// マイグレーション 0011（ADR 0051）: 用事の正本の分離・終わった操作の本文の削除（J5 の 7 日）・90 日の削除の順序・
// 依頼の結び付けの外部キー・解放済みの予算の行の backfill。期待値は手で書き、実装の処理（RETENTION_RULES など）から
// 作っていない。暗号文は乱数の合成値（実際の暗号化と復号は apps/core の task-content-migration.test.ts）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import {
  OPERATION_PURGE_STEPS,
  applyMigrations,
  executeBudgetOp,
  executeCommand,
  executeConversationOp,
  executeEventQuery,
  executeRetentionOp,
  initStoreGeneration,
  loadMigrations,
  openWriteConnection,
  parseMigration,
  readOperation,
  readSchemaVersion,
} from './index.js';
import type {
  DbCommand,
  RetentionOp,
  RetentionOpResult,
  SqliteDatabase,
  StoreOutcome,
} from './index.js';
import {
  CONTENT_HASH,
  SEED,
  STORE_GENERATION,
  approveCommand,
  cancelCommand,
  createCommand,
  databasePath,
  dispatchCommand,
  openSeededDatabase,
  prepareCommand,
  resultCommand,
  sealedIntent,
  withTempDir,
} from './operation-test-support.js';

const DAY = 86_400_000;
const T0 = 1_000_000;
// 完了の時刻（手で決めた値）。本文は 7 日後、レシートは 90 日後に消せる。
const DONE = 2_000_000;
const BODY_DUE = DONE + 7 * DAY;
const RECEIPT_DUE = DONE + 90 * DAY;

function run(
  db: SqliteDatabase,
  command: DbCommand,
  now: number,
): StoreOutcome {
  return executeCommand(db, command, {
    now,
    platform: 'macos',
    storeGeneration: STORE_GENERATION,
  }).outcome;
}

function ok(db: SqliteDatabase, command: DbCommand, now = T0): void {
  const outcome = run(db, command, now);
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
}

function retention(
  db: SqliteDatabase,
  op: RetentionOp,
  beforeCommit?: () => void,
): { result: RetentionOpResult; halt: boolean } {
  return executeRetentionOp(db, op, {
    platform: 'macos',
    halted: false,
    ...(beforeCommit === undefined ? {} : { beforeCommit }),
  });
}

function value(result: RetentionOpResult): unknown {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.value : null;
}

function reasons(result: RetentionOpResult): readonly string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.reasons;
}

async function withDb(run: (db: SqliteDatabase) => void): Promise<void> {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      run(db);
    } finally {
      db.close();
    }
  });
}

const count = (db: SqliteDatabase, sql: string, ...args: unknown[]): number =>
  db
    .prepare(sql)
    .pluck()
    .get(...args) as number;

// 外部変更の操作を成功まで進める（承認 → 準備 → 送出意図（工程 1 つ）→ 成功）。完了の時刻は DONE。
function succeedRemote(db: SqliteDatabase, id: string): DbCommand {
  ok(db, createCommand(id));
  const approve = approveCommand(id, '1');
  ok(db, approve);
  const attempt = randomUUID();
  ok(db, prepareCommand(id, '2', { attempt_id: attempt }));
  ok(db, {
    ...dispatchCommand(id, '3', attempt),
    step: { step_id: '1-apply_labels', step_kind: 'apply_labels' },
  } as DbCommand);
  ok(db, resultCommand(id, '4', attempt, 'reconciling'));
  ok(db, resultCommand(id, '5', attempt, 'succeeded'), DONE);
  return approve;
}

// 用事の登録（LocalCommand）を成功まで進め、用事の ID を返す。
function applyTask(db: SqliteDatabase, id: string): string {
  const local = { effect_route: 'local_command', connection_id: null } as const;
  ok(db, createCommand(id, local));
  ok(db, approveCommand(id, '1', { connection_id: null }));
  const taskId = randomUUID();
  ok(
    db,
    {
      command_id: randomUUID(),
      kind: 'operation.apply_local',
      operation_id: id,
      expected_state_revision: '2',
      request_revision: null,
      permission_revision: '0',
      forgetting_generation: '0',
      connection_id: null,
      request: null,
      attempt_id: randomUUID(),
      task_id: taskId,
      list_id: 'inbox',
      content: sealedIntent(),
    },
    DONE,
  );
  return taskId;
}

