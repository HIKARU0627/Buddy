import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATE_STATES,
  candidateDueEvent,
  candidateRetentionPhase,
  candidateTransition,
  checkSnoozeUntil,
  evidenceDecision,
} from '../packages/domain/dist/index.js';

// B11-02 P2: 時間による遷移・根拠の失効・保持の段階（ADR 0116、設計 11 §4・§5B）。
// 期待値は手で数えた。基準は 2030-10-09（水）12:00 JST（= 03:00Z）。
const NOW = '2030-10-09T03:00:00Z';
const ZONE = 'Asia/Tokyo';
const ACTIVE = ['new', 'seen', 'acted', 'snoozed'];

const on = (date) => ({ kind: 'date', date, original_text: 'x' });
const at = (local_datetime) => ({
  kind: 'instant',
  local_datetime,
  zone: ZONE,
  original_text: 'x',
});
const candidate = (over) => ({
  state: 'new',
  deadline: { kind: 'none' },
  initial_import: false,
  created_at: '2030-10-01T00:00:00Z',
  snooze_until: null,
  ...over,
});
const due = (input, now = NOW) => candidateDueEvent(input, now, ZONE);

test('evidence loss is a state transition for every live state and never for the closed ones', () => {
  for (const event of ['source_out_of_scope', 'overlap_resolved']) {
    for (const state of ACTIVE)
      assert.equal(
        candidateTransition(state, event),
        'resolved',
        `${state} ${event}`,
      );
    for (const state of ['dismissed', 'resolved'])
      assert.equal(
        candidateTransition(state, event),
        null,
        `${state} ${event}`,
      );
  }
  // 既存の遷移は変わらない。
  assert.equal(candidateTransition('new', 'open'), 'seen');
  assert.equal(candidateTransition('snoozed', 'snooze_elapsed'), 'new');
  assert.equal(candidateTransition('acted', 'dismiss'), null);
  assert.equal(CANDIDATE_STATES.length, 6);
});

test('a passed deadline resolves every live candidate; the end of a date is the local midnight', () => {
  for (const state of ACTIVE)
    assert.deepEqual(
      due(candidate({ state, deadline: on('2030-10-08') })),
      {
        ok: true,
        event: 'deadline_passed',
      },
      state,
    );
  // 日付だけの期限は、その日が終わる現地の 0 時（= 前日 15:00Z）まで過ぎない。
  const today = candidate({ deadline: on('2030-10-09') });
  assert.equal(due(today).event, null);
  assert.equal(due(today, '2030-10-09T14:59:59Z').event, null);
  assert.equal(due(today, '2030-10-09T15:00:00Z').event, 'deadline_passed');
});

test('a timed deadline passes just after its minute, not at it', () => {
  const noon = candidate({ deadline: at('2030-10-09T12:00') });
  assert.equal(due(noon, '2030-10-09T03:00:00Z').event, null);
  assert.equal(due(noon, '2030-10-09T03:00:01Z').event, 'deadline_passed');
});

test('a deadline that is absent or not single never passes by itself', () => {
  for (const deadline of [
    { kind: 'none' },
    { kind: 'unresolved', reason: 'relative', original_text: '来週' },
    on('2030-02-30'), // 暦にない日付は推測しない
  ])
    assert.equal(
      due(candidate({ deadline }), '2031-01-01T00:00:00Z').event,
      null,
    );
});

test('closed candidates stay closed even when the clock says otherwise', () => {
  for (const state of ['dismissed', 'resolved'])
    assert.equal(
      due(candidate({ state, deadline: on('2030-10-08') })).event,
      null,
    );
});

test('a first-import candidate whose deadline had already passed is not resolved by the clock', () => {
  const stale = candidate({
    initial_import: true,
    deadline: on('2030-10-08'),
    created_at: '2030-10-09T00:00:00Z', // 作った時にすでに過ぎていた
  });
  assert.equal(due(stale).event, null);
  assert.equal(due(stale, '2031-01-01T00:00:00Z').event, null);
  // 作った時に過ぎていなかった期限は、過ぎたら解決する。
  const live = candidate({
    initial_import: true,
    deadline: at('2030-10-09T18:00'),
    created_at: '2030-10-09T00:00:00Z',
  });
  assert.equal(due(live, '2030-10-09T09:00:00Z').event, null); // 18:00 ちょうど
  assert.equal(due(live, '2030-10-09T09:01:00Z').event, 'deadline_passed');
  // 作った時刻が読めない初回取り込みは、黙って解決しない。
  const unreadable = candidate({
    initial_import: true,
    deadline: on('2030-10-08'),
    created_at: 'yesterday',
  });
  assert.equal(due(unreadable).event, null);
  // 初回取り込みでなければ、作った時に過ぎていても解決する。
  const normal = candidate({
    deadline: on('2030-10-08'),
    created_at: '2030-10-09T00:00:00Z',
  });
  assert.equal(due(normal).event, 'deadline_passed');
});

