// 安全停止の知らせ（U315、ADR 0198）の試験。
// - 純粋な部品（createSafetyNotices）: 起動のときの版より後の変化だけを 1 回知らせる・読めないときは送らない・重なった
//   知らせはまとめて読み直す・止めた後は送らない。
// - 製品の Core（startCore、HTTPS は 127.0.0.1・鍵は模擬）: 方針で自動承認した同じ対象への 3 回目で安全停止になると、開いて
//   いる購読へ SafetyNotice が 1 回届き、本人の解除でもう 1 回届く。知らせには ID と時刻しかない。ロック中・記録しない会話の
//   間の購読にも届く。止まらない書込み（1・2 回目）では届かない。
// 期待値は設計 03「取り消しと安全停止」・ADR 0147（同じ対象の 3 回目で止める）・ADR 0198 から手で書いた値。模擬の試験だけ。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sealOperationIntent } from '@buddy/storage';
import type { CreateOperationCommand, DbCommandOutcome } from '@buddy/storage';
import { sharedApiContract } from './api-test-support.js';
import {
  DATA_KEY_MATERIAL,
  bootstrap,
  getJson,
  insertDevice,
  openStream,
  postJson,
  startEventCore,
  submitDurable,
} from './event-test-support.js';
import type { EventCore, StreamClient } from './event-test-support.js';
import { NoticeRelay } from './notice-relay.js';
import type { StreamNoticeMessage } from './notice-relay.js';
import { createSafetyNotices } from './safety-notices.js';

const contract = sharedApiContract();

// --- 純粋な部品 ---

interface Probe {
  revision: string | null;
  reads: number;
  readonly sent: StreamNoticeMessage[];
  readonly logs: string[];
  handed: number;
  gate: Promise<void> | null;
}

function probe(): Probe {
  return { revision: '0', reads: 0, sent: [], logs: [], handed: 1, gate: null };
}

function notices(p: Probe) {
  let id = 0;
  return createSafetyNotices({
    read: async () => {
      p.reads += 1;
      if (p.gate !== null) await p.gate;
      return p.revision;
    },
    send: (message) => {
      p.sent.push(message);
      return p.handed;
    },
    now: () => new Date('2030-01-01T00:00:40Z'),
    newId: () => `00000000-0000-4000-8000-0000000000f${String((id += 1))}`,
    log: (message) => p.logs.push(message),
  });
}

test('only a change after the start revision is announced, once, with an id and a time only', async () => {
  const p = probe();
  const n = notices(p);
  await n.start();
  n.observe();
  await n.idle();
  assert.deepEqual(p.sent, []);
  p.revision = '1';
  n.observe();
  await n.idle();
  n.observe();
  await n.idle();
  assert.deepEqual(p.sent, [
    {
      type: 'notice',
      notice: {
        schema: 'buddy.safety-notice.v1',
        notice_id: '00000000-0000-4000-8000-0000000000f1',
        occurred_at: '2030-01-01T00:00:40.000Z',
      },
    },
  ]);
  assert(contract.valid('EventStreamMessage', p.sent[0]));
});

test('an unreadable state is not a change, and the next readable change is announced', async () => {
  const p = probe();
  const n = notices(p);
  await n.start();
  p.revision = null;
  n.observe();
  await n.idle();
  assert.deepEqual(p.sent, []);
  p.revision = '0';
  n.observe();
  await n.idle();
  assert.deepEqual(p.sent, []);
  p.revision = '2';
  n.observe();
  await n.idle();
  assert.equal(p.sent.length, 1);
});

test('observations while reading are folded into one more read; nothing is sent after close', async () => {
  const p = probe();
  const n = notices(p);
  await n.start();
  assert.equal(p.reads, 1);
  let open: () => void = () => undefined;
  p.gate = new Promise((resolve) => {
    open = resolve;
  });
  n.observe();
  n.observe();
  n.observe();
  p.revision = '1';
  p.gate = null;
  open();
  await n.idle();
  // 起動の 1 回、最初の読み取り、重なった知らせの読み直し 1 回。
  assert.equal(p.reads, 3);
  assert.equal(p.sent.length, 1);
  n.close();
  p.revision = '2';
  n.observe();
  await n.idle();
  assert.equal(p.sent.length, 1);
  assert.equal(p.reads, 3);
});

