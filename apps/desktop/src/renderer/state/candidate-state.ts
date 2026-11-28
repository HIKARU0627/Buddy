// 気づき（候補）の画面の状態と、操作から送る要求（B11-05、ADR 0132。設計 01 気づき、設計 11 §4、ADR 0115）。
// React と DOM に依存しない純粋な関数と状態の持ち主を置き、node:test で試験する。受付の規則・参照の解決・期待する状態は
// main が持つ。画面に来るのは main の参照（ref）と表示用の値（題・期限・種類・状態・注記の材料）だけで、候補 ID は来ない。
// - 見出し（今日・明日・今週・それ以降・期限不明・初回取り込みの過去の期限）は domain の orderCandidates で分け、基準の
//   時刻と本人のタイムゾーンは中枢の応答の値（fetched_at・zone）を使う。端末の OS のタイムゾーンで代用しない。見出しの中は
//   中枢が並べた順（position）。
// - 未取得・取得の失敗を「候補なし」にしない（設計 01）。
// - 再通知の時刻は本人のタイムゾーンで解釈する（domain の candidateSnoozeUntil。checkSnoozeUntil に従う）。
// - OS の通知の入・切（ADR 0196）: 画面は main が渡す設定の参照と入・切だけを持ち、変更の要求に参照を載せる（版は main）。
//   別の画面で変わった・結果が分からないときは、一覧を読み直し終えるまで選択を押させない（ADR 0191 の設定と同じ）。
//   設定を読めていない間は選択を出さない（「切」と言わない）。
// - 自動実行の結果（ADR 0199）: 行に、候補に結び付いた自動実行の行（自動実行の欄と同じ参照・種類・取り消しの状態）と、
//   自動実行の一覧に無い件数が来る。「取り消す」は自動実行の欄と同じ desktop.auto_action_undo に自動実行の参照を載せて
//   送り（別の実行の経路を作らない）、結果にかかわらず一覧を読み直す。取り消せない行は送らない（正本は main と中枢の検査）。
// 理由のコード・API の名前は画面に出さない。
import type {
  DesktopCandidateEntry,
  DesktopCandidateView,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import {
  candidateLocalClock,
  candidateRowNotes,
  candidateSnoozeUntil,
  candidateTransition,
  orderCandidates,
  parseCandidateUtc,
} from '@buddy/domain';
import type { CandidateHeading, CandidateSnoozeChoice } from '@buddy/domain';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';
import { autoActionFailureText, canUndo } from './auto-action-state.js';

type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];

export const CANDIDATE_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

// --- 文言（見出しとボタンの名前） ---

export const CANDIDATE_LABELS = {
  section: '気づき',
  refresh: '読み直す',
  reading: '読み込んでいます…',
  lastFetched: '最終取得',
  newCount: '新着',
  open: '開く',
  dismiss: '今回は扱わない',
  snooze: '再通知',
  snoozeTomorrow: '明日（同じ時刻）',
  snoozeNextWeek: '来週（同じ時刻）',
  snoozeAt: '日時を指定',
  snoozeAtInput: '再通知する日時',
  snoozeSubmit: 'この日時に再通知',
  cancel: 'やめる',
  busy: '送っています…',
  unknown: '結果を確認できませんでした',
  dateOnly: '日付のみの期限',
  noDeadline: '期限なし',
  empty: '今は気づきはありません。',
  truncated:
    '件数が多いため、一部だけを表示しています。対応した気づきが減ると、残りが表示されます。',
  zoneMissing:
    'タイムゾーンを確かめられないため、見出しで分けずに表示しています。',
  alert: '新しい気づきを OS の通知で知らせる',
  alertDescription:
    '入にすると、Buddy が前面にないときに、音なしの通知「新しい気づきが N 件あります」を出し、トレイ（macOS はメニューバー）に新着の件数を出します。題・差出人・本文は通知に出しません。画面がロックされている間は出しません。すべての端末で同じ設定です。',
  alertUnavailable:
    'OS の通知の設定をまだ読めていません。「読み直す」を押してください。',
  alertBusy: '設定を送っています…',
  autoActions: 'この気づきから自動で行った操作',
  autoActionsStale:
    '自動実行の最新の取得に失敗しました。前回の内容を表示しています。',
  autoActionsUnread:
    '自動実行の結果をまだ読めていません。「読み直す」を押してください。',
  autoActionUndone:
    '取り消しを受け付けました。元に戻ったかは、この欄を読み直すと確かめられます。',
} as const;

