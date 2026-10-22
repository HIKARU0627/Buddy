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
  canTransition,
  commandGuard,
  planContentRevision,
  replayDecision,
} from '@buddy/domain';
import type { OperationRoute, OperationState } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
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
  RecoverAfterRestartCommand,
  ReviseContentCommand,
  SealedBlobInput,
  StoreOutcome,
} from './operation-commands.js';

const RECEIPT_TTL_MS = RETENTION_RULES['command_receipt']?.ms ?? 0;
const EVENT_TTL_MS = RETENTION_RULES['event_outbox']?.ms ?? 0;

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
  status: string;
  approved_at: number;
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

// 起動時に回復の対象になる操作（08 §4、ADR 0019）。送出境界の手前（preparing）と、送出意図の記録の後（dispatching）。
export interface InterruptedOperation {
  readonly operation_id: string;
  readonly state: 'preparing' | 'dispatching';
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
      "SELECT o.operation_id, o.state, o.state_revision, o.current_content_version, a.attempt_id FROM operations o LEFT JOIN operation_attempts a ON a.operation_id = o.operation_id AND a.status = o.state WHERE o.state IN ('preparing', 'dispatching') ORDER BY o.created_at, o.operation_id",
    )
    .all() as {
    operation_id: string;
    state: 'preparing' | 'dispatching';
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

function appendEvent(
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
  const next = operation.state_revision + 1;
  const completed = to === 'succeeded' || to === 'cancelled';
  const updated = db
    .prepare(
      'UPDATE operations SET state = ?, state_revision = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END WHERE operation_id = ? AND state_revision = ?',
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
function insertVersion(
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

// --- 命令ごとの本体 ---

function createOperation(
  db: SqliteDatabase,
  context: StoreContext,
  command: CreateOperationCommand,
): StoreOutcome {
  if (operationRow(db, command.operation_id) !== undefined)
    throw new CommandRejection(['operation_exists']);
  guard(db, command, '0', command.workflow_id, null);
  const auto = command.auto_approval;
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
  }
  const state: OperationState =
    auto === null ? 'awaiting_approval' : 'approved';
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
      "INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at) VALUES (?, ?, 1, ?, 'policy_auto', NULL, NULL, ?, 'valid', ?)",
    ).run(
      auto.approval_id,
      command.operation_id,
      command.content_hash,
      toInt(auto.policy_version),
      context.now,
    );
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
  guard(
    db,
    command,
    toText(operation.state_revision),
    operation.workflow_id,
    null,
  );
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
  if (operation.effect_route === 'remote_mutation') {
    if (command.connection_id === null) reasons.push('connection_required');
    else {
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
  // 成功した送出で承認を使い終える。未実行の確定では同じ承認を本人の明示再試行へ戻せる（08 §4）。
  if (command.to === 'succeeded')
    db.prepare(
      "UPDATE approvals SET status = 'consumed' WHERE approval_id = ? AND status = 'valid'",
    ).run(attempt.approval_id);
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
  return durable(
    command,
    advance(db, context, command, operation, 'unknown_held'),
  );
}

// 内容版の更新（D1、ADR 0027・0029）。domain の planContentRevision で決め、旧版の有効な承認の失効・新しい版の
// 保存・承認待ちへの遷移を一つの transaction で行う。実行中の試行がある操作は試行の superseded（0001 の CHECK に
// ない状態）が要るため、B04-04 まで拒否する。
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
  if (plan.supersede_attempt) throw new CommandRejection(['attempt_active']);
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
