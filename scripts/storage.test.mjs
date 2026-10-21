import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { RETENTION_RULES } from '../packages/domain/dist/index.js';
import {
  PLAINTEXT_COLUMN_NAMES,
  TABLE_POLICIES,
  pragmaReasons,
} from '../packages/storage/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// 保存案（0001 から順の全版）を Node 組み込みの SQLite（開発ツールの試験だけ）で適用し、手書きの期待値と照合する。
// 製品の better-sqlite3 とは SQLite の版が違い得る。電源断の耐久性（X60）はここでは検証しない。
const migrationsDir = new URL('packages/storage/migrations/', root);
const migrationFiles = (await readdir(migrationsDir))
  .filter((name) => /^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(name))
  .sort();
const migrations = await Promise.all(
  migrationFiles.map((name) => readFile(new URL(name, migrationsDir), 'utf8')),
);
// 期限の定数の照合は 0001 の本文で行う。
const migration = migrations[0];
const connectionSql = await readFile(
  new URL('packages/storage/migrations/connection.sql', root),
  'utf8',
);
const cases = parseStrictJson(
  await readFile(new URL('tests/fixtures/storage-cases.json', root), 'utf8'),
);

function openMigrated() {
  const db = new DatabaseSync(':memory:');
  for (const sql of migrations) db.exec(sql);
  return db;
}

function outcome(db, sql) {
  try {
    db.exec(sql);
    return 'ok';
  } catch (error) {
    const message = String(error.message);
    if (message.includes('UNIQUE constraint failed')) return 'unique';
    if (message.includes('CHECK constraint failed')) return 'check';
    if (message.includes('FOREIGN KEY constraint failed')) return 'foreign_key';
    if (message.includes('NOT NULL constraint failed')) return 'not_null';
    return `trigger:${message}`;
  }
}

const db = openMigrated();
const tables = db
  .prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((row) => row.name);
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all();
const foreignKeys = (table) =>
  db.prepare(`PRAGMA foreign_key_list(${table})`).all();

test('the migration applies, every table is STRICT and has a storage policy', () => {
  assert(tables.length >= 40);
  const strict = new Map(
    db
      .prepare('PRAGMA table_list')
      .all()
      .map((row) => [row.name, row.strict]),
  );
  for (const table of tables) assert.equal(strict.get(table), 1, table);
  assert.deepEqual(tables, Object.keys(TABLE_POLICIES).sort());
  assert.equal(
    db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get().value,
    '1',
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('bodies live only in sealed_blobs and body-free tables have no body columns', () => {
  for (const table of tables) {
    const names = columns(table).map((column) => column.name);
    for (const name of names)
      assert(!PLAINTEXT_COLUMN_NAMES.includes(name), `${table}.${name}`);
    const blobColumns = names.filter((name) => name.endsWith('_blob_id'));
    const policy = TABLE_POLICIES[table];
    if (table === 'sealed_blobs') continue;
    assert.equal(
      policy.body === 'sealed_refs',
      blobColumns.length > 0,
      `${table} body policy`,
    );
    const references = foreignKeys(table);
    for (const column of blobColumns)
      assert(
        references.some(
          (fk) =>
            fk.from === column &&
            fk.table === 'sealed_blobs' &&
            fk.to === 'blob_id',
        ),
        `${table}.${column} must reference sealed_blobs`,
      );
  }
  // 08 §5・03 で本文を持たないと決めた表。
  for (const table of [
    'event_outbox',
    'command_receipts',
    'forget_ledger',
    'forget_ledger_items',
    'intent_shadow',
    'sync_staging',
    'sync_batches',
    'deliveries',
  ])
    assert.equal(TABLE_POLICIES[table].body, 'none', table);
  const sealed = columns('sealed_blobs').map((column) => column.name);
  for (const name of [
    'format_version',
    'key_id',
    'nonce',
    'ciphertext',
    'tag',
    'purpose',
    'owner_table',
    'owner_id',
    'owner_version',
  ])
    assert(sealed.includes(name), name);
});

test('retention constants in SQL match the domain retention rules', () => {
  const used = Object.values(TABLE_POLICIES).map((policy) => policy.retention);
  for (const rule of Object.keys(RETENTION_RULES))
    assert(
      used.some((retention) => retention.includes(rule)),
      `retention rule ${rule} is not used by any table`,
    );
  const ms = (rule) => RETENTION_RULES[rule].ms;
  for (const fragment of [
    `delete_at = created_at + ${ms('command_receipt')}`,
    `delete_at = occurred_at + ${ms('event_outbox')}`,
    `expires_at <= issued_at + ${ms('command_scope')}`,
    `expires_at <= created_at + ${ms('pairing_code')}`,
    `undo_deadline = completed_at + ${ms('undo_window')}`,
    `coalesce(key_delete_at, -1) = closed_at + ${ms('candidate_excerpt')} + ${ms('candidate_key') - ms('candidate_excerpt')}`,
  ])
    assert(migration.includes(fragment), fragment);
});

test('unique constraints, checks, foreign keys and triggers follow the hand-written expectations', () => {
  for (const scenario of cases.scenarios) {
    const scenarioDb = openMigrated();
    for (const sql of cases.seed)
      assert.equal(outcome(scenarioDb, sql), 'ok', sql);
    for (const [index, [sql, expected]] of scenario.steps.entries())
      assert.equal(
        outcome(scenarioDb, sql),
        expected,
        `${scenario.id} #${index + 1}: ${sql}`,
      );
    scenarioDb.close();
  }
});

test('connection pragmas read back as WAL / FULL / fullfsync, which is not a durability proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-storage-'));
  try {
    const file = new DatabaseSync(join(dir, 'probe.sqlite'));
    file.exec(connectionSql);
    const read = (name) =>
      Object.values(file.prepare(`PRAGMA ${name}`).get())[0];
    const observed = {
      journal_mode: read('journal_mode'),
      synchronous: read('synchronous'),
      fullfsync: read('fullfsync'),
      foreign_keys: read('foreign_keys'),
    };
    assert.deepEqual(pragmaReasons(observed, 'macos'), []);
    file.close();
    assert((await readdir(dir)).length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const memory = new DatabaseSync(':memory:');
  memory.exec(connectionSql);
  const observed = {
    journal_mode: Object.values(memory.prepare('PRAGMA journal_mode').get())[0],
    synchronous: 1,
    fullfsync: 0,
    foreign_keys: 0,
  };
  assert.deepEqual(pragmaReasons(observed, 'macos'), [
    'journal_mode_not_wal',
    'synchronous_not_full',
    'fullfsync_off',
    'foreign_keys_off',
  ]);
  assert.deepEqual(
    pragmaReasons(
      { ...observed, journal_mode: 'wal', synchronous: 2, foreign_keys: 1 },
      'windows',
    ),
    [],
  );
  memory.close();
});
