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
  reveal,
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

const ID1 = { opId: 1, generation: 0 };
const ID2 = { opId: 2, generation: 0 };
const MOVE_A = {
  kind: 'move' as const,
  item_id: 'a',
  cell: { column: 7, row: 3, span: 4, rows: 2 },
};

test('a sent move is held until the description of the applied revision arrives; an unrelated newer revision does not release it', () => {
  const canvas = view('3', [
    item('a'),
    item('b', { grid: { column: 5, span: 4, rows: 2 } }),
  ]);
  let state = sent(NO_INTERACTION, MOVE_A, '3', ID1);
  assert.deepEqual(boxIn(canvas, state, 'a').cell, {
    column: 7,
    row: 3,
    span: 4,
    rows: 2,
  });
  // 応答の前に、ほかの物の更新で版 4 が届いても守る（その操作が当たった証拠ではない）。
  const unrelated = view('4', [
    item('a'),
    item('b', { grid: { column: 5, span: 4, rows: 2 }, emphasis: 'high' }),
  ]);
  state = interactionAfterView(state, unrelated);
  assert.notEqual(state.pending, null);
  assert.equal(boxIn(unrelated, state, 'a').source, 'held');
  // 成功の応答（中枢が当てた版 5）。今の記述は版 4 なので、版 5 が届くまで守る。
  state = settled(state, ID1, '5', '4');
  assert.equal(state.pending?.applied, '5');
  assert.equal(interactionAfterView(state, unrelated).pending?.applied, '5');
  // 版 5 の記述（ユーザーの置き場所を持つ）が届いたら解く。
  const applied = view('5', unrelated.items, {
    user_pins: [{ item_id: 'a', cell: MOVE_A.cell }],
  });
  state = interactionAfterView(state, applied);
  assert.equal(state.pending, null);
  assert.equal(boxIn(applied, state, 'a').source, 'user');
  // 当てた版の記述が先に届いていた（応答が遅れた）なら、応答ですぐに解く。
  const early = settled(sent(NO_INTERACTION, MOVE_A, '3', ID1), ID1, '5', '5');
  assert.equal(early.pending, null);
});

test('a rejection releases the hold; a late answer of an earlier operation or of a discarded generation does nothing', () => {
  let state = sent(NO_INTERACTION, MOVE_A, '3', ID1);
  state = settled(state, ID1, null, '3');
  assert.equal(state.pending, null);
  // 次の操作（ID 2）を送った後に、前の操作（ID 1）の遅れた拒否・成功が来ても、ID 2 の保護は外れない。
  const second = sent(
    state,
    {
      kind: 'resize',
      item_id: 'a',
      cell: { column: 1, row: 1, span: 6, rows: 2 },
    },
    '3',
    ID2,
  );
  assert.equal(settled(second, ID1, null, '3'), second);
  assert.equal(settled(second, ID1, '9', '3'), second);
  // 捨てた後の世代の応答（同じ ID でも世代が違う）も反映しない。
  assert.equal(settled(second, { opId: 2, generation: 1 }, null, '3'), second);
  assert.equal(settled(second, ID2, null, '3').pending, null);
  // 閉じるの送信中は、Core が当てるまで描かない。
  const canvas = view('3', [
    item('a'),
    item('b', { grid: { column: 5, span: 4, rows: 2 } }),
  ]);
  const closing = sent(
    NO_INTERACTION,
    { kind: 'close', item_id: 'a' },
    '3',
    ID1,
  );
  const layout = layoutForView(canvas, WIDE, NO_INSETS, closing);
  assert.deepEqual(
    layout.boxes.map((box) => box.item_id),
    ['b'],
  );
  assert.deepEqual(layout.reading_order, ['b']);
  // 閉じた物が記述からなくなったら（当たった）解く。
  assert.equal(
    interactionAfterView(closing, view('4', [item('b')])).pending,
    null,
  );
});

test('a card chosen from its overflow tag is shown first; closing or shelving it, or its disappearance, ends the choice', () => {
  // 480 × 800 の 1 列（置ける高さ 600）。a・b・c は 248（3 行）ずつ: a と b が入り、c は札。
  const items = ['a', 'b', 'c'].map((id) =>
    item(id, { grid: { column: 1, span: 4, rows: 3 } }),
  );
  const canvas = view('3', items);
  const NARROW = { width: 480, height: 800 };
  const before = layoutForView(canvas, NARROW, NO_INSETS, NO_INTERACTION);
  assert.deepEqual(before.overflow, ['c']);
  // c の札を押す: c が先に場所を取り、a・c が見え（読む順のまま a が上）、b が札に回る。
  const chosen = reveal(NO_INTERACTION, 'c');
  assert.equal(chosen.revealed, 'c');
  assert.equal(chosen.selected, 'c');
  const after = layoutForView(canvas, NARROW, NO_INSETS, chosen);
  assert.deepEqual(
    after.boxes.map((box) => [box.item_id, box.rect.y]),
    [
      ['a', 24],
      ['c', 288],
    ],
  );
  assert.deepEqual(after.overflow, ['b']);
  // c を閉じる・片付けると、選んだことも終わる。
  assert.equal(
    sent(chosen, { kind: 'close', item_id: 'c' }, '3', ID1).revealed,
    null,
  );
  assert.equal(
    sent(chosen, { kind: 'shelve', item_id: 'c' }, '3', ID1).revealed,
    null,
  );
  assert.equal(sent(chosen, MOVE_A, '3', ID1).revealed, 'c');
  // AI が c を閉じた・棚へ移した記述が届いたら終わる。ロック・停止で記述を捨てても終わる。
  assert.equal(
    interactionAfterView(chosen, view('4', items.slice(0, 2))).revealed,
    null,
  );
  assert.equal(interactionAfterView(chosen, null), NO_INTERACTION);
});

test('lock, stop or a discarded canvas drops the selection, the drag and the pending move', () => {
  const canvas = view('3', [item('a')]);
  const a = boxIn(canvas, NO_INTERACTION, 'a');
  const dragging = beginDrag(NO_INTERACTION, a, 'move', { x: 0, y: 0 });
  // main はロック・停止・切断で記述を捨てる（canvas: null）。
  assert.equal(interactionAfterView(dragging, null), NO_INTERACTION);
  const pending = sent(
    NO_INTERACTION,
    { kind: 'shelve', item_id: 'a' },
    '3',
    ID1,
  );
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