test('0011: the body of a finished operation is erased after 7 days; hash, approvals and the view stay', async () => {
  await withDb((db) => {
    const approve = succeedRemote(db, '00000000-0000-4000-8000-0000000000e1');
    // 7 日の 1 ms 前は消さない。
    assert.deepEqual(
      reasons(
        retention(db, {
          kind: 'retention.erase_body',
          operation_id: '00000000-0000-4000-8000-0000000000e1',
          now: BODY_DUE - 1,
        }).result,
      ),
      ['not_due'],
    );
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.erase_body',
          operation_id: '00000000-0000-4000-8000-0000000000e1',
          now: BODY_DUE,
        }).result,
      ),
      {
        operation_id: '00000000-0000-4000-8000-0000000000e1',
        erased_versions: 1,
      },
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT content_version, content_hash, intent_blob_id, body_deleted_at FROM operation_versions WHERE operation_id = '00000000-0000-4000-8000-0000000000e1'",
        )
        .all(),
      [
        {
          content_version: 1,
          content_hash: CONTENT_HASH,
          intent_blob_id: null,
          body_deleted_at: BODY_DUE,
        },
      ],
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'operation_versions' AND owner_id = '00000000-0000-4000-8000-0000000000e1'",
      ),
      0,
    );
    // 2 回目は何も消さない（再開しても同じ結果）。
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.erase_body',
          operation_id: '00000000-0000-4000-8000-0000000000e1',
          now: BODY_DUE,
        }).result,
      ),
      {
        operation_id: '00000000-0000-4000-8000-0000000000e1',
        erased_versions: 0,
      },
    );
    // 結果の表示: hash・承認・試行は残る。
    const record = readOperation(db, '00000000-0000-4000-8000-0000000000e1');
    assert.equal(record?.state, 'succeeded');
    assert.equal(record?.content_hash, CONTENT_HASH);
    assert.equal(record?.body_erased, true);
    assert.equal(record?.approvals[0]?.status, 'consumed');
    assert.equal(record?.attempts[0]?.status, 'succeeded');
    const view = executeEventQuery(db, STORE_GENERATION, {
      kind: 'operation_view',
      operation_id: '00000000-0000-4000-8000-0000000000e1',
    });
    assert.notEqual(view, null);
    // 承認の照合: 保存した承認の hash は、本文を消した内容版の hash と同じ。
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM approvals a JOIN operation_versions v ON v.operation_id = a.operation_id AND v.content_version = a.content_version WHERE a.operation_id = '00000000-0000-4000-8000-0000000000e1' AND a.content_hash = v.content_hash",
      ),
      1,
    );
    // 同じ hash の再送: 同じ命令は保存済みの受付結果を返す（解釈し直さない）。
    ok(db, approve);
    // 本文の暗号文は読めない（送出・preview の材料にしない）。
    const intent = executeConversationOp(
      db,
      {
        kind: 'operation.intent',
        operation_id: '00000000-0000-4000-8000-0000000000e1',
        content_version: '1',
      },
      { platform: 'macos', halted: false, storeGeneration: STORE_GENERATION },
    );
    assert.deepEqual(intent.result, { ok: true, value: null });
  });
});

test('0011: an erased content version is never dispatched again (retry after not_executed is refused)', async () => {
  await withDb((db) => {
    ok(db, createCommand('op-n'));
    ok(db, approveCommand('op-n', '1'));
    const attempt = randomUUID();
    ok(db, prepareCommand('op-n', '2', { attempt_id: attempt }));
    ok(db, dispatchCommand('op-n', '3', attempt));
    ok(db, resultCommand('op-n', '4', attempt, 'reconciling'));
    ok(db, resultCommand('op-n', '5', attempt, 'not_executed'), DONE);
    // 未実行の確定も完了に数え、完了の時刻を持つ。
    assert.equal(
      count(
        db,
        "SELECT completed_at FROM operations WHERE operation_id = 'op-n'",
      ),
      DONE,
    );
    value(
      retention(db, {
        kind: 'retention.erase_body',
        operation_id: 'op-n',
        now: BODY_DUE,
      }).result,
    );
    const retry = run(
      db,
      { ...prepareCommand('op-n', '6'), retry: true } as DbCommand,
      BODY_DUE + 1,
    );
    assert.deepEqual(retry, {
      outcome: 'rejected',
      command_id: retry.command_id,
      kind: 'operation.prepare',
      reasons: ['operation_body_erased'],
    });
    // DB の最後の保証: 本文のない内容版への試行と、送出の手前への遷移を trigger で拒否する。
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO operation_attempts VALUES ('at-x', 'op-n', 1, (SELECT approval_id FROM approvals WHERE operation_id = 'op-n'), 'preparing', NULL, NULL, NULL, 1)",
          )
          .run(),
      /operation_body_erased/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET state = 'preparing' WHERE operation_id = 'op-n'",
          )
          .run(),
      /operation_body_erased/u,
    );
  });
});

test('0011: a retry before the deadline clears completed_at, and unfinished or unknown operations keep the body', async () => {
  await withDb((db) => {
    ok(db, createCommand('op-n'));
    ok(db, approveCommand('op-n', '1'));
    const first = randomUUID();
    ok(db, prepareCommand('op-n', '2', { attempt_id: first }));
    ok(db, dispatchCommand('op-n', '3', first));
    ok(db, resultCommand('op-n', '4', first, 'reconciling'));
    ok(db, resultCommand('op-n', '5', first, 'not_executed'), DONE);
    ok(db, { ...prepareCommand('op-n', '6'), retry: true } as DbCommand, DONE);
    assert.equal(
      db
        .prepare(
          "SELECT completed_at FROM operations WHERE operation_id = 'op-n'",
        )
        .pluck()
        .get(),
      null,
    );
    assert.deepEqual(
      reasons(
        retention(db, {
          kind: 'retention.erase_body',
          operation_id: 'op-n',
          now: BODY_DUE,
        }).result,
      ),
      ['operation_not_finished'],
    );
    // 結果不明は完了ではない（照合のために残す）。
    ok(db, createCommand('op-u'));
    ok(db, approveCommand('op-u', '1'));
    const attempt = randomUUID();
    ok(db, prepareCommand('op-u', '2', { attempt_id: attempt }));
    ok(db, dispatchCommand('op-u', '3', attempt));
    ok(db, resultCommand('op-u', '4', attempt, 'unknown_held'), DONE);
    for (const kind of [
      'retention.erase_body',
      'retention.purge_operation',
    ] as const)
      assert.deepEqual(
        reasons(
          retention(db, { kind, operation_id: 'op-u', now: RECEIPT_DUE })
            .result,
        ),
        ['unknown_held'],
      );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operation_versions SET intent_blob_id = NULL, body_deleted_at = 1 WHERE operation_id = 'op-u'",
          )
          .run(),
      /operation_body_not_finished/u,
    );
  });
});

