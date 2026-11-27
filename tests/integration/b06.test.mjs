// B06 の全ケースを同じ入口から、固定 seed・異なる順序で反復する（B06-09、Issue #145）。件数は期待値から作らず実観測を保存する。
// 保存期限の掃除・記憶と忘却の命令・忘却の Core の経路（公開ゲートを開いた試験の組み立て）・バックアップと復元・
// 記録しない会話をつないだ模擬の統合試験で、実機の Mac mini・実際のバックアップの置き場所・実 API・実請求は含まない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform, release } from 'node:os';
import { shuffled, specification } from './b06-support.mjs';
import { collectRuns, shouldWriteEvidence } from './evidence-run.mjs';
import { caseIds, runCase } from './b06-cases.mjs';
import { b06SourceSha256 } from '../../scripts/b06-evidence-sources.mjs';

const cases = specification.cases;
const ids = cases.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length);
assert.deepEqual(
  [...ids].sort(),
  [...caseIds()].sort(),
  '手書きの期待値とケースの実装の ID が一致する',
);

const DEVIATION =
  '模擬の試験。合成のデータ鍵・台帳の鍵・バックアップの鍵（模擬の KeyStore）、一時ディレクトリの DB と DB worker、同じプロセスの Core（HTTPS は 127.0.0.1）、模擬の Live の provider を使った。忘却の公開ゲートは製品では閉じたままで、試験の組み立てで開いた関数を渡した。実機の Mac mini での実際のバックアップと鍵の復元・同期フォルダー・SSD の痕跡・実 API・実請求は未実施（B15）。';

test(
  'B06-09: X15・X16・X17・X44・X59 と QA34 の期限・忘却と遅着・古いバックアップ・記録しない会話（記憶の保存の拒否を含む）を固定 seed で反復照合する',
  { timeout: 600000 },
  async (t) => {
    // 子試験の時間切れ・取り消しの後に遅れて終わった結果は、成功に数えない（evidence-run.mjs）。
    // 保存は親の t.after() で行う。親が時間切れ・取り消しで本体が最後まで進まない場合も、後始末の後に判定するため、
    // 集計の前に登録する（結果がなければ保存しない）。
    let result = null;
    // 順序の入れ替えを確かめ終えたか（確かめられなければ、ケースが通っていても証拠を書かない）。
    let ordersObserved = false;
    t.after(() => writeEvidence());
    result = await collectRuns({
      t,
      cases,
      seeds: specification.seeds,
      shuffled,
      timeoutMs: 120000,
      parentTimeoutMs: 600000,
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
    // 忘却と遅着の順序は、seed ごとに入れ替わり、両方の順序（遅着が先・忘却が先）を観測した。
    const variants = new Set(
      result.runs
        .filter((run) => run.case_id === 'X15-forget-and-late-result-order')
        .map((run) => run.observed.variant),
    );
    assert.deepEqual([...variants].sort(), [
      'late_source_after_execute',
      'late_source_before_execute',
    ]);
    ordersObserved = true;

    function writeEvidence() {
      if (result === null || !ordersObserved) return;
      const { runs } = result;
      // 通常の CI では書き出さない。全反復が時間内に成功し、case と seed のすべての組がそろったときだけ、証拠を作る。
      if (shouldWriteEvidence(process.env.BUDDY_B06_EVIDENCE_PATH, result, t)) {
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
        const sourceSha256 = b06SourceSha256();
        const observedAt = new Date().toISOString();
        const records = cases.map((spec) => {
          const caseRuns = runs.filter((r) => r.case_id === spec.id);
          const o = caseRuns[0].observed;
          return {
            case_id: spec.id,
            kind: 'simulated',
            commit,
            contract_version: '1.0.0',
            db_version: o.db_version,
            environment: {
              os: `${platform()} ${release()} / ${process.version}`,
              hub: '同一プロセスの保存期限の掃除・忘却の Core の経路・バックアップと復元・保存境界の保持者（一時ディレクトリの DB と DB worker、HTTPS は 127.0.0.1）と模擬の Live の provider',
              devices: [],
            },
            seed: specification.seeds.join(','),
            fault_point: spec.faults.join(',') || null,
            provider_requests: Math.max(
              ...caseRuns.map((r) => r.observed.provider_requests),
            ),
            provider_state_changes: 0,
            approvals: 0,
            final_state: [
              ...new Set(caseRuns.map((r) => r.observed.final_state)),
            ].join(' | '),
            observed_at: observedAt,
            deviation: DEVIATION,
            voice_stop_ms: null,
            outcome: 'matched_expectation',
          };
        });
        const evidence = {
          status: 'recorded',
          description:
            'B06-09 の模擬結果。commit は実行時の基点、source_sha256 は未コミット差分を含む検査対象の正確な内容。保存期限の掃除・記憶と忘却の命令・忘却の Core の経路・バックアップと復元・記録しない会話をつなぎ、行・知らせ・台帳と、合成の目印の平文・暗号文を DB・WAL・台帳の別ファイル・バックアップ・ログから探した結果を手書きの期待値と突き合わせた。忘却と遅着の順序は seed ごとに入れ替えた。実機の Mac mini での実際のバックアップと鍵の復元・実 API・実請求は未実施（B15）。本人の明示の依頼の記憶の保存（memory_save、ADR 0191）は、記録しない会話の間に保存しないこと（X59）と通常の会話での保存（陽性の対照）だけを観測した。memory_correct・自動の抽出・発言からの忘却は観測していない。知らせを端末へ運ぶ経路（UI-05 の段階 3、ADR 0187）はこの統合では観測していない。',
          command: 'node --test tests/integration/b06.test.mjs',
          source_sha256: sourceSha256,
          records,
          runs,
        };
        writeFileSync(
          process.env.BUDDY_B06_EVIDENCE_PATH,
          JSON.stringify(evidence, null, 2) + '\n',
        );
      }
    }
  },
);
