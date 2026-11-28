// UI-09（Issue #101、ADR 0200）: モデルが出す配置のヒントの domain の規則の試験（守る物・コードの値へ戻すこと・
// まとまりの名前の付け直し・上限・配置以外が変わらないこと）。期待値は手で書いた値で、実装から作らない。
// 評価セットを Core（CanvasHub.applyHinted）に通す試験と、hub.document を配置のエンジンで描く見た目の回帰は
// apps/core/src/canvas-layout-hint.test.ts、画面に描く回帰は CanvasBoard.hint.dom.test.tsx（docs/ui/layout-hint.md）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CANVAS_LAYOUT_HINT_CHANGE_LIMIT,
  CANVAS_LAYOUT_HINT_CHECK_VIEWPORTS,
  CANVAS_LAYOUT_HINT_FOCUS_LIMIT,
  CANVAS_LAYOUT_HINT_GROUP_LIMIT,
  CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX,
  CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN,
  CANVAS_LAYOUT_HINT_ORDER_LIMIT,
  CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT,
  applyCanvasBatch,
  applyCanvasLayoutHint,
  canvasCodeLayoutBatch,
  canvasLayoutOnlyChange,
  decideCanvasTurnLayout,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

const { validators, schema } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/layout-hint-cases.json', root),
    'utf8',
  ),
);
const base = cases.base;
const codeBatch = {
  base_canvas_revision: '7',
  canvas_revision: '8',
  ops: base.ops,
  reading_order: ['errands', 'mail', 'news'],
};
const hint = (overrides) => ({
  base_canvas_revision: '7',
  focus: [],
  peripheral: [],
  order: [],
  groups: [],
  ...overrides,
});

test('the domain limits match the CanvasLayoutHint schema and the hand-written values', () => {
  const properties = schema.$defs.CanvasLayoutHint.properties;
  const group = schema.$defs.CanvasLayoutHintGroup.properties;
  assert.equal(properties.focus.maxItems, CANVAS_LAYOUT_HINT_FOCUS_LIMIT);
  assert.equal(
    properties.peripheral.maxItems,
    CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT,
  );
  assert.equal(properties.order.maxItems, CANVAS_LAYOUT_HINT_ORDER_LIMIT);
  assert.equal(properties.groups.maxItems, CANVAS_LAYOUT_HINT_GROUP_LIMIT);
  assert.equal(group.members.minItems, CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN);
  assert.equal(group.members.maxItems, CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX);
  assert.deepEqual(
    [
      CANVAS_LAYOUT_HINT_FOCUS_LIMIT,
      CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT,
      CANVAS_LAYOUT_HINT_ORDER_LIMIT,
      CANVAS_LAYOUT_HINT_GROUP_LIMIT,
      CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN,
      CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX,
      CANVAS_LAYOUT_HINT_CHANGE_LIMIT,
      CANVAS_LAYOUT_HINT_CHECK_VIEWPORTS.length,
    ],
    [2, 10, 24, 4, 2, 12, 10, 18],
  );
  // ヒントには配置の候補の 5 つの項目しかない（承認・実行・処理状態・見出し・本文・読み上げの項目を持たない）。
  assert.deepEqual(Object.keys(properties).sort(), [
    'base_canvas_revision',
    'focus',
    'groups',
    'order',
    'peripheral',
  ]);
  assert.equal(schema.$defs.CanvasLayoutHint.additionalProperties, false);
  assert.equal(schema.$defs.CanvasLayoutHintGroup.additionalProperties, false);
});

test('a hint that fails the shape check is not used by the domain either', () => {
  for (const entry of cases.evaluation)
    for (const turn of entry.turns)
      if (turn.domain_reason !== undefined) {
        assert.equal(validators['CanvasLayoutHint'](turn.hint), false);
        const decision = decideCanvasTurnLayout({
          canvas: base.canvas,
          batch: codeBatch,
          hint: turn.hint,
        });
        assert(decision.ok);
        assert.equal(decision.hint, turn.domain_reason, entry.id);
        assert.equal(decision.batch, codeBatch);
      }
});

