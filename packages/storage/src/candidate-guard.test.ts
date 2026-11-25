// 候補を起点にした方針による自動承認の最終ガード（ADR 0148）を、worker を介さずに同期で確かめる。
// 期待値は設計 11 §5A（同じ依頼・操作・アカウント・カレンダーにつき一度だけ、取消済み・抑止中は作らない）・
// §5B（関連解析の版が現在で ready のときだけ）・08 §9 と、ADR 0103 の理由の名前から手で書いた値。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { executeCommand } from './index.js';
import type {
  CreateOperationCommand,
  DbCommand,
  SqliteDatabase,
  StoreOutcome,
} from './index.js';
import {
  createCommand,
  databasePath,
  dispatchCommand,
  openSeededDatabase,
  operationState,
  prepareCommand,
  sealedIntent,
  storeContext,
  withTempDir,
} from './operation-test-support.js';

const T0 = 1_800_000_000_000;
const REQ = '11111111-1111-4111-8111-111111111111';
const REQ_2 = '22222222-2222-4222-8222-222222222222';
const CAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAND_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAND_OVERLAP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GROUP = 'group-1';
const HASH = 'd'.repeat(64);
const OTHER_HASH = 'e'.repeat(64);

async function withStore(run: (db: SqliteDatabase) => void): Promise<void> {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seed(db);
      run(db);
    } finally {
      db.close();
    }
  });
}

// 依頼（版 3、有効）・関連解析（版 2、ready、世代 5）・その版で作った候補 2 つと、依頼を持たない予定の重複の候補。
function seed(db: SqliteDatabase): void {
  const entity = db.prepare(
    "INSERT INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, 'acct-1', 'thread-1', 'msg-1', 3, 'active', 0, NULL, ?, NULL)",
  );
  entity.run(REQ, T0);
  entity.run(REQ_2, T0);
  analysis(db, 2, HASH, 5, 'ready');
  const candidate = db.prepare(
    "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, kind, notification_key, state, created_at, received_at, state_changed_at, related_group_id, related_analysis_revision, related_source_set_hash, related_published_generation) VALUES (?, ?, 3, 'mail_deadline', ?, 'new', ?, ?, ?, ?, 2, ?, 5)",
  );
  candidate.run(CAND, REQ, 'key-1', T0, T0, T0, GROUP, HASH);
  candidate.run(CAND_2, REQ, 'key-2', T0, T0, T0, GROUP, HASH);
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, kind, notification_key, state, created_at, received_at, state_changed_at) VALUES (?, 'schedule_overlap', 'key-3', 'new', ?, ?, ?)",
  ).run(CAND_OVERLAP, T0, T0, T0);
}

