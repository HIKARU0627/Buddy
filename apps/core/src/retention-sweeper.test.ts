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
  RetentionSweepCallError,
  RetentionSweeper,
  createRetentionSweepPort,
  type RetentionSweepPort,
  type RetentionSweeperOptions,
} from './retention-sweeper.js';
import { ManualClock, withBudgetStore } from './budget-test-support.js';

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

// 予算の月 2030-01 の 1 組。live_session・承認（予約に使った分と使わなかった分）・予約の ID は、月の文字列と別の値にする。
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
      live_session_ids: ['ls-1'],
      approval_ids: ['ap-1'],
    },
  ],
  unused_approval_ids: ['ap-2'],
});

class FakePort implements RetentionSweepPort {
  rows: readonly SweepRow[] = [];
  readonly calls: string[] = [];
  eraseCalls: { now: number; after: OperationCursor | null }[] = [];
  budgetCalls: { month: string; now: number }[] = [];
  undoCalls: number[] = [];
  checkpointCalls = 0;
  vacuumCalls = 0;
  // 命令の失敗（呼び出しごとに差し替える）。
  readError: Error | null = null;
  budgetError: Error | null = null;
  checkpointBusy = 0;
  // 呼び出しごとの busy（先頭から使い、尽きたら checkpointBusy）。
  checkpointBusyQueue: number[] = [];
  // 呼び出しごとの例外（先頭から使い、尽きたら投げない）。
  checkpointErrorQueue: (Error | null)[] = [];
  // 掃除の途中で止める関門（解放されるまで進まない）。
  gateOn: string | null = null;
  release: (() => void) | null = null;
  reached: (() => void) | null = null;
  vacuumGate: Promise<void> | null = null;
  // 本文の削除のバッチの残りの応答（呼ばれた順）。
  bodyBatches: RetentionBatchValue[] = [];
  // 90 日の削除が止まっているか（undo_records の掃除で解ける）。
  receiptBlocked = false;
  receiptProcessed: string[] = [];

  async stopAt(step: string): Promise<void> {
    if (this.gateOn !== step) return;
    await new Promise<void>((resolve) => {
      this.release = resolve;
      this.reached?.();
    });
  }
  async readRows(): Promise<readonly SweepRow[]> {
    this.calls.push('read');
    await this.stopAt('read');
    if (this.readError !== null) throw this.readError;
    return this.rows;
  }
  async eraseDueBodies(
    now: number,
    after: OperationCursor | null,
  ): Promise<RetentionBatchValue> {
    this.calls.push('erase');
    this.eraseCalls.push({ now, after });
    await this.stopAt('erase');
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
    await this.stopAt('budget');
    if (this.budgetError !== null) throw this.budgetError;
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
    const error = this.checkpointErrorQueue.shift();
    if (error) throw error;
    return {
      busy: this.checkpointBusyQueue.shift() ?? this.checkpointBusy,
      log_frames: 0,
      checkpointed_frames: 0,
    };
  }
  async vacuum(): Promise<void> {
    this.calls.push('vacuum');
    this.vacuumCalls += 1;
    await this.vacuumGate;
  }
}

// VACUUM の間隔は 0（掃除のたびに呼ばれる）。間隔の試験だけ上書きする。
const sweeper = (
  port: FakePort,
  now: () => number,
  options: Partial<RetentionSweeperOptions> = {},
) =>
  new RetentionSweeper({
    port,
    epoch: 'boot-1',
    now,
    vacuumIntervalMs: 0,
    ...options,
  });

