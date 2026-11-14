import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_LIVE_TRANSCRIPT,
  LIVE_DELEGATION_WINDOW_MS,
  observeEndCandidate,
  observeFragment,
  observeSpeechStart,
  resolveDelegationTarget,
  resolveDuplicateDelegation,
} from '../packages/domain/dist/index.js';

// B10-04 P1（ADR 0105）: 同じ発話・同じ版への再委譲を、先の依頼と同じものとして見分ける規則の手書きの検査。
// 期待値は domain の実装から作らない。時計は注入した合成の値で、実際の音声・実 API・実機は使わない。
const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';

// 発話 1 つ分の文字起こしを足す（開始 → 断片 → 終了候補）。
function utter(transcript, parts, startMs, indexFrom, at) {
  let next = observeSpeechStart(transcript);
  let start = startMs;
  for (const [position, text] of parts.entries()) {
    next = observeFragment(
      next,
      {
        index: indexFrom + position,
        start_ms: start,
        end_ms: start + 800,
        text,
      },
      at + position * 50,
    );
    start += 800;
  }
  return observeEndCandidate(next);
}

const bind = (ordinal, workflow_id, text) => ({ ordinal, workflow_id, text });

test('duplicate delegation: the same utterance with the same text is the earlier request, and the window is the documented 2 seconds', () => {
  assert.equal(LIVE_DELEGATION_WINDOW_MS, 2000);
  const transcript = utter(
    EMPTY_LIVE_TRANSCRIPT,
    ['今日の予定を教えて'],
    0,
    0,
    10,
  );
  // 先の委譲が対象にしたので、新しい委譲の対象の候補は 0（従来はここで聞き返しになっていた）。
  assert.deepEqual(resolveDelegationTarget(transcript, 800, [1]), {
    count: 0,
    turn: null,
  });
  assert.deepEqual(
    resolveDuplicateDelegation(
      transcript,
      800,
      [bind(1, W1, '今日の予定を教えて')],
      [1],
    ),
    bind(1, W1, '今日の予定を教えて'),
  );
});

test('duplicate delegation: a text that grew or changed is not the same version, so it is not a duplicate', () => {
  const first = utter(
    EMPTY_LIVE_TRANSCRIPT,
    ['明日15時に予定を入れて'],
    0,
    0,
    10,
  );
  const bindings = [bind(1, W1, '明日15時に予定を入れて')];
  assert.notEqual(resolveDuplicateDelegation(first, 800, bindings, [1]), null);
  // 同じ発話に断片が追記された（「…いや16時」）。
  const grown = observeFragment(
    first,
    { index: 1, start_ms: 800, end_ms: 1200, text: 'いや16時' },
    500,
  );
  assert.equal(resolveDuplicateDelegation(grown, 1200, bindings, [1]), null);
});

test('duplicate delegation: a new unclaimed utterance in the window, an unknown offset, an empty window and an unbound turn are not duplicates', () => {
  const first = utter(EMPTY_LIVE_TRANSCRIPT, ['今日の予定を教えて'], 0, 0, 10);
  const bindings = [bind(1, W1, '今日の予定を教えて')];
  // 窓の中に、まだどの委譲も対象にしていない発話がある（別の新しい依頼）。
  const second = utter(first, ['メモして'], 1000, 1, 600);
  assert.equal(resolveDuplicateDelegation(second, 1800, bindings, [1]), null);
  // offset が分からない。
  assert.equal(resolveDuplicateDelegation(first, null, bindings, [1]), null);
  // 窓の中に発話がない（遠い offset）。
  assert.equal(resolveDuplicateDelegation(first, 10000, bindings, [1]), null);
  // 対象にされた連番だけがあり、文字の対応を持たない。
  assert.equal(resolveDuplicateDelegation(first, 800, [], [1]), null);
  // 先の委譲がまだ対象にしていない（claimed が空）。通常の対象の解決に任せる。
  assert.equal(resolveDuplicateDelegation(first, 800, bindings, []), null);
});

test('duplicate delegation: when several earlier utterances are in the window, all must be the same version, and the latest request is returned', () => {
  const first = utter(EMPTY_LIVE_TRANSCRIPT, ['はい'], 0, 0, 10);
  const second = utter(first, ['今日の予定を教えて'], 1000, 1, 600);
  // offset 2300 の窓 [300, 2300] は 2 つの発話に重なる。
  const both = [bind(1, W1, 'はい'), bind(2, W2, '今日の予定を教えて')];
  assert.deepEqual(
    resolveDuplicateDelegation(second, 2300, both, [1, 2]),
    bind(2, W2, '今日の予定を教えて'),
  );
  // 一方の版が変わっていれば、どの依頼の重複とも言えない。
  assert.equal(
    resolveDuplicateDelegation(
      second,
      2300,
      [bind(1, W1, 'いいえ'), bind(2, W2, '今日の予定を教えて')],
      [1, 2],
    ),
    null,
  );
  // 一方が依頼に紐付いていなければ重複と言えない。
  assert.equal(
    resolveDuplicateDelegation(
      second,
      2300,
      [bind(2, W2, '今日の予定を教えて')],
      [1, 2],
    ),
    null,
  );
});
