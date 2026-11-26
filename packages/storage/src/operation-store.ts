// 操作・内容版・承認・試行・命令の受付・イベントの送出記録の保存（設計 08 §1〜§5、11 §9、07 §2・§3、ADR 0010・0018）。
//
// DB worker の中で実行する同期関数。1 命令を 1 つの短い BEGIN IMMEDIATE の transaction で処理し、
// 状態の更新・event_outbox・command_receipts を同じ transaction で書く。外部 HTTP は実行しない。
// 状態遷移は domain の OPERATION_TRANSITIONS、承認は approvalDecision、版の照合は commandGuard、
// 再要求は replayDecision と同じ結論にし、最終の保証は 0001 の一意制約・CHECK と transaction に置く。
//
// - transaction の本体は同期関数だけ（Promise を返したら巻き戻して拒否する）。
// - 本体の途中の失敗は巻き戻して rejected（適用していないことが確か）。
// - COMMIT の失敗は成否不明（unknown）として扱い、未 commit と決めつけない。以後の書込みを止める（halt）。
// - 命令ごとに transaction の前で接続の耐久設定を読み戻し、違えば記録せずに書込みを止める。

import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  RETENTION_RULES,
  approvalDecision,
  autoActionKindFor,
  autoCreationReasons,
  canTransition,
  commandGuard,
  planContentRevision,
  replayDecision,
} from '@buddy/domain';
import type {
  AutoActionKind,
  OperationRoute,
  OperationState,
} from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import {
  countPolicyAutoApproval,
  recordAutoAction,
  recordUndoOutcome,
  safetyStopped,
  startUndo,
  syncUndoForTransition,
} from './safety-store.js';
import type { UndoStatus } from './safety-store.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import {
  INTERNAL_COMMAND_SCOPE,
  commandShapeReasons,
} from './operation-commands.js';
import type {
  ApproveOperationCommand,
  CancelOperationCommand,
  CreateOperationCommand,
  DbCommand,
  DispatchIntentCommand,
  DispatchedAttempt,
  PrepareOperationCommand,
  RecordResultCommand,
  ResultState,
  RecoverAfterRestartCommand,
  ReviseContentCommand,
  ApplyLocalCommand,
  DeleteLocalCommand,
  SealedBlobInput,
  StoreOutcome,
} from './operation-commands.js';

const RECEIPT_TTL_MS = RETENTION_RULES['command_receipt']?.ms ?? 0;
const EVENT_TTL_MS = RETENTION_RULES['event_outbox']?.ms ?? 0;

// 完了した状態（J5 の本文の削除・90 日の削除の対象。unknown_held は完了ではない。ADR 0040）。
export const COMPLETED_OPERATION_STATES: readonly OperationState[] = [
  'succeeded',
  'not_executed',
  'cancelled',
  'superseded',
];
const COMPLETED_STATES = COMPLETED_OPERATION_STATES;

// 送出境界を越えて結果を待っている状態。取消は受け付けるが取消済みにしない（08 §3、X05）。
const AFTER_DISPATCH: readonly OperationState[] = [
  'dispatching',
  'reconciling',
  'unknown_held',
];

export interface StoreContext {
  // UTC の Unix ミリ秒。
  readonly now: number;
  readonly platform: StoragePlatform;
  readonly storeGeneration: string;
  // 故障注入の試験用。transaction の本体の後・COMMIT の前に呼ぶ。
  readonly beforeCommit?: (command: DbCommand) => void;
}

export interface StoreTimings {
  // BEGIN から COMMIT（または巻き戻し）の終わりまで。
  readonly transaction_ms: number;
  // COMMIT の実行時間（同期・fsync の待ちを含む）。コミットしなければ null。
  readonly commit_ms: number | null;
}

export interface StoreResult {
  readonly outcome: StoreOutcome;
  // 以後の書込みを止めるべき失敗（成否不明・想定外の失敗・耐久設定の不一致）。
  readonly halt: boolean;
  readonly timings: StoreTimings;
}

// 適用しない理由。transaction の本体で投げて巻き戻す。
class CommandRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'CommandRejection';
    this.reasons = reasons;
  }
}

class CommitUncertain extends Error {
  constructor(cause: unknown) {
    super('COMMIT が失敗しました。', { cause });
    this.name = 'CommitUncertain';
  }
}

function clock(): number {
  return performance.now();
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export interface TransactionRun<T> {
  readonly value: T;
  readonly timings: StoreTimings;
}

// 短い同期 transaction。本体が失敗すれば巻き戻して例外をそのまま投げ、COMMIT の失敗は
// CommitUncertain を投げる。better-sqlite3 の transaction wrapper は COMMIT の失敗と本体の失敗を
// 区別しにくいため、BEGIN IMMEDIATE・COMMIT・ROLLBACK を明示する。
export function runImmediate<T>(
  db: SqliteDatabase,
  body: () => T,
  beforeCommit?: () => void,
): TransactionRun<T> {
  if (db.inTransaction)
    throw new Error('transaction の中から transaction を始めません。');
  const started = clock();
  db.exec('BEGIN IMMEDIATE');
  let value: T;
  try {
    value = body();
    // transaction の本体を async 関数にしない（11 §9）。await の間に他の命令が割り込むため。
    if (isThenable(value))
      throw new Error('transaction の本体が Promise を返しました。');
    beforeCommit?.();
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
  const commitStarted = clock();
  try {
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 巻き戻しにも失敗した。成否不明として扱う。
      }
    }
    throw new CommitUncertain(error);
  }
  const ended = clock();
  return {
    value,
    timings: {
      transaction_ms: ended - started,
      commit_ms: ended - commitStarted,
    },
  };
}

// --- 値の変換 ---

function toInt(revision: string): number {
  return Number(revision);
}

function toText(value: number): string {
  return String(value);
}

function bytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

