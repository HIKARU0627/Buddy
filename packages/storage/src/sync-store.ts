// 同期の走査の保存（設計 11 §1A、B08-05、ADR 0007・0088）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、
// 接続の取得対象（connection-targets-store.ts）と同じく、transaction の前に接続の耐久設定を読み戻す。
// - 排他・公開の可否は domain の requestScan / scanCurrentReasons / publishScan / abandonScan が正本。
//   ここは保存済みの取得集合と走査を domain の型へ変換して適用し、結果をそのまま保存するだけで、規則を足さない。
// - ワイヤ・保存の境界では時刻は ISO 文字列、版・世代は 10 進文字列。DB 内は INTEGER ミリ秒・整数。
// - 公開の差分は staging と公開済み（source_items）の版の比較で数える。差分のある upsert だけを書き、
//   版が変わる行は本文（body_blob_id）を NULL にして再取得させる。全量照合だけが不在の行を消す。
// - 結果の理由にはコードだけを入れ、SQL・パス・値を入れない。

import Database from 'better-sqlite3';
import {
  RETENTION_RULES,
  abandonScan,
  publishScan,
  requestScan,
  restartExecutor,
  scanCurrentReasons,
} from '@buddy/domain';
import type { ScanBatch, ScanKind, ScopeState } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';

const ID = /^[\x21-\x7e]{1,128}$/u;
const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;
const BATCH_TTL_MS = RETENTION_RULES['sync_batch']?.ms ?? 86_400_000;

// 契約の形（ワイヤ・保存の境界）。
export interface SyncScopeRecord {
  readonly scope_id: string;
  readonly connection_id: string;
  readonly scope_revision: string;
  readonly active_scan_id: string | null;
  readonly active_generation: string;
  readonly committed_watermark: string | null;
  readonly provider_cursor: string | null;
  readonly executor_generation: string;
  readonly last_incremental_completed_at: string | null;
  readonly last_full_reconciled_at: string | null;
  readonly pending_incremental: boolean;
  readonly pending_full: boolean;
  readonly analysis_plan_complete_generation: string | null;
}

export type SyncBatchStatus =
  'fetching' | 'staged' | 'validated' | 'published' | 'abandoned';

export interface SyncBatchRecord {
  readonly scan_id: string;
  readonly scope_id: string;
  readonly scope_revision: string;
  readonly kind: ScanKind;
  readonly status: SyncBatchStatus;
  readonly scan_started_at: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly query_fingerprint: string;
  readonly base_generation: string;
  readonly base_watermark: string | null;
  readonly base_provider_cursor: string | null;
  readonly executor_generation: string;
  readonly page_cursor: string | null;
  readonly diff_count: number | null;
}

export interface SyncScopeSnapshot {
  readonly scope: SyncScopeRecord;
  readonly active_batch: SyncBatchRecord | null;
  readonly last_attempt_at: string | null;
}

export interface SyncStagedItem {
  readonly remote_id: string;
  readonly source_revision: string;
  readonly change: 'upsert' | 'delete' | 'out_of_scope';
}

export interface SyncPublishedItem {
  readonly remote_id: string;
  readonly source_revision: string;
}

export interface SyncBeginValue {
  readonly outcome: 'started' | 'queued' | 'held';
  readonly scope: SyncScopeRecord;
  readonly batch: SyncBatchRecord | null;
}

export interface SyncBatchValue {
  readonly scope: SyncScopeRecord;
  readonly batch: SyncBatchRecord;
}

export interface SyncPublishValue {
  readonly scope: SyncScopeRecord;
  readonly batch: SyncBatchRecord;
  readonly diff_count: number;
}

