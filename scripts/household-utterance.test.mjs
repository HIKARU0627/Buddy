import assert from 'node:assert/strict';
import test from 'node:test';
import {
  householdMerchantErrors,
  readHouseholdUtterance,
} from '../packages/domain/dist/index.js';

// 会話の一言からの家計の記録の候補（ADR 0171・0174）。期待値はすべて手で書いた。

const TODAY = '2030-11-26';
const draft = (over) => ({
  kind: 'draft',
  draft: {
    direction: 'expense',
    amount_yen: 500,
    occurred_on: TODAY,
    merchant: null,
    memo: null,
    payment: null,
    ...over,
  },
});
// 収入の候補。出どころは店名ではなくメモに入れる（ADR 0174）。
const income = (over) => draft({ direction: 'income', ...over });
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
    'コンビニで 500 円使わなかった',
    '',
  ])
    assert.deepEqual(readHouseholdUtterance(said, TODAY), NONE, said);
});

test('金額でない「円」（円ショップ・円札・円玉・円引き・円オフ）の前の数は金額に数えない', () => {
  for (const text of [
    '100円ショップで買った',
    '100 円 ショップで買った',
    '１００円ショップで買った',
    '100円均一で買った',
    '1000円札で払った',
    '1,000 円 札で払った',
    '500円玉で払った',
    '500円引きで買った',
    '500円offで買った',
    '500円OFFで買った',
    '500円オフで買った',
    '１万円札で払った',
  ])
    assert.deepEqual(
      readHouseholdUtterance(text, TODAY),
      unreadable('amount_missing'),
      text,
    );
  // 実際の金額が別にあれば、それを読む。店名は「100円ショップ」。
  assert.deepEqual(
    readHouseholdUtterance('100円ショップで500円使った', TODAY),
    draft({ merchant: '100円ショップ' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('１００円ショップで５００円使った', TODAY),
    draft({ merchant: '100円ショップ' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('100 円 ショップで 500 円使った', TODAY),
    draft({ merchant: '100 円 ショップ' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('1000円札で払って、本屋で1,200円使った', TODAY),
    draft({ amount_yen: 1200, merchant: '本屋' }),
  );
  // 「円」の直後がほかの言葉なら、これまでどおり金額。
  assert.deepEqual(readHouseholdUtterance('500円で買った', TODAY), draft({}));
  assert.deepEqual(
    readHouseholdUtterance('500円ちょうど払った', TODAY),
    draft({}),
  );
});

test('日付の言葉: さきおとといは 3 日前、昨夜・昨晩は昨日、年・月・週の言葉は日付を空にする', () => {
  assert.deepEqual(
    readHouseholdUtterance('さきおととい500円使った', TODAY),
    draft({ occurred_on: '2030-11-23' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('さきおとといコンビニで500円使った', TODAY),
    draft({ occurred_on: '2030-11-23', merchant: 'コンビニ' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('おととい500円使った', TODAY),
    draft({ occurred_on: '2030-11-24' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('昨夜500円使った', TODAY),
    draft({ occurred_on: '2030-11-25' }),
  );
  assert.deepEqual(
    readHouseholdUtterance('昨晩500円使った', TODAY),
    draft({ occurred_on: '2030-11-25' }),
  );
  for (const word of [
    '去年',
    '昨年',
    '今年',
    '今月',
    '今週',
    '先週',
    '先々週',
    '先月',
    '先々月',
    '来週',
  ])
    assert.deepEqual(
      readHouseholdUtterance(`${word}コンビニで500円使った`, TODAY),
      draft({ occurred_on: null, merchant: 'コンビニ' }),
      word,
    );
});

test('店名の前の時の言葉は助詞がなくても除き、日付の言葉が二つ以上あれば日付を空にして店名に入れない', () => {
  const cases = [
    ['朝コンビニで500円使った', TODAY, 'コンビニ'],
    ['昼マックで500円使った', TODAY, 'マック'],
    ['夜ガストで500円使った', TODAY, 'ガスト'],
    ['夕方コンビニで500円使った', TODAY, 'コンビニ'],
    ['今朝コンビニで500円使った', TODAY, 'コンビニ'],
    ['朝 コンビニで500円使った', TODAY, 'コンビニ'],
    ['朝は コンビニで500円使った', TODAY, 'コンビニ'],
    ['昨夜コンビニで500円使った', '2030-11-25', 'コンビニ'],
    ['昨日の朝コンビニで500円使った', '2030-11-25', 'コンビニ'],
    // 店名の頭が漢字なら、朝・昼・夜は店名の一部。
    ['朝日食堂で500円使った', TODAY, '朝日食堂'],
    ['夜景の見えるバーで500円使った', TODAY, '夜景の見えるバー'],
    // 「と」が次の時の言葉につながらなければ店名の一部。
    ['昨日とんかつ屋で500円使った', '2030-11-25', 'とんかつ屋'],
  ];
  for (const [text, on, merchant] of cases)
    assert.deepEqual(
      readHouseholdUtterance(text, TODAY),
      draft({ occurred_on: on, merchant }),
      text,
    );
  assert.deepEqual(
    readHouseholdUtterance('おとといと昨日で500円使った', TODAY),
    draft({ occurred_on: null, merchant: null }),
  );
  assert.deepEqual(
    readHouseholdUtterance('昨日や今日で500円使った', TODAY),
    draft({ occurred_on: null, merchant: null }),
  );
  assert.deepEqual(
    readHouseholdUtterance('昨日と今日コンビニで500円使った', TODAY),
    draft({ occurred_on: null, merchant: 'コンビニ' }),
  );
});

// --- 収入の候補（ADR 0174） ---

test('収入の言い方（入った・振り込まれた・もらった・売れた・売った・稼いだ）を収入の候補として読み、出どころをメモに入れる', () => {
  const cases = [
    ['給料が 25 万円入った', income({ amount_yen: 250000, memo: '給料' })],
    [
      'お小遣いを 5000 円もらった',
      income({ amount_yen: 5000, memo: 'お小遣い' }),
    ],
    ['フリマで 3,000 円売れた', income({ amount_yen: 3000, memo: 'フリマ' })],
    ['親から１万円もらいました。', income({ amount_yen: 10000, memo: '親' })],
    ['バイトで 8,000 円稼いだよ', income({ amount_yen: 8000, memo: 'バイト' })],
    ['給料 25 万 3000 円が振り込まれた', income({ amount_yen: 253000 })],
    [
      'ボーナスが 30 万円振り込まれました！',
      income({ amount_yen: 300000, memo: 'ボーナス' }),
    ],
    [
      '古いカメラを 1 万 2000 円で売った',
      income({ amount_yen: 12000, memo: '古いカメラ' }),
    ],
    [
      'お祝いを ¥30,000 いただいた',
      income({ amount_yen: 30000, memo: 'お祝い' }),
    ],
    ['500 円もらった', income({})],
    ['現金で 5000 円もらった', income({ amount_yen: 5000, payment: '現金' })],
    [
      'フリマで現金で 3000 円売れた',
      income({ amount_yen: 3000, memo: 'フリマ', payment: '現金' }),
    ],
    // 金額が言い方の後にあれば、出どころは読まない（金額のすぐ前が助詞でない）。
    ['給料が入った、25 万円', income({ amount_yen: 250000 })],
  ];
  for (const [said, expected] of cases)
    assert.deepEqual(readHouseholdUtterance(said, TODAY), expected, said);
});

test('収入の日付の言葉と、出どころの前の時の言葉', () => {
  const cases = [
    [
      '昨日給料が 25 万円入った',
      income({ amount_yen: 250000, occurred_on: '2030-11-25', memo: '給料' }),
    ],
    [
      '今日は給料が 25 万円入った',
      income({ amount_yen: 250000, memo: '給料' }),
    ],
    [
      'おとといフリマで 3000 円売れた',
      income({ amount_yen: 3000, occurred_on: '2030-11-24', memo: 'フリマ' }),
    ],
    [
      '25日に給料が 25 万円入った',
      income({ amount_yen: 250000, occurred_on: null, memo: '給料' }),
    ],
    [
      '今月の給料が 25 万円入った',
      income({ amount_yen: 250000, occurred_on: null, memo: '給料' }),
    ],
    [
      '先週、お小遣いを 3000 円もらった',
      income({ amount_yen: 3000, occurred_on: null, memo: 'お小遣い' }),
    ],
  ];
  for (const [said, expected] of cases)
    assert.deepEqual(readHouseholdUtterance(said, TODAY), expected, said);
  // 年の境目。
  assert.deepEqual(
    readHouseholdUtterance('きのうお年玉を 1 万円もらった', '2031-01-01'),
    income({ amount_yen: 10000, occurred_on: '2030-12-31', memo: 'お年玉' }),
  );
});

test('収入の出どころに口座番号らしい数字の並び・長すぎる文字があればメモに入れない', () => {
  assert.deepEqual(
    readHouseholdUtterance(
      '口座 1234 5678 9012 から 5000 円が振り込まれた',
      TODAY,
    ),
    income({ amount_yen: 5000 }),
  );
  assert.deepEqual(
    readHouseholdUtterance(`${'あ'.repeat(101)}から 500 円もらった`, TODAY),
    income({}),
  );
  assert.deepEqual(
    readHouseholdUtterance(`${'あ'.repeat(100)}から 500 円もらった`, TODAY),
    income({ memo: 'あ'.repeat(100) }),
  );
  // 支出の店名は今までどおり店名の欄に入れ、メモは空のまま。
  assert.deepEqual(readHouseholdUtterance('コンビニで 500 円使った', TODAY), {
    kind: 'draft',
    draft: {
      direction: 'expense',
      amount_yen: 500,
      occurred_on: TODAY,
      merchant: 'コンビニ',
      memo: null,
      payment: null,
    },
  });
});

test('支出と収入の言い方が両方ある一言は、取り違えないよう候補にせず理由を返す', () => {
  for (const said of [
    '本を 3000 円で売った後、別の本を買った',
    '3000 円で買った本を売った',
    'メルカリで買った服が 2000 円で売れた',
    '古本を 500 円で売って、そのお金で本を買った',
    '1 万円もらって 3000 円払った',
    'お小遣いをもらったので 500 円使った',
    '給料が 25 万円入って、服を買った',
    '25 万円入った。服に 3 万円使った',
  ])
    assert.deepEqual(
      readHouseholdUtterance(said, TODAY),
      unreadable('direction_unclear'),
      said,
    );
  // 支出だけの一言は、今までどおり支出の候補（売り場・店で売っていた品・売れ残り・「店に入って」は収入の話ではない）。
  const expenses = [
    ['コンビニで売ってたパンを 300 円で買った', draft({ amount_yen: 300 })],
    ['売り場で 500 円払った', draft({ merchant: '売り場' })],
    ['カフェに入って 500 円使った', draft({})],
    ['売れ残りを 300 円で買った', draft({ amount_yen: 300 })],
  ];
  for (const [said, expected] of expenses)
    assert.deepEqual(readHouseholdUtterance(said, TODAY), expected, said);
});

test('返金・払い戻し・取り消しは収入にせず、返金か収入か決められない言い方は候補にしない', () => {
  const cases = [
    ['返金で 500 円入った', 'cancellation'],
    ['払い戻しで 3000 円もらった', 'cancellation'],
    ['キャンセルされて 1200 円振り込まれた', 'cancellation'],
    ['キャンセルで 3000 円戻ってきた', 'cancellation'],
    ['500 円戻ってきた', 'direction_unclear'],
    ['払った 500 円が戻ってきた', 'direction_unclear'],
    ['1000 円返ってきた', 'direction_unclear'],
    ['500 円戻りました', 'direction_unclear'],
  ];
  for (const [said, reason] of cases)
    assert.deepEqual(
      readHouseholdUtterance(said, TODAY),
      unreadable(reason),
      said,
    );
});

test('お釣り・立て替え・貸し借り・ポイント・振替・「〜てもらった」・物の説明は収入として読まない', () => {
  for (const said of [
    'お釣りを 500 円もらった',
    '立て替えた 3000 円をもらった',
    '割り勘で 2000 円もらった',
    '友達に貸した 1000 円を返してもらった',
    '1000 円おごってもらった',
    'ポイントが 500 円分入った',
    '商品券を 3000 円分もらった',
    '貯金用の口座に 5 万円移した',
    'ATM で 1 万円おろした',
    '口座に移した 5 万円が入った',
    'Suica に 3000 円チャージした',
    '1000 円入った財布を落とした',
  ])
    assert.deepEqual(readHouseholdUtterance(said, TODAY), NONE, said);
  // お釣りの話があっても、支出の言い方だけなら今までどおり支出の候補。
  assert.deepEqual(
    readHouseholdUtterance('コンビニで 800 円払った。お釣りももらった', TODAY),
    draft({ amount_yen: 800, merchant: 'コンビニ' }),
  );
});

test('収入の問い・仮定・否定は読まない', () => {
  for (const said of [
    '給料 25 万円入ったっけ',
    '給料が 25 万円入った？',
    '5000 円もらったら何を買おう',
    '25 万円入ったなら貯金する',
    '5000 円もらわなかった',
    '給料が 25 万円入らなかった',
    'まだ 5000 円もらってない',
    '給料が入ったよ',
  ])
    assert.deepEqual(readHouseholdUtterance(said, TODAY), NONE, said);
});

test('収入の金額の境（0 円・上限・桁あふれ）と読めない金額', () => {
  assert.deepEqual(
    readHouseholdUtterance('9,999,999,999 円入った', TODAY),
    income({ amount_yen: 9999999999 }),
  );
  assert.deepEqual(
    readHouseholdUtterance('1 円もらった', TODAY),
    income({ amount_yen: 1 }),
  );
  const cases = [
    ['0 円もらった', 'amount_invalid'],
    ['10,000,000,000 円入った', 'amount_invalid'],
    ['12345678901 円振り込まれた', 'amount_invalid'],
    ['1234567万円もらった', 'amount_invalid'],
    ['給料が二十五万円入った', 'amount_missing'],
    ['1000円札をもらった', 'amount_missing'],
    ['ボーナスが 30 万円と 5 万円入った', 'several_amounts'],
    ['100 ドルもらった', 'foreign_currency'],
    ['−5000 円入った', 'negative_amount'],
  ];
  for (const [said, reason] of cases)
    assert.deepEqual(
      readHouseholdUtterance(said, TODAY),
      unreadable(reason),
      said,
    );
});
