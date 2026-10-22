// 操作の工程（operation_steps）の進め方（設計 08 §3・§4、09 §5 X10、ADR 0027 の D3）。
// 一つの試行の中で工程を決まった順にだけ進め、送出意図を保存した工程は再送せず照合する。
// B04 は仕組みだけを作り、2 工程（下書き → 送信）の X10 の合格は B14 に回す。

import type { OperationStepKind } from './connectors.js';

export type StepResultStatus =
  'confirmed_success' | 'confirmed_not_executed' | 'unknown';

// operation_steps の 1 行（0001 の列と同じ意味）。
export interface OperationStepRecord {
  readonly step_id: string;
  readonly step_kind: OperationStepKind;
  readonly dispatch_intent_at: number | null;
  readonly result_status: StepResultStatus | null;
  readonly external_id: string | null;
}

// pending: 送出意図がまだない。dispatching: 送出意図を保存し、結果がまだない（再送しない）。
export type StepState =
  'pending' | 'dispatching' | 'succeeded' | 'not_executed' | 'unknown';

export function stepState(record: OperationStepRecord): StepState {
  if (record.dispatch_intent_at === null)
    return record.result_status === null ? 'pending' : 'unknown';
  switch (record.result_status) {
    case null:
      return 'dispatching';
    case 'confirmed_success':
      return 'succeeded';
    case 'confirmed_not_executed':
      return 'not_executed';
    case 'unknown':
      return 'unknown';
  }
}

// 工程 ID は試行の中の位置と種類から決める（再起動の後も同じ値）。例: 1-create_draft、2-send。
export function stepId(index: number, kind: OperationStepKind): string {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new TypeError('工程の位置は 0 以上の整数にしてください。');
  return `${index + 1}-${kind}`;
}

export type StepDecision =
  | {
      readonly action: 'dispatch';
      readonly step_id: string;
      readonly step_kind: OperationStepKind;
    }
  | { readonly action: 'reconcile'; readonly step_id: string }
  | { readonly action: 'complete' }
  | { readonly action: 'stop'; readonly reasons: readonly string[] };

// 次に行うことを決める。前の工程が成功で確定するまで次の工程へ進まない。
// 送出意図を保存した工程（dispatching・unknown）は照合だけ（自動で再送しない）。
export function nextStepDecision(
  plan: readonly OperationStepKind[],
  records: readonly OperationStepRecord[],
): StepDecision {
  if (plan.length === 0)
    return { action: 'stop', reasons: ['step_plan_empty'] };
  if (records.length > plan.length)
    return { action: 'stop', reasons: ['step_plan_mismatch'] };
  for (const [index, record] of records.entries())
    if (
      record.step_kind !== plan[index] ||
      record.step_id !== stepId(index, record.step_kind)
    )
      return { action: 'stop', reasons: ['step_plan_mismatch'] };
  for (const [index, kind] of plan.entries()) {
    const record = records[index];
    const state = record === undefined ? 'pending' : stepState(record);
    if (state === 'succeeded') continue;
    // 後ろの工程に送出意図があれば、順序が崩れている。
    if (records.slice(index + 1).some((r) => r.dispatch_intent_at !== null))
      return { action: 'stop', reasons: ['step_order_violation'] };
    if (state === 'pending')
      return {
        action: 'dispatch',
        step_id: stepId(index, kind),
        step_kind: kind,
      };
    if (state === 'not_executed')
      return {
        action: 'stop',
        reasons: [index === 0 ? 'step_not_executed' : 'partial_steps'],
      };
    return { action: 'reconcile', step_id: stepId(index, kind) };
  }
  return { action: 'complete' };
}
