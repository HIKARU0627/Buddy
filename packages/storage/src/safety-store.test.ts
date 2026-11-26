// 安全停止の時間窓・同じ対象の反復・自動実行の一覧・取り消しの記録・停止の解除（ADR 0147）を、
// worker を介さずに同期で確かめる。期待値は設計 08 §9・03「取り消しと安全停止」の初期値
// （10 分間に 20 件まで、同じ対象は 1 時間に 2 件まで、補償の失敗は 3 回連続で停止、取り消しは 30 日）と
// 0001 の制約から手で書いた値。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  DbWorkerClient,
  executeCommand,
  executeSafetyOp,
  listAutoActions,
  readSafetyState,
  resumeSafetyBreaker,
  stopSafetyBreaker,
} from './index.js';
import type {
  ApproveOperationCommand,
  DbCommand,
  SqliteDatabase,
  StoreOutcome,
} from './index.js';
import {
  CONTENT_HASH,
  STORE_GENERATION,
  approveCommand,
  cancelCommand,
  createCommand,
  databasePath,
  dispatchCommand,
  openSeededDatabase,
  operationState,
  prepareCommand,
  resultCommand,
  sealedIntent,
  storeContext,
  withTempDir,
} from './operation-test-support.js';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function withStore(run: (db: SqliteDatabase) => void): Promise<void> {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      run(db);
    } finally {
      db.close();
    }
  });
}

function exec(
  db: SqliteDatabase,
  command: DbCommand,
  now: number,
): StoreOutcome {
  const result = executeCommand(db, command, storeContext(now));
  assert.equal(result.halt, false, JSON.stringify(result.outcome));
  return result.outcome;
}

function committed(outcome: StoreOutcome): string {
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
  return outcome.outcome === 'durable' ? outcome.committed_state_revision : '';
}

function reasons(outcome: StoreOutcome): readonly string[] {
  assert.equal(outcome.outcome, 'rejected', JSON.stringify(outcome));
  return outcome.outcome === 'rejected' ? outcome.reasons : [];
}

function breaker(db: SqliteDatabase): unknown {
  return db
    .prepare(
      'SELECT state, safety_revision, stop_reason, stopped_at, resumed_by_device_id FROM safety_breaker WHERE singleton = 1',
    )
    .get();
}

function windowCounts(db: SqliteDatabase): unknown[] {
  return db
    .prepare(
      'SELECT window_start, scope_key, count FROM safety_window_counts ORDER BY scope_key',
    )
    .all();
}

function autoActions(db: SqliteDatabase): unknown[] {
  return db
    .prepare(
      'SELECT operation_id, action_kind, policy_version, completed_at, undo_deadline FROM auto_actions ORDER BY operation_id',
    )
    .all();
}

function undoRows(db: SqliteDatabase): unknown[] {
  return db
    .prepare(
      'SELECT undo_id, operation_id, compensation_operation_id, status, requested_at FROM undo_records ORDER BY requested_at, undo_id',
    )
    .all();
}

// 方針で承認済み（版 1）の外部変更を、準備・送出・照合・結果まで進める。結果の版は 5。
function finishAuto(
  db: SqliteDatabase,
  operationId: string,
  now: number,
  to: 'succeeded' | 'not_executed' = 'succeeded',
): void {
  const prepare = prepareCommand(operationId, '1');
  committed(exec(db, prepare, now));
  committed(
    exec(db, dispatchCommand(operationId, '2', prepare.attempt_id), now),
  );
  committed(
    exec(
      db,
      resultCommand(operationId, '3', prepare.attempt_id, 'reconciling'),
      now,
    ),
  );
  committed(
    exec(db, resultCommand(operationId, '4', prepare.attempt_id, to), now),
  );
}

// 画面で承認した操作（補償の操作など）を結果まで進める。結果の版は 6。
function finishScreen(
  db: SqliteDatabase,
  operationId: string,
  now: number,
  to: 'succeeded' | 'not_executed' | 'unknown_held',
): void {
  committed(exec(db, approveCommand(operationId, '1'), now));
  const prepare = prepareCommand(operationId, '2');
  committed(exec(db, prepare, now));
  committed(
    exec(db, dispatchCommand(operationId, '3', prepare.attempt_id), now),
  );
  committed(
    exec(
      db,
      resultCommand(operationId, '4', prepare.attempt_id, 'reconciling'),
      now,
    ),
  );
  committed(
    exec(db, resultCommand(operationId, '5', prepare.attempt_id, to), now),
  );
}

function policyApprove(
  operationId: string,
  targetKey: string | null,
): ApproveOperationCommand {
  return {
    ...approveCommand(operationId, '1'),
    route: 'policy_auto',
    device_id: null,
    preview_id: null,
    preview_valid: false,
    policy_version: '3',
    safety_target_key: targetKey,
  };
}

test('twenty automatic approvals fit in ten minutes; the twenty-first stops the breaker and is not recorded', async () => {
  await withStore((db) => {
    for (let i = 1; i <= 20; i += 1)
      assert.equal(
        committed(exec(db, createCommand(`op-${i}`, { auto: true }), T0 + i)),
        '1',
      );
    assert.deepEqual(readSafetyState(db).auto_approvals, {
      window_started_at: new Date(T0 + 1).toISOString(),
      auto_approvals: 20,
      limit: 20,
      window_minutes: 10,
    });
    // 21 件目は記録せず、停止だけを commit する。
    assert.deepEqual(
      reasons(exec(db, createCommand('op-21', { auto: true }), T0 + 21)),
      ['rate_exceeded'],
    );
    assert.equal(operationState(db, 'op-21'), undefined);
    assert.deepEqual(breaker(db), {
      state: 'stopped',
      safety_revision: 1,
      stop_reason: 'rate_exceeded',
      stopped_at: T0 + 21,
      resumed_by_device_id: null,
    });
    // 停止中は数えずに拒否する。
    assert.deepEqual(
      reasons(exec(db, createCommand('op-22', { auto: true }), T0 + 22)),
      ['safety_stopped'],
    );
    assert.equal(readSafetyState(db).auto_approvals?.auto_approvals, 20);
    // 画面の承認を待つ操作は停止と関係なく作れる。
    assert.equal(committed(exec(db, createCommand('op-screen'), T0 + 23)), '1');
  });
});

