// バックアップの封筒ファイル（設計 03、ADR 0040・0047・0055 の U121）。
// 1 つのファイルに、平文の封筒（BackupManifest。本文を持たない）と、暗号化した本体（SQLite の写し）を並べる。
//   8 バイト: マジック "BUDDYBK1"
//   4 バイト: 封筒（JSON）の長さ（ビッグエンディアン）
//   N バイト: 封筒（UTF-8 の JSON）
//   M バイト: 本体（nonce 12 ‖ 暗号文 ‖ 認証タグ 16。M は封筒の payload.bytes）
// 復元の段階 2 は、本体の長さと SHA-256 を封筒と照合してから開く。封筒の欄は本体の AES-GCM の追加認証データにも入る
// ので、封筒だけを書き換えても本体は開けない（backup-crypto.ts）。書き込みは一時ファイル → fsync → rename。

import { randomUUID } from 'node:crypto';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const BACKUP_FILE_MAGIC = 'BUDDYBK1';
export const BACKUP_FILE_EXTENSION = '.buddybackup';
// 封筒（JSON）の大きさの上限。本文を持たないので数 KB だが、壊れた長さで大きく読まないための上限。
export const BACKUP_MANIFEST_MAX_BYTES = 64 * 1024;
const HEADER_BYTES = 12;
const TEMP_PREFIX = '.buddy-backup-';
const TEMP_SUFFIX = '.tmp';
const FILE_NAME =
  /^buddy-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.buddybackup$/u;

export function backupFileName(backupId: string): string {
  return `buddy-${backupId}${BACKUP_FILE_EXTENSION}`;
}

// ファイル名から backup_id を読む。この形でないファイルはバックアップとして扱わない（ほかのファイルに触れない）。
export function backupIdFromFileName(name: string): string | null {
  return FILE_NAME.exec(name)?.[1] ?? null;
}

export function encodeBackupFile(
  manifest: object,
  payload: Uint8Array,
): Buffer {
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (json.length > BACKUP_MANIFEST_MAX_BYTES)
    throw new RangeError('manifest_too_large');
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(BACKUP_FILE_MAGIC, 0, 'ascii');
  header.writeUInt32BE(json.length, 8);
  return Buffer.concat([header, json, payload]);
}

export type BackupFileHeader =
  | {
      readonly ok: true;
      // 封筒（JSON を読んだだけ。Schema・意味の検査は呼び出し側）。
      readonly manifest: unknown;
      readonly payload_offset: number;
      readonly file_bytes: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'file_unreadable'
        | 'magic_mismatch'
        | 'manifest_length_invalid'
        | 'manifest_not_json'
        | 'truncated';
    };

// ファイルの先頭の封筒だけを読む（本体は読まない）。
export async function readBackupFileHeader(
  path: string,
): Promise<BackupFileHeader> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { ok: false, reason: 'file_unreadable' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: 'file_unreadable' };
    const head = Buffer.alloc(HEADER_BYTES);
    const read = await handle.read(head, 0, HEADER_BYTES, 0);
    if (read.bytesRead < HEADER_BYTES)
      return { ok: false, reason: 'truncated' };
    if (head.toString('ascii', 0, 8) !== BACKUP_FILE_MAGIC)
      return { ok: false, reason: 'magic_mismatch' };
    const length = head.readUInt32BE(8);
    if (length === 0 || length > BACKUP_MANIFEST_MAX_BYTES)
      return { ok: false, reason: 'manifest_length_invalid' };
    if (info.size < HEADER_BYTES + length)
      return { ok: false, reason: 'truncated' };
    const body = Buffer.alloc(length);
    const got = await handle.read(body, 0, length, HEADER_BYTES);
    if (got.bytesRead < length) return { ok: false, reason: 'truncated' };
    let manifest: unknown;
    try {
      manifest = JSON.parse(body.toString('utf8'));
    } catch {
      return { ok: false, reason: 'manifest_not_json' };
    }
    return {
      ok: true,
      manifest,
      payload_offset: HEADER_BYTES + length,
      file_bytes: info.size,
    };
  } catch {
    return { ok: false, reason: 'file_unreadable' };
  } finally {
    await handle.close();
  }
}

// 本体（暗号化した部分）を読む。長さは封筒の payload.bytes と一致することを呼び出し側が確かめる。
export async function readBackupPayload(
  path: string,
  offset: number,
  bytes: number,
): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (info.size !== offset + bytes) return null;
    const buffer = Buffer.alloc(bytes);
    const read = await handle.read(buffer, 0, bytes, offset);
    return read.bytesRead === bytes ? buffer : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(dir: string): Promise<void> {
  // Windows はディレクトリを開いて fsync できない。rename の永続は OS に任せる（実機の確認は B15）。
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// 一時ファイルに書いて fsync し、rename で置く。同じ名前（同じ backup_id）がすでにあれば書かない（上書きしない）。
export async function writeBackupFileAtomic(
  dir: string,
  backupId: string,
  bytes: Uint8Array,
  options: { readonly beforeRename?: () => void } = {},
): Promise<string> {
  const target = join(dir, backupFileName(backupId));
  const exists = await stat(target).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error('backup_file_exists');
  const temp = join(dir, `${TEMP_PREFIX}${randomUUID()}${TEMP_SUFFIX}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    options.beforeRename?.();
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(dir);
  return target;
}

// 置き場所の中の封筒ファイルの一覧（ファイル名が封筒の形のものだけ。辞書順）と、取り残された一時ファイル。
export async function listBackupFiles(dir: string): Promise<{
  readonly files: readonly {
    readonly name: string;
    readonly backup_id: string;
    readonly path: string;
  }[];
  readonly temps: readonly string[];
}> {
  const names = await readdir(dir);
  const files = names
    .flatMap((name) => {
      const id = backupIdFromFileName(name);
      return id === null
        ? []
        : [{ name, backup_id: id, path: join(dir, name) }];
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const temps = names
    .filter(
      (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX),
    )
    .sort()
    .map((name) => join(dir, name));
  return { files, temps };
}
