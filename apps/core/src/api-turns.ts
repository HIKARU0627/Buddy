// 会話の開始・発言（入力→解釈→意味検証→操作の作成）・preview の発行の経路（設計 07 §1〜3、08 §3、09 §1〜3、
// 10 §5・§6A、01 承認画面の必須内容、ADR 0004・0027・0029）。
//
// - 経路の検査（ROUTE_CHECKS: 端末トークン・自宅・接続範囲・ロック解除）は api-server.ts が先に行う。
// - 発言: 解釈（差し込み口。B04 は模擬）→ 意図表（checkIntentArgs）と契約（IntentArgs）の検査 → 意味検証
//   （provider の読み取りで対象を解決し、接続と許可の版を確かめる）→ 経路の分け。
//   - Read: 承認も試行も作らず ResultView を返す（予定の重なりはコードで計算する）。
//   - LocalCommand・RemoteMutation: assessReadiness を通し、確定 intent を暗号化して operation.create へ進む。
//     外部への変更はここでは行わない（実行は B04-04）。自動実行は試験用の方針表ですべて off。
//   - 知らない文・必須の不足・意味検証の失敗は聞き返し（操作を作らない）。
// - 発言・依頼・入力スナップショット・受付は DB worker の turn.record で一つの transaction に書く。同じ request_id の
//   再送は保存済みの ID を返し、依頼に操作がまだなければ作り直す（再開）。照合値が違えば 409。
// - preview: 承認待ちの操作の確定 intent を復号し、hash を照合して返す。端末・接続範囲・内容版・hash（外部変更は
//   口座と許可の版）に結び付けて Core のメモリーに置く（previews.ts）。承認のときに previewValid で照合する。
// - 応答・ログに本文の平文・トークンを入れない（preview の応答の確定 intent は表示のための例外で、ログに出さない）。

import { createHash, randomUUID } from 'node:crypto';
import {
  INTENT_NAMES,
  RETENTION_RULES,
  assessReadiness,
  checkIntentArgs,
} from '@buddy/domain';
import type { ArgValues, IntentName } from '@buddy/domain';
import {
  openOperationIntent,
  sealBlob,
  sealOperationIntent,
} from '@buddy/storage';
import type {
  ConversationOpResult,
  CreateOperationCommand,
  DataKeyMaterial,
  DataKeyProvider,
  DbCommand,
  DbSubmission,
  DbWorkerClient,
  WorkflowState,
} from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import { deviceCommandId, requestHash } from './api-operations.js';
import type { PreviewCheck } from './api-operations.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import type { EventQueryStore } from './event-feed.js';
import type { PreviewRegistry } from './previews.js';
import type { JsonObject } from './strict-json.js';
import type {
  CandidateSource,
  Interpreter,
  ProviderReader,
  TurnPolicy,
} from './turn-ports.js';

export interface TurnRouteStore extends EventQueryStore {
  submit(command: DbCommand): DbSubmission;
  conversation: DbWorkerClient['conversation'];
}

export interface TurnRoutesOptions {
  readonly store: TurnRouteStore;
  readonly keyStore: DataKeyProvider;
  readonly interpreter: Interpreter;
  // 連携の provider の読み取り。null は接続なし（Read・RemoteMutation は聞き返し）。
  readonly provider: ProviderReader | null;
  readonly candidates: CandidateSource;
  readonly policy: TurnPolicy;
  readonly previews: PreviewRegistry;
  // 今日の日付を決める時差（例: +09:00）。
  readonly utcOffset: string;
  readonly now?: () => number;
  readonly contract?: ApiContract;
}

const stringOf = (body: JsonObject | null, key: string): string => {
  const value = body?.[key];
  return typeof value === 'string' ? value : '';
};

