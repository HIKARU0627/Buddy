// B07 の証拠（evidence-b07-simulated.json）が、どのソースで作られたかを hash で固定する。
// 対象は、B07 の統合の実行器（tests/integration/b07*.mjs）が実際に読み込むファイル（予算の門・DB worker・
// マイグレーション・契約・手書きの期待値）だけ。集め方は B04 と共通（scripts/evidence-sources.mjs）。
import {
  assertEvidenceSources,
  evidenceSourceFiles,
  evidenceSourceSha256,
} from './evidence-sources.mjs';

const OPTIONS = { entry: /^b07.*\.mjs$/u, extraFiles: [] };

export const b07SourceFiles = (readFile) =>
  evidenceSourceFiles(OPTIONS, readFile);

export const b07SourceSha256 = (readFile) =>
  evidenceSourceSha256(OPTIONS, readFile);

export const assertB07EvidenceSources = (evidence, readFile) =>
  assertEvidenceSources(
    evidence,
    OPTIONS,
    'B07 の証拠と現行ソースが不一致です。ビルド後に B07 実行器で証拠を再生成してください。',
    readFile,
  );
