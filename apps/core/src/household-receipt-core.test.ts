// Core の起動の設定からのレシートの写真の読み取り（ADR 0178）。Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は
// 模擬）。外部のモデルは模擬の送信の口だけで、実 API は呼ばない。鍵は合成の値。期待値は手で書いた。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { HttpRequest, HttpResult } from '@buddy/ai';
import { tempDir } from './api-test-support.js';
import { BUDGET_CONFIG_FILE } from './budget-config.js';
import { OCT_15, syntheticConfig } from './budget-test-support.js';
import {
  bootstrap,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { ReceiptHttpTransport } from './household-receipt-reader.js';

type Json = Record<string, unknown>;

// 合成の鍵（実在の鍵の形に似せない）。鍵に見える文字列はソースに置かず、実行時に組み立てる（ADR 0127 の試験と同じ扱い）。
const KEY = ['synthetic', 'receipt', 'credential', '0002'].join('-');
const ENDPOINT = 'https://llm.invalid/v1beta/models/receipt:generateContent';
// 中枢の検査に通る合成の JPEG（SOI・SOF0 の縦 1280 横 960・SOS・EOI）。
const SENDABLE_BASE64 = '/9j/wAARCAUAA8ADASIAAhEBAxEB/9oACAEBAAA/AP/Z';

// 予算の設定に Gemini の単価の系列を足す（合成の通貨 XTS、入力・出力とも 1 token 1 単位、枠を大きくする）。
function geminiConfig(withGemini: boolean): Record<string, unknown> {
  return syntheticConfig((config) => {
    if (!withGemini) return;
    const budget = config['budget'] as Json;
    for (const pool of budget['pools'] as Json[])
      if (pool['pool_id'] === 'total' || pool['pool_id'] === 'llm')
        pool['limit'] = { currency: 'XTS', amount: '100000' };
    budget['verified_price_versions'] = [
      ...(budget['verified_price_versions'] as string[]),
      'xts.gemini.v1',
    ];
    (config['price_versions'] as Json[]).push({
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
    });
  });
}

class MockTransport implements ReceiptHttpTransport {
  readonly requests: HttpRequest[] = [];
  send(request: HttpRequest): Promise<HttpResult> {
    this.requests.push(request);
    return Promise.resolve({
      kind: 'response',
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      readable: true,
                      receipt_count: 1,
                      currency: 'JPY',
                      total: 540,
                      date: '2026-01-05',
                      time: null,
                      merchant: '合成の売店',
                      payment: null,
                      items: [],
                    }),
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60 },
        }),
      },
    });
  }
}

async function startWith(
  t: test.TestContext,
  apiKey: string | null,
  withGemini: boolean,
  // 製品の送信の口（transport を渡さない）で、endpoint だけ指定する場合。
  productEndpoint?: string,
) {
  const dataDir = join(await tempDir(t, 'buddy-receipt-core-'), 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDir, BUDGET_CONFIG_FILE),
    JSON.stringify(geminiConfig(withGemini)),
    { mode: 0o600 },
  );
  const transport = new MockTransport();
  const core = await startEventCore(t, {
    dataDir,
    budget: { tickIntervalMs: 0, now: () => OCT_15 },
    household: {
      receiptProvider:
        productEndpoint === undefined
          ? { apiKey, transport, endpoint: ENDPOINT }
          : { apiKey, endpoint: productEndpoint },
    },
  });
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
  const screen = { 'buddy-input-origin': 'screen' };
  const turnOn = () =>
    postJson(
      core,
      device,
      '/v1/household/receipt-setting',
      {
        request_id: randomUUID(),
        command_scope_id: scope,
        receipt_reading: 'on',
      },
      screen,
    );
  const read = () =>
    postJson(
      core,
      device,
      '/v1/household/receipt-readings',
      {
        request_id: randomUUID(),
        command_scope_id: scope,
        image: { media_type: 'image/jpeg', data_base64: SENDABLE_BASE64 },
      },
      screen,
    );
  return { core, transport, turnOn, read };
}

test(
  '鍵と確認済みの単価の版があれば、起動の設定から Gemini の読み取りの口で 1 回だけ送る',
  { timeout: 30_000 },
  async (t) => {
    const h = await startWith(t, KEY, true);
    const on = await h.turnOn();
    assert.equal(on.status, 200, on.text);
    assert.deepEqual(on.json, { receipt_reading: 'on' });
    const result = await h.read();
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json, {
      result: 'candidate',
      candidate: {
        amount_yen: 540,
        occurred_on: '2026-01-05',
        occurred_time: null,
        merchant: '合成の売店',
        payment: null,
      },
      reasons: [],
    });
    assert.equal(h.transport.requests.length, 1);
    const request = h.transport.requests[0] as HttpRequest;
    assert.equal(request.url, ENDPOINT);
    assert.equal(request.timeout_ms, 45_000);
    assert.equal(request.headers['x-goog-api-key'], KEY);
    const body = JSON.parse(request.body) as {
      contents: { parts: { inlineData: { data: string } }[] }[];
    };
    assert.equal(body.contents[0]?.parts[0]?.inlineData.data, SENDABLE_BASE64);
  },
);

test(
  '鍵がない・予算の設定に単価の版がなければ unavailable で、入にもできず送らない',
  { timeout: 30_000 },
  async (t) => {
    for (const [apiKey, withGemini] of [
      [null, true],
      [KEY, false],
    ] as const) {
      const h = await startWith(t, apiKey, withGemini);
      const on = await h.turnOn();
      assert.equal(on.status, 503, on.text);
      const result = await h.read();
      assert.equal(result.status, 503, result.text);
      assert.equal(h.transport.requests.length, 0);
    }
  },
);

test(
  '製品の送信の口では、鍵を送る宛先を generativelanguage.googleapis.com の https に限る',
  { timeout: 30_000 },
  async (t) => {
    // 任意のホスト・http・別のホストに見える名前は、設定の段階で拒否して読み取りを使えなくする。
    for (const endpoint of [
      ENDPOINT,
      'http://generativelanguage.googleapis.com/v1beta/models/m:generateContent',
      'https://generativelanguage.googleapis.com.evil.invalid/v1beta/m',
      [
        'https://synthetic',
        ':credential',
        '@generativelanguage.googleapis.com/v1beta/m',
      ].join(''),
      'https://generativelanguage.googleapis.com:8443/v1beta/m',
    ]) {
      const h = await startWith(t, KEY, true, endpoint);
      const on = await h.turnOn();
      assert.equal(on.status, 503, `${endpoint}: ${on.text}`);
    }
    // 固定のホストなら読み取りを入にできる（ここでは送らない）。
    const allowed = await startWith(
      t,
      KEY,
      true,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    const on = await allowed.turnOn();
    assert.equal(on.status, 200, on.text);
  },
);
