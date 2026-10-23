// 予算の 4 経路（利用状況・超過の承認・M 超過の確認・不明な費用の手での精算。設計 05 F02、01 設定・運用・承認画面、
// ADR 0034・0039、本人の判断 2026-10-23）。
//
// - 経路の検査（ROUTE_CHECKS）は api-server.ts が先に行う（未登録・失効した端末は 401、ロック・画面操作・接続範囲・
//   版の照合）。ここは検査を通った要求の処理だけ。
// - 判定は予算の門（BudgetGate）と DB worker の予算の命令に任せる。承認・精算・確認は 1 つの transaction で記録し、
//   接続範囲＋request_id の受付（command_receipts）で再送を保存済みの結果にする（承認の二度押しでも承認は 1 件）。
// - 超過枠の承認は、画面で見せた予算の要求（budget_request_id）と M が記録と一致するときだけ決める。LLM・クライアントは
//   承認の正本ではない（承認の状態は DB だけが持つ）。
// - 応答は契約（BudgetUsageSummary・BudgetOverageApproval・BudgetReservation）の形だけ。拒否は ApiError で、理由のコード・
//   金額を入れない。
import { MANUAL_RECONCILIATION_ID } from '@buddy/domain';
import type { EnvironmentInput } from './api-environment.js';
import { deviceCommandId, requestHash } from './api-operations.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import type { BudgetGate, GateResult, Money } from './budget-gate.js';
import type { JsonObject } from './strict-json.js';

// 版（expected_reservation_revision）を照合する経路。
export const BUDGET_REVISION_CHECKED_ROUTES: ReadonlySet<string> = new Set([
  'reviewBudgetOverrun',
  'settleBudgetManually',
]);

// 内容・状態が変わった（記録と合わない）拒否の理由。他の理由は中枢側の保留（503）。
const CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'request_conflict',
  'unknown_reservation',
  'revision_conflict',
  'approval_unknown',
  'approval_mismatch',
  'approval_pending',
  'approval_approved',
  'approval_rejected',
  'approval_expired',
  'approval_consumed',
  'approval_changed',
  'review_mismatch',
  'no_overrun',
  'not_settled',
  'already_settled',
  'released',
  'not_usage_unknown',
  'not_settleable',
  'reconciliation_id_used',
  'currency_mismatch',
]);

// 本文の形は経路の形式の検査（JSON Schema）が済ませている。取り出すだけ。
const stringOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const moneyOf = (value: unknown): Money => {
  const object = (value ?? {}) as JsonObject;
  return {
    currency: stringOf(object['currency']),
    amount: stringOf(object['amount']),
  };
};

export interface BudgetRoutesOptions {
  readonly gate: BudgetGate;
  // 接続範囲＋request_id の受付があるか（再送の判定。版の照合で使う）。
  readonly receiptExists: (
    commandScopeId: string,
    requestId: string,
  ) => Promise<boolean>;
}

export interface BudgetRoutes {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
  // reviewBudgetOverrun・settleBudgetManually の版の照合（RequestEnvironment.revisionMatches）。
  revisionMatches(input: EnvironmentInput): Promise<boolean>;
}

// 命令の結果を応答へ写す。成功は 200 と記録の形、記録と合わない拒否は 409、それ以外（成否不明・保存の失敗）は 503。
// 成否不明は同じ request_id で送り直せば、保存済みなら同じ結果が返る。
function failure(
  result: Extract<GateResult<unknown>, { ok: false }>,
  requestId: string,
): { status: number; body: object } {
  if (
    !result.unknown &&
    result.reasons.length > 0 &&
    result.reasons.every((reason) => CONFLICT_REASONS.has(reason))
  )
    return apiErrorResponse(409, 'conflict', requestId);
  return apiErrorResponse(503, 'dependency_unavailable', requestId);
}

