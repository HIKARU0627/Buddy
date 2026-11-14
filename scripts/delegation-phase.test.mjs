import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_SILENCE_STATE,
  aggregateDelegationPhase,
  delegationPhaseEventType,
  delegationPhaseOfEvent,
  observeSilence,
} from '../packages/domain/dist/index.js';

// B10-04 P4（ADR 0109、U253）: 中枢が端末へ伝える委譲の状態（前面・裏・なし）の規則を、手書きの期待値で検査する。
// 時計は注入した合成の値で、実音声・実機は使わない。
test('delegation phase: each phase has its own event type and the event type reads back to the same phase', () => {
  assert.equal(delegationPhaseEventType('foreground'), 'delegation_processing');
  assert.equal(
    delegationPhaseEventType('background'),
    'delegation_backgrounded',
  );
  assert.equal(delegationPhaseEventType('none'), 'delegation_finished');
  assert.equal(delegationPhaseOfEvent('delegation_processing'), 'foreground');
  assert.equal(delegationPhaseOfEvent('delegation_backgrounded'), 'background');
  assert.equal(delegationPhaseOfEvent('delegation_finished'), 'none');
});

test('delegation phase: other events and unknown values do not change the phase', () => {
  for (const type of [
    'audio_control',
    'silence_extension',
    'sideband_connected',
    'read_aloud_requested',
    'delegation_phase',
    'Delegation_Processing',
    '',
  ])
    assert.equal(delegationPhaseOfEvent(type), null, type);
});

test('delegation phase: one request waiting in the foreground keeps the whole live in the foreground, then background, then none', () => {
  const waiting = { backgrounded: false };
  const away = { backgrounded: true };
  assert.equal(aggregateDelegationPhase([]), 'none');
  assert.equal(aggregateDelegationPhase([waiting]), 'foreground');
  assert.equal(aggregateDelegationPhase([away]), 'background');
  assert.equal(aggregateDelegationPhase([away, away]), 'background');
  // 裏のものがあっても、前面で待つ依頼が 1 つでもあれば前面（無音で閉じない側）。
  assert.equal(aggregateDelegationPhase([away, waiting]), 'foreground');
  assert.equal(aggregateDelegationPhase([waiting, away, away]), 'foreground');
});

test('delegation phase: the silence rule never closes a live while the phase is foreground, closes 10 seconds after the move to the background, and counts again after finished', () => {
  const base = {
    user_speaking: false,
    playing: false,
    screen_event: false,
    screen_active: false,
  };
  // 前面で 60 秒待っても閉じない。
  let state = INITIAL_SILENCE_STATE;
  for (let t = 0; t <= 60_000; t += 5_000) {
    const decision = observeSilence(
      state,
      { ...base, delegation: 'foreground' },
      t,
    );
    assert.equal(decision.decision, 'keep', String(t));
    state = decision.state;
  }
  // 裏へ移した時点から無音を数え始め、10 秒（既定）で閉じる。
  const moved = observeSilence(
    state,
    { ...base, delegation: 'background' },
    70_000,
  );
  assert.equal(moved.decision, 'keep');
  assert.equal(
    observeSilence(moved.state, { ...base, delegation: 'background' }, 79_999)
      .decision,
    'keep',
  );
  assert.equal(
    observeSilence(moved.state, { ...base, delegation: 'background' }, 80_000)
      .decision,
    'close',
  );
  // 前面の待ちが終わって none になった後も、通常の判定（10 秒）。
  const done = observeSilence(
    INITIAL_SILENCE_STATE,
    { ...base, delegation: 'none' },
    0,
  );
  assert.equal(
    observeSilence(done.state, { ...base, delegation: 'none' }, 10_000)
      .decision,
    'close',
  );
});
