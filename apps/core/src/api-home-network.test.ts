// 自宅ネットワークの判定（X42、ADR 0022）を HTTPS の要求で確かめる。127.0.0.1 の模擬で、DB は一時ディレクトリ、
// TLS の鍵は模擬の KeyStore、Tailscale は模擬の runner が返す合成の `tailscale status --json`（実機の tailscale は呼ばない）。
// 試験のクライアントは 127.0.0.1 から接続するので、合成の Tailscale のピアのアドレスを 127.0.0.1 にしている。
// MAC・SSID・アドレスは文書用の合成値（00:00:5e:00:53:xx・RFC 5737）。期待値（状態・コード・理由・HMAC）は手で書いた値で、
// HMAC の期待値は openssl dgst -sha256 -mac HMAC で別に求めた値。端末トークンは出力に出さない。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  createMockCommandRunner,
  createMockTlsKeyStore,
  createTailscaleStatusSource,
} from '@buddy/platform';
import type { DbWorkerClient } from '@buddy/storage';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';
import { HomeNetworkKey, createHomeNetworkGate } from './api-home-network.js';
import { isSameMachine } from './api-pairing.js';
import type { HomeNetworkGate } from './api-home-network.js';
import { createApiServer } from './api-server.js';
import { API_ROUTES } from './api-routes.js';
import {
  insertDevice,
  onCleanup,
  pinnedCheck,
  pinnedRequest,
  startTestStore,
  tempDir,
  withTimeout,
} from './api-test-support.js';
import type {
  ApiResponse,
  PinnedTarget,
  TestDevice,
} from './api-test-support.js';
import { loadOrCreateTlsIdentity } from './tls-identity.js';

const CORE_INSTANCE = '00000000-0000-4000-8000-0000000000c1';
const SIX_MINUTES = 360_000;
const T0 = Date.UTC(2030, 9, 5);
// 合成のデータ鍵（0x00〜0x1f）。実データの鍵ではない。
const DATA_KEY = {
  keyId: 'data-key-v1',
  key: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
};
// openssl で別に求めた HMAC（鍵は DATA_KEY から HMAC-SHA256 で導いた値）。
const MAC_HMAC =
  '5e6d1ce16d9bddb06a90a8f54290cd489c046016cec034ad32a65053c654560c';
const SSID_HMAC =
  'd2a2ee15f5db80c53170058ca13d6e622d8cc88150b678537bbfd4f7fed35698';
const HOME = {
  gateway_mac: '00:00:5e:00:53:01',
  subnet: '192.0.2.0/24',
  ssid: '合成の自宅',
};

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
const validStatus = ajv.getSchema(`${schema.$id}#/$defs/HomeNetworkStatus`);
const validRegistration = ajv.getSchema(
  `${schema.$id}#/$defs/HomeRegistration`,
);
const validApiError = ajv.getSchema(`${schema.$id}#/$defs/ApiError`);
assert(validStatus && validRegistration && validApiError);

// 合成の Tailscale の状態。peer が null なら接続元のピアはない。exit が 0 でなければ取得できない。
interface TailscaleState {
  exit: number;
  backend: string;
  peer: {
    readonly CurAddr?: string;
    readonly Relay?: string;
    readonly PeerRelay?: string;
  } | null;
}

interface Started {
  readonly store: DbWorkerClient;
  readonly gate: HomeNetworkGate;
  readonly target: PinnedTarget;
  readonly port: number;
  readonly certificatePem: string;
  readonly fingerprint: string;
  readonly clock: { now: number };
  readonly tailscale: TailscaleState;
  readonly sameMachine: { value: boolean };
  readonly denied: { deviceId: string; reasons: readonly string[] }[];
  readonly logs: string[];
  readonly hub: TestDevice;
  readonly remote: TestDevice;
}

const DIRECT = { CurAddr: '192.0.2.23:41641', Relay: 'tok' } as const;

