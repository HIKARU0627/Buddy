// main の端末状態と限定 IPC の受付（ADR 0014・0015）。期待値は手で書き、実装から生成しない。
// Electron は起動しない。送信元の判定・ウィンドウの前面・OS のイベントは試験が直接渡す。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopIpcNotification } from '@buddy/contracts';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopDeviceController } from './device-controller.js';
import type { DeviceIoRecord } from './device-io-store.js';

const contract = createDesktopContract(loadContractSchema());
const ID = '5d0e3c1a-7b2f-4a6e-8c9d-0e1f2a3b4c5d';
const AT = '2026-10-20T00:00:00.000Z';
const TRUSTED_FOCUSED = { trustedSender: true, windowFocused: true };
const TRUSTED_BACKGROUND = { trustedSender: true, windowFocused: false };

function setup(
  initial: DeviceIoRecord = { io_epoch: '0', stop_scope: 'none' },
  options: { persistFails?: boolean; powerLogLimit?: number } = {},
) {
  const persisted: DeviceIoRecord[] = [];
  const notifications: DesktopIpcNotification[] = [];
  const persistErrors: unknown[] = [];
  const controller = new DesktopDeviceController({
    contract,
    initial,
    now: () => new Date(AT),
    persist: (record) => {
      if (options.persistFails) throw new Error('disk full');
      persisted.push(record);
    },
    onNotification: (notification) => notifications.push(notification),
    onPersistError: (error) => persistErrors.push(error),
    ...(options.powerLogLimit === undefined
      ? {}
      : { powerLogLimit: options.powerLogLimit }),
  });
  return { controller, persisted, notifications, persistErrors };
}

const req = (channel: string, payload: unknown = null) => ({
  channel,
  request_id: ID,
  payload,
});

const SHOWN_RUNNING = {
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '0',
  voice_state: null,
  hub_connection: 'not_connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
} as const;

const shownStopped = (epoch: string) => ({
  ...SHOWN_RUNNING,
  stop_scope: 'local',
  input_permitted: false,
  io_epoch: epoch,
});

test('right after start the lock state is unknown and input is not permitted', () => {
  const { controller, notifications, persisted } = setup();
  assert.deepEqual(controller.state, {
    lockState: 'unknown',
    stopScope: 'none',
    ioEpoch: '0',
  });
  assert.deepEqual(controller.statusBar, {
    visibility: 'hidden',
    lock_state: 'unknown',
  });
  // 状態欄の取得は受け付けるが、内容は隠したまま。
  assert.deepEqual(
    controller.handleIpc(
      'desktop.get_state',
      req('desktop.get_state'),
      TRUSTED_FOCUSED,
    ).response,
    {
      request_id: ID,
      channel: 'desktop.get_state',
      outcome: 'ok',
      status: { visibility: 'hidden', lock_state: 'unknown' },
    },
  );
  assert.deepEqual(notifications, []);
  assert.deepEqual(persisted, []);
});

test('the saved stop scope and io_epoch are restored on start', () => {
  const { controller } = setup({ io_epoch: '41', stop_scope: 'local' });
  assert.deepEqual(controller.state, {
    lockState: 'unknown',
    stopScope: 'local',
    ioEpoch: '41',
  });
  // 解除を確かめても、保存されていた停止は画面の再開まで続く。
  controller.applyLockQuery('unlock_screen');
  assert.deepEqual(controller.statusBar, shownStopped('41'));
});

test('an OS query that confirms unlock is recorded as os_query and then permits input', () => {
  const { controller, notifications } = setup();
  assert.equal(controller.applyLockQuery('unlock_screen'), true);
  assert.deepEqual(notifications, [
    {
      channel: 'desktop.power_event',
      event: 'unlock_screen',
      source: 'os_query',
      observed_at: AT,
    },
    { channel: 'desktop.state_changed', status: SHOWN_RUNNING },
  ]);
  assert.deepEqual(controller.powerLog, [notifications[0]]);
  // 同じ結果の問い合わせは記録しない。
  assert.equal(controller.applyLockQuery('unlock_screen'), false);
  assert.equal(notifications.length, 2);
});

test('an OS query that cannot tell keeps the lock state unknown', () => {
  const { controller, notifications } = setup();
  assert.equal(controller.applyLockQuery(null), false);
  assert.equal(controller.state.lockState, 'unknown');
  assert.deepEqual(notifications, []);
  assert.deepEqual(controller.powerLog, []);
  assert.deepEqual(
    controller.handleIpc(
      'desktop.io_resume',
      req('desktop.io_resume', { expected_io_epoch: '0' }),
      TRUSTED_FOCUSED,
    ).response,
    {
      request_id: ID,
      channel: 'desktop.io_resume',
      outcome: 'rejected',
      reason: 'device_locked',
    },
  );
});

