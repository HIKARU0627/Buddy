// 気づき（候補）の画面の状態と、操作から送る要求（B11-05、ADR 0132。設計 01 気づき、設計 11 §4、ADR 0115）。
// React と DOM に依存しない純粋な関数と状態の持ち主を置き、node:test で試験する。受付の規則・参照の解決・期待する状態は
// main が持つ。画面に来るのは main の参照（ref）と表示用の値（題・期限・種類・状態・注記の材料）だけで、候補 ID は来ない。
// - 見出し（今日・明日・今週・それ以降・期限不明・初回取り込みの過去の期限）は domain の orderCandidates で分け、基準の
//   時刻と本人のタイムゾーンは中枢の応答の値（fetched_at・zone）を使う。端末の OS のタイムゾーンで代用しない。見出しの中は
//   中枢が並べた順（position）。
// - 未取得・取得の失敗を「候補なし」にしない（設計 01）。
// - 再通知の時刻は本人のタイムゾーンで解釈する（domain の candidateSnoozeUntil。checkSnoozeUntil に従う）。
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
  hasOperations: '自動実行の操作があります',
  empty: '今は気づきはありません。',
  truncated:
    '件数が多いため、一部だけを表示しています。対応した気づきが減ると、残りが表示されます。',
  zoneMissing:
    'タイムゾーンを確かめられないため、見出しで分けずに表示しています。',
} as const;

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

// 行に添える注記。メールの候補は常に「対応済みかは未確認」、一部未読なら「本文・添付の一部は未読」（domain の規則）、
// 操作が結び付いていれば自動実行の操作がある旨。
export function rowNotes(entry: DesktopCandidateEntry): string[] {
  const notes = candidateRowNotes(entry);
  if (entry.has_operations) notes.push(CANDIDATE_LABELS.hasOperations);
  return notes;
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
  // 状態の変更を送って結果を待っている行の参照（二重に押させない）。
  readonly busy: string | null;
  readonly notice: CandidateNotice | null;
  // 再通知の日時を選んでいる行。
  readonly snooze: SnoozeDraft | null;
}

export const INITIAL_CANDIDATE_STATE: CandidateViewState = {
  view: null,
  seq: 0,
  reading: false,
  busy: null,
  notice: null,
  snooze: null,
};

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
  readonly open: (ref: string) => void;
  readonly dismiss: (ref: string) => void;
  // 再通知の選択肢を出す・しまう。
  readonly startSnooze: (ref: string) => void;
  readonly cancelSnooze: () => void;
  readonly setSnoozeInput: (value: string) => void;
  readonly snooze: (ref: string, choice: CandidateSnoozeChoice['kind']) => void;
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

  constructor(api: CandidateApi, now: () => number = () => Date.now()) {
    this.#api = api;
    this.#now = now;
    this.actions = {
      refresh: () => this.#list(),
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
    };
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
