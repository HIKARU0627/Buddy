// 付帯クレジットの保存（B07-07、ADR 0042）を worker を介さずに同期で確かめる。マイグレーションは足さず、0006 の予約の
// 列（credit_applied・additional_spend・credit_cycle_id）に、受付時に周期へ結び付け、精算で区分を分けて書く。
// 期待値（受付の可否・理由・クレジット・追加の支出・台帳の合計）は、合成の上限（予算の通貨 XTS）と ADR 0042 の規則から
// 手で書いた値で、実装の処理から作っていない。模擬の試験だけで、実 API・実請求は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CreditBasis } from '@buddy/domain';
import { executeBudgetOp } from './index.js';
import type {
  BudgetOp,
  BudgetOpResult,
  BudgetOpValues,
  SqliteDatabase,
} from './index.js';
import {
  OCT_15,
  TIME_ZONE,
  admitOp,
  budgetRequestId,
  count,
  request,
  reservationId,
  uuid,
} from './budget-test-support.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const CONTEXT = { platform: 'macos', halted: false } as const;
const CYCLE = 'anthropic:2030-10-01';
const MAX_AGE = 3_600_000;

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

async function withBudget(body: (db: SqliteDatabase) => void): Promise<void> {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      value(
        'budget.calendar_advance',
        run(db, {
          kind: 'budget.calendar_advance',
          now: OCT_15,
          time_zone: TIME_ZONE,
        }),
      );
      body(db);
    } finally {
      db.close();
    }
  });
}

// 周期 2030-10-01（11 月 1 日 0 時 UTC まで）の観測。2030-10-15 に観測した予算の通貨の残高。
const basis = (
  balance: string,
  overrides: Partial<CreditBasis> = {},
): CreditBasis => ({
  cycleId: CYCLE,
  cycleStart: Date.parse('2030-10-01T00:00:00.000Z'),
  observedAt: OCT_15,
  expiresAt: Date.parse('2030-11-01T00:00:00.000Z'),
  status: 'observed',
  shared: false,
  balance,
  ...overrides,
});

const credited = (
  n: number,
  amounts: { readonly reserved: string; readonly max: string },
  balance: string,
  overrides: Partial<Extract<BudgetOp, { kind: 'budget.admit' }>> = {},
) =>
  admitOp(n, amounts, {
    credit: { basis: basis(balance), shared_max_age_ms: MAX_AGE },
    ...overrides,
  });

const settle = (
  n: number,
  actual: string,
  balance: string | null,
  now = OCT_15 + 1000,
): Extract<BudgetOp, { kind: 'budget.settle' }> => ({
  kind: 'budget.settle',
  reservation_id: reservationId(n),
  request_id: budgetRequestId(n),
  provider: 'anthropic',
  provider_reconciliation_id: `msg-${n}`,
  actual_gross: actual,
  credit: balance === null ? null : { bases: [basis(balance)] },
  now,
});

const ledger = (
  db: SqliteDatabase,
  since = OCT_15,
  exclude: string | null = null,
) =>
  value(
    'budget.credit_ledger',
    run(db, {
      kind: 'budget.credit_ledger',
      cycle_id: CYCLE,
      since,
      exclude_reservation_id: exclude,
    }),
  );

const split = (db: SqliteDatabase, n: number) =>
  db
    .prepare(
      'SELECT status, actual_gross, credit_applied, additional_spend, credit_cycle_id FROM budget_reservations WHERE reservation_id = ?',
    )
    .get(reservationId(n));

