// 予算の保存（ADR 0036、マイグレーション 0006）を worker を介さずに同期で確かめる。DB は一時ディレクトリの書込み接続。
// 期待値（受付の可否・理由・行の値・利用状況の合計）は ADR 0006・0034・0035 の規則と合成の上限から手で書いた値で、
// 実装の処理から作っていない。通貨は XTS、上限は縮めた合成値。待ち合わせは COMMIT の前の関門（beforeCommit）で行い、
// 固定の sleep を使わない。模擬の試験だけで、実 API・実請求は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBudgetOp, openWriteConnection } from './index.js';
import type {
  BudgetOp,
  BudgetOpResult,
  BudgetOpValues,
  BudgetReservationValue,
  SqliteDatabase,
} from './index.js';
import {
  NOV_02,
  OCT_15,
  OWNER_ROUTE,
  SETTINGS,
  TIME_ZONE,
  admitOp,
  approvalId,
  budgetRequestId,
  count,
  request,
  reservationId,
  reservationRow,
  uuid,
} from './budget-test-support.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const CONTEXT = { platform: 'macos', halted: false } as const;

const run = (db: SqliteDatabase, op: BudgetOp): BudgetOpResult =>
  executeBudgetOp(db, op, CONTEXT).result;

function value<K extends keyof BudgetOpValues>(
  _kind: K,
  result: BudgetOpResult,
): BudgetOpValues[K] {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as unknown as { value: BudgetOpValues[K] }).value;
}

function reasons(result: BudgetOpResult): readonly string[] {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.ok ? [] : result.reasons;
}

const admit = (
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.admit' }>,
): BudgetOpValues['budget.admit'] => value('budget.admit', run(db, op));

function advance(
  db: SqliteDatabase,
  now: number,
  timeZone = TIME_ZONE,
): BudgetOpResult {
  return run(db, { kind: 'budget.calendar_advance', now, time_zone: timeZone });
}

// 東京の 2030 年 10 月の予算月を記録した DB で試す。
async function withBudget(
  body: (db: SqliteDatabase, path: string) => void,
  options: { readonly calendar?: boolean } = {},
): Promise<void> {
  await withTempDir((dir) => {
    const path = databasePath(dir);
    const db = openSeededDatabase(path);
    try {
      if (options.calendar !== false)
        value('budget.calendar_advance', advance(db, OCT_15));
      body(db, path);
    } finally {
      db.close();
    }
  });
}

const settle = (
  n: number,
  provider: string,
  id: string,
  actual: string,
  now = OCT_15 + 1000,
): Extract<BudgetOp, { kind: 'budget.settle' }> => ({
  kind: 'budget.settle',
  reservation_id: reservationId(n),
  request_id: budgetRequestId(n),
  provider,
  provider_reconciliation_id: id,
  actual_gross: actual,
  now,
});

const summaryOf = (db: SqliteDatabase, now = OCT_15 + 5000) =>
  value(
    'budget.summary',
    run(db, {
      kind: 'budget.summary',
      settings: SETTINGS,
      config_valid: true,
      now,
    }),
  );

function poolOf(
  summary: BudgetOpValues['budget.summary'],
  month: string,
  poolId: string,
): Record<string, unknown> {
  const pool = summary.months
    .find((item) => item.budget_month === month)
    ?.pools.find((item) => item.pool_id === poolId);
  assert(pool !== undefined, `${month} ${poolId}`);
  return {
    settled: pool.settled.amount,
    reserved: pool.unsettled_reserved.amount,
    max: pool.unsettled_max_liability.amount,
    unknown: pool.usage_unknown_count,
    overrun: pool.overrun_review_count,
    holds: pool.hold_reasons,
  };
}

function reservationOf(result: BudgetOpResult): BudgetReservationValue | null {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? (result.value as BudgetReservationValue | null) : null;
}

test('the budget month is recorded once per month, follows the time zone of the month and never moves back', async () => {
  await withBudget(
    (db) => {
      assert.equal(
        reservationOf(run(db, { kind: 'budget.calendar_read' })),
        null,
      );
      assert.deepEqual(value('budget.calendar_advance', advance(db, OCT_15)), {
        state: {
          month: '2030-10',
          timeZone: 'Asia/Tokyo',
          monthStart: '2030-09-30T15:00:00.000Z',
          monthStartTimeZone: 'Asia/Tokyo',
        },
        rolled_over: false,
        recorded: true,
      });
      // 同じ月の再実行と、月の途中のタイムゾーンの変更は記録を足さない（変更は翌月から）。
      assert.deepEqual(
        value('budget.calendar_advance', advance(db, OCT_15 + 1, 'UTC')),
        {
          state: {
            month: '2030-10',
            timeZone: 'Asia/Tokyo',
            monthStart: '2030-09-30T15:00:00.000Z',
            monthStartTimeZone: 'Asia/Tokyo',
          },
          rolled_over: false,
          recorded: false,
        },
      );
      assert.deepEqual(
        value('budget.calendar_advance', advance(db, NOV_02, 'UTC')),
        {
          state: {
            month: '2030-11',
            timeZone: 'UTC',
            monthStart: '2030-10-31T15:00:00.000Z',
            monthStartTimeZone: 'Asia/Tokyo',
          },
          rolled_over: true,
          recorded: true,
        },
      );
      // 時計が戻っても予算月を戻さず、記録も足さない。
      assert.deepEqual(reasons(advance(db, OCT_15, 'UTC')), [
        'clock_regressed',
      ]);
      assert.deepEqual(
        db
          .prepare(
            'SELECT month, time_zone, month_start, month_start_time_zone FROM budget_months ORDER BY month',
          )
          .all(),
        [
          {
            month: '2030-10',
            time_zone: 'Asia/Tokyo',
            month_start: 1917010800000,
            month_start_time_zone: 'Asia/Tokyo',
          },
          {
            month: '2030-11',
            time_zone: 'UTC',
            month_start: 1919689200000,
            month_start_time_zone: 'Asia/Tokyo',
          },
        ],
      );
      assert.deepEqual(
        value(
          'budget.calendar_read',
          run(db, { kind: 'budget.calendar_read' }),
        ),
        {
          month: '2030-11',
          timeZone: 'UTC',
          monthStart: '2030-10-31T15:00:00.000Z',
          monthStartTimeZone: 'Asia/Tokyo',
        },
      );
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'budget.calendar_advance',
            now: NOV_02,
            time_zone: '+09:00',
          }),
        ),
        ['time_zone_invalid'],
      );
    },
    { calendar: false },
  );
});

// ADR 0036 の判断: tz データの更新などで、保存した月の始まりが求め直した始まりと食い違ったら、記録を書き換えず、
// 有料の受付と月の進行を止める（閉じた側に倒す）。
test('a stored month start that no longer matches the time zone data holds admission and is never rewritten', async () => {
  await withBudget(
    (db) => {
      // 東京の 10 月の始まり（2030-09-30T15:00Z）より 1 時間遅い始まりの記録（古い tz データで作った記録の模擬）。
      db.prepare(
        "INSERT INTO budget_months (month, time_zone, month_start, month_start_time_zone, recorded_at) VALUES ('2030-10', 'Asia/Tokyo', 1917014400000, 'Asia/Tokyo', 1917014400000)",
      ).run();
      assert.deepEqual(reasons(advance(db, OCT_15)), [
        'invalid_calendar_state',
      ]);
      assert.deepEqual(
        reasons(run(db, admitOp(1, { reserved: '1', max: '1' }))),
        ['invalid_calendar_state'],
      );
      assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 0);
      assert.deepEqual(
        db.prepare('SELECT month, month_start FROM budget_months').all(),
        [{ month: '2030-10', month_start: 1917014400000 }],
      );
    },
    { calendar: false },
  );
});

