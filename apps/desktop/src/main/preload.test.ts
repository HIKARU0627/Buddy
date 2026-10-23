// ビルド後の preload（dist/preload/preload.cjs）を、Electron の代わりの模擬の contextBridge・ipcRenderer で動かす。
// 公開する API・チャネルの一覧・通知で渡す値を確かめる。期待値は手で書く。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_NOTIFICATION_CHANNELS,
  DESKTOP_ROLE_CHANNELS,
  DESKTOP_ROLE_NOTIFICATIONS,
} from '@buddy/domain';

type Listener = (event: unknown, payload: unknown) => void;

// argv を渡すと、sandbox の preload の process（argv だけ）を模擬する。渡さなければ process がない。
function loadPreload(argv?: readonly string[]) {
  const exposed = new Map<
    string,
    Record<string, (...args: never[]) => unknown>
  >();
  const invoked: [string, unknown][] = [];
  const listeners = new Map<string, Set<Listener>>();
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: Record<string, () => unknown>) =>
        exposed.set(key, api),
    },
    ipcRenderer: {
      invoke: (channel: string, request: unknown) => {
        invoked.push([channel, request]);
        return Promise.resolve({ ok: channel });
      },
      on: (channel: string, listener: Listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)?.add(listener);
      },
      removeListener: (channel: string, listener: Listener) =>
        listeners.get(channel)?.delete(listener),
    },
  };
  const requested: string[] = [];
  const source = readFileSync(
    new URL('../preload/preload.cjs', import.meta.url),
    'utf8',
  );
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name: string) => {
      requested.push(name);
      if (name !== 'electron') throw new Error(`unexpected require: ${name}`);
      return electron;
    },
    Promise,
    Error,
    ...(argv === undefined ? {} : { process: { argv } }),
  });
  return { exposed, invoked, listeners, requested };
}

test('the preload requires only electron and exposes only invoke, onNotification, the window role and the stop shortcut mark', () => {
  const { exposed, requested } = loadPreload();
  assert.deepEqual(requested, ['electron']);
  assert.deepEqual([...exposed.keys()], ['buddyDesktop']);
  assert.deepEqual(Object.keys(exposed.get('buddyDesktop') ?? {}).sort(), [
    'invoke',
    'onNotification',
    'stopShortcut',
    'windowRole',
  ]);
  // 役割の引数がなければ従来の窓。停止のショートカットの引数がなければ印を出さない（null）。
  assert.equal(exposed.get('buddyDesktop')?.['windowRole'], 'legacy');
  assert.equal(exposed.get('buddyDesktop')?.['stopShortcut'], null);
});

// UI-04: 全体の停止のショートカットを登録できたか（印だけに使う）。知らない値・2 つ以上は null。
test('the stop shortcut argument is passed through only when it is a known value', () => {
  const read = (argv: string[]) =>
    loadPreload(argv).exposed.get('buddyDesktop')?.['stopShortcut'];
  assert.equal(read(['--buddy-stop-shortcut=registered']), 'registered');
  assert.equal(
    read(['--buddy-window-role=status', '--buddy-stop-shortcut=unavailable']),
    'unavailable',
  );
  for (const argv of [
    ['--buddy-stop-shortcut=yes'],
    ['--buddy-stop-shortcut='],
    ['--buddy-stop-shortcut=registered', '--buddy-stop-shortcut=unavailable'],
  ])
    assert.equal(read(argv), null, argv.join(' '));
});

