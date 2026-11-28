import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMockCommandRunner } from '@buddy/platform';
import { runAutostart, runAutostartLaunch } from './autostart.js';

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

test('autostart is unsupported for Linux hubs', async () => {
  const outcome = await runAutostart('enable', '/synthetic/data', {
    nodePlatform: 'linux',
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
    'core_autostart_supports_macos_and_windows_only',
  );
});

// Windows の中枢（ADR 0203）。模擬の runner で、実機の schtasks・whoami・PowerShell・powercfg は呼ばない。
const WINDOWS_DEPS = {
  nodePlatform: 'win32',
  homeDir: 'C:\\Users\\synthetic',
  uid: undefined,
  systemRoot: 'C:\\Windows',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  coreCliPath: 'C:\\buddy-test\\apps\\core\\dist\\cli.js',
};

function powercfgOutput(acHex: string): string {
  return [
    '      Minimum Possible Setting: 0x00000000',
    '      Maximum Possible Setting: 0xffffffff',
    '      Possible Settings increment: 0x00000001',
    '      Possible Settings units: Seconds',
    `    Current AC Power Setting Index: 0x${acHex}`,
    '    Current DC Power Setting Index: 0x00000384',
  ].join('\r\n');
}

test('Windows: status returns the logon task state and power warnings', async () => {
  const runner = createMockCommandRunner((command, args) => {
    if (command.endsWith('powershell.exe'))
      return {
        exitCode: 0,
        stdout: '{"found":true,"enabled":true,"state":"Ready"}',
        stderr: '',
      };
    if (command.endsWith('powercfg.exe'))
      return {
        exitCode: 0,
        stdout: powercfgOutput(
          args.includes('STANDBYIDLE') ? '00000708' : '00000000',
        ),
        stderr: '',
      };
    return { exitCode: 1, stdout: '', stderr: '' };
  });
  const outcome = await runAutostart('status', 'C:\\buddy-test\\data', {
    ...WINDOWS_DEPS,
    runner,
  });
  assert.deepEqual(outcome, {
    ok: true,
    output: {
      status: 'ok',
      platform: 'windows',
      definitionPath: '\\BuddyCore',
      installed: true,
      load: 'loaded',
      warnings: ['system_sleep_enabled'],
    },
  });
  // macOS の pmset・fdesetup は呼ばない。
  assert.ok(
    runner.calls.every((call) =>
      call.command.startsWith('C:\\Windows\\System32\\'),
    ),
  );
});

test('Windows: enable reports the failed step without touching files when the user SID is unreadable', async () => {
  const runner = createMockCommandRunner(() => ({
    exitCode: 1,
    stdout: '',
    stderr: 'synthetic',
  }));
  const outcome = await runAutostart('enable', 'C:\\buddy-test\\data', {
    ...WINDOWS_DEPS,
    runner,
  });
  assert.deepEqual(outcome, {
    ok: false,
    output: {
      status: 'failed',
      step: 'query_user',
      reasons: ['whoami_exit:1'],
    },
  });
  assert.deepEqual(
    runner.calls.map((call) => call.command),
    ['C:\\Windows\\System32\\whoami.exe'],
  );
});

test('Windows: disable deletes the logon task but does not stop a running Core', async () => {
  const runner = createMockCommandRunner((command) =>
    command.endsWith('powershell.exe')
      ? {
          exitCode: 0,
          stdout: '{"found":true,"enabled":true,"state":"Ready"}',
          stderr: '',
        }
      : { exitCode: 0, stdout: '', stderr: '' },
  );
  const outcome = await runAutostart('disable', 'C:\\buddy-test\\data', {
    ...WINDOWS_DEPS,
    runner,
  });
  assert.deepEqual(outcome, {
    ok: true,
    output: {
      status: 'unregistered',
      removedDefinition: true,
      bootedOut: false,
    },
  });
  assert.deepEqual(runner.calls.at(-1), {
    command: 'C:\\Windows\\System32\\schtasks.exe',
    args: ['/Delete', '/TN', '\\BuddyCore', '/F'],
  });
});

// 起動役（autostart launch）。spawn を差し替えて、渡す引数・切り離し・窓を出さない・ログの追記を確かめる。
class FakeChild extends EventEmitter {
  unrefCalled = false;
  unref() {
    this.unrefCalled = true;
  }
}

test('launch spawns a detached, hidden start with logs appended under the data directory', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'buddy-launch-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls: {
    command: string;
    args: readonly string[];
    options: SpawnOptions;
  }[] = [];
  const child = new FakeChild();
  const outcome = await runAutostartLaunch(dataDir, {
    nodePlatform: 'win32',
    nodePath: '/synthetic/bin/node',
    coreCliPath: '/synthetic/cli.js',
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      setImmediate(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    },
  });
  assert.deepEqual(outcome, { ok: true, output: { status: 'launched' } });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.command, '/synthetic/bin/node');
  assert.deepEqual(call?.args, [
    '/synthetic/cli.js',
    'start',
    '--data-dir',
    dataDir,
  ]);
  assert.equal(call?.options.detached, true);
  assert.equal(call?.options.windowsHide, true);
  assert.equal(call?.options.shell, false);
  const stdio = call?.options.stdio as unknown[];
  assert.equal(stdio[0], 'ignore');
  assert.equal(typeof stdio[1], 'number');
  assert.equal(typeof stdio[2], 'number');
  assert.equal(child.unrefCalled, true);
  assert.deepEqual((await readdir(join(dataDir, 'logs'))).sort(), [
    'core.err.log',
    'core.out.log',
  ]);
});

