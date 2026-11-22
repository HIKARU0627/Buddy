// 同期の走査の実行器の provider 振り分け（B09-04、ADR 0138）の試験。保存層と実行器は偽物にし、
// 接続の provider ごとの振り分けだけを確かめる。期待値は手で書いた。

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ConnectionRecord,
  ConnectionTargetsOpResult,
  DbWorkerClient,
} from '@buddy/storage';
import { createProviderSyncExecutor } from './provider-sync-executor.js';
import type {
  SyncExecutor,
  SyncScanOutcome,
  SyncScanRequest,
} from './sync-executor.js';

const record = (provider: 'google' | 'microsoft'): ConnectionRecord => ({
  connection_id: 'conn-1',
  provider,
  status: 'active',
  access: 'read',
  granted_scopes: [],
  targets: {
    calendar_ids: [],
    mail_container_ids: [],
    attachment_kinds: [],
    mail_lookback_days: 90,
    calendar_past_days: 30,
    calendar_future_days: 90,
    attachment_max_bytes: 10000000,
  },
  targets_state: 'complete',
  permission_revision: '1',
  scope_revision: '1',
});

function fakeStore(
  result: ConnectionTargetsOpResult,
): Pick<DbWorkerClient, 'connectionTargets'> {
  return {
    connectionTargets: (() =>
      Promise.resolve(result)) as DbWorkerClient['connectionTargets'],
  };
}

function fakeExecutor(reason: string): {
  readonly executor: SyncExecutor;
  readonly calls: SyncScanRequest[];
} {
  const calls: SyncScanRequest[] = [];
  return {
    calls,
    executor: {
      async runScan(request: SyncScanRequest): Promise<SyncScanOutcome> {
        calls.push(request);
        return { status: 'unavailable', reason };
      },
    },
  };
}

const REQUEST: SyncScanRequest = {
  connection_id: 'conn-1',
  account_id: 'acct-1',
  scope_id: 'scope-1',
  resource: 'mail',
  kind: 'full',
};

test('routes by the connection provider', async () => {
  const google = fakeExecutor('google-side');
  const microsoft = fakeExecutor('microsoft-side');
  const forGoogle = createProviderSyncExecutor({
    store: fakeStore({ ok: true, value: record('google') }),
    google: google.executor,
    microsoft: microsoft.executor,
  });
  assert.deepEqual(await forGoogle.runScan(REQUEST), {
    status: 'unavailable',
    reason: 'google-side',
  });
  assert.equal(google.calls.length, 1);
  assert.equal(microsoft.calls.length, 0);

  const forMicrosoft = createProviderSyncExecutor({
    store: fakeStore({ ok: true, value: record('microsoft') }),
    google: google.executor,
    microsoft: microsoft.executor,
  });
  assert.deepEqual(await forMicrosoft.runScan(REQUEST), {
    status: 'unavailable',
    reason: 'microsoft-side',
  });
  assert.equal(google.calls.length, 1);
  assert.equal(microsoft.calls.length, 1);
});

test('a missing connection or a store failure calls neither executor', async () => {
  const google = fakeExecutor('google-side');
  const microsoft = fakeExecutor('microsoft-side');
  const missing = createProviderSyncExecutor({
    store: fakeStore({ ok: true, value: null }),
    google: google.executor,
    microsoft: microsoft.executor,
  });
  assert.deepEqual(await missing.runScan(REQUEST), {
    status: 'unavailable',
    reason: 'connection_not_found',
  });

  const broken = createProviderSyncExecutor({
    store: fakeStore({
      ok: false,
      outcome: 'rejected',
      reasons: ['worker_unavailable'],
    }),
    google: google.executor,
    microsoft: microsoft.executor,
  });
  assert.deepEqual(await broken.runScan(REQUEST), {
    status: 'unavailable',
    reason: 'store_unavailable',
  });
  assert.equal(google.calls.length, 0);
  assert.equal(microsoft.calls.length, 0);
});