test('admission is decided inside the transaction against every pool on the path and the current month only', async () => {
  await withBudget((db) => {
    const first = admit(db, admitOp(1, { reserved: '10', max: '30' }));
    assert.deepEqual(first, {
      admitted: true,
      reason_codes: [],
      duplicate: false,
      routed: false,
      reservation: {
        reservationId: reservationId(1),
        requestId: budgetRequestId(1),
        profileId: 'intent.luna.v1',
        priceVersion: 'price-1',
        poolId: 'llm',
        budgetMonth: '2030-10',
        currency: 'XTS',
        reserved: '10',
        maxLiability: '30',
        status: 'reserved',
        actualGross: null,
        providerReconciliationId: null,
        approvalId: null,
        revision: '1',
        overrunReviewed: false,
        settlementKind: null,
        settledAt: null,
        overrunReviewedAt: null,
        createdAt: OCT_15,
        requestedPoolId: 'llm',
        origin: 'owner_request',
        dispatchIntentAt: null,
      },
    });
    // llm は 30＋50＝80 で上限ちょうど。次の M 1 は llm の上限を超える（R は 31 で収まる）。
    assert.equal(
      admit(db, admitOp(2, { reserved: '20', max: '50' })).admitted,
      true,
    );
    const over = admit(db, admitOp(3, { reserved: '1', max: '1' }));
    assert.deepEqual(
      [over.admitted, over.reason_codes, over.reservation],
      [false, ['m_limit:llm'], null],
    );
    // search は自分の上限（40）に収まっても、親の llm_search（80＋25＝105 > 100）で拒否する。
    assert.deepEqual(
      admit(db, admitOp(4, { reserved: '5', max: '25' }, { pool_id: 'search' }))
        .reason_codes,
      ['m_limit:llm_search'],
    );
    // 親の上限ちょうど（80＋20＝100）は受け付ける。音声は独立の枠。
    assert.equal(
      admit(db, admitOp(5, { reserved: '5', max: '20' }, { pool_id: 'search' }))
        .admitted,
      true,
    );
    assert.equal(
      admit(db, admitOp(6, { reserved: '0', max: '50' }, { pool_id: 'voice' }))
        .admitted,
      true,
    );
    // domain の判定: 確認されていない単価の版、R が M を超える要求。
    assert.deepEqual(
      admit(
        db,
        admitOp(
          7,
          { reserved: '0', max: '0' },
          { pool_id: 'voice', price_version: 'price-x' },
        ),
      ).reason_codes,
      ['price_unverified'],
    );
    assert.deepEqual(
      admit(db, admitOp(8, { reserved: '1', max: '0' }, { pool_id: 'voice' }))
        .reason_codes,
      ['reservation_exceeds_max'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 4);
    // 予算月は保存した状態の今月だけ。月の終わりを越えた（進めていない）・時計が戻った時刻は受け付けない。
    assert.deepEqual(
      reasons(
        run(
          db,
          admitOp(9, { reserved: '0', max: '0' }, { budget_month: '2030-11' }),
        ),
      ),
      ['budget_month_not_current'],
    );
    assert.deepEqual(
      reasons(
        run(db, admitOp(10, { reserved: '0', max: '0' }, { now: NOV_02 })),
      ),
      ['calendar_stale'],
    );
    assert.deepEqual(
      reasons(
        run(
          db,
          admitOp(
            11,
            { reserved: '0', max: '0' },
            { now: Date.parse('2030-09-30T14:59:59.999Z') },
          ),
        ),
      ),
      ['clock_regressed'],
    );
    // 形の拒否: 0001 の行の印の profile、小数・19 桁の金額。
    assert.deepEqual(
      reasons(
        run(
          db,
          admitOp(
            12,
            { reserved: '0', max: '0' },
            { profile_id: 'legacy:unrecorded' },
          ),
        ),
      ),
      ['profile_id_invalid'],
    );
    assert.deepEqual(
      reasons(run(db, admitOp(13, { reserved: '0', max: '1.5' }))),
      ['amount_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(db, admitOp(14, { reserved: '0', max: '1000000000000000000' })),
      ),
      ['amount_invalid'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 4);
  });
  await withBudget(
    (db) => {
      assert.deepEqual(
        reasons(run(db, admitOp(1, { reserved: '1', max: '1' }))),
        ['calendar_not_initialized'],
      );
    },
    { calendar: false },
  );
});

test('the same request_id returns the stored reservation and a different request under it is a conflict', async () => {
  await withBudget((db) => {
    const first = admit(db, admitOp(1, { reserved: '10', max: '30' }));
    const again = admit(db, admitOp(1, { reserved: '10', max: '30' }));
    assert.deepEqual(
      [again.admitted, again.duplicate, again.reservation?.reservationId],
      [true, true, first.reservation?.reservationId],
    );
    // 新しい予約 ID で送り直しても、同じ request_id の予約は 1 つ。
    const renamed = admit(
      db,
      admitOp(
        1,
        { reserved: '10', max: '30' },
        { reservation_id: uuid(0xa0ffff) },
      ),
    );
    assert.deepEqual(
      [renamed.duplicate, renamed.reservation?.reservationId],
      [true, reservationId(1)],
    );
    assert.deepEqual(
      reasons(run(db, admitOp(1, { reserved: '10', max: '31' }))),
      ['request_conflict'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 1);
  });
});

test('settlement applies once by request_id and the provider-prefixed reconciliation id, and the totals add up', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '30' }));
    admit(db, admitOp(2, { reserved: '20', max: '50' }));
    admit(db, admitOp(3, { reserved: '5', max: '20' }, { pool_id: 'search' }));
    const settled = value(
      'budget.settle',
      run(db, settle(1, 'anthropic', 'msg-1', '25')),
    );
    assert.deepEqual([settled.duplicate, settled.overrun], [false, false]);
    assert.deepEqual(reservationRow(db, reservationId(1)), {
      pool_id: 'llm',
      budget_month: '2030-10',
      status: 'settled',
      reserved_amount: '10',
      max_liability: '30',
      reservation_revision: '1',
      actual_gross: '25',
      provider_reconciliation_id: 'anthropic:msg-1',
      settlement_kind: 'provider',
      settled_at: String(OCT_15 + 1000),
      overrun_reviewed: '0',
      overrun_reviewed_at: null,
      approval_id: null,
    });
    // 同じ値の再適用は変化なし（精算の時刻も最初のまま）。違う値は競合。
    const again = value(
      'budget.settle',
      run(db, settle(1, 'anthropic', 'msg-1', '25', OCT_15 + 2000)),
    );
    assert.equal(again.duplicate, true);
    assert.equal(again.reservation.settledAt, OCT_15 + 1000);
    assert.deepEqual(reasons(run(db, settle(1, 'anthropic', 'msg-1', '26'))), [
      'settlement_conflict',
    ]);
    assert.deepEqual(reasons(run(db, settle(1, 'anthropic', 'msg-1b', '25'))), [
      'settlement_conflict',
    ]);
    // 同じ照合 ID で別の予約を精算しない。provider の名前が違えば別の ID。
    assert.deepEqual(reasons(run(db, settle(2, 'anthropic', 'msg-1', '40'))), [
      'reconciliation_id_used',
    ]);
    assert.equal(
      value('budget.settle', run(db, settle(2, 'openai', 'msg-1', '40')))
        .reservation.providerReconciliationId,
      'openai:msg-1',
    );
    assert.deepEqual(
      reasons(
        run(db, {
          ...settle(3, 'anthropic', 'msg-3', '1'),
          request_id: uuid(0xbfffff),
        }),
      ),
      ['request_mismatch'],
    );
    assert.deepEqual(reasons(run(db, settle(3, 'manual', 'inv-3', '1'))), [
      'provider_invalid',
    ]);
    // 精算済みは実費、未精算は R と M（親の枠は子の分を含む）。25＋40＝65。
    const summary = summaryOf(db);
    assert.deepEqual(poolOf(summary, '2030-10', 'llm'), {
      settled: '65',
      reserved: '0',
      max: '0',
      unknown: 0,
      overrun: 0,
      holds: [],
    });
    assert.deepEqual(poolOf(summary, '2030-10', 'search'), {
      settled: '0',
      reserved: '5',
      max: '20',
      unknown: 0,
      overrun: 0,
      holds: [],
    });
    assert.deepEqual(poolOf(summary, '2030-10', 'llm_search'), {
      settled: '65',
      reserved: '5',
      max: '20',
      unknown: 0,
      overrun: 0,
      holds: [],
    });
    assert.equal(
      count(
        db,
        "SELECT sum(actual_gross) FROM budget_reservations WHERE status = 'settled'",
      ),
      65,
    );
  });
});

