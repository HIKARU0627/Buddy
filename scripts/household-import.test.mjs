import assert from 'node:assert/strict';
import test from 'node:test';
import {
  householdNoticeMatchKey,
  readMoneyforwardExport,
  splitHouseholdCsv,
} from '../packages/domain/dist/index.js';

// 外部の家計簿サービスの書き出しの読み取り（ADR 0164）。書き出しの中身はすべて合成で、実在の書き出しの写しではない。
// 公式の案内で確かめた列の名前（計算対象・日付・内容・金額（円）・保有金融機関・大項目・中項目・メモ・振替・ID）を
// 使い、日付・金額の書き方は確かめられていない（U336）ので両方の書き方を試す。期待値はすべて手で書いた。

const HEADER =
  '"計算対象","日付","内容","金額（円）","保有金融機関","大項目","中項目","メモ","振替","ID"';

const line = (cells) =>
  cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',');

const csv = (...rows) => [HEADER, ...rows.map(line)].join('\r\n') + '\r\n';

test('CSV の欄: 引用符・コンマ・改行・二重の引用符・BOM・末尾の空行を扱い、壊れた引用符は null', () => {
  assert.deepEqual(splitHouseholdCsv('﻿a,"b,c","d\r\ne",""""\r\nx,y\n\n'), [
    ['a', 'b,c', 'd\r\ne', '"'],
    ['x', 'y'],
  ]);
  assert.deepEqual(splitHouseholdCsv('a,,b\n'), [['a', '', 'b']]);
  assert.equal(splitHouseholdCsv('"open'), null);
  assert.equal(splitHouseholdCsv('"a"b'), null);
  assert.equal(splitHouseholdCsv('a"b"'), null);
  assert.deepEqual(splitHouseholdCsv(''), []);
});

test('支出・収入・振替を向きと分類に写し、店名・メモ・支払い手段を入れる', () => {
  const read = readMoneyforwardExport(
    csv(
      [
        '1',
        '2030/10/05',
        '合成の食堂',
        '-1,280',
        '合成のカード',
        '食費',
        '外食',
        '',
        '0',
        'mf-row-1',
      ],
      [
        '1',
        '2030/10/25',
        '合成の給与',
        '250000',
        '合成の銀行',
        '収入',
        '給与',
        '10 月分',
        '0',
        'mf-row-2',
      ],
      [
        '1',
        '2030/10/27',
        '合成のカードの引き落とし',
        '-40000',
        '合成の銀行',
        '未分類',
        '未分類',
        '',
        '1',
        'mf-row-3',
      ],
      [
        '1',
        '2030-10-28',
        '合成の新しい店',
        '-500',
        '合成のカード',
        '未分類',
        '未分類',
        '',
        '0',
        'mf-row-4',
      ],
    ),
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.skipped, {
    excluded: 0,
    zero_amount: 0,
    unreadable: 0,
  });
  assert.deepEqual(read.rows, [
    {
      row_id: 'mf-row-1',
      content: {
        direction: 'expense',
        amount_yen: 1280,
        occurred_on: '2030-10-05',
        occurred_time: null,
        category: 'food',
        merchant: '合成の食堂',
        memo: null,
        payment: '合成のカード',
      },
      categorized: true,
    },
    {
      row_id: 'mf-row-2',
      content: {
        direction: 'income',
        amount_yen: 250000,
        occurred_on: '2030-10-25',
        occurred_time: null,
        category: 'income',
        merchant: '合成の給与',
        memo: '10 月分',
        payment: '合成の銀行',
      },
      categorized: false,
    },
    {
      row_id: 'mf-row-3',
      content: {
        direction: 'transfer',
        amount_yen: 40000,
        occurred_on: '2030-10-27',
        occurred_time: null,
        category: 'transfer',
        merchant: '合成のカードの引き落とし',
        memo: null,
        payment: '合成の銀行',
      },
      categorized: false,
    },
    {
      row_id: 'mf-row-4',
      content: {
        direction: 'expense',
        amount_yen: 500,
        occurred_on: '2030-10-28',
        occurred_time: null,
        category: 'uncategorized',
        merchant: '合成の新しい店',
        memo: null,
        payment: '合成のカード',
      },
      categorized: false,
    },
  ]);
});

