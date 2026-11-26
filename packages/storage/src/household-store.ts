// 家計の記録と分類の規則の保存（ADR 0158、マイグレーション 0016）。
//
// - household.record: 記録を 1 件作る。同じ出所の鍵（source_key）の行があれば書かずに duplicate を返す（同じメールの
//   再同期・同じ書き出しの再取込みで二つ目を作らない。本人が消した記録も作り直さない）。暗号文と行を同じ transaction で書く。
// - household.update: 内容を差し替える（分類の変更・本人の修正）。呼び出し側が見ていた内容版と照合し、新しい版の暗号文を
//   書いてから行を差し替え、古い暗号文を消す。
// - household.delete: 記録を消す。行は残し（出所の鍵を作り直しの止めに使う）、暗号文と月を消す。
// - household.list / household.get: 読み取り。暗号文は封筒のまま返す（復号は Core）。
// - household.rule_get / household.rule_set: 店名（HMAC）→ 分類の規則。本人の規則は取込みで上書きしない
//   （domain の householdRuleWritable。DB の trigger も最後に拒否する）。
// 時刻は呼び出し側の値を信じる（DB は時計を持たない）。結果には ID・件数・状態だけを入れ、SQL・パスを入れない。

import {
  HOUSEHOLD_CATEGORY_IDS,
  HOUSEHOLD_MONTH_SPAN_MAX,
  householdMonthSpan,
  householdRuleWritable,
  isHouseholdMonth,
} from '@buddy/domain';
import type { HouseholdRuleOrigin, HouseholdSourceKind } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { isSealedBlob } from './operation-commands.js';
import type { SealedBlobInput } from './operation-commands.js';
import { runImmediate } from './operation-store.js';

// 一度に返す記録の上限。超えたら truncated にして月の古い方から切る。
export const HOUSEHOLD_LIST_LIMIT = 5000;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;
const REVISION = /^[1-9][0-9]{0,15}$/u;
const SOURCE_KINDS: ReadonlySet<string> = new Set([
  'mail_notice',
  'csv_import',
  'manual',
]);
const RULE_ORIGINS: ReadonlySet<string> = new Set(['user', 'import']);
const CATEGORY_IDS: ReadonlySet<string> = new Set(HOUSEHOLD_CATEGORY_IDS);

export interface HouseholdEnvelope {
  readonly blob_id: string;
  readonly format_version: number;
  readonly key_id: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

export interface HouseholdEntryRecord {
  readonly entry_id: string;
  readonly source_kind: HouseholdSourceKind;
  readonly state: 'active' | 'deleted';
  // 削除した記録は null。
  readonly month: string | null;
  readonly content_revision: string;
  readonly created_at: string;
  readonly updated_at: string;
  // 削除した記録は null。
  readonly content: HouseholdEnvelope | null;
}

export type HouseholdRecordValue =
  | {
      readonly outcome: 'created';
      readonly entry_id: string;
      readonly content_revision: string;
    }
  | {
      readonly outcome: 'duplicate';
      readonly entry_id: string;
      readonly state: 'active' | 'deleted';
    };

export interface HouseholdRevisionValue {
  readonly entry_id: string;
  readonly content_revision: string;
}

export interface HouseholdListValue {
  readonly entries: readonly HouseholdEntryRecord[];
  readonly truncated: boolean;
}

export interface HouseholdRuleValue {
  readonly category: string;
  readonly origin: HouseholdRuleOrigin;
}

export type HouseholdOp =
  | {
      readonly kind: 'household.record';
      readonly entry_id: string;
      readonly source_kind: HouseholdSourceKind;
      readonly source_key: string;
      readonly month: string;
      // 内容版 1 の暗号文（所有者は entry_id、版 1）。
      readonly content: SealedBlobInput;
      readonly now: string;
    }
  | {
      readonly kind: 'household.update';
      readonly entry_id: string;
      readonly expected_revision: string;
      readonly month: string;
      // 新しい内容版（expected_revision + 1）の暗号文。
      readonly content: SealedBlobInput;
      readonly now: string;
    }
  | {
      readonly kind: 'household.delete';
      readonly entry_id: string;
      readonly expected_revision: string;
      readonly now: string;
    }
  | {
      readonly kind: 'household.list';
      readonly month_from: string;
      readonly month_to: string;
    }
  | { readonly kind: 'household.get'; readonly entry_id: string }
  | { readonly kind: 'household.rule_get'; readonly merchant_key: string }
  | {
      readonly kind: 'household.rule_set';
      readonly merchant_key: string;
      readonly category: string;
      readonly origin: HouseholdRuleOrigin;
      readonly now: string;
    };

export type HouseholdOpKind = HouseholdOp['kind'];

// 書込みを伴う命令（応答が失われたら成否不明として扱う。照会は拒否でよい）。
export const HOUSEHOLD_WRITE_OPS: ReadonlySet<HouseholdOpKind> = new Set([
  'household.record',
  'household.update',
  'household.delete',
  'household.rule_set',
]);

export type HouseholdOpValue =
  | HouseholdRecordValue
  | HouseholdRevisionValue
  | HouseholdListValue
  | HouseholdEntryRecord
  | HouseholdRuleValue
  | { readonly written: boolean }
  | null;

export type HouseholdOpResult =
  | { readonly ok: true; readonly value: HouseholdOpValue }
  | {
      readonly ok: false;
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface HouseholdStoreResult {
  readonly result: HouseholdOpResult;
  readonly halt: boolean;
}

const OP_KINDS: ReadonlySet<string> = new Set<HouseholdOpKind>([
  'household.record',
  'household.update',
  'household.delete',
  'household.list',
  'household.get',
  'household.rule_get',
  'household.rule_set',
]);

class HouseholdRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'HouseholdRejection';
    this.reasons = reasons;
  }
}

