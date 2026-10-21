// デスクトップの main の中枢との接続（設計 02 端末登録と接続、07 §2〜§4、ADR 0014・0025）。
//
// - 登録（保存したトークン）・ペアリング（pairing-flow）・接続の状態機械（@buddy/client）・自宅の指紋の報告
//   （home-reporter）をまとめ、画面へ出す接続の状態（DesktopConnectionView）と状態欄の中枢の欄を作る。
// - 限定 IPC のうち接続・ペアリングのチャネルを受け付ける。受付の順は ADR 0014 と同じ（形式 → 規則 → 処理 →
//   送る前の検査）。手順に合わない要求は pairing_step_mismatch、安全な保存がなければ secure_storage_unavailable。
// - トークン・申請用の秘密・端末 ID・自宅の指紋の値は画面・IPC・ログに出さない（ログは理由のコードだけ）。
// - ロック状態は端末の状態（device-controller）から受け取り、要求の Buddy-Lock-State と表示の範囲に使う。
// Electron に依存しない。safeStorage・指紋の収集・接続口の一覧は Electron の層が注入する。

import type {
  DesktopConnectionView,
  DesktopIpcChannel,
  DesktopIpcResponse,
  DevicePlatform,
  HomeFingerprint,
} from '@buddy/contracts';
import {
  ClientConnection,
  hubConnectionOf,
  type BackoffPolicy,
  type ClientClock,
  type ClientLockState,
  type ClientTransport,
  type HubConnection,
  type LinkState,
} from '@buddy/client';
import {
  DESKTOP_IPC_CHANNELS,
  admitDesktopRequest,
  admitPairingHost,
  type DesktopIoState,
  type DesktopIpcRejectReason,
  type DesktopIpcSender,
} from '@buddy/domain';
import type { DesktopContract } from './contract.js';
import {
  loadCredential,
  protectionCheck,
  saveCredential,
} from './credential-store.js';
import type { SecretProtector, StoredCredential } from './credential-store.js';
import { DesktopContractError } from './device-controller.js';
import { HomeReporter, sanitizeFingerprint } from './home-reporter.js';
import type { HomeObservation, HomeReportResult } from './home-reporter.js';
import {
  createHubTransport,
  fetchPeerCertificate,
  hubRequest,
} from './hub-transport.js';
import type {
  HubHttpRequest,
  PeerCertificateResult,
  PinnedHub,
} from './hub-transport.js';
import { PairingFlow } from './pairing-flow.js';

export const CONNECTION_CHANNELS: readonly DesktopIpcChannel[] = [
  'desktop.get_connection',
  'desktop.pairing_begin',
  'desktop.pairing_confirm',
  'desktop.pairing_submit',
  'desktop.pairing_cancel',
];

export type Registration =
  | 'unregistered'
  | 'registered'
  | 'reregistration_required'
  | 'secure_storage_unavailable';

export interface HubStatus {
  readonly connection: HubConnection;
  readonly lastConfirmedAt: string | null;
}

export interface DesktopCoreLinkOptions {
  readonly contract: DesktopContract;
  readonly credentialPath: string;
  readonly protector: SecretProtector;
  readonly clock: ClientClock;
  readonly platform: DevicePlatform;
  readonly collectHome: () => Promise<HomeObservation>;
  readonly networkSignature: () => string;
  readonly onChange: () => void;
  readonly log?: (code: string) => void;
  // 以下は試験で差し替える。
  readonly transportFor?: (
    hub: PinnedHub,
    token: () => string,
  ) => ClientTransport;
  readonly fetchCertificate?: (
    host: string,
    port: number,
  ) => Promise<PeerCertificateResult>;
  readonly pairingRequest?: typeof hubRequest;
  readonly backoff?: BackoffPolicy;
  readonly aliveTimeoutMs?: number;
  readonly pairingPollIntervalMs?: number;
  readonly homeReportIntervalMs?: number;
  readonly networkWatchIntervalMs?: number;
}

export interface ConnectionIpcOutcome {
  readonly response: DesktopIpcResponse;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

export class DesktopCoreLink {
  readonly #options: DesktopCoreLinkOptions;
  readonly #pairing: PairingFlow;
  #registration: Registration = 'unregistered';
  #connection: ClientConnection | null = null;
  #reporter: HomeReporter | null = null;
  #home: HomeReportResult | null = null;
  #lockState: ClientLockState = 'unknown';
  #started = false;

