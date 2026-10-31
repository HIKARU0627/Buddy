// DB とデータ鍵・store_generation の結び付け（ADR 0019）。DB は一時ディレクトリに作って消す。
// 照合値の期待値は OpenSSL の CLI で別に計算した値:
//   printf 'buddy/data-key-check/v1\0data-key-v1' | openssl dgst -sha256 -mac HMAC -macopt hexkey:<鍵の 16 進>
// 検査対象の関数（node:crypto の createHmac）で期待値を作っていない。

import assert from 'node:assert/strict';
import { openSync, writeSync, closeSync } from 'node:fs';
import test from 'node:test';
import {
  DbWorkerClient,
  StorageError,
  applyMigrations,
  bindStore,
  checkDatabaseIntegrity,
  dataKeyCheckValue,
  initStoreGeneration,
  loadMigrations,
  openWriteConnection,
} from './index.js';
import type { DataKeyCheck, SqliteDatabase } from './index.js';
import {
  databasePath,
  sealedIntent,
  withTempDir,
} from './operation-test-support.js';

// 鍵 A: 0x00, 0x01, …, 0x1f。鍵 B: 0xff が 32 バイト。合成の値で、秘密ではない。
const KEY_A = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY_B = new Uint8Array(32).fill(0xff);
const CHECK_A =
  '96fb8d01af171f589f6a358c13946e0fe5b12d5f7e1456754846a5b0daa15659';
const CHECK_B =
  '5a1f74c17627f5a4d9d0f767dedfbe6a2d60c45a8c388fbf22fb5569982fc3de';
const LEGACY = '0b6f7f1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_GENERATION = '7d4e2a10-5b6c-4d8e-9f01-a2b3c4d5e6f7';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const checkA: DataKeyCheck = { keyId: 'data-key-v1', value: CHECK_A };
const checkB: DataKeyCheck = { keyId: 'data-key-v1', value: CHECK_B };

