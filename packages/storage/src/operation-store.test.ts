// 操作・承認・試行・受付・イベントの保存（ADR 0018）を、worker を介さずに同期で確かめる。
// DB は一時ディレクトリの書込み接続（WAL・FULL）。期待値は operation-transitions.json などの手書きの fixture と
// 0001 の制約から手で書いた値（state_revision は作成で 1、状態の更新ごとに 1 ずつ増える）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  BULK_WRITE_LIMITS,
  INTERNAL_COMMAND_SCOPE,
  executeCommand,
  listInterruptedOperations,
  readOperation,
  runImmediate,
  writeBulkSlice,
} from './index.js';
import type { DbCommand, SqliteDatabase, StoreOutcome } from './index.js';
import {
  CONTENT_HASH,
  OTHER_CONTENT_HASH,
  RECEIPT_TTL,
  STORE_GENERATION,
  approveCommand,
  cancelCommand,
  createCommand,
  databasePath,
  dispatchCommand,
  effectiveApprovals,
  eventRows,
  openSeededDatabase,
  operationState,
  prepareCommand,
  receiptRows,
  recoverCommand,
  resultCommand,
  sealedIntent,
  storeContext,
  withTempDir,
} from './operation-test-support.js';

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

let clock = 1_000_000;
function run(db: SqliteDatabase, command: DbCommand): StoreOutcome {
  clock += 10;
  const result = executeCommand(db, command, storeContext(clock));
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

// 承認・準備まで進め、試行の ID を返す（state_revision は 3）。
function toPreparing(db: SqliteDatabase, operationId: string): string {
  committed(run(db, createCommand(operationId)));
  committed(run(db, approveCommand(operationId, '1')));
  const prepare = prepareCommand(operationId, '2');
  committed(run(db, prepare));
  return prepare.attempt_id;
}

test('the normal flow commits each step with its state_revision, outbox event and receipt (X01)', async () => {
  await withStore((db) => {
    const steps: { command: DbCommand; state: string; revision: string }[] = [];
    const create = createCommand('op-1');
    const approve = approveCommand('op-1', '1');
    const prepare = prepareCommand('op-1', '2');
    const dispatch = dispatchCommand('op-1', '3', prepare.attempt_id);
    const reconcile = resultCommand(
      'op-1',
      '4',
      prepare.attempt_id,
      'reconciling',
      {
        external_id: 'mail-001',
      },
    );
    const succeed = resultCommand('op-1', '5', prepare.attempt_id, 'succeeded');
    steps.push(
      { command: create, state: 'awaiting_approval', revision: '1' },
      { command: approve, state: 'approved', revision: '2' },
      { command: prepare, state: 'preparing', revision: '3' },
      { command: dispatch, state: 'dispatching', revision: '4' },
      { command: reconcile, state: 'reconciling', revision: '5' },
      { command: succeed, state: 'succeeded', revision: '6' },
    );
    for (const [index, step] of steps.entries()) {
      const outcome = run(db, step.command);
      assert.equal(committed(outcome), step.revision, step.command.kind);
      assert.deepEqual(operationState(db, 'op-1'), {
        state: step.state,
        state_revision: Number(step.revision),
      });
      // イベントは状態の更新ごとに 1 件、受付は命令ごとに 1 件（同じ transaction）。
      const events = eventRows(db);
      assert.equal(events.length, index + 1);
      const event = events.at(-1);
      assert.equal(event?.sequence, index + 1);
      assert.equal(event?.store_generation, STORE_GENERATION);
      assert.equal(event?.target_id, 'op-1');
      assert.equal(event?.event_type, 'operation.updated');
      assert.equal(event?.state_revision, Number(step.revision));
      assert.equal(event?.delete_at, (event?.occurred_at ?? 0) + RECEIPT_TTL);
      const receipts = receiptRows(db);
      assert.equal(receipts.length, index + 1);
      const receipt = receipts.at(-1);
      assert.equal(receipt?.command_id, step.command.command_id);
      assert.equal(receipt?.command_scope_id, INTERNAL_COMMAND_SCOPE);
      assert.equal(receipt?.request_id, step.command.command_id);
      assert.equal(receipt?.target_id, 'op-1');
      assert.equal(receipt?.status, 'durable');
      assert.equal(receipt?.committed_state_revision, Number(step.revision));
      assert.equal(
        receipt?.delete_at,
        (receipt?.created_at ?? 0) + RECEIPT_TTL,
      );
    }
    const record = readOperation(db, 'op-1');
    assert.equal(record?.content_hash, CONTENT_HASH);
    assert.equal(record?.attempts.length, 1);
    assert.equal(record?.attempts[0]?.status, 'succeeded');
    assert.equal(record?.attempts[0]?.result_status, 'confirmed_success');
    assert.equal(record?.attempts[0]?.external_id, 'mail-001');
    assert.notEqual(record?.attempts[0]?.dispatch_intent_at, null);
    // 成功した送出で承認を使い終える（consumed も有効な承認として数える）。
    assert.deepEqual(
      record?.approvals.map((approval) => approval.status),
      ['consumed'],
    );
    assert.equal(effectiveApprovals(db, 'op-1'), 1);
    assert.notEqual(record?.completed_at, null);
  });
});

test('a second approval of the same content returns the existing state and adds no approval (X02)', async () => {
  await withStore((db) => {
    committed(run(db, createCommand('op-1')));
    assert.equal(committed(run(db, approveCommand('op-1', '1'))), '2');
    // 別の端末から、承認前の版を見て同じ内容を承認する。
    const second = run(db, approveCommand('op-1', '1', { device_id: 'dev-2' }));
    assert.equal(second.outcome, 'durable');
    assert.equal(second.outcome === 'durable' && second.existing, true);
    assert.equal(committed(second), '2');
    assert.equal(effectiveApprovals(db, 'op-1'), 1);
    assert.equal(eventRows(db).length, 2);
    // 内容が違う承認は流用せず拒否する。
    assert.deepEqual(
      reasons(
        run(
          db,
          approveCommand('op-1', '2', { content_hash: OTHER_CONTENT_HASH }),
        ),
      ),
      ['content_hash_mismatch', 'not_awaiting_approval'],
    );
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'approved',
      state_revision: 2,
    });
  });
});

