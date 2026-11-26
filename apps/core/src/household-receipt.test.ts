// レシートの写真の読み取りの経路（ADR 0177）の試験。画像は合成のバイト列（JPEG の頭と大きさだけ）で、本物の写真は使わない。
// 外部のモデルは模擬の読み取りの口だけで、実 API は呼ばない。期待値はすべて手で書いた。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProfile, ModelUsage } from '@buddy/contracts';
import type { AdapterResult } from '@buddy/ai';
import { syntheticProfile } from '@buddy/ai/testing';
import type { SqliteDatabase } from '@buddy/storage';
import { createHouseholdRoutes } from './api-household.js';
import type { ApiRouteHandler } from './api-server.js';
import { uuid, withBudgetStore } from './budget-test-support.js';
import {
  HOUSEHOLD_RECEIPT_INSTRUCTIONS,
  createHouseholdReceiptRoutes,
  receiptBudgetOf,
} from './household-receipt.js';
import type {
  HouseholdReceiptOptions,
  ReceiptBudget,
  ReceiptBudgetOutcome,
  ReceiptImageReader,
  ReceiptReadCommand,
  ReceiptReadingSetup,
} from './household-receipt.js';
import type { JsonObject } from './strict-json.js';

type Json = Record<string, unknown>;

// 2030-11-26 12:00（東京）。
const NOW = Date.parse('2030-11-26T03:00:00.000Z');
const ZONE = 'Asia/Tokyo';

const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];

// 合成の JPEG の頭（SOI・SOF0・SOS・EOI）。size を指定すれば 0 で埋めてその長さにする。
function jpeg(width: number, height: number, size = 0): Uint8Array {
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
    ...be16(8),
    1,
    1,
    0,
    0,
    0x3f,
    0,
    0xff,
    0xd9,
  ];
  const out = new Uint8Array(Math.max(size, bytes.length));
  out.set(bytes);
  return out;
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52, 0, 0, 3, 0xc0, 0, 0, 5, 0, 8, 2, 0, 0, 0,
]);

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const IMAGE = jpeg(960, 1280, 2048);

const readBody = (
  requestId: string,
  bytes: Uint8Array = IMAGE,
): JsonObject => ({
  request_id: requestId,
  command_scope_id: uuid(900),
  image: { media_type: 'image/jpeg', data_base64: base64(bytes) },
});

const settingBody = (value: 'on' | 'off'): JsonObject => ({
  request_id: uuid(800),
  command_scope_id: uuid(900),
  receipt_reading: value,
});

const call = async (
  handler: ApiRouteHandler,
  body: JsonObject,
): Promise<{ status: number; body: Json }> => {
  const response = await handler({
    route: undefined as never,
    device: null,
    body,
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  return { status: response.status, body: response.body as Json };
};

const USAGE: ModelUsage = {
  input_tokens: 15,
  cached_input_tokens: 0,
  output_tokens: 5,
  reasoning_tokens: null,
  usage_complete: true,
};

const replyText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    readable: true,
    receipt_count: 1,
    currency: 'JPY',
    total: 1280,
    date: '2030-11-25',
    time: '12:34',
    merchant: '合成の商店',
    payment: '現金',
    items: [
      { name: 'おにぎり', amount: 300 },
      { name: 'お茶', amount: 980 },
    ],
    ...over,
  });

const response = (text: string, over: Partial<AdapterResult> = {}) =>
  ({
    kind: 'response',
    text,
    usage: USAGE,
    provider_request_id: 'synthetic-request-1',
    refused: false,
    truncated: false,
    ...over,
  }) as AdapterResult;

// 模擬の読み取りの口。受け取った命令と、受け取った時点の画像の写しを記録する。
class MockReader implements ReceiptImageReader {
  readonly commands: ReceiptReadCommand[] = [];
  readonly copies: Uint8Array[] = [];
  next: (cancellation: {
    readonly aborted: boolean;
  }) => Promise<AdapterResult> = () => Promise.resolve(response(replyText()));
  read(
    command: ReceiptReadCommand,
    cancellation: { readonly aborted: boolean },
  ): Promise<AdapterResult> {
    this.commands.push(command);
    this.copies.push(new Uint8Array(command.image.bytes));
    return this.next(cancellation);
  }
}