test('the code values come back: a hinted emphasis or group is reset by the next code batch', () => {
  // 今の記述は mail が high・まとまり g1（前のヒント）。コードの値は mail が normal・まとまりなし。
  const canvas = {
    ...base.canvas,
    items: base.canvas.items.map((item) =>
      item.item_id === 'mail'
        ? { ...item, emphasis: 'high', group: 'g1' }
        : item,
    ),
  };
  const code = new Map([
    ['errands', { emphasis: 'normal', group: null }],
    ['mail', { emphasis: 'normal', group: null }],
    ['news', { emphasis: 'low', group: null }],
    ['trip', { emphasis: 'normal', group: null }],
  ]);
  const reset = canvasCodeLayoutBatch(canvas, codeBatch, code);
  assert(reset.ok);
  assert.deepEqual(reset.batch.ops, [
    ...base.ops,
    {
      op: 'update',
      item_id: 'mail',
      changes: { emphasis: 'normal', group: null },
    },
  ]);
  assert.deepEqual(reset.rest, []);
  assert.deepEqual(reset.code.get('errands'), {
    emphasis: 'normal',
    group: null,
  });
  // コードの束が強調を決めた物（errands を high）は、その値がコードの値になる。
  const review = canvasCodeLayoutBatch(
    canvas,
    { ...codeBatch, ops: base.review_ops },
    code,
  );
  assert(review.ok);
  assert.deepEqual(review.code.get('errands'), {
    emphasis: 'high',
    group: null,
  });
  // コードの束が当たらない（元の版が違う）なら ok でない（ヒントの問題ではない）。
  assert.deepEqual(
    canvasCodeLayoutBatch(base.canvas, {
      ...codeBatch,
      base_canvas_revision: '6',
      canvas_revision: '7',
    }),
    { ok: false },
  );
});

test('protected items: an order hint may reorder around them but never put a later item before one', () => {
  const withReply = {
    ...base.canvas,
    items: [...base.canvas.items, base.items.reply],
    reading_order: ['errands', 'mail', 'reply', 'news'],
  };
  const batch = { ...codeBatch, reading_order: withReply.reading_order };
  const protectedNames = new Set(['reply']);
  const run = (order) =>
    applyCanvasLayoutHint({
      canvas: withReply,
      batch,
      hint: hint({ order }),
      protected: protectedNames,
    });
  // reply より前の物どうしを入れ替える・前の物を後ろへ回すのはよい（reply は後ろへ下がらない）。
  assert.equal(run(['mail', 'errands', 'reply', 'news']).ok, true);
  assert.equal(run(['errands', 'reply', 'news', 'mail']).ok, true);
  // 後ろの news を reply より前に入れると、reply が下がる。
  assert.deepEqual(run(['news', 'errands', 'mail', 'reply']), {
    ok: false,
    reason: 'protected_moved',
  });
  // 守る物そのものを焦点にするのはよい（目立たせるだけ）。
  assert.equal(
    applyCanvasLayoutHint({
      canvas: withReply,
      batch,
      hint: hint({ focus: ['reply'] }),
      protected: protectedNames,
    }).ok,
    true,
  );
});

test('protected items: a focus that would push a protected card off or make it smaller is rejected (protected_overflow)', () => {
  // 1 列（480 × 600: 高さの余り 352）で a（1 行 72）・b（1 行 72）・reply（2 行 160）は 336 で入る。a を焦点にすると
  // a が 3 行（248）になり、reply は入りきらない。
  const card = (name, rows) => ({
    item_id: name,
    kind: 'card',
    component: 'list',
    heading: '合成',
    emphasis: 'normal',
    group: null,
    relations: [],
    grid: { column: 1, span: 4, rows },
    placement: 'canvas',
    data: { item_refs: [], more_count: 0 },
  });
  const canvas = {
    canvas_revision: '3',
    items: [card('a', 1), card('b', 1), { ...base.items.reply }],
    reading_order: ['a', 'b', 'reply'],
  };
  const batch = {
    base_canvas_revision: '3',
    canvas_revision: '4',
    ops: [
      {
        op: 'update',
        item_id: 'a',
        changes: { data: { item_refs: [], more_count: 0 } },
      },
    ],
    reading_order: ['a', 'b', 'reply'],
  };
  assert.deepEqual(
    applyCanvasLayoutHint({
      canvas,
      batch,
      hint: { ...hint({ focus: ['a'] }), base_canvas_revision: '3' },
      protected: new Set(['reply']),
    }),
    { ok: false, reason: 'protected_overflow' },
  );
  // 守る物がなければ、同じヒントは使う。
  assert.equal(
    applyCanvasLayoutHint({
      canvas,
      batch,
      hint: { ...hint({ focus: ['a'] }), base_canvas_revision: '3' },
    }).ok,
    true,
  );
});

