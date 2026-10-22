// スナップショットと操作の表示用の読み取り（設計 07 §1・§2・§4、08 §5、ADR 0023）。
//
// DB worker の中で実行する同期関数。書込みはしない。
// - スナップショットは、操作の状態とイベントの最大の連番を一つの読み取り transaction（BEGIN DEFERRED）で取る。
//   worker はメッセージを一つずつ同期で処理するため、命令の transaction の途中を読むことはない。
//   読み取り transaction は、同じ境界（どの連番までのイベントが反映済みか）を明示するために使う。
// - 本文（確定 intent・暗号文）・宛先・トークンの照合値は読まない。返すのは ID・版・状態・hash だけ。
// - 版・連番は契約と同じ 10 進の文字列にする（DB の INTEGER は worker の中で変換する）。

import type { OperationState } from '@buddy/domain';
import type { SqliteDatabase } from './connection.js';
import type { CommandScopeRecord } from './device-store.js';

// 表示の対象に必ず含める状態（終端ではない、または本人の再試行を待つ状態）。
// 終端（succeeded・cancelled・superseded）の操作は、その変更のイベントがまだ event_outbox にある間だけ含める。
const TERMINAL_STATES: readonly OperationState[] = [
  'succeeded',
  'cancelled',
  'superseded',
];

export type ApprovalStatus =
  'none' | 'valid' | 'consumed' | 'revoked' | 'expired';

// 操作の表示用の値と、承認・取消の命令に入れる版（依頼・忘却）。本文は含めない。
export interface OperationView {
  readonly operation_id: string;
  readonly workflow_id: string | null;
  // 操作の種類（operations.kind。確定 intent の action.kind と同じ値、ADR 0027）。
  readonly operation_kind: string;
  readonly effect_route: string;
  readonly state: OperationState;
  readonly state_revision: string;
  readonly current_content_version: string;
  readonly content_hash: string;
  // 現在の内容版の承認（有効な承認を優先し、なければ最新の失効・期限切れ、どちらもなければ none）。
  readonly approval_status: ApprovalStatus;
  // 最新の試行の結果。試行がない・結果がまだなければ null。
  readonly result_status: string | null;
  readonly external_id: string | null;
  // 最新の試行の ID と状態（実行担当の再開と照合に使う。ADR 0030）。試行がなければ null。
  readonly attempt_id: string | null;
  readonly attempt_status: string | null;
  // 送出境界を越えた後の取消を受け付けた（受付だけで状態は変えていない、X05）。
  readonly cancel_requested: boolean;
  // workflow の現在の依頼の版。workflow のない操作は null。
  readonly request_revision: string | null;
  // 忘却台帳の最大の世代（なければ 0）。
  readonly forgetting_generation: string;
  readonly created_at: number;
}

export interface SnapshotRead {
  readonly store_generation: string;
  // 読み取りの時点で event_outbox にある最大の連番（なければ 0）。スナップショットの境界。
  readonly max_sequence: number;
  // 読み取りの時点で残っている最小の連番（なければ null）。
  readonly min_sequence: number | null;
  readonly operations: readonly OperationView[];
}

interface OperationRow {
  operation_id: string;
  workflow_id: string | null;
  kind: string;
  effect_route: string;
  current_content_version: number;
  state: OperationState;
  state_revision: number;
  created_at: number;
  content_hash: string | null;
}

const OPERATION_COLUMNS =
  'o.operation_id, o.workflow_id, o.kind, o.effect_route, o.current_content_version, o.state, o.state_revision, o.created_at, v.content_hash';
const OPERATION_FROM =
  'FROM operations o LEFT JOIN operation_versions v ON v.operation_id = o.operation_id AND v.content_version = o.current_content_version';

const text = (value: number): string => String(value);

// 読み取り transaction。命令の transaction の中からは呼ばない。
export function readConsistently<T>(db: SqliteDatabase, body: () => T): T {
  if (db.inTransaction)
    throw new Error('transaction の中から読み取り transaction を始めません。');
  return db.transaction(body).deferred();
}

function forgettingGeneration(db: SqliteDatabase): string {
  const row = db
    .prepare(
      'SELECT coalesce(max(forgetting_generation), 0) AS value FROM forget_ledger',
    )
    .get() as { value: number };
  return text(row.value);
}

