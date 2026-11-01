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
  RETENTION_RULES,
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
  lineageHasLiveDownstream,
  lineageSources,
  pruneDeadLineage,
  readForgetGraph,
  readLedgerChain,
  readLedgerEntries,
  readLedgerId,
} from './forget-store.js';
import { buildLedgerFile, parseLedgerFile } from './forget-ledger-file.js';
import type {
  ForgetApplyValue,
  ForgetLedgerExport,
  SourceHmacValue,
} from './forget-store.js';

const DAY_MS = 86_400_000;
// 元情報の本文の保存期限（取得から 24 時間。domain の RETENTION_RULES の source_body）。
const SOURCE_BODY_MS = RETENTION_RULES['source_body']?.ms ?? 0;
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
  // 0012 より前の台帳の行があり、系譜（ledger_id）がない DB に系譜を付ける（U119）。台帳のファイルがないことを Core が
  // 確かめてから呼ぶ。旧い行が台帳のファイルの形で書き出せなければ付けない。
  | { readonly kind: 'forget.adopt_ledger_id'; readonly ledger_id: string }
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
  'forget.adopt_ledger_id': {
    readonly ledger_id: string;
    readonly forgetting_generation: string;
  };
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
  'forget.adopt_ledger_id',
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
  'forget.adopt_ledger_id',
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
    case 'forget.adopt_ledger_id':
      if (!isUuid(op.ledger_id)) reasons.push('ledger_id_invalid');
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
  // 由来がもうない・期限を過ぎた（掃除がまだでも）なら、期限切れの由来として保存しない（ADR 0040・0054 U118。閉じた側）。
  // 期限はこの transaction の中の今の値で判定し、ちょうどは期限切れ（掃除の sweepPlan の due と同じ now >= 期限）。
  const sourceMemoryReviewAts: number[] = [];
  for (const source of op.sources) {
    if (source.source_kind === 'turn') {
      const expiresAt = db
        .prepare('SELECT expires_at FROM turns WHERE turn_id = ?')
        .pluck()
        .get(source.source_id) as number | undefined;
      if (expiresAt === undefined || op.now >= expiresAt)
        reasons.push('source_expired');
    } else if (source.source_kind === 'source_item') {
      // 元情報は元サービスの ID（remote_id）で引く（忘却と同じ。U110）。本文が保存期限の中にある行が 1 つもなければ拒否。
      const rows = db
        .prepare(
          'SELECT fetched_at, body_blob_id FROM source_items WHERE remote_id = ?',
        )
        .all(source.source_id) as {
        fetched_at: number;
        body_blob_id: string | null;
      }[];
      if (
        !rows.some(
          (row) =>
            row.body_blob_id !== null &&
            op.now < row.fetched_at + SOURCE_BODY_MS,
        )
      )
        reasons.push('source_expired');
    } else {
      const row = memoryRow(db, source.source_id);
      if (
        row === undefined ||
        row.status === 'deleted' ||
        (row.delete_at !== null && op.now >= row.delete_at)
      )
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
  // 見直し待ちのまま期限を過ぎた記憶は、継続で生き返らせない（削除の掃除を待つ）。期限は削除と同じ補正を通す。
  if (op.now >= cappedDeleteAt(row)) throw new ForgetRejection(['delete_due']);
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

// 見直し待ちの削除日。保存した値と見直し日＋30 日の小さい方（保存した値が 30 日を超えて延ばされていても戻す。domain の
// sweepPlan と同じ補正で、計画と命令の結果を食い違わせない）。NULL は見直し日＋30 日。
function cappedDeleteAt(row: MemoryRow): number {
  const cap = row.review_at + MEMORY_DELETE_AFTER_REVIEW_DAYS * DAY_MS;
  return row.delete_at === null ? cap : Math.min(row.delete_at, cap);
}

// 期限切れの記憶の物理削除（台帳には書かない。再登録を禁じない。ADR 0008・0040）。記憶の行・由来の行・暗号文を消す。
// この記憶を由来にする辺は残す（存在しない由来は期限切れとして扱う）。派生物が残っていれば、この記憶の由来の辺
// （ID だけ）を derivations に残す。本文を消しても、生きた派生物から元の発言・元情報へ辿れるようにし、後で元情報を
// 忘れたときに派生物が閉包から漏れないようにする（ADR 0054 U110。辺は削除の前と同じなので、閉包は削除の前と変わらない）。
function deleteDueMemory(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'memory.delete_due' }>,
): { readonly memory_id: string; readonly deleted: boolean } {
  const row = memoryRow(db, op.memory_id);
  if (row === undefined) return { memory_id: op.memory_id, deleted: false };
  // 状態が deleted の行（掃除の計画の status_deleted）は期限を待たずに消す。ほかは見直し待ちで、期限を過ぎたものだけ。
  // 期限は domain の sweepPlan（ADR 0043）と同じ補正を通す: 保存した削除日と見直し日＋30 日の小さい方（0001 の CHECK で
  // 見直し待ちの削除日が NULL の行は作れないが、NULL なら見直し日＋30 日）。
  if (row.status !== 'deleted') {
    if (row.status !== 'review_pending')
      throw new ForgetRejection(['not_review_pending']);
    if (op.now < cappedDeleteAt(row)) throw new ForgetRejection(['not_due']);
  }
  const sources = db
    .prepare(
      'SELECT source_kind, source_id FROM memory_sources WHERE memory_id = ? ORDER BY source_kind, source_id',
    )
    .all(op.memory_id) as { source_kind: string; source_id: string }[];
  const node = { kind: 'memory', id: op.memory_id };
  const parents = lineageSources(db, node);
  if (lineageHasLiveDownstream(db, node)) {
    const exists = db.prepare(
      "SELECT 1 FROM derivations WHERE artifact_kind = 'memory' AND artifact_id = ? AND source_kind = ? AND source_id = ?",
    );
    const insert = db.prepare(
      "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('memory', ?, ?, ?, ?)",
    );
    for (const source of sources)
      if (
        exists.get(op.memory_id, source.source_kind, source.source_id) ===
        undefined
      )
        insert.run(op.memory_id, source.source_kind, source.source_id, op.now);
  }
  db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(
    op.memory_id,
  );
  db.prepare('DELETE FROM memories WHERE memory_id = ?').run(op.memory_id);
  db.prepare('DELETE FROM sealed_blobs WHERE blob_id IN (?, ?)').run(
    row.text_blob_id,
    row.target_key_blob_id,
  );
  // 生きた下流がなければ、この記憶の辺を消し、実体を消した由来（記憶・ほかの派生物）の辺も要らなくなれば消す。
  pruneDeadLineage(db, [node, ...parents]);
  return { memory_id: op.memory_id, deleted: true };
}

// 0012 より前の台帳の行（hash・項目の数が NULL）に系譜を付ける（U119）。0012 より前の製品に台帳を書く経路はなかったので、
// ふつうは起きない。台帳のファイル・端末の複製がないこと（系譜を確かめられないのに新しい ID を出さないこと）は Core が
// 確かめる。旧い行が台帳のファイルの形（次の起動で読み戻す形）で書き出せなければ付けずに拒否する（手で直す）。
function adoptLedgerId(
  db: SqliteDatabase,
  op: Extract<MemoryOp, { kind: 'forget.adopt_ledger_id' }>,
): { readonly ledger_id: string; readonly forgetting_generation: string } {
  if (readLedgerId(db) !== null)
    throw new ForgetRejection(['ledger_id_present']);
  const entries = readLedgerChain(db);
  const last = entries.at(-1);
  if (last === undefined) throw new ForgetRejection(['ledger_empty']);
  const file = buildLedgerFile(
    {
      ledger_id: op.ledger_id,
      entries,
      head: {
        forgetting_generation: last.entry.forgetting_generation,
        entry_hash: last.entry_hash,
      },
    },
    new Date(0),
  );
  if (parseLedgerFile(JSON.stringify(file)) === null)
    throw new ForgetRejection(['legacy_ledger_invalid']);
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('ledger_id', ?)",
  ).run(op.ledger_id);
  return {
    ledger_id: op.ledger_id,
    forgetting_generation: last.entry.forgetting_generation,
  };
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
    case 'forget.adopt_ledger_id':
      return adoptLedgerId(db, op);
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