test('the same request_id with different content is a conflict, the same content replays (X04)', async () => {
  await withStore((db) => {
    committed(run(db, createCommand('op-1')));
    const request = {
      command_scope_id: 'scope-1',
      request_id: 'req-1',
      request_hash: 'c'.repeat(64),
    };
    const first = approveCommand('op-1', '1', { request });
    assert.equal(committed(run(db, first)), '2');
    const conflict = run(
      db,
      approveCommand('op-1', '1', {
        request: { ...request, request_hash: 'd'.repeat(64) },
      }),
    );
    assert.deepEqual(reasons(conflict), ['request_conflict']);
    // 同じ要求の再送（Core が別の command_id を付けた）は保存済みの受付結果を返す。
    const replay = run(db, approveCommand('op-1', '1', { request }));
    assert.equal(replay.outcome, 'durable');
    assert.equal(replay.outcome === 'durable' && replay.replayed, true);
    assert.equal(replay.command_id, first.command_id);
    assert.equal(committed(replay), '2');
    // 別の接続範囲の同じ request_id は別の要求。
    const otherScope = run(
      db,
      prepareCommand('op-1', '2', {
        request: { ...request, command_scope_id: 'scope-2' },
      }),
    );
    assert.equal(committed(otherScope), '3');
    const receipts = receiptRows(db);
    assert.deepEqual(
      receipts.map((row) => [row.command_scope_id, row.request_id]),
      [
        [INTERNAL_COMMAND_SCOPE, receipts[0]?.command_id],
        ['scope-1', 'req-1'],
        ['scope-2', 'req-1'],
      ],
    );
  });
});

test('the same command_id returns the stored result and never applies twice', async () => {
  await withStore((db) => {
    const create = createCommand('op-1');
    assert.equal(committed(run(db, create)), '1');
    const approve = approveCommand('op-1', '1');
    assert.equal(committed(run(db, approve)), '2');
    const again = run(db, approve);
    assert.equal(again.outcome === 'durable' && again.replayed, true);
    assert.equal(committed(again), '2');
    const prepare = prepareCommand('op-1', '2');
    assert.equal(committed(run(db, prepare)), '3');
    const dispatch = dispatchCommand('op-1', '3', prepare.attempt_id);
    const first = run(db, dispatch);
    assert.equal(
      first.outcome === 'durable' && first.dispatched?.attempt_id,
      prepare.attempt_id,
    );
    // 送出意図の再到着は保存済みの版を返すだけで、送出の材料（dispatched）を返さない。
    const replay = run(db, dispatch);
    assert.equal(replay.outcome === 'durable' && replay.replayed, true);
    assert.equal(replay.outcome === 'durable' ? replay.dispatched : 'x', null);
    assert.equal(committed(replay), '4');
    assert.equal(eventRows(db).length, 4);
    assert.equal(receiptRows(db).length, 4);
    // 同じ command_id で内容が違う命令は拒否する。
    assert.deepEqual(
      reasons(run(db, { ...approve, expected_state_revision: '9' })),
      ['command_id_reused'],
    );
  });
});

