// 窓の役割の基盤（UI-02、ADR 0032）。送信元の窓の役割で受付を絞ること・通知の宛先・従来の窓が変わらないこと・
// 役割ごとの窓の作り方。期待値は手で書き、実装から生成しない。Electron は起動しない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC_CHANNELS, admitDesktopRequest } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopDeviceController } from './device-controller.js';
import { isTrustedSender, type SenderFacts } from './window-policy.js';
import {
  UiWindowRegistry,
  channelAllowedForWindow,
  notificationAllowedForWindow,
  rolesForMode,
  uiWindowMode,
  uiWindowSpec,
  windowSender,
  type UiWindowRole,
} from './window-roles.js';

// 今の 24 チャネル（B01〜B04-05）。従来の窓はこれをすべて使う。
const ALL_CHANNELS = [
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
  'desktop.turn_submit',
  'desktop.operation_preview',
  'desktop.operation_approve',
  'desktop.operation_cancel',
  'desktop.operation_reconcile',
  'desktop.operation_retry',
  'desktop.operation_check',
];

const UNLOCKED = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
} as const;

// 窓の主フレームから送った要求の事実（その窓の webContents の ID を uiWebContentsId に入れる）。
const factsFrom = (id: number, registered: boolean): SenderFacts => ({
  senderWebContentsId: id,
  uiWebContentsId: registered ? id : null,
  senderIsMainFrame: registered,
  senderFrameUrl: 'buddy://app/index.html',
});

interface FakeWindow {
  readonly name: string;
}

// main の受付と同じ組み立て: 対応表で送信元の窓を引き、送信元の事実と役割から送信元を作る。
function senderFor(
  registry: UiWindowRegistry<FakeWindow>,
  webContentsId: number,
  channel: string,
  focused = true,
) {
  const entry = registry.lookup(webContentsId);
  return windowSender({
    channel,
    role: entry?.role ?? null,
    facts: factsFrom(webContentsId, entry !== null),
    focused,
  });
}

function threeWindows() {
  const registry = new UiWindowRegistry<FakeWindow>();
  registry.register(11, 'canvas', { name: 'canvas' });
  registry.register(12, 'status', { name: 'status' });
  registry.register(13, 'input', { name: 'input' });
  return registry;
}

test('the default stays the single legacy window; the flag or env opens the three windows', () => {
  assert.equal(uiWindowMode([], {}), 'legacy');
  assert.equal(uiWindowMode(['electron', '.'], {}), 'legacy');
  assert.equal(
    uiWindowMode(['electron', '.', '--buddy-ui=canvas'], {}),
    'canvas',
  );
  assert.equal(uiWindowMode([], { BUDDY_DESKTOP_UI: 'canvas' }), 'canvas');
  // フラグが環境変数より優先。最後のフラグを使う。
  assert.equal(
    uiWindowMode(['--buddy-ui=legacy'], { BUDDY_DESKTOP_UI: 'canvas' }),
    'legacy',
  );
  assert.equal(
    uiWindowMode(['--buddy-ui=canvas', '--buddy-ui=legacy'], {}),
    'legacy',
  );
  // 知らない値は既定のまま。
  assert.equal(uiWindowMode(['--buddy-ui=CANVAS'], {}), 'legacy');
  assert.equal(uiWindowMode(['--buddy-ui='], {}), 'legacy');
  assert.equal(uiWindowMode([], { BUDDY_DESKTOP_UI: 'status' }), 'legacy');
  assert.deepEqual(rolesForMode('legacy'), ['legacy']);
  // キャンバスを先に作り、状態の層・入力バーを前に重ねる。
  assert.deepEqual(rolesForMode('canvas'), ['canvas', 'status', 'input']);
});

