// 終わった操作の本文の削除（J5 の 7 日）・操作のレシートの 90 日の削除と、用事の正本の移行（B06-06c、ADR 0040・0051、
// マイグレーション 0011。設計 03 保存期限・本人が確定保存したメモ・用事、08 §5）。
//
// DB worker の中で実行する同期関数。書込みは操作 1 件（用事 1 件）ごとに 1 つの短い BEGIN IMMEDIATE の transaction で行い、
// 途中で止まっても、もう一度呼べば残りから続けられる（消した行は対象から外れ、同じ命令は何度呼んでも同じ結果になる）。
// - 時刻は呼び出し側が渡す now をそのまま信じる（DB は時計を持たない）。時計の巻き戻しの保留は domain の sweepPlan が
//   判定するので、B06-06d で必ずその判定を通してから呼ぶ（budget.purge_month と同じ）。
// - 0010 までの用事の暗号文の移行（Core の起動時のデータ移行）が済んでいない用事がある操作だけを残し、ほかの操作の
//   本文の削除・90 日の削除は進める。操作ごとに taskNotMigrated で確かめ、最後の保証は 0011 の trigger
//   （task_content_not_migrated）。全体のゲートは置かない（1 件の移せない用事で全部の削除を止めない）。
// - 結果不明（unknown_held）と進行中の操作は対象外。取り消しの補償の操作が完了していない間は 90 日の削除をしない。
// 結果には ID と件数だけを入れ、本文・SQL・パスを入れない。

import Database from 'better-sqlite3';
import { RETENTION_RULES } from '@buddy/domain';
import type {
  BudgetReservationRow,
  OperationRow as SweepOperationRow,
  SweepRow,
} from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { isId, isSealedBlob } from './operation-commands.js';
import type { SealedBlobInput } from './operation-commands.js';
import {
  COMPLETED_OPERATION_STATES,
  insertTaskContent,
  runImmediate,
} from './operation-store.js';
import type { SealedEnvelope } from './sealed-blob.js';

const BODY_TTL_MS = RETENTION_RULES['operation_body']?.ms ?? 0;
const RECEIPT_TTL_MS = RETENTION_RULES['operation_receipt']?.ms ?? 0;
const UNDO_TTL_MS = RETENTION_RULES['undo_window']?.ms ?? 0;

/** 1 回の命令で扱う件数の上限（11 §9 P06 の小分けと同じ 50）。 */
export const RETENTION_BATCH_LIMIT = 50;

const COMPLETED_SQL = `(${COMPLETED_OPERATION_STATES.map((state) => `'${state}'`).join(', ')})`;

/**
 * 90 日の削除の順序（ADR 0040 の 7 つの手順）。上から順に、1 つの transaction で実行する。どの時点でも外部キーの違反を
 * 作らない（参照する側の行を先に消す）。順序を入れ替えると外部キーの違反で失敗する（試験で確かめる）。
 * - request_entity_operations・tasks は 0011 で operations・operation_versions を参照しなくなったので、ここでは消さない
 *   （依頼の一度だけの記録は依頼の期限まで、用事は本人の削除まで残る）。
 * - 手順 6 は内容版の行を消してから、その確定 intent の暗号文（持ち主は operation_versions の操作 ID）を消す。
 */
export const OPERATION_PURGE_STEPS: readonly {
  readonly step: number;
  readonly table: string;
  readonly statements: readonly string[];
}[] = [
  {
    step: 1,
    table: 'undo_records',
    statements: [
      'DELETE FROM undo_records WHERE operation_id = @id OR compensation_operation_id = @id',
    ],
  },
  {
    step: 2,
    table: 'auto_actions',
    statements: ['DELETE FROM auto_actions WHERE operation_id = @id'],
  },
  {
    step: 3,
    table: 'operation_steps',
    statements: [
      'DELETE FROM operation_steps WHERE attempt_id IN (SELECT attempt_id FROM operation_attempts WHERE operation_id = @id)',
    ],
  },
  {
    step: 4,
    table: 'operation_attempts',
    statements: ['DELETE FROM operation_attempts WHERE operation_id = @id'],
  },
  {
    step: 5,
    table: 'approvals',
    statements: ['DELETE FROM approvals WHERE operation_id = @id'],
  },
  {
    step: 6,
    table: 'operation_versions',
    statements: [
      'DELETE FROM operation_versions WHERE operation_id = @id',
      "DELETE FROM sealed_blobs WHERE owner_table = 'operation_versions' AND purpose = 'operation_intent' AND owner_id = @id",
    ],
  },
  {
    step: 7,
    table: 'operations',
    statements: ['DELETE FROM operations WHERE operation_id = @id'],
  },
];

// --- 命令 ---

