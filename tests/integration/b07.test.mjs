// B07 の全ケースを同じ入口から、固定 seed・異なる順序で反復する。件数は期待値から作らず実観測を保存する。
// 予算の門・DB worker・模擬の有料 provider をつないだ模擬の統合試験で、実 API・実請求・実機は含まない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform, release } from 'node:os';
import { specification, shuffled } from './b07-support.mjs';
import { collectRuns, shouldWriteEvidence } from './evidence-run.mjs';
import { runCase } from './b07-cases.mjs';
import { b07SourceSha256 } from '../../scripts/b07-evidence-sources.mjs';

const cases = specification.cases;
const ids = cases.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length);

test(
  'B07-06: X18・QA42・QA20・X53 と同時予約・月替わり・失敗・精算の重複を固定 seed で反復照合する',
  { timeout: 600000 },
  async (t) => {
    // 子試験の時間切れ・取り消しの後に遅れて終わった結果は、成功に数えない（evidence-run.mjs）。
    const result = await collectRuns({
      t,
      cases,
      seeds: specification.seeds,
      shuffled,
      timeoutMs: 60000,
      execute: (sub, spec, seed, round) => runCase(spec, seed, round),
      toRun: (spec, seed, order, observed) => ({
        case_id: spec.id,
        seed: String(seed),
        order: order.map((c) => c.id),
        faults: spec.faults,
        observed,
      }),
    });
    const { runs } = result;
    // 通常の CI では書き出さない。全反復が時間内に成功し、case と seed のすべての組がそろったときだけ、証拠を作る。
    if (shouldWriteEvidence(process.env.BUDDY_B07_EVIDENCE_PATH, result)) {
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      const sourceSha256 = b07SourceSha256();
      const observedAt = new Date().toISOString();
      const records = cases.map((spec) => {
        const run = runs.find((r) => r.case_id === spec.id);
        const o = run.observed;
        return {
          case_id: spec.id,
          kind: 'simulated',
          commit,
          contract_version: '1.0.0',
          db_version: o.db_version,
          environment: {
            os: `${platform()} ${release()} / ${process.version}`,
            hub: '同一プロセスの予算の門・一時ディレクトリの DB と DB worker・同一プロセスの模擬の有料 provider（HTTP の経路は通さない）',
            devices: [],
          },
          seed: specification.seeds.join(','),
          fault_point: spec.faults.join(',') || null,
          provider_requests: o.provider_requests,
          provider_state_changes: o.provider_state_changes,
          approvals: o.approvals,
          final_state: o.final_state,
          observed_at: observedAt,
          deviation:
            '模擬の有料 provider と合成の通貨 XTS による試験。実 API・実請求・実機は未実施で、実請求との照合は B15。HTTP の経路・画面は通さない。',
          voice_stop_ms: null,
          outcome: 'matched_expectation',
        };
      });
      const evidence = {
        status: 'recorded',
        description:
          'B07-06 の模擬結果。commit は実行時の基点、source_sha256 は未コミット差分を含む検査対象の正確な内容。予算の門・DB worker・模擬の有料 provider をつないだ統合で、予約の行（SQL で直接読む）と provider の受信の記録・真の usage を突き合わせた。実 API・実請求・実機・HTTP の経路・画面は未実施。実請求の照合は B15。クレジットの区分（MA03〜MA06）は B07-07。',
        command: 'node --test tests/integration/b07.test.mjs',
        source_sha256: sourceSha256,
        records,
        runs,
      };
      writeFileSync(
        process.env.BUDDY_B07_EVIDENCE_PATH,
        JSON.stringify(evidence, null, 2) + '\n',
      );
    }
  },
);
