// 自動実行の一覧と安全停止の解除の経路（設計 03「取り消しと安全停止」、07 §2、J12、B13-05、ADR 0152）。
//
// 経路の検査（端末トークン・自宅判定・ロック解除・画面の操作・接続範囲・版の照合）は api-server の admission が先に行う。
// ここは検査を通った要求の処理で、判定の正本は保存層（safety-store.ts）と domain の autoActionUndoState。
// - 一覧（GET /v1/auto-actions）は安全停止の状態と自動実行した操作を一つの読み取りで返す。本文（確定 intent）は返さない。
// - 取り消し（POST /v1/auto-actions/{id}/undo）は補償の操作を新しい operation_id で作る（ADR 0153）。今はメールの
//   ラベルの変更（label_mail）だけで、提供元の読み書きの口があるときだけ取り消せるように見せる。他の種類は unavailable。
//   一覧での本人の押下が J12 の確認で、補償の操作は画面の承認つきで作り、すぐ実行担当へ渡す。作る前に対象のメールを
//   読み直し、ラベルが自動実行の後に変わっていれば 409（target_changed）で自動では戻さない。期限切れは 410（undo_expired）。
//   同じ接続範囲・request_id の再送は保存済みの受付結果、内容が違えば 409（07 §3）。
// - 解除（POST /v1/safety/resume）は登録済みの端末の画面操作だけ。版（expected_safety_revision）は DB の現在値で
//   照合し、解除の transaction の中でも同じ値で照合し直す（compare-and-swap）。同じ request_id の再送は、成功済みなら
//   版が進んでいるので 409 になる（二重に効かない）。画面は読み直して確かめる。
// - 想定外の保存の失敗・成否不明は 503 dependency_unavailable にし、成功にも版の不一致にも見せない。

import { randomUUID } from 'node:crypto';
import type { AutoActionKind } from '@buddy/domain';
import { openOperationIntent, sealOperationIntent } from '@buddy/storage';
import type {
  AutoActionListRecord,
  AutoActionRecord,
  CreateOperationCommand,
  DataKeyMaterial,
  DbWorkerClient,
  SafetyStateRecord,
} from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import type { EnvironmentInput } from './api-environment.js';
import {
  deviceCommandId,
  durableReceiptResponse,
  receiptResponse,
  requestHash,
} from './api-operations.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import type { JsonObject } from './strict-json.js';
import { canRead, canWrite } from './turn-ports.js';
import type {
  ProviderConnection,
  ProviderMailTarget,
  ProviderReader,
} from './turn-ports.js';

// 版の照合を api-auto-actions.ts で行う経路（core.ts が環境の revisionMatches を切り替える）。
export const AUTO_ACTION_REVISION_CHECKED_ROUTES: ReadonlySet<string> = new Set(
  ['resumeSafety', 'undoAutoAction'],
);

export type AutoActionRoutesStore = Pick<
  DbWorkerClient,
  'safety' | 'query' | 'conversation' | 'submit'
>;

// 取り消しに使う口（ADR 0153）。渡さなければ取り消しの経路は 503 で、一覧はどれも取り消せるように見せない。
export interface AutoActionUndoPorts {
  // 対象のメールの読み直し（読み取りだけ）。
  readonly provider: ProviderReader;
  readonly contract: ApiContract;
  // 要求ごとに読むデータ鍵（保持しない）。読めなければ null。
  readonly dataKey: () => Promise<DataKeyMaterial | null>;
  // 補償の操作を保存した後に実行担当へ渡す（OperationRunner.afterApproval）。
  readonly afterApproval: (operationId: string) => void;
  // 保存期限の掃除のゲート（ADR 0043・0053）。掃除が済むまで提供元を読まない。省略したときは確かめない（試験）。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => {
      readonly search: boolean;
      readonly cloud_send: boolean;
    };
    readonly lease: () => (() => void) | null;
  };
}

export interface AutoActionRoutesOptions {
  readonly store: AutoActionRoutesStore;
  // UTC のミリ秒。取り消しの期限の判定と、解除の時刻に使う。
  readonly now: () => number;
  readonly undo?: AutoActionUndoPorts | null;
}

