// 会話・発言・依頼・入力スナップショットの保存と、内容版の更新（D1）の保存（ADR 0029）を、worker を介さずに
// 同期で確かめる。DB は一時ディレクトリの書込み接続。期待値（行数・状態・版・理由）は 0001 の制約と ADR 0027・0029
// から手で書いた値。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { executeCommand, executeConversationOp } from './index.js';
import type {
  ConversationOp,
  ConversationOpResult,
  DbCommand,
  ReviseContentCommand,
  SqliteDatabase,
  StoreOutcome,
} from './index.js';
import {
  CONTENT_HASH,
  OTHER_CONTENT_HASH,
  STORE_GENERATION,
  approveCommand,
  createCommand,
  databasePath,
  effectiveApprovals,
  openSeededDatabase,
  operationState,
  prepareCommand,
  sealedIntent,
  storeContext,
  withTempDir,
} from './operation-test-support.js';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const SCOPE = '22222222-2222-4222-8222-222222222222';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function withStore(run: (db: SqliteDatabase) => void): Promise<void> {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      db.prepare(
        "INSERT INTO devices VALUES (?, '合成の端末', 'macos', 0, X'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1000, NULL, NULL)",
      ).run(DEVICE);
      run(db);
    } finally {
      db.close();
    }
  });
}

const op = (db: SqliteDatabase, value: ConversationOp): ConversationOpResult =>
  executeConversationOp(db, value, {
    platform: 'macos',
    halted: false,
    storeGeneration: STORE_GENERATION,
  }).result;

const ok = (result: ConversationOpResult): Record<string, unknown> => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result.ok ? result.value : null) as unknown as Record<
    string,
    unknown
  >;
};

const rejectedWith = (result: ConversationOpResult): readonly string[] => {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.ok ? [] : result.reasons;
};

const request = (hash = HASH_A, requestId = randomUUID()) => ({
  command_scope_id: SCOPE,
  request_id: requestId,
  request_hash: hash,
  command_id: randomUUID(),
});

const count = (db: SqliteDatabase, table: string): number =>
  db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;

const createSession = (
  sessionId: string,
  ref = request(),
): Extract<ConversationOp, { kind: 'session.create' }> => ({
  kind: 'session.create',
  session_id: sessionId,
  storage_mode: 'normal',
  display_device_id: DEVICE,
  created_at: 2_000,
  request: ref,
});

const turn = (
  sessionId: string,
  options: {
    readonly ref?: ReturnType<typeof request>;
    readonly workflow?: string | null;
    readonly operation?: string;
  } = {},
): Extract<ConversationOp, { kind: 'turn.record' }> => ({
  kind: 'turn.record',
  session_id: sessionId,
  turn_id: randomUUID(),
  input_id: randomUUID(),
  text: sealedIntent(),
  created_at: 3_000,
  expires_at: 3_000 + 604_800_000,
  workflow:
    options.workflow === null
      ? null
      : { workflow_id: options.workflow ?? randomUUID(), state: 'ready' },
  permission_revision: '4',
  request: options.ref ?? request(),
  operation:
    options.operation === undefined
      ? null
      : {
          operation_id: options.operation,
          operation_kind: 'mail.labels.change',
          effect_route: 'remote_mutation',
          content_hash: CONTENT_HASH,
          intent: sealedIntent(),
        },
  response_json: JSON.stringify({ synthetic: options.operation ?? 'none' }),
});

