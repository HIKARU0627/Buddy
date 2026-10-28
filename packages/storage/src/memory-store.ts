// 記憶と忘却の DB worker の命令（設計 03 忘却と再取り込み・保存期限、08 §6、11 §7、ADR 0008・0040・0044・0054、
// マイグレーション 0012）。
//
// - forget.*: 忘却の系譜の読み出し・忘却の適用（forget-store.ts）・台帳の書き出し（台帳の別ファイルを作る材料）。
// - memory.save: 記憶の保存。保存の直前に、transaction の中で台帳の全件と照合する（遅れて届いた結果の最後の保証。
//   domain の ledgerRelationReasons と同じ規則）。由来の HMAC は Core が鍵で求めて渡す。
// - memory.continue: 見直し待ちの記憶の明示継続（継続した時点から次の 90 日。ADR 0008 U14）。
// - memory.start_review: 見直し日を過ぎた記憶を見直し待ちへ（見直しから 30 日で削除）。
// - memory.delete_due: 見直し待ちのまま 30 日を過ぎた記憶の物理削除（期限切れ。台帳には書かない）。
// - directive.revoke: 本人の指示（「今後は」など）の取り消し。行と暗号文を消す。
// 書込みは 1 命令を 1 つの短い BEGIN IMMEDIATE の transaction で行う。時刻は呼び出し側の now を信じる（DB は時計を
// 持たない。期限の命令は B06-06d1 の sweepPlan の時計の判定を通してから呼ぶ）。結果には ID・件数だけを入れる。

import Database from 'better-sqlite3';
import {
  MEMORY_DELETE_AFTER_REVIEW_DAYS,
  MEMORY_REVIEW_DAYS,
  ledgerRelationReasons,
} from '@buddy/domain';
import type { ForgetGraph, ForgetPlan, MemorySource } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { isSealedBlob } from './operation-commands.js';
import type { SealedBlobInput } from './operation-commands.js';
import { runImmediate } from './operation-store.js';
import {
  ForgetRejection,
  applyForget,
  currentForgettingGeneration,
  exportForgetLedger,
  forgetTargetExists,
  isHex64,
  isUuid,
  readForgetGraph,
  readLedgerEntries,
  readLedgerId,
} from './forget-store.js';
import type {
  ForgetApplyValue,
  ForgetLedgerExport,
  SourceHmacValue,
} from './forget-store.js';

const DAY_MS = 86_400_000;
const MEMORY_KINDS = [
  'preference',
  'goal',
  'person',
  'routine',
  'lexicon',
  'progress',
] as const;
const SOURCE_KINDS = ['turn', 'source_item', 'memory'] as const;
// 元情報の ID の形の最低限（契約の OriginalSourceId）。
const ORIGINAL_SOURCE_ID = /^[A-Za-z0-9._:=+~-]{1,256}$/u;

export type MemoryOp =
  // 忘却の対象の系譜（domain の ForgetGraph）と、今の台帳の世代・対象があるか。
  | {
      readonly kind: 'forget.graph';
      readonly target: MemorySource;
    }
  // 忘却の適用（台帳・削除・送出禁止の印を 1 つの transaction で）。
  | {
      readonly kind: 'forget.apply';
      readonly target: MemorySource;
      readonly instruction_turn_id: string | null;
      readonly plan: ForgetPlan;
      readonly source_hmacs: readonly SourceHmacValue[];
      readonly entry_id: string;
      readonly previous_generation: string;
      readonly new_ledger_id: string;
      readonly now: number;
    }
  // 台帳の全件（連鎖の hash つき）。台帳の別ファイルを書く・遅着の検査に使う。
  | { readonly kind: 'forget.ledger_export' }
  | {
      readonly kind: 'memory.save';
      readonly memory_id: string;
      readonly origin: 'auto_extraction' | 'explicit_request';
      readonly memory_kind: (typeof MEMORY_KINDS)[number];
      readonly text: SealedBlobInput;
      readonly target_key: SealedBlobInput;
      readonly target_key_hash: string;
      // 内容の HMAC（memories.dedupe_key。台帳の blocked_content_keys と比べる）。
      readonly dedupe_key: string;
      readonly sources: readonly MemorySource[];
      // すべての由来の台帳用 HMAC（台帳の blocked_source_hmacs・元情報の forgotten と比べる。欠ければ照合できないので拒否）。
      readonly source_hmacs: readonly SourceHmacValue[];
      // 保存の判定を始めたときの台帳の世代。
      readonly forgetting_generation: string;
      readonly now: number;
    }
  | {
      readonly kind: 'memory.continue';
      readonly memory_id: string;
      readonly now: number;
    }
  | {
      readonly kind: 'memory.start_review';
      readonly memory_id: string;
      readonly now: number;
    }
  | {
      readonly kind: 'memory.delete_due';
      readonly memory_id: string;
      readonly now: number;
    }
  | { readonly kind: 'directive.revoke'; readonly directive_id: string };

