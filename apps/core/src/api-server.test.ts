// HTTPS の受付の試験（ADR 0020）。127.0.0.1 の模擬で、DB は一時ディレクトリ、TLS の鍵は模擬の KeyStore。
// 期待値（HTTP の状態・コード・上限の値）は手書き。証明書の指紋の期待値は試験の中で X509Certificate から求める。
// 端末トークンは試験の中で作る合成の値で、アサーションのメッセージ・出力に入れない。

import assert from 'node:assert/strict';
import { X509Certificate, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { connect } from 'node:tls';
import { createMockTlsKeyStore } from '@buddy/platform';
import type { DbWorkerClient } from '@buddy/storage';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';
import { createDeviceToken } from './api-auth.js';
import type { RequestEnvironment } from './api-environment.js';
import { ApiListenError, createApiServer } from './api-server.js';
import type { ApiLimits, ApiServer } from './api-server.js';
import {
  STORE_GENERATION,
  insertDevice,
  jsonOfRaw,
  onCleanup,
  pinnedCheck,
  pinnedConnect,
  pinnedRequest,
  rawExchange,
  startTestStore,
  withTimeout,
  statusOf,
  tempDir,
} from './api-test-support.js';
import type { ApiResponse, PinnedTarget } from './api-test-support.js';
import { loadOrCreateTlsIdentity } from './tls-identity.js';
import type { TlsIdentity } from './tls-identity.js';

const CORE_INSTANCE = '00000000-0000-4000-8000-0000000000c1';
const HOUR = 3_600_000;
// 手書きの上限（02・ADR 0009 の設計初期値）。
const AUTHENTICATED_LIMIT = 262_144;
const PREAUTH_LIMIT = 16_384;

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;
const schema = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/contracts/schemas/buddy.schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { $id: string };
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validBootstrap = ajv.getSchema(`${schema.$id}#/$defs/Bootstrap`);
const validApiError = ajv.getSchema(`${schema.$id}#/$defs/ApiError`);
assert(validBootstrap && validApiError);

// 判定の元がまだない文脈をすべて満たす環境（試験用）。
const PASSING: RequestEnvironment = {
  homeNetwork: () => true,
  lockState: () => 'unlocked',
  hubLocal: () => true,
  audioOwner: () => 'self',
  revisionMatches: () => true,
  claimSecretMatches: () => true,
};

interface Started {
  readonly api: ApiServer;
  readonly store: DbWorkerClient;
  readonly identity: TlsIdentity;
  readonly target: PinnedTarget;
  readonly clock: { now: number; mono: number };
}

async function identityFor(t: test.TestContext): Promise<TlsIdentity> {
  return loadOrCreateTlsIdentity({
    dataDir: await tempDir(t, 'buddy-api-tls-'),
    tlsKeyStore: createMockTlsKeyStore(),
    now: new Date(),
  });
}

async function startApi(
  t: test.TestContext,
  options: {
    readonly environment?: Partial<RequestEnvironment>;
    readonly limits?: Partial<ApiLimits>;
    readonly store?: DbWorkerClient;
    readonly identity?: TlsIdentity;
  } = {},
): Promise<Started> {
  const identity = options.identity ?? (await identityFor(t));
  const store = options.store ?? (await startTestStore(t));
  const clock = { now: Date.UTC(2030, 9, 5), mono: 1_000 };
  const api = createApiServer({
    host: '127.0.0.1',
    port: 0,
    identity,
    store,
    coreInstanceId: CORE_INSTANCE,
    environment: options.environment ?? PASSING,
    limits: { preAuthMaxRequests: 1000, ...options.limits },
    now: () => clock.now,
    monotonicNow: () => clock.mono,
  });
  await api.listen();
  onCleanup(t, () => api.close(0));
  return {
    api,
    store,
    identity,
    clock,
    target: {
      host: '127.0.0.1',
      port: api.port,
      certificatePem: identity.certificatePem,
      fingerprint: identity.fingerprint,
    },
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const json = { 'content-type': 'application/json' };

function codeOf(response: ApiResponse): unknown {
  return response.json?.['code'];
}

// 拒否の応答の形（ApiError）と、本文にトークンを返していないこと。
function assertRejected(
  response: ApiResponse,
  status: number,
  code: string,
  label: string,
  secrets: readonly string[] = [],
): void {
  assert.equal(response.status, status, label);
  assert.equal(codeOf(response), code, label);
  assert(validApiError?.(response.json), `${label}: ApiError`);
  for (const secret of secrets)
    assert(!response.text.includes(secret), `${label}: secret echoed`);
}

async function bootstrap(
  started: Started,
  token: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<ApiResponse> {
  return pinnedRequest(started.target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: { ...bearer(token), ...headers },
  });
}

function stopIo(
  started: Started,
  token: string,
  scope: string,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<ApiResponse> {
  return pinnedRequest(started.target, {
    method: 'POST',
    path: '/v1/io/stop',
    headers: { ...bearer(token), ...json },
    body: JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: scope,
      scope: 'local',
      ...extra,
    }),
  });
}

test(
  'getBootstrap issues a 24-hour command scope for the authenticated device',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { device, token } = await insertDevice(started.store);
    // 本文・ヘッダーで別の端末を名乗っても、認証の結果の端末として扱う（X04 の端末 ID の偽装）。
    const response = await bootstrap(started, token, {
      'buddy-device-id': randomUUID(),
    });
    assert.equal(response.status, 200);
    assert(
      validBootstrap(response.json),
      JSON.stringify(validBootstrap.errors),
    );
    const body = response.json as Record<string, unknown>;
    assert.equal(body['device_id'], device.device_id);
    assert.equal(body['core_instance_id'], CORE_INSTANCE);
    assert.equal(body['store_generation'], STORE_GENERATION);
    assert.equal(body['api_version'], '1.0');
    assert.equal(
      Date.parse(String(body['command_scope_expires_at'])),
      started.clock.now + 24 * HOUR,
    );
    const io = body['io_state'] as Record<string, unknown>;
    assert.equal(io['device_id'], device.device_id);
    assert.equal(io['lock_state'], 'unknown');
    assert.equal(io['input_permitted'], false);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert(!response.text.includes(token));
    // DB に発行の記録が残り、端末の最終接続も更新される。
    const scope = await started.store.device({
      kind: 'scope.find',
      command_scope_id: String(body['command_scope_id']),
    });
    assert(scope.ok && scope.value !== null);
    assert.equal(scope.value.device_id, device.device_id);
    assert.equal(scope.value.core_instance_id, CORE_INSTANCE);
    assert.equal(scope.value.issued_at, started.clock.now);
  },
);

test(
  'missing, malformed, unknown and revoked tokens are rejected with 401',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { device, token } = await insertDevice(started.store);
    const unknown = createDeviceToken();
    const cases: readonly [string, Record<string, string>][] = [
      ['no token', {}],
      ['other scheme', { authorization: `Basic ${token}` }],
      ['short token', { authorization: `Bearer ${token.slice(1)}` }],
      ['padded token', { authorization: `Bearer ${token}=` }],
      ['unknown token', bearer(unknown)],
    ];
    for (const [label, headers] of cases) {
      const response = await pinnedRequest(started.target, {
        method: 'GET',
        path: '/v1/bootstrap',
        headers,
      });
      assertRejected(response, 401, 'unauthenticated', label, [token, unknown]);
      assert.equal(response.json?.['request_id'], null, label);
    }
    // 失効した端末のトークン。発行済みの接続範囲も同じ transaction で無効になる。
    const first = await bootstrap(started, token);
    assert.equal(first.status, 200);
    const revoked = await started.store.device({
      kind: 'device.revoke',
      device_id: device.device_id,
      revoked_at: started.clock.now,
    });
    assert(revoked.ok);
    assert.deepEqual(revoked.value, { revoked_scopes: 1 });
    assertRejected(
      await bootstrap(started, token),
      401,
      'unauthenticated',
      'revoked',
      [token],
    );
    assertRejected(
      await stopIo(started, token, String(first.json?.['command_scope_id'])),
      401,
      'unauthenticated',
      'revoked command',
      [token],
    );
  },
);