export interface OperationCursor {
  readonly completed_at: number;
  readonly operation_id: string;
}

export interface TaskStagedBlob extends SealedEnvelope {
  readonly blob_id: string;
}

export type RetentionOp =
  // 暗号文を移していない用事の件数（その用事の操作だけが削除から残る。全体のゲートは置かない）。
  | { readonly kind: 'retention.gate' }
  // 1 つの操作の本文を消す（完了から 7 日）。すべての内容版の確定 intent の暗号文を消し、hash と行は残す。
  | {
      readonly kind: 'retention.erase_body';
      readonly operation_id: string;
      readonly now: number;
    }
  // 1 つの操作のレシートを消す（完了から 90 日）。OPERATION_PURGE_STEPS の順に消す。
  | {
      readonly kind: 'retention.purge_operation';
      readonly operation_id: string;
      readonly now: number;
    }
  // 期限の来た操作を、完了の古い順に limit 件まで、1 件ずつ別の transaction で本文を消す。after から続ける。
  | {
      readonly kind: 'retention.erase_due_bodies';
      readonly now: number;
      readonly limit: number;
      readonly after: OperationCursor | null;
    }
  | {
      readonly kind: 'retention.purge_due_operations';
      readonly now: number;
      readonly limit: number;
      readonly after: OperationCursor | null;
    }
  // 掃除の計画（domain の sweepPlan）へ渡す行を読む（B06-06d1）。操作と予算の月の組だけを返す。
  // 発言・元情報・記憶・派生物は、削除の命令を作る作業（B06-06d2）で足す。
  | { readonly kind: 'retention.sweep_rows'; readonly now: number }
  // 取り消しの期限（30 日、undo_window）を過ぎた undo_records を消す。補償の操作がまだ終わっていない
  // 記録は残す（ADR 0040・0051）。これで補償のない記録が 90 日の削除を止め続けない。
  | { readonly kind: 'retention.purge_undo_records'; readonly now: number }
  // 削除を伴う掃除の後の WAL の切り詰め（ADR 0040・0048）。マイグレーションの外でだけ実行する。
  | { readonly kind: 'retention.checkpoint' }
  // マイグレーションの外の定期の VACUUM（ADR 0016・0040・0048）。間隔は呼び出し側（Core の job）が決める。
  | { readonly kind: 'retention.vacuum' }
  // 用事の内容（暗号文）を読む。
  | { readonly kind: 'task.read'; readonly task_id: string }
  // 暗号文を移していない用事を task_id の順に limit 件まで読む（after より後）。確定 intent の暗号文と、
  // 書き込み済みで結び付けていない暗号文（移行の途中で止まったもの）を添える。
  | {
      readonly kind: 'task.migration_next';
      readonly limit: number;
      readonly after: string | null;
    }
  // 移行: 用事を所有者にした暗号文を書く（まだ結び付けない）。結び付けるのは、Core が読み戻して復号を確かめた後。
  | {
      readonly kind: 'task.stage_content';
      readonly task_id: string;
      readonly content: SealedBlobInput;
      readonly now: number;
    }
  // 移行: 読み戻しを確かめた暗号文を用事に結び付ける（content_blob_id を NULL から値へ一度だけ）。
  | {
      readonly kind: 'task.link_content';
      readonly task_id: string;
      readonly blob_id: string;
    }
  // 移行: 読み戻しが合わなかった、結び付けていない暗号文を消す（次の起動で書き直す）。
  | {
      readonly kind: 'task.discard_staged';
      readonly task_id: string;
      readonly blob_id: string;
    };

export type RetentionOpKind = RetentionOp['kind'];

export interface RetentionGateValue {
  readonly tasks_pending: number;
}

export interface EraseBodyValue {
  readonly operation_id: string;
  // 今回消した内容版の本文の数（既に消えていれば 0）。
  readonly erased_versions: number;
}

export interface PurgeOperationValue {
  readonly operation_id: string;
  // 今回消したか（既に消えていれば false）。
  readonly purged: boolean;
}

export interface RetentionBatchValue {
  readonly processed: readonly string[];
  readonly skipped: readonly {
    readonly operation_id: string;
    readonly reasons: readonly string[];
  }[];
  // 続きの位置。対象を最後まで見たら null。
  readonly next: OperationCursor | null;
}

export interface SweepRowsValue {
  readonly rows: readonly SweepRow[];
}

export interface UndoPurgeValue {
  // 今回消した undo_records の数。
  readonly purged: number;
}

export interface CheckpointValue {
  // PRAGMA wal_checkpoint(TRUNCATE) の読み戻し。busy が 1 なら他が読んでいて切り詰められていない。
  readonly busy: number;
  readonly log_frames: number;
  readonly checkpointed_frames: number;
}

