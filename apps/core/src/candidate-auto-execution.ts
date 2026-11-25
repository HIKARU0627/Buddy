// 気づきの候補を起点にした自動実行の配線（設計 11 §5・§5A・§5B、08 §1・§9、04 の自動実行の範囲、ADR 0149）。
//
// - 候補を保存した後に呼ぶ。DB の現在値（安全停止・時間窓・候補・依頼・作成済みの操作）を読み、Core が別に確かめた
//   事実（方針・許可の版・抽出の根拠・関連解析の計画）と合わせて、4 種類の操作それぞれを judgeAutoExecution で判定する。
// - 今つなぐのは Buddy 内の用事の登録（create_task、LocalCommand）だけ。判定が auto_eligible のとき、確定 intent を
//   契約で確かめて暗号化し、方針による自動承認（auto_approval）と候補の起点（candidate_origin）を付けて
//   operation.create へ送る。作成と承認と一度だけの記録は保存層の一つの transaction で行い、保存層が候補の行から
//   版を読み直して照合する（ADR 0148 の最終ガード）。ここでの判定は最終ガードを省略する理由にならない。
// - ラベル・下書き・予定は、判定の結果を返すだけで操作を作らない（not_wired）。書込みの内容（付けるラベル、下書きの
//   本文、予定のカレンダー）を決める口がまだない。
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
      context:
        operation === 'create_event'
          ? {
              ...input.context,
              ownCalendarSelected:
                input.context.ownCalendarSelected && input.calendar_id !== null,
            }
          : input.context,
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
    if (operation !== 'create_task') {
      results.push({ ...base, outcome: { kind: 'not_wired' } });
      continue;
    }
    results.push({
      ...base,
      outcome: await createTask(ports, input, state),
    });
  }
  return { kind: 'judged', results };
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
  const content = {
    schema: 'buddy.operation.v1',
    operation_id: operationId,
    content_version: '1',
    permission_revision: ports.task.permission_revision,
    target: { list_id: ports.task.list_id },
    action: { kind: 'task.create', title, due: due.due, body: null },
    effects: { external_recipients: [], reconcile_scope: 'local_transaction' },
  };
  if (!ports.contract.valid('OperationIntent', content))
    return { kind: 'not_created', reasons: ['intent_invalid'] };
  const sealed = sealOperationIntent(
    ports.dataKey,
    { operationId, contentVersion: 1 },
    content,
    ports.newId(),
  );
  if (!sealed.ok) return { kind: 'not_created', reasons: ['seal_failed'] };
  const command: CreateOperationCommand = {
    command_id: ports.newId(),
    kind: 'operation.create',
    operation_id: operationId,
    expected_state_revision: '0',
    request_revision: null,
    permission_revision: ports.task.permission_revision,
    forgetting_generation: state.forgetting_generation,
    connection_id: null,
    request: null,
    workflow_id: null,
    operation_kind: 'task.create',
    effect_route: 'local_command',
    content_hash: sealed.content_hash,
    intent: sealed.intent,
    auto_approval: {
      approval_id: ports.newId(),
      policy_version: ports.policy.policy_version,
      current_policy_version: ports.current_policy_version,
      safety_target_key: candidateSafetyTargetKey(
        'create_task',
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
