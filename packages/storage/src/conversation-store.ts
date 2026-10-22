// 会話・発言・依頼（workflow）・入力スナップショットの保存（設計 03 sessions / turns・InputSnapshot、07 §2・§3、
// 10 §5A、ADR 0029）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、端末の要求の受付
// （command_receipts）を同じ transaction で書く。同じ接続範囲・request_id・同じ要求の照合値の再送は保存済みの
// 結果を返し、照合値が違えば request_conflict（Core が 409 にする）。
// - 発言の本文は Core が暗号化した sealed_blobs の行（purpose: turn_text）として受け取り、平文を受け取らない。
// - 記録しない会話（private）は保存しない（0001 の CHECK）。Core が受け付けない。
// - 入力は文字入力（typed・submitted_text・sealed）だけ。端末内の音声認識（local_asr）は B06。
// 結果の理由にはコードだけを入れ、SQL・本文・hash の値を入れない。

import Database from 'better-sqlite3';
import { RETENTION_RULES } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { isRevision } from './operation-commands.js';
import type { SealedBlobInput } from './operation-commands.js';
import { runImmediate } from './operation-store.js';

const RECEIPT_TTL_MS = RETENTION_RULES['command_receipt']?.ms ?? 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;

export type WorkflowState = 'clarifying' | 'ready' | 'done';

// 端末の要求の受付（07 §3）。command_id は Core が接続範囲と request_id から決める値。
export interface ConversationRequestRef {
  readonly command_scope_id: string;
  readonly request_id: string;
  readonly request_hash: string;
  readonly command_id: string;
}

export interface SessionRecord {
  readonly session_id: string;
  readonly storage_mode: 'normal' | 'extended';
  readonly display_device_id: string | null;
  readonly route_revision: string;
  readonly created_at: number;
  readonly ended_at: number | null;
}

export interface TurnRecordValue {
  readonly turn_id: string;
  readonly input_id: string;
  readonly workflow_id: string | null;
  readonly forgetting_generation: string;
  readonly replayed: boolean;
}

