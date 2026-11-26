// 自動実行の経路（AutoActionBridge。B13-05、ADR 0154）の試験。接続は模擬（中枢への要求を記録して手で答える）で、世代を
// 手で動かす。期待値（表示用の値・本文・理由）は手で書いた合成の値。実メール・実 API は使わない。
// 確かめること: 画面へ操作 ID・版を渡さない、読めなかったことを「自動実行なし」「動いている」にしない、取り消しは一覧で
// 読んだ state_revision を送り、受け付けられたら読み直す、対象が変わっていた 409 は undo_target_changed、ほかの 409・410 は
// preview_stale、結果不明は送り直さず次の読み取りまで取り消させない、解除は画面が見ている停止の参照でだけ送る、世代を
// またいだ読み取りは反映しない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import { AutoActionBridge } from './auto-action-bridge.js';
import type { AutoActionHost } from './auto-action-bridge.js';
import { createDesktopContract, loadContractSchema } from './contract.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const SCOPE = uuid(0x5c);
const LABEL_OP = uuid(0x801);
const TASK_OP = uuid(0x802);
const NOW = Date.parse('2030-10-09T03:00:00.000Z');

const item = (fields: Record<string, unknown> = {}) => ({
  operation_id: LABEL_OP,
  action_kind: 'label_mail',
  policy_version: '1',
  state_revision: '4',
  completed_at: '2030-10-08T02:00:00Z',
  undo_state: 'available',
  undo_deadline: '2030-11-07T02:00:00Z',
  undo_target: null,
  ...fields,
});

const taskItem = () =>
  item({
    operation_id: TASK_OP,
    action_kind: 'create_task',
    state_revision: '2',
    completed_at: '2030-10-07T09:00:00Z',
    undo_state: 'unavailable',
    undo_deadline: '2030-11-06T09:00:00Z',
  });

const running = (revision = '3') => ({
  state: 'running',
  safety_revision: revision,
  stop_reason: null,
  stopped_at: null,
});

const stopped = (revision = '4') => ({
  state: 'stopped',
  safety_revision: revision,
  stop_reason: 'rate_exceeded',
  stopped_at: '2030-10-09T02:30:00Z',
  auto_approvals: {
    window_started_at: '2030-10-09T02:20:00Z',
    auto_approvals: 20,
    limit: 20,
    window_minutes: 10,
  },
});

const listBody = (
  items: unknown[] = [item(), taskItem()],
  safety: unknown = running(),
) => ({ safety, items });

const receipt = {
  request_id: uuid(0x901),
  command_id: uuid(0x902),
  operation_id: uuid(0x903),
  state_revision: '1',
  status: 'durable',
  committed_state_revision: '2',
};

type Outcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' }
  | { kind: 'not_sent'; reason: 'not_connected' };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly scoped?: boolean;
  readonly screenOperation?: boolean;
  readonly expectedScopeId?: string;
}

interface Rig {
  readonly bridge: AutoActionBridge;
  readonly calls: Call[];
  readonly logs: string[];
  list: () => Outcome;
  post: (call: Call) => Outcome;
  delay: (() => Promise<void>) | null;
  scope: string | null;
  posts(): Call[];
}

function rig(): Rig {
  const calls: Call[] = [];
  const logs: string[] = [];
  const state: Rig = {
    calls,
    logs,
    list: () => ({ kind: 'response', status: 200, body: listBody() }),
    post: () => ({ kind: 'unknown' }),
    delay: null,
    scope: SCOPE,
    posts: () => calls.filter((call) => call.method === 'POST'),
    bridge: undefined as unknown as AutoActionBridge,
  };
  const connection = {
    get state() {
      return { commandScopeId: state.scope, phase: 'live' };
    },
    request: async (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (state.delay !== null) await state.delay();
      if (call.method === 'GET' && call.path === '/v1/auto-actions')
        return state.list();
      return state.post(call);
    },
  } as unknown as ClientConnection;
  let counter = 0x100;
  const host: AutoActionHost = {
    contract,
    connection: () => connection,
    newRef: () => uuid(counter++),
    now: () => NOW,
    log: (code) => logs.push(code),
  };
  return Object.assign(state, { bridge: new AutoActionBridge(host) });
}

const ok = <T>(outcome: { ok: boolean; value?: T }): T => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.value as T;
};

