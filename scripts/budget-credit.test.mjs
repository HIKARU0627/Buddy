import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  allocateCredit,
  budgetRuntimeConfigErrors,
  creditAdmission,
  creditAdoptionDecision,
  creditAvailability,
  creditBasesOf,
  creditConfigErrors,
  creditCycleStart,
  creditEligible,
  creditObservationsErrors,
  creditStillCovers,
  creditTopUp,
  settleManually,
  settleReservation,
  toReservationView,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root, semanticErrors } from './contract-tools.mjs';

// B07-07 の付帯クレジットの純粋な規則を、手書きの期待値（budget-credit.json）で検査する（ADR 0042）。
// 期待値は設計 05 のクレジットの追補と 09 の MA03〜MA06 の規則から手で計算したもので、ここでは実装の出力と比べるだけ。
// 期待値を実装から作らない。通貨は予算が XTS、残高が ISO の通貨なしコード XXX の合成値だけ。
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));
const spec = await read('packages/contracts/fixtures/budget-credit.json');
const schemaCases = await read('packages/contracts/fixtures/schema-cases.json');

const ms = (iso) => Date.parse(iso);
const toBasis = (item) =>
  item === null
    ? null
    : {
        cycleId: item.cycleId,
        cycleStart: ms(item.cycleStart),
        observedAt: ms(item.observedAt),
        expiresAt: ms(item.expiresAt),
        status: item.status,
        shared: item.shared,
        balance: item.balance,
      };
const toLedger = (item) =>
  item === null
    ? null
    : {
        allocatedSince: BigInt(item.allocated_since),
        outstanding: BigInt(item.outstanding),
      };
const fromBasis = (basis) =>
  basis === null
    ? null
    : {
        cycleId: basis.cycleId,
        cycleStart: new Date(basis.cycleStart).toISOString(),
        observedAt: new Date(basis.observedAt).toISOString(),
        expiresAt: new Date(basis.expiresAt).toISOString(),
        status: basis.status,
        shared: basis.shared,
        balance: basis.balance,
      };

const record = (entry) => ({
  reservationId: 'res-1',
  requestId: 'req-1',
  profileId: 'claude.synthetic.v1',
  priceVersion: 'p-text-1',
  poolId: entry.pool,
  budgetMonth: entry.month,
  currency: 'XTS',
  reserved: entry.r,
  maxLiability: entry.m,
  status: entry.status,
  actualGross: entry.actual ?? null,
  providerReconciliationId: entry.receipt ?? null,
  approvalId: null,
  revision: entry.revision ?? '1',
  overrunReviewed: false,
  ...(entry.credit === undefined ? {} : { creditApplied: entry.credit }),
  ...(entry.additional === undefined
    ? {}
    : { additionalSpend: entry.additional }),
  creditCycleId: entry.cycle,
});

test('the credit fixture uses only synthetic currencies', () => {
  const text = JSON.stringify(spec);
  assert(!/"(JPY|USD|EUR)"/u.test(text));
  assert(text.includes('"XXX"'));
});

for (const entry of spec.cycle_start_cases)
  test(`creditCycleStart: ${entry.id}`, () => {
    const actual = creditCycleStart(entry.cycle_id);
    assert.equal(
      actual === null ? null : new Date(actual).toISOString(),
      entry.expected,
    );
  });

for (const entry of spec.eligible_cases)
  test(`creditEligible: ${entry.id}`, () => {
    assert.equal(
      creditEligible(
        entry.configured ? spec.config : null,
        entry.service,
        entry.profile,
      ),
      entry.expected,
    );
  });

for (const entry of spec.bases_cases)
  test(`creditBasesOf: ${entry.id}`, () => {
    const result = creditBasesOf({
      config: { ...spec.config, ...entry.config_override },
      budgetCurrency: 'XTS',
      observations: entry.observations,
      now: ms(entry.now),
    });
    assert.deepEqual(
      {
        current: fromBasis(result.current),
        bases: result.bases.map(fromBasis),
      },
      entry.expected,
    );
  });

for (const entry of spec.availability_cases)
  test(`creditAvailability: ${entry.id}`, () => {
    const result = creditAvailability({
      basis: toBasis(entry.basis),
      ledger: toLedger(entry.ledger),
      now: ms(entry.now),
      sharedMaxAgeMs: entry.max_age_ms,
    });
    assert.deepEqual(
      result.ok ? { ok: true, available: result.available.toString() } : result,
      entry.expected,
    );
  });

for (const entry of spec.admission_cases)
  test(`creditAdmission: ${entry.id}`, () => {
    const result = creditAdmission({
      basis: toBasis(entry.basis),
      ledger: toLedger(entry.ledger),
      now: ms(entry.now),
      sharedMaxAgeMs: entry.max_age_ms,
      maxLiability: BigInt(entry.max_liability),
    });
    assert.deepEqual(result, entry.expected);
  });

for (const entry of spec.allocation_cases)
  test(`allocateCredit: ${entry.id}`, () => {
    const result = allocateCredit({
      cycleId: entry.cycle_id,
      actualGross: BigInt(entry.actual_gross),
      maxLiability: BigInt(entry.max_liability),
      basis: toBasis(entry.basis),
      ledger: toLedger(entry.ledger),
      now: ms(entry.now),
    });
    assert.deepEqual(
      {
        credit_applied: result.creditApplied.toString(),
        additional_spend: result.additionalSpend.toString(),
        estimate: result.estimate.toString(),
      },
      entry.expected,
    );
    // 実費 = クレジット + 追加の支出（精算の区分は過不足なく分ける）。
    assert.equal(
      result.creditApplied + result.additionalSpend,
      BigInt(entry.actual_gross),
    );
  });