test('a reservation keeps its budget month and pool: it settles into the original month after the month changes', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '80' }));
    value('budget.calendar_advance', advance(db, NOV_02));
    // 10 月の未精算は 11 月に数えない。
    assert.equal(
      admit(
        db,
        admitOp(
          2,
          { reserved: '10', max: '80' },
          { budget_month: '2030-11', now: NOV_02 },
        ),
      ).admitted,
      true,
    );
    assert.deepEqual(
      reasons(
        run(db, admitOp(3, { reserved: '0', max: '0' }, { now: NOV_02 })),
      ),
      ['budget_month_not_current'],
    );
    let summary = summaryOf(db, NOV_02 + 1);
    assert.deepEqual(
      summary.months.map((month) => month.budget_month),
      ['2030-11', '2030-10'],
    );
    assert.equal(poolOf(summary, '2030-10', 'llm')['max'], '80');
    assert.equal(poolOf(summary, '2030-11', 'llm')['max'], '80');
    value(
      'budget.settle',
      run(db, settle(1, 'anthropic', 'msg-1', '70', NOV_02)),
    );
    const row = reservationRow(db, reservationId(1));
    assert.deepEqual(
      [row?.['budget_month'], row?.['pool_id'], row?.['actual_gross']],
      ['2030-10', 'llm', '70'],
    );
    summary = summaryOf(db, NOV_02 + 1);
    assert.deepEqual(
      summary.months.map((month) => month.budget_month),
      ['2030-11'],
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE budget_reservations SET budget_month = '2030-11' WHERE reservation_id = ?",
          )
          .run(reservationId(1)),
      /budget_month_fixed/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE budget_reservations SET pool_id = 'voice' WHERE reservation_id = ?",
          )
          .run(reservationId(1)),
      /budget_month_fixed/u,
    );
  });
});

test('a top-up is a compare-and-set on the reservation revision and checks only the added amount', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '30' }));
    const topUp = (expected: string, deltaR: string, deltaM: string) =>
      run(db, {
        kind: 'budget.top_up',
        reservation_id: reservationId(1),
        expected_revision: expected,
        delta_reserved: deltaR,
        delta_max_liability: deltaM,
        settings: SETTINGS,
        now: OCT_15,
      });
    const first = value('budget.top_up', topUp('1', '5', '10')).reservation;
    assert.deepEqual(
      [first.revision, first.reserved, first.maxLiability],
      ['2', '15', '40'],
    );
    assert.deepEqual(reasons(topUp('1', '5', '10')), ['revision_conflict']);
    // 40＋41＝81 > 80。
    assert.deepEqual(reasons(topUp('2', '0', '41')), ['m_limit:llm']);
    assert.equal(
      value('budget.top_up', topUp('2', '0', '40')).reservation.revision,
      '3',
    );
    value(
      'budget.mark_unknown',
      run(db, {
        kind: 'budget.mark_unknown',
        reservation_id: reservationId(1),
      }),
    );
    assert.deepEqual(reasons(topUp('3', '0', '0')), ['not_active']);
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.top_up',
          reservation_id: uuid(0xa0eeee),
          expected_revision: '1',
          delta_reserved: '0',
          delta_max_liability: '0',
          settings: SETTINGS,
          now: OCT_15,
        }),
      ),
      ['unknown_reservation'],
    );
    assert.deepEqual(
      reservationRow(db, reservationId(1))?.['max_liability'],
      '80',
    );
  });
});

test('usage unknown keeps R and M, only certainly unsent reservations are released, and a released one is never settled', async () => {
  await withBudget((db) => {
    for (const n of [1, 2, 3, 4])
      admit(db, admitOp(n, { reserved: '1', max: '2' }));
    const mark = (n: number) =>
      run(db, {
        kind: 'budget.mark_unknown',
        reservation_id: reservationId(n),
      });
    const release = (n: number, sent: boolean) =>
      run(db, {
        kind: 'budget.release_unsent',
        reservation_id: reservationId(n),
        provider_request_sent: sent,
      });
    assert.deepEqual(
      [
        value('budget.mark_unknown', mark(1)).duplicate,
        value('budget.mark_unknown', mark(1)).duplicate,
      ],
      [false, true],
    );
    assert.deepEqual(reasons(release(1, false)), ['possibly_sent']);
    assert.equal(
      value('budget.release_unsent', release(2, false)).duplicate,
      false,
    );
    assert.equal(
      value('budget.release_unsent', release(2, false)).duplicate,
      true,
    );
    assert.deepEqual(reasons(run(db, settle(2, 'anthropic', 'msg-2', '1'))), [
      'released',
    ]);
    assert.deepEqual(reasons(mark(2)), ['not_active']);
    assert.deepEqual(
      reservationRow(db, reservationId(2))?.['status'],
      'released',
    );
    assert.deepEqual(
      reservationRow(db, reservationId(2))?.['actual_gross'],
      null,
    );
    assert.deepEqual(reasons(release(3, true)), ['possibly_sent']);
    // 会話の接続を作った予約は送った可能性がある。
    db.exec(
      "INSERT INTO sessions VALUES ('s-1', 'normal', 'dev-1', 1, NULL, 1000, NULL)",
    );
    db.prepare(
      "INSERT INTO live_sessions VALUES ('ls-1', 'dev-1', 's-1', 'conversation', 'connecting', 0, 'open', NULL, ?, 1000, NULL, NULL)",
    ).run(reservationId(4));
    assert.deepEqual(reasons(release(4, false)), ['possibly_sent']);
    // 解放した予約は 0、usage 不明と予約中は R と M（1・3・4 の 3 件）。
    assert.deepEqual(poolOf(summaryOf(db), '2030-10', 'llm'), {
      settled: '0',
      reserved: '3',
      max: '6',
      unknown: 1,
      overrun: 0,
      holds: [],
    });
  });
});

