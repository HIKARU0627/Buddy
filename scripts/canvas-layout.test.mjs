import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANVAS_LAYOUT,
  canvasCellAt,
  layoutCanvas,
} from '../packages/domain/dist/index.js';

// UI-06（ADR 0032 の「UI-06 の配置のエンジンとユーザーの操作」）: 配置のエンジンの純粋な関数の試験。
// 期待値（マス・ピクセル・棚・空けた場所）は ADR の規則から手で計算した値で、エンジンの実装から作らない。
// 1280 × 800（作業領域の外なし）の手計算: 左 24・上 24、置ける幅 = 1280 − 72 − 24 − 24 = 1160、
// 列の幅 = (1160 − 16 × 11) / 12 = 82（1 列分の送り 98）、行の高さ 72（1 行分の送り 88）、
// 入力バーの場所 = x (1280 − 592) / 2 = 344・y 800 − 88 = 712、置ける下端 = 712 − 16 = 696、
// 行の数 = floor((696 − 24 + 16) / 88) = 7、棚 = x 24・y 800 − 16 − 56 = 728・幅 344 − 16 − 24 = 304。

const item = (id, overrides = {}) => ({
  item_id: id,
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 1, span: 4, rows: 2 },
  placement: 'canvas',
  ...overrides,
});

const layout = (items, options = {}) =>
  layoutCanvas({
    items,
    reading_order:
      options.order ??
      items
        .filter((entry) => entry.placement === 'canvas')
        .map((e) => e.item_id),
    user_pins: options.pins ?? [],
    held: options.held ?? null,
    viewport: options.viewport ?? { width: 1280, height: 800 },
    ...(options.insets === undefined ? {} : { insets: options.insets }),
  });

const cellOf = (result, id) => {
  const box = result.boxes.find((entry) => entry.item_id === id);
  assert(box, id);
  return box.cell;
};

const rectOf = (result, id) => {
  const box = result.boxes.find((entry) => entry.item_id === id);
  assert(box, id);
  return box.rect;
};

const cell = (row, column, span, rows) => ({ row, column, span, rows });

const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

test('the constants match ADR 0032 (UI-06)', () => {
  assert.deepEqual(CANVAS_LAYOUT, {
    margin: 24,
    gap: 16,
    rowHeight: 72,
    statusReserveWidth: 72,
    inputBarReserve: { width: 592, height: 88 },
    shelfHeight: 56,
    shelfBottomMargin: 16,
    shelfMinWidth: 160,
    gridMinWidth: 720,
    maxRows: 48,
    minHeight: 272,
    compactShelfTop: 4,
    compactShelfHeight: 32,
  });
});

test('meaning decides the place: focus large at the top, compare beside, detail next to its parent, sequence below, peripheral at the edge', () => {
  const result = layout([
    item('focus', { emphasis: 'high' }),
    item('compare', {
      relations: [{ kind: 'compare', target: 'focus' }],
      grid: { column: 9, span: 3, rows: 2 },
    }),
    item('detail', {
      relations: [{ kind: 'detail_of', target: 'compare' }],
      grid: { column: 1, span: 3, rows: 2 },
    }),
    item('next', {
      relations: [{ kind: 'sequence', target: 'detail' }],
      grid: { column: 5, span: 2, rows: 1 },
    }),
    item('edge', { emphasis: 'low', grid: { column: 3, span: 6, rows: 3 } }),
  ]);
  assert.equal(result.mode, 'grid');
  assert.deepEqual(result.grid, {
    x: 24,
    y: 24,
    columnWidth: 82,
    rowHeight: 72,
    gap: 16,
    columns: 12,
    rows: 7,
  });
  // 焦点: 幅 4 → 6、行 2 → 4 に広げ、1 行目・列 1。
  assert.deepEqual(cellOf(result, 'focus'), cell(1, 1, 6, 4));
  // 見比べる: 焦点の右隣（列 7）、行数を焦点にそろえる（4）。ヒントの列 9 は使わない。
  assert.deepEqual(cellOf(result, 'compare'), cell(1, 7, 3, 4));
  // 詳細: 親（compare）の右隣（列 10）。
  assert.deepEqual(cellOf(result, 'detail'), cell(1, 10, 3, 2));
  // 順序: 相手（detail）の真下（行 3・列 10）。
  assert.deepEqual(cellOf(result, 'next'), cell(3, 10, 2, 1));
  // 周辺: 幅 6 → 4、行 3 → 2 に縮め、最後の行に下端をそろえる（行 6）、ヒントの列 3。
  assert.deepEqual(cellOf(result, 'edge'), cell(6, 3, 4, 2));
  // ピクセル（手計算）。
  assert.deepEqual(rectOf(result, 'focus'), {
    x: 24,
    y: 24,
    width: 572,
    height: 336,
  });
  assert.deepEqual(rectOf(result, 'compare'), {
    x: 612,
    y: 24,
    width: 278,
    height: 336,
  });
  assert.deepEqual(rectOf(result, 'detail'), {
    x: 906,
    y: 24,
    width: 278,
    height: 160,
  });
  assert.deepEqual(rectOf(result, 'next'), {
    x: 906,
    y: 200,
    width: 180,
    height: 72,
  });
  assert.deepEqual(rectOf(result, 'edge'), {
    x: 220,
    y: 464,
    width: 376,
    height: 160,
  });
  assert.deepEqual(result.reading_order, [
    'focus',
    'compare',
    'detail',
    'next',
    'edge',
  ]);
  assert.deepEqual(result.overflow, []);
  assert(result.boxes.every((box) => box.source === 'engine'));
});