test('the list carries refs and display values only, never operation IDs or revisions', async () => {
  const r = rig();
  const view = ok(await r.bridge.list());
  assert.deepEqual(view, {
    fetch: 'loaded',
    fetched_at: '2030-10-09T03:00:00.000Z',
    safety: {
      ref: uuid(0x102),
      state: 'running',
      stop_reason: null,
      stopped_at: null,
    },
    entries: [
      {
        ref: uuid(0x100),
        position: 0,
        kind: 'label_mail',
        completed_at: '2030-10-08T02:00:00Z',
        undo_state: 'available',
        undo_deadline: '2030-11-07T02:00:00Z',
        delivery_unknown: false,
      },
      {
        ref: uuid(0x101),
        position: 1,
        kind: 'create_task',
        completed_at: '2030-10-07T09:00:00Z',
        undo_state: 'unavailable',
        undo_deadline: '2030-11-06T09:00:00Z',
        delivery_unknown: false,
      },
    ],
    list_seq: 2,
  });
  const text = JSON.stringify(view);
  for (const secret of [LABEL_OP, TASK_OP, '"4"', 'safety_revision'])
    assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(r.calls, [
    { method: 'GET', path: '/v1/auto-actions', expectedScopeId: SCOPE },
  ]);
  // 読み直しても同じ操作は同じ参照、同じ停止の版は同じ参照のまま。
  const again = ok(await r.bridge.list());
  assert.deepEqual(
    again.entries.map((entry) => entry.ref),
    [uuid(0x100), uuid(0x101)],
  );
  assert.equal(again.safety?.ref, uuid(0x102));
  assert.equal(r.bridge.safetyStopped(), false);
});

test('a failed read keeps the last values as stale and never reads as empty or running', async () => {
  const r = rig();
  r.list = () => ({ kind: 'response', status: 503, body: {} });
  const first = ok(await r.bridge.list());
  assert.equal(first.fetch, 'unavailable');
  assert.equal(first.safety, null);
  assert.deepEqual(first.entries, []);
  assert.equal(r.bridge.safetyStopped(), null);
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([item()], stopped()),
  });
  ok(await r.bridge.list());
  // 形の違う応答（本文の項目を足した）も読めなかったことにする。
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([item({ intent: 'x' })], running()),
  });
  const stale = ok(await r.bridge.list());
  assert.equal(stale.fetch, 'stale');
  assert.equal(stale.safety?.state, 'stopped');
  assert.equal(stale.entries.length, 1);
  assert.equal(r.bridge.safetyStopped(), true);
  assert.deepEqual(r.logs, [
    'auto_action_list_unavailable',
    'auto_action_list_unavailable',
  ]);
});

test('undo sends the read state_revision as a scoped screen operation and re-reads after the receipt', async () => {
  const r = rig();
  const view = ok(await r.bridge.list());
  r.post = () => ({ kind: 'response', status: 202, body: receipt });
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([item({ undo_state: 'in_progress' }), taskItem()]),
  });
  const after = ok(await r.bridge.undo(view.entries[0]!.ref));
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: `/v1/auto-actions/${LABEL_OP}/undo`,
      body: { expected_state_revision: '4' },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(after.entries[0]!.undo_state, 'in_progress');
  assert.equal(r.calls.at(-1)?.method, 'GET');
});

test('undo is not sent for an unknown ref or a row that the list says cannot be undone', async () => {
  const r = rig();
  const view = ok(await r.bridge.list());
  assert.deepEqual(await r.bridge.undo(uuid(0xfff)), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.deepEqual(await r.bridge.undo(view.entries[1]!.ref), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.deepEqual(r.posts(), []);
});

test('a target that changed afterwards is reported as such; other conflicts and expiry are stale', async () => {
  const r = rig();
  const view = ok(await r.bridge.list());
  const ref = view.entries[0]!.ref;
  r.post = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'target_changed', message: 'm', request_id: null },
  });
  assert.deepEqual(await r.bridge.undo(ref), {
    ok: false,
    reason: 'undo_target_changed',
  });
  r.post = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'conflict', message: 'm', request_id: null },
  });
  assert.deepEqual(await r.bridge.undo(ref), {
    ok: false,
    reason: 'preview_stale',
  });
  r.post = () => ({
    kind: 'response',
    status: 410,
    body: { code: 'undo_expired', message: 'm', request_id: null },
  });
  assert.deepEqual(await r.bridge.undo(ref), {
    ok: false,
    reason: 'preview_stale',
  });
  r.post = () => ({
    kind: 'response',
    status: 422,
    body: { code: 'invalid_input', message: 'm', request_id: null },
  });
  assert.deepEqual(await r.bridge.undo(ref), {
    ok: false,
    reason: 'core_rejected',
  });
  // どれも送り直さず、読み直しを始める。
  assert.equal(r.posts().length, 4);
});

