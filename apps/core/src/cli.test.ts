import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { controlEndpoint } from './paths.js';
import { onCleanup } from './api-test-support.js';
import { startCli } from './cli-test-support.js';

// ビルド済みの dist/cli.js を子プロセスで動かすヘッドレス起動の試験（Electron は使わない）。
// Windows では子プロセスへの SIGTERM が即時終了になるため、停止は制御チャネルの stop で行う。
// 終了コード・理由コードの期待値は手書き。

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const ID = '7d4e2a10-5b6c-4d8e-9f01-a2b3c4d5e6f7';
const TIMEOUT_MS = 15_000;

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
type Json = Record<string, unknown>;

async function tempDataDir(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-cli-'));
  onCleanup(t, () =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return join(base, 'data');
}

function run(args: readonly string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout
      .setEncoding('utf8')
      .on('data', (text: string) => (stdout += text));
    child.stderr
      .setEncoding('utf8')
      .on('data', (text: string) => (stderr += text));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const lastJson = (text: string): Json => {
  const lines = text.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] as string) as Json;
};

// running は全ての待受けが完了した後の CLI の通知。上限は各試験の signal だけ。
const startBackground = (t: test.TestContext, dataDir: string) =>
  startCli(t, ['--mock-key-protection', '--data-dir', dataDir]);

test(
  'headless start, duplicate refusal, client exit, stop, and restart keep the generation',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = await tempDataDir(t);
    const first = await startBackground(t, dataDir);
    assert.equal(first.running['state'], 'running');
    assert.equal(first.running['pid'], first.child.pid);
    const instance = first.running['core_instance_id'];
    const generation = first.running['store_generation'];
    assert.match(String(instance), /^[0-9a-f-]{36}$/u);
    assert.match(String(generation), /^[0-9a-f-]{36}$/u);

    const status = await run(['status', '--data-dir', dataDir]);
    assert.equal(status.code, 0);
    const body = lastJson(status.stdout);
    assert.equal(body['ok'], true);
    assert.equal(body['state'], 'running');
    assert.equal(body['core_instance_id'], instance);
    assert.equal(body['store_generation'], generation);

    // 同じデータディレクトリの 2 つ目は拒否され、動いている Core のロックは変わらない。
    const lockBefore = await readFile(join(dataDir, 'core.lock'), 'utf8');
    const second = await run([
      'start',
      '--mock-key-protection',
      '--data-dir',
      dataDir,
    ]);
    assert.equal(second.code, 4);
    assert.deepEqual(lastJson(second.stdout), {
      event: 'refused',
      code: 'already_running',
      reasons: ['already_running'],
    });
    assert.equal(
      await readFile(join(dataDir, 'core.lock'), 'utf8'),
      lockBefore,
    );

    // 模擬クライアント: 別プロセスが接続して途中で終了しても Core の状態は変わらない。
    // 接続先の場所だけを実装から求める（期待値には使わない）。
    const endpoint = controlEndpoint(await realpath(dataDir), process.platform);
    const abrupt = spawnSync(
      process.execPath,
      [
        '-e',
        `const net = require('node:net');
       const s = net.connect({ path: process.argv[1] }, () => {
         s.write('{"op":"status","request_id":"${ID}"');
         process.exit(0);
       });
       s.on('error', () => process.exit(2));`,
        endpoint,
      ],
      { timeout: TIMEOUT_MS },
    );
    assert.equal(abrupt.status, 0);
    const afterClients = lastJson(
      (await run(['status', '--data-dir', dataDir])).stdout,
    );
    assert.equal(afterClients['state'], 'running');
    assert.equal(afterClients['core_instance_id'], instance);
    assert.equal(afterClients['store_generation'], generation);

    const stop = await run(['stop', '--data-dir', dataDir]);
    assert.equal(stop.code, 0);
    assert.deepEqual(lastJson(stop.stdout), {
      ok: true,
      state: 'stopped',
      core_instance_id: instance,
    });
    const exited = await first.exited;
    assert.equal(exited.code, 0);
    assert.deepEqual(lastJson(exited.stdout), {
      event: 'stopped',
      ok: true,
      core_instance_id: instance,
    });
    // ソケット・ロックは消え、DB と時計の状態ファイル（ADR 0058）だけが残る。
    assert.deepEqual((await readdir(dataDir)).sort(), [
      'buddy.sqlite',
      'clock-state.json',
    ]);

    const notRunning = await run(['status', '--data-dir', dataDir]);
    assert.equal(notRunning.code, 3);
    assert.deepEqual(lastJson(notRunning.stdout), {
      ok: false,
      state: 'not_running',
    });
    assert.equal((await run(['stop', '--data-dir', dataDir])).code, 3);

    // 再起動: store_generation は同じ、core_instance_id は新しい。
    const restarted = await startBackground(t, dataDir);
    assert.equal(restarted.running['store_generation'], generation);
    assert.notEqual(restarted.running['core_instance_id'], instance);
    assert.equal((await run(['stop', '--data-dir', dataDir])).code, 0);
    assert.equal((await restarted.exited).code, 0);
  },
);

