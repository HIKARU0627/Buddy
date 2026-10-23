// キャンバスの窓の配置とユーザーの操作の状態（UI-06、ADR 0032）の試験。作業領域の外の幅、ドラッグの間の保護（新しい記述が
// 届いても守る・なくなったらやめる）、送信中の位置、ロック・停止で捨てること、キーボードの操作を確かめる。期待値は手で書いた
// （1280 × 800: 左 24・上 24、列の幅 82・間 16（1 列分の送り 98）、行の高さ 72・間 16（1 行分の送り 88）、7 行）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopCanvasView } from '@buddy/contracts';
import type { CanvasViewItem } from './canvas-state.js';
import {
  NO_INSETS,
  NO_INTERACTION,
  beginDrag,
  canvasInsetsFrom,
  dragTo,
  endDrag,
  heldOf,
  interactionAfterView,
  keyOp,
  layoutForView,
  sent,
  settled,
} from './canvas-layout-state.js';
import type {
  CanvasInteraction,
  CanvasLayoutBox,
} from './canvas-layout-state.js';

const item = (
  id: string,
  overrides: Partial<CanvasViewItem> = {},
): CanvasViewItem => ({
  item_id: id,
  kind: 'card',
  component: 'list',
  heading: '見出し',
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 1, span: 4, rows: 2 },
  placement: 'canvas',
  data: { item_refs: [], more_count: 0 },
  ...overrides,
});

const view = (
  revision: string,
  items: CanvasViewItem[],
  extra: Partial<DesktopCanvasView> = {},
): DesktopCanvasView => ({
  canvas_revision: revision,
  items,
  reading_order: items
    .filter((entry) => entry.placement === 'canvas')
    .map((entry) => entry.item_id),
  ...extra,
});

const WIDE = { width: 1280, height: 800 };

const boxIn = (
  canvas: DesktopCanvasView,
  interaction: CanvasInteraction,
  id: string,
): CanvasLayoutBox => {
  const found = layoutForView(canvas, WIDE, NO_INSETS, interaction).boxes.find(
    (box) => box.item_id === id,
  );
  assert(found, id);
  return found;
};

test('insets come from the work area of the screen: menu bar on top and Dock at the bottom (macOS), zero for a maximized window', () => {
  // 画面 1440 × 900 の全体を覆う窓。作業領域は上 25 から高さ 800（Dock 75）。
  assert.deepEqual(
    canvasInsetsFrom(
      { availLeft: 0, availTop: 25, availWidth: 1440, availHeight: 800 },
      { screenX: 0, screenY: 0, innerWidth: 1440, innerHeight: 900 },
    ),
    { top: 25, left: 0, right: 0, bottom: 75 },
  );
  // 2 つ目の画面（x 1440 から）で左に Dock（幅 64）。
  assert.deepEqual(
    canvasInsetsFrom(
      { availLeft: 1504, availTop: 25, availWidth: 1856, availHeight: 1175 },
      { screenX: 1440, screenY: 0, innerWidth: 1920, innerHeight: 1200 },
    ),
    { top: 25, left: 64, right: 0, bottom: 0 },
  );
  // Windows の最大化の窓（作業領域と同じ）は 0。avail* がなくても壊れない。
  assert.deepEqual(
    canvasInsetsFrom(
      { availWidth: 1920, availHeight: 1040 },
      { screenX: 0, screenY: 0, innerWidth: 1920, innerHeight: 1040 },
    ),
    NO_INSETS,
  );
});

test('while dragging, the dragged item keeps its place even if a new revision from the AI moves it; others are laid out again', () => {
  const first = view('3', [
    item('a', { grid: { column: 1, span: 4, rows: 2 } }),
    item('b', { grid: { column: 5, span: 4, rows: 2 } }),
  ]);
  // a は 1 行目・列 1、b は焦点がないので 1 行目・列 5。
  const a = boxIn(first, NO_INTERACTION, 'a');
  assert.deepEqual(a.cell, { row: 1, column: 1, span: 4, rows: 2 });
  let state = beginDrag(NO_INTERACTION, a, 'move', { x: 100, y: 50 });
  // 右へ 2 列分（196）・下へ 1 行分（88）動かす → 列 3・行 2。
  state = dragTo(state, layoutForView(first, WIDE, NO_INSETS, state).grid, {
    x: 296,
    y: 138,
  });
  assert.deepEqual(state.drag?.cell, { column: 3, row: 2, span: 4, rows: 2 });
  assert.deepEqual(heldOf(state), {
    item_id: 'a',
    cell: { column: 3, row: 2, span: 4, rows: 2 },
  });
  // AI が a を動かし（ヒントを列 9 に）、強調も変えた版 4 が届く。ドラッグ中は a を守る（今のマスのまま）。
  const second = view('4', [
    item('a', { grid: { column: 9, span: 4, rows: 2 }, emphasis: 'high' }),
    item('b', { grid: { column: 5, span: 4, rows: 2 } }),
  ]);
  state = interactionAfterView(state, second);
  assert.notEqual(state.drag, null);
  const held = boxIn(second, state, 'a');
  assert.equal(held.source, 'held');
  assert.deepEqual(held.cell, { column: 3, row: 2, span: 4, rows: 2 });
  // 離すと、置く先のマスで動かす操作を送る。
  const ended = endDrag(state);
  assert.deepEqual(ended.op, {
    kind: 'move',
    item_id: 'a',
    cell: { column: 3, row: 2, span: 4, rows: 2 },
  });
  assert.equal(ended.state.drag, null);
});

