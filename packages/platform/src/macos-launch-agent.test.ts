// LaunchAgent の生成・登録・解除の試験。期待値は手で書き、実装の関数で作らない。
// 実機の launchctl は呼ばない（模擬の runner）。ホームとデータディレクトリは一時ディレクトリを注入する。
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createMacLaunchAgentSupervisor,
  launchAgentDefinitionReasons,
  renderLaunchAgentPlist,
} from './macos-launch-agent.js';
import type { CommandResult } from './runner.js';
import { createMockCommandRunner } from './runner.js';
import type { RegisterRequest, UnregisterRequest } from './supervisor.js';

const SYNTHETIC = {
  nodePath: '/opt/buddy-test/bin/node',
  coreCliPath: '/opt/buddy-test/core/dist/cli.js',
  dataDir: '/var/buddy-test/data',
};

test('plist は手書きの期待値と一致し、KeepAlive を含まない', () => {
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.buddy.core</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/buddy-test/bin/node</string>
    <string>/opt/buddy-test/core/dist/cli.js</string>
    <string>start</string>
    <string>--data-dir</string>
    <string>/var/buddy-test/data</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/buddy-test/data/logs/core.out.log</string>
  <key>StandardErrorPath</key>
  <string>/var/buddy-test/data/logs/core.err.log</string>
</dict>
</plist>
`;
  const plist = renderLaunchAgentPlist(SYNTHETIC);
  assert.equal(plist, expected);
  assert.ok(!plist.includes('KeepAlive'));
});

test('plist は与えた値と固定値だけを含み、実行環境のホームを含まない', () => {
  const plist = renderLaunchAgentPlist(SYNTHETIC);
  const home = homedir();
  if (home.length > 1) assert.ok(!plist.includes(home));
  const strings = [...plist.matchAll(/<string>([^<]*)<\/string>/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(strings, [
    'dev.buddy.core',
    '/opt/buddy-test/bin/node',
    '/opt/buddy-test/core/dist/cli.js',
    'start',
    '--data-dir',
    '/var/buddy-test/data',
    '/var/buddy-test/data/logs/core.out.log',
    '/var/buddy-test/data/logs/core.err.log',
  ]);
});

test('plist は XML の特殊文字をエスケープする', () => {
  const plist = renderLaunchAgentPlist({
    ...SYNTHETIC,
    dataDir: `/var/a&b <c> "d" 'e'`,
  });
  assert.ok(
    plist.includes(
      '<string>/var/a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos;</string>',
    ),
  );
  assert.ok(
    plist.includes(
      '<string>/var/a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos;/logs/core.out.log</string>',
    ),
  );
  assert.ok(!plist.includes('a&b'));
  assert.ok(!plist.includes('<c>'));
});

test('使えないパス・label は理由を返し、生成を拒否する', () => {
  const cases: [Record<string, string>, string[]][] = [
    [{ nodePath: 'bin/node' }, ['node_path_not_absolute']],
    [{ coreCliPath: '' }, ['core_cli_path_empty']],
    [{ dataDir: '/var/buddy/../etc' }, ['data_dir_not_normalized']],
    [{ dataDir: '/var/buddy/' }, ['data_dir_not_normalized']],
    [{ dataDir: '/var//buddy' }, ['data_dir_not_normalized']],
    [{ dataDir: '/var/bud\ndy' }, ['data_dir_invalid_character']],
    [{ dataDir: '/var/bud\u0000dy' }, ['data_dir_invalid_character']],
    [{ dataDir: '/var/bud\uD800dy' }, ['data_dir_invalid_character']],
    [{ dataDir: '/var/bud\u007Fdy' }, ['data_dir_invalid_character']],
    [
      { dataDir: `/var/bud${String.fromCharCode(0xfffe)}dy` },
      ['data_dir_invalid_character'],
    ],
    [{ dataDir: '/var/bud\tdy' }, ['data_dir_invalid_character']],
    [{ label: 'dev buddy' }, ['label_invalid']],
    [{ label: '../evil' }, ['label_invalid']],
    [
      { nodePath: 'node', dataDir: 'data' },
      ['node_path_not_absolute', 'data_dir_not_absolute'],
    ],
  ];
  for (const [patch, reasons] of cases) {
    const definition = { ...SYNTHETIC, ...patch };
    assert.deepEqual(launchAgentDefinitionReasons(definition), reasons);
    assert.throws(() => renderLaunchAgentPlist(definition), TypeError);
  }
  assert.deepEqual(launchAgentDefinitionReasons(SYNTHETIC), []);
});

// --- 登録・解除（ファイル出力あり）。macOS 用の POSIX パスを使うため Windows では省略する。
const posixOnly = { skip: process.platform === 'win32' };
const UID = 501;
const NOT_FOUND: CommandResult = { exitCode: 113, stdout: '', stderr: '' };
const OK: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const launch = {
    nodePath: '/opt/buddy-test/bin/node',
    coreCliPath: '/opt/buddy-test/core/dist/cli.js',
    dataDir: join(root, 'data'),
  };
  const plistPath = join(
    home,
    'Library',
    'LaunchAgents',
    'dev.buddy.core.plist',
  );
  return { root, home, launch, plistPath };
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test(
  'enabled: true でなければファイルもコマンドも触らない',
  posixOnly,
  async (t) => {
    const { home, launch, plistPath } = await fixture(t);
    const runner = createMockCommandRunner(() => OK);
    const supervisor = createMacLaunchAgentSupervisor({
      runner,
      homeDir: home,
      uid: UID,
    });
    const requests = [
      { enabled: false, loadNow: true, launch },
      { loadNow: true, launch },
      { enabled: 'true', loadNow: true, launch },
      undefined,
    ] as unknown as RegisterRequest[];
    for (const request of requests)
      assert.deepEqual(await supervisor.register(request), {
        status: 'not_enabled',
      });
    assert.deepEqual(runner.calls, []);
    assert.equal(await exists(plistPath), false);
    assert.equal(await exists(join(home, 'Library')), false);
  },
);

test(
  '有効にすると plist を書き、bootstrap gui/<uid> で読み込む',
  posixOnly,
  async (t) => {
    const { home, launch, plistPath } = await fixture(t);
    const runner = createMockCommandRunner((_command, args) =>
      args[0] === 'print' ? NOT_FOUND : OK,
    );
    const supervisor = createMacLaunchAgentSupervisor({
      runner,
      homeDir: home,
      uid: UID,
    });
    assert.deepEqual(
      await supervisor.register({ enabled: true, loadNow: true, launch }),
      {
        status: 'registered',
        definitionPath: plistPath,
        loaded: true,
        alreadyLoaded: false,
      },
    );
    assert.deepEqual(runner.calls, [
      { command: '/bin/launchctl', args: ['print', 'gui/501/dev.buddy.core'] },
      { command: '/bin/launchctl', args: ['bootstrap', 'gui/501', plistPath] },
    ]);
    const data = launch.dataDir;
    assert.equal(
      await readFile(plistPath, 'utf8'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.buddy.core</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/buddy-test/bin/node</string>
    <string>/opt/buddy-test/core/dist/cli.js</string>
    <string>start</string>
    <string>--data-dir</string>
    <string>${data}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${data}/logs/core.out.log</string>
  <key>StandardErrorPath</key>
  <string>${data}/logs/core.err.log</string>
</dict>
</plist>
`,
    );
    assert.equal((await stat(plistPath)).mode & 0o777, 0o644);
    assert.ok((await stat(join(data, 'logs'))).isDirectory());
    assert.deepEqual(await readdir(join(home, 'Library', 'LaunchAgents')), [
      'dev.buddy.core.plist',
    ]);
  },
);