test('a credited admission needs the whole M inside the remaining credit, binds the reservation to the cycle and holds concurrent requests against it', async () => {
  await withBudget((db) => {
    // 残高 60。a（M 30）→ 残り 60、b（M 20）→ 残り 30。どちらも受け付け、周期に結び付ける。
    const a = value(
      'budget.admit',
      run(db, credited(1, { reserved: '10', max: '30' }, '60')),
    );
    assert.equal(a.admitted, true);
    assert.equal(a.reservation?.creditCycleId, CYCLE);
    const b = value(
      'budget.admit',
      run(db, credited(2, { reserved: '10', max: '20' }, '60')),
    );
    assert.equal(b.admitted, true);
    assert.deepEqual(ledger(db), { allocated_since: '0', outstanding: '50' });
    // c（M 20）は残り 60 − 50 = 10 に収まらない。枠の上限には収まるので、理由はクレジットだけ。行は作らない。
    const c = value(
      'budget.admit',
      run(db, credited(3, { reserved: '10', max: '20' }, '60')),
    );
    assert.deepEqual(
      [c.admitted, c.reason_codes, c.reservation],
      [false, ['credit_insufficient'], null],
    );
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 2);
    // 枠の上限にも収まらないときは、枠の理由にクレジットの理由が続く。
    const d = value(
      'budget.admit',
      run(db, credited(4, { reserved: '10', max: '40' }, '60')),
    );
    // 最大負担の上限（llm は 80。受付済みの M 50 + 40 = 90）にも収まらない。R は収まる（20 + 10 = 30）。
    assert.deepEqual(d.reason_codes, ['m_limit:llm', 'credit_insufficient']);
    // 残りちょうどの M は受け付ける（残り 10 に M 10）。その後は残り 0 で、M 1 も枯渇。
    const e = value(
      'budget.admit',
      run(db, credited(5, { reserved: '5', max: '10' }, '60')),
    );
    assert.equal(e.admitted, true);
    const f = value(
      'budget.admit',
      run(db, credited(6, { reserved: '1', max: '1' }, '60')),
    );
    assert.deepEqual(f.reason_codes, ['credit_exhausted']);
    assert.deepEqual(ledger(db), { allocated_since: '0', outstanding: '60' });
  });
});

test('a request that is not credited, or whose credit state cannot be confirmed, is decided as before and never takes a cycle', async () => {
  await withBudget((db) => {
    // credit なし（省略・null）は周期に結び付けず、クレジットの理由で拒否しない。
    const plain = value(
      'budget.admit',
      run(db, admitOp(1, { reserved: '5', max: '10' })),
    );
    assert.equal(plain.reservation?.creditCycleId, null);
    const nulled = value(
      'budget.admit',
      run(db, admitOp(2, { reserved: '5', max: '10' }, { credit: null })),
    );
    assert.equal(nulled.reservation?.creditCycleId, null);
    // 観測がない・不明・失効・古い共有の観測は、クレジットの保留で拒否する（行を作らない）。
    const holds: [
      string,
      Partial<Extract<BudgetOp, { kind: 'budget.admit' }>>,
    ][] = [
      [
        'credit_unknown',
        { credit: { basis: null, shared_max_age_ms: MAX_AGE } },
      ],
      [
        'credit_unknown',
        {
          credit: {
            basis: basis('100', { status: 'unknown', balance: null }),
            shared_max_age_ms: MAX_AGE,
          },
        },
      ],
      [
        'credit_expired',
        {
          credit: {
            basis: basis('100', { status: 'expired', balance: null }),
            shared_max_age_ms: MAX_AGE,
          },
        },
      ],
      [
        'credit_expired',
        {
          credit: {
            basis: basis('100', { expiresAt: OCT_15 }),
            shared_max_age_ms: MAX_AGE,
          },
        },
      ],
      [
        'credit_stale',
        {
          credit: {
            basis: basis('100', {
              shared: true,
              observedAt: OCT_15 - MAX_AGE - 1,
            }),
            shared_max_age_ms: MAX_AGE,
          },
        },
      ],
    ];
    for (const [index, [expected, overrides]] of holds.entries()) {
      const held = value(
        'budget.admit',
        run(db, admitOp(10 + index, { reserved: '1', max: '2' }, overrides)),
      );
      assert.deepEqual(held.reason_codes, [expected], `${index}`);
      assert.equal(held.reservation, null);
    }
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 2);
    // 同じ request_id の送り直しは、クレジットの状態が変わっていても保存済みの予約を返す。
    const again = value(
      'budget.admit',
      run(db, credited(1, { reserved: '5', max: '10' }, '0')),
    );
    assert.deepEqual([again.duplicate, again.admitted], [true, true]);
  });
});

