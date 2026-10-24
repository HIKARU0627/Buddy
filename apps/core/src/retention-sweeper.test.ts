// B06-06d1: 掃除の job の配線（計画 → 命令 → 記録 → ゲート、checkpoint・VACUUM、undo_records の掃除）。
// 期待値は手で書く。時計と命令の口は注入し、DB・実機は使わない（実 DB の削除は packages/storage の試験）。

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BudgetPurgeValue,
  CheckpointValue,
  OperationCursor,
  RetentionBatchValue,
  UndoPurgeValue,
} from '@buddy/storage';
import type { SweepRow } from '@buddy/domain';
import {
  RetentionSweeper,
  type RetentionSweepPort,
} from './retention-sweeper.js';

const T0 = Date.parse('2031-06-01T00:00:00Z');
const REGRESSED = Date.parse('2031-05-01T00:00:00Z');

const operationRow = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    family: 'operation',
    id,
    operation_state: 'succeeded',
    completed_at: '2030-01-01T00:00:00Z',
    body_erased: false,
    compensation_open: false,
    task_depends: false,
    body_delete_at: null,
    row_delete_at: null,
    ...overrides,
  }) as SweepRow;

const budgetRow = (): SweepRow => ({
  family: 'budget_month',
  budget_month: '2030-01',
  time_zone: 'UTC',
  reservations: [
    {
      reservation_id: 'r-1',
      status: 'settled',
      actual_gross: '10',
      max_liability: '10',
      overrun_reviewed: false,
      live_session_ids: [],
      approval_ids: [],
    },
  ],
  unused_approval_ids: [],
});

class FakePort implements RetentionSweepPort {
  rows: readonly SweepRow[] = [];
  readonly calls: string[] = [];
  eraseCalls: { now: number; after: OperationCursor | null }[] = [];
  budgetCalls: { month: string; now: number }[] = [];
  undoCalls: number[] = [];
  checkpointCalls = 0;
  vacuumCalls = 0;
  // 本文の削除のバッチの残りの応答（呼ばれた順）。
  bodyBatches: RetentionBatchValue[] = [];
  // 90 日の削除が止まっているか（undo_records の掃除で解ける）。
  receiptBlocked = false;
  receiptProcessed: string[] = [];

  async readRows(): Promise<readonly SweepRow[]> {
    this.calls.push('read');
    return this.rows;
  }
  async eraseDueBodies(
    now: number,
    after: OperationCursor | null,
  ): Promise<RetentionBatchValue> {
    this.calls.push('erase');
    this.eraseCalls.push({ now, after });
    const next =
      this.bodyBatches.length === 0
        ? { processed: [], skipped: [], next: null }
        : (this.bodyBatches.shift() as RetentionBatchValue);
    return next;
  }
  async purgeDueOperations(
    _now: number,
    after: OperationCursor | null,
  ): Promise<RetentionBatchValue> {
    this.calls.push('purge');
    if (this.receiptBlocked)
      return {
        processed: [],
        skipped: [
          { operation_id: 'op-receipt', reasons: ['compensation_open'] },
        ],
        next: null,
      };
    const processed = ['op-receipt'];
    this.receiptProcessed.push(...processed);
    assert.equal(after, null);
    return { processed, skipped: [], next: null };
  }
  async purgeBudgetMonth(
    month: string,
    now: number,
  ): Promise<BudgetPurgeValue> {
    this.calls.push('budget');
    this.budgetCalls.push({ month, now });
    return {
      budget_month: month,
      deleted_live_sessions: 0,
      deleted_approvals: 0,
      deleted_reservations: 1,
    };
  }
  async purgeUndoRecords(now: number): Promise<UndoPurgeValue> {
    this.calls.push('undo');
    this.undoCalls.push(now);
    this.receiptBlocked = false;
    return { purged: 1 };
  }
  async checkpoint(): Promise<CheckpointValue> {
    this.calls.push('checkpoint');
    this.checkpointCalls += 1;
    return { busy: 0, log_frames: 0, checkpointed_frames: 0 };
  }
  async vacuum(): Promise<void> {
    this.calls.push('vacuum');
    this.vacuumCalls += 1;
  }
}

