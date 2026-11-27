// 自動実行の一覧と安全停止の解除の経路（B13-05、ADR 0152）の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬）。操作は合成の H01 で、実アカウント・実データは使わない。
// 期待値は設計 03「取り消しと安全停止」（解除は登録済み・ロック解除済み端末の画面操作だけ、版の一致が条件）、
// J12（取り消しは完了から 30 日）、ADR 0147 の時間窓（10 分・20 件）と ADR 0152・0153（提供元の読み書きの口が
// なければ unavailable）から手で書いた値。取り消しの経路は api-auto-actions-undo.test.ts。模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
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

const contract = sharedApiContract();
type Json = Record<string, unknown>;
const SCREEN = { 'buddy-input-origin': 'screen' } as const;
const THIRTY_DAYS_MS = 2_592_000_000;

interface Harness {
  readonly core: EventCore;
  readonly device: TestDevice;
  readonly scope: string;
  sql<T>(body: (db: ReturnType<typeof openWriteConnection>) => T): T;
}

async function start(t: test.TestContext): Promise<Harness> {
  const core = await startEventCore(t);
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

const list = (h: Harness, token = h.device.token): Promise<ApiResponse> =>
  pinnedRequest(h.core.target, {
    method: 'GET',
    path: '/v1/auto-actions',
    headers: bearer(token),
  });

const resume = (
  h: Harness,
  expected: string,
  headers: Record<string, string> = SCREEN,
  requestId: string = randomUUID(),
): Promise<ApiResponse> =>
  pinnedRequest(h.core.target, {
    method: 'POST',
    path: '/v1/safety/resume',
    headers: {
      ...bearer(h.device.token),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      request_id: requestId,
      command_scope_id: h.scope,
      expected_safety_revision: expected,
    }),
  });

// 安全停止にする（版 1、時間窓の件数の超過、停止の時刻は 2027-01-15T08:00:00.000Z）。
const stopBreaker = (h: Harness): void =>
  h.sql((db) => {
    db.prepare(
      "INSERT INTO safety_breaker (singleton, state, safety_revision, stop_reason, stopped_at, resumed_by_device_id) VALUES (1, 'stopped', 1, 'rate_exceeded', 1800000000000, NULL) ON CONFLICT (singleton) DO UPDATE SET state = 'stopped', safety_revision = 1, stop_reason = 'rate_exceeded', stopped_at = 1800000000000, resumed_by_device_id = NULL",
    ).run();
  });

const RUNNING_0 = {
  state: 'running',
  safety_revision: '0',
  stop_reason: null,
  stopped_at: null,
  auto_approvals: null,
};

