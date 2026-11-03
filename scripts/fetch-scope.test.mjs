import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyFetchScopeUpdate,
  calendarWindow,
  checkAttachment,
  checkCalendarEvent,
  checkMailMessage,
  classifyAttachment,
  fetchRequestStale,
  initialFetchScope,
  mailWindow,
  normalizeFetchScope,
  reconcileDiscoveredTargets,
  validateFetchScope,
  FETCH_SCOPE_LIMITS,
} from '../packages/domain/dist/index.js';

// B08-02 の取得範囲の検査（設計 04 取得する対象、J13・J16、D5、ADR 0086）。
// 期待値はすべて手で書く。時刻は合成で、窓の端は 2026-11-03T00:00:00Z を基準に日数から手で数えた値。
const NOW = '2026-11-03T00:00:00.000Z';
const MAIL_START = '2026-08-05T00:00:00.000Z'; // 90 日前
const CAL_START = '2026-10-04T00:00:00.000Z'; // 30 日前
const CAL_END = '2027-02-01T00:00:00.000Z'; // 90 日後

const scope = (over = {}) => ({
  ...initialFetchScope('INBOX'),
  calendarIds: ['cal-work'],
  mailContainerIds: ['INBOX', 'Label_1'],
  ...over,
});

test('the initial scope is the design default and widens nothing', () => {
  const initial = initialFetchScope('INBOX');
  assert.deepEqual(initial, {
    calendarIds: [],
    mailContainerIds: ['INBOX'],
    attachmentKinds: ['pdf', 'text'],
    mailLookbackDays: 90,
    calendarPastDays: 30,
    calendarFutureDays: 90,
    attachmentMaxBytes: 10000000,
  });
  assert.deepEqual(validateFetchScope(initial), []);
  // 受信トレイの ID が分からない provider は空で始め、推測で足さない。
  assert.deepEqual(initialFetchScope(null).mailContainerIds, []);
  assert.deepEqual(FETCH_SCOPE_LIMITS, {
    mailLookbackDays: 90,
    calendarPastDays: 30,
    calendarFutureDays: 90,
    attachmentMaxBytes: 10000000,
  });
});

test('settings may narrow the limits but never widen them', () => {
  assert.deepEqual(
    validateFetchScope(
      scope({
        mailLookbackDays: 1,
        calendarPastDays: 0,
        calendarFutureDays: 0,
        attachmentMaxBytes: 1,
        attachmentKinds: [],
      }),
    ),
    [],
  );
  const cases = [
    [{ mailLookbackDays: 91 }, 'mail_lookback_out_of_range'],
    [{ mailLookbackDays: 0 }, 'mail_lookback_out_of_range'],
    [{ mailLookbackDays: 1.5 }, 'mail_lookback_out_of_range'],
    [{ calendarPastDays: 31 }, 'calendar_past_out_of_range'],
    [{ calendarPastDays: -1 }, 'calendar_past_out_of_range'],
    [{ calendarFutureDays: 91 }, 'calendar_future_out_of_range'],
    [{ attachmentMaxBytes: 10000001 }, 'attachment_max_bytes_out_of_range'],
    [{ attachmentMaxBytes: 0 }, 'attachment_max_bytes_out_of_range'],
    [{ attachmentMaxBytes: Number.NaN }, 'attachment_max_bytes_out_of_range'],
    [{ attachmentKinds: ['pdf', 'docx'] }, 'attachment_kind_unknown'],
    [{ attachmentKinds: ['pdf', 'pdf'] }, 'duplicate_attachment_kind'],
    [{ calendarIds: [''] }, 'calendar_id_invalid'],
    [{ calendarIds: ['a', 'a'] }, 'duplicate_calendar_id'],
    [{ mailContainerIds: [' INBOX'] }, 'mail_container_id_invalid'],
    [{ mailContainerIds: ['INBOX', 'INBOX'] }, 'duplicate_mail_container_id'],
  ];
  for (const [over, expected] of cases)
    assert.deepEqual(validateFetchScope(scope(over)), [expected], expected);
});

