// Core の起動に組み込んだ自宅判定の試験（ADR 0022）。同じプロセスの startCore で、鍵は模擬の KeyStore、
// Tailscale は模擬の状態（実機の tailscale を呼ばない）。待ち受けは 127.0.0.1。期待値は手書き。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createMockKeyStore,
  createMockTailscaleStatusSource,
  createMockTlsKeyStore,
} from '@buddy/platform';
import type { TailscalePeerPath } from '@buddy/platform';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';
import type { RequestEnvironment } from './api-environment.js';
import {
  insertDevice,
  onCleanup,
  pinnedCheck,
  pinnedRequest,
  tempDir,
  withTimeout,
} from './api-test-support.js';
import type {
  ApiResponse,
  PinnedTarget,
  TestDevice,
} from './api-test-support.js';
import { startCore } from './core.js';
import type { CoreHandle, CoreHttpsOptions } from './core.js';
import { TLS_CERTIFICATE_FILE } from './tls-identity.js';

const keyStore = () =>
  createMockKeyStore({ stored: Buffer.alloc(32, 0x5c).toString('base64') });
// 自宅判定以外の文脈を満たす環境（自宅判定は Core の既定＝ B03-03 の判定を使う）。
const OTHERS: Partial<RequestEnvironment> = {
  lockState: () => 'unlocked',
  hubLocal: ({ device }) => device?.hub_local === true,
  audioOwner: () => 'self',
  revisionMatches: () => true,
  claimSecretMatches: () => true,
};
const HOME = {
  gateway_mac: '00:00:5e:00:53:01',
  subnet: '192.0.2.0/24',
  ssid: null,
};

async function startWith(
  t: test.TestContext,
  https: Partial<CoreHttpsOptions>,
): Promise<{ readonly handle: CoreHandle; readonly target: PinnedTarget }> {
  const dataDir = join(await tempDir(t, 'buddy-home-core-'), 'data');
  const logs: string[] = [];
  const handle = await startCore({
    dataDir,
    keyStore: keyStore(),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    log: (message) => logs.push(message),
    https: {
      host: '127.0.0.1',
      port: 0,
      tlsKeyStore: createMockTlsKeyStore(),
      environment: OTHERS,
      ...https,
    },
  });
  onCleanup(t, () => handle.stop('test').catch(() => undefined));
  assert(handle.https !== null);
  const certificatePem = await readFile(
    join(dataDir, TLS_CERTIFICATE_FILE),
    'utf8',
  );
  return {
    handle,
    target: {
      host: handle.https.host,
      port: handle.https.port,
      certificatePem,
      fingerprint: handle.https.certificateFingerprint,
    },
  };
}

const bootstrap = (target: PinnedTarget, token: string): Promise<ApiResponse> =>
  pinnedRequest(target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: { authorization: `Bearer ${token}` },
  });

test(
  'without a Tailscale source only the same-machine hub client passes the home check',
  { timeout: 30_000 },
  async (t) => {
    const { handle, target } = await startWith(t, {});
    assert.notEqual(handle.homeNetwork, null);
    const hub = await insertDevice(handle.store, { hubLocal: true });
    const remote = await insertDevice(handle.store);
    assert.equal((await bootstrap(target, hub.token)).status, 200);
    const denied = await bootstrap(target, remote.token);
    assert.equal(denied.status, 403);
    assert.equal(denied.json?.['code'], 'outside_home_network');
  },
);

test(
  'the Core wires registration, reports, the Tailscale state and the denial hook together',
  { timeout: 30_000 },
  async (t) => {
    let path: TailscalePeerPath = {
      kind: 'peer',
      cur_addr: '192.0.2.23:41641',
      relay: 'tok',
      peer_relay: '',
    };
    const tailscale = createMockTailscaleStatusSource(() => path);
    const { handle, target } = await startWith(t, { tailscale });
    const gate = handle.homeNetwork;
    assert(gate !== null);
    const denied: string[] = [];
    gate.onDenied((deviceId) => denied.push(deviceId));
    const hub = await insertDevice(handle.store, { hubLocal: true });
    const remote = await insertDevice(handle.store);
    const hubBoot = await bootstrap(target, hub.token);
    const registered = await pinnedRequest(target, {
      method: 'PUT',
      path: '/v1/home-network/registration',
      headers: {
        authorization: `Bearer ${hub.token}`,
        'content-type': 'application/json',
        'buddy-input-origin': 'screen',
      },
      body: JSON.stringify({
        request_id: randomUUID(),
        command_scope_id: String(hubBoot.json?.['command_scope_id']),
        ...HOME,
      }),
    });
    assert.equal(registered.status, 200);
    const reported = await pinnedRequest(target, {
      method: 'POST',
      path: '/v1/home-network/reports',
      headers: {
        authorization: `Bearer ${remote.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ request_id: randomUUID(), fingerprint: HOME }),
    });
    assert.equal(reported.json?.['allowed'], true);
    assert.equal((await bootstrap(target, remote.token)).status, 200);
    // 接続元のアドレスで Tailscale のピアを引いている。
    assert(tailscale.calls.includes('127.0.0.1'));
    path = { kind: 'peer', cur_addr: '', relay: 'tok', peer_relay: '' };
    const refused = await bootstrap(target, remote.token);
    assert.equal(refused.status, 403);
    assert.deepEqual(denied, [remote.device.device_id]);
  },
);

// 端末の WSS の購読を開き、Core が端末の接続として登録するまで待つ（B03-04 の配信）。
async function openStream(
  t: test.TestContext,
  handle: CoreHandle,
  target: PinnedTarget,
  device: TestDevice,
): Promise<{
  readonly socket: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
}> {
  const snapshot = await pinnedRequest(target, {
    method: 'GET',
    path: '/v1/snapshot',
    headers: { authorization: `Bearer ${device.token}` },
  });
  assert.equal(snapshot.status, 200);
  const cursor = String(snapshot.json?.['event_cursor']);
  const socket = new WebSocket(
    `wss://127.0.0.1:${target.port}/v1/events/stream?cursor=${encodeURIComponent(cursor)}`,
    {
      headers: { authorization: `Bearer ${device.token}` },
      ca: [target.certificatePem],
      checkServerIdentity: pinnedCheck(
        target.fingerprint,
      ) as unknown as ClientOptions['checkServerIdentity'],
      minVersion: 'TLSv1.3',
    },
  );
  onCleanup(t, () => socket.terminate());
  socket.on('error', () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString('utf8') }),
    );
  });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('close', () => reject(new Error('stream closed')));
    }),
    10_000,
    'stream open',
  );
  const deadline = Date.now() + 5_000;
  while (handle.deviceConnections.count(device.device.device_id) === 0) {
    assert(Date.now() < deadline, 'stream registered');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { socket, closed };
}

