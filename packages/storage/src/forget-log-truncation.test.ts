// U440（ADR 0186）: 忘却の命令（forget.apply）の COMMIT の後の WAL の切り詰め（retention.checkpoint。掃除の後始末と同じ
// wal_checkpoint(TRUNCATE)）。忘れた行の暗号文のバイト列が、切り詰めの後は DB のファイルにも WAL にも残らないこと、消して
// いない行の暗号文は DB に残ること（陽性の対照）、切り詰めが busy・失敗でも忘却は確定したままで、次の切り詰めで消えることを
// 確かめる。暗号文は試験用の乱数で、期待値（どのファイルにあるか）は手で書いた。切り詰めを頼む時機と再試行は Core の試験
// （apps/core の retention-sweeper.test.ts・forget-service.test.ts）で確かめる。

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { executeRetentionOp } from './index.js';
import type {
  CheckpointValue,
  ForgetApplyValue,
  RetentionOp,
  SqliteDatabase,
} from './index.js';
import {
  M,
  M2,
  M_OTHER,
  count,
  forgetM,
  value,
  withWorld,
} from './forget-test-support.js';

function retention(db: SqliteDatabase, op: RetentionOp) {
  return executeRetentionOp(db, op, { platform: 'macos', halted: false });
}

function checkpoint(db: SqliteDatabase): CheckpointValue {
  const done = retention(db, { kind: 'retention.checkpoint' });
  assert.equal(done.halt, false);
  assert.equal(done.result.ok, true, JSON.stringify(done.result));
  return (done.result.ok ? done.result.value : null) as CheckpointValue;
}

// DB のファイルと WAL のどちらに、指定のバイト列があるか（'db'・'wal' の順）。
function filesHolding(db: SqliteDatabase, bytes: Buffer): string[] {
  const found: string[] = [];
  for (const [name, path] of [
    ['db', db.name],
    ['wal', `${db.name}-wal`],
  ] as const)
    if (existsSync(path) && readFileSync(path).includes(bytes))
      found.push(name);
  return found;
}

const walSize = (db: SqliteDatabase): number =>
  existsSync(`${db.name}-wal`) ? statSync(`${db.name}-wal`).size : 0;

// 記憶の封筒の暗号文（本文と対象の鍵）。
function ciphertexts(db: SqliteDatabase, memoryIds: readonly string[]) {
  return memoryIds.flatMap(
    (id) =>
      db
        .prepare(
          "SELECT ciphertext FROM sealed_blobs WHERE owner_table = 'memories' AND owner_id = ? ORDER BY purpose",
        )
        .pluck()
        .all(id) as Buffer[],
  );
}

// 忘却の世界（forget-test-support の seedWorld）で M を忘れると、M と M から作った M2 が消え、M_OTHER は残る。
function seen(db: SqliteDatabase) {
  const forgotten = ciphertexts(db, [M, M2]);
  const kept = ciphertexts(db, [M_OTHER]);
  assert.equal(forgotten.length, 4);
  assert.equal(kept.length, 2);
  return { forgotten, kept };
}

test('U440: without a checkpoint the forgotten ciphertext stays in the WAL; after the checkpoint it is in neither file and kept rows are in the DB', async () => {
  await withWorld((db) => {
    const { forgotten, kept } = seen(db);
    // 合成の世界は書き込んだまま checkpoint していない。暗号文は WAL のフレームにある（探し方の陽性の対照）。
    for (const bytes of [...forgotten, ...kept])
      assert.deepEqual(filesHolding(db, bytes), ['wal']);
    value<ForgetApplyValue>(forgetM(db));
    assert.equal(
      count(
        db,
        'SELECT COUNT(*) FROM memories WHERE memory_id IN (?, ?)',
        M,
        M2,
      ),
      0,
    );
    // 忘却の命令だけでは、書き込んだときの WAL のフレームに暗号文が残る（B06-09 の観測）。
    for (const bytes of forgotten)
      assert.deepEqual(filesHolding(db, bytes), ['wal']);
    const result = checkpoint(db);
    assert.equal(result.busy, 0);
    assert.equal(walSize(db), 0);
    // 消したページは secure_delete で 0 になっている。書き戻しの後は DB にも WAL にもない。
    for (const bytes of forgotten)
      assert.deepEqual(filesHolding(db, bytes), []);
    for (const bytes of kept) assert.deepEqual(filesHolding(db, bytes), ['db']);
  });
});

test('U440: a busy checkpoint keeps the forget committed and the next checkpoint after the reader ends removes the ciphertext', async () => {
  await withWorld((db) => {
    const { forgotten, kept } = seen(db);
    // 別の接続の読みの transaction（バックアップの写しの読みに当たる）。開いている間は切り詰められない。
    const reader = new Database(db.name, { timeout: 0 });
    try {
      reader.exec('BEGIN');
      assert.equal(
        reader.prepare('SELECT COUNT(*) FROM memories').pluck().get(),
        3,
      );
      value<ForgetApplyValue>(forgetM(db));
      const busy = checkpoint(db);
      assert.equal(busy.busy, 1);
      // 忘却は確定したまま（台帳の 1 件と、消えた記憶）。WAL には暗号文がまだある。
      assert.equal(count(db, 'SELECT COUNT(*) FROM forget_ledger'), 1);
      assert.equal(
        count(
          db,
          'SELECT COUNT(*) FROM memories WHERE memory_id IN (?, ?)',
          M,
          M2,
        ),
        0,
      );
      // 読みが終わっても、切り詰めるまで WAL に暗号文が残る（読む接続は開いたまま。閉じるとその接続の後始末で
      // WAL が書き戻され、次の切り詰めを確かめられない）。
      reader.exec('COMMIT');
      for (const bytes of forgotten)
        assert.ok(filesHolding(db, bytes).includes('wal'));
      assert.ok(walSize(db) > 0);
      const retried = checkpoint(db);
      assert.equal(retried.busy, 0);
      assert.equal(walSize(db), 0);
      for (const bytes of forgotten)
        assert.deepEqual(filesHolding(db, bytes), []);
      for (const bytes of kept)
        assert.deepEqual(filesHolding(db, bytes), ['db']);
    } finally {
      reader.close();
    }
  });
});

test('U440: a checkpoint that fails with a full disk is a rejection that keeps the forget and the writer, and the next checkpoint removes the ciphertext', async () => {
  await withWorld((db) => {
    const { forgotten, kept } = seen(db);
    value<ForgetApplyValue>(forgetM(db));
    // ログの切り詰めの pragma だけが SQLITE_FULL で落ちる接続。
    const full = new Proxy(db, {
      get(target, property) {
        if (property === 'pragma')
          return (source: string, ...rest: unknown[]) => {
            if (source.startsWith('wal_checkpoint'))
              throw new Database.SqliteError('simulated', 'SQLITE_FULL');
            return (target.pragma as (...args: unknown[]) => unknown)(
              source,
              ...rest,
            );
          };
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const failed = retention(full, { kind: 'retention.checkpoint' });
    assert.deepEqual(failed.result, {
      ok: false,
      outcome: 'rejected',
      reasons: ['database_full'],
    });
    assert.equal(failed.halt, false);
    assert.equal(count(db, 'SELECT COUNT(*) FROM forget_ledger'), 1);
    for (const bytes of forgotten)
      assert.deepEqual(filesHolding(db, bytes), ['wal']);
    assert.equal(checkpoint(db).busy, 0);
    for (const bytes of forgotten)
      assert.deepEqual(filesHolding(db, bytes), []);
    for (const bytes of kept) assert.deepEqual(filesHolding(db, bytes), ['db']);
  });
});