export interface VacuumValue {
  readonly vacuumed: true;
}

export interface TaskContentRecord {
  readonly task_id: string;
  readonly operation_id: string;
  readonly list_id: string;
  readonly status: 'open' | 'done';
  readonly created_at: number;
  // 暗号文。0010 までの用事で移行が済んでいなければ null。
  readonly content: TaskStagedBlob | null;
}

export interface TaskMigrationItem {
  readonly task_id: string;
  readonly operation_id: string;
  readonly content_version: number;
  // 確定 intent の hash と暗号文。本文が見つからなければ null（0011 の trigger により、移行前には消えない）。
  readonly content_hash: string | null;
  readonly intent: SealedEnvelope | null;
  // 書き込み済みで結び付けていない暗号文。
  readonly staged: TaskStagedBlob | null;
}

export interface TaskMigrationBatch {
  readonly items: readonly TaskMigrationItem[];
  readonly pending: number;
}

export interface RetentionOpValues {
  'retention.gate': RetentionGateValue;
  'retention.erase_body': EraseBodyValue;
  'retention.purge_operation': PurgeOperationValue;
  'retention.erase_due_bodies': RetentionBatchValue;
  'retention.purge_due_operations': RetentionBatchValue;
  'retention.sweep_rows': SweepRowsValue;
  'retention.purge_undo_records': UndoPurgeValue;
  'retention.checkpoint': CheckpointValue;
  'retention.vacuum': VacuumValue;
  'task.read': TaskContentRecord | null;
  'task.migration_next': TaskMigrationBatch;
  'task.stage_content': { readonly task_id: string; readonly blob_id: string };
  'task.link_content': { readonly task_id: string; readonly blob_id: string };
  'task.discard_staged': { readonly task_id: string; readonly blob_id: string };
}

export type RetentionOpValue = RetentionOpValues[RetentionOpKind];

export type RetentionOpResult =
  | { readonly ok: true; readonly value: RetentionOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface RetentionStoreResult {
  readonly result: RetentionOpResult;
  readonly halt: boolean;
}

export const RETENTION_WRITE_OPS: ReadonlySet<RetentionOpKind> = new Set([
  'retention.erase_body',
  'retention.purge_operation',
  'retention.erase_due_bodies',
  'retention.purge_due_operations',
  'retention.purge_undo_records',
  'retention.checkpoint',
  'retention.vacuum',
  'task.stage_content',
  'task.link_content',
  'task.discard_staged',
]);

const KINDS: ReadonlySet<string> = new Set<RetentionOpKind>([
  'retention.gate',
  'retention.erase_body',
  'retention.purge_operation',
  'retention.erase_due_bodies',
  'retention.purge_due_operations',
  'retention.sweep_rows',
  'retention.purge_undo_records',
  'retention.checkpoint',
  'retention.vacuum',
  'task.read',
  'task.migration_next',
  'task.stage_content',
  'task.link_content',
  'task.discard_staged',
]);

class RetentionRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'RetentionRejection';
    this.reasons = reasons;
  }
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= RETENTION_BATCH_LIMIT
  );
}

function isCursor(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const cursor = value as Partial<OperationCursor>;
  return isTime(cursor.completed_at) && isId(cursor.operation_id);
}