// 模擬の予算の門。send を一度だけ呼ぶ。plan で受付の拒否・解放を決める。
class MockBudget implements ReceiptBudget {
  readonly runs: string[] = [];
  plan: 'send' | 'held' | 'denied' | 'released' = 'send';
  async run(
    requestId: string,
    send: (signal: AbortSignal) => Promise<{ usage: ModelUsage | null }>,
    signal: AbortSignal,
  ): Promise<ReceiptBudgetOutcome> {
    this.runs.push(requestId);
    if (this.plan === 'held') return { kind: 'rejected', budget_held: true };
    if (this.plan === 'denied') return { kind: 'rejected', budget_held: false };
    if (this.plan === 'released' || signal.aborted) return { kind: 'released' };
    try {
      const sent = await send(signal);
      return sent.usage === null
        ? { kind: 'usage_unknown' }
        : { kind: 'settled' };
    } catch {
      return { kind: 'usage_unknown' };
    }
  }
}

const profile = (over: Partial<ModelProfile> = {}): ModelProfile =>
  syntheticProfile({
    profile_id: 'receipt.synthetic.v1',
    role: 'background_text',
    output_limit_tokens: 10,
    ...over,
  });

function setupOf(
  reader: ReceiptImageReader,
  over: Partial<ReceiptReadingSetup> = {},
): ReceiptReadingSetup {
  return {
    reader,
    profile: profile(),
    profile_revision: '1',
    price_key: 'synthetic.text',
    max_input_tokens: 20,
    ...over,
  };
}

function harness(over: Partial<HouseholdReceiptOptions> = {}) {
  const reader = new MockReader();
  const budget = new MockBudget();
  const routes = createHouseholdReceiptRoutes({
    setup: setupOf(reader),
    budget,
    zone: () => ZONE,
    now: () => NOW,
    ...over,
  });
  const on = () =>
    call(routes.handlers.changeHouseholdReceiptSetting, settingBody('on'));
  const off = () =>
    call(routes.handlers.changeHouseholdReceiptSetting, settingBody('off'));
  const read = (requestId: string, bytes?: Uint8Array) =>
    call(routes.handlers.readHouseholdReceipt, readBody(requestId, bytes));
  return { reader, budget, routes, on, off, read };
}

const CANDIDATE = {
  result: 'candidate',
  candidate: {
    amount_yen: 1280,
    occurred_on: '2030-11-25',
    occurred_time: '12:34',
    merchant: '合成の商店',
    payment: '現金',
  },
  reasons: [],
};

test('既定は切で、切のあいだは予算の受付も送信もしない', async () => {
  const h = harness();
  assert.equal(h.routes.state(), 'off');
  const result = await h.read(uuid(1));
  assert.equal(result.status, 403);
  assert.equal(result.body['code'], 'external_send_consent_required');
  assert.equal(h.reader.commands.length, 0);
  assert.equal(h.budget.runs.length, 0);
  // 入にしてから切に戻しても送らない。
  assert.deepEqual((await h.on()).body, { receipt_reading: 'on' });
  assert.deepEqual((await h.off()).body, { receipt_reading: 'off' });
  assert.equal((await h.read(uuid(2))).status, 403);
  assert.equal(h.reader.commands.length, 0);
});

test('読み取りの口がなければ unavailable で、入にもできず送らない', async () => {
  for (const options of [
    { setup: null, budget: null },
    // 出力の上限が決まっていない profile は予約の最大負担を決められない。
    {
      setup: setupOf(new MockReader(), {
        profile: profile({ output_limit_tokens: null }),
      }),
    },
    { setup: setupOf(new MockReader(), { max_input_tokens: 0 }) },
  ]) {
    const h = harness(options);
    assert.equal(h.routes.state(), 'unavailable');
    const on = await h.on();
    assert.equal(on.status, 503);
    assert.equal(h.routes.state(), 'unavailable');
    assert.equal((await h.read(uuid(1))).status, 503);
    assert.equal(h.budget.runs.length, 0);
  }
  // 家計簿の経路に読み取りを渡さなければ、月ごとの合計の設定も unavailable で、読み取りは 503。
  const plain = createHouseholdRoutes({
    store: undefined as never,
    dataKey: () => Promise.resolve(null),
    zone: () => ZONE,
    now: () => NOW,
  });
  assert.equal(
    (await call(plain.handlers.readHouseholdReceipt, readBody(uuid(3)))).status,
    503,
  );
});

