// 記憶の忘却の計画・実行と、忘却台帳の端末への配信の経路（B06-07b-2、設計 03、ADR 0040・0054・0180）。
//
// 経路の検査（端末トークン・自宅判定・接続範囲・ロック解除・画面の操作）は api-server の admission が先に行う。
// - 計画（createForgetPlan）と実行（executeForgetPlan）は ForgetService に渡すだけ。忘却の公開ゲート（U112）・計画の端末・
//   期限・世代の照合と、DB の今の系譜との照合は ForgetService と DB worker が行う。ゲートが閉じている間は 503。
// - 配信（getForgetLedgerEntries）は、DB の台帳（正本。U109）を書き出し、domain の forgetLedgerDelta で端末の head の
//   続きを返す（U385・U386）。本文・生の元サービス ID は台帳にない。忘却の公開ゲートには関わらない（読み取りだけ）。
// 拒否の本文は ApiError だけで、計画の中身・拒否の詳しい理由を返さない。

import type {
  ForgetLedgerChainEntry,
  ForgetLedgerDelta,
} from '@buddy/contracts';
import { forgetLedgerDelta } from '@buddy/domain';
import type { DbWorkerClient, LedgerChainEntry } from '@buddy/storage';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import type { ForgetService } from './forget-service.js';

export interface ForgetRoutesOptions {
  readonly service: Pick<ForgetService, 'plan' | 'execute'>;
  readonly store: Pick<DbWorkerClient, 'memory'>;
}

export interface ForgetRoutes {
  readonly handlers: {
    readonly createForgetPlan: ApiRouteHandler;
    readonly executeForgetPlan: ApiRouteHandler;
    readonly getForgetLedgerEntries: ApiRouteHandler;
  };
}

const stringOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

// DB の台帳の 1 件を契約の形にする。忘れた対象が空の行は台帳として不正なので null（DB の照合と CHECK が守る）。
function chainEntryOf(link: LedgerChainEntry): ForgetLedgerChainEntry | null {
  const [first, ...rest] = link.entry.forgotten;
  if (first === undefined) return null;
  return {
    entry: {
      schema: link.entry.schema,
      entry_id: link.entry.entry_id,
      forgetting_generation: link.entry.forgetting_generation,
      recorded_at: link.entry.recorded_at,
      forgotten: [first, ...rest],
      blocked_source_hmacs: [...link.entry.blocked_source_hmacs],
      blocked_content_keys: [...link.entry.blocked_content_keys],
    },
    previous_hash: link.previous_hash,
    entry_hash: link.entry_hash,
  };
}

export function createForgetRoutes(options: ForgetRoutesOptions): ForgetRoutes {
  const createForgetPlan: ApiRouteHandler = async (request) => {
    const requestId = stringOf(request.body?.['request_id']) || null;
    if (request.device === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const outcome = await options.service.plan({
      device_id: request.device.device_id,
      memory_id: stringOf(request.body?.['memory_id']),
    });
    if (outcome.ok) return { status: 200, body: outcome.view };
    return outcome.reason === 'target_not_found'
      ? apiErrorResponse(409, 'conflict', requestId)
      : apiErrorResponse(503, 'dependency_unavailable', requestId);
  };

  const executeForgetPlan: ApiRouteHandler = async (request) => {
    const requestId = stringOf(request.body?.['request_id']) || null;
    if (request.device === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const outcome = await options.service.execute({
      device_id: request.device.device_id,
      plan_id: stringOf(request.params['plan_id']),
      forgetting_generation: stringOf(request.body?.['forgetting_generation']),
    });
    if (outcome.ok) return { status: 200, body: outcome.result };
    switch (outcome.reason) {
      case 'plan_not_found':
      case 'plan_expired':
      case 'generation_mismatch':
      case 'replan_required':
        return apiErrorResponse(409, 'conflict', requestId);
      // 確定の成否が分からない。計画は捨てたので再試行しても残っておらず、消えた可能性がある（自動では送り直さない）。
      case 'outcome_unknown':
        return apiErrorResponse(503, 'outcome_unknown', requestId);
      default:
        return apiErrorResponse(503, 'dependency_unavailable', requestId);
    }
  };

  const getForgetLedgerEntries: ApiRouteHandler = async (request) => {
    const exported = await options.store.memory({
      kind: 'forget.ledger_export',
    });
    if (!exported.ok) return apiErrorResponse(503, 'dependency_unavailable');
    const ledgerId = request.body?.['ledger_id'];
    const decision = forgetLedgerDelta(
      { ledger_id: exported.value.ledger_id, entries: exported.value.entries },
      {
        ledger_id: typeof ledgerId === 'string' ? ledgerId : null,
        forgetting_generation: stringOf(
          request.body?.['forgetting_generation'],
        ),
        entry_hash: stringOf(request.body?.['entry_hash']),
      },
    );
    if (decision.outcome === 'ledger_invalid')
      return apiErrorResponse(503, 'dependency_unavailable');
    const head = {
      forgetting_generation: exported.value.head.forgetting_generation,
      entry_hash: exported.value.head.entry_hash,
    };
    if (decision.outcome !== 'entries') {
      const body: ForgetLedgerDelta = {
        schema: 'buddy.forget-ledger-delta.v1',
        outcome: decision.outcome,
        ledger_id: exported.value.ledger_id,
        head,
        entries: [],
        has_more: false,
      };
      return { status: 200, body };
    }
    const entries: ForgetLedgerChainEntry[] = [];
    for (const link of decision.entries) {
      const entry = chainEntryOf(link);
      if (entry === null)
        return apiErrorResponse(503, 'dependency_unavailable');
      entries.push(entry);
    }
    const body: ForgetLedgerDelta = {
      schema: 'buddy.forget-ledger-delta.v1',
      outcome: 'entries',
      ledger_id: exported.value.ledger_id,
      head,
      entries,
      has_more: decision.has_more,
    };
    return { status: 200, body };
  };

  return {
    handlers: { createForgetPlan, executeForgetPlan, getForgetLedgerEntries },
  };
}
