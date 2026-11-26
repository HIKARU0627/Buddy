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
// - household.mail_pending / household.mail_checked: 利用通知メールの取り込みで、同期で保存したメールのうちまだ確かめて
//   いないものを返す・確かめ済みにする（ADR 0160、マイグレーション 0017）。確かめ済みの行は同期のメールの行に結び付け、
//   メールの行が消えれば一緒に消える。
// - household.bill_record / household.bill_list: カード会社の請求のお知らせから読んだ請求予定（ADR 0176、マイグレーション 0021）。
//   家計の記録とは別の表に置き、月の集計・予算・定期の支出に入れない。同じ出所の鍵の行があれば書かずに duplicate を返す。
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
// 1 か月の請求予定を一度に返す上限。超えたら truncated にして新しく作った方を返す。
export const HOUSEHOLD_BILL_LIST_LIMIT = 100;

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

// 請求予定（ADR 0176）。暗号文は封筒のまま返す（復号は Core）。
export interface HouseholdBillRecord {
  readonly bill_id: string;
  // 引き落とし日の月。
  readonly month: string;
  readonly created_at: string;
  readonly content: HouseholdEnvelope | null;
}

export type HouseholdBillRecordValue =
  | { readonly outcome: 'created'; readonly bill_id: string }
  | { readonly outcome: 'duplicate'; readonly bill_id: string };

export interface HouseholdBillListValue {
  // 作った順（古い方から）。
  readonly bills: readonly HouseholdBillRecord[];
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
    }
  // 利用通知メールの取り込み（ADR 0160）。同期で保存したメールのうち、まだ確かめていないものを返す。
  // その口座で初めて呼ぶと、いまある全部を確かめ済みにして空を返す（過去のメールを一度に取りに行かない）。
  | {
      readonly kind: 'household.mail_pending';
      readonly provider: HouseholdMailProvider;
      readonly account_id: string;
      readonly scope_id: string;
      readonly limit: number;
      readonly now: string;
    }
  // メール 1 通を確かめ済みにする（通知でなかった・記録した・記録しない通知だった、のどれでも）。
  | {
      readonly kind: 'household.mail_checked';
      readonly provider: HouseholdMailProvider;
      readonly account_id: string;
      readonly remote_id: string;
      readonly now: string;
    }
  // 本人の家計簿の設定（ADR 0163）。行がなければ取り込みは入、版は 0。
  | { readonly kind: 'household.settings_get' }
  // 分類ごとの予算（ADR 0166）。行がなければ予算なし・版 0。金額は暗号文のまま受け渡す。
  | { readonly kind: 'household.budget_get' }
  | {
      readonly kind: 'household.budget_set';
      readonly expected_revision: string;
      // 新しい版（expected_revision + 1）の暗号文。
      readonly content: SealedBlobInput;
      readonly now: string;
    }
  // 設定を変える。版を照合し、切から入へ戻すときは取り込みの基準を消す（止めていた間のメールを読まない。U334）。
  | {
      readonly kind: 'household.settings_set';
      readonly expected_revision: string;
      readonly mail_intake: HouseholdMailIntakeSetting;
      readonly now: string;
    }
  // 請求予定を 1 件作る（ADR 0176）。同じ出所の鍵があれば書かずに duplicate。
  | {
      readonly kind: 'household.bill_record';
      readonly bill_id: string;
      readonly source_key: string;
      // 引き落とし日の月。
      readonly month: string;
      // 暗号文（所有者は bill_id、版 1）。
      readonly content: SealedBlobInput;
      readonly now: string;
    }
  // 1 か月（引き落とし日の月）の請求予定。
  | { readonly kind: 'household.bill_list'; readonly month: string };

export type HouseholdMailIntakeSetting = 'on' | 'off';

export interface HouseholdBudgetValue {
  readonly budget_revision: string;
  // 予算がまだなければ null。
  readonly content: HouseholdEnvelope | null;
}

export interface HouseholdSettingsValue {
  readonly mail_intake: HouseholdMailIntakeSetting;
  readonly settings_revision: string;
}

export type HouseholdMailProvider = 'google' | 'microsoft';

export interface HouseholdMailPendingValue {
  // 本人が取り込みを止めている（何も返さず、基準も作らない。ADR 0163）。
  readonly paused: boolean;
  // この呼び出しで基準を作った（いまある全部を確かめ済みにした）か。
  readonly baseline: boolean;
  // 新しく保存した順。
  readonly remote_ids: readonly string[];
}

