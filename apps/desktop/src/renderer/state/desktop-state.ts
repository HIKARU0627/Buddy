// 画面が持つ端末の状態（状態欄・電源とロックの記録・拒否の文言）と、操作から送る要求（ADR 0014・0015・0024）。
// React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。受付の規則は main が持ち、ここは表示と要求の組み立てだけ。
import type {
  DesktopConnectionView,
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopStatusBar,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';

export type PowerEvent = Extract<
  DesktopIpcNotification,
  { channel: 'desktop.power_event' }
>;
export type ShownStatus = Extract<DesktopStatusBar, { visibility: 'shown' }>;

// 画面に残す電源とロックの記録の件数（新しい順）。
export const POWER_LOG_LIMIT = 50;

export interface DesktopViewState {
  // null は main から状態欄をまだ受け取っていないこと。
  readonly status: DesktopStatusBar | null;
  readonly powerLog: readonly PowerEvent[];
  // 拒否・通信失敗の文言。null なら出さない。
  readonly message: string | null;
  // 中枢との接続・登録・ペアリングの状態（ADR 0025）。null は main からまだ受け取っていないこと。
  readonly connection: DesktopConnectionView | null;
}

export const INITIAL_VIEW_STATE: DesktopViewState = {
  status: null,
  powerLog: [],
  message: null,
  connection: null,
};

export const IPC_FAILURE_MESSAGE = 'main と通信できませんでした。';

// main からの通知を画面の状態へ反映する。状態欄は置き換え、記録は先頭に足して上限で切る。
export function applyNotification(
  state: DesktopViewState,
  notification: DesktopIpcNotification,
): DesktopViewState {
  if (notification.channel === 'desktop.state_changed')
    return { ...state, status: notification.status };
  if (notification.channel === 'desktop.connection_changed')
    return { ...state, connection: notification.connection };
  return {
    ...state,
    powerLog: [notification, ...state.powerLog].slice(0, POWER_LOG_LIMIT),
  };
}

// main の応答を画面の状態へ反映する。拒否は文言だけを出し、状態欄は変えない。
export function applyResponse(
  state: DesktopViewState,
  response: DesktopIpcResponse,
): DesktopViewState {
  if (response.outcome === 'rejected')
    return { ...state, message: REJECT_MESSAGES[response.reason] };
  if ('connection' in response)
    return { ...state, message: null, connection: response.connection };
  return 'status' in response
    ? { ...state, message: null, status: response.status }
    : { ...state, message: null };
}

export function applyIpcFailure(state: DesktopViewState): DesktopViewState {
  return { ...state, message: IPC_FAILURE_MESSAGE };
}

// 状態欄の内容を出してよいとき（ロック解除済み）だけ値を返す。ロック中・不明・未受信は null。
export function shownStatus(
  status: DesktopStatusBar | null,
): ShownStatus | null {
  return status?.visibility === 'shown' ? status : null;
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
