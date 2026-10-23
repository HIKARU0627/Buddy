// キャンバスの物の中身（本文）の読み取り（UI-07、ADR 0032）の試験。Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬の
// KeyStore）、解釈は模擬、provider は試験の中で作る合成の読み取り専用の模擬。中身は模擬の合成データ（実データは B08・B09・B11）。
// 期待値（件数・題名・版・状態コード）は手で書いた値で、実装の出力から作らない。実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type {
  CanvasContentResponse,
  CanvasDocument,
  CanvasItem,
} from '@buddy/contracts';
import { canvasContentErrors } from '@buddy/domain';
import { createApiContract } from './api-contract.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import { API_ROUTES } from './api-routes.js';
import { mockCanvasContent } from './canvas-content.js';
import { CanvasHub, createStreamRoutes } from './canvas-stream.js';
import {
  bootstrap,
  getJson,
  insertDevice,
  openStream,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import type { ProviderEvent, ProviderReader } from './turn-ports.js';

const contract = createApiContract();

const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';

// 合成の読み取り専用の provider。今日は 4 件（ev-1 と ev-2 が重なる）。
const EVENTS: ProviderEvent[] = [0, 1, 2, 3].map((index) => ({
  event_id: `ev-${index}`,
  title: `合成の予定${index}`,
  start: `2026-10-05T${String(9 + index).padStart(2, '0')}:00:00+09:00`,
  end: `2026-10-05T${String(10 + index).padStart(2, '0')}:30:00+09:00`,
}));

const mockProvider = (): ProviderReader => ({
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
  readTarget: () => Promise.resolve(null),
  listEvents: () => Promise.resolve(EVENTS),
});

const startCanvasCore = (t: test.TestContext): Promise<EventCore> =>
  startEventCore(t, {
    previewValid: false,
    now: () => CLOCK,
    turns: {
      provider: mockProvider(),
      candidates: {
        mailCandidates: () =>
          Promise.resolve([
            { candidate_id: MAIL_CANDIDATE, remote_id: 'mail-001' },
          ]),
      },
      utcOffset: '+09:00',
    },
  });

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const itemOf = (
  component: CanvasItem['component'],
  refs: number,
): Pick<CanvasItem, 'component' | 'data'> => ({
  component,
  data: {
    item_refs: Array.from({ length: refs }, (_, index) => ({
      kind: 'calendar_event',
      id: id(0x500 + index),
    })),
    more_count: 0,
  },
});

const contentBody = (
  scope: string,
  expected: string,
  itemId: string,
  openIndex: number | null = null,
) => ({
  request_id: randomUUID(),
  command_scope_id: scope,
  expected_canvas_revision: expected,
  item_id: itemId,
  open_index: openIndex,
});

const COMPONENTS = [
  'list',
  'table',
  'schedule_timeline',
  'mail_card',
  'compare',
  'progress',
  'chart',
  'source_list',
  'text',
] as const;

test('the mock content has the hand-written shape of each component, keeps no Core id, and always passes the schema and the domain check', () => {
  const list = mockCanvasContent(itemOf('list', 5), null);
  assert(list.component === 'list');
  assert.equal(list.rows.length, 5);
  assert.deepEqual(list.rows[0], {
    title: '歯医者の予約を入れる',
    due_at: '2026-10-24T01:00:00Z',
    state: 'open',
  });
  // 添字 4 は期限なし、添字 2 は気づき、添字 3 は済み。
  assert.equal(list.rows[4]?.due_at, null);
  assert.equal(list.rows[2]?.state, 'attention');
  assert.equal(list.rows[3]?.state, 'done');

  const table = mockCanvasContent(itemOf('table', 3), null);
  assert(table.component === 'table');
  assert.deepEqual(table.columns, ['項目', '場所', '期限', '状態']);
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[0]?.cells, [
    '歯医者の予約を入れる',
    '自宅',
    '10 日',
    '未了',
  ]);

  const timeline = mockCanvasContent(itemOf('schedule_timeline', 3), null);
  assert(timeline.component === 'schedule_timeline');
  assert.equal(timeline.day_start_minute, 480);
  assert.equal(timeline.day_end_minute, 1200);
  // 開始は 8:00・8:40・9:20、どれも 60 分。隣り合う予定は重なる（重なりの位置は画面が決める）。
  assert.deepEqual(
    timeline.events.map((event) => [event.start_minute, event.end_minute]),
    [
      [480, 540],
      [520, 580],
      [560, 620],
    ],
  );

  // メールの本文は開いた行だけ。
  const closed = mockCanvasContent(itemOf('mail_card', 3), null);
  assert(closed.component === 'mail_card');
  assert.deepEqual(
    closed.mails.map((mail) => mail.body),
    [null, null, null],
  );
  assert.equal(closed.mails[0]?.from, '山田 花子');
  const opened = mockCanvasContent(itemOf('mail_card', 3), 1);
  assert(opened.component === 'mail_card');
  assert.deepEqual(
    opened.mails.map((mail) => mail.body === null),
    [true, false, true],
  );
  assert.equal(
    opened.mails[1]?.body,
    'お世話になっております。\n来週の予定について、いくつか候補を挙げます。\n火曜日の午後、または木曜日の午前でしたら調整できます。\nご都合のよい時間を教えてください。',
  );

  const compare = mockCanvasContent(itemOf('compare', 2), null);
  assert(compare.component === 'compare');
  assert.deepEqual(compare.columns, ['案 A', '案 B', '案 C']);
  assert.equal(compare.rows.length, 4);
  // 場所は A と C が同じ、B が違う。
  assert.deepEqual(compare.rows[0]?.values, [
    '駅から近い',
    '駅から遠い',
    '駅から近い',
  ]);

  const progress = mockCanvasContent(itemOf('progress', 0), null);
  assert(progress.component === 'progress');
  assert.deepEqual(
    progress.steps.map((step) => [step.done, step.total]),
    [
      [4, 5],
      [1, 2],
      [0, 1],
    ],
  );

  const chart = mockCanvasContent(itemOf('chart', 0), null);
  assert(chart.component === 'chart');
  assert.deepEqual(chart.x_labels, ['月', '火', '水', '木', '金', '土', '日']);
  assert.deepEqual(
    chart.series.map((series) => [series.label, series.mark]),
    [
      ['今週', 'bar'],
      ['目標', 'line'],
    ],
  );

  const sources = mockCanvasContent(itemOf('source_list', 4), null);
  assert(sources.component === 'source_list');
  assert.deepEqual(sources.sources[0], {
    title: '公共の案内ページ',
    url: 'https://www.example.com/guide/overview',
  });
  assert(sources.sources.every((source) => source.url.startsWith('https://')));

  const text = mockCanvasContent(itemOf('text', 0), null);
  assert(text.component === 'text');
  assert(text.text.includes('\n'));

  // 参照が 0・1・7・50 件のどれでも、形式と意味の検査を通る。中身は中枢の識別子（参照の id）を含まない。
  for (const component of COMPONENTS)
    for (const refs of [0, 1, 7, 50]) {
      const item = itemOf(component, refs);
      const content = mockCanvasContent(item, null);
      assert(contract.valid('CanvasContent', content), `${component} ${refs}`);
      assert.deepEqual(
        canvasContentErrors(content, {
          component,
          refCount: refs,
          openIndex: null,
        }),
        [],
        `${component} ${refs}`,
      );
      const serialized = JSON.stringify(content);
      for (const ref of item.data.item_refs)
        assert(!serialized.includes(ref.id), `${component} leaks a Core id`);
      // 決まった入力から決まった結果（乱数・時刻を使わない）。
      assert.deepEqual(mockCanvasContent(item, null), content);
    }
});

