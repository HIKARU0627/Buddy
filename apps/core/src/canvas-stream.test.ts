// 流れへの発言とキャンバスの記述（UI-03、ADR 0032）の試験。Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬の
// KeyStore）、解釈は模擬（モデルを使わない）、provider は試験の中で作る合成の読み取り専用の模擬。期待値（版・操作・見出し・
// 件数・参照の並び）は手で書いた値で、配置者・キャンバスの実装から作らない。模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type {
  CanvasDocument,
  CanvasOpBatch,
  ResultView,
  StreamTurnResponse,
} from '@buddy/contracts';
import { createApiContract } from './api-contract.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import { API_ROUTES } from './api-routes.js';
import {
  CanvasHub,
  EMPTY_CANVAS,
  ERRANDS_ITEM_ID,
  createStreamRoutes,
  placeCanvasForTurn,
} from './canvas-stream.js';
import {
  bootstrap,
  eventsOf,
  getJson,
  insertDevice,
  openStream,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import type { TestDevice } from './api-test-support.js';
import type { ProviderEvent, ProviderReader } from './turn-ports.js';

const contract = createApiContract();

// 設計 09 §2 の時計（2026-10-05T09:00:00+09:00）。
const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';

// 合成の読み取り専用の provider。今日（2026-10-05）は ev-0〜ev-3 の 4 件で、ev-1 と ev-2 が重なる。ev-4 は翌日。
const EVENTS: ProviderEvent[] = [
  {
    event_id: 'ev-0',
    title: '合成の予定0',
    start: '2026-10-04T23:30:00+09:00',
    end: '2026-10-05T00:30:00+09:00',
  },
  {
    event_id: 'ev-1',
    title: '合成の予定1',
    start: '2026-10-05T09:30:00+09:00',
    end: '2026-10-05T10:30:00+09:00',
  },
  {
    event_id: 'ev-2',
    title: '合成の予定2',
    start: '2026-10-05T10:00:00+09:00',
    end: '2026-10-05T11:00:00+09:00',
  },
  {
    event_id: 'ev-3',
    title: '合成の予定3',
    start: '2026-10-05T11:00:00+09:00',
    end: '2026-10-05T12:00:00+09:00',
  },
  {
    event_id: 'ev-4',
    title: '合成の予定4',
    start: '2026-10-06T10:00:00+09:00',
    end: '2026-10-06T11:00:00+09:00',
  },
];

function mockProvider(
  events: readonly ProviderEvent[] = EVENTS,
): ProviderReader {
  return {
    connection: () =>
      Promise.resolve({
        provider: 'mock' as const,
        account_id: ACCOUNT,
        account_label: '合成の口座（user@example.com）',
        status: 'active' as const,
        access: 'read_write' as const,
      }),
    readPermission: (accountId) =>
      Promise.resolve(
        accountId === ACCOUNT
          ? {
              account_id: ACCOUNT,
              permission_revision: '1',
              scopes: ['mail.read', 'mail.labels'],
            }
          : null,
      ),
    readTarget: (remoteId) =>
      Promise.resolve(
        remoteId === 'mail-001'
          ? {
              remote_id: 'mail-001',
              source_revision: '7',
              mailbox: 'INBOX',
              labels: ['inbox'],
              subject: '合成の件名',
              sender: 'sender@example.com',
              received_at: '2026-10-04T18:30:00+09:00',
            }
          : null,
      ),
    listEvents: () => Promise.resolve(events),
  };
}

async function startCanvasCore(
  t: test.TestContext,
  events?: readonly ProviderEvent[],
): Promise<EventCore> {
  return startEventCore(t, {
    previewValid: false,
    now: () => CLOCK,
    turns: {
      provider: mockProvider(events),
      candidates: {
        mailCandidates: () =>
          Promise.resolve([
            { candidate_id: MAIL_CANDIDATE, remote_id: 'mail-001' },
          ]),
      },
      utcOffset: '+09:00',
    },
  });
}

const postStream = async (
  core: EventCore,
  device: TestDevice,
  scope: string,
  text: string,
  options: {
    readonly requestId?: string;
    readonly expected?: string;
    readonly lockHeader?: string;
  } = {},
) => {
  const response = await postJson(core, device, '/v1/stream/turns', {
    request_id: options.requestId ?? randomUUID(),
    command_scope_id: scope,
    text,
    input_kind: 'text',
    expected_canvas_revision: options.expected ?? '0',
  });
  if (response.status === 200)
    assert(contract.valid('StreamTurnResponse', response.json), response.text);
  return response;
};

const canvasOf = async (core: EventCore, device: TestDevice) => {
  const response = await getJson(core, device, '/v1/canvas');
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('CanvasDocument', response.json), response.text);
  return response.json as unknown as CanvasDocument;
};