test('stale revisions and changed versions are rejected without writing anything', async () => {
  await withStore((db) => {
    const attemptId = toPreparing(db, 'op-1');
    const before = {
      events: eventRows(db).length,
      receipts: receiptRows(db).length,
    };
    const cases: {
      command: DbCommand;
      setup?: string;
      undo?: string;
      expected: string[];
    }[] = [
      {
        command: dispatchCommand('op-1', '2', attemptId),
        expected: ['state_revision_changed'],
      },
      {
        command: dispatchCommand('op-1', '3', attemptId, {
          permission_revision: '2',
        }),
        expected: ['permission_changed'],
      },
      {
        command: dispatchCommand('op-1', '3', attemptId, {
          forgetting_generation: '1',
        }),
        expected: ['forgetting_generation_changed'],
      },
      {
        command: dispatchCommand('op-1', '3', attemptId, {
          request_revision: '1',
        }),
        expected: ['request_revision_changed'],
      },
      {
        command: dispatchCommand('op-1', '3', attemptId),
        setup:
          "INSERT INTO safety_breaker VALUES (1, 'stopped', 1, 'rate_exceeded', 1000, NULL)",
        undo: 'DELETE FROM safety_breaker',
        expected: ['safety_stopped'],
      },
      {
        command: dispatchCommand('op-1', '3', attemptId, {
          reservation_id: 'res-1',
        }),
        setup:
          "INSERT INTO budget_reservations (reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, created_at) VALUES ('res-1', 'breq-1', 'intent.luna.v1', 'pool-1', 'pool-1', 'owner_request', '2030-10', 'XTS', 'p1', 0, 0, 'released', 1, 1000)",
        expected: ['reservation_invalid'],
      },
      {
        command: dispatchCommand('op-1', '3', attemptId),
        setup:
          "UPDATE connections SET access = 'read' WHERE connection_id = 'c-1'",
        undo: "UPDATE connections SET access = 'read_write' WHERE connection_id = 'c-1'",
        expected: ['connection_not_writable'],
      },
      {
        command: dispatchCommand('op-1', '3', attemptId, {
          connection_id: null,
        }),
        expected: ['connection_required'],
      },
      {
        command: dispatchCommand('op-1', '3', 'other-attempt'),
        expected: ['attempt_not_preparing'],
      },
      {
        command: resultCommand('op-1', '3', attemptId, 'succeeded'),
        expected: ['transition_not_allowed'],
      },
      {
        command: approveCommand('op-1', '3', { content_version: '2' }),
        expected: ['content_version_changed', 'not_awaiting_approval'],
      },
    ];
    for (const entry of cases) {
      if (entry.setup) db.exec(entry.setup);
      assert.deepEqual(
        reasons(run(db, entry.command)),
        entry.expected,
        entry.expected.join(),
      );
      if (entry.undo) db.exec(entry.undo);
      assert.deepEqual(operationState(db, 'op-1'), {
        state: 'preparing',
        state_revision: 3,
      });
    }
    // 忘却台帳が進んだ後は、古い世代を付けた命令を拒否する。
    db.exec("INSERT INTO forget_ledger VALUES (1, 'fl-1', 1000)");
    assert.deepEqual(
      reasons(run(db, dispatchCommand('op-1', '3', attemptId))),
      ['forgetting_generation_changed'],
    );
    assert.equal(eventRows(db).length, before.events);
    assert.equal(receiptRows(db).length, before.receipts);
    // 現在の版をそろえれば通る。
    const ok = run(
      db,
      dispatchCommand('op-1', '3', attemptId, { forgetting_generation: '1' }),
    );
    assert.equal(committed(ok), '4');
  });
});

test('the request revision is checked against the workflow', async () => {
  await withStore((db) => {
    db.exec(
      "INSERT INTO sessions VALUES ('s-1', 'normal', 'dev-1', 1, NULL, 1000, NULL)",
    );
    db.exec("INSERT INTO workflows VALUES ('wf-1', 's-1', 2, 'ready', 1000)");
    assert.deepEqual(
      reasons(
        run(
          db,
          createCommand('op-1', { workflow_id: 'wf-1', request_revision: '1' }),
        ),
      ),
      ['request_revision_changed'],
    );
    assert.equal(operationState(db, 'op-1'), undefined);
    assert.equal(
      committed(
        run(
          db,
          createCommand('op-1', { workflow_id: 'wf-1', request_revision: '2' }),
        ),
      ),
      '1',
    );
    db.exec(
      "UPDATE workflows SET current_request_revision = 3 WHERE workflow_id = 'wf-1'",
    );
    assert.deepEqual(
      reasons(run(db, approveCommand('op-1', '1', { request_revision: '2' }))),
      ['request_revision_changed'],
    );
  });
});

