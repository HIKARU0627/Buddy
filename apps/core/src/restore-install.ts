// 復元した DB の差し替え（設計 03 バックアップ・復元、ADR 0040・0047・0054）。
//
// 復元の後の保留（承認の失効・隔離の印・端末の失効・安全停止など）は、差し替える前の作業用の DB に 1 つの transaction で
// 書いておく（@buddy/storage の applyRestoreAftermath）。ここは、その DB を今の DB と入れ替える手順だけを持つ。
// - Core が止まっていることを、Core のロックを取って確かめてから差し替える（Core が動いていれば拒否する）。差し替えの
//   後の最初の起動で、Core のメモリーの上の状態（WebSocket の接続・音声と表示のリース・端末の世代・イベントの購読）は
//   すべて作り直される（ADR 0047 の P3-5。動いている Core の DB だけを入れ替えて、古い接続を残すことをしない）。
// - 作業用の DB は閉じて -wal を残していないこと（書いた内容が本体のファイルに入っていること）。
// - 今の DB（と -wal・-shm）を退避してから作業用の DB を今の名前へ rename し、ディレクトリを fsync した後に退避した
//   ファイルを消す（忘却・期限を当てる前の古い中身を残さない。SSD の痕跡までは保証しない）。

import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock, defaultIsPidAlive, releaseLock } from './lock.js';
import { DB_FILE } from './paths.js';

export type RestoreInstallRefusal =
  // 作業用の DB がない。
  | 'working_db_missing'
  // 作業用の DB の -wal が残っている（閉じていない・checkpoint していない）。
  | 'working_db_not_closed';

export class RestoreInstallError extends Error {
  readonly reason: RestoreInstallRefusal;
  constructor(reason: RestoreInstallRefusal) {
    super(`復元した DB を差し替えられません（${reason}）。`);
    this.name = 'RestoreInstallError';
    this.reason = reason;
  }
}

export interface InstallRestoredDatabaseOptions {
  readonly dataDir: string;
  // 復元の後の保留まで書いて閉じた作業用の DB（データディレクトリと同じファイルシステムに置く）。
  readonly workingPath: string;
  // Core の制御チャネル（動いている Core があるかを確かめる）。
  readonly endpoint: string;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly probeTimeoutMs?: number;
  readonly removeStaleEndpoint?: () => Promise<void>;
  readonly now?: () => Date;
}

async function size(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function fsyncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Core が止まっている間に、作業用の DB を今の DB と入れ替える。Core が動いていれば LockError を投げる。
export async function installRestoredDatabase(
  options: InstallRestoredDatabaseOptions,
): Promise<void> {
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
    if ((await size(options.workingPath)) === null)
      throw new RestoreInstallError('working_db_missing');
    if (((await size(`${options.workingPath}-wal`)) ?? 0) > 0)
      throw new RestoreInstallError('working_db_not_closed');
    const live = join(options.dataDir, DB_FILE);
    const aside = `${live}.pre-restore-${coreInstanceId}`;
    const suffixes = ['', '-wal', '-shm'];
    for (const suffix of suffixes)
      if ((await size(`${live}${suffix}`)) !== null)
        await rename(`${live}${suffix}`, `${aside}${suffix}`);
    await rm(`${options.workingPath}-wal`, { force: true });
    await rm(`${options.workingPath}-shm`, { force: true });
    await rename(options.workingPath, live);
    await fsyncDirectory(options.dataDir);
    for (const suffix of suffixes)
      await rm(`${aside}${suffix}`, { force: true });
  } finally {
    await releaseLock(options.dataDir, coreInstanceId);
  }
}