test(
  'a device that fails the home check has its event stream closed with 4403 while other streams stay open',
  { timeout: 60_000 },
  async (t) => {
    // 試験のクライアントはどれも 127.0.0.1 から接続するので、Tailscale の経路は全端末で同じ。
    // 端末ごとの違いは報告（指紋）で作り、後半は Tailscale の経路の変化（DERP）を ping ごとの判定で拾う。
    let path: TailscalePeerPath = {
      kind: 'peer',
      cur_addr: '192.0.2.23:41641',
      relay: 'tok',
      peer_relay: '',
    };
    const { handle, target } = await startWith(t, {
      tailscale: createMockTailscaleStatusSource(() => path),
      // DERP への変化を定期再検査で拾うための短縮。切断待ちの 10 秒以内で、pong の処理には余裕を持たせる。
      eventStream: { pingIntervalMs: 1_000 },
    });
    const hub = await insertDevice(handle.store, { hubLocal: true });
    const leaving = await insertDevice(handle.store, { name: '合成の端末 A' });
    const staying = await insertDevice(handle.store, { name: '合成の端末 B' });
    const hubBoot = await bootstrap(target, hub.token);
    const registered = await pinnedRequest(target, {
      method: 'PUT',
      path: '/v1/home-network/registration',
      headers: {
        authorization: `Bearer ${hub.token}`,
        'content-type': 'application/json',
        'buddy-input-origin': 'screen',
      },
      body: JSON.stringify({
        request_id: randomUUID(),
        command_scope_id: String(hubBoot.json?.['command_scope_id']),
        ...HOME,
      }),
    });
    assert.equal(registered.status, 200);
    const report = (device: TestDevice, fingerprint: object) =>
      pinnedRequest(target, {
        method: 'POST',
        path: '/v1/home-network/reports',
        headers: {
          authorization: `Bearer ${device.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ request_id: randomUUID(), fingerprint }),
      });
    for (const device of [leaving, staying]) {
      assert.equal((await report(device, HOME)).json?.['allowed'], true);
      assert.equal((await bootstrap(target, device.token)).status, 200);
    }
    const leavingStream = await openStream(t, handle, target, leaving);
    const stayingStream = await openStream(t, handle, target, staying);
    const hubStream = await openStream(t, handle, target, hub);

    // A が別のネットワーク（ゲートウェイの MAC が違う）を報告する。自宅判定で不成立になり、A の購読だけが閉じる。
    const moved = await report(leaving, {
      ...HOME,
      gateway_mac: '00:00:5e:00:53:02',
    });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.json?.['reasons'], ['gateway_mac_mismatch']);
    assert.deepEqual(
      await withTimeout(leavingStream.closed, 10_000, 'A stream closed'),
      { code: 4403, reason: 'outside_home_network' },
    );
    assert.equal(handle.deviceConnections.count(leaving.device.device_id), 0);
    assert.equal(stayingStream.socket.readyState, WebSocket.OPEN);
    assert.equal(handle.deviceConnections.count(staying.device.device_id), 1);
    // A は新しく購読も bootstrap もできない（自宅判定で 403）。
    const again = await bootstrap(target, leaving.token);
    assert.equal(again.status, 403);
    assert.equal(again.json?.['code'], 'outside_home_network');

    // Tailscale の経路が DERP に変わると、ping ごとの判定で B の購読も 4403 で閉じる。
    // 中枢と同じマシンの hub_local の端末は自宅判定を免除するので、購読は開いたまま。
    path = { kind: 'peer', cur_addr: '', relay: 'tok', peer_relay: '' };
    assert.deepEqual(
      await withTimeout(stayingStream.closed, 10_000, 'B stream closed'),
      { code: 4403, reason: 'outside_home_network' },
    );
    assert.equal(hubStream.socket.readyState, WebSocket.OPEN);
    assert.equal(handle.deviceConnections.count(hub.device.device_id), 1);
  },
);
