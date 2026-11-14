import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PREFILTER_RULE_ID,
  automatedSenderReasons,
  cueCategories,
  deriveMessageFacts,
  prefilterCounts,
  prefilterDecision,
  prefilterRecord,
  withoutQuotedLines,
} from '../packages/domain/dist/index.js';

// 抽出前フィルター（設計 11 §2、X38・X62）。期待値は設計の語から手で書いた値で、実装から生成していない。

const human = {
  auto_submitted: null,
  precedence: null,
  has_list_unsubscribe: false,
  from_local_part: 'tanaka',
  is_calendar_invite: false,
};
const noContext = {
  user_requested: false,
  thread_has_activity: false,
  filter_enabled: true,
};
const plainMail = (overrides = {}) => ({
  subject: 'ご利用明細のお知らせ',
  body: 'ご利用ありがとうございます。明細は会員サイトでご確認いただけます。',
  attachments: [],
  ...overrides,
});
const automated = { ...human, auto_submitted: 'auto-generated' };

test('condition A: each header or local part alone marks an automated sender', () => {
  assert.deepEqual(automatedSenderReasons(human), []);
  assert.deepEqual(
    automatedSenderReasons({ ...human, auto_submitted: 'auto-replied' }),
    ['auto_submitted'],
  );
  // "no"（大文字小文字・空白・パラメーターを許す）は自動配信ではない。
  for (const value of ['no', 'No', ' NO ', 'no; comment=x', '']) {
    assert.deepEqual(
      automatedSenderReasons({ ...human, auto_submitted: value }),
      [],
      value,
    );
  }
  for (const value of ['bulk', 'List', ' JUNK ']) {
    assert.deepEqual(
      automatedSenderReasons({ ...human, precedence: value }),
      ['precedence_bulk'],
      value,
    );
  }
  assert.deepEqual(
    automatedSenderReasons({ ...human, precedence: 'first-class' }),
    [],
  );
  assert.deepEqual(
    automatedSenderReasons({ ...human, has_list_unsubscribe: true }),
    ['list_unsubscribe'],
  );
  for (const local of [
    'no-reply',
    'NoReply',
    'donotreply',
    'mailer-daemon',
    'Notification',
    'notifications',
    'NEWSLETTER',
  ]) {
    assert.deepEqual(
      automatedSenderReasons({ ...human, from_local_part: local }),
      ['automated_local_part'],
      local,
    );
  }
  // 部分一致は自動配信にしない（人の名前に no-reply が混ざっても）。
  assert.deepEqual(
    automatedSenderReasons({ ...human, from_local_part: 'reply-tanaka' }),
    [],
  );
});

test('condition B words: every listed cue is found, case-insensitively, and plain prose has none', () => {
  const cases = [
    ['10月7日にお会いしましょう', ['date']],
    ['2030/10/07 に開催', ['date']],
    ['2030-10-07 に開催', ['date']],
    ['金曜の予定', ['date']],
    ['明日', ['date']],
    ['明後日', ['date']],
    ['今週', ['date']],
    ['来週', ['date']],
    ['今月末', ['date']],
    ['本日中', ['date']],
    ['締切について', ['deadline']],
    ['締め切りは', ['deadline']],
    ['〆切', ['deadline']],
    ['期日です', ['deadline']],
    ['お支払いはDeadline前', ['deadline']],
    ['Due soon', ['deadline']],
    ['返信ください', ['request']],
    ['ご返答をお願いします', ['request']],
    ['お返事を', ['request']],
    ['ご連絡ください', ['request']],
    ['提出してください', ['request']],
    ['出欠', ['request']],
    ['Please RSVP', ['request']],
    ['Please reply', ['request']],
    ['Please CONFIRM', ['request']],
    ['予定を取り消します', ['change']],
    ['中止になりました', ['change']],
    ['訂正します', ['change']],
    ['Order CANCELLED', ['change']],
    ['This is no longer required', ['change']],
  ];
  for (const [text, expected] of cases) {
    for (const category of expected)
      assert.equal(
        cueCategories(text).includes(category),
        true,
        `${text} -> ${category}`,
      );
  }
  assert.deepEqual(
    cueCategories(
      'ご利用ありがとうございます。会員サイトでご確認いただけます。',
    ),
    [],
  );
  assert.deepEqual(cueCategories(''), []);
});

test('quoted lines are not cues of this mail', () => {
  assert.equal(
    withoutQuotedLines('本文\n> 10月7日までに\n  > 返信\nおわり'),
    '本文\nおわり',
  );
  assert.equal(withoutQuotedLines('引用なし'), '引用なし');
});

