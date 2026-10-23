// UI レンダラーの preload（設計 10 §1、ADR 0014・0015）。sandbox の中で動くため CommonJS で出力する。
// contextBridge で用途別の限定 API だけを公開する。チャネルは IPC 契約（DesktopIpcChannel・通知）のものだけで、
// 汎用の IPC・HTTP・任意コマンド・端末トークンを渡さない。中枢との接続・ペアリングも用途別のチャネルだけ（ADR 0025）。要求の形式・送信元・規則は main が検査する。
import { contextBridge, ipcRenderer } from 'electron';

// packages/domain の DESKTOP_IPC_CHANNELS と同じ一覧（sandbox の preload は electron 以外を読み込めない）。
// 一致は main の試験（preload-channels.test）で確かめる。
const REQUEST_CHANNELS: readonly string[] = [
  'desktop.get_state',
  'desktop.io_stop',
  'desktop.io_resume',
  'desktop.window_hide',
  'desktop.client_quit',
  'desktop.get_connection',
  'desktop.pairing_begin',
  'desktop.pairing_confirm',
  'desktop.pairing_submit',
  'desktop.pairing_cancel',
  'desktop.claims_list',
  'desktop.claim_decide',
  'desktop.devices_list',
  'desktop.device_revoke',
  'desktop.pairing_open',
  'desktop.home_status',
  'desktop.home_register',
  'desktop.turn_submit',
  'desktop.operation_preview',
  'desktop.operation_approve',
  'desktop.operation_cancel',
  'desktop.operation_reconcile',
  'desktop.operation_retry',
  'desktop.operation_check',
  'desktop.canvas_summon',
  'desktop.status_panel',
  'desktop.canvas_user_op',
];
const NOTIFICATION_CHANNELS: readonly string[] = [
  'desktop.state_changed',
  'desktop.power_event',
  'desktop.connection_changed',
  'desktop.canvas_changed',
];

// 窓の役割（UI-02、ADR 0032）。main が窓を作るときに --buddy-window-role=<役割> を渡す。引数がなければ従来の窓。
// 役割の正本は main の対応表で、main が送信元の窓の役割で受付を絞る。ここでの絞り込みは多重の防御と、画面の切り替えのため。
// packages/domain の DESKTOP_ROLE_CHANNELS・DESKTOP_ROLE_NOTIFICATIONS と同じ表（一致は preload.test で確かめる）。
const ROLE_ARG = '--buddy-window-role=';
const ROLE_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  // 従来の窓はキャンバスを前に出すチャネル・状態の層のパネルのチャネル・キャンバスのユーザーの操作のチャネルを使わない
  // （従来の窓の組み立てにはキャンバスも状態の層もない）。
  legacy: REQUEST_CHANNELS.filter(
    (channel) =>
      channel !== 'desktop.canvas_summon' &&
      channel !== 'desktop.status_panel' &&
      channel !== 'desktop.canvas_user_op',
  ),
  // キャンバスは状態の取得と、物のユーザーの操作だけ（UI-06。承認・停止を使えない）。
  canvas: ['desktop.get_state', 'desktop.canvas_user_op'],
  status: REQUEST_CHANNELS.filter(
    (channel) =>
      channel !== 'desktop.turn_submit' && channel !== 'desktop.canvas_user_op',
  ),
  input: ['desktop.get_state', 'desktop.turn_submit', 'desktop.canvas_summon'],
};
const ROLE_NOTIFICATIONS: Readonly<Record<string, readonly string[]>> = {
  // 従来の窓・状態の層・入力バーはキャンバスの記述を受けない（キャンバスの窓だけ。ADR 0032）。
  legacy: NOTIFICATION_CHANNELS.filter(
    (channel) => channel !== 'desktop.canvas_changed',
  ),
  canvas: ['desktop.state_changed', 'desktop.canvas_changed'],
  status: NOTIFICATION_CHANNELS.filter(
    (channel) => channel !== 'desktop.canvas_changed',
  ),
  input: ['desktop.state_changed'],
};

// sandbox の preload の process は一部だけ（argv を読める）。
declare const process: { readonly argv?: readonly string[] } | undefined;

function windowRole(): string | null {
  const argv = typeof process === 'undefined' ? [] : (process.argv ?? []);
  const given = argv
    .filter((arg) => arg.startsWith(ROLE_ARG))
    .map((arg) => arg.slice(ROLE_ARG.length));
  if (given.length === 0) return 'legacy';
  // 引数が 2 つ以上・知らない役割なら、どのチャネルも使わない。
  const [role] = given;
  return given.length === 1 &&
    role !== undefined &&
    Object.hasOwn(ROLE_CHANNELS, role)
    ? role
    : null;
}

// 全体の停止のショートカットを登録できたか（UI-04）。main が窓を作るときに --buddy-stop-shortcut=<値> を渡す。
// 停止のボタンの近くの印だけに使う（受付には使わない）。知らない値・なしは null。
const STOP_SHORTCUT_ARG = '--buddy-stop-shortcut=';
function stopShortcut(): string | null {
  const argv = typeof process === 'undefined' ? [] : (process.argv ?? []);
  const given = argv
    .filter((arg) => arg.startsWith(STOP_SHORTCUT_ARG))
    .map((arg) => arg.slice(STOP_SHORTCUT_ARG.length));
  const [value] = given;
  return given.length === 1 &&
    (value === 'registered' || value === 'unavailable')
    ? value
    : null;
}

const role = windowRole();
const roleChannels = role === null ? [] : (ROLE_CHANNELS[role] ?? []);
const roleNotifications = role === null ? [] : (ROLE_NOTIFICATIONS[role] ?? []);

function invoke(request: unknown): Promise<unknown> {
  const channel =
    typeof request === 'object' && request !== null
      ? (request as { channel?: unknown }).channel
      : undefined;
  if (
    typeof channel !== 'string' ||
    !REQUEST_CHANNELS.includes(channel) ||
    !roleChannels.includes(channel)
  )
    return Promise.reject(new Error('desktop_unknown_channel'));
  return ipcRenderer.invoke(channel, request);
}

// 通知の本体だけを渡し、Electron のイベントオブジェクト（送信元の情報）を画面へ渡さない。
function onNotification(listener: (notification: unknown) => void): () => void {
  if (typeof listener !== 'function') throw new Error('desktop_listener');
  const forward = (_event: unknown, notification: unknown) =>
    listener(notification);
  for (const channel of roleNotifications) ipcRenderer.on(channel, forward);
  return () => {
    for (const channel of roleNotifications)
      ipcRenderer.removeListener(channel, forward);
  };
}

contextBridge.exposeInMainWorld('buddyDesktop', {
  // 画面の切り替えに使う窓の役割（知らない役割なら null）。受付の判断には使わない。
  windowRole: role,
  stopShortcut: stopShortcut(),
  invoke,
  onNotification,
});
