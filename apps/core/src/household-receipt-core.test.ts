// Core の起動の設定からのレシートの写真の読み取り（ADR 0178）と、入・切の保存との組み合わせ（ADR 0179）。Core は同じ
// プロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬）。外部のモデルは模擬の送信の口だけで、実 API は呼ばない。鍵は合成の
// 値。期待値は手で書いた。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { HttpRequest, HttpResult } from '@buddy/ai';
import { tempDir } from './api-test-support.js';
import { BUDGET_CONFIG_FILE } from './budget-config.js';
import { OCT_15, syntheticConfig } from './budget-test-support.js';
import type { TestDevice } from './api-test-support.js';
import {
  bootstrap,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
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
  // 中枢を起動し直す場合の前の中枢（同じデータディレクトリ・TLS の鍵・端末を使う）。
  previous?: { readonly core: EventCore; readonly device: TestDevice },
) {
  const dataDir =
    previous?.core.dataDir ??
    join(await tempDir(t, 'buddy-receipt-core-'), 'data');
  if (previous === undefined) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dataDir, BUDGET_CONFIG_FILE),
      JSON.stringify(geminiConfig(withGemini)),
      { mode: 0o600 },
    );
  }
  const transport = new MockTransport();
  const core = await startEventCore(t, {
    dataDir,
    ...(previous === undefined
      ? {}
      : { tlsKeyStore: previous.core.tlsKeyStore }),
    budget: { tickIntervalMs: 0, now: () => OCT_15 },
    household: {
      receiptProvider:
        productEndpoint === undefined
          ? { apiKey, transport, endpoint: ENDPOINT }
          : { apiKey, endpoint: productEndpoint },
    },
  });
  const device = previous?.device ?? (await insertDevice(core.handle.store));
  const scope = await bootstrap(core, device);
  const screen = { 'buddy-input-origin': 'screen' };
  // 設定の版（ADR 0179）。家計簿の設定の行がなければ 0。
  const change = (value: 'on' | 'off', revision = '0') =>
    postJson(
      core,
      device,
      '/v1/household/receipt-setting',
      {
        request_id: randomUUID(),
        command_scope_id: scope,
        expected_settings_revision: revision,
        receipt_reading: value,
      },
      screen,
    );
  const turnOn = (revision = '0') => change('on', revision);
  const turnOff = (revision: string) => change('off', revision);
  // DB に保存した入・切と版（読み取りの口の有無によらない値）。
  const stored = async () => {
    const got = await core.handle.store.household({
      kind: 'household.settings_get',
    });
    assert(got.ok);
    return [got.value.receipt_reading, got.value.settings_revision];
  };
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
  return { core, device, transport, turnOn, turnOff, stored, read };
}

test(
  '鍵と確認済みの単価の版があれば、起動の設定から Gemini の読み取りの口で 1 回だけ送る',
  { timeout: 30_000 },
  async (t) => {
    const h = await startWith(t, KEY, true);
    const on = await h.turnOn();
    assert.equal(on.status, 200, on.text);
    assert.deepEqual(on.json, {
      receipt_reading: 'on',
      settings_revision: '1',
    });
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
      // 入にする要求は保存しない（ADR 0179）。
      assert.deepEqual(await h.stored(), ['off', '0']);
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

test(
  '入にして起動し直すと入のままで、鍵を外して起動し直すと切に倒して保存し、鍵を戻しても切のまま（403 で送らない）',
  { timeout: 60_000 },
  async (t) => {
    const first = await startWith(t, KEY, true);
    const on = await first.turnOn();
    assert.equal(on.status, 200, on.text);
    await first.core.handle.stop('restart');

    // 鍵のまま起動し直す: 入にし直さなくても読み取りを受け、1 回だけ送る。
    const again = await startWith(t, KEY, true, undefined, first);
    assert.deepEqual(await again.stored(), ['on', '1']);
    const read = await again.read();
    assert.equal(read.status, 200, read.text);
    assert.equal(again.transport.requests.length, 1);
    await again.core.handle.stop('restart');

    // 鍵を外して起動し直す: 読み取りの口がないので、保存した値が入だったのを切に倒して保存する（版は 1 進む）。送らない。
    const keyless = await startWith(t, null, true, undefined, first);
    assert.deepEqual(await keyless.stored(), ['off', '2']);
    const notSent = await keyless.read();
    assert.equal(notSent.status, 503, notSent.text);
    assert.equal(notSent.json?.['code'], 'not_sent');
    // 入にする要求は 503 で保存しない。
    const refused = await keyless.turnOn('2');
    assert.equal(refused.status, 503, refused.text);
    assert.deepEqual(await keyless.stored(), ['off', '2']);
    assert.equal(keyless.transport.requests.length, 0);
    await keyless.core.handle.stop('restart');

    // 鍵を戻して起動し直す: 切のままで、確認ダイアログを経る入にする要求まで送らない（403）。
    const back = await startWith(t, KEY, true, undefined, first);
    assert.deepEqual(await back.stored(), ['off', '2']);
    const consent = await back.read();
    assert.equal(consent.status, 403, consent.text);
    assert.equal(consent.json?.['code'], 'external_send_consent_required');
    assert.equal(back.transport.requests.length, 0);
    // 古い表示（版 1）から入にする要求は、版の違いで 409。今の版（2）で入にすると送れる。
    const stale = await back.turnOn('1');
    assert.equal(stale.status, 409, stale.text);
    const onAgain = await back.turnOn('2');
    assert.equal(onAgain.status, 200, onAgain.text);
    assert.deepEqual(await back.stored(), ['on', '3']);
  },
);

test(
  '入にして、確認済みの単価の版がない状態で起動し直すと切に倒して保存し、単価の版を戻しても切のまま（403 で送らない）',
  { timeout: 60_000 },
  async (t) => {
    const first = await startWith(t, KEY, true);
    const on = await first.turnOn();
    assert.equal(on.status, 200, on.text);
    await first.core.handle.stop('restart');

    // 予算の設定から Gemini の単価の版を外して起動し直す。
    const configPath = join(first.core.dataDir, BUDGET_CONFIG_FILE);
    await writeFile(configPath, JSON.stringify(geminiConfig(false)), {
      mode: 0o600,
    });
    const noPrice = await startWith(t, KEY, false, undefined, first);
    assert.deepEqual(await noPrice.stored(), ['off', '2']);
    const notSent = await noPrice.read();
    assert.equal(notSent.status, 503, notSent.text);
    assert.equal(noPrice.transport.requests.length, 0);
    await noPrice.core.handle.stop('restart');

    // 単価の版を戻して起動し直す: 切のままで送らない。
    await writeFile(configPath, JSON.stringify(geminiConfig(true)), {
      mode: 0o600,
    });
    const back = await startWith(t, KEY, true, undefined, first);
    assert.deepEqual(await back.stored(), ['off', '2']);
    const consent = await back.read();
    assert.equal(consent.status, 403, consent.text);
    assert.equal(consent.json?.['code'], 'external_send_consent_required');
    assert.equal(back.transport.requests.length, 0);
  },
);