const isId = (value: unknown): value is string =>
  typeof value === 'string' && ID.test(value);
const isTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  UTC_TIME.test(value) &&
  Number.isFinite(Date.parse(value));
const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && REVISION.test(value);

/** 命令の形の検査。理由が空なら形は正しい。 */
export function householdOpShapeReasons(op: HouseholdOp): string[] {
  const value = op as unknown as Record<string, unknown>;
  if (
    op === null ||
    typeof op !== 'object' ||
    !OP_KINDS.has(value['kind'] as string)
  )
    return ['kind_invalid'];
  const reasons: string[] = [];
  const needs = (ok: boolean, reason: string): void => {
    if (!ok) reasons.push(reason);
  };
  switch (op.kind) {
    case 'household.record':
      needs(isId(op.entry_id), 'entry_id_invalid');
      needs(SOURCE_KINDS.has(op.source_kind), 'source_kind_invalid');
      needs(
        typeof op.source_key === 'string' && HEX64.test(op.source_key),
        'source_key_invalid',
      );
      needs(isHouseholdMonth(op.month), 'month_invalid');
      needs(isSealedBlob(op.content), 'content_invalid');
      needs(isTime(op.now), 'now_invalid');
      break;
    case 'household.update':
      needs(isId(op.entry_id), 'entry_id_invalid');
      needs(isRevision(op.expected_revision), 'expected_revision_invalid');
      needs(isHouseholdMonth(op.month), 'month_invalid');
      needs(isSealedBlob(op.content), 'content_invalid');
      needs(isTime(op.now), 'now_invalid');
      break;
    case 'household.delete':
      needs(isId(op.entry_id), 'entry_id_invalid');
      needs(isRevision(op.expected_revision), 'expected_revision_invalid');
      needs(isTime(op.now), 'now_invalid');
      break;
    case 'household.list': {
      const span = householdMonthSpan(op.month_from, op.month_to);
      needs(span !== null, 'month_range_invalid');
      needs(
        span === null || span <= HOUSEHOLD_MONTH_SPAN_MAX,
        'month_range_too_wide',
      );
      break;
    }
    case 'household.get':
      needs(isId(op.entry_id), 'entry_id_invalid');
      break;
    case 'household.rule_get':
      needs(
        typeof op.merchant_key === 'string' && HEX64.test(op.merchant_key),
        'merchant_key_invalid',
      );
      break;
    case 'household.rule_set':
      needs(
        typeof op.merchant_key === 'string' && HEX64.test(op.merchant_key),
        'merchant_key_invalid',
      );
      needs(CATEGORY_IDS.has(op.category), 'category_invalid');
      needs(RULE_ORIGINS.has(op.origin), 'origin_invalid');
      needs(isTime(op.now), 'now_invalid');
      break;
  }
  return reasons;
}