test(
  'loadNow: false なら plist だけを書き、bootstrap しない',
  posixOnly,
  async (t) => {
    const { home, launch, plistPath } = await fixture(t);
    const runner = createMockCommandRunner(() => NOT_FOUND);
    const supervisor = createMacLaunchAgentSupervisor({
      runner,
      homeDir: home,
      uid: UID,
    });
    assert.deepEqual(
      await supervisor.register({ enabled: true, loadNow: false, launch }),
      {
        status: 'registered',
        definitionPath: plistPath,
        loaded: false,
        alreadyLoaded: false,
      },
    );
    assert.deepEqual(
      runner.calls.map((call) => call.args[0]),
      ['print'],
    );
    assert.equal(await exists(plistPath), true);
  },
);

test(
  'すでに読み込まれていれば読み込み直さない（実行中の Core を止めない）',
  posixOnly,
  async (t) => {
    const { home, launch, plistPath } = await fixture(t);
    const runner = createMockCommandRunner(() => OK);
    const supervisor = createMacLaunchAgentSupervisor({
      runner,
      homeDir: home,
      uid: UID,
    });
    assert.deepEqual(
      await supervisor.register({ enabled: true, loadNow: true, launch }),
      {
        status: 'registered',
        definitionPath: plistPath,
        loaded: true,
        alreadyLoaded: true,
      },
    );
    assert.deepEqual(
      runner.calls.map((call) => call.args[0]),
      ['print'],
    );
  },
);