export interface AutoActionRoutes {
  readonly handlers: {
    readonly listAutoActions: ApiRouteHandler;
    readonly resumeSafety: ApiRouteHandler;
    readonly undoAutoAction: ApiRouteHandler;
  };
  // resumeSafety・undoAutoAction の expected_revision の照合。保存済みの版と本文の版を比べる。
  // 読めなければ例外にし、経路の検査が 503 で閉じる（「状態が変わりました」と見せない）。
  revisionMatches(input: EnvironmentInput): Promise<boolean>;
}

// 補償の操作を作れる種類（ADR 0153）。下書き・用事の補償は操作の種類が契約にまだない（U310）。
export const UNDOABLE_KINDS: readonly AutoActionKind[] = ['label_mail'];

// 掃除の貸し出しを取り直す回数（発言の入口・候補の自動実行と同じ）。
const LEASE_ATTEMPTS = 3;

// 補償の操作の ID。接続範囲と request_id から決まる値にし、同じ要求の再送・成否不明の後の送り直しが同じ操作になる
// ようにする（DB worker が保存済みの受付を返す）。命令の ID とは別の値にする（Id の形は \0 を含まない）。
export function undoOperationId(
  commandScopeId: string,
  requestId: string,
): string {
  return deviceCommandId(commandScopeId, `${requestId}\0undo-operation`);
}

