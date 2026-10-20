import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMockKeyStore } from '@buddy/platform';
import { CoreStartError, startCore } from './core.js';
import type { CoreHandle } from './core.js';

// 同じプロセス内で startCore を動かし、排他・制御チャネル・起動前の検査を確かめる。
// 期待値（理由コード・応答の形）は手書き。鍵は模擬の KeyStore（実機のキーチェーンに触れない）。

const ID = '0b6f7f1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const POSIX = process.platform !== 'win32';
// 合成の鍵（32 バイト、値に意味はない）。再起動の試験で同じ鍵になるよう固定する。
const keyStore = () =>
  createMockKeyStore({ stored: Buffer.alloc(32, 0x5c).toString('base64') });
// 停止の後に残るのは DB（buddy.sqlite。閉じると -wal・-shm は消える）だけ。
const afterStop = ['buddy.sqlite'];

async function tempDataDir(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-core-'));
  t.after(() =>
    rm(base, { recursive: true, force: true, maxRetries: 5 }).catch(
      () => undefined,
    ),
  );
  return join(base, 'data');
}

async function started(
  t: test.TestContext,
  dataDir: string,
): Promise<CoreHandle> {
  const handle = await startCore({
    dataDir,
    keyStore: keyStore(),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
  });
  t.after(async () => {
    await handle.stop('test').catch(() => undefined);
  });
  return handle;
}

// 生の接続で 1 回送り、閉じられるまでに受け取った内容を返す。
function rawExchange(
  endpoint: string,
  payload: Uint8Array | string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ path: endpoint });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, 5000);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

const exitedPid = () => {
  const result = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(typeof result.pid, 'number');
  return result.pid as number;
};

test('preflight reasons refuse startup before touching the data directory', async (t) => {
  const dataDir = await tempDataDir(t);
  await assert.rejects(
    startCore({
      dataDir,
      keyStore: keyStore(),
      preflight: [() => ['key_protection_unavailable']],
    }),
    (error: unknown) =>
      error instanceof CoreStartError &&
      error.code === 'preflight_failed' &&
      error.reasons.join() === 'key_protection_unavailable',
  );
  await assert.rejects(stat(dataDir), { code: 'ENOENT' });
});

test('the control channel rejects malformed requests and keeps serving', async (t) => {
  const dataDir = await tempDataDir(t);
  const core = await started(t, dataDir);
  const invalid = (reason: string) =>
    `${JSON.stringify({ ok: false, error: 'invalid_request', reason })}\n`;
  const cases: ReadonlyArray<[string | Uint8Array, string]> = [
    [`{"op":"restart","request_id":"${ID}"}\n`, invalid('unknown_op')],
    [
      `{"op":"status","request_id":"${ID}","extra":true}\n`,
      invalid('unknown_field'),
    ],
    [
      `{"op":"status","op":"stop","request_id":"${ID}"}\n`,
      invalid('duplicate_key'),
    ],
    ['{"op":"status"\n', invalid('invalid_json')],
    ['{"op":"status","request_id":7}\n', invalid('invalid_type')],
    // 改行が来る前に上限を超えた時点で拒否する。
    ['x'.repeat(5000), invalid('too_large')],
    [`${'x'.repeat(4097)}\n`, invalid('too_large')],
    [new Uint8Array([0xc3, 0x28, 0x0a]), invalid('invalid_utf8')],
  ];
  for (const [payload, expected] of cases)
    assert.equal(await rawExchange(core.endpoint, payload), expected);
  // 要求を送らずに切った接続も Core に影響しない。
  assert.equal(await rawExchange(core.endpoint, ''), '');
  const reply = JSON.parse(
    await rawExchange(core.endpoint, `{"op":"status","request_id":"${ID}"}\n`),
  ) as Record<string, unknown>;
  assert.equal(reply['ok'], true);
  assert.equal(reply['request_id'], ID);
  assert.equal(reply['state'], 'running');
  assert.equal(reply['core_instance_id'], core.coreInstanceId);
  assert.equal(reply['store_generation'], core.storeGeneration);
  assert.equal(reply['pid'], process.pid);
  assert.deepEqual(Object.keys(reply).sort(), [
    'core_instance_id',
    'ok',
    'pid',
    'request_id',
    'started_at',
    'state',
    'store_generation',
    'uptime_ms',
  ]);
  assert.equal(core.state, 'running');
});

