// evidence-run.test.mjs が子プロセスで実行する、時間切れの再現用の試験（単独では試験として扱わない）。
// 結果は OUT のファイルへ書く。
// - 子試験の時間切れ: 1 つ目のケース（slow）が期限を過ぎてから、2 つ目のケース（next）の実行中に正常に終わる。
//   重なったこと（slow の終了が next の開始と終了の間）も記録する。
// - 親の時間切れ: AFTER_MS を指定すると、最後のケースの後始末（子試験の t.after()）が長引き、親の試験が時間切れになる。
//   保存の判定は、本番の実行器と同じく親の t.after() の中で行う。
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { collectRuns, shouldWriteEvidence } from './evidence-run.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slow = Number(process.env.SLOW_MS);
const next = Number(process.env.NEXT_MS);
const afterMs = Number(process.env.AFTER_MS ?? 0);
const parentAfterMs = Number(process.env.PARENT_AFTER_MS ?? 0);
const parentTimeout = process.env.PARENT_TIMEOUT_MS
  ? Number(process.env.PARENT_TIMEOUT_MS)
  : undefined;

test('時間切れの再現', { timeout: parentTimeout }, async (t) => {
  const clock = {};
  let result = null;
  // 親の後始末（長引くと親の試験が時間切れになる）。保存の判定より先に登録する。
  if (parentAfterMs > 0) t.after(() => wait(parentAfterMs));
  // 本番の実行器と同じく、親の t.after() は集計の前に登録する（親が時間切れ・取り消しになって本体が最後まで進まなくても、
  // 後始末の後に必ず判定する）。結果がなければ保存しない。
  t.after(async () => {
    await wait(slow + 100);
    let decision = 'no_result';
    if (result !== null) {
      try {
        decision = shouldWriteEvidence('evidence.json', result, t);
      } catch {
        decision = 'rejected';
      }
    }
    writeFileSync(
      process.env.OUT,
      JSON.stringify({
        runs: result?.runs.map((run) => run.case_id) ?? null,
        failed: result?.failed ?? null,
        complete: result?.complete ?? null,
        decision,
        overlap:
          clock.slow_end > clock.next_start && clock.slow_end < clock.next_end,
      }),
    );
  });
  result = await collectRuns({
    t,
    cases: [{ id: 'slow' }, { id: 'next' }],
    seeds: [1],
    shuffled: (values) => [...values],
    timeoutMs: Number(process.env.TIMEOUT_MS),
    parentTimeoutMs: parentTimeout,
    execute: async (sub, spec) => {
      clock[`${spec.id}_start`] = Date.now();
      if (spec.id === 'next' && afterMs > 0) sub.after(() => wait(afterMs));
      await wait(spec.id === 'slow' ? slow : next);
      clock[`${spec.id}_end`] = Date.now();
      return { id: spec.id };
    },
    toRun: (spec, seed, order, observed) => ({
      case_id: spec.id,
      seed: String(seed),
      order: order.map((c) => c.id),
      observed,
    }),
  });
});
