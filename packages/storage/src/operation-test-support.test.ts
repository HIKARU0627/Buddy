// 試験の道具 openSeededDatabase（移行済みで合成のデータを置いた雛形を写す。Issue #348）の試験。
// 雛形を写した DB が、新しいファイルにマイグレーションと合成のデータを置いた DB と同じ表・版・行になること、
// 試験ごとに別のファイルになることを確かめる。期待値（store_generation・端末・接続の ID）は手で書いた値。

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { openWriteConnection } from './connection.js';
import type { SqliteDatabase } from './connection.js';
import { applyMigrations, initStoreGeneration } from './migrations.js';
import {
  SEED,
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const schemaOf = (db: SqliteDatabase) =>
  db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
const metaOf = (db: SqliteDatabase) =>
  db.prepare('SELECT key, value FROM schema_meta ORDER BY key').all();
const ids = (db: SqliteDatabase, sql: string) =>
  db.prepare(sql).pluck().all() as string[];

test('雛形を写した DB は、新しいファイルに全マイグレーションと合成のデータを置いた DB と同じ表・版・行になる', async () => {
  await withTempDir((dir) => {
    // 雛形を使わない作り方（この試験の中で、別のファイルに一から作る）。
    const direct = openWriteConnection(join(dir, 'direct', 'buddy.sqlite'), {
      platform: 'macos',
    });
    const seeded = openSeededDatabase(databasePath(dir));
    try {
      applyMigrations(direct);
      initStoreGeneration(direct, '00000000-0000-4000-8000-0000000000aa');
      for (const sql of SEED) direct.exec(sql);
      assert.ok(schemaOf(direct).length > 0);
      assert.deepEqual(schemaOf(seeded), schemaOf(direct));
      assert.deepEqual(metaOf(seeded), metaOf(direct));
      assert.deepEqual(
        ids(
          seeded,
          "SELECT value FROM schema_meta WHERE key = 'store_generation'",
        ),
        ['00000000-0000-4000-8000-0000000000aa'],
      );
      assert.deepEqual(
        ids(seeded, 'SELECT device_id FROM devices ORDER BY device_id'),
        ['dev-1', 'dev-2'],
      );
      assert.deepEqual(ids(seeded, 'SELECT connection_id FROM connections'), [
        'c-1',
      ]);
      assert.equal(seeded.pragma('journal_mode', { simple: true }), 'wal');
    } finally {
      seeded.close();
      direct.close();
    }
  });
});

test('写した DB は試験ごとに別のファイルで、片方への書込みはもう片方に残らない', async () => {
  await withTempDir((first) =>
    withTempDir((second) => {
      const a = openSeededDatabase(databasePath(first));
      try {
        a.exec("DELETE FROM connections WHERE connection_id = 'c-1'");
        assert.deepEqual(ids(a, 'SELECT connection_id FROM connections'), []);
      } finally {
        a.close();
      }
      const b = openSeededDatabase(databasePath(second));
      try {
        assert.deepEqual(ids(b, 'SELECT connection_id FROM connections'), [
          'c-1',
        ]);
      } finally {
        b.close();
      }
    }),
  );
});
