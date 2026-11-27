// 保存モードの経路（StorageModeBridge。UI-05 の段階 6、ADR 0189）の試験。接続は模擬（中枢への要求を記録して手で答える）。
// 期待値（送る本文・送り先・画面操作の印・保存モード・理由）は手で書いた。確かめること: 切り替えは画面操作として 1 回だけ
// 送り、区切り・会話の ID を送らない、受け付けたら中枢が返した区切りの保存モードを持つ、結果が分からなければ送り直さずに
// 読み直す、拒否では読み直して値を中枢にそろえる、読めなかったら前の値のまま（通常とみなさない）、世代をまたいだ結果を
// 反映しない、後から始めた結果を先に始めた読み取りの結果で戻さない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { StorageModeBridge } from './storage-mode-bridge.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SCOPE = uuid(0x5c);

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

const segment = (mode: string, reason: string) => ({
  request_id: uuid(0x901),
  segment: {
    segment_id: uuid(0x41),
    storage_mode: mode,
    opened_at: '2030-11-04T09:00:00Z',
    open_reason: reason,
    carried_summary: null,
  },
});

function rig() {
  const calls: Call[] = [];
  const changes: number[] = [];
  const logs: string[] = [];
  const state = {
    read: (): Outcome => ({
      kind: 'response',
      status: 200,
      body: { storage_mode: 'normal' },
    }),
    change: (): Outcome => ({
      kind: 'response',
      status: 200,
      body: segment('private', 'private_started'),
    }),
    // 読み取りの応答を、これが解けるまで待たせる（null なら待たせない）。
    readGate: null as Promise<void> | null,
    connected: true,
  };
  const connection = {
    get state() {
      return { commandScopeId: SCOPE, phase: 'live' };
    },
    request: (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (call.method === 'GET') {
        const gate = state.readGate;
        return gate === null
          ? Promise.resolve(state.read())
          : gate.then(() => state.read());
      }
      return Promise.resolve(state.change());
    },
  } as unknown as ClientConnection;
  let changed = 0;
  const bridge = new StorageModeBridge({
    contract,
    connection: () => (state.connected ? connection : null),
    changed: () => {
      changed += 1;
      changes.push(changed);
    },
    log: (code) => logs.push(code),
  });
  return { bridge, calls, state, changes, logs };
}

// 非同期の読み直し（void で始めたもの）が終わるまで待つ。
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('reading the stream storage mode: unknown until read, the hub value after, and the last value kept when a read fails', async () => {
  const { bridge, calls, state, changes } = rig();
  assert.equal(bridge.mode, null);
  await bridge.refresh();
  assert.equal(bridge.mode, 'normal');
  assert.deepEqual(calls, [
    { method: 'GET', path: '/v1/stream/storage-mode', expectedScopeId: SCOPE },
  ]);
  assert.equal(changes.length, 1);
  // 同じ値では知らせない。
  await bridge.refresh();
  assert.equal(changes.length, 1);
  // 読めない（結果不明・503・形の違う応答）ときは前の値のまま（通常とみなさない・null にもしない）。
  state.read = () => ({ kind: 'unknown' });
  await bridge.refresh();
  state.read = () => ({ kind: 'response', status: 503, body: {} });
  await bridge.refresh();
  state.read = () => ({
    kind: 'response',
    status: 200,
    body: { storage_mode: 'private', segment_id: uuid(0x41) },
  });
  await bridge.refresh();
  assert.equal(bridge.mode, 'normal');
  assert.equal(changes.length, 1);
  // 接続していなければ送らない。
  state.connected = false;
  await bridge.refresh();
  assert.equal(calls.length, 5);
});

test('switching sends one screen operation without IDs and keeps the mode the hub returned', async () => {
  const { bridge, calls } = rig();
  const result = await bridge.change('private');
  assert.deepEqual(result, { ok: true, value: 'private' });
  assert.equal(bridge.mode, 'private');
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/stream/storage-mode',
      body: { storage_mode: 'private' },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
});

