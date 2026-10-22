// B04 専用の装置。製品の src を直接 import せず、ビルド済みの試験用部品を再利用する。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const Database = createRequire(
  new URL('../../packages/storage/package.json', import.meta.url),
)('better-sqlite3');
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ClientConnection } from '../../packages/client/dist/index.js';
import { createHubTransport } from '../../apps/desktop/dist/main/hub-transport.js';
import { systemClock } from '../../apps/desktop/dist/main/system-clock.js';
import { createApiContract } from '../../apps/core/dist/api-contract.js';
import {
  onCleanup,
  withTimeout,
} from '../../apps/core/dist/api-test-support.js';
import { FaultInjector } from '../../packages/connectors/dist/testing.js';
import {
  startCore,
  idle,
} from '../../apps/core/dist/operation-runner-test-support.js';
import { bootstrap } from '../../apps/core/dist/event-test-support.js';

export const specification = JSON.parse(
  readFileSync(new URL('./fault-points.json', import.meta.url), 'utf8'),
);

// 順序だけを固定する PRNG。資格情報・鍵・ID の乱数を予測可能にしない。
export function shuffled(values, seed) {
  let state = seed >>> 0;
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function database(core, run, readOnly = true) {
  const db = new Database(join(core.dataDir, 'buddy.sqlite'), {
    readonly: readOnly,
  });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

// 合成 DB にだけ置く観測器。状態変更と同じ transaction で履歴を残すので、中間状態の取りこぼしも
// rollback の誤記録もない。製品表・命令・状態遷移の処理は変更しない。
export function installHistory(core) {
  database(
    core,
    (db) =>
      db.exec(`
    CREATE TABLE b04_history (sequence INTEGER PRIMARY KEY, operation_id TEXT, state TEXT, state_revision INTEGER, content_version INTEGER);
    CREATE TRIGGER b04_insert AFTER INSERT ON operations BEGIN
      INSERT INTO b04_history(operation_id,state,state_revision,content_version)
      VALUES(new.operation_id,new.state,new.state_revision,new.current_content_version);
    END;
    CREATE TRIGGER b04_update AFTER UPDATE OF state_revision ON operations
    WHEN new.state_revision != old.state_revision BEGIN
      INSERT INTO b04_history(operation_id,state,state_revision,content_version)
      VALUES(new.operation_id,new.state,new.state_revision,new.current_content_version);
    END;
  `),
    false,
  );
}

export async function restart(t, rig, core, devices = []) {
  const generation = core.handle.storeGeneration;
  const instance = core.handle.coreInstanceId;
  const provider = rig.provider;
  const receipts = provider.truth.receipts();
  await core.handle.stop('test');
  // 停止中の故障点を解放しても旧中枢は送らない。
  rig.injector.release('after_target_recheck');
  rig.injector.release('after_dispatch_intent_before_send');
  rig.injector.release('after_approval_save');
  const next = await startCore(t, rig, {
    restartOf: core,
    faults: new FaultInjector(),
  });
  assert.equal(next.handle.storeGeneration, generation);
  assert.notEqual(next.handle.coreInstanceId, instance);
  assert.equal(rig.provider, provider);
  assert.deepEqual(
    provider.truth.receipts().slice(0, receipts.length),
    receipts,
  );
  await idle(next);
  for (const who of devices) who.scope = await bootstrap(next, who.device);
  return next;
}

export async function observe(core, rig, operationId, expected) {
  await idle(core);
  const record = await core.handle.store.query({
    kind: 'operation',
    operation_id: operationId,
  });
  assert(record);
  const view = await core.handle.store.query({
    kind: 'operation_view',
    operation_id: operationId,
  });
  const history = database(core, (db) =>
    db
      .prepare(
        'SELECT state,state_revision,content_version FROM b04_history WHERE operation_id=? ORDER BY sequence',
      )
      .all(operationId),
  ).map((r) => ({ ...r }));
  assert.deepEqual(
    history.map((r) => r.state),
    expected.state_history,
  );
  assert.deepEqual(
    history.map((r) => r.state_revision),
    history.map((_, i) => i + 1),
  );
  assert.equal(record.state, expected.core_final_state);
  assert.equal(record.approvals.length, expected.approvals);
  assert.equal(record.attempts.length, expected.attempts);
  for (const attempt of record.attempts) {
    assert(
      record.approvals.some(
        (a) =>
          a.approval_id === attempt.approval_id &&
          a.content_version === attempt.content_version,
      ),
    );
  }
  assert.equal(
    record.approvals.filter((a) => a.status === 'revoked').length,
    expected.revoked_approvals,
  );
  if (expected.content_version_after)
    assert.equal(
      record.current_content_version,
      expected.content_version_after,
    );
  const events = await core.handle.store.query({
    kind: 'events',
    after_sequence: 0,
    limit: 500,
  });
  assert.deepEqual(
    events
      .filter((e) => e.target_id === operationId)
      .map((e) => Number(e.state_revision)),
    history.map((r) => r.state_revision),
  );
  const receipts = rig.provider.truth.receipts();
  assert.deepEqual(
    receipts.map((r) => r.responded),
    expected.provider_responses,
  );
  if (expected.stored_steps) {
    assert.deepEqual(
      view.steps.map((s) => ({
        step_id: s.step_id,
        intent: s.dispatch_intent_at !== null,
        result_status: s.result_status,
      })),
      expected.stored_steps,
    );
  }
  assert.equal(receipts.length, expected.provider_requests);
  assert.equal(rig.provider.truth.requestCount(), expected.provider_requests);
  assert.equal(
    rig.provider.truth.stateChangeCount(),
    expected.provider_state_changes,
  );
  assert.equal(
    receipts.filter((r) => r.applied_change !== null).length,
    expected.provider_state_changes,
  );
  const stepReceives = {};
  for (const [i, r] of receipts.entries()) {
    assert.equal(r.operation_id, operationId);
    assert.equal(r.receive_order, i + 1);
    assert(record.attempts.some((a) => a.attempt_id === r.attempt_id));
    assert(
      view.steps.some(
        (s) => s.step_id === r.step_id && s.dispatch_intent_at !== null,
      ),
    );
    stepReceives[r.step_id] = (stepReceives[r.step_id] ?? 0) + 1;
  }
  assert.deepEqual(stepReceives, expected.step_receives);
  // 対応する試行・工程・承認を同じ観測に残す。本文・トークン・鍵は含めない。
  return {
    operation_id: operationId,
    db_version: String(core.handle.store.schemaVersion),
    state_history: history,
    approvals: record.approvals,
    attempts: record.attempts,
    steps: view.steps,
    provider_receipts: receipts.map(
      ({
        operation_id,
        attempt_id,
        step_id,
        receive_order,
        applied_change,
        responded,
      }) => ({
        operation_id,
        attempt_id,
        step_id,
        receive_order,
        applied: applied_change !== null,
        responded,
      }),
    ),
    provider_requests: receipts.length,
    provider_state_changes: rig.provider.truth.stateChangeCount(),
    approval_count: record.approvals.length,
    final_state: record.state,
  };
}

export async function client(
  t,
  coreRef,
  device,
  { holdEvents = false, beforeSubscribe } = {},
) {
  const pending = [];
  let deliver;
  const requests = [];
  const transport = () =>
    createHubTransport({
      hub: coreRef.current.target,
      token: () => device.token,
    });
  const link = new ClientConnection({
    lockState: 'unlocked',
    contract: createApiContract(),
    clock: systemClock(),
    backoff: { baseMs: 1, maxMs: 5, jitterRatio: 0 },
    transport: {
      request: (request) => {
        requests.push(`${request.method} ${request.path}`);
        return transport().request(request);
      },
      openStream: async (cursor, lock, listener) => {
        await beforeSubscribe?.(link.state);
        deliver = listener;
        return transport().openStream(cursor, lock, (event) => {
          if (
            holdEvents &&
            event.type === 'message' &&
            event.data?.type === 'event'
          )
            pending.push(event);
          else listener(event);
        });
      },
    },
  });
  onCleanup(t, () => link.stop());
  link.start();
  await waitClient(link, (s) => s.phase === 'live');
  return { link, pending, requests, deliver: (event) => deliver(event) };
}

export function waitClient(link, predicate) {
  if (predicate(link.state)) return Promise.resolve();
  let remove;
  return withTimeout(
    new Promise((resolve) => {
      remove = link.onChange((state) => {
        if (predicate(state)) {
          remove();
          resolve();
        }
      });
    }),
    10000,
    '端末の状態の到達',
  ).finally(() => remove?.());
}

export async function until(predicate) {
  await withTimeout(
    (async () => {
      while (!predicate())
        await new Promise((resolve) => setImmediate(resolve));
    })(),
    10000,
    'イベントの到達',
  );
}
