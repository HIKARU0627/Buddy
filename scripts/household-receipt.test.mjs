import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readHouseholdReceiptReply,
  receiptImageInfo,
  receiptSendImageErrors,
  receiptSourceImageErrors,
} from '../packages/domain/dist/index.js';

// レシートの写真からの家計の記録の候補（ADR 0177）。画像は合成のバイト列（形式の頭と大きさだけを持つ）で、本物の写真は
// 使わない。期待値はすべて手で書いた。

const be16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

// 合成の JPEG の頭: SOI、APP0（16 バイト）、SOF0（縦・横）、SOS、EOI。size を指定すれば 0 で埋めてその長さにする。
function jpeg(width, height, { size = 0, fill = false, marker = 0xc0 } = {}) {
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(16),
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    ...(fill ? [0xff, 0xff] : [0xff]),
    marker,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
    ...be16(8),
    1,
    1,
    0,
    0,
    0x3f,
    0,
    0xff,
    0xd9,
  ];
  const out = new Uint8Array(Math.max(size, bytes.length));
  out.set(bytes);
  return out;
}

// 合成の PNG の頭: 署名と IHDR。
function png(width, height) {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(width),
    ...be32(height),
    8,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

test('画像の形式と縦横の大きさを頭から読む', () => {
  assert.deepEqual(receiptImageInfo(jpeg(1280, 960)), {
    format: 'jpeg',
    width: 1280,
    height: 960,
  });
  // 区切りの前の埋めの 0xFF と、SOF2（プログレッシブ）も読む。
  assert.deepEqual(receiptImageInfo(jpeg(800, 1200, { fill: true })), {
    format: 'jpeg',
    width: 800,
    height: 1200,
  });
  assert.deepEqual(receiptImageInfo(jpeg(640, 480, { marker: 0xc2 })), {
    format: 'jpeg',
    width: 640,
    height: 480,
  });
  assert.deepEqual(receiptImageInfo(png(3000, 4000)), {
    format: 'png',
    width: 3000,
    height: 4000,
  });
  // GIF・空・途中で切れた JPEG（SOF の前で終わる）・SOF のない JPEG は読めない。
  assert.equal(receiptImageInfo(new TextEncoder().encode('GIF89a....')), null);
  assert.equal(receiptImageInfo(new Uint8Array()), null);
  assert.equal(receiptImageInfo(jpeg(640, 480).subarray(0, 24)), null);
  assert.equal(
    receiptImageInfo(
      new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 8, 0xff, 0xd9]),
    ),
    null,
  );
  // DHT（0xC4）は大きさを持つ区切りではない。
  assert.equal(receiptImageInfo(jpeg(640, 480, { marker: 0xc4 })), null);
});

test('本人が選んだファイルの検査（開く前）', () => {
  assert.deepEqual(receiptSourceImageErrors(jpeg(4032, 3024)), []);
  assert.deepEqual(receiptSourceImageErrors(png(1170, 2532)), []);
  // 形式: GIF・HEIC の頭・文字は受けない。
  assert.deepEqual(
    receiptSourceImageErrors(new TextEncoder().encode('GIF89a0000000000000')),
    ['image_format_unsupported'],
  );
  assert.deepEqual(
    receiptSourceImageErrors(
      new Uint8Array([
        0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      ]),
    ),
    ['image_format_unsupported'],
  );
  // 壊れた JPEG・幅 0。
  assert.deepEqual(receiptSourceImageErrors(jpeg(640, 480).subarray(0, 24)), [
    'image_unreadable',
  ]);
  assert.deepEqual(receiptSourceImageErrors(png(0, 480)), ['image_unreadable']);
  // バイト数の上限 20 MiB（20,971,520 バイト）はちょうどなら受け、1 バイト超えたら受けない。
  assert.deepEqual(
    receiptSourceImageErrors(jpeg(4000, 3000, { size: 20_971_520 })),
    [],
  );
  assert.deepEqual(
    receiptSourceImageErrors(jpeg(4000, 3000, { size: 20_971_521 })),
    ['image_too_large'],
  );
  // 1 辺の上限 12,000 と画素の数の上限 50,000,000。
  assert.deepEqual(receiptSourceImageErrors(png(12_000, 4_000)), []);
  assert.deepEqual(receiptSourceImageErrors(png(12_001, 4_000)), [
    'image_dimensions_too_large',
  ]);
  assert.deepEqual(receiptSourceImageErrors(png(10_000, 5_000)), []);
  assert.deepEqual(receiptSourceImageErrors(png(10_000, 5_001)), [
    'image_dimensions_too_large',
  ]);
  // 短い辺の下限 64。
  assert.deepEqual(receiptSourceImageErrors(png(64, 2000)), []);
  assert.deepEqual(receiptSourceImageErrors(png(63, 2000)), [
    'image_too_small',
  ]);
});

