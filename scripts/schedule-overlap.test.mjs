import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findScheduleOverlaps,
  orderCandidates,
  scheduleOverlapDeadline,
} from '../packages/domain/dist/index.js';

// B11-02 P3: 予定の重複の判定（ADR 0117、設計 04 予定重複、T05 の境界）。
// 期待値は手で数えた。日本時間（UTC+9、夏時間なし）の 2030-10-09（水）の予定で、時刻は UTC で書く。
const ZONE = 'Asia/Tokyo';
const WINDOW = { start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' };

const ev = (id, start, end, over = {}) => ({
  calendar_id: 'cal-a',
  event_id: id,
  ical_uid: `uid-${id}`,
  recurrence_id: null,
  status: 'confirmed',
  response: 'none',
  busy: true,
  time: { kind: 'timed', start, end },
  ...over,
});
const day = (id, start_date, end_date, over = {}) =>
  ev(id, '', '', { time: { kind: 'all_day', start_date, end_date }, ...over });
const run = (events, window = WINDOW, zone = ZONE) => {
  const result = findScheduleOverlaps(events, window, zone);
  assert.equal(result.ok, true);
  return result;
};
const periodsOf = (result) =>
  result.overlaps.map((o) =>
    o.period.kind === 'timed'
      ? `${o.period.start}/${o.period.end}`
      : `${o.period.start_date}..${o.period.end_date}`,
  );

test('the interval includes its start and excludes its end', () => {
  // 終了と次の開始が同時なら重複にしない。
  const touching = run([
    ev('a', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z'),
    ev('b', '2030-10-09T02:00:00Z', '2030-10-09T03:00:00Z'),
  ]);
  assert.deepEqual(touching.overlaps, []);
  // 1 秒でも重なれば重複で、時間帯はその 1 秒。
  const oneSecond = run([
    ev('a', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z'),
    ev('b', '2030-10-09T01:59:59Z', '2030-10-09T03:00:00Z'),
  ]);
  assert.deepEqual(periodsOf(oneSecond), [
    '2030-10-09T01:59:59Z/2030-10-09T02:00:00Z',
  ]);
  assert.deepEqual(oneSecond.overlaps[0].refs, ['ical:uid-a#', 'ical:uid-b#']);
  assert.equal(oneSecond.overlaps[0].identity, 'distinct');
});

test('a contained event overlaps for its whole length, and identical times overlap fully', () => {
  const contained = run([
    ev('outer', '2030-10-09T01:00:00Z', '2030-10-09T05:00:00Z'),
    ev('inner', '2030-10-09T02:00:00Z', '2030-10-09T03:00:00Z'),
  ]);
  assert.deepEqual(periodsOf(contained), [
    '2030-10-09T02:00:00Z/2030-10-09T03:00:00Z',
  ]);
  const same = run([
    ev('a', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z'),
    ev('b', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z'),
  ]);
  assert.deepEqual(periodsOf(same), [
    '2030-10-09T01:00:00Z/2030-10-09T02:00:00Z',
  ]);
});

test('three events give one pair for each real overlap, not for events that only touch', () => {
  const result = run([
    ev('a', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z'),
    ev('b', '2030-10-09T01:30:00Z', '2030-10-09T02:30:00Z'),
    ev('c', '2030-10-09T02:00:00Z', '2030-10-09T03:00:00Z'),
  ]);
  assert.deepEqual(
    result.overlaps.map((o) => [
      o.refs[0],
      o.refs[1],
      periodsOf({ overlaps: [o] })[0],
    ]),
    [
      [
        'ical:uid-a#',
        'ical:uid-b#',
        '2030-10-09T01:30:00Z/2030-10-09T02:00:00Z',
      ],
      [
        'ical:uid-b#',
        'ical:uid-c#',
        '2030-10-09T02:00:00Z/2030-10-09T02:30:00Z',
      ],
    ],
  );
});

test('the same event held in two calendars is not an overlap with itself', () => {
  const copy = ev('p-copy', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z', {
    calendar_id: 'cal-b',
    ical_uid: 'uid-p',
  });
  const original = ev('p', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z', {
    ical_uid: 'uid-p',
  });
  assert.deepEqual(run([original, copy]).overlaps, []);
  // 片方の写しの時刻が古いなど、時間帯が食い違っても、同じ予定どうしは重複にしない。
  const stale = ev('p-stale', '2030-10-09T01:30:00Z', '2030-10-09T02:30:00Z', {
    calendar_id: 'cal-b',
    ical_uid: 'uid-p',
  });
  assert.deepEqual(run([original, stale]).overlaps, []);
  // 別の予定と重なるときは、写しが 2 つあっても 1 件だけ。
  const other = ev('y', '2030-10-09T01:30:00Z', '2030-10-09T02:30:00Z');
  const result = run([copy, original, other]);
  assert.equal(result.overlaps.length, 1);
  assert.deepEqual(result.overlaps[0].refs, ['ical:uid-p#', 'ical:uid-y#']);
  // 畳んだ写しは ID の昇順で先頭の 1 つを示す。
  assert.deepEqual(result.overlaps[0].events[0], {
    calendar_id: 'cal-a',
    event_id: 'p',
  });
});

test('a recurring event is compared by occurrence, not as a whole series', () => {
  const week1 = ev('s1', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z', {
    ical_uid: 'uid-s',
    recurrence_id: '2030-10-09T01:00:00Z',
  });
  const week2 = ev('s2', '2030-10-16T01:00:00Z', '2030-10-16T02:00:00Z', {
    ical_uid: 'uid-s',
    recurrence_id: '2030-10-16T01:00:00Z',
  });
  const other = ev('z', '2030-10-16T01:30:00Z', '2030-10-16T02:30:00Z');
  const result = run([week1, week2, other]);
  assert.equal(result.overlaps.length, 1);
  assert.deepEqual(result.overlaps[0].refs, [
    'ical:uid-s#2030-10-16T01:00:00Z',
    'ical:uid-z#',
  ]);
  // 同じ繰り返しの別の回どうしでも、時間が重なれば別々の予定として重複する（動かした回）。
  const moved = ev('s3', '2030-10-09T01:30:00Z', '2030-10-09T02:30:00Z', {
    ical_uid: 'uid-s',
    recurrence_id: '2030-10-10T01:00:00Z',
  });
  const pair = run([week1, moved]);
  assert.equal(pair.overlaps.length, 1);
  assert.equal(pair.overlaps[0].identity, 'distinct');
});

test('an event without an iCalUID is shown as an unconfirmed overlap, not dropped', () => {
  const noUid = ev('a', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z', {
    ical_uid: null,
  });
  const other = ev('b', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z');
  const result = run([noUid, other]);
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0].identity, 'unconfirmed');
  assert.deepEqual(result.overlaps[0].refs, ['ical:uid-b#', 'id:cal-a/a']);
  // 同じカレンダーと ID の写しは、iCalUID が無くても同じ予定。
  const dup = ev('a', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z', {
    ical_uid: null,
  });
  assert.deepEqual(run([noUid, dup]).overlaps, []);
});