const view = (
  refs: readonly { kind: string; id: string }[],
  status: ResultView['status'] = 'ready',
  more = 0,
) => ({
  intent: 'query_schedule' as const,
  kind: 'schedule_cards' as const,
  status,
  item_refs: refs,
  more_count: more,
});

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

test('the placer builds one errands list card from a schedule answer, and only from that', () => {
  const refs = [
    { kind: 'calendar_event', id: id(1) },
    { kind: 'calendar_event', id: id(2) },
    // 重なりの参照は同じ予定を指すので、行には数えない（強調で表す）。
    { kind: 'calendar_overlap', id: id(2) },
  ];
  const batch = placeCanvasForTurn(EMPTY_CANVAS, view(refs, 'needs_review'));
  assert.deepEqual(batch, {
    base_canvas_revision: '0',
    canvas_revision: '1',
    ops: [
      {
        op: 'add',
        item: {
          item_id: 'errands',
          kind: 'card',
          component: 'list',
          heading: '今日の用事',
          emphasis: 'high',
          group: null,
          relations: [],
          grid: { column: 2, span: 4, rows: 3 },
          placement: 'canvas',
          data: {
            item_refs: [
              { kind: 'calendar_event', id: id(1) },
              { kind: 'calendar_event', id: id(2) },
            ],
            more_count: 0,
          },
        },
      },
    ],
    reading_order: ['errands'],
  });
  assert(contract.valid('CanvasOpBatch', batch));
  // 重なりがなければ強調しない。
  const calm = placeCanvasForTurn(EMPTY_CANVAS, view(refs.slice(0, 1)));
  assert.equal(
    (calm?.ops[0] as { item: { emphasis: string } }).item.emphasis,
    'normal',
  );
  // 予定の照会でなければ何も置かない（雑談・聞き返し・承認待ちの操作・結果なし）。
  assert.equal(placeCanvasForTurn(EMPTY_CANVAS, null), null);
  assert.equal(
    placeCanvasForTurn(EMPTY_CANVAS, {
      ...view([]),
      kind: 'approval_link' as never,
    }),
    null,
  );
  assert.equal(
    placeCanvasForTurn(EMPTY_CANVAS, {
      ...view([]),
      intent: 'label_mail' as never,
    }),
    null,
  );
});

test('the placer keeps at most 50 refs and carries more_count only when 50 are shown', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({
    kind: 'calendar_event',
    id: id(index + 1),
  }));
  const batch = placeCanvasForTurn(EMPTY_CANVAS, view(many, 'ready', 10));
  const item = (
    batch?.ops[0] as {
      item: { data: { item_refs: unknown[]; more_count: number } };
    }
  ).item;
  assert.equal(item.data.item_refs.length, 50);
  assert.equal(item.data.more_count, 10);
  // 50 件に満たないとき more_count は 0（形式の規則）。
  const few = placeCanvasForTurn(
    EMPTY_CANVAS,
    view(many.slice(0, 3), 'ready', 10),
  );
  assert.equal(
    (few?.ops[0] as { item: { data: { more_count: number } } }).item.data
      .more_count,
    0,
  );
});

