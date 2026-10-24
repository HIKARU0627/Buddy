// マイグレーション 0010 の制約（ADR 0048）: 予算の記録の delete_at と月ごとの削除、派生物の系譜、記録しない会話の
// 操作の印、復元の後の未確認の印。期待値は手で書き、実装の処理から作っていない。DB はメモリ上に作る。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FORGET_ARTIFACT_KINDS } from '@buddy/domain';
import {
  applyMigrations,
  executeBudgetOp,
  openWriteConnection,
  readDerivationsBySource,
  writeDerivation,
} from './index.js';
import type { SqliteDatabase } from './index.js';

const MONTH = '2030-10';
// 予算月 2030-10（UTC）の締めは 2030-11-01。13 か月後は 2031-12-01（ADR 0043 の budgetRecordDeleteAt）。
const DELETE_AT = Date.parse('2031-12-01T00:00:00Z');
const HASH = '1'.repeat(64);
const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function withDb(run: (db: SqliteDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-retention-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'linux',
  });
  try {
    applyMigrations(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertMonth(
  db: SqliteDatabase,
  month = MONTH,
  timeZone = 'UTC',
  monthStart = Date.UTC(2030, 9, 1),
): void {
  db.prepare(
    'INSERT INTO budget_months (month, time_zone, month_start, month_start_time_zone, recorded_at) VALUES (?, ?, ?, ?, 1)',
  ).run(month, timeZone, monthStart, timeZone);
}

interface ReservationInput {
  readonly id: string;
  readonly request: string;
  readonly status: 'reserved' | 'usage_unknown' | 'settled' | 'released';
  readonly month?: string;
  readonly max?: number;
  readonly actual?: number;
  readonly reviewed?: boolean;
  readonly deleteAt?: number | null;
  readonly approvalId?: string | null;
}

function insertReservation(db: SqliteDatabase, input: ReservationInput): void {
  const settled = input.status === 'settled';
  const actual = input.actual ?? 0;
  db.prepare(
    `INSERT INTO budget_reservations (
      reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month,
      currency, price_version, reserved_amount, max_liability, status, reservation_revision,
      approval_id, actual_gross, credit_applied, additional_spend, provider_reconciliation_id, settlement_kind,
      credit_cycle_id, settled_at, overrun_reviewed, overrun_reviewed_at, created_at, delete_at
    ) VALUES (?, ?, 'claude.synthetic.v1', 'llm', 'llm', 'owner_request', ?, 'XTS', 'price-1', 0, ?, ?, 1,
      ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1000, ?)`,
  ).run(
    input.id,
    input.request,
    input.month ?? MONTH,
    input.max ?? 20,
    input.status,
    input.approvalId ?? null,
    settled ? actual : null,
    settled ? 0 : null,
    settled ? actual : null,
    settled ? `anthropic:${input.request}` : null,
    settled ? 'provider' : null,
    settled ? 1500 : null,
    input.reviewed === true ? 1 : 0,
    settled && input.reviewed === true ? 1600 : null,
    input.deleteAt ?? null,
  );
}

function insertDevice(db: SqliteDatabase): void {
  db.prepare(
    "INSERT INTO devices (device_id, device_name, platform, hub_local, token_hash, registered_at) VALUES ('dev-1', 'd', 'macos', 0, X'0000000000000000000000000000000000000000000000000000000000000000', 1000)",
  ).run();
}

function insertLiveSession(
  db: SqliteDatabase,
  id: string,
  reservationId: string,
): void {
  db.prepare(
    "INSERT INTO live_sessions (live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure, usage_seconds, reservation_id, started_at, ended_at, end_reason, audio_epoch, session_epoch) VALUES (?, 'dev-1', NULL, 'conversation', 'ready', 1, 'open', NULL, ?, 1000, NULL, NULL, 0, 0)",
  ).run(id, reservationId);
}

function insertConsumedApproval(
  db: SqliteDatabase,
  approvalId: string,
  reservationId: string,
  request: string,
): void {
  db.prepare(
    "INSERT INTO budget_overage_approvals (approval_id, request_id, pool_id, budget_month, currency, max_liability, overage_remaining, status, requested_at, expires_at, decided_at, consumed_at, consumed_reservation_id) VALUES (?, ?, 'llm', ?, 'XTS', 20, 0, 'consumed', 900, 5000, 1000, 1100, ?)",
  ).run(approvalId, request, MONTH, reservationId);
}

function insertUnusedApproval(
  db: SqliteDatabase,
  approvalId: string,
  request: string,
): void {
  db.prepare(
    "INSERT INTO budget_overage_approvals (approval_id, request_id, pool_id, budget_month, currency, max_liability, overage_remaining, status, requested_at, expires_at, decided_at, consumed_at, consumed_reservation_id) VALUES (?, ?, 'llm', ?, 'XTS', 20, 0, 'rejected', 900, 5000, 1000, NULL, NULL)",
  ).run(approvalId, request, MONTH);
}

function budgetResult(db: SqliteDatabase, op: unknown) {
  return executeBudgetOp(db, op as never, {
    platform: 'linux',
    halted: false,
  }).result;
}

function counts(db: SqliteDatabase): {
  reservations: number;
  live: number;
  approvals: number;
} {
  const count = (table: string): number =>
    db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
  return {
    reservations: count('budget_reservations'),
    live: count('live_sessions'),
    approvals: count('budget_overage_approvals'),
  };
}

test('settling, releasing and confirming an overrun write the month-close deadline into delete_at', () => {
  withDb((db) => {
    insertMonth(db);
    insertReservation(db, {
      id: uuid(1),
      request: uuid(2),
      status: 'reserved',
      max: 20,
    });
    insertReservation(db, {
      id: uuid(3),
      request: uuid(4),
      status: 'reserved',
      max: 20,
    });
    insertReservation(db, {
      id: uuid(5),
      request: uuid(6),
      status: 'reserved',
      max: 20,
    });

    assert.equal(
      budgetResult(db, {
        kind: 'budget.settle',
        reservation_id: uuid(1),
        request_id: uuid(2),
        provider: 'anthropic',
        provider_reconciliation_id: 'p-settle',
        actual_gross: '15',
        now: 2000,
      }).ok,
      true,
    );
    assert.equal(
      budgetResult(db, {
        kind: 'budget.release_unsent',
        reservation_id: uuid(3),
        provider_request_sent: false,
      }).ok,
      true,
    );
    // M を超えた精算では delete_at を書かない。本人の確認（review_overrun）で書く。
    assert.equal(
      budgetResult(db, {
        kind: 'budget.settle',
        reservation_id: uuid(5),
        request_id: uuid(6),
        provider: 'anthropic',
        provider_reconciliation_id: 'p-overrun',
        actual_gross: '30',
        now: 2000,
      }).ok,
      true,
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT reservation_id, delete_at FROM budget_reservations ORDER BY reservation_id',
        )
        .all(),
      [
        { reservation_id: uuid(1), delete_at: DELETE_AT },
        { reservation_id: uuid(3), delete_at: DELETE_AT },
        { reservation_id: uuid(5), delete_at: null },
      ],
    );
    assert.equal(
      budgetResult(db, {
        kind: 'budget.review_overrun',
        reservation_id: uuid(5),
        expected_revision: '1',
        currency: 'XTS',
        actual_gross: '30',
        max_liability: '20',
        now: 2100,
        request: null,
      }).ok,
      true,
    );
    assert.equal(
      db
        .prepare(
          'SELECT delete_at FROM budget_reservations WHERE reservation_id = ?',
        )
        .pluck()
        .get(uuid(5)),
      DELETE_AT,
    );
  });
});

test('delete_at follows the month close in Asia/Tokyo and America/New_York (hand-written values)', () => {
  // 2030-10 の締め（東京）は 2030-10-31T15:00:00Z。13 か月後は 2031-11-30T15:00:00Z。
  // 2030-03 の締め（ニューヨーク、夏時間）は 2030-04-01T04:00:00Z。13 か月後は 2031-05-01T04:00:00Z。
  const cases = [
    {
      month: '2030-10',
      timeZone: 'Asia/Tokyo',
      monthStart: Date.UTC(2030, 9, 1),
      expected: '2031-11-30T15:00:00Z',
    },
    {
      month: '2030-03',
      timeZone: 'America/New_York',
      // 2030-03-01 00:00 ニューヨーク（EST、UTC−5）は 05:00Z。
      monthStart: Date.UTC(2030, 2, 1, 5),
      expected: '2031-05-01T04:00:00Z',
    },
  ] as const;
  for (const [index, item] of cases.entries()) {
    withDb((db) => {
      const id = uuid(100 + index);
      const request = uuid(200 + index);
      insertMonth(db, item.month, item.timeZone, item.monthStart);
      insertReservation(db, {
        id,
        request,
        status: 'reserved',
        month: item.month,
      });
      assert.equal(
        budgetResult(db, {
          kind: 'budget.settle',
          reservation_id: id,
          request_id: request,
          provider: 'anthropic',
          provider_reconciliation_id: `p-tz-${index}`,
          actual_gross: '15',
          now: 2000,
        }).ok,
        true,
      );
      assert.equal(
        db
          .prepare(
            'SELECT delete_at FROM budget_reservations WHERE reservation_id = ?',
          )
          .pluck()
          .get(id),
        Date.parse(item.expected),
      );
    });
  }
});

test('a reservation without delete_at cannot be deleted (DB final guard)', () => {
  withDb((db) => {
    insertMonth(db);
    insertReservation(db, {
      id: uuid(7),
      request: uuid(8),
      status: 'reserved',
    });
    assert.throws(
      () =>
        db
          .prepare('DELETE FROM budget_reservations WHERE reservation_id = ?')
          .run(uuid(7)),
      /budget_delete_at_missing/u,
    );
    // 消してよい状態でない行には delete_at を書けない（DB の最終ガード）。
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE budget_reservations SET delete_at = ? WHERE reservation_id = ?',
          )
          .run(DELETE_AT, uuid(7)),
      /budget_delete_at_invalid/u,
    );
    // 作った時刻から 364 日より前の期限は早すぎる（月の締めから 13 か月後は、どの月でも 395 日以上ある）。
    insertReservation(db, {
      id: uuid(9),
      request: uuid(10),
      status: 'settled',
      actual: 10,
    });
    const earliest = 1000 + 364 * 86400000;
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE budget_reservations SET delete_at = ? WHERE reservation_id = ?',
          )
          .run(earliest - 1, uuid(9)),
      /budget_delete_at_invalid/u,
    );
    db.prepare(
      'UPDATE budget_reservations SET delete_at = ? WHERE reservation_id = ?',
    ).run(earliest, uuid(9));
    assert.equal(
      db
        .prepare(
          'SELECT delete_at FROM budget_reservations WHERE reservation_id = ?',
        )
        .pluck()
        .get(uuid(9)),
      earliest,
    );
  });
});

