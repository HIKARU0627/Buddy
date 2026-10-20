// マイグレーションの適用・二重適用・版の拒否・途中失敗の巻き戻し・内容の変更の拒否と store_generation（ADR 0016）。
// DB は一時ディレクトリかメモリ上に作って消す。期待値（表の数・版・ハッシュ）は手で書いた値か、
// ファイルの生のバイトから試験側で計算した値で、適用の実装から生成していない。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  MIGRATIONS_DIR,
  StorageError,
  TABLE_POLICIES,
  applyConnectionPragmas,
  applyMigrations,
  initStoreGeneration,
  loadMigrations,
  migrationSha256,
  openWriteConnection,
  parseMigration,
  readSchemaVersion,
  readStoreGeneration,
} from './index.js';
import type { SqliteDatabase } from './index.js';

const initialBytes = readFileSync(new URL('0001_initial.sql', MIGRATIONS_DIR));
const initialSql = initialBytes.toString('utf8');
const initialSha = createHash('sha256').update(initialBytes).digest('hex');
const initial = parseMigration('0001_initial.sql', initialSql);
// 0002（ADR 0019）: schema_meta を作り直して鍵の照合値を置けるようにした。
const secondBytes = readFileSync(
  new URL('0002_data_key_check.sql', MIGRATIONS_DIR),
);
const secondSha = createHash('sha256').update(secondBytes).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-storage-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withMemory(run: (db: SqliteDatabase) => void): void {
  const db = new Database(':memory:', { timeout: 0 });
  try {
    applyConnectionPragmas(db);
    run(db);
  } finally {
    db.close();
  }
}

function rejection(run: () => unknown): StorageError {
  try {
    run();
  } catch (error) {
    assert(error instanceof StorageError, String(error));
    return error;
  }
  assert.fail('拒否されませんでした');
}

function meta(db: SqliteDatabase): Record<string, unknown> {
  const rows = db
    .prepare('SELECT key, value FROM schema_meta ORDER BY key')
    .all() as { key: string; value: unknown }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function tableNames(db: SqliteDatabase): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}

// スキーマの状態（定義と SQLite の schema cookie）。DDL が一つでも走れば変わる。
function schemaSnapshot(db: SqliteDatabase): unknown {
  return {
    objects: db
      .prepare(
        'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name',
      )
      .all(),
    cookie: db.pragma('schema_version', { simple: true }),
    meta: meta(db),
  };
}

