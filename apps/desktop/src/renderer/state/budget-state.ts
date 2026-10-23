// 予算の確認（超過枠の承認・M 超過の確認・不明な費用の手での精算）の画面の状態と、操作から送る要求（B07-05、ADR 0039）。
// React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。受付の規則・参照の解決・OS の確認ダイアログは main が
// 持つ。画面が持つのは main が作った参照（ref）と、表示用の金額・枠・予算月・期限だけで、承認 ID・予算の要求 ID・予約 ID・
// 予約の版は来ない。説明の文章は置かず、金額・枠・期限の並べ方（レイアウト）で伝える。理由のコード・API の名前は出さない。
import type {
  DesktopBudgetEntry,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import {
  amountFromDecimal,
  budgetOriginLabel,
  budgetPoolLabel,
  formatMoney,
} from '@buddy/domain';
import { request } from '../desktop-api.js';
import { clockOf } from '../format.js';
import { REJECT_MESSAGES } from '../labels.js';

type Channel = DesktopIpcRequest['channel'];
type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];

export const BUDGET_CHANNELS: readonly Channel[] = [
  'desktop.budget_overage_decide',
  'desktop.budget_overrun_review',
  'desktop.budget_manual_settle',
];

export const BUDGET_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

// --- 文言（見出しとボタンの名前。説明の文章は置かない） ---

export const BUDGET_LABELS = {
  section: '予算の確認',
  kindOverage: '超過枠の承認',
  kindOverrun: 'M 超過',
  kindManual: '不明な費用',
  maxLiability: '最大負担',
  overageRemaining: '超過枠の残り',
  actual: '実費',
  over: '超過',
  month: '予算月',
  reconciliation: '照合 ID',
  actualInput: '実費',
  approve: '承認する',
  reject: '見送る',
  review: '確認する',
  settle: '精算する',
  busy: '送っています…',
  unknown: '結果不明',
  expired: '期限切れ',
  // 欄の初期値。manual: に続けて入力する。
  reconciliationPrefix: 'manual:',
} as const;

export const KIND_LABELS: Readonly<Record<DesktopBudgetEntry['kind'], string>> =
  {
    overage_approval: BUDGET_LABELS.kindOverage,
    overrun_review: BUDGET_LABELS.kindOverrun,
    manual_settlement: BUDGET_LABELS.kindManual,
  };

// --- 表示の値 ---

export interface BudgetBar {
  // 帯の全体を 100 として、最大負担の分・超過した分（M 超過のとき）の割合（整数の %）。
  readonly base: number;
  readonly overflow: number;
}

const NB = ' ';

const clampPercent = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(value)));

// 割合は表示の目安だけ（金額の判定には使わない）。BigInt の割り算の後に数にする（桁あふれを避ける）。
function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 100;
  return Number((numerator * 10_000n) / denominator) / 100;
}

// 超過枠の承認: 帯の全体は超過枠の残り。最大負担が占める割合を塗る（残りに収まらなければ全体）。
// M 超過の確認: 帯の全体は実費。最大負担の分を base、超えた分を overflow にする。
// 手での精算: 帯なし（null）。
export function budgetBar(entry: DesktopBudgetEntry): BudgetBar | null {
  if (entry.kind === 'overage_approval' && entry.overage_remaining !== null)
    return {
      base: clampPercent(
        ratio(
          BigInt(entry.max_liability.amount),
          BigInt(entry.overage_remaining.amount),
        ),
      ),
      overflow: 0,
    };
  if (entry.kind === 'overrun_review' && entry.actual_gross !== null) {
    const actual = BigInt(entry.actual_gross.amount);
    const max = BigInt(entry.max_liability.amount);
    const base = clampPercent(ratio(max, actual));
    return { base, overflow: 100 - base };
  }
  return null;
}

// M 超過の超過額（実費 − M）。超えていなければ null。
export function overAmount(entry: DesktopBudgetEntry) {
  if (entry.actual_gross === null) return null;
  const over =
    BigInt(entry.actual_gross.amount) - BigInt(entry.max_liability.amount);
  return over > 0n
    ? { currency: entry.actual_gross.currency, amount: over.toString() }
    : null;
}

