import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelUsage } from '@buddy/contracts';
import type { PriceVersionInput } from '@buddy/domain';
import { usageCost } from './cost.js';

// 合成の通貨 XTS の単価。個人の金額・実為替・実 API の単価ではない。
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
      category: 'cached_input_tokens',
      unit_price: '2',
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

const usage = (overrides: Partial<ModelUsage> = {}): ModelUsage => ({
  input_tokens: 1000,
  cached_input_tokens: 0,
  output_tokens: 100,
  reasoning_tokens: 20,
  usage_complete: true,
  ...overrides,
});

const request = (
  overrides: Partial<Parameters<typeof usageCost>[0]> = {},
): Parameters<typeof usageCost>[0] => ({
  usage: usage(),
  priceVersion,
  budgetCurrency: 'XTS',
  ...overrides,
});

test('bills input and output tokens without double-counting reasoning tokens', () => {
  // input 1000 × 10 = 10000、output 100 × 30 = 3000。reasoning 20 は output に含まれる。
  const result = usageCost(request());
  assert.deepEqual(result, {
    ok: true,
    amount: '13000',
    price_version: 'price-xts-1',
    lines: [
      { category: 'input_tokens', quantity: '1000', amount: '10000' },
      { category: 'output_tokens', quantity: '100', amount: '3000' },
    ],
  });
});

test('bills cached input separately when the price version has a cached rate', () => {
  // 非命中 600 × 10 = 6000、命中 400 × 2 = 800、output 100 × 30 = 3000。
  const result = usageCost(
    request({ usage: usage({ cached_input_tokens: 400 }) }),
  );
  assert.deepEqual(result, {
    ok: true,
    amount: '9800',
    price_version: 'price-xts-1',
    lines: [
      { category: 'input_tokens', quantity: '600', amount: '6000' },
      { category: 'cached_input_tokens', quantity: '400', amount: '800' },
      { category: 'output_tokens', quantity: '100', amount: '3000' },
    ],
  });
});

test('bills all input at the input rate when the version has no cached rate', () => {
  const withoutCached: PriceVersionInput = {
    ...priceVersion,
    rates: priceVersion.rates.filter(
      (rate) => rate.category !== 'cached_input_tokens',
    ),
  };
  const result = usageCost(
    request({
      priceVersion: withoutCached,
      usage: usage({ cached_input_tokens: 400 }),
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    amount: '13000',
    price_version: 'price-xts-1',
    lines: [
      { category: 'input_tokens', quantity: '1000', amount: '10000' },
      { category: 'output_tokens', quantity: '100', amount: '3000' },
    ],
  });
});

test('charges the minimum quantity only when the quantity is above zero', () => {
  const withMinimum: PriceVersionInput = {
    ...priceVersion,
    rates: priceVersion.rates.map((rate) =>
      rate.category === 'output_tokens'
        ? { ...rate, minimum_quantity: '200' }
        : rate,
    ),
  };
  const result = usageCost(
    request({
      priceVersion: withMinimum,
      usage: usage({ output_tokens: 100 }),
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    amount: '16000',
    price_version: 'price-xts-1',
    lines: [
      { category: 'input_tokens', quantity: '1000', amount: '10000' },
      { category: 'output_tokens', quantity: '200', amount: '6000' },
    ],
  });
  const zero = usageCost(
    request({
      priceVersion: withMinimum,
      usage: usage({ output_tokens: 0, reasoning_tokens: null }),
    }),
  );
  assert.deepEqual(zero, {
    ok: true,
    amount: '10000',
    price_version: 'price-xts-1',
    lines: [{ category: 'input_tokens', quantity: '1000', amount: '10000' }],
  });
});

test('rejects incomplete usage instead of settling an estimate', () => {
  assert.deepEqual(
    usageCost(request({ usage: usage({ usage_complete: false }) })),
    { ok: false, reasonCodes: ['usage_incomplete'] },
  );
});

test('rejects inconsistent usage and mismatched currency', () => {
  assert.deepEqual(
    usageCost(request({ usage: usage({ cached_input_tokens: 2000 }) })),
    { ok: false, reasonCodes: ['cached_exceeds_input'] },
  );
  assert.deepEqual(usageCost(request({ budgetCurrency: 'USD' })), {
    ok: false,
    reasonCodes: ['currency_mismatch'],
  });
  assert.deepEqual(
    usageCost(
      request({ usage: usage({ output_tokens: 10, reasoning_tokens: 20 }) }),
    ),
    { ok: false, reasonCodes: ['reasoning_exceeds_output'] },
  );
});

test('rejects a category that the price version does not price', () => {
  const withoutOutput: PriceVersionInput = {
    ...priceVersion,
    rates: priceVersion.rates.filter(
      (rate) => rate.category !== 'output_tokens',
    ),
  };
  assert.deepEqual(usageCost(request({ priceVersion: withoutOutput })), {
    ok: false,
    reasonCodes: ['unpriced_category:output_tokens'],
  });
});

test('rejects a price version with a category that usage cannot settle', () => {
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
  assert.deepEqual(usageCost(request({ priceVersion: withTools })), {
    ok: false,
    reasonCodes: ['unsettled_category:tool_calls'],
  });
});

test('rejects an amount above the 18-digit limit', () => {
  const huge: PriceVersionInput = {
    ...priceVersion,
    rates: priceVersion.rates.map((rate) =>
      rate.category === 'input_tokens'
        ? { ...rate, unit_price: '999999999999999999' }
        : rate,
    ),
  };
  assert.deepEqual(usageCost(request({ priceVersion: huge })), {
    ok: false,
    reasonCodes: ['amount_overflow'],
  });
});
