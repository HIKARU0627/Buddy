// B04・B05・B07 の模擬証拠（G1: 記録の同一性 / G4: 無言のドリフト防止）を、現行ソースと厳密に照合する。
//
// これは PR の必須チェックではない（ADR 0085）。PR の CI は実行器が期待値と一致すること（G5）を検査し、
// 記録の現在性は工程の完了時・main の freshness・手動の確認で担保する。同期間、main の記録は一時的に
// 古い状態になり得るので、その不一致を PR の必須チェック（Verify (<os>) と Public content / secrets）へ
// 混ぜない。`pnpm run evidence:check` はその専用の入口である。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertB04EvidenceSources } from './b04-evidence-sources.mjs';
import { assertB05EvidenceSources } from './b05-evidence-sources.mjs';
import { assertB07EvidenceSources } from './b07-evidence-sources.mjs';
import { root } from './contract-tools.mjs';

const defaultRead = (path) => readFileSync(new URL(path, root), 'utf8');

// 証拠のファイルと、その工程の対象を集める検査。順序は出力の順序にだけ使う。
export const EVIDENCE_TARGETS = [
  {
    label: 'B04',
    path: 'tests/integration/evidence-b04-simulated.json',
    assertSources: assertB04EvidenceSources,
  },
  {
    label: 'B05',
    path: 'tests/integration/evidence-b05-simulated.json',
    assertSources: assertB05EvidenceSources,
  },
  {
    label: 'B07',
    path: 'tests/integration/evidence-b07-simulated.json',
    assertSources: assertB07EvidenceSources,
  },
];

// 不一致の説明を配列で返す（空なら一致）。試験から readFile を差し替えられるようにする。
export function checkEvidenceSources(readFile = defaultRead) {
  const failures = [];
  for (const target of EVIDENCE_TARGETS) {
    let evidence;
    try {
      evidence = JSON.parse(readFile(target.path));
    } catch (error) {
      failures.push(`${target.label}: 証拠を読めません（${error.message}）`);
      continue;
    }
    try {
      target.assertSources(evidence, readFile);
    } catch (error) {
      failures.push(`${target.label}: ${error.message}`);
    }
  }
  return failures;
}

// CLI の本体。不一致なら説明を出して 1 を返す。例外にせず、呼び出し側（試験・workflow）が結果を使えるようにする。
export function runEvidenceCheck({
  readFile = defaultRead,
  log = console.log,
  error = console.error,
} = {}) {
  const failures = checkEvidenceSources(readFile);
  if (failures.length === 0) {
    log(
      'B04・B05・B07 の証拠は、現行ソースの対象ファイルと一致します（記録の現在性 G1/G4）。',
    );
    return 0;
  }
  error(
    'B04・B05・B07 の証拠と現行ソースが一致しません。記録の現在性（G1/G4）が崩れています。',
  );
  for (const failure of failures) error(`- ${failure}`);
  error(
    '工程の完了時、または main の記録更新で、その head の証拠を再生成してください。',
  );
  return 1;
}

// 直接実行したときだけ CLI として動く（import した試験では動かさない）。
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = runEvidenceCheck();