test(
  'SIGTERM stops gracefully and releases socket and lock',
  { skip: process.platform === 'win32', timeout: 30_000 },
  async (t) => {
    const dataDir = await tempDataDir(t);
    const core = await startBackground(t, dataDir);
    core.child.kill('SIGTERM');
    const exited = await core.exited;
    assert.equal(exited.code, 0);
    assert.match(exited.stderr, /SIGTERM/u);
    assert.deepEqual((await readdir(dataDir)).sort(), [
      'buddy.sqlite',
      'clock-state.json',
    ]);
  },
);

test(
  'start is refused when preflight fails or key protection is not available',
  { timeout: 30_000 },
  async (t) => {
    const dataDir = await tempDataDir(t);
    const unavailable = await run([
      'start',
      '--mock-key-protection-unavailable',
      '--data-dir',
      dataDir,
    ]);
    assert.equal(unavailable.code, 5);
    assert.deepEqual(lastJson(unavailable.stdout), {
      event: 'refused',
      code: 'preflight_failed',
      reasons: ['key_protection_unavailable:mock_unavailable'],
    });
    // 模擬の指定がなければ実行中の OS の鍵保護を確かめる。Linux・Windows の中枢は初期版の対象外なので起動しない。
    // macOS では実機のキーチェーンを確かめることになるため、この試験では実行しない。
    if (process.platform !== 'darwin') {
      const unsupported = await run(['start', '--data-dir', dataDir]);
      assert.equal(unsupported.code, 5);
      const [reason = ''] = lastJson(unsupported.stdout)['reasons'] as string[];
      assert.match(
        reason,
        /^key_protection_unavailable:(linux|windows)_core_not_supported_in_initial_release$/u,
      );
    }
    await assert.rejects(readdir(dataDir), { code: 'ENOENT' });
  },
);

test(
  'stale and unconfirmed locks from the CLI',
  { timeout: 30_000 },
  async (t) => {
    const dataDir = await tempDataDir(t);
    const core = await startBackground(t, dataDir);
    const generation = core.running['store_generation'];
    assert.equal((await run(['stop', '--data-dir', dataDir])).code, 0);
    await core.exited;

    // 生きている pid（この試験のプロセス）で応答がないロックは、終了を確認できないので拒否する。
    const live = {
      pid: process.pid,
      core_instance_id: ID,
      started_at: '2026-10-20T00:00:00.000Z',
    };
    await writeFile(join(dataDir, 'core.lock'), `${JSON.stringify(live)}\n`);
    const refused = await run([
      'start',
      '--mock-key-protection',
      '--data-dir',
      dataDir,
    ]);
    assert.equal(refused.code, 4);
    assert.equal(
      lastJson(refused.stdout)['code'],
      'previous_owner_unconfirmed',
    );

    // 終了済みの pid のロックは古いものとして片付け、起動できる。
    const dead = spawnSync(process.execPath, ['-e', ''], {
      stdio: 'ignore',
    }).pid;
    const stale = { ...live, pid: dead };
    await writeFile(join(dataDir, 'core.lock'), `${JSON.stringify(stale)}\n`);
    const recovered = await startBackground(t, dataDir);
    assert.equal(recovered.running['store_generation'], generation);
    assert.equal((await run(['stop', '--data-dir', dataDir])).code, 0);
    assert.equal((await recovered.exited).code, 0);
  },
);

test('usage errors exit with code 2', async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['restart'])).code, 2);
  assert.equal((await run(['status', '--unknown'])).code, 2);
  assert.equal((await run(['status', '--mock-key-protection'])).code, 2);
});
