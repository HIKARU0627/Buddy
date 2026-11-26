import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOUSEHOLD_CATEGORIES,
  householdCategoryByLabel,
  householdContentErrors,
  householdDefaultCategory,
  householdMonthOf,
  householdMonthSpan,
  householdRuleApplies,
  householdRuleWritable,
  householdSourceKeyMaterial,
  isHouseholdDate,
  normalizeHouseholdMerchant,
  summarizeHouseholdMonth,
} from '../packages/domain/dist/index.js';

// 家計簿の段階 1: 分類・記録の内容・月の集計・出所の鍵・店名からの分類の規則（ADR 0158）。
// 期待値はすべて手で書いた。店名・金額は合成。

const valid = {
  direction: 'expense',
  amount_yen: 1280,
  occurred_on: '2030-10-01',
  occurred_time: '12:30',
  category: 'food',
  merchant: '合成食堂',
  memo: null,
  payment: '合成カード',
};

test('分類はマネーフォワード ME の大項目 16 と、その他・未分類・収入・振替の 20 で、表示名から引ける', () => {
  assert.deepEqual(
    HOUSEHOLD_CATEGORIES.map((category) => category.label),
    [
      '食費',
      '現金・カード',
      '交通費',
      '趣味・娯楽',
      '日用品',
      '衣服・美容',
      '特別な支出',
      '交際費',
      '住宅',
      '水道・光熱費',
      '自動車',
      '保険',
      '税・社会保障',
      '教養・教育',
      '通信費',
      '健康・医療',
      'その他',
      '未分類',
      '収入',
      '振替',
    ],
  );
  assert.equal(householdCategoryByLabel(' 水道・光熱費 ')?.id, 'utilities');
  assert.equal(householdCategoryByLabel('食料品'), null);
  assert.equal(householdDefaultCategory('expense'), 'uncategorized');
  assert.equal(householdDefaultCategory('income'), 'income');
  assert.equal(householdDefaultCategory('transfer'), 'transfer');
});

test('記録の内容: 正しい形は理由なし。金額・日付・時刻・分類と向き・項目の過不足を見分ける', () => {
  assert.deepEqual(householdContentErrors(valid), []);
  assert.deepEqual(
    householdContentErrors({
      ...valid,
      amount_yen: 0,
      occurred_on: '2030-02-29',
      occurred_time: '24:00',
    }),
    ['amount_invalid', 'occurred_on_invalid', 'occurred_time_invalid'],
  );
  assert.deepEqual(householdContentErrors({ ...valid, amount_yen: 12.5 }), [
    'amount_invalid',
  ]);
  assert.deepEqual(
    householdContentErrors({ ...valid, amount_yen: 10_000_000_000 }),
    ['amount_invalid'],
  );
  assert.deepEqual(householdContentErrors({ ...valid, category: 'income' }), [
    'category_direction_mismatch',
  ]);
  assert.deepEqual(
    householdContentErrors({
      ...valid,
      direction: 'income',
      category: 'income',
    }),
    [],
  );
  assert.deepEqual(
    householdContentErrors({ ...valid, category: 'groceries' }),
    ['category_invalid'],
  );
  const missing = { ...valid };
  delete missing.memo;
  assert.deepEqual(householdContentErrors(missing), ['content_keys_invalid']);
  assert.deepEqual(householdContentErrors({ ...valid, extra: 1 }), [
    'content_keys_invalid',
  ]);
  assert.deepEqual(householdContentErrors(null), ['content_invalid']);
  // 2032 年はうるう年。2100 年は範囲外。
  assert.equal(isHouseholdDate('2032-02-29'), true);
  assert.equal(isHouseholdDate('2100-01-01'), false);
  assert.equal(isHouseholdDate('1999-12-31'), false);
});

test('記録の内容: 店名・メモ・支払い手段の長さ・空・制御文字・カード番号のような長い数字を拒否する', () => {
  assert.deepEqual(householdContentErrors({ ...valid, merchant: '  ' }), [
    'merchant_empty',
  ]);
  assert.deepEqual(
    householdContentErrors({ ...valid, merchant: 'あ'.repeat(101) }),
    ['merchant_too_long'],
  );
  assert.deepEqual(
    householdContentErrors({ ...valid, merchant: 'あ'.repeat(100) }),
    [],
  );
  assert.deepEqual(householdContentErrors({ ...valid, merchant: '店\n名' }), [
    'merchant_control_character',
  ]);
  // メモは改行を許す。
  assert.deepEqual(
    householdContentErrors({ ...valid, memo: '1 行目\n2 行目' }),
    [],
  );
  assert.deepEqual(
    householdContentErrors({ ...valid, payment: 'カード 1234-5678-9012-3456' }),
    ['payment_long_digits'],
  );
  assert.deepEqual(
    householdContentErrors({ ...valid, memo: '口座 ０１２３４５６７８９０１' }),
    ['memo_long_digits'],
  );
  // 11 桁までは通す（電話番号の写しは拒否しないが、カード・口座の番号の長さは拒否する）。
  assert.deepEqual(
    householdContentErrors({ ...valid, memo: '01234567890' }),
    [],
  );
  assert.deepEqual(
    householdContentErrors({ ...valid, payment: 'カード（末尾 3456）' }),
    [],
  );
});

