// 復元の後の保留を作業用の DB に 1 つの transaction で書く（ADR 0047・0054）。承認の失効・隔離の印・端末と接続範囲の
// 失効・超過枠の失効・予約の使用量不明・安全停止・配備の格下げ・音声の世代と停止・Live の接続・再認証・同期の取り直し・
// DB の世代。期待値は手で書いた（どの操作に有効な承認が残るか・どの状態へ移るかは ADR 0040・0047 の表から写した）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applyRestoreAftermath, executeCommand } from './index.js';
import type {
  DbCommand,
  RestoreAftermathInput,
  SqliteDatabase,
} from './index.js';
import {
  STORE_GENERATION,
  approveCommand,
  cancelCommand,
  createCommand,
  databasePath,
  dispatchCommand,
  openSeededDatabase,
  prepareCommand,
  resultCommand,
  withTempDir,
} from './operation-test-support.js';

const RESTORED_AT = Date.parse('2031-03-01T00:00:00.000Z');
const BACKUP_AT = Date.parse('2031-02-20T00:00:00.000Z');
const NEW_GENERATION = 'abababab-abab-4bab-8bab-abababababab';

const op = (n: number): string =>
  `0a000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const A = op(1); // 承認待ち
const B = op(2); // 承認済み
const C = op(3); // 準備中
const D = op(4); // 送出中
const E = op(5); // 照合中
const F = op(6); // 結果不明
const G = op(7); // 未実行
const H = op(8); // 成功
const I = op(9); // 取消
const L1 = op(10); // LocalCommand の承認済み（承認が要る種類）
const L2 = op(11); // LocalCommand の承認済み（承認の要らない種類）

function ok(db: SqliteDatabase, command: DbCommand): void {
  const outcome = executeCommand(db, command, {
    now: 1_000_000,
    platform: 'macos',
    storeGeneration: STORE_GENERATION,
  }).outcome;
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
}

function remote(db: SqliteDatabase, id: string, path: readonly string[]): void {
  ok(db, createCommand(id));
  if (path.length === 0) return;
  ok(db, approveCommand(id, '1'));
  const attempt = `at-${id.slice(-2)}`;
  let revision = 2;
  for (const step of path.slice(1)) {
    if (step === 'preparing')
      ok(db, prepareCommand(id, String(revision), { attempt_id: attempt }));
    else if (step === 'dispatching')
      ok(db, dispatchCommand(id, String(revision), attempt));
    else
      ok(
        db,
        resultCommand(id, String(revision), attempt, step as 'reconciling'),
      );
    revision += 1;
  }
}

function seed(db: SqliteDatabase): void {
  remote(db, A, []);
  remote(db, B, ['approved']);
  remote(db, C, ['approved', 'preparing']);
  remote(db, D, ['approved', 'preparing', 'dispatching']);
  remote(db, E, ['approved', 'preparing', 'dispatching', 'reconciling']);
  remote(db, F, ['approved', 'preparing', 'dispatching', 'unknown_held']);
  remote(db, G, [
    'approved',
    'preparing',
    'dispatching',
    'reconciling',
    'not_executed',
  ]);
  remote(db, H, [
    'approved',
    'preparing',
    'dispatching',
    'reconciling',
    'succeeded',
  ]);
  ok(db, createCommand(I));
  ok(db, cancelCommand(I, '1'));
  for (const id of [L1, L2]) {
    ok(
      db,
      createCommand(id, { effect_route: 'local_command', connection_id: null }),
    );
    ok(db, approveCommand(id, '1', { connection_id: null }));
  }
  db.prepare(
    "UPDATE operations SET kind = 'memory.forget' WHERE operation_id = ?",
  ).run(L2);
  db.exec(`
    INSERT INTO devices VALUES ('dev-hub', '合成の中枢', 'macos', 1, X'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1000, NULL, NULL);
    INSERT INTO devices VALUES ('dev-old', '合成の旧端末', 'windows', 0, X'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 1000, NULL, 5000);
    INSERT INTO device_epochs (device_id, io_epoch, output_epoch, audio_epoch, session_epoch, local_stop, updated_at) VALUES ('dev-hub', 5, 5, 5, 5, 0, 1000);
    INSERT INTO command_scopes VALUES ('sc-1', 'dev-1', 'core-1', 1000, 2000, NULL);
    INSERT INTO budget_overage_approvals (approval_id, request_id, pool_id, budget_month, currency, max_liability, overage_remaining, status, requested_at, expires_at, decided_at) VALUES
      ('oa-p', 'rq-p', 'llm', '2031-02', 'JPY', 10, 10, 'pending', 1000, 9000, NULL),
      ('oa-a', 'rq-a', 'llm', '2031-02', 'JPY', 10, 10, 'approved', 1000, 9000, 2000),
      ('oa-r', 'rq-r', 'llm', '2031-02', 'JPY', 10, 10, 'rejected', 1000, 9000, 2000);
    INSERT INTO budget_reservations (reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, created_at) VALUES
      ('rs-1', 'rq-1', 'p', 'live', 'live', 'owner_request', '2031-02', 'JPY', 'v1', 5, 10, 'reserved', 1, 1000);
    INSERT INTO live_sessions (live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure, usage_seconds, reservation_id, started_at, ended_at, end_reason) VALUES
      ('ls-1', 'dev-1', NULL, 'conversation', 'ready', 2, 'open', NULL, 'rs-1', 1000, NULL, NULL);
    INSERT INTO safety_breaker VALUES (1, 'running', 3, NULL, NULL, NULL);
    INSERT INTO deployments VALUES ('dp-a', 'prof', 'active', '{}', 1000), ('dp-s', 'prof2', 'suspended', '{}', 1000);
    INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation, committed_watermark, provider_cursor, executor_generation) VALUES ('ss-1', 'c-1', 1, NULL, 1, 10, 'cursor-1', 1);
  `);
}

// 中枢が生きている（復元の前の DB がある）とき: 中枢と同じマシンの端末は失効していない。dev-1 の世代は復元した値より大きい。
const PRE: RestoreAftermathInput['pre_restore'] = {
  devices: [
    { device_id: 'dev-hub', hub_local: true, revoked_at: null },
    { device_id: 'dev-1', hub_local: false, revoked_at: null },
  ],
  device_epochs: [
    {
      device_id: 'dev-1',
      io_epoch: '9',
      output_epoch: '8',
      audio_epoch: '7',
      session_epoch: '6',
      local_stop: false,
    },
  ],
  io_stop: { guest_mode: true, global_stop: false },
  safety_revision: '7',
};

const INPUT: RestoreAftermathInput = {
  restored_at: RESTORED_AT,
  backup_created_at: BACKUP_AT,
  new_store_generation: NEW_GENERATION,
  pre_restore: PRE,
  approval_requirements: { 'memory.forget': 'none' },
};

async function withSeeded(run: (db: SqliteDatabase) => void): Promise<void> {
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

type Snapshot = Record<string, unknown>;

function snapshot(db: SqliteDatabase): Snapshot {
  const all = (sql: string): unknown[] => db.prepare(sql).all();
  return {
    operations: all(
      'SELECT operation_id, state, state_revision, restore_unverified_at, completed_at FROM operations ORDER BY operation_id',
    ),
    approvals: all(
      'SELECT approval_id, status FROM approvals ORDER BY approval_id',
    ),
    attempts: all(
      'SELECT attempt_id, status FROM operation_attempts ORDER BY attempt_id',
    ),
    devices: all(
      'SELECT device_id, revoked_at FROM devices ORDER BY device_id',
    ),
    scopes: all('SELECT command_scope_id, revoked_at FROM command_scopes'),
    overage: all(
      'SELECT approval_id, status FROM budget_overage_approvals ORDER BY approval_id',
    ),
    reservations: all('SELECT reservation_id, status FROM budget_reservations'),
    safety: all('SELECT * FROM safety_breaker'),
    deployments: all(
      'SELECT deployment_id, stage FROM deployments ORDER BY deployment_id',
    ),
    epochs: all('SELECT * FROM device_epochs ORDER BY device_id'),
    io: all('SELECT * FROM io_stop_state'),
    live: all('SELECT * FROM live_sessions'),
    connections: all('SELECT connection_id, status FROM connections'),
    sync: all(
      'SELECT scope_id, provider_cursor, pending_full, committed_watermark FROM sync_scopes',
    ),
    meta: all(
      "SELECT key, value FROM schema_meta WHERE key NOT GLOB 'migration_sha256:*' ORDER BY key",
    ),
  };
}

test('restore aftermath: every reset is written in one transaction (hand-written expectations)', async () => {
  await withSeeded((db) => {
    assert.equal(
      db
        .prepare("SELECT count(*) FROM approvals WHERE status = 'valid'")
        .pluck()
        .get(),
      8,
    );
    const result = applyRestoreAftermath(db, INPUT);
    assert.deepEqual(result, {
      approvals_revoked_count: 8,
      operations_held_count: 5,
      operations_unverified_count: 7,
      local_operations_reset_count: 2,
      devices_revoked_count: 2,
      command_scopes_revoked_count: 1,
      overage_approvals_expired_count: 2,
      budget_reservations_unknown_count: 1,
      deployments_demoted_count: 1,
      live_sessions_closed_count: 1,
      connections_reauth_count: 1,
      sync_scopes_reset_count: 1,
      safety_revision: '8',
    });
    const after = snapshot(db);
    const ops = after['operations'] as {
      operation_id: string;
      state: string;
      restore_unverified_at: number | null;
      completed_at: number | null;
    }[];
    const byId = new Map(ops.map((row) => [row.operation_id, row]));
    const expected: [string, string, boolean][] = [
      [A, 'awaiting_approval', true],
      [B, 'unknown_held', true],
      [C, 'unknown_held', true],
      [D, 'unknown_held', true],
      [E, 'unknown_held', true],
      [F, 'unknown_held', true],
      [G, 'not_executed', true],
      [H, 'succeeded', false],
      [I, 'cancelled', false],
      [L1, 'awaiting_approval', false],
      [L2, 'cancelled', false],
    ];
    for (const [id, state, marked] of expected) {
      assert.equal(byId.get(id)?.state, state, id);
      assert.equal(
        byId.get(id)?.restore_unverified_at,
        marked ? RESTORED_AT : null,
        id,
      );
    }
    assert.equal(byId.get(L2)?.completed_at, RESTORED_AT);
    assert.equal(
      db
        .prepare("SELECT count(*) FROM approvals WHERE status = 'valid'")
        .pluck()
        .get(),
      0,
    );
    // 実行中の試行を残さない（送出の境界の前は置き換え済み、後は結果不明。どちらも再送しない）。
    assert.deepEqual(after['attempts'], [
      { attempt_id: 'at-03', status: 'superseded' },
      { attempt_id: 'at-04', status: 'unknown_held' },
      { attempt_id: 'at-05', status: 'unknown_held' },
      { attempt_id: 'at-06', status: 'unknown_held' },
      { attempt_id: 'at-07', status: 'not_executed' },
      { attempt_id: 'at-08', status: 'succeeded' },
    ]);
    assert.deepEqual(after['devices'], [
      { device_id: 'dev-1', revoked_at: RESTORED_AT },
      { device_id: 'dev-2', revoked_at: RESTORED_AT },
      { device_id: 'dev-hub', revoked_at: null },
      { device_id: 'dev-old', revoked_at: 5000 },
    ]);
    assert.deepEqual(after['scopes'], [
      { command_scope_id: 'sc-1', revoked_at: RESTORED_AT },
    ]);
    assert.deepEqual(after['overage'], [
      { approval_id: 'oa-a', status: 'expired' },
      { approval_id: 'oa-p', status: 'expired' },
      { approval_id: 'oa-r', status: 'rejected' },
    ]);
    assert.deepEqual(after['reservations'], [
      { reservation_id: 'rs-1', status: 'usage_unknown' },
    ]);
    assert.deepEqual(after['safety'], [
      {
        singleton: 1,
        state: 'stopped',
        safety_revision: 8,
        stop_reason: 'restored_from_backup',
        stopped_at: RESTORED_AT,
        resumed_by_device_id: null,
      },
    ]);
    assert.deepEqual(after['deployments'], [
      { deployment_id: 'dp-a', stage: 'evaluated' },
      { deployment_id: 'dp-s', stage: 'suspended' },
    ]);
    // 世代は復元した値と復元の前の値の大きい方より 1 つ進み、端末ごとの停止が立つ。行のない端末は作る。
    assert.deepEqual(after['epochs'], [
      {
        device_id: 'dev-1',
        io_epoch: 10,
        output_epoch: 9,
        audio_epoch: 8,
        session_epoch: 7,
        local_stop: 1,
        updated_at: RESTORED_AT,
      },
      {
        device_id: 'dev-2',
        io_epoch: 1,
        output_epoch: 1,
        audio_epoch: 1,
        session_epoch: 1,
        local_stop: 1,
        updated_at: RESTORED_AT,
      },
      {
        device_id: 'dev-hub',
        io_epoch: 6,
        output_epoch: 6,
        audio_epoch: 6,
        session_epoch: 6,
        local_stop: 1,
        updated_at: RESTORED_AT,
      },
      {
        device_id: 'dev-old',
        io_epoch: 1,
        output_epoch: 1,
        audio_epoch: 1,
        session_epoch: 1,
        local_stop: 1,
        updated_at: RESTORED_AT,
      },
    ]);
    assert.deepEqual(after['io'], [
      { stop_id: 1, guest_mode: 1, global_stop: 1, updated_at: RESTORED_AT },
    ]);
    assert.deepEqual(
      (after['live'] as Record<string, unknown>[]).map((row) => [
        row['control_state'],
        row['control_epoch'],
        row['closure'],
        row['usage_seconds'],
        row['ended_at'],
        row['end_reason'],
      ]),
      [
        [
          'closed',
          3,
          'close_unconfirmed',
          null,
          RESTORED_AT,
          'core_lease_lost',
        ],
      ],
    );
    assert.deepEqual(after['connections'], [
      { connection_id: 'c-1', status: 'needs_reauth' },
    ]);
    assert.deepEqual(after['sync'], [
      {
        scope_id: 'ss-1',
        provider_cursor: null,
        pending_full: 1,
        committed_watermark: 10,
      },
    ]);
    assert.deepEqual(after['meta'], [
      { key: 'restore_backup_created_at', value: String(BACKUP_AT) },
      { key: 'restore_restored_at', value: String(RESTORED_AT) },
      { key: 'schema_version', value: '12' },
      { key: 'store_generation', value: NEW_GENERATION },
    ]);
    // 隔離の印のある操作は、承認・準備へ進めない（DB の最後の保証）。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET state = 'approved' WHERE operation_id = ?",
          )
          .run(A),
      /operation_restore_unverified/u,
    );
  });
});

test('restore aftermath: a failure anywhere leaves the working DB unchanged (one transaction)', async () => {
  await withSeeded((db) => {
    const before = snapshot(db);
    assert.throws(
      () =>
        applyRestoreAftermath(db, INPUT, {
          beforeCommit: () => {
            throw new Error('注入した失敗（COMMIT の前）');
          },
        }),
      /注入した失敗/u,
    );
    assert.deepEqual(snapshot(db), before);
    // DB の世代を新しくしない・計画できない操作がある: 何も書かない。
    assert.throws(
      () =>
        applyRestoreAftermath(db, {
          ...INPUT,
          new_store_generation: STORE_GENERATION,
        }),
      /store_generation_not_renewed/u,
    );
    assert.deepEqual(snapshot(db), before);
    ok(db, createCommand('not-a-uuid'));
    const withBad = snapshot(db);
    assert.throws(() => applyRestoreAftermath(db, INPUT), /operation_invalid/u);
    assert.deepEqual(snapshot(db), withBad);
  });
});

test('restore aftermath: when the hub is lost, the hub_local device is revoked too and epochs advance from the restored value', async () => {
  await withSeeded((db) => {
    const result = applyRestoreAftermath(db, {
      ...INPUT,
      pre_restore: null,
      new_store_generation: randomUUID(),
    });
    assert.equal(result.devices_revoked_count, 3);
    assert.equal(result.safety_revision, '4');
    assert.equal(
      db
        .prepare("SELECT revoked_at FROM devices WHERE device_id = 'dev-hub'")
        .pluck()
        .get(),
      RESTORED_AT,
    );
    assert.equal(
      db
        .prepare("SELECT io_epoch FROM device_epochs WHERE device_id = 'dev-1'")
        .pluck()
        .get(),
      1,
    );
    assert.equal(
      db.prepare('SELECT guest_mode FROM io_stop_state').pluck().get(),
      0,
    );
  });
});
