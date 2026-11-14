// 画面承認が必要な外部変更（送信・予定の変更・参加者のいる予定の作成・ごみ箱）の
// 送出直前の照合（設計 08 §2・§3、設計 04 表、ADR 0075）。
// ここで決めるのは「形式として拒否を表せること」だけで、実際の送出・照合・保存は B14-02〜B14-04。

export const APPROVAL_REQUIRED_OPERATION_KINDS = [
  'mail.send',
  'calendar.event.update',
  'calendar.event.create_with_attendees',
  'mail.trash',
] as const;
export type ApprovalRequiredOperationKind =
  (typeof APPROVAL_REQUIRED_OPERATION_KINDS)[number];

// 拒否の理由。結果不明（unknown_held）は拒否ではないので、ここへ入れず保留として扱う。
export const DISPATCH_GUARD_REJECTIONS = [
  'not_approved',
  'approval_cancelled',
  'content_changed',
  'recipient_changed',
  'target_changed',
  'stale_version',
] as const;
export type DispatchGuardRejection = (typeof DISPATCH_GUARD_REJECTIONS)[number];

export interface OperationTargetVersion {
  readonly content_version: string;
  readonly content_hash: string;
}

export interface ApprovalBinding {
  readonly content_version: string;
  readonly content_hash: string;
  readonly state_revision: string;
  readonly cancelled: boolean;
}

export interface DispatchGuard {
  readonly operation_id: string;
  readonly operation_kind: ApprovalRequiredOperationKind;
  readonly content_version: string;
  readonly content_hash: string;
  readonly state_revision: string;
  readonly approval: ApprovalBinding | null;
  readonly target: OperationTargetVersion | null;
  readonly expected_target: OperationTargetVersion | null;
}

function sameTarget(
  left: OperationTargetVersion | null,
  right: OperationTargetVersion | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.content_version === right.content_version &&
    left.content_hash === right.content_hash
  );
}

// 送出してよいか。理由をすべて返し、一つでもあれば送出しない。
// 判定の順は、未承認 → 取消 → 内容 → 宛先・対象 → 版の順で安定させる。
export function dispatchGuardReasons(
  guard: DispatchGuard,
): DispatchGuardRejection[] {
  const reasons: DispatchGuardRejection[] = [];
  const { approval } = guard;
  if (!approval) {
    reasons.push('not_approved');
    return reasons;
  }
  if (approval.cancelled) reasons.push('approval_cancelled');
  if (
    approval.content_version !== guard.content_version ||
    approval.content_hash !== guard.content_hash
  )
    reasons.push('content_changed');
  if (approval.state_revision !== guard.state_revision)
    reasons.push('stale_version');
  if (!sameTarget(guard.target, guard.expected_target))
    reasons.push(
      guard.operation_kind === 'mail.send'
        ? 'recipient_changed'
        : 'target_changed',
    );
  // 参加者のいる予定の作成は既存の対象を持たない。他の 3 種類は対象の版が要る。
  if (
    guard.operation_kind !== 'calendar.event.create_with_attendees' &&
    guard.target === null
  ) {
    if (!reasons.includes('target_changed')) reasons.push('target_changed');
  }
  return reasons;
}

export function canDispatch(guard: DispatchGuard): boolean {
  return dispatchGuardReasons(guard).length === 0;
}