// --- 行 ---

interface EntryRow {
  entry_id: string;
  source_kind: HouseholdSourceKind;
  state: 'active' | 'deleted';
  month: string | null;
  content_revision: number;
  content_blob_id: string | null;
  created_at: number;
  updated_at: number;
}

interface BlobRow {
  blob_id: string;
  format_version: number;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

const ENTRY_COLUMNS =
  'entry_id, source_kind, state, month, content_revision, content_blob_id, created_at, updated_at';

const toIso = (millis: number): string => new Date(millis).toISOString();

function bytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function readEntryRow(
  db: SqliteDatabase,
  entryId: string,
): EntryRow | undefined {
  return db
    .prepare(
      `SELECT ${ENTRY_COLUMNS} FROM household_entries WHERE entry_id = ?`,
    )
    .get(entryId) as EntryRow | undefined;
}

function readEnvelope(
  db: SqliteDatabase,
  blobId: string | null,
): HouseholdEnvelope | null {
  if (blobId === null) return null;
  const row = db
    .prepare(
      'SELECT blob_id, format_version, key_id, nonce, ciphertext, tag FROM sealed_blobs WHERE blob_id = ?',
    )
    .get(blobId) as BlobRow | undefined;
  if (row === undefined) return null;
  return {
    blob_id: row.blob_id,
    format_version: row.format_version,
    key_id: row.key_id,
    nonce: new Uint8Array(row.nonce),
    ciphertext: new Uint8Array(row.ciphertext),
    tag: new Uint8Array(row.tag),
  };
}

function recordOf(db: SqliteDatabase, row: EntryRow): HouseholdEntryRecord {
  return {
    entry_id: row.entry_id,
    source_kind: row.source_kind,
    state: row.state,
    month: row.month,
    content_revision: String(row.content_revision),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    content: readEnvelope(db, row.content_blob_id),
  };
}

function insertContent(
  db: SqliteDatabase,
  entryId: string,
  revision: number,
  content: SealedBlobInput,
  now: number,
): void {
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'household_entry', 'household_entries', ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    content.blob_id,
    entryId,
    revision,
    content.format_version,
    content.key_id,
    bytes(content.nonce),
    bytes(content.ciphertext),
    bytes(content.tag),
    now,
  );
}

// 呼び出し側が見ていた内容版と照合する。無い・消した・版が違えば拒否する。
function requireActive(
  db: SqliteDatabase,
  entryId: string,
  expectedRevision: string,
): EntryRow {
  const row = readEntryRow(db, entryId);
  if (row === undefined) throw new HouseholdRejection(['entry_missing']);
  if (row.state !== 'active') throw new HouseholdRejection(['entry_deleted']);
  if (String(row.content_revision) !== expectedRevision)
    throw new HouseholdRejection(['revision_mismatch']);
  return row;
}

function applyRecord(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.record' }>,
): HouseholdRecordValue {
  const existing = db
    .prepare(
      'SELECT entry_id, state FROM household_entries WHERE source_key = ?',
    )
    .get(op.source_key) as
    { entry_id: string; state: 'active' | 'deleted' } | undefined;
  if (existing !== undefined)
    return {
      outcome: 'duplicate',
      entry_id: existing.entry_id,
      state: existing.state,
    };
  if (readEntryRow(db, op.entry_id) !== undefined)
    throw new HouseholdRejection(['entry_id_reused']);
  const now = Date.parse(op.now);
  insertContent(db, op.entry_id, 1, op.content, now);
  db.prepare(
    "INSERT INTO household_entries (entry_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?, NULL)",
  ).run(
    op.entry_id,
    op.source_kind,
    op.source_key,
    op.month,
    op.content.blob_id,
    now,
    now,
  );
  return { outcome: 'created', entry_id: op.entry_id, content_revision: '1' };
}