// 命令の形の検査。理由が空なら形は正しい。
export function retentionOpShapeReasons(op: RetentionOp): string[] {
  const reasons: string[] = [];
  if (op === null || typeof op !== 'object' || !KINDS.has(op.kind))
    return ['kind_invalid'];
  switch (op.kind) {
    case 'retention.gate':
      break;
    case 'retention.erase_body':
    case 'retention.purge_operation':
      if (!isId(op.operation_id)) reasons.push('operation_id_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'retention.erase_due_bodies':
    case 'retention.purge_due_operations':
      if (!isTime(op.now)) reasons.push('now_invalid');
      if (!isLimit(op.limit)) reasons.push('limit_invalid');
      if (!isCursor(op.after)) reasons.push('cursor_invalid');
      break;
    case 'retention.purge_undo_records':
    case 'retention.sweep_rows':
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'task.read':
      if (!isId(op.task_id)) reasons.push('task_id_invalid');
      break;
    case 'task.migration_next':
      if (!isLimit(op.limit)) reasons.push('limit_invalid');
      if (op.after !== null && !isId(op.after)) reasons.push('cursor_invalid');
      break;
    case 'task.stage_content':
      if (!isId(op.task_id)) reasons.push('task_id_invalid');
      if (!isSealedBlob(op.content)) reasons.push('content_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'task.link_content':
    case 'task.discard_staged':
      if (!isId(op.task_id)) reasons.push('task_id_invalid');
      if (!isId(op.blob_id)) reasons.push('blob_id_invalid');
      break;
  }
  return reasons;
}

// --- 照会 ---

function tasksPending(db: SqliteDatabase): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM tasks WHERE content_blob_id IS NULL')
    .get() as { n: number };
  return row.n;
}

interface BlobRow {
  blob_id: string;
  format_version: number;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function toBlob(row: BlobRow): TaskStagedBlob {
  return {
    blob_id: row.blob_id,
    formatVersion: row.format_version,
    keyId: row.key_id,
    nonce: new Uint8Array(row.nonce),
    ciphertext: new Uint8Array(row.ciphertext),
    tag: new Uint8Array(row.tag),
  };
}

const BLOB_COLUMNS = 'blob_id, format_version, key_id, nonce, ciphertext, tag';

function blobById(db: SqliteDatabase, blobId: string): BlobRow | undefined {
  return db
    .prepare(`SELECT ${BLOB_COLUMNS} FROM sealed_blobs WHERE blob_id = ?`)
    .get(blobId) as BlobRow | undefined;
}

// 用事を所有者にして書いた暗号文（結び付けているかどうかによらない）。
function stagedBlob(db: SqliteDatabase, taskId: string): BlobRow | undefined {
  return db
    .prepare(
      `SELECT ${BLOB_COLUMNS} FROM sealed_blobs WHERE owner_table = 'tasks' AND owner_id = ? AND owner_version = 0 AND purpose = 'task_content'`,
    )
    .get(taskId) as BlobRow | undefined;
}

export function readTaskContent(
  db: SqliteDatabase,
  taskId: string,
): TaskContentRecord | null {
  const row = db
    .prepare(
      'SELECT task_id, operation_id, list_id, status, created_at, content_blob_id FROM tasks WHERE task_id = ?',
    )
    .get(taskId) as
    | {
        task_id: string;
        operation_id: string;
        list_id: string;
        status: 'open' | 'done';
        created_at: number;
        content_blob_id: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  const blob =
    row.content_blob_id === null
      ? undefined
      : blobById(db, row.content_blob_id);
  return {
    task_id: row.task_id,
    operation_id: row.operation_id,
    list_id: row.list_id,
    status: row.status,
    created_at: row.created_at,
    content: blob === undefined ? null : toBlob(blob),
  };
}

export function readTaskMigrationBatch(
  db: SqliteDatabase,
  limit: number,
  after: string | null,
): TaskMigrationBatch {
  const rows = db
    .prepare(
      `SELECT t.task_id, t.operation_id, t.content_version, v.content_hash,
              b.format_version, b.key_id, b.nonce, b.ciphertext, b.tag
         FROM tasks t
         LEFT JOIN operation_versions v ON v.operation_id = t.operation_id AND v.content_version = t.content_version
         LEFT JOIN sealed_blobs b ON b.blob_id = v.intent_blob_id
        WHERE t.content_blob_id IS NULL AND (? IS NULL OR t.task_id > ?)
        ORDER BY t.task_id LIMIT ?`,
    )
    .all(after, after, limit) as {
    task_id: string;
    operation_id: string;
    content_version: number;
    content_hash: string | null;
    format_version: number | null;
    key_id: string | null;
    nonce: Buffer | null;
    ciphertext: Buffer | null;
    tag: Buffer | null;
  }[];
  return {
    pending: tasksPending(db),
    items: rows.map((row) => {
      const staged = stagedBlob(db, row.task_id);
      return {
        task_id: row.task_id,
        operation_id: row.operation_id,
        content_version: row.content_version,
        content_hash: row.content_hash,
        intent:
          row.format_version === null ||
          row.key_id === null ||
          row.nonce === null ||
          row.ciphertext === null ||
          row.tag === null
            ? null
            : {
                formatVersion: row.format_version,
                keyId: row.key_id,
                nonce: new Uint8Array(row.nonce),
                ciphertext: new Uint8Array(row.ciphertext),
                tag: new Uint8Array(row.tag),
              },
        staged: staged === undefined ? null : toBlob(staged),
      };
    }),
  };
}

// --- 書込み（transaction の本体） ---

interface OperationRow {
  operation_id: string;
  state: string;
  completed_at: number | null;
}

// 本文の削除・90 日の削除に共通の前提。消してよければ操作の行を返し、既に消えていれば null。
function finishedOperation(
  db: SqliteDatabase,
  operationId: string,
  now: number,
  ttlMs: number,
): OperationRow | null {
  const row = db
    .prepare(
      'SELECT operation_id, state, completed_at FROM operations WHERE operation_id = ?',
    )
    .get(operationId) as OperationRow | undefined;
  if (row === undefined) return null;
  // 結果不明は完了ではない。照合のために本文とレシートを残す（ADR 0040）。
  if (row.state === 'unknown_held')
    throw new RetentionRejection(['unknown_held']);
  if (!(COMPLETED_OPERATION_STATES as readonly string[]).includes(row.state))
    throw new RetentionRejection(['operation_not_finished']);
  // 完了の時刻がない（0011 より前の未実行の確定など）ときは、起点が分からないので消さない。
  if (row.completed_at === null)
    throw new RetentionRejection(['completed_at_missing']);
  if (now < row.completed_at + ttlMs) throw new RetentionRejection(['not_due']);
  return row;
}

function taskNotMigrated(db: SqliteDatabase, operationId: string): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM tasks WHERE operation_id = ? AND content_blob_id IS NULL',
      )
      .get(operationId) !== undefined
  );
}