export type MemoryOpKind = MemoryOp['kind'];

export interface ForgetGraphValue {
  readonly graph: ForgetGraph;
  readonly forgetting_generation: string;
  readonly target_exists: boolean;
  readonly ledger_id: string | null;
}

export interface MemoryScheduleValue {
  readonly memory_id: string;
  readonly status: 'active' | 'review_pending';
  readonly review_at: number;
  readonly delete_at: number | null;
}

export interface MemoryOpValues {
  'forget.graph': ForgetGraphValue;
  'forget.apply': ForgetApplyValue;
  'forget.ledger_export': ForgetLedgerExport;
  'memory.save': MemoryScheduleValue;
  'memory.continue': MemoryScheduleValue;
  'memory.start_review': MemoryScheduleValue;
  'memory.delete_due': {
    readonly memory_id: string;
    readonly deleted: boolean;
  };
  'directive.revoke': {
    readonly directive_id: string;
    readonly revoked: boolean;
  };
}

export type MemoryOpValue = MemoryOpValues[MemoryOpKind];

export type MemoryOpResult =
  | { readonly ok: true; readonly value: MemoryOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface MemoryStoreResult {
  readonly result: MemoryOpResult;
  readonly halt: boolean;
}

export const MEMORY_WRITE_OPS: ReadonlySet<MemoryOpKind> = new Set([
  'forget.apply',
  'memory.save',
  'memory.continue',
  'memory.start_review',
  'memory.delete_due',
  'directive.revoke',
]);

const KINDS: ReadonlySet<string> = new Set<MemoryOpKind>([
  'forget.graph',
  'forget.apply',
  'forget.ledger_export',
  'memory.save',
  'memory.continue',
  'memory.start_review',
  'memory.delete_due',
  'directive.revoke',
]);

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSource(value: unknown): value is MemorySource {
  if (value === null || typeof value !== 'object') return false;
  const source = value as Partial<MemorySource>;
  if (!SOURCE_KINDS.includes(source.source_kind as never)) return false;
  return source.source_kind === 'source_item'
    ? typeof source.source_id === 'string' &&
        ORIGINAL_SOURCE_ID.test(source.source_id)
    : isUuid(source.source_id);
}

function isHmacList(value: unknown): value is readonly SourceHmacValue[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every(
      (item: Partial<SourceHmacValue> | null) =>
        item !== null &&
        typeof item === 'object' &&
        isSource({
          source_kind: item.source_kind,
          source_id: item.source_id,
        }) &&
        typeof item.hmac === 'string' &&
        item.hmac.length <= 128,
    )
  );
}

const GENERATION = /^(0|[1-9][0-9]{0,15})$/u;

