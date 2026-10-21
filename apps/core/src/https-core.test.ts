// Core の起動に組み込んだ HTTPS の試験（ADR 0020）。同じプロセスの startCore と、ビルド済みの CLI。
// 鍵は模擬の KeyStore（実機のキーチェーンに触れない）。待ち受けは 127.0.0.1。期待値は手書き。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect as netConnect, createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMockKeyStore, createMockTlsKeyStore } from '@buddy/platform';
import type { MockTlsKeyStore } from '@buddy/platform';
import type { RequestEnvironment } from './api-environment.js';
import {
  insertDevice,
  onCleanup,
  pinnedRequest,
  tempDir,
} from './api-test-support.js';
import type { PinnedTarget } from './api-test-support.js';
import { startCore } from './core.js';
import type { CoreHandle, CoreHttpsOptions, CoreStartError } from './core.js';
import { keyProtectionCheck } from './preflight.js';
import { TLS_CERTIFICATE_FILE } from './tls-identity.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const keyStore = () =>
  createMockKeyStore({ stored: Buffer.alloc(32, 0x5c).toString('base64') });
const PASSING: RequestEnvironment = {
  homeNetwork: () => true,
  lockState: () => 'unlocked',
  hubLocal: () => true,
  audioOwner: () => 'self',
  revisionMatches: () => true,
  claimSecretMatches: () => true,
};

async function freePort(): Promise<number> {
  const server = netServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert(address !== null && typeof address === 'object');
  return address.port;
}

// 待ち受けていないか（接続が拒否されるか）。Windows では拒否の通知に 1〜2 秒かかるため、
// 時間切れ（5 秒）も「接続できなかった」として扱い、待ちを必ず終える。
function refusesConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, 5_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function startWithHttps(
  t: test.TestContext,
  dataDir: string,
  https: Partial<CoreHttpsOptions> & { readonly tlsKeyStore: MockTlsKeyStore },
): Promise<CoreHandle> {
  const handle = await startCore({
    dataDir,
    keyStore: keyStore(),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    https: { host: '127.0.0.1', port: 0, environment: PASSING, ...https },
  });
  onCleanup(t, () => handle.stop('test').catch(() => undefined));
  return handle;
}

function targetOf(handle: CoreHandle, certificatePem: string): PinnedTarget {
  assert(handle.https !== null);
  return {
    host: handle.https.host,
    port: handle.https.port,
    certificatePem,
    fingerprint: handle.https.certificateFingerprint,
  };
}

