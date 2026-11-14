// 復元の段階 4（DB の検証）に渡す事実を読む（設計 03 バックアップ・復元、ADR 0040・0047・0054）。
//
// 取り出した DB を開いて、整合性・外部キー・版・表の一覧・世代・系譜・忘却の世代を読む。台帳が壊れている DB は
// readBackupFacts が拒否するので、そのときは世代と系譜を null にして呼び出し側が db_integrity_failed にする。

import type { SqliteDatabase } from './connection.js';
import { readBackupFacts } from './backup-facts.js';
import { readSchemaVersion, readStoreGeneration } from './migrations.js';
import type { OperationBeforeRestore } from '@buddy/domain';

export interface RestoreFacts {
  readonly integrity_ok: boolean;
  readonly foreign_keys_ok: boolean;
  readonly schema_version: number;
  readonly tables: readonly string[];
  readonly store_generation: string | null;
  readonly ledger_id: string | null;
  readonly forgetting_generation: string | null;
}

export function readRestoreFacts(db: SqliteDatabase): RestoreFacts {
  const integrity = db.pragma('integrity_check', { simple: true }) === 'ok';
  const foreignKeys =
    (db.pragma('foreign_key_check') as unknown[]).length === 0;
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
  let ledgerId: string | null = null;
  let generation: string | null = null;
  try {
    const facts = readBackupFacts(db);
    ledgerId = facts.ledger_id;
    generation = facts.forgetting_generation;
  } catch {
    // 台帳の連鎖が壊れている。呼び出し側が db_integrity_failed にする（版・表は読める）。
  }
  return {
    integrity_ok: integrity,
    foreign_keys_ok: foreignKeys,
    schema_version: readSchemaVersion(db),
    tables,
    store_generation: readStoreGeneration(db),
    ledger_id: ledgerId,
    forgetting_generation: generation,
  };
}

// 段階 4 の「操作の隔離の計画が立つか」を確かめるための読み取り。承認の要否は呼び出し側が渡す
// （復元の後はすべて承認が要る側として扱う。ADR 0047 の LocalCommand は入力がなければ承認待ち）。
export function readRestoreOperationsForPlan(
  db: SqliteDatabase,
): OperationBeforeRestore[] {
  const rows = db
    .prepare(
      `SELECT o.operation_id, o.kind, o.effect_route, o.state, o.current_content_version,
              (SELECT count(*) FROM approvals a WHERE a.operation_id = o.operation_id AND a.status = 'valid') AS valid
         FROM operations o ORDER BY o.operation_id`,
    )
    .all() as {
    operation_id: string;
    kind: string;
    effect_route: string;
    state: string;
    current_content_version: number;
    valid: number;
  }[];
  return rows.map((row) => ({
    operation_id: row.operation_id,
    effect_route: row.effect_route,
    state: row.state,
    content_version: String(row.current_content_version),
    valid_approval_count: row.valid,
    approval_requirement: 'required',
  }));
}
