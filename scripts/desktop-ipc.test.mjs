import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_REJECT_REASONS,
  DESKTOP_NOTIFICATION_CHANNELS,
  DESKTOP_POWER_EVENTS,
  admitDesktopRequest,
  desktopInputPermitted,
  nextDesktopIoState,
  statusBarVisibility,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// デスクトップの限定 IPC（ADR 0014）。ビルド後の domain を、手書きの期待値（fixtures）と schema の列挙で検査する。
const { schema, validators } = await loadContracts();
const defs = schema.$defs;
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));
const cases = await read('packages/contracts/fixtures/schema-cases.json');
const spec = await read('packages/contracts/fixtures/desktop-ipc-cases.json');
const fixture = (id) =>
  structuredClone(cases.find((entry) => entry.id === id).value);
const consts = (def, field) =>
  def.oneOf.map((branch) => branch.properties[field].const);

test('channel, event and reason lists in the schema and domain are the same', () => {
  assert.deepEqual(defs.DesktopIpcChannel.enum, [...DESKTOP_IPC_CHANNELS]);
  assert.deepEqual(consts(defs.DesktopIpcRequest, 'channel'), [
    ...DESKTOP_IPC_CHANNELS,
  ]);
  assert.deepEqual(consts(defs.DesktopIpcNotification, 'channel'), [
    ...DESKTOP_NOTIFICATION_CHANNELS,
  ]);
  const power = defs.DesktopIpcNotification.oneOf.find(
    (branch) => branch.properties.channel.const === 'desktop.power_event',
  );
  assert.deepEqual(power.properties.event.enum, [...DESKTOP_POWER_EVENTS]);
  const rejected = defs.DesktopIpcResponse.oneOf.find(
    (branch) => branch.properties.outcome.const === 'rejected',
  );
  assert.deepEqual(rejected.properties.reason.enum, [
    ...DESKTOP_IPC_REJECT_REASONS,
  ]);
  // 成功応答の分岐は全チャネルを一度ずつ受け持つ。
  const okChannels = defs.DesktopIpcResponse.oneOf
    .filter((branch) => branch.properties.outcome.const === 'ok')
    .flatMap((branch) => branch.properties.channel.enum);
  assert.deepEqual([...okChannels].sort(), [...DESKTOP_IPC_CHANNELS].sort());
});

test('client quit, local IO stop and hub stop are separate; no token, device ID, URL or hub stop exists', () => {
  // 中枢の停止・汎用の HTTP 実行を表すチャネルがない（07 §2、02 停止）。
  for (const channel of DESKTOP_IPC_CHANNELS)
    assert.doesNotMatch(channel, /hub|core|http|url|fetch|token/u, channel);
  assert(DESKTOP_IPC_CHANNELS.includes('desktop.client_quit'));
  assert(DESKTOP_IPC_CHANNELS.includes('desktop.io_stop'));
  // 要求・状態欄・通知のどこにも端末 ID・トークン・URL の項目がない。
  const banned = /device_id|token|secret|url|method|scope_id|hub_stop/u;
  const walk = (node, path) => {
    if (Array.isArray(node)) node.forEach((item) => walk(item, path));
    else if (node && typeof node === 'object') {
      for (const key of Object.keys(node.properties ?? {}))
        assert.doesNotMatch(key, banned, `${path}.${key}`);
      for (const [key, value] of Object.entries(node))
        walk(value, path + '/' + key);
    }
  };
  for (const name of [
    'DesktopIpcRequest',
    'DesktopIpcResponse',
    'DesktopIpcNotification',
    'DesktopStatusBar',
  ])
    walk(defs[name], name);
  // 入出力停止は local だけで、範囲を指定できない。
  const stop = fixture('desktop-ipc-io-stop');
  for (const scope of ['local', 'guest', 'global'])
    assert(!validators.DesktopIpcRequest({ ...stop, payload: { scope } }));
});

test('main admits requests by the hand-written table', () => {
  const { state, sender, cases: entries } = spec.admission;
  assert(entries.length > 0);
  for (const entry of entries)
    assert.deepEqual(
      admitDesktopRequest(
        entry.channel,
        entry.expected_io_epoch,
        { ...state, ...entry.state },
        { ...sender, ...entry.sender },
      ),
      entry.expected,
      entry.id,
    );
  // 拒否の理由は schema の列挙にある。
  for (const entry of entries)
    if (!entry.expected.ok)
      assert(DESKTOP_IPC_REJECT_REASONS.includes(entry.expected.reason));
});

test('IO state transitions never resume on unlock or wake', () => {
  for (const entry of spec.transitions)
    assert.deepEqual(
      nextDesktopIoState(entry.state, entry.event),
      entry.expected,
      entry.id,
    );
  for (const entry of spec.views) {
    assert.equal(
      statusBarVisibility(entry.state.lockState),
      entry.visibility,
      JSON.stringify(entry.state),
    );
    assert.equal(
      desktopInputPermitted(entry.state),
      entry.input_permitted,
      JSON.stringify(entry.state),
    );
  }
  // ロック → 解除 の後は、画面の再開を受け付けるまで入出力を許可しない。
  const running = { lockState: 'unlocked', stopScope: 'none', ioEpoch: '5' };
  const locked = nextDesktopIoState(running, {
    kind: 'power',
    event: 'lock_screen',
  });
  const unlocked = nextDesktopIoState(locked, {
    kind: 'power',
    event: 'unlock_screen',
  });
  assert.equal(desktopInputPermitted(unlocked), false);
  const focused = { trustedSender: true, windowFocused: true };
  // 停止前の世代を持つ古い再開の画面は使えない。
  assert.deepEqual(
    admitDesktopRequest('desktop.io_resume', '5', unlocked, focused),
    { ok: false, reason: 'io_epoch_mismatch' },
  );
  assert.deepEqual(
    admitDesktopRequest(
      'desktop.io_resume',
      unlocked.ioEpoch,
      unlocked,
      focused,
    ),
    { ok: true },
  );
  assert.equal(
    desktopInputPermitted(nextDesktopIoState(unlocked, { kind: 'io_resume' })),
    true,
  );
});

