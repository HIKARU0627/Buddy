// 家計簿の画面の状態と、操作から送る要求（ADR 0162。API は ADR 0161）。React と DOM に依存しない純粋な関数と状態の
// 持ち主を置き、node:test で試験する。記録の ID・内容版は main が持つ。画面に来るのは main の参照（ref）と表示用の値だけ。
// - 今月は中枢が本人のタイムゾーンで決めた値を使う（端末の時計で決めない。U331）。月は合計の一覧から選ぶ。
// - 未取得・取得の失敗を「記録はありません」にしない。
// - 分類の変更は選んだらすぐ送る（直せるので確かめない）。削除は同じ通知から作り直さないので、画面の中で一度確かめる。
// 理由のコード・API の名前・記録の ID は画面に出さない。
import type {
  DesktopHouseholdEntry,
  DesktopHouseholdView,
  DesktopIpcRequest,
  DesktopIpcResponse,
  HouseholdCategoryId,
} from '@buddy/contracts';
import { HOUSEHOLD_CATEGORIES } from '@buddy/domain';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';

type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];

export const HOUSEHOLD_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

// --- 文言 ---

export const HOUSEHOLD_LABELS = {
  section: '家計簿',
  refresh: '読み直す',
  reading: '読み込んでいます…',
  lastFetched: '最終取得',
  months: '月ごとの合計',
  expense: '支出',
  income: '収入',
  balance: '収支',
  transfer: '振替',
  count: '件',
  byCategory: '分類ごとの支出',
  entries: '記録',
  empty: 'この月の記録はありません。',
  category: '分類',
  delete: '削除する',
  deleting: '削除しています…',
  deleteConfirm:
    'この記録を削除しますか。削除した記録は集計から外れ、同じ通知からは作り直しません。',
  deleteSubmit: '削除する',
  cancel: 'やめる',
  changing: '分類を変えています…',
  unknown: '変更の結果を確認できませんでした',
  thisMonth: '今月',
  truncated:
    '記録が多いため、一部の記録を読み込めていません。合計は読み込めた記録だけのものです。',
  intakeOn: 'カードの利用通知メールを取り込んでいます。',
  intakeOff: 'カードの利用通知メールの取り込みを止めています。',
  intakeStop: '取り込みを止める',
  intakeResume: '取り込みを再開する',
  intakeResumeNote:
    '再開すると、止めていた間に届いた通知は読みません。その分は書き出したファイルの取り込みで補ってください。',
  intakeChanging: '切り替えています…',
  importTitle: '書き出したファイルの取り込み',
  importNote:
    'マネーフォワード ME のアプリで書き出した入出金履歴の CSV を取り込みます。取り込み済みの行と、利用通知で記録済みの利用は二重に記録しません。',
  importButton: 'ファイルを選んで取り込む',
  importing: '取り込んでいます…',
  recurringTitle: '定期の支出（固定費の目安）',
  recurringNote:
    '毎月決まって払っている支出です。直近 12 か月の記録から、3 か月以上続き、今月か先月にもある店を数えています。',
  recurringEmpty: 'まだ定期の支出は見つかっていません。',
  recurringTotal: '月の固定費の目安',
  budgetTitle: '予算',
  budgetEmpty: 'まだ予算を決めていません。',
  budgetEdit: '予算を決める',
  budgetSave: '予算を保存する',
  budgetSaving: '保存しています…',
  budgetNote:
    '分類ごとの月の予算を円で入れてください。空のままの分類は予算なしにします。',
  budgetTotal: '予算の合計',
  budgetInvalid: '予算は 1 円以上の整数で入れてください。',
} as const;

type BudgetPayload = Extract<
  DesktopIpcRequest,
  { channel: 'desktop.household_budget' }
>['payload'];

// 予算の知らせを出す場所。
export const BUDGET_PLACE = 'budget';

