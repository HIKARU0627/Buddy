// スナップショット・イベントの再取得・操作の取得・承認・取消の経路（設計 07 §1〜§4、08 §1・§3、ADR 0009・0018・0023）。
//
// - 経路の検査（ROUTE_CHECKS）は api-server.ts が先に行う。ここは検査を通った要求の処理だけ。
// - getSnapshot: 操作の状態とイベントの境界を DB worker の一つの読み取りで取り、境界を event_cursor にする。
//   ロック中・ロック状態不明は管理情報だけ（management_only。会話・候補・操作を含めない）。
// - getEvents: cursor の後のイベントを 1 ページ返す。DB 世代違い・期限切れ・欠けは resnapshot_required。
// - 承認・取消: DB worker の命令（operation.approve・operation.cancel）へつなぐ。受付は接続範囲＋request_id と
//   要求の照合値で command_receipts に記録され、同じ内容の再送は保存済みの結果、内容が違えば 409（07 §3、X04）。
//   古い接続範囲は経路の検査で 410。命令を送った後の通知でイベントを配る（event-feed.ts）。
// - 応答・イベントに本文（確定 intent）・宛先・トークンを入れない。

import { createHash, randomUUID } from 'node:crypto';
import type {
  CancelOperationCommand,
  ApproveOperationCommand,
  DbCommand,
  DbCommandOutcome,
  DbSubmission,
  OperationView,
} from '@buddy/storage';
import type {
  EnvironmentInput,
  RequestEnvironment,
} from './api-environment.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import {
  cursorReplayDecision,
  decodeEventCursor,
  encodeEventCursor,
} from './event-cursor.js';
import type { EventFeed, EventQueryStore } from './event-feed.js';
import type { JsonObject, JsonValue } from './strict-json.js';

export interface OperationRouteStore extends EventQueryStore {
  submit(command: DbCommand): DbSubmission;
}

// preview の有効性（07 §3: 端末・接続範囲・表示内容に結び付き、接続終了・ロック・内容変更で無効）。
// 発行と照合は api-turns.ts（ADR 0029）。渡されなければ「有効な preview はない」（安全側）。
export type PreviewCheck = (input: {
  readonly device_id: string;
  readonly command_scope_id: string;
  readonly operation_id: string;
  readonly preview_id: string;
  readonly content_version: string;
  readonly content_hash: string;
}) => boolean | Promise<boolean>;

export interface OperationRoutesOptions {
  readonly store: OperationRouteStore;
  readonly feed: EventFeed;
  readonly coreInstanceId: string;
  // 経路の検査と同じ環境（ロック状態の判定に使う）。
  readonly environment: RequestEnvironment;
  readonly now?: () => number;
  readonly previewValid?: PreviewCheck;
  // 承認の命令を送る直前（同期）に preview がまだ無効化されていないか（ADR 0029）。previewValid の非同期の
  // 照合の後にロック・接続の終了が起きても取り逃さないため、命令の送信と同じ同期の区間で確かめる。
  readonly previewCurrent?: (previewId: string) => boolean;
}

// 版の照合（expected_revision）をこのファイルで行う経路。
export const REVISION_CHECKED_ROUTES: ReadonlySet<string> = new Set([
  'approveOperation',
  'cancelOperation',
]);

// 表示の補助（allowed_actions）。認可ではない（実行の可否は経路の検査と DB worker の命令が決める）。
const ALLOWED_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  awaiting_approval: ['preview', 'approve', 'cancel'],
  approved: ['cancel'],
  preparing: ['cancel'],
  dispatching: [],
  reconciling: [],
  unknown_held: ['reconcile'],
  not_executed: ['retry'],
  succeeded: [],
  cancelled: [],
  superseded: [],
};

// 契約の approval_state には consumed がない。使い終えた承認は承認済みとして valid で表す（ADR 0023 の読み取り）。
const APPROVAL_STATE: Readonly<Record<string, string>> = {
  none: 'none',
  valid: 'valid',
  consumed: 'valid',
  revoked: 'revoked',
  expired: 'expired',
};

