// 画面の文言（日本語、敬体）。状態は色だけで判別させず、必ず文言と記号を併記する（設計 01、ADR 0024 の約束）。
// 開発の段階名（B0x）・内部の理由のコード・「世代」の語は画面に出さない。エラーは「何が起きたか」と「次に何をするか」。
import type {
  DesktopConnectionView,
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';

type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];
type PowerEvent = Extract<
  DesktopIpcNotification,
  { channel: 'desktop.power_event' }
>;
type ShownConnection = Extract<DesktopConnectionView, { visibility: 'shown' }>;
type PairingFailure = NonNullable<
  NonNullable<ShownConnection['pairing']>['failure']
>;

export const REJECT_MESSAGES: Readonly<Record<RejectReason, string>> = {
  invalid_request: '受け付けられない操作でした。画面を開き直してください。',
  untrusted_sender: '送信元を確かめられないため、受け付けませんでした。',
  device_locked:
    'ロック中、またはロック状態を確かめられないため、受け付けませんでした。',
  screen_operation_required:
    'このウィンドウを一度クリックして前面にしてから、もう一度押してください。',
  not_stopped: 'この端末の入出力は止まっていません。',
  core_required: '来客モード・全体停止の解除は、中枢で行います。',
  io_epoch_mismatch:
    '画面の状態が古いため再開しませんでした。表示が更新されたら、もう一度押してください。',
  pairing_step_mismatch:
    '登録の手順と合わない操作でした。画面の表示を確かめてください。',
  secure_storage_unavailable:
    'この端末では安全な保存が使えないため、登録できません。',
  hub_screen_required: 'この操作は、中枢と同じマシンの画面でだけ行えます。',
  not_connected: '中枢に接続していないため、操作できません。',
  entry_not_found:
    '一覧が古くなっています。一覧を取り直してから、もう一度操作してください。',
  core_rejected:
    '中枢が受け付けませんでした（期限切れ・決め済みなど）。一覧を取り直してください。',
  outcome_unknown:
    '結果を確かめられませんでした。自動では送り直しません。一覧を取り直して確かめてください。',
  fingerprint_tail_mismatch:
    '中枢の画面の指紋と違います。宛先が正しいか確かめてください。',
  pairing_host_not_allowed:
    'Tailscale のアドレス（100.x.x.x）か、〜.ts.net の名前を入れてください。',
  home_network_changed:
    '確かめている間に、このマシンのネットワークが変わったため登録しませんでした。「読み取り直す」を押して内容を確かめてから、もう一度登録してください。',
};

// 操作ごとに言い方を変える拒否（何が拒否されたかと、次の行動）。
export function rejectMessage(
  channel: DesktopIpcRequest['channel'] | null,
  reason: RejectReason,
): string {
  if (channel === 'desktop.io_resume') {
    if (reason === 'screen_operation_required')
      return '再開できませんでした。このウィンドウを一度クリックして前面にしてから、もう一度「この端末で再開する」を押してください。';
    if (reason === 'device_locked')
      return '再開できませんでした。ロックを解除してから、もう一度押してください。';
  }
  return REJECT_MESSAGES[reason];
}

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
  os_event: '通知',
  os_query: '確認',
};

// 入出力の主状態（記号は tones.ts、色は状態帯が付ける）。
export const IO_STATE_LABELS = {
  none: '受付中',
  local: '停止中',
  guest: '停止中（来客モード）',
  global: '全体停止中',
} as const;

// 値を受け取っていない項目。
export const NOT_RECEIVED = '—';
export const NOT_RECEIVED_NOTE = '— は中枢からまだ受け取っていない項目です。';

export const STORAGE_MODE_LABELS: Readonly<Record<string, string>> = {
  normal: '通常（7 日）',
  extended: '継続相談（30 日）',
  private: '記録しない',
};

export const VOICE_STATE_LABELS: Readonly<Record<string, string>> = {
  waiting_wake_word: '呼びかけ待ち',
  conversation_live: '会話中',
  reading_aloud: '読み上げ中',
  device_stopped: 'この端末では停止中',
  global_stopped: '全体停止中',
  budget_voice_stopped: '予算の上限で停止中',
  private_voice_off: '記録しない会話のため OFF',
  listening_text_reply: '聞き取り中（文字で返す）',
};

export const DISPLAY_TARGET_LABELS: Readonly<Record<string, string>> = {
  this_device: 'この端末',
  other_device: '他の端末',
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
  certificate_mismatch: '中枢の証明書が登録したときと違います',
  api_major_mismatch: '中枢の版が違うため使えません',
};

