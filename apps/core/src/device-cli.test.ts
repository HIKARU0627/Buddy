// 端末の一覧と失効の CLI（buddy-core device list | revoke）の試験（ADR 0021 の追記、本人の判断 2026-10-21）。
// 中枢の画面が使えないときの保守の手段（1 台目の復旧）。Core は同じプロセスで起動し（端末の接続の数を確かめるため）、
// CLI はビルド済みの cli.js を子プロセスで動かしてローカルの制御チャネルへ頼む。鍵は模擬、待ち受けは 127.0.0.1。
// 期待値（終了コード・理由・出力の項目）は手で書いた値。コード・秘密・トークンは出力のアサーションのメッセージに入れない。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMockKeyStore, createMockTlsKeyStore } from '@buddy/platform';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';
import {
  onCleanup,
  pinnedCheck,
  pinnedRequest,
  tempDir,
  withTimeout,
} from './api-test-support.js';
import type { PinnedTarget } from './api-test-support.js';
import { startCore } from './core.js';
import type { CoreHandle } from './core.js';
import {
  claimPairing,
  containsAny,
  createClaimSecret,
  fetchPeerCertificate,
  pickupToken,
  requireFingerprint,
} from './pairing-test-support.js';
import { TLS_CERTIFICATE_FILE } from './tls-identity.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