test('an OS query that finds the screen locked stops this device', () => {
  const { controller, persisted, notifications } = setup();
  controller.applyLockQuery('lock_screen');
  assert.deepEqual(controller.state, {
    lockState: 'locked',
    stopScope: 'local',
    ioEpoch: '1',
  });
  assert.deepEqual(persisted, [{ io_epoch: '1', stop_scope: 'local' }]);
  assert.deepEqual(notifications, [
    {
      channel: 'desktop.power_event',
      event: 'lock_screen',
      source: 'os_query',
      observed_at: AT,
    },
    {
      channel: 'desktop.state_changed',
      status: { visibility: 'hidden', lock_state: 'locked' },
    },
  ]);
});

test('requests are checked by schema, then by the rule, then applied', () => {
  const { controller, persisted } = setup();
  controller.applyLockQuery('unlock_screen');
  // 形式の不正: 確かめられない request_id・channel は null。
  assert.deepEqual(
    controller.handleIpc('desktop.get_state', 'hello', TRUSTED_FOCUSED)
      .response,
    {
      request_id: null,
      channel: null,
      outcome: 'rejected',
      reason: 'invalid_request',
    },
  );
  // 形式の不正でも UUID v4 の request_id と一致するチャネルは返す。
  assert.deepEqual(
    controller.handleIpc(
      'desktop.io_stop',
      { ...req('desktop.io_stop'), device_id: 'pc-1' },
      TRUSTED_FOCUSED,
    ).response,
    {
      request_id: ID,
      channel: 'desktop.io_stop',
      outcome: 'rejected',
      reason: 'invalid_request',
    },
  );
  // Electron のチャネルと要求のチャネルが違う。
  assert.deepEqual(
    controller.handleIpc(
      'desktop.get_state',
      req('desktop.io_stop'),
      TRUSTED_FOCUSED,
    ).response,
    {
      request_id: ID,
      channel: null,
      outcome: 'rejected',
      reason: 'invalid_request',
    },
  );
  // 送信元が UI レンダラーの主フレームでなければ、停止も受け付けない。
  assert.deepEqual(
    controller.handleIpc('desktop.io_stop', req('desktop.io_stop'), {
      trustedSender: false,
      windowFocused: true,
    }).response,
    {
      request_id: ID,
      channel: 'desktop.io_stop',
      outcome: 'rejected',
      reason: 'untrusted_sender',
    },
  );
  assert.equal(controller.state.stopScope, 'none');
  assert.deepEqual(persisted, []);
});

test('stop advances io_epoch once; resume needs focus and the current epoch', () => {
  const { controller, persisted } = setup();
  controller.applyLockQuery('unlock_screen');
  // 停止はウィンドウが前面になくても受け付ける。
  const stop = controller.handleIpc(
    'desktop.io_stop',
    req('desktop.io_stop'),
    TRUSTED_BACKGROUND,
  );
  assert.deepEqual(stop, {
    response: {
      request_id: ID,
      channel: 'desktop.io_stop',
      outcome: 'ok',
      status: shownStopped('1'),
    },
    effect: 'none',
  });
  // 二度目の停止は世代を進めず、保存もしない。
  controller.handleIpc(
    'desktop.io_stop',
    req('desktop.io_stop'),
    TRUSTED_FOCUSED,
  );
  assert.equal(controller.state.ioEpoch, '1');
  assert.deepEqual(persisted, [{ io_epoch: '1', stop_scope: 'local' }]);

  const resume = (epoch: string, sender = TRUSTED_FOCUSED) =>
    controller.handleIpc(
      'desktop.io_resume',
      req('desktop.io_resume', { expected_io_epoch: epoch }),
      sender,
    ).response;
  assert.deepEqual(resume('1', TRUSTED_BACKGROUND), {
    request_id: ID,
    channel: 'desktop.io_resume',
    outcome: 'rejected',
    reason: 'screen_operation_required',
  });
  assert.deepEqual(resume('0'), {
    request_id: ID,
    channel: 'desktop.io_resume',
    outcome: 'rejected',
    reason: 'io_epoch_mismatch',
  });
  assert.deepEqual(resume('1'), {
    request_id: ID,
    channel: 'desktop.io_resume',
    outcome: 'ok',
    status: { ...SHOWN_RUNNING, io_epoch: '1' },
  });
  // 再開では世代を進めない。
  assert.deepEqual(persisted, [
    { io_epoch: '1', stop_scope: 'local' },
    { io_epoch: '1', stop_scope: 'none' },
  ]);
  assert.deepEqual(resume('1'), {
    request_id: ID,
    channel: 'desktop.io_resume',
    outcome: 'rejected',
    reason: 'not_stopped',
  });
});

