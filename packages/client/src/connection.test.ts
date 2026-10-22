// 端末側の接続の状態機械の試験（ADR 0025）。模擬の通信・時計で、bootstrap → スナップショット → 購読 →
// 再スナップショット、API の版、cursor、applyEvents の反映、再接続の間隔、切断中の命令をためないことを確かめる。
// 期待値（要求の順・状態・間隔・版）は試験に手で書いた値で、検査対象の関数から作っていない。

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkApiVersion } from './api-version.js';
import { reconnectDelay } from './backoff.js';
import { ClientConnection, hubConnectionOf } from './connection.js';
import type { ClientConnectionOptions } from './connection.js';
import {
  FakeClock,
  FakeTransport,
  HASH,
  IDS,
  apiError,
  bootstrapBody,
  eventMessage,
  ok,
  operation,
  schemaContract,
  settle,
  snapshotBody,
} from './test-support.js';

const contract = schemaContract();

function setup(
  options: {
    readonly clock?: FakeClock;
    readonly extra?: Partial<ClientConnectionOptions>;
  } = {},
) {
  const transport = new FakeTransport();
  const clock = options.clock ?? new FakeClock();
  const connection = new ClientConnection({
    transport,
    clock,
    contract,
    lockState: 'unlocked',
    ...options.extra,
  });
  return { transport, clock, connection };
}

async function connectLive(
  transport: FakeTransport,
  connection: ClientConnection,
  operations = [operation(IDS.op1, '1', 'awaiting_approval')],
) {
  transport.respond(
    () => ok(bootstrapBody()),
    () => ok(snapshotBody({ operations, cursor: 'cursor-5' })),
  );
  connection.start();
  await settle();
  assert.equal(connection.state.phase, 'live');
}

test('bootstrap, snapshot and subscription in order with the lock state on each request', async () => {
  const { transport, clock, connection } = setup();
  assert.equal(hubConnectionOf(connection.state), 'not_connected');
  await connectLive(transport, connection);
  assert.deepEqual(transport.paths(), [
    'GET /v1/bootstrap',
    'GET /v1/snapshot',
  ]);
  assert.deepEqual(
    transport.requests.map((request) => request.lockState),
    ['unlocked', 'unlocked'],
  );
  assert.equal(transport.streams.length, 1);
  assert.equal(transport.streams[0]?.cursor, 'cursor-5');
  const state = connection.state;
  assert.equal(hubConnectionOf(state), 'connected');
  assert.equal(state.commandScopeId, IDS.scope1);
  assert.equal(state.coreInstanceId, IDS.core1);
  assert.equal(state.view, 'full');
  assert.equal(state.lastConfirmedAt, clock.now());
  assert.deepEqual(
    state.operations.map((op) => [
      op.operation_id,
      op.state_revision,
      op.state,
    ]),
    [[IDS.op1, '1', 'awaiting_approval']],
  );
  connection.stop();
  assert.equal(transport.streams[0]?.closed, true);
  assert.deepEqual(clock.pendingTimers, []);
});

test('a different API major is not used: no snapshot, no stream, no retry', async () => {
  for (const version of ['2.0', '0.9', '01.0', '1', 'v1.0']) {
    const { transport, clock, connection } = setup();
    transport.respond(() => ok(bootstrapBody({ apiVersion: version })));
    connection.start();
    await settle();
    // 形式の違う版は Bootstrap の schema で拒否され、再接続の待ちになる。major の違い・先頭の 0 は使わない。
    if (/^[0-9]+\.[0-9]+$/u.test(version)) {
      assert.equal(connection.state.phase, 'upgrade_required', version);
      assert.equal(connection.state.reason, 'api_major_mismatch');
      assert.equal(connection.state.apiVersion, version);
      assert.deepEqual(clock.pendingTimers, [], version);
    } else {
      assert.equal(connection.state.phase, 'waiting_retry', version);
      assert.equal(connection.state.reason, 'protocol_error', version);
      connection.stop();
    }
    assert.deepEqual(transport.paths(), ['GET /v1/bootstrap'], version);
    assert.equal(transport.streams.length, 0, version);
    connection.retryNow();
    await settle();
    assert.equal(transport.requests.length, 1, version);
  }
  assert.equal(checkApiVersion('1.0'), 'compatible');
  assert.equal(checkApiVersion('1.12'), 'compatible');
  assert.equal(checkApiVersion('2.0'), 'upgrade_required');
  assert.equal(checkApiVersion('01.0'), 'upgrade_required');
  assert.equal(checkApiVersion('1.0.0'), 'upgrade_required');
});