test(
  'bootstrap の失敗・読み込み状態の不明は失敗として返す',
  posixOnly,
  async (t) => {
    const { home, launch, plistPath } = await fixture(t);
    const failing = createMockCommandRunner((_command, args) =>
      args[0] === 'print'
        ? NOT_FOUND
        : { exitCode: 5, stdout: '', stderr: 'Bootstrap failed: 5' },
    );
    assert.deepEqual(
      await createMacLaunchAgentSupervisor({
        runner: failing,
        homeDir: home,
        uid: UID,
      }).register({ enabled: true, loadNow: true, launch }),
      {
        status: 'failed',
        step: 'bootstrap',
        reasons: ['launchctl_bootstrap_exit:5'],
      },
    );
    assert.equal(await exists(plistPath), true);

    const unknown = createMockCommandRunner(() => ({
      exitCode: null,
      stdout: '',
      stderr: '',
    }));
    assert.deepEqual(
      await createMacLaunchAgentSupervisor({
        runner: unknown,
        homeDir: home,
        uid: UID,
      }).register({ enabled: true, loadNow: true, launch }),
      {
        status: 'failed',
        step: 'query_load_state',
        reasons: ['launchctl_print_unexpected_result'],
      },
    );
    assert.deepEqual(
      unknown.calls.map((call) => call.args[0]),
      ['print'],
    );
  },
);

test('使えない起動方法は書き出さずに失敗を返す', posixOnly, async (t) => {
  const { home, launch, plistPath } = await fixture(t);
  const runner = createMockCommandRunner(() => OK);
  assert.deepEqual(
    await createMacLaunchAgentSupervisor({
      runner,
      homeDir: home,
      uid: UID,
    }).register({
      enabled: true,
      loadNow: true,
      launch: { ...launch, coreCliPath: 'dist/cli.js' },
    }),
    {
      status: 'failed',
      step: 'invalid_spec',
      reasons: ['core_cli_path_not_absolute'],
    },
  );
  assert.deepEqual(runner.calls, []);
  assert.equal(await exists(plistPath), false);
});