test('lock, unlock, sleep and wake never resume automatically', () => {
  const { controller, persisted } = setup({
    io_epoch: '9',
    stop_scope: 'none',
  });
  controller.applyLockQuery('unlock_screen');
  controller.recordOsEvent('lock_screen');
  assert.deepEqual(controller.state, {
    lockState: 'locked',
    stopScope: 'local',
    ioEpoch: '10',
  });
  assert.deepEqual(controller.statusBar, {
    visibility: 'hidden',
    lock_state: 'locked',
  });
  controller.recordOsEvent('unlock_screen');
  assert.deepEqual(controller.statusBar, shownStopped('10'));

  // 画面で再開してから、スリープ → 復帰。
  controller.handleIpc(
    'desktop.io_resume',
    req('desktop.io_resume', { expected_io_epoch: '10' }),
    TRUSTED_FOCUSED,
  );
  controller.recordOsEvent('suspend');
  assert.deepEqual(controller.state, {
    lockState: 'unknown',
    stopScope: 'local',
    ioEpoch: '11',
  });
  controller.recordOsEvent('resume');
  assert.equal(controller.state.lockState, 'unknown');
  // 復帰後の問い合わせで解除を確かめても、停止のまま。
  controller.applyLockQuery('unlock_screen');
  assert.deepEqual(controller.statusBar, shownStopped('11'));
  assert.deepEqual(persisted, [
    { io_epoch: '10', stop_scope: 'local' },
    { io_epoch: '10', stop_scope: 'none' },
    { io_epoch: '11', stop_scope: 'local' },
  ]);
  assert.deepEqual(
    controller.powerLog.map((entry) => [entry.event, entry.source]),
    [
      ['unlock_screen', 'os_query'],
      ['lock_screen', 'os_event'],
      ['unlock_screen', 'os_event'],
      ['suspend', 'os_event'],
      ['resume', 'os_event'],
      ['unlock_screen', 'os_query'],
    ],
  );
});

test('shutdown stops this device and saves the stop', () => {
  const { controller, persisted } = setup({
    io_epoch: '2',
    stop_scope: 'none',
  });
  controller.applyLockQuery('unlock_screen');
  controller.recordOsEvent('shutdown');
  assert.deepEqual(persisted, [{ io_epoch: '3', stop_scope: 'local' }]);
});

test('closing the window and quitting the client do not change the IO state', () => {
  const { controller, persisted, notifications } = setup();
  controller.applyLockQuery('unlock_screen');
  const before = controller.state;
  const count = notifications.length;
  assert.deepEqual(
    controller.handleIpc(
      'desktop.window_hide',
      req('desktop.window_hide'),
      TRUSTED_BACKGROUND,
    ),
    {
      response: {
        request_id: ID,
        channel: 'desktop.window_hide',
        outcome: 'ok',
      },
      effect: 'hide_window',
    },
  );
  // ロック中でもクライアントの終了は受け付ける。
  controller.recordOsEvent('lock_screen');
  const locked = controller.state;
  assert.deepEqual(
    controller.handleIpc(
      'desktop.client_quit',
      req('desktop.client_quit'),
      TRUSTED_BACKGROUND,
    ),
    {
      response: {
        request_id: ID,
        channel: 'desktop.client_quit',
        outcome: 'ok',
      },
      effect: 'quit',
    },
  );
  assert.deepEqual(before, {
    lockState: 'unlocked',
    stopScope: 'none',
    ioEpoch: '0',
  });
  assert.deepEqual(controller.state, locked);
  // 停止の保存はロックによるもの 1 回だけ。
  assert.deepEqual(persisted, [{ io_epoch: '1', stop_scope: 'local' }]);
  assert.equal(notifications.length, count + 2);
});

test('the tray stop is applied in main without the renderer', () => {
  const { controller, persisted } = setup({
    io_epoch: '5',
    stop_scope: 'none',
  });
  controller.stopFromMain();
  assert.deepEqual(controller.state, {
    lockState: 'unknown',
    stopScope: 'local',
    ioEpoch: '6',
  });
  assert.deepEqual(persisted, [{ io_epoch: '6', stop_scope: 'local' }]);
});

test('a failed save is reported and the stop is kept', () => {
  const { controller, persistErrors } = setup(undefined, {
    persistFails: true,
  });
  controller.applyLockQuery('unlock_screen');
  controller.handleIpc(
    'desktop.io_stop',
    req('desktop.io_stop'),
    TRUSTED_FOCUSED,
  );
  assert.equal(persistErrors.length, 1);
  assert.deepEqual(controller.state, {
    lockState: 'unlocked',
    stopScope: 'local',
    ioEpoch: '1',
  });
});

