import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOUSEHOLD_NOTICE_ISSUERS,
  checkHouseholdNoticeSender,
  householdNoticeSenderDomain,
  householdNoticeSubjectKind,
  parseHouseholdNoticeAmount,
  parseHouseholdNoticeDate,
  readHouseholdNotice,
} from '../packages/domain/dist/index.js';

// 利用通知メールの送り主の確かめと本文の読み取り（ADR 0159）。
// メールの本文はすべて合成で、各社の項目名の表記の揺れ（公式の案内に載った項目名）だけを再現した。
// 実在のメールの写しは使っていない。期待値はすべて手で書いた。

const issuer = (id) => {
  const found = HOUSEHOLD_NOTICE_ISSUERS.find((entry) => entry.id === id);
  assert.ok(found);
  return found;
};

const GMAIL = 'mx.google.com;';

// 送り主の確かめの試験は、合成の送信元の一覧（例示用のドメイン）で行う。組み込みの一覧はドメインの形だけを確かめる。
const CARD_A = {
  id: 'card_a',
  label: '合成カードA',
  domains: ['example.invalid'],
  provisional_subject: /速報/u,
};
const CARD_B = {
  id: 'card_b',
  label: '合成カードB',
  domains: ['example.org', 'example.net'],
  provisional_subject: null,
};
const ISSUERS = [CARD_A, CARD_B];

test('組み込みの送信元の一覧は、小文字のドメインだけで、会社の id が重ならない', () => {
  const ids = HOUSEHOLD_NOTICE_ISSUERS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of HOUSEHOLD_NOTICE_ISSUERS)
    for (const domain of entry.domains)
      assert.match(domain, /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/u, domain);
  assert.deepEqual(issuer('view_card').domains, ['mail.viewsnet.jp']);
});

test('差出人のドメインを取り出す。読めない差出人は null', () => {
  assert.equal(
    householdNoticeSenderDomain('通知 <info@Example.Invalid>'),
    'example.invalid',
  );
  assert.equal(householdNoticeSenderDomain('info@example.org'), 'example.org');
  assert.equal(householdNoticeSenderDomain('名前だけ'), null);
  assert.equal(householdNoticeSenderDomain('a@b@example.invalid'), null);
});

test('送り主: 一覧のドメインで、DMARC か同じ会社の DKIM が合格したときだけ通知として扱う', () => {
  const dmarcPass = `${GMAIL} dkim=pass header.d=mail.example.invalid header.s=s1; spf=pass (comment) smtp.mailfrom=bounce@example.invalid; dmarc=pass (p=REJECT) header.from=example.invalid`;
  const ok = checkHouseholdNoticeSender(
    {
      from: 'カード <info@example.invalid>',
      authentication_results: [dmarcPass],
    },
    ISSUERS,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.issuer.id, 'card_a');
  // DMARC がなくても、同じ会社の別のドメイン（一覧のドメインの下を含む）の DKIM が合格していればよい。
  assert.equal(
    checkHouseholdNoticeSender(
      {
        from: 'info@example.org',
        authentication_results: [
          `${GMAIL} dkim=pass header.d=mail.example.net; spf=neutral`,
        ],
      },
      ISSUERS,
    ).ok,
    true,
  );
  // 別の会社のドメインの DKIM・合格していない DMARC・別のドメインの DMARC は信じない。
  assert.deepEqual(
    checkHouseholdNoticeSender(
      {
        from: 'info@example.org',
        authentication_results: [
          `${GMAIL} dkim=pass header.d=example.invalid; dmarc=fail header.from=example.org`,
        ],
      },
      ISSUERS,
    ),
    { ok: false, reason: 'authentication_failed' },
  );
  assert.deepEqual(
    checkHouseholdNoticeSender(
      {
        from: 'info@example.invalid',
        authentication_results: [
          `${GMAIL} dmarc=pass header.from=attacker.invalid`,
        ],
      },
      ISSUERS,
    ),
    { ok: false, reason: 'authentication_failed' },
  );
  assert.deepEqual(
    checkHouseholdNoticeSender(
      { from: 'info@example.invalid', authentication_results: [] },
      ISSUERS,
    ),
    { ok: false, reason: 'authentication_missing' },
  );
  // 一覧にないドメインは知らない送り主。
  for (const from of ['info@example.com', 'info@example.com.invalid'])
    assert.deepEqual(
      checkHouseholdNoticeSender(
        {
          from,
          authentication_results: [`${GMAIL} dmarc=pass header.from=x`],
        },
        ISSUERS,
      ),
      { ok: false, reason: 'sender_unknown' },
    );
  // 一覧を渡さなければ組み込みの一覧で確かめる（合成のドメインは知らない送り主）。
  assert.deepEqual(
    checkHouseholdNoticeSender({
      from: 'info@example.invalid',
      authentication_results: [dmarcPass],
    }),
    { ok: false, reason: 'sender_unknown' },
  );
});

