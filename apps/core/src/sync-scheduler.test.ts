// 同期の周期起動（B08-06、設計 11 §1・§1A、ADR 0137）の試験。保存層と実行器は偽物にし、
// タイマーと時刻と乱数を差し替える。期待値（60 秒・±10 秒・メール 6 時間／予定 15 分・バックオフ上限 15 分）は
// 設計 11 §1 の表と文から手で書いた値で、実装から生成しない。実 API・実アカウントは使わない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ConnectionRecord,
  DbWorkerClient,
  SyncScopeRecord,
  SyncScopeSnapshot,
} from '@buddy/storage';
import type {
  SyncExecutor,
  SyncScanOutcome,
  SyncScanRequest,
} from './sync-executor.js';
import { createSyncScheduler } from './sync-scheduler.js';
import type {
  SyncSchedulerOptions,
  SyncSchedulerTarget,
} from './sync-scheduler.js';

const T0 = Date.parse('2026-01-05T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function connection(connectionId: string): ConnectionRecord {
  return {
    connection_id: connectionId,
    provider: 'google',
    status: 'active',
    access: 'read',
    granted_scopes: [],
    targets: {
      calendar_ids: ['cal-1'],
      mail_container_ids: ['INBOX'],
      attachment_kinds: ['pdf'],
      mail_lookback_days: 90,
      calendar_past_days: 30,
      calendar_future_days: 90,
      attachment_max_bytes: 10000000,
    },
    targets_state: 'complete',
    permission_revision: '1',
    scope_revision: '1',
  };
}

function scopeRecord(
  over: Partial<SyncScopeRecord> & { scope_id: string },
): SyncScopeRecord {
  return {
    connection_id: 'conn-1',
    scope_revision: '1',
    active_scan_id: null,
    active_generation: '0',
    committed_watermark: null,
    provider_cursor: null,
    executor_generation: '1',
    last_incremental_completed_at: null,
    last_full_reconciled_at: null,
    pending_incremental: false,
    pending_full: false,
    analysis_plan_complete_generation: null,
    ...over,
  };
}

const snapshotOf = (scope: SyncScopeRecord): SyncScopeSnapshot => ({
  scope,
  active_batch: null,
  last_attempt_at: null,
});

class FakeStore {
  readonly ops: string[] = [];
  readonly scopes = new Map<string, SyncScopeRecord>();
  constructor(
    private readonly connections: readonly ConnectionRecord[],
    scopes: readonly SyncScopeRecord[],
  ) {
    for (const scope of scopes) this.scopes.set(scope.scope_id, scope);
  }

  readonly client = {
    connectionTargets: async (op: { kind: string }) => {
      this.ops.push(op.kind);
      return { ok: true as const, value: this.connections };
    },
    sync: async (op: {
      kind: string;
      connection_id?: string;
      scope_id?: string;
    }) => {
      this.ops.push(op.kind);
      if (op.kind === 'sync.list_scopes')
        return {
          ok: true as const,
          value: [...this.scopes.values()]
            .filter((scope) => scope.connection_id === op.connection_id)
            .map(snapshotOf),
        };
      if (op.kind === 'sync.recover') {
        const scope = this.scopes.get(op.scope_id as string);
        if (scope === undefined)
          return {
            ok: false as const,
            outcome: 'rejected' as const,
            reasons: ['scope_not_found'],
          };
        const next: SyncScopeRecord = {
          ...scope,
          executor_generation: String(Number(scope.executor_generation) + 1),
          active_scan_id: null,
        };
        this.scopes.set(next.scope_id, next);
        return { ok: true as const, value: snapshotOf(next) };
      }
      throw new Error(`unexpected op ${op.kind}`);
    },
  } as unknown as Pick<DbWorkerClient, 'connectionTargets' | 'sync'>;
}

class FakeExecutor implements SyncExecutor {
  readonly calls: SyncScanRequest[] = [];
  handler: (request: SyncScanRequest) => Promise<SyncScanOutcome> = async (
    request,
  ) => ({
    status: 'published',
    scan_id: `scan-${this.calls.length}`,
    diff_count: 0,
    resumed: false,
    kind: 'full',
    window_end: '2026-01-20T00:00:00.000Z',
    scope: scopeRecord({ scope_id: request.scope_id }),
  });

