// 関連集合の解析完了と、依頼・取消の順序に依存しない状態の解決（設計 11 §5A・§5B F05、08 §3 F05）。

export interface AnalysisState {
  readonly group_id: string;
  readonly analysis_revision: string;
  readonly source_set_hash: string;
  readonly published_generation: string;
  readonly plan_complete: boolean;
  readonly sources: readonly {
    readonly state: 'analyzed' | 'pending' | 'unread' | 'failed' | 'excluded';
    readonly rule_id: string | null;
  }[];
  readonly unresolved_change_count: number;
}

// 列挙・必要な解析・関係の解決が揃い、現在の公開世代に対する判定であるときだけ ready。
// 未読・失敗・予算待ちは解析完了に数えず、空の結果で ready にしない。
export function analysisReadiness(
  analysis: AnalysisState,
  currentPublishedGeneration: string,
): { readonly ready: boolean; readonly reasons: string[] } {
  const reasons: string[] = [];
  if (!analysis.plan_complete) reasons.push('plan_incomplete');
  if (analysis.published_generation !== currentPublishedGeneration)
    reasons.push('generation_changed');
  for (const state of ['pending', 'unread', 'failed'] as const)
    if (analysis.sources.some((source) => source.state === state))
      reasons.push(`source_${state}`);
  if (
    analysis.sources.some(
      (source) => source.state === 'excluded' && source.rule_id === null,
    )
  )
    reasons.push('excluded_without_rule');
  if (analysis.unresolved_change_count > 0) reasons.push('unresolved_changes');
  return { ready: reasons.length === 0, reasons };
}

// 判定に使った版が最終 transaction の時点でも現在の版か（08 §3 F05）。
export function analysisStillCurrent(
  used: Pick<
    AnalysisState,
    | 'group_id'
    | 'analysis_revision'
    | 'source_set_hash'
    | 'published_generation'
  >,
  current: AnalysisState,
  currentPublishedGeneration: string,
): boolean {
  return (
    used.group_id === current.group_id &&
    used.analysis_revision === current.analysis_revision &&
    used.source_set_hash === current.source_set_hash &&
    used.published_generation === current.published_generation &&
    analysisReadiness(current, currentPublishedGeneration).ready
  );
}

export type EntityState = 'active' | 'cancelled' | 'completed';

export interface ResolvedChange {
  readonly relation: 'new' | 'correction' | 'cancel' | 'complete' | 'uncertain';
  readonly target_request_entity_id: string | null;
  readonly resolution: 'resolved' | 'ambiguous' | 'unresolved';
}

// 解析結果の到着順や配列順によらず、確定した取消・完了を同じ依頼の状態へ反映する。
export function resolveEntityState(
  entityId: string,
  current: EntityState,
  changes: readonly ResolvedChange[],
): EntityState {
  const relevant = changes.filter(
    (change) =>
      change.resolution === 'resolved' &&
      change.target_request_entity_id === entityId,
  );
  if (relevant.some((change) => change.relation === 'cancel'))
    return 'cancelled';
  if (relevant.some((change) => change.relation === 'complete'))
    return 'completed';
  return current;
}

export interface EntityRecord {
  readonly request_entity_id: string;
  readonly state: EntityState;
  readonly recreation_suppressed: boolean;
  readonly created_operations: readonly {
    readonly operation_kind: string;
    readonly account_id: string;
    readonly calendar_id: string | null;
  }[];
}

// 自動作成は同じ依頼・操作種別・対象につき一度だけ。取消済み・抑止中は作らない（11 §5A）。
export function autoCreationReasons(
  entity: EntityRecord,
  changes: readonly ResolvedChange[],
  operation: {
    readonly kind: string;
    readonly accountId: string;
    readonly calendarId: string | null;
  },
): string[] {
  const reasons: string[] = [];
  const state = resolveEntityState(
    entity.request_entity_id,
    entity.state,
    changes,
  );
  if (state !== 'active') reasons.push(`entity_${state}`);
  if (entity.recreation_suppressed) reasons.push('recreation_suppressed');
  if (
    entity.created_operations.some(
      (created) =>
        created.operation_kind === operation.kind &&
        created.account_id === operation.accountId &&
        created.calendar_id === operation.calendarId,
    )
  )
    reasons.push('already_created');
  return reasons;
}