test('a deletable month is purged in one transaction with foreign keys intact', () => {
  withDb((db) => {
    insertMonth(db);
    insertDevice(db);
    insertReservation(db, {
      id: uuid(11),
      request: uuid(12),
      status: 'settled',
      actual: 10,
      approvalId: 'ap-1',
      deleteAt: DELETE_AT,
    });
    insertReservation(db, {
      id: uuid(13),
      request: uuid(14),
      status: 'released',
      deleteAt: DELETE_AT,
    });
    insertLiveSession(db, 'ls-1', uuid(11));
    insertConsumedApproval(db, 'ap-1', uuid(11), uuid(12));
    insertUnusedApproval(db, 'ap-2', uuid(14));
    db.prepare(
      "INSERT INTO budget_credit_observations (cycle_id, cycle_start, observed_at, expires_at, status, shared, organization_ref, balance_currency, balance_amount, content_id, recorded_at) VALUES ('anthropic:2030-10-01', 0, 1000, 5000, 'observed', 0, 'synthetic', 'XTS', 10, ?, 1)",
    ).run(HASH);

    const result = budgetResult(db, {
      kind: 'budget.purge_month',
      budget_month: MONTH,
      now: DELETE_AT,
    });
    assert.deepEqual(result, {
      ok: true,
      value: {
        budget_month: MONTH,
        deleted_live_sessions: 1,
        deleted_approvals: 2,
        deleted_reservations: 2,
      },
    });
    assert.deepEqual(counts(db), {
      reservations: 0,
      live: 0,
      approvals: 0,
    });
    // 予算月・確かめ直し・クレジットの観測は消さない。
    assert.equal(
      db.prepare('SELECT count(*) FROM budget_months').pluck().get(),
      1,
    );
    assert.equal(
      db
        .prepare('SELECT count(*) FROM budget_credit_observations')
        .pluck()
        .get(),
      1,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  });
});

test('one open row keeps the whole month, and a future delete_at keeps it too', () => {
  withDb((db) => {
    insertMonth(db);
    insertReservation(db, {
      id: uuid(21),
      request: uuid(22),
      status: 'released',
      deleteAt: DELETE_AT,
    });
    insertReservation(db, {
      id: uuid(23),
      request: uuid(24),
      status: 'reserved',
    });
    assert.deepEqual(
      budgetResult(db, {
        kind: 'budget.purge_month',
        budget_month: MONTH,
        now: DELETE_AT,
      }),
      { ok: false, outcome: 'rejected', reasons: ['month_has_open_rows'] },
    );
    assert.deepEqual(counts(db), {
      reservations: 2,
      live: 0,
      approvals: 0,
    });
  });
  withDb((db) => {
    insertMonth(db);
    insertReservation(db, {
      id: uuid(25),
      request: uuid(26),
      status: 'released',
      deleteAt: DELETE_AT,
    });
    insertReservation(db, {
      id: uuid(27),
      request: uuid(28),
      status: 'released',
      deleteAt: DELETE_AT + 1,
    });
    assert.deepEqual(
      budgetResult(db, {
        kind: 'budget.purge_month',
        budget_month: MONTH,
        now: DELETE_AT,
      }),
      { ok: false, outcome: 'rejected', reasons: ['not_due'] },
    );
    assert.deepEqual(counts(db), {
      reservations: 2,
      live: 0,
      approvals: 0,
    });
  });
});

test('INSERT OR REPLACE cannot get around the delete guard for reservations', () => {
  withDb((db) => {
    insertMonth(db);
    insertReservation(db, {
      id: uuid(30),
      request: uuid(31),
      status: 'settled',
      actual: 10,
      deleteAt: DELETE_AT,
    });
    // 承認（approval_id）は、0006 の部分 UNIQUE 索引で 1 つの予約にだけ結び付く。
    insertReservation(db, {
      id: uuid(35),
      request: uuid(36),
      status: 'settled',
      actual: 10,
      approvalId: 'ap-1',
      deleteAt: DELETE_AT,
    });
    const replace = db.prepare(
      `INSERT OR REPLACE INTO budget_reservations (
        reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month,
        currency, price_version, reserved_amount, max_liability, status, reservation_revision,
        approval_id, actual_gross, credit_applied, additional_spend, provider_reconciliation_id, settlement_kind,
        credit_cycle_id, settled_at, overrun_reviewed, overrun_reviewed_at, created_at, delete_at
      ) VALUES (?, ?, 'claude.synthetic.v1', 'llm', 'llm', 'owner_request', ?, 'XTS', 'price-1', 0, 20,
        'settled', 1, ?, 10, 0, 10, ?, 'provider', NULL, 1500, 0, NULL, 1000, ?)`,
    );
    // 予約 ID・要求 ID・照合 ID のどれかが既存の行と衝突したら、置き換えない。
    for (const [id, request, provider] of [
      [uuid(30), uuid(32), `anthropic:${uuid(32)}`],
      [uuid(33), uuid(31), `anthropic:${uuid(33)}`],
      [uuid(34), uuid(34), `anthropic:${uuid(31)}`],
    ]) {
      assert.throws(
        () => replace.run(id, request, MONTH, null, provider, DELETE_AT),
        /budget_reservation_replace/u,
      );
    }
    // 承認（approval_id）だけが既存の行と衝突する場合も置き換えない。
    assert.throws(
      () =>
        replace.run(
          uuid(37),
          uuid(38),
          MONTH,
          'ap-1',
          `anthropic:${uuid(38)}`,
          DELETE_AT,
        ),
      /budget_reservation_replace/u,
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT reservation_id, request_id, provider_reconciliation_id, approval_id, delete_at FROM budget_reservations ORDER BY reservation_id',
        )
        .all(),
      [
        {
          reservation_id: uuid(30),
          request_id: uuid(31),
          provider_reconciliation_id: `anthropic:${uuid(31)}`,
          approval_id: null,
          delete_at: DELETE_AT,
        },
        {
          reservation_id: uuid(35),
          request_id: uuid(36),
          provider_reconciliation_id: `anthropic:${uuid(36)}`,
          approval_id: 'ap-1',
          delete_at: DELETE_AT,
        },
      ],
    );
  });
});