// 承認の期限の書き方（「09:10 まで」。過ぎていれば「期限切れ」）。
export function expiryText(
  entry: DesktopBudgetEntry,
  now: number,
): string | null {
  if (entry.expires_at === null) return null;
  if (Date.parse(entry.expires_at) <= now) return BUDGET_LABELS.expired;
  return `${clockOf(entry.expires_at, now, { seconds: false })}${NB}まで`;
}

export function entryExpired(entry: DesktopBudgetEntry, now: number): boolean {
  return entry.expires_at !== null && Date.parse(entry.expires_at) <= now;
}

export const moneyText = formatMoney;

// 枠の表示名（内部の ID は出さない。対応表にない枠は「別の枠」）。
export const poolText = (entry: DesktopBudgetEntry): string =>
  budgetPoolLabel(entry.pool_id);

// 対象が発生した日時（「10/15 09:00」。端末の地域時間。中枢が記録していなければ null）。
export function occurredText(entry: DesktopBudgetEntry): string | null {
  return entry.occurred_at === null
    ? null
    : clockOf(entry.occurred_at, 0, { seconds: false, date: true });
}

// 用途（処理の起点）の表示名。
export const originText = (entry: DesktopBudgetEntry): string | null =>
  entry.origin === null ? null : budgetOriginLabel(entry.origin);

// 手での精算の入力（照合 ID と実費）。
export interface ManualInput {
  readonly reconciliationId: string;
  readonly amount: string;
}

export const INITIAL_MANUAL_INPUT: ManualInput = {
  reconciliationId: BUDGET_LABELS.reconciliationPrefix,
  amount: '',
};

const RECONCILIATION_ID = /^manual:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface ManualProblems {
  readonly reconciliationId: string | null;
  readonly amount: string | null;
}

// 入力の問題（なければ null）。照合 ID は manual: に続く英数字と . _ -（メールアドレス・氏名・自由文を入れない）。
export function manualProblems(input: ManualInput): ManualProblems {
  return {
    reconciliationId: RECONCILIATION_ID.test(input.reconciliationId.trim())
      ? null
      : `「${BUDGET_LABELS.reconciliationPrefix}」に続けて、英数字と「.」「_」「-」で入力してください。`,
    amount:
      amountFromDecimal(input.amount) === null
        ? `数字で入力してください（小数は 6${NB}桁まで）。`
        : null,
  };
}

export function manualReady(input: ManualInput): boolean {
  const problems = manualProblems(input);
  return problems.reconciliationId === null && problems.amount === null;
}

// --- 状態 ---

export interface BudgetNotice {
  readonly tone: 'warning' | 'success';
  readonly text: string;
}

export interface BudgetViewState {
  // 項目ごとの結果の文言（行のすぐ下に出す）。キーは参照。
  readonly notices: Readonly<Record<string, BudgetNotice>>;
  // 送って結果を待っている項目の参照（OS の確認ダイアログを表示している間も含む）。
  readonly busy: readonly string[];
  // 手での精算の入力（項目ごと）。送れなかったときも入力を残す。
  readonly inputs: Readonly<Record<string, ManualInput>>;
  // 精算を送ろうとして入力に問題があった項目（問題の文言を出す）。
  readonly checked: readonly string[];
}

export const INITIAL_BUDGET_STATE: BudgetViewState = {
  notices: {},
  busy: [],
  inputs: {},
  checked: [],
};

// ロック・切断・接続待ちで内容を捨てる（ロック中は内容を隠す）。
export function forgetBudget(): BudgetViewState {
  return INITIAL_BUDGET_STATE;
}

const warn = (text: string): BudgetNotice => ({ tone: 'warning', text });