test('cancel before dispatch is final, cancel after dispatch is only accepted (X05)', async () => {
  await withStore((db) => {
    const attemptId = toPreparing(db, 'op-1');
    assert.equal(committed(run(db, cancelCommand('op-1', '3'))), '4');
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'cancelled',
      state_revision: 4,
    });
    assert.equal(readOperation(db, 'op-1')?.attempts[0]?.status, 'cancelled');
    // 取消の後は送出意図を記録できない。
    assert.deepEqual(
      reasons(run(db, dispatchCommand('op-1', '4', attemptId))),
      ['transition_not_allowed'],
    );
    assert.deepEqual(reasons(run(db, cancelCommand('op-1', '4'))), [
      'operation_finished',
    ]);

    const attempt2 = toPreparing(db, 'op-2');
    committed(run(db, dispatchCommand('op-2', '3', attempt2)));
    const events = eventRows(db).length;
    const cancel = cancelCommand('op-2', '4');
    const accepted = run(db, cancel);
    assert.equal(accepted.outcome, 'accepted');
    assert.equal(
      accepted.outcome === 'accepted' && accepted.reason,
      'dispatch_boundary_crossed',
    );
    assert.deepEqual(operationState(db, 'op-2'), {
      state: 'dispatching',
      state_revision: 4,
    });
    assert.equal(eventRows(db).length, events);
    const receipt = receiptRows(db).find(
      (row) => row.command_id === cancel.command_id,
    );
    assert.equal(receipt?.status, 'accepted');
    assert.equal(receipt?.committed_state_revision, null);
    const replay = run(db, cancel);
    assert.equal(replay.outcome === 'accepted' && replay.replayed, true);
  });
});

test('a not_executed result lets the same approval back into a new attempt', async () => {
  await withStore((db) => {
    const attemptId = toPreparing(db, 'op-1');
    committed(run(db, dispatchCommand('op-1', '3', attemptId)));
    committed(run(db, resultCommand('op-1', '4', attemptId, 'unknown_held')));
    committed(run(db, resultCommand('op-1', '5', attemptId, 'reconciling')));
    assert.equal(
      committed(run(db, resultCommand('op-1', '6', attemptId, 'not_executed'))),
      '7',
    );
    const retry = prepareCommand('op-1', '7');
    assert.equal(committed(run(db, retry)), '8');
    const record = readOperation(db, 'op-1');
    assert.deepEqual(
      record?.attempts.map((attempt) => [
        attempt.status,
        attempt.result_status,
      ]),
      [
        ['not_executed', 'confirmed_not_executed'],
        ['preparing', null],
      ],
    );
    assert.equal(
      record?.attempts[0]?.approval_id,
      record?.attempts[1]?.approval_id,
    );
    assert.equal(effectiveApprovals(db, 'op-1'), 1);
  });
});

test('auto execution starts at approved with a policy approval in the same transaction (X21)', async () => {
  await withStore((db) => {
    assert.equal(
      committed(run(db, createCommand('op-1', { auto: true }))),
      '1',
    );
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'approved',
      state_revision: 1,
    });
    assert.equal(readOperation(db, 'op-1')?.approvals[0]?.route, 'policy_auto');
    const stale = createCommand('op-2', { auto: true });
    const outcome = run(db, {
      ...stale,
      auto_approval: stale.auto_approval && {
        ...stale.auto_approval,
        current_policy_version: '4',
      },
    });
    assert.deepEqual(reasons(outcome), ['policy_version_changed']);
    assert.equal(operationState(db, 'op-2'), undefined);
  });
});

test('a constraint violation rolls the whole transaction back and keeps the worker writable', async () => {
  await withStore((db) => {
    const intent = sealedIntent();
    committed(run(db, createCommand('op-1', { intent })));
    // 同じ鍵で nonce を再利用しない（sealed_blobs の一意制約）。operations の行は先に書いている。
    const result = executeCommand(
      db,
      createCommand('op-2', {
        intent: {
          ...sealedIntent(),
          key_id: intent.key_id,
          nonce: intent.nonce,
        },
      }),
      storeContext(),
    );
    assert.deepEqual(reasons(result.outcome), ['constraint_violation']);
    assert.equal(result.halt, false);
    assert.equal(operationState(db, 'op-2'), undefined);
    assert.equal(eventRows(db).length, 1);
    assert.equal(receiptRows(db).length, 1);
    assert.equal(db.inTransaction, false);
  });
});

test('an injected failure before COMMIT rolls back and halts writes', async () => {
  await withStore((db) => {
    const attemptId = toPreparing(db, 'op-1');
    const result = executeCommand(db, dispatchCommand('op-1', '3', attemptId), {
      ...storeContext(),
      beforeCommit: () => {
        throw new Error('注入した失敗');
      },
    });
    assert.deepEqual(reasons(result.outcome), ['transaction_failed']);
    assert.equal(result.halt, true);
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'preparing',
      state_revision: 3,
    });
    assert.equal(readOperation(db, 'op-1')?.attempts[0]?.status, 'preparing');
    assert.equal(eventRows(db).length, 3);
  });
});