test('a new window starts exactly ten minutes after the first approval of the old one', async () => {
  await withStore((db) => {
    for (let i = 1; i <= 20; i += 1)
      committed(exec(db, createCommand(`op-${i}`, { auto: true }), T0));
    // 9 分 59.999 秒は同じ窓（21 件目）なので止まる。窓の境界は別の DB で確かめる。
    committed(
      exec(db, createCommand('op-21', { auto: true }), T0 + 10 * MINUTE),
    );
    assert.deepEqual(readSafetyState(db).auto_approvals, {
      window_started_at: new Date(T0 + 10 * MINUTE).toISOString(),
      auto_approvals: 1,
      limit: 20,
      window_minutes: 10,
    });
    assert.equal(readSafetyState(db).state, 'running');
  });
  await withStore((db) => {
    for (let i = 1; i <= 20; i += 1)
      committed(exec(db, createCommand(`op-${i}`, { auto: true }), T0));
    assert.deepEqual(
      reasons(
        exec(db, createCommand('op-21', { auto: true }), T0 + 10 * MINUTE - 1),
      ),
      ['rate_exceeded'],
    );
  });
});

test('the third automatic action on the same target within an hour stops the breaker', async () => {
  await withStore((db) => {
    const same = { auto: true, target_key: 'label:mail-001' } as const;
    committed(exec(db, createCommand('op-1', same), T0));
    committed(exec(db, createCommand('op-2', same), T0 + 30 * MINUTE));
    // 別の対象は数えが分かれる。
    committed(
      exec(
        db,
        createCommand('op-x', { auto: true, target_key: 'label:mail-002' }),
        T0 + 31 * MINUTE,
      ),
    );
    assert.deepEqual(
      reasons(exec(db, createCommand('op-3', same), T0 + 59 * MINUTE)),
      ['same_target_repeated'],
    );
    assert.equal(operationState(db, 'op-3'), undefined);
    assert.deepEqual(breaker(db), {
      state: 'stopped',
      safety_revision: 1,
      stop_reason: 'same_target_repeated',
      stopped_at: T0 + 59 * MINUTE,
      resumed_by_device_id: null,
    });
  });
  await withStore((db) => {
    const same = { auto: true, target_key: 'label:mail-001' } as const;
    committed(exec(db, createCommand('op-1', same), T0));
    committed(exec(db, createCommand('op-2', same), T0 + 30 * MINUTE));
    // 最初の 1 件から 1 時間ちょうどで新しい窓になる。
    committed(exec(db, createCommand('op-3', same), T0 + 60 * MINUTE));
    assert.deepEqual(windowCounts(db), [
      { window_start: T0 + 60 * MINUTE, scope_key: 'policy_auto', count: 1 },
      {
        window_start: T0 + 60 * MINUTE,
        scope_key: 'same_target:label:mail-001',
        count: 1,
      },
    ]);
  });
});

test('only the kinds on the automatic list can be approved by policy, and nothing is counted otherwise', async () => {
  await withStore((db) => {
    assert.deepEqual(
      reasons(
        exec(
          db,
          createCommand('op-send', { auto: true, operation_kind: 'mail.send' }),
          T0,
        ),
      ),
      ['operation_kind_not_auto'],
    );
    assert.deepEqual(windowCounts(db), []);
    // 承認待ちから方針で承認する経路も同じ数えと鍵を使う。
    committed(exec(db, createCommand('op-1'), T0));
    assert.deepEqual(reasons(exec(db, policyApprove('op-1', null), T0)), [
      'safety_target_key_invalid',
    ]);
    assert.equal(
      committed(exec(db, policyApprove('op-1', 'label:m1'), T0)),
      '2',
    );
    assert.equal(readSafetyState(db).auto_approvals?.auto_approvals, 1);
    // 画面の承認は数えない。
    committed(exec(db, createCommand('op-2'), T0));
    committed(exec(db, approveCommand('op-2', '1'), T0));
    assert.equal(readSafetyState(db).auto_approvals?.auto_approvals, 1);
  });
});

test('a policy-approved success goes on the automatic list with a 30-day undo deadline; a screen-approved one does not', async () => {
  await withStore((db) => {
    committed(exec(db, createCommand('op-auto', { auto: true }), T0));
    finishAuto(db, 'op-auto', T0 + 5);
    committed(exec(db, createCommand('op-screen'), T0));
    finishScreen(db, 'op-screen', T0 + 6, 'succeeded');
    assert.deepEqual(autoActions(db), [
      {
        operation_id: 'op-auto',
        action_kind: 'label_mail',
        policy_version: 3,
        completed_at: T0 + 5,
        undo_deadline: T0 + 5 + 2_592_000_000,
      },
    ]);
  });
});