test('a relation whose target comes later in reading order waits for the target', () => {
  // detail が先に読まれても、親（parent）を置いてから、その右隣に置く。
  const result = layout(
    [
      item('detail', {
        relations: [{ kind: 'detail_of', target: 'parent' }],
        grid: { column: 9, span: 3, rows: 2 },
      }),
      item('parent', { grid: { column: 1, span: 4, rows: 2 } }),
    ],
    { order: ['detail', 'parent'] },
  );
  assert.deepEqual(cellOf(result, 'parent'), cell(1, 1, 4, 2));
  assert.deepEqual(cellOf(result, 'detail'), cell(1, 5, 3, 2));
  // 読む順（DOM の順）は記述のまま。
  assert.deepEqual(result.reading_order, ['detail', 'parent']);
  assert.deepEqual(
    result.boxes.map((box) => box.item_id),
    ['detail', 'parent'],
  );
});

test('a group pulls its members together; the grid hint is used only where the meaning allows', () => {
  const grouped = layout([
    item('g1', { group: 'today', grid: { column: 1, span: 3, rows: 2 } }),
    item('other', { grid: { column: 1, span: 3, rows: 2 } }),
    item('g2', { group: 'today', grid: { column: 9, span: 3, rows: 2 } }),
  ]);
  assert.deepEqual(cellOf(grouped, 'g1'), cell(1, 1, 3, 2));
  // other は列 1 を望むが空いていない: 最も近い空き（行 1・列 4。同点の行 3・列 1 より上を選ぶ）。
  assert.deepEqual(cellOf(grouped, 'other'), cell(1, 4, 3, 2));
  // g2 はヒントの列 9 ではなく、まとまり（g1 の範囲 行 1〜2・列 1〜3）に接する空きを望む: 右隣（列 4）は other なので、
  // 行の順に探して最初に接する（すき間 0 の）空き = g1 の真下（行 3・列 1）。列 7 は列のすき間 3 で遠い。
  assert.deepEqual(cellOf(grouped, 'g2'), cell(3, 1, 3, 2));
  // まとまりがなければヒントの列 9。
  const loose = layout([
    item('g1', { grid: { column: 1, span: 3, rows: 2 } }),
    item('other', { grid: { column: 1, span: 3, rows: 2 } }),
    item('g2', { grid: { column: 9, span: 3, rows: 2 } }),
  ]);
  assert.deepEqual(cellOf(loose, 'g2'), cell(1, 9, 3, 2));
});

