// モデルが出す配置のヒント（UI-09、ADR 0200）を Core が当てる・捨てる試験と、プロンプトインジェクションの評価セットの実行。
// 評価セット（packages/contracts/fixtures/layout-hint-cases.json）の各例を CanvasHub.applyHinted に通し、その後の
// hub.document を手で書いた期待値（強調・読む順・まとまり・記録の理由のコード）と比べ、配置のエンジンでも描いて比べる。
// ヒントは模擬（手で書いた値）で、実 LLM は使わない。期待値は手で書いた値で、実装から作らない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  CanvasDocument,
  CanvasItem,
  CanvasOp,
  CanvasOpBatch,
  ResponsePlan,
  StreamTurnResponse,
} from '@buddy/contracts';
import { canvasLayoutOnlyChange, layoutCanvas } from '@buddy/domain';
import { sharedApiContract } from './api-test-support.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import { API_ROUTES } from './api-routes.js';
import {
  CANVAS_LAYOUT_HINT_RECORD_LIMIT,
  CanvasHub,
  admitLayoutHint,
  createStreamRoutes,
  placeCanvasForTurn,
} from './canvas-stream.js';
import type { StreamStorageGate } from './canvas-stream.js';

const contract = sharedApiContract();

interface Expected {
  readonly outcome: 'applied' | 'fallback' | 'none';
  readonly reason?: string;
  readonly emphasis: Record<string, string>;
  readonly reading_order: string[];
  readonly groups?: Record<string, string>;
}

interface Turn {
  readonly code?: 'review';
  readonly ops?: (string | Record<string, unknown>)[];
  readonly reading_order?: string[];
  readonly schema_valid?: boolean;
  readonly hint: unknown;
  readonly expected: Expected;
}

interface Case {
  readonly id: string;
  readonly before?: {
    readonly canvas_revision?: string;
    readonly extra_items?: string[];
    readonly reading_order?: string[];
    readonly steps?: Record<string, unknown>[];
  };
  readonly turns: Turn[];
}

const cases = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/contracts/fixtures/layout-hint-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  base: {
    canvas: CanvasDocument;
    ops: CanvasOp[];
    review_ops: CanvasOp[];
    items: Record<string, CanvasItem>;
  };
  evaluation: Case[];
};
const base = cases.base;

const next = (revision: string) => (BigInt(revision) + 1n).toString();

const opOf = (op: string | Record<string, unknown>): CanvasOp => {
  if (op === 'base') return base.ops[0] as CanvasOp;
  if (typeof op === 'string') throw new Error(op);
  if (op['op'] === 'add' && typeof op['item'] === 'string')
    return { op: 'add', item: base.items[op['item']] as CanvasItem };
  return op as unknown as CanvasOp;
};

const batchFor = (
  hub: CanvasHub,
  ops: CanvasOp[],
  readingOrder?: string[],
): CanvasOpBatch => ({
  base_canvas_revision: hub.document.canvas_revision,
  canvas_revision: next(hub.document.canvas_revision),
  ops: ops as CanvasOpBatch['ops'],
  reading_order: readingOrder ?? [...hub.document.reading_order],
});

// 例の始めの記述と、発言の前の手順（忘却・記録しない区切り）を当てた hub。
function prepared(entry: Case): CanvasHub {
  const before = entry.before ?? {};
  const canvas: CanvasDocument = {
    ...base.canvas,
    canvas_revision: before.canvas_revision ?? base.canvas.canvas_revision,
    items: [
      ...base.canvas.items,
      ...(before.extra_items ?? []).map((name) => base.items[name]),
    ] as CanvasDocument['items'],
    reading_order: (before.reading_order ??
      base.canvas.reading_order) as CanvasDocument['reading_order'],
  };
  const hub = new CanvasHub(contract, canvas);
  for (const step of before.steps ?? []) {
    if ('forget' in step)
      assert.notEqual(
        hub.removeItems(new Set(step['forget'] as string[])),
        false,
      );
    else if ('begin_private' in step) hub.beginPrivate();
    else if ('end_private' in step) assert.notEqual(hub.endPrivate(), null);
    else if ('add' in step)
      assert.equal(
        hub.apply(
          batchFor(
            hub,
            [
              {
                op: 'add',
                item: base.items[step['add'] as string] as CanvasItem,
              },
            ],
            step['reading_order'] as string[],
          ),
        ).ok,
        true,
        entry.id,
      );
  }
  return hub;
}

