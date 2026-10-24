// 付帯クレジットの保存（B07-07、ADR 0042、マイグレーション 0008）を worker を介さずに同期で確かめる。
// 観測は transaction の中で採用して永続化し（巻き戻りを拒否）、受付・追加予約・送出の直前・精算は採用済みの観測から判定する。
// 期待値（受付の可否・理由・クレジット・追加の支出・見積もり・台帳の合計）は、合成の上限（予算の通貨 XTS、残高の通貨 XXX は
// 換算 1）と ADR 0042 の規則から手で書いた値で、実装の処理から作っていない。模擬の試験だけで、実 API・実請求は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CreditObservationInput } from '@buddy/domain';
import { executeBudgetOp } from './index.js';
import type {
  BudgetCreditInput,
  BudgetOp,
  BudgetOpResult,
  BudgetOpValues,
  SqliteDatabase,
} from './index.js';
import {
  OCT_15,
  SETTINGS,
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
const CYCLE_NOV = 'anthropic:2030-11-01';
const MAX_AGE = 3_600_000;
const NOV_01 = Date.parse('2030-11-01T00:00:00.000Z');
const DEC_01 = '2030-12-01T00:00:00.000Z';

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

const advanceTo = (db: SqliteDatabase, now: number): void => {
  value(
    'budget.calendar_advance',
    run(db, { kind: 'budget.calendar_advance', now, time_zone: TIME_ZONE }),
  );
};

const iso = (millis: number): string => new Date(millis).toISOString();

// 設定: 残高の通貨 XXX は予算の通貨 XTS へ換算 1。共有の観測は 1 時間で古くなる。
const CONFIG = {
  provider: 'anthropic',
  profile_ids: ['claude.synthetic.v1'],
  balance_currency: 'XXX',
  balance_to_budget_rate: '1',
  shared_observation_max_age_ms: MAX_AGE,
};

// 周期 2030-10-01（11 月 1 日 0 時 UTC まで）の観測。既定は 2030-10-15 に観測した残高。
const obs = (
  balance: string | null,
  overrides: Partial<CreditObservationInput> = {},
): CreditObservationInput => ({
  provider: 'anthropic',
  organization_ref: 'synthetic-organization',
  cycle_id: CYCLE,
  observed_at: iso(OCT_15),
  expires_at: iso(NOV_01),
  balance: balance === null ? null : { currency: 'XXX', amount: balance },
  status: 'observed',
  shared: false,
  ...overrides,
});

const input = (
  ...observations: readonly CreditObservationInput[]
): BudgetCreditInput => ({
  config: CONFIG,
  budget_currency: 'XTS',
  observations,
});

const credited = (
  n: number,
  amounts: { readonly reserved: string; readonly max: string },
  credit: BudgetCreditInput | null,
  overrides: Partial<Extract<BudgetOp, { kind: 'budget.admit' }>> = {},
) => admitOp(n, amounts, { credit, ...overrides });

const settle = (
  n: number,
  actual: string,
  credit: BudgetCreditInput | null,
  now = OCT_15 + 1000,
): Extract<BudgetOp, { kind: 'budget.settle' }> => ({
  kind: 'budget.settle',
  reservation_id: reservationId(n),
  request_id: budgetRequestId(n),
  provider: 'anthropic',
  provider_reconciliation_id: `msg-${n}`,
  actual_gross: actual,
  credit,
  now,
});

const topUp = (
  n: number,
  revision: string,
  delta: string,
  credit: BudgetCreditInput | null,
  now = OCT_15,
): Extract<BudgetOp, { kind: 'budget.top_up' }> => ({
  kind: 'budget.top_up',
  reservation_id: reservationId(n),
  expected_revision: revision,
  delta_reserved: delta,
  delta_max_liability: delta,
  settings: SETTINGS,
  now,
  credit,
});

const dispatch = (
  n: number,
  credit: BudgetCreditInput | null,
  now = OCT_15,
): Extract<BudgetOp, { kind: 'budget.dispatch_intent' }> => ({
  kind: 'budget.dispatch_intent',
  reservation_id: reservationId(n),
  now,
  deadline: now + 60_000,
  credit,
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

const state = (db: SqliteDatabase, now: number, credit: BudgetCreditInput) =>
  value(
    'budget.credit_state',
    run(db, { kind: 'budget.credit_state', credit, now }),
  );

const split = (db: SqliteDatabase, n: number) =>
  db
    .prepare(
      'SELECT status, actual_gross, credit_applied, additional_spend, credit_estimate, credit_cycle_id FROM budget_reservations WHERE reservation_id = ?',
    )
    .get(reservationId(n));

const row = (db: SqliteDatabase, n: number) =>
  db
    .prepare(
      'SELECT status, reserved_amount, max_liability, reservation_revision, dispatch_intent_at, credit_cycle_id, credit_expires_at, credit_observation_seq FROM budget_reservations WHERE reservation_id = ?',
    )
    .get(reservationId(n)) as Record<string, unknown>;

const observationRows = (db: SqliteDatabase): number =>
  count(db, 'SELECT count(*) FROM budget_credit_observations');

test('a credited admission needs the whole M inside the remaining credit, binds the reservation to the cycle, its expiry and the adopted observation, and holds concurrent requests against it', async () => {
  await withBudget((db) => {
    const credit = input(obs('60'));
    // 残高 60。a（M 30）→ 残り 60、b（M 20）→ 残り 30。どちらも受け付け、周期・期限・観測の番号に結び付ける。
    const a = value(
      'budget.admit',
      run(db, credited(1, { reserved: '10', max: '30' }, credit)),
    );
    assert.equal(a.admitted, true);
    assert.equal(a.reservation?.creditCycleId, CYCLE);
    assert.equal(a.reservation?.creditExpiresAt, NOV_01);
    assert.equal(a.reservation?.creditObservationSeq, 1);
    const b = value(
      'budget.admit',
      run(db, credited(2, { reserved: '10', max: '20' }, credit)),
    );
    assert.equal(b.admitted, true);
    // 同じ内容の観測は一度だけ採用する。
    assert.equal(observationRows(db), 1);
    assert.deepEqual(ledger(db), { allocated_since: '0', outstanding: '50' });
    // c（M 20）は残り 60 − 50 = 10 に収まらない。枠の上限には収まるので、理由はクレジットだけ。行は作らない。
    const c = value(
      'budget.admit',
      run(db, credited(3, { reserved: '10', max: '20' }, credit)),
    );
    assert.deepEqual(
      [c.admitted, c.reason_codes, c.reservation],
      [false, ['credit_insufficient'], null],
    );
    assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 2);
    // 枠の上限（llm は 80。M 50 + 40 = 90）にも収まらないときは、枠の理由にクレジットの理由が続く。R は収まる。
    const d = value(
      'budget.admit',
      run(db, credited(4, { reserved: '10', max: '40' }, credit)),
    );
    assert.deepEqual(d.reason_codes, ['m_limit:llm', 'credit_insufficient']);
    // 残りちょうどの M は受け付ける（残り 10 に M 10）。その後は残り 0 で、M 1 も枯渇。
    const e = value(
      'budget.admit',
      run(db, credited(5, { reserved: '5', max: '10' }, credit)),
    );
    assert.equal(e.admitted, true);
    const f = value(
      'budget.admit',
      run(db, credited(6, { reserved: '1', max: '1' }, credit)),
    );
    assert.deepEqual(f.reason_codes, ['credit_exhausted']);
    assert.deepEqual(ledger(db), { allocated_since: '0', outstanding: '60' });
  });
});

test('an admission without credit is decided as before and never takes a cycle', async () => {
  await withBudget((db) => {
    const plain = value(
      'budget.admit',
      run(db, admitOp(1, { reserved: '5', max: '10' })),
    );
    assert.equal(plain.reservation?.creditCycleId, null);
    assert.equal(plain.reservation?.creditExpiresAt, null);
    assert.equal(plain.reservation?.creditObservationSeq, null);
    const nulled = value(
      'budget.admit',
      run(db, admitOp(2, { reserved: '5', max: '10' }, { credit: null })),
    );
    assert.equal(nulled.reservation?.creditCycleId, null);
    assert.equal(observationRows(db), 0);
    // 同じ request_id の送り直しは、クレジットの状態が変わっていても保存済みの予約を返す。
    const again = value(
      'budget.admit',
      run(db, credited(1, { reserved: '5', max: '10' }, input(obs('0')))),
    );
    assert.deepEqual([again.duplicate, again.admitted], [true, true]);
  });
});

const HOLDS: readonly (readonly [
  string,
  string,
  readonly CreditObservationInput[],
])[] = [
  ['no observation', 'credit_unknown', []],
  [
    'status unknown',
    'credit_unknown',
    [obs(null, { status: 'unknown', shared: true })],
  ],
  ['status expired', 'credit_expired', [obs('100', { status: 'expired' })]],
  [
    'at the end of the cycle',
    'credit_expired',
    [obs('100', { expires_at: iso(OCT_15) })],
  ],
  [
    'shared and older than the limit by one millisecond',
    'credit_stale',
    [obs('100', { shared: true, observed_at: iso(OCT_15 - MAX_AGE - 1) })],
  ],
  ['zero balance', 'credit_exhausted', [obs('0')]],
  [
    'balance in another currency',
    'credit_unknown',
    [obs('100', { balance: { currency: 'XTS', amount: '100' } })],
  ],
  [
    'another provider',
    'credit_unknown',
    [obs('100', { provider: 'openai', cycle_id: 'openai:2030-10-01' })],
  ],
  [
    'observed after now',
    'credit_unknown',
    [obs('100', { observed_at: iso(OCT_15 + 1000) })],
  ],
];

for (const [title, expected, observations] of HOLDS)
  test(`a credited admission is held when the balance is unconfirmed: ${title}`, async () => {
    await withBudget((db) => {
      const held = value(
        'budget.admit',
        run(
          db,
          credited(1, { reserved: '1', max: '2' }, input(...observations)),
        ),
      );
      assert.deepEqual(held.reason_codes, [expected]);
      assert.equal(held.reservation, null);
      assert.equal(count(db, 'SELECT count(*) FROM budget_reservations'), 0);
    });
  });

test('a settlement splits the actual cost between the credit and the additional spend inside the cycle of the reservation, once, and keeps the estimate equal to the credit', async () => {
  await withBudget((db) => {
    const credit = input(obs('60'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '10', max: '30' }, credit)),
    );
    value(
      'budget.admit',
      run(db, credited(2, { reserved: '10', max: '20' }, credit)),
    );
    // a: 実費 25。残り = 60 − 精算したクレジット 0 − ほかの未精算の M（b の 20）= 40。クレジットは min(25, M 30, 40) = 25。
    const a = value('budget.settle', run(db, settle(1, '25', credit)));
    assert.deepEqual([a.duplicate, a.overrun], [false, false]);
    assert.deepEqual(split(db, 1), {
      status: 'settled',
      actual_gross: 25,
      credit_applied: 25,
      additional_spend: 0,
      credit_estimate: 25,
      credit_cycle_id: CYCLE,
    });
    // b: 実費 25 は M 20 を超える。残り = 60 − 25 − 0 = 35。クレジットは min(25, M 20, 35) = 20、超えた 5 は追加の支出。
    const b = value('budget.settle', run(db, settle(2, '25', credit)));
    assert.deepEqual([b.duplicate, b.overrun], [false, true]);
    assert.deepEqual(split(db, 2), {
      status: 'settled',
      actual_gross: 25,
      credit_applied: 20,
      additional_spend: 5,
      credit_estimate: 20,
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
      run(db, settle(1, '25', credit, OCT_15 + 5000)),
    );
    assert.equal(again.duplicate, true);
    assert.deepEqual(reasons(run(db, settle(1, '26', credit))), [
      'settlement_conflict',
    ]);
    assert.deepEqual(split(db, 1), {
      status: 'settled',
      actual_gross: 25,
      credit_applied: 25,
      additional_spend: 0,
      credit_estimate: 25,
      credit_cycle_id: CYCLE,
    });
  });
});

test('a settlement that cannot confirm the credit records zero credit but keeps min(actual, M) as consumed until a newer observation arrives', async () => {
  await withBudget((db) => {
    const credit = input(obs('100'));
    for (const n of [1, 2, 3])
      value(
        'budget.admit',
        run(db, credited(n, { reserved: '1', max: '10' }, credit)),
      );
    // 1: クレジットの入力がない。2: 採用した観測の後に、不明と記録した新しい観測が届いた。3: 周期の終わりの後の精算。
    value('budget.settle', run(db, settle(1, '8', null)));
    value(
      'budget.settle',
      run(
        db,
        settle(
          2,
          '8',
          input(
            obs('100'),
            obs(null, { status: 'unknown', observed_at: iso(OCT_15 + 500) }),
          ),
          OCT_15 + 2000,
        ),
      ),
    );
    value('budget.settle', run(db, settle(3, '8', credit, NOV_01)));
    for (const n of [1, 2, 3])
      assert.deepEqual(split(db, n), {
        status: 'settled',
        actual_gross: 8,
        credit_applied: 0,
        additional_spend: 8,
        credit_estimate: 8,
        credit_cycle_id: CYCLE,
      });
    // 周期に結び付かない予約は、基準があってもクレジット 0・見積もり 0。
    value('budget.admit', run(db, admitOp(4, { reserved: '1', max: '10' })));
    value('budget.settle', run(db, settle(4, '8', credit)));
    assert.deepEqual(split(db, 4), {
      status: 'settled',
      actual_gross: 8,
      credit_applied: 0,
      additional_spend: 8,
      credit_estimate: 0,
      credit_cycle_id: null,
    });
    // 見積もりは台帳に残る（観測の時刻を 1.5 秒後とすると、それより前の精算 1 は引かず、2・3 の 16）。
    assert.deepEqual(ledger(db, OCT_15 + 1500), {
      allocated_since: '16',
      outstanding: '0',
    });
  });
});

test('regression: a consumed balance is not reused when the settlement could not see the observation, until a newer observation arrives', async () => {
  await withBudget((db) => {
    const credit = input(obs('40'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    // provider は実費 30 をクレジットから消費したが、精算の時に観測の入力を渡せなかった。
    value('budget.settle', run(db, settle(1, '30', null)));
    assert.deepEqual(split(db, 1), {
      status: 'settled',
      actual_gross: 30,
      credit_applied: 0,
      additional_spend: 30,
      credit_estimate: 30,
      credit_cycle_id: CYCLE,
    });
    // 同じ観測のままでは、残り 40 − 30 = 10。M 40 は収まらない（以前は 40 に戻って受け付けた）。
    const again = value(
      'budget.admit',
      run(db, credited(2, { reserved: '40', max: '40' }, credit)),
    );
    assert.deepEqual(again.reason_codes, ['credit_insufficient']);
    // 本人が新しい観測（観測の時刻が精算より後）を書けば、その残高から数え直す。
    const fresh = input(
      obs('40'),
      obs('40', { observed_at: iso(OCT_15 + 5000) }),
    );
    const resumed = value(
      'budget.admit',
      run(
        db,
        credited(2, { reserved: '40', max: '40' }, fresh, {
          now: OCT_15 + 6000,
        }),
      ),
    );
    assert.equal(resumed.admitted, true);
  });
});

test('the ledger counts the reserved and usage-unknown M until settlement, never a released one, and can leave out the reservation being settled', async () => {
  await withBudget((db) => {
    const credit = input(obs('100'));
    for (const n of [1, 2, 3])
      value(
        'budget.admit',
        run(db, credited(n, { reserved: '5', max: '10' }, credit)),
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
    // 精算すると未精算から外れ、観測の時刻以後の見積もりになる。usage 不明の予約の精算も同じ。
    value('budget.settle', run(db, settle(2, '7', credit)));
    assert.deepEqual(ledger(db), { allocated_since: '7', outstanding: '10' });
  });
});

test('a manual settlement takes the split the owner reconciled only in the cycle of the reservation, once, with the estimate equal to the credit, and the sum is checked by the table', async () => {
  await withBudget((db) => {
    const credit = input(obs('100'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '5', max: '30' }, credit)),
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
      creditAmount: string,
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
      credit_applied: creditAmount,
      additional_spend: additional,
      credit_cycle_id: cycle,
      now: OCT_15 + 1000,
      request: ref,
    });
    assert.deepEqual(reasons(run(db, manual(1, '20', '10', CYCLE_NOV))), [
      'credit_cycle_mismatch',
    ]);
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
      credit_estimate: 20,
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
    const plain = { ...manual(2, '0', '30', null) } as Extract<
      BudgetOp,
      { kind: 'budget.settle_manual' }
    >;
    delete (plain as { credit_applied?: string }).credit_applied;
    delete (plain as { additional_spend?: string }).additional_spend;
    delete (plain as { credit_cycle_id?: string | null }).credit_cycle_id;
    value('budget.settle_manual', run(db, plain));
    assert.deepEqual(split(db, 2), {
      status: 'settled',
      actual_gross: 30,
      credit_applied: 0,
      additional_spend: 30,
      credit_estimate: 0,
      credit_cycle_id: null,
    });
  });
});

test('a top-up of a credited reservation is checked against the credit in the same transaction: remaining, expiry, bound expiry, staleness, unknown and missing input', async () => {
  // 残高 40 で M 40 を受け付けた後は、追加の 20 は賄えない（以前は M 60 まで増やせた）。
  await withBudget((db) => {
    const credit = input(obs('40'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    assert.deepEqual(reasons(run(db, topUp(1, '1', '20', credit))), [
      'credit_exhausted',
    ]);
    assert.deepEqual(row(db, 1), {
      status: 'reserved',
      reserved_amount: 40,
      max_liability: 40,
      reservation_revision: 1,
      dispatch_intent_at: null,
      credit_cycle_id: CYCLE,
      credit_expires_at: NOV_01,
      credit_observation_seq: 1,
    });
  });
  // 残高 70 で M 40: 追加 20 は残り 30 に収まり、次の追加 20 は残り 10 に収まらない。
  await withBudget((db) => {
    const credit = input(obs('70'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    const first = value('budget.top_up', run(db, topUp(1, '1', '20', credit)));
    assert.deepEqual(
      [first.reservation.revision, first.reservation.maxLiability],
      ['2', '60'],
    );
    assert.deepEqual(reasons(run(db, topUp(1, '2', '20', credit))), [
      'credit_insufficient',
    ]);
    assert.equal(
      value('budget.top_up', run(db, topUp(1, '2', '10', credit))).reservation
        .maxLiability,
      '70',
    );
  });
  // 周期の終わりの後の追加予約。観測が後から期限を延ばしても、受付の時点の期限（11 月 1 日）を過ぎたら失効。
  await withBudget((db) => {
    const credit = input(obs('100'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    advanceTo(db, NOV_01);
    assert.deepEqual(reasons(run(db, topUp(1, '1', '10', credit, NOV_01))), [
      'credit_expired',
    ]);
    const extended = input(
      obs('100'),
      obs('100', { observed_at: iso(OCT_15 + 1000), expires_at: DEC_01 }),
    );
    assert.deepEqual(
      reasons(run(db, topUp(1, '1', '10', extended, NOV_01 + 1))),
      ['credit_expired'],
    );
  });
  // 共有の観測が古い・不明と記録された・クレジットの入力がない。
  await withBudget((db) => {
    const credit = input(obs('100', { shared: true }));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    assert.deepEqual(
      reasons(run(db, topUp(1, '1', '10', credit, OCT_15 + MAX_AGE + 1))),
      ['credit_stale'],
    );
    assert.deepEqual(reasons(run(db, topUp(1, '1', '10', null))), [
      'credit_unknown',
    ]);
    const unknown = input(
      obs('100', { shared: true }),
      obs(null, { status: 'unknown', observed_at: iso(OCT_15 + 1000) }),
    );
    assert.deepEqual(
      reasons(run(db, topUp(1, '1', '10', unknown, OCT_15 + 2000))),
      ['credit_unknown'],
    );
  });
  // クレジットに結び付かない予約は、クレジットの入力がなくても追加予約できる。
  await withBudget((db) => {
    value('budget.admit', run(db, admitOp(1, { reserved: '10', max: '10' })));
    assert.equal(
      value('budget.top_up', run(db, topUp(1, '1', '10', null))).reservation
        .maxLiability,
      '20',
    );
  });
});

test('the check right before sending re-verifies the credit: expiry, unknown, observation drop and missing input stop it without recording the dispatch intent', async () => {
  // 残りちょうど（残高 40・M 40）は送れる。
  await withBudget((db) => {
    const credit = input(obs('40'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    const sent = value('budget.dispatch_intent', run(db, dispatch(1, credit)));
    assert.equal(sent.reservation.dispatchIntentAt, OCT_15);
  });
  // 受付の後に、他の用途で残高が減った新しい観測（30 < 確保した 40）。送らず、送出意図を記録せず、解放できる。
  await withBudget((db) => {
    const credit = input(obs('100'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    const lowered = input(
      obs('100'),
      obs('30', { observed_at: iso(OCT_15 + 1000) }),
    );
    assert.deepEqual(reasons(run(db, dispatch(1, lowered, OCT_15 + 2000))), [
      'credit_exhausted',
    ]);
    assert.equal(row(db, 1)?.['dispatch_intent_at'], null);
    value(
      'budget.release_unsent',
      run(db, {
        kind: 'budget.release_unsent',
        reservation_id: reservationId(1),
        provider_request_sent: false,
      }),
    );
  });
  // 失効（受付は 2030-10-15、送る時が周期の終わり）。受付の後に観測が期限を延ばしても、受付の時点の期限で止まる。
  await withBudget((db) => {
    const credit = input(obs('100'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    assert.deepEqual(reasons(run(db, dispatch(1, credit, NOV_01))), [
      'credit_expired',
    ]);
    const extended = input(
      obs('100'),
      obs('100', { observed_at: iso(OCT_15 + 1000), expires_at: DEC_01 }),
    );
    assert.deepEqual(reasons(run(db, dispatch(1, extended, NOV_01 + 1))), [
      'credit_expired',
    ]);
    assert.equal(row(db, 1)?.['dispatch_intent_at'], null);
  });
  // 不明と記録された新しい観測・共有の観測が古い・クレジットの入力がない。
  await withBudget((db) => {
    const credit = input(obs('100', { shared: true }));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '40', max: '40' }, credit)),
    );
    assert.deepEqual(
      reasons(run(db, dispatch(1, credit, OCT_15 + MAX_AGE + 1))),
      ['credit_stale'],
    );
    assert.deepEqual(reasons(run(db, dispatch(1, null))), ['credit_unknown']);
    const unknown = input(
      obs('100', { shared: true }),
      obs(null, { status: 'unknown', observed_at: iso(OCT_15 + 1000) }),
    );
    assert.deepEqual(reasons(run(db, dispatch(1, unknown, OCT_15 + 2000))), [
      'credit_unknown',
    ]);
  });
  // クレジットに結び付かない予約は、クレジットの入力がなくても送れる。
  await withBudget((db) => {
    value('budget.admit', run(db, admitOp(1, { reserved: '10', max: '10' })));
    assert.equal(
      value('budget.dispatch_intent', run(db, dispatch(1, null))).reservation
        .dispatchIntentAt,
      OCT_15,
    );
  });
});

test('an adopted observation is persisted: a rolled-back file, a conflicting observation, an older cycle and a clock set back never undo a confirmed exhaustion', async () => {
  await withBudget((db) => {
    const t0 = obs('40');
    const t1 = obs('0', { observed_at: iso(OCT_15 + 1000), shared: true });
    // 残高 40（t0）の後に、残高 0（t1）が観測された。新しい方が残高。
    const first = state(db, OCT_15 + 2000, input(t0, t1));
    assert.deepEqual(first.rejected, []);
    assert.equal(first.current?.balance, '0');
    assert.equal(observationRows(db), 2);
    const full = (n: number, now: number, credit: BudgetCreditInput) =>
      value(
        'budget.admit',
        run(db, credited(n, { reserved: '40', max: '40' }, credit, { now })),
      );
    assert.deepEqual(full(1, OCT_15 + 2000, input(t0, t1)).reason_codes, [
      'credit_exhausted',
    ]);
    // ファイルを古い観測だけに戻しても、採用済みの t1 のまま（t0 は採用済みと同じ内容で、変化なし）。
    const reverted = state(db, OCT_15 + 3000, input(t0));
    assert.deepEqual(reverted.rejected, []);
    assert.equal(reverted.current?.balance, '0');
    assert.deepEqual(full(1, OCT_15 + 3000, input(t0)).reason_codes, [
      'credit_exhausted',
    ]);
    // ファイルが空・読めなくても、採用済みの観測のまま。
    assert.equal(state(db, OCT_15 + 3500, input()).current?.balance, '0');
    // 同じ時刻で内容の違う観測は矛盾として拒否する。
    const conflict = state(
      db,
      OCT_15 + 4000,
      input(t0, obs('40', { observed_at: iso(OCT_15 + 1000), shared: true })),
    );
    assert.deepEqual(conflict.rejected, ['credit_observation_conflict']);
    assert.equal(conflict.current?.balance, '0');
    // 採用済みより古い時刻の新しい観測（巻き戻り）は拒否する。
    const rollback = state(
      db,
      OCT_15 + 5000,
      input(t0, t1, obs('99', { observed_at: iso(OCT_15 + 500) })),
    );
    assert.deepEqual(rollback.rejected, ['credit_observation_rollback']);
    assert.equal(rollback.current?.balance, '0');
    // 時計を戻しても、採用済みの観測は今より後でも捨てない（古い残高 40 へ戻らない）。
    const earlier = state(db, OCT_15 + 500, input(t0, t1));
    assert.equal(earlier.current?.balance, '0');
    assert.equal(observationRows(db), 2);
  });
  // 新しい周期の観測を採用した後は、古い周期の新しい観測を拒否する。古い周期の基準も残る。
  await withBudget((db) => {
    const oct = obs('40');
    const nov = obs('100', {
      cycle_id: CYCLE_NOV,
      observed_at: iso(NOV_01),
      expires_at: DEC_01,
    });
    const adopted = state(db, NOV_01 + 1000, input(oct, nov));
    assert.deepEqual(adopted.rejected, []);
    assert.deepEqual(
      adopted.bases.map((basis) => [basis.cycleId, basis.balance]),
      [
        [CYCLE_NOV, '100'],
        [CYCLE, '40'],
      ],
    );
    const stale = state(
      db,
      NOV_01 + 2000,
      input(oct, nov, obs('77', { observed_at: iso(NOV_01 + 500) })),
    );
    assert.deepEqual(stale.rejected, ['credit_observation_cycle_regression']);
    assert.equal(stale.current?.cycleId, CYCLE_NOV);
  });
});

test('observations are fixed by the table: no update, no delete, no rollback and no older cycle, whatever the caller does', async () => {
  await withBudget((db) => {
    state(
      db,
      OCT_15 + 1000,
      input(obs('40'), obs('10', { observed_at: iso(OCT_15 + 500) })),
    );
    const insert = (cycle: string, start: string, observedAt: number) =>
      db
        .prepare(
          "INSERT INTO budget_credit_observations (cycle_id, cycle_start, observed_at, expires_at, status, shared, organization_ref, balance_currency, balance_amount, content_id, recorded_at) VALUES (?, ?, ?, ?, 'observed', 0, 'x', 'XXX', 1, ?, 1)",
        )
        .run(
          cycle,
          Date.parse(start),
          observedAt,
          NOV_01 + 1e9,
          'a'.repeat(64),
        );
    assert.throws(
      () =>
        db
          .prepare('UPDATE budget_credit_observations SET balance_amount = 99')
          .run(),
      /budget_credit_observation_fixed/u,
    );
    assert.throws(
      () => db.prepare('DELETE FROM budget_credit_observations').run(),
      /budget_credit_observation_fixed/u,
    );
    assert.throws(
      () => insert(CYCLE, '2030-10-01T00:00:00.000Z', OCT_15 + 100),
      /budget_credit_observation_regression/u,
    );
    insert(CYCLE_NOV, '2030-11-01T00:00:00.000Z', NOV_01);
    assert.throws(
      () => insert(CYCLE, '2030-10-01T00:00:00.000Z', NOV_01 + 5),
      /budget_credit_cycle_regression/u,
    );
  });
});

test('the table keeps the credit binding of a reservation fixed, the estimate fixed after settlement, and a credit split consistent', async () => {
  await withBudget((db) => {
    const credit = input(obs('100'));
    value(
      'budget.admit',
      run(db, credited(1, { reserved: '5', max: '10' }, credit)),
    );
    value('budget.admit', run(db, admitOp(2, { reserved: '5', max: '10' })));
    const update = (n: number, sql: string) =>
      db
        .prepare(
          `UPDATE budget_reservations SET ${sql} WHERE reservation_id = ?`,
        )
        .run(reservationId(n));
    // 受付で結び付けた周期・期限・観測の番号は変えられない。周期のない予約に付けることもできない。
    assert.throws(
      () => update(1, "credit_cycle_id = 'anthropic:2030-11-01'"),
      /budget_credit_binding_fixed/u,
    );
    assert.throws(
      () => update(1, 'credit_expires_at = 1'),
      /budget_credit_binding_fixed/u,
    );
    assert.throws(
      () => update(1, 'credit_observation_seq = 2'),
      /budget_credit_binding_fixed/u,
    );
    assert.throws(
      () => update(2, "credit_cycle_id = 'anthropic:2030-10-01'"),
      /budget_credit_binding_fixed/u,
    );
    // 周期のない予約へ、クレジットや見積もりがある精算は書けない。クレジットは見積もりを超えない。
    const settledSql = (credit: number, additional: number, estimate: number) =>
      `status = 'settled', actual_gross = ${credit + additional}, credit_applied = ${credit}, additional_spend = ${additional}, credit_estimate = ${estimate}, provider_reconciliation_id = 'x:y', settlement_kind = 'provider', settled_at = 1`;
    assert.throws(
      () => update(2, settledSql(5, 0, 5)),
      /budget_credit_split_invalid/u,
    );
    assert.throws(
      () => update(2, settledSql(0, 5, 3)),
      /budget_credit_split_invalid/u,
    );
    assert.throws(
      () => update(1, settledSql(5, 0, 4)),
      /budget_credit_split_invalid/u,
    );
    update(1, settledSql(5, 0, 5));
    // 精算した後は、見積もり・区分・周期を変えられない。
    assert.throws(
      () => update(1, 'credit_estimate = 9'),
      /budget_credit_estimate_fixed/u,
    );
    assert.throws(
      () => update(1, 'credit_applied = 4, additional_spend = 1'),
      /budget_settlement_fixed/u,
    );
    assert.throws(
      () => update(1, 'credit_expires_at = 5'),
      /budget_credit_binding_fixed/u,
    );
    // 周期・期限・観測の番号は、3 つがそろうときだけ結び付ける。
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO budget_reservations (reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, credit_cycle_id, created_at) VALUES (?, ?, 'p', 'llm', 'llm', 'owner_request', '2030-10', 'XTS', 'price-1', 1, 1, 'reserved', 1, 'anthropic:2030-10-01', 1)",
          )
          .run(uuid(0xd0001), uuid(0xd0002)),
      /budget_credit_binding_invalid/u,
    );
  });
});

test('malformed credit input is refused by the shape check before anything is written', async () => {
  await withBudget((db) => {
    const bad = (credit: unknown): BudgetOp =>
      admitOp(
        1,
        { reserved: '1', max: '2' },
        {
          credit: credit as BudgetCreditInput,
        },
      );
    const base = input(obs('10'));
    const variants: unknown[] = [
      { ...base, config: { ...CONFIG, balance_to_budget_rate: '1.1234567' } },
      { ...base, config: { ...CONFIG, shared_observation_max_age_ms: 0 } },
      { ...base, config: { ...CONFIG, provider: 'Anthropic' } },
      { ...base, config: { ...CONFIG, profile_ids: 'claude' } },
      { ...base, budget_currency: 'xts' },
      { ...base, observations: 'none' },
      { ...base, observations: Array.from({ length: 121 }, () => obs('1')) },
      input(obs('10', { cycle_id: 'anthropic:2030-10' })),
      input(obs('10', { cycle_id: 'Anthropic:2030-10-01' })),
      input(obs('10', { observed_at: 'yesterday' })),
      input(obs('10', { expires_at: 'tomorrow' })),
      input(obs('10', { status: 'maybe' as CreditObservationInput['status'] })),
      input(obs('10', { shared: 'yes' as unknown as boolean })),
      input(obs('-1')),
      input(obs('1.5')),
      input(obs('1000000000000000000')),
      input(obs(null, { status: 'observed' })),
      input(obs('10', { organization_ref: '' })),
    ];
    for (const [index, variant] of variants.entries())
      assert.deepEqual(
        reasons(run(db, bad(variant))),
        ['credit_invalid'],
        String(index),
      );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'budget.credit_state',
          credit: null as unknown as BudgetCreditInput,
          now: OCT_15,
        }),
      ),
      ['credit_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          ...dispatch(1, base),
          credit: { config: 1 } as unknown as BudgetCreditInput,
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
    assert.equal(observationRows(db), 0);
  });
});