export type SyncOp =
  | { readonly kind: 'sync.get_scope'; readonly scope_id: string }
  | { readonly kind: 'sync.list_scopes'; readonly connection_id: string }
  | {
      readonly kind: 'sync.list_published';
      readonly scope_id: string;
      readonly provider: 'google' | 'microsoft';
      readonly account_id: string;
    }
  | {
      readonly kind: 'sync.begin';
      readonly scope_id: string;
      readonly scan_id: string;
      readonly scan_kind: ScanKind;
      readonly now: string;
      readonly window_start: string;
      readonly window_end: string;
      readonly query_fingerprint: string;
    }
  | {
      readonly kind: 'sync.stage_page';
      readonly scan_id: string;
      readonly page_no: number;
      readonly items: readonly SyncStagedItem[];
      readonly next_page_cursor: string | null;
    }
  | { readonly kind: 'sync.validate'; readonly scan_id: string }
  | {
      readonly kind: 'sync.publish';
      readonly scan_id: string;
      readonly provider: 'google' | 'microsoft';
      readonly account_id: string;
      readonly provider_cursor: string | null;
      readonly completed_at: string;
    }
  | { readonly kind: 'sync.abandon'; readonly scan_id: string }
  | { readonly kind: 'sync.recover'; readonly scope_id: string };

export type SyncOpKind = SyncOp['kind'];

export type SyncOpValue =
  | SyncScopeSnapshot
  | readonly SyncScopeSnapshot[]
  | readonly SyncPublishedItem[]
  | SyncBeginValue
  | SyncBatchValue
  | SyncPublishValue
  | null;

export type SyncOpResult =
  | { readonly ok: true; readonly value: SyncOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か（公開の失敗で abandoned にした保存だけは確定している）。
      // unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface SyncStoreResult {
  readonly result: SyncOpResult;
  // 以後の書込みを止めるべき失敗（成否不明・想定外の失敗・耐久設定の不一致）。
  readonly halt: boolean;
}

export const SYNC_WRITE_OPS: ReadonlySet<SyncOpKind> = new Set([
  'sync.begin',
  'sync.stage_page',
  'sync.validate',
  'sync.publish',
  'sync.abandon',
  'sync.recover',
]);

const OP_KINDS: ReadonlySet<string> = new Set<SyncOpKind>([
  'sync.get_scope',
  'sync.list_scopes',
  'sync.list_published',
  'sync.begin',
  'sync.stage_page',
  'sync.validate',
  'sync.publish',
  'sync.abandon',
  'sync.recover',
]);

class SyncRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'SyncRejection';
    this.reasons = reasons;
  }
}

// --- 形の検査 ---

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return false;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  // 暦にない日時（2 月 30 日）は Date.parse が繰り上げる。繰り上げた値を行に入れない。
  return new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19);
}

function isCursor(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length <= 8192);
}

