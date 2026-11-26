// 気づきの候補を起点にした自動実行の配線（設計 11 §5・§5A・§5B、08 §1・§9、04 の自動実行の範囲、ADR 0149）。
//
// - 候補を保存した後に呼ぶ。DB の現在値（安全停止・時間窓・候補・依頼・作成済みの操作）を読み、Core が別に確かめた
//   事実（方針・許可の版・抽出の根拠・関連解析の計画）と合わせて、4 種類の操作それぞれを judgeAutoExecution で判定する。
// - 今つなぐのは Buddy 内の用事の登録（create_task、LocalCommand）と、既存のラベルの付与（label_mail、Gmail と模擬の
//   RemoteMutation、ADR 0150）。判定が auto_eligible のとき、確定 intent を
//   契約で確かめて暗号化し、方針による自動承認（auto_approval）と候補の起点（candidate_origin）を付けて
//   operation.create へ送る。作成と承認と一度だけの記録は保存層の一つの transaction で行い、保存層が候補の行から
//   版を読み直して照合する（ADR 0148 の最終ガード）。ここでの判定は最終ガードを省略する理由にならない。
// - 下書き・予定は、判定の結果を返すだけで操作を作らない（not_wired）。書込みの内容（下書きの本文、予定の内容）を
//   決める口がまだない。
// - 拒否・成否不明の操作を自動で作り直さない（U302）。結果は呼び出し側が記録・表示に使う。
// - 本文（題・抄録・メール本文）をログに出さない。用事の本文（body）は空にし、メールの文を写さない。
import type { Deadline } from '@buddy/contracts';
import { judgeAutoExecution } from '@buddy/domain';
import type {
  AnalysisState,
  AutoExecutionDecision,
  AutoExecutionPolicy,
  AutoOperation,
  AutoOperationContext,
  CandidateRequest,
  Completeness,
  EntityRecord,
  LabelProvider,
  ResolvedChange,
  StartupGateDecision,
} from '@buddy/domain';
import { sealOperationIntent } from '@buddy/storage';
import type {
  AutoExecutionStateRecord,
  CreateOperationCommand,
  DataKeyMaterial,
  DbCommand,
  DbSubmission,
} from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import { mailCandidateTitle } from './candidate-intake.js';
import { canRead, canWrite } from './turn-ports.js';
import type {
  ProviderConnection,
  ProviderMailTarget,
  ProviderReader,
} from './turn-ports.js';

// 判定する操作の順（判定表の行の順）。
export const CANDIDATE_AUTO_OPERATIONS: readonly AutoOperation[] = [
  'create_task',
  'create_event',
  'label_mail',
  'draft_reply',
];

// 閉じた候補（本人が不要・解決済みにした）からは作らない。保存層も同じ状態で断る（ADR 0148）。
const CLOSED_STATES: ReadonlySet<string> = new Set(['dismissed', 'resolved']);

export interface CandidateAutoExecutionInput {
  readonly candidate_id: string;
  // 抽出した依頼の要約（モデルの文）。用事の題の材料にだけ使い、検査を通らなければ固定の題にする。
  readonly summary: string;
  readonly request: CandidateRequest;
  readonly completeness: Completeness;
  // 受信時刻を本人のタイムゾーンで表した地域日時。
  readonly received_at_local: string;
  // 本人のタイムゾーン（IANA）。用事の期限はこのタイムゾーンの地域日時で登録する。
  readonly zone: string;
  readonly initial_import: boolean;
  // 関連解析の計画（planRelatedAnalysis の analysis）と、Core の現在の公開世代。
  readonly analysis: AnalysisState;
  readonly current_published_generation: string;
  // 同じ集合の解析結果の変更（取消・完了など）。
  readonly changes: readonly ResolvedChange[];
  // 依頼の元のアカウント（用事・ラベル・下書きの対象アカウント）と、元のメール。
  readonly account_id: string;
  readonly source_id: string;
  // 本人が選んだ自分の予定のカレンダー。無ければ null（予定の行は own_calendar_not_selected で気づきだけ）。
  readonly calendar_id: string | null;
  readonly context: AutoOperationContext;
  readonly label_provider: LabelProvider | null;
  // 本人が割り当てた既存のラベル（provider のラベル ID）。無ければ null（ラベルの行は label_not_assigned で気づきだけ）。
  readonly label_id: string | null;
  // 判定に使う方針・許可の版が現在の版か（Core が別に確かめる）。
  readonly policy_current: boolean;
  readonly permission_current: boolean;
}