export function budgetFailureText(
  channel: Channel,
  reason: RejectReason,
  decision: 'approve' | 'reject' = 'approve',
): string {
  switch (reason) {
    case 'confirmation_declined':
      return channel === 'desktop.budget_manual_settle'
        ? '確認でやめたため、精算していません。'
        : channel === 'desktop.budget_overrun_review'
          ? '確認でやめたため、確認していません。'
          : '確認でやめたため、承認していません。';
    case 'preview_stale':
      return '内容が変わりました。表示が更新されたら、もう一度確かめてください。';
    case 'core_rejected':
      return decision === 'reject' &&
        channel === 'desktop.budget_overage_decide'
        ? '見送れませんでした。表示が更新されるまで、お待ちください。'
        : '中枢が受け付けませんでした。表示が更新されるまで、お待ちください。';
    case 'outcome_unknown':
      return '結果を確かめられませんでした。自動では送り直しません。表示が更新されるまで、お待ちください。';
    default:
      return REJECT_MESSAGES[reason];
  }
}

function withoutNotice(
  notices: Readonly<Record<string, BudgetNotice>>,
  ref: string,
): Record<string, BudgetNotice> {
  const rest = { ...notices };
  delete rest[ref];
  return rest;
}

export function markBusy(state: BudgetViewState, ref: string): BudgetViewState {
  return {
    ...state,
    busy: [...state.busy.filter((item) => item !== ref), ref],
    notices: withoutNotice(state.notices, ref),
  };
}

const SUCCESS_TEXT: Readonly<Record<string, string>> = {
  'desktop.budget_overage_decide:approve': '承認しました。',
  'desktop.budget_overage_decide:reject': '見送りました。',
  'desktop.budget_overrun_review:approve': '確認しました。',
  'desktop.budget_manual_settle:approve': '精算しました。',
};

export function applyBudgetResponse(
  state: BudgetViewState,
  ref: string,
  channel: Channel,
  decision: 'approve' | 'reject',
  response: DesktopIpcResponse,
): BudgetViewState {
  const busy = state.busy.filter((item) => item !== ref);
  if (response.outcome === 'rejected')
    return {
      ...state,
      busy,
      notices: {
        ...state.notices,
        [ref]: warn(budgetFailureText(channel, response.reason, decision)),
      },
    };
  // 受け付けた（中枢が記録した）。項目は次の読み取りで一覧から消える。入力は捨てる。
  const inputs = { ...state.inputs };
  delete inputs[ref];
  return {
    ...state,
    busy,
    inputs,
    checked: state.checked.filter((item) => item !== ref),
    notices: {
      ...state.notices,
      [ref]: {
        tone: 'success',
        text: SUCCESS_TEXT[`${channel}:${decision}`] ?? '送りました。',
      },
    },
  };
}

export function applyBudgetFailure(
  state: BudgetViewState,
  ref: string,
): BudgetViewState {
  return {
    ...state,
    busy: state.busy.filter((item) => item !== ref),
    notices: { ...state.notices, [ref]: warn(BUDGET_IPC_FAILURE_MESSAGE) },
  };
}

export function inputOf(state: BudgetViewState, ref: string): ManualInput {
  return state.inputs[ref] ?? INITIAL_MANUAL_INPUT;
}

export function setManualInput(
  state: BudgetViewState,
  ref: string,
  change: Partial<ManualInput>,
): BudgetViewState {
  return {
    ...state,
    inputs: { ...state.inputs, [ref]: { ...inputOf(state, ref), ...change } },
    notices: withoutNotice(state.notices, ref),
  };
}

export function markChecked(
  state: BudgetViewState,
  ref: string,
): BudgetViewState {
  return state.checked.includes(ref)
    ? state
    : { ...state, checked: [...state.checked, ref] };
}

// 項目の一覧が変わったとき、なくなった項目の文言・入力・送信中を捨てる。
export function syncBudget(
  state: BudgetViewState,
  items: readonly DesktopBudgetEntry[],
): BudgetViewState {
  const refs = new Set(items.map((entry) => entry.ref));
  const keep = (ref: string) => refs.has(ref);
  const notices = Object.entries(state.notices).filter(([ref]) => keep(ref));
  const inputs = Object.entries(state.inputs).filter(([ref]) => keep(ref));
  const busy = state.busy.filter(keep);
  const checked = state.checked.filter(keep);
  if (
    notices.length === Object.keys(state.notices).length &&
    inputs.length === Object.keys(state.inputs).length &&
    busy.length === state.busy.length &&
    checked.length === state.checked.length
  )
    return state;
  return {
    notices: Object.fromEntries(notices),
    inputs: Object.fromEntries(inputs),
    busy,
    checked,
  };
}