test('user pins are kept exactly; a later pin on a taken cell moves to the nearest free cell; a held item wins over its pin', () => {
  const result = layout(
    [item('a'), item('b'), item('c', { emphasis: 'high' })],
    {
      pins: [
        { item_id: 'a', cell: { column: 2, row: 2, span: 4, rows: 2 } },
        { item_id: 'b', cell: { column: 2, row: 2, span: 4, rows: 2 } },
      ],
    },
  );
  assert.deepEqual(cellOf(result, 'a'), cell(2, 2, 4, 2));
  // b は a と同じマス: 同じ大きさで最も近い空き（行 4・列 2。行の差 2 × 3 = 6 が、列 6 の 4 × 2 = 8 より近い）。
  assert.deepEqual(cellOf(result, 'b'), cell(4, 2, 4, 2));
  assert.equal(result.boxes.find((box) => box.item_id === 'a').source, 'user');
  assert.equal(result.boxes.find((box) => box.item_id === 'b').source, 'user');
  // ユーザーが置いた物の後に焦点を置く（行 1・列 1 は a と重なるので、最も近い空き）。
  const focus = cellOf(result, 'c');
  assert.equal(focus.span, 6);
  assert.equal(focus.rows, 4);
  // 守る物（ドラッグ中）は、ユーザーの置き場所より先にその位置へ置く。
  const held = layout([item('a')], {
    pins: [{ item_id: 'a', cell: { column: 1, row: 1, span: 4, rows: 2 } }],
    held: { item_id: 'a', cell: { column: 5, row: 3, span: 4, rows: 2 } },
  });
  assert.deepEqual(cellOf(held, 'a'), cell(3, 5, 4, 2));
  assert.equal(held.boxes[0].source, 'held');
  // はみ出す置き場所は格子に収める（行 7 から 2 行は入らないので行 6）。
  const clamped = layout([item('a')], {
    pins: [{ item_id: 'a', cell: { column: 9, row: 7, span: 4, rows: 2 } }],
  });
  assert.deepEqual(cellOf(clamped, 'a'), cell(6, 9, 4, 2));
});

test('what does not fit is shrunk, then put on the shelf place as overflow (the description is not changed)', () => {
  const result = layout(
    ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) => item(id, { emphasis: 'high' })),
  );
  assert.deepEqual(cellOf(result, 'h1'), cell(1, 1, 6, 4));
  assert.deepEqual(cellOf(result, 'h2'), cell(1, 7, 6, 4));
  // 4 行は入らないので 3 行に縮める（行 5〜7）。
  assert.deepEqual(cellOf(result, 'h3'), cell(5, 1, 6, 3));
  assert.deepEqual(cellOf(result, 'h4'), cell(5, 7, 6, 3));
  assert.deepEqual(rectOf(result, 'h3'), {
    x: 24,
    y: 376,
    width: 572,
    height: 248,
  });
  assert.deepEqual(result.overflow, ['h5']);
  assert.deepEqual(result.reading_order, ['h1', 'h2', 'h3', 'h4', 'h5']);
  assert.equal(
    result.boxes.some((box) => box.item_id === 'h5'),
    false,
  );
});

test('the shelf sits left of the input bar; shelved items keep the order of the description and never get a box', () => {
  const result = layout([
    item('a'),
    item('s2', { placement: 'shelf' }),
    item('b'),
    item('s1', { placement: 'shelf' }),
  ]);
  assert.deepEqual(result.shelf, {
    rect: { x: 24, y: 728, width: 304, height: 56 },
    items: ['s2', 's1'],
    compact: false,
  });
  assert.deepEqual(result.reserved, {
    input_bar: { x: 344, y: 712, width: 592, height: 88 },
    status: { x: 1208, y: 0, width: 72, height: 800 },
  });
  assert.deepEqual(
    result.boxes.map((box) => box.item_id),
    ['a', 'b'],
  );
});

