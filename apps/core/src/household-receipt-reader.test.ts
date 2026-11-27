// レシートの写真の読み取りの口の Gemini の実装と profile（ADR 0178）の試験。入・切の保存（ADR 0179）との組み合わせも
// 含む。外部のモデルは模擬の HTTP の口だけで、実 API は呼ばない。鍵は合成の値、画像は合成のバイト列（JPEG の頭と大きさ
// だけ）。期待値はすべて手で書いた。
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import type { AdapterResult, HttpRequest, HttpResult } from '@buddy/ai';
import ajvModule from 'ajv/dist/2020.js';
import type { ApiRouteHandler } from './api-server.js';
import {
  loadedConfig,
  syntheticConfig,
  uuid,
  withBudgetStore,
} from './budget-test-support.js';
import {
  HOUSEHOLD_RECEIPT_INSTRUCTIONS,
  createHouseholdReceiptRoutes,
  receiptBudgetOf,
  receiptSetupUsable,
} from './household-receipt.js';
import type {
  ReceiptBudget,
  ReceiptReadCommand,
  ReceiptReadingSetup,
} from './household-receipt.js';
import {
  HOUSEHOLD_RECEIPT_REPLY_SCHEMA,
  createGeminiReceiptReader,
  householdReceiptProfile,
  householdReceiptSetup,
  HOUSEHOLD_RECEIPT_ENDPOINT,
  receiptApiKeyFromEnv,
  receiptEndpointAllowed,
} from './household-receipt-reader.js';
import type { ReceiptHttpTransport } from './household-receipt-reader.js';
import { memoryReceiptSettingStore } from './household-receipt-setting.js';
import type { JsonObject } from './strict-json.js';

type Json = Record<string, unknown>;

// 合成の鍵（実在の鍵の形に似せない）。鍵に見える文字列はソースに置かず、実行時に組み立てる（ADR 0127 の試験と同じ扱い）。
const KEY = ['synthetic', 'receipt', 'credential', '0001'].join('-');
// 合成の JPEG（SOI・EOI だけ）と、その base64（手で書いた値）。
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const BYTES_BASE64 = '/9j/2Q==';
// 中枢の検査に通る合成の JPEG（SOI・SOF0 の縦 1280 横 960・SOS・EOI）の base64（api-server-abort.test.ts と同じ値）。
const SENDABLE_BASE64 = '/9j/wAARCAUAA8ADASIAAhEBAxEB/9oACAEBAAA/AP/Z';
const ENDPOINT = 'https://llm.invalid/v1beta/models/receipt:generateContent';

const profile = householdReceiptProfile({
  price_version: 'xts.gemini.v1',
  endpoint: ENDPOINT,
});

const command = (bytes: Uint8Array = BYTES): ReceiptReadCommand => ({
  request_id: uuid(1),
  profile,
  instructions: HOUSEHOLD_RECEIPT_INSTRUCTIONS,
  image: { media_type: 'image/jpeg', bytes },
});

const REPLY = {
  readable: true,
  receipt_count: 1,
  currency: 'JPY',
  total: 1280,
  date: '2030-10-14',
  time: '12:34',
  merchant: '合成の商店',
  payment: '現金',
  items: [
    { name: 'おにぎり', amount: 300 },
    { name: 'お茶', amount: 980 },
  ],
};

// Gemini の generateContent の応答の封筒（合成）。
const envelope = (over: Json = {}, text = JSON.stringify(REPLY)): string =>
  JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 1500,
      candidatesTokenCount: 80,
      thoughtsTokenCount: 30,
    },
    responseId: 'synthetic-response-1',
    ...over,
  });

const ok = (body: string, status = 200): HttpResult => ({
  kind: 'response',
  response: { status, headers: { 'content-type': 'application/json' }, body },
});

type Step = (request: HttpRequest, signal: AbortSignal) => Promise<HttpResult>;

// 模擬の送信の口。送った要求と中断の口を記録する。
class MockTransport implements ReceiptHttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly signals: AbortSignal[] = [];
  constructor(public step: Step) {}
  send(request: HttpRequest, signal: AbortSignal): Promise<HttpResult> {
    this.requests.push(request);
    this.signals.push(signal);
    return this.step(request, signal);
  }
}

