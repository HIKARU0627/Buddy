// 中枢の画面の操作の失敗の文言（ペアリングの開始の結果が分からないとき。PR #79 のコードレビュー Low-5）。
// 期待値の文言は手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationFailureText } from './hub-state.js';

test(
  'an unknown pairing start asks for a new code instead of refreshing a list',
  { timeout: 10_000 },
  () => {
    const open = operationFailureText(
      {
        channel: 'desktop.pairing_open',
        ref: null,
        name: null,
        verb: 'ペアリングの開始',
      },
      'outcome_unknown',
    );
    assert.equal(
      open,
      '中枢にペアリングの開始が届いたか確かめられませんでした。自動では送り直しません。前のコードは使えなくなっている可能性があります。もう一度コードを出してください。',
    );
    assert.doesNotMatch(open, /一覧を更新/u);
    // 承認・失効は、これまでどおり一覧を更新して確かめてもらう。
    assert.match(
      operationFailureText(
        {
          channel: 'desktop.claim_decide',
          ref: '00000000-0000-4000-8000-000000000e71',
          name: '合成の端末',
          verb: '承認',
        },
        'outcome_unknown',
      ),
      /「一覧を更新」を押して、結果を確かめてください。/u,
    );
  },
);
