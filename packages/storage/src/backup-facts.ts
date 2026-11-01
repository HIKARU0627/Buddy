// バックアップの封筒に書く DB の事実（設計 03、ADR 0040・0047・0055）。
// 稼働中の DB（セットアップの検査）と、スナップショットの写し（封筒の値の正本）の両方から同じ関数で読む。
// 台帳の連鎖が壊れている（hash・項目の数の食い違い）DB は読めずに ForgetRejection を投げる（壊れた台帳の封筒を作らない）。

import type { SqliteDatabase } from './connection.js';
import { exportForgetLedger } from './forget-store.js';
import { readSchemaVersion, readStoreGeneration } from './migrations.js';

export interface BackupFacts {
  readonly store_generation: string | null;
  readonly db_schema_version: number;
  readonly forgetting_generation: string;
  // 台帳の系譜。まだ付けていなければ null（バックアップの前に付ける）。
  readonly ledger_id: string | null;
  readonly ledger_head_hash: string;
  // 台帳・記憶の HMAC に使っている鍵の ID（schema_meta。未記録は null）。
  readonly recorded_ledger_key_id: string | null;
  // DB の暗号文（sealed_blobs）が使っているデータ鍵の ID（重複なし・辞書順）。
  readonly db_blob_key_ids: readonly string[];
  // アプリの表の名前（SQLite の内部の表 sqlite_* を除く。辞書順）。
  readonly tables: readonly string[];
}

export function readBackupFacts(db: SqliteDatabase): BackupFacts {
  return db.transaction((): BackupFacts => {
    const ledger = exportForgetLedger(db);
    const recorded = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'ledger_hmac_key_id'")
      .pluck()
      .get() as string | undefined;
    const keyIds = db
      .prepare('SELECT DISTINCT key_id FROM sealed_blobs ORDER BY key_id')
      .pluck()
      .all() as string[];
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all() as string[];
    return {
      store_generation: readStoreGeneration(db),
      db_schema_version: readSchemaVersion(db),
      forgetting_generation: ledger.head.forgetting_generation,
      ledger_id: ledger.ledger_id,
      ledger_head_hash: ledger.head.entry_hash,
      recorded_ledger_key_id: recorded ?? null,
      db_blob_key_ids: keyIds,
      tables,
    };
  })();
}