test('the legacy window keeps every channel and the same sender decision as before', () => {
  assert.deepEqual([...DESKTOP_IPC_CHANNELS], ALL_CHANNELS);
  const registry = new UiWindowRegistry<FakeWindow>();
  registry.register(7, 'legacy', { name: 'legacy' });
  for (const channel of ALL_CHANNELS) {
    assert.equal(channelAllowedForWindow('legacy', channel), true, channel);
    // 受付に渡す送信元は、今の送信元の検査（isTrustedSender）と同じ。
    for (const facts of [
      factsFrom(7, true),
      { ...factsFrom(7, true), senderIsMainFrame: false },
      { ...factsFrom(7, true), senderFrameUrl: 'https://example.com/' },
      { ...factsFrom(7, true), senderWebContentsId: 8 },
      factsFrom(7, false),
    ])
      for (const focused of [true, false])
        assert.deepEqual(
          windowSender({ channel, role: 'legacy', facts, focused }),
          { trustedSender: isTrustedSender(facts), windowFocused: focused },
          channel,
        );
    assert.deepEqual(senderFor(registry, 7, channel), {
      trustedSender: true,
      windowFocused: true,
    });
  }
  assert.equal(channelAllowedForWindow('legacy', 'desktop.hub_stop'), false);
  for (const channel of [
    'desktop.state_changed',
    'desktop.power_event',
    'desktop.connection_changed',
  ])
    assert.equal(notificationAllowedForWindow('legacy', channel), true);
});

test('each role admits only its own channels; the rest are untrusted senders', () => {
  const registry = threeWindows();
  const allowed: Record<Exclude<UiWindowRole, 'legacy'>, readonly string[]> = {
    canvas: ['desktop.get_state'],
    input: ['desktop.get_state', 'desktop.turn_submit'],
    status: ALL_CHANNELS.filter((channel) => channel !== 'desktop.turn_submit'),
  };
  const ids = { canvas: 11, status: 12, input: 13 } as const;
  for (const role of ['canvas', 'status', 'input'] as const)
    for (const channel of ALL_CHANNELS) {
      const expected = allowed[role].includes(channel);
      assert.equal(
        channelAllowedForWindow(role, channel),
        expected,
        `${role} ${channel}`,
      );
      const admission = admitDesktopRequest(
        channel,
        null,
        UNLOCKED,
        senderFor(registry, ids[role], channel),
      );
      if (!expected)
        assert.deepEqual(
          admission,
          { ok: false, reason: 'untrusted_sender' },
          `${role} ${channel}`,
        );
      else if (admission.ok === false)
        // 役割に合うチャネルは、役割の検査では拒否しない（ほかの規則の拒否だけ）。
        assert.notEqual(
          admission.reason,
          'untrusted_sender',
          `${role} ${channel}`,
        );
    }
  // 手で選んだ代表: キャンバスは承認・停止・再開・終了・接続の表示を使えない。
  for (const channel of [
    'desktop.operation_approve',
    'desktop.operation_cancel',
    'desktop.io_stop',
    'desktop.io_resume',
    'desktop.client_quit',
    'desktop.get_connection',
    'desktop.turn_submit',
  ])
    assert.equal(
      senderFor(registry, 11, channel).trustedSender,
      false,
      channel,
    );
  // 入力バーは発言だけ。状態の層は発言を使えない。
  assert.equal(
    senderFor(registry, 13, 'desktop.turn_submit').trustedSender,
    true,
  );
  assert.equal(
    senderFor(registry, 13, 'desktop.operation_approve').trustedSender,
    false,
  );
  assert.equal(
    senderFor(registry, 12, 'desktop.turn_submit').trustedSender,
    false,
  );
  assert.equal(
    senderFor(registry, 12, 'desktop.operation_approve').trustedSender,
    true,
  );
});

test('a request from an unknown window or a closed window is rejected', () => {
  const registry = threeWindows();
  // 対応表にない webContents（main の作っていない窓）。
  assert.equal(registry.lookup(99), null);
  assert.equal(channelAllowedForWindow(null, 'desktop.get_state'), false);
  for (const channel of ALL_CHANNELS)
    assert.deepEqual(
      admitDesktopRequest(
        channel,
        null,
        UNLOCKED,
        senderFor(registry, 99, channel),
      ),
      { ok: false, reason: 'untrusted_sender' },
    );
  // 対応表にあっても、送信元の事実が別の窓（ID の食い違い）なら拒否。
  assert.equal(
    windowSender({
      channel: 'desktop.get_state',
      role: 'status',
      facts: { ...factsFrom(12, true), uiWebContentsId: 11 },
      focused: true,
    }).trustedSender,
    false,
  );
  // 閉じた窓は対応表から外れ、その ID からの要求は拒否する。
  assert.equal(senderFor(registry, 12, 'desktop.io_stop').trustedSender, true);
  registry.unregister(12);
  assert.equal(registry.lookup(12), null);
  assert.deepEqual(
    admitDesktopRequest(
      'desktop.io_stop',
      null,
      UNLOCKED,
      senderFor(registry, 12, 'desktop.io_stop'),
    ),
    { ok: false, reason: 'untrusted_sender' },
  );
  // ほかの窓はそのまま。
  assert.equal(
    senderFor(registry, 11, 'desktop.get_state').trustedSender,
    true,
  );
  // 同じ役割を作り直せば、新しい窓の ID だけを受け付ける（古い ID は拒否のまま）。
  registry.register(21, 'status', { name: 'status again' });
  assert.equal(senderFor(registry, 21, 'desktop.io_stop').trustedSender, true);
  assert.equal(senderFor(registry, 12, 'desktop.io_stop').trustedSender, false);
});

