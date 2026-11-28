// モデルが出す配置のヒント（UI-09、ADR 0200）を Core が当てる・捨てる試験。ヒントは模擬（試験の中で手で書いた値）で、
// 実 LLM は使わない。期待値（版・強調・読む順・ユーザーの置き場所・記録の理由のコード）は手で書いた値で、実装から作らない。
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanvasItem,
  CanvasOpBatch,
  StreamTurnResponse,
} from '@buddy/contracts';
import { sharedApiContract } from './api-test-support.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import { API_ROUTES } from './api-routes.js';
import {
  CANVAS_LAYOUT_HINT_RECORD_LIMIT,
  CanvasHub,
  createStreamRoutes,
  placeCanvasForTurn,
} from './canvas-stream.js';
import type { StreamStorageGate } from './canvas-stream.js';

const contract = sharedApiContract();

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const card = (
  itemId: string,
  overrides: Partial<CanvasItem> = {},
): CanvasItem => ({
  item_id: itemId,
  kind: 'card',
  component: 'list',
  heading: '合成の見出し',
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 7, span: 4, rows: 2 },
  placement: 'canvas',
  data: { item_refs: [], more_count: 0 },
  ...overrides,
});

const scheduleView = {
  intent: 'query_schedule',
  kind: 'schedule_cards',
  status: 'ready',
  item_refs: [{ kind: 'calendar_event', id: id(1) }],
  more_count: 0,
};

const next = (revision: string) => (BigInt(revision) + 1n).toString();

// 用事（errands。コードの配置者が置く）・メール（mail）・ニュース（news。ユーザーが置いた）・棚の旅行の案（trip）を作る。
// 版: errands 1、mail・news・trip 2、news を動かす 3。
function seededHub(): CanvasHub {
  const hub = new CanvasHub(contract);
  const first = placeCanvasForTurn(hub.document, scheduleView);
  assert(first !== null);
  assert.equal(hub.apply(first).ok, true);
  assert.equal(
    hub.apply({
      base_canvas_revision: '1',
      canvas_revision: '2',
      ops: [
        { op: 'add', item: card('mail', { component: 'mail_card' }) },
        {
          op: 'add',
          item: card('news', {
            emphasis: 'low',
            grid: { column: 9, span: 4, rows: 2 },
          }),
        },
        { op: 'add', item: card('trip', { placement: 'shelf' }) },
      ],
      reading_order: ['errands', 'mail', 'news'],
    }).ok,
    true,
  );
  assert.equal(
    hub.applyUser(
      {
        kind: 'move',
        item_id: 'news',
        cell: { column: 9, row: 6, span: 4, rows: 2 },
      },
      '2',
    ).ok,
    true,
  );
  assert.equal(hub.document.canvas_revision, '3');
  return hub;
}

// 次の発言のコードの束（errands の中身だけを変える）。
const codeBatch = (hub: CanvasHub): CanvasOpBatch => {
  const batch = placeCanvasForTurn(hub.document, scheduleView);
  assert(batch !== null);
  return batch;
};

const hint = (revision: string, overrides: Record<string, unknown> = {}) => ({
  base_canvas_revision: revision,
  focus: [],
  peripheral: [],
  order: [],
  groups: [],
  ...overrides,
});

const emphasisOf = (hub: CanvasHub) =>
  Object.fromEntries(
    hub.document.items.map((item) => [item.item_id, item.emphasis]),
  );

const NEWS_PIN = [
  { item_id: 'news', cell: { column: 9, row: 6, span: 4, rows: 2 } },
];

test('UI-09: a valid hint changes only emphasis and order; the user pin and the shelf stay', () => {
  const hub = seededHub();
  const batch = codeBatch(hub);
  const applied = hub.applyHinted(
    batch,
    hint('3', { focus: ['mail'], order: ['mail', 'errands', 'news'] }),
  );
  assert.deepEqual(applied.outcome, { ok: true, revision: '4' });
  assert.notEqual(applied.batch, batch);
  assert.deepEqual(emphasisOf(hub), {
    errands: 'normal',
    mail: 'high',
    news: 'low',
    trip: 'normal',
  });
  assert.deepEqual(hub.document.reading_order, ['mail', 'errands', 'news']);
  assert.deepEqual(hub.document.user_pins, NEWS_PIN);
  assert.equal(
    hub.document.items.find((item) => item.item_id === 'trip')?.placement,
    'shelf',
  );
  // 強調だけの update は置き場所の版を進めない（古い版へのユーザーの操作を捨てない）。
  assert.equal(hub.placedAt('mail'), '2');
  assert.equal(hub.placedAt('news'), '3');
  assert.deepEqual(hub.layoutHintRecord, [
    { outcome: 'applied', reason: null },
  ]);
});