test('入にすると写真 1 枚を 1 回だけ送り、候補を返して画像を捨てる', async () => {
  const h = harness();
  await h.on();
  const result = await h.read(uuid(1));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, CANDIDATE);
  assert.equal(h.budget.runs.length, 1);
  assert.equal(h.reader.commands.length, 1);
  const command = h.reader.commands[0] as ReceiptReadCommand;
  assert.equal(command.request_id, uuid(1));
  assert.equal(command.profile.profile_id, 'receipt.synthetic.v1');
  assert.equal(command.instructions, HOUSEHOLD_RECEIPT_INSTRUCTIONS);
  assert.equal(command.image.media_type, 'image/jpeg');
  // 送った時点の画像は本人が選んだ（端末が縮めた）画像と同じ。処理の後は 0 で埋めて捨てている。
  assert.deepEqual(h.reader.copies[0], IMAGE);
  assert.equal(command.image.bytes.length, IMAGE.length);
  assert.ok(command.image.bytes.every((byte) => byte === 0));
});

test('同じ要求は二度送らない（結果不明の後も、送り直さない）', async () => {
  const h = harness();
  await h.on();
  assert.equal((await h.read(uuid(1))).status, 200);
  const again = await h.read(uuid(1));
  assert.equal(again.status, 409);
  assert.equal(h.reader.commands.length, 1);
  // 応答が届かなかった（timeout）: 結果不明の 503。同じ要求はもう送らない。
  h.reader.next = () => Promise.resolve({ kind: 'timeout', usage: null });
  const lost = await h.read(uuid(2));
  assert.equal(lost.status, 503);
  assert.equal(lost.body['code'], 'dependency_unavailable');
  assert.equal(h.reader.commands.length, 2);
  assert.equal((await h.read(uuid(2))).status, 409);
  assert.equal(h.reader.commands.length, 2);
  // 読み取りの口が例外を投げた・利用不可も結果不明で、送り直さない。
  h.reader.next = () => Promise.reject(new Error('lost'));
  assert.equal((await h.read(uuid(3))).status, 503);
  h.reader.next = () => Promise.resolve({ kind: 'unavailable', usage: null });
  assert.equal((await h.read(uuid(4))).status, 503);
  assert.equal(h.reader.commands.length, 4);
});

test('読み取り中の二つ目の要求は受けない', async () => {
  const h = harness();
  await h.on();
  let finish: (value: AdapterResult) => void = () => undefined;
  h.reader.next = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = h.read(uuid(1));
  await new Promise((resolve) => setImmediate(resolve));
  const second = await h.read(uuid(2));
  assert.equal(second.status, 409);
  finish(response(replyText()));
  assert.deepEqual((await first).body, CANDIDATE);
  assert.equal(h.reader.commands.length, 1);
});

test('予算を予約できなければ送らない', async () => {
  const h = harness();
  await h.on();
  h.budget.plan = 'held';
  const held = await h.read(uuid(1));
  assert.equal(held.status, 422);
  assert.equal(held.body['code'], 'budget_held');
  h.budget.plan = 'denied';
  assert.equal((await h.read(uuid(2))).status, 503);
  h.budget.plan = 'released';
  assert.equal((await h.read(uuid(3))).status, 503);
  assert.equal(h.reader.commands.length, 0);
});

test('保存期限の掃除の門が閉じている・今日が決まらないときは送らない', async () => {
  let open = false;
  let leases = 0;
  let released = 0;
  const h = harness({
    cloudGate: {
      ready: () => Promise.resolve(),
      open: () => open,
      lease: () => {
        if (!open) return null;
        leases += 1;
        return () => {
          released += 1;
        };
      },
    },
  });
  await h.on();
  assert.equal((await h.read(uuid(1))).status, 503);
  assert.equal(h.budget.runs.length, 0);
  open = true;
  assert.equal((await h.read(uuid(2))).status, 200);
  // 貸し出しは読み取りの終わりに返す。
  assert.equal(leases, 1);
  assert.equal(released, 1);
  const noZone = harness({ zone: () => null });
  await noZone.on();
  assert.equal((await noZone.read(uuid(3))).status, 503);
  assert.equal(noZone.budget.runs.length, 0);
});

