// ペアリング（ブリッジを中枢の端末として登録する。ADR 0021・0143）。
//
// 流れはデスクトップの端末登録と同じで、既存の経路だけを使う（新しい経路は作らない）:
//   1. 何も送らずに TLS を接続し、中枢の証明書と指紋を受け取る（本人が中枢の表示と指紋を比べる）。
//   2. 本人が中枢の画面でペアリングを開始して出た 8 桁のコードで申請する（claimPairing）。
//      申請用の秘密（256 ビット）はブリッジが作り、申請には SHA-256 だけを送る。
//   3. 本人が中枢の画面で承認したら、申請用の秘密で端末トークンを受け取る（pickupPairingToken、1 回だけ）。
//      接続元が中枢と同じマシンなので、端末は hub_local として登録される（Core が決める。ブリッジは関与しない）。
// - 自宅の指紋は中枢と同じマシンの実際の値を platform の収集で得る（推測で埋めない。取れない要素は null）。
// - 端末トークンと申請用の秘密は、結果・例外・ログに入れない。申請用の秘密は受け取りの後に捨てる。

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CoreClient } from './core-client.js';
import type {
  CoreTransport,
  PeerCertificateOutcome,
} from './core-transport.js';

export interface HomeFingerprint {
  readonly gateway_mac: string | null;
  readonly subnet: string | null;
  readonly ssid: string | null;
}

export interface PairingDeps {
  // 証明書の取得だけに使う transport（ピン留め前）。
  readonly transport: CoreTransport;
  // ピン留めした証明書で transport と client を作り直す（証明書を受け取った後に呼ぶ）。
  readonly pinnedClient: (
    certificatePem: string,
    fingerprint: string,
  ) => CoreClient;
  readonly collectFingerprint: () => Promise<HomeFingerprint>;
  readonly deviceName: string;
  readonly platform: 'windows' | 'macos' | 'linux';
  // 指紋を受け取ったときに呼ぶ（CLI が本人の確認のために表示し、一致の確認を待つ。申請はその後にだけ進む）。
  readonly onPeerCertificate?: (fingerprint: string) => void | Promise<void>;
  // 申請ができたときに呼ぶ（CLI が「中枢の画面で承認してください」と伝える）。
  readonly onClaimCreated?: (claimId: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newRequestId?: () => string;
  // 承認を待つ間隔と上限（申請の期限は 5 分。既定は 2 秒ごとに 4 分まで）。
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

export type PairingResult =
  | {
      readonly kind: 'paired';
      readonly deviceId: string;
      // 端末トークン（1 回だけ返る値）。呼び出し側が設定へ保存する。ログに出さない。
      readonly deviceToken: string;
      readonly certificatePem: string;
      readonly fingerprint: string;
    }
  | { readonly kind: 'failed'; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// 申請用の秘密（256 ビット、base64url の 43 文字。契約の PairingTokenRequest と同じ形）。
export function generateClaimSecret(): string {
  return randomBytes(32).toString('base64url');
}

// 申請用の秘密の SHA-256（Core の claimSecretHash と同じ計算。値は秘密そのものではない）。
export function claimSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'ascii').digest('hex');
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function pairBridge(
  deps: PairingDeps,
  pairingCode: string,
): Promise<PairingResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const newRequestId = deps.newRequestId ?? randomUUID;
  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 240_000;

  const peer: PeerCertificateOutcome =
    await deps.transport.fetchPeerCertificate();
  if (peer.kind !== 'ok')
    return { kind: 'failed', reason: `certificate_${peer.reason}` };
  // 本人が指紋を中枢の表示と比べるまで申請しない（デスクトップの登録と同じ順序）。
  await deps.onPeerCertificate?.(peer.fingerprint);
  const client = deps.pinnedClient(peer.certificatePem, peer.fingerprint);

  const fingerprint = await deps.collectFingerprint();
  const secret = generateClaimSecret();
  const claim = await client.preAuth('POST', '/v1/pairing/claims', {
    request_id: newRequestId(),
    pairing_code: pairingCode,
    device_name: deps.deviceName,
    platform: deps.platform,
    claim_secret_hash: claimSecretHash(secret),
    home_fingerprint: fingerprint,
  });
  if (claim.kind !== 'response')
    return { kind: 'failed', reason: `claim_${claim.kind}` };
  // 申請の受付は 202（中枢の承認待ち。契約の claimPairing）。
  if (claim.status !== 202 || !isRecord(claim.body)) {
    const code = isRecord(claim.body) ? claim.body['code'] : null;
    return {
      kind: 'failed',
      reason: `claim_rejected_${claim.status}${typeof code === 'string' ? `_${code}` : ''}`,
    };
  }
  const claimId = claim.body['claim_id'];
  if (typeof claimId !== 'string')
    return { kind: 'failed', reason: 'claim_response_invalid' };
  deps.onClaimCreated?.(claimId);

  // 承認されるまで受け取りを試す。承認前は 409（conflict）、期限切れ・拒否・使用済みは 410。
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const pickup = await client.preAuth(
      'POST',
      `/v1/pairing/claims/${encodeURIComponent(claimId)}/token`,
      { claim_secret: secret, home_fingerprint: fingerprint },
    );
    if (pickup.kind === 'response' && pickup.status === 200) {
      if (!isRecord(pickup.body))
        return { kind: 'failed', reason: 'pickup_response_invalid' };
      const deviceId = pickup.body['device_id'];
      const deviceToken = pickup.body['device_token'];
      if (typeof deviceId !== 'string' || typeof deviceToken !== 'string')
        return { kind: 'failed', reason: 'pickup_response_invalid' };
      return {
        kind: 'paired',
        deviceId,
        deviceToken,
        certificatePem: peer.certificatePem,
        fingerprint: peer.fingerprint,
      };
    }
    if (pickup.kind === 'response' && pickup.status === 409) {
      if (Date.now() >= deadline)
        return { kind: 'failed', reason: 'approval_timeout' };
      await sleep(pollIntervalMs);
      continue;
    }
    if (pickup.kind === 'response') {
      const code = isRecord(pickup.body) ? pickup.body['code'] : null;
      return {
        kind: 'failed',
        reason: `pickup_rejected_${pickup.status}${typeof code === 'string' ? `_${code}` : ''}`,
      };
    }
    // 接続できない間も、期限までは待ち直す（申請の期限内なら承認され得る）。
    if (Date.now() >= deadline)
      return { kind: 'failed', reason: `pickup_${pickup.kind}` };
    await sleep(pollIntervalMs);
  }
}
