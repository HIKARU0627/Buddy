import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOUSEHOLD_BILL_DUE_WINDOW,
  householdBillContentErrors,
  householdBillSourceKeyMaterial,
  householdBillSubject,
  householdSameBill,
  householdSourceKeyMaterial,
  readHouseholdBill,
  readHouseholdNotice,
  summarizeHouseholdBills,
} from '../packages/domain/dist/index.js';

// 請求のお知らせから読む請求予定（ADR 0176）。
// 件名・本文はすべて合成で、実在の会社のメールの文面は写していない（実在のメールでの確かめは未実施。U356）。
// 期待値はすべて手で書いた。

const CARD_A = {
  id: 'card_a',
  label: '合成カードA',
  domains: ['example.invalid'],
  provisional_subject: /速報/u,
};

const read = (subject, text, receivedOn = '2030-11-25') =>
  readHouseholdBill({
    issuer: CARD_A,
    subject,
    text,
    received_on: receivedOn,
  });

const bill = (amount, due) => ({
  outcome: 'bill',
  content: { issuer: '合成カードA', amount_yen: amount, due_on: due },
});

test('件名: 請求・支払い・引き落としの金額や予定を知らせる件名だけを請求のお知らせとして読む', () => {
  for (const subject of [
    '【合成カードA】ご請求金額確定のお知らせ',
    'お支払い金額のご案内',
    '今月のお引き落とし額のお知らせ',
    '口座振替日のお知らせ',
    'カードご利用代金のお知らせ',
    'ご利用明細が確定しました',
    'ご請求予定額のお知らせ',
  ])
    assert.equal(householdBillSubject(subject), true, subject);
  for (const subject of [
    // 件名だけ似た宣伝・手続き・引き落としの失敗・督促・変更。
    '【キャンペーン】ご請求額から500円割引のチャンス',
    'ポイントをお支払いに充てられます',
    'お引き落としができませんでした',
    'お支払い日変更のお知らせ',
    '口座振替の残高不足について',
    'お支払いのお願い（督促）',
    'ご利用代金の再引落しのお知らせ',
    // 訂正・修正・お詫び・再送・取消のお知らせと速報は読まない（訂正前と訂正後の両方ができないように）。
    'ご請求金額訂正のお知らせ',
    'ご請求金額の修正について',
    '【お詫び】ご請求金額について',
    'ご請求金額のお知らせ（再送）',
    'ご請求金額取消のお知らせ',
    'ご請求金額の取り消しについて',
    '【速報】ご請求額のお知らせ',
    // 請求の語がない件名。
    'カードご利用のお知らせ',
    'ログインのお知らせ',
    '',
  ])
    assert.equal(householdBillSubject(subject), false, subject);
});

test('請求のお知らせは利用通知として読まない（支払い済みの記録にしない）', () => {
  const reading = readHouseholdNotice({
    issuer: CARD_A,
    subject: 'ご請求金額確定のお知らせ',
    text: 'ご利用金額：12,345円\nご利用日：2030/11/20',
    received_on: '2030-11-25',
  });
  assert.deepEqual(reading, { outcome: 'ignored', reason: 'not_usage_notice' });
});

test('本文: 同じ行の書式と次の行の書式から、請求の金額と引き落とし日を読む', () => {
  assert.deepEqual(
    read(
      'ご請求金額確定のお知らせ',
      [
        '合成カードAをご利用いただきありがとうございます。',
        '■ご請求金額：12,345円',
        '■お支払日：2030年12月10日（火）',
      ].join('\n'),
    ),
    bill(12345, '2030-12-10'),
  );
  assert.deepEqual(
    read(
      'お支払い金額のお知らせ',
      [
        '【今回のお支払い金額】',
        '',
        '¥8,800',
        '【お引き落とし日】',
        '1月6日',
      ].join('\r\n'),
      '2030-12-20',
    ),
    bill(8800, '2031-01-06'),
  );
  // 全角の数字・コロン、括弧の補足のある項目名、口座振替日。
  assert.deepEqual(
    read(
      '口座振替日のお知らせ',
      'ご請求金額（１２月分）：５，０００円\n口座振替日（予定）：２０３０／１２／２７',
    ),
    bill(5000, '2030-12-27'),
  );
  // 前回の金額は読まない。同じ金額が二度書かれていれば一つの請求。
  assert.deepEqual(
    read(
      'ご請求額のお知らせ',
      [
        '前回お支払い金額 9,999円',
        'ご請求額 3,210円',
        'お引落し金額 3,210円',
        'お引落し日 12/10',
      ].join('\n'),
    ),
    bill(3210, '2030-12-10'),
  );
});

