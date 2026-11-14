// 連携の接続の一覧・取得対象の読み取りと、本人の選択の変更（設計 04 取得する対象、設計 11 §1A、B08-02、ADR 0086〜0089）。
//
// 経路の検査（端末トークン・自宅判定・ロック解除・画面の操作・接続範囲・版の照合）は api-server の admission が先に行う。
// ここは検査を通った要求の処理で、判定の正本は保存層（connection-targets-store.ts）と domain の validateFetchScope。
// - 新しい経路は作らない。B08-01（ADR 0071）で足した GET /targets と、B03 の PUT /targets・GET /connections の処理を作る。
// - OAuth トークン・credential_ref は返さない。応答は ConnectionSummary の項目だけ。
// - 選択の変更は許可版の一致が条件（compare-and-swap）。版が合わない・接続がない・切断済みは 409 conflict で、
//   新しいカレンダー・フォルダーを足すのも、期間・サイズの上限を超えるのも、本人の選択（本文）だけが決める。
//   同じ request_id の再送は、成功済みなら許可版が進んでいるので 409 になる（二重に効かない）。画面は読み直して確かめる。
// - 想定外の保存の失敗・成否不明は 503 dependency_unavailable にし、成功にも版の不一致にも見せない。

import type { DbWorkerClient } from '@buddy/storage';
import type { ConnectionRecord } from '@buddy/storage';
import type { EnvironmentInput } from './api-environment.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import type { JsonObject } from './strict-json.js';

// 版の照合を api-connections.ts で行う経路（core.ts が環境の revisionMatches を切り替える）。
export const CONNECTION_REVISION_CHECKED_ROUTES: ReadonlySet<string> = new Set([
  'updateConnectionTargets',
]);

export type ConnectionRoutesStore = Pick<DbWorkerClient, 'connectionTargets'>;

export interface ConnectionRoutesOptions {
  readonly store: ConnectionRoutesStore;
}

export interface ConnectionRoutes {
  readonly handlers: {
    readonly listConnections: ApiRouteHandler;
    readonly getConnectionTargets: ApiRouteHandler;
    readonly updateConnectionTargets: ApiRouteHandler;
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
    },
    revisionMatches,
  };
}
