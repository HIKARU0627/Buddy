// ビルド後の preload（dist/preload/preload.cjs）を、Electron の代わりの模擬の contextBridge・ipcRenderer で動かす。
// 公開する API・チャネルの一覧・通知で渡す値を確かめる。期待値は手で書く。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_NOTIFICATION_CHANNELS,
} from '@buddy/domain';

type Listener = (event: unknown, payload: unknown) => void;

function loadPreload() {
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
  });
  return { exposed, invoked, listeners, requested };
}

test('the preload requires only electron and exposes only invoke and onNotification', () => {
  const { exposed, requested } = loadPreload();
  assert.deepEqual(requested, ['electron']);
  assert.deepEqual([...exposed.keys()], ['buddyDesktop']);
  assert.deepEqual(Object.keys(exposed.get('buddyDesktop') ?? {}).sort(), [
    'invoke',
    'onNotification',
  ]);
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
  ];
  // preload の一覧は domain の一覧と同じ。
  assert.deepEqual([...DESKTOP_IPC_CHANNELS], channels);
  for (const channel of channels) {
    const request = { channel, request_id: 'r', payload: null };
    assert.deepEqual(await api.invoke(request), { ok: channel });
  }
  assert.deepEqual(
    invoked.map(([channel]) => channel),
    channels,
  );
  for (const bad of [
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
  assert.deepEqual([...listeners.keys()], [...DESKTOP_NOTIFICATION_CHANNELS]);
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
