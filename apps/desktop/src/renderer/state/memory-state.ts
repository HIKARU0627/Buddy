// 忘却の画面の状態と、操作から送る要求（UI-10、Issue #180。設計 03 忘却と再取り込み、ADR 0040・0054・0180・0183）。
// React と DOM に依存しない純粋な関数と状態の持ち主を置き、node:test で試験する。
// - 計画は中枢が作る。画面は計画を見せて確認を返すだけ。記憶 ID・計画 ID・台帳の世代の照合は main と中枢が持ち、画面に来るのは
//   main の参照（ref）と表示用の値だけ。
// - 忘却の公開ゲートが閉じている・中枢が 503 を返した間は、計画・実行の操作を「まだ使えません」と分かる形で無効にする
//   （ADR 0024 の約束 7「押せないボタンは置かない」の例外。理由を同じ欄に出す。ADR 0183）。
// - 実行は確認の帯の中のボタンだけから送る。main が OS の確認ダイアログを 1 回出す。計画の後に変わった（preview_stale）は
//   計画を作り直させ、自動では作り直さない。結果が分からない（outcome_unknown）は「消えたかもしれない」と見せ、自動では送り直さない。
// - 保存してよい記憶の種類の設定（ADR 0191）: 種類ごとの選択を変えたら、変えた後の種類の全部と、見ている設定の参照をすぐ
//   送る（版は main が持つ）。別の画面で変わった・結果が分からないときは送り直さず、一覧と設定を読み直し、読み直しが終わる
//   まで選択を押せないままにする（古い表示から作った全部を新しい版で送らない。ADR 0191 の見直し）。
// 理由のコード・API の名前・「世代」の語は画面に出さない。
import type {
  DesktopForgetPlanView,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopMemoryEntry,
  DesktopMemoryView,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';

type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];

export const MEMORY_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

const NB = ' ';
const count = (n: number): string => `${n}${NB}件`;

// --- 文言 ---

export const MEMORY_LABELS = {
  section: '記憶と忘却',
  refresh: '読み直す',
  reading: '読み込んでいます…',
  lastFetched: '最終取得',
  listTitle: '記憶の一覧',
  planTitle: '忘却の計画',
  bandTitle: '忘却の確認',
  empty: '保存している記憶はありません。',
  makePlan: '忘却の計画を作る',
  planning: '計画を作っています…',
  removed: '消える物',
  directives: '消える指示',
  kept: '残る物',
  execute: '忘れる（確認へ）',
  executing: '忘れています…',
  dismiss: '計画をしまう',
  reviewPending: '見直し待ち',
  planNone:
    '左の一覧で記憶を選び、「忘却の計画を作る」を押すと、ここに消える物と残る物が出ます。計画を作っても、まだ何も消えません。',
  noDirectives: '消える指示はありません。',
  directivesLead:
    'この記憶の元の発言から作った、本人の指示です。忘れると、これらの指示も消えます。',
  directiveUnreadable: '本文を読めない指示',
  directiveUnreadableBody:
    '中枢がこの指示の本文を開けませんでした。忘れると、この指示も一緒に消えます。',
  noKept: '残る物はありません。',
  truncated: '記憶が多いため、新しい順に 1000 件だけを出しています。',
  closed:
    '忘却はまだ使えません。中枢で忘却の受付が開くまで、記憶を見ることだけができます。',
  unavailable:
    '中枢が今は忘却を受け付けていません。何も消していません。時間をおいて「読み直す」を押してください。',
  forgotten: '記憶を忘れました。',
  unknownTitle: '消えたかもしれません',
  unknownBody:
    '忘却の結果を確かめられませんでした。自動では送り直しません。「読み直す」で、記憶が一覧に残っているかを確かめてください。',
  expired: '計画の期限が過ぎました。「忘却の計画を作る」で作り直してください。',
} as const;