export function syncOpShapeReasons(op: SyncOp): string[] {
  if (op === null || typeof op !== 'object' || !OP_KINDS.has(op.kind))
    return ['kind_invalid'];
  const reasons: string[] = [];
  const id = (value: unknown, reason: string) => {
    if (typeof value !== 'string' || !ID.test(value)) reasons.push(reason);
  };
  switch (op.kind) {
    case 'sync.get_scope':
    case 'sync.recover':
      id(op.scope_id, 'scope_id_invalid');
      break;
    case 'sync.list_scopes':
      id(op.connection_id, 'connection_id_invalid');
      break;
    case 'sync.list_published':
      id(op.scope_id, 'scope_id_invalid');
      if (op.provider !== 'google' && op.provider !== 'microsoft')
        reasons.push('provider_invalid');
      id(op.account_id, 'account_id_invalid');
      break;
    case 'sync.begin':
      id(op.scope_id, 'scope_id_invalid');
      id(op.scan_id, 'scan_id_invalid');
      if (op.scan_kind !== 'incremental' && op.scan_kind !== 'full')
        reasons.push('scan_kind_invalid');
      if (!isIsoTime(op.now)) reasons.push('now_invalid');
      if (!isIsoTime(op.window_start)) reasons.push('window_start_invalid');
      if (!isIsoTime(op.window_end)) reasons.push('window_end_invalid');
      if (
        isIsoTime(op.window_start) &&
        isIsoTime(op.window_end) &&
        Date.parse(op.window_end) <= Date.parse(op.window_start)
      )
        reasons.push('window_invalid');
      if (
        typeof op.query_fingerprint !== 'string' ||
        op.query_fingerprint.length < 1 ||
        op.query_fingerprint.length > 128
      )
        reasons.push('query_fingerprint_invalid');
      break;
    case 'sync.stage_page':
      id(op.scan_id, 'scan_id_invalid');
      if (!Number.isSafeInteger(op.page_no) || op.page_no < 0)
        reasons.push('page_no_invalid');
      if (!Array.isArray(op.items) || op.items.length > 1000)
        reasons.push('items_invalid');
      else
        for (const item of op.items) {
          if (
            item === null ||
            typeof item !== 'object' ||
            typeof item.remote_id !== 'string' ||
            item.remote_id.length < 1 ||
            item.remote_id.length > 512
          )
            reasons.push('remote_id_invalid');
          else if (
            typeof item.source_revision !== 'string' ||
            item.source_revision.length < 1 ||
            item.source_revision.length > 512
          )
            reasons.push('source_revision_invalid');
          else if (
            item.change !== 'upsert' &&
            item.change !== 'delete' &&
            item.change !== 'out_of_scope'
          )
            reasons.push('change_invalid');
        }
      if (!isCursor(op.next_page_cursor))
        reasons.push('next_page_cursor_invalid');
      break;
    case 'sync.validate':
    case 'sync.abandon':
      id(op.scan_id, 'scan_id_invalid');
      break;
    case 'sync.publish':
      id(op.scan_id, 'scan_id_invalid');
      if (op.provider !== 'google' && op.provider !== 'microsoft')
        reasons.push('provider_invalid');
      id(op.account_id, 'account_id_invalid');
      if (!isCursor(op.provider_cursor))
        reasons.push('provider_cursor_invalid');
      if (!isIsoTime(op.completed_at)) reasons.push('completed_at_invalid');
      break;
  }
  return reasons;
}

// --- 値の変換 ---

const toIso = (millis: number | null): string | null =>
  millis === null ? null : new Date(millis).toISOString();
const toMillis = (iso: string | null): number | null =>
  iso === null ? null : Date.parse(iso);

interface ScopeRow {
  scope_id: string;
  connection_id: string;
  scope_revision: number;
  active_scan_id: string | null;
  active_generation: number;
  committed_watermark: number | null;
  provider_cursor: string | null;
  executor_generation: number;
  last_incremental_completed_at: number | null;
  last_full_reconciled_at: number | null;
  pending_incremental: number;
  pending_full: number;
  analysis_plan_complete_generation: number | null;
}

interface BatchRow {
  scan_id: string;
  scope_id: string;
  scope_revision: number;
  kind: ScanKind;
  base_generation: number;
  base_watermark: number | null;
  base_provider_cursor: string | null;
  scan_started_at: number;
  window_start: number;
  window_end: number;
  query_fingerprint: string;
  executor_generation: number;
  status: SyncBatchStatus;
  page_cursor: string | null;
  diff_count: number | null;
}

const SCOPE_COLUMNS =
  'scope_id, connection_id, scope_revision, active_scan_id, active_generation, committed_watermark, provider_cursor, executor_generation, last_incremental_completed_at, last_full_reconciled_at, pending_incremental, pending_full, analysis_plan_complete_generation';
const BATCH_COLUMNS =
  'scan_id, scope_id, scope_revision, kind, base_generation, base_watermark, base_provider_cursor, scan_started_at, window_start, window_end, query_fingerprint, executor_generation, status, page_cursor, diff_count';