test('値は元の行から読む: 次の行がマイナスの金額なら取消として読み、請求予定にしない。項目名の後の括弧に前回・前月・先月があれば読まない', () => {
  const reason = (text) => {
    const reading = read('ご請求金額のお知らせ', text);
    return reading.outcome === 'bill' ? reading : reading.reason;
  };
  // 同じ行の「：-1,000円」は取消。次の行の値も、飾りの記号に見えるマイナスを落とさず取消として読む。
  for (const minus of ['-', '－', '−'])
    assert.equal(
      reason(`ご請求金額\n${minus}1,000円\nお支払日\n12/10`),
      'cancellation',
      minus,
    );
  // ハイフン・ダッシュ類は負の数として読めないが、飾りとして落とさないので、金額が読めず請求予定にならない。
  for (const dash of ['‐', '–', '—'])
    assert.equal(
      reason(`ご請求金額\n${dash}1,000円\nお支払日\n12/10`),
      'amount_unreadable',
      dash,
    );
  assert.equal(reason('ご請求金額：-1,000円\nお支払日：12/10'), 'cancellation');
  // 次の行の値の前の飾りの記号は、金額として読めないので請求予定にしない（飾りを黙って落とさない）。
  assert.equal(
    reason('ご請求金額\n■1,000円\nお支払日\n12/10'),
    'amount_unreadable',
  );
  // 前回・前月・先月の括弧の補足がある項目は読まない。
  for (const note of ['前回', '前月', '先月', '前回分'])
    assert.deepEqual(
      read(
        'ご請求金額のお知らせ',
        `ご請求金額(${note}) 9,999円\nお支払日 12/10`,
      ),
      { outcome: 'ignored', reason: 'no_amount' },
      note,
    );
  assert.deepEqual(
    read('ご請求金額のお知らせ', 'ご請求金額（前回）\n9,999円\nお支払日 12/10'),
    { outcome: 'ignored', reason: 'no_amount' },
  );
  // 今回の補足の括弧はこれまでどおり読む。
  assert.deepEqual(
    read('ご請求金額のお知らせ', 'ご請求金額(予定) 7,000円\nお支払日 12/10'),
    bill(7000, '2030-12-10'),
  );
});

test('引き落とし日の年: 年のない日付は、受信日の 31 日前から 92 日先までに入る年にする', () => {
  assert.deepEqual(HOUSEHOLD_BILL_DUE_WINDOW, { ahead: 92, behind: 31 });
  const due = (value, receivedOn) => {
    const reading = read(
      'ご請求金額のお知らせ',
      `ご請求金額 1,000円\nお支払日 ${value}`,
      receivedOn,
    );
    return reading.outcome === 'bill' ? reading.content.due_on : reading.reason;
  };
  // 受信日 2030-11-25 から 92 日先は 2031-02-25、31 日前は 2030-10-25。
  assert.equal(due('12/10', '2030-11-25'), '2030-12-10');
  assert.equal(due('2月25日', '2030-11-25'), '2031-02-25');
  assert.equal(due('2月26日', '2030-11-25'), 'due_on_unreadable');
  assert.equal(due('10/25', '2030-11-25'), '2030-10-25');
  assert.equal(due('10/24', '2030-11-25'), 'due_on_unreadable');
  // 年をまたぐ: 年末に届いた 1 月の引き落とし、年明けに届いた前の年の 12 月の引き落とし。
  assert.equal(due('1/5', '2030-12-28'), '2031-01-05');
  assert.equal(due('12月27日', '2031-01-03'), '2030-12-27');
  // 年のある日付はそのまま。暦にない日付・読めない日付は読まない。
  assert.equal(due('2031年3月27日', '2030-11-25'), '2031-03-27');
  assert.equal(due('2/30', '2030-11-25'), 'due_on_unreadable');
  assert.equal(due('毎月27日', '2030-11-25'), 'due_on_unreadable');
});

test('金額: 0 円・外貨・取消・読めない金額・食い違う金額は請求予定にしない', () => {
  const reason = (amountLines) => {
    const reading = read(
      'ご請求金額のお知らせ',
      [...amountLines, 'お支払日 12/10'].join('\n'),
    );
    return reading.outcome === 'bill' ? reading : reading.reason;
  };
  assert.equal(reason(['ご請求金額 0円']), 'zero_amount');
  assert.equal(reason(['ご請求金額 ¥0']), 'zero_amount');
  assert.equal(reason(['ご請求金額 USD 120.00']), 'foreign_currency');
  assert.equal(reason(['ご請求金額 -1,000円']), 'cancellation');
  assert.equal(
    reason(['ご請求金額 会員サイトでご確認ください']),
    'amount_unreadable',
  );
  assert.equal(
    reason(['ご請求金額 12,345円', 'お支払い金額 12,000円']),
    'amount_mismatch',
  );
  assert.equal(
    reason(['ご請求金額 0円', 'お支払い金額 500円']),
    'amount_mismatch',
  );
});

