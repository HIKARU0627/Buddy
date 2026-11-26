// 自動で登録した用事の取り消し（POST /v1/auto-actions/{id}/undo、B13-05、ADR 0157）の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬）。用事は外部を使わない LocalCommand なので、
// 提供元は取り消しの経路を開くための最小の合成の口だけを渡す。実アカウント・実データは使わない。
// 期待値は設計 03「取り消しと安全停止」・J12 と ADR 0157（登録したままの、開いている用事だけを削除する。
// 消えた・完了した用事は 409 target_changed。適用の直前にも同じ transaction で確かめる）から手で書いた値。
// 模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import {
  openWriteConnection,
  sealOperationIntent,
  sealTaskContent,
  storagePlatform,
} from '@buddy/storage';
import type { CreateOperationCommand } from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { taskCreationOf, undoOperationId } from './api-auto-actions.js';
import {
  DATA_KEY_MATERIAL,
  bearer,
  bootstrap,
  insertDevice,
  startEventCore,
  submitDurable,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { pinnedRequest } from './api-test-support.js';
import type { ApiResponse, TestDevice } from './api-test-support.js';
import { DB_FILE } from './paths.js';
import type { ProviderReader, ProviderWriter } from './turn-ports.js';

const contract = createApiContract();
type Json = Record<string, unknown>;
const SCREEN = { 'buddy-input-origin': 'screen' } as const;
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const TASK = { title: '資料を送る', due: null, body: null } as const;

// 取り消しの経路を開くための最小の合成の口（用事の取り消しでは読み書きしない）。
function minimalProvider(): {
  reader: ProviderReader;
  writer: ProviderWriter;
} {
  return {
    reader: {
      connection: () =>
        Promise.resolve({
          provider: 'mock',
          account_id: ACCOUNT,
          status: 'active',
          access: 'read',
          writable_kinds: [],
          readable_kinds: ['mail.message'],
        }),
      readPermission: () => Promise.resolve(null),
      readTarget: () => Promise.resolve(null),
      listEvents: () => Promise.resolve([]),
    },
    writer: { changeLabels: () => Promise.resolve({ kind: 'not_sent' }) },
  };
}

interface Harness {
  readonly core: EventCore;
  readonly device: TestDevice;
  readonly scope: string;
  sql<T>(body: (db: ReturnType<typeof openWriteConnection>) => T): T;
}

async function start(t: test.TestContext): Promise<Harness> {
  const ports = minimalProvider();
  const core = await startEventCore(t, {
    turns: { provider: ports.reader, writer: ports.writer },
  });
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
  const sql = <T>(
    body: (db: ReturnType<typeof openWriteConnection>) => T,
  ): T => {
    const db = openWriteConnection(join(core.dataDir, DB_FILE), {
      platform: storagePlatform(),
    });
    try {
      return body(db);
    } finally {
      db.close();
    }
  };
  return { core, device, scope, sql };
}

const base = (operationId: string, expected: string) => ({
  command_id: randomUUID(),
  operation_id: operationId,
  expected_state_revision: expected,
  request_revision: null,
  permission_revision: '0',
  forgetting_generation: '0',
  connection_id: null,
  request: null,
});

// 方針で自動承認した用事の登録を適用まで進める（結果の版は 2）。登録した用事の ID を返す。
async function seedAutoTask(
  h: Harness,
): Promise<{ operationId: string; taskId: string }> {
  const operationId = randomUUID();
  const sealed = sealOperationIntent(
    DATA_KEY_MATERIAL,
    { operationId, contentVersion: 1 },
    {
      schema: 'buddy.operation.v1',
      operation_id: operationId,
      content_version: '1',
      permission_revision: '0',
      target: { list_id: 'inbox' },
      action: { kind: 'task.create', ...TASK },
      effects: {
        external_recipients: [],
        reconcile_scope: 'local_transaction',
      },
    },
  );
  assert(sealed.ok);
  const create: CreateOperationCommand = {
    ...base(operationId, '0'),
    kind: 'operation.create',
    workflow_id: null,
    operation_kind: 'task.create',
    effect_route: 'local_command',
    content_hash: sealed.content_hash,
    intent: sealed.intent,
    auto_approval: {
      approval_id: randomUUID(),
      policy_version: '3',
      current_policy_version: '3',
      safety_target_key: `target:${operationId}`,
    },
  };
  await submitDurable(h.core, create);
  const taskId = randomUUID();
  const content = sealTaskContent(DATA_KEY_MATERIAL, taskId, TASK);
  assert(content.ok);
  await submitDurable(h.core, {
    ...base(operationId, '1'),
    kind: 'operation.apply_local',
    attempt_id: randomUUID(),
    task_id: taskId,
    list_id: 'inbox',
    content: content.content,
  });
  return { operationId, taskId };
}

const undoRequest = (
  h: Harness,
  operationId: string,
  requestId: string = randomUUID(),
): Promise<ApiResponse> =>
  pinnedRequest(h.core.target, {
    method: 'POST',
    path: `/v1/auto-actions/${operationId}/undo`,
    headers: {
      ...bearer(h.device.token),
      'content-type': 'application/json',
      ...SCREEN,
    },
    body: JSON.stringify({
      request_id: requestId,
      command_scope_id: h.scope,
      expected_state_revision: '2',
    }),
  });

async function undoStates(h: Harness): Promise<string[]> {
  const response = await pinnedRequest(h.core.target, {
    method: 'GET',
    path: '/v1/auto-actions',
    headers: bearer(h.device.token),
  });
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('AutoActionList', response.json), response.text);
  return ((response.json as Json)['items'] as Json[]).map((item) =>
    String(item['undo_state']),
  );
}

