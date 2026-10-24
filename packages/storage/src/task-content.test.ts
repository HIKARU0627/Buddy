// 用事の平文の形（ADR 0051）。期待値は手で書いた。暗号化・復号は apps/core の移行の試験で確かめる。

import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskContent, taskContentFromIntent } from './task-content.js';

// 孤立したサロゲートの扱いを、ワイヤの TaskOperationIntent の境界に合わせる。
// - JSON Schema の minLength は文字列の長さだけを見るので、Ajv 単体は孤立したサロゲートを通す。
// - しかしワイヤの入力は parseStrictJson（RFC 8785 の正規化の前）が孤立したサロゲートを拒否する
//   （scripts/contracts.test.mjs「raw JSON refuses lone surrogate value」）。
// - 平文を UTF-8 の暗号文にすると Buffer が孤立したサロゲートを U+FFFD に置き換え、内容が変わる。
// そこで task-content も拒否する（ワイヤの入力と同じ扱い。Schema の minLength だけに合わせると、書いた内容と
// 読み戻した内容が変わる）。
test('task content rejects lone surrogates at the same boundary as the strict wire JSON parser', () => {
  for (const text of ['\ud800', 'a\ud800', '\udc00b', 'a\udc00b']) {
    assert.equal(
      isTaskContent({ title: text, due: null, body: null }),
      false,
      JSON.stringify(text),
    );
  }
  // 対になったサロゲート（U+10000）と通常の Unicode は受け付ける。
  assert.equal(isTaskContent({ title: '😀', due: null, body: null }), true);
  assert.equal(
    isTaskContent({ title: '用事', due: '2030-11-02', body: '本文' }),
    true,
  );
  // 期限・本文も同じ規則。
  assert.equal(isTaskContent({ title: 'a', due: '\ud800', body: null }), false);
  assert.equal(isTaskContent({ title: 'a', due: null, body: '\udc00' }), false);
});

test('task contents from an intent use the same lone-surrogate rule', () => {
  const intent = (title: string) => ({
    schema: 'buddy.operation.v1',
    operation_id: '00000000-0000-4000-8000-000000000201',
    content_version: '1',
    permission_revision: '0',
    target: { list_id: 'inbox' },
    action: { kind: 'task.create', title, due: null, body: null },
    effects: { external_recipients: [], reconcile_scope: 'local_transaction' },
  });
  assert.deepEqual(taskContentFromIntent(intent('牛乳を買う')), {
    title: '牛乳を買う',
    due: null,
    body: null,
  });
  assert.equal(taskContentFromIntent(intent('\ud800')), null);
});
