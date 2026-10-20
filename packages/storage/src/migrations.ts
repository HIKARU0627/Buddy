// マイグレーションの適用と schema_meta（設計 03 DB スキーマの版、ADR 0010・0016）。
//
// - migrations/NNNN_名前.sql を版の順に、1 版ずつ BEGIN IMMEDIATE の transaction で適用する。
// - 適用した版と同じ transaction で schema_meta の schema_version と migration_sha256:NNNN を書く。
//   途中で失敗すれば transaction ごと巻き戻し、版を進めない。
// - DB の版がコードの最新より新しければ拒否する（ダウングレードしない）。
// - 適用済みの版のファイル内容が記録したハッシュと違えば、何も適用せずに拒否する。
// - store_generation は初回だけ作り、以後は維持する（Core の状態ファイルからの移行は B02-04）。

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS_DIR } from './connection.js';
import type { SqliteDatabase } from './connection.js';
import { StorageError } from './errors.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  // 内容の SHA-256（小文字の 16 進）。改行は LF にそろえてから計算する。
  readonly sha256: string;
}

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;
const VERSION_TEXT = /^[1-9][0-9]*$/u;
const SHA256_TEXT = /^[0-9a-f]{64}$/u;
// 規約どおりの小文字の UUID（8-4-4-4-12）。Core の状態ファイルと同じ形。
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function migrationHashKey(version: number): string {
  return `migration_sha256:${String(version).padStart(4, '0')}`;
}

export function migrationSha256(sql: string): string {
  return createHash('sha256')
    .update(sql.replace(/\r\n/gu, '\n'), 'utf8')
    .digest('hex');
}

// コメント・文字列・引用した識別子を除いた SQL（transaction 制御の検出用）。
function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/gu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/'(?:[^']|'')*'/gu, "''")
    .replace(/"(?:[^"]|"")*"/gu, '""');
}

// transaction は適用側が張る。ファイル内で確定・巻き戻し・transaction の中で使えない文を書かない。
// trigger の BEGIN … END と区別できない単独の END / BEGIN は、適用後の inTransaction でも確かめる。
const TRANSACTION_CONTROL = [
  /\b(?:COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH)\b/iu,
  /\bBEGIN\s*(?:DEFERRED|IMMEDIATE|EXCLUSIVE|TRANSACTION|;)/iu,
  /\bEND\s+TRANSACTION\b/iu,
  /\bPRAGMA\s+(?:\w+\.)?journal_mode\b/iu,
];

export function parseMigration(fileName: string, sql: string): Migration {
  const match = MIGRATION_FILE.exec(fileName);
  if (!match?.[1])
    throw new StorageError(
      'migration_name_invalid',
      `マイグレーションのファイル名が規則に合いません: ${fileName}`,
    );
  const stripped = stripSqlLiterals(sql);
  if (TRANSACTION_CONTROL.some((pattern) => pattern.test(stripped)))
    throw new StorageError(
      'migration_transaction_control',
      `マイグレーションに transaction の制御文があります: ${fileName}`,
    );
  return {
    version: Number(match[1]),
    name: fileName,
    sql,
    sha256: migrationSha256(sql),
  };
}

// 版は 1 から欠番なく続く。重複・欠番・0 は拒否する。
export function checkMigrationSequence(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new StorageError(
        'migration_sequence_invalid',
        'マイグレーションの版が 1 から連続していません。',
      );
  });
}

// ディレクトリの NNNN_名前.sql を版の順に読む。connection.sql・README は対象外。
export function loadMigrations(
  directory: URL | string = MIGRATIONS_DIR,
): Migration[] {
  const path =
    typeof directory === 'string' ? directory : fileURLToPath(directory);
  const migrations = readdirSync(path)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort()
    .map((name) =>
      parseMigration(name, readFileSync(join(path, name), 'utf8')),
    );
  checkMigrationSequence(migrations);
  return migrations;
}

function hasTable(db: SqliteDatabase, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function metaValue(db: SqliteDatabase, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get(key) as { value: unknown } | undefined;
  if (row === undefined) return null;
  return typeof row.value === 'string' ? row.value : null;
}

// DB のスキーマの版。空の DB は 0。schema_meta のない既存の DB・読めない版は拒否する。
export function readSchemaVersion(db: SqliteDatabase): number {
  if (!hasTable(db, 'schema_meta')) {
    const objects = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      )
      .get() as { n: number };
    if (objects.n > 0)
      throw new StorageError(
        'unknown_database',
        'schema_meta のない DB です。Buddy の DB として扱いません。',
      );
    return 0;
  }
  const value = metaValue(db, 'schema_version');
  if (value === null || !VERSION_TEXT.test(value))
    throw new StorageError(
      'schema_version_invalid',
      'schema_meta の schema_version を読めません。',
    );
  return Number(value);
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly number[];
}