test(
  'after a hub restart the old command scope is rejected with 410 and the certificate is kept',
  { timeout: 30_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-https-core-'), 'data');
    const tlsKeyStore = createMockTlsKeyStore();
    const first = await startWithHttps(t, dataDir, { tlsKeyStore });
    assert(first.https !== null);
    assert.equal(first.https.certificateCreation, 'key_and_certificate');
    const pem = await readFile(join(dataDir, TLS_CERTIFICATE_FILE), 'utf8');
    // 試験側で求めた指紋（X509Certificate）と Core の出す指紋が同じ。
    assert.equal(
      first.https.certificateFingerprint,
      new X509Certificate(pem).fingerprint256.replace(/:/gu, '').toLowerCase(),
    );
    const { device, token } = await insertDevice(first.store);
    const target = targetOf(first, pem);
    const boot = await pinnedRequest(target, {
      method: 'GET',
      path: '/v1/bootstrap',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(boot.status, 200);
    assert.equal(boot.json?.['core_instance_id'], first.coreInstanceId);
    assert.equal(boot.json?.['device_id'], device.device_id);
    const oldScope = String(boot.json?.['command_scope_id']);
    await first.stop('restart');

    // 再起動: 同じ鍵（キーチェーン）と証明書なので指紋は変わらない。起動 ID は変わる。
    const second = await startWithHttps(t, dataDir, { tlsKeyStore });
    assert(second.https !== null);
    assert.equal(second.https.certificateCreation, 'existing');
    assert.equal(
      second.https.certificateFingerprint,
      first.https.certificateFingerprint,
    );
    assert.notEqual(second.coreInstanceId, first.coreInstanceId);
    assert.equal(tlsKeyStore.writes, 1);
    const target2 = targetOf(second, pem);
    const command = (path: string, body: Record<string, unknown>) =>
      pinnedRequest(target2, {
        method: 'POST',
        path,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ request_id: randomUUID(), ...body }),
      });
    // 再起動の前の接続範囲の命令は 410（古い命令を新しい依頼として受け付けない）。
    for (const [path, body] of [
      ['/v1/io/stop', { command_scope_id: oldScope, scope: 'global' }],
      ['/v1/sessions', { command_scope_id: oldScope, storage_mode: 'normal' }],
    ] as const) {
      const response = await command(path, body);
      assert.equal(response.status, 410, path);
      assert.equal(response.json?.['code'], 'expired_scope', path);
    }
    // 新しい bootstrap の接続範囲は検査を通る（経路は B03-04 なので 503 で閉じる）。
    const again = await pinnedRequest(target2, {
      method: 'GET',
      path: '/v1/bootstrap',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(again.status, 200);
    assert.equal(again.json?.['core_instance_id'], second.coreInstanceId);
    const fresh = await command('/v1/io/stop', {
      command_scope_id: again.json?.['command_scope_id'],
      scope: 'global',
    });
    assert.equal(fresh.status, 503);
    assert.equal(fresh.json?.['code'], 'dependency_unavailable');
    // 停止すると HTTPS も閉じる。
    const port = second.https.port;
    await second.stop('test');
    assert.equal(await refusesConnections(port), true);
  },
);

test(
  'HTTPS is not opened when key protection is unavailable',
  { timeout: 30_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-https-core-'), 'data');
    const port = await freePort();
    // TLS の秘密鍵を鍵保護から取得できない。
    const unavailable = createMockTlsKeyStore({ available: false });
    await assert.rejects(
      startCore({
        dataDir,
        keyStore: keyStore(),
        shutdownGraceMs: 200,
        https: { host: '127.0.0.1', port, tlsKeyStore: unavailable },
      }),
      (error: CoreStartError) =>
        error.code === 'tls_unavailable' &&
        error.reasons[0] === 'tls_key_unavailable:mock_unavailable',
    );
    assert.equal(await refusesConnections(port), true);
    // データ鍵の鍵保護（起動前の検査）が使えなければ、TLS の鍵にも触れずに拒否する。
    const untouched = createMockTlsKeyStore();
    await assert.rejects(
      startCore({
        dataDir,
        keyStore: keyStore(),
        preflight: [keyProtectionCheck('mock_unavailable')],
        https: { host: '127.0.0.1', port, tlsKeyStore: untouched },
      }),
      (error: CoreStartError) => error.code === 'preflight_failed',
    );
    assert.equal(untouched.writes, 0);
    assert.equal(await refusesConnections(port), true);
    // ロックを返しているので、鍵保護が使えれば同じデータディレクトリで起動できる。
    const handle = await startWithHttps(t, dataDir, {
      port,
      tlsKeyStore: createMockTlsKeyStore(),
    });
    assert.equal(handle.https?.port, port);
    assert.equal(await refusesConnections(port), false);
  },
);

test(
  'invalid listening hosts and ports in use refuse the start and release the lock',
  { timeout: 30_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-https-core-'), 'data');
    for (const host of ['0.0.0.0', '::', 'localhost']) {
      await assert.rejects(
        startCore({
          dataDir,
          keyStore: keyStore(),
          https: { host, port: 0, tlsKeyStore: createMockTlsKeyStore() },
        }),
        (error: CoreStartError) => error.code === 'https_config_invalid',
        host,
      );
    }
    const busy = netServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    onCleanup(
      t,
      () => new Promise<void>((resolve) => busy.close(() => resolve())),
    );
    const address = busy.address();
    assert(address !== null && typeof address === 'object');
    await assert.rejects(
      startCore({
        dataDir,
        keyStore: keyStore(),
        https: {
          host: '127.0.0.1',
          port: address.port,
          tlsKeyStore: createMockTlsKeyStore(),
        },
      }),
      (error: CoreStartError) =>
        error.code === 'https_listen_failed' &&
        error.reasons[0] === 'https_listen_failed:eaddrinuse',
    );
    // 拒否の後もロックは残らない。
    const handle = await startWithHttps(t, dataDir, {
      tlsKeyStore: createMockTlsKeyStore(),
    });
    assert.equal(handle.state, 'running');
  },
);

function runCli(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    });
    let stdout = '';
    child.stdout
      .setEncoding('utf8')
      .on('data', (text: string) => (stdout += text));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test(
  'buddy-core start --https-host prints the fingerprint and serves HTTPS',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-https-cli-'), 'data');
    const child = spawn(
      process.execPath,
      [
        CLI,
        'start',
        '--mock-key-protection',
        '--https-host',
        '127.0.0.1',
        '--https-port',
        '0',
        '--data-dir',
        dataDir,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    onCleanup(t, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on('close', resolve),
    );
    const events: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('start timeout')),
        15_000,
      );
      createInterface({ input: child.stdout }).on('line', (line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        if (event['event'] === 'running') {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`exited ${code}`));
      });
    });
    const listening = events.find(
      (event) => event['event'] === 'https_listening',
    );
    assert(listening);
    assert.equal(listening['host'], '127.0.0.1');
    assert.equal(listening['certificate_creation'], 'key_and_certificate');
    const pem = await readFile(join(dataDir, TLS_CERTIFICATE_FILE), 'utf8');
    const fingerprint = new X509Certificate(pem).fingerprint256
      .replace(/:/gu, '')
      .toLowerCase();
    assert.equal(listening['certificate_fingerprint'], fingerprint);
    // https_listening は running より前に出る。
    assert(
      events.findIndex((event) => event['event'] === 'https_listening') <
        events.findIndex((event) => event['event'] === 'running'),
    );
    const response = await pinnedRequest(
      {
        host: '127.0.0.1',
        port: Number(listening['port']),
        certificatePem: pem,
        fingerprint,
      },
      { method: 'GET', path: '/v1/bootstrap' },
    );
    assert.equal(response.status, 401);
    assert.equal((await runCli(['stop', '--data-dir', dataDir])).code, 0);
    assert.equal(await exited, 0);
  },
);

test(
  'HTTPS options are usage errors outside start or without a host',
  { timeout: 30_000 },
  async () => {
    assert.equal((await runCli(['start', '--https-port', '1'])).code, 2);
    assert.equal(
      (
        await runCli([
          'start',
          '--https-host',
          '127.0.0.1',
          '--https-port',
          'x',
        ])
      ).code,
      2,
    );
    assert.equal(
      (
        await runCli([
          'start',
          '--https-host',
          '127.0.0.1',
          '--https-port',
          '70000',
        ])
      ).code,
      2,
    );
    assert.equal(
      (await runCli(['status', '--https-host', '127.0.0.1'])).code,
      2,
    );
  },
);