export interface CandidateAutoExecutionPorts {
  readonly store: {
    query(query: {
      readonly kind: 'auto_execution_state';
      readonly candidate_id: string;
    }): Promise<AutoExecutionStateRecord>;
    submit(command: DbCommand): DbSubmission;
  };
  // データ鍵（Core が鍵の保管庫から取ったもの）。
  readonly dataKey: DataKeyMaterial;
  readonly contract: ApiContract;
  // 方針（自動実行の規則と版）と、DB に照合させる現在の方針の版。
  readonly policy: AutoExecutionPolicy;
  readonly current_policy_version: string;
  // Buddy 内の用事の登録先と、その保存先の許可の版（TaskOperationIntent）。
  readonly task: {
    readonly list_id: string;
    readonly permission_revision: string;
  };
  // SHA-256 の 16 進（node:crypto）。
  readonly sha256Hex: (material: string) => string;
  readonly newId: () => string;
  // いまの UTC 時刻（ISO 8601）。
  readonly now: () => string;
  // 連携の provider の読み取り（接続・許可の版・対象のメール）。ラベルの付与で使う。無ければ null。
  readonly provider: ProviderReader | null;
  // 保存期限の掃除のゲート（ADR 0053・0058）。ラベルの付与で provider を読む前に掃除が済むのを待ち、閉じていれば
  // 作らない（retention_blocked）。発言の入口（api-turns.ts）と同じ口。用事の登録は Buddy 内だけなので通さない。
  readonly retention: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    // 掃除が動いている・待っている・ゲートが閉じているときは null。返された関数を呼ぶまで新しい掃除は本体に入らない。
    readonly lease: () => (() => void) | null;
  };
  // 自動承認した操作の実行を始める（OperationRunner.afterApproval）。
  readonly afterApproval: (operationId: string) => void;
}

export type CandidateOperationOutcome =
  // 方針による自動承認で操作を作り、実行を始めた。
  | { readonly kind: 'created'; readonly operation_id: string }
  // 判定が auto_eligible 以外（気づきだけ・保留・承認待ち）。操作は作らない。
  | { readonly kind: 'not_eligible' }
  // 判定は通ったが、この操作の書込みはまだつないでいない。
  | { readonly kind: 'not_wired' }
  // 判定は通ったが、作る内容を決められない（期限のタイムゾーンが本人の設定と違うなど）。
  | { readonly kind: 'not_created'; readonly reasons: readonly string[] }
  // 保存層が断った（最終ガード・安全停止・時間窓）。適用していないことが確か。
  | {
      readonly kind: 'rejected';
      readonly operation_id: string;
      readonly reasons: readonly string[];
    }
  // 保存の成否が不明。作り直さない（U302）。
  | {
      readonly kind: 'unknown';
      readonly operation_id: string;
      readonly reasons: readonly string[];
    };

export interface CandidateOperationResult {
  readonly operation: AutoOperation;
  readonly decision: AutoExecutionDecision;
  readonly reason_codes: readonly string[];
  readonly outcome: CandidateOperationOutcome;
}

export type CandidateAutoExecutionResult =
  // 判定に入れる DB の現在値が揃わない。どの操作も判定しない。
  | { readonly kind: 'skipped'; readonly reasons: readonly string[] }
  | {
      readonly kind: 'judged';
      readonly results: readonly CandidateOperationResult[];
    };

// 同じ対象への反復を数える鍵（ADR 0147）。操作の種類・アカウント・元のメールから作り、SHA-256 の 16 進にする。
// メールの ID を DB の平文の列に残さないため、ハッシュにする（U304）。
export function candidateSafetyTargetKey(
  operation: AutoOperation,
  accountId: string,
  sourceId: string,
  sha256Hex: (material: string) => string,
): string {
  return `auto:${sha256Hex(JSON.stringify([operation, accountId, sourceId]))}`;
}