test('a manual settlement applies once to a usage-unknown reservation and the device request is recorded with it', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '30' }));
    admit(db, admitOp(2, { reserved: '10', max: '30' }));
    run(db, { kind: 'budget.mark_unknown', reservation_id: reservationId(1) });
    const manual = (
      n: number,
      id: string,
      actual: string,
      ref: ReturnType<typeof request> | null,
      expected = '1',
    ) =>
      run(db, {
        kind: 'budget.settle_manual',
        reservation_id: reservationId(n),
        expected_revision: expected,
        manual_reconciliation_id: id,
        currency: 'XTS',
        actual_gross: actual,
        now: OCT_15 + 3000,
        request: ref,
      });
    const first = value(
      'budget.settle_manual',
      manual(1, 'manual:inv-1', '20', request(1)),
    );
    assert.deepEqual(
      [first.duplicate, first.overrun, first.replayed],
      [false, false, false],
    );
    assert.deepEqual(
      [
        first.reservation.status,
        first.reservation.settlementKind,
        first.reservation.providerReconciliationId,
        first.reservation.settledAt,
      ],
      ['settled', 'manual', 'manual:inv-1', OCT_15 + 3000],
    );
    assert.equal(count(db, 'SELECT count(*) FROM command_receipts'), 1);
    const replay = value(
      'budget.settle_manual',
      manual(1, 'manual:inv-1', '20', request(1)),
    );
    assert.deepEqual([replay.replayed, replay.duplicate], [true, true]);
    assert.deepEqual(
      reasons(manual(1, 'manual:inv-1', '20', request(1, 'b'))),
      ['request_conflict'],
    );
    const twice = value(
      'budget.settle_manual',
      manual(1, 'manual:inv-1', '20', request(2)),
    );
    assert.deepEqual([twice.replayed, twice.duplicate], [false, true]);
    assert.equal(count(db, 'SELECT count(*) FROM command_receipts'), 2);
    assert.deepEqual(reasons(manual(1, 'manual:inv-1', '21', request(3))), [
      'already_settled',
    ]);
    assert.deepEqual(reasons(run(db, settle(1, 'anthropic', 'msg-9', '20'))), [
      'settlement_conflict',
    ]);
    // 予約中（送信中）の予約は手で精算しない。照合 ID は 1 つの予約にだけ使う。
    assert.deepEqual(reasons(manual(2, 'manual:inv-2', '20', null)), [
      'not_usage_unknown',
    ]);
    run(db, { kind: 'budget.mark_unknown', reservation_id: reservationId(2) });
    assert.deepEqual(reasons(manual(2, 'manual:inv-1', '20', null)), [
      'reconciliation_id_used',
    ]);
    assert.deepEqual(reasons(manual(2, 'manual:inv-2', '20', null, '2')), [
      'revision_conflict',
    ]);
    assert.deepEqual(reasons(manual(2, 'inv-2', '20', null)), [
      'manual_id_invalid',
    ]);
    assert.equal(count(db, 'SELECT count(*) FROM command_receipts'), 2);
  });
});

test('an actual cost above M holds the pool and its descendants until the owner reviews it', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '30' }));
    assert.equal(
      value('budget.settle', run(db, settle(1, 'anthropic', 'msg-1', '45')))
        .overrun,
      true,
    );
    assert.deepEqual(
      admit(
        db,
        admitOp(2, { reserved: '1', max: '1' }, { pool_id: 'llm.background' }),
      ).reason_codes,
      ['overrun_hold:llm'],
    );
    assert.equal(
      admit(db, admitOp(3, { reserved: '1', max: '1' }, { pool_id: 'search' }))
        .admitted,
      true,
    );
    let summary = summaryOf(db);
    assert.deepEqual(poolOf(summary, '2030-10', 'llm')['holds'], [
      'overrun_review_pending',
    ]);
    assert.deepEqual(poolOf(summary, '2030-10', 'llm.background')['holds'], [
      'ancestor_held',
    ]);
    assert.equal(poolOf(summary, '2030-10', 'llm')['overrun'], 1);
    assert.deepEqual(
      summary.pending_reservations.map((item) => item.reservation_id),
      [reservationId(1)],
    );
    const review = (
      expected: string,
      actual: string,
      ref: ReturnType<typeof request> | null,
    ) =>
      run(db, {
        kind: 'budget.review_overrun',
        reservation_id: reservationId(1),
        expected_revision: expected,
        currency: 'XTS',
        actual_gross: actual,
        max_liability: '30',
        now: OCT_15 + 4000,
        request: ref,
      });
    assert.deepEqual(reasons(review('1', '44', null)), ['review_mismatch']);
    assert.deepEqual(reasons(review('2', '45', null)), ['revision_conflict']);
    const reviewed = value(
      'budget.review_overrun',
      review('1', '45', request(1)),
    );
    assert.deepEqual(
      [
        reviewed.duplicate,
        reviewed.replayed,
        reviewed.reservation.overrunReviewed,
        reviewed.reservation.overrunReviewedAt,
        reviewed.reservation.actualGross,
      ],
      [false, false, true, OCT_15 + 4000, '45'],
    );
    assert.equal(
      value('budget.review_overrun', review('1', '45', request(1))).replayed,
      true,
    );
    assert.equal(
      value('budget.review_overrun', review('1', '45', null)).duplicate,
      true,
    );
    summary = summaryOf(db);
    assert.deepEqual(poolOf(summary, '2030-10', 'llm')['holds'], []);
    assert.equal(
      admit(
        db,
        admitOp(2, { reserved: '1', max: '1' }, { pool_id: 'llm.background' }),
      ).admitted,
      true,
    );
    value('budget.settle', run(db, settle(3, 'anthropic', 'msg-3', '1')));
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.review_overrun',
          reservation_id: reservationId(3),
          expected_revision: '1',
          currency: 'XTS',
          actual_gross: '1',
          max_liability: '1',
          now: OCT_15 + 4000,
          request: null,
        }),
      ),
      ['no_overrun'],
    );
  });
});