// 保存してよい記憶の種類の欄（ADR 0191）。
export const MEMORY_SETTINGS_LABELS = {
  section: '保存してよい記憶の種類',
  lead: 'ここで選んだ種類だけを、記憶として保存します。「〇〇を覚えて」と頼んだときも、選んでいない種類は保存しません。',
  none: '今は何も選んでいないので、記憶は保存しません。',
  some: (n: number) => `今は${NB}${n}${NB}種類を保存します。`,
  keep: '選ぶのをやめても、保存済みの記憶は消えません。忘れるときは、下の「記憶と忘却」の欄を使います。',
  changing: '変えています…',
  unread:
    '保存してよい記憶の種類を、まだ中枢から読めていません。「記憶と忘却」の欄の「読み直す」を押してください。',
  listLabel: '保存してよい記憶の種類',
} as const;

// 種類ごとの説明（どんなことを覚えるか。ADR 0191 の暫定の言い方。U491）。
export const MEMORY_KIND_DESCRIPTIONS: Readonly<
  Record<DesktopMemoryEntry['kind'], string>
> = {
  preference: '好きなもの・苦手なもの・返事の長さなど',
  goal: '達成したいこと・続けたいこと',
  person: '家族・友人・仕事の相手についてのこと',
  routine: '毎日・毎週のように繰り返すこと',
  lexicon: '呼び方・言い回し・略語の意味',
  progress: '学習や作業がどこまで進んだか',
};

export const MEMORY_KIND_LABELS: Readonly<
  Record<DesktopMemoryEntry['kind'], string>
> = {
  preference: '好み',
  goal: '目標',
  person: '人',
  routine: '習慣',
  lexicon: '言葉の使い方',
  progress: '進み具合',
};

// 見出しの順（一覧の行は、この順の見出しの下に保存の新しい順で並べる）。
export const MEMORY_KIND_ORDER: readonly DesktopMemoryEntry['kind'][] = [
  'preference',
  'goal',
  'person',
  'routine',
  'lexicon',
  'progress',
];

export const ORIGIN_LABELS: Readonly<
  Record<DesktopMemoryEntry['origin'], string>
> = {
  explicit_request: '本人の依頼で保存',
  auto_extraction: '会話から自動で保存',
};

type RemovedKind = DesktopForgetPlanView['removed']['counts'][number]['kind'];

export const REMOVED_KIND_LABELS: Readonly<Record<RemovedKind, string>> = {
  intent_shadow: '解釈の記録',
  canvas_item: 'キャンバスの物',
  notification_candidate: '気づき',
  related_analysis: '関連の分析',
  request_entity: '依頼',
  async_guard: '後から届く結果の待ち',
  carried_summary: '引き継いだ要約',
  session_summary: '会話の要約',
  memory: '記憶',
  user_directive: '本人の指示',
  turn: '発言',
  source_item: '元の情報（メールなど）',
  operation_content: '操作の確定内容',
};

type DirectiveScope =
  DesktopForgetPlanView['removed']['directives'][number]['scope'];

// 消える指示の範囲（U433、ADR 0185）。
export const DIRECTIVE_SCOPE_LABELS: Readonly<Record<DirectiveScope, string>> =
  {
    from_now_on: '今後ずっと守る指示',
    this_time: 'この会話の間だけの指示',
  };

type KeptState = DesktopForgetPlanView['kept']['operation_states'][number];

export const KEPT_STATE_LABELS: Readonly<Record<KeptState, string>> = {
  awaiting_approval: '承認待ち',
  approved: '承認済み',
  preparing: '準備中',
  dispatching: '送出中',
  reconciling: '照合中',
  unknown_held: '結果不明で保留中',
  not_executed: '実行されなかった',
  unknown: '状態を確かめられない',
};

// --- 表示の値 ---

// 由来の件数の 1 行（「由来: 発言 1 件・元の情報 2 件」）。由来がどれも 0 なら null。
export function sourceText(entry: DesktopMemoryEntry): string | null {
  const parts: string[] = [];
  if (entry.source_counts.turn > 0)
    parts.push(`発言${NB}${count(entry.source_counts.turn)}`);
  if (entry.source_counts.source_item > 0)
    parts.push(`元の情報${NB}${count(entry.source_counts.source_item)}`);
  if (entry.source_counts.memory > 0)
    parts.push(`別の記憶${NB}${count(entry.source_counts.memory)}`);
  return parts.length === 0 ? null : `由来: ${parts.join('・')}`;
}