// 用事の期限。日付だけの期限は日付のまま（23:59 などを補わない。11 §5 D15）、時刻のある期限は本人の
// タイムゾーンの地域日時で登録する。期限のタイムゾーンが本人の設定と違うときは変換せず、作らない（U305）。
export function candidateTaskDue(
  deadline: Deadline,
  zone: string,
):
  | { readonly ok: true; readonly due: string | null }
  | { readonly ok: false; readonly reason: string } {
  switch (deadline.kind) {
    case 'none':
      return { ok: true, due: null };
    case 'date':
      return { ok: true, due: deadline.date };
    case 'instant':
      return deadline.zone === zone
        ? { ok: true, due: deadline.local_datetime }
        : { ok: false, reason: 'deadline_zone_mismatch' };
    case 'unresolved':
      return { ok: false, reason: 'deadline_unresolved' };
  }
}

// 用事の題。依頼の要約から候補の題と同じ検査で作り、期限・差出人は付けない（期限は due に入る）。
export function candidateTaskTitle(summary: string): string | null {
  return mailCandidateTitle({
    kind: 'mail_deadline',
    summary,
    deadline: { kind: 'none' },
    sender_label: null,
  });
}

function stateReasons(
  state: AutoExecutionStateRecord,
):
  | { readonly ok: true; readonly entity: EntityRecord }
  | { readonly ok: false; readonly reasons: readonly string[] } {
  if (state.candidate === null)
    return { ok: false, reasons: ['candidate_not_found'] };
  const reasons: string[] = [];
  if (CLOSED_STATES.has(state.candidate.state))
    reasons.push('candidate_closed');
  if (
    state.candidate.request_entity_id === null ||
    state.candidate.request_revision === null
  )
    reasons.push('candidate_without_request');
  else if (state.entity === null) reasons.push('entity_not_found');
  else if (state.entity.request_revision !== state.candidate.request_revision)
    reasons.push('request_revision_changed');
  if (reasons.length > 0 || state.entity === null)
    return { ok: false, reasons };
  return { ok: true, entity: state.entity.record };
}

export async function runCandidateAutoExecution(
  ports: CandidateAutoExecutionPorts,
  input: CandidateAutoExecutionInput,
): Promise<CandidateAutoExecutionResult> {
  const state = await ports.store.query({
    kind: 'auto_execution_state',
    candidate_id: input.candidate_id,
  });
  const usable = stateReasons(state);
  if (!usable.ok) return { kind: 'skipped', reasons: usable.reasons };
  const results: CandidateOperationResult[] = [];
  for (const operation of CANDIDATE_AUTO_OPERATIONS) {
    const judgment = judgeAutoExecution({
      operation,
      policy: ports.policy,
      policy_current: input.policy_current,
      permission_current: input.permission_current,
      safety_stopped: state.safety_stopped,
      auto_approvals: state.auto_approvals,
      now: ports.now(),
      initial_import: input.initial_import,
      request: input.request,
      completeness: input.completeness,
      received_at_local: input.received_at_local,
      // カレンダーが無いのに選択済みとはしない（重複キーはカレンダーを必須にする）。
      // 付けるラベルの ID が無いのに割り当て済みとはしない（何を付けるか決まらない）。
      context: {
        ...input.context,
        ownCalendarSelected:
          input.context.ownCalendarSelected && input.calendar_id !== null,
        labelAssigned: input.context.labelAssigned && input.label_id !== null,
      },
      label_provider: input.label_provider,
      analysis: input.analysis,
      current_published_generation: input.current_published_generation,
      entity: usable.entity,
      changes: input.changes,
      target: {
        account_id: input.account_id,
        calendar_id: operation === 'create_event' ? input.calendar_id : null,
      },
    });
    const base = {
      operation,
      decision: judgment.decision,
      reason_codes: judgment.reason_codes,
    };
    if (judgment.decision !== 'auto_eligible') {
      results.push({ ...base, outcome: { kind: 'not_eligible' } });
      continue;
    }
    if (operation === 'create_task')
      results.push({
        ...base,
        outcome: await createTask(ports, input, state),
      });
    else if (operation === 'label_mail')
      results.push({
        ...base,
        outcome: await createLabel(ports, input, state),
      });
    else results.push({ ...base, outcome: { kind: 'not_wired' } });
  }
  return { kind: 'judged', results };
}

