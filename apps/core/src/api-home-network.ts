// 自宅ネットワークの判定（設計 11 §10、02 運用上の境界、X42、ADR 0022）。
//
// 経路の検査の home_network（RequestEnvironment.homeNetwork）と、自宅の指紋の報告・自宅の登録の経路の処理を作る。
// - 許可は「自宅の指紋の一致」と「Tailscale の直接経路が自宅 LAN の中」の両方を満たすときだけ（domain の
//   homeNetworkDecision）。端末認証の代わりではなく追加の条件で、端末トークンの照合はこの前に済んでいる。
// - 不成立（取得できない・確認できないを含む）は 403 outside_home_network。認証済みの端末なら、その端末の有効な
//   接続範囲（command_scope）を失効させ、onDenied で知らせる（WSS を閉じる差し込み口。配信は B03-04）。
//   指紋だけの許可に切り替えない。
// - 端末の報告は受け取った時刻（中枢の時計）から 6 分の間だけ使う。認証前の経路（申請・受取り）は、本文の
//   home_fingerprint をその時点の報告として使う（登録前の端末は報告を持たない）。
// - 中枢と同じマシンのクライアント（hub_local の端末で、接続元がループバックか待ち受けのアドレス）は自宅判定だけを
//   免除する。トークンは必要（経路の検査の device_token が先）。端末のない申請・受取りは、同じマシンからなら免除する
//   （最初の端末の登録。登録前なので hub_local を確かめられない）。
// - MAC と SSID はデータ鍵から導いた鍵の HMAC-SHA256 にしてから保存する。鍵の値・MAC・SSID をログ・例外・応答に出さない。
// - 外出先からの接続を有効にする経路・設定は作らない（初期版は OFF に固定）。

import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import {
  HOME_REPORT_MAX_AGE_MS,
  homeNetworkDecision,
  parseHomeSubnet,
} from '@buddy/domain';
import type {
  HomeNetworkDecision,
  HomeNetworkReason,
  HomeReportView,
  TailscalePeerPath,
} from '@buddy/domain';
import { normalizeRemoteAddress } from '@buddy/platform';
import type { TailscaleStatusSource } from '@buddy/platform';
import type {
  DataKeyMaterial,
  DbWorkerClient,
  DeviceRecord,
  HomeReportRecord,
} from '@buddy/storage';
import type { EnvironmentInput } from './api-environment.js';
import { apiErrorBody } from './api-server.js';
import type { ApiErrorCode, ApiRouteHandler } from './api-server.js';
import type { JsonObject } from './strict-json.js';

// データ鍵から自宅の HMAC の鍵を導く文脈。データ鍵が変われば DB を開けない（ADR 0019）ので、鍵の版は持たない。
export const HOME_NETWORK_KEY_CONTEXT = 'buddy.home_network.hmac.v1';

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