// 予算に対する使い方の文。「12,000 円 / 40,000 円（残り 28,000 円）」「42,000 円 / 40,000 円（2,000 円の超過）」。
export function budgetUseText(use: {
  readonly budget_yen: number;
  readonly spent_yen: number;
  readonly remaining_yen: number;
}): string {
  const head = `${yenText(use.spent_yen)} / ${yenText(use.budget_yen)}`;
  return use.remaining_yen >= 0
    ? `${head}（残り ${yenText(use.remaining_yen)}）`
    : `${head}（${yenText(-use.remaining_yen)}の超過）`;
}

/**
 * 入力欄の文字（分類 → 入れた文字）から予算の一覧を作る。空は予算なし。全角数字とコンマを受ける。正の整数で
 * なければ null（保存させない）。
 */
export function budgetItemsFromInput(
  input: Readonly<Record<string, string>>,
): { category: HouseholdCategoryId; budget_yen: number }[] | null {
  const items: { category: HouseholdCategoryId; budget_yen: number }[] = [];
  for (const choice of categoryChoices('expense')) {
    const raw = (input[choice.id] ?? '')
      .normalize('NFKC')
      .replaceAll(',', '')
      .trim();
    if (raw === '') continue;
    if (!/^[1-9][0-9]{0,9}$/u.test(raw)) return null;
    const value = Number(raw);
    if (value > 9_999_999_999) return null;
    items.push({ category: choice.id, budget_yen: value });
  }
  return items;
}

// 「12 か月中 4 か月」（定期の支出が現れた月の数）。
export function monthsSeenText(months: number): string {
  return `12\u00a0か月中\u00a0${String(months)}\u00a0か月`;
}

// 取り込みの知らせを出す場所。
export const IMPORT_PLACE = 'import';

type LastImport = NonNullable<DesktopHouseholdView['last_import']>;

// 取り込みの結果の文。
export function importResultText(result: LastImport): string {
  if (result.outcome === 'unreadable')
    return 'ファイルを読めませんでした。マネーフォワード ME のアプリで書き出した入出金履歴の CSV か、16\u00a0MB 以下かを確かめてください。';
  const parts = [
    `新しく記録\u00a0${String(result.created)}\u00a0件`,
    `取り込み済み\u00a0${String(result.duplicate)}\u00a0件`,
    `利用通知と同じ\u00a0${String(result.matched)}\u00a0件`,
  ];
  if (result.skipped > 0)
    parts.push(`集計から外した行など\u00a0${String(result.skipped)}\u00a0件`);
  if (result.rejected > 0)
    parts.push(`記録できなかった行\u00a0${String(result.rejected)}\u00a0件`);
  const counts = `${parts.join('、')}。`;
  return result.outcome === 'stopped'
    ? `途中で中枢に送れなくなったため止めました（${counts}）もう一度取り込むと、残りの行を記録します（記録済みの行は増えません）。`
    : `取り込みました（${counts}）`;
}

// 取り込みの入・切の知らせを出す場所（行の参照は main が作る UUID なので重ならない）。
export const INTAKE_PLACE = 'intake';

export const FETCH_LABELS: Readonly<
  Record<DesktopHouseholdView['fetch'], string>
> = {
  loaded: '取得できています',
  stale: '最新の取得に失敗しました。前回の内容を表示しています',
  unavailable: 'まだ取得できていません',
};

export const SOURCE_LABELS: Readonly<
  Record<DesktopHouseholdEntry['source_kind'], string>
> = {
  mail_notice: '利用通知メール',
  csv_import: '取り込み',
  manual: '手入力',
};

export const DIRECTION_LABELS: Readonly<
  Record<DesktopHouseholdEntry['direction'], string>
> = {
  expense: '支出',
  income: '収入',
  transfer: '振替',
};

const CATEGORY_LABELS: ReadonlyMap<string, string> = new Map(
  HOUSEHOLD_CATEGORIES.map((category) => [category.id, category.label]),
);