test('requests go only to the contract channels', async () => {
  const { exposed, invoked } = loadPreload();
  const api = exposed.get('buddyDesktop') as unknown as {
    invoke(request: unknown): Promise<unknown>;
  };
  const channels = [
    'desktop.get_state',
    'desktop.io_stop',
    'desktop.io_resume',
    'desktop.window_hide',
    'desktop.client_quit',
    // B03-05: 中枢との接続・ペアリング（ADR 0025）。
    'desktop.get_connection',
    'desktop.pairing_begin',
    'desktop.pairing_confirm',
    'desktop.pairing_submit',
    'desktop.pairing_cancel',
    // B03-06: 中枢の画面の端末の申請の承認・端末の管理（ADR 0026）。
    'desktop.claims_list',
    'desktop.claim_decide',
    'desktop.devices_list',
    'desktop.device_revoke',
    'desktop.pairing_open',
    // B03-08: 中枢の画面の端末の自宅のネットワークの登録（ADR 0022）。
    'desktop.home_status',
    'desktop.home_register',
    // B04-05: 発言・承認表示の準備・承認・取消・照合（ADR 0031）。
    'desktop.turn_submit',
    'desktop.operation_preview',
    'desktop.operation_approve',
    'desktop.operation_cancel',
    'desktop.operation_reconcile',
    'desktop.operation_retry',
    'desktop.operation_check',
  ];
  // preload の一覧は domain の一覧と同じ（UI-02 の canvas_summon・UI-04 の status_panel・UI-06 の canvas_user_op は
  // 従来の窓では使わないので、最後に別に足す）。
  assert.deepEqual(
    [...DESKTOP_IPC_CHANNELS],
    [
      ...channels,
      'desktop.canvas_summon',
      'desktop.status_panel',
      'desktop.canvas_user_op',
      'desktop.canvas_content',
    ],
  );
  for (const channel of channels) {
    const request = { channel, request_id: 'r', payload: null };
    assert.deepEqual(await api.invoke(request), { ok: channel });
  }
  assert.deepEqual(
    invoked.map(([channel]) => channel),
    channels,
  );
  for (const bad of [
    // 従来の窓（役割の引数なし）はキャンバスを前に出さない・状態の層のパネルを使わない。
    { channel: 'desktop.canvas_summon' },
    { channel: 'desktop.status_panel' },
    // キャンバスの物のユーザーの操作も使わない（UI-06）。
    { channel: 'desktop.canvas_user_op' },
    // キャンバスの物の中身の読み取りも使わない（UI-07）。
    { channel: 'desktop.canvas_content' },
    { channel: 'desktop.hub_stop' },
    { channel: 'desktop.power_event' },
    { channel: 'desktop.connection_changed' },
    { channel: 'desktop.pickup_token' },
    { channel: 'http.fetch' },
    null,
    'desktop.get_state',
  ])
    await assert.rejects(api.invoke(bad), /desktop_unknown_channel/u);
  assert.equal(invoked.length, channels.length);
});

test('notifications pass only the body, never the Electron event', () => {
  const { exposed, listeners } = loadPreload();
  const api = exposed.get('buddyDesktop') as unknown as {
    onNotification(listener: (value: unknown) => void): () => void;
  };
  const received: unknown[] = [];
  const unsubscribe = api.onNotification((value) => received.push(value));
  // 役割の引数がない窓（従来の窓）はキャンバスの記述（UI-03）と作業領域の外の幅（UI-06）を受けない（キャンバスの窓だけ）。
  assert.deepEqual(
    [...listeners.keys()],
    DESKTOP_NOTIFICATION_CHANNELS.filter(
      (channel) =>
        channel !== 'desktop.canvas_changed' &&
        channel !== 'desktop.canvas_work_area',
    ),
  );
  assert.deepEqual(
    [...listeners.keys()],
    [
      'desktop.state_changed',
      'desktop.power_event',
      'desktop.connection_changed',
    ],
  );
  const event = { sender: 'ipc-renderer', senderId: 0 };
  for (const set of listeners.values())
    for (const listener of set) listener(event, { body: 1 });
  assert.deepEqual(received, [{ body: 1 }, { body: 1 }, { body: 1 }]);
  unsubscribe();
  for (const set of listeners.values()) assert.equal(set.size, 0);
});

interface LoadedApi {
  readonly windowRole: string | null;
  invoke(request: unknown): Promise<unknown>;
  onNotification(listener: (value: unknown) => void): () => void;
}

const apiOf = (loaded: ReturnType<typeof loadPreload>) =>
  loaded.exposed.get('buddyDesktop') as unknown as LoadedApi;

// UI-02: 窓の役割ごとに、preload でもチャネルと通知を絞る（多重の防御。正本は main の対応表）。
// 期待する表は手で書き、domain の表とも一致することを確かめる。
const EXPECTED_ROLE_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  // キャンバスは状態の取得と物のユーザーの操作だけ（UI-06）。
  canvas: [
    'desktop.get_state',
    'desktop.canvas_user_op',
    'desktop.canvas_content',
  ],
  input: ['desktop.get_state', 'desktop.turn_submit', 'desktop.canvas_summon'],
  status: [
    'desktop.get_state',
    'desktop.io_stop',
    'desktop.io_resume',
    'desktop.window_hide',
    'desktop.client_quit',
    'desktop.get_connection',
    'desktop.pairing_begin',
    'desktop.pairing_confirm',
    'desktop.pairing_submit',
    'desktop.pairing_cancel',
    'desktop.claims_list',
    'desktop.claim_decide',
    'desktop.devices_list',
    'desktop.device_revoke',
    'desktop.pairing_open',
    'desktop.home_status',
    'desktop.home_register',
    'desktop.operation_preview',
    'desktop.operation_approve',
    'desktop.operation_cancel',
    'desktop.operation_reconcile',
    'desktop.operation_retry',
    'desktop.operation_check',
    'desktop.canvas_summon',
    'desktop.status_panel',
  ],
};
const EXPECTED_ROLE_NOTIFICATIONS: Readonly<Record<string, readonly string[]>> =
  {
    // キャンバスの記述（UI-03）はキャンバスの窓だけが受ける。
    // 作業領域の外の幅（UI-06）もキャンバスの窓だけ。
    canvas: [
      'desktop.state_changed',
      'desktop.canvas_changed',
      'desktop.canvas_work_area',
    ],
    input: ['desktop.state_changed'],
    status: [
      'desktop.state_changed',
      'desktop.power_event',
      'desktop.connection_changed',
    ],
  };