test('a settlement splits the actual cost between the credit and the additional spend inside the cycle of the reservation, once', async () => {
  await withBudget((db) => {
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '10', max: '30' }, '60')),
    );
    value(
      'budget.admit',
      run(db, credited(2, { reserved: '10', max: '20' }, '60')),
    );
    // a: 実費 25。残り = 60 − 精算したクレジット 0 − ほかの未精算の M（b の 20）= 40。クレジットは min(25, M 30, 40) = 25。
    const a = value('budget.settle', run(db, settle(1, '25', '60')));
    assert.deepEqual([a.duplicate, a.overrun], [false, false]);
    assert.deepEqual(split(db, 1), {
      status: 'settled',
      actual_gross: 25,
      credit_applied: 25,
      additional_spend: 0,
      credit_cycle_id: CYCLE,
    });
    // b: 実費 25 は M 20 を超える。残り = 60 − 25 − 0 = 35。クレジットは min(25, M 20, 35) = 20、超えた 5 は追加の支出。
    const b = value('budget.settle', run(db, settle(2, '25', '60')));
    assert.deepEqual([b.duplicate, b.overrun], [false, true]);
    assert.deepEqual(split(db, 2), {
      status: 'settled',
      actual_gross: 25,
      credit_applied: 20,
      additional_spend: 5,
      credit_cycle_id: CYCLE,
    });
    assert.deepEqual(ledger(db), { allocated_since: '45', outstanding: '0' });
    // 観測の時刻より前に精算した分は引かない（観測した残高に含まれている）。
    assert.deepEqual(ledger(db, OCT_15 + 1001), {
      allocated_since: '0',
      outstanding: '0',
    });
    // 同じ usage の再適用は変化なし。区分は変わらない。違う実費は競合。
    const again = value(
      'budget.settle',
      run(db, settle(1, '25', '60', OCT_15 + 5000)),
    );
    assert.equal(again.duplicate, true);
    assert.deepEqual(reasons(run(db, settle(1, '26', '60'))), [
      'settlement_conflict',
    ]);
    assert.deepEqual(split(db, 1), {
      status: 'settled',
      actual_gross: 25,
      credit_applied: 25,
      additional_spend: 0,
      credit_cycle_id: CYCLE,
    });
  });
});

test('a settlement that cannot confirm the credit records zero credit and keeps the cycle of the reservation', async () => {
  await withBudget((db) => {
    for (const n of [1, 2, 3, 4])
      value(
        'budget.admit',
        run(db, credited(n, { reserved: '1', max: '10' }, '100')),
      );
    // 1: credit を渡さない。2: 観測がない（基準が空）。3: 周期が終わった後の精算。4: 別の周期の基準だけ。
    value('budget.settle', run(db, { ...settle(1, '8', null) }));
    value(
      'budget.settle',
      run(db, { ...settle(2, '8', null), credit: { bases: [] } }),
    );
    value(
      'budget.settle',
      run(db, settle(3, '8', '100', Date.parse('2030-11-01T00:00:00.000Z'))),
    );
    value(
      'budget.settle',
      run(db, {
        ...settle(4, '8', null),
        credit: {
          bases: [
            basis('100', {
              cycleId: 'anthropic:2030-11-01',
              cycleStart: Date.parse('2030-11-01T00:00:00.000Z'),
            }),
          ],
        },
      }),
    );
    for (const n of [1, 2, 3, 4])
      assert.deepEqual(split(db, n), {
        status: 'settled',
        actual_gross: 8,
        credit_applied: 0,
        additional_spend: 8,
        credit_cycle_id: CYCLE,
      });
    // 周期に結び付かない予約は、基準があってもクレジット 0。
    value('budget.admit', run(db, admitOp(5, { reserved: '1', max: '10' })));
    value('budget.settle', run(db, settle(5, '8', '100')));
    assert.deepEqual(split(db, 5), {
      status: 'settled',
      actual_gross: 8,
      credit_applied: 0,
      additional_spend: 8,
      credit_cycle_id: null,
    });
    assert.deepEqual(ledger(db), { allocated_since: '0', outstanding: '0' });
  });
});