// 内部の命令の照合値。キーを並べ替えた JSON の SHA-256。バイト列は 16 進にする。
function stableJson(value: unknown): string {
  if (value instanceof Uint8Array)
    return JSON.stringify(`bytes:${bytes(value).toString('hex')}`);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function internalRequestHash(command: DbCommand): string {
  return createHash('sha256').update(stableJson(command), 'utf8').digest('hex');
}

// --- 読み取り ---

interface OperationRow {
  operation_id: string;
  workflow_id: string | null;
  kind: string;
  effect_route: OperationRoute;
  current_content_version: number;
  state: OperationState;
  state_revision: number;
  created_at: number;
  completed_at: number | null;
  // 忘却の送出禁止の印（0012。ADR 0044 の U61・ADR 0054）。印のある操作は承認・準備・送出・適用へ進めない。
  send_blocked_generation: number | null;
}

interface AttemptRow {
  attempt_id: string;
  operation_id: string;
  content_version: number;
  approval_id: string;
  status: string;
  dispatch_intent_at: number | null;
  external_id: string | null;
  result_status: string | null;
  created_at: number;
}

interface ApprovalRow {
  approval_id: string;
  operation_id: string;
  content_version: number;
  content_hash: string;
  route: string;
  policy_version: number | null;
  status: string;
  approved_at: number;
  // 候補を起点にした方針による自動承認の判定に使った版（0015、ADR 0148）。それ以外は NULL。
  candidate_id: string | null;
  request_entity_id: string | null;
  request_revision: number | null;
  related_group_id: string | null;
  analysis_revision: number | null;
  source_set_hash: string | null;
  published_generation: number | null;
}

interface ReceiptRow {
  command_scope_id: string;
  request_id: string;
  request_hash: string;
  command_id: string;
  target_id: string;
  status: 'accepted' | 'durable';
  committed_state_revision: number | null;
  created_at: number;
  delete_at: number;
}

export interface OperationRecord {
  readonly operation_id: string;
  readonly workflow_id: string | null;
  readonly kind: string;
  readonly effect_route: string;
  readonly state: OperationState;
  readonly state_revision: string;
  readonly current_content_version: string;
  readonly content_hash: string;
  // 今の内容版の本文を J5 で消したか（hash は残る）。
  readonly body_erased: boolean;
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly approvals: readonly {
    readonly approval_id: string;
    readonly content_version: string;
    readonly route: string;
    readonly status: string;
  }[];
  readonly attempts: readonly {
    readonly attempt_id: string;
    readonly content_version: string;
    readonly approval_id: string;
    readonly status: string;
    readonly dispatch_intent_at: number | null;
    readonly external_id: string | null;
    readonly result_status: string | null;
  }[];
}

export interface CommandReceiptRecord {
  readonly command_scope_id: string;
  readonly request_id: string;
  readonly request_hash: string;
  readonly command_id: string;
  readonly target_id: string;
  readonly status: 'accepted' | 'durable';
  readonly committed_state_revision: string | null;
  readonly created_at: number;
  readonly delete_at: number;
}

export interface OutboxEventRecord {
  readonly store_generation: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly target_id: string;
  readonly state_revision: string;
  readonly event_type: string;
  readonly occurred_at: number;
  readonly delete_at: number;
}

function operationRow(
  db: SqliteDatabase,
  id: string,
): OperationRow | undefined {
  return db
    .prepare('SELECT * FROM operations WHERE operation_id = ?')
    .get(id) as OperationRow | undefined;
}

function versionHash(
  db: SqliteDatabase,
  id: string,
  contentVersion: number,
): string | undefined {
  const row = db
    .prepare(
      'SELECT content_hash FROM operation_versions WHERE operation_id = ? AND content_version = ?',
    )
    .get(id, contentVersion) as { content_hash: string } | undefined;
  return row?.content_hash;
}

// 内容版の本文（確定 intent の暗号文）を J5 で消したか。消えた内容版からは承認・準備・送出・適用をしない（ADR 0051）。
function bodyErased(
  db: SqliteDatabase,
  id: string,
  contentVersion: number,
): boolean {
  const row = db
    .prepare(
      'SELECT intent_blob_id FROM operation_versions WHERE operation_id = ? AND content_version = ?',
    )
    .get(id, contentVersion) as { intent_blob_id: string | null } | undefined;
  return row !== undefined && row.intent_blob_id === null;
}

function effectiveApproval(
  db: SqliteDatabase,
  id: string,
  contentVersion: number,
): ApprovalRow | undefined {
  return db
    .prepare(
      "SELECT * FROM approvals WHERE operation_id = ? AND content_version = ? AND status IN ('valid', 'consumed')",
    )
    .get(id, contentVersion) as ApprovalRow | undefined;
}

function attemptRow(
  db: SqliteDatabase,
  attemptId: string,
): AttemptRow | undefined {
  return db
    .prepare('SELECT * FROM operation_attempts WHERE attempt_id = ?')
    .get(attemptId) as AttemptRow | undefined;
}

function receiptToRecord(row: ReceiptRow): CommandReceiptRecord {
  return {
    ...row,
    committed_state_revision:
      row.committed_state_revision === null
        ? null
        : toText(row.committed_state_revision),
  };
}

export function readOperation(
  db: SqliteDatabase,
  operationId: string,
): OperationRecord | null {
  const row = operationRow(db, operationId);
  if (row === undefined) return null;
  const approvals = db
    .prepare(
      'SELECT * FROM approvals WHERE operation_id = ? ORDER BY approved_at, approval_id',
    )
    .all(operationId) as ApprovalRow[];
  const attempts = db
    .prepare(
      'SELECT * FROM operation_attempts WHERE operation_id = ? ORDER BY created_at, rowid',
    )
    .all(operationId) as AttemptRow[];
  return {
    operation_id: row.operation_id,
    workflow_id: row.workflow_id,
    kind: row.kind,
    effect_route: row.effect_route,
    state: row.state,
    state_revision: toText(row.state_revision),
    current_content_version: toText(row.current_content_version),
    content_hash:
      versionHash(db, operationId, row.current_content_version) ?? '',
    body_erased: bodyErased(db, operationId, row.current_content_version),
    created_at: row.created_at,
    completed_at: row.completed_at,
    approvals: approvals.map((approval) => ({
      approval_id: approval.approval_id,
      content_version: toText(approval.content_version),
      route: approval.route,
      status: approval.status,
    })),
    attempts: attempts.map((attempt) => ({
      attempt_id: attempt.attempt_id,
      content_version: toText(attempt.content_version),
      approval_id: attempt.approval_id,
      status: attempt.status,
      dispatch_intent_at: attempt.dispatch_intent_at,
      external_id: attempt.external_id,
      result_status: attempt.result_status,
    })),
  };
}

export function readCommandReceipt(
  db: SqliteDatabase,
  commandId: string,
): CommandReceiptRecord | null {
  const row = db
    .prepare('SELECT * FROM command_receipts WHERE command_id = ?')
    .get(commandId) as ReceiptRow | undefined;
  return row === undefined ? null : receiptToRecord(row);
}

// 起動時に回復の対象になる操作（08 §4、ADR 0019・0030）。承認済みで実行の前（approved）、送出境界の手前
// （preparing）と、送出意図の記録の後（dispatching）。
export interface InterruptedOperation {
  readonly operation_id: string;
  readonly state: 'approved' | 'preparing' | 'dispatching';
  readonly state_revision: string;
  readonly current_content_version: string;
  // 操作と同じ状態の実行中の試行。見つからなければ null（0001 の制約上は起きない）。
  readonly attempt_id: string | null;
}

export function listInterruptedOperations(
  db: SqliteDatabase,
): InterruptedOperation[] {
  const rows = db
    .prepare(
      "SELECT o.operation_id, o.state, o.state_revision, o.current_content_version, a.attempt_id FROM operations o LEFT JOIN operation_attempts a ON a.operation_id = o.operation_id AND a.status = o.state WHERE o.state IN ('approved', 'preparing', 'dispatching') ORDER BY o.created_at, o.operation_id",
    )
    .all() as {
    operation_id: string;
    state: 'approved' | 'preparing' | 'dispatching';
    state_revision: number;
    current_content_version: number;
    attempt_id: string | null;
  }[];
  return rows.map((row) => ({
    operation_id: row.operation_id,
    state: row.state,
    state_revision: toText(row.state_revision),
    current_content_version: toText(row.current_content_version),
    attempt_id: row.attempt_id,
  }));
}

export function listOutboxEvents(
  db: SqliteDatabase,
  storeGeneration: string,
  afterSequence = 0,
  limit = 100,
): OutboxEventRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM event_outbox WHERE store_generation = ? AND sequence > ? ORDER BY sequence LIMIT ?',
    )
    .all(storeGeneration, afterSequence, limit) as (Omit<
    OutboxEventRecord,
    'state_revision'
  > & { state_revision: number })[];
  return rows.map((row) => ({
    ...row,
    state_revision: toText(row.state_revision),
  }));
}

// --- 現在値（commandGuard の DbCurrent） ---

interface CurrentVersions {
  readonly request_revision: string | null;
  readonly permission_revision: string;
  readonly forgetting_generation: string;
  readonly safety_stopped: boolean;
}

function currentVersions(
  db: SqliteDatabase,
  command: DbCommand,
  workflowId: string | null,
): CurrentVersions {
  let request: string | null = null;
  if (workflowId !== null) {
    const row = db
      .prepare(
        'SELECT current_request_revision AS value FROM workflows WHERE workflow_id = ?',
      )
      .get(workflowId) as { value: number } | undefined;
    if (row === undefined) throw new CommandRejection(['workflow_not_found']);
    request = toText(row.value);
  }
  // 許可の版は連携の接続の版と照合する。接続のない操作（LocalCommand）の許可の版は
  // 0001 に正本がないため DB では照合しない（ADR 0018 の読み取り）。
  let permission = command.permission_revision;
  if (command.connection_id !== null) {
    const row = db
      .prepare(
        'SELECT permission_revision AS value FROM connections WHERE connection_id = ?',
      )
      .get(command.connection_id) as { value: number } | undefined;
    if (row === undefined) throw new CommandRejection(['connection_not_found']);
    permission = toText(row.value);
  }
  const forgetting = db
    .prepare(
      'SELECT coalesce(max(forgetting_generation), 0) AS value FROM forget_ledger',
    )
    .get() as { value: number };
  const breaker = db
    .prepare('SELECT state FROM safety_breaker WHERE singleton = 1')
    .get() as { state: string } | undefined;
  return {
    request_revision: request,
    permission_revision: permission,
    forgetting_generation: toText(forgetting.value),
    safety_stopped: breaker?.state === 'stopped',
  };
}