test('group names from the model are replaced by g1 to g4 in the order of the hint', () => {
  const result = applyCanvasLayoutHint({
    canvas: base.canvas,
    batch: codeBatch,
    hint: hint({
      groups: [
        { group: 'call-the-bank', members: ['errands', 'mail'] },
        { group: 'news-later', members: ['news', 'errands-x'] },
      ],
    }),
  });
  // ない物（errands-x）を含むまとまりは unknown_item。1 つ目だけなら使う。
  assert.deepEqual(result, { ok: false, reason: 'unknown_item' });
  const one = applyCanvasLayoutHint({
    canvas: base.canvas,
    batch: codeBatch,
    hint: hint({
      groups: [{ group: 'call-the-bank', members: ['errands', 'mail'] }],
    }),
  });
  assert(one.ok);
  const two = applyCanvasLayoutHint({
    canvas: {
      ...base.canvas,
      items: [...base.canvas.items, base.items.reply],
      reading_order: ['errands', 'mail', 'news', 'reply'],
    },
    batch: {
      ...codeBatch,
      reading_order: ['errands', 'mail', 'news', 'reply'],
    },
    hint: hint({
      groups: [
        { group: 'call-the-bank', members: ['errands', 'mail'] },
        { group: 'news-later', members: ['news', 'reply'] },
      ],
    }),
  });
  assert(two.ok);
  const both = applyCanvasBatch(
    {
      ...base.canvas,
      items: [...base.canvas.items, base.items.reply],
      reading_order: ['errands', 'mail', 'news', 'reply'],
    },
    two.batch,
  );
  assert(both.ok);
  assert.deepEqual(
    Object.fromEntries(
      both.canvas.items.map((item) => [item.item_id, item.group]),
    ),
    { errands: 'g1', mail: 'g1', news: 'g2', trip: null, reply: 'g2' },
  );
  const document = applyCanvasBatch(base.canvas, one.batch);
  assert(document.ok);
  assert.deepEqual(
    Object.fromEntries(
      document.canvas.items.map((item) => [item.item_id, item.group]),
    ),
    { errands: 'g1', mail: 'g1', news: null, trip: null },
  );
  assert(!JSON.stringify(document.canvas).includes('call-the-bank'));
});

test('the reason codes for limits, closed items and the order of checks', () => {
  const run = (overrides, extra = {}) =>
    applyCanvasLayoutHint({
      canvas: base.canvas,
      batch: codeBatch,
      hint: hint(overrides),
      ...extra,
    });
  assert.deepEqual(run({ focus: ['notes'] }), {
    ok: false,
    reason: 'unknown_item',
  });
  assert.deepEqual(
    run({ focus: ['notes'] }, { withdrawn: new Set(['notes']) }),
    { ok: false, reason: 'withdrawn_item' },
  );
  assert.equal(
    run({ focus: ['mail'] }, { withdrawn: new Set(['mail']) }).ok,
    true,
  );
  assert.deepEqual(run({ order: ['mail', 'mail', 'news'] }), {
    ok: false,
    reason: 'duplicate_item',
  });
  assert.deepEqual(
    run({
      groups: [
        { group: 'today', members: ['errands', 'mail'] },
        { group: 'today', members: ['news', 'trip'] },
      ],
    }),
    { ok: false, reason: 'duplicate_item' },
  );
  assert.deepEqual(run({ groups: [{ group: 'one', members: ['mail'] }] }), {
    ok: false,
    reason: 'limit_exceeded',
  });
  // 版の違いは最初に確かめる。
  assert.deepEqual(run({ base_canvas_revision: '6', focus: ['notes'] }), {
    ok: false,
    reason: 'stale_revision',
  });
  // 何も変えないヒントは、コードの束と同じ操作で当たる。
  const same = run({});
  assert(same.ok);
  assert.deepEqual(same.batch.ops, codeBatch.ops);
  assert.deepEqual(same.batch.reading_order, codeBatch.reading_order);
});

test('a hint that changes more than 10 items falls back (limit_exceeded)', () => {
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
  const run = (focus, peripheral) =>
    applyCanvasLayoutHint({
      canvas,
      batch,
      hint: {
        base_canvas_revision: '3',
        focus,
        peripheral,
        order: [],
        groups: [],
      },
    });
  assert.deepEqual(run(['i11'], names.slice(1, 11)), {
    ok: false,
    reason: 'limit_exceeded',
  });
  const fits = run([], names.slice(1, 11));
  assert(fits.ok);
  assert.equal(fits.batch.ops.length, 11);
});

test('canvasLayoutOnlyChange compares everything but emphasis and group, and the user pins', () => {
  const after = applyCanvasBatch(base.canvas, codeBatch);
  assert(after.ok);
  const change = (patch) => ({
    ...after.canvas,
    items: after.canvas.items.map((item) =>
      item.item_id === 'mail' ? { ...item, ...patch } : item,
    ),
  });
  assert.equal(
    canvasLayoutOnlyChange(
      after.canvas,
      change({ emphasis: 'high', group: 'g1' }),
    ),
    true,
  );
  for (const patch of [
    { heading: '承認してください' },
    { placement: 'shelf' },
    { grid: { column: 1, span: 4, rows: 2 } },
    { data: { item_refs: [], more_count: 0 } },
    { relations: [{ kind: 'detail_of', target: 'errands' }] },
    { kind: 'float' },
    { extra: true },
  ])
    assert.equal(
      canvasLayoutOnlyChange(after.canvas, change(patch)),
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    canvasLayoutOnlyChange(after.canvas, { ...after.canvas, user_pins: [] }),
    false,
  );
});