test('without an open stream the change is not kept for later (logged only)', async () => {
  const p = probe();
  p.handed = 0;
  const n = notices(p);
  await n.start();
  p.revision = '1';
  n.observe();
  await n.idle();
  assert.equal(p.sent.length, 1);
  assert.equal(p.logs.length, 1);
  // 同じ版では送り直さない。
  n.observe();
  await n.idle();
  assert.equal(p.sent.length, 1);
});

// 中継（NoticeRelay.publishSafety）: 開いている購読へだけ渡し、表示の後始末・起動の設定の受け取り口へは渡さない。契約に
// 合わない知らせ（状態を持つ）・ほかの種類は送らない。
test('the relay hands a safety notice to the open streams only, and refuses extra fields', () => {
  const logs: string[] = [];
  const downstream: unknown[] = [];
  const relay = new NoticeRelay({
    contract,
    downstream: {
      publish: (notice) => {
        downstream.push(notice);
      },
    },
    log: (line) => logs.push(line),
  });
  const displayed: unknown[] = [];
  relay.attachDisplay((notice) => {
    displayed.push(notice);
    return true;
  });
  const message: StreamNoticeMessage = {
    type: 'notice',
    notice: {
      schema: 'buddy.safety-notice.v1',
      notice_id: '00000000-0000-4000-8000-0000000000f1',
      occurred_at: '2030-01-01T00:00:40Z',
    },
  };
  assert.equal(relay.publishSafety(message), 0);
  const received: StreamNoticeMessage[] = [];
  relay.subscribe((sent) => {
    received.push(sent);
  });
  relay.subscribe(() => false);
  assert.equal(relay.publishSafety(message), 1);
  assert.deepEqual(received, [message]);
  const withState = {
    type: 'notice',
    notice: { ...message.notice, state: 'stopped' },
  } as unknown as StreamNoticeMessage;
  assert.equal(relay.publishSafety(withState), 0);
  const candidate: StreamNoticeMessage = {
    type: 'notice',
    notice: {
      schema: 'buddy.candidate-notice.v1',
      notice_id: '00000000-0000-4000-8000-0000000000f2',
      occurred_at: '2030-01-01T00:00:41Z',
      alert_count: 0,
    },
  };
  assert.equal(relay.publishSafety(candidate), 0);
  assert.equal(received.length, 1);
  assert.deepEqual(logs, [
    '契約に合わない安全停止の知らせを端末へ送りませんでした。',
  ]);
  assert.deepEqual(displayed, []);
  assert.deepEqual(downstream, []);
});

// --- 製品の Core ---

const ACCOUNT = '00000000-0000-4000-8000-000000000002';

// 方針で自動承認したラベルの変更を、同じ対象の鍵で作る（3 回目は記録せずに安全停止になる。ADR 0147）。
function autoLabel(targetKey: string): CreateOperationCommand {
  const operationId = randomUUID();
  const sealed = sealOperationIntent(
    DATA_KEY_MATERIAL,
    { operationId, contentVersion: 1 },
    {
      schema: 'buddy.operation.v1',
      operation_id: operationId,
      content_version: '1',
      permission_revision: '1',
      provider: 'mock',
      account_id: ACCOUNT,
      target: { remote_id: 'mail-001', source_revision: 'r1' },
      action: { kind: 'mail.labels.change', add: ['Label_1'], remove: [] },
      effects: { external_recipients: [], reconcile_scope: 'exact_target' },
    },
  );
  assert(sealed.ok);
  return {
    command_id: randomUUID(),
    operation_id: operationId,
    expected_state_revision: '0',
    request_revision: null,
    permission_revision: '1',
    forgetting_generation: '0',
    connection_id: null,
    request: null,
    kind: 'operation.create',
    workflow_id: null,
    operation_kind: 'mail.labels.change',
    effect_route: 'remote_mutation',
    content_hash: sealed.content_hash,
    intent: sealed.intent,
    auto_approval: {
      approval_id: randomUUID(),
      policy_version: '3',
      current_policy_version: '3',
      safety_target_key: targetKey,
    },
  };
}

const safetyNotices = (stream: StreamClient) =>
  stream.messages.filter(
    (message) =>
      message.type === 'notice' &&
      (message.notice as { schema: string }).schema ===
        'buddy.safety-notice.v1',
  );