// 自動実行のラベルの変更の確定 intent から、補償に使う項目を取り出す。形が違えば null。
interface LabelChange {
  readonly provider: string;
  readonly account_id: string;
  readonly remote_id: string;
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;

export function labelChangeOf(
  intent: Record<string, unknown>,
): LabelChange | null {
  const target = intent['target'] as Record<string, unknown> | undefined;
  const action = intent['action'] as Record<string, unknown> | undefined;
  const add = stringList(action?.['add']);
  const remove = stringList(action?.['remove']);
  if (
    action?.['kind'] !== 'mail.labels.change' ||
    typeof intent['provider'] !== 'string' ||
    typeof intent['account_id'] !== 'string' ||
    typeof target?.['remote_id'] !== 'string' ||
    add === null ||
    remove === null
  )
    return null;
  return {
    provider: intent['provider'],
    account_id: intent['account_id'],
    remote_id: target['remote_id'],
    add,
    remove,
  };
}

// 自動実行の後に対象のラベルが変わっていないか。足したラベルがすべて残り、外したラベルがどれも戻っていないこと。
export function labelsUnchanged(
  target: Pick<ProviderMailTarget, 'labels'>,
  change: Pick<LabelChange, 'add' | 'remove'>,
): boolean {
  return (
    change.add.every((label) => target.labels.includes(label)) &&
    change.remove.every((label) => !target.labels.includes(label))
  );
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
  const undo = options.undo ?? null;
  const undoableKinds: readonly AutoActionKind[] =
    undo === null ? [] : UNDOABLE_KINDS;

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
      undoable_kinds: undoableKinds,
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

  // 掃除のゲートを確かめ、貸し出しを持ったまま提供元を読む。ゲートが閉じていれば null。
  const withLease = async <T>(read: () => Promise<T>): Promise<T | null> => {
    const retention = undo?.retention;
    if (retention === undefined) return read();
    let release: (() => void) | null = null;
    for (
      let attempt = 0;
      release === null && attempt < LEASE_ATTEMPTS;
      attempt += 1
    ) {
      await retention.ready();
      const gate = retention.gate();
      if (!gate.search || !gate.cloud_send) return null;
      // 取れないのは、ready の後に別の掃除が始まったとき。その掃除が済むのを待って確かめ直す。
      release = retention.lease();
    }
    if (release === null) return null;
    try {
      return await read();
    } finally {
      release();
    }
  };

  type TargetRead =
    | {
        readonly kind: 'ok';
        readonly connection: ProviderConnection;
        readonly permission: string;
        readonly target: ProviderMailTarget;
      }
    // 接続・許可・読み取りができない（後で送り直せる）。
    | { readonly kind: 'unavailable' }
    // 接続の口座が違う・対象のメールがない（自動では戻さない）。
    | { readonly kind: 'changed' };

  const readTarget = async (
    provider: ProviderReader,
    change: LabelChange,
  ): Promise<TargetRead> => {
    try {
      const connection = await provider.connection();
      if (
        connection === null ||
        connection.status !== 'active' ||
        connection.provider !== change.provider ||
        !canWrite(connection, 'mail.labels.change') ||
        !canRead(connection, 'mail.message')
      )
        return { kind: 'unavailable' };
      if (connection.account_id !== change.account_id)
        return { kind: 'changed' };
      const permission = await provider.readPermission(change.account_id);
      if (permission === null || permission.account_id !== change.account_id)
        return { kind: 'unavailable' };
      const target = await provider.readTarget(change.remote_id);
      if (target === null || target.remote_id !== change.remote_id)
        return { kind: 'changed' };
      return {
        kind: 'ok',
        connection,
        permission: permission.permission_revision,
        target,
      };
    } catch {
      return { kind: 'unavailable' };
    }
  };

  // 補償の操作の作成の拒否を応答へ写す。
  const undoRejection = (
    requestId: string,
    reasons: readonly string[],
  ): { status: number; body: object } | null => {
    if (reasons.includes('undo_expired'))
      return apiErrorResponse(410, 'undo_expired', requestId);
    if (reasons.includes('undo_in_progress'))
      return apiErrorResponse(409, 'conflict', requestId);
    if (reasons.includes('undo_target_not_auto'))
      return apiErrorResponse(422, 'invalid_input', requestId);
    // 照合の後に失効した端末。
    if (reasons.includes('device_not_registered'))
      return apiErrorResponse(401, 'unauthenticated', requestId);
    return null;
  };

  const undoAutoAction = authenticated(async (request) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body['request_id']);
    const scopeId = stringOf(body['command_scope_id']);
    const targetId = request.params['id'] ?? '';
    const commandId = deviceCommandId(scopeId, requestId);
    const compensationId = undoOperationId(scopeId, requestId);
    const hash = requestHash(request.route.operationId, targetId, body);
    // 同じ要求の再送は保存済みの受付を返す（補償の操作を作り直さない）。内容が違えば 409。
    const stored = await store.query({
      kind: 'command',
      command_id: commandId,
    });
    if (stored !== null) {
      if (
        stored.command_scope_id !== scopeId ||
        stored.request_id !== requestId ||
        stored.target_id !== compensationId ||
        stored.request_hash !== hash
      )
        return apiErrorResponse(409, 'conflict', requestId);
      if (
        stored.status !== 'durable' ||
        stored.committed_state_revision === null
      )
        return apiErrorResponse(503, 'dependency_unavailable', requestId);
      return durableReceiptResponse(requestId, {
        command_id: stored.command_id,
        operation_id: compensationId,
        committed_state_revision: stored.committed_state_revision,
      });
    }
    const read = await store.safety({
      kind: 'safety.auto_action',
      operation_id: targetId,
      now: now(),
      undoable_kinds: undoableKinds,
    });
    if (!read.ok)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const action = read.value;
    // 自動実行でない操作（契約に「対象がない」のコードがないため 422。ADR 0023 の読み取り）。
    if (action === null)
      return apiErrorResponse(422, 'invalid_input', requestId);
    if (action.undo_state === 'expired')
      return apiErrorResponse(410, 'undo_expired', requestId);
    if (action.undo_state === 'undone' || action.undo_state === 'in_progress')
      return apiErrorResponse(409, 'conflict', requestId);
    // 提供元の読み書きの口がない（後で送り直せる）。
    if (undo === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // この種類の補償がまだない（一覧も取り消せるように見せていない）。
    if (action.undo_state !== 'available')
      return apiErrorResponse(409, 'conflict', requestId);
    // 実行した内容版の確定 intent を開く（保存した hash と照合する）。
    const view = await store.query({
      kind: 'operation_view',
      operation_id: targetId,
    });
    if (
      view === null ||
      action.undo_target === null ||
      view.current_content_version !== action.undo_target.content_version ||
      view.content_hash !== action.undo_target.content_hash
    )
      return apiErrorResponse(409, 'conflict', requestId);
    const blob = await store.conversation({
      kind: 'operation.intent',
      operation_id: targetId,
      content_version: view.current_content_version,
    });
    const key = await undo.dataKey();
    if (
      !blob.ok ||
      blob.value === null ||
      blob.value.content_hash !== view.content_hash ||
      key === null
    )
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const opened = openOperationIntent(
      key,
      {
        operationId: targetId,
        contentVersion: Number(view.current_content_version),
      },
      {
        formatVersion: blob.value.format_version,
        keyId: blob.value.key_id,
        nonce: blob.value.nonce,
        ciphertext: blob.value.ciphertext,
        tag: blob.value.tag,
      },
      view.content_hash,
    );
    if (!opened.ok)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const change = labelChangeOf(
      JSON.parse(opened.canonical) as Record<string, unknown>,
    );
    if (change === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // 対象のメールを今読み直す（掃除が済むまで読まない）。
    const current = await withLease(() => readTarget(undo.provider, change));
    if (current === null || current.kind === 'unavailable')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    if (current.kind === 'changed' || !labelsUnchanged(current.target, change))
      return apiErrorResponse(409, 'target_changed', requestId);
    // 補償は逆向きのラベルの変更。送出の直前には実行担当が対象と許可の版をもう一度確かめる（D1、ADR 0030）。
    const content = {
      schema: 'buddy.operation.v1',
      operation_id: compensationId,
      content_version: '1',
      permission_revision: current.permission,
      provider: current.connection.provider,
      account_id: current.connection.account_id,
      target: {
        remote_id: current.target.remote_id,
        source_revision: current.target.source_revision,
      },
      action: {
        kind: 'mail.labels.change',
        add: [...change.remove],
        remove: [...change.add],
      },
      effects: { external_recipients: [], reconcile_scope: 'exact_target' },
    };
    if (!undo.contract.valid('OperationIntent', content))
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const sealed = sealOperationIntent(
      key,
      { operationId: compensationId, contentVersion: 1 },
      content,
      randomUUID(),
    );
    if (!sealed.ok)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const command: CreateOperationCommand = {
      command_id: commandId,
      kind: 'operation.create',
      operation_id: compensationId,
      expected_state_revision: '0',
      request_revision: null,
      permission_revision: current.permission,
      forgetting_generation: view.forgetting_generation,
      connection_id: null,
      request: {
        command_scope_id: scopeId,
        request_id: requestId,
        request_hash: hash,
      },
      workflow_id: null,
      operation_kind: 'mail.labels.change',
      effect_route: 'remote_mutation',
      content_hash: sealed.content_hash,
      intent: sealed.intent,
      auto_approval: null,
      undo_of: {
        undo_id: randomUUID(),
        operation_id: targetId,
        screen_approval: {
          approval_id: randomUUID(),
          device_id: request.device.device_id,
        },
      },
    };
    const outcome = await store.submit(command).result;
    if (outcome.outcome === 'rejected') {
      const mapped = undoRejection(requestId, outcome.reasons);
      if (mapped !== null) return mapped;
    }
    const response = receiptResponse(requestId, outcome);
    if (outcome.outcome === 'durable') undo.afterApproval(compensationId);
    return response;
  });

  // 取り消しの版の照合。自動実行した操作の今の状態版と本文の版を比べる。保存済みの受付（同じ接続範囲・request_id）が
  // あれば経路側の再送の判定に任せる（同じ内容は保存済みの結果、違えば 409）。
  const undoRevisionMatches = async (
    input: EnvironmentInput,
  ): Promise<boolean> => {
    const view = await store.query({
      kind: 'operation_view',
      operation_id: input.params['id'] ?? '',
    });
    if (view === null) return false;
    const scopeId = stringOf(input.body?.['command_scope_id']);
    const requestId = stringOf(input.body?.['request_id']);
    if (scopeId !== '' && requestId !== '') {
      const stored = await store.query({
        kind: 'receipt_exists',
        command_scope_id: scopeId,
        request_id: requestId,
      });
      if (stored) return true;
    }
    return (
      stringOf(input.body?.['expected_state_revision']) === view.state_revision
    );
  };

  return {
    handlers: { listAutoActions, resumeSafety, undoAutoAction },
    async revisionMatches(input) {
      if (input.device === null) return false;
      if (input.operationId === 'undoAutoAction')
        return undoRevisionMatches(input);
      const result = await store.safety({ kind: 'safety.state' });
      if (!result.ok) throw new Error('safety_state_unavailable');
      return (
        result.value.safety_revision ===
        stringOf(input.body?.['expected_safety_revision'])
      );
    },
  };
}