test(
  'sessions are created once per request and other content under the same request_id is a conflict',
  { timeout: 30_000 },
  async () => {
    await withStore((db) => {
      const sessionId = randomUUID();
      const ref = request();
      const created = ok(op(db, createSession(sessionId, ref)));
      assert.deepEqual(created, {
        session_id: sessionId,
        storage_mode: 'normal',
        display_device_id: DEVICE,
        route_revision: '0',
        created_at: 2_000,
        ended_at: null,
      });
      // 同じ要求の再送は保存済みの会話（新しい ID の会話を作らない）。
      assert.deepEqual(ok(op(db, createSession(randomUUID(), ref))), created);
      assert.equal(count(db, 'sessions'), 1);
      // 同じ request_id で照合値が違う: request_conflict。
      assert.deepEqual(
        rejectedWith(
          op(
            db,
            createSession(randomUUID(), {
              ...ref,
              request_hash: HASH_B,
            }),
          ),
        ),
        ['request_conflict'],
      );
      // 失効した端末・知らない端末の会話は作らない。
      db.prepare('UPDATE devices SET revoked_at = 5 WHERE device_id = ?').run(
        DEVICE,
      );
      assert.deepEqual(rejectedWith(op(db, createSession(randomUUID()))), [
        'device_not_active',
      ]);
      assert.equal(count(db, 'sessions'), 1);
      assert.deepEqual(
        ok(op(db, { kind: 'session.get', session_id: sessionId })),
        created,
      );
      assert.deepEqual(
        op(db, { kind: 'session.get', session_id: randomUUID() }),
        { ok: true, value: null },
      );
      // 形の不正（記録しない会話は保存しない）。
      assert.deepEqual(
        rejectedWith(
          op(db, {
            ...createSession(randomUUID()),
            storage_mode: 'private' as 'normal',
          }),
        ),
        ['storage_mode_invalid'],
      );
    });
  },
);

test(
  'a turn writes the turn, workflow, sealed input snapshot and receipt in one transaction',
  { timeout: 30_000 },
  async () => {
    await withStore((db) => {
      const sessionId = randomUUID();
      ok(op(db, createSession(sessionId)));
      const record = turn(sessionId);
      const value = ok(op(db, record));
      assert.deepEqual(value, {
        turn_id: record.turn_id,
        response_json: '{"synthetic":"none"}',
        replayed: false,
      });
      // 解釈の前の再送の判定: 保存した応答を返す。知らない要求は null、照合値の違いは request_conflict。
      assert.deepEqual(
        ok(op(db, { kind: 'turn.find', request: record.request })),
        {
          ...value,
          replayed: true,
        },
      );
      assert.deepEqual(op(db, { kind: 'turn.find', request: request() }), {
        ok: true,
        value: null,
      });
      assert.deepEqual(
        rejectedWith(
          op(db, {
            kind: 'turn.find',
            request: { ...record.request, request_hash: HASH_B },
          }),
        ),
        ['request_conflict'],
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT delete_at - created_at AS ttl FROM turn_responses WHERE turn_id = ?',
          )
          .get(record.turn_id),
        { ttl: 604_800_000 },
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT role, input_kind, expires_at - created_at AS ttl FROM turns WHERE turn_id = ?',
          )
          .get(record.turn_id),
        { role: 'user', input_kind: 'text', ttl: 604_800_000 },
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT purpose, owner_table, delete_at FROM sealed_blobs WHERE owner_id = ?',
          )
          .get(record.turn_id),
        {
          purpose: 'turn_text',
          owner_table: 'turns',
          delete_at: 3_000 + 604_800_000,
        },
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT current_request_revision AS rev, state FROM workflows WHERE workflow_id = ?',
          )
          .get(record.workflow?.workflow_id),
        { rev: 1, state: 'ready' },
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT request_revision, origin, state, seal_reason, input_evidence, permission_revision, forgetting_generation FROM input_snapshots WHERE input_id = ?',
          )
          .get(record.input_id),
        {
          request_revision: 1,
          origin: 'typed',
          state: 'sealed',
          seal_reason: 'submitted_text',
          input_evidence: 'submitted_text',
          permission_revision: 4,
          forgetting_generation: 0,
        },
      );
      // 同じ要求の再送: 保存済みの応答（新しい行を作らない）。
      const again = ok(op(db, { ...turn(sessionId), request: record.request }));
      assert.deepEqual(again, { ...value, replayed: true });
      assert.equal(count(db, 'turns'), 1);
      assert.equal(count(db, 'input_snapshots'), 1);
      // 照合値が違う: request_conflict。
      assert.deepEqual(
        rejectedWith(
          op(db, {
            ...turn(sessionId),
            request: { ...record.request, request_hash: HASH_B },
          }),
        ),
        ['request_conflict'],
      );
      // 知らない会話: 何も書かない（発言・依頼・入力・受付・暗号文）。
      const before = [
        'turns',
        'workflows',
        'input_snapshots',
        'command_receipts',
        'sealed_blobs',
      ].map((table) => count(db, table));
      assert.deepEqual(rejectedWith(op(db, turn(randomUUID()))), [
        'session_not_found',
      ]);
      assert.deepEqual(
        [
          'turns',
          'workflows',
          'input_snapshots',
          'command_receipts',
          'sealed_blobs',
        ].map((table) => count(db, table)),
        before,
      );
      // 依頼のない発言（聞き返し）: workflow を作らない。
      const unclear = turn(sessionId, { workflow: null });
      assert.equal(ok(op(db, unclear))['replayed'], false);
      assert.equal(count(db, 'workflows'), 1);
      // 依頼のない発言から操作は作らない（形の検査）。
      assert.deepEqual(
        rejectedWith(
          op(db, turn(sessionId, { workflow: null, operation: randomUUID() })),
        ),
        ['operation_without_workflow'],
      );
    });
  },
);

