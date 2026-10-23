// 状態の層のパネル（UI-04、ADR 0032）と全体のショートカットの試験。窓の大きさと位置、出す・しまう（Esc・つまみ・
// 外へのクリック・隠す）、確認のダイアログを出している間の blur、確認の親、ショートカットの既定値を確かめる。
// 期待値は手で書き、実装から生成しない。Electron は起動しない（窓は模擬）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { CANVAS_SUMMON_ACCELERATOR } from './canvas-presence.js';
import {
  GLOBAL_SHORTCUTS,
  RESERVED_ACCELERATORS,
  STATUS_PANEL_ACCELERATOR,
  STOP_ACCELERATOR,
  normalizeAccelerator,
  registerGlobalShortcuts,
  shortcutsForMode,
  stopShortcutState,
  trayMenuEntries,
} from './global-shortcuts.js';
import {
  CONFIRM_NOT_SHOWN,
  STATUS_PANEL_WIDTH,
  StatusPanel,
  confirmDialogParent,
  runPanelConfirm,
  statusWindowBounds,
} from './status-panel.js';
import type { Rect } from './window-roles.js';

// 作業領域（メニューバーの下 33・幅 1512・高さ 875）。
const AREA: Rect = { x: 0, y: 33, width: 1512, height: 875 };

interface FakeStatusWindow {
  readonly calls: string[];
  visible: boolean;
}

function setup(options: { reducedMotion?: boolean; window?: boolean } = {}) {
  const window: FakeStatusWindow = { calls: [], visible: true };
  const logs: string[] = [];
  let closedConfirms = 0;
  const panel = new StatusPanel({
    window: () =>
      options.window === false
        ? null
        : {
            setBounds: (bounds, animate) =>
              window.calls.push(
                `bounds:${bounds.x},${bounds.y},${bounds.width},${bounds.height}:${animate ? 'animate' : 'instant'}`,
              ),
            isVisible: () => window.visible,
            show: () => {
              window.visible = true;
              window.calls.push('show');
            },
            focus: () => window.calls.push('focus'),
          },
    workArea: () => AREA,
    reducedMotion: () => options.reducedMotion ?? false,
    closeConfirm: () => {
      closedConfirms += 1;
    },
    log: (code) => logs.push(code),
  });
  return { panel, window, logs, closedConfirms: () => closedConfirms };
}

test('the status window is the tab at the middle of the right edge, or the full-height panel at the right edge', () => {
  assert.equal(STATUS_PANEL_WIDTH, 440);
  // つまみ（56 × 232）は右の端の中ほど。
  assert.deepEqual(statusWindowBounds(false, AREA), {
    x: 1512 - 56,
    y: 33 + Math.round((875 - 232) / 2),
    width: 56,
    height: 232,
  });
  // パネル（440 × 作業領域の高さ）は右の端の上から下まで。
  assert.deepEqual(statusWindowBounds(true, AREA), {
    x: 1512 - 440,
    y: 33,
    width: 440,
    height: 875,
  });
  // 作業領域がずれた画面（左にほかの画面がある）でも、作業領域の右の端に付く。
  assert.deepEqual(
    statusWindowBounds(true, { x: -1920, y: 0, width: 1920, height: 1040 }),
    { x: -440, y: 0, width: 440, height: 1040 },
  );
});

test('the tab opens the panel with a slide and focus; pressing it again or Esc puts it away', () => {
  const { panel, window, closedConfirms } = setup();
  assert.equal(panel.open, false);
  assert.equal(panel.request(true), 'expand');
  assert.equal(panel.open, true);
  assert.deepEqual(window.calls, ['bounds:1072,33,440,875:animate', 'focus']);
  // 二重に出しても大きさは変えない（フォーカスだけ戻す）。
  assert.equal(panel.request(true), 'none');
  assert.deepEqual(window.calls.slice(2), ['focus']);
  // つまみ・Esc（どちらも desktop.status_panel の open: false）でしまう。確認を閉じてから小さくする。
  assert.equal(panel.request(false), 'collapse');
  assert.equal(panel.open, false);
  assert.equal(closedConfirms(), 1);
  assert.deepEqual(window.calls.slice(3), ['bounds:1456,355,56,232:animate']);
  assert.equal(panel.request(false), 'none');
  assert.equal(closedConfirms(), 1);
});