test('件名: 利用のお知らせだけを読み、速報を送る会社の速報と、請求・キャンペーンなどは読まない', () => {
  const view = issuer('view_card');
  const smbc = issuer('smbc_card');
  assert.equal(householdNoticeSubjectKind(smbc, 'ご利用のお知らせ'), 'usage');
  assert.equal(
    householdNoticeSubjectKind(view, '【確報】カードご利用のお知らせ'),
    'usage',
  );
  assert.equal(
    householdNoticeSubjectKind(view, '【速報】カードご利用のお知らせ'),
    'provisional',
  );
  // 速報を送らない会社は「速報」の語があっても読む（その会社の唯一の通知）。
  assert.equal(householdNoticeSubjectKind(smbc, 'ご利用速報'), 'usage');
  for (const subject of [
    'ご請求金額確定のお知らせ',
    'ご利用明細のお知らせ',
    'ポイントご利用のお知らせ',
    '【重要】本人確認のお知らせ',
    '不正利用の疑いのお知らせ',
    '新しいキャンペーンのご案内',
  ])
    assert.equal(householdNoticeSubjectKind(smbc, subject), 'other', subject);
});

test('金額: 円の印のある金額だけを読み、外貨・取消・読めない金額は理由を返す', () => {
  assert.deepEqual(parseHouseholdNoticeAmount('1,280円'), {
    ok: true,
    yen: 1280,
  });
  assert.deepEqual(parseHouseholdNoticeAmount('１，２８０円'), {
    ok: true,
    yen: 1280,
  });
  assert.deepEqual(parseHouseholdNoticeAmount('￥12,345'), {
    ok: true,
    yen: 12345,
  });
  assert.deepEqual(parseHouseholdNoticeAmount('JPY 500'), {
    ok: true,
    yen: 500,
  });
  assert.deepEqual(parseHouseholdNoticeAmount('3500 円（国内）'), {
    ok: true,
    yen: 3500,
  });
  assert.deepEqual(parseHouseholdNoticeAmount('USD 12.34'), {
    ok: false,
    reason: 'foreign_currency',
  });
  assert.deepEqual(parseHouseholdNoticeAmount('-1,280円'), {
    ok: false,
    reason: 'cancellation',
  });
  assert.deepEqual(parseHouseholdNoticeAmount('1,280円（取消）'), {
    ok: false,
    reason: 'cancellation',
  });
  assert.deepEqual(parseHouseholdNoticeAmount('ご確認ください'), {
    ok: false,
    reason: 'amount_unreadable',
  });
  assert.deepEqual(parseHouseholdNoticeAmount('0円'), {
    ok: false,
    reason: 'amount_unreadable',
  });
});

test('日付: 各書式を YYYY-MM-DD と HH:MM にし、年のない書式は受信日から年を決める', () => {
  assert.deepEqual(parseHouseholdNoticeDate('2030/10/05 12:34', '2030-10-05'), {
    on: '2030-10-05',
    time: '12:34',
  });
  assert.deepEqual(
    parseHouseholdNoticeDate('2030年10月5日（土） 9時05分', '2030-10-05'),
    { on: '2030-10-05', time: '09:05' },
  );
  assert.deepEqual(parseHouseholdNoticeDate('2030-10-05', '2030-10-06'), {
    on: '2030-10-05',
    time: null,
  });
  assert.deepEqual(parseHouseholdNoticeDate('10/05 08:00', '2030-10-06'), {
    on: '2030-10-05',
    time: '08:00',
  });
  // 1 月に受け取った 12 月の利用は前の年。
  assert.deepEqual(parseHouseholdNoticeDate('12/31', '2031-01-02'), {
    on: '2030-12-31',
    time: null,
  });
  assert.equal(parseHouseholdNoticeDate('2030/02/30', '2030-03-01'), null);
  assert.equal(parseHouseholdNoticeDate('近日中', '2030-10-05'), null);
});

