// スナップショット・イベント・操作の表示用の照会（ADR 0023）。DB は一時ディレクトリに作って消す。
// 期待値（連番・版・状態・範囲）は 0001 の制約と命令の並びから手で書いた値。
// DB worker 経由では、COMMIT しなかった命令のイベントが照会に出ないこと（durable commit の後だけ配信）も確かめる。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DbWorkerClient,
  executeCommand,
  executeEventQuery,
  hasReceiptForRequest,
  readCurrentScope,
  readEventsSince,
  readOperationView,
  readSnapshot,
} from './index.js';
import type { DbWorkerOptions } from './index.js';
import {
  CONTENT_HASH,
  STORE_GENERATION,
  approveCommand,
  cancelCommand,
  createCommand,
  databasePath,
  dispatchCommand,
  openSeededDatabase,
  prepareCommand,
  resultCommand,
  storeContext,
  withTempDir,
} from './operation-test-support.js';

const REQUEST = {
  command_scope_id: 'scope-1',
  request_id: 'req-1',
  request_hash: 'a'.repeat(64),
};

test(
  'the snapshot reads operations with the event boundary, and terminal operations only while their events remain',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const run = (command: Parameters<typeof executeCommand>[1]) => {
          const result = executeCommand(db, command, storeContext());
          assert.equal(
            result.outcome.outcome,
            'durable',
            JSON.stringify(result.outcome),
          );
        };
        assert.deepEqual(readSnapshot(db, STORE_GENERATION), {
          store_generation: STORE_GENERATION,
          max_sequence: 0,
          min_sequence: null,
          operations: [],
        });
        run(createCommand('op-wait'));
        run(createCommand('op-cancel'));
        run(cancelCommand('op-cancel', '1'));
        run(createCommand('op-done', { auto: true }));
        run(prepareCommand('op-done', '1', { attempt_id: 'att-done' }));
        run(dispatchCommand('op-done', '2', 'att-done'));
        run(
          resultCommand('op-done', '3', 'att-done', 'reconciling', {
            external_id: 'ext-1',
          }),
        );
        run(
          resultCommand('op-done', '4', 'att-done', 'succeeded', {
            external_id: 'ext-1',
          }),
        );
        run(approveCommand('op-wait', '1', { request: REQUEST }));

        const snapshot = readSnapshot(db, STORE_GENERATION);
        // 作成 3・取消 1・準備・送出意図・照合中・成功の 4・承認 1 の 9 件。
        assert.equal(snapshot.max_sequence, 9);
        assert.equal(snapshot.min_sequence, 1);
        const byId = new Map(
          snapshot.operations.map((view) => [view.operation_id, view]),
        );
        assert.deepEqual([...byId.keys()].sort(), [
          'op-cancel',
          'op-done',
          'op-wait',
        ]);
        assert.deepEqual(byId.get('op-wait'), {
          operation_id: 'op-wait',
          workflow_id: null,
          operation_kind: 'mail.labels.change',
          effect_route: 'remote_mutation',
          state: 'approved',
          state_revision: '2',
          current_content_version: '1',
          content_hash: CONTENT_HASH,
          approval_status: 'valid',
          result_status: null,
          external_id: null,
          attempt_id: null,
          attempt_status: null,
          cancel_requested: false,
          request_revision: null,
          forgetting_generation: '0',
          created_at: 1_000_000,
        });
        const done = byId.get('op-done');
        assert.equal(done?.state, 'succeeded');
        assert.equal(done?.state_revision, '5');
        assert.equal(done?.approval_status, 'consumed');
        assert.equal(done?.result_status, 'confirmed_success');
        assert.equal(done?.external_id, 'ext-1');
        assert.equal(byId.get('op-cancel')?.approval_status, 'none');
        assert.deepEqual(readOperationView(db, 'op-wait'), byId.get('op-wait'));
        assert.equal(readOperationView(db, 'op-none'), null);

        // 7 日の削除の模擬: 取消した操作と承認待ちの操作のイベントを消す。終端の取消は表示から外れ、
        // 終端でない操作は残る。残っている最小の連番が上がる。
        db.prepare(
          "DELETE FROM event_outbox WHERE target_id IN ('op-cancel', 'op-wait')",
        ).run();
        db.prepare(
          "INSERT INTO forget_ledger VALUES (1, 'entry-1', 2000000)",
        ).run();
        const later = readSnapshot(db, STORE_GENERATION);
        assert.deepEqual(
          later.operations.map((view) => view.operation_id).sort(),
          ['op-done', 'op-wait'],
        );
        assert.equal(later.max_sequence, 8);
        assert.equal(later.min_sequence, 4);
        assert.equal(
          readOperationView(db, 'op-wait')?.forgetting_generation,
          '1',
        );
        // 本文の列（暗号文・nonce など）を返さない。
        assert(!JSON.stringify(later).includes('ciphertext'));
        assert(!JSON.stringify(later).includes('intent'));
      } finally {
        db.close();
      }
    });
  },
);