// 期限が来ても消さない月（使用量不明・M 超過の確認待ち・予算月の記録なし・期限の 1 ms 前）。
test('purge_month refuses months with unknown usage, an unreviewed overrun, no month record or one millisecond early', () => {
  withDb((db) => {
    insertMonth(db);
    insertReservation(db, {
      id: uuid(40),
      request: uuid(41),
      status: 'usage_unknown',
    });
    assert.deepEqual(
      budgetResult(db, {
        kind: 'budget.purge_month',
        budget_month: MONTH,
        now: DELETE_AT,
      }),
      { ok: false, outcome: 'rejected', reasons: ['month_has_open_rows'] },
    );
    assert.equal(
      db.prepare('SELECT count(*) FROM budget_reservations').pluck().get(),
      1,
    );
  });
  withDb((db) => {
    insertMonth(db);
    insertReservation(db, {
      id: uuid(42),
      request: uuid(43),
      status: 'settled',
      max: 20,
      actual: 30,
    });
    assert.deepEqual(
      budgetResult(db, {
        kind: 'budget.purge_month',
        budget_month: MONTH,
        now: DELETE_AT,
      }),
      { ok: false, outcome: 'rejected', reasons: ['month_has_open_rows'] },
    );
    assert.equal(
      db.prepare('SELECT count(*) FROM budget_reservations').pluck().get(),
      1,
    );
  });
  withDb((db) => {
    insertReservation(db, {
      id: uuid(44),
      request: uuid(45),
      status: 'released',
      deleteAt: DELETE_AT,
    });
    assert.deepEqual(
      budgetResult(db, {
        kind: 'budget.purge_month',
        budget_month: MONTH,
        now: DELETE_AT,
      }),
      { ok: false, outcome: 'rejected', reasons: ['calendar_invalid'] },
    );
    assert.equal(
      db.prepare('SELECT count(*) FROM budget_reservations').pluck().get(),
      1,
    );
  });
  withDb((db) => {
    insertMonth(db);
    insertReservation(db, {
      id: uuid(46),
      request: uuid(47),
      status: 'released',
      deleteAt: DELETE_AT,
    });
    assert.deepEqual(
      budgetResult(db, {
        kind: 'budget.purge_month',
        budget_month: MONTH,
        now: DELETE_AT - 1,
      }),
      { ok: false, outcome: 'rejected', reasons: ['not_due'] },
    );
    assert.equal(
      db.prepare('SELECT count(*) FROM budget_reservations').pluck().get(),
      1,
    );
  });
});

