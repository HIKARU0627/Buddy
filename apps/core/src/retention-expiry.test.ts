// B06-07a-1: 掃除の job の期限削除の配線・時計の状態ファイル・復帰・採り直し・恒久の原因の隔離・知らせ（ADR 0058）。
// 期待値は手で書く。時計・命令の口・ファイルの口は注入し、DB・実機は使わない（実 DB の削除は packages/storage の
// expiry-store.test.ts と、下の「実 SQLite」の試験）。

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BudgetBackfillValue,
  BudgetPurgeValue,
  CheckpointValue,
  ExpiryDeleteValue,
  ExpiryFamily,
  MemoryScheduleValue,
  RetentionBatchValue,
  UndoPurgeValue,
} from '@buddy/storage';
import type { SweepRow } from '@buddy/domain';
import {
  RetentionSweepCallError,
  RetentionSweeper,
  type RetentionSweepPort,
  type RetentionSweeperOptions,
} from './retention-sweeper.js';
import {
  CLOCK_STATE_SCHEMA,
  parseClockState,
  serializeClockState,
  type ClockStateContent,
  type ClockStateLoad,
  type ClockStatePort,
} from './clock-state.js';
import { RecordingNoticeSink } from './notice-sink.js';

const T0 = Date.parse('2031-06-01T00:00:00Z');
const MIN = 60_000;
const E1 = 'e1111111-1111-4111-8111-111111111111';
const E2 = 'e2222222-2222-4222-8222-222222222222';
const E3 = 'e3333333-3333-4333-8333-333333333333';
const R1 = 'f1111111-1111-4111-8111-111111111111';
const TURN_A = 'a0000000-0000-4000-8000-00000000000a';
const TURN_B = 'a0000000-0000-4000-8000-00000000000b';
const MEM_1 = 'b0000000-0000-4000-8000-000000000001';
const MEM_2 = 'b0000000-0000-4000-8000-000000000002';
const MEM_3 = 'b0000000-0000-4000-8000-000000000003';

const turnRow = (id: string, deleteAt = '2031-05-01T00:00:00Z'): SweepRow => ({
  family: 'timed',
  rule: 'turn_normal',
  id,
  anchor_at: '2031-04-01T00:00:00Z',
  delete_at: deleteAt,
});
const sourceRow = (remote: string): SweepRow => ({
  family: 'timed',
  rule: 'source_body',
  id: `google/acct/${remote}`,
  anchor_at: '2031-05-01T00:00:00Z',
  delete_at: null,
  notice_item_id: remote,
});
const operationRow = (id: string): SweepRow => ({
  family: 'operation',
  id,
  operation_state: 'succeeded',
  completed_at: '2030-01-01T00:00:00Z',
  body_erased: false,
  compensation_open: false,
  task_depends: false,
  body_delete_at: null,
  row_delete_at: null,
});
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
const memoryRow = (
  id: string,
  status: 'active' | 'review_pending',
  reviewAt: string,
  deleteAt: string | null,
): SweepRow => ({
  family: 'memory',
  id,
  status,
  review_at: reviewAt,
  delete_at: deleteAt,
});

class Port implements RetentionSweepPort {
  rows: readonly SweepRow[] = [];
  readonly calls: string[] = [];
  deleteCalls: { family: ExpiryFamily; ids: readonly string[]; now: number }[] =
    [];
  readNow: number[] = [];
  backfills: string[] = [];
  // 行ごとの命令の結果（family:id → 理由）。
  skip = new Map<string, readonly string[]>();
  callError: Error | null = null;
  memoryError = new Map<string, Error>();
  memoryCalls: string[] = [];
  bodySkips: { operation_id: string; reasons: readonly string[] }[] = [];
  eraseCalls = 0;
  budgetCalls: string[] = [];