test('401 and a certificate mismatch need re-registration and stop sending', async () => {
  const cases = [
    [apiError(401, 'unauthenticated'), 'unauthenticated'],
    [{ kind: 'certificate_mismatch' } as const, 'certificate_mismatch'],
  ] as const;
  for (const [outcome, reason] of cases) {
    const { transport, clock, connection } = setup();
    transport.respond(() => outcome);
    connection.start();
    await settle();
    assert.equal(connection.state.phase, 'reregistration_required');
    assert.equal(connection.state.reason, reason);
    assert.equal(hubConnectionOf(connection.state), 'not_connected');
    assert.deepEqual(clock.pendingTimers, []);
    await clock.advance(120_000);
    assert.equal(transport.requests.length, 1);
  }
});

test('unreachable hubs are retried with growing delays that reset after success', async () => {
  const { transport, clock, connection } = setup();
  transport.fallback(() => ({ kind: 'unreachable', reason: 'ECONNREFUSED' }));
  connection.start();
  await settle();
  assert.equal(connection.state.phase, 'waiting_retry');
  assert.equal(connection.state.reason, 'unreachable');
  assert.equal(hubConnectionOf(connection.state), 'unreachable');
  // random 0.5 は揺らぎなし。1 秒 → 2 秒 → 4 秒。
  assert.deepEqual(clock.pendingTimers, [1_000]);
  await clock.advance(1_000);
  assert.deepEqual(clock.pendingTimers, [2_000]);
  await clock.advance(2_000);
  assert.deepEqual(clock.pendingTimers, [4_000]);
  assert.equal(transport.requests.length, 3);
  transport.fallback(() => ({ kind: 'unreachable', reason: 'none' }));
  transport.respond(
    () => ok(bootstrapBody()),
    () => ok(snapshotBody()),
  );
  await clock.advance(4_000);
  assert.equal(connection.state.phase, 'live');
  assert.equal(connection.state.attempt, 0);
  // 購読の生存の確認（45 秒）だけが残る。
  assert.deepEqual(clock.pendingTimers, [45_000]);
  connection.stop();

  assert.equal(
    reconnectDelay(0, () => 0),
    800,
  );
  assert.equal(
    reconnectDelay(0, () => 0.5),
    1_000,
  );
  assert.equal(
    reconnectDelay(3, () => 0.5),
    8_000,
  );
  assert.equal(
    reconnectDelay(10, () => 0.999),
    60_000,
  );
  assert.equal(
    reconnectDelay(10, () => 0),
    48_000,
  );
});

test('events are applied with applyEvents; duplicates and stale versions are ignored; changed operations are fetched again', async () => {
  const { transport, connection } = setup();
  await connectLive(transport, connection, [
    operation(IDS.op1, '1', 'awaiting_approval'),
  ]);
  const stream = transport.streams[0];
  assert(stream);
  transport.respond(() => ok(operation(IDS.op1, '2', 'approved')));
  stream.send(eventMessage(IDS.event1, IDS.op1, '2', '6'));
  await settle();
  assert.deepEqual(transport.paths().slice(2), [
    `GET /v1/operations/${IDS.op1}`,
  ]);
  assert.equal(connection.state.cursor, 'cursor-6');
  assert.deepEqual(
    connection.state.operations.map((op) => [op.state_revision, op.state]),
    [['2', 'approved']],
  );
  // 重複（同じ event_id）・古い版は取り直さない。cursor は受け取った位置へ進める。
  stream.send(eventMessage(IDS.event1, IDS.op1, '2', '6'));
  stream.send(eventMessage(IDS.event2, IDS.op1, '1', '7'));
  await settle();
  assert.equal(transport.requests.length, 3);
  assert.equal(connection.state.cursor, 'cursor-7');
  // 新しい操作もイベントから取り直して表示に加える。
  transport.respond(() => ok(operation(IDS.op2, '1', 'awaiting_approval')));
  stream.send(eventMessage(IDS.event3, IDS.op2, '1', '8'));
  await settle();
  assert.deepEqual(
    connection.state.operations.map((op) => op.operation_id),
    [IDS.op1, IDS.op2],
  );
  connection.stop();
});

