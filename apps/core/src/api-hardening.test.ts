// 中枢の HTTPS・WSS の可用性と失効の経路の強化（B03-07、独立したセキュリティレビューの指摘、#75）の試験。
// 127.0.0.1 の模擬で、DB は一時ディレクトリ、TLS の鍵は模擬の KeyStore。時間の上限は試験用の短い値を注入する。
// 期待値（HTTP の状態・コード・閉じるコード・件数）は手書き。端末トークンは試験の中で作る合成の値で、出力に出さない。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { TLSSocket } from 'node:tls';
import { createMockTlsKeyStore } from '@buddy/platform';
import type { DbWorkerClient } from '@buddy/storage';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';
import { parse } from 'yaml';
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
import { STREAM_CLOSE_CODES, createEventStream } from './event-stream.js';
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
    await streams.closeAll();
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

type Opened =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string | null;
    };

interface StreamClient {
  readonly socket: WebSocket;
  // 切り替えの結果（open か、HTTP の拒否の状態と ApiError のコード）。
  readonly opened: Promise<Opened>;
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
    new Promise<Opened>((resolve) => {
      socket.once('open', () => resolve({ ok: true }));
      socket.once('unexpected-response', (request, response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let code: string | null;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              code?: unknown;
            };
            code = typeof body.code === 'string' ? body.code : null;
          } catch {
            code = null;
          }
          resolve({ ok: false, status: response.statusCode ?? 0, code });
          request.destroy();
        });
      });
      socket.once('close', () => resolve({ ok: false, status: 0, code: null }));
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

// --- M3: 配信の元を止めた後に届いた購読 ---

test(
  'M3: a stream that arrives after the event feed has stopped is refused or closed without an unhandled rejection',
  { timeout: 30_000 },
  async (t) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    onCleanup(t, () => {
      process.off('unhandledRejection', onRejection);
    });

    // 1) 配信の元を止めた後の切り替えは、切り替えずに 503（中枢の停止の途中）。
    const stopped = await startApi(t);
    const device = await insertDevice(stopped.store);
    assert.equal((await bootstrap(stopped, device)).status, 200);
    stopped.feed.close();
    const refused = openStream(t, stopped, device);
    assert.deepEqual(await refused.opened, {
      ok: false,
      status: 503,
      code: 'dependency_unavailable',
    });

    // 2) 受け付けの判定の後・購読の前に止まった場合は、購読の失敗として 1011 で閉じる。
    const racing = await startApi(t, {
      wrapStream: (streams, feed) => ({
        admit: async (request) => {
          const result = await streams.admit(request);
          feed.close();
          return result;
        },
        open: (client, request) => streams.open(client, request),
      }),
    });
    const other = await insertDevice(racing.store);
    assert.equal((await bootstrap(racing, other)).status, 200);
    const raced = openStream(t, racing, other);
    assert.deepEqual(await raced.opened, { ok: true });
    assert.deepEqual(await raced.closed, {
      code: 1011,
      reason: 'dependency_unavailable',
    });
    assert.equal(racing.deviceConnections.count(), 0);
    assert.equal(racing.streams.openCount, 0);
    // 未処理の拒否が通知される猶予を置いてから確かめる。
    await sleep(100);
    assert.equal(rejections.length, 0);
  },
);

// --- L3: 端末ごとの同時の購読の数 ---

