import assert from 'node:assert/strict';
import test from 'node:test';
import { controlEndpoint, defaultDataDir, socketPathTooLong } from './paths.js';
import { keyProtectionCheck, runPreflight } from './preflight.js';

// 期待値は手書き。パイプ名の SHA-256 は shasum -a 256 で別に求めた値。

test('default data directories follow each OS convention', () => {
  assert.equal(
    defaultDataDir({ platform: 'darwin', env: {}, homedir: '/Users/example' }),
    '/Users/example/Library/Application Support/Buddy/core',
  );
  assert.equal(
    defaultDataDir({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\example\\AppData\\Roaming' },
      homedir: 'C:\\Users\\example',
    }),
    'C:\\Users\\example\\AppData\\Roaming\\Buddy\\core',
  );
  assert.equal(
    defaultDataDir({
      platform: 'win32',
      env: {},
      homedir: 'C:\\Users\\example',
    }),
    'C:\\Users\\example\\AppData\\Roaming\\Buddy\\core',
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

test('preflight: mock key protection passes, unavailable and unimplemented checks refuse', async () => {
  assert.deepEqual(await runPreflight([keyProtectionCheck('mock')]), []);
  assert.deepEqual(
    await runPreflight([keyProtectionCheck('mock_unavailable')]),
    ['key_protection_unavailable'],
  );
  assert.deepEqual(await runPreflight([keyProtectionCheck('os')]), [
    'key_protection_check_not_implemented',
  ]);
  assert.deepEqual(
    await runPreflight([() => ['a'], async () => [], async () => ['b', 'c']]),
    ['a', 'b', 'c'],
  );
});
