// 復元した DB の差し替えの途中の失敗・停止と、起動の前の復旧（ADR 0054 U113）。
// - 差し替えの各ファイル操作（rename・削除・書き込み・fsync）の境界で、その 1 回だけ失敗する場合と、そこで止まる
//   （その後の操作がすべて失敗する）場合を作り、次の起動の前の復旧の後に、旧 DB・-wal・-shm がそろって元の名前にあるか、
//   新しい DB だけが今の名前にあるかのどちらかになること（DB がない・旧と新が混ざる・退避したファイルが残る、がないこと）。
// - Core の起動は DB を開く前に復旧し、記録が読めない・記録のない退避したファイルがあるときは、DB を作らずに起動を止める。
// 期待値は手で書いた（操作の順と、どの境界からが新しい DB かを表で書いた）。DB の中身は区別できる文字列の模擬のファイル。

import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMockKeyStore } from '@buddy/platform';
import {
  applyRestoreAftermath,
  openWriteConnection,
  storagePlatform,
} from '@buddy/storage';
import { onCleanup } from './api-test-support.js';
import { CoreStartError, startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { DB_FILE, LOCK_FILE, controlEndpoint } from './paths.js';
import {
  RESTORE_INSTALL_JOURNAL,
  RestoreInstallError,
  installRestoredDatabase,
  nodeRestoreInstallFs,
  recoverRestoreInstall,
} from './restore-install.js';
import type { RestoreInstallFs } from './restore-install.js';

const KEY = Buffer.alloc(32, 0x41);
const NEW_GENERATION = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';

async function tempBase(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-install-'));
  onCleanup(t, () =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return base;
}

// 差し替えの成功の手順で呼ばれるファイル操作（手で書いた順。ID は記録・退避の名前の UUID）。
const SUCCESS_OPS = [
  'remove WORKING-wal',
  'remove WORKING-shm',
  'writeDurable .restore-install-ID.tmp',
  `rename .restore-install-ID.tmp ${RESTORE_INSTALL_JOURNAL}`,
  'fsyncDirectory DATA',
  `rename ${DB_FILE} ${DB_FILE}.pre-restore-ID`,
  `rename ${DB_FILE}-wal ${DB_FILE}.pre-restore-ID-wal`,
  `rename ${DB_FILE}-shm ${DB_FILE}.pre-restore-ID-shm`,
  'fsyncDirectory DATA',
  `rename WORKING ${DB_FILE}`,
  'fsyncDirectory DATA',
  'writeDurable .restore-install-ID.tmp',
  `rename .restore-install-ID.tmp ${RESTORE_INSTALL_JOURNAL}`,
  'fsyncDirectory DATA',
  `remove ${DB_FILE}.pre-restore-ID`,
  `remove ${DB_FILE}.pre-restore-ID-wal`,
  `remove ${DB_FILE}.pre-restore-ID-shm`,
  'fsyncDirectory DATA',
  `remove ${RESTORE_INSTALL_JOURNAL}`,
  'fsyncDirectory DATA',
];
// この番号（1 始まり）の操作が済んでいれば、作業用の DB が今の名前にある（rename WORKING → DB）。
const SWAPPED_AT = 10;
// この番号の操作が済んでいれば、installed の記録が永続に書けている（その後の片付けの失敗は成功として返す）。
const INSTALLED_AT = 14;

// 旧 DB の組と、差し替えた後の新しい DB だけの組（ロックのファイルは除く）。
const OLD_FILES = {
  [DB_FILE]: 'old-db',
  [`${DB_FILE}-wal`]: 'old-wal',
  [`${DB_FILE}-shm`]: 'old-shm',
};
const NEW_FILES = { [DB_FILE]: 'new-db' };

interface Fixture {
  readonly dataDir: string;
  readonly working: string;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const base = await tempBase(t);
  const dataDir = join(base, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  for (const [name, text] of Object.entries(OLD_FILES))
    await writeFile(join(dataDir, name), text);
  const working = join(base, 'working.sqlite');
  await writeFile(working, 'new-db');
  await writeFile(`${working}-shm`, 'working-shm');
  return { dataDir, working };
}

async function snapshot(
  f: Fixture,
): Promise<{ files: Record<string, string>; working: string | null }> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(f.dataDir)).sort())
    if (name !== LOCK_FILE)
      files[name] = await readFile(join(f.dataDir, name), 'utf8');
  let working: string | null;
  try {
    working = await readFile(f.working, 'utf8');
  } catch {
    working = null;
  }
  return { files, working };
}

const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu;