test('集計から外した行・金額 0・読めない行は数えて飛ばし、口座番号らしい店名は空にして行は取り込む', () => {
  const read = readMoneyforwardExport(
    csv(
      [
        '0',
        '2030/10/05',
        '合成の食堂',
        '-1280',
        '合成のカード',
        '食費',
        '外食',
        '',
        '0',
        'mf-1',
      ],
      [
        '1',
        '2030/10/05',
        '合成の食堂',
        '0',
        '合成のカード',
        '食費',
        '外食',
        '',
        '0',
        'mf-2',
      ],
      [
        '1',
        '2030/02/30',
        '合成の食堂',
        '-100',
        '合成のカード',
        '食費',
        '外食',
        '',
        '0',
        'mf-3',
      ],
      [
        '1',
        '2030/10/05',
        '合成の食堂',
        '-1.5',
        '合成のカード',
        '食費',
        '外食',
        '',
        '0',
        'mf-4',
      ],
      [
        '1',
        '2030/10/05',
        '合成の食堂',
        '-100',
        '合成のカード',
        '食費',
        '外食',
        '',
        '0',
        '',
      ],
      [
        '1',
        '1999/12/31',
        '合成の食堂',
        '-100',
        '合成のカード',
        '食費',
        '外食',
        '',
        '0',
        'mf-6',
      ],
      [
        '1',
        '2030/10/06',
        '振込 1234 5678 9012 3456',
        '-300',
        '合成の銀行',
        '知らない分類',
        '',
        '',
        '0',
        'mf-7',
      ],
    ),
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.skipped, {
    excluded: 1,
    zero_amount: 1,
    unreadable: 4,
  });
  assert.equal(read.rows.length, 1);
  assert.deepEqual(read.rows[0]?.content, {
    direction: 'expense',
    amount_yen: 300,
    occurred_on: '2030-10-06',
    occurred_time: null,
    category: 'uncategorized',
    merchant: null,
    memo: null,
    payment: '合成の銀行',
  });
});

test('見出しは名前で探し（並びと半角の括弧を問わない）、足りない・壊れている・同じ ID が二つある書き出しは読まない', () => {
  const reordered = [
    'ID,振替,メモ,中項目,大項目,保有金融機関,金額(円),内容,日付,計算対象',
    'mf-1,0,,,食費,合成のカード,-980,合成のパン屋,2030/11/01,1',
  ].join('\n');
  const read = readMoneyforwardExport(reordered);
  assert.equal(read.ok, true);
  assert.equal(read.rows[0]?.content.category, 'food');
  assert.equal(read.rows[0]?.content.amount_yen, 980);
  assert.deepEqual(readMoneyforwardExport('日付,内容,金額\n2030/11/01,a,-1'), {
    ok: false,
    reason: 'header_missing',
  });
  assert.deepEqual(readMoneyforwardExport(`${HEADER}\n"1,"broken`), {
    ok: false,
    reason: 'csv_invalid',
  });
  assert.deepEqual(
    readMoneyforwardExport(
      csv(
        ['1', '2030/10/05', 'a', '-1', 'x', '食費', '', '', '0', 'same'],
        ['1', '2030/10/06', 'b', '-2', 'x', '食費', '', '', '0', 'same'],
      ),
    ),
    { ok: false, reason: 'duplicate_row_id' },
  );
  // 見出しだけなら 0 行。
  assert.deepEqual(readMoneyforwardExport(`${HEADER}\r\n`), {
    ok: true,
    rows: [],
    skipped: { excluded: 0, zero_amount: 0, unreadable: 0 },
  });
});

test('利用通知と同じ利用かを見る鍵は支出の日付と金額だけ', () => {
  assert.equal(
    householdNoticeMatchKey({
      direction: 'expense',
      occurred_on: '2030-10-05',
      amount_yen: 1280,
    }),
    '2030-10-05|1280',
  );
  assert.equal(
    householdNoticeMatchKey({
      direction: 'income',
      occurred_on: '2030-10-05',
      amount_yen: 1280,
    }),
    null,
  );
});