test('a narrow canvas is one column in reading order; the shelf moves above the input bar; what does not fit overflows in order', () => {
  // 480 × 800: 置ける幅 480 − 72 − 48 = 360。入力バーの場所は幅 480 いっぱい（x 0・y 712）。左に棚の幅がないので、
  // 棚は入力バーの上（y 712 − 16 − 56 = 640）、置ける下端 640 − 16 = 624。
  const result = layout(
    [
      item('a', { grid: { column: 1, span: 4, rows: 2 } }),
      item('b', { emphasis: 'high', grid: { column: 1, span: 4, rows: 1 } }),
      item('c', { emphasis: 'low', grid: { column: 1, span: 4, rows: 3 } }),
      item('d', { grid: { column: 1, span: 4, rows: 3 } }),
      item('e', { emphasis: 'low' }),
    ],
    { viewport: { width: 480, height: 800 } },
  );
  assert.equal(result.mode, 'column');
  assert.equal(result.grid, null);
  assert.deepEqual(result.reserved.input_bar, {
    x: 0,
    y: 712,
    width: 480,
    height: 88,
  });
  assert.deepEqual(result.shelf.rect, {
    x: 24,
    y: 640,
    width: 360,
    height: 56,
  });
  // a: 2 行（160）、b: 焦点は 3 行以上（248）、c: 周辺は 1 行（72）。
  assert.deepEqual(rectOf(result, 'a'), {
    x: 24,
    y: 24,
    width: 360,
    height: 160,
  });
  assert.deepEqual(rectOf(result, 'b'), {
    x: 24,
    y: 200,
    width: 360,
    height: 248,
  });
  assert.deepEqual(rectOf(result, 'c'), {
    x: 24,
    y: 464,
    width: 360,
    height: 72,
  });
  // d（3 行・248）は下端 624 を超える。e は入る高さでも、読む順を保つため d の後ろに回す。
  assert.deepEqual(result.overflow, ['d', 'e']);
  assert(result.boxes.every((box) => box.cell === null));
  // 1 列ではユーザーの置き場所・守る物を使わない。
  const pinned = layout([item('a')], {
    viewport: { width: 480, height: 800 },
    pins: [{ item_id: 'a', cell: { column: 9, row: 3, span: 4, rows: 2 } }],
    held: { item_id: 'a', cell: { column: 5, row: 5, span: 4, rows: 2 } },
  });
  assert.deepEqual(rectOf(pinned, 'a'), {
    x: 24,
    y: 24,
    width: 360,
    height: 160,
  });
});

test('the work area insets (menu bar and Dock) move every reserved place inside the work area', () => {
  // 1440 × 900、上 25（メニューバー）・下 75（Dock）。作業領域 = y 25・高さ 800。
  const result = layout([item('a')], {
    viewport: { width: 1440, height: 900 },
    insets: { top: 25, right: 0, bottom: 75, left: 0 },
  });
  assert.deepEqual(result.reserved, {
    input_bar: { x: 424, y: 737, width: 592, height: 88 },
    status: { x: 1368, y: 25, width: 72, height: 800 },
  });
  assert.deepEqual(result.shelf.rect, {
    x: 24,
    y: 753,
    width: 384,
    height: 56,
  });
  // 上 25 + 24 = 49 から、置ける下端 737 − 16 = 721 まで 7 行。
  assert.equal(result.grid.y, 49);
  assert.equal(result.grid.rows, 7);
  assert.deepEqual(rectOf(result, 'a').y, 49);
});

// 幅を変えた試験で使う物（焦点・関係・まとまり・周辺・棚を含む 10 個）。
const MIXED = [
  item('focus', { emphasis: 'high', grid: { column: 4, span: 5, rows: 3 } }),
  item('cmp', {
    relations: [{ kind: 'compare', target: 'focus' }],
    grid: { column: 9, span: 4, rows: 2 },
  }),
  item('det', {
    relations: [{ kind: 'detail_of', target: 'cmp' }],
    grid: { column: 1, span: 3, rows: 2 },
  }),
  item('seq', {
    relations: [{ kind: 'sequence', target: 'det' }],
    grid: { column: 1, span: 3, rows: 1 },
  }),
  item('g1', { group: 'g', grid: { column: 2, span: 3, rows: 2 } }),
  item('g2', { group: 'g', grid: { column: 10, span: 3, rows: 2 } }),
  item('n1', { grid: { column: 6, span: 4, rows: 2 } }),
  item('low1', { emphasis: 'low', grid: { column: 1, span: 6, rows: 3 } }),
  item('low2', { emphasis: 'low', grid: { column: 7, span: 2, rows: 1 } }),
  item('shelf1', { placement: 'shelf' }),
];