// 決まった値から UUID v4 の形の ID を作る（予定の参照 ID。provider の ID を Buddy の Id の形にする）。
function derivedId(...parts: readonly string[]): string {
  const bytes = createHash('sha256')
    .update(parts.join('\0'), 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const OFFSET = /^([+-])([01][0-9]|2[0-3]):([0-5][0-9])$/u;

function offsetMinutes(offset: string): number {
  const match = OFFSET.exec(offset);
  if (match === null) throw new Error('utc_offset_invalid');
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

// 聞き返しの文（決まった文。モデルに作らせない）。
const CLARIFY = {
  unclear: 'すみません、どうしたいのか分かりませんでした。言い換えてください。',
  missing_target: 'どのメールのことか教えてください。',
  missing_title: '用事の題名を教えてください。',
  missing_other: '足りない情報があります。もう少し詳しく教えてください。',
  invalid: 'その内容では進められません。言い換えてください。',
  target_not_found: '対象が見つかりませんでした。もう一度指定してください。',
  connection: '連携の接続が使えません。接続を確かめてください。',
  no_change: 'すでにその状態です。変更はありません。',
  blocked: '今は進められません。少し待ってからもう一度お願いします。',
  unsupported: 'その依頼にはまだ対応していません。',
} as const;

type ClarifyReason = keyof typeof CLARIFY;

interface ScheduleItem {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

// 予定の重なり（コードで計算する。モデルに判定させない）。開始の順に並べ、区間が重なる予定を返す。
// 端がちょうど接する（前の終了＝次の開始）予定は重ならない。
export function scheduleOverlaps(
  items: readonly ScheduleItem[],
): ReadonlySet<string> {
  const sorted = [...items].sort(
    (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const overlapping = new Set<string>();
  for (let i = 0; i < sorted.length; i += 1)
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i] as ScheduleItem;
      const b = sorted[j] as ScheduleItem;
      if (b.start >= a.end) continue;
      overlapping.add(a.id);
      overlapping.add(b.id);
    }
  return overlapping;
}

type TurnPlan =
  | {
      readonly kind: 'clarify';
      readonly reason: ClarifyReason;
      // 意図が分かった聞き返しは依頼（workflow）を作る。知らない文は作らない。
      readonly intent: IntentName | null;
    }
  | {
      readonly kind: 'read';
      readonly intent: IntentName;
      readonly items: readonly { readonly kind: string; readonly id: string }[];
      readonly overlaps: boolean;
    }
  | {
      readonly kind: 'operation';
      readonly intent: IntentName;
      readonly route: 'local_command' | 'remote_mutation';
      readonly operation_id: string;
      readonly operation_kind: string;
      readonly content: Readonly<Record<string, unknown>>;
      readonly permission_revision: string;
    };

const clarify = (
  reason: ClarifyReason,
  intent: IntentName | null,
): TurnPlan => ({ kind: 'clarify', reason, intent });

export interface TurnRoutes {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
  readonly previewValid: PreviewCheck;
}

export function createTurnRoutes(options: TurnRoutesOptions): TurnRoutes {
  const { store, previews, policy } = options;
  const now = options.now ?? (() => Date.now());
  const contract = options.contract ?? createApiContract();
  const offset = offsetMinutes(options.utcOffset);

  const loadKey = async (): Promise<DataKeyMaterial | null> => {
    try {
      const result = await options.keyStore.loadDataKey();
      return result.ok ? result.dataKey : null;
    } catch {
      return null;
    }
  };

  const today = (): string =>
    new Date(now() + offset * 60_000).toISOString().slice(0, 10);

  // 会話の命令の拒否を応答へ写す。照合値の違い・対象の不在は 409、他は中枢側の保留（503）。
  const conversationError = (
    result: Extract<ConversationOpResult, { ok: false }>,
    requestId: string,
  ) =>
    result.outcome === 'rejected' &&
    result.reasons.some((reason) =>
      ['request_conflict', 'session_not_found', 'device_not_active'].includes(
        reason,
      ),
    )
      ? apiErrorResponse(409, 'conflict', requestId)
      : apiErrorResponse(503, 'dependency_unavailable', requestId);

  const requestRef = (request: ApiHandlerRequest, targetId: string) => {
    const body = request.body as JsonObject;
    const scope = stringOf(body, 'command_scope_id');
    const requestId = stringOf(body, 'request_id');
    return {
      command_scope_id: scope,
      request_id: requestId,
      request_hash: requestHash(request.route.operationId, targetId, body),
      command_id: deviceCommandId(scope, requestId),
    };
  };

  const createSession: ApiRouteHandler = async (request) => {
    const device = request.device;
    const requestId = stringOf(request.body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const mode = stringOf(request.body, 'storage_mode');
    // 記録しない会話（private）は保存しない会話の扱い（B05）が要るため、B04-03 では受け付けない。
    if (mode !== 'normal' && mode !== 'extended')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const result = await store.conversation({
      kind: 'session.create',
      session_id: randomUUID(),
      storage_mode: mode,
      display_device_id: device.device_id,
      created_at: now(),
      request: requestRef(request, ''),
    });
    if (!result.ok) return conversationError(result, requestId);
    const session = result.value;
    if (session === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    return {
      status: 201,
      body: {
        request_id: requestId,
        session_id: session.session_id,
        storage_mode: session.storage_mode,
        route_revision: session.route_revision,
      },
    };
  };

  // 連携の接続を読む。読めなければ null（接続なしの扱い）。
  const readConnection = async () => {
    if (options.provider === null) return null;
    try {
      return await options.provider.connection();
    } catch {
      return null;
    }
  };

  const readPermission = async (accountId: string): Promise<string | null> => {
    if (options.provider === null) return null;
    try {
      const permission = await options.provider.readPermission(accountId);
      return permission !== null && permission.account_id === accountId
        ? permission.permission_revision
        : null;
    } catch {
      return null;
    }
  };

  const planRead = async (
    intent: IntentName,
    args: ArgValues,
  ): Promise<TurnPlan> => {
    if (intent !== 'query_schedule') return clarify('unsupported', intent);
    const connection = await readConnection();
    if (
      options.provider === null ||
      connection === null ||
      connection.status !== 'active'
    )
      return clarify('connection', intent);
    const date = typeof args.start === 'string' ? args.start : today();
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(date))
      return clarify('invalid', intent);
    const dayStart = Date.parse(`${date}T00:00:00${options.utcOffset}`);
    if (!Number.isFinite(dayStart)) return clarify('invalid', intent);
    const dayEnd = dayStart + 86_400_000;
    let events;
    try {
      events = await options.provider.listEvents();
    } catch {
      return clarify('connection', intent);
    }
    const items: ScheduleItem[] = [];
    for (const event of events) {
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        continue;
      if (start >= dayEnd || end <= dayStart) continue;
      items.push({
        id: derivedId(
          'buddy/calendar-event/v1',
          connection.provider,
          connection.account_id,
          event.event_id,
        ),
        start,
        end,
      });
    }
    items.sort(
      (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const overlapping = scheduleOverlaps(items);
    return {
      kind: 'read',
      intent,
      items: [
        ...items.map((item) => ({ kind: 'calendar_event', id: item.id })),
        ...items
          .filter((item) => overlapping.has(item.id))
          .map((item) => ({ kind: 'calendar_overlap', id: item.id })),
      ],
      overlaps: overlapping.size > 0,
    };
  };

  const readiness = (
    intent: IntentName,
    permissionCurrent: boolean,
  ): 'blocked' | 'ok' => {
    const result = assessReadiness(
      { state: 'sealed', inputEvidence: 'submitted_text' },
      intent,
      {
        utteranceHold: false,
        targetResolved: true,
        evidenceVerified: true,
        permissionCurrent,
        policyCurrent: true,
        // 安全停止の最終の判定は DB worker（送出意図の transaction）。作成では止めない。
        safetyStopped: false,
        autoPolicyAllows: policy.auto_execution[intent],
      },
    );
    // auto_eligible は方針表がすべて off なので起きない。起きても自動承認せず承認待ちで作る（B04-04）。
    return result.state === 'blocked' ? 'blocked' : 'ok';
  };

  const planLabel = async (
    args: ArgValues,
    permissionAtInput: string | null,
  ): Promise<TurnPlan> => {
    const intent: IntentName = 'label_mail';
    const add = (args.add_labels as readonly string[] | null) ?? [];
    const remove = (args.remove_labels as readonly string[] | null) ?? [];
    if (add.some((label) => remove.includes(label)))
      return clarify('invalid', intent);
    let candidates;
    try {
      candidates = await options.candidates.mailCandidates();
    } catch {
      candidates = [];
    }
    const candidate = candidates.find(
      (item) => item.candidate_id === args.target_candidate_id,
    );
    if (candidate === undefined || options.provider === null)
      return clarify('target_not_found', intent);
    const connection = await readConnection();
    if (
      connection === null ||
      connection.status !== 'active' ||
      connection.access !== 'read_write'
    )
      return clarify('connection', intent);
    let target;
    try {
      target = await options.provider.readTarget(candidate.remote_id);
    } catch {
      return clarify('connection', intent);
    }
    if (target === null || target.remote_id !== candidate.remote_id)
      return clarify('target_not_found', intent);
    const addEffective = add.filter((label) => !target.labels.includes(label));
    const removeEffective = remove.filter((label) =>
      target.labels.includes(label),
    );
    if (addEffective.length === 0 && removeEffective.length === 0)
      return clarify('no_change', intent);
    const permission = await readPermission(connection.account_id);
    if (permission === null) return clarify('connection', intent);
    // 入力の時点の許可の版と、確定の直前に読み直した許可の版が同じであること（10 §5A、ADR 0029）。
    if (readiness(intent, permission === permissionAtInput) === 'blocked')
      return clarify('blocked', intent);
    const operationId = randomUUID();
    return {
      kind: 'operation',
      intent,
      route: 'remote_mutation',
      operation_id: operationId,
      operation_kind: 'mail.labels.change',
      permission_revision: permission,
      content: {
        schema: 'buddy.operation.v1',
        operation_id: operationId,
        content_version: '1',
        permission_revision: permission,
        provider: connection.provider,
        account_id: connection.account_id,
        target: {
          remote_id: target.remote_id,
          source_revision: target.source_revision,
        },
        action: {
          kind: 'mail.labels.change',
          add: addEffective,
          remove: removeEffective,
        },
        effects: { external_recipients: [], reconcile_scope: 'exact_target' },
      },
    };
  };

  const planTask = (args: ArgValues): TurnPlan => {
    const intent: IntentName = 'create_task';
    if (args.target_candidate_id !== null)
      return clarify('unsupported', intent);
    if (readiness(intent, true) === 'blocked')
      return clarify('blocked', intent);
    const operationId = randomUUID();
    return {
      kind: 'operation',
      intent,
      route: 'local_command',
      operation_id: operationId,
      operation_kind: 'task.create',
      permission_revision: policy.task_permission_revision,
      content: {
        schema: 'buddy.operation.v1',
        operation_id: operationId,
        content_version: '1',
        permission_revision: policy.task_permission_revision,
        target: { list_id: policy.task_list_id },
        action: {
          kind: 'task.create',
          title: args.title,
          due: args.due ?? null,
          body: args.body ?? null,
        },
        effects: {
          external_recipients: [],
          reconcile_scope: 'local_transaction',
        },
      },
    };
  };

  const planTurn = async (
    text: string,
    permissionAtInput: string | null,
  ): Promise<TurnPlan> => {
    let candidates;
    try {
      candidates = await options.candidates.mailCandidates();
    } catch {
      candidates = [];
    }
    let reply;
    try {
      reply = await options.interpreter.interpret({
        text,
        today: today(),
        mail_candidates: candidates,
      });
    } catch {
      return clarify('unclear', null);
    }
    // 解釈の結果を信用しない: 意図表にない意図・契約に合わない引数は知らない文と同じ扱い。
    if (
      reply === null ||
      typeof reply !== 'object' ||
      reply.kind !== 'intent' ||
      !(INTENT_NAMES as readonly string[]).includes(reply.intent) ||
      reply.intent === 'unclear' ||
      !contract.valid('IntentArgs', reply.args)
    )
      return clarify('unclear', null);
    const intent = reply.intent as IntentName;
    const args = reply.args as unknown as ArgValues;
    const checked = checkIntentArgs(intent, args);
    if (checked.missing.length > 0)
      return clarify(
        checked.missing.includes('target_candidate_id')
          ? 'missing_target'
          : checked.missing.includes('title')
            ? 'missing_title'
            : 'missing_other',
        intent,
      );
    if (checked.unexpected.length > 0) return clarify('invalid', intent);
    if (intent === 'query_schedule') return planRead(intent, args);
    if (intent === 'label_mail') return planLabel(args, permissionAtInput);
    if (intent === 'create_task') return planTask(args);
    return clarify('unsupported', intent);
  };

  const workflowState = (plan: TurnPlan): WorkflowState | null => {
    if (plan.kind === 'read') return 'done';
    if (plan.kind === 'operation') return 'ready';
    return plan.intent === null ? null : 'clarifying';
  };

  // 確定 intent を契約で確かめ、暗号化して operation.create を送る。
  const createOperation = async (
    plan: Extract<TurnPlan, { kind: 'operation' }>,
    workflowId: string,
    forgettingGeneration: string,
  ): Promise<'created' | 'invalid' | 'unavailable'> => {
    if (!contract.valid('OperationIntent', plan.content)) return 'invalid';
    const key = await loadKey();
    if (key === null) return 'unavailable';
    const sealed = sealOperationIntent(
      key,
      { operationId: plan.operation_id, contentVersion: 1 },
      plan.content,
    );
    if (!sealed.ok) return 'invalid';
    const command: CreateOperationCommand = {
      command_id: randomUUID(),
      kind: 'operation.create',
      operation_id: plan.operation_id,
      expected_state_revision: '0',
      request_revision: '1',
      permission_revision: plan.permission_revision,
      forgetting_generation: forgettingGeneration,
      // 操作に連携の接続の列がない（0001）。接続と許可の版は意味検証と preview・承認の照合で確かめる。
      connection_id: null,
      request: null,
      workflow_id: workflowId,
      operation_kind: plan.operation_kind,
      effect_route: plan.route,
      content_hash: sealed.content_hash,
      intent: sealed.intent,
      // 自動実行はすべて off（試験用の方針表）。画面承認を待つ。
      auto_approval: null,
    };
    const outcome = await store.submit(command).result;
    return outcome.outcome === 'durable' ? 'created' : 'unavailable';
  };

  const postTurn: ApiRouteHandler = async (request) => {
    const device = request.device;
    const body = request.body as JsonObject;
    const requestId = stringOf(body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    // 端末内の音声認識（local_asr）の入力は音声の区間と世代の照合が要る（B06）。B04-03 は文字入力だけ。
    if (stringOf(body, 'input_kind') !== 'text')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const sessionId = request.params['session_id'] ?? '';
    const session = await store.conversation({
      kind: 'session.get',
      session_id: sessionId,
    });
    if (!session.ok) return conversationError(session, requestId);
    if (session.value === null || session.value.ended_at !== null)
      return apiErrorResponse(409, 'conflict', requestId);
    const text = stringOf(body, 'text');
    // 入力の時点の許可の版（連携の接続がなければ 0）。
    const connection = await readConnection();
    const permissionAtInput =
      connection === null ? null : await readPermission(connection.account_id);
    const plan = await planTurn(text, permissionAtInput);
    const key = await loadKey();
    if (key === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const turnId = randomUUID();
    const createdAt = now();
    const rule =
      RETENTION_RULES[
        session.value.storage_mode === 'extended'
          ? 'turn_extended'
          : 'turn_normal'
      ];
    const sealed = sealBlob(key, Buffer.from(text, 'utf8'), {
      ownerTable: 'turns',
      ownerId: turnId,
      ownerVersion: 0,
      purpose: 'turn_text',
    });
    if (!sealed.ok || rule === undefined)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const state = workflowState(plan);
    const recorded = await store.conversation({
      kind: 'turn.record',
      session_id: sessionId,
      turn_id: turnId,
      input_id: randomUUID(),
      text: {
        blob_id: randomUUID(),
        format_version: sealed.envelope.formatVersion,
        key_id: sealed.envelope.keyId,
        nonce: sealed.envelope.nonce,
        ciphertext: sealed.envelope.ciphertext,
        tag: sealed.envelope.tag,
      },
      created_at: createdAt,
      expires_at: createdAt + rule.ms,
      workflow: state === null ? null : { workflow_id: randomUUID(), state },
      permission_revision: permissionAtInput ?? '0',
      request: requestRef(request, sessionId),
    });
    if (!recorded.ok) return conversationError(recorded, requestId);
    const turn = recorded.value;
    const response = (
      status: 'answered' | 'clarification',
      resultView: object | null,
      replyText: string | null,
    ) => ({
      status: 200,
      body: {
        request_id: requestId,
        session_id: sessionId,
        turn_id: turn.turn_id,
        input_id: turn.input_id,
        workflow_id: turn.workflow_id,
        status,
        result_view: resultView,
        reply_text: replyText,
      },
    });
    const view = (
      intent: IntentName,
      kind: string,
      status: string,
      itemRefs: readonly object[],
    ) =>
      turn.workflow_id === null
        ? null
        : {
            workflow_id: turn.workflow_id,
            request_revision: '1',
            intent,
            kind,
            status,
            item_refs: itemRefs,
            more_count: 0,
            template_id: null,
            template_version: null,
          };
    const clarification = (reason: ClarifyReason, intent: IntentName | null) =>
      response(
        'clarification',
        intent === null
          ? null
          : view(intent, 'clarification', 'confirming_input', []),
        CLARIFY[reason],
      );
    // 再送で、保存した発言に依頼がない（知らない文だった）なら、聞き返しのまま返す。
    if (turn.workflow_id === null || plan.kind === 'clarify')
      return clarification(
        plan.kind === 'clarify' ? plan.reason : 'unclear',
        plan.kind === 'clarify' ? plan.intent : null,
      );
    if (plan.kind === 'read')
      return response(
        'answered',
        view(
          plan.intent,
          'schedule_cards',
          plan.overlaps ? 'needs_review' : 'ready',
          plan.items,
        ),
        null,
      );
    // 再送: 依頼に操作があればそれを返す（二つ目を作らない）。なければ作る（前回は作成の前に止まった）。
    let operationId = plan.operation_id;
    const existing = turn.replayed
      ? await store.conversation({
          kind: 'workflow.operation',
          workflow_id: turn.workflow_id,
        })
      : null;
    if (existing !== null && !existing.ok)
      return conversationError(existing, requestId);
    if (existing?.value.operation_id != null)
      operationId = existing.value.operation_id;
    else {
      const created = await createOperation(
        plan,
        turn.workflow_id,
        turn.forgetting_generation,
      );
      if (created === 'invalid') return clarification('invalid', plan.intent);
      if (created === 'unavailable')
        return apiErrorResponse(503, 'dependency_unavailable', requestId);
    }
    return response(
      'answered',
      view(plan.intent, 'approval_link', 'needs_review', [
        { kind: 'operation', id: operationId },
      ]),
      null,
    );
  };

  const previewOperation: ApiRouteHandler = async (request) => {
    const device = request.device;
    const requestId = stringOf(request.body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const operationId = request.params['id'] ?? '';
    const operation = await store.query({
      kind: 'operation_view',
      operation_id: operationId,
    });
    // 承認待ちの操作だけ（承認の表示の準備）。それ以外は状態が変わった扱い。
    if (operation === null || operation.state !== 'awaiting_approval')
      return apiErrorResponse(409, 'conflict', requestId);
    const blob = await store.conversation({
      kind: 'operation.intent',
      operation_id: operationId,
      content_version: operation.current_content_version,
    });
    if (!blob.ok) return conversationError(blob, requestId);
    if (
      blob.value === null ||
      blob.value.content_hash !== operation.content_hash
    )
      return apiErrorResponse(409, 'conflict', requestId);
    const key = await loadKey();
    if (key === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const opened = openOperationIntent(
      key,
      {
        operationId,
        contentVersion: Number(operation.current_content_version),
      },
      {
        formatVersion: blob.value.format_version,
        keyId: blob.value.key_id,
        nonce: blob.value.nonce,
        ciphertext: blob.value.ciphertext,
        tag: blob.value.tag,
      },
      operation.content_hash,
    );
    if (!opened.ok)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const intent = JSON.parse(opened.canonical) as Record<string, unknown>;
    if (!contract.valid('OperationIntent', intent))
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // 外部変更は、今の接続が書込み可で、許可の版が確定 intent と同じときだけ preview を出す。
    let account: { account_id: string; permission_revision: string } | null =
      null;
    if (typeof intent['account_id'] === 'string') {
      const accountId = intent['account_id'];
      const connection = await readConnection();
      const permission = await readPermission(accountId);
      if (
        connection === null ||
        connection.status !== 'active' ||
        connection.access !== 'read_write' ||
        connection.account_id !== accountId ||
        permission === null ||
        permission !== intent['permission_revision']
      )
        return apiErrorResponse(409, 'conflict', requestId);
      account = { account_id: accountId, permission_revision: permission };
    }
    const previewId = randomUUID();
    previews.issue({
      preview_id: previewId,
      device_id: device.device_id,
      command_scope_id: stringOf(request.body, 'command_scope_id'),
      operation_id: operationId,
      content_version: operation.current_content_version,
      content_hash: operation.content_hash,
      account,
      issued_at: now(),
    });
    return {
      status: 200,
      body: {
        preview_id: previewId,
        intent,
        content_hash: operation.content_hash,
        state_revision: operation.state_revision,
      },
    };
  };

  // 承認のときの preview の照合（07 §3）。端末・接続範囲・操作・内容版・hash が発行したときと同じで、操作の今の
  // 内容版・hash とも同じこと。外部変更は、今の接続が書込み可で、許可の版が変わっていないこと。
  const previewValid: PreviewCheck = async (input) => {
    const binding = previews.get(input.preview_id);
    if (
      binding === null ||
      binding.device_id !== input.device_id ||
      binding.command_scope_id !== input.command_scope_id ||
      binding.operation_id !== input.operation_id ||
      binding.content_version !== input.content_version ||
      binding.content_hash !== input.content_hash
    )
      return false;
    const operation = await store.query({
      kind: 'operation_view',
      operation_id: input.operation_id,
    });
    if (
      operation === null ||
      operation.current_content_version !== binding.content_version ||
      operation.content_hash !== binding.content_hash
    )
      return false;
    if (binding.account !== null) {
      const connection = await readConnection();
      if (
        connection === null ||
        connection.status !== 'active' ||
        connection.access !== 'read_write' ||
        connection.account_id !== binding.account.account_id ||
        (await readPermission(binding.account.account_id)) !==
          binding.account.permission_revision
      )
        return false;
    }
    return true;
  };

  return {
    handlers: { createSession, postTurn, previewOperation },
    previewValid,
  };
}