function guard(
  db: SqliteDatabase,
  command: DbCommand,
  stateRevision: string,
  workflowId: string | null,
  external: { readonly reservationValid: boolean } | null,
): void {
  const current = currentVersions(db, command, workflowId);
  const decision = commandGuard(
    command,
    {
      ...current,
      state_revision: stateRevision,
      // 再到着は transaction の前に command_receipts で判定済み。
      applied_command_ids: [],
      reservation_valid: external?.reservationValid ?? true,
    },
    { external: external !== null },
  );
  if (decision.action !== 'apply') throw new CommandRejection(decision.reasons);
}

function requireStateRevision(
  command: DbCommand,
  operation: OperationRow,
): void {
  if (command.expected_state_revision !== toText(operation.state_revision))
    throw new CommandRejection(['state_revision_changed']);
}

function requireOperation(
  db: SqliteDatabase,
  command: DbCommand,
): OperationRow {
  const operation = operationRow(db, command.operation_id);
  if (operation === undefined)
    throw new CommandRejection(['operation_not_found']);
  return operation;
}

// --- 書込みの部品（同じ transaction の中で呼ぶ） ---

export function appendEvent(
  db: SqliteDatabase,
  context: StoreContext,
  operationId: string,
  stateRevision: number,
): void {
  const next = db
    .prepare(
      'SELECT coalesce(max(sequence), 0) + 1 AS value FROM event_outbox WHERE store_generation = ?',
    )
    .get(context.storeGeneration) as { value: number };
  db.prepare(
    "INSERT INTO event_outbox (store_generation, sequence, event_id, target_id, state_revision, event_type, occurred_at, delete_at) VALUES (?, ?, ?, ?, ?, 'operation.updated', ?, ?)",
  ).run(
    context.storeGeneration,
    next.value,
    randomUUID(),
    operationId,
    stateRevision,
    context.now,
    context.now + EVENT_TTL_MS,
  );
}

function requestRef(command: DbCommand): {
  readonly command_scope_id: string;
  readonly request_id: string;
  readonly request_hash: string;
} {
  return (
    command.request ?? {
      command_scope_id: INTERNAL_COMMAND_SCOPE,
      request_id: command.command_id,
      request_hash: internalRequestHash(command),
    }
  );
}

function writeReceipt(
  db: SqliteDatabase,
  context: StoreContext,
  command: DbCommand,
  committedStateRevision: number | null,
): void {
  const ref = requestRef(command);
  db.prepare(
    'INSERT INTO command_receipts (command_scope_id, request_id, request_hash, command_id, target_id, status, committed_state_revision, created_at, delete_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    ref.command_scope_id,
    ref.request_id,
    ref.request_hash,
    command.command_id,
    command.operation_id,
    committedStateRevision === null ? 'accepted' : 'durable',
    committedStateRevision,
    context.now,
    context.now + RECEIPT_TTL_MS,
  );
}

// 状態を一つ進め、イベントと受付を同じ transaction で書く。
function advance(
  db: SqliteDatabase,
  context: StoreContext,
  command: DbCommand,
  operation: OperationRow,
  to: OperationState,
): number {
  if (!canTransition(operation.state, to, operation.effect_route))
    throw new CommandRejection(['transition_not_allowed']);
  // 補償の操作なら、取り消しの記録を状態に合わせる（U313、ADR 0155）。
  if (
    syncUndoForTransition(db, operation.operation_id, operation.state, to) !==
    null
  )
    throw new CommandRejection(['retry_not_allowed']);
  const next = operation.state_revision + 1;
  // completed_at は今の完了の状態に入った時刻（J5 の本文 7 日・レシート 90 日の起点。ADR 0040・0051）。
  // 未実行の確定（not_executed）も完了に数える。本人の再試行で完了でない状態へ戻れば NULL に戻す。
  const completed = COMPLETED_STATES.includes(to);
  const updated = db
    .prepare(
      'UPDATE operations SET state = ?, state_revision = ?, completed_at = CASE WHEN ? THEN ? ELSE NULL END WHERE operation_id = ? AND state_revision = ?',
    )
    .run(
      to,
      next,
      completed ? 1 : 0,
      context.now,
      operation.operation_id,
      operation.state_revision,
    );
  if (updated.changes !== 1)
    throw new CommandRejection(['state_revision_changed']);
  appendEvent(db, context, operation.operation_id, next);
  writeReceipt(db, context, command, next);
  return next;
}

function durable(
  command: DbCommand,
  committed: number,
  options: {
    readonly replayed?: boolean;
    readonly existing?: boolean;
    readonly dispatched?: DispatchedAttempt | null;
  } = {},
): StoreOutcome {
  return {
    outcome: 'durable',
    command_id: command.command_id,
    kind: command.kind,
    operation_id: command.operation_id,
    committed_state_revision: toText(committed),
    replayed: options.replayed ?? false,
    existing: options.existing ?? false,
    dispatched: options.dispatched ?? null,
  };
}

// 内容版の行と、その確定 intent の暗号文（sealed_blobs、持ち主は operation_versions の版）を書く。
export function insertVersion(
  db: SqliteDatabase,
  context: StoreContext,
  operationId: string,
  contentVersion: number,
  contentHash: string,
  intent: SealedBlobInput,
): void {
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'operation_intent', 'operation_versions', ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    intent.blob_id,
    operationId,
    contentVersion,
    intent.format_version,
    intent.key_id,
    bytes(intent.nonce),
    bytes(intent.ciphertext),
    bytes(intent.tag),
    context.now,
  );
  db.prepare(
    'INSERT INTO operation_versions (operation_id, content_version, content_hash, intent_blob_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(operationId, contentVersion, contentHash, intent.blob_id, context.now);
}

// 用事の暗号文（sealed_blobs、purpose = task_content、持ち主は tasks の task_id・版 0）を書く。
export function insertTaskContent(
  db: SqliteDatabase,
  context: { readonly now: number },
  taskId: string,
  content: SealedBlobInput,
): void {
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'task_content', 'tasks', ?, 0, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    content.blob_id,
    taskId,
    content.format_version,
    content.key_id,
    bytes(content.nonce),
    bytes(content.ciphertext),
    bytes(content.tag),
    context.now,
  );
}

// --- 自動実行・取り消し（08 §9、03、ADR 0147） ---

// 方針による自動承認は自動実行の一覧に載る種類だけに許す。
function requireAutoKind(operationKind: string): void {
  if (autoActionKindFor(operationKind) === null)
    throw new CommandRejection(['operation_kind_not_auto']);
}

function isCompensation(db: SqliteDatabase, operationId: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM undo_records WHERE compensation_operation_id = ?')
      .get(operationId) !== undefined
  );
}

const UNDO_STATUS: Partial<Record<ResultState, UndoStatus>> = {
  succeeded: 'undone',
  not_executed: 'failed',
  unknown_held: 'unknown',
};

// 結果の記録と同じ transaction で、自動実行の一覧と取り消しの記録を書く。
function afterResult(
  db: SqliteDatabase,
  context: StoreContext,
  operation: OperationRow,
  approvalId: string,
  to: ResultState,
): void {
  if (to === 'succeeded') {
    const approval = db
      .prepare(
        'SELECT route, policy_version FROM approvals WHERE approval_id = ?',
      )
      .get(approvalId) as
      Pick<ApprovalRow, 'route' | 'policy_version'> | undefined;
    const kind = autoActionKindFor(operation.kind);
    if (
      approval?.route === 'policy_auto' &&
      approval.policy_version !== null &&
      kind !== null
    )
      recordAutoAction(
        db,
        context.now,
        operation.operation_id,
        kind,
        approval.policy_version,
      );
  }
  const undo = UNDO_STATUS[to];
  if (undo !== undefined)
    recordUndoOutcome(db, context.now, operation.operation_id, undo);
}

// --- 候補を起点にした自動実行の最終ガード（11 §5A・§5B、ADR 0103・0148） ---

// 判定に使った依頼と関連解析の版。候補の行から読み、承認の行に写して送出の直前にも使う。
interface CandidateUse {
  readonly candidate_id: string;
  readonly request_entity_id: string;
  readonly request_revision: number;
  readonly related_group_id: string;
  readonly analysis_revision: number;
  readonly source_set_hash: string;
  readonly published_generation: number;
}