export function createBudgetRoutes(options: BudgetRoutesOptions): BudgetRoutes {
  const { gate } = options;

  // 端末の要求の受付（07 §3）。経路・対象・本文の照合値で、同じ要求の再送は保存済みの結果、内容が違えば拒否する。
  const requestRef = (request: ApiHandlerRequest, targetId: string) => {
    const body = request.body as JsonObject;
    const scopeId = stringOf(body['command_scope_id']);
    const requestId = stringOf(body['request_id']);
    return {
      command_scope_id: scopeId,
      request_id: requestId,
      request_hash: requestHash(request.route.operationId, targetId, body),
      command_id: deviceCommandId(scopeId, requestId),
    };
  };

  const getBudgetUsage: ApiRouteHandler = async () => {
    const usage = await gate.usage();
    if (!usage.ok) return apiErrorResponse(503, 'dependency_unavailable');
    return { status: 200, body: usage.value };
  };

  const decideBudgetOverage: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body['request_id']);
    const approvalId = request.params['approval_id'] ?? '';
    const decision = body['decision'] === 'reject' ? 'reject' : 'approve';
    const result = await gate.decideOverage({
      approval_id: approvalId,
      budget_request_id: stringOf(body['budget_request_id']),
      max_liability: moneyOf(body['max_liability']),
      decision,
      request: requestRef(request, approvalId),
    });
    if (!result.ok) return failure(result, requestId);
    return { status: 200, body: result.value };
  };

  const reviewBudgetOverrun: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body['request_id']);
    const reservationId = request.params['reservation_id'] ?? '';
    const result = await gate.reviewOverrun({
      reservation_id: reservationId,
      expected_revision: stringOf(body['expected_reservation_revision']),
      actual_gross: moneyOf(body['actual_gross']),
      max_liability: moneyOf(body['max_liability']),
      request: requestRef(request, reservationId),
    });
    if (!result.ok) return failure(result, requestId);
    return { status: 200, body: result.value };
  };

  const settleBudgetManually: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body['request_id']);
    const reservationId = request.params['reservation_id'] ?? '';
    const actual = moneyOf(body['actual_gross']);
    const credit = moneyOf(body['credit_applied']);
    const additional = moneyOf(body['additional_spend']);
    // クレジットの区分の決め方（MA03〜MA06）は B07-07。それまでは初期の規則（クレジット 0・追加の支出＝実費・周期なし）
    // だけを受け付け、推測の区分を記録しない（ADR 0034・0039）。
    if (
      !MANUAL_RECONCILIATION_ID.test(
        stringOf(body['manual_reconciliation_id']),
      ) ||
      credit.currency !== actual.currency ||
      additional.currency !== actual.currency ||
      credit.amount !== '0' ||
      additional.amount !== actual.amount ||
      body['credit_cycle_id'] !== null
    )
      return apiErrorResponse(422, 'invalid_input', requestId);
    const result = await gate.settleManual({
      reservation_id: reservationId,
      expected_revision: stringOf(body['expected_reservation_revision']),
      manual_reconciliation_id: stringOf(body['manual_reconciliation_id']),
      actual_gross: actual,
      request: requestRef(request, reservationId),
    });
    if (!result.ok) return failure(result, requestId);
    return { status: 200, body: result.value };
  };

  // 版の照合。保存済みの受付（同じ接続範囲・request_id）があれば再送の判定に任せる（同じ内容は保存済みの結果、違えば
  // 409）。なければ、予約の今の版と本文の版を比べる（予約がない・読めないときは合わない。閉じた側）。
  const revisionMatches = async (input: EnvironmentInput): Promise<boolean> => {
    const body = input.body;
    const scopeId = stringOf(body?.['command_scope_id']);
    const requestId = stringOf(body?.['request_id']);
    const current = await gate.reservationRevision(
      input.params['reservation_id'] ?? '',
    );
    if (current === 'unavailable' || current === null) return false;
    if (scopeId !== '' && requestId !== '') {
      if (await options.receiptExists(scopeId, requestId)) return true;
    }
    return stringOf(body?.['expected_reservation_revision']) === current;
  };

  return {
    handlers: {
      getBudgetUsage,
      decideBudgetOverage,
      reviewBudgetOverrun,
      settleBudgetManually,
    },
    revisionMatches,
  };
}
