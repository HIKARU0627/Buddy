import assert from 'node:assert/strict';
import test from 'node:test';
import { controlEndpoint, defaultDataDir, socketPathTooLong } from './paths.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMacKeychainKeyStore,
  createMockKeyStore,
  createMockStdinCommandRunner,
  createWindowsDpapiKeyStore,
} from '@buddy/platform';
import type { KeyringModule } from '@buddy/platform';
import { keyProtectionCheck, runPreflight } from './preflight.js';

// 期待値は手書き。パイプ名の SHA-256 は shasum -a 256 で別に求めた値。

test('default data directories follow each OS convention', () => {
  assert.equal(
    defaultDataDir({ platform: 'darwin', env: {}, homedir: '/Users/example' }),
    '/Users/example/Library/Application Support/Buddy/core',
  );
  // Windows は %LOCALAPPDATA%（移動プロファイルで同期しない場所。ADR 0202）。%APPDATA%（Roaming）は使わない。
  assert.equal(
    defaultDataDir({
      platform: 'win32',
      env: {
        LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
        APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
      },
      homedir: 'C:\\Users\\example',
    }),
    'C:\\Users\\example\\AppData\\Local\\Buddy\\core',
  );
  assert.equal(
    defaultDataDir({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\example\\AppData\\Roaming' },
      homedir: 'C:\\Users\\example',
    }),
    'C:\\Users\\example\\AppData\\Local\\Buddy\\core',
  );
  // 相対パスの LOCALAPPDATA は使わず、ホームの下の既定へ戻す。
  assert.equal(
    defaultDataDir({
      platform: 'win32',
      env: { LOCALAPPDATA: 'relative\\Local' },
      homedir: 'D:\\Profiles\\example',
    }),
    'D:\\Profiles\\example\\AppData\\Local\\Buddy\\core',
  );
  assert.equal(
    defaultDataDir({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/data/example' },
      homedir: '/home/example',
    }),
    '/data/example/buddy/core',
  );
  assert.equal(
    defaultDataDir({ platform: 'linux', env: {}, homedir: '/home/example' }),
    '/home/example/.local/share/buddy/core',
  );
  // 相対パスの XDG_DATA_HOME は仕様上無効なので既定へ戻す。
  assert.equal(
    defaultDataDir({
      platform: 'linux',
      env: { XDG_DATA_HOME: 'relative/data' },
      homedir: '/home/example',
    }),
    '/home/example/.local/share/buddy/core',
  );
});

test('control endpoints: socket in the data directory, named pipe from the path digest', () => {
  assert.equal(
    controlEndpoint('/home/example/.local/share/buddy/core', 'linux'),
    '/home/example/.local/share/buddy/core/control.sock',
  );
  assert.equal(
    controlEndpoint(
      'C:\\Users\\example\\AppData\\Roaming\\Buddy\\core',
      'win32',
    ),
    '\\\\.\\pipe\\buddy-core-f09700047c695401',
  );
  assert.equal(
    controlEndpoint('D:\\buddy-data', 'win32'),
    '\\\\.\\pipe\\buddy-core-2f97910c0a367f79',
  );
});

test('unix socket paths longer than 103 bytes are refused, pipes are not limited', () => {
  assert.equal(socketPathTooLong(`/${'a'.repeat(102)}`, 'darwin'), false);
  assert.equal(socketPathTooLong(`/${'a'.repeat(103)}`, 'darwin'), true);
  // 多バイト文字はバイト数で数える（「あ」は UTF-8 で 3 バイト）。
  assert.equal(socketPathTooLong(`/${'あ'.repeat(34)}`, 'linux'), false);
  assert.equal(socketPathTooLong(`/${'あ'.repeat(35)}`, 'linux'), true);
  assert.equal(
    socketPathTooLong(`\\\\.\\pipe\\${'a'.repeat(200)}`, 'win32'),
    false,
  );
});

// 模擬の DPAPI。標準入力の「操作・entropy・データ」の 3 行を読む（本物の DPAPI の暗号ではない。往復の形だけを再現する）。
// protect は DPAPI の blob の見出し（版 1・提供者の GUID・マスターキーの版と GUID・dwFlags 0 の 44 バイト）の後に、
// データの各バイトを 0x5a と XOR した値を付けて返す。unprotect は見出しを外して戻す。
const FAKE_DPAPI_HEADER = Buffer.from(
  'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAAAAECAwQFBgcICQoLDA0ODwAAAAA=',
  'base64',
);
function fakeDpapiRunner() {
  return createMockStdinCommandRunner((_command, _args, stdin) => {
    const [op = '', , data = ''] = stdin.split('\n');
    const bytes = Buffer.from(data, 'base64');
    const xor = (input: Buffer) =>
      Buffer.from(input.map((byte) => byte ^ 0x5a));
    if (op === 'protect')
      return {
        exitCode: 0,
        stdout: `${Buffer.concat([FAKE_DPAPI_HEADER, xor(bytes)]).toString('base64')}\r\n`,
        stderr: '',
      };
    if (op === 'unprotect')
      return {
        exitCode: 0,
        stdout: xor(bytes.subarray(FAKE_DPAPI_HEADER.length)).toString(
          'base64',
        ),
        stderr: '',
      };
    return { exitCode: 11, stdout: '', stderr: '' };
  });
}

