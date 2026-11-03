import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { b04SourceSha256 } from './b04-evidence-sources.mjs';
import { b05SourceSha256 } from './b05-evidence-sources.mjs';
import { b07SourceSha256 } from './b07-evidence-sources.mjs';
import { root } from './contract-tools.mjs';
import {
  checkEvidenceSources,
  EVIDENCE_TARGETS,
  runEvidenceCheck,
} from './evidence-check.mjs';

const B04 = 'tests/integration/evidence-b04-simulated.json';
const B05 = 'tests/integration/evidence-b05-simulated.json';
const B07 = 'tests/integration/evidence-b07-simulated.json';

const defaultRead = (path) => readFileSync(new URL(path, root), 'utf8');
const readOverridden = (overrides) => (path) =>
  path in overrides ? overrides[path] : defaultRead(path);

const evidenceFor = (sourceSha256) =>
  `${JSON.stringify(
    {
      status: 'recorded',
      records: [{ case_id: 'synthetic' }],
      source_sha256: sourceSha256,
    },
    null,
    2,
  )}\n`;

// 合成の木に対して一致する証拠を作る。実在の証拠（コミット済みの内容）には依存しない。
// これにより、この試験は「記録が今のソースと一致するか」ではなく「検査の仕組みが不一致を検出するか」だけを見る。
function consistentTree(overrides = {}) {
  const readBase = readOverridden(overrides);
  const files = {
    ...overrides,
    [B04]: evidenceFor(b04SourceSha256(readBase)),
    [B05]: evidenceFor(b05SourceSha256(readBase)),
    [B07]: evidenceFor(b07SourceSha256(readBase)),
  };
  return { files, read: readOverridden(files) };
}

test('証拠の対象は B04・B05・B07 の模擬証拠の 3 つだけ', () => {
  assert.deepEqual(
    EVIDENCE_TARGETS.map((target) => target.path),
    [B04, B05, B07],
  );
});

test('現行ソースと一致する証拠は通る', () => {
  assert.deepEqual(checkEvidenceSources(consistentTree().read), []);
});

test('対象外のファイルが変わっても、証拠の検査は通る', () => {
  const tree = consistentTree({
    'apps/desktop/src/renderer/screens/work/WorkPanel.tsx': '// 合成の変更\n',
    'docs/b04/README.md': '# 合成の変更\n',
  });
  assert.deepEqual(checkEvidenceSources(tree.read), []);
});

test('対象のファイルが変わると、古い証拠は B04 の不一致として落ちる', () => {
  const tree = consistentTree();
  const changed = readOverridden({
    ...tree.files,
    'apps/core/src/mock-mail-ports.ts': `${defaultRead('apps/core/src/mock-mail-ports.ts')}\n// 合成の変更\n`,
  });
  const failures = checkEvidenceSources(changed);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^B04: /u);
  assert.match(failures[0], /不一致/u);
});

test('B04・B05・B07 の証拠の古い hash・欠落・余分なファイルを拒否する', () => {
  for (const [path, label] of [
    [B04, 'B04'],
    [B05, 'B05'],
    [B07, 'B07'],
  ]) {
    for (const mutate of [
      (sources) => {
        sources[0].sha256 = '0'.repeat(64);
      },
      (sources) => {
        sources.pop();
      },
      (sources) => {
        sources.push({ path: 'tests/removed.mjs', sha256: '0'.repeat(64) });
      },
    ]) {
      const tree = consistentTree();
      const evidence = JSON.parse(tree.files[path]);
      mutate(evidence.source_sha256);
      const failures = checkEvidenceSources(
        readOverridden({ ...tree.files, [path]: JSON.stringify(evidence) }),
      );
      assert.equal(failures.length, 1, `${label}: ${mutate}`);
      assert.match(failures[0], new RegExp(`^${label}: `, 'u'));
      assert.match(failures[0], /不一致/u);
    }
  }
});

test('証拠が読めないときも例外にせず、不一致として返す', () => {
  const tree = consistentTree();
  const failures = checkEvidenceSources(
    readOverridden({ ...tree.files, [B04]: '{' }),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^B04: 証拠を読めません/u);
});

test('CLI は一致なら 0、不一致なら説明を出して 1 を返す', () => {
  const okLines = [];
  const okErrors = [];
  assert.equal(
    runEvidenceCheck({
      readFile: consistentTree().read,
      log: (line) => okLines.push(line),
      error: (line) => okErrors.push(line),
    }),
    0,
  );
  assert.equal(okErrors.length, 0);
  assert.match(okLines.join('\n'), /G1\/G4/u);

  const badLines = [];
  const badErrors = [];
  const tree = consistentTree();
  const evidence = JSON.parse(tree.files[B04]);
  evidence.source_sha256.pop();
  assert.equal(
    runEvidenceCheck({
      readFile: readOverridden({
        ...tree.files,
        [B04]: JSON.stringify(evidence),
      }),
      log: (line) => badLines.push(line),
      error: (line) => badErrors.push(line),
    }),
    1,
  );
  assert.equal(badLines.length, 0);
  assert.match(badErrors.join('\n'), /G1\/G4/u);
  assert.match(badErrors.join('\n'), /B04/u);
});
