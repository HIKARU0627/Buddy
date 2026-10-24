// 統合の実行器の共通の部品（evidence-run.mjs）の回帰試験。B04・B07 の両方の実行器が使う。
// node:test の子試験が時間切れになった後に、本体が遅れて正常に終わっても、その結果を成功に数えず、
// 証拠を保存しないことを、実際の node:test を子プロセスで動かして確かめる（Codex のレビュー P2）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { shouldWriteEvidence } from './evidence-run.mjs';

const fixture = fileURLToPath(
  new URL('./evidence-run-fixture.mjs', import.meta.url),
);

function runFixture(env) {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-evidence-run-'));
  try {
    const out = join(directory, 'result.json');
    const child = spawnSync(process.execPath, ['--test', fixture], {
      // 親の node:test の文脈を引き継がない（子が独立した試験の実行として動くように）。
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...env, OUT: out },
      encoding: 'utf8',
    });
    return {
      status: child.status,
      result: JSON.parse(readFileSync(out, 'utf8')),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('時間内に終わった全ケースは成功に数え、完了として保存の判定が通る', () => {
  const { status, result } = runFixture({
    TIMEOUT_MS: '2000',
    SLOW_MS: '20',
    NEXT_MS: '20',
  });
  assert.equal(status, 0);
  assert.deepEqual(result, {
    runs: ['slow', 'next'],
    failed: false,
    complete: true,
    decision: true,
    overlap: false,
  });
});

test('時間切れの後、次のケースの実行中に遅れて正常に終わった結果は、成功に数えず、証拠を保存しない', () => {
  // slow は子試験の期限（400ms）を過ぎた 600ms で終わる。next は 400ms 以降に始まり、期限内の 350ms で終わるので、
  // 約 400〜750ms の間に実行される。slow の終了（600ms）は next の実行中に重なり、正常に終わるが、runs に足されない。
  const { status, result } = runFixture({
    TIMEOUT_MS: '400',
    SLOW_MS: '600',
    NEXT_MS: '350',
  });
  assert.equal(
    result.overlap,
    true,
    'slow の終了が next の実行中に重なっていない',
  );
  assert.notEqual(status, 0);
  assert.deepEqual(result.runs, ['next']);
  assert.equal(result.failed, true);
  assert.equal(result.complete, false);
  assert.equal(result.decision, false);
});

test('最後のケースの後始末が親の期限を過ぎても、証拠を保存しない（保存の判定が拒否する）', () => {
  // 全ケースは時間内に成功するが、親の後始末が 800ms かかり、親の期限（300ms）を過ぎる。
  const { result } = runFixture({
    TIMEOUT_MS: '2000',
    SLOW_MS: '20',
    NEXT_MS: '20',
    PARENT_AFTER_MS: '800',
    PARENT_TIMEOUT_MS: '300',
  });
  assert.deepEqual(result.runs, ['slow', 'next']);
  assert.equal(result.complete, true);
  assert.equal(result.decision, 'rejected');
});

test('最後のケースの子試験の後始末の途中で親が時間切れになっても、証拠を保存しない', () => {
  // 最後のケースの後始末（子試験の t.after()）が 800ms かかり、親の期限（300ms）の途中で親と子が取り消される。
  const { status, result } = runFixture({
    TIMEOUT_MS: '2000',
    SLOW_MS: '20',
    NEXT_MS: '20',
    AFTER_MS: '800',
    PARENT_TIMEOUT_MS: '300',
  });
  assert.notEqual(status, 0);
  assert.notEqual(result.decision, true);
  assert.equal(result.complete === true && result.decision === true, false);
});

test('保存の判定: 指定がなければ保存せず、失敗・親の中断なら保存せず、未完了・期限超過なら試験を失敗させ、完了なら保存する', () => {
  const ok = { failed: false, complete: true, deadlineAt: null };
  assert.equal(shouldWriteEvidence(undefined, ok), false);
  assert.equal(
    shouldWriteEvidence('out.json', { ...ok, failed: true, complete: false }),
    false,
  );
  assert.throws(
    () => shouldWriteEvidence('out.json', { ...ok, complete: false }),
    /証拠を保存しません/u,
  );
  assert.equal(shouldWriteEvidence('out.json', ok), true);
  // 親の試験が中断されていれば保存しない。
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    shouldWriteEvidence('out.json', ok, { signal: aborted.signal }),
    false,
  );
  assert.equal(
    shouldWriteEvidence('out.json', ok, {
      signal: new AbortController().signal,
    }),
    true,
  );
  // 親の期限を過ぎていれば（後始末の途中を含む）保存せず、試験を失敗させる。
  assert.throws(
    () =>
      shouldWriteEvidence('out.json', { ...ok, deadlineAt: Date.now() - 1 }),
    /親の試験の期限を過ぎた/u,
  );
  assert.equal(
    shouldWriteEvidence('out.json', { ...ok, deadlineAt: Date.now() + 60000 }),
    true,
  );
});