// 本文の削除（J5 の 7 日）。内容版ごとに intent_blob_id を NULL にしてから（同じ transaction で）暗号文の行を消す。
export function eraseOperationBody(
  db: SqliteDatabase,
  operationId: string,
  now: number,
): EraseBodyValue {
  const operation = finishedOperation(db, operationId, now, BODY_TTL_MS);
  if (operation === null) throw new RetentionRejection(['operation_not_found']);
  if (taskNotMigrated(db, operationId))
    throw new RetentionRejection(['task_content_not_migrated']);
  const versions = db
    .prepare(
      'SELECT content_version, intent_blob_id FROM operation_versions WHERE operation_id = ? AND intent_blob_id IS NOT NULL ORDER BY content_version',
    )
    .all(operationId) as { content_version: number; intent_blob_id: string }[];
  const clear = db.prepare(
    'UPDATE operation_versions SET intent_blob_id = NULL, body_deleted_at = ? WHERE operation_id = ? AND content_version = ? AND intent_blob_id = ?',
  );
  const remove = db.prepare(
    "DELETE FROM sealed_blobs WHERE blob_id = ? AND purpose = 'operation_intent'",
  );
  for (const version of versions) {
    const cleared = clear.run(
      now,
      operationId,
      version.content_version,
      version.intent_blob_id,
    );
    if (cleared.changes !== 1)
      throw new RetentionRejection(['operation_version_changed']);
    if (remove.run(version.intent_blob_id).changes !== 1)
      throw new RetentionRejection(['operation_body_missing']);
  }
  return { operation_id: operationId, erased_versions: versions.length };
}

// 90 日の削除（ADR 0040 の 7 つの手順）。
export function purgeOperation(
  db: SqliteDatabase,
  operationId: string,
  now: number,
): PurgeOperationValue {
  const operation = finishedOperation(db, operationId, now, RECEIPT_TTL_MS);
  if (operation === null) return { operation_id: operationId, purged: false };
  if (taskNotMigrated(db, operationId))
    throw new RetentionRejection(['task_content_not_migrated']);
  // 取り消しの相手の補償の操作が完了していない間は消さない（undo_records が補償の操作を参照する。ADR 0040）。
  const compensationOpen = db
    .prepare(
      `SELECT 1 FROM undo_records u
         LEFT JOIN operations c ON c.operation_id = u.compensation_operation_id
        WHERE u.operation_id = ? AND (c.state IS NULL OR c.state NOT IN ${COMPLETED_SQL})`,
    )
    .get(operationId);
  if (compensationOpen !== undefined)
    throw new RetentionRejection(['compensation_open']);
  for (const step of OPERATION_PURGE_STEPS)
    for (const statement of step.statements)
      db.prepare(statement).run({ id: operationId });
  return { operation_id: operationId, purged: true };
}

function stageContent(
  db: SqliteDatabase,
  op: Extract<RetentionOp, { kind: 'task.stage_content' }>,
): { readonly task_id: string; readonly blob_id: string } {
  const task = db
    .prepare('SELECT content_blob_id FROM tasks WHERE task_id = ?')
    .get(op.task_id) as { content_blob_id: string | null } | undefined;
  if (task === undefined) throw new RetentionRejection(['task_not_found']);
  if (task.content_blob_id !== null)
    throw new RetentionRejection(['task_content_already_linked']);
  if (stagedBlob(db, op.task_id) !== undefined)
    throw new RetentionRejection(['task_content_already_staged']);
  insertTaskContent(db, { now: op.now }, op.task_id, op.content);
  return { task_id: op.task_id, blob_id: op.content.blob_id };
}

