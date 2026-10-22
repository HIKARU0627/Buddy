// 操作の取得・承認・取消の経路と再送の規則（ADR 0023、X04）、中枢の再起動と再接続の後の復元。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬の KeyStore）。再起動は同じデータディレクトリで
// startCore を呼び直す。期待値（HTTP の状態・コード・版・状態・連番）は手で書いた値。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApiContract } from './api-contract.js';
import { deviceCommandId, requestHash } from './api-operations.js';
import { decodeEventCursor } from './event-cursor.js';
import {
  H01_OPERATION,
  H01_SHA256,
  approve,
  approveBody,
  bootstrap,
  cancel,
  createCommand,
  dispatchCommand,
  eventsOf,
  getJson,
  insertDevice,
  openStream,
  prepareCommand,
  startEventCore,
  submitDurable,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import type { TestDevice } from './api-test-support.js';

const contract = createApiContract();

const eventsAfter = async (
  core: EventCore,
  device: TestDevice,
  cursor: string,
) => {
  const page = await getJson(
    core,
    device,
    `/v1/events?cursor=${encodeURIComponent(cursor)}`,
  );
  assert.equal(page.status, 200, page.text);
  return page.json?.['events'] as Record<string, unknown>[];
};

const cursorNow = async (core: EventCore, device: TestDevice) =>
  String((await getJson(core, device, '/v1/snapshot')).json?.['event_cursor']);

test(
  'X04: the same request returns the stored receipt, other content is 409 and an old command scope is 410',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    await submitDurable(core, createCommand(H01_OPERATION));
    const scope1 = await bootstrap(core, device);
    const before = await cursorNow(core, device);

    const body = approveBody(scope1);
    const first = await approve(core, device, H01_OPERATION, body);
    assert.equal(first.status, 202, first.text);
    assert(contract.valid('CommandReceipt', first.json), first.text);
    assert.equal(first.json?.['status'], 'durable');
    assert.equal(first.json?.['committed_state_revision'], '2');
    assert.equal(first.json?.['state_revision'], '2');
    assert.equal(first.json?.['operation_id'], H01_OPERATION);
    assert.equal(first.json?.['request_id'], body['request_id']);

    // 同じ接続範囲・request_id・同じ内容: 保存済みの受付結果（同じ command_id・版）で、二度適用しない。
    const again = await approve(core, device, H01_OPERATION, body);
    assert.equal(again.status, 202, again.text);
    assert.deepEqual(again.json, first.json);
    assert.equal(
      (await getJson(core, device, `/v1/operations/${H01_OPERATION}`)).json?.[
        'state_revision'
      ],
      '2',
    );
    assert.deepEqual(
      (await eventsAfter(core, device, before)).map((event) => [
        event['operation_id'],
        event['state_revision'],
      ]),
      [[H01_OPERATION, '2']],
    );

    // 同じ request_id で内容が違う（preview・hash・経路）: 409。状態は変えない。
    const conflicts = [
      { ...body, preview_id: randomUUID() },
      { ...body, content_hash: 'a'.repeat(64) },
    ];
    for (const changed of conflicts) {
      const response = await approve(core, device, H01_OPERATION, changed);
      assert.equal(response.status, 409, response.text);
      assert.deepEqual(response.json, {
        code: 'conflict',
        message: response.json?.['message'],
        request_id: body['request_id'],
      });
    }
    const otherRoute = await cancel(core, device, H01_OPERATION, {
      request_id: body['request_id'],
      command_scope_id: scope1,
      expected_state_revision: '2',
    });
    assert.equal(otherRoute.status, 409, otherRoute.text);
    assert.equal(otherRoute.json?.['code'], 'conflict');
    const after = await getJson(
      core,
      device,
      `/v1/operations/${H01_OPERATION}`,
    );
    assert.equal(after.json?.['state'], 'approved');
    assert.equal(after.json?.['state_revision'], '2');

    // 再接続（新しい接続範囲）の後、古い接続範囲の命令は同じ内容でも新しい内容でも 410。
    const scope2 = await bootstrap(core, device);
    assert.notEqual(scope2, scope1);
    for (const old of [body, approveBody(scope1, { expected: '2' })]) {
      const response = await approve(core, device, H01_OPERATION, old);
      assert.equal(response.status, 410, response.text);
      assert.equal(response.json?.['code'], 'expired_scope');
    }

    // 新しい接続範囲では同じ request_id も別の命令。同じ内容版の有効な承認があるので、新しく作らず
    // 現在の版を返す（X02、承認は 1 件のまま）。
    const renewed = await approve(core, device, H01_OPERATION, {
      ...body,
      command_scope_id: scope2,
    });
    assert.equal(renewed.status, 202, renewed.text);
    assert.equal(renewed.json?.['committed_state_revision'], '2');
    assert.notEqual(renewed.json?.['command_id'], first.json?.['command_id']);
    const record = await core.handle.store.query({
      kind: 'operation',
      operation_id: H01_OPERATION,
    });
    assert.equal(record?.approvals.length, 1);

    // 版の不一致は 409、正しい版の取消は durable（版 3）。再送は同じ結果。
    const stale = await cancel(core, device, H01_OPERATION, {
      request_id: randomUUID(),
      command_scope_id: scope2,
      expected_state_revision: '1',
    });
    assert.equal(stale.status, 409, stale.text);
    const cancelBody = {
      request_id: randomUUID(),
      command_scope_id: scope2,
      expected_state_revision: '2',
    };
    const cancelled = await cancel(core, device, H01_OPERATION, cancelBody);
    assert.equal(cancelled.status, 202, cancelled.text);
    assert.equal(cancelled.json?.['status'], 'durable');
    assert.equal(cancelled.json?.['committed_state_revision'], '3');
    assert.deepEqual(
      (await cancel(core, device, H01_OPERATION, cancelBody)).json,
      cancelled.json,
    );
    const finished = await getJson(
      core,
      device,
      `/v1/operations/${H01_OPERATION}`,
    );
    assert(contract.valid('OperationSnapshot', finished.json), finished.text);
    assert.deepEqual(finished.json, {
      operation_id: H01_OPERATION,
      operation_kind: 'mail.labels.change',
      content_version: '1',
      content_hash: H01_SHA256,
      state_revision: '3',
      state: 'cancelled',
      approval_state: 'valid',
      allowed_actions: [],
      result: null,
    });
  },
);

