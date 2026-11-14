import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMENTARY_MAX_PARTS,
  COMMENTARY_PART_MAX_CHARS,
  COMMENTARY_TEMPLATE_VERSION,
  acceptedCommentary,
  backgroundCommentary,
  bridgeCommentary,
  completionCommentary,
  fitCommentary,
  inputCommentary,
  resultCommentary,
  withOverflowNotice,
} from '../packages/domain/dist/index.js';

// B10-04 P2b（ADR 0107）: 声で返す定型文（つなぎ・背景化・受付・完了・追記の上限）の手書きの検査。
// 期待値は設計 10 §5 に書かれた言い回しを手で書いた文字列で、domain の実装から作らない。
// 実音声・実 API は使わない。
const parts = (commentary) => commentary.commentary_parts;

test('commentary: the bridge, the background move and the accepted notice are the fixed sentences, each with one fact-free part', () => {
  assert.equal(COMMENTARY_TEMPLATE_VERSION, '1');
  assert.deepEqual(parts(bridgeCommentary()), ['確認しますね。']);
  assert.deepEqual(parts(backgroundCommentary()), [
    '少し時間がかかるので、できたら知らせます。',
  ]);
  assert.deepEqual(parts(acceptedCommentary()), [
    '受け付けました。終わったら知らせます。',
  ]);
  assert.equal(bridgeCommentary().template_id, 'bridge.checking');
  assert.equal(backgroundCommentary().template_id, 'background.moved');
  assert.equal(acceptedCommentary().template_id, 'accepted.background');
  for (const commentary of [
    bridgeCommentary(),
    backgroundCommentary(),
    acceptedCommentary(),
  ]) {
    assert.equal(commentary.template_version, '1');
    assert.equal(commentary.facts.length, 1);
    assert.equal(commentary.facts[0].ref_id, null);
    assert.equal(commentary.facts[0].title, null);
  }
});

test('commentary: completion is told only when the execution is confirmed (executed is exactly true), otherwise it points to the screen', () => {
  const expected = {
    task_created: '用事を登録しました。',
    note_created: 'メモを残しました。',
    event_created: '予定を登録しました。',
    label_applied: 'ラベルを付けました。',
    draft_saved: '下書きを保存しました。',
  };
  for (const [kind, sentence] of Object.entries(expected)) {
    const done = completionCommentary({ kind, executed: true });
    assert.deepEqual(parts(done), [sentence], kind);
    assert.equal(done.template_id, 'completion.done', kind);
    // 実行を確認できていない・確認の値が true でないときは、完了を告げない。
    for (const executed of [false, undefined, null, 1, 'true']) {
      const pending = completionCommentary({ kind, executed });
      assert.deepEqual(parts(pending), ['画面で確認してください。'], kind);
      assert.equal(pending.template_id, 'review.screen', kind);
    }
  }
});

test('commentary: no sentence other than the confirmed completion says that something was done', () => {
  const doneWords = ['しました。', 'ました。'];
  const sentences = [
    ...parts(bridgeCommentary()),
    ...parts(backgroundCommentary()),
    ...parts(
      resultCommentary({
        kind: 'approval_link',
        event_count: 0,
        overlap: false,
        more_count: 0,
        clarification_text: null,
      }),
    ),
    ...parts(inputCommentary('hold_dropped')),
    ...parts(inputCommentary('say_again')),
    ...parts(inputCommentary('full_text')),
  ];
  // 「受け付けました」は受付の事実で、実行の完了ではない（下で別に確かめる）。
  for (const sentence of sentences)
    for (const word of doneWords) assert.ok(!sentence.endsWith(word), sentence);
  assert.deepEqual(parts(acceptedCommentary()), [
    '受け付けました。終わったら知らせます。',
  ]);
});

test('commentary: the rest of a schedule list says "put on the screen" only when it was placed', () => {
  const base = {
    kind: 'schedule_cards',
    event_count: 3,
    overlap: false,
    more_count: 4,
    clarification_text: null,
  };
  assert.deepEqual(parts(resultCommentary(base)), [
    '予定は3件です。',
    'ほかに4件あります。',
  ]);
  assert.deepEqual(
    parts(resultCommentary({ ...base, more_on_screen: false })),
    ['予定は3件です。', 'ほかに4件あります。'],
  );
  assert.deepEqual(parts(resultCommentary({ ...base, more_on_screen: true })), [
    '予定は3件です。',
    'ほかに4件。画面に出しました。',
  ]);
  // 残りがなければ、置いたかどうかに関係なく画面の案内は付かない。
  assert.deepEqual(
    parts(resultCommentary({ ...base, more_count: 0, more_on_screen: true })),
    ['予定は3件です。'],
  );
});

test('commentary: the limits are 3 parts and 200 characters, and what is over is not cut but sent to the screen', () => {
  assert.equal(COMMENTARY_MAX_PARTS, 3);
  assert.equal(COMMENTARY_PART_MAX_CHARS, 200);
  const make = (...texts) => ({
    template_id: 'result.screen',
    template_version: '1',
    facts: [],
    commentary_parts: texts,
  });
  assert.deepEqual(fitCommentary(make('あ', 'い', 'う')), {
    parts: ['あ', 'い', 'う'],
    overflow: false,
  });
  // 4 つ目以降は声に載せず、超えた分があったことを返す。
  assert.deepEqual(fitCommentary(make('あ', 'い', 'う', 'え', 'お')), {
    parts: ['あ', 'い', 'う'],
    overflow: true,
  });
  // 200 文字ちょうどは載せ、201 文字は切らずに載せない（コードポイントで数える）。
  assert.equal(fitCommentary(make('あ'.repeat(200))).overflow, false);
  assert.deepEqual(fitCommentary(make('あ'.repeat(201), '後ろ')), {
    parts: ['後ろ'],
    overflow: true,
  });
  assert.equal(fitCommentary(make('😀'.repeat(200))).overflow, false);
  assert.equal(fitCommentary(make('😀'.repeat(201))).overflow, true);
  // 空の部分は載せず、超えた分とは数えない。
  assert.deepEqual(fitCommentary(make('', 'あ')), {
    parts: ['あ'],
    overflow: false,
  });
  // 載せられる部分が 1 つもないときは空（呼び出し側が画面へ回す）。
  assert.deepEqual(fitCommentary(make('あ'.repeat(201))), {
    parts: [],
    overflow: true,
  });
});

test('commentary: the overflow notice is added without ever exceeding 3 parts', () => {
  assert.deepEqual(withOverflowNotice([]), ['ほかは画面に出しました。']);
  assert.deepEqual(withOverflowNotice(['あ']), [
    'あ',
    'ほかは画面に出しました。',
  ]);
  assert.deepEqual(withOverflowNotice(['あ', 'い']), [
    'あ',
    'い',
    'ほかは画面に出しました。',
  ]);
  // 満杯のときは、最後の部分を案内に置き換える（3 部を超えない）。
  assert.deepEqual(withOverflowNotice(['あ', 'い', 'う']), [
    'あ',
    'い',
    'ほかは画面に出しました。',
  ]);
});
