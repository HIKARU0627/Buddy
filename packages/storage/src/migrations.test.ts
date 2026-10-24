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
  executeBudgetOp,
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
// 0003（ADR 0022）: 自宅の登録値と端末ごとの最新の報告。
const thirdBytes = readFileSync(
  new URL('0003_home_network.sql', MIGRATIONS_DIR),
);
const thirdSha = createHash('sha256').update(thirdBytes).digest('hex');
// 0004（ADR 0029）: 発言への応答。
const fourthBytes = readFileSync(
  new URL('0004_turn_responses.sql', MIGRATIONS_DIR),
);
const fourthSha = createHash('sha256').update(fourthBytes).digest('hex');
// 0005（ADR 0030）: 試行の superseded と用事の表。
const fifthBytes = readFileSync(new URL('0005_runner.sql', MIGRATIONS_DIR));
const fifthSha = createHash('sha256').update(fifthBytes).digest('hex');
// 0006（ADR 0036）: 予算の予約の作り直し・超過の承認・予算月の状態。
const sixthBytes = readFileSync(new URL('0006_budget.sql', MIGRATIONS_DIR));
const sixthSha = createHash('sha256').update(sixthBytes).digest('hex');
// 0007（ADR 0037）: 予約の送出意図と予算月の確かめ直し。
const seventhBytes = readFileSync(
  new URL('0007_budget_gate.sql', MIGRATIONS_DIR),
);
const seventhSha = createHash('sha256').update(seventhBytes).digest('hex');
// 0008（ADR 0042）: 付帯クレジットの観測の採用と、予約のクレジットの結び付け。
const eighthBytes = readFileSync(
  new URL('0008_budget_credit.sql', MIGRATIONS_DIR),
);
const eighthSha = createHash('sha256').update(eighthBytes).digest('hex');
// 0009（ADR 0046）: 音声の世代・入出力の停止の状態・live_sessions の世代の列と trigger。
const ninthBytes = readFileSync(
  new URL('0009_voice_epochs.sql', MIGRATIONS_DIR),
);
const ninthSha = createHash('sha256').update(ninthBytes).digest('hex');
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