test('both routes need a device token; the resume also needs home, an unlocked device and a screen operation', async (t) => {
  const h = await start(t);
  for (const [method, path] of [
    ['GET', '/v1/auto-actions'],
    ['POST', '/v1/safety/resume'],
  ] as const) {
    const response = await pinnedRequest(h.core.target, {
      method,
      path,
      headers: SCREEN,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  stopBreaker(h);
  const notScreen = await resume(h, '1', { 'buddy-input-origin': 'voice' });
  assert.equal(notScreen.status, 403, notScreen.text);
  assert.equal(notScreen.json?.['code'], 'screen_operation_required');
  h.core.env.lock = 'locked';
  const locked = await resume(h, '1');
  assert.equal(locked.status, 403, locked.text);
  assert.equal(locked.json?.['code'], 'device_locked');
  h.core.env.lock = 'unlocked';
  h.core.env.home = false;
  const outside = await resume(h, '1');
  assert.equal(outside.status, 403, outside.text);
  assert.equal(outside.json?.['code'], 'outside_home_network');
  const outsideList = await list(h);
  assert.equal(outsideList.status, 403, outsideList.text);
  h.core.env.home = true;
  // どの拒否でも停止は解けていない。
  const after = await list(h);
  assert.equal(after.status, 200, after.text);
  assert.equal((after.json?.['safety'] as Json)['state'], 'stopped');
});

test('the list shows the safety state and the automatic actions without their content, and undo is not offered without a provider', async (t) => {
  const h = await start(t);
  const empty = await list(h);
  assert.equal(empty.status, 200, empty.text);
  assert(contract.valid('AutoActionList', empty.json), empty.text);
  assert.deepEqual(empty.json, { safety: RUNNING_0, items: [] });

  // 方針で自動承認した操作（版 1 の approved から始まる）を、準備・送出・結果まで進める。
  const operationId = randomUUID();
  const create = createCommand(operationId, { auto: true });
  await submitDurable(h.core, create);
  const prepare = prepareCommand(operationId, '1');
  await submitDurable(h.core, prepare);
  assert(prepare.kind === 'operation.prepare');
  await submitDurable(
    h.core,
    dispatchCommand(operationId, '2', prepare.attempt_id),
  );
  const result = (expected: string, to: 'reconciling' | 'succeeded') =>
    submitDurable(h.core, {
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
  await result('3', 'reconciling');
  await result('4', 'succeeded');
  // 方針で自動承認していない操作は載らない。
  await submitDurable(h.core, createCommand(randomUUID()));

  const response = await list(h);
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('AutoActionList', response.json), response.text);
  const body = response.json as Json;
  const safety = body['safety'] as Json;
  assert.equal(safety['state'], 'running');
  assert.equal(safety['safety_revision'], '0');
  const approvals = safety['auto_approvals'] as Json;
  assert.equal(approvals['auto_approvals'], 1);
  assert.equal(approvals['limit'], 20);
  assert.equal(approvals['window_minutes'], 10);
  const items = body['items'] as Json[];
  assert.equal(items.length, 1, response.text);
  const [item] = items as [Json];
  const completedAt = String(item['completed_at']);
  assert.deepEqual(item, {
    operation_id: operationId,
    action_kind: 'label_mail',
    policy_version: '3',
    state_revision: '5',
    completed_at: completedAt,
    undo_state: 'unavailable',
    undo_deadline: new Date(
      Date.parse(completedAt) + THIRTY_DAYS_MS,
    ).toISOString(),
    undo_target: { content_version: '1', content_hash: create.content_hash },
  });
  // 確定 intent の本文（H01 の宛先・件名など）は返さない。
  assert(!response.text.includes('intent'), response.text);
});

test('the resume needs the current revision, clears the stop once, and is not repeated by a retry', async (t) => {
  const h = await start(t);
  // 止まっていなければ解除はない（版が合っていても 409）。
  const running = await resume(h, '0');
  assert.equal(running.status, 409, running.text);
  assert.equal(running.json?.['code'], 'conflict');

  stopBreaker(h);
  const stopped = await list(h);
  assert.equal(stopped.status, 200, stopped.text);
  assert(contract.valid('AutoActionList', stopped.json), stopped.text);
  assert.deepEqual((stopped.json as Json)['safety'], {
    state: 'stopped',
    safety_revision: '1',
    stop_reason: 'rate_exceeded',
    stopped_at: '2027-01-15T08:00:00.000Z',
    auto_approvals: null,
  });

  const stale = await resume(h, '0');
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json?.['code'], 'conflict');

  const requestId = randomUUID();
  const ok = await resume(h, '1', SCREEN, requestId);
  assert.equal(ok.status, 200, ok.text);
  assert(contract.valid('SafetyState', ok.json), ok.text);
  assert.deepEqual(ok.json, {
    state: 'running',
    safety_revision: '2',
    stop_reason: null,
    stopped_at: null,
    auto_approvals: null,
  });
  // 解除した本人の端末を残す（07 §2）。
  assert.deepEqual(
    h.sql((db) =>
      db
        .prepare(
          'SELECT state, safety_revision, resumed_by_device_id FROM safety_breaker WHERE singleton = 1',
        )
        .get(),
    ),
    {
      state: 'running',
      safety_revision: 2,
      resumed_by_device_id: h.device.device.device_id,
    },
  );

  // 同じ要求の再送は版が進んでいるので 409 になり、二重に効かない。
  const retry = await resume(h, '1', SCREEN, requestId);
  assert.equal(retry.status, 409, retry.text);
  const notStopped = await resume(h, '2');
  assert.equal(notStopped.status, 409, notStopped.text);
  const after = await list(h);
  assert.deepEqual((after.json as Json)['safety'], {
    ...RUNNING_0,
    safety_revision: '2',
  });
});
