import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATE_HEADING_LABELS,
  candidateRowNotes,
  candidateTitleErrors,
  orderCandidates,
} from '../packages/domain/dist/index.js';

// B11-02 P1: 気づきの表示順と見出し（ADR 0115、設計 11 §4）。
// 期待値はすべて手で数えた。基準は 2030-10-09（水）12:00 JST（= 03:00Z）。
// その週は 10/07（月）〜 10/13（日）。今日 10/09、明日 10/10、今週 10/11〜10/13、それ以降 10/14〜。
const NOW = '2030-10-09T03:00:00Z';
const ZONE = 'Asia/Tokyo';
const context = { now: NOW, zone: ZONE };

let seq = 0;
const item = (over) => {
  seq += 1;
  return {
    candidate_id: `c${String(seq).padStart(3, '0')}`,
    kind: 'mail_deadline',
    deadline: { kind: 'none' },
    initial_import: false,
    received_at: '2030-10-08T00:00:00Z',
    ...over,
  };
};
const at = (local_datetime, zone = ZONE) => ({
  kind: 'instant',
  local_datetime,
  zone,
  original_text: 'x',
});
const on = (date) => ({ kind: 'date', date, original_text: 'x' });
const headingsOf = (result) => result.groups.map((g) => g.heading);
const idsOf = (result, heading) =>
  result.groups
    .find((g) => g.heading === heading)
    ?.items.map((i) => i.candidate_id);

test('headings split at today, tomorrow, the end of this week, and later', () => {
  const cases = [
    ['2030-10-09', 'today'],
    ['2030-10-10', 'tomorrow'],
    ['2030-10-11', 'this_week'],
    ['2030-10-13', 'this_week'], // 日曜は今週の最後
    ['2030-10-14', 'later'], // 翌週の月曜
    ['2031-01-01', 'later'],
  ];
  for (const [date, heading] of cases) {
    const target = item({ deadline: on(date) });
    const result = orderCandidates([target], context);
    assert.equal(result.ok, true);
    assert.deepEqual(headingsOf(result), [heading], date);
    assert.deepEqual(idsOf(result, heading), [target.candidate_id], date);
  }
});

test('unresolved and absent deadlines go to the unknown heading, last of the live ones', () => {
  const none = item({ deadline: { kind: 'none' } });
  const unresolved = item({
    deadline: { kind: 'unresolved', reason: 'relative', original_text: '来週' },
  });
  const later = item({ deadline: on('2030-12-01') });
  const result = orderCandidates([none, unresolved, later], context);
  assert.deepEqual(headingsOf(result), ['later', 'unknown']);
  assert.equal(result.groups[1].label, '期限不明');
});

test('a malformed deadline is shown as unknown, not hidden or guessed', () => {
  const bad = item({ deadline: on('2030-02-30') }); // 実在しない日付
  const bad2 = item({ deadline: on('2030-10-9') });
  const bad3 = item({ deadline: at('2030-10-09T25:00') });
  const result = orderCandidates([bad, bad2, bad3], context);
  assert.deepEqual(headingsOf(result), ['unknown']);
  assert.equal(result.groups[0].items.length, 3);
});

test('the day changes at the local midnight of the user, not at UTC midnight', () => {
  // 2030-10-12T15:30Z = JST 2030-10-13（日）00:30。今日は 10/13、明日は翌週の 10/14。
  const nowEdge = { now: '2030-10-12T15:30:00Z', zone: ZONE };
  const cases = [
    ['2030-10-12', 'today'], // もう過ぎた日（初回取り込みでない）は今日へ
    ['2030-10-13', 'today'],
    ['2030-10-14', 'tomorrow'],
    ['2030-10-15', 'later'], // 今週が空になる日曜
  ];
  for (const [date, heading] of cases) {
    const result = orderCandidates([item({ deadline: on(date) })], nowEdge);
    assert.deepEqual(headingsOf(result), [heading], date);
  }
  // 同じ時刻でも UTC のタイムゾーンなら 10/12（土）。明日は 10/13、今週は 10/13 まで。
  const utc = { now: '2030-10-12T15:30:00Z', zone: 'UTC' };
  assert.deepEqual(
    headingsOf(orderCandidates([item({ deadline: on('2030-10-13') })], utc)),
    ['tomorrow'],
  );
});