test('mail window is [now - lookback, now] and includes both edges', () => {
  assert.deepEqual(mailWindow(scope(), NOW), { start: MAIL_START, end: NOW });
  const check = (receivedAt, containerIds = ['INBOX']) =>
    checkMailMessage(scope(), { containerIds, receivedAt }, NOW);
  assert.deepEqual(check(MAIL_START), { ok: true });
  assert.deepEqual(check(NOW), { ok: true });
  assert.deepEqual(check('2026-08-04T23:59:59.999Z'), {
    ok: false,
    reason: 'before_window',
  });
  assert.deepEqual(check('2026-11-03T00:00:00.001Z'), {
    ok: false,
    reason: 'after_window',
  });
  // 本人が期間を狭めたら、その窓が優先する（7 日）。
  const narrow = scope({ mailLookbackDays: 7 });
  assert.deepEqual(
    checkMailMessage(
      narrow,
      { containerIds: ['INBOX'], receivedAt: '2026-10-27T00:00:00.000Z' },
      NOW,
    ),
    { ok: true },
  );
  assert.deepEqual(
    checkMailMessage(
      narrow,
      { containerIds: ['INBOX'], receivedAt: '2026-10-26T23:59:59.999Z' },
      NOW,
    ),
    { ok: false, reason: 'before_window' },
  );
});

test('mail outside the selected folders or labels is rejected', () => {
  const at = '2026-11-01T00:00:00.000Z';
  assert.deepEqual(
    checkMailMessage(
      scope(),
      { containerIds: ['Label_2'], receivedAt: at },
      NOW,
    ),
    { ok: false, reason: 'container_not_selected' },
  );
  assert.deepEqual(
    checkMailMessage(scope(), { containerIds: [], receivedAt: at }, NOW),
    { ok: false, reason: 'container_not_selected' },
  );
  // 複数のラベルのうち 1 つが選択済みなら取る。
  assert.deepEqual(
    checkMailMessage(
      scope(),
      { containerIds: ['Label_2', 'Label_1'], receivedAt: at },
      NOW,
    ),
    { ok: true },
  );
  // 受信トレイも選択に無ければ取らない（暗黙の受信トレイを作らない）。
  assert.deepEqual(
    checkMailMessage(
      scope({ mailContainerIds: ['Label_1'] }),
      { containerIds: ['INBOX'], receivedAt: at },
      NOW,
    ),
    { ok: false, reason: 'container_not_selected' },
  );
});

test('calendar window is 30 days back to 90 days ahead, overlapping events only', () => {
  assert.deepEqual(calendarWindow(scope(), NOW), {
    start: CAL_START,
    end: CAL_END,
  });
  const check = (startsAt, endsAt, calendarId = 'cal-work') =>
    checkCalendarEvent(scope(), { calendarId, startsAt, endsAt }, NOW);
  assert.deepEqual(check('2026-11-05T09:00:00Z', '2026-11-05T10:00:00Z'), {
    ok: true,
  });
  // 窓の始めの直前に終わる予定は取らず、1 ミリ秒重なれば取る。
  assert.deepEqual(check('2026-10-03T00:00:00Z', CAL_START), {
    ok: false,
    reason: 'before_window',
  });
  assert.deepEqual(check('2026-10-03T00:00:00Z', '2026-10-04T00:00:00.001Z'), {
    ok: true,
  });
  // 窓の終わりに始まる予定は取らず、1 ミリ秒前に始まれば取る。
  assert.deepEqual(check(CAL_END, '2027-02-01T01:00:00Z'), {
    ok: false,
    reason: 'after_window',
  });
  assert.deepEqual(check('2027-01-31T23:59:59.999Z', '2027-02-01T01:00:00Z'), {
    ok: true,
  });
  // 窓をまたぐ長い予定は取る。
  assert.deepEqual(check('2026-09-01T00:00:00Z', '2027-03-01T00:00:00Z'), {
    ok: true,
  });
});

