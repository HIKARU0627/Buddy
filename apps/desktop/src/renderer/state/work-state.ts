// 会話・変更の確認・処理状況の画面の状態と、操作から送る要求（B04-05、ADR 0024・0031）。
// React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。受付の規則・参照の解決・承認の確認（OS の
// ダイアログ）は main が持つ。画面が持つのは main が作った参照（ref・preview_ref）だけで、操作 ID・内容版・hash は来ない。
// 状態の文言の対応表（01 いつも見える状態、08 §3）は operationStatus。理由のコードや API の名前は出さない。
import type {
  DesktopConnectionView,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopOperationEntry,
  DesktopOperationPreview,
  DesktopTurnResult,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';
import type { StatusLine } from '../tones.js';

type Channel = DesktopIpcRequest['channel'];
type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];
export type ShownConnection = Extract<
  DesktopConnectionView,
  { visibility: 'shown' }
>;

export const WORK_CHANNELS: readonly Channel[] = [
  'desktop.turn_submit',
  'desktop.operation_preview',
  'desktop.operation_approve',
  'desktop.operation_cancel',
  'desktop.operation_reconcile',
];

export const WORK_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

// 1 回に送れる発言の長さ（契約の TurnRequest の上限）。
export const MAX_TURN_CHARS = 4_000;

// --- 操作の種類・変更先・項目の文言 ---

export const OPERATION_KIND_LABELS: Readonly<Record<string, string>> = {
  'mail.labels.change': 'メールのラベルの変更',
  'mail.draft.create': '返信の下書きの作成',
  'task.create': '用事の登録',
};

export const SERVICE_LABELS: Readonly<Record<string, string>> = {
  mock: '模擬のメール',
  gmail: 'Gmail',
  microsoft_graph: 'Microsoft のメール',
  buddy: 'Buddy の用事（中枢に保存）',
};

export const TARGET_LABELS: Readonly<Record<string, string>> = {
  'mail.labels.change': 'メール',
  'mail.draft.create': '返信元のメール',
  'task.create': '登録先の一覧',
};

// 変更の前後の 1 行（項目名・変更前・変更後）。変更前は、中枢が確かめた事実から言えることだけを書く
// （付けるラベルは付いていない・外すラベルは付いている。新しく作るものは「なし」）。
export interface ChangeRow {
  readonly field: DesktopOperationPreview['fields'][number]['field'];
  readonly name: string;
  readonly before: string;
  readonly after: string;
  // 本文のような長い文字（改行を保つ）。
  readonly long: boolean;
}

const JOIN = '、';

export function changeRows(preview: DesktopOperationPreview): ChangeRow[] {
  return preview.fields.map(({ field, values }) => {
    const joined = values.join(JOIN);
    switch (field) {
      case 'labels_add':
        return row(field, '付けるラベル', '付いていません', joined);
      case 'labels_remove':
        return row(field, '外すラベル', joined, '外します');
      case 'draft_to':
        return row(field, '宛先', 'なし', joined);
      case 'draft_cc':
        return row(field, 'Cc', 'なし', joined);
      case 'draft_subject':
        return row(field, '件名', 'なし', joined);
      case 'draft_body':
        return { ...row(field, '本文', 'なし', joined), long: true };
      case 'task_title':
        return row(field, '題名', 'なし', joined);
      case 'task_due':
        return row(field, '期限', 'なし', joined);
      case 'task_body':
        return { ...row(field, 'メモ', 'なし', joined), long: true };
    }
  });
}

function row(
  field: ChangeRow['field'],
  name: string,
  before: string,
  after: string,
): ChangeRow {
  return { field, name, before, after, long: false };
}

// 影響（設計 01 承認画面の必須内容）。種類ごとの決まった文で、モデルに作らせない。
export function impactLines(kind: string): string[] {
  const common =
    '承認すると、中枢がこの内容で実行します。取り消せるのは、実行の前だけです。';
  switch (kind) {
    case 'mail.labels.change':
      return [
        'このメールのラベルだけを変えます。本文・宛先は変わらず、メールは送りません。',
        common,
      ];
    case 'mail.draft.create':
      return ['下書きを作るだけです。メールは送りません。', common];
    case 'task.create':
      return [
        'Buddy の用事に登録するだけです。外部のサービスには何も送りません。',
        common,
      ];
    default:
      return [common];
  }
}

