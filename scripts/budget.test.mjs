import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  admitBudget,
  admitWithOverage,
  markUsageUnknown,
  poolPath,
  releaseUnsent,
  reviewOverrun,
  settleManually,
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
  profileId: entry.profile ?? spec.defaults.profile,
  priceVersion: entry.price ?? spec.defaults.price,
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

// 超過枠の承認（契約の BudgetOverageApproval の形）。シナリオでは短い ID と主な項目だけを手で書く。
const approvalOf = (entry) => ({
  approval_id: entry.id,
  request_id: entry.request,
  pool_id: entry.pool ?? 'overage',
  budget_month: entry.month ?? spec.defaults.month,
  max_liability: { currency: spec.config.currency, amount: entry.m },
  overage_remaining: { currency: spec.config.currency, amount: '25' },
  status: entry.status ?? 'approved',
  requested_at: '2030-10-20T00:00:00Z',
  expires_at: entry.expires ?? '2030-10-20T00:10:00Z',
  decided_at: entry.status === 'pending' ? null : '2030-10-20T00:01:00Z',
});

function run(scenario) {
  const state = scenario.initial.map(record);
  const approvals = (scenario.approvals ?? []).map(approvalOf);
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
        profileId: entry.profileId,
        poolId: entry.poolId,
        budgetMonth: entry.budgetMonth,
        priceVersion: entry.priceVersion,
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
    } else if (step.op === 'admit_route') {
      const entry = record(step);
      const result = admitWithOverage(
        settings,
        state,
        {
          requestId: entry.requestId,
          profileId: entry.profileId,
          poolId: entry.poolId,
          budgetMonth: entry.budgetMonth,
          priceVersion: entry.priceVersion,
          currency: entry.currency,
          reserved: entry.reserved,
          maxLiability: entry.maxLiability,
          approvalId: null,
        },
        {
          origin: step.origin,
          routablePoolIds: spec.defaults.routable_pools,
          overagePoolId: 'overage',
          approval:
            approvals.find((item) => item.approval_id === step.approval) ??
            null,
          now: step.now ?? spec.defaults.now,
        },
      );
      if (result.admitted)
        state.push({
          ...entry,
          poolId: result.poolId,
          approvalId: result.approvalId,
        });
      actual = result;
    } else if (step.op === 'manual_settle') {
      const current = state[index(step.id)];
      const result = settleManually(current, {
        expectedRevision: step.revision ?? current.revision,
        manualReconciliationId: step.receipt,
        currency: spec.config.currency,
        actualGross: step.actual,
      });
      replace(result);
      actual = result.ok
        ? { ok: true, duplicate: result.duplicate, overrun: result.overrun }
        : result;
    } else if (step.op === 'review') {
      const current = state[index(step.id)];
      const result = reviewOverrun(current, {
        expectedRevision: step.revision ?? current.revision,
        currency: spec.config.currency,
        actualGross: step.actual,
        maxLiability: step.m,
      });
      replace(result);
      actual = result.ok ? { ok: true, duplicate: result.duplicate } : result;
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
      /^(?:[rm]_limit:[a-z.]+|overrun_hold:[a-z.]+|approval_required|approval_(?:pending|expired|m_mismatch|request_mismatch)|price_unverified|duplicate_request|settlement_conflict|revision_conflict|possibly_sent|released|not_active|not_owner_request|pool_not_routable|not_limit_only|manual_id_invalid|manual_prefix_reserved|already_settled|not_usage_unknown|review_mismatch|unknown_pool|reservation_pool_unknown)$/u,
    );
  assert(reasons.some((reason) => reason.startsWith('m_limit:')));
  assert(reasons.some((reason) => reason.startsWith('overrun_hold:')));
});
