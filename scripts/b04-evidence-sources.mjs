import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);

export function b04SourceSha256() {
  const tracked = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0');
  return [...new Set(tracked)]
    .filter(
      (p) =>
        /^(apps|packages|scripts|tests)\//u.test(p) &&
        !p.includes('/evidence-') &&
        !p.endsWith('.md'),
    )
    .sort()
    .map((path) => ({
      path,
      sha256: createHash('sha256')
        .update(readFileSync(new URL(path, root)))
        .digest('hex'),
    }));
}

export function assertB04EvidenceSources(evidence) {
  // hash だけでなく一覧も比較し、追加・削除・証拠側の欠落を検出する。
  assert.deepEqual(
    evidence.source_sha256,
    b04SourceSha256(),
    'B04 の証拠と現行ソースが不一致です。ビルド後に B04 実行器で証拠を再生成してください。',
  );
}