test(
  'a device_id in the body is invalid input and another device scope is stale',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const a = await insertDevice(started.store, { name: '端末A' });
    const b = await insertDevice(started.store, { name: '端末B' });
    const scopeA = String(
      (await bootstrap(started, a.token)).json?.['command_scope_id'],
    );
    const scopeB = String(
      (await bootstrap(started, b.token)).json?.['command_scope_id'],
    );
    // 本文で端末 ID を名乗る要求は契約にない項目として 422。
    assertRejected(
      await stopIo(started, a.token, scopeA, { device_id: b.device.device_id }),
      422,
      'invalid_input',
      'device_id in body',
    );
    // クエリーで名乗る要求も 422。
    assertRejected(
      await pinnedRequest(started.target, {
        method: 'GET',
        path: `/v1/bootstrap?device_id=${b.device.device_id}`,
        headers: bearer(a.token),
      }),
      422,
      'invalid_input',
      'device_id in query',
    );
    // 端末 A のトークンで端末 B の接続範囲を使うと、古い接続範囲として 410。
    assertRejected(
      await stopIo(started, a.token, scopeB),
      410,
      'expired_scope',
      'scope of another device',
    );
    // 自分の接続範囲は検査を通る（停止の経路は B03-04 なので 503 で閉じる）。
    assertRejected(
      await stopIo(started, a.token, scopeA),
      503,
      'dependency_unavailable',
      'own scope',
    );
  },
);

