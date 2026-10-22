// 中枢との接続の状態を状態欄と画面へ送る手順の試験（ADR 0025、レビューの指摘 L8）。
// electron/main.ts と同じつなぎ方（状態欄の通知の処理から、もう一度送る処理を呼ぶ）を、本物の
// DesktopDeviceController で再現する。期待値（送った回数・内容）は手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopIpcNotification } from '@buddy/contracts';
import { ConnectionPublisher } from './connection-publisher.js';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopDeviceController } from './device-controller.js';
import type { StatusBarHub } from './status-bar.js';

const contract = createDesktopContract(loadContractSchema());

type Sent = { readonly channel: string; readonly connection: unknown };

function wiring() {
  let hub: StatusBarHub = {
    connection: 'not_connected',
    lastConfirmedAt: null,
  };
  let link: 'not_connected' | 'connected' = 'not_connected';
  const sent: Sent[] = [];
  const stateChanged: DesktopIpcNotification[] = [];
  let publisher: ConnectionPublisher<Sent> | null = null;
  const controller = new DesktopDeviceController({
    contract,
    initial: { io_epoch: '0', stop_scope: 'none' },
    now: () => new Date('2030-10-01T00:00:00.000Z'),
    persist: () => undefined,
    // main.ts と同じく、状態欄の通知のたびに接続の状態も送り直す。
    onNotification: (notification) => {
      if (notification.channel !== 'desktop.state_changed') return;
      stateChanged.push(notification);
      publisher?.publish();
    },
  });
  publisher = new ConnectionPublisher<Sent>({
    refreshHub: () => controller.setHub(hub),
    build: () => ({
      channel: 'desktop.connection_changed',
      connection: { link },
    }),
    send: (notification) => sent.push(notification),
  });
  controller.recordOsEvent('unlock_screen');
  return {
    controller,
    publisher,
    sent,
    stateChanged,
    set(next: StatusBarHub, nextLink: typeof link) {
      hub = next;
      link = nextLink;
    },
  };
}

test('a re-entrant publish from the status bar notification sends the connection only once', () => {
  const { publisher, sent, stateChanged, set } = wiring();
  publisher.publish();
  assert.equal(sent.length, 1);
  const before = stateChanged.length;
  // 中枢の欄が変わる → setHub が状態欄の通知を出す → 通知の処理がもう一度 publish を呼ぶ（再入）。
  set(
    { connection: 'connected', lastConfirmedAt: '2030-10-01T00:00:00.000Z' },
    'connected',
  );
  publisher.publish();
  assert.equal(stateChanged.length, before + 1);
  assert.deepEqual(sent.slice(1), [
    {
      channel: 'desktop.connection_changed',
      connection: { link: 'connected' },
    },
  ]);
});

test('the same notification is not sent twice until the screen is reloaded', () => {
  const { publisher, sent, set } = wiring();
  publisher.publish();
  publisher.publish();
  assert.equal(sent.length, 1);
  set({ connection: 'unreachable', lastConfirmedAt: null }, 'not_connected');
  publisher.publish();
  // 接続の通知の中身（link）は同じなので送らない（状態欄は状態欄の通知で届く）。
  assert.equal(sent.length, 1);
  set(
    { connection: 'connected', lastConfirmedAt: '2030-10-01T00:00:01.000Z' },
    'connected',
  );
  publisher.publish();
  assert.equal(sent.length, 2);
  // 画面を読み込み直したら、同じ内容でも送る。
  publisher.reset();
  publisher.publish();
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2], sent[1]);
});

test('a build that returns null sends nothing', () => {
  const sent: unknown[] = [];
  const publisher = new ConnectionPublisher<unknown>({
    refreshHub: () => undefined,
    build: () => null,
    send: (notification) => sent.push(notification),
  });
  publisher.publish();
  assert.deepEqual(sent, []);
});