test('0011: the content of an open task stays readable after the body of its operation is erased', async () => {
  await withDb((db) => {
    const taskId = applyTask(db, 'op-t');
    const before = value(
      retention(db, { kind: 'task.read', task_id: taskId }).result,
    ) as { content: { ciphertext: Uint8Array } | null; status: string };
    assert.equal(before.status, 'open');
    assert.notEqual(before.content, null);
    value(
      retention(db, {
        kind: 'retention.erase_body',
        operation_id: 'op-t',
        now: BODY_DUE,
      }).result,
    );
    const after = value(
      retention(db, { kind: 'task.read', task_id: taskId }).result,
    ) as typeof before;
    assert.equal(after.status, 'open');
    assert.deepEqual(after.content, before.content);
    // 90 日の削除の後も、用事と暗号文は残る（用事は本人の削除操作で消える）。
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.purge_operation',
          operation_id: 'op-t',
          now: RECEIPT_DUE,
        }).result,
      ),
      { operation_id: 'op-t', purged: true },
    );
    assert.deepEqual(
      value(retention(db, { kind: 'task.read', task_id: taskId }).result),
      after,
    );
    assert.equal(
      count(db, "SELECT count(*) FROM operations WHERE operation_id = 'op-t'"),
      0,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

// 90 日の削除の対象 X に、すべての参照する表の行を持たせる。Y は X の取り消しの補償の操作（承認待ちのまま）。
function seedFullOperation(db: SqliteDatabase): void {
  succeedRemote(db, 'op-x');
  ok(db, createCommand('op-y'));
  db.prepare(
    "INSERT INTO auto_actions VALUES ('op-x', 'label_mail', 3, ?, ?)",
  ).run(DONE, DONE + 2_592_000_000);
  db.prepare(
    "INSERT INTO undo_records VALUES ('undo-1', 'op-x', 'op-y', 'in_progress', ?)",
  ).run(DONE + 1);
  db.prepare(
    "INSERT INTO request_entities VALUES ('re-1', 'acct-1', 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
  ).run();
  db.prepare(
    "INSERT INTO request_entity_operations VALUES ('re-1', 'label_mail', 'acct-1', '', 'op-x')",
  ).run();
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES ('b-task-x', 'task_content', 'tasks', 'task-x', 0, 1, 'k-test', randomblob(12), X'00', randomblob(16), 1, NULL)",
  ).run();
  db.prepare(
    "INSERT INTO tasks VALUES ('task-x', 'op-x', 1, 'inbox', 'open', 1, 'b-task-x')",
  ).run();
}

const TABLE_COUNTS = `SELECT
  (SELECT count(*) FROM undo_records) AS undo_records,
  (SELECT count(*) FROM auto_actions) AS auto_actions,
  (SELECT count(*) FROM operation_steps) AS operation_steps,
  (SELECT count(*) FROM operation_attempts WHERE operation_id = 'op-x') AS operation_attempts,
  (SELECT count(*) FROM approvals WHERE operation_id = 'op-x') AS approvals,
  (SELECT count(*) FROM operation_versions WHERE operation_id = 'op-x') AS operation_versions,
  (SELECT count(*) FROM sealed_blobs WHERE owner_id = 'op-x') AS intent_blobs,
  (SELECT count(*) FROM operations WHERE operation_id = 'op-x') AS operations,
  (SELECT count(*) FROM tasks) AS tasks,
  (SELECT count(*) FROM request_entity_operations) AS request_entity_operations`;

