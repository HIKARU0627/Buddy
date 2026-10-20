// 実機用 runner の試験。OS の設定を変えるコマンドは使わず、試験中の node 自身だけを実行する。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createMockCommandRunner, createNodeCommandRunner } from './runner.js';

test('終了コードと標準出力・標準エラーを返し、引数を shell で展開しない', async () => {
  const runner = createNodeCommandRunner();
  const result = await runner.run(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1]); process.stderr.write("e"); process.exit(3)',
    '$HOME; echo injected',
  ]);
  assert.deepEqual(result, {
    exitCode: 3,
    stdout: '$HOME; echo injected',
    stderr: 'e',
  });
  assert.deepEqual(await runner.run(process.execPath, ['-e', '']), {
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
});

test('起動できない・時間切れは例外ではなく exitCode: null を返す', async () => {
  const missing = await createNodeCommandRunner().run(
    join(tmpdir(), 'buddy-platform-missing-command'),
    [],
  );
  assert.equal(missing.exitCode, null);
  const slow = await createNodeCommandRunner({ timeoutMs: 100 }).run(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 10000)'],
  );
  assert.equal(slow.exitCode, null);
});

test('模擬の runner は実行せずに呼び出しを記録する', async () => {
  const runner = createMockCommandRunner((command, args) => ({
    exitCode: 0,
    stdout: `${command} ${args.join(' ')}`,
    stderr: '',
  }));
  assert.equal(runner.kind, 'mock');
  const args = ['print', 'gui/501/dev.buddy.core'];
  const result = await runner.run('/bin/launchctl', args);
  args.push('mutated');
  assert.equal(result.stdout, '/bin/launchctl print gui/501/dev.buddy.core');
  assert.deepEqual(runner.calls, [
    { command: '/bin/launchctl', args: ['print', 'gui/501/dev.buddy.core'] },
  ]);
});