test(
  'command scopes are invalidated by a new bootstrap, expiry and another core instance',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { device, token } = await insertDevice(started.store);
    const first = String(
      (await bootstrap(started, token)).json?.['command_scope_id'],
    );
    const second = String(
      (await bootstrap(started, token)).json?.['command_scope_id'],
    );
    assert.notEqual(first, second);
    assertRejected(
      await stopIo(started, token, first),
      410,
      'expired_scope',
      'replaced',
    );
    assertRejected(
      await stopIo(started, token, second),
      503,
      'dependency_unavailable',
      'current',
    );
    // 期限（24 時間）の直前は有効、到達したら古い。
    started.clock.now += 24 * HOUR - 1;
    assertRejected(
      await stopIo(started, token, second),
      503,
      'dependency_unavailable',
      'just before expiry',
    );
    started.clock.now += 1;
    assertRejected(
      await stopIo(started, token, second),
      410,
      'expired_scope',
      'expired',
    );
    // 時計が発行より前へ戻ったときも古いものとして扱う。
    const third = String(
      (await bootstrap(started, token)).json?.['command_scope_id'],
    );
    started.clock.now -= 1;
    assertRejected(
      await stopIo(started, token, third),
      410,
      'expired_scope',
      'clock back',
    );
    // 別の起動 ID（再起動の前）の接続範囲は古い。
    const other = await started.store.device({
      kind: 'scope.issue',
      command_scope_id: randomUUID(),
      device_id: device.device_id,
      core_instance_id: '00000000-0000-4000-8000-0000000000c2',
      issued_at: started.clock.now - 1000,
      expires_at: started.clock.now + HOUR,
    });
    assert(other.ok);
    assertRejected(
      await stopIo(started, token, other.value.command_scope_id),
      410,
      'expired_scope',
      'other core instance',
    );
    // 発行していない ID も古い。
    assertRejected(
      await stopIo(started, token, randomUUID()),
      410,
      'expired_scope',
      'unknown scope',
    );
  },
);

