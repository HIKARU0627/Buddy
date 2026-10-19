import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  admitBudget,
  markUsageUnknown,
  poolPath,
  releaseUnsent,
  settleReservation,
  topUpReservation,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// ビルド後の domain を、合成設定の手書きシナリオで検査する。
const { validators } = await loadContracts();
const spec = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/budget-scenarios.json', root),
    'utf8',
  ),
);
const settings = {
  currency: spec.config.currency,
  pools: spec.config.pools.map((pool) => ({
    poolId: pool.pool_id,
    parentPoolId: pool.parent_pool_id,
    limit: pool.limit.amount,
    requiresApproval: pool.requires_approval,
  })),
  verifiedPriceVersions: spec.config.verified_price_versions,
};

const record = (entry) => ({
  reservationId: entry.id,
  requestId: entry.request ?? `req-${entry.id}`,
  poolId: entry.pool,
  budgetMonth: entry.month ?? spec.defaults.month,
  currency: spec.config.currency,
  reserved: entry.r,
  maxLiability: entry.m,
  status: entry.status ?? 'reserved',
  actualGross: entry.actual ?? null,
  providerReconciliationId: entry.receipt ?? null,
  approvalId: entry.approval ?? null,
  revision: '0',
  overrunReviewed: false,
});

function run(scenario) {
  const state = scenario.initial.map(record);
  const index = (id) => state.findIndex((item) => item.reservationId === id);
  const replace = (result) => {
    if (result.ok)
      state[index(result.reservation.reservationId)] = result.reservation;
  };
  for (const [number, step] of scenario.steps.entries()) {
    const label = `${scenario.id} #${number + 1} ${step.op} ${step.id}`;
    let actual;
    if (step.op === 'admit') {
      const entry = record(step);
      actual = admitBudget(settings, state, {
        requestId: entry.requestId,
        poolId: entry.poolId,
        budgetMonth: entry.budgetMonth,
        priceVersion: step.price ?? spec.defaults.price,
        currency: entry.currency,
        reserved: entry.reserved,
        maxLiability: entry.maxLiability,
        approvalId: entry.approvalId,
      });
      if (actual.admitted) state.push(entry);
    } else if (step.op === 'settle') {
      const current = state[index(step.id)];
      const result = settleReservation(current, {
        requestId: current.requestId,
        providerReconciliationId: step.receipt,
        actualGross: step.actual,
      });
      replace(result);
      actual = result.ok
        ? { ok: true, duplicate: result.duplicate, overrun: result.overrun }
        : result;
    } else if (step.op === 'top_up') {
      const result = topUpReservation(
        settings,
        state,
        step.id,
        step.revision,
        step.dr,
        step.dm,
      );
      replace(result);
      actual = result.ok ? { ok: true } : result;
    } else if (step.op === 'mark_unknown') {
      const result = markUsageUnknown(state[index(step.id)]);
      replace(result);
      actual = result.ok ? { ok: true } : result;
    } else if (step.op === 'release') {
      const result = releaseUnsent(state[index(step.id)], step.sent);
      replace(result);
      actual = result.ok ? { ok: true } : result;
    } else if (step.op === 'review_overrun') {
      state[index(step.id)] = {
        ...state[index(step.id)],
        overrunReviewed: true,
      };
      continue;
    } else throw new Error(`unknown op ${step.op}`);
    assert.deepEqual(actual, step.expected, label);
    if (step.record)
      for (const [key, value] of Object.entries(step.record))
        assert.equal(state[index(step.id)][key], value, `${label}.${key}`);
  }
  return state;
}

test('the synthetic budget config is a valid tree without personal amounts', () => {
  assert(validators.BudgetConfig(spec.config));
  assert.deepEqual(semanticErrors('BudgetConfig', spec.config), []);
  assert.equal(spec.config.currency, 'XTS');
  assert.deepEqual(poolPath(settings, 'llm.background.campaign'), [
    'llm.background.campaign',
    'llm.background',
    'llm',
    'total',
  ]);
  assert.equal(poolPath(settings, 'missing'), null);
});

test('budget config rejects broken trees', () => {
  const pools = structuredClone(spec.config.pools);
  const broken = (change) =>
    semanticErrors('BudgetConfig', {
      ...spec.config,
      pools: change(structuredClone(pools)),
    });
  assert(broken((p) => [...p, { ...p[1] }]).includes('duplicate_pool'));
  assert(
    broken((p) => {
      p[1].parent_pool_id = 'nowhere';
      return p;
    }).includes('unknown_parent_pool'),
  );
  assert(
    broken((p) => {
      p[0].parent_pool_id = 'llm';
      return p;
    }).includes('pool_cycle'),
  );
  assert(
    broken((p) => {
      p[2].limit.amount = '101';
      return p;
    }).includes('child_limit_exceeds_parent'),
  );
  assert(
    broken((p) => {
      p[4].limit.currency = 'JPY';
      return p;
    }).includes('currency_mismatch'),
  );
});

for (const scenario of spec.scenarios)
  test(`budget scenario: ${scenario.title}`, () => {
    const state = run(scenario);
    for (const item of state) {
      assert(
        BigInt(item.reserved) <= BigInt(item.maxLiability),
        item.reservationId,
      );
      if (item.status !== 'settled') assert.equal(item.actualGross, null);
    }
  });

test('every admission reason in the scenarios is either a limit, a hold or a named guard', () => {
  const reasons = spec.scenarios
    .flatMap((scenario) => scenario.steps)
    .flatMap((step) => step.expected?.reasonCodes ?? []);
  for (const reason of reasons)
    assert.match(
      reason,
      /^(?:[rm]_limit:[a-z.]+|overrun_hold:[a-z.]+|approval_required|price_unverified|duplicate_request|settlement_conflict|revision_conflict|possibly_sent|released|not_active)$/u,
    );
  assert(reasons.some((reason) => reason.startsWith('m_limit:')));
  assert(reasons.some((reason) => reason.startsWith('overrun_hold:')));
});