function toView(
  db: SqliteDatabase,
  row: OperationRow,
  forgetting: string,
): OperationView {
  const approval = db
    .prepare(
      "SELECT status FROM approvals WHERE operation_id = ? AND content_version = ? ORDER BY CASE status WHEN 'valid' THEN 0 WHEN 'consumed' THEN 1 ELSE 2 END, approved_at DESC, approval_id DESC LIMIT 1",
    )
    .get(row.operation_id, row.current_content_version) as
    { status: ApprovalStatus } | undefined;
  const attempt = db
    .prepare(
      'SELECT attempt_id, status, result_status, external_id FROM operation_attempts WHERE operation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get(row.operation_id) as
    | {
        attempt_id: string;
        status: string;
        result_status: string | null;
        external_id: string | null;
      }
    | undefined;
  // 受付だけ（accepted）の記録は、送出境界を越えた後の取消だけが作る（operation-store の cancelOperation）。
  const cancel = db
    .prepare(
      "SELECT count(*) AS value FROM command_receipts WHERE target_id = ? AND status = 'accepted'",
    )
    .get(row.operation_id) as { value: number };
  let requestRevision: string | null = null;
  if (row.workflow_id !== null) {
    const workflow = db
      .prepare(
        'SELECT current_request_revision AS value FROM workflows WHERE workflow_id = ?',
      )
      .get(row.workflow_id) as { value: number } | undefined;
    requestRevision = workflow === undefined ? null : text(workflow.value);
  }
  return {
    operation_id: row.operation_id,
    workflow_id: row.workflow_id,
    operation_kind: row.kind,
    effect_route: row.effect_route,
    state: row.state,
    state_revision: text(row.state_revision),
    current_content_version: text(row.current_content_version),
    content_hash: row.content_hash ?? '',
    approval_status: approval?.status ?? 'none',
    result_status: attempt?.result_status ?? null,
    external_id: attempt?.external_id ?? null,
    attempt_id: attempt?.attempt_id ?? null,
    attempt_status: attempt?.status ?? null,
    cancel_requested: cancel.value > 0,
    request_revision: requestRevision,
    forgetting_generation: forgetting,
    created_at: row.created_at,
  };
}

// 操作 1 件の表示用の値。なければ null。
export function readOperationView(
  db: SqliteDatabase,
  operationId: string,
): OperationView | null {
  return readConsistently(db, () => {
    const row = db
      .prepare(
        `SELECT ${OPERATION_COLUMNS} ${OPERATION_FROM} WHERE o.operation_id = ?`,
      )
      .get(operationId) as OperationRow | undefined;
    return row === undefined ? null : toView(db, row, forgettingGeneration(db));
  });
}

// 操作の状態とイベントの境界（最大の連番）を一つの読み取りで取る（07 §4）。
// 終端でない操作はすべて、終端の操作はその変更のイベントがまだ残っている（7 日以内）ものだけを含める。
export function readSnapshot(
  db: SqliteDatabase,
  storeGeneration: string,
): SnapshotRead {
  return readConsistently(db, () => {
    const bounds = db
      .prepare(
        'SELECT coalesce(max(sequence), 0) AS max_sequence, min(sequence) AS min_sequence FROM event_outbox WHERE store_generation = ?',
      )
      .get(storeGeneration) as {
      max_sequence: number;
      min_sequence: number | null;
    };
    const terminal = TERMINAL_STATES.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT ${OPERATION_COLUMNS} ${OPERATION_FROM} WHERE o.state NOT IN (${terminal}) OR EXISTS (SELECT 1 FROM event_outbox e WHERE e.store_generation = ? AND e.target_id = o.operation_id) ORDER BY o.created_at, o.operation_id`,
      )
      .all(...TERMINAL_STATES, storeGeneration) as OperationRow[];
    const forgetting = forgettingGeneration(db);
    return {
      store_generation: storeGeneration,
      max_sequence: bounds.max_sequence,
      min_sequence: bounds.min_sequence,
      operations: rows.map((row) => toView(db, row, forgetting)),
    };
  });
}

// 接続範囲と request_id の受付が保存済みか（07 §3）。再送の判定は DB worker の命令で行い、
// ここでは経路の版の照合（expected_revision）で、保存済みの再送を 409 にしないために使う。
export function hasReceiptForRequest(
  db: SqliteDatabase,
  commandScopeId: string,
  requestId: string,
): boolean {
  const row = db
    .prepare(
      'SELECT 1 AS found FROM command_receipts WHERE command_scope_id = ? AND request_id = ?',
    )
    .get(commandScopeId, requestId) as { found: number } | undefined;
  return row !== undefined;
}

// 端末の今の接続範囲（今回の起動で発行し、失効しておらず、期限の前のもの）。WSS の接続を結び付ける。
// 発行で前の接続範囲を無効にするため、条件に合うものは端末ごとに高々一つ。
export function readCurrentScope(
  db: SqliteDatabase,
  deviceId: string,
  coreInstanceId: string,
  now: number,
): CommandScopeRecord | null {
  const row = db
    .prepare(
      'SELECT command_scope_id, device_id, core_instance_id, issued_at, expires_at, revoked_at FROM command_scopes WHERE device_id = ? AND core_instance_id = ? AND revoked_at IS NULL AND issued_at <= ? AND expires_at > ? ORDER BY issued_at DESC, command_scope_id DESC LIMIT 1',
    )
    .get(deviceId, coreInstanceId, now, now) as CommandScopeRecord | undefined;
  return row ?? null;
}