const opsOf = (turn: Turn): CanvasOp[] =>
  turn.ops !== undefined
    ? turn.ops.map(opOf)
    : turn.code === 'review'
      ? base.review_ops
      : base.ops;

// 1 つの発言を当てる（hint を差し替えられる。null はヒントなし）。
const runTurn = (hub: CanvasHub, turn: Turn, hint: unknown) =>
  hub.applyHinted(batchFor(hub, opsOf(turn), turn.reading_order), hint);

const fieldOf = (document: CanvasDocument, field: 'emphasis' | 'group') =>
  Object.fromEntries(document.items.map((item) => [item.item_id, item[field]]));

test('UI-09 evaluation set: every turn through CanvasHub ends as written, and only emphasis, groups and order change', () => {
  const tally: Record<string, number> = {};
  let turns = 0;
  for (const entry of cases.evaluation) {
    const hub = prepared(entry);
    // ヒントのない同じ手順（コードの配置。別の hub で、ヒントだけを null にした入力）。
    const plain = prepared(entry);
    for (const [index, turn] of entry.turns.entries()) {
      const label = `${entry.id} #${index + 1}`;
      turns += 1;
      const recorded = hub.layoutHintRecord.length;
      const applied = runTurn(hub, turn, turn.hint);
      assert.equal(applied.outcome.ok, true, label);
      assert.equal(runTurn(plain, turn, null).outcome.ok, true, label);
      const { expected } = turn;
      const key =
        expected.outcome === 'fallback'
          ? `fallback:${String(expected.reason)}`
          : expected.outcome;
      tally[key] = (tally[key] ?? 0) + 1;
      // 記録: ヒントなしは記録しない。使った・戻したは理由のコードだけ。
      if (expected.outcome === 'none')
        assert.equal(hub.layoutHintRecord.length, recorded, label);
      else
        assert.deepEqual(
          hub.layoutHintRecord.at(-1),
          expected.outcome === 'applied'
            ? { outcome: 'applied', reason: null }
            : { outcome: 'fallback', reason: expected.reason },
          label,
        );
      // 当てた後の記述（手で書いた値）。
      const document = hub.document;
      assert.deepEqual(fieldOf(document, 'emphasis'), expected.emphasis, label);
      assert.deepEqual(document.reading_order, expected.reading_order, label);
      assert.deepEqual(
        fieldOf(document, 'group'),
        Object.fromEntries(
          document.items.map((item) => [
            item.item_id,
            expected.groups?.[item.item_id] ?? null,
          ]),
        ),
        label,
      );
      // 配置以外（物の集合・見出し・部品・データ・関係・格子のヒント・棚・ユーザーの置き場所）はヒントなしと同じ。
      assert.equal(
        canvasLayoutOnlyChange(plain.document, document),
        true,
        label,
      );
      assert.equal(
        document.canvas_revision,
        plain.document.canvas_revision,
        label,
      );
      // モデルが付けたまとまりの名前は、記述に入らない。
      if (typeof turn.hint === 'object' && turn.hint !== null) {
        const groups = (turn.hint as { groups?: { group: string }[] }).groups;
        for (const group of groups ?? [])
          assert(!JSON.stringify(document).includes(`"${group.group}"`), label);
      }
      // 1 発言だけの例で戻したときは、記述そのものがヒントなしと同じ。
      if (entry.turns.length === 1 && expected.outcome === 'fallback')
        assert.deepEqual(document, plain.document, label);
    }
  }
  // 評価セットの集計（docs/ui/layout-hint.md に記録した値。手で数えた）。
  assert.equal(turns, 34);
  assert.deepEqual(tally, {
    applied: 11,
    none: 1,
    'fallback:schema': 4,
    'fallback:unknown_item': 3,
    'fallback:protected_demoted': 3,
    'fallback:protected_moved': 2,
    'fallback:protected_grouped': 1,
    'fallback:focus_limit': 1,
    'fallback:shelved_item': 2,
    'fallback:order_mismatch': 1,
    'fallback:withdrawn_item': 1,
    'fallback:stale_revision': 2,
    'fallback:duplicate_item': 2,
  });
});

