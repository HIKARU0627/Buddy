import assert from 'node:assert/strict';
import test from 'node:test';
import { computeLiveSecondsAmount } from '../packages/domain/dist/index.js';

// B05-04（ADR 0049）の、会話の秒数を金額にする規則を、手書きの期待値で検査する。
// 通貨は ISO の試験用コード XTS、単価・為替・係数は合成値。期待値は式を手で解いた値で、実装から作らない。
const version = (overrides = {}) => ({
  price_version: 'xts.live.v1',
  price_key: 'synthetic.live',
  currency: 'XTS',
  effective_from: '2030-01-01T00:00:00.000Z',
  effective_to: null,
  rates: [
    {
      category: 'live_seconds',
      unit_price: '5',
      per_quantity: '60',
      minimum_quantity: '15',
      max_quantity_per_request: '400',
    },
  ],
  conversion: {
    conversion_version: 'xts.conv.v1',
    to_currency: 'XTS',
    rate: '2',
    safety_factor: '1.25',
  },
  ...overrides,
});

const request = (seconds, basis, extra = {}) => ({
  budgetCurrency: 'XTS',
  priceKey: 'synthetic.live',
  priceVersion: 'xts.live.v1',
  priceVersions: [version()],
  verifiedPriceVersions: ['xts.live.v1'],
  seconds,
  basis,
  ...extra,
});

// 単価 5 / 60 秒 × 為替 2 = 1 秒あたり 1/6。安全係数 1.25 は追加予約（increment）だけに掛ける。
const accepted = [
  // [秒数, 基準, 期待する額]。切り上げは 1 回ごと。
  [60, 'increment', '13'], // 60 × 5 × 2 × 1.25 / 60 = 12.5 → 13
  [60, 'actual', '10'], // 60 × 5 × 2 / 60 = 10（係数なし）
  [7, 'increment', '2'], // 7 × 5 × 2 × 1.25 / 60 = 1.458… → 2（最低課金量は掛けない）
  [7, 'actual', '3'], // 最低 15 秒: 15 × 5 × 2 / 60 = 2.5 → 3
  [15, 'actual', '3'],
  [16, 'actual', '3'], // 16 × 10 / 60 = 2.666… → 3
  [0, 'increment', '0'],
  [0, 'actual', '3'], // 0 秒でも最低課金 15 秒
  [300, 'actual', '50'], // 版の 1 要求の最大量（400）以下。超えて実費を記録する場合は次の行
  [700, 'actual', '117'], // 最大量 400 を超えても精算の実費は全額（700 × 10 / 60 = 116.67 → 117）
  [700, 'increment', '146'], // 700 × 5 × 2 × 1.25 / 60 = 145.83 → 146（追加は最大量を見ない）
];
for (const [seconds, basis, amount] of accepted)
  test(`会話の秒数の金額: ${seconds} 秒 ${basis} は ${amount}`, () => {
    assert.deepEqual(computeLiveSecondsAmount(request(seconds, basis)), {
      ok: true,
      amount,
      priceVersion: 'xts.live.v1',
    });
  });

test('会話の秒数の金額: 予約に固定した版で求める（今の版が変わっても、その版の単価）', () => {
  const next = version({
    price_version: 'xts.live.v2',
    effective_from: '2030-06-01T00:00:00.000Z',
    rates: [
      {
        category: 'live_seconds',
        unit_price: '10',
        per_quantity: '60',
        minimum_quantity: '15',
        max_quantity_per_request: '400',
      },
    ],
  });
  const both = { priceVersions: [version(), next] };
  const verified = { verifiedPriceVersions: ['xts.live.v1', 'xts.live.v2'] };
  assert.equal(
    computeLiveSecondsAmount(request(60, 'actual', { ...both, ...verified }))
      .amount,
    '10',
  );
  assert.equal(
    computeLiveSecondsAmount(
      request(60, 'actual', {
        ...both,
        ...verified,
        priceVersion: 'xts.live.v2',
      }),
    ).amount,
    '20',
  );
});

const rejected = [
  [
    '版がない',
    request(60, 'actual', { priceVersion: 'xts.live.v9' }),
    ['price_version_unknown'],
  ],
  [
    '系列が違う',
    request(60, 'actual', { priceKey: 'other.key' }),
    ['price_version_unknown'],
  ],
  [
    '版が確認されていない',
    request(60, 'actual', { verifiedPriceVersions: [] }),
    ['price_unverified:xts.live.v1'],
  ],
  [
    '通貨が予算の通貨と違う',
    request(60, 'actual', { budgetCurrency: 'XXX' }),
    ['currency_mismatch'],
  ],
  [
    'live_seconds の単価がない',
    request(60, 'actual', {
      priceVersions: [version({ rates: [] })],
    }),
    ['unpriced_category:live_seconds'],
  ],
  ['負の秒数', request(-1, 'actual'), ['invalid_quantity:live_seconds']],
  ['小数の秒数', request(1.5, 'actual'), ['invalid_quantity:live_seconds']],
  [
    '安全係数が 1 未満',
    request(60, 'increment', {
      priceVersions: [
        version({
          conversion: {
            conversion_version: 'xts.conv.v1',
            to_currency: 'XTS',
            rate: '2',
            safety_factor: '0.5',
          },
        }),
      ],
    }),
    ['invalid_conversion'],
  ],
  [
    '桁あふれ',
    request(Number.MAX_SAFE_INTEGER, 'actual', {
      priceVersions: [
        version({
          rates: [
            {
              category: 'live_seconds',
              unit_price: '999999999999',
              per_quantity: '1',
              minimum_quantity: '15',
              max_quantity_per_request: null,
            },
          ],
        }),
      ],
    }),
    ['amount_overflow'],
  ],
];
for (const [name, input, reasonCodes] of rejected)
  test(`会話の秒数の金額: 拒否 ${name}`, () => {
    assert.deepEqual(computeLiveSecondsAmount(input), {
      ok: false,
      reasonCodes,
    });
  });