test('private_minimal operations cannot carry a workflow, and record_kind is limited', () => {
  withDb((db) => {
    db.prepare(
      "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES ('s-1', 'normal', NULL, 1, NULL, 1000, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO workflows (workflow_id, session_id, current_request_revision, state, updated_at) VALUES ('w-1', 's-1', 1, 'ready', 1000)",
    ).run();
    const insert = (
      id: string,
      recordKind: string,
      workflowId: string | null,
    ) =>
      db
        .prepare(
          "INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at, record_kind) VALUES (?, ?, 'mail.labels.change', 'remote_mutation', 1, 'awaiting_approval', 0, 1000, NULL, ?)",
        )
        .run(id, workflowId, recordKind);
    assert.throws(
      () => insert('op-private', 'private_minimal', 'w-1'),
      /operation_private_minimal_workflow/u,
    );
    insert('op-private-ok', 'private_minimal', null);
    insert('op-normal', 'normal', 'w-1');
    insert('op-linked', 'normal', null);
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET record_kind = 'private_minimal' WHERE operation_id = 'op-normal'",
          )
          .run(),
      /operation_private_minimal_workflow/u,
    );
    // 逆向き（private_minimal → normal）は拒否する。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET record_kind = 'normal' WHERE operation_id = 'op-private-ok'",
          )
          .run(),
      /operation_record_kind_fixed/u,
    );
    // private_minimal の操作は、依頼と操作の結び付け（自動作成の一度だけの記録）に使わない。
    db.prepare(
      "INSERT INTO request_entities VALUES ('re-1', 'acct-1', 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO request_entity_operations VALUES ('re-1', 'label_mail', 'acct-1', '', 'op-private-ok')",
          )
          .run(),
      /operation_private_minimal_request_entity/u,
    );
    db.prepare(
      "INSERT INTO request_entity_operations VALUES ('re-1', 'label_mail', 'acct-1', '', 'op-normal')",
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE request_entity_operations SET operation_id = 'op-private-ok' WHERE operation_id = 'op-normal'",
          )
          .run(),
      /operation_private_minimal_request_entity/u,
    );
    // 依頼と操作の結び付けに使った操作は、workflow がなくても private_minimal に変えられない
    // （結び付けを残したまま、記録しない会話の操作にしない）。
    db.prepare(
      "INSERT INTO request_entities VALUES ('re-2', 'acct-1', 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO request_entity_operations VALUES ('re-2', 'label_mail', 'acct-1', '', 'op-linked')",
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET record_kind = 'private_minimal' WHERE operation_id = 'op-linked'",
          )
          .run(),
      /operation_record_kind_fixed/u,
    );
    assert.throws(
      () => insert('op-bad', 'private', null),
      /CHECK constraint failed/u,
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT operation_id, record_kind, workflow_id FROM operations ORDER BY operation_id',
        )
        .all(),
      [
        {
          operation_id: 'op-linked',
          record_kind: 'normal',
          workflow_id: null,
        },
        {
          operation_id: 'op-normal',
          record_kind: 'normal',
          workflow_id: 'w-1',
        },
        {
          operation_id: 'op-private-ok',
          record_kind: 'private_minimal',
          workflow_id: null,
        },
      ],
    );
  });
});

