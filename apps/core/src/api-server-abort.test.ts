// 端末の切断を経路の処理へ伝えること（abortOnCloseRoutes）と、読んだ本文のバイト列を 0 で埋めること（wipeBodyRoutes）の
// 試験（ADR 0177 の追補、見直しの指摘 1・3）。127.0.0.1 の模擬の中枢で、DB は一時ディレクトリ、TLS の鍵は模擬の
// KeyStore。画像は合成のバイト列で、外部のモデルは模擬の読み取りの口だけ（実 API は呼ばない）。期待値は手で書いた。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpsRequest } from 'node:https';
import test from 'node:test';
import type { AdapterResult } from '@buddy/ai';
import { syntheticProfile } from '@buddy/ai/testing';
import { createMockTlsKeyStore } from '@buddy/platform';
import type { RequestEnvironment } from './api-environment.js';
import { createApiServer, readRequestBody } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import {
  insertDevice,
  onCleanup,
  pinnedConnect,
  pinnedRequest,
  startTestStore,
  tempDir,
  withTimeout,
} from './api-test-support.js';
import type { PinnedTarget, TestDevice } from './api-test-support.js';
import { createHouseholdReceiptRoutes } from './household-receipt.js';
import type { ReceiptBudget, ReceiptReadCommand } from './household-receipt.js';
import { loadOrCreateTlsIdentity } from './tls-identity.js';

const CORE_INSTANCE = '00000000-0000-4000-8000-0000000000c1';

const PASSING: RequestEnvironment = {
  homeNetwork: () => true,
  lockState: () => 'unlocked',
  hubLocal: () => true,
  audioOwner: () => 'self',
  revisionMatches: () => true,
  claimSecretMatches: () => true,
};

// 合成の JPEG（SOI・SOF0 の縦 1280 横 960・SOS・EOI）。
const IMAGE_BASE64 = '/9j/wAARCAUAA8ADASIAAhEBAxEB/9oACAEBAAA/AP/Z';

async function startHub(
  t: test.TestContext,
  handlers: Readonly<Record<string, ApiRouteHandler>>,
): Promise<{ target: PinnedTarget; device: TestDevice }> {
  const identity = await loadOrCreateTlsIdentity({
    dataDir: await tempDir(t, 'buddy-abort-tls-'),
    tlsKeyStore: createMockTlsKeyStore(),
    now: new Date(),
  });
  const store = await startTestStore(t);
  const api = createApiServer({
    host: '127.0.0.1',
    port: 0,
    identity,
    store,
    coreInstanceId: CORE_INSTANCE,
    environment: PASSING,
    limits: { preAuthMaxRequests: 1000 },
    handlers,
    abortOnCloseRoutes: ['readHouseholdReceipt'],
    wipeBodyRoutes: ['readHouseholdReceipt'],
  });
  await api.listen();
  onCleanup(t, () => api.close(0));
  const device = await insertDevice(store);
  return {
    target: {
      host: '127.0.0.1',
      port: api.port,
      certificatePem: identity.certificatePem,
      fingerprint: identity.fingerprint,
    },
    device,
  };
}

async function scopeOf(target: PinnedTarget, token: string): Promise<string> {
  const response = await pinnedRequest(target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: { authorization: `Bearer ${token}` },
  });
  const scope = response.json?.['command_scope_id'];
  assert.equal(typeof scope, 'string');
  return scope as string;
}

const headersFor = (token: string, body: Buffer) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'content-length': String(body.length),
  'buddy-input-origin': 'screen',
  'buddy-lock-state': 'unlocked',
  connection: 'close',
});

// 読み取りの要求を送り、応答を待たずに接続を切れるようにする。
async function sendReceipt(
  target: PinnedTarget,
  token: string,
  scope: string,
): Promise<{ readonly cut: () => void }> {
  const socket = await pinnedConnect(target);
  socket.on('error', () => undefined);
  const body = Buffer.from(
    JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: scope,
      image: { media_type: 'image/jpeg', data_base64: IMAGE_BASE64 },
    }),
  );
  const req = httpsRequest({
    createConnection: () => socket,
    host: target.host,
    port: target.port,
    method: 'POST',
    path: '/v1/household/receipt-readings',
    headers: headersFor(token, body),
  });
  req.on('error', () => undefined);
  req.end(body);
  return {
    cut: () => {
      req.destroy();
      socket.destroy();
    },
  };
}

