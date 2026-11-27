// 外部のモデルへの HTTPS の送信（ADR 0178）の試験。127.0.0.1 の模擬の HTTPS サーバー（模擬の TLS の鍵）だけに送り、実 API
// は呼ばない。期待値は手で書いた。
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Agent, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createMockTlsKeyStore } from '@buddy/platform';
import type { HttpRequest } from '@buddy/ai';
import { onCleanup, tempDir } from './api-test-support.js';
import { createModelHttpsTransport } from './model-https.js';
import { loadOrCreateTlsIdentity } from './tls-identity.js';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

// 模擬の HTTPS サーバー。受け取った要求と、閉じた接続の数を記録する。
async function startServer(t: test.TestContext, handler: Handler) {
  const identity = await loadOrCreateTlsIdentity({
    dataDir: await tempDir(t, 'buddy-model-https-'),
    tlsKeyStore: createMockTlsKeyStore(),
    now: new Date(),
  });
  const seen: Seen[] = [];
  const state = { connections: 0, closed: 0 };
  const server = createServer(
    { key: identity.privateKey.toPkcs8Pem(), cert: identity.certificatePem },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        handler(request, response);
      });
    },
  );
  server.on('secureConnection', (socket) => {
    state.connections += 1;
    socket.on('close', () => {
      state.closed += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(t, async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = (server.address() as AddressInfo).port;
  // 模擬の証明書を信頼する（名前は入っていないので照合しない）。製品は Node の既定を使う。
  const agent = new Agent({
    ca: identity.certificatePem,
    checkServerIdentity: () => undefined,
  });
  onCleanup(t, () => agent.destroy());
  return { seen, state, url: `https://127.0.0.1:${port}/v1/read`, agent };
}

const requestTo = (
  url: string,
  over: Partial<HttpRequest> = {},
): HttpRequest => ({
  method: 'POST',
  url,
  headers: {
    'content-type': 'application/json',
    'x-goog-api-key': 'synthetic-key-0001',
  },
  body: '{"合成":"本文"}',
  timeout_ms: 5_000,
  ...over,
});

async function waitFor(condition: () => boolean, label: string) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 5_000) assert.fail(`待ちの上限: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('要求をそのまま 1 回送り、応答の状態・ヘッダー・本文を返す', async (t) => {
  const server = await startServer(t, (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Synthetic': 'a',
    });
    response.end('{"応答":1}');
  });
  const transport = createModelHttpsTransport({ agent: server.agent });
  const result = await transport.send(requestTo(server.url));
  assert.equal(result.kind, 'response');
  if (result.kind !== 'response') return;
  assert.equal(result.response.status, 200);
  assert.equal(result.response.body, '{"応答":1}');
  assert.equal(result.response.headers['content-type'], 'application/json');
  assert.equal(result.response.headers['x-synthetic'], 'a');
  assert.equal(server.seen.length, 1);
  const seen = server.seen[0] as Seen;
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/v1/read');
  assert.equal(seen.body, '{"合成":"本文"}');
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.headers['x-goog-api-key'], 'synthetic-key-0001');
  // 「{"合成":"本文"}」の UTF-8 のバイト数（記号 7 バイトと漢字 4 文字 × 3 バイト。手で数えた値）。
  assert.equal(seen.headers['content-length'], '19');
});

test('200 以外の状態も応答として返す（読み方は呼び出し側が決める）', async (t) => {
  const server = await startServer(t, (_request, response) => {
    response.writeHead(429);
    response.end('{}');
  });
  const transport = createModelHttpsTransport({ agent: server.agent });
  const result = await transport.send(requestTo(server.url));
  assert.equal(result.kind === 'response' && result.response.status, 429);
});

test('期限を過ぎたら接続を切って timeout を返す', async (t) => {
  const server = await startServer(t, () => undefined);
  const transport = createModelHttpsTransport({ agent: server.agent });
  const started = Date.now();
  const result = await transport.send(
    requestTo(server.url, { timeout_ms: 100 }),
  );
  assert.deepEqual(result, { kind: 'timeout' });
  assert.ok(Date.now() - started < 3_000);
  await waitFor(() => server.state.closed === 1, '接続が閉じる');
  assert.equal(server.seen.length, 1);
});

test('中断されたら接続を切ってすぐ返し、中断済みなら接続しない', async (t) => {
  const server = await startServer(t, () => undefined);
  const transport = createModelHttpsTransport({ agent: server.agent });
  const controller = new AbortController();
  const pending = transport.send(
    requestTo(server.url, { timeout_ms: 60_000 }),
    controller.signal,
  );
  await waitFor(() => server.seen.length === 1, '要求が届く');
  const started = Date.now();
  controller.abort();
  assert.deepEqual(await pending, { kind: 'unavailable' });
  assert.ok(Date.now() - started < 1_000);
  await waitFor(() => server.state.closed === 1, '接続が閉じる');
  // 中断済み。
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(
    await transport.send(requestTo(server.url), aborted.signal),
    { kind: 'unavailable' },
  );
  assert.equal(server.state.connections, 1);
});

test('応答の本文の上限: ちょうどは返し、1 バイト超えは unavailable', async (t) => {
  let size = 10;
  const server = await startServer(t, (_request, response) => {
    response.writeHead(200);
    response.end('a'.repeat(size));
  });
  const transport = createModelHttpsTransport({
    agent: server.agent,
    maxResponseBytes: 10,
  });
  const exact = await transport.send(requestTo(server.url));
  assert.equal(exact.kind === 'response' && exact.response.body, 'aaaaaaaaaa');
  size = 11;
  assert.deepEqual(await transport.send(requestTo(server.url)), {
    kind: 'unavailable',
  });
});

test('https: でない URL・読めない URL・不正なヘッダーは接続せずに unavailable', async (t) => {
  let plainConnections = 0;
  const plain = createHttpServer((_request, response) => response.end('{}'));
  plain.on('connection', () => {
    plainConnections += 1;
  });
  await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
  onCleanup(t, () => new Promise((resolve) => plain.close(resolve)));
  const port = (plain.address() as AddressInfo).port;
  const transport = createModelHttpsTransport();
  assert.deepEqual(
    await transport.send(requestTo(`http://127.0.0.1:${port}/v1/read`)),
    { kind: 'unavailable' },
  );
  assert.deepEqual(await transport.send(requestTo('not a url')), {
    kind: 'unavailable',
  });
  assert.equal(plainConnections, 0);
  const server = await startServer(t, (_request, response) => response.end());
  const withAgent = createModelHttpsTransport({ agent: server.agent });
  assert.deepEqual(
    await withAgent.send(
      requestTo(server.url, {
        headers: { 'x-goog-api-key': 'a\r\nx-injected: 1' },
      }),
    ),
    { kind: 'unavailable' },
  );
  assert.equal(server.seen.length, 0);
});

test('接続できない・証明書を信頼できないときは unavailable', async (t) => {
  // 閉じたポート。
  const closed = createHttpServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
  const transport = createModelHttpsTransport();
  assert.deepEqual(
    await transport.send(requestTo(`https://127.0.0.1:${port}/v1/read`)),
    { kind: 'unavailable' },
  );
  // 模擬の証明書を信頼しない既定の接続。
  const server = await startServer(t, (_request, response) => response.end());
  assert.deepEqual(await transport.send(requestTo(server.url)), {
    kind: 'unavailable',
  });
  assert.equal(server.seen.length, 0);
});

test('allowedHosts があれば、含まれないホストへは接続せずに unavailable を返す', async (t) => {
  const server = await startServer(t, (_request, response) => {
    response.writeHead(200);
    response.end('{}');
  });
  const refused = createModelHttpsTransport({
    agent: server.agent,
    allowedHosts: ['generativelanguage.googleapis.com'],
  });
  assert.deepEqual(await refused.send(requestTo(server.url)), {
    kind: 'unavailable',
  });
  assert.equal(server.seen.length, 0);
  assert.equal(server.state.connections, 0);
  const allowed = createModelHttpsTransport({
    agent: server.agent,
    allowedHosts: ['127.0.0.1'],
  });
  const result = await allowed.send(requestTo(server.url));
  assert.equal(result.kind, 'response');
  assert.equal(server.seen.length, 1);
});