test('0011: the 90-day purge removes all seven kinds of rows in order, keeping tasks and the once-only record', async () => {
  await withDb((db) => {
    seedFullOperation(db);
    assert.deepEqual(db.prepare(TABLE_COUNTS).get(), {
      undo_records: 1,
      auto_actions: 1,
      operation_steps: 1,
      operation_attempts: 1,
      approvals: 1,
      operation_versions: 1,
      intent_blobs: 1,
      operations: 1,
      tasks: 1,
      request_entity_operations: 1,
    });
    // 90 日の 1 ms 前は消さない。
    assert.deepEqual(
      reasons(
        retention(db, {
          kind: 'retention.purge_operation',
          operation_id: 'op-x',
          now: RECEIPT_DUE - 1,
        }).result,
      ),
      ['not_due'],
    );
    // 補償の操作（op-y）が終わっていない間は消さない。
    assert.deepEqual(
      reasons(
        retention(db, {
          kind: 'retention.purge_operation',
          operation_id: 'op-x',
          now: RECEIPT_DUE,
        }).result,
      ),
      ['compensation_open'],
    );
    ok(db, cancelCommand('op-y', '1'), DONE);
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.purge_operation',
          operation_id: 'op-x',
          now: RECEIPT_DUE,
        }).result,
      ),
      { operation_id: 'op-x', purged: true },
    );
    assert.deepEqual(db.prepare(TABLE_COUNTS).get(), {
      undo_records: 0,
      auto_actions: 0,
      operation_steps: 0,
      operation_attempts: 0,
      approvals: 0,
      operation_versions: 0,
      intent_blobs: 0,
      operations: 0,
      tasks: 1,
      request_entity_operations: 1,
    });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // 再開しても同じ（既に消えている）。
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.purge_operation',
          operation_id: 'op-x',
          now: RECEIPT_DUE,
        }).result,
      ),
      { operation_id: 'op-x', purged: false },
    );
    // 補償の操作も 90 日で消せる（取り消しの記録は先に消えている）。
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.purge_operation',
          operation_id: 'op-y',
          now: RECEIPT_DUE,
        }).result,
      ),
      { operation_id: 'op-y', purged: true },
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('0011: swapping dependent purge steps fails on a foreign key; the documented order succeeds', async () => {
  await withDb((db) => {
    seedFullOperation(db);
    ok(db, cancelCommand('op-y', '1'), DONE);
    const order = OPERATION_PURGE_STEPS.map((step) => step.table);
    assert.deepEqual(order, [
      'undo_records',
      'auto_actions',
      'operation_steps',
      'operation_attempts',
      'approvals',
      'operation_versions',
      'operations',
    ]);
    const attempt = (steps: readonly string[]): 'ok' | 'foreign_key' => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of steps)
          db.prepare(statement).run({ id: 'op-x' });
        return 'ok';
      } catch (error) {
        assert.match(String(error), /FOREIGN KEY constraint failed/u);
        return 'foreign_key';
      } finally {
        db.exec('ROLLBACK');
      }
    };
    const statements = (indexes: readonly number[]): string[] =>
      indexes.flatMap(
        (index) => OPERATION_PURGE_STEPS[index]?.statements ?? [],
      );
    // 隣どうしを入れ替えた順序（手で決めた期待値）。auto_actions と operation_steps は互いに参照しないので通る。
    const swaps: readonly [number, number, 'ok' | 'foreign_key'][] = [
      [0, 1, 'foreign_key'],
      [1, 2, 'ok'],
      [2, 3, 'foreign_key'],
      [3, 4, 'foreign_key'],
      [4, 5, 'foreign_key'],
      [5, 6, 'foreign_key'],
    ];
    for (const [a, b, expected] of swaps) {
      const indexes = [0, 1, 2, 3, 4, 5, 6];
      indexes[a] = b;
      indexes[b] = a;
      assert.equal(attempt(statements(indexes)), expected, `${a}<->${b}`);
    }
    // 手順 6 の中で、暗号文を内容版の行より先に消すと失敗する。
    const step6 = OPERATION_PURGE_STEPS[5]?.statements ?? [];
    assert.equal(
      attempt([
        ...statements([0, 1, 2, 3, 4]),
        step6[1] ?? '',
        step6[0] ?? '',
        ...statements([6]),
      ]),
      'foreign_key',
    );
    assert.equal(attempt(statements([0, 1, 2, 3, 4, 5, 6])), 'ok');
  });
});