test('resnapshot requests restart from bootstrap and snapshot; a generation change replaces the view', async () => {
  const { transport, connection } = setup();
  await connectLive(transport, connection);
  transport.respond(
    () => ok(bootstrapBody({ scope: IDS.scope2 })),
    () =>
      ok(
        snapshotBody({
          cursor: 'cursor-9',
          operations: [operation(IDS.op1, '3', 'succeeded')],
        }),
      ),
  );
  transport.streams[0]?.send({
    type: 'resnapshot_required',
    reason: 'history_expired',
  });
  transport.streams[0]?.closeFromServer(4410, 'history_expired');
  await settle();
  assert.deepEqual(transport.paths(), [
    'GET /v1/bootstrap',
    'GET /v1/snapshot',
    'GET /v1/bootstrap',
    'GET /v1/snapshot',
  ]);
  assert.equal(connection.state.phase, 'live');
  assert.equal(connection.state.commandScopeId, IDS.scope2);
  assert.equal(transport.streams[1]?.cursor, 'cursor-9');
  assert.equal(transport.streams[0]?.closed, true);

  // 再接続で DB 世代が変わった（復元など）: cursor を使わずにスナップショットから。
  transport.respond(
    () => ok(bootstrapBody({ generation: IDS.generation2, scope: IDS.scope3 })),
    () =>
      ok(
        snapshotBody({
          generation: IDS.generation2,
          cursor: 'cursor-1',
          operations: [operation(IDS.op2, '1', 'awaiting_approval')],
        }),
      ),
  );
  transport.streams[1]?.closeFromServer(1006);
  await settle();
  connection.retryNow();
  await settle();
  assert.equal(connection.state.storeGeneration, IDS.generation2);
  assert.deepEqual(
    connection.state.operations.map((op) => op.operation_id),
    [IDS.op2],
  );
  assert.equal(transport.streams[2]?.cursor, 'cursor-1');
  connection.stop();
});

test('after a hub restart the client takes a new scope and resumes the stream from its cursor without a snapshot', async () => {
  const { transport, clock, connection } = setup();
  await connectLive(transport, connection);
  transport.streams[0]?.closeFromServer(1001, 'core_stopping');
  await settle();
  assert.equal(connection.state.phase, 'waiting_retry');
  assert.equal(connection.state.reason, 'core_stopping');
  assert.equal(connection.state.commandScopeId, null);
  // 停止中の操作の表示は残す（同じ ID・版・状態）。
  assert.deepEqual(
    connection.state.operations.map((op) => [
      op.operation_id,
      op.state_revision,
    ]),
    [[IDS.op1, '1']],
  );
  transport.respond(
    () => ok(bootstrapBody({ core: IDS.core2, scope: IDS.scope2 })),
    () => ok(operation(IDS.op1, '4', 'unknown_held')),
  );
  await clock.advance(1_000);
  assert.deepEqual(transport.paths().slice(2), ['GET /v1/bootstrap']);
  assert.equal(transport.streams[1]?.cursor, 'cursor-5');
  assert.equal(connection.state.coreInstanceId, IDS.core2);
  assert.equal(connection.state.commandScopeId, IDS.scope2);
  // 欠けたイベント（再起動の回復）を cursor の後から受け取る。
  transport.streams[1]?.send(eventMessage(IDS.event1, IDS.op1, '4', '6'));
  await settle();
  assert.deepEqual(
    connection.state.operations.map((op) => [op.state_revision, op.state]),
    [['4', 'unknown_held']],
  );
  connection.stop();
});

