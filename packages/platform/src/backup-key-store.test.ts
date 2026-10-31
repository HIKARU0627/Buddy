// バックアップの鍵の KeyStore（backup_file・ledger_hmac_key。ADR 0017・0055）。模擬だけ（実機のキーチェーンには触れない）。
// 期待値は手書き。鍵の値は合成。

import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  BackupKey,
  backupKeyAccount,
  createMockBackupKeyStore,
  createSlotBackupKeyStore,
  createUnsupportedBackupKeyStore,
  newBackupKeyMaterial,
} from './index.js';
import type { SecretSlot } from './index.js';

const MATERIAL = Buffer.alloc(32, 0x5a);

test('置いた鍵は読み戻せ、同じ値の再設定は何もせず、違う値は上書きしない', async () => {
  const store = createMockBackupKeyStore();
  const put = await store.put('backup_file', 'backup-file-0123', MATERIAL);
  assert.ok(put.ok);
  assert.deepEqual(put.key.key, MATERIAL);
  const read = await store.read('backup_file', 'backup-file-0123');
  assert.ok(read.ok);
  assert.deepEqual(read.key.key, MATERIAL);
  assert.equal(read.key.purpose, 'backup_file');
  // 同じ値は成功（設定のやり直し）。
  assert.ok((await store.put('backup_file', 'backup-file-0123', MATERIAL)).ok);
  // 違う値は、同じ ID の鍵を上書きしない。
  const other = Buffer.alloc(32, 0x5b);
  const clash = await store.put('backup_file', 'backup-file-0123', other);
  assert.equal(clash.ok, false);
  assert.equal(clash.ok ? '' : clash.reason, 'backup_key_exists');
  const still = await store.read('backup_file', 'backup-file-0123');
  assert.ok(still.ok);
  assert.deepEqual(still.key.key, MATERIAL);
  // 用途が違えば別の項目（同じ ID でも取り違えない）。
  const missing = await store.read('ledger_hmac_key', 'backup-file-0123');
  assert.equal(missing.ok ? '' : missing.reason, 'backup_key_missing');
  assert.deepEqual(store.accounts(), ['backup-file:backup-file-0123']);
});

test('アカウント名は用途と鍵の ID を持ち、個人情報を含まない', () => {
  assert.equal(
    backupKeyAccount('backup_file', 'backup-file-0123'),
    'backup-file:backup-file-0123',
  );
  assert.equal(
    backupKeyAccount('ledger_hmac_key', 'ledger-hmac-abcd'),
    'ledger-hmac:ledger-hmac-abcd',
  );
});

test('鍵の ID の形・鍵の長さ・保存値の形式が違えば理由だけを返し、値を返さない', async () => {
  const store = createMockBackupKeyStore();
  for (const id of ['', 'Upper', 'a b', '../x', 'a'.repeat(65), '-leading']) {
    const result = await store.read('backup_file', id);
    assert.equal(result.ok ? '' : result.reason, 'backup_key_id_invalid', id);
  }
  const short = await store.put('backup_file', 'k1', Buffer.alloc(31));
  assert.equal(short.ok ? '' : short.reason, 'backup_key_format_invalid');
  // 保存値が壊れている（正準の base64 でない・長さが違う）。
  for (const stored of [
    'not base64!',
    Buffer.alloc(31).toString('base64'),
    ' ',
  ]) {
    store.overwrite('ledger_hmac_key', 'k2', stored);
    const result = await store.read('ledger_hmac_key', 'k2');
    assert.equal(result.ok ? '' : result.reason, 'backup_key_format_invalid');
  }
});

test('保護領域を開けない・書けない・読み戻しが違うときは平文に切り替えず失敗する', async () => {
  const unavailable = createMockBackupKeyStore({ available: false });
  assert.equal(
    (await unavailable.read('backup_file', 'k1')).ok ? '' : 'mock_unavailable',
    'mock_unavailable',
  );
  const put = await unavailable.put('backup_file', 'k1', MATERIAL);
  assert.equal(put.ok ? '' : put.reason, 'mock_unavailable');
  const failing = createMockBackupKeyStore({ writeFails: true });
  const write = await failing.put('backup_file', 'k1', MATERIAL);
  assert.equal(write.ok ? '' : write.reason, 'keystore_write_failed');
  assert.deepEqual(failing.accounts(), []);
  // 書いた値を読み戻したら違った（並行した書き込みの再現）。
  let stored: string | null = null;
  const slot: SecretSlot = {
    read: () => Promise.resolve(stored),
    write: () => {
      stored = Buffer.alloc(32, 1).toString('base64');
      return Promise.resolve();
    },
  };
  const racing = createSlotBackupKeyStore({
    kind: 'mock',
    backend: 'mock',
    unavailableReason: 'mock_unavailable',
    openSlot: () => Promise.resolve(slot),
  });
  const verify = await racing.put('backup_file', 'k1', MATERIAL);
  assert.equal(verify.ok ? '' : verify.reason, 'backup_key_verify_failed');
  // 読み出しの失敗。
  const unreadable = createSlotBackupKeyStore({
    kind: 'mock',
    backend: 'mock',
    unavailableReason: 'mock_unavailable',
    openSlot: () =>
      Promise.resolve({
        read: () => Promise.reject(new Error('locked')),
        write: () => Promise.resolve(),
      }),
  });
  const read = await unreadable.read('backup_file', 'k1');
  assert.equal(read.ok ? '' : read.reason, 'keystore_read_failed');
});

test('鍵の値は JSON・inspect・文字列化に出ない', () => {
  const key = new BackupKey('ledger_hmac_key', 'ledger-hmac-1', MATERIAL);
  const shown = [
    JSON.stringify(key),
    String(key),
    inspect(key),
    `${JSON.stringify({ key })}`,
  ].join('\n');
  assert.equal(shown.includes(MATERIAL.toString('base64')), false);
  assert.equal(shown.includes(MATERIAL.toString('hex')), false);
  assert.match(shown, /\[redacted\]/u);
  // 呼び出しごとの複製を返す（書き換えても保持している値は変わらない）。
  const copy = key.key;
  copy.fill(0);
  assert.deepEqual(key.key, MATERIAL);
  assert.throws(() => new BackupKey('backup_file', 'k', Buffer.alloc(8)));
});

test('新しい鍵の素材は 32 バイトで毎回違う', () => {
  const a = newBackupKeyMaterial();
  const b = newBackupKeyMaterial();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
});

test('初期版で対応しない OS は鍵を返さない', async () => {
  for (const [platform, reason] of [
    ['win32', 'windows_core_not_supported_in_initial_release'],
    ['linux', 'linux_core_not_supported_in_initial_release'],
    ['freebsd', 'platform_not_supported'],
  ] as const) {
    const store = createUnsupportedBackupKeyStore(platform);
    const read = await store.read('backup_file', 'k1');
    assert.equal(read.ok ? '' : read.reason, reason, platform);
    const put = await store.put('backup_file', 'k1', MATERIAL);
    assert.equal(put.ok ? '' : put.reason, reason, platform);
  }
});