test(
  'a cancel after the dispatch boundary is accepted without cancelling, and replays return the same receipt',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    const id = randomUUID();
    await submitDurable(core, createCommand(id, { auto: true }));
    const prepare = prepareCommand(id, '1');
    await submitDurable(core, prepare);
    await submitDurable(
      core,
      dispatchCommand(id, '2', (prepare as { attempt_id: string }).attempt_id),
    );
    const scope = await bootstrap(core, device);
    const body = {
      request_id: randomUUID(),
      command_scope_id: scope,
      expected_state_revision: '3',
    };
    const accepted = await cancel(core, device, id, body);
    assert.equal(accepted.status, 202, accepted.text);
    assert(contract.valid('CommandReceipt', accepted.json));
    assert.equal(accepted.json?.['status'], 'accepted');
    assert.equal(accepted.json?.['committed_state_revision'], null);
    assert.equal(accepted.json?.['state_revision'], '3');
    assert.deepEqual(
      (await cancel(core, device, id, body)).json,
      accepted.json,
    );
    const current = await getJson(core, device, `/v1/operations/${id}`);
    assert.equal(current.json?.['state'], 'dispatching');
    assert.equal(current.json?.['state_revision'], '3');
  },
);

test(
  'approval needs a valid preview and an unlocked device; unknown operations are rejected',
  { timeout: 30_000 },
  async (t) => {
    // preview の発行は後の Issue。既定（有効な preview なし）では承認は 409 で、状態は変わらない。
    const core = await startEventCore(t, { previewValid: false });
    const device = await insertDevice(core.handle.store);
    await submitDurable(core, createCommand(H01_OPERATION));
    const scope = await bootstrap(core, device);
    const noPreview = await approve(
      core,
      device,
      H01_OPERATION,
      approveBody(scope),
    );
    assert.equal(noPreview.status, 409, noPreview.text);
    assert.equal(
      (await getJson(core, device, `/v1/operations/${H01_OPERATION}`)).json?.[
        'state_revision'
      ],
      '1',
    );
    core.env.lock = 'locked';
    const locked = await approve(
      core,
      device,
      H01_OPERATION,
      approveBody(scope),
    );
    assert.equal(locked.status, 403);
    assert.equal(locked.json?.['code'], 'device_locked');
    core.env.lock = 'unlocked';
    const unknown = await getJson(
      core,
      device,
      `/v1/operations/${randomUUID()}`,
    );
    assert.equal(unknown.status, 422);
    assert.equal(unknown.json?.['code'], 'invalid_input');
    const unknownApprove = await approve(
      core,
      device,
      randomUUID(),
      approveBody(scope),
    );
    assert.equal(unknownApprove.status, 409);
  },
);

test(
  'device command IDs are UUID v4 values fixed by the command scope and request_id',
  { timeout: 10_000 },
  () => {
    const scope = '00000000-0000-4000-8000-000000000033';
    const request = '00000000-0000-4000-8000-000000000030';
    const id = deviceCommandId(scope, request);
    assert(contract.valid('Id', id), id);
    assert.equal(deviceCommandId(scope, request), id);
    assert.notEqual(
      deviceCommandId(scope, '00000000-0000-4000-8000-000000000031'),
      id,
    );
    assert.notEqual(
      deviceCommandId('00000000-0000-4000-8000-000000000034', request),
      id,
    );
    // 区切りを入れているので、連結の位置をずらした組と同じ値にならない。
    assert.notEqual(deviceCommandId('ab', 'c'), deviceCommandId('a', 'bc'));
  },
);

