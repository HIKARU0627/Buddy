// 抽出結果から候補起点の自動実行へ進めるかの判定（設計 11 §3・§5・§5A、ADR 0007）。
// 年不明・根拠の不一致・未読を推測で埋めず、条件を満たさない候補は気づきだけにする。

export type Deadline =
  | {
      readonly kind: 'instant';
      readonly local_datetime: string;
      readonly zone: string;
      readonly original_text: string;
    }
  | {
      readonly kind: 'date';
      readonly date: string;
      readonly original_text: string;
    }
  | {
      readonly kind: 'unresolved';
      readonly reason:
        | 'missing_year'
        | 'missing_date'
        | 'relative'
        | 'conflict'
        | 'missing_zone';
      readonly original_text: string;
    }
  | { readonly kind: 'none' };

export interface WireDeadline {
  readonly resolution:
    'exact_datetime' | 'date_only' | 'relative_unresolved' | 'none';
  readonly local_datetime: string | null;
  readonly local_date: string | null;
  readonly original_text: string | null;
  readonly unresolved_reason:
    | 'missing_year'
    | 'missing_date'
    | 'relative'
    | 'conflict'
    | 'missing_zone'
    | null;
}

// モデルの期限を契約の Deadline へ。組み合わせが矛盾する出力は推測せず null（意味検証の失敗）。
export function toDeadline(wire: WireDeadline, zone: string): Deadline | null {
  const text = wire.original_text;
  switch (wire.resolution) {
    case 'exact_datetime':
      return wire.local_datetime && !wire.local_date && text
        ? {
            kind: 'instant',
            local_datetime: wire.local_datetime,
            zone,
            original_text: text,
          }
        : null;
    case 'date_only':
      return wire.local_date && !wire.local_datetime && text
        ? { kind: 'date', date: wire.local_date, original_text: text }
        : null;
    case 'relative_unresolved':
      return !wire.local_date &&
        !wire.local_datetime &&
        text &&
        wire.unresolved_reason
        ? {
            kind: 'unresolved',
            reason: wire.unresolved_reason,
            original_text: text,
          }
        : null;
    case 'none':
      return wire.local_date || wire.local_datetime ? null : { kind: 'none' };
  }
}

export interface FieldEvidenceLike {
  readonly field: 'summary' | 'kind' | 'target' | 'deadline' | 'change';
  readonly status:
    'explicit' | 'derived' | 'missing' | 'conflicting' | 'unread';
  readonly refs: readonly unknown[];
  readonly rule_id: string | null;
}

export interface CandidateRequest {
  readonly kind: 'reply_required' | 'action_required' | 'fyi';
  readonly deadline: Deadline;
  readonly fields: readonly FieldEvidenceLike[];
  readonly in_quoted_text: boolean;
  readonly confidence_observed: 'low' | 'medium' | 'high';
  readonly addressed_to_me: boolean;
  readonly from_automated_sender: boolean;
}

export interface Completeness {
  readonly unread_source_ids: readonly string[];
  readonly truncated_source_ids: readonly string[];
}

// 受信時刻より前の期限か。日付だけの期限は時刻を補わず、受信日と日付どうしで比べる。
// 同じタイムゾーンの地域日時・日付の文字列は辞書順で前後を比べられる。
function deadlinePast(deadline: Deadline, receivedAtLocal: string): boolean {
  if (deadline.kind === 'instant')
    return deadline.local_datetime < receivedAtLocal;
  if (deadline.kind === 'date')
    return deadline.date < receivedAtLocal.slice(0, 10);
  return false;
}

// 4 種類の自動操作に共通の検査（11 §5 の共通検査）。
export function candidateCommonReasons(
  request: CandidateRequest,
  completeness: Completeness,
  receivedAtLocal: string,
): string[] {
  const reasons: string[] = [];
  if (request.confidence_observed === 'low') reasons.push('confidence_low');
  if (request.deadline.kind === 'unresolved')
    reasons.push(`deadline_unresolved:${request.deadline.reason}`);
  for (const field of request.fields) {
    const verified =
      (field.status === 'explicit' && field.refs.length > 0) ||
      (field.status === 'derived' && field.rule_id !== null);
    if (!verified) reasons.push(`evidence_${field.status}:${field.field}`);
  }
  if (request.in_quoted_text) reasons.push('in_quoted_text');
  if (completeness.unread_source_ids.length) reasons.push('unread_sources');
  if (completeness.truncated_source_ids.length)
    reasons.push('truncated_sources');
  if (deadlinePast(request.deadline, receivedAtLocal))
    reasons.push('deadline_past');
  return reasons;
}

export type AutoOperation =
  'create_task' | 'create_event' | 'label_mail' | 'draft_reply';

export interface AutoOperationContext {
  readonly ownCalendarSelected: boolean;
  readonly labelAssigned: boolean;
  readonly draftExists: boolean;
  readonly budgetAvailable: boolean;
}

// 判定表の各行（11 §5、§5A D15）。共通検査に加えて操作ごとの条件を見る。
export function autoOperationReasons(
  operation: AutoOperation,
  request: CandidateRequest,
  context: AutoOperationContext,
): string[] {
  const reasons: string[] = [];
  const confidenceAtLeastMedium = request.confidence_observed !== 'low';
  const personal = () => {
    if (!request.addressed_to_me) reasons.push('not_addressed_to_me');
    if (request.from_automated_sender) reasons.push('automated_sender');
  };
  if (operation === 'create_task' || operation === 'create_event') {
    if (request.kind === 'fyi') reasons.push('not_a_request');
    if (!confidenceAtLeastMedium) reasons.push('confidence_low');
    personal();
    if (request.deadline.kind !== 'instant' && request.deadline.kind !== 'date')
      reasons.push('deadline_not_fixed');
  }
  if (operation === 'create_event') {
    if (request.deadline.kind !== 'instant')
      reasons.push('deadline_not_instant');
    if (request.confidence_observed !== 'high')
      reasons.push('confidence_not_high');
    if (!context.ownCalendarSelected) reasons.push('own_calendar_not_selected');
  }
  if (operation === 'label_mail' && !context.labelAssigned)
    reasons.push('label_not_assigned');
  if (operation === 'draft_reply') {
    if (request.kind !== 'reply_required') reasons.push('not_reply_required');
    if (!confidenceAtLeastMedium) reasons.push('confidence_low');
    personal();
    if (context.draftExists) reasons.push('draft_exists');
    if (!context.budgetAvailable) reasons.push('budget_unavailable');
  }
  return reasons.filter((reason, index, all) => all.indexOf(reason) === index);
}