// 結び付いた操作のうち、自動実行の一覧に無い件数の文言（ADR 0199）。
export function unlistedText(count: number): string {
  return `ほかに ${count}\u00a0件の操作は、結果をこの欄では確かめられません（実行中・止まった・古い操作など）。`;
}

export const KIND_LABELS: Readonly<
  Record<DesktopCandidateEntry['kind'], string>
> = {
  schedule_overlap: '予定の重複',
  mail_deadline: 'メールの期限',
  mail_reply: '返信の依頼',
  research_done: '調査の完了',
};

export const STATE_LABELS: Readonly<
  Record<DesktopCandidateEntry['state'], string>
> = {
  new: '新着',
  seen: '確認済み',
  acted: '対応済み',
  dismissed: '扱わない',
  snoozed: '再通知待ち',
  resolved: '解決済み',
};

// 取得の状態（記号＋文言）。
export const FETCH_LABELS: Readonly<
  Record<DesktopCandidateView['fetch'], string>
> = {
  loaded: '取得できています',
  stale: '最新の取得に失敗しました。前回の内容を表示しています',
  unavailable: 'まだ取得できていません',
};

// --- 表示の値 ---

// 「10/9」（年は出さない）。
const monthDay = (date: string): string => {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
};

// 時刻（UTC）を本人のタイムゾーンの「10/9 12:00」にする。読めなければ null。
export function zonedText(
  utc: string | null,
  zone: string | null,
): string | null {
  if (utc === null || zone === null) return null;
  const millis = parseCandidateUtc(utc);
  if (millis === null) return null;
  const clock = candidateLocalClock(millis, zone);
  if (clock === null) return null;
  return `${monthDay(clock.date)} ${clock.time.slice(0, 5)}`;
}

// 期限の書き方。日付だけの期限は時刻を見せず「日付のみの期限」と添える（設計 01）。確定していない期限は原文を添える。
// 時刻付きの期限は期限のタイムゾーンの現地の時刻で、本人のタイムゾーンと違えばタイムゾーン名を添える。
export function deadlineText(
  deadline: DesktopCandidateEntry['deadline'],
  zone: string | null,
): string {
  switch (deadline.kind) {
    case 'none':
      return CANDIDATE_LABELS.noDeadline;
    case 'date':
      return `${monthDay(deadline.date)}（${CANDIDATE_LABELS.dateOnly}）`;
    case 'instant': {
      const [date, time] = deadline.local_datetime.split('T') as [
        string,
        string,
      ];
      const shown = `${monthDay(date)} ${time.slice(0, 5)}`;
      return deadline.zone === zone ? shown : `${shown}（${deadline.zone}）`;
    }
    case 'unresolved':
      return `期限は未確定（「${deadline.original_text}」）`;
  }
}

// 行に添える注記。メールの候補は常に「対応済みかは未確認」、一部未読なら「本文・添付の一部は未読」（domain の規則）。
// 結び付いた自動実行の操作は、注記ではなく行の中の欄（「この気づきから自動で行った操作」）で出す（ADR 0199）。
export function rowNotes(entry: DesktopCandidateEntry): string[] {
  return candidateRowNotes(entry);
}

// 行に出す操作。状態の遷移表（domain）で許される操作だけを出す（acted は開く・扱わない・再通知を出さない）。
export function rowActions(
  entry: DesktopCandidateEntry,
): readonly ('open' | 'dismiss' | 'snooze')[] {
  return (['open', 'snooze', 'dismiss'] as const).filter(
    (event) => candidateTransition(entry.state, event) !== null,
  );
}

export interface CandidateSection {
  readonly heading: CandidateHeading | null;
  readonly label: string | null;
  // 初回取り込みの過去の期限だけ、既定で折りたたむ。
  readonly collapsed: boolean;
  readonly entries: readonly DesktopCandidateEntry[];
}

