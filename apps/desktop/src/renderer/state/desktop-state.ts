// 画面が持つ端末の状態（状態欄・電源とロックの記録・拒否の文言・止まった理由）と、操作から送る要求
// （ADR 0014・0015・0024・0025）。React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。
// 受付の規則は main が持ち、ここは表示と要求の組み立てだけ。
import type {
  DesktopCanvasView,
  DesktopConnectionView,
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopStatusBar,
  DesktopVoiceView,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { rejectMessage } from '../labels.js';

export type PowerEvent = Extract<
  DesktopIpcNotification,
  { channel: 'desktop.power_event' }
>;
export type ShownStatus = Extract<DesktopStatusBar, { visibility: 'shown' }>;
type Channel = DesktopIpcRequest['channel'];

// 画面に残す電源とロックの記録の件数（新しい順）。
export const POWER_LOG_LIMIT = 50;

// 拒否・通信失敗の文言と、それを出した操作（押したボタンのすぐ下に出すため）。
export interface ActionMessage {
  readonly channel: Channel | null;
  readonly text: string;
}

// この端末の入出力が止まった理由（画面の表示用）。
export type StopCause =
  | { readonly kind: 'button'; readonly at: string }
  | {
      readonly kind: 'power';
      readonly event: 'lock_screen' | 'suspend' | 'shutdown';
      readonly at: string;
    };

export interface DesktopViewState {
  // null は main から状態欄をまだ受け取っていないこと。
  readonly status: DesktopStatusBar | null;
  readonly powerLog: readonly PowerEvent[];
  readonly message: ActionMessage | null;
  // 中枢との接続・登録・ペアリングの状態（ADR 0025）。null は main からまだ受け取っていないこと。
  readonly connection: DesktopConnectionView | null;
  readonly stopCause: StopCause | null;
  // 登録が終わった直後（一度だけ success の知らせを出す）。
  readonly justRegistered: boolean;
  // 最後に入力した宛先（失敗の後も入力を残す）と、申請した端末名。
  readonly lastTarget: { readonly host: string; readonly port: number } | null;
  readonly submittedName: string | null;
  // キャンバスの窓が描く記述（main が検査して参照を置き換えたもの。ADR 0032）。null は受け取っていない・捨てた。
  // ロック中・不明になったら、main の通知を待たずに捨てる（解除しても main が送り直すまで戻さない）。
  readonly canvas: DesktopCanvasView | null;
  // キャンバスの窓の作業領域の外の幅（main が画面の作業領域から決めて送る。UI-06）。null は受け取っていない
  // （画面は window.screen から求めた値を使う）。
  readonly canvasInsets: CanvasWorkAreaInsets | null;
  // 音声の状態（状態の層だけが受け取る。B05-06）。null は main からまだ受け取っていないこと。
  readonly voice: DesktopVoiceView | null;
}

export type CanvasWorkAreaInsets = Extract<
  DesktopIpcNotification,
  { channel: 'desktop.canvas_work_area' }
>['insets'];

export const INITIAL_VIEW_STATE: DesktopViewState = {
  status: null,
  powerLog: [],
  message: null,
  connection: null,
  stopCause: null,
  justRegistered: false,
  lastTarget: null,
  submittedName: null,
  canvas: null,
  canvasInsets: null,
  voice: null,
};

export const IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

const IO_CHANNELS: ReadonlySet<Channel> = new Set([
  'desktop.io_stop',
  'desktop.io_resume',
]);
const STOPPING_EVENTS: ReadonlySet<string> = new Set([
  'lock_screen',
  'suspend',
  'shutdown',
]);

function stopScopeOf(status: DesktopStatusBar | null): string | null {
  return status?.visibility === 'shown' ? status.stop_scope : null;
}

function registrationOf(connection: DesktopConnectionView | null) {
  return connection?.visibility === 'shown' ? connection.registration : null;
}

// main からの通知を画面の状態へ反映する。
export function applyNotification(
  state: DesktopViewState,
  notification: DesktopIpcNotification,
): DesktopViewState {
  if (notification.channel === 'desktop.state_changed') {
    const status = notification.status;
    const resumed = stopScopeOf(status) === 'none';
    return {
      ...state,
      status,
      // ロック中・状態が不明・入出力の停止になったら、描いている記述を捨てる（解除・再開しても戻さない。main が取り直して送る）。
      canvas:
        status.visibility === 'shown' && status.stop_scope === 'none'
          ? state.canvas
          : null,
      // 再開したら止まった理由を消す。入出力の状態が変わったら、入出力の拒否の文言も消す。
      stopCause: resumed ? null : state.stopCause,
      message:
        state.message !== null &&
        state.message.channel !== null &&
        IO_CHANNELS.has(state.message.channel) &&
        stopScopeOf(status) !== stopScopeOf(state.status)
          ? null
          : state.message,
    };
  }
  if (notification.channel === 'desktop.connection_changed') {
    const before = registrationOf(state.connection);
    const after = registrationOf(notification.connection);
    return {
      ...state,
      connection: notification.connection,
      justRegistered:
        state.justRegistered ||
        (after === 'registered' && before !== null && before !== 'registered'),
    };
  }
  if (notification.channel === 'desktop.canvas_changed')
    return { ...state, canvas: notification.canvas };
  if (notification.channel === 'desktop.canvas_work_area')
    return { ...state, canvasInsets: notification.insets };
  if (notification.channel === 'desktop.voice_changed')
    return { ...state, voice: notification.voice };
  return {
    ...state,
    powerLog: [notification, ...state.powerLog].slice(0, POWER_LOG_LIMIT),
    stopCause: STOPPING_EVENTS.has(notification.event)
      ? {
          kind: 'power',
          event: notification.event as 'lock_screen' | 'suspend' | 'shutdown',
          at: notification.observed_at,
        }
      : state.stopCause,
  };
}

// 送る前の状態（操作を始めたら前の文言と登録の知らせを消し、入力を覚える）。
export function applySending(
  state: DesktopViewState,
  built: DesktopIpcRequest,
  now: () => string = () => new Date().toISOString(),
): DesktopViewState {
  const next: DesktopViewState = {
    ...state,
    message: null,
    justRegistered: false,
  };
  // 停止のボタン: 受付中から止めるときは理由を「停止ボタン」にする（main の通知が応答より先に届くため、送る時点で決める）。
  if (
    built.channel === 'desktop.io_stop' &&
    stopScopeOf(state.status) === 'none'
  )
    return { ...next, stopCause: { kind: 'button', at: now() } };
  if (built.channel === 'desktop.pairing_begin')
    return {
      ...next,
      lastTarget: { host: built.payload.host, port: built.payload.port },
    };
  if (built.channel === 'desktop.pairing_submit')
    return { ...next, submittedName: built.payload.device_name };
  return next;
}

// main の応答を画面の状態へ反映する。拒否は文言だけを出し、状態欄は変えない。
export function applyResponse(
  state: DesktopViewState,
  response: DesktopIpcResponse,
  sent: Channel | null = response.channel,
): DesktopViewState {
  if (response.outcome === 'rejected')
    return {
      ...state,
      message: { channel: sent, text: rejectMessage(sent, response.reason) },
    };
  if ('connection' in response)
    return { ...state, message: null, connection: response.connection };
  if ('voice' in response)
    return { ...state, message: null, voice: response.voice };
  if ('status' in response)
    return { ...state, message: null, status: response.status };
  return { ...state, message: null };
}

export function applyIpcFailure(
  state: DesktopViewState,
  sent: Channel | null = null,
): DesktopViewState {
  return { ...state, message: { channel: sent, text: IPC_FAILURE_MESSAGE } };
}

// 状態欄の内容を出してよいとき（ロック解除済み）だけ値を返す。ロック中・不明・未受信は null。
export function shownStatus(
  status: DesktopStatusBar | null,
): ShownStatus | null {
  return status?.visibility === 'shown' ? status : null;
}

// その操作の拒否の文言（押したボタンのすぐ下に出す）。
export function messageFor(
  state: DesktopViewState,
  channels: readonly Channel[],
): string | null {
  const message = state.message;
  if (message === null) return null;
  if (message.channel === null) return message.text;
  return channels.includes(message.channel) ? message.text : null;
}

// 画面の操作。resume は「この端末で再開する」を出せるとき（この端末の停止だけのとき）だけ関数になる。
export interface DeviceActions {
  readonly stop: () => void;
  readonly resume: (() => void) | null;
  readonly hideWindow: () => void;
  readonly quit: () => void;
}

// 操作から送る要求を組み立てる。再開は画面が表示している世代を expected_io_epoch として送り、
// 世代が古ければ main が io_epoch_mismatch で拒否する（画面は世代を進めない）。
export function deviceActions(
  status: DesktopStatusBar | null,
  send: (built: DesktopIpcRequest) => void,
): DeviceActions {
  const shown = shownStatus(status);
  return {
    stop: () => send(request('desktop.io_stop', null)),
    resume:
      shown !== null && shown.stop_scope === 'local'
        ? () =>
            send(
              request('desktop.io_resume', {
                expected_io_epoch: shown.io_epoch,
              }),
            )
        : null,
    hideWindow: () => send(request('desktop.window_hide', null)),
    quit: () => send(request('desktop.client_quit', null)),
  };
}