test('an automatic approval made before the stop is held at dispatch while the breaker is stopped', async () => {
  await withStore((db) => {
    committed(exec(db, createCommand('op-held', { auto: true }), T0));
    for (let i = 1; i <= 19; i += 1)
      committed(exec(db, createCommand(`op-${i}`, { auto: true }), T0));
    reasons(exec(db, createCommand('op-over', { auto: true }), T0 + 1));
    const prepare = prepareCommand('op-held', '1');
    committed(exec(db, prepare, T0 + 2));
    assert.deepEqual(
      reasons(
        exec(db, dispatchCommand('op-held', '2', prepare.attempt_id), T0 + 3),
      ),
      ['safety_stopped'],
    );
  });
});

test('an undo is a new compensation operation linked to the automatic action, one at a time, within 30 days', async () => {
  await withStore((db) => {
    committed(exec(db, createCommand('op-auto', { auto: true }), T0));
    finishAuto(db, 'op-auto', T0 + 5);
    const undo = { undo_id: 'undo-1', operation_id: 'op-auto' };
    committed(exec(db, createCommand('op-comp', { undo_of: undo }), T0 + 10));
    assert.deepEqual(undoRows(db), [
      {
        undo_id: 'undo-1',
        operation_id: 'op-auto',
        compensation_operation_id: 'op-comp',
        status: 'in_progress',
        requested_at: T0 + 10,
      },
    ]);
    // 同じ自動実行の取り消しを並行させない。
    assert.deepEqual(
      reasons(
        exec(
          db,
          createCommand('op-comp-2', {
            undo_of: { undo_id: 'undo-2', operation_id: 'op-auto' },
          }),
          T0 + 11,
        ),
      ),
      ['undo_in_progress'],
    );
    // 補償の操作は方針では承認しない。
    assert.deepEqual(
      reasons(exec(db, policyApprove('op-comp', 'label:comp'), T0 + 12)),
      ['undo_auto_approval'],
    );
    finishScreen(db, 'op-comp', T0 + 20, 'succeeded');
    assert.deepEqual(
      undoRows(db).map((row) => (row as { status: string }).status),
      ['undone'],
    );
    // 補償の操作の成功は自動実行の一覧に載せない。
    assert.equal(autoActions(db).length, 1);
  });
});

test('undo is refused for an operation that is not an automatic action, after the deadline, or with a policy approval', async () => {
  await withStore((db) => {
    committed(exec(db, createCommand('op-screen'), T0));
    finishScreen(db, 'op-screen', T0, 'succeeded');
    assert.deepEqual(
      reasons(
        exec(
          db,
          createCommand('op-c1', {
            undo_of: { undo_id: 'u1', operation_id: 'op-screen' },
          }),
          T0 + 1,
        ),
      ),
      ['undo_target_not_auto'],
    );
    assert.equal(operationState(db, 'op-c1'), undefined);
    committed(exec(db, createCommand('op-auto', { auto: true }), T0));
    finishAuto(db, 'op-auto', T0 + 100);
    const deadline = T0 + 100 + 30 * DAY;
    committed(
      exec(
        db,
        createCommand('op-c2', {
          undo_of: { undo_id: 'u2', operation_id: 'op-auto' },
        }),
        deadline,
      ),
    );
  });
  await withStore((db) => {
    committed(exec(db, createCommand('op-auto', { auto: true }), T0));
    finishAuto(db, 'op-auto', T0 + 100);
    assert.deepEqual(
      reasons(
        exec(
          db,
          createCommand('op-c', {
            undo_of: { undo_id: 'u', operation_id: 'op-auto' },
          }),
          T0 + 100 + 30 * DAY + 1,
        ),
      ),
      ['undo_expired'],
    );
    assert.deepEqual(
      reasons(
        exec(
          db,
          createCommand('op-c', {
            auto: true,
            undo_of: { undo_id: 'u', operation_id: 'op-auto' },
          }),
          T0 + 101,
        ),
      ),
      ['undo_auto_approval'],
    );
  });
});

test('a draft deletion is made only as the compensation of an undo (ADR 0156)', async () => {
  await withStore((db) => {
    // 取り消しでない下書きの削除は、画面の承認待ちでも方針の自動承認でも作らない。
    assert.deepEqual(
      reasons(
        exec(
          db,
          createCommand('op-delete', { operation_kind: 'mail.draft.delete' }),
          T0,
        ),
      ),
      ['undo_only_kind'],
    );
    assert.equal(operationState(db, 'op-delete'), undefined);
    committed(
      exec(
        db,
        createCommand('op-draft', {
          auto: true,
          operation_kind: 'mail.draft.create',
        }),
        T0,
      ),
    );
    finishAuto(db, 'op-draft', T0 + 5);
    committed(
      exec(
        db,
        createCommand('op-delete', {
          operation_kind: 'mail.draft.delete',
          undo_of: { undo_id: 'u-draft', operation_id: 'op-draft' },
        }),
        T0 + 10,
      ),
    );
    assert.deepEqual(
      undoRows(db).map((row) => (row as { status: string }).status),
      ['in_progress'],
    );
  });
});

// 用事の登録・取り消しの LocalCommand（ADR 0030・0157）。用事の正本の暗号文は合成の乱数で、ここでは復号しない。
const localCommand = (
  kind: 'operation.apply_local' | 'operation.delete_local',
  operationId: string,
  expected: string,
  taskId: string,
): DbCommand =>
  ({
    command_id: randomUUID(),
    kind,
    operation_id: operationId,
    expected_state_revision: expected,
    request_revision: null,
    permission_revision: '0',
    forgetting_generation: '0',
    connection_id: null,
    request: null,
    attempt_id: randomUUID(),
    task_id: taskId,
    ...(kind === 'operation.apply_local'
      ? { list_id: 'inbox', content: sealedIntent() }
      : {}),
  }) as DbCommand;

