// 会話・発言・依頼（workflow）・入力スナップショットの保存（設計 03 sessions / turns・InputSnapshot、07 §2・§3、
// 10 §5A、ADR 0029）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、端末の要求の受付
// （command_receipts）を同じ transaction で書く。同じ接続範囲・request_id・同じ要求の照合値の再送は保存済みの
// 結果を返し、照合値が違えば request_conflict（Core が 409 にする）。
// - 発言の本文は Core が暗号化した sealed_blobs の行（purpose: turn_text）として受け取り、平文を受け取らない。
// - 記録しない会話（private）は保存しない（0001 の CHECK）。Core が受け付けない。
// - 入力は文字入力（typed・submitted_text・sealed）が既定。Live の文字起こし（B05-05、ADR 0052）は input で明示し、
//   方式 C の暫定入力（live_fragment・live_transcript_policy・live_policy_observed）か、確定できなかった入力
//   （blocked・unverified。変更を作らない）として書く。端末内の音声認識（local_asr）は B06。
// - 発言から作る操作（承認待ち）は、発言・依頼と同じ transaction で作る（同じ要求の同時の再送で二つ作らない）。
// - 応答（turn_responses、0004）も同じ transaction で書き、再送には解釈し直さずにその応答を返す。
// 結果の理由にはコードだけを入れ、SQL・本文・hash の値を入れない。

import Database from 'better-sqlite3';
import { RETENTION_RULES } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { isRevision } from './operation-commands.js';
import type { SealedBlobInput } from './operation-commands.js';
import { appendEvent, insertVersion, runImmediate } from './operation-store.js';

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

// 発言の入力の記録（InputSnapshot の入力側）。省略は文字入力。voice_live は Live の文字起こしで、
// sealed は方式 C の暫定入力（policy_version が必須）、partial は確定前の入力から答えた参照だけ（操作を作らない）、
// blocked は欠落などで確定できなかった入力（依頼・操作を作らない）。
export type TurnInputRecord =
  | { readonly kind: 'text' }
  | {
      readonly kind: 'voice_live';
      readonly audio_epoch: string;
      readonly outcome:
        | { readonly state: 'sealed'; readonly policy_version: string }
        // 確定していない入力から答えた参照（変更・操作は作らない）。
        | { readonly state: 'partial' }
        | { readonly state: 'blocked' };
    };

export interface TurnRecordValue {
  readonly turn_id: string;
  // 保存した応答（契約の TurnResponse の JSON）。再送では最初に保存した値。
  readonly response_json: string;
  readonly replayed: boolean;
}

// 発言から作る承認待ちの操作（operation.create と同じ行を、発言と同じ transaction で書く）。
// 自動承認はない（B04-03 の方針表はすべて off）。依頼は同じ transaction で作るので、依頼の版は 1。
export interface TurnOperationInput {
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly effect_route: 'local_command' | 'remote_mutation';
  readonly content_hash: string;
  readonly intent: SealedBlobInput;
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
      // 入力の種類と確定の記録。省略は文字入力。
      readonly input?: TurnInputRecord;
      // 発言から作る操作。依頼（ready）があるときだけ。
      readonly operation: TurnOperationInput | null;
      // 応答（契約の TurnResponse の JSON）。
      readonly response_json: string;
    }
  // 解釈の前の再送の判定。保存済みの発言があればその応答、なければ null（照合値の違いは request_conflict）。
  | { readonly kind: 'turn.find'; readonly request: ConversationRequestRef }
  // 操作の内容版の確定 intent の暗号文と hash（preview の発行に使う）。
  | {
      readonly kind: 'operation.intent';
      readonly operation_id: string;
      readonly content_version: string;
    };

export type ConversationOpKind = ConversationOp['kind'];

export type ConversationOpValue =
  SessionRecord | TurnRecordValue | OperationIntentBlob | null;

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

function isSealed(value: unknown): boolean {
  const blob = value as SealedBlobInput | null | undefined;
  return (
    typeof blob === 'object' &&
    blob !== null &&
    isUuid(blob.blob_id) &&
    Number.isSafeInteger(blob.format_version) &&
    blob.format_version >= 1 &&
    typeof blob.key_id === 'string' &&
    blob.key_id.length > 0 &&
    isBytes(blob.nonce, 12) &&
    isBytes(blob.ciphertext) &&
    isBytes(blob.tag, 16)
  );
}

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
      if (!isSealed(op.text)) reasons.push('text_invalid');
      const input = op.input;
      if (input !== undefined) {
        if (typeof input !== 'object' || input === null)
          reasons.push('input_invalid');
        else if (input.kind === 'voice_live') {
          const outcome = input.outcome;
          if (
            !isRevision(input.audio_epoch) ||
            typeof outcome !== 'object' ||
            outcome === null ||
            !['sealed', 'partial', 'blocked'].includes(outcome.state) ||
            (outcome.state === 'sealed' && !isRevision(outcome.policy_version))
          )
            reasons.push('input_invalid');
          // 確定できなかった入力（blocked）から依頼・操作を作らない。確定前の入力（partial）からは操作を作らない。
          else if (
            outcome.state === 'blocked' &&
            (op.workflow !== null || op.operation !== null)
          )
            reasons.push('blocked_input_with_workflow');
          else if (outcome.state === 'partial' && op.operation !== null)
            reasons.push('partial_input_with_operation');
        } else if (input.kind !== 'text') reasons.push('input_invalid');
      }
      const workflow = op.workflow;
      if (
        workflow !== null &&
        (typeof workflow !== 'object' ||
          !isUuid(workflow.workflow_id) ||
          !['clarifying', 'ready', 'done'].includes(workflow.state))
      )
        reasons.push('workflow_invalid');
      const operation = op.operation;
      if (operation !== null) {
        if (
          typeof operation !== 'object' ||
          !isUuid(operation.operation_id) ||
          typeof operation.operation_kind !== 'string' ||
          operation.operation_kind.length === 0 ||
          !['local_command', 'remote_mutation'].includes(
            operation.effect_route,
          ) ||
          typeof operation.content_hash !== 'string' ||
          !HASH.test(operation.content_hash) ||
          !isSealed(operation.intent)
        )
          reasons.push('operation_invalid');
        // 操作は依頼（ready）から作る。
        if (workflow === null || workflow.state !== 'ready')
          reasons.push('operation_without_workflow');
      }
      if (
        typeof op.response_json !== 'string' ||
        op.response_json.length === 0 ||
        op.response_json.length > 16_384
      )
        reasons.push('response_invalid');
      reasons.push(...requestReasons(op.request));
      break;
    }
    case 'turn.find':
      reasons.push(...requestReasons(op.request));
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
    .prepare('SELECT response_json FROM turn_responses WHERE turn_id = ?')
    .get(turnId) as { response_json: string } | undefined;
  if (row === undefined) return null;
  return { turn_id: turnId, response_json: row.response_json, replayed: true };
}