const sweeper = (port: FakePort, now: () => number) =>
  new RetentionSweeper({ port, epoch: 'boot-1', now });

test('B06-06d1: the gate is closed right after start and opens after the first sweep', async () => {
  const port = new FakePort();
  const job = sweeper(port, () => T0);
  // 起動の直後（掃除の記録がない）。
  assert.equal(job.gate().search, false);
  assert.equal(job.gate().cloud_send, false);
  assert.equal(job.gate().auto_use, false);
  assert.deepEqual(job.gate().reasons, ['sweep_not_started']);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(job.gate().reasons, []);
  assert.equal(job.gate().search, true);
  assert.equal(job.gate().cloud_send, true);
  assert.equal(job.gate().auto_use, true);
  assert.deepEqual(job.gate().use_blocked, []);
});

test('B06-06d1: after the clock goes back the commands get the last checked time, personal rows still go, budget records stay', async () => {
  const port = new FakePort();
  let now = T0;
  const job = sweeper(port, () => now);
  await job.runOnce(true);
  // 巻き戻る直前の最終確認は T0。
  port.rows = [
    operationRow('op-body'),
    operationRow('op-budget', { body_erased: true }),
    budgetRow(),
  ];
  now = REGRESSED;
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  // 命令に渡す now は最終確認の時刻（T0）。戻した時刻（REGRESSED）では期限を延ばさない。
  assert.equal(port.eraseCalls.length, 1);
  assert.equal(port.eraseCalls[0]?.now, T0);
  // 予算の記録は巻き戻り中に消さない（domain の clock_regression の hold）。
  assert.deepEqual(port.budgetCalls, []);
  // ゲートは時計の巻き戻りで閉じたまま（追いつくまで）。
  assert.equal(job.gate().search, false);
  assert.ok(job.gate().reasons.includes('clock_regression'));
});

test('B06-06d1: the batch follows next and reaches rows behind more than 50 undeletable rows', async () => {
  const port = new FakePort();
  const rows: SweepRow[] = [];
  for (let index = 0; index < 120; index += 1)
    rows.push(operationRow(`op-${String(index).padStart(3, '0')}`));
  port.rows = rows;
  const first = { completed_at: 1, operation_id: 'op-050' };
  const second = { completed_at: 2, operation_id: 'op-100' };
  const skipped = (start: number, count: number) =>
    Array.from({ length: count }, (_, offset) => ({
      operation_id: `op-${String(start + offset).padStart(3, '0')}`,
      reasons: ['task_content_not_migrated'],
    }));
  port.bodyBatches = [
    { processed: [], skipped: skipped(0, 50), next: first },
    { processed: [], skipped: skipped(50, 50), next: second },
    { processed: ['op-100'], skipped: skipped(100, 19), next: null },
  ];
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(
    port.eraseCalls.map((call) => call.after),
    [null, first, second],
  );
  // 後ろの行（op-100）まで届いた。
  assert.equal(record.failed_actions, 0);
});

test('B06-06d1: checkpoint and VACUUM run after the deletions', async () => {
  const port = new FakePort();
  port.rows = [operationRow('op-body'), budgetRow()];
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(port.calls, [
    'read',
    // 90 日の削除の計画があるので、その前に取り消しの記録を片付ける。
    'undo',
    'erase',
    'purge',
    'budget',
    'checkpoint',
    'vacuum',
  ]);
  assert.equal(port.checkpointCalls, 1);
  assert.equal(port.vacuumCalls, 1);
});

test('B06-06d1: the undo_records cleanup runs before the 90-day purge and lets it proceed', async () => {
  const port = new FakePort();
  // 本文は消えていて、レシート（90 日）だけが残る操作。undo_records が補償を参照して止めている。
  port.rows = [operationRow('op-receipt', { body_erased: true })];
  port.receiptBlocked = true;
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(port.undoCalls, [T0]);
  assert.deepEqual(port.receiptProcessed, ['op-receipt']);
  // 掃除 → 90 日の削除 → checkpoint → VACUUM の順。
  assert.deepEqual(port.calls, [
    'read',
    'undo',
    'purge',
    'checkpoint',
    'vacuum',
  ]);
});