function checkAppliedHashes(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  current: number,
): void {
  for (const migration of migrations.slice(0, current)) {
    const recorded = metaValue(db, migrationHashKey(migration.version));
    if (recorded === null || !SHA256_TEXT.test(recorded))
      throw new StorageError(
        'migration_hash_missing',
        `適用済みの版 ${migration.version} の内容のハッシュがありません。`,
      );
    if (recorded !== migration.sha256)
      throw new StorageError(
        'migration_changed',
        `適用済みの版 ${migration.version} のマイグレーションの内容が変わっています。`,
      );
  }
}

function applyOne(db: SqliteDatabase, migration: Migration): void {
  const run = db.transaction(() => {
    // 単一 writer の前提でも、版を読んだ後に別の接続が進めていないかを transaction の中で確かめる。
    if (readSchemaVersion(db) !== migration.version - 1)
      throw new StorageError(
        'schema_version_changed',
        '適用中に DB の版が変わりました。',
      );
    db.exec(migration.sql);
    if (!db.inTransaction)
      throw new StorageError(
        'migration_transaction_control',
        `マイグレーションが transaction を終えました: ${migration.name}`,
      );
    if (!hasTable(db, 'schema_meta'))
      throw new StorageError(
        'schema_meta_missing',
        'マイグレーションの後に schema_meta がありません。',
      );
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(String(migration.version));
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
      migrationHashKey(migration.version),
      migration.sha256,
    );
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0)
      throw new StorageError(
        'migration_foreign_key_violation',
        `マイグレーションの後に外部キーの違反があります: ${migration.name}`,
      );
  });
  run.immediate();
}

// 未適用の版を順に適用する。既に最新なら何もしない。
export function applyMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[] = loadMigrations(),
): MigrationResult {
  checkMigrationSequence(migrations);
  const latest = migrations.length;
  const from = readSchemaVersion(db);
  if (from > latest)
    throw new StorageError(
      'schema_newer_than_code',
      `DB の版（${from}）がコードの最新（${latest}）より新しいため開きません。`,
    );
  checkAppliedHashes(db, migrations, from);
  const applied: number[] = [];
  for (const migration of migrations.slice(from)) {
    applyOne(db, migration);
    applied.push(migration.version);
  }
  return { from, to: readSchemaVersion(db), applied };
}

function requireSchemaMeta(db: SqliteDatabase): void {
  if (readSchemaVersion(db) < 1)
    throw new StorageError(
      'schema_not_initialized',
      'マイグレーションを適用する前の DB です。',
    );
}

// DB の世代（store_generation）。まだなければ null。形が壊れていれば拒否する。
export function readStoreGeneration(db: SqliteDatabase): string | null {
  requireSchemaMeta(db);
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'store_generation'")
    .get() as { value: unknown } | undefined;
  if (row === undefined) return null;
  const value = row.value;
  if (typeof value !== 'string' || !UUID_TEXT.test(value))
    throw new StorageError(
      'store_generation_invalid',
      'schema_meta の store_generation を読めません。',
    );
  return value;
}

export interface StoreGenerationResult {
  readonly storeGeneration: string;
  readonly created: boolean;
}

// store_generation がなければ initial（既定は新しい UUID）で作り、あれば既存の値を返す。
// 既存の値を書き換えない（復元・新規作成での世代の更新は B06 の担当）。
// B02-04 で Core の状態ファイルの値を initial に渡し、戻り値と一致するかを確かめる。
export function initStoreGeneration(
  db: SqliteDatabase,
  initial: string = randomUUID(),
): StoreGenerationResult {
  if (!UUID_TEXT.test(initial))
    throw new StorageError(
      'store_generation_invalid',
      'store_generation に使えない値です。',
    );
  const run = db.transaction((): StoreGenerationResult => {
    const existing = readStoreGeneration(db);
    if (existing !== null) return { storeGeneration: existing, created: false };
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('store_generation', ?)",
    ).run(initial);
    return { storeGeneration: initial, created: true };
  });
  return run.immediate();
}