test('the status bar hides content while locked or unknown and keeps hub-owned values unknown without the hub', () => {
  for (const id of ['desktop-status-locked', 'desktop-status-lock-unknown']) {
    const value = fixture(id);
    assert.deepEqual(Object.keys(value).sort(), ['lock_state', 'visibility']);
  }
  const stopped = fixture('desktop-status-b01-stopped');
  assert.deepEqual(semanticErrors('DesktopStatusBar', stopped), []);
  const check = (change, expected) => {
    const value = { ...stopped, ...change };
    assert(validators.DesktopStatusBar(value), JSON.stringify(change));
    assert.deepEqual(
      semanticErrors('DesktopStatusBar', value),
      expected,
      JSON.stringify(change),
    );
  };
  check({ input_permitted: true }, ['input_permitted_while_stopped']);
  check({ voice_state: 'waiting_wake_word' }, [
    'voice_state_conflicts_with_stop',
  ]);
  check({ voice_state: 'global_stopped' }, ['voice_state_conflicts_with_stop']);
  check({ voice_state: 'device_stopped' }, []);
  check({ stop_scope: 'global', voice_state: 'global_stopped' }, []);
  check({ stop_scope: 'guest', voice_state: 'global_stopped' }, []);
  check({ stop_scope: 'none', input_permitted: true }, []);
  check({ stop_scope: 'none', voice_state: 'device_stopped' }, [
    'voice_state_conflicts_with_stop',
  ]);
  check({ storage_mode: 'normal' }, ['hub_values_without_connection']);
  check({ hub_last_confirmed_at: '2030-01-01T00:00:00Z' }, [
    'hub_values_without_connection',
  ]);
  check({ hub_connection: 'unreachable' }, []);
  check(
    {
      hub_connection: 'unreachable',
      hub_last_confirmed_at: '2030-01-01T00:00:00Z',
    },
    [],
  );
  check({ hub_connection: 'unreachable', safety_stopped: false }, [
    'hub_values_without_connection',
  ]);
  check({ hub_connection: 'connected' }, ['connected_without_values']);
  const connected = fixture('desktop-status-connected');
  assert.deepEqual(semanticErrors('DesktopStatusBar', connected), []);
  assert.deepEqual(
    semanticErrors('DesktopStatusBar', { ...connected, budget_held: null }),
    ['connected_without_values'],
  );
});

test('responses reflect the stop or resume they acknowledge', () => {
  const stop = fixture('desktop-response-state');
  assert.deepEqual(semanticErrors('DesktopIpcResponse', stop), []);
  const running = { ...stop.status, stop_scope: 'none', input_permitted: true };
  assert.deepEqual(
    semanticErrors('DesktopIpcResponse', { ...stop, status: running }),
    ['stop_not_reflected'],
  );
  const resume = { ...stop, channel: 'desktop.io_resume' };
  assert.deepEqual(semanticErrors('DesktopIpcResponse', resume), [
    'resume_not_reflected',
  ]);
  assert.deepEqual(
    semanticErrors('DesktopIpcResponse', { ...resume, status: running }),
    [],
  );
  assert.deepEqual(
    semanticErrors('DesktopIpcResponse', {
      ...resume,
      status: { visibility: 'hidden', lock_state: 'locked' },
    }),
    ['resume_not_reflected'],
  );
  // 状態欄の不変条件は応答・通知の中でも検査する。
  const broken = { ...stop.status, input_permitted: true };
  assert.deepEqual(
    semanticErrors('DesktopIpcResponse', { ...stop, status: broken }),
    ['input_permitted_while_stopped'],
  );
  assert.deepEqual(
    semanticErrors('DesktopIpcNotification', {
      channel: 'desktop.state_changed',
      status: broken,
    }),
    ['input_permitted_while_stopped'],
  );
});

test('power event records name their source; a query only reports the lock state', () => {
  const lock = fixture('desktop-notify-lock');
  assert.deepEqual(semanticErrors('DesktopIpcNotification', lock), []);
  for (const event of ['lock_screen', 'unlock_screen'])
    assert.deepEqual(
      semanticErrors('DesktopIpcNotification', {
        ...lock,
        event,
        source: 'os_query',
      }),
      [],
    );
  for (const event of ['suspend', 'resume', 'shutdown']) {
    const value = { ...lock, event, source: 'os_query' };
    assert(validators.DesktopIpcNotification(value));
    assert.deepEqual(semanticErrors('DesktopIpcNotification', value), [
      'query_without_lock_state',
    ]);
  }
});
