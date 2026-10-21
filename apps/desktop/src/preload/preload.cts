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
];
const NOTIFICATION_CHANNELS: readonly string[] = [
  'desktop.state_changed',
  'desktop.power_event',
  'desktop.connection_changed',
];

function invoke(request: unknown): Promise<unknown> {
  const channel =
    typeof request === 'object' && request !== null
      ? (request as { channel?: unknown }).channel
      : undefined;
  if (typeof channel !== 'string' || !REQUEST_CHANNELS.includes(channel))
    return Promise.reject(new Error('desktop_unknown_channel'));
  return ipcRenderer.invoke(channel, request);
}

// 通知の本体だけを渡し、Electron のイベントオブジェクト（送信元の情報）を画面へ渡さない。
function onNotification(listener: (notification: unknown) => void): () => void {
  if (typeof listener !== 'function') throw new Error('desktop_listener');
  const forward = (_event: unknown, notification: unknown) =>
    listener(notification);
  for (const channel of NOTIFICATION_CHANNELS) ipcRenderer.on(channel, forward);
  return () => {
    for (const channel of NOTIFICATION_CHANNELS)
      ipcRenderer.removeListener(channel, forward);
  };
}

contextBridge.exposeInMainWorld('buddyDesktop', { invoke, onNotification });