async function start(t: test.TestContext): Promise<Started> {
  const identity = await loadOrCreateTlsIdentity({
    dataDir: await tempDir(t, 'buddy-home-tls-'),
    tlsKeyStore: createMockTlsKeyStore(),
    now: new Date(),
  });
  const store = await startTestStore(t);
  const clock = { now: T0 };
  const tailscale: TailscaleState = {
    exit: 0,
    backend: 'Running',
    peer: { ...DIRECT },
  };
  const runner = createMockCommandRunner(() => {
    if (tailscale.exit !== 0)
      return { exitCode: tailscale.exit, stdout: '', stderr: 'synthetic' };
    return {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        BackendState: tailscale.backend,
        Self: { TailscaleIPs: ['100.64.0.1'] },
        Peer:
          tailscale.peer === null
            ? {}
            : {
                'nodekey:synthetic': {
                  TailscaleIPs: ['127.0.0.1'],
                  ...tailscale.peer,
                },
              },
      }),
    };
  });
  const sameMachine = { value: true };
  const logs: string[] = [];
  const gate = createHomeNetworkGate({
    store,
    key: HomeNetworkKey.fromDataKey(DATA_KEY),
    tailscale: createTailscaleStatusSource({
      runner,
      commands: ['tailscale'],
      ttlMs: 0,
    }),
    sameMachine: (remote) =>
      sameMachine.value && isSameMachine(remote, '127.0.0.1'),
    now: () => clock.now,
    log: (message) => logs.push(message),
  });
  const denied: { deviceId: string; reasons: readonly string[] }[] = [];
  gate.onDenied((deviceId, reasons) => denied.push({ deviceId, reasons }));
  const api = createApiServer({
    host: '127.0.0.1',
    port: 0,
    identity,
    store,
    coreInstanceId: CORE_INSTANCE,
    environment: {
      homeNetwork: gate.homeNetwork,
      lockState: () => 'unlocked',
      hubLocal: ({ device }) => device?.hub_local === true,
      audioOwner: () => 'self',
      revisionMatches: () => true,
      claimSecretMatches: () => true,
    },
    handlers: gate.handlers,
    limits: { preAuthMaxRequests: 1000 },
    now: () => clock.now,
  });
  await api.listen();
  onCleanup(t, () => api.close(0));
  const hub = await insertDevice(store, { hubLocal: true, name: '合成の中枢' });
  const remote = await insertDevice(store, { hubLocal: false });
  return {
    store,
    gate,
    port: api.port,
    certificatePem: identity.certificatePem,
    fingerprint: identity.fingerprint,
    target: {
      host: '127.0.0.1',
      port: api.port,
      certificatePem: identity.certificatePem,
      fingerprint: identity.fingerprint,
    },
    clock,
    tailscale,
    sameMachine,
    denied,
    logs,
    hub,
    remote,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const json = { 'content-type': 'application/json' };

function bootstrap(
  started: Started,
  token: string | null,
): Promise<ApiResponse> {
  return pinnedRequest(started.target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: token === null ? {} : bearer(token),
  });
}

function report(
  started: Started,
  token: string,
  fingerprint: Record<string, unknown>,
): Promise<ApiResponse> {
  return pinnedRequest(started.target, {
    method: 'POST',
    path: '/v1/home-network/reports',
    headers: { ...bearer(token), ...json },
    body: JSON.stringify({ request_id: randomUUID(), fingerprint }),
  });
}

async function register(
  started: Started,
  body: Record<string, unknown> = HOME,
): Promise<ApiResponse> {
  const scope = await bootstrap(started, started.hub.token);
  assert.equal(scope.status, 200, 'hub bootstrap');
  return pinnedRequest(started.target, {
    method: 'PUT',
    path: '/v1/home-network/registration',
    headers: {
      ...bearer(started.hub.token),
      ...json,
      'buddy-input-origin': 'screen',
    },
    body: JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: String(scope.json?.['command_scope_id']),
      ...body,
    }),
  });
}

function assertRejected(
  response: ApiResponse,
  status: number,
  code: string,
  label: string,
  secrets: readonly string[],
): void {
  assert.equal(response.status, status, label);
  assert.equal(response.json?.['code'], code, label);
  assert(validApiError?.(response.json), label);
  for (const secret of secrets)
    assert(!response.text.includes(secret), `${label}: leaked a secret`);
}

async function scopeRevoked(
  started: Started,
  scopeId: string,
): Promise<boolean> {
  const found = await started.store.device({
    kind: 'scope.find',
    command_scope_id: scopeId,
  });
  assert(found.ok && found.value !== null);
  return found.value.revoked_at !== null;
}