test('a drag stops when the dragged item disappears; no move is sent; an unchanged drop sends nothing', () => {
  const first = view('3', [
    item('a'),
    item('b', { grid: { column: 5, span: 4, rows: 2 } }),
  ]);
  const a = boxIn(first, NO_INTERACTION, 'a');
  let state = beginDrag(NO_INTERACTION, a, 'move', { x: 0, y: 0 });
  // AI が a を閉じた版。
  state = interactionAfterView(state, view('4', [item('b')]));
  assert.equal(state.drag, null);
  assert.equal(state.selected, null);
  assert.equal(endDrag(state).op, null);
  // AI が a を棚へ片付けた版でもやめる。
  let shelved = beginDrag(NO_INTERACTION, a, 'move', { x: 0, y: 0 });
  shelved = interactionAfterView(
    shelved,
    view('4', [item('a', { placement: 'shelf' }), item('b')]),
  );
  assert.equal(shelved.drag, null);
  // 動かさずに離したら何も送らない。
  const still = beginDrag(NO_INTERACTION, a, 'move', { x: 10, y: 10 });
  assert.equal(endDrag(still).op, null);
});

test('resizing by the corner snaps to whole cells within the grid', () => {
  const canvas = view('3', [
    item('a', { grid: { column: 9, span: 4, rows: 2 } }),
  ]);
  const box = boxIn(canvas, NO_INTERACTION, 'a');
  // 焦点がない補助: 1 行目・ヒントの列 9。
  assert.deepEqual(box.cell, { row: 1, column: 9, span: 4, rows: 2 });
  const grid = layoutForView(canvas, WIDE, NO_INSETS, NO_INTERACTION).grid;
  let state = beginDrag(NO_INTERACTION, box, 'resize', { x: 0, y: 0 });
  // 左へ 2 列分（−196）・下へ 2 行分（176）。
  state = dragTo(state, grid, { x: -196, y: 176 });
  assert.deepEqual(state.drag?.cell, { row: 1, column: 9, span: 2, rows: 4 });
  // 右へはみ出す幅は 12 列に収める（列 9 からは 4 列まで）。下は 7 行まで。
  state = dragTo(state, grid, { x: 2000, y: 2000 });
  assert.deepEqual(state.drag?.cell, { row: 1, column: 9, span: 4, rows: 7 });
  assert.deepEqual(endDrag(state).op, {
    kind: 'resize',
    item_id: 'a',
    cell: { row: 1, column: 9, span: 4, rows: 7 },
  });
});

test('a sent move is held until a newer revision arrives; a rejection releases it; a sent close hides the item', () => {
  const canvas = view('3', [
    item('a'),
    item('b', { grid: { column: 5, span: 4, rows: 2 } }),
  ]);
  let state = sent(
    NO_INTERACTION,
    {
      kind: 'move',
      item_id: 'a',
      cell: { column: 7, row: 3, span: 4, rows: 2 },
    },
    '3',
  );
  assert.deepEqual(boxIn(canvas, state, 'a').cell, {
    column: 7,
    row: 3,
    span: 4,
    rows: 2,
  });
  // 同じ版の記述が届いても守る。新しい版（Core が当てた）が届いたら解く。
  assert.equal(interactionAfterView(state, canvas), state);
  assert.equal(
    interactionAfterView(state, view('4', canvas.items)).pending,
    null,
  );
  // 拒否されたら解く（当たったなら新しい版を待つ）。
  assert.equal(settled(state, true), state);
  state = settled(state, false);
  assert.equal(state.pending, null);
  // 閉じるの送信中は、Core が当てるまで描かない。
  const closing = sent(NO_INTERACTION, { kind: 'close', item_id: 'a' }, '3');
  const layout = layoutForView(canvas, WIDE, NO_INSETS, closing);
  assert.deepEqual(
    layout.boxes.map((box) => box.item_id),
    ['b'],
  );
  assert.deepEqual(layout.reading_order, ['b']);
});

