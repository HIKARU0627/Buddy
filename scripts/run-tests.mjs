import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'coverage'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.test\.(?:mjs|js)$/u.test(entry.name)) files.push(path);
  }
}
for (const directory of ['scripts', 'packages', 'apps', 'tests'])
  await walk(join(root, directory));
if (files.length === 0) throw new Error('実行対象の試験がありません。');
files.sort();
const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', ...files],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