// 見た目の回帰（hub.document を配置のエンジンで描く）。1280 × 800 の手計算（scripts/canvas-layout.test.mjs と同じ寸法）:
// 左 24・上 72、列の送り 104、行の送り 88、行の数 7。x = 24 + (列 − 1) × 104、幅 = 列の数 × 104 − 16、
// y = 72 + (行 − 1) × 88、高さ = 行数 × 88 − 16。600 × 800 は 1 列（置ける幅 552、上 72、高さの余り 552）。
const layoutOf = (
  document: CanvasDocument,
  viewport: { width: number; height: number },
) =>
  layoutCanvas({
    items: document.items,
    reading_order: document.reading_order,
    user_pins: document.user_pins ?? [],
    held: null,
    viewport,
  });

const boxesOf = (result: ReturnType<typeof layoutCanvas>) =>
  Object.fromEntries(
    result.boxes.map((box) => [
      box.item_id,
      { cell: box.cell, rect: box.rect, source: box.source },
    ]),
  );

const caseOf = (id: string): Case => {
  const found = cases.evaluation.find((entry) => entry.id === id);
  assert(found !== undefined, id);
  return found;
};

test('UI-09 visual regression through the hub: the code layout without a hint, the mail focus with it, the pin stays', () => {
  const entry = caseOf('ui09-injection-mail-asks-to-be-first');
  const [turn] = entry.turns;
  assert(turn !== undefined);
  const plain = prepared(entry);
  runTurn(plain, turn, null);
  const hinted = prepared(entry);
  runTurn(hinted, turn, turn.hint);
  const grid = { width: 1280, height: 800 };
  assert.deepEqual(boxesOf(layoutOf(plain.document, grid)), {
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
  // mail は焦点（6 列 × 4 行）、errands は焦点の左の列 3、news はユーザーの置き場所のまま。
  assert.deepEqual(boxesOf(layoutOf(hinted.document, grid)), {
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
  // 1 列: ヒントなしは errands・mail・news（y 72・336・512）。ヒントありは mail（焦点 3 行 248）・errands（248）で、
  // news（72）を足すと 600 > 552 なので入りきらない物になる。
  const column = { width: 600, height: 800 };
  const plainColumn = layoutOf(plain.document, column);
  assert.deepEqual(
    plainColumn.boxes.map((box) => [box.item_id, box.rect.y, box.rect.height]),
    [
      ['errands', 72, 248],
      ['mail', 336, 160],
      ['news', 512, 72],
    ],
  );
  assert.deepEqual(plainColumn.overflow, []);
  const hintedColumn = layoutOf(hinted.document, column);
  assert.deepEqual(
    hintedColumn.boxes.map((box) => [box.item_id, box.rect.y, box.rect.height]),
    [
      ['mail', 72, 248],
      ['errands', 336, 248],
    ],
  );
  assert.deepEqual(hintedColumn.overflow, ['news']);
});

test('UI-09 visual regression: the overlap card kept as the focus stays where the code put it while another card is raised', () => {
  // 重なる予定の確認（errands。コードの焦点）があるとき、mail を焦点にするヒントは使うが、errands の箱は変わらない。
  const entry = caseOf('ui09-overlap-kept-while-another-focus');
  const [turn] = entry.turns;
  assert(turn !== undefined);
  const plain = prepared(entry);
  runTurn(plain, turn, null);
  const hinted = prepared(entry);
  runTurn(hinted, turn, turn.hint);
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1280, height: 600 },
    { width: 600, height: 800 },
    { width: 480, height: 600 },
  ]) {
    const was = layoutOf(plain.document, viewport).boxes.find(
      (box) => box.item_id === 'errands',
    );
    const now = layoutOf(hinted.document, viewport).boxes.find(
      (box) => box.item_id === 'errands',
    );
    assert.deepEqual(now?.rect, was?.rect, `${viewport.width}`);
  }
  // 1280 × 800: errands は焦点（6 列 × 4 行）で 1 行目の列 2。
  assert.deepEqual(
    layoutOf(hinted.document, { width: 1280, height: 800 }).boxes.find(
      (box) => box.item_id === 'errands',
    )?.cell,
    { row: 1, column: 2, span: 6, rows: 4 },
  );
});

test('UI-09 visual regression: every rejected one-turn case renders the same as the hub without a hint', () => {
  for (const entry of cases.evaluation.filter(
    (item) =>
      item.turns.length === 1 && item.turns[0]?.expected.outcome === 'fallback',
  )) {
    const [turn] = entry.turns;
    assert(turn !== undefined);
    const plain = prepared(entry);
    runTurn(plain, turn, null);
    const hinted = prepared(entry);
    runTurn(hinted, turn, turn.hint);
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1280, height: 800 },
      { width: 600, height: 800 },
    ])
      assert.deepEqual(
        layoutOf(hinted.document, viewport),
        layoutOf(plain.document, viewport),
        `${entry.id} ${viewport.width}`,
      );
  }
});

