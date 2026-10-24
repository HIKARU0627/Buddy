// 承認の受付と、DB worker へ渡す命令の再検査（設計 08 §1・§3・§5、03 承認は操作の版に結び付ける、ADR 0010）。
// DB の一意制約（approvals_one_effective など）と同じ結論になる純粋な判定。最終の保証は DB の制約と transaction。

import {
  scopedForgettingReasons,
  type ForgettingScope,
} from './late-result.js';

export interface OperationVersionState {
  readonly operation_id: string;
  readonly current_content_version: string;
  readonly content_hash: string;
  readonly state_revision: string;
  readonly state: string;
  readonly effective_approval: {
    readonly content_version: string;
    readonly content_hash: string;
  } | null;
}

export interface ApprovalAttempt {
  readonly route: 'screen' | 'policy_auto';
  readonly content_version: string;
  readonly content_hash: string;
  readonly expected_state_revision: string;
  // 画面の承認は、この端末・接続範囲に結び付いた有効な preview が必要。
  readonly preview_valid: boolean;
  readonly policy_version: string | null;
  readonly current_policy_version: string;
}

// 承認を記録するか。同じ内容版に有効な承認があれば新しく作らず、その状態を返す（X02）。
// 内容版・hash が違えば拒否し、旧承認を新しい内容へ流用しない。
export function approvalDecision(
  operation: OperationVersionState,
  attempt: ApprovalAttempt,
): {
  readonly action: 'record' | 'existing' | 'reject';
  readonly reasons: string[];
} {
  const reasons: string[] = [];
  if (attempt.content_version !== operation.current_content_version)
    reasons.push('content_version_changed');
  if (attempt.content_hash !== operation.content_hash)
    reasons.push('content_hash_mismatch');
  if (reasons.length === 0 && operation.effective_approval !== null)
    return operation.effective_approval.content_version ===
      attempt.content_version &&
      operation.effective_approval.content_hash === attempt.content_hash
      ? { action: 'existing', reasons: [] }
      : { action: 'reject', reasons: ['approval_conflict'] };
  if (attempt.expected_state_revision !== operation.state_revision)
    reasons.push('state_revision_changed');
  if (operation.state !== 'awaiting_approval')
    reasons.push('not_awaiting_approval');
  if (attempt.route === 'screen' && !attempt.preview_valid)
    reasons.push('preview_invalid');
  // 方針の版が変わった後に、古い版で判定した自動承認を使わない（08 §1）。
  if (
    attempt.route === 'policy_auto' &&
    attempt.policy_version !== attempt.current_policy_version
  )
    reasons.push('policy_version_changed');
  return reasons.length === 0
    ? { action: 'record', reasons: [] }
    : { action: 'reject', reasons };
}

// DB worker へ渡す命令（11 §9 P06）。worker 内で DB の現在値と照合する。
export interface DbCommand {
  readonly command_id: string;
  readonly kind: string;
  readonly expected_state_revision: string;
  readonly request_revision: string | null;
  readonly permission_revision: string;
  readonly forgetting_generation: string;
}

export interface DbCurrent {
  readonly state_revision: string;
  readonly request_revision: string | null;
  readonly permission_revision: string;
  readonly forgetting_generation: string;
  readonly applied_command_ids: readonly string[];
  readonly safety_stopped: boolean;
  readonly reservation_valid: boolean;
}

// 同じ command_id の再到着は既存の結果を返し、再度変更しない。版が一つでも違えば適用しない。
// options.forgetting を渡さなければ、忘却世代が違えば拒否する（従来どおり）。渡したときだけ、
// 世代の検査を命令の由来が忘却と関係するときに絞る（ADR 0044。storage への配線は B06 の後続）。
export function commandGuard(
  command: DbCommand,
  current: DbCurrent,
  options: {
    readonly external: boolean;
    readonly forgetting?: ForgettingScope;
  },
): {
  readonly action: 'apply' | 'already_applied' | 'reject';
  readonly reasons: string[];
} {
  if (current.applied_command_ids.includes(command.command_id))
    return { action: 'already_applied', reasons: [] };
  const reasons: string[] = [];
  if (command.expected_state_revision !== current.state_revision)
    reasons.push('state_revision_changed');
  if (command.request_revision !== current.request_revision)
    reasons.push('request_revision_changed');
  if (command.permission_revision !== current.permission_revision)
    reasons.push('permission_changed');
  const forgettingRejected =
    options.forgetting === undefined
      ? command.forgetting_generation !== current.forgetting_generation
      : scopedForgettingReasons(
          command.forgetting_generation,
          current.forgetting_generation,
          options.forgetting,
        ).length > 0;
  if (forgettingRejected) reasons.push('forgetting_generation_changed');
  // 外部へ送る直前の transaction では、安全停止と予算予約の有効性も見る（08 §3 P01）。
  if (options.external && current.safety_stopped)
    reasons.push('safety_stopped');
  if (options.external && !current.reservation_valid)
    reasons.push('reservation_invalid');
  return reasons.length === 0
    ? { action: 'apply', reasons: [] }
    : { action: 'reject', reasons };
}