// 手で書いた幅ごとの並べ方。置ける幅 = 幅 − 120 が 720 以上（幅 840 以上）なら格子。
const MODES = [
  [480, 'column'],
  [600, 'column'],
  [768, 'column'],
  [839, 'column'],
  [840, 'grid'],
  [1024, 'grid'],
  [1280, 'grid'],
  [1440, 'grid'],
  [1920, 'grid'],
];

test('widths 480 to 1920: the mode switches at 840, and no box overlaps another, the input bar, the status edge or the shelf', () => {
  for (const [width, mode] of MODES)
    for (const height of [272, 300, 720, 900, 1080]) {
      const result = layout(MIXED, { viewport: { width, height } });
      const label = `${width}×${height}`;
      assert.equal(result.mode, mode, label);
      const { input_bar: bar, status } = result.reserved;
      for (const [index, box] of result.boxes.entries()) {
        assert(
          box.rect.width > 0 && box.rect.height > 0,
          `${label} ${box.item_id}`,
        );
        assert(box.rect.x >= 24, `${label} ${box.item_id} left`);
        assert(box.rect.y >= 24, `${label} ${box.item_id} top`);
        assert(
          box.rect.x + box.rect.width <= status.x - 24,
          `${label} ${box.item_id} status`,
        );
        assert(!overlaps(box.rect, bar), `${label} ${box.item_id} input bar`);
        assert(!overlaps(box.rect, status), `${label} ${box.item_id} status`);
        assert(
          !overlaps(box.rect, result.shelf.rect),
          `${label} ${box.item_id} shelf`,
        );
        for (const other of result.boxes.slice(index + 1))
          assert(
            !overlaps(box.rect, other.rect),
            `${label} ${box.item_id} × ${other.item_id}`,
          );
      }
      assert(!overlaps(result.shelf.rect, bar), `${label} shelf × bar`);
      assert(!overlaps(result.shelf.rect, status), `${label} shelf × status`);
      assert(result.shelf.rect.y + result.shelf.rect.height <= height, label);
      // 棚の上の端も作業領域の中。
      assert(result.shelf.rect.y >= 0, `${label} shelf top`);
      assert.equal(result.shelf.compact, false, label);
      // 見える物はすべて、置かれるか入りきらない物のどちらか 1 回（読む順のまま）。
      const visible = MIXED.filter((entry) => entry.placement === 'canvas').map(
        (entry) => entry.item_id,
      );
      assert.deepEqual(result.reading_order, visible, label);
      assert.deepEqual(
        [...result.boxes.map((box) => box.item_id), ...result.overflow].sort(),
        [...visible].sort(),
        label,
      );
      assert.deepEqual(result.shelf.items, ['shelf1'], label);
    }
});

test('several displays: each display gets its own complete layout from its own size (the engine sees one canvas at a time)', () => {
  // 3 つの画面の大きさ（主 1920 × 1080・1280 × 800・縦置き 1080 × 1920）。どれも同じ記述から決まった結果になる。
  const displays = [
    { width: 1920, height: 1080, mode: 'grid', rows: 11 },
    { width: 1280, height: 800, mode: 'grid', rows: 7 },
    { width: 1080, height: 1920, mode: 'grid', rows: 20 },
  ];
  for (const display of displays) {
    const result = layout(MIXED, { viewport: display });
    assert.equal(result.mode, display.mode, `${display.width}`);
    // 行の数 = floor((高さ − 88 − 16 − 24 + 16) / 88)。
    assert.equal(result.grid.rows, display.rows, `${display.width}`);
    assert.deepEqual(layout(MIXED, { viewport: display }), result);
  }
});

test('the same input always gives the same result, whatever the order of the items array', () => {
  const first = layout(MIXED);
  const reversed = layoutCanvas({
    items: [...MIXED].reverse(),
    reading_order: MIXED.filter((entry) => entry.placement === 'canvas').map(
      (entry) => entry.item_id,
    ),
    user_pins: [],
    held: null,
    viewport: { width: 1280, height: 800 },
  });
  assert.deepEqual(reversed.boxes, first.boxes);
  assert.deepEqual(reversed.overflow, first.overflow);
  assert.deepEqual(layout(MIXED), first);
});