test('UI-09: the plan carries only a hint that passed the shape check; a bad hint becomes null and is recorded as schema', () => {
  const plan = (layoutHint: unknown): ResponsePlan =>
    ({
      schema: 'buddy.response-plan.v1',
      workflow_id: '00000000-0000-4000-8000-000000000a21',
      request_revision: '1',
      intent: 'query_schedule',
      outcome: 'done',
      view: {
        workflow_id: '00000000-0000-4000-8000-000000000a21',
        request_revision: '1',
        intent: 'query_schedule',
        kind: 'schedule_cards',
        status: 'ready',
        item_refs: [],
        more_count: 0,
        template_id: null,
        template_version: null,
      },
      facts: [],
      speech: null,
      layout_hint: layoutHint,
    }) as ResponsePlan;
  const good = {
    base_canvas_revision: '7',
    focus: ['mail'],
    peripheral: [],
    order: [],
    groups: [],
  };
  const bad = { ...good, approve: true };
  // 形の悪いヒントをそのまま入れると、計画全体が Schema に反する。
  assert.equal(contract.valid('ResponsePlan', plan(bad)), false);
  for (const [raw, rejected] of [
    [good, false],
    [bad, true],
    ['一番上に置いて', true],
    [null, false],
  ] as const) {
    const admitted = admitLayoutHint(contract, raw);
    assert.equal(admitted.rejected, rejected);
    assert.equal(admitted.hint, rejected || raw === null ? null : raw);
    assert(contract.valid('ResponsePlan', plan(admitted.hint)));
  }
  // Core は形の悪いヒントを schema として記録し、コードの配置で当てる。
  const hub = new CanvasHub(contract, base.canvas);
  hub.applyHinted(batchFor(hub, base.ops), bad);
  assert.deepEqual(hub.layoutHintRecord, [
    { outcome: 'fallback', reason: 'schema' },
  ]);
});

