// 自動実行の取り消しの経路（POST /v1/auto-actions/{id}/undo、B13-05、ADR 0153）の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬）。提供元は試験の中の合成の読み書きの口で、
// 操作は合成の H01（模擬のメール mail-001 にラベル follow-up を足す）。実アカウント・実データは使わない。
// 期待値は設計 03「取り消しと安全停止」・07 §2・§3・J12（補償は新しい operation_id、対象が変わっていれば 409
// target_changed、30 日を過ぎたら 410 undo_expired、同じ要求の再送は保存済みの受付）と ADR 0153 から手で書いた値。
// 模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import { undoOperationId } from './api-auto-actions.js';
import {
  bearer,
  bootstrap,
  createCommand,
  dispatchCommand,
  insertDevice,
  prepareCommand,
  startEventCore,
  submitDurable,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { pinnedRequest, sharedApiContract } from './api-test-support.js';
import type { ApiResponse, TestDevice } from './api-test-support.js';
import { DB_FILE } from './paths.js';
import type {
  ProviderMailTarget,
  ProviderReader,
  ProviderWriter,
} from './turn-ports.js';

const contract = sharedApiContract();
type Json = Record<string, unknown>;
const SCREEN = { 'buddy-input-origin': 'screen' } as const;
// H01 の口座・対象。
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const MAIL = 'mail-001';

// 合成の提供元。対象のメールのラベルを持ち、ラベルの変更を受けるたびに版を一つ進める。
interface FakeMail {
  labels: string[];
  revision: number;
  readonly changes: { add: readonly string[]; remove: readonly string[] }[];
}

function fakeProvider(mail: FakeMail): {
  reader: ProviderReader;
  writer: ProviderWriter;
} {
  const target = (): ProviderMailTarget => ({
    remote_id: MAIL,
    source_revision: `r${mail.revision}`,
    mailbox: 'inbox',
    labels: [...mail.labels],
  });
  return {
    reader: {
      connection: () =>
        Promise.resolve({
          provider: 'mock',
          account_id: ACCOUNT,
          status: 'active',
          access: 'read_write',
          writable_kinds: ['mail.labels.change'],
          readable_kinds: ['mail.message'],
        }),
      readPermission: (accountId) =>
        Promise.resolve(
          accountId === ACCOUNT
            ? {
                account_id: ACCOUNT,
                permission_revision: '1',
                scopes: ['mail.read', 'mail.labels.change'],
              }
            : null,
        ),
      readTarget: (remoteId) =>
        Promise.resolve(remoteId === MAIL ? target() : null),
      listEvents: () => Promise.resolve([]),
    },
    writer: {
      changeLabels: (_identity, change) => {
        mail.changes.push({ add: change.add, remove: change.remove });
        mail.labels = [
          ...mail.labels.filter((label) => !change.remove.includes(label)),
          ...change.add.filter((label) => !mail.labels.includes(label)),
        ];
        mail.revision += 1;
        return Promise.resolve({
          kind: 'applied',
          status: 200,
          value: target(),
        });
      },
    },
  };
}

interface Harness {
  readonly core: EventCore;
  readonly device: TestDevice;
  readonly scope: string;
  sql<T>(body: (db: ReturnType<typeof openWriteConnection>) => T): T;
}

async function start(
  t: test.TestContext,
  mail: FakeMail | null,
): Promise<Harness> {
  const ports = mail === null ? null : fakeProvider(mail);
  const core = await startEventCore(
    t,
    ports === null
      ? {}
      : { turns: { provider: ports.reader, writer: ports.writer } },
  );
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

// 方針で自動承認した H01 の操作を、準備・送出・結果まで進める（結果の版は 5）。
async function seedAutoAction(h: Harness): Promise<string> {
  const operationId = randomUUID();
  await submitDurable(h.core, createCommand(operationId, { auto: true }));
  const prepare = prepareCommand(operationId, '1');
  assert(prepare.kind === 'operation.prepare');
  await submitDurable(h.core, prepare);
  await submitDurable(
    h.core,
    dispatchCommand(operationId, '2', prepare.attempt_id),
  );
  for (const [expected, to] of [
    ['3', 'reconciling'],
    ['4', 'succeeded'],
  ] as const)
    await submitDurable(h.core, {
      command_id: randomUUID(),
      operation_id: operationId,
      expected_state_revision: expected,
      request_revision: null,
      permission_revision: '0',
      forgetting_generation: '0',
      connection_id: null,
      request: null,
      kind: 'operation.record_result',
      attempt_id: prepare.attempt_id,
      to,
      external_id: null,
    });
  return operationId;
}

const undoRequest = (
  h: Harness,
  operationId: string,
  options: {
    readonly expected?: string;
    readonly requestId?: string;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse> =>
  pinnedRequest(h.core.target, {
    method: 'POST',
    path: `/v1/auto-actions/${operationId}/undo`,
    headers: {
      ...bearer(h.device.token),
      'content-type': 'application/json',
      ...(options.headers ?? SCREEN),
    },
    body: JSON.stringify({
      request_id: options.requestId ?? randomUUID(),
      command_scope_id: h.scope,
      expected_state_revision: options.expected ?? '5',
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

const undoRecords = (h: Harness): unknown[] =>
  h.sql((db) =>
    db
      .prepare(
        'SELECT operation_id, compensation_operation_id, status FROM undo_records ORDER BY requested_at',
      )
      .all(),
  );

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('did not reach the expected state');
}

test('without a provider the list does not offer undo and the route answers 503', async (t) => {
  const h = await start(t, null);
  const operationId = await seedAutoAction(h);
  assert.deepEqual(await undoStates(h), ['unavailable']);
  const response = await undoRequest(h, operationId);
  assert.equal(response.status, 503, response.text);
  assert.equal(response.json?.['code'], 'dependency_unavailable');
  assert.deepEqual(undoRecords(h), []);
});

test('undo removes the added label through a new compensation operation approved by the press, once', async (t) => {
  const mail: FakeMail = { labels: ['follow-up'], revision: 2, changes: [] };
  const h = await start(t, mail);
  const operationId = await seedAutoAction(h);
  assert.deepEqual(await undoStates(h), ['available']);

  // 画面の操作だけ・状態版が今の値のときだけ。
  const voice = await undoRequest(h, operationId, {
    headers: { 'buddy-input-origin': 'voice' },
  });
  assert.equal(voice.status, 403, voice.text);
  assert.equal(voice.json?.['code'], 'screen_operation_required');
  const stale = await undoRequest(h, operationId, { expected: '4' });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json?.['code'], 'conflict');
  assert.deepEqual(undoRecords(h), []);

  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, { requestId });
  assert.equal(accepted.status, 202, accepted.text);
  assert(contract.valid('CommandReceipt', accepted.json), accepted.text);
  const compensationId = undoOperationId(h.scope, requestId);
  assert.notEqual(compensationId, operationId);
  assert.deepEqual(accepted.json, {
    request_id: requestId,
    command_id: (accepted.json as Json)['command_id'],
    operation_id: compensationId,
    state_revision: '1',
    status: 'durable',
    committed_state_revision: '1',
  });
  // 実行担当が補償の操作を送り、結果の記録で取り消し済みになる。
  await waitFor(async () => (await undoStates(h))[0] === 'undone');
  assert.deepEqual(mail.changes, [{ add: [], remove: ['follow-up'] }]);
  assert.deepEqual(mail.labels, []);
  assert.deepEqual(undoRecords(h), [
    {
      operation_id: operationId,
      compensation_operation_id: compensationId,
      status: 'undone',
    },
  ]);
  // 補償の操作は押した端末の画面の承認つき。
  assert.deepEqual(
    h.sql((db) =>
      db
        .prepare(
          'SELECT o.kind, o.state, a.route, a.device_id FROM operations o JOIN approvals a ON a.operation_id = o.operation_id WHERE o.operation_id = ?',
        )
        .get(compensationId),
    ),
    {
      kind: 'mail.labels.change',
      state: 'succeeded',
      route: 'screen',
      device_id: h.device.device.device_id,
    },
  );

  // 同じ要求の再送は保存済みの受付を返し、二度は送らない。
  const retry = await undoRequest(h, operationId, { requestId });
  assert.equal(retry.status, 202, retry.text);
  assert.deepEqual(retry.json, accepted.json);
  // 同じ request_id で内容が違えば 409。
  const reused = await undoRequest(h, operationId, {
    requestId,
    expected: '6',
  });
  assert.equal(reused.status, 409, reused.text);
  // 取り消し済みの自動実行はもう取り消せない。
  const again = await undoRequest(h, operationId);
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json?.['code'], 'conflict');
  assert.equal(mail.changes.length, 1);
});

test('a label changed after the automatic action is not undone automatically (409 target_changed)', async (t) => {
  const mail: FakeMail = { labels: ['other'], revision: 3, changes: [] };
  const h = await start(t, mail);
  const operationId = await seedAutoAction(h);
  const response = await undoRequest(h, operationId);
  assert.equal(response.status, 409, response.text);
  assert(contract.valid('ApiError', response.json), response.text);
  assert.equal(response.json?.['code'], 'target_changed');
  assert.deepEqual(undoRecords(h), []);
  assert.deepEqual(mail.changes, []);
  assert.deepEqual(await undoStates(h), ['available']);
});

test('undo after 30 days is 410 undo_expired, and an operation that is not automatic is 422', async (t) => {
  const mail: FakeMail = { labels: ['follow-up'], revision: 2, changes: [] };
  const h = await start(t, mail);
  const operationId = await seedAutoAction(h);
  // 完了と期限を過去にする（期限の判定は domain と保存層の試験で境界まで確かめている）。
  h.sql((db) =>
    db
      .prepare(
        'UPDATE auto_actions SET completed_at = 1, undo_deadline = 2592000001 WHERE operation_id = ?',
      )
      .run(operationId),
  );
  assert.deepEqual(await undoStates(h), ['expired']);
  const expired = await undoRequest(h, operationId);
  assert.equal(expired.status, 410, expired.text);
  assert(contract.valid('ApiError', expired.json), expired.text);
  assert.equal(expired.json?.['code'], 'undo_expired');

  const screenOperation = randomUUID();
  await submitDurable(h.core, createCommand(screenOperation));
  const notAuto = await undoRequest(h, screenOperation, { expected: '1' });
  assert.equal(notAuto.status, 422, notAuto.text);
  assert.equal(notAuto.json?.['code'], 'invalid_input');
  assert.deepEqual(undoRecords(h), []);
  assert.deepEqual(mail.changes, []);
});
