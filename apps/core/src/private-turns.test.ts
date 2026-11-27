// 記録しない区切りの発言の RAM（B06-07a-2 の 2c、ADR 0190）の単体の試験。期待値（件数・残る文・境界の時刻）は ADR 0190 の
// 上限（直前のやりとり 6 件・応答の控え 64 件・最後のやりとりから 30 分・本人の時間帯の日付の変更）から手で書いた値で、
// 実装の関数から作らない。模擬の試験だけ。

import assert from 'node:assert/strict';
import test from 'node:test';
import { PrivateConversationRam } from './private-turns.js';

const SEGMENT = { segment_id: 'seg-a', segment_generation: '2' };
const OTHER = { segment_id: 'seg-b', segment_generation: '4' };
// 本人の時間帯 +09:00 の 2026-10-05 09:00。
const T0 = '2026-10-05T00:00:00Z';

const holdTurn = (
  ram: PrivateConversationRam,
  index: number,
  at: string,
  segment = SEGMENT,
  epoch = ram.epoch,
) =>
  ram.hold({
    segment,
    epoch,
    key: `key-${index}`,
    hash: `hash-${index}`,
    body: { turn: index },
    user_text: `u${index}`,
    buddy_text: `b${index}`,
    at,
  });

test('the recent turns keep the last 6 entries (user and Buddy counted one by one)', () => {
  const ram = new PrivateConversationRam({ utcOffset: '+09:00' });
  ram.bind(SEGMENT, T0);
  for (let index = 1; index <= 3; index += 1)
    assert.equal(holdTurn(ram, index, T0), true);
  // 3 回のやりとり＝6 件。ちょうど上限。
  assert.deepEqual(
    ram.recent(SEGMENT, T0).map((turn) => `${turn.role}:${turn.text}`),
    ['user:u1', 'buddy:b1', 'user:u2', 'buddy:b2', 'user:u3', 'buddy:b3'],
  );
  // 4 回目で古い 2 件（u1・b1）が落ちる。
  holdTurn(ram, 4, T0);
  assert.deepEqual(
    ram.recent(SEGMENT, T0).map((turn) => turn.text),
    ['u2', 'b2', 'u3', 'b3', 'u4', 'b4'],
  );
  // 返事の文がない発言（予定のカードだけの応答など）は本人の発言だけを数える。
  ram.hold({
    segment: SEGMENT,
    epoch: ram.epoch,
    key: 'key-5',
    hash: 'hash-5',
    body: {},
    user_text: 'u5',
    buddy_text: null,
    at: T0,
  });
  assert.deepEqual(
    ram.recent(SEGMENT, T0).map((turn) => turn.text),
    ['b2', 'u3', 'b3', 'u4', 'b4', 'u5'],
  );
  assert.deepEqual(ram.held(), {
    replays: 5,
    recent_turns: 6,
    discards: 0,
    last_discard: null,
  });
});

test('the recent turns are dropped 30 minutes after the last exchange or when the local date changes', () => {
  const ram = new PrivateConversationRam({ utcOffset: '+09:00' });
  ram.bind(SEGMENT, T0);
  holdTurn(ram, 1, T0);
  // 29 分 59.999 秒後は残る。
  assert.equal(ram.recent(SEGMENT, '2026-10-05T00:29:59.999Z').length, 2);
  // ちょうど 30 分で捨てる（その後も空のまま）。
  assert.deepEqual(ram.recent(SEGMENT, '2026-10-05T00:30:00Z'), []);
  assert.deepEqual(ram.recent(SEGMENT, '2026-10-05T00:30:00Z'), []);
  assert.equal(ram.held().recent_turns, 0);
  // 応答の控えは時間では捨てない（同じ要求の再送には同じ応答を返す）。
  assert.equal(ram.replay(SEGMENT, 'key-1', 'hash-1').kind, 'same');

  // 本人の時間帯（+09:00）で 23:59 に話し、1 分後の 0:00 に日付が変わると捨てる。
  holdTurn(ram, 2, '2026-10-05T14:59:00Z');
  assert.equal(ram.recent(SEGMENT, '2026-10-05T14:59:59.999Z').length, 2);
  assert.deepEqual(ram.recent(SEGMENT, '2026-10-05T15:00:00Z'), []);
});

test('the replay list keeps 64 requests, answers the same request and refuses a changed one', () => {
  const ram = new PrivateConversationRam({ utcOffset: '+09:00' });
  ram.bind(SEGMENT, T0);
  for (let index = 1; index <= 64; index += 1) holdTurn(ram, index, T0);
  assert.equal(ram.held().replays, 64);
  assert.deepEqual(ram.replay(SEGMENT, 'key-1', 'hash-1'), {
    kind: 'same',
    body: { turn: 1 },
  });
  // 同じ鍵で照合値が違えば conflict。
  assert.deepEqual(ram.replay(SEGMENT, 'key-1', 'other'), {
    kind: 'conflict',
  });
  // 65 件目で最も古い key-1 が落ちる（落ちた要求は新しい要求として処理し直す）。
  holdTurn(ram, 65, T0);
  assert.equal(ram.held().replays, 64);
  assert.deepEqual(ram.replay(SEGMENT, 'key-1', 'hash-1'), { kind: 'none' });
  assert.equal(ram.replay(SEGMENT, 'key-2', 'hash-2').kind, 'same');
  assert.equal(ram.replay(SEGMENT, 'key-65', 'hash-65').kind, 'same');
  // 別の区切りの控えは見えない。
  assert.deepEqual(ram.replay(OTHER, 'key-2', 'hash-2'), { kind: 'none' });
});

test('a discard drops everything and a result that started before it is not held', () => {
  const ram = new PrivateConversationRam({ utcOffset: '+09:00' });
  ram.bind(SEGMENT, T0);
  holdTurn(ram, 1, T0);
  const started = ram.epoch;
  ram.discard('locked');
  assert.deepEqual(ram.held(), {
    replays: 0,
    recent_turns: 0,
    discards: 1,
    last_discard: 'locked',
  });
  // 捨てる前に始めた処理の結果は持たない。
  ram.bind(SEGMENT, T0);
  assert.equal(holdTurn(ram, 2, T0, SEGMENT, started), false);
  assert.equal(ram.held().replays, 0);
  // 捨てた後に始めた処理は持てる。
  assert.equal(holdTurn(ram, 3, T0), true);
  assert.equal(ram.held().replays, 1);
});

test('binding to another private segment drops the previous contents, and a result for the old segment is refused', () => {
  const ram = new PrivateConversationRam({ utcOffset: '+09:00' });
  ram.bind(SEGMENT, T0);
  holdTurn(ram, 1, T0);
  ram.bind(OTHER, T0);
  assert.deepEqual(ram.held(), {
    replays: 0,
    recent_turns: 0,
    discards: 0,
    last_discard: null,
  });
  assert.deepEqual(ram.recent(SEGMENT, T0), []);
  assert.equal(holdTurn(ram, 2, T0, SEGMENT), false);
  assert.equal(ram.held().replays, 0);
  // 同じ区切りへの bind は中身を変えない。
  holdTurn(ram, 3, T0, OTHER);
  ram.bind(OTHER, T0);
  assert.equal(ram.held().replays, 1);
});