function toScopeRecord(row: ScopeRow): SyncScopeRecord {
  return {
    scope_id: row.scope_id,
    connection_id: row.connection_id,
    scope_revision: String(row.scope_revision),
    active_scan_id: row.active_scan_id,
    active_generation: String(row.active_generation),
    committed_watermark: toIso(row.committed_watermark),
    provider_cursor: row.provider_cursor,
    executor_generation: String(row.executor_generation),
    last_incremental_completed_at: toIso(row.last_incremental_completed_at),
    last_full_reconciled_at: toIso(row.last_full_reconciled_at),
    pending_incremental: row.pending_incremental === 1,
    pending_full: row.pending_full === 1,
    analysis_plan_complete_generation:
      row.analysis_plan_complete_generation === null
        ? null
        : String(row.analysis_plan_complete_generation),
  };
}

function toBatchRecord(row: BatchRow): SyncBatchRecord {
  return {
    scan_id: row.scan_id,
    scope_id: row.scope_id,
    scope_revision: String(row.scope_revision),
    kind: row.kind,
    status: row.status,
    scan_started_at: new Date(row.scan_started_at).toISOString(),
    window_start: new Date(row.window_start).toISOString(),
    window_end: new Date(row.window_end).toISOString(),
    query_fingerprint: row.query_fingerprint,
    base_generation: String(row.base_generation),
    base_watermark: toIso(row.base_watermark),
    base_provider_cursor: row.base_provider_cursor,
    executor_generation: String(row.executor_generation),
    page_cursor: row.page_cursor,
    diff_count: row.diff_count,
  };
}

function toScopeState(record: SyncScopeRecord): ScopeState {
  return {
    scopeId: record.scope_id,
    scopeRevision: record.scope_revision,
    activeScanId: record.active_scan_id,
    activeGeneration: record.active_generation,
    committedWatermark: record.committed_watermark,
    providerCursor: record.provider_cursor,
    executorGeneration: record.executor_generation,
    lastIncrementalCompletedAt: record.last_incremental_completed_at,
    lastFullReconciledAt: record.last_full_reconciled_at,
    pendingIncremental: record.pending_incremental,
    pendingFull: record.pending_full,
    analysisPlanCompleteGeneration: record.analysis_plan_complete_generation,
  };
}

function toScanBatch(record: SyncBatchRecord): ScanBatch {
  return {
    scanId: record.scan_id,
    scopeId: record.scope_id,
    scopeRevision: record.scope_revision,
    kind: record.kind,
    status: record.status,
    scanStartedAt: record.scan_started_at,
    baseGeneration: record.base_generation,
    baseWatermark: record.base_watermark,
    baseProviderCursor: record.base_provider_cursor,
    executorGeneration: record.executor_generation,
  };
}

function readScopeRow(
  db: SqliteDatabase,
  scopeId: string,
): ScopeRow | undefined {
  return db
    .prepare(`SELECT ${SCOPE_COLUMNS} FROM sync_scopes WHERE scope_id = ?`)
    .get(scopeId) as ScopeRow | undefined;
}

function readBatchRow(
  db: SqliteDatabase,
  scanId: string,
): BatchRow | undefined {
  return db
    .prepare(`SELECT ${BATCH_COLUMNS} FROM sync_batches WHERE scan_id = ?`)
    .get(scanId) as BatchRow | undefined;
}

function requireScope(db: SqliteDatabase, scopeId: string): SyncScopeRecord {
  const row = readScopeRow(db, scopeId);
  if (row === undefined) throw new SyncRejection(['scope_not_found']);
  return toScopeRecord(row);
}

function requireBatch(db: SqliteDatabase, scanId: string): SyncBatchRecord {
  const row = readBatchRow(db, scanId);
  if (row === undefined) throw new SyncRejection(['scan_not_found']);
  return toBatchRecord(row);
}