test('an unknown undo outcome is not resent and holds the row until a later read succeeds', async () => {
  const r = rig();
  const view = ok(await r.bridge.list());
  const ref = view.entries[0]!.ref;
  r.post = () => ({ kind: 'unknown' });
  // 読み直しを止めて、保留の間の表示を見る。
  r.list = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await r.bridge.undo(ref), {
    ok: false,
    reason: 'outcome_unknown',
  });
  const held = r.bridge.view();
  assert.equal(held.entries[0]!.delivery_unknown, true);
  assert.deepEqual(await r.bridge.undo(ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(r.posts().length, 1);
  // 503 も結果不明（中枢は保存の成否が分からないときも 503）。
  r.list = () => ({ kind: 'response', status: 200, body: listBody() });
  const read = ok(await r.bridge.list());
  assert.equal(read.entries[0]!.delivery_unknown, false);
  r.post = () => ({ kind: 'response', status: 503, body: {} });
  r.list = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await r.bridge.undo(ref), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(r.bridge.view().entries[0]!.delivery_unknown, true);
  assert.deepEqual(r.logs.slice(0, 1), ['auto_action_undo_outcome_unknown']);
});

test('resume sends the read safety_revision only for the stop the screen shows', async () => {
  const r = rig();
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([], stopped('4')),
  });
  const view = ok(await r.bridge.list());
  const shown = view.safety!.ref;
  assert.equal(view.safety?.stop_reason, 'rate_exceeded');
  // 画面を開いた後に停止の版が変わった（読み直した）: 画面が見ていた参照では送らない。
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([], stopped('5')),
  });
  const newer = ok(await r.bridge.list());
  assert.notEqual(newer.safety!.ref, shown);
  assert.deepEqual(await r.bridge.resume(shown), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.deepEqual(r.posts(), []);
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: running('6'),
  });
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([], running('6')),
  });
  const after = ok(await r.bridge.resume(newer.safety!.ref));
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: '/v1/safety/resume',
      body: { expected_safety_revision: '5' },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(after.safety?.state, 'running');
  // 動いているときは解除を送らない。
  assert.deepEqual(await r.bridge.resume(after.safety!.ref), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.equal(r.posts().length, 1);
});

test('resume conflicts are stale and unknown outcomes are not resent', async () => {
  const r = rig();
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([], stopped('4')),
  });
  const ref = ok(await r.bridge.list()).safety!.ref;
  r.post = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'conflict', message: 'm', request_id: null },
  });
  assert.deepEqual(await r.bridge.resume(ref), {
    ok: false,
    reason: 'preview_stale',
  });
  r.post = () => ({ kind: 'unknown' });
  assert.deepEqual(await r.bridge.resume(ref), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(r.posts().length, 2);
  assert(r.logs.includes('safety_resume_outcome_unknown'));
});

test('a reset drops refs and values, and a read that spans the reset is not applied', async () => {
  const r = rig();
  const view = ok(await r.bridge.list());
  let release: () => void = () => undefined;
  r.delay = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = r.bridge.list();
  await Promise.resolve();
  r.bridge.reset();
  release();
  assert.deepEqual(await pending, { ok: false, reason: 'not_connected' });
  r.delay = null;
  const after = r.bridge.view();
  assert.equal(after.fetch, 'unavailable');
  assert.equal(after.safety, null);
  assert.deepEqual(after.entries, []);
  assert.deepEqual(await r.bridge.undo(view.entries[0]!.ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  // 送った後に世代が変わった取り消しは結果不明として返す（自動では送り直さない）。
  ok(await r.bridge.list());
  const ref = r.bridge.view().entries[0]!.ref;
  r.post = () => ({ kind: 'response', status: 202, body: receipt });
  r.delay = () => {
    r.bridge.reset();
    return Promise.resolve();
  };
  assert.deepEqual(await r.bridge.undo(ref), {
    ok: false,
    reason: 'outcome_unknown',
  });
});

test('without a connection scope nothing is sent', async () => {
  const r = rig();
  r.scope = null;
  assert.deepEqual(await r.bridge.list(), {
    ok: false,
    reason: 'not_connected',
  });
  assert.deepEqual(await r.bridge.undo(uuid(0x100)), {
    ok: false,
    reason: 'not_connected',
  });
  assert.deepEqual(await r.bridge.resume(uuid(0x100)), {
    ok: false,
    reason: 'not_connected',
  });
  assert.deepEqual(r.calls, []);
});
