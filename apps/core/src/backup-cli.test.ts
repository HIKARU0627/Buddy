// バックアップの CLI（buddy-core backup status | run | setup）と制御チャネルの使い方の試験（ADR 0055）。
// ビルド済みの cli.js を子プロセスで動かす。鍵は模擬（--mock-key-protection）で、実機のキーチェーンには触れない。
// backup setup の中身（復旧キーの作成・包み・記録）は backup.test.ts で同じ関数を直接確かめる（この試験では OS の
// キーチェーンを使う経路を呼ばない）。期待値（終了コード・理由コード）は手で書いた。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { onCleanup } from './api-test-support.js';
import { startCli } from './cli-test-support.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
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

async function tempDataDir(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-backup-cli-'));
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

test('backup の使い方の誤りは終了コード 2、Core が動いていなければ 3', async (t) => {
  const dataDir = await tempDataDir(t);
  assert.equal((await run(['backup'])).code, 2);
  assert.equal((await run(['backup', 'restore'])).code, 2);
  assert.equal((await run(['backup', 'run', 'extra'])).code, 2);
  assert.equal(
    (await run(['backup', 'status', '--device-id', 'x', '--data-dir', dataDir]))
      .code,
    2,
  );
  for (const action of ['status', 'run', 'setup']) {
    const result = await run(['backup', action, '--data-dir', dataDir]);
    assert.equal(result.code, 3, action);
    assert.deepEqual(lastJson(result.stdout), {
      ok: false,
      state: 'not_running',
    });
  }
});

test('動いている Core に対して、設定がなければ status は未設定を返し、run は理由つきで終了コード 10', async (t) => {
  const dataDir = await tempDataDir(t);
  const core = await startCli(t, [
    '--data-dir',
    dataDir,
    '--mock-key-protection',
  ]);
  const status = await run(['backup', 'status', '--data-dir', dataDir]);
  assert.equal(status.code, 0);
  const statusBody = lastJson(status.stdout);
  assert.equal(statusBody['ok'], true);
  const detail = statusBody['backup'] as Record<string, unknown>;
  assert.equal(detail['kind'], 'status');
  assert.equal(detail['configured'], false);
  assert.deepEqual(detail['config_reasons'], ['config_missing']);
  assert.equal(detail['recovery_key_state'], 'not_set_up');
  assert.equal(detail['keys_ready'], false);
  const attempt = await run(['backup', 'run', '--data-dir', dataDir]);
  assert.equal(attempt.code, 10);
  const ran = lastJson(attempt.stdout)['backup'] as Record<string, unknown>;
  assert.equal(ran['kind'], 'run');
  assert.equal(ran['ok'], false);
  assert.deepEqual(ran['reasons'], ['config_missing']);
  assert.match(attempt.stderr, /config_missing/u);
  const stopped = await run(['stop', '--data-dir', dataDir]);
  assert.equal(stopped.code, 0);
  assert.equal((await core.exited).code, 0);
});
