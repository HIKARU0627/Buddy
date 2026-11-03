import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelUsage } from '@buddy/contracts';
import type { PriceVersionInput } from '@buddy/domain';
import { planUsageSettlement } from './settlement.js';

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

const request = { priceVersion, budgetCurrency: 'XTS' };

const usage: ModelUsage = {
  input_tokens: 1000,
  cached_input_tokens: 0,
  output_tokens: 100,
  reasoning_tokens: 20,
  usage_complete: true,
};

test('settles a complete usage with the actual gross amount', () => {
  assert.deepEqual(planUsageSettlement(usage, request), {
    kind: 'settle',
    actual_gross: '13000',
    price_version: 'price-xts-1',
    lines: [
      { category: 'input_tokens', quantity: '1000', amount: '10000' },
      { category: 'output_tokens', quantity: '100', amount: '3000' },
    ],
  });
});

test('keeps R and M when usage is missing or incomplete', () => {
  assert.deepEqual(planUsageSettlement(null, request), {
    kind: 'usage_unknown',
    reason: 'usage_missing',
  });
  assert.deepEqual(
    planUsageSettlement({ ...usage, usage_complete: false }, request),
    { kind: 'usage_unknown', reason: 'usage_incomplete' },
  );
});

test('reports an invalid price configuration instead of inventing an amount', () => {
  const withoutOutput: PriceVersionInput = {
    ...priceVersion,
    rates: priceVersion.rates.filter(
      (rate) => rate.category !== 'output_tokens',
    ),
  };
  assert.deepEqual(
    planUsageSettlement(usage, {
      priceVersion: withoutOutput,
      budgetCurrency: 'XTS',
    }),
    { kind: 'invalid', reasonCodes: ['unpriced_category:output_tokens'] },
  );
});
