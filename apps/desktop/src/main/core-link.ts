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
  DesktopCanvasView,
  DesktopIpcNotification,
  DesktopIpcRequest,
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
  desktopInputPermitted,
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
  macTailOf,
  maskHomeObservation,
  ssidHintOf,
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
import { CanvasBridge } from './canvas-bridge.js';
import { OperationBridge } from './operation-bridge.js';
import type {
  BridgeOutcome,
  OperationConfirmRequest,
} from './operation-bridge.js';
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

// 発言・承認・取消・照合のチャネル（B04-05、ADR 0031）。登録済みでロック解除済みの端末なら、中枢の画面の端末でなくても使える。
export const OPERATION_CHANNELS: readonly DesktopIpcChannel[] = [
  'desktop.turn_submit',
  'desktop.operation_preview',
  'desktop.operation_approve',
  'desktop.operation_cancel',
  'desktop.operation_reconcile',
  'desktop.operation_retry',
  'desktop.operation_check',
];

// キャンバスのユーザーの操作のチャネル（UI-06、ADR 0032）。キャンバスの窓だけが使い、キャンバスが前に出ている間だけ受け付ける。
// 承認・停止のチャネルとは別。
export const CANVAS_CHANNELS: readonly DesktopIpcChannel[] = [
  'desktop.canvas_user_op',
  // 物の中身（本文）を求める（UI-07）。読み取りだけ。後ろにある間も描いている物の中身を取る（メールの本文を開くときだけ前面）。
  'desktop.canvas_content',
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
  // ウィンドウが表示中かつ前面か（Electron の層が注入する）。自宅の登録の送る直前に確かめ直す（受付から送るまでに
  // 読み取りの時間が入るため）。省略すると受付の判定だけを使う（試験）。
  readonly windowFocused?: () => boolean;
  // 端末の今の入出力・ロックの状態（Electron の層が注入する）。承認・再試行を送る直前に、確認を出したときと同じ
  // 停止していない状態・io_epoch かを確かめる（確認の最中の停止）。省略すると受付の判定だけを使う（試験）。
  readonly ioState?: () => DesktopIoState;
  // 中枢の画面の端末かの判定の再試行の間隔の単位（試験で短くする）。
  readonly hubScreenProbeRetryMs?: number;
  // 承認・拒否・失効の前の本人の確認。省略すると確認できないので送らない。
  readonly confirmAdmin?: AdminConfirm;
  // キャンバスのモード（開発用のフラグ。UI-03、ADR 0032）。true のとき、入力バーの発言を流れ（POST /v1/stream/turns）へ
  // 送り、中枢のキャンバスの記述を取って onCanvas でキャンバスの窓へ渡す。false（既定）は従来どおり会話へ送る。
  readonly canvasMode?: boolean;
  // キャンバスが前に出ているか（UI-06。Electron の層が CanvasPresence から注入する）。省略は前に出ていない
  // （ユーザーの操作を受け付けない）。
  readonly canvasFront?: () => boolean;
  // キャンバスの記述の通知（検査済み。キャンバスの窓だけへ送るのは Electron の層）。
  readonly onCanvas?: (
    notification: Extract<
      DesktopIpcNotification,
      { channel: 'desktop.canvas_changed' }
    >,
  ) => void;
}

// 承認・拒否・失効の前の本人の確認（本人の判断 2026-10-22、ADR 0026）。main が OS の確認ダイアログで行う。
// 表示する値（端末名・OS・確認コード）は main が中枢から受け取った一覧の値で、画面からは受け取らない。
// 「やめる」を既定にし、signal で閉じられたら false を返す。Electron の層が dialog.showMessageBox で実装し、試験は注入する。
export type AdminConfirmRequest =
  DeviceConfirmRequest | HomeConfirmRequest | OperationConfirmRequest;

export interface DeviceConfirmRequest {
  readonly action: 'approve' | 'reject' | 'revoke';
  readonly deviceName: string;
  readonly platform: string;
  // 承認・拒否の確認コード（8 桁の 16 進）。失効では null。
  readonly claimCheck: string | null;
  // 申請・登録の時刻（UTC）。
  readonly at: string;
}