function linkContent(
  db: SqliteDatabase,
  op: Extract<RetentionOp, { kind: 'task.link_content' }>,
): { readonly task_id: string; readonly blob_id: string } {
  const staged = stagedBlob(db, op.task_id);
  if (staged === undefined || staged.blob_id !== op.blob_id)
    throw new RetentionRejection(['task_content_not_staged']);
  // 所有者・用途の照合は 0011 の trigger（tasks_content_owner_update）も行う。
  const updated = db
    .prepare(
      'UPDATE tasks SET content_blob_id = ? WHERE task_id = ? AND content_blob_id IS NULL',
    )
    .run(op.blob_id, op.task_id);
  if (updated.changes !== 1)
    throw new RetentionRejection(['task_content_already_linked']);
  return { task_id: op.task_id, blob_id: op.blob_id };
}

function discardStaged(
  db: SqliteDatabase,
  op: Extract<RetentionOp, { kind: 'task.discard_staged' }>,
): { readonly task_id: string; readonly blob_id: string } {
  const removed = db
    .prepare(
      `DELETE FROM sealed_blobs WHERE blob_id = ? AND owner_table = 'tasks' AND owner_id = ? AND owner_version = 0
          AND purpose = 'task_content' AND NOT EXISTS (SELECT 1 FROM tasks WHERE content_blob_id = ?)`,
    )
    .run(op.blob_id, op.task_id, op.blob_id);
  if (removed.changes !== 1)
    throw new RetentionRejection(['task_content_not_staged']);
  return { task_id: op.task_id, blob_id: op.blob_id };
}

// 期限の来た操作（完了の古い順）。本文の削除は本文の残る操作だけ、90 日の削除は行の残る操作だけ。
function dueOperations(
  db: SqliteDatabase,
  kind: 'body' | 'receipt',
  now: number,
  limit: number,
  after: OperationCursor | null,
): OperationCursor[] {
  const ttl = kind === 'body' ? BODY_TTL_MS : RECEIPT_TTL_MS;
  const bodyFilter =
    kind === 'body'
      ? 'AND EXISTS (SELECT 1 FROM operation_versions v WHERE v.operation_id = o.operation_id AND v.intent_blob_id IS NOT NULL)'
      : '';
  return db
    .prepare(
      `SELECT o.completed_at, o.operation_id FROM operations o
        WHERE o.state IN ${COMPLETED_SQL} AND o.completed_at IS NOT NULL AND o.completed_at + ? <= ?
          ${bodyFilter}
          AND (? IS NULL OR (o.completed_at, o.operation_id) > (?, ?))
        ORDER BY o.completed_at, o.operation_id LIMIT ?`,
    )
    .all(
      ttl,
      now,
      after === null ? null : 1,
      after?.completed_at ?? null,
      after?.operation_id ?? null,
      limit,
    ) as OperationCursor[];
}

// --- 掃除の計画の入力（B06-06d1） ---

interface OperationSweepSqlRow {
  operation_id: string;
  state: string;
  completed_at: number | null;
  body_erased: number;
  compensation_open: number;
}

interface BudgetReservationSqlRow {
  reservation_id: string;
  status: 'reserved' | 'usage_unknown' | 'settled' | 'released';
  actual_gross: bigint | null;
  max_liability: bigint;
  overrun_reviewed: bigint;
}

interface BudgetApprovalSqlRow {
  approval_id: string;
  consumed_reservation_id: string | null;
  status: string;
  expires_at: bigint;
}

