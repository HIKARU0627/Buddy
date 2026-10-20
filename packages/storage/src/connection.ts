// better-sqlite3 の書込み接続（設計 08 §3、11 §9、02 保存と秘密情報、ADR 0010・0016）。
//
// 接続を作るたびに migrations/connection.sql の PRAGMA を設定し、読み戻して確かめる。
// WAL・synchronous=FULL・（macOS）fullfsync・外部キー・busy_timeout=0 のどれかが違えば
// 接続を閉じて拒否し、書込み（外部変更の開始を含む）を始めさせない。性能のために NORMAL へ下げない。
// 読み戻しの一致は、OS・VFS・ストレージの同期が正しいことを前提にした設定の確認であり、
// 電源断で記録が残ることの証明ではない（X60 は未実施）。

import Database from 'better-sqlite3';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { StorageError } from './errors.js';
import { pragmaReasons } from './policy.js';
import type { ObservedPragmas } from './policy.js';

export type SqliteDatabase = Database.Database;
export type StoragePlatform = 'macos' | 'windows' | 'linux';

// パッケージの migrations ディレクトリ（dist/ から見て ../migrations/）。
export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

export function readConnectionSql(): string {
  return readFileSync(new URL('connection.sql', MIGRATIONS_DIR), 'utf8');
}

// Node の process.platform を保存層の区分へ写す。中枢の対象外の OS は拒否する。
export function storagePlatform(
  nodePlatform: NodeJS.Platform = process.platform,
): StoragePlatform {
  if (nodePlatform === 'darwin') return 'macos';
  if (nodePlatform === 'win32') return 'windows';
  if (nodePlatform === 'linux') return 'linux';
  throw new StorageError(
    'platform_unsupported',
    '保存層が対応していない OS です。',
  );
}

export interface WriteConnectionPragmas extends ObservedPragmas {
  readonly busy_timeout: number;
}

function pragmaValue(db: SqliteDatabase, name: string): unknown {
  return db.pragma(name, { simple: true });
}

// 接続の PRAGMA を読み戻す。値の型が想定と違う場合も一致しない値として扱う。
export function readConnectionPragmas(
  db: SqliteDatabase,
): WriteConnectionPragmas {
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : '';
  const number = (value: unknown): number =>
    typeof value === 'number' ? value : -1;
  return {
    journal_mode: text(pragmaValue(db, 'journal_mode')),
    synchronous: number(pragmaValue(db, 'synchronous')),
    fullfsync: number(pragmaValue(db, 'fullfsync')),
    foreign_keys: number(pragmaValue(db, 'foreign_keys')),
    busy_timeout: number(pragmaValue(db, 'busy_timeout')),
  };
}

// 書込み接続として使えない理由。空なら一致。耐久設定は pragmaReasons（policy.ts）、
// busy_timeout は 11 §9（SQLITE_BUSY を待たずにキューへ戻す）の確認。
export function writeConnectionReasons(
  db: SqliteDatabase,
  platform: StoragePlatform,
): string[] {
  const observed = readConnectionPragmas(db);
  const reasons = pragmaReasons(observed, platform);
  if (observed.busy_timeout !== 0) reasons.push('busy_timeout_not_zero');
  return reasons;
}

export interface WriteConnectionOptions {
  readonly platform: StoragePlatform;
  // 接続の作成時に実行する SQL。既定は migrations/connection.sql。
  // 故障注入の試験で差し替える。弱めた SQL を渡しても読み戻しで拒否される。
  readonly connectionSql?: string;
}

const SIDE_FILES = ['-wal', '-shm', '-journal'];

function currentUid(): number | undefined {
  return process.getuid?.();
}

function checkOwnedFile(path: string, info: Stats): void {
  if (info.isSymbolicLink())
    throw new StorageError(
      'database_path_symlink',
      'DB ファイルにシンボリックリンクは使えません。',
    );
  if (!info.isFile())
    throw new StorageError(
      'database_path_not_file',
      'DB のパスが通常のファイルではありません。',
    );
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid)
    throw new StorageError(
      'database_file_not_owned',
      'DB ファイルの所有者が実行中の利用者と異なります。',
    );
  if ((info.mode & 0o077) !== 0) chmodSync(path, 0o600);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// DB のディレクトリとファイルを本人だけが読み書きできる状態にする（設計 02・03）。
// POSIX はディレクトリ 0700・ファイル 0600 にそろえ、所有者が違えば拒否する。
// Windows は利用者のプロファイル配下の既定の ACL に任せる（ACL の検査は未実装）。
function prepareDatabaseFile(path: string): void {
  if (!isAbsolute(path))
    throw new StorageError(
      'database_path_not_absolute',
      'DB のパスは絶対パスで指定してください。',
    );
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const posix = process.platform !== 'win32';
  if (posix) {
    const real = realpathSync(directory);
    const info = statSync(real);
    if (!info.isDirectory())
      throw new StorageError(
        'database_directory_not_directory',
        'DB の置き場所がディレクトリではありません。',
      );
    const uid = currentUid();
    if (uid !== undefined && info.uid !== uid)
      throw new StorageError(
        'database_directory_not_owned',
        'DB のディレクトリの所有者が実行中の利用者と異なります。',
      );
    if ((info.mode & 0o077) !== 0) chmodSync(real, 0o700);
  }
  const existing = lstatOrNull(path);
  if (existing === null) {
    // SQLite は -wal・-shm を DB ファイルと同じ権限で作るため、最初から 0600 で作っておく。
    closeSync(openSync(path, 'wx', 0o600));
  }
  const info = lstatSync(path);
  if (posix) checkOwnedFile(path, info);
  else if (!info.isFile())
    throw new StorageError(
      'database_path_not_file',
      'DB のパスが通常のファイルではありません。',
    );
  if (posix)
    for (const suffix of SIDE_FILES) {
      const side = lstatOrNull(`${path}${suffix}`);
      if (side !== null) checkOwnedFile(`${path}${suffix}`, side);
    }
}

// connection.sql を実行して PRAGMA を設定する（読み戻しは writeConnectionReasons）。
export function applyConnectionPragmas(
  db: SqliteDatabase,
  connectionSql: string = readConnectionSql(),
): void {
  db.exec(connectionSql);
}

// 書込み接続を開く。PRAGMA の読み戻しが一致しなければ接続を閉じて StorageError を投げる。
// ':memory:' はファイルの準備を飛ばす（journal_mode が WAL にならず拒否される。試験用）。
export function openWriteConnection(
  path: string,
  options: WriteConnectionOptions,
): SqliteDatabase {
  const memory = path === ':memory:';
  if (!memory) {
    if (path.trim() !== path || path === '' || path.startsWith('file:'))
      throw new StorageError(
        'database_path_invalid',
        'DB のパスとして使えない形式です。',
      );
    prepareDatabaseFile(path);
  }
  // better-sqlite3 の既定の待ち時間（5 秒）を使わない。connection.sql でも 0 にする。
  const db = new Database(path, {
    timeout: 0,
    ...(memory ? {} : { fileMustExist: true }),
  });
  try {
    applyConnectionPragmas(db, options.connectionSql ?? readConnectionSql());
    const reasons = writeConnectionReasons(db, options.platform);
    if (reasons.length > 0)
      throw new StorageError(
        'write_connection_rejected',
        `書込み接続の PRAGMA が一致しません（${reasons.join(', ')}）。書込みを開始しません。`,
        reasons,
      );
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