test('an instant deadline is classified in the calendar of the user, not of its own zone', () => {
  // NOW は New York では 2030-10-08 23:00（夏時間）。そこでの 10/09 は明日。
  const inNewYork = item({
    deadline: at('2030-10-09T20:00', 'America/New_York'),
  });
  const inTokyo = item({ deadline: at('2030-10-09T20:00') });
  const result = orderCandidates([inNewYork, inTokyo], context);
  assert.deepEqual(idsOf(result, 'tomorrow'), [inNewYork.candidate_id]);
  assert.deepEqual(idsOf(result, 'today'), [inTokyo.candidate_id]);
});

test('within a heading the nearest deadline comes first and unknown ones last', () => {
  const a = item({ deadline: at('2030-10-14T09:00') });
  const b = item({ deadline: at('2030-10-14T08:59') });
  const c = item({ deadline: on('2030-10-14') }); // 日付だけは、その日の時刻付きの期限の後
  const d = item({ deadline: on('2030-10-15') });
  const result = orderCandidates([d, c, a, b], context);
  assert.deepEqual(idsOf(result, 'later'), [
    b.candidate_id,
    a.candidate_id,
    c.candidate_id,
    d.candidate_id,
  ]);
});

test('same deadline falls back to the newest received, then to the id', () => {
  const old = item({
    deadline: on('2030-10-20'),
    received_at: '2030-10-01T00:00:00Z',
  });
  const fresh = item({
    deadline: on('2030-10-20'),
    received_at: '2030-10-08T00:00:00Z',
  });
  const mid1 = item({
    candidate_id: 'tie-a',
    deadline: on('2030-10-20'),
    received_at: '2030-10-05T00:00:00Z',
  });
  const mid2 = item({
    candidate_id: 'tie-b',
    deadline: on('2030-10-20'),
    received_at: '2030-10-05T00:00:00Z',
  });
  const result = orderCandidates([mid2, old, mid1, fresh], context);
  assert.deepEqual(idsOf(result, 'later'), [
    fresh.candidate_id,
    'tie-a',
    'tie-b',
    old.candidate_id,
  ]);
  // 期限不明の見出しの中は受信の新しい順だけで並ぶ。
  const u1 = item({ received_at: '2030-10-01T00:00:00Z' });
  const u2 = item({ received_at: '2030-10-07T00:00:00Z' });
  assert.deepEqual(idsOf(orderCandidates([u1, u2], context), 'unknown'), [
    u2.candidate_id,
    u1.candidate_id,
  ]);
});

test('schedule overlaps for today and tomorrow come before every other candidate there', () => {
  const mailToday = item({ deadline: at('2030-10-09T12:30') });
  const overlapToday = item({
    kind: 'schedule_overlap',
    deadline: at('2030-10-09T18:00'), // メールの期限より遅くても先に出す
  });
  const overlapTomorrow = item({
    kind: 'schedule_overlap',
    deadline: at('2030-10-10T09:00'),
  });
  const mailTomorrow = item({ deadline: at('2030-10-10T08:00') });
  const result = orderCandidates(
    [mailToday, mailTomorrow, overlapTomorrow, overlapToday],
    context,
  );
  assert.deepEqual(idsOf(result, 'today'), [
    overlapToday.candidate_id,
    mailToday.candidate_id,
  ]);
  assert.deepEqual(idsOf(result, 'tomorrow'), [
    overlapTomorrow.candidate_id,
    mailTomorrow.candidate_id,
  ]);
  // 今週以降の予定の重複に先頭の扱いは無い。期限の近い順に混ざる。
  const mailWeek = item({ deadline: at('2030-10-11T08:00') });
  const overlapWeek = item({
    kind: 'schedule_overlap',
    deadline: at('2030-10-11T10:00'),
  });
  assert.deepEqual(
    idsOf(orderCandidates([overlapWeek, mailWeek], context), 'this_week'),
    [mailWeek.candidate_id, overlapWeek.candidate_id],
  );
});