test('close codes: 4401 needs re-registration, 4403 waits outside the home network, 422 on the cursor resnapshots', async () => {
  {
    const { transport, clock, connection } = setup();
    await connectLive(transport, connection);
    transport.streams[0]?.closeFromServer(4401, 'device_revoked');
    await settle();
    assert.equal(connection.state.phase, 'reregistration_required');
    assert.equal(connection.state.reason, 'device_revoked');
    assert.deepEqual(connection.state.operations, []);
    assert.deepEqual(clock.pendingTimers, []);
  }
  {
    const { transport, connection } = setup();
    await connectLive(transport, connection);
    transport.streams[0]?.closeFromServer(4403, 'outside_home_network');
    await settle();
    assert.equal(connection.state.phase, 'waiting_retry');
    assert.equal(connection.state.reason, 'outside_home_network');
    transport.respond(
      () => ok(bootstrapBody({ scope: IDS.scope2 })),
      () => ok(bootstrapBody({ scope: IDS.scope3 })),
      () => ok(snapshotBody({ cursor: 'cursor-20' })),
    );
    transport.nextStream = () => ({
      kind: 'rejected',
      status: 422,
      body: { code: 'invalid_input', message: 'x', request_id: null },
    });
    connection.retryNow();
    await settle();
    // cursor が使えなければスナップショットから購読し直す。
    assert.deepEqual(transport.paths().slice(2), [
      'GET /v1/bootstrap',
      'GET /v1/bootstrap',
      'GET /v1/snapshot',
    ]);
    assert.equal(connection.state.phase, 'live');
    assert.equal(transport.streams.at(-1)?.cursor, 'cursor-20');
    connection.stop();
  }
});

test('403 outside the home network on bootstrap is retried; other unexpected answers are protocol errors', async () => {
  const { transport, connection } = setup();
  transport.respond(() => apiError(403, 'outside_home_network'));
  connection.start();
  await settle();
  assert.equal(connection.state.phase, 'waiting_retry');
  assert.equal(connection.state.reason, 'outside_home_network');
  transport.respond(() => ok({ not: 'a bootstrap' }));
  connection.retryNow();
  await settle();
  assert.equal(connection.state.reason, 'protocol_error');
  connection.stop();
});

test('commands are never queued while disconnected and are not sent after reconnection', async () => {
  const clock = new FakeClock(undefined, 0.5, [IDS.request1, IDS.request2]);
  const { transport, connection } = setup({ clock });
  const cancel = {
    kind: 'cancel',
    operationId: IDS.op1,
    expectedStateRevision: '1',
  } as const;
  assert.deepEqual(await connection.send(cancel), {
    kind: 'not_sent',
    reason: 'not_connected',
  });
  transport.fallback(() => ({ kind: 'unreachable', reason: 'down' }));
  connection.start();
  await settle();
  assert.deepEqual(await connection.send(cancel), {
    kind: 'not_sent',
    reason: 'not_connected',
  });
  transport.respond(
    () => ok(bootstrapBody({ scope: IDS.scope2 })),
    () =>
      ok(
        snapshotBody({
          operations: [operation(IDS.op1, '1', 'awaiting_approval')],
        }),
      ),
  );
  await clock.advance(1_000);
  assert.equal(connection.state.phase, 'live');
  // 復帰しても、切断中の命令は送っていない。
  assert(transport.requests.every((request) => request.method === 'GET'));

  // 今の接続範囲と違う範囲で作った命令・ロック中の命令は送らない。
  assert.deepEqual(
    await connection.send({ ...cancel, commandScopeId: IDS.scope1 }),
    { kind: 'not_sent', reason: 'scope_changed' },
  );
  transport.respond(
    () =>
      ok(
        {
          request_id: IDS.request1,
          command_id: '80000000-0000-4000-8000-000000000001',
          operation_id: IDS.op1,
          state_revision: '2',
          status: 'durable',
          committed_state_revision: '2',
        },
        202,
      ),
    () => ({ kind: 'unreachable', reason: 'reset' }),
  );
  const sent = await connection.send({ ...cancel, commandScopeId: IDS.scope2 });
  assert.equal(sent.kind, 'accepted');
  const post = transport.requests.at(-1);
  assert.equal(post?.path, `/v1/operations/${IDS.op1}/cancel`);
  assert.deepEqual(post?.body, {
    request_id: IDS.request1,
    command_scope_id: IDS.scope2,
    expected_state_revision: '1',
  });
  // 結果が分からない命令は unknown で、自動で再送しない。
  const count = transport.requests.length;
  assert.deepEqual(await connection.send(cancel), {
    kind: 'unknown',
    requestId: IDS.request2,
  });
  await settle();
  assert.equal(transport.requests.length, count + 1);
  connection.setLockState('locked');
  assert.deepEqual(await connection.send(cancel), {
    kind: 'not_sent',
    reason: 'device_locked',
  });
  connection.stop();
});

