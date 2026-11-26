// 自動実行の一覧・安全停止・取り消しの画面の状態と、操作から送る要求（B13-05、ADR 0154。設計 03「取り消しと安全停止」、
// J12、ADR 0152・0153）。React と DOM に依存しない純粋な関数と状態の持ち主を置き、node:test で試験する。参照の解決・
// 操作 ID・版は main が持つ。画面に来るのは main の参照（ref）と表示用の値（種類・完了の時刻・取り消しの状態と期限・
// 安全停止の状態と理由）だけ。
// - 時刻は「〜前」「あと〜」の経過で出す（中枢の一覧は本人のタイムゾーンを返さないので、端末の OS のタイムゾーンで
//   日時を書かない。ADR 0154）。基準は画面の時計。
// - 未取得・取得の失敗を「自動実行なし」「動いている」にしない。
// - 取り消しは押下が確認（J12。ADR 0153 の U311）。安全停止の解除は、ほかの自動実行もまとめて動き出すので、画面の中で
//   もう一度確かめてから送る。
// 理由のコード・API の名前は画面に出さない。
import type {
  DesktopAutoActionEntry,
  DesktopAutoActionView,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopSafetyView,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';

type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];

export const AUTO_ACTION_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

// 知らせを出す場所のうち、安全停止の欄（行の参照は main が作る UUID なので重ならない）。
export const SAFETY_PLACE = 'safety';

// --- 文言 ---

export const AUTO_ACTION_LABELS = {
  section: '自動実行',
  refresh: '読み直す',
  reading: '読み込んでいます…',
  lastFetched: '最終取得',
  undo: '取り消す',
  undoing: '取り消しています…',
  unknown: '取り消しの結果を確認できませんでした',
  empty: '自動で行った操作はありません。',
  completed: '実行',
  running: '自動実行は動いています。',
  stoppedTitle: '自動実行を止めています（安全停止）',
  stoppedAt: '停止',
  resume: '自動実行を再開する',
  resumeConfirm:
    '再開すると、方針で許した操作を、また自動で行うようになります。再開しますか。',
  resumeSubmit: '再開する',
  resuming: '再開しています…',
  cancel: 'やめる',
  safetyUnknown: '安全停止の状態を確かめられていません。',
} as const;

export const AUTO_ACTION_KIND_LABELS: Readonly<
  Record<DesktopAutoActionEntry['kind'], string>
> = {
  create_task: 'タスクの登録',
  create_note: 'メモの作成',
  label_mail: 'メールのラベル付け',
  draft_reply: '返信の下書きの保存',
  create_event: '予定の作成',
};

// 取り消しで何が起きるか（取り消せる行だけに出す）。下書きと用事は削除で元に戻すので、押す前に分かるようにする
// （ADR 0156・0157）。ラベルは逆向きに付け外しするだけなので出さない。
export const UNDO_EFFECT_LABELS: Readonly<
  Partial<Record<DesktopAutoActionEntry['kind'], string>>
> = {
  draft_reply: '取り消すと、Buddy が作った下書きを削除します。',
  create_task: '取り消すと、Buddy が登録したタスクを削除します。',
};

export const STOP_REASON_LABELS: Readonly<
  Record<NonNullable<DesktopSafetyView['stop_reason']>, string>
> = {
  rate_exceeded: '短い間に自動で行った操作が上限を超えたため、止めました。',
  same_target_repeated: '同じ対象への自動実行が続いたため、止めました。',
  compensation_failures: '取り消しの失敗が続いたため、止めました。',
  restored_from_backup:
    'バックアップから戻したため、再開するまで自動実行を止めています。',
};

export const FETCH_LABELS: Readonly<
  Record<DesktopAutoActionView['fetch'], string>
> = {
  loaded: '取得できています',
  stale: '最新の取得に失敗しました。前回の内容を表示しています',
  unavailable: 'まだ取得できていません',
};

// --- 時刻の経過 ---

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const parse = (utc: string | null): number | null => {
  if (utc === null) return null;
  const millis = Date.parse(utc);
  return Number.isFinite(millis) ? millis : null;
};