test('stop over the control channel answers first, then releases socket and lock', async (t) => {
  const dataDir = await tempDataDir(t);
  const core = await started(t, dataDir);
  const reply = JSON.parse(
    await rawExchange(core.endpoint, `{"op":"stop","request_id":"${ID}"}\n`),
  ) as Record<string, unknown>;
  assert.equal(reply['ok'], true);
  assert.equal(reply['state'], 'stopping');
  await core.closed;
  assert.equal(core.state, 'stopped');
  assert.equal(core.store.state, 'closed');
  assert.deepEqual((await readdir(core.dataDir)).sort(), afterStop);
});

test(
  'data directory and files are private to the owner on POSIX',
  { skip: !POSIX },
  async (t) => {
    const dataDir = await tempDataDir(t);
    const core = await started(t, dataDir);
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    assert.equal(await mode(core.dataDir), 0o700);
    assert.equal(await mode(join(core.dataDir, 'core.lock')), 0o600);
    assert.equal(await mode(join(core.dataDir, 'buddy.sqlite')), 0o600);
    assert.equal(await mode(core.endpoint), 0o600);
  },
);

test('a stale lock from an exited pid is cleaned up and a new instance starts', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await started(t, dataDir);
  await first.stop('test');
  const deadPid = exitedPid();
  const stale = {
    pid: deadPid,
    core_instance_id: ID,
    started_at: '2026-10-20T00:00:00.000Z',
  };
  await writeFile(
    join(first.dataDir, 'core.lock'),
    `${JSON.stringify(stale)}\n`,
  );
  // 前回のソケットファイルが残っていても片付ける（POSIX）。
  if (POSIX) await writeFile(first.endpoint, '');
  const second = await started(t, dataDir);
  assert.notEqual(second.coreInstanceId, first.coreInstanceId);
  assert.equal(second.storeGeneration, first.storeGeneration);
  const lock = JSON.parse(
    await readFile(join(second.dataDir, 'core.lock'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(lock['core_instance_id'], second.coreInstanceId);
  assert.equal(lock['pid'], process.pid);
});

test('a live pid without a control response is refused as unconfirmed', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await started(t, dataDir);
  await first.stop('test');
  const holder = {
    pid: 424242,
    core_instance_id: ID,
    started_at: '2026-10-20T00:00:00.000Z',
  };
  const lockText = `${JSON.stringify(holder)}\n`;
  await writeFile(join(first.dataDir, 'core.lock'), lockText);
  const probed: number[] = [];
  await assert.rejects(
    startCore({
      dataDir,
      keyStore: keyStore(),
      probeTimeoutMs: 300,
      isPidAlive: (pid) => (probed.push(pid), true),
    }),
    (error: unknown) =>
      error instanceof CoreStartError &&
      error.code === 'previous_owner_unconfirmed',
  );
  assert.deepEqual(probed, [424242]);
  // 他者のロックには触れない。
  assert.equal(
    await readFile(join(first.dataDir, 'core.lock'), 'utf8'),
    lockText,
  );
});

test('an unreadable lock or state file refuses startup instead of regenerating', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await started(t, dataDir);
  await first.stop('test');
  await writeFile(join(first.dataDir, 'core.lock'), '{"pid":1,"pid":2}');
  await assert.rejects(
    startCore({
      dataDir,
      keyStore: keyStore(),
      probeTimeoutMs: 300,
      isPidAlive: () => false,
    }),
    (error: unknown) =>
      error instanceof CoreStartError && error.code === 'lock_unreadable',
  );
  await rm(join(first.dataDir, 'core.lock'));
  const stateText =
    '{"store_generation":"not-a-uuid","created_at":"2026-10-20T00:00:00Z"}';
  await writeFile(join(first.dataDir, 'core-state.json'), stateText);
  await assert.rejects(
    startCore({ dataDir, keyStore: keyStore(), probeTimeoutMs: 300 }),
    (error: unknown) =>
      error instanceof CoreStartError && error.code === 'state_file_invalid',
  );
  // 状態ファイルは書き換えず、DB も開かず、取ったロックは返している。
  assert.equal(
    await readFile(join(first.dataDir, 'core-state.json'), 'utf8'),
    stateText,
  );
  assert.deepEqual((await readdir(first.dataDir)).sort(), [
    'buddy.sqlite',
    'core-state.json',
  ]);
});