const taskRows = (db: SqliteDatabase): unknown[] =>
  db.prepare('SELECT task_id, status FROM tasks ORDER BY task_id').all();

const taskBlobCount = (db: SqliteDatabase): number =>
  db
    .prepare(
      "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'tasks' AND purpose = 'task_content'",
    )
    .pluck()
    .get() as number;

test('a task deletion is made only as an undo and deletes only the open task its original registered (ADR 0157)', async () => {
  await withStore((db) => {
    assert.deepEqual(
      reasons(
        exec(
          db,
          createCommand('op-delete', {
            operation_kind: 'task.delete',
            effect_route: 'local_command',
          }),
          T0,
        ),
      ),
      ['undo_only_kind'],
    );
    // 方針で自動承認した用事の登録と、もう一つ別の用事。
    for (const id of ['op-task', 'op-other']) {
      committed(
        exec(
          db,
          createCommand(id, {
            auto: true,
            operation_kind: 'task.create',
            effect_route: 'local_command',
          }),
          T0,
        ),
      );
      committed(
        exec(
          db,
          localCommand('operation.apply_local', id, '1', `task-${id}`),
          T0 + 1,
        ),
      );
    }
    assert.equal(taskBlobCount(db), 2);
    committed(
      exec(
        db,
        createCommand('op-delete', {
          operation_kind: 'task.delete',
          effect_route: 'local_command',
          undo_of: { undo_id: 'u-task', operation_id: 'op-task' },
        }),
        T0 + 10,
      ),
    );
    committed(exec(db, approveCommand('op-delete', '1'), T0 + 11));
    // 用事の登録の命令では、取り消しの操作を適用しない（逆も同じ）。
    assert.deepEqual(
      reasons(
        exec(
          db,
          localCommand('operation.apply_local', 'op-delete', '2', 'task-x'),
          T0 + 12,
        ),
      ),
      ['operation_kind_mismatch'],
    );
    // 別の操作が作った用事・完了した用事・ない用事は消さず、操作は approved のまま残る。
    assert.deepEqual(
      reasons(
        exec(
          db,
          localCommand(
            'operation.delete_local',
            'op-delete',
            '2',
            'task-op-other',
          ),
          T0 + 12,
        ),
      ),
      ['target_changed'],
    );
    db.prepare("UPDATE tasks SET status = 'done' WHERE task_id = ?").run(
      'task-op-task',
    );
    assert.deepEqual(
      reasons(
        exec(
          db,
          localCommand(
            'operation.delete_local',
            'op-delete',
            '2',
            'task-op-task',
          ),
          T0 + 12,
        ),
      ),
      ['target_changed'],
    );
    assert.deepEqual(
      reasons(
        exec(
          db,
          localCommand('operation.delete_local', 'op-delete', '2', 'task-none'),
          T0 + 12,
        ),
      ),
      ['target_changed'],
    );
    assert.equal(operationState(db, 'op-delete')?.state, 'approved');
    db.prepare("UPDATE tasks SET status = 'open' WHERE task_id = ?").run(
      'task-op-task',
    );
    committed(
      exec(
        db,
        localCommand(
          'operation.delete_local',
          'op-delete',
          '2',
          'task-op-task',
        ),
        T0 + 13,
      ),
    );
    assert.equal(operationState(db, 'op-delete')?.state, 'succeeded');
    assert.deepEqual(taskRows(db), [
      { task_id: 'task-op-other', status: 'open' },
    ]);
    assert.equal(taskBlobCount(db), 1);
    assert.deepEqual(
      undoRows(db).map((row) => (row as { status: string }).status),
      ['undone'],
    );
    // 取り消しの成功は自動実行の一覧に載せない。
    assert.equal(autoActions(db).length, 2);
  });
});

test('three compensation failures in a row stop the breaker; a success in between resets the run', async () => {
  const undoAndFail = (
    db: SqliteDatabase,
    n: number,
    to: 'succeeded' | 'not_executed' | 'unknown_held',
  ): void => {
    committed(
      exec(db, createCommand(`op-a${n}`, { auto: true }), T0 + n * 100),
    );
    finishAuto(db, `op-a${n}`, T0 + n * 100 + 1);
    committed(
      exec(
        db,
        createCommand(`op-c${n}`, {
          undo_of: { undo_id: `u${n}`, operation_id: `op-a${n}` },
        }),
        T0 + n * 100 + 2,
      ),
    );
    finishScreen(db, `op-c${n}`, T0 + n * 100 + 3, to);
  };
  await withStore((db) => {
    undoAndFail(db, 1, 'not_executed');
    undoAndFail(db, 2, 'not_executed');
    assert.equal(readSafetyState(db).state, 'running');
    undoAndFail(db, 3, 'not_executed');
    assert.deepEqual(breaker(db), {
      state: 'stopped',
      safety_revision: 1,
      stop_reason: 'compensation_failures',
      stopped_at: T0 + 303,
      resumed_by_device_id: null,
    });
  });
  await withStore((db) => {
    undoAndFail(db, 1, 'not_executed');
    undoAndFail(db, 2, 'succeeded');
    undoAndFail(db, 3, 'not_executed');
    // 結果不明は失敗に数えない。
    undoAndFail(db, 4, 'unknown_held');
    undoAndFail(db, 5, 'not_executed');
    assert.equal(readSafetyState(db).state, 'running');
    assert.deepEqual(
      undoRows(db).map((row) => (row as { status: string }).status),
      ['failed', 'undone', 'failed', 'unknown', 'failed'],
    );
  });
});