test('a second schedule answer updates the card in place and keeps a shelved card on the shelf', () => {
  const hub = new CanvasHub(contract);
  const first = placeCanvasForTurn(
    hub.document,
    view([{ kind: 'calendar_event', id: id(1) }]),
  );
  assert(first !== null);
  assert.deepEqual(hub.apply(first), { ok: true, revision: '1' });
  const second = placeCanvasForTurn(
    hub.document,
    view([{ kind: 'calendar_event', id: id(2) }], 'needs_review'),
  );
  assert.deepEqual(second, {
    base_canvas_revision: '1',
    canvas_revision: '2',
    ops: [
      {
        op: 'update',
        item_id: 'errands',
        changes: {
          emphasis: 'high',
          data: {
            item_refs: [{ kind: 'calendar_event', id: id(2) }],
            more_count: 0,
          },
        },
      },
    ],
    reading_order: ['errands'],
  });
  assert(second !== null);
  assert.deepEqual(hub.apply(second), { ok: true, revision: '2' });
  assert.equal(hub.document.items.length, 1);
  // 本人が棚へ片付けた後（UI-06 の仕組みを模して move を当てる）。更新しても棚のまま、読む順も増えない。
  const shelved = hub.apply({
    base_canvas_revision: '2',
    canvas_revision: '3',
    ops: [{ op: 'move', item_id: ERRANDS_ITEM_ID, placement: 'shelf' }],
    reading_order: [],
  });
  assert.deepEqual(shelved, { ok: true, revision: '3' });
  const third = placeCanvasForTurn(hub.document, view([]));
  assert.deepEqual(third?.reading_order, []);
  assert(third !== null);
  assert.deepEqual(hub.apply(third), { ok: true, revision: '4' });
  assert.equal(hub.document.items[0]?.placement, 'shelf');
});

test('the hub applies only batches that pass the schema and the domain checks; the previous version stays and nobody is told', () => {
  const hub = new CanvasHub(contract);
  const told: string[] = [];
  const stop = hub.subscribe((revision) => told.push(revision));
  const good = placeCanvasForTurn(
    hub.document,
    view([{ kind: 'calendar_event', id: id(1) }]),
  ) as CanvasOpBatch;
  const item = (good.ops[0] as unknown as { item: Record<string, unknown> })
    .item;
  const withHeading = (heading: string): CanvasOpBatch => ({
    ...good,
    ops: [{ op: 'add', item: { ...item, heading } as never }],
  });
  const before = JSON.stringify(hub.document);
  // Schema 違反（見出しのマークアップ・制御文字・上限を超える長さ・説明文の項目）。
  for (const bad of [
    withHeading('<script>x</script>'),
    withHeading('今日\n用事'),
    withHeading('あ'.repeat(25)),
    {
      ...good,
      ops: [{ op: 'add', item: { ...item, description: '説明' } as never }],
    } as CanvasOpBatch,
  ])
    assert.deepEqual(hub.apply(bad), { ok: false, reason: 'schema' });
  // 意味の違反（版が連続しない・元の版が違う・読む順の欠け）。
  assert.deepEqual(hub.apply({ ...good, canvas_revision: '2' }), {
    ok: false,
    reason: 'semantic',
  });
  assert.deepEqual(
    hub.apply({ ...good, base_canvas_revision: '5', canvas_revision: '6' }),
    {
      ok: false,
      reason: 'semantic',
    },
  );
  assert.deepEqual(hub.apply({ ...good, reading_order: [] }), {
    ok: false,
    reason: 'semantic',
  });
  assert.equal(JSON.stringify(hub.document), before);
  assert.equal(hub.document.canvas_revision, '0');
  assert.deepEqual(told, []);
  // 正しい束は当たり、版だけが知らされる。
  assert.deepEqual(hub.apply(good), { ok: true, revision: '1' });
  assert.deepEqual(told, ['1']);
  // 同じ束をもう一度は元の版が合わず当たらない（物の重複も作らない）。
  assert.deepEqual(hub.apply(good), { ok: false, reason: 'semantic' });
  assert.equal(hub.document.items.length, 1);
  stop();
  assert.equal(hub.listenerCount, 0);
});

test('a throwing listener does not stop the others or the applied description', () => {
  const hub = new CanvasHub(contract);
  const told: string[] = [];
  hub.subscribe(() => {
    throw new Error('listener_failed');
  });
  hub.subscribe((revision) => told.push(revision));
  const good = placeCanvasForTurn(hub.document, view([])) as CanvasOpBatch;
  assert.deepEqual(hub.apply(good), { ok: true, revision: '1' });
  assert.deepEqual(told, ['1']);
});