// 「5 分前」「3 時間前」「2 日前」。時計が戻っていて先の時刻なら「たった今」。読めなければ null。
export function elapsedText(utc: string | null, now: number): string | null {
  const at = parse(utc);
  if (at === null) return null;
  const elapsed = now - at;
  if (elapsed < MINUTE) return 'たった今';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}\u00a0分前`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}\u00a0時間前`;
  return `${Math.floor(elapsed / DAY)}\u00a0日前`;
}

// 取り消しの期限までの残り。「あと 12 日」「あと 5 時間」「あと 1 時間未満」、過ぎていれば null。
export function remainingText(deadline: string, now: number): string | null {
  const at = parse(deadline);
  if (at === null || at <= now) return null;
  const left = at - now;
  if (left >= DAY) return `あと\u00a0${Math.floor(left / DAY)}\u00a0日`;
  if (left >= HOUR) return `あと\u00a0${Math.floor(left / HOUR)}\u00a0時間`;
  return 'あと\u00a01\u00a0時間未満';
}

// 行の取り消しの状態の文言。取り消せる行は期限までの残りを添える。中枢が取り消せると返しても、画面の時計で期限を
// 過ぎていればボタンを出さない（正本は中枢の検査）。
export function undoStateText(
  entry: DesktopAutoActionEntry,
  now: number,
): string {
  switch (entry.undo_state) {
    case 'available': {
      const left = remainingText(entry.undo_deadline, now);
      return left === null
        ? '取り消しの期限を過ぎました'
        : `取り消せます（${left}）`;
    }
    case 'target_changed':
      return 'その後に変わったため、自動では元に戻しません';
    case 'expired':
      return '取り消しの期限を過ぎました';
    case 'in_progress':
      return '取り消しています';
    case 'undone':
      return '取り消しました';
    case 'unavailable':
      return 'この操作は今は取り消せません';
  }
}

export function canUndo(entry: DesktopAutoActionEntry, now: number): boolean {
  return (
    entry.undo_state === 'available' &&
    !entry.delivery_unknown &&
    remainingText(entry.undo_deadline, now) !== null
  );
}

// 欄の頭の一行と安全停止の欄の値。
export type SafetyShown =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'running' }
  | {
      readonly kind: 'stopped';
      readonly ref: string;
      readonly reason: string | null;
      readonly stoppedText: string | null;
    };

export function safetyShown(
  view: DesktopAutoActionView | null,
  now: number,
): SafetyShown {
  const safety = view?.safety ?? null;
  if (safety === null) return { kind: 'unknown' };
  if (safety.state === 'running') return { kind: 'running' };
  return {
    kind: 'stopped',
    ref: safety.ref,
    reason:
      safety.stop_reason === null
        ? null
        : STOP_REASON_LABELS[safety.stop_reason],
    stoppedText: elapsedText(safety.stopped_at, now),
  };
}

// --- 状態 ---

export interface AutoActionNotice {
  readonly tone: 'warning' | 'success';
  readonly text: string;
  // 出す場所。null は欄の頭、SAFETY_PLACE は安全停止の欄、それ以外は行の参照。
  readonly place: string | null;
}

export interface AutoActionViewState {
  // null はまだ受け取っていない。
  readonly view: DesktopAutoActionView | null;
  // 反映した一覧の main の通し番号（0 はまだ反映していない）。これより小さい番号の一覧は反映しない。
  readonly seq: number;
  readonly reading: boolean;
  // 取り消し・解除を送って結果を待っている場所（行の参照か SAFETY_PLACE。二重に押させない）。
  readonly busy: string | null;
  readonly notice: AutoActionNotice | null;
  // 解除の確かめを出している、安全停止の参照。
  readonly confirming: string | null;
}

export const INITIAL_AUTO_ACTION_STATE: AutoActionViewState = {
  view: null,
  seq: 0,
  reading: false,
  busy: null,
  notice: null,
  confirming: null,
};