test(
  '端末が接続を切ると、読み取りの経路の処理へ中断が届き、送出意図の前なら送らない',
  { timeout: 30_000 },
  async (t) => {
    const reads: ReceiptReadCommand[] = [];
    let admitted: () => void = () => undefined;
    const admitting = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finished: (outcome: string) => void = () => undefined;
    const outcome = new Promise<string>((resolve) => {
      finished = resolve;
    });
    // 予算の門の受付（DB の記録）が終わる前に端末が切る。受付の後に中断を見て、送出意図の前なので送らずに解放する。
    const budget: ReceiptBudget = {
      async run(_requestId, send, signal) {
        entered();
        await admitting;
        if (signal.aborted) {
          finished('released');
          return { kind: 'released' };
        }
        await send(signal);
        finished('sent');
        return { kind: 'settled' };
      },
    };
    const routes = createHouseholdReceiptRoutes({
      setup: {
        reader: {
          read: (command) => {
            reads.push(command);
            return Promise.resolve({
              kind: 'timeout',
              usage: null,
            } as AdapterResult);
          },
        },
        profile: syntheticProfile({
          profile_id: 'receipt.synthetic.v1',
          role: 'background_text',
          output_limit_tokens: 10,
        }),
        profile_revision: '1',
        price_key: 'synthetic.text',
        max_input_tokens: 20,
      },
      budget,
      zone: () => 'Asia/Tokyo',
      now: () => Date.parse('2030-11-26T03:00:00.000Z'),
    });
    // 設定を入にする（中枢の画面の操作の代わりに、経路の処理を直接呼ぶ）。
    await routes.handlers.changeHouseholdReceiptSetting({
      body: {
        request_id: randomUUID(),
        expected_settings_revision: '0',
        receipt_reading: 'on',
      },
    } as unknown as ApiHandlerRequest);
    // 挙げていない経路には signal も要求が届いた時刻も付かない。
    const plain: (AbortSignal | number | undefined)[] = [];
    // 読み取りの経路の処理が受け取った signal（中断が届いたことを、待つ時間ではなく abort の事象で確かめる）。
    let handed: (signal: AbortSignal | undefined) => void = () => undefined;
    const signalOf = new Promise<AbortSignal | undefined>((resolve) => {
      handed = resolve;
    });
    const hub = await startHub(t, {
      readHouseholdReceipt: (request) => {
        handed(request.signal);
        return routes.handlers.readHouseholdReceipt(request);
      },
      getSnapshot: async (request) => {
        plain.push(request.signal, request.receivedAt);
        return { status: 200, body: {} };
      },
    });
    const scope = await scopeOf(hub.target, hub.device.token);
    const sent = await sendReceipt(hub.target, hub.device.token, scope);
    await withTimeout(started, 10_000, 'budget entered');
    const signal = await signalOf;
    assert.ok(signal instanceof AbortSignal);
    const abortedEvent = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    sent.cut();
    // 中断が経路の処理へ届いて（abort の事象が起きて）から、受付を終わらせる。
    await withTimeout(abortedEvent, 10_000, 'abort reached the route');
    admitted();
    assert.equal(await withTimeout(outcome, 10_000, 'outcome'), 'released');
    assert.equal(reads.length, 0);
    const snapshot = await pinnedRequest(hub.target, {
      method: 'GET',
      path: '/v1/snapshot',
      headers: { authorization: `Bearer ${hub.device.token}` },
    });
    assert.equal(snapshot.status, 200);
    assert.deepEqual(plain, [undefined, undefined]);
  },
);

test(
  '切らなければ読み取りの経路の signal は中断されない',
  { timeout: 30_000 },
  async (t) => {
    const signals: (AbortSignal | undefined)[] = [];
    // 要求が届いた時刻（本文を読む前の単調時計）と、経路の処理を始めた時刻。
    const times: { receivedAt: number | undefined; started: number }[] = [];
    const hub = await startHub(t, {
      readHouseholdReceipt: async (request) => {
        signals.push(request.signal);
        times.push({
          receivedAt: request.receivedAt,
          started: performance.now(),
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: 200, body: { aborted: request.signal?.aborted } };
      },
    });
    const scope = await scopeOf(hub.target, hub.device.token);
    const body = JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: scope,
      image: { media_type: 'image/jpeg', data_base64: IMAGE_BASE64 },
    });
    const response = await pinnedRequest(hub.target, {
      method: 'POST',
      path: '/v1/household/receipt-readings',
      headers: headersFor(hub.device.token, Buffer.from(body)),
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { aborted: false });
    assert.equal(signals.length, 1);
    assert.ok(signals[0] instanceof AbortSignal);
    // 挙げた経路には要求が届いた時刻が付き、経路の処理を始めた時刻より前（本文の受け取りと経路の検査の前）。
    const time = times[0];
    assert.equal(typeof time?.receivedAt, 'number');
    assert.ok((time?.receivedAt ?? Infinity) <= (time?.started ?? 0));
  },
);