const taskRows = (h: Harness): unknown[] =>
  h.sql((db) => db.prepare('SELECT task_id, status FROM tasks').all());

const taskBlobs = (h: Harness): number =>
  h.sql(
    (db) =>
      db
        .prepare(
          "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'tasks' AND purpose = 'task_content'",
        )
        .pluck()
        .get() as number,
  );

const undoRecords = (h: Harness): unknown[] =>
  h.sql((db) =>
    db
      .prepare(
        'SELECT operation_id, compensation_operation_id, status FROM undo_records ORDER BY requested_at',
      )
      .all(),
  );

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('did not reach the expected state');
}

test('undo deletes the task Buddy registered, with its content, through a local compensation approved by the press', async (t) => {
  const h = await start(t);
  const { operationId, taskId } = await seedAutoTask(h);
  assert.deepEqual(taskRows(h), [{ task_id: taskId, status: 'open' }]);
  assert.equal(taskBlobs(h), 1);
  assert.deepEqual(await undoStates(h), ['available']);

  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, requestId);
  assert.equal(accepted.status, 202, accepted.text);
  assert(contract.valid('CommandReceipt', accepted.json), accepted.text);
  const compensationId = undoOperationId(h.scope, requestId);
  assert.equal((accepted.json as Json)['operation_id'], compensationId);

  await waitFor(async () => (await undoStates(h))[0] === 'undone');
  assert.deepEqual(taskRows(h), []);
  assert.equal(taskBlobs(h), 0);
  assert.deepEqual(undoRecords(h), [
    {
      operation_id: operationId,
      compensation_operation_id: compensationId,
      status: 'undone',
    },
  ]);
  assert.deepEqual(
    h.sql((db) =>
      db
        .prepare(
          'SELECT o.kind, o.effect_route, o.state, a.route, t.external_id FROM operations o JOIN approvals a ON a.operation_id = o.operation_id JOIN operation_attempts t ON t.operation_id = o.operation_id WHERE o.operation_id = ?',
        )
        .get(compensationId),
    ),
    {
      kind: 'task.delete',
      effect_route: 'local_command',
      state: 'succeeded',
      route: 'screen',
      external_id: taskId,
    },
  );
  // 同じ要求の再送は保存済みの受付を返し、二つ目の補償を作らない。
  const replay = await undoRequest(h, operationId, requestId);
  assert.equal(replay.status, 202, replay.text);
  assert.equal((replay.json as Json)['operation_id'], compensationId);
  assert.equal(undoRecords(h).length, 1);
});

test('a task that was completed or removed is not deleted automatically (409 target_changed)', async (t) => {
  const h = await start(t);
  const { operationId, taskId } = await seedAutoTask(h);
  // 本人が完了にした用事（完了の命令はまだないので、行を直接書き換える）。
  h.sql((db) =>
    db
      .prepare("UPDATE tasks SET status = 'done' WHERE task_id = ?")
      .run(taskId),
  );
  const done = await undoRequest(h, operationId);
  assert.equal(done.status, 409, done.text);
  assert(contract.valid('ApiError', done.json), done.text);
  assert.equal(done.json?.['code'], 'target_changed');
  // 消えた用事。
  h.sql((db) => {
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
  });
  const removed = await undoRequest(h, operationId);
  assert.equal(removed.status, 409, removed.text);
  assert.equal(removed.json?.['code'], 'target_changed');
  assert.deepEqual(undoRecords(h), []);
  assert.deepEqual(await undoStates(h), ['available']);
});

test('the pure check reads only a task registration', () => {
  const operationId = randomUUID();
  assert.deepEqual(
    taskCreationOf({
      operation_id: operationId,
      content_version: '1',
      permission_revision: '0',
      target: { list_id: 'inbox' },
      action: { kind: 'task.create', ...TASK },
    }),
    {
      operation_id: operationId,
      content_version: '1',
      permission_revision: '0',
    },
  );
  assert.equal(
    taskCreationOf({
      operation_id: operationId,
      content_version: '1',
      permission_revision: '0',
      action: { kind: 'mail.draft.create' },
    }),
    null,
  );
  assert.equal(
    taskCreationOf({
      operation_id: operationId,
      content_version: '1',
      action: { kind: 'task.create', ...TASK },
    }),
    null,
  );
});
