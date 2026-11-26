import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOUSEHOLD_EXPORT_HEADER,
  HOUSEHOLD_EXPORT_MONTH_MAX,
  buildHouseholdCsv,
  householdCsvField,
  householdCsvGuard,
  householdExportFileName,
  householdExportMonths,
  readMoneyforwardExport,
  splitHouseholdCsv,
} from '../packages/domain/dist/index.js';

// 家計の記録の CSV への書き出し（ADR 0172）。記録の中身はすべて合成。期待値の CSV は手で書いた文字列で、実装と同じ処理で
// 作っていない。取り込み（ADR 0164）で読み直せることも確かめる。

const HEADER_LINE =
  '計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID,時刻,向き,出所の種類';

const entry = (fields = {}) => ({
  entry_id: 'e1',
  source_kind: 'manual',
  direction: 'expense',
  amount_yen: 1280,
  occurred_on: '2030-11-03',
  occurred_time: null,
  category: 'food',
  merchant: '合成の食堂',
  memo: null,
  payment: null,
  ...fields,
});

const csv = (...lines) => `\uFEFF${[HEADER_LINE, ...lines].join('\r\n')}\r\n`;

test('見出し: 取り込みと同じ先頭の 10 列に、時刻・向き・出所の種類を足す', () => {
  assert.equal(HOUSEHOLD_EXPORT_HEADER.join(','), HEADER_LINE);
  assert.equal(HOUSEHOLD_EXPORT_HEADER.length, 13);
  assert.equal(HOUSEHOLD_EXPORT_MONTH_MAX, 120);
});

test('記録の写し方: 支出は負・収入と振替は正の金額、向きと出所は日本語、BOM と CRLF', () => {
  assert.equal(
    buildHouseholdCsv([
      entry({
        entry_id: 'a',
        occurred_time: '09:05',
        payment: '合成のカード',
        source_kind: 'mail_notice',
      }),
      entry({
        entry_id: 'b',
        direction: 'income',
        amount_yen: 250000,
        category: 'income',
        merchant: '合成の勤め先',
        memo: '11 月分',
        source_kind: 'csv_import',
        occurred_on: '2030-11-25',
      }),
      entry({
        entry_id: 'c',
        direction: 'transfer',
        amount_yen: 30000,
        category: 'transfer',
        merchant: null,
        occurred_on: '2030-11-27',
      }),
    ]),
    csv(
      // 日付の古い順（入力は新しい順なので、並びを逆にして日付で整える）。
      '1,2030/11/03,合成の食堂,-1280,合成のカード,食費,,,0,buddy:a,09:05,支出,利用通知メール',
      '1,2030/11/25,合成の勤め先,250000,,収入,,11 月分,0,buddy:b,,収入,書き出しの取り込み',
      '1,2030/11/27,,30000,,振替,,,1,buddy:c,,振替,手入力',
    ),
  );
  assert.equal(buildHouseholdCsv([]), csv());
});

test('並び: 日付の古い順、同じ日は時刻の早い順（時刻なしが先）、同じなら入力の逆（古く作った記録が先）', () => {
  const lines = buildHouseholdCsv([
    entry({ entry_id: 'n1', occurred_on: '2030-11-10' }),
    entry({ entry_id: 't2', occurred_time: '20:00' }),
    entry({ entry_id: 't1', occurred_time: '08:30' }),
    entry({ entry_id: 'n2' }),
    entry({ entry_id: 'n3' }),
    entry({ entry_id: 'old', occurred_on: '2030-10-31' }),
  ])
    .split('\r\n')
    .slice(1, -1)
    .map((line) => line.split(',')[9]);
  // 入力は新しい順なので、同じ日の時刻なし 3 件（n2・n3 と n1 は別の日）は n3 が先。
  assert.deepEqual(lines, [
    'buddy:old',
    'buddy:n3',
    'buddy:n2',
    'buddy:t1',
    'buddy:t2',
    'buddy:n1',
  ]);
});

test('コンマ・引用符・改行・前後の空白を含む値は引用符で囲み、中の引用符は二つにする', () => {
  assert.equal(householdCsvField('合成の店'), '合成の店');
  assert.equal(householdCsvField('A,B'), '"A,B"');
  assert.equal(
    householdCsvField('彼は "高い" と言った'),
    '"彼は ""高い"" と言った"',
  );
  assert.equal(householdCsvField('1 行目\n2 行目'), '"1 行目\n2 行目"');
  assert.equal(householdCsvField('1 行目\r\n2 行目'), '"1 行目\r\n2 行目"');
  assert.equal(householdCsvField(' 先頭に空白'), '" 先頭に空白"');
  assert.equal(householdCsvField('末尾に空白 '), '"末尾に空白 "');
  assert.equal(householdCsvField(''), '');
  assert.equal(
    buildHouseholdCsv([
      entry({
        merchant: '合成,"本店"',
        memo: '1 行目\n"2 行目"',
        payment: 'カード, 青',
      }),
    ]),
    csv(
      '1,2030/11/03,"合成,""本店""",-1280,"カード, 青",食費,,"1 行目\n""2 行目""",0,buddy:e1,,支出,手入力',
    ),
  );
});