test('a restore-unverified operation rejects approvals, approved/preparing transitions and attempts', () => {
  withDb((db) => {
    db.prepare(
      "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES ('b-1', 'operation_intent', 'operation_versions', 'op-r', 1, 1, 'k1', X'000000000000000000000001', X'00', X'00000000000000000000000000000000', 1000, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES ('b-2', 'operation_intent', 'operation_versions', 'op-r3', 1, 1, 'k1', X'000000000000000000000002', X'00', X'00000000000000000000000000000000', 1000, NULL)",
    ).run();
    const insertOp = (
      id: string,
      state: string,
      marked: number | null,
      recordKind = 'normal',
    ) =>
      db
        .prepare(
          "INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at, record_kind, restore_unverified_at) VALUES (?, NULL, 'mail.labels.change', 'remote_mutation', 1, ?, 0, 1000, NULL, ?, ?)",
        )
        .run(id, state, recordKind, marked);
    insertOp('op-r', 'awaiting_approval', 2000);
    // 印のある操作は INSERT OR REPLACE で入れ替えない（印・状態・記録の種類を消さない）。
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT OR REPLACE INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at, record_kind, restore_unverified_at) VALUES ('op-r', NULL, 'mail.labels.change', 'remote_mutation', 1, 'awaiting_approval', 0, 1000, NULL, 'normal', NULL)",
          )
          .run(),
      /operation_replace/u,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT state, restore_unverified_at FROM operations WHERE operation_id = 'op-r'",
        )
        .get(),
      { state: 'awaiting_approval', restore_unverified_at: 2000 },
    );
    // 印を付けられるのは remote_mutation の操作だけ（挿入でも更新でも拒否する）。
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at, record_kind, restore_unverified_at) VALUES ('op-local', NULL, 'task.create', 'local_command', 1, 'awaiting_approval', 0, 1000, NULL, 'normal', 2000)",
          )
          .run(),
      /operation_restore_unverified_route/u,
    );
    db.prepare(
      "INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at, record_kind, restore_unverified_at) VALUES ('op-local-2', NULL, 'task.create', 'local_command', 1, 'awaiting_approval', 0, 1000, NULL, 'normal', NULL)",
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET restore_unverified_at = 2000 WHERE operation_id = 'op-local-2'",
          )
          .run(),
      /operation_restore_unverified_route/u,
    );
    db.prepare(
      "INSERT INTO operation_versions (operation_id, content_version, content_hash, intent_blob_id, created_at) VALUES ('op-r', 1, ?, 'b-1', 1000)",
    ).run(HASH);
    // 1. 承認の作成。
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at) VALUES ('ap-r', 'op-r', 1, ?, 'policy_auto', NULL, NULL, 3, 'valid', 1000)",
          )
          .run(HASH),
      /operation_restore_unverified/u,
    );
    // 2. approved・preparing への遷移。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET state = 'approved' WHERE operation_id = 'op-r'",
          )
          .run(),
      /operation_restore_unverified/u,
    );
    insertOp('op-r2', 'approved', 2000);
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET state = 'preparing' WHERE operation_id = 'op-r2'",
          )
          .run(),
      /operation_restore_unverified/u,
    );
    // 送出の手前（dispatching）へも進めない。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operations SET state = 'dispatching' WHERE operation_id = 'op-r2'",
          )
          .run(),
      /operation_restore_unverified/u,
    );
    // 3. 試行の作成（承認は印を付ける前に作っておく）。
    insertOp('op-r3', 'preparing', null);
    db.prepare(
      "INSERT INTO operation_versions (operation_id, content_version, content_hash, intent_blob_id, created_at) VALUES ('op-r3', 1, ?, 'b-2', 1000)",
    ).run(HASH);
    db.prepare(
      "INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at) VALUES ('ap-r3', 'op-r3', 1, ?, 'policy_auto', NULL, NULL, 3, 'valid', 1000)",
    ).run(HASH);
    db.prepare(
      "UPDATE operations SET restore_unverified_at = 2000 WHERE operation_id = 'op-r3'",
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO operation_attempts (attempt_id, operation_id, content_version, approval_id, status, dispatch_intent_at, external_id, result_status, created_at) VALUES ('at-r3', 'op-r3', 1, 'ap-r3', 'preparing', NULL, NULL, NULL, 1000)",
          )
          .run(),
      /operation_restore_unverified/u,
    );
    // 印を外す更新は許す（後の作業の命令が行う）。
    db.prepare(
      "UPDATE operations SET restore_unverified_at = NULL WHERE operation_id = 'op-r3'",
    ).run();
    db.prepare(
      "INSERT INTO operation_attempts (attempt_id, operation_id, content_version, approval_id, status, dispatch_intent_at, external_id, result_status, created_at) VALUES ('at-r3', 'op-r3', 1, 'ap-r3', 'preparing', NULL, NULL, NULL, 1000)",
    ).run();
    assert.equal(
      db
        .prepare(
          "SELECT count(*) FROM operation_attempts WHERE attempt_id = 'at-r3'",
        )
        .pluck()
        .get(),
      1,
    );
    // 印を付ける前に作った試行も、印がある間は dispatching へ進めない。印を外せば進める。
    db.prepare(
      "UPDATE operations SET restore_unverified_at = 2000 WHERE operation_id = 'op-r3'",
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE operation_attempts SET status = 'dispatching', dispatch_intent_at = 3000 WHERE attempt_id = 'at-r3'",
          )
          .run(),
      /operation_restore_unverified/u,
    );
    db.prepare(
      "UPDATE operations SET restore_unverified_at = NULL WHERE operation_id = 'op-r3'",
    ).run();
    db.prepare(
      "UPDATE operation_attempts SET status = 'dispatching', dispatch_intent_at = 3000 WHERE attempt_id = 'at-r3'",
    ).run();
    assert.equal(
      db
        .prepare(
          "SELECT status FROM operation_attempts WHERE attempt_id = 'at-r3'",
        )
        .pluck()
        .get(),
      'dispatching',
    );
  });
});