type Kind = 'list' | 'undo' | 'resume';

export function autoActionFailureText(
  kind: Kind,
  reason: RejectReason,
): string {
  switch (reason) {
    case 'undo_target_changed':
      return '対象がその後に変わっていたため、自動では元に戻しませんでした。必要なら、元のアプリで直してください。';
    case 'preview_stale':
      return kind === 'resume'
        ? '安全停止の状態が変わっていました。一覧を読み直したので、今の状態を確かめてください。'
        : 'この操作の状態が変わっていました（期限切れ・取り消し済みなど）。一覧を読み直したので、もう一度確かめてください。';
    case 'outcome_unknown':
      return '結果を確かめられませんでした。自動では送り直しません。「読み直す」で今の状態を確かめてください。';
    case 'core_rejected':
      return '中枢が受け付けませんでした。一覧を読み直してから、もう一度操作してください。';
    case 'entry_not_found':
      return '一覧が古くなっています。「読み直す」を押してから、もう一度操作してください。';
    case 'not_connected':
      return '中枢に接続していないため、自動実行の一覧を読めません。接続してから「読み直す」を押してください。';
    default:
      return REJECT_MESSAGES[reason];
  }
}

// 一覧の応答を反映する（main の順で古い一覧は反映しない）。
function withView(
  state: AutoActionViewState,
  view: DesktopAutoActionView,
): AutoActionViewState {
  if (view.list_seq < state.seq) return state;
  const refs = new Set(view.entries.map((entry) => entry.ref));
  const place = state.notice?.place ?? null;
  return {
    ...state,
    view,
    seq: view.list_seq,
    // 確かめている停止が今の停止でなくなったら、確かめをしまう（新しい停止を見ないまま解除させない）。
    confirming:
      view.safety !== null &&
      view.safety.state === 'stopped' &&
      view.safety.ref === state.confirming
        ? state.confirming
        : null,
    // 一覧から消えた行の警告は捨てる。
    notice:
      state.notice !== null &&
      place !== null &&
      place !== SAFETY_PLACE &&
      !refs.has(place) &&
      state.notice.tone === 'warning'
        ? null
        : state.notice,
  };
}

export function applyListResponse(
  state: AutoActionViewState,
  response: DesktopIpcResponse,
): AutoActionViewState {
  const reading = { ...state, reading: false };
  if (response.outcome === 'rejected')
    return {
      ...reading,
      notice: {
        tone: 'warning',
        text: autoActionFailureText('list', response.reason),
        place: null,
      },
    };
  if (!('auto_actions' in response)) return reading;
  return withView(reading, response.auto_actions);
}

const SUCCESS_TEXT: Readonly<Record<'undo' | 'resume', string>> = {
  undo: '取り消しを受け付けました。元に戻ったかは、この一覧で確かめられます。',
  resume: '自動実行を再開しました。',
};

export function applyActionResponse(
  state: AutoActionViewState,
  kind: 'undo' | 'resume',
  place: string,
  response: DesktopIpcResponse,
): AutoActionViewState {
  const idle = {
    ...state,
    busy: state.busy === place ? null : state.busy,
    confirming: kind === 'resume' ? null : state.confirming,
  };
  if (response.outcome === 'rejected')
    return {
      ...idle,
      notice: {
        tone: 'warning',
        text: autoActionFailureText(kind, response.reason),
        place,
      },
    };
  if (!('auto_actions' in response)) return idle;
  return withView(
    {
      ...idle,
      notice: { tone: 'success', text: SUCCESS_TEXT[kind], place },
    },
    response.auto_actions,
  );
}

export function applyFailure(
  state: AutoActionViewState,
  place: string | null,
): AutoActionViewState {
  return {
    ...state,
    reading: place === null ? false : state.reading,
    busy: place !== null && state.busy === place ? null : state.busy,
    notice: { tone: 'warning', text: AUTO_ACTION_IPC_FAILURE_MESSAGE, place },
  };
}

// --- 操作 ---