const subscribed = async (core: EventCore, count: number) => {
  const relay = core.handle.notices as unknown as { listenerCount: number };
  for (let i = 0; i < 200 && relay.listenerCount !== count; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.listenerCount, count);
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test('a stop and a resume each reach the open stream once, also while locked and in a private conversation', async (t) => {
  const core = await startEventCore(t, {});
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
  const snapshot = await getJson(core, device, '/v1/snapshot');
  assert.equal(snapshot.status, 200, snapshot.text);
  const stream = openStream(
    t,
    core,
    device,
    String(snapshot.json?.['event_cursor']),
  );
  assert.deepEqual(await stream.opened, { ok: true });
  await subscribed(core, 1);

  // 記録しない会話に入る（知らせは本文を持たないので、記録しない会話の間も送る）。
  const privateMode = await postJson(
    core,
    device,
    '/v1/stream/storage-mode',
    {
      request_id: randomUUID(),
      command_scope_id: scope,
      storage_mode: 'private',
    },
    { 'buddy-input-origin': 'screen' },
  );
  assert.equal(privateMode.status, 200, privateMode.text);

  // 1・2 回目は止まらない（版は変わらない）ので、知らせは届かない。
  const key = `target:${randomUUID()}`;
  await submitDurable(core, autoLabel(key));
  await submitDurable(core, autoLabel(key));
  await settle();
  assert.deepEqual(safetyNotices(stream), []);

  // ロック中に 3 回目で止まる。
  core.env.lock = 'locked';
  const third: DbCommandOutcome = await core.handle.store.submit(autoLabel(key))
    .result;
  assert.equal(third.outcome, 'rejected', JSON.stringify(third));
  await stream.waitFor(
    () => safetyNotices(stream).length === 1,
    'the stop notice',
  );
  const [stopped] = safetyNotices(stream);
  assert(contract.valid('EventStreamMessage', stopped));
  assert.deepEqual(Object.keys((stopped as { notice: object }).notice).sort(), [
    'notice_id',
    'occurred_at',
    'schema',
  ]);
  core.env.lock = 'unlocked';

  const list = await getJson(core, device, '/v1/auto-actions');
  assert.equal(list.status, 200, list.text);
  const safety = (list.json as { safety: Record<string, unknown> }).safety;
  assert.equal(safety['state'], 'stopped');
  assert.equal(safety['stop_reason'], 'same_target_repeated');

  // 本人の解除でもう 1 回。
  const resumed = await postJson(
    core,
    device,
    '/v1/safety/resume',
    {
      request_id: randomUUID(),
      command_scope_id: scope,
      expected_safety_revision: safety['safety_revision'],
    },
    { 'buddy-input-origin': 'screen' },
  );
  assert.equal(resumed.status, 200, resumed.text);
  await stream.waitFor(
    () => safetyNotices(stream).length === 2,
    'the resume notice',
  );
  // 状態を変えない拒否された解除（版が古い）では届かない。
  const stale = await postJson(
    core,
    device,
    '/v1/safety/resume',
    {
      request_id: randomUUID(),
      command_scope_id: scope,
      expected_safety_revision: safety['safety_revision'],
    },
    { 'buddy-input-origin': 'screen' },
  );
  assert.equal(stale.status, 409, stale.text);
  await settle();
  assert.equal(safetyNotices(stream).length, 2);
});

test('a stream opened after the stop does not receive the earlier notice', async (t) => {
  const core = await startEventCore(t, {});
  const device = await insertDevice(core.handle.store);
  await bootstrap(core, device);
  const key = `target:${randomUUID()}`;
  await submitDurable(core, autoLabel(key));
  await submitDurable(core, autoLabel(key));
  const third = await core.handle.store.submit(autoLabel(key)).result;
  assert.equal(third.outcome, 'rejected');
  await settle();
  const snapshot = await getJson(core, device, '/v1/snapshot');
  const stream = openStream(
    t,
    core,
    device,
    String(snapshot.json?.['event_cursor']),
  );
  assert.deepEqual(await stream.opened, { ok: true });
  await subscribed(core, 1);
  await settle();
  assert.deepEqual(safetyNotices(stream), []);
  // 端末は一覧を読んで今の状態を知る。
  const list = await getJson(core, device, '/v1/auto-actions');
  assert.equal(
    (list.json as { safety: Record<string, unknown> }).safety['state'],
    'stopped',
  );
});
