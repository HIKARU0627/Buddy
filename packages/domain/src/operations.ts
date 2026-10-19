// 操作の内部状態と許される遷移（設計 08 §3・§4）。
// dispatching 以降は取消済みにせず、結果不明を自動再送しない。

export type OperationState =
  | 'awaiting_approval'
  | 'approved'
  | 'preparing'
  | 'dispatching'
  | 'reconciling'
  | 'succeeded'
  | 'unknown_held'
  | 'not_executed'
  | 'cancelled'
  | 'superseded';

export const OPERATION_TRANSITIONS: Readonly<
  Record<OperationState, readonly OperationState[]>
> = {
  awaiting_approval: ['approved', 'cancelled', 'superseded'],
  approved: ['preparing', 'cancelled', 'superseded'],
  // 対象の前提が変われば送出せず新しい内容版へ（旧版は superseded）。
  preparing: ['dispatching', 'cancelled', 'superseded'],
  dispatching: ['reconciling', 'unknown_held'],
  reconciling: ['succeeded', 'unknown_held', 'not_executed'],
  unknown_held: ['reconciling', 'succeeded', 'not_executed'],
  // 未実行が確定した同じ内容への本人の明示再試行は新しい試行で準備へ戻る。
  not_executed: ['preparing', 'superseded'],
  succeeded: [],
  cancelled: [],
  superseded: [],
};

// 自動実行（方針による自動承認）は awaiting_approval を通らず approved から始まる。
export const INITIAL_OPERATION_STATES: readonly OperationState[] = [
  'awaiting_approval',
  'approved',
];

export function canTransition(
  from: OperationState,
  to: OperationState,
): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}