const RESULT_STATUSES = new Set([
  'confirmed_success',
  'confirmed_not_executed',
  'unknown',
]);

// 操作の表示（契約の OperationSnapshot）。
export function operationSnapshot(view: OperationView): object {
  const result =
    view.result_status !== null && RESULT_STATUSES.has(view.result_status)
      ? {
          status: view.result_status,
          provider_receipt_id: view.external_id,
        }
      : null;
  return {
    operation_id: view.operation_id,
    operation_kind: view.operation_kind,
    content_version: view.current_content_version,
    content_hash: view.content_hash,
    state_revision: view.state_revision,
    state: view.state,
    approval_state: APPROVAL_STATE[view.approval_status] ?? 'none',
    allowed_actions: [...(ALLOWED_ACTIONS[view.state] ?? [])],
    result,
  };
}

// 入出力の状態の正本は B05。今は安全側の値（入力不可・音声なし）に、判定したロック状態だけを入れる。
function ioState(
  deviceId: string,
  lockState: 'unlocked' | 'locked' | 'unknown',
): object {
  return {
    device_id: deviceId,
    io_epoch: '0',
    output_epoch: '0',
    lock_state: lockState,
    stop_scope: 'none',
    input_permitted: false,
    voice_state: 'waiting_wake_word',
    output_mode: 'text',
    private_conversation: false,
    audio_lease_valid: false,
  };
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as JsonObject;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(object[key] as JsonValue)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// 要求の照合値（07 §3）。経路・対象・本文（キー順の JSON）の SHA-256。同じ request_id で経路・対象・本文の
// どれかが違えば別の値になり、DB worker が 409（command_id_reused・request_conflict）で拒否する。
export function requestHash(
  operationId: string,
  targetId: string,
  body: JsonObject,
): string {
  return createHash('sha256')
    .update(stableJson({ route: operationId, target: targetId, body }), 'utf8')
    .digest('hex');
}

// 端末の要求の命令 ID。接続範囲と request_id から決まる値（UUID v4 の形）にする。同じ要求の再送は同じ command_id に
// なり、DB worker が command_receipts の保存済みの結果を返す（DbWorkerClient は結果の command_id が送った命令と
// 同じことを確かめるため、再送ごとに新しい ID を作ると保存済みの結果を受け取れない）。同じ接続範囲・request_id で
// 経路・対象・本文が違えば、DB worker は command_id_reused で拒否する（409）。
export function deviceCommandId(
  commandScopeId: string,
  requestId: string,
): string {
  const bytes = createHash('sha256')
    .update(`buddy/device-command/v1\0${commandScopeId}\0${requestId}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// DB worker の拒否の理由のうち、内容・状態が変わった（最新を読み直す）もの。他は中枢側の保留（503）。
const CONFLICT_REASONS = new Set([
  'request_conflict',
  'command_id_reused',
  'state_revision_changed',
  'content_version_changed',
  'content_hash_mismatch',
  'approval_conflict',
  'not_awaiting_approval',
  'preview_invalid',
  'operation_finished',
  'transition_not_allowed',
  'request_revision_changed',
  'permission_changed',
  'forgetting_generation_changed',
  'operation_not_found',
  'workflow_not_found',
]);

// 命令の結果を CommandReceipt（202）へ写す。durable・accepted は受付の記録で、外部変更の成功ではない。
export function receiptResponse(
  requestId: string,
  outcome: DbCommandOutcome,
): { status: number; body: object } {
  if (outcome.outcome === 'durable')
    return {
      status: 202,
      body: {
        request_id: requestId,
        command_id: outcome.command_id,
        operation_id: outcome.operation_id,
        state_revision: outcome.committed_state_revision,
        status: 'durable',
        committed_state_revision: outcome.committed_state_revision,
      },
    };
  if (outcome.outcome === 'accepted')
    return {
      status: 202,
      body: {
        request_id: requestId,
        command_id: outcome.command_id,
        operation_id: outcome.operation_id,
        state_revision: outcome.state_revision,
        status: 'accepted',
        committed_state_revision: null,
      },
    };
  if (
    outcome.outcome === 'rejected' &&
    outcome.reasons.some((reason) => CONFLICT_REASONS.has(reason))
  )
    return apiErrorResponse(409, 'conflict', requestId);
  // 成否不明（unknown）・DB worker の停止など。同じ request_id で送り直せば、保存済みなら同じ結果が返る。
  return apiErrorResponse(503, 'dependency_unavailable', requestId);
}

const stringOf = (body: JsonObject | null, key: string): string => {
  const value = body?.[key];
  return typeof value === 'string' ? value : '';
};

export interface OperationRoutes {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
  // approveOperation・cancelOperation の版の照合（RequestEnvironment.revisionMatches）。
  revisionMatches(input: EnvironmentInput): Promise<boolean>;
}

export function createOperationRoutes(
  options: OperationRoutesOptions,
): OperationRoutes {
  const { store, feed, environment } = options;
  const now = options.now ?? (() => Date.now());
  const previewValid: PreviewCheck = options.previewValid ?? (() => false);
  const previewCurrent = options.previewCurrent ?? (() => true);

  const lockStateOf = async (request: ApiHandlerRequest) =>
    environment.lockState({
      operationId: request.route.operationId,
      device: request.device,
      remoteAddress: request.remoteAddress,
      params: request.params,
      body: request.body,
      declaredLockState: request.declaredLockState,
    });

  const getSnapshot: ApiRouteHandler = async (request) => {
    const device = request.device;
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const lockState = await lockStateOf(request);
    const full = lockState === 'unlocked';
    const snapshot = await store.query({ kind: 'snapshot' });
    return {
      status: 200,
      body: {
        store_generation: snapshot.store_generation,
        core_instance_id: options.coreInstanceId,
        event_cursor: encodeEventCursor({
          storeGeneration: snapshot.store_generation,
          sequence: snapshot.max_sequence,
          issuedAt: now(),
        }),
        view: full ? 'full' : 'management_only',
        io_state: ioState(device.device_id, lockState),
        // 会話・候補の正本は後の工程（B05・B10）。今は空。
        sessions: [],
        candidates: [],
        operations: full ? snapshot.operations.map(operationSnapshot) : [],
      },
    };
  };

  const getEvents: ApiRouteHandler = async (request) => {
    const raw = request.query['cursor'] ?? '';
    const cursor = decodeEventCursor(raw);
    if (cursor === null) return apiErrorResponse(422, 'invalid_input');
    const resnapshot = {
      status: 200,
      // 再スナップショットが要る。cursor は受け取った値をそのまま返す（続きの位置として使わせない）。
      body: { events: [], event_cursor: raw, resnapshot_required: true },
    };
    // DB 世代と発行からの期限を先に見る（範囲は読み取りと同じ照会で見る）。
    const early = cursorReplayDecision(cursor, {
      storeGeneration: feed.storeGeneration,
      now: now(),
      minSequence: null,
      maxSequence: Number.MAX_SAFE_INTEGER,
    });
    if (!early.ok) return resnapshot;
    const batch = await feed.read(cursor.sequence);
    if (batch.kind === 'resnapshot') return resnapshot;
    return {
      status: 200,
      body: {
        events: batch.events,
        event_cursor: encodeEventCursor({
          storeGeneration: feed.storeGeneration,
          sequence: batch.sequence,
          issuedAt: now(),
        }),
        resnapshot_required: false,
      },
    };
  };

  const getOperation: ApiRouteHandler = async (request) => {
    const view = await store.query({
      kind: 'operation_view',
      operation_id: request.params['id'] ?? '',
    });
    // 契約に「対象がない」のコードがないため、形式の不正（422）として返す（ADR 0023 の読み取り）。
    if (view === null) return apiErrorResponse(422, 'invalid_input');
    return { status: 200, body: operationSnapshot(view) };
  };

  // 承認・取消の命令の共通部分。
  const commandBase = (request: ApiHandlerRequest, view: OperationView) => {
    const body = request.body as JsonObject;
    const operationId = request.params['id'] ?? '';
    const scopeId = stringOf(body, 'command_scope_id');
    const requestId = stringOf(body, 'request_id');
    return {
      command_id: deviceCommandId(scopeId, requestId),
      operation_id: operationId,
      expected_state_revision: stringOf(body, 'expected_state_revision'),
      request_revision: view.request_revision,
      // 操作に連携の接続の列がないため、許可の版は DB で照合しない（ADR 0018 の読み取り）。
      permission_revision: '0',
      forgetting_generation: view.forgetting_generation,
      connection_id: null,
      request: {
        command_scope_id: scopeId,
        request_id: requestId,
        request_hash: requestHash(request.route.operationId, operationId, body),
      },
    };
  };

  const submit = async (
    request: ApiHandlerRequest,
    build: (view: OperationView) => Promise<DbCommand>,
  ) => {
    const requestId = stringOf(request.body, 'request_id');
    const view = await store.query({
      kind: 'operation_view',
      operation_id: request.params['id'] ?? '',
    });
    if (view === null) return apiErrorResponse(409, 'conflict', requestId);
    const built = await build(view);
    // 承認では、送る直前に preview の生死を同期で確かめ直す（この後の無効化は承認の後の出来事になる）。
    const command: DbCommand =
      built.kind === 'operation.approve' &&
      built.preview_valid &&
      (built.preview_id === null || !previewCurrent(built.preview_id))
        ? { ...built, preview_valid: false }
        : built;
    const outcome = await store.submit(command).result;
    return receiptResponse(requestId, outcome);
  };

  const approveOperation: ApiRouteHandler = (request) =>
    submit(request, async (view): Promise<ApproveOperationCommand> => {
      const device = request.device;
      const body = request.body;
      const base = commandBase(request, view);
      const contentVersion = stringOf(body, 'content_version');
      const contentHash = stringOf(body, 'content_hash');
      const previewId = stringOf(body, 'preview_id');
      const valid =
        device === null
          ? false
          : await previewValid({
              device_id: device.device_id,
              command_scope_id: base.request.command_scope_id,
              operation_id: base.operation_id,
              preview_id: previewId,
              content_version: contentVersion,
              content_hash: contentHash,
            });
      return {
        ...base,
        kind: 'operation.approve',
        approval_id: randomUUID(),
        route: 'screen',
        content_version: contentVersion,
        content_hash: contentHash,
        device_id: device?.device_id ?? null,
        preview_id: previewId,
        preview_valid: valid === true,
        policy_version: null,
        current_policy_version: '0',
      };
    });

  const cancelOperation: ApiRouteHandler = (request) =>
    submit(request, async (view): Promise<CancelOperationCommand> => ({
      ...commandBase(request, view),
      kind: 'operation.cancel',
    }));

  // 版の照合。保存済みの受付（同じ接続範囲・request_id）があれば DB worker の再送の判定に任せる（同じ内容は
  // 保存済みの結果、違えば 409）。承認では、同じ内容版・hash の有効な承認がすでにあれば DB worker が現在の版を
  // 返す（X02、approvalDecision の existing）ので、状態版が進んでいても 409 にしない。
  const revisionMatches = async (input: EnvironmentInput): Promise<boolean> => {
    const body = input.body;
    const scopeId = stringOf(body, 'command_scope_id');
    const requestId = stringOf(body, 'request_id');
    if (scopeId !== '' && requestId !== '') {
      const stored = await store.query({
        kind: 'receipt_exists',
        command_scope_id: scopeId,
        request_id: requestId,
      });
      if (stored) return true;
    }
    const view = await store.query({
      kind: 'operation_view',
      operation_id: input.params['id'] ?? '',
    });
    if (view === null) return false;
    if (stringOf(body, 'expected_state_revision') === view.state_revision)
      return true;
    return (
      input.operationId === 'approveOperation' &&
      (view.approval_status === 'valid' ||
        view.approval_status === 'consumed') &&
      stringOf(body, 'content_version') === view.current_content_version &&
      stringOf(body, 'content_hash') === view.content_hash
    );
  };

  return {
    handlers: {
      getSnapshot,
      getEvents,
      getOperation,
      approveOperation,
      cancelOperation,
    },
    revisionMatches,
  };
}
