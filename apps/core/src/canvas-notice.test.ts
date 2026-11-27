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
// canvas は試験が差し替えられる（途中の束で当てられない場合）。duringTurn は発言の保存の後・配置の前に呼ぶ（処理中の
// 発言と知らせの競合）。
function rig(
  canvas: CanvasHub = new CanvasHub(contract),
  duringTurn: ((turnId: string) => void) | null = null,
) {
  let at = T0;
  let sessions = 0;
  const turnsByRequest = new Map<string, string>();
  // 置く物、または閉じる物（{ close: 物の ID }。AI の close）。
  let pending: CanvasItem | { readonly close: string } | null = null;
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
      duringTurn?.(turnId);
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
      if ('close' in item)
        return {
          base_canvas_revision: base,
          canvas_revision: next,
          ops: [{ op: 'close', item_id: item.close }],
          reading_order: document.reading_order.filter(
            (id) => id !== item.close,
          ),
        } as CanvasOpBatch;
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
    placing: CanvasItem | { readonly close: string } | null = null,
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
  const userOpHandler = routes.handlers['postCanvasUserOp'];
  const userOpRoute = API_ROUTES.find(
    (entry) => entry.operationId === 'postCanvasUserOp',
  );
  assert(userOpHandler !== undefined && userOpRoute !== undefined);
  // ユーザーが物を閉じる（UI-06）。
  const userClose = async (itemId: string) => {
    const response = await userOpHandler({
      route: userOpRoute,
      device,
      body: {
        request_id: ID(0x900 + (requests += 1)),
        command_scope_id: ID(0x600),
        expected_canvas_revision: canvas.document.canvas_revision,
        op: { kind: 'close', item_id: itemId },
      },
      params: {},
      remoteAddress: '127.0.0.1',
      query: {},
      declaredLockState: null,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  return {
    canvas,
    routes,
    say,
    userClose,
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

// ---- 見直しでの修正（ADR 0187 の「見直しでの修正」）----

// 物を 12 個ずつの束で足す（試験の準備。足した後の版は束の数）。
const addAll = (hub: CanvasHub, items: readonly CanvasItem[]) => {
  for (let start = 0; start < items.length; start += 12) {
    const chunk = items.slice(start, start + 12);
    const base = hub.document.canvas_revision;
    const next = (BigInt(base) + 1n).toString();
    const batch = {
      base_canvas_revision: base,
      canvas_revision: next,
      ops: chunk.map((item) => ({ op: 'add' as const, item })),
      reading_order: [
        ...hub.document.reading_order,
        ...chunk.map((item) => item.item_id),
      ],
    } as unknown as CanvasOpBatch;
    assert.deepEqual(hub.apply(batch), { ok: true, revision: next });
  }
};
const x = (n: number) => `x${n}`;

test('closing 13 items where a later one points at an earlier one closes them all across two batches', () => {
  const hub = new CanvasHub(contract);
  addAll(hub, [
    ...Array.from({ length: 12 }, (_, n) => card(x(n))),
    card('x12', [], [{ kind: 'detail_of', target: 'x0' }]),
  ]);
  assert.equal(hub.document.canvas_revision, '2');
  const revisions: string[] = [];
  hub.subscribe((revision) => revisions.push(revision));

  // x12 の関係を外す 1 件 + 閉じる 11 件、閉じる 2 件の 2 つの束（版 3・4）。
  assert.equal(
    hub.removeItems(new Set(Array.from({ length: 13 }, (_, n) => x(n)))),
    '4',
  );
  assert.deepEqual(revisions, ['3', '4']);
  assert.deepEqual(hub.document, {
    canvas_revision: '4',
    items: [],
    reading_order: [],
  });
  assert.equal(hub.placedAt('x0'), null);
  assert.equal(hub.placedAt('x12'), null);
});

test('closing items that point at each other works in one batch and across batches', () => {
  // 1 つの束に収まる: 互いに指す a・b と、a を指す keep。keep の関係を外して a・b を閉じる（版 1 つ）。
  const small = new CanvasHub(contract);
  addAll(small, [
    card('a', [], [{ kind: 'detail_of', target: 'b' }]),
    card('b', [], [{ kind: 'detail_of', target: 'a' }]),
    card('keep', [], [{ kind: 'detail_of', target: 'a' }]),
  ]);
  assert.equal(small.removeItems(new Set(['a', 'b'])), '2');
  assert.deepEqual(small.document, {
    canvas_revision: '2',
    items: [card('keep')],
    reading_order: ['keep'],
  });

  // 束をまたぐ: 互いに指す x0・x12 と、x5 を指す keep、関係のない other。関係を外す 3 件、閉じる 12 件、閉じる 1 件の
  // 3 つの束（同じ物の関係の更新と閉じるを 1 つの束に入れない。版 3・4・5）。
  const hub = new CanvasHub(contract);
  addAll(hub, [
    card('x0', [], [{ kind: 'detail_of', target: 'x12' }]),
    card('x12', [], [{ kind: 'detail_of', target: 'x0' }]),
    ...Array.from({ length: 11 }, (_, n) => card(x(n + 1))),
    card('keep', [], [{ kind: 'detail_of', target: 'x5' }]),
    card('other'),
  ]);
  assert.equal(hub.document.canvas_revision, '2');
  const revisions: string[] = [];
  hub.subscribe((revision) => revisions.push(revision));
  assert.equal(
    hub.removeItems(new Set(Array.from({ length: 13 }, (_, n) => x(n)))),
    '5',
  );
  assert.deepEqual(revisions, ['3', '4', '5']);
  assert.deepEqual(hub.document, {
    canvas_revision: '5',
    items: [card('keep'), card('other')],
    reading_order: ['keep', 'other'],
  });
});

test('closing a chain of items that crosses the batch boundary closes all of them', () => {
  // x(n) が x(n-1) を指す鎖と、x12 を指す tail。関係を外す 12 件、関係を外す 1 件 + 閉じる 11 件、閉じる 2 件の
  // 3 つの束（版 3・4・5）。
  const hub = new CanvasHub(contract);
  addAll(hub, [
    card('x0'),
    ...Array.from({ length: 12 }, (_, n) =>
      card(x(n + 1), [], [{ kind: 'detail_of', target: x(n) }]),
    ),
    card('tail', [], [{ kind: 'detail_of', target: 'x12' }]),
  ]);
  assert.equal(hub.document.canvas_revision, '2');
  assert.equal(
    hub.removeItems(new Set(Array.from({ length: 13 }, (_, n) => x(n)))),
    '5',
  );
  assert.deepEqual(hub.document, {
    canvas_revision: '5',
    items: [card('tail')],
    reading_order: ['tail'],
  });
});

// 指定した回の apply を当てない（途中の束で失敗する場合）。
class FlakyHub extends CanvasHub {
  failOn: number | null = null;
  override apply(batch: CanvasOpBatch) {
    if (this.failOn !== null) {
      this.failOn -= 1;
      if (this.failOn === 0) {
        this.failOn = null;
        return { ok: false as const, reason: 'semantic' as const };
      }
    }
    return super.apply(batch);
  }
}

test('when a later batch fails, the closed part stays closed and the rest is closed again by the next turn or notice', async () => {
  for (const retry of ['turn', 'notice'] as const) {
    const hub = new FlakyHub(contract);
    const r = rig(hub);
    const turns: string[] = [];
    for (let n = 0; n < 13; n += 1)
      turns.push((await r.say('置いて', card(`c${n}`))).body.turn_id);
    assert.equal(hub.document.canvas_revision, '13');

    // 13 件を閉じる束（12 件・1 件）の 2 つ目を当てない: 1 つ目の 12 件は閉じたまま（版 14）、c12 が残る。
    hub.failOn = 2;
    assert.equal(
      r.routes.applyNotice(
        expired(
          turns.map((id) => ({
            item_kind: 'turn' as const,
            item_id: id,
          })) as RetentionNotice['items'],
        ),
      ),
      false,
    );
    assert.equal(hub.document.canvas_revision, '14');
    assert.deepEqual(
      hub.document.items.map((item) => item.item_id),
      ['c12'],
    );
    assert.equal(hub.placedAt('c0'), null);
    assert.equal(hub.placedAt('c11'), null);
    assert.equal(hub.placedAt('c12'), '13');
    assert.deepEqual(r.routes.boundItemIds(), ['c12']);

    if (retry === 'turn') {
      // 次の発言: fresh を置き（版 15）、続けて c12 を閉じ直す（版 16）。
      const next = await r.say('つぎ', card('fresh'));
      assert.equal(next.body.canvas?.canvas_revision, '15');
      assert.equal(hub.document.canvas_revision, '16');
      assert.deepEqual(
        hub.document.items.map((item) => item.item_id),
        ['fresh'],
      );
      assert.deepEqual(r.routes.boundItemIds(), ['fresh']);
    } else {
      // 次の知らせ（関係のない発言の期限切れ）: c12 を閉じ直す（版 15）。
      assert.equal(
        r.routes.applyNotice(
          expired([{ item_kind: 'turn', item_id: ID(0x999) }]),
        ),
        true,
      );
      assert.equal(hub.document.canvas_revision, '15');
      assert.deepEqual(hub.document.items, []);
      assert.deepEqual(r.routes.boundItemIds(), []);
    }
    assert.equal(hub.placedAt('c12'), null);
  }
});

test('an item closed by the AI or by the user drops its tie to the turn at once', async () => {
  const r = rig();
  await r.say('ひとつめ', card('alpha'));
  await r.say('ふたつめ', card('beta'));
  assert.deepEqual(r.routes.boundItemIds(), ['alpha', 'beta']);
  // AI の close（版 3）。
  const closed = await r.say('みっつめ', { close: 'alpha' });
  assert.equal(closed.body.canvas?.canvas_revision, '3');
  assert.deepEqual(r.routes.boundItemIds(), ['beta']);
  // ユーザーの閉じる操作（版 4）。
  await r.userClose('beta');
  assert.equal(r.canvas.document.canvas_revision, '4');
  assert.deepEqual(r.canvas.document.items, []);
  assert.deepEqual(r.routes.boundItemIds(), []);
});

test('a turn that expires while it is processed places nothing, and items pointing at gone turns or memories are closed at once', async () => {
  let expireNext = false;
  const r = rig(new CanvasHub(contract), (turnId) => {
    if (!expireNext) return;
    expireNext = false;
    // 発言の保存の後・配置の前に、その発言の期限切れの知らせが来る。
    assert.equal(
      r.routes.applyNotice(expired([{ item_kind: 'turn', item_id: turnId }])),
      true,
    );
  });
  await r.say('ひとつめ', card('alpha'));
  assert.equal(r.canvas.document.canvas_revision, '1');

  // 1. 処理中に消えた発言の結果は置かない（版 1 のまま）。同じ要求の再送でも置かない。
  expireNext = true;
  const lost = await r.say('ふたつめ', card('beta'));
  assert.equal(lost.body.canvas, null);
  assert.equal(r.canvas.document.canvas_revision, '1');
  assert.deepEqual(
    r.canvas.document.items.map((item) => item.item_id),
    ['alpha'],
  );
  const again = await r.say('ふたつめ', card('beta'), lost.requestId);
  assert.equal(again.body.turn_id, lost.body.turn_id);
  assert.equal(again.body.canvas, null);
  assert.equal(r.canvas.document.canvas_revision, '1');
  assert.deepEqual(r.routes.boundItemIds(), ['alpha']);

  // 2. 後の発言が置いた物が消えた発言を参照していたら、置いた直後に閉じる（置いて版 2、閉じて版 3）。
  const pointing = await r.say(
    'みっつめ',
    card('gamma', [{ kind: 'screen_result', id: lost.body.turn_id }]),
  );
  assert.equal(pointing.body.canvas?.canvas_revision, '2');
  assert.equal(r.canvas.document.canvas_revision, '3');
  assert.deepEqual(
    r.canvas.document.items.map((item) => item.item_id),
    ['alpha'],
  );

  // 3. 忘れた記憶を参照する物も、置いた直後に閉じる（版 4・5）。
  const memory = ID(0x700);
  r.routes.applyNotice({
    ...expired([{ item_kind: 'memory', item_id: memory }]),
    kind: 'forgotten',
    reason: 'forgotten',
    forgetting_generation: '1',
  });
  assert.equal(r.canvas.document.canvas_revision, '3');
  const remembered = await r.say(
    'よっつめ',
    card('delta', [{ kind: 'memory', id: memory }]),
  );
  assert.equal(remembered.body.canvas?.canvas_revision, '4');
  assert.equal(r.canvas.document.canvas_revision, '5');
  assert.deepEqual(
    r.canvas.document.items.map((item) => item.item_id),
    ['alpha'],
  );
  assert.deepEqual(r.routes.boundItemIds(), ['alpha']);
});

test('a late result of a gone turn is not placed while the turn is remembered; the list keeps the newest 256 turns', () => {
  const r = rig();
  const lateTurn = (turnId: string) =>
    ({
      request_id: ID(0x800),
      turn_id: turnId,
      input_id: ID(0x802),
      workflow_id: ID(0x803),
      status: 'answered',
      result_view: null,
      reply_text: '合成の答え',
    }) as unknown as TurnResponse;
  const others = (from: number, count: number) =>
    expired(
      Array.from({ length: count }, (_, n) => ({
        item_kind: 'turn' as const,
        item_id: ID(from + n),
      })) as RetentionNotice['items'],
    );
  // 消えた発言 L1 の後に 255 件: L1 を含めて 256 件なので、L1 の遅着の結果は置かない。
  r.routes.applyNotice(expired([{ item_kind: 'turn', item_id: ID(0xb01) }]));
  r.routes.applyNotice(others(0x10000, 255));
  assert.equal(r.routes.placeLate(lateTurn(ID(0xb01)), null), null);
  assert.equal(r.canvas.document.canvas_revision, '0');
  // 消えた発言 L2 の後に 256 件: L2 は一覧から外れているので、遅着の結果を置く（版 1）。
  r.routes.applyNotice(expired([{ item_kind: 'turn', item_id: ID(0xb02) }]));
  r.routes.applyNotice(others(0x20000, 256));
  assert.equal(
    r.routes.placeLate(lateTurn(ID(0xb02)), null)?.canvas_revision,
    '1',
  );
  assert.equal(r.canvas.document.canvas_revision, '1');
});