test('0001 and 0002 apply to a temporary file DB: 42 STRICT tables, version 2 and the content hashes', () => {
  withTempDir((dir) => {
    const path = join(dir, 'buddy.sqlite');
    const db = openWriteConnection(path, { platform: 'macos' });
    try {
      assert.equal(readSchemaVersion(db), 0);
      assert.deepEqual(applyMigrations(db), {
        from: 0,
        to: 2,
        applied: [1, 2],
      });
      const tables = tableNames(db);
      assert.equal(tables.length, 42);
      assert.deepEqual(tables, Object.keys(TABLE_POLICIES).sort());
      const strict = db
        .prepare(
          "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string; strict: number }[];
      assert.equal(strict.length, 42);
      for (const row of strict) assert.equal(row.strict, 1, row.name);
      assert.deepEqual(meta(db), {
        'migration_sha256:0001': initialSha,
        'migration_sha256:0002': secondSha,
        schema_version: '2',
      });
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      db.close();
    }
    // 開き直しても版は 2 のまま、適用するものはない。
    const reopened = openWriteConnection(path, { platform: 'macos' });
    try {
      assert.equal(readSchemaVersion(reopened), 2);
      assert.deepEqual(applyMigrations(reopened), {
        from: 2,
        to: 2,
        applied: [],
      });
    } finally {
      reopened.close();
    }
  });
});

test('applying twice changes nothing', () => {
  withMemory((db) => {
    applyMigrations(db, [initial]);
    const before = schemaSnapshot(db);
    assert.deepEqual(applyMigrations(db, [initial]), {
      from: 1,
      to: 1,
      applied: [],
    });
    assert.deepEqual(schemaSnapshot(db), before);
  });
});

test('a database newer than the code is rejected without downgrading', () => {
  withMemory((db) => {
    applyMigrations(db, [initial]);
    db.prepare(
      "UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'",
    ).run();
    const before = schemaSnapshot(db);
    assert.equal(
      rejection(() => applyMigrations(db, [initial])).reason,
      'schema_newer_than_code',
    );
    assert.deepEqual(schemaSnapshot(db), before);
    assert.equal(meta(db)['schema_version'], '2');
  });
});

test('a failure in the middle of a migration rolls back and does not advance the version', () => {
  withMemory((db) => {
    const broken = parseMigration(
      '0001_initial.sql',
      `${initialSql}\nINSERT INTO table_that_does_not_exist VALUES (1);\n`,
    );
    assert.throws(() => applyMigrations(db, [broken]), /no such table/u);
    assert.equal(
      db.prepare('SELECT count(*) FROM sqlite_schema').pluck().get(),
      0,
    );
    assert.equal(readSchemaVersion(db), 0);
  });
  withMemory((db) => {
    applyMigrations(db, [initial]);
    const brokenSecond = parseMigration(
      '0002_extra.sql',
      'CREATE TABLE extra (x INTEGER) STRICT;\nINSERT INTO table_that_does_not_exist VALUES (1);\n',
    );
    assert.throws(
      () => applyMigrations(db, [initial, brokenSecond]),
      /no such table/u,
    );
    assert.equal(readSchemaVersion(db), 1);
    assert(!tableNames(db).includes('extra'));
    assert.equal(meta(db)['migration_sha256:0002'], undefined);
    // 直した 0002 は適用でき、版と内容のハッシュが進む。
    const second = parseMigration(
      '0002_extra.sql',
      'CREATE TABLE extra (x INTEGER) STRICT;\n',
    );
    assert.deepEqual(applyMigrations(db, [initial, second]), {
      from: 1,
      to: 2,
      applied: [2],
    });
    assert(tableNames(db).includes('extra'));
    assert.equal(
      meta(db)['migration_sha256:0002'],
      '55bb45bb0eb32e25b49c2388c8033490904dd155742738b0e017bbfcf2051642',
    );
  });
});

test('a changed applied migration is rejected before anything else is applied', () => {
  withMemory((db) => {
    applyMigrations(db, [initial]);
    const before = schemaSnapshot(db);
    const edited = parseMigration(
      '0001_initial.sql',
      `${initialSql}\n-- 追記\n`,
    );
    const second = parseMigration(
      '0002_extra.sql',
      'CREATE TABLE extra (x INTEGER) STRICT;\n',
    );
    assert.equal(
      rejection(() => applyMigrations(db, [edited, second])).reason,
      'migration_changed',
    );
    assert.deepEqual(schemaSnapshot(db), before);
    // 改行を CRLF にしただけの checkout は同じ内容として扱う。
    const crlf = parseMigration(
      '0001_initial.sql',
      initialSql.replace(/\n/gu, '\r\n'),
    );
    assert.deepEqual(applyMigrations(db, [crlf]), {
      from: 1,
      to: 1,
      applied: [],
    });
    db.prepare(
      "DELETE FROM schema_meta WHERE key = 'migration_sha256:0001'",
    ).run();
    assert.equal(
      rejection(() => applyMigrations(db, [initial])).reason,
      'migration_hash_missing',
    );
  });
});

test('content hashes ignore only CRLF line endings', () => {
  assert.equal(
    migrationSha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    migrationSha256('CREATE TABLE extra (x INTEGER) STRICT;\r\n'),
    '55bb45bb0eb32e25b49c2388c8033490904dd155742738b0e017bbfcf2051642',
  );
  assert.equal(initial.sha256, initialSha);
});

test('unknown databases and unreadable versions are rejected', () => {
  withMemory((db) => {
    db.exec('CREATE TABLE other (x INTEGER) STRICT;');
    assert.equal(
      rejection(() => applyMigrations(db, [initial])).reason,
      'unknown_database',
    );
  });
  withMemory((db) => {
    applyMigrations(db, [initial]);
    db.prepare(
      "UPDATE schema_meta SET value = 'one' WHERE key = 'schema_version'",
    ).run();
    assert.equal(
      rejection(() => applyMigrations(db, [initial])).reason,
      'schema_version_invalid',
    );
  });
  withMemory((db) => {
    applyMigrations(db, [initial]);
    // schema_meta の CHECK は決めたキー以外を受け付けない。
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO schema_meta VALUES ('migration_sha256:1', 'x')")
          .run(),
      /CHECK constraint failed/u,
    );
  });
});

