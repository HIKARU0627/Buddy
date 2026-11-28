// Windows のデータディレクトリの場所の検査と、旧い既定の場所の知らせ（ADR 0202、U700・U705）。
// 判定の関数は実パスの解決を差し替えて、どの OS でも Windows のパスで試験する。
// 末尾の 2 件だけは Windows（CI の windows-latest）で本物のジャンクションとプロファイルの外のパスを使う。
// 期待値は手書き。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DataDirError,
  prepareDataDir,
  realpathOfPlanned,
  windowsDataDirLocationReason,
} from './data-dir.js';
import { LEGACY_DATA_DIR_PRESENT, legacyDataDirNotice } from './paths.js';

const PROFILE = {
  LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\example',
};

// 実パスの解決の模擬。ジャンクションの先を表で返し、表に無いものはそのまま（大文字・小文字は実パスで変わり得る）。
function fakeRealpath(links: Record<string, string> = {}) {
  return (path: string) => Promise.resolve(links[path] ?? path);
}

test('Windows のデータディレクトリ: %LOCALAPPDATA% か %USERPROFILE% の下だけを受け入れる', async () => {
  const real = fakeRealpath();
  for (const dir of [
    'C:\\Users\\example\\AppData\\Local\\Buddy\\core',
    'C:\\Users\\example\\Documents\\Buddy',
    // 大文字・小文字の違いは同じ場所（Windows のパスは区別しない）。
    'c:\\users\\EXAMPLE\\appdata\\local\\buddy\\core',
  ])
    assert.equal(await windowsDataDirLocationReason(dir, PROFILE, real), null);
  for (const dir of [
    'C:\\BuddyData',
    'D:\\Users\\example\\AppData\\Local\\Buddy',
    // プロファイルそのものは使わない（下に作る）。
    'C:\\Users\\example',
    // 名前の前方一致だけで判定しない。
    'C:\\Users\\example-other\\Buddy',
    'C:\\Users\\example\\..\\other\\Buddy',
    '\\\\server\\share\\Buddy',
  ])
    assert.equal(
      await windowsDataDirLocationReason(dir, PROFILE, real),
      'data_dir_outside_user_profile',
      dir,
    );
});

test('Windows のデータディレクトリ: 実パス（ジャンクションの先）で判定し、プロファイルが分からなければ断る', async () => {
  // プロファイルの側がジャンクションでも、実パスどうしで比べる。
  const linked = fakeRealpath({
    'C:\\Users\\example\\AppData\\Local': 'E:\\Profiles\\example\\Local',
  });
  assert.equal(
    await windowsDataDirLocationReason(
      'E:\\Profiles\\example\\Local\\Buddy\\core',
      PROFILE,
      linked,
    ),
    null,
  );
  // LOCALAPPDATA・USERPROFILE が無い・ドライブ文字の絶対パスでない・実パスを求められない。
  for (const env of [
    {},
    { LOCALAPPDATA: 'relative\\Local' },
    { USERPROFILE: '\\\\server\\share\\example' },
  ])
    assert.equal(
      await windowsDataDirLocationReason(
        'C:\\Users\\example\\AppData\\Local\\Buddy\\core',
        env,
        fakeRealpath(),
      ),
      'data_dir_profile_unknown',
    );
  assert.equal(
    await windowsDataDirLocationReason(
      'C:\\Users\\example\\AppData\\Local\\Buddy\\core',
      PROFILE,
      () => Promise.reject(new Error('ENOENT')),
    ),
    'data_dir_profile_unknown',
  );
});

test(
  'まだ無いデータディレクトリの実パス: 有る祖先までを実パスにして残りをつなぐ',
  { skip: process.platform === 'win32' },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'buddy-planned-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const real = await realpath(base);
    await mkdir(join(real, 'target'));
    await symlink(join(real, 'target'), join(real, 'link'));
    assert.equal(
      await realpathOfPlanned(join(base, 'link', 'a', 'b'), realpath),
      join(real, 'target', 'a', 'b'),
    );
    assert.equal(await realpathOfPlanned(base, realpath), real);
  },
);

test('旧い既定のデータディレクトリ（%APPDATA%\\Buddy\\core）があり新しい既定が無いときだけ知らせる', () => {
  const env = {
    APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
  };
  const legacy = 'C:\\Users\\example\\AppData\\Roaming\\Buddy\\core';
  const current = 'C:\\Users\\example\\AppData\\Local\\Buddy\\core';
  const notice = (
    existing: string[],
    extra: Partial<Parameters<typeof legacyDataDirNotice>[0]> = {},
  ) =>
    legacyDataDirNotice({
      platform: 'win32',
      env,
      homedir: 'C:\\Users\\example',
      dataDirGiven: false,
      exists: (path) => existing.includes(path),
      ...extra,
    });
  assert.equal(notice([legacy]), LEGACY_DATA_DIR_PRESENT);
  assert.equal(notice([legacy, current]), null);
  assert.equal(notice([]), null);
  assert.equal(notice([current]), null);
  // --data-dir を指定した起動・Windows 以外では知らせない。
  assert.equal(notice([legacy], { dataDirGiven: true }), null);
  assert.equal(notice([legacy], { platform: 'darwin' }), null);
  // APPDATA が無ければホームの下の Roaming を旧い場所とする。
  assert.equal(
    legacyDataDirNotice({
      platform: 'win32',
      env: {},
      homedir: 'C:\\Users\\example',
      dataDirGiven: false,
      exists: (path) => path === legacy,
    }),
    LEGACY_DATA_DIR_PRESENT,
  );
});

test(
  'Windows の実機: プロファイルの外のデータディレクトリは作らずに断り、外を指すジャンクションも断る',
  // 本物のジャンクションと %SystemDrive% のパスは Windows だけにある。他の OS では上の模擬の試験で形を確かめる。
  { skip: process.platform !== 'win32' && 'Windows だけで動く試験' },
  async (t) => {
    const drive = process.env['SystemDrive'] ?? 'C:';
    const outside = `${drive}\\buddy-test-outside-${randomUUID()}`;
    await assert.rejects(
      prepareDataDir(join(outside, 'core')),
      (error: unknown) =>
        error instanceof DataDirError &&
        error.reason === 'data_dir_outside_user_profile',
    );
    // 断る前に作らない。
    assert.equal(existsSync(outside), false);

    // 一時ディレクトリ（%LOCALAPPDATA%\Temp の下）は受け入れる。
    const base = await mkdtemp(join(tmpdir(), 'buddy-junction-'));
    t.after(() =>
      rm(base, { recursive: true, force: true, maxRetries: 5 }).catch(
        () => undefined,
      ),
    );
    assert.equal(
      (await prepareDataDir(join(base, 'inside'))).toLowerCase(),
      (await realpath(join(base, 'inside'))).toLowerCase(),
    );
    // プロファイルの外（%SystemRoot%）を指すジャンクションの下は、実パスで判定して断る（作らない）。
    const systemRoot = process.env['SystemRoot'] ?? `${drive}\\Windows`;
    const junction = join(base, 'junction');
    await symlink(systemRoot, junction, 'junction');
    const planned = join(junction, `buddy-test-${randomUUID()}`);
    await assert.rejects(
      prepareDataDir(planned),
      (error: unknown) =>
        error instanceof DataDirError &&
        error.reason === 'data_dir_outside_user_profile',
    );
    assert.equal(existsSync(planned), false);
  },
);