// 自宅の HMAC の鍵。データ鍵そのものは持たず、導いた 32 バイトだけをメモリに置く。値は文字列化・JSON・inspect に出さない。
export class HomeNetworkKey {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  // HMAC-SHA256(データ鍵, 文脈 + NUL + key_id)。
  static fromDataKey(dataKey: DataKeyMaterial): HomeNetworkKey {
    const { keyId, key } = dataKey;
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId))
      throw new TypeError('home_network_key_id_invalid');
    if (!(key instanceof Uint8Array) || key.length !== 32)
      throw new TypeError('home_network_data_key_invalid');
    return new HomeNetworkKey(
      createHmac('sha256', key)
        .update(`${HOME_NETWORK_KEY_CONTEXT}\0${keyId}`, 'utf8')
        .digest(),
    );
  }

  // ゲートウェイの MAC（小文字のコロン区切り）の HMAC の小文字の 16 進。
  gatewayMac(mac: string): string {
    return createHmac('sha256', this.#key)
      .update(`gateway_mac\0${mac}`, 'utf8')
      .digest('hex');
  }

  // SSID（UTF-8）の HMAC の小文字の 16 進。
  ssid(ssid: string): string {
    return createHmac('sha256', this.#key)
      .update(`ssid\0${ssid}`, 'utf8')
      .digest('hex');
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return 'HomeNetworkKey [redacted]';
  }
}

// 接続元が中枢と同じマシンか（ループバック、または待ち受けのアドレスと同じ IP）。
// B03-02 の isSameMachine と同じ判定で、統合で一つにまとめる（ADR 0022 の読み取り）。
export function isSameMachineAddress(
  remoteAddress: string,
  listenHost: string,
): boolean {
  const remote = normalizeRemoteAddress(remoteAddress);
  if (remote === '') return false;
  if (
    remote === '::1' ||
    /^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u.test(remote)
  )
    return true;
  return remote === normalizeRemoteAddress(listenHost);
}

export type HomeNetworkStore = Pick<DbWorkerClient, 'home'>;

export type HomeNetworkDeniedListener = (
  deviceId: string,
  reasons: readonly HomeNetworkReason[],
) => void;

export interface HomeNetworkGateOptions {
  readonly store: HomeNetworkStore;
  readonly key: HomeNetworkKey;
  // 中枢の Tailscale の状態（@buddy/platform。製品は `tailscale status --json`、試験は模擬）。
  readonly tailscale: TailscaleStatusSource;
  readonly sameMachine: (remoteAddress: string) => boolean;
  // UTC の Unix ミリ秒（報告の受け取りと鮮度）。
  readonly now: () => number;
  readonly log?: (message: string) => void;
}

export interface HomeNetworkGate {
  // 経路の検査の home_network。DB を読めなければ例外（経路の検査は 503 にする。許可にはしない）。
  homeNetwork(input: EnvironmentInput): Promise<boolean>;
  readonly handlers: {
    readonly reportHomeFingerprint: ApiRouteHandler;
    readonly registerHome: ApiRouteHandler;
  };
  // 認証済みの端末が自宅判定で不成立になったときの通知（接続範囲を失効させた後）。WSS を閉じるのに使う。
  onDenied(listener: HomeNetworkDeniedListener): () => void;
}

export class HomeNetworkStoreError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`home_network_store_failed: ${reasons.join(', ')}`);
    this.name = 'HomeNetworkStoreError';
    this.reasons = reasons;
  }
}

// 本文の指紋を報告の形に（認証前の経路）。形式は JSON Schema で検査済み。
interface Fingerprint {
  readonly gateway_mac: string | null;
  readonly subnet: string | null;
  readonly ssid: string | null;
}

const ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requestIdOf(body: JsonObject | null): string | null {
  const value = body?.['request_id'];
  return typeof value === 'string' && ID.test(value) ? value : null;
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

function fingerprintOf(value: unknown): Fingerprint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  return {
    gateway_mac: stringOrNull(record['gateway_mac']),
    subnet: stringOrNull(record['subnet']),
    ssid: stringOrNull(record['ssid']),
  };
}

// 本文の home_fingerprint を自宅判定に使う経路（認証前で、端末の報告がない）。
const BODY_FINGERPRINT_ROUTES: ReadonlySet<string> = new Set([
  'claimPairing',
  'pickupPairingToken',
]);

const rejectWith = (
  status: number,
  code: ApiErrorCode,
  requestId: string | null,
) => ({ status, body: apiErrorBody(code, requestId) });

