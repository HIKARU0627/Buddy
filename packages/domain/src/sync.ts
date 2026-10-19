// 同期の走査の排他・公開前の照合・時計の後退（設計 11 §1・§1A F04、ADR 0007）。
// 公開世代は Buddy 内部の版で、provider の全ページが同時点の snapshot だった保証ではない。

export interface ScopeState {
  readonly scopeId: string;
  readonly scopeRevision: string;
  readonly activeScanId: string | null;
  readonly activeGeneration: string;
  readonly committedWatermark: string | null;
  readonly providerCursor: string | null;
  readonly executorGeneration: string;
  readonly lastIncrementalCompletedAt: string | null;
  readonly lastFullReconciledAt: string | null;
  readonly pendingIncremental: boolean;
  readonly pendingFull: boolean;
  readonly analysisPlanCompleteGeneration: string | null;
}

export type ScanKind = 'incremental' | 'full';
export type BatchStatus =
  'fetching' | 'staged' | 'validated' | 'published' | 'abandoned';

export interface ScanBatch {
  readonly scanId: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
  readonly kind: ScanKind;
  readonly status: BatchStatus;
  readonly scanStartedAt: string;
  readonly baseGeneration: string;
  readonly baseWatermark: string | null;
  readonly baseProviderCursor: string | null;
  readonly executorGeneration: string;
}

const before = (a: string, b: string): boolean => Date.parse(a) < Date.parse(b);

// 走査中の要求はまとめて待たせ、全量照合の要求も失わない。
export function requestScan(
  scope: ScopeState,
  request: {
    readonly scanId: string;
    readonly kind: ScanKind;
    readonly now: string;
  },
):
  | {
      readonly action: 'started';
      readonly scope: ScopeState;
      readonly batch: ScanBatch;
    }
  | { readonly action: 'queued'; readonly scope: ScopeState }
  | { readonly action: 'held'; readonly reason: 'clock_regression' } {
  if (scope.activeScanId !== null)
    return {
      action: 'queued',
      scope: {
        ...scope,
        pendingFull: scope.pendingFull || request.kind === 'full',
        pendingIncremental:
          scope.pendingIncremental || request.kind === 'incremental',
      },
    };
  if (
    scope.committedWatermark !== null &&
    before(request.now, scope.committedWatermark)
  )
    return { action: 'held', reason: 'clock_regression' };
  return {
    action: 'started',
    scope: {
      ...scope,
      activeScanId: request.scanId,
      pendingFull: request.kind === 'full' ? false : scope.pendingFull,
      // 全量照合は増分の要求も満たす。
      pendingIncremental: false,
    },
    batch: {
      scanId: request.scanId,
      scopeId: scope.scopeId,
      scopeRevision: scope.scopeRevision,
      kind: request.kind,
      status: 'fetching',
      scanStartedAt: request.now,
      baseGeneration: scope.activeGeneration,
      baseWatermark: scope.committedWatermark,
      baseProviderCursor: scope.providerCursor,
      executorGeneration: scope.executorGeneration,
    },
  };
}

// ページの保存・検証・公開の前に、有効な走査・取得範囲の版・担当世代が一致するかを見る。
export function scanCurrentReasons(
  scope: ScopeState,
  batch: ScanBatch,
): string[] {
  const reasons: string[] = [];
  if (scope.activeScanId !== batch.scanId) reasons.push('stale_scan');
  if (scope.scopeRevision !== batch.scopeRevision)
    reasons.push('scope_changed');
  if (scope.executorGeneration !== batch.executorGeneration)
    reasons.push('executor_changed');
  return reasons;
}

export type ScanResult =
  | { readonly ok: true; readonly scope: ScopeState; readonly batch: ScanBatch }
  | {
      readonly ok: false;
      readonly reasons: string[];
      readonly scope: ScopeState;
      readonly batch: ScanBatch;
    };

const release = (scope: ScopeState, batch: ScanBatch): ScopeState =>
  scope.activeScanId === batch.scanId
    ? { ...scope, activeScanId: null }
    : scope;

// 公開は開始時の世代・watermark・cursor との compare-and-swap。差分ゼロでも照合し、世代は進めない。
export function publishScan(
  scope: ScopeState,
  batch: ScanBatch,
  result: {
    readonly diffCount: number;
    readonly providerCursor: string | null;
    readonly completedAt: string;
  },
): ScanResult {
  const reasons = scanCurrentReasons(scope, batch);
  if (batch.status !== 'validated') reasons.push('not_validated');
  if (scope.activeGeneration !== batch.baseGeneration)
    reasons.push('generation_changed');
  if (
    scope.committedWatermark !== batch.baseWatermark ||
    scope.providerCursor !== batch.baseProviderCursor
  )
    reasons.push('cursor_changed');
  if (
    scope.committedWatermark !== null &&
    before(batch.scanStartedAt, scope.committedWatermark)
  )
    reasons.push('clock_regression');
  if (reasons.length) {
    const abandoned = reasons.some((reason) => reason !== 'not_validated');
    return {
      ok: false,
      reasons,
      scope: abandoned ? release(scope, batch) : scope,
      batch: abandoned ? { ...batch, status: 'abandoned' } : batch,
    };
  }
  const changed = result.diffCount > 0;
  return {
    ok: true,
    scope: {
      ...scope,
      activeScanId: null,
      activeGeneration: changed
        ? (BigInt(scope.activeGeneration) + 1n).toString()
        : scope.activeGeneration,
      committedWatermark: batch.scanStartedAt,
      providerCursor: result.providerCursor,
      lastIncrementalCompletedAt:
        batch.kind === 'incremental'
          ? result.completedAt
          : scope.lastIncrementalCompletedAt,
      lastFullReconciledAt:
        batch.kind === 'full' ? result.completedAt : scope.lastFullReconciledAt,
    },
    batch: { ...batch, status: 'published' },
  };
}

// token 失効・範囲変更・TTL 超過は旧走査を abandoned にし、新しい走査で最初から取り直す。
export function abandonScan(
  scope: ScopeState,
  batch: ScanBatch,
): { readonly scope: ScopeState; readonly batch: ScanBatch } {
  const own = scope.activeScanId === batch.scanId;
  return {
    scope: own
      ? {
          ...release(scope, batch),
          pendingFull: scope.pendingFull || batch.kind === 'full',
          pendingIncremental:
            scope.pendingIncremental || batch.kind === 'incremental',
        }
      : scope,
    batch: { ...batch, status: 'abandoned' },
  };
}

// 差分のある公開の後、その世代の解析計画が完了するまで候補起点の実行を始めない（11 §5B）。
export function analysisPlanCurrent(scope: ScopeState): boolean {
  return scope.analysisPlanCompleteGeneration === scope.activeGeneration;
}