// 一度に返す確かめていないメールの上限。
export const HOUSEHOLD_MAIL_PENDING_LIMIT = 200;

export type HouseholdOpKind = HouseholdOp['kind'];

// 書込みを伴う命令（応答が失われたら成否不明として扱う。照会は拒否でよい）。
export const HOUSEHOLD_WRITE_OPS: ReadonlySet<HouseholdOpKind> = new Set([
  'household.record',
  'household.update',
  'household.delete',
  'household.rule_set',
  'household.mail_pending',
  'household.mail_checked',
  'household.settings_set',
  'household.budget_set',
  'household.bill_record',
]);

export type HouseholdOpValue =
  | HouseholdRecordValue
  | HouseholdRevisionValue
  | HouseholdListValue
  | HouseholdEntryRecord
  | HouseholdRuleValue
  | HouseholdMailPendingValue
  | HouseholdSettingsValue
  | HouseholdBudgetValue
  | HouseholdBillRecordValue
  | HouseholdBillListValue
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
  'household.mail_pending',
  'household.mail_checked',
  'household.settings_get',
  'household.settings_set',
  'household.budget_get',
  'household.budget_set',
  'household.bill_record',
  'household.bill_list',
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
// 提供元の識別子（口座・メール・取得集合）。表示できる ASCII の 1〜512 文字。
const REMOTE_TEXT = /^[\x21-\x7e]{1,512}$/u;
const isRemoteText = (value: unknown): value is string =>
  typeof value === 'string' && REMOTE_TEXT.test(value);
const MAIL_PROVIDERS: ReadonlySet<string> = new Set(['google', 'microsoft']);
const MAIL_INTAKE_SETTINGS: ReadonlySet<string> = new Set(['on', 'off']);
// 設定の版（行がなければ 0）。
const SETTINGS_REVISION = /^(0|[1-9][0-9]{0,15})$/u;

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
    case 'household.mail_pending':
      needs(MAIL_PROVIDERS.has(op.provider), 'provider_invalid');
      needs(isRemoteText(op.account_id), 'account_id_invalid');
      needs(isRemoteText(op.scope_id), 'scope_id_invalid');
      needs(
        Number.isSafeInteger(op.limit) &&
          op.limit >= 1 &&
          op.limit <= HOUSEHOLD_MAIL_PENDING_LIMIT,
        'limit_invalid',
      );
      needs(isTime(op.now), 'now_invalid');
      break;
    case 'household.mail_checked':
      needs(MAIL_PROVIDERS.has(op.provider), 'provider_invalid');
      needs(isRemoteText(op.account_id), 'account_id_invalid');
      needs(isRemoteText(op.remote_id), 'remote_id_invalid');
      needs(isTime(op.now), 'now_invalid');
      break;
    case 'household.settings_get':
    case 'household.budget_get':
      break;
    case 'household.budget_set':
      needs(
        typeof op.expected_revision === 'string' &&
          SETTINGS_REVISION.test(op.expected_revision),
        'expected_revision_invalid',
      );
      needs(isSealedBlob(op.content), 'content_invalid');
      needs(isTime(op.now), 'now_invalid');
      break;
    case 'household.settings_set':
      needs(
        typeof op.expected_revision === 'string' &&
          SETTINGS_REVISION.test(op.expected_revision),
        'expected_revision_invalid',
      );
      needs(MAIL_INTAKE_SETTINGS.has(op.mail_intake), 'mail_intake_invalid');
      needs(isTime(op.now), 'now_invalid');
      break;
    case 'household.bill_record':
      needs(isId(op.bill_id), 'bill_id_invalid');
      needs(
        typeof op.source_key === 'string' && HEX64.test(op.source_key),
        'source_key_invalid',
      );
      needs(isHouseholdMonth(op.month), 'month_invalid');
      needs(isSealedBlob(op.content), 'content_invalid');
      needs(isTime(op.now), 'now_invalid');
      break;
    case 'household.bill_list':
      needs(isHouseholdMonth(op.month), 'month_invalid');
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

function readBudget(db: SqliteDatabase): HouseholdBudgetValue {
  const row = db
    .prepare(
      'SELECT budget_revision, content_blob_id FROM household_budgets WHERE budget_id = 1',
    )
    .get() as { budget_revision: number; content_blob_id: string } | undefined;
  return row === undefined
    ? { budget_revision: '0', content: null }
    : {
        budget_revision: String(row.budget_revision),
        content: readEnvelope(db, row.content_blob_id),
      };
}

