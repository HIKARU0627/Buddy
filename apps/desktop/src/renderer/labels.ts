// 画面の文言（日本語）。状態は色だけで判別させず、必ず文言と記号を併記する（設計 01）。
import type {
  DesktopConnectionView,
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
  pairing_step_mismatch:
    'ペアリングの手順と合わないため受け付けませんでした。画面の表示を確かめてください。',
  secure_storage_unavailable:
    'この端末では安全な保存が使えないため、登録できません。',
  pairing_host_not_allowed:
    'Tailscale のアドレス（100.x.x.x）か、〜.ts.net の名前を入れてください。',
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
  not_connected: '未接続',
  connected: '接続中',
  unreachable: '接続できません',
} as const;

export const UNKNOWN = '不明';

// --- 中枢との接続・ペアリング（ADR 0025） ---

type ShownConnection = Extract<DesktopConnectionView, { visibility: 'shown' }>;
type PairingStep = NonNullable<ShownConnection['pairing']>['step'];

export const REGISTRATION_LABELS: Readonly<
  Record<ShownConnection['registration'], string>
> = {
  unregistered: '未登録',
  registered: '登録済み',
  reregistration_required: '⚠ 再登録が必要です',
  secure_storage_unavailable: '⚠ 安全な保存が使えないため登録できません',
};

export const LINK_LABELS: Readonly<Record<ShownConnection['link'], string>> = {
  not_connected: '未接続',
  connecting: '… 接続しています',
  connected: '● 接続中',
  waiting_retry: '○ 接続できません（自動で接続し直します）',
  upgrade_required: '⚠ 中枢の API の版が違うため使えません（更新が必要です）',
  reregistration_required: '⚠ 再登録が必要です',
};

export const LINK_REASON_LABELS: Readonly<
  Record<NonNullable<ShownConnection['link_reason']>, string>
> = {
  unreachable: '中枢に接続できません',
  outside_home_network: '自宅のネットワークの外です',
  rate_limited: '要求が多すぎるため待っています',
  dependency_unavailable: '中枢が一時的に使えません',
  protocol_error: '中枢の応答を読めませんでした',
  core_stopping: '中枢が停止しました',
  slow_consumer: '受信が追いつかず切断されました',
  stream_closed: '接続が切れました',
  alive_timeout: '中枢から応答がありません',
  resnapshot: '最新の状態を取り直しています',
  unauthenticated: 'この端末の登録が無効です（失効・未登録）',
  device_revoked: 'この端末は失効しました',
  certificate_mismatch: '中枢の証明書が登録時と違います',
  api_major_mismatch: '中枢の API の版が違います',
};

export const PAIRING_STEP_LABELS: Readonly<Record<PairingStep, string>> = {
  fetching_certificate: '… 中枢の証明書を受け取っています',
  fingerprint_check: '指紋を確かめてください',
  code_entry: 'ワンタイムコードを入力してください',
  claiming: '… 申請しています',
  waiting_approval: '… 中枢での承認を待っています',
  failed: '⚠ ペアリングできませんでした',
};

export const PAIRING_FAILURE_LABELS: Readonly<
  Record<
    NonNullable<NonNullable<ShownConnection['pairing']>['failure']>,
    string
  >
> = {
  certificate_unavailable:
    '中枢の証明書を受け取れませんでした。宛先とポートを確かめてください。',
  certificate_changed:
    '中枢の証明書が確かめたものと違ったため、申請を送りませんでした。',
  unreachable: '中枢に接続できませんでした。',
  pairing_failed:
    'コードが違う・期限切れ・回数の上限のいずれかです。中枢の画面で開始し直してください。',
  outside_home_network: '自宅のネットワークの外からは登録できません。',
  rate_limited: '要求が多すぎます。しばらく待ってからやり直してください。',
  claim_expired: '申請の期限（5 分）が過ぎました。最初からやり直してください。',
  pickup_refused: '申請が拒否された・期限切れ・受取り済みのいずれかです。',
  pickup_unknown:
    '受取りの結果が分かりません。自動では再送しません。中枢の端末の一覧でこの端末を失効してから、やり直してください。',
  secure_storage_unavailable:
    'この端末では安全な保存が使えないため、登録できません。',
  storage_failed:
    'トークンを保存できませんでした。中枢の端末の一覧でこの端末を失効してから、やり直してください。',
  protocol_error: '中枢の応答を読めませんでした。',
};

export const OPERATION_STATE_LABELS: Readonly<Record<string, string>> = {
  awaiting_approval: '承認待ち',
  approved: '承認済み',
  preparing: '準備中',
  dispatching: '送出中',
  reconciling: '照合中',
  succeeded: '成功',
  unknown_held: '結果不明（保留）',
  not_executed: '未実行',
  cancelled: '取消済み',
  superseded: '置き換え済み',
};

// 指紋（64 桁の 16 進）を 4 桁ずつに区切って読み比べやすくする。
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/gu) ?? []).join(' ');
}

export function formatObservedAt(utc: string): string {
  const date = new Date(utc);
  return Number.isNaN(date.getTime())
    ? utc
    : date.toLocaleString('ja-JP', { hour12: false });
}