test('calendars that are not selected are never fetched', () => {
  const event = {
    startsAt: '2026-11-05T09:00:00Z',
    endsAt: '2026-11-05T10:00:00Z',
  };
  assert.deepEqual(
    checkCalendarEvent(scope(), { calendarId: 'cal-other', ...event }, NOW),
    { ok: false, reason: 'calendar_not_selected' },
  );
  assert.deepEqual(
    checkCalendarEvent(
      scope({ calendarIds: [] }),
      { calendarId: 'cal-work', ...event },
      NOW,
    ),
    { ok: false, reason: 'calendar_not_selected' },
  );
});

test('times that are not strict UTC are rejected instead of guessed', () => {
  const event = { calendarId: 'cal-work', startsAt: '2026-11-05T09:00:00Z' };
  for (const bad of [
    '2026-11-05T10:00:00+09:00',
    '2026-11-05',
    '',
    'tomorrow',
  ]) {
    assert.deepEqual(
      checkCalendarEvent(scope(), { ...event, endsAt: bad }, NOW),
      { ok: false, reason: 'time_invalid' },
      bad,
    );
    assert.deepEqual(
      checkMailMessage(
        scope(),
        { containerIds: ['INBOX'], receivedAt: bad },
        NOW,
      ),
      { ok: false, reason: 'time_invalid' },
      bad,
    );
  }
  assert.deepEqual(
    checkCalendarEvent(
      scope(),
      { ...event, endsAt: '2026-11-05T08:00:00Z' },
      NOW,
    ),
    { ok: false, reason: 'time_invalid' },
  );
  assert.deepEqual(
    checkMailMessage(
      scope(),
      { containerIds: ['INBOX'], receivedAt: '2026-11-01T00:00:00Z' },
      '2026-11-03',
    ),
    { ok: false, reason: 'time_invalid' },
  );
});

test('attachment kinds are classified conservatively', () => {
  const kind = (mimeType, filename) =>
    classifyAttachment({ mimeType, filename });
  assert.deepEqual(kind('application/pdf', 'invoice.PDF'), { kind: 'pdf' });
  assert.deepEqual(kind('text/plain; charset=utf-8', 'memo.txt'), {
    kind: 'text',
  });
  assert.deepEqual(kind('text/markdown', 'notes.md'), { kind: 'text' });
  assert.deepEqual(kind('text/csv', 'table.csv'), { kind: 'text' });
  // 一般的な MIME は拡張子で決める。拡張子の無い PDF は MIME で決める。
  assert.deepEqual(kind('application/octet-stream', 'scan.pdf'), {
    kind: 'pdf',
  });
  assert.deepEqual(kind('application/pdf', 'scan'), { kind: 'pdf' });
  // 食い違いと対象外は種類を決めない。
  assert.deepEqual(kind('application/pdf', 'memo.txt'), {
    kind: null,
    reason: 'mismatch',
  });
  assert.deepEqual(kind('application/pdf', 'invoice.exe'), {
    kind: null,
    reason: 'unsupported',
  });
  assert.deepEqual(kind('image/png', 'photo.png'), {
    kind: null,
    reason: 'unsupported',
  });
  assert.deepEqual(kind('application/octet-stream', 'archive.zip'), {
    kind: null,
    reason: 'unsupported',
  });
  assert.deepEqual(kind('application/octet-stream', 'noext'), {
    kind: null,
    reason: 'unsupported',
  });
  assert.deepEqual(
    kind(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'report.docx',
    ),
    { kind: null, reason: 'unsupported' },
  );
  // プロトタイプの名前を拡張子や MIME にしても種類にならない。
  assert.deepEqual(kind('constructor', 'a.constructor'), {
    kind: null,
    reason: 'unsupported',
  });
});