test('migration files are numbered from 1 without gaps and contain no transaction control', () => {
  const bundled = loadMigrations();
  assert.deepEqual(
    bundled.map((migration) => [migration.version, migration.name]),
    [
      [1, '0001_initial.sql'],
      [2, '0002_data_key_check.sql'],
    ],
  );
  withTempDir((dir) => {
    writeFileSync(join(dir, '0001_initial.sql'), initialBytes);
    writeFileSync(join(dir, 'connection.sql'), 'PRAGMA foreign_keys = ON;\n');
    writeFileSync(join(dir, 'README.md'), '# 合成\n');
    assert.deepEqual(
      loadMigrations(dir).map((migration) => migration.version),
      [1],
    );
    writeFileSync(
      join(dir, '0003_gap.sql'),
      'CREATE TABLE gap (x INTEGER) STRICT;\n',
    );
    assert.equal(
      rejection(() => loadMigrations(dir)).reason,
      'migration_sequence_invalid',
    );
    rmSync(join(dir, '0003_gap.sql'));
    writeFileSync(
      join(dir, '0002_Bad.sql'),
      'CREATE TABLE bad (x INTEGER) STRICT;\n',
    );
    assert.equal(
      rejection(() => loadMigrations(dir)).reason,
      'migration_name_invalid',
    );
  });
  for (const sql of [
    'BEGIN TRANSACTION;\nCREATE TABLE a (x INTEGER) STRICT;\nCOMMIT;\n',
    'CREATE TABLE a (x INTEGER) STRICT;\nCOMMIT;\n',
    'SAVEPOINT s;\nCREATE TABLE a (x INTEGER) STRICT;\nRELEASE s;\n',
    'BEGIN;\nCREATE TABLE a (x INTEGER) STRICT;\n',
    'PRAGMA journal_mode = DELETE;\n',
    'VACUUM;\n',
  ])
    assert.equal(
      rejection(() => parseMigration('0002_tx.sql', sql)).reason,
      'migration_transaction_control',
      sql,
    );
  // 文字列・コメントの中の語と trigger の BEGIN … END は制御文ではない。
  parseMigration(
    '0002_ok.sql',
    "-- COMMIT はしない\nCREATE TABLE a (x TEXT NOT NULL CHECK (x IN ('commit', 'release'))) STRICT;\n" +
      "CREATE TRIGGER a_no_update BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'a_immutable'); END;\n",
  );
});

test('a migration that ends the transaction itself does not advance the version', () => {
  withMemory((db) => {
    applyMigrations(db, [initial]);
    // 単独の END（COMMIT の別名）は trigger の END と区別できないため、適用後に検出する。
    const ending = parseMigration(
      '0002_end.sql',
      'CREATE TABLE a (x INTEGER) STRICT;\nEND;\nCREATE TABLE b (x INTEGER) STRICT;\n',
    );
    assert.equal(
      rejection(() => applyMigrations(db, [initial, ending])).reason,
      'migration_transaction_control',
    );
    assert.equal(readSchemaVersion(db), 1);
    assert.equal(meta(db)['migration_sha256:0002'], undefined);
  });
});

test('store_generation is created once and kept afterwards', () => {
  withMemory((db) => {
    assert.equal(
      rejection(() => readStoreGeneration(db)).reason,
      'schema_not_initialized',
    );
    applyMigrations(db, [initial]);
    assert.equal(readStoreGeneration(db), null);
    const first = initStoreGeneration(db);
    assert.equal(first.created, true);
    assert.match(first.storeGeneration, UUID);
    const again = initStoreGeneration(
      db,
      '00000000-0000-4000-8000-000000000001',
    );
    assert.deepEqual(again, {
      storeGeneration: first.storeGeneration,
      created: false,
    });
    assert.equal(readStoreGeneration(db), first.storeGeneration);
  });
  withMemory((db) => {
    applyMigrations(db, [initial]);
    // B02-04 で Core の状態ファイルの世代を引き継ぐ形。
    assert.deepEqual(
      initStoreGeneration(db, '00000000-0000-4000-8000-000000000002'),
      {
        storeGeneration: '00000000-0000-4000-8000-000000000002',
        created: true,
      },
    );
    assert.equal(
      rejection(() => initStoreGeneration(db, 'not-a-uuid')).reason,
      'store_generation_invalid',
    );
    db.prepare(
      "UPDATE schema_meta SET value = 'NOT-A-UUID' WHERE key = 'store_generation'",
    ).run();
    assert.equal(
      rejection(() => readStoreGeneration(db)).reason,
      'store_generation_invalid',
    );
  });
  withTempDir((dir) => {
    const path = join(dir, 'buddy.sqlite');
    const db = openWriteConnection(path, { platform: 'linux' });
    let generation: string;
    try {
      applyMigrations(db);
      generation = initStoreGeneration(db).storeGeneration;
    } finally {
      db.close();
    }
    const reopened = openWriteConnection(path, { platform: 'linux' });
    try {
      applyMigrations(reopened);
      assert.equal(readStoreGeneration(reopened), generation);
      assert.equal(initStoreGeneration(reopened).created, false);
    } finally {
      reopened.close();
    }
  });
});