// 判定に使った版が今も DB の現在値か、依頼が有効で、同じ依頼・操作・アカウント・カレンダーをまだ作っていないかを見る。
// 読めなかったもの（依頼・関連解析が無い）は拒否する（推測で通さない。ADR 0103 の finalGuard と同じ理由の名前）。
// 送出の直前は、自分の操作の一度だけの記録を「作成済み」に数えない（ownOperationId）。
function candidateGuardReasons(
  db: SqliteDatabase,
  use: CandidateUse,
  kind: AutoActionKind,
  accountId: string,
  calendarId: string,
  ownOperationId: string | null,
): string[] {
  const reasons: string[] = [];
  const entity = db
    .prepare(
      'SELECT state, request_revision, recreation_suppressed FROM request_entities WHERE request_entity_id = ?',
    )
    .get(use.request_entity_id) as
    | { state: string; request_revision: number; recreation_suppressed: number }
    | undefined;
  if (entity === undefined) reasons.push('entity_not_found');
  else {
    if (entity.request_revision !== use.request_revision)
      reasons.push('request_revision_changed');
    const created = db
      .prepare(
        'SELECT operation_kind, account_id, calendar_id FROM request_entity_operations WHERE request_entity_id = ? AND operation_id <> ?',
      )
      .all(use.request_entity_id, ownOperationId ?? '') as {
      operation_kind: string;
      account_id: string;
      calendar_id: string;
    }[];
    reasons.push(
      ...autoCreationReasons(
        {
          request_entity_id: use.request_entity_id,
          state: entity.state as 'active' | 'cancelled' | 'completed',
          recreation_suppressed: entity.recreation_suppressed === 1,
          created_operations: created,
        },
        [],
        { kind, accountId, calendarId },
      ),
    );
  }
  // 同じ集合の最新の版と比べる。新しい版が公開されていれば、旧版の資格は ready に戻っても通さない。
  const analysis = db
    .prepare(
      'SELECT analysis_revision, source_set_hash, published_generation, status FROM related_analyses WHERE group_id = ? ORDER BY analysis_revision DESC LIMIT 1',
    )
    .get(use.related_group_id) as
    | {
        analysis_revision: number;
        source_set_hash: string;
        published_generation: number;
        status: string;
      }
    | undefined;
  if (analysis === undefined) reasons.push('analysis_not_found');
  else {
    if (analysis.analysis_revision !== use.analysis_revision)
      reasons.push('analysis_revision_changed');
    if (analysis.source_set_hash !== use.source_set_hash)
      reasons.push('source_set_changed');
    if (analysis.published_generation !== use.published_generation)
      reasons.push('generation_changed');
    if (analysis.status !== 'ready') reasons.push('analysis_not_ready');
  }
  return reasons;
}

const CLOSED_CANDIDATE_STATES = new Set(['dismissed', 'resolved']);

// 作成と同時の自動承認で、候補の行から判定に使った版を読み、最終ガードを通す。
function candidateUseForCreate(
  db: SqliteDatabase,
  command: CreateOperationCommand,
  kind: AutoActionKind,
): CandidateUse | null {
  const origin = command.candidate_origin ?? null;
  if (origin === null) return null;
  const row = db
    .prepare(
      'SELECT state, request_entity_id, request_revision, related_group_id, related_analysis_revision, related_source_set_hash, related_published_generation FROM notification_candidates WHERE candidate_id = ?',
    )
    .get(origin.candidate_id) as
    | {
        state: string;
        request_entity_id: string | null;
        request_revision: number | null;
        related_group_id: string | null;
        related_analysis_revision: number | null;
        related_source_set_hash: string | null;
        related_published_generation: number | null;
      }
    | undefined;
  if (row === undefined) throw new CommandRejection(['candidate_not_found']);
  const reasons: string[] = [];
  // 本人が閉じた候補（不要・解決済み）からは作らない。
  if (CLOSED_CANDIDATE_STATES.has(row.state)) reasons.push('candidate_closed');
  if (row.request_entity_id === null || row.request_revision === null)
    reasons.push('candidate_without_request');
  if (
    row.related_group_id === null ||
    row.related_analysis_revision === null ||
    row.related_source_set_hash === null ||
    row.related_published_generation === null
  )
    reasons.push('related_analysis_missing');
  if (reasons.length > 0) throw new CommandRejection(reasons);
  const use: CandidateUse = {
    candidate_id: origin.candidate_id,
    request_entity_id: row.request_entity_id ?? '',
    request_revision: row.request_revision ?? 0,
    related_group_id: row.related_group_id ?? '',
    analysis_revision: row.related_analysis_revision ?? 0,
    source_set_hash: row.related_source_set_hash ?? '',
    published_generation: row.related_published_generation ?? 0,
  };
  const blocked = candidateGuardReasons(
    db,
    use,
    kind,
    origin.account_id,
    origin.calendar_id ?? '',
    null,
  );
  if (blocked.length > 0) throw new CommandRejection(blocked);
  return use;
}

// 送出の直前（LocalCommand の適用・RemoteMutation の送出意図）。候補を起点にした自動承認だけを照合する。
// 一度だけの記録（request_entity_operations）が依頼と一緒に消えていても、承認の行の版で依頼を探して拒否する。
function dispatchGuardReasons(
  db: SqliteDatabase,
  operation: OperationRow,
  approval: ApprovalRow,
): string[] {
  if (approval.route !== 'policy_auto' || approval.candidate_id === null)
    return [];
  const link = db
    .prepare(
      'SELECT operation_kind, account_id, calendar_id FROM request_entity_operations WHERE operation_id = ?',
    )
    .get(operation.operation_id) as
    | {
        operation_kind: AutoActionKind;
        account_id: string;
        calendar_id: string;
      }
    | undefined;
  const reasons = candidateGuardReasons(
    db,
    {
      candidate_id: approval.candidate_id,
      request_entity_id: approval.request_entity_id ?? '',
      request_revision: approval.request_revision ?? 0,
      related_group_id: approval.related_group_id ?? '',
      analysis_revision: approval.analysis_revision ?? 0,
      source_set_hash: approval.source_set_hash ?? '',
      published_generation: approval.published_generation ?? 0,
    },
    link?.operation_kind ?? autoActionKindFor(operation.kind) ?? 'create_task',
    link?.account_id ?? '',
    link?.calendar_id ?? '',
    operation.operation_id,
  );
  // 依頼があるのに自分の一度だけの記録が無いのは、記録の欠け。推測で通さない。
  if (link === undefined && !reasons.includes('entity_not_found'))
    reasons.push('candidate_link_missing');
  return reasons;
}

// --- 命令ごとの本体 ---

function deviceActive(db: SqliteDatabase, deviceId: string): boolean {
  const row = db
    .prepare('SELECT revoked_at FROM devices WHERE device_id = ?')
    .get(deviceId) as { revoked_at: number | null } | undefined;
  return row !== undefined && row.revoked_at === null;
}