export function categoryLabel(id: string): string {
  return CATEGORY_LABELS.get(id) ?? id;
}

// その記録に付けられる分類（向きが同じもの。表示の順）。支出は 18 個、収入・振替は 1 個。
export function categoryChoices(
  direction: DesktopHouseholdEntry['direction'],
): readonly { readonly id: HouseholdCategoryId; readonly label: string }[] {
  return HOUSEHOLD_CATEGORIES.filter(
    (category) => category.direction === direction,
  ).map((category) => ({
    id: category.id as HouseholdCategoryId,
    label: category.label,
  }));
}

// 「1,280 円」「-3,000 円」。区切りは端末の言語の設定によらず 3 桁ごとのコンマ。
export function yenText(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(amount))).replace(
    /\B(?=(\d{3})+(?!\d))/gu,
    ',',
  );
  return `${sign}${digits}\u00a0円`;
}

// 「2030 年 11 月」。形が違えばそのまま。
export function monthText(month: string): string {
  const match = /^([0-9]{4})-([0-9]{2})$/u.exec(month);
  if (match === null) return month;
  return `${match[1] as string}\u00a0年\u00a0${String(Number(match[2]))}\u00a0月`;
}

// 「11 月 3 日 12:34」（年は月の見出しにあるので出さない）。
export function dayText(entry: DesktopHouseholdEntry): string {
  const [, month, day] = entry.occurred_on.split('-');
  const date = `${String(Number(month))}\u00a0月\u00a0${String(Number(day))}\u00a0日`;
  return entry.occurred_time === null ? date : `${date} ${entry.occurred_time}`;
}

// --- 時刻の経過（最終取得） ---

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function elapsedText(utc: string | null, now: number): string | null {
  if (utc === null) return null;
  const at = Date.parse(utc);
  if (!Number.isFinite(at)) return null;
  const elapsed = now - at;
  if (elapsed < MINUTE) return 'たった今';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}\u00a0分前`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}\u00a0時間前`;
  return `${Math.floor(elapsed / DAY)}\u00a0日前`;
}

// --- 状態 ---

export interface HouseholdNotice {
  readonly tone: 'warning' | 'success';
  readonly text: string;
  // 出す場所。null は欄の頭、それ以外は行の参照。
  readonly place: string | null;
}

export interface HouseholdViewState {
  // null はまだ受け取っていない。
  readonly view: DesktopHouseholdView | null;
  // 反映した値の main の通し番号（0 はまだ反映していない）。これより小さい番号の値は反映しない。
  readonly seq: number;
  readonly reading: boolean;
  // 変更・削除を送って結果を待っている行の参照（二重に押させない）。
  readonly busy: string | null;
  readonly notice: HouseholdNotice | null;
  // 削除の確かめを出している行の参照。
  readonly confirming: string | null;
  // 予算の入力欄を出しているか。
  readonly editingBudget: boolean;
}

export const INITIAL_HOUSEHOLD_STATE: HouseholdViewState = {
  view: null,
  seq: 0,
  reading: false,
  busy: null,
  notice: null,
  confirming: null,
  editingBudget: false,
};

type Kind = 'view' | 'category' | 'delete' | 'intake' | 'import' | 'budget';

export function householdFailureText(kind: Kind, reason: RejectReason): string {
  switch (reason) {
    case 'preview_stale':
      return kind === 'intake'
        ? '取り込みの設定はその後に変わっていました。読み直したので、今の設定を確かめてください。'
        : kind === 'budget'
          ? '予算はその後に変わっていました。読み直したので、今の予算を確かめてから、もう一度保存してください。'
          : 'この記録はその後に変わっていました。読み直したので、今の内容を確かめてから、もう一度操作してください。';
    case 'outcome_unknown':
      return '結果を確かめられませんでした。自動では送り直しません。「読み直す」で今の内容を確かめてください。';
    case 'core_rejected':
      return kind === 'category'
        ? 'この分類には変えられませんでした。読み直したので、もう一度選んでください。'
        : '中枢が受け付けませんでした。読み直したので、もう一度操作してください。';
    case 'entry_not_found':
      return '表示が古くなっています。「読み直す」を押してから、もう一度操作してください。';
    case 'list_superseded':
      return '別の月を読み込んでいます。';
    case 'not_connected':
      return '中枢に接続していないため、家計簿を読めません。接続してから「読み直す」を押してください。';
    default:
      return REJECT_MESSAGES[reason];
  }
}

