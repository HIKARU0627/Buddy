// 自動実行の安全停止・時間窓の件数・自動実行の一覧・取り消しの記録（設計 03「取り消しと安全停止」、
// 08 §3・§9、J12、ADR 0074・0147）。
//
// - 方針による自動承認は、承認の記録と同じ transaction で時間窓の件数を数える（08 §9）。
// - 基準を超えた自動承認は記録せず、安全停止だけを同じ transaction で残す（ADR 0147）。
// - 自動実行の一覧（auto_actions）は、方針による自動承認の操作が成功した transaction で書く。
// - 取り消しは新しい補償の操作として作り、undo_records で元の操作と結び付ける（03、ADR 0074）。
// - 停止の解除は登録済みの端末からだけ（03）。画面のロック解除の確認は Core が行う。
// - 一覧の照会と停止の解除は worker の safety の通り道で受ける（ADR 0152）。

import Database from 'better-sqlite3';
import {
  COMPENSATION_FAILURE_LIMIT,
  POLICY_AUTO_LIMIT,
  POLICY_AUTO_WINDOW_MINUTES,
  SAME_TARGET_REPEAT_LIMIT,
  SAME_TARGET_WINDOW_MINUTES,
  UNDO_WINDOW_MS,
  autoActionUndoState,
  autoApprovalAllowed,
} from '@buddy/domain';
import type {
  AutoActionKind,
  AutoActionUndoState,
  AutoApprovalCounter,
} from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';
import { readConsistently } from './snapshot-store.js';

export type SafetyStopReason =
  | 'rate_exceeded'
  | 'same_target_repeated'
  | 'compensation_failures'
  | 'restored_from_backup';

// 時間窓の件数の範囲（safety_window_counts.scope_key）。
export const POLICY_AUTO_SCOPE = 'policy_auto';
export const sameTargetScope = (targetKey: string): string =>
  `same_target:${targetKey}`;

interface WindowRow {
  readonly window_start: number;
  readonly count: number;
}