interface AutoCreate {
  readonly operation: 'create_task' | 'label_mail';
  readonly operation_id: string;
  readonly operation_kind: 'task.create' | 'mail.labels.change';
  readonly effect_route: 'local_command' | 'remote_mutation';
  readonly permission_revision: string;
  readonly content: Record<string, unknown>;
}

// 確定 intent を契約で確かめて暗号化し、方針による自動承認と候補の起点を付けて作る。保存できたら実行を始める。
async function submitAuto(
  ports: CandidateAutoExecutionPorts,
  input: CandidateAutoExecutionInput,
  state: AutoExecutionStateRecord,
  create: AutoCreate,
): Promise<CandidateOperationOutcome> {
  const operationId = create.operation_id;
  if (!ports.contract.valid('OperationIntent', create.content))
    return { kind: 'not_created', reasons: ['intent_invalid'] };
  const sealed = sealOperationIntent(
    ports.dataKey,
    { operationId, contentVersion: 1 },
    create.content,
    ports.newId(),
  );
  if (!sealed.ok) return { kind: 'not_created', reasons: ['seal_failed'] };
  const command: CreateOperationCommand = {
    command_id: ports.newId(),
    kind: 'operation.create',
    operation_id: operationId,
    expected_state_revision: '0',
    request_revision: null,
    permission_revision: create.permission_revision,
    forgetting_generation: state.forgetting_generation,
    connection_id: null,
    request: null,
    workflow_id: null,
    operation_kind: create.operation_kind,
    effect_route: create.effect_route,
    content_hash: sealed.content_hash,
    intent: sealed.intent,
    auto_approval: {
      approval_id: ports.newId(),
      policy_version: ports.policy.policy_version,
      current_policy_version: ports.current_policy_version,
      safety_target_key: candidateSafetyTargetKey(
        create.operation,
        input.account_id,
        input.source_id,
        ports.sha256Hex,
      ),
    },
    candidate_origin: {
      candidate_id: input.candidate_id,
      account_id: input.account_id,
      calendar_id: null,
    },
  };
  const outcome = await ports.store.submit(command).result;
  if (outcome.outcome === 'durable') {
    ports.afterApproval(operationId);
    return { kind: 'created', operation_id: operationId };
  }
  if (outcome.outcome === 'unknown')
    return {
      kind: 'unknown',
      operation_id: operationId,
      reasons: [outcome.reason],
    };
  return {
    kind: 'rejected',
    operation_id: operationId,
    reasons: outcome.outcome === 'rejected' ? outcome.reasons : ['accepted'],
  };
}

async function createTask(
  ports: CandidateAutoExecutionPorts,
  input: CandidateAutoExecutionInput,
  state: AutoExecutionStateRecord,
): Promise<CandidateOperationOutcome> {
  const title = candidateTaskTitle(input.summary);
  const due = candidateTaskDue(input.request.deadline, input.zone);
  const reasons: string[] = [];
  if (title === null) reasons.push('title_invalid');
  if (!due.ok) reasons.push(due.reason);
  if (title === null || !due.ok) return { kind: 'not_created', reasons };
  const operationId = ports.newId();
  return submitAuto(ports, input, state, {
    operation: 'create_task',
    operation_id: operationId,
    operation_kind: 'task.create',
    effect_route: 'local_command',
    permission_revision: ports.task.permission_revision,
    content: {
      schema: 'buddy.operation.v1',
      operation_id: operationId,
      content_version: '1',
      permission_revision: ports.task.permission_revision,
      target: { list_id: ports.task.list_id },
      action: { kind: 'task.create', title, due: due.due, body: null },
      effects: {
        external_recipients: [],
        reconcile_scope: 'local_transaction',
      },
    },
  });
}

// 掃除の貸し出しを取り直す回数（発言の入口と同じ）。
const LEASE_ATTEMPTS = 3;

// 連携の provider の名前と、判定表のラベルの元サービスの対応。
const LABEL_PROVIDER_OF: Readonly<
  Record<ProviderConnection['provider'], LabelProvider>
> = {
  gmail: 'google',
  microsoft_graph: 'microsoft',
  mock: 'mock',
};