test(
  'まとめた本文（Buffer）は、挙げた経路でだけ JSON として読んだ後に 0 で埋める',
  { timeout: 30_000 },
  async (t) => {
    // api-server が本文の断片をまとめた Buffer を捕まえる（送った本文と同じ中身のものだけ）。
    const bodies = new Map<string, Buffer[]>();
    const original = Buffer.concat.bind(Buffer);
    t.mock.method(
      Buffer,
      'concat',
      (...args: Parameters<typeof Buffer.concat>) => {
        const made = original(...args);
        const text = made.toString('utf8');
        const list = bodies.get(text);
        if (list !== undefined) list.push(made);
        return made;
      },
    );
    // 経路の処理を呼んだ時点で、まとめた本文が 0 で埋めてあるか。
    const atHandler: Record<string, boolean> = {};
    const zeroed = (text: string) =>
      (bodies.get(text) ?? []).length > 0 &&
      (bodies.get(text) ?? []).every((buffer) =>
        buffer.every((byte) => byte === 0),
      );
    let receiptText = '';
    let settingText = '';
    const hub = await startHub(t, {
      readHouseholdReceipt: async () => {
        atHandler['receipt'] = zeroed(receiptText);
        return { status: 200, body: {} };
      },
      changeHouseholdReceiptSetting: async () => {
        atHandler['setting'] = zeroed(settingText);
        return {
          status: 200,
          body: { receipt_reading: 'off', settings_revision: '1' },
        };
      },
    });
    const scope = await scopeOf(hub.target, hub.device.token);
    receiptText = JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: scope,
      image: { media_type: 'image/jpeg', data_base64: IMAGE_BASE64 },
    });
    settingText = JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: scope,
      expected_settings_revision: '0',
      receipt_reading: 'off',
    });
    bodies.set(receiptText, []);
    bodies.set(settingText, []);
    const receipt = await pinnedRequest(hub.target, {
      method: 'POST',
      path: '/v1/household/receipt-readings',
      headers: headersFor(hub.device.token, Buffer.from(receiptText)),
      body: receiptText,
    });
    assert.equal(receipt.status, 200);
    const setting = await pinnedRequest(hub.target, {
      method: 'POST',
      path: '/v1/household/receipt-setting',
      headers: headersFor(hub.device.token, Buffer.from(settingText)),
      body: settingText,
    });
    assert.equal(setting.status, 200);
    // 挙げた経路（読み取り）は、経路の処理の前に 0 で埋めてある。
    assert.equal(bodies.get(receiptText)?.length, 1);
    assert.equal(atHandler['receipt'], true);
    assert.equal(zeroed(receiptText), true);
    // 挙げていない経路（設定の変更）は埋めない。
    assert.equal(bodies.get(settingText)?.length, 1);
    assert.equal(atHandler['setting'], false);
    assert.equal(bodies.get(settingText)?.[0]?.toString('utf8'), settingText);
  },
);

// 本文の読み取りの模擬（IncomingMessage の data・end・close だけ）。
class FakeBody extends EventEmitter {
  paused = false;
  pause(): this {
    this.paused = true;
    return this;
  }
}

test('読んだ本文の断片の Buffer は、挙げた経路でだけ 0 で埋める', async () => {
  const chunks = [Buffer.from('{"a":'), Buffer.from('"bcd"}')];
  const wiped = new FakeBody();
  const reading = readRequestBody(wiped, 1024, true);
  for (const chunk of chunks) wiped.emit('data', chunk);
  wiped.emit('end');
  const result = await reading;
  assert.equal(result.kind, 'body');
  // まとめた本文は呼び出し側が読むまで残り、受け取った断片は 0 で埋めてある。
  assert.equal(
    result.kind === 'body' ? result.bytes.toString('utf8') : '',
    '{"a":"bcd"}',
  );
  for (const chunk of chunks) assert.ok(chunk.every((byte) => byte === 0));
  // 上限を超えて読むのをやめたときも埋める。
  const big = [Buffer.alloc(8, 0x41), Buffer.alloc(8, 0x42)];
  const over = new FakeBody();
  const overReading = readRequestBody(over, 10, true);
  for (const chunk of big) over.emit('data', chunk);
  assert.deepEqual(await overReading, { kind: 'too_large' });
  for (const chunk of big) assert.ok(chunk.every((byte) => byte === 0));
  // 挙げていない経路（wipe なし）は埋めない。
  const kept = [Buffer.from('{"a":1}')];
  const plain = new FakeBody();
  const plainReading = readRequestBody(plain, 1024);
  plain.emit('data', kept[0]);
  plain.emit('end');
  await plainReading;
  assert.equal(kept[0]?.toString('utf8'), '{"a":1}');
});
