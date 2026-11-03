import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

// 模擬証拠の freshness は、読み取りだけの専用シグナル（ADR 0085）。
// 生成・必須チェック・書き込み・PR の自動作成を持たないことを、workflow の構造で確かめる。
const workflow = parse(
  await readFile(
    new URL('../.github/workflows/evidence-freshness.yml', import.meta.url),
    'utf8',
  ),
);

const steps = (job) => job.steps;
const byName = (job, name) => steps(job).find((step) => step.name === name);

test('freshness は main の push・週 1 回の schedule・手動で動き、読み取りだけである', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  assert.equal(workflow.on.schedule.length, 1);
  assert.match(workflow.on.schedule[0].cron, /^\S+ \S+ \S+ \S+ \S+$/u);
  assert.ok('workflow_dispatch' in workflow.on);
  assert.equal(workflow.on.pull_request_target, undefined);
  const text = JSON.stringify(workflow);
  assert(!/contents:\s*write/u.test(text));
  assert(!/pull-requests/u.test(text));
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.permissions, undefined);
  }
});

test('1 つの job がコミット済みの証拠を照合し、macOS の生成 job を追加しない', () => {
  assert.deepEqual(Object.keys(workflow.jobs), ['identity']);
  const job = workflow.jobs.identity;
  assert.equal(job.name, 'Identity (committed evidence)');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job.env, undefined);
  const check = byName(job, 'Check committed evidence');
  assert.equal(check.run, 'pnpm run evidence:check');
  assert.equal(check['continue-on-error'], true);
  // 生成・artifact・macOS runner を持たない。
  const text = JSON.stringify(workflow);
  for (const forbidden of [
    /macos-latest/u,
    /upload-artifact/u,
    /BUDDY_B04_EVIDENCE_PATH/u,
    /BUDDY_B07_EVIDENCE_PATH/u,
    /b04\.test\.mjs/u,
    /b07\.test\.mjs/u,
  ])
    assert(!forbidden.test(text), String(forbidden));
});

test('不一致は summary に手順を出し、job を失敗にする（必須チェックではない）', () => {
  const job = workflow.jobs.identity;
  const summary = byName(job, 'Write freshness summary');
  assert.equal(summary.if, 'always()');
  assert.equal(summary.env.CHECK_OUTCOME, '${{ steps.check.outcome }}');
  assert.match(summary.run, /GITHUB_STEP_SUMMARY/u);
  assert.match(summary.run, /stale/u);
  assert.match(summary.run, /simulated-evidence-b04-<sha>/u);
  assert.match(summary.run, /Simulated evidence \(macOS\)/u);
  assert.match(summary.run, /PR を作る/u);
  const fail = byName(job, 'Fail when stale');
  assert.equal(fail.if, "steps.check.outcome == 'failure'");
});

test('freshness は commit・push・PR の作成をしない', () => {
  const text = JSON.stringify(workflow);
  for (const forbidden of [
    /git push/u,
    /git commit/u,
    /gh pr create/u,
    /pull_request_target/u,
    /contents:\s*write/u,
  ])
    assert(!forbidden.test(text), String(forbidden));
});