// U313（ADR 0155）: 補償の操作が止まったときの取り消しの記録。
function startAutoAndUndo(db: SqliteDatabase, n: number): void {
  committed(exec(db, createCommand(`op-a${n}`, { auto: true }), T0 + n * 100));
  finishAuto(db, `op-a${n}`, T0 + n * 100 + 1);
  committed(
    exec(
      db,
      createCommand(`op-c${n}`, {
        undo_of: { undo_id: `u${n}`, operation_id: `op-a${n}` },
      }),
      T0 + n * 100 + 2,
    ),
  );
}

function statuses(db: SqliteDatabase): string[] {
  return undoRows(db).map((row) => (row as { status: string }).status);
}

test('a compensation cancelled before dispatch frees the undo so the same action can be undone again', async () => {
  await withStore((db) => {
    startAutoAndUndo(db, 1);
    assert.equal(
      committed(exec(db, cancelCommand('op-c1', '1'), T0 + 110)),
      '2',
    );
    assert.equal(operationState(db, 'op-c1')?.state, 'cancelled');
    assert.deepEqual(statuses(db), ['failed']);
    committed(
      exec(
        db,
        createCommand('op-c1b', {
          undo_of: { undo_id: 'u1b', operation_id: 'op-a1' },
        }),
        T0 + 120,
      ),
    );
    assert.deepEqual(statuses(db), ['failed', 'in_progress']);
    finishScreen(db, 'op-c1b', T0 + 130, 'succeeded');
    assert.deepEqual(statuses(db), ['failed', 'undone']);
  });
});

test('a cancelled compensation does not count toward three failures in a row', async () => {
  await withStore((db) => {
    startAutoAndUndo(db, 1);
    finishScreen(db, 'op-c1', T0 + 103, 'not_executed');
    startAutoAndUndo(db, 2);
    committed(exec(db, cancelCommand('op-c2', '1'), T0 + 203));
    startAutoAndUndo(db, 3);
    finishScreen(db, 'op-c3', T0 + 303, 'not_executed');
    assert.deepEqual(statuses(db), ['failed', 'failed', 'failed']);
    assert.equal(readSafetyState(db).state, 'running');
    startAutoAndUndo(db, 4);
    finishScreen(db, 'op-c4', T0 + 403, 'not_executed');
    assert.deepEqual(breaker(db), {
      state: 'stopped',
      safety_revision: 1,
      stop_reason: 'compensation_failures',
      stopped_at: T0 + 403,
      resumed_by_device_id: null,
    });
  });
});

test('retrying a not-executed compensation puts the undo back in progress, unless another undo has started', async () => {
  await withStore((db) => {
    startAutoAndUndo(db, 1);
    finishScreen(db, 'op-c1', T0 + 103, 'not_executed');
    assert.deepEqual(statuses(db), ['failed']);
    const retry = { ...prepareCommand('op-c1', '6'), retry: true };
    assert.equal(committed(exec(db, retry, T0 + 110)), '7');
    assert.deepEqual(statuses(db), ['in_progress']);
    committed(
      exec(db, dispatchCommand('op-c1', '7', retry.attempt_id), T0 + 111),
    );
    committed(
      exec(
        db,
        resultCommand('op-c1', '8', retry.attempt_id, 'reconciling'),
        T0 + 112,
      ),
    );
    committed(
      exec(
        db,
        resultCommand('op-c1', '9', retry.attempt_id, 'succeeded'),
        T0 + 113,
      ),
    );
    assert.deepEqual(statuses(db), ['undone']);
  });
  await withStore((db) => {
    startAutoAndUndo(db, 1);
    finishScreen(db, 'op-c1', T0 + 103, 'not_executed');
    committed(
      exec(
        db,
        createCommand('op-c1b', {
          undo_of: { undo_id: 'u1b', operation_id: 'op-a1' },
        }),
        T0 + 120,
      ),
    );
    const retry = { ...prepareCommand('op-c1', '6'), retry: true };
    assert.deepEqual(reasons(exec(db, retry, T0 + 130)), ['retry_not_allowed']);
    assert.equal(operationState(db, 'op-c1')?.state, 'not_executed');
    assert.deepEqual(statuses(db), ['failed', 'in_progress']);
  });
});

test('only a registered device can resume, at the current revision; resuming clears the window counts', async () => {
  await withStore((db) => {
    for (let i = 1; i <= 20; i += 1)
      committed(exec(db, createCommand(`op-${i}`, { auto: true }), T0));
    reasons(exec(db, createCommand('op-21', { auto: true }), T0));
    db.prepare(
      "UPDATE devices SET revoked_at = 2000 WHERE device_id = 'dev-2'",
    ).run();
    assert.deepEqual(
      resumeSafetyBreaker(db, {
        device_id: 'dev-9',
        expected_safety_revision: '1',
        now: T0 + 1,
      }),
      { ok: false, reasons: ['device_not_registered'] },
    );
    assert.deepEqual(
      resumeSafetyBreaker(db, {
        device_id: 'dev-2',
        expected_safety_revision: '1',
        now: T0 + 1,
      }),
      { ok: false, reasons: ['device_not_registered'] },
    );
    assert.deepEqual(
      resumeSafetyBreaker(db, {
        device_id: 'dev-1',
        expected_safety_revision: '0',
        now: T0 + 1,
      }),
      { ok: false, reasons: ['safety_revision_changed'] },
    );
    assert.deepEqual(
      resumeSafetyBreaker(db, {
        device_id: 'dev-1',
        expected_safety_revision: '1',
        now: T0 + 1,
      }),
      { ok: true, safety_revision: '2' },
    );
    assert.deepEqual(breaker(db), {
      state: 'running',
      safety_revision: 2,
      stop_reason: null,
      stopped_at: null,
      resumed_by_device_id: 'dev-1',
    });
    assert.deepEqual(windowCounts(db), []);
    assert.deepEqual(
      resumeSafetyBreaker(db, {
        device_id: 'dev-1',
        expected_safety_revision: '2',
        now: T0 + 2,
      }),
      { ok: false, reasons: ['safety_not_stopped'] },
    );
    assert.equal(
      committed(exec(db, createCommand('op-22', { auto: true }), T0 + 3)),
      '1',
    );
  });
});