test('the controller rejects a stop from the canvas and keeps the state', () => {
  const registry = threeWindows();
  const controller = new DesktopDeviceController({
    contract: createDesktopContract(loadContractSchema()),
    initial: { io_epoch: '0', stop_scope: 'none' },
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    persist: () => undefined,
    onNotification: () => undefined,
    onPersistError: () => undefined,
  });
  controller.applyLockQuery('unlock_screen');
  const request = {
    channel: 'desktop.io_stop',
    request_id: '5d0e3c1a-7b2f-4a6e-8c9d-0e1f2a3b4c5d',
    payload: null,
  };
  const fromCanvas = controller.handleIpc(
    'desktop.io_stop',
    request,
    senderFor(registry, 11, 'desktop.io_stop'),
  );
  assert.deepEqual(fromCanvas.response, {
    request_id: request.request_id,
    channel: 'desktop.io_stop',
    outcome: 'rejected',
    reason: 'untrusted_sender',
  });
  assert.equal(controller.state.stopScope, 'none');
  const fromStatus = controller.handleIpc(
    'desktop.io_stop',
    request,
    senderFor(registry, 12, 'desktop.io_stop'),
  );
  assert.equal(fromStatus.response.outcome, 'ok');
  assert.equal(controller.state.stopScope, 'local');
});

test('notifications go only to loaded windows whose role takes them', () => {
  const registry = threeWindows();
  const names = (channel: string) =>
    registry.notificationTargets(channel).map((entry) => entry.window.name);
  // 読み込みが終わるまでは送らない。
  assert.deepEqual(names('desktop.state_changed'), []);
  registry.setReady(11, true);
  registry.setReady(12, true);
  registry.setReady(13, true);
  assert.deepEqual(names('desktop.state_changed'), [
    'canvas',
    'status',
    'input',
  ]);
  assert.deepEqual(names('desktop.power_event'), ['status']);
  assert.deepEqual(names('desktop.connection_changed'), ['status']);
  assert.deepEqual(names('desktop.unknown'), []);
  registry.setReady(12, false);
  assert.deepEqual(names('desktop.connection_changed'), []);
  registry.unregister(13);
  assert.deepEqual(names('desktop.state_changed'), ['canvas']);
  // 従来の窓は 3 種とも受ける。
  const legacy = new UiWindowRegistry<FakeWindow>();
  legacy.register(1, 'legacy', { name: 'legacy' });
  legacy.setReady(1, true);
  for (const channel of [
    'desktop.state_changed',
    'desktop.power_event',
    'desktop.connection_changed',
  ])
    assert.deepEqual(
      legacy.notificationTargets(channel).map((entry) => entry.window.name),
      ['legacy'],
    );
});

test('a webContents or a role is registered only once', () => {
  const registry = threeWindows();
  assert.throws(
    () => registry.register(11, 'legacy', { name: 'x' }),
    /window_already_registered/u,
  );
  assert.throws(
    () => registry.register(30, 'canvas', { name: 'x' }),
    /window_role_taken/u,
  );
  assert.equal(registry.byRole('canvas')?.webContentsId, 11);
  assert.equal(registry.byRole('legacy'), null);
});

const DISPLAY = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 33, width: 1512, height: 875 },
};
const PRELOAD = '/app/dist/preload/preload.cjs';

const SHARED_PREFS = {
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: false,
};

