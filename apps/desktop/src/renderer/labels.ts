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
    '入力した 4\u00a0桁が、この端末が受け取った中枢の証明書と合いません。申請はまだ送っていません。打ち間違いでなければ、別の機器につながっているおそれがあります。中枢の画面の下線の 4\u00a0桁を確かめ、合わなければ「一致しない（やめる）」を押してください。',
  confirmation_declined: '確認で「やめる」を選んだため、送りませんでした。',
  confirmation_pending:
    '別の確認を表示しています。そちらを閉じてから、もう一度押してください。',
  list_superseded: '一覧は新しい結果に置き換わりました。',
  pairing_host_not_allowed:
    'Tailscale のアドレス（100.x.x.x）か、〜.ts.net の名前を入れてください。',
  home_network_changed:
    '確かめている間に、このマシンのネットワークが変わった（または読み取れなくなった）ため、登録しませんでした。「読み取り直す」を押して内容を確かめてから、もう一度登録してください。',
  preview_stale:
    '確かめた後に、内容か状態が変わりました。承認していません。内容をもう一度確かめてください。',
  input_stopped:
    'この端末の入出力が止まっているため、受け付けませんでした。再開してから、もう一度お願いします。',
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
  os_event: 'OS の通知',
  os_query: 'Buddy が確かめた',
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
export const NOT_RECEIVED_NOTE = '（— は中枢から未受信）';

export const STORAGE_MODE_LABELS: Readonly<Record<string, string>> = {
  normal: '通常（7\u00a0日）',
  extended: '継続相談（30\u00a0日）',
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
  address: { index: 1, name: '宛先の入力' },
  fingerprint: { index: 2, name: '指紋の確認' },
  code: { index: 3, name: 'コードの入力' },
  waiting: { index: 4, name: '承認待ち' },
} as const;
export const PAIRING_STEP_COUNT = 4;

// 失敗の重さ: 証明書が変わった（ピン留めが外れた警報）だけ danger、ほかの失敗は warning（UI レビュー 2 回目 R1-M5）。
export type FailureSeverity = 'danger' | 'warning';

export interface FailureCopy {
  readonly severity: FailureSeverity;
  // 失敗した手順（失敗の画面でも「手順 n / 4」を残す）。
  readonly step: keyof typeof PAIRING_STEPS;
  readonly title: string;
  // 本文の先頭に等幅で出す値（試した宛先）。null なら本文だけ。
  readonly subject: string | null;
  readonly body: string;
  readonly action: string;
}

// 文言に入れる値（試した宛先・申請した端末名）。分からなければ null。
export interface FailureContext {
  readonly target: string | null;
  readonly deviceName: string | null;
}

const RESTART = '最初からやり直す';

// ペアリングの失敗ごとの重さ・題・本文・ボタン。失敗の後は宛先の入力（手順 1）から始め直す（ADR 0025）。
export function pairingFailureCopy(
  failure: PairingFailure,
  context: FailureContext,
): FailureCopy {
  const name =
    context.deviceName === null ? 'この端末' : `「${context.deviceName}」`;
  switch (failure) {
    case 'certificate_unavailable':
    case 'unreachable':
      return {
        severity: 'warning',
        step: failure === 'unreachable' ? 'code' : 'address',
        title: '中枢に接続できませんでした',
        subject: context.target,
        body: `${context.target === null ? '中枢' : ''}に接続できませんでした。宛先とポート、中枢が起動しているか、Tailscale がつながっているかを確かめてください。`,
        action: '宛先を直す',
      };
    case 'certificate_changed':
      return {
        severity: 'danger',
        step: 'code',
        title: '中枢の証明書が変わったため、申請を送りませんでした',
        subject: null,
        body: '指紋を確かめた後に、中枢の証明書が変わりました。中枢の画面で状態を確かめてから、最初からやり直してください。',
        action: RESTART,
      };
    case 'pairing_failed':
      return {
        severity: 'warning',
        step: 'code',
        title: 'コードを受け付けませんでした',
        subject: null,
        body: 'コードが違うか、5\u00a0分の期限が切れたか、5\u00a0回の上限に達しました。中枢の画面で新しいコードを出してから、最初からやり直してください。',
        action: RESTART,
      };
    case 'outside_home_network':
      return {
        severity: 'warning',
        step: 'code',
        title: '自宅のネットワークの外からは登録できません',
        subject: null,
        body: '自宅の Wi-Fi・有線につないでから、最初からやり直してください。',
        action: RESTART,
      };
    case 'rate_limited':
      return {
        severity: 'warning',
        step: 'code',
        title: '要求が多すぎるため、受け付けられませんでした',
        subject: null,
        body: '1\u00a0分ほど待ってから、最初からやり直してください。',
        action: RESTART,
      };
    case 'claim_expired':
      return {
        severity: 'warning',
        step: 'waiting',
        title: '申請の期限が切れました',
        subject: null,
        body: '申請から 5\u00a0分以内に中枢で承認されませんでした。中枢の画面で新しいコードを出してから、最初からやり直してください。',
        action: RESTART,
      };
    case 'pickup_refused':
      return {
        severity: 'warning',
        step: 'waiting',
        title: '申請が受け付けられませんでした',
        subject: null,
        body: '中枢で拒否されたか、期限が切れたか、すでに受け取り済みです。最初からやり直してください。',
        action: RESTART,
      };
    case 'pickup_unknown':
      return {
        severity: 'warning',
        step: 'waiting',
        title: '登録が済んだか確かめられませんでした',
        subject: null,
        body: `自動ではやり直しません。中枢の画面の「登録済みの端末」に${name}があれば失効してから、もう一度登録してください。`,
        action: '確かめたので、もう一度登録する',
      };
    case 'secure_storage_unavailable':
      return {
        severity: 'warning',
        step: 'address',
        title: 'この端末では登録できません',
        subject: null,
        body: 'OS の鍵束（安全な保存）が使えないため、登録の情報を保存できません。',
        action: '最初に戻る',
      };
    case 'storage_failed':
      return {
        severity: 'warning',
        step: 'waiting',
        title: '登録の情報を保存できませんでした',
        subject: null,
        body: `中枢の画面の「登録済みの端末」に${name}があれば失効してから、もう一度登録してください。`,
        action: '確かめたので、もう一度登録する',
      };
    case 'protocol_error':
      return {
        severity: 'warning',
        step: 'address',
        title: '中枢の応答を読めませんでした',
        subject: null,
        body: '中枢とこの端末の版を確かめてから、最初からやり直してください。',
        action: RESTART,
      };
  }
}

export const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};
