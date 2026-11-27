// 試験の道具 copyMigratedDatabase（移行済みの DB の雛形を写す。Issue #348）の試験。
// 雛形から起動した DB が、新しいファイルから DB worker を起動した DB と同じ表・版・store_generation になること、
// 試験ごとに別のファイルになること、既にある DB を上書きしないことを確かめる。期待値の store_generation は手で書いた値。

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DbWorkerClient, openWriteConnection } from '@buddy/storage';
import type { SqliteDatabase } from '@buddy/storage';
import {
  copyMigratedDatabase,
  onCleanup,
  tempDir,
} from './api-test-support.js';

const GENERATION = '00000000-0000-4000-8000-0000000000cc';

function read<T>(path: string, body: (db: SqliteDatabase) => T): T {
  const db = openWriteConnection(path, { platform: 'macos' });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

const schemaOf = (db: SqliteDatabase) =>
  db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
const metaOf = (db: SqliteDatabase) =>
  db.prepare('SELECT key, value FROM schema_meta ORDER BY key').all();

async function startAndClose(path: string): Promise<void> {
  const store = await DbWorkerClient.start({
    path,
    storeGeneration: GENERATION,
    responseTimeoutMs: 10_000,
  });
  await store.close();
}

test('移行済みの雛形から起動した DB は、新しいファイルから起動した DB と同じ表・版・store_generation になる', async (t) => {
  const dir = await tempDir(t, 'buddy-template-check-');
  const fresh = join(dir, 'fresh', 'buddy.sqlite');
  const copied = join(dir, 'copied', 'data', 'buddy.sqlite');
  await startAndClose(fresh);
  await copyMigratedDatabase(copied, GENERATION);
  await startAndClose(copied);
  const [freshSchema, freshMeta] = read(fresh, (db) => [
    schemaOf(db),
    metaOf(db),
  ]);
  const [copiedSchema, copiedMeta, journal] = read(copied, (db) => [
    schemaOf(db),
    metaOf(db),
    db.pragma('journal_mode', { simple: true }),
  ]);
  assert.ok(freshSchema.length > 0);
  assert.deepEqual(copiedSchema, freshSchema);
  assert.deepEqual(copiedMeta, freshMeta);
  assert.deepEqual(
    copiedMeta.filter(
      (row) => (row as { key: string }).key === 'store_generation',
    ),
    [{ key: 'store_generation', value: GENERATION }],
  );
  assert.equal(journal, 'wal');
});

test('写した DB は試験ごとに別のファイルで、片方への書込みはもう片方と雛形に残らない。既にある DB は上書きしない', async (t) => {
  const dir = await tempDir(t, 'buddy-template-isolation-');
  const first = join(dir, 'a', 'buddy.sqlite');
  const second = join(dir, 'b', 'buddy.sqlite');
  await copyMigratedDatabase(first, GENERATION);
  const store = await DbWorkerClient.start({
    path: first,
    storeGeneration: GENERATION,
    responseTimeoutMs: 10_000,
  });
  onCleanup(t, () => store.close());
  read(first, (db) =>
    db
      .prepare(
        "INSERT INTO devices VALUES ('dev-template', '合成の端末', 'macos', 0, X'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1000, NULL, NULL)",
      )
      .run(),
  );
  await copyMigratedDatabase(second, GENERATION);
  const count = (path: string) =>
    read(
      path,
      (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number },
    ).n;
  assert.equal(count(first), 1);
  assert.equal(count(second), 0);
  // 既にあるファイルへは写さない（試験の DB を雛形で消さない）。
  await assert.rejects(copyMigratedDatabase(first, GENERATION), {
    code: 'EEXIST',
  });
  assert.equal(count(first), 1);
  assert.ok(existsSync(second));
});