function analysis(
  db: SqliteDatabase,
  revision: number,
  hash: string,
  generation: number,
  status: 'ready' | 'pending' | 'blocked',
): void {
  db.prepare(
    'INSERT INTO related_analyses (group_id, analysis_revision, source_set_hash, published_generation, plan_complete, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(GROUP, revision, hash, generation, status === 'ready' ? 1 : 0, status);
}

function exec(db: SqliteDatabase, command: DbCommand): StoreOutcome {
  const result = executeCommand(db, command, storeContext(T0));
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

const LOCAL = { effect_route: 'local_command', connection_id: null } as const;

// 候補を起点にした方針による自動承認の作成。既定は用事の登録（LocalCommand）とアカウント acct-1。
function autoCreate(
  operationId: string,
  options: {
    readonly candidate_id?: string;
    readonly account_id?: string;
    readonly calendar_id?: string | null;
    readonly remote?: boolean;
    readonly auto?: boolean;
  } = {},
): CreateOperationCommand {
  const remote = options.remote === true;
  return {
    ...createCommand(operationId, {
      auto: options.auto ?? true,
      ...(remote
        ? { operation_kind: 'mail.labels.change' }
        : { ...LOCAL, operation_kind: 'task.create' }),
    }),
    candidate_origin: {
      candidate_id: options.candidate_id ?? CAND,
      account_id: options.account_id ?? 'acct-1',
      calendar_id: options.calendar_id ?? null,
    },
  };
}

const applyLocal = (operationId: string, expected: string): DbCommand => ({
  command_id: randomUUID(),
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
  list_id: 'inbox',
  content: sealedIntent(),
});

function guardColumns(db: SqliteDatabase, operationId: string): unknown {
  return db
    .prepare(
      'SELECT route, candidate_id, request_entity_id, request_revision, related_group_id, analysis_revision, source_set_hash, published_generation FROM approvals WHERE operation_id = ?',
    )
    .get(operationId);
}

function links(db: SqliteDatabase): unknown[] {
  return db
    .prepare(
      'SELECT request_entity_id, operation_kind, account_id, calendar_id, operation_id FROM request_entity_operations ORDER BY operation_id',
    )
    .all();
}

const windowTotal = (db: SqliteDatabase): unknown =>
  db
    .prepare(
      "SELECT coalesce(sum(count), 0) FROM safety_window_counts WHERE scope_key = 'policy_auto'",
    )
    .pluck()
    .get();

test('a candidate-origin automatic approval copies the judged versions and records the one-time key in the same transaction', async () => {
  await withStore((db) => {
    assert.equal(committed(exec(db, autoCreate('op-1'))), '1');
    assert.deepEqual(guardColumns(db, 'op-1'), {
      route: 'policy_auto',
      candidate_id: CAND,
      request_entity_id: REQ,
      request_revision: 3,
      related_group_id: GROUP,
      analysis_revision: 2,
      source_set_hash: HASH,
      published_generation: 5,
    });
    assert.deepEqual(links(db), [
      {
        request_entity_id: REQ,
        operation_kind: 'create_task',
        account_id: 'acct-1',
        calendar_id: '',
        operation_id: 'op-1',
      },
    ]);
    assert.equal(windowTotal(db), 1);
    // 版がすべて現在のままなら、適用の直前の照合も通る。
    assert.equal(committed(exec(db, applyLocal('op-1', '1'))), '2');
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'succeeded',
      state_revision: 2,
    });
  });
});

test('the same request, operation and account is created once; another account or a refused judgement is not counted', async () => {
  await withStore((db) => {
    committed(exec(db, autoCreate('op-1')));
    // 別の候補でも、同じ依頼・操作・アカウントなら作らない。拒否は件数にも数えない。
    assert.deepEqual(
      reasons(exec(db, autoCreate('op-2', { candidate_id: CAND_2 }))),
      ['already_created'],
    );
    assert.equal(windowTotal(db), 1);
    assert.equal(operationState(db, 'op-2'), undefined);
    // 別のアカウントは別の記録。
    committed(
      exec(
        db,
        autoCreate('op-3', { candidate_id: CAND_2, account_id: 'acct-2' }),
      ),
    );
    // 同じ依頼でも操作の種類が違えば作れる（ラベルの付与）。
    committed(exec(db, autoCreate('op-4', { remote: true })));
    assert.equal(windowTotal(db), 3);
    assert.deepEqual(
      (links(db) as { operation_id: string; operation_kind: string }[]).map(
        (row) => [row.operation_id, row.operation_kind],
      ),
      [
        ['op-1', 'create_task'],
        ['op-3', 'create_task'],
        ['op-4', 'label_mail'],
      ],
    );
  });
});