function applyUpdate(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.update' }>,
): HouseholdRevisionValue {
  const row = requireActive(db, op.entry_id, op.expected_revision);
  const now = Math.max(Date.parse(op.now), row.updated_at);
  const next = row.content_revision + 1;
  insertContent(db, op.entry_id, next, op.content, now);
  db.prepare(
    'UPDATE household_entries SET month = ?, content_revision = ?, content_blob_id = ?, updated_at = ? WHERE entry_id = ?',
  ).run(op.month, next, op.content.blob_id, now, op.entry_id);
  db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(
    row.content_blob_id,
  );
  return { entry_id: op.entry_id, content_revision: String(next) };
}

function applyDelete(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.delete' }>,
): HouseholdRevisionValue {
  const row = requireActive(db, op.entry_id, op.expected_revision);
  const now = Math.max(Date.parse(op.now), row.updated_at);
  const next = row.content_revision + 1;
  db.prepare(
    "UPDATE household_entries SET state = 'deleted', month = NULL, content_revision = ?, content_blob_id = NULL, updated_at = ?, deleted_at = ? WHERE entry_id = ?",
  ).run(next, now, now, op.entry_id);
  db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(
    row.content_blob_id,
  );
  return { entry_id: op.entry_id, content_revision: String(next) };
}

function applyRuleSet(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.rule_set' }>,
): { readonly written: boolean } {
  const existing = db
    .prepare(
      'SELECT origin FROM household_category_rules WHERE merchant_key = ?',
    )
    .get(op.merchant_key) as { origin: HouseholdRuleOrigin } | undefined;
  if (!householdRuleWritable(existing?.origin ?? null, op.origin))
    return { written: false };
  const now = Date.parse(op.now);
  if (existing === undefined)
    db.prepare(
      'INSERT INTO household_category_rules (merchant_key, category, origin, updated_at) VALUES (?, ?, ?, ?)',
    ).run(op.merchant_key, op.category, op.origin, now);
  else
    db.prepare(
      'UPDATE household_category_rules SET category = ?, origin = ?, updated_at = ? WHERE merchant_key = ?',
    ).run(op.category, op.origin, now, op.merchant_key);
  return { written: true };
}

function listEntries(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.list' }>,
): HouseholdListValue {
  // 新しい月・新しい作成の順に読み、上限を超えた分（古い方）を切る。
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLUMNS} FROM household_entries
        WHERE state = 'active' AND month BETWEEN ? AND ?
        ORDER BY month DESC, created_at DESC, entry_id ASC LIMIT ?`,
    )
    .all(op.month_from, op.month_to, HOUSEHOLD_LIST_LIMIT + 1) as EntryRow[];
  const truncated = rows.length > HOUSEHOLD_LIST_LIMIT;
  return {
    entries: rows
      .slice(0, HOUSEHOLD_LIST_LIMIT)
      .map((row) => recordOf(db, row)),
    truncated,
  };
}

function sqliteCode(error: unknown): string | null {
  return (error as { code?: string } | null)?.code ?? null;
}

const rejected = (reasons: readonly string[]): HouseholdOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

export function executeHouseholdOp(
  db: SqliteDatabase,
  op: HouseholdOp,
  context: { readonly platform: StoragePlatform; readonly halted: boolean },
): HouseholdStoreResult {
  const shape = householdOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'household.list')
    return { result: { ok: true, value: listEntries(db, op) }, halt: false };
  if (op.kind === 'household.get') {
    const row = readEntryRow(db, op.entry_id);
    return {
      result: {
        ok: true,
        value: row === undefined ? null : recordOf(db, row),
      },
      halt: false,
    };
  }
  if (op.kind === 'household.rule_get') {
    const row = db
      .prepare(
        'SELECT category, origin FROM household_category_rules WHERE merchant_key = ?',
      )
      .get(op.merchant_key) as HouseholdRuleValue | undefined;
    return { result: { ok: true, value: row ?? null }, halt: false };
  }
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
    const run = runImmediate(db, (): HouseholdOpValue => {
      switch (op.kind) {
        case 'household.record':
          return applyRecord(db, op);
        case 'household.update':
          return applyUpdate(db, op);
        case 'household.delete':
          return applyDelete(db, op);
        case 'household.rule_set':
          return applyRuleSet(db, op);
        default:
          throw new HouseholdRejection(['kind_invalid']);
      }
    });
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof HouseholdRejection)
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