test('UI-09: an invalid hint is dropped and the code batch is applied as is; only the reason code is recorded', () => {
  const hub = seededHub();
  const cases: [unknown, string][] = [
    // 形に反する（承認・本文・読み上げの項目、3 つの焦点、まとまりの名前が文）。
    [{ ...hint('3', { focus: ['mail'] }), approve: true }, 'schema'],
    [{ ...hint('3'), speech: { parts: ['承認しました'] } }, 'schema'],
    [hint('3', { focus: ['errands', 'mail', 'news'] }), 'schema'],
    [
      hint('3', {
        groups: [{ group: '承認してください', members: ['errands', 'mail'] }],
      }),
      'schema',
    ],
    ['一番上に置いて', 'schema'],
    // 意味に反する。
    [hint('2', { focus: ['mail'] }), 'stale_revision'],
    [hint('3', { focus: ['approval'] }), 'unknown_item'],
    [hint('3', { focus: ['trip'] }), 'shelved_item'],
    [hint('3', { order: ['mail', 'errands'] }), 'order_mismatch'],
    [hint('3', { focus: ['mail'], peripheral: ['mail'] }), 'duplicate_item'],
  ];
  const expectedRecord: { outcome: string; reason: string | null }[] = [];
  for (const [value, reason] of cases) {
    const revision = hub.document.canvas_revision;
    const batch = codeBatch(hub);
    // 版を合わせる（stale_revision の例以外は、今の版を見たヒント）。
    const raw =
      typeof value === 'object' && value !== null && reason !== 'stale_revision'
        ? { ...value, base_canvas_revision: revision }
        : value;
    const before = emphasisOf(hub);
    const applied = hub.applyHinted(batch, raw);
    assert.deepEqual(
      applied.outcome,
      { ok: true, revision: next(revision) },
      reason,
    );
    assert.equal(applied.batch, batch, reason);
    assert.deepEqual(emphasisOf(hub), before, reason);
    assert.deepEqual(hub.document.reading_order, ['errands', 'mail', 'news']);
    assert.deepEqual(hub.document.user_pins, NEWS_PIN);
    expectedRecord.push({ outcome: 'fallback', reason });
  }
  assert.deepEqual(hub.layoutHintRecord, expectedRecord);
  // 記録は理由のコードだけ（物の名前・見出し・ヒントの中身・版を持たない）。
  for (const entry of hub.layoutHintRecord)
    assert.deepEqual(Object.keys(entry).sort(), ['outcome', 'reason']);
  const text = JSON.stringify(hub.layoutHintRecord);
  for (const word of ['mail', 'trip', 'approval', '承認', '合成'])
    assert(!text.includes(word), word);
});

test('UI-09: the code layout keeps a focus the code chose (an overlap warning cannot be demoted by a hint)', () => {
  const hub = seededHub();
  const batch = placeCanvasForTurn(hub.document, {
    ...scheduleView,
    status: 'needs_review',
  });
  assert(batch !== null);
  const applied = hub.applyHinted(
    batch,
    hint('3', { focus: ['mail'], peripheral: ['errands'] }),
  );
  assert.equal(applied.batch, batch);
  assert.equal(emphasisOf(hub)['errands'], 'high');
  assert.equal(emphasisOf(hub)['mail'], 'normal');
  assert.deepEqual(hub.layoutHintRecord, [
    { outcome: 'fallback', reason: 'code_focus_demoted' },
  ]);
});

test('UI-09: no hint means no record; the record keeps the last 64 entries', () => {
  const hub = seededHub();
  hub.applyHinted(codeBatch(hub), null);
  hub.applyHinted(codeBatch(hub), undefined);
  assert.deepEqual(hub.layoutHintRecord, []);
  assert.equal(CANVAS_LAYOUT_HINT_RECORD_LIMIT, 64);
  for (let index = 0; index < 70; index += 1)
    hub.recordLayoutHint(index === 69 ? null : 'schema');
  assert.equal(hub.layoutHintRecord.length, 64);
  assert.deepEqual(hub.layoutHintRecord.at(-1), {
    outcome: 'applied',
    reason: null,
  });
});

