import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMockCommandRunner } from '@buddy/platform';
import { runAutostart } from './autostart.js';

// 自動起動の設定を模擬の runner と一時ディレクトリで確かめる。実機の launchctl は実行しない。
const posixOnly = { skip: process.platform === 'win32' };

test(
  'enable writes the LaunchAgent without starting it now',
  posixOnly,
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'buddy-autostart-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const runner = createMockCommandRunner(() => ({
      exitCode: 113,
      stdout: '',
      stderr: '',
    }));
    const deps = {
      nodePlatform: 'darwin',
      runner,
      homeDir: home,
      uid: 501,
      nodePath: '/synthetic/bin/node',
      coreCliPath: '/synthetic/buddy/apps/core/dist/cli.js',
    };
    const enabled = await runAutostart('enable', join(home, 'data'), deps);
    assert.equal(enabled.ok, true);
    assert.equal(enabled.output['status'], 'registered');
    assert.equal(enabled.output['loaded'], false);
    const plist = await readFile(
      join(home, 'Library', 'LaunchAgents', 'dev.buddy.core.plist'),
      'utf8',
    );
    assert.match(
      plist,
      /<string>\/synthetic\/buddy\/apps\/core\/dist\/cli\.js<\/string>/u,
    );
    assert.match(plist, /<string>start<\/string>/u);
    // 即時の起動（launchctl bootstrap）はしない。
    assert(!runner.calls.some((call) => call.args[0] === 'bootstrap'));
    const disabled = await runAutostart('disable', join(home, 'data'), deps);
    assert.equal(disabled.ok, true);
    assert.equal(disabled.output['status'], 'unregistered');
    assert(!runner.calls.some((call) => call.args[0] === 'bootout'));
  },
);

test('autostart is unsupported for Linux and Windows hubs in the initial release', async () => {
  for (const nodePlatform of ['linux', 'win32']) {
    const outcome = await runAutostart('enable', '/synthetic/data', {
      nodePlatform,
      runner: createMockCommandRunner(() => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      })),
      homeDir: '/synthetic/home',
      uid: undefined,
      nodePath: '/synthetic/bin/node',
      coreCliPath: '/synthetic/cli.js',
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.output['status'], 'unsupported');
    assert.equal(
      outcome.output['reason'],
      'initial_release_supports_macos_core_only',
    );
  }
});
