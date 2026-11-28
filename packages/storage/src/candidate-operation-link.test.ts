// 候補と自動実行の操作の結び付き（CandidateRow.operation_ids、ADR 0199・U282）を、worker を介さずに同期で確かめる。
// 結び付きは承認の行（approvals.candidate_id、ADR 0148）からだけ読む。候補が 97 日の掃除・忘却で消えても、操作・承認・
// 一度だけの記録は消えず、承認の行の候補 ID はどの候補にも当たらない値として残ること、同じ識別子で作り直した候補へ
// 古い操作が付かないことを確かめる。期待値は手で書いた値。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  deleteForgetNode,
  executeCandidateOp,
  executeCommand,
} from './index.js';
import type {
  CandidateOp,
  CandidateOpValues,
  CreateOperationCommand,
  DbCommand,
  SqliteDatabase,
  StoreOutcome,
} from './index.js';
import {
  createCommand,
  databasePath,
  openSeededDatabase,
  sealedIntent,
  storeContext,
  withTempDir,
} from './operation-test-support.js';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const REQ = '11111111-1111-4111-8111-111111111111';
const CAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAND_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAND_OVERLAP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CAND_NEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GROUP = 'group-1';
const HASH = 'd'.repeat(64);

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

// 依頼（版 3、有効）・関連解析（版 2、ready）・その版で作った候補 2 つと、依頼を持たない予定の重複の候補。
function seed(db: SqliteDatabase): void {
  db.prepare(
    "INSERT INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, 'acct-1', 'thread-1', 'msg-1', 3, 'active', 0, NULL, ?, NULL)",
  ).run(REQ, T0);
  db.prepare(
    "INSERT INTO related_analyses (group_id, analysis_revision, source_set_hash, published_generation, plan_complete, status) VALUES (?, 2, ?, 5, 1, 'ready')",
  ).run(GROUP, HASH);
  const candidate = db.prepare(
    "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, kind, notification_key, state, created_at, received_at, state_changed_at, related_group_id, related_analysis_revision, related_source_set_hash, related_published_generation) VALUES (?, ?, 3, 'mail_deadline', ?, 'new', ?, ?, ?, ?, 2, ?, 5)",
  );
  candidate.run(CAND, REQ, 'key-1', T0, T0, T0, GROUP, HASH);
  candidate.run(CAND_2, REQ, 'key-2', T0, T0 - 1, T0, GROUP, HASH);
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, kind, notification_key, state, created_at, received_at, state_changed_at) VALUES (?, 'schedule_overlap', 'key-3', 'new', ?, ?, ?)",
  ).run(CAND_OVERLAP, T0, T0 - 2, T0);
}

function exec(db: SqliteDatabase, command: DbCommand, now = T0): StoreOutcome {
  const result = executeCommand(db, command, storeContext(now));
  assert.equal(result.halt, false, JSON.stringify(result.outcome));
  return result.outcome;
}

function durable(outcome: StoreOutcome): void {
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
}

const LOCAL = { effect_route: 'local_command', connection_id: null } as const;

// 候補を起点にした方針による自動承認の作成（既定は用事の登録、アカウント acct-1）。
function autoCreate(
  operationId: string,
  candidateId: string,
  options: { readonly remote?: boolean; readonly account_id?: string } = {},
): CreateOperationCommand {
  return {
    ...createCommand(operationId, {
      auto: true,
      ...(options.remote === true
        ? { operation_kind: 'mail.labels.change' }
        : { ...LOCAL, operation_kind: 'task.create' }),
    }),
    candidate_origin: {
      candidate_id: candidateId,
      account_id: options.account_id ?? 'acct-1',
      calendar_id: null,
    },
  };
}

