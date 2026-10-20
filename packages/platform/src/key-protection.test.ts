// 鍵保護の可否の確認と起動前検査。実機の security コマンドは呼ばない（模擬の runner）。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeyProtectionProbe } from './key-protection.js';
import {
  createKeyProtectionProbe,
  createMacKeychainProbe,
  createMockKeyProtectionProbe,
  createUnsupportedKeyProtectionProbe,
  keyProtectionPreflight,
} from './key-protection.js';
import type { CommandResult } from './runner.js';
import { createMockCommandRunner } from './runner.js';

const keychain = (result: CommandResult) =>
  createMacKeychainProbe(createMockCommandRunner(() => result));

test('macOS: 既定のキーチェーンがあれば使える。パスは結果に含めない', async () => {
  const runner = createMockCommandRunner(() => ({
    exitCode: 0,
    stdout: '    "/Users/synthetic/Library/Keychains/login.keychain-db"\n',
    stderr: '',
  }));
  const probe = createMacKeychainProbe(runner);
  assert.equal(probe.kind, 'os');
  const status = await probe.check();
  assert.deepEqual(status, {
    available: true,
    backend: 'macos_keychain',
    reason: null,
  });
  assert.ok(!JSON.stringify(status).includes('synthetic'));
  assert.deepEqual(runner.calls, [
    { command: '/usr/bin/security', args: ['default-keychain'] },
  ]);
  assert.deepEqual(await keyProtectionPreflight(probe), []);
});

test('macOS: 既定のキーチェーンを確かめられなければ使えない', async () => {
  const cases: [CommandResult, string][] = [
    [
      { exitCode: null, stdout: '', stderr: '' },
      'security_command_unavailable',
    ],
    [
      {
        exitCode: 50,
        stdout: '',
        stderr:
          'security: SecKeychainCopyDefault: A default keychain could not be found.',
      },
      'default_keychain_query_failed',
    ],
    [{ exitCode: 0, stdout: '', stderr: '' }, 'default_keychain_missing'],
    [
      { exitCode: 0, stdout: '"a"\n"b"\n', stderr: '' },
      'default_keychain_missing',
    ],
    [
      { exitCode: 0, stdout: 'login.keychain\n', stderr: '' },
      'default_keychain_missing',
    ],
  ];
  for (const [result, reason] of cases) {
    const probe = keychain(result);
    assert.deepEqual(await probe.check(), {
      available: false,
      backend: 'macos_keychain',
      reason,
    });
    assert.deepEqual(await keyProtectionPreflight(probe), [
      `key_protection_unavailable:${reason}`,
    ]);
  }
});

test('Windows・Linux の中枢は初期版の対象外として使えない', async () => {
  const runner = createMockCommandRunner(() => ({
    exitCode: 0,
    stdout: '"synthetic"\n',
    stderr: '',
  }));
  const cases: [string, string][] = [
    ['win32', 'windows_core_not_supported_in_initial_release'],
    ['linux', 'linux_core_not_supported_in_initial_release'],
    ['freebsd', 'platform_not_supported'],
  ];
  for (const [platform, reason] of cases) {
    const probe = createKeyProtectionProbe(platform, runner);
    assert.deepEqual(await probe.check(), {
      available: false,
      backend: 'none',
      reason,
    });
    assert.deepEqual(await keyProtectionPreflight(probe), [
      `key_protection_unavailable:${reason}`,
    ]);
    assert.deepEqual(
      await createUnsupportedKeyProtectionProbe(platform).check(),
      { available: false, backend: 'none', reason },
    );
  }
  assert.deepEqual(runner.calls, []);
  assert.equal(createKeyProtectionProbe('darwin', runner).kind, 'os');
});

test('模擬の probe は名前・kind・backend で模擬と分かり、既定では起動前検査で拒否する', async () => {
  const available = createMockKeyProtectionProbe({ available: true });
  assert.equal(available.kind, 'mock');
  assert.deepEqual(await available.check(), {
    available: true,
    backend: 'mock',
    reason: null,
  });
  assert.deepEqual(await keyProtectionPreflight(available), [
    'key_protection_unavailable:mock_not_allowed',
  ]);
  assert.deepEqual(
    await keyProtectionPreflight(available, { allowMock: true }),
    [],
  );

  const unavailable = createMockKeyProtectionProbe({
    available: false,
    reason: 'keychain_locked',
  });
  assert.deepEqual(
    await keyProtectionPreflight(unavailable, { allowMock: true }),
    ['key_protection_unavailable:keychain_locked'],
  );
  assert.deepEqual(
    await keyProtectionPreflight(
      createMockKeyProtectionProbe({ available: false }),
      { allowMock: true },
    ),
    ['key_protection_unavailable:mock_unavailable'],
  );
});

test('起動前検査: 例外・不正な結果は使えない扱いにする（良好と推測しない）', async () => {
  const probe = (check: () => Promise<unknown>): KeyProtectionProbe => ({
    kind: 'os',
    check: check as KeyProtectionProbe['check'],
  });
  const cases: [KeyProtectionProbe, string][] = [
    [probe(() => Promise.reject(new Error('boom'))), 'probe_failed'],
    [
      probe(() => {
        throw new Error('sync boom');
      }),
      'probe_failed',
    ],
    [probe(() => Promise.resolve(undefined)), 'probe_result_invalid'],
    [probe(() => Promise.resolve(null)), 'probe_result_invalid'],
    [
      probe(() =>
        Promise.resolve({ available: 'yes', backend: 'macos_keychain' }),
      ),
      'probe_result_invalid',
    ],
    [
      probe(() => Promise.resolve({ available: 1, backend: 'macos_keychain' })),
      'probe_result_invalid',
    ],
    // 実機の probe が模擬・none の「使える」を返しても受け入れない。
    [
      probe(() =>
        Promise.resolve({ available: true, backend: 'mock', reason: null }),
      ),
      'probe_result_invalid',
    ],
    [
      probe(() =>
        Promise.resolve({ available: true, backend: 'none', reason: null }),
      ),
      'probe_result_invalid',
    ],
    // 理由コードに使えない値（パスや改行を含む出力など）はそのまま出さない。
    [
      probe(() =>
        Promise.resolve({
          available: false,
          backend: 'macos_keychain',
          reason: '/Users/synthetic/Library\nKeychains',
        }),
      ),
      'unknown',
    ],
    [
      probe(() =>
        Promise.resolve({ available: false, backend: 'macos_keychain' }),
      ),
      'unknown',
    ],
  ];
  for (const [target, reason] of cases)
    assert.deepEqual(await keyProtectionPreflight(target), [
      `key_protection_unavailable:${reason}`,
    ]);

  // 模擬の probe が実機の backend を名乗っても、模擬として扱う。
  const disguised: KeyProtectionProbe = {
    kind: 'mock',
    check: () =>
      Promise.resolve({
        available: true,
        backend: 'macos_keychain',
        reason: null,
      }),
  };
  assert.deepEqual(await keyProtectionPreflight(disguised), [
    'key_protection_unavailable:mock_not_allowed',
  ]);
  assert.deepEqual(
    await keyProtectionPreflight(disguised, { allowMock: true }),
    ['key_protection_unavailable:probe_result_invalid'],
  );
});