test('引き落とし日がない・二つが食い違う・金額の項目がない・件名が違うときは読まない', () => {
  assert.deepEqual(read('ご請求金額のお知らせ', 'ご請求金額 1,000円'), {
    outcome: 'skipped',
    reason: 'due_on_missing',
  });
  assert.deepEqual(
    read(
      'ご請求金額のお知らせ',
      'ご請求金額 1,000円\nお支払日 12/10\nお引き落とし日 12/27',
    ),
    { outcome: 'skipped', reason: 'due_on_mismatch' },
  );
  assert.deepEqual(
    read(
      'ご請求金額確定のお知らせ',
      '今月のご請求金額が確定しました。\n会員サイトでご確認ください。',
    ),
    { outcome: 'ignored', reason: 'no_amount' },
  );
  assert.deepEqual(
    read(
      '【キャンペーン】ご請求額から500円割引のチャンス',
      'ご請求金額 500円\nお支払日 12/10',
    ),
    { outcome: 'ignored', reason: 'not_bill_notice' },
  );
});

test('出所の鍵の材料は、家計の記録の出所と別の名前空間で、形が違えば null', () => {
  const parts = {
    provider: 'google',
    account_id: 'acct-1',
    remote_id: 'msg-1',
  };
  assert.equal(
    householdBillSourceKeyMaterial(parts),
    '["buddy.household_bill_source.v1","mail_bill","google","acct-1","msg-1"]',
  );
  assert.notEqual(
    householdBillSourceKeyMaterial(parts),
    householdSourceKeyMaterial({ kind: 'mail_notice', ...parts, index: 0 }),
  );
  assert.equal(
    householdBillSourceKeyMaterial({ ...parts, provider: 'other' }),
    null,
  );
  assert.equal(
    householdBillSourceKeyMaterial({ ...parts, remote_id: '' }),
    null,
  );
  assert.equal(
    householdBillSourceKeyMaterial({ ...parts, account_id: 'a b' }),
    null,
  );
});

test('中身の検査と、同じ請求の判定', () => {
  const content = {
    issuer: '合成カードA',
    amount_yen: 1,
    due_on: '2030-12-10',
  };
  assert.deepEqual(householdBillContentErrors(content), []);
  assert.deepEqual(householdBillContentErrors({ ...content, extra: 1 }), [
    'bill_keys_invalid',
  ]);
  assert.deepEqual(
    householdBillContentErrors({
      issuer: ' ',
      amount_yen: 0,
      due_on: '2030-02-30',
    }),
    ['issuer_invalid', 'amount_invalid', 'due_on_invalid'],
  );
  assert.deepEqual(
    householdBillContentErrors({ ...content, issuer: 'あ'.repeat(41) }),
    ['issuer_invalid'],
  );
  assert.deepEqual(
    householdBillContentErrors({ ...content, amount_yen: 10_000_000_000 }),
    ['amount_invalid'],
  );
  assert.equal(householdSameBill(content, { ...content }), true);
  assert.equal(
    householdSameBill(content, { ...content, amount_yen: 2 }),
    false,
  );
  assert.equal(
    householdSameBill(content, { ...content, due_on: '2030-12-11' }),
    false,
  );
  assert.equal(
    householdSameBill(content, { ...content, issuer: '合成カードB' }),
    false,
  );
});

test('月の請求予定は引き落とし日の順に並べて合計し、月の外の請求予定は入れない', () => {
  const bills = [
    { issuer: '合成カードB', amount_yen: 3000, due_on: '2030-12-27' },
    { issuer: '合成カードA', amount_yen: 12345, due_on: '2030-12-10' },
    { issuer: '合成カードA', amount_yen: 500, due_on: '2030-12-27' },
    { issuer: '合成カードA', amount_yen: 7000, due_on: '2031-01-10' },
  ];
  assert.deepEqual(summarizeHouseholdBills(bills, '2030-12'), {
    items: [
      { issuer: '合成カードA', amount_yen: 12345, due_on: '2030-12-10' },
      { issuer: '合成カードA', amount_yen: 500, due_on: '2030-12-27' },
      { issuer: '合成カードB', amount_yen: 3000, due_on: '2030-12-27' },
    ],
    total_yen: 15845,
  });
  assert.deepEqual(summarizeHouseholdBills([], '2030-12'), {
    items: [],
    total_yen: 0,
  });
});