test('the shortcut toggles the panel and brings back a hidden window', () => {
  const { panel, window } = setup();
  window.visible = false;
  assert.equal(panel.toggle(), 'expand');
  assert.deepEqual(window.calls, [
    'bounds:1072,33,440,875:animate',
    'show',
    'focus',
  ]);
  assert.equal(panel.toggle(), 'collapse');
  assert.equal(panel.open, false);
});

test('a click outside (blur) or hiding puts the panel away; hiding does not animate', () => {
  const { panel, window } = setup();
  panel.show('tab');
  assert.equal(panel.hide('blur'), 'collapse');
  panel.show('tab');
  window.calls.length = 0;
  assert.equal(panel.hide('hidden'), 'collapse');
  assert.deepEqual(window.calls, ['bounds:1456,355,56,232:instant']);
});

test('with reduced motion the panel opens and closes without animation', () => {
  const { panel, window } = setup({ reducedMotion: true });
  panel.show('tab');
  panel.hide('escape');
  assert.deepEqual(window.calls, [
    'bounds:1072,33,440,875:instant',
    'focus',
    'bounds:1456,355,56,232:instant',
  ]);
});

test('while the OS confirmation is attached to the panel, its blur does not put the panel away; Esc or the shortcut still close it and the confirmation', () => {
  const { panel, closedConfirms } = setup();
  // パネルが出ていなければ確認を出さない。
  assert.equal(panel.beginConfirm(), false);
  assert.equal(panel.confirming, false);
  panel.show('tab');
  assert.equal(panel.beginConfirm(), true);
  assert.equal(panel.confirming, true);
  // 確認（シート・モーダル）へフォーカスが移った blur ではしまわない。確認も閉じない。
  assert.equal(panel.hide('blur'), 'none');
  assert.equal(panel.open, true);
  assert.equal(closedConfirms(), 0);
  // ショートカット・窓を隠す操作ではしまい、確認も閉じる（パネルなしで確認を残さない）。
  assert.equal(panel.toggle(), 'collapse');
  assert.equal(closedConfirms(), 1);
  panel.endConfirm();
  assert.equal(panel.confirming, false);
  // 確認が終われば、blur でまたしまう。
  panel.show('tab');
  assert.equal(panel.hide('blur'), 'collapse');
});

test('without a status window nothing happens and the reason is logged', () => {
  const { panel, logs } = setup({ window: false });
  assert.equal(panel.show('tab'), 'none');
  assert.equal(panel.open, false);
  assert.deepEqual(logs, ['status_panel_unavailable']);
  panel.reset();
  assert.equal(panel.confirming, false);
});

test('the OS confirmation is parented to the legacy window, or to the open panel; with the panel put away it is not shown', () => {
  assert.equal(confirmDialogParent('legacy', false), 'legacy');
  assert.equal(confirmDialogParent('legacy', true), 'legacy');
  assert.equal(confirmDialogParent('canvas', true), 'status');
  assert.equal(confirmDialogParent('canvas', false), null);
});

test('the global shortcuts use three modifiers and a letter, are distinct, and avoid IME and OS combinations', () => {
  assert.equal(STOP_ACCELERATOR, 'CommandOrControl+Alt+Shift+X');
  assert.equal(STATUS_PANEL_ACCELERATOR, 'CommandOrControl+Alt+Shift+P');
  assert.deepEqual(
    GLOBAL_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.accelerator]),
    [
      ['stop', 'CommandOrControl+Alt+Shift+X'],
      ['status_panel', 'CommandOrControl+Alt+Shift+P'],
      ['canvas', CANVAS_SUMMON_ACCELERATOR],
    ],
  );
  for (const platform of ['darwin', 'win32'] as const) {
    const normalized = GLOBAL_SHORTCUTS.map((shortcut) =>
      normalizeAccelerator(shortcut.accelerator, platform),
    );
    assert.equal(new Set(normalized).size, normalized.length, platform);
    for (const value of normalized) {
      const parts = value.split('+');
      assert.equal(parts.length, 4, value);
      assert.match(parts.at(-1) ?? '', /^[A-Z]$/u, value);
      assert.equal(
        RESERVED_ACCELERATORS[platform].includes(value),
        false,
        `${platform} ${value}`,
      );
    }
  }
  // 比べる形の確かめ（手で書いた値）。
  assert.equal(
    normalizeAccelerator('CommandOrControl+Alt+Shift+X', 'darwin'),
    'Alt+Command+Shift+X',
  );
  assert.equal(
    normalizeAccelerator('CommandOrControl+Alt+Shift+X', 'win32'),
    'Alt+Control+Shift+X',
  );
  assert.equal(
    normalizeAccelerator('Option+Cmd+Esc', 'darwin'),
    'Alt+Command+Esc',
  );
  // 一覧にある組み合わせは見つかる（検査が働くこと）。
  assert(
    RESERVED_ACCELERATORS.darwin.includes(
      normalizeAccelerator('Command+Option+Shift+Q', 'darwin'),
    ),
  );
  assert(
    RESERVED_ACCELERATORS.win32.includes(
      normalizeAccelerator('Ctrl+Shift+Escape', 'win32'),
    ),
  );
});

