// B05 の全ケースを同じ入口から、固定 seed・異なる順序で反復する。件数は期待値から作らず実観測を数える。
// 端末（VoiceController・DesktopDeviceController・模擬の音声レンダラー・合成の PCM）と中枢（VoiceControl・DB worker・
// 予算の門・模擬の Live の provider・会話の処理）を 1 本の手で進める時計でつないだ模擬の統合試験で、実機・実 API・実請求は
// 含まない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform, release } from 'node:os';
import { specification, shuffled } from './b05-support.mjs';
import { collectRuns, shouldWriteEvidence } from './evidence-run.mjs';
import { caseIds, runCase } from './b05-cases.mjs';
import { b05SourceSha256 } from '../../scripts/b05-evidence-sources.mjs';

const cases = specification.cases;
const ids = cases.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length);
assert.deepEqual(
  [...ids].sort(),
  [...caseIds()].sort(),
  '手書きの期待値とケースの実装の ID が一致する',
);

const DEVIATION =
  '模擬の音声（合成の PCM）・台本の模擬 Live・手で進める時計と故障の注入による試験。実機・実 API・実請求は未実施（#132・#133）。マイク・WebRTC・Electron・HTTP と WSS の経路は通さない。時間の値（voice_stop_ms など）は手で進める時計の模擬で、T04 の実測ではない。';

test(
  'B05-07: X13・X25・X30・X49・X51・X58・X27・QA24・QA41・QA43 の音声の停止・世代・再開・入力の確定を固定 seed で反復照合する',
  { timeout: 900000 },
  async (t) => {
    // 子試験の時間切れ・取り消しの後に遅れて終わった結果は、成功に数えない（evidence-run.mjs）。
    // 保存は親の t.after() で行う。親が時間切れ・取り消しで本体が最後まで進まない場合も、後始末の後に判定するため、
    // 集計の前に登録する（結果がなければ保存しない）。
    let result = null;
    t.after(() => writeEvidence());
    result = await collectRuns({
      t,
      cases,
      seeds: specification.seeds,
      shuffled,
      timeoutMs: 120000,
      parentTimeoutMs: 900000,
      execute: (sub, spec, seed, round) => runCase(spec, seed, round),
      toRun: (spec, seed, order, observed) => ({
        case_id: spec.id,
        seed: String(seed),
        order: order.map((c) => c.id),
        faults: spec.faults,
        observed,
      }),
    });
    assert.equal(result.failed, false);
    assert.equal(result.complete, true);

    function writeEvidence() {
      if (result === null) return;
      const { runs } = result;
      // 通常の CI では書き出さない。全反復が時間内に成功し、case と seed のすべての組がそろったときだけ、証拠を作る。
      if (shouldWriteEvidence(process.env.BUDDY_B05_EVIDENCE_PATH, result, t)) {
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
        const sourceSha256 = b05SourceSha256();
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
              hub: '同一プロセスの中枢の音声の制御（VoiceControl・一時ディレクトリの DB と DB worker・予算の門・模擬の Live の provider・会話の処理）と、端末の音声の制御（VoiceController・DesktopDeviceController・模擬の音声レンダラー）を、手で進める 1 本の時計でつないだ（HTTP・WSS・Electron は通さない）',
              devices: [],
            },
            seed: specification.seeds.join(','),
            fault_point: spec.faults.join(',') || null,
            provider_requests: o.provider_requests,
            provider_state_changes: o.provider_state_changes,
            approvals: o.approvals,
            final_state: o.final_state,
            observed_at: observedAt,
            deviation: spec.deviation_note
              ? `${DEVIATION} ${spec.deviation_note}`
              : DEVIATION,
            voice_stop_ms: o.voice_stop_ms ?? null,
            outcome: 'matched_expectation',
          };
        });
        const evidence = {
          status: 'recorded',
          description:
            'B05-07 の模擬結果。commit は実行時の基点、source_sha256 は未コミット差分を含む検査対象の正確な内容。端末の音声の制御・模擬の音声レンダラー・中枢の音声の制御・DB worker・予算の門・模擬の Live の provider・会話の処理をつないだ統合で、端末が音声レンダラーへ送った命令・音声レンダラーの状態・Core の Live と予約の行・provider 自身の真の使用時間を突き合わせた。実機・実 API・実請求は未実施（#132・#133）。U120（文字の結果・破棄の知らせの画面配信）は UI-08 の別 PR で未了。',
          command: 'node --test tests/integration/b05.test.mjs',
          source_sha256: sourceSha256,
          records,
          runs,
        };
        writeFileSync(
          process.env.BUDDY_B05_EVIDENCE_PATH,
          JSON.stringify(evidence, null, 2) + '\n',
        );
      }
    }
  },
);
