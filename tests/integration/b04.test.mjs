// 全ケースを同じ入口から、固定 seed・異なる順序で反復する。件数は期待値から作らず実観測を保存する。
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform, release } from 'node:os';
import { specification, shuffled } from './b04-support.mjs';
import { runCase } from './b04-cases.mjs';
import { b04SourceSha256 } from '../../scripts/b04-evidence-sources.mjs';

const cases = [...specification.cases, ...specification.qa_cases];
const ids = cases.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length);

test(
  'B04-06・07: 全故障点・下書きの保存の故障・QA27 の 3 経路と権限・期限・QA28 を固定 seed で反復照合する',
  { timeout: 300000 },
  async (t) => {
    const runs = [];
    let failed = false;
    for (const [round, seed] of specification.seeds.entries()) {
      const order = shuffled(cases, seed);
      for (const spec of order) {
        await t.test(
          `${spec.id} / seed=${seed}`,
          { timeout: 45000 },
          async (sub) => {
            try {
              const observed = await runCase(sub, spec, seed, round);
              runs.push({
                case_id: spec.id,
                seed: String(seed),
                order: order.map((c) => c.id),
                faults: spec.b04_faults ?? spec.faults ?? [],
                observed,
              });
            } catch (error) {
              failed = true;
              throw error;
            }
          },
        );
      }
    }
    // 通常の CI では書き出さない。全反復の成功時だけ、指定された出力先へ証拠を作る。
    // 子試験の時間切れ・取り消しは catch を通らないので、case と seed のすべての組が実際に完了したことも確かめる
    // （欠けた実行があれば、前の証拠を今回の成功として上書きしない）。
    const finished = new Set(runs.map((run) => `${run.case_id}/${run.seed}`));
    const complete =
      runs.length === cases.length * specification.seeds.length &&
      finished.size === runs.length &&
      cases.every((spec) =>
        specification.seeds.every((seed) => finished.has(`${spec.id}/${seed}`)),
      );
    if (process.env.BUDDY_B04_EVIDENCE_PATH && !failed)
      assert(
        complete,
        '時間切れ・取り消しなどで完了していない実行があるため、証拠を保存しません',
      );
    if (process.env.BUDDY_B04_EVIDENCE_PATH && !failed && complete) {
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      const sourceSha256 = b04SourceSha256();
      const observedAt = new Date().toISOString();
      const records = cases.map((spec) => {
        const run = runs.find((r) => r.case_id === spec.id);
        const o = run.observed;
        const partial = spec.id.startsWith('X10');
        return {
          case_id: partial ? `B04-${spec.id.toLowerCase()}-mechanism` : spec.id,
          kind: 'simulated',
          commit,
          contract_version: '1.0.0',
          db_version: o.db_version,
          environment: {
            os: `${platform()} ${release()} / ${process.version}`,
            hub: '同一プロセスの Core・独立した一時 DB・loopback HTTPS と模擬 provider HTTP',
            devices: [
              '2 個の模擬端末（X02）・製品クライアントの TLS/WSS（X02・X11）。Electron 未起動',
            ],
          },
          seed: specification.seeds.join(','),
          fault_point: (spec.b04_faults ?? spec.faults ?? []).join(',') || null,
          provider_requests: o.provider_requests,
          provider_state_changes: o.provider_state_changes,
          approvals: o.approval_count,
          final_state: o.final_state,
          observed_at: observedAt,
          deviation: partial
            ? spec.b04_expected.scope
            : spec.id.startsWith('QA27')
              ? 'Core の API で確認。同じ画面からの 3 経路はデスクトップの main の部品の試験（two-clients.test.ts）で別に確認。Electron の画面と本物の OS 確認ダイアログは未実施。'
              : null,
          voice_stop_ms: null,
          outcome: 'matched_expectation',
        };
      });
      const evidence = {
        status: 'recorded',
        description:
          'B04-06・07 の模擬結果。commit は実行時の基点、source_sha256 は未コミット差分を含む検査対象の正確な内容。X10 は工程の仕組みだけ（B14 で縦断合格）。QA27 は外部の下書きの保存を含む 3 経路と全経路の権限・期限を Core の API で確認。実機・実 API・実請求・handoff・Electron の画面は未実施。',
        command: 'node --test tests/integration/b04.test.mjs',
        source_sha256: sourceSha256,
        records,
        runs,
      };
      writeFileSync(
        process.env.BUDDY_B04_EVIDENCE_PATH,
        JSON.stringify(evidence, null, 2) + '\n',
      );
    }
  },
);
