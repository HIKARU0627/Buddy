// キャンバスを置く画面の設定（複数のモニターの設定。UI-06、ADR 0032）の試験。既定は主の画面、選んだ画面がなければ主の画面、
// 保存は設定の項目だけで本文を持たないこと、入力バー・状態の層の窓が配置のエンジンの空けた場所に入ることを、どの画面でも
// 確かめる。期待値は手で書いた。Electron は起動しない（画面の一覧は合成）。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CANVAS_LAYOUT, layoutCanvas } from '@buddy/domain';
import {
  CANVAS_DISPLAY_FILE,
  DEFAULT_CANVAS_DISPLAY_SETTINGS,
  canvasInsetsOf,
  loadCanvasDisplaySettings,
  resolveCanvasDisplay,
  saveCanvasDisplaySettings,
} from './canvas-display.js';
import type { DisplayLike } from './canvas-display.js';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { tempDir } from './hub-test-support.js';
import {
  INPUT_BAR_MARGIN,
  INPUT_BAR_SIZE,
  STATUS_TAB_SIZE,
  uiWindowSpec,
} from './window-roles.js';
import type { Rect } from './window-roles.js';

const contract = createDesktopContract(loadContractSchema());
const valid = (value: unknown) =>
  contract.valid('DesktopCanvasDisplaySettings', value);

// 合成の画面: 主（id 7。メニューバー 25・Dock 75）、右の 1280 × 800（id 3。メニューバーだけ）、左の縦置き（id 11）。
const PRIMARY: DisplayLike = {
  id: 7,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 25, width: 1920, height: 980 },
};
const RIGHT: DisplayLike = {
  id: 3,
  bounds: { x: 1920, y: 0, width: 1280, height: 800 },
  workArea: { x: 1920, y: 25, width: 1280, height: 775 },
};
const PORTRAIT: DisplayLike = {
  id: 11,
  bounds: { x: -1080, y: -400, width: 1080, height: 1920 },
  workArea: { x: -1080, y: -375, width: 1080, height: 1895 },
};

test('the default is the primary display; a chosen display is used when present, otherwise the primary (the setting is kept)', () => {
  assert.deepEqual(DEFAULT_CANVAS_DISPLAY_SETTINGS, {
    schema_version: 1,
    target: 'primary',
  });
  // 主の画面が一覧の最初でなくても、主の画面の ID で選ぶ。
  const displays = [RIGHT, PORTRAIT, PRIMARY];
  assert.deepEqual(
    resolveCanvasDisplay(DEFAULT_CANVAS_DISPLAY_SETTINGS, displays, 7),
    {
      id: 7,
      geometry: { bounds: PRIMARY.bounds, workArea: PRIMARY.workArea },
      fallback: false,
    },
  );
  assert.deepEqual(
    resolveCanvasDisplay(
      { schema_version: 1, target: 'display', display_id: 3 },
      displays,
      7,
    ),
    {
      id: 3,
      geometry: { bounds: RIGHT.bounds, workArea: RIGHT.workArea },
      fallback: false,
    },
  );
  // 選んだ画面を外した: 主の画面にする（fallback）。
  assert.deepEqual(
    resolveCanvasDisplay(
      { schema_version: 1, target: 'display', display_id: 3 },
      [PRIMARY, PORTRAIT],
      7,
    ),
    {
      id: 7,
      geometry: { bounds: PRIMARY.bounds, workArea: PRIMARY.workArea },
      fallback: true,
    },
  );
  // 画面が 1 つだけ（既定）。主の画面の ID が一覧にない（起こらないはず）なら最初の画面。画面がなければ null。
  assert.equal(
    resolveCanvasDisplay(DEFAULT_CANVAS_DISPLAY_SETTINGS, [RIGHT], 7)?.id,
    3,
  );
  assert.equal(
    resolveCanvasDisplay(DEFAULT_CANVAS_DISPLAY_SETTINGS, [], 7),
    null,
  );
});

