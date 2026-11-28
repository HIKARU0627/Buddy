// 配置のヒント（UI-09、ADR 0200）の有無での見た目の回帰。happy-dom の文書の上に React で CanvasBoard を実際に描く。
// 描く記述は、Core と同じ決め方（domain の decideCanvasTurnLayout。コードの値へ戻す update・ヒントの意味の検査）で
// 決めた束を当てたもので、ヒントを使ったとき・捨てたとき・前のヒントを次の発言で戻したときのカードの位置・大きさ・
// 強調の印・DOM の順（読み上げとキーボードの順）を、手で書いた値と比べる（1280 × 800: 左 24・上 72、列の送り 104、
// 行の送り 88。apps/core/src/canvas-layout-hint.test.ts と同じ手計算）。本物のブラウザ・実機の描画・Codex の
// 見た目のレビューではない（docs/ui/layout-hint.md）。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopCanvasView } from '@buddy/contracts';
import { applyCanvasBatch, decideCanvasTurnLayout } from '@buddy/domain';
import type {
  CanvasDocumentLike,
  CanvasItemLike,
  CanvasLayoutHintLike,
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
const codeBatch = (from: CanvasDocumentLike): CanvasOpBatchLike => ({
  base_canvas_revision: from.canvas_revision,
  canvas_revision: (BigInt(from.canvas_revision) + 1n).toString(),
  ops: [
    {
      op: 'update',
      item_id: 'errands',
      changes: { data: { item_refs: [], more_count: 0 } },
    },
  ],
  reading_order: [...from.reading_order],
});

const hint = (
  overrides: Partial<CanvasLayoutHintLike>,
): CanvasLayoutHintLike => ({
  base_canvas_revision: '7',
  focus: [],
  peripheral: [],
  order: [],
  groups: [],
  ...overrides,
});

// Core と同じ決め方で 1 つの発言の束を決めて当てる（コードの値は始めの記述の値）。
const turn = (
  from: CanvasDocumentLike,
  given: CanvasLayoutHintLike | null,
): { document: CanvasDocumentLike; hint: string } => {
  const decision = decideCanvasTurnLayout({
    canvas: from,
    batch: codeBatch(from),
    hint: given,
    code: new Map(
      canvas.items.map((entry) => [
        entry.item_id,
        { emphasis: entry.emphasis, group: entry.group },
      ]),
    ),
  });
  assert(decision.ok);
  const result = applyCanvasBatch(from, decision.batch);
  assert(result.ok);
  return { document: result.canvas, hint: decision.hint };
};

// 参照は空なので、中枢の記述をそのまま画面へ渡す記述として使える（main の不透明な参照への置き換えが要らない）。
const viewOf = (document: CanvasDocumentLike): DesktopCanvasView =>
  document as unknown as DesktopCanvasView;

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
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
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

// ヒントなし（コードの配置）の手で書いた値。
const CODE_LAYOUT = {
  errands: {
    left: '128px',
    top: '72px',
    width: '400px',
    height: '248px',
    source: 'engine',
    emphasis: 'normal',
  },
  mail: {
    left: '648px',
    top: '72px',
    width: '400px',
    height: '160px',
    source: 'engine',
    emphasis: 'normal',
  },
  news: {
    left: '856px',
    top: '512px',
    width: '400px',
    height: '160px',
    source: 'user',
    emphasis: 'low',
  },
};

const drawnCodeLayout = () => ({
  errands: box('errands'),
  mail: box('mail'),
  news: box('news'),
});

test('without a hint the board draws the code layout', async () => {
  const decided = turn(canvas, null);
  assert.equal(decided.hint, 'none');
  const drawn = await draw(viewOf(decided.document));
  assert.deepEqual(drawnCodeLayout(), CODE_LAYOUT);
  assert.deepEqual(order(), ['errands', 'mail', 'news']);
  drawn.unmount();
});

test('with the hint the mail card is the large focus first in order, the pinned card stays; a rejected hint draws the code layout', async () => {
  const used = turn(
    canvas,
    hint({ focus: ['mail'], order: ['mail', 'errands', 'news'] }),
  );
  assert.equal(used.hint, 'applied');
  const drawn = await draw(viewOf(used.document));
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
  assert.deepEqual(box('news'), CODE_LAYOUT.news);
  assert.deepEqual(order(), ['mail', 'errands', 'news']);
  drawn.unmount();
  // 棚の物を指すヒントは捨て、決め方が選んだ束（コードの束）を描く。
  const rejected = turn(canvas, hint({ focus: ['trip'] }));
  assert.equal(rejected.hint, 'shelved_item');
  const again = await draw(viewOf(rejected.document));
  assert.deepEqual(drawnCodeLayout(), CODE_LAYOUT);
  assert.deepEqual(order(), ['errands', 'mail', 'news']);
  again.unmount();
});

test('the next turn without a hint draws the code layout again (the hint focus does not stay)', async () => {
  const first = turn(canvas, hint({ focus: ['mail'] }));
  assert.equal(first.hint, 'applied');
  const second = turn(first.document, null);
  assert.equal(second.hint, 'none');
  const drawn = await draw(viewOf(second.document));
  assert.deepEqual(drawnCodeLayout(), CODE_LAYOUT);
  drawn.unmount();
});

test('the board draws no group name: a name in the description appears nowhere in the DOM', async () => {
  // モデルの名前は Core が記述へ入れない（g1〜g4 に付け直す）。仮に名前が記述にあっても、画面は描かない。
  const named: CanvasDocumentLike = {
    ...canvas,
    items: canvas.items.map((entry) =>
      entry.item_id === 'errands' || entry.item_id === 'mail'
        ? { ...entry, group: 'approve-now' }
        : entry,
    ),
  };
  const drawn = await draw(viewOf(named));
  assert(!drawn.container.innerHTML.includes('approve-now'));
  assert(!(drawn.container.textContent ?? '').includes('approve-now'));
  drawn.unmount();
  // 決め方を通したヒントのまとまりは g1 で、モデルの名前は記述にない。
  const grouped = turn(
    canvas,
    hint({ groups: [{ group: 'approve-now', members: ['errands', 'mail'] }] }),
  );
  assert.equal(grouped.hint, 'applied');
  assert(!JSON.stringify(grouped.document).includes('approve-now'));
  const again = await draw(viewOf(grouped.document));
  assert(!again.container.innerHTML.includes('approve-now'));
  assert(!again.container.innerHTML.includes('"g1"'));
  again.unmount();
});
