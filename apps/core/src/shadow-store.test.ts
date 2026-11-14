// 影モードの比較記録の保存先（DB worker の intent_shadow.* への口。ADR 0092・0110、B06-06e）。
// 期待値は手で書く。件数が読めないときは例外（比較を始めない側）、保存の拒否は `failed`（本線を止めない側）。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntentShadowRecord } from '@buddy/contracts';
import type {
  DbWorkerClient,
  IntentShadowOp,
  IntentShadowOpResult,
} from '@buddy/storage';
import { createDbShadowRecordStore } from './shadow-store.js';

const CAMPAIGN = 'a1000000-0000-4000-8000-000000000001';
const INPUT = 'b1000000-0000-4000-8000-000000000001';
const RECORD = 'c1000000-0000-4000-8000-000000000001';
const PRIMARY = 'd1000000-0000-4000-8000-000000000001';
const SHADOW = 'd1000000-0000-4000-8000-000000000002';

function record(): IntentShadowRecord {
  return {
    schema: 'buddy.intent-shadow.v1',
    record_id: RECORD,
    campaign_id: CAMPAIGN,
    input_id: INPUT,
    request_revision: '1',
    primary: {
      deployment_id: PRIMARY,
      outcome: 'ok',
      intent: 'create_task',
      args: {
        target_candidate_id: null,
        start: null,
        end: null,
        due: null,
        title: '牛乳を買う',
        body: null,
        subject: null,
        add_labels: null,
        remove_labels: null,
        task_change: null,
        memory_kind: null,
        query: null,
        device_name: null,
      },
      probability: null,
      latency_ms: 120,
    },
    shadows: [
      {
        deployment_id: SHADOW,
        outcome: 'timeout',
        intent: null,
        args: null,
        probability: null,
        latency_ms: null,
      },
    ],
    recorded_at: '2031-01-01T00:00:00Z',
    expires_at: '2031-01-08T00:00:00Z',
    used_for_execution: false,
  } as IntentShadowRecord;
}

function fakeClient(response: (op: IntentShadowOp) => IntentShadowOpResult): {
  client: Pick<DbWorkerClient, 'intentShadow'>;
  ops: IntentShadowOp[];
} {
  const ops: IntentShadowOp[] = [];
  const client = {
    intentShadow: (op: IntentShadowOp) => {
      ops.push(op);
      return Promise.resolve(response(op));
    },
  } as unknown as Pick<DbWorkerClient, 'intentShadow'>;
  return { client, ops };
}

test('件数は worker の値をそのまま返す', async () => {
  const { client, ops } = fakeClient(() => ({
    ok: true,
    value: { campaign_id: CAMPAIGN, count: 299 },
  }));
  const store = createDbShadowRecordStore(client);
  assert.equal(await store.count(CAMPAIGN), 299);
  assert.deepEqual(ops, [
    { kind: 'intent_shadow.count', campaign_id: CAMPAIGN },
  ]);
});

test('件数が読めなければ例外にする（比較を始めない側）', async () => {
  const { client } = fakeClient(() => ({
    ok: false,
    outcome: 'rejected',
    reasons: ['worker_halted'],
  }));
  const store = createDbShadowRecordStore(client);
  await assert.rejects(
    store.count(CAMPAIGN),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'shadow_count_failed:worker_halted',
  );
});

test('保存は記録・上限・保存モードを渡し、結果の語を返す', async () => {
  let answer: 'saved' | 'duplicate' | 'limit_reached' = 'saved';
  const { client, ops } = fakeClient(() => ({
    ok: true,
    value: { record_id: RECORD, result: answer },
  }));
  const store = createDbShadowRecordStore(client);
  const input = record();
  assert.equal(await store.save(input, 300, 'normal'), 'saved');
  answer = 'duplicate';
  assert.equal(await store.save(input, 300, 'normal'), 'duplicate');
  answer = 'limit_reached';
  assert.equal(await store.save(input, 5, 'extended'), 'limit_reached');
  assert.deepEqual(ops, [
    {
      kind: 'intent_shadow.save',
      record: input,
      limit: 300,
      storage_mode: 'normal',
    },
    {
      kind: 'intent_shadow.save',
      record: input,
      limit: 300,
      storage_mode: 'normal',
    },
    {
      kind: 'intent_shadow.save',
      record: input,
      limit: 5,
      storage_mode: 'extended',
    },
  ]);
});

test('保存の拒否は failed にする（例外にしない）', async () => {
  const { client } = fakeClient(() => ({
    ok: false,
    outcome: 'rejected',
    reasons: ['shadow_not_permitted'],
  }));
  const store = createDbShadowRecordStore(client);
  assert.equal(await store.save(record(), 300, 'private'), 'failed');
});

test('成否不明（COMMIT の失敗）も failed にする', async () => {
  const { client } = fakeClient(() => ({
    ok: false,
    outcome: 'unknown',
    reasons: ['commit_failed'],
  }));
  const store = createDbShadowRecordStore(client);
  assert.equal(await store.save(record(), 300, 'normal'), 'failed');
});