test('approve is sent as a screen operation with the preview and content binding', async () => {
  const clock = new FakeClock(undefined, 0.5, [IDS.request1]);
  const { transport, connection } = setup({ clock });
  await connectLive(transport, connection);
  transport.respond(() => apiError(409, 'conflict'));
  const outcome = await connection.send({
    kind: 'approve',
    operationId: IDS.op1,
    previewId: IDS.op2,
    contentVersion: '1',
    contentHash: HASH,
    expectedStateRevision: '1',
  });
  assert.deepEqual(outcome, {
    kind: 'rejected',
    requestId: IDS.request1,
    status: 409,
    code: 'conflict',
  });
  const request = transport.requests.at(-1);
  assert.equal(request?.screenOperation, true);
  assert.deepEqual(request?.body, {
    request_id: IDS.request1,
    command_scope_id: IDS.scope1,
    expected_state_revision: '1',
    preview_id: IDS.op2,
    content_version: '1',
    content_hash: HASH,
  });
  connection.stop();
});

test('locking hides operations at once and takes a management-only snapshot; unlocking takes a full one', async () => {
  const { transport, connection } = setup();
  await connectLive(transport, connection);
  transport.respond(() =>
    ok(snapshotBody({ lock: 'locked', cursor: 'cursor-6' })),
  );
  connection.setLockState('locked');
  assert.deepEqual(connection.state.operations, []);
  assert.equal(connection.state.view, 'management_only');
  await settle();
  assert.equal(transport.requests.at(-1)?.lockState, 'locked');
  assert.equal(transport.requests.at(-1)?.path, '/v1/snapshot');
  // ロック中のイベントは版だけ追い、取り直さない。
  transport.streams[0]?.send(eventMessage(IDS.event1, IDS.op1, '2', '7'));
  await settle();
  assert.equal(transport.requests.length, 3);
  transport.respond(() =>
    ok(snapshotBody({ operations: [operation(IDS.op1, '2', 'approved')] })),
  );
  connection.setLockState('unlocked');
  await settle();
  // 状態は呼ぶたびに読み直す（前のアサーションの型の絞り込みを持ち越さない）。
  const after = (): typeof connection.state => connection.state;
  assert.equal(after().view, 'full');
  assert.deepEqual(
    after().operations.map((op) => op.state),
    ['approved'],
  );
  // 購読は開き直さない。
  assert.equal(transport.streams.length, 1);
  connection.stop();
});

// レビューの指摘 M1: 購読の途中（subscribing）にロック・解除が変わっても、live になった後の表示の範囲が
// 今のロック状態に合うこと。
test('locking while subscribing and unlocking after live shows the full view again', async () => {
  const { transport, connection } = setup();
  let open = () => undefined as void;
  transport.nextStreamGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  transport.respond(
    () => ok(bootstrapBody()),
    () =>
      ok(
        snapshotBody({
          operations: [operation(IDS.op1, '1', 'awaiting_approval')],
          cursor: 'cursor-5',
        }),
      ),
  );
  connection.start();
  await settle();
  const now = (): typeof connection.state => connection.state;
  assert.equal(now().phase, 'subscribing');
  connection.setLockState('locked');
  assert.equal(now().view, 'management_only');
  assert.deepEqual(now().operations, []);
  open();
  await settle();
  assert.equal(now().phase, 'live');
  // ロック中は操作を出さない（表示はすでに management_only）。
  assert.equal(now().view, 'management_only');
  assert.deepEqual(now().operations, []);
  transport.respond(() =>
    ok(snapshotBody({ operations: [operation(IDS.op1, '2', 'approved')] })),
  );
  connection.setLockState('unlocked');
  await settle();
  // 解除でスナップショットを取り直す（購読の後に 1 回だけ）。
  assert.deepEqual(transport.paths(), [
    'GET /v1/bootstrap',
    'GET /v1/snapshot',
    'GET /v1/snapshot',
  ]);
  assert.equal(transport.requests.at(-1)?.lockState, 'unlocked');
  assert.equal(now().view, 'full');
  assert.deepEqual(
    now().operations.map((op) => [op.state_revision, op.state]),
    [['2', 'approved']],
  );
  assert.equal(transport.streams.length, 1);
  connection.stop();
});