// ---- 自動実行の一覧と worker の safety の通り道（ADR 0152） -------------------------------------------------

// 自動実行を 5 件（取り消しなし・取り消し済み・取り消し中・取り消しの失敗・取り消しの結果不明）と、
// 一覧に載らない操作（画面で承認した成功・方針で承認しただけで未完了）を置く。
function seedAutoActions(db: SqliteDatabase): void {
  const auto = (id: string, createdAt: number, finishedAt: number): void => {
    committed(exec(db, createCommand(id, { auto: true }), createdAt));
    finishAuto(db, id, finishedAt);
  };
  const undo = (
    id: string,
    of: string,
    at: number,
    to: 'succeeded' | 'not_executed' | 'unknown_held' | null,
  ): void => {
    committed(
      exec(
        db,
        createCommand(id, {
          undo_of: { undo_id: `undo-${id}`, operation_id: of },
        }),
        at,
      ),
    );
    if (to !== null) finishScreen(db, id, at + 1, to);
  };
  auto('op-a', T0, T0 + 10);
  auto('op-b', T0 + 1, T0 + 20);
  undo('op-cb', 'op-b', T0 + 21, 'succeeded');
  auto('op-c', T0 + 2, T0 + 30);
  undo('op-cc', 'op-c', T0 + 31, null);
  auto('op-d', T0 + 3, T0 + 40);
  undo('op-cd', 'op-d', T0 + 41, 'not_executed');
  auto('op-e', T0 + 4, T0 + 50);
  undo('op-ce', 'op-e', T0 + 51, 'unknown_held');
  committed(exec(db, createCommand('op-screen'), T0 + 5));
  finishScreen(db, 'op-screen', T0 + 60, 'succeeded');
  committed(exec(db, createCommand('op-pending', { auto: true }), T0 + 6));
}

// 完了の時刻（T0 + ms）の項目。結果の版は 5、内容版は 1（finishAuto と createCommand の値）。
function item(
  operationId: string,
  completedIso: string,
  deadlineIso: string,
  undoState: string,
): unknown {
  return {
    operation_id: operationId,
    action_kind: 'label_mail',
    policy_version: '3',
    state_revision: '5',
    completed_at: completedIso,
    undo_state: undoState,
    undo_deadline: deadlineIso,
    undo_target: { content_version: '1', content_hash: CONTENT_HASH },
  };
}

// 方針で自動承認した 6 件（op-a〜op-e と op-pending）。窓は T0 に始まる。
const SIX_IN_WINDOW = {
  window_started_at: '2027-01-15T08:00:00.000Z',
  auto_approvals: 6,
  limit: 20,
  window_minutes: 10,
};

test('the automatic list is newest first and shows undo as undone, in progress, unavailable (kind not undoable) or expired', async () => {
  await withStore((db) => {
    assert.deepEqual(listAutoActions(db, T0), {
      safety: {
        state: 'running',
        safety_revision: '0',
        stop_reason: null,
        stopped_at: null,
        auto_approvals: null,
      },
      items: [],
    });
    seedAutoActions(db);
    const items = (now: number): unknown => listAutoActions(db, now).items;
    assert.deepEqual(listAutoActions(db, T0 + 100), {
      safety: {
        state: 'running',
        safety_revision: '0',
        stop_reason: null,
        stopped_at: null,
        auto_approvals: SIX_IN_WINDOW,
      },
      items: [
        item(
          'op-e',
          '2027-01-15T08:00:00.050Z',
          '2027-02-14T08:00:00.050Z',
          'in_progress',
        ),
        item(
          'op-d',
          '2027-01-15T08:00:00.040Z',
          '2027-02-14T08:00:00.040Z',
          'unavailable',
        ),
        item(
          'op-c',
          '2027-01-15T08:00:00.030Z',
          '2027-02-14T08:00:00.030Z',
          'in_progress',
        ),
        item(
          'op-b',
          '2027-01-15T08:00:00.020Z',
          '2027-02-14T08:00:00.020Z',
          'undone',
        ),
        item(
          'op-a',
          '2027-01-15T08:00:00.010Z',
          '2027-02-14T08:00:00.010Z',
          'unavailable',
        ),
      ],
    });
    // 期限ちょうどはまだ期限内。1 ms 過ぎたら期限切れ。取り消し済み・取り消し中は期限の後もそのまま。
    const states = (now: number): unknown =>
      (items(now) as { operation_id: string; undo_state: string }[]).map(
        (row) => [row.operation_id, row.undo_state],
      );
    assert.deepEqual(states(T0 + 10 + 2_592_000_000), [
      ['op-e', 'in_progress'],
      ['op-d', 'unavailable'],
      ['op-c', 'in_progress'],
      ['op-b', 'undone'],
      ['op-a', 'unavailable'],
    ]);
    assert.deepEqual(states(T0 + 41 + 2_592_000_000), [
      ['op-e', 'in_progress'],
      ['op-d', 'expired'],
      ['op-c', 'in_progress'],
      ['op-b', 'undone'],
      ['op-a', 'expired'],
    ]);
    // 取り消せる種類に label_mail を渡すと、有効な記録のない期限内の行だけが available になる（ADR 0153）。
    const undoable = (now: number): unknown =>
      listAutoActions(db, now, ['label_mail']).items.map((row) => [
        row.operation_id,
        row.undo_state,
      ]);
    assert.deepEqual(undoable(T0 + 100), [
      ['op-e', 'in_progress'],
      ['op-d', 'available'],
      ['op-c', 'in_progress'],
      ['op-b', 'undone'],
      ['op-a', 'available'],
    ]);
    assert.deepEqual(undoable(T0 + 41 + 2_592_000_000), [
      ['op-e', 'in_progress'],
      ['op-d', 'expired'],
      ['op-c', 'in_progress'],
      ['op-b', 'undone'],
      ['op-a', 'expired'],
    ]);
    // 他の種類だけを渡しても label_mail は取り消せるように見せない。
    assert.deepEqual(
      listAutoActions(db, T0 + 100, ['create_task']).items.map(
        (row) => row.undo_state,
      ),
      ['in_progress', 'unavailable', 'in_progress', 'undone', 'unavailable'],
    );
  });
});

