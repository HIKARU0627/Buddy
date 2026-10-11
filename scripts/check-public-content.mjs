import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPublicContent } from './public-content.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (args) =>
  execFileSync('git', args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const commitRange = process.argv
  .find((arg) => arg.startsWith('--commits='))
  ?.slice('--commits='.length);
if (commitRange && !/^[a-f0-9]{40}(?:\.\.[a-f0-9]{40})?$/u.test(commitRange)) {
  throw new Error('Invalid commit range');
}
const history = process.argv.includes('--history') || Boolean(commitRange);
const staged = process.argv.includes('--staged');
const entries = [];
if (history) {
  if (
    git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false'
  )
    throw new Error('全履歴を取得してください。');
  const commits = git(['rev-list', commitRange ?? '--all'])
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  const seen = new Set();
  for (const commit of commits) {
    for (const row of git(['ls-tree', '-rz', '--full-tree', commit])
      .toString()
      .split('\0')
      .filter(Boolean)) {
      const match = row.match(/^\d+ blob ([a-f0-9]+)\t([\s\S]+)$/u);
      if (!match) continue;
      const [, sha, path] = match;
      const key = `${sha}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ path, bytes: git(['cat-file', 'blob', sha]) });
    }
  }
} else if (staged) {
  for (const row of git(['ls-files', '--stage', '-z'])
    .toString()
    .split('\0')
    .filter(Boolean)) {
    const match = row.match(/^\d+ ([a-f0-9]+) 0\t([\s\S]+)$/u);
    if (!match) throw new Error('未解決の index エントリがあります。');
    entries.push({
      path: match[2],
      bytes: git(['cat-file', 'blob', match[1]]),
    });
  }
} else {
  const paths = new Set(
    git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .toString()
      .split('\0')
      .filter(Boolean),
  );
  for (const path of paths) {
    try {
      entries.push({ path, bytes: await readFile(join(root, path)) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
const findings = entries.flatMap(({ path, bytes }) =>
  inspectPublicContent(path, bytes).map((rule) => ({ path, rule })),
);
if (findings.length) {
  const unique = new Map(findings.map((f) => [`${f.path}:${f.rule}`, f]));
  for (const { path, rule } of [...unique.values()].slice(0, 50))
    console.error(`${path}: ${rule}`);
  console.error(
    `${findings.length} public-content finding(s). Matched values are never printed.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `${entries.length} ${history ? 'historical' : staged ? 'staged' : 'working-tree'} files passed public-content checks.`,
  );
}
