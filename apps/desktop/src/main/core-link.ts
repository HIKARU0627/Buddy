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
  DesktopIpcRequest,
  DeviceList,
  PairingClaimList,
  PairingSession,
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

// 中枢の画面の端末だけのチャネル（B03-06、ADR 0026）。
export const ADMIN_CHANNELS: readonly DesktopIpcChannel[] = [
  'desktop.claims_list',
  'desktop.claim_decide',
  'desktop.devices_list',
  'desktop.device_revoke',
  'desktop.pairing_open',
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
  // 中枢の画面の端末かの判定の再試行の間隔の単位（試験で短くする）。
  readonly hubScreenProbeRetryMs?: number;
  // 承認・拒否・失効の前の本人の確認。省略すると確認できないので送らない。
  readonly confirmAdmin?: AdminConfirm;
}

// 承認・拒否・失効の前の本人の確認（本人の判断 2026-10-22、ADR 0026）。main が OS の確認ダイアログで行う。
// 表示する値（端末名・OS・確認コード）は main が中枢から受け取った一覧の値で、画面からは受け取らない。
// 「やめる」を既定にし、signal で閉じられたら false を返す。Electron の層が dialog.showMessageBox で実装し、試験は注入する。
export interface AdminConfirmRequest {
  readonly action: 'approve' | 'reject' | 'revoke';
  readonly deviceName: string;
  readonly platform: string;
  // 承認・拒否の確認コード（8 桁の 16 進）。失効では null。
  readonly claimCheck: string | null;
  // 申請・登録の時刻（UTC）。
  readonly at: string;
}

export type AdminConfirm = (
  request: AdminConfirmRequest,
  signal: AbortSignal,
) => Promise<boolean>;