export interface AutoActionActions {
  readonly refresh: () => void;
  readonly undo: (ref: string) => void;
  // 解除の確かめを出す・しまう。
  readonly startResume: () => void;
  readonly cancelResume: () => void;
  readonly resume: () => void;
}

export interface AutoActionApi {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
}

// 読み直しで今の状態を見せる拒否（main も読み直しを始めている）。
const REREAD: ReadonlySet<RejectReason> = new Set([
  'preview_stale',
  'entry_not_found',
  'undo_target_changed',
  'outcome_unknown',
  'core_rejected',
]);

// 表示の権限の世代を持ち、世代をまたいだ応答（ロック・切断の前に送った要求の遅い応答）は反映しない。
export class AutoActionStore {
  readonly #api: AutoActionApi;
  readonly #listeners = new Set<() => void>();
  #state: AutoActionViewState = INITIAL_AUTO_ACTION_STATE;
  #epoch = 0;
  readonly actions: AutoActionActions;

  constructor(api: AutoActionApi) {
    this.#api = api;
    this.actions = {
      refresh: () => this.#list(),
      undo: (ref) => this.#undo(ref),
      startResume: () => {
        const safety = this.#state.view?.safety ?? null;
        if (safety === null || safety.state !== 'stopped') return;
        this.#set({ ...this.#state, confirming: safety.ref, notice: null });
      },
      cancelResume: () => this.#set({ ...this.#state, confirming: null }),
      resume: () => this.#resume(),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): AutoActionViewState => this.#state;

  #set(next: AutoActionViewState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #send(
    built: DesktopIpcRequest,
    onResponse: (
      state: AutoActionViewState,
      response: DesktopIpcResponse,
    ) => AutoActionViewState,
    onFailure: (state: AutoActionViewState) => AutoActionViewState,
  ): Promise<void> {
    const epoch = this.#epoch;
    const apply = (
      change: (prev: AutoActionViewState) => AutoActionViewState,
    ) => {
      if (epoch !== this.#epoch) return;
      this.#set(change(this.#state));
    };
    return this.#api.invoke(built).then(
      (response) => apply((prev) => onResponse(prev, response)),
      () => apply(onFailure),
    );
  }

  #list(): void {
    this.#set({ ...this.#state, reading: true, notice: null });
    void this.#send(
      request('desktop.auto_actions_list', null),
      applyListResponse,
      (state) => applyFailure(state, null),
    );
  }

  // 送った操作の結果を反映し、拒否なら（main が読み直した）一覧を受け取る。
  #act(kind: 'undo' | 'resume', place: string, built: DesktopIpcRequest): void {
    const epoch = this.#epoch;
    let reread = false;
    this.#set({ ...this.#state, busy: place, notice: null });
    void this.#send(
      built,
      (state, response) => {
        reread = response.outcome === 'rejected' && REREAD.has(response.reason);
        return applyActionResponse(state, kind, place, response);
      },
      (state) => applyFailure(state, place),
    ).then(() => {
      if (reread && epoch === this.#epoch) this.#reread();
    });
  }

  #undo(ref: string): void {
    if (this.#state.busy !== null) return;
    this.#act('undo', ref, request('desktop.auto_action_undo', { ref }));
  }

  #resume(): void {
    const confirming = this.#state.confirming;
    if (this.#state.busy !== null || confirming === null) return;
    this.#act(
      'resume',
      SAFETY_PLACE,
      request('desktop.safety_resume', { ref: confirming }),
    );
  }

  // 文言を残したまま一覧だけを読み直す。
  #reread(): void {
    void this.#send(
      request('desktop.auto_actions_list', null),
      (state, response) =>
        response.outcome === 'ok' && 'auto_actions' in response
          ? withView(state, response.auto_actions)
          : state,
      (state) => state,
    );
  }

  // 出せなくなった（ロック・切断）: 世代を進めて内容を捨てる。
  hide(): void {
    this.#epoch += 1;
    this.#set(INITIAL_AUTO_ACTION_STATE);
  }
}