test('a dragged point snaps to the top-left cell of the grid and stays inside it', () => {
  const grid = layout([item('a')]).grid;
  // 列 3 の左端 24 + 2 × 98 = 220、行 2 の上端 24 + 88 = 112。少しずれても近いマスへ。
  assert.deepEqual(
    canvasCellAt(grid, { x: 230, y: 100 }, { span: 4, rows: 2 }),
    { column: 3, row: 2, span: 4, rows: 2 },
  );
  // 右下の外は、幅 4・行 2 が入る最後のマス（列 9・行 6）。
  assert.deepEqual(
    canvasCellAt(grid, { x: 5000, y: 5000 }, { span: 4, rows: 2 }),
    { column: 9, row: 6, span: 4, rows: 2 },
  );
  assert.deepEqual(
    canvasCellAt(grid, { x: -500, y: -500 }, { span: 4, rows: 2 }),
    { column: 1, row: 1, span: 4, rows: 2 },
  );
});

test('related items take the place next to their partner before unrelated ones; with no room on the right they go to the left', () => {
  // 読む順は焦点・関係のない物・詳細だが、詳細（関係を持つ物）が先に焦点の右隣（列 7）を取る。
  const first = layout(
    [
      item('focus', { emphasis: 'high' }),
      item('plain', { grid: { column: 1, span: 4, rows: 2 } }),
      item('detail', {
        relations: [{ kind: 'detail_of', target: 'focus' }],
        grid: { column: 1, span: 3, rows: 2 },
      }),
    ],
    { order: ['focus', 'plain', 'detail'] },
  );
  assert.deepEqual(cellOf(first, 'focus'), cell(1, 1, 6, 4));
  assert.deepEqual(cellOf(first, 'detail'), cell(1, 7, 3, 2));
  // 関係のない物は焦点の右隣を望むが、詳細が取ったので最も近い空き（行 3・列 7）。
  assert.deepEqual(cellOf(first, 'plain'), cell(3, 7, 4, 2));
  assert.deepEqual(first.reading_order, ['focus', 'plain', 'detail']);
  // 相手が右の端（列 9 から 4 列）: 右に 4 列の幅がないので左隣（列 5）、行数は相手にそろえる。
  const left = layout([
    item('target', { grid: { column: 9, span: 4, rows: 3 } }),
    item('other', {
      relations: [{ kind: 'compare', target: 'target' }],
      grid: { column: 1, span: 4, rows: 1 },
    }),
  ]);
  assert.deepEqual(cellOf(left, 'target'), cell(1, 9, 4, 3));
  assert.deepEqual(cellOf(left, 'other'), cell(1, 5, 4, 3));
});

test('a card chosen from its overflow tag takes its place first; the others go to tags (1 column keeps the reading order on screen)', () => {
  // 480 × 800 の 1 列（置ける高さ 624 − 24 = 600）。札から d を選ぶ: d（248）→ a（16 + 160 → 424）→ b（16 + 248 → 688 は
  // 入らない）。並べる順は読む順なので a が上（y 24）、d がその下（y 24 + 160 + 16 = 200）。
  const items = [
    item('a', { grid: { column: 1, span: 4, rows: 2 } }),
    item('b', { emphasis: 'high', grid: { column: 1, span: 4, rows: 1 } }),
    item('c', { emphasis: 'low', grid: { column: 1, span: 4, rows: 3 } }),
    item('d', { grid: { column: 1, span: 4, rows: 3 } }),
    item('e', { emphasis: 'low' }),
  ];
  const narrow = layoutCanvas({
    items,
    reading_order: ['a', 'b', 'c', 'd', 'e'],
    viewport: { width: 480, height: 800 },
    revealed: 'd',
  });
  assert.deepEqual(
    narrow.boxes.map((box) => [box.item_id, box.rect.y, box.rect.height]),
    [
      ['a', 24, 160],
      ['d', 200, 248],
    ],
  );
  assert.deepEqual(narrow.overflow, ['b', 'c', 'e']);
  assert.deepEqual(narrow.reading_order, ['a', 'b', 'c', 'd', 'e']);
  // 格子: 5 つの焦点のうち h5 を選ぶと、h5 が先に左上（行 1・列 1）を取り、h4 が入りきらない物になる。
  const grid = layoutCanvas({
    items: ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) =>
      item(id, { emphasis: 'high' }),
    ),
    reading_order: ['h1', 'h2', 'h3', 'h4', 'h5'],
    viewport: { width: 1280, height: 800 },
    revealed: 'h5',
  });
  assert.deepEqual(cellOf(grid, 'h5'), cell(1, 1, 6, 4));
  assert.deepEqual(cellOf(grid, 'h1'), cell(1, 7, 6, 4));
  assert.deepEqual(cellOf(grid, 'h2'), cell(5, 1, 6, 3));
  assert.deepEqual(cellOf(grid, 'h3'), cell(5, 7, 6, 3));
  assert.deepEqual(grid.overflow, ['h4']);
  // 読む順（DOM の順）は記述のまま。
  assert.deepEqual(
    grid.boxes.map((box) => box.item_id),
    ['h1', 'h2', 'h3', 'h5'],
  );
  // 棚の物・ない物を選んでも何も変えない。
  assert.deepEqual(
    layoutCanvas({
      items,
      reading_order: ['a', 'b', 'c', 'd', 'e'],
      viewport: { width: 480, height: 800 },
      revealed: 'ghost',
    }).overflow,
    ['d', 'e'],
  );
});

