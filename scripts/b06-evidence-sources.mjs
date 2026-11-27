// B06 の証拠（evidence-b06-simulated.json）が、どのソースで作られたかを hash で固定する。
// 対象は、B06 の統合の実行器（tests/integration/b06*.mjs）が実際に読み込むファイル（保存期限の掃除・忘却の Core の経路・
// バックアップと復元・保存境界の保持者・DB worker・マイグレーション・契約・手書きの期待値）だけ。集め方は B04・B05・B07 と
// 共通（scripts/evidence-sources.mjs）。
import {
  assertEvidenceSources,
  evidenceSourceFiles,
  evidenceSourceSha256,
} from './evidence-sources.mjs';

const OPTIONS = { entry: /^b06.*\.mjs$/u, extraFiles: [] };

export const b06SourceFiles = (readFile) =>
  evidenceSourceFiles(OPTIONS, readFile);

export const b06SourceSha256 = (readFile) =>
  evidenceSourceSha256(OPTIONS, readFile);

export const assertB06EvidenceSources = (evidence, readFile) =>
  assertEvidenceSources(
    evidence,
    OPTIONS,
    'B06 の証拠と現行ソースが不一致です。ビルド後に B06 実行器で証拠を再生成してください。',
    readFile,
  );