// 自宅を登録し、遠隔の端末が一致する指紋を報告して接続範囲を受け取った状態にする。
async function allowedRemote(started: Started): Promise<string> {
  assert.equal((await register(started)).status, 200);
  const reported = await report(started, started.remote.token, HOME);
  assert.equal(reported.status, 200);
  assert.equal(reported.json?.['allowed'], true);
  const response = await bootstrap(started, started.remote.token);
  assert.equal(response.status, 200, 'remote bootstrap at home');
  return String(response.json?.['command_scope_id']);
}

test(
  'the home key is derived from the data key and MAC and SSID are stored only as HMAC',
  { timeout: 30_000 },
  async (t) => {
    const key = HomeNetworkKey.fromDataKey(DATA_KEY);
    assert.equal(key.gatewayMac(HOME.gateway_mac), MAC_HMAC);
    assert.equal(key.ssid(HOME.ssid), SSID_HMAC);
    // 鍵の値は文字列化・JSON・inspect に出さない。
    assert.equal(String(key), '[redacted]');
    assert.equal(JSON.stringify({ key }), '{"key":"[redacted]"}');
    assert(!inspect(key).includes('59fed0'));
    assert.throws(() =>
      HomeNetworkKey.fromDataKey({
        keyId: 'data-key-v1',
        key: Buffer.alloc(16),
      }),
    );
    const started = await start(t);
    const registered = await register(started);
    assert.equal(registered.status, 200);
    assert(validRegistration?.(registered.json), registered.text);
    assert.deepEqual(registered.json, {
      subnet: '192.0.2.0/24',
      ssid_registered: true,
      registered_at: new Date(T0).toISOString(),
    });
    const stored = await started.store.home({ kind: 'home.get' });
    assert(stored.ok && stored.value !== null);
    assert.equal(stored.value.gateway_mac_hmac, MAC_HMAC);
    assert.equal(stored.value.ssid_hmac, SSID_HMAC);
    assert.equal(
      stored.value.registered_by_device_id,
      started.hub.device.device_id,
    );
    // 応答・記録に MAC・SSID の値を出さない。
    for (const text of [registered.text, ...started.logs]) {
      assert(!text.includes(HOME.gateway_mac));
      assert(!text.includes(HOME.ssid));
    }
    const reported = await report(started, started.remote.token, HOME);
    assert(validStatus?.(reported.json), reported.text);
    const found = await started.store.home({
      kind: 'home.find_report',
      device_id: started.remote.device.device_id,
    });
    assert(found.ok && found.value !== null);
    assert.deepEqual(found.value, {
      device_id: started.remote.device.device_id,
      gateway_mac_hmac: MAC_HMAC,
      subnet: '192.0.2.0/24',
      ssid_hmac: SSID_HMAC,
      received_at: T0,
    });
  },
);

test(
  'X42: a matching fingerprint over a direct path inside the home LAN is allowed only with a device token',
  { timeout: 30_000 },
  async (t) => {
    const started = await start(t);
    await allowedRemote(started);
    const reported = await report(started, started.remote.token, HOME);
    assert.deepEqual(reported.json, {
      allowed: true,
      exempt: false,
      reasons: [],
      report_expires_at: new Date(T0 + SIX_MINUTES).toISOString(),
    });
    // 端末認証が先。トークンがない・失効した端末は自宅の中でも 401。
    assertRejected(
      await bootstrap(started, null),
      401,
      'unauthenticated',
      'no token',
      [],
    );
    const revoked = await started.store.device({
      kind: 'device.revoke',
      device_id: started.remote.device.device_id,
      revoked_at: T0,
    });
    assert(revoked.ok);
    assertRejected(
      await bootstrap(started, started.remote.token),
      401,
      'unauthenticated',
      'revoked device at home',
      [started.remote.token],
    );
    assertRejected(
      await report(started, started.remote.token, HOME),
      401,
      'unauthenticated',
      'revoked device report',
      [started.remote.token],
    );
    assert.deepEqual(started.denied, []);
  },
);