// --- 処理状況の文言の対応表 ---

export function operationStatus(entry: DesktopOperationEntry): StatusLine {
  if (entry.delivery_unknown)
    return {
      tone: 'warning',
      mark: 'warning',
      text: '命令が届いたか確かめられていません',
    };
  switch (entry.state) {
    case 'awaiting_approval':
      return {
        tone: 'warning',
        mark: 'circle',
        text:
          entry.approval_state === 'expired'
            ? '承認の期限が切れました'
            : entry.approval_state === 'revoked'
              ? '承認が取り消されました'
              : '承認待ち',
      };
    case 'approved':
      return {
        tone: 'neutral',
        mark: 'spinner',
        text: '承認しました。実行を待っています',
      };
    case 'preparing':
      return { tone: 'neutral', mark: 'spinner', text: '実行を準備しています' };
    case 'dispatching':
      return { tone: 'neutral', mark: 'spinner', text: '実行しています' };
    case 'reconciling':
      return {
        tone: 'neutral',
        mark: 'spinner',
        text: '結果を確認しています',
      };
    case 'succeeded':
      return { tone: 'success', mark: 'dot', text: '完了しました' };
    case 'unknown_held':
      return {
        tone: 'danger',
        mark: 'warning',
        text: '結果を確認できませんでした',
      };
    case 'not_executed':
      return { tone: 'neutral', mark: 'square', text: '実行されませんでした' };
    case 'cancelled':
      return { tone: 'neutral', mark: 'square', text: '取り消しました' };
    case 'superseded':
      return {
        tone: 'neutral',
        mark: 'square',
        text: '内容が更新されたため、この操作は使われません',
      };
  }
}

// 状態の補足（次に何をするか）。なければ null。
export function operationNote(entry: DesktopOperationEntry): string | null {
  if (entry.delivery_unknown)
    return '承認か取消が中枢に届いたか分かりません。自動では送り直しません。状態が更新されるまで、お待ちください。';
  switch (entry.state) {
    case 'awaiting_approval':
      return entry.approval_state === 'expired' ||
        entry.approval_state === 'revoked'
        ? '内容を確かめてから、もう一度承認してください。'
        : '内容を確かめてから承認してください。';
    case 'unknown_held':
      return '実行されたかどうか分かりません。自動では送り直しません。「照合」を押すと、相手の状態を読み取って確かめます（変更は増えません）。';
    case 'not_executed':
      return '変更は行われていません。';
    case 'succeeded':
      return null;
    default:
      return null;
  }
}

// 行に出す操作（allowed_actions は表示の補助で、実行時の認可は中枢が行う）。結果不明の保留中は出さない。
export interface EntryActions {
  readonly preview: boolean;
  readonly cancel: boolean;
  readonly reconcile: boolean;
}

export function entryActions(entry: DesktopOperationEntry): EntryActions {
  if (entry.delivery_unknown)
    return { preview: false, cancel: false, reconcile: false };
  const allowed = new Set<string>(entry.allowed_actions);
  return {
    preview:
      entry.state === 'awaiting_approval' &&
      (allowed.has('preview') || allowed.has('approve')),
    cancel: allowed.has('cancel'),
    reconcile: allowed.has('reconcile'),
  };
}

// 確認が要る（承認待ち）・処理中・終わった、の 3 つに分ける。終わったものは新しい順に最近の数件だけ出す。
export const FINISHED_SHOWN = 5;

export interface OperationGroups {
  readonly attention: readonly DesktopOperationEntry[];
  readonly running: readonly DesktopOperationEntry[];
  readonly finished: readonly DesktopOperationEntry[];
  readonly hiddenFinished: number;
}

