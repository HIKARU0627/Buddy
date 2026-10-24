// DB worker（worker_threads）とクライアント、送出の許可の境界（ADR 0018）。DB は一時ディレクトリに作って消す。
// 期待値は operation-transitions.json の手書きの経路と、0001 の制約から手で書いた値。
// external_writes は「作られて一度だけ使えた送出の許可」の数と比べる（外部送出そのものは B04）。
// 故障注入（COMMIT 前の例外・COMMIT の失敗・COMMIT 前後の worker の終了・応答なし・耐久設定の不一致）で
// 許可を返さないこと、送出意図の後の異常終了で dispatching のまま残り自動で送らないことを確かめる。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DbWorkerClient,
  DispatchPermit,
  StorageError,
  readConnectionSql,
} from './index.js';
import type {
  DbCommand,
  DbCommandMetrics,
  DbCommandOutcome,
  DbWorkerFaults,
  DbWorkerOptions,
} from './index.js';
import {
  STORE_GENERATION,
  TRANSITION_CASES,
  approveCommand,
  cancelCommand,
  createCommand,
  databasePath,
  dispatchCommand,
  openSeededDatabase,
  prepareCommand,
  resultCommand,
  withTempDir,
} from './operation-test-support.js';
import type { OperationTransitionCase } from './operation-test-support.js';

function seed(path: string): void {
  openSeededDatabase(path).close();
}

function start(
  path: string,
  options: Partial<DbWorkerOptions> = {},
): Promise<DbWorkerClient> {
  return DbWorkerClient.start({
    path,
    storeGeneration: STORE_GENERATION,
    responseTimeoutMs: 10_000,
    ...options,
  });
}

async function withClient(
  run: (path: string, client: DbWorkerClient) => Promise<void>,
  options: Partial<DbWorkerOptions> = {},
): Promise<void> {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    seed(path);
    const client = await start(path, options);
    try {
      await run(path, client);
    } finally {
      await client.close();
    }
  });
}

async function send(
  client: DbWorkerClient,
  command: DbCommand,
): Promise<DbCommandOutcome> {
  return client.submit(command).result;
}

function revision(outcome: DbCommandOutcome): string {
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
  return outcome.outcome === 'durable' ? outcome.committed_state_revision : '';
}

function permitOf(outcome: DbCommandOutcome): DispatchPermit | null {
  return outcome.outcome === 'durable' ? outcome.dispatch_permit : null;
}

// 作成・承認・準備まで進め、試行の ID を返す（state_revision は 3）。
async function toPreparing(
  client: DbWorkerClient,
  operationId: string,
): Promise<string> {
  revision(await send(client, createCommand(operationId)));
  revision(await send(client, approveCommand(operationId, '1')));
  const prepare = prepareCommand(operationId, '2');
  revision(await send(client, prepare));
  return prepare.attempt_id;
}

async function stateOf(
  client: DbWorkerClient,
  operationId: string,
): Promise<[string | undefined, string | undefined]> {
  const record = await client.query({
    kind: 'operation',
    operation_id: operationId,
  });
  return [record?.state, record?.state_revision];
}

// X06 は送出意図の COMMIT の直後（応答の前）に worker が止まる。
const CASE_FAULTS: Readonly<Record<string, DbWorkerFaults>> = {
  X06: { exitAfterCommit: 'operation.dispatch_intent' },
};
const DRIVEN = [
  'X01',
  'X02',
  'X05-before-dispatch',
  'X05-after-dispatch',
  'X06',
  'X07',
  'X08',
  'X21-auto',
];