test(
  'bodies over the limit are rejected with 413 without truncation',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { token } = await insertDevice(started.store);
    const scope = String(
      (await bootstrap(started, token)).json?.['command_scope_id'],
    );
    // ちょうど上限の本文（JSON の空白で埋める）は上限の検査を通る。
    const base = JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: scope,
      scope: 'local',
    });
    const padded = (size: number) =>
      base + ' '.repeat(size - Buffer.byteLength(base));
    const send = (
      body: string,
      headers: Record<string, string> = bearer(token),
    ) =>
      pinnedRequest(started.target, {
        method: 'POST',
        path: '/v1/io/stop',
        headers: { ...headers, ...json },
        body,
      });
    assertRejected(
      await send(padded(AUTHENTICATED_LIMIT)),
      503,
      'dependency_unavailable',
      'exactly 256 KiB',
    );
    // 宣言の長さが上限を超えたら、本文を読まずに 413 を返して接続を閉じる。
    const head = (length: number, auth = true) =>
      [
        'POST /v1/io/stop HTTP/1.1',
        'host: 127.0.0.1',
        ...(auth ? [`authorization: Bearer ${token}`] : []),
        'content-type: application/json',
        `content-length: ${length}`,
        '',
        '',
      ].join('\r\n');
    const declared = await rawExchange(
      started.target,
      head(AUTHENTICATED_LIMIT + 1),
    );
    assert.equal(statusOf(declared.text), 413);
    assert.equal(jsonOfRaw(declared.text)?.['code'], 'payload_too_large');
    assert.equal(declared.closed, true);
    // 宣言なし（chunked）で少しずつ送っても、上限を超えた時点で 413。
    const chunk = Buffer.from(`4000\r\n${' '.repeat(0x4000)}\r\n`);
    const chunked = await rawExchange(
      started.target,
      [
        'POST /v1/io/stop HTTP/1.1',
        'host: 127.0.0.1',
        `authorization: Bearer ${token}`,
        'content-type: application/json',
        'transfer-encoding: chunked',
        '',
        '',
      ].join('\r\n'),
      { drip: { chunk, intervalMs: 1, max: 64 } },
    );
    assert.equal(statusOf(chunked.text), 413);
    assert.equal(jsonOfRaw(chunked.text)?.['code'], 'payload_too_large');
    // 認証前（端末トークンなし）は、宣言の長さが上限を超えれば 413、上限内なら本文を読まずに 401。
    const unauthLarge = await rawExchange(
      started.target,
      head(AUTHENTICATED_LIMIT + 1, false),
    );
    assert.equal(statusOf(unauthLarge.text), 413);
    const unauth = await rawExchange(
      started.target,
      head(PREAUTH_LIMIT + 1, false),
    );
    assert.equal(statusOf(unauth.text), 401);
    assert.equal(unauth.closed, true);
    // 認証前の経路（登録の申請）は 16 KiB まで。
    const claim = JSON.stringify({
      request_id: randomUUID(),
      pairing_code: '12345678',
      device_name: '合成の端末',
      platform: 'windows',
      claim_secret_hash: 'c'.repeat(64),
      // 申請の自宅の指紋（B03-03、文書用の合成値）。
      home_fingerprint: {
        gateway_mac: '00:00:5e:00:53:01',
        subnet: '192.0.2.0/24',
        ssid: null,
      },
    });
    const claimPadded = (size: number) =>
      claim + ' '.repeat(size - Buffer.byteLength(claim));
    const sendClaim = (body: string) =>
      pinnedRequest(started.target, {
        method: 'POST',
        path: '/v1/pairing/claims',
        headers: json,
        body,
      });
    assertRejected(
      await sendClaim(claimPadded(PREAUTH_LIMIT)),
      503,
      'dependency_unavailable',
      'exactly 16 KiB before authentication',
    );
    const over = await rawExchange(
      started.target,
      [
        'POST /v1/pairing/claims HTTP/1.1',
        'host: 127.0.0.1',
        'content-type: application/json',
        `content-length: ${PREAUTH_LIMIT + 1}`,
        '',
        '',
      ].join('\r\n'),
    );
    assert.equal(statusOf(over.text), 413);
    // GET でも本文の上限は同じ（宣言の長さで先に拒否）。
    const getOver = await rawExchange(
      started.target,
      [
        'GET /v1/bootstrap HTTP/1.1',
        'host: 127.0.0.1',
        `authorization: Bearer ${token}`,
        `content-length: ${AUTHENTICATED_LIMIT + 1}`,
        '',
        '',
      ].join('\r\n'),
    );
    assert.equal(statusOf(getOver.text), 413);
    // 上限を超えた要求は処理していない（新しい接続範囲を発行していない）。
    assertRejected(
      await send(padded(AUTHENTICATED_LIMIT)),
      503,
      'dependency_unavailable',
      'scope still current',
    );
  },
);