test('the judgement is refused for a cancelled, suppressed or revised request and for a stale, missing or unfinished analysis', async () => {
  const cases: readonly {
    readonly name: string;
    readonly change: (db: SqliteDatabase) => void;
    readonly expected: readonly string[];
  }[] = [
    {
      name: 'cancelled',
      change: (db) =>
        db.exec(
          `UPDATE request_entities SET state = 'cancelled' WHERE request_entity_id = '${REQ}'`,
        ),
      expected: ['entity_cancelled'],
    },
    {
      name: 'completed and suppressed',
      change: (db) =>
        db.exec(
          `UPDATE request_entities SET state = 'completed', recreation_suppressed = 1 WHERE request_entity_id = '${REQ}'`,
        ),
      expected: ['entity_completed', 'recreation_suppressed'],
    },
    {
      name: 'revised request',
      change: (db) =>
        db.exec(
          `UPDATE request_entities SET request_revision = 4 WHERE request_entity_id = '${REQ}'`,
        ),
      expected: ['request_revision_changed'],
    },
    {
      // 新しい版が公開されて ready に戻っても、旧版で判定した資格は通さない（ADR 0103）。
      name: 'newer ready revision',
      change: (db) => analysis(db, 3, OTHER_HASH, 6, 'ready'),
      expected: [
        'analysis_revision_changed',
        'source_set_changed',
        'generation_changed',
      ],
    },
    {
      name: 'newer pending revision with the same sources',
      change: (db) => analysis(db, 3, HASH, 5, 'pending'),
      expected: ['analysis_revision_changed', 'analysis_not_ready'],
    },
    {
      name: 'analysis removed',
      change: (db) =>
        db.exec(`DELETE FROM related_analyses WHERE group_id = '${GROUP}'`),
      expected: ['analysis_not_found'],
    },
    {
      name: 'candidate dismissed',
      change: (db) =>
        db.exec(
          `UPDATE notification_candidates SET state = 'dismissed', closed_at = ${T0}, key_delete_at = ${T0 + 604800000 + 7776000000}, state_changed_at = ${T0} WHERE candidate_id = '${CAND}'`,
        ),
      expected: ['candidate_closed'],
    },
  ];
  for (const item of cases)
    await withStore((db) => {
      item.change(db);
      assert.deepEqual(
        reasons(exec(db, autoCreate('op-1'))),
        item.expected,
        item.name,
      );
      assert.equal(operationState(db, 'op-1'), undefined, item.name);
      assert.deepEqual(links(db), [], item.name);
      assert.equal(windowTotal(db), 0, item.name);
    });
});

test('a candidate without a request or analysis, an unknown candidate and a malformed origin are refused', async () => {
  await withStore((db) => {
    assert.deepEqual(
      reasons(exec(db, autoCreate('op-1', { candidate_id: CAND_OVERLAP }))),
      ['candidate_without_request', 'related_analysis_missing'],
    );
    assert.deepEqual(
      reasons(
        exec(
          db,
          autoCreate('op-2', {
            candidate_id: '99999999-9999-4999-8999-999999999999',
          }),
        ),
      ),
      ['candidate_not_found'],
    );
    // 候補の起点は方針による自動承認にだけ付ける。
    assert.deepEqual(reasons(exec(db, autoCreate('op-3', { auto: false }))), [
      'candidate_origin_without_auto',
    ]);
    assert.deepEqual(
      reasons(exec(db, autoCreate('op-4', { account_id: '' }))),
      ['candidate_origin_invalid'],
    );
    assert.equal(windowTotal(db), 0);
  });
});

test('a local task is not applied when the request is cancelled or gone after the approval', async () => {
  await withStore((db) => {
    committed(exec(db, autoCreate('op-1')));
    db.exec(
      `UPDATE request_entities SET state = 'cancelled' WHERE request_entity_id = '${REQ}'`,
    );
    assert.deepEqual(reasons(exec(db, applyLocal('op-1', '1'))), [
      'entity_cancelled',
    ]);
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'approved',
      state_revision: 1,
    });
  });
  // 依頼が期限で消え、一度だけの記録も一緒に消えても、承認の行の版で探して拒否する（素通りしない）。
  await withStore((db) => {
    committed(exec(db, autoCreate('op-1')));
    db.exec(
      `UPDATE notification_candidates SET request_entity_id = NULL, request_revision = NULL WHERE request_entity_id = '${REQ}'`,
    );
    db.exec(
      `DELETE FROM request_entity_operations WHERE request_entity_id = '${REQ}'`,
    );
    db.exec(`DELETE FROM request_entities WHERE request_entity_id = '${REQ}'`);
    assert.deepEqual(reasons(exec(db, applyLocal('op-1', '1'))), [
      'entity_not_found',
    ]);
  });
  // 依頼はあるのに自分の一度だけの記録が無いのは欠けとして拒否する。
  await withStore((db) => {
    committed(exec(db, autoCreate('op-1')));
    db.exec(
      "DELETE FROM request_entity_operations WHERE operation_id = 'op-1'",
    );
    assert.deepEqual(reasons(exec(db, applyLocal('op-1', '1'))), [
      'candidate_link_missing',
    ]);
  });
});

