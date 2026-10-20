// 同じデータディレクトリで動く Core を一つに限る排他（設計 08 §4、X20、ADR 0012）。
//
// ロックファイルを排他作成（O_CREAT | O_EXCL）し、pid・core_instance_id・起動時刻を書く。
// 既存のロックがあれば、制御チャネルへ status を問い合わせて応答があれば二重起動として拒否する。
// 応答がなく pid も生きていなければ古いロックとして片付ける。pid が生きているのに応答が
// なければ、旧担当の終了を確認できないので並行実行せずに拒否する。

import { randomUUID } from 'node:crypto';
import { link, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { callControl } from './control-channel.js';
import { LOCK_FILE } from './paths.js';
import { UUID_PATTERN, isJsonObject, parseStrictJson } from './strict-json.js';

export interface LockRecord {
  readonly pid: number;
  readonly core_instance_id: string;
  readonly started_at: string;
}

export type LockRefusal =
  // 制御チャネルが応答した。動いている Core がある。
  | 'already_running'
  // pid が生きているが応答がない。旧担当の終了を確認できない。
  | 'previous_owner_unconfirmed'
  // ロックの内容を読めない（書込み途中・破損）。終了を確認できないので拒否する。
  | 'lock_unreadable'
  // 古いロックを片付ける途中で別の起動と競合した。
  | 'lock_contended';

export class LockError extends Error {
  readonly reason: LockRefusal;
  readonly holder: LockRecord | null;
  constructor(reason: LockRefusal, holder: LockRecord | null) {
    super(reason);
    this.name = 'LockError';
    this.reason = reason;
    this.holder = holder;
  }
}

export interface AcquireLockOptions {
  readonly dataDir: string;
  readonly endpoint: string;
  readonly record: LockRecord;
  readonly isPidAlive: (pid: number) => boolean;
  readonly probeTimeoutMs: number;
  // 古いロックを片付けたあと、残ったソケットファイルを消す（Windows のパイプは不要）。
  readonly removeStaleEndpoint: () => Promise<void>;
}

export function parseLockRecord(text: string): LockRecord | null {
  let value;
  try {
    value = parseStrictJson(text, 4);
  } catch {
    return null;
  }
  if (!isJsonObject(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'core_instance_id,pid,started_at') return null;
  const { pid, core_instance_id: id, started_at: startedAt } = value;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
    return null;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt)))
    return null;
  return { pid, core_instance_id: id, started_at: startedAt };
}

// pid が存在するか。EPERM は別の利用者のプロセスが存在するので生きているとみなす。
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const lockText = (record: LockRecord) => `${JSON.stringify(record)}\n`;

async function tryCreate(path: string, record: LockRecord): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(lockText(record), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function acquireLock(options: AcquireLockOptions): Promise<void> {
  const path = join(options.dataDir, LOCK_FILE);
  // 古いロックの片付けは一度だけ。二度目も取れなければ競合として拒否する。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await tryCreate(path, options.record)) return;
    const text = await readText(path);
    if (text === null) continue; // 直前に解放された。作成をやり直す。
    const holder = parseLockRecord(text);
    const probe = await callControl(
      options.endpoint,
      'status',
      options.probeTimeoutMs,
    );
    if (probe.kind === 'response')
      throw new LockError('already_running', holder);
    if (!holder) throw new LockError('lock_unreadable', null);
    if (options.isPidAlive(holder.pid))
      throw new LockError('previous_owner_unconfirmed', holder);
    if (attempt > 0) break;
    await removeStaleLock(path, text, holder);
    await options.removeStaleEndpoint();
  }
  throw new LockError('lock_contended', null);
}

// 判定したロックと同じ内容のときだけ消す。rename で退避してから中身を確かめ、
// 別の起動が作り直したロックだったら元に戻して拒否する。
async function removeStaleLock(
  path: string,
  judged: string,
  holder: LockRecord,
): Promise<void> {
  const aside = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = await readText(aside);
  if (moved !== judged) {
    // 戻せない（さらに別の起動が作った）場合も、どちらの起動も続けずに拒否する。
    await link(aside, path).catch(() => undefined);
    await rm(aside, { force: true });
    throw new LockError('lock_contended', holder);
  }
  await rm(aside, { force: true });
}

// 自分のロックのときだけ消す。
export async function releaseLock(
  dataDir: string,
  coreInstanceId: string,
): Promise<void> {
  const path = join(dataDir, LOCK_FILE);
  const text = await readText(path);
  if (text === null) return;
  if (parseLockRecord(text)?.core_instance_id !== coreInstanceId) return;
  await rm(path, { force: true });
}
