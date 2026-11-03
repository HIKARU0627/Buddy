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

test('does not settle when the price version has a category usage cannot price', () => {
  const withTools: PriceVersionInput = {
    ...priceVersion,
    rates: [
      ...priceVersion.rates,
      {
        category: 'tool_calls',
        unit_price: '5',
        per_quantity: '1',
        minimum_quantity: '0',
        max_quantity_per_request: '10',
      },
    ],
  };
  // ツールの実使用量が分からないときは精算しない。
  assert.deepEqual(
    planUsageSettlement(usage, {
      priceVersion: withTools,
      budgetCurrency: 'XTS',
    }),
    { kind: 'invalid', reasonCodes: ['unsettled_category:tool_calls'] },
  );
  // 既知の 0 なら token の実費だけを精算する。
  assert.deepEqual(
    planUsageSettlement(
      usage,
      { priceVersion: withTools, budgetCurrency: 'XTS' },
      0,
    ),
    {
      kind: 'settle',
      actual_gross: '13000',
      price_version: 'price-xts-1',
      lines: [
        { category: 'input_tokens', quantity: '1000', amount: '10000' },
        { category: 'output_tokens', quantity: '100', amount: '3000' },
      ],
    },
  );
  // ツールを 2 回使った要求は、ツールの実費 2 × 5 = 10 を足す。
  assert.deepEqual(
    planUsageSettlement(
      usage,
      { priceVersion: withTools, budgetCurrency: 'XTS' },
      2,
    ),
    {
      kind: 'settle',
      actual_gross: '13010',
      price_version: 'price-xts-1',
      lines: [
        { category: 'input_tokens', quantity: '1000', amount: '10000' },
        { category: 'output_tokens', quantity: '100', amount: '3000' },
        { category: 'tool_calls', quantity: '2', amount: '10' },
      ],
    },
  );
  // 検索の回数はこの段階では確定できないので、既知の 0 を渡しても精算しない。
  const withSearch: PriceVersionInput = {
    ...priceVersion,
    rates: [
      ...priceVersion.rates,
      {
        category: 'search_requests',
        unit_price: '5',
        per_quantity: '1',
        minimum_quantity: '0',
        max_quantity_per_request: '1',
      },
    ],
  };
  assert.deepEqual(
    planUsageSettlement(usage, {
      priceVersion: withSearch,
      budgetCurrency: 'XTS',
    }),
    { kind: 'invalid', reasonCodes: ['unsettled_category:search_requests'] },
  );
});
