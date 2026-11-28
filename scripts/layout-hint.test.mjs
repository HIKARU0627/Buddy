// UI-09（Issue #101、ADR 0200）: モデルが出す配置のヒントの意味の検査・プロンプトインジェクションの評価セット・
// ヒントの有無での配置の回帰。期待値（結果・理由のコード・強調・読む順・まとまり・マス・ピクセル）は fixture と
// この試験に手で書いた値で、実装から作らない。実 LLM は使わない（評価セットのヒントは模擬のモデルの出力として手で書いた）。
// 見た目の回帰は配置のエンジンの出力（マスとピクセル）で確かめる。本物のブラウザ・実機の描画・Codex の見た目のレビューは
// 未実施（docs/ui/layout-hint.md）。
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANVAS_LAYOUT_HINT_FOCUS_LIMIT,
  CANVAS_LAYOUT_HINT_GROUP_LIMIT,
  CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX,
  CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN,
  CANVAS_LAYOUT_HINT_ORDER_LIMIT,
  CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT,
  applyCanvasBatch,
  applyCanvasLayoutHint,
  canvasLayoutOnlyChange,
  layoutCanvas,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

const { validators, schema } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/layout-hint-cases.json', root),
    'utf8',
  ),
);

// Core（CanvasHub.applyHinted）と同じ順の判定: 形 → 意味。形に反すれば理由は schema。
const judge = (entry) => {
  const batch = entry.batch ?? cases.base.batch;
  if (!validators['CanvasLayoutHint'](entry.hint))
    return { ok: false, reason: 'schema', batch };
  const result = applyCanvasLayoutHint({
    canvas: cases.base.canvas,
    batch,
    hint: entry.hint,
    withdrawn: new Set(entry.withdrawn ?? []),
  });
  return result.ok ? { ok: true, batch: result.batch } : { ...result, batch };
};

const documentOf = (batch) => {
  const result = applyCanvasBatch(cases.base.canvas, batch);
  assert(result.ok, JSON.stringify(result));
  return result.canvas;
};

const fieldMap = (document, field) =>
  Object.fromEntries(document.items.map((item) => [item.item_id, item[field]]));

test('the domain limits match the CanvasLayoutHint schema', () => {
  const hint = schema.$defs.CanvasLayoutHint.properties;
  const group = schema.$defs.CanvasLayoutHintGroup.properties;
  assert.equal(hint.focus.maxItems, CANVAS_LAYOUT_HINT_FOCUS_LIMIT);
  assert.equal(hint.peripheral.maxItems, CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT);
  assert.equal(hint.order.maxItems, CANVAS_LAYOUT_HINT_ORDER_LIMIT);
  assert.equal(hint.groups.maxItems, CANVAS_LAYOUT_HINT_GROUP_LIMIT);
  assert.equal(group.members.minItems, CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN);
  assert.equal(group.members.maxItems, CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX);
  // 手で書いた値（ADR 0200）。
  assert.deepEqual(
    [
      CANVAS_LAYOUT_HINT_FOCUS_LIMIT,
      CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT,
      CANVAS_LAYOUT_HINT_ORDER_LIMIT,
      CANVAS_LAYOUT_HINT_GROUP_LIMIT,
      CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN,
      CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX,
    ],
    [2, 12, 24, 4, 2, 12],
  );
  // ヒントには配置の候補の 5 つの項目しかない（承認・実行・処理状態・見出し・本文・読み上げの項目を持たない）。
  assert.deepEqual(Object.keys(hint).sort(), [
    'base_canvas_revision',
    'focus',
    'groups',
    'order',
    'peripheral',
  ]);
  assert.equal(schema.$defs.CanvasLayoutHint.additionalProperties, false);
  assert.equal(schema.$defs.CanvasLayoutHintGroup.additionalProperties, false);
});

