// 配置のヒント（UI-09、ADR 0200）の有無での見た目の回帰。happy-dom の文書の上に React で CanvasBoard を実際に描き、
// コードの配置の記述と、モデルのヒント（模擬。手で書いた値）を domain で当てた記述とで、カードの位置・大きさ・強調の印・
// DOM の順（読み上げとキーボードの順）を確かめる。期待値は手で書いた（1280 × 800: 左 24・上 72、列の送り 104、行の送り 88。
// scripts/layout-hint.test.mjs と同じ手計算）。本物のブラウザ・実機の描画・Codex の見た目のレビューではない
// （docs/ui/layout-hint.md）。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopCanvasView } from '@buddy/contracts';
import { applyCanvasBatch, applyCanvasLayoutHint } from '@buddy/domain';
import type {
  CanvasDocumentLike,
  CanvasItemLike,
  CanvasOpBatchLike,
} from '@buddy/domain';
import { AppProviders } from '../../app/AppProviders.js';
import { CanvasBoard } from './CanvasBoard.js';

after(async () => {
  await happy.happyDOM.close();
});

// 参照を持たない物（画面へ渡す記述と中枢の記述が同じ形になる）。
const item = (
  itemId: string,
  overrides: Partial<CanvasItemLike> = {},
): CanvasItemLike => ({
  item_id: itemId,
  kind: 'card',
  component: 'list',
  heading: `見出し${itemId}`,
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 1, span: 4, rows: 2 },
  placement: 'canvas',
  data: { item_refs: [], more_count: 0 },
  ...overrides,
});

// 今の記述（版 7）: errands（補助）・mail（補助）・news（周辺、ユーザーが 6 行目の列 9 に置いた）・棚の trip。
const canvas: CanvasDocumentLike = {
  canvas_revision: '7',
  items: [
    item('errands', { grid: { column: 2, span: 4, rows: 3 } }),
    item('mail', { grid: { column: 7, span: 4, rows: 2 } }),
    item('news', { emphasis: 'low', grid: { column: 9, span: 4, rows: 2 } }),
    item('trip', { placement: 'shelf', grid: { column: 1, span: 6, rows: 3 } }),
  ],
  reading_order: ['errands', 'mail', 'news'],
  user_pins: [
    { item_id: 'news', cell: { column: 9, row: 6, span: 4, rows: 2 } },
  ],
};

// コードの配置者の束（errands の中身だけを変える）。
const codeBatch: CanvasOpBatchLike = {
  base_canvas_revision: '7',
  canvas_revision: '8',
  ops: [
    {
      op: 'update',
      item_id: 'errands',
      changes: { data: { item_refs: [], more_count: 0 } },
    },
  ],
  reading_order: ['errands', 'mail', 'news'],
};

const viewOf = (batch: CanvasOpBatchLike): DesktopCanvasView => {
  const result = applyCanvasBatch(canvas, batch);
  assert(result.ok);
  // 参照は空なので、中枢の記述をそのまま画面へ渡す記述として使える（main の不透明な参照への置き換えが要らない）。
  return result.canvas as unknown as DesktopCanvasView;
};

async function draw(view: DesktopCanvasView) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProviders>
        <CanvasBoard
          view={view}
          front
          viewport={{ width: 1280, height: 800 }}
          onUserOp={() => Promise.resolve(null)}
        />
      </AppProviders>,
    );
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

const box = (itemId: string) => {
  const found = document.querySelector(`[data-item="${itemId}"]`);
  assert(found instanceof HTMLElement, itemId);
  const style = found.style;
  return {
    left: style.left,
    top: style.top,
    width: style.width,
    height: style.height,
    source: found.dataset['source'],
    emphasis:
      found.querySelector('[data-emphasis]')?.getAttribute('data-emphasis') ??
      null,
  };
};

const order = () =>
  [...document.querySelectorAll('[data-item]')].map((node) =>
    node.getAttribute('data-item'),
  );

test('without a hint the board draws the code layout', async () => {
  const unmount = await draw(viewOf(codeBatch));
  assert.deepEqual(box('errands'), {
    left: '128px',
    top: '72px',
    width: '400px',
    height: '248px',
    source: 'engine',
    emphasis: 'normal',
  });
  assert.deepEqual(box('mail'), {
    left: '648px',
    top: '72px',
    width: '400px',
    height: '160px',
    source: 'engine',
    emphasis: 'normal',
  });
  assert.deepEqual(box('news'), {
    left: '856px',
    top: '512px',
    width: '400px',
    height: '160px',
    source: 'user',
    emphasis: 'low',
  });
  assert.deepEqual(order(), ['errands', 'mail', 'news']);
  unmount();
});

test('with the hint the mail card is the large focus first in order, the pinned card stays, and a rejected hint draws the code layout', async () => {
  const hinted = applyCanvasLayoutHint({
    canvas,
    batch: codeBatch,
    hint: {
      base_canvas_revision: '7',
      focus: ['mail'],
      peripheral: [],
      order: ['mail', 'errands', 'news'],
      groups: [],
    },
  });
  assert(hinted.ok);
  const unmount = await draw(viewOf(hinted.batch));
  assert.deepEqual(box('mail'), {
    left: '648px',
    top: '72px',
    width: '608px',
    height: '336px',
    source: 'engine',
    emphasis: 'high',
  });
  assert.deepEqual(box('errands'), {
    left: '232px',
    top: '72px',
    width: '400px',
    height: '248px',
    source: 'engine',
    emphasis: 'normal',
  });
  assert.deepEqual(box('news'), {
    left: '856px',
    top: '512px',
    width: '400px',
    height: '160px',
    source: 'user',
    emphasis: 'low',
  });
  assert.deepEqual(order(), ['mail', 'errands', 'news']);
  unmount();
  // 棚の物を指すヒントは捨て、コードの配置で描く（上の試験と同じ位置）。
  const rejected = applyCanvasLayoutHint({
    canvas,
    batch: codeBatch,
    hint: {
      base_canvas_revision: '7',
      focus: ['trip'],
      peripheral: [],
      order: [],
      groups: [],
    },
  });
  assert.deepEqual(rejected, { ok: false, reason: 'shelved_item' });
  const again = await draw(viewOf(codeBatch));
  assert.equal(box('mail').width, '400px');
  assert.equal(box('errands').left, '128px');
  assert.deepEqual(order(), ['errands', 'mail', 'news']);
  again();
});
