// 意図ごとの経路・承認・入力条件・引数の表（ADR 0004）。
// 経路と承認はコードが決め、モデルや端末の申告から作らない（設計 10 §6A D15、修正案 H02）。

export const INTENT_NAMES = [
  'query_schedule',
  'query_mail',
  'query_tasks',
  'query_memory',
  'create_task',
  'create_note',
  'label_mail',
  'draft_reply',
  'create_event',
  'update_event',
  'send_mail',
  'trash_mail',
  'undo_action',
  'update_task',
  'research',
  'memory_save',
  'memory_forget',
  'memory_correct',
  'dev_status',
  'handoff_screen',
  'smalltalk',
  'general_question',
  'consult',
  'unclear',
] as const;

export type IntentName = (typeof INTENT_NAMES)[number];

export const ARG_FIELDS = [
  'target_candidate_id',
  'start',
  'end',
  'due',
  'title',
  'body',
  'subject',
  'add_labels',
  'remove_labels',
  'task_change',
  'memory_kind',
  'query',
  'device_name',
] as const;

export type ArgField = (typeof ARG_FIELDS)[number];

export type ExecutionRoute = 'read' | 'local_command' | 'remote_mutation';

// none: 承認なし（参照、または本人の明示依頼による Buddy 内の変更）。
// policy: D05 の自動実行（方針による自動承認）。方針が許さなければ画面承認。
// screen: 内容版に結び付いた画面承認。音声の「はい」は承認にしない。
export type ApprovalKind = 'none' | 'policy' | 'screen';

export interface IntentPolicy {
  readonly route: ExecutionRoute;
  readonly approval: ApprovalKind;
  // 方式 C（Live 文字起こしの暫定入力）から進めてよいか（設計 10 §5A F01）。
  readonly liveTranscript: boolean;
  readonly required: readonly ArgField[];
  readonly allowed: readonly ArgField[];
}

const read = (
  allowed: readonly ArgField[],
  required: readonly ArgField[] = [],
): IntentPolicy => ({
  route: 'read',
  approval: 'none',
  liveTranscript: true,
  required,
  allowed,
});

export const INTENT_POLICIES: Readonly<Record<IntentName, IntentPolicy>> = {
  query_schedule: read(['start', 'end']),
  query_mail: read(['target_candidate_id', 'start', 'end', 'query']),
  query_tasks: read(['start', 'end', 'query']),
  query_memory: read(['query']),
  create_task: {
    route: 'local_command',
    approval: 'policy',
    liveTranscript: true,
    required: ['title'],
    allowed: ['title', 'due', 'body', 'target_candidate_id'],
  },
  create_note: {
    route: 'local_command',
    approval: 'policy',
    liveTranscript: true,
    required: ['body'],
    allowed: ['body', 'title'],
  },
  label_mail: {
    route: 'remote_mutation',
    approval: 'policy',
    liveTranscript: true,
    required: ['target_candidate_id'],
    allowed: ['target_candidate_id', 'add_labels', 'remove_labels'],
  },
  draft_reply: {
    route: 'remote_mutation',
    approval: 'policy',
    liveTranscript: true,
    required: ['target_candidate_id'],
    allowed: ['target_candidate_id', 'body'],
  },
  // 自分だけの予定（J11）は方針による自動実行、それ以外は画面承認。
  create_event: {
    route: 'remote_mutation',
    approval: 'policy',
    liveTranscript: true,
    required: ['title', 'start'],
    allowed: ['title', 'start', 'end'],
  },
  update_event: {
    route: 'remote_mutation',
    approval: 'screen',
    liveTranscript: false,
    required: ['target_candidate_id'],
    allowed: ['target_candidate_id', 'start', 'end', 'title'],
  },
  // 宛先はモデルに作らせず、返信元の候補か画面で本人が確定する（ADR 0004）。
  send_mail: {
    route: 'remote_mutation',
    approval: 'screen',
    liveTranscript: false,
    required: ['body'],
    allowed: ['target_candidate_id', 'subject', 'body'],
  },
  trash_mail: {
    route: 'remote_mutation',
    approval: 'screen',
    liveTranscript: false,
    required: ['target_candidate_id'],
    allowed: ['target_candidate_id'],
  },
  // 取り消し一覧を開くだけ。補償操作は画面の undo API で別の操作として作る（J12）。
  undo_action: read(['target_candidate_id']),
  update_task: {
    route: 'local_command',
    approval: 'screen',
    liveTranscript: false,
    required: ['target_candidate_id', 'task_change'],
    allowed: ['target_candidate_id', 'task_change', 'due'],
  },
  research: read(['query'], ['query']),
  memory_save: {
    route: 'local_command',
    approval: 'none',
    liveTranscript: false,
    required: ['body'],
    allowed: ['body', 'memory_kind'],
  },
  memory_forget: {
    route: 'local_command',
    approval: 'none',
    liveTranscript: false,
    required: [],
    allowed: ['target_candidate_id', 'query'],
  },
  memory_correct: {
    route: 'local_command',
    approval: 'none',
    liveTranscript: false,
    required: ['body'],
    allowed: ['target_candidate_id', 'body', 'memory_kind'],
  },
  dev_status: read(['query']),
  handoff_screen: {
    route: 'local_command',
    approval: 'none',
    liveTranscript: true,
    required: [],
    allowed: ['device_name'],
  },
  smalltalk: read([]),
  general_question: read(['query']),
  consult: read(['query'], ['query']),
  unclear: read([]),
};

export type ArgValues = Readonly<Record<ArgField, unknown>>;

// 必須の不足は聞き返し、許可外の値は意味検証の失敗として区別する（設計 10 §5、§6A D15）。
export function checkIntentArgs(
  intent: IntentName,
  args: ArgValues,
): { missing: ArgField[]; unexpected: ArgField[] } {
  const policy = INTENT_POLICIES[intent];
  const missing = policy.required.filter((field) => args[field] === null);
  const unexpected = ARG_FIELDS.filter(
    (field) => args[field] !== null && !policy.allowed.includes(field),
  );
  if (
    intent === 'memory_forget' &&
    args.target_candidate_id === null &&
    args.query === null
  )
    missing.push('target_candidate_id');
  if (intent === 'update_task' && args.task_change === 'reschedule')
    if (args.due === null) missing.push('due');
  if (intent === 'label_mail') {
    const add = Array.isArray(args.add_labels) ? args.add_labels : [];
    const remove = Array.isArray(args.remove_labels) ? args.remove_labels : [];
    if (add.length === 0 && remove.length === 0) missing.push('add_labels');
  }
  return { missing, unexpected };
}