function snapshot(db: SqliteDatabase, scopeId: string): SyncScopeSnapshot {
  const scope = requireScope(db, scopeId);
  const active =
    scope.active_scan_id === null
      ? null
      : (readBatchRow(db, scope.active_scan_id) ?? null);
  const last = db
    .prepare(
      'SELECT max(scan_started_at) AS value FROM sync_batches WHERE scope_id = ?',
    )
    .get(scopeId) as { value: number | null };
  return {
    scope,
    active_batch: active === null ? null : toBatchRecord(active),
    last_attempt_at: toIso(last.value),
  };
}

function readPublished(
  db: SqliteDatabase,
  op: Extract<SyncOp, { kind: 'sync.list_published' }>,
): readonly SyncPublishedItem[] {
  return db
    .prepare(
      `SELECT remote_id, source_revision FROM source_items
       WHERE provider = ? AND account_id = ? AND scope_id = ? ORDER BY remote_id`,
    )
    .all(op.provider, op.account_id, op.scope_id) as SyncPublishedItem[];
}

// 取得集合の pending と active_scan_id だけを domain の結果どおりに書く（begin の queued、abandon）。
function writeScopeFlags(db: SqliteDatabase, scope: ScopeState): void {
  db.prepare(
    `UPDATE sync_scopes SET active_scan_id = ?, pending_incremental = ?, pending_full = ?
     WHERE scope_id = ?`,
  ).run(
    scope.activeScanId,
    scope.pendingIncremental ? 1 : 0,
    scope.pendingFull ? 1 : 0,
    scope.scopeId,
  );
}

// --- 命令ごとの本体（同じ transaction の中で呼ぶ） ---

function applyBegin(
  db: SqliteDatabase,
  op: Extract<SyncOp, { kind: 'sync.begin' }>,
): SyncBeginValue {
  const current = requireScope(db, op.scope_id);
  const result = requestScan(toScopeState(current), {
    scanId: op.scan_id,
    kind: op.scan_kind,
    now: op.now,
  });
  if (result.action === 'held')
    return { outcome: 'held', scope: current, batch: null };
  if (result.action === 'queued') {
    writeScopeFlags(db, result.scope);
    return {
      outcome: 'queued',
      scope: requireScope(db, op.scope_id),
      batch: null,
    };
  }
  const batch = result.batch;
  const started = Date.parse(batch.scanStartedAt);
  db.prepare(
    `INSERT INTO sync_batches (scan_id, scope_id, scope_revision, kind, base_generation, base_watermark,
       base_provider_cursor, scan_started_at, window_start, window_end, query_fingerprint,
       executor_generation, status, page_cursor, diff_count, delete_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fetching', NULL, NULL, ?)`,
  ).run(
    batch.scanId,
    batch.scopeId,
    Number(batch.scopeRevision),
    batch.kind,
    Number(batch.baseGeneration),
    toMillis(batch.baseWatermark),
    batch.baseProviderCursor,
    started,
    Date.parse(op.window_start),
    Date.parse(op.window_end),
    op.query_fingerprint,
    Number(batch.executorGeneration),
    started + BATCH_TTL_MS,
  );
  writeScopeFlags(db, result.scope);
  return {
    outcome: 'started',
    scope: requireScope(db, op.scope_id),
    batch: requireBatch(db, op.scan_id),
  };
}

function currentBatch(
  db: SqliteDatabase,
  scanId: string,
): { scope: SyncScopeRecord; batch: SyncBatchRecord } {
  const batch = requireBatch(db, scanId);
  if (batch.status !== 'fetching' && batch.status !== 'staged')
    throw new SyncRejection(['batch_not_active']);
  const scope = requireScope(db, batch.scope_id);
  const reasons = scanCurrentReasons(toScopeState(scope), toScanBatch(batch));
  if (reasons.length > 0) throw new SyncRejection(reasons);
  return { scope, batch };
}