test('日付: 年のない日付が受信日より後でも、7 日以内なら受信日の年のまま（ADR 0170）', () => {
  // タイムゾーンの違いで 1 日先になっただけの日付は前の年にしない。
  assert.deepEqual(parseHouseholdNoticeDate('12/01 00:10', '2030-11-30'), {
    on: '2030-12-01',
    time: '00:10',
  });
  // ちょうど 7 日先までは受信日の年、8 日先からは前の年。
  assert.equal(
    parseHouseholdNoticeDate('10/12', '2030-10-05')?.on,
    '2030-10-12',
  );
  assert.equal(
    parseHouseholdNoticeDate('10/13', '2030-10-05')?.on,
    '2029-10-13',
  );
  // 月をまたぐ 7 日先と 8 日先。
  assert.equal(
    parseHouseholdNoticeDate('11/06', '2030-10-30')?.on,
    '2030-11-06',
  );
  assert.equal(
    parseHouseholdNoticeDate('11/07', '2030-10-30')?.on,
    '2029-11-07',
  );
  // 年末年始: 12/31 の利用を 1/2 に受け取れば前の年。年内の 12/31 を 12/30 に受け取れば同じ年。
  assert.equal(
    parseHouseholdNoticeDate('12/31', '2031-01-02')?.on,
    '2030-12-31',
  );
  assert.equal(
    parseHouseholdNoticeDate('12/31', '2030-12-30')?.on,
    '2030-12-31',
  );
  // 受信日と同じ・過去の日付は変わらない。
  assert.equal(
    parseHouseholdNoticeDate('10/05', '2030-10-05')?.on,
    '2030-10-05',
  );
  // ちょうど 7 日先の月日は、受信日に近い翌年になる（358 日前の同じ年より近い）。
  assert.equal(
    parseHouseholdNoticeDate('01/07', '2030-12-31')?.on,
    '2031-01-07',
  );
});

test('本文: 項目名と値を読み、記録の内容にする（同じ行の書式と次の行の書式）', () => {
  const sameLine = readHouseholdNotice({
    issuer: issuer('smbc_card'),
    subject: 'ご利用のお知らせ',
    text: [
      'いつもご利用いただきありがとうございます。',
      'ご利用金額は確定したものではありません。',
      '',
      '◇利用日：2030/10/05 12:34',
      '◇利用先：合成マート 駅前店',
      '◇利用取引：買物',
      '◇利用金額：1,280円',
    ].join('\n'),
    received_on: '2030-10-05',
  });
  assert.deepEqual(sameLine, {
    outcome: 'entries',
    entries: [
      {
        index: 0,
        content: {
          direction: 'expense',
          amount_yen: 1280,
          occurred_on: '2030-10-05',
          occurred_time: '12:34',
          category: 'uncategorized',
          merchant: '合成マート 駅前店',
          memo: null,
          payment: '三井住友カード',
        },
      },
    ],
    skipped: [],
  });
  const nextLine = readHouseholdNotice({
    issuer: issuer('view_card'),
    subject: '【確報】カードご利用のお知らせ',
    text: [
      '【ご利用日】',
      '2030年10月4日',
      '【ご利用加盟店】',
      '合成書店',
      '【ご利用金額】',
      '２，４２０円',
    ].join('\r\n'),
    received_on: '2030-10-06',
  });
  assert.equal(nextLine.outcome, 'entries');
  assert.deepEqual(
    nextLine.outcome === 'entries' && nextLine.entries[0]?.content,
    {
      direction: 'expense',
      amount_yen: 2420,
      occurred_on: '2030-10-04',
      occurred_time: null,
      category: 'uncategorized',
      merchant: '合成書店',
      memo: null,
      payment: 'ビューカード',
    },
  );
});

