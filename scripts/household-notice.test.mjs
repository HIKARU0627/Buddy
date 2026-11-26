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