// 自宅の判定の理由（内部のコードを画面の文言にする）。
export const HOME_REASON_LABELS: Readonly<Record<string, string>> = {
  home_not_registered: '自宅がまだ登録されていません',
  report_missing: 'ネットワークの報告がまだ届いていません',
  report_stale: 'ネットワークの報告が古くなっています',
  report_clock_inconsistent: '中枢の時計が報告より前です',
  gateway_mac_unavailable: 'ルーターを確かめられません',
  gateway_mac_mismatch: '自宅のルーターと違います',
  subnet_unavailable: 'ネットワークの範囲を確かめられません',
  subnet_mismatch: '自宅のネットワークの範囲と違います',
  ssid_mismatch: '自宅の Wi-Fi と違います',
  tailscale_unavailable: '中枢で Tailscale の状態を確かめられません',
  tailscale_peer_not_found: 'Tailscale でこの端末が見つかりません',
  tailscale_derp: 'Tailscale が中継（DERP）でつながっています',
  tailscale_peer_relay: 'Tailscale が他の端末の中継でつながっています',
  direct_address_missing: '直接の経路を確かめられません',
  direct_address_invalid: '直接の経路を読めません',
  direct_address_outside_home: '直接の経路が自宅の外です',
};

export const PAIRING_STEPS = {
  address: { index: 1, name: '中枢の宛先' },
  fingerprint: { index: 2, name: '指紋の確認' },
  code: { index: 3, name: 'コードの入力' },
  waiting: { index: 4, name: '承認待ち' },
} as const;
export const PAIRING_STEP_COUNT = 4;

export interface FailureCopy {
  readonly title: string;
  readonly body: string;
  readonly action: string;
}

// ペアリングの失敗ごとの題・本文・ボタン（R1-M5・R2-M7 の案から自然な方を選んだ）。
export const PAIRING_FAILURES: Readonly<Record<PairingFailure, FailureCopy>> = {
  certificate_unavailable: {
    title: '中枢に接続できませんでした',
    body: '宛先とポート、中枢が起動しているか、Tailscale がつながっているかを確かめてください。',
    action: '宛先を直す',
  },
  certificate_changed: {
    title: '中枢の証明書が変わったため、申請を送りませんでした',
    body: '中枢の画面で状態を確かめてから、最初からやり直してください。',
    action: 'もう一度登録する',
  },
  unreachable: {
    title: '中枢に接続できませんでした',
    body: '宛先とポート、中枢が起動しているかを確かめてから、もう一度登録してください。',
    action: '宛先を直す',
  },
  pairing_failed: {
    title: 'コードを受け付けませんでした',
    body: 'コードが違うか、5 分の期限が切れたか、5 回の上限に達しました。中枢の画面で新しいコードを出してから、もう一度登録してください。',
    action: 'もう一度登録する',
  },
  outside_home_network: {
    title: '自宅のネットワークの外からは登録できません',
    body: '自宅の Wi-Fi・有線につないでから、もう一度登録してください。',
    action: 'もう一度登録する',
  },
  rate_limited: {
    title: '要求が多すぎるため、受け付けられませんでした',
    body: '1 分ほど待ってから、もう一度登録してください。',
    action: 'もう一度登録する',
  },
  claim_expired: {
    title: '申請の期限が切れました',
    body: '申請から 5 分以内に中枢で承認されませんでした。中枢の画面で新しいコードを出してから、もう一度登録してください。',
    action: 'もう一度登録する',
  },
  pickup_refused: {
    title: '申請が受け付けられませんでした',
    body: '中枢で拒否されたか、期限が切れたか、すでに受け取り済みです。もう一度登録してください。',
    action: 'もう一度登録する',
  },
  pickup_unknown: {
    title: '登録が済んだか確かめられませんでした',
    body: '自動ではやり直しません。中枢の画面の「登録済みの端末」にこの端末があれば失効してから、もう一度登録してください。',
    action: '失効したので、もう一度登録する',
  },
  secure_storage_unavailable: {
    title: 'この端末では登録できません',
    body: 'OS の鍵束（安全な保存）が使えないため、登録の情報を保存できません。',
    action: '最初に戻る',
  },
  storage_failed: {
    title: '登録の情報を保存できませんでした',
    body: '中枢の画面の「登録済みの端末」にこの端末があれば失効してから、もう一度登録してください。',
    action: 'もう一度登録する',
  },
  protocol_error: {
    title: '中枢の応答を読めませんでした',
    body: '中枢とこの端末の版を確かめてから、もう一度登録してください。',
    action: 'もう一度登録する',
  },
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

export const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};