// UI-04 のレビュー P2-1: パネルを親にした確認の手順（main はダイアログを渡すだけ）。
function confirmSetup(options: { focused?: boolean } = {}) {
  const base = setup();
  const deferred: (() => void)[] = [];
  let shown = 0;
  let answer: (response: number) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const ports = {
    showDialog: () => {
      shown += 1;
      return new Promise<{ response: number }>((resolve, reject) => {
        answer = (response) => resolve({ response });
        fail = reject;
      });
    },
    windowFocused: () => options.focused ?? true,
    defer: (task: () => void) => deferred.push(task),
  };
  return {
    ...base,
    ports,
    shown: () => shown,
    answer: (response: number) => answer(response),
    fail: (error: unknown) => fail(error),
    runDeferred: () => {
      for (const task of deferred.splice(0)) task();
    },
  };
}

test('the panel confirmation: shown once while the panel is open, true only for the approve button', async () => {
  const c = confirmSetup();
  c.panel.show('tab');
  const signal = new AbortController().signal;
  const pending = runPanelConfirm(c.panel, signal, c.ports);
  assert.equal(c.shown(), 1);
  assert.equal(c.panel.confirming, true);
  // 確認の間の blur ではしまわない。
  assert.equal(c.panel.hide('blur'), 'none');
  c.answer(1);
  assert.equal(await pending, true);
  assert.equal(c.panel.confirming, false);
  // 「やめる」（0）は false。
  const declined = runPanelConfirm(c.panel, signal, c.ports);
  c.answer(0);
  assert.equal(await declined, false);
  assert.equal(c.shown(), 2);
});

test('the panel confirmation is not shown while the panel is put away or the signal is already closed', async () => {
  const c = confirmSetup();
  assert.equal(
    await runPanelConfirm(c.panel, new AbortController().signal, c.ports),
    CONFIRM_NOT_SHOWN,
  );
  c.panel.show('tab');
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    await runPanelConfirm(c.panel, aborted.signal, c.ports),
    CONFIRM_NOT_SHOWN,
  );
  assert.equal(c.shown(), 0);
  assert.equal(c.panel.confirming, false);
});

test('putting the panel away or closing the signal during the confirmation makes it false', async () => {
  const hidden = confirmSetup();
  hidden.panel.show('tab');
  const pendingHidden = runPanelConfirm(
    hidden.panel,
    new AbortController().signal,
    hidden.ports,
  );
  // 確認の間に窓を隠す（パネルをしまう。確認も閉じる）→「承認する」が返っても false。
  assert.equal(hidden.panel.hide('hidden'), 'collapse');
  assert.equal(hidden.closedConfirms(), 1);
  hidden.answer(1);
  assert.equal(await pendingHidden, false);
  const aborted = confirmSetup();
  aborted.panel.show('tab');
  const controller = new AbortController();
  const pendingAborted = runPanelConfirm(
    aborted.panel,
    controller.signal,
    aborted.ports,
  );
  // ロック・停止で core-link が確認を閉じる（signal）→ false。
  controller.abort();
  aborted.answer(1);
  assert.equal(await pendingAborted, false);
  assert.equal(aborted.panel.confirming, false);
});

test('a dialog that throws still ends the confirmation, so a later blur puts the panel away', async () => {
  const c = confirmSetup();
  c.panel.show('tab');
  const pending = runPanelConfirm(
    c.panel,
    new AbortController().signal,
    c.ports,
  );
  c.fail(new Error('dialog failed'));
  await assert.rejects(pending, /dialog failed/u);
  assert.equal(c.panel.confirming, false);
  assert.equal(c.panel.hide('blur'), 'collapse');
});