test('the ledger counts the reserved and usage-unknown M until settlement, never a released one, and can leave out the reservation being settled', async () => {
  await withBudget((db) => {
    for (const n of [1, 2, 3])
      value(
        'budget.admit',
        run(db, credited(n, { reserved: '5', max: '10' }, '100')),
      );
    value(
      'budget.mark_unknown',
      run(db, {
        kind: 'budget.mark_unknown',
        reservation_id: reservationId(2),
      }),
    );
    value(
      'budget.release_unsent',
      run(db, {
        kind: 'budget.release_unsent',
        reservation_id: reservationId(3),
        provider_request_sent: false,
      }),
    );
    assert.deepEqual(ledger(db), { allocated_since: '0', outstanding: '20' });
    assert.deepEqual(ledger(db, OCT_15, reservationId(1)), {
      allocated_since: '0',
      outstanding: '10',
    });
    // 精算すると未精算から外れ、観測の時刻以後のクレジットになる。usage 不明の予約の精算も同じ。
    value('budget.settle', run(db, settle(2, '7', '100')));
    assert.deepEqual(ledger(db), { allocated_since: '7', outstanding: '10' });
  });
});

test('a manual settlement takes the split the owner reconciled only in the cycle of the reservation, once, and the sum is checked by the table', async () => {
  await withBudget((db) => {
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '5', max: '30' }, '100')),
    );
    value('budget.admit', run(db, admitOp(2, { reserved: '5', max: '30' })));
    for (const n of [1, 2])
      value(
        'budget.mark_unknown',
        run(db, {
          kind: 'budget.mark_unknown',
          reservation_id: reservationId(n),
        }),
      );
    const manual = (
      n: number,
      credit: string,
      additional: string,
      cycle: string | null,
      ref = request(n),
    ): Extract<BudgetOp, { kind: 'budget.settle_manual' }> => ({
      kind: 'budget.settle_manual',
      reservation_id: reservationId(n),
      expected_revision: '1',
      manual_reconciliation_id: `manual:inv-${n}`,
      currency: 'XTS',
      actual_gross: '30',
      credit_applied: credit,
      additional_spend: additional,
      credit_cycle_id: cycle,
      now: OCT_15 + 1000,
      request: ref,
    });
    assert.deepEqual(
      reasons(run(db, manual(1, '20', '10', 'anthropic:2030-11-01'))),
      ['credit_cycle_mismatch'],
    );
    assert.deepEqual(reasons(run(db, manual(1, '20', '9', CYCLE))), [
      'settlement_sum',
    ]);
    assert.deepEqual(reasons(run(db, manual(1, '20', '10', null))), [
      'missing_credit_cycle',
    ]);
    // 周期に結び付かない予約へは、クレジットを充てられない。
    assert.deepEqual(reasons(run(db, manual(2, '5', '25', CYCLE))), [
      'credit_cycle_mismatch',
    ]);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM budget_reservations WHERE status = 'settled'",
      ),
      0,
    );
    const ok = value(
      'budget.settle_manual',
      run(db, manual(1, '20', '10', CYCLE)),
    );
    assert.deepEqual([ok.duplicate, ok.replayed], [false, false]);
    assert.deepEqual(split(db, 1), {
      status: 'settled',
      actual_gross: 30,
      credit_applied: 20,
      additional_spend: 10,
      credit_cycle_id: CYCLE,
    });
    // 同じ要求の再送は保存済みの結果。別の要求で区分を変えると拒否し、記録は変わらない。
    const replay = value(
      'budget.settle_manual',
      run(db, manual(1, '20', '10', CYCLE)),
    );
    assert.deepEqual([replay.duplicate, replay.replayed], [true, true]);
    assert.deepEqual(
      reasons(run(db, manual(1, '30', '0', CYCLE, request(99, 'b')))),
      ['already_settled'],
    );
    // 区分を省略した手での精算は初期の規則（クレジット 0・追加の支出＝実費）。周期は予約のまま。
    const plain = {
      ...manual(2, '0', '30', null),
    } as Extract<BudgetOp, { kind: 'budget.settle_manual' }>;
    delete (plain as { credit_applied?: string }).credit_applied;
    delete (plain as { additional_spend?: string }).additional_spend;
    delete (plain as { credit_cycle_id?: string | null }).credit_cycle_id;
    value('budget.settle_manual', run(db, plain));
    assert.deepEqual(split(db, 2), {
      status: 'settled',
      actual_gross: 30,
      credit_applied: 0,
      additional_spend: 30,
      credit_cycle_id: null,
    });
    // DB の最終の保証: 実費 = クレジット + 追加の支出（CHECK）。合わない区分は SQL でも書けない。
    const third = value(
      'budget.admit',
      run(db, credited(3, { reserved: '5', max: '10' }, '100')),
    );
    assert.equal(third.admitted, true);
    assert.throws(() =>
      db
        .prepare(
          "UPDATE budget_reservations SET status = 'settled', actual_gross = 5, credit_applied = 4, additional_spend = 2, provider_reconciliation_id = 'x:bad', settlement_kind = 'provider', settled_at = 1 WHERE reservation_id = ?",
        )
        .run(reservationId(3)),
    );
    // 精算した区分と周期は変えられない（精算は一度だけ）。
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE budget_reservations SET credit_applied = 30, additional_spend = 0 WHERE reservation_id = ?',
          )
          .run(reservationId(1)),
      /budget_settlement_fixed/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE budget_reservations SET credit_cycle_id = 'anthropic:2030-11-01' WHERE reservation_id = ?",
          )
          .run(reservationId(1)),
      /budget_settlement_fixed/u,
    );
  });
});

