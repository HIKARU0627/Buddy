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
  isRealLocalDateTime,
} from '@buddy/domain';
import type { ArgValues, IntentName } from '@buddy/domain';
import {
  openOperationIntent,
  sealBlob,
  sealOperationIntent,
} from '@buddy/storage';
import type {
  ConversationOpResult,
  DataKeyMaterial,
  DataKeyProvider,
  DbCommand,
  DbSubmission,
  DbWorkerClient,
  TurnOperationInput,
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
  // 発言から操作を作った後に呼ぶ（イベントの配信を起こす。event-feed の notify）。
  readonly onOperationCreated?: () => void;
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

// 予定の照会で返す予定の上限。予定 1 件の参照は重なりの参照を含めて高々 2 件（1 件は約 70 文字）なので、
// 上限まで返しても応答は turn_responses の上限（16,384 文字）に十分収まる。
export const MAX_SCHEDULE_ITEMS = 50;

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
      // 上限で切って返さなかった予定の件数（ResultView の more_count）。
      readonly more: number;
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
  readonly previewCurrent: (previewId: string) => boolean;
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

  // 対象のメールの表示用の値（件名・差出人・受信日時）。読めなければ null（承認画面は対象を確認できないと言う）。
  const readTargetDisplay = async (
    intent: Record<string, unknown>,
  ): Promise<{
    subject: string | null;
    sender: string | null;
    received_at: string | null;
  } | null> => {
    const target = intent['target'];
    if (
      options.provider === null ||
      typeof target !== 'object' ||
      target === null
    )
      return null;
    const remoteId = (target as Record<string, unknown>)['remote_id'];
    if (typeof remoteId !== 'string') return null;
    try {
      const mail = await options.provider.readTarget(remoteId);
      if (mail === null) return null;
      return {
        subject: mail.subject ?? null,
        sender: mail.sender ?? null,
        received_at: mail.received_at ?? null,
      };
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
    // 重なりは全件で計算し、返す参照は開始の順に上限まで（残りは more_count）。
    const overlapping = scheduleOverlaps(items);
    const shown = items.slice(0, MAX_SCHEDULE_ITEMS);
    return {
      kind: 'read',
      intent,
      items: [
        ...shown.map((item) => ({ kind: 'calendar_event', id: item.id })),
        ...shown
          .filter((item) => overlapping.has(item.id))
          .map((item) => ({ kind: 'calendar_overlap', id: item.id })),
      ],
      overlaps: overlapping.size > 0,
      more: items.length - shown.length,
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
    // 期限の地域日時は実在の日時に限る（契約の Schema は形だけを見る。日付だけの値は format: date で検査済み）。
    if (
      typeof args.due === 'string' &&
      args.due.includes('T') &&
      !isRealLocalDateTime(args.due)
    )
      return clarify('invalid', intent);
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

  // 確定 intent を契約で確かめて暗号化する。操作は発言と同じ transaction（turn.record）で作る。
  const sealOperation = (
    plan: Extract<TurnPlan, { kind: 'operation' }>,
    key: DataKeyMaterial,
  ): TurnOperationInput | null => {
    if (!contract.valid('OperationIntent', plan.content)) return null;
    const sealed = sealOperationIntent(
      key,
      { operationId: plan.operation_id, contentVersion: 1 },
      plan.content,
    );
    if (!sealed.ok) return null;
    return {
      operation_id: plan.operation_id,
      operation_kind: plan.operation_kind,
      effect_route: plan.route,
      content_hash: sealed.content_hash,
      intent: sealed.intent,
    };
  };

  // 保存した応答を返す（同じ要求の再送）。読めなければ中枢側の保留。
  const storedResponse = (json: string, requestId: string) => {
    try {
      return { status: 200, body: JSON.parse(json) as object };
    } catch {
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    }
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
    // 再送の判定は解釈より先（保存済みの応答をそのまま返し、解釈・意味検証をやり直さない）。
    const ref = requestRef(request, sessionId);
    const found = await store.conversation({ kind: 'turn.find', request: ref });
    if (!found.ok) return conversationError(found, requestId);
    if (found.value !== null)
      return storedResponse(found.value.response_json, requestId);
    const text = stringOf(body, 'text');
    // 入力の時点の許可の版（連携の接続がなければ 0）。
    const connection = await readConnection();
    const permissionAtInput =
      connection === null ? null : await readPermission(connection.account_id);
    let plan = await planTurn(text, permissionAtInput);
    const key = await loadKey();
    if (key === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    let operation: TurnOperationInput | null = null;
    if (plan.kind === 'operation') {
      operation = sealOperation(plan, key);
      if (operation === null) plan = clarify('invalid', plan.intent);
    }
    const turnId = randomUUID();
    const inputId = randomUUID();
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
    const workflowId = state === null ? null : randomUUID();
    const view = (
      intent: IntentName,
      kind: string,
      status: string,
      itemRefs: readonly object[],
      moreCount = 0,
    ) =>
      workflowId === null
        ? null
        : {
            workflow_id: workflowId,
            request_revision: '1',
            intent,
            kind,
            status,
            item_refs: itemRefs,
            more_count: moreCount,
            template_id: null,
            template_version: null,
          };
    const responseOf = (
      status: 'answered' | 'clarification',
      resultView: object | null,
      replyText: string | null,
    ) => ({
      request_id: requestId,
      session_id: sessionId,
      turn_id: turnId,
      input_id: inputId,
      workflow_id: workflowId,
      status,
      result_view: resultView,
      reply_text: replyText,
    });
    const responseBody =
      plan.kind === 'clarify'
        ? responseOf(
            'clarification',
            plan.intent === null
              ? null
              : view(plan.intent, 'clarification', 'confirming_input', []),
            CLARIFY[plan.reason],
          )
        : plan.kind === 'read'
          ? responseOf(
              'answered',
              view(
                plan.intent,
                'schedule_cards',
                plan.overlaps ? 'needs_review' : 'ready',
                plan.items,
                plan.more,
              ),
              null,
            )
          : responseOf(
              'answered',
              view(plan.intent, 'approval_link', 'needs_review', [
                { kind: 'operation', id: plan.operation_id },
              ]),
              null,
            );
    const recorded = await store.conversation({
      kind: 'turn.record',
      session_id: sessionId,
      turn_id: turnId,
      input_id: inputId,
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
      workflow:
        state === null || workflowId === null
          ? null
          : { workflow_id: workflowId, state },
      permission_revision: permissionAtInput ?? '0',
      request: ref,
      operation,
      response_json: JSON.stringify(responseBody),
    });
    if (!recorded.ok) return conversationError(recorded, requestId);
    // 同時の再送で先に保存された発言があった: その応答を返す（この要求の計画は捨てる。操作は作っていない）。
    if (recorded.value.replayed)
      return storedResponse(recorded.value.response_json, requestId);
    if (operation !== null) options.onOperationCreated?.();
    return { status: 200, body: responseBody };
  };

  // 操作の確定 intent を読んで開く（preview と display の共通部）。ない・内容が合わない・開けないときは応答を返す。
  const loadIntent = async (
    operationId: string,
    requestId: string,
    states: readonly string[] | null,
  ) => {
    const operation = await store.query({
      kind: 'operation_view',
      operation_id: operationId,
    });
    if (
      operation === null ||
      (states !== null && !states.includes(operation.state))
    )
      return { error: apiErrorResponse(409, 'conflict', requestId) } as const;
    const blob = await store.conversation({
      kind: 'operation.intent',
      operation_id: operationId,
      content_version: operation.current_content_version,
    });
    if (!blob.ok) return { error: conversationError(blob, requestId) } as const;
    if (
      blob.value === null ||
      blob.value.content_hash !== operation.content_hash
    )
      return { error: apiErrorResponse(409, 'conflict', requestId) } as const;
    const key = await loadKey();
    if (key === null)
      return {
        error: apiErrorResponse(503, 'dependency_unavailable', requestId),
      } as const;
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
      return {
        error: apiErrorResponse(503, 'dependency_unavailable', requestId),
      } as const;
    const intent = JSON.parse(opened.canonical) as Record<string, unknown>;
    if (!contract.valid('OperationIntent', intent))
      return {
        error: apiErrorResponse(503, 'dependency_unavailable', requestId),
      } as const;
    return { operation, intent } as const;
  };

  const previewOperation: ApiRouteHandler = async (request) => {
    const device = request.device;
    const requestId = stringOf(request.body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const operationId = request.params['id'] ?? '';
    // 承認待ちの操作だけ（承認の表示の準備）。それ以外は状態が変わった扱い。
    const loaded = await loadIntent(operationId, requestId, [
      'awaiting_approval',
    ]);
    if ('error' in loaded) return loaded.error;
    const { operation, intent } = loaded;
    // 外部変更は、今の接続が書込み可で、許可の版が確定 intent と同じときだけ preview を出す。
    let account: { account_id: string; permission_revision: string } | null =
      null;
    // 承認画面で口座と対象のメールを見分ける表示用の値（provider から読む。読めない項目は null）。
    let display: {
      account_label: string | null;
      target: {
        subject: string | null;
        sender: string | null;
        received_at: string | null;
      } | null;
    } = { account_label: null, target: null };
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
      display = {
        account_label: connection.account_label ?? null,
        target: await readTargetDisplay(intent),
      };
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
        display,
      },
    };
  };

  // 操作の内容の表示用の読み取り（B04-05、ADR 0031）。取消・再試行の確認に出す見出しを、承認待ち以外の状態でも取り直せる
  // ようにする。読み取りだけで、preview は発行せず（古い preview を失効させない）、承認にも使えない。認可は preview と同じ
  // （端末トークン・自宅・接続範囲・ロック解除）。外部変更の口座の表示名・対象のメールは provider から読み、読めない項目は
  // null（接続が使えなくても内容は返す）。内容はこの応答だけで、イベント・スナップショットには入れない。
  const displayOperation: ApiRouteHandler = async (request) => {
    const device = request.device;
    const requestId = stringOf(request.body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const loaded = await loadIntent(
      request.params['id'] ?? '',
      requestId,
      null,
    );
    if ('error' in loaded) return loaded.error;
    const { operation, intent } = loaded;
    let display: {
      account_label: string | null;
      target: {
        subject: string | null;
        sender: string | null;
        received_at: string | null;
      } | null;
    } = { account_label: null, target: null };
    if (typeof intent['account_id'] === 'string') {
      const connection = await readConnection();
      display = {
        account_label:
          connection !== null && connection.account_id === intent['account_id']
            ? (connection.account_label ?? null)
            : null,
        target: await readTargetDisplay(intent),
      };
    }
    return {
      status: 200,
      body: {
        content_version: operation.current_content_version,
        content_hash: operation.content_hash,
        state_revision: operation.state_revision,
        intent,
        display,
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
    // 非同期の照会の間に無効化（ロック・接続の終了・置き換え）されていないこと。登録は同じ値のまま残る
    // 限り有効で、消されたら同じ ID で戻ることはない（ID は使い捨て）。
    const alive = () => previews.get(input.preview_id) === binding;
    const operation = await store.query({
      kind: 'operation_view',
      operation_id: input.operation_id,
    });
    if (
      !alive() ||
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
    return alive();
  };

  return {
    handlers: { createSession, postTurn, previewOperation, displayOperation },
    previewValid,
    previewCurrent: (previewId) => previews.get(previewId) !== null,
  };
}