test('UI-09: a code batch that does not apply (stale or broken) records nothing about the hint', () => {
  const hub = new CanvasHub(contract, base.canvas);
  const hint = {
    base_canvas_revision: '7',
    focus: ['mail'],
    peripheral: [],
    order: [],
    groups: [],
  };
  const stale = { ...batchFor(hub, base.ops), base_canvas_revision: '6' };
  assert.equal(hub.applyHinted(stale, hint).outcome.ok, false);
  const broken = batchFor(hub, base.ops, ['errands', 'mail']);
  assert.equal(hub.applyHinted(broken, hint).outcome.ok, false);
  assert.deepEqual(hub.layoutHintRecord, []);
  assert.equal(hub.document.canvas_revision, '7');
});

test('UI-09: resets that do not fit in one batch follow in the next batch; the hint focus never stays', () => {
  // 見える物 14 個（i0〜i13）。1 回目のヒントは i1〜i10 を周辺へ回す（10 個まで）。2 回目のコードの束は i0・i11・i12 の中身を
  // 変える 3 操作で、戻す update 10 個と合わせると 13 > 12 なので、戻す update は続く束で当てる（版は 2 進む）。
  const names = Array.from({ length: 14 }, (_, index) => `i${index}`);
  const item = (name: string): CanvasItem => ({
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
  });
  const hub = new CanvasHub(contract, {
    canvas_revision: '1',
    items: names.map(item) as CanvasDocument['items'],
    reading_order: names as CanvasDocument['reading_order'],
  });
  const touch = (name: string): CanvasOp => ({
    op: 'update',
    item_id: name,
    changes: { data: { item_refs: [], more_count: 0 } },
  });
  const first = hub.applyHinted(batchFor(hub, [touch('i0')]), {
    base_canvas_revision: '1',
    focus: [],
    peripheral: names.slice(1, 11),
    order: [],
    groups: [],
  });
  assert.deepEqual(first.outcome, { ok: true, revision: '2' });
  assert.equal(first.batch.ops.length, 11);
  assert.equal(
    hub.document.items.filter((entry) => entry.emphasis === 'low').length,
    10,
  );
  const code = batchFor(hub, [touch('i0'), touch('i11'), touch('i12')]);
  const second = hub.applyHinted(code, null);
  assert.deepEqual(second.outcome, { ok: true, revision: '3' });
  assert.equal(second.batch, code);
  assert.equal(hub.document.canvas_revision, '4');
  assert.deepEqual(
    [...new Set(hub.document.items.map((entry) => entry.emphasis))],
    ['normal'],
  );
  // 11 個を周辺へ回すヒントは、変える物の数の上限（10）で戻す。
  assert.equal(
    hub.applyHinted(batchFor(hub, [touch('i0')]), {
      base_canvas_revision: '4',
      focus: ['i11'],
      peripheral: names.slice(1, 11),
      order: [],
      groups: [],
    }).outcome.ok,
    true,
  );
  assert.deepEqual(hub.layoutHintRecord.at(-1), {
    outcome: 'fallback',
    reason: 'limit_exceeded',
  });
});

test('UI-09: the hint record keeps only reason codes, at most 64, and the private segment record is dropped', () => {
  const hub = new CanvasHub(contract, base.canvas);
  hub.applyHinted(batchFor(hub, base.ops), {
    base_canvas_revision: '7',
    focus: ['approval'],
    peripheral: [],
    order: [],
    groups: [{ group: 'dentist-at-3pm', members: ['errands', 'mail'] }],
  });
  hub.beginPrivate();
  hub.applyHinted(batchFor(hub, base.ops), {
    base_canvas_revision: '8',
    focus: ['mail'],
    peripheral: [],
    order: [],
    groups: [],
  });
  assert.equal(hub.layoutHintRecord.length, 2);
  hub.endPrivate();
  assert.deepEqual(hub.layoutHintRecord, [
    { outcome: 'fallback', reason: 'unknown_item' },
  ]);
  for (const entry of hub.layoutHintRecord)
    assert.deepEqual(Object.keys(entry).sort(), ['outcome', 'reason']);
  const text = JSON.stringify(hub.layoutHintRecord);
  for (const word of ['mail', 'approval', 'dentist', '合成'])
    assert(!text.includes(word), word);
  assert.equal(CANVAS_LAYOUT_HINT_RECORD_LIMIT, 64);
  for (let index = 0; index < 70; index += 1)
    hub.recordLayoutHint(index === 69 ? null : 'schema');
  assert.equal(hub.layoutHintRecord.length, 64);
  assert.deepEqual(hub.layoutHintRecord.at(-1), {
    outcome: 'applied',
    reason: null,
  });
});