export function groupOperations(
  operations: readonly DesktopOperationEntry[],
): OperationGroups {
  const attention: DesktopOperationEntry[] = [];
  const running: DesktopOperationEntry[] = [];
  const finished: DesktopOperationEntry[] = [];
  for (const entry of operations) {
    // 結果不明は、本人の対応（照合）が要るので「確認が必要」に入れる。
    if (
      entry.state === 'awaiting_approval' ||
      entry.state === 'unknown_held' ||
      entry.delivery_unknown
    )
      attention.push(entry);
    else if (
      entry.state === 'approved' ||
      entry.state === 'preparing' ||
      entry.state === 'dispatching' ||
      entry.state === 'reconciling'
    )
      running.push(entry);
    else finished.push(entry);
  }
  return {
    attention,
    running,
    finished: finished.slice(0, FINISHED_SHOWN),
    hiddenFinished: Math.max(0, finished.length - FINISHED_SHOWN),
  };
}

// --- 発言の結果の文言 ---

const NB = ' ';

// 予定の照会の結果の文（件数だけ。予定の本文を出す経路は B04 にはない）。
export function scheduleText(
  result: NonNullable<DesktopTurnResult['result']>,
): string {
  if (result.event_count === 0) return '予定はありません。';
  const parts = [`予定は${result.event_count}${NB}件あります。`];
  if (result.overlap_count > 0)
    parts.push(
      `そのうち${result.overlap_count}${NB}件は、時間が重なっています。`,
    );
  if (result.more_count > 0)
    parts.push(`ほか${result.more_count}${NB}件は、ここには出していません。`);
  return parts.join('');
}

export function turnText(turn: DesktopTurnResult): string {
  const result = turn.result;
  if (result !== null) {
    if (result.kind === 'schedule_cards') return scheduleText(result);
    if (result.kind === 'approval_link')
      return '確認が必要な操作を作りました。下の「確認が必要な操作」で内容を確かめてから、承認してください。まだ何も実行していません。';
  }
  return turn.reply_text ?? '受け付けました。';
}

// --- 状態 ---

export interface Message {
  readonly id: number;
  readonly role: 'user' | 'buddy';
  readonly text: string;
  // 聞き返し（本人の答えを待つ）か。
  readonly clarification: boolean;
}

export interface PreviewState {
  // 操作の参照（一覧の行と結ぶ）。
  readonly ref: string;
  // 内容を取得している（null）か、取得した内容。
  readonly preview: DesktopOperationPreview | null;
  // 承認を送って結果を待っている（OS の確認ダイアログを表示している間も含む）。
  readonly approving: boolean;
}

export interface Notice {
  readonly tone: 'warning' | 'success';
  readonly text: string;
}

export interface WorkViewState {
  readonly messages: readonly Message[];
  readonly nextId: number;
  readonly draft: string;
  readonly sending: boolean;
  readonly turnNotice: Notice | null;
  readonly preview: PreviewState | null;
  // 操作ごとの結果の文言（行のすぐ下に出す）。キーは操作の参照。
  readonly notices: Readonly<Record<string, Notice>>;
  // 取消・照合を送って結果を待っている操作の参照。
  readonly busy: readonly string[];
}

export const INITIAL_WORK_STATE: WorkViewState = {
  messages: [],
  nextId: 1,
  draft: '',
  sending: false,
  turnNotice: null,
  preview: null,
  notices: {},
  busy: [],
};

// ロック・切断・登録の取り消しで、会話と確認の内容を捨てる（ロック中は内容を隠す）。
export function forgetWork(): WorkViewState {
  return INITIAL_WORK_STATE;
}

export function setDraft(state: WorkViewState, draft: string): WorkViewState {
  return { ...state, draft, turnNotice: null };
}

const trimmed = (text: string) => text.trim();

// 発言を送れるか（空・長すぎ・送信中は送らない）。
export function turnProblem(state: WorkViewState): string | null {
  const text = trimmed(state.draft);
  if (text.length === 0) return '発言を入力してください。';
  if ([...text].length > MAX_TURN_CHARS)
    return `発言は${MAX_TURN_CHARS}${NB}文字までです。短くしてください。`;
  return null;
}

export function markTurnSending(state: WorkViewState): WorkViewState {
  return { ...state, sending: true, turnNotice: null };
}