async function drive(
  path: string,
  first: DbWorkerClient,
  entry: OperationTransitionCase,
): Promise<{ client: DbWorkerClient; writes: number }> {
  let client = first;
  let writes = 0;
  let attemptId = '';
  const op = `op-${entry.id}`;
  for (const [index, to] of entry.path.entries()) {
    // 作成の後の state_revision は 1、状態を一つ進めるごとに 1 ずつ増える。
    const expected = String(index);
    let command: DbCommand;
    if (index === 0) command = createCommand(op, { auto: to === 'approved' });
    else if (to === 'approved') command = approveCommand(op, expected);
    else if (to === 'preparing') {
      const prepare = prepareCommand(op, expected);
      attemptId = prepare.attempt_id;
      command = prepare;
    } else if (to === 'dispatching')
      command = dispatchCommand(op, expected, attemptId);
    else if (to === 'cancelled') command = cancelCommand(op, expected);
    else
      command = resultCommand(
        op,
        expected,
        attemptId,
        to as 'reconciling' | 'succeeded' | 'not_executed' | 'unknown_held',
      );
    let outcome = await send(client, command);
    if (outcome.outcome === 'unknown' && to === 'dispatching') {
      // durable ACK を失った。許可は出ていない。前の世代の終了を待ち、新しい worker で照会する。
      assert.equal(outcome.reason, 'worker_exited', entry.id);
      assert.equal(client.state, 'broken');
      await client.close();
      client = await start(path);
      assert.deepEqual(await stateOf(client, op), [
        'dispatching',
        String(index + 1),
      ]);
      // 同じ command_id の再到着は保存済みの版を返すが、送出の許可は作らない。
      outcome = await send(client, command);
      assert.equal(outcome.outcome === 'durable' && outcome.replayed, true);
      assert.equal(permitOf(outcome), null, entry.id);
    }
    assert.equal(revision(outcome), String(index + 1), `${entry.id} → ${to}`);
    const permit = permitOf(outcome);
    if (permit !== null && client.consumeDispatchPermit(permit)) writes += 1;
    if (
      to === 'approved' &&
      entry.duplicate_approve === 'returns_existing_state'
    ) {
      const second = await send(
        client,
        approveCommand(op, expected, { device_id: 'dev-2' }),
      );
      assert.equal(second.outcome === 'durable' && second.existing, true);
      assert.equal(revision(second), String(index + 1));
    }
  }
  if (entry.cancel_response === 'accepted_not_cancelled') {
    const cancel = await send(
      client,
      cancelCommand(op, String(entry.path.length)),
    );
    assert.equal(cancel.outcome, 'accepted', entry.id);
  }
  return { client, writes };
}

test('the operation transition fixtures run through the DB worker with the expected revisions, events, approvals and permits', async () => {
  const cases = TRANSITION_CASES.filter((entry) => DRIVEN.includes(entry.id));
  assert.deepEqual(
    cases.map((entry) => entry.id),
    DRIVEN,
  );
  for (const entry of cases) {
    await withTempDir(async (dir) => {
      const path = databasePath(dir);
      seed(path);
      const first = await start(path, { faults: CASE_FAULTS[entry.id] ?? {} });
      const { client, writes } = await drive(path, first, entry).catch(
        async (error: unknown) => {
          await first.close();
          throw error;
        },
      );
      try {
        const op = `op-${entry.id}`;
        const record = await client.query({
          kind: 'operation',
          operation_id: op,
        });
        assert.equal(record?.state, entry.path.at(-1), entry.id);
        assert.equal(record?.state_revision, String(entry.path.length));
        const effective = record?.approvals.filter((approval) =>
          ['valid', 'consumed'].includes(approval.status),
        );
        assert.equal(effective?.length, entry.approvals, entry.id);
        assert.equal(writes, entry.external_writes, entry.id);
        const events = await client.query({
          kind: 'events',
          after_sequence: 0,
          limit: 100,
        });
        assert.deepEqual(
          events.map((event) => event.state_revision),
          entry.path.map((_, index) => String(index + 1)),
          entry.id,
        );
      } finally {
        await client.close();
        if (client !== first) await first.close();
      }
    });
  }
});

test('the client sees the received ACK before the durable result and records timings', async () => {
  const metrics: DbCommandMetrics[] = [];
  await withClient(
    async (_path, client) => {
      assert.equal(client.storeGeneration, STORE_GENERATION);
      assert.equal(client.schemaVersion, 9);
      const order: string[] = [];
      const submission = client.submit(createCommand('op-1'));
      const received = submission.received.then((value) => {
        order.push('received');
        return value;
      });
      const result = submission.result.then((value) => {
        order.push('result');
        return value;
      });
      assert.equal(await received, true);
      assert.equal(revision(await result), '1');
      assert.deepEqual(order, ['received', 'result']);
      const receipt = await client.query({
        kind: 'command',
        command_id: (await result).command_id,
      });
      assert.equal(receipt?.status, 'durable');
      assert.equal(receipt?.committed_state_revision, '1');
    },
    { onMetrics: (entry) => metrics.push(entry) },
  );
  assert.equal(metrics.length, 1);
  const [entry] = metrics;
  assert.equal(entry?.kind, 'operation.create');
  assert.equal(entry?.outcome, 'durable');
  for (const value of [
    entry?.queue_wait_ms,
    entry?.transaction_ms,
    entry?.commit_ms,
    entry?.round_trip_ms,
  ])
    assert(typeof value === 'number' && Number.isFinite(value) && value >= 0);
});

