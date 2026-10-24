// 起動時のデータ移行（ADR 0051）: 0010 までの用事の正本を、確定 intent から用事自身の暗号文へ移す。
// 実際の AES-256-GCM で暗号化・復号する（合成の鍵）。期待値（題名・期限・本文）は手で書いた。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  executeRetentionOp,
  initStoreGeneration,
  loadMigrations,
  openTaskContent,
  openWriteConnection,
  sealOperationIntent,
  sealTaskContent,
} from '@buddy/storage';
import type {
  DataKeyMaterial,
  RetentionOp,
  RetentionOpKind,
  RetentionOpOutcome,
  SqliteDatabase,
  TaskContentRecord,
} from '@buddy/storage';
import {
  TaskMigrationError,
  migrateTaskContents,
} from './task-content-migration.js';
import type { TaskMigrationStore } from './task-content-migration.js';

// 合成の鍵（値に意味はない）。
const KEY: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: Buffer.alloc(32, 0x5a),
};
const OP_A = '00000000-0000-4000-8000-00000000000a';
const OP_B = '00000000-0000-4000-8000-00000000000b';
const TASK_A = '00000000-0000-4000-8000-0000000000aa';
const TASK_B = '00000000-0000-4000-8000-0000000000bb';
const DONE = 2_000_000;
const BODY_DUE = DONE + 7 * 86_400_000;

function taskIntent(operationId: string, title: string, body: string | null) {
  return {
    schema: 'buddy.operation.v1',
    operation_id: operationId,
    content_version: '1',
    permission_revision: '0',
    target: { list_id: 'inbox' },
    action: { kind: 'task.create', title, due: '2030-11-02', body },
    effects: { external_recipients: [], reconcile_scope: 'local_transaction' },
  };
}

// 版 10 の DB に、暗号文を持たない用事を置く。B の確定 intent は別の操作を所有者にして暗号化した（認証で失敗する）。
function seedVersion10(db: SqliteDatabase): void {
  applyMigrations(db, loadMigrations().slice(0, 10));
  initStoreGeneration(db, '00000000-0000-4000-8000-0000000000ff');
  const insert = (
    operationId: string,
    taskId: string,
    sealedFor: string,
    title: string,
  ): void => {
    const sealed = sealOperationIntent(
      KEY,
      { operationId: sealedFor, contentVersion: 1 },
      taskIntent(operationId, title, '合成のメモ'),
    );
    assert.equal(sealed.ok, true);
    if (!sealed.ok) return;
    const intent = sealed.intent;
    db.prepare(
      "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'operation_intent', 'operation_versions', ?, 1, ?, ?, ?, ?, ?, 1000, NULL)",
    ).run(
      intent.blob_id,
      operationId,
      intent.format_version,
      intent.key_id,
      Buffer.from(intent.nonce),
      Buffer.from(intent.ciphertext),
      Buffer.from(intent.tag),
    );
    db.prepare(
      "INSERT INTO operations VALUES (?, NULL, 'task.create', 'local_command', 1, 'succeeded', 3, 1000, ?, 'normal', NULL)",
    ).run(operationId, DONE);
    db.prepare('INSERT INTO operation_versions VALUES (?, 1, ?, ?, 1000)').run(
      operationId,
      sealed.content_hash,
      intent.blob_id,
    );
    db.prepare("INSERT INTO tasks VALUES (?, ?, 1, 'inbox', 'open', 1200)").run(
      taskId,
      operationId,
    );
  };
  insert(OP_A, TASK_A, OP_A, '合成の用事 A');
  insert(OP_B, TASK_B, OP_A, '合成の用事 B');
  applyMigrations(db);
}

