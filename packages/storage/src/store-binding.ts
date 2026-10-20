// DB とデータ鍵・store_generation の結び付け（設計 02・07 §1・§4・08 §4、ADR 0017・0019）。
//
// Core の起動で、DB worker が書込み接続を開いてマイグレーションを適用した後、命令の受付の前に行う。
// - DB の健全性: PRAGMA quick_check が ok でなければ拒否する（DB 破損では外部変更を始めない。08 §4）。
// - 鍵の照合値: 初回は DB に保存し、以後は一致を確かめる。照合値は鍵そのものではなく
//   HMAC-SHA256(鍵, "buddy/data-key-check/v1" + NUL + key_id)。一致しなければ書込みを始めない。
// - store_generation: DB にあれば DB を正とする。B01 の状態ファイル（core-state.json）の値を渡された場合、
//   DB になければその値で作り（移行）、DB の値と違えば拒否する。どちらもなければ新しい UUID で作る。
// 保存は一つの BEGIN IMMEDIATE の transaction で行い、拒否するときは何も書かない。

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqliteDatabase } from './connection.js';
import { StorageError } from './errors.js';
import { readSchemaVersion } from './migrations.js';
import type { DataKeyMaterial } from './sealed-blob.js';

// 照合値の文脈。鍵を他の用途（AES-256-GCM の暗号化）と同じ入力で使わないための固定の文字列。
export const DATA_KEY_CHECK_CONTEXT = 'buddy/data-key-check/v1';
const DATA_KEY_CHECK_PREFIX = 'data_key_check:';
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// 照合値を置けるのは 0002 から。
export const DATA_KEY_CHECK_MIN_SCHEMA_VERSION = 2;

export interface DataKeyCheck {
  readonly keyId: string;
  // HMAC-SHA256 の小文字の 16 進（64 桁）。
  readonly value: string;
}

// データ鍵の照合値。鍵の値は戻り値・例外に入れない。
export function dataKeyCheckValue(dataKey: DataKeyMaterial): DataKeyCheck {
  const { keyId, key } = dataKey;
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId))
    throw new StorageError('key_id_invalid', 'key_id の形が正しくありません。');
  if (!(key instanceof Uint8Array) || key.length !== 32)
    throw new StorageError('key_invalid', 'データ鍵の形が正しくありません。');
  const value = createHmac('sha256', key)
    .update(`${DATA_KEY_CHECK_CONTEXT}\0${keyId}`, 'utf8')
    .digest('hex');
  return { keyId, value };
}

export function dataKeyCheckMetaKey(keyId: string): string {
  return `${DATA_KEY_CHECK_PREFIX}${keyId}`;
}

export interface StoreBindingInput {
  readonly dataKeyCheck: DataKeyCheck;
  // B01 の状態ファイルの store_generation。状態ファイルがなければ null。
  readonly legacyStoreGeneration: string | null;
}

export type StoreGenerationSource =
  // DB に既にあった（通常の再起動）。
  | 'database'
  // 状態ファイルの値を DB へ移した。
  | 'state_file'
  // DB にも状態ファイルにもなく、新しく作った（新規 DB）。
  | 'created';

export interface StoreBindingResult {
  readonly storeGeneration: string;
  readonly storeGenerationSource: StoreGenerationSource;
  // 照合値を今回保存したか（stored）、保存済みの値と一致したか（matched）。
  readonly dataKeyCheck: 'stored' | 'matched';
}

// DB の健全性の確認。ok でなければ StorageError（database_integrity_failed）。
// SQLITE_CORRUPT などの例外も同じ理由にする。
export function checkDatabaseIntegrity(db: SqliteDatabase): void {
  let rows: unknown[];
  try {
    rows = db.pragma('quick_check') as unknown[];
  } catch {
    throw new StorageError(
      'database_integrity_failed',
      'DB の健全性を確認できません。',
    );
  }
  const ok =
    rows.length === 1 &&
    (rows[0] as { quick_check?: unknown }).quick_check === 'ok';
  if (!ok)
    throw new StorageError(
      'database_integrity_failed',
      'DB の健全性の確認に失敗しました。書込みを開始しません。',
    );
}

function sameHex(a: string, b: string): boolean {
  return (
    HEX64.test(a) &&
    HEX64.test(b) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  );
}