test('X38: automated mail without any cue is skipped; with a cue it is analyzed', () => {
  const skipped = prefilterDecision(automated, plainMail(), noContext);
  assert.deepEqual(skipped, {
    kind: 'skip_automated',
    rule_id: PREFILTER_RULE_ID,
    reasons: ['automated_no_cue'],
  });
  const withDate = prefilterDecision(
    automated,
    plainMail({ body: '10月7日までにお手続きください。' }),
    noContext,
  );
  assert.deepEqual(withDate, { kind: 'analyze', reasons: ['cue_found'] });
  // 件名にだけ手がかりがあっても解析する。
  assert.equal(
    prefilterDecision(
      automated,
      plainMail({ subject: '【期限】更新のお願い' }),
      noContext,
    ).kind,
    'analyze',
  );
});

test('only automated AND no-cue mail is skipped (condition A and B both required)', () => {
  // 人からのメールは、手がかりがなくても外さない。
  assert.deepEqual(prefilterDecision(human, plainMail(), noContext), {
    kind: 'analyze',
    reasons: ['not_automated'],
  });
  // 自動配信でも、手がかりがあれば外さない。
  assert.equal(
    prefilterDecision(
      { ...human, from_local_part: 'noreply' },
      plainMail({ body: '返信は不要です' }),
      noContext,
    ).kind,
    'analyze',
  );
});

test('quoted cues alone do not keep an automated mail', () => {
  const decision = prefilterDecision(
    automated,
    plainMail({ body: 'お知らせです。\n> 10月7日までに返信してください' }),
    noContext,
  );
  assert.equal(decision.kind, 'skip_automated');
});

test('X62: an attachment deadline is analyzed; unread, failed, truncated or missing body leaves condition B undetermined', () => {
  const body = '詳細は添付をご覧ください。';
  const readable = (text, extra = {}) => ({
    permitted: true,
    state: 'extracted',
    text,
    truncated: false,
    ...extra,
  });
  assert.deepEqual(
    prefilterDecision(
      automated,
      plainMail({
        body,
        attachments: [readable('2030年10月9日17時までに回答')],
      }),
      noContext,
    ),
    { kind: 'analyze', reasons: ['cue_found'] },
  );
  const undetermined = [
    { permitted: true, state: 'failed', text: null, truncated: false },
    { permitted: true, state: 'unread', text: null, truncated: false },
    readable('添付の冒頭だけ', { truncated: true }),
  ];
  for (const attachment of undetermined)
    assert.deepEqual(
      prefilterDecision(
        automated,
        plainMail({ body, attachments: [attachment] }),
        noContext,
      ),
      { kind: 'analyze', reasons: ['cue_undetermined'] },
      JSON.stringify(attachment),
    );
  assert.deepEqual(
    prefilterDecision(automated, plainMail({ body: null }), noContext),
    { kind: 'analyze', reasons: ['cue_undetermined'] },
  );
  // 許可範囲外の添付は見ない・取得しない（手がかりが入っていても、未読にも数えない）。
  assert.deepEqual(
    prefilterDecision(
      automated,
      plainMail({
        body,
        attachments: [
          readable('2030年10月9日17時までに回答', { permitted: false }),
          { permitted: false, state: 'unread', text: null, truncated: false },
        ],
      }),
      noContext,
    ),
    {
      kind: 'skip_automated',
      rule_id: PREFILTER_RULE_ID,
      reasons: ['automated_no_cue'],
    },
  );
});

test('exceptions: a user request, an active thread, a disabled filter and calendar invites', () => {
  assert.deepEqual(
    prefilterDecision(automated, plainMail(), {
      ...noContext,
      user_requested: true,
    }),
    { kind: 'analyze', reasons: ['user_requested'] },
  );
  // 本人が頼んだ招待は、フィルターにも招待の扱いにも関係なく解析する。
  assert.deepEqual(
    prefilterDecision({ ...automated, is_calendar_invite: true }, plainMail(), {
      ...noContext,
      user_requested: true,
    }),
    { kind: 'analyze', reasons: ['user_requested'] },
  );
  assert.deepEqual(
    prefilterDecision(
      { ...automated, is_calendar_invite: true },
      plainMail(),
      noContext,
    ),
    { kind: 'handled_elsewhere', reasons: ['calendar_invite'] },
  );
  // 同じスレッドに依頼・履歴があるメールは、手がかりがなくても外さない（取消・完了を見逃さない）。
  assert.deepEqual(
    prefilterDecision(automated, plainMail(), {
      ...noContext,
      thread_has_activity: true,
    }),
    { kind: 'analyze', reasons: ['thread_activity'] },
  );
  assert.deepEqual(
    prefilterDecision(automated, plainMail(), {
      ...noContext,
      filter_enabled: false,
    }),
    { kind: 'analyze', reasons: ['filter_disabled'] },
  );
});

