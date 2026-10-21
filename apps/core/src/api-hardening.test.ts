// 中枢の HTTPS・WSS の可用性と失効の経路の強化（B03-07、独立したセキュリティレビューの指摘、#75）の試験。
// 127.0.0.1 の模擬で、DB は一時ディレクトリ、TLS の鍵は模擬の KeyStore。時間の上限は試験用の短い値を注入する。
// 期待値（HTTP の状態・コード・閉じるコード・件数）は手書き。端末トークンは試験の中で作る合成の値で、出力に出さない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TLSSocket } from 'node:tls';
import { createMockTlsKeyStore } from '@buddy/platform';
import type { DbWorkerClient } from '@buddy/storage';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';
import type { RequestEnvironment } from './api-environment.js';
import { createApiServer } from './api-server.js';
import type {
  ApiEventStream,
  ApiLimits,
  ApiRouteHandler,
  ApiServer,
} from './api-server.js';
import {
  insertDevice,
  onCleanup,
  pinnedCheck,
  pinnedConnect,
  pinnedRequest,
  startTestStore,
  statusOf,
  tempDir,
  withTimeout,
} from './api-test-support.js';
import type {
  ApiResponse,
  PinnedTarget,
  TestDevice,
} from './api-test-support.js';
import { DeviceConnections } from './device-connections.js';
import { encodeEventCursor } from './event-cursor.js';
import { EventFeed } from './event-feed.js';
import { createEventStream } from './event-stream.js';
import type { EventStreamManager } from './event-stream.js';
import { loadOrCreateTlsIdentity } from './tls-identity.js';

const CORE_INSTANCE = '00000000-0000-4000-8000-0000000000c1';

// 判定の元がまだない文脈をすべて満たす環境（試験用）。
const PASSING: RequestEnvironment = {
  homeNetwork: () => true,
  lockState: () => 'unlocked',
  hubLocal: () => true,
  audioOwner: () => 'self',
  revisionMatches: () => true,
  claimSecretMatches: () => true,
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Started {
  readonly api: ApiServer;
  readonly store: DbWorkerClient;
  readonly target: PinnedTarget;
  readonly clock: { mono: number };
  readonly feed: EventFeed;
  readonly streams: EventStreamManager;
  readonly deviceConnections: DeviceConnections;
}

// HTTPS の受付と WSS の配信（同じプロセス、Core なし）。eventStream を渡すと配信を包める（故障の注入）。
async function startApi(
  t: test.TestContext,
  options: {
    readonly limits?: Partial<ApiLimits>;
    readonly handlers?: Readonly<Record<string, ApiRouteHandler>>;
    readonly pingIntervalMs?: number;
    readonly wrapStream?: (
      streams: EventStreamManager,
      feed: EventFeed,
    ) => ApiEventStream;
  } = {},
): Promise<Started> {
  const identity = await loadOrCreateTlsIdentity({
    dataDir: await tempDir(t, 'buddy-hardening-tls-'),
    tlsKeyStore: createMockTlsKeyStore(),
    now: new Date(),
  });
  const store = await startTestStore(t);
  const feed = new EventFeed({ store, pollIntervalMs: 0 });
  onCleanup(t, () => feed.close());
  const deviceConnections = new DeviceConnections();
  const streams = createEventStream({
    feed,
    store,
    coreInstanceId: CORE_INSTANCE,
    environment: PASSING,
    deviceConnections,
    pingIntervalMs: options.pingIntervalMs ?? 100,
  });
  const clock = { mono: 1_000 };
  const api = createApiServer({
    host: '127.0.0.1',
    port: 0,
    identity,
    store,
    coreInstanceId: CORE_INSTANCE,
    environment: PASSING,
    limits: { preAuthMaxRequests: 1000, ...options.limits },
    monotonicNow: () => clock.mono,
    eventStream: options.wrapStream?.(streams, feed) ?? streams,
    ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
  });
  await api.listen();
  onCleanup(t, async () => {
    streams.closeAll();
    await api.close(0);
  });
  return {
    api,
    store,
    clock,
    feed,
    streams,
    deviceConnections,
    target: {
      host: '127.0.0.1',
      port: api.port,
      certificatePem: identity.certificatePem,
      fingerprint: identity.fingerprint,
    },
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function bootstrap(started: Started, device: TestDevice): Promise<ApiResponse> {
  return pinnedRequest(started.target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: bearer(device.token),
  });
}

// 接続が閉じるのを待つ（閉じなければ時間切れの失敗）。
function closedWithin(socket: TLSSocket, ms: number, label: string) {
  return withTimeout(
    new Promise<void>((resolve) => {
      if (socket.destroyed) resolve();
      else socket.once('close', () => resolve());
    }),
    ms,
    label,
  );
}

// 1 本の TLS の接続の上で、要求を順に書いて応答を 1 件ずつ読む（keep-alive の確認用）。
function keepAliveClient(socket: TLSSocket) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake();
  });
  socket.on('close', () => {
    closed = true;
    wake();
  });
  socket.on('error', () => undefined);
  const next = () =>
    withTimeout(
      new Promise<number>((resolve, reject) => {
        const check = () => {
          const at = buffer.indexOf('\r\n\r\n');
          if (at !== -1) {
            const head = buffer.subarray(0, at + 2).toString('latin1');
            const length = Number(
              /\r\ncontent-length: (\d+)\r\n/iu.exec(head)?.[1] ?? '0',
            );
            if (buffer.length >= at + 4 + length) {
              buffer = buffer.subarray(at + 4 + length);
              waiters.delete(check);
              resolve(statusOf(head));
              return;
            }
          }
          if (closed) {
            waiters.delete(check);
            reject(new Error('closed_before_response'));
          }
        };
        waiters.add(check);
        check();
      }),
      5_000,
      'keep-alive response',
    );
  return {
    request(path: string, token: string): Promise<number> {
      socket.write(
        `GET ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${token}\r\nconnection: keep-alive\r\n\r\n`,
      );
      return next();
    },
    get closed() {
      return closed;
    },
  };
}