test('one automatic action is read by id with the same undo state as the list; anything else reads as null', async () => {
  await withStore((db) => {
    seedAutoActions(db);
    const context = { platform: 'macos' as const, halted: false };
    const read = (operationId: string, kinds?: readonly 'label_mail'[]) =>
      executeSafetyOp(
        db,
        {
          kind: 'safety.auto_action',
          operation_id: operationId,
          now: T0 + 100,
          ...(kinds === undefined ? {} : { undoable_kinds: kinds }),
        },
        context,
      );
    assert.deepEqual(read('op-d', ['label_mail']), {
      result: {
        ok: true,
        value: item(
          'op-d',
          '2027-01-15T08:00:00.040Z',
          '2027-02-14T08:00:00.040Z',
          'available',
        ),
      },
      halt: false,
    });
    assert.deepEqual(read('op-d'), {
      result: {
        ok: true,
        value: item(
          'op-d',
          '2027-01-15T08:00:00.040Z',
          '2027-02-14T08:00:00.040Z',
          'unavailable',
        ),
      },
      halt: false,
    });
    // 画面で承認した操作・未完了の自動承認・ない操作は自動実行ではない。
    for (const id of ['op-screen', 'op-pending', 'op-none'])
      assert.deepEqual(read(id, ['label_mail']), {
        result: { ok: true, value: null },
        halt: false,
      });
    assert.deepEqual(
      executeSafetyOp(
        db,
        {
          kind: 'safety.auto_action',
          operation_id: '',
          now: Number.NaN,
          undoable_kinds: ['send_mail' as 'label_mail'],
        },
        context,
      ),
      {
        result: {
          ok: false,
          outcome: 'rejected',
          reasons: [
            'now_invalid',
            'undoable_kinds_invalid',
            'operation_id_invalid',
          ],
        },
        halt: false,
      },
    );
  });
});

test('an undo pressed on the list creates the compensation already approved on screen by that device', async () => {
  await withStore((db) => {
    committed(exec(db, createCommand('op-auto', { auto: true }), T0));
    finishAuto(db, 'op-auto', T0 + 5);
    const pressed = (id: string, device: string) =>
      createCommand(id, {
        undo_of: {
          undo_id: `undo-${id}`,
          operation_id: 'op-auto',
          screen_approval: { approval_id: `appr-${id}`, device_id: device },
        },
      });
    // 失効した端末・登録のない端末からは作らない（何も書かない）。
    db.prepare(
      "UPDATE devices SET revoked_at = 2000 WHERE device_id = 'dev-2'",
    ).run();
    assert.deepEqual(reasons(exec(db, pressed('op-x', 'dev-2'), T0 + 9)), [
      'device_not_registered',
    ]);
    assert.deepEqual(reasons(exec(db, pressed('op-y', 'dev-9'), T0 + 9)), [
      'device_not_registered',
    ]);
    assert.deepEqual(undoRows(db), []);
    assert.equal(
      committed(exec(db, pressed('op-comp', 'dev-1'), T0 + 10)),
      '1',
    );
    assert.deepEqual(operationState(db, 'op-comp'), {
      state: 'approved',
      state_revision: 1,
    });
    assert.deepEqual(
      db
        .prepare(
          'SELECT approval_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at FROM approvals WHERE operation_id = ?',
        )
        .all('op-comp'),
      [
        {
          approval_id: 'appr-op-comp',
          content_version: 1,
          content_hash: CONTENT_HASH,
          route: 'screen',
          device_id: 'dev-1',
          preview_id: 'undo-op-comp',
          policy_version: null,
          status: 'valid',
          approved_at: T0 + 10,
        },
      ],
    );
    assert.deepEqual(undoRows(db), [
      {
        undo_id: 'undo-op-comp',
        operation_id: 'op-auto',
        compensation_operation_id: 'op-comp',
        status: 'in_progress',
        requested_at: T0 + 10,
      },
    ]);
    // 承認済みから準備へ進める（承認の命令は要らない）。結果まで進めると取り消し済みになる。
    const prepare = prepareCommand('op-comp', '1');
    committed(exec(db, prepare, T0 + 11));
    committed(
      exec(db, dispatchCommand('op-comp', '2', prepare.attempt_id), T0 + 11),
    );
    committed(
      exec(
        db,
        resultCommand('op-comp', '3', prepare.attempt_id, 'reconciling'),
        T0 + 11,
      ),
    );
    committed(
      exec(
        db,
        resultCommand('op-comp', '4', prepare.attempt_id, 'succeeded'),
        T0 + 12,
      ),
    );
    assert.deepEqual(
      undoRows(db).map((row) => (row as { status: string }).status),
      ['undone'],
    );
    // 期限を過ぎた押下は承認も取り消しの記録も書かない。
    committed(exec(db, createCommand('op-old', { auto: true }), T0));
    finishAuto(db, 'op-old', T0 + 20);
    const late = createCommand('op-late', {
      undo_of: {
        undo_id: 'undo-late',
        operation_id: 'op-old',
        screen_approval: { approval_id: 'appr-late', device_id: 'dev-1' },
      },
    });
    assert.deepEqual(reasons(exec(db, late, T0 + 21 + 2_592_000_000)), [
      'undo_expired',
    ]);
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM approvals WHERE approval_id = ?')
        .get('appr-late')?.['n' as never],
      0,
    );
    // 押下の承認の形が不正なら命令の形の検査で拒否する。
    assert.deepEqual(
      reasons(
        exec(
          db,
          createCommand('op-bad', {
            undo_of: {
              undo_id: 'undo-bad',
              operation_id: 'op-old',
              screen_approval: { approval_id: '', device_id: 'dev-1' },
            },
          }),
          T0 + 30,
        ),
      ),
      ['undo_of_invalid'],
    );
  });
});