test('below the minimum height (272) nothing is placed and the shelf becomes a small strip at the top of the work area', () => {
  for (const [width, height] of [
    [480, 100],
    [840, 100],
    [1280, 200],
    [1280, 271],
  ]) {
    const result = layout([item('a'), item('s', { placement: 'shelf' })], {
      viewport: { width, height },
    });
    const label = `${width}×${height}`;
    assert.equal(result.mode, 'minimal', label);
    assert.deepEqual(result.boxes, [], label);
    assert.deepEqual(result.overflow, ['a'], label);
    assert.equal(result.grid, null, label);
    // 小さな棚: 作業領域の上の端から 4 下、高さ 32、置ける幅いっぱい（幅 − 120）。
    assert.deepEqual(
      result.shelf,
      {
        rect: { x: 24, y: 4, width: width - 120, height: 32 },
        items: ['s'],
        compact: true,
      },
      label,
    );
  }
  // メニューバーの下（上 25）でも、棚の上の端は作業領域の中（25 + 4）。
  const inset = layout([item('a')], {
    viewport: { width: 1280, height: 250 },
    insets: { top: 25, right: 0, bottom: 0, left: 0 },
  });
  assert.equal(inset.mode, 'minimal');
  assert.equal(inset.shelf.rect.y, 29);
  // ちょうど 272 なら置ける: 格子 1 行（下端 272 − 88 − 16 = 168）、1 列でも 1 行分の物（72）が入る。
  const wide = layout([item('a', { grid: { column: 1, span: 4, rows: 1 } })], {
    viewport: { width: 1280, height: 272 },
  });
  assert.equal(wide.mode, 'grid');
  assert.equal(wide.grid.rows, 1);
  assert.deepEqual(cellOf(wide, 'a'), cell(1, 1, 4, 1));
  assert.deepEqual(wide.shelf.rect, { x: 24, y: 200, width: 304, height: 56 });
  const narrow = layout(
    [item('a', { emphasis: 'low', grid: { column: 1, span: 4, rows: 1 } })],
    { viewport: { width: 480, height: 272 } },
  );
  assert.equal(narrow.mode, 'column');
  assert.deepEqual(rectOf(narrow, 'a'), {
    x: 24,
    y: 24,
    width: 360,
    height: 72,
  });
  // 棚は入力バーの上（272 − 88 − 16 − 56 = 112）。
  assert.deepEqual(narrow.shelf.rect, {
    x: 24,
    y: 112,
    width: 360,
    height: 56,
  });
});