  constructor(options: DesktopCoreLinkOptions) {
    this.#options = options;
    this.#pairing = new PairingFlow({
      fetchCertificate: options.fetchCertificate ?? fetchPeerCertificate,
      request: (hub: PinnedHub, request: HubHttpRequest) =>
        (options.pairingRequest ?? hubRequest)(hub, request),
      valid: (name, value) => options.contract.valid(name, value),
      collectHome: () => this.#collectHome(),
      store: (credential) =>
        saveCredential(options.credentialPath, options.protector, credential),
      onRegistered: (credential) => this.#registered(credential),
      onChange: () => options.onChange(),
      now: () => options.clock.now(),
      setTimer: (ms, run) => options.clock.setTimer(ms, run),
      newRequestId: () => options.clock.newRequestId(),
      platform: options.platform,
      ...(options.pairingPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.pairingPollIntervalMs }),
      log: (code) => this.#log(code),
    });
  }

  get registration(): Registration {
    return this.#registration;
  }

  // 試験用: 接続の状態機械の状態（トークンを含まない）。
  get linkState(): LinkState | null {
    return this.#connection?.state ?? null;
  }

  start(lockState: ClientLockState): void {
    if (this.#started) return;
    this.#started = true;
    this.#lockState = lockState;
    const loaded = loadCredential(
      this.#options.credentialPath,
      this.#options.protector,
    );
    switch (loaded.kind) {
      case 'unprotected':
        this.#log(`credential_unprotected:${loaded.reason}`);
        this.#registration = 'secure_storage_unavailable';
        break;
      case 'missing':
        this.#registration = 'unregistered';
        break;
      case 'unreadable':
        this.#log('credential_unreadable');
        this.#registration = 'reregistration_required';
        break;
      case 'loaded':
        this.#connect(loaded.credential);
        break;
    }
    this.#options.onChange();
  }

  stop(): void {
    this.#started = false;
    // 終了では受取りの結果を待たない（受取りの最中なら、中枢で失効してやり直す）。
    this.#pairing.dispose();
    this.#disconnect();
  }

  setLockState(lockState: ClientLockState): void {
    if (lockState === this.#lockState) return;
    this.#lockState = lockState;
    this.#connection?.setLockState(lockState);
    this.#options.onChange();
  }

  // スリープからの復帰・ネットワークの変化（Electron の層が知らせる）。
  networkMayHaveChanged(reason: string): void {
    this.#reporter?.reportNow(reason);
    this.#connection?.retryNow();
  }

  hubStatus(): HubStatus {
    const state = this.#connection?.state;
    if (state === undefined)
      return { connection: 'not_connected', lastConfirmedAt: null };
    const connection = hubConnectionOf(state);
    return {
      connection,
      // 接続していない（未登録・再登録が必要）ときは最終確認時刻を出さない（状態欄の意味検査）。
      lastConfirmedAt:
        connection === 'not_connected' ? null : iso(state.lastConfirmedAt),
    };
  }

  // 画面へ出す接続の状態。ロック中・不明は内容を隠す。
  view(lockState: DesktopIoState['lockState']): DesktopConnectionView {
    if (lockState !== 'unlocked')
      return { visibility: 'hidden', lock_state: lockState };
    const state = this.#connection?.state ?? null;
    const registration = this.#registration;
    const link: Extract<
      DesktopConnectionView,
      { visibility: 'shown' }
    >['link'] =
      registration === 'reregistration_required'
        ? 'reregistration_required'
        : registration !== 'registered' || state === null
          ? 'not_connected'
          : state.phase === 'live'
            ? 'connected'
            : state.phase === 'waiting_retry'
              ? 'waiting_retry'
              : state.phase === 'upgrade_required'
                ? 'upgrade_required'
                : state.phase === 'stopped'
                  ? 'not_connected'
                  : 'connecting';
    const home = this.#home;
    const view: DesktopConnectionView = {
      visibility: 'shown',
      registration,
      link,
      link_reason:
        registration === 'registered' ||
        registration === 'reregistration_required'
          ? (state?.reason ?? null)
          : null,
      last_confirmed_at:
        link === 'not_connected' || link === 'reregistration_required'
          ? null
          : iso(state?.lastConfirmedAt ?? null),
      retry_at: link === 'waiting_retry' ? iso(state?.retryAt ?? null) : null,
      pairing: this.#pairing.view,
      home_network:
        home === null || registration !== 'registered'
          ? null
          : {
              allowed: home.status.allowed,
              exempt: home.status.exempt,
              reasons: [...home.status.reasons],
              reported_at: new Date(home.reportedAt).toISOString(),
            },
      operations:
        link === 'connected' && state?.view === 'full'
          ? [...state.operations]
          : [],
    };
    const errors = this.#options.contract.connectionErrors(view);
    if (errors.length > 0) throw new DesktopContractError(errors);
    return view;
  }

  // 接続・ペアリングのチャネルの要求。ioState は端末の状態（ロック・停止）。
  handleIpc(
    ipcChannel: string,
    raw: unknown,
    sender: DesktopIpcSender,
    ioState: DesktopIoState,
  ): ConnectionIpcOutcome {
    const contract = this.#options.contract;
    if (
      !contract.isRequest(raw) ||
      raw.channel !== ipcChannel ||
      !CONNECTION_CHANNELS.includes(raw.channel)
    )
      return this.#reject(
        echoRequestId(raw),
        echoChannel(raw, ipcChannel),
        'invalid_request',
      );
    const admission = admitDesktopRequest(raw.channel, null, ioState, sender);
    if (!admission.ok)
      return this.#reject(raw.request_id, raw.channel, admission.reason);
    switch (raw.channel) {
      case 'desktop.pairing_begin': {
        if (this.#registration === 'secure_storage_unavailable')
          return this.#reject(
            raw.request_id,
            raw.channel,
            'secure_storage_unavailable',
          );
        // 保護が使えなくなっていないかを始める前に確かめる（受け取っても保存できないトークンを作らない）。
        if (!protectionCheck(this.#options.protector).ok) {
          this.#registration = 'secure_storage_unavailable';
          this.#options.onChange();
          return this.#reject(
            raw.request_id,
            raw.channel,
            'secure_storage_unavailable',
          );
        }
        if (this.#registration === 'registered')
          return this.#reject(
            raw.request_id,
            raw.channel,
            'pairing_step_mismatch',
          );
        // 宛先は Tailscale のアドレス・ループバック・*.ts.net の名前だけを受け付け、正規化して使う
        // （末尾のドットを除いて小文字にする。保存した宛先をそのまま読み戻せるように。ADR 0025）。
        const host = admitPairingHost(raw.payload.host);
        if (!host.ok)
          return this.#reject(raw.request_id, raw.channel, host.reason);
        if (this.#pairing.begin(host.host, raw.payload.port) !== 'ok')
          return this.#reject(
            raw.request_id,
            raw.channel,
            'pairing_step_mismatch',
          );
        break;
      }
      case 'desktop.pairing_confirm':
        if (this.#pairing.confirm(raw.payload.fingerprint) !== 'ok')
          return this.#reject(
            raw.request_id,
            raw.channel,
            'pairing_step_mismatch',
          );
        break;
      case 'desktop.pairing_submit':
        if (
          this.#pairing.submit(
            raw.payload.pairing_code,
            raw.payload.device_name,
          ) !== 'ok'
        )
          return this.#reject(
            raw.request_id,
            raw.channel,
            'pairing_step_mismatch',
          );
        break;
      case 'desktop.pairing_cancel':
        this.#pairing.cancel();
        break;
      default:
        break;
    }
    return this.#respond({
      request_id: raw.request_id,
      channel: raw.channel as Extract<
        DesktopIpcResponse,
        { connection: unknown }
      >['channel'],
      outcome: 'ok',
      connection: this.view(ioState.lockState),
    });
  }

  // --- 内部 ---

  #registered(credential: StoredCredential): void {
    // 止めた後には接続を始めない（保存した記録は次の start で読む）。
    if (!this.#started) return;
    this.#disconnect();
    this.#home = null;
    this.#connect(credential);
    this.#options.onChange();
  }

  #connect(credential: StoredCredential): void {
    this.#registration = 'registered';
    const hub: PinnedHub = credential.hub;
    const token = () => credential.token.reveal();
    const transport = (
      this.#options.transportFor ??
      ((h, t) => createHubTransport({ hub: h, token: t }))
    )(hub, token);
    const connection = new ClientConnection({
      transport,
      clock: this.#options.clock,
      contract: {
        valid: (name, value) => this.#options.contract.valid(name, value),
      },
      lockState: this.#lockState,
      ...(this.#options.backoff === undefined
        ? {}
        : { backoff: this.#options.backoff }),
      ...(this.#options.aliveTimeoutMs === undefined
        ? {}
        : { aliveTimeoutMs: this.#options.aliveTimeoutMs }),
    });
    let previous: LinkState = connection.state;
    connection.onChange((state) => {
      if (state.phase !== previous.phase || state.reason !== previous.reason)
        this.#log(
          `link:${state.phase}${state.reason ? `:${state.reason}` : ''}`,
        );
      if (
        state.phase === 'reregistration_required' &&
        this.#registration === 'registered'
      ) {
        this.#registration = 'reregistration_required';
        this.#reporter?.stop();
      }
      // 中枢の API の major が違えば、以後は要求を送らない。自宅の指紋の報告も止める（レビューの指摘 L4）。
      if (state.phase === 'upgrade_required') this.#reporter?.stop();
      // 自宅の外で拒否されたら、すぐに指紋を報告し直す（通れば次の接続で使える）。
      if (
        state.reason === 'outside_home_network' &&
        previous.reason !== 'outside_home_network'
      )
        this.#reporter?.reportNow('outside_home_network');
      previous = state;
      this.#options.onChange();
    });
    this.#connection = connection;
    const reporter = new HomeReporter({
      collect: () => this.#options.collectHome(),
      send: (body) =>
        transport.request({
          method: 'POST',
          path: '/v1/home-network/reports',
          body,
          lockState: this.#lockState,
        }),
      valid: (name, value) => this.#options.contract.valid(name, value),
      networkSignature: this.#options.networkSignature,
      now: () => this.#options.clock.now(),
      setTimer: (ms, run) => this.#options.clock.setTimer(ms, run),
      newRequestId: () => this.#options.clock.newRequestId(),
      onResult: (result) => {
        this.#home = result;
        // 自宅の外で待っていた接続は、判定が通ればすぐに接続し直す。
        if (
          result.status.allowed &&
          connection.state.phase === 'waiting_retry' &&
          connection.state.reason === 'outside_home_network'
        )
          connection.retryNow();
        this.#options.onChange();
      },
      ...(this.#options.homeReportIntervalMs === undefined
        ? {}
        : { intervalMs: this.#options.homeReportIntervalMs }),
      ...(this.#options.networkWatchIntervalMs === undefined
        ? {}
        : { watchIntervalMs: this.#options.networkWatchIntervalMs }),
      log: (code) => this.#log(code),
    });
    this.#reporter = reporter;
    reporter.start();
    connection.start();
  }

  #disconnect(): void {
    this.#reporter?.stop();
    this.#reporter = null;
    this.#connection?.stop();
    this.#connection = null;
  }

  // 試験用: 接続の状態機械（命令の送信を確かめる）。トークンは含まない。
  get connection(): ClientConnection | null {
    return this.#connection;
  }

  // 試験用: 進行中の自宅の指紋の報告が終わるまで待つ。
  async homeReportIdle(): Promise<void> {
    await this.#reporter?.idle();
  }

  async #collectHome(): Promise<HomeFingerprint> {
    let observation: HomeObservation;
    try {
      observation = await this.#options.collectHome();
    } catch {
      observation = { gateway_mac: null, subnet: null, ssid: null };
    }
    return sanitizeFingerprint(observation, (name, value) =>
      this.#options.contract.valid(name, value),
    );
  }

  #reject(
    requestId: string | null,
    channel: DesktopIpcChannel | null,
    reason: DesktopIpcRejectReason,
  ): ConnectionIpcOutcome {
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'rejected',
      reason,
    });
  }

  #respond(response: DesktopIpcResponse): ConnectionIpcOutcome {
    const errors = this.#options.contract.responseErrors(response);
    if (errors.length > 0) throw new DesktopContractError(errors);
    return { response };
  }

  #log(code: string): void {
    this.#options.log?.(code);
  }
}

function echoRequestId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = (raw as Record<string, unknown>)['request_id'];
  return typeof id === 'string' && UUID_V4.test(id) ? id : null;
}

function echoChannel(
  raw: unknown,
  ipcChannel: string,
): DesktopIpcChannel | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const channel = (raw as Record<string, unknown>)['channel'];
  return typeof channel === 'string' &&
    channel === ipcChannel &&
    (DESKTOP_IPC_CHANNELS as readonly string[]).includes(channel)
    ? (channel as DesktopIpcChannel)
    : null;
}