test(
  '解除は plist を消し、unloadNow のときだけ bootout する',
  posixOnly,
  async (t) => {
    const { home, launch, plistPath } = await fixture(t);
    let loaded = true;
    const runner = createMockCommandRunner((_command, args) => {
      if (args[0] === 'print') return loaded ? OK : NOT_FOUND;
      if (args[0] === 'bootout') loaded = false;
      return OK;
    });
    const supervisor = createMacLaunchAgentSupervisor({
      runner,
      homeDir: home,
      uid: UID,
    });
    await supervisor.register({ enabled: true, loadNow: false, launch });
    const before = runner.calls.length;

    assert.deepEqual(await supervisor.unregister({ unloadNow: false }), {
      status: 'unregistered',
      removedDefinition: true,
      bootedOut: false,
    });
    assert.equal(await exists(plistPath), false);
    assert.equal(runner.calls.length, before);

    await writeFile(plistPath, 'synthetic');
    assert.deepEqual(await supervisor.unregister({ unloadNow: true }), {
      status: 'unregistered',
      removedDefinition: true,
      bootedOut: true,
    });
    assert.deepEqual(runner.calls.slice(before), [
      { command: '/bin/launchctl', args: ['print', 'gui/501/dev.buddy.core'] },
      {
        command: '/bin/launchctl',
        args: ['bootout', 'gui/501/dev.buddy.core'],
      },
    ]);
    assert.equal(await exists(plistPath), false);

    assert.deepEqual(await supervisor.unregister({ unloadNow: true }), {
      status: 'unregistered',
      removedDefinition: false,
      bootedOut: false,
    });

    // unloadNow を明示しなければ bootout しない。
    loaded = true;
    const calls = runner.calls.length;
    assert.deepEqual(
      await supervisor.unregister(undefined as unknown as UnregisterRequest),
      { status: 'unregistered', removedDefinition: false, bootedOut: false },
    );
    assert.equal(runner.calls.length, calls);
  },
);

test(
  'bootout に失敗して読み込まれたままなら失敗を返す',
  posixOnly,
  async (t) => {
    const { home } = await fixture(t);
    const runner = createMockCommandRunner((_command, args) =>
      args[0] === 'print' ? OK : { exitCode: 1, stdout: '', stderr: '' },
    );
    assert.deepEqual(
      await createMacLaunchAgentSupervisor({
        runner,
        homeDir: home,
        uid: UID,
      }).unregister({ unloadNow: true }),
      {
        status: 'failed',
        step: 'bootout',
        reasons: ['launchctl_bootout_exit:1'],
      },
    );
  },
);

test('状態確認は plist の有無と読み込み状態を返す', posixOnly, async (t) => {
  const { home, launch, plistPath } = await fixture(t);
  let printResult: CommandResult = NOT_FOUND;
  const runner = createMockCommandRunner(() => printResult);
  const supervisor = createMacLaunchAgentSupervisor({
    runner,
    homeDir: home,
    uid: UID,
  });
  assert.deepEqual(await supervisor.status(), {
    status: 'ok',
    platform: 'macos',
    definitionPath: plistPath,
    installed: false,
    load: 'not_loaded',
  });
  await supervisor.register({ enabled: true, loadNow: false, launch });
  printResult = OK;
  assert.deepEqual(await supervisor.status(), {
    status: 'ok',
    platform: 'macos',
    definitionPath: plistPath,
    installed: true,
    load: 'loaded',
  });
  printResult = { exitCode: 1, stdout: '', stderr: '' };
  assert.equal((await supervisor.status()).status, 'ok');
  const status = await supervisor.status();
  assert.equal(status.status === 'ok' ? status.load : null, 'unknown');
});

test('不正な uid・homeDir・label ではアダプターを作らない', () => {
  const runner = createMockCommandRunner(() => OK);
  for (const options of [
    { homeDir: '/Users/synthetic', uid: -1 },
    { homeDir: '/Users/synthetic', uid: 1.5 },
    { homeDir: 'relative/home', uid: 501 },
    { homeDir: '/Users/synthetic', uid: 501, label: 'a/b' },
  ])
    assert.throws(
      () => createMacLaunchAgentSupervisor({ runner, ...options }),
      TypeError,
    );
});
