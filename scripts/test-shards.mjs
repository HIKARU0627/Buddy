// 試験ファイルの shard 分割。CI が OS ごとに複数の job へ分けて並列に実行するときの割り当て。
// 割り当ては「ファイルの一覧と重み」だけから決まる純粋な関数で、同じ入力なら全 job で同じ結果になる。
// 全 shard の和集合が全ファイルとちょうど一致し、重なりがないこと（各ファイルがちょうど 1 回実行されること）は
// scripts/test-shards.test.mjs と CI の構成の試験が確かめる。
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

// 試験ファイルを集める（リポジトリのルートからの相対パス、区切りは / 、辞書順）。
export async function discoverTests(base = root) {
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
    await walk(join(base, directory));
  return files.map((file) => relative(base, file).split(sep).join('/')).sort();
}

export async function readWeights() {
  const raw = JSON.parse(
    await readFile(new URL('test-shard-weights.json', import.meta.url), 'utf8'),
  );
  return raw;
}

// weights: { default_weight, reserved: { "<shard>": 重み }, files: { path: 重み } }。
// 重いファイルから順に、そのときいちばん負荷の小さい shard へ入れる（同じなら番号の小さい方）。
// 重みは負荷の目安にすぎず、割り当ての正しさ（ちょうど 1 回）には影響しない。
export function partition(files, total, weights) {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`shard の総数は 1 以上の整数にしてください: ${total}`);
  }
  const defaultWeight = weights.default_weight ?? 1;
  const loads = Array.from(
    { length: total },
    (_, i) => weights.reserved?.[String(i + 1)] ?? 0,
  );
  const shards = Array.from({ length: total }, () => []);
  const weightOf = (file) => weights.files?.[file] ?? defaultWeight;
  const ordered = [...files].sort(
    (a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const file of ordered) {
    let target = 0;
    for (let i = 1; i < total; i += 1) if (loads[i] < loads[target]) target = i;
    shards[target].push(file);
    loads[target] += weightOf(file);
  }
  return shards.map((list) => list.sort());
}

// "2/4" → { index: 2, total: 4 }
export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/u.exec(value ?? '');
  if (!match)
    throw new Error(`--shard は <番号>/<総数> で指定してください: ${value}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`--shard の番号が範囲外です: ${value}`);
  }
  return { index, total };
}
