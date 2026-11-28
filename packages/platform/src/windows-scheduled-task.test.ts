// Windows のログオン時のタスクの生成・登録・解除・状態の試験（ADR 0203）。期待値は手で書き、実装の関数で作らない。
// 実機の schtasks・whoami・PowerShell は呼ばない（模擬の runner）。ファイルの書き込みも模擬（Windows のパスを
// Linux の CI で扱うため）。値は合成（SID・パスは実在しない形）。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandResult } from './runner.js';
import { createMockCommandRunner } from './runner.js';
import type { RegisterRequest } from './supervisor.js';
import type { WindowsTaskFiles } from './windows-scheduled-task.js';
import {
  createWindowsScheduledTaskSupervisor,
  encodeWindowsTaskXml,
  parseWhoamiUserSid,
  parseWindowsTaskQuery,
  renderWindowsTaskXml,
  windowsTaskDefinitionReasons,
  windowsTaskQueryScript,
} from './windows-scheduled-task.js';

const SYSTEM_ROOT = 'C:\\Windows';
const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe';
const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';
const POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SID = 'S-1-5-21-1000000001-1000000002-1000000003-1001';

const LAUNCH = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  coreCliPath: 'C:\\buddy-test\\apps\\core\\dist\\cli.js',
  dataDir: 'C:\\buddy-test\\data & logs',
};

const ok = (stdout = ''): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
});
const exit = (code: number | null): CommandResult => ({
  exitCode: code,
  stdout: '',
  stderr: 'synthetic localized message',
});

// 書き込みを記録する模擬のファイル操作。
function fakeFiles(failWrite = false) {
  const written = new Map<string, Buffer>();
  const removed: string[] = [];
  const dirs: string[] = [];
  const files: WindowsTaskFiles = {
    mkdir(path) {
      dirs.push(path);
      return Promise.resolve();
    },
    writeFile(path, data) {
      if (failWrite)
        return Promise.reject(
          Object.assign(new Error('x'), { code: 'EACCES' }),
        );
      written.set(path, data);
      return Promise.resolve();
    },
    rm(path) {
      removed.push(path);
      return Promise.resolve();
    },
  };
  return { files, written, removed, dirs };
}

test('タスクの XML は手書きの期待値と一致し、失敗時の再起動・時間の上限を持たない', () => {
  const expected = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Buddy Core</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '      <UserId>S-1-5-21-1000000001-1000000002-1000000003-1001</UserId>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>S-1-5-21-1000000001-1000000002-1000000003-1001</UserId>',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>5</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>&quot;C:\\Program Files\\nodejs\\node.exe&quot;</Command>',
    '      <Arguments>&quot;C:\\buddy-test\\apps\\core\\dist\\cli.js&quot; autostart launch --data-dir &quot;C:\\buddy-test\\data &amp; logs&quot;</Arguments>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
  const xml = renderWindowsTaskXml({ ...LAUNCH, userSid: SID });
  assert.equal(xml, expected);
  for (const absent of [
    'RestartOnFailure',
    'Password',
    'S4U',
    'HighestAvailable',
    'BootTrigger',
  ])
    assert.ok(!xml.includes(absent), absent);
});

test('XML は UTF-16LE の BOM つきで書く', () => {
  const encoded = encodeWindowsTaskXml('<a/>');
  assert.deepEqual(
    [...encoded],
    [0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00, 0x2f, 0x00, 0x3e, 0x00],
  );
});

test('使えないパス・SID・タスク名は理由のコードになり、XML を作らない', () => {
  const cases: [Record<string, string>, string[]][] = [
    [{ nodePath: '' }, ['node_path_empty']],
    [{ nodePath: 'node.exe' }, ['node_path_not_absolute']],
    [{ nodePath: '\\\\server\\share\\node.exe' }, ['node_path_not_absolute']],
    [{ nodePath: '/usr/bin/node' }, ['node_path_not_absolute']],
    [{ coreCliPath: 'C:\\a\\..\\cli.js' }, ['core_cli_path_not_absolute']],
    [
      { coreCliPath: 'C:\\a\\%USERNAME%\\cli.js' },
      ['core_cli_path_invalid_character'],
    ],
    [{ coreCliPath: 'C:\\a\\"b\\cli.js' }, ['core_cli_path_invalid_character']],
    [{ dataDir: 'C:\\data\\' }, ['data_dir_not_normalized']],
    [{ dataDir: 'C:\\data\\\\x' }, ['data_dir_not_absolute']],
    [{ dataDir: 'C:\\data\nx' }, ['data_dir_invalid_character']],
    [{ dataDir: 'C:/data' }, ['data_dir_not_absolute']],
    [{ userSid: 'S-1-5' }, ['user_sid_invalid']],
    [{ userSid: 'S-1-5-21-1</UserId>' }, ['user_sid_invalid']],
    [{ taskName: "Buddy'; Remove-Item" }, ['task_name_invalid']],
  ];
  for (const [override, reasons] of cases) {
    const definition = { ...LAUNCH, userSid: SID, ...override };
    assert.deepEqual(
      windowsTaskDefinitionReasons(definition),
      reasons,
      JSON.stringify(override),
    );
    assert.throws(() => renderWindowsTaskXml(definition), TypeError);
  }
  assert.deepEqual(
    windowsTaskDefinitionReasons({ ...LAUNCH, userSid: SID }),
    [],
  );
});