test(
  'duplicate keys and other malformed requests are rejected with 422',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { token } = await insertDevice(started.store);
    const scope = String(
      (await bootstrap(started, token)).json?.['command_scope_id'],
    );
    const requestId = randomUUID();
    const send = (
      body: string | Uint8Array,
      headers: Record<string, string> = json,
      path = '/v1/io/stop',
    ) =>
      pinnedRequest(started.target, {
        method: 'POST',
        path,
        headers: { ...bearer(token), ...headers },
        body,
      });
    const valid = `{"request_id":"${requestId}","command_scope_id":"${scope}","scope":"local"}`;
    const cases: readonly [
      string,
      string | Uint8Array,
      Record<string, string>?,
    ][] = [
      [
        'duplicate key',
        `{"request_id":"${requestId}","command_scope_id":"${scope}","scope":"local","scope":"global"}`,
      ],
      [
        'duplicate request_id',
        `{"request_id":"${requestId}","request_id":"${randomUUID()}","command_scope_id":"${scope}","scope":"local"}`,
      ],
      ['not json', '{"request_id":'],
      ['array', '[]'],
      ['unknown field', valid.replace('}', ',"extra":true}')],
      [
        'missing field',
        `{"request_id":"${requestId}","command_scope_id":"${scope}"}`,
      ],
      ['wrong enum', valid.replace('"local"', '"everything"')],
      ['byte order mark', `\uFEFF${valid}`],
      [
        'invalid utf-8',
        Buffer.concat([
          Buffer.from(valid.slice(0, -1)),
          Buffer.from([0xff]),
          Buffer.from('}'),
        ]),
      ],
      ['empty body', ''],
      ['text content type', valid, { 'content-type': 'text/plain' }],
    ];
    for (const [label, body, headers] of cases)
      assertRejected(
        await send(body, headers ?? json),
        422,
        'invalid_input',
        label,
      );
    // 形式に合う本文は検査を通る。
    assertRejected(
      await send(valid),
      503,
      'dependency_unavailable',
      'valid body',
    );
    // 本文のない経路の本文・未知のクエリー・重複したクエリー・パスの値の形式違い。
    const get = (path: string, body?: string) =>
      pinnedRequest(started.target, {
        method: 'GET',
        path,
        headers: bearer(token),
        ...(body === undefined ? {} : { body }),
      });
    assertRejected(
      await get('/v1/bootstrap', '{}'),
      422,
      'invalid_input',
      'GET with body',
    );
    assertRejected(
      await get('/v1/snapshot?x=1'),
      422,
      'invalid_input',
      'unknown query',
    );
    assertRejected(
      await get('/v1/events'),
      422,
      'invalid_input',
      'missing cursor',
    );
    assertRejected(
      await get('/v1/events?cursor=a&cursor=b'),
      422,
      'invalid_input',
      'duplicate query',
    );
    assertRejected(
      await get('/v1/operations/not-a-uuid'),
      422,
      'invalid_input',
      'path value',
    );
    // 画面操作の経路で Buddy-Input-Origin がない・不正なら 422、voice なら画面操作でないとして 403。
    const revoke = (origin?: string) =>
      send(
        `{"request_id":"${requestId}","command_scope_id":"${scope}"}`,
        origin === undefined ? json : { ...json, 'buddy-input-origin': origin },
        `/v1/devices/${randomUUID()}/revoke`,
      );
    assertRejected(
      await revoke(),
      422,
      'invalid_input',
      'missing input origin',
    );
    assertRejected(
      await revoke('keyboard'),
      422,
      'invalid_input',
      'unknown input origin',
    );
    assertRejected(
      await revoke('voice'),
      403,
      'screen_operation_required',
      'voice origin',
    );
    // 拒否の request_id は形式に合う本文のものだけを返す。
    const missing = await send(
      `{"request_id":"${requestId}","command_scope_id":"${scope}"}`,
    );
    assert.equal(missing.json?.['request_id'], requestId);
  },
);

test(
  'unknown paths and methods are rejected',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { token } = await insertDevice(started.store);
    const response = await pinnedRequest(started.target, {
      method: 'GET',
      path: '/v1/unknown',
      headers: bearer(token),
    });
    assertRejected(response, 404, 'invalid_input', 'unknown path');
    assertRejected(
      await pinnedRequest(started.target, {
        method: 'DELETE',
        path: '/v1/bootstrap',
        headers: bearer(token),
      }),
      405,
      'invalid_input',
      'unknown method',
    );
  },
);

test(
  'requests with an Origin header are rejected, including WebSocket upgrades',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { token } = await insertDevice(started.store);
    assertRejected(
      await bootstrap(started, token, { origin: 'https://example.invalid' }),
      403,
      'forbidden',
      'origin',
      [token],
    );
    const status = await withTimeout(
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(
          `wss://127.0.0.1:${started.api.port}/v1/events/stream`,
          {
            headers: bearer(token),
            origin: 'https://example.invalid',
            ca: [started.identity.certificatePem],
            checkServerIdentity: pinnedCheck(
              started.identity.fingerprint,
            ) as unknown as ClientOptions['checkServerIdentity'],
          },
        );
        socket.on('unexpected-response', (request, response) => {
          resolve(response.statusCode ?? 0);
          request.destroy();
        });
        socket.on('open', () => reject(new Error('upgraded')));
        socket.on('error', () => undefined);
        // 応答の前に切られたときも待ちを終える（応答の後の close では resolve 済み）。
        socket.on('close', () => reject(new Error('closed_without_response')));
      }),
      10_000,
      'origin upgrade',
    );
    assert.equal(status, 403);
  },
);