test('past deadlines from the first import are collapsed and listed last', () => {
  const pastDate = item({ deadline: on('2030-10-08'), initial_import: true });
  const pastInstant = item({
    deadline: at('2030-10-09T11:59'), // いまより 1 分前
    initial_import: true,
  });
  const olderPast = item({ deadline: on('2030-09-01'), initial_import: true });
  const futureImport = item({
    deadline: on('2030-10-09'),
    initial_import: true,
  });
  const sameMinute = item({
    deadline: at('2030-10-09T12:00'), // いまちょうどは過ぎていない
    initial_import: true,
  });
  const unknownImport = item({ initial_import: true });
  const result = orderCandidates(
    [olderPast, pastDate, pastInstant, futureImport, sameMinute, unknownImport],
    context,
  );
  assert.deepEqual(headingsOf(result), [
    'today',
    'unknown',
    'initial_import_past',
  ]);
  const past = result.groups.at(-1);
  assert.equal(past.collapsed, true);
  assert.equal(past.label, CANDIDATE_HEADING_LABELS.initial_import_past);
  // いまに近い期限が先。
  assert.deepEqual(
    past.items.map((i) => i.candidate_id),
    [pastInstant.candidate_id, pastDate.candidate_id, olderPast.candidate_id],
  );
  assert.deepEqual(
    result.groups
      .filter((g) => g.heading !== 'initial_import_past')
      .map((g) => g.collapsed),
    [false, false],
  );
  // 今日の見出しには、期限が今日の取り込み候補が（期限が過ぎていないので）入る。
  assert.deepEqual(
    new Set(idsOf(result, 'today')),
    new Set([futureImport.candidate_id, sameMinute.candidate_id]),
  );
});

test('a past deadline that is not from the first import stays visible under today', () => {
  const overdue = item({ deadline: on('2030-10-08') });
  assert.deepEqual(headingsOf(orderCandidates([overdue], context)), ['today']);
});

test('the heading labels are the original Japanese words', () => {
  assert.deepEqual(CANDIDATE_HEADING_LABELS, {
    today: '今日',
    tomorrow: '明日',
    this_week: '今週',
    later: 'それ以降',
    unknown: '期限不明',
    initial_import_past: '初回取り込み（過去の期限）',
  });
});

test('empty input gives no groups, and the input is not changed', () => {
  assert.deepEqual(orderCandidates([], context), { ok: true, groups: [] });
  const list = [
    item({ deadline: on('2030-12-01') }),
    item({ deadline: on('2030-11-01') }),
  ];
  const copy = structuredClone(list);
  orderCandidates(list, context);
  assert.deepEqual(list, copy);
});

test('a bad clock or zone is refused instead of using the machine zone', () => {
  assert.deepEqual(orderCandidates([], { now: 'soon', zone: ZONE }), {
    ok: false,
    reason: 'now_invalid',
  });
  for (const zone of ['', 'Not/AZone', 'undefined', 'JST9', '../etc']) {
    assert.deepEqual(orderCandidates([], { now: NOW, zone }), {
      ok: false,
      reason: 'zone_invalid',
    });
  }
});

test('mail rows always say the reply status is unconfirmed', () => {
  assert.deepEqual(
    candidateRowNotes({ kind: 'mail_reply', unread_partial: false }),
    ['対応済みかは未確認'],
  );
  assert.deepEqual(
    candidateRowNotes({ kind: 'mail_deadline', unread_partial: true }),
    ['対応済みかは未確認', '本文・添付の一部は未読'],
  );
  assert.deepEqual(
    candidateRowNotes({ kind: 'schedule_overlap', unread_partial: false }),
    [],
  );
  assert.deepEqual(
    candidateRowNotes({ kind: 'research_done', unread_partial: true }),
    ['本文・添付の一部は未読'],
  );
});

test('a title never says the reply is missing, and stays within 60 characters', () => {
  const allowed = [
    '参加可否の返信：10/7 17:00まで（山田さん）',
    '見積の提出：10/9まで',
    '今日 14:00–15:00 の予定が重なっています',
    '返信は不要と書かれています',
  ];
  for (const title of allowed)
    assert.deepEqual(candidateTitleErrors(title), [], title);
  const refused = [
    '山田さんへ未返信です',
    '未対応のメール',
    '返信がありません',
    '返信していません',
    'まだ返信していない依頼',
    '返事が来ていません',
    '返信忘れ：山田さん',
    'Unreplied: Yamada',
    'You have not replied yet',
  ];
  for (const title of refused)
    assert.ok(candidateTitleErrors(title).includes('asserts_unreplied'), title);
  assert.deepEqual(candidateTitleErrors(''), ['title_empty']);
  assert.deepEqual(candidateTitleErrors('あ'.repeat(61)), ['title_too_long']);
  assert.deepEqual(candidateTitleErrors('あ'.repeat(60)), []);
  // コードポイントで数える（サロゲートペアを 2 と数えない）。
  assert.deepEqual(candidateTitleErrors('😀'.repeat(60)), []);
  assert.deepEqual(candidateTitleErrors('😀'.repeat(61)), ['title_too_long']);
});