export function createHomeNetworkGate(
  options: HomeNetworkGateOptions,
): HomeNetworkGate {
  const listeners = new Set<HomeNetworkDeniedListener>();
  const log = options.log ?? (() => undefined);

  // 指紋を保存・比較する形（MAC と SSID は HMAC）。サブネットが正準でなければ null（比べられない）。
  const hashed = (fingerprint: Fingerprint) => ({
    gateway_mac_hash:
      fingerprint.gateway_mac === null
        ? null
        : options.key.gatewayMac(fingerprint.gateway_mac),
    subnet:
      fingerprint.subnet !== null &&
      parseHomeSubnet(fingerprint.subnet) !== null
        ? fingerprint.subnet
        : null,
    ssid_hash:
      fingerprint.ssid === null ? null : options.key.ssid(fingerprint.ssid),
  });

  const reportView = (record: HomeReportRecord): HomeReportView => ({
    gateway_mac_hash: record.gateway_mac_hmac,
    subnet: record.subnet,
    ssid_hash: record.ssid_hmac,
    received_at_ms: record.received_at,
  });

  const peerPath = async (remote: string): Promise<TailscalePeerPath> => {
    try {
      return await options.tailscale.peerPath(remote);
    } catch {
      return { kind: 'unavailable' };
    }
  };

  const decide = async (
    device: DeviceRecord | null,
    remoteAddress: string,
    report: () => Promise<HomeReportView | null>,
    preAuth = false,
  ): Promise<HomeNetworkDecision> => {
    const now = options.now();
    // 中枢と同じマシンのクライアントは、DB も Tailscale も見ずに免除する。認証した端末は hub_local のときだけ。
    // 端末のない認証前の要求（申請・受取り）は、同じマシンからなら免除する（最初の端末＝中枢の画面の登録。
    // 登録前なので hub_local を確かめられない。B03-02 と合わせた読み取り、ADR 0022）。
    const hubClient = device === null ? preAuth : device.hub_local === true;
    if (hubClient && options.sameMachine(remoteAddress))
      return homeNetworkDecision({
        same_machine_hub_client: true,
        registration: null,
        report: null,
        tailscale: { kind: 'unavailable' },
        now_ms: now,
      });
    const registration = await options.store.home({ kind: 'home.get' });
    if (!registration.ok) throw new HomeNetworkStoreError(registration.reasons);
    const [view, path] = await Promise.all([report(), peerPath(remoteAddress)]);
    return homeNetworkDecision({
      same_machine_hub_client: false,
      registration:
        registration.value === null
          ? null
          : {
              gateway_mac_hash: registration.value.gateway_mac_hmac,
              subnet: registration.value.subnet,
              ssid_hash: registration.value.ssid_hmac,
            },
      report: view,
      tailscale: path,
      now_ms: now,
    });
  };

  // 不成立の後始末: 接続範囲の失効（リースは接続範囲に結び付くので一緒に無効になる）と通知。
  const deny = async (
    device: DeviceRecord,
    reasons: readonly HomeNetworkReason[],
  ): Promise<void> => {
    const revoked = await options.store.home({
      kind: 'home.revoke_scopes',
      device_id: device.device_id,
      revoked_at: options.now(),
    });
    log(
      `自宅判定が成り立ちません（端末 ${device.device_id}、理由: ${reasons.join(', ')}）。${
        revoked.ok
          ? `接続範囲を ${revoked.value.revoked_scopes} 件失効させました。`
          : `接続範囲を失効できませんでした（${revoked.reasons.join(', ')}）。`
      }`,
    );
    for (const listener of listeners) {
      try {
        listener(device.device_id, reasons);
      } catch {
        // 通知の失敗で拒否を変えない。
      }
    }
  };

  const homeNetwork = async (input: EnvironmentInput): Promise<boolean> => {
    const fromBody = BODY_FINGERPRINT_ROUTES.has(input.operationId);
    const decision = await decide(
      input.device,
      input.remoteAddress,
      async () => {
        if (fromBody) {
          const fingerprint = fingerprintOf(input.body?.['home_fingerprint']);
          return fingerprint === null
            ? null
            : { ...hashed(fingerprint), received_at_ms: options.now() };
        }
        if (input.device === null) return null;
        const found = await options.store.home({
          kind: 'home.find_report',
          device_id: input.device.device_id,
        });
        if (!found.ok) throw new HomeNetworkStoreError(found.reasons);
        return found.value === null ? null : reportView(found.value);
      },
      fromBody,
    );
    if (!decision.allowed && input.device !== null)
      await deny(input.device, decision.reasons);
    return decision.allowed;
  };

  const reportHomeFingerprint: ApiRouteHandler = async (request) => {
    const requestId = requestIdOf(request.body);
    const device = request.device;
    if (device === null) return rejectWith(401, 'unauthenticated', requestId);
    const fingerprint = fingerprintOf(request.body?.['fingerprint']);
    if (fingerprint === null)
      return rejectWith(422, 'invalid_input', requestId);
    // ネットワークのアドレスでないサブネットは形式の不正（JSON Schema では表せない）。
    if (
      fingerprint.subnet !== null &&
      parseHomeSubnet(fingerprint.subnet) === null
    )
      return rejectWith(422, 'invalid_input', requestId);
    const view = hashed(fingerprint);
    const receivedAt = options.now();
    const stored = await options.store.home({
      kind: 'home.report',
      device_id: device.device_id,
      gateway_mac_hmac: view.gateway_mac_hash,
      subnet: view.subnet,
      ssid_hmac: view.ssid_hash,
      received_at: receivedAt,
    });
    if (!stored.ok) {
      const revoked =
        stored.outcome === 'rejected' &&
        (stored.reasons.includes('device_revoked') ||
          stored.reasons.includes('device_not_found'));
      return revoked
        ? rejectWith(401, 'unauthenticated', requestId)
        : rejectWith(503, 'dependency_unavailable', requestId);
    }
    const decision = await decide(device, request.remoteAddress, () =>
      Promise.resolve(reportView(stored.value)),
    );
    if (!decision.allowed) await deny(device, decision.reasons);
    return {
      status: 200,
      body: {
        allowed: decision.allowed,
        exempt: decision.exempt,
        reasons: decision.reasons,
        report_expires_at: decision.exempt
          ? null
          : new Date(receivedAt + HOME_REPORT_MAX_AGE_MS).toISOString(),
      },
    };
  };

  const registerHome: ApiRouteHandler = async (request) => {
    const requestId = requestIdOf(request.body);
    const device = request.device;
    if (device === null) return rejectWith(401, 'unauthenticated', requestId);
    const fingerprint = fingerprintOf(request.body);
    if (
      fingerprint === null ||
      fingerprint.gateway_mac === null ||
      fingerprint.subnet === null ||
      parseHomeSubnet(fingerprint.subnet) === null
    )
      return rejectWith(422, 'invalid_input', requestId);
    const registeredAt = options.now();
    const stored = await options.store.home({
      kind: 'home.register',
      gateway_mac_hmac: options.key.gatewayMac(fingerprint.gateway_mac),
      subnet: fingerprint.subnet,
      ssid_hmac:
        fingerprint.ssid === null ? null : options.key.ssid(fingerprint.ssid),
      registered_at: registeredAt,
      device_id: device.device_id,
    });
    if (!stored.ok) {
      const revoked =
        stored.outcome === 'rejected' &&
        (stored.reasons.includes('device_revoked') ||
          stored.reasons.includes('device_not_found'));
      return revoked
        ? rejectWith(401, 'unauthenticated', requestId)
        : rejectWith(503, 'dependency_unavailable', requestId);
    }
    log(
      `自宅を登録しました（SSID: ${fingerprint.ssid === null ? 'なし' : 'あり'}）。`,
    );
    return {
      status: 200,
      body: {
        subnet: stored.value.subnet,
        ssid_registered: stored.value.ssid_hmac !== null,
        registered_at: new Date(stored.value.registered_at).toISOString(),
      },
    };
  };

  return {
    homeNetwork,
    handlers: { reportHomeFingerprint, registerHome },
    onDenied(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
