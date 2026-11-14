// B05 の証拠（evidence-b05-simulated.json）が、どのソースで作られたかを hash で固定する。
// 対象は、B05 の統合の実行器（tests/integration/b05*.mjs）が実際に読み込むファイル（端末の音声の制御・模擬の音声レンダラー・
// 中枢の音声の制御・会話の処理・DB worker・予算の門・マイグレーション・契約・手書きの期待値）だけ。集め方は B04・B07 と共通
// （scripts/evidence-sources.mjs）。
import {
  assertEvidenceSources,
  evidenceSourceFiles,
  evidenceSourceSha256,
} from './evidence-sources.mjs';

const OPTIONS = { entry: /^b05.*\.mjs$/u, extraFiles: [] };

export const b05SourceFiles = (readFile) =>
  evidenceSourceFiles(OPTIONS, readFile);

export const b05SourceSha256 = (readFile) =>
  evidenceSourceSha256(OPTIONS, readFile);

export const assertB05EvidenceSources = (evidence, readFile) =>
  assertEvidenceSources(
    evidence,
    OPTIONS,
    'B05 の証拠と現行ソースが不一致です。ビルド後に B05 実行器で証拠を再生成してください。',
    readFile,
  );