test('the power event log keeps only the newest records', () => {
  const { controller } = setup(undefined, { powerLogLimit: 2 });
  controller.recordOsEvent('suspend');
  controller.recordOsEvent('resume');
  controller.recordOsEvent('shutdown');
  assert.deepEqual(
    controller.powerLog.map((entry) => entry.event),
    ['resume', 'shutdown'],
  );
});

test('the panel stop (desktop.io_stop) and the main stop (tray and the global stop shortcut) take the same transition and send the same status', () => {
  // UI-04: トレイ・全体の停止のショートカット（main の stopFromMain）と、状態の層のパネルの停止（desktop.io_stop）は
  // 同じ状態の遷移を通り、同じ状態欄を通知し、同じ値を保存する。
  const viaPanel = setup({ io_epoch: '5', stop_scope: 'none' });
  const viaMain = setup({ io_epoch: '5', stop_scope: 'none' });
  for (const { controller } of [viaPanel, viaMain])
    controller.applyLockQuery('unlock_screen');
  const response = viaPanel.controller.handleIpc(
    'desktop.io_stop',
    req('desktop.io_stop'),
    // パネルが前面でなくても止められる（停止は確認を挟まず、いつでも 1 回で効く）。
    TRUSTED_BACKGROUND,
  );
  assert.equal(response.response.outcome, 'ok');
  viaMain.controller.stopFromMain();
  const expected = { lockState: 'unlocked', stopScope: 'local', ioEpoch: '6' };
  assert.deepEqual(viaPanel.controller.state, expected);
  assert.deepEqual(viaMain.controller.state, expected);
  assert.deepEqual(viaPanel.persisted, [
    { io_epoch: '6', stop_scope: 'local' },
  ]);
  assert.deepEqual(viaMain.persisted, [{ io_epoch: '6', stop_scope: 'local' }]);
  assert.deepEqual(viaPanel.notifications.at(-1), {
    channel: 'desktop.state_changed',
    status: shownStopped('6'),
  });
  assert.deepEqual(viaMain.notifications.at(-1), viaPanel.notifications.at(-1));
  // 止まっている間にもう一度止めても、世代は進まない（どちらの経路でも）。
  viaMain.controller.stopFromMain();
  viaPanel.controller.handleIpc(
    'desktop.io_stop',
    req('desktop.io_stop'),
    TRUSTED_FOCUSED,
  );
  assert.deepEqual(viaPanel.controller.state, expected);
  assert.deepEqual(viaMain.controller.state, expected);
});

test('the status panel request turns into the open or close effect, even while the lock is unknown or IO is stopped', () => {
  const { controller, notifications, persisted } = setup({
    io_epoch: '3',
    stop_scope: 'local',
  });
  const before = notifications.length;
  // ロック状態が不明・停止中・前面でなくても受け付ける（停止へいつでも届く。中身は画面と main が隠す）。
  assert.deepEqual(
    controller.handleIpc(
      'desktop.status_panel',
      req('desktop.status_panel', { open: true }),
      TRUSTED_BACKGROUND,
    ),
    {
      response: {
        request_id: ID,
        channel: 'desktop.status_panel',
        outcome: 'ok',
      },
      effect: 'status_panel_open',
    },
  );
  assert.equal(
    controller.handleIpc(
      'desktop.status_panel',
      req('desktop.status_panel', { open: false }),
      TRUSTED_FOCUSED,
    ).effect,
    'status_panel_close',
  );
  // 入出力の状態は変えない（保存も通知もしない）。
  assert.equal(notifications.length, before);
  assert.deepEqual(persisted, []);
  // 形の違う要求・信頼しない送信元は拒否し、効果はない。
  for (const payload of [null, {}, { open: 'yes' }, { open: true, x: 1 }]) {
    const outcome = controller.handleIpc(
      'desktop.status_panel',
      req('desktop.status_panel', payload),
      TRUSTED_FOCUSED,
    );
    assert.equal(outcome.effect, 'none', JSON.stringify(payload));
    assert.equal(
      (outcome.response as { reason?: string }).reason,
      'invalid_request',
    );
  }
  const untrusted = controller.handleIpc(
    'desktop.status_panel',
    req('desktop.status_panel', { open: true }),
    { trustedSender: false, windowFocused: true },
  );
  assert.equal(untrusted.effect, 'none');
  assert.equal(
    (untrusted.response as { reason?: string }).reason,
    'untrusted_sender',
  );
});