test('a card chosen from its tag is always shown at or above the minimum height: it shrinks, and user pins or a held card step aside', () => {
  // 1 列 480 × 400: 置ける高さ = (400 − 88 − 16 − 56 − 16) − 24 = 200。焦点 f は 3 行（248）では入らないので
  // 2 行（160）に縮めて見せる。a（160）は 160 + 16 + 160 = 336 > 200 なので札。
  const items = [
    item('a', { grid: { column: 1, span: 4, rows: 2 } }),
    item('f', { emphasis: 'high', grid: { column: 1, span: 4, rows: 3 } }),
  ];
  const plain = layoutCanvas({
    items,
    reading_order: ['a', 'f'],
    viewport: { width: 480, height: 400 },
  });
  assert.deepEqual(plain.overflow, ['f']);
  const shown = layoutCanvas({
    items,
    reading_order: ['a', 'f'],
    viewport: { width: 480, height: 400 },
    revealed: 'f',
  });
  assert.deepEqual(rectOf(shown, 'f'), {
    x: 24,
    y: 24,
    width: 360,
    height: 160,
  });
  assert.deepEqual(shown.overflow, ['a']);
  // 最小の高さ 272 では置ける高さ 72: 1 行（72）に縮めて見せる。
  const lowest = layoutCanvas({
    items,
    reading_order: ['a', 'f'],
    viewport: { width: 480, height: 272 },
    revealed: 'f',
  });
  assert.deepEqual(rectOf(lowest, 'f'), {
    x: 24,
    y: 24,
    width: 360,
    height: 72,
  });

  // 格子 1280 × 300（2 行）: ユーザーの置き場所 p が 12 列 × 2 行を埋めている。札から x を選ぶと、x を先に
  // （列 1・4 列 × 2 行）置き、p は同じ大きさで入らないので縮めて最も近い空き（行 1・列 5 から 8 列 × 1 行）へ下げる。
  const pinned = [
    item('p'),
    item('x', { grid: { column: 1, span: 4, rows: 2 } }),
  ];
  const pins = [
    { item_id: 'p', cell: { column: 1, row: 1, span: 12, rows: 2 } },
  ];
  const blocked = layout(pinned, {
    viewport: { width: 1280, height: 300 },
    pins,
  });
  assert.equal(blocked.grid.rows, 2);
  assert.deepEqual(blocked.overflow, ['x']);
  const stepped = layoutCanvas({
    items: pinned,
    reading_order: ['p', 'x'],
    user_pins: pins,
    viewport: { width: 1280, height: 300 },
    revealed: 'x',
  });
  assert.deepEqual(cellOf(stepped, 'x'), cell(1, 1, 4, 2));
  assert.deepEqual(cellOf(stepped, 'p'), cell(1, 5, 8, 1));
  assert.equal(stepped.boxes.find((box) => box.item_id === 'p').source, 'user');
  assert.deepEqual(stepped.overflow, []);

  // 格子 1280 × 272（1 行）: 守る物 h（ドラッグ中・送信中）が 12 列を埋めていても、選んだ x を最初に置き
  // （列 1・4 列 × 1 行）、h は縮めて行 1・列 5 から 8 列へ。
  const heldCase = layoutCanvas({
    items: [item('h'), item('x', { grid: { column: 1, span: 4, rows: 2 } })],
    reading_order: ['h', 'x'],
    held: { item_id: 'h', cell: { column: 1, row: 1, span: 12, rows: 1 } },
    viewport: { width: 1280, height: 272 },
    revealed: 'x',
  });
  assert.deepEqual(cellOf(heldCase, 'x'), cell(1, 1, 4, 1));
  assert.deepEqual(cellOf(heldCase, 'h'), cell(1, 5, 8, 1));
  assert.equal(
    heldCase.boxes.find((box) => box.item_id === 'h').source,
    'held',
  );

  // 最小の高さに満たない（1280 × 200）ときは見せない（物を置かない）。
  const minimal = layoutCanvas({
    items,
    reading_order: ['a', 'f'],
    viewport: { width: 1280, height: 200 },
    revealed: 'f',
  });
  assert.equal(minimal.mode, 'minimal');
  assert.deepEqual(minimal.boxes, []);
});

test('at every size from the minimum height up, any visible card chosen from the tags gets a box', () => {
  const visible = MIXED.filter((entry) => entry.placement === 'canvas').map(
    (entry) => entry.item_id,
  );
  for (const width of [480, 600, 840, 1024, 1280, 1920])
    for (const height of [272, 300, 400, 720])
      for (const id of visible) {
        const result = layoutCanvas({
          items: MIXED,
          reading_order: visible,
          viewport: { width, height },
          revealed: id,
        });
        assert(
          result.boxes.some((box) => box.item_id === id),
          `${width}×${height} ${id}`,
        );
      }
});
