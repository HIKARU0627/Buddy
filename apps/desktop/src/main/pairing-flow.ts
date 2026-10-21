// 端末側のペアリングの手順（設計 02 端末登録と接続、ADR 0009・0021・0022・0025）。
//
//   begin（最初の接続で証明書を受け取る。要求を 1 バイトも送らない）
//   → fingerprint_check（指紋を表示する。本人が「一致」を押すまで申請を送らない）
//   → confirm（表示した指紋と受け取った証明書の指紋が同じときだけ）→ code_entry
//   → submit（その指紋でピン留めした新しい接続で申請。申請用の秘密の SHA-256 だけを送る）→ waiting_approval
//   → 受取り（承認を待つ間は 409 の間だけ間隔を空けて受取りを試す）→ トークンを保存して終わる
//
// - 受取りの結果が分からない（接続できない・503）ときは自動で再送しない（pickup_unknown。中枢で失効してやり直す）。
// - 申請用の秘密・トークンは Renderer・IPC・ログに出さない。画面へ返すのは手順・宛先・指紋・期限・失敗の理由だけ。
// Electron に依存しない。通信・時計・保存・自宅の指紋は注入する。

import { createHash, randomBytes } from 'node:crypto';
import type {
  DeviceCredential,
  DevicePlatform,
  HomeFingerprint,
  PairingClaim,
} from '@buddy/contracts';
import type { ClientApiOutcome } from '@buddy/client';
import { SecretText } from './credential-store.js';
import type { StoredCredential } from './credential-store.js';
import type {
  HubHttpRequest,
  PeerCertificateResult,
  PinnedHub,
} from './hub-transport.js';

export type PairingStep =
  | 'fetching_certificate'
  | 'fingerprint_check'
  | 'code_entry'
  | 'claiming'
  | 'waiting_approval'
  | 'failed';

export type PairingFailure =
  | 'certificate_unavailable'
  | 'certificate_changed'
  | 'unreachable'
  | 'pairing_failed'
  | 'outside_home_network'
  | 'rate_limited'
  | 'claim_expired'
  | 'pickup_refused'
  | 'pickup_unknown'
  | 'secure_storage_unavailable'
  | 'storage_failed'
  | 'protocol_error';

export interface PairingView {
  readonly step: PairingStep;
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string | null;
  readonly claim_expires_at: string | null;
  readonly failure: PairingFailure | null;
  // 申請の確認コード（承認待ちのときだけ。中枢の画面の一覧と同じ値。B03-06）。
  readonly claim_check: string | null;
}

export interface PairingFlowOptions {
  readonly fetchCertificate: (
    host: string,
    port: number,
  ) => Promise<PeerCertificateResult>;
  // ピン留めした接続での認証前の要求（申請・受取り）。
  readonly request: (
    hub: PinnedHub,
    request: HubHttpRequest,
  ) => Promise<ClientApiOutcome>;
  readonly valid: (name: string, value: unknown) => boolean;
  readonly collectHome: () => Promise<HomeFingerprint>;
  // 受け取ったトークンを保存する。失敗は例外。
  readonly store: (credential: StoredCredential) => void;
  readonly onRegistered: (credential: StoredCredential) => void;
  readonly onChange: () => void;
  readonly now: () => number;
  readonly setTimer: (ms: number, run: () => void) => () => void;
  readonly newRequestId: () => string;
  readonly platform: DevicePlatform;
  // 承認を待つ間の受取りの間隔。
  readonly pollIntervalMs?: number;
  readonly log?: (code: string) => void;
}

export const PAIRING_POLL_INTERVAL_MS = 2_000;

