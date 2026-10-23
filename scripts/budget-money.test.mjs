import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  amountFromDecimal,
  budgetOriginLabel,
  budgetPoolLabel,
  formatAmount,
  formatMoney,
  toReservationView,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// 金額（契約の Money。通貨単位の百万分の一の整数文字列）の表示と小数の入力の変換（B07-05、ADR 0039）。
// 期待値は手で書いた値。浮動小数点数を使わないので、18 桁の端でも桁を失わない。

test('an amount is shown with grouped whole digits and at least two decimals, trimming trailing zeros', () => {
  const cases = [
    ['0', '0.00'],
    ['1', '0.000001'],
    ['40', '0.00004'],
    ['500000', '0.50'],
    ['1000000', '1.00'],
    ['40000000', '40.00'],
    ['3500000', '3.50'],
    ['1234567890', '1,234.56789'],
    ['999999999999999999', '999,999,999,999.999999'],
  ];
  for (const [amount, expected] of cases)
    assert.equal(formatAmount(amount), expected, amount);
  // 契約の形でない値は、そのまま返す（変換しない）。
  for (const wrong of ['', '-1', '1.5', '01', '1e3', '1000000000000000000'])
    assert.equal(formatAmount(wrong), wrong, wrong);
});

test('money keeps the currency code and joins it to the number with a no-break space', () => {
  assert.equal(
    formatMoney({ currency: 'XTS', amount: '40000000' }),
    'XTS 40.00',
  );
  assert.equal(
    formatMoney({ currency: 'XTS', amount: '15000000' }),
    'XTS 15.00',
  );
});

test('a typed decimal becomes an integer of millionths without rounding, and anything else is refused', () => {
  const accepted = [
    ['3', '3000000'],
    ['3.5', '3500000'],
    ['0.000001', '1'],
    ['0.000040', '40'],
    ['40.00', '40000000'],
    ['0', '0'],
    ['  12.34  ', '12340000'],
  ];
  for (const [text, expected] of accepted)
    assert.equal(amountFromDecimal(text), expected, text);
  // Amount の上限（18 桁）を超える入力は受け付けない。
  assert.equal(amountFromDecimal('999999999999999999'), null);
  assert.equal(amountFromDecimal('999999999999.999999'), '999999999999999999');
  assert.equal(amountFromDecimal('1000000000000.000000'), null);
  for (const wrong of [
    '',
    ' ',
    '-3',
    '+3',
    '3.',
    '.5',
    '3.1234567',
    '1e3',
    '1,000',
    '３',
    '3 5',
    'abc',
  ])
    assert.equal(amountFromDecimal(wrong), null, JSON.stringify(wrong));
});

test('the budget entries and requests in the contract fixtures use only the synthetic currency XTS', async () => {
  const cases = parseStrictJson(
    await readFile(
      new URL('packages/contracts/fixtures/schema-cases.json', root),
      'utf8',
    ),
  );
  const currencies = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'currency' && typeof inner === 'string')
          currencies.add(inner);
        else walk(inner);
      }
  };
  const budgetCases = cases.filter(
    (entry) =>
      entry.id.startsWith('desktop-budget-') ||
      entry.id.startsWith('desktop-ipc-budget-') ||
      entry.id.startsWith('desktop-connection-budget-') ||
      entry.id.startsWith('desktop-response-budget-'),
  );
  assert(budgetCases.length >= 20, 'the budget cases exist');
  for (const entry of budgetCases) walk(entry.value);
  assert.deepEqual([...currencies], ['XTS']);
  // 実費の入力は整数の文字列（小数・個人の金額の書き方は契約に入れない）。
  for (const entry of budgetCases)
    if (entry.valid && entry.value.payload?.actual_amount !== undefined)
      assert.match(entry.value.payload.actual_amount, /^[0-9]{1,18}$/u);
});

test('pools and origins are shown by names a person can read; a pool outside the table never leaks its internal ID', () => {
  // 手で書いた対応表（枠の木。ADR 0006・0039）。
  const pools = {
    total: '全体',
    llm_search: '会話と検索の合計',
    llm: '会話',
    'llm.background': '自動の解析',
    search: '検索',
    voice: '音声',
    overage: '超過枠',
  };
  for (const [id, label] of Object.entries(pools))
    assert.equal(budgetPoolLabel(id), label, id);
  for (const id of [
    'llm.experiment',
    'custom',
    '',
    'constructor',
    '__proto__',
  ]) {
    assert.equal(budgetPoolLabel(id), '別の枠', id);
  }
  const origins = {
    owner_request: '本人の依頼',
    autonomous_analysis: '自動の解析',
    auto_execution: '自動の実行',
    initial_import: '初回の読み込み',
    shadow_mode: '影モード',
  };
  for (const [id, label] of Object.entries(origins))
    assert.equal(budgetOriginLabel(id), label, id);
});

test('the reservation view carries the time and origin only when they are recorded', () => {
  const record = {
    reservationId: '00000000-0000-4000-8000-0000000000b1',
    requestId: '00000000-0000-4000-8000-0000000000b2',
    profileId: 'synthetic.text.v1',
    priceVersion: 'xts.text.v1',
    poolId: 'llm',
    budgetMonth: '2030-10',
    currency: 'XTS',
    reserved: '40',
    maxLiability: '40',
    status: 'usage_unknown',
    actualGross: null,
    providerReconciliationId: null,
    approvalId: null,
    revision: '1',
    overrunReviewed: false,
  };
  const plain = toReservationView(record);
  assert(!('created_at' in plain) && !('origin' in plain));
  assert(!('origin' in toReservationView({ ...record, origin: null })));
  const shown = toReservationView({
    ...record,
    createdAt: Date.parse('2030-10-15T00:00:00.000Z'),
    origin: 'autonomous_analysis',
  });
  assert.equal(shown.created_at, '2030-10-15T00:00:00.000Z');
  assert.equal(shown.origin, 'autonomous_analysis');
});
