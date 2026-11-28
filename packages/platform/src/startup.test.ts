// OS 別の起動アダプターの選択（macOS・Windows）と、Linux などの未対応の明示（ADR 0013・0203）。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoreLaunchSpec } from './supervisor.js';
import { createMockCommandRunner } from './runner.js';
import { createStartupSupervisor } from './startup.js';
import {
  corePlatformOf,
  createUnsupportedStartupSupervisor,
} from './supervisor.js';

const launch: CoreLaunchSpec = {
  nodePath: '/opt/buddy-test/bin/node',
  coreCliPath: '/opt/buddy-test/core/dist/cli.js',
  dataDir: '/var/buddy-test/data',
};

test('Node の platform 名を中枢の OS 区分へ対応させる', () => {
  assert.equal(corePlatformOf('darwin'), 'macos');
  assert.equal(corePlatformOf('win32'), 'windows');
  assert.equal(corePlatformOf('linux'), 'linux');
  assert.equal(corePlatformOf('freebsd'), 'other');
  assert.equal(corePlatformOf(''), 'other');
});

test('Linux などは例外ではなく未対応の結果を返し、コマンドを実行しない', async () => {
  const runner = createMockCommandRunner(() => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));
  for (const [nodePlatform, platform] of [
    ['linux', 'linux'],
    ['freebsd', 'other'],
  ] as const) {
    const supervisor = createStartupSupervisor({
      nodePlatform,
      runner,
      homeDir: '/home/synthetic',
      uid: undefined,
    });
    const unsupported = {
      status: 'unsupported',
      platform,
      reason: 'core_autostart_supports_macos_and_windows_only',
    };
    assert.equal(supervisor.platform, platform);
    assert.deepEqual(
      await supervisor.register({ enabled: true, loadNow: true, launch }),
      unsupported,
    );
    assert.deepEqual(
      await supervisor.unregister({ unloadNow: true }),
      unsupported,
    );
    assert.deepEqual(await supervisor.status(), unsupported);
  }
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(await createUnsupportedStartupSupervisor('linux').status(), {
    status: 'unsupported',
    platform: 'linux',
    reason: 'core_autostart_supports_macos_and_windows_only',
  });
});

test('macOS は LaunchAgent のアダプターを選び、uid がなければ作らない', async () => {
  const runner = createMockCommandRunner(() => ({
    exitCode: 113,
    stdout: '',
    stderr: '',
  }));
  const supervisor = createStartupSupervisor({
    nodePlatform: 'darwin',
    runner,
    homeDir: '/Users/synthetic',
    uid: 501,
  });
  assert.equal(supervisor.platform, 'macos');
  // 有効にしていなければ、ホームへ何も書かない。
  assert.deepEqual(
    await supervisor.register({ enabled: false, loadNow: true, launch }),
    { status: 'not_enabled' },
  );
  assert.deepEqual(runner.calls, []);
  assert.throws(
    () =>
      createStartupSupervisor({
        nodePlatform: 'darwin',
        runner,
        homeDir: '/Users/synthetic',
        uid: undefined,
      }),
    TypeError,
  );
});

test('Windows はログオン時のタスクのアダプターを選び、有効にしていなければ何も実行しない', async () => {
  const runner = createMockCommandRunner(() => ({
    exitCode: 0,
    stdout: '{"found":false}',
    stderr: '',
  }));
  const supervisor = createStartupSupervisor({
    nodePlatform: 'win32',
    runner,
    homeDir: 'C:\\Users\\synthetic',
    uid: undefined,
    systemRoot: 'C:\\Windows',
  });
  assert.equal(supervisor.platform, 'windows');
  assert.deepEqual(
    await supervisor.register({ enabled: false, loadNow: true, launch }),
    { status: 'not_enabled' },
  );
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(await supervisor.status(), {
    status: 'ok',
    platform: 'windows',
    definitionPath: '\\BuddyCore',
    installed: false,
    load: 'not_loaded',
  });
});