test('cancelled, declined and free-time events are excluded with a reason', () => {
  const base = ev('base', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z');
  const t = ['2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z'];
  const result = run([
    base,
    ev('cancelled', ...t, { status: 'cancelled' }),
    ev('declined', ...t, { response: 'declined' }),
    ev('free', ...t, { busy: false }),
  ]);
  assert.deepEqual(result.overlaps, []);
  assert.deepEqual(
    result.excluded.map((e) => [e.event_id, e.reason]),
    [
      ['cancelled', 'cancelled'],
      ['declined', 'declined'],
      ['free', 'free_time'],
    ],
  );
  // 仮の予定・未回答・仮の出欠は除かない。
  const kept = run([
    base,
    ev('tentative-status', ...t, { status: 'tentative' }),
    ev('tentative-reply', ...t, { response: 'tentative' }),
    ev('needs-action', ...t, { response: 'needs_action' }),
  ]);
  assert.equal(kept.overlaps.length, 6); // 4 つの総当たり
  assert.equal(kept.excluded.length, 0);
});

test('events whose times cannot be read are excluded, never guessed', () => {
  const base = ev('base', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z');
  const result = run([
    base,
    ev('backwards', '2030-10-09T02:00:00Z', '2030-10-09T01:00:00Z'),
    ev('empty', '2030-10-09T01:30:00Z', '2030-10-09T01:30:00Z'),
    ev('local', '2030-10-09T10:00:00', '2030-10-09T11:00:00'),
    ev('offset', '2030-10-09T10:00:00+09:00', '2030-10-09T11:00:00+09:00'),
    ev('nodate', '', ''),
    day('bad-day', '2030-02-30', '2030-03-01'),
    day('reverse-day', '2030-10-10', '2030-10-09'),
    day('empty-day', '2030-10-09', '2030-10-09'),
  ]);
  assert.deepEqual(result.overlaps, []);
  assert.deepEqual(
    result.excluded.map((e) => [e.event_id, e.reason]),
    [
      ['backwards', 'time_invalid'],
      ['bad-day', 'time_invalid'],
      ['empty', 'time_invalid'],
      ['empty-day', 'time_invalid'],
      ['local', 'time_invalid'],
      ['nodate', 'time_invalid'],
      ['offset', 'time_invalid'],
      ['reverse-day', 'time_invalid'],
    ],
  );
});

test('an all-day event keeps its dates and covers the local day of the user', () => {
  // 日本時間の 10/09 は 2030-10-08T15:00Z から 2030-10-09T15:00Z まで。
  const allDay = day('ad', '2030-10-09', '2030-10-10');
  const inside = ev('t1', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z');
  const acrossEnd = ev('t2', '2030-10-09T14:30:00Z', '2030-10-09T15:30:00Z');
  const afterEnd = ev('t3', '2030-10-09T15:00:00Z', '2030-10-09T16:00:00Z');
  const acrossStart = ev('t0', '2030-10-08T14:30:00Z', '2030-10-08T15:30:00Z');
  const result = run([allDay, inside, acrossEnd, acrossStart]);
  assert.deepEqual(periodsOf(result), [
    '2030-10-08T15:00:00Z/2030-10-08T15:30:00Z',
    '2030-10-09T01:00:00Z/2030-10-09T02:00:00Z',
    '2030-10-09T14:30:00Z/2030-10-09T15:00:00Z',
  ]);
  // 日の終わりちょうどに始まる予定は重ならない。同じ予定でも UTC の本人なら、UTC の日付で比べる。
  assert.deepEqual(run([allDay, afterEnd], WINDOW, ZONE).overlaps, []);
  const utc = run([allDay, afterEnd], WINDOW, 'UTC');
  assert.deepEqual(periodsOf(utc), [
    '2030-10-09T15:00:00Z/2030-10-09T16:00:00Z',
  ]);
});

test('a free all-day event is excluded and two busy all-day events overlap by dates', () => {
  const free = day('free-day', '2030-10-09', '2030-10-10', { busy: false });
  const timed = ev('t', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z');
  const freeResult = run([free, timed]);
  assert.deepEqual(freeResult.overlaps, []);
  assert.deepEqual(
    freeResult.excluded.map((e) => e.reason),
    ['free_time'],
  );
  // 日付どうし: 10/09〜10/10 の終わりと 10/10〜10/11 の始まりが重なる日は 10/10 の 1 日。
  const result = run([
    day('a', '2030-10-09', '2030-10-11'),
    day('b', '2030-10-10', '2030-10-12'),
  ]);
  assert.deepEqual(result.overlaps[0].period, {
    kind: 'all_day',
    start_date: '2030-10-10',
    end_date: '2030-10-11',
  });
  // 終了の日付は含まないので、隣り合う日は重複にしない。
  assert.deepEqual(
    run([
      day('a', '2030-10-09', '2030-10-10'),
      day('b', '2030-10-10', '2030-10-11'),
    ]).overlaps,
    [],
  );
});

test('an all-day event follows the length of the day in a zone with daylight saving time', () => {
  // ニューヨークの 2030-03-10 は夏時間の開始日で 23 時間。0 時は 05:00Z、翌日の 0 時は 04:00Z。
  const NY = 'America/New_York';
  const allDay = day('ad', '2030-03-10', '2030-03-11');
  const early = ev('e', '2030-03-10T04:30:00Z', '2030-03-10T05:30:00Z');
  const late = ev('l', '2030-03-11T03:30:00Z', '2030-03-11T05:00:00Z');
  const after = ev('a', '2030-03-11T04:00:00Z', '2030-03-11T05:00:00Z');
  const result = run([allDay, early, late], WINDOW, NY);
  assert.deepEqual(periodsOf(result), [
    '2030-03-10T05:00:00Z/2030-03-10T05:30:00Z',
    '2030-03-11T03:30:00Z/2030-03-11T04:00:00Z',
  ]);
  // 翌日の 0 時（04:00Z）ちょうどに始まる予定は重ならない。
  assert.deepEqual(run([allDay, after], WINDOW, NY).overlaps, []);
});

test('only overlaps that meet the window are returned, and they are not cut to it', () => {
  const window = { start: '2030-10-01T00:00:00Z', end: '2030-11-01T00:00:00Z' };
  const at = (a, b) => [a, b];
  const pair = (prefix, [s1, e1], [s2, e2]) => [
    ev(`${prefix}1`, s1, e1),
    ev(`${prefix}2`, s2, e2),
  ];
  const events = [
    // 期間の前で終わる（ちょうど始まりで終わるものも含めない）
    ...pair(
      'before',
      at('2030-09-30T23:00:00Z', '2030-10-01T00:00:00Z'),
      at('2030-09-30T23:30:00Z', '2030-10-01T00:00:00Z'),
    ),
    // 期間の始まりをまたぐ
    ...pair(
      'across-start',
      at('2030-09-30T23:00:00Z', '2030-10-01T01:00:00Z'),
      at('2030-09-30T23:30:00Z', '2030-10-01T00:30:00Z'),
    ),
    // 期間の終わりに始まる（終わりは含まない）
    ...pair(
      'at-end',
      at('2030-11-01T00:00:00Z', '2030-11-01T01:00:00Z'),
      at('2030-11-01T00:00:00Z', '2030-11-01T02:00:00Z'),
    ),
    // 期間の終わりの 1 秒前に始まる
    ...pair(
      'last-second',
      at('2030-10-31T23:59:59Z', '2030-11-01T01:00:00Z'),
      at('2030-10-31T23:59:59Z', '2030-11-01T02:00:00Z'),
    ),
  ];
  assert.deepEqual(periodsOf(run(events, window)), [
    '2030-09-30T23:30:00Z/2030-10-01T00:30:00Z',
    '2030-10-31T23:59:59Z/2030-11-01T01:00:00Z',
  ]);
});

test('the result does not depend on the order of the input', () => {
  const events = [
    ev('a', '2030-10-09T01:00:00Z', '2030-10-09T02:00:00Z'),
    ev('b', '2030-10-09T01:30:00Z', '2030-10-09T02:30:00Z'),
    ev('c', '2030-10-09T01:45:00Z', '2030-10-09T03:00:00Z', {
      calendar_id: 'cal-z',
    }),
    ev('d', '2030-10-09T09:00:00Z', '2030-10-09T09:30:00Z'),
  ];
  const expected = run(events);
  assert.equal(expected.overlaps.length, 3);
  for (const order of [
    [3, 2, 1, 0],
    [1, 3, 0, 2],
    [2, 0, 3, 1],
  ])
    assert.deepEqual(run(order.map((i) => events[i])), expected);
  const copy = structuredClone(events);
  run(events);
  assert.deepEqual(events, copy);
});

test('a bad window or zone is refused', () => {
  const bad = (window, zone = ZONE) => findScheduleOverlaps([], window, zone);
  assert.deepEqual(bad({ start: WINDOW.end, end: WINDOW.start }), {
    ok: false,
    reason: 'window_invalid',
  });
  assert.deepEqual(bad({ start: WINDOW.start, end: WINDOW.start }), {
    ok: false,
    reason: 'window_invalid',
  });
  assert.deepEqual(bad({ start: 'x', end: WINDOW.end }), {
    ok: false,
    reason: 'window_invalid',
  });
  assert.deepEqual(bad(WINDOW, 'Not/AZone'), {
    ok: false,
    reason: 'zone_invalid',
  });
  assert.deepEqual(bad(WINDOW, ''), { ok: false, reason: 'zone_invalid' });
});

test('the deadline of an overlap candidate is its start in the zone of the user, and sorts first today', () => {
  const [overlap] = run([
    ev('a', '2030-10-09T09:00:00Z', '2030-10-09T10:00:00Z'),
    ev('b', '2030-10-09T09:30:00Z', '2030-10-09T10:30:00Z'),
  ]).overlaps;
  assert.deepEqual(scheduleOverlapDeadline(overlap, ZONE), {
    kind: 'instant',
    local_datetime: '2030-10-09T18:30:00',
    zone: ZONE,
    original_text: '予定の重複',
  });
  const [dayOverlap] = run([
    day('a', '2030-10-10', '2030-10-12'),
    day('b', '2030-10-11', '2030-10-13'),
  ]).overlaps;
  assert.deepEqual(scheduleOverlapDeadline(dayOverlap, ZONE), {
    kind: 'date',
    date: '2030-10-11',
    original_text: '予定の重複',
  });
  // 基準 2030-10-09 12:00 JST。今日の予定の重複は、今日のより早いメールの期限よりも先に出る。
  const ordered = orderCandidates(
    [
      {
        candidate_id: 'mail',
        kind: 'mail_deadline',
        deadline: {
          kind: 'instant',
          local_datetime: '2030-10-09T12:30',
          zone: ZONE,
          original_text: 'x',
        },
        initial_import: false,
        received_at: '2030-10-08T00:00:00Z',
      },
      {
        candidate_id: 'overlap',
        kind: 'schedule_overlap',
        deadline: scheduleOverlapDeadline(overlap, ZONE),
        initial_import: false,
        received_at: '2030-10-08T00:00:00Z',
      },
    ],
    { now: '2030-10-09T03:00:00Z', zone: ZONE },
  );
  assert.deepEqual(
    ordered.groups.map((g) => [g.heading, g.items.map((i) => i.candidate_id)]),
    [['today', ['overlap', 'mail']]],
  );
});