const readerWith = (step: Step) => {
  const transport = new MockTransport(step);
  const logs: string[] = [];
  const reader = createGeminiReceiptReader({
    apiKey: KEY,
    transport,
    log: (message) => logs.push(message),
  });
  return { transport, logs, reader };
};

const USAGE_FULL = {
  input_tokens: 1500,
  cached_input_tokens: 0,
  output_tokens: 110,
  reasoning_tokens: 30,
  usage_complete: true,
};

test('送る要求: 指示文と画像 1 枚だけを、決まったモデル・期限・鍵のヘッダーで 1 回だけ送る', async () => {
  const h = readerWith(() => Promise.resolve(ok(envelope())));
  const result = await h.reader.read(command(), new AbortController().signal);
  assert.equal(result.kind, 'response');
  assert.equal(h.transport.requests.length, 1);
  const request = h.transport.requests[0] as HttpRequest;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, ENDPOINT);
  assert.equal(request.timeout_ms, 45_000);
  assert.deepEqual(request.headers, {
    'content-type': 'application/json',
    'x-goog-api-key': KEY,
  });
  const body = JSON.parse(request.body) as Json;
  // 本文は指示文・画像・生成の設定の 3 つだけ（要求の ID・本人・端末の情報を含めない）。
  assert.deepEqual(Object.keys(body).sort(), [
    'contents',
    'generationConfig',
    'systemInstruction',
  ]);
  assert.deepEqual(body['systemInstruction'], {
    parts: [{ text: HOUSEHOLD_RECEIPT_INSTRUCTIONS }],
  });
  assert.deepEqual(body['contents'], [
    {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/jpeg', data: BYTES_BASE64 } }],
    },
  ]);
  const config = body['generationConfig'] as Json;
  assert.equal(config['responseMimeType'], 'application/json');
  assert.equal(config['maxOutputTokens'], 4096);
  assert.deepEqual(config['thinkingConfig'], { thinkingLevel: 'low' });
  assert.ok(!('temperature' in config));
  const schema = config['responseJsonSchema'] as Json;
  assert.deepEqual(schema['required'], [
    'readable',
    'receipt_count',
    'currency',
    'total',
    'date',
    'time',
    'merchant',
    'payment',
    'items',
  ]);
  assert.equal(schema['additionalProperties'], false);
  assert.ok(!request.body.includes(uuid(1)));
  assert.ok(!request.body.includes(KEY));
  assert.ok(!request.url.includes(KEY));
  // 画像は写しを作らずに読み、変えない。
  assert.deepEqual([...BYTES], [0xff, 0xd8, 0xff, 0xd9]);
});

test('既定の profile: Gemini 3.8 Flash・思考 low・出力 4096・期限 45 秒（60 秒以内）', () => {
  const standard = householdReceiptProfile({ price_version: 'xts.gemini.v1' });
  assert.deepEqual(standard, {
    profile_id: 'household-receipt.gemini',
    role: 'background_text',
    provider: 'gemini',
    endpoint:
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    api_version: 'v1beta',
    sdk_version: null,
    model_request_id: 'gemini-3.8-flash',
    reasoning: 'low',
    structured_output: 'json_schema_strict',
    output_limit_tokens: 4096,
    timeout_ms: 45_000,
    max_concurrency: 2,
    price_version: 'xts.gemini.v1',
    reservation_method: 'max_liability',
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  assert.ok(standard.timeout_ms <= 60_000);
});

test('応答: 本文と usage（思考を含む出力）をそのまま返し、本文は読まない', async () => {
  const h = readerWith(() => Promise.resolve(ok(envelope())));
  const result = await h.reader.read(command(), new AbortController().signal);
  assert.deepEqual(result, {
    kind: 'response',
    text: JSON.stringify(REPLY),
    usage: USAGE_FULL,
    provider_request_id: 'synthetic-response-1',
    refused: false,
    truncated: false,
  });
  assert.deepEqual(h.logs, []);
});

test('usage がない・不完全なら null（推測で埋めない）', async () => {
  const cases: [string, Json][] = [
    ['なし', { usageMetadata: undefined }],
    ['出力がない', { usageMetadata: { promptTokenCount: 1500 } }],
    [
      '負の数',
      { usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 80 } },
    ],
    [
      'cached が入力を超える',
      {
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 1,
          cachedContentTokenCount: 11,
        },
      },
    ],
  ];
  for (const [name, over] of cases) {
    const h = readerWith(() => Promise.resolve(ok(envelope(over))));
    const result = await h.reader.read(command(), new AbortController().signal);
    assert.equal(result.kind, 'response', name);
    assert.equal(result.usage, null, name);
  }
});

