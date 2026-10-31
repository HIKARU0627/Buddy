// 使い方: node scripts/run-tests.mjs [--shard <番号>/<総数>] [--list]
// 引数なしは全試験ファイルを 1 つの `node --test` で実行する（pnpm test / pnpm run check）。
// --shard は CI が OS ごとに試験を複数の job へ分けるときに使う。--list は実行せず対象を表示する。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  discoverTests,
  parseShard,
  partition,
  readWeights,
} from './test-shards.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let shard = null;
let listOnly = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--shard') shard = parseShard(args[++i]);
  else if (args[i].startsWith('--shard=')) shard = parseShard(args[i].slice(8));
  else if (args[i] === '--list') listOnly = true;
  else throw new Error(`不明な引数です: ${args[i]}`);
}

let files = await discoverTests(root);
if (files.length === 0) throw new Error('実行対象の試験がありません。');
const all = files.length;
if (shard) {
  files = partition(files, shard.total, await readWeights())[shard.index - 1];
  if (files.length === 0) {
    throw new Error(`shard ${shard.index}/${shard.total} の試験がありません。`);
  }
}
console.log(
  shard
    ? `試験 shard ${shard.index}/${shard.total}: ${files.length} / ${all} ファイル`
    : `試験: ${all} ファイル`,
);
if (listOnly) {
  for (const file of files) console.log(file);
} else {
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
}