test('malformed credit input is refused by the shape check before anything is written', async () => {
  await withBudget((db) => {
    const bad = (overrides: Partial<CreditBasis>): BudgetOp =>
      admitOp(
        1,
        { reserved: '1', max: '2' },
        {
          credit: { basis: basis('10', overrides), shared_max_age_ms: MAX_AGE },
        },
      );
    for (const overrides of [
      { cycleId: 'anthropic:2030-10' },
      { cycleId: 'Anthropic:2030-10-01' },
      { status: 'observed', balance: null } as Partial<CreditBasis>,
      { balance: '-1' },
      { balance: '1.5' },
      { balance: '1000000000000000000' },
      { shared: 'yes' as unknown as boolean },
      { observedAt: -1 },
      { expiresAt: 1.5 },
      { status: 'maybe' as unknown as CreditBasis['status'] },
    ])
      assert.deepEqual(
        reasons(run(db, bad(overrides))),
        ['credit_invalid'],
        JSON.stringify(overrides),
      );
    assert.deepEqual(
      reasons(
        run(
          db,
          admitOp(
            1,
            { reserved: '1', max: '2' },
            {
              credit: { basis: basis('10'), shared_max_age_ms: 0 },
            },
          ),
        ),
      ),
      ['credit_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          ...settle(1, '1', '10'),
          credit: { bases: [{ cycleId: 'x' } as unknown as CreditBasis] },
        }),
      ),
      ['credit_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.credit_ledger',
          cycle_id: 'someone@example.invalid',
          since: 1,
          exclude_reservation_id: null,
        }),
      ),
      ['credit_cycle_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.settle_manual',
          reservation_id: uuid(1),
          expected_revision: '1',
          manual_reconciliation_id: 'manual:x',
          currency: 'XTS',
          actual_gross: '1',
          credit_applied: '1.5',
          additional_spend: '-1',
          credit_cycle_id: 'free text',
          now: OCT_15,
          request: null,
        }),
      ),
      ['amount_invalid', 'credit_cycle_invalid'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 0);
  });
});