function applyStagePage(
  db: SqliteDatabase,
  op: Extract<SyncOp, { kind: 'sync.stage_page' }>,
): SyncBatchValue {
  const { batch } = currentBatch(db, op.scan_id);
  const insert = db.prepare(
    `INSERT INTO sync_staging (scan_id, remote_id, source_revision, page_no, executor_generation, change)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (scan_id, remote_id) DO UPDATE SET
       source_revision = excluded.source_revision,
       page_no = excluded.page_no,
       change = excluded.change`,
  );
  for (const item of op.items)
    insert.run(
      op.scan_id,
      item.remote_id,
      item.source_revision,
      op.page_no,
      Number(batch.executor_generation),
      item.change,
    );
  db.prepare(
    "UPDATE sync_batches SET page_cursor = ?, status = 'staged' WHERE scan_id = ?",
  ).run(op.next_page_cursor, op.scan_id);
  return {
    scope: requireScope(db, batch.scope_id),
    batch: requireBatch(db, op.scan_id),
  };
}

function applyValidate(
  db: SqliteDatabase,
  op: Extract<SyncOp, { kind: 'sync.validate' }>,
): SyncBatchValue {
  const { batch } = currentBatch(db, op.scan_id);
  db.prepare(
    "UPDATE sync_batches SET status = 'validated' WHERE scan_id = ?",
  ).run(op.scan_id);
  return {
    scope: requireScope(db, batch.scope_id),
    batch: requireBatch(db, op.scan_id),
  };
}

interface StagingRow {
  remote_id: string;
  source_revision: string;
  change: 'upsert' | 'delete' | 'out_of_scope';
}

interface PublishedRow {
  remote_id: string;
  source_revision: string;
}

// 公開の失敗のうち、domain が走査を abandoned にしたものは、その状態だけを保存してから拒否する
// （transaction を巻き戻すと abandoned 化まで消えてしまうため、例外ではなく値で返す）。
type PublishOutcome =
  | { readonly type: 'published'; readonly value: SyncPublishValue }
  | { readonly type: 'rejected'; readonly reasons: readonly string[] };