test(
  'X42: fingerprint mismatch, DERP, an unknown route and an unavailable Tailscale are refused with 403 and revoke the scope',
  { timeout: 60_000 },
  async (t) => {
    const started = await start(t);
    const cases: {
      readonly label: string;
      readonly reasons: readonly string[];
      readonly arrange: () => Promise<void> | void;
    }[] = [
      {
        label: 'fingerprint mismatch',
        reasons: ['gateway_mac_mismatch'],
        arrange: async () => {
          const response = await report(started, started.remote.token, {
            ...HOME,
            gateway_mac: '00:00:5e:00:53:02',
          });
          assert.equal(response.status, 200);
          assert.deepEqual(response.json?.['reasons'], [
            'gateway_mac_mismatch',
          ]);
          assert.equal(response.json?.['allowed'], false);
        },
      },
      {
        label: 'DERP',
        reasons: ['tailscale_derp'],
        arrange: () => {
          started.tailscale.peer = { CurAddr: '', Relay: 'tok' };
        },
      },
      {
        label: 'route unknown',
        reasons: ['direct_address_missing'],
        arrange: () => {
          started.tailscale.peer = { CurAddr: '' };
        },
      },
      {
        label: 'tailscale status unavailable',
        reasons: ['tailscale_unavailable'],
        arrange: () => {
          started.tailscale.exit = 1;
        },
      },
      {
        label: 'tailscale stopped',
        reasons: ['tailscale_unavailable'],
        arrange: () => {
          started.tailscale.backend = 'Stopped';
        },
      },
      {
        label: 'peer not found',
        reasons: ['tailscale_peer_not_found'],
        arrange: () => {
          started.tailscale.peer = null;
        },
      },
      {
        label: 'fingerprint only (direct address outside the home subnet)',
        reasons: ['direct_address_outside_home'],
        arrange: () => {
          started.tailscale.peer = {
            CurAddr: '198.51.100.7:41641',
            Relay: 'tok',
          };
        },
      },
    ];
    for (const entry of cases) {
      // 毎回、自宅の中で許可された状態から始める。
      started.tailscale.exit = 0;
      started.tailscale.backend = 'Running';
      started.tailscale.peer = { ...DIRECT };
      started.denied.length = 0;
      const scope = await allowedRemote(started);
      assert.equal(await scopeRevoked(started, scope), false, entry.label);
      await entry.arrange();
      assertRejected(
        await bootstrap(started, started.remote.token),
        403,
        'outside_home_network',
        entry.label,
        [started.remote.token],
      );
      // 発行済みの接続範囲を失効させ、WSS を閉じる差し込み口へ知らせる。
      assert.equal(await scopeRevoked(started, scope), true, entry.label);
      assert(started.denied.length >= 1, entry.label);
      assert.deepEqual(
        started.denied.at(-1),
        { deviceId: started.remote.device.device_id, reasons: entry.reasons },
        entry.label,
      );
      // 古い接続範囲を使う命令も、自宅判定で先に拒否する（指紋だけでは通らない）。
      assertRejected(
        await pinnedRequest(started.target, {
          method: 'POST',
          path: '/v1/io/stop',
          headers: { ...bearer(started.remote.token), ...json },
          body: JSON.stringify({
            request_id: randomUUID(),
            command_scope_id: scope,
            scope: 'global',
          }),
        }),
        403,
        'outside_home_network',
        `${entry.label} command`,
        [],
      );
    }
    // 記録は理由のコードと端末 ID だけで、MAC・SSID・アドレスを含めない。
    for (const line of started.logs) {
      assert(!line.includes(HOME.gateway_mac), line);
      assert(!line.includes('192.0.2.23'), line);
    }
  },
);

test(
  'X42: a report older than six minutes is refused and a fresh report restores the check',
  { timeout: 30_000 },
  async (t) => {
    const started = await start(t);
    await allowedRemote(started);
    started.clock.now = T0 + SIX_MINUTES - 1;
    assert.equal((await bootstrap(started, started.remote.token)).status, 200);
    started.clock.now = T0 + SIX_MINUTES;
    assertRejected(
      await bootstrap(started, started.remote.token),
      403,
      'outside_home_network',
      'stale report',
      [],
    );
    assert.deepEqual(started.denied.at(-1)?.reasons, ['report_stale']);
    // 時計が報告より前へ戻ったときも使わない。
    started.clock.now = T0 - 1;
    assertRejected(
      await bootstrap(started, started.remote.token),
      403,
      'outside_home_network',
      'clock went back',
      [],
    );
    started.clock.now = T0 + SIX_MINUTES;
    const reported = await report(started, started.remote.token, HOME);
    assert.equal(reported.json?.['allowed'], true);
    assert.equal((await bootstrap(started, started.remote.token)).status, 200);
  },
);

