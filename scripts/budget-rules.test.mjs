import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BUDGET_AMOUNT_MAX,
  MANUAL_RECONCILIATION_ID,
  advanceBudgetMonth,
  budgetMonthOf,
  computeLiability,
  computeReservation,
  matchOverageApproval,
  overageRouteReasons,
  reviewOverrun,
  settleManually,
  summarizeUsage,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B07-02 の予算の純粋な規則を、手書きの期待値（budget-rules.json）で検査する（ADR 0035）。
// 期待値は設計本文と手計算で書いたもので、ここでは実装の出力と比べるだけ。期待値を実装から作らない。
const { schema, validators } = await loadContracts();
const spec = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/budget-rules.json', root),
    'utf8',
  ),
);
const runtime = spec.runtime;
const budget = runtime.budget;
const settings = {
  currency: budget.currency,
  pools: budget.pools.map((pool) => ({
    poolId: pool.pool_id,
    parentPoolId: pool.parent_pool_id,
    limit: pool.limit.amount,
    requiresApproval: pool.requires_approval,
  })),
  verifiedPriceVersions: budget.verified_price_versions,
};

const liabilityRequest = (request) => ({
  budgetCurrency: request.budget_currency ?? budget.currency,
  priceKey: request.price_key,
  priceVersions:
    request.versions === 'invalid'
      ? spec.invalid_price_versions
      : request.versions === 'extra'
        ? spec.extra_price_versions
        : runtime.price_versions,
  verifiedPriceVersions:
    request.verified ??
    (request.versions === 'extra'
      ? spec.extra_price_versions.map((item) => item.price_version)
      : budget.verified_price_versions),
  billableFrom: request.from,
  billableUntil: request.until,
  quantities: request.quantities,
});

const record = (entry) => ({
  reservationId: entry.id ?? 'res-1',
  requestId: entry.request ?? 'req-1',
  profileId: entry.profile ?? 'synthetic.text.v1',
  priceVersion: entry.price ?? 'p-text-1',
  poolId: entry.pool,
  budgetMonth: entry.month ?? '2030-10',
  currency: budget.currency,
  reserved: entry.r,
  maxLiability: entry.m,
  status: entry.status,
  actualGross: entry.actual ?? null,
  providerReconciliationId: entry.receipt ?? null,
  approvalId: entry.approval ?? null,
  revision: entry.revision ?? '0',
  overrunReviewed: entry.reviewed ?? false,
});

test('the synthetic runtime config is valid and has no personal amounts', () => {
  assert(validators.BudgetRuntimeConfig(runtime));
  assert.deepEqual(semanticErrors('BudgetRuntimeConfig', runtime), []);
  assert.equal(budget.currency, 'XTS');
  // 上限のない出力の版は設定の検査でも拒否される（domain の拒否と二重に守る）。
  const unbounded = spec.invalid_price_versions.find(
    (item) => item.price_version === 'p-unbounded',
  );
  assert(
    semanticErrors('PriceVersion', unbounded).includes('unbounded_category'),
  );
  // cached の単価が入力より高い版・安全係数が 1 未満の版も、設定の検査で拒否される。
  const invalid = (id) =>
    semanticErrors(
      'PriceVersion',
      spec.invalid_price_versions.find((item) => item.price_version === id),
    );
  assert(invalid('p-cached-high').includes('cached_price_above_input'));
  assert(invalid('p-bad-conversion').includes('safety_factor_below_one'));
  // cached の最低課金量が大きい版などは設定の検査に通る。domain の M が最大の分け方で守る。
  for (const item of spec.extra_price_versions) {
    assert(validators.PriceVersion(item), item.price_version);
    assert.deepEqual(
      semanticErrors('PriceVersion', item),
      [],
      item.price_version,
    );
  }
});

for (const entry of spec.liability_cases)
  test(`computeLiability: ${entry.id}`, () => {
    const actual = computeLiability(liabilityRequest(entry.request));
    assert.deepEqual(actual, entry.expected);
    // 手で求めた本当の最大（区分ごとに版を選んで切り上げた、最も高い分け方の費用）を下回らない。
    if (entry.true_max !== undefined)
      assert(BigInt(actual.maxLiability) >= BigInt(entry.true_max), entry.id);
  });