test('an unknown switch result is not resent; the mode is read again instead', async () => {
  const { bridge, calls, state, logs } = rig();
  await bridge.refresh();
  state.change = () => ({ kind: 'unknown' });
  state.read = () => ({
    kind: 'response',
    status: 200,
    body: { storage_mode: 'private' },
  });
  const result = await bridge.change('private');
  assert.deepEqual(result, { ok: false, reason: 'outcome_unknown' });
  await settle();
  // 切り替えは 1 回だけ。その後は読み取りだけ。
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'POST', 'GET'],
  );
  assert.equal(bridge.mode, 'private');
  assert(logs.includes('storage_mode_change_unknown'));
});

test('a refused switch reads the hub value again; not sent is not connected', async () => {
  const { bridge, calls, state } = rig();
  await bridge.refresh();
  // 世代を書けない（503）・規則の拒否（409）・画面操作でない（403）。読み直した値にそろえる。
  for (const status of [503, 409, 403]) {
    state.change = () => ({
      kind: 'response',
      status,
      body: { code: 'conflict', message: 'x', request_id: null },
    });
    assert.deepEqual(await bridge.change('extended'), {
      ok: false,
      reason: 'core_rejected',
    });
  }
  await settle();
  assert.equal(bridge.mode, 'normal');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 3);
  // 形の違う 200（区切りのない応答）も拒否と同じ。
  state.change = () => ({
    kind: 'response',
    status: 200,
    body: { storage_mode: 'extended' },
  });
  assert.deepEqual(await bridge.change('extended'), {
    ok: false,
    reason: 'core_rejected',
  });
  state.change = () => ({ kind: 'not_sent', reason: 'not_connected' });
  assert.deepEqual(await bridge.change('extended'), {
    ok: false,
    reason: 'not_connected',
  });
  state.connected = false;
  const before = calls.length;
  assert.deepEqual(await bridge.change('extended'), {
    ok: false,
    reason: 'not_connected',
  });
  assert.equal(calls.length, before);
});

test('lock or disconnect drops the value, and results across the reset are not applied', async () => {
  const { bridge, state } = rig();
  await bridge.refresh();
  assert.equal(bridge.mode, 'normal');
  let release: () => void = () => undefined;
  state.readGate = new Promise((resolve) => {
    release = resolve;
  });
  state.read = () => ({
    kind: 'response',
    status: 200,
    body: { storage_mode: 'private' },
  });
  const reading = bridge.refresh();
  bridge.reset();
  assert.equal(bridge.mode, null);
  release();
  await reading;
  // ロック・切断をまたいだ読み取りは反映しない。
  assert.equal(bridge.mode, null);
  // 切り替えも、送った後に世代が変わったら結果を返さない（分からない扱い）。
  state.readGate = null;
  const changing = bridge.change('extended');
  bridge.reset();
  assert.deepEqual(await changing, { ok: false, reason: 'outcome_unknown' });
  assert.equal(bridge.mode, null);
});

test('a later switch or turn is not overwritten by an earlier read that answers late', async () => {
  const { bridge, state } = rig();
  let release: () => void = () => undefined;
  state.readGate = new Promise((resolve) => {
    release = resolve;
  });
  state.read = () => ({
    kind: 'response',
    status: 200,
    body: { storage_mode: 'normal' },
  });
  const reading = bridge.refresh();
  assert.deepEqual(await bridge.change('private'), {
    ok: true,
    value: 'private',
  });
  release();
  await reading;
  assert.equal(bridge.mode, 'private');
  // 流れへの発言の応答の区切り（observe）も、先に始めた読み取りで戻さない。
  state.readGate = new Promise((resolve) => {
    release = resolve;
  });
  const again = bridge.refresh();
  bridge.observe('extended');
  release();
  await again;
  assert.equal(bridge.mode, 'extended');
});
