// 保存ディレクトリの排他。同じディレクトリで 2 つの provider を動かすと、後の保存が先の記録を消すため拒否する。
//
// - 取得: 中身を書いた一時ファイルをハードリンクで `provider.lock` にする。リンクは「無いときだけ」成功する
//   原子的な操作で、空のファイルが見える瞬間がない。
// - 消す操作（古い排他の引き継ぎ・解放）はすべて `provider.lock.guard`（排他作成）の中で、中身を確かめてから行う。
//   作成は消す操作と競合せず（リンクは存在しないときだけ成功）、消すのはガードを持つ者だけなので、
//   確かめた中身と違う（別の持ち主の）排他を消すことがない。
// - 持ち主は pid ではなく、起動ごとの乱数のトークンで見分ける。pid が生きていても、記録したポートの
//   provider がそのトークンを答えなければ、pid が再利用された古い排他として引き継ぐ。
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const LOCK_FILE = 'provider.lock';
const GUARD_FILE = 'provider.lock.guard';
const GUARD_RETRIES = 100;
const GUARD_WAIT_MS = 20;
// ガードは数 ms しか持たないので、これより古いガードは持ち主が異常終了した残りとして片付ける。
const GUARD_STALE_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_000;

interface LockRecord {
  readonly pid: number;
  readonly token: string;
  /** 待ち受けを始めたら記録する。始める前は null。 */
  readonly port: number | null;
}

export interface DirLock {
  /** 起動ごとの乱数。provider が `/v1/instance` で答え、持ち主の確認に使う。 */
  readonly token: string;
  setPort(port: number): Promise<void>;
  /** 自分の排他のときだけ消す。2 回呼んでもよい。 */
  release(): Promise<void>;
}

function parseRecord(text: string): LockRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const { pid, token, port } = value;
    if (
      typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      typeof token === 'string' &&
      token.length > 0 &&
      (port === null ||
        (typeof port === 'number' && Number.isSafeInteger(port)))
    )
      return { pid, token, port };
  } catch {
    // 読めない内容は null。
  }
  return null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM は、存在するが権限がないプロセス。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 記録した持ち主が今も動いているか。確かめられないときは動いているとみなす（拒否側に倒す）。 */
async function ownerAlive(record: LockRecord): Promise<boolean> {
  if (!pidAlive(record.pid)) return false;
  if (record.port === null) return true;
  try {
    const response = await fetch(
      `http://127.0.0.1:${String(record.port)}/v1/instance`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    const body = (await response.json()) as { token?: unknown };
    return body.token === record.token;
  } catch (error) {
    // 時間切れは確かめられない。接続できない・答えが違うのは、持ち主ではない。
    return (error as Error).name === 'TimeoutError';
  }
}

async function withGuard<T>(dir: string, task: () => T): Promise<T> {
  const guard = join(dir, GUARD_FILE);
  for (let attempt = 0; attempt < GUARD_RETRIES; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(guard, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS)
          removeFile(guard);
      } catch {
        // 直前に消された。取り直す。
      }
      await sleep(GUARD_WAIT_MS);
      continue;
    }
    closeSync(fd);
    try {
      return task();
    } finally {
      removeFile(guard);
    }
  }
  throw new Error('模擬 provider の排他のガードを取得できません。');
}

export async function acquireDirLock(dir: string): Promise<DirLock> {
  const lockFile = join(dir, LOCK_FILE);
  const token = randomUUID();
  const write = (record: LockRecord): string => {
    const temp = join(dir, `${LOCK_FILE}.${token}.tmp`);
    writeFileSync(temp, `${JSON.stringify(record)}\n`, 'utf8');
    return temp;
  };

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const temp = write({ pid: process.pid, token, port: null });
    try {
      linkSync(temp, lockFile);
      return makeLock(dir, lockFile, token, write);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      removeFile(temp);
    }
    const judged = readText(lockFile);
    if (judged === null) continue; // 直前に解放された。作り直す。
    const holder = parseRecord(judged);
    if (holder === null)
      throw new Error('模擬 provider の排他の内容を読めません。');
    if (await ownerAlive(holder))
      throw new Error(
        '模擬 provider の保存ディレクトリは、別の provider が使っています。',
      );
    // 古い排他。ガードの中で、判定したときと同じ中身のときだけ消す。
    await withGuard(dir, () => {
      if (readText(lockFile) === judged) removeFile(lockFile);
    });
  }
  throw new Error('模擬 provider の保存ディレクトリの排他を取得できません。');
}

function makeLock(
  dir: string,
  lockFile: string,
  token: string,
  write: (record: LockRecord) => string,
): DirLock {
  const owned = (): boolean => {
    const text = readText(lockFile);
    return text !== null && parseRecord(text)?.token === token;
  };
  let released = false;
  return {
    token,
    setPort: (port) =>
      withGuard(dir, () => {
        if (!owned()) throw new Error('模擬 provider の排他を失っています。');
        renameSync(write({ pid: process.pid, token, port }), lockFile);
      }),
    async release() {
      if (released) return;
      released = true;
      await withGuard(dir, () => {
        if (owned()) removeFile(lockFile);
      });
    },
  };
}