test('0011: due bodies are erased in small transactions and a stopped batch resumes from where it was', async () => {
  await withDb((db) => {
    for (const [index, id] of ['op-a', 'op-b', 'op-c'].entries()) {
      ok(db, createCommand(id));
      ok(db, cancelCommand(id, '1'), DONE + index);
    }
    // まだ期限の来ていない操作と、進行中の操作は選ばない。
    ok(db, createCommand('op-late'));
    ok(db, cancelCommand('op-late', '1'), DONE + DAY);
    ok(db, createCommand('op-open'));
    const first = value(
      retention(db, {
        kind: 'retention.erase_due_bodies',
        now: BODY_DUE + 2,
        limit: 2,
        after: null,
      }).result,
    );
    assert.deepEqual(first, {
      processed: ['op-a', 'op-b'],
      skipped: [],
      next: { completed_at: DONE + 1, operation_id: 'op-b' },
    });
    // 次の transaction の COMMIT の前で止まる（巻き戻す）。書込みは止まり、何も消していない。
    let thrown = false;
    const stopped = retention(
      db,
      {
        kind: 'retention.erase_due_bodies',
        now: BODY_DUE + 2,
        limit: 2,
        after: { completed_at: DONE + 1, operation_id: 'op-b' },
      },
      () => {
        thrown = true;
        throw new Error('注入した失敗');
      },
    );
    assert.equal(thrown, true);
    assert.equal(stopped.halt, true);
    assert.deepEqual(reasons(stopped.result), ['transaction_failed']);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM operation_versions WHERE operation_id = 'op-c' AND intent_blob_id IS NOT NULL",
      ),
      1,
    );
    const resumed = value(
      retention(db, {
        kind: 'retention.erase_due_bodies',
        now: BODY_DUE + 2,
        limit: 2,
        after: { completed_at: DONE + 1, operation_id: 'op-b' },
      }).result,
    );
    assert.deepEqual(resumed, { processed: ['op-c'], skipped: [], next: null });
    assert.deepEqual(
      db
        .prepare(
          'SELECT operation_id FROM operation_versions WHERE intent_blob_id IS NOT NULL ORDER BY operation_id',
        )
        .pluck()
        .all(),
      ['op-late', 'op-open'],
    );
    // 最初から呼び直しても、消した操作は選ばれない。
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.erase_due_bodies',
          now: BODY_DUE + 2,
          limit: 2,
          after: null,
        }).result,
      ),
      { processed: [], skipped: [], next: null },
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('0011: the 90-day batch skips an operation whose compensation is open and continues', async () => {
  await withDb((db) => {
    seedFullOperation(db);
    ok(db, createCommand('op-z'));
    ok(db, cancelCommand('op-z', '1'), DONE + 5);
    const result = value(
      retention(db, {
        kind: 'retention.purge_due_operations',
        now: RECEIPT_DUE + 5,
        limit: 50,
        after: null,
      }).result,
    );
    assert.deepEqual(result, {
      processed: ['op-z'],
      skipped: [{ operation_id: 'op-x', reasons: ['compensation_open'] }],
      next: null,
    });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

// 版 10 の DB に、0010 までの形で用事（暗号文なし）・操作・承認・試行・工程・依頼の結び付け・解放済みの予約・
// 安全停止を置く。
function seedVersion10(db: SqliteDatabase): void {
  initStoreGeneration(db, STORE_GENERATION);
  for (const sql of SEED) db.exec(sql);
  const blob = (id: string, owner: string, version: number): string =>
    `INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES ('${id}', 'operation_intent', 'operation_versions', '${owner}', ${version}, 1, 'k-test', randomblob(12), X'00', randomblob(16), 1000, NULL)`;
  for (const sql of [
    blob('b-1', 'op-1', 1),
    blob('b-2', 'op-2', 1),
    "INSERT INTO operations VALUES ('op-1', NULL, 'task.create', 'local_command', 1, 'succeeded', 3, 1000, 2000000, 'normal', NULL)",
    "INSERT INTO operations VALUES ('op-2', NULL, 'mail.labels.change', 'remote_mutation', 1, 'succeeded', 5, 1000, 2000000, 'normal', NULL)",
    `INSERT INTO operation_versions VALUES ('op-1', 1, '${CONTENT_HASH}', 'b-1', 1000)`,
    `INSERT INTO operation_versions VALUES ('op-2', 1, '${CONTENT_HASH}', 'b-2', 1000)`,
    `INSERT INTO approvals VALUES ('ap-1', 'op-1', 1, '${CONTENT_HASH}', 'policy_auto', NULL, NULL, 3, 'consumed', 1100)`,
    `INSERT INTO approvals VALUES ('ap-2', 'op-2', 1, '${CONTENT_HASH}', 'policy_auto', NULL, NULL, 3, 'consumed', 1100)`,
    "INSERT INTO operation_attempts VALUES ('at-1', 'op-1', 1, 'ap-1', 'succeeded', 1200, 'task-1', 'confirmed_success', 1200)",
    "INSERT INTO operation_attempts VALUES ('at-2', 'op-2', 1, 'ap-2', 'succeeded', 1200, 'm-1', 'confirmed_success', 1200)",
    "INSERT INTO operation_steps VALUES ('at-2', '1-apply_labels', 'apply_labels', 'm-1', 1200, 'confirmed_success')",
    "INSERT INTO tasks VALUES ('task-1', 'op-1', 1, 'inbox', 'open', 1200)",
    "INSERT INTO request_entities VALUES ('re-1', 'acct-1', 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
    "INSERT INTO request_entity_operations VALUES ('re-1', 'create_task', 'acct-1', '', 'op-1')",
    "INSERT INTO safety_breaker VALUES (1, 'stopped', 2, 'rate_exceeded', 1500, NULL)",
    "INSERT INTO budget_months (month, time_zone, month_start, month_start_time_zone, recorded_at) VALUES ('2030-10', 'UTC', 1917043200000, 'UTC', 1)",
    "INSERT INTO budget_reservations (reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, created_at) VALUES ('r-released', 'q-1', 'claude.synthetic.v1', 'llm', 'llm', 'owner_request', '2030-10', 'XTS', 'price-1', 10, 20, 'released', 1, 1917043200000)",
    "INSERT INTO budget_reservations (reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, created_at) VALUES ('r-open', 'q-2', 'claude.synthetic.v1', 'llm', 'llm', 'owner_request', '2030-10', 'XTS', 'price-1', 10, 20, 'reserved', 1, 1917043200000)",
  ])
    db.exec(sql);
}

async function withVersion10(
  run: (db: SqliteDatabase, path: string) => void,
): Promise<void> {
  await withTempDir((dir) => {
    const path = join(dir, 'buddy.sqlite');
    const db = openWriteConnection(path, { platform: 'macos' });
    try {
      applyMigrations(db, loadMigrations().slice(0, 10));
      seedVersion10(db);
      run(db, path);
    } finally {
      db.close();
    }
  });
}

test('0011 moves a version 10 DB: rows survive, old tasks have no content yet, and only their operations stay', async () => {
  await withVersion10((db) => {
    assert.deepEqual(applyMigrations(db), {
      from: 10,
      to: 12,
      applied: [11, 12],
    });
    assert.deepEqual(
      db
        .prepare(
          'SELECT task_id, operation_id, content_version, list_id, status, content_blob_id FROM tasks',
        )
        .all(),
      [
        {
          task_id: 'task-1',
          operation_id: 'op-1',
          content_version: 1,
          list_id: 'inbox',
          status: 'open',
          content_blob_id: null,
        },
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT operation_id, intent_blob_id, body_deleted_at FROM operation_versions ORDER BY operation_id',
        )
        .all(),
      [
        { operation_id: 'op-1', intent_blob_id: 'b-1', body_deleted_at: null },
        { operation_id: 'op-2', intent_blob_id: 'b-2', body_deleted_at: null },
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT (SELECT count(*) FROM sealed_blobs) AS blobs, (SELECT count(*) FROM approvals) AS approvals, (SELECT count(*) FROM operation_attempts) AS attempts, (SELECT count(*) FROM operation_steps) AS steps, (SELECT count(*) FROM request_entity_operations) AS links',
        )
        .get(),
      { blobs: 2, approvals: 2, attempts: 2, steps: 1, links: 1 },
    );
    assert.deepEqual(db.prepare('SELECT * FROM safety_breaker').get(), {
      singleton: 1,
      state: 'stopped',
      safety_revision: 2,
      stop_reason: 'rate_exceeded',
      stopped_at: 1500,
      resumed_by_device_id: null,
    });
    // 外部キー: tasks・request_entity_operations は操作を参照しない。
    for (const table of ['tasks', 'request_entity_operations'])
      assert.deepEqual(
        (
          db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
            table: string;
          }[]
        )
          .map((row) => row.table)
          .filter((name) => name.startsWith('operation')),
        [],
        table,
      );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    // 移していない用事がある操作（op-1）だけを残し、ほかの操作（op-2）の削除は進む。
    assert.deepEqual(value(retention(db, { kind: 'retention.gate' }).result), {
      tasks_pending: 1,
    });
    for (const op of [
      {
        kind: 'retention.erase_body',
        operation_id: 'op-1',
        now: RECEIPT_DUE,
      },
      {
        kind: 'retention.purge_operation',
        operation_id: 'op-1',
        now: RECEIPT_DUE,
      },
    ] as const)
      assert.deepEqual(reasons(retention(db, op).result), [
        'task_content_not_migrated',
      ]);
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.erase_body',
          operation_id: 'op-2',
          now: RECEIPT_DUE,
        }).result,
      ),
      { operation_id: 'op-2', erased_versions: 1 },
    );
    assert.deepEqual(
      value(
        retention(db, {
          kind: 'retention.purge_operation',
          operation_id: 'op-2',
          now: RECEIPT_DUE,
        }).result,
      ),
      { operation_id: 'op-2', purged: true },
    );
    // バッチは移せない用事の操作を飛ばして続ける（全体のゲートは置かない）。
    for (const kind of [
      'retention.erase_due_bodies',
      'retention.purge_due_operations',
    ] as const)
      assert.deepEqual(
        value(
          retention(db, { kind, now: RECEIPT_DUE, limit: 10, after: null })
            .result,
        ),
        {
          processed: [],
          skipped: [
            { operation_id: 'op-1', reasons: ['task_content_not_migrated'] },
          ],
          next: null,
        },
      );
    // DB の最後の保証: 移していない用事の操作の本文と内容版の行は消せない。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operation_versions SET intent_blob_id = NULL, body_deleted_at = 1 WHERE operation_id = 'op-1'",
          )
          .run(),
      /task_content_not_migrated/u,
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM operation_versions WHERE operation_id = 'op-1'")
          .run(),
      /task_content_not_migrated/u,
    );
  });
});