test('CSV 注入: 式として解釈される文字で始まる値は先頭に引用符を付けて文字にする', () => {
  for (const [input, expected] of [
    ['=1+1', "'=1+1"],
    ['+81', "'+81"],
    ['-5', "'-5"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1', "'\t=1"],
    ['\rx', "'\rx"],
    [' =1+1', "' =1+1"],
    ['　+1', "'　+1"],
    ['＝1', "'＝1"],
    ['＋1', "'＋1"],
    ['－1', "'－1"],
    ['＠x', "'＠x"],
    [
      '=HYPERLINK("http://example.invalid","x")',
      `'=HYPERLINK("http://example.invalid","x")`,
    ],
    // 守らない値: 途中にあるだけ・普通の文字・空・すでに引用符で始まる値。
    ['a=b', 'a=b'],
    ['合成の店-本店', '合成の店-本店'],
    ["'=1", "'=1"],
    ['', ''],
    ['100%', '100%'],
  ]) {
    assert.equal(householdCsvGuard(input), expected, JSON.stringify(input));
  }
  // 3 つの文字の欄すべてに効き、引用符で囲む値でも守りが先に付く。金額の負の符号は守らない。
  assert.equal(
    buildHouseholdCsv([
      entry({ merchant: '=cmd|"x"', memo: '+1,2', payment: '@a' }),
    ]),
    csv(
      `1,2030/11/03,"'=cmd|""x""",-1280,'@a,食費,,"'+1,2",0,buddy:e1,,支出,手入力`,
    ),
  );
});

test('不正な記録が 1 件でもあれば、欠けたファイルを作らず null を返す', () => {
  for (const bad of [
    { amount_yen: 0 },
    { amount_yen: -5 },
    { amount_yen: 1.5 },
    { amount_yen: 10_000_000_000 },
    { occurred_on: '2030-02-30' },
    { occurred_on: '1999-12-31' },
    { occurred_on: '2030-11-3' },
    { occurred_time: '24:00' },
    { occurred_time: '9:05' },
    { direction: 'refund' },
    { source_kind: 'unknown' },
    { entry_id: '' },
    { entry_id: 'a,b' },
    { entry_id: 'a b' },
  ]) {
    assert.equal(
      buildHouseholdCsv([entry(), entry({ entry_id: 'z', ...bad })]),
      null,
      JSON.stringify(bad),
    );
  }
});

test('取り込みで読み直せる: 同じ見出しの 10 列を読み、向き・金額・日付・分類・店名・ID が戻る', () => {
  const text = buildHouseholdCsv([
    entry({
      entry_id: 'a',
      merchant: '合成,"食堂"',
      memo: 'ランチ',
      payment: '合成のカード',
    }),
    entry({
      entry_id: 'b',
      direction: 'income',
      amount_yen: 250000,
      category: 'income',
      merchant: '合成の勤め先',
      occurred_on: '2030-11-25',
    }),
    entry({
      entry_id: 'c',
      direction: 'transfer',
      amount_yen: 30000,
      category: 'transfer',
      merchant: null,
      occurred_on: '2030-11-27',
    }),
    // 守りの引用符は戻らない（式を文字にした代わりに、読み直すと先頭に残る）。
    entry({ entry_id: 'd', merchant: '=1+1', occurred_on: '2030-11-28' }),
  ]);
  const split = splitHouseholdCsv(text);
  assert.equal(split.length, 5);
  assert.equal(split[1][2], '合成,"食堂"');
  const read = readMoneyforwardExport(text);
  assert.equal(read.ok, true);
  assert.deepEqual(
    read.rows.map((row) => [row.row_id, row.content]),
    [
      [
        'buddy:a',
        {
          direction: 'expense',
          amount_yen: 1280,
          occurred_on: '2030-11-03',
          occurred_time: null,
          category: 'food',
          merchant: '合成,"食堂"',
          memo: 'ランチ',
          payment: '合成のカード',
        },
      ],
      [
        'buddy:b',
        {
          direction: 'income',
          amount_yen: 250000,
          occurred_on: '2030-11-25',
          occurred_time: null,
          category: 'income',
          merchant: '合成の勤め先',
          memo: null,
          payment: null,
        },
      ],
      [
        'buddy:c',
        {
          direction: 'transfer',
          amount_yen: 30000,
          occurred_on: '2030-11-27',
          occurred_time: null,
          category: 'transfer',
          merchant: null,
          memo: null,
          payment: null,
        },
      ],
      [
        'buddy:d',
        {
          direction: 'expense',
          amount_yen: 1280,
          occurred_on: '2030-11-28',
          occurred_time: null,
          category: 'food',
          merchant: "'=1+1",
          memo: null,
          payment: null,
        },
      ],
    ],
  );
  assert.deepEqual(read.skipped, {
    excluded: 0,
    zero_amount: 0,
    unreadable: 0,
  });
});

test('範囲: 古い月から並べ、逆順・形の誤り・2000〜2099 年の外・121 か月は null', () => {
  assert.deepEqual(householdExportMonths('2029-11', '2030-02'), [
    '2029-11',
    '2029-12',
    '2030-01',
    '2030-02',
  ]);
  assert.deepEqual(householdExportMonths('2030-05', '2030-05'), ['2030-05']);
  assert.equal(householdExportMonths('2021-01', '2030-12').length, 120);
  assert.equal(householdExportMonths('2020-12', '2030-12'), null);
  assert.equal(householdExportMonths('2030-06', '2030-05'), null);
  assert.equal(householdExportMonths('1999-12', '2000-01'), null);
  assert.equal(householdExportMonths('2099-12', '2100-01'), null);
  assert.equal(householdExportMonths('2030-1', '2030-05'), null);
  assert.equal(householdExportMonths('2000-01', '2000-01')?.length, 1);
  assert.equal(householdExportMonths('2099-12', '2099-12')?.length, 1);
});

test('ファイル名: 月だけの ASCII。一月なら 1 つの月', () => {
  assert.equal(
    householdExportFileName('2030-11', '2030-11'),
    'buddy-household-2030-11.csv',
  );
  assert.equal(
    householdExportFileName('2029-12', '2030-11'),
    'buddy-household-2029-12_2030-11.csv',
  );
});