  async runScan(request: SyncScanRequest): Promise<SyncScanOutcome> {
    this.calls.push(request);
    return this.handler(request);
  }
}

class FakeTimers {
  pending: { run: () => void; ms: number } | null = null;
  readonly setTimer = (run: () => void, ms: number): unknown => {
    this.pending = { run, ms };
    return this.pending;
  };
  readonly clearTimer = (timer: unknown): void => {
    if (this.pending === timer) this.pending = null;
  };
  fire(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.run();
  }
}

interface Harness {
  readonly store: FakeStore;
  readonly executor: FakeExecutor;
  readonly timers: FakeTimers;
  now: number;
  randomValue: number;
}

function harness(
  scopes: readonly SyncScopeRecord[],
  targets: readonly SyncSchedulerTarget[],
  over: {
    pollIntervalMs?: number;
    jitterMs?: number;
    backoffMaxMs?: number;
    withTargets?: boolean;
    onPublished?: SyncSchedulerOptions['onPublished'];
  } = {},
): { h: Harness; scheduler: ReturnType<typeof createSyncScheduler> } {
  const store = new FakeStore([connection('conn-1')], scopes);
  const executor = new FakeExecutor();
  const timers = new FakeTimers();
  const h: Harness = {
    store,
    executor,
    timers,
    now: T0,
    randomValue: 0.5,
  };
  const scheduler = createSyncScheduler({
    store: store.client,
    executor,
    ...(over.withTargets === false ? {} : { targetsFor: () => targets }),
    now: () => new Date(h.now),
    random: () => h.randomValue,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(over.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: over.pollIntervalMs }),
    ...(over.jitterMs === undefined ? {} : { jitterMs: over.jitterMs }),
    ...(over.backoffMaxMs === undefined
      ? {}
      : { backoffMaxMs: over.backoffMaxMs }),
    ...(over.onPublished === undefined
      ? {}
      : { onPublished: over.onPublished }),
  });
  return { h, scheduler };
}

const TARGETS: readonly SyncSchedulerTarget[] = [
  { account_id: 'acct-1', scope_id: 'scope-mail', resource: 'mail' },
  { account_id: 'acct-1', scope_id: 'scope-cal', resource: 'calendar' },
];

const recentScopes = (): SyncScopeRecord[] => [
  scopeRecord({
    scope_id: 'scope-mail',
    last_full_reconciled_at: iso(T0 - 60_000),
  }),
  scopeRecord({
    scope_id: 'scope-cal',
    last_full_reconciled_at: iso(T0 - 60_000),
  }),
];

test('startup recovers every scope once, then runs a full scan for each target', async () => {
  const { h, scheduler } = harness(recentScopes(), TARGETS);
  scheduler.start();
  await scheduler.idle();
  // 回復は接続一覧→取得集合の順で、走査より前に 1 回ずつ。
  assert.deepEqual(h.store.ops, [
    'connections.list',
    'sync.list_scopes',
    'sync.recover',
    'sync.recover',
  ]);
  assert.deepEqual(
    h.executor.calls.map((call) => [call.scope_id, call.kind]),
    [
      ['scope-mail', 'full'],
      ['scope-cal', 'full'],
    ],
  );
  assert.equal(h.store.scopes.get('scope-mail')?.executor_generation, '2');
  // 次の周期は 60 秒（乱数 0.5 でジッター 0）に予約される。
  assert.equal(h.timers.pending?.ms, 60_000);
  scheduler.stop();
});

