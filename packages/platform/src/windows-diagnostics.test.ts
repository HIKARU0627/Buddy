// Windows の電源の診断（powercfg）の試験（ADR 0203）。出力は Microsoft の文書の `powercfg /query` の形に合わせた合成の値。
// 英語と日本語の見出しの両方で、16 進の値の並びだけを読むことを確かめる。実機の powercfg は呼ばない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockCommandRunner } from './runner.js';
import {
  parseHibernateEnabled,
  parsePowercfgRange,
  readWindowsHostDiagnostics,
  sleepSettingOfSeconds,
  windowsHostDiagnosticWarnings,
} from './windows-diagnostics.js';

const POWERCFG = 'C:\\Windows\\System32\\powercfg.exe';
const REG = 'C:\\Windows\\System32\\reg.exe';

function englishOutput(ac: string, dc: string): string {
  return [
    'Power Scheme GUID: 00000000-0000-0000-0000-000000000001  (Synthetic plan)',
    '  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)',
    '    GUID Alias: SUB_SLEEP',
    '    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)',
    '      GUID Alias: STANDBYIDLE',
    '      Minimum Possible Setting: 0x00000000',
    '      Maximum Possible Setting: 0xffffffff',
    '      Possible Settings increment: 0x00000001',
    '      Possible Settings units: Seconds',
    `    Current AC Power Setting Index: 0x${ac}`,
    `    Current DC Power Setting Index: 0x${dc}`,
    '',
  ].join('\r\n');
}

function japaneseOutput(ac: string, dc: string): string {
  return [
    '電源設定の GUID: 00000000-0000-0000-0000-000000000001  (合成のプラン)',
    '  サブグループの GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (スリープ)',
    '    GUID エイリアス: SUB_SLEEP',
    '    電源設定の GUID: 9d7815a6-7ee4-497e-8888-515a05f02364  (次の時間が経過後休止状態にする)',
    '      GUID エイリアス: HIBERNATEIDLE',
    '      利用可能な設定の最小値: 0x00000000',
    '      利用可能な設定の最大値: 0xffffffff',
    '      利用可能な設定の増分: 0x00000001',
    '      利用可能な設定の単位: 秒',
    `    現在の AC 電源設定のインデックス: 0x${ac}`,
    `    現在の DC 電源設定のインデックス: 0x${dc}`,
    '',
  ].join('\r\n');
}

test('powercfg の出力から AC と DC の現在値（秒）を読む', () => {
  assert.deepEqual(parsePowercfgRange(englishOutput('00000708', '00000384')), {
    ac: 1800,
    dc: 900,
  });
  assert.deepEqual(parsePowercfgRange(japaneseOutput('00000000', '00002a30')), {
    ac: 0,
    dc: 10800,
  });
  // 16 進の値の数が 5 つでなければ読まない（別の種類の設定・途中で切れた出力）。
  assert.equal(parsePowercfgRange(''), null);
  assert.equal(
    parsePowercfgRange(
      englishOutput('00000708', '00000384')
        .split('\r\n')
        .slice(0, 10)
        .join('\r\n'),
    ),
    null,
  );
  assert.equal(
    parsePowercfgRange(
      `${englishOutput('00000708', '00000384')}    Extra: 0x00000001\r\n`,
    ),
    null,
  );
});

test('秒の値をスリープの設定にする（0 はしない、それ以外は分に切り上げる）', () => {
  assert.deepEqual(sleepSettingOfSeconds(0), {
    state: 'never',
    idleMinutes: null,
  });
  assert.deepEqual(sleepSettingOfSeconds(60), {
    state: 'after_idle',
    idleMinutes: 1,
  });
  assert.deepEqual(sleepSettingOfSeconds(61), {
    state: 'after_idle',
    idleMinutes: 2,
  });
  assert.deepEqual(sleepSettingOfSeconds(-1), {
    state: 'unknown',
    idleMinutes: null,
  });
});

// `reg query HKLM\SYSTEM\CurrentControlSet\Control\Power /v HibernateEnabled` の形の合成の出力。
function regOutput(hex: string): string {
  return [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Power',
    `    HibernateEnabled    REG_DWORD    0x${hex}`,
    '',
  ].join('\r\n');
}