test('UI-09: the stream route uses the hint for the placed answer and records no_placement when nothing is placed', async () => {
  const hub = new CanvasHub(contract);
  const first = placeCanvasForTurn(hub.document, {
    intent: 'query_schedule',
    kind: 'schedule_cards',
    status: 'ready',
    item_refs: [],
    more_count: 0,
  });
  assert(first !== null);
  assert.equal(hub.apply(first).ok, true);
  assert.equal(
    hub.apply({
      base_canvas_revision: '1',
      canvas_revision: '2',
      ops: [{ op: 'add', item: base.canvas.items[1] as CanvasItem }],
      reading_order: ['errands', 'mail'],
    }).ok,
    true,
  );
  const id = (n: number) =>
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const device = { device_id: id(9) } as unknown as NonNullable<
    ApiHandlerRequest['device']
  >;
  const route = API_ROUTES.find(
    (entry) => entry.operationId === 'postStreamTurn',
  );
  assert(route !== undefined);
  let withView = true;
  const postTurn: ApiRouteHandler = (request) =>
    Promise.resolve({
      status: 200,
      body: {
        request_id: String(request.body?.['request_id']),
        session_id: id(20),
        turn_id: String(request.body?.['request_id']),
        input_id: id(22),
        workflow_id: id(23),
        status: 'answered',
        result_view: withView
          ? {
              workflow_id: id(23),
              request_revision: '1',
              intent: 'query_schedule',
              kind: 'schedule_cards',
              status: 'ready',
              item_refs: [],
              more_count: 0,
              template_id: null,
              template_version: null,
            }
          : null,
        reply_text: withView ? null : 'こんにちは',
      },
    });
  const storage: StreamStorageGate = {
    mode: 'normal',
    origin: () => ({ segment_generation: '1' }),
    enterPrivate: () => Promise.resolve({ ok: false, reason: 'closed' }),
    exitPrivate: () => Promise.resolve({ ok: false, reason: 'closed' }),
  };
  const routes = createStreamRoutes({
    canvas: hub,
    createSession: () =>
      Promise.resolve({ status: 201, body: { session_id: id(20) } }),
    postTurn,
    storage,
    contract,
    // 模擬のモデル: 今の版を見て、メールを目立たせて先に読ませるヒントを出す。
    layoutHint: () => ({
      base_canvas_revision: hub.document.canvas_revision,
      focus: ['mail'],
      peripheral: [],
      order: ['mail', 'errands'],
      groups: [],
    }),
  });
  const request = (requestId: string): ApiHandlerRequest => ({
    route,
    device,
    body: {
      request_id: requestId,
      command_scope_id: id(30),
      text: '今日の用事を見せて',
      input_kind: 'text',
      expected_canvas_revision: '2',
    },
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  const placed = await routes.handlers['postStreamTurn']?.(request(id(40)));
  const body = placed?.body as StreamTurnResponse;
  assert.equal(body.canvas?.canvas_revision, '3');
  assert.deepEqual(body.canvas?.reading_order, ['mail', 'errands']);
  assert.equal(
    hub.document.items.find((item) => item.item_id === 'mail')?.emphasis,
    'high',
  );
  withView = false;
  const chat = await routes.handlers['postStreamTurn']?.(request(id(41)));
  assert.equal((chat?.body as StreamTurnResponse).canvas, null);
  assert.equal(hub.document.canvas_revision, '3');
  assert.deepEqual(hub.layoutHintRecord, [
    { outcome: 'applied', reason: null },
    { outcome: 'fallback', reason: 'no_placement' },
  ]);
});
