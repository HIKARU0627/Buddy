// 復元した DB の差し替え（設計 03 バックアップ・復元、ADR 0040・0047・0054）。
//
// 復元の後の保留（承認の失効・隔離の印・端末の失効・安全停止など）は、差し替える前の作業用の DB に 1 つの transaction で
// 書いておく（@buddy/storage の applyRestoreAftermath）。ここは、その DB を今の DB と入れ替える手順だけを持つ。
// - Core が止まっていることを、Core のロックを取って確かめてから差し替える（Core が動いていれば拒否する）。差し替えの
//   後の最初の起動で、Core のメモリーの上の状態（WebSocket の接続・音声と表示のリース・端末の世代・イベントの購読）は
//   すべて作り直される（ADR 0047 の P3-5。動いている Core の DB だけを入れ替えて、古い接続を残すことをしない）。
// - 作業用の DB は閉じて -wal を残していないこと（書いた内容が本体のファイルに入っていること）。
// - 切替の記録（restore-install.json）を先に永続に書いてから、今の DB（と -wal・-shm）を退避し、作業用の DB を今の名前へ
//   rename する。差し替えを終えたら記録を installed にし、退避したファイルを消してから記録を消す（忘却・期限を当てる前の
//   古い中身を残さない。SSD の痕跡までは保証しない）。
// - 途中で失敗・停止しても、記録があれば次の Core の起動（DB を開く前）と次の差し替えの前に recoverRestoreInstall が
//   差し替えを終えるか、退避した旧 DB・-wal・-shm を元の名前へ戻す（ADR 0054 U113）。記録が読めない・ファイルの組が
//   どの段階とも合わないときは何も動かさずに拒否し、DB がないからと新しい DB を作って起動することをしない。

import { randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { acquireLock, defaultIsPidAlive, releaseLock } from './lock.js';
import { DB_FILE } from './paths.js';

// 切替の記録（データディレクトリの中）。
export const RESTORE_INSTALL_JOURNAL = 'restore-install.json';
const JOURNAL_SCHEMA = 'buddy.restore-install.v1';
const JOURNAL_TEMP_PREFIX = '.restore-install-';
const JOURNAL_TEMP_SUFFIX = '.tmp';
const ASIDE_MARK = '.pre-restore-';
const SUFFIXES = ['', '-wal', '-shm'] as const;
type Suffix = (typeof SUFFIXES)[number];

export type RestoreInstallRefusal =
  // 作業用の DB がない。
  | 'working_db_missing'
  // 作業用の DB の -wal が残っている（閉じていない・checkpoint していない）。
  | 'working_db_not_closed'
  // 切替の記録が読めない・形が違う。
  | 'restore_install_journal_invalid'
  // 記録の段階とファイルの組が合わない（旧 DB と新しい DB のどちらとも決められない）。
  | 'restore_install_inconsistent'
  // 記録がないのに退避したファイルがある（記録を書く前の手順で止まった差し替えの残り・記録が消された）。
  | 'restore_install_orphaned';

export class RestoreInstallError extends Error {
  readonly reason: RestoreInstallRefusal;
  constructor(reason: RestoreInstallRefusal) {
    super(`復元した DB を差し替えられません（${reason}）。`);
    this.name = 'RestoreInstallError';
    this.reason = reason;
  }
}

// ファイルの操作。試験は各操作の境界で失敗・停止を差し込む。
export interface RestoreInstallFs {
  rename(from: string, to: string): Promise<void>;
  // ないファイルは無視する。
  remove(path: string): Promise<void>;
  // 書いて fsync する（新しいファイル）。
  writeDurable(path: string, text: string): Promise<void>;
  fsyncDirectory(dir: string): Promise<void>;
}

export const nodeRestoreInstallFs: RestoreInstallFs = {
  rename,
  remove: (path) => rm(path, { force: true }),
  async writeDurable(path, text) {
    await writeFile(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const handle = await open(path, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async fsyncDirectory(dir) {
    // Windows では Node.js の fs.open でディレクトリを開けず、ディレクトリの fsync ができない（ファイルの rename の
    // 永続は NTFS のメタデータのジャーナルに任せる。電源断の直前の rename が残るかは保証しない）。初期の中枢は
    // Mac mini（設計 08）なので、Windows で中枢を動かすときの耐久は実機の試験（B15）で確かめる（ADR 0054）。
    if (process.platform === 'win32') return;
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

export interface InstallRestoredDatabaseOptions {
  readonly dataDir: string;
  // 復元の後の保留まで書いて閉じた作業用の DB（データディレクトリと同じファイルシステムに置く。絶対パス）。
  readonly workingPath: string;
  // Core の制御チャネル（動いている Core があるかを確かめる）。
  readonly endpoint: string;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly probeTimeoutMs?: number;
  readonly removeStaleEndpoint?: () => Promise<void>;
  readonly now?: () => Date;
  readonly fs?: RestoreInstallFs;
}

interface Journal {
  readonly schema: typeof JOURNAL_SCHEMA;
  // swapping: 退避と差し替えの途中。installed: 差し替えを終え、退避したファイルを消す途中。
  readonly phase: 'swapping' | 'installed';
  readonly install_id: string;
  readonly working_path: string;
  // 差し替えの前にあった今の DB のファイル（本体・-wal・-shm）。
  readonly live_files: readonly Suffix[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function size(path: string): Promise<number | null> {
  try {
    return (await lstat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function parseJournal(text: string): Journal | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !==
    'install_id,live_files,phase,schema,working_path'
  )
    return null;
  const files = item['live_files'];
  if (
    item['schema'] !== JOURNAL_SCHEMA ||
    (item['phase'] !== 'swapping' && item['phase'] !== 'installed') ||
    typeof item['install_id'] !== 'string' ||
    !UUID_V4.test(item['install_id']) ||
    typeof item['working_path'] !== 'string' ||
    !isAbsolute(item['working_path']) ||
    !Array.isArray(files) ||
    new Set(files).size !== files.length ||
    !files.every((suffix) => (SUFFIXES as readonly unknown[]).includes(suffix))
  )
    return null;
  return item as unknown as Journal;
}

// 記録を一時ファイルに書いて fsync し、rename で置き換えてからディレクトリを fsync する（記録は前の版か新しい版のどちらか）。
async function writeJournal(
  fs: RestoreInstallFs,
  dataDir: string,
  journal: Journal,
): Promise<void> {
  const temp = join(
    dataDir,
    `${JOURNAL_TEMP_PREFIX}${randomUUID()}${JOURNAL_TEMP_SUFFIX}`,
  );
  await fs.writeDurable(temp, `${JSON.stringify(journal)}\n`);
  await fs.rename(temp, join(dataDir, RESTORE_INSTALL_JOURNAL));
  await fs.fsyncDirectory(dataDir);
}

async function removeJournalTemps(
  fs: RestoreInstallFs,
  dataDir: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names)
    if (
      name.startsWith(JOURNAL_TEMP_PREFIX) &&
      name.endsWith(JOURNAL_TEMP_SUFFIX)
    )
      await fs.remove(join(dataDir, name));
}

export type RestoreInstallRecovery =
  // 記録がなかった。
  | 'none'
  // 差し替えを終えた（新しい DB が今の DB）。
  | 'completed'
  // 差し替えの前へ戻した（旧 DB・-wal・-shm を元の名前へ。作業用の DB は残す）。
  | 'rolled_back';

// 作業用の DB を別のディレクトリから移したときは、移した元のディレクトリも fsync する（移した元に名前が残らないこと）。
async function fsyncWorkingDirectory(
  fs: RestoreInstallFs,
  dataDir: string,
  workingPath: string,
): Promise<void> {
  const workingDir = dirname(workingPath);
  if (workingDir !== dataDir) await fs.fsyncDirectory(workingDir);
}

// 途中で止まった差し替えを終えるか、元へ戻す。Core のロックを持った状態で、DB を開く前に呼ぶ。復旧の途中で止まっても、
// もう一度呼べば続きから進む（記録は退避したファイルを消す前に installed にする。戻すときは 1 つずつ元の名前へ戻す）。
export async function recoverRestoreInstall(
  dataDir: string,
  fs: RestoreInstallFs = nodeRestoreInstallFs,
): Promise<RestoreInstallRecovery> {
  const live = join(dataDir, DB_FILE);
  let names: string[];
  try {
    names = await readdir(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
  const journalPath = join(dataDir, RESTORE_INSTALL_JOURNAL);
  let text: string | null;
  try {
    text = await readFile(journalPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = null;
  }
  if (text === null) {
    // 記録を書く前の一時ファイルは、まだ何も動かしていない（記録の rename の前に止まった）。
    await removeJournalTemps(fs, dataDir, names);
    if (names.some((name) => name.startsWith(`${DB_FILE}${ASIDE_MARK}`)))
      throw new RestoreInstallError('restore_install_orphaned');
    return 'none';
  }
  const journal = parseJournal(text);
  if (journal === null)
    throw new RestoreInstallError('restore_install_journal_invalid');
  const aside = `${live}${ASIDE_MARK}${journal.install_id}`;
  const finish = async (): Promise<void> => {
    await fs.fsyncDirectory(dataDir);
    await fs.remove(journalPath);
    await fs.fsyncDirectory(dataDir);
    await removeJournalTemps(fs, dataDir, names);
  };
  // 差し替えを終えた側: 新しい DB が今の名前にあり、旧 DB の -wal・-shm が今の名前に残っていないこと。
  // swapping からは、旧 DB のファイルがすべて退避済みであること（作業用の DB の rename は退避と fsync の後）。
  const rollForward = async (
    swapping: boolean,
  ): Promise<RestoreInstallRecovery> => {
    if (!(await exists(live)))
      throw new RestoreInstallError('restore_install_inconsistent');
    if (swapping)
      for (const suffix of journal.live_files)
        if (!(await exists(`${aside}${suffix}`)))
          throw new RestoreInstallError('restore_install_inconsistent');
    for (const suffix of ['-wal', '-shm'] as const)
      if (
        journal.live_files.includes(suffix) &&
        (await exists(`${live}${suffix}`))
      )
        throw new RestoreInstallError('restore_install_inconsistent');
    if (swapping) {
      // 退避したファイルを消す前に、新しい DB の置き場所を永続にして installed を記録する（消している途中で止まっても、
      // 次の復旧は installed として続きから消せる。退避したファイルが欠けた swapping の記録を残さない）。
      await fs.fsyncDirectory(dataDir);
      await fsyncWorkingDirectory(fs, dataDir, journal.working_path);
      await writeJournal(fs, dataDir, { ...journal, phase: 'installed' });
    }
    for (const suffix of SUFFIXES) await fs.remove(`${aside}${suffix}`);
    await finish();
    return 'completed';
  };
  if (journal.phase === 'installed') return rollForward(false);
  // swapping: 作業用の DB が残っていれば、まだ今の名前へ移していない（rename は 1 つの操作で、両方にはならない）。
  if (!(await exists(journal.working_path))) return rollForward(true);
  // 元へ戻す。退避したファイルを元の名前へ。まだ退避していないファイルは元の名前にあること。
  const moves: Suffix[] = [];
  for (const suffix of journal.live_files) {
    const moved = await exists(`${aside}${suffix}`);
    const present = await exists(`${live}${suffix}`);
    if (moved === present)
      throw new RestoreInstallError('restore_install_inconsistent');
    if (moved) moves.push(suffix);
  }
  for (const suffix of moves)
    await fs.rename(`${aside}${suffix}`, `${live}${suffix}`);
  await finish();
  return 'rolled_back';
}

// Core が止まっている間に、作業用の DB を今の DB と入れ替える。Core が動いていれば LockError を投げる。
export async function installRestoredDatabase(
  options: InstallRestoredDatabaseOptions,
): Promise<void> {
  const fs = options.fs ?? nodeRestoreInstallFs;
  const coreInstanceId = randomUUID();
  await acquireLock({
    dataDir: options.dataDir,
    endpoint: options.endpoint,
    record: {
      pid: process.pid,
      core_instance_id: coreInstanceId,
      started_at: (options.now?.() ?? new Date()).toISOString(),
    },
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    probeTimeoutMs: options.probeTimeoutMs ?? 1000,
    removeStaleEndpoint: options.removeStaleEndpoint ?? (async () => undefined),
  });
  try {
    // 前の差し替えが途中で止まっていれば、先に終えるか戻す（記録を 2 つ重ねない）。
    await recoverRestoreInstall(options.dataDir, fs);
    if (!isAbsolute(options.workingPath))
      throw new RestoreInstallError('working_db_missing');
    if ((await size(options.workingPath)) === null)
      throw new RestoreInstallError('working_db_missing');
    if (((await size(`${options.workingPath}-wal`)) ?? 0) > 0)
      throw new RestoreInstallError('working_db_not_closed');
    const live = join(options.dataDir, DB_FILE);
    const liveFiles: Suffix[] = [];
    for (const suffix of SUFFIXES)
      if (await exists(`${live}${suffix}`)) liveFiles.push(suffix);
    // 作業用の DB の空の -wal と -shm（作り直せる）は、記録の前に消す。
    await fs.remove(`${options.workingPath}-wal`);
    await fs.remove(`${options.workingPath}-shm`);
    const journal: Journal = {
      schema: JOURNAL_SCHEMA,
      phase: 'swapping',
      install_id: coreInstanceId,
      working_path: options.workingPath,
      live_files: liveFiles,
    };
    const aside = `${live}${ASIDE_MARK}${coreInstanceId}`;
    try {
      await writeJournal(fs, options.dataDir, journal);
      for (const suffix of liveFiles)
        await fs.rename(`${live}${suffix}`, `${aside}${suffix}`);
      await fs.fsyncDirectory(options.dataDir);
      await fs.rename(options.workingPath, live);
      await fs.fsyncDirectory(options.dataDir);
      await fsyncWorkingDirectory(fs, options.dataDir, options.workingPath);
      await writeJournal(fs, options.dataDir, {
        ...journal,
        phase: 'installed',
      });
    } catch (error) {
      // 例外のときはその場で終えるか戻す。差し替えを終えられたら成功として返す（作業用の DB はもうない）。戻したとき・
      // それも失敗したときは投げる。失敗なら記録が残り、次の起動・差し替えの前に同じ手順で扱う。
      const recovered = await recoverRestoreInstall(options.dataDir, fs).catch(
        () => null,
      );
      if (recovered !== 'completed') throw error;
      return;
    }
    // installed の記録を永続に書いた後は、差し替えは確定している。退避したファイルと記録の片付けに失敗しても成功として
    // 返し、残りは次の起動・差し替えの前の復旧が消す。
    try {
      for (const suffix of liveFiles) await fs.remove(`${aside}${suffix}`);
      await fs.fsyncDirectory(options.dataDir);
      await fs.remove(join(options.dataDir, RESTORE_INSTALL_JOURNAL));
      await fs.fsyncDirectory(options.dataDir);
    } catch {
      await recoverRestoreInstall(options.dataDir, fs).catch(() => undefined);
    }
  } finally {
    await releaseLock(options.dataDir, coreInstanceId);
  }
}