test('after a publish the hook receives the target, the diff count, the published scope, the scan kind and the window end (ADR 0194)', async () => {
  const notified: [string, string, number, string, string, string][] = [];
  const { h, scheduler } = harness(recentScopes(), TARGETS, {
    onPublished: (conn, target, published) => {
      notified.push([
        conn.connection_id,
        target.scope_id,
        published.diff_count,
        published.scope.active_generation,
        published.kind,
        published.window_end,
      ]);
    },
  });
  h.executor.handler = async (request) => ({
    status: 'published',
    scan_id: 'scan-x',
    diff_count: request.resource === 'calendar' ? 2 : 0,
    resumed: false,
    kind: 'full',
    window_end: '2026-01-20T00:00:00.000Z',
    scope: scopeRecord({
      scope_id: request.scope_id,
      active_generation: request.resource === 'calendar' ? '7' : '3',
    }),
  });
  scheduler.start();
  await scheduler.idle();
  // 知らせは待たずに呼ばれるので、次の順番まで待つ。
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notified, [
    ['conn-1', 'scope-mail', 0, '3', 'full', '2026-01-20T00:00:00.000Z'],
    ['conn-1', 'scope-cal', 2, '7', 'full', '2026-01-20T00:00:00.000Z'],
  ]);
  scheduler.stop();
});

test('regular ticks run incrementals, and full scans follow the per-resource interval', async () => {
  const { h, scheduler } = harness(recentScopes(), TARGETS);
  scheduler.start();
  await scheduler.idle();
  h.executor.calls.length = 0;

  // 1 分後: どちらも増分。
  h.now = T0 + 60_000;
  h.timers.fire();
  await scheduler.idle();
  assert.deepEqual(
    h.executor.calls.map((call) => [call.scope_id, call.kind]),
    [
      ['scope-mail', 'incremental'],
      ['scope-cal', 'incremental'],
    ],
  );

  // 16 分後: 予定は全量（15 分）、メールは増分（6 時間）。
  h.executor.calls.length = 0;
  h.now = T0 + 16 * 60_000;
  h.store.scopes.set(
    'scope-cal',
    scopeRecord({
      scope_id: 'scope-cal',
      last_full_reconciled_at: iso(T0),
    }),
  );
  h.store.scopes.set(
    'scope-mail',
    scopeRecord({
      scope_id: 'scope-mail',
      last_full_reconciled_at: iso(T0),
    }),
  );
  h.timers.fire();
  await scheduler.idle();
  assert.deepEqual(
    h.executor.calls.map((call) => [call.scope_id, call.kind]),
    [
      ['scope-mail', 'incremental'],
      ['scope-cal', 'full'],
    ],
  );

  // 6 時間後: メールも全量。
  h.executor.calls.length = 0;
  h.now = T0 + 6 * 60 * 60_000;
  h.timers.fire();
  await scheduler.idle();
  assert.deepEqual(
    h.executor.calls.map((call) => [call.scope_id, call.kind]),
    [
      ['scope-mail', 'full'],
      ['scope-cal', 'full'],
    ],
  );
  scheduler.stop();
});

test('pending_full and a missing full reconciliation force a full scan on regular ticks', async () => {
  const { h, scheduler } = harness(
    [
      scopeRecord({
        scope_id: 'scope-mail',
        last_full_reconciled_at: iso(T0 - 60_000),
        pending_full: true,
      }),
      scopeRecord({ scope_id: 'scope-cal' }),
    ],
    TARGETS,
  );
  scheduler.start();
  await scheduler.idle();
  h.executor.calls.length = 0;
  h.now = T0 + 60_000;
  h.timers.fire();
  await scheduler.idle();
  assert.deepEqual(
    h.executor.calls.map((call) => [call.scope_id, call.kind]),
    [
      ['scope-mail', 'full'],
      ['scope-cal', 'full'],
    ],
  );
  scheduler.stop();
});

test('the poll delay carries the ±10 second jitter', async () => {
  const { h, scheduler } = harness(recentScopes(), TARGETS);
  h.randomValue = 0;
  scheduler.start();
  await scheduler.idle();
  assert.equal(h.timers.pending?.ms, 50_000);
  h.randomValue = 0.999999;
  h.timers.fire();
  await scheduler.idle();
  assert.ok(h.timers.pending !== null);
  assert.ok(h.timers.pending.ms > 69_999 && h.timers.pending.ms <= 70_000);
  scheduler.stop();
});

