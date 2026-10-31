// バックアップの DB の命令（backup.facts・backup.record_setup。ADR 0055）。期待値は手書き。
// 台帳の系譜は、まだ忘れていない DB の設定のときにだけ付く。台帳の HMAC の鍵の ID は同じ系譜の中で変えない。

import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryOp, value } from './forget-test-support.js';
import type { BackupFacts, MemoryOp } from './index.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const LEDGER = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const OTHER_LEDGER = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const record = (
  ledger: string,
  keyId: string,
): Extract<MemoryOp, { kind: 'backup.record_setup' }> => ({
  kind: 'backup.record_setup',
  ledger_id: ledger,
  ledger_hmac_key_id: keyId,
});

test('backup.facts: 新しい DB の事実（世代 0・系譜なし・鍵の記録なし・表の一覧）', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const facts = value<BackupFacts>(memoryOp(db, { kind: 'backup.facts' }));
      assert.equal(facts.db_schema_version, 12);
      assert.equal(facts.forgetting_generation, '0');
      assert.equal(facts.ledger_head_hash, '0'.repeat(64));
      assert.equal(facts.ledger_id, null);
      assert.equal(facts.recorded_ledger_key_id, null);
      assert.deepEqual(facts.db_blob_key_ids, []);
      assert.match(facts.store_generation ?? '', /^[0-9a-f-]{36}$/u);
      // 表の一覧は SQLite の内部の表（sqlite_*）を含まず、辞書順。
      assert.equal(
        facts.tables.some((name) => name.startsWith('sqlite_')),
        false,
      );
      assert.deepEqual([...facts.tables], [...facts.tables].sort());
      assert.equal(facts.tables.includes('forget_ledger'), true);
      assert.equal(facts.tables.includes('sealed_blobs'), true);
    } finally {
      db.close();
    }
  });
});

test('backup.record_setup: 台帳が空なら系譜と鍵の ID を記録し、同じ呼び出しを繰り返しても変わらない', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const first = value<{
        ledger_id: string;
        ledger_hmac_key_id: string;
        forgetting_generation: string;
      }>(memoryOp(db, record(LEDGER, 'ledger-hmac-aaaa')));
      assert.deepEqual(first, {
        ledger_id: LEDGER,
        ledger_hmac_key_id: 'ledger-hmac-aaaa',
        forgetting_generation: '0',
      });
      const facts = value<BackupFacts>(memoryOp(db, { kind: 'backup.facts' }));
      assert.equal(facts.ledger_id, LEDGER);
      assert.equal(facts.recorded_ledger_key_id, 'ledger-hmac-aaaa');
      // 同じ鍵の ID なら成功し、系譜は新しい UUID を渡しても変わらない。
      const again = value<{ ledger_id: string }>(
        memoryOp(db, record(OTHER_LEDGER, 'ledger-hmac-aaaa')),
      );
      assert.equal(again.ledger_id, LEDGER);
    } finally {
      db.close();
    }
  });
});

test('backup.record_setup: 同じ系譜で鍵の ID を変える要求は拒否し、何も書かない', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      value(memoryOp(db, record(LEDGER, 'ledger-hmac-aaaa')));
      const result = memoryOp(db, record(LEDGER, 'ledger-hmac-bbbb'));
      assert.deepEqual(result, {
        ok: false,
        outcome: 'rejected',
        reasons: ['ledger_key_id_conflict'],
      });
      const facts = value<BackupFacts>(memoryOp(db, { kind: 'backup.facts' }));
      assert.equal(facts.recorded_ledger_key_id, 'ledger-hmac-aaaa');
    } finally {
      db.close();
    }
  });
});

test('backup.record_setup: 忘却を 1 件でもした DB に系譜がなければ、系譜を付けずに拒否する', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      // 系譜のない台帳（0012 の起動の確認を通っていない状態）の世代 1 を作る。
      db.exec(
        "INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at, entry_hash, item_count) VALUES (1, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1000, '" +
          'ab'.repeat(32) +
          "', 1)",
      );
      db.exec(
        "INSERT INTO forget_ledger_items (forgetting_generation, item_kind, item_id) VALUES (1, 'turn', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')",
      );
      const result = memoryOp(db, record(LEDGER, 'ledger-hmac-aaaa'));
      assert.deepEqual(result, {
        ok: false,
        outcome: 'rejected',
        reasons: ['ledger_lineage_missing'],
      });
      assert.equal(
        db
          .prepare(
            "SELECT count(*) FROM schema_meta WHERE key IN ('ledger_id', 'ledger_hmac_key_id')",
          )
          .pluck()
          .get(),
        0,
      );
    } finally {
      db.close();
    }
  });
});

test('backup.record_setup: 形の違う ID は拒否する', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      for (const [ledger, key, reason] of [
        ['not-a-uuid', 'ledger-hmac-aaaa', 'ledger_id_invalid'],
        [LEDGER, 'Bad Key', 'ledger_key_id_invalid'],
        [LEDGER, '', 'ledger_key_id_invalid'],
        [LEDGER, 'a'.repeat(65), 'ledger_key_id_invalid'],
      ] as const) {
        const result = memoryOp(db, record(ledger, key));
        assert.equal(result.ok, false);
        assert.deepEqual(result.ok ? [] : result.reasons, [reason]);
      }
      assert.equal(
        value<BackupFacts>(memoryOp(db, { kind: 'backup.facts' })).ledger_id,
        null,
      );
    } finally {
      db.close();
    }
  });
});
