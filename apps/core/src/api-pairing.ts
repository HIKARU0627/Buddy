// 端末のペアリング・端末の一覧・失効の経路と、最初の端末の CLI の承認（設計 02 端末登録と接続、
// ADR 0009 の U15・0020・0021）。
//
// - コードは 8 桁の暗号論的乱数で、有効 5 分・連続 5 回の失敗で無効。DB には起動ごとの乱数の鍵による
//   HMAC-SHA256 だけを置く（平文を残さない。再起動で未使用のペアリングは使えなくなる）。
// - 申請では端末が作った申請用の秘密の SHA-256 だけを受け取り、トークン（256 ビット）は承認の後に秘密と
//   交換で 1 回だけ渡す。DB にはトークンの hash（ASCII の 43 文字の SHA-256）だけを置く。
// - 照合（コード・秘密）は DB worker の transaction の中で timingSafeEqual で行う（pairing-store.ts）。
// - 開始・承認は中枢の画面（hub_local の端末で、接続元が中枢と同じマシン）だけ。
// - 中枢の証明書が変わったら自動で承認しない。ペアリングの開始時の指紋と今の指紋が違う申請は承認・受取りが
//   できず、違う指紋で登録した端末は起動時に失効する（再登録にする）。
// - ログ・例外・応答の拒否にコード・秘密・トークン・hash を入れない（ID と理由コードだけ）。

import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from 'node:crypto';
import { isIP } from 'node:net';
import { tokenPickup } from '@buddy/domain';
import {
  PAIRING_CLAIM_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_SESSION_TTL_MS,
} from '@buddy/storage';
import type {
  DbWorkerClient,
  DeviceRecord,
  PairingClaimRecord,
} from '@buddy/storage';
import { createDeviceToken, deviceTokenHash } from './api-auth.js';
import type {
  EnvironmentInput,
  RequestEnvironment,
} from './api-environment.js';
import { apiErrorResponse } from './api-server.js';
import type {
  ApiErrorCode,
  ApiHandlerRequest,
  ApiRouteHandler,
} from './api-server.js';
import type { DeviceConnections } from './device-connections.js';

const CODE_LABEL = 'buddy/pairing-code/v1';
const CLAIM_SECRET = /^[A-Za-z0-9_-]{43}$/u;

export type PairingStore = Pick<DbWorkerClient, 'device' | 'pairing'>;

// 接続元が中枢と同じマシンか。ループバック（127.0.0.0/8・::1）か、待ち受けのアドレスと同じ IP のとき。
// 中枢は 1 つの IP アドレスだけで待ち受けるので、同じマシンのクライアントがそのアドレスへ接続すると
// 接続元も同じアドレスになる。Tailscale の経路では、別のマシンが中枢のアドレスを名乗れない前提。
export function isSameMachine(
  remoteAddress: string,
  listenHost: string,
): boolean {
  const normalize = (address: string) => {
    const lower = address.toLowerCase();
    return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4
      ? lower.slice(7)
      : lower;
  };
  const remote = normalize(remoteAddress);
  if (isIP(remote) === 0) return false;
  if (remote === '::1' || (isIP(remote) === 4 && remote.startsWith('127.')))
    return true;
  return remote === normalize(listenHost);
}

// 申請用の秘密の照合値（ASCII の 43 文字の SHA-256 の小文字の 16 進。契約の claim_secret_hash と同じ定義）。
export function claimSecretHash(secret: string): string {
  if (!CLAIM_SECRET.test(secret))
    throw new TypeError('claim secret must be 43 base64url characters');
  return createHash('sha256').update(secret, 'ascii').digest('hex');
}

// 8 桁のワンタイムコード（0 埋め。暗号論的乱数で一様に選ぶ）。
export function createPairingCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

export type FirstDeviceRefusal =
  // 有効な端末が 1 台でもある。
  | 'devices_registered'
  // CLI で開始したペアリングではない・見つからない。
  | 'pairing_not_found'
  // まだ申請がない。
  | 'claim_not_found'
  // 申請が中枢と同じマシンからではない（または再起動などで確かめられない）。
  | 'claim_not_same_machine'
  // 申請を承認済み・拒否済み。
  | 'claim_not_pending'
  // 期限切れ・証明書の変更など、ペアリングが無効。
  | 'pairing_failed'
  // DB に書けない・成否不明。
  | 'store_failed';