test('安全のための拒否・打ち切り・空の応答を区別する', async () => {
  const cases: [
    string,
    string,
    { refused: boolean; truncated: boolean; text: string },
  ][] = [
    [
      '入力の拒否',
      JSON.stringify({
        promptFeedback: { blockReason: 'SAFETY' },
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 0 },
      }),
      { refused: true, truncated: false, text: '' },
    ],
    [
      '画像の安全',
      envelope({
        candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }],
      }),
      { refused: true, truncated: false, text: '' },
    ],
    [
      '個人の情報',
      envelope({
        candidates: [{ content: { parts: [] }, finishReason: 'SPII' }],
      }),
      { refused: true, truncated: false, text: '' },
    ],
    [
      '出力の上限',
      envelope({
        candidates: [
          {
            content: { parts: [{ text: '{"readable"' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      }),
      { refused: false, truncated: true, text: '{"readable"' },
    ],
    [
      '空の本文',
      envelope({
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      }),
      { refused: false, truncated: false, text: '' },
    ],
    [
      '思考の要約は本文に混ぜない',
      envelope({
        candidates: [
          {
            content: {
              parts: [{ text: '考え', thought: true }, { text: '{}' }],
            },
            finishReason: 'STOP',
          },
        ],
      }),
      { refused: false, truncated: false, text: '{}' },
    ],
  ];
  for (const [name, body, expected] of cases) {
    const h = readerWith(() => Promise.resolve(ok(body)));
    const result = await h.reader.read(command(), new AbortController().signal);
    assert.equal(result.kind, 'response', name);
    if (result.kind !== 'response') continue;
    assert.equal(result.refused, expected.refused, name);
    assert.equal(result.truncated, expected.truncated, name);
    assert.equal(result.text, expected.text, name);
    assert.equal(h.transport.requests.length, 1, name);
  }
});

test('HTTP の失敗・壊れた封筒・時間切れ・送れないは、送り直さずに結果不明として返す', async () => {
  const cases: [string, Step, AdapterResult['kind'], string | null][] = [
    [
      '500',
      () => Promise.resolve(ok('{}', 500)),
      'unavailable',
      'http_status_500',
    ],
    [
      '429',
      () => Promise.resolve(ok('{"error":{}}', 429)),
      'unavailable',
      'http_status_429',
    ],
    [
      '403',
      () => Promise.resolve(ok('', 403)),
      'unavailable',
      'http_status_403',
    ],
    [
      'JSON でない',
      () => Promise.resolve(ok('<html>')),
      'unavailable',
      'response_unreadable',
    ],
    [
      '候補がない',
      () => Promise.resolve(ok('{"candidates":[]}')),
      'unavailable',
      'response_unreadable',
    ],
    [
      '知らない終了の理由',
      () =>
        Promise.resolve(
          ok(
            envelope({
              candidates: [{ content: { parts: [] }, finishReason: 'OTHER' }],
            }),
          ),
        ),
      'unavailable',
      'response_unreadable',
    ],
    [
      '時間切れ',
      () => Promise.resolve({ kind: 'timeout' }),
      'timeout',
      'timeout',
    ],
    [
      '送れない',
      () => Promise.resolve({ kind: 'unavailable' }),
      'unavailable',
      'unavailable',
    ],
    [
      '口の例外',
      () => Promise.reject(new Error('boom')),
      'unavailable',
      'transport_failed',
    ],
  ];
  for (const [name, step, kind, reason] of cases) {
    const h = readerWith(step);
    const result = await h.reader.read(command(), new AbortController().signal);
    assert.equal(result.kind, kind, name);
    assert.equal(result.usage, null, name);
    assert.equal(h.transport.requests.length, 1, name);
    assert.deepEqual(
      h.logs,
      reason === null
        ? []
        : [
            `家計簿のレシートの写真の読み取りで応答を得られませんでした（${reason}）。`,
          ],
      name,
    );
  }
});

test('中断: 送る前なら送らず、送っている途中なら口へ中断を渡してすぐ返す', async () => {
  // 送る前。
  const before = readerWith(() => Promise.resolve(ok(envelope())));
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await before.reader.read(command(), aborted.signal), {
    kind: 'cancelled',
    usage: null,
  });
  assert.equal(before.transport.requests.length, 0);
  // 送っている途中: 口は中断されるまで返らない（中断されたら unavailable を返す）。
  const during = readerWith(
    (_request, signal) =>
      new Promise<HttpResult>((resolve) => {
        signal.addEventListener(
          'abort',
          () => resolve({ kind: 'unavailable' }),
          {
            once: true,
          },
        );
      }),
  );
  const controller = new AbortController();
  const pending = during.reader.read(command(), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(during.transport.requests.length, 1);
  assert.equal(during.transport.signals[0], controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { kind: 'cancelled', usage: null });
  assert.deepEqual(during.logs, []);
  // 応答が届いた後に中断された: usage は捨てずに返す。
  const after = new AbortController();
  const late = readerWith(() => {
    after.abort();
    return Promise.resolve(ok(envelope()));
  });
  assert.deepEqual(await late.reader.read(command(), after.signal), {
    kind: 'cancelled',
    usage: USAGE_FULL,
  });
  // 口が例外を投げたときに中断されていた。
  const thrown = new AbortController();
  const failed = readerWith(() => {
    thrown.abort();
    return Promise.reject(new Error('aborted'));
  });
  assert.deepEqual(await failed.reader.read(command(), thrown.signal), {
    kind: 'cancelled',
    usage: null,
  });
});

test('Gemini 以外の profile では送らない', async () => {
  const h = readerWith(() => Promise.resolve(ok(envelope())));
  const result = await h.reader.read(
    { ...command(), profile: { ...profile, provider: 'synthetic' } },
    new AbortController().signal,
  );
  assert.deepEqual(result, { kind: 'unavailable', usage: null });
  assert.equal(h.transport.requests.length, 0);
});

test('記録に鍵・画像・応答の中身を出さない（理由の名前だけ）', async () => {
  const secretText = '合成の商店の秘密の品目';
  const steps: Step[] = [
    () => Promise.resolve(ok(envelope({}, secretText), 500)),
    () => Promise.resolve(ok(`{"text":"${secretText}"`)),
    () => Promise.resolve({ kind: 'timeout' }),
    () => Promise.reject(new Error(`${KEY} ${secretText}`)),
  ];
  const logs: string[] = [];
  for (const step of steps) {
    const h = readerWith(step);
    await h.reader.read(command(), new AbortController().signal);
    logs.push(...h.logs);
  }
  assert.equal(logs.length, 4);
  for (const line of logs) {
    assert.match(
      line,
      /^家計簿のレシートの写真の読み取りで応答を得られませんでした（[a-z0-9_]+）。$/u,
    );
    assert.ok(!line.includes(KEY));
    assert.ok(!line.includes(secretText));
    assert.ok(!line.includes(BYTES_BASE64));
  }
  // 口のオブジェクトに鍵を持たせない（JSON・inspect に出ない）。
  const h = readerWith(() => Promise.resolve(ok(envelope())));
  assert.ok(!JSON.stringify(h.reader).includes(KEY));
  assert.ok(!inspect(h.reader, { depth: 5 }).includes(KEY));
});

test('構造化出力の形は domain の応答の形と同じキーで、余計なキー・品目 101 件を許さない', () => {
  const Ajv2020 = ajvModule.default;
  const validate = new Ajv2020({ strict: true }).compile(
    HOUSEHOLD_RECEIPT_REPLY_SCHEMA,
  );
  assert.equal(validate(REPLY), true);
  assert.equal(
    validate({ ...REPLY, currency: null, total: null, date: null, time: null }),
    true,
  );
  assert.equal(validate({ ...REPLY, extra: 1 }), false);
  assert.equal(validate({ ...REPLY, total: 12.5 }), false);
  const item = { name: null, amount: 1 };
  assert.equal(validate({ ...REPLY, items: Array(100).fill(item) }), true);
  assert.equal(validate({ ...REPLY, items: Array(101).fill(item) }), false);
  const missing: Json = { ...REPLY };
  delete missing['items'];
  assert.equal(validate(missing), false);
});

test('鍵は起動の環境変数からだけ値のまま読み、未設定・空だけを鍵がないものとして扱う', () => {
  assert.equal(receiptApiKeyFromEnv({}), null);
  assert.equal(receiptApiKeyFromEnv({ BUDDY_GEMINI_API_KEY: '' }), null);
  assert.equal(receiptApiKeyFromEnv({ OTHER_KEY: KEY }), null);
  assert.equal(receiptApiKeyFromEnv({ BUDDY_GEMINI_API_KEY: KEY }), KEY);
  // 形の違う値（空白・改行・\r・全角）も落とさずに返し、起動の設定が receipt_api_key_invalid として記録する。
  for (const value of [`${KEY}\r`, `${KEY} `, 'a b', 'a\nb', 'ａｂ'])
    assert.equal(receiptApiKeyFromEnv({ BUDDY_GEMINI_API_KEY: value }), value);
});

test('形の違う鍵は、環境変数から起動の設定まで通すと receipt_api_key_invalid が記録され、鍵がないときは記録されない', () => {
  const logs: string[] = [];
  const build = (env: Record<string, string | undefined>) =>
    householdReceiptSetup({
      apiKey: receiptApiKeyFromEnv(env),
      transport: new MockTransport(() => Promise.resolve(ok(envelope()))),
      priceVersionFor: () => 'xts.gemini.v1',
      log: (message) => logs.push(message),
    });
  assert.equal(build({}), null);
  assert.equal(build({ BUDDY_GEMINI_API_KEY: '' }), null);
  assert.deepEqual(logs, []);
  assert.equal(build({ BUDDY_GEMINI_API_KEY: `${KEY}\r` }), null);
  assert.deepEqual(logs, [
    '家計簿のレシートの写真の読み取りを使えなくしました（receipt_api_key_invalid）。',
  ]);
  // 値は記録に出さない。
  assert.ok(!logs.join('').includes(KEY));
  assert.notEqual(build({ BUDDY_GEMINI_API_KEY: KEY }), null);
});

test('鍵を送ってよい宛先は generativelanguage.googleapis.com の https だけ', () => {
  const base = 'generativelanguage.googleapis.com';
  assert.equal(receiptEndpointAllowed(HOUSEHOLD_RECEIPT_ENDPOINT), true);
  assert.equal(receiptEndpointAllowed(`https://${base}/v1beta/x`), true);
  for (const endpoint of [
    ENDPOINT,
    `http://${base}/v1beta/x`,
    `https://${base}.evil.invalid/v1beta/x`,
    `https://x.${base}/v1beta/x`,
    ['https://synthetic', ':credential', `@${base}/v1beta/x`].join(''),
    `https://${base}:8443/v1beta/x`,
    'not a url',
    '',
  ])
    assert.equal(receiptEndpointAllowed(endpoint), false, endpoint);
});

test('起動の設定: 鍵がない・形が違う・単価の版がなければ作らない（unavailable）', () => {
  const transport = new MockTransport(() => Promise.resolve(ok(envelope())));
  const asked: unknown[] = [];
  const logs: string[] = [];
  const build = (apiKey: string | null, version: string | null) =>
    householdReceiptSetup({
      apiKey,
      transport,
      priceVersionFor: (request) => {
        asked.push(request);
        return version;
      },
      log: (message) => logs.push(message),
    });
  // 鍵がないのは既定の状態なので、記録もしない。
  assert.equal(build(null, 'xts.gemini.v1'), null);
  assert.equal(build('', 'xts.gemini.v1'), null);
  assert.deepEqual(logs, []);
  assert.equal(build('a b', 'xts.gemini.v1'), null);
  assert.deepEqual(asked, []);
  assert.equal(build(KEY, null), null);
  assert.deepEqual(logs, [
    '家計簿のレシートの写真の読み取りを使えなくしました（receipt_api_key_invalid）。',
    '家計簿のレシートの写真の読み取りを使えなくしました（receipt_price_version_unavailable）。',
  ]);
  assert.deepEqual(asked, [
    {
      price_key: 'gemini.gemini-3.8-flash',
      quantities: { input_tokens: '8192', output_tokens: '4096' },
      timeout_ms: 45_000,
    },
  ]);
  const setup = build(KEY, 'xts.gemini.v1') as ReceiptReadingSetup;
  assert.notEqual(setup, null);
  assert.equal(receiptSetupUsable(setup), true);
  assert.equal(setup.profile_revision, '1');
  assert.equal(setup.price_key, 'gemini.gemini-3.8-flash');
  assert.equal(setup.max_input_tokens, 8192);
  assert.equal(setup.profile.price_version, 'xts.gemini.v1');
  assert.equal(setup.profile.model_request_id, 'gemini-3.8-flash');
  assert.ok(!JSON.stringify(setup).includes(KEY));
  assert.ok(!inspect(setup, { depth: 8 }).includes(KEY));
});

// 経路まで通す（模擬の送信の口 → Gemini の読み取りの口 → 厳格な JSON → domain の検査）。
const readBody = (requestId: string): JsonObject => ({
  request_id: requestId,
  command_scope_id: uuid(900),
  image: { media_type: 'image/jpeg', data_base64: SENDABLE_BASE64 },
});

const call = async (
  handler: ApiRouteHandler,
  body: JsonObject,
): Promise<{ status: number; body: Json }> => {
  const request = {
    route: undefined as never,
    device: null,
    body,
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  } as Parameters<ApiRouteHandler>[0];
  const response = await handler(request);
  return { status: response.status, body: response.body as Json };
};

// 送る関数を一度だけ呼ぶ模擬の予算の門。
const passingBudget: ReceiptBudget = {
  async run(_requestId, send, signal) {
    const sent = await send(signal);
    return sent.usage === null
      ? { kind: 'usage_unknown' }
      : { kind: 'settled' };
  },
};

const routesWith = (step: Step) => {
  const transport = new MockTransport(step);
  const setup = householdReceiptSetup({
    apiKey: KEY,
    transport,
    priceVersionFor: () => 'xts.gemini.v1',
    endpoint: ENDPOINT,
  });
  const routes = createHouseholdReceiptRoutes({
    setup,
    budget: passingBudget,
    zone: () => 'Asia/Tokyo',
    // 2030-10-15 12:00（東京）。
    now: () => Date.parse('2030-10-15T03:00:00.000Z'),
  });
  return { transport, routes };
};

// 設定の版は、中枢のメモリーの保存を新しく作ったときは 0（ADR 0179）。経路はどれも 1 回だけ入にする。
const settingOn: JsonObject = {
  request_id: uuid(800),
  command_scope_id: uuid(900),
  expected_settings_revision: '0',
  receipt_reading: 'on',
};

test('経路: Gemini の応答から候補を作り、検査に落ちる応答は候補にしない', async () => {
  const cases: [string, Step, number, Json][] = [
    [
      '候補',
      () => Promise.resolve(ok(envelope())),
      200,
      {
        result: 'candidate',
        candidate: {
          amount_yen: 1280,
          occurred_on: '2030-10-14',
          occurred_time: '12:34',
          merchant: '合成の商店',
          payment: '現金',
        },
        reasons: [],
      },
    ],
    [
      '外貨',
      () =>
        Promise.resolve(
          ok(envelope({}, JSON.stringify({ ...REPLY, currency: 'USD' }))),
        ),
      200,
      {
        result: 'not_candidate',
        candidate: null,
        reasons: ['currency_not_yen'],
      },
    ],
    [
      '重複したキー',
      () =>
        Promise.resolve(ok(envelope({}, '{"readable":true,"readable":false}'))),
      200,
      { result: 'not_candidate', candidate: null, reasons: ['reply_invalid'] },
    ],
    [
      '余計なキー',
      () =>
        Promise.resolve(
          ok(envelope({}, JSON.stringify({ ...REPLY, note: 'x' }))),
        ),
      200,
      { result: 'not_candidate', candidate: null, reasons: ['reply_invalid'] },
    ],
    [
      '合計と品目の食い違い',
      () =>
        Promise.resolve(
          ok(envelope({}, JSON.stringify({ ...REPLY, total: 1281 }))),
        ),
      200,
      {
        result: 'not_candidate',
        candidate: null,
        reasons: ['items_total_mismatch'],
      },
    ],
    [
      '空の本文',
      () =>
        Promise.resolve(
          ok(
            envelope({
              candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
            }),
          ),
        ),
      200,
      { result: 'not_candidate', candidate: null, reasons: ['reply_invalid'] },
    ],
    [
      '安全のための拒否',
      () =>
        Promise.resolve(
          ok(
            envelope({
              candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
            }),
          ),
        ),
      200,
      { result: 'not_candidate', candidate: null, reasons: ['refused'] },
    ],
    [
      '打ち切り',
      () =>
        Promise.resolve(
          ok(
            envelope({
              candidates: [
                {
                  content: { parts: [{ text: '{' }] },
                  finishReason: 'MAX_TOKENS',
                },
              ],
            }),
          ),
        ),
      200,
      { result: 'not_candidate', candidate: null, reasons: ['reply_invalid'] },
    ],
  ];
  let n = 10;
  for (const [name, step, status, expected] of cases) {
    const h = routesWith(step);
    assert.equal(await h.routes.state(), 'off', name);
    await call(h.routes.handlers.changeHouseholdReceiptSetting, settingOn);
    n += 1;
    const result = await call(
      h.routes.handlers.readHouseholdReceipt,
      readBody(uuid(n)),
    );
    assert.equal(result.status, status, name);
    assert.deepEqual(result.body, expected, name);
    assert.equal(h.transport.requests.length, 1, name);
  }
  // HTTP の失敗は結果不明の 503（送り直さない）。
  const failed = routesWith(() => Promise.resolve(ok('{}', 500)));
  await call(failed.routes.handlers.changeHouseholdReceiptSetting, settingOn);
  const lost = await call(
    failed.routes.handlers.readHouseholdReceipt,
    readBody(uuid(99)),
  );
  assert.equal(lost.status, 503);
  assert.equal(lost.body['code'], 'dependency_unavailable');
  assert.equal(failed.transport.requests.length, 1);
});

test('経路: 鍵がなければ unavailable で、入にもできない', async () => {
  const transport = new MockTransport(() => Promise.resolve(ok(envelope())));
  const settings = memoryReceiptSettingStore();
  const routes = createHouseholdReceiptRoutes({
    setup: householdReceiptSetup({
      apiKey: null,
      transport,
      priceVersionFor: () => 'xts.gemini.v1',
    }),
    budget: null,
    zone: () => 'Asia/Tokyo',
    now: () => Date.parse('2030-10-15T03:00:00.000Z'),
    settings,
  });
  assert.equal(await routes.state(), 'unavailable');
  const on = await call(
    routes.handlers.changeHouseholdReceiptSetting,
    settingOn,
  );
  assert.equal(on.status, 503);
  assert.equal(await routes.state(), 'unavailable');
  // 入にする要求は保存しない（ADR 0179）。
  assert.deepEqual(await settings.read(), {
    receipt_reading: 'off',
    settings_revision: '0',
  });
  assert.equal(transport.requests.length, 0);
});

test('経路: 入で保存していても、鍵がなければ unavailable で送らない（ADR 0179）', async () => {
  const transport = new MockTransport(() => Promise.resolve(ok(envelope())));
  // 鍵があったときに入にして保存した（版 1）。
  const settings = memoryReceiptSettingStore();
  assert.equal((await settings.write('0', 'on')).kind, 'written');
  const routes = createHouseholdReceiptRoutes({
    setup: householdReceiptSetup({
      apiKey: null,
      transport,
      priceVersionFor: () => 'xts.gemini.v1',
    }),
    budget: null,
    zone: () => 'Asia/Tokyo',
    now: () => Date.parse('2030-10-15T03:00:00.000Z'),
    settings,
  });
  assert.equal(await routes.state(), 'unavailable');
  const result = await call(
    routes.handlers.readHouseholdReceipt,
    readBody(uuid(3)),
  );
  assert.equal(result.status, 503);
  assert.equal(result.body['code'], 'not_sent');
  // 切にする要求は保存する（見せる値は unavailable のまま）。
  const off = await call(routes.handlers.changeHouseholdReceiptSetting, {
    ...settingOn,
    expected_settings_revision: '1',
    receipt_reading: 'off',
  });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, {
    receipt_reading: 'unavailable',
    settings_revision: '2',
  });
  assert.equal(transport.requests.length, 0);
});

// 予算の設定に Gemini の単価の系列を足す（合成の通貨 XTS、入力・出力とも 1 token 1 単位、枠を大きくする）。
const geminiConfig = (change: (version: Json) => void = () => undefined) =>
  syntheticConfig((config) => {
    const budget = config['budget'] as Json;
    for (const pool of budget['pools'] as Json[])
      if (pool['pool_id'] === 'total' || pool['pool_id'] === 'llm')
        pool['limit'] = { currency: 'XTS', amount: '100000' };
    budget['verified_price_versions'] = [
      ...(budget['verified_price_versions'] as string[]),
      'xts.gemini.v1',
    ];
    const version: Json = {
      price_version: 'xts.gemini.v1',
      price_key: 'gemini.gemini-3.8-flash',
      currency: 'XTS',
      effective_from: '2030-01-01T00:00:00.000Z',
      effective_to: null,
      rates: [
        {
          category: 'input_tokens',
          unit_price: '1',
          per_quantity: '1',
          minimum_quantity: '0',
          max_quantity_per_request: null,
        },
        {
          category: 'output_tokens',
          unit_price: '1',
          per_quantity: '1',
          minimum_quantity: '0',
          max_quantity_per_request: '8192',
        },
      ],
      conversion: {
        conversion_version: 'xts.same.v1',
        to_currency: 'XTS',
        rate: '1',
        safety_factor: '1',
      },
    };
    change(version);
    (config['price_versions'] as Json[]).push(version);
  });

test('予算の門: 起動の時点で確認済みの単価の版がある系列だけを使う', async () => {
  await withBudgetStore(async (harness) => {
    const versionOf = (config: Record<string, unknown>) =>
      harness.gate({ config: loadedConfig(config) }).priceVersionFor({
        price_key: 'gemini.gemini-3.8-flash',
        quantities: { input_tokens: '8192', output_tokens: '4096' },
        timeout_ms: 45_000,
      });
    assert.equal(versionOf(geminiConfig()), 'xts.gemini.v1');
    // 系列がない。
    assert.equal(versionOf(syntheticConfig()), null);
    // 確認されていない版。
    const unverified = geminiConfig();
    const budget = unverified['budget'] as Json;
    budget['verified_price_versions'] = ['xts.text.v1', 'xts.live.v1'];
    assert.equal(versionOf(unverified), null);
    // まだ始まっていない版（今は 2030-10-15）。
    assert.equal(
      versionOf(
        geminiConfig((version) => {
          version['effective_from'] = '2030-11-01T00:00:00.000Z';
        }),
      ),
      null,
    );
    // 出力の 1 要求の最大量が出力の上限より小さい。
    assert.equal(
      versionOf(
        geminiConfig((version) => {
          (version['rates'] as Json[])[1]!['max_quantity_per_request'] = '4095';
        }),
      ),
      null,
    );
  });
});

test('予算の門: Gemini の usage で精算し、usage が不完全なら予約を保持する', async () => {
  await withBudgetStore(async (harness) => {
    const gate = harness.gate({ config: loadedConfig(geminiConfig()) });
    await gate.start();
    let body = envelope();
    const transport = new MockTransport(() => Promise.resolve(ok(body)));
    const setup = householdReceiptSetup({
      apiKey: KEY,
      transport,
      priceVersionFor: (request) => gate.priceVersionFor(request),
      endpoint: ENDPOINT,
    }) as ReceiptReadingSetup;
    assert.notEqual(setup, null);
    const routes = createHouseholdReceiptRoutes({
      setup,
      budget: receiptBudgetOf(gate, setup),
      zone: () => 'Asia/Tokyo',
      now: () => harness.clock.now(),
    });
    await call(routes.handlers.changeHouseholdReceiptSetting, settingOn);
    const first = await call(
      routes.handlers.readHouseholdReceipt,
      readBody(uuid(1)),
    );
    assert.equal(first.status, 200);
    assert.equal(first.body['result'], 'candidate');
    // usage が不完全（出力の数がない）。
    body = envelope({ usageMetadata: { promptTokenCount: 1500 } });
    const second = await call(
      routes.handlers.readHouseholdReceipt,
      readBody(uuid(2)),
    );
    assert.equal(second.status, 200);
    const rows = harness.sql((db) =>
      db
        .prepare(
          'SELECT request_id, pool_id, status, max_liability, actual_gross FROM budget_reservations ORDER BY request_id',
        )
        .all(),
    ) as Json[];
    // M = 入力 8192 + 出力 4096 = 12288。実費 = 入力 1500 + 出力（思考を含む）110 = 1610。usage が不完全なら保持する。
    assert.deepEqual(
      rows.map((row) => [
        row['request_id'],
        row['pool_id'],
        row['status'],
        row['max_liability'],
        row['actual_gross'],
      ]),
      [
        [uuid(1), 'llm', 'settled', 12288, 1610],
        [uuid(2), 'llm', 'usage_unknown', 12288, null],
      ],
    );
  });
});