test('evaluation set: every case ends as written (applied, or the code layout with the reason code)', () => {
  const results = [];
  for (const entry of cases.evaluation) {
    const judged = judge(entry);
    const outcome = judged.ok ? 'applied' : 'fallback';
    results.push([entry.id, outcome, judged.ok ? null : judged.reason]);
    assert.equal(outcome, entry.expected.outcome, entry.id);
    if (!judged.ok)
      assert.equal(judged.reason, entry.expected.reason, entry.id);
    // 形の検査を通さずに domain へ渡しても、ヒントは使われない。
    if (!entry.schema_valid && entry.domain_reason !== undefined) {
      const direct = applyCanvasLayoutHint({
        canvas: cases.base.canvas,
        batch: entry.batch ?? cases.base.batch,
        hint: entry.hint,
      });
      assert.deepEqual(
        direct,
        { ok: false, reason: entry.domain_reason },
        entry.id,
      );
    }
  }
  // 評価セットの集計（docs/ui/layout-hint.md に記録した値。手で数えた）。
  const count = (outcome) =>
    results.filter((entry) => entry[1] === outcome).length;
  assert.equal(results.length, 18);
  assert.equal(count('applied'), 4);
  assert.equal(count('fallback'), 14);
  const reasons = {};
  for (const [, , reason] of results)
    if (reason !== null) reasons[reason] = (reasons[reason] ?? 0) + 1;
  assert.deepEqual(reasons, {
    schema: 4,
    unknown_item: 1,
    code_focus_demoted: 1,
    shelved_item: 2,
    order_mismatch: 1,
    withdrawn_item: 2,
    stale_revision: 1,
    duplicate_item: 2,
  });
});

test('evaluation set: an applied hint changes only emphasis, groups and the reading order', () => {
  for (const entry of cases.evaluation.filter(
    (item) => item.expected.outcome === 'applied',
  )) {
    const judged = judge(entry);
    assert(judged.ok, entry.id);
    const code = documentOf(entry.batch ?? cases.base.batch);
    const hinted = documentOf(judged.batch);
    assert.deepEqual(fieldMap(hinted, 'emphasis'), entry.expected.emphasis);
    assert.deepEqual(fieldMap(hinted, 'group'), entry.expected.groups);
    assert.deepEqual(hinted.reading_order, entry.expected.reading_order);
    // 物の集合・見出し・部品・データの参照・関係・格子のヒント・置き場所（棚）・ユーザーの置き場所は、コードの配置と同じ。
    for (const field of [
      'kind',
      'component',
      'heading',
      'relations',
      'grid',
      'placement',
      'data',
    ])
      assert.deepEqual(
        fieldMap(hinted, field),
        fieldMap(code, field),
        `${entry.id} ${field}`,
      );
    assert.deepEqual(hinted.user_pins, [
      { item_id: 'news', cell: { column: 9, row: 6, span: 4, rows: 2 } },
    ]);
    assert.equal(hinted.canvas_revision, '8');
    assert.equal(canvasLayoutOnlyChange(code, hinted), true);
    // 束は add・update だけ。ヒントが足した update は強調・まとまりだけを変える。
    const codeTargets = new Set(
      (entry.batch ?? cases.base.batch).ops.map((op) => op.item_id),
    );
    for (const op of judged.batch.ops) {
      assert(op.op === 'add' || op.op === 'update', entry.id);
      if (op.op === 'update' && !codeTargets.has(op.item_id))
        for (const key of Object.keys(op.changes))
          assert(['emphasis', 'group'].includes(key), `${entry.id} ${key}`);
    }
    assert(validators['CanvasOpBatch'](judged.batch), entry.id);
  }
});