test('門を待つ間・読み取り中に切にすると、送らない・結果を捨てる', async () => {
  // 掃除の門を待つ間に切にした: 送らない（予算の受付もしない）。
  let unblock: () => void = () => undefined;
  const waiting = harness({
    cloudGate: {
      ready: () =>
        new Promise<void>((resolve) => {
          unblock = resolve;
        }),
      open: () => true,
      lease: () => () => undefined,
    },
  });
  await waiting.on();
  const pending = waiting.read(uuid(1));
  await new Promise((resolve) => setImmediate(resolve));
  await waiting.off();
  unblock();
  const stopped = await pending;
  assert.equal(stopped.status, 403);
  assert.equal(waiting.budget.runs.length, 0);
  assert.equal(waiting.reader.commands.length, 0);
  // 読み取り中に切にした: 中断を読み取りの口へ伝え、届いた結果は候補にしない（結果不明の 503）。
  const h = harness();
  await h.on();
  let seen: { readonly aborted: boolean } | null = null;
  let finish: () => void = () => undefined;
  h.reader.next = (cancellation) => {
    seen = cancellation;
    return new Promise((resolve) => {
      finish = () => resolve(response(replyText()));
    });
  };
  const running = h.read(uuid(2));
  await new Promise((resolve) => setImmediate(resolve));
  await h.off();
  assert.equal((seen as { readonly aborted: boolean } | null)?.aborted, true);
  finish();
  const discarded = await running;
  assert.equal(discarded.status, 503);
  assert.equal(h.routes.state(), 'off');
});

test('外部へ送る画像の上限を超えるものは送らない', async () => {
  const h = harness();
  await h.on();
  const cases: [string, Uint8Array][] = [
    ['PNG', PNG],
    ['180 KiB を 1 バイト超える', jpeg(960, 1280, 184_321)],
    ['長い辺が 1601', jpeg(1200, 1601)],
    ['短い辺が 63', jpeg(63, 1200)],
    ['壊れた JPEG', jpeg(960, 1280).subarray(0, 10)],
  ];
  let n = 10;
  for (const [name, bytes] of cases) {
    n += 1;
    const result = await h.read(uuid(n), bytes);
    assert.equal(result.status, 422, name);
    assert.equal(result.body['code'], 'invalid_input', name);
  }
  // ちょうど 180 KiB・長い辺 1600 は送る。
  assert.equal((await h.read(uuid(30), jpeg(1200, 1600, 184_320))).status, 200);
  assert.equal(h.reader.commands.length, 1);
});

test('応答は信用しない入力として確かめ直し、読めない・矛盾する結果は候補にしない', async () => {
  const h = harness();
  await h.on();
  const cases: [string, AdapterResult, Json][] = [
    [
      '断った',
      response('', { refused: true }),
      { result: 'not_candidate', candidate: null, reasons: ['refused'] },
    ],
    [
      '打ち切られた',
      response(replyText(), { truncated: true }),
      { result: 'not_candidate', candidate: null, reasons: ['reply_invalid'] },
    ],
    [
      'JSON でない',
      response('合計 1280 円'),
      { result: 'not_candidate', candidate: null, reasons: ['reply_invalid'] },
    ],
    [
      '同じキーが二つ',
      response('{"total":1,"total":2}'),
      { result: 'not_candidate', candidate: null, reasons: ['reply_invalid'] },
    ],
    [
      '外貨',
      response(replyText({ currency: 'USD' })),
      {
        result: 'not_candidate',
        candidate: null,
        reasons: ['currency_not_yen'],
      },
    ],
    [
      '金額が読めない',
      response(replyText({ total: null, items: [] })),
      {
        result: 'not_candidate',
        candidate: null,
        reasons: ['total_unreadable'],
      },
    ],
    [
      'カード番号らしい数字',
      response(replyText({ payment: 'VISA 4111 1111 1111 1111' })),
      { result: 'not_candidate', candidate: null, reasons: ['long_digits'] },
    ],
    [
      '合計と品目の食い違い',
      response(replyText({ total: 1300 })),
      {
        result: 'not_candidate',
        candidate: null,
        reasons: ['items_total_mismatch'],
      },
    ],
    [
      '明日の日付は空にする',
      response(replyText({ date: '2030-11-27' })),
      {
        ...CANDIDATE,
        candidate: { ...CANDIDATE.candidate, occurred_on: null },
      },
    ],
  ];
  let n = 40;
  for (const [name, reply, expected] of cases) {
    n += 1;
    h.reader.next = () => Promise.resolve(reply);
    const result = await h.read(uuid(n));
    assert.equal(result.status, 200, name);
    assert.deepEqual(result.body, expected, name);
  }
});