test('a fresh dispatch intent yields one single-use permit bound to this worker generation', async () => {
  await withClient(async (_path, client) => {
    const attemptId = await toPreparing(client, 'op-1');
    const outcome = await send(client, dispatchCommand('op-1', '3', attemptId));
    assert.equal(revision(outcome), '4');
    const permit = permitOf(outcome);
    assert(permit instanceof DispatchPermit);
    assert.equal(permit.operation_id, 'op-1');
    assert.equal(permit.attempt_id, attemptId);
    assert.equal(permit.content_version, '1');
    assert.equal(permit.committed_state_revision, '4');
    assert.equal(permit.worker_generation, client.workerGeneration);
    assert.equal(permit.store_generation, STORE_GENERATION);
    assert(Object.isFrozen(permit));
    assert.equal(client.consumeDispatchPermit(permit), true);
    assert.equal(client.consumeDispatchPermit(permit), false);
    // 承認・準備・結果の記録からは許可を作らない。
    const other = await toPreparing(client, 'op-2');
    const reconcile = await send(
      client,
      resultCommand('op-1', '4', attemptId, 'reconciling'),
    );
    assert.equal(permitOf(reconcile), null);
    const second = permitOf(
      await send(client, dispatchCommand('op-2', '3', other)),
    );
    assert(second !== null);
    // 許可は作れない（コンストラクタの合言葉は公開していない）。
    assert.throws(
      () =>
        new DispatchPermit(Symbol('DispatchPermit'), {
          ...second,
        }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.reason === 'dispatch_permit_forged',
    );
    await client.close();
    // 閉じた後・別の世代では使えない。
    assert.equal(client.isDispatchPermitCurrent(second), false);
    assert.equal(client.consumeDispatchPermit(second), false);
  });
});

test('a permit from an earlier worker generation is not current after a restart', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    seed(path);
    const first = await start(path);
    const permit = await toPreparing(first, 'op-1')
      .then(async (attemptId) =>
        permitOf(await send(first, dispatchCommand('op-1', '3', attemptId))),
      )
      .finally(() => first.close());
    assert(permit !== null);
    const second = await start(path);
    try {
      assert.notEqual(second.workerGeneration, first.workerGeneration);
      assert.equal(second.isDispatchPermitCurrent(permit), false);
      assert.equal(second.consumeDispatchPermit(permit), false);
      assert.deepEqual(await stateOf(second, 'op-1'), ['dispatching', '4']);
    } finally {
      await second.close();
    }
  });
});

interface FaultCase {
  readonly name: string;
  readonly faults: DbWorkerFaults;
  readonly options?: Partial<DbWorkerOptions>;
  readonly expected: { readonly outcome: string; readonly reason: string };
  readonly brokenReason: string;
}

const FAULT_CASES: readonly FaultCase[] = [
  {
    name: 'an exception before COMMIT',
    faults: { throwBeforeCommit: 'operation.dispatch_intent' },
    expected: { outcome: 'rejected', reason: 'transaction_failed' },
    brokenReason: 'worker_halted',
  },
  {
    name: 'a failed COMMIT',
    faults: { failCommit: 'operation.dispatch_intent' },
    expected: { outcome: 'unknown', reason: 'commit_failed' },
    brokenReason: 'worker_halted',
  },
  {
    name: 'a worker exit before COMMIT',
    faults: { exitBeforeCommit: 'operation.dispatch_intent' },
    expected: { outcome: 'unknown', reason: 'worker_exited' },
    brokenReason: 'worker_exited',
  },
  {
    name: 'a worker that never answers',
    faults: { ignore: 'operation.dispatch_intent' },
    // 応答の期限は命令ごとに同じ値で、作成・承認・準備にも当たる。300 ms だと遅い実行機で
    // 準備まで時間切れになるため、無視させる送出意図がその長さで時間切れになるまで待てる値にする。
    options: { responseTimeoutMs: 3_000 },
    expected: { outcome: 'unknown', reason: 'worker_timeout' },
    brokenReason: 'worker_timeout',
  },
  {
    name: 'a weakened durability setting',
    faults: { weakenDurability: 'operation.dispatch_intent' },
    expected: { outcome: 'rejected', reason: 'durability_mismatch' },
    brokenReason: 'worker_halted',
  },
];