function createOperation(
  db: SqliteDatabase,
  context: StoreContext,
  command: CreateOperationCommand,
): StoreOutcome {
  if (operationRow(db, command.operation_id) !== undefined)
    throw new CommandRejection(['operation_exists']);
  guard(db, command, '0', command.workflow_id, null);
  const auto = command.auto_approval;
  let candidateUse: CandidateUse | null = null;
  if (auto !== null) {
    // 作成と同時の自動承認も approvalDecision で判定する（承認待ちの版 0 の操作として）。
    const decision = approvalDecision(
      {
        operation_id: command.operation_id,
        current_content_version: '1',
        content_hash: command.content_hash,
        state_revision: '0',
        state: 'awaiting_approval',
        effective_approval: null,
      },
      {
        route: 'policy_auto',
        content_version: '1',
        content_hash: command.content_hash,
        expected_state_revision: '0',
        preview_valid: false,
        policy_version: auto.policy_version,
        current_policy_version: auto.current_policy_version,
      },
    );
    if (decision.action !== 'record')
      throw new CommandRejection(decision.reasons);
    requireAutoKind(command.operation_kind);
    // 候補を起点にしたものは、件数を数える前に最終ガードを通す（拒否した判定は自動承認に数えない。ADR 0148）。
    candidateUse = candidateUseForCreate(
      db,
      command,
      autoActionKindFor(command.operation_kind) ?? 'create_task',
    );
    // 時間窓の件数を承認の記録と同じ transaction で数える（08 §9）。基準を超えたら承認を書かず、
    // 安全停止だけを commit して拒否を返す（ADR 0147）。
    const block = countPolicyAutoApproval(
      db,
      context.now,
      auto.safety_target_key,
    );
    if (block === 'safety_stopped') throw new CommandRejection([block]);
    if (block !== null) return rejected(command, [block]);
  }
  const undoApproval = command.undo_of?.screen_approval ?? null;
  // 取り消しの押下は登録済みで失効していない端末からだけ（J12）。承認の行の端末の外部キーより先に理由を返す。
  if (undoApproval !== null && !deviceActive(db, undoApproval.device_id))
    throw new CommandRejection(['device_not_registered']);
  const state: OperationState =
    auto === null && undoApproval === null ? 'awaiting_approval' : 'approved';
  db.prepare(
    'INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at) VALUES (?, ?, ?, ?, 1, ?, 1, ?, NULL)',
  ).run(
    command.operation_id,
    command.workflow_id,
    command.operation_kind,
    command.effect_route,
    state,
    context.now,
  );
  insertVersion(
    db,
    context,
    command.operation_id,
    1,
    command.content_hash,
    command.intent,
  );
  if (auto !== null)
    db.prepare(
      "INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at, candidate_id, request_entity_id, request_revision, related_group_id, analysis_revision, source_set_hash, published_generation) VALUES (?, ?, 1, ?, 'policy_auto', NULL, NULL, ?, 'valid', ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      auto.approval_id,
      command.operation_id,
      command.content_hash,
      toInt(auto.policy_version),
      context.now,
      candidateUse?.candidate_id ?? null,
      candidateUse?.request_entity_id ?? null,
      candidateUse?.request_revision ?? null,
      candidateUse?.related_group_id ?? null,
      candidateUse?.analysis_revision ?? null,
      candidateUse?.source_set_hash ?? null,
      candidateUse?.published_generation ?? null,
    );
  // 同じ依頼・操作・アカウント・カレンダーにつき一度だけ（11 §5A）。承認と同じ transaction で記録する。
  // 送出が失敗しても行は残し、同じ候補から自動でやり直さない（本人が画面で作り直す。ADR 0148）。
  const origin = command.candidate_origin ?? null;
  if (candidateUse !== null && origin !== null)
    db.prepare(
      'INSERT INTO request_entity_operations (request_entity_id, operation_kind, account_id, calendar_id, operation_id) VALUES (?, ?, ?, ?, ?)',
    ).run(
      candidateUse.request_entity_id,
      autoActionKindFor(command.operation_kind),
      origin.account_id,
      origin.calendar_id ?? '',
      command.operation_id,
    );
  // 取り消しの押下を画面の承認として記録する（preview は一覧の行そのもの。preview_id に undo_id を使う。ADR 0153）。
  if (undoApproval !== null && command.undo_of)
    db.prepare(
      "INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at) VALUES (?, ?, 1, ?, 'screen', ?, ?, NULL, 'valid', ?)",
    ).run(
      undoApproval.approval_id,
      command.operation_id,
      command.content_hash,
      undoApproval.device_id,
      command.undo_of.undo_id,
      context.now,
    );
  const undo = command.undo_of ?? null;
  if (undo !== null) {
    const block = startUndo(
      db,
      context.now,
      undo.undo_id,
      undo.operation_id,
      command.operation_id,
    );
    if (block !== null) throw new CommandRejection([block]);
  }
  appendEvent(db, context, command.operation_id, 1);
  writeReceipt(db, context, command, 1);
  return durable(command, 1);
}

function approveOperation(
  db: SqliteDatabase,
  context: StoreContext,
  command: ApproveOperationCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  const contentVersion = operation.current_content_version;
  const hash = versionHash(db, operation.operation_id, contentVersion) ?? '';
  const effective = effectiveApproval(
    db,
    operation.operation_id,
    contentVersion,
  );
  const decision = approvalDecision(
    {
      operation_id: operation.operation_id,
      current_content_version: toText(contentVersion),
      content_hash: hash,
      state_revision: toText(operation.state_revision),
      state: operation.state,
      effective_approval:
        effective === undefined
          ? null
          : {
              content_version: toText(effective.content_version),
              content_hash: effective.content_hash,
            },
    },
    {
      route: command.route,
      content_version: command.content_version,
      content_hash: command.content_hash,
      expected_state_revision: command.expected_state_revision,
      preview_valid: command.preview_valid,
      policy_version: command.policy_version,
      current_policy_version: command.current_policy_version,
    },
  );
  if (decision.action === 'reject')
    throw new CommandRejection(decision.reasons);
  if (decision.action === 'existing') {
    // 同じ内容版の有効な承認がある（X02）。新しく作らず、現在のコミット済みの版を受付結果にする。
    writeReceipt(db, context, command, operation.state_revision);
    return durable(command, operation.state_revision, { existing: true });
  }
  if (bodyErased(db, operation.operation_id, contentVersion))
    throw new CommandRejection(['operation_body_erased']);
  if (operation.send_blocked_generation !== null)
    throw new CommandRejection(['operation_send_blocked']);
  guard(
    db,
    command,
    toText(operation.state_revision),
    operation.workflow_id,
    null,
  );
  if (command.route === 'policy_auto') {
    requireAutoKind(operation.kind);
    // 取り消しの補償の操作は本人の画面操作が起点（03 J12）。方針では承認しない。
    if (isCompensation(db, operation.operation_id))
      throw new CommandRejection(['undo_auto_approval']);
    const block = countPolicyAutoApproval(
      db,
      context.now,
      command.safety_target_key ?? '',
    );
    if (block === 'safety_stopped') throw new CommandRejection([block]);
    if (block !== null) return rejected(command, [block]);
  }
  db.prepare(
    "INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)",
  ).run(
    command.approval_id,
    operation.operation_id,
    contentVersion,
    hash,
    command.route,
    command.device_id,
    command.preview_id,
    command.policy_version === null ? null : toInt(command.policy_version),
    context.now,
  );
  return durable(command, advance(db, context, command, operation, 'approved'));
}

// ① 準備権の取得（08 §3）。有効な内容版・承認・状態版を条件に preparing の試行を作る。
function prepareOperation(
  db: SqliteDatabase,
  context: StoreContext,
  command: PrepareOperationCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  requireStateRevision(command, operation);
  // 本人の再試行は未実行の確定の後だけ（初回の実行・照合中の操作を横取りしない）。
  if (command.retry === true && operation.state !== 'not_executed')
    throw new CommandRejection(['retry_not_allowed']);
  if (!canTransition(operation.state, 'preparing', operation.effect_route))
    throw new CommandRejection(['transition_not_allowed']);
  guard(
    db,
    command,
    toText(operation.state_revision),
    operation.workflow_id,
    null,
  );
  const contentVersion = operation.current_content_version;
  // 本文の消えた内容版は送れない（未実行の確定の後、7 日を過ぎてからの本人の再試行）。
  if (bodyErased(db, operation.operation_id, contentVersion))
    throw new CommandRejection(['operation_body_erased']);
  // 忘れた内容を含み得る確定内容は送らない（忘却の送出禁止の印。ADR 0054）。
  if (operation.send_blocked_generation !== null)
    throw new CommandRejection(['operation_send_blocked']);
  const hash = versionHash(db, operation.operation_id, contentVersion);
  const approval = effectiveApproval(
    db,
    operation.operation_id,
    contentVersion,
  );
  if (
    approval === undefined ||
    approval.status !== 'valid' ||
    approval.content_hash !== hash
  )
    throw new CommandRejection(['approval_not_valid']);
  db.prepare(
    "INSERT INTO operation_attempts (attempt_id, operation_id, content_version, approval_id, status, dispatch_intent_at, external_id, result_status, created_at) VALUES (?, ?, ?, ?, 'preparing', NULL, NULL, NULL, ?)",
  ).run(
    command.attempt_id,
    operation.operation_id,
    contentVersion,
    approval.approval_id,
    context.now,
  );
  return durable(
    command,
    advance(db, context, command, operation, 'preparing'),
  );
}

