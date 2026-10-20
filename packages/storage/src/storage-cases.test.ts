// 保存案 0001 の制約のシナリオ（tests/fixtures/storage-cases.json）を製品の better-sqlite3 で確かめる。
// 同じ fixture を scripts/storage.test.mjs が開発ツールの node:sqlite で検査している（ADR 0010 U18）。
// 期待値は fixture に手で書いた値。DB はメモリ上に作り、接続の PRAGMA と適用の部品は製品と同じものを使う。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applyConnectionPragmas, applyMigrations } from './index.js';
import type { SqliteDatabase } from './index.js';

interface StorageCases {
  readonly seed: readonly string[];
  readonly scenarios: readonly {
    readonly id: string;
    readonly steps: readonly (readonly [string, string])[];
  }[];
}

const cases = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/storage-cases.json', import.meta.url),
    'utf8',
  ),
) as StorageCases;

// better-sqlite3 の拡張エラーコードで分類する（node:sqlite 側はメッセージで分類している）。
function outcome(db: SqliteDatabase, sql: string): string {
  try {
    db.exec(sql);
    return 'ok';
  } catch (error) {
    if (!(error instanceof Database.SqliteError)) throw error;
    switch (error.code) {
      case 'SQLITE_CONSTRAINT_UNIQUE':
      case 'SQLITE_CONSTRAINT_PRIMARYKEY':
        return 'unique';
      case 'SQLITE_CONSTRAINT_CHECK':
        return 'check';
      case 'SQLITE_CONSTRAINT_FOREIGNKEY':
        return 'foreign_key';
      case 'SQLITE_CONSTRAINT_NOTNULL':
        return 'not_null';
      case 'SQLITE_CONSTRAINT_TRIGGER':
        return `trigger:${error.message}`;
      default:
        return `${error.code}:${error.message}`;
    }
  }
}

test('the storage constraint scenarios hold on better-sqlite3', () => {
  assert(cases.scenarios.length >= 20);
  for (const scenario of cases.scenarios) {
    const db = new Database(':memory:', { timeout: 0 });
    try {
      applyConnectionPragmas(db);
      applyMigrations(db);
      for (const sql of cases.seed) assert.equal(outcome(db, sql), 'ok', sql);
      for (const [index, [sql, expected]] of scenario.steps.entries())
        assert.equal(
          outcome(db, sql),
          expected,
          `${scenario.id} #${index + 1}: ${sql}`,
        );
    } finally {
      db.close();
    }
  }
});
