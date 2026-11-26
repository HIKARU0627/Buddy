import assert from 'node:assert/strict';
import test from 'node:test';
import {
  householdMerchantErrors,
  readHouseholdUtterance,
} from '../packages/domain/dist/index.js';

// 会話の一言からの家計の記録の候補（ADR 0171）。期待値はすべて手で書いた。

const TODAY = '2030-11-26';
const draft = (over) => ({
  kind: 'draft',
  draft: {
    amount_yen: 500,
    occurred_on: TODAY,
    merchant: null,
    payment: null,
    ...over,
  },
});
const unreadable = (reason) => ({ kind: 'unreadable', reason });
const NONE = { kind: 'none' };

test('店名・金額・今日の支出を読む', () => {
  assert.deepEqual(
    readHouseholdUtterance('コンビニで 500 円使った', TODAY),
    draft({ merchant: 'コンビニ' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('駅前のパン屋で1,280円払った。', TODAY),
    draft({ amount_yen: 1280, merchant: '駅前のパン屋' }),
  );
  // 全角の数字・円記号・空白はそろえて読む。
  assert.deepEqual(
    readHouseholdUtterance('書店で￥３，０００支払いました', TODAY),
    draft({ amount_yen: 3000, merchant: '書店' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('¥980 円で本を買った', TODAY),
    draft({ amount_yen: 980 }),
  );
});

test('「万」「千」を使った金額を読む', () => {
  assert.deepEqual(
    readHouseholdUtterance('家電屋で1万2000円の加湿器を買った', TODAY),
    draft({ amount_yen: 12000, merchant: '家電屋' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('美容院で 3 千円かかった', TODAY),
    draft({ amount_yen: 3000, merchant: '美容院' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('2万3千500円使った', TODAY),
    draft({ amount_yen: 23500 }),
  );
  assert.deepEqual(
    readHouseholdUtterance('病院で１万円払った', TODAY),
    draft({ amount_yen: 10000, merchant: '病院' }),
  );
});

test('「昨日」「おととい」を今日から数え、月・年・うるう年の境目をまたぐ', () => {
  assert.deepEqual(
    readHouseholdUtterance('昨日スーパーで 2,000 円使った', TODAY),
    draft({
      amount_yen: 2000,
      occurred_on: '2030-11-25',
      merchant: 'スーパー',
    }),
  );
  assert.deepEqual(
    readHouseholdUtterance('きのうタクシーで 1500 円払った', '2031-01-01'),
    draft({
      amount_yen: 1500,
      occurred_on: '2030-12-31',
      merchant: 'タクシー',
    }),
  );
  assert.deepEqual(
    readHouseholdUtterance(
      'おとといの夜に居酒屋で 4000 円使った',
      '2032-03-01',
    ),
    draft({ amount_yen: 4000, occurred_on: '2032-02-28', merchant: '居酒屋' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('今日は薬局で 700 円買った', TODAY),
    draft({ amount_yen: 700, merchant: '薬局' }),
  );
});

test('読めない日付の言葉・違う日付の言葉が二つあれば、日付を空にする', () => {
  assert.deepEqual(
    readHouseholdUtterance('3日にコンビニで 500 円使った', TODAY),
    draft({ occurred_on: null, merchant: 'コンビニ' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('先週、本屋で 500 円使った', TODAY),
    draft({ occurred_on: null, merchant: '本屋' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('昨日じゃなくて今日 500 円使った', TODAY),
    draft({ occurred_on: null }),
  );
  // 今日の日付が家計の記録の範囲（2000〜2099 年）の外なら日付を空にする。
  assert.deepEqual(
    readHouseholdUtterance('昨日 500 円使った', '2000-01-01'),
    draft({ occurred_on: null }),
  );
  assert.deepEqual(
    readHouseholdUtterance('500 円使った', '2030-02-30'),
    draft({ occurred_on: null }),
  );
});

test('「現金で」「カードで」を支払い手段として読む', () => {
  assert.deepEqual(
    readHouseholdUtterance('現金で 500 円払った', TODAY),
    draft({ payment: '現金' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('カフェで現金で 450 円払った', TODAY),
    draft({ amount_yen: 450, merchant: 'カフェ', payment: '現金' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('カードで、ガソリンスタンドで 6000 円払った', TODAY),
    draft({ amount_yen: 6000, merchant: 'ガソリンスタンド' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('クレジットカードでホテルで 9800 円払った', TODAY),
    draft({
      amount_yen: 9800,
      merchant: 'ホテル',
      payment: 'クレジットカード',
    }),
  );
});

test('店名にカード番号らしい数字の並び・長すぎる店名があれば店名を入れない', () => {
  assert.deepEqual(
    readHouseholdUtterance('カード 1234-5678-9012-3456 で 500 円払った', TODAY),
    draft({}),
  );
  assert.deepEqual(
    readHouseholdUtterance('店 1234 5678 9012 で 500 円使った', TODAY),
    draft({}),
  );
  assert.deepEqual(
    readHouseholdUtterance(`${'あ'.repeat(101)}で 500 円使った`, TODAY),
    draft({}),
  );
  assert.deepEqual(
    readHouseholdUtterance(`${'あ'.repeat(100)}で 500 円使った`, TODAY),
    draft({ merchant: 'あ'.repeat(100) }),
  );
  assert.deepEqual(householdMerchantErrors('店 1234 5678 9012'), [
    'merchant_long_digits',
  ]);
  assert.deepEqual(householdMerchantErrors('コンビニ'), []);
  assert.deepEqual(householdMerchantErrors(null), []);
});

test('金額の上限と下限', () => {
  assert.deepEqual(
    readHouseholdUtterance('9,999,999,999 円払った', TODAY),
    draft({ amount_yen: 9999999999 }),
  );
  assert.deepEqual(
    readHouseholdUtterance('1 円使った', TODAY),
    draft({ amount_yen: 1 }),
  );
  for (const said of [
    '10,000,000,000 円払った',
    '12345678901 円使った',
    '1234567890123456 円使った',
    '0 円使った',
    '0500 円使った',
    '1,00 円使った',
    '1万12000円使った',
    '1234567万円使った',
  ])
    assert.deepEqual(
      readHouseholdUtterance(said, TODAY),
      unreadable('amount_invalid'),
      said,
    );
});

test('読めない金額・円以外の通貨・負の金額・取り消し・複数の金額は候補にせず理由を返す', () => {
  const cases = [
    ['コンビニで五百円使った', 'amount_missing'],
    ['コンビニで 12.5 円使った', 'amount_missing'],
    ['ホテルで 120 ドル払った', 'foreign_currency'],
    ['空港で $45 使った', 'foreign_currency'],
    ['ネットで 30 EUR 払った', 'foreign_currency'],
    ['500 円と 10 ドル使った', 'foreign_currency'],
    ['コンビニで -500 円使った', 'negative_amount'],
    ['マイナス 500 円使った', 'negative_amount'],
    ['−¥500 払った', 'negative_amount'],
    ['500 円払ったけど返金された', 'cancellation'],
    ['キャンセルした 500 円を払った', 'cancellation'],
    ['コンビニで 500 円と 300 円使った', 'several_amounts'],
    ['500円払った、あと200円使った', 'several_amounts'],
  ];
  for (const [said, reason] of cases)
    assert.deepEqual(
      readHouseholdUtterance(said, TODAY),
      unreadable(reason),
      said,
    );
});

test('支出の話でない一言・問い・仮定・数のない「円」は読まない', () => {
  for (const said of [
    '今日の予定を見せて',
    '「牛乳を買う」を用事に登録して',
    'コンビニで 500 円',
    '電車で 30 分かかった',
    '円安で旅行にお金を使った',
    '昨日 500 円使ったっけ',
    'コンビニで 500 円使った？',
    '1000 円使ったら何が買える',
    '500 円もらった',
    'コンビニで 500 円使わなかった',
    '',
  ])
    assert.deepEqual(readHouseholdUtterance(said, TODAY), NONE, said);
});
