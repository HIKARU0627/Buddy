// 流れへの発言とキャンバスの記述（UI-03、ADR 0032）の試験。Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬の
// KeyStore）、解釈は模擬（モデルを使わない）、provider は試験の中で作る合成の読み取り専用の模擬。期待値（版・操作・見出し・
// 件数・参照の並び）は手で書いた値で、配置者・キャンバスの実装から作らない。模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type {
  CanvasDocument,
  CanvasItem,
  CanvasOpBatch,
  ResultView,
  StreamTurnResponse,
} from '@buddy/contracts';
import { createApiContract } from './api-contract.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import { API_ROUTES } from './api-routes.js';
import type { DeviceRecord } from '@buddy/storage';
import {
  CanvasHub,
  EMPTY_CANVAS,
  ERRANDS_ITEM_ID,
  HELD_DROPPED_ITEM_ID,
  REPLY_ITEM_ID,
  createStreamRoutes,
  placeCanvasForTurn,
  placeHeldDropped,
  placeReplyForTurn,
} from './canvas-stream.js';
import { createLiveScreenSink } from './live-conversation.js';
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
  clock?: () => Date,
): Promise<EventCore> {
  return startEventCore(t, {
    previewValid: false,
    now: clock ?? (() => CLOCK),
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

// U120（ADR 0066）: 声で返せなかった文字の結果と保留の破棄を、キャンバスの text の物にする。本文は記述に載せず、
// content の経路でだけ返す。予定のカードと同じく、配置・意味の検査を通った束だけを当てる。
test('U120: a late result becomes one reusable text card and a held-dropped notice carries only the fixed phrase', () => {
  const turnOf = (turnId: string, text: string) => ({
    turn_id: turnId,
    status: 'clarification' as const,
    reply_text: text,
  });
  const first = placeReplyForTurn(
    EMPTY_CANVAS,
    turnOf(id(31), 'どちらですか。'),
  );
  assert(first !== null);
  assert.deepEqual(first.batch, {
    base_canvas_revision: '0',
    canvas_revision: '1',
    ops: [
      {
        op: 'add',
        item: {
          item_id: REPLY_ITEM_ID,
          kind: 'float',
          component: 'text',
          heading: '答え',
          emphasis: 'normal',
          group: null,
          relations: [],
          grid: { column: 9, span: 4, rows: 2 },
          placement: 'canvas',
          data: {
            item_refs: [{ kind: 'screen_result', id: id(31) }],
            more_count: 0,
          },
        },
      },
    ],
    reading_order: [REPLY_ITEM_ID],
  });
  assert.equal(first.text, 'どちらですか。');
  // 2 回目は同じ物の中身だけを更新する（物を増やさない。本文をとり直すための参照は進む）。
  const hub = new CanvasHub(contract);
  assert(hub.apply(first.batch).ok);
  hub.setText(first.item_id, first.text);
  const second = placeReplyForTurn(
    hub.document,
    turnOf(id(32), 'もう一度お願いします。'),
  );
  assert(second !== null);
  assert.deepEqual(second.batch.ops, [
    {
      op: 'update',
      item_id: REPLY_ITEM_ID,
      changes: {
        heading: '答え',
        emphasis: 'normal',
        data: {
          item_refs: [{ kind: 'screen_result', id: id(32) }],
          more_count: 0,
        },
      },
    },
  ]);
  assert.deepEqual(second.batch.reading_order, [REPLY_ITEM_ID]);
  // 保留を捨てた知らせは別の物。本文は固定の定型文で、捨てた依頼の本文を含めない。
  const held = placeHeldDropped(hub.document, {
    workflow_id: id(33),
    text: '実行前の依頼は実行していません。必要なら、もう一度お願いします。',
  });
  assert.deepEqual(held.batch.ops, [
    {
      op: 'add',
      item: {
        item_id: HELD_DROPPED_ITEM_ID,
        kind: 'float',
        component: 'text',
        heading: '実行前の依頼',
        emphasis: 'normal',
        group: null,
        relations: [],
        grid: { column: 5, span: 8, rows: 2 },
        placement: 'canvas',
        data: {
          item_refs: [{ kind: 'screen_result', id: id(33) }],
          more_count: 0,
        },
      },
    },
  ]);
  assert.equal(
    held.text,
    '実行前の依頼は実行していません。必要なら、もう一度お願いします。',
  );
  // 声で返すはずだった案内（Core が選んだ定型文）があれば、turn.reply_text より優先する。
  const chosen = placeReplyForTurn(
    EMPTY_CANVAS,
    turnOf(id(34), 'どこに保存しますか。'),
    undefined,
    '画面から全文を入力し直してください。',
  );
  assert.equal(chosen?.text, '画面から全文を入力し直してください。');
});

test('U120: the product screen sink reaches the canvas and the content route; the text stays out of the description', async () => {
  const hub = new CanvasHub(contract);
  const device = { device_id: id(9) } as unknown as NonNullable<
    ApiHandlerRequest['device']
  >;
  const route = (operationId: string) => {
    const found = API_ROUTES.find((entry) => entry.operationId === operationId);
    assert(found !== undefined);
    return found;
  };
  const createSession: ApiRouteHandler = () =>
    Promise.resolve({ status: 201, body: { session_id: id(20) } });
  const postTurn: ApiRouteHandler = () =>
    Promise.resolve({ status: 500, body: {} });
  const stream = createStreamRoutes({
    canvas: hub,
    createSession,
    postTurn,
    contract,
  });
  const logs: string[] = [];
  const sink = createLiveScreenSink({
    placeLate: (turn, text) => stream.placeLate(turn, text),
    placeNotice: (notice) => stream.placeNotice(notice),
    log: (message) => logs.push(message),
  });
  const turn = {
    request_id: id(40),
    session_id: id(20),
    turn_id: id(21),
    input_id: id(22),
    workflow_id: id(23),
    status: 'clarification',
    result_view: {
      workflow_id: id(23),
      request_revision: '1',
      intent: 'query_schedule',
      kind: 'clarification',
      status: 'confirming_input',
      item_refs: [],
      more_count: 0,
      template_id: null,
      template_version: null,
    },
    reply_text: 'どちらですか。',
  };
  sink.show({
    reason: 'live_closed',
    session_id: id(20),
    turn: turn as never,
    text: 'Core が選んだ案内。',
  });
  sink.heldDropped({
    session_id: id(20),
    workflow_id: id(33),
    reason: 'hold_expired',
  });
  assert.deepEqual(logs, []);
  const document = hub.document;
  assert.equal(document.canvas_revision, '2');
  assert.deepEqual(
    document.items.map((item) => item.item_id),
    [REPLY_ITEM_ID, HELD_DROPPED_ITEM_ID],
  );
  // 本文は記述に載らない。
  assert(!JSON.stringify(document).includes('Core が選んだ案内。'));
  assert(!JSON.stringify(document).includes('どちらですか。'));
  assert(!JSON.stringify(document).includes('実行前の依頼は実行していません'));
  const request = (
    requestId: string,
    itemId: string,
    revision: string,
  ): ApiHandlerRequest => ({
    route: route('postCanvasContent'),
    device,
    body: {
      request_id: requestId,
      expected_canvas_revision: revision,
      item_id: itemId,
      open_index: null,
    },
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  const reply = await stream.handlers['postCanvasContent']?.(
    request(id(41), REPLY_ITEM_ID, '2'),
  );
  assert.equal(reply?.status, 200);
  assert.deepEqual((reply?.body as { content: unknown }).content, {
    component: 'text',
    text: 'Core が選んだ案内。',
  });
  const held = await stream.handlers['postCanvasContent']?.(
    request(id(42), HELD_DROPPED_ITEM_ID, '2'),
  );
  assert.equal(held?.status, 200);
  assert.deepEqual((held?.body as { content: unknown }).content, {
    component: 'text',
    text: '実行前の依頼は実行していません。必要なら、もう一度お願いします。',
  });
});

test(
  'UI-05: 30 minutes without a turn opens a new segment and carries only the previous summary origin and expiry',
  { timeout: 60_000 },
  async (t) => {
    let at = new Date('2026-10-05T09:00:00+09:00');
    const core = await startCanvasCore(t, undefined, () => at);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const first = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(first.status, 200, first.text);
    const a = (first.json as unknown as StreamTurnResponse).segment;
    assert.equal(a.open_reason, 'stream_started');
    assert.equal(a.carried_summary, null);
    // 29 分 59 秒 999 ミリ秒では区切らない（同じ区切りで答える）。
    at = new Date('2026-10-05T09:29:59.999+09:00');
    const near = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(near.status, 200, near.text);
    assert.equal(
      (near.json as unknown as StreamTurnResponse).segment.segment_id,
      a.segment_id,
    );
    // 経過は最後のやりとりから測る（直前の発言からちょうど 30 分で切る）。
    at = new Date('2026-10-05T09:59:59.999+09:00');
    const next = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(next.status, 200, next.text);
    const b = (next.json as unknown as StreamTurnResponse).segment;
    assert.notEqual(b.segment_id, a.segment_id);
    assert.equal(b.open_reason, 'idle_timeout');
    assert.equal(b.storage_mode, 'normal');
    assert.equal(b.opened_at, '2026-10-05T00:59:59.999Z');
    // 1 回目の発言は 00:00:00Z。normal の期限は 7 日後（手で数えた値）。
    assert.deepEqual(b.carried_summary, {
      source_segment_ids: [a.segment_id],
      expires_at: '2026-10-12T00:00:00Z',
    });
    // 区切りをまたいでも、応答は同じ流れ（会話は Core の中だけ）。
    assert(contract.valid('StreamTurnResponse', next.json));
  },
);

test(
  'UI-05: a local date change opens a new segment before the 30 minutes are over',
  { timeout: 60_000 },
  async (t) => {
    let at = new Date('2026-10-05T23:50:00+09:00');
    const core = await startCanvasCore(t, undefined, () => at);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const first = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(first.status, 200, first.text);
    const a = (first.json as unknown as StreamTurnResponse).segment;
    // 23:59:59.999 は同じ日なので切らない。
    at = new Date('2026-10-05T23:59:59.999+09:00');
    const before = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(
      (before.json as unknown as StreamTurnResponse).segment.segment_id,
      a.segment_id,
    );
    // 0 時ちょうど（+09:00 では 15:00Z）で日付が変わる。
    at = new Date('2026-10-06T00:00:00+09:00');
    const next = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(next.status, 200, next.text);
    const b = (next.json as unknown as StreamTurnResponse).segment;
    assert.equal(b.open_reason, 'date_changed');
    assert.notEqual(b.segment_id, a.segment_id);
    // 1 回目の発言は 14:50Z。normal の期限は 7 日後。
    assert.deepEqual(b.carried_summary, {
      source_segment_ids: [a.segment_id],
      expires_at: '2026-10-12T14:50:00Z',
    });
  },
);

test(
  'UI-05: carried summaries keep the earliest origin across segments and are dropped once every source expired',
  { timeout: 60_000 },
  async (t) => {
    let at = new Date('2026-10-05T09:00:00+09:00');
    const core = await startCanvasCore(t, undefined, () => at);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const first = await postStream(core, device, scope, '今日の用事を見せて');
    const a = (first.json as unknown as StreamTurnResponse).segment;
    // 2 つ目の区切り（09:31）。由来は A だけ。
    at = new Date('2026-10-05T09:31:00+09:00');
    const second = await postStream(core, device, scope, '今日の用事を見せて');
    const b = (second.json as unknown as StreamTurnResponse).segment;
    assert.equal(b.open_reason, 'idle_timeout');
    assert.deepEqual(b.carried_summary, {
      source_segment_ids: [a.segment_id],
      expires_at: '2026-10-12T00:00:00Z',
    });
    // 3 つ目の区切り（10:02）。A の由来と期限を引き継ぎ、B を足す。期限は A の早い方のまま。
    at = new Date('2026-10-05T10:02:00+09:00');
    const third = await postStream(core, device, scope, '今日の用事を見せて');
    const c = (third.json as unknown as StreamTurnResponse).segment;
    assert.equal(c.open_reason, 'idle_timeout');
    assert.deepEqual(c.carried_summary, {
      source_segment_ids: [a.segment_id, b.segment_id],
      expires_at: '2026-10-12T00:00:00Z',
    });
    // A の発言の期限（2026-10-12T00:00:00Z）ちょうどでは、期限の切れた前の要約を材料にしない。
    // C の期限内の発言だけから作り直す（期限は C の発言の 7 日後）。接続範囲の期限（1 日）をまたぐので取り直す。
    at = new Date('2026-10-12T09:00:00+09:00');
    const scopeLater = await bootstrap(core, device);
    const fourth = await postStream(
      core,
      device,
      scopeLater,
      '今日の用事を見せて',
    );
    assert.equal(fourth.status, 200, fourth.text);
    const d = (fourth.json as unknown as StreamTurnResponse).segment;
    assert.equal(d.open_reason, 'idle_timeout');
    assert.deepEqual(d.carried_summary, {
      source_segment_ids: [c.segment_id],
      expires_at: '2026-10-12T01:02:00Z',
    });
  },
);

test('UI-05: when the new segment cannot be opened, the turn is not answered in the old segment', async () => {
  const canvas = new CanvasHub(contract);
  let at = Date.parse('2026-10-05T09:00:00+09:00');
  let sessions = 0;
  let turns = 0;
  const id = (n: number) =>
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const routes = createStreamRoutes({
    canvas,
    now: () => at,
    utcOffset: '+09:00',
    createSession: () => {
      sessions += 1;
      return Promise.resolve(
        sessions === 1
          ? { status: 201, body: { session_id: id(1) } }
          : {
              status: 503,
              body: { code: 'dependency_unavailable', retryable: true },
            },
      );
    },
    postTurn: (request) => {
      turns += 1;
      const body = request.body as Record<string, string>;
      return Promise.resolve({
        status: 200,
        body: {
          request_id: body['request_id'],
          session_id: request.params['session_id'],
          turn_id: id(100 + turns),
          input_id: id(200 + turns),
          workflow_id: null,
          status: 'answered',
          result_view: null,
          reply_text: null,
        },
      });
    },
  });
  const handler = routes.handlers['postStreamTurn'];
  assert(handler !== undefined);
  const route = API_ROUTES.find(
    (entry) => entry.operationId === 'postStreamTurn',
  );
  assert(route !== undefined);
  const device = { device_id: id(9) } as unknown as DeviceRecord;
  const request = (text: string): ApiHandlerRequest => ({
    route,
    device,
    body: {
      request_id: randomUUID(),
      command_scope_id: id(400),
      text,
      input_kind: 'text',
      expected_canvas_revision: '0',
    },
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  const first = await handler(request('こんにちは'));
  assert.equal(first.status, 200);
  // 30 分後: 区切りを始めるが、会話を作れない（503）。古い区切りで答えず、発言の処理もしない。
  at += 30 * 60_000;
  const second = await handler(request('こんにちは'));
  assert.equal(second.status, 503);
  assert.equal(
    (second.body as { code?: string }).code,
    'dependency_unavailable',
  );
  assert.equal(sessions, 2);
  assert.equal(turns, 1);
});

test(
  'UI-05: a resent request is answered in its original segment before any boundary is applied',
  { timeout: 60_000 },
  async (t) => {
    let at = new Date('2026-10-05T09:00:00+09:00');
    const core = await startCanvasCore(t, undefined, () => at);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const requestId = randomUUID();
    const first = await postStream(core, device, scope, '今日の用事を見せて', {
      requestId,
    });
    assert.equal(first.status, 200, first.text);
    const a = first.json as unknown as StreamTurnResponse;
    // 30 分ちょうどで、同じ要求を再送する。元の区切りで保存済みの応答を返し、区切りは切り替えない。
    at = new Date('2026-10-05T09:30:00+09:00');
    const replay = await postStream(core, device, scope, '今日の用事を見せて', {
      requestId,
    });
    assert.equal(replay.status, 200, replay.text);
    const replayed = replay.json as unknown as StreamTurnResponse;
    assert.equal(replayed.turn_id, a.turn_id);
    assert.equal(replayed.segment.segment_id, a.segment.segment_id);
    // 再送はやりとりに数えない。その後の新しい発言で、前の発言から 30 分の区切りが始まる。
    const fresh = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(fresh.status, 200, fresh.text);
    const b = (fresh.json as unknown as StreamTurnResponse).segment;
    assert.notEqual(b.segment_id, a.segment.segment_id);
    assert.equal(b.open_reason, 'idle_timeout');
    // 前の区切りを再送したときも同じ（元の応答を返し、今の区切りを返す）。
    at = new Date('2026-10-05T09:31:00+09:00');
    const again = await postStream(core, device, scope, '今日の用事を見せて', {
      requestId,
    });
    assert.equal(again.status, 200, again.text);
    const againBody = again.json as unknown as StreamTurnResponse;
    assert.equal(againBody.turn_id, a.turn_id);
    assert.equal(againBody.segment.segment_id, b.segment_id);
  },
);

test('UI-05: the expiry kept for a turn is the one saved with it, not the clock when the answer is built', async () => {
  const canvas = new CanvasHub(contract);
  let at = Date.parse('2026-10-05T09:00:00+09:00');
  let sessions = 0;
  let turns = 0;
  const id = (n: number) =>
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const routes = createStreamRoutes({
    canvas,
    now: () => at,
    utcOffset: '+09:00',
    createSession: () => {
      sessions += 1;
      return Promise.resolve({
        status: 201,
        body: { session_id: id(sessions) },
      });
    },
    postTurn: (request) => {
      turns += 1;
      const body = request.body as Record<string, string>;
      return Promise.resolve({
        status: 200,
        body: {
          request_id: body['request_id'],
          session_id: request.params['session_id'],
          turn_id: id(100 + turns),
          input_id: id(200 + turns),
          workflow_id: null,
          status: 'answered',
          result_view: null,
          reply_text: null,
        },
      });
    },
  });
  const handler = routes.handlers['postStreamTurn'];
  assert(handler !== undefined);
  const route = API_ROUTES.find(
    (entry) => entry.operationId === 'postStreamTurn',
  );
  assert(route !== undefined);
  const device = { device_id: id(9) } as unknown as DeviceRecord;
  const request = (): ApiHandlerRequest => ({
    route,
    device,
    body: {
      request_id: randomUUID(),
      command_scope_id: id(400),
      text: 'こんにちは',
      input_kind: 'text',
      expected_canvas_revision: '0',
    },
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  const first = await handler(request());
  assert.equal(first.status, 200);
  // 保存の時点で確定した期限（7 日後ではなく、保存の側が決めた値）。応答の後で時計が進んでも作り直さない。
  routes.recordTurn({
    session_id: id(1),
    turn_id: id(101),
    created_at: '2026-10-05T00:00:00Z',
    expires_at: '2026-10-06T00:00:00Z',
  });
  at += 31 * 60_000;
  const second = await handler(request());
  assert.equal(second.status, 200);
  const b = (second.body as unknown as StreamTurnResponse).segment;
  assert.equal(b.open_reason, 'idle_timeout');
  assert.deepEqual(b.carried_summary, {
    source_segment_ids: [id(1)],
    expires_at: '2026-10-06T00:00:00Z',
  });
});

test('UI-05: the replay lookup is keyed by the connection scope as well as the request id', async (t) => {
  const at = new Date('2026-10-05T09:00:00+09:00');
  const core = await startCanvasCore(t, undefined, () => at);
  const device = await insertDevice(core.handle.store);
  const firstScope = await bootstrap(core, device);
  const requestId = randomUUID();
  const first = await postStream(
    core,
    device,
    firstScope,
    '今日の用事を見せて',
    {
      requestId,
    },
  );
  assert.equal(first.status, 200, first.text);
  const firstBody = first.json as unknown as StreamTurnResponse;
  // 別の接続範囲で同じ要求 ID を使うのは、同じ要求の再送ではない（保存側の受付レシートは接続範囲と組で見る）。
  const secondScope = await bootstrap(core, device);
  const other = await postStream(core, device, secondScope, 'こんにちは', {
    requestId,
  });
  assert.equal(other.status, 200, other.text);
  const otherBody = other.json as unknown as StreamTurnResponse;
  assert.notEqual(otherBody.turn_id, firstBody.turn_id);
  assert.equal(otherBody.status, 'clarification');
});

test('UI-05: a new segment waits for a turn still being saved in the old segment', async () => {
  const canvas = new CanvasHub(contract);
  let at = Date.parse('2026-10-05T23:59:59+09:00');
  let sessions = 0;
  let turns = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const id = (n: number) =>
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const routes = createStreamRoutes({
    canvas,
    now: () => at,
    utcOffset: '+09:00',
    createSession: () => {
      sessions += 1;
      return Promise.resolve({
        status: 201,
        body: { session_id: id(sessions) },
      });
    },
    postTurn: async (request) => {
      turns += 1;
      const turn = turns;
      const sessionId = request.params['session_id'] as string;
      if (turn === 1) {
        // 保存が終わるまで待つ（日付をまたいだ後に区切りを切り替える側が、この発言の期限を待つ）。
        await gate;
        routes.recordTurn({
          session_id: sessionId,
          turn_id: id(100 + turn),
          created_at: '2026-10-05T14:59:59Z',
          expires_at: '2026-10-12T14:59:59Z',
        });
      } else
        routes.recordTurn({
          session_id: sessionId,
          turn_id: id(100 + turn),
          created_at: '2026-10-05T15:00:00Z',
          expires_at: '2026-10-12T15:00:00Z',
        });
      const body = request.body as Record<string, string>;
      return {
        status: 200,
        body: {
          request_id: body['request_id'],
          session_id: sessionId,
          turn_id: id(100 + turn),
          input_id: id(200 + turn),
          workflow_id: null,
          status: 'answered',
          result_view: null,
          reply_text: null,
        },
      };
    },
  });
  const handler = routes.handlers['postStreamTurn'];
  assert(handler !== undefined);
  const route = API_ROUTES.find(
    (entry) => entry.operationId === 'postStreamTurn',
  );
  assert(route !== undefined);
  const device = { device_id: id(9) } as unknown as DeviceRecord;
  const request = (): ApiHandlerRequest => ({
    route,
    device,
    body: {
      request_id: randomUUID(),
      command_scope_id: id(400),
      text: 'こんにちは',
      input_kind: 'text',
      expected_canvas_revision: '0',
    },
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  // 23:59:59 の発言の保存を保留したまま、0 時の発言で区切りをまたぐ。
  const first = handler(request());
  await new Promise((resolve) => setImmediate(resolve));
  at = Date.parse('2026-10-06T00:00:00+09:00');
  const second = handler(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert(release !== null);
  (release as () => void)();
  const [firstDone, secondDone] = await Promise.all([first, second]);
  assert.equal(firstDone.status, 200);
  assert.equal(secondDone.status, 200);
  const segment = (secondDone.body as unknown as StreamTurnResponse).segment;
  assert.equal(segment.open_reason, 'date_changed');
  // 保留していた旧区切りの発言の期限が、つないだ要約の期限になる（保存の完了を待ってから確定する）。
  assert.deepEqual(segment.carried_summary, {
    source_segment_ids: [id(1)],
    expires_at: '2026-10-12T14:59:59Z',
  });
  assert.equal(sessions, 2);
});

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
    let at = new Date('2026-10-05T09:00:00+09:00');
    const core = await startCanvasCore(t, undefined, () => at);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const firstId = randomUUID();
    const first = await postStream(core, device, scope, '今日の用事を見せて', {
      requestId: firstId,
    });
    const firstBody = first.json as unknown as StreamTurnResponse;
    assert.equal(firstBody.canvas?.canvas_revision, '1');
    // もう一度、現在の記述を版 2 にしておく（最初の束の参照へ戻されたことを見分けるため）。時計を進める前に置く。
    const second = await postStream(core, device, scope, '今日の予定を見せて');
    const secondBody = second.json as unknown as StreamTurnResponse;
    assert.equal(secondBody.canvas?.canvas_revision, '2');
    // 応答のキャッシュの上限（256 件）を超えるまで、別の発言（聞き返し。配置なし）を送る。
    for (let index = 0; index < 260; index += 1) {
      const filler = await postStream(core, device, scope, 'こんにちは');
      assert.equal(filler.status, 200, filler.text);
    }
    // 前の発言から 30 分を過ぎてから次を送り、区切りをまたぐ（受付の対応は応答のキャッシュと別に保つ）。
    at = new Date('2026-10-05T09:31:00+09:00');
    const boundary = await postStream(core, device, scope, 'こんにちは');
    const boundaryBody = boundary.json as unknown as StreamTurnResponse;
    assert.equal(boundaryBody.segment.open_reason, 'idle_timeout');
    assert.equal(boundaryBody.canvas, null);
    const before = JSON.stringify(await canvasOf(core, device));
    // さらに 30 分後に最初の要求を再送する: 元の区切り（会話）で解決し、保存済みの発言の応答（文字の結果）を返す。
    // 区切りは切り替えない（増えない）し、もう一度配置もしない（版も参照も変わらない）。
    at = new Date('2026-10-05T10:02:00+09:00');
    const again = await postStream(core, device, scope, '今日の用事を見せて', {
      requestId: firstId,
    });
    assert.equal(again.status, 200, again.text);
    const againBody = again.json as unknown as StreamTurnResponse;
    assert.equal(againBody.turn_id, firstBody.turn_id);
    assert.deepEqual(againBody.result_view, firstBody.result_view);
    assert.equal(
      againBody.segment.segment_id,
      boundaryBody.segment.segment_id,
      'the replay must not open another segment',
    );
    assert.equal(againBody.canvas, null);
    assert.equal(JSON.stringify(await canvasOf(core, device)), before);
    assert.equal((await canvasOf(core, device)).canvas_revision, '2');
  },
);

// UI-06（#98、ADR 0032）: ユーザーの操作の記録・版の照合・AI が優先。期待値（版・置き場所・記録）は手で書いた。
const CELL = { column: 7, row: 2, span: 4, rows: 3 };
const notesItem: CanvasItem = {
  item_id: 'notes',
  kind: 'card',
  component: 'list',
  heading: 'メモ',
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 7, span: 4, rows: 2 },
  placement: 'canvas',
  data: { item_refs: [], more_count: 0 },
};

test('UI-06: the hub applies user operations by the per-item revision rule and keeps a bounded record', () => {
  const hub = new CanvasHub(contract);
  const told: string[] = [];
  hub.subscribe((revision) => told.push(revision));
  const first = placeCanvasForTurn(
    EMPTY_CANVAS,
    view([{ kind: 'calendar_event', id: id(1) }]),
  );
  assert(first !== null);
  assert.equal(hub.apply(first).ok, true);
  assert.equal(hub.placedAt('errands'), '1');
  // AI がもう 1 つ置く（版 2）。errands の置き場所は版 1 のまま。
  assert.equal(
    hub.apply({
      base_canvas_revision: '1',
      canvas_revision: '2',
      ops: [{ op: 'add', item: notesItem }],
      reading_order: ['errands', 'notes'],
    }).ok,
    true,
  );
  assert.equal(hub.placedAt('errands'), '1');
  assert.equal(hub.placedAt('notes'), '2');

  // 版 1 を見ていた本人が errands を動かす: errands は版 1 から変わっていないので当てる（版 3）。
  assert.deepEqual(
    hub.applyUser({ kind: 'move', item_id: 'errands', cell: CELL }, '1'),
    { ok: true, revision: '3' },
  );
  assert.deepEqual(hub.document.user_pins, [
    { item_id: 'errands', cell: CELL },
  ]);
  assert.deepEqual(hub.document.reading_order, ['errands', 'notes']);
  assert.equal(hub.placedAt('errands'), '3');
  assert.deepEqual(hub.record, [
    { kind: 'move', item_id: 'errands', cell: CELL, canvas_revision: '3' },
  ]);
  // 版 2 を見ていた操作: errands は版 3 で動いたので捨てる。notes は版 2 のままなので当てる（閉じる。版 4）。
  assert.deepEqual(
    hub.applyUser(
      { kind: 'resize', item_id: 'errands', cell: { ...CELL, span: 2 } },
      '2',
    ),
    { ok: false, reason: 'stale' },
  );
  assert.deepEqual(hub.applyUser({ kind: 'close', item_id: 'notes' }, '2'), {
    ok: true,
    revision: '4',
  });
  assert.equal(hub.placedAt('notes'), null);
  assert.deepEqual(hub.document.reading_order, ['errands']);
  // ない物・今より新しい版・当てられない操作（見える物を棚から出す・はみ出すマス）。
  assert.deepEqual(hub.applyUser({ kind: 'close', item_id: 'ghost' }, '4'), {
    ok: false,
    reason: 'stale',
  });
  assert.deepEqual(hub.applyUser({ kind: 'close', item_id: 'errands' }, '9'), {
    ok: false,
    reason: 'stale',
  });
  assert.deepEqual(
    hub.applyUser({ kind: 'unshelve', item_id: 'errands' }, '4'),
    { ok: false, reason: 'not_applicable' },
  );
  assert.deepEqual(
    hub.applyUser(
      {
        kind: 'move',
        item_id: 'errands',
        cell: { column: 10, row: 1, span: 4, rows: 1 },
      },
      '4',
    ),
    { ok: false, reason: 'not_applicable' },
  );
  assert.equal(hub.document.canvas_revision, '4');

  // AI の中身だけの update（版 5）はユーザーの置き場所を消さず、置き場所の版も進めない。
  const update = placeCanvasForTurn(
    hub.document,
    view([{ kind: 'calendar_event', id: id(2) }]),
  );
  assert(update !== null && update.ops[0]?.op === 'update');
  assert.equal(hub.apply(update).ok, true);
  assert.deepEqual(hub.document.user_pins, [
    { item_id: 'errands', cell: CELL },
  ]);
  assert.equal(hub.placedAt('errands'), '3');
  // AI が errands を動かす（版 6）: AI が優先なのでユーザーの置き場所を消す。
  assert.equal(
    hub.apply({
      base_canvas_revision: '5',
      canvas_revision: '6',
      ops: [
        {
          op: 'move',
          item_id: 'errands',
          grid: { column: 1, span: 6, rows: 3 },
        },
      ],
      reading_order: ['errands'],
    }).ok,
    true,
  );
  assert.deepEqual(hub.document.user_pins, []);
  assert.equal(hub.placedAt('errands'), '6');
  // もう一度置いて、AI の置き直し（relayout、版 8）でも消える。
  assert.equal(
    hub.applyUser({ kind: 'move', item_id: 'errands', cell: CELL }, '6').ok,
    true,
  );
  assert.equal(
    hub.apply({
      base_canvas_revision: '7',
      canvas_revision: '8',
      ops: [{ op: 'relayout' }],
      reading_order: ['errands'],
    }).ok,
    true,
  );
  assert.deepEqual(hub.document.user_pins, []);
  assert.deepEqual(told, ['1', '2', '3', '4', '5', '6', '7', '8']);
  // 記録は 64 件まで（古い方から捨てる）。
  for (let n = 0; n < 70; n += 1)
    assert.equal(
      hub.applyUser(
        {
          kind: 'move',
          item_id: 'errands',
          cell: { ...CELL, row: 1 + (n % 3) },
        },
        hub.document.canvas_revision,
      ).ok,
      true,
    );
  assert.equal(hub.record.length, 64);
  assert.equal(hub.record.at(-1)?.canvas_revision, '78');
  assert.equal(hub.record[0]?.canvas_revision, '15');
});

test('UI-06: the placer re-adds the card with the size the user gave it last (the record is the next input)', () => {
  const record = [
    {
      kind: 'move' as const,
      item_id: 'errands',
      cell: { column: 3, row: 1, span: 4, rows: 3 },
      canvas_revision: '2',
    },
    {
      kind: 'resize' as const,
      item_id: 'errands',
      cell: { column: 5, row: 3, span: 6, rows: 2 },
      canvas_revision: '3',
    },
    // ほかの物と、マスのない操作は使わない。
    {
      kind: 'move' as const,
      item_id: 'notes',
      cell: { column: 1, row: 1, span: 2, rows: 1 },
      canvas_revision: '4',
    },
    {
      kind: 'close' as const,
      item_id: 'errands',
      cell: null,
      canvas_revision: '5',
    },
  ];
  const batch = placeCanvasForTurn(
    { canvas_revision: '5', items: [], reading_order: [] },
    view([{ kind: 'calendar_event', id: id(1) }]),
    { record, seen_revision: '3' },
  );
  const op = batch?.ops[0];
  assert(op?.op === 'add');
  assert.deepEqual(op.item.grid, { column: 5, span: 6, rows: 2 });
  // 記録がなければ UI-03 のヒントのまま。
  const plain = placeCanvasForTurn(
    EMPTY_CANVAS,
    view([{ kind: 'calendar_event', id: id(1) }]),
    { record: [], seen_revision: '0' },
  );
  assert(plain?.ops[0]?.op === 'add');
  assert.deepEqual(plain.ops[0].item.grid, { column: 2, span: 4, rows: 3 });
});

test(
  'UI-06: postCanvasUserOp over HTTPS needs a screen operation, applies by the revision rule, replays the same request and refuses a changed one',
  { timeout: 60_000 },
  async (t) => {
    const core = await startCanvasCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const placed = await postStream(core, device, scope, '今日の用事を見せて');
    assert.equal(placed.status, 200, placed.text);
    const screen = { 'buddy-input-origin': 'screen' };
    const body = (requestId: string, expected: string, op: object) => ({
      request_id: requestId,
      command_scope_id: scope,
      expected_canvas_revision: expected,
      op,
    });
    const move = { kind: 'move', item_id: 'errands', cell: CELL };
    // 画面操作でない（音声）は 403。
    const voice = await postJson(
      core,
      device,
      '/v1/canvas/user-ops',
      body(randomUUID(), '1', move),
      { 'buddy-input-origin': 'voice' },
    );
    assert.equal(voice.status, 403, voice.text);
    assert.equal(
      (voice.json as { code?: string }).code,
      'screen_operation_required',
    );
    // ピクセルを持つ操作は形式の違反（422）。
    const pixels = await postJson(
      core,
      device,
      '/v1/canvas/user-ops',
      body(randomUUID(), '1', { ...move, x: 120 }),
      screen,
    );
    assert.equal(pixels.status, 422, pixels.text);
    // 当てる: 版 2。応答は契約どおり。購読の知らせと同じく、記述は getCanvas で取る。
    const requestId = randomUUID();
    const ok = await postJson(
      core,
      device,
      '/v1/canvas/user-ops',
      body(requestId, '1', move),
      screen,
    );
    assert.equal(ok.status, 200, ok.text);
    assert(contract.valid('CanvasUserOpResponse', ok.json));
    assert.deepEqual(ok.json, { request_id: requestId, canvas_revision: '2' });
    const canvas = await canvasOf(core, device);
    assert.deepEqual(canvas.user_pins, [{ item_id: 'errands', cell: CELL }]);
    // 同じ要求の再送は同じ結果（もう一度当てない）。内容が違えば 409。
    const replay = await postJson(
      core,
      device,
      '/v1/canvas/user-ops',
      body(requestId, '1', move),
      screen,
    );
    assert.deepEqual(replay.json, {
      request_id: requestId,
      canvas_revision: '2',
    });
    assert.equal((await canvasOf(core, device)).canvas_revision, '2');
    const changed = await postJson(
      core,
      device,
      '/v1/canvas/user-ops',
      body(requestId, '1', { kind: 'close', item_id: 'errands' }),
      screen,
    );
    assert.equal(changed.status, 409, changed.text);
    // 古い版で、その物が後から動いた: 409（conflict）。記述は変えない。
    const stale = await postJson(
      core,
      device,
      '/v1/canvas/user-ops',
      body(randomUUID(), '1', { kind: 'shelve', item_id: 'errands' }),
      screen,
    );
    assert.equal(stale.status, 409, stale.text);
    assert.equal((stale.json as { code?: string }).code, 'conflict');
    assert.equal((await canvasOf(core, device)).canvas_revision, '2');
    // 発言は版が古くても受け付ける（言葉を捨てない）。配置者は今の記述から作る（中身だけの update。版 3）。
    const turn = await postStream(core, device, scope, '今日の用事を見せて', {
      expected: '0',
    });
    assert.equal(turn.status, 200, turn.text);
    const turnBody = turn.json as unknown as StreamTurnResponse;
    assert.equal(turnBody.canvas?.base_canvas_revision, '2');
    assert.equal(turnBody.canvas?.ops[0]?.op, 'update');
    // 中身だけの update はユーザーの置き場所を消さない。
    assert.deepEqual((await canvasOf(core, device)).user_pins, [
      { item_id: 'errands', cell: CELL },
    ]);
  },
);