test('evaluation set: a rejected hint leaves exactly the code layout', () => {
  for (const entry of cases.evaluation.filter(
    (item) => item.expected.outcome === 'fallback',
  )) {
    const judged = judge(entry);
    assert.equal(judged.ok, false, entry.id);
    // 戻した後に当てる束は、コードの束そのもの。
    assert.equal(judged.batch, entry.batch ?? cases.base.batch, entry.id);
    const code = documentOf(judged.batch);
    // 読む順はコードの束のまま。
    assert.deepEqual(
      code.reading_order,
      (entry.batch ?? cases.base.batch).reading_order,
    );
  }
  // 重なりの確認（コードが high にした errands）を周辺へ回すヒントを捨てると、errands は high のまま。
  const hide = cases.evaluation.find(
    (item) => item.id === 'qa03-layout-hint-injection-hides-overlap',
  );
  assert.deepEqual(fieldMap(documentOf(hide.batch), 'emphasis'), {
    errands: 'high',
    mail: 'normal',
    news: 'low',
    trip: 'normal',
  });
});

test('the reason codes for limits, closed items, and a broken code batch', () => {
  const canvas = cases.base.canvas;
  const batch = cases.base.batch;
  const hint = (overrides) => ({
    base_canvas_revision: '7',
    focus: [],
    peripheral: [],
    order: [],
    groups: [],
    ...overrides,
  });
  const run = (overrides, extra = {}) =>
    applyCanvasLayoutHint({ canvas, batch, hint: hint(overrides), ...extra });
  // 束の元の版が記述と違えば、ヒントも stale_revision。
  assert.deepEqual(
    applyCanvasLayoutHint({
      canvas,
      batch: { ...batch, base_canvas_revision: '6', canvas_revision: '7' },
      hint: hint({ focus: ['mail'] }),
    }),
    { ok: false, reason: 'stale_revision' },
  );
  // コードの束そのものが当たらない（読む順の欠け）なら apply_rejected。
  assert.deepEqual(
    applyCanvasLayoutHint({
      canvas,
      batch: { ...batch, reading_order: ['errands', 'mail'] },
      hint: hint({ focus: ['mail'] }),
    }),
    { ok: false, reason: 'apply_rejected' },
  );
  // ユーザーが閉じた物（記述にない・消えた物の名前にもない）は unknown_item。
  assert.deepEqual(run({ focus: ['notes'] }), {
    ok: false,
    reason: 'unknown_item',
  });
  // 同じ名前でも今の記述にある物なら、消えた物の名前の一覧にあっても指せる（物の名前は使い回される）。
  assert.equal(
    run({ focus: ['mail'] }, { withdrawn: new Set(['mail']) }).ok,
    true,
  );
  // 読む順に同じ物を 2 回・まとまりの名前を 2 回。
  assert.deepEqual(run({ order: ['mail', 'mail', 'news'] }), {
    ok: false,
    reason: 'duplicate_item',
  });
  assert.deepEqual(
    run({
      groups: [
        { group: 'today', members: ['errands', 'mail'] },
        { group: 'today', members: ['news', 'news-2'] },
      ],
    }),
    { ok: false, reason: 'duplicate_item' },
  );
  // 上限（domain だけで使う呼び出し側のために重ねて確かめる）。
  assert.deepEqual(run({ groups: [{ group: 'one', members: ['mail'] }] }), {
    ok: false,
    reason: 'limit_exceeded',
  });
  // 何も変えないヒントは、コードの束と同じ操作で当たる（読む順もそのまま）。
  const same = run({});
  assert(same.ok);
  assert.deepEqual(same.batch.ops, batch.ops);
  assert.deepEqual(same.batch.reading_order, batch.reading_order);
});