test(
  'SSID is compared only when both sides have it, and MAC and subnet are required',
  { timeout: 30_000 },
  async (t) => {
    const started = await start(t);
    assert.equal((await register(started)).status, 200);
    const statusOf = async (fingerprint: Record<string, unknown>) =>
      (await report(started, started.remote.token, fingerprint)).json;
    assert.deepEqual(
      (await statusOf({ ...HOME, ssid: null }))?.['reasons'],
      [],
    );
    assert.deepEqual(
      (await statusOf({ ...HOME, ssid: '合成の別の家' }))?.['reasons'],
      ['ssid_mismatch'],
    );
    assert.deepEqual(
      (await statusOf({ gateway_mac: null, subnet: null, ssid: HOME.ssid }))?.[
        'reasons'
      ],
      ['gateway_mac_unavailable', 'subnet_unavailable'],
    );
    assert.deepEqual(
      (await statusOf({ ...HOME, subnet: '198.51.100.0/24' }))?.['reasons'],
      ['subnet_mismatch'],
    );
    // 登録で SSID がなければ比べない（登録し直すと置き換える）。
    assert.equal(
      (await register(started, { ...HOME, ssid: null })).json?.[
        'ssid_registered'
      ],
      false,
    );
    assert.deepEqual(
      (await statusOf({ ...HOME, ssid: '合成の別の家' }))?.['reasons'],
      [],
    );
    // ネットワークのアドレスでないサブネットは形式の不正（報告・登録とも 422）。
    assertRejected(
      await report(started, started.remote.token, {
        ...HOME,
        subnet: '192.0.2.23/24',
      }),
      422,
      'invalid_input',
      'host bits in reported subnet',
      [],
    );
    assertRejected(
      await register(started, { ...HOME, subnet: '192.0.2.23/24' }),
      422,
      'invalid_input',
      'host bits in registered subnet',
      [],
    );
    // 未登録なら判定できないので拒否する。
    const fresh = await start(t);
    const status = await report(fresh, fresh.remote.token, HOME);
    assert.deepEqual(status.json?.['reasons'], ['home_not_registered']);
  },
);

test(
  'the same-machine hub client is exempt only from the home check and still needs its token',
  { timeout: 30_000 },
  async (t) => {
    const started = await start(t);
    // 自宅が未登録・Tailscale を取得できない・報告なしでも、同じマシンの hub_local の端末は通る。
    started.tailscale.exit = 1;
    assert.equal((await bootstrap(started, started.hub.token)).status, 200);
    const reported = await report(started, started.hub.token, {
      gateway_mac: null,
      subnet: null,
      ssid: null,
    });
    assert.deepEqual(reported.json, {
      allowed: true,
      exempt: true,
      reasons: [],
      report_expires_at: null,
    });
    // トークンがなければ 401（免除は自宅判定だけ）。
    assertRejected(
      await bootstrap(started, null),
      401,
      'unauthenticated',
      'hub without token',
      [],
    );
    // hub_local でない端末は同じマシンからでも免除しない。
    assertRejected(
      await bootstrap(started, started.remote.token),
      403,
      'outside_home_network',
      'non-hub device on the same machine',
      [],
    );
    // hub_local の端末でも、接続元が同じマシンでなければ免除しない（トークンの持ち出し）。
    started.sameMachine.value = false;
    assertRejected(
      await bootstrap(started, started.hub.token),
      403,
      'outside_home_network',
      'hub token from another machine',
      [],
    );
    // 外出先からの接続を有効にする経路はない。
    for (const route of API_ROUTES)
      assert(
        !/outside|away|remote_?access/iu.test(route.operationId),
        route.operationId,
      );
    assert.equal(isSameMachine('::ffff:127.0.0.1', '100.64.0.1'), true);
    assert.equal(isSameMachine('100.64.0.1', '100.64.0.1'), true);
    assert.equal(isSameMachine('100.64.0.2', '100.64.0.1'), false);
    assert.equal(isSameMachine('', '100.64.0.1'), false);
  },
);