test('each window role reaches only its own channels from the preload', async () => {
  for (const role of ['canvas', 'status', 'input'] as const) {
    const expected = EXPECTED_ROLE_CHANNELS[role] ?? [];
    assert.deepEqual([...DESKTOP_ROLE_CHANNELS[role]], expected, role);
    const loaded = loadPreload([
      '/path/to/electron',
      `--buddy-window-role=${role}`,
    ]);
    const api = apiOf(loaded);
    assert.equal(api.windowRole, role);
    for (const channel of DESKTOP_IPC_CHANNELS) {
      const request = { channel, request_id: 'r', payload: null };
      if (expected.includes(channel))
        assert.deepEqual(await api.invoke(request), { ok: channel });
      else
        await assert.rejects(
          api.invoke(request),
          /desktop_unknown_channel/u,
          `${role} ${channel}`,
        );
    }
    assert.deepEqual(
      loaded.invoked.map(([channel]) => channel),
      expected,
    );
  }
});

test('each window role listens only to its own notifications', () => {
  for (const role of ['canvas', 'status', 'input'] as const) {
    const expected = EXPECTED_ROLE_NOTIFICATIONS[role] ?? [];
    assert.deepEqual([...DESKTOP_ROLE_NOTIFICATIONS[role]], expected, role);
    const loaded = loadPreload([`--buddy-window-role=${role}`]);
    const unsubscribe = apiOf(loaded).onNotification(() => undefined);
    assert.deepEqual(
      [...loaded.listeners.entries()]
        .filter(([, set]) => set.size > 0)
        .map(([channel]) => channel),
      expected,
    );
    unsubscribe();
  }
});

test('an unknown or repeated role argument opens no channel', async () => {
  for (const argv of [
    ['--buddy-window-role=admin'],
    ['--buddy-window-role='],
    ['--buddy-window-role=__proto__'],
    ['--buddy-window-role=canvas', '--buddy-window-role=status'],
  ]) {
    const loaded = loadPreload(argv);
    const api = apiOf(loaded);
    assert.equal(api.windowRole, null, argv.join(' '));
    await assert.rejects(
      api.invoke({ channel: 'desktop.get_state', request_id: 'r' }),
      /desktop_unknown_channel/u,
    );
    api.onNotification(() => undefined);
    assert.equal(loaded.listeners.size, 0);
    assert.equal(loaded.invoked.length, 0);
  }
});

test('the legacy role argument keeps every existing channel and notification', async () => {
  const loaded = loadPreload(['--buddy-window-role=legacy']);
  const api = apiOf(loaded);
  assert.equal(api.windowRole, 'legacy');
  for (const channel of DESKTOP_IPC_CHANNELS)
    if (
      channel === 'desktop.canvas_summon' ||
      channel === 'desktop.status_panel' ||
      channel === 'desktop.canvas_user_op' ||
      channel === 'desktop.canvas_content'
    )
      await assert.rejects(
        api.invoke({ channel, request_id: 'r', payload: null }),
        /desktop_unknown_channel/u,
      );
    else
      assert.deepEqual(
        await api.invoke({ channel, request_id: 'r', payload: null }),
        { ok: channel },
      );
  api.onNotification(() => undefined);
  // 従来の窓はキャンバスの記述（UI-03）と作業領域の外の幅（UI-06）を受けない。ほかの通知はすべて受ける。
  assert.deepEqual(
    [...loaded.listeners.keys()],
    DESKTOP_NOTIFICATION_CHANNELS.filter(
      (channel) =>
        channel !== 'desktop.canvas_changed' &&
        channel !== 'desktop.canvas_work_area',
    ),
  );
  assert(!loaded.listeners.has('desktop.canvas_changed'));
  assert(!loaded.listeners.has('desktop.canvas_work_area'));
});