test(
  'postCanvasContent returns the content in the order of item_refs, is read-only (no event, no new revision, no notice), and refuses stale revisions, missing items, bad open_index, a locked device and a changed scope',
  { timeout: 60_000 },
  async (t) => {
    const core = await startCanvasCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const placed = await postJson(core, device, '/v1/stream/turns', {
      request_id: randomUUID(),
      command_scope_id: scope,
      text: '今日の用事を見せて',
      input_kind: 'text',
      expected_canvas_revision: '0',
    });
    assert.equal(placed.status, 200, placed.text);
    const snapshot = await getJson(core, device, '/v1/snapshot');
    const cursor = String(snapshot.json?.['event_cursor']);
    const stream = openStream(t, core, device, cursor);
    assert.deepEqual(await stream.opened, { ok: true });
    const canvasOf = async () => {
      const response = await getJson(core, device, '/v1/canvas');
      assert.equal(response.status, 200, response.text);
      return response.json as unknown as CanvasDocument;
    };
    const before = await canvasOf();
    assert.equal(before.canvas_revision, '1');
    assert.equal(before.items[0]?.data.item_refs.length, 4);

    const ok = await postJson(
      core,
      device,
      '/v1/canvas/content',
      contentBody(scope, '1', 'errands'),
    );
    assert.equal(ok.status, 200, ok.text);
    assert(contract.valid('CanvasContentResponse', ok.json), ok.text);
    const response = ok.json as unknown as CanvasContentResponse;
    assert.equal(response.canvas_revision, '1');
    assert.equal(response.item_id, 'errands');
    assert.equal(response.open_index, null);
    assert(response.content.component === 'list');
    // 4 件の参照と同じ件数（手で書いた題名の先頭 4 つ）。
    assert.deepEqual(
      response.content.rows.map((row) => row.title),
      [
        '歯医者の予約を入れる',
        '書類を郵送する',
        '電球を買う',
        '週のメモを整える',
      ],
    );
    // 中身に参照の id（予定の識別子）を含めない。
    for (const ref of before.items[0]?.data.item_refs ?? [])
      assert(!ok.text.includes(ref.id));

    // 読み取りだけ: 記述は変わらず、購読へ知らせず、イベントの記録に入らない。
    assert.deepEqual(await canvasOf(), before);
    assert.deepEqual(stream.messages, []);
    const feed = await getJson(
      core,
      device,
      `/v1/events?cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(feed.status, 200, feed.text);
    assert.deepEqual(feed.json?.['events'], []);
    assert(!feed.text.includes('歯医者'));

    // 古い版・今より新しい版は 409。物がない・本文を開けない物も 409。中身は返さない。
    for (const [label, body] of [
      ['stale', contentBody(scope, '0', 'errands')],
      ['newer', contentBody(scope, '2', 'errands')],
      ['missing', contentBody(scope, '1', 'unknown-item')],
      ['open a list', contentBody(scope, '1', 'errands', 0)],
    ] as const) {
      const refused = await postJson(core, device, '/v1/canvas/content', body);
      assert.equal(refused.status, 409, `${label}: ${refused.text}`);
      assert.equal((refused.json as { code?: string }).code, 'conflict');
      assert(!refused.text.includes('歯医者'), label);
    }

    // ロック中・不明は 403（本文を出さない）。
    for (const lock of ['locked', 'unknown'] as const) {
      core.env.lock = lock;
      const refused = await postJson(
        core,
        device,
        '/v1/canvas/content',
        contentBody(scope, '1', 'errands'),
      );
      assert.equal(refused.status, 403, `${lock}: ${refused.text}`);
      assert.equal((refused.json as { code?: string }).code, 'device_locked');
      assert(!refused.text.includes('歯医者'), lock);
    }
    core.env.lock = 'unlocked';

    // 古い接続範囲は 410、自宅の外は 403。
    const staleScope = await postJson(
      core,
      device,
      '/v1/canvas/content',
      contentBody(randomUUID(), '1', 'errands'),
    );
    assert.equal(staleScope.status, 410, staleScope.text);
    core.env.home = false;
    const outside = await postJson(
      core,
      device,
      '/v1/canvas/content',
      contentBody(scope, '1', 'errands'),
    );
    core.env.home = true;
    assert.equal(outside.status, 403, outside.text);
    assert.equal(
      (outside.json as { code?: string }).code,
      'outside_home_network',
    );
    // 形式の違反（本文の項目・範囲外の位置）は 422。
    for (const extra of [{ body: '本文' }, { open_index: 50 }]) {
      const invalid = await postJson(core, device, '/v1/canvas/content', {
        ...contentBody(scope, '1', 'errands'),
        ...extra,
      });
      assert.equal(invalid.status, 422, invalid.text);
    }
    // 端末トークンがなければ 401。
    const anonymous = await postJson(
      core,
      { ...device, token: 'not-a-token' },
      '/v1/canvas/content',
      contentBody(scope, '1', 'errands'),
    );
    assert.equal(anonymous.status, 401, anonymous.text);
  },
);

test('the mail body is returned only for the opened row, and only for a mail card', async () => {
  const hub = new CanvasHub();
  const routes = createStreamRoutes({
    canvas: hub,
    createSession: () => Promise.reject(new Error('unused')),
    postTurn: () => Promise.reject(new Error('unused')),
  });
  const handler = routes.handlers['postCanvasContent'] as ApiRouteHandler;
  const item = (
    itemId: string,
    component: CanvasItem['component'],
    refs: number,
  ): CanvasItem => ({
    item_id: itemId,
    kind: 'card',
    component,
    heading: '見出し',
    emphasis: 'normal',
    group: null,
    relations: [],
    grid: { column: 1, span: 4, rows: 2 },
    placement: 'canvas',
    data: itemOf(component, refs).data,
  });
  const add = (entry: CanvasItem, revision: string, base: string) =>
    hub.apply({
      base_canvas_revision: base,
      canvas_revision: revision,
      ops: [{ op: 'add', item: entry }],
      reading_order: [...hub.document.reading_order, entry.item_id],
    });
  assert(add(item('mails', 'mail_card', 3), '1', '0').ok);
  assert(add(item('news', 'list', 2), '2', '1').ok);
  const call = (itemId: string, openIndex: number | null) =>
    handler({
      route: API_ROUTES.find(
        (route) => route.operationId === 'postCanvasContent',
      ) as ApiHandlerRequest['route'],
      device: {} as ApiHandlerRequest['device'],
      body: contentBody(
        '00000000-0000-4000-8000-000000000001',
        '2',
        itemId,
        openIndex,
      ),
      params: {},
      query: {},
      remoteAddress: '127.0.0.1',
      declaredLockState: null,
    });
  const closed = await call('mails', null);
  assert.equal(closed.status, 200);
  const closedMails = (closed.body as CanvasContentResponse).content;
  assert(closedMails.component === 'mail_card');
  assert.deepEqual(
    closedMails.mails.map((mail) => mail.body),
    [null, null, null],
  );
  const opened = await call('mails', 2);
  assert.equal(opened.status, 200);
  const openedMails = (opened.body as CanvasContentResponse).content;
  assert(openedMails.component === 'mail_card');
  assert.deepEqual(
    openedMails.mails.map((mail) => mail.body === null),
    [true, true, false],
  );
  assert.equal((opened.body as CanvasContentResponse).open_index, 2);
  // 範囲外の行・メール以外は 409。
  assert.equal((await call('mails', 3)).status, 409);
  assert.equal((await call('news', 0)).status, 409);
});
