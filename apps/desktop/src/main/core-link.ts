// デスクトップの main の中枢との接続（設計 02 端末登録と接続、07 §2〜§4、ADR 0014・0025）。
//
// - 登録（保存したトークン）・ペアリング（pairing-flow）・接続の状態機械（@buddy/client）・自宅の指紋の報告
//   （home-reporter）をまとめ、画面へ出す接続の状態（DesktopConnectionView）と状態欄の中枢の欄を作る。
// - 限定 IPC のうち接続・ペアリングのチャネルを受け付ける。受付の順は ADR 0014 と同じ（形式 → 規則 → 処理 →
//   送る前の検査）。手順に合わない要求は pairing_step_mismatch、安全な保存がなければ secure_storage_unavailable。
// - トークン・申請用の秘密・端末 ID・自宅の指紋の値は画面・IPC・ログに出さない（ログは理由のコードだけ）。
//   中枢の画面の自宅の登録（B03-08）も、画面へは伏せた表示（home-registration.ts）と参照だけを渡す。
// - ロック状態は端末の状態（device-controller）から受け取り、要求の Buddy-Lock-State と表示の範囲に使う。
// Electron に依存しない。safeStorage・指紋の収集・接続口の一覧は Electron の層が注入する。

import type {
  DeviceList,
  PairingClaimList,
  PairingSession,
  DesktopConnectionView,
  DesktopIpcChannel,
  DesktopIpcResponse,
  DevicePlatform,
  HomeFingerprint,
  HomeRegistration,
  HomeRegistrationState,
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
import {
  HOME_COLLECT_TIMEOUT_MS,
  maskHomeObservation,
  registrable,
  sameFingerprint,
} from './home-registration.js';
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

// 中枢の画面の端末だけのチャネル（B03-06、ADR 0026）。
export const ADMIN_CHANNELS: readonly DesktopIpcChannel[] = [
  'desktop.claims_list',
  'desktop.claim_decide',
  'desktop.devices_list',
  'desktop.device_revoke',
  'desktop.pairing_open',
  // B03-08: 自宅のネットワークの登録（ADR 0022）。
  'desktop.home_status',
  'desktop.home_register',
];

// 中枢の画面のこのマシンの指紋の読み取り（main だけが持つ。画面へは伏せた表示だけを出す）。
interface HubHomeReading {
  readonly fingerprint: HomeFingerprint;
  readonly unavailable: readonly string[];
  readonly collectedAt: number;
}

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
  // 中枢の画面の自宅の登録で、このマシンの指紋を読み取る上限（既定 HOME_COLLECT_TIMEOUT_MS）。
  readonly homeCollectTimeoutMs?: number;
}