test('a hint that would need more than 12 operations falls back (limit_exceeded)', () => {
  // 見える物 13 個（i0〜i12）。コードの束は i0 の中身だけを変える。ヒントは i1〜i12 を周辺へ回す（update が 12 個増える）。
  const names = Array.from({ length: 13 }, (_, index) => `i${index}`);
  const canvas = {
    canvas_revision: '3',
    items: names.map((name) => ({
      item_id: name,
      kind: 'card',
      component: 'list',
      heading: '合成',
      emphasis: 'normal',
      group: null,
      relations: [],
      grid: { column: 1, span: 4, rows: 1 },
      placement: 'canvas',
      data: { item_refs: [], more_count: 0 },
    })),
    reading_order: names,
  };
  const batch = {
    base_canvas_revision: '3',
    canvas_revision: '4',
    ops: [
      {
        op: 'update',
        item_id: 'i0',
        changes: { data: { item_refs: [], more_count: 0 } },
      },
    ],
    reading_order: names,
  };
  const hint = {
    base_canvas_revision: '3',
    focus: [],
    peripheral: names.slice(1),
    order: [],
    groups: [],
  };
  assert(validators['CanvasLayoutHint'](hint));
  assert.deepEqual(applyCanvasLayoutHint({ canvas, batch, hint }), {
    ok: false,
    reason: 'limit_exceeded',
  });
  // 11 個なら 12 操作に収まり、当たる。
  const fits = applyCanvasLayoutHint({
    canvas,
    batch,
    hint: { ...hint, peripheral: names.slice(1, 12) },
  });
  assert(fits.ok);
  assert.equal(fits.batch.ops.length, 12);
});

// 見た目の回帰（配置のエンジンの出力）。1280 × 800 の手計算（scripts/canvas-layout.test.mjs と同じ寸法）:
// 左 24・上 72、列の幅 88・送り 104、行の高さ 72・送り 88、行の数 7、見出しを読める最小の列の数 2。
// x = 24 + (列 − 1) × 104、幅 = 列の数 × 104 − 16、y = 72 + (行 − 1) × 88、高さ = 行数 × 88 − 16。
const layoutOf = (document, viewport) =>
  layoutCanvas({
    items: document.items,
    reading_order: document.reading_order,
    user_pins: document.user_pins ?? [],
    held: null,
    viewport,
  });

const boxesOf = (result) =>
  Object.fromEntries(
    result.boxes.map((box) => [
      box.item_id,
      { cell: box.cell, rect: box.rect, source: box.source },
    ]),
  );

const mailFirst = cases.evaluation.find(
  (item) => item.id === 'ui09-injection-mail-asks-to-be-first',
);

test('visual regression (grid 1280 × 800): without a hint the code layout, with the hint the mail card is the large focus and the pinned card stays', () => {
  const code = layoutOf(documentOf(cases.base.batch), {
    width: 1280,
    height: 800,
  });
  // コードの配置: errands は補助（1 行目の列 2、4 列 × 3 行）、mail は補助（焦点がないので 1 行目の列 7、4 列 × 2 行）、
  // news はユーザーの置き場所（6 行目の列 9）。
  assert.equal(code.mode, 'grid');
  assert.deepEqual(boxesOf(code), {
    errands: {
      cell: { row: 1, column: 2, span: 4, rows: 3 },
      rect: { x: 128, y: 72, width: 400, height: 248 },
      source: 'engine',
    },
    mail: {
      cell: { row: 1, column: 7, span: 4, rows: 2 },
      rect: { x: 648, y: 72, width: 400, height: 160 },
      source: 'engine',
    },
    news: {
      cell: { row: 6, column: 9, span: 4, rows: 2 },
      rect: { x: 856, y: 512, width: 400, height: 160 },
      source: 'user',
    },
  });
  assert.deepEqual(code.reading_order, ['errands', 'mail', 'news']);
  assert.deepEqual(code.shelf.items, ['trip']);

  const judged = judge(mailFirst);
  assert(judged.ok);
  const hinted = layoutOf(documentOf(judged.batch), {
    width: 1280,
    height: 800,
  });
  // ヒントの配置: mail は焦点（幅 6 以上・4 行以上に広げ、1 行目の列 7）、errands は焦点に接する左（列 3）、news は
  // ユーザーの置き場所のまま。読む順は mail → errands → news。棚は変わらない。
  assert.deepEqual(boxesOf(hinted), {
    errands: {
      cell: { row: 1, column: 3, span: 4, rows: 3 },
      rect: { x: 232, y: 72, width: 400, height: 248 },
      source: 'engine',
    },
    mail: {
      cell: { row: 1, column: 7, span: 6, rows: 4 },
      rect: { x: 648, y: 72, width: 608, height: 336 },
      source: 'engine',
    },
    news: {
      cell: { row: 6, column: 9, span: 4, rows: 2 },
      rect: { x: 856, y: 512, width: 400, height: 160 },
      source: 'user',
    },
  });
  assert.deepEqual(hinted.reading_order, ['mail', 'errands', 'news']);
  assert.deepEqual(hinted.shelf.items, ['trip']);
  assert.deepEqual(hinted.overflow, []);
});