export function operationFailureText(
  channel: Channel,
  reason: RejectReason,
): string {
  switch (channel) {
    case 'desktop.turn_submit':
      if (reason === 'outcome_unknown')
        return '発言が中枢に届いたか確かめられませんでした。自動では送り直しません。「処理状況」を確かめて、必要ならもう一度送ってください。';
      if (reason === 'not_connected')
        return '中枢に接続していないため、発言を送れませんでした。接続が戻ってから、もう一度送ってください。';
      if (reason === 'core_rejected')
        return '中枢が発言を受け付けませんでした。少し待ってから、もう一度送ってください。';
      break;
    case 'desktop.operation_preview':
      if (reason === 'core_rejected' || reason === 'preview_stale')
        return '内容を確かめられませんでした。状態が変わった可能性があります。表示が更新されたら、もう一度確かめてください。';
      if (reason === 'not_connected')
        return '中枢に接続していないため、内容を確かめられませんでした。接続が戻ってから、もう一度押してください。';
      break;
    case 'desktop.operation_approve':
      if (reason === 'confirmation_declined')
        return '確認で「やめる」を選んだため、承認していません。';
      if (reason === 'outcome_unknown')
        return '承認が中枢に届いたか確かめられませんでした。自動では送り直しません。この操作の状態が更新されるまで、お待ちください。';
      if (reason === 'core_rejected')
        return '中枢が承認を受け付けませんでした（期限切れ・状態が変わったなど）。内容をもう一度確かめてください。';
      if (reason === 'not_connected')
        return '中枢に接続していないため、承認していません。接続が戻ってから、内容をもう一度確かめてください。';
      break;
    case 'desktop.operation_cancel':
      if (reason === 'outcome_unknown')
        return '取消が中枢に届いたか確かめられませんでした。自動では送り直しません。この操作の状態が更新されるまで、お待ちください。';
      if (reason === 'core_rejected')
        return '取り消せませんでした。すでに実行に進んでいるか、状態が変わった可能性があります。';
      if (reason === 'not_connected')
        return '中枢に接続していないため、取り消せませんでした。接続が戻ってから、もう一度押してください。';
      break;
    case 'desktop.operation_reconcile':
      if (reason === 'outcome_unknown')
        return '照合の結果を確かめられませんでした。もう一度「照合」を押してください（照合は参照だけで、変更は増えません）。';
      if (reason === 'core_rejected')
        return '照合を受け付けられませんでした。状態が変わった可能性があります。表示が更新されるまで、お待ちください。';
      if (reason === 'not_connected')
        return '中枢に接続していないため、照合できませんでした。接続が戻ってから、もう一度押してください。';
      break;
    default:
      break;
  }
  return REJECT_MESSAGES[reason];
}

const warn = (text: string): Notice => ({ tone: 'warning', text });

// 発言の応答。送信中を解き、結果を会話に足す（失敗は入力欄の下に出し、入力は残す）。
export function applyTurnResponse(
  state: WorkViewState,
  response: DesktopIpcResponse,
): WorkViewState {
  if (response.outcome === 'rejected')
    return {
      ...state,
      sending: false,
      turnNotice: warn(
        operationFailureText('desktop.turn_submit', response.reason),
      ),
    };
  if (response.channel !== 'desktop.turn_submit')
    return { ...state, sending: false };
  const turn = response.turn;
  const user: Message = {
    id: state.nextId,
    role: 'user',
    text: trimmed(state.draft),
    clarification: false,
  };
  const buddy: Message = {
    id: state.nextId + 1,
    role: 'buddy',
    text: turnText(turn),
    clarification: turn.status === 'clarification',
  };
  return {
    ...state,
    messages: [...state.messages, user, buddy],
    nextId: state.nextId + 2,
    draft: '',
    sending: false,
    turnNotice: null,
  };
}

export function applyTurnFailure(state: WorkViewState): WorkViewState {
  return {
    ...state,
    sending: false,
    turnNotice: warn(WORK_IPC_FAILURE_MESSAGE),
  };
}

