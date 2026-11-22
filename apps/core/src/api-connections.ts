// 連携の接続の一覧・取得対象の読み取りと、本人の選択の変更（設計 04 取得する対象、設計 11 §1A、B08-02、ADR 0086〜0089）。
// 同期の状態の読み取り（getConnectionSync）は B08-05 で足した（ADR 0136）。
//
// 経路の検査（端末トークン・自宅判定・ロック解除・画面の操作・接続範囲・版の照合）は api-server の admission が先に行う。
// ここは検査を通った要求の処理で、判定の正本は保存層（connection-targets-store.ts）と domain の validateFetchScope。
// - 新しい経路は作らない。B08-01（ADR 0071）で足した GET /targets と、B03 の PUT /targets・GET /connections の処理を作る。
// - OAuth トークン・credential_ref は返さない。応答は ConnectionSummary の項目だけ。
// - 選択の変更は許可版の一致が条件（compare-and-swap）。版が合わない・接続がない・切断済みは 409 conflict で、
//   新しいカレンダー・フォルダーを足すのも、期間・サイズの上限を超えるのも、本人の選択（本文）だけが決める。
//   同じ request_id の再送は、成功済みなら許可版が進んでいるので 409 になる（二重に効かない）。画面は読み直して確かめる。
// - 想定外の保存の失敗・成否不明は 503 dependency_unavailable にし、成功にも版の不一致にも見せない。

import { CONNECTOR_RETRY_POLICY } from '@buddy/domain';
import type { DbWorkerClient } from '@buddy/storage';
import type { ConnectionRecord } from '@buddy/storage';
import type { SyncBatchRecord, SyncScopeRecord } from '@buddy/storage';
import type { EnvironmentInput } from './api-environment.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import type { JsonObject } from './strict-json.js';

// 版の照合を api-connections.ts で行う経路（core.ts が環境の revisionMatches を切り替える）。
export const CONNECTION_REVISION_CHECKED_ROUTES: ReadonlySet<string> = new Set([
  'updateConnectionTargets',
]);

export type ConnectionRoutesStore = Pick<
  DbWorkerClient,
  'connectionTargets' | 'sync'
>;

export interface ConnectionRoutesOptions {
  readonly store: ConnectionRoutesStore;
}

export interface ConnectionRoutes {
  readonly handlers: {
    readonly listConnections: ApiRouteHandler;
    readonly getConnectionTargets: ApiRouteHandler;
    readonly updateConnectionTargets: ApiRouteHandler;
    readonly getConnectionSync: ApiRouteHandler;
  };
  // updateConnectionTargets の expected_revision の照合。保存済みの許可版と本文の版を比べる。
  // 読めなければ例外にし、経路の検査が 503 で閉じる（「内容が変わりました」と見せない）。
  revisionMatches(input: EnvironmentInput): Promise<boolean>;
}

const stringOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

// 保存層の接続を契約の ConnectionSummary にする。トークン・credential_ref・保存の状態は出さない。
export function connectionSummary(record: ConnectionRecord): object {
  return {
    connection_id: record.connection_id,
    provider: record.provider,
    status: record.status,
    access: record.access,
    granted_scopes: [...record.granted_scopes],
    targets: {
      calendar_ids: [...record.targets.calendar_ids],
      mail_container_ids: [...record.targets.mail_container_ids],
      attachment_kinds: [...record.targets.attachment_kinds],
      mail_lookback_days: record.targets.mail_lookback_days,
      calendar_past_days: record.targets.calendar_past_days,
      calendar_future_days: record.targets.calendar_future_days,
      attachment_max_bytes: record.targets.attachment_max_bytes,
    },
    permission_revision: record.permission_revision,
    scope_revision: record.scope_revision,
  };
}

// 保存層の取得集合を契約の SyncScopeState にする。時刻・版は保存層が契約の形（ISO・10 進文字列）で返す。
export function syncScopeState(scope: SyncScopeRecord): object {
  return {
    scope_id: scope.scope_id,
    scope_revision: scope.scope_revision,
    active_scan_id: scope.active_scan_id,
    active_generation: scope.active_generation,
    committed_watermark: scope.committed_watermark,
    provider_cursor: scope.provider_cursor,
    executor_generation: scope.executor_generation,
    last_incremental_completed_at: scope.last_incremental_completed_at,
    last_full_reconciled_at: scope.last_full_reconciled_at,
    pending_incremental: scope.pending_incremental,
    pending_full: scope.pending_full,
    analysis_plan_complete_generation: scope.analysis_plan_complete_generation,
  };
}

// 保存層の走査を契約の SyncBatch にする。
export function syncBatch(batch: SyncBatchRecord): object {
  return {
    scan_id: batch.scan_id,
    scope_id: batch.scope_id,
    scope_revision: batch.scope_revision,
    kind: batch.kind,
    status: batch.status,
    scan_started_at: batch.scan_started_at,
    window_start: batch.window_start,
    window_end: batch.window_end,
    query_fingerprint: batch.query_fingerprint,
    base_generation: batch.base_generation,
    base_watermark: batch.base_watermark,
    base_provider_cursor: batch.base_provider_cursor,
    executor_generation: batch.executor_generation,
    page_cursor: batch.page_cursor,
    diff_count: batch.diff_count,
  };
}