test('月ごとの合計の設定は読み取りの経路の今の値', () => {
  const h = harness();
  assert.equal(h.routes.state(), 'off');
  void h.on();
  assert.equal(h.routes.state(), 'on');
});

// 予算の門（BudgetGate）につないだ口。合成の設定は入力・出力とも 1 token 1 単位、LLM の本人の依頼の枠は 100。
const rowsOf = (db: SqliteDatabase) =>
  db
    .prepare(
      'SELECT request_id, pool_id, status, max_liability, actual_gross, dispatch_intent_at FROM budget_reservations ORDER BY created_at, request_id',
    )
    .all() as {
    request_id: string;
    pool_id: string;
    status: string;
    max_liability: number;
    actual_gross: number | null;
    dispatch_intent_at: number | null;
  }[];

test('予算の門: 予約して 1 回送り、usage で精算し、分からなければ予約を保持する', async () => {
  await withBudgetStore(async (harness) => {
    const gate = harness.gate();
    await gate.start();
    const reader = new MockReader();
    const setup = setupOf(reader);
    const budget = receiptBudgetOf(gate, setup);
    const routes = createHouseholdReceiptRoutes({
      setup,
      budget,
      zone: () => ZONE,
      now: () => harness.clock.now(),
    });
    await call(
      routes.handlers.changeHouseholdReceiptSetting,
      settingBody('on'),
    );
    // 2030-10-15 の東京は今日が 10-15 なので、日付 10-14 の応答を使う。
    reader.next = () =>
      Promise.resolve(response(replyText({ date: '2030-10-14' })));
    const ok = await call(
      routes.handlers.readHouseholdReceipt,
      readBody(uuid(1)),
    );
    assert.equal(ok.status, 200);
    assert.equal((ok.body['candidate'] as Json)['occurred_on'], '2030-10-14');
    // 結果が分からない（timeout）: 予約を保持し、送り直さない。
    reader.next = () => Promise.resolve({ kind: 'timeout', usage: null });
    const lost = await call(
      routes.handlers.readHouseholdReceipt,
      readBody(uuid(2)),
    );
    assert.equal(lost.status, 503);
    // usage が不完全なら 0 円にせず、予約を保持する。
    reader.next = () =>
      Promise.resolve(
        response(replyText({ date: '2030-10-14' }), {
          usage: { ...USAGE, usage_complete: false },
        }),
      );
    const partial = await call(
      routes.handlers.readHouseholdReceipt,
      readBody(uuid(3)),
    );
    // 応答は届いたので候補は返す（費用は本人の手での精算に回る）。
    assert.equal(partial.status, 200);
    assert.equal(reader.commands.length, 3);
    // M = 入力 20 + 出力 10 = 30。実費 = 入力 15 + 出力 5 = 20。
    const rows = harness.sql(rowsOf);
    assert.deepEqual(
      rows.map((row) => [
        row.request_id,
        row.pool_id,
        row.status,
        row.max_liability,
        row.actual_gross,
        row.dispatch_intent_at !== null,
      ]),
      [
        [uuid(1), 'llm', 'settled', 30, 20, true],
        [uuid(2), 'llm', 'usage_unknown', 30, null, true],
        [uuid(3), 'llm', 'usage_unknown', 30, null, true],
      ],
    );
    // 予約の最大負担（入力 95 + 出力 10 = 105）が LLM の枠（100）を超える設定では受け付けず、送らない。
    const large = setupOf(reader, { max_input_tokens: 95 });
    const largeRoutes = createHouseholdReceiptRoutes({
      setup: large,
      budget: receiptBudgetOf(gate, large),
      zone: () => ZONE,
      now: () => harness.clock.now(),
    });
    await call(
      largeRoutes.handlers.changeHouseholdReceiptSetting,
      settingBody('on'),
    );
    const denied = await call(
      largeRoutes.handlers.readHouseholdReceipt,
      readBody(uuid(4)),
    );
    assert.equal(denied.status, 422);
    assert.equal(denied.body['code'], 'budget_held');
    assert.equal(reader.commands.length, 3);
  });
});