test('derivations reject duplicates and read back by source', () => {
  withDb((db) => {
    writeDerivation(db, {
      artifact_kind: 'session_summary',
      artifact_id: 'summary-1',
      source_kind: 'turn',
      source_id: 'turn-1',
      created_at: 1000,
    });
    writeDerivation(db, {
      artifact_kind: 'notification_candidate',
      artifact_id: 'notice-1',
      source_kind: 'turn',
      source_id: 'turn-1',
      created_at: 1100,
    });
    writeDerivation(db, {
      artifact_kind: 'session_summary',
      artifact_id: 'summary-2',
      source_kind: 'memory',
      source_id: 'memory-1',
      created_at: 1200,
    });
    assert.deepEqual(
      readDerivationsBySource(db, { source_kind: 'turn', source_id: 'turn-1' }),
      [
        {
          artifact_kind: 'notification_candidate',
          artifact_id: 'notice-1',
          source_kind: 'turn',
          source_id: 'turn-1',
          created_at: 1100,
        },
        {
          artifact_kind: 'session_summary',
          artifact_id: 'summary-1',
          source_kind: 'turn',
          source_id: 'turn-1',
          created_at: 1000,
        },
      ],
    );
    assert.throws(
      () =>
        writeDerivation(db, {
          artifact_kind: 'session_summary',
          artifact_id: 'summary-1',
          source_kind: 'turn',
          source_id: 'turn-1',
          created_at: 1300,
        }),
      /derivation_fixed/u,
    );
    // 書いた辺は変えず、INSERT OR REPLACE でも入れ替えない。削除は忘却で使うので許す。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE derivations SET created_at = 1400 WHERE artifact_id = 'summary-1'",
          )
          .run(),
      /derivation_fixed/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT OR REPLACE INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('session_summary', 'summary-1', 'turn', 'turn-1', 1400)",
          )
          .run(),
      /derivation_fixed/u,
    );
    // 自分自身を由来にしない。
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('turn', 'same-1', 'turn', 'same-1', 1000)",
          )
          .run(),
      /CHECK constraint failed/u,
    );
    db.prepare(
      "DELETE FROM derivations WHERE artifact_kind = 'notification_candidate'",
    ).run();
    assert.equal(
      db.prepare('SELECT count(*) FROM derivations').pluck().get(),
      2,
    );
    assert.throws(
      () =>
        writeDerivation(db, {
          artifact_kind: 'unknown_kind',
          artifact_id: 'x-1',
          source_kind: 'turn',
          source_id: 'turn-1',
          created_at: 1300,
        } as never),
      /CHECK constraint failed/u,
    );
  });
});

