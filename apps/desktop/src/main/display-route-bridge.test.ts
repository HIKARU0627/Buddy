// 流れの表示先の経路（DisplayRouteBridge。UI-05 の段階 5、ADR 0193）の試験。接続は模擬（中枢への要求を記録して手で答える）。
// 期待値（送る本文・送り先・画面操作の印・表示先・理由）は手で書いた。確かめること: 移すときは直前に中枢の今の版を読んで添え、
// 移す先は自分の端末だけ・画面操作として 1 回だけ送る、受け付けたら中枢が返した表示先を持つ、結果が分からなければ送り直さずに
// 読み直す、拒否（他の端末が先に移した）では読み直して中枢にそろえる、読めなかったら前の値のまま（他の端末とみなさない）、
// 版を読めなければ送らない、未決定のときは表示のリースを持っている間だけこの端末、世代をまたいだ結果を反映しない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DisplayRouteBridge } from './display-route-bridge.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SCOPE = uuid(0x5c);
const ME = uuid(0xa1);
const OTHER = uuid(0xb1);
const NIL = uuid(0);

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

const view = (revision: string, device: string, state = 'completed') => ({
  session_id: NIL,
  route_revision: revision,
  display_device_id: device,
  state,
});

function rig() {
  const calls: Call[] = [];
  const changes: number[] = [];
  const logs: string[] = [];
  const state = {
    read: (): Outcome => ({
      kind: 'response',
      status: 200,
      body: view('3', OTHER),
    }),
    post: (): Outcome => ({
      kind: 'response',
      status: 202,
      body: view('4', ME, 'moving'),
    }),
    held: false,
    connected: true,
    // 読み取りの応答を、これが解けるまで待たせる（null なら待たせない）。
    readGate: null as Promise<void> | null,
    postGate: null as Promise<void> | null,
  };
  const connection = {
    get state() {
      return { commandScopeId: SCOPE, deviceId: ME, phase: 'live' };
    },
    request: (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (call.method === 'GET') {
        const gate = state.readGate;
        return gate === null
          ? Promise.resolve(state.read())
          : gate.then(() => state.read());
      }
      const gate = state.postGate;
      return gate === null
        ? Promise.resolve(state.post())
        : gate.then(() => state.post());
    },
  } as unknown as ClientConnection;
  let changed = 0;
  const bridge = new DisplayRouteBridge({
    contract,
    connection: () => (state.connected ? connection : null),
    leaseHeld: () => state.held,
    changed: () => {
      changed += 1;
      changes.push(changed);
    },
    log: (code) => logs.push(code),
  });
  return { bridge, calls, state, changes, logs };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('reading: unknown until read, another device or this device after, and the last value kept when a read fails', async () => {
  const { bridge, calls, state, changes } = rig();
  assert.equal(bridge.target, null);
  await bridge.refresh();
  assert.equal(bridge.target, 'other_device');
  assert.deepEqual(calls, [
    { method: 'GET', path: '/v1/stream/handoff', expectedScopeId: SCOPE },
  ]);
  assert.equal(changes.length, 1);
  // 同じ値では知らせない。
  await bridge.refresh();
  assert.equal(changes.length, 1);
  // この端末が表示先。
  state.read = () => ({ kind: 'response', status: 200, body: view('5', ME) });
  await bridge.refresh();
  assert.equal(bridge.target, 'this_device');
  // 読めない（結果不明・503・形の違う応答・ID を余計に持つ応答）ときは前の値のまま（他の端末とみなさない・null にもしない）。
  state.read = () => ({ kind: 'unknown' });
  await bridge.refresh();
  state.read = () => ({ kind: 'response', status: 503, body: {} });
  await bridge.refresh();
  state.read = () => ({
    kind: 'response',
    status: 200,
    body: { ...view('6', OTHER), extra: true },
  });
  await bridge.refresh();
  assert.equal(bridge.target, 'this_device');
  // 接続していなければ送らない。
  const before = calls.length;
  state.connected = false;
  await bridge.refresh();
  assert.equal(calls.length, before);
});

test('an undecided route is this device only while the display lease is held', async () => {
  const { bridge, state } = rig();
  state.read = () => ({ kind: 'response', status: 200, body: view('0', NIL) });
  await bridge.refresh();
  assert.equal(bridge.target, null);
  state.held = true;
  assert.equal(bridge.target, 'this_device');
  state.held = false;
  assert.equal(bridge.target, null);
});

test('moving reads the current revision first, then sends one screen operation naming only this device', async () => {
  const { bridge, calls } = rig();
  const result = await bridge.handoff();
  assert.deepEqual(result, { ok: true, value: 'moving' });
  assert.equal(bridge.target, 'this_device');
  assert.deepEqual(calls, [
    { method: 'GET', path: '/v1/stream/handoff', expectedScopeId: SCOPE },
    {
      method: 'POST',
      path: '/v1/stream/handoff',
      body: { target_device_id: ME, expected_route_revision: '3' },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
});

test('nothing is sent when the revision cannot be read or when not connected', async () => {
  const { bridge, calls, state } = rig();
  state.read = () => ({ kind: 'unknown' });
  assert.deepEqual(await bridge.handoff(), {
    ok: false,
    reason: 'core_rejected',
  });
  state.read = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await bridge.handoff(), {
    ok: false,
    reason: 'core_rejected',
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'GET'],
  );
  state.connected = false;
  assert.deepEqual(await bridge.handoff(), {
    ok: false,
    reason: 'not_connected',
  });
  assert.equal(calls.length, 2);
});

test('an unknown result is not resent; the route is read again instead', async () => {
  const { bridge, calls, state, logs } = rig();
  state.post = () => ({ kind: 'unknown' });
  state.read = () => ({
    kind: 'response',
    status: 200,
    body: view('4', ME),
  });
  const result = await bridge.handoff();
  assert.deepEqual(result, { ok: false, reason: 'outcome_unknown' });
  await settle();
  // 移動は 1 回だけ。その後は読み取りだけ。
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'POST', 'GET'],
  );
  assert.equal(bridge.target, 'this_device');
  assert(logs.includes('display_handoff_unknown'));
});

test('a refusal (another device moved first) is not resent; the route is read again and stays with the other device', async () => {
  const { bridge, calls, state, logs } = rig();
  // 読んだ後に、他の端末が先に移した（版が進んだ）。
  state.post = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'conflict', message: 'x', request_id: null },
  });
  let reads = 0;
  state.read = () => {
    reads += 1;
    return {
      kind: 'response',
      status: 200,
      body: reads === 1 ? view('3', OTHER) : view('4', OTHER),
    };
  };
  const result = await bridge.handoff();
  assert.deepEqual(result, { ok: false, reason: 'core_rejected' });
  await settle();
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'POST', 'GET'],
  );
  assert.equal(bridge.target, 'other_device');
  assert(logs.includes('display_handoff_rejected:409'));
  // 拒否の応答（形の違う 202 を含む）はどれも成功にしない。
  state.post = () => ({ kind: 'response', status: 202, body: { state: 'x' } });
  assert.deepEqual(await bridge.handoff(), {
    ok: false,
    reason: 'core_rejected',
  });
});

