// 表示と読み上げの計画の意味検査（B10-01、ADR 0070）。
// 形の検査は contracts が行う。ここでは、計画の段（plan と view）の識別子と、
// 意図と結果の種類の対応（RESULT_VIEW_BY_INTENT）が食い違っていないかを確かめる。
import { RESULT_VIEW_BY_INTENT, type ResultViewKind } from './conversation.js';
import type { IntentName } from './intents.js';

export interface ResponsePlanLike {
  readonly workflow_id: string;
  readonly request_revision: string;
  readonly intent: IntentName;
  readonly view: {
    readonly workflow_id: string;
    readonly request_revision: string;
    readonly intent: IntentName;
    readonly kind: ResultViewKind;
  };
}

export function responsePlanErrors(plan: ResponsePlanLike): string[] {
  const errors: string[] = [];
  if (plan.view.workflow_id !== plan.workflow_id)
    errors.push('view_workflow_mismatch');
  if (plan.view.request_revision !== plan.request_revision)
    errors.push('view_revision_mismatch');
  if (plan.view.intent !== plan.intent) errors.push('view_intent_mismatch');
  // 意図の結果の種類は既存の表から変えない。計画だけ別の種類を名乗ることを許さない。
  if (plan.view.kind !== RESULT_VIEW_BY_INTENT[plan.intent])
    errors.push('view_kind_mismatch');
  return errors;
}
