// 自動実行の安全停止・時間窓の件数・自動実行の一覧・取り消しの記録（設計 03「取り消しと安全停止」、
// 08 §3・§9、J12、ADR 0074・0147）。
//
// - 方針による自動承認は、承認の記録と同じ transaction で時間窓の件数を数える（08 §9）。
// - 基準を超えた自動承認は記録せず、安全停止だけを同じ transaction で残す（ADR 0147）。
// - 自動実行の一覧（auto_actions）は、方針による自動承認の操作が成功した transaction で書く。
// - 取り消しは新しい補償の操作として作り、undo_records で元の操作と結び付ける（03、ADR 0074）。
// - 停止の解除は登録済みの端末からだけ（03）。画面のロック解除の確認は Core が行う。

import {
  COMPENSATION_FAILURE_LIMIT,
  POLICY_AUTO_LIMIT,
  POLICY_AUTO_WINDOW_MINUTES,
  SAME_TARGET_REPEAT_LIMIT,
  SAME_TARGET_WINDOW_MINUTES,
  UNDO_WINDOW_MS,
  autoApprovalAllowed,
} from '@buddy/domain';
import type { AutoActionKind, AutoApprovalCounter } from '@buddy/domain';
import type { SqliteDatabase } from './connection.js';
import { runImmediate } from './operation-store.js';

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
  const recent = db
    .prepare(
      "SELECT status FROM undo_records WHERE status IN ('undone', 'failed') ORDER BY requested_at DESC, rowid DESC LIMIT ?",
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
export function resumeSafetyBreaker(
  db: SqliteDatabase,
  input: ResumeSafetyInput,
): ResumeSafetyResult {
  return runImmediate(db, (): ResumeSafetyResult => {
    const device = db
      .prepare('SELECT revoked_at FROM devices WHERE device_id = ?')
      .get(input.device_id) as { revoked_at: number | null } | undefined;
    if (device === undefined || device.revoked_at !== null)
      return { ok: false, reasons: ['device_not_registered'] };
    const row = breakerRow(db);
    if (row?.state !== 'stopped')
      return { ok: false, reasons: ['safety_not_stopped'] };
    if (String(row.safety_revision) !== input.expected_safety_revision)
      return { ok: false, reasons: ['safety_revision_changed'] };
    db.prepare(
      "UPDATE safety_breaker SET state = 'running', safety_revision = safety_revision + 1, stop_reason = NULL, stopped_at = NULL, resumed_by_device_id = ? WHERE singleton = 1",
    ).run(input.device_id);
    db.prepare('DELETE FROM safety_window_counts').run();
    return { ok: true, safety_revision: String(row.safety_revision + 1) };
  }).value;
}