for (const fault of FAULT_CASES)
  test(`${fault.name} gives no dispatch permit and leaves the operation preparing`, async () => {
    await withTempDir(async (dir) => {
      const path = databasePath(dir);
      seed(path);
      const client = await start(path, {
        faults: fault.faults,
        ...fault.options,
      });
      let attemptId: string;
      try {
        attemptId = await toPreparing(client, 'op-1');
        const dispatch = dispatchCommand('op-1', '3', attemptId);
        const outcome = await send(client, dispatch);
        assert.equal(
          outcome.outcome,
          fault.expected.outcome,
          JSON.stringify(outcome),
        );
        const reason =
          outcome.outcome === 'rejected'
            ? outcome.reasons[0]
            : outcome.outcome === 'unknown'
              ? outcome.reason
              : '';
        assert.equal(reason, fault.expected.reason);
        assert.equal(permitOf(outcome), null);
        // 書込みを止めた worker へは以後の命令を送らない（送っていないので適用していない）。
        assert.equal(client.state, 'broken');
        assert.equal(client.brokenReason, fault.brokenReason);
        const after = client.submit(cancelCommand('op-1', '3'));
        assert.equal(await after.received, false);
        const refused = await after.result;
        assert.equal(refused.outcome, 'rejected');
        assert.deepEqual(refused.outcome === 'rejected' && refused.reasons, [
          'worker_unavailable',
        ]);
      } finally {
        await client.close();
      }
      // 前の世代の終了を待ってから新しい worker で照会する。送出意図は記録されていない。
      const next = await start(path);
      try {
        const record = await next.query({
          kind: 'operation',
          operation_id: 'op-1',
        });
        assert.equal(record?.state, 'preparing');
        assert.equal(record?.state_revision, '3');
        assert.equal(record?.attempts[0]?.status, 'preparing');
        assert.equal(record?.attempts[0]?.dispatch_intent_at, null);
        const events = await next.query({
          kind: 'events',
          after_sequence: 0,
          limit: 100,
        });
        assert.equal(events.length, 3);
        // 新しい命令で送出意図を記録すれば、この世代の許可が出る。
        const retry = await send(next, dispatchCommand('op-1', '3', attemptId));
        const permit = permitOf(retry);
        assert(permit !== null);
        assert.equal(permit.worker_generation, next.workerGeneration);
        assert.equal(next.consumeDispatchPermit(permit), true);
      } finally {
        await next.close();
      }
    });
  });

test('a worker exit after the dispatch intent COMMIT leaves dispatching and never re-issues a permit', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    seed(path);
    const client = await start(path, {
      faults: { exitAfterCommit: 'operation.dispatch_intent' },
    });
    const dispatch = dispatchCommand(
      'op-1',
      '3',
      await toPreparing(client, 'op-1'),
    );
    const outcome = await send(client, dispatch);
    await client.close();
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(
      outcome.outcome === 'unknown' && outcome.reason,
      'worker_exited',
    );
    assert.equal(permitOf(outcome), null);
    const next = await start(path);
    try {
      // 未 commit と決めつけずに照会すると、送出意図は保存されている。自動では送らない。
      const record = await next.query({
        kind: 'operation',
        operation_id: 'op-1',
      });
      assert.equal(record?.state, 'dispatching');
      assert.equal(record?.state_revision, '4');
      assert.notEqual(record?.attempts[0]?.dispatch_intent_at, null);
      const receipt = await next.query({
        kind: 'command',
        command_id: dispatch.command_id,
      });
      assert.equal(receipt?.committed_state_revision, '4');
      const replay = await send(next, dispatch);
      assert.equal(replay.outcome === 'durable' && replay.replayed, true);
      assert.equal(permitOf(replay), null);
      // 新しい試行で送り直すこともできない（実行中の試行は一つ）。
      const retry = await send(next, prepareCommand('op-1', '4'));
      assert.equal(retry.outcome, 'rejected');
      assert.deepEqual(retry.outcome === 'rejected' && retry.reasons, [
        'transition_not_allowed',
      ]);
      assert.deepEqual(await stateOf(next, 'op-1'), ['dispatching', '4']);
    } finally {
      await next.close();
    }
  });
});

test('the worker refuses to start when the durability settings do not read back', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    const weakened = readConnectionSql().replace(
      'PRAGMA synchronous = FULL;',
      'PRAGMA synchronous = NORMAL;',
    );
    assert.notEqual(weakened, readConnectionSql());
    await assert.rejects(
      start(path, { connectionSql: weakened }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.reason === 'write_connection_rejected' &&
        error.reasons.includes('synchronous_not_full'),
    );
    await assert.rejects(
      start('relative/buddy.sqlite'),
      (error: unknown) =>
        error instanceof StorageError &&
        error.reason === 'database_path_not_absolute',
    );
  });
});
