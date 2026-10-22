import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  startRig,
  startCore,
  session,
  createOperation,
  approveOperation,
  LABEL,
} from '../../apps/core/dist/operation-runner-test-support.js';
import {
  installHistory,
  observe,
  specification,
  until,
} from './b04-support.mjs';

test('B04 の照合は回数が同じでも外部変更の内容や真の状態が違えば拒否する', async (t) => {
  const rig = await startRig(t);
  const core = await startCore(t, rig);
  installHistory(core);
  const who = await session(core);
  const id = await createOperation(core, who, LABEL);
  await approveOperation(core, who, id);
  const expected = specification.cases.find((c) => c.id === 'X01').expected;
  await observe(core, rig, id, expected);

  for (const [name, mutate] of [
    [
      '対象の取り違え',
      (receipts) => {
        receipts[0].applied_change.remote_id = 'mail-other';
      },
    ],
    [
      '追加ラベルの取り違え',
      (receipts) => {
        receipts[0].applied_change.add = ['wrong-label'];
      },
    ],
    [
      '余分なラベルの削除',
      (receipts) => {
        receipts[0].applied_change.remove = ['INBOX'];
      },
    ],
    [
      '受信記録の最終ラベルの違い',
      (receipts) => {
        receipts[0].applied_change.labels_after = ['wrong-label'];
      },
    ],
    [
      '記録が正しくても真の状態が違う',
      (_receipts, snapshot) => {
        snapshot.mails['mail-001'].labels = ['wrong-label'];
      },
    ],
    [
      '記録と真の状態が同じ誤変更',
      (receipts, snapshot) => {
        receipts[0].applied_change.add = ['wrong-label'];
        receipts[0].applied_change.labels_after = ['wrong-label'];
        snapshot.mails['mail-001'].labels = ['wrong-label'];
      },
    ],
  ]) {
    await t.test(name, async () => {
      const receipts = rig.provider.truth.receipts();
      const snapshot = rig.provider.truth.snapshot();
      mutate(receipts, snapshot);
      const wrongRig = {
        provider: {
          truth: {
            ...rig.provider.truth,
            receipts: () => receipts,
            snapshot: () => snapshot,
          },
        },
      };
      await assert.rejects(observe(core, wrongRig, id, expected), {
        code: 'ERR_ASSERTION',
      });
    });
  }
});

test('イベント待機は到達と predicate の例外で終了する', async (t) => {
  let calls = 0;
  await until(t, () => ++calls === 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  await assert.rejects(
    until(t, () => {
      throw new Error('合成の失敗');
    }),
    /合成の失敗/u,
  );
});

for (const [name, body] of [
  [
    '時間切れ',
    `await assert.rejects(until(t, () => false, 20), /timeout: イベントの到達/u);`,
  ],
  [
    '試験終了',
    `const stopped = assert.rejects(until(t, () => false, 60000), /イベントの待機を中止/u); t.after(() => stopped);`,
  ],
]) {
  test(`イベント待機は${name}で子プロセスを残さない`, () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import test from 'node:test';
      import { until } from ${JSON.stringify(new URL('./b04-support.mjs', import.meta.url).href)};
      await test('イベント待機の終了', async (t) => { ${body} });
      console.log('待機終了');
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    // 明示的な process.exit は使わず、参照された timer / immediate が残れば親側で失敗させる。
    assert.equal(child.error, undefined, child.stderr);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /待機終了/u);
  });
}