const verdict = (result) =>
  result.ok ? { ok: true } : { ok: false, reason: result.reason };

for (const entry of spec.still_covers_cases)
  test(`creditStillCovers: ${entry.id}`, () => {
    assert.deepEqual(
      verdict(
        creditStillCovers({
          basis: toBasis(entry.basis),
          ledger: toLedger(entry.ledger),
          now: ms(entry.now),
          sharedMaxAgeMs: entry.max_age_ms,
          boundExpiresAt:
            entry.bound_expires_at === null ? null : ms(entry.bound_expires_at),
        }),
      ),
      entry.expected,
    );
  });

for (const entry of spec.top_up_cases)
  test(`creditTopUp: ${entry.id}`, () => {
    assert.deepEqual(
      verdict(
        creditTopUp({
          basis: toBasis(entry.basis),
          ledger: toLedger(entry.ledger),
          now: ms(entry.now),
          sharedMaxAgeMs: entry.max_age_ms,
          deltaMaxLiability: BigInt(entry.delta_max_liability),
          boundExpiresAt:
            entry.bound_expires_at === null ? null : ms(entry.bound_expires_at),
        }),
      ),
      entry.expected,
    );
  });

for (const entry of spec.adoption_cases)
  test(`creditAdoptionDecision: ${entry.id}`, () => {
    const input = entry.input;
    assert.equal(
      creditAdoptionDecision({
        cycleStart: ms(input.cycleStart),
        observedAt: ms(input.observedAt),
        contentId: input.contentId,
        sameTime: input.sameTime,
        latestObservedAtOfCycle:
          input.latestObservedAtOfCycle === null
            ? null
            : ms(input.latestObservedAtOfCycle),
        maxCycleStart:
          input.maxCycleStart === null ? null : ms(input.maxCycleStart),
      }),
      entry.expected,
    );
  });

const subset = (value, expected) =>
  Object.fromEntries(Object.keys(expected).map((key) => [key, value[key]]));

for (const entry of spec.settle_cases)
  test(`settleReservation: ${entry.id}`, () => {
    const result = settleReservation(record(entry.reservation), {
      requestId: 'req-1',
      ...entry.settlement,
    });
    if (!entry.expected.ok) {
      assert.deepEqual(result, entry.expected);
      return;
    }
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, entry.expected.duplicate);
    assert.deepEqual(
      subset(result.reservation, entry.expected.record),
      entry.expected.record,
    );
    // 実費 = クレジット + 追加の支出。
    assert.equal(
      BigInt(result.reservation.creditApplied ?? '0') +
        BigInt(
          result.reservation.additionalSpend ?? result.reservation.actualGross,
        ),
      BigInt(result.reservation.actualGross),
    );
  });

for (const entry of spec.manual_cases)
  test(`settleManually: ${entry.id}`, () => {
    const result = settleManually(record(entry.reservation), entry.input);
    if (!entry.expected.ok) {
      assert.deepEqual(result, entry.expected);
      return;
    }
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, entry.expected.duplicate);
    assert.deepEqual(
      subset(result.reservation, entry.expected.record),
      entry.expected.record,
    );
  });

for (const entry of spec.view_cases)
  test(`toReservationView: ${entry.id}`, () => {
    const view = toReservationView(record(entry.reservation));
    assert.deepEqual(
      {
        actual_gross: view.actual_gross?.amount ?? null,
        credit_applied: view.credit_applied?.amount ?? null,
        additional_spend: view.additional_spend?.amount ?? null,
        credit_cycle_id: view.credit_cycle_id,
      },
      entry.expected,
    );
  });

// 設定・観測の意味検査は、契約の検査（scripts/contract-tools.mjs）と同じ理由コードを返す（Core は scripts を読まないので
// domain に同じ規則を置き、契約の手書きの期待値と一致することをここで確かめる）。
const unique = (items) => [...new Set(items)].sort();

for (const entry of schemaCases.filter(
  (item) => item.valid && item.schema === 'BudgetCreditObservations',
))
  test(`creditObservationsErrors matches the contract: ${entry.id}`, () => {
    const expected = entry.semantic_errors ?? [];
    assert.deepEqual(
      unique(creditObservationsErrors(entry.value)),
      unique(expected),
    );
    assert.deepEqual(
      unique(semanticErrors('BudgetCreditObservations', entry.value)),
      unique(expected),
    );
  });

for (const entry of schemaCases.filter(
  (item) =>
    item.valid &&
    item.schema === 'BudgetRuntimeConfig' &&
    item.value.credit !== undefined,
))
  test(`the runtime config credit errors match the contract: ${entry.id}`, () => {
    const expected = unique(entry.semantic_errors ?? []);
    assert.deepEqual(unique(budgetRuntimeConfigErrors(entry.value)), expected);
    assert.deepEqual(
      unique(
        creditConfigErrors(entry.value.credit, entry.value.budget.currency),
      ),
      expected,
    );
  });