test('a failed COMMIT is reported as unknown, not as rejected', async () => {
  await withStore((db) => {
    const attemptId = toPreparing(db, 'op-1');
    const result = executeCommand(db, dispatchCommand('op-1', '3', attemptId), {
      ...storeContext(),
      beforeCommit: () => {
        db.pragma('defer_foreign_keys = ON');
        db.prepare(
          "INSERT INTO operation_steps (attempt_id, step_id, step_kind) VALUES ('missing', 'fault', 'fault')",
        ).run();
      },
    });
    assert.equal(result.outcome.outcome, 'unknown');
    assert.equal(
      result.outcome.outcome === 'unknown' && result.outcome.reason,
      'commit_failed',
    );
    assert.equal(result.halt, true);
    assert.equal(db.inTransaction, false);
    // この失敗では巻き戻っている（照会で確かめる。結果の値だけで未 commit と決めない）。
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'preparing',
      state_revision: 3,
    });
  });
});

test('a weakened durability setting rejects every command and halts writes', async () => {
  await withStore((db) => {
    const attemptId = toPreparing(db, 'op-1');
    db.pragma('synchronous = NORMAL');
    const result = executeCommand(
      db,
      dispatchCommand('op-1', '3', attemptId),
      storeContext(),
    );
    assert.deepEqual(reasons(result.outcome), [
      'durability_mismatch',
      'synchronous_not_full',
    ]);
    assert.equal(result.halt, true);
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'preparing',
      state_revision: 3,
    });
    db.pragma('fullfsync = OFF');
    db.pragma('synchronous = FULL');
    assert.deepEqual(
      reasons(
        executeCommand(db, cancelCommand('op-1', '3'), storeContext()).outcome,
      ),
      ['durability_mismatch', 'fullfsync_off'],
    );
  });
});

test('malformed commands are rejected before the transaction', async () => {
  await withStore((db) => {
    const create = createCommand('op-1');
    assert.deepEqual(reasons(run(db, { ...create, content_hash: 'ABC' })), [
      'content_hash_invalid',
    ]);
    assert.deepEqual(
      reasons(run(db, { ...create, expected_state_revision: '1' })),
      ['expected_state_revision_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          ...create,
          intent: { ...create.intent, nonce: new Uint8Array(8) },
        }),
      ),
      ['intent_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          ...create,
          request: {
            command_scope_id: INTERNAL_COMMAND_SCOPE,
            request_id: 'r',
            request_hash: 'c'.repeat(64),
          },
        }),
      ),
      ['request_invalid'],
    );
    const approve = approveCommand('op-1', '1');
    assert.deepEqual(reasons(run(db, { ...approve, preview_id: null })), [
      'screen_approval_incomplete',
    ]);
    assert.deepEqual(
      reasons(run(db, { ...approve, permission_revision: '01' })),
      ['permission_revision_invalid'],
    );
    assert.equal(receiptRows(db).length, 0);
  });
});

test('a local command needs no connection to record its dispatch intent', async () => {
  await withStore((db) => {
    committed(
      run(
        db,
        createCommand('op-1', {
          effect_route: 'local_command',
          connection_id: null,
        }),
      ),
    );
    committed(run(db, approveCommand('op-1', '1', { connection_id: null })));
    const prepare = prepareCommand('op-1', '2', { connection_id: null });
    committed(run(db, prepare));
    const outcome = run(
      db,
      dispatchCommand('op-1', '3', prepare.attempt_id, { connection_id: null }),
    );
    assert.equal(committed(outcome), '4');
  });
});

test('a transaction body must be synchronous', async () => {
  await withStore((db) => {
    assert.throws(
      () =>
        runImmediate(db, () => {
          db.exec("INSERT INTO forget_ledger VALUES (1, 'fl-1', 1000)");
          return Promise.resolve();
        }),
      /Promise/u,
    );
    assert.equal(db.inTransaction, false);
    assert.equal(
      (
        db.prepare('SELECT count(*) AS n FROM forget_ledger').get() as {
          n: number;
        }
      ).n,
      0,
    );
  });
});

