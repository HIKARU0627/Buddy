// evidence-run.test.mjs が子プロセスで実行する、時間切れの再現用の試験（単独では試験として扱わない）。
// 1 つ目のケースは子試験の期限を過ぎてから、2 つ目のケースの実行中に正常に終わる。結果は OUT のファイルへ書く。
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { collectRuns } from './evidence-run.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slow = Number(process.env.SLOW_MS);
const next = Number(process.env.NEXT_MS);

test('時間切れの再現', async (t) => {
  const result = await collectRuns({
    t,
    cases: [{ id: 'slow' }, { id: 'next' }],
    seeds: [1],
    shuffled: (values) => [...values],
    timeoutMs: Number(process.env.TIMEOUT_MS),
    execute: async (_sub, spec) => {
      await wait(spec.id === 'slow' ? slow : next);
      return { id: spec.id };
    },
    toRun: (spec, seed, order, observed) => ({
      case_id: spec.id,
      seed: String(seed),
      order: order.map((c) => c.id),
      observed,
    }),
  });
  // 遅れて終わったケースが完了した後まで待ってから、結果を書く。
  await wait(slow + 100);
  writeFileSync(
    process.env.OUT,
    JSON.stringify({
      runs: result.runs.map((run) => run.case_id),
      failed: result.failed,
      complete: result.complete,
    }),
  );
});
