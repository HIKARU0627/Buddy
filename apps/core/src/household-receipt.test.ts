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
import { loadedConfig, uuid, withBudgetStore } from './budget-test-support.js';
import { RetentionSweeper } from './retention-sweeper.js';
import type { RetentionSweepPort } from './retention-sweeper.js';
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

// 合成の JPEG の頭（SOI・SOF0・SOS・EOI）。size を指定すれば、走査のデータ（SOS と EOI の間）を 0 で埋めてその長さに
// する（EOI の後ろにバイトを付けない）。
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
  ];
  const out = new Uint8Array(Math.max(size, bytes.length + 2));
  out.set(bytes);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

// 合成の JPEG の SOI の直後に区切り（marker と中身）を差し込む。
function withSegment(marker: number, payload: readonly number[]): Uint8Array {
  const base = jpeg(960, 1280);
  return new Uint8Array([
    ...base.subarray(0, 2),
    0xff,
    marker,
    ...be16(payload.length + 2),
    ...payload,
    ...base.subarray(2),
  ]);
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
  signal?: AbortSignal,
  receivedAt?: number,
): Promise<{ status: number; body: Json }> => {
  const request = {
    route: undefined as never,
    device: null,
    body,
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
    ...(signal === undefined ? {} : { signal }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
  } as Parameters<ApiRouteHandler>[0];
  const response = await handler(request);
  return { status: response.status, body: response.body as Json };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));
