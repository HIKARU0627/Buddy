// 自動実行の一覧と安全停止の解除の経路（設計 03「取り消しと安全停止」、07 §2、J12、B13-05、ADR 0152）。
//
// 経路の検査（端末トークン・自宅判定・ロック解除・画面の操作・接続範囲・版の照合）は api-server の admission が先に行う。
// ここは検査を通った要求の処理で、判定の正本は保存層（safety-store.ts）と domain の autoActionUndoState。
// - 一覧（GET /v1/auto-actions）は安全停止の状態と自動実行した操作を一つの読み取りで返す。本文（確定 intent）は返さない。
// - 取り消しの経路（POST /v1/auto-actions/{id}/undo）はまだ作らない。一覧の undo_state は取り消せるように見せない
//   （unavailable）。取り消し済み・取り消し中・期限切れは記録のとおりに見せる。
// - 解除（POST /v1/safety/resume）は登録済みの端末の画面操作だけ。版（expected_safety_revision）は DB の現在値で
//   照合し、解除の transaction の中でも同じ値で照合し直す（compare-and-swap）。同じ request_id の再送は、成功済みなら
//   版が進んでいるので 409 になる（二重に効かない）。画面は読み直して確かめる。
// - 想定外の保存の失敗・成否不明は 503 dependency_unavailable にし、成功にも版の不一致にも見せない。

import type {
  AutoActionListRecord,
  AutoActionRecord,
  DbWorkerClient,
  SafetyStateRecord,
} from '@buddy/storage';
import type { EnvironmentInput } from './api-environment.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';

// 版の照合を api-auto-actions.ts で行う経路（core.ts が環境の revisionMatches を切り替える）。
export const AUTO_ACTION_REVISION_CHECKED_ROUTES: ReadonlySet<string> = new Set(
  ['resumeSafety'],
);

export type AutoActionRoutesStore = Pick<DbWorkerClient, 'safety'>;

export interface AutoActionRoutesOptions {
  readonly store: AutoActionRoutesStore;
  // UTC のミリ秒。取り消しの期限の判定と、解除の時刻に使う。
  readonly now: () => number;
}

export interface AutoActionRoutes {
  readonly handlers: {
    readonly listAutoActions: ApiRouteHandler;
    readonly resumeSafety: ApiRouteHandler;
  };
  // resumeSafety の expected_revision の照合。保存済みの安全停止の版と本文の版を比べる。
  // 読めなければ例外にし、経路の検査が 503 で閉じる（「状態が変わりました」と見せない）。
  revisionMatches(input: EnvironmentInput): Promise<boolean>;
}

const stringOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const iso = (ms: number): string => new Date(ms).toISOString();

// 保存層の安全停止の状態を契約の SafetyState にする。
export function safetyState(record: SafetyStateRecord): object {
  return {
    state: record.state,
    safety_revision: record.safety_revision,
    stop_reason: record.stop_reason,
    stopped_at: record.stopped_at === null ? null : iso(record.stopped_at),
    auto_approvals: record.auto_approvals,
  };
}

// 保存層の自動実行を契約の AutoActionItem にする。時刻・版は保存層が契約の形（ISO・10 進文字列）で返す。
export function autoActionItem(record: AutoActionRecord): object {
  return {
    operation_id: record.operation_id,
    action_kind: record.action_kind,
    policy_version: record.policy_version,
    state_revision: record.state_revision,
    completed_at: record.completed_at,
    undo_state: record.undo_state,
    undo_deadline: record.undo_deadline,
    undo_target: record.undo_target,
  };
}

export function autoActionList(record: AutoActionListRecord): object {
  return {
    safety: safetyState(record.safety),
    items: record.items.map(autoActionItem),
  };
}

// 解除の拒否の理由のうち、状態が変わったことを表すもの（409）。読み直せば確かめられる。
const CONFLICT_REASONS: readonly string[] = [
  'safety_revision_changed',
  'safety_not_stopped',
];

export function createAutoActionRoutes(
  options: AutoActionRoutesOptions,
): AutoActionRoutes {
  const { store, now } = options;

  const authenticated =
    (
      run: (
        request: ApiHandlerRequest & {
          device: NonNullable<ApiHandlerRequest['device']>;
        },
      ) => Promise<{ status: number; body: object }>,
    ): ApiRouteHandler =>
    async (request) => {
      if (request.device === null)
        return apiErrorResponse(401, 'unauthenticated');
      try {
        return await run({ ...request, device: request.device });
      } catch {
        return apiErrorResponse(
          503,
          'dependency_unavailable',
          stringOf(request.body?.['request_id']) || null,
        );
      }
    };

  const listAutoActions = authenticated(async () => {
    const result = await store.safety({
      kind: 'safety.auto_actions',
      now: now(),
    });
    if (!result.ok) return apiErrorResponse(503, 'dependency_unavailable');
    return { status: 200, body: autoActionList(result.value) };
  });

  const resumeSafety = authenticated(async (request) => {
    const requestId = stringOf(request.body?.['request_id']) || null;
    const result = await store.safety({
      kind: 'safety.resume',
      device_id: request.device.device_id,
      expected_safety_revision: stringOf(
        request.body?.['expected_safety_revision'],
      ),
      now: now(),
    });
    if (result.ok) return { status: 200, body: safetyState(result.value) };
    if (result.outcome === 'rejected') {
      if (result.reasons.some((reason) => CONFLICT_REASONS.includes(reason)))
        return apiErrorResponse(409, 'conflict', requestId);
      // 照合の後に失効した端末。
      if (result.reasons.includes('device_not_registered'))
        return apiErrorResponse(401, 'unauthenticated', requestId);
    }
    return apiErrorResponse(503, 'dependency_unavailable', requestId);
  });

  return {
    handlers: { listAutoActions, resumeSafety },
    async revisionMatches(input) {
      if (input.device === null) return false;
      const result = await store.safety({ kind: 'safety.state' });
      if (!result.ok) throw new Error('safety_state_unavailable');
      return (
        result.value.safety_revision ===
        stringOf(input.body?.['expected_safety_revision'])
      );
    },
  };
}
