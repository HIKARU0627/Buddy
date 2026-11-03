// 表示と読み上げの計画の意味検査（B10-01、ADR 0070）。
// 形の検査は contracts が行う。ここでは、計画の段（plan と view）の識別子と、
// 意図・結果の状態から決まる結果の種類（RESULT_VIEW_BY_INTENT と resultViewKind）が
// 食い違っていないかを確かめる。聞き返しと承認は通常完了の種類より優先する（ADR 0005）。
import { resultViewKind, type ResultViewKind } from './conversation.js';
import { INTENT_POLICIES, type IntentName } from './intents.js';

export type ResponsePlanOutcome =
  'done' | 'needs_approval' | 'needs_clarification';

export interface ResponsePlanLike {
  readonly workflow_id: string;
  readonly request_revision: string;
  readonly intent: IntentName;
  readonly outcome: ResponsePlanOutcome;
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
  // 聞き返し・承認は、通常完了の結果の種類より優先する。計画だけ別の種類を名乗ることを許さない。
  if (plan.view.kind !== resultViewKind(plan.intent, plan.outcome))
    errors.push('view_kind_mismatch');
  // 承認を求めない意図（Read と、本人の明示依頼だけの操作）に承認の計画を作らない。
  if (
    plan.outcome === 'needs_approval' &&
    INTENT_POLICIES[plan.intent].approval === 'none'
  )
    errors.push('approval_not_possible');
  return errors;
}
