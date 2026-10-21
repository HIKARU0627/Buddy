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
import type { RequestEnvironment } from './api-environment.js';
import {
  insertDevice,
  onCleanup,
  pinnedRequest,
  tempDir,
} from './api-test-support.js';
import type { ApiResponse, PinnedTarget } from './api-test-support.js';
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