function run<K extends CandidateOp['kind']>(
  db: SqliteDatabase,
  op: Extract<CandidateOp, { kind: K }>,
): CandidateOpValues[K] {
  const { result } = executeCandidateOp(db, op, {
    platform: 'macos',
    halted: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as unknown as { value: CandidateOpValues[K] }).value;
}

// 一覧（全状態）で読んだ、候補 ID → 操作 ID の並び。
function listed(db: SqliteDatabase): Record<string, readonly string[]> {
  const value = run(db, { kind: 'candidate.list', limit: 100 });
  return Object.fromEntries(
    value.candidates.map((row) => [row.candidate_id, row.operation_ids]),
  );
}

function got(db: SqliteDatabase, id: string): readonly string[] | null {
  return (
    run(db, { kind: 'candidate.get', candidate_id: id }).candidate
      ?.operation_ids ?? null
  );
}

const count = (db: SqliteDatabase, sql: string): unknown =>
  db.prepare(sql).pluck().get();

function close(db: SqliteDatabase, id: string, now: number): void {
  run(db, {
    kind: 'candidate.transition',
    input: {
      candidate_id: id,
      event: 'dismiss',
      expected_state: 'new',
      zone: 'Asia/Tokyo',
      snooze_until: null,
      now: new Date(now).toISOString(),
    },
  });
}

test('operation_ids lists the automatic operations started from each candidate, oldest approval first; others stay empty', async () => {
  await withStore((db) => {
    // 結び付きのない候補は空（作成の前）。
    assert.deepEqual(listed(db), {
      [CAND]: [],
      [CAND_2]: [],
      [CAND_OVERLAP]: [],
    });
    // 同じ候補から 2 つ（承認の時刻が後の方を ID の小さい名前にして、並びが ID でなく時刻で決まることを見る）。
    durable(exec(db, autoCreate('op-b', CAND), T0));
    durable(exec(db, autoCreate('op-a', CAND, { remote: true }), T0 + 10));
    // 別の候補から、別のアカウントの用事。
    durable(exec(db, autoCreate('op-c', CAND_2, { account_id: 'acct-2' })));
    // 画面で承認する操作（自動承認でない）は、どの候補にも結び付かない。
    durable(exec(db, createCommand('op-screen', LOCAL)));
    assert.deepEqual(listed(db), {
      [CAND]: ['op-b', 'op-a'],
      [CAND_2]: ['op-c'],
      [CAND_OVERLAP]: [],
    });
    assert.deepEqual(got(db, CAND), ['op-b', 'op-a']);
    assert.deepEqual(got(db, CAND_OVERLAP), []);
    assert.equal(got(db, randomUUID()), null);
  });
});

test('a refused creation leaves no link; the page and the cursor carry each candidate its own operations', async () => {
  await withStore((db) => {
    durable(exec(db, autoCreate('op-c', CAND_2, { account_id: 'acct-2' })));
    // 閉じた候補からの作成は最終ガードで断られ、承認の行を書かないので結び付きも残らない。
    close(db, CAND, T0 + 1);
    const refused = exec(
      db,
      autoCreate('op-x', CAND, { account_id: 'acct-3' }),
    );
    assert.deepEqual(
      refused.outcome === 'rejected' ? refused.reasons : refused,
      ['candidate_closed'],
    );
    assert.deepEqual(got(db, CAND), []);
    // 1 件ずつの頁でも、各候補の操作はその候補の行にだけ付く（受信の新しい順: CAND・CAND_2・CAND_OVERLAP）。
    const first = run(db, { kind: 'candidate.list', limit: 1 });
    assert.deepEqual(
      first.candidates.map((row) => [row.candidate_id, row.operation_ids]),
      [[CAND, []]],
    );
    const second = run(db, {
      kind: 'candidate.list',
      limit: 1,
      after: first.next_after as NonNullable<typeof first.next_after>,
    });
    assert.deepEqual(
      second.candidates.map((row) => [row.candidate_id, row.operation_ids]),
      [[CAND_2, ['op-c']]],
    );
  });
});

test('the 97 day sweep removes the candidate but keeps the operation, its approval and the once-only record', async () => {
  await withStore((db) => {
    durable(exec(db, autoCreate('op-1', CAND)));
    close(db, CAND, T0 + 1);
    // 閉じた時刻 + 97 日で行ごと消える（ADR 0118）。
    const swept = run(db, {
      kind: 'candidate.sweep',
      now: new Date(T0 + 1 + 97 * DAY).toISOString(),
    });
    assert.deepEqual(swept.deleted, [CAND]);
    assert.equal(got(db, CAND), null);
    assert.equal(
      count(db, "SELECT count(*) FROM operations WHERE operation_id = 'op-1'"),
      1,
    );
    // 承認の行の候補 ID は、どの候補にも当たらない値として残る（最終ガードの印なので外さない。0015 の trigger）。
    assert.equal(
      count(
        db,
        "SELECT candidate_id FROM approvals WHERE operation_id = 'op-1'",
      ),
      CAND,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM notification_candidates WHERE candidate_id = (SELECT candidate_id FROM approvals WHERE operation_id = 'op-1')",
      ),
      0,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE approvals SET candidate_id = NULL WHERE operation_id = 'op-1'",
          )
          .run(),
      /approval_candidate_guard_fixed/u,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM request_entity_operations WHERE operation_id = 'op-1'",
      ),
      1,
    );
    // 同じ識別子で作り直した候補は新しい ID なので、古い操作は付かない。
    db.prepare(
      "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, kind, notification_key, state, created_at, received_at, state_changed_at) VALUES (?, ?, 3, 'mail_deadline', 'key-1', 'new', ?, ?, ?)",
    ).run(CAND_NEW, REQ, T0 + 98 * DAY, T0 + 98 * DAY, T0 + 98 * DAY);
    assert.deepEqual(got(db, CAND_NEW), []);
  });
});

test('forgetting a candidate keeps its operations, and the final guard still runs from the approval after the candidate is gone', async () => {
  await withStore((db) => {
    durable(exec(db, autoCreate('op-1', CAND)));
    durable(exec(db, autoCreate('op-2', CAND_2, { account_id: 'acct-2' })));
    assert.equal(
      deleteForgetNode(db, { kind: 'notification_candidate', id: CAND }),
      1,
    );
    assert.equal(got(db, CAND), null);
    assert.deepEqual(listed(db), {
      [CAND_2]: ['op-2'],
      [CAND_OVERLAP]: [],
    });
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM approvals WHERE operation_id = 'op-1' AND candidate_id IS NOT NULL",
      ),
      1,
    );
    // 候補が消えても、承認の行の版で依頼を照合する（依頼の取消で適用を断る。候補の削除で照合を素通りしない）。
    db.prepare(
      "UPDATE request_entities SET state = 'cancelled' WHERE request_entity_id = ?",
    ).run(REQ);
    const applied = exec(db, {
      command_id: randomUUID(),
      kind: 'operation.apply_local',
      operation_id: 'op-1',
      expected_state_revision: '1',
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
    assert.deepEqual(
      applied.outcome === 'rejected' ? applied.reasons : applied,
      ['entity_cancelled'],
    );
  });
});