function applyPublish(
  db: SqliteDatabase,
  op: Extract<SyncOp, { kind: 'sync.publish' }>,
): PublishOutcome {
  const batch = requireBatch(db, op.scan_id);
  const scope = requireScope(db, batch.scope_id);
  const staging = db
    .prepare(
      'SELECT remote_id, source_revision, change FROM sync_staging WHERE scan_id = ?',
    )
    .all(op.scan_id) as StagingRow[];
  const published = db
    .prepare(
      `SELECT remote_id, source_revision FROM source_items
       WHERE provider = ? AND account_id = ? AND scope_id = ?`,
    )
    .all(op.provider, op.account_id, batch.scope_id) as PublishedRow[];
  const publishedById = new Map(
    published.map((row) => [row.remote_id, row.source_revision]),
  );
  const stagedIds = new Set(staging.map((row) => row.remote_id));
  const upserts = staging.filter(
    (row) =>
      row.change === 'upsert' &&
      publishedById.get(row.remote_id) !== row.source_revision,
  );
  const deletes = staging.filter(
    (row) => row.change !== 'upsert' && publishedById.has(row.remote_id),
  );
  const missing =
    batch.kind === 'full'
      ? published.filter((row) => !stagedIds.has(row.remote_id))
      : [];
  const diffCount = upserts.length + deletes.length + missing.length;
  const result = publishScan(toScopeState(scope), toScanBatch(batch), {
    diffCount,
    providerCursor: op.provider_cursor,
    completedAt: op.completed_at,
  });
  if (!result.ok) {
    if (result.batch.status === 'abandoned') {
      db.prepare(
        "UPDATE sync_batches SET status = 'abandoned' WHERE scan_id = ?",
      ).run(op.scan_id);
      db.prepare(
        'UPDATE sync_scopes SET active_scan_id = ? WHERE scope_id = ?',
      ).run(result.scope.activeScanId, batch.scope_id);
      db.prepare('DELETE FROM sync_staging WHERE scan_id = ?').run(op.scan_id);
    }
    return { type: 'rejected', reasons: result.reasons };
  }
  const generation = Number(result.scope.activeGeneration);
  const fetchedAt = Date.parse(op.completed_at);
  const upsert = db.prepare(
    `INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id,
       published_generation, fetched_at, body_blob_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (provider, account_id, remote_id) DO UPDATE SET
       source_revision = excluded.source_revision,
       scope_id = excluded.scope_id,
       published_generation = excluded.published_generation,
       fetched_at = excluded.fetched_at,
       body_blob_id = NULL`,
  );
  for (const row of upserts)
    upsert.run(
      op.provider,
      op.account_id,
      row.remote_id,
      row.source_revision,
      batch.scope_id,
      generation,
      fetchedAt,
    );
  const remove = db.prepare(
    `DELETE FROM source_items
     WHERE provider = ? AND account_id = ? AND remote_id = ? AND scope_id = ?`,
  );
  for (const row of [...deletes, ...missing])
    remove.run(op.provider, op.account_id, row.remote_id, batch.scope_id);
  db.prepare(
    `UPDATE sync_scopes SET active_scan_id = ?, active_generation = ?,
       committed_watermark = ?, provider_cursor = ?,
       last_incremental_completed_at = ?, last_full_reconciled_at = ?
     WHERE scope_id = ?`,
  ).run(
    result.scope.activeScanId,
    generation,
    toMillis(result.scope.committedWatermark),
    result.scope.providerCursor,
    toMillis(result.scope.lastIncrementalCompletedAt),
    toMillis(result.scope.lastFullReconciledAt),
    batch.scope_id,
  );
  db.prepare(
    "UPDATE sync_batches SET status = 'published', diff_count = ? WHERE scan_id = ?",
  ).run(diffCount, op.scan_id);
  db.prepare('DELETE FROM sync_staging WHERE scan_id = ?').run(op.scan_id);
  return {
    type: 'published',
    value: {
      scope: requireScope(db, batch.scope_id),
      batch: requireBatch(db, op.scan_id),
      diff_count: diffCount,
    },
  };
}

function applyAbandon(
  db: SqliteDatabase,
  op: Extract<SyncOp, { kind: 'sync.abandon' }>,
): SyncBatchValue {
  const batch = requireBatch(db, op.scan_id);
  if (batch.status === 'published' || batch.status === 'abandoned')
    throw new SyncRejection(['batch_not_active']);
  const scope = requireScope(db, batch.scope_id);
  const result = abandonScan(toScopeState(scope), toScanBatch(batch));
  db.prepare(
    "UPDATE sync_batches SET status = 'abandoned' WHERE scan_id = ?",
  ).run(op.scan_id);
  writeScopeFlags(db, result.scope);
  db.prepare('DELETE FROM sync_staging WHERE scan_id = ?').run(op.scan_id);
  return {
    scope: requireScope(db, batch.scope_id),
    batch: requireBatch(db, op.scan_id),
  };
}