test('0011: the task content migration is staged, linked once, and resumes after a stop in the middle', async () => {
  await withVersion10((db, path) => {
    applyMigrations(db);
    const batch = value(
      retention(db, { kind: 'task.migration_next', limit: 10, after: null })
        .result,
    ) as {
      pending: number;
      items: {
        task_id: string;
        content_hash: string | null;
        intent: unknown;
        staged: unknown;
      }[];
    };
    assert.equal(batch.pending, 1);
    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0]?.task_id, 'task-1');
    assert.equal(batch.items[0]?.content_hash, CONTENT_HASH);
    assert.notEqual(batch.items[0]?.intent, null);
    assert.equal(batch.items[0]?.staged, null);
    // 書く（まだ結び付けない）。ここで止まった（DB を閉じた）とする。
    const staged = sealedIntent();
    value(
      retention(db, {
        kind: 'task.stage_content',
        task_id: 'task-1',
        content: staged,
        now: 3000,
      }).result,
    );
    db.close();
    const reopened = openWriteConnection(path, { platform: 'macos' });
    try {
      assert.equal(readSchemaVersion(reopened), 12);
      const again = value(
        retention(reopened, {
          kind: 'task.migration_next',
          limit: 10,
          after: null,
        }).result,
      ) as { items: { staged: { blob_id: string } | null }[] };
      assert.equal(again.items[0]?.staged?.blob_id, staged.blob_id);
      // 二つ目は書けない。読み戻しが合わなければ消して書き直す。
      assert.deepEqual(
        reasons(
          retention(reopened, {
            kind: 'task.stage_content',
            task_id: 'task-1',
            content: sealedIntent(),
            now: 3001,
          }).result,
        ),
        ['task_content_already_staged'],
      );
      value(
        retention(reopened, {
          kind: 'task.discard_staged',
          task_id: 'task-1',
          blob_id: staged.blob_id,
        }).result,
      );
      const rewritten = sealedIntent();
      value(
        retention(reopened, {
          kind: 'task.stage_content',
          task_id: 'task-1',
          content: rewritten,
          now: 3002,
        }).result,
      );
      // 別の暗号文は結び付けられない。
      assert.deepEqual(
        reasons(
          retention(reopened, {
            kind: 'task.link_content',
            task_id: 'task-1',
            blob_id: staged.blob_id,
          }).result,
        ),
        ['task_content_not_staged'],
      );
      value(
        retention(reopened, {
          kind: 'task.link_content',
          task_id: 'task-1',
          blob_id: rewritten.blob_id,
        }).result,
      );
      // 一度だけ。結び付けた暗号文は消せない。
      assert.deepEqual(
        reasons(
          retention(reopened, {
            kind: 'task.discard_staged',
            task_id: 'task-1',
            blob_id: rewritten.blob_id,
          }).result,
        ),
        ['task_content_not_staged'],
      );
      assert.deepEqual(
        reasons(
          retention(reopened, {
            kind: 'task.link_content',
            task_id: 'task-1',
            blob_id: rewritten.blob_id,
          }).result,
        ),
        ['task_content_already_linked'],
      );
      assert.deepEqual(
        value(retention(reopened, { kind: 'retention.gate' }).result),
        { tasks_pending: 0 },
      );
      // ゲートが開いた後は、期限の来た本文を消せる。用事の内容は残る。
      assert.deepEqual(
        value(
          retention(reopened, {
            kind: 'retention.erase_due_bodies',
            now: BODY_DUE,
            limit: 10,
            after: null,
          }).result,
        ),
        { processed: ['op-1', 'op-2'], skipped: [], next: null },
      );
      const task = value(
        retention(reopened, { kind: 'task.read', task_id: 'task-1' }).result,
      ) as { content: { blob_id: string; ciphertext: Uint8Array } | null };
      assert.equal(task.content?.blob_id, rewritten.blob_id);
      assert.deepEqual(
        task.content?.ciphertext,
        new Uint8Array(rewritten.ciphertext),
      );
      assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      reopened.close();
    }
  });
});

