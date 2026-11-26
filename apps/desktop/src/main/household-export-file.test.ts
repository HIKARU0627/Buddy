// 家計の記録の CSV を本人が選んだ場所へ書く処理（ADR 0172）の試験。ファイルシステムは模擬で、書いた先・権限・失敗の後始末を
// 手で確かめる。実機の保存先の選択・実ディスクは未実施。
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeHouseholdExportFile } from './household-export-file.js';
import type { HouseholdExportFileSystem } from './household-export-file.js';

test('writes only the chosen path, as UTF-8, owner-only, and nothing else', async () => {
  const calls: string[] = [];
  const fileSystem: HouseholdExportFileSystem = {
    writeFile: (path, text, options) => {
      calls.push(
        `write ${path} ${text} ${options.encoding} ${options.mode.toString(8)} ${options.flag}`,
      );
      return Promise.resolve();
    },
    rm: (path) => {
      calls.push(`rm ${path}`);
      return Promise.resolve();
    },
  };
  assert.equal(
    await writeHouseholdExportFile(
      '/chosen/家計.csv',
      '\uFEFFa,b\r\n',
      fileSystem,
    ),
    'saved',
  );
  assert.deepEqual(calls, ['write /chosen/家計.csv \uFEFFa,b\r\n utf8 600 w']);
});

test('a write failure removes the partial file and reports failure; a failed removal is still a failure', async () => {
  const calls: string[] = [];
  const failing: HouseholdExportFileSystem = {
    writeFile: (path) => {
      calls.push(`write ${path}`);
      return Promise.reject(new Error('ENOSPC'));
    },
    rm: (path, options) => {
      calls.push(`rm ${path} force=${String(options.force)}`);
      return Promise.resolve();
    },
  };
  assert.equal(
    await writeHouseholdExportFile('/chosen/a.csv', 'x', failing),
    'failed',
  );
  assert.deepEqual(calls, [
    'write /chosen/a.csv',
    'rm /chosen/a.csv force=true',
  ]);
  const stuck: HouseholdExportFileSystem = {
    writeFile: () => Promise.reject(new Error('EIO')),
    rm: () => Promise.reject(new Error('EBUSY')),
  };
  assert.equal(
    await writeHouseholdExportFile('/chosen/b.csv', 'x', stuck),
    'failed',
  );
});

test('with the real file system: the bytes start with the BOM, no temporary file is left, a bad folder fails without leaving a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-export-'));
  try {
    const target = join(dir, 'buddy-household-2030-11.csv');
    const text = '\uFEFF計算対象,日付\r\n1,2030/11/03\r\n';
    assert.equal(
      await writeHouseholdExportFile(target, text, { writeFile, rm }),
      'saved',
    );
    const bytes = await readFile(target);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.toString('utf8'), text);
    assert.deepEqual(await readdir(dir), ['buddy-household-2030-11.csv']);
    if (process.platform !== 'win32')
      assert.equal((await stat(target)).mode & 0o777, 0o600);
    // 存在しないフォルダは書けない（失敗）。何も作らない。
    assert.equal(
      await writeHouseholdExportFile(join(dir, 'missing', 'a.csv'), 'x', {
        writeFile,
        rm,
      }),
      'failed',
    );
    assert.deepEqual(await readdir(dir), ['buddy-household-2030-11.csv']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