test(
  'L3: one device cannot open more than four streams at once and the slots come back when streams close',
  { timeout: 30_000 },
  async (t) => {
    // 同時の切り替えを揃えるための関門（受け付けの判定を通った 2 件を、そろってから先へ進める）。
    const barrier = { active: false, waiting: [] as (() => void)[] };
    const started = await startApi(t, {
      wrapStream: (streams) => ({
        admit: async (request) => {
          const result = await streams.admit(request);
          if (barrier.active && result === null)
            await new Promise<void>((resolve) => {
              barrier.waiting.push(resolve);
              if (barrier.waiting.length === 2)
                for (const release of barrier.waiting.splice(0)) release();
            });
          return result;
        },
        open: (client, request) => streams.open(client, request),
      }),
    });
    const device = await insertDevice(started.store);
    const other = await insertDevice(started.store);
    assert.equal((await bootstrap(started, device)).status, 200);
    assert.equal((await bootstrap(started, other)).status, 200);

    // 上限（手書きの値 4）までは開ける。
    const open: StreamClient[] = [];
    for (let i = 0; i < 4; i += 1) {
      const stream = openStream(t, started, device);
      assert.deepEqual(await stream.opened, { ok: true }, `stream ${i + 1}`);
      open.push(stream);
    }
    await registered(started, device, 4);
    // 5 本目は切り替えずに 429 rate_limited。
    const fifth = openStream(t, started, device);
    assert.deepEqual(await fifth.opened, {
      ok: false,
      status: 429,
      code: 'rate_limited',
    });
    // 他の端末は影響を受けない。
    const others = openStream(t, started, other);
    assert.deepEqual(await others.opened, { ok: true });
    await registered(started, other, 1);

    // 1 本を閉じれば、また開ける。
    const first = open.shift() as StreamClient;
    first.socket.close();
    await first.closed;
    await registered(started, device, 3);

    // 残りの枠が 1 つのときに 2 本を同時に切り替えると、受け付けの判定は両方通るが、切り替えた後に
    // 後の 1 本を理由つき（4429 too_many_streams）で閉じる。
    barrier.active = true;
    const racing = [
      openStream(t, started, device),
      openStream(t, started, device),
    ];
    for (const stream of racing)
      assert.deepEqual(await stream.opened, { ok: true });
    const refused = await Promise.race(
      racing.map((stream, index) =>
        stream.closed.then((closed) => ({ index, closed })),
      ),
    );
    barrier.active = false;
    assert.deepEqual(refused.closed, {
      code: 4429,
      reason: 'too_many_streams',
    });
    await registered(started, device, 4);
    // 先に開いた 1 本は開いたまま。
    await sleep(300);
    const survivor = racing[1 - refused.index] as StreamClient;
    assert.equal(survivor.socket.readyState, WebSocket.OPEN);
    assert.equal(started.deviceConnections.count(device.device.device_id), 4);
    assert.equal(started.streams.openCount, 5);

    // 閉じるコードは契約（OpenAPI の x-buddy-websocket-close-codes）と同じ。
    const openapi = parse(
      await readFile(
        new URL('../../../packages/contracts/openapi.yaml', import.meta.url),
        'utf8',
      ),
    ) as {
      paths: Record<
        string,
        { get: { 'x-buddy-websocket-close-codes': Record<string, string> } }
      >;
    };
    const codes =
      openapi.paths['/v1/events/stream']?.get['x-buddy-websocket-close-codes'];
    assert(codes !== undefined);
    assert.match(String(codes['4429']), /too_many_streams/u);
    assert.equal(STREAM_CLOSE_CODES.too_many_streams, 4429);
  },
);

// --- L1: 認証した端末ごとの頻度 ---

test(
  'L1: an authenticated device over its request rate is refused with 429 and other devices are unaffected',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t, {
      limits: { deviceWindowMs: 1_000, deviceMaxRequests: 3 },
    });
    const device = await insertDevice(started.store);
    const other = await insertDevice(started.store);
    for (let i = 0; i < 3; i += 1)
      assert.equal(
        (await bootstrap(started, device)).status,
        200,
        `request ${i + 1}`,
      );
    const over = await bootstrap(started, device);
    assert.equal(over.status, 429);
    assert.equal(over.json?.['code'], 'rate_limited');
    assert.deepEqual(Object.keys(over.json ?? {}).sort(), [
      'code',
      'message',
      'request_id',
    ]);
    // WSS の切り替えも同じ端末の数に入る。
    const stream = openStream(t, started, device);
    assert.deepEqual(await stream.opened, {
      ok: false,
      status: 429,
      code: 'rate_limited',
    });
    // 他の端末は自分の窓で数える。
    assert.equal((await bootstrap(started, other)).status, 200);
    // 窓を過ぎれば数え直す。
    started.clock.mono += 1_000;
    assert.equal((await bootstrap(started, device)).status, 200);
  },
);

test(
  'L1: the default device rate leaves room for normal use (reconnects, reports and streams)',
  { timeout: 60_000 },
  async (t) => {
    // 手書きの既定値（ADR 0020 の B03-07 の変更）: 端末ごとに 60 秒で 300 件。
    const started = await startApi(t);
    const device = await insertDevice(started.store);
    const cursor = encodeURIComponent(
      encodeEventCursor({
        storeGeneration: started.store.storeGeneration,
        sequence: 0,
        issuedAt: Date.now(),
      }),
    );
    // 同じ窓の中で 10 回の再接続（bootstrap・スナップショット・イベント・自宅の報告・購読の開閉）。
    // 経路の処理を渡していない経路は 503 になるが、頻度の上限（429）には掛からない。
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      statuses.push((await bootstrap(started, device)).status);
      for (const path of ['/v1/snapshot', `/v1/events?cursor=${cursor}`])
        statuses.push(
          (
            await pinnedRequest(started.target, {
              method: 'GET',
              path,
              headers: bearer(device.token),
            })
          ).status,
        );
      statuses.push(
        (
          await pinnedRequest(started.target, {
            method: 'POST',
            path: '/v1/home-network/reports',
            headers: {
              ...bearer(device.token),
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              request_id: '00000000-0000-4000-8000-000000009001',
              fingerprint: {
                gateway_mac: '00:00:5e:00:53:01',
                subnet: '192.0.2.0/24',
                ssid: null,
              },
            }),
          })
        ).status,
      );
      const stream = openStream(t, started, device);
      assert.deepEqual(await stream.opened, { ok: true }, `stream ${i + 1}`);
      stream.socket.close();
      await stream.closed;
    }
    assert.equal(statuses.length, 40);
    assert.equal(
      statuses.filter((status) => status === 429).length,
      0,
      statuses.join(','),
    );
  },
);