// 自宅の登録・登録し直しの確認（B03-08）。値は main が読み取った指紋の伏せた表示だけで、生の値を入れない。
export interface HomeConfirmRequest {
  readonly action: 'register_home';
  // 登録し直し（今の登録を置き換える）か。
  readonly replacing: boolean;
  // ゲートウェイの MAC の最後の 2 組・サブネット。
  readonly macTail: string;
  readonly subnet: string;
  // Wi-Fi 名（SSID）も確かめるか。確かめるときだけ伏せた表示（先頭の 1 文字と文字数）を出す。
  readonly includeSsid: boolean;
  readonly ssidHint: {
    readonly first: string | null;
    readonly length: number;
  } | null;
  // 登録し直すと Wi-Fi 名の確認が付く・外れるか（変わらなければ null）。
  readonly ssidChange: 'added' | 'removed' | null;
}

// 確認の結果。true は「承認する」等を選んだ、false は「やめる」を選んだ。'not_shown' は確認を出せなかった
// （確認の親の窓・パネルが出ていない。UI-04）で、本人の画面操作からやり直す（screen_operation_required）。
export type AdminConfirm = (
  request: AdminConfirmRequest,
  signal: AbortSignal,
) => Promise<boolean | 'not_shown'>;

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
  #claimInfo = new Map<string, DeviceConfirmRequest>();
  #deviceInfo = new Map<string, DeviceConfirmRequest>();
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
  // 自宅の登録の参照 → 画面に伏せて見せた指紋（B03-08）。最後に見せた 1 つだけを持つ。
  #homeRef: {
    readonly ref: string;
    readonly fingerprint: HomeFingerprint;
  } | null = null;
  // 進行中のこのマシンの指紋の収集（コマンドの連鎖）。読み取りを時間切れで見限っても、収集が終わる（settle する）
  // まで残し、その間の要求は同じ収集を待つ（コマンドの連鎖を重ねない。コマンドそのものは runner の時間切れで止まる）。
  // 収集を始めたときの表示の権限の世代を持ち、世代が違う（ロック・切断をまたいだ）収集には相乗りしない（終わるのを
  // 待って結果を捨て、集め直す。PR #79 の Codex の最終確認）。
  #homeCollect: {
    readonly generation: number;
    readonly promise: Promise<HomeObservation | 'failed'>;
  } | null = null;
  // 自宅の要求の順（一覧と同じ形）: 読み取りごとの通し番号と、これより前に始めた読み取りを古いとみなす境目
  // （登録・新しい読み取りで進む）。結果が分からなかった登録の保留（結果が分かった後の通し番号。それより後に
  // 始めた読み取りで解く。それまで登録させない）。
  #homeSeq = 0;
  #homeFloor = 0;
  #homeHeld: number | null = null;
  // 最後に画面へ返した読み取り（通し番号・指紋・参照）。登録の最中に新しい読み取りを返していたら、登録の応答も
  // その読み取りを返す（画面は通し番号だけで新旧を比べ、表示をまるごと置き換える）。
  #homeShown: {
    readonly seq: number;
    readonly reading: HubHomeReading | null;
    readonly ref: string | null;
  } | null = null;
  // 最後に読んだ中枢の登録（登録し直しの確認に、置き換えと Wi-Fi 名の確認の変化を出すため）。
  #homeRegistration: HomeRegistration | null = null;

  // 発言・承認・取消・照合（参照だけを画面へ渡す。B04-05）。
  readonly #operations: OperationBridge;
  // キャンバスの記述と流れへの発言（キャンバスのモードだけ。UI-03）。
  readonly #canvas: CanvasBridge;

  constructor(options: DesktopCoreLinkOptions) {
    this.#options = options;
    this.#operations = new OperationBridge({
      contract: options.contract,
      connection: () => this.#connection,
      newRef: () => options.clock.newRequestId(),
      confirm: (request) => this.#confirm(request),
      io: () => {
        const state = options.ioState?.() ?? null;
        return state === null
          ? { permitted: true, epoch: '' }
          : { permitted: desktopInputPermitted(state), epoch: state.ioEpoch };
      },
      changed: () => options.onChange(),
      log: (code) => this.#log(code),
    });
    this.#canvas = new CanvasBridge({
      contract: options.contract,
      connection: () => this.#connection,
      newRef: () => options.clock.newRequestId(),
      unlocked: () => this.#lockState === 'unlocked',
      io: () => {
        const state = options.ioState?.() ?? null;
        return state === null
          ? { permitted: true, epoch: '' }
          : { permitted: desktopInputPermitted(state), epoch: state.ioEpoch };
      },
      publish: (canvas) => this.#publishCanvas(canvas),
      turnResult: (turn) => this.#operations.streamTurnResult(turn),
      log: (code) => this.#log(code),
    });
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
    if (lockState === 'unlocked') {
      void this.#probeHubScreen();
      // ロック中に捨てた記述を、解除したら中枢から取り直す（ロック中に届いた版の知らせは取っていない）。
      if (this.#options.canvasMode === true) void this.#canvas.refresh();
    }
    // ロックした・不明になったら、自宅の登録の参照を捨てる（解除の後に読み取り直して確かめ直す。B03-08）。
    else this.#homeRef = null;
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
          ? this.#operations.entries(state.operations)
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
        // 接続するたびに、中枢のキャンバスの今の記述を取る（捨てた記述の復元。UI-03）。
        if (this.#options.canvasMode === true) void this.#canvas.refresh();
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
    // 中枢のキャンバスの版の知らせ（本文なし）。取るのは canvas の窓のためだけ（キャンバスのモード）。
    if (this.#options.canvasMode === true)
      connection.onCanvas((revision) => this.#canvas.onRevision(revision));
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

  // 発言・承認表示の準備・承認・取消・照合（B04-05、ADR 0031）。中枢へ要求を送るので非同期。受付の規則は
  // ロック解除済み・前面・画面操作。承認は main の OS の確認ダイアログで 1 回だけ（本人の判断 D2）。
  async handleOperationIpc(
    ipcChannel: string,
    raw: unknown,
    sender: DesktopIpcSender,
    ioState: DesktopIoState,
  ): Promise<ConnectionIpcOutcome> {
    const contract = this.#options.contract;
    if (
      !contract.isRequest(raw) ||
      raw.channel !== ipcChannel ||
      !OPERATION_CHANNELS.includes(raw.channel)
    )
      return this.#reject(
        echoRequestId(raw),
        echoChannel(raw, ipcChannel),
        'invalid_request',
      );
    const admission = admitDesktopRequest(raw.channel, null, ioState, sender);
    if (!admission.ok)
      return this.#reject(raw.request_id, raw.channel, admission.reason);
    // 入出力が止まっている（この端末の停止・来客・全体停止）間は、発言も承認も受け付けない（01 いつも見える状態）。
    // 内容の確認・取消・照合は止まっていても使える（実行を増やさない）。
    if (
      (raw.channel === 'desktop.turn_submit' ||
        raw.channel === 'desktop.operation_approve' ||
        raw.channel === 'desktop.operation_retry') &&
      !desktopInputPermitted(ioState)
    )
      return this.#reject(raw.request_id, raw.channel, 'input_stopped');
    const connection = this.#connection;
    if (
      connection === null ||
      this.#registration !== 'registered' ||
      connection.state.phase !== 'live'
    )
      return this.#reject(raw.request_id, raw.channel, 'not_connected');
    const generation = this.#viewGeneration;
    const requestId = raw.request_id;
    let outcome: ConnectionIpcOutcome;
    switch (raw.channel) {
      case 'desktop.turn_submit': {
        // キャンバスのモードは流れへ（会話を作らない）。それ以外は従来の会話へ。
        const result =
          this.#options.canvasMode === true
            ? await this.#canvas.submitTurn(raw.payload.text)
            : await this.#operations.submitTurn(raw.payload.text);
        outcome = this.#operationOutcome(
          requestId,
          raw.channel,
          result,
          (turn) => ({
            turn,
          }),
        );
        break;
      }
      case 'desktop.operation_preview': {
        const result = await this.#operations.preview(raw.payload.ref);
        outcome = this.#operationOutcome(
          requestId,
          raw.channel,
          result,
          (preview) => ({
            preview,
          }),
        );
        break;
      }
      case 'desktop.operation_approve': {
        const result = await this.#operations.approve(raw.payload.ref);
        outcome = this.#operationOutcome(
          requestId,
          raw.channel,
          result,
          (receipt) => ({
            receipt,
          }),
        );
        break;
      }
      case 'desktop.operation_check': {
        const result = await this.#operations.check(raw.payload.ref);
        outcome = this.#operationOutcome(
          requestId,
          raw.channel,
          result,
          (resolved) => ({ resolved }),
        );
        break;
      }
      case 'desktop.operation_cancel':
      case 'desktop.operation_reconcile':
      case 'desktop.operation_retry': {
        const result = await this.#operations.command(
          raw.channel === 'desktop.operation_cancel'
            ? 'cancel'
            : raw.channel === 'desktop.operation_retry'
              ? 'retry'
              : 'reconcile',
          raw.payload.ref,
        );
        outcome = this.#operationOutcome(
          requestId,
          raw.channel,
          result,
          (receipt) => ({
            receipt,
          }),
        );
        break;
      }
      default:
        return this.#reject(requestId, raw.channel, 'invalid_request');
    }
    // 世代（ロック・切断）が変わっていた場合の返し方。送った後の結果を「送っていない（not_connected）」と答えない:
    // 発言は中枢へ届いているので、内容を隠して結果不明にする（自動では送り直さない）。承認・取消・再試行・照合・確認の
    // 受付の応答は内容を含まないので、そのまま返す。承認表示の準備は内容を含むので隠す。
    if (
      (generation !== this.#viewGeneration || this.#lockState !== 'unlocked') &&
      outcome.response.outcome === 'ok'
    ) {
      if (raw.channel === 'desktop.turn_submit')
        return this.#reject(requestId, raw.channel, 'outcome_unknown');
      if (raw.channel !== 'desktop.operation_preview') return outcome;
    }
    return this.#withinGeneration(generation, outcome);
  }

  // キャンバスのユーザーの操作（UI-06、ADR 0032）。受付の規則は ロック解除済み・前面（画面操作）→ キャンバスが前に出ている
  // → 入出力が止まっていない の順。中枢へ操作を記録し、当てた後の版を返す。古い版への操作で物が変わっていれば
  // canvas_conflict（記述を取り直す）。送った後に世代（ロック・停止・切断）が変わったら結果不明にする（自動では送り直さない）。
  async handleCanvasIpc(
    ipcChannel: string,
    raw: unknown,
    sender: DesktopIpcSender,
    ioState: DesktopIoState,
  ): Promise<ConnectionIpcOutcome> {
    const contract = this.#options.contract;
    if (
      !contract.isRequest(raw) ||
      raw.channel !== ipcChannel ||
      (raw.channel !== 'desktop.canvas_user_op' &&
        raw.channel !== 'desktop.canvas_content')
    )
      return this.#reject(
        echoRequestId(raw),
        echoChannel(raw, ipcChannel),
        'invalid_request',
      );
    const admission = admitDesktopRequest(raw.channel, null, ioState, sender);
    if (!admission.ok)
      return this.#reject(raw.request_id, raw.channel, admission.reason);
    // 動かす・閉じるなどは前に出ている間だけ。物の中身の読み取りは後ろにある間も受け付ける（描いている物の中身を取る）が、
    // メールの本文を開くのは本人の操作なので前に出ているときだけ。
    const needsFront =
      raw.channel === 'desktop.canvas_user_op' || raw.payload.open_ref !== null;
    if (needsFront && this.#options.canvasFront?.() !== true)
      return this.#reject(
        raw.request_id,
        raw.channel,
        'screen_operation_required',
      );
    if (!desktopInputPermitted(ioState))
      return this.#reject(raw.request_id, raw.channel, 'input_stopped');
    if (this.#options.canvasMode !== true)
      return this.#reject(raw.request_id, raw.channel, 'invalid_request');
    const connection = this.#connection;
    if (
      connection === null ||
      this.#registration !== 'registered' ||
      connection.state.phase !== 'live'
    )
      return this.#reject(raw.request_id, raw.channel, 'not_connected');
    const generation = this.#viewGeneration;
    if (raw.channel === 'desktop.canvas_content') {
      // 物の中身（UI-07）。読み取りだけなので、世代が変わったら中身を渡さず、ロック中なら device_locked にする。
      const content = await this.#canvas.content(
        raw.payload.item_id,
        raw.payload.expected_canvas_revision,
        raw.payload.open_ref,
      );
      const stale = this.#staleReason(generation);
      if (stale !== null)
        return this.#reject(raw.request_id, raw.channel, stale);
      return this.#operationOutcome(
        raw.request_id,
        raw.channel,
        content,
        (value) => ({ ...value }),
      );
    }
    const result = await this.#canvas.userOp(
      raw.payload.expected_canvas_revision,
      raw.payload.op,
    );
    if (generation !== this.#viewGeneration || this.#lockState !== 'unlocked')
      return this.#reject(raw.request_id, raw.channel, 'outcome_unknown');
    return this.#operationOutcome(
      raw.request_id,
      raw.channel,
      result,
      (revision) => ({ canvas_revision: revision }),
    );
  }

  // 操作の結果を応答にする。結果が分からない（outcome_unknown）はそのまま返す（自動では送り直さない）。
  #operationOutcome<T>(
    requestId: string,
    channel: DesktopIpcChannel,
    result: BridgeOutcome<T>,
    body: (value: T) => Record<string, unknown>,
  ): ConnectionIpcOutcome {
    if (!result.ok) return this.#reject(requestId, channel, result.reason);
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'ok',
      ...body(result.value),
    } as DesktopIpcResponse);
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
    let confirmed: boolean | 'not_shown';
    try {
      confirmed = await confirm(request, controller.signal);
    } catch {
      confirmed = false;
    } finally {
      if (this.#confirmAbort === controller) this.#confirmAbort = null;
    }
    if (generation !== this.#viewGeneration)
      return this.#lockState === 'unlocked' ? 'not_connected' : 'device_locked';
    // ウィンドウが隠れた・最小化された（前面でなくなった）ので閉じた。画面操作からやり直す。
    if (controller.signal.aborted) return 'screen_operation_required';
    // 確認を出せなかった（親の窓・パネルがない）。「やめる」を選んだのではないので、画面操作からやり直す。
    if (confirmed === 'not_shown') return 'screen_operation_required';
    if (this.#connection?.state.commandScopeId !== scope)
      return 'not_connected';
    return confirmed === true ? { scope } : 'confirmation_declined';
  }

  // 結果が分からなかった参照を、同じ種類の一覧で照合できるまで保留にする。
  // 返すのは保留を付けた時点の通し番号（画面にも渡し、同じ番号で保留を解く）。
  #hold(pane: 'claims' | 'devices', ref: string): number {
    const after = ++this.#listSeq[pane];
    this.#held[pane].set(ref, after);
    return after;
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
        if (failed === 'outcome_unknown')
          return this.#unknown(
            requestId,
            raw.channel,
            this.#hold('claims', raw.payload.ref),
          );
        if (failed !== null) {
          this.#claimRefs.delete(raw.payload.ref);
          return this.#reject(requestId, raw.channel, failed);
        }
        this.#log(`hub_claim_decided:${raw.payload.decision}`);
        this.#claimRefs.delete(raw.payload.ref);
        // POST の最中に始めた一覧も古い（取り直しが失敗しても、この境目は保つ）。
        this.#listFloor.claims = ++this.#listSeq.claims;
        const claimsFloor = this.#listFloor.claims;
        return this.#afterApplied(
          requestId,
          await this.#listClaims(requestId, raw.channel, generation),
          claimsFloor,
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
        if (failed === 'outcome_unknown')
          return this.#unknown(
            requestId,
            raw.channel,
            this.#hold('devices', raw.payload.ref),
          );
        if (failed !== null)
          return this.#reject(requestId, raw.channel, failed);
        this.#deviceRefs.delete(raw.payload.ref);
        this.#log('hub_device_revoked');
        this.#listFloor.devices = ++this.#listSeq.devices;
        const devicesFloor = this.#listFloor.devices;
        return this.#afterApplied(
          requestId,
          await this.#listDevices(requestId, raw.channel, generation),
          devicesFloor,
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
        // 2xx で本文が契約に合わなければ、ペアリングは始まった（前のコードは使えなくなった）かもしれない。
        // 外部の変更なので結果不明として扱い、自動では送り直さない。
        if (!this.#options.contract.valid('PairingSession', outcome.body)) {
          this.#log('hub_pairing_open_failed:outcome_unknown');
          return this.#reject(requestId, raw.channel, 'outcome_unknown');
        }
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
      case 'desktop.home_status':
        return this.#homeStatus(requestId, raw.channel, generation);
      case 'desktop.home_register':
        return this.#homeRegister(
          requestId,
          raw.channel,
          raw.payload.ref,
          raw.payload.include_ssid,
          generation,
        );
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
      // 画面は届いた順ではなく、この番号で一覧の新旧を比べる。
      list_seq: seq,
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
      list_seq: seq,
    });
  }

  // 自宅の登録の状態とこのマシンのネットワークの伏せた表示（B03-08）。中枢の登録の読み取りと指紋の読み取りを
  // 同時に行う。登録できる指紋なら参照を作る（前に見せた指紋と同じなら同じ参照。確認を開いている間に読み取り
  // 直しても参照が古くならない）。一覧と同じく、世代と要求の順を照合する（ADR 0026）。
  async #homeStatus(
    requestId: string,
    channel: 'desktop.home_status',
    generation: number,
  ): Promise<ConnectionIpcOutcome> {
    const connection = this.#connection;
    if (connection === null)
      return this.#reject(requestId, channel, 'not_connected');
    const seq = ++this.#homeSeq;
    const [outcome, reading] = await Promise.all([
      connection.request({
        method: 'GET',
        path: '/v1/home-network/registration',
      }),
      this.#readHubHome(),
    ]);
    // 古い世代（読み取りの間にロック・切断・bootstrap のやり直し）の読み取りは、参照・通し番号・境目を変えず、
    // 伏せた表示も返さない。
    const stale = this.#staleReason(generation);
    if (stale !== null) return this.#reject(requestId, channel, stale);
    if (connection !== this.#connection)
      return this.#reject(requestId, channel, 'not_connected');
    const failed = this.#adminFailure(outcome, 200, true);
    if (failed !== null || outcome.kind !== 'response')
      return this.#reject(requestId, channel, failed ?? 'not_connected');
    if (!this.#options.contract.valid('HomeRegistrationState', outcome.body))
      return this.#reject(requestId, channel, 'core_rejected');
    // 後から始めた読み取り・登録に追い越された古い読み取りでは、参照も表示も戻さない。
    if (seq < this.#homeFloor)
      return this.#reject(requestId, channel, 'list_superseded');
    this.#homeFloor = seq;
    // 結果が分からなかった登録の保留は、結果が分かった後に始めた読み取りでだけ解く。
    if (this.#homeHeld !== null && seq > this.#homeHeld) this.#homeHeld = null;
    const registration = (outcome.body as HomeRegistrationState).registration;
    this.#homeRegistration = registration;
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
    this.#homeShown = { seq, reading, ref };
    return this.#homeResponse(
      requestId,
      channel,
      registration,
      reading,
      ref,
      seq,
    );
  }

  // 画面で確かめた指紋を自宅として登録する（B03-08）。承認・失効と同じ OS の確認で本人に確かめ、参照の指紋と、
  // 確認の後に読み取り直した指紋が同じときだけ中枢へ送る（違う・読み取れなければ home_network_changed）。
  // 読み取りの間に切断・ロック・前面でなくなったら送らない。確認を出したときの接続範囲と違えば送らない。
  // includeSsid が false なら Wi-Fi 名（SSID）を送らずに登録する（中枢は SSID を比べない。本人の判断 2026-10-22）。
  // 結果が分からない（2xx で本文が契約に合わないときを含む）なら outcome_unknown で、自動では送り直さず、
  // 結果が分かった後に始めた読み取りまで登録させない。
  async #homeRegister(
    requestId: string,
    channel: 'desktop.home_register',
    ref: string,
    includeSsid: boolean,
    generation: number,
  ): Promise<ConnectionIpcOutcome> {
    const connection = this.#connection;
    if (connection === null)
      return this.#reject(requestId, channel, 'not_connected');
    const pending = this.#homeRef;
    if (pending === null || pending.ref !== ref || this.#homeHeld !== null)
      return this.#reject(requestId, channel, 'entry_not_found');
    // 本人の確認（承認・失効と同じ OS の確認ダイアログ。「やめる」が既定。ロック・切断・bootstrap のやり直し・
    // ウィンドウが隠れたときに閉じる。本人の判断 2026-10-22）。出すのは伏せた値だけ。
    const confirmed = await this.#confirm(
      homeConfirmRequest(
        pending.fingerprint,
        includeSsid,
        this.#homeRegistration,
      ),
    );
    if (typeof confirmed === 'string')
      return this.#reject(requestId, channel, confirmed);
    // これより前に始めた読み取りは古い（登録の前の表示・参照を戻さない）。
    const started = ++this.#homeSeq;
    this.#homeFloor = started;
    // 確認の後に始めた読み取りの値と比べる（進行中の読み取りに相乗りしない）。
    const reading = await this.#readHubHome(true);
    const staleRead = this.#staleReason(generation);
    if (staleRead !== null) return this.#reject(requestId, channel, staleRead);
    if (connection !== this.#connection)
      return this.#reject(requestId, channel, 'not_connected');
    // 前面でなくなったら送らない。参照は残す（前面に戻して、もう一度押せる）。
    if (this.#options.windowFocused?.() === false)
      return this.#reject(requestId, channel, 'screen_operation_required');
    if (
      reading === null ||
      !sameFingerprint(reading.fingerprint, pending.fingerprint)
    ) {
      // 画面は読み取り直してから、もう一度確かめる（古い参照では送らない）。
      if (this.#homeRef === pending) this.#homeRef = null;
      this.#log(reading === null ? 'hub_home_unreadable' : 'hub_home_changed');
      return this.#reject(requestId, channel, 'home_network_changed');
    }
    const outcome = await connection.request({
      method: 'PUT',
      path: '/v1/home-network/registration',
      body: {
        gateway_mac: pending.fingerprint.gateway_mac,
        subnet: pending.fingerprint.subnet,
        ssid: includeSsid ? pending.fingerprint.ssid : null,
      },
      screenOperation: true,
      scoped: true,
      expectedScopeId: confirmed.scope,
    });
    const failed = this.#adminFailure(outcome, 200);
    // 古い世代の処理は、今の世代の参照・通し番号・境目・保留を変えない（応答も返さない）。
    const stale = this.#staleReason(generation);
    if (stale !== null) return this.#reject(requestId, channel, stale);
    if (failed !== null || outcome.kind !== 'response') {
      this.#log(`hub_home_register_failed:${failed ?? 'not_connected'}`);
      if (failed === 'outcome_unknown') {
        this.#homeHeld = ++this.#homeSeq;
        return this.#unknown(requestId, channel, this.#homeHeld);
      }
      return this.#reject(requestId, channel, failed ?? 'not_connected');
    }
    // 2xx で本文が契約に合わなければ、登録は反映されたかもしれない（外部の変更）。結果不明として扱う。
    if (!this.#options.contract.valid('HomeRegistration', outcome.body)) {
      this.#log('hub_home_register_failed:outcome_unknown');
      this.#homeHeld = ++this.#homeSeq;
      return this.#unknown(requestId, channel, this.#homeHeld);
    }
    this.#log(
      `hub_home_registered:${includeSsid && pending.fingerprint.ssid !== null ? 'with_ssid' : 'without_ssid'}`,
    );
    // 登録の最中に始めた読み取りも古い（登録の前の登録の状態を戻さない）。
    const floor = ++this.#homeSeq;
    this.#homeFloor = floor;
    this.#homeRegistration = outcome.body as HomeRegistration;
    // 登録の最中に、登録の前の読み取りより新しい読み取りを画面へ返していたら、その表示と参照を返す（画面は
    // 通し番号で比べて表示をまるごと置き換えるので、新しい読み取りを古い読み取りで戻さない）。
    const shown = this.#homeShown;
    const newer = shown !== null && shown.seq > started ? shown : null;
    const shownReading = newer === null ? reading : newer.reading;
    const shownRef = newer === null ? pending.ref : newer.ref;
    this.#homeShown = { seq: floor, reading: shownReading, ref: shownRef };
    return this.#homeResponse(
      requestId,
      channel,
      outcome.body as HomeRegistration,
      shownReading,
      shownRef,
      floor,
    );
  }

  #homeResponse(
    requestId: string,
    channel: 'desktop.home_status' | 'desktop.home_register',
    registration: HomeRegistration | null,
    reading: HubHomeReading | null,
    ref: string | null,
    seq: number,
  ): ConnectionIpcOutcome {
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'ok',
      list_seq: seq,
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

  // 指紋の収集を始める（進行中の収集があれば、それを返す）。
  #startHomeCollect(): Promise<HomeObservation | 'failed'> {
    const running = this.#homeCollect;
    // 呼ぶ側（#readHubHome）は、世代の違う収集が終わるのを待ってから呼ぶ。
    if (running !== null) return running.promise;
    const generation = this.#viewGeneration;
    let started: Promise<HomeObservation | 'failed'>;
    try {
      started = this.#options.collectHome().catch(() => 'failed' as const);
    } catch {
      started = Promise.resolve('failed' as const);
    }
    const tracked: Promise<HomeObservation | 'failed'> = started.finally(() => {
      if (this.#homeCollect?.promise === tracked) this.#homeCollect = null;
    });
    this.#homeCollect = { generation, promise: tracked };
    return tracked;
  }

  // このマシンの指紋を読み取る。同時の要求は進行中の収集を待つ。HOME_COLLECT_TIMEOUT_MS で見限る（コマンドは
  // 止めない）。fresh なら、進行中の収集が終わるのを待ってから新しく 1 回読む（登録の直前の読み取り直し）。
  // 失敗・時間切れ・どの要素も取れないときは null（値は記録しない）。
  async #readHubHome(fresh = false): Promise<HubHomeReading | null> {
    let cancel: () => void = () => undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      cancel = this.#options.clock.setTimer(
        this.#options.homeCollectTimeoutMs ?? HOME_COLLECT_TIMEOUT_MS,
        () => resolve('timeout'),
      );
    });
    let observation: HomeObservation | 'timeout' | 'failed' | null = null;
    try {
      // 新しく読む（fresh）ときは進行中の収集に相乗りせず、終わるのを待ってから集め直す。世代の違う（ロック・切断の
      // 前に始めた）収集も、終わるのを待って結果を捨てる（収集は重ねて起動しない）。
      let mustWait = fresh;
      for (;;) {
        const running = this.#homeCollect;
        if (
          running === null ||
          (!mustWait && running.generation === this.#viewGeneration)
        )
          break;
        const waited = await Promise.race([
          running.promise.then(() => 'settled' as const),
          timeout,
        ]);
        if (waited === 'timeout') {
          observation = 'timeout';
          break;
        }
        mustWait = false;
      }
      observation ??= await Promise.race([this.#startHomeCollect(), timeout]);
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

  // 承認・拒否・失効は適用できたが、その後の一覧の取り直しだけが失敗したときは、拒否ではなく
  // 「適用した・一覧は古い」（list_refreshed: false）として返す（CR-L2）。
  // floor は変更の結果が分かった時点の境目（画面もこれより前の番号の一覧を反映しない）。
  #afterApplied(
    requestId: string,
    outcome: ConnectionIpcOutcome,
    floor: number,
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
      list_seq: floor,
    });
  }

  // 結果が分からなかった: 保留を付けた時点の通し番号を添える（画面はそれより後の同じ種類の一覧で保留を解く）。
  #unknown(
    requestId: string,
    channel:
      | 'desktop.claim_decide'
      | 'desktop.device_revoke'
      | 'desktop.home_register',
    after: number,
  ): ConnectionIpcOutcome {
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'rejected',
      reason: 'outcome_unknown',
      list_seq: after,
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

  // 今キャンバスの窓へ渡している記述（読み込み直した窓へ送る。キャンバスのモード以外は null）。
  canvasView(): DesktopCanvasView | null {
    return this.#options.canvasMode === true ? this.#canvas.view : null;
  }

  // 入出力の状態（停止・io_epoch）が変わった（Electron の層が呼ぶ）。停止・世代の変化ではキャンバスの記述を捨て、再開
  // したら取り直す（キャンバスのモードだけ）。
  ioStateChanged(): void {
    if (this.#options.canvasMode === true) this.#canvas.ioChanged();
  }

  // キャンバスの窓が通知を受け取る準備を終えた。今の記述を送り直す（なければ取り直す）。
  canvasSubscribed(): void {
    if (this.#options.canvasMode === true) this.#canvas.resend();
  }

  // 試験用: 進行中のキャンバスの取得がすべて終わるまで待つ。
  canvasIdle(): Promise<void> {
    return this.#canvas.idle();
  }

  // キャンバスの記述をキャンバスの窓へ通知する。送る前に契約で確かめる（形式に合わなければ送らず捨てる）。
  #publishCanvas(canvas: DesktopCanvasView | null): void {
    if (this.#options.canvasMode !== true) return;
    const notification = { channel: 'desktop.canvas_changed' as const, canvas };
    if (this.#options.contract.notificationErrors(notification).length > 0) {
      this.#log('canvas_notification_invalid');
      return;
    }
    this.#options.onCanvas?.(notification);
  }

  // 表示している確認を閉じて「送らない」にする（ウィンドウが隠れた・最小化されたとき。Electron の層が呼ぶ）。
  // 表示の権限の世代は進めない（参照・一覧は残し、前面に戻して押し直せる）。
  closeConfirm(): void {
    this.#confirmAbort?.abort();
    this.#confirmAbort = null;
  }

  // 表示の権限の世代を進め、表示している確認を閉じる。
  #bumpGeneration(): void {
    this.#viewGeneration += 1;
    this.#operations.reset();
    this.#canvas.reset();
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
    this.#homeRef = null;
    this.#homeHeld = null;
    this.#homeShown = null;
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

// 自宅の登録の確認に出す伏せた値（B03-08）。MAC は最後の 2 組、SSID は先頭の 1 文字と文字数だけ。
function homeConfirmRequest(
  fingerprint: HomeFingerprint,
  includeSsid: boolean,
  registration: HomeRegistration | null,
): HomeConfirmRequest {
  const sendsSsid = includeSsid && fingerprint.ssid !== null;
  return {
    action: 'register_home',
    replacing: registration !== null,
    macTail: macTailOf(fingerprint.gateway_mac ?? ''),
    subnet: fingerprint.subnet ?? '',
    includeSsid: sendsSsid,
    ssidHint:
      sendsSsid && fingerprint.ssid !== null
        ? ssidHintOf(fingerprint.ssid)
        : null,
    ssidChange:
      registration === null || registration.ssid_registered === sendsSsid
        ? null
        : sendsSsid
          ? 'added'
          : 'removed',
  };
}