// 申請の確認コード（ADR 0026）: SHA-256("buddy/pairing-claim-check/v1" NUL 申請用の秘密の SHA-256 の 16 進) の
// 先頭 4 バイト。中枢（storage）も同じ定義で求め、本人が両方の画面で見比べる。
export function claimCheckOf(claimSecretHashHex: string): string {
  return createHash('sha256')
    .update(`buddy/pairing-claim-check/v1\u0000${claimSecretHashHex}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
}

export type PairingCommandResult = 'ok' | 'step_mismatch';

interface Attempt {
  readonly host: string;
  readonly port: number;
  step: PairingStep;
  certificatePem: string | null;
  fingerprint: string | null;
  claimId: string | null;
  claimExpiresAt: number | null;
  claimCheck: string | null;
  // 申請用の秘密（受取りの時だけ送る）。
  secret: SecretText | null;
  failure: PairingFailure | null;
  cancelTimer: (() => void) | null;
}

function failureOf(
  outcome: Exclude<ClientApiOutcome, { kind: 'response' }>,
): PairingFailure {
  return outcome.kind === 'certificate_mismatch'
    ? 'certificate_changed'
    : 'unreachable';
}

function codeOf(body: unknown): string | null {
  return typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>)['code'] === 'string'
    ? ((body as Record<string, unknown>)['code'] as string)
    : null;
}

export class PairingFlow {
  readonly #options: PairingFlowOptions;
  #attempt: Attempt | null = null;

  constructor(options: PairingFlowOptions) {
    this.#options = options;
  }

  get view(): PairingView | null {
    const attempt = this.#attempt;
    if (attempt === null) return null;
    return {
      step: attempt.step,
      host: attempt.host,
      port: attempt.port,
      fingerprint: attempt.fingerprint,
      claim_expires_at:
        attempt.claimExpiresAt === null
          ? null
          : new Date(attempt.claimExpiresAt).toISOString(),
      failure: attempt.failure,
      claim_check:
        attempt.step === 'waiting_approval' ? attempt.claimCheck : null,
    };
  }

  // 新しく始める（失敗した後・やめた後も）。進行中の手順があれば step_mismatch。
  begin(host: string, port: number): PairingCommandResult {
    const current = this.#attempt;
    if (current !== null && current.step !== 'failed') return 'step_mismatch';
    const attempt: Attempt = {
      host,
      port,
      step: 'fetching_certificate',
      certificatePem: null,
      fingerprint: null,
      claimId: null,
      claimExpiresAt: null,
      claimCheck: null,
      secret: null,
      failure: null,
      cancelTimer: null,
    };
    this.#attempt = attempt;
    this.#changed();
    void this.#fetch(attempt);
    return 'ok';
  }

  // 本人が「一致」を押した。表示した指紋が受け取った証明書の指紋と同じときだけ進む。
  confirm(fingerprint: string): PairingCommandResult {
    const attempt = this.#attempt;
    if (
      attempt === null ||
      attempt.step !== 'fingerprint_check' ||
      attempt.fingerprint !== fingerprint
    )
      return 'step_mismatch';
    attempt.step = 'code_entry';
    this.#changed();
    return 'ok';
  }

  submit(code: string, deviceName: string): PairingCommandResult {
    const attempt = this.#attempt;
    if (attempt === null || attempt.step !== 'code_entry')
      return 'step_mismatch';
    attempt.step = 'claiming';
    this.#changed();
    void this.#claim(attempt, code, deviceName);
    return 'ok';
  }

  // やめる。中枢へは何も送らない（申請は期限で無効になる）。
  cancel(): void {
    const attempt = this.#attempt;
    if (attempt === null) return;
    attempt.cancelTimer?.();
    this.#attempt = null;
    this.#changed();
  }

  // 保存できない状態でペアリングを失敗にする（安全な保存が使えなくなった）。
  failStorageUnavailable(): void {
    const attempt = this.#attempt;
    if (attempt === null || attempt.step === 'failed') return;
    this.#fail(attempt, 'secure_storage_unavailable');
  }

  async #fetch(attempt: Attempt): Promise<void> {
    const result = await this.#options.fetchCertificate(
      attempt.host,
      attempt.port,
    );
    if (this.#attempt !== attempt) return;
    if (!result.ok) {
      this.#options.log?.(`pairing_certificate_unavailable:${result.reason}`);
      this.#fail(attempt, 'certificate_unavailable');
      return;
    }
    attempt.certificatePem = result.certificatePem;
    attempt.fingerprint = result.fingerprint;
    attempt.step = 'fingerprint_check';
    this.#changed();
  }

  #hub(attempt: Attempt): PinnedHub {
    if (attempt.certificatePem === null || attempt.fingerprint === null)
      throw new Error('pairing_hub_unknown');
    return {
      host: attempt.host,
      port: attempt.port,
      certificatePem: attempt.certificatePem,
      fingerprint: attempt.fingerprint,
    };
  }

  async #claim(
    attempt: Attempt,
    code: string,
    deviceName: string,
  ): Promise<void> {
    const secret = randomBytes(32).toString('base64url');
    attempt.secret = new SecretText(secret);
    const secretHash = createHash('sha256')
      .update(secret, 'ascii')
      .digest('hex');
    const home = await this.#collectHome();
    if (this.#attempt !== attempt) return;
    const outcome = await this.#options.request(this.#hub(attempt), {
      method: 'POST',
      path: '/v1/pairing/claims',
      body: {
        request_id: this.#options.newRequestId(),
        pairing_code: code,
        device_name: deviceName,
        platform: this.#options.platform,
        claim_secret_hash: secretHash,
        home_fingerprint: home,
      },
    });
    if (this.#attempt !== attempt) return;
    if (outcome.kind !== 'response') {
      this.#fail(attempt, failureOf(outcome));
      return;
    }
    if (
      outcome.status === 202 &&
      this.#options.valid('PairingClaim', outcome.body)
    ) {
      const claim = outcome.body as PairingClaim;
      attempt.claimId = claim.claim_id;
      attempt.claimExpiresAt = Date.parse(claim.expires_at);
      attempt.claimCheck = claimCheckOf(secretHash);
      attempt.step = 'waiting_approval';
      this.#changed();
      this.#schedulePickup(attempt, 0);
      return;
    }
    const code_ = codeOf(outcome.body);
    this.#fail(
      attempt,
      outcome.status === 410
        ? 'pairing_failed'
        : outcome.status === 403 && code_ === 'outside_home_network'
          ? 'outside_home_network'
          : outcome.status === 429
            ? 'rate_limited'
            : 'protocol_error',
    );
  }

  #schedulePickup(attempt: Attempt, delay: number): void {
    attempt.cancelTimer = this.#options.setTimer(delay, () => {
      attempt.cancelTimer = null;
      void this.#pickup(attempt);
    });
  }

  async #pickup(attempt: Attempt): Promise<void> {
    if (this.#attempt !== attempt || attempt.step !== 'waiting_approval')
      return;
    if (
      attempt.claimExpiresAt !== null &&
      this.#options.now() >= attempt.claimExpiresAt
    ) {
      this.#fail(attempt, 'claim_expired');
      return;
    }
    const secret = attempt.secret;
    if (secret === null || attempt.claimId === null) return;
    const home = await this.#collectHome();
    if (this.#attempt !== attempt) return;
    const outcome = await this.#options.request(this.#hub(attempt), {
      method: 'POST',
      path: `/v1/pairing/claims/${encodeURIComponent(attempt.claimId)}/token`,
      body: { claim_secret: secret.reveal(), home_fingerprint: home },
    });
    if (this.#attempt !== attempt) return;
    if (outcome.kind !== 'response') {
      // 受け取れたかが分からない。自動で再送しない。
      this.#fail(attempt, 'pickup_unknown');
      return;
    }
    const interval = this.#options.pollIntervalMs ?? PAIRING_POLL_INTERVAL_MS;
    // 承認前（409）・頻度の上限（429）はトークンが出ていない確かな応答なので、間隔を空けて試す。
    if (outcome.status === 409 || outcome.status === 429) {
      this.#schedulePickup(attempt, interval);
      return;
    }
    if (
      outcome.status === 200 &&
      this.#options.valid('DeviceCredential', outcome.body)
    ) {
      const issued = outcome.body as DeviceCredential;
      const credential: StoredCredential = {
        deviceId: issued.device_id,
        token: new SecretText(issued.device_token),
        issuedAt: issued.issued_at,
        hub: {
          host: attempt.host,
          port: attempt.port,
          certificatePem: attempt.certificatePem ?? '',
          fingerprint: attempt.fingerprint ?? '',
        },
      };
      try {
        this.#options.store(credential);
      } catch {
        // 保存できなかったトークンは捨てる（中枢の端末の一覧から失効してやり直す）。
        this.#options.log?.('pairing_credential_store_failed');
        this.#fail(attempt, 'storage_failed');
        return;
      }
      attempt.secret = null;
      this.#attempt = null;
      this.#options.log?.('pairing_registered');
      this.#changed();
      this.#options.onRegistered(credential);
      return;
    }
    const code = codeOf(outcome.body);
    this.#fail(
      attempt,
      outcome.status === 200 || outcome.status >= 500
        ? 'pickup_unknown'
        : outcome.status === 403 && code === 'outside_home_network'
          ? 'outside_home_network'
          : 'pickup_refused',
    );
  }

  async #collectHome(): Promise<HomeFingerprint> {
    try {
      return await this.#options.collectHome();
    } catch {
      return { gateway_mac: null, subnet: null, ssid: null };
    }
  }

  #fail(attempt: Attempt, failure: PairingFailure): void {
    attempt.cancelTimer?.();
    attempt.cancelTimer = null;
    attempt.secret = null;
    attempt.step = 'failed';
    attempt.failure = failure;
    this.#options.log?.(`pairing_failed:${failure}`);
    this.#changed();
  }

  #changed(): void {
    this.#options.onChange();
  }
}