// 予算を差し替える。版を照合し、新しい暗号文を入れてから行を進め、古い暗号文を消す。
function applyBudget(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.budget_set' }>,
): HouseholdBudgetValue {
  const row = db
    .prepare(
      'SELECT budget_revision, content_blob_id FROM household_budgets WHERE budget_id = 1',
    )
    .get() as { budget_revision: number; content_blob_id: string } | undefined;
  const current = row === undefined ? '0' : String(row.budget_revision);
  if (current !== op.expected_revision)
    throw new HouseholdRejection(['revision_mismatch']);
  const next = Number(current) + 1;
  const now = Date.parse(op.now);
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'household_budget', 'household_budgets', '1', ?, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    op.content.blob_id,
    next,
    op.content.format_version,
    op.content.key_id,
    bytes(op.content.nonce),
    bytes(op.content.ciphertext),
    bytes(op.content.tag),
    now,
  );
  if (row === undefined)
    db.prepare(
      'INSERT INTO household_budgets (budget_id, budget_revision, content_blob_id, updated_at) VALUES (1, ?, ?, ?)',
    ).run(next, op.content.blob_id, now);
  else {
    db.prepare(
      'UPDATE household_budgets SET budget_revision = ?, content_blob_id = ?, updated_at = ? WHERE budget_id = 1',
    ).run(next, op.content.blob_id, now);
    db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(
      row.content_blob_id,
    );
  }
  return readBudget(db);
}

function readSettings(db: SqliteDatabase): HouseholdSettingsValue {
  const row = db
    .prepare(
      'SELECT mail_intake, settings_revision FROM household_settings WHERE setting_id = 1',
    )
    .get() as
    | { mail_intake: HouseholdMailIntakeSetting; settings_revision: number }
    | undefined;
  return row === undefined
    ? { mail_intake: 'on', settings_revision: '0' }
    : {
        mail_intake: row.mail_intake,
        settings_revision: String(row.settings_revision),
      };
}

function applySettings(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.settings_set' }>,
): HouseholdSettingsValue {
  const current = readSettings(db);
  if (current.settings_revision !== op.expected_revision)
    throw new HouseholdRejection(['revision_mismatch']);
  const now = Date.parse(op.now);
  const next = Number(current.settings_revision) + 1;
  if (current.settings_revision === '0')
    db.prepare(
      'INSERT INTO household_settings (setting_id, mail_intake, settings_revision, updated_at) VALUES (1, ?, ?, ?)',
    ).run(op.mail_intake, next, now);
  else
    db.prepare(
      'UPDATE household_settings SET mail_intake = ?, settings_revision = ?, updated_at = ? WHERE setting_id = 1',
    ).run(op.mail_intake, next, now);
  // 切から入へ戻す: 止めていた間に届いたメールは読まない。基準を消し、次の取り込みでいまある全部を確かめ済みにする。
  if (current.mail_intake === 'off' && op.mail_intake === 'on')
    db.prepare('DELETE FROM household_mail_baselines').run();
  return { mail_intake: op.mail_intake, settings_revision: String(next) };
}

// 確かめていないメール。初回（基準がない取得集合）は、その取得集合の同期済みのメールを確かめ済みにして基準を作る（ADR 0170）。本人が止めていれば
// 何も返さず、基準も作らない（同じ transaction で設定を読む。ADR 0163）。
function mailPending(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.mail_pending' }>,
): HouseholdMailPendingValue {
  if (readSettings(db).mail_intake === 'off')
    return { paused: true, baseline: false, remote_ids: [] };
  const now = Date.parse(op.now);
  const baseline = db
    .prepare(
      'SELECT 1 FROM household_mail_baselines WHERE provider = ? AND account_id = ? AND scope_id = ?',
    )
    .get(op.provider, op.account_id, op.scope_id);
  if (baseline === undefined) {
    db.prepare(
      'INSERT INTO household_mail_baselines (provider, account_id, scope_id, established_at) VALUES (?, ?, ?, ?)',
    ).run(op.provider, op.account_id, op.scope_id, now);
    db.prepare(
      `INSERT OR IGNORE INTO household_mail_checks (provider, account_id, remote_id, checked_at)
       SELECT provider, account_id, remote_id, ? FROM source_items
       WHERE provider = ? AND account_id = ? AND scope_id = ?`,
    ).run(now, op.provider, op.account_id, op.scope_id);
    return { paused: false, baseline: true, remote_ids: [] };
  }
  const rows = db
    .prepare(
      `SELECT s.remote_id AS remote_id FROM source_items s
       WHERE s.provider = ? AND s.account_id = ? AND s.scope_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM household_mail_checks c
           WHERE c.provider = s.provider AND c.account_id = s.account_id AND c.remote_id = s.remote_id)
       ORDER BY s.fetched_at DESC, s.remote_id
       LIMIT ?`,
    )
    .all(op.provider, op.account_id, op.scope_id, op.limit) as {
    remote_id: string;
  }[];
  return {
    paused: false,
    baseline: false,
    remote_ids: rows.map((row) => row.remote_id),
  };
}

