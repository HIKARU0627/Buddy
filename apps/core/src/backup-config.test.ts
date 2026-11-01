// バックアップの置き場所の設定の読み込みと置き場所の検査（本人の判断 J2、ADR 0055 の U124）。
// 期待値は手書き。パスの例はすべて合成の値で、実在の個人のパスではない。

import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiContract } from './api-contract.js';
import { onCleanup } from './api-test-support.js';
import {
  MAX_BACKUP_CONFIG_BYTES,
  checkBackupConfigText,
  checkBackupLocation,
  loadBackupConfig,
  syncProviderHint,
} from './backup-config.js';

const contract = createApiContract();
const POSIX = process.platform !== 'win32';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-backup-config-'));
  onCleanup(t, () =>
    rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return dir;
}

const configText = (directory: string, keep: number): string =>
  JSON.stringify({
    schema: 'buddy.backup-config.v1',
    directory,
    keep_generations: keep,
  });

test('同期フォルダーの手がかり: パスの区切りごとの名前だけで判定し、似た名前の途中の一致では警告しない', () => {
  const cases: ReadonlyArray<[string, ReturnType<typeof syncProviderHint>]> = [
    ['/Users/a/Library/Mobile Documents/com~apple~CloudDocs/backups', 'icloud'],
    ['/Users/a/iCloud Drive/backups', 'icloud'],
    ['C:\\Users\\a\\OneDrive\\Buddy', 'onedrive'],
    ['C:\\Users\\a\\OneDrive - Contoso\\Buddy', 'onedrive'],
    ['/Users/a/Dropbox/Buddy', 'dropbox'],
    ['/Users/a/Library/CloudStorage/Dropbox/Buddy', 'dropbox'],
    ['/Users/a/Google Drive/My Drive/Buddy', 'google_drive'],
    [
      '/Users/a/Library/CloudStorage/GoogleDrive-someone/My Drive/Buddy',
      'google_drive',
    ],
    ['/Users/a/Library/CloudStorage/Box-Box/Buddy', 'other'],
    ['/Volumes/backup/buddy', null],
    ['/Users/a/Documents/OneDriveNotes/buddy', null],
    ['/Users/a/dropbox-archive/buddy', null],
    ['D:\\backups\\buddy', null],
  ];
  for (const [path, expected] of cases)
    assert.equal(syncProviderHint(path), expected, path);
});

test('設定の文: 契約の Schema に通るものだけを使い、知らない項目・重複・相対パス・..・世代の範囲外を拒否する', () => {
  assert.deepEqual(checkBackupConfigText(configText('/backups', 7), contract), {
    ok: true,
    config: {
      schema: 'buddy.backup-config.v1',
      directory: '/backups',
      keep_generations: 7,
    },
  });
  assert.equal(
    checkBackupConfigText(configText('C:\\backups', 30), contract).ok,
    true,
  );
  const refused = (text: string): readonly string[] => {
    const result = checkBackupConfigText(text, contract);
    return result.ok ? ['accepted'] : result.reasons;
  };
  assert.deepEqual(refused(configText('/backups', 0)), [
    'config_schema_invalid',
  ]);
  assert.deepEqual(refused(configText('/backups', 31)), [
    'config_schema_invalid',
  ]);
  assert.deepEqual(refused(configText('backups', 7)), [
    'config_schema_invalid',
  ]);
  assert.deepEqual(refused(configText('/backups/../etc', 7)), [
    'config_schema_invalid',
  ]);
  assert.deepEqual(refused(configText('', 7)), ['config_schema_invalid']);
  assert.deepEqual(
    refused(
      '{"schema":"buddy.backup-config.v1","directory":"/b","keep_generations":7,"extra":1}',
    ),
    ['config_schema_invalid'],
  );
  assert.deepEqual(
    refused(
      '{"schema":"buddy.backup-config.v1","directory":"/b","directory":"/c","keep_generations":7}',
    ),
    ['config_duplicate_key'],
  );
  assert.deepEqual(refused('{'), ['config_invalid_json']);
  assert.deepEqual(refused('[]'), ['config_schema_invalid']);
});

test('設定ファイル: なければ config_missing、大きすぎる・普通のファイルでない・本人以外が書けるものは使わない', async (t) => {
  const dir = await temp(t);
  const path = join(dir, 'backup-config.json');
  const reasons = async (): Promise<readonly string[]> => {
    const result = await loadBackupConfig({ path, contract });
    return result.ok ? ['accepted'] : result.reasons;
  };
  assert.deepEqual(await reasons(), ['config_missing']);
  await writeFile(path, configText('/b', 7), { mode: 0o600 });
  assert.deepEqual(await reasons(), ['accepted']);
  await writeFile(path, ' '.repeat(MAX_BACKUP_CONFIG_BYTES + 1), {
    mode: 0o600,
  });
  assert.deepEqual(await reasons(), ['config_too_large']);
  await rm(path);
  await mkdir(path);
  assert.deepEqual(await reasons(), ['config_not_regular_file']);
  await rm(path, { recursive: true });
  if (POSIX) {
    await writeFile(path, configText('/b', 7), { mode: 0o600 });
    await chmod(path, 0o666);
    assert.deepEqual(await reasons(), ['config_writable_by_others']);
    await rm(path);
    await writeFile(join(dir, 'real.json'), '{}', { mode: 0o600 });
    await symlink(join(dir, 'real.json'), path);
    assert.deepEqual(await reasons(), ['config_not_regular_file']);
  }
  // 不正な UTF-8 は読めない。
  await rm(path, { force: true });
  await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]), { mode: 0o600 });
  assert.deepEqual(await reasons(), ['config_unreadable']);
});

test('置き場所の検査: ディレクトリで書ける場所は使え、データディレクトリの中・ファイル・存在しない場所は使えない', async (t) => {
  const base = await temp(t);
  const data = join(base, 'data');
  const good = join(base, 'backups');
  await mkdir(data);
  await mkdir(good);
  assert.deepEqual(await checkBackupLocation(good, data), {
    schema: 'buddy.backup-location-check.v1',
    directory: good,
    usable: true,
    problems: [],
    warnings: [],
    sync_provider_hint: null,
  });
  const inside = join(data, 'nested');
  await mkdir(inside);
  assert.deepEqual((await checkBackupLocation(data, data)).problems, [
    'is_data_directory',
  ]);
  assert.deepEqual((await checkBackupLocation(inside, data)).problems, [
    'is_data_directory',
  ]);
  // データディレクトリを含む上位のディレクトリは使える。
  assert.equal((await checkBackupLocation(base, data)).usable, true);
  await writeFile(join(base, 'file'), 'x');
  assert.deepEqual(
    (await checkBackupLocation(join(base, 'file'), data)).problems,
    ['not_a_directory'],
  );
  assert.deepEqual(
    (await checkBackupLocation(join(base, 'absent'), data)).problems,
    ['not_a_directory'],
  );
  // 同期フォルダーは使えるが警告する。
  const synced = join(base, 'Dropbox', 'buddy');
  await mkdir(synced, { recursive: true });
  const warned = await checkBackupLocation(synced, data);
  assert.equal(warned.usable, true);
  assert.deepEqual(warned.warnings, ['sync_folder_detected']);
  assert.equal(warned.sync_provider_hint, 'dropbox');
  if (POSIX && process.getuid?.() !== 0) {
    const readonly = join(base, 'readonly');
    await mkdir(readonly);
    await chmod(readonly, 0o500);
    try {
      assert.deepEqual((await checkBackupLocation(readonly, data)).problems, [
        'not_writable',
      ]);
    } finally {
      await chmod(readonly, 0o700);
    }
  }
});