test('外部へ送る画像の検査（JPEG だけ・180 KiB・長い辺 1600）', () => {
  assert.deepEqual(receiptSendImageErrors(jpeg(960, 1280)), []);
  // PNG は縮めた後の形式ではないので送らない。
  assert.deepEqual(receiptSendImageErrors(png(960, 1280)), [
    'image_format_unsupported',
  ]);
  // 180 KiB（184,320 バイト）はちょうどなら送り、1 バイト超えたら送らない。
  assert.deepEqual(
    receiptSendImageErrors(jpeg(960, 1280, { size: 184_320 })),
    [],
  );
  assert.deepEqual(receiptSendImageErrors(jpeg(960, 1280, { size: 184_321 })), [
    'image_too_large',
  ]);
  assert.deepEqual(receiptSendImageErrors(jpeg(1200, 1600)), []);
  assert.deepEqual(receiptSendImageErrors(jpeg(1200, 1601)), [
    'image_dimensions_too_large',
  ]);
  assert.deepEqual(receiptSendImageErrors(jpeg(63, 1600)), ['image_too_small']);
});

const TODAY = '2030-11-26';
const reply = (over = {}) => ({
  readable: true,
  receipt_count: 1,
  currency: 'JPY',
  total: 1280,
  date: '2030-11-25',
  time: '12:34',
  merchant: 'テスト商店',
  payment: '現金',
  items: [
    { name: 'おにぎり', amount: 300 },
    { name: 'お茶', amount: 980 },
  ],
  ...over,
});
const candidate = (over = {}) => ({
  kind: 'candidate',
  draft: {
    amount_yen: 1280,
    occurred_on: '2030-11-25',
    occurred_time: '12:34',
    merchant: 'テスト商店',
    payment: '現金',
    ...over,
  },
});
const not = (...reasons) => ({ kind: 'not_candidate', reasons });

test('応答から候補を作る（合計・日付・時刻・店名・支払い手段）', () => {
  assert.deepEqual(readHouseholdReceiptReply(reply(), TODAY), candidate());
  // 品目がなければ合計だけで候補にする。値引きの負の品目は和に入れる。
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ items: [] }), TODAY),
    candidate(),
  );
  assert.deepEqual(
    readHouseholdReceiptReply(
      reply({
        items: [
          { name: '弁当', amount: 1380 },
          { name: '値引', amount: -100 },
        ],
      }),
      TODAY,
    ),
    candidate(),
  );
  // 店名の前後の空白は除く。品目名は候補に入れない。
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ merchant: '  テスト商店 ' }), TODAY),
    candidate(),
  );
  // 今日の日付は受け、明日・読めない日付・2000 年より前は空にする（本人が入れる）。
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ date: TODAY }), TODAY),
    candidate({ occurred_on: TODAY }),
  );
  for (const date of [
    '2030-11-27',
    '2030-02-30',
    '令和12年11月25日',
    '1999-12-31',
    null,
  ])
    assert.deepEqual(
      readHouseholdReceiptReply(reply({ date }), TODAY),
      candidate({ occurred_on: null }),
      String(date),
    );
  // 読めない時刻は空にする。
  for (const time of ['24:00', '9:05', '12:34:56', null])
    assert.deepEqual(
      readHouseholdReceiptReply(reply({ time }), TODAY),
      candidate({ occurred_time: null }),
      String(time),
    );
  // 記録に入れられない店名（制御文字・101 文字）は空にする。空白だけも空。
  for (const merchant of ['テスト\n商店', 'あ'.repeat(101), '   ', null])
    assert.deepEqual(
      readHouseholdReceiptReply(reply({ merchant }), TODAY),
      candidate({ merchant: null }),
      JSON.stringify(merchant),
    );
  // 記録に入れられない支払い手段（41 文字）は空にする。
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ payment: 'カ'.repeat(41) }), TODAY),
    candidate({ payment: null }),
  );
  // 金額の上限 9,999,999,999 円はちょうどなら受ける。
  assert.deepEqual(
    readHouseholdReceiptReply(
      reply({ total: 9_999_999_999, items: [] }),
      TODAY,
    ),
    candidate({ amount_yen: 9_999_999_999 }),
  );
});