export interface ConnectionIpcOutcome {
  readonly response: DesktopIpcResponse;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// 最終確認時刻だけが変わったときに画面へ知らせる最短の間隔（レビューの指摘 L8）。中枢の ping（15 秒）の
// たびには知らせるが、イベントの取り直しなどで続けて変わるときは間引く。
export const CONFIRMED_ONLY_NOTIFY_INTERVAL_MS = 10_000;

// 中枢の画面の端末かの判定が決まらなかったときの再試行（2・4・6 秒後、最大 3 回。接続し直すと数え直す）。
export const HUB_SCREEN_PROBE_RETRY_MS = 2_000;
export const HUB_SCREEN_PROBE_RETRIES = 3;

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
  // 判定が決まらなかったとき（503・429・時間切れ・形の違う 200）の再試行（回数と、待っている timer）。CR-L1。
  #probeRetries = 0;
  #probeTimer: (() => void) | null = null;
  // 一覧ごとに作る参照 → 申請 ID・端末 ID。参照だけを画面へ渡す（ID を画面に持たせない）。
  #claimRefs = new Map<string, string>();
  #deviceRefs = new Map<string, string>();
  // 一覧の表示用の値（確認のダイアログに出す。参照 → 値）。
  #claimInfo = new Map<string, AdminConfirmRequest>();
  #deviceInfo = new Map<string, AdminConfirmRequest>();
  // 結果が分からなかった参照（申請・端末ごと）→ 結果が分かった後の通し番号。それより後に始めた同じ種類の一覧で
  // 照合できるまで、同じ参照では送らない。
  #held = {
    claims: new Map<string, number>(),
    devices: new Map<string, number>(),
  };
  // 表示の権限の世代: ロック・切断・接続のやり直しで進める。応答を返すときに照合し、またいだ内容は返さない。
  #viewGeneration = 0;
  // 一覧の要求の順: 一覧ごとの通し番号と、これより前に始めた一覧を古いとみなす境目（変更の操作・新しい一覧で進む）。
  #listSeq = { claims: 0, devices: 0 };
  #listFloor = { claims: 0, devices: 0 };
  // 表示している確認（同時に 1 つまで）。世代が進むと閉じる。
  #confirmAbort: AbortController | null = null;

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
    if (lockState !== 'unlocked') this.#bumpGeneration();
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
    this.#bumpGeneration();
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
      // 接続が切れたら（待ち・再登録・版違い）・bootstrap をやり直したら（4410 など。接続範囲が変わる）、表示している
      // 確認を閉じ、またいだ応答を返さない。届いたイベントでの取り直し（snapshotting・subscribing）は同じ接続範囲の
      // 中なので世代を進めない。
      if (
        previous.phase !== state.phase &&
        (state.phase === 'waiting_retry' ||
          state.phase === 'bootstrapping' ||
          state.phase === 'reregistration_required' ||
          state.phase === 'upgrade_required' ||
          state.phase === 'idle' ||
          state.phase === 'stopped')
      )
        this.#bumpGeneration();
      // 接続するたびに中枢の画面の端末かを確かめる（B03-06）。
      if (state.phase === 'live' && previous.phase !== 'live') {
        this.#probeRetries = 0;
        void this.#probeHubScreen();
      }
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
  // 決まらなかったとき（送れない・結果不明・503・429・形の違う 200）は、間隔を空けて上限まで問い合わせ直す。
  // 接続が変わったら、古い接続の結果と待っている再試行は捨てる。
  async #probeHubScreen(): Promise<void> {
    const connection = this.#connection;
    if (connection === null || connection.state.phase !== 'live') return;
    if (this.#lockState !== 'unlocked') return;
    this.#cancelProbeRetry();
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/pairing/claims',
    });
    if (connection !== this.#connection) return;
    const before = this.#hubScreen;
    if (
      outcome.kind === 'response' &&
      outcome.status === 200 &&
      this.#options.contract.valid('PairingClaimList', outcome.body)
    )
      this.#hubScreen = true;
    else if (
      outcome.kind === 'response' &&
      outcome.status === 403 &&
      errorCodeOf(outcome.body) === 'hub_screen_required'
    )
      this.#hubScreen = false;
    if (this.#hubScreen !== null) this.#probeRetries = 0;
    else if (this.#probeRetries < HUB_SCREEN_PROBE_RETRIES) {
      this.#probeRetries += 1;
      this.#log(`hub_screen_probe_retry:${String(this.#probeRetries)}`);
      this.#probeTimer = this.#options.clock.setTimer(
        (this.#options.hubScreenProbeRetryMs ?? HUB_SCREEN_PROBE_RETRY_MS) *
          this.#probeRetries,
        () => {
          this.#probeTimer = null;
          if (connection === this.#connection && this.#hubScreen === null)
            void this.#probeHubScreen();
        },
      );
    }
    if (before !== this.#hubScreen) {
      this.#log(`hub_screen:${String(this.#hubScreen)}`);
      this.#options.onChange();
    }
  }

  #cancelProbeRetry(): void {
    this.#probeTimer?.();
    this.#probeTimer = null;
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
    const generation = this.#viewGeneration;
    if (this.#hubScreen === null) await this.#probeHubScreen();
    if (this.#hubScreen !== true)
      return this.#reject(raw.request_id, raw.channel, 'hub_screen_required');
    const outcome = await this.#admin(raw, connection, generation);
    return this.#withinGeneration(generation, outcome);
  }

  // ロック・切断をまたいだ一覧・コードは返さない（またいだ変更の操作の結果も、表示の内容は渡さない）。
  #withinGeneration(
    generation: number,
    outcome: ConnectionIpcOutcome,
  ): ConnectionIpcOutcome {
    if (generation === this.#viewGeneration && this.#lockState === 'unlocked')
      return outcome;
    const response = outcome.response;
    if (response.outcome === 'rejected') return outcome;
    return this.#reject(
      response.request_id,
      response.channel,
      this.#lockState === 'unlocked' ? 'not_connected' : 'device_locked',
    );
  }

  // 世代が変わっていたら、その理由（ロック中なら device_locked、それ以外は not_connected）。変わっていなければ null。
  #staleReason(generation: number): DesktopIpcRejectReason | null {
    if (generation === this.#viewGeneration && this.#lockState === 'unlocked')
      return null;
    return this.#lockState === 'unlocked' ? 'not_connected' : 'device_locked';
  }

  // 本人の確認（OS の確認ダイアログ）。同時に 1 つまで。世代が進むと閉じて「送らない」。確認を出したときの
  // 接続範囲を返し、送る直前にもそれと一致するときだけ送る（bootstrap をやり直していれば送らない）。
  async #confirm(
    request: AdminConfirmRequest,
  ): Promise<{ readonly scope: string } | DesktopIpcRejectReason> {
    const scope = this.#connection?.state.commandScopeId ?? null;
    if (scope === null) return 'not_connected';
    const confirm = this.#options.confirmAdmin;
    if (confirm === undefined) return 'confirmation_declined';
    if (this.#confirmAbort !== null) return 'confirmation_pending';
    const generation = this.#viewGeneration;
    const controller = new AbortController();
    this.#confirmAbort = controller;
    let confirmed: boolean;
    try {
      confirmed = await confirm(request, controller.signal);
    } catch {
      confirmed = false;
    } finally {
      if (this.#confirmAbort === controller) this.#confirmAbort = null;
    }
    if (controller.signal.aborted || generation !== this.#viewGeneration)
      return this.#lockState === 'unlocked' ? 'not_connected' : 'device_locked';
    if (this.#connection?.state.commandScopeId !== scope)
      return 'not_connected';
    return confirmed ? { scope } : 'confirmation_declined';
  }

  // 結果が分からなかった参照を、同じ種類の一覧で照合できるまで保留にする。
  #hold(pane: 'claims' | 'devices', ref: string): void {
    this.#held[pane].set(ref, ++this.#listSeq[pane]);
  }

  // 一覧（通し番号 seq）を反映した: それより前に結果が分かった保留だけを解く。
  #releaseHeld(pane: 'claims' | 'devices', seq: number): void {
    for (const [ref, after] of this.#held[pane])
      if (seq > after) this.#held[pane].delete(ref);
  }

  async #admin(
    raw: DesktopIpcRequest,
    connection: ClientConnection,
    generation: number,
  ): Promise<ConnectionIpcOutcome> {
    const requestId = raw.request_id;
    switch (raw.channel) {
      case 'desktop.claims_list':
        return this.#listClaims(requestId, raw.channel, generation);
      case 'desktop.devices_list':
        return this.#listDevices(requestId, raw.channel, generation);
      case 'desktop.claim_decide': {
        const claimId = this.#claimRefs.get(raw.payload.ref);
        const info = this.#claimInfo.get(raw.payload.ref);
        if (
          claimId === undefined ||
          info === undefined ||
          this.#held.claims.has(raw.payload.ref)
        )
          return this.#reject(requestId, raw.channel, 'entry_not_found');
        const confirmed = await this.#confirm({
          ...info,
          action: raw.payload.decision,
        });
        if (typeof confirmed === 'string')
          return this.#reject(requestId, raw.channel, confirmed);
        // これより前に始めた申請の一覧は古い（決めた申請を戻さない）。
        this.#listFloor.claims = ++this.#listSeq.claims;
        const outcome = await connection.request({
          method: 'POST',
          path: `/v1/pairing/claims/${encodeURIComponent(claimId)}/decision`,
          body: { decision: raw.payload.decision },
          screenOperation: true,
          scoped: true,
          expectedScopeId: confirmed.scope,
        });
        const failed = this.#adminFailure(outcome, 200);
        // 古い世代の処理は、今の世代の参照・順序の状態を進めない（応答も返さない）。
        const stale = this.#staleReason(generation);
        if (stale !== null) return this.#reject(requestId, raw.channel, stale);
        if (failed !== null) {
          if (failed === 'outcome_unknown')
            this.#hold('claims', raw.payload.ref);
          else this.#claimRefs.delete(raw.payload.ref);
          return this.#reject(requestId, raw.channel, failed);
        }
        this.#log(`hub_claim_decided:${raw.payload.decision}`);
        this.#claimRefs.delete(raw.payload.ref);
        // POST の最中に始めた一覧も古い（取り直しが失敗しても、この境目は保つ）。
        this.#listFloor.claims = ++this.#listSeq.claims;
        return this.#afterApplied(
          requestId,
          await this.#listClaims(requestId, raw.channel, generation),
        );
      }
      case 'desktop.device_revoke': {
        const deviceId = this.#deviceRefs.get(raw.payload.ref);
        const info = this.#deviceInfo.get(raw.payload.ref);
        if (
          deviceId === undefined ||
          info === undefined ||
          this.#held.devices.has(raw.payload.ref)
        )
          return this.#reject(requestId, raw.channel, 'entry_not_found');
        const confirmed = await this.#confirm(info);
        if (typeof confirmed === 'string')
          return this.#reject(requestId, raw.channel, confirmed);
        this.#listFloor.devices = ++this.#listSeq.devices;
        const outcome = await connection.request({
          method: 'POST',
          path: `/v1/devices/${encodeURIComponent(deviceId)}/revoke`,
          body: {},
          screenOperation: true,
          scoped: true,
          expectedScopeId: confirmed.scope,
        });
        const failed = this.#adminFailure(outcome, 200);
        const stale = this.#staleReason(generation);
        if (stale !== null) return this.#reject(requestId, raw.channel, stale);
        if (failed !== null) {
          if (failed === 'outcome_unknown')
            this.#hold('devices', raw.payload.ref);
          return this.#reject(requestId, raw.channel, failed);
        }
        this.#deviceRefs.delete(raw.payload.ref);
        this.#log('hub_device_revoked');
        this.#listFloor.devices = ++this.#listSeq.devices;
        return this.#afterApplied(
          requestId,
          await this.#listDevices(requestId, raw.channel, generation),
        );
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
            hub_endpoint: {
              host: session.hub_endpoint.host,
              port: session.hub_endpoint.port,
            },
          },
        });
      }
      default:
        return this.#reject(requestId, raw.channel, 'invalid_request');
    }
  }

  async #listClaims(
    requestId: string,
    channel: 'desktop.claims_list' | 'desktop.claim_decide',
    generation: number,
  ): Promise<ConnectionIpcOutcome> {
    const connection = this.#connection;
    if (connection === null)
      return this.#reject(requestId, channel, 'not_connected');
    const seq = ++this.#listSeq.claims;
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/pairing/claims',
    });
    const failed = this.#adminFailure(outcome, 200, true);
    if (failed !== null || outcome.kind !== 'response')
      return this.#reject(requestId, channel, failed ?? 'not_connected');
    if (!this.#options.contract.valid('PairingClaimList', outcome.body))
      return this.#reject(requestId, channel, 'core_rejected');
    // 古い世代の一覧は、今の世代の参照・順序の状態を進めない。
    const staleClaims = this.#staleReason(generation);
    if (staleClaims !== null)
      return this.#reject(requestId, channel, staleClaims);
    // 後から始めた一覧・変更の操作に追い越された古い一覧では、参照も表示も戻さない。
    if (seq < this.#listFloor.claims)
      return this.#reject(requestId, channel, 'list_superseded');
    this.#listFloor.claims = seq;
    // 同じ申請には同じ参照を使う（取り直しの間に確認を開いていても参照が古くならない）。一覧から消えたものは捨てる。
    const previousClaims = this.#claimRefs;
    this.#claimRefs = new Map();
    this.#claimInfo = new Map();
    this.#releaseHeld('claims', seq);
    const claims = (outcome.body as PairingClaimList).claims.map((claim) => {
      const ref =
        refFor(previousClaims, claim.claim_id) ??
        this.#options.clock.newRequestId();
      this.#claimRefs.set(ref, claim.claim_id);
      this.#claimInfo.set(ref, {
        action: 'approve',
        deviceName: claim.device_name,
        platform: claim.platform,
        claimCheck: claim.claim_check,
        at: claim.claimed_at,
      });
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
    generation: number,
  ): Promise<ConnectionIpcOutcome> {
    const connection = this.#connection;
    if (connection === null)
      return this.#reject(requestId, channel, 'not_connected');
    const seq = ++this.#listSeq.devices;
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/devices',
    });
    const failed = this.#adminFailure(outcome, 200, true);
    if (failed !== null || outcome.kind !== 'response')
      return this.#reject(requestId, channel, failed ?? 'not_connected');
    if (!this.#options.contract.valid('DeviceList', outcome.body))
      return this.#reject(requestId, channel, 'core_rejected');
    const staleDevices = this.#staleReason(generation);
    if (staleDevices !== null)
      return this.#reject(requestId, channel, staleDevices);
    if (seq < this.#listFloor.devices)
      return this.#reject(requestId, channel, 'list_superseded');
    this.#listFloor.devices = seq;
    const self = connection.state.deviceId;
    const previousDevices = this.#deviceRefs;
    this.#deviceRefs = new Map();
    this.#deviceInfo = new Map();
    this.#releaseHeld('devices', seq);
    const devices = (outcome.body as DeviceList).devices.map((device) => {
      const thisDevice = device.device_id === self;
      // この端末と失効済みの端末には参照を作らない（画面から失効できない）。
      let ref: string | null = null;
      if (!thisDevice && device.revoked_at === null) {
        ref =
          refFor(previousDevices, device.device_id) ??
          this.#options.clock.newRequestId();
        this.#deviceRefs.set(ref, device.device_id);
        this.#deviceInfo.set(ref, {
          action: 'revoke',
          deviceName: device.device_name,
          platform: device.platform,
          claimCheck: null,
          at: device.registered_at,
        });
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

  // 承認・拒否・失効は適用できたが、その後の一覧の取り直しだけが失敗したときは、拒否ではなく
  // 「適用した・一覧は古い」（list_refreshed: false）として返す（CR-L2）。
  #afterApplied(
    requestId: string,
    outcome: ConnectionIpcOutcome,
  ): ConnectionIpcOutcome {
    const response = outcome.response;
    if (
      response.outcome !== 'rejected' ||
      (response.channel !== 'desktop.claim_decide' &&
        response.channel !== 'desktop.device_revoke')
    )
      return outcome;
    this.#log('hub_list_refresh_failed_after_apply');
    return this.#respond({
      request_id: requestId,
      channel: response.channel,
      outcome: 'ok',
      list_refreshed: false,
    });
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

  // 表示の権限の世代を進め、表示している確認を閉じる。
  #bumpGeneration(): void {
    this.#viewGeneration += 1;
    this.#confirmAbort?.abort();
    this.#confirmAbort = null;
  }

  #disconnect(): void {
    this.#bumpGeneration();
    this.#held.claims.clear();
    this.#held.devices.clear();
    this.#hubScreen = null;
    this.#cancelProbeRetry();
    this.#probeRetries = 0;
    this.#claimRefs.clear();
    this.#deviceRefs.clear();
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