test('the safety op reads the state and resumes only a stopped breaker at its revision, returning the state after resuming', async () => {
  await withStore((db) => {
    const context = { platform: 'macos' as const, halted: false };
    assert.deepEqual(executeSafetyOp(db, { kind: 'safety.state' }, context), {
      result: {
        ok: true,
        value: {
          state: 'running',
          safety_revision: '0',
          stop_reason: null,
          stopped_at: null,
          auto_approvals: null,
        },
      },
      halt: false,
    });
    const resume = (revision: string, device = 'dev-1') =>
      executeSafetyOp(
        db,
        {
          kind: 'safety.resume',
          device_id: device,
          expected_safety_revision: revision,
          now: T0 + 5,
        },
        context,
      );
    assert.deepEqual(resume('0'), {
      result: {
        ok: false,
        outcome: 'rejected',
        reasons: ['safety_not_stopped'],
      },
      halt: false,
    });
    db.transaction(() => stopSafetyBreaker(db, T0, 'rate_exceeded'))();
    assert.deepEqual(resume('0'), {
      result: {
        ok: false,
        outcome: 'rejected',
        reasons: ['safety_revision_changed'],
      },
      halt: false,
    });
    assert.deepEqual(resume('1', 'dev-9'), {
      result: {
        ok: false,
        outcome: 'rejected',
        reasons: ['device_not_registered'],
      },
      halt: false,
    });
    assert.deepEqual(resume('x'), {
      result: {
        ok: false,
        outcome: 'rejected',
        reasons: ['expected_safety_revision_invalid'],
      },
      halt: false,
    });
    assert.deepEqual(
      executeSafetyOp(
        db,
        {
          kind: 'safety.resume',
          device_id: 'dev-1',
          expected_safety_revision: '1',
          now: T0 + 5,
        },
        { platform: 'macos', halted: true },
      ),
      {
        result: { ok: false, outcome: 'rejected', reasons: ['worker_halted'] },
        halt: false,
      },
    );
    assert.equal(readSafetyState(db).state, 'stopped');
    assert.deepEqual(resume('1'), {
      result: {
        ok: true,
        value: {
          state: 'running',
          safety_revision: '2',
          stop_reason: null,
          stopped_at: null,
          auto_approvals: null,
        },
      },
      halt: false,
    });
    assert.deepEqual(breaker(db), {
      state: 'running',
      safety_revision: 2,
      stop_reason: null,
      stopped_at: null,
      resumed_by_device_id: 'dev-1',
    });
  });
});

test('through the worker, the list and the resume reach the store', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    const db = openSeededDatabase(path);
    try {
      committed(exec(db, createCommand('op-a', { auto: true }), T0));
      finishAuto(db, 'op-a', T0 + 10);
      db.transaction(() =>
        stopSafetyBreaker(db, T0 + 20, 'same_target_repeated'),
      )();
    } finally {
      db.close();
    }
    const client = await DbWorkerClient.start({
      path,
      storeGeneration: STORE_GENERATION,
      responseTimeoutMs: 10_000,
    });
    try {
      assert.deepEqual(
        await client.safety({ kind: 'safety.auto_actions', now: T0 + 100 }),
        {
          ok: true,
          value: {
            safety: {
              state: 'stopped',
              safety_revision: '1',
              stop_reason: 'same_target_repeated',
              stopped_at: T0 + 20,
              auto_approvals: {
                window_started_at: '2027-01-15T08:00:00.000Z',
                auto_approvals: 1,
                limit: 20,
                window_minutes: 10,
              },
            },
            items: [
              item(
                'op-a',
                '2027-01-15T08:00:00.010Z',
                '2027-02-14T08:00:00.010Z',
                'unavailable',
              ),
            ],
          },
        },
      );
      assert.deepEqual(
        await client.safety({
          kind: 'safety.resume',
          device_id: 'dev-1',
          expected_safety_revision: '1',
          now: T0 + 200,
        }),
        {
          ok: true,
          value: {
            state: 'running',
            safety_revision: '2',
            stop_reason: null,
            stopped_at: null,
            auto_approvals: null,
          },
        },
      );
      assert.deepEqual(await client.safety({ kind: 'safety.state' }), {
        ok: true,
        value: {
          state: 'running',
          safety_revision: '2',
          stop_reason: null,
          stopped_at: null,
          auto_approvals: null,
        },
      });
    } finally {
      await client.close();
    }
  });
});