test('the stored setting is only the display choice; a file with content or a broken file falls back to the default', async (t) => {
  const dir = await tempDir(t, 'bcd-');
  const path = join(dir, CANVAS_DISPLAY_FILE);
  assert.deepEqual(loadCanvasDisplaySettings(path, valid), {
    kind: 'missing',
    settings: DEFAULT_CANVAS_DISPLAY_SETTINGS,
  });
  assert.equal(
    saveCanvasDisplaySettings(
      path,
      { schema_version: 1, target: 'display', display_id: 3 },
      valid,
    ),
    true,
  );
  assert.equal(
    readFileSync(path, 'utf8'),
    '{"schema_version":1,"target":"display","display_id":3}\n',
  );
  assert.deepEqual(loadCanvasDisplaySettings(path, valid), {
    kind: 'loaded',
    settings: { schema_version: 1, target: 'display', display_id: 3 },
  });
  // 本文・見出し・置き場所を含む値は保存しない（前の設定のまま）。
  for (const carrying of [
    { schema_version: 1, target: 'primary', heading: '今日の用事' },
    {
      schema_version: 1,
      target: 'primary',
      user_pins: [
        { item_id: 'errands', cell: { column: 1, row: 1, span: 4, rows: 2 } },
      ],
    },
    { schema_version: 1, target: 'all' },
  ])
    assert.equal(
      saveCanvasDisplaySettings(path, carrying as never, valid),
      false,
    );
  assert.equal(
    readFileSync(path, 'utf8'),
    '{"schema_version":1,"target":"display","display_id":3}\n',
  );
  // 手で書き換えた・壊れたファイルは既定にする（中身は使わない）。
  for (const text of [
    '{"schema_version":1,"target":"primary","heading":"今日の用事"}',
    '{"schema_version":2,"target":"primary"}',
    'not json',
    `{"schema_version":1,"target":"primary","pad":"${'x'.repeat(2000)}"}`,
  ]) {
    writeFileSync(path, text);
    assert.deepEqual(loadCanvasDisplaySettings(path, valid), {
      kind: 'invalid',
      settings: DEFAULT_CANVAS_DISPLAY_SETTINGS,
    });
  }
  // 保存しない値で、ファイルを新しく作らない。
  const other = join(dir, 'never.json');
  assert.equal(
    saveCanvasDisplaySettings(other, { schema_version: 1 } as never, valid),
    false,
  );
  assert.equal(existsSync(other), false);
});

const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

test('on every display (macOS and Windows), the input bar and status tab windows fall inside the places the layout engine keeps free', () => {
  // main の窓の大きさは、エンジンの空ける大きさに入る（手で書いた関係: 560 + 16 × 2 = 592、56 + 16 + 16 = 88、56 ≤ 72）。
  assert(
    INPUT_BAR_SIZE.width + INPUT_BAR_MARGIN * 2 <=
      CANVAS_LAYOUT.inputBarReserve.width,
  );
  assert(
    INPUT_BAR_SIZE.height + INPUT_BAR_MARGIN + CANVAS_LAYOUT.gap <=
      CANVAS_LAYOUT.inputBarReserve.height,
  );
  assert(STATUS_TAB_SIZE.width <= CANVAS_LAYOUT.statusReserveWidth);
  for (const platform of ['darwin', 'win32'])
    for (const display of [PRIMARY, RIGHT, PORTRAIT]) {
      const geometry = { bounds: display.bounds, workArea: display.workArea };
      const canvas = uiWindowSpec('canvas', platform, geometry, '/p').options;
      // macOS は画面全体（bounds）、Windows は作業領域に最大化。
      const canvasRect: Rect = {
        x: canvas.x ?? 0,
        y: canvas.y ?? 0,
        width: canvas.width,
        height: canvas.height,
      };
      assert.deepEqual(
        canvasRect,
        platform === 'darwin' ? display.bounds : display.workArea,
      );
      const layout = layoutCanvas({
        items: [],
        reading_order: [],
        viewport: { width: canvasRect.width, height: canvasRect.height },
        insets: canvasInsetsOf(canvasRect, display.workArea),
      });
      const relative = (window: {
        readonly x?: number;
        readonly y?: number;
        readonly width: number;
        readonly height: number;
      }): Rect => ({
        x: (window.x ?? 0) - canvasRect.x,
        y: (window.y ?? 0) - canvasRect.y,
        width: window.width,
        height: window.height,
      });
      const label = `${platform} ${display.id}`;
      const input = relative(
        uiWindowSpec('input', platform, geometry, '/p').options,
      );
      const status = relative(
        uiWindowSpec('status', platform, geometry, '/p').options,
      );
      assert(inside(input, layout.reserved.input_bar), `${label} input`);
      assert(inside(status, layout.reserved.status), `${label} status`);
    }
});

test('insets of the canvas window are the parts outside the work area', () => {
  assert.deepEqual(canvasInsetsOf(PRIMARY.bounds, PRIMARY.workArea), {
    top: 25,
    left: 0,
    right: 0,
    bottom: 75,
  });
  assert.deepEqual(canvasInsetsOf(PORTRAIT.bounds, PORTRAIT.workArea), {
    top: 25,
    left: 0,
    right: 0,
    bottom: 0,
  });
  assert.deepEqual(canvasInsetsOf(RIGHT.workArea, RIGHT.workArea), {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  });
});