test('launch reports a spawn failure and is Windows only', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'buddy-launch-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const failing = await runAutostartLaunch(dataDir, {
    nodePlatform: 'win32',
    nodePath: '/synthetic/bin/node',
    coreCliPath: '/synthetic/cli.js',
    spawn: () => {
      const child = new FakeChild();
      setImmediate(() => child.emit('error', new Error('synthetic ENOENT')));
      return child as unknown as ChildProcess;
    },
  });
  assert.deepEqual(failing, {
    ok: false,
    output: { status: 'failed', step: 'spawn', reasons: ['spawn_failed'] },
  });
  const throwing = await runAutostartLaunch(dataDir, {
    nodePlatform: 'win32',
    nodePath: '/synthetic/bin/node',
    coreCliPath: '/synthetic/cli.js',
    spawn: () => {
      throw new TypeError('synthetic');
    },
  });
  assert.equal(throwing.ok, false);
  for (const nodePlatform of ['darwin', 'linux']) {
    let spawned = false;
    const outcome = await runAutostartLaunch(dataDir, {
      nodePlatform,
      nodePath: '/synthetic/bin/node',
      coreCliPath: '/synthetic/cli.js',
      spawn: () => {
        spawned = true;
        return new FakeChild() as unknown as ChildProcess;
      },
    });
    assert.deepEqual(outcome, {
      ok: false,
      output: {
        status: 'unsupported',
        reason: 'autostart_launch_windows_only',
      },
    });
    assert.equal(spawned, false);
  }
});

// 実際の spawn で、切り離した子の標準出力・標準エラーがログへ追記されることを確かめる（どの OS でも動く）。
test(
  'launch appends the real child output to the log files',
  { timeout: 20_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'buddy-launch-'));
    // Windows では子が終わるまでログのファイルを消せないので、少し待って消し直す。
    t.after(() =>
      rm(dataDir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
    );
    const script = join(dataDir, 'fake-cli.mjs');
    await writeFile(
      script,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n'); process.stderr.write('synthetic-err\\n');\n",
    );
    await mkdir(join(dataDir, 'logs'));
    await writeFile(join(dataDir, 'logs', 'core.out.log'), 'earlier\n');
    const outcome = await runAutostartLaunch(dataDir, {
      nodePlatform: 'win32',
      nodePath: process.execPath,
      coreCliPath: script,
    });
    assert.equal(outcome.ok, true);
    const deadline = Date.now() + 15_000;
    let out = '';
    let err = '';
    while (Date.now() < deadline) {
      out = await readFile(join(dataDir, 'logs', 'core.out.log'), 'utf8');
      err = await readFile(join(dataDir, 'logs', 'core.err.log'), 'utf8');
      if (out.includes(']') && err.includes('synthetic-err')) break;
      await delay(50);
    }
    assert.equal(
      out,
      `earlier\n${JSON.stringify(['start', '--data-dir', dataDir])}\n`,
    );
    assert.equal(err, 'synthetic-err\n');
  },
);