test('deadlines in different zones are ordered on one time line, not by their local text', () => {
  // 基準 2030-10-09 12:00 JST。2030-10-20 のニューヨークは夏時間（UTC-4）。
  // 日本 10:00 = 01:00Z、ニューヨーク 08:00 = 12:00Z、ニューヨーク 09:00 = 13:00Z、日本 09:00 = 00:00Z。
  const tokyo10 = item({ deadline: at('2030-10-20T10:00') });
  const newYork08 = item({
    deadline: at('2030-10-20T08:00', 'America/New_York'),
  });
  const newYork09 = item({
    deadline: at('2030-10-20T09:00', 'America/New_York'),
  });
  const tokyo09 = item({ deadline: at('2030-10-20T09:00') });
  const result = orderCandidates(
    [newYork09, newYork08, tokyo10, tokyo09],
    context,
  );
  assert.deepEqual(idsOf(result, 'later'), [
    tokyo09.candidate_id, // 00:00Z
    tokyo10.candidate_id, // 01:00Z（文字では 10:00 が 08:00 より後でも先に出る）
    newYork08.candidate_id, // 12:00Z
    newYork09.candidate_id, // 13:00Z
  ]);
  // 日付だけの期限は、本人（日本）のその日が終わる 2030-10-20T15:00Z として比べる。
  // ニューヨーク 20:00 = 2030-10-21T00:00Z は、それより後。
  const dateOnly = item({ deadline: on('2030-10-20') });
  const newYork20 = item({
    deadline: at('2030-10-20T20:00', 'America/New_York'),
  });
  const lateNewYork = orderCandidates([newYork20, dateOnly], context);
  assert.deepEqual(idsOf(lateNewYork, 'later'), [
    dateOnly.candidate_id,
    newYork20.candidate_id,
  ]);
});

test('a time that does not exist in the zone is still ordered next to its neighbours', () => {
  // ニューヨークは 2030-03-10 02:30 が存在しない（02:00 が 03:00 になる）。直後の 03:00 EDT = 07:00Z として比べる。
  const nowSpring = { now: '2030-03-01T03:00:00Z', zone: 'America/New_York' };
  const gap = item({ deadline: at('2030-03-10T02:30', 'America/New_York') });
  const before = item({ deadline: at('2030-03-10T01:59', 'America/New_York') });
  const after = item({ deadline: at('2030-03-10T03:01', 'America/New_York') });
  const result = orderCandidates([after, gap, before], nowSpring);
  assert.deepEqual(idsOf(result, 'later'), [
    before.candidate_id,
    gap.candidate_id,
    after.candidate_id,
  ]);
});

test('the clock must be a real UTC time; a time without a zone or on a day that does not exist is refused', () => {
  const bad = [
    '2030-10-09T12:00:00', // タイムゾーンが無い（端末の時計で読まれる）
    '2030-10-09T12:00:00+09:00', // UTC ではない
    '2030-02-30T00:00:00Z', // 暦にない日
    '2030-10-09 12:00:00Z',
    '2030-10-09T12:00:00x500Z', // 小数点のはずの位置が別の文字
    '2030-10-09T12:00:00.Z',
    '2030-10-09',
    '',
  ];
  for (const now of bad)
    assert.deepEqual(
      orderCandidates([], { now, zone: ZONE }),
      {
        ok: false,
        reason: 'now_invalid',
      },
      now,
    );
  assert.equal(
    orderCandidates([], { now: '2030-10-09T03:00:00.000Z', zone: ZONE }).ok,
    true,
  );
  // 受信の時刻が UTC として読めない候補は、最も古いものとして並ぶ（端末の時計で読まない）。
  const unreadable = item({
    deadline: on('2030-10-20'),
    received_at: '2030-10-08T00:00:00',
  });
  const readable = item({
    deadline: on('2030-10-20'),
    received_at: '2020-01-01T00:00:00Z',
  });
  assert.deepEqual(
    idsOf(orderCandidates([unreadable, readable], context), 'later'),
    [readable.candidate_id, unreadable.candidate_id],
  );
});

