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
  readonly recipients: readonly string[] | null;
  readonly expected_recipients: readonly string[] | null;
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

// 宛先はメールアドレスの大文字小文字を区別せず、重複を除いて比べる（ADR 0075）。
function recipientKey(values: readonly string[] | null): string[] | null {
  if (values === null) return null;
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}

function sameRecipients(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  const a = recipientKey(left);
  const b = recipientKey(right);
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// 送信と予定の 2 種類は宛先・参加者を持つ。ごみ箱は持たない。
function hasRecipients(kind: ApprovalRequiredOperationKind): boolean {
  return kind !== 'mail.trash';
}

// 既存の対象を持つ種類。参加者のいる予定の作成と新規の送信は対象を持たない。
function needsTarget(kind: ApprovalRequiredOperationKind): boolean {
  return kind === 'calendar.event.update' || kind === 'mail.trash';
}

// 送出してよいか。理由をすべて返し、一つでもあれば送出しない。
// 判定の順は、未承認 → 取消 → 内容 → 宛先 → 対象 → 版の順で安定させる。
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
  if (
    hasRecipients(guard.operation_kind) &&
    (guard.recipients === null ||
      guard.expected_recipients === null ||
      !sameRecipients(guard.recipients, guard.expected_recipients))
  )
    reasons.push('recipient_changed');
  if (!sameTarget(guard.target, guard.expected_target))
    reasons.push('target_changed');
  if (approval.state_revision !== guard.state_revision)
    reasons.push('stale_version');
  // 予定の変更とごみ箱は既存の対象の版が要る。読めなければ対象の変更として扱う。
  if (needsTarget(guard.operation_kind) && guard.target === null) {
    if (!reasons.includes('target_changed')) reasons.push('target_changed');
  }
  return reasons;
}

export function canDispatch(guard: DispatchGuard): boolean {
  return dispatchGuardReasons(guard).length === 0;
}