// 内容の確認を始める（取得を待つ間も、確認の欄を出す）。
export function markPreviewLoading(
  state: WorkViewState,
  ref: string,
): WorkViewState {
  return {
    ...state,
    preview: { ref, preview: null, approving: false },
    notices: withoutNotice(state.notices, ref),
  };
}

function withoutNotice(
  notices: Readonly<Record<string, Notice>>,
  ref: string,
): Record<string, Notice> {
  const { [ref]: _dropped, ...rest } = notices;
  return rest;
}

export function applyPreviewResponse(
  state: WorkViewState,
  ref: string,
  response: DesktopIpcResponse,
): WorkViewState {
  if (state.preview?.ref !== ref) return state;
  if (response.outcome === 'rejected')
    return {
      ...state,
      preview: null,
      notices: {
        ...state.notices,
        [ref]: warn(
          operationFailureText('desktop.operation_preview', response.reason),
        ),
      },
    };
  if (response.channel !== 'desktop.operation_preview') return state;
  return {
    ...state,
    preview: { ref, preview: response.preview, approving: false },
  };
}

export function closePreview(state: WorkViewState): WorkViewState {
  return { ...state, preview: null };
}

export function markApproving(state: WorkViewState): WorkViewState {
  return state.preview === null
    ? state
    : { ...state, preview: { ...state.preview, approving: true } };
}

// 承認の応答。受け付けたら確認を閉じる。拒否は確認の欄に残して（状態が変わった・やめたなど）文言を出す。
export function applyApproveResponse(
  state: WorkViewState,
  ref: string,
  response: DesktopIpcResponse,
): WorkViewState {
  if (state.preview?.ref !== ref) return state;
  if (response.outcome === 'ok')
    return {
      ...state,
      preview: null,
      notices: {
        ...state.notices,
        [ref]: {
          tone: 'success',
          text: '承認を送りました。実行の状況は、この行で確かめられます。',
        },
      },
    };
  const text = operationFailureText(
    'desktop.operation_approve',
    response.reason,
  );
  // 内容・状態が変わった・結果が分からない・参照がなくなった: 確認を閉じ、行のすぐ下に出す。
  // 「やめる」と接続の失敗は確認を残し、その場でやり直せるようにする。
  const keep =
    response.reason === 'confirmation_declined' ||
    response.reason === 'not_connected' ||
    response.reason === 'confirmation_pending' ||
    response.reason === 'screen_operation_required';
  return {
    ...state,
    preview: keep ? { ...state.preview, approving: false } : null,
    notices: { ...state.notices, [ref]: warn(text) },
  };
}

export function applyApproveFailure(
  state: WorkViewState,
  ref: string,
): WorkViewState {
  if (state.preview?.ref !== ref) return state;
  return {
    ...state,
    preview: { ...state.preview, approving: false },
    notices: { ...state.notices, [ref]: warn(WORK_IPC_FAILURE_MESSAGE) },
  };
}

export function markBusy(state: WorkViewState, ref: string): WorkViewState {
  return {
    ...state,
    busy: [...state.busy.filter((item) => item !== ref), ref],
    notices: withoutNotice(state.notices, ref),
  };
}

export function applyCommandResponse(
  state: WorkViewState,
  ref: string,
  channel: Channel,
  response: DesktopIpcResponse,
): WorkViewState {
  const busy = state.busy.filter((item) => item !== ref);
  if (response.outcome === 'rejected')
    return {
      ...state,
      busy,
      notices: {
        ...state.notices,
        [ref]: warn(operationFailureText(channel, response.reason)),
      },
    };
  return {
    ...state,
    busy,
    notices: {
      ...state.notices,
      [ref]: {
        tone: 'success',
        text:
          channel === 'desktop.operation_reconcile'
            ? '照合を依頼しました。結果が分かると、この行の状態が変わります。'
            : '取消を依頼しました。結果が分かると、この行の状態が変わります。',
      },
    },
  };
}

export function applyCommandFailure(
  state: WorkViewState,
  ref: string,
): WorkViewState {
  return {
    ...state,
    busy: state.busy.filter((item) => item !== ref),
    notices: { ...state.notices, [ref]: warn(WORK_IPC_FAILURE_MESSAGE) },
  };
}