export type FirstDeviceStart =
  | {
      readonly ok: true;
      readonly pairing_id: string;
      // CLI の画面に出す値（ログには出さない）。
      readonly pairing_code: string;
      readonly certificate_fingerprint: string;
      readonly expires_at: string;
    }
  | { readonly ok: false; readonly reason: FirstDeviceRefusal };

export type FirstDeviceApproval =
  | {
      readonly ok: true;
      readonly claim_id: string;
      readonly status: 'approved';
      readonly device_name: string;
      readonly platform: string;
      readonly expires_at: string;
    }
  | { readonly ok: false; readonly reason: FirstDeviceRefusal };

export interface PairingServiceOptions {
  readonly store: PairingStore;
  // 今の中枢の証明書の指紋（DER 全体の SHA-256）。
  readonly fingerprint: string;
  // HTTPS の待ち受けのアドレス（同じマシンの判定に使う）。
  readonly host: string;
  // UTC の Unix ミリ秒。
  readonly now: () => number;
  readonly deviceConnections: DeviceConnections;
  readonly log?: (message: string) => void;
  // 接続元が中枢と同じマシンか（試験で差し替える）。既定は isSameMachine(remote, host)。
  readonly sameMachine?: (remoteAddress: string) => boolean;
}

export interface PairingService {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
  // 中枢の画面の判定と申請用の秘密の照合（RequestEnvironment の該当の欄）。
  readonly environment: Pick<
    RequestEnvironment,
    'hubLocal' | 'claimSecretMatches' | 'homeNetwork'
  >;
  // 最初の端末: 有効な端末が 0 台のときだけ、CLI でペアリングを開始する。
  startFirstDevice(): Promise<FirstDeviceStart>;
  // 最初の端末: CLI で開始したペアリングの、同じマシンからの申請を承認する。
  approveFirstDevice(pairingId: string): Promise<FirstDeviceApproval>;
  // 起動時: 今の証明書と違う指紋で登録した有効な端末を失効する。失効した端末の ID を返す。
  revokeCertificateMismatch(): Promise<readonly string[]>;
}

export class PairingStoreError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`pairing_store_failed: ${reasons.join(', ')}`);
    this.name = 'PairingStoreError';
    this.reasons = reasons;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

function requestIdOf(request: ApiHandlerRequest): string | null {
  const value = request.body?.['request_id'];
  return typeof value === 'string' ? value : null;
}

// 拒否の応答（ApiError）。B03-04 の apiErrorResponse を使う。
const fail = apiErrorResponse;

export function deviceSummary(device: DeviceRecord): object {
  return {
    device_id: device.device_id,
    device_name: device.device_name,
    platform: device.platform,
    hub_local: device.hub_local,
    registered_at: iso(device.registered_at),
    last_seen_at:
      device.last_seen_at === null ? null : iso(device.last_seen_at),
    revoked_at: device.revoked_at === null ? null : iso(device.revoked_at),
  };
}

function claimBody(claim: PairingClaimRecord): object {
  return {
    claim_id: claim.claim_id,
    status: claim.status,
    device_name: claim.device_name,
    platform: claim.platform,
    expires_at: iso(claim.expires_at),
  };
}

