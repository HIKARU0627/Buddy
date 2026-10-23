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

test('時間内に終わった全ケースは成功に数え、完了として扱う', () => {
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
  });
});

test('時間切れの後、次のケースの実行中に遅れて正常に終わった結果は、成功に数えず、証拠を保存しない', () => {
  // slow は子試験の期限（200ms）を過ぎた 500ms で終わる。next は 200ms 以降に始まり、期限内の 50ms で終わる。
  // slow は next の実行中に正常に終わるが、runs に足されない。
  const { status, result } = runFixture({
    TIMEOUT_MS: '200',
    SLOW_MS: '500',
    NEXT_MS: '50',
  });
  assert.notEqual(status, 0);
  assert.deepEqual(result.runs, ['next']);
  assert.equal(result.failed, true);
  assert.equal(result.complete, false);
});

test('保存の判定: 指定がなければ保存せず、失敗なら保存せず、未完了なら試験を失敗させ、完了なら保存する', () => {
  assert.equal(
    shouldWriteEvidence(undefined, { failed: false, complete: true }),
    false,
  );
  assert.equal(
    shouldWriteEvidence('out.json', { failed: true, complete: false }),
    false,
  );
  assert.throws(
    () => shouldWriteEvidence('out.json', { failed: false, complete: false }),
    /証拠を保存しません/u,
  );
  assert.equal(
    shouldWriteEvidence('out.json', { failed: false, complete: true }),
    true,
  );
});
