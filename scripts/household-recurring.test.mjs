import assert from 'node:assert/strict';
import test from 'node:test';
import { detectHouseholdRecurring } from '../packages/domain/dist/index.js';

// 定期の支出と固定費の目安（ADR 0165）。店名・金額は合成。期待値はすべて手で書いた。

const expense = (occurredOn, merchant, amount, category = 'communication') => ({
  direction: 'expense',
  amount_yen: amount,
  occurred_on: occurredOn,
  category,
  merchant,
});

test('3 か月以上・最後が今月か先月・月 2 回以下・金額の幅が 2 倍以内の店だけを定期の支出にする', () => {
  const entries = [
    // 毎月の通信費（今月まで）。
    expense('2030-08-27', '合成モバイル', 3000),
    expense('2030-09-27', '合成モバイル', 3000),
    expense('2030-10-27', '合成モバイル', 3200),
    expense('2030-11-27', '合成モバイル', 3000),
    // 季節で変わる電気代（先月まで）。英字の大文字・小文字と全角・半角の違いは同じ店。
    expense('2030-08-05', 'GOSEI電力', 9000, 'utilities'),
    expense('2030-09-05', 'gosei電力', 6000, 'utilities'),
    expense('2030-10-05', 'ＧＯＳＥＩ電力', 5000, 'utilities'),
    // 2 か月だけ。
    expense('2030-10-01', '合成動画', 990, 'hobby'),
    expense('2030-11-01', '合成動画', 990, 'hobby'),
    // やめたサブスクリプション（最後が 2 か月前）。
    expense('2030-07-10', '合成音楽', 980, 'hobby'),
    expense('2030-08-10', '合成音楽', 980, 'hobby'),
    expense('2030-09-10', '合成音楽', 980, 'hobby'),
    // 毎日の買い物（月 3 回以上）。
    ...['08', '09', '10', '11'].flatMap((month) =>
      ['03', '13', '23'].map((day) =>
        expense(`2030-${month}-${day}`, '合成コンビニ', 500, 'food'),
      ),
    ),
    // 金額の幅が 2 倍を超える店。
    expense('2030-09-15', '合成百貨店', 1000, 'clothing_beauty'),
    expense('2030-10-15', '合成百貨店', 30000, 'clothing_beauty'),
    expense('2030-11-15', '合成百貨店', 2000, 'clothing_beauty'),
    // 収入と店名のない記録は数えない。
    { ...expense('2030-09-25', '合成給与', 200000), direction: 'income' },
    { ...expense('2030-10-25', '合成給与', 200000), direction: 'income' },
    { ...expense('2030-11-25', '合成給与', 200000), direction: 'income' },
    { ...expense('2030-09-01', 'x', 100), merchant: null },
    { ...expense('2030-10-01', 'x', 100), merchant: null },
    { ...expense('2030-11-01', 'x', 100), merchant: null },
  ];
  assert.deepEqual(detectHouseholdRecurring(entries, '2030-11'), {
    items: [
      {
        merchant: 'ＧＯＳＥＩ電力',
        category: 'utilities',
        typical_yen: 6000,
        months_seen: 3,
        last_on: '2030-10-05',
      },
      {
        merchant: '合成モバイル',
        category: 'communication',
        typical_yen: 3000,
        months_seen: 4,
        last_on: '2030-11-27',
      },
    ],
    monthly_total_yen: 9000,
  });
});

test('同じ月の 2 回までは合計を月の金額にし、記録がなければ空', () => {
  const entries = [
    expense('2030-09-01', '合成保険', 2000, 'insurance'),
    expense('2030-09-20', '合成保険', 2000, 'insurance'),
    expense('2030-10-01', '合成保険', 4000, 'insurance'),
    expense('2030-11-01', '合成保険', 4500, 'insurance'),
  ];
  assert.deepEqual(detectHouseholdRecurring(entries, '2030-12').items, [
    {
      merchant: '合成保険',
      category: 'insurance',
      typical_yen: 4000,
      months_seen: 3,
      last_on: '2030-11-01',
    },
  ]);
  // 年をまたいだ先月（12 月の記録で 1 月）も残す。
  assert.equal(
    detectHouseholdRecurring(
      [
        expense('2030-10-03', '合成回線', 5000),
        expense('2030-11-03', '合成回線', 5000),
        expense('2030-12-03', '合成回線', 5000),
      ],
      '2031-01',
    ).items.length,
    1,
  );
  assert.deepEqual(detectHouseholdRecurring([], '2030-11'), {
    items: [],
    monthly_total_yen: 0,
  });
});
