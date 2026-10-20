// pmset・fdesetup の出力のパース。代表的な出力は手で書いた合成例（実機から取得したものではない）。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  macHostDiagnosticWarnings,
  parseFdesetupStatus,
  parsePmsetSleep,
  readMacHostDiagnostics,
} from './macos-diagnostics.js';
import { createMockCommandRunner } from './runner.js';

const PMSET_NEVER = `System-wide power settings:
Currently in use:
 standby              0
 Sleep On Power Button 1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 networkoversleep     0
 disksleep            10
 sleep                0 (sleep prevented by sharingd, powerd)
 hibernatemode        0
 ttyskeepawake        1
 displaysleep         10
 tcpkeepalive         1
 womp                 1
`;

const PMSET_IDLE = `System-wide power settings:
Currently in use:
 disksleep            10
 sleep                1 (sleep prevented by coreaudiod)
 displaysleep         10
`;

test('pmset: sleep 0 はスリープしない、正の値はアイドル分数でスリープする', () => {
  assert.deepEqual(parsePmsetSleep(PMSET_NEVER), {
    state: 'never',
    idleMinutes: null,
  });
  assert.deepEqual(parsePmsetSleep(PMSET_IDLE), {
    state: 'after_idle',
    idleMinutes: 1,
  });
  assert.deepEqual(parsePmsetSleep(' sleep 180\r\n displaysleep 0\r\n'), {
    state: 'after_idle',
    idleMinutes: 180,
  });
});

test('pmset: SleepDisabled 1 はスリープしない', () => {
  assert.deepEqual(
    parsePmsetSleep(
      'System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 10\n',
    ),
    { state: 'never', idleMinutes: null },
  );
});

test('pmset: 判定できない出力は unknown にする', () => {
  for (const output of [
    '',
    'Currently in use:\n disksleep 10\n displaysleep 0\n',
    ' sleep abc\n',
    ' sleep -1\n',
    ' sleep 0\n sleep 10\n',
    ' SleepDisabled maybe\n sleep 0\n',
    'Sleep On Power Button 1\n',
    'pmset: unknown option\n',
  ])
    assert.deepEqual(
      parsePmsetSleep(output),
      { state: 'unknown', idleMinutes: null },
      JSON.stringify(output),
    );
});

test('fdesetup: 代表的な出力を読み取る', () => {
  assert.equal(parseFdesetupStatus('FileVault is On.\n'), 'on');
  assert.equal(parseFdesetupStatus('FileVault is Off.\n'), 'off');
  assert.equal(
    parseFdesetupStatus(
      'FileVault is Off.\nDeferred enablement appears to be active for user synthetic.\n',
    ),
    'off',
  );
  assert.equal(
    parseFdesetupStatus(
      'FileVault is On.\nEncryption in progress: Percent completed = 42.0\n',
    ),
    'encrypting',
  );
  assert.equal(
    parseFdesetupStatus(
      'FileVault is On.\nDecryption in progress: Percent completed = 10.5\n',
    ),
    'decrypting',
  );
});

test('fdesetup: 判定できない出力は unknown にする', () => {
  for (const output of [
    '',
    'FileVault is on\n',
    'FileVault is On. maybe\n',
    'FileVault is On.\nFileVault is Off.\n',
    'Error: unexpected\n',
  ])
    assert.equal(
      parseFdesetupStatus(output),
      'unknown',
      JSON.stringify(output),
    );
});

test('runner 経由の取得: 失敗したコマンドの項目は unknown', async () => {
  const good = createMockCommandRunner((command) =>
    command === '/usr/bin/pmset'
      ? { exitCode: 0, stdout: PMSET_NEVER, stderr: '' }
      : { exitCode: 0, stdout: 'FileVault is On.\n', stderr: '' },
  );
  const diagnostics = await readMacHostDiagnostics(good);
  assert.deepEqual(diagnostics, {
    systemSleep: { state: 'never', idleMinutes: null },
    fileVault: 'on',
  });
  assert.deepEqual(macHostDiagnosticWarnings(diagnostics), []);
  assert.deepEqual(
    [...good.calls].sort((a, b) => a.command.localeCompare(b.command)),
    [
      { command: '/usr/bin/fdesetup', args: ['status'] },
      { command: '/usr/bin/pmset', args: ['-g'] },
    ],
  );

  // 終了コードが 0 でなければ、出力が良好に見えても採用しない。
  const failing = createMockCommandRunner((command) =>
    command === '/usr/bin/pmset'
      ? { exitCode: 1, stdout: PMSET_NEVER, stderr: '' }
      : { exitCode: null, stdout: 'FileVault is On.\n', stderr: '' },
  );
  const unknown = await readMacHostDiagnostics(failing);
  assert.deepEqual(unknown, {
    systemSleep: { state: 'unknown', idleMinutes: null },
    fileVault: 'unknown',
  });
  assert.deepEqual(macHostDiagnosticWarnings(unknown), [
    'system_sleep_unknown',
    'filevault_unknown',
  ]);
});

test('警告: スリープする設定と FileVault の無効・復号中', () => {
  assert.deepEqual(
    macHostDiagnosticWarnings({
      systemSleep: { state: 'after_idle', idleMinutes: 10 },
      fileVault: 'off',
    }),
    ['system_sleep_enabled', 'filevault_off'],
  );
  assert.deepEqual(
    macHostDiagnosticWarnings({
      systemSleep: { state: 'never', idleMinutes: null },
      fileVault: 'decrypting',
    }),
    ['filevault_decrypting'],
  );
  assert.deepEqual(
    macHostDiagnosticWarnings({
      systemSleep: { state: 'never', idleMinutes: null },
      fileVault: 'encrypting',
    }),
    [],
  );
});