interface BreakerRow {
  readonly state: 'running' | 'stopped';
  readonly safety_revision: number;
  readonly stop_reason: SafetyStopReason | null;
  readonly stopped_at: number | null;
  readonly resumed_by_device_id: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function latestWindow(
  db: SqliteDatabase,
  scope: string,
): WindowRow | undefined {
  return db
    .prepare(
      'SELECT window_start, count FROM safety_window_counts WHERE scope_key = ? ORDER BY window_start DESC LIMIT 1',
    )
    .get(scope) as WindowRow | undefined;
}

function counterOf(
  row: WindowRow | undefined,
  limit: number,
  windowMinutes: number,
): AutoApprovalCounter | null {
  return row === undefined
    ? null
    : {
        window_started_at: iso(row.window_start),
        auto_approvals: row.count,
        limit,
        window_minutes: windowMinutes,
      };
}

// 窓の中なら数を足し、窓が過ぎていれば古い窓を消して新しい窓を今から始める。
function bump(
  db: SqliteDatabase,
  scope: string,
  row: WindowRow | undefined,
  now: number,
  windowMinutes: number,
): void {
  if (row !== undefined && now - row.window_start < windowMinutes * 60_000) {
    db.prepare(
      'UPDATE safety_window_counts SET count = count + 1 WHERE window_start = ? AND scope_key = ?',
    ).run(row.window_start, scope);
    return;
  }
  db.prepare('DELETE FROM safety_window_counts WHERE scope_key = ?').run(scope);
  db.prepare(
    'INSERT INTO safety_window_counts (window_start, scope_key, count) VALUES (?, ?, 1)',
  ).run(now, scope);
}

function breakerRow(db: SqliteDatabase): BreakerRow | undefined {
  return db
    .prepare('SELECT * FROM safety_breaker WHERE singleton = 1')
    .get() as BreakerRow | undefined;
}

export function safetyStopped(db: SqliteDatabase): boolean {
  return breakerRow(db)?.state === 'stopped';
}

// 安全停止にする。すでに停止中なら理由と時刻を変えない。transaction の中で呼ぶ。
export function stopSafetyBreaker(
  db: SqliteDatabase,
  now: number,
  reason: SafetyStopReason,
): void {
  if (safetyStopped(db)) return;
  db.prepare(
    `INSERT INTO safety_breaker (singleton, state, safety_revision, stop_reason, stopped_at, resumed_by_device_id)
     VALUES (1, 'stopped', 1, ?, ?, NULL)
     ON CONFLICT (singleton) DO UPDATE SET state = 'stopped', safety_revision = safety_revision + 1,
       stop_reason = excluded.stop_reason, stopped_at = excluded.stopped_at, resumed_by_device_id = NULL`,
  ).run(reason, now);
}

export type AutoApprovalBlock =
  'safety_stopped' | 'rate_exceeded' | 'same_target_repeated';

// 方針による自動承認を 1 件数える。transaction の中で、承認を書く前に呼ぶ。
// null なら数えた（呼び出し側が承認を書く）。safety_stopped なら何も書いていない。
// rate_exceeded・same_target_repeated なら安全停止だけを書いた（呼び出し側は承認を書かずに commit する）。
export function countPolicyAutoApproval(
  db: SqliteDatabase,
  now: number,
  targetKey: string,
): AutoApprovalBlock | null {
  if (safetyStopped(db)) return 'safety_stopped';
  const rate = latestWindow(db, POLICY_AUTO_SCOPE);
  if (
    !autoApprovalAllowed(
      counterOf(rate, POLICY_AUTO_LIMIT, POLICY_AUTO_WINDOW_MINUTES),
      iso(now),
    )
  ) {
    stopSafetyBreaker(db, now, 'rate_exceeded');
    return 'rate_exceeded';
  }
  const scope = sameTargetScope(targetKey);
  const same = latestWindow(db, scope);
  // 3 回目は記録せずに停止する（U300）。それまでの 2 回が窓の中にあれば止める。
  if (
    !autoApprovalAllowed(
      counterOf(same, SAME_TARGET_REPEAT_LIMIT - 1, SAME_TARGET_WINDOW_MINUTES),
      iso(now),
    )
  ) {
    stopSafetyBreaker(db, now, 'same_target_repeated');
    return 'same_target_repeated';
  }
  bump(db, POLICY_AUTO_SCOPE, rate, now, POLICY_AUTO_WINDOW_MINUTES);
  bump(db, scope, same, now, SAME_TARGET_WINDOW_MINUTES);
  return null;
}

// 自動実行の一覧へ載せる（成功した transaction の中で呼ぶ）。取り消しの期限は完了から 30 日。
export function recordAutoAction(
  db: SqliteDatabase,
  now: number,
  operationId: string,
  kind: AutoActionKind,
  policyVersion: number,
): void {
  db.prepare(
    'INSERT INTO auto_actions (operation_id, action_kind, policy_version, completed_at, undo_deadline) VALUES (?, ?, ?, ?, ?)',
  ).run(operationId, kind, policyVersion, now, now + UNDO_WINDOW_MS);
}

export type UndoStartBlock =
  'undo_target_not_auto' | 'undo_expired' | 'undo_in_progress';

// 取り消し（補償の操作）を始める。補償の操作を作る transaction の中で、操作の行を書いた後に呼ぶ。
// 対象の内容版と現在値の照合は実行の直前（B13-04）で行う。
export function startUndo(
  db: SqliteDatabase,
  now: number,
  undoId: string,
  operationId: string,
  compensationOperationId: string,
): UndoStartBlock | null {
  const action = db
    .prepare('SELECT undo_deadline FROM auto_actions WHERE operation_id = ?')
    .get(operationId) as { undo_deadline: number } | undefined;
  if (action === undefined) return 'undo_target_not_auto';
  if (now > action.undo_deadline) return 'undo_expired';
  const active = db
    .prepare(
      "SELECT 1 FROM undo_records WHERE operation_id = ? AND status IN ('in_progress', 'undone', 'unknown')",
    )
    .get(operationId);
  if (active !== undefined) return 'undo_in_progress';
  db.prepare(
    "INSERT INTO undo_records (undo_id, operation_id, compensation_operation_id, status, requested_at) VALUES (?, ?, ?, 'in_progress', ?)",
  ).run(undoId, operationId, compensationOperationId, now);
  return null;
}

// 補償の操作の状態の変化を取り消しの記録へ写す（状態を進める transaction の中で呼ぶ。U313、ADR 0155）。
// - 送出の前に取消・置き換えで止まったら、取り消しの記録を failed にして、同じ自動実行を取り消し直せるようにする。
//   失敗の連続（安全停止）には数えない（recordUndoOutcome の数え方）。
// - 未実行（not_executed）の確定の後に本人が補償の操作をやり直すときは、記録を in_progress に戻す。その間に
//   別の取り消しが始まっていれば、補償を二重にしないため、やり直しを拒否する（呼び出し側は retry_not_allowed）。
// 補償の操作でなければ何もしない。
export function syncUndoForTransition(
  db: SqliteDatabase,
  compensationOperationId: string,
  from: string,
  to: string,
): 'undo_in_progress' | null {
  if (to === 'cancelled' || to === 'superseded') {
    db.prepare(
      "UPDATE undo_records SET status = 'failed' WHERE compensation_operation_id = ? AND status = 'in_progress'",
    ).run(compensationOperationId);
    return null;
  }
  if (from !== 'not_executed') return null;
  const record = db
    .prepare(
      'SELECT operation_id, status FROM undo_records WHERE compensation_operation_id = ?',
    )
    .get(compensationOperationId) as
    { operation_id: string; status: string } | undefined;
  if (record === undefined || record.status !== 'failed') return null;
  const other = db
    .prepare(
      "SELECT 1 FROM undo_records WHERE operation_id = ? AND status IN ('in_progress', 'undone', 'unknown')",
    )
    .get(record.operation_id);
  if (other !== undefined) return 'undo_in_progress';
  db.prepare(
    "UPDATE undo_records SET status = 'in_progress' WHERE compensation_operation_id = ? AND status = 'failed'",
  ).run(compensationOperationId);
  return null;
}

export type UndoStatus = 'undone' | 'failed' | 'unknown';

// 補償の操作の結果を取り消しの記録へ写す（結果を記録する transaction の中で呼ぶ）。
// 補償の操作でなければ何もしない。失敗が 3 回続いたら安全停止にする（03）。
export function recordUndoOutcome(
  db: SqliteDatabase,
  now: number,
  compensationOperationId: string,
  status: UndoStatus,
): void {
  const updated = db
    .prepare(
      "UPDATE undo_records SET status = ? WHERE compensation_operation_id = ? AND status IN ('in_progress', 'unknown')",
    )
    .run(status, compensationOperationId);
  if (updated.changes === 0 || status !== 'failed') return;
  // 本人が取消・置き換えで止めた補償の操作は、失敗に数えない（U313、ADR 0155）。
  const recent = db
    .prepare(
      `SELECT u.status FROM undo_records u
         LEFT JOIN operations o ON o.operation_id = u.compensation_operation_id
        WHERE u.status IN ('undone', 'failed')
          AND coalesce(o.state, '') NOT IN ('cancelled', 'superseded')
        ORDER BY u.requested_at DESC, u.rowid DESC LIMIT ?`,
    )
    .pluck()
    .all(COMPENSATION_FAILURE_LIMIT) as string[];
  if (
    recent.length === COMPENSATION_FAILURE_LIMIT &&
    recent.every((value) => value === 'failed')
  )
    stopSafetyBreaker(db, now, 'compensation_failures');
}

export interface SafetyStateRecord {
  readonly state: 'running' | 'stopped';
  readonly safety_revision: string;
  readonly stop_reason: SafetyStopReason | null;
  readonly stopped_at: number | null;
  // 方針による自動承認の現在の時間窓。窓がなければ null。
  readonly auto_approvals: AutoApprovalCounter | null;
}

export function readSafetyState(db: SqliteDatabase): SafetyStateRecord {
  const row = breakerRow(db);
  return {
    state: row?.state ?? 'running',
    safety_revision: String(row?.safety_revision ?? 0),
    stop_reason: row?.stop_reason ?? null,
    stopped_at: row?.stopped_at ?? null,
    auto_approvals: counterOf(
      latestWindow(db, POLICY_AUTO_SCOPE),
      POLICY_AUTO_LIMIT,
      POLICY_AUTO_WINDOW_MINUTES,
    ),
  };
}

export interface ResumeSafetyInput {
  readonly device_id: string;
  readonly expected_safety_revision: string;
  readonly now: number;
}

export type ResumeSafetyResult =
  | { readonly ok: true; readonly safety_revision: string }
  | { readonly ok: false; readonly reasons: readonly string[] };

// 本人の画面操作による停止の解除（03）。登録済みで失効していない端末からだけ受ける。
// 解除と同時に時間窓の件数を消し、解除の直後に同じ件数で止まり直さないようにする（ADR 0147）。
// transaction の中で呼ぶ。受けられなければ理由を返し、何も書かない。
function applyResume(
  db: SqliteDatabase,
  input: ResumeSafetyInput,
): readonly string[] | null {
  const device = db
    .prepare('SELECT revoked_at FROM devices WHERE device_id = ?')
    .get(input.device_id) as { revoked_at: number | null } | undefined;
  if (device === undefined || device.revoked_at !== null)
    return ['device_not_registered'];
  const row = breakerRow(db);
  if (row?.state !== 'stopped') return ['safety_not_stopped'];
  if (String(row.safety_revision) !== input.expected_safety_revision)
    return ['safety_revision_changed'];
  db.prepare(
    "UPDATE safety_breaker SET state = 'running', safety_revision = safety_revision + 1, stop_reason = NULL, stopped_at = NULL, resumed_by_device_id = ? WHERE singleton = 1",
  ).run(input.device_id);
  db.prepare('DELETE FROM safety_window_counts').run();
  return null;
}

export function resumeSafetyBreaker(
  db: SqliteDatabase,
  input: ResumeSafetyInput,
): ResumeSafetyResult {
  return runImmediate(db, (): ResumeSafetyResult => {
    const reasons = applyResume(db, input);
    return reasons === null
      ? { ok: true, safety_revision: readSafetyState(db).safety_revision }
      : { ok: false, reasons };
  }).value;
}

// ---- 自動実行の一覧（GET /v1/auto-actions、ADR 0152） ------------------------------------------------------

// 一覧に載せる件数の上限。新しい順に返す（U309）。
export const AUTO_ACTION_LIST_LIMIT = 200;

export interface AutoActionRecord {
  readonly operation_id: string;
  readonly action_kind: AutoActionKind | 'create_note' | 'create_event';
  readonly policy_version: string;
  readonly state_revision: string;
  readonly completed_at: string;
  readonly undo_state: AutoActionUndoState;
  readonly undo_deadline: string;
  // 実行した確定 intent の内容版。版の行が無ければ null。
  readonly undo_target: {
    readonly content_version: string;
    readonly content_hash: string;
  } | null;
}

export interface AutoActionListRecord {
  readonly safety: SafetyStateRecord;
  readonly items: readonly AutoActionRecord[];
}

interface AutoActionRow {
  readonly operation_id: string;
  readonly action_kind: AutoActionRecord['action_kind'];
  readonly policy_version: number;
  readonly completed_at: number;
  readonly undo_deadline: number;
  readonly state_revision: number;
  readonly content_version: number | null;
  readonly content_hash: string | null;
  readonly active_undo: 'in_progress' | 'undone' | 'unknown' | null;
}

const AUTO_ACTION_SELECT = `SELECT a.operation_id, a.action_kind, a.policy_version, a.completed_at, a.undo_deadline,
                o.state_revision, v.content_version, v.content_hash,
                (SELECT u.status FROM undo_records u
                   WHERE u.operation_id = a.operation_id AND u.status IN ('in_progress', 'undone', 'unknown')) AS active_undo
           FROM auto_actions a
           JOIN operations o ON o.operation_id = a.operation_id
           LEFT JOIN operation_versions v
             ON v.operation_id = o.operation_id AND v.content_version = o.current_content_version`;

// 取り消しの経路（補償の操作を作る処理）がある種類だけを取り消せるように見せる。どの種類を取り消せるかは
// Core が決める（提供元の読み書きの口があるか。ADR 0153）。渡されなければどれも取り消せない（ADR 0152）。
function autoActionRecord(
  row: AutoActionRow,
  now: number,
  undoableKinds: readonly string[],
): AutoActionRecord {
  return {
    operation_id: row.operation_id,
    action_kind: row.action_kind,
    policy_version: String(row.policy_version),
    state_revision: String(row.state_revision),
    completed_at: iso(row.completed_at),
    undo_state: autoActionUndoState({
      now,
      undo_deadline: row.undo_deadline,
      active_undo: row.active_undo,
      undo_supported: undoableKinds.includes(row.action_kind),
    }),
    undo_deadline: iso(row.undo_deadline),
    undo_target:
      row.content_version === null || row.content_hash === null
        ? null
        : {
            content_version: String(row.content_version),
            content_hash: row.content_hash,
          },
  };
}

// 安全停止の状態と自動実行の一覧を一つの読み取り transaction で読む。本文（確定 intent）は読まない。
export function listAutoActions(
  db: SqliteDatabase,
  now: number,
  undoableKinds: readonly string[] = [],
): AutoActionListRecord {
  return readConsistently(db, () => {
    const rows = db
      .prepare(
        `${AUTO_ACTION_SELECT}
          ORDER BY a.completed_at DESC, a.operation_id
          LIMIT ?`,
      )
      .all(AUTO_ACTION_LIST_LIMIT) as AutoActionRow[];
    return {
      safety: readSafetyState(db),
      items: rows.map((row) => autoActionRecord(row, now, undoableKinds)),
    };
  });
}

// 自動実行を一つ読む（取り消しの経路の判定に使う。ADR 0153）。自動実行でなければ null。
export function readAutoAction(
  db: SqliteDatabase,
  operationId: string,
  now: number,
  undoableKinds: readonly string[] = [],
): AutoActionRecord | null {
  const row = db
    .prepare(`${AUTO_ACTION_SELECT} WHERE a.operation_id = ?`)
    .get(operationId) as AutoActionRow | undefined;
  return row === undefined ? null : autoActionRecord(row, now, undoableKinds);
}

// ---- worker の safety の通り道（ADR 0152） ----------------------------------------------------------------

export type SafetyOp =
  // 安全停止の状態（解除の expected_revision の照合に使う）。
  | { readonly kind: 'safety.state' }
  // 安全停止の状態と自動実行の一覧。now は取り消しの期限の判定に使う。undoable_kinds は取り消せる種類（ADR 0153）。
  | {
      readonly kind: 'safety.auto_actions';
      readonly now: number;
      readonly undoable_kinds?: readonly AutoActionKind[];
    }
  // 自動実行を一つ。自動実行でなければ値は null。
  | {
      readonly kind: 'safety.auto_action';
      readonly operation_id: string;
      readonly now: number;
      readonly undoable_kinds?: readonly AutoActionKind[];
    }
  // 停止の解除。成功すれば解除の後の状態を返す。
  | {
      readonly kind: 'safety.resume';
      readonly device_id: string;
      readonly expected_safety_revision: string;
      readonly now: number;
    };

export type SafetyOpKind = SafetyOp['kind'];

export interface SafetyOpValues {
  'safety.state': SafetyStateRecord;
  'safety.auto_actions': AutoActionListRecord;
  'safety.auto_action': AutoActionRecord | null;
  'safety.resume': SafetyStateRecord;
}

export type SafetyOpValue = SafetyOpValues[SafetyOpKind];

export type SafetyOpResult =
  | { readonly ok: true; readonly value: SafetyOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface SafetyStoreResult {
  readonly result: SafetyOpResult;
  readonly halt: boolean;
}

export const SAFETY_WRITE_OPS: ReadonlySet<SafetyOpKind> = new Set([
  'safety.resume',
]);

class SafetyRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'SafetyRejection';
    this.reasons = reasons;
  }
}