function withView(
  state: HouseholdViewState,
  view: DesktopHouseholdView,
): HouseholdViewState {
  if (view.list_seq < state.seq) return state;
  const refs = new Set(view.entries.map((entry) => entry.ref));
  const place = state.notice?.place ?? null;
  return {
    ...state,
    view,
    seq: view.list_seq,
    // 確かめている行が消えたら確かめをしまう。
    confirming:
      state.confirming !== null && refs.has(state.confirming)
        ? state.confirming
        : null,
    // 消えた行の警告は捨てる（削除の成功の知らせは欄の頭に出す）。
    notice:
      state.notice !== null &&
      place !== null &&
      !refs.has(place) &&
      state.notice.tone === 'warning'
        ? null
        : state.notice,
  };
}

export function applyViewResponse(
  state: HouseholdViewState,
  response: DesktopIpcResponse,
): HouseholdViewState {
  const reading = { ...state, reading: false };
  if (response.outcome === 'rejected') {
    // 後から始めた読み取りに追い越された: その読み取りの結果を待つ（知らせを出さず、読み込み中のまま）。
    if (response.reason === 'list_superseded') return state;
    return {
      ...reading,
      notice: {
        tone: 'warning',
        text: householdFailureText('view', response.reason),
        place: null,
      },
    };
  }
  if (!('household' in response)) return reading;
  return withView(reading, response.household);
}

const SUCCESS_TEXT: Readonly<
  Record<'category' | 'delete' | 'intake' | 'budget', string>
> = {
  budget: '予算を保存しました。',
  intake: '取り込みの設定を変えました。',
  category:
    '分類を変えました。店名のある記録は、同じ店の次の未分類の利用にもこの分類を使います。',
  delete: '記録を削除しました。',
};

export function applyChangeResponse(
  state: HouseholdViewState,
  kind: 'category' | 'delete' | 'intake' | 'budget',
  place: string,
  response: DesktopIpcResponse,
): HouseholdViewState {
  const idle = {
    ...state,
    busy: state.busy === place ? null : state.busy,
    confirming: kind === 'delete' ? null : state.confirming,
  };
  if (response.outcome === 'rejected')
    return {
      ...idle,
      notice: {
        tone: 'warning',
        text: householdFailureText(kind, response.reason),
        place,
      },
    };
  if (!('household' in response)) return idle;
  return withView(
    {
      ...idle,
      notice: {
        tone: 'success',
        text: SUCCESS_TEXT[kind],
        // 削除した行は消えるので、欄の頭に出す。
        place: kind === 'delete' ? null : place,
      },
    },
    response.household,
  );
}

export function applyFailure(
  state: HouseholdViewState,
  place: string | null,
): HouseholdViewState {
  return {
    ...state,
    reading: place === null ? false : state.reading,
    busy: place !== null && state.busy === place ? null : state.busy,
    notice: { tone: 'warning', text: HOUSEHOLD_IPC_FAILURE_MESSAGE, place },
  };
}

export function canChange(
  state: HouseholdViewState,
  entry: DesktopHouseholdEntry,
): boolean {
  return state.busy === null && !entry.delivery_unknown;
}

// --- 操作 ---