test('a snooze returns to new when its time comes, and the deadline wins over it', () => {
  const snoozed = (until, deadline = { kind: 'none' }) =>
    candidate({ state: 'snoozed', snooze_until: until, deadline });
  assert.equal(due(snoozed('2030-10-09T03:00:01Z')).event, null);
  assert.equal(due(snoozed('2030-10-09T03:00:00Z')).event, 'snooze_elapsed');
  assert.equal(due(snoozed('2030-10-09T02:59:59Z')).event, 'snooze_elapsed');
  // 期限が先に過ぎたスヌーズは new に戻さず解決する。
  assert.equal(
    due(snoozed('2030-10-09T02:59:59Z', on('2030-10-08'))).event,
    'deadline_passed',
  );
  // 時刻が欠けた・読めないスヌーズは隠れたままにしない。
  for (const until of [null, '', 'tomorrow', '2030-02-30T00:00:00Z'])
    assert.equal(due(snoozed(until)).event, 'snooze_elapsed', String(until));
  // スヌーズでない候補の snooze_until は見ない。
  assert.equal(
    due(candidate({ state: 'seen', snooze_until: '2030-10-08T00:00:00Z' }))
      .event,
    null,
  );
});

test('a bad clock or zone is refused', () => {
  assert.deepEqual(candidateDueEvent(candidate({}), 'soon', ZONE), {
    ok: false,
    reason: 'now_invalid',
  });
  assert.deepEqual(
    candidateDueEvent(candidate({}), '2030-10-09T03:00:00+09:00', ZONE),
    {
      ok: false,
      reason: 'now_invalid',
    },
  );
  for (const zone of ['', 'Not/AZone', 'undefined'])
    assert.deepEqual(candidateDueEvent(candidate({}), NOW, zone), {
      ok: false,
      reason: 'zone_invalid',
    });
});

test('a snooze time must be a valid UTC time after now', () => {
  assert.deepEqual(checkSnoozeUntil(NOW, '2030-10-09T03:00:01Z'), { ok: true });
  assert.deepEqual(checkSnoozeUntil(NOW, '2030-10-09T03:00:00Z'), {
    ok: false,
    reason: 'not_in_future',
  });
  assert.deepEqual(checkSnoozeUntil(NOW, '2030-10-08T03:00:00Z'), {
    ok: false,
    reason: 'not_in_future',
  });
  assert.deepEqual(checkSnoozeUntil(NOW, '2030-10-10T03:00:00+09:00'), {
    ok: false,
    reason: 'until_invalid',
  });
  assert.deepEqual(checkSnoozeUntil('now', '2030-10-10T03:00:00Z'), {
    ok: false,
    reason: 'now_invalid',
  });
});

test('evidence observations decide the state change, the standing of the evidence and the purge', () => {
  const none = (evidence) => ({ event: null, evidence, purge: false });
  for (const state of CANDIDATE_STATES) {
    assert.deepEqual(
      evidenceDecision(state, 'available'),
      none('valid'),
      state,
    );
    // 版が変わった・取り直せないときは、状態を変えずに資格だけを失効する。
    assert.deepEqual(
      evidenceDecision(state, 'revised'),
      none('refresh_required'),
      state,
    );
    assert.deepEqual(
      evidenceDecision(state, 'temporarily_unavailable'),
      none('unconfirmed'),
      state,
    );
    // 忘却は遷移でなく物理削除。
    assert.deepEqual(
      evidenceDecision(state, 'forgotten'),
      { event: null, evidence: 'gone', purge: true },
      state,
    );
  }
  for (const observation of ['out_of_scope', 'removed']) {
    for (const state of ACTIVE)
      assert.deepEqual(
        evidenceDecision(state, observation),
        { event: 'source_out_of_scope', evidence: 'gone', purge: false },
        `${state} ${observation}`,
      );
    for (const state of ['dismissed', 'resolved'])
      assert.deepEqual(
        evidenceDecision(state, observation),
        { event: null, evidence: 'gone', purge: false },
        `${state} ${observation}`,
      );
  }
  // 返された遷移は、実際の状態機械が受け付ける。
  for (const state of ACTIVE) {
    const { event } = evidenceDecision(state, 'removed');
    assert.equal(candidateTransition(state, event), 'resolved');
  }
});