function withDb(run: (db: SqliteDatabase) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-task-migration-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  return (async () => {
    try {
      seedVersion10(db);
      await run(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

function directStore(
  db: SqliteDatabase,
  intercept?: (op: RetentionOp) => RetentionOpOutcome<RetentionOpKind> | null,
): TaskMigrationStore {
  return {
    retention: <K extends RetentionOpKind>(
      op: Extract<RetentionOp, { kind: K }>,
    ): Promise<RetentionOpOutcome<K>> => {
      const replaced = intercept?.(op) ?? null;
      if (replaced !== null)
        return Promise.resolve(replaced as RetentionOpOutcome<K>);
      return Promise.resolve(
        executeRetentionOp(db, op, { platform: 'macos', halted: false })
          .result as RetentionOpOutcome<K>,
      );
    },
  };
}

function readTask(db: SqliteDatabase, taskId: string): TaskContentRecord {
  const result = executeRetentionOp(
    db,
    { kind: 'task.read', task_id: taskId },
    { platform: 'macos', halted: false },
  ).result;
  assert.equal(result.ok, true);
  return (result.ok ? result.value : null) as TaskContentRecord;
}

function taskContent(db: SqliteDatabase, taskId: string) {
  const record = readTask(db, taskId);
  assert.notEqual(record.content, null);
  if (record.content === null) return null;
  const opened = openTaskContent(KEY, taskId, record.content);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened.ok ? opened.content : null;
}

const taskBlobs = (db: SqliteDatabase, taskId: string): number =>
  db
    .prepare(
      "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'tasks' AND owner_id = ?",
    )
    .pluck()
    .get(taskId) as number;

test('migration re-encrypts the task content under the task, and leaves a task whose intent cannot be opened', async () => {
  await withDb(async (db) => {
    const report = await migrateTaskContents(directStore(db), KEY, () => 3000);
    assert.deepEqual(report, {
      migrated: 1,
      failed: [{ task_id: TASK_B, reason: 'authentication_failed' }],
      pending: 1,
    });
    assert.deepEqual(taskContent(db, TASK_A), {
      title: '合成の用事 A',
      due: '2030-11-02',
      body: '合成のメモ',
    });
    assert.equal(readTask(db, TASK_B).content, null);
    assert.equal(taskBlobs(db, TASK_B), 0);
    // 移せた用事の OP_A の本文は消せて、移せない用事の OP_B だけが残る（全体のゲートは置かない）。
    const erased = executeRetentionOp(
      db,
      { kind: 'retention.erase_body', operation_id: OP_A, now: BODY_DUE },
      { platform: 'macos', halted: false },
    ).result;
    assert.deepEqual(erased, {
      ok: true,
      value: { operation_id: OP_A, erased_versions: 1 },
    });
    assert.equal(
      db
        .prepare(
          'SELECT intent_blob_id FROM operation_versions WHERE operation_id = ?',
        )
        .pluck()
        .get(OP_A),
      null,
    );
    const blocked = executeRetentionOp(
      db,
      { kind: 'retention.erase_body', operation_id: OP_B, now: BODY_DUE },
      { platform: 'macos', halted: false },
    ).result;
    assert.deepEqual(blocked, {
      ok: false,
      outcome: 'rejected',
      reasons: ['task_content_not_migrated'],
    });
  });
});

test('a stop after the content was written is resumed on the next start; a wrong staged content is replaced', async () => {
  await withDb(async (db) => {
    // B は移せないので、この試験では行ごと消す（A だけを見る）。
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(TASK_B);
    // 1 回目: 書いた後、結び付けの結果が分からない（成否不明）まま止まる。
    let interrupted = false;
    await assert.rejects(
      migrateTaskContents(
        directStore(db, (op) => {
          if (op.kind !== 'task.link_content' || interrupted) return null;
          interrupted = true;
          return { ok: false, outcome: 'unknown', reasons: ['commit_failed'] };
        }),
        KEY,
      ),
      (error: unknown) =>
        error instanceof TaskMigrationError && error.reason === 'commit_failed',
    );
    assert.equal(readTask(db, TASK_A).content, null);
    assert.equal(taskBlobs(db, TASK_A), 1);
    // 書いた暗号文を、別の内容の暗号文に差し替えておく（読み戻しが合わない場合）。
    db.prepare(
      "DELETE FROM sealed_blobs WHERE owner_table = 'tasks' AND owner_id = ?",
    ).run(TASK_A);
    const wrong = sealTaskContent(KEY, TASK_A, {
      title: 'ちがう内容',
      due: null,
      body: null,
    });
    assert.equal(wrong.ok, true);
    if (!wrong.ok) return;
    const staged = executeRetentionOp(
      db,
      {
        kind: 'task.stage_content',
        task_id: TASK_A,
        content: wrong.content,
        now: 3000,
      },
      { platform: 'macos', halted: false },
    ).result;
    assert.equal(staged.ok, true);
    // 2 回目の起動: 合わない暗号文を消して書き直し、読み戻してから結び付ける。
    const report = await migrateTaskContents(directStore(db), KEY);
    assert.deepEqual(report, { migrated: 1, failed: [], pending: 0 });
    assert.deepEqual(taskContent(db, TASK_A), {
      title: '合成の用事 A',
      due: '2030-11-02',
      body: '合成のメモ',
    });
    assert.equal(taskBlobs(db, TASK_A), 1);
    assert.notEqual(
      readTask(db, TASK_A).content?.blob_id,
      wrong.content.blob_id,
    );
    // 3 回目の起動では何もしない。
    assert.deepEqual(await migrateTaskContents(directStore(db), KEY), {
      migrated: 0,
      failed: [],
      pending: 0,
    });
    // ゲートが開いた後に操作の本文を消しても、用事の内容は読める。
    const erase = executeRetentionOp(
      db,
      { kind: 'retention.erase_body', operation_id: OP_A, now: BODY_DUE },
      { platform: 'macos', halted: false },
    ).result;
    assert.deepEqual(erase, {
      ok: true,
      value: { operation_id: OP_A, erased_versions: 1 },
    });
    assert.deepEqual(taskContent(db, TASK_A), {
      title: '合成の用事 A',
      due: '2030-11-02',
      body: '合成のメモ',
    });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});
