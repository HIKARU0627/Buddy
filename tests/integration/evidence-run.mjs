// 統合の実行器（B04・B07）が、全ケース × seed の反復を実行して観測を集める共通の部品。
// 証拠を保存してよいのは、全反復が実際に時間内に成功し、case と seed のすべての組がそろったときだけ。
// node:test の子試験の時間切れ・取り消しは catch を通らず、時間切れの後も本体の処理が動き続けて次のケースの実行中に
// 正常に終わることがある。その遅れて終わった結果は成功に数えず、失敗として扱う（Codex のレビュー P2）。
import assert from 'node:assert/strict';

// execute: (sub, spec, seed, round) => 観測。toRun: (spec, seed, order, observed) => runs の 1 件。
// 戻り値: { runs, failed, complete }。failed は 1 件でも失敗・時間切れ・取り消しがあったこと。
export async function collectRuns({
  t,
  cases,
  seeds,
  shuffled,
  execute,
  toRun,
  timeoutMs,
}) {
  const runs = [];
  let failed = false;
  for (const [round, seed] of seeds.entries()) {
    const order = shuffled(cases, seed);
    for (const spec of order) {
      await t.test(
        `${spec.id} / seed=${seed}`,
        { timeout: timeoutMs },
        async (sub) => {
          // node:test とは別に、自分でも期限を数える（本体が終わる前に期限を過ぎたかどうか）。
          let expired = false;
          const timer = setTimeout(() => {
            expired = true;
            failed = true;
          }, timeoutMs);
          try {
            const observed = await execute(sub, spec, seed, round);
            if (expired || sub.signal?.aborted || t.signal?.aborted) {
              failed = true;
              throw new Error(
                `${spec.id} / seed=${seed}: 時間切れ・取り消しの後に終わった結果は成功に数えません`,
              );
            }
            runs.push(toRun(spec, seed, order, observed));
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            clearTimeout(timer);
          }
        },
      );
    }
  }
  const finished = new Set(runs.map((run) => `${run.case_id}/${run.seed}`));
  const complete =
    !failed &&
    runs.length === cases.length * seeds.length &&
    finished.size === runs.length &&
    cases.every((spec) =>
      seeds.every((seed) => finished.has(`${spec.id}/${seed}`)),
    );
  return { runs, failed, complete };
}

// 証拠を保存してよいか。指定があるのに完了していなければ、試験を失敗させる（前の証拠を今回の成功として上書きしない）。
export function shouldWriteEvidence(path, { failed, complete }) {
  if (!path || failed) return false;
  assert(
    complete,
    '時間切れ・取り消しなどで完了していない実行があるため、証拠を保存しません',
  );
  return true;
}