function powerRunner(standby: string, hibernate: string, reg: string | null) {
  return createMockCommandRunner((command, args) => {
    if (command === REG)
      return reg === null
        ? { exitCode: 1, stdout: '', stderr: 'synthetic' }
        : { exitCode: 0, stdout: regOutput(reg), stderr: '' };
    return {
      exitCode: 0,
      stdout: args.includes('STANDBYIDLE')
        ? englishOutput(standby, '00000384')
        : japaneseOutput(hibernate, hibernate),
      stderr: '',
    };
  });
}

test('powercfg と reg を絶対パスで呼び、AC の値と休止状態の有無から警告を作る', async () => {
  const runner = powerRunner('00000000', '00002a30', '1');
  const diagnostics = await readWindowsHostDiagnostics(runner, 'C:\\Windows');
  assert.deepEqual(diagnostics, {
    systemSleep: { state: 'never', idleMinutes: null },
    hibernate: { state: 'after_idle', idleMinutes: 180 },
    hibernateAvailable: true,
  });
  assert.deepEqual(windowsHostDiagnosticWarnings(diagnostics), [
    'hibernate_enabled',
  ]);
  assert.deepEqual(
    runner.calls.map((call) => [call.command, ...call.args]),
    [
      [POWERCFG, '/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'],
      [POWERCFG, '/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'HIBERNATEIDLE'],
      [
        REG,
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power',
        '/v',
        'HibernateEnabled',
      ],
    ],
  );
});

test('休止状態そのものが無効（powercfg /h off）なら、休止状態までの時間があっても警告しない', async () => {
  const diagnostics = await readWindowsHostDiagnostics(
    powerRunner('00000708', '00002a30', '0'),
    'C:\\Windows',
  );
  assert.deepEqual(diagnostics.hibernate, {
    state: 'never',
    idleMinutes: null,
  });
  assert.equal(diagnostics.hibernateAvailable, false);
  assert.deepEqual(windowsHostDiagnosticWarnings(diagnostics), [
    'system_sleep_enabled',
  ]);
});

test('休止状態の有無を読めなければ、警告を「かもしれない」に弱める', async () => {
  const diagnostics = await readWindowsHostDiagnostics(
    powerRunner('00000000', '00002a30', null),
    'C:\\Windows',
  );
  assert.equal(diagnostics.hibernateAvailable, null);
  assert.deepEqual(windowsHostDiagnosticWarnings(diagnostics), [
    'hibernate_maybe_enabled',
  ]);
});

test('HibernateEnabled の出力を厳しく読む', () => {
  assert.equal(parseHibernateEnabled(regOutput('1')), true);
  assert.equal(parseHibernateEnabled(regOutput('0')), false);
  assert.equal(parseHibernateEnabled(regOutput('2')), null);
  assert.equal(parseHibernateEnabled(''), null);
  assert.equal(
    parseHibernateEnabled(`${regOutput('1')}${regOutput('0')}`),
    null,
  );
});

test('失敗・読めない出力・SystemRoot がないときは unknown で、良好と推測しない', async () => {
  const failing = createMockCommandRunner(() => ({
    exitCode: 1,
    stdout: '',
    stderr: 'synthetic',
  }));
  const unknown = await readWindowsHostDiagnostics(failing, 'C:\\Windows');
  assert.deepEqual(windowsHostDiagnosticWarnings(unknown), [
    'system_sleep_unknown',
    'hibernate_unknown',
  ]);
  const unused = createMockCommandRunner(() => ({
    exitCode: 0,
    stdout: englishOutput('00000000', '00000000'),
    stderr: '',
  }));
  const noRoot = await readWindowsHostDiagnostics(unused, undefined);
  assert.deepEqual(windowsHostDiagnosticWarnings(noRoot), [
    'system_sleep_unknown',
    'hibernate_unknown',
  ]);
  assert.deepEqual(unused.calls, []);
  const throwing = await readWindowsHostDiagnostics(
    { run: () => Promise.reject(new Error('x')) },
    'C:\\Windows',
  );
  assert.equal(throwing.systemSleep.state, 'unknown');
  // スリープしない・休止状態にしない設定なら警告はない。
  assert.deepEqual(
    windowsHostDiagnosticWarnings(
      await readWindowsHostDiagnostics(unused, 'C:\\Windows'),
    ),
    [],
  );
});