let clock = 10_000;
const run = (db: SqliteDatabase, command: DbCommand): StoreOutcome => {
  clock += 10;
  const result = executeCommand(db, command, storeContext(clock));
  assert.equal(result.halt, false);
  return result.outcome;
};
const committed = (outcome: StoreOutcome): string => {
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
  return outcome.outcome === 'durable' ? outcome.committed_state_revision : '';
};
const reasons = (outcome: StoreOutcome): readonly string[] => {
  assert.equal(outcome.outcome, 'rejected', JSON.stringify(outcome));
  return outcome.outcome === 'rejected' ? outcome.reasons : [];
};

const revise = (
  operationId: string,
  expected: string,
  options: { readonly version?: string; readonly hash?: string } = {},
): ReviseContentCommand => ({
  command_id: randomUUID(),
  kind: 'operation.revise_content',
  operation_id: operationId,
  expected_state_revision: expected,
  request_revision: null,
  permission_revision: '1',
  forgetting_generation: '0',
  connection_id: 'c-1',
  request: null,
  content_version: options.version ?? '2',
  content_hash: options.hash ?? OTHER_CONTENT_HASH,
  intent: sealedIntent(),
});

test(
  'a turn creates its operation in the same transaction, a resend never creates a second one and a failure writes nothing',
  { timeout: 30_000 },
  async () => {
    await withStore((db) => {
      const sessionId = randomUUID();
      ok(op(db, createSession(sessionId)));
      const operationId = randomUUID();
      const record = turn(sessionId, { operation: operationId });
      ok(op(db, record));
      assert.deepEqual(operationState(db, operationId), {
        state: 'awaiting_approval',
        state_revision: 1,
      });
      assert.equal(
        db
          .prepare('SELECT workflow_id FROM operations WHERE operation_id = ?')
          .pluck()
          .get(operationId),
        record.workflow?.workflow_id,
      );
      // 操作のイベントも同じ transaction（版 1）。
      assert.deepEqual(
        db
          .prepare(
            'SELECT target_id, state_revision FROM event_outbox WHERE target_id = ?',
          )
          .all(operationId),
        [{ target_id: operationId, state_revision: 1 }],
      );
      // 同じ要求の再送（別の操作 ID を計画していても）: 保存済みの応答で、操作は増えない。
      const resend = ok(
        op(db, {
          ...turn(sessionId, { operation: randomUUID() }),
          request: record.request,
        }),
      );
      assert.equal(resend['replayed'], true);
      assert.equal(resend['response_json'], record.response_json);
      assert.equal(count(db, 'operations'), 1);
      // 作成の途中で失敗（既にある操作 ID）: 発言・依頼・入力・応答・受付・暗号文のどれも書かない。
      const tables = [
        'turns',
        'workflows',
        'input_snapshots',
        'turn_responses',
        'command_receipts',
        'sealed_blobs',
        'operations',
        'event_outbox',
      ];
      const before = tables.map((table) => count(db, table));
      assert.deepEqual(
        rejectedWith(op(db, turn(sessionId, { operation: operationId }))),
        ['operation_exists'],
      );
      assert.deepEqual(
        tables.map((table) => count(db, table)),
        before,
      );
      const intent = record.operation?.intent;
      assert(intent !== undefined);
      const blob = ok(
        op(db, {
          kind: 'operation.intent',
          operation_id: operationId,
          content_version: '1',
        }),
      );
      assert.equal(blob['content_hash'], CONTENT_HASH);
      assert.equal(blob['key_id'], 'k-test');
      assert.deepEqual(
        Buffer.from(blob['ciphertext'] as Uint8Array),
        Buffer.from(intent.ciphertext),
      );
      assert.equal(
        (
          op(db, {
            kind: 'operation.intent',
            operation_id: operationId,
            content_version: '2',
          }) as { value: unknown }
        ).value,
        null,
      );
    });
  },
);