test('a lock or disconnect during the exchange drops the result', async () => {
  const { bridge, state } = rig();
  let release: () => void = () => undefined;
  state.readGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = bridge.refresh();
  bridge.reset();
  release();
  await reading;
  assert.equal(bridge.target, null);
  // 移動を送った後に世代が変われば、移ったかは分からない（結果を画面へ返さず、値も持たない）。
  state.readGate = null;
  state.postGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const moving = bridge.handoff();
  await settle();
  bridge.reset();
  release();
  assert.deepEqual(await moving, { ok: false, reason: 'outcome_unknown' });
  assert.equal(bridge.target, null);
});

test('a read that started earlier does not overwrite a newer result', async () => {
  const { bridge, state } = rig();
  let release: () => void = () => undefined;
  state.readGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 古い読み取り（まだ答えが来ない。答えは「他の端末」）。
  state.read = () => ({
    kind: 'response',
    status: 200,
    body: view('3', OTHER),
  });
  const slow = bridge.refresh();
  // 新しい移動の結果（この端末）が先に反映される。
  state.readGate = null;
  state.read = () => ({
    kind: 'response',
    status: 200,
    body: view('3', OTHER),
  });
  const moved = await bridge.handoff();
  assert.deepEqual(moved, { ok: true, value: 'moving' });
  release();
  await slow;
  assert.equal(bridge.target, 'this_device');
});