test('if the user moved to another app during the confirmation, the panel is put away after it ends (not before the result)', async () => {
  const away = confirmSetup({ focused: false });
  away.panel.show('tab');
  const pending = runPanelConfirm(
    away.panel,
    new AbortController().signal,
    away.ports,
  );
  away.answer(1);
  // 結果は確定してから返す（フォーカスの移動の途中で取り消さない）。しまうのは後。
  assert.equal(await pending, true);
  assert.equal(away.panel.open, true);
  assert.equal(away.closedConfirms(), 0);
  away.runDeferred();
  assert.equal(away.panel.open, false);
  // 前面のままなら、しまわない。
  const front = confirmSetup({ focused: true });
  front.panel.show('tab');
  const kept = runPanelConfirm(
    front.panel,
    new AbortController().signal,
    front.ports,
  );
  front.answer(0);
  await kept;
  front.runDeferred();
  assert.equal(front.panel.open, true);
});

test('opening the panel with the shortcut brings Buddy to the front first; the tab does not', () => {
  const calls: string[] = [];
  const panel = new StatusPanel({
    window: () => ({
      setBounds: () => calls.push('bounds'),
      isVisible: () => true,
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
    }),
    workArea: () => AREA,
    reducedMotion: () => true,
    closeConfirm: () => undefined,
    activateApp: () => calls.push('activate'),
    log: () => undefined,
  });
  panel.toggle();
  assert.deepEqual(calls, ['bounds', 'activate', 'focus']);
  panel.hide('escape');
  calls.length = 0;
  panel.request(true);
  assert.deepEqual(calls, ['bounds', 'focus']);
});

// UI-04 のレビュー P2-1・P3-d: 全体のショートカットの登録（停止を先に。登録できなくても続ける）とトレイの印。
test('the stop shortcut is registered first and in every mode; failures are logged and the rest go on', () => {
  assert.deepEqual(
    shortcutsForMode('legacy').map((shortcut) => shortcut.id),
    ['stop'],
  );
  assert.deepEqual(
    shortcutsForMode('canvas').map((shortcut) => shortcut.id),
    ['stop', 'status_panel', 'canvas'],
  );
  const order: string[] = [];
  const logs: string[] = [];
  const run = {
    stop: () => undefined,
    status_panel: () => undefined,
    canvas: () => undefined,
  };
  const failed = registerGlobalShortcuts(
    shortcutsForMode('canvas'),
    (accelerator) => {
      order.push(accelerator);
      if (accelerator === STOP_ACCELERATOR) return false;
      if (accelerator === STATUS_PANEL_ACCELERATOR) throw new Error('taken');
      return true;
    },
    run,
    (code) => logs.push(code),
  );
  assert.deepEqual(order, [
    STOP_ACCELERATOR,
    STATUS_PANEL_ACCELERATOR,
    CANVAS_SUMMON_ACCELERATOR,
  ]);
  assert.deepEqual(failed, ['stop', 'status_panel']);
  assert.deepEqual(logs, [
    'stop_shortcut_unavailable',
    'status_panel_shortcut_unavailable',
  ]);
  assert.equal(stopShortcutState(failed), 'unavailable');
  assert.equal(stopShortcutState(['canvas']), 'registered');
  // 登録した操作は渡した関数そのもの（停止はトレイと同じ処理を main が渡す）。
  const callbacks: unknown[] = [];
  registerGlobalShortcuts(
    shortcutsForMode('legacy'),
    (_accelerator, callback) => {
      callbacks.push(callback);
      return true;
    },
    run,
    () => undefined,
  );
  assert.deepEqual(callbacks, [run.stop]);
});

test('the tray stop item shows the shortcut when registered and a warning mark when not', () => {
  const items = [
    { action: 'show_window', label: 'Buddy を表示' },
    { action: 'io_stop', label: 'この端末の入出力を停止' },
    { action: 'client_quit', label: 'Buddy を終了（中枢は止めません）' },
  ] as const;
  assert.deepEqual(
    trayMenuEntries(items, 'registered').map((item) => [
      item.label,
      item.accelerator,
    ]),
    [
      ['Buddy を表示', null],
      ['この端末の入出力を停止', 'CommandOrControl+Alt+Shift+X'],
      ['Buddy を終了（中枢は止めません）', null],
    ],
  );
  assert.deepEqual(
    trayMenuEntries(items, 'unavailable').map((item) => [
      item.label,
      item.accelerator,
    ]),
    [
      ['Buddy を表示', null],
      ['⚠ この端末の入出力を停止', null],
      ['Buddy を終了（中枢は止めません）', null],
    ],
  );
});