test(
  'the event stream upgrade passes the checks and closes until delivery exists',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { token } = await insertDevice(started.store);
    // 開始位置のクエリー cursor は必須（ADR 0023）。形の検査だけで、配信を渡していないので切り替えた後に 1013。
    const open = (headers: Record<string, string>, query = '?cursor=c-1') =>
      withTimeout(
        new Promise<{ upgraded: boolean; code: number }>((resolve) => {
          const socket = new WebSocket(
            `wss://127.0.0.1:${started.api.port}/v1/events/stream${query}`,
            {
              headers,
              ca: [started.identity.certificatePem],
              checkServerIdentity: pinnedCheck(
                started.identity.fingerprint,
              ) as unknown as ClientOptions['checkServerIdentity'],
            },
          );
          let upgraded = false;
          socket.on('open', () => (upgraded = true));
          socket.on('unexpected-response', (request, response) => {
            resolve({ upgraded: false, code: response.statusCode ?? 0 });
            request.destroy();
          });
          socket.on('close', (code) => resolve({ upgraded, code }));
          socket.on('error', () => undefined);
        }),
        10_000,
        'event stream upgrade',
      );
    assert.deepEqual(await open(bearer(token)), { upgraded: true, code: 1013 });
    assert.deepEqual(await open({}), { upgraded: false, code: 401 });
    assert.deepEqual(await open(bearer(token), ''), {
      upgraded: false,
      code: 422,
    });
    // 通常の GET（切り替えの要求でない）は形式の不正。
    assertRejected(
      await pinnedRequest(started.target, {
        method: 'GET',
        path: '/v1/events/stream',
        headers: bearer(token),
      }),
      422,
      'invalid_input',
      'plain GET',
    );
  },
);

test(
  'connections over the limit receive 429 and are closed',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t, { limits: { maxConnections: 2 } });
    const { token } = await insertDevice(started.store);
    const first = await pinnedConnect(started.target);
    const second = await pinnedConnect(started.target);
    onCleanup(t, () => {
      first.destroy();
      second.destroy();
    });
    // 2 本を保ったまま 3 本目で要求すると 429。
    assertRejected(
      await bootstrap(started, token),
      429,
      'rate_limited',
      'third connection',
    );
    first.destroy();
    second.destroy();
    // 接続が減れば受け付ける（閉じた接続の数え直しを待つ）。
    let response = await bootstrap(started, token);
    for (let i = 0; i < 20 && response.status === 429; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      response = await bootstrap(started, token);
    }
    assert.equal(response.status, 200);
  },
);

test(
  'unauthenticated requests over the pre-auth rate are rejected with 429',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t, {
      limits: { preAuthMaxRequests: 3, preAuthWindowMs: 1000 },
    });
    const { token } = await insertDevice(started.store);
    // 認証した要求は数えない。
    for (let i = 0; i < 5; i += 1)
      assert.equal((await bootstrap(started, token)).status, 200);
    const anonymous = () =>
      pinnedRequest(started.target, { method: 'GET', path: '/v1/bootstrap' });
    for (let i = 0; i < 3; i += 1)
      assertRejected(
        await anonymous(),
        401,
        'unauthenticated',
        `attempt ${i + 1}`,
      );
    assertRejected(await anonymous(), 429, 'rate_limited', 'over the rate');
    // 上限に達した接続元は、トークンを照合する前に拒否する（推測の試行を続けさせない）。
    assertRejected(
      await bootstrap(started, token),
      429,
      'rate_limited',
      'valid token',
    );
    // 窓を過ぎれば数え直す。
    started.clock.mono += 1000;
    assertRejected(await anonymous(), 401, 'unauthenticated', 'next window');
    assert.equal((await bootstrap(started, token)).status, 200);
  },
);