export interface OperationIntentBlob {
  readonly operation_id: string;
  readonly content_version: string;
  readonly content_hash: string;
  readonly format_version: number;
  readonly key_id: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

export type ConversationOp =
  | {
      readonly kind: 'session.create';
      readonly session_id: string;
      readonly storage_mode: 'normal' | 'extended';
      readonly display_device_id: string;
      readonly created_at: number;
      readonly request: ConversationRequestRef;
    }
  | { readonly kind: 'session.get'; readonly session_id: string }
  // 発言・入力スナップショット・（あれば）依頼を一つの transaction で書く。
  | {
      readonly kind: 'turn.record';
      readonly session_id: string;
      readonly turn_id: string;
      readonly input_id: string;
      readonly text: SealedBlobInput;
      readonly created_at: number;
      readonly expires_at: number;
      readonly workflow: {
        readonly workflow_id: string;
        readonly state: WorkflowState;
      } | null;
      // 入力の時点の許可の版（意味検証で provider から読んだ値）。
      readonly permission_revision: string;
      readonly request: ConversationRequestRef;
    }
  // 依頼から作った操作（再送の後の再開に使う）。
  | { readonly kind: 'workflow.operation'; readonly workflow_id: string }
  // 操作の内容版の確定 intent の暗号文と hash（preview の発行に使う）。
  | {
      readonly kind: 'operation.intent';
      readonly operation_id: string;
      readonly content_version: string;
    };

export type ConversationOpKind = ConversationOp['kind'];

export type ConversationOpValue =
  | SessionRecord
  | TurnRecordValue
  | OperationIntentBlob
  | { readonly operation_id: string | null }
  | null;

export type ConversationOpResult =
  | { readonly ok: true; readonly value: ConversationOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface ConversationStoreResult {
  readonly result: ConversationOpResult;
  readonly halt: boolean;
}

export const CONVERSATION_WRITE_OPS: ReadonlySet<ConversationOpKind> = new Set([
  'session.create',
  'turn.record',
]);

class ConversationRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'ConversationRejection';
    this.reasons = reasons;
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
const isBytes = (value: unknown, length?: number): boolean =>
  value instanceof Uint8Array &&
  value.length > 0 &&
  (length === undefined || value.length === length);

function requestReasons(request: ConversationRequestRef | undefined): string[] {
  if (
    typeof request !== 'object' ||
    request === null ||
    !isUuid(request.command_scope_id) ||
    !isUuid(request.request_id) ||
    !isUuid(request.command_id) ||
    typeof request.request_hash !== 'string' ||
    !HASH.test(request.request_hash)
  )
    return ['request_invalid'];
  return [];
}

// 形の検査。structured clone を通った値を信用せず、DB に書く前に確かめる。
export function conversationOpShapeReasons(op: ConversationOp): string[] {
  const reasons: string[] = [];
  switch (op.kind) {
    case 'session.create':
      if (!isUuid(op.session_id)) reasons.push('session_id_invalid');
      if (!['normal', 'extended'].includes(op.storage_mode))
        reasons.push('storage_mode_invalid');
      if (!isUuid(op.display_device_id)) reasons.push('device_id_invalid');
      if (!isTime(op.created_at)) reasons.push('created_at_invalid');
      reasons.push(...requestReasons(op.request));
      break;
    case 'session.get':
      if (!isUuid(op.session_id)) reasons.push('session_id_invalid');
      break;
    case 'turn.record': {
      if (!isUuid(op.session_id)) reasons.push('session_id_invalid');
      if (!isUuid(op.turn_id)) reasons.push('turn_id_invalid');
      if (!isUuid(op.input_id)) reasons.push('input_id_invalid');
      if (!isTime(op.created_at)) reasons.push('created_at_invalid');
      if (!isTime(op.expires_at) || op.expires_at <= op.created_at)
        reasons.push('expires_at_invalid');
      if (!isRevision(op.permission_revision))
        reasons.push('permission_revision_invalid');
      const text = op.text as SealedBlobInput | null | undefined;
      if (
        typeof text !== 'object' ||
        text === null ||
        !isUuid(text.blob_id) ||
        !Number.isSafeInteger(text.format_version) ||
        text.format_version < 1 ||
        typeof text.key_id !== 'string' ||
        text.key_id.length === 0 ||
        !isBytes(text.nonce, 12) ||
        !isBytes(text.ciphertext) ||
        !isBytes(text.tag, 16)
      )
        reasons.push('text_invalid');
      const workflow = op.workflow;
      if (
        workflow !== null &&
        (typeof workflow !== 'object' ||
          !isUuid(workflow.workflow_id) ||
          !['clarifying', 'ready', 'done'].includes(workflow.state))
      )
        reasons.push('workflow_invalid');
      reasons.push(...requestReasons(op.request));
      break;
    }
    case 'workflow.operation':
      if (!isUuid(op.workflow_id)) reasons.push('workflow_id_invalid');
      break;
    case 'operation.intent':
      if (!isUuid(op.operation_id)) reasons.push('operation_id_invalid');
      if (!isRevision(op.content_version) || op.content_version === '0')
        reasons.push('content_version_invalid');
      break;
    default:
      reasons.push('kind_invalid');
  }
  return reasons;
}

interface SessionRow {
  session_id: string;
  storage_mode: 'normal' | 'extended';
  display_device_id: string | null;
  route_revision: number;
  created_at: number;
  ended_at: number | null;
}

interface ReceiptRow {
  command_scope_id: string;
  request_id: string;
  request_hash: string;
  command_id: string;
  target_id: string;
}

function readSession(
  db: SqliteDatabase,
  sessionId: string,
): SessionRecord | null {
  const row = db
    .prepare(
      'SELECT session_id, storage_mode, display_device_id, route_revision, created_at, ended_at FROM sessions WHERE session_id = ?',
    )
    .get(sessionId) as SessionRow | undefined;
  if (row === undefined) return null;
  return { ...row, route_revision: String(row.route_revision) };
}

function forgettingGeneration(db: SqliteDatabase): number {
  const row = db
    .prepare(
      'SELECT coalesce(max(forgetting_generation), 0) AS value FROM forget_ledger',
    )
    .get() as { value: number };
  return row.value;
}

// 同じ接続範囲・request_id の受付があれば、その対象 ID を返す（照合値・命令 ID が違えば request_conflict）。
// 同じ command_id が別の要求に使われていても request_conflict。
function findReceipt(
  db: SqliteDatabase,
  request: ConversationRequestRef,
): string | null {
  const byRequest = db
    .prepare(
      'SELECT command_scope_id, request_id, request_hash, command_id, target_id FROM command_receipts WHERE command_scope_id = ? AND request_id = ?',
    )
    .get(request.command_scope_id, request.request_id) as
    ReceiptRow | undefined;
  if (byRequest !== undefined) {
    if (
      byRequest.request_hash !== request.request_hash ||
      byRequest.command_id !== request.command_id
    )
      throw new ConversationRejection(['request_conflict']);
    return byRequest.target_id;
  }
  const byCommand = db
    .prepare('SELECT 1 FROM command_receipts WHERE command_id = ?')
    .get(request.command_id);
  if (byCommand !== undefined)
    throw new ConversationRejection(['request_conflict']);
  return null;
}

function writeReceipt(
  db: SqliteDatabase,
  request: ConversationRequestRef,
  targetId: string,
  committed: number,
  now: number,
): void {
  db.prepare(
    "INSERT INTO command_receipts (command_scope_id, request_id, request_hash, command_id, target_id, status, committed_state_revision, created_at, delete_at) VALUES (?, ?, ?, ?, ?, 'durable', ?, ?, ?)",
  ).run(
    request.command_scope_id,
    request.request_id,
    request.request_hash,
    request.command_id,
    targetId,
    committed,
    now,
    now + RECEIPT_TTL_MS,
  );
}

function storedTurn(
  db: SqliteDatabase,
  turnId: string,
): TurnRecordValue | null {
  const row = db
    .prepare(
      'SELECT input_id, workflow_id, forgetting_generation FROM input_snapshots WHERE turn_id = ? AND request_revision = 1',
    )
    .get(turnId) as
    | {
        input_id: string;
        workflow_id: string | null;
        forgetting_generation: number;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    turn_id: turnId,
    input_id: row.input_id,
    workflow_id: row.workflow_id,
    forgetting_generation: String(row.forgetting_generation),
    replayed: true,
  };
}

function applyWrite(
  db: SqliteDatabase,
  op: Extract<ConversationOp, { kind: 'session.create' | 'turn.record' }>,
): ConversationOpValue {
  if (op.kind === 'session.create') {
    const stored = findReceipt(db, op.request);
    if (stored !== null) {
      const session = readSession(db, stored);
      if (session === null)
        throw new ConversationRejection(['request_conflict']);
      return session;
    }
    const device = db
      .prepare('SELECT revoked_at FROM devices WHERE device_id = ?')
      .get(op.display_device_id) as { revoked_at: number | null } | undefined;
    if (device === undefined || device.revoked_at !== null)
      throw new ConversationRejection(['device_not_active']);
    db.prepare(
      'INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, ?, ?, 0, NULL, ?, NULL)',
    ).run(op.session_id, op.storage_mode, op.display_device_id, op.created_at);
    writeReceipt(db, op.request, op.session_id, 0, op.created_at);
    const session = readSession(db, op.session_id);
    if (session === null) throw new ConversationRejection(['session_missing']);
    return session;
  }
  const stored = findReceipt(db, op.request);
  if (stored !== null) {
    const turn = storedTurn(db, stored);
    if (turn === null) throw new ConversationRejection(['request_conflict']);
    return turn;
  }
  const session = readSession(db, op.session_id);
  if (session === null || session.ended_at !== null)
    throw new ConversationRejection(['session_not_found']);
  const text = op.text;
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'turn_text', 'turns', ?, 0, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    text.blob_id,
    op.turn_id,
    text.format_version,
    text.key_id,
    Buffer.from(text.nonce),
    Buffer.from(text.ciphertext),
    Buffer.from(text.tag),
    op.created_at,
    op.expires_at,
  );
  db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, ?, ?)",
  ).run(op.turn_id, op.session_id, text.blob_id, op.created_at, op.expires_at);
  if (op.workflow !== null)
    db.prepare(
      'INSERT INTO workflows (workflow_id, session_id, current_request_revision, state, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run(
      op.workflow.workflow_id,
      op.session_id,
      op.workflow.state,
      op.created_at,
    );
  const forgetting = forgettingGeneration(db);
  db.prepare(
    "INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch) VALUES (?, 1, ?, ?, 'typed', 'sealed', 'submitted_text', 'submitted_text', NULL, ?, ?, NULL)",
  ).run(
    op.input_id,
    op.workflow?.workflow_id ?? null,
    op.turn_id,
    Number(op.permission_revision),
    forgetting,
  );
  writeReceipt(db, op.request, op.turn_id, 1, op.created_at);
  return {
    turn_id: op.turn_id,
    input_id: op.input_id,
    workflow_id: op.workflow?.workflow_id ?? null,
    forgetting_generation: String(forgetting),
    replayed: false,
  };
}