test('本文: 一通に複数の利用があれば順に分け、外貨や取消の利用は理由とともに外す', () => {
  const reading = readHouseholdNotice({
    issuer: issuer('rakuten_card'),
    subject: 'カード利用のお知らせ',
    text: [
      '■利用日: 2030/10/01',
      '■利用先: 合成カフェ',
      '■利用金額: 450 円',
      '■利用日: 2030/10/02',
      '■利用先: SYNTHETIC STORE',
      '■利用金額: USD 12.34',
      '■利用日: 2030/10/03',
      '■利用先: 合成交通',
      '■利用金額: 1,100 円',
      '■利用日: 2030/10/03',
      '■利用先: 合成カフェ',
      '■利用金額: -450 円',
    ].join('\n'),
    received_on: '2030-10-05',
  });
  assert.equal(reading.outcome, 'entries');
  if (reading.outcome !== 'entries') return;
  assert.deepEqual(
    reading.entries.map((entry) => [
      entry.index,
      entry.content.amount_yen,
      entry.content.occurred_on,
      entry.content.merchant,
    ]),
    [
      [0, 450, '2030-10-01', '合成カフェ'],
      [2, 1100, '2030-10-03', '合成交通'],
    ],
  );
  assert.deepEqual(reading.skipped, [
    { index: 1, reason: 'foreign_currency' },
    { index: 3, reason: 'cancellation' },
  ]);
});

test('本文: 日付のない通知は受信日を使い、店名にカード番号らしい長い数字があれば店名を空にする', () => {
  const reading = readHouseholdNotice({
    issuer: issuer('jcb'),
    subject: 'カードご利用通知',
    text: 'ご利用先：合成 1234 5678 9012 3456\nご利用金額：980円',
    received_on: '2030-10-07',
  });
  assert.equal(reading.outcome, 'entries');
  if (reading.outcome !== 'entries') return;
  assert.deepEqual(
    [
      reading.entries[0]?.content.occurred_on,
      reading.entries[0]?.content.merchant,
    ],
    ['2030-10-07', null],
  );
});

test('本文: 速報・利用の通知でない件名・金額のない本文は記録しない', () => {
  assert.deepEqual(
    readHouseholdNotice({
      issuer: issuer('view_card'),
      subject: '【速報】カードご利用のお知らせ',
      text: 'ご利用金額：1,000円',
      received_on: '2030-10-05',
    }),
    { outcome: 'ignored', reason: 'provisional' },
  );
  assert.deepEqual(
    readHouseholdNotice({
      issuer: issuer('smbc_card'),
      subject: 'ご請求金額確定のお知らせ',
      text: 'ご利用金額：1,000円',
      received_on: '2030-10-05',
    }),
    { outcome: 'ignored', reason: 'not_usage_notice' },
  );
  assert.deepEqual(
    readHouseholdNotice({
      issuer: issuer('smbc_card'),
      subject: 'ご利用のお知らせ',
      text: 'ご利用内容はアプリでご確認ください。',
      received_on: '2030-10-05',
    }),
    { outcome: 'ignored', reason: 'no_usage' },
  );
});

