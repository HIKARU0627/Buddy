import assert from 'node:assert/strict';
import test from 'node:test';
import { computeReservation } from '@buddy/domain';
import type { PriceVersionInput } from '@buddy/domain';
import { planReservation } from './reservation.js';
import { syntheticProfile } from './testing.js';

// 合成の通貨 XTS の単価。実 API の単価・実為替ではない。
const priceVersion: PriceVersionInput = {
  price_version: 'price-xts-1',
  price_key: 'llm.xts',
  currency: 'XTS',
  effective_from: '2026-01-01T00:00:00Z',
  effective_to: null,
  rates: [
    {
      category: 'input_tokens',
      unit_price: '10',
      per_quantity: '1',
      minimum_quantity: '0',
      max_quantity_per_request: null,
    },
    {
      category: 'output_tokens',
      unit_price: '30',
      per_quantity: '1',
      minimum_quantity: '0',
      max_quantity_per_request: null,
    },
  ],
  conversion: {
    conversion_version: 'conv-xts-1',
    to_currency: 'XTS',
    rate: '1.000000',
    safety_factor: '1.2',
  },
};

const profile = syntheticProfile({
  profile_id: 'intent-primary',
  role: 'intent',
  price_version: 'price-xts-1',
  output_limit_tokens: 500,
  verified_capabilities: ['json_schema_strict', 'reasoning:low'],
});

test('turns the input quantity and the profile output limit into reservation quantities', () => {
  assert.deepEqual(planReservation({ profile, input_tokens: 1000 }), {
    ok: true,
    plan: {
      quantities: { input_tokens: '1000', output_tokens: '500' },
      price_version: 'price-xts-1',
    },
  });
});

test('rejects a profile without a finite output limit or price version', () => {
  assert.deepEqual(
    planReservation({
      profile: syntheticProfile({
        profile_id: 'no-limit',
        role: 'intent',
        output_limit_tokens: null,
      }),
      input_tokens: 1000,
    }),
    { ok: false, reasonCodes: ['output_limit_missing'] },
  );
  assert.deepEqual(
    planReservation({
      profile: syntheticProfile({
        profile_id: 'no-price',
        role: 'intent',
        price_version: null,
      }),
      input_tokens: 1000,
    }),
    { ok: false, reasonCodes: ['price_version_missing'] },
  );
  assert.deepEqual(planReservation({ profile, input_tokens: -1 }), {
    ok: false,
    reasonCodes: ['invalid_input_tokens'],
  });
});

test('the quantities feed B07 computeReservation and give a hand-written M', () => {
  // M = 入力 1000 × 10 × 1.2 + 出力 500 × 30 × 1.2 = 12000 + 18000 = 30000（XTS の百万分の一）。
  const planned = planReservation({ profile, input_tokens: 1000 });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const result = computeReservation({
    budgetCurrency: 'XTS',
    priceKey: 'llm.xts',
    priceVersions: [priceVersion],
    verifiedPriceVersions: ['price-xts-1'],
    billableFrom: '2030-10-01T00:00:00Z',
    billableUntil: '2030-10-01T00:00:20Z',
    quantities: planned.plan.quantities,
    profileId: 'intent-primary',
    profileRevision: '1',
    p95ProfileIds: [],
    measurement: null,
  });
  assert.deepEqual(result, {
    ok: true,
    reserved: '30000',
    maxLiability: '30000',
    basis: 'not_designated',
    priceVersion: 'price-xts-1',
    priceVersions: ['price-xts-1'],
  });
});

test('a designated p95 profile reserves the output p95 times 1.2', () => {
  // R = 入力 12000 + 出力 ceil(100 × 1.2) = 120 × 30 × 1.2 = 4320 → 16320。M は 30000 のまま。
  const planned = planReservation({ profile, input_tokens: 1000 });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const result = computeReservation({
    budgetCurrency: 'XTS',
    priceKey: 'llm.xts',
    priceVersions: [priceVersion],
    verifiedPriceVersions: ['price-xts-1'],
    billableFrom: '2030-10-01T00:00:00Z',
    billableUntil: '2030-10-01T00:00:20Z',
    quantities: planned.plan.quantities,
    profileId: 'intent-primary',
    profileRevision: '1',
    p95ProfileIds: ['intent-primary'],
    measurement: {
      profileId: 'intent-primary',
      profileRevision: '1',
      outputP95Tokens: '100',
    },
  });
  assert.deepEqual(result, {
    ok: true,
    reserved: '16320',
    maxLiability: '30000',
    basis: 'p95',
    priceVersion: 'price-xts-1',
    priceVersions: ['price-xts-1'],
  });
});