// 見出しで分ける。基準は中枢が並べた時刻（fetched_at）と本人のタイムゾーン（zone）。どちらかが無い・読めないときは
// 見出しなしの 1 つにまとめ、中枢の順のまま出す（端末の OS のタイムゾーンで代用しない）。
export function candidateSections(view: DesktopCandidateView): {
  readonly headed: boolean;
  readonly sections: CandidateSection[];
} {
  const byPosition = (a: DesktopCandidateEntry, b: DesktopCandidateEntry) =>
    a.position - b.position;
  const flat = {
    headed: false,
    sections:
      view.entries.length === 0
        ? []
        : [
            {
              heading: null,
              label: null,
              collapsed: false,
              entries: [...view.entries].sort(byPosition),
            },
          ],
  };
  if (view.zone === null || view.fetched_at === null) return flat;
  const items = view.entries.map((entry) => ({
    candidate_id: entry.ref,
    kind: entry.kind,
    deadline: entry.deadline,
    initial_import: entry.initial_import,
    // 見出しの中の順は中枢の順（position）で決め直すので、受信の時刻は使わない。
    received_at: view.fetched_at as string,
    entry,
  }));
  const ordered = orderCandidates(items, {
    now: view.fetched_at,
    zone: view.zone,
  });
  if (!ordered.ok) return flat;
  return {
    headed: true,
    sections: ordered.groups.map((group) => ({
      heading: group.heading,
      label: group.label,
      collapsed: group.collapsed,
      entries: group.items.map((item) => item.entry).sort(byPosition),
    })),
  };
}

// --- 状態 ---

export interface CandidateNotice {
  readonly tone: 'warning' | 'success';
  readonly text: string;
  // 出す場所。null は欄の頭（読み直し）、それ以外は行の参照。
  readonly ref: string | null;
}

export interface SnoozeDraft {
  readonly ref: string;
  // 「日時を指定」の入力（本人のタイムゾーンの YYYY-MM-DDTHH:MM）。
  readonly input: string;
  // 入力に問題があった文言。
  readonly problem: string | null;
}

export interface CandidateViewState {
  // null はまだ受け取っていない。
  readonly view: DesktopCandidateView | null;
  // 反映した一覧の main の通し番号（0 はまだ反映していない）。これより小さい番号の一覧は反映しない。
  readonly seq: number;
  readonly reading: boolean;
  // 状態の変更を送って結果を待っている行の参照、または取り消しを送って結果を待っている自動実行の参照（二重に押させない）。
  readonly busy: string | null;
  readonly notice: CandidateNotice | null;
  // 再通知の日時を選んでいる行。
  readonly snooze: SnoozeDraft | null;
  // OS の通知の入・切を送って結果を待っている、または断られて読み直しを待っている（押させない）。
  readonly alertBusy: boolean;
}

export const INITIAL_CANDIDATE_STATE: CandidateViewState = {
  view: null,
  seq: 0,
  reading: false,
  busy: null,
  notice: null,
  snooze: null,
  alertBusy: false,
};

const ALERT_SUCCESS_TEXT: Readonly<Record<'on' | 'off', string>> = {
  on: 'OS の通知を入にしました。これから新しくできた気づきを知らせます（今ある気づきは知らせません）。',
  off: 'OS の通知を切にしました。トレイの新着の件数も出しません。',
};

export function candidateAlertFailureText(reason: RejectReason): string {
  switch (reason) {
    case 'preview_stale':
      return '別の画面で OS の通知の設定が変わっていました。設定を読み直したので、もう一度確かめてください。';
    case 'outcome_unknown':
      return 'OS の通知の設定を変えられたか確かめられませんでした。自動では送り直しません。設定を読み直しています。';
    case 'entry_not_found':
      return CANDIDATE_LABELS.alertUnavailable;
    default:
      return candidateFailureText(reason);
  }
}

// OS の通知の入・切の変更の応答を反映する。断られたら欄の頭に理由を出す（押せないままにするかは呼び出し側が決める）。
export function applyAlertResponse(
  state: CandidateViewState,
  value: 'on' | 'off',
  response: DesktopIpcResponse,
): CandidateViewState {
  if (response.outcome === 'rejected')
    return {
      ...state,
      notice: {
        tone: 'warning',
        text: candidateAlertFailureText(response.reason),
        ref: null,
      },
    };
  if (!('candidates' in response)) return { ...state, alertBusy: false };
  return {
    ...withView(state, response.candidates),
    alertBusy: false,
    notice: { tone: 'success', text: ALERT_SUCCESS_TEXT[value], ref: null },
  };
}

const SUCCESS_TEXT: Readonly<Record<string, string>> = {
  open: '開きました。',
  dismiss: '今回は扱わないことにしました。元のメール・予定は変えていません。',
  snooze: '指定した日時に、もう一度お知らせします。',
};