test('an overage approval is fixed to one request and M, a double press keeps one approval, and it is used once', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '80' }));
    const routed = (n: number, now = OCT_15 + 2000) =>
      admit(
        db,
        admitOp(n, { reserved: '5', max: '20' }, { overage: OWNER_ROUTE, now }),
      );
    assert.deepEqual(routed(2).reason_codes, [
      'm_limit:llm',
      'approval_required',
    ]);
    const ask = (id: number, max = '20') =>
      run(db, {
        kind: 'budget.request_overage',
        approval_id: approvalId(id),
        request_id: budgetRequestId(2),
        pool_id: 'overage',
        budget_month: '2030-10',
        currency: 'XTS',
        max_liability: max,
        overage_remaining: '60',
        now: OCT_15,
        expires_at: OCT_15 + 600_000,
      });
    const asked = value('budget.request_overage', ask(1));
    assert.deepEqual(asked, {
      approval: {
        approval_id: approvalId(1),
        request_id: budgetRequestId(2),
        pool_id: 'overage',
        budget_month: '2030-10',
        max_liability: { currency: 'XTS', amount: '20' },
        overage_remaining: { currency: 'XTS', amount: '60' },
        status: 'pending',
        requested_at: '2030-10-15T00:00:00.000Z',
        expires_at: '2030-10-15T00:10:00.000Z',
        decided_at: null,
      },
      consumed_reservation_id: null,
      duplicate: false,
    });
    const askedAgain = value('budget.request_overage', ask(99));
    assert.deepEqual(
      [askedAgain.duplicate, askedAgain.approval.approval_id],
      [true, approvalId(1)],
    );
    assert.deepEqual(reasons(ask(98, '21')), ['approval_conflict']);
    assert.equal(count(db, 'SELECT count(*) FROM budget_overage_approvals'), 1);
    assert.deepEqual(routed(2).reason_codes, [
      'm_limit:llm',
      'approval_pending',
    ]);
    const decide = (
      decision: 'approve' | 'reject',
      ref: ReturnType<typeof request> | null,
      max = '20',
    ) =>
      run(db, {
        kind: 'budget.approve_overage',
        approval_id: approvalId(1),
        budget_request_id: budgetRequestId(2),
        currency: 'XTS',
        max_liability: max,
        decision,
        now: OCT_15 + 1000,
        request: ref,
      });
    assert.deepEqual(reasons(decide('approve', null, '21')), [
      'approval_mismatch',
    ]);
    const approved = value(
      'budget.approve_overage',
      decide('approve', request(1)),
    );
    assert.deepEqual(
      [
        approved.approval.status,
        approved.approval.decided_at,
        approved.duplicate,
      ],
      ['approved', '2030-10-15T00:00:01.000Z', false],
    );
    // 二度押し（別の要求）でも承認は 1 件。同じ要求の再送は保存済みの結果。
    assert.equal(
      value('budget.approve_overage', decide('approve', request(2))).duplicate,
      true,
    );
    assert.equal(
      value('budget.approve_overage', decide('approve', request(1))).replayed,
      true,
    );
    assert.deepEqual(reasons(decide('reject', null)), ['approval_approved']);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM budget_overage_approvals WHERE status = 'approved'",
      ),
      1,
    );
    // 承認した M で超過枠に計上し、同じ transaction で承認を使用済みにする。
    const used = routed(2);
    assert.deepEqual(
      [
        used.admitted,
        used.routed,
        used.reservation?.poolId,
        used.reservation?.approvalId,
      ],
      [true, true, 'overage', approvalId(1)],
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT status, consumed_at, consumed_reservation_id FROM budget_overage_approvals',
        )
        .all(),
      [
        {
          status: 'consumed',
          consumed_at: OCT_15 + 2000,
          consumed_reservation_id: reservationId(2),
        },
      ],
    );
    // 送り直しは保存済みの予約。承認は二度使えない。
    assert.deepEqual([routed(2).duplicate, routed(2).routed], [true, true]);
    assert.deepEqual(reasons(decide('approve', request(3))), [
      'approval_consumed',
    ]);
    assert.deepEqual(routed(3).reason_codes, [
      'm_limit:llm',
      'approval_required',
    ]);
    assert.deepEqual(reasons(ask(97)), ['already_admitted']);
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.top_up',
          reservation_id: reservationId(2),
          expected_revision: '1',
          delta_reserved: '0',
          delta_max_liability: '1',
          settings: SETTINGS,
          now: OCT_15,
        }),
      ),
      ['approval_fixes_max_liability'],
    );
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM budget_reservations WHERE approval_id IS NOT NULL',
      ),
      1,
    );
  });
});

test('an expired overage approval is not used and a new one can be requested', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '80' }));
    const ask = (id: number, now: number) =>
      run(db, {
        kind: 'budget.request_overage',
        approval_id: approvalId(id),
        request_id: budgetRequestId(4),
        pool_id: 'overage',
        budget_month: '2030-10',
        currency: 'XTS',
        max_liability: '20',
        overage_remaining: '60',
        now,
        expires_at: now + 1000,
      });
    value('budget.request_overage', ask(1, OCT_15));
    const decide = (id: number, now: number) =>
      run(db, {
        kind: 'budget.approve_overage',
        approval_id: approvalId(id),
        budget_request_id: budgetRequestId(4),
        currency: 'XTS',
        max_liability: '20',
        decision: 'approve',
        now,
        request: null,
      });
    value('budget.approve_overage', decide(1, OCT_15 + 500));
    // 期限の時刻ちょうどは期限切れ。
    assert.deepEqual(
      admit(
        db,
        admitOp(
          4,
          { reserved: '5', max: '20' },
          { overage: OWNER_ROUTE, now: OCT_15 + 1000 },
        ),
      ).reason_codes,
      ['m_limit:llm', 'approval_expired'],
    );
    const renewed = value('budget.request_overage', ask(2, OCT_15 + 2000));
    assert.equal(renewed.duplicate, false);
    assert.deepEqual(
      db
        .prepare(
          'SELECT approval_id, status FROM budget_overage_approvals ORDER BY requested_at',
        )
        .all(),
      [
        { approval_id: approvalId(1), status: 'expired' },
        { approval_id: approvalId(2), status: 'pending' },
      ],
    );
    assert.deepEqual(reasons(decide(2, OCT_15 + 3000)), ['approval_expired']);
  });
});

// X18 の DB の層: 関門（COMMIT の前）でそろえた 2 件の同時の受付。先の transaction の中で別の接続が受付を試み、
// 書込みの排他（busy_timeout=0）で待たずに拒否される。先が COMMIT した後の再試行は上限で拒否される。
test('two admissions aligned at a barrier on two connections never exceed the limit', async () => {
  await withBudget((db, path) => {
    admit(db, admitOp(1, { reserved: '10', max: '60' }));
    const other = openWriteConnection(path, { platform: 'macos' });
    try {
      let inner: BudgetOpResult | null = null;
      const outer = executeBudgetOp(
        db,
        admitOp(2, { reserved: '5', max: '20' }),
        {
          ...CONTEXT,
          beforeCommit: () => {
            inner = executeBudgetOp(
              other,
              admitOp(3, { reserved: '5', max: '20' }),
              CONTEXT,
            ).result;
          },
        },
      ).result;
      assert.equal(value('budget.admit', outer).admitted, true);
      assert.deepEqual(reasons(inner as unknown as BudgetOpResult), [
        'database_busy',
      ]);
      assert.deepEqual(
        value(
          'budget.admit',
          executeBudgetOp(
            other,
            admitOp(3, { reserved: '5', max: '20' }),
            CONTEXT,
          ).result,
        ).reason_codes,
        ['m_limit:llm'],
      );
      // 二度押しの承認も、関門でそろえて 1 件。
      value(
        'budget.request_overage',
        run(db, {
          kind: 'budget.request_overage',
          approval_id: approvalId(1),
          request_id: budgetRequestId(3),
          pool_id: 'overage',
          budget_month: '2030-10',
          currency: 'XTS',
          max_liability: '20',
          overage_remaining: '60',
          now: OCT_15,
          expires_at: OCT_15 + 600_000,
        }),
      );
      const press: BudgetOp = {
        kind: 'budget.approve_overage',
        approval_id: approvalId(1),
        budget_request_id: budgetRequestId(3),
        currency: 'XTS',
        max_liability: '20',
        decision: 'approve',
        now: OCT_15 + 1000,
        request: null,
      };
      let second: BudgetOpResult | null = null;
      const first = executeBudgetOp(db, press, {
        ...CONTEXT,
        beforeCommit: () => {
          second = executeBudgetOp(other, press, CONTEXT).result;
        },
      }).result;
      assert.equal(value('budget.approve_overage', first).duplicate, false);
      assert.deepEqual(reasons(second as unknown as BudgetOpResult), [
        'database_busy',
      ]);
      assert.equal(
        value(
          'budget.approve_overage',
          executeBudgetOp(other, press, CONTEXT).result,
        ).duplicate,
        true,
      );
    } finally {
      other.close();
    }
    assert.equal(
      count(
        db,
        "SELECT sum(max_liability) FROM budget_reservations WHERE pool_id = 'llm' AND status = 'reserved'",
      ),
      80,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM budget_overage_approvals WHERE status = 'approved'",
      ),
      1,
    );
  });
});

// B07-03 の Codex のレビュー P1: 設定から枠を消した後は、その枠の予約の経路が解けないので、追加予約を上限の検査なしに
// 通さず拒否する。
test('a top-up of a reservation whose pool was removed from the settings is refused without changing the row', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '5', max: '20' }));
    const withoutLlm = {
      ...SETTINGS,
      pools: SETTINGS.pools.filter(
        (pool) => pool.poolId !== 'llm' && pool.poolId !== 'llm.background',
      ),
    };
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.top_up',
          reservation_id: reservationId(1),
          expected_revision: '1',
          delta_reserved: '0',
          delta_max_liability: '500',
          settings: withoutLlm,
          now: OCT_15,
        }),
      ),
      ['unknown_pool'],
    );
    const row = reservationRow(db, reservationId(1));
    assert.deepEqual(
      [row?.['max_liability'], row?.['reservation_revision']],
      ['20', '1'],
    );
  });
});