  async readRows(now: number): Promise<readonly SweepRow[]> {
    this.calls.push('read');
    this.readNow.push(now);
    return this.rows;
  }
  async eraseDueBodies(): Promise<RetentionBatchValue> {
    this.calls.push('erase');
    this.eraseCalls += 1;
    return { processed: [], skipped: this.bodySkips, next: null };
  }
  async purgeDueOperations(): Promise<RetentionBatchValue> {
    this.calls.push('purge');
    return { processed: [], skipped: [], next: null };
  }
  async purgeBudgetMonth(month: string): Promise<BudgetPurgeValue> {
    this.calls.push('budget');
    this.budgetCalls.push(month);
    return {
      budget_month: month,
      deleted_live_sessions: 0,
      deleted_approvals: 0,
      deleted_reservations: 1,
    };
  }
  async purgeUndoRecords(): Promise<UndoPurgeValue> {
    this.calls.push('undo');
    return { purged: 0 };
  }
  async checkpoint(): Promise<CheckpointValue> {
    return { busy: 0, log_frames: 0, checkpointed_frames: 0 };
  }
  async vacuum(): Promise<void> {
    this.calls.push('vacuum');
  }
  async deleteExpired(
    family: ExpiryFamily,
    ids: readonly string[],
    now: number,
  ): Promise<ExpiryDeleteValue> {
    this.calls.push(`delete_expired:${family}`);
    this.deleteCalls.push({ family, ids, now });
    if (this.callError !== null) throw this.callError;
    const deleted: string[] = [];
    const skipped: { id: string; reasons: readonly string[] }[] = [];
    for (const id of ids) {
      const reasons = this.skip.get(`${family}:${id}`);
      if (reasons === undefined) deleted.push(id);
      else skipped.push({ id, reasons });
    }
    return { deleted, skipped };
  }
  async startMemoryReview(
    memoryId: string,
    now: number,
  ): Promise<MemoryScheduleValue> {
    this.calls.push(`start_review:${memoryId}`);
    this.memoryCalls.push(`start_review:${memoryId}@${now}`);
    const error = this.memoryError.get(memoryId);
    if (error) throw error;
    return {
      memory_id: memoryId,
      status: 'review_pending',
      review_at: 0,
      delete_at: 0,
    } as MemoryScheduleValue;
  }
  async deleteDueMemory(
    memoryId: string,
    now: number,
  ): Promise<{ readonly memory_id: string; readonly deleted: boolean }> {
    this.calls.push(`delete_due:${memoryId}`);
    this.memoryCalls.push(`delete_due:${memoryId}@${now}`);
    const error = this.memoryError.get(memoryId);
    if (error) throw error;
    return { memory_id: memoryId, deleted: true };
  }
  async backfillBudget(month: string): Promise<BudgetBackfillValue> {
    this.backfills.push(month);
    return { budget_month: month, filled: 0, still_open: 0 };
  }
}

class MemoryClockFile implements ClockStatePort {
  loaded: ClockStateLoad;
  saves: ClockStateContent[] = [];
  failSave = false;
  loads = 0;
  constructor(loaded: ClockStateLoad) {
    this.loaded = loaded;
  }
  async load(): Promise<ClockStateLoad> {
    this.loads += 1;
    return this.loaded;
  }
  async save(content: ClockStateContent): Promise<void> {
    if (this.failSave) throw new Error('disk');
    this.saves.push(content);
    this.loaded = { status: 'verified', content };
  }
}

const fileContent = (
  lastCheckedAt: string,
  overrides: Partial<ClockStateContent> = {},
): ClockStateContent => ({
  schema: CLOCK_STATE_SCHEMA,
  revision: 3,
  last_checked_at: lastCheckedAt,
  epoch: E1,
  epoch_started_at: '2031-05-31T00:00:00Z',
  written_at: '2031-05-31T00:00:00Z',
  rechecks: [],
  storage_boundary: null,
  ...overrides,
});

let epochCounter = 0;
const nextEpochs = [E2, E3];
const sweeper = (
  port: Port,
  now: () => number,
  options: Partial<RetentionSweeperOptions> = {},
) => {
  epochCounter = 0;
  return new RetentionSweeper({
    port,
    epoch: E1,
    now,
    vacuumIntervalMs: 0,
    newEpoch: () => nextEpochs[epochCounter++] ?? E3,
    newNoticeId: () => R1,
    ...options,
  });
};