// 再起動の回復（11 §1A、B08-06）。担当世代を 1 つ進め、有効な走査が残っていれば domain の回復の規則で
// abandoned にして pending を立て直す。世代・有効な走査・pending の書換えは同じ transaction で行う。
// 旧世代の遅着は、この後の stage_page・validate・publish が executor_changed で拒否する。
function applyRecover(
  db: SqliteDatabase,
  op: Extract<SyncOp, { kind: 'sync.recover' }>,
): SyncScopeSnapshot {
  const current = requireScope(db, op.scope_id);
  const activeRow =
    current.active_scan_id === null
      ? undefined
      : readBatchRow(db, current.active_scan_id);
  const result = restartExecutor(
    toScopeState(current),
    activeRow === undefined ? null : toScanBatch(toBatchRecord(activeRow)),
  );
  if (result.batch !== null) {
    db.prepare(
      "UPDATE sync_batches SET status = 'abandoned' WHERE scan_id = ?",
    ).run(result.batch.scanId);
    db.prepare('DELETE FROM sync_staging WHERE scan_id = ?').run(
      result.batch.scanId,
    );
  }
  db.prepare(
    `UPDATE sync_scopes SET executor_generation = ?, active_scan_id = ?,
       pending_incremental = ?, pending_full = ?
     WHERE scope_id = ?`,
  ).run(
    Number(result.scope.executorGeneration),
    result.scope.activeScanId,
    result.scope.pendingIncremental ? 1 : 0,
    result.scope.pendingFull ? 1 : 0,
    op.scope_id,
  );
  return snapshot(db, op.scope_id);
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): SyncOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

// 同期の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeSyncOp(
  db: SqliteDatabase,
  op: SyncOp,
  context: { readonly platform: StoragePlatform; readonly halted: boolean },
): SyncStoreResult {
  const shape = syncOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'sync.get_scope') {
    try {
      const row = readScopeRow(db, op.scope_id);
      return {
        result: {
          ok: true,
          value: row === undefined ? null : snapshot(db, op.scope_id),
        },
        halt: false,
      };
    } catch (error) {
      if (error instanceof SyncRejection)
        return { result: rejected(error.reasons), halt: false };
      throw error;
    }
  }
  if (op.kind === 'sync.list_scopes') {
    const rows = db
      .prepare(
        `SELECT ${SCOPE_COLUMNS} FROM sync_scopes WHERE connection_id = ? ORDER BY scope_id`,
      )
      .all(op.connection_id) as ScopeRow[];
    return {
      result: {
        ok: true,
        value: rows.map((row) => snapshot(db, row.scope_id)),
      },
      halt: false,
    };
  }
  if (op.kind === 'sync.list_published')
    return { result: { ok: true, value: readPublished(db, op) }, halt: false };
  // 書込みを止めた worker は書かない（ADR 0018）。照会は続ける。
  if (context.halted)
    return { result: rejected(['worker_halted']), halt: false };
  const durability = writeConnectionReasons(db, context.platform);
  if (durability.length > 0)
    return {
      result: rejected(['durability_mismatch', ...durability]),
      halt: true,
    };
  try {
    const run = runImmediate(db, (): SyncOpValue | PublishOutcome => {
      switch (op.kind) {
        case 'sync.begin':
          return applyBegin(db, op);
        case 'sync.stage_page':
          return applyStagePage(db, op);
        case 'sync.validate':
          return applyValidate(db, op);
        case 'sync.publish':
          return applyPublish(db, op);
        case 'sync.abandon':
          return applyAbandon(db, op);
        case 'sync.recover':
          return applyRecover(db, op);
        default:
          throw new SyncRejection(['kind_invalid']);
      }
    });
    const value = run.value;
    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      (value as PublishOutcome).type === 'rejected'
    )
      return {
        result: rejected((value as { reasons: readonly string[] }).reasons),
        halt: false,
      };
    const published =
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      (value as PublishOutcome).type === 'published'
        ? (value as { value: SyncPublishValue }).value
        : (value as SyncOpValue);
    return { result: { ok: true, value: published }, halt: false };
  } catch (error) {
    if (error instanceof SyncRejection)
      return { result: rejected(error.reasons), halt: false };
    if (error instanceof Error && error.name === 'CommitUncertain')
      return {
        result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
        halt: true,
      };
    const code = sqliteCode(error);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
      return { result: rejected(['database_busy']), halt: false };
    if (code?.startsWith('SQLITE_CONSTRAINT'))
      return { result: rejected(['constraint_violation']), halt: false };
    return {
      result: rejected([
        code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
      ]),
      halt: true,
    };
  }
}