// 命令の形の検査。理由が空なら形は正しい。
export function memoryOpShapeReasons(op: MemoryOp): string[] {
  if (op === null || typeof op !== 'object' || !KINDS.has(op.kind))
    return ['kind_invalid'];
  const reasons: string[] = [];
  switch (op.kind) {
    case 'forget.graph':
      if (!isSource(op.target)) reasons.push('target_invalid');
      break;
    case 'forget.apply':
      if (!isSource(op.target)) reasons.push('target_invalid');
      if (op.instruction_turn_id !== null && !isUuid(op.instruction_turn_id))
        reasons.push('instruction_turn_id_invalid');
      if (op.plan === null || typeof op.plan !== 'object')
        reasons.push('plan_invalid');
      if (!isHmacList(op.source_hmacs)) reasons.push('source_hmacs_invalid');
      if (!isUuid(op.entry_id)) reasons.push('entry_id_invalid');
      if (
        typeof op.previous_generation !== 'string' ||
        !GENERATION.test(op.previous_generation)
      )
        reasons.push('generation_invalid');
      if (!isUuid(op.new_ledger_id)) reasons.push('ledger_id_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'forget.ledger_export':
      break;
    case 'memory.save':
      if (!isUuid(op.memory_id)) reasons.push('memory_id_invalid');
      if (op.origin !== 'auto_extraction' && op.origin !== 'explicit_request')
        reasons.push('origin_invalid');
      if (!MEMORY_KINDS.includes(op.memory_kind))
        reasons.push('memory_kind_invalid');
      if (!isSealedBlob(op.text) || !isSealedBlob(op.target_key))
        reasons.push('content_invalid');
      if (!isHex64(op.target_key_hash) || !isHex64(op.dedupe_key))
        reasons.push('hash_invalid');
      if (
        !Array.isArray(op.sources) ||
        op.sources.length > 256 ||
        !op.sources.every(isSource)
      )
        reasons.push('sources_invalid');
      if (!isHmacList(op.source_hmacs)) reasons.push('source_hmacs_invalid');
      if (
        typeof op.forgetting_generation !== 'string' ||
        !GENERATION.test(op.forgetting_generation)
      )
        reasons.push('generation_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'memory.continue':
    case 'memory.start_review':
    case 'memory.delete_due':
      if (!isUuid(op.memory_id)) reasons.push('memory_id_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'directive.revoke':
      if (!isUuid(op.directive_id)) reasons.push('directive_id_invalid');
      break;
  }
  return reasons;
}

// --- 記憶 ---

interface MemoryRow {
  memory_id: string;
  status: 'active' | 'review_pending' | 'deleted';
  created_at: number;
  review_at: number;
  delete_at: number | null;
  text_blob_id: string;
  target_key_blob_id: string;
}

function memoryRow(db: SqliteDatabase, id: string): MemoryRow | undefined {
  return db
    .prepare(
      'SELECT memory_id, status, created_at, review_at, delete_at, text_blob_id, target_key_blob_id FROM memories WHERE memory_id = ?',
    )
    .get(id) as MemoryRow | undefined;
}

function schedule(row: MemoryRow): MemoryScheduleValue {
  return {
    memory_id: row.memory_id,
    status: row.status === 'review_pending' ? 'review_pending' : 'active',
    review_at: row.review_at,
    delete_at: row.delete_at,
  };
}

function insertMemoryBlob(
  db: SqliteDatabase,
  purpose: 'memory_text' | 'memory_target_key',
  memoryId: string,
  blob: SealedBlobInput,
  now: number,
): void {
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, ?, 'memories', ?, 0, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    blob.blob_id,
    purpose,
    memoryId,
    blob.format_version,
    blob.key_id,
    Buffer.from(blob.nonce),
    Buffer.from(blob.ciphertext),
    Buffer.from(blob.tag),
    now,
  );
}

// 記憶の保存。保存の直前の最後の保証として、台帳の全件と由来を照合する（ADR 0040 の「忘却の関連の判定」）。
function saveMemory(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.save' }>,
): MemoryScheduleValue {
  const reasons: string[] = [];
  // 記憶は由来関係を必ず記録する（03）。由来がなければ忘却と関係するか判定できない。
  if (op.sources.length === 0) reasons.push('provenance_unknown');
  const hmacs = new Map(
    op.source_hmacs.map((item) => [
      `${item.source_kind}\u0000${item.source_id}`,
      item.hmac,
    ]),
  );
  const current = currentForgettingGeneration(db);
  // 由来の HMAC が渡されていなければ、照合できないので形の不正（source_hmac_malformed）として拒否する（閉じた側）。
  reasons.push(
    ...ledgerRelationReasons({
      sources: op.sources,
      startedGeneration: op.forgetting_generation,
      currentGeneration: String(current),
      ledger: readLedgerEntries(db),
      sourceHmac: (source) =>
        hmacs.get(`${source.source_kind}\u0000${source.source_id}`) ?? '',
      contentKey: op.origin === 'auto_extraction' ? op.dedupe_key : null,
    }),
  );
  // 由来がもうない（期限で消えた発言・記憶）なら、期限切れの由来として保存しない（ADR 0040。閉じた側）。
  const sourceMemoryReviewAts: number[] = [];
  for (const source of op.sources) {
    if (source.source_kind === 'turn') {
      if (
        db
          .prepare('SELECT 1 FROM turns WHERE turn_id = ?')
          .get(source.source_id) === undefined
      )
        reasons.push('source_expired');
    } else if (source.source_kind === 'memory') {
      const row = memoryRow(db, source.source_id);
      if (row === undefined || row.status === 'deleted')
        reasons.push('source_expired');
      else sourceMemoryReviewAts.push(row.review_at);
    }
  }
  if (reasons.length > 0) throw new ForgetRejection([...new Set(reasons)]);
  if (memoryRow(db, op.memory_id) !== undefined)
    throw new ForgetRejection(['memory_exists']);
  const live = db
    .prepare(
      "SELECT dedupe_key, kind, target_key_hash FROM memories WHERE status <> 'deleted'",
    )
    .all() as { dedupe_key: string; kind: string; target_key_hash: string }[];
  if (live.some((row) => row.dedupe_key === op.dedupe_key))
    throw new ForgetRejection(['memory_duplicate']);
  // 同じ種類・同じ対象キーで内容が違えば、両方を見直し待ちにする（J15）。見直し待ちの期限の起点は原本に決めなしで、
  // 今の CHECK（見直し日は作成より後）では表せないので、この命令は保存せずに知らせる（U111）。
  if (
    live.some(
      (row) =>
        row.kind === op.memory_kind &&
        row.target_key_hash === op.target_key_hash,
    )
  )
    throw new ForgetRejection(['memory_conflict_review_required']);
  // 見直し日: 保存から 90 日。別の記憶から作った記憶は、由来の見直し日より後にしない（再要約で延ばさない）。
  const reviewAt = Math.min(
    op.now + MEMORY_REVIEW_DAYS * DAY_MS,
    ...sourceMemoryReviewAts,
  );
  if (reviewAt <= op.now) throw new ForgetRejection(['source_review_due']);
  insertMemoryBlob(db, 'memory_text', op.memory_id, op.text, op.now);
  insertMemoryBlob(
    db,
    'memory_target_key',
    op.memory_id,
    op.target_key,
    op.now,
  );
  db.prepare(
    "INSERT INTO memories (memory_id, origin, kind, text_blob_id, target_key_blob_id, target_key_hash, dedupe_key, status, created_at, review_at, delete_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)",
  ).run(
    op.memory_id,
    op.origin,
    op.memory_kind,
    op.text.blob_id,
    op.target_key.blob_id,
    op.target_key_hash,
    op.dedupe_key,
    op.now,
    reviewAt,
  );
  const source = db.prepare(
    'INSERT INTO memory_sources (memory_id, source_kind, source_id) VALUES (?, ?, ?)',
  );
  const written = new Set<string>();
  for (const item of op.sources) {
    const key = `${item.source_kind}\u0000${item.source_id}`;
    if (written.has(key)) continue;
    written.add(key);
    source.run(op.memory_id, item.source_kind, item.source_id);
  }
  return {
    memory_id: op.memory_id,
    status: 'active',
    review_at: reviewAt,
    delete_at: null,
  };
}

function continueMemory(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.continue' }>,
): MemoryScheduleValue {
  const row = memoryRow(db, op.memory_id);
  if (row === undefined) throw new ForgetRejection(['memory_not_found']);
  if (row.status !== 'review_pending')
    throw new ForgetRejection(['not_review_pending']);
  // 見直し待ちのまま期限を過ぎた記憶は、継続で生き返らせない（削除の掃除を待つ）。
  if (row.delete_at !== null && op.now >= row.delete_at)
    throw new ForgetRejection(['delete_due']);
  const reviewAt = op.now + MEMORY_REVIEW_DAYS * DAY_MS;
  db.prepare(
    "UPDATE memories SET status = 'active', review_at = ?, delete_at = NULL WHERE memory_id = ? AND status = 'review_pending'",
  ).run(reviewAt, op.memory_id);
  return {
    memory_id: op.memory_id,
    status: 'active',
    review_at: reviewAt,
    delete_at: null,
  };
}

function startReview(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.start_review' }>,
): MemoryScheduleValue {
  const row = memoryRow(db, op.memory_id);
  if (row === undefined) throw new ForgetRejection(['memory_not_found']);
  if (row.status !== 'active') throw new ForgetRejection(['not_active']);
  if (op.now < row.review_at) throw new ForgetRejection(['not_due']);
  const deleteAt = row.review_at + MEMORY_DELETE_AFTER_REVIEW_DAYS * DAY_MS;
  db.prepare(
    "UPDATE memories SET status = 'review_pending', delete_at = ? WHERE memory_id = ? AND status = 'active'",
  ).run(deleteAt, op.memory_id);
  return schedule({ ...row, status: 'review_pending', delete_at: deleteAt });
}

// 期限切れの記憶の物理削除（台帳には書かない。再登録を禁じない。ADR 0008・0040）。記憶の由来・系譜の辺（記憶が
// 派生物である辺）・暗号文を消す。この記憶を由来にする辺は残す（存在しない由来は期限切れとして扱う）。
function deleteDueMemory(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.delete_due' }>,
): { readonly memory_id: string; readonly deleted: boolean } {
  const row = memoryRow(db, op.memory_id);
  if (row === undefined) return { memory_id: op.memory_id, deleted: false };
  if (row.status !== 'review_pending' || row.delete_at === null)
    throw new ForgetRejection(['not_review_pending']);
  if (op.now < row.delete_at) throw new ForgetRejection(['not_due']);
  db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(
    op.memory_id,
  );
  db.prepare(
    "DELETE FROM derivations WHERE artifact_kind = 'memory' AND artifact_id = ?",
  ).run(op.memory_id);
  db.prepare('DELETE FROM memories WHERE memory_id = ?').run(op.memory_id);
  db.prepare('DELETE FROM sealed_blobs WHERE blob_id IN (?, ?)').run(
    row.text_blob_id,
    row.target_key_blob_id,
  );
  return { memory_id: op.memory_id, deleted: true };
}

// 本人の指示の取り消し。取り消した指示は使わないので、行と暗号文を消す（03 は設定画面で確認・取り消しできるとだけ
// 定める。取り消した指示を残す理由がないので、残さない側にした。U112）。
function revokeDirective(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'directive.revoke' }>,
): { readonly directive_id: string; readonly revoked: boolean } {
  const blob = db
    .prepare('SELECT text_blob_id FROM user_directives WHERE directive_id = ?')
    .pluck()
    .get(op.directive_id) as string | undefined;
  if (blob === undefined)
    return { directive_id: op.directive_id, revoked: false };
  db.prepare('DELETE FROM user_directives WHERE directive_id = ?').run(
    op.directive_id,
  );
  db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(blob);
  return { directive_id: op.directive_id, revoked: true };
}

function applyWrite(db: SqliteDatabase, op: MemoryOp): MemoryOpValue {
  switch (op.kind) {
    case 'forget.apply':
      return applyForget(db, op);
    case 'memory.save':
      return saveMemory(db, op);
    case 'memory.continue':
      return continueMemory(db, op);
    case 'memory.start_review':
      return startReview(db, op);
    case 'memory.delete_due':
      return deleteDueMemory(db, op);
    case 'directive.revoke':
      return revokeDirective(db, op);
    default:
      throw new ForgetRejection(['kind_invalid']);
  }
}

function readOnly(db: SqliteDatabase, op: MemoryOp): MemoryOpValue {
  switch (op.kind) {
    case 'forget.graph':
      return db.transaction(() => ({
        graph: readForgetGraph(db),
        forgetting_generation: String(currentForgettingGeneration(db)),
        target_exists: forgetTargetExists(db, op.target),
        ledger_id: readLedgerId(db),
      }))();
    case 'forget.ledger_export':
      return db.transaction(() => exportForgetLedger(db))();
    default:
      throw new ForgetRejection(['kind_invalid']);
  }
}

const rejected = (reasons: readonly string[]): MemoryOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

function failure(error: unknown): MemoryStoreResult {
  if (error instanceof ForgetRejection)
    return { result: rejected(error.reasons), halt: false };
  if (error instanceof Error && error.name === 'CommitUncertain')
    return {
      result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
      halt: true,
    };
  const code = error instanceof Database.SqliteError ? error.code : null;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return { result: rejected(['database_busy']), halt: false };
  if (code?.startsWith('SQLITE_CONSTRAINT')) {
    const message = error instanceof Error ? error.message : '';
    return {
      result: rejected([
        /^[a-z_]{1,64}$/u.test(message) ? message : 'constraint_violation',
      ]),
      halt: false,
    };
  }
  return {
    result: rejected([
      code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
    ]),
    halt: true,
  };
}

export interface MemoryContext {
  readonly platform: StoragePlatform;
  readonly halted: boolean;
  // 故障注入の試験用。transaction の本体の後・COMMIT の前に呼ぶ。
  readonly beforeCommit?: (op: MemoryOp) => void;
}

// 記憶と忘却の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeMemoryOp(
  db: SqliteDatabase,
  op: MemoryOp,
  context: MemoryContext,
): MemoryStoreResult {
  const shape = memoryOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (!MEMORY_WRITE_OPS.has(op.kind)) {
    try {
      return { result: { ok: true, value: readOnly(db, op) }, halt: false };
    } catch (error) {
      if (error instanceof ForgetRejection)
        return { result: rejected(error.reasons), halt: false };
      throw error;
    }
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
  const beforeCommit =
    context.beforeCommit === undefined
      ? undefined
      : () => context.beforeCommit?.(op);
  try {
    const run = runImmediate(db, () => applyWrite(db, op), beforeCommit);
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    return failure(error);
  }
}