test('preflight: mock key protection passes, unavailable key protection refuses without a plaintext fallback', async (t) => {
  assert.deepEqual(await runPreflight([keyProtectionCheck('mock')]), []);
  assert.deepEqual(
    await runPreflight([keyProtectionCheck('mock_unavailable')]),
    ['key_protection_unavailable:mock_unavailable'],
  );
  // Linux の中枢は初期版の対象外。鍵保護がないので起動しない。
  assert.deepEqual(
    await runPreflight([keyProtectionCheck('os', { nodePlatform: 'linux' })]),
    ['key_protection_unavailable:linux_core_not_supported_in_initial_release'],
  );
  // Windows は DPAPI（ADR 0202）。模擬の PowerShell と一時ディレクトリを使い、本人の置き場所と実機の DPAPI には触れない。
  const keyDir = await mkdtemp(join(tmpdir(), 'buddy-dpapi-preflight-'));
  t.after(() => rm(keyDir, { recursive: true, force: true }));
  const dpapi = fakeDpapiRunner();
  assert.deepEqual(
    await runPreflight([
      keyProtectionCheck('os', {
        nodePlatform: 'win32',
        keyStore: createWindowsDpapiKeyStore({
          directory: keyDir,
          powershellPath:
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          runner: dpapi,
        }),
      }),
    ]),
    [],
  );
  // 初回は作成（protect）して読み戻す（unprotect）。項目は 1 つ。
  assert.deepEqual(
    dpapi.calls.map((call) => call.stdin.split('\n')[0]),
    ['protect', 'unprotect'],
  );
  assert.equal((await readdir(keyDir)).length, 1);
  // PowerShell を起動できない・置き場所（LOCALAPPDATA）がないときは起動しない。平文へ切り替えない。
  const noProcess = createMockStdinCommandRunner(() => ({
    exitCode: null,
    stdout: '',
    stderr: '',
  }));
  const emptyDir = await mkdtemp(join(tmpdir(), 'buddy-dpapi-preflight-'));
  t.after(() => rm(emptyDir, { recursive: true, force: true }));
  assert.deepEqual(
    await runPreflight([
      keyProtectionCheck('os', {
        nodePlatform: 'win32',
        keyStore: createWindowsDpapiKeyStore({
          directory: emptyDir,
          powershellPath:
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          runner: noProcess,
        }),
      }),
    ]),
    ['key_protection_unavailable:dpapi_unavailable'],
  );
  assert.deepEqual(await readdir(emptyDir), []);
  assert.deepEqual(
    await runPreflight([
      keyProtectionCheck('os', {
        nodePlatform: 'win32',
        keyStore: createWindowsDpapiKeyStore({ env: {}, runner: noProcess }),
      }),
    ]),
    ['key_protection_unavailable:dpapi_unavailable'],
  );
  // macOS はキーチェーンのデータ鍵を取得（初回は作成）できるかを確かめる。
  // 模擬の keyring モジュールを使い、実機のキーチェーンには触れない。
  const items = new Map<string, string>();
  const keyring = (getFails: boolean): KeyringModule => ({
    AsyncEntry: class {
      getPassword() {
        return getFails
          ? Promise.reject(new Error('synthetic keychain locked'))
          : Promise.resolve(items.get('data-key') ?? null);
      }
      setPassword(value: string) {
        items.set('data-key', value);
        return Promise.resolve();
      }
    },
  });
  assert.deepEqual(
    await runPreflight([
      keyProtectionCheck('os', {
        nodePlatform: 'darwin',
        keyStore: createMacKeychainKeyStore({
          loadModule: () => Promise.resolve(keyring(false)),
        }),
      }),
    ]),
    [],
  );
  assert.equal(items.size, 1);
  assert.deepEqual(
    await runPreflight([
      keyProtectionCheck('os', {
        nodePlatform: 'darwin',
        keyStore: createMacKeychainKeyStore({
          loadModule: () => Promise.resolve(keyring(true)),
        }),
      }),
    ]),
    ['key_protection_unavailable:keystore_read_failed'],
  );
  assert.deepEqual(
    await runPreflight([
      keyProtectionCheck('os', {
        nodePlatform: 'darwin',
        keyStore: createMacKeychainKeyStore({
          loadModule: () => Promise.reject(new Error('no native binding')),
        }),
      }),
    ]),
    ['key_protection_unavailable:keystore_module_unavailable'],
  );
  // 実機の検査に模擬の KeyStore を渡しても受け入れない。
  assert.deepEqual(
    await runPreflight([
      keyProtectionCheck('os', {
        nodePlatform: 'darwin',
        keyStore: createMockKeyStore(),
      }),
    ]),
    ['key_protection_unavailable:mock_not_allowed'],
  );
  assert.deepEqual(
    await runPreflight([() => ['a'], async () => [], async () => ['b', 'c']]),
    ['a', 'b', 'c'],
  );
});