test('0011: a re-created parent row that is missing is caught, and the migration does not apply', async () => {
  await withVersion10((db) => {
    // 0011 の sealed_blobs の入れ直しから 1 行を落とした写し（故障の注入）。
    const migrations = loadMigrations();
    const original = migrations[10];
    assert.ok(original);
    const broken = original.sql.replace(
      'FROM sealed_blobs_0011_copy;',
      "FROM sealed_blobs_0011_copy WHERE blob_id <> 'b-2';",
    );
    assert.notEqual(broken, original.sql);
    assert.throws(() =>
      applyMigrations(db, [
        ...migrations.slice(0, 10),
        parseMigration(original.name, broken),
      ]),
    );
    assert.equal(readSchemaVersion(db), 10);
    assert.equal(count(db, 'SELECT count(*) FROM sealed_blobs'), 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // 正しい 0011 はその後に適用できる。
    assert.deepEqual(applyMigrations(db), {
      from: 10,
      to: 12,
      applied: [11, 12],
    });
  });
});

test('0011 fills completed_at of finished operations from before 0011 (the body is not kept forever)', async () => {
  await withTempDir((dir) => {
    const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
      platform: 'macos',
    });
    try {
      applyMigrations(db, loadMigrations().slice(0, 10));
      initStoreGeneration(db, STORE_GENERATION);
      const insert = db.prepare(
        "INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at) VALUES (?, NULL, 'mail.labels.change', 'remote_mutation', 1, ?, 5, 1000, ?)",
      );
      // 0010 までの not_executed・superseded は NULL。succeeded・cancelled は本来は値を持つが、異常な NULL も同じ扱い。
      insert.run('op-not-executed', 'not_executed', null);
      insert.run('op-superseded', 'superseded', null);
      insert.run('op-succeeded-null', 'succeeded', null);
      insert.run('op-cancelled-null', 'cancelled', null);
      insert.run('op-succeeded-value', 'succeeded', 5000);
      const before = Date.now() - 1000;
      assert.deepEqual(applyMigrations(db), {
        from: 10,
        to: 12,
        applied: [11, 12],
      });
      const after = Date.now() + 1000;
      const rows = db
        .prepare(
          'SELECT operation_id, completed_at FROM operations ORDER BY operation_id',
        )
        .all() as { operation_id: string; completed_at: number | null }[];
      const completed = new Map(
        rows.map((row) => [row.operation_id, row.completed_at]),
      );
      for (const id of [
        'op-not-executed',
        'op-superseded',
        'op-succeeded-null',
        'op-cancelled-null',
      ]) {
        const value = completed.get(id);
        assert.equal(typeof value, 'number', id);
        assert.ok(
          typeof value === 'number' && value >= before && value <= after,
          `${id}: ${String(value)}`,
        );
      }
      // 既に値のある行は変えない。
      assert.equal(completed.get('op-succeeded-value'), 5000);
    } finally {
      db.close();
    }
  });
});

