// 候補を起点にした自動実行の判定に使う DB の現在値（ADR 0149）。worker を介した読み取りと、行が無いときの形を見る。
// 期待値は 0001 の列（依頼の状態・版・抑止、作成済みの操作のカレンダーなしは空文字）と ADR 0074・0147 の
// 時間窓（10 分・20 件）から手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  DbWorkerClient,
  executeCommand,
  readAutoExecutionState,
  stopSafetyBreaker,
} from './index.js';
import type { SqliteDatabase } from './index.js';
import {
  STORE_GENERATION,
  createCommand,
  databasePath,
  openSeededDatabase,
  storeContext,
  withTempDir,
} from './operation-test-support.js';

const T0 = 1_800_000_000_000;
const REQ = '11111111-1111-4111-8111-111111111111';
const CAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAND_OVERLAP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function seed(db: SqliteDatabase): void {
  db.prepare(
    "INSERT INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, 'acct-1', 'thread-1', 'msg-1', 3, 'active', 1, NULL, ?, NULL)",
  ).run(REQ, T0);
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, kind, notification_key, state, created_at, received_at, state_changed_at) VALUES (?, ?, 3, 'mail_deadline', 'key-1', 'seen', ?, ?, ?)",
  ).run(CAND, REQ, T0, T0, T0);
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, kind, notification_key, state, created_at, received_at, state_changed_at) VALUES (?, 'schedule_overlap', 'key-2', 'new', ?, ?, ?)",
  ).run(CAND_OVERLAP, T0, T0, T0);
  // 結び付ける操作は先に要る（0011 の trigger）。
  const operations = [randomUUID(), randomUUID()];
  for (const operationId of operations) {
    const result = executeCommand(
      db,
      createCommand(operationId),
      storeContext(T0),
    );
    assert.equal(result.outcome.outcome, 'durable');
  }
  const created = db.prepare(
    'INSERT INTO request_entity_operations (request_entity_id, operation_kind, account_id, calendar_id, operation_id) VALUES (?, ?, ?, ?, ?)',
  );
  created.run(REQ, 'create_task', 'acct-1', '', operations[0]);
  created.run(REQ, 'create_event', 'acct-1', 'cal-1', operations[1]);
  db.prepare(
    "INSERT INTO safety_window_counts (window_start, scope_key, count) VALUES (?, 'policy_auto', 4)",
  ).run(T0);
  const ledger = db.prepare(
    'INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at, entry_hash, item_count) VALUES (?, ?, ?, ?, 1)',
  );
  ledger.run(1, 'f-1', T0, 'a'.repeat(64));
  ledger.run(2, 'f-2', T0, 'b'.repeat(64));
}

test('worker を介して、候補・依頼・作成済みの操作・時間窓・忘却の世代を読む', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    const db = openSeededDatabase(path);
    try {
      seed(db);
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
        await client.query({
          kind: 'auto_execution_state',
          candidate_id: CAND,
        }),
        {
          safety_stopped: false,
          auto_approvals: {
            window_started_at: '2027-01-15T08:00:00.000Z',
            auto_approvals: 4,
            limit: 20,
            window_minutes: 10,
          },
          forgetting_generation: '2',
          candidate: {
            candidate_id: CAND,
            candidate_kind: 'mail_deadline',
            state: 'seen',
            request_entity_id: REQ,
            request_revision: '3',
          },
          entity: {
            record: {
              request_entity_id: REQ,
              state: 'active',
              recreation_suppressed: true,
              created_operations: [
                {
                  operation_kind: 'create_event',
                  account_id: 'acct-1',
                  calendar_id: 'cal-1',
                },
                {
                  operation_kind: 'create_task',
                  account_id: 'acct-1',
                  calendar_id: null,
                },
              ],
            },
            request_revision: '3',
          },
        },
      );
    } finally {
      await client.close();
    }
  });
});

test('候補が無い・依頼を持たない候補では null を返し、安全停止を読む', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seed(db);
      stopSafetyBreaker(db, T0, 'rate_exceeded');
      const missing = readAutoExecutionState(
        db,
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
      );
      assert.equal(missing.safety_stopped, true);
      assert.equal(missing.candidate, null);
      assert.equal(missing.entity, null);
      const overlap = readAutoExecutionState(db, CAND_OVERLAP);
      assert.deepEqual(overlap.candidate, {
        candidate_id: CAND_OVERLAP,
        candidate_kind: 'schedule_overlap',
        state: 'new',
        request_entity_id: null,
        request_revision: null,
      });
      assert.equal(overlap.entity, null);
    } finally {
      db.close();
    }
  });
});
