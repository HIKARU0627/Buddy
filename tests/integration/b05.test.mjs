// B05 の全ケースを同じ入口から、固定 seed・異なる順序で反復する。件数は期待値から作らず実観測を数える。
// 端末（VoiceController・DesktopDeviceController・模擬の音声レンダラー・合成の PCM）と中枢（VoiceControl・DB worker・
// 予算の門・模擬の Live の provider）を 1 本の手で進める時計でつないだ模擬の統合試験で、実機・実 API・実請求は含まない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { specification, shuffled } from './b05-support.mjs';
import { collectRuns } from './evidence-run.mjs';
import { caseIds, runCase } from './b05-cases.mjs';

const cases = specification.cases;
const ids = cases.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length);
assert.deepEqual(
  [...ids].sort(),
  [...caseIds()].sort(),
  '手書きの期待値とケースの実装の ID が一致する',
);

test(
  'B05-07: X13・QA43 ほかの音声の停止・世代・再開を固定 seed で反復照合する',
  { timeout: 600000 },
  async (t) => {
    const result = await collectRuns({
      t,
      cases,
      seeds: specification.seeds,
      shuffled,
      timeoutMs: 60000,
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
  },
);
