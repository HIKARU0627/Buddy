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
      : runtime.price_versions,
  verifiedPriceVersions: request.verified ?? budget.verified_price_versions,
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
});

for (const entry of spec.liability_cases)
  test(`computeLiability: ${entry.id}`, () => {
    assert.deepEqual(
      computeLiability(liabilityRequest(entry.request)),
      entry.expected,
    );
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