const pad = (value: number) => String(value).padStart(2, '0');
const dayOf = (utc: string): string | null => {
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1}/${date.getDate()}`;
};
const timeOf = (utc: string): string | null => {
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return null;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// 期限の 1 行。保存中は「見直し 12/30」、見直し待ちは「11/29 に削除（見直さなければ）」。
export function deadlineText(entry: DesktopMemoryEntry): string | null {
  if (entry.status === 'review_pending') {
    const day = entry.delete_at === null ? null : dayOf(entry.delete_at);
    return day === null ? null : `${day} に削除（見直さなければ）`;
  }
  const day = dayOf(entry.review_at);
  return day === null ? null : `見直し ${day}`;
}

// 種類の見出しの下に行を並べる（見出しは決まった順。行のない種類は出さない）。
export function groupByKind(
  entries: readonly DesktopMemoryEntry[],
): { kind: DesktopMemoryEntry['kind']; entries: DesktopMemoryEntry[] }[] {
  return MEMORY_KIND_ORDER.map((kind) => ({
    kind,
    entries: entries.filter((entry) => entry.kind === kind),
  })).filter((group) => group.entries.length > 0);
}

export function removedTotal(plan: DesktopForgetPlanView): number {
  let total = 0;
  for (const entry of plan.removed.counts) total += entry.count;
  return total;
}

// 消える物の種類ごとの行（「記憶 2 件」）。本人の指示は「消える指示」に分けて出すので除く。
export function removedLines(plan: DesktopForgetPlanView): string[] {
  return plan.removed.counts
    .filter((entry) => entry.kind !== 'user_directive')
    .map((entry) => `${REMOVED_KIND_LABELS[entry.kind]} ${count(entry.count)}`);
}

// 残る操作を状態ごとにまとめた行（「承認待ち 1 件」）。並びは KEPT_STATE_LABELS の順。
export function keptLines(plan: DesktopForgetPlanView): string[] {
  const order = Object.keys(KEPT_STATE_LABELS) as KeptState[];
  return order
    .map((state) => ({
      state,
      n: plan.kept.operation_states.filter((item) => item === state).length,
    }))
    .filter((item) => item.n > 0)
    .map((item) => `${KEPT_STATE_LABELS[item.state]}の操作 ${count(item.n)}`);
}

// 確認の帯の件数の 1 行。
export function bandSummary(plan: DesktopForgetPlanView): string {
  const memories =
    plan.removed.memory_refs.length + plan.removed.unlisted_memory_count;
  return `消える物 合計${NB}${count(removedTotal(plan))}（記憶${NB}${count(memories)}・指示${NB}${count(plan.removed.directives.length)}）`;
}

// 計画の時点の忘却の記録の数（台帳の世代。画面では「世代」と言わない）。
export function generationText(plan: DesktopForgetPlanView): string {
  return `この計画を作った時点で、これまでに忘れた回数: ${plan.forgetting_generation}${NB}回`;
}

// 計画の期限（「12:40 まで（残り 9 分）」）。過ぎていれば null。
export function expiryText(
  plan: DesktopForgetPlanView,
  now: number,
): string | null {
  const at = Date.parse(plan.expires_at);
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.ceil((at - now) / 60_000);
  return `${timeOf(plan.expires_at) ?? ''} まで（残り${NB}${minutes}${NB}分）`;
}

// --- 状態 ---

export const HEAD_PLACE = 'head';
export const PLAN_PLACE = 'plan';
export const BAND_PLACE = 'band';
// 保存してよい記憶の種類の欄（ADR 0191）。
export const SETTINGS_PLACE = 'settings';

export interface MemoryNotice {
  readonly tone: 'warning' | 'success';
  readonly text: string;
  // 出す場所。HEAD_PLACE は欄の頭、PLAN_PLACE は計画の欄、BAND_PLACE は確認の帯、それ以外は行の参照。
  readonly place: string;
}

export interface MemoryViewState {
  // null はまだ受け取っていない。
  readonly view: DesktopMemoryView | null;
  readonly seq: number;
  readonly reading: boolean;
  // 計画・実行を送って結果を待っている場所（行の参照か BAND_PLACE。二重に押させない）。
  readonly busy: string | null;
  readonly notice: MemoryNotice | null;
  // 中枢が計画・実行に 503 を返した（本人が「読み直す」を押すまで、忘却を使えないとして見せる）。
  readonly blocked: boolean;
  // 本人が「計画をしまう」を押した計画の参照（main の計画は使われないまま期限で消える）。
  readonly dismissed: string | null;
}

export const INITIAL_MEMORY_STATE: MemoryViewState = {
  view: null,
  seq: 0,
  reading: false,
  busy: null,
  notice: null,
  blocked: false,
  dismissed: null,
};

// 計画・実行の操作を使えるか（閉じている・使えない・読めていない間は使えない）。
export type ForgetAvailability = 'open' | 'closed' | 'unavailable';

export function forgetAvailability(state: MemoryViewState): ForgetAvailability {
  if (state.view === null || state.view.fetch === 'unavailable')
    return 'unavailable';
  if (state.blocked) return 'unavailable';
  return state.view.forget;
}

// 画面に出す計画（しまった計画は出さない）。
export function shownPlan(
  state: MemoryViewState,
): DesktopForgetPlanView | null {
  const plan = state.view?.plan ?? null;
  return plan === null || plan.ref === state.dismissed ? null : plan;
}

type Kind = 'list' | 'plan' | 'execute' | 'settings';

// 保存してよい記憶の種類の設定の変更が断られた・結果が分からないときの文（ADR 0191）。
function settingsFailureText(reason: RejectReason): string {
  switch (reason) {
    case 'preview_stale':
      return '設定がほかの画面で変わりました。今の設定を読み直したので、もう一度選んでください。';
    case 'outcome_unknown':
      return '設定を変えられたか確かめられませんでした。自動では送り直しません。今の設定を読み直しているので、表示を確かめてください。';
    case 'entry_not_found':
      return '今の設定を読めていないため、変えられません。「記憶と忘却」の欄の「読み直す」を押してください。';
    case 'confirmation_pending':
      return '前の変更を送っています。終わってから、もう一度選んでください。';
    case 'core_rejected':
      return '中枢が受け付けませんでした。設定は変わっていません。';
    case 'not_connected':
      return '中枢に接続していないため、設定を変えられません。';
    default:
      return REJECT_MESSAGES[reason];
  }
}

export function memoryFailureText(kind: Kind, reason: RejectReason): string {
  if (kind === 'settings') return settingsFailureText(reason);
  switch (reason) {
    case 'forget_unavailable':
      return MEMORY_LABELS.unavailable;
    case 'preview_stale':
      return kind === 'plan'
        ? 'この記憶はもう一覧にありません。一覧を読み直したので、今の記憶を確かめてください。'
        : '計画の後に、記憶か忘却の記録が変わりました。何も消していません。「忘却の計画を作る」で作り直して、もう一度確かめてください。';
    case 'outcome_unknown':
      return kind === 'execute'
        ? MEMORY_LABELS.unknownBody
        : '計画を受け取れませんでした。計画を作るだけでは何も消えません。もう一度「忘却の計画を作る」を押してください。';
    case 'confirmation_declined':
      return '忘却をやめました。何も消していません。';
    case 'confirmation_pending':
      return '別の確認を表示しています。その確認を閉じてから、もう一度押してください。';
    case 'entry_not_found':
      return '一覧が古くなっています。「読み直す」を押してから、もう一度操作してください。';
    case 'core_rejected':
      return '中枢が受け付けませんでした。何も消していません。一覧を読み直してから、もう一度操作してください。';
    case 'not_connected':
      return '中枢に接続していないため、記憶の一覧を読めません。接続してから「読み直す」を押してください。';
    default:
      return REJECT_MESSAGES[reason];
  }
}

function withView(
  state: MemoryViewState,
  view: DesktopMemoryView,
): MemoryViewState {
  if (view.list_seq < state.seq) return state;
  const refs = new Set(view.entries.map((entry) => entry.ref));
  const place = state.notice?.place ?? null;
  return {
    ...state,
    view,
    seq: view.list_seq,
    // 一覧から消えた行の警告は捨てる。
    notice:
      state.notice !== null &&
      place !== HEAD_PLACE &&
      place !== PLAN_PLACE &&
      place !== BAND_PLACE &&
      place !== SETTINGS_PLACE &&
      place !== null &&
      !refs.has(place)
        ? null
        : state.notice,
  };
}

export function applyListResponse(
  state: MemoryViewState,
  response: DesktopIpcResponse,
  manual: boolean,
): MemoryViewState {
  const reading = {
    ...state,
    reading: false,
    // 本人が読み直したときだけ、中枢の 503 で止めた状態を解く（中枢の今の値を見直す）。
    blocked: manual ? false : state.blocked,
  };
  if (response.outcome === 'rejected')
    return {
      ...reading,
      notice: {
        tone: 'warning',
        text: memoryFailureText('list', response.reason),
        place: HEAD_PLACE,
      },
    };
  if (!('memories' in response)) return reading;
  return withView(reading, response.memories);
}

export function applyPlanResponse(
  state: MemoryViewState,
  place: string,
  response: DesktopIpcResponse,
): MemoryViewState {
  const idle = { ...state, busy: state.busy === place ? null : state.busy };
  if (response.outcome === 'rejected')
    return {
      ...idle,
      blocked: response.reason === 'forget_unavailable' ? true : idle.blocked,
      notice: {
        tone: 'warning',
        text: memoryFailureText('plan', response.reason),
        place: response.reason === 'forget_unavailable' ? HEAD_PLACE : place,
      },
    };
  if (!('memories' in response)) return idle;
  return withView(
    { ...idle, dismissed: null, notice: null },
    response.memories,
  );
}

export function applyExecuteResponse(
  state: MemoryViewState,
  response: DesktopIpcResponse,
): MemoryViewState {
  const idle = {
    ...state,
    busy: state.busy === BAND_PLACE ? null : state.busy,
  };
  if (response.outcome === 'rejected')
    return {
      ...idle,
      blocked: response.reason === 'forget_unavailable' ? true : idle.blocked,
      notice: {
        tone: 'warning',
        text: memoryFailureText('execute', response.reason),
        // 計画を捨てた拒否は計画の欄に、計画が残る拒否（やめた・別の確認）は確認の帯に出す。
        place:
          response.reason === 'confirmation_declined' ||
          response.reason === 'confirmation_pending' ||
          response.reason === 'screen_operation_required'
            ? BAND_PLACE
            : response.reason === 'forget_unavailable'
              ? HEAD_PLACE
              : PLAN_PLACE,
      },
    };
  if (!('memories' in response)) return idle;
  return withView({ ...idle, notice: null }, response.memories);
}

// 読み直しが終わるまで選択を押せないままにする拒否（main が設定を読み直している）。
const SETTINGS_REREAD: ReadonlySet<RejectReason> = new Set([
  'preview_stale',
  'outcome_unknown',
]);

export function applySettingsResponse(
  state: MemoryViewState,
  response: DesktopIpcResponse,
): MemoryViewState {
  const idle = {
    ...state,
    busy: state.busy === SETTINGS_PLACE ? null : state.busy,
  };
  if (response.outcome === 'rejected')
    return {
      ...(SETTINGS_REREAD.has(response.reason) ? state : idle),
      notice: {
        tone: 'warning',
        text: memoryFailureText('settings', response.reason),
        place: SETTINGS_PLACE,
      },
    };
  if (!('memories' in response)) return idle;
  return withView({ ...idle, notice: null }, response.memories);
}

type MemoryKindName = DesktopMemoryEntry['kind'];
type AllowedKinds = Extract<
  DesktopIpcRequest,
  { channel: 'desktop.memory_settings_change' }
>['payload']['allowed_kinds'];

// 画面が見ている設定の参照（main が版ごとに付ける。読めていなければ null）。
export function settingsRefOf(state: MemoryViewState): string | null {
  return state.view?.settings?.ref ?? null;
}

// 中枢から読めた保存してよい種類（読めていなければ null）。
export function allowedKinds(
  state: MemoryViewState,
): readonly MemoryKindName[] | null {
  const settings = state.view?.settings ?? null;
  return settings === null
    ? null
    : (settings.allowed_kinds as readonly MemoryKindName[]);
}

// 種類 1 つの選択を変えた後の、保存してよい種類の全部（決まった順。ADR 0191）。
export function nextAllowedKinds(
  current: readonly DesktopMemoryEntry['kind'][],
  kind: DesktopMemoryEntry['kind'],
  allowed: boolean,
): DesktopMemoryEntry['kind'][] {
  return MEMORY_KIND_ORDER.filter((item) =>
    item === kind ? allowed : current.includes(item),
  );
}

export function applyFailure(
  state: MemoryViewState,
  place: string | null,
): MemoryViewState {
  return {
    ...state,
    reading: place === null ? false : state.reading,
    busy: place !== null && state.busy === place ? null : state.busy,
    notice: {
      tone: 'warning',
      text: MEMORY_IPC_FAILURE_MESSAGE,
      place: place ?? HEAD_PLACE,
    },
  };
}

// --- 操作 ---

export interface MemoryActions {
  readonly refresh: () => void;
  readonly plan: (ref: string) => void;
  readonly execute: () => void;
  readonly dismiss: () => void;
  // 保存してよい記憶の種類の選択を変える（ADR 0191）。
  readonly setKind: (
    kind: DesktopMemoryEntry['kind'],
    allowed: boolean,
  ) => void;
}

export interface MemoryApi {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
}

// 読み直して今の状態を見せる拒否（main は計画を捨てている）。forget_unavailable は読み直さない（中枢の 503 を画面の
// 状態に写したまま、本人の「読み直す」を待つ）。
const REREAD: ReadonlySet<RejectReason> = new Set([
  'preview_stale',
  'entry_not_found',
  'outcome_unknown',
  'core_rejected',
]);

// 表示の権限の世代を持ち、世代をまたいだ応答（ロック・切断の前に送った要求の遅い応答）は反映しない。
// 実行は確認の帯の「忘れる（確認へ）」からだけ送り、拒否・結果不明のときも自動では送り直さない。
export class MemoryStore {
  readonly #api: MemoryApi;
  readonly #listeners = new Set<() => void>();
  #state: MemoryViewState = INITIAL_MEMORY_STATE;
  #epoch = 0;
  readonly actions: MemoryActions;

  constructor(api: MemoryApi) {
    this.#api = api;
    this.actions = {
      refresh: () => this.#list(true),
      plan: (ref) => this.#plan(ref),
      execute: () => this.#execute(),
      dismiss: () => {
        const plan = shownPlan(this.#state);
        if (plan === null || this.#state.busy !== null) return;
        this.#set({ ...this.#state, dismissed: plan.ref, notice: null });
      },
      setKind: (kind, allowed) => this.#setKind(kind, allowed),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): MemoryViewState => this.#state;

  #set(next: MemoryViewState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #send(
    built: DesktopIpcRequest,
    onResponse: (
      state: MemoryViewState,
      response: DesktopIpcResponse,
    ) => MemoryViewState,
    onFailure: (state: MemoryViewState) => MemoryViewState,
  ): Promise<DesktopIpcResponse | null> {
    const epoch = this.#epoch;
    return this.#api.invoke(built).then(
      (response) => {
        if (epoch !== this.#epoch) return null;
        this.#set(onResponse(this.#state, response));
        return response;
      },
      () => {
        if (epoch === this.#epoch) this.#set(onFailure(this.#state));
        return null;
      },
    );
  }

  // 出せるようになったとき（manual = false）と、本人の「読み直す」（manual = true）。
  open(): void {
    this.#list(false);
  }

  #list(manual: boolean): void {
    this.#set({ ...this.#state, reading: true, notice: null });
    void this.#send(
      request('desktop.memories_list', null),
      (state, response) => applyListResponse(state, response, manual),
      (state) => applyFailure(state, null),
    );
  }

  // 文言を残したまま一覧だけを読み直す。
  #reread(): void {
    void this.#send(
      request('desktop.memories_list', null),
      (state, response) =>
        response.outcome === 'ok' && 'memories' in response
          ? withView(state, response.memories)
          : state,
      (state) => state,
    );
  }

  #plan(ref: string): void {
    if (this.#state.busy !== null) return;
    if (forgetAvailability(this.#state) !== 'open') return;
    const epoch = this.#epoch;
    this.#set({ ...this.#state, busy: ref, notice: null });
    void this.#send(
      request('desktop.forget_plan', { ref }),
      (state, response) => applyPlanResponse(state, ref, response),
      (state) => applyFailure(state, ref),
    ).then((response) => {
      if (
        response !== null &&
        response.outcome === 'rejected' &&
        REREAD.has(response.reason) &&
        epoch === this.#epoch
      )
        this.#reread();
    });
  }

  #execute(): void {
    const plan = shownPlan(this.#state);
    if (this.#state.busy !== null || plan === null) return;
    if (forgetAvailability(this.#state) !== 'open') return;
    const epoch = this.#epoch;
    this.#set({ ...this.#state, busy: BAND_PLACE, notice: null });
    void this.#send(
      request('desktop.forget_execute', { ref: plan.ref }),
      applyExecuteResponse,
      (state) => applyFailure(state, BAND_PLACE),
    ).then((response) => {
      if (
        response !== null &&
        response.outcome === 'rejected' &&
        REREAD.has(response.reason) &&
        epoch === this.#epoch
      )
        this.#reread();
    });
  }

  // 保存してよい記憶の種類の選択を変える。変えた後の種類の全部を送り、送っている間はほかの操作を止める。結果が分からない・
  // 別の画面で変わったときは送り直さない（main が今の設定を読み直す）。
  #setKind(kind: DesktopMemoryEntry['kind'], allowed: boolean): void {
    const current = allowedKinds(this.#state);
    const settingsRef = settingsRefOf(this.#state);
    if (this.#state.busy !== null || current === null || settingsRef === null)
      return;
    if (current.includes(kind) === allowed) return;
    const epoch = this.#epoch;
    this.#set({ ...this.#state, busy: SETTINGS_PLACE, notice: null });
    void this.#send(
      request('desktop.memory_settings_change', {
        settings_ref: settingsRef,
        allowed_kinds: nextAllowedKinds(current, kind, allowed) as AllowedKinds,
      }),
      applySettingsResponse,
      (state) => applyFailure(state, SETTINGS_PLACE),
    ).then((response) => {
      if (
        response !== null &&
        response.outcome === 'rejected' &&
        SETTINGS_REREAD.has(response.reason) &&
        epoch === this.#epoch
      )
        this.#rereadSettings();
    });
  }

  // 設定の変更が断られた・結果が分からなかった後の読み直し。読み直しが終わる（読めた・読めなかった）まで選択を押せないままにし、
  // 終わったら外す（文言は残す）。
  #rereadSettings(): void {
    const release = (state: MemoryViewState): MemoryViewState => ({
      ...state,
      busy: state.busy === SETTINGS_PLACE ? null : state.busy,
    });
    void this.#send(
      request('desktop.memories_list', null),
      (state, response) =>
        release(
          response.outcome === 'ok' && 'memories' in response
            ? withView(state, response.memories)
            : state,
        ),
      release,
    );
  }

  // 出せなくなった（ロック・切断）: 世代を進めて内容を捨てる。
  hide(): void {
    this.#epoch += 1;
    this.#set(INITIAL_MEMORY_STATE);
  }
}