// ③ 送出意図の記録（08 §3）。取消・版・許可・依頼の最新版・安全停止・予算予約を再検査し、
// attempt と送出意図を記録して dispatching へ進める。COMMIT の成功の後にだけ送出の許可を出せる。
function recordDispatchIntent(
  db: SqliteDatabase,
  context: StoreContext,
  command: DispatchIntentCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  requireStateRevision(command, operation);
  if (!canTransition(operation.state, 'dispatching', operation.effect_route))
    throw new CommandRejection(['transition_not_allowed']);
  const attempt = attemptRow(db, command.attempt_id);
  if (
    attempt === undefined ||
    attempt.operation_id !== operation.operation_id ||
    attempt.status !== 'preparing'
  )
    throw new CommandRejection(['attempt_not_preparing']);
  const reasons: string[] = [];
  if (attempt.content_version !== operation.current_content_version)
    reasons.push('content_version_changed');
  if (bodyErased(db, operation.operation_id, attempt.content_version))
    reasons.push('operation_body_erased');
  if (operation.send_blocked_generation !== null)
    reasons.push('operation_send_blocked');
  const hash = versionHash(db, operation.operation_id, attempt.content_version);
  const approval = db
    .prepare('SELECT * FROM approvals WHERE approval_id = ?')
    .get(attempt.approval_id) as ApprovalRow | undefined;
  if (
    approval === undefined ||
    approval.status !== 'valid' ||
    approval.content_version !== attempt.content_version ||
    approval.content_hash !== hash
  )
    reasons.push('approval_not_valid');
  // 候補を起点にした自動承認は、送出意図の直前にも判定に使った版を照らす（ADR 0148）。
  if (approval !== undefined)
    reasons.push(...dispatchGuardReasons(db, operation, approval));
  if (operation.effect_route === 'remote_mutation') {
    const observed = command.observed_connection ?? null;
    if (command.connection_id === null) {
      // DB に行のない接続（B04 の模擬 provider）は、Core が送出の直前に読み直した値で確かめる（ADR 0030）。
      if (observed === null) reasons.push('connection_required');
      else {
        if (observed.status !== 'active' || observed.access !== 'read_write')
          reasons.push('connection_not_writable');
        if (observed.permission_revision !== command.permission_revision)
          reasons.push('permission_changed');
      }
    } else {
      const connection = db
        .prepare(
          'SELECT status, access FROM connections WHERE connection_id = ?',
        )
        .get(command.connection_id) as
        { status: string; access: string } | undefined;
      if (
        connection !== undefined &&
        (connection.status !== 'active' || connection.access !== 'read_write')
      )
        reasons.push('connection_not_writable');
    }
  }
  let reservationValid = true;
  if (command.reservation_id !== null) {
    const reservation = db
      .prepare(
        'SELECT status FROM budget_reservations WHERE reservation_id = ?',
      )
      .get(command.reservation_id) as { status: string } | undefined;
    reservationValid = reservation?.status === 'reserved';
  }
  if (reasons.length > 0) throw new CommandRejection(reasons);
  guard(db, command, toText(operation.state_revision), operation.workflow_id, {
    reservationValid,
  });
  const updated = db
    .prepare(
      "UPDATE operation_attempts SET status = 'dispatching', dispatch_intent_at = ? WHERE attempt_id = ? AND status = 'preparing'",
    )
    .run(context.now, attempt.attempt_id);
  if (updated.changes !== 1)
    throw new CommandRejection(['attempt_not_preparing']);
  // 工程の送出意図（D3）。同じ工程の二度目の送出意図は主キーで拒否する（再送しない最終の保証）。
  if (command.step !== undefined && command.step !== null)
    db.prepare(
      'INSERT INTO operation_steps (attempt_id, step_id, step_kind, external_id, dispatch_intent_at, result_status) VALUES (?, ?, ?, NULL, ?, NULL)',
    ).run(
      attempt.attempt_id,
      command.step.step_id,
      command.step.step_kind,
      context.now,
    );
  const committed = advance(db, context, command, operation, 'dispatching');
  return durable(command, committed, {
    dispatched: {
      attempt_id: attempt.attempt_id,
      content_version: toText(attempt.content_version),
      content_hash: hash ?? '',
    },
  });
}

const RESULT_STATUS: Readonly<Record<string, string | null>> = {
  reconciling: null,
  succeeded: 'confirmed_success',
  not_executed: 'confirmed_not_executed',
  unknown_held: 'unknown',
};

// ④ 結果の記録（08 §3）。送出済みの結果を失わないよう、許可・忘却の版の変更では拒否しない。
function recordResult(
  db: SqliteDatabase,
  context: StoreContext,
  command: RecordResultCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  requireStateRevision(command, operation);
  if (!canTransition(operation.state, command.to, operation.effect_route))
    throw new CommandRejection(['transition_not_allowed']);
  const attempt = attemptRow(db, command.attempt_id);
  // 結果を記録できるのは、操作の現在の状態と同じ状態にある送出済みの試行だけ。
  if (
    attempt === undefined ||
    attempt.operation_id !== operation.operation_id ||
    attempt.status !== operation.state ||
    attempt.dispatch_intent_at === null
  )
    throw new CommandRejection(['attempt_not_dispatched']);
  const resultStatus = RESULT_STATUS[command.to] ?? null;
  db.prepare(
    'UPDATE operation_attempts SET status = ?, result_status = coalesce(?, result_status), external_id = coalesce(?, external_id) WHERE attempt_id = ?',
  ).run(command.to, resultStatus, command.external_id, attempt.attempt_id);
  // 送出意図のある工程のうち、結果が確定していないものに同じ結果を記録する（D3。1 工程の操作）。
  if (resultStatus !== null)
    db.prepare(
      "UPDATE operation_steps SET result_status = ?, external_id = coalesce(?, external_id) WHERE attempt_id = ? AND dispatch_intent_at IS NOT NULL AND coalesce(result_status, 'unknown') = 'unknown'",
    ).run(resultStatus, command.external_id, attempt.attempt_id);
  // 成功した送出で承認を使い終える。未実行の確定では同じ承認を本人の明示再試行へ戻せる（08 §4）。
  if (command.to === 'succeeded')
    db.prepare(
      "UPDATE approvals SET status = 'consumed' WHERE approval_id = ? AND status = 'valid'",
    ).run(attempt.approval_id);
  afterResult(db, context, operation, attempt.approval_id, command.to);
  return durable(command, advance(db, context, command, operation, command.to));
}

// 取消（07 §2、08 §3、X05）。送出前だけ取消を確定し、送出後は受付だけを記録して照合へ回す。
function cancelOperation(
  db: SqliteDatabase,
  context: StoreContext,
  command: CancelOperationCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  requireStateRevision(command, operation);
  if (AFTER_DISPATCH.includes(operation.state)) {
    writeReceipt(db, context, command, null);
    return {
      outcome: 'accepted',
      command_id: command.command_id,
      kind: command.kind,
      operation_id: command.operation_id,
      state_revision: toText(operation.state_revision),
      replayed: false,
      reason: 'dispatch_boundary_crossed',
    };
  }
  if (!canTransition(operation.state, 'cancelled', operation.effect_route))
    throw new CommandRejection(['operation_finished']);
  db.prepare(
    "UPDATE operation_attempts SET status = 'cancelled' WHERE operation_id = ? AND status = 'preparing'",
  ).run(operation.operation_id);
  return durable(
    command,
    advance(db, context, command, operation, 'cancelled'),
  );
}

// 起動時の回復（08 §4、ADR 0019）。dispatching の試行を unknown_held へ回し、自動では送らない。
// 送ったかどうかは分からない（送出意図の COMMIT の後、送信の前後のどこで止まったか記録にない）ため、
// 未実行（not_executed）にも成功にもしない。照合（reconciling）と本人の判断は B04 以降。
function recoverAfterRestart(
  db: SqliteDatabase,
  context: StoreContext,
  command: RecoverAfterRestartCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  requireStateRevision(command, operation);
  if (operation.state !== 'dispatching')
    throw new CommandRejection(['operation_not_dispatching']);
  const attempt = attemptRow(db, command.attempt_id);
  if (
    attempt === undefined ||
    attempt.operation_id !== operation.operation_id ||
    attempt.status !== 'dispatching' ||
    attempt.dispatch_intent_at === null
  )
    throw new CommandRejection(['attempt_not_dispatched']);
  const updated = db
    .prepare(
      "UPDATE operation_attempts SET status = 'unknown_held', result_status = 'unknown' WHERE attempt_id = ? AND status = 'dispatching'",
    )
    .run(attempt.attempt_id);
  if (updated.changes !== 1)
    throw new CommandRejection(['attempt_not_dispatched']);
  // 送出意図のある工程も結果不明にする（D3。再送せず照合だけにする）。
  db.prepare(
    "UPDATE operation_steps SET result_status = 'unknown' WHERE attempt_id = ? AND dispatch_intent_at IS NOT NULL AND result_status IS NULL",
  ).run(attempt.attempt_id);
  return durable(
    command,
    advance(db, context, command, operation, 'unknown_held'),
  );
}