test(
  'pairing claims and token pickup are checked with the fingerprint in the body and the direct path',
  { timeout: 30_000 },
  async (t) => {
    const started = await start(t);
    assert.equal((await register(started)).status, 200);
    started.sameMachine.value = false;
    const claim = (fingerprint: Record<string, unknown>) =>
      pinnedRequest(started.target, {
        method: 'POST',
        path: '/v1/pairing/claims',
        headers: json,
        body: JSON.stringify({
          request_id: randomUUID(),
          pairing_code: '12345678',
          device_name: '合成の端末',
          platform: 'windows',
          claim_secret_hash: 'c'.repeat(64),
          home_fingerprint: fingerprint,
        }),
      });
    const pickup = (fingerprint: Record<string, unknown>) =>
      pinnedRequest(started.target, {
        method: 'POST',
        path: `/v1/pairing/claims/${randomUUID()}/token`,
        headers: json,
        body: JSON.stringify({
          claim_secret: 'B'.repeat(43),
          home_fingerprint: fingerprint,
        }),
      });
    // 自宅判定を通った後の処理は B03-02（このブランチでは 503）。
    for (const send of [claim, pickup]) {
      assertRejected(
        await send(HOME),
        503,
        'dependency_unavailable',
        'at home',
        [],
      );
      assertRejected(
        await send({ ...HOME, gateway_mac: '00:00:5e:00:53:02' }),
        403,
        'outside_home_network',
        'fingerprint mismatch before pairing',
        [],
      );
      started.tailscale.peer = { CurAddr: '', Relay: 'tok' };
      assertRejected(
        await send(HOME),
        403,
        'outside_home_network',
        'DERP before pairing',
        [],
      );
      started.tailscale.peer = { ...DIRECT };
    }
    // 登録前の同じマシンからの申請・受取りは免除する（最初の端末の登録）。
    started.sameMachine.value = true;
    started.tailscale.exit = 1;
    assertRejected(
      await claim({ gateway_mac: null, subnet: null, ssid: null }),
      503,
      'dependency_unavailable',
      'same machine claim',
      [],
    );
    // 端末がないので失効・通知はない。
    assert.deepEqual(started.denied, []);
  },
);

test(
  'a WebSocket upgrade is refused outside the home network and the denial hook fires',
  { timeout: 30_000 },
  async (t) => {
    const started = await start(t);
    await allowedRemote(started);
    started.tailscale.peer = { CurAddr: '', Relay: 'tok' };
    const outcome = await withTimeout(
      new Promise<{ status: number; code: unknown }>((resolve, reject) => {
        const socket = new WebSocket(
          `wss://127.0.0.1:${started.port}/v1/events/stream?cursor=c-1`,
          {
            headers: bearer(started.remote.token),
            ca: [started.certificatePem],
            checkServerIdentity: pinnedCheck(
              started.fingerprint,
            ) as unknown as ClientOptions['checkServerIdentity'],
            minVersion: 'TLSv1.3',
          },
        );
        socket.on('unexpected-response', (request, response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              code?: unknown;
            };
            resolve({ status: response.statusCode ?? 0, code: body.code });
            request.destroy();
          });
          response.on('error', reject);
        });
        socket.on('open', () => {
          socket.close();
          reject(new Error('upgraded outside the home network'));
        });
        socket.on('error', (error) => {
          if (socket.readyState !== WebSocket.CLOSED) reject(error);
        });
      }),
      10_000,
      'websocket outside home',
    );
    assert.deepEqual(outcome, { status: 403, code: 'outside_home_network' });
    assert.deepEqual(started.denied.at(-1)?.reasons, ['tailscale_derp']);
  },
);

test(
  'a DB failure while checking is not turned into an allowance',
  { timeout: 30_000 },
  async (t) => {
    const started = await start(t);
    await allowedRemote(started);
    // 自宅の登録値・報告を読めない store。判定は例外になり（経路の検査は 503）、許可にはしない。
    const failing = {
      home: () =>
        Promise.resolve({
          ok: false as const,
          outcome: 'rejected' as const,
          reasons: ['worker_unavailable'],
        }),
    } as unknown as Pick<DbWorkerClient, 'home'>;
    const gate = createHomeNetworkGate({
      store: failing,
      key: HomeNetworkKey.fromDataKey(DATA_KEY),
      tailscale: createTailscaleStatusSource({
        runner: createMockCommandRunner(() => ({
          exitCode: 0,
          stdout: '{}',
          stderr: '',
        })),
        commands: ['tailscale'],
        ttlMs: 0,
      }),
      sameMachine: () => false,
      now: () => T0,
    });
    await assert.rejects(
      Promise.resolve(
        gate.homeNetwork({
          operationId: 'getBootstrap',
          device: started.remote.device,
          remoteAddress: '127.0.0.1',
          params: {},
          body: null,
          declaredLockState: null,
        }),
      ),
      { name: 'HomeNetworkStoreError' },
    );
    // HTTP では DB worker が止まれば 503（許可にしない）。
    await started.store.close();
    const response = await bootstrap(started, started.remote.token);
    assert.equal(response.status, 503);
    assert.equal(response.json?.['code'], 'dependency_unavailable');
  },
);