// 待ちが終わらないときに、永久に止まらず失敗させる（停止の試験用）。
const timeoutAfter = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout: 待ちが ${ms} ms で終わりませんでした`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

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

test('B06-06d1: checkpoint and VACUUM run after the record is final, with a checkpoint after the VACUUM', async () => {
  const port = new FakePort();
  port.rows = [operationRow('op-body'), budgetRow()];
  // VACUUM は終わらせない（その間もゲートが開いていることを確かめる）。
  let finishVacuum: () => void = () => undefined;
  port.vacuumGate = new Promise<void>((resolve) => {
    finishVacuum = resolve;
  });
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(port.calls.slice(0, 5), [
    'read',
    // 90 日の削除の計画があるので、その前に取り消しの記録を片付ける。
    'undo',
    'erase',
    'purge',
    'budget',
  ]);
  // 後始末は記録の確定の後。VACUUM が終わらなくても、ゲートは開いていて idle() も待たせない。
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.calls.slice(5), ['checkpoint', 'vacuum']);
  assert.equal(job.gate().search, true);
  assert.deepEqual(job.gate().reasons, []);
  await job.idle();
  finishVacuum();
  await job.drain();
  assert.deepEqual(port.calls.slice(5), ['checkpoint', 'vacuum', 'checkpoint']);
  assert.equal(port.vacuumCalls, 1);
});

test('B06-06d1: the budget month passed to the purge is the month of the row, not a reservation, approval or live session id', async () => {
  const port = new FakePort();
  port.rows = [budgetRow()];
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  // live_session 1 件・承認 2 件（予約に使った分と使わなかった分）・予約 1 件の行があっても、月ごとに 1 回。
  assert.deepEqual(port.budgetCalls, [{ month: '2030-01', now: T0 }]);
  await job.drain();
});

test('B06-06d1: a month with only unused approvals is purged by its month', async () => {
  const port = new FakePort();
  const row = budgetRow() as Extract<SweepRow, { family: 'budget_month' }>;
  port.rows = [{ ...row, reservations: [], unused_approval_ids: ['ap-9'] }];
  const job = sweeper(port, () => T0);
  await job.runOnce(true);
  assert.deepEqual(port.budgetCalls, [{ month: '2030-01', now: T0 }]);
  await job.drain();
});

test('B06-06d1: no deletion means no checkpoint, and VACUUM follows its interval', async () => {
  const quiet = new FakePort();
  const job = sweeper(quiet, () => T0);
  await job.runOnce(true);
  await job.drain();
  assert.equal(quiet.checkpointCalls, 0);
  assert.equal(quiet.vacuumCalls, 0);

  // 間隔は起動の時刻から数える（起動の直後は VACUUM しない）。
  const port = new FakePort();
  port.rows = [budgetRow()];
  let now = T0;
  const second = sweeper(port, () => now, { vacuumIntervalMs: 60_000 });
  await second.runOnce(true);
  await second.drain();
  assert.equal(port.checkpointCalls, 1);
  assert.equal(port.vacuumCalls, 0);
  now = T0 + 60_000;
  await second.runOnce(true);
  await second.drain();
  assert.equal(port.vacuumCalls, 1);
  // 直後の掃除では呼ばない。
  now = T0 + 90_000;
  await second.runOnce(true);
  await second.drain();
  assert.equal(port.vacuumCalls, 1);
});

test('B06-06d1: a busy checkpoint skips VACUUM and is tried again after the next sweep', async () => {
  const port = new FakePort();
  port.rows = [budgetRow()];
  port.checkpointBusy = 1;
  const logs: string[] = [];
  const job = sweeper(port, () => T0, { log: (message) => logs.push(message) });
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.vacuumCalls, 0);
  assert.equal(logs.length, 1);
  port.checkpointBusy = 0;
  await job.runOnce(true);
  await job.drain();
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
  await job.drain();
  // 掃除 → 90 日の削除 → checkpoint → VACUUM → checkpoint の順。
  assert.deepEqual(port.calls, [
    'read',
    'undo',
    'purge',
    'checkpoint',
    'vacuum',
    'checkpoint',
  ]);
});

test('B06-06d1: an unexpected rejection counts as a failure and keeps the gate closed with sweep_failed', async () => {
  const port = new FakePort();
  port.rows = [budgetRow()];
  port.budgetError = new RetentionSweepCallError(
    ['transaction_failed'],
    'rejected',
  );
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'failed');
  assert.equal(record.failed_actions, 1);
  assert.deepEqual(job.gate().reasons, ['sweep_failed']);
  assert.equal(job.gate().search, false);
  await job.drain();
});

test('B06-06d1: an unknown outcome counts as a failure, an expected hold does not', async () => {
  const unknown = new FakePort();
  unknown.rows = [budgetRow()];
  unknown.budgetError = new RetentionSweepCallError(
    ['commit_failed'],
    'unknown',
  );
  const failed = await sweeper(unknown, () => T0).runOnce(true);
  assert.equal(failed.status, 'failed');

  const held = new FakePort();
  held.rows = [budgetRow()];
  held.budgetError = new RetentionSweepCallError(
    ['month_has_open_rows'],
    'rejected',
  );
  const job = sweeper(held, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.equal(record.failed_actions, 0);
});

test('B06-06d1: a read failure removes nothing and closes the gate', async () => {
  const port = new FakePort();
  port.readError = new RetentionSweepCallError(
    ['retention_op_failed'],
    'rejected',
  );
  const logs: string[] = [];
  const job = sweeper(port, () => T0, { log: (message) => logs.push(message) });
  const record = await job.runOnce(true);
  assert.equal(record.status, 'failed');
  assert.deepEqual(port.calls, ['read']);
  assert.deepEqual(job.gate().reasons, ['sweep_failed']);
  assert.equal(logs.length, 1);
});

test('B06-06d1: an unreadable clock removes nothing and closes the gate', async () => {
  const port = new FakePort();
  port.rows = [operationRow('op-body'), budgetRow()];
  // 日付として読めない時刻（年が 9999 を超える）。sweepPlan は ok: false を返す。
  const job = sweeper(port, () => 8_640_000_000_000_000);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'failed');
  assert.deepEqual(port.calls, ['read']);
  assert.equal(job.gate().search, false);
});

test('B06-06d1: use_blocked rows from the plan are copied into the record and block only that row', async () => {
  const port = new FakePort();
  // 完了済みなのに完了時刻がない操作は、期限を判定できないので残して使わない（deadline_unreadable）。
  port.rows = [operationRow('op-unreadable', { completed_at: null })];
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.use_blocked, [
    { family: 'operation', id: 'op-unreadable', reason: 'deadline_unreadable' },
  ]);
  assert.equal(job.isRowUsable('operation', 'op-unreadable'), false);
  assert.equal(job.isRowUsable('operation', 'op-other'), true);
});

test('B06-06d1: the gate is closed with sweep_running while a sweep is in progress', async () => {
  const port = new FakePort();
  port.gateOn = 'read';
  const reached = new Promise<void>((resolve) => {
    port.reached = resolve;
  });
  const job = sweeper(port, () => T0);
  const running = job.runOnce(true);
  await reached;
  assert.deepEqual(job.gate().reasons, ['sweep_running']);
  assert.equal(job.gate().cloud_send, false);
  port.release?.();
  const record = await running;
  assert.equal(record.status, 'completed');
  assert.deepEqual(job.gate().reasons, []);
});

test('B06-06d1: close() stops a running sweep at the next step without a failure record', async () => {
  const port = new FakePort();
  port.rows = [operationRow('op-body'), budgetRow()];
  port.gateOn = 'erase';
  const reached = new Promise<void>((resolve) => {
    port.reached = resolve;
  });
  const logs: string[] = [];
  const job = sweeper(port, () => T0, { log: (message) => logs.push(message) });
  const running = job.runOnce(true);
  await reached;
  job.close();
  port.release?.();
  const record = await running;
  await job.drain();
  // 本文の削除の後の 90 日の削除・予算・後始末へ進まない。失敗の記録も、ログも作らない。
  assert.deepEqual(port.calls, ['read', 'undo', 'erase']);
  assert.equal(record.status, 'running');
  assert.deepEqual(logs, []);
  assert.equal(job.gate().search, false);
});

test('B06-06d1: the timer runs the sweep again once the interval has passed, and close() stops it', async () => {
  const port = new FakePort();
  let now = T0;
  const job = sweeper(port, () => now, { sweepIntervalMs: 50 });
  job.start();
  await job.idle();
  assert.equal(port.calls.filter((call) => call === 'read').length, 1);
  // 時計を 5 分進める。定期の確認（10 ms ごと）が次の掃除を始める。
  now = T0 + 5 * 60_000;
  await new Promise((resolve) => setTimeout(resolve, 80));
  await job.idle();
  assert.equal(port.calls.filter((call) => call === 'read').length, 2);
  job.close();
  now = T0 + 20 * 60_000;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(port.calls.filter((call) => call === 'read').length, 2);
});

test('B06-06d1: a real SQLite store: the plan, the month lookup and the purge delete a due month (live session, approvals, reservation)', async () => {
  await withBudgetStore(async (harness) => {
    const month = '2030-10';
    // 2030-10（UTC）の締めは 2030-11-01。13 か月後の 2031-12-01 に消せる。
    const deleteAt = Date.parse('2031-12-01T00:00:00Z');
    harness.sql((db) => {
      db.prepare(
        'INSERT INTO budget_months (month, time_zone, month_start, month_start_time_zone, recorded_at) VALUES (?, ?, ?, ?, 1)',
      ).run(month, 'UTC', Date.UTC(2030, 9, 1), 'UTC');
      db.prepare(
        "INSERT INTO devices (device_id, device_name, platform, hub_local, token_hash, registered_at) VALUES ('dev-1', 'd', 'macos', 0, X'0000000000000000000000000000000000000000000000000000000000000000', 1000)",
      ).run();
      db.prepare(
        `INSERT INTO budget_reservations (
          reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month,
          currency, price_version, reserved_amount, max_liability, status, reservation_revision,
          approval_id, actual_gross, credit_applied, additional_spend, provider_reconciliation_id, settlement_kind,
          credit_cycle_id, settled_at, overrun_reviewed, overrun_reviewed_at, created_at, delete_at
        ) VALUES ('res-1', 'req-1', 'claude.synthetic.v1', 'llm', 'llm', 'owner_request', ?, 'XTS', 'price-1', 0, 20, 'settled', 1,
          'ap-1', 10, 0, 10, 'anthropic:req-1', 'provider', NULL, 1500, 0, NULL, 1000, ?)`,
      ).run(month, deleteAt);
      db.prepare(
        "INSERT INTO live_sessions (live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure, usage_seconds, reservation_id, started_at, ended_at, end_reason, audio_epoch, session_epoch) VALUES ('ls-1', 'dev-1', NULL, 'conversation', 'ready', 1, 'open', NULL, 'res-1', 1000, NULL, NULL, 0, 0)",
      ).run();
      db.prepare(
        "INSERT INTO budget_overage_approvals (approval_id, request_id, pool_id, budget_month, currency, max_liability, overage_remaining, status, requested_at, expires_at, decided_at, consumed_at, consumed_reservation_id) VALUES ('ap-1', 'req-1', 'llm', ?, 'XTS', 20, 0, 'consumed', 900, 5000, 1000, 1100, 'res-1')",
      ).run(month);
      db.prepare(
        "INSERT INTO budget_overage_approvals (approval_id, request_id, pool_id, budget_month, currency, max_liability, overage_remaining, status, requested_at, expires_at, decided_at, consumed_at, consumed_reservation_id) VALUES ('ap-2', 'req-2', 'llm', ?, 'XTS', 20, 0, 'rejected', 900, 5000, 1000, NULL, NULL)",
      ).run(month);
    });
    const clock = new ManualClock(deleteAt + 1000);
    const logs: string[] = [];
    const job = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: 'boot-1',
      now: clock.now,
      log: (message) => logs.push(message),
    });
    const record = await job.runOnce(true);
    await job.drain();
    assert.deepEqual(logs, []);
    assert.equal(record.status, 'completed');
    assert.equal(record.failed_actions, 0);
    const counts = harness.sql((db) => ({
      reservations: db
        .prepare('SELECT count(*) FROM budget_reservations')
        .pluck()
        .get(),
      live: db.prepare('SELECT count(*) FROM live_sessions').pluck().get(),
      approvals: db
        .prepare('SELECT count(*) FROM budget_overage_approvals')
        .pluck()
        .get(),
      months: db.prepare('SELECT count(*) FROM budget_months').pluck().get(),
    }));
    assert.deepEqual(counts, {
      reservations: 0,
      live: 0,
      approvals: 0,
      months: 1,
    });
    assert.equal(job.gate().search, true);
  });
});

test('B06-06d1: a stop while the last body erase is awaited does not record completion or open the gate', async () => {
  const port = new FakePort();
  // 完了から 8 日: 本文の削除だけが期限（90 日のレシートはまだ）。
  port.rows = [
    operationRow('op-body', { completed_at: '2031-05-24T00:00:00Z' }),
  ];
  port.gateOn = 'erase';
  const reached = new Promise<void>((resolve) => {
    port.reached = resolve;
  });
  const job = sweeper(port, () => T0);
  const running = job.runOnce(true);
  await reached;
  job.close();
  port.release?.();
  const record = await running;
  await job.drain();
  assert.deepEqual(port.calls, ['read', 'erase']);
  assert.equal(record.status, 'running');
  assert.equal(job.gate().cloud_send, false);
  assert.equal(port.checkpointCalls, 0);
});

test('B06-06d1: a stop while the last budget month purge is awaited does not record completion or open the gate', async () => {
  const port = new FakePort();
  port.rows = [budgetRow()];
  port.gateOn = 'budget';
  const reached = new Promise<void>((resolve) => {
    port.reached = resolve;
  });
  const job = sweeper(port, () => T0);
  const running = job.runOnce(true);
  await reached;
  job.close();
  port.release?.();
  const record = await running;
  await job.drain();
  assert.deepEqual(port.calls, ['read', 'budget']);
  assert.equal(record.status, 'running');
  assert.equal(job.gate().search, false);
  assert.equal(port.checkpointCalls, 0);
});

test('B06-06d1: a VACUUM deferred by its interval is carried to a later sweep that deletes nothing', async () => {
  const port = new FakePort();
  port.rows = [budgetRow()];
  let now = T0;
  const job = sweeper(port, () => now, { vacuumIntervalMs: 60_000 });
  await job.runOnce(true);
  await job.drain();
  // 初回の削除: checkpoint は済み、VACUUM は間隔で延期。
  assert.equal(port.checkpointCalls, 1);
  assert.equal(port.vacuumCalls, 0);
  // 以後は削除がない。間隔が過ぎた次の掃除の後で、延期した VACUUM を行う（その後の checkpoint つき）。
  port.rows = [];
  now = T0 + 30_000;
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.vacuumCalls, 0);
  now = T0 + 60_000;
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.vacuumCalls, 1);
  assert.equal(port.checkpointCalls, 2);
  // 済んだ後は、削除がなければ何もしない。
  now = T0 + 5 * 60_000;
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.vacuumCalls, 1);
  assert.equal(port.checkpointCalls, 2);
});

test('B06-06d1: a busy checkpoint after VACUUM keeps the maintenance pending without resetting the VACUUM time', async () => {
  const port = new FakePort();
  port.rows = [budgetRow()];
  // 1 回目の checkpoint は成功、VACUUM の後の checkpoint は busy。
  port.checkpointBusyQueue = [0, 1];
  const logs: string[] = [];
  const job = sweeper(port, () => T0, { log: (message) => logs.push(message) });
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.vacuumCalls, 1);
  assert.equal(port.checkpointCalls, 2);
  assert.equal(logs.length, 1);
  // 削除がなくても、保留した checkpoint を次の掃除の後に試す。VACUUM は済んでいるので繰り返さない。
  port.rows = [];
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.checkpointCalls, 3);
  assert.equal(port.vacuumCalls, 1);
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.checkpointCalls, 3);
});

test('B06-06d1: a rejected checkpoint after VACUUM is retried by the next sweep that deletes nothing', async () => {
  const port = new FakePort();
  port.rows = [budgetRow()];
  // 1 回目の checkpoint は成功、VACUUM の後の checkpoint は SQLITE_FULL の拒否。
  port.checkpointErrorQueue = [
    null,
    new RetentionSweepCallError(['database_full'], 'rejected'),
  ];
  const logs: string[] = [];
  const job = sweeper(port, () => T0, { log: (message) => logs.push(message) });
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.checkpointCalls, 2);
  assert.equal(port.vacuumCalls, 1);
  assert.equal(logs.length, 1);
  // 削除のない次の掃除でも、保留した checkpoint を試す。VACUUM は済んでいるので繰り返さない。
  port.rows = [];
  await job.runOnce(true);
  await job.drain();
  assert.equal(port.checkpointCalls, 3);
  assert.equal(port.vacuumCalls, 1);
});

test('B06-06d1: a send lease is refused while the gate is closed or a sweep runs, and a sweep waits for a held lease', async () => {
  const port = new FakePort();
  const job = sweeper(port, () => T0);
  // 起動の直後（掃除の記録がない）は貸さない。
  assert.equal(job.lease(), null);
  await job.runOnce(true);
  const release = job.lease();
  assert.notEqual(release, null);
  // 貸し出し中に始まった掃除は、本体に入らず（read しない）、記録は running でゲートは閉じる。
  const sweep = job.runOnce(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(port.calls.filter((call) => call === 'read').length, 1);
  assert.equal(job.record().status, 'running');
  assert.equal(job.gate().cloud_send, false);
  // 掃除が待っている間も、新しい貸し出しはしない。
  assert.equal(job.lease(), null);
  release?.();
  release?.();
  const record = await sweep;
  assert.equal(record.status, 'completed');
  assert.equal(port.calls.filter((call) => call === 'read').length, 2);
  assert.notEqual(job.lease(), null);
});

test('B06-06d1: close() while a sweep waits for a send lease ends it without a failure record', async () => {
  const port = new FakePort();
  const logs: string[] = [];
  const job = sweeper(port, () => T0, { log: (message) => logs.push(message) });
  await job.runOnce(true);
  const release = job.lease();
  const sweep = job.runOnce(true);
  job.close();
  release?.();
  const record = await sweep;
  assert.equal(record.status, 'running');
  assert.equal(port.calls.filter((call) => call === 'read').length, 1);
  assert.deepEqual(logs, []);
});

test('B06-06d1: close() ends a sweep waiting for a lease that is never released, and drain() finishes', async () => {
  const port = new FakePort();
  const logs: string[] = [];
  const job = sweeper(port, () => T0, { log: (message) => logs.push(message) });
  await job.runOnce(true);
  const release = job.lease();
  assert.notEqual(release, null);
  const sweep = job.runOnce(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 貸し出しを返さないまま停止しても、掃除は中断し、drain() も終わる。
  job.close();
  const [record] = await timeoutAfter(
    Promise.all([sweep, job.drain()]),
    10_000,
  );
  assert.equal(record.status, 'running');
  assert.equal(port.calls.filter((call) => call === 'read').length, 1);
  assert.deepEqual(logs, []);
  assert.equal(job.gate().cloud_send, false);
  // 遅れて返しても、例外も状態の崩れもない。
  release?.();
  release?.();
  assert.equal(job.record().status, 'running');
  assert.equal(job.gate().cloud_send, false);
  await job.drain();
  assert.equal(port.calls.filter((call) => call === 'read').length, 1);
});
