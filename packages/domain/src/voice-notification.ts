// 音声の通知の頻度の制限（B05-02、ADR 0041。設計 10 §7、09 X29・X35）。
// 60 秒以内に届いた気づきは 1 回にまとめ、音声通知の接続は 5 分に 1 回まで（設計初期値。15 秒の最低課金への対策）。
// 時刻は呼び出し側が単調時計で渡す。読み上げの費用は会話予算に計上する（予約は voice-reservation.ts と B07）。

export const NOTIFICATION_BATCH_WINDOW_MS = 60000;
export const NOTIFICATION_MIN_INTERVAL_MS = 300000;
// 1 回の読み上げは最大 5 件（1 件 60 文字以内。文面は B05 以降）。
export const NOTIFICATION_MAX_ITEMS = 5;

export interface PendingNotice {
  readonly id: string;
  readonly arrived_at_ms: number;
}

export interface NotificationState {
  readonly pending: readonly PendingNotice[];
  // 音声通知の接続を最後に開いた時刻。まだなければ null。
  readonly last_connection_at_ms: number | null;
}

export const INITIAL_NOTIFICATION_STATE: NotificationState = {
  pending: [],
  last_connection_at_ms: null,
};

// 読み上げず画面通知だけにする条件（ロック中・来客モード・全体停止中・会話予算の上限到達後。X29）。
export type NotificationBlock =
  'locked' | 'guest_mode' | 'global_stop' | 'budget_reached';

export interface NotificationContext {
  readonly now_ms: number;
  // 本人が音声通知モードを開始している。
  readonly mode_enabled: boolean;
  readonly blocked: NotificationBlock | null;
  // すでに会話の接続が開いている（新しい接続を開かず commentary.append で伝える）。
  readonly conversation_open: boolean;
}

export type NotificationDecision =
  | { readonly action: 'wait'; readonly retry_at_ms: number | null }
  | {
      readonly action: 'screen_only';
      readonly reason: 'mode_off' | NotificationBlock;
      readonly item_ids: readonly string[];
    }
  | {
      readonly action: 'read_new_connection';
      readonly item_ids: readonly string[];
    }
  | {
      readonly action: 'append_to_open_conversation';
      readonly item_ids: readonly string[];
    }
  | { readonly action: 'defer'; readonly retry_at_ms: number };

export interface NotificationOutcome {
  readonly decision: NotificationDecision;
  readonly state: NotificationState;
}

// 気づきを待ちの列に足す。同じ id は 1 回だけ（再配送・再取得で二重に読み上げない。X12）。
export function addNotice(
  state: NotificationState,
  notice: PendingNotice,
): NotificationState {
  return state.pending.some((entry) => entry.id === notice.id)
    ? state
    : { ...state, pending: [...state.pending, notice] };
}

// 今読み上げてよいか。
// - 音声通知モードでない・止める条件にある: 読み上げず、待ちの列を空にして画面通知だけにする（画面通知は別の経路で出ている）。
// - 最初の気づきから 60 秒たつまで待つ（その間の気づきを 1 回にまとめる。60 秒ちょうどに届いたものまで含める）。
// - 会話の接続が開いていれば、新しい接続を開かず commentary.append で伝える（接続の間隔の制限は受けない）。
// - 新しい接続は、前の接続の開始から 5 分（ちょうどから可）たつまで開かない。制限中の気づきは待ちの列に残して次の読み上げにまとめる。
// - 1 回に読むのは古い順の最大 5 件。残りは次の読み上げに回す。まとめの 60 秒より後に届いたものは次のまとまり。
// 時計が戻ったとき（now が最初の気づき・前の接続より前）は、期間がたったと確かめられないので待つ・開かない側に倒す。
export function decideNotification(
  state: NotificationState,
  context: NotificationContext,
): NotificationOutcome {
  const keep = (decision: NotificationDecision): NotificationOutcome => ({
    decision,
    state,
  });
  if (state.pending.length === 0)
    return keep({ action: 'wait', retry_at_ms: null });
  if (!context.mode_enabled || context.blocked !== null)
    return {
      decision: {
        action: 'screen_only',
        reason: context.blocked ?? 'mode_off',
        item_ids: state.pending.map((entry) => entry.id),
      },
      state: { ...state, pending: [] },
    };
  const first = Math.min(...state.pending.map((entry) => entry.arrived_at_ms));
  const windowEnd = first + NOTIFICATION_BATCH_WINDOW_MS;
  if (context.now_ms < windowEnd)
    return keep({ action: 'wait', retry_at_ms: windowEnd });
  const batch = state.pending
    .filter((entry) => entry.arrived_at_ms <= windowEnd)
    .slice(0, NOTIFICATION_MAX_ITEMS);
  const ids = new Set(batch.map((entry) => entry.id));
  const rest = state.pending.filter((entry) => !ids.has(entry.id));
  const item_ids = batch.map((entry) => entry.id);
  if (context.conversation_open)
    return {
      decision: { action: 'append_to_open_conversation', item_ids },
      state: { ...state, pending: rest },
    };
  if (state.last_connection_at_ms !== null) {
    const allowedAt =
      state.last_connection_at_ms + NOTIFICATION_MIN_INTERVAL_MS;
    if (context.now_ms < allowedAt)
      return keep({ action: 'defer', retry_at_ms: allowedAt });
  }
  return {
    decision: { action: 'read_new_connection', item_ids },
    state: { pending: rest, last_connection_at_ms: context.now_ms },
  };
}