test('bulk writes are split into transactions of at most 50 items or 20 ms', async () => {
  assert.deepEqual(BULK_WRITE_LIMITS, { maxItems: 50, maxMilliseconds: 20 });
  await withStore((db) => {
    db.exec('CREATE TEMP TABLE bulk (n INTEGER NOT NULL)');
    const items = Array.from({ length: 120 }, (_, index) => index);
    const write = (n: number): void => {
      db.prepare('INSERT INTO bulk (n) VALUES (?)').run(n);
    };
    const ends: number[] = [];
    // 20ms に達しない時計を渡し、実時間に依存せず件数の上限だけで区切る。
    const frozenClock = (): number => 0;
    for (let index = 0; index < items.length;) {
      index = writeBulkSlice(db, items, index, write, { clock: frozenClock });
      ends.push(index);
    }
    assert.deepEqual(ends, [50, 100, 120]);
    // 1 件ごとに 7ms 進む時計では、20ms に達した 3 件目で区切る。
    let fake = 0;
    const slow: number[] = [];
    for (let index = 0; index < 10;) {
      index = writeBulkSlice(db, items.slice(0, 10), index, write, {
        clock: () => {
          const value = fake;
          fake += 7;
          return value;
        },
      });
      slow.push(index);
    }
    assert.deepEqual(slow, [3, 6, 9, 10]);
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM bulk').get() as { n: number }).n,
      130,
    );
  });
});