test('visual regression (one column 600 × 800): the hint changes the order and pushes the last card to the overflow tags', () => {
  // 600 × 800 の手計算: 置ける幅 552（< 720 で 1 列）、上 72、棚は入力バーの上（y 640）、置ける下端 624、高さの余り 552。
  // 焦点は 3〜4 行（ヒントの行数 2 → 3 行 = 248）、補助はヒントの行数（1〜3 行）、周辺は 1 行（72）。
  const code = layoutOf(documentOf(cases.base.batch), {
    width: 600,
    height: 800,
  });
  assert.equal(code.mode, 'column');
  assert.deepEqual(boxesOf(code), {
    errands: {
      cell: null,
      rect: { x: 24, y: 72, width: 552, height: 248 },
      source: 'engine',
    },
    mail: {
      cell: null,
      rect: { x: 24, y: 336, width: 552, height: 160 },
      source: 'engine',
    },
    news: {
      cell: null,
      rect: { x: 24, y: 512, width: 552, height: 72 },
      source: 'engine',
    },
  });
  assert.deepEqual(code.overflow, []);
  const judged = judge(mailFirst);
  assert(judged.ok);
  const hinted = layoutOf(documentOf(judged.batch), {
    width: 600,
    height: 800,
  });
  // mail（焦点 248）→ errands（248）で 512、news（72）を足すと 600 > 552 なので news は入りきらない物。
  assert.deepEqual(boxesOf(hinted), {
    mail: {
      cell: null,
      rect: { x: 24, y: 72, width: 552, height: 248 },
      source: 'engine',
    },
    errands: {
      cell: null,
      rect: { x: 24, y: 336, width: 552, height: 248 },
      source: 'engine',
    },
  });
  assert.deepEqual(hinted.overflow, ['news']);
  assert.deepEqual(hinted.reading_order, ['mail', 'errands', 'news']);
});

test('visual regression: every rejected hint renders exactly the code layout at several sizes', () => {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
    { width: 600, height: 800 },
  ]) {
    for (const entry of cases.evaluation.filter(
      (item) => item.expected.outcome === 'fallback',
    )) {
      const judged = judge(entry);
      assert.equal(judged.ok, false);
      assert.deepEqual(
        layoutOf(documentOf(judged.batch), viewport),
        layoutOf(documentOf(entry.batch ?? cases.base.batch), viewport),
        `${entry.id} ${viewport.width}`,
      );
    }
  }
});

test('the screen never draws a group name (a hint group name cannot carry visible words)', async () => {
  const renderer = fileURLToPath(
    new URL('../apps/desktop/src/renderer/', import.meta.url),
  );
  const files = async (directory) =>
    (await readdir(directory, { withFileTypes: true })).flatMap((entry) =>
      entry.isDirectory()
        ? [join(directory, entry.name)]
        : /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
          ? [join(directory, entry.name)]
          : [],
    );
  const queue = [renderer];
  const sources = [];
  while (queue.length > 0) {
    const directory = queue.pop();
    for (const path of await files(directory))
      if (/\.tsx?$/u.test(path)) sources.push(path);
      else queue.push(path);
  }
  assert(sources.length > 10);
  for (const path of sources) {
    const text = await readFile(path, 'utf8');
    assert(!/\.group\b/u.test(text), path);
  }
});