test('本文: ご利用金額とお支払い金額が並ぶ通知は 1 件、支払いの金額だけの通知も 1 件、利用の金額が二つなら 2 件（ADR 0170）', () => {
  const both = readHouseholdNotice({
    issuer: issuer('smbc_card'),
    subject: 'ご利用のお知らせ',
    text: [
      '◇利用日：2030/10/05 12:34',
      '◇利用先：合成マート 駅前店',
      '◇ご利用金額：1,200円',
      '◇お支払い金額：1,200円',
    ].join('\n'),
    received_on: '2030-10-05',
  });
  assert.equal(both.outcome, 'entries');
  assert.equal(both.entries.length, 1);
  assert.equal(both.entries[0].content.amount_yen, 1200);
  assert.equal(both.entries[0].content.merchant, '合成マート 駅前店');
  assert.deepEqual(both.skipped, []);
  const paymentOnly = readHouseholdNotice({
    issuer: issuer('smbc_card'),
    subject: 'ご利用のお知らせ',
    text: [
      '◇利用日：2030/10/05 12:34',
      '◇利用先：合成書店',
      '◇お支払金額：3,400円',
    ].join('\n'),
    received_on: '2030-10-05',
  });
  assert.equal(paymentOnly.outcome, 'entries');
  assert.equal(paymentOnly.entries.length, 1);
  assert.equal(paymentOnly.entries[0].content.amount_yen, 3400);
  const twoUsages = readHouseholdNotice({
    issuer: issuer('smbc_card'),
    subject: 'ご利用のお知らせ',
    text: [
      '◇利用日：2030/10/05 12:34',
      '◇利用先：合成マート',
      '◇ご利用金額：500円',
      '◇利用日：2030/10/05 13:00',
      '◇利用先：合成書店',
      '◇ご利用金額：700円',
      '◇お支払い金額：1,200円',
    ].join('\n'),
    received_on: '2030-10-05',
  });
  assert.equal(twoUsages.outcome, 'entries');
  assert.deepEqual(
    twoUsages.entries.map((entry) => entry.content.amount_yen),
    [500, 700],
  );
});

test('日付: 年のない日付は、受信日の前の年・同じ年・翌年のうち、7 日先から 358 日前までに入るものにする（ADR 0170）', () => {
  const year = (value, received) =>
    parseHouseholdNoticeDate(value, received)?.on ?? null;
  // 年末の受信に年初の日付: 翌年。タイムゾーンの違いで 1 日先になる場合。
  assert.deepEqual(parseHouseholdNoticeDate('01/01 00:10', '2030-12-31'), {
    on: '2031-01-01',
    time: '00:10',
  });
  assert.equal(year('01/02', '2030-12-31'), '2031-01-02');
  assert.equal(year('01/06', '2030-12-31'), '2031-01-06');
  // ちょうど 7 日先（01/07）は、受信日と同じ年の 358 日前も範囲に入るが、受信日に近い翌年を使う。8 日先（01/08）は範囲の外
  // なので、357 日前の同じ年。境目の前後で年が揺れない（01/06・01/07 は翌年、01/08 から同じ年）。
  assert.equal(year('01/07', '2030-12-31'), '2031-01-07');
  assert.equal(year('01/08', '2030-12-31'), '2030-01-08');
  // 年始の受信に年末の日付: 前の年。
  assert.equal(year('12/31', '2031-01-01'), '2030-12-31');
  assert.equal(year('12/25', '2031-01-03'), '2030-12-25');
  // 年内の境目（受信日の年のまま）。
  assert.equal(year('12/31', '2030-12-31'), '2030-12-31');
  assert.equal(year('12/31', '2030-12-24'), '2030-12-31');
  assert.equal(year('12/31', '2030-12-23'), '2029-12-31');
  // 年始の受信で、年初の過去の日付は同じ年。
  assert.equal(year('01/01', '2031-01-01'), '2031-01-01');
  assert.equal(year('11/30', '2031-01-01'), '2030-11-30');
  // 範囲の下の端: 受信日の 358 日前までは前の年。
  assert.equal(year('10/12', '2030-10-05'), '2030-10-12');
  assert.equal(year('10/13', '2030-10-05'), '2029-10-13');
  // うるう年をまたぐ 7 日先と 8 日先、358 日前。
  assert.equal(year('03/06', '2028-02-28'), '2028-03-06');
  assert.equal(year('03/07', '2028-02-28'), '2027-03-07');
  assert.equal(year('03/01', '2028-02-22'), '2027-03-01');
  // 年のある日付は受信日と離れていてもそのまま。
  assert.equal(year('2029/01/05', '2030-12-31'), '2029-01-05');
});