function meta(db: SqliteDatabase): Record<string, unknown> {
  const rows = db
    .prepare(
      "SELECT key, value FROM schema_meta WHERE key NOT GLOB 'migration_sha256:*' ORDER BY key",
    )
    .all() as { key: string; value: unknown }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
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

function openMigrated(path: string): SqliteDatabase {
  const db = openWriteConnection(path, { platform: 'macos' });
  applyMigrations(db);
  return db;
}

test('the data key check is an HMAC-SHA256 with the fixed context and does not contain the key', () => {
  assert.deepEqual(dataKeyCheckValue({ keyId: 'data-key-v1', key: KEY_A }), {
    keyId: 'data-key-v1',
    value: CHECK_A,
  });
  assert.deepEqual(dataKeyCheckValue({ keyId: 'data-key-v1', key: KEY_B }), {
    keyId: 'data-key-v1',
    value: CHECK_B,
  });
  // key_id も照合値の入力に含める。
  assert.notEqual(
    dataKeyCheckValue({ keyId: 'data-key-v2', key: KEY_A }).value,
    CHECK_A,
  );
  assert.equal(
    rejection(() =>
      dataKeyCheckValue({ keyId: 'data-key-v1', key: KEY_A.subarray(1) }),
    ).reason,
    'key_invalid',
  );
  assert.equal(
    rejection(() => dataKeyCheckValue({ keyId: 'Bad Id', key: KEY_A })).reason,
    'key_id_invalid',
  );
});

test('first binding stores the check and a new generation, later bindings match and keep them', async () => {
  await withTempDir((dir) => {
    const path = databasePath(dir);
    const db = openMigrated(path);
    let generation: string;
    try {
      const first = bindStore(db, {
        dataKeyCheck: checkA,
        legacyStoreGeneration: null,
      });
      assert.equal(first.dataKeyCheck, 'stored');
      assert.equal(first.storeGenerationSource, 'created');
      assert.match(first.storeGeneration, UUID);
      generation = first.storeGeneration;
      assert.deepEqual(meta(db), {
        'data_key_check:data-key-v1': CHECK_A,
        schema_version: '12',
        store_generation: generation,
      });
    } finally {
      db.close();
    }
    const reopened = openMigrated(path);
    try {
      assert.deepEqual(
        bindStore(reopened, {
          dataKeyCheck: checkA,
          legacyStoreGeneration: null,
        }),
        {
          storeGeneration: generation,
          storeGenerationSource: 'database',
          dataKeyCheck: 'matched',
        },
      );
      // 状態ファイルの値が DB と同じなら、DB を正としてそのまま使う（移行済み）。
      assert.equal(
        bindStore(reopened, {
          dataKeyCheck: checkA,
          legacyStoreGeneration: generation,
        }).storeGenerationSource,
        'database',
      );
    } finally {
      reopened.close();
    }
  });
});

test('a different key, a different key id, or a different generation is refused without writing', async () => {
  await withTempDir((dir) => {
    const db = openMigrated(databasePath(dir));
    try {
      const { storeGeneration } = bindStore(db, {
        dataKeyCheck: checkA,
        legacyStoreGeneration: null,
      });
      const before = meta(db);
      assert.equal(
        rejection(() =>
          bindStore(db, { dataKeyCheck: checkB, legacyStoreGeneration: null }),
        ).reason,
        'data_key_check_mismatch',
      );
      assert.equal(
        rejection(() =>
          bindStore(db, {
            dataKeyCheck: { keyId: 'data-key-v2', value: CHECK_B },
            legacyStoreGeneration: null,
          }),
        ).reason,
        'data_key_check_mismatch',
      );
      assert.equal(
        rejection(() =>
          bindStore(db, {
            dataKeyCheck: checkA,
            legacyStoreGeneration: OTHER_GENERATION,
          }),
        ).reason,
        'store_generation_mismatch',
      );
      assert.equal(
        rejection(() =>
          bindStore(db, {
            dataKeyCheck: { keyId: 'data-key-v1', value: 'not-hex' },
            legacyStoreGeneration: null,
          }),
        ).reason,
        'data_key_check_invalid',
      );
      assert.equal(
        rejection(() =>
          bindStore(db, {
            dataKeyCheck: checkA,
            legacyStoreGeneration: 'not-a-uuid',
          }),
        ).reason,
        'store_generation_invalid',
      );
      assert.deepEqual(meta(db), before);
      assert.equal(before['store_generation'], storeGeneration);
    } finally {
      db.close();
    }
  });
});

test('the B01 state file generation moves into the DB once; a conflicting DB value is refused first', async () => {
  await withTempDir((dir) => {
    const db = openMigrated(databasePath(dir));
    try {
      assert.deepEqual(
        bindStore(db, { dataKeyCheck: checkA, legacyStoreGeneration: LEGACY }),
        {
          storeGeneration: LEGACY,
          storeGenerationSource: 'state_file',
          dataKeyCheck: 'stored',
        },
      );
    } finally {
      db.close();
    }
  });
  // DB に別の世代だけがある（鍵の照合値はまだない）: 世代の食い違いで拒否し、照合値も保存しない。
  await withTempDir((dir) => {
    const db = openMigrated(databasePath(dir));
    try {
      initStoreGeneration(db, OTHER_GENERATION);
      assert.equal(
        rejection(() =>
          bindStore(db, {
            dataKeyCheck: checkA,
            legacyStoreGeneration: LEGACY,
          }),
        ).reason,
        'store_generation_mismatch',
      );
      assert.deepEqual(meta(db), {
        schema_version: '12',
        store_generation: OTHER_GENERATION,
      });
    } finally {
      db.close();
    }
  });
});

test('ciphertext without a stored check, an old schema, and invalid stored values are refused', async () => {
  await withTempDir((dir) => {
    const db = openMigrated(databasePath(dir));
    try {
      const intent = sealedIntent();
      db.prepare(
        "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'turn_text', 'turns', 't-1', 0, 1, 'data-key-v1', ?, ?, ?, 1, NULL)",
      ).run(intent.blob_id, intent.nonce, intent.ciphertext, intent.tag);
      assert.equal(
        rejection(() =>
          bindStore(db, { dataKeyCheck: checkA, legacyStoreGeneration: null }),
        ).reason,
        'data_key_check_missing',
      );
      assert.deepEqual(meta(db), { schema_version: '12' });
    } finally {
      db.close();
    }
  });
  // 0001 だけの DB には照合値を置けない。
  await withTempDir((dir) => {
    const db = openWriteConnection(databasePath(dir), { platform: 'macos' });
    try {
      applyMigrations(db, loadMigrations().slice(0, 1));
      assert.equal(
        rejection(() =>
          bindStore(db, { dataKeyCheck: checkA, legacyStoreGeneration: null }),
        ).reason,
        'schema_too_old',
      );
    } finally {
      db.close();
    }
  });
  // 0002 の CHECK: 照合値は 16 進 64 桁だけ、キーは data_key_check:<key_id> の形だけ。
  await withTempDir((dir) => {
    const db = openMigrated(databasePath(dir));
    try {
      const insert = db.prepare(
        'INSERT INTO schema_meta (key, value) VALUES (?, ?)',
      );
      assert.throws(
        () => insert.run('data_key_check:data-key-v1', 'xyz'),
        /CHECK constraint failed/u,
      );
      assert.throws(
        () => insert.run('data_key_check:data-key-v1', CHECK_A.toUpperCase()),
        /CHECK constraint failed/u,
      );
      assert.throws(
        () => insert.run('data_key_check:', CHECK_A),
        /CHECK constraint failed/u,
      );
      assert.throws(
        () => insert.run('key_check', CHECK_A),
        /CHECK constraint failed/u,
      );
      insert.run('data_key_check:data-key-v1', CHECK_A);
      assert.equal(
        bindStore(db, { dataKeyCheck: checkA, legacyStoreGeneration: null })
          .dataKeyCheck,
        'matched',
      );
    } finally {
      db.close();
    }
  });
});

test('a corrupted DB fails the integrity check and no binding is written', async () => {
  await withTempDir((dir) => {
    const path = databasePath(dir);
    const db = openMigrated(path);
    let rootPage: number;
    let pageSize: number;
    try {
      const insert = db.prepare(
        "INSERT INTO devices VALUES (?, '合成の端末', 'macos', 0, ?, 1000, NULL, NULL)",
      );
      for (let index = 0; index < 50; index += 1)
        insert.run(`dev-${index}`, Buffer.alloc(32, index));
      checkDatabaseIntegrity(db);
      rootPage = (
        db
          .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'devices'")
          .get() as { rootpage: number }
      ).rootpage;
      pageSize = db.pragma('page_size', { simple: true }) as number;
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    // devices の b-tree の根のページを 0 で塗りつぶす（ページの種類が不正になる）。
    const handle = openSync(path, 'r+');
    try {
      writeSync(
        handle,
        Buffer.alloc(pageSize),
        0,
        pageSize,
        (rootPage - 1) * pageSize,
      );
    } finally {
      closeSync(handle);
    }
    const reopened = openMigrated(path);
    try {
      assert.equal(
        rejection(() =>
          bindStore(reopened, {
            dataKeyCheck: checkA,
            legacyStoreGeneration: null,
          }),
        ).reason,
        'database_integrity_failed',
      );
      assert.deepEqual(meta(reopened), { schema_version: '12' });
    } finally {
      reopened.close();
    }
  });
});

test('the DB worker binds before accepting commands and refuses to start on a mismatch', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    const first = await DbWorkerClient.start({
      path,
      binding: { dataKeyCheck: checkA, legacyStoreGeneration: LEGACY },
    });
    try {
      assert.equal(first.storeGeneration, LEGACY);
      assert.equal(first.schemaVersion, 12);
      assert.deepEqual(first.binding, {
        storeGeneration: LEGACY,
        storeGenerationSource: 'state_file',
        dataKeyCheck: 'stored',
      });
    } finally {
      await first.close();
    }
    let refused: unknown = null;
    try {
      const started = await DbWorkerClient.start({
        path,
        binding: { dataKeyCheck: checkB, legacyStoreGeneration: null },
      });
      // 起動してしまった worker は閉じてから失敗にする（試験の後に残さない）。
      await started.close();
    } catch (error) {
      refused = error;
    }
    assert(
      refused instanceof StorageError &&
        refused.reason === 'data_key_check_mismatch',
      String(refused),
    );
    const again = await DbWorkerClient.start({
      path,
      binding: { dataKeyCheck: checkA, legacyStoreGeneration: null },
    });
    try {
      assert.deepEqual(again.binding, {
        storeGeneration: LEGACY,
        storeGenerationSource: 'database',
        dataKeyCheck: 'matched',
      });
    } finally {
      await again.close();
    }
  });
});
