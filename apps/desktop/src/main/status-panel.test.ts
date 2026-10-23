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
} from './global-shortcuts.js';
import {
  STATUS_PANEL_WIDTH,
  StatusPanel,
  confirmDialogParent,
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
  panel.show();
  assert.equal(panel.hide('blur'), 'collapse');
  panel.show();
  window.calls.length = 0;
  assert.equal(panel.hide('hidden'), 'collapse');
  assert.deepEqual(window.calls, ['bounds:1456,355,56,232:instant']);
});

test('with reduced motion the panel opens and closes without animation', () => {
  const { panel, window } = setup({ reducedMotion: true });
  panel.show();
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
  panel.show();
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
  panel.show();
  assert.equal(panel.hide('blur'), 'collapse');
});

test('without a status window nothing happens and the reason is logged', () => {
  const { panel, logs } = setup({ window: false });
  assert.equal(panel.show(), 'none');
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
