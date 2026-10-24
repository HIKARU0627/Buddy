import type { IntentName } from './intents.js';

// 結果の種類と画面部品（設計 10 §6A、ADR 0005）。
export type ResultViewKind =
  | 'schedule_cards'
  | 'task_rows'
  | 'insight_rows'
  | 'mail_rows'
  | 'memory_rows'
  | 'completion_line'
  | 'approval_link'
  | 'clarification'
  | 'speech_bubble'
  | 'accepted_line'
  | 'status_line'
  | 'undo_list_link';

export const RESULT_VIEW_BY_INTENT: Readonly<
  Record<IntentName, ResultViewKind>
> = {
  query_schedule: 'schedule_cards',
  query_mail: 'mail_rows',
  query_tasks: 'task_rows',
  query_memory: 'memory_rows',
  create_task: 'completion_line',
  create_note: 'completion_line',
  label_mail: 'completion_line',
  draft_reply: 'completion_line',
  create_event: 'completion_line',
  update_event: 'approval_link',
  send_mail: 'approval_link',
  trash_mail: 'approval_link',
  undo_action: 'undo_list_link',
  update_task: 'approval_link',
  research: 'accepted_line',
  memory_save: 'completion_line',
  memory_forget: 'completion_line',
  memory_correct: 'completion_line',
  dev_status: 'speech_bubble',
  handoff_screen: 'status_line',
  smalltalk: 'speech_bubble',
  general_question: 'speech_bubble',
  consult: 'speech_bubble',
  unclear: 'clarification',
};

// 聞き返しが必要なら質問、画面承認が必要なら変更確認画面を開くボタンを優先する。
export function resultViewKind(
  intent: IntentName,
  outcome: 'done' | 'needs_approval' | 'needs_clarification',
): ResultViewKind {
  if (outcome === 'needs_clarification') return 'clarification';
  if (outcome === 'needs_approval') return 'approval_link';
  return RESULT_VIEW_BY_INTENT[intent];
}

export type SessionControlAction =
  | 'extend_silence'
  | 'stop_playback'
  | 'end_conversation'
  | 'start_private_conversation'
  | 'reply_in_text';

// 照合の前の正規化（全角・半角をそろえ、末尾の記号と空白を除く）。照合表の言い回しにも同じ正規化を使う。
export const normalizeUtterance = (text: string): string =>
  text
    .normalize('NFKC')
    .trim()
    .replace(/[\s。．、，,.!！?？…]+$/u, '');

// 短い発話の全体が照合表の言い回しに一致したときだけ会話の操作にする（10 §5、X58）。
// 「終わりの時間教えて」のような依頼は一致させず、通常の意図判定へ回す。
export function matchSessionControl(
  utterance: string,
  phrases: readonly {
    readonly phrase: string;
    readonly action: SessionControlAction;
  }[],
): SessionControlAction | null {
  const said = normalizeUtterance(utterance);
  if (!said) return null;
  return (
    phrases.find((entry) => normalizeUtterance(entry.phrase) === said)
      ?.action ?? null
  );
}