// DB と鍵・世代を結び付ける。拒否の理由（StorageError.reason）:
// - database_integrity_failed: quick_check が ok でない
// - schema_too_old: 照合値を置けない版（0002 より前）
// - data_key_check_invalid: 保存済みの照合値・入力の形が壊れている
// - data_key_check_mismatch: 保存済みの照合値と違う（別の鍵、または別の key_id の鍵で作った DB）
// - data_key_check_missing: 照合値がないのに暗号文（sealed_blobs）がある（どの鍵で作ったか確かめられない）
// - store_generation_mismatch: 状態ファイルの世代と DB の世代が違う
// - store_generation_invalid: 世代の形が壊れている
export function bindStore(
  db: SqliteDatabase,
  input: StoreBindingInput,
): StoreBindingResult {
  const { dataKeyCheck, legacyStoreGeneration } = input;
  if (!KEY_ID.test(dataKeyCheck.keyId) || !HEX64.test(dataKeyCheck.value))
    throw new StorageError(
      'data_key_check_invalid',
      '鍵の照合値の形が正しくありません。',
    );
  if (legacyStoreGeneration !== null && !UUID_TEXT.test(legacyStoreGeneration))
    throw new StorageError(
      'store_generation_invalid',
      '状態ファイルの store_generation の形が正しくありません。',
    );
  checkDatabaseIntegrity(db);
  const run = db.transaction((): StoreBindingResult => {
    if (readSchemaVersion(db) < DATA_KEY_CHECK_MIN_SCHEMA_VERSION)
      throw new StorageError(
        'schema_too_old',
        '鍵の照合値を置けない版の DB です。',
      );
    const meta = db
      .prepare(
        "SELECT key, value FROM schema_meta WHERE key = 'store_generation' OR key GLOB 'data_key_check:*'",
      )
      .all() as { key: string; value: unknown }[];
    const checks = meta.filter((row) =>
      row.key.startsWith(DATA_KEY_CHECK_PREFIX),
    );
    const ownKey = dataKeyCheckMetaKey(dataKeyCheck.keyId);
    const own = checks.find((row) => row.key === ownKey);
    let keyResult: 'stored' | 'matched';
    if (own !== undefined) {
      if (typeof own.value !== 'string' || !HEX64.test(own.value))
        throw new StorageError(
          'data_key_check_invalid',
          '保存済みの鍵の照合値を読めません。',
        );
      if (!sameHex(own.value, dataKeyCheck.value))
        throw new StorageError(
          'data_key_check_mismatch',
          'DB を作ったときのデータ鍵と、今のデータ鍵が一致しません。書込みを開始しません。',
        );
      keyResult = 'matched';
    } else {
      if (checks.length > 0)
        throw new StorageError(
          'data_key_check_mismatch',
          'DB は別の key_id のデータ鍵で作られています。書込みを開始しません。',
        );
      const sealed = db
        .prepare('SELECT count(*) AS n FROM sealed_blobs')
        .get() as { n: number };
      if (sealed.n > 0)
        throw new StorageError(
          'data_key_check_missing',
          '鍵の照合値がないまま暗号文があります。どの鍵で作った DB か確かめられません。',
        );
      keyResult = 'stored';
    }
    const generationRow = meta.find((row) => row.key === 'store_generation');
    let storeGeneration: string;
    let source: StoreGenerationSource;
    if (generationRow !== undefined) {
      if (
        typeof generationRow.value !== 'string' ||
        !UUID_TEXT.test(generationRow.value)
      )
        throw new StorageError(
          'store_generation_invalid',
          'schema_meta の store_generation を読めません。',
        );
      if (
        legacyStoreGeneration !== null &&
        legacyStoreGeneration !== generationRow.value
      )
        throw new StorageError(
          'store_generation_mismatch',
          '状態ファイルと DB の store_generation が一致しません。どちらも書き換えずに起動を中止します。',
        );
      storeGeneration = generationRow.value;
      source = 'database';
    } else {
      storeGeneration = legacyStoreGeneration ?? randomUUID();
      source = legacyStoreGeneration === null ? 'created' : 'state_file';
    }
    // 書込みは両方の確認が済んでから。拒否した場合は何も書いていない。
    if (keyResult === 'stored')
      db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
        ownKey,
        dataKeyCheck.value,
      );
    if (source !== 'database')
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('store_generation', ?)",
      ).run(storeGeneration);
    return {
      storeGeneration,
      storeGenerationSource: source,
      dataKeyCheck: keyResult,
    };
  });
  return run.immediate();
}