test(
  'a pinned client sends nothing to a hub with another certificate and TLS 1.2 is refused',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t);
    const { token } = await insertDevice(started.store);
    // 試験側で求めた指紋（X509Certificate#fingerprint256 のコロンを除いた小文字）が中枢の指紋と一致する。
    const expected = new X509Certificate(
      started.identity.certificatePem,
    ).fingerprint256
      .replace(/:/gu, '')
      .toLowerCase();
    assert.equal(started.identity.fingerprint, expected);
    assert.equal(started.api.fingerprint, expected);
    // 別の証明書を出す中枢（同じ DB・別の鍵）。
    const other = await startApi(t, { store: started.store });
    assert.notEqual(other.identity.fingerprint, expected);
    const before = other.api.requestsReceived;
    // 1) 登録した証明書を信頼の起点にしたクライアント: 別の中枢の証明書は検証で拒否される。
    await assert.rejects(
      pinnedRequest(
        { ...started.target, port: other.api.port },
        { method: 'GET', path: '/v1/bootstrap', headers: bearer(token) },
      ),
      (error: NodeJS.ErrnoException) => error.code !== undefined,
    );
    // 2) 信頼の起点は合っていても、ピン留めした指紋が違えば checkServerIdentity で拒否される。
    await assert.rejects(
      pinnedRequest(
        {
          ...other.target,
          fingerprint: expected,
        },
        { method: 'GET', path: '/v1/bootstrap', headers: bearer(token) },
      ),
      /certificate_fingerprint_mismatch/u,
    );
    // どちらでも、別の中枢には要求が 1 件も届いていない。
    assert.equal(other.api.requestsReceived, before);
    // 正しい中枢には届く。
    assert.equal((await bootstrap(started, token)).status, 200);
    // TLS 1.2 以下のクライアントは TLS の段階で拒否され、要求は届かない。
    const received = started.api.requestsReceived;
    await assert.rejects(
      pinnedConnect({
        ...started.target,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      }),
    );
    await assert.rejects(
      new Promise((resolve, reject) => {
        const socket = connect({
          host: '127.0.0.1',
          port: started.api.port,
          minVersion: 'TLSv1',
          maxVersion: 'TLSv1.2',
          ca: [started.identity.certificatePem],
          checkServerIdentity: () => undefined,
        });
        socket.once('secureConnect', () => {
          socket.destroy();
          resolve(null);
        });
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('closed')));
        setTimeout(() => {
          socket.destroy();
          reject(new Error('tls12_timeout'));
        }, 10_000).unref();
      }),
    );
    assert.equal(started.api.requestsReceived, received);
  },
);

test(
  'a stopped store answers 503 and listening hosts are validated',
  { timeout: 30_000 },
  async (t) => {
    const store = await startTestStore(t);
    const { token } = await insertDevice(store);
    const started = await startApi(t, { store });
    await store.close();
    assertRejected(
      await bootstrap(started, token),
      503,
      'dependency_unavailable',
      'closed store',
      [token],
    );
    const identity = started.identity;
    for (const host of ['0.0.0.0', '::', '0:0::0', 'localhost', ''])
      assert.throws(
        () =>
          createApiServer({
            host,
            port: 0,
            identity,
            store,
            coreInstanceId: CORE_INSTANCE,
          }),
        ApiListenError,
        host,
      );
    assert.throws(
      () =>
        createApiServer({
          host: '127.0.0.1',
          port: 70_000,
          identity,
          store,
          coreInstanceId: CORE_INSTANCE,
        }),
      ApiListenError,
    );
  },
);

test(
  'the safe default environment only lets hub-local devices through and refuses lock checks',
  { timeout: 30_000 },
  async (t) => {
    const started = await startApi(t, { environment: {} });
    const remote = await insertDevice(started.store, { hubLocal: false });
    const hub = await insertDevice(started.store, { hubLocal: true });
    // 自宅判定は B03-03。それまでは中枢と同じマシンの端末だけが通る。
    assertRejected(
      await bootstrap(started, remote.token),
      403,
      'outside_home_network',
      'remote device',
    );
    const response = await bootstrap(started, hub.token);
    assert.equal(response.status, 200);
    const scope = String(response.json?.['command_scope_id']);
    // ロック状態の元がないので、ロック解除を求める経路は 403。
    assertRejected(
      await pinnedRequest(started.target, {
        method: 'POST',
        path: '/v1/sessions',
        headers: { ...bearer(hub.token), ...json },
        body: JSON.stringify({
          request_id: randomUUID(),
          command_scope_id: scope,
          storage_mode: 'normal',
        }),
      }),
      403,
      'device_locked',
      'lock unknown',
    );
  },
);