const rejected = (reasons: readonly string[]): SafetyOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

const DECIMAL = /^(0|[1-9][0-9]*)$/;

const AUTO_ACTION_KINDS: readonly AutoActionKind[] = [
  'create_task',
  'label_mail',
  'draft_reply',
  'create_event',
];

function safetyOpShapeReasons(op: SafetyOp): readonly string[] {
  if (op.kind === 'safety.state') return [];
  if (op.kind === 'safety.auto_actions' || op.kind === 'safety.auto_action') {
    const reasons: string[] = [];
    if (!Number.isFinite(op.now)) reasons.push('now_invalid');
    if (
      op.undoable_kinds !== undefined &&
      (!Array.isArray(op.undoable_kinds) ||
        !op.undoable_kinds.every((kind) => AUTO_ACTION_KINDS.includes(kind)))
    )
      reasons.push('undoable_kinds_invalid');
    if (
      op.kind === 'safety.auto_action' &&
      (typeof op.operation_id !== 'string' || op.operation_id === '')
    )
      reasons.push('operation_id_invalid');
    return reasons;
  }
  if (op.kind === 'safety.resume') {
    const reasons: string[] = [];
    if (typeof op.device_id !== 'string' || op.device_id === '')
      reasons.push('device_id_invalid');
    if (
      typeof op.expected_safety_revision !== 'string' ||
      !DECIMAL.test(op.expected_safety_revision)
    )
      reasons.push('expected_safety_revision_invalid');
    if (!Number.isFinite(op.now)) reasons.push('now_invalid');
    return reasons;
  }
  return ['kind_invalid'];
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

export function executeSafetyOp(
  db: SqliteDatabase,
  op: SafetyOp,
  context: {
    readonly platform: StoragePlatform;
    readonly halted: boolean;
    readonly beforeCommit?: (op: SafetyOp) => void;
  },
): SafetyStoreResult {
  const shape = safetyOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'safety.state')
    return { result: { ok: true, value: readSafetyState(db) }, halt: false };
  if (op.kind === 'safety.auto_actions')
    return {
      result: {
        ok: true,
        value: listAutoActions(db, op.now, op.undoable_kinds ?? []),
      },
      halt: false,
    };
  if (op.kind === 'safety.auto_action')
    return {
      result: {
        ok: true,
        value: readAutoAction(
          db,
          op.operation_id,
          op.now,
          op.undoable_kinds ?? [],
        ),
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
    const run = runImmediate(
      db,
      () => {
        const reasons = applyResume(db, op);
        if (reasons !== null) throw new SafetyRejection(reasons);
        return readSafetyState(db);
      },
      context.beforeCommit === undefined
        ? undefined
        : () => context.beforeCommit?.(op),
    );
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof SafetyRejection)
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
