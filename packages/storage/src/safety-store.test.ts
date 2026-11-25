// 安全停止の時間窓・同じ対象の反復・自動実行の一覧・取り消しの記録・停止の解除（ADR 0147）を、
// worker を介さずに同期で確かめる。期待値は設計 08 §9・03「取り消しと安全停止」の初期値
// （10 分間に 20 件まで、同じ対象は 1 時間に 2 件まで、補償の失敗は 3 回連続で停止、取り消しは 30 日）と
// 0001 の制約から手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeCommand,
  readSafetyState,
  resumeSafetyBreaker,
} from './index.js';
import type {
  ApproveOperationCommand,
  DbCommand,
  SqliteDatabase,
  StoreOutcome,
} from './index.js';
import {
  approveCommand,
  createCommand,
  databasePath,
  dispatchCommand,
  openSeededDatabase,
  operationState,
  prepareCommand,
  resultCommand,
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
