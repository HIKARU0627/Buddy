import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

// 模擬証拠の freshness は、読み取りだけの専用シグナル（ADR 0085）。
// 必須チェック・書き込み・PR の自動作成を持たないことを、workflow の構造で確かめる。
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

test('main の push は生成せず、コミット済みの証拠を照合して summary に出す', () => {
  const job = workflow.jobs.identity;
  assert.equal(job.if, "github.event_name == 'push'");
  assert.equal(job['runs-on'], 'ubuntu-latest');
  const check = byName(job, 'Check committed evidence');
  assert.equal(check.run, 'pnpm run evidence:check');
  assert.equal(check['continue-on-error'], true);
  const summary = byName(job, 'Write freshness summary');
  assert.equal(summary.if, 'always()');
  assert.match(summary.run, /GITHUB_STEP_SUMMARY/u);
  const fail = byName(job, 'Fail when stale');
  assert.equal(fail.if, "steps.check.outcome == 'failure'");
});

test('schedule / workflow_dispatch は macOS の既存実行器で生成し、artifact に残す', () => {
  const job = workflow.jobs.generate;
  assert.equal(job.if, "github.event_name != 'push'");
  assert.equal(job['runs-on'], 'macos-latest');
  const generate = byName(job, 'Generate B04 and B07 evidence');
  assert.equal(
    generate.env.BUDDY_B04_EVIDENCE_PATH,
    'tests/integration/evidence-b04-simulated.json',
  );
  assert.equal(
    generate.env.BUDDY_B07_EVIDENCE_PATH,
    'tests/integration/evidence-b07-simulated.json',
  );
  assert.match(generate.run, /b04\.test\.mjs/u);
  assert.match(generate.run, /b07\.test\.mjs/u);
  const upload = byName(job, 'Upload generated evidence');
  assert.equal(
    upload.uses,
    'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  );
  assert.equal(upload.if, "steps.generate.outcome == 'success'");
  assert.equal(upload.with['if-no-files-found'], 'error');
  const check = byName(job, 'Compare generated evidence with the source');
  assert.equal(check.run, 'pnpm run evidence:check');
  assert.equal(check['continue-on-error'], true);
  const summary = byName(job, 'Write freshness summary');
  assert.equal(summary.if, 'always()');
  assert.match(summary.run, /GITHUB_STEP_SUMMARY/u);
  assert.match(summary.run, /simulated-evidence-freshness/u);
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