// B07-03 の Codex のレビュー P2: 超過枠へ回した予約の送り直しは、計上先だけでなく要求した枠と起点でも照合する。
test('a resend of a routed admission with another requested pool or origin is a conflict', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '80' }));
    value(
      'budget.request_overage',
      run(db, {
        kind: 'budget.request_overage',
        approval_id: approvalId(1),
        request_id: budgetRequestId(2),
        pool_id: 'overage',
        budget_month: '2030-10',
        currency: 'XTS',
        max_liability: '20',
        overage_remaining: '60',
        now: OCT_15,
        expires_at: OCT_15 + 600_000,
      }),
    );
    value(
      'budget.approve_overage',
      run(db, {
        kind: 'budget.approve_overage',
        approval_id: approvalId(1),
        budget_request_id: budgetRequestId(2),
        currency: 'XTS',
        max_liability: '20',
        decision: 'approve',
        now: OCT_15 + 1000,
        request: null,
      }),
    );
    const routed = (overrides: Parameters<typeof admitOp>[2] = {}) =>
      run(
        db,
        admitOp(
          2,
          { reserved: '5', max: '20' },
          { overage: OWNER_ROUTE, now: OCT_15 + 2000, ...overrides },
        ),
      );
    const first = value('budget.admit', routed());
    assert.deepEqual(
      [
        first.admitted,
        first.reservation?.poolId,
        first.reservation?.requestedPoolId,
        first.reservation?.origin,
      ],
      [true, 'overage', 'llm', 'owner_request'],
    );
    assert.equal(value('budget.admit', routed()).duplicate, true);
    assert.deepEqual(reasons(routed({ pool_id: 'voice' })), [
      'request_conflict',
    ]);
    assert.deepEqual(reasons(routed({ origin: 'autonomous_analysis' })), [
      'request_conflict',
    ]);
    // 超過枠へ回さない送り直し（経路なし）は、計上先が超過枠なので一致しない。
    assert.deepEqual(reasons(routed({ overage: null })), ['request_conflict']);
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 2);
  });
});

// B07-03 の Codex のレビュー P2: 予算月の状態が食い違う（U23）・時計が戻った・月の終わりを越えて進めていないときは、
// 追加予約も止める。進めた後は、前の月の予約の追加予約は元の月に計上する。
test('a top-up is held like an admission when the budget month is inconsistent, regressed or stale', async () => {
  await withBudget(
    (db) => {
      // 古い tz データで作った記録の模擬（東京の 10 月の始まりより 1 時間遅い）と、その月の予約。
      db.prepare(
        "INSERT INTO budget_months (month, time_zone, month_start, month_start_time_zone, recorded_at) VALUES ('2030-10', 'Asia/Tokyo', 1917014400000, 'Asia/Tokyo', 1917014400000)",
      ).run();
      db.prepare(
        "INSERT INTO budget_reservations (reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, created_at) VALUES (?, ?, 'intent.luna.v1', 'llm', 'llm', 'owner_request', '2030-10', 'XTS', 'price-1', 10, 20, 'reserved', 1, ?)",
      ).run(reservationId(1), budgetRequestId(1), OCT_15);
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'budget.top_up',
            reservation_id: reservationId(1),
            expected_revision: '1',
            delta_reserved: '0',
            delta_max_liability: '10',
            settings: SETTINGS,
            now: OCT_15,
          }),
        ),
        ['invalid_calendar_state'],
      );
      assert.deepEqual(
        reservationRow(db, reservationId(1))?.['max_liability'],
        '20',
      );
    },
    { calendar: false },
  );
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '20' }));
    const topUp = (now: number, expected = '1') =>
      run(db, {
        kind: 'budget.top_up',
        reservation_id: reservationId(1),
        expected_revision: expected,
        delta_reserved: '0',
        delta_max_liability: '10',
        settings: SETTINGS,
        now,
      });
    assert.deepEqual(reasons(topUp(Date.parse('2030-09-30T14:59:59.999Z'))), [
      'clock_regressed',
    ]);
    assert.deepEqual(reasons(topUp(NOV_02)), ['calendar_stale']);
    assert.deepEqual(
      reservationRow(db, reservationId(1))?.['max_liability'],
      '20',
    );
    value('budget.calendar_advance', advance(db, NOV_02));
    // 11 月の予約で llm を満たしても、10 月の予約の追加予約は 10 月の上限（20＋10＝30 ≦ 80）で検査する。
    admit(
      db,
      admitOp(
        2,
        { reserved: '0', max: '80' },
        { budget_month: '2030-11', now: NOV_02 },
      ),
    );
    const grown = value('budget.top_up', topUp(NOV_02)).reservation;
    assert.deepEqual(
      [grown.budgetMonth, grown.maxLiability, grown.revision],
      ['2030-10', '30', '2'],
    );
  });
});

// B07-03 の Codex のレビュー P2: 承認した M の固定は DB の trigger でも守る（直接の SQL で版を上げても変えられない）。
test('the max liability of a reservation admitted with an overage approval cannot be changed by SQL', async () => {
  await withBudget((db) => {
    admit(db, admitOp(1, { reserved: '10', max: '80' }));
    value(
      'budget.request_overage',
      run(db, {
        kind: 'budget.request_overage',
        approval_id: approvalId(1),
        request_id: budgetRequestId(2),
        pool_id: 'overage',
        budget_month: '2030-10',
        currency: 'XTS',
        max_liability: '20',
        overage_remaining: '60',
        now: OCT_15,
        expires_at: OCT_15 + 600_000,
      }),
    );
    value(
      'budget.approve_overage',
      run(db, {
        kind: 'budget.approve_overage',
        approval_id: approvalId(1),
        budget_request_id: budgetRequestId(2),
        currency: 'XTS',
        max_liability: '20',
        decision: 'approve',
        now: OCT_15 + 1000,
        request: null,
      }),
    );
    assert.equal(
      admit(
        db,
        admitOp(
          2,
          { reserved: '5', max: '20' },
          { overage: OWNER_ROUTE, now: OCT_15 + 2000 },
        ),
      ).routed,
      true,
    );
    for (const sql of [
      'UPDATE budget_reservations SET max_liability = 21, reservation_revision = 2 WHERE reservation_id = ?',
      'UPDATE budget_reservations SET max_liability = 19 WHERE reservation_id = ?',
    ])
      assert.throws(
        () => db.prepare(sql).run(reservationId(2)),
        /budget_approval_fixes_max_liability/u,
      );
    assert.deepEqual(
      reservationRow(db, reservationId(2))?.['max_liability'],
      '20',
    );
  });
});