export function candidateFailureText(reason: RejectReason): string {
  switch (reason) {
    case 'preview_stale':
      return 'この気づきの状態が変わっていました。一覧を読み直したので、もう一度確かめてください。';
    case 'outcome_unknown':
      return '結果を確かめられませんでした。自動では送り直しません。一覧が更新されるまで、お待ちください。';
    case 'core_rejected':
      return '中枢が受け付けませんでした。一覧を読み直してから、もう一度操作してください。';
    case 'invalid_request':
      return '再通知の日時は、今より後の日時を選んでください。';
    case 'not_connected':
      return '中枢に接続していないため、気づきを読めません。接続してから「読み直す」を押してください。';
    default:
      return REJECT_MESSAGES[reason];
  }
}

// 一覧の応答を反映する（main の順で古い一覧は反映しない）。
function withView(
  state: CandidateViewState,
  view: DesktopCandidateView,
): CandidateViewState {
  if (view.list_seq < state.seq) return state;
  const refs = new Set(view.entries.map((entry) => entry.ref));
  return {
    ...state,
    view,
    seq: view.list_seq,
    // 一覧から消えた行の入力・文言は捨てる。
    snooze:
      state.snooze !== null && refs.has(state.snooze.ref) ? state.snooze : null,
    notice:
      state.notice !== null &&
      state.notice.ref !== null &&
      !refs.has(state.notice.ref) &&
      state.notice.tone === 'warning'
        ? null
        : state.notice,
  };
}

export function applyListResponse(
  state: CandidateViewState,
  response: DesktopIpcResponse,
): CandidateViewState {
  const reading = { ...state, reading: false };
  if (response.outcome === 'rejected')
    return {
      ...reading,
      notice: {
        tone: 'warning',
        text: candidateFailureText(response.reason),
        ref: null,
      },
    };
  if (!('candidates' in response)) return reading;
  return withView(reading, response.candidates);
}

export function applyChangeResponse(
  state: CandidateViewState,
  ref: string,
  event: 'open' | 'dismiss' | 'snooze',
  response: DesktopIpcResponse,
): CandidateViewState {
  const idle = { ...state, busy: state.busy === ref ? null : state.busy };
  if (response.outcome === 'rejected')
    return {
      ...idle,
      notice: {
        tone: 'warning',
        text: candidateFailureText(response.reason),
        ref,
      },
    };
  if (!('candidates' in response)) return idle;
  const next = withView({ ...idle, snooze: null }, response.candidates);
  // 開いたときは知らせを出さない（行の状態が変わるだけ）。扱わない・再通知は行が一覧から消えるので、欄の頭に知らせる。
  return event === 'open'
    ? { ...next, notice: null }
    : {
        ...next,
        notice: { tone: 'success', text: SUCCESS_TEXT[event] ?? '', ref: null },
      };
}

export function applyFailure(
  state: CandidateViewState,
  ref: string | null,
): CandidateViewState {
  return {
    ...state,
    reading: ref === null ? false : state.reading,
    busy: ref !== null && state.busy === ref ? null : state.busy,
    notice: { tone: 'warning', text: CANDIDATE_IPC_FAILURE_MESSAGE, ref },
  };
}

// --- 操作 ---

export interface CandidateActions {
  readonly refresh: () => void;
  // 文言を残したまま一覧だけを読み直す（自動実行の欄で取り消した・読み直した後。ADR 0199）。
  readonly reload: () => void;
  readonly open: (ref: string) => void;
  readonly dismiss: (ref: string) => void;
  // 再通知の選択肢を出す・しまう。
  readonly startSnooze: (ref: string) => void;
  readonly cancelSnooze: () => void;
  readonly setSnoozeInput: (value: string) => void;
  readonly snooze: (ref: string, choice: CandidateSnoozeChoice['kind']) => void;
  // OS の通知の入・切（ADR 0196）。
  readonly setAlert: (value: 'on' | 'off') => void;
  // 行に結び付いた自動実行の取り消し（ADR 0199）。候補の参照と自動実行の参照。
  readonly undoAutoAction: (
    candidateRef: string,
    autoActionRef: string,
  ) => void;
}

export interface CandidateApi {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
}

// 表示の権限の世代を持ち、世代をまたいだ応答（ロック・切断の前に送った要求の遅い応答）は反映しない。
export class CandidateStore {
  readonly #api: CandidateApi;
  // 画面の時計（UTC のミリ秒）。再通知の「明日・来週」の基準。試験で差し替える。
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #state: CandidateViewState = INITIAL_CANDIDATE_STATE;
  #epoch = 0;
  readonly actions: CandidateActions;