test(
  'events after a sequence are paged with the retained range, receipts and current scopes are found',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        for (const id of ['op-1', 'op-2', 'op-3'])
          executeCommand(db, createCommand(id), storeContext());
        const first = readEventsSince(db, STORE_GENERATION, 0, 2);
        assert.deepEqual(
          first.events.map((event) => [
            event.sequence,
            event.target_id,
            event.state_revision,
            event.event_type,
          ]),
          [
            [1, 'op-1', '1', 'operation.updated'],
            [2, 'op-2', '1', 'operation.updated'],
          ],
        );
        assert.equal(first.has_more, true);
        assert.equal(first.min_sequence, 1);
        assert.equal(first.max_sequence, 3);
        const rest = readEventsSince(db, STORE_GENERATION, 2, 2);
        assert.deepEqual(
          rest.events.map((event) => event.sequence),
          [3],
        );
        assert.equal(rest.has_more, false);
        assert.deepEqual(
          readEventsSince(db, STORE_GENERATION, 3, 2).events,
          [],
        );
        // 別の世代の行は読まない。
        assert.deepEqual(
          readEventsSince(db, '00000000-0000-4000-8000-0000000000bb', 0, 10),
          {
            store_generation: '00000000-0000-4000-8000-0000000000bb',
            min_sequence: null,
            max_sequence: 0,
            events: [],
            has_more: false,
          },
        );
        // 古い行を消すと、残っている最小の連番で欠けが分かる。
        db.prepare('DELETE FROM event_outbox WHERE sequence <= 2').run();
        const gap = readEventsSince(db, STORE_GENERATION, 0, 10);
        assert.equal(gap.min_sequence, 3);
        assert.deepEqual(
          gap.events.map((event) => event.sequence),
          [3],
        );

        executeCommand(
          db,
          approveCommand('op-1', '1', { request: REQUEST }),
          storeContext(),
        );
        assert.equal(hasReceiptForRequest(db, 'scope-1', 'req-1'), true);
        assert.equal(hasReceiptForRequest(db, 'scope-1', 'req-2'), false);
        assert.equal(hasReceiptForRequest(db, 'scope-2', 'req-1'), false);

        const insert = db.prepare(
          'INSERT INTO command_scopes VALUES (?, ?, ?, ?, ?, ?)',
        );
        insert.run('s-old', 'dev-1', 'core-1', 1000, 5000, 2000);
        insert.run('s-cur', 'dev-1', 'core-1', 2000, 90_000, null);
        insert.run('s-other-core', 'dev-1', 'core-0', 3000, 90_000, null);
        insert.run('s-dev2', 'dev-2', 'core-1', 2000, 90_000, null);
        assert.equal(
          readCurrentScope(db, 'dev-1', 'core-1', 3000)?.command_scope_id,
          's-cur',
        );
        assert.equal(
          readCurrentScope(db, 'dev-1', 'core-1', 90_000),
          null,
          'expired',
        );
        assert.equal(
          readCurrentScope(db, 'dev-1', 'core-1', 1500),
          null,
          'before issue',
        );
        assert.equal(
          readCurrentScope(db, 'dev-1', 'core-2', 3000),
          null,
          'other core',
        );
        assert.equal(
          readCurrentScope(db, 'dev-2', 'core-1', 3000)?.command_scope_id,
          's-dev2',
        );

        assert.throws(
          () =>
            executeEventQuery(db, STORE_GENERATION, {
              kind: 'events_since',
              after_sequence: -1,
              limit: 10,
            }),
          /events_query_invalid/u,
        );
        assert.throws(
          () =>
            executeEventQuery(db, STORE_GENERATION, {
              kind: 'events_since',
              after_sequence: 0,
              limit: 501,
            }),
          /events_query_invalid/u,
        );
      } finally {
        db.close();
      }
    });
  },
);

const startClient = (
  path: string,
  options: Partial<DbWorkerOptions> = {},
): Promise<DbWorkerClient> =>
  DbWorkerClient.start({
    path,
    storeGeneration: STORE_GENERATION,
    responseTimeoutMs: 10_000,
    ...options,
  });

test(
  'through the DB worker only committed commands produce events, and malformed queries fail',
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      const path = databasePath(dir);
      openSeededDatabase(path).close();
      // COMMIT の前の失敗（巻き戻し）: 承認は記録されず、worker は書込みを止める。
      const faulty = await startClient(path, {
        faults: { throwBeforeCommit: 'operation.approve' },
      });
      try {
        assert.equal(
          (await faulty.submit(createCommand('op-1')).result).outcome,
          'durable',
        );
        const rolledBack = await faulty.submit(approveCommand('op-1', '1'))
          .result;
        assert.equal(rolledBack.outcome, 'rejected');
      } finally {
        await faulty.close();
      }
      const client = await startClient(path);
      try {
        const page = await client.query({
          kind: 'events_since',
          after_sequence: 0,
          limit: 10,
        });
        assert.deepEqual(
          page.events.map((event) => [event.sequence, event.state_revision]),
          [[1, '1']],
        );
        const snapshot = await client.query({ kind: 'snapshot' });
        assert.equal(snapshot.max_sequence, 1);
        assert.equal(snapshot.operations[0]?.state, 'awaiting_approval');
        // 新しい worker で送り直せば適用され、イベントが一つ増える。
        assert.equal(
          (await client.submit(approveCommand('op-1', '1')).result).outcome,
          'durable',
        );
        const after = await client.query({
          kind: 'events_since',
          after_sequence: 1,
          limit: 10,
        });
        assert.deepEqual(
          after.events.map((event) => [event.sequence, event.state_revision]),
          [[2, '2']],
        );
        assert.equal(
          (await client.query({ kind: 'operation_view', operation_id: 'op-1' }))
            ?.state_revision,
          '2',
        );
        assert.equal(
          await client.query({
            kind: 'receipt_exists',
            command_scope_id: 'scope-x',
            request_id: 'r',
          }),
          false,
        );
        assert.equal(
          await client.query({
            kind: 'current_scope',
            device_id: 'dev-1',
            core_instance_id: 'c',
            now: 1,
          }),
          null,
        );
        await assert.rejects(
          client.query({ kind: 'events_since', after_sequence: 0, limit: 0 }),
          (error: Error & { reason?: string }) =>
            error.reason === 'query_failed',
        );
        assert.equal(client.state, 'running');
      } finally {
        await client.close();
      }
    });
  },
);