test('0001 to 0009 apply to a temporary file DB: 52 STRICT tables, version 9 and the content hashes', () => {
  withTempDir((dir) => {
    const path = join(dir, 'buddy.sqlite');
    const db = openWriteConnection(path, { platform: 'macos' });
    try {
      assert.equal(readSchemaVersion(db), 0);
      assert.deepEqual(applyMigrations(db), {
        from: 0,
        to: 9,
        applied: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      });
      const tables = tableNames(db);
      assert.equal(tables.length, 52);
      assert.deepEqual(tables, Object.keys(TABLE_POLICIES).sort());
      const strict = db
        .prepare(
          "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string; strict: number }[];
      assert.equal(strict.length, 52);
      for (const row of strict) assert.equal(row.strict, 1, row.name);
      assert.deepEqual(meta(db), {
        'migration_sha256:0001': initialSha,
        'migration_sha256:0002': secondSha,
        'migration_sha256:0003': thirdSha,
        'migration_sha256:0004': fourthSha,
        'migration_sha256:0005': fifthSha,
        'migration_sha256:0006': sixthSha,
        'migration_sha256:0007': seventhSha,
        'migration_sha256:0008': eighthSha,
        'migration_sha256:0009': ninthSha,
        schema_version: '9',
      });
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      db.close();
    }
    // 開き直しても版は 9 のまま、適用するものはない。
    const reopened = openWriteConnection(path, { platform: 'macos' });
    try {
      assert.equal(readSchemaVersion(reopened), 9);
      assert.deepEqual(applyMigrations(reopened), {
        from: 9,
        to: 9,
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
      [3, '0003_home_network.sql'],
      [4, '0004_turn_responses.sql'],
      [5, '0005_runner.sql'],
      [6, '0006_budget.sql'],
      [7, '0007_budget_gate.sql'],
      [8, '0008_budget_credit.sql'],
      [9, '0009_voice_epochs.sql'],
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

// 0005（ADR 0030）: 既存の試行・工程が入った版 4 の DB を更新しても、全行・索引・外部キーが残る（レビュー P1）。
test('0005 upgrades a version 4 DB holding attempts and steps and keeps every row, index and foreign key', () => {
  withTempDir((dir) => {
    const path = join(dir, 'buddy.sqlite');
    const db = openWriteConnection(path, { platform: 'macos' });
    try {
      const bundled = loadMigrations();
      applyMigrations(db, bundled.slice(0, 4));
      const h1 = '1'.repeat(64);
      for (const sql of [
        "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES ('b-1', 'operation_intent', 'operation_versions', 'op-1', 1, 1, 'k1', X'000000000000000000000001', X'00', X'00000000000000000000000000000000', 1000, NULL)",
        "INSERT INTO operations VALUES ('op-1', NULL, 'mail.labels.change', 'remote_mutation', 1, 'unknown_held', 5, 1000, NULL)",
        `INSERT INTO operation_versions VALUES ('op-1', 1, '${h1}', 'b-1', 1000)`,
        "INSERT INTO devices (device_id, device_name, platform, hub_local, token_hash, registered_at) VALUES ('dev-1', 'd', 'macos', 0, X'0000000000000000000000000000000000000000000000000000000000000000', 1000)",
        `INSERT INTO approvals VALUES ('ap-1', 'op-1', 1, '${h1}', 'screen', 'dev-1', 'pv-1', NULL, 'valid', 1100)`,
        "INSERT INTO operation_attempts VALUES ('at-1', 'op-1', 1, 'ap-1', 'unknown_held', 1200, NULL, 'unknown', 1150)",
        "INSERT INTO operation_steps VALUES ('at-1', '1-apply_labels', 'apply_labels', NULL, 1200, 'unknown')",
      ])
        db.exec(sql);
      assert.deepEqual(applyMigrations(db, bundled.slice(0, 5)), {
        from: 4,
        to: 5,
        applied: [5],
      });
      assert.deepEqual(db.prepare('SELECT * FROM operation_attempts').all(), [
        {
          attempt_id: 'at-1',
          operation_id: 'op-1',
          content_version: 1,
          approval_id: 'ap-1',
          status: 'unknown_held',
          dispatch_intent_at: 1200,
          external_id: null,
          result_status: 'unknown',
          created_at: 1150,
        },
      ]);
      assert.deepEqual(db.prepare('SELECT * FROM operation_steps').all(), [
        {
          attempt_id: 'at-1',
          step_id: '1-apply_labels',
          step_kind: 'apply_labels',
          external_id: null,
          dispatch_intent_at: 1200,
          result_status: 'unknown',
        },
      ]);
      assert.deepEqual(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name IN ('operation_attempts', 'operation_steps') AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .pluck()
          .all(),
        [
          'operation_attempts_one_active',
          'operation_attempts_one_per_approval',
        ],
      );
      // 外部キーは新しい表を指す（存在しない試行の工程・存在しない操作の試行は拒否）。
      assert.deepEqual(
        db
          .prepare('PRAGMA foreign_key_list(operation_steps)')
          .all()
          .map((row) => (row as { table: string }).table),
        ['operation_attempts'],
      );
      assert.throws(
        () =>
          db.exec(
            "INSERT INTO operation_steps VALUES ('at-x', '1-apply_labels', 'apply_labels', NULL, NULL, NULL)",
          ),
        /FOREIGN KEY/u,
      );
      assert.throws(
        () =>
          db.exec(
            "INSERT INTO operation_attempts VALUES ('at-2', 'op-x', 1, 'ap-x', 'preparing', NULL, NULL, NULL, 1300)",
          ),
        /FOREIGN KEY/u,
      );
      // 0001 の一意の索引も働く（一つの承認に有効な試行は一つ）。
      db.exec(
        "UPDATE operation_attempts SET status = 'reconciling' WHERE attempt_id = 'at-1'",
      );
      assert.throws(
        () =>
          db.exec(
            "INSERT INTO operation_attempts VALUES ('at-3', 'op-1', 1, 'ap-1', 'preparing', NULL, NULL, NULL, 1300)",
          ),
        /UNIQUE/u,
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });
});

// 0006（ADR 0036）: 予約（各状態）と会話の接続が入った版 5 の DB を更新しても、全行・外部キーが残り、新しい列は
// 0001 の行から求められる値（手での精算の印）か NULL（記録のない時刻）、profile は記録なしの印になる。
// 期待値は手で書いた値。金額は合成の通貨 XTS と縮めた値（18 桁の上限の 1 行を含む）。
test('0008 upgrades a version 7 DB holding reservations, keeps every row, gives the new columns their defaults and adds the observation table and triggers', () => {
  withTempDir((dir) => {
    const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
      platform: 'macos',
    });
    try {
      applyMigrations(db, loadMigrations().slice(0, 7));
      const columns =
        'reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, actual_gross, credit_applied, additional_spend, provider_reconciliation_id, settlement_kind, credit_cycle_id, settled_at, created_at';
      for (const sql of [
        `INSERT INTO budget_reservations (${columns}) VALUES ('r-1', 'q-1', 'claude.synthetic.v1', 'llm', 'llm', 'owner_request', '2030-10', 'XTS', 'price-1', 10, 20, 'reserved', 1, NULL, NULL, NULL, NULL, NULL, 'anthropic:2030-10-01', NULL, 1100)`,
        `INSERT INTO budget_reservations (${columns}) VALUES ('r-2', 'q-2', 'claude.synthetic.v1', 'llm', 'llm', 'owner_request', '2030-10', 'XTS', 'price-1', 10, 20, 'settled', 1, 15, 5, 10, 'anthropic:p-2', 'provider', 'anthropic:2030-10-01', 1500, 1200)`,
        `INSERT INTO budget_reservations (${columns}) VALUES ('r-3', 'q-3', 'intent.luna.v1', 'llm', 'llm', 'owner_request', '2030-10', 'XTS', 'price-1', 10, 20, 'usage_unknown', 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1300)`,
      ])
        db.exec(sql);
      // 0008 の移し方だけを見る（0009 は 0009 の試験で見る）。
      assert.deepEqual(applyMigrations(db, loadMigrations().slice(0, 8)), {
        from: 7,
        to: 8,
        applied: [8],
      });
      assert.deepEqual(
        db
          .prepare(
            'SELECT reservation_id, status, credit_applied, additional_spend, credit_cycle_id, credit_estimate, credit_settled_seq, credit_expires_at, credit_observation_seq FROM budget_reservations ORDER BY reservation_id',
          )
          .all(),
        [
          {
            reservation_id: 'r-1',
            status: 'reserved',
            credit_applied: null,
            additional_spend: null,
            credit_cycle_id: 'anthropic:2030-10-01',
            credit_estimate: 0,
            credit_settled_seq: null,
            credit_expires_at: null,
            credit_observation_seq: null,
          },
          {
            reservation_id: 'r-2',
            status: 'settled',
            credit_applied: 5,
            additional_spend: 10,
            credit_cycle_id: 'anthropic:2030-10-01',
            // 精算済みの行は、確認済みの消費（credit_applied 5）を見積もりへ引き継ぐ（連番は順序が分からないので空）。
            credit_estimate: 5,
            credit_settled_seq: null,
            credit_expires_at: null,
            credit_observation_seq: null,
          },
          {
            reservation_id: 'r-3',
            status: 'usage_unknown',
            credit_applied: null,
            additional_spend: null,
            credit_cycle_id: null,
            credit_estimate: 0,
            credit_settled_seq: null,
            credit_expires_at: null,
            credit_observation_seq: null,
          },
        ],
      );
      assert.equal(
        db
          .prepare('SELECT count(*) FROM budget_credit_observations')
          .pluck()
          .get(),
        0,
      );
      assert.deepEqual(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND (name LIKE 'budget_credit%' OR name LIKE 'budget_reservations_credit%') ORDER BY name",
          )
          .pluck()
          .all(),
        [
          'budget_credit_observations_cycle_forward',
          'budget_credit_observations_no_delete',
          'budget_credit_observations_no_replace',
          'budget_credit_observations_no_update',
          'budget_credit_observations_time_forward',
          'budget_reservations_credit_binding_fixed',
          'budget_reservations_credit_binding_insert',
          'budget_reservations_credit_cycle_fixed',
          'budget_reservations_credit_estimate_fixed',
          'budget_reservations_credit_split_valid',
        ],
      );
      // 移した精算済みの行の消費（5）は、精算より前に観測した基準なら台帳から引き、後に観測した基準なら引かない（連番がないので
      // 観測の時刻と精算の時刻で比べる）。精算前の周期付きの行 r-1 の M 20 は未精算として数える。観測は表へ直接書く（手で書いた値）。
      const observe = db.prepare(
        "INSERT INTO budget_credit_observations (observation_seq, cycle_id, cycle_start, observed_at, expires_at, status, shared, organization_ref, balance_currency, balance_amount, content_id, recorded_at) VALUES (?, 'anthropic:2030-10-01', 0, ?, 100000, 'observed', 0, 'synthetic-organization', 'XXX', 40, ?, 1)",
      );
      observe.run(1, 1000, 'a'.repeat(64));
      observe.run(2, 2000, 'b'.repeat(64));
      const ledgerAt = (basisSeq: number) => {
        const result = executeBudgetOp(
          db,
          {
            kind: 'budget.credit_ledger',
            cycle_id: 'anthropic:2030-10-01',
            basis_seq: basisSeq,
            exclude_reservation_id: null,
          },
          { platform: 'macos', halted: false },
        ).result;
        assert.equal(result.ok, true);
        return result.ok ? result.value : null;
      };
      assert.deepEqual(ledgerAt(1), {
        allocated_since: '5',
        outstanding: '20',
      });
      assert.deepEqual(ledgerAt(2), {
        allocated_since: '0',
        outstanding: '20',
      });
      // 移した行の周期は、受付で結び付けたものではないので変えられない（精算前の行）。
      assert.throws(
        () =>
          db.exec(
            "UPDATE budget_reservations SET credit_cycle_id = 'anthropic:2030-11-01' WHERE reservation_id = 'r-1'",
          ),
        /budget_credit_binding_fixed/u,
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      db.close();
    }
  });
});

test('0006 upgrades a version 5 DB holding reservations and a live session and keeps every row and foreign key', () => {
  withTempDir((dir) => {
    const path = join(dir, 'buddy.sqlite');
    const db = openWriteConnection(path, { platform: 'macos' });
    try {
      const bundled = loadMigrations();
      applyMigrations(db, bundled.slice(0, 5));
      const columns =
        'reservation_id, request_id, pool_id, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, approval_id, actual_gross, credit_applied, additional_spend, provider_reconciliation_id, credit_cycle_id, overrun_reviewed, created_at';
      for (const sql of [
        "INSERT INTO devices (device_id, device_name, platform, hub_local, token_hash, registered_at) VALUES ('dev-1', 'd', 'macos', 0, X'0000000000000000000000000000000000000000000000000000000000000000', 1000)",
        "INSERT INTO sessions VALUES ('s-1', 'normal', 'dev-1', 1, NULL, 1000, NULL)",
        `INSERT INTO budget_reservations (${columns}) VALUES ('r-1', 'q-1', 'llm', '2030-10', 'XTS', 'price-1', 10, 20, 'reserved', 1, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1100)`,
        `INSERT INTO budget_reservations (${columns}) VALUES ('r-2', 'q-2', 'llm', '2030-10', 'XTS', 'price-1', 10, 20, 'usage_unknown', 2, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1200)`,
        `INSERT INTO budget_reservations (${columns}) VALUES ('r-3', 'q-3', 'llm', '2030-09', 'XTS', 'price-1', 10, 20, 'settled', 1, NULL, 15, 0, 15, 'p-3', NULL, 0, 1300)`,
        `INSERT INTO budget_reservations (${columns}) VALUES ('r-4', 'q-4', 'overage', '2030-09', 'XTS', 'price-1', 10, 20, 'settled', 1, 'ap-4', 30, 0, 30, 'manual:inv-4', NULL, 1, 1400)`,
        `INSERT INTO budget_reservations (${columns}) VALUES ('r-5', 'q-5', 'voice', '2030-10', 'XTS', 'price-1', 0, 999999999999999999, 'released', 1, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1500)`,
        "INSERT INTO live_sessions VALUES ('ls-1', 'dev-1', 's-1', 'conversation', 'ready', 1, 'open', NULL, 'r-1', 1100, NULL, NULL)",
      ])
        db.exec(sql);
      // 0006 の移し方だけを見る（0009 の列は 0009 の試験で見る）。
      assert.deepEqual(applyMigrations(db, bundled.slice(0, 8)), {
        from: 5,
        to: 8,
        applied: [6, 7, 8],
      });
      const rows = db
        .prepare(
          'SELECT reservation_id, request_id, profile_id, pool_id, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, approval_id, actual_gross, credit_applied, additional_spend, provider_reconciliation_id, settlement_kind, credit_cycle_id, settled_at, overrun_reviewed, overrun_reviewed_at, created_at FROM budget_reservations ORDER BY reservation_id',
        )
        .safeIntegers(true)
        .all();
      const base = {
        profile_id: 'legacy:unrecorded',
        currency: 'XTS',
        price_version: 'price-1',
        credit_cycle_id: null,
        settled_at: null,
        overrun_reviewed_at: null,
      };
      const open = {
        approval_id: null,
        actual_gross: null,
        credit_applied: null,
        additional_spend: null,
        provider_reconciliation_id: null,
        settlement_kind: null,
        overrun_reviewed: 0n,
      };
      assert.deepEqual(rows, [
        {
          ...base,
          ...open,
          reservation_id: 'r-1',
          request_id: 'q-1',
          pool_id: 'llm',
          budget_month: '2030-10',
          reserved_amount: 10n,
          max_liability: 20n,
          status: 'reserved',
          reservation_revision: 1n,
          created_at: 1100n,
        },
        {
          ...base,
          ...open,
          reservation_id: 'r-2',
          request_id: 'q-2',
          pool_id: 'llm',
          budget_month: '2030-10',
          reserved_amount: 10n,
          max_liability: 20n,
          status: 'usage_unknown',
          reservation_revision: 2n,
          created_at: 1200n,
        },
        {
          ...base,
          reservation_id: 'r-3',
          request_id: 'q-3',
          pool_id: 'llm',
          budget_month: '2030-09',
          reserved_amount: 10n,
          max_liability: 20n,
          status: 'settled',
          reservation_revision: 1n,
          approval_id: null,
          actual_gross: 15n,
          credit_applied: 0n,
          additional_spend: 15n,
          provider_reconciliation_id: 'p-3',
          settlement_kind: 'provider',
          overrun_reviewed: 0n,
          created_at: 1300n,
        },
        {
          ...base,
          reservation_id: 'r-4',
          request_id: 'q-4',
          pool_id: 'overage',
          budget_month: '2030-09',
          reserved_amount: 10n,
          max_liability: 20n,
          status: 'settled',
          reservation_revision: 1n,
          approval_id: 'ap-4',
          actual_gross: 30n,
          credit_applied: 0n,
          additional_spend: 30n,
          provider_reconciliation_id: 'manual:inv-4',
          settlement_kind: 'manual',
          overrun_reviewed: 1n,
          created_at: 1400n,
        },
        {
          ...base,
          ...open,
          reservation_id: 'r-5',
          request_id: 'q-5',
          pool_id: 'voice',
          budget_month: '2030-10',
          reserved_amount: 0n,
          max_liability: 999999999999999999n,
          status: 'released',
          reservation_revision: 1n,
          created_at: 1500n,
        },
      ]);
      // 受付の要求の識別: 0001 の行は計上した枠を要求した枠とし、起点は記録なし（NULL）。
      assert.deepEqual(
        db
          .prepare(
            'SELECT reservation_id, requested_pool_id, origin FROM budget_reservations ORDER BY reservation_id',
          )
          .all(),
        [
          { reservation_id: 'r-1', requested_pool_id: 'llm', origin: null },
          { reservation_id: 'r-2', requested_pool_id: 'llm', origin: null },
          { reservation_id: 'r-3', requested_pool_id: 'llm', origin: null },
          { reservation_id: 'r-4', requested_pool_id: 'overage', origin: null },
          { reservation_id: 'r-5', requested_pool_id: 'voice', origin: null },
        ],
      );
      assert.deepEqual(db.prepare('SELECT * FROM live_sessions').all(), [
        {
          live_session_id: 'ls-1',
          device_id: 'dev-1',
          session_id: 's-1',
          purpose: 'conversation',
          control_state: 'ready',
          control_epoch: 1,
          closure: 'open',
          usage_seconds: null,
          reservation_id: 'r-1',
          started_at: 1100,
          ended_at: null,
          end_reason: null,
        },
      ]);
      // 外部キーは作り直した予約の表を指す（存在しない予約の接続は拒否）。
      assert.deepEqual(
        db
          .prepare('PRAGMA foreign_key_list(live_sessions)')
          .all()
          .map((row) => (row as { table: string }).table)
          .sort(),
        ['budget_reservations', 'devices', 'sessions'],
      );
      assert.throws(
        () =>
          db.exec(
            "INSERT INTO live_sessions VALUES ('ls-2', 'dev-1', 's-1', 'conversation', 'ready', 1, 'open', NULL, 'r-x', 1100, NULL, NULL)",
          ),
        /FOREIGN KEY/u,
      );
      // 0001 の索引と trigger、0006 の索引も働く。
      assert.deepEqual(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'budget_reservations' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .pluck()
          .all(),
        [
          'budget_reservations_month',
          'budget_reservations_one_per_approval',
          'budget_reservations_open',
        ],
      );
      assert.throws(
        () =>
          db.exec(
            "UPDATE budget_reservations SET budget_month = '2030-11' WHERE reservation_id = 'r-1'",
          ),
        /budget_month_fixed/u,
      );
      // 解放済みの予約は精算できない。
      assert.throws(
        () =>
          db.exec(
            "UPDATE budget_reservations SET status = 'settled', actual_gross = 1, credit_applied = 0, additional_spend = 1, provider_reconciliation_id = 'p-5', settlement_kind = 'provider' WHERE reservation_id = 'r-5'",
          ),
        /budget_reservation_released/u,
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      db.close();
    }
  });
});