// B07-03 の Codex のレビュー P1（2 回目）: 設定から枠を消した後、その月に経路を解けない予約が残っていれば、その使用量を
// 親の枠に数えられないので、残った兄弟の枠への受付・追加予約と利用状況を閉じた側に倒して拒否する。
test('usage left in a removed pool blocks admission and top-up into sibling pools and the usage summary', async () => {
  await withBudget((db) => {
    // 削除の前: llm に M 80、search に M 20（llm_search は 100 ちょうど）。
    admit(db, admitOp(1, { reserved: '10', max: '80' }));
    admit(db, admitOp(2, { reserved: '5', max: '20' }, { pool_id: 'search' }));
    const withoutLlm = {
      ...SETTINGS,
      pools: SETTINGS.pools.filter(
        (pool) => pool.poolId !== 'llm' && pool.poolId !== 'llm.background',
      ),
    };
    // 削除の後に search へ M 15 を足すと、消えた llm の 80 を数えなければ llm_search は 35 ≦ 100 に見えるが、本当は 115。
    // search の自分の上限（40）には 20＋15＝35 で収まる。追加予約の 20 も search は 40 ちょうどで、本当の llm_search は 120。
    const sibling = admit(
      db,
      admitOp(
        3,
        { reserved: '5', max: '15' },
        { pool_id: 'search', settings: withoutLlm },
      ),
    );
    assert.deepEqual(
      [sibling.admitted, sibling.reason_codes],
      [false, ['reservation_pool_unknown']],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.top_up',
          reservation_id: reservationId(2),
          expected_revision: '1',
          delta_reserved: '0',
          delta_max_liability: '20',
          settings: withoutLlm,
          now: OCT_15,
        }),
      ),
      ['reservation_pool_unknown'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.summary',
          settings: withoutLlm,
          config_valid: true,
          now: OCT_15 + 5000,
        }),
      ),
      ['unknown_pool'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 2);
    assert.deepEqual(
      reservationRow(db, reservationId(2))?.['max_liability'],
      '20',
    );
  });
});

// --- B07-04（0007、ADR 0037）: 予算月の確かめ直しと送出意図 ---

const calendarCheck = (db: SqliteDatabase, now: number) =>
  value(
    'budget.calendar_check',
    run(db, { kind: 'budget.calendar_check', now }),
  );

const confirm = (
  db: SqliteDatabase,
  input: {
    readonly n: number;
    readonly reason: 'invalid_calendar_state' | 'clock_regressed';
    readonly month: string;
    readonly monthStart: number;
    readonly now: number;
    // 本人が見た状態の版と時計（既定は版 0・今の時計）。
    readonly revision?: string;
    readonly observedAt?: number;
  },
): BudgetOpResult =>
  run(db, {
    kind: 'budget.calendar_confirm',
    confirmation_id: uuid(0xf00000 + input.n),
    reason: input.reason,
    month: input.month,
    month_start: input.monthStart,
    expected_revision: input.revision ?? '0',
    observed_at: input.observedAt ?? input.now,
    now: input.now,
  });

// 東京の 10 月の始まり（2030-09-30T15:00Z）と、1 時間遅い始まり（古い tz データで作った記録の模擬）。
const TOKYO_OCT_START = 1917010800000;
const DRIFTED_OCT_START = 1917014400000;
// 東京の 11 月・12 月の始まり（2030-10-31T15:00Z・2030-11-30T15:00Z）。
const TOKYO_NOV_START = 1919689200000;
const TOKYO_DEC_START = 1922281200000;

test('the owner re-verifies a month start that no longer matches the time zone data: the record stays and admission resumes', async () => {
  await withBudget(
    (db) => {
      db.prepare(
        "INSERT INTO budget_months (month, time_zone, month_start, month_start_time_zone, recorded_at) VALUES ('2030-10', 'Asia/Tokyo', ?, 'Asia/Tokyo', ?)",
      ).run(DRIFTED_OCT_START, DRIFTED_OCT_START);
      assert.deepEqual(calendarCheck(db, OCT_15), {
        state: {
          month: '2030-10',
          timeZone: 'Asia/Tokyo',
          monthStart: '2030-09-30T16:00:00.000Z',
          monthStartTimeZone: 'Asia/Tokyo',
        },
        reasons: ['invalid_calendar_state'],
        stale: false,
        recorded_month_start: '2030-09-30T16:00:00.000Z',
        recomputed_month_start: '2030-09-30T15:00:00.000Z',
        regression_floor: null,
        confirmation_revision: '0',
      });
      const base = {
        n: 1,
        reason: 'invalid_calendar_state' as const,
        month: '2030-10',
        monthStart: TOKYO_OCT_START,
        now: OCT_15,
      };
      // 理由・月・始まりのどれかが本人の見た値と違えば記録しない。
      assert.deepEqual(
        reasons(confirm(db, { ...base, reason: 'clock_regressed' })),
        ['nothing_to_confirm'],
      );
      assert.deepEqual(
        reasons(confirm(db, { ...base, monthStart: DRIFTED_OCT_START })),
        ['confirmation_mismatch'],
      );
      assert.deepEqual(reasons(confirm(db, { ...base, month: '2030-11' })), [
        'confirmation_mismatch',
      ]);
      assert.equal(
        count(db, 'SELECT count(*) FROM budget_month_confirmations'),
        0,
      );
      const confirmed = value('budget.calendar_confirm', confirm(db, base));
      assert.deepEqual(confirmed.reasons, []);
      assert.equal(confirmed.state?.monthStart, '2030-09-30T15:00:00.000Z');
      assert.equal(confirmed.recorded_month_start, '2030-09-30T16:00:00.000Z');
      // 予算月の記録は書き換えない。確かめ直しは別の行。
      assert.deepEqual(
        db.prepare('SELECT month, month_start FROM budget_months').all(),
        [{ month: '2030-10', month_start: DRIFTED_OCT_START }],
      );
      assert.deepEqual(
        db
          .prepare(
            'SELECT month, kind, previous_month_start, month_start, regression_floor, confirmed_at FROM budget_month_confirmations',
          )
          .all(),
        [
          {
            month: '2030-10',
            kind: 'start_reverified',
            previous_month_start: DRIFTED_OCT_START,
            month_start: TOKYO_OCT_START,
            regression_floor: null,
            confirmed_at: OCT_15,
          },
        ],
      );
      assert.equal(
        admit(db, admitOp(1, { reserved: '1', max: '1' })).admitted,
        true,
      );
      // 同じ入力の送り直しは古い（版が 1 に進んだ）。新しい版でも、止まっていなければ記録しない。
      assert.deepEqual(reasons(confirm(db, { ...base, n: 2 })), [
        'confirmation_stale',
      ]);
      assert.deepEqual(reasons(confirm(db, { ...base, n: 3, revision: '1' })), [
        'nothing_to_confirm',
      ]);
      // 確かめ直した月から次の月へ進める。
      assert.equal(
        value('budget.calendar_advance', advance(db, NOV_02)).rolled_over,
        true,
      );
      // 記録の行は SQL でも書き換えられない。
      assert.throws(
        () => db.exec('UPDATE budget_month_confirmations SET month_start = 0'),
        /budget_month_confirmation_fixed/u,
      );
      assert.throws(
        () => db.exec('DELETE FROM budget_month_confirmations'),
        /budget_month_confirmation_fixed/u,
      );
    },
    { calendar: false },
  );
});