// domain の sweepPlan へ渡す行。操作は J5 の 7 日・90 日、予算は月ごとの削除の対象になる。
// 時刻は domain の読み取り（UTC の RFC 3339）に合わせて ISO にする。
export function readSweepRows(
  db: SqliteDatabase,
  now: number,
): readonly SweepRow[] {
  const operations = db
    .prepare(
      `SELECT o.operation_id, o.state, o.completed_at,
              (NOT EXISTS (
                SELECT 1 FROM operation_versions v
                 WHERE v.operation_id = o.operation_id AND v.intent_blob_id IS NOT NULL)) AS body_erased,
              (EXISTS (
                SELECT 1 FROM undo_records u
                  LEFT JOIN operations c ON c.operation_id = u.compensation_operation_id
                 WHERE u.operation_id = o.operation_id
                   AND (c.operation_id IS NULL OR c.state NOT IN ${COMPLETED_SQL}))) AS compensation_open
         FROM operations o
        ORDER BY o.operation_id`,
    )
    .all() as OperationSweepSqlRow[];
  const rows: SweepRow[] = operations.map((row): SweepOperationRow => ({
    family: 'operation',
    id: row.operation_id,
    operation_state: row.state as SweepOperationRow['operation_state'],
    // 読めない（範囲外の）時刻は null にして、計画に hold（deadline_unreadable）させる。1 行の異常で掃除全体を止めない。
    completed_at: isoOrNull(row.completed_at),
    body_erased: row.body_erased === 1,
    compensation_open: row.compensation_open === 1,
    // 0011 の後は、生きている用事が操作の暗号文・行を参照しない（ADR 0051）。
    task_depends: false,
    body_delete_at: null,
    row_delete_at: null,
  }));

  const months = db
    .prepare('SELECT month, time_zone FROM budget_months ORDER BY month')
    .all() as { month: string; time_zone: string }[];
  const reservationsOf = db.prepare(
    'SELECT reservation_id, status, actual_gross, max_liability, overrun_reviewed FROM budget_reservations WHERE budget_month = ? ORDER BY reservation_id',
  );
  const approvalsOf = db.prepare(
    'SELECT approval_id, consumed_reservation_id, status, expires_at FROM budget_overage_approvals WHERE budget_month = ? ORDER BY approval_id',
  );
  const liveSessionsOf = db.prepare(
    'SELECT live_session_id FROM live_sessions WHERE reservation_id = ? ORDER BY live_session_id',
  );
  for (const month of months) {
    const reservations = reservationsOf
      .safeIntegers(true)
      .all(month.month) as BudgetReservationSqlRow[];
    const approvals = approvalsOf
      .safeIntegers(true)
      .all(month.month) as BudgetApprovalSqlRow[];
    rows.push({
      family: 'budget_month',
      budget_month: month.month,
      time_zone: month.time_zone,
      reservations: reservations.map((reservation): BudgetReservationRow => ({
        reservation_id: reservation.reservation_id,
        status: reservation.status,
        actual_gross:
          reservation.actual_gross === null
            ? null
            : reservation.actual_gross.toString(),
        max_liability: reservation.max_liability.toString(),
        overrun_reviewed: reservation.overrun_reviewed === 1n,
        live_session_ids: (
          liveSessionsOf.pluck().all(reservation.reservation_id) as string[]
        ).slice(),
        approval_ids: approvals
          .filter(
            (approval) =>
              approval.consumed_reservation_id === reservation.reservation_id,
          )
          .map((approval) => approval.approval_id),
      })),
      unused_approval_ids: approvals
        .filter(
          (approval) =>
            approval.consumed_reservation_id === null &&
            (approval.status === 'pending' ||
              approval.status === 'rejected' ||
              approval.status === 'expired') &&
            approval.expires_at <= BigInt(now),
        )
        .map((approval) => approval.approval_id),
    });
  }
  return rows;
}

// 取り消しの期限（30 日、undo_window）を過ぎた記録を消す。補償の操作がまだ終わっていない記録は残す
// （補償のために undo_records の参照が要る。ADR 0040）。0001 の表は compensation_operation_id が NOT NULL なので、
// 「補償のない（NULL の）記録」はこの版では作れない（ADR 0053 に記録）。NULL の条件は将来の表でも同じ意味になるよう残す。
export function purgeUndoRecords(
  db: SqliteDatabase,
  now: number,
): UndoPurgeValue {
  const removed = db
    .prepare(
      `DELETE FROM undo_records
        WHERE requested_at + ? <= ?
          AND (compensation_operation_id IS NULL
            OR EXISTS (
              SELECT 1 FROM operations c
               WHERE c.operation_id = undo_records.compensation_operation_id
                 AND c.state IN ${COMPLETED_SQL}))`,
    )
    .run(UNDO_TTL_MS, now);
  return { purged: removed.changes };
}

function isoOrNull(millis: number | null): string | null {
  if (millis === null) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString().replace('.000Z', 'Z');
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): RetentionOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

class BatchStop extends Error {
  readonly result: RetentionStoreResult;
  constructor(result: RetentionStoreResult) {
    super('batch stopped');
    this.name = 'BatchStop';
    this.result = result;
  }
}