test('the derivations CHECK lists exactly turn, memory and FORGET_ARTIFACT_KINDS', () => {
  // 手で書いた期待値（domain の FORGET_ARTIFACT_KINDS と、由来を引けない種類の turn・memory）。
  const artifactKinds = [
    'turn',
    'memory',
    'session_summary',
    'carried_summary',
    'notification_candidate',
    'request_entity',
    'related_analysis',
    'canvas_item',
    'intent_shadow',
    'operation_content',
    'async_guard',
  ];
  const sourceKinds = [
    'turn',
    'source_item',
    'memory',
    'session_summary',
    'carried_summary',
    'notification_candidate',
    'request_entity',
    'related_analysis',
    'canvas_item',
    'intent_shadow',
    'operation_content',
    'async_guard',
  ];
  assert.deepEqual([...FORGET_ARTIFACT_KINDS], artifactKinds.slice(2));
  withDb((db) => {
    const sql = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'derivations'",
      )
      .pluck()
      .get();
    assert.equal(typeof sql, 'string');
    const checked = (column: string): string[] => {
      const match = new RegExp(
        `${column}\\s+TEXT\\s+NOT\\s+NULL\\s+CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
        'u',
      ).exec(sql as string);
      assert.notEqual(match, null, column);
      return ((match as RegExpExecArray)[1] ?? '')
        .split(',')
        .map((item) => item.trim().replace(/^'|'$/gu, ''));
    };
    assert.deepEqual(checked('artifact_kind'), artifactKinds);
    assert.deepEqual(checked('source_kind'), sourceKinds);
    // 期待した種類はすべて通り、知らない種類と、artifact_kind に許さない source_item は拒否する。
    for (const [index, kind] of artifactKinds.entries())
      db.prepare(
        "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES (?, ?, 'turn', ?, 1000)",
      ).run(kind, `a-${index}`, `t-${index}`);
    db.prepare(
      "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('session_summary', 'from-source-item', 'source_item', 's-1', 1000)",
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('session', 's', 'turn', 't', 1000)",
          )
          .run(),
      /CHECK constraint failed/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('source_item', 's', 'turn', 't', 1000)",
          )
          .run(),
      /CHECK constraint failed/u,
    );
  });
});