// --- 送る要求 ---

export interface BudgetActions {
  readonly decide: (ref: string, decision: 'approve' | 'reject') => void;
  readonly review: (ref: string) => void;
  readonly settle: (ref: string) => void;
  readonly setReconciliationId: (ref: string, value: string) => void;
  readonly setAmount: (ref: string, value: string) => void;
}

export interface BudgetSink {
  readonly state: () => BudgetViewState;
  readonly send: (
    built: DesktopIpcRequest,
    onResponse: (
      state: BudgetViewState,
      response: DesktopIpcResponse,
    ) => BudgetViewState,
    onFailure: (state: BudgetViewState) => BudgetViewState,
    before: (state: BudgetViewState) => BudgetViewState,
  ) => void;
  readonly update: (
    change: (state: BudgetViewState) => BudgetViewState,
  ) => void;
}

export function budgetActions(sink: BudgetSink): BudgetActions {
  const send = (
    built: DesktopIpcRequest,
    ref: string,
    decision: 'approve' | 'reject',
  ) =>
    sink.send(
      built,
      (state, response) =>
        applyBudgetResponse(state, ref, built.channel, decision, response),
      (state) => applyBudgetFailure(state, ref),
      (state) => markBusy(state, ref),
    );
  return {
    decide: (ref, decision) => {
      if (sink.state().busy.includes(ref)) return;
      send(
        request('desktop.budget_overage_decide', { ref, decision }),
        ref,
        decision,
      );
    },
    review: (ref) => {
      if (sink.state().busy.includes(ref)) return;
      send(request('desktop.budget_overrun_review', { ref }), ref, 'approve');
    },
    settle: (ref) => {
      const current = sink.state();
      if (current.busy.includes(ref)) return;
      const input = inputOf(current, ref);
      const amount = amountFromDecimal(input.amount);
      if (!manualReady(input) || amount === null) {
        // 問題の文言を出し、入力は残す。
        sink.update((state) => markChecked(state, ref));
        return;
      }
      send(
        request('desktop.budget_manual_settle', {
          ref,
          reconciliation_id: input.reconciliationId.trim(),
          actual_amount: amount,
        }),
        ref,
        'approve',
      );
    },
    setReconciliationId: (ref, value) =>
      sink.update((state) =>
        setManualInput(state, ref, { reconciliationId: value }),
      ),
    setAmount: (ref, value) =>
      sink.update((state) => setManualInput(state, ref, { amount: value })),
  };
}

// --- 状態の持ち主（React に依存しない。フックはこれを購読するだけ） ---

export interface BudgetApi {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
}

// 表示の権限の世代を持ち、世代をまたいだ応答（ロック・切断・接続待ちの前に送った要求の遅い応答）は反映しない。
export class BudgetStore {
  readonly #api: BudgetApi;
  readonly #listeners = new Set<() => void>();
  #state: BudgetViewState = INITIAL_BUDGET_STATE;
  #epoch = 0;
  readonly actions: BudgetActions;

  constructor(api: BudgetApi) {
    this.#api = api;
    this.actions = budgetActions({
      state: () => this.#state,
      update: (change) => this.#set(change(this.#state)),
      send: (built, onResponse, onFailure, before) => {
        const epoch = this.#epoch;
        this.#set(before(this.#state));
        const apply = (change: (prev: BudgetViewState) => BudgetViewState) => {
          if (epoch !== this.#epoch) return;
          this.#set(change(this.#state));
        };
        this.#api.invoke(built).then(
          (response) => apply((prev) => onResponse(prev, response)),
          () => apply(onFailure),
        );
      },
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): BudgetViewState => this.#state;

  #set(next: BudgetViewState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  // 出せなくなった（ロック・切断・接続待ち）: 世代を進めて内容を捨てる。
  hide(): void {
    this.#epoch += 1;
    this.#set(forgetBudget());
  }

  sync(items: readonly DesktopBudgetEntry[]): void {
    this.#set(syncBudget(this.#state, items));
  }
}