export interface HouseholdActions {
  // 今出している月を読み直す（まだ出していなければ今月）。
  readonly refresh: () => void;
  readonly selectMonth: (month: string) => void;
  readonly changeCategory: (ref: string, category: HouseholdCategoryId) => void;
  readonly startDelete: (ref: string) => void;
  readonly cancelDelete: () => void;
  readonly confirmDelete: () => void;
  // 利用通知の取り込みを止める・再開する（ADR 0163）。
  readonly setIntake: (mailIntake: 'on' | 'off') => void;
  // 書き出しを取り込む（ADR 0164）。ファイルは main が OS のファイル選択で本人に選ばせる。
  readonly importExport: () => void;
  // 予算の入力欄を出す・しまう・保存する（ADR 0166）。
  readonly startBudget: () => void;
  readonly cancelBudget: () => void;
  readonly saveBudget: (
    items: readonly { category: HouseholdCategoryId; budget_yen: number }[],
  ) => void;
}

export interface HouseholdApi {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
}

// 読み直しで今の値を見せる拒否（main も読み直しを始めている）。
const REREAD: ReadonlySet<RejectReason> = new Set([
  'preview_stale',
  'entry_not_found',
  'outcome_unknown',
  'core_rejected',
]);

// 表示の権限の世代を持ち、世代をまたいだ応答（ロック・切断の前に送った要求の遅い応答）は反映しない。
export class HouseholdStore {
  readonly #api: HouseholdApi;
  readonly #listeners = new Set<() => void>();
  #state: HouseholdViewState = INITIAL_HOUSEHOLD_STATE;
  #epoch = 0;
  readonly actions: HouseholdActions;

  constructor(api: HouseholdApi) {
    this.#api = api;
    this.actions = {
      refresh: () => this.#show(this.#state.view?.month ?? null),
      selectMonth: (month) => this.#show(month),
      changeCategory: (ref, category) => this.#category(ref, category),
      startDelete: (ref) => {
        if (this.#state.busy !== null) return;
        this.#set({ ...this.#state, confirming: ref, notice: null });
      },
      cancelDelete: () => this.#set({ ...this.#state, confirming: null }),
      confirmDelete: () => this.#delete(),
      setIntake: (mailIntake) => this.#intake(mailIntake),
      importExport: () => this.#importExport(),
      startBudget: () => {
        if ((this.#state.view?.budget ?? null) === null) return;
        this.#set({ ...this.#state, editingBudget: true, notice: null });
      },
      cancelBudget: () => this.#set({ ...this.#state, editingBudget: false }),
      saveBudget: (items) => this.#saveBudget(items),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): HouseholdViewState => this.#state;

  #set(next: HouseholdViewState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #send(
    built: DesktopIpcRequest,
    onResponse: (
      state: HouseholdViewState,
      response: DesktopIpcResponse,
    ) => HouseholdViewState,
    onFailure: (state: HouseholdViewState) => HouseholdViewState,
  ): Promise<void> {
    const epoch = this.#epoch;
    const apply = (
      change: (prev: HouseholdViewState) => HouseholdViewState,
    ) => {
      if (epoch !== this.#epoch) return;
      this.#set(change(this.#state));
    };
    return this.#api.invoke(built).then(
      (response) => apply((prev) => onResponse(prev, response)),
      () => apply(onFailure),
    );
  }

  #show(month: string | null): void {
    this.#set({
      ...this.#state,
      reading: true,
      notice: null,
      confirming: null,
    });
    void this.#send(
      request('desktop.household_view', { month }),
      applyViewResponse,
      (state) => applyFailure(state, null),
    );
  }

  #category(ref: string, category: HouseholdCategoryId): void {
    const entry = this.#state.view?.entries.find((item) => item.ref === ref);
    if (entry === undefined || !canChange(this.#state, entry)) return;
    if (entry.category === category) return;
    this.#set({ ...this.#state, busy: ref, notice: null, confirming: null });
    this.#change(
      'category',
      ref,
      request('desktop.household_category', { ref, category }),
    );
  }