// 既存のラベルを元のメールに 1 つ足す（Gmail のラベル追加は加算の操作。11 §5A）。外すラベルは作らない。
// 接続・許可の版・対象のメールを今読み直し、接続のアカウントと元サービスが判定に使った値と同じときだけ作る。
// 送出の直前には実行器が対象の版と許可の版をもう一度確かめる（D1、ADR 0030）。
async function createLabel(
  ports: CandidateAutoExecutionPorts,
  input: CandidateAutoExecutionInput,
  state: AutoExecutionStateRecord,
): Promise<CandidateOperationOutcome> {
  const provider = ports.provider;
  const labelId = input.label_id;
  if (labelId === null)
    return { kind: 'not_created', reasons: ['label_not_assigned'] };
  // Outlook のカテゴリは判定で承認待ちになる。ここへ来るのは Gmail と模擬だけ（念のため確かめる）。
  if (input.label_provider !== 'google' && input.label_provider !== 'mock')
    return { kind: 'not_created', reasons: ['label_provider_unsupported'] };
  if (provider === null)
    return { kind: 'not_created', reasons: ['connection_unavailable'] };
  // 掃除が済むまで provider を読まない（ADR 0053）。ゲートの確認と貸し出しの取得は同じ同期の区間で行い、
  // 読み直しが終わるまで貸し出しを持つ。保存（Buddy 内）と実行の開始の前に返す（送出は実行担当が別に通す）。
  let release: (() => void) | null = null;
  for (
    let attempt = 0;
    release === null && attempt < LEASE_ATTEMPTS;
    attempt += 1
  ) {
    await ports.retention.ready();
    const gate = ports.retention.gate();
    if (!gate.search || !gate.cloud_send || !gate.auto_use)
      return { kind: 'not_created', reasons: ['retention_blocked'] };
    // 取れないのは、ready の後に別の掃除が始まったとき。その掃除が済むのを待って確かめ直す。
    release = ports.retention.lease();
  }
  if (release === null)
    return { kind: 'not_created', reasons: ['retention_blocked'] };
  let read: LabelRead;
  try {
    read = await readLabelTarget(provider, input, labelId);
  } finally {
    release();
  }
  if (!read.ok) return { kind: 'not_created', reasons: [read.reason] };
  const { connection, permission, target } = read;
  const operationId = ports.newId();
  return submitAuto(ports, input, state, {
    operation: 'label_mail',
    operation_id: operationId,
    operation_kind: 'mail.labels.change',
    effect_route: 'remote_mutation',
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
        add: [labelId],
        remove: [],
      },
      effects: { external_recipients: [], reconcile_scope: 'exact_target' },
    },
  });
}

type LabelRead =
  | {
      readonly ok: true;
      readonly connection: ProviderConnection;
      readonly permission: string;
      readonly target: ProviderMailTarget;
    }
  | { readonly ok: false; readonly reason: string };

// 接続・許可の版・対象のメールを今読み直す（掃除の貸し出しを持った区間で呼ぶ）。
async function readLabelTarget(
  provider: ProviderReader,
  input: CandidateAutoExecutionInput,
  labelId: string,
): Promise<LabelRead> {
  let connection: ProviderConnection | null;
  try {
    connection = await provider.connection();
  } catch {
    connection = null;
  }
  if (
    connection === null ||
    connection.status !== 'active' ||
    connection.account_id !== input.account_id ||
    !canWrite(connection, 'mail.labels.change') ||
    !canRead(connection, 'mail.message')
  )
    return { ok: false, reason: 'connection_unavailable' };
  if (LABEL_PROVIDER_OF[connection.provider] !== input.label_provider)
    return { ok: false, reason: 'label_provider_changed' };
  let permission: string | null = null;
  try {
    const read = await provider.readPermission(input.account_id);
    if (read !== null && read.account_id === input.account_id)
      permission = read.permission_revision;
  } catch {
    permission = null;
  }
  if (permission === null)
    return { ok: false, reason: 'connection_unavailable' };
  let target: ProviderMailTarget | null;
  try {
    target = await provider.readTarget(input.source_id);
  } catch {
    target = null;
  }
  if (target === null || target.remote_id !== input.source_id)
    return { ok: false, reason: 'target_not_found' };
  if (target.labels.includes(labelId))
    return { ok: false, reason: 'no_change' };
  return { ok: true, connection, permission, target };
}
