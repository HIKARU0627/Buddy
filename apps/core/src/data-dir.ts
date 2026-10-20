// データディレクトリの準備と、B01 の状態ファイルの読み取り・片付け（設計 07 §1・§4、ADR 0012・0019）。
//
// core-state.json は B01 の仮置きで、store_generation（DB の世代）と作成時刻だけを持つ。
// B02-04 から store_generation の正本は DB の schema_meta で、状態ファイルは新しく作らない。
// 残っている状態ファイルは起動時に一度だけ読み、DB へ移した（または DB の値と一致した）後に消す。

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  chmod,
} from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_FILE } from './paths.js';
import { UUID_PATTERN, isJsonObject, parseStrictJson } from './strict-json.js';

export class DataDirError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'DataDirError';
    this.reason = reason;
  }
}

// 本人だけが読み書きできるディレクトリを用意し、実体の絶対パスを返す。
// POSIX では所有者を確かめて 0700 にそろえる。Windows は %APPDATA% 既定の ACL に任せる
// （ACL の検査は B01-02 の鍵保護・配置の検討で扱う）。
export async function prepareDataDir(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const real = await realpath(dataDir);
  if (process.platform === 'win32') return real;
  const info = await stat(real);
  if (!info.isDirectory())
    throw new DataDirError(
      'data_dir_not_directory',
      'データディレクトリではありません。',
    );
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw new DataDirError(
      'data_dir_not_owned',
      'データディレクトリの所有者が実行中の利用者と異なります。',
    );
  if ((info.mode & 0o077) !== 0) await chmod(real, 0o700);
  return real;
}

// ディレクトリ内でアトミックに置き換える（一時ファイル → fsync → rename → ディレクトリの fsync）。
export async function writeFileAtomic(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, join(dir, name));
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectory(dir);
}

export async function syncDirectory(dir: string): Promise<void> {
  // Windows ではディレクトリを開いて fsync できない。
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface CoreState {
  readonly store_generation: string;
  readonly created_at: string;
}

export function parseCoreState(text: string): CoreState | null {
  let value;
  try {
    value = parseStrictJson(text, 4);
  } catch {
    return null;
  }
  if (!isJsonObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'created_at' ||
    keys[1] !== 'store_generation'
  )
    return null;
  const generation = value['store_generation'];
  const createdAt = value['created_at'];
  if (typeof generation !== 'string' || !UUID_PATTERN.test(generation))
    return null;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)))
    return null;
  return { store_generation: generation, created_at: createdAt };
}

// B01 の状態ファイルを読む（作らない）。なければ null。壊れたファイルを無視すると世代が変わり、
// 復元・新規作成と区別できなくなるため、読めなければ起動を拒否する。
export async function readLegacyCoreState(
  dataDir: string,
): Promise<CoreState | null> {
  const path = join(dataDir, STATE_FILE);
  let text: string;
  try {
    const handle = await open(path, 'r');
    try {
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const state = parseCoreState(text);
  if (!state)
    throw new DataDirError(
      'state_file_invalid',
      `${STATE_FILE} を読めません。世代を作り直さずに起動を中止します。`,
    );
  return state;
}

// DB へ移した後の状態ファイルを消す。消した後にディレクトリを fsync する。
// 残すと、DB を消して作り直したときに古い世代を新しい DB へ移してしまうため（新規 DB は新しい世代）。
export async function removeLegacyCoreState(dataDir: string): Promise<void> {
  await rm(join(dataDir, STATE_FILE), { force: true });
  await syncDirectory(dataDir);
}