for (const entry of spec.reservation_cases)
  test(`computeReservation: ${entry.id}`, () => {
    const request = { ...spec.reservation_defaults, ...entry.request };
    const actual = computeReservation({
      ...liabilityRequest(request),
      profileId: request.profile,
      profileRevision: request.profile_revision,
      p95ProfileIds: request.p95_profiles,
      measurement: request.measurement,
    });
    if (!entry.expected.ok) {
      assert.deepEqual(actual, entry.expected);
      return;
    }
    assert.equal(actual.ok, true);
    assert.equal(actual.reserved, entry.expected.reserved);
    assert.equal(actual.maxLiability, entry.expected.maxLiability);
    assert.equal(actual.basis, entry.expected.basis);
    // R は M を超えない。
    assert(BigInt(actual.reserved) <= BigInt(actual.maxLiability));
  });

for (const entry of spec.month_cases)
  test(`budgetMonthOf: ${entry.id}`, () => {
    assert.equal(budgetMonthOf(entry.time, entry.time_zone), entry.expected);
  });

for (const entry of spec.calendar_cases)
  test(`advanceBudgetMonth: ${entry.id}`, () => {
    assert.deepEqual(
      advanceBudgetMonth(entry.state, entry.now, entry.configured),
      entry.expected,
    );
  });

for (const entry of spec.route_cases)
  test(`overageRouteReasons: ${entry.id}`, () => {
    assert.deepEqual(
      overageRouteReasons({
        settings,
        origin: entry.origin,
        normalPoolId: entry.pool,
        normalReasonCodes: entry.reasons,
        routablePoolIds: entry.routable ?? spec.routable_pools,
        overagePoolId: entry.overage_pool ?? 'overage',
      }),
      entry.expected,
    );
  });

for (const entry of spec.approval_cases)
  test(`matchOverageApproval: ${entry.id}`, () => {
    const approval =
      entry.approval === null
        ? null
        : { ...spec.approval_base, ...(entry.approval ?? {}) };
    // contract_invalid の例は、契約の意味検査でも拒否される記録を domain でも拒否することを確かめる。
    if (approval !== null && entry.contract_invalid)
      assert.notDeepEqual(
        semanticErrors('BudgetOverageApproval', approval),
        [],
        entry.id,
      );
    if (approval !== null && !entry.contract_invalid) {
      assert(validators.BudgetOverageApproval(approval), entry.id);
      assert.deepEqual(
        semanticErrors('BudgetOverageApproval', approval),
        [],
        entry.id,
      );
    }
    assert.deepEqual(
      matchOverageApproval(approval, {
        ...spec.approval_expectation,
        ...(entry.expectation ?? {}),
      }),
      entry.expected,
    );
  });

const checkRecord = (entry, result) => {
  for (const [key, value] of Object.entries(entry.record ?? {}))
    assert.equal(result.reservation[key], value, `${entry.id}.${key}`);
};

for (const entry of spec.manual_cases)
  test(`settleManually: ${entry.id}`, () => {
    const result = settleManually(record(entry.reservation), entry.input);
    const summary = result.ok
      ? { ok: true, duplicate: result.duplicate, overrun: result.overrun }
      : result;
    assert.deepEqual(summary, entry.expected);
    if (result.ok) checkRecord(entry, result);
  });

test('the manual reconciliation id matches the contract pattern', () => {
  assert.equal(
    MANUAL_RECONCILIATION_ID.source,
    schema.$defs.BudgetManualSettlement.properties.manual_reconciliation_id
      .pattern,
  );
  assert(MANUAL_RECONCILIATION_ID.test(`manual:${'a'.repeat(64)}`));
  assert(!MANUAL_RECONCILIATION_ID.test(`manual:${'a'.repeat(65)}`));
});

for (const entry of spec.review_cases)
  test(`reviewOverrun: ${entry.id}`, () => {
    const result = reviewOverrun(record(entry.reservation), entry.input);
    const summary = result.ok
      ? { ok: true, duplicate: result.duplicate }
      : result;
    assert.deepEqual(summary, entry.expected);
    if (result.ok) checkRecord(entry, result);
  });