// 操作を記録し、mode に応じて failAt 番目（または failAt が真を返した操作）で失敗させる（once: その 1 回だけ。
// crash: それ以降すべて。その場の復旧も失敗し、記録が残る）。
function injectedFs(
  f: Fixture,
  log: string[],
  mode: 'none' | 'once' | 'crash',
  failAt: number | ((log: readonly string[]) => boolean),
): RestoreInstallFs {
  let crashed = false;
  const label = (path: string): string =>
    path === f.dataDir
      ? 'DATA'
      : path.startsWith(f.working)
        ? path.replace(f.working, 'WORKING')
        : path.replace(`${f.dataDir}/`, '').replace(UUID, 'ID');
  const step = (text: string): void => {
    log.push(text);
    const index = log.length;
    const hit = typeof failAt === 'number' ? index === failAt : failAt(log);
    if (mode === 'crash' && hit) crashed = true;
    if ((mode === 'once' && hit) || crashed) {
      const error = new Error(`injected ${mode} at ${index}`) as Error & {
        code: string;
      };
      error.code = 'EIO';
      throw error;
    }
  };
  return {
    async rename(from, to) {
      step(`rename ${label(from)} ${label(to)}`);
      await nodeRestoreInstallFs.rename(from, to);
    },
    async remove(path) {
      step(`remove ${label(path)}`);
      await nodeRestoreInstallFs.remove(path);
    },
    async writeDurable(path, text) {
      step(`writeDurable ${label(path)}`);
      await nodeRestoreInstallFs.writeDurable(path, text);
    },
    async fsyncDirectory(dir) {
      step(`fsyncDirectory ${label(dir)}`);
      await nodeRestoreInstallFs.fsyncDirectory(dir);
    },
  };
}

const install = (f: Fixture, fs?: RestoreInstallFs) =>
  installRestoredDatabase({
    dataDir: f.dataDir,
    workingPath: f.working,
    endpoint: controlEndpoint(f.dataDir, process.platform),
    probeTimeoutMs: 300,
    ...(fs === undefined ? {} : { fs }),
  });

test('restore install: the file operations run in the recorded order and leave only the new DB', async (t) => {
  const f = await fixture(t);
  const log: string[] = [];
  await install(f, injectedFs(f, log, 'none', 0));
  assert.deepEqual(log, SUCCESS_OPS);
  assert.deepEqual(await snapshot(f), { files: NEW_FILES, working: null });
});

for (const mode of ['once', 'crash'] as const)
  test(`restore install: a ${mode === 'once' ? 'failure' : 'stop'} at each file operation ends as the old DB or the new DB after recovery`, async (t) => {
    for (let failAt = 1; failAt <= SUCCESS_OPS.length; failAt += 1) {
      const f = await fixture(t);
      const log: string[] = [];
      const done = await install(f, injectedFs(f, log, mode, failAt)).then(
        () => true,
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'EIO', String(error));
          return false;
        },
      );
      const swapped = failAt > SWAPPED_AT;
      // 1 回だけの失敗は、その場の復旧で終えるか戻す。差し替えを終えたときだけ成功として返す。止まったとき（その場の
      // 復旧も失敗する）は、installed の記録を書いた後の片付けの中だけが成功になる。
      if (mode === 'once') assert.equal(done, swapped, `once ${failAt}`);
      else assert.equal(done, failAt > INSTALLED_AT, `crash ${failAt}`);
      // 次の起動の前の復旧（本物のファイル操作）。
      const recovered = await recoverRestoreInstall(f.dataDir);
      const after = await snapshot(f);
      assert.deepEqual(
        after,
        swapped
          ? { files: NEW_FILES, working: null }
          : { files: OLD_FILES, working: 'new-db' },
        `${mode} at ${failAt} (${SUCCESS_OPS[failAt - 1]}): ${recovered}`,
      );
      // 復旧は何度呼んでも同じ（2 回目は何もしない）。
      assert.equal(await recoverRestoreInstall(f.dataDir), 'none');
    }
  });

test('restore install: an interrupted install is recovered before the next install', async (t) => {
  const f = await fixture(t);
  // 旧 DB と -wal を退避した後に止まる（-shm はまだ今の名前）。
  await assert.rejects(install(f, injectedFs(f, [], 'crash', 8)));
  const names = Object.keys((await snapshot(f)).files);
  assert.ok(names.includes(RESTORE_INSTALL_JOURNAL));
  assert.ok(!names.includes(DB_FILE));
  // 次の差し替えは、前の差し替えを戻してからやり直す。
  await install(f);
  assert.deepEqual(await snapshot(f), { files: NEW_FILES, working: null });
});