test('読めない・矛盾する応答は候補にしない', () => {
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ readable: false }), TODAY),
    not('unreadable'),
  );
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ receipt_count: 0 }), TODAY),
    not('unreadable'),
  );
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ receipt_count: 2 }), TODAY),
    not('several_receipts'),
  );
  // 外貨・通貨が分からない。
  for (const currency of ['USD', 'jpy', '円', null])
    assert.deepEqual(
      readHouseholdReceiptReply(reply({ currency }), TODAY),
      not('currency_not_yen'),
      String(currency),
    );
  // 合計がない・0・負・上限を超える。
  for (const total of [null, 0, -500, 10_000_000_000])
    assert.deepEqual(
      readHouseholdReceiptReply(reply({ total, items: [] }), TODAY),
      not('total_unreadable'),
      String(total),
    );
  // 合計と品目の和の食い違い（1 円でも）。
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ total: 1281 }), TODAY),
    not('items_total_mismatch'),
  );
  // カード番号らしい数字の並び（店名・支払い手段・品目名。区切りのハイフンと全角の数字も数える）。
  for (const over of [
    { merchant: 'テスト商店 4111111111111111' },
    { payment: 'カード 4111-1111-1111-1111' },
    { payment: 'カード ４１１１１１１１１１１１' },
    {
      items: [
        { name: 'おにぎり 123456789012', amount: 300 },
        { name: 'お茶', amount: 980 },
      ],
    },
  ])
    assert.deepEqual(
      readHouseholdReceiptReply(reply(over), TODAY),
      not('long_digits'),
      JSON.stringify(over),
    );
  // 11 桁までの並び（電話番号の写しなど）は拒まない。
  assert.deepEqual(
    readHouseholdReceiptReply(
      reply({ merchant: 'テスト商店 03123456789' }),
      TODAY,
    ),
    candidate({ merchant: 'テスト商店 03123456789' }),
  );
});

test('決まった形でない応答は候補にしない', () => {
  const invalid = not('reply_invalid');
  for (const value of [null, 'text', [], 1280, {}])
    assert.deepEqual(readHouseholdReceiptReply(value, TODAY), invalid);
  // 足りないキー・余計なキー。
  const missing = reply();
  delete missing.time;
  assert.deepEqual(readHouseholdReceiptReply(missing, TODAY), invalid);
  assert.deepEqual(
    readHouseholdReceiptReply({ ...reply(), card_number: null }, TODAY),
    invalid,
  );
  // 型の違い（金額が文字・小数、読めたかが文字、件数が負、品目が配列でない）。
  for (const over of [
    { total: '1280' },
    { total: 1280.5, items: [] },
    { readable: 'true' },
    { receipt_count: -1 },
    { items: null },
    { items: [{ name: 'おにぎり', amount: '300' }] },
    { items: [{ name: 'おにぎり', amount: 300, tax: 24 }] },
    { items: [{ name: 'おにぎり', amount: 10_000_000_000 }] },
    { merchant: 'あ'.repeat(201) },
  ])
    assert.deepEqual(
      readHouseholdReceiptReply(reply(over), TODAY),
      invalid,
      JSON.stringify(over).slice(0, 80),
    );
  // 品目の数の上限 100 はちょうどなら受け、101 は受けない。
  const items = (count) =>
    Array.from({ length: count }, () => ({ name: null, amount: 10 }));
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ total: 1000, items: items(100) }), TODAY),
    candidate({ amount_yen: 1000 }),
  );
  assert.deepEqual(
    readHouseholdReceiptReply(reply({ total: 1010, items: items(101) }), TODAY),
    invalid,
  );
});