test(
  'L1: repeated failures of the same device revoke its scopes once until the check passes again (B03-07)',
  { timeout: 30_000 },
  async (t) => {
    const started = await start(t);
    // 自宅を登録し、遠隔の端末の一致する報告を入れる（HTTP。報告の時刻は T0）。
    assert.equal((await register(started)).status, 200);
    assert.equal(
      (await report(started, started.remote.token, HOME)).status,
      200,
    );
    // DB への失効の書込み（home.revoke_scopes）を数える store。他の命令はそのまま渡す。
    const revokes: string[] = [];
    const counting = new Proxy(started.store, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        const method = value as (
          this: DbWorkerClient,
          ...args: unknown[]
        ) => unknown;
        if (property !== 'home') return method.bind(target);
        return (op: { readonly kind: string; readonly device_id?: string }) => {
          if (op.kind === 'home.revoke_scopes')
            revokes.push(String(op.device_id));
          return method.call(target, op);
        };
      },
    });
    const path = { direct: true };
    const clock = { now: T0 };
    const gate = createHomeNetworkGate({
      store: counting,
      key: HomeNetworkKey.fromDataKey(DATA_KEY),
      tailscale: createTailscaleStatusSource({
        runner: createMockCommandRunner(() => ({
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { TailscaleIPs: ['100.64.0.1'] },
            Peer: {
              'nodekey:synthetic': {
                TailscaleIPs: ['127.0.0.1'],
                ...(path.direct ? DIRECT : { CurAddr: '', Relay: 'tok' }),
              },
            },
          }),
        })),
        commands: ['tailscale'],
        ttlMs: 0,
      }),
      sameMachine: () => false,
      now: () => clock.now,
    });
    const denied: string[] = [];
    gate.onDenied((deviceId) => denied.push(deviceId));
    const check = (device: TestDevice) =>
      Promise.resolve(
        gate.homeNetwork({
          operationId: 'getBootstrap',
          device: device.device,
          remoteAddress: '127.0.0.1',
          params: {},
          body: null,
        }),
      );
    const issue = async (device: TestDevice) => {
      const id = randomUUID();
      const issued = await started.store.device({
        kind: 'scope.issue',
        command_scope_id: id,
        device_id: device.device.device_id,
        core_instance_id: CORE_INSTANCE,
        issued_at: clock.now,
        expires_at: clock.now + 3_600_000,
      });
      assert(issued.ok);
      return id;
    };
    const remote = started.remote;

    assert.equal(await check(remote), true);
    const first = await issue(remote);
    // DERP に変わった（不成立）。続けて 5 回拒否しても、失効の書込みは 1 回だけ。WSS を閉じる通知は毎回。
    path.direct = false;
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await check(remote), false, `denial ${i + 1}`);
      clock.now += 1_000;
    }
    assert.deepEqual(revokes, [remote.device.device_id]);
    assert.equal(denied.length, 5);
    assert.equal(await scopeRevoked(started, first), true);

    // 自宅判定が成り立った後に発行した接続範囲は、次の不成立で失効させる。
    path.direct = true;
    assert.equal(await check(remote), true);
    const second = await issue(remote);
    path.direct = false;
    assert.equal(await check(remote), false);
    assert.equal(revokes.length, 2);
    assert.equal(await scopeRevoked(started, second), true);

    // 間引く間隔（手書きの値 60 秒）を過ぎたら、もう一度書く。
    clock.now += 59_999;
    assert.equal(await check(remote), false);
    assert.equal(revokes.length, 2);
    clock.now += 1;
    assert.equal(await check(remote), false);
    assert.equal(revokes.length, 3);
    // 時計が戻ったときは書く（安全側）。
    clock.now -= 10_000;
    assert.equal(await check(remote), false);
    assert.equal(revokes.length, 4);
    // 別の端末は別に数える。
    assert.equal(await check(started.hub), false);
    assert.deepEqual(revokes.slice(4), [started.hub.device.device_id]);
  },
);