test('recipient and automated-sender facts come from the headers (CC only is not addressed to me)', () => {
  const own = ['Me@example.invalid'];
  assert.deepEqual(
    deriveMessageFacts(human, { to: ['ME@example.invalid'], cc: [] }, own),
    { addressed_to_me: true, from_automated_sender: false },
  );
  assert.deepEqual(
    deriveMessageFacts(
      human,
      { to: ['other@example.invalid'], cc: ['me@example.invalid'] },
      own,
    ),
    { addressed_to_me: false, from_automated_sender: false },
  );
  assert.deepEqual(
    deriveMessageFacts(
      automated,
      { to: [' me@example.invalid '], cc: [] },
      own,
    ),
    { addressed_to_me: true, from_automated_sender: true },
  );
  assert.deepEqual(deriveMessageFacts(human, { to: [], cc: [] }, []), {
    addressed_to_me: false,
    from_automated_sender: false,
  });
});

test('decision records hold metadata only and the counts use the latest decision per message revision', () => {
  const message = {
    source_account_id: 'acct-1',
    message_id: 'm-1',
    source_revision: 'r1',
  };
  const skipped = prefilterRecord(
    message,
    prefilterDecision(automated, plainMail(), noContext),
    '2030-10-05T00:00:00.000Z',
  );
  assert.deepEqual(skipped, {
    source_account_id: 'acct-1',
    message_id: 'm-1',
    source_revision: 'r1',
    decision: 'skipped_automated',
    reasons: ['automated_no_cue'],
    rule_id: PREFILTER_RULE_ID,
    decided_at: '2030-10-05T00:00:00.000Z',
  });
  // 本文・件名・宛先の欄を持たない。
  assert.deepEqual(Object.keys(skipped).sort(), [
    'decided_at',
    'decision',
    'message_id',
    'reasons',
    'rule_id',
    'source_account_id',
    'source_revision',
  ]);
  const analyzed = prefilterRecord(
    message,
    prefilterDecision(human, plainMail(), noContext),
    '2030-10-05T01:00:00.000Z',
  );
  assert.equal(analyzed.rule_id, null);
  const invite = prefilterRecord(
    { ...message, message_id: 'm-2' },
    prefilterDecision(
      { ...automated, is_calendar_invite: true },
      plainMail(),
      noContext,
    ),
    '2030-10-05T02:00:00.000Z',
  );
  const other = prefilterRecord(
    { ...message, message_id: 'm-3' },
    prefilterDecision(automated, plainMail(), noContext),
    '2030-10-05T03:00:00.000Z',
  );
  // 同じメッセージ・版を再判定したら最後の判定だけを数える。
  assert.deepEqual(prefilterCounts([skipped, analyzed, invite, other]), {
    analyzed: 1,
    skipped_automated: 1,
    handled_elsewhere: 1,
  });
  assert.deepEqual(prefilterCounts([]), {
    analyzed: 0,
    skipped_automated: 0,
    handled_elsewhere: 0,
  });
});

test('review: date cues without a year and English dates keep an automated mail analyzed (not skipped)', () => {
  const cueBodies = [
    'お支払い 11/30 引落予定。残高をご確認ください',
    'お支払い 11/20（金）に引落します',
    '20日に引落します',
    '11月分の請求です',
    'Payment due Nov 20.',
    'Your plan renews on November 20',
    'Your plan renews on 20 November',
    'It renews on 3rd of March',
    'Please see you on Friday',
    'See you Fri, at the office',
    'The service ends tomorrow',
    'This ends tonight',
    'Please finish by next week',
    'Please finish by end of the day',
    'Do it EOD',
    'ASAP please',
  ];
  for (const body of cueBodies)
    assert.deepEqual(
      prefilterDecision(automated, plainMail({ body }), noContext),
      { kind: 'analyze', reasons: ['cue_found'] },
      body,
    );
  // 日付の手がかりを持たない文は、広げても外れる（過剰に解析へ回さない）。
  for (const body of [
    'ご利用ありがとうございます。会員サイトでご確認いただけます。',
    'We may contact you with news. Thank you for using the service.',
    'The sun is up and the cannon is quiet.',
    'May the best team win.',
  ])
    assert.equal(
      prefilterDecision(automated, plainMail({ body }), noContext).kind,
      'skip_automated',
      body,
    );
});