test('the bulk write with the default clock splits every item when the time limit is zero', async () => {
  await withStore((db) => {
    db.exec('CREATE TEMP TABLE bulk (n INTEGER NOT NULL)');
    const items = [1, 2, 3];
    const write = (n: number): void => {
      db.prepare('INSERT INTO bulk (n) VALUES (?)').run(n);
    };
    // 時計を渡さず、実時間（performance.now）を使う。上限 0ms では 1 件書いた時点で
    // 経過が必ず 0 以上になるため、実測の値に関係なく 1 件ずつ区切られる。
    const ends: number[] = [];
    for (let index = 0; index < items.length;) {
      index = writeBulkSlice(db, items, index, write, { maxMilliseconds: 0 });
      ends.push(index);
    }
    assert.deepEqual(ends, [1, 2, 3]);
    assert.deepEqual(db.prepare('SELECT n FROM bulk ORDER BY n').all(), [
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
  });
});

test('recovery after a restart moves only dispatching attempts to unknown_held and records it (08 §4)', async () => {
  await withStore((db) => {
    // op-p: preparing のまま。op-d: 送出意図の記録の後（dispatching）。op-a: 承認済み。
    const preparingAttempt = toPreparing(db, 'op-p');
    const dispatchingAttempt = toPreparing(db, 'op-d');
    committed(run(db, dispatchCommand('op-d', '3', dispatchingAttempt)));
    committed(run(db, createCommand('op-a')));
    committed(run(db, approveCommand('op-a', '1')));
    assert.deepEqual(listInterruptedOperations(db), [
      {
        operation_id: 'op-p',
        state: 'preparing',
        state_revision: '3',
        current_content_version: '1',
        attempt_id: preparingAttempt,
      },
      {
        operation_id: 'op-d',
        state: 'dispatching',
        state_revision: '4',
        current_content_version: '1',
        attempt_id: dispatchingAttempt,
      },
      // 承認済みで実行の前の操作も、起動時の再開の対象（ADR 0030）。試行はまだない。
      {
        operation_id: 'op-a',
        state: 'approved',
        state_revision: '2',
        current_content_version: '1',
        attempt_id: null,
      },
    ]);
    const eventsBefore = eventRows(db).length;
    const receiptsBefore = receiptRows(db).length;
    // preparing・承認済みの操作・試行の違い・版の違いは回復しない（何も書かない）。
    assert.deepEqual(
      reasons(run(db, recoverCommand('op-p', '3', preparingAttempt))),
      ['operation_not_dispatching'],
    );
    assert.deepEqual(
      reasons(run(db, recoverCommand('op-a', '2', preparingAttempt))),
      ['operation_not_dispatching'],
    );
    assert.deepEqual(
      reasons(run(db, recoverCommand('op-d', '4', preparingAttempt))),
      ['attempt_not_dispatched'],
    );
    assert.deepEqual(
      reasons(run(db, recoverCommand('op-d', '3', dispatchingAttempt))),
      ['state_revision_changed'],
    );
    assert.equal(eventRows(db).length, eventsBefore);
    assert.equal(receiptRows(db).length, receiptsBefore);
    // 許可・忘却の版が変わっていても、送出済みかもしれない試行の保留は拒否しない。
    const recover = recoverCommand('op-d', '4', dispatchingAttempt, {
      permission_revision: '9',
      forgetting_generation: '9',
    });
    assert.equal(committed(run(db, recover)), '5');
    assert.deepEqual(operationState(db, 'op-d'), {
      state: 'unknown_held',
      state_revision: 5,
    });
    const record = readOperation(db, 'op-d');
    assert.equal(record?.attempts.length, 1);
    assert.equal(record?.attempts[0]?.status, 'unknown_held');
    assert.equal(record?.attempts[0]?.result_status, 'unknown');
    assert.notEqual(record?.attempts[0]?.dispatch_intent_at, null);
    // 承認は使い終えない（送ったか分からない）。有効な承認は 1 件のまま。
    assert.equal(record?.approvals[0]?.status, 'valid');
    assert.equal(effectiveApprovals(db, 'op-d'), 1);
    // 回復はイベントと内部の受付を同じ transaction で書く。
    const event = eventRows(db).at(-1);
    assert.equal(event?.target_id, 'op-d');
    assert.equal(event?.state_revision, 5);
    const receipt = receiptRows(db).at(-1);
    assert.equal(receipt?.command_scope_id, INTERNAL_COMMAND_SCOPE);
    assert.equal(receipt?.command_id, recover.command_id);
    assert.equal(receipt?.status, 'durable');
    assert.equal(receipt?.committed_state_revision, 5);
    // 同じ命令の再到着は保存済みの結果を返し、二度適用しない。
    const replay = run(db, recover);
    assert.equal(committed(replay), '5');
    assert.equal(replay.outcome === 'durable' && replay.replayed, true);
    assert.deepEqual(
      listInterruptedOperations(db).map((entry) => entry.operation_id),
      ['op-p', 'op-a'],
    );
    // unknown_held からは自動で送出意図に戻れない（照合・本人の判断は B04 以降）。
    assert.deepEqual(
      reasons(run(db, dispatchCommand('op-d', '5', dispatchingAttempt))),
      ['transition_not_allowed'],
    );
  });
});

// --- B04-04（ADR 0030）: LocalCommand の適用と、送出の直前の接続の照合 ---

const applyLocalCommand = (
  operationId: string,
  expected: string,
  options: { readonly command_id?: string; readonly list_id?: string } = {},
): DbCommand => ({
  command_id: options.command_id ?? randomUUID(),
  kind: 'operation.apply_local',
  operation_id: operationId,
  expected_state_revision: expected,
  request_revision: null,
  permission_revision: '0',
  forgetting_generation: '0',
  connection_id: null,
  request: null,
  attempt_id: randomUUID(),
  task_id: randomUUID(),
  list_id: options.list_id ?? 'inbox',
  // 用事の正本の暗号文（ADR 0051。中身は合成の乱数で、ここでは復号しない）。
  content: sealedIntent(),
});

const count = (db: SqliteDatabase, sql: string): number =>
  db.prepare(sql).pluck().get() as number;

test('D5: apply_local writes the task, attempt, approval use, final state, event and receipt once (QA28)', async () => {
  await withStore((db) => {
    const local = {
      effect_route: 'local_command',
      connection_id: null,
    } as const;
    committed(run(db, createCommand('op-l', local)));
    committed(run(db, approveCommand('op-l', '1', { connection_id: null })));
    const eventsBefore = eventRows(db).length;
    const receiptsBefore = receiptRows(db).length;
    const command = applyLocalCommand('op-l', '2');
    // 承認待ち（1）→ 承認済み（2）→ 成功（3）。
    assert.equal(committed(run(db, command)), '3');
    assert.deepEqual(operationState(db, 'op-l'), {
      state: 'succeeded',
      state_revision: 3,
    });
    assert.equal(
      count(db, "SELECT count(*) FROM tasks WHERE operation_id = 'op-l'"),
      1,
    );
    // 用事は自分の暗号文（用途 task_content、持ち主は用事・版 0）を持つ（ADR 0051）。
    assert.deepEqual(
      db
        .prepare(
          "SELECT b.blob_id = ? AS same, b.purpose, b.owner_table, b.owner_id = t.task_id AS owner, b.owner_version FROM tasks t JOIN sealed_blobs b ON b.blob_id = t.content_blob_id WHERE t.operation_id = 'op-l'",
        )
        .all(
          (command as Extract<DbCommand, { kind: 'operation.apply_local' }>)
            .content.blob_id,
        ),
      [
        {
          same: 1,
          purpose: 'task_content',
          owner_table: 'tasks',
          owner: 1,
          owner_version: 0,
        },
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT status, result_status, dispatch_intent_at IS NOT NULL AS intent, external_id = (SELECT task_id FROM tasks WHERE operation_id = 'op-l') AS task FROM operation_attempts WHERE operation_id = 'op-l'",
        )
        .all(),
      [
        {
          status: 'succeeded',
          result_status: 'confirmed_success',
          intent: 1,
          task: 1,
        },
      ],
    );
    assert.equal(
      db
        .prepare("SELECT status FROM approvals WHERE operation_id = 'op-l'")
        .pluck()
        .get(),
      'consumed',
    );
    assert.equal(eventRows(db).length, eventsBefore + 1);
    assert.equal(receiptRows(db).length, receiptsBefore + 1);
    // 同じ命令の再到着: 保存済みの結果を返し、DB は変えない。
    const replay = run(db, command);
    assert.equal(committed(replay), '3');
    assert.equal(replay.outcome === 'durable' && replay.replayed, true);
    // 同じ command_id で内容（照合値）が違えば拒否する。
    assert.deepEqual(
      reasons(run(db, { ...command, list_id: 'other' } as DbCommand)),
      ['command_id_reused'],
    );
    // 別の命令での二度目の適用は、状態で拒否する。
    assert.deepEqual(reasons(run(db, applyLocalCommand('op-l', '3'))), [
      'transition_not_allowed',
    ]);
    assert.equal(
      count(db, "SELECT count(*) FROM tasks WHERE operation_id = 'op-l'"),
      1,
    );
    assert.equal(eventRows(db).length, eventsBefore + 1);
    // 外部変更（remote_mutation）と、承認のない LocalCommand には使えない。
    committed(run(db, createCommand('op-r')));
    committed(run(db, approveCommand('op-r', '1')));
    assert.deepEqual(reasons(run(db, applyLocalCommand('op-r', '2'))), [
      'route_mismatch',
    ]);
    committed(run(db, createCommand('op-w', local)));
    assert.deepEqual(reasons(run(db, applyLocalCommand('op-w', '1'))), [
      'transition_not_allowed',
    ]);
    assert.equal(count(db, 'SELECT count(*) FROM tasks'), 1);
  });
});

test('dispatch intent without a DB connection row needs the re-read connection and the same permission revision', async () => {
  await withStore((db) => {
    const none = { connection_id: null } as const;
    committed(run(db, createCommand('op-o', none)));
    committed(run(db, approveCommand('op-o', '1', none)));
    const attempt = randomUUID();
    committed(
      run(db, prepareCommand('op-o', '2', { ...none, attempt_id: attempt })),
    );
    const dispatch = (observed: unknown): DbCommand =>
      ({
        ...dispatchCommand('op-o', '3', attempt, none),
        observed_connection: observed,
      }) as DbCommand;
    assert.deepEqual(reasons(run(db, dispatch(null))), ['connection_required']);
    assert.deepEqual(
      reasons(
        run(
          db,
          dispatch({
            status: 'active',
            access: 'read',
            permission_revision: '1',
          }),
        ),
      ),
      ['connection_not_writable'],
    );
    assert.deepEqual(
      reasons(
        run(
          db,
          dispatch({
            status: 'active',
            access: 'read_write',
            permission_revision: '2',
          }),
        ),
      ),
      ['permission_changed'],
    );
    assert.deepEqual(
      reasons(
        run(
          db,
          dispatch({
            status: 'active',
            access: 'write',
            permission_revision: '1',
          }),
        ),
      ),
      ['observed_connection_invalid'],
    );
    const ok = run(
      db,
      dispatch({
        status: 'active',
        access: 'read_write',
        permission_revision: '1',
      }),
    );
    assert.equal(committed(ok), '4');
    assert.equal(
      ok.outcome === 'durable' && ok.dispatched?.attempt_id,
      attempt,
    );
  });
});

test('a retry prepare starts only from not_executed (review P2)', async () => {
  await withStore((db) => {
    const retry = (id: string, expected: string): DbCommand =>
      ({ ...prepareCommand(id, expected), retry: true }) as DbCommand;
    // 承認待ち・承認済み・準備中・結果不明からは始めない（初回の実行や照合を横取りしない）。
    committed(run(db, createCommand('op-ra')));
    assert.deepEqual(reasons(run(db, retry('op-ra', '1'))), [
      'retry_not_allowed',
    ]);
    committed(run(db, createCommand('op-rb')));
    committed(run(db, approveCommand('op-rb', '1')));
    assert.deepEqual(reasons(run(db, retry('op-rb', '2'))), [
      'retry_not_allowed',
    ]);
    assert.deepEqual(operationState(db, 'op-rb'), {
      state: 'approved',
      state_revision: 2,
    });
    toPreparing(db, 'op-rc');
    assert.deepEqual(reasons(run(db, retry('op-rc', '3'))), [
      'retry_not_allowed',
    ]);
    const held = toPreparing(db, 'op-rd');
    committed(run(db, dispatchCommand('op-rd', '3', held)));
    committed(run(db, resultCommand('op-rd', '4', held, 'unknown_held')));
    assert.deepEqual(reasons(run(db, retry('op-rd', '5'))), [
      'retry_not_allowed',
    ]);
    // 未実行が確定した操作だけ、新しい試行で準備へ戻せる。
    const failed = toPreparing(db, 'op-re');
    committed(run(db, dispatchCommand('op-re', '3', failed)));
    committed(run(db, resultCommand('op-re', '4', failed, 'reconciling')));
    committed(run(db, resultCommand('op-re', '5', failed, 'not_executed')));
    assert.equal(committed(run(db, retry('op-re', '6'))), '7');
    assert.deepEqual(operationState(db, 'op-re'), {
      state: 'preparing',
      state_revision: 7,
    });
  });
});