test('whoami の CSV から SID だけを読む', () => {
  assert.equal(
    parseWhoamiUserSid(
      '"synthetic-pc\\synthetic-user","S-1-5-21-1000000001-1000000002-1000000003-1001"\r\n',
    ),
    SID,
  );
  for (const output of [
    '',
    'USER INFORMATION\r\n----------------\r\n',
    '"a\\b","S-1-5"\r\n',
    '"a\\b","S-1-5-21-1"\r\n"c\\d","S-1-5-21-2"\r\n',
    '"a\\b","not-a-sid"',
  ])
    assert.equal(parseWhoamiUserSid(output), null, output);
});

test('状態の問い合わせのスクリプトは固定の文字列で、出力の JSON を厳しく読む', () => {
  assert.equal(
    windowsTaskQueryScript('BuddyCore'),
    "$ErrorActionPreference = 'Stop'; try { $t = Get-ScheduledTask -TaskPath '\\' -TaskName 'BuddyCore' } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { '{\"found\":false}'; exit 0 }; exit 3 }; [pscustomobject]@{ found = $true; enabled = [bool]$t.Settings.Enabled; state = [string]$t.State } | ConvertTo-Json -Compress",
  );
  assert.throws(() => windowsTaskQueryScript("x' ; calc"), TypeError);
  assert.deepEqual(parseWindowsTaskQuery('{"found":false}\r\n'), {
    found: false,
  });
  assert.deepEqual(
    parseWindowsTaskQuery('{"found":true,"enabled":true,"state":"Ready"}'),
    { found: true, enabled: true, state: 'Ready' },
  );
  for (const output of [
    '',
    'null',
    '[]',
    '{"found":false,"extra":1}',
    '{"found":true,"enabled":"true","state":"Ready"}',
    '{"found":true,"enabled":true}',
    '{"found":true,"enabled":true,"state":"Ready now"}',
  ])
    assert.equal(parseWindowsTaskQuery(output), null, output);
});

const request: RegisterRequest = {
  enabled: true,
  loadNow: false,
  launch: LAUNCH,
};

test('有効にしていなければ、コマンドもファイルも触らない', async () => {
  const runner = createMockCommandRunner(() => ok());
  const fake = fakeFiles();
  const supervisor = createWindowsScheduledTaskSupervisor({
    runner,
    systemRoot: SYSTEM_ROOT,
    files: fake.files,
  });
  assert.equal(supervisor.platform, 'windows');
  assert.deepEqual(await supervisor.register({ ...request, enabled: false }), {
    status: 'not_enabled',
  });
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(fake.dirs, []);
});

test('登録: SID を読み、XML を一時ファイルに書いて schtasks で作り、一時ファイルを消す（すぐには起動しない）', async () => {
  const runner = createMockCommandRunner((command) =>
    command === WHOAMI
      ? ok(`"synthetic-pc\\synthetic-user","${SID}"\r\n`)
      : ok(),
  );
  const fake = fakeFiles();
  const supervisor = createWindowsScheduledTaskSupervisor({
    runner,
    systemRoot: SYSTEM_ROOT,
    files: fake.files,
  });
  const result = await supervisor.register(request);
  assert.deepEqual(result, {
    status: 'registered',
    definitionPath: '\\BuddyCore',
    loaded: false,
    alreadyLoaded: false,
  });
  assert.deepEqual(fake.dirs, ['C:\\buddy-test\\data & logs\\logs']);
  assert.equal(fake.written.size, 1);
  const [temporary, data] = [...fake.written][0] as [string, Buffer];
  assert.match(
    temporary,
    /^C:\\buddy-test\\data & logs\\\.autostart-task\.[0-9a-f-]{36}\.xml$/u,
  );
  // 書いた中身は BOM の後に UTF-16LE の XML（本人の SID・launch の引数を含む）。
  assert.deepEqual([...data.subarray(0, 2)], [0xff, 0xfe]);
  const text = data.subarray(2).toString('utf16le');
  assert.ok(text.includes(`<UserId>${SID}</UserId>`));
  assert.ok(text.includes(' autostart launch --data-dir '));
  assert.deepEqual(fake.removed, [temporary]);
  assert.deepEqual(runner.calls, [
    { command: WHOAMI, args: ['/user', '/fo', 'csv', '/nh'] },
    {
      command: SCHTASKS,
      args: ['/Create', '/TN', '\\BuddyCore', '/XML', temporary, '/F'],
    },
  ]);
});