test('0011 applies to a version 10 DB with 6000 operations within 10 seconds (child foreign keys are indexed)', async () => {
  const ROWS = 6000;
  await withTempDir((dir) => {
    const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
      platform: 'macos',
    });
    try {
      applyMigrations(db, loadMigrations().slice(0, 10));
      initStoreGeneration(db, STORE_GENERATION);
      const insertOperation = db.prepare(
        "INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at) VALUES (?, NULL, 'mail.labels.change', 'remote_mutation', 1, 'succeeded', 5, 1000, 2000000)",
      );
      const insertBlob = db.prepare(
        "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'operation_intent', 'operation_versions', ?, 1, 1, 'k-perf', randomblob(12), X'00', X'00000000000000000000000000000000', 1000, NULL)",
      );
      const insertVersion = db.prepare(
        'INSERT INTO operation_versions (operation_id, content_version, content_hash, intent_blob_id, created_at) VALUES (?, 1, ?, ?, 1000)',
      );
      const insertApproval = db.prepare(
        "INSERT INTO approvals VALUES (?, ?, 1, ?, 'policy_auto', NULL, NULL, 3, 'consumed', 1100)",
      );
      const insertAttempt = db.prepare(
        "INSERT INTO operation_attempts VALUES (?, ?, 1, ?, 'succeeded', 1200, NULL, 'confirmed_success', 1200)",
      );
      const insertConnection = db.prepare(
        "INSERT INTO connections VALUES (?, 'google', ?, NULL, 'active', 'read', '[]', '{}', 0, 0)",
      );
      const insertSession = db.prepare(
        "INSERT INTO sessions VALUES (?, 'normal', NULL, 1, ?, 1000, NULL)",
      );
      const insertRequestEntity = db.prepare(
        "INSERT INTO request_entities VALUES (?, 'acct-perf', ?, ?, 1, 'active', 0, ?, 1000, NULL)",
      );
      const insertCandidate = db.prepare(
        "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key, title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at) VALUES (?, NULL, NULL, NULL, 'schedule_overlap', ?, ?, NULL, 'new', NULL, NULL)",
      );
      const insertMemory = db.prepare(
        "INSERT INTO memories VALUES (?, 'auto_extraction', 'preference', ?, 'b-perf-0000', ?, ?, 'active', 1000, 7776001000, NULL)",
      );
      const hash = 'a'.repeat(64);
      db.transaction(() => {
        for (let index = 0; index < ROWS; index += 1) {
          const suffix = String(index).padStart(4, '0');
          const operation = `op-perf-${suffix}`;
          const blob = `b-perf-${suffix}`;
          const approval = `ap-perf-${suffix}`;
          const attempt = `at-perf-${suffix}`;
          insertOperation.run(operation);
          insertBlob.run(blob, operation);
          insertVersion.run(operation, hash, blob);
          insertApproval.run(approval, operation, hash);
          insertAttempt.run(attempt, operation, approval);
          insertConnection.run(`c-perf-${suffix}`, blob);
          insertSession.run(`s-perf-${suffix}`, blob);
          insertRequestEntity.run(
            `re-perf-${suffix}`,
            `thread-${suffix}`,
            `msg-${suffix}`,
            blob,
          );
          insertCandidate.run(`nc-perf-${suffix}`, `key-${suffix}`, blob);
          insertMemory.run(
            `m-perf-${suffix}`,
            blob,
            'b'.repeat(64),
            `d-${suffix}`.padEnd(64, '0'),
          );
        }
      })();
      const started = Date.now();
      assert.deepEqual(applyMigrations(db), {
        from: 10,
        to: 12,
        applied: [11, 12],
      });
      const elapsed = Date.now() - started;
      // 索引のない 0011 は同じ規模で 22.9 秒かかった。CI の遅い実行機でも通る上限（ADR 0051）。
      assert.ok(elapsed < 10_000, `0011 took ${elapsed} ms`);
      assert.equal(count(db, 'SELECT count(*) FROM operations'), ROWS);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });
});

test('0011: released budget rows from before 0010 get delete_at once, and nothing else changes', async () => {
  await withVersion10((db) => {
    applyMigrations(db);
    // 予算月 2030-10（UTC）の締めは 2030-11-01。13 か月後は 2031-12-01（手で計算した値）。
    const deleteAt = Date.parse('2031-12-01T00:00:00Z');
    const backfill = executeBudgetOp(
      db,
      { kind: 'budget.backfill_delete_at', budget_month: '2030-10' },
      { platform: 'macos', halted: false },
    ).result;
    assert.deepEqual(backfill, {
      ok: true,
      value: { budget_month: '2030-10', filled: 1, still_open: 1 },
    });
    assert.deepEqual(
      db
        .prepare(
          'SELECT reservation_id, delete_at FROM budget_reservations ORDER BY reservation_id',
        )
        .all(),
      [
        { reservation_id: 'r-open', delete_at: null },
        { reservation_id: 'r-released', delete_at: deleteAt },
      ],
    );
    // 2 回目は何も書かない。
    assert.deepEqual(
      executeBudgetOp(
        db,
        { kind: 'budget.backfill_delete_at', budget_month: '2030-10' },
        { platform: 'macos', halted: false },
      ).result,
      {
        ok: true,
        value: { budget_month: '2030-10', filled: 0, still_open: 1 },
      },
    );
    // 解放済みの行は、delete_at 以外を変えられず、delete_at も一度だけ。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE budget_reservations SET reserved_amount = 11 WHERE reservation_id = 'r-released'",
          )
          .run(),
      /budget_reservation_released/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE budget_reservations SET delete_at = delete_at + 1 WHERE reservation_id = 'r-released'",
          )
          .run(),
      /budget_reservation_released/u,
    );
    // 月の記録がない月は書かない（推測の時刻を入れない）。
    assert.deepEqual(
      executeBudgetOp(
        db,
        { kind: 'budget.backfill_delete_at', budget_month: '2030-09' },
        { platform: 'macos', halted: false },
      ).result,
      { ok: false, outcome: 'rejected', reasons: ['calendar_invalid'] },
    );
  });
});