test('attachments outside the selected kinds or size are rejected', () => {
  const pdf = (sizeBytes) => ({
    mimeType: 'application/pdf',
    filename: 'a.pdf',
    sizeBytes,
  });
  // サイズの上限ちょうどは取り、1 バイト超は取らない。
  assert.deepEqual(checkAttachment(scope(), pdf(10000000)), { ok: true });
  assert.deepEqual(checkAttachment(scope(), pdf(10000001)), {
    ok: false,
    reason: 'attachment_too_large',
  });
  assert.deepEqual(checkAttachment(scope(), pdf(0)), { ok: true });
  for (const unknown of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.deepEqual(checkAttachment(scope(), pdf(unknown)), {
      ok: false,
      reason: 'attachment_size_unknown',
    });
  // 本人が上限を狭めたらそれに従う。
  assert.deepEqual(
    checkAttachment(scope({ attachmentMaxBytes: 1024 }), pdf(1025)),
    { ok: false, reason: 'attachment_too_large' },
  );
  // 種類を絞れば、対象でも選択外は取らない。
  const textOnly = scope({ attachmentKinds: ['text'] });
  assert.deepEqual(checkAttachment(textOnly, pdf(100)), {
    ok: false,
    reason: 'attachment_kind_not_selected',
  });
  assert.deepEqual(
    checkAttachment(textOnly, {
      mimeType: 'text/plain',
      filename: 'a.txt',
      sizeBytes: 100,
    }),
    { ok: true },
  );
  assert.deepEqual(checkAttachment(scope({ attachmentKinds: [] }), pdf(100)), {
    ok: false,
    reason: 'attachment_kind_not_selected',
  });
  assert.deepEqual(
    checkAttachment(scope(), {
      mimeType: 'image/png',
      filename: 'tracker.png',
      sizeBytes: 43,
    }),
    { ok: false, reason: 'attachment_kind_unsupported' },
  );
});

test('an invalid scope fetches nothing', () => {
  const wide = scope({ mailLookbackDays: 365, attachmentMaxBytes: 99999999 });
  assert.deepEqual(
    checkMailMessage(
      wide,
      { containerIds: ['INBOX'], receivedAt: '2026-11-01T00:00:00Z' },
      NOW,
    ),
    { ok: false, reason: 'scope_invalid' },
  );
  assert.deepEqual(
    checkAttachment(wide, {
      mimeType: 'application/pdf',
      filename: 'a.pdf',
      sizeBytes: 1,
    }),
    { ok: false, reason: 'scope_invalid' },
  );
  assert.deepEqual(
    checkCalendarEvent(
      wide,
      {
        calendarId: 'cal-work',
        startsAt: '2026-11-05T09:00:00Z',
        endsAt: '2026-11-05T10:00:00Z',
      },
      NOW,
    ),
    { ok: false, reason: 'scope_invalid' },
  );
});

test('newly discovered calendars and folders are not added to the selection', () => {
  const current = scope();
  const result = reconcileDiscoveredTargets(current, {
    calendarIds: ['cal-work', 'cal-new', 'cal-new'],
    mailContainerIds: ['INBOX', 'Label_9'],
  });
  assert.equal(result.scope, current);
  assert.deepEqual(result.scope.calendarIds, ['cal-work']);
  assert.deepEqual(result.scope.mailContainerIds, ['INBOX', 'Label_1']);
  assert.deepEqual(result.unselected, {
    calendarIds: ['cal-new'],
    mailContainerIds: ['Label_9'],
  });
  // 選択済みで一覧から消えたものも、選択から外さない。
  assert.deepEqual(result.missing, {
    calendarIds: [],
    mailContainerIds: ['Label_1'],
  });
  // 新しいものは選択が無ければ取得もされない。
  assert.deepEqual(
    checkMailMessage(
      result.scope,
      { containerIds: ['Label_9'], receivedAt: '2026-11-01T00:00:00Z' },
      NOW,
    ),
    { ok: false, reason: 'container_not_selected' },
  );
});

const state = (over = {}) => ({
  scope: scope(),
  permissionRevision: '4',
  scopeRevision: '9',
  ...over,
});

test('changing the selection raises both revisions and normalizes the scope', () => {
  const result = applyFetchScopeUpdate(state(), {
    expectedPermissionRevision: '4',
    next: scope({ calendarIds: ['cal-b', 'cal-a'], mailLookbackDays: 30 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.state.permissionRevision, '5');
  assert.equal(result.state.scopeRevision, '10');
  assert.deepEqual(result.state.scope.calendarIds, ['cal-a', 'cal-b']);
  assert.equal(result.state.scope.mailLookbackDays, 30);
  // 桁の繰り上がりも 10 進で数える。
  const big = applyFetchScopeUpdate(
    state({ permissionRevision: '99', scopeRevision: '999' }),
    {
      expectedPermissionRevision: '99',
      next: scope({ calendarIds: [] }),
    },
  );
  assert.equal(big.state.permissionRevision, '100');
  assert.equal(big.state.scopeRevision, '1000');
});

test('an unchanged selection does not raise revisions when only the key order differs', () => {
  const base = scope();
  const current = state({ scope: normalizeFetchScope(base) });
  // 同じ値を、キーを逆順に並べたオブジェクトで送る。
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  assert.notDeepEqual(Object.keys(reordered), Object.keys(base));
  const result = applyFetchScopeUpdate(current, {
    expectedPermissionRevision: '4',
    next: reordered,
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.state, current);
  // 保存する形は決まった項目だけで、余計な項目を持ち込まない。
  const extra = applyFetchScopeUpdate(current, {
    expectedPermissionRevision: '4',
    next: { ...base, mailLookbackDays: 7, note: 'extra' },
  });
  assert.equal(extra.changed, true);
  assert.deepEqual(Object.keys(extra.state.scope).sort(), [
    'attachmentKinds',
    'attachmentMaxBytes',
    'calendarFutureDays',
    'calendarIds',
    'calendarPastDays',
    'mailContainerIds',
    'mailLookbackDays',
  ]);
});

test('precision finer than a millisecond is rejected, never truncated across a window edge', () => {
  // 切り捨てると、now の 0.0001 秒後（未来）が now と同じ時刻になって取得されてしまう。
  const mail = (receivedAt, now = NOW) =>
    checkMailMessage(scope(), { containerIds: ['INBOX'], receivedAt }, now);
  assert.deepEqual(mail('2026-11-03T00:00:00.0001Z'), {
    ok: false,
    reason: 'time_invalid',
  });
  assert.deepEqual(mail('2026-11-03T00:00:00.0000001Z'), {
    ok: false,
    reason: 'time_invalid',
  });
  // 窓の始めから 0.0001 秒だけ重なる予定も、切り捨てずに拒否する。
  const event = (endsAt) =>
    checkCalendarEvent(
      scope(),
      {
        calendarId: 'cal-work',
        startsAt: '2026-10-01T00:00:00Z',
        endsAt,
      },
      NOW,
    );
  assert.deepEqual(event('2026-10-04T00:00:00.0001Z'), {
    ok: false,
    reason: 'time_invalid',
  });
  // ミリ秒で表せる値は端の判定どおり（ちょうど端は重ならず、1 ミリ秒後は重なる）。
  assert.deepEqual(event('2026-10-04T00:00:00.000Z'), {
    ok: false,
    reason: 'before_window',
  });
  assert.deepEqual(event('2026-10-04T00:00:00.001Z'), { ok: true });
  // 端数が 0 だけなら同じ時刻として扱う（Graph の 7 桁の小数部など）。
  assert.deepEqual(mail('2026-11-03T00:00:00.0000000Z'), { ok: true });
  assert.deepEqual(mail('2026-11-03T00:00:00.0010000Z'), {
    ok: false,
    reason: 'after_window',
  });
  // 現在時刻の側も同じ。
  assert.equal(mailWindow(scope(), '2026-11-03T00:00:00.0001Z'), null);
  assert.deepEqual(mailWindow(scope(), '2026-11-03T00:00:00.0000000Z'), {
    start: MAIL_START,
    end: NOW,
  });
});

test('dates that do not exist are rejected, not corrected', () => {
  // Date.parse は 2 月 31 日を 3 月 4 日に、24 時を翌日 0 時に補正する。補正した時刻で取得を許さない。
  const mail = (receivedAt) =>
    checkMailMessage(scope(), { containerIds: ['INBOX'], receivedAt }, NOW);
  for (const bad of [
    '2026-02-31T00:00:00Z',
    '2026-02-29T00:00:00Z', // 2026 年は平年
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-11-00T00:00:00Z',
    '2026-11-03T24:00:00Z',
    '2026-11-03T23:60:00Z',
    '2026-11-03T23:59:60Z',
    '2026-04-31T12:00:00Z',
  ])
    assert.deepEqual(mail(bad), { ok: false, reason: 'time_invalid' }, bad);
  // 存在する日付は通る（うるう日、端数が 0 だけの長い小数部）。
  assert.deepEqual(mail('2026-10-31T23:59:59Z'), { ok: true });
  assert.deepEqual(mail('2026-10-31T23:59:59.1230000Z'), { ok: true });
  assert.deepEqual(
    checkMailMessage(
      scope(),
      { containerIds: ['INBOX'], receivedAt: '2024-02-29T00:00:00Z' },
      '2024-03-01T00:00:00Z',
    ),
    { ok: true },
  );
  // 現在時刻の側が存在しない日付でも、窓を作らない。
  assert.equal(mailWindow(scope(), '2026-02-31T00:00:00Z'), null);
  assert.equal(calendarWindow(scope(), '2026-11-03T24:00:00Z'), null);
  assert.deepEqual(
    checkCalendarEvent(
      scope(),
      {
        calendarId: 'cal-work',
        startsAt: '2026-11-31T00:00:00Z',
        endsAt: '2026-12-01T00:00:00Z',
      },
      NOW,
    ),
    { ok: false, reason: 'time_invalid' },
  );
});

test('an unchanged selection does not raise revisions, regardless of order', () => {
  const current = state({
    scope: normalizeFetchScope(
      scope({ mailContainerIds: ['Label_1', 'INBOX'] }),
    ),
  });
  const result = applyFetchScopeUpdate(current, {
    expectedPermissionRevision: '4',
    next: scope({ mailContainerIds: ['INBOX', 'Label_1'] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.state, current);
});

test('a stale permission revision or an invalid scope is rejected without changing state', () => {
  const current = state();
  assert.deepEqual(
    applyFetchScopeUpdate(current, {
      expectedPermissionRevision: '3',
      next: scope({ calendarIds: [] }),
    }),
    { ok: false, reason: 'permission_revision_mismatch' },
  );
  assert.deepEqual(
    applyFetchScopeUpdate(current, {
      expectedPermissionRevision: '4',
      next: scope({ mailLookbackDays: 91 }),
    }),
    {
      ok: false,
      reason: 'invalid_scope',
      issues: ['mail_lookback_out_of_range'],
    },
  );
  for (const bad of ['', '04', '-1', 'x'])
    assert.deepEqual(
      applyFetchScopeUpdate(current, {
        expectedPermissionRevision: bad,
        next: scope(),
      }),
      { ok: false, reason: 'revision_invalid' },
      bad,
    );
});

test('fetch requests built with an old revision are stale', () => {
  const current = { permissionRevision: '5', scopeRevision: '10' };
  assert.equal(
    fetchRequestStale(current, {
      permissionRevision: '5',
      scopeRevision: '10',
    }),
    null,
  );
  assert.equal(
    fetchRequestStale(current, { permissionRevision: '5', scopeRevision: '9' }),
    'scope_revision_stale',
  );
  assert.equal(
    fetchRequestStale(current, {
      permissionRevision: '4',
      scopeRevision: '10',
    }),
    'permission_revision_stale',
  );
  // 新しい側の版も一致しない（先の版を名乗る要求も取らない）。
  assert.equal(
    fetchRequestStale(current, {
      permissionRevision: '5',
      scopeRevision: '11',
    }),
    'scope_revision_stale',
  );
  assert.equal(
    fetchRequestStale(current, {
      permissionRevision: '5',
      scopeRevision: '010',
    }),
    'revision_invalid',
  );
});