test('the legacy window is created with the same options as before', () => {
  for (const platform of ['darwin', 'win32'])
    assert.deepEqual(uiWindowSpec('legacy', platform, DISPLAY, PRELOAD), {
      role: 'legacy',
      options: {
        width: 960,
        height: 680,
        minWidth: 480,
        minHeight: 360,
        show: false,
        title: 'Buddy',
        autoHideMenuBar: true,
        webPreferences: {
          ...SHARED_PREFS,
          additionalArguments: ['--buddy-window-role=legacy'],
        },
      },
      contentProtection: false,
      allWorkspaces: null,
      alwaysOnTopLevel: null,
      maximize: false,
      focusOnShow: true,
    });
});

test('all windows share sandbox, isolation and the preload; only the role argument differs', () => {
  for (const platform of ['darwin', 'win32'])
    for (const role of ['legacy', 'canvas', 'status', 'input'] as const)
      assert.deepEqual(
        uiWindowSpec(role, platform, DISPLAY, PRELOAD).options.webPreferences,
        {
          ...SHARED_PREFS,
          additionalArguments: [`--buddy-window-role=${role}`],
        },
        `${platform} ${role}`,
      );
});

test('the macOS canvas sits on the desktop layer over the whole screen, on every space', () => {
  const spec = uiWindowSpec('canvas', 'darwin', DISPLAY, PRELOAD);
  assert.equal(spec.options.type, 'desktop');
  assert.equal(spec.options.frame, false);
  assert.deepEqual(
    [spec.options.x, spec.options.y, spec.options.width, spec.options.height],
    [0, 0, 1512, 982],
  );
  assert.equal(spec.contentProtection, true);
  assert.deepEqual(spec.allWorkspaces, { visibleOnFullScreen: false });
  assert.equal(spec.alwaysOnTopLevel, null);
  assert.equal(spec.maximize, false);
  // 前面を奪わない（ほかのアプリの後ろ）。
  assert.equal(spec.focusOnShow, false);
});

test('the Windows canvas is a frameless maximized window kept off the taskbar', () => {
  const spec = uiWindowSpec('canvas', 'win32', DISPLAY, PRELOAD);
  assert.equal(spec.options.type, undefined);
  assert.equal(spec.options.frame, false);
  assert.equal(spec.options.skipTaskbar, true);
  assert.equal(spec.options.thickFrame, false);
  assert.deepEqual(
    [spec.options.x, spec.options.y, spec.options.width, spec.options.height],
    [0, 33, 1512, 875],
  );
  assert.equal(spec.maximize, true);
  assert.equal(spec.contentProtection, true);
  assert.equal(spec.allWorkspaces, null);
  assert.equal(spec.focusOnShow, false);
});

test('the status tab and the input bar are small, frameless, always-on-top windows', () => {
  for (const platform of ['darwin', 'win32']) {
    const status = uiWindowSpec('status', platform, DISPLAY, PRELOAD);
    const input = uiWindowSpec('input', platform, DISPLAY, PRELOAD);
    for (const spec of [status, input]) {
      assert.equal(
        spec.options.type,
        platform === 'darwin' ? 'panel' : undefined,
      );
      assert.equal(spec.options.frame, false);
      assert.equal(spec.options.resizable, false);
      assert.equal(spec.options.movable, false);
      assert.equal(spec.options.skipTaskbar, true);
      assert.equal(spec.options.alwaysOnTop, true);
      assert.equal(spec.alwaysOnTopLevel, 'floating');
      assert.deepEqual(spec.allWorkspaces, { visibleOnFullScreen: true });
    }
    // 右の端の中ほどのつまみ（56 × 128）。
    assert.deepEqual(
      [
        status.options.x,
        status.options.y,
        status.options.width,
        status.options.height,
      ],
      [1512 - 56, 33 + Math.round((875 - 128) / 2), 56, 128],
    );
    // 下の中ほどの帯（560 × 56、下端から 16）。
    assert.deepEqual(
      [
        input.options.x,
        input.options.y,
        input.options.width,
        input.options.height,
      ],
      [Math.round((1512 - 560) / 2), 33 + 875 - 56 - 16, 560, 56],
    );
    // 画面共有から守るのはキャンバスと状態の層。入力バーはキー入力のために前面に出す。
    assert.equal(status.contentProtection, true);
    assert.equal(input.contentProtection, false);
    assert.equal(status.focusOnShow, false);
    assert.equal(input.focusOnShow, true);
  }
});