test('restore recovery refuses an unreadable journal or set-aside files without a journal, and moves nothing', async (t) => {
  const f = await fixture(t);
  await assert.rejects(install(f, injectedFs(f, [], 'crash', 8)));
  await writeFile(join(f.dataDir, RESTORE_INSTALL_JOURNAL), '{"schema":');
  const before = await snapshot(f);
  await assert.rejects(
    recoverRestoreInstall(f.dataDir),
    (error: unknown) =>
      error instanceof RestoreInstallError &&
      error.reason === 'restore_install_journal_invalid',
  );
  assert.deepEqual(await snapshot(f), before);
  // 記録を消した（または記録を書く前の手順で止まった差し替えの残り）: 退避したファイルだけがある。
  await rm(join(f.dataDir, RESTORE_INSTALL_JOURNAL));
  const orphaned = await snapshot(f);
  await assert.rejects(
    recoverRestoreInstall(f.dataDir),
    (error: unknown) =>
      error instanceof RestoreInstallError &&
      error.reason === 'restore_install_orphaned',
  );
  assert.deepEqual(await snapshot(f), orphaned);
});

// --- Core の起動 ---

// 実際の DB は -wal・-shm の有無で操作の数が変わるので、止める位置は操作の名前で決める。
const SWAP = `rename WORKING ${DB_FILE}`;
const BEFORE_SWAP = (log: readonly string[]): boolean => log.at(-1) === SWAP;
const AFTER_SWAP = (log: readonly string[]): boolean =>
  log.slice(0, -1).includes(SWAP);

async function start(
  t: test.TestContext,
  dataDir: string,
): Promise<CoreHandle> {
  const handle = await startCore({
    dataDir,
    keyStore: createMockKeyStore({ stored: KEY.toString('base64') }),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
  });
  onCleanup(t, async () => {
    await handle.stop('test').catch(() => undefined);
  });
  return handle;
}

async function refusal(run: Promise<CoreHandle>): Promise<readonly string[]> {
  let handle: CoreHandle;
  try {
    handle = await run;
  } catch (error) {
    assert(error instanceof CoreStartError, String(error));
    assert.equal(error.code, 'store_recovery_failed');
    return error.reasons;
  }
  await handle.stop('test').catch(() => undefined);
  assert.fail('起動が拒否されませんでした');
}

// 動いた Core の DB の写しに復元の後の保留を書いた作業用の DB（新しい DB の世代）を作る。
async function realFixture(
  t: test.TestContext,
): Promise<Fixture & { readonly before: string }> {
  const base = await tempBase(t);
  const dataDir = join(base, 'data');
  const core = await start(t, dataDir);
  const before = core.storeGeneration;
  await core.stop('test');
  const working = join(base, 'restore-working.sqlite');
  await copyFile(join(dataDir, DB_FILE), working);
  const db = openWriteConnection(working, { platform: storagePlatform() });
  try {
    applyRestoreAftermath(db, {
      restored_at: Date.parse('2031-03-01T00:00:00.000Z'),
      backup_created_at: Date.parse('2031-02-28T00:00:00.000Z'),
      new_store_generation: NEW_GENERATION,
      pre_restore: null,
    });
  } finally {
    db.close();
  }
  return { dataDir, working, before };
}

test('Core start rolls back an install stopped before the swap, and completes one stopped after it', async (t) => {
  const early = await realFixture(t);
  // 旧 DB を退避した後・作業用の DB を移す前に止まる。DB がないからと新しい DB を作らず、旧 DB に戻して起動する。
  await assert.rejects(
    install(early, injectedFs(early, [], 'crash', BEFORE_SWAP)),
  );
  const rolledBack = await start(t, early.dataDir);
  assert.equal(rolledBack.storeGeneration, early.before);
  await rolledBack.stop('test');
  assert.equal(
    (await readdir(early.dataDir)).some(
      (name) =>
        name.includes('.pre-restore-') || name === RESTORE_INSTALL_JOURNAL,
    ),
    false,
  );

  const late = await realFixture(t);
  // 作業用の DB を今の名前へ移した後、ディレクトリの fsync の前に止まる。差し替えを終えて新しい DB で起動する。
  await assert.rejects(
    install(late, injectedFs(late, [], 'crash', AFTER_SWAP)),
  );
  const completed = await start(t, late.dataDir);
  assert.equal(completed.storeGeneration, NEW_GENERATION);
  await completed.stop('test');
});

test('Core start refuses an unreadable install journal or orphaned set-aside files without creating a DB', async (t) => {
  const f = await realFixture(t);
  await assert.rejects(install(f, injectedFs(f, [], 'crash', BEFORE_SWAP)));
  await writeFile(join(f.dataDir, RESTORE_INSTALL_JOURNAL), 'not json');
  assert.deepEqual(await refusal(start(t, f.dataDir)), [
    'restore_install',
    'restore_install_journal_invalid',
  ]);
  assert.equal((await readdir(f.dataDir)).includes(DB_FILE), false);
  await rm(join(f.dataDir, RESTORE_INSTALL_JOURNAL));
  assert.deepEqual(await refusal(start(t, f.dataDir)), [
    'restore_install',
    'restore_install_orphaned',
  ]);
  assert.equal((await readdir(f.dataDir)).includes(DB_FILE), false);
});