function runCli(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const lastJson = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<
    string,
    unknown
  >;

// 一覧の 1 台分に出す項目（手で書いた一覧）。トークン・その hash・証明書の指紋・プラットフォームは出さない。
const DEVICE_KEYS = [
  'device_id',
  'device_name',
  'hub_local',
  'registered_at',
  'last_seen_at',
  'revoked_at',
].sort();

interface Registered {
  readonly deviceId: string;
  readonly token: string;
  readonly secrets: readonly string[];
}

// 最初の端末を CLI（first-device start → 申請 → first-device approve → 受取り）で登録する。
async function registerFirstDevice(
  dataDir: string,
  target: PinnedTarget,
  name: string,
): Promise<Registered> {
  const started = await runCli([
    'first-device',
    'start',
    '--data-dir',
    dataDir,
  ]);
  assert.equal(started.code, 0);
  const session = lastJson(started.stdout);
  const code = String(session['pairing_code']);
  const peer = await fetchPeerCertificate(target.host, target.port);
  const pinned = requireFingerprint(
    target.host,
    target.port,
    peer,
    String(session['certificate_fingerprint']),
  );
  const secret = createClaimSecret();
  const claim = await claimPairing(pinned, code, secret, {
    name,
    platform: 'macos',
  });
  assert.equal(claim.status, 202);
  const approved = await runCli([
    'first-device',
    'approve',
    '--pairing-id',
    String(session['pairing_id']),
    '--data-dir',
    dataDir,
  ]);
  assert.equal(approved.code, 0);
  const picked = await pickupToken(
    pinned,
    String(claim.json?.['claim_id']),
    secret.secret,
  );
  assert.equal(picked.status, 200);
  const token = String(picked.json?.['device_token']);
  return {
    deviceId: String(picked.json?.['device_id']),
    token,
    secrets: [code, secret.secret, secret.hash, token],
  };
}

// 端末の WSS の購読を開き、Core が端末の接続として登録するまで待つ。
async function openEventStream(
  t: test.TestContext,
  handle: CoreHandle,
  target: PinnedTarget,
  device: Registered,
): Promise<{ readonly closed: Promise<{ code: number; reason: string }> }> {
  // 購読には今の接続範囲が要る（bootstrap で発行される）。
  const boot = await pinnedRequest(target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: { authorization: `Bearer ${device.token}` },
  });
  assert.equal(boot.status, 200);
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
  while (handle.deviceConnections.count(device.deviceId) === 0) {
    assert(Date.now() < deadline, 'stream registered');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { closed };
}

const keyStore = () =>
  createMockKeyStore({ stored: Buffer.alloc(32, 0x5d).toString('base64') });

test(
  'buddy-core device list and revoke: revoking the first device returns to zero devices and first-device works again',
  { timeout: 120_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-device-cli-'), 'data');
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
      },
    });
    onCleanup(t, () => handle.stop('test').catch(() => undefined));
    assert(handle.https !== null);
    const target: PinnedTarget = {
      host: handle.https.host,
      port: handle.https.port,
      certificatePem: await readFile(
        join(dataDir, TLS_CERTIFICATE_FILE),
        'utf8',
      ),
      fingerprint: handle.https.certificateFingerprint,
    };

    // 0 台の一覧。
    const empty = await runCli(['device', 'list', '--data-dir', dataDir]);
    assert.equal(empty.code, 0);
    const emptyBody = lastJson(empty.stdout);
    assert.equal(emptyBody['ok'], true);
    assert.deepEqual(emptyBody['devices'], []);

    const first = await registerFirstDevice(dataDir, target, '中枢の画面');
    const listed = await runCli(['device', 'list', '--data-dir', dataDir]);
    assert.equal(listed.code, 0);
    const devices = lastJson(listed.stdout)['devices'] as Record<
      string,
      unknown
    >[];
    assert.equal(devices.length, 1);
    const [entry] = devices;
    assert(entry !== undefined);
    assert.deepEqual(Object.keys(entry).sort(), DEVICE_KEYS);
    assert.equal(entry['device_id'], first.deviceId);
    assert.equal(entry['device_name'], '中枢の画面');
    assert.equal(entry['hub_local'], true);
    assert.match(String(entry['registered_at']), /^\d{4}-\d{2}-\d{2}T.*Z$/u);
    assert.equal(entry['revoked_at'], null);
    // トークン・申請用の秘密・その hash・証明書の指紋を出さない。
    assert.equal(
      containsAny(listed.stdout + listed.stderr, [
        ...first.secrets,
        target.fingerprint,
      ]),
      false,
    );

    // 失効: 既存の失効と同じ経路（接続範囲の無効化と WSS の切断）。
    const { closed } = await openEventStream(t, handle, target, first);
    const revoked = await runCli([
      'device',
      'revoke',
      '--device-id',
      first.deviceId,
      '--data-dir',
      dataDir,
    ]);
    assert.equal(revoked.code, 0);
    const revokedBody = lastJson(revoked.stdout);
    assert.equal(revokedBody['ok'], true);
    const revokedDevice = revokedBody['device'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(revokedDevice).sort(), DEVICE_KEYS);
    assert.equal(revokedDevice['device_id'], first.deviceId);
    const revokedAt = revokedDevice['revoked_at'];
    assert.equal(typeof revokedAt, 'string');
    assert.deepEqual(await withTimeout(closed, 10_000, 'stream closed'), {
      code: 4401,
      reason: 'device_revoked',
    });
    assert.equal(handle.deviceConnections.count(first.deviceId), 0);
    const rejected = await pinnedRequest(target, {
      method: 'GET',
      path: '/v1/bootstrap',
      headers: { authorization: `Bearer ${first.token}` },
    });
    assert.equal(rejected.status, 401);
    // もう一度失効しても時刻は変わらない。
    const again = await runCli([
      'device',
      'revoke',
      '--device-id',
      first.deviceId,
      '--data-dir',
      dataDir,
    ]);
    assert.equal(again.code, 0);
    assert.equal(
      (lastJson(again.stdout)['device'] as Record<string, unknown>)[
        'revoked_at'
      ],
      revokedAt,
    );

    // 有効な端末が 0 台に戻ったので、最初の端末の CLI からやり直せる。
    const second = await registerFirstDevice(dataDir, target, '新しい端末');
    const both = lastJson(
      (await runCli(['device', 'list', '--data-dir', dataDir])).stdout,
    )['devices'] as Record<string, unknown>[];
    assert.deepEqual(
      both.map((device) => [
        device['device_id'],
        device['revoked_at'] === null,
      ]),
      [
        [first.deviceId, false],
        [second.deviceId, true],
      ],
    );
    const boot = await pinnedRequest(target, {
      method: 'GET',
      path: '/v1/bootstrap',
      headers: { authorization: `Bearer ${second.token}` },
    });
    assert.equal(boot.status, 200);
    // 有効な端末があるので、最初の端末の CLI は拒否する（承認の機能は足していない）。
    assert.equal(
      (await runCli(['first-device', 'start', '--data-dir', dataDir])).code,
      7,
    );

    // 使い方の誤り・存在しない端末。
    const unknown = await runCli([
      'device',
      'revoke',
      '--device-id',
      randomUUID(),
      '--data-dir',
      dataDir,
    ]);
    assert.equal(unknown.code, 8);
    assert.deepEqual(lastJson(unknown.stdout), {
      ok: false,
      error: 'refused',
      reason: 'device_not_found',
    });
    for (const args of [
      ['device', 'revoke', '--data-dir', dataDir],
      ['device', 'list', '--device-id', first.deviceId, '--data-dir', dataDir],
      ['device', 'approve', '--data-dir', dataDir],
      ['device', '--data-dir', dataDir],
      ['status', '--device-id', first.deviceId, '--data-dir', dataDir],
    ])
      assert.equal((await runCli(args)).code, 2, args.join(' '));
    // 形式の違う ID は制御チャネルが拒否する（使い方の誤り）。
    assert.equal(
      (
        await runCli([
          'device',
          'revoke',
          '--device-id',
          'not-a-uuid',
          '--data-dir',
          dataDir,
        ])
      ).code,
      2,
    );

    // Core のログにトークン・秘密を出さない。失効は理由と端末 ID だけ。
    assert.equal(
      containsAny(logs.join('\n'), [...first.secrets, ...second.secrets]),
      false,
    );
    assert(logs.some((line) => line.includes(first.deviceId)));
    await handle.stop('test');
    // 動いている Core がなければ終了コード 3。
    assert.equal(
      (await runCli(['device', 'list', '--data-dir', dataDir])).code,
      3,
    );
  },
);

test(
  'device list works without HTTPS (no devices) because it reads the store, not the HTTPS server',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-device-nohttps-'), 'data');
    const handle = await startCore({
      dataDir,
      keyStore: keyStore(),
      shutdownGraceMs: 200,
      probeTimeoutMs: 300,
    });
    onCleanup(t, () => handle.stop('test').catch(() => undefined));
    const listed = await runCli(['device', 'list', '--data-dir', dataDir]);
    assert.equal(listed.code, 0);
    assert.deepEqual(lastJson(listed.stdout)['devices'], []);
    const unknown = await runCli([
      'device',
      'revoke',
      '--device-id',
      randomUUID(),
      '--data-dir',
      dataDir,
    ]);
    assert.equal(unknown.code, 8);
    assert.equal(lastJson(unknown.stdout)['reason'], 'device_not_found');
  },
);