  // 気づきの欄で取り消した後に呼ぶ（自動実行の欄を読み直させる）。
  readonly #autoActionsChanged: () => void;

  constructor(
    api: CandidateApi,
    now: () => number = () => Date.now(),
    autoActionsChanged: () => void = () => undefined,
  ) {
    this.#api = api;
    this.#now = now;
    this.#autoActionsChanged = autoActionsChanged;
    this.actions = {
      refresh: () => this.#list(),
      reload: () => this.#reread(),
      open: (ref) => this.#change(ref, 'open', null),
      dismiss: (ref) => this.#change(ref, 'dismiss', null),
      startSnooze: (ref) =>
        this.#set({
          ...this.#state,
          snooze: { ref, input: '', problem: null },
          notice: null,
        }),
      cancelSnooze: () => this.#set({ ...this.#state, snooze: null }),
      setSnoozeInput: (value) => {
        const draft = this.#state.snooze;
        if (draft === null) return;
        this.#set({
          ...this.#state,
          snooze: { ...draft, input: value, problem: null },
        });
      },
      snooze: (ref, kind) => this.#snooze(ref, kind),
      setAlert: (value) => this.#setAlert(value),
      undoAutoAction: (candidateRef, autoActionRef) =>
        this.#undoAutoAction(candidateRef, autoActionRef),
    };
  }

  // 結び付いた自動実行を取り消す。押下が確認（J12、ADR 0153・0154）。今の一覧で取り消せると読めた行だけを送り、
  // 結果にかかわらず一覧を読み直す（main は受け付けた後・断った後に自動実行の一覧を読み直している）。
  #undoAutoAction(candidateRef: string, autoActionRef: string): void {
    if (this.#state.busy !== null) return;
    const candidate = this.#state.view?.entries.find(
      (item) => item.ref === candidateRef,
    );
    const auto = candidate?.auto_actions.find(
      (item) => item.ref === autoActionRef,
    );
    if (auto === undefined || !canUndo(auto, this.#now())) return;
    const epoch = this.#epoch;
    this.#set({ ...this.#state, busy: autoActionRef, notice: null });
    void this.#send(
      request('desktop.auto_action_undo', { ref: autoActionRef }),
      (state, response) => ({
        ...state,
        busy: state.busy === autoActionRef ? null : state.busy,
        notice:
          response.outcome === 'rejected'
            ? {
                tone: 'warning',
                // 自動実行の欄と同じ文言。
                text: autoActionFailureText('undo', response.reason),
                ref: candidateRef,
              }
            : {
                tone: 'success',
                text: CANDIDATE_LABELS.autoActionUndone,
                ref: candidateRef,
              },
      }),
      (state) => ({
        ...state,
        busy: state.busy === autoActionRef ? null : state.busy,
        notice: {
          tone: 'warning',
          text: CANDIDATE_IPC_FAILURE_MESSAGE,
          ref: candidateRef,
        },
      }),
    ).then(() => {
      if (epoch !== this.#epoch) return;
      // 2 つの読み直しは重なるが、それぞれ別の欄の写しを新しくする（気づきの行と自動実行の欄）。main の自動実行の
      // 一覧の読み取りは進行中の読み取りにまとめられる（AutoActionBridge.refresh）ので、中枢への要求は増えても 1 回。
      this.#reread();
      this.#autoActionsChanged();
    });
  }

  #setAlert(value: 'on' | 'off'): void {
    const alert = this.#state.view?.alert ?? null;
    if (alert === null || this.#state.alertBusy) return;
    const epoch = this.#epoch;
    let held = false;
    this.#set({ ...this.#state, alertBusy: true, notice: null });
    void this.#send(
      request('desktop.candidate_alert_setting', {
        settings_ref: alert.ref,
        os_notification: value,
      }),
      (state, response) => {
        held =
          response.outcome === 'rejected' &&
          (response.reason === 'preview_stale' ||
            response.reason === 'outcome_unknown');
        const next = applyAlertResponse(state, value, response);
        return held ? next : { ...next, alertBusy: false };
      },
      (state) => ({ ...applyFailure(state, null), alertBusy: false }),
    ).then(() => {
      // 別の画面で変わった・結果が分からない: 読み直し（新しい参照）を受け取るまで押させない。
      if (!held || epoch !== this.#epoch) return;
      void this.#send(
        request('desktop.candidates_list', null),
        (state, response) =>
          response.outcome === 'ok' && 'candidates' in response
            ? { ...withView(state, response.candidates), alertBusy: false }
            : { ...state, alertBusy: false },
        (state) => ({ ...state, alertBusy: false }),
      );
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): CandidateViewState => this.#state;

  #set(next: CandidateViewState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #send(
    built: DesktopIpcRequest,
    onResponse: (
      state: CandidateViewState,
      response: DesktopIpcResponse,
    ) => CandidateViewState,
    onFailure: (state: CandidateViewState) => CandidateViewState,
  ): Promise<void> {
    const epoch = this.#epoch;
    const apply = (
      change: (prev: CandidateViewState) => CandidateViewState,
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
      request('desktop.candidates_list', null),
      applyListResponse,
      (state) => applyFailure(state, null),
    );
  }

  #change(
    ref: string,
    event: 'open' | 'dismiss' | 'snooze',
    snoozeUntil: string | null,
  ): void {
    if (this.#state.busy !== null) return;
    const epoch = this.#epoch;
    let stale = false;
    this.#set({ ...this.#state, busy: ref, notice: null });
    void this.#send(
      request('desktop.candidate_state', {
        ref,
        event,
        snooze_until: snoozeUntil,
      }),
      (state, response) => {
        stale =
          response.outcome === 'rejected' &&
          (response.reason === 'preview_stale' ||
            response.reason === 'entry_not_found');
        return applyChangeResponse(state, ref, event, response);
      },
      (state) => applyFailure(state, ref),
    ).then(() => {
      // 状態が変わっていた・参照が古かった（main が読み直した）ときは、読み直した一覧を受け取る（409 では読み直す）。
      if (stale && epoch === this.#epoch) this.#reread();
    });
  }

  // 文言を残したまま一覧だけを読み直す。
  #reread(): void {
    void this.#send(
      request('desktop.candidates_list', null),
      (state, response) =>
        response.outcome === 'ok' && 'candidates' in response
          ? withView(state, response.candidates)
          : state,
      (state) => state,
    );
  }

  #snooze(ref: string, kind: CandidateSnoozeChoice['kind']): void {
    const zone = this.#state.view?.zone ?? null;
    const draft = this.#state.snooze;
    // 本人のタイムゾーンが分からなければ、再通知の日時を決めない（端末の OS のタイムゾーンで代用しない）。
    if (zone === null) {
      this.#set({
        ...this.#state,
        notice: {
          tone: 'warning',
          text: 'タイムゾーンを確かめられないため、再通知の日時を決められません。「読み直す」を押してください。',
          ref,
        },
      });
      return;
    }
    const choice: CandidateSnoozeChoice =
      kind === 'at'
        ? {
            kind: 'at',
            local_datetime:
              draft !== null && draft.ref === ref ? draft.input : '',
          }
        : { kind };
    const now = new Date(this.#now()).toISOString();
    const until = candidateSnoozeUntil(choice, now, zone);
    if (!until.ok) {
      this.#set({
        ...this.#state,
        snooze: {
          ref,
          input: draft?.ref === ref ? draft.input : '',
          problem:
            until.reason === 'not_in_future'
              ? '今より後の日時を選んでください。'
              : '日付と時刻を入れてください。',
        },
      });
      return;
    }
    this.#change(ref, 'snooze', until.until);
  }

  // 出せなくなった（ロック・切断）: 世代を進めて内容を捨てる。
  hide(): void {
    this.#epoch += 1;
    this.#set(INITIAL_CANDIDATE_STATE);
  }
}

// 欄の頭の一行（最終取得時刻・取得状態・新着の件数）に使う値。
export function headerOf(view: DesktopCandidateView | null): {
  readonly fetch: DesktopCandidateView['fetch'];
  readonly fetchedText: string | null;
  readonly newCount: number | null;
} {
  if (view === null)
    return { fetch: 'unavailable', fetchedText: null, newCount: null };
  return {
    fetch: view.fetch,
    fetchedText: zonedText(view.fetched_at, view.zone),
    newCount: view.counts === null ? null : view.counts.new,
  };
}

// 「明日（同じ時刻）」などの選択肢の名前に添える、本人のタイムゾーンでの時刻（「10/10 12:00」）。読めなければ null。
export function snoozePreview(
  kind: 'tomorrow' | 'next_week',
  now: number,
  zone: string | null,
): string | null {
  if (zone === null) return null;
  const until = candidateSnoozeUntil(
    { kind },
    new Date(now).toISOString(),
    zone,
  );
  return until.ok ? zonedText(until.until, zone) : null;
}