test('a batch that fails the checks is not applied: the turn is still answered in text and the previous canvas stays', async () => {
  const hub = new CanvasHub(contract);
  const device = { device_id: id(9) } as unknown as NonNullable<
    ApiHandlerRequest['device']
  >;
  const route = (operationId: string) => {
    const found = API_ROUTES.find((entry) => entry.operationId === operationId);
    assert(found !== undefined);
    return found;
  };
  const turnResponse = (requestId: string) => ({
    request_id: requestId,
    session_id: id(20),
    turn_id: id(21),
    input_id: id(22),
    workflow_id: id(23),
    status: 'answered',
    result_view: {
      workflow_id: id(23),
      request_revision: '1',
      intent: 'query_schedule',
      kind: 'schedule_cards',
      status: 'ready',
      item_refs: [{ kind: 'calendar_event', id: id(1) }],
      more_count: 0,
      template_id: null,
      template_version: null,
    },
    reply_text: null,
  });
  const createSession: ApiRouteHandler = () =>
    Promise.resolve({ status: 201, body: { session_id: id(20) } });
  const postTurn: ApiRouteHandler = (request) =>
    Promise.resolve({
      status: 200,
      body: turnResponse(String(request.body?.['request_id'])),
    });
  const request = (requestId: string): ApiHandlerRequest => ({
    route: route('postStreamTurn'),
    device,
    body: {
      request_id: requestId,
      command_scope_id: id(30),
      text: '今日の用事を見せて',
      input_kind: 'text',
      expected_canvas_revision: '0',
    },
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  const told: string[] = [];
  hub.subscribe((revision) => told.push(revision));
  // 説明文の項目を持つ（Schema に反する）束を作る壊れた配置者。
  const broken = createStreamRoutes({
    canvas: hub,
    createSession,
    postTurn,
    contract,
    place: (canvas) => ({
      base_canvas_revision: canvas.canvas_revision,
      canvas_revision: '1',
      ops: [
        {
          op: 'add',
          item: {
            item_id: 'errands',
            description: '説明',
          } as never,
        },
      ],
      reading_order: ['errands'],
    }),
  });
  const failed = await broken.handlers['postStreamTurn']?.(request(id(40)));
  assert.equal(failed?.status, 200);
  assert.equal((failed?.body as StreamTurnResponse).canvas, null);
  assert.equal((failed?.body as StreamTurnResponse).status, 'answered');
  assert.equal(hub.document.canvas_revision, '0');
  assert.deepEqual(told, []);
  // 版が合わない束（意味の違反）も当てない。
  const stale = createStreamRoutes({
    canvas: hub,
    createSession,
    postTurn,
    contract,
    place: (canvas) =>
      placeCanvasForTurn(
        { ...canvas, canvas_revision: '9' },
        view([{ kind: 'calendar_event', id: id(1) }]),
      ),
  });
  const rejected = await stale.handlers['postStreamTurn']?.(request(id(41)));
  assert.equal((rejected?.body as StreamTurnResponse).canvas, null);
  assert.equal(hub.document.canvas_revision, '0');
  assert.deepEqual(told, []);
});

test(
  'UI-03: "今日の用事を見せて" through POST /v1/stream/turns places one errands card, tells subscribers only the revision, and GET /v1/canvas returns it',
  { timeout: 60_000 },
  async (t) => {
    const core = await startCanvasCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    // 空のキャンバス（版 0）。
    assert.deepEqual(await canvasOf(core, device), {
      canvas_revision: '0',
      items: [],
      reading_order: [],
    });
    // 購読を先に開く（開いた後の変更は必ず知らせが届く）。
    const snapshot = await getJson(core, device, '/v1/snapshot');
    const stream = openStream(
      t,
      core,
      device,
      String(snapshot.json?.['event_cursor']),
    );
    assert.deepEqual(await stream.opened, { ok: true });

    const requestId = randomUUID();
    const response = await postStream(
      core,
      device,
      scope,
      '今日の用事を見せて',
      {
        requestId,
      },
    );
    assert.equal(response.status, 200, response.text);
    const body = response.json as unknown as StreamTurnResponse;
    // 区切りは Core が選ぶ（最初の発言は stream_started。要約はつながない）。
    assert.equal(body.segment.open_reason, 'stream_started');
    assert.equal(body.segment.storage_mode, 'normal');
    assert.equal(body.segment.carried_summary, null);
    assert.equal(body.status, 'answered');
    assert.equal(body.result_view?.kind, 'schedule_cards');
    assert.equal(body.result_view?.status, 'needs_review');
    // 4 件の予定（ev-0〜ev-3。翌日の ev-4 は含めない）。重なる ev-1・ev-2 の参照が付く。
    const eventRefs = (body.result_view?.item_refs ?? []).filter(
      (ref) => ref.kind === 'calendar_event',
    );
    assert.equal(eventRefs.length, 4);
    // 配置者の束: 版 0 → 1、用事の list のカードを 1 枚 add。重なりがあるので強調。
    const batch = body.canvas;
    assert(batch !== null);
    assert.equal(batch.base_canvas_revision, '0');
    assert.equal(batch.canvas_revision, '1');
    assert.equal(batch.ops.length, 1);
    const op = batch.ops[0];
    assert(op?.op === 'add');
    assert.equal(op.item.item_id, 'errands');
    assert.equal(op.item.kind, 'card');
    assert.equal(op.item.component, 'list');
    assert.equal(op.item.heading, '今日の用事');
    assert.equal(op.item.emphasis, 'high');
    assert.equal(op.item.placement, 'canvas');
    assert.deepEqual(op.item.grid, { column: 2, span: 4, rows: 3 });
    assert.deepEqual(op.item.data.item_refs, eventRefs);
    assert.equal(op.item.data.more_count, 0);
    assert.deepEqual(batch.reading_order, ['errands']);

    // 読み取り: 同じ記述が版 1 で返る。
    const current = await canvasOf(core, device);
    assert.equal(current.canvas_revision, '1');
    assert.deepEqual(current.items, [op.item]);
    assert.deepEqual(current.reading_order, ['errands']);

    // 購読には版だけの知らせが届く（記述の本文・見出し・参照を含めない）。イベントの記録（cursor）には入らない。
    await stream.waitFor(
      (messages) => messages.some((message) => message.type === 'canvas'),
      'canvas notice',
    );
    const notices = stream.messages.filter(
      (message) => message.type === 'canvas',
    );
    assert.deepEqual(notices, [{ type: 'canvas', canvas_revision: '1' }]);
    assert.deepEqual(Object.keys(notices[0] ?? {}).sort(), [
      'canvas_revision',
      'type',
    ]);
    assert(!JSON.stringify(notices).includes('今日の用事'));
    assert.deepEqual(eventsOf(stream.messages), []);
    for (const message of stream.messages)
      assert(
        contract.valid('EventStreamMessage', message),
        JSON.stringify(message),
      );

    // 同じ要求の再送は、前の束をそのまま返し、もう一度配置しない（版は 1 のまま・知らせも増えない）。
    const again = await postStream(core, device, scope, '今日の用事を見せて', {
      requestId,
    });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(
      (again.json as unknown as StreamTurnResponse).canvas,
      batch,
    );
    assert.equal((await canvasOf(core, device)).canvas_revision, '1');
    // 内容が違う同じ request_id は 409。
    const conflict = await postStream(
      core,
      device,
      scope,
      '今日の予定を見せて',
      {
        requestId,
      },
    );
    assert.equal(conflict.status, 409, conflict.text);

    // 2 回目の別の要求は、端末の版が古くても（expected が 0）受け付け、Core の今の版から update で中身を更新する。
    const second = await postStream(core, device, scope, '今日の予定を見せて', {
      expected: '0',
    });
    const secondBody = second.json as unknown as StreamTurnResponse;
    assert.equal(secondBody.segment.segment_id, body.segment.segment_id);
    assert.equal(secondBody.canvas?.base_canvas_revision, '1');
    assert.equal(secondBody.canvas?.canvas_revision, '2');
    assert.equal(secondBody.canvas?.ops[0]?.op, 'update');
    const updated = await canvasOf(core, device);
    assert.equal(updated.canvas_revision, '2');
    assert.equal(updated.items.length, 1);
    await stream.waitFor(
      (messages) =>
        messages.filter((message) => message.type === 'canvas').length === 2,
      'second canvas notice',
    );
    assert.deepEqual(
      stream.messages
        .filter((message) => message.type === 'canvas')
        .map((message) => message.canvas_revision),
      ['1', '2'],
    );
  },
);

test(
  'UI-03: clarifications and approval links place nothing on the canvas (approval is never put on it)',
  { timeout: 60_000 },
  async (t) => {
    const core = await startCanvasCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const snapshot = await getJson(core, device, '/v1/snapshot');
    const stream = openStream(
      t,
      core,
      device,
      String(snapshot.json?.['event_cursor']),
    );
    assert.deepEqual(await stream.opened, { ok: true });
    // 知らない文は聞き返し（キャンバスは変えない）。
    const unclear = await postStream(core, device, scope, 'こんにちは');
    assert.equal(unclear.status, 200, unclear.text);
    const unclearBody = unclear.json as unknown as StreamTurnResponse;
    assert.equal(unclearBody.status, 'clarification');
    assert.equal(unclearBody.canvas, null);
    // 外部変更になる発言は承認待ちの操作を作るだけで、キャンバスには何も置かない。
    const label = await postStream(
      core,
      device,
      scope,
      'mail-001 に follow-up を付けて',
    );
    assert.equal(label.status, 200, label.text);
    const labelBody = label.json as unknown as StreamTurnResponse;
    assert.equal(labelBody.result_view?.kind, 'approval_link');
    assert.equal(labelBody.canvas, null);
    // 同じ区切り（会話は 1 つ）で、操作が 1 件できている。
    assert.equal(labelBody.segment.segment_id, unclearBody.segment.segment_id);
    const operations = (await getJson(core, device, '/v1/snapshot')).json?.[
      'operations'
    ] as unknown[];
    assert.equal(operations.length, 1);
    // 聞き返し・承認待ちの操作の後も、キャンバスは空のまま。
    assert.deepEqual(await canvasOf(core, device), EMPTY_CANVAS);
    // 固定の待ちは使わず、順序で確かめる。次に本物の変更（予定の照会）を行い、その知らせ（版 1）が届いた時点で、それより前に
    // キャンバスの知らせが 1 つも出ていないこと（WSS の送信は順番どおり）。
    const real = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(real.status, 200, real.text);
    await stream.waitFor(
      (messages) => messages.some((message) => message.type === 'canvas'),
      'first canvas notice',
    );
    assert.deepEqual(
      stream.messages.filter((message) => message.type === 'canvas'),
      [{ type: 'canvas', canvas_revision: '1' }],
    );
  },
);

test(
  'UI-03: the same checks as a conversation turn apply (token, home network, lock) and bad bodies are refused',
  { timeout: 60_000 },
  async (t) => {
    const core = await startCanvasCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const body = (overrides: Record<string, unknown> = {}) => ({
      request_id: randomUUID(),
      command_scope_id: scope,
      text: '今日の用事を見せて',
      input_kind: 'text',
      expected_canvas_revision: '0',
      ...overrides,
    });
    // 端末の声の入力（音声）は B06。受け付けない（既存の発言の処理と同じ）。
    const voice = await postJson(
      core,
      device,
      '/v1/stream/turns',
      body({ input_kind: 'voice_local' }),
    );
    assert.equal(voice.status, 503, voice.text);
    // 形式の違反。会話・区切りの ID・保存モードを送らない（余計な項目は 422）。
    for (const bad of [
      body({ session_id: randomUUID() }),
      body({ segment_id: randomUUID() }),
      body({ storage_mode: 'private' }),
      body({ text: '' }),
      body({ expected_canvas_revision: '01' }),
    ]) {
      const response = await postJson(core, device, '/v1/stream/turns', bad);
      assert.equal(response.status, 422, response.text);
    }
    const missing = body();
    delete (missing as Record<string, unknown>)['expected_canvas_revision'];
    assert.equal(
      (await postJson(core, device, '/v1/stream/turns', missing)).status,
      422,
    );
    // 認可: 古い接続範囲・ロック中・不明・自宅の外。
    assert.equal(
      (
        await postJson(
          core,
          device,
          '/v1/stream/turns',
          body({ command_scope_id: randomUUID() }),
        )
      ).status,
      410,
    );
    core.env.lock = 'locked';
    assert.equal(
      (await postJson(core, device, '/v1/stream/turns', body())).status,
      403,
    );
    assert.equal((await getJson(core, device, '/v1/canvas')).status, 403);
    core.env.lock = 'unknown';
    assert.equal((await getJson(core, device, '/v1/canvas')).status, 403);
    core.env.lock = 'unlocked';
    core.env.home = false;
    assert.equal(
      (await postJson(core, device, '/v1/stream/turns', body())).status,
      403,
    );
    assert.equal((await getJson(core, device, '/v1/canvas')).status, 403);
    core.env.home = true;
    // 認証なし。
    const anonymous = await openStream(t, core, null, null).opened;
    assert.equal(anonymous.ok, false);
    // 拒否した発言は何も配置していない。
    assert.deepEqual(await canvasOf(core, device), EMPTY_CANVAS);
  },
);

test(
  'UI-03: a schedule answer with more than 50 events keeps 50 refs and the remaining count',
  { timeout: 60_000 },
  async (t) => {
    const many: ProviderEvent[] = Array.from({ length: 53 }, (_, index) => ({
      event_id: `many-${index}`,
      title: `合成の予定${index}`,
      // 重ならない 10 分ずつの予定（今日の 0 時から 53 件。1 日に収まる）。
      start: new Date(
        Date.parse('2026-10-05T00:00:00+09:00') + index * 600_000,
      ).toISOString(),
      end: new Date(
        Date.parse('2026-10-05T00:00:00+09:00') + index * 600_000 + 600_000,
      ).toISOString(),
    }));
    const core = await startCanvasCore(t, many);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const response = await postStream(
      core,
      device,
      scope,
      '今日の用事を見せて',
    );
    assert.equal(response.status, 200, response.text);
    const body = response.json as unknown as StreamTurnResponse;
    const op = body.canvas?.ops[0];
    assert(op?.op === 'add');
    assert.equal(op.item.data.item_refs.length, 50);
    assert.equal(op.item.data.more_count, 3);
    // 重ならないので強調しない。
    assert.equal(op.item.emphasis, 'normal');
  },
);

test(
  'UI-03: a request replayed after the response cache evicted it is answered but never placed again',
  { timeout: 120_000 },
  async (t) => {
    const core = await startCanvasCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const firstId = randomUUID();
    const first = await postStream(core, device, scope, '今日の用事を見せて', {
      requestId: firstId,
    });
    const firstBody = first.json as unknown as StreamTurnResponse;
    assert.equal(firstBody.canvas?.canvas_revision, '1');
    // 応答のキャッシュの上限（256 件）を超えるまで、別の発言（聞き返し。配置なし）を送る。
    for (let index = 0; index < 260; index += 1) {
      const filler = await postStream(core, device, scope, 'こんにちは');
      assert.equal(filler.status, 200, filler.text);
    }
    // もう一度、現在の記述を版 2 にしておく（最初の束の参照へ戻されたことを見分けるため）。
    const second = await postStream(core, device, scope, '今日の予定を見せて');
    assert.equal(
      (second.json as unknown as StreamTurnResponse).canvas?.canvas_revision,
      '2',
    );
    const before = JSON.stringify(await canvasOf(core, device));
    // 最初の要求の再送: 保存済みの発言の応答（文字の結果）は同じで、もう一度配置しない（版も参照も変わらない）。
    const again = await postStream(core, device, scope, '今日の用事を見せて', {
      requestId: firstId,
    });
    assert.equal(again.status, 200, again.text);
    const againBody = again.json as unknown as StreamTurnResponse;
    assert.equal(againBody.turn_id, firstBody.turn_id);
    assert.deepEqual(againBody.result_view, firstBody.result_view);
    assert.equal(againBody.canvas, null);
    assert.equal(JSON.stringify(await canvasOf(core, device)), before);
    assert.equal((await canvasOf(core, device)).canvas_revision, '2');
  },
);