test('failed scans back the connection off exponentially up to the cap, and success resets it', async () => {
  const { h, scheduler } = harness(recentScopes(), TARGETS, {
    pollIntervalMs: 1000,
    jitterMs: 100,
    backoffMaxMs: 5000,
  });
  h.randomValue = 0.5;
  scheduler.start();
  await scheduler.idle();
  h.executor.handler = async () => ({
    status: 'failed',
    reason: 'google_api_error:rate_limited:429',
    scan_id: null,
  });
  h.executor.calls.length = 0;

  // tick 1（+1 秒）: 失敗 1 回目。バックオフは初項 1 秒。
  h.now = T0 + 1000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 2);
  // tick 2（+2 秒）: バックオフ明け（境界）に呼ばれ、失敗 2 回目。次は 2 秒。
  h.now = T0 + 2000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 4);
  // tick 3（+3 秒）: バックオフ中（+4 秒まで）は呼ばない。
  h.now = T0 + 3000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 4);
  // tick 4（+4 秒）: 呼ばれて失敗 3 回目。次は 4 秒。
  h.now = T0 + 4000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 6);
  // tick 5（+8 秒）: 失敗 4 回目。8 秒ではなく上限の 5 秒で頭打ち。
  h.now = T0 + 8000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 8);
  // tick 6（+12 秒）: 上限 5 秒のバックオフ中（+13 秒まで）は呼ばない。
  h.now = T0 + 12_000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 8);
  // 成功すると連続失敗は戻り、次の失敗は初項から数え直す。
  h.executor.handler = async (request) => ({
    status: 'published',
    scan_id: 'scan-ok',
    diff_count: 0,
    resumed: false,
    kind: 'full',
    window_end: '2026-01-20T00:00:00.000Z',
    scope: scopeRecord({ scope_id: request.scope_id }),
  });
  h.now = T0 + 13_000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 10);
  h.executor.handler = async () => ({
    status: 'failed',
    reason: 'google_api_error:server:500',
    scan_id: null,
  });
  h.now = T0 + 14_000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 12);
  // 初項 1 秒のバックオフなので、+15 秒の tick では呼ばれる。
  h.now = T0 + 15_000;
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 14);
  scheduler.stop();
});

test('stop prevents further ticks, and a tick during a pass does not overlap', async () => {
  const { h, scheduler } = harness(recentScopes(), TARGETS);
  scheduler.start();
  await scheduler.idle();
  h.executor.calls.length = 0;

  // 実行中の周期がある間は、tick が来ても重ねない。1 件目だけを保留し、残りは即時に終える。
  const gate: { release: (() => void) | null } = { release: null };
  let blocked = true;
  h.executor.handler = (request) => {
    if (blocked) {
      blocked = false;
      return new Promise((resolve) => {
        gate.release = () =>
          resolve({
            status: 'published',
            scan_id: 'scan-late',
            diff_count: 0,
            resumed: false,
            kind: 'full',
            window_end: '2026-01-20T00:00:00.000Z',
            scope: scopeRecord({ scope_id: request.scope_id }),
          });
      });
    }
    return Promise.resolve({
      status: 'published',
      scan_id: 'scan-late',
      diff_count: 0,
      resumed: false,
      kind: 'full',
      window_end: '2026-01-20T00:00:00.000Z',
      scope: scopeRecord({ scope_id: request.scope_id }),
    });
  };
  h.now = T0 + 60_000;
  h.timers.fire();
  for (let i = 0; i < 50 && h.executor.calls.length === 0; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.executor.calls.length, 1);
  // 実行中の間は次の tick が予約されず、重なった呼出しも増えない。
  assert.equal(h.timers.pending, null);
  gate.release?.();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 2);

  scheduler.stop();
  assert.equal(h.timers.pending, null);
  h.timers.fire();
  await scheduler.idle();
  assert.equal(h.executor.calls.length, 2);
});

test('without targets the startup still recovers, but nothing is scanned', async () => {
  const { h, scheduler } = harness(recentScopes(), TARGETS, {
    withTargets: false,
  });
  scheduler.start();
  await scheduler.idle();
  assert.deepEqual(h.store.ops, [
    'connections.list',
    'sync.list_scopes',
    'sync.recover',
    'sync.recover',
  ]);
  assert.equal(h.executor.calls.length, 0);
  scheduler.stop();
});