test('locking and unlocking both while subscribing take a full snapshot once live', async () => {
  const { transport, connection } = setup();
  let open = () => undefined as void;
  transport.nextStreamGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  transport.respond(
    () => ok(bootstrapBody()),
    () =>
      ok(
        snapshotBody({
          operations: [operation(IDS.op1, '1', 'awaiting_approval')],
          cursor: 'cursor-5',
        }),
      ),
  );
  connection.start();
  await settle();
  const now = (): typeof connection.state => connection.state;
  assert.equal(now().phase, 'subscribing');
  connection.setLockState('locked');
  connection.setLockState('unlocked');
  assert.equal(now().view, 'management_only');
  transport.respond(() =>
    ok(snapshotBody({ operations: [operation(IDS.op1, '3', 'approved')] })),
  );
  open();
  await settle();
  assert.equal(now().phase, 'live');
  assert.deepEqual(transport.paths(), [
    'GET /v1/bootstrap',
    'GET /v1/snapshot',
    'GET /v1/snapshot',
  ]);
  assert.equal(now().view, 'full');
  assert.deepEqual(
    now().operations.map((op) => [op.state_revision, op.state]),
    [['3', 'approved']],
  );
  connection.stop();
});

test('a snapshot taken while locked is replaced by a full one when unlocked during subscribing', async () => {
  const { transport, connection } = setup({ extra: { lockState: 'locked' } });
  let open = () => undefined as void;
  transport.nextStreamGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  transport.respond(
    () => ok(bootstrapBody()),
    () => ok(snapshotBody({ lock: 'locked', cursor: 'cursor-5' })),
  );
  connection.start();
  await settle();
  const now = (): typeof connection.state => connection.state;
  assert.equal(now().phase, 'subscribing');
  assert.equal(now().view, 'management_only');
  connection.setLockState('unlocked');
  transport.respond(() =>
    ok(snapshotBody({ operations: [operation(IDS.op1, '1', 'approved')] })),
  );
  open();
  await settle();
  assert.equal(now().phase, 'live');
  assert.equal(now().view, 'full');
  assert.deepEqual(
    now().operations.map((op) => op.operation_id),
    [IDS.op1],
  );
  connection.stop();
});

// レビューの指摘 L7: 再スナップショットの数は、購読が動いていると確かめられたら数え直す。
// 続けて求められたとき（購読を開いた直後にまた求められる）は、2 回目から間隔を空ける。
test('the resnapshot count resets once the stream is confirmed alive; back-to-back requests still wait', async () => {
  const { transport, clock, connection } = setup();
  await connectLive(transport, connection);
  const resnapshot = { type: 'resnapshot_required', reason: 'history_expired' };
  transport.respond(
    () => ok(bootstrapBody({ scope: IDS.scope2 })),
    () => ok(snapshotBody({ cursor: 'cursor-9' })),
  );
  transport.streams[0]?.send(resnapshot);
  await settle();
  assert.equal(connection.state.phase, 'live');
  assert.equal(transport.streams.length, 2);
  // 購読が動いている（中枢の ping を受け取った）後の再スナップショットは、また 1 回目としてすぐに行う。
  await clock.advance(15_000);
  transport.streams[1]?.ping();
  transport.respond(
    () => ok(bootstrapBody({ scope: IDS.scope3 })),
    () => ok(snapshotBody({ cursor: 'cursor-10' })),
  );
  transport.streams[1]?.send(resnapshot);
  await settle();
  assert.equal(connection.state.phase, 'live');
  assert.equal(transport.streams.length, 3);
  assert.deepEqual(clock.pendingTimers, [45_000]);
  // 開いた直後にまた求められたら（ping も イベントもまだない）、間隔を空ける（すぐに繰り返さない）。
  transport.streams[2]?.send(resnapshot);
  await settle();
  assert.equal(connection.state.phase, 'waiting_retry');
  assert.equal(connection.state.reason, 'resnapshot');
  assert.deepEqual(clock.pendingTimers, [1_000]);
  connection.stop();
});