interface StreamClient {
  readonly socket: WebSocket;
  readonly opened: Promise<
    { readonly ok: true } | { readonly ok: false; readonly status: number }
  >;
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
}

function openStream(
  t: test.TestContext,
  started: Started,
  device: TestDevice,
): StreamClient {
  const cursor = encodeEventCursor({
    storeGeneration: started.store.storeGeneration,
    sequence: 0,
    issuedAt: Date.now(),
  });
  const socket = new WebSocket(
    `wss://127.0.0.1:${started.target.port}/v1/events/stream?cursor=${encodeURIComponent(cursor)}`,
    {
      headers: bearer(device.token),
      ca: [started.target.certificatePem],
      checkServerIdentity: pinnedCheck(
        started.target.fingerprint,
      ) as unknown as ClientOptions['checkServerIdentity'],
    },
  );
  onCleanup(t, () => socket.terminate());
  socket.on('error', () => undefined);
  const opened = withTimeout(
    new Promise<
      { readonly ok: true } | { readonly ok: false; readonly status: number }
    >((resolve) => {
      socket.once('open', () => resolve({ ok: true }));
      socket.once('unexpected-response', (request, response) => {
        resolve({ ok: false, status: response.statusCode ?? 0 });
        request.destroy();
      });
      socket.once('close', () => resolve({ ok: false, status: 0 }));
    }),
    10_000,
    'stream opened',
  );
  const closed = withTimeout(
    new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString('utf8') }),
      );
    }),
    10_000,
    'stream closed',
  );
  // 待たずに失敗した場合の未処理の拒否にしない（使う試験で待つ）。
  closed.catch(() => undefined);
  return { socket, opened, closed };
}

// 購読が端末の接続として登録される（接続範囲に結び付いた）まで待つ。
async function registered(
  started: Started,
  device: TestDevice,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (started.deviceConnections.count(device.device.device_id) !== count) {
    assert(Date.now() < deadline, `stream registered: ${count}`);
    await sleep(10);
  }
}

// --- M1: TLS の確立から最初の要求までの期限 ---

test(
  'M1: connections that send nothing after the TLS handshake are closed and do not hold the connection slots',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t, {
      limits: {
        maxConnections: 2,
        headersTimeoutMs: 300,
        requestTimeoutMs: 1_000,
      },
    });
    const device = await insertDevice(started.store);
    // 何も送らない接続を 2 本（同時の TLS 接続の上限）開く。
    const idle = [
      await pinnedConnect(started.target),
      await pinnedConnect(started.target),
    ];
    onCleanup(t, () => {
      for (const socket of idle) socket.destroy();
    });
    for (const socket of idle) socket.on('error', () => undefined);
    // 最初の要求の期限（300 ms）を過ぎたら中枢が切る。Node の headersTimeout の確認の間隔（30 秒）を待たない。
    await Promise.all(
      idle.map((socket, index) =>
        closedWithin(socket, 3_000, `idle connection ${index + 1} closed`),
      ),
    );
    // 枠が空いたので、正しいトークンの要求は 429 にならない。
    const response = await bootstrap(started, device);
    assert.equal(response.status, 200);
  },
);

test(
  'M1: keep-alive connections and slow handlers are not cut by the first-request deadline',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t, {
      limits: {
        headersTimeoutMs: 300,
        requestTimeoutMs: 1_000,
        keepAliveTimeoutMs: 3_000,
      },
      handlers: {
        // 期限より長くかかる処理（応答を書くまで接続に何も流れない）。
        getSnapshot: async () => {
          await sleep(700);
          return { status: 200, body: {} };
        },
      },
    });
    const device = await insertDevice(started.store);
    const socket = await pinnedConnect(started.target);
    onCleanup(t, () => socket.destroy());
    const client = keepAliveClient(socket);
    assert.equal(await client.request('/v1/bootstrap', device.token), 200);
    // 期限より長く間を空けても、keep-alive の間（3 秒）は同じ接続で続けられる。
    await sleep(700);
    assert.equal(await client.request('/v1/snapshot', device.token), 200);
    await sleep(700);
    assert.equal(await client.request('/v1/bootstrap', device.token), 200);
    assert.equal(client.closed, false);
  },
);

test(
  'M1: an open event stream is not cut by the first-request deadline',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t, {
      limits: { headersTimeoutMs: 300, requestTimeoutMs: 1_000 },
      pingIntervalMs: 100,
    });
    const device = await insertDevice(started.store);
    assert.equal((await bootstrap(started, device)).status, 200);
    const stream = openStream(t, started, device);
    assert.deepEqual(await stream.opened, { ok: true });
    await registered(started, device, 1);
    // 期限の数倍の間、購読は開いたまま（ping・接続範囲の確かめ直しが続く）。
    await sleep(1_200);
    assert.equal(stream.socket.readyState, WebSocket.OPEN);
    assert.equal(started.deviceConnections.count(device.device.device_id), 1);
    stream.socket.close();
    await stream.closed;
  },
);