// 内容版の更新（D1、ADR 0027・0029・0030）。domain の planContentRevision で決め、旧版の有効な承認の失効・
// 送出意図の前の試行の superseded・新しい版の保存・承認待ちへの遷移を一つの transaction で行う。
function reviseContent(
  db: SqliteDatabase,
  context: StoreContext,
  command: ReviseContentCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  requireStateRevision(command, operation);
  const current = operation.current_content_version;
  const currentHash = versionHash(db, operation.operation_id, current) ?? '';
  const effective = effectiveApproval(db, operation.operation_id, current);
  const active = db
    .prepare(
      "SELECT count(*) AS value FROM operation_attempts WHERE operation_id = ? AND status IN ('preparing', 'dispatching', 'reconciling')",
    )
    .get(operation.operation_id) as { value: number };
  const plan = planContentRevision({
    state: operation.state,
    current_content_version: toText(current),
    current_content_hash: currentHash,
    next_content_hash: command.content_hash,
    has_valid_approval: effective?.status === 'valid',
    has_active_attempt: active.value > 0,
  });
  if (!plan.ok) throw new CommandRejection(plan.reasons);
  if (command.content_version !== plan.next_content_version)
    throw new CommandRejection(['content_version_changed']);
  guard(
    db,
    command,
    toText(operation.state_revision),
    operation.workflow_id,
    null,
  );
  const next = toInt(plan.next_content_version);
  insertVersion(
    db,
    context,
    operation.operation_id,
    next,
    command.content_hash,
    command.intent,
  );
  if (plan.revoke_approval)
    db.prepare(
      "UPDATE approvals SET status = 'revoked' WHERE operation_id = ? AND content_version = ? AND status = 'valid'",
    ).run(operation.operation_id, current);
  // 送出意図の前の試行（preparing）は旧版のまま送らない（X09、ADR 0030）。送出境界を越えた試行はここに来ない
  // （planContentRevision が dispatch_boundary_crossed で拒否する）。
  if (plan.supersede_attempt) {
    const superseded = db
      .prepare(
        "UPDATE operation_attempts SET status = 'superseded' WHERE operation_id = ? AND status = 'preparing' AND dispatch_intent_at IS NULL",
      )
      .run(operation.operation_id);
    if (superseded.changes !== active.value)
      throw new CommandRejection(['attempt_not_preparing']);
  }
  const updated = db
    .prepare(
      'UPDATE operations SET current_content_version = ? WHERE operation_id = ? AND state_revision = ?',
    )
    .run(next, operation.operation_id, operation.state_revision);
  if (updated.changes !== 1)
    throw new CommandRejection(['state_revision_changed']);
  return durable(
    command,
    advance(db, context, command, operation, plan.next_state),
  );
}

// LocalCommand の適用（D5、ADR 0030）。外部 HTTP を使わず、承認済みの操作から用事の行・成功の試行・承認の使用・
// 最終状態（approved → succeeded）・イベント・受付を一つの transaction で書く。同じ命令の再到着は command_receipts で
// 保存済みの結果を返し（findReplay）、別の命令で二度目を適用しようとしても状態版・tasks の一意制約で拒否する。
// LocalCommand の適用と取り消しに共通する検査（D5、ADR 0030・0157）。承認済みで、承認が有効で内容の照合値が合い、
// 停止・送出禁止・候補の版の照合に掛からないこと。
function requireLocalApproval(
  db: SqliteDatabase,
  command: ApplyLocalCommand | DeleteLocalCommand,
  operation: OperationRow,
): { contentVersion: number; approval: ApprovalRow } {
  if (operation.effect_route !== 'local_command')
    throw new CommandRejection(['route_mismatch']);
  if (
    operation.state !== 'approved' ||
    !canTransition(operation.state, 'succeeded', operation.effect_route)
  )
    throw new CommandRejection(['transition_not_allowed']);
  guard(
    db,
    command,
    toText(operation.state_revision),
    operation.workflow_id,
    null,
  );
  const contentVersion = operation.current_content_version;
  if (bodyErased(db, operation.operation_id, contentVersion))
    throw new CommandRejection(['operation_body_erased']);
  if (operation.send_blocked_generation !== null)
    throw new CommandRejection(['operation_send_blocked']);
  const hash = versionHash(db, operation.operation_id, contentVersion);
  const approval = effectiveApproval(
    db,
    operation.operation_id,
    contentVersion,
  );
  if (
    approval === undefined ||
    approval.status !== 'valid' ||
    approval.content_hash !== hash
  )
    throw new CommandRejection(['approval_not_valid']);
  // 停止前に自動承認済みで未実行のものは保留にする（08 §9）。
  if (approval.route === 'policy_auto' && safetyStopped(db))
    throw new CommandRejection(['safety_stopped']);
  // 候補を起点にした自動承認は、適用の直前にも判定に使った版を照らす（ADR 0148）。
  const blocked = dispatchGuardReasons(db, operation, approval);
  if (blocked.length > 0) throw new CommandRejection(blocked);
  return { contentVersion, approval };
}

function applyLocal(
  db: SqliteDatabase,
  context: StoreContext,
  command: ApplyLocalCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  requireStateRevision(command, operation);
  const { contentVersion, approval } = requireLocalApproval(
    db,
    command,
    operation,
  );
  if (operation.kind !== 'task.create')
    throw new CommandRejection(['operation_kind_mismatch']);
  db.prepare(
    "INSERT INTO operation_attempts (attempt_id, operation_id, content_version, approval_id, status, dispatch_intent_at, external_id, result_status, created_at) VALUES (?, ?, ?, ?, 'succeeded', ?, ?, 'confirmed_success', ?)",
  ).run(
    command.attempt_id,
    operation.operation_id,
    contentVersion,
    approval.approval_id,
    context.now,
    command.task_id,
    context.now,
  );
  // 用事の正本（題名・期限・本文の暗号文。所有者は用事）を同じ transaction で書く（ADR 0051）。
  insertTaskContent(db, context, command.task_id, command.content);
  db.prepare(
    "INSERT INTO tasks (task_id, operation_id, content_version, list_id, status, created_at, content_blob_id) VALUES (?, ?, ?, ?, 'open', ?, ?)",
  ).run(
    command.task_id,
    operation.operation_id,
    contentVersion,
    command.list_id,
    context.now,
    command.content.blob_id,
  );
  db.prepare(
    "UPDATE approvals SET status = 'consumed' WHERE approval_id = ? AND status = 'valid'",
  ).run(approval.approval_id);
  afterResult(db, context, operation, approval.approval_id, 'succeeded');
  return durable(
    command,
    advance(db, context, command, operation, 'succeeded'),
  );
}

// LocalCommand の取り消し（ADR 0157）。自動で登録した用事を、取り消しの補償（task.delete）として消す。
// 消せるのは、取り消しの記録が結ぶ元の操作が作った用事で、まだ開いているもの（完了・削除済みなら target_changed）。
// 用事の内容は今は編集できない（tasks_content_fixed）ので、開いていれば登録した時のままである。
// 拒否した時は何も書かず、操作は approved のまま残る（ADR 0156 と同じ。U317 の決め方 (a)）。
function deleteLocal(
  db: SqliteDatabase,
  context: StoreContext,
  command: DeleteLocalCommand,
): StoreOutcome {
  const operation = requireOperation(db, command);
  requireStateRevision(command, operation);
  const { contentVersion, approval } = requireLocalApproval(
    db,
    command,
    operation,
  );
  if (operation.kind !== 'task.delete')
    throw new CommandRejection(['operation_kind_mismatch']);
  const undo = db
    .prepare(
      'SELECT operation_id FROM undo_records WHERE compensation_operation_id = ?',
    )
    .get(operation.operation_id) as { operation_id: string } | undefined;
  if (undo === undefined) throw new CommandRejection(['undo_only_kind']);
  const task = db
    .prepare(
      'SELECT operation_id, status, content_blob_id FROM tasks WHERE task_id = ?',
    )
    .get(command.task_id) as
    | {
        operation_id: string;
        status: string;
        content_blob_id: string | null;
      }
    | undefined;
  if (
    task === undefined ||
    task.operation_id !== undo.operation_id ||
    task.status !== 'open'
  )
    throw new CommandRejection(['target_changed']);
  db.prepare(
    "INSERT INTO operation_attempts (attempt_id, operation_id, content_version, approval_id, status, dispatch_intent_at, external_id, result_status, created_at) VALUES (?, ?, ?, ?, 'succeeded', ?, ?, 'confirmed_success', ?)",
  ).run(
    command.attempt_id,
    operation.operation_id,
    contentVersion,
    approval.approval_id,
    context.now,
    command.task_id,
    context.now,
  );
  // 用事の行と、その用事だけが持つ暗号文を同じ transaction で消す（03 の until_owner_deletes）。
  db.prepare('DELETE FROM tasks WHERE task_id = ?').run(command.task_id);
  if (task.content_blob_id !== null)
    db.prepare(
      "DELETE FROM sealed_blobs WHERE blob_id = ? AND owner_table = 'tasks' AND owner_id = ? AND purpose = 'task_content'",
    ).run(task.content_blob_id, command.task_id);
  db.prepare(
    "UPDATE approvals SET status = 'consumed' WHERE approval_id = ? AND status = 'valid'",
  ).run(approval.approval_id);
  afterResult(db, context, operation, approval.approval_id, 'succeeded');
  return durable(
    command,
    advance(db, context, command, operation, 'succeeded'),
  );
}