test('登録: loadNow ならタスクを一度実行する', async () => {
  const runner = createMockCommandRunner((command) =>
    command === WHOAMI ? ok(`"a\\b","${SID}"`) : ok(),
  );
  const supervisor = createWindowsScheduledTaskSupervisor({
    runner,
    systemRoot: SYSTEM_ROOT,
    files: fakeFiles().files,
  });
  const result = await supervisor.register({ ...request, loadNow: true });
  assert.deepEqual(result, {
    status: 'registered',
    definitionPath: '\\BuddyCore',
    loaded: true,
    alreadyLoaded: false,
  });
  assert.deepEqual(runner.calls.at(-1), {
    command: SCHTASKS,
    args: ['/Run', '/TN', '\\BuddyCore'],
  });
});

test('登録の失敗は段階と理由のコードだけを返し、出力の文言を入れない', async () => {
  const cases: {
    readonly respond: (
      command: string,
      args: readonly string[],
    ) => CommandResult;
    readonly systemRoot?: string;
    readonly failWrite?: boolean;
    readonly launch?: typeof LAUNCH;
    readonly expected: unknown;
  }[] = [
    {
      respond: () => ok(),
      launch: { ...LAUNCH, dataDir: 'relative\\data' },
      expected: {
        status: 'failed',
        step: 'invalid_spec',
        reasons: ['data_dir_not_absolute'],
      },
    },
    {
      respond: () => ok(),
      systemRoot: 'Windows',
      expected: {
        status: 'failed',
        step: 'system_root',
        reasons: ['system_root_unavailable'],
      },
    },
    {
      respond: () => exit(1),
      expected: {
        status: 'failed',
        step: 'query_user',
        reasons: ['whoami_exit:1'],
      },
    },
    {
      respond: () => ok('"a\\b","S-1-5"'),
      expected: {
        status: 'failed',
        step: 'query_user',
        reasons: ['user_sid_unreadable'],
      },
    },
    {
      respond: (command) => (command === WHOAMI ? ok(`"a\\b","${SID}"`) : ok()),
      failWrite: true,
      expected: {
        status: 'failed',
        step: 'write_definition',
        reasons: ['fs_error:EACCES'],
      },
    },
    {
      respond: (command) =>
        command === WHOAMI ? ok(`"a\\b","${SID}"`) : exit(1),
      expected: {
        status: 'failed',
        step: 'create_task',
        reasons: ['schtasks_create_exit:1'],
      },
    },
    {
      respond: (command) =>
        command === WHOAMI ? ok(`"a\\b","${SID}"`) : exit(null),
      expected: {
        status: 'failed',
        step: 'create_task',
        reasons: ['schtasks_create_exit:none'],
      },
    },
  ];
  for (const entry of cases) {
    const runner = createMockCommandRunner(entry.respond);
    const fake = fakeFiles(entry.failWrite === true);
    const supervisor = createWindowsScheduledTaskSupervisor({
      runner,
      systemRoot: entry.systemRoot ?? SYSTEM_ROOT,
      files: fake.files,
    });
    const result = await supervisor.register({
      ...request,
      launch: entry.launch ?? LAUNCH,
    });
    assert.deepEqual(result, entry.expected);
    assert.ok(!JSON.stringify(result).includes('synthetic localized'));
    // 書いた一時ファイルは必ず消す。
    for (const path of fake.written.keys())
      assert.ok(fake.removed.includes(path));
  }
});

