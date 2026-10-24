// B04 の証拠（evidence-b04-simulated.json）が、どのソースで作られたかを hash で固定する。
// 対象の集め方（実行器 tests/integration/b04*.mjs が読み込むファイルだけを機械的に辿る）は B07 と共通で、
// scripts/evidence-sources.mjs にある。ここは B04 の入口と、明示して含めるファイルだけを決める。
import {
  assertEvidenceSources,
  evidenceSourceFiles,
  evidenceSourceSha256,
  runtimeSpecifiers,
} from './evidence-sources.mjs';

// 実行器は読まないが、期待値の整合を検査する fixture（状態の遷移表）。
export const EXTRA_FILES = [
  'packages/contracts/fixtures/operation-transitions.json',
];
const OPTIONS = { entry: /^b04.*\.mjs$/u, extraFiles: EXTRA_FILES };

export { runtimeSpecifiers };

// B04 の実行器が読むファイル（リポジトリからの相対パス、辞書順）。
export const b04SourceFiles = (readFile) =>
  evidenceSourceFiles(OPTIONS, readFile);

export const b04SourceSha256 = (readFile) =>
  evidenceSourceSha256(OPTIONS, readFile);

export const assertB04EvidenceSources = (evidence, readFile) =>
  assertEvidenceSources(
    evidence,
    OPTIONS,
    'B04 の証拠と現行ソースが不一致です。ビルド後に B04 実行器で証拠を再生成してください。',
    readFile,
  );
