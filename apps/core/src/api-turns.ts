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
  INTENT_POLICIES,
  RETENTION_RULES,
  SESSION_CONTROL_TABLE,
  assessReadiness,
  checkIntentArgs,
  isRealLocalDateTime,
  resolveSessionControl,
} from '@buddy/domain';
import type {
  ArgValues,
  HoldRelation,
  InputEvidence,
  IntentName,
  SessionControlAction,
} from '@buddy/domain';
import {
  openOperationIntent,
  sealBlob,
  sealOperationIntent,
} from '@buddy/storage';
import type {
  ConversationOpResult,
  ConversationRequestRef,
  DataKeyMaterial,
  DataKeyProvider,
  DbCommand,
  DbSubmission,
  DbWorkerClient,
  TurnInputRecord,
  TurnOperationInput,
  WorkflowState,
} from '@buddy/storage';
import type { TurnResponse } from '@buddy/contracts';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import { deviceCommandId, requestHash } from './api-operations.js';
import type { PreviewCheck } from './api-operations.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import type { EventQueryStore } from './event-feed.js';
import type { PreviewRegistry } from './previews.js';
import type { JsonObject } from './strict-json.js';
import { canRead, canWrite, replyFields } from './turn-ports.js';
import type {
  CandidateSource,
  Interpreter,
  ProviderConnection,
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
  // 会話の操作（照合表に当たった発言。LLM を呼ばない）を保存した後に呼ぶ（B05-05）。再送では呼ばない。
  // 音声の接続が開いていれば、同じ操作を接続へ行う（画面のボタンと同じ処理）。
  readonly onSessionControl?: (event: {
    readonly device_id: string;
    readonly session_id: string;
    readonly action: SessionControlAction;
  }) => void;
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
  missing_body: '下書きの本文を教えてください。',
  missing_other: '足りない情報があります。もう少し詳しく教えてください。',
  invalid: 'その内容では進められません。言い換えてください。',
  target_not_found: '対象が見つかりませんでした。もう一度指定してください。',
  connection: '連携の接続が使えません。接続を確かめてください。',
  no_change: 'すでにその状態です。変更はありません。',
  blocked: '今は進められません。少し待ってからもう一度お願いします。',
  unsupported: 'その依頼にはまだ対応していません。',
  // 声（方式 C）の入力は 4 操作だけを進める。それ以外は画面で全文を確かめてから（B05-05）。
  full_text:
    'この操作は、画面で内容を確かめてからにします。画面から送ってください。',
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

export type TurnPlan =
  | {
      readonly kind: 'session_control';
      readonly action: SessionControlAction;
    }
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

// 発言の入力の時点に控える、連携の口座と許可の版（Core のメモリーにある最後に確かめた値）。
type InputPermission = {
  readonly account_id: string;
  readonly permission_revision: string;
} | null;

const clarify = (
  reason: ClarifyReason,
  intent: IntentName | null,
): TurnPlan => ({ kind: 'clarify', reason, intent });

// 解釈の結果（意図表・契約で検査済み）。Live の委譲は、解釈の後・保存の前に入力の受付（方式 C の限定）を挟むので、
// 解釈と保存を分けて呼ぶ（解釈を 2 回しない）。
export type InterpretedTurn =
  | { readonly kind: 'plan'; readonly plan: TurnPlan }
  | {
      readonly kind: 'intent';
      readonly intent: IntentName;
      readonly args: ArgValues;
      // 直前の依頼との関係（5A-4）。モデルの値は信用せず、分からなければ unknown（保留中の変更を再開しない側）。
      readonly relation: HoldRelation;
      readonly target_workflow_id: string | null;
    };

// Live の委譲から保存する発言（B05-05）。共通の workflow（意図表・意味検証・readiness・承認待ちの操作）を通す。
export interface LiveCommitInput {
  readonly session_id: string;
  // 接続範囲（Live を開いた端末のリースの接続範囲）と、委譲ごとに決まる request_id（同じ委譲の再送は同じ値）。
  readonly command_scope_id: string;
  readonly request_id: string;
  // 要求の照合値に入れる値（live_session_id と委譲の ID）。同じ request_id で違う委譲なら 409。
  readonly identity: string;
  readonly text: string;
  readonly audio_epoch: string;
  readonly policy_version: string;
  readonly interpreted: InterpretedTurn;
  // sealed: 方式 C の暫定入力として進める。partial: 確定前の入力から参照だけ答える（変更は作らない）。
  // blocked: 確定できなかった入力として記録し、依頼・操作を作らない。
  readonly outcome: 'sealed' | 'partial' | 'blocked';
  // 依頼の ID（保留の間も同じ値で追う）。
  readonly workflow_id: string;
  // 保存の直前の確認。false なら保存せず held を返す（新しい発話の開始による保留。送出の直前の再検査）。
  readonly precommit: () => boolean;
}

export type LiveCommitResult =
  | {
      readonly kind: 'ok';
      readonly turn: TurnResponse;
      readonly replayed: boolean;
      // 4 操作でも画面承認・全文の確定が要るため進めなかった（readiness の requires_full_text）。
      readonly full_text: boolean;
    }
  | { readonly kind: 'held' }
  | { readonly kind: 'failed'; readonly status: number };

export interface TurnRoutes {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
  readonly previewValid: PreviewCheck;
  readonly previewCurrent: (previewId: string) => boolean;
  readonly prime: () => Promise<void>;
  // 発言の解釈（外部へは送らない。副作用なし）。
  readonly interpret: (text: string) => Promise<InterpretedTurn>;
  // Live の委譲から発言・依頼・操作（承認待ち）を保存する。
  readonly commitLive: (input: LiveCommitInput) => Promise<LiveCommitResult>;
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
  // 今の接続先（アカウント）が確定 intent の口座と同じときだけ読む。違えば（接続先を替えた後に、同じ remote_id で別の
  // アカウントのメールを読んでしまう）null を返す。
  const readTargetDisplay = async (
    intent: Record<string, unknown>,
    connection: Pick<
      ProviderConnection,
      'account_id' | 'status' | 'readable_kinds'
    > | null,
  ): Promise<{
    subject: string | null;
    sender: string | null;
    received_at: string | null;
  } | null> => {
    const target = intent['target'];
    if (
      options.provider === null ||
      connection === null ||
      connection.account_id !== intent['account_id'] ||
      // メールの読み取りが許可に含まれなければ、件名・差出人を読まない。
      !canRead(connection, 'mail.message') ||
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

  // Core が最後に確かめた連携の口座と許可の版（メモリーだけ）。provider から読むたびに更新する。
  // 発言の入力の時点の許可の版は、外部へ問い合わせずにこの値から取る（解釈の前に控える。QA27 の LocalCommand に
  // 外部の HTTP を作らないため。PR #107 のレビュー）。起動時に一度読んでおく（prime）。
  let observedPermission: InputPermission = null;

  const readPermission = async (accountId: string): Promise<string | null> => {
    if (options.provider === null) return null;
    try {
      const permission = await options.provider.readPermission(accountId);
      if (permission === null || permission.account_id !== accountId)
        return null;
      observedPermission = {
        account_id: accountId,
        permission_revision: permission.permission_revision,
      };
      return permission.permission_revision;
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
    // Read も権限を確かめる（QA27）: 接続が active で、予定の読み取りが許可に含まれること。
    if (
      options.provider === null ||
      connection === null ||
      !canRead(connection, 'calendar.events')
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
    evidence: InputEvidence,
  ): { readonly state: 'blocked' | 'ok'; readonly full_text: boolean } => {
    const result = assessReadiness(
      { state: 'sealed', inputEvidence: evidence },
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
    // 方式 C（live_policy_observed）は、画面承認が要る・方針が自動実行を許さない操作を requires_full_text でここで止める
    // （承認待ちへ昇格させない。全文を画面で確かめてから。10 §5A）。
    return {
      state: result.state === 'blocked' ? 'blocked' : 'ok',
      full_text: result.reasonCodes.includes('requires_full_text'),
    };
  };

  const blocked = (
    result: { readonly full_text: boolean },
    intent: IntentName,
  ): TurnPlan => clarify(result.full_text ? 'full_text' : 'blocked', intent);

  // 入力の時点に控えた口座と許可の版から、今の接続の口座の入力の時点の版を取る（口座が違えば null）。
  const permissionOf = (
    input: InputPermission,
    accountId: string,
  ): string | null =>
    input !== null && input.account_id === accountId
      ? input.permission_revision
      : null;

  const planLabel = async (
    args: ArgValues,
    input: InputPermission,
    evidence: InputEvidence,
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
      !canWrite(connection, 'mail.labels.change') ||
      // 対象のメールを読む前に、メールの読み取りが許可に含まれることを確かめる。
      !canRead(connection, 'mail.message')
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
    // 入力の時点の版が分からない（起動の後にまだ確かめていない）ときも進めない。
    const ready = readiness(
      intent,
      permission === permissionOf(input, connection.account_id),
      evidence,
    );
    if (ready.state === 'blocked') return blocked(ready, intent);
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

  // 返信の下書きの保存（RemoteMutation、B04-07）。宛先は返信元の差出人、件名は返信元の件名に「Re: 」を付けた値で、
  // どちらも Core が provider の読み取りから決める（モデルに作らせない。ADR 0004）。本文だけを発言から取る。
  // CC は空。下書きは送らないので external_recipients は空で、照合は作成物の目印（operation_marker）。
  const planDraft = async (
    args: ArgValues,
    input: InputPermission,
    evidence: InputEvidence,
  ): Promise<TurnPlan> => {
    const intent: IntentName = 'draft_reply';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (body.length === 0) return clarify('missing_body', intent);
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
      !canWrite(connection, 'mail.draft.create') ||
      // 返信元を読む前に、メールの読み取りが許可に含まれることを確かめる。
      !canRead(connection, 'mail.message')
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
    // 返信先（差出人）と件名が読めなければ、宛先と件名を決められないので作らない。
    const reply = replyFields(target);
    if (reply === null) return clarify('invalid', intent);
    const permission = await readPermission(connection.account_id);
    if (permission === null) return clarify('connection', intent);
    const ready = readiness(
      intent,
      permission === permissionOf(input, connection.account_id),
      evidence,
    );
    if (ready.state === 'blocked') return blocked(ready, intent);
    const operationId = randomUUID();
    return {
      kind: 'operation',
      intent,
      route: 'remote_mutation',
      operation_id: operationId,
      operation_kind: 'mail.draft.create',
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
          kind: 'mail.draft.create',
          to: reply.to,
          cc: [],
          subject: reply.subject,
          body,
        },
        effects: {
          external_recipients: [],
          reconcile_scope: 'operation_marker',
        },
      },
    };
  };

  const planTask = (args: ArgValues, evidence: InputEvidence): TurnPlan => {
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
    const ready = readiness(intent, true, evidence);
    if (ready.state === 'blocked') return blocked(ready, intent);
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

  // 連携の provider を使う意図（Read と RemoteMutation）。これ以外（LocalCommand・聞き返し）では接続を照会しない
  // （QA27: LocalCommand に外部の HTTP がない。B04-07）。
  const PROVIDER_INTENTS: readonly IntentName[] = [
    'query_schedule',
    'label_mail',
    'draft_reply',
  ];

  // input: 発言を受けた時点（解釈の前）に控えた口座と許可の版。解釈の間に許可の版が変わっても、確定の直前の
  // 読み直しとの比較で気づける。evidence は入力の確かさ（文字入力は submitted_text、Live の方式 C は
  // live_policy_observed）。方式 C の入力は 4 操作でも readiness が全文の確定へ戻す。
  const planFrom = async (
    result: InterpretedTurn,
    input: InputPermission,
    evidence: InputEvidence,
  ): Promise<{
    readonly plan: TurnPlan;
    readonly permissionAtInput: string | null;
  }> => {
    if (result.kind === 'plan')
      return { plan: result.plan, permissionAtInput: null };
    const { intent, args } = result;
    if (!PROVIDER_INTENTS.includes(intent))
      return {
        plan:
          intent === 'create_task'
            ? planTask(args, evidence)
            : clarify('unsupported', intent),
        permissionAtInput: null,
      };
    const plan =
      intent === 'query_schedule'
        ? await planRead(intent, args)
        : intent === 'label_mail'
          ? await planLabel(args, input, evidence)
          : await planDraft(args, input, evidence);
    return { plan, permissionAtInput: input?.permission_revision ?? null };
  };

  // 解釈と、意図表・契約での引数の検査。聞き返しなら plan、通れば意図と引数を返す。
  const interpretTurn = async (text: string): Promise<InterpretedTurn> => {
    const done = (plan: TurnPlan) => ({ kind: 'plan' as const, plan });
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
      return done(clarify('unclear', null));
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
      return done(clarify('unclear', null));
    const intent = reply.intent as IntentName;
    const args = reply.args as unknown as ArgValues;
    const checked = checkIntentArgs(intent, args);
    if (checked.missing.length > 0)
      return done(
        clarify(
          checked.missing.includes('target_candidate_id')
            ? 'missing_target'
            : checked.missing.includes('title')
              ? 'missing_title'
              : 'missing_other',
          intent,
        ),
      );
    if (checked.unexpected.length > 0) return done(clarify('invalid', intent));
    // 直前の依頼との関係は信用しない。知っている値で、対象の ID が文字のときだけ使う（なければ unknown）。
    const relation: HoldRelation =
      (['new', 'clarification', 'correction', 'cancel'] as const).find(
        (value) => value === reply.relation,
      ) ?? 'unknown';
    const target =
      typeof reply.target_workflow_id === 'string' &&
      reply.target_workflow_id.length > 0
        ? reply.target_workflow_id
        : null;
    return {
      kind: 'intent',
      intent,
      args,
      relation,
      target_workflow_id: target,
    };
  };

  const workflowState = (plan: TurnPlan): WorkflowState | null => {
    // 会話の操作は依頼ではない（workflow を作らない）。
    if (plan.kind === 'session_control') return null;
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

  // 発言を保存して応答を作る（文字入力と Live の委譲の共通部）。計画（plan）はすでに作ってある。
  // 発言・依頼・入力スナップショット・受付・応答は DB worker の turn.record で一つの transaction に書く。
  // precommit が false を返したら保存せず held を返す（送出の直前の再検査。新しい発話の開始による保留）。
  const recordTurn = async (args: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly storageMode: 'normal' | 'extended';
    readonly ref: ConversationRequestRef;
    readonly text: string;
    readonly plan: TurnPlan;
    readonly permissionAtInput: string | null;
    readonly input?: TurnInputRecord;
    readonly workflowId?: string;
    readonly precommit?: () => boolean;
  }): Promise<
    | {
        readonly kind: 'done';
        readonly status: number;
        readonly body: object;
        readonly replayed: boolean;
        readonly plan: TurnPlan;
      }
    | { readonly kind: 'held' }
  > => {
    const { requestId, sessionId, ref, text } = args;
    let plan = args.plan;
    const fail = (status: number, body: object) =>
      ({
        kind: 'done',
        status,
        body,
        replayed: false,
        plan,
      }) as const;
    const key = await loadKey();
    if (key === null) {
      const response = apiErrorResponse(
        503,
        'dependency_unavailable',
        requestId,
      );
      return fail(response.status, response.body);
    }
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
        args.storageMode === 'extended' ? 'turn_extended' : 'turn_normal'
      ];
    const sealed = sealBlob(key, Buffer.from(text, 'utf8'), {
      ownerTable: 'turns',
      ownerId: turnId,
      ownerVersion: 0,
      purpose: 'turn_text',
    });
    if (!sealed.ok || rule === undefined) {
      const response = apiErrorResponse(
        503,
        'dependency_unavailable',
        requestId,
      );
      return fail(response.status, response.body);
    }
    const state = workflowState(plan);
    const workflowId =
      state === null ? null : (args.workflowId ?? randomUUID());
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
      status: 'answered' | 'clarification' | 'session_control',
      resultView: object | null,
      replyText: string | null,
      sessionControl: SessionControlAction | null = null,
    ) => ({
      request_id: requestId,
      session_id: sessionId,
      turn_id: turnId,
      input_id: inputId,
      workflow_id: workflowId,
      status,
      result_view: resultView,
      reply_text: replyText,
      // 会話の操作のときだけ（それ以外は項目を持たない）。
      ...(sessionControl === null ? {} : { session_control: sessionControl }),
    });
    const responseBody =
      plan.kind === 'session_control'
        ? responseOf('session_control', null, null, plan.action)
        : plan.kind === 'clarify'
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
    // 送出の直前の再検査（新しい発話の開始による保留）。保存の直前に同期で確かめる（この後に await があるのは DB への
    // 送信だけで、保留は保存の命令を送る前に決める）。
    if (args.precommit !== undefined && !args.precommit())
      return { kind: 'held' };
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
      permission_revision: args.permissionAtInput ?? '0',
      request: ref,
      ...(args.input === undefined ? {} : { input: args.input }),
      operation,
      response_json: JSON.stringify(responseBody),
    });
    if (!recorded.ok) {
      const response = conversationError(recorded, requestId);
      return fail(response.status, response.body);
    }
    // 同時の再送で先に保存された発言があった: その応答を返す（この要求の計画は捨てる。操作は作っていない）。
    if (recorded.value.replayed) {
      const response = storedResponse(recorded.value.response_json, requestId);
      return {
        kind: 'done',
        status: response.status,
        body: response.body,
        replayed: true,
        plan,
      };
    }
    if (operation !== null) options.onOperationCreated?.();
    return {
      kind: 'done',
      status: 200,
      body: responseBody,
      replayed: false,
      plan,
    };
  };

  const postTurn: ApiRouteHandler = async (request) => {
    // 入力の時点の口座と許可の版は、最初の await より前に Core のメモリーから控える（外部へ問い合わせない）。
    // DB の照会を待つ間に別の要求が値を更新しても、発言を受けた時点の値で比べる（PR #107 の再々レビュー）。
    const input = observedPermission;
    const device = request.device;
    const body = request.body as JsonObject;
    const requestId = stringOf(body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    // 端末内の音声認識（local_asr）の入力は音声の区間と世代の照合が要る（B06）。B04-03 は文字入力だけ。
    // Live の文字起こし（voice_live）は端末のこの経路では受け付けない（中枢がサイドバンドで受ける。X49）。
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
    // 会話の操作（照合表に全体が一致した短い発話）は、LLM を呼ばず、依頼も作らない（10 §5、X58）。
    const control = resolveSessionControl(text, SESSION_CONTROL_TABLE, 'text');
    // 記録する入力の時点の許可の版は provider を使う意図だけで、連携の接続がない・使わないなら 0 として記録する。
    const planned: {
      readonly plan: TurnPlan;
      readonly permissionAtInput: string | null;
    } =
      control !== null
        ? {
            plan: { kind: 'session_control', action: control.action },
            permissionAtInput: null,
          }
        : await planFrom(await interpretTurn(text), input, 'submitted_text');
    const done = await recordTurn({
      requestId,
      sessionId,
      storageMode: session.value.storage_mode,
      ref,
      text,
      plan: planned.plan,
      permissionAtInput: planned.permissionAtInput,
    });
    if (done.kind === 'held')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    if (
      control !== null &&
      done.status === 200 &&
      !done.replayed &&
      done.plan.kind === 'session_control'
    )
      options.onSessionControl?.({
        device_id: device.device_id,
        session_id: sessionId,
        action: done.plan.action,
      });
    return { status: done.status, body: done.body };
  };

  // Live の委譲（声）から、共通の workflow へ保存する（B05-05、ADR 0052）。入力の受付と方式 C の限定は呼び出し側
  // （LiveConversation）が先に済ませている。ここでも readiness が方式 C（live_policy_observed）を再検査し、4 操作でも
  // 画面承認・方針が自動実行を許さない操作は進めない（requires_full_text）。
  const commitLive = async (
    live: LiveCommitInput,
  ): Promise<LiveCommitResult> => {
    // 入力の時点の許可の版は、最初の await より前に控える（postTurn と同じ）。
    const permission = observedPermission;
    const session = await store.conversation({
      kind: 'session.get',
      session_id: live.session_id,
    });
    if (!session.ok) return { kind: 'failed', status: 503 };
    if (session.value === null || session.value.ended_at !== null)
      return { kind: 'failed', status: 409 };
    const ref: ConversationRequestRef = {
      command_scope_id: live.command_scope_id,
      request_id: live.request_id,
      request_hash: requestHash('liveDelegation', live.session_id, {
        identity: live.identity,
      }),
      command_id: deviceCommandId(live.command_scope_id, live.request_id),
    };
    const found = await store.conversation({ kind: 'turn.find', request: ref });
    if (!found.ok)
      return {
        kind: 'failed',
        status: found.reasons.includes('request_conflict') ? 409 : 503,
      };
    if (found.value !== null) {
      const stored = storedResponse(found.value.response_json, live.request_id);
      return stored.status === 200
        ? {
            kind: 'ok',
            turn: stored.body as TurnResponse,
            replayed: true,
            full_text: false,
          }
        : { kind: 'failed', status: stored.status };
    }
    let planned: {
      readonly plan: TurnPlan;
      readonly permissionAtInput: string | null;
    };
    const interpreted = live.interpreted;
    if (live.outcome === 'blocked')
      planned = { plan: clarify('blocked', null), permissionAtInput: null };
    else if (
      live.outcome === 'partial' &&
      interpreted.kind === 'intent' &&
      INTENT_POLICIES[interpreted.intent].route !== 'read'
    )
      // 確定前の入力から変更は進めない（外部へも問い合わせない）。
      planned = {
        plan: clarify('blocked', interpreted.intent),
        permissionAtInput: null,
      };
    else
      planned = await planFrom(
        interpreted,
        permission,
        live.outcome === 'sealed' ? 'live_policy_observed' : 'unverified',
      );
    const outcome: TurnInputRecord = {
      kind: 'voice_live',
      audio_epoch: live.audio_epoch,
      outcome:
        live.outcome === 'sealed'
          ? { state: 'sealed', policy_version: live.policy_version }
          : { state: live.outcome },
    };
    const done = await recordTurn({
      requestId: live.request_id,
      sessionId: live.session_id,
      storageMode: session.value.storage_mode,
      ref,
      text: live.text,
      plan: planned.plan,
      permissionAtInput: planned.permissionAtInput,
      input: outcome,
      workflowId: live.workflow_id,
      precommit: live.precommit,
    });
    if (done.kind === 'held') return { kind: 'held' };
    if (done.status !== 200) return { kind: 'failed', status: done.status };
    return {
      kind: 'ok',
      turn: done.body as TurnResponse,
      replayed: done.replayed,
      full_text:
        done.plan.kind === 'clarify' && done.plan.reason === 'full_text',
    };
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
    let account: {
      account_id: string;
      permission_revision: string;
      operation_kind: string;
    } | null = null;
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
      const actionKind = (intent['action'] as Record<string, unknown>)['kind'];
      if (
        connection === null ||
        connection.status !== 'active' ||
        typeof actionKind !== 'string' ||
        !canWrite(connection, actionKind) ||
        // 対象のメールを確かめられない（読み取りの範囲がない）なら、承認の表示を出さない。
        !canRead(connection, 'mail.message') ||
        connection.account_id !== accountId ||
        permission === null ||
        permission !== intent['permission_revision']
      )
        return apiErrorResponse(409, 'conflict', requestId);
      account = {
        account_id: accountId,
        permission_revision: permission,
        operation_kind: actionKind,
      };
      display = {
        account_label: connection.account_label ?? null,
        target: await readTargetDisplay(intent, connection),
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
        target: await readTargetDisplay(intent, connection),
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
      // 書込み・読み取りの範囲は種類ごとに見る（許可の版が同じでも、その種類の範囲だけが外れうる）。
      if (
        connection === null ||
        connection.status !== 'active' ||
        !canWrite(connection, binding.account.operation_kind) ||
        !canRead(connection, 'mail.message') ||
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
    interpret: interpretTurn,
    commitLive,
    previewValid,
    previewCurrent: (previewId) => previews.get(previewId) !== null,
    // 起動の後に一度、連携の口座と許可の版を確かめておく（入力の時点の版を外部へ問い合わせずに持つため）。
    // 読めなくても起動は止めない（最初の外部変更の発言は聞き返しになり、そのときの読み取りで控え直す）。
    async prime() {
      const connection = await readConnection();
      if (connection !== null) await readPermission(connection.account_id);
    },
  };
}