// 操作の一覧が変わったとき、なくなった操作の文言・確認を捨てる。確認は、その操作が承認待ちのままのときだけ残す。
export function syncOperations(
  state: WorkViewState,
  operations: readonly DesktopOperationEntry[],
): WorkViewState {
  const refs = new Set(operations.map((entry) => entry.ref));
  const keptNotices = Object.entries(state.notices).filter(([ref]) =>
    refs.has(ref),
  );
  const previewEntry =
    state.preview === null
      ? undefined
      : operations.find((entry) => entry.ref === state.preview?.ref);
  const previewAlive =
    previewEntry !== undefined &&
    previewEntry.state === 'awaiting_approval' &&
    !previewEntry.delivery_unknown;
  const preview = previewAlive || state.preview === null ? state.preview : null;
  if (
    keptNotices.length === Object.keys(state.notices).length &&
    preview === state.preview
  )
    return state;
  return { ...state, notices: Object.fromEntries(keptNotices), preview };
}

// --- 送る要求 ---

export interface WorkActions {
  readonly submit: () => void;
  readonly setDraft: (draft: string) => void;
  readonly preview: (ref: string) => void;
  readonly closePreview: () => void;
  readonly approve: () => void;
  readonly cancel: (ref: string) => void;
  readonly reconcile: (ref: string) => void;
}

export interface WorkSink {
  readonly state: () => WorkViewState;
  readonly send: (
    built: DesktopIpcRequest,
    onResponse: (
      state: WorkViewState,
      response: DesktopIpcResponse,
    ) => WorkViewState,
    onFailure: (state: WorkViewState) => WorkViewState,
    before: (state: WorkViewState) => WorkViewState,
  ) => void;
  readonly update: (change: (state: WorkViewState) => WorkViewState) => void;
}

export function workActions(sink: WorkSink): WorkActions {
  return {
    submit: () => {
      const current = sink.state();
      if (current.sending) return;
      const problem = turnProblem(current);
      if (problem !== null) {
        sink.update((state) => ({ ...state, turnNotice: warn(problem) }));
        return;
      }
      sink.send(
        request('desktop.turn_submit', { text: trimmed(current.draft) }),
        applyTurnResponse,
        applyTurnFailure,
        markTurnSending,
      );
    },
    setDraft: (draft) => sink.update((state) => setDraft(state, draft)),
    preview: (ref) => {
      const current = sink.state();
      if (current.preview?.approving === true) return;
      sink.send(
        request('desktop.operation_preview', { ref }),
        (state, response) => applyPreviewResponse(state, ref, response),
        (state) =>
          applyPreviewResponse(state, ref, {
            request_id: null,
            channel: null,
            outcome: 'rejected',
            reason: 'core_rejected',
          }),
        (state) => markPreviewLoading(state, ref),
      );
    },
    closePreview: () => {
      if (sink.state().preview?.approving === true) return;
      sink.update(closePreview);
    },
    approve: () => {
      const current = sink.state();
      const preview = current.preview;
      if (preview === null || preview.preview === null || preview.approving)
        return;
      const ref = preview.ref;
      sink.send(
        request('desktop.operation_approve', {
          ref: preview.preview.preview_ref,
        }),
        (state, response) => applyApproveResponse(state, ref, response),
        (state) => applyApproveFailure(state, ref),
        markApproving,
      );
    },
    cancel: (ref) => command(sink, 'desktop.operation_cancel', ref),
    reconcile: (ref) => command(sink, 'desktop.operation_reconcile', ref),
  };
}

function command(
  sink: WorkSink,
  channel: 'desktop.operation_cancel' | 'desktop.operation_reconcile',
  ref: string,
): void {
  if (sink.state().busy.includes(ref)) return;
  sink.send(
    request(channel, { ref }),
    (state, response) => applyCommandResponse(state, ref, channel, response),
    (state) => applyCommandFailure(state, ref),
    (state) => markBusy(state, ref),
  );
}