for (const entry of spec.summary_cases)
  test(`summarizeUsage: ${entry.id}`, () => {
    const result = summarizeUsage({
      settings,
      reservations: entry.reservations.map(record),
      currentMonth: entry.current_month,
      timeZone: entry.time_zone,
      generatedAt: entry.generated_at,
      overageApprovals: entry.approvals,
      configValid: entry.config_valid,
    });
    if (entry.expected) assert.deepEqual(result, entry.expected);
    if (entry.expected_hold_reasons) {
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.summary.months.map((month) => month.budget_month),
        entry.expected_months,
      );
      for (const month of result.summary.months)
        assert.deepEqual(
          Object.fromEntries(
            month.pools.map((pool) => [pool.pool_id, pool.hold_reasons]),
          ),
          entry.expected_hold_reasons,
        );
    }
    // 作った利用状況は契約の形と意味検査に通る。
    if (result.ok) {
      assert(validators.BudgetUsageSummary(result.summary), entry.id);
      assert.deepEqual(
        semanticErrors('BudgetUsageSummary', result.summary),
        [],
        entry.id,
      );
    }
  });

test('the amount limit is the 18-figure contract maximum', () => {
  assert.equal(BUDGET_AMOUNT_MAX.toString(), '9'.repeat(18));
  const amount = new RegExp(schema.$defs.Amount.pattern, 'u');
  assert(amount.test(BUDGET_AMOUNT_MAX.toString()));
  assert(!amount.test((BUDGET_AMOUNT_MAX + 1n).toString()));
});

// 入力と cached の分け方の上限を、すべての分け方を数え上げた本当の最大と比べる（固定の seed の合成の単価）。
// 本当の最大は、分け方ごとに区分ごと・版ごとの高い方を選んで切り上げた費用で、実装とは別の数え上げで求める。
// 上限はそれを下回らず、多くても 1 単位だけ多い（ADR 0035）。
test('the input split bound never falls below the enumerated maximum', () => {
  let seed = 20261023;
  const next = (limit) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  const ceil = (n, d) => (n + d - 1n) / d;
  const billed = (amount, minimum) =>
    amount === 0n ? 0n : amount > minimum ? amount : minimum;
  const randomRate = (category) => ({
    category,
    unit_price: String(1 + next(9)),
    per_quantity: String(1 + next(9)),
    minimum_quantity: String(next(4) === 0 ? next(20) : 0),
    max_quantity_per_request: null,
  });
  for (let round = 0; round < 300; round += 1) {
    const versions = [0, 1].map((index) => ({
      price_version: `p-random-${index + 1}`,
      price_key: 'synthetic.random',
      currency: 'XTS',
      effective_from:
        index === 0 ? '2030-10-01T00:00:00.000Z' : '2030-11-01T00:00:00.000Z',
      effective_to: index === 0 ? '2030-11-01T00:00:00.000Z' : null,
      rates: [randomRate('input_tokens'), randomRate('cached_input_tokens')],
      conversion: {
        conversion_version: 'xts-same-1',
        to_currency: 'XTS',
        rate: '1',
        safety_factor: next(2) === 0 ? '1' : '1.2',
      },
    }));
    const total = BigInt(1 + next(12));
    const result = computeLiability({
      budgetCurrency: 'XTS',
      priceKey: 'synthetic.random',
      priceVersions: versions,
      verifiedPriceVersions: ['p-random-1', 'p-random-2'],
      billableFrom: '2030-10-31T23:59:50.000Z',
      billableUntil: '2030-11-01T00:00:20.000Z',
      quantities: { input_tokens: String(total) },
    });
    assert.equal(result.ok, true);
    // 区分ごと・版ごとの高い方を切り上げた費用（安全係数 1 / 1.2 を 10 / 12 の 10 分の 1 で扱う）。
    const categoryCost = (amount, index) => {
      let best = 0n;
      for (const version of versions) {
        const rate = version.rates[index];
        const safety = version.conversion.safety_factor === '1' ? 10n : 12n;
        const value = ceil(
          billed(amount, BigInt(rate.minimum_quantity)) *
            BigInt(rate.unit_price) *
            safety,
          BigInt(rate.per_quantity) * 10n,
        );
        if (value > best) best = value;
      }
      return best;
    };
    let trueMax = 0n;
    for (let uncached = 0n; uncached <= total; uncached += 1n) {
      const cost =
        categoryCost(uncached, 0) + categoryCost(total - uncached, 1);
      if (cost > trueMax) trueMax = cost;
    }
    const m = BigInt(result.maxLiability);
    assert(m >= trueMax, `round ${round}: M ${m} < ${trueMax}`);
    assert(m <= trueMax + 1n, `round ${round}: M ${m} > ${trueMax} + 1`);
  }
});