test('解除: タスクがあれば消し、なければ何もしない。Core は止めない', async () => {
  const states = ['{"found":true,"enabled":true,"state":"Ready"}'];
  const runner = createMockCommandRunner((command) =>
    command === POWERSHELL ? ok(states[0]) : ok(),
  );
  const supervisor = createWindowsScheduledTaskSupervisor({
    runner,
    systemRoot: SYSTEM_ROOT,
    files: fakeFiles().files,
  });
  assert.deepEqual(await supervisor.unregister({ unloadNow: true }), {
    status: 'unregistered',
    removedDefinition: true,
    bootedOut: false,
  });
  assert.deepEqual(runner.calls[0]?.command, POWERSHELL);
  assert.deepEqual(runner.calls[0]?.args.slice(0, 3), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
  ]);
  assert.deepEqual(runner.calls[1], {
    command: SCHTASKS,
    args: ['/Delete', '/TN', '\\BuddyCore', '/F'],
  });
  states[0] = '{"found":false}';
  const before = runner.calls.length;
  assert.deepEqual(await supervisor.unregister({ unloadNow: false }), {
    status: 'unregistered',
    removedDefinition: false,
    bootedOut: false,
  });
  // 見つからなければ schtasks を呼ばない。
  assert.ok(
    runner.calls.slice(before).every((call) => call.command === POWERSHELL),
  );
});

test('解除: 消せず、確かめ直してもタスクが残れば失敗にする', async () => {
  const runner = createMockCommandRunner((command) =>
    command === POWERSHELL
      ? ok('{"found":true,"enabled":true,"state":"Running"}')
      : exit(1),
  );
  const supervisor = createWindowsScheduledTaskSupervisor({
    runner,
    systemRoot: SYSTEM_ROOT,
    files: fakeFiles().files,
  });
  assert.deepEqual(await supervisor.unregister({ unloadNow: false }), {
    status: 'failed',
    step: 'delete_task',
    reasons: ['schtasks_delete_exit:1'],
  });
});

test('状態: 有効なタスクは loaded、無効・なしは not_loaded、問い合わせの失敗は failed', async () => {
  const cases: [CommandResult, unknown][] = [
    [
      ok('{"found":true,"enabled":true,"state":"Ready"}'),
      {
        status: 'ok',
        platform: 'windows',
        definitionPath: '\\BuddyCore',
        installed: true,
        load: 'loaded',
      },
    ],
    [
      ok('{"found":true,"enabled":false,"state":"Disabled"}'),
      {
        status: 'ok',
        platform: 'windows',
        definitionPath: '\\BuddyCore',
        installed: true,
        load: 'not_loaded',
      },
    ],
    [
      ok('{"found":false}'),
      {
        status: 'ok',
        platform: 'windows',
        definitionPath: '\\BuddyCore',
        installed: false,
        load: 'not_loaded',
      },
    ],
    [
      exit(3),
      { status: 'failed', step: 'query_task', reasons: ['task_query_failed'] },
    ],
    [
      ok('not json'),
      { status: 'failed', step: 'query_task', reasons: ['task_query_failed'] },
    ],
  ];
  for (const [response, expected] of cases) {
    const runner = createMockCommandRunner(() => response);
    const supervisor = createWindowsScheduledTaskSupervisor({
      runner,
      systemRoot: SYSTEM_ROOT,
      files: fakeFiles().files,
    });
    assert.deepEqual(await supervisor.status(), expected);
  }
  const noRoot = createWindowsScheduledTaskSupervisor({
    runner: createMockCommandRunner(() => ok()),
    systemRoot: undefined,
  });
  assert.deepEqual(await noRoot.status(), {
    status: 'failed',
    step: 'system_root',
    reasons: ['system_root_unavailable'],
  });
});

test('runner が例外を投げても、例外にせず失敗の結果にする', async () => {
  const supervisor = createWindowsScheduledTaskSupervisor({
    runner: {
      run: () => Promise.reject(new Error('synthetic secret path')),
    },
    systemRoot: SYSTEM_ROOT,
    files: fakeFiles().files,
  });
  const result = await supervisor.status();
  assert.deepEqual(result, {
    status: 'failed',
    step: 'query_task',
    reasons: ['task_query_failed'],
  });
  assert.deepEqual(await supervisor.register(request), {
    status: 'failed',
    step: 'query_user',
    reasons: ['whoami_exit:none'],
  });
});

test('タスク名は固定の形だけを受け付ける', () => {
  assert.throws(
    () =>
      createWindowsScheduledTaskSupervisor({
        runner: createMockCommandRunner(() => ok()),
        systemRoot: SYSTEM_ROOT,
        taskName: '..\\Other',
      }),
    TypeError,
  );
});
