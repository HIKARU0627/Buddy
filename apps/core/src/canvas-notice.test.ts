// 期限切れ・忘却の知らせで流れの表示を片付ける（UI-05 の段階 3、ADR 0187）単体の試験。
// - CanvasHub.removeItems: 物を閉じる束を Core が作って当てる。残る物の関係を先に外し、12 件を超える操作は束を分け、
//   束ごとに版を 1 進める。閉じた物の本文・置き場所の版を残さない。ない物は数えない。
// - StreamRoutes.applyNotice: 消えた発言が置いた・最後に変えた物、発言（screen_result）・記憶（memory）を参照する物を閉じる。
//   関係のない知らせ・台帳の知らせでは版を進めない。消えた発言の束を再送の応答に返さない。忘却の知らせでは、区切りに
//   つないだ要約を外して次の発言で新しい区切り（forget_requested）を始める。要約をつないだ区間の期限切れでは要約を外す。
// 解釈・保存は模擬（発言の処理と会話の作成は試験の中の偽物）。期待値（版・物・関係・区切り）は手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanvasItem,
  CanvasOpBatch,
  RetentionNotice,
  StreamTurnResponse,
  TurnResponse,
} from '@buddy/contracts';
import type { DeviceRecord } from '@buddy/storage';
import { sharedApiContract } from './api-test-support.js';
import { API_ROUTES } from './api-routes.js';
import type { ApiHandlerRequest } from './api-server.js';
import {
  CanvasHub,
  REPLY_ITEM_ID,
  createStreamRoutes,
} from './canvas-stream.js';
import type { StreamStorageGate } from './canvas-stream.js';

const contract = sharedApiContract();
const ID = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = Date.parse('2026-10-05T09:00:00+09:00');
const MIN = 60_000;
const DAY = 86_400_000;

const storage: StreamStorageGate = {
  mode: 'normal',
  origin: () => ({ segment_generation: '1' }),
  enterPrivate: () => Promise.resolve({ ok: false, reason: 'closed' }),
  exitPrivate: () => Promise.resolve({ ok: false, reason: 'closed' }),
};

const card = (
  itemId: string,
  refs: CanvasItem['data']['item_refs'] = [],
  relations: CanvasItem['relations'] = [],
): CanvasItem => ({
  item_id: itemId,
  kind: 'card',
  component: 'list',
  heading: '合成のカード',
  emphasis: 'normal',
  group: null,
  relations,
  grid: { column: 1, span: 4, rows: 2 },
  placement: 'canvas',
  data: { item_refs: refs, more_count: 0 },
});

const expired = (
  items: RetentionNotice['items'],
  noticeId = ID(0xa1),
): RetentionNotice => ({
  schema: 'buddy.retention-notice.v1',
  notice_id: noticeId,
  occurred_at: '2026-10-13T00:00:00Z',
  kind: 'expired',
  reason: 'retention_due',
  forgetting_generation: null,
  items,
});

test('the hub closes items in batches of at most 12 operations, drops relations to them first and keeps nothing of them', () => {
  const hub = new CanvasHub(contract);
  const revisions: string[] = [];
  const names = Array.from({ length: 13 }, (_, index) => `x${index}`);
  const add = (base: string, next: string, items: CanvasItem[]) => {
    const batch = {
      base_canvas_revision: base,
      canvas_revision: next,
      ops: items.map((item) => ({ op: 'add' as const, item })),
      reading_order: [
        ...hub.document.reading_order,
        ...items.map((i) => i.item_id),
      ],
    } as unknown as CanvasOpBatch;
    assert.deepEqual(hub.apply(batch), { ok: true, revision: next });
  };
  add(
    '0',
    '1',
    names.slice(0, 12).map((name) => card(name)),
  );
  add('1', '2', [
    card('x12'),
    card('keep', [], [{ kind: 'detail_of', target: 'x0' }]),
  ]);
  hub.setText('x3', '合成の本文');
  hub.subscribe((revision) => revisions.push(revision));
  assert.equal(hub.placedAt('x0'), '1');

  // 13 件を閉じ、keep の関係を外す（14 操作）→ 12 操作（関係の更新 1 件 + 閉じる 11 件）と 2 操作の 2 つの束。
  assert.equal(hub.removeItems(new Set([...names, 'missing'])), '4');
  assert.deepEqual(revisions, ['3', '4']);
  assert.deepEqual(hub.document, {
    canvas_revision: '4',
    items: [card('keep')],
    reading_order: ['keep'],
  });
  assert.equal(hub.textFor('x3'), null);
  assert.equal(hub.placedAt('x0'), null);
  assert.equal(hub.placedAt('x12'), null);
  // ない物だけなら何もしない（版を進めず、知らせない）。
  assert.equal(hub.removeItems(new Set(['x0', 'missing'])), null);
  assert.equal(hub.document.canvas_revision, '4');
  assert.deepEqual(revisions, ['3', '4']);
});