test('a silent stream is treated as dead after the alive timeout; pings keep it alive', async () => {
  const { transport, clock, connection } = setup();
  await connectLive(transport, connection);
  await clock.advance(30_000);
  transport.streams[0]?.ping();
  await clock.advance(30_000);
  assert.equal(connection.state.phase, 'live');
  assert.equal(connection.state.lastConfirmedAt, Date.UTC(2030, 9, 1) + 30_000);
  await clock.advance(15_000);
  assert.equal(connection.state.phase, 'waiting_retry');
  assert.equal(connection.state.reason, 'alive_timeout');
  assert.equal(transport.streams[0]?.closed, true);
  connection.stop();
});

test('invalid stream messages are protocol errors and old streams cannot change the state', async () => {
  const { transport, connection } = setup();
  await connectLive(transport, connection);
  const first = transport.streams[0];
  first?.send({ type: 'event', event: { schema: 'buddy.event.v1' } });
  await settle();
  assert.equal(connection.state.reason, 'protocol_error');
  transport.respond(
    () => ok(bootstrapBody({ scope: IDS.scope2 })),
    () => ok(snapshotBody()),
  );
  connection.retryNow();
  await settle();
  assert.equal(connection.state.phase, 'live');
  // 前の購読から遅れて届いた切断は無視する。
  first?.closeFromServer(4401, 'device_revoked');
  await settle();
  assert.equal(connection.state.phase, 'live');
  connection.stop();
});

test('request sends only while live, adds the scope when asked, and never retries an unknown outcome (B03-06)', async () => {
  const clock = new FakeClock(undefined, 0.5, [IDS.request1, IDS.request2]);
  const { transport, connection } = setup({ clock });
  assert.deepEqual(
    await connection.request({ method: 'GET', path: '/v1/pairing/claims' }),
    { kind: 'not_sent', reason: 'not_connected' },
  );
  assert.equal(transport.requests.length, 0);
  await connectLive(transport, connection);
  transport.respond(() => ok({ claims: [] }));
  assert.deepEqual(
    await connection.request({ method: 'GET', path: '/v1/pairing/claims' }),
    { kind: 'response', status: 200, body: { claims: [] } },
  );
  assert.equal(transport.requests.at(-1)?.body, undefined);
  transport.respond(() => ({ kind: 'unreachable', reason: 'reset' }));
  assert.deepEqual(
    await connection.request({
      method: 'POST',
      path: '/v1/devices/x/revoke',
      body: {},
      scoped: true,
      screenOperation: true,
    }),
    { kind: 'unknown' },
  );
  const sent = transport.requests.at(-1);
  assert.equal(sent?.screenOperation, true);
  assert.deepEqual(sent?.body, {
    request_id: IDS.request1,
    command_scope_id: IDS.scope1,
  });
  const count = transport.requests.length;
  await settle();
  assert.equal(transport.requests.length, count);
  // 本人が確かめたときの接続範囲と今の接続範囲が違えば（bootstrap をやり直した）、送らない。
  assert.deepEqual(
    await connection.request({
      method: 'POST',
      path: '/v1/devices/x/revoke',
      body: {},
      scoped: true,
      screenOperation: true,
      expectedScopeId: 'scope-from-before-bootstrap',
    }),
    { kind: 'not_sent', reason: 'not_connected' },
  );
  assert.equal(transport.requests.length, count);
  // 401 は再登録が必要（以後は送らない）。
  transport.respond(() => apiError(401, 'unauthenticated'));
  await connection.request({ method: 'GET', path: '/v1/devices' });
  assert.equal(connection.state.phase, 'reregistration_required');
  connection.stop();
});