test('a remote label is not dispatched when a newer analysis is published between preparing and dispatching', async () => {
  await withStore((db) => {
    committed(exec(db, autoCreate('op-1', { remote: true })));
    const prepare = prepareCommand('op-1', '1');
    committed(exec(db, prepare));
    analysis(db, 3, OTHER_HASH, 6, 'pending');
    assert.deepEqual(
      reasons(exec(db, dispatchCommand('op-1', '2', prepare.attempt_id))),
      [
        'analysis_revision_changed',
        'source_set_changed',
        'generation_changed',
        'analysis_not_ready',
      ],
    );
    assert.deepEqual(operationState(db, 'op-1'), {
      state: 'preparing',
      state_revision: 2,
    });
  });
  // 版が現在のままなら送出意図まで進む。
  await withStore((db) => {
    committed(exec(db, autoCreate('op-1', { remote: true })));
    const prepare = prepareCommand('op-1', '1');
    committed(exec(db, prepare));
    assert.equal(
      committed(exec(db, dispatchCommand('op-1', '2', prepare.attempt_id))),
      '3',
    );
  });
});

test('an automatic approval from the person’s own request has no candidate columns and is not checked against a request entity', async () => {
  await withStore((db) => {
    committed(
      exec(
        db,
        createCommand('op-1', {
          auto: true,
          ...LOCAL,
          operation_kind: 'task.create',
        }),
      ),
    );
    assert.deepEqual(guardColumns(db, 'op-1'), {
      route: 'policy_auto',
      candidate_id: null,
      request_entity_id: null,
      request_revision: null,
      related_group_id: null,
      analysis_revision: null,
      source_set_hash: null,
      published_generation: null,
    });
    assert.deepEqual(links(db), []);
    assert.equal(committed(exec(db, applyLocal('op-1', '1'))), '2');
  });
});

test('the judged versions on an approval are all or none, only on a policy approval, and never change', async () => {
  await withStore((db) => {
    committed(exec(db, autoCreate('op-1')));
    assert.throws(
      () =>
        db.exec(
          "UPDATE approvals SET request_revision = 9 WHERE operation_id = 'op-1'",
        ),
      /approval_candidate_guard_fixed/u,
    );
    committed(exec(db, createCommand('op-2')));
    const insert = (
      route: string,
      candidate: string | null,
      hash: string | null,
    ) =>
      db
        .prepare(
          `INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at, candidate_id, request_entity_id, request_revision, related_group_id, analysis_revision, source_set_hash, published_generation) VALUES (?, 'op-2', 1, (SELECT content_hash FROM operation_versions WHERE operation_id = 'op-2'), ?, ?, ?, ?, 'valid', ${T0}, ?, ?, 3, ?, 2, ?, 5)`,
        )
        .run(
          randomUUID(),
          route,
          route === 'screen' ? 'dev-1' : null,
          route === 'screen' ? 'pv-1' : null,
          route === 'screen' ? null : 3,
          candidate,
          REQ,
          GROUP,
          hash,
        );
    // 一部だけの列は拒否する。
    assert.throws(
      () => insert('policy_auto', CAND, null),
      /approval_candidate_guard_invalid/u,
    );
    // 画面の承認は版の列を持たない。
    assert.throws(
      () => insert('screen', CAND, HASH),
      /approval_candidate_guard_invalid/u,
    );
  });
});