test(
  'D1: revising the content keeps the operation id, raises the content version and revokes the old approval',
  { timeout: 30_000 },
  async () => {
    await withStore((db) => {
      // 承認待ちからの更新: 版 2、承認待ち、state_revision 2。旧版の承認はない。
      committed(run(db, createCommand('op-a')));
      assert.equal(committed(run(db, revise('op-a', '1'))), '2');
      assert.deepEqual(operationState(db, 'op-a'), {
        state: 'awaiting_approval',
        state_revision: 2,
      });
      assert.equal(
        db
          .prepare(
            "SELECT current_content_version FROM operations WHERE operation_id = 'op-a'",
          )
          .pluck()
          .get(),
        2,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) FROM operation_versions WHERE operation_id = 'op-a'",
          )
          .pluck()
          .get(),
        2,
      );
      // 旧版の内容での承認は拒否する（内容版が違う）。
      assert.ok(
        reasons(run(db, approveCommand('op-a', '2'))).includes(
          'content_version_changed',
        ),
      );
      // 承認の後の更新: 旧版の承認は revoked、承認待ちへ戻る（D1）。
      committed(run(db, createCommand('op-b')));
      committed(run(db, approveCommand('op-b', '1')));
      assert.equal(effectiveApprovals(db, 'op-b'), 1);
      assert.equal(committed(run(db, revise('op-b', '2'))), '3');
      assert.deepEqual(operationState(db, 'op-b'), {
        state: 'awaiting_approval',
        state_revision: 3,
      });
      assert.equal(effectiveApprovals(db, 'op-b'), 0);
      assert.equal(
        db
          .prepare("SELECT status FROM approvals WHERE operation_id = 'op-b'")
          .pluck()
          .get(),
        'revoked',
      );
      // 内容が同じなら版を上げない。版の食い違い・古い状態版は拒否する。
      committed(run(db, createCommand('op-c')));
      assert.deepEqual(
        reasons(run(db, revise('op-c', '1', { hash: CONTENT_HASH }))),
        ['content_unchanged'],
      );
      assert.deepEqual(
        reasons(run(db, revise('op-c', '1', { version: '3' }))),
        ['content_version_changed'],
      );
      assert.deepEqual(reasons(run(db, revise('op-c', '0'))), [
        'state_revision_changed',
      ]);
      assert.deepEqual(
        reasons(run(db, revise('op-c', '1', { version: '1' }))),
        ['content_version_invalid'],
      );
      // 実行中の試行がある操作は、試行の superseded（B04-04）まで更新しない。
      committed(run(db, createCommand('op-d')));
      committed(run(db, approveCommand('op-d', '1')));
      committed(run(db, prepareCommand('op-d', '2')));
      assert.deepEqual(reasons(run(db, revise('op-d', '3'))), [
        'attempt_active',
      ]);
      assert.deepEqual(operationState(db, 'op-d'), {
        state: 'preparing',
        state_revision: 3,
      });
    });
  },
);