export interface ConnectionIpcOutcome {
  readonly response: DesktopIpcResponse;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// 最終確認時刻だけが変わったときに画面へ知らせる最短の間隔（レビューの指摘 L8）。中枢の ping（15 秒）の
// たびには知らせるが、イベントの取り直しなどで続けて変わるときは間引く。
export const CONFIRMED_ONLY_NOTIFY_INTERVAL_MS = 10_000;

// 画面（接続の欄・状態欄）に出る接続の状態か。cursor・接続範囲・ID などの変化だけでは画面へ知らせない。
function visibleChange(previous: LinkState, state: LinkState): boolean {
  return (
    state.phase !== previous.phase ||
    state.reason !== previous.reason ||
    state.retryAt !== previous.retryAt ||
    state.view !== previous.view ||
    state.operations !== previous.operations ||
    (state.lastConfirmedAt === null) !== (previous.lastConfirmedAt === null)
  );
}

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
  // 登録した中枢の宛先（再登録の宛先の初期値。秘密ではない）。
  #hubTarget: { readonly host: string; readonly port: number } | null = null;
  // 中枢の画面の端末として中枢が認めたか（承認待ちの申請の一覧が 200）。null は未確認（B03-06）。
  #hubScreen: boolean | null = null;
  // 一覧ごとに作る参照 → 申請 ID・端末 ID。参照だけを画面へ渡す（ID を画面に持たせない）。
  #claimRefs = new Map<string, string>();
  #deviceRefs = new Map<string, string>();
  // 自宅の登録の参照 → 画面に伏せて見せた指紋（B03-08）。最後に見せた 1 つだけを持つ。
  #homeRef: {
    readonly ref: string;
    readonly fingerprint: HomeFingerprint;
  } | null = null;

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
    if (lockState === 'unlocked') void this.#probeHubScreen();
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
      hub_screen: link === 'connected' && this.#hubScreen === true,
      hub_target:
        registration === 'registered' ||
        registration === 'reregistration_required'
          ? this.#hubTarget
          : null,
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
      case 'desktop.pairing_confirm': {
        const confirmed = this.#pairing.confirm(
          raw.payload.fingerprint,
          raw.payload.fingerprint_tail,
        );
        if (confirmed !== 'ok')
          return this.#reject(
            raw.request_id,
            raw.channel,
            confirmed === 'tail_mismatch'
              ? 'fingerprint_tail_mismatch'
              : 'pairing_step_mismatch',
          );
        break;
      }
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
    this.#hubTarget = { host: credential.hub.host, port: credential.hub.port };
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
    let notifiedAt = Number.NEGATIVE_INFINITY;
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
        this.#hubScreen = null;
        this.#reporter?.stop();
      }
      // 接続するたびに中枢の画面の端末かを確かめる（B03-06）。
      if (state.phase === 'live' && previous.phase !== 'live')
        void this.#probeHubScreen();
      // 中枢の API の major が違えば、以後は要求を送らない。自宅の指紋の報告も止める（レビューの指摘 L4）。
      if (state.phase === 'upgrade_required') this.#reporter?.stop();
      // 自宅の外で拒否されたら、すぐに指紋を報告し直す（通れば次の接続で使える）。
      if (
        state.reason === 'outside_home_network' &&
        previous.reason !== 'outside_home_network'
      )
        this.#reporter?.reportNow('outside_home_network');
      const visible = visibleChange(previous, state);
      const confirmedOnly =
        !visible && state.lastConfirmedAt !== previous.lastConfirmedAt;
      previous = state;
      if (!visible && !confirmedOnly) return;
      const now = this.#options.clock.now();
      if (confirmedOnly && now - notifiedAt < CONFIRMED_ONLY_NOTIFY_INTERVAL_MS)
        return;
      notifiedAt = now;
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

  // 中枢の画面の端末か（承認待ちの申請の一覧の経路が 200 か、403 hub_screen_required か）。
  async #probeHubScreen(): Promise<void> {
    const connection = this.#connection;
    if (connection === null || connection.state.phase !== 'live') return;
    if (this.#lockState !== 'unlocked') return;
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/pairing/claims',
    });
    if (connection !== this.#connection || outcome.kind !== 'response') return;
    const before = this.#hubScreen;
    if (
      outcome.status === 200 &&
      this.#options.contract.valid('PairingClaimList', outcome.body)
    )
      this.#hubScreen = true;
    else if (
      outcome.status === 403 &&
      errorCodeOf(outcome.body) === 'hub_screen_required'
    )
      this.#hubScreen = false;
    if (before !== this.#hubScreen) {
      this.#log(`hub_screen:${String(this.#hubScreen)}`);
      this.#options.onChange();
    }
  }

  // 中枢の画面の端末の申請の承認・端末の管理（B03-06、ADR 0026）。中枢へ要求を送るので非同期。
  async handleAdminIpc(
    ipcChannel: string,
    raw: unknown,
    sender: DesktopIpcSender,
    ioState: DesktopIoState,
  ): Promise<ConnectionIpcOutcome> {
    const contract = this.#options.contract;
    if (
      !contract.isRequest(raw) ||
      raw.channel !== ipcChannel ||
      !ADMIN_CHANNELS.includes(raw.channel)
    )
      return this.#reject(
        echoRequestId(raw),
        echoChannel(raw, ipcChannel),
        'invalid_request',
      );
    const admission = admitDesktopRequest(raw.channel, null, ioState, sender);
    if (!admission.ok)
      return this.#reject(raw.request_id, raw.channel, admission.reason);
    const connection = this.#connection;
    if (
      connection === null ||
      this.#registration !== 'registered' ||
      connection.state.phase !== 'live'
    )
      return this.#reject(raw.request_id, raw.channel, 'not_connected');
    if (this.#hubScreen === null) await this.#probeHubScreen();
    if (this.#hubScreen !== true)
      return this.#reject(raw.request_id, raw.channel, 'hub_screen_required');
    const requestId = raw.request_id;
    switch (raw.channel) {
      case 'desktop.claims_list':
        return this.#listClaims(requestId, raw.channel);
      case 'desktop.devices_list':
        return this.#listDevices(requestId, raw.channel);
      case 'desktop.claim_decide': {
        const claimId = this.#claimRefs.get(raw.payload.ref);
        if (claimId === undefined)
          return this.#reject(requestId, raw.channel, 'entry_not_found');
        const outcome = await connection.request({
          method: 'POST',
          path: `/v1/pairing/claims/${encodeURIComponent(claimId)}/decision`,
          body: { decision: raw.payload.decision },
          screenOperation: true,
          scoped: true,
        });
        const failed = this.#adminFailure(outcome, 200);
        if (failed !== null) {
          if (failed !== 'outcome_unknown')
            this.#claimRefs.delete(raw.payload.ref);
          return this.#reject(requestId, raw.channel, failed);
        }
        this.#log(`hub_claim_decided:${raw.payload.decision}`);
        return this.#listClaims(requestId, raw.channel);
      }
      case 'desktop.device_revoke': {
        const deviceId = this.#deviceRefs.get(raw.payload.ref);
        if (deviceId === undefined)
          return this.#reject(requestId, raw.channel, 'entry_not_found');
        const outcome = await connection.request({
          method: 'POST',
          path: `/v1/devices/${encodeURIComponent(deviceId)}/revoke`,
          body: {},
          screenOperation: true,
          scoped: true,
        });
        const failed = this.#adminFailure(outcome, 200);
        if (failed !== null)
          return this.#reject(requestId, raw.channel, failed);
        this.#deviceRefs.delete(raw.payload.ref);
        this.#log('hub_device_revoked');
        return this.#listDevices(requestId, raw.channel);
      }
      case 'desktop.pairing_open': {
        // 新しい端末のペアリングを始める。コードは本人が登録する端末に入力するための表示で、この応答にだけ入れる。
        const outcome = await connection.request({
          method: 'POST',
          path: '/v1/pairing/sessions',
          body: {},
          screenOperation: true,
          scoped: true,
        });
        const failed = this.#adminFailure(outcome, 201);
        if (failed !== null || outcome.kind !== 'response')
          return this.#reject(
            requestId,
            raw.channel,
            failed ?? 'not_connected',
          );
        if (!this.#options.contract.valid('PairingSession', outcome.body))
          return this.#reject(requestId, raw.channel, 'core_rejected');
        const session = outcome.body as PairingSession;
        this.#log('hub_pairing_opened');
        return this.#respond({
          request_id: requestId,
          channel: raw.channel,
          outcome: 'ok',
          session: {
            pairing_code: session.pairing_code,
            certificate_fingerprint: session.certificate_fingerprint,
            expires_at: session.expires_at,
          },
        });
      }
      case 'desktop.home_status':
        return this.#homeStatus(requestId, raw.channel);
      case 'desktop.home_register':
        return this.#homeRegister(requestId, raw.channel, raw.payload.ref);
      default:
        return this.#reject(requestId, raw.channel, 'invalid_request');
    }
  }

  async #listClaims(
    requestId: string,
    channel: 'desktop.claims_list' | 'desktop.claim_decide',
  ): Promise<ConnectionIpcOutcome> {
    const connection = this.#connection;
    if (connection === null)
      return this.#reject(requestId, channel, 'not_connected');
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/pairing/claims',
    });
    const failed = this.#adminFailure(outcome, 200, true);
    if (failed !== null || outcome.kind !== 'response')
      return this.#reject(requestId, channel, failed ?? 'not_connected');
    if (!this.#options.contract.valid('PairingClaimList', outcome.body))
      return this.#reject(requestId, channel, 'core_rejected');
    // 同じ申請には同じ参照を使う（取り直しの間に確認を開いていても参照が古くならない）。一覧から消えたものは捨てる。
    const previousClaims = this.#claimRefs;
    this.#claimRefs = new Map();
    const claims = (outcome.body as PairingClaimList).claims.map((claim) => {
      const ref =
        refFor(previousClaims, claim.claim_id) ??
        this.#options.clock.newRequestId();
      this.#claimRefs.set(ref, claim.claim_id);
      return {
        ref,
        device_name: claim.device_name,
        platform: claim.platform,
        claimed_at: claim.claimed_at,
        expires_at: claim.expires_at,
        claim_check: claim.claim_check,
      };
    });
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'ok',
      claims,
    });
  }

  async #listDevices(
    requestId: string,
    channel: 'desktop.devices_list' | 'desktop.device_revoke',
  ): Promise<ConnectionIpcOutcome> {
    const connection = this.#connection;
    if (connection === null)
      return this.#reject(requestId, channel, 'not_connected');
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/devices',
    });
    const failed = this.#adminFailure(outcome, 200, true);
    if (failed !== null || outcome.kind !== 'response')
      return this.#reject(requestId, channel, failed ?? 'not_connected');
    if (!this.#options.contract.valid('DeviceList', outcome.body))
      return this.#reject(requestId, channel, 'core_rejected');
    const self = connection.state.deviceId;
    const previousDevices = this.#deviceRefs;
    this.#deviceRefs = new Map();
    const devices = (outcome.body as DeviceList).devices.map((device) => {
      const thisDevice = device.device_id === self;
      // この端末と失効済みの端末には参照を作らない（画面から失効できない）。
      let ref: string | null = null;
      if (!thisDevice && device.revoked_at === null) {
        ref =
          refFor(previousDevices, device.device_id) ??
          this.#options.clock.newRequestId();
        this.#deviceRefs.set(ref, device.device_id);
      }
      return {
        ref,
        device_name: device.device_name,
        platform: device.platform,
        hub_local: device.hub_local,
        this_device: thisDevice,
        registered_at: device.registered_at,
        last_seen_at: device.last_seen_at,
        revoked_at: device.revoked_at,
      };
    });
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'ok',
      devices,
    });
  }

  // 自宅の登録の状態とこのマシンのネットワークの伏せた表示（B03-08）。中枢の登録の読み取りと指紋の読み取りを
  // 同時に行う。登録できる指紋なら参照を作る（前に見せた指紋と同じなら同じ参照。確認を開いている間に読み取り
  // 直しても参照が古くならない）。
  async #homeStatus(
    requestId: string,
    channel: 'desktop.home_status',
  ): Promise<ConnectionIpcOutcome> {
    const connection = this.#connection;
    if (connection === null)
      return this.#reject(requestId, channel, 'not_connected');
    const [outcome, reading] = await Promise.all([
      connection.request({
        method: 'GET',
        path: '/v1/home-network/registration',
      }),
      this.#readHubHome(),
    ]);
    const failed = this.#adminFailure(outcome, 200, true);
    if (failed !== null || outcome.kind !== 'response')
      return this.#reject(requestId, channel, failed ?? 'not_connected');
    if (!this.#options.contract.valid('HomeRegistrationState', outcome.body))
      return this.#reject(requestId, channel, 'core_rejected');
    const registration = (outcome.body as HomeRegistrationState).registration;
    let ref: string | null = null;
    if (reading !== null && registrable(reading.fingerprint)) {
      const previous = this.#homeRef;
      ref =
        previous !== null &&
        sameFingerprint(previous.fingerprint, reading.fingerprint)
          ? previous.ref
          : this.#options.clock.newRequestId();
      this.#homeRef = { ref, fingerprint: reading.fingerprint };
    } else this.#homeRef = null;
    return this.#homeResponse(requestId, channel, registration, reading, ref);
  }

  // 画面で確かめた指紋を自宅として登録する（B03-08）。参照の指紋と、送る直前に読み取り直した指紋が同じときだけ
  // 中枢へ送る（違えば home_network_changed）。結果が分からなければ outcome_unknown で、自動では送り直さない。
  async #homeRegister(
    requestId: string,
    channel: 'desktop.home_register',
    ref: string,
  ): Promise<ConnectionIpcOutcome> {
    const connection = this.#connection;
    if (connection === null)
      return this.#reject(requestId, channel, 'not_connected');
    const pending = this.#homeRef;
    if (pending === null || pending.ref !== ref)
      return this.#reject(requestId, channel, 'entry_not_found');
    const reading = await this.#readHubHome();
    if (
      reading === null ||
      !sameFingerprint(reading.fingerprint, pending.fingerprint)
    ) {
      // 画面は読み取り直してから、もう一度確かめる（古い参照では送らない）。
      if (this.#homeRef === pending) this.#homeRef = null;
      this.#log('hub_home_changed');
      return this.#reject(requestId, channel, 'home_network_changed');
    }
    const outcome = await connection.request({
      method: 'PUT',
      path: '/v1/home-network/registration',
      body: {
        gateway_mac: pending.fingerprint.gateway_mac,
        subnet: pending.fingerprint.subnet,
        ssid: pending.fingerprint.ssid,
      },
      screenOperation: true,
      scoped: true,
    });
    const failed = this.#adminFailure(outcome, 200);
    if (failed !== null || outcome.kind !== 'response') {
      this.#log(`hub_home_register_failed:${failed ?? 'not_connected'}`);
      return this.#reject(requestId, channel, failed ?? 'not_connected');
    }
    if (!this.#options.contract.valid('HomeRegistration', outcome.body))
      return this.#reject(requestId, channel, 'core_rejected');
    this.#log('hub_home_registered');
    return this.#homeResponse(
      requestId,
      channel,
      outcome.body as HomeRegistration,
      reading,
      pending.ref,
    );
  }

  #homeResponse(
    requestId: string,
    channel: 'desktop.home_status' | 'desktop.home_register',
    registration: HomeRegistration | null,
    reading: HubHomeReading | null,
    ref: string | null,
  ): ConnectionIpcOutcome {
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'ok',
      home: {
        registration,
        observation:
          reading === null
            ? null
            : maskHomeObservation(
                reading.fingerprint,
                reading.unavailable,
                ref,
                new Date(reading.collectedAt).toISOString(),
              ),
      },
    });
  }

  // このマシンの指紋を読み取る。失敗・時間切れ・どの要素も取れないときは null（値は記録しない）。
  async #readHubHome(): Promise<HubHomeReading | null> {
    let cancel: () => void = () => undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      cancel = this.#options.clock.setTimer(
        this.#options.homeCollectTimeoutMs ?? HOME_COLLECT_TIMEOUT_MS,
        () => resolve('timeout'),
      );
    });
    let observation: HomeObservation | 'timeout' | 'failed';
    try {
      observation = await Promise.race([
        this.#options.collectHome().catch(() => 'failed' as const),
        timeout,
      ]);
    } catch {
      observation = 'failed';
    } finally {
      cancel();
    }
    if (observation === 'timeout' || observation === 'failed') {
      this.#log(`hub_home_read_${observation}`);
      return null;
    }
    const fingerprint = sanitizeFingerprint(observation, (name, value) =>
      this.#options.contract.valid(name, value),
    );
    if (
      fingerprint.gateway_mac === null &&
      fingerprint.subnet === null &&
      fingerprint.ssid === null
    ) {
      this.#log('hub_home_read_empty');
      return null;
    }
    return {
      fingerprint,
      unavailable: observation.unavailable ?? [],
      collectedAt: this.#options.clock.now(),
    };
  }

  // 中枢の画面の操作の結果の分類。null は成功。read は一覧（送れなかった・分からないは未接続として扱う）。
  #adminFailure(
    outcome: Awaited<ReturnType<ClientConnection['request']>>,
    okStatus: number,
    read = false,
  ): DesktopIpcRejectReason | null {
    if (outcome.kind === 'not_sent') return 'not_connected';
    if (outcome.kind === 'unknown')
      return read ? 'not_connected' : 'outcome_unknown';
    if (outcome.status === okStatus) return null;
    if (
      outcome.status === 403 &&
      errorCodeOf(outcome.body) === 'hub_screen_required'
    ) {
      this.#hubScreen = false;
      this.#options.onChange();
      return 'hub_screen_required';
    }
    return 'core_rejected';
  }

  #disconnect(): void {
    this.#hubScreen = null;
    this.#claimRefs.clear();
    this.#deviceRefs.clear();
    this.#homeRef = null;
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

// 前の一覧で同じ ID に渡した参照。
function refFor(refs: ReadonlyMap<string, string>, id: string): string | null {
  for (const [ref, value] of refs) if (value === id) return ref;
  return null;
}

function errorCodeOf(body: unknown): string | null {
  return typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>)['code'] === 'string'
    ? ((body as Record<string, unknown>)['code'] as string)
    : null;
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