test('the retention phase follows live, seven days, ninety-seven days, then deletion', () => {
  const changed = '2030-01-01T00:00:00Z';
  const phase = (state, now, changedAt = changed) =>
    (() => {
      const out = candidateRetentionPhase(state, changedAt, now);
      assert.equal(out.ok, true, JSON.stringify(out));
      return out.phase;
    })();
  for (const state of ACTIVE)
    assert.equal(phase(state, '2035-01-01T00:00:00Z'), 'active', state);
  for (const state of ['resolved', 'dismissed']) {
    assert.equal(phase(state, '2030-01-01T00:00:00Z'), 'content_kept');
    assert.equal(phase(state, '2030-01-07T23:59:59Z'), 'content_kept');
    assert.equal(phase(state, '2030-01-08T00:00:00Z'), 'identifier_only');
    assert.equal(phase(state, '2030-04-07T23:59:59Z'), 'identifier_only');
    assert.equal(phase(state, '2030-04-08T00:00:00Z'), 'delete');
    assert.equal(phase(state, '2031-01-01T00:00:00Z'), 'delete');
  }
  // 状態を変えた時刻が読めないときは、内容を消す側で、識別子は残す。
  assert.equal(phase('resolved', NOW, 'unknown'), 'identifier_only');
  // 時計（now）が読めないときは、どの状態でも段階を返さず拒否する（全候補の内容が消える方向へ倒さない）。
  for (const state of [...ACTIVE, 'resolved', 'dismissed'])
    for (const bad of [
      'now',
      '',
      '2030-01-08T00:00:00',
      '2030-02-30T00:00:00Z',
    ])
      assert.deepEqual(
        candidateRetentionPhase(state, changed, bad),
        {
          ok: false,
          reason: 'now_invalid',
        },
        `${state} ${bad}`,
      );
});

test('a deadline on a local time that happens twice is passed only after the later one, and never un-passes', () => {
  // ニューヨークの 2030-11-03 01:30 は 05:30Z（EDT）と 06:30Z（EST）の 2 回ある。後の回（06:30Z）で過ぎる。
  const NY = 'America/New_York';
  const target = candidate({
    deadline: {
      kind: 'instant',
      local_datetime: '2030-11-03T01:30',
      zone: NY,
      original_text: 'x',
    },
  });
  const eventAt = (now) => candidateDueEvent(target, now, NY).event;
  assert.equal(eventAt('2030-11-03T05:45:00Z'), null); // 01:45 EDT。先の回の 01:30 の後でも、まだ過ぎていない
  assert.equal(eventAt('2030-11-03T06:15:00Z'), null); // 01:15 EST
  assert.equal(eventAt('2030-11-03T06:30:00Z'), null); // ちょうどは過ぎていない
  assert.equal(eventAt('2030-11-03T06:30:01Z'), 'deadline_passed');
  // 5 分ごとに見て、過ぎたあとは戻らない。
  let passed = false;
  for (let minute = 0; minute <= 300; minute += 5) {
    const now = new Date(Date.parse('2030-11-03T03:00:00Z') + minute * 60_000)
      .toISOString()
      .replace('.000Z', 'Z');
    const nowPassed = eventAt(now) === 'deadline_passed';
    assert.ok(!(passed && !nowPassed), now);
    passed = nowPassed;
  }
  assert.equal(passed, true);
  // スヌーズの終わりも、期限が先に過ぎたかどうかの判断が揺れない（掃除の時刻で結果が変わらない）。
  const snoozed = candidate({
    state: 'snoozed',
    snooze_until: '2030-11-03T05:00:00Z',
    deadline: target.deadline,
  });
  for (const now of ['2030-11-03T05:45:00Z', '2030-11-03T06:15:00Z'])
    assert.equal(
      candidateDueEvent(snoozed, now, NY).event,
      'snooze_elapsed',
      now,
    );
  assert.equal(
    candidateDueEvent(snoozed, '2030-11-03T06:30:01Z', NY).event,
    'deadline_passed',
  );
});