test(
  'the request hash covers the route, the target and the whole body',
  { timeout: 10_000 },
  () => {
    const body = {
      request_id: 'r',
      command_scope_id: 's',
      expected_state_revision: '1',
    };
    const hash = requestHash('cancelOperation', 'op', body);
    assert.match(hash, /^[0-9a-f]{64}$/u);
    // キーの順は照合値に影響しない。
    assert.equal(
      requestHash('cancelOperation', 'op', {
        expected_state_revision: '1',
        command_scope_id: 's',
        request_id: 'r',
      }),
      hash,
    );
    assert.notEqual(requestHash('approveOperation', 'op', body), hash);
    assert.notEqual(requestHash('cancelOperation', 'op2', body), hash);
    assert.notEqual(
      requestHash('cancelOperation', 'op', {
        ...body,
        expected_state_revision: '2',
      }),
      hash,
    );
  },
);

test(
  'after a hub restart and reconnection the same IDs, versions and states are returned and missed events are replayed from the cursor',
  { timeout: 60_000 },
  async (t) => {
    const first = await startEventCore(t);
    const device = await insertDevice(first.handle.store);
    await submitDurable(first, createCommand(H01_OPERATION));
    const held = randomUUID();
    await submitDurable(first, createCommand(held, { auto: true }));
    const prepare = prepareCommand(held, '1');
    await submitDurable(first, prepare);
    await submitDurable(
      first,
      dispatchCommand(
        held,
        '2',
        (prepare as { attempt_id: string }).attempt_id,
      ),
    );
    const scope1 = await bootstrap(first, device);
    const body = approveBody(scope1);
    const approved = await approve(first, device, H01_OPERATION, body);
    assert.equal(approved.status, 202, approved.text);
    assert.equal(approved.json?.['committed_state_revision'], '2');
    const snapshot = await getJson(first, device, '/v1/snapshot');
    const cursor = String(snapshot.json?.['event_cursor']);
    // 作成・作成・準備・送出意図・承認の 5 件。
    assert.equal(decodeEventCursor(cursor)?.sequence, 5);
    await first.handle.stop('restart');

    // 再起動: 起動時の回復で送出意図のまま止まった操作を unknown_held へ回す（イベント 6）。
    const second = await startEventCore(t, {
      dataDir: first.dataDir,
      tlsKeyStore: first.tlsKeyStore,
    });
    assert.equal(second.handle.storeGeneration, first.handle.storeGeneration);
    assert.notEqual(second.handle.coreInstanceId, first.handle.coreInstanceId);
    assert.deepEqual(second.handle.recovery.held, [held]);

    // 古い接続範囲の命令は、同じ内容の再送でも 410（中枢の再起動の後）。
    const old = await approve(second, device, H01_OPERATION, body);
    assert.equal(old.status, 410, old.text);
    assert.equal(old.json?.['code'], 'expired_scope');

    const scope2 = await bootstrap(second, device);
    const h01 = await getJson(
      second,
      device,
      `/v1/operations/${H01_OPERATION}`,
    );
    assert.deepEqual(
      [
        h01.json?.['operation_id'],
        h01.json?.['content_version'],
        h01.json?.['content_hash'],
        h01.json?.['state_revision'],
        h01.json?.['state'],
      ],
      [H01_OPERATION, '1', H01_SHA256, '2', 'approved'],
    );
    const heldNow = await getJson(second, device, `/v1/operations/${held}`);
    assert.deepEqual(
      [
        heldNow.json?.['state'],
        heldNow.json?.['state_revision'],
        heldNow.json?.['allowed_actions'],
        heldNow.json?.['result'],
      ],
      [
        'unknown_held',
        '4',
        ['reconcile'],
        { status: 'unknown', provider_receipt_id: null },
      ],
    );

    // 欠けたイベント（停止中・起動時の回復）を cursor から取り戻す。HTTP と WSS の両方。
    const missed = await eventsAfter(second, device, cursor);
    assert.deepEqual(
      missed.map((event) => [
        event['sequence'],
        event['operation_id'],
        event['state_revision'],
      ]),
      [['6', held, '4']],
    );
    const stream = openStream(t, second, device, cursor);
    await stream.waitFor(
      (messages) => eventsOf(messages).length >= 1,
      'replayed after restart',
    );
    assert.deepEqual(
      eventsOf(stream.messages).map((event) => [
        event['sequence'],
        event['event_id'],
      ]),
      [['6', missed[0]?.['event_id']]],
    );

    // 再起動の後も X04 の規則は同じ: 新しい接続範囲の request_id は保存済みの結果、内容違いは 409。
    const renewedBody = { ...body, command_scope_id: scope2 };
    const renewed = await approve(second, device, H01_OPERATION, renewedBody);
    assert.equal(renewed.status, 202, renewed.text);
    assert.equal(renewed.json?.['committed_state_revision'], '2');
    assert.deepEqual(
      (await approve(second, device, H01_OPERATION, renewedBody)).json,
      renewed.json,
    );
    const conflict = await approve(second, device, H01_OPERATION, {
      ...renewedBody,
      preview_id: randomUUID(),
    });
    assert.equal(conflict.status, 409, conflict.text);
    const record = await second.handle.store.query({
      kind: 'operation',
      operation_id: H01_OPERATION,
    });
    assert.equal(record?.approvals.length, 1);
    assert.equal(record?.state_revision, '2');
  },
);