function readIntent(
  db: SqliteDatabase,
  operationId: string,
  contentVersion: string,
): OperationIntentBlob | null {
  const row = db
    .prepare(
      `SELECT v.content_hash, b.format_version, b.key_id, b.nonce, b.ciphertext, b.tag
         FROM operation_versions v JOIN sealed_blobs b ON b.blob_id = v.intent_blob_id
        WHERE v.operation_id = ? AND v.content_version = ?`,
    )
    .get(operationId, Number(contentVersion)) as
    | {
        content_hash: string;
        format_version: number;
        key_id: string;
        nonce: Buffer;
        ciphertext: Buffer;
        tag: Buffer;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    operation_id: operationId,
    content_version: contentVersion,
    content_hash: row.content_hash,
    format_version: row.format_version,
    key_id: row.key_id,
    nonce: new Uint8Array(row.nonce),
    ciphertext: new Uint8Array(row.ciphertext),
    tag: new Uint8Array(row.tag),
  };
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): ConversationOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

// 会話の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeConversationOp(
  db: SqliteDatabase,
  op: ConversationOp,
  context: { readonly platform: StoragePlatform; readonly halted: boolean },
): ConversationStoreResult {
  const shape = conversationOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'session.get')
    return {
      result: { ok: true, value: readSession(db, op.session_id) },
      halt: false,
    };
  if (op.kind === 'workflow.operation') {
    const row = db
      .prepare(
        'SELECT operation_id FROM operations WHERE workflow_id = ? ORDER BY created_at, operation_id LIMIT 1',
      )
      .get(op.workflow_id) as { operation_id: string } | undefined;
    return {
      result: { ok: true, value: { operation_id: row?.operation_id ?? null } },
      halt: false,
    };
  }
  if (op.kind === 'operation.intent')
    return {
      result: {
        ok: true,
        value: readIntent(db, op.operation_id, op.content_version),
      },
      halt: false,
    };
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
    const run = runImmediate(db, () => applyWrite(db, op));
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof ConversationRejection)
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