test('lock, stop or a discarded canvas drops the selection, the drag and the pending move', () => {
  const canvas = view('3', [item('a')]);
  const a = boxIn(canvas, NO_INTERACTION, 'a');
  const dragging = beginDrag(NO_INTERACTION, a, 'move', { x: 0, y: 0 });
  // main はロック・停止・切断で記述を捨てる（canvas: null）。
  assert.equal(interactionAfterView(dragging, null), NO_INTERACTION);
  const pending = sent(NO_INTERACTION, { kind: 'shelve', item_id: 'a' }, '3');
  assert.equal(interactionAfterView(pending, null), NO_INTERACTION);
  // 送信中は新しいドラッグを始めない。
  assert.equal(beginDrag(pending, a, 'move', { x: 0, y: 0 }), pending);
});

const key = (
  name: string,
  modifiers: Partial<{
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
    meta: boolean;
  }> = {},
) => ({
  key: name,
  shiftKey: modifiers.shift ?? false,
  altKey: modifiers.alt ?? false,
  ctrlKey: modifiers.ctrl ?? false,
  metaKey: modifiers.meta ?? false,
});

test('keyboard: arrows move one cell, Shift+arrows resize, Delete closes, Alt+Down shelves; edges and modifiers do nothing', () => {
  const canvas = view('3', [
    item('a', { grid: { column: 1, span: 4, rows: 2 } }),
  ]);
  const layout = layoutForView(canvas, WIDE, NO_INSETS, NO_INTERACTION);
  const box = layout.boxes[0];
  assert(box);
  assert.deepEqual(box.cell, { row: 1, column: 1, span: 4, rows: 2 });
  const cell = (column: number, row: number, span: number, rows: number) => ({
    column,
    row,
    span,
    rows,
  });
  assert.deepEqual(keyOp(key('ArrowRight'), box, layout.grid), {
    kind: 'move',
    item_id: 'a',
    cell: cell(2, 1, 4, 2),
  });
  assert.deepEqual(keyOp(key('ArrowDown'), box, layout.grid), {
    kind: 'move',
    item_id: 'a',
    cell: cell(1, 2, 4, 2),
  });
  // 左・上の端では動かない。
  assert.equal(keyOp(key('ArrowLeft'), box, layout.grid), null);
  assert.equal(keyOp(key('ArrowUp'), box, layout.grid), null);
  assert.deepEqual(
    keyOp(key('ArrowRight', { shift: true }), box, layout.grid),
    {
      kind: 'resize',
      item_id: 'a',
      cell: cell(1, 1, 5, 2),
    },
  );
  assert.deepEqual(keyOp(key('ArrowUp', { shift: true }), box, layout.grid), {
    kind: 'resize',
    item_id: 'a',
    cell: cell(1, 1, 4, 1),
  });
  assert.deepEqual(keyOp(key('Delete'), box, layout.grid), {
    kind: 'close',
    item_id: 'a',
  });
  assert.deepEqual(keyOp(key('Backspace'), box, layout.grid), {
    kind: 'close',
    item_id: 'a',
  });
  assert.deepEqual(keyOp(key('ArrowDown', { alt: true }), box, layout.grid), {
    kind: 'shelve',
    item_id: 'a',
  });
  // ⌘・Ctrl との組み合わせ・ほかのキーは操作にしない。
  assert.equal(
    keyOp(key('ArrowRight', { meta: true }), box, layout.grid),
    null,
  );
  assert.equal(keyOp(key('Delete', { ctrl: true }), box, layout.grid), null);
  assert.equal(keyOp(key('a'), box, layout.grid), null);
  // 1 列（格子がない）では動かす・大きさを変えるを受けない。閉じるは受ける。
  const narrow = layoutForView(
    canvas,
    { width: 600, height: 900 },
    NO_INSETS,
    NO_INTERACTION,
  );
  const column = narrow.boxes[0];
  assert(column);
  assert.equal(narrow.grid, null);
  assert.equal(keyOp(key('ArrowRight'), column, narrow.grid), null);
  assert.deepEqual(keyOp(key('Delete'), column, narrow.grid), {
    kind: 'close',
    item_id: 'a',
  });
});