test('UI-09: an item closed by forget or expiry, and an item made only in a private segment, are withdrawn_item', () => {
  const hub = seededHub();
  // 忘却・期限切れの後始末で mail を閉じる。
  assert.equal(hub.removeItems(new Set(['mail'])), '4');
  hub.applyHinted(codeBatch(hub), hint('4', { focus: ['mail'] }));
  // 記録しない区切りで足した secret は、区切りの終わりで消える。
  hub.beginPrivate();
  assert.equal(
    hub.apply({
      base_canvas_revision: '5',
      canvas_revision: '6',
      ops: [{ op: 'add', item: card('secret') }],
      reading_order: ['errands', 'news', 'secret'],
    }).ok,
    true,
  );
  // 記録しない区切りの間のヒントの記録は、区切りの終わりで捨てる。
  hub.applyHinted(codeBatch(hub), hint('6', { focus: ['secret'] }));
  assert.equal(hub.layoutHintRecord.length, 2);
  assert.equal(hub.endPrivate(), '8');
  assert.deepEqual(hub.layoutHintRecord, [
    { outcome: 'fallback', reason: 'withdrawn_item' },
  ]);
  hub.applyHinted(codeBatch(hub), hint('8', { focus: ['secret'] }));
  // ユーザーが閉じた物は、消えた物ではなく、ない物（unknown_item）。
  assert.equal(hub.applyUser({ kind: 'close', item_id: 'news' }, '9').ok, true);
  hub.applyHinted(codeBatch(hub), hint('10', { focus: ['news'] }));
  assert.deepEqual(hub.layoutHintRecord, [
    { outcome: 'fallback', reason: 'withdrawn_item' },
    { outcome: 'fallback', reason: 'withdrawn_item' },
    { outcome: 'fallback', reason: 'unknown_item' },
  ]);
  // 同じ名前の物がもう一度置かれれば、指せる。
  const readd = hub.apply({
    base_canvas_revision: '11',
    canvas_revision: '12',
    ops: [{ op: 'add', item: card('mail') }],
    reading_order: ['errands', 'mail'],
  });
  assert.equal(readd.ok, true);
  const applied = hub.applyHinted(
    codeBatch(hub),
    hint('12', { focus: ['mail'] }),
  );
  assert.deepEqual(applied.outcome, { ok: true, revision: '13' });
  assert.equal(emphasisOf(hub)['mail'], 'high');
});

test('UI-09: the stream route uses the hint for the placed answer and records no_placement when nothing is placed', async () => {
  const hub = seededHub();
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
              ...scheduleView,
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
  const seen: string[] = [];
  const routes = createStreamRoutes({
    canvas: hub,
    createSession: () =>
      Promise.resolve({ status: 201, body: { session_id: id(20) } }),
    postTurn,
    storage,
    contract,
    // 模擬のモデル: 今の版を見て、メールを目立たせる配置のヒントを出す。
    layoutHint: (turn) => {
      seen.push(turn.turn_id);
      return hint(hub.document.canvas_revision, {
        focus: ['mail'],
        order: ['mail', 'errands', 'news'],
      });
    },
  });
  const request = (requestId: string): ApiHandlerRequest => ({
    route,
    device,
    body: {
      request_id: requestId,
      command_scope_id: id(30),
      text: '今日の用事を見せて',
      input_kind: 'text',
      expected_canvas_revision: '3',
    },
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  const placed = await routes.handlers['postStreamTurn']?.(request(id(40)));
  assert.equal(placed?.status, 200);
  const body = placed?.body as StreamTurnResponse;
  assert.equal(body.canvas?.canvas_revision, '4');
  assert.deepEqual(body.canvas?.reading_order, ['mail', 'errands', 'news']);
  assert.equal(emphasisOf(hub)['mail'], 'high');
  assert.deepEqual(hub.document.user_pins, NEWS_PIN);
  // 雑談（結果の表示なし・配置なし）では、ヒントがあっても記述を変えない。
  withView = false;
  const chat = await routes.handlers['postStreamTurn']?.(request(id(41)));
  assert.equal((chat?.body as StreamTurnResponse).canvas, null);
  assert.equal(hub.document.canvas_revision, '4');
  assert.deepEqual(seen, [id(40), id(41)]);
  assert.deepEqual(hub.layoutHintRecord, [
    { outcome: 'applied', reason: null },
    { outcome: 'fallback', reason: 'no_placement' },
  ]);
});