// 状態が変わったことを表す拒否（409）。再読み込みで確かめられる。
const CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'permission_revision_mismatch',
  'connection_not_found',
  'connection_disconnected',
]);

export function createConnectionRoutes(
  options: ConnectionRoutesOptions,
): ConnectionRoutes {
  const { store } = options;

  const listConnections: ApiRouteHandler = async () => {
    const result = await store.connectionTargets({ kind: 'connections.list' });
    if (!result.ok) return apiErrorResponse(503, 'dependency_unavailable');
    return {
      status: 200,
      body: { connections: result.value.map(connectionSummary) },
    };
  };

  const getConnectionTargets: ApiRouteHandler = async (request) => {
    const result = await store.connectionTargets({
      kind: 'connections.get',
      connection_id: request.params['connection_id'] ?? '',
    });
    if (!result.ok) {
      // 形の合わない ID は入力の不正。それ以外の失敗は読めないだけ。
      return result.reasons.includes('connection_id_invalid')
        ? apiErrorResponse(422, 'invalid_input')
        : apiErrorResponse(503, 'dependency_unavailable');
    }
    // 契約に 404 は無い。存在しない接続は、指した ID が不正な入力として返す。
    if (result.value === null) return apiErrorResponse(422, 'invalid_input');
    return { status: 200, body: connectionSummary(result.value) };
  };

  const updateConnectionTargets: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body['request_id']);
    const result = await store.connectionTargets({
      kind: 'connections.update_targets',
      connection_id: request.params['connection_id'] ?? '',
      expected_permission_revision: stringOf(
        body['expected_permission_revision'],
      ),
      // 形と上限は経路の検査が JSON Schema で済ませている。保存層が domain の規則でもう一度確かめる。
      targets: body['targets'] as never,
    });
    if (result.ok) {
      return { status: 200, body: connectionSummary(result.value.connection) };
    }
    if (result.outcome === 'rejected') {
      if (result.reasons.every((reason) => CONFLICT_REASONS.has(reason)))
        return apiErrorResponse(409, 'conflict', requestId);
      if (
        result.reasons.includes('targets_invalid') ||
        result.reasons.includes('connection_id_invalid') ||
        result.reasons.includes('expected_permission_revision_invalid')
      )
        return apiErrorResponse(422, 'invalid_input', requestId);
    }
    // 成否不明・想定外の保存の失敗・書込みの停止は、成功にも版の不一致にも見せない。
    return apiErrorResponse(503, 'dependency_unavailable', requestId);
  };

  // 同期の状態（B08-05、ADR 0136）。契約の応答は接続につき 1 つの取得集合の状態だけを持つので、
  // 保存層が返す最初の取得集合（scope_id 順）を使う。取得集合がまだ無い接続は、状態を作らず 503 で閉じる
  // （取得集合の作成は接続の作成（B03-04）の責務）。トークン・本文は応答に載せない。
  const getConnectionSync: ApiRouteHandler = async (request) => {
    const connectionId = request.params['connection_id'] ?? '';
    const connection = await store.connectionTargets({
      kind: 'connections.get',
      connection_id: connectionId,
    });
    if (!connection.ok) {
      return connection.reasons.includes('connection_id_invalid')
        ? apiErrorResponse(422, 'invalid_input')
        : apiErrorResponse(503, 'dependency_unavailable');
    }
    if (connection.value === null)
      return apiErrorResponse(422, 'invalid_input');
    const scopes = await store.sync({
      kind: 'sync.list_scopes',
      connection_id: connectionId,
    });
    if (!scopes.ok) return apiErrorResponse(503, 'dependency_unavailable');
    const snapshot = scopes.value[0];
    if (snapshot === undefined)
      return apiErrorResponse(503, 'dependency_unavailable');
    return {
      status: 200,
      body: {
        connection_id: connection.value.connection_id,
        provider: connection.value.provider,
        scope_revision: connection.value.scope_revision,
        state: syncScopeState(snapshot.scope),
        active_batch:
          snapshot.active_batch === null
            ? null
            : syncBatch(snapshot.active_batch),
        retry: { ...CONNECTOR_RETRY_POLICY },
        last_attempt_at: snapshot.last_attempt_at,
      },
    };
  };

  const revisionMatches = async (input: EnvironmentInput): Promise<boolean> => {
    const result = await store.connectionTargets({
      kind: 'connections.get',
      connection_id: input.params['connection_id'] ?? '',
    });
    if (!result.ok) throw new Error('connection_unavailable');
    if (result.value === null) return false;
    return (
      stringOf(input.body?.['expected_permission_revision']) ===
      result.value.permission_revision
    );
  };

  return {
    handlers: {
      listConnections,
      getConnectionTargets,
      updateConnectionTargets,
      getConnectionSync,
    },
    revisionMatches,
  };
}