function applyCommand(
  db: SqliteDatabase,
  context: StoreContext,
  command: DbCommand,
): StoreOutcome {
  switch (command.kind) {
    case 'operation.create':
      return createOperation(db, context, command);
    case 'operation.approve':
      return approveOperation(db, context, command);
    case 'operation.prepare':
      return prepareOperation(db, context, command);
    case 'operation.dispatch_intent':
      return recordDispatchIntent(db, context, command);
    case 'operation.record_result':
      return recordResult(db, context, command);
    case 'operation.cancel':
      return cancelOperation(db, context, command);
    case 'operation.revise_content':
      return reviseContent(db, context, command);
    case 'operation.recover_after_restart':
      return recoverAfterRestart(db, context, command);
    case 'operation.apply_local':
      return applyLocal(db, context, command);
    case 'operation.delete_local':
      return deleteLocal(db, context, command);
  }
}

// --- 再到着（command_receipts） ---

function replayOutcome(
  db: SqliteDatabase,
  command: DbCommand,
  receipt: ReceiptRow,
): StoreOutcome {
  if (receipt.status === 'durable' && receipt.committed_state_revision !== null)
    return {
      outcome: 'durable',
      command_id: receipt.command_id,
      kind: command.kind,
      operation_id: receipt.target_id,
      committed_state_revision: toText(receipt.committed_state_revision),
      replayed: true,
      existing: false,
      // 再到着では送出意図を新しくコミットしていない。送出の許可の材料を返さない。
      dispatched: null,
    };
  const operation = operationRow(db, receipt.target_id);
  return {
    outcome: 'accepted',
    command_id: receipt.command_id,
    kind: command.kind,
    operation_id: receipt.target_id,
    state_revision: toText(operation?.state_revision ?? 0),
    replayed: true,
    reason: 'dispatch_boundary_crossed',
  };
}

// 同じ command_id・同じ接続範囲と request_id の再到着を判定する。null なら新しい命令。
function findReplay(
  db: SqliteDatabase,
  command: DbCommand,
): StoreOutcome | null {
  const ref = requestRef(command);
  const byCommand = db
    .prepare('SELECT * FROM command_receipts WHERE command_id = ?')
    .get(command.command_id) as ReceiptRow | undefined;
  if (byCommand !== undefined) {
    const same =
      byCommand.command_scope_id === ref.command_scope_id &&
      byCommand.request_id === ref.request_id &&
      byCommand.request_hash === ref.request_hash &&
      byCommand.target_id === command.operation_id;
    if (!same) throw new CommandRejection(['command_id_reused']);
    return replayOutcome(db, command, byCommand);
  }
  const byRequest = db
    .prepare(
      'SELECT * FROM command_receipts WHERE command_scope_id = ? AND request_id = ?',
    )
    .get(ref.command_scope_id, ref.request_id) as ReceiptRow | undefined;
  const decision = replayDecision(
    byRequest === undefined ? [] : [byRequest],
    ref,
  );
  if (decision === 'new') return null;
  // 同じ要求内容は保存済みの受付結果へ。内容が違う再利用は 409 相当（07 §3、X04）。
  if (decision === 'conflict' || byRequest?.target_id !== command.operation_id)
    throw new CommandRejection(['request_conflict']);
  return replayOutcome(db, command, byRequest);
}

function rejected(
  command: DbCommand,
  reasons: readonly string[],
): StoreOutcome {
  return {
    outcome: 'rejected',
    command_id: command.command_id,
    kind: command.kind,
    reasons,
  };
}

const NO_TIMINGS: StoreTimings = { transaction_ms: 0, commit_ms: null };

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

// 1 命令を処理する。DB worker の中から呼ぶ。
export function executeCommand(
  db: SqliteDatabase,
  command: DbCommand,
  context: StoreContext,
): StoreResult {
  const shape = commandShapeReasons(command);
  if (shape.length > 0)
    return {
      outcome: rejected(command, shape),
      halt: false,
      timings: NO_TIMINGS,
    };
  // 耐久設定が一つでも違えば記録せず（durable ACK・送出意図を出さない）、以後の書込みを止める
  // （08 §3、11 §9）。接続の作成時に加えて命令ごとに読み戻す。
  const durability = writeConnectionReasons(db, context.platform);
  if (durability.length > 0)
    return {
      outcome: rejected(command, ['durability_mismatch', ...durability]),
      halt: true,
      timings: NO_TIMINGS,
    };
  const started = clock();
  try {
    const run = runImmediate(
      db,
      () => findReplay(db, command) ?? applyCommand(db, context, command),
      context.beforeCommit === undefined
        ? undefined
        : () => context.beforeCommit?.(command),
    );
    return { outcome: run.value, halt: false, timings: run.timings };
  } catch (error) {
    const timings: StoreTimings = {
      transaction_ms: clock() - started,
      commit_ms: null,
    };
    if (error instanceof CommandRejection)
      return {
        outcome: rejected(command, error.reasons),
        halt: false,
        timings,
      };
    if (error instanceof CommitUncertain)
      return {
        outcome: {
          outcome: 'unknown',
          command_id: command.command_id,
          kind: command.kind,
          reason: 'commit_failed',
        },
        halt: true,
        timings,
      };
    const code = sqliteCode(error);
    // 書込みの競合は待たずに返す（busy_timeout=0、11 §9）。適用していない。
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
      return {
        outcome: rejected(command, ['database_busy']),
        halt: false,
        timings,
      };
    // 制約違反は transaction ごと巻き戻した。最終の保証が働いた結果で、書込みは続けられる。
    if (code?.startsWith('SQLITE_CONSTRAINT'))
      return {
        outcome: rejected(command, ['constraint_violation']),
        halt: false,
        timings,
      };
    // 想定外の失敗（ディスクの空き・I/O・注入した例外など）。巻き戻したが、以後の書込みは止める。
    return {
      outcome: rejected(command, [
        code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
      ]),
      halt: true,
      timings,
    };
  }
}

// --- 大量書込みの小分け（11 §9 P06） ---

export const BULK_WRITE_LIMITS = {
  maxItems: 50,
  maxMilliseconds: 20,
} as const;

export interface BulkWriteOptions {
  readonly maxItems?: number;
  readonly maxMilliseconds?: number;
  // 経過時間の計測（試験で差し替える）。既定は performance.now。
  readonly clock?: () => number;
}

// items[start] から、最大 50 件または 20ms までを一つの transaction で書き、次の位置を返す。
// 1 件は必ず書く。呼び出し側は transaction の間に他の命令を処理できる（優先処理の受付）。
// fsync 自体が 20ms 以内に終わる保証ではない。
export function writeBulkSlice<T>(
  db: SqliteDatabase,
  items: readonly T[],
  start: number,
  write: (item: T) => void,
  options: BulkWriteOptions = {},
): number {
  const maxItems = options.maxItems ?? BULK_WRITE_LIMITS.maxItems;
  const maxMilliseconds =
    options.maxMilliseconds ?? BULK_WRITE_LIMITS.maxMilliseconds;
  const now = options.clock ?? clock;
  if (start >= items.length) return start;
  return runImmediate(db, () => {
    const began = now();
    let index = start;
    while (index < items.length && index - start < maxItems) {
      write(items[index] as T);
      index += 1;
      if (now() - began >= maxMilliseconds) break;
    }
    return index;
  }).value;
}