  #intake(mailIntake: 'on' | 'off'): void {
    const current = this.#state.view?.mail_intake ?? null;
    if (this.#state.busy !== null || current === null || current === mailIntake)
      return;
    this.#set({
      ...this.#state,
      busy: INTAKE_PLACE,
      notice: null,
      confirming: null,
    });
    this.#change(
      'intake',
      INTAKE_PLACE,
      request('desktop.household_intake', { mail_intake: mailIntake }),
    );
  }

  #saveBudget(
    items: readonly { category: HouseholdCategoryId; budget_yen: number }[],
  ): void {
    if (this.#state.busy !== null || !this.#state.editingBudget) return;
    this.#set({ ...this.#state, busy: BUDGET_PLACE, notice: null });
    const epoch = this.#epoch;
    let reread = false;
    void this.#send(
      request('desktop.household_budget', {
        // 契約の上限（18 個）は生成型では組の型になるので、分類の数で守っている一覧をその型として渡す。
        items: [...items] as BudgetPayload['items'],
      }),
      (state, response) => {
        reread = response.outcome === 'rejected' && REREAD.has(response.reason);
        const next = applyChangeResponse(
          state,
          'budget',
          BUDGET_PLACE,
          response,
        );
        // 保存できたら入力欄をしまう。拒否なら残して直させる。
        return response.outcome === 'ok'
          ? { ...next, editingBudget: false }
          : next;
      },
      (state) => applyFailure(state, BUDGET_PLACE),
    ).then(() => {
      if (reread && epoch === this.#epoch) this.#reread();
    });
  }

  #importExport(): void {
    if (this.#state.busy !== null || this.#state.view === null) return;
    this.#set({
      ...this.#state,
      busy: IMPORT_PLACE,
      notice: null,
      confirming: null,
    });
    void this.#send(
      request('desktop.household_import', null),
      (state, response) => {
        const idle = {
          ...state,
          busy: state.busy === IMPORT_PLACE ? null : state.busy,
        };
        if (response.outcome === 'rejected')
          return {
            ...idle,
            notice: {
              tone: 'warning' as const,
              text: householdFailureText('import', response.reason),
              place: IMPORT_PLACE,
            },
          };
        return 'household' in response
          ? withView(idle, response.household)
          : idle;
      },
      (state) => applyFailure(state, IMPORT_PLACE),
    );
  }

  // 送った変更・削除の結果を反映し、拒否なら（main が読み直した）値を受け取る。
  #change(
    kind: 'category' | 'delete' | 'intake' | 'budget',
    ref: string,
    built: DesktopIpcRequest,
  ) {
    const epoch = this.#epoch;
    let reread = false;
    void this.#send(
      built,
      (state, response) => {
        reread = response.outcome === 'rejected' && REREAD.has(response.reason);
        return applyChangeResponse(state, kind, ref, response);
      },
      (state) => applyFailure(state, ref),
    ).then(() => {
      if (reread && epoch === this.#epoch) this.#reread();
    });
  }

  // 知らせを残したまま、今出している月だけを読み直す。
  #reread(): void {
    void this.#send(
      request('desktop.household_view', {
        month: this.#state.view?.month ?? null,
      }),
      (state, response) =>
        response.outcome === 'ok' && 'household' in response
          ? withView(state, response.household)
          : state,
      (state) => state,
    );
  }

  #delete(): void {
    const ref = this.#state.confirming;
    if (ref === null || this.#state.busy !== null) return;
    this.#set({ ...this.#state, busy: ref, notice: null });
    this.#change('delete', ref, request('desktop.household_delete', { ref }));
  }

  // 出せなくなった（ロック・切断）: 世代を進めて内容を捨てる。
  hide(): void {
    this.#epoch += 1;
    this.#set(INITIAL_HOUSEHOLD_STATE);
  }
}