function mailChecked(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.mail_checked' }>,
): { readonly written: boolean } {
  const exists = db
    .prepare(
      'SELECT 1 FROM source_items WHERE provider = ? AND account_id = ? AND remote_id = ?',
    )
    .get(op.provider, op.account_id, op.remote_id);
  // 同期で消えたメールは確かめ済みにしない（行が残らないように）。
  if (exists === undefined) return { written: false };
  const result = db
    .prepare(
      'INSERT OR IGNORE INTO household_mail_checks (provider, account_id, remote_id, checked_at) VALUES (?, ?, ?, ?)',
    )
    .run(op.provider, op.account_id, op.remote_id, Date.parse(op.now));
  return { written: result.changes === 1 };
}

// 請求予定を作る。同じ出所の鍵の行があれば書かない。暗号文と行を同じ transaction で書く。
function applyBillRecord(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.bill_record' }>,
): HouseholdBillRecordValue {
  const existing = db
    .prepare('SELECT bill_id FROM household_bills WHERE source_key = ?')
    .get(op.source_key) as { bill_id: string } | undefined;
  if (existing !== undefined)
    return { outcome: 'duplicate', bill_id: existing.bill_id };
  if (
    db
      .prepare('SELECT 1 FROM household_bills WHERE bill_id = ?')
      .get(op.bill_id) !== undefined
  )
    throw new HouseholdRejection(['bill_id_reused']);
  const now = Date.parse(op.now);
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'household_bill', 'household_bills', ?, 1, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    op.content.blob_id,
    op.bill_id,
    op.content.format_version,
    op.content.key_id,
    bytes(op.content.nonce),
    bytes(op.content.ciphertext),
    bytes(op.content.tag),
    now,
  );
  db.prepare(
    "INSERT INTO household_bills (bill_id, source_kind, source_key, month, content_blob_id, created_at) VALUES (?, 'mail_bill', ?, ?, ?, ?)",
  ).run(op.bill_id, op.source_key, op.month, op.content.blob_id, now);
  return { outcome: 'created', bill_id: op.bill_id };
}

function listBills(
  db: SqliteDatabase,
  op: Extract<HouseholdOp, { kind: 'household.bill_list' }>,
): HouseholdBillListValue {
  // 新しく作った順に上限まで読み、作った順（古い方から）に並べ直して返す。
  const rows = db
    .prepare(
      `SELECT bill_id, month, content_blob_id, created_at FROM household_bills
        WHERE month = ? ORDER BY created_at DESC, bill_id DESC LIMIT ?`,
    )
    .all(op.month, HOUSEHOLD_BILL_LIST_LIMIT + 1) as {
    bill_id: string;
    month: string;
    content_blob_id: string;
    created_at: number;
  }[];
  return {
    bills: rows
      .slice(0, HOUSEHOLD_BILL_LIST_LIMIT)
      .reverse()
      .map((row) => ({
        bill_id: row.bill_id,
        month: row.month,
        created_at: toIso(row.created_at),
        content: readEnvelope(db, row.content_blob_id),
      })),
    truncated: rows.length > HOUSEHOLD_BILL_LIST_LIMIT,
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
  if (op.kind === 'household.settings_get')
    return { result: { ok: true, value: readSettings(db) }, halt: false };
  if (op.kind === 'household.budget_get')
    return { result: { ok: true, value: readBudget(db) }, halt: false };
  if (op.kind === 'household.bill_list')
    return { result: { ok: true, value: listBills(db, op) }, halt: false };
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
        case 'household.mail_pending':
          return mailPending(db, op);
        case 'household.mail_checked':
          return mailChecked(db, op);
        case 'household.settings_set':
          return applySettings(db, op);
        case 'household.budget_set':
          return applyBudget(db, op);
        case 'household.bill_record':
          return applyBillRecord(db, op);
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