export function createPairingService(
  options: PairingServiceOptions,
): PairingService {
  const { store, fingerprint, now } = options;
  const log = options.log ?? (() => undefined);
  const sameMachine =
    options.sameMachine ??
    ((remote: string) => isSameMachine(remote, options.host));
  // コードの HMAC の鍵（起動ごとの乱数。プロセスの外へ出さない）。
  const codeKey = randomBytes(32);
  const codeHash = (code: string) =>
    createHmac('sha256', codeKey)
      .update(`${CODE_LABEL}\u0000${code}`, 'utf8')
      .digest('hex');
  // CLI で開始したペアリング（ID → 期限）と、申請の接続元が同じマシンだったか（ID → 期限）。
  // どちらもメモリだけに置き、再起動で失う（その場合は最初からやり直す）。
  const firstPairings = new Map<string, number>();
  const sameMachineClaims = new Map<string, number>();
  const prune = (at: number) => {
    for (const [id, until] of firstPairings)
      if (at >= until) firstPairings.delete(id);
    for (const [id, until] of sameMachineClaims)
      if (at >= until) sameMachineClaims.delete(id);
  };

  // ペアリングを開始する（中枢の画面と CLI の共通部分）。
  const startSession = async (): Promise<
    | {
        readonly ok: true;
        readonly pairingId: string;
        readonly code: string;
        readonly expiresAt: number;
      }
    | { readonly ok: false; readonly reasons: readonly string[] }
  > => {
    const createdAt = now();
    const expiresAt = createdAt + PAIRING_SESSION_TTL_MS;
    const code = createPairingCode();
    const pairingId = randomUUID();
    const started = await store.pairing({
      kind: 'pairing.start',
      pairing_id: pairingId,
      code_hash: codeHash(code),
      certificate_fingerprint: fingerprint,
      created_at: createdAt,
      expires_at: expiresAt,
    });
    if (!started.ok) return { ok: false, reasons: started.reasons };
    return { ok: true, pairingId, code, expiresAt };
  };

  const startPairing: ApiRouteHandler = async (request) => {
    const requestId = requestIdOf(request);
    const started = await startSession();
    if (!started.ok) return fail(503, 'dependency_unavailable', requestId);
    log(
      `ペアリングを開始しました（pairing_id ${started.pairingId}、端末 ${request.device?.device_id ?? '-'}）。`,
    );
    return {
      status: 201,
      body: {
        pairing_id: started.pairingId,
        pairing_code: started.code,
        certificate_fingerprint: fingerprint,
        expires_at: iso(started.expiresAt),
        attempts_left: PAIRING_MAX_ATTEMPTS,
      },
    };
  };

  const claimPairing: ApiRouteHandler = async (request) => {
    const requestId = requestIdOf(request);
    const body = request.body ?? {};
    const at = now();
    prune(at);
    const claimId = randomUUID();
    const result = await store.pairing({
      kind: 'pairing.claim',
      claim_id: claimId,
      code_hash: codeHash(String(body['pairing_code'])),
      device_name: String(body['device_name']),
      platform: body['platform'] as DeviceRecord['platform'],
      claim_secret_hash: String(body['claim_secret_hash']),
      now: at,
      claim_expires_at: at + PAIRING_CLAIM_TTL_MS,
    });
    if (!result.ok) {
      if (
        result.outcome === 'rejected' &&
        result.reasons.includes('claim_secret_reused')
      )
        return fail(410, 'pairing_failed', requestId);
      return fail(503, 'dependency_unavailable', requestId);
    }
    if (!result.value.ok) {
      // 理由（不一致・期限切れ・回数の上限・使用済み）はどれも pairing_failed として返し、区別を外へ出さない。
      log(`ペアリングの申請を拒否しました（${result.value.reason}）。`);
      return fail(410, 'pairing_failed', requestId);
    }
    const claim = result.value.claim;
    if (sameMachine(request.remoteAddress))
      sameMachineClaims.set(claim.claim_id, claim.expires_at);
    log(
      `ペアリングの申請を受け付けました（claim_id ${claim.claim_id}、pairing_id ${claim.pairing_id}）。`,
    );
    return { status: 202, body: claimBody(claim) };
  };

  const decidePairingClaim: ApiRouteHandler = async (request) => {
    const requestId = requestIdOf(request);
    const claimId = request.params['claim_id'] ?? '';
    const decision =
      request.body?.['decision'] === 'approve' ? 'approve' : 'reject';
    const result = await store.pairing({
      kind: 'pairing.decide',
      claim_id: claimId,
      decision,
      now: now(),
      certificate_fingerprint: fingerprint,
      require_no_active_devices: false,
    });
    if (!result.ok) {
      if (result.outcome === 'rejected') {
        const reason = result.reasons[0];
        // 決め済みの申請は 409。無い・期限切れ・証明書の変更は 410（ペアリングの無効）。
        if (
          reason === 'claim_not_pending' ||
          reason === 'claim_consumed' ||
          reason === 'claim_rejected'
        )
          return fail(409, 'conflict', requestId);
        if (
          reason === 'claim_not_found' ||
          reason === 'claim_expired' ||
          reason === 'certificate_changed'
        )
          return fail(410, 'pairing_failed', requestId);
      }
      return fail(503, 'dependency_unavailable', requestId);
    }
    log(
      `ペアリングの申請を${decision === 'approve' ? '承認' : '拒否'}しました（claim_id ${claimId}）。`,
    );
    return { status: 200, body: claimBody(result.value) };
  };

  const pickupPairingToken: ApiRouteHandler = async (request) => {
    const claimId = request.params['claim_id'] ?? '';
    const secret = String(request.body?.['claim_secret'] ?? '');
    const at = now();
    const found = await store.pairing({
      kind: 'pairing.find_claim',
      claim_id: claimId,
    });
    if (!found.ok) return fail(503, 'dependency_unavailable', null);
    // 申請用の秘密は経路の検査（claim_secret）で照合済み。申請がなければそこで 401 になっている。
    if (found.value === null) return fail(401, 'unauthenticated', null);
    const claim = found.value;
    if (claim.certificate_fingerprint !== fingerprint)
      return fail(410, 'pairing_failed', null);
    // 受け取れるかは domain の規則（承認前 409、使用済み・拒否・期限切れ 410）で決める。
    const decided = tokenPickup(
      { status: claim.status, expires_at: iso(claim.expires_at) },
      true,
      iso(at),
    );
    if (decided.status !== 200)
      return fail(decided.status, decided.code as ApiErrorCode, null);
    const token = createDeviceToken();
    const deviceId = randomUUID();
    const hubLocal = sameMachine(request.remoteAddress);
    const picked = await store.pairing({
      kind: 'pairing.pickup',
      claim_id: claimId,
      claim_secret_hash: claimSecretHash(secret),
      device_id: deviceId,
      token_hash: deviceTokenHash(token),
      hub_local: hubLocal,
      now: at,
      certificate_fingerprint: fingerprint,
    });
    if (!picked.ok) {
      // 成否不明（unknown）のときもトークンを返さない。登録されていれば本人が失効して登録し直す。
      const reason = picked.outcome === 'rejected' ? picked.reasons[0] : null;
      if (reason === 'claim_secret_mismatch' || reason === 'claim_not_found')
        return fail(401, 'unauthenticated', null);
      if (reason === 'claim_not_approved') return fail(409, 'conflict', null);
      if (
        reason === 'claim_consumed' ||
        reason === 'claim_rejected' ||
        reason === 'claim_expired' ||
        reason === 'certificate_changed'
      )
        return fail(410, 'pairing_failed', null);
      return fail(503, 'dependency_unavailable', null);
    }
    sameMachineClaims.delete(claimId);
    log(
      `端末を登録しました（device_id ${deviceId}、claim_id ${claimId}、中枢と同じマシン: ${hubLocal ? 'はい' : 'いいえ'}）。`,
    );
    return {
      status: 200,
      body: { device_id: deviceId, device_token: token, issued_at: iso(at) },
    };
  };

  const listDevices: ApiRouteHandler = async () => {
    const listed = await store.pairing({ kind: 'devices.list' });
    if (!listed.ok) return fail(503, 'dependency_unavailable', null);
    return { status: 200, body: { devices: listed.value.map(deviceSummary) } };
  };

  const revokeDevice: ApiRouteHandler = async (request) => {
    const requestId = requestIdOf(request);
    const deviceId = request.params['device_id'] ?? '';
    const revoked = await store.device({
      kind: 'device.revoke',
      device_id: deviceId,
      revoked_at: now(),
    });
    if (!revoked.ok) {
      if (
        revoked.outcome === 'rejected' &&
        revoked.reasons.includes('device_not_found')
      )
        return fail(409, 'conflict', requestId);
      return fail(503, 'dependency_unavailable', requestId);
    }
    // 失効を記録した後に、その端末の開いている接続（WSS など）を閉じる。
    const closed = options.deviceConnections.closeDevice(
      deviceId,
      'device_revoked',
    );
    log(
      `端末を失効しました（device_id ${deviceId}、無効にした接続範囲 ${revoked.value.revoked_scopes}、閉じた接続 ${closed}）。`,
    );
    const found = await store.pairing({
      kind: 'devices.find',
      device_id: deviceId,
    });
    if (!found.ok || found.value === null)
      return fail(503, 'dependency_unavailable', requestId);
    return { status: 200, body: deviceSummary(found.value) };
  };

  const environment: PairingService['environment'] = {
    // 自宅判定の B03-03 までの既定（安全側）。認証した端末は B03-01 の既定（hub_local の端末だけ免除）のまま。
    // 登録前の申請・受取り（端末なし）は、中枢と同じマシンからの接続だけを免除で通す（最初の端末の登録の
    // ため。中枢と同じマシンのクライアントは自宅判定を免除する、という RequestContext の注記に合わせる）。
    // B03-03 の自宅判定で置き換える。
    homeNetwork: (input: EnvironmentInput) =>
      input.device === null
        ? sameMachine(input.remoteAddress)
        : input.device.hub_local === true,
    // 中枢の画面: 中枢と同じマシンとして登録した端末で、今の接続元も同じマシンのとき（ADR 0020 の読み取りの見直し）。
    hubLocal: (input: EnvironmentInput) =>
      input.device?.hub_local === true && sameMachine(input.remoteAddress),
    claimSecretMatches: async (input: EnvironmentInput) => {
      const claimId = input.params['claim_id'];
      const secret = input.body?.['claim_secret'];
      if (typeof claimId !== 'string' || typeof secret !== 'string')
        return false;
      if (!CLAIM_SECRET.test(secret)) return false;
      const result = await store.pairing({
        kind: 'pairing.claim_secret_matches',
        claim_id: claimId,
        claim_secret_hash: claimSecretHash(secret),
      });
      if (!result.ok) throw new PairingStoreError(result.reasons);
      return result.value.matches;
    },
  };

  return {
    handlers: {
      startPairing,
      claimPairing,
      decidePairingClaim,
      pickupPairingToken,
      listDevices,
      revokeDevice,
    },
    environment,
    async startFirstDevice() {
      const count = await store.pairing({ kind: 'devices.count_active' });
      if (!count.ok) return { ok: false, reason: 'store_failed' };
      if (count.value.count > 0)
        return { ok: false, reason: 'devices_registered' };
      const started = await startSession();
      if (!started.ok) return { ok: false, reason: 'store_failed' };
      prune(now());
      firstPairings.set(started.pairingId, started.expiresAt);
      log(
        `最初の端末のペアリングを CLI で開始しました（pairing_id ${started.pairingId}）。`,
      );
      return {
        ok: true,
        pairing_id: started.pairingId,
        pairing_code: started.code,
        certificate_fingerprint: fingerprint,
        expires_at: iso(started.expiresAt),
      };
    },
    async approveFirstDevice(pairingId) {
      const at = now();
      // 期限の過ぎたものを片付ける前に、CLI で開始したかを確かめる（期限切れは pairing_failed にする）。
      const until = firstPairings.get(pairingId);
      prune(at);
      if (until === undefined)
        return { ok: false, reason: 'pairing_not_found' };
      const found = await store.pairing({
        kind: 'pairing.find_session_claim',
        pairing_id: pairingId,
      });
      if (!found.ok) return { ok: false, reason: 'store_failed' };
      if (found.value === null)
        return {
          ok: false,
          reason: at >= until ? 'pairing_failed' : 'claim_not_found',
        };
      const claim = found.value;
      if (!sameMachineClaims.has(claim.claim_id))
        return { ok: false, reason: 'claim_not_same_machine' };
      const decided = await store.pairing({
        kind: 'pairing.decide',
        claim_id: claim.claim_id,
        decision: 'approve',
        now: at,
        certificate_fingerprint: fingerprint,
        require_no_active_devices: true,
      });
      if (!decided.ok) {
        const reason =
          decided.outcome === 'rejected' ? decided.reasons[0] : null;
        if (reason === 'devices_registered') return { ok: false, reason };
        if (
          reason === 'claim_not_pending' ||
          reason === 'claim_rejected' ||
          reason === 'claim_consumed'
        )
          return { ok: false, reason: 'claim_not_pending' };
        if (
          reason === 'claim_expired' ||
          reason === 'certificate_changed' ||
          reason === 'claim_not_found'
        )
          return { ok: false, reason: 'pairing_failed' };
        return { ok: false, reason: 'store_failed' };
      }
      firstPairings.delete(pairingId);
      log(
        `最初の端末の申請を CLI で承認しました（claim_id ${claim.claim_id}）。`,
      );
      return {
        ok: true,
        claim_id: decided.value.claim_id,
        status: 'approved',
        device_name: decided.value.device_name,
        platform: decided.value.platform,
        expires_at: iso(decided.value.expires_at),
      };
    },
    async revokeCertificateMismatch() {
      const result = await store.pairing({
        kind: 'devices.revoke_certificate_mismatch',
        certificate_fingerprint: fingerprint,
        revoked_at: now(),
      });
      if (!result.ok) throw new PairingStoreError(result.reasons);
      for (const deviceId of result.value.revoked_device_ids)
        options.deviceConnections.closeDevice(deviceId, 'device_revoked');
      if (result.value.revoked_device_ids.length > 0)
        log(
          `証明書が変わったため、前の証明書で登録した端末 ${result.value.revoked_device_ids.length} 台を失効しました。再登録が必要です。`,
        );
      return result.value.revoked_device_ids;
    },
  };
}