// 流れの経路の偽物の組み立て。次に置く物（pending）を試験が決めてから発言する。
function rig() {
  const canvas = new CanvasHub(contract);
  let at = T0;
  let sessions = 0;
  const turnsByRequest = new Map<string, string>();
  let pending: CanvasItem | null = null;
  // 会話の作成を止めておく口（区切りを作る間に知らせが来る場合）。
  let hold: { entered: () => void; release: Promise<void> } | null = null;
  const routes = createStreamRoutes({
    canvas,
    storage,
    contract,
    now: () => at,
    utcOffset: '+09:00',
    createSession: async () => {
      sessions += 1;
      const session = ID(0x100 + sessions);
      const held = hold;
      hold = null;
      if (held !== null) {
        held.entered();
        await held.release;
      }
      return { status: 201, body: { session_id: session } };
    },
    postTurn: (request) => {
      const body = request.body as Record<string, string>;
      const requestId = body['request_id'] as string;
      const turnId =
        turnsByRequest.get(requestId) ?? ID(0x200 + turnsByRequest.size + 1);
      turnsByRequest.set(requestId, turnId);
      const forget = body['text'] === '忘れて';
      return Promise.resolve({
        status: 200,
        body: {
          request_id: requestId,
          session_id: request.params['session_id'],
          turn_id: turnId,
          input_id: ID(0x300),
          workflow_id: ID(0x400),
          status: 'answered',
          result_view: {
            workflow_id: ID(0x400),
            request_revision: '1',
            intent: forget ? 'memory_forget' : 'query_schedule',
            kind: forget ? 'completion_line' : 'schedule_cards',
            status: 'ready',
            item_refs: [],
            more_count: 0,
            template_id: null,
            template_version: null,
          },
          reply_text: null,
        },
      });
    },
    // 試験が決めた物を置く（あれば中身だけを更新する）。
    place: (document) => {
      const item = pending;
      pending = null;
      if (item === null) return null;
      const base = document.canvas_revision;
      const next = (BigInt(base) + 1n).toString();
      const exists = document.items.some(
        (entry) => entry.item_id === item.item_id,
      );
      return (
        exists
          ? {
              base_canvas_revision: base,
              canvas_revision: next,
              ops: [
                {
                  op: 'update',
                  item_id: item.item_id,
                  changes: { data: item.data },
                },
              ],
              reading_order: [...document.reading_order],
            }
          : {
              base_canvas_revision: base,
              canvas_revision: next,
              ops: [{ op: 'add', item }],
              reading_order: [...document.reading_order, item.item_id],
            }
      ) as CanvasOpBatch;
    },
  });
  const handler = routes.handlers['postStreamTurn'];
  assert(handler !== undefined);
  const route = API_ROUTES.find(
    (entry) => entry.operationId === 'postStreamTurn',
  );
  assert(route !== undefined);
  const device = { device_id: ID(9) } as unknown as DeviceRecord;
  let requests = 0;
  const say = async (
    text: string,
    placing: CanvasItem | null = null,
    requestId: string = ID(0x500 + (requests += 1)),
  ) => {
    pending = placing;
    const request: ApiHandlerRequest = {
      route,
      device,
      body: {
        request_id: requestId,
        command_scope_id: ID(0x600),
        text,
        input_kind: 'text',
        expected_canvas_revision: '0',
      },
      params: {},
      remoteAddress: '127.0.0.1',
      query: {},
      declaredLockState: null,
    };
    const response = await handler(request);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return { requestId, body: response.body as unknown as StreamTurnResponse };
  };
  return {
    canvas,
    routes,
    say,
    advance: (ms: number) => {
      at += ms;
    },
    at: () => at,
    // 次の会話の作成を止める。作成に入ったら entered が解決し、release を呼ぶまで待つ。
    holdNextSession: () => {
      let entered: () => void = () => undefined;
      let release: () => void = () => undefined;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      hold = {
        entered: () => entered(),
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return { entered: enteredPromise, release: () => release() };
    },
  };
}

test('an expired or forgotten turn or memory closes the items tied to it; unrelated and ledger notices change nothing', async () => {
  const r = rig();
  const memory = ID(0x700);
  const a = await r.say('ひとつめ', card('alpha'));
  const b = await r.say(
    'ふたつめ',
    card('beta', [{ kind: 'memory', id: memory }]),
  );
  await r.say(
    'みっつめ',
    card('gamma', [], [{ kind: 'detail_of', target: 'alpha' }]),
  );
  // 声で返せなかった結果（発言の ID を参照する text の物）。
  const late = r.routes.placeLate(
    {
      request_id: ID(0x800),
      turn_id: ID(0x801),
      input_id: ID(0x802),
      workflow_id: ID(0x803),
      status: 'answered',
      result_view: null,
      reply_text: '合成の答え',
    } as unknown as TurnResponse,
    null,
  );
  assert.equal(late?.canvas_revision, '4');
  assert.equal(r.canvas.textFor(REPLY_ITEM_ID), '合成の答え');
  const revisions: string[] = [];
  r.canvas.subscribe((revision) => revisions.push(revision));

  // 1. alpha を置いた発言の期限切れ: alpha を閉じ、gamma の関係を外す（1 つの束で版 5）。
  assert.equal(
    r.routes.applyNotice(
      expired([{ item_kind: 'turn', item_id: a.body.turn_id }]),
    ),
    true,
  );
  assert.deepEqual(revisions, ['5']);
  assert.deepEqual(
    r.canvas.document.items.map((item) => [item.item_id, item.relations]),
    [
      ['beta', []],
      ['gamma', []],
      [REPLY_ITEM_ID, []],
    ],
  );
  assert.deepEqual(r.canvas.document.reading_order, [
    'beta',
    'gamma',
    REPLY_ITEM_ID,
  ]);

  // 2. 答えの物が参照する発言の期限切れ: 答えの物を閉じ、本文も捨てる（版 6）。
  r.routes.applyNotice(expired([{ item_kind: 'turn', item_id: ID(0x801) }]));
  assert.deepEqual(revisions, ['5', '6']);
  assert.equal(r.canvas.textFor(REPLY_ITEM_ID), null);

  // 3. 記憶の忘却: その記憶を参照する beta を閉じる（版 7）。
  r.routes.applyNotice({
    ...expired([{ item_kind: 'memory', item_id: memory }]),
    kind: 'forgotten',
    reason: 'forgotten',
    forgetting_generation: '1',
  });
  assert.deepEqual(revisions, ['5', '6', '7']);
  assert.deepEqual(
    r.canvas.document.items.map((item) => item.item_id),
    ['gamma'],
  );

  // 4. 関係のない知らせ・台帳の知らせは版を進めない。
  assert.equal(
    r.routes.applyNotice(
      expired([
        { item_kind: 'turn', item_id: ID(0x999) },
        { item_kind: 'source_item', item_id: 'mail-synthetic-raw' },
      ]),
    ),
    true,
  );
  assert.equal(
    r.routes.applyNotice({
      schema: 'buddy.forget-ledger-notice.v1',
      notice_id: ID(0xa2),
      occurred_at: '2026-10-13T00:00:00Z',
      kind: 'ledger_advanced',
      ledger_id: ID(0xa3),
      forgetting_generation: '1',
      entry_hash: 'ab'.repeat(32),
    }),
    true,
  );
  assert.deepEqual(revisions, ['5', '6', '7']);

  // 5. 消えた発言の同じ要求の再送は、前の束を返さず、置き直さない。
  const again = await r.say('ひとつめ', card('alpha'), a.requestId);
  assert.equal(again.body.turn_id, a.body.turn_id);
  assert.equal(again.body.canvas, null);
  assert.equal(r.canvas.document.canvas_revision, '7');
  // 消えていない発言の再送は、従来どおり前の束を返す。
  const kept = await r.say('ふたつめ', null, b.requestId);
  assert.equal(kept.body.canvas?.canvas_revision, '2');
});

test('the carried summary is dropped when its source expires, and a forget drops it and opens a forget segment next', async () => {
  const r = rig();
  const first = await r.say('こんにちは');
  const s1 = first.body.segment.segment_id;
  r.routes.recordTurn({
    session_id: s1,
    turn_id: first.body.turn_id,
    created_at: new Date(r.at()).toISOString(),
    expires_at: new Date(r.at() + 7 * DAY).toISOString(),
  });
  // 30 分後: 新しい区切り（idle_timeout）に s1 の要約をつなぐ。
  r.advance(30 * MIN);
  const second = await r.say('こんにちは');
  const s2 = second.body.segment;
  assert.notEqual(s2.segment_id, s1);
  assert.equal(s2.open_reason, 'idle_timeout');
  assert.deepEqual(s2.carried_summary, {
    source_segment_ids: [s1],
    expires_at: '2026-10-12T00:00:00.000Z',
  });
  // 期限切れの発言（今の区切りのもの）では区切らない。要約をつないだ区間（s1）の期限切れで要約を外す。
  r.routes.applyNotice(
    expired([{ item_kind: 'turn', item_id: second.body.turn_id }]),
  );
  const third = await r.say('こんにちは');
  assert.equal(third.body.segment.segment_id, s2.segment_id);
  assert.notEqual(third.body.segment.carried_summary, null);
  r.routes.applyNotice(
    expired([{ item_kind: 'carried_summary', item_id: s1 }]),
  );
  const fourth = await r.say('こんにちは');
  assert.equal(fourth.body.segment.segment_id, s2.segment_id);
  assert.equal(fourth.body.segment.open_reason, 'idle_timeout');
  assert.equal(fourth.body.segment.carried_summary, null);

  // 忘却（画面の経路。発言の忘却の指示ではない）: 次の発言で、時刻に関係なく新しい区切り（forget_requested）。
  r.routes.recordTurn({
    session_id: s2.segment_id,
    turn_id: fourth.body.turn_id,
    created_at: new Date(r.at()).toISOString(),
    expires_at: new Date(r.at() + 7 * DAY).toISOString(),
  });
  r.routes.applyNotice({
    ...expired([{ item_kind: 'memory', item_id: ID(0x700) }]),
    kind: 'forgotten',
    reason: 'forgotten',
    forgetting_generation: '1',
  });
  const fifth = await r.say('こんにちは');
  assert.notEqual(fifth.body.segment.segment_id, s2.segment_id);
  assert.equal(fifth.body.segment.open_reason, 'forget_requested');
  assert.equal(fifth.body.segment.carried_summary, null);
  // 印は一度だけ使う。
  const sixth = await r.say('こんにちは');
  assert.equal(sixth.body.segment.segment_id, fifth.body.segment.segment_id);
});

test('a forget that arrives while a new segment is being opened keeps the summary out of that segment', async () => {
  const r = rig();
  const first = await r.say('こんにちは');
  r.routes.recordTurn({
    session_id: first.body.segment.segment_id,
    turn_id: first.body.turn_id,
    created_at: new Date(r.at()).toISOString(),
    expires_at: new Date(r.at() + 7 * DAY).toISOString(),
  });
  r.advance(30 * MIN);
  // 30 分後の発言が新しい区切りの会話を作っている間に、忘却の知らせが来る。
  const held = r.holdNextSession();
  const pendingTurn = r.say('こんにちは');
  await held.entered;
  r.routes.applyNotice({
    ...expired([{ item_kind: 'memory', item_id: ID(0x700) }]),
    kind: 'forgotten',
    reason: 'forgotten',
    forgetting_generation: '1',
  });
  held.release();
  const second = await pendingTurn;
  assert.notEqual(
    second.body.segment.segment_id,
    first.body.segment.segment_id,
  );
  assert.equal(second.body.segment.open_reason, 'idle_timeout');
  assert.equal(second.body.segment.carried_summary, null);
});
