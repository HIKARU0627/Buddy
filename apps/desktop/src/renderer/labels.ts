// 画面の文言（日本語）。状態は色だけで判別させず、必ず文言と記号を併記する（設計 01）。
import type {
  DesktopIpcNotification,
  DesktopIpcResponse,
} from '@buddy/contracts';

type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type PowerEvent = Extract<
  DesktopIpcNotification,
  { channel: 'desktop.power_event' }
>;

export const REJECT_MESSAGES: Readonly<Record<Rejected['reason'], string>> = {
  invalid_request: '要求の形式が正しくないため受け付けませんでした。',
  untrusted_sender: '送信元を確認できないため受け付けませんでした。',
  device_locked: 'ロック中、またはロック状態を確認できないため再開できません。',
  screen_operation_required: 'ウィンドウを前面に表示してから操作してください。',
  not_stopped: 'この端末の入出力は停止していません。',
  core_required: '来客モード・全体停止の解除には中枢での操作が必要です。',
  io_epoch_mismatch:
    '画面の情報が古いため再開しませんでした。最新の状態を確かめてから、もう一度押してください。',
};

export const POWER_EVENT_LABELS: Readonly<Record<PowerEvent['event'], string>> =
  {
    lock_screen: '画面のロック',
    unlock_screen: 'ロックの解除',
    suspend: 'スリープ',
    resume: 'スリープからの復帰',
    shutdown: 'シャットダウン',
  };

export const POWER_SOURCE_LABELS: Readonly<
  Record<PowerEvent['source'], string>
> = {
  os_event: 'OS からの通知',
  os_query: 'OS への問い合わせ',
};

export const STOP_SCOPE_LABELS = {
  none: '● 受付中',
  local: '■ 停止中（この端末）',
  guest: '■ 停止中（来客モード）',
  global: '■ 停止中（全体停止）',
} as const;

export const HUB_CONNECTION_LABELS = {
  not_connected: '未接続（B01 では中枢に接続しません）',
  connected: '接続中',
  unreachable: '接続できません',
} as const;

export const UNKNOWN = '不明';

export function formatObservedAt(utc: string): string {
  const date = new Date(utc);
  return Number.isNaN(date.getTime())
    ? utc
    : date.toLocaleString('ja-JP', { hour12: false });
}