test('expiry: turns, source items and derived rows are deleted by id in batches of 50 with the effective time, and only deleted ones are announced', async () => {
  const port = new Port();
  const turns = Array.from({ length: 51 }, (_, index) =>
    turnRow(
      `a0000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
    ),
  );
  port.rows = [...turns, sourceRow('msg-1'), sourceRow('msg-2')];
  port.skip.set('source_item:google/acct/msg-2', ['not_due']);
  const sink = new RecordingNoticeSink();
  const job = sweeper(port, () => T0, { notices: sink });
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(
    port.deleteCalls.map((call) => [call.family, call.ids.length, call.now]),
    [
      ['turn', 50, T0],
      ['turn', 1, T0],
      ['source_item', 2, T0],
    ],
  );
  // 知らせは実際に消せた物だけ。同じ理由（retention_due）の物は 1 つの知らせに入る（256 件まで）。発言 51 件と、
  // 元情報は元サービスの ID（msg-1 だけ。msg-2 は期限前で消えていない）。
  assert.equal(sink.notices.length, 1);
  const [notice] = sink.notices;
  assert.equal(notice?.kind, 'expired');
  assert.equal(notice?.reason, 'retention_due');
  assert.equal(notice?.forgetting_generation, null);
  assert.equal(notice?.items.length, 52);
  assert.equal(notice?.items[0]?.item_kind, 'turn');
  assert.deepEqual(notice?.items.at(-1), {
    item_kind: 'source_item',
    item_id: 'msg-1',
  });
  assert.equal(notice?.occurred_at, '2031-06-01T00:00:00Z');
  assert.equal(notice?.notice_id, R1);
});

test('expiry: a notice sink that throws or rejects never fails the sweep', async () => {
  const port = new Port();
  port.rows = [turnRow(TURN_A)];
  const throwing = sweeper(port, () => T0, {
    notices: {
      publish() {
        throw new Error('sink');
      },
    },
  });
  assert.equal((await throwing.runOnce(true)).status, 'completed');
  const rejecting = sweeper(port, () => T0, {
    notices: { publish: () => Promise.reject(new Error('sink')) },
  });
  assert.equal((await rejecting.runOnce(true)).status, 'completed');
});

test('expiry: notice item ids that do not fit the contract id pattern are never sent', async () => {
  const port = new Port();
  port.rows = [
    {
      family: 'timed',
      rule: 'source_body',
      id: 'google/acct/ok',
      anchor_at: '2031-05-01T00:00:00Z',
      delete_at: null,
      notice_item_id: 'has space',
    },
  ];
  const sink = new RecordingNoticeSink();
  const job = sweeper(port, () => T0, { notices: sink });
  assert.equal((await job.runOnce(true)).status, 'completed');
  assert.equal(sink.notices.length, 0);
});

test('expiry: memory — review due starts the review, an unanswered one is deleted, an active one past both deadlines starts then deletes', async () => {
  const port = new Port();
  port.rows = [
    // 見直し日だけ過ぎた（まだ見直し待ちの 30 日の途中）→ 見直し待ちへ。
    memoryRow(MEM_1, 'active', '2031-05-20T00:00:00Z', null),
    // 見直し待ちのまま 30 日を過ぎた → 期限削除。
    memoryRow(
      MEM_2,
      'review_pending',
      '2031-04-01T00:00:00Z',
      '2031-05-01T00:00:00Z',
    ),
    // 有効なまま止まっていて、見直し日＋30 日も過ぎた → 見直し待ちを経て削除。
    memoryRow(MEM_3, 'active', '2031-03-01T00:00:00Z', null),
  ];
  const sink = new RecordingNoticeSink();
  const job = sweeper(port, () => T0, { notices: sink });
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(port.memoryCalls, [
    `start_review:${MEM_1}@${T0}`,
    `delete_due:${MEM_2}@${T0}`,
    `start_review:${MEM_3}@${T0}`,
    `delete_due:${MEM_3}@${T0}`,
  ]);
  // 期限切れの記憶の知らせ（review_unanswered）は、消した 2 件だけ。見直し待ちにしただけの記憶は知らせない。
  assert.equal(sink.notices.length, 1);
  assert.equal(sink.notices[0]?.reason, 'review_unanswered');
  assert.deepEqual(
    sink.notices[0]?.items.map((item) => item.item_id),
    [MEM_2, MEM_3],
  );
});

test('expiry: a memory row that changed between the plan and the command is an expected hold, not a failure', async () => {
  const port = new Port();
  port.rows = [memoryRow(MEM_1, 'active', '2031-05-20T00:00:00Z', null)];
  port.memoryError.set(
    MEM_1,
    new RetentionSweepCallError(['not_active'], 'rejected'),
  );
  const record = await sweeper(port, () => T0).runOnce(true);
  assert.equal(record.status, 'completed');
  assert.equal(record.failed_actions, 0);
});

test('expiry: a clock regression gives the commands the last checked time, so a restart cannot extend a deadline (file backed)', async () => {
  const port = new Port();
  port.rows = [turnRow(TURN_A, '2031-05-31T12:00:00Z')];
  const file = new MemoryClockFile({
    status: 'verified',
    content: fileContent('2031-06-02T00:00:00Z'),
  });
  // 時計が最終確認時刻（6/2）より前の 6/1 に戻っている。期限（5/31 12:00）は最終確認時刻でも過ぎているので消える。
  const job = sweeper(port, () => T0, { clock: file });
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(
    port.deleteCalls.map((call) => call.now),
    [Date.parse('2031-06-02T00:00:00Z')],
  );
  // ゲートは時計が追いつくまで閉じたまま。
  assert.deepEqual(job.gate().reasons, ['clock_regression']);
  assert.equal(job.gate().search, false);
  // 最終確認時刻は戻さない（ファイルは 6/2 のまま。書き直さない）。
  assert.equal(file.saves.length, 0);
});

test('clock file: the first start (fresh DB) creates the file with the current time and the gate opens', async () => {
  const port = new Port();
  const file = new MemoryClockFile({ status: 'missing' });
  const job = sweeper(port, () => T0, { clock: file, freshClockState: true });
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.equal(file.saves.length >= 1, true);
  assert.equal(file.saves[0]?.revision, 1);
  assert.equal(file.saves[0]?.last_checked_at, '2031-06-01T00:00:00Z');
  assert.equal(file.saves[0]?.epoch, E1);
  assert.deepEqual(job.gate().reasons, []);
});

test('clock file: a missing file on an existing DB cannot be judged, so the gate stays closed, budget records stay, personal rows still go and no file is created', async () => {
  const port = new Port();
  port.rows = [turnRow(TURN_A), budgetRow()];
  const file = new MemoryClockFile({ status: 'missing' });
  const job = sweeper(port, () => T0, { clock: file });
  const record = await job.runOnce(true);
  // 掃除そのものは済む（個人の内容は消し続ける。U54）が、自動利用は止める。
  assert.equal(record.status, 'completed');
  assert.deepEqual(job.gate().reasons, ['clock_state_missing']);
  assert.equal(job.gate().search, false);
  assert.equal(job.gate().cloud_send, false);
  assert.equal(job.gate().auto_use, false);
  assert.equal(port.deleteCalls.length, 1);
  assert.deepEqual(port.budgetCalls, []);
  assert.deepEqual(port.backfills, []);
  assert.equal(file.saves.length, 0);
  // 周期が来てもファイルを勝手に作らない（採り直しだけが作る）。
  await job.runOnce(true);
  assert.equal(file.saves.length, 0);
  assert.deepEqual(job.gate().reasons, ['clock_state_missing']);
});

test('clock file: an unreadable file closes the gate with clock_state_invalid', async () => {
  const port = new Port();
  const file = new MemoryClockFile({ status: 'invalid', reason: 'malformed' });
  const job = sweeper(port, () => T0, { clock: file, freshClockState: true });
  await job.runOnce(true);
  // 読めないファイルは、初めての起動でも新しく作らない（壊れた状態を黙って作り直さない）。
  assert.deepEqual(job.gate().reasons, ['clock_state_invalid']);
  assert.equal(file.saves.length, 0);
});

test('clock file: the next last checked time is written before any deletion, and a write failure deletes nothing and closes the gate', async () => {
  const port = new Port();
  port.rows = [turnRow(TURN_A), operationRow('op-1')];
  const file = new MemoryClockFile({
    status: 'verified',
    content: fileContent('2031-05-31T00:00:00Z'),
  });
  const order: string[] = [];
  const original = file.save.bind(file);
  file.save = async (content) => {
    order.push('save');
    return original(content);
  };
  const job = sweeper(port, () => T0, { clock: file });
  await job.runOnce(true);
  assert.equal(file.saves.at(-1)?.last_checked_at, '2031-06-01T00:00:00Z');
  assert.equal(file.saves.at(-1)?.revision, 4);
  // 保存は削除の命令より前。
  assert.equal(order[0], 'save');
  assert.ok(port.calls.indexOf('undo') > -1);

  const failing = new Port();
  failing.rows = [turnRow(TURN_A)];
  const brokenFile = new MemoryClockFile({
    status: 'verified',
    content: fileContent('2031-05-31T00:00:00Z'),
  });
  brokenFile.failSave = true;
  const broken = sweeper(failing, () => T0, { clock: brokenFile });
  const failed = await broken.runOnce(true);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failing.deleteCalls, []);
  assert.equal(failing.eraseCalls, 0);
  assert.deepEqual(broken.gate().reasons, ['sweep_failed']);
});

test('clock file: the file round-trips and rejects every malformed shape', () => {
  const content = fileContent('2031-06-01T00:00:00Z', {
    rechecks: [
      {
        at: '2031-06-01T00:00:00Z',
        request_id: R1,
        from_last_checked_at: null,
        to_last_checked_at: '2031-06-01T00:00:00Z',
      },
    ],
    storage_boundary: { reserved: 'for 07a-2' },
  });
  assert.deepEqual(parseClockState(serializeClockState(content)), content);
  const good = JSON.parse(serializeClockState(content)) as Record<
    string,
    unknown
  >;
  const bad: Record<string, unknown>[] = [
    { ...good, schema: 'other' },
    { ...good, revision: -1 },
    { ...good, revision: 1.5 },
    { ...good, last_checked_at: '2031-02-30T00:00:00Z' },
    { ...good, last_checked_at: '2031-06-01T00:00:00+09:00' },
    { ...good, epoch: 'not-a-uuid' },
    { ...good, extra: 1 },
    { ...good, rechecks: 'x' },
    {
      ...good,
      rechecks: Array.from(
        { length: 21 },
        () => (good['rechecks'] as unknown[])[0],
      ),
    },
    { ...good, rechecks: [{ at: 'x' }] },
  ];
  for (const item of bad)
    assert.equal(
      parseClockState(JSON.stringify(item)),
      null,
      JSON.stringify(item),
    );
  // 重複キーは拒否する。
  assert.equal(
    parseClockState(
      serializeClockState(content).replace(
        '"revision":3,',
        '"revision":3,"revision":4,',
      ),
    ),
    null,
  );
  assert.equal(parseClockState('not json'), null);
});

test('recheck: a clock set too far ahead and put back is judged regressed; the person re-takes the last checked time with the values seen and a record stays', async () => {
  const port = new Port();
  const file = new MemoryClockFile({
    status: 'verified',
    content: fileContent('2032-01-01T00:00:00Z'),
  });
  const job = sweeper(port, () => T0, { clock: file });
  await job.runOnce(true);
  assert.deepEqual(job.gate().reasons, ['clock_regression']);
  const view = await job.clockStatus();
  assert.equal(view.state, 'verified');
  assert.equal(view.regressed, true);
  assert.equal(view.needs_recheck, true);
  assert.equal(view.revision, '3');
  assert.equal(view.last_checked_at, '2032-01-01T00:00:00Z');
  assert.equal(view.now, '2031-06-01T00:00:00Z');

  const result = await job.recheckClock({
    request_id: R1,
    revision: view.revision,
    observed_last_checked_at: view.last_checked_at,
    observed_now: view.now,
  });
  assert.deepEqual(result, {
    ok: true,
    last_checked_at: '2031-06-01T00:00:00Z',
  });
  const saved = file.saves.at(-1);
  assert.equal(saved?.last_checked_at, '2031-06-01T00:00:00Z');
  assert.equal(saved?.revision, 4);
  assert.deepEqual(saved?.rechecks, [
    {
      at: '2031-06-01T00:00:00Z',
      request_id: R1,
      from_last_checked_at: '2032-01-01T00:00:00Z',
      to_last_checked_at: '2031-06-01T00:00:00Z',
    },
  ]);
  // 新しい epoch で掃除し直し、済むとゲートが開く。
  await job.idle();
  await job.drain();
  assert.equal(saved?.epoch, E2);
  assert.deepEqual(job.gate().reasons, []);
  assert.equal(job.gate().search, true);
  // もう採り直すものがない。
  const again = await job.recheckClock({
    request_id: R1,
    revision: '4',
    observed_last_checked_at: '2031-06-01T00:00:00Z',
    observed_now: '2031-06-01T00:00:00Z',
  });
  assert.deepEqual(again, { ok: false, reasons: ['not_needed'] });
});

test('recheck: a missing or unreadable file is re-created by the person, never by the job', async () => {
  const port = new Port();
  const file = new MemoryClockFile({ status: 'missing' });
  const job = sweeper(port, () => T0, { clock: file });
  await job.runOnce(true);
  assert.equal(file.saves.length, 0);
  const view = await job.clockStatus();
  assert.equal(view.state, 'missing');
  assert.equal(view.revision, 'missing');
  assert.equal(view.last_checked_at, null);
  assert.equal(view.needs_recheck, true);
  const result = await job.recheckClock({
    request_id: R1,
    revision: 'missing',
    observed_last_checked_at: null,
    observed_now: view.now,
  });
  assert.deepEqual(result, {
    ok: true,
    last_checked_at: '2031-06-01T00:00:00Z',
  });
  assert.equal(file.saves.at(-1)?.revision, 1);
  assert.equal(file.saves.at(-1)?.rechecks[0]?.from_last_checked_at, null);
  await job.drain();
  assert.deepEqual(job.gate().reasons, []);
});

test('recheck: values that differ from the current state, a stale clock, a closed job and an unavailable file are refused and change nothing', async () => {
  const port = new Port();
  const file = new MemoryClockFile({
    status: 'verified',
    content: fileContent('2032-01-01T00:00:00Z'),
  });
  const job = sweeper(port, () => T0, { clock: file });
  await job.runOnce(true);
  const base: {
    request_id: string;
    revision: string;
    observed_last_checked_at: string | null;
    observed_now: string;
  } = {
    request_id: R1,
    revision: '3',
    observed_last_checked_at: '2032-01-01T00:00:00Z',
    observed_now: '2031-06-01T00:00:00Z',
  };
  const refusals: [Partial<typeof base>, string][] = [
    [{ revision: '2' }, 'revision_mismatch'],
    [{ revision: 'missing' }, 'revision_mismatch'],
    [
      { observed_last_checked_at: '2032-01-01T00:00:01Z' },
      'observed_last_checked_at_mismatch',
    ],
    [{ observed_last_checked_at: null }, 'observed_last_checked_at_mismatch'],
    // 見た「今」が 10 分より古い（別の時計・古い画面）。
    [{ observed_now: '2031-05-31T23:49:59Z' }, 'observed_now_stale'],
    [{ observed_now: '2031-06-01T00:10:01Z' }, 'observed_now_stale'],
    [{ observed_now: 'garbage' }, 'observed_now_stale'],
  ];
  const savesBefore = file.saves.length;
  for (const [override, reason] of refusals) {
    const result = await job.recheckClock({ ...base, ...override });
    assert.deepEqual(result, { ok: false, reasons: [reason] }, reason);
  }
  // 10 分ちょうどは許す側（境界）。
  assert.equal(
    (
      await job.recheckClock({
        ...base,
        observed_now: '2031-06-01T00:10:00Z',
      })
    ).ok,
    true,
  );
  assert.equal(file.saves.length, savesBefore + 1);

  const noFile = sweeper(new Port(), () => T0);
  assert.deepEqual(await noFile.recheckClock(base), {
    ok: false,
    reasons: ['clock_file_unavailable'],
  });
  job.close();
  assert.deepEqual(await job.recheckClock(base), {
    ok: false,
    reasons: ['closed'],
  });
});

test('recheck: a save failure keeps the old state and the old epoch', async () => {
  const port = new Port();
  const file = new MemoryClockFile({
    status: 'verified',
    content: fileContent('2032-01-01T00:00:00Z'),
  });
  const job = sweeper(port, () => T0, { clock: file });
  await job.runOnce(true);
  file.failSave = true;
  const result = await job.recheckClock({
    request_id: R1,
    revision: '3',
    observed_last_checked_at: '2032-01-01T00:00:00Z',
    observed_now: '2031-06-01T00:00:00Z',
  });
  assert.deepEqual(result, { ok: false, reasons: ['save_failed'] });
  assert.equal((await job.clockStatus()).epoch, E1);
  assert.deepEqual(job.gate().reasons, ['clock_regression']);
});

test('recheck: only the last 20 rechecks are kept', async () => {
  const port = new Port();
  const history = Array.from({ length: 20 }, (_, index) => ({
    at: '2031-05-01T00:00:00Z',
    request_id: R1,
    from_last_checked_at: null,
    to_last_checked_at: `2031-05-01T00:00:${String(index).padStart(2, '0')}Z`,
  }));
  const file = new MemoryClockFile({
    status: 'verified',
    content: fileContent('2032-01-01T00:00:00Z', { rechecks: history }),
  });
  const job = sweeper(port, () => T0, { clock: file });
  await job.runOnce(true);
  await job.recheckClock({
    request_id: R1,
    revision: '3',
    observed_last_checked_at: '2032-01-01T00:00:00Z',
    observed_now: '2031-06-01T00:00:00Z',
  });
  const kept = file.saves.at(-1)?.rechecks ?? [];
  assert.equal(kept.length, 20);
  assert.equal(kept[0]?.to_last_checked_at, '2031-05-01T00:00:01Z');
  assert.equal(kept.at(-1)?.to_last_checked_at, '2031-06-01T00:00:00Z');
});

test('resume: a long gap between periodic checks starts a new epoch, the old sweep no longer counts and the gate reopens only after a new sweep', async () => {
  const port = new Port();
  let now = T0;
  const job = sweeper(port, () => now);
  await job.runOnce(true);
  assert.deepEqual(job.gate().reasons, []);
  // スリープ明け: 確認が 4 分（確認の間隔 1 分の 3 倍を超える）空いた。
  now = T0 + 4 * MIN;
  job.tick();
  assert.deepEqual(job.gate().reasons, ['sweep_running']);
  assert.equal(job.gate().search, false);
  await job.idle();
  await job.drain();
  assert.deepEqual(job.gate().reasons, []);
  // 2 回目の読み出しは新しい epoch の掃除。
  assert.equal(port.readNow.length, 2);
  assert.equal(job.record().epoch, E2);
});

test('resume: a normal gap (about one minute) is not a resume and only runs the sweep when due', async () => {
  const port = new Port();
  let now = T0;
  const job = sweeper(port, () => now);
  await job.runOnce(true);
  for (let step = 1; step <= 3; step += 1) {
    now = T0 + step * MIN;
    job.tick();
    await job.idle();
  }
  assert.equal(port.readNow.length, 1);
  assert.equal(job.record().epoch, E1);
  // 5 分を過ぎた確認で通常の定期の掃除（epoch は変わらない）。
  now = T0 + 5 * MIN + 1;
  job.tick();
  await job.idle();
  assert.equal(port.readNow.length, 2);
  assert.equal(job.record().epoch, E1);
});

test('resume: the monotonic clock standing still while the wall clock advances (sleep) is a resume even when the wall gap looks small', async () => {
  const port = new Port();
  let now = T0;
  let mono = 1000;
  const job = sweeper(port, () => now, { monotonic: () => mono });
  await job.runOnce(true);
  // 壁時計は 2.5 分進んだが、単調時計は 10 秒しか進んでいない（差が確認の間隔の 2 倍を超える）。
  now = T0 + 150_000;
  mono += 10_000;
  job.tick();
  assert.deepEqual(job.gate().reasons, ['sweep_running']);
  await job.drain();
  assert.equal(job.record().epoch, E2);
  // 両方が同じだけ進めば復帰ではない。
  now += MIN;
  mono += MIN;
  job.tick();
  await job.idle();
  assert.equal(job.record().epoch, E2);
});

test('resume: a resume while a sweep is running starts one more sweep for the new epoch after it ends', async () => {
  const port = new Port();
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const readRows = port.readRows.bind(port);
  port.readRows = async (now) => {
    if (first) {
      first = false;
      await hold;
    }
    return readRows(now);
  };
  let now = T0;
  const job = sweeper(port, () => now);
  const running = job.runOnce(true);
  now = T0 + 4 * MIN;
  job.tick();
  release();
  await running;
  await job.drain();
  // 古い epoch の掃除の記録は数えない。新しい epoch の掃除が済んで開く。
  assert.equal(job.record().epoch, E2);
  assert.deepEqual(job.gate().reasons, []);
  assert.equal(port.readNow.length, 2);
});

test('undeletable rows: a permanent cause isolates only that row, the gate opens and the other rows still go', async () => {
  const port = new Port();
  port.rows = [
    turnRow(TURN_A),
    turnRow(TURN_B),
    operationRow('op-stuck'),
    operationRow('op-ok'),
  ];
  port.skip.set(`turn:${TURN_A}`, ['constraint_violation']);
  port.bodySkips = [
    { operation_id: 'op-stuck', reasons: ['constraint_violation'] },
    { operation_id: 'op-hold', reasons: ['compensation_open'] },
  ];
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.equal(record.failed_actions, 0);
  assert.deepEqual(record.use_blocked, [
    { family: 'operation', id: 'op-stuck', reason: 'undeletable' },
    { family: 'timed', id: TURN_A, reason: 'undeletable' },
  ]);
  // ゲート全体は開き、隔離した行だけが使えない。
  assert.deepEqual(job.gate().reasons, []);
  assert.equal(job.gate().search, true);
  assert.equal(job.isRowUsable('timed', TURN_A), false);
  assert.equal(job.isRowUsable('operation', 'op-stuck'), false);
  assert.equal(job.isRowUsable('timed', TURN_B), true);
  assert.equal(job.isRowUsable('operation', 'op-ok'), true);
  assert.equal(job.isRowUsable('operation', 'op-hold'), true);
  // 次の周期でも同じ行を消せなければ隔離し続ける（状態を持たず、毎回の失敗から作る）。
  const second = await job.runOnce(true);
  assert.deepEqual(second.use_blocked, record.use_blocked);
  // 原因が解けた（もう失敗しない）行は、次の掃除で隔離から外れる。
  port.skip.clear();
  port.bodySkips = [];
  const third = await job.runOnce(true);
  assert.deepEqual(third.use_blocked, []);
  assert.equal(job.isRowUsable('timed', TURN_A), true);
});

test('undeletable rows: a transient or unknown cause still counts as a failure and closes the whole gate', async () => {
  for (const reasons of [
    ['database_busy'],
    ['database_full'],
    ['something_new'],
  ]) {
    const port = new Port();
    port.rows = [turnRow(TURN_A)];
    port.skip.set(`turn:${TURN_A}`, reasons);
    const job = sweeper(port, () => T0);
    const record = await job.runOnce(true);
    assert.equal(record.status, 'failed', reasons.join());
    assert.equal(record.failed_actions, 1);
    assert.deepEqual(job.gate().reasons, ['sweep_failed']);
  }
  const unknown = new Port();
  unknown.rows = [turnRow(TURN_A)];
  unknown.callError = new RetentionSweepCallError(['commit_failed'], 'unknown');
  const record = await sweeper(unknown, () => T0).runOnce(true);
  assert.equal(record.status, 'failed');
});

test('undeletable rows: a permanent cause on a memory command isolates that memory; a thrown error is transient', async () => {
  const port = new Port();
  port.rows = [
    memoryRow(
      MEM_1,
      'review_pending',
      '2031-04-01T00:00:00Z',
      '2031-05-01T00:00:00Z',
    ),
    memoryRow(
      MEM_2,
      'review_pending',
      '2031-04-01T00:00:00Z',
      '2031-05-01T00:00:00Z',
    ),
  ];
  port.memoryError.set(
    MEM_1,
    new RetentionSweepCallError(['constraint_violation'], 'rejected'),
  );
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.use_blocked, [
    { family: 'memory', id: MEM_1, reason: 'undeletable' },
  ]);
  assert.deepEqual(port.memoryCalls, [
    `delete_due:${MEM_1}@${T0}`,
    `delete_due:${MEM_2}@${T0}`,
  ]);

  const thrown = new Port();
  thrown.rows = [
    memoryRow(
      MEM_1,
      'review_pending',
      '2031-04-01T00:00:00Z',
      '2031-05-01T00:00:00Z',
    ),
  ];
  thrown.memoryError.set(MEM_1, new Error('worker crashed'));
  assert.equal(
    (await sweeper(thrown, () => T0).runOnce(true)).status,
    'failed',
  );
});

test('undeletable rows: more than 1000 isolated rows is a mechanism fault and closes the gate', async () => {
  const port = new Port();
  const rows: SweepRow[] = [];
  for (let index = 0; index < 1001; index += 1) {
    const id = `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    rows.push(turnRow(id));
    port.skip.set(`turn:${id}`, ['constraint_violation']);
  }
  port.rows = rows;
  const job = sweeper(port, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'failed');
  assert.equal(record.use_blocked.length, 1000);
  assert.deepEqual(job.gate().reasons, ['sweep_failed']);
  // ちょうど 1000 件なら閉じない（境界）。
  const exact = new Port();
  exact.rows = rows.slice(0, 1000);
  for (const row of exact.rows)
    exact.skip.set(`turn:${row.family === 'timed' ? row.id : ''}`, [
      'constraint_violation',
    ]);
  const ok = await sweeper(exact, () => T0).runOnce(true);
  assert.equal(ok.status, 'completed');
  assert.equal(ok.use_blocked.length, 1000);
});

test('budget: the rows written before 0010 are back-filled once per month per start, and not while the clock state is unverified', async () => {
  const port = new Port();
  port.rows = [budgetRow()];
  const job = sweeper(port, () => T0);
  await job.runOnce(true);
  await job.runOnce(true);
  assert.deepEqual(port.backfills, ['2030-01']);
});

test('expiry: without a delete command in the port, a planned expiry is a failure, never a silent skip', async () => {
  const port = new Port();
  port.rows = [turnRow(TURN_A)];
  const stripped = Object.create(port) as Port;
  Object.defineProperty(stripped, 'deleteExpired', { value: undefined });
  const job = sweeper(stripped, () => T0);
  const record = await job.runOnce(true);
  assert.equal(record.status, 'failed');
});