// 1 つの transaction の失敗を、命令の結果へ写す（ほかの store と同じ分け方）。
function failure(error: unknown): RetentionStoreResult {
  if (error instanceof RetentionRejection)
    return { result: rejected(error.reasons), halt: false };
  if (error instanceof Error && error.name === 'CommitUncertain')
    return {
      result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
      halt: true,
    };
  const code = sqliteCode(error);
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return { result: rejected(['database_busy']), halt: false };
  if (code?.startsWith('SQLITE_CONSTRAINT')) {
    // trigger の理由（RAISE の文）はコードの形なので理由に写す。それ以外の制約違反は名前だけ。
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

function runBatch(
  db: SqliteDatabase,
  op: Extract<
    RetentionOp,
    { kind: 'retention.erase_due_bodies' | 'retention.purge_due_operations' }
  >,
  beforeCommit: (() => void) | undefined,
): RetentionBatchValue {
  const body = op.kind === 'retention.erase_due_bodies';
  const due = dueOperations(
    db,
    body ? 'body' : 'receipt',
    op.now,
    op.limit,
    op.after,
  );
  const processed: string[] = [];
  const skipped: { operation_id: string; reasons: readonly string[] }[] = [];
  for (const item of due) {
    try {
      runImmediate(
        db,
        () =>
          body
            ? eraseOperationBody(db, item.operation_id, op.now)
            : purgeOperation(db, item.operation_id, op.now),
        beforeCommit,
      );
      processed.push(item.operation_id);
    } catch (error) {
      const result = failure(error);
      // 拒否（補償が終わっていない・移行前の用事など）は飛ばして続ける。成否不明・想定外の失敗では止める。
      if (result.halt || result.result.ok) throw new BatchStop(result);
      const reasons = result.result.reasons;
      if (reasons.includes('database_busy')) throw new BatchStop(result);
      skipped.push({ operation_id: item.operation_id, reasons });
    }
  }
  const last = due.at(-1);
  return {
    processed,
    skipped,
    next: due.length < op.limit || last === undefined ? null : last,
  };
}

function applyWrite(db: SqliteDatabase, op: RetentionOp): RetentionOpValue {
  switch (op.kind) {
    case 'retention.erase_body':
      return eraseOperationBody(db, op.operation_id, op.now);
    case 'retention.purge_operation':
      return purgeOperation(db, op.operation_id, op.now);
    case 'retention.purge_undo_records':
      return purgeUndoRecords(db, op.now);
    case 'task.stage_content':
      return stageContent(db, op);
    case 'task.link_content':
      return linkContent(db, op);
    case 'task.discard_staged':
      return discardStaged(db, op);
    default:
      throw new RetentionRejection(['kind_invalid']);
  }
}

function readOnly(db: SqliteDatabase, op: RetentionOp): RetentionOpValue {
  switch (op.kind) {
    case 'retention.gate':
      return { tasks_pending: tasksPending(db) };
    case 'retention.sweep_rows':
      return { rows: readSweepRows(db, op.now) };
    case 'task.read':
      return readTaskContent(db, op.task_id);
    case 'task.migration_next':
      return db.transaction(() =>
        readTaskMigrationBatch(db, op.limit, op.after),
      )();
    default:
      throw new RetentionRejection(['kind_invalid']);
  }
}

export interface RetentionContext {
  readonly platform: StoragePlatform;
  readonly halted: boolean;
  // 故障注入の試験用。各 transaction の本体の後・COMMIT の前に呼ぶ。
  readonly beforeCommit?: (op: RetentionOp) => void;
}

// 保存期限の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeRetentionOp(
  db: SqliteDatabase,
  op: RetentionOp,
  context: RetentionContext,
): RetentionStoreResult {
  const shape = retentionOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (!RETENTION_WRITE_OPS.has(op.kind)) {
    try {
      return { result: { ok: true, value: readOnly(db, op) }, halt: false };
    } catch (error) {
      if (error instanceof RetentionRejection)
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
  // checkpoint と VACUUM は transaction の外で実行する（VACUUM は transaction の中で実行できない。ADR 0016）。
  // 削除の後の後始末なので、書込みを止めた worker では実行しない。
  if (op.kind === 'retention.checkpoint' || op.kind === 'retention.vacuum') {
    try {
      if (op.kind === 'retention.vacuum') {
        db.exec('VACUUM');
        return { result: { ok: true, value: { vacuumed: true } }, halt: false };
      }
      const rows = db.pragma('wal_checkpoint(TRUNCATE)') as {
        busy: number;
        log: number;
        checkpointed: number;
      }[];
      const row = rows[0];
      return {
        result: {
          ok: true,
          value: {
            busy: row?.busy ?? 0,
            log_frames: row?.log ?? 0,
            checkpointed_frames: row?.checkpointed ?? 0,
          },
        },
        halt: false,
      };
    } catch (error) {
      // ディスクの空きが足りない（SQLITE_FULL）のは、一時領域を要する VACUUM とログの切り詰めで起こりうる。どちらも
      // 1 つの transaction の外にあり、VACUUM は失敗しても元の DB が残るので、書込みを止める（halt）理由にしない
      // （ADR 0053。承認・保存・予算の書込みまで止めない）。成否不明（CommitUncertain）・I/O の失敗は failure() のまま止める。
      if (sqliteCode(error) === 'SQLITE_FULL')
        return { result: rejected(['database_full']), halt: false };
      return failure(error);
    }
  }
  if (
    op.kind === 'retention.erase_due_bodies' ||
    op.kind === 'retention.purge_due_operations'
  ) {
    try {
      return {
        result: { ok: true, value: runBatch(db, op, beforeCommit) },
        halt: false,
      };
    } catch (error) {
      if (error instanceof BatchStop) return error.result;
      return failure(error);
    }
  }
  try {
    const run = runImmediate(db, () => applyWrite(db, op), beforeCommit);
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    return failure(error);
  }
}