// 発言から作る承認待ちの操作（operation-store.ts の createOperation と同じ行。自動承認なし）。
function insertOperation(
  db: SqliteDatabase,
  context: ConversationContext,
  workflowId: string,
  operation: TurnOperationInput,
  now: number,
): void {
  const exists = db
    .prepare('SELECT 1 FROM operations WHERE operation_id = ?')
    .get(operation.operation_id);
  if (exists !== undefined)
    throw new ConversationRejection(['operation_exists']);
  db.prepare(
    "INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at) VALUES (?, ?, ?, ?, 1, 'awaiting_approval', 1, ?, NULL)",
  ).run(
    operation.operation_id,
    workflowId,
    operation.operation_kind,
    operation.effect_route,
    now,
  );
  const store = {
    now,
    platform: context.platform,
    storeGeneration: context.storeGeneration,
  };
  insertVersion(
    db,
    store,
    operation.operation_id,
    1,
    operation.content_hash,
    operation.intent,
  );
  appendEvent(db, store, operation.operation_id, 1);
}

function applyWrite(
  db: SqliteDatabase,
  op: Extract<ConversationOp, { kind: 'session.create' | 'turn.record' }>,
  context: ConversationContext,
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
  const input = op.input ?? { kind: 'text' as const };
  db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', ?, ?, ?, ?)",
  ).run(
    op.turn_id,
    op.session_id,
    input.kind === 'voice_live' ? 'voice_live' : 'text',
    text.blob_id,
    op.created_at,
    op.expires_at,
  );
  if (op.workflow !== null)
    db.prepare(
      'INSERT INTO workflows (workflow_id, session_id, current_request_revision, state, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run(
      op.workflow.workflow_id,
      op.session_id,
      op.workflow.state,
      op.created_at,
    );
  if (op.operation !== null && op.workflow !== null)
    insertOperation(
      db,
      context,
      op.workflow.workflow_id,
      op.operation,
      op.created_at,
    );
  const forgetting = forgettingGeneration(db);
  if (input.kind === 'voice_live') {
    const sealed = input.outcome.state === 'sealed';
    // 確定前（partial）は collecting、確定できなかった入力は blocked。どちらも証拠は unverified で、seal の理由を持たない。
    const state = sealed
      ? 'sealed'
      : input.outcome.state === 'partial'
        ? 'collecting'
        : 'blocked';
    db.prepare(
      "INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch) VALUES (?, 1, ?, ?, 'live_fragment', ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      op.input_id,
      op.workflow?.workflow_id ?? null,
      op.turn_id,
      state,
      sealed ? 'live_transcript_policy' : null,
      sealed ? 'live_policy_observed' : 'unverified',
      input.outcome.state === 'sealed'
        ? Number(input.outcome.policy_version)
        : null,
      Number(op.permission_revision),
      forgetting,
      Number(input.audio_epoch),
    );
  } else
    db.prepare(
      "INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch) VALUES (?, 1, ?, ?, 'typed', 'sealed', 'submitted_text', 'submitted_text', NULL, ?, ?, NULL)",
    ).run(
      op.input_id,
      op.workflow?.workflow_id ?? null,
      op.turn_id,
      Number(op.permission_revision),
      forgetting,
    );
  db.prepare(
    'INSERT INTO turn_responses (turn_id, response_json, created_at, delete_at) VALUES (?, ?, ?, ?)',
  ).run(op.turn_id, op.response_json, op.created_at, op.expires_at);
  writeReceipt(db, op.request, op.turn_id, 1, op.created_at);
  return {
    turn_id: op.turn_id,
    response_json: op.response_json,
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
export interface ConversationContext {
  readonly platform: StoragePlatform;
  readonly halted: boolean;
  // event_outbox の世代（発言から作る操作のイベント）。
  readonly storeGeneration: string;
}

export function executeConversationOp(
  db: SqliteDatabase,
  op: ConversationOp,
  context: ConversationContext,
): ConversationStoreResult {
  const shape = conversationOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'session.get')
    return {
      result: { ok: true, value: readSession(db, op.session_id) },
      halt: false,
    };
  if (op.kind === 'turn.find') {
    try {
      const stored = findReceipt(db, op.request);
      return {
        result: {
          ok: true,
          value: stored === null ? null : storedTurn(db, stored),
        },
        halt: false,
      };
    } catch (error) {
      if (error instanceof ConversationRejection)
        return { result: rejected(error.reasons), halt: false };
      throw error;
    }
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
    const run = runImmediate(db, () => applyWrite(db, op, context));
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