test('a local time that happens twice when daylight saving time ends counts as the later one, and never goes back', () => {
  // ニューヨークは 2030-11-03 の 02:00 EDT に 01:00 EST へ戻る。01:30 は 05:30Z（EDT）と 06:30Z（EST）の 2 回ある。
  // 後の回（06:30Z）を期限として、先の回で期限を過ぎたと見なさない（候補を早く解決しない）。
  const NY = 'America/New_York';
  const pastAt = (nowIso) => {
    const target = item({
      deadline: at('2030-11-03T01:30', NY),
      initial_import: true,
    });
    const result = orderCandidates([target], { now: nowIso, zone: NY });
    return headingsOf(result)[0] === 'initial_import_past';
  };
  assert.equal(pastAt('2030-11-03T05:45:00Z'), false); // 01:45 EDT（1 回目の 01:30 の後）
  assert.equal(pastAt('2030-11-03T06:15:00Z'), false); // 01:15 EST（2 回目の 01:30 の前。ここで逆戻りしてはいけない）
  assert.equal(pastAt('2030-11-03T06:30:00Z'), false); // ちょうどは過ぎていない
  assert.equal(pastAt('2030-11-03T06:30:01Z'), true);
  // 5 分ごとに 4 時間見ても、いったん過ぎたら戻らない。
  let wasPast = false;
  for (let minute = 0; minute <= 240; minute += 5) {
    const now = new Date(Date.parse('2030-11-03T04:00:00Z') + minute * 60_000)
      .toISOString()
      .replace('.000Z', 'Z');
    const past = pastAt(now);
    assert.ok(!(wasPast && !past), now);
    wasPast = past;
  }
  assert.equal(wasPast, true);
  // 並べるときも後の回の時点: 06:30Z・06:40Z・06:45Z の順。
  const a = item({ deadline: at('2030-11-03T01:30', NY) });
  const b = item({ deadline: at('2030-11-03T01:45', NY) });
  const c = item({ deadline: at('2030-11-03T06:40', 'UTC') });
  const ordered = orderCandidates([b, c, a], {
    now: '2030-11-02T12:00:00Z',
    zone: NY,
  });
  assert.deepEqual(idsOf(ordered, 'tomorrow'), [
    a.candidate_id,
    c.candidate_id,
    b.candidate_id,
  ]);
});

test('the heading follows the calendar of the user, even when the deadline is written in another zone', () => {
  const NY = 'America/New_York';
  // 本人は日本。基準 2030-10-09T03:00Z = 日本 10/9 12:00。
  // ニューヨーク 10/9 09:00（EDT）= 13:00Z = 日本 10/9 22:00 は、本人にとって今日（ニューヨークの暦では今日が 10/8 でも）。
  const nyMorning = item({ deadline: at('2030-10-09T09:00', NY) });
  const tokyoLate = item({ deadline: at('2030-10-09T23:00') });
  const result = orderCandidates([tokyoLate, nyMorning], context);
  assert.deepEqual(headingsOf(result), ['today']);
  assert.deepEqual(idsOf(result, 'today'), [
    nyMorning.candidate_id,
    tokyoLate.candidate_id,
  ]);
  // ニューヨーク 10/9 20:00 = 10/10 00:00Z = 日本 10/10 09:00 は、本人にとって明日。
  const nyEvening = item({ deadline: at('2030-10-09T20:00', NY) });
  assert.deepEqual(headingsOf(orderCandidates([nyEvening], context)), [
    'tomorrow',
  ]);
  // 週の境目も本人の暦: 日本の日曜 10/13 00:30（= 10/12T15:30Z）に、ニューヨーク 10/13 11:00 = 15:00Z = 日本の月曜 10/14 00:00 は明日。
  const sunday = { now: '2030-10-12T15:30:00Z', zone: ZONE };
  const nyNoonish = item({ deadline: at('2030-10-13T11:00', NY) });
  assert.deepEqual(headingsOf(orderCandidates([nyNoonish], sunday)), [
    'tomorrow',
  ]);
  // 昨日の日本時間の夜にあたる、ニューヨークの今日の期限（初回取り込みなら過去、そうでなければ今日の見出し）。
  const past = item({
    deadline: at('2030-10-08T08:00', NY),
    initial_import: true,
  });
  assert.deepEqual(headingsOf(orderCandidates([past], context)), [
    'initial_import_past',
  ]);
  const overdue = item({ deadline: at('2030-10-08T08:00', NY) });
  assert.deepEqual(headingsOf(orderCandidates([overdue], context)), ['today']);
});