test('日付: 年のない 2/29 は、その年にうるう日がある年だけで読み、ないときは丸めず null にする（ADR 0170）', () => {
  const year = (value, received) =>
    parseHouseholdNoticeDate(value, received)?.on ?? null;
  assert.equal(year('02/29', '2032-03-01'), '2032-02-29');
  assert.equal(year('02/29', '2028-03-03'), '2028-02-29');
  assert.equal(year('02/29', '2028-02-25'), '2028-02-29');
  // 2029〜2031 年には 2/29 がなく、2028 年は 358 日より前、2032 年は 7 日より先。
  assert.equal(year('02/29', '2029-03-01'), null);
  assert.equal(year('02/29', '2030-03-01'), null);
  assert.equal(year('02/29', '2031-03-01'), null);
  assert.equal(year('02/29', '2027-03-02'), null);
  // 本文の日付が読めなければ、受信日を使う（既存の扱い）。
  const reading = readHouseholdNotice({
    issuer: issuer('smbc_card'),
    subject: 'ご利用のお知らせ',
    text: ['◇利用日：02/29', '◇ご利用金額：500円'].join('\n'),
    received_on: '2030-03-01',
  });
  assert.equal(reading.outcome, 'entries');
  assert.equal(reading.entries[0].content.occurred_on, '2030-03-01');
});

test('本文: 利用の金額の項目がなく支払いの金額の項目が 2 種類並ぶ通知は 1 件にし、金額が食い違えば読まない（ADR 0170）', () => {
  const read = (lines) =>
    readHouseholdNotice({
      issuer: issuer('smbc_card'),
      subject: 'ご利用のお知らせ',
      text: lines.join('\n'),
      received_on: '2030-10-05',
    });
  const same = read([
    '◇利用日：2030/10/05 12:34',
    '◇利用先：合成マート',
    '◇お支払い金額：1,200円',
    '◇決済金額：1,200円',
  ]);
  assert.equal(same.outcome, 'entries');
  assert.deepEqual(
    same.entries.map((entry) => [entry.index, entry.content.amount_yen]),
    [[0, 1200]],
  );
  assert.deepEqual(same.skipped, []);
  // 順序が逆でも 1 件。
  const reversed = read(['◇決済金額：800円', '◇お支払金額：800円']);
  assert.deepEqual(
    reversed.entries.map((entry) => entry.content.amount_yen),
    [800],
  );
  // 金額が食い違えば、どちらも信じず、その利用は読まない。
  const differ = read([
    '◇利用日：2030/10/05 12:34',
    '◇利用先：合成マート',
    '◇お支払い金額：1,200円',
    '◇決済金額：1,300円',
  ]);
  assert.equal(differ.outcome, 'entries');
  assert.deepEqual(differ.entries, []);
  assert.deepEqual(differ.skipped, [{ index: 0, reason: 'amount_unreadable' }]);
  // 一方が外貨なら、その理由で読まない。
  const foreign = read(['◇お支払い金額：1,200円', '◇決済金額：USD 12.00']);
  assert.deepEqual(foreign.entries, []);
  assert.deepEqual(foreign.skipped, [{ index: 0, reason: 'foreign_currency' }]);
  // 一通に 2 件の利用があり、それぞれに 2 種類の支払いの金額が並ぶ本文は 2 件。
  const two = read([
    '◇利用日：2030/10/01',
    '◇利用先：合成マート',
    '◇お支払い金額：500円',
    '◇決済金額：500円',
    '◇利用日：2030/10/02',
    '◇利用先：合成書店',
    '◇お支払い金額：700円',
    '◇決済金額：700円',
  ]);
  assert.deepEqual(
    two.entries.map((entry) => [
      entry.index,
      entry.content.amount_yen,
      entry.content.merchant,
    ]),
    [
      [0, 500, '合成マート'],
      [1, 700, '合成書店'],
    ],
  );
  // 種類の同じ支払いの金額の項目が二度出れば、これまでどおり次の利用。
  const sameKind = read(['◇お支払い金額：500円', '◇お支払金額：700円']);
  assert.deepEqual(
    sameKind.entries.map((entry) => entry.content.amount_yen),
    [500, 700],
  );
  // 利用の金額の項目があれば、支払いの金額の項目が 2 種類あっても 1 件（既存の扱い）。
  const usage = read([
    '◇ご利用金額：900円',
    '◇お支払い金額：900円',
    '◇決済金額：900円',
  ]);
  assert.deepEqual(
    usage.entries.map((entry) => entry.content.amount_yen),
    [900],
  );
});