// 条件がそろうまで待つ（時間ではなく状態で待つ。そろわなければ上限で失敗させる）。
async function waitFor(
  condition: () => boolean,
  label: string,
  limitMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > limitMs) assert.fail(`待ちの上限: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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

// 模擬の予算の門。send を一度だけ呼ぶ。plan で受付の拒否・解放を決める。admission を渡すと、受付（DB の記録）に時間が
// かかったものとして、それが終わるまで送出意図の前で待つ。race なら、send の結果を待たずに中断・時間切れとして返す
// （BudgetGate.run の race が先に返ったときと同じ。送っている途中の読み取りは続く）。
class MockBudget implements ReceiptBudget {
  readonly runs: string[] = [];
  plan: 'send' | 'held' | 'denied' | 'released' | 'race' = 'send';
  admission: Promise<void> | null = null;
  async run(
    requestId: string,
    send: (signal: AbortSignal) => Promise<{ usage: ModelUsage | null }>,
    signal: AbortSignal,
  ): Promise<ReceiptBudgetOutcome> {
    this.runs.push(requestId);
    if (this.plan === 'held') return { kind: 'rejected', budget_held: true };
    if (this.plan === 'denied') return { kind: 'rejected', budget_held: false };
    if (this.admission !== null) await this.admission;
    if (this.plan === 'released' || signal.aborted) return { kind: 'released' };
    if (this.plan === 'race') {
      void send(signal).catch(() => undefined);
      return { kind: 'usage_unknown' };
    }
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

function harness(
  over: Partial<HouseholdReceiptOptions> = {},
  setupOver: Partial<ReceiptReadingSetup> = {},
) {
  const reader = new MockReader();
  const budget = new MockBudget();
  const routes = createHouseholdReceiptRoutes({
    setup: setupOf(reader, setupOver),
    budget,
    zone: () => ZONE,
    now: () => NOW,
    ...over,
  });
  const on = () =>
    call(routes.handlers.changeHouseholdReceiptSetting, settingBody('on'));
  const off = () =>
    call(routes.handlers.changeHouseholdReceiptSetting, settingBody('off'));
  const read = (
    requestId: string,
    bytes?: Uint8Array,
    signal?: AbortSignal,
    receivedAt?: number,
  ) =>
    call(
      routes.handlers.readHouseholdReceipt,
      readBody(requestId, bytes),
      signal,
      receivedAt,
    );
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
  // 予算の門が受け付けなかった・送出意図の前に解放した: 送っていないので not_sent（結果不明の 503 と分ける）。
  h.budget.plan = 'denied';
  const denied = await h.read(uuid(2));
  assert.equal(denied.status, 503);
  assert.equal(denied.body['code'], 'not_sent');
  h.budget.plan = 'released';
  const released = await h.read(uuid(3));
  assert.equal(released.status, 503);
  assert.equal(released.body['code'], 'not_sent');
  assert.equal(h.reader.commands.length, 0);
});

test('保存期限の掃除の門は待たず、送れなければ送らずに 503 not_sent', async () => {
  let open = false;
  let sweeping = false;
  let leases = 0;
  let released = 0;
  let waited = 0;
  // 掃除が済むまで待つ口（ready）があっても呼ばない。呼べば終わらない待ちになる。
  const gate = {
    ready: () => {
      waited += 1;
      return new Promise<void>(() => undefined);
    },
    open: () => open,
    lease: () => {
      if (!open || sweeping) return null;
      leases += 1;
      return () => {
        released += 1;
      };
    },
  };
  const h = harness({ cloudGate: gate });
  await h.on();
  // ゲートが閉じている。
  const closed = await h.read(uuid(1));
  assert.equal(closed.status, 503);
  assert.equal(closed.body['code'], 'not_sent');
  // ゲートは開いているが掃除の途中（貸し出しを取れない）。
  open = true;
  sweeping = true;
  const busy = await h.read(uuid(2));
  assert.equal(busy.status, 503);
  assert.equal(busy.body['code'], 'not_sent');
  assert.equal(h.budget.runs.length, 0);
  assert.equal(h.reader.commands.length, 0);
  sweeping = false;
  assert.equal((await h.read(uuid(3))).status, 200);
  assert.equal(waited, 0);
  // 貸し出しは読み取りの終わりに返す。
  assert.equal(leases, 1);
  assert.equal(released, 1);
  const noZone = harness({ zone: () => null });
  await noZone.on();
  const today = await noZone.read(uuid(4));
  assert.equal(today.status, 503);
  assert.equal(today.body['code'], 'not_sent');
  assert.equal(noZone.budget.runs.length, 0);
});

test('端末が接続を切ったら、送出意図の前なら送らない', async () => {
  const h = harness();
  await h.on();
  let admit: () => void = () => undefined;
  h.budget.admission = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const client = new AbortController();
  const pending = h.read(uuid(1), undefined, client.signal);
  await tick();
  assert.equal(h.budget.runs.length, 1);
  // 予算の門の受付の途中で端末が待つのをやめた（接続を切った）。
  client.abort();
  admit();
  const result = await pending;
  assert.equal(result.status, 503);
  assert.equal(result.body['code'], 'not_sent');
  assert.equal(h.reader.commands.length, 0);
  // 要求の前から切れていた接続も送らない（予算の門にも入らない）。
  const gone = new AbortController();
  gone.abort();
  h.budget.admission = null;
  const early = await h.read(uuid(2), undefined, gone.signal);
  assert.equal(early.body['code'], 'not_sent');
  assert.equal(h.budget.runs.length, 1);
  assert.equal(h.reader.commands.length, 0);
  // 切らなければ送る。
  assert.equal(
    (await h.read(uuid(3), undefined, new AbortController().signal)).status,
    200,
  );
  assert.equal(h.reader.commands.length, 1);
});

test('送り始めるまでの期限を過ぎたら送らない', async () => {
  const h = harness({ preDispatchMs: 20 } as Partial<HouseholdReceiptOptions>);
  await h.on();
  // 予算の門の受付が期限より長くかかった。
  h.budget.admission = sleep(80);
  const late = await h.read(uuid(1));
  assert.equal(late.status, 503);
  assert.equal(late.body['code'], 'not_sent');
  assert.equal(h.reader.commands.length, 0);
  // 期限の前に送り始めたら、読み取りが期限より長くかかっても止めない（読み取りの期限は予算の門が持つ）。
  h.budget.admission = null;
  h.reader.next = async () => {
    await sleep(80);
    return response(replyText());
  };
  const slow = await h.read(uuid(2));
  assert.equal(slow.status, 200);
  assert.deepEqual(slow.body, CANDIDATE);
});

test('送り始めるまでの期限は、経路の処理を始めた時刻ではなく要求が届いた時刻から数える', async () => {
  // 単調時計は試験が決める（要求が届いた時刻と比べる時計）。期限は 100 ms。
  let clock = 1_000;
  const h = harness({ preDispatchMs: 100, monotonicNow: () => clock });
  await h.on();
  // 要求が届いてから 150 ms たって経路の処理を始めた（本文の受け取り・経路の検査が遅れた）: 予算の門にも入らない。
  const late = await h.read(uuid(1), undefined, undefined, clock - 150);
  assert.equal(late.status, 503);
  assert.equal(late.body['code'], 'not_sent');
  assert.equal(h.budget.runs.length, 0);
  // 届いてから 80 ms たって始めた: 残りは 20 ms。予算の門の受付に 100 ms かかると送らない（経路の処理を始めた時刻から
  // 数えると 100 ms の期限の内に見えるが、届いた時刻からは過ぎている）。
  clock = 2_000;
  h.budget.admission = sleep(100);
  const slow = await h.read(uuid(2), undefined, undefined, clock - 80);
  assert.equal(slow.status, 503);
  assert.equal(slow.body['code'], 'not_sent');
  assert.equal(h.reader.commands.length, 0);
  // 届いた直後に始めたなら送る。
  h.budget.admission = null;
  const fresh = await h.read(uuid(3), undefined, undefined, clock);
  assert.equal(fresh.status, 200);
  assert.equal(h.reader.commands.length, 1);
});

test('中枢の受付の期限で端末の時間切れとの関係が破れるなら、読み取りは使えない', async () => {
  const logs: string[] = [];
  // 既定（requestTimeout 15 秒・確かめる間隔 30 秒）なら使える。
  const fits = harness({
    requestLimits: {
      requestTimeoutMs: 15_000,
      connectionsCheckingIntervalMs: 30_000,
    },
    log: (message) => logs.push(message),
  });
  assert.equal(fits.routes.state(), 'off');
  assert.equal(logs.length, 0);
  // requestTimeout を 45 秒に上書きすると 45 + 30 + 10 + 60 + 5 = 150 秒で、端末の 150 秒に収まらない。期限なし（0）も同じ。
  for (const requestTimeoutMs of [45_000, 0]) {
    const broken = harness({
      requestLimits: {
        requestTimeoutMs,
        connectionsCheckingIntervalMs: 30_000,
      },
      log: (message) => logs.push(message),
    });
    assert.equal(broken.routes.state(), 'unavailable');
    assert.equal((await broken.on()).status, 503);
    assert.equal((await broken.read(uuid(1))).status, 503);
    assert.equal(broken.budget.runs.length, 0);
  }
  assert.deepEqual(logs, [
    '家計簿のレシートの写真の読み取りを使えなくしました（receipt_timing_exceeds_client_timeout）。',
    '家計簿のレシートの写真の読み取りを使えなくしました（receipt_timing_exceeds_client_timeout）。',
  ]);
});

test('読み取りの期限が 60 秒を超える profile は使わない', () => {
  const over = harness({
    setup: setupOf(new MockReader(), {
      profile: profile({ timeout_ms: 60_001 }),
    }),
  });
  assert.equal(over.routes.state(), 'unavailable');
  const limit = harness({
    setup: setupOf(new MockReader(), {
      profile: profile({ timeout_ms: 60_000 }),
    }),
  });
  assert.equal(limit.routes.state(), 'off');
});

test('読み取り中に切にすると、中断を伝えて結果を捨てる', async () => {
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
  await tick();
  await h.off();
  assert.equal((seen as { readonly aborted: boolean } | null)?.aborted, true);
  finish();
  const discarded = await running;
  assert.equal(discarded.status, 503);
  assert.equal(discarded.body['code'], 'dependency_unavailable');
  assert.equal(h.routes.state(), 'off');
});

test('予算の門が先に返っても、読み取りが終わるまで画像を埋めず貸し出しも返さない', async () => {
  let released = 0;
  const gate = {
    open: () => true,
    lease: () => () => {
      released += 1;
    },
  };
  const h = harness({ cloudGate: gate });
  await h.on();
  h.budget.plan = 'race';
  let finish: () => void = () => undefined;
  h.reader.next = () =>
    new Promise((resolve) => {
      finish = () => resolve({ kind: 'timeout', usage: null });
    });
  const result = await h.read(uuid(1));
  // 予算の門は時間切れ・中断として先に返った（結果不明）。読み取りの口はまだ画像を読んでいる。
  assert.equal(result.status, 503);
  assert.equal(result.body['code'], 'dependency_unavailable');
  const command = h.reader.commands[0] as ReceiptReadCommand;
  assert.deepEqual(command.image.bytes, IMAGE);
  assert.equal(released, 0);
  // 読み取りが終わるまでは次の読み取りも受けない。
  assert.equal((await h.read(uuid(2))).status, 409);
  finish();
  await tick();
  assert.ok(command.image.bytes.every((byte) => byte === 0));
  assert.equal(released, 1);
  h.budget.plan = 'send';
  h.reader.next = () => Promise.resolve(response(replyText()));
  assert.equal((await h.read(uuid(3))).status, 200);
});

// 中断に応じず、いつまでも返らない読み取りの口（約束を守らない実装）。
const neverReturns = (): Promise<AdapterResult> =>
  new Promise<AdapterResult>(() => undefined);

test('読み取りの口が中断に応じず返らなくても、待つ上限を過ぎたら画像を埋め、貸し出しを返し、次の読み取りを受ける', async () => {
  let released = 0;
  const logs: string[] = [];
  const gate = {
    open: () => true,
    lease: () => () => {
      released += 1;
    },
  };
  // 読み取りの期限 30 ms、返らない口を待つ猶予 20 ms（送り始めてから 50 ms で待つのをやめる）。
  const h = harness(
    {
      cloudGate: gate,
      returnGraceMs: 20,
      log: (message) => logs.push(message),
    },
    { profile: profile({ timeout_ms: 30 }) },
  );
  await h.on();
  h.budget.plan = 'race';
  let cancelled: { readonly aborted: boolean } | null = null;
  h.reader.next = (cancellation) => {
    cancelled = cancellation;
    return neverReturns();
  };
  const result = await h.read(uuid(1));
  assert.equal(result.status, 503);
  assert.equal(result.body['code'], 'dependency_unavailable');
  const command = h.reader.commands[0] as ReceiptReadCommand;
  // 上限の前は、まだ口が画像を読んでいる扱い。
  assert.deepEqual(command.image.bytes, IMAGE);
  assert.equal(released, 0);
  assert.equal((await h.read(uuid(2))).status, 409);
  // 上限を過ぎると、口が返らないままでも、画像を 0 で埋め、貸し出しを返す。
  await waitFor(() => released === 1, '貸し出しを返す');
  assert.ok(command.image.bytes.every((byte) => byte === 0));
  assert.notEqual(cancelled, null);
  // 記録は理由の名前だけで、画像・応答の中身は出さない。
  assert.deepEqual(logs, [
    '家計簿のレシートの写真の読み取りの口が期限を過ぎても返らないため、待つのをやめました（reader_not_returned）。',
  ]);
  // 次の読み取りを受ける。
  h.budget.plan = 'send';
  h.reader.next = () => Promise.resolve(response(replyText()));
  const next = await h.read(uuid(3));
  assert.equal(next.status, 200);
  assert.deepEqual(next.body, CANDIDATE);
  assert.equal(released, 2);
  // 返る口では記録を出さない。
  assert.equal(logs.length, 1);
});

// 保存期限の掃除の模擬の口（消すものがない DB）。
const emptySweepPort = (): RetentionSweepPort => ({
  readRows: () => Promise.resolve([]),
  eraseDueBodies: () =>
    Promise.resolve({ processed: [], skipped: [], next: null }),
  purgeDueOperations: () =>
    Promise.resolve({ processed: [], skipped: [], next: null }),
  purgeBudgetMonth: (month) =>
    Promise.resolve({
      budget_month: month,
      deleted_live_sessions: 0,
      deleted_approvals: 0,
      deleted_reservations: 0,
    }),
  purgeUndoRecords: () => Promise.resolve({ purged: 0 }),
  checkpoint: () =>
    Promise.resolve({ busy: 0, log_frames: 0, checkpointed_frames: 0 }),
  vacuum: () => Promise.resolve(),
});

test('返らない読み取りの口でも、保存期限の掃除の門が閉じたままにならない（実際の RetentionSweeper）', async () => {
  const sweeper = new RetentionSweeper({
    port: emptySweepPort(),
    epoch: 'boot-1',
    now: () => NOW,
    vacuumIntervalMs: 0,
  });
  await sweeper.runOnce(true);
  assert.equal(sweeper.gate().cloud_send, true);
  const h = harness(
    {
      cloudGate: {
        open: () => sweeper.gate().cloud_send,
        lease: () => sweeper.lease(),
      },
      returnGraceMs: 20,
    },
    { profile: profile({ timeout_ms: 30 }) },
  );
  await h.on();
  h.budget.plan = 'race';
  h.reader.next = neverReturns;
  assert.equal((await h.read(uuid(1))).status, 503);
  // 貸し出し中に始まった定期の掃除は、貸し出しが返るまで本体に入らず、その間はゲートが閉じる。
  const sweep = sweeper.runOnce(true);
  assert.equal(sweeper.gate().cloud_send, false);
  // 読み取りの口が返らなくても、待つ上限を過ぎれば貸し出しが返り、掃除が終わってゲートが開く。
  let timer: NodeJS.Timeout | undefined;
  const record = await Promise.race([
    sweep,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 5_000);
    }),
  ]);
  clearTimeout(timer);
  assert.notEqual(record, null, '掃除が貸し出しを待ったまま終わらない');
  assert.equal(record?.status, 'completed');
  assert.equal(sweeper.gate().cloud_send, true);
  // 次の読み取りも送れる。
  h.budget.plan = 'send';
  h.reader.next = () => Promise.resolve(response(replyText()));
  assert.equal((await h.read(uuid(2))).status, 200);
  sweeper.close();
  await sweeper.drain();
});

test('画像は失敗・例外・時間切れ・送らなかった経路でも 0 で埋める', async (t) => {
  // 中枢が base64 から作ったバイト列（読み取りの口へ渡る前のものも含む）を捕まえる。
  const decoded: Buffer[] = [];
  const original = Buffer.from.bind(Buffer);
  t.mock.method(Buffer, 'from', (...args: unknown[]) => {
    const made = (original as (...values: unknown[]) => Buffer)(...args);
    if (args[1] === 'base64') decoded.push(made);
    return made;
  });
  const zeroed = (label: string) => {
    const last = decoded.at(-1);
    assert.ok(last !== undefined && last.length === IMAGE.length, label);
    assert.ok(
      last.every((byte) => byte === 0),
      label,
    );
  };
  const h = harness();
  await h.on();
  h.reader.next = () => Promise.reject(new Error('lost'));
  assert.equal((await h.read(uuid(1))).status, 503);
  zeroed('読み取りの口の例外');
  h.reader.next = () => Promise.resolve({ kind: 'timeout', usage: null });
  assert.equal((await h.read(uuid(2))).status, 503);
  zeroed('時間切れ');
  h.reader.next = () => Promise.resolve(response('合計 1280 円'));
  assert.equal((await h.read(uuid(3))).status, 200);
  zeroed('読めない応答');
  h.budget.plan = 'held';
  assert.equal((await h.read(uuid(4))).status, 422);
  zeroed('予算の拒否（送っていない）');
  const noZone = harness({ zone: () => null });
  await noZone.on();
  assert.equal((await noZone.read(uuid(5))).status, 503);
  zeroed('今日が決まらない（送っていない）');
  const big = jpeg(960, 1280, 184_321);
  assert.equal((await h.read(uuid(6), big)).status, 422);
  const last = decoded.at(-1);
  assert.ok(last !== undefined && last.length === big.length);
  assert.ok(
    last.every((byte) => byte === 0),
    '画像の検査に合わない',
  );
  // 予算の門が例外を投げた。
  const throwing = harness({
    budget: {
      run: () => Promise.reject(new Error('db')),
    },
  });
  await throwing.on();
  assert.equal((await throwing.read(uuid(7))).status, 503);
  zeroed('予算の門の例外');
});

test('今日は応答が届いた後に決め直す（読み取りの間に日付が変わった）', async () => {
  // 送る前は 2030-11-26 23:59:59（東京）、応答の後は 2030-11-27 00:00:01。
  let clock = Date.parse('2030-11-26T14:59:59.000Z');
  const h = harness({ now: () => clock });
  await h.on();
  h.reader.next = () => {
    clock = Date.parse('2030-11-26T15:00:01.000Z');
    return Promise.resolve(response(replyText({ date: '2030-11-27' })));
  };
  const result = await h.read(uuid(1));
  assert.equal(result.status, 200);
  assert.equal((result.body['candidate'] as Json)['occurred_on'], '2030-11-27');
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
    // 中枢でも付帯情報を確かめ直す（APP1 の Exif・APP13 を SOI の直後に差し込む）。
    ['APP1 の Exif', withSegment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0])],
    ['APP13', withSegment(0xed, [0x50, 0x68, 0x6f, 0x74, 0x6f])],
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

test('予算の門: 送出意図の後に端末が接続を切ると、予約を usage 不明として残し、結果を捨てる', async () => {
  await withBudgetStore(async (harness) => {
    const gate = harness.gate();
    await gate.start();
    const reader = new MockReader();
    const setup = setupOf(reader);
    const routes = createHouseholdReceiptRoutes({
      setup,
      budget: receiptBudgetOf(gate, setup),
      zone: () => ZONE,
      now: () => harness.clock.now(),
    });
    await call(
      routes.handlers.changeHouseholdReceiptSetting,
      settingBody('on'),
    );
    // 読み取りの口は中断に応じて返る（約束どおりの口）。
    let reading: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let seen: { readonly aborted: boolean } | null = null;
    reader.next = (cancellation) => {
      seen = cancellation;
      reading();
      return new Promise<AdapterResult>((resolve) => {
        (cancellation as AbortSignal).addEventListener(
          'abort',
          () => resolve({ kind: 'cancelled', usage: null }),
          { once: true },
        );
      });
    };
    const client = new AbortController();
    const pending = call(
      routes.handlers.readHouseholdReceipt,
      readBody(uuid(11)),
      client.signal,
    );
    // 送出意図を記録して読み取りの口を呼んだ後に、端末が接続を切る。
    await started;
    client.abort();
    const result = await pending;
    assert.equal(result.status, 503);
    assert.equal(result.body['code'], 'dependency_unavailable');
    assert.equal((seen as { readonly aborted: boolean } | null)?.aborted, true);
    await gate.idle();
    const rows = harness
      .sql(rowsOf)
      .filter((row) => row.request_id === uuid(11));
    assert.deepEqual(
      rows.map((row) => [
        row.status,
        row.max_liability,
        row.actual_gross,
        row.dispatch_intent_at !== null,
      ]),
      [['usage_unknown', 30, null, true]],
    );
  });
});

test('予算の門: 読み取りの口が返らなくても、待つ上限の後に予算の門の後ろの処理も終わる', async () => {
  await withBudgetStore(async (harness) => {
    const gate = harness.gate();
    await gate.start();
    const reader = new MockReader();
    // 読み取りの期限 30 ms（予算の門の期限）、返らない口を待つ猶予 20 ms。
    const setup = setupOf(reader, { profile: profile({ timeout_ms: 30 }) });
    let released = 0;
    const routes = createHouseholdReceiptRoutes({
      setup,
      budget: receiptBudgetOf(gate, setup),
      zone: () => ZONE,
      now: () => harness.clock.now(),
      returnGraceMs: 20,
      cloudGate: {
        open: () => true,
        lease: () => () => {
          released += 1;
        },
      },
    });
    await call(
      routes.handlers.changeHouseholdReceiptSetting,
      settingBody('on'),
    );
    reader.next = neverReturns;
    const result = await call(
      routes.handlers.readHouseholdReceipt,
      readBody(uuid(12)),
    );
    // 予算の門の期限で、結果不明として先に返る。
    assert.equal(result.status, 503);
    assert.equal(result.body['code'], 'dependency_unavailable');
    // 予算の門が後ろで待つ送信（遅れた usage の精算）も、待つ上限で終わる。
    let timer: NodeJS.Timeout | undefined;
    const idle = await Promise.race([
      gate.idle().then(() => 'idle' as const),
      new Promise<'stuck'>((resolve) => {
        timer = setTimeout(() => resolve('stuck'), 5_000);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(idle, 'idle');
    await waitFor(() => released === 1, '貸し出しを返す');
    const command = reader.commands[0] as ReceiptReadCommand;
    assert.ok(command.image.bytes.every((byte) => byte === 0));
    const rows = harness
      .sql(rowsOf)
      .filter((row) => row.request_id === uuid(12));
    assert.deepEqual(
      rows.map((row) => [row.status, row.actual_gross]),
      [['usage_unknown', null]],
    );
  });
});

test('予算の門の modelUsageAmount: 設定が使えない・単価の版がない・通貨が違う・usage が分からないときは理由を返す', async () => {
  await withBudgetStore(async (harness) => {
    const loaded = loadedConfig();
    const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
      ...USAGE,
      ...over,
    });
    const gate = harness.gate();
    // 合成の単価は入力・出力とも 1 token 1 単位。入力 15 + 出力 5 = 20。
    assert.deepEqual(gate.modelUsageAmount('xts.text.v1', usage()), {
      ok: true,
      amount: '20',
    });
    assert.deepEqual(gate.modelUsageAmount('xts.text.v1', null), {
      ok: false,
      reasons: ['usage_missing'],
    });
    assert.deepEqual(
      gate.modelUsageAmount('xts.text.v1', usage({ usage_complete: false })),
      { ok: false, reasons: ['usage_incomplete'] },
    );
    // 予約に固定した単価の版が設定にない。
    assert.deepEqual(gate.modelUsageAmount('xts.text.v9', usage()), {
      ok: false,
      reasons: ['price_version_unknown'],
    });
    // 設定が読めていない。
    const invalid = harness.gate({
      config: { ok: false, reasons: ['config_missing'] },
    });
    assert.deepEqual(invalid.modelUsageAmount('xts.text.v1', usage()), {
      ok: false,
      reasons: ['config_invalid'],
    });
    // 予算の通貨（XXX）と単価の版の換算先（XTS）が違う。
    const otherCurrency = harness.gate({
      config: {
        ...loaded,
        settings: { ...loaded.settings, currency: 'XXX' },
      },
    });
    assert.deepEqual(otherCurrency.modelUsageAmount('xts.text.v1', usage()), {
      ok: false,
      reasons: ['currency_mismatch'],
    });
  });
});