test('the owner accepts a regressed clock: the month never moves back and a further regression holds again', async () => {
  await withBudget((db) => {
    value('budget.calendar_advance', advance(db, NOV_02));
    // 時計が 10 月 15 日へ戻った（11 月の始まりより前）。
    const back = OCT_15;
    assert.deepEqual(
      reasons(
        run(
          db,
          admitOp(
            1,
            { reserved: '1', max: '1' },
            {
              budget_month: '2030-11',
              now: back,
            },
          ),
        ),
      ),
      ['clock_regressed'],
    );
    assert.deepEqual(calendarCheck(db, back).reasons, ['clock_regressed']);
    assert.deepEqual(
      reasons(
        confirm(db, {
          n: 1,
          reason: 'clock_regressed',
          month: '2030-11',
          monthStart: TOKYO_OCT_START,
          now: back,
        }),
      ),
      ['confirmation_mismatch'],
    );
    const accepted = value(
      'budget.calendar_confirm',
      confirm(db, {
        n: 2,
        reason: 'clock_regressed',
        month: '2030-11',
        monthStart: TOKYO_NOV_START,
        now: back,
      }),
    );
    assert.deepEqual(accepted.reasons, []);
    assert.equal(accepted.regression_floor, '2030-10-15T00:00:00.000Z');
    // 予算月は 11 月のまま受け付ける（10 月へ戻さない）。
    const admitted = admit(
      db,
      admitOp(
        1,
        { reserved: '1', max: '1' },
        {
          budget_month: '2030-11',
          now: back + 1000,
        },
      ),
    );
    assert.equal(admitted.reservation?.budgetMonth, '2030-11');
    assert.deepEqual(
      reasons(
        run(
          db,
          admitOp(
            2,
            { reserved: '1', max: '1' },
            {
              budget_month: '2030-10',
              now: back + 1000,
            },
          ),
        ),
      ),
      ['budget_month_not_current'],
    );
    // 下限よりさらに戻れば、また保留する。
    assert.deepEqual(
      reasons(
        run(
          db,
          admitOp(
            3,
            { reserved: '1', max: '1' },
            {
              budget_month: '2030-11',
              now: back - 1,
            },
          ),
        ),
      ),
      ['clock_regressed'],
    );
    // 前の確かめ直しの入力の送り直しは、さらに戻った時計を承認しない（版が 1 に進んだ。Codex のレビュー P2）。
    const accept = {
      reason: 'clock_regressed' as const,
      month: '2030-11',
      monthStart: TOKYO_NOV_START,
    };
    assert.deepEqual(
      reasons(
        confirm(db, { ...accept, n: 3, observedAt: back, now: back - 1 }),
      ),
      ['confirmation_stale'],
    );
    // 新しい版でも、本人が見た時計より今の時計がさらに戻っていれば古い入力。
    assert.deepEqual(
      reasons(
        confirm(db, {
          ...accept,
          n: 4,
          revision: '1',
          observedAt: back,
          now: back - 1,
        }),
      ),
      ['confirmation_stale'],
    );
    // 今の状態を見直した入力なら、見た時計を新しい下限にする（実行時の時計ではない）。
    const again = value(
      'budget.calendar_confirm',
      confirm(db, {
        ...accept,
        n: 5,
        revision: '1',
        observedAt: back - 1,
        now: back - 1,
      }),
    );
    assert.deepEqual(
      [again.reasons, again.regression_floor, again.confirmation_revision],
      [[], '2030-10-14T23:59:59.999Z', '2'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM budget_months'), 2);
    // 正しい時刻が 12 月の始まりを越えれば、普通に次の月へ進む。
    assert.deepEqual(
      value('budget.calendar_advance', advance(db, TOKYO_DEC_START)),
      {
        state: {
          month: '2030-12',
          timeZone: 'Asia/Tokyo',
          monthStart: '2030-11-30T15:00:00.000Z',
          monthStartTimeZone: 'Asia/Tokyo',
        },
        rolled_over: true,
        recorded: true,
      },
    );
  });
});

test('the dispatch intent is the final check before sending: once, only while reserved and not safety-stopped, and never released after', async () => {
  await withBudget((db) => {
    for (const n of [1, 2, 3])
      admit(db, admitOp(n, { reserved: '1', max: '2' }));
    const dispatch = (n: number, now = OCT_15 + 10) =>
      run(db, {
        kind: 'budget.dispatch_intent',
        reservation_id: reservationId(n),
        now,
        deadline: OCT_15 + 60_000,
      });
    const release = (n: number) =>
      run(db, {
        kind: 'budget.release_unsent',
        reservation_id: reservationId(n),
        provider_request_sent: false,
      });
    assert.equal(
      value('budget.dispatch_intent', dispatch(1)).reservation.dispatchIntentAt,
      OCT_15 + 10,
    );
    // 二度目の送出意図は記録しない（自動の再送をしない）。送った可能性がある予約は解放しない。
    assert.deepEqual(reasons(dispatch(1, OCT_15 + 20)), ['already_dispatched']);
    assert.deepEqual(reasons(release(1)), ['possibly_sent']);
    const listed = value(
      'budget.unsettled_list',
      run(db, { kind: 'budget.unsettled_list' }),
    );
    assert.deepEqual(
      listed.map((item) => [
        item.reservation.reservationId,
        item.reservation.dispatchIntentAt,
        item.live_session,
      ]),
      [
        [reservationId(1), OCT_15 + 10, false],
        [reservationId(2), null, false],
        [reservationId(3), null, false],
      ],
    );
    run(db, { kind: 'budget.mark_unknown', reservation_id: reservationId(1) });
    assert.deepEqual(reasons(dispatch(1)), [
      'reservation_invalid',
      'already_dispatched',
    ]);
    // 安全停止の間は送出意図を記録しない。記録のない予約は解放できる。
    db.exec(
      "INSERT OR REPLACE INTO safety_breaker (singleton, state, safety_revision, stop_reason, stopped_at) VALUES (1, 'stopped', 1, 'rate_exceeded', 1000)",
    );
    assert.deepEqual(reasons(dispatch(2)), ['safety_stopped']);
    assert.equal(reservationRow(db, reservationId(2))?.['status'], 'reserved');
    assert.equal(value('budget.release_unsent', release(2)).duplicate, false);
    db.exec(
      "UPDATE safety_breaker SET state = 'running', stop_reason = NULL, stopped_at = NULL WHERE singleton = 1",
    );
    value('budget.dispatch_intent', dispatch(3));
    // DB の制約が最終の保証: 送出意図は消せず、送出意図のある予約は解放できない。
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE budget_reservations SET dispatch_intent_at = NULL WHERE reservation_id = ?',
          )
          .run(reservationId(3)),
      /budget_dispatch_intent_fixed/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE budget_reservations SET status = 'released' WHERE reservation_id = ?",
          )
          .run(reservationId(3)),
      /budget_dispatched_not_releasable/u,
    );
    // 送出意図と解放を 1 つの UPDATE で同時に書いても拒否する（Codex のレビュー P2）。行は変わらない。
    admit(db, admitOp(4, { reserved: '1', max: '2' }));
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE budget_reservations SET dispatch_intent_at = 1000, status = 'released' WHERE reservation_id = ?",
          )
          .run(reservationId(4)),
      /budget_dispatched_not_releasable/u,
    );
    assert.deepEqual(
      [
        reservationRow(db, reservationId(4))?.['status'],
        db
          .prepare(
            'SELECT dispatch_intent_at FROM budget_reservations WHERE reservation_id = ?',
          )
          .pluck()
          .get(reservationId(4)),
      ],
      ['reserved', null],
    );
    // 応答の期限（M を計算した課金期間の終わり）ちょうど以降は送出意図を記録しない（Codex のレビュー P1）。
    admit(db, admitOp(5, { reserved: '1', max: '2' }));
    const deadline = OCT_15 + 60_000;
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.dispatch_intent',
          reservation_id: reservationId(5),
          now: deadline,
          deadline,
        }),
      ),
      ['reservation_expired'],
    );
    assert.equal(
      value(
        'budget.dispatch_intent',
        run(db, {
          kind: 'budget.dispatch_intent',
          reservation_id: reservationId(5),
          now: deadline - 1,
          deadline,
        }),
      ).reservation.dispatchIntentAt,
      deadline - 1,
    );
    assert.equal(
      value('budget.unsettled_list', run(db, { kind: 'budget.unsettled_list' }))
        .length,
      3,
    );
  });
});