test('月の集計: 支出は分類ごとに多い順、同額は分類の表示の順。振替は支出・収入に入れない', () => {
  const summary = summarizeHouseholdMonth([
    { direction: 'expense', amount_yen: 1000, category: 'food' },
    { direction: 'expense', amount_yen: 500, category: 'food' },
    { direction: 'expense', amount_yen: 1500, category: 'daily_goods' },
    { direction: 'expense', amount_yen: 3000, category: 'transport' },
    { direction: 'income', amount_yen: 200000, category: 'income' },
    { direction: 'transfer', amount_yen: 45000, category: 'transfer' },
  ]);
  assert.deepEqual(summary, {
    expense_yen: 6000,
    income_yen: 200000,
    balance_yen: 194000,
    entry_count: 6,
    // 食費と日用品は同じ 1500 円。表示の順で食費が先。
    expense_by_category: [
      { category: 'transport', total_yen: 3000, count: 1 },
      { category: 'food', total_yen: 1500, count: 2 },
      { category: 'daily_goods', total_yen: 1500, count: 1 },
    ],
    transfer_yen: 45000,
  });
  assert.deepEqual(summarizeHouseholdMonth([]), {
    expense_yen: 0,
    income_yen: 0,
    balance_yen: 0,
    entry_count: 0,
    expense_by_category: [],
    transfer_yen: 0,
  });
});

test('月: 日付から月を出し、範囲の月の数を数える（逆順・形の誤りは null）', () => {
  assert.equal(householdMonthOf('2030-10-31'), '2030-10');
  assert.equal(householdMonthOf('2030-10-32'), null);
  assert.equal(householdMonthSpan('2030-10', '2030-10'), 1);
  assert.equal(householdMonthSpan('2029-11', '2030-10'), 12);
  assert.equal(householdMonthSpan('2030-10', '2030-09'), null);
  assert.equal(householdMonthSpan('2030-13', '2030-12'), null);
});

test('出所の鍵の材料: 種類ごとに項目の順を固定し、形の誤りは null', () => {
  assert.equal(
    householdSourceKeyMaterial({
      kind: 'mail_notice',
      provider: 'google',
      account_id: 'acct-1',
      remote_id: 'msg-1',
      index: 0,
    }),
    '["buddy.household_source.v1","mail_notice","google","acct-1","msg-1",0]',
  );
  assert.equal(
    householdSourceKeyMaterial({
      kind: 'csv_import',
      origin: 'moneyforward',
      row_id: 'row-1',
    }),
    '["buddy.household_source.v1","csv_import","moneyforward","row-1"]',
  );
  assert.equal(
    householdSourceKeyMaterial({ kind: 'manual', entry_id: 'e-1' }),
    '["buddy.household_source.v1","manual","e-1"]',
  );
  assert.equal(
    householdSourceKeyMaterial({
      kind: 'mail_notice',
      provider: 'google',
      account_id: 'acct-1',
      remote_id: 'msg-1',
      index: 100,
    }),
    null,
  );
  assert.equal(
    householdSourceKeyMaterial({
      kind: 'csv_import',
      origin: 'other',
      row_id: 'row-1',
    }),
    null,
  );
});

test('店名の正規化と規則: 全角英数・大文字・空白をそろえ、本人の規則は取込みで上書きしない', () => {
  assert.equal(
    normalizeHouseholdMerchant('  ＡＢＣ　ストア  本店 '),
    'abc ストア 本店',
  );
  assert.equal(normalizeHouseholdMerchant('ｺﾞｳｾｲ'), 'ゴウセイ');
  assert.equal(normalizeHouseholdMerchant('   '), null);
  assert.equal(householdRuleWritable(null, 'import'), true);
  assert.equal(householdRuleWritable('import', 'import'), true);
  assert.equal(householdRuleWritable('import', 'user'), true);
  assert.equal(householdRuleWritable('user', 'user'), true);
  assert.equal(householdRuleWritable('user', 'import'), false);
  assert.equal(householdRuleApplies('expense', 'food'), true);
  assert.equal(householdRuleApplies('income', 'food'), false);
  assert.equal(householdRuleApplies('expense', 'unknown'), false);
});
