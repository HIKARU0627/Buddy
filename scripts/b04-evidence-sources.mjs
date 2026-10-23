// B04 の証拠（evidence-b04-simulated.json）が、どのソースで作られたかを hash で固定する。
//
// 対象は、B04 の統合の実行器（tests/integration/b04*.mjs）が実際に読み込んで動かすファイルと、期待値・fixture
// だけ（B04 と関係のない画面などの変更で、証拠を作り直さないため）。読み込むファイルは機械的に集める:
// - 入口は tests/integration/b04*.mjs。そこから import・export … from・動的 import（文字列）を辿る。
// - `import type` / `export type` だけの文は実行されないので辿らない。
// - ビルド済みの dist を指す参照は、同じワークスペースの src（.ts / .tsx）へ読み替える（dist はコミットしない）。
// - @buddy/* はワークスペースの package.json の exports で解決する（dist は src へ読み替え）。
// - `new URL('…', import.meta.url)` と `import.meta.resolve('…')` の文字列も辿る（fixture・Schema・SQL の
//   マイグレーション・worker）。ディレクトリ（末尾が /）は中のファイルをすべて含める。
// - node: の組み込みと外部の依存（node_modules）は含めない。
// - EXTRA_FILES: 実行器は読まないが、期待値の整合を検査する fixture（状態の遷移表）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_DIR = 'tests/integration';
const ENTRY = /^b04.*\.mjs$/u;
export const EXTRA_FILES = [
  'packages/contracts/fixtures/operation-transitions.json',
];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js'];

const toPosix = (path) => path.split(sep).join(posix.sep);
const rel = (abs) => toPosix(relative(ROOT, abs));

// ワークスペースの名前 → ディレクトリと exports。
function workspaces() {
  const map = new Map();
  for (const group of ['apps', 'packages']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const file = join(base, name, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      map.set(pkg.name, { dir: join(base, name), exports: pkg.exports ?? {} });
    }
  }
  return map;
}

// dist のファイルを src のソースへ読み替える。存在するソースのパス（絶対）か null。
function toSource(abs) {
  const candidates = [];
  const marker = `${sep}dist${sep}`;
  const base = abs.includes(marker)
    ? abs.replace(marker, `${sep}src${sep}`)
    : abs;
  candidates.push(base);
  const stem = base.replace(/\.(m?js|d\.ts)$/u, '');
  for (const ext of SOURCE_EXTENSIONS) candidates.push(stem + ext);
  for (const candidate of candidates)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

function exportTarget(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object')
    return entry.default ?? entry.import ?? null;
  return null;
}

// 指定子を解決する。辿らない（組み込み・外部）なら null。ディレクトリは { dir }。
function resolveSpecifier(specifier, fromAbs, packages) {
  if (specifier.startsWith('node:')) return null;
  let target;
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    target = resolve(dirname(fromAbs), specifier);
  } else if (specifier.startsWith('@buddy/')) {
    const parts = specifier.split('/');
    const name = parts.slice(0, 2).join('/');
    const pkg = packages.get(name);
    if (pkg === undefined) return null;
    const sub = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
    const mapped = exportTarget(pkg.exports[sub]);
    if (mapped === null) return null;
    target = resolve(pkg.dir, mapped);
  } else return null;
  if (specifier.endsWith('/')) return { dir: target };
  return { file: toSource(target) ?? target };
}

// 実行される参照の指定子を取り出す（型だけの import / export は除く）。
export function runtimeSpecifiers(text) {
  const found = [];
  const statement =
    /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gu;
  for (const match of text.matchAll(statement)) {
    if (match[2] !== undefined) continue;
    found.push(match[4]);
  }
  for (const match of text.matchAll(
    /(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/gu,
  ))
    found.push(match[1]);
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu))
    found.push(match[1]);
  for (const match of text.matchAll(
    /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
  ))
    found.push(match[1]);
  for (const match of text.matchAll(
    /import\.meta\.resolve\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ))
    found.push(match[1]);
  return found;
}

function listDir(abs) {
  const files = [];
  for (const name of readdirSync(abs)) {
    const path = join(abs, name);
    if (statSync(path).isDirectory()) files.push(...listDir(path));
    else files.push(path);
  }
  return files;
}

// B04 の実行器が読むファイル（リポジトリからの相対パス、辞書順）。
// readFile は試験で内容を差し替えるための差し込み口（既定はディスクから読む）。
export function b04SourceFiles(readFile = defaultRead) {
  const packages = workspaces();
  const entries = readdirSync(join(ROOT, ENTRY_DIR))
    .filter((name) => ENTRY.test(name))
    .map((name) => join(ROOT, ENTRY_DIR, name));
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const abs = queue.shift();
    const path = rel(abs);
    if (seen.has(path) || !existsSync(abs)) continue;
    seen.add(path);
    if (!/\.(m?[jt]sx?)$/u.test(abs)) continue;
    for (const specifier of runtimeSpecifiers(readFile(path))) {
      const resolved = resolveSpecifier(specifier, abs, packages);
      if (resolved === null) continue;
      if ('dir' in resolved) {
        if (existsSync(resolved.dir)) queue.push(...listDir(resolved.dir));
        continue;
      }
      if (!rel(resolved.file).startsWith('..')) queue.push(resolved.file);
    }
  }
  for (const extra of EXTRA_FILES) seen.add(extra);
  return (
    [...seen]
      .filter((path) => !path.includes('node_modules/'))
      .filter((path) => !/(^|\/)evidence-[^/]*\.json$/u.test(path))
      // ディレクトリの中の説明文（README など）は実行されない。
      .filter((path) => !path.endsWith('.md'))
      .sort()
  );
}

function defaultRead(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

export function b04SourceSha256(readFile = defaultRead) {
  return b04SourceFiles(readFile).map((path) => ({
    path,
    sha256: createHash('sha256').update(readFile(path), 'utf8').digest('hex'),
  }));
}

export function assertB04EvidenceSources(evidence, readFile = defaultRead) {
  // hash だけでなく一覧も比較し、追加・削除・証拠側の欠落を検出する。
  assert.deepEqual(
    evidence.source_sha256,
    b04SourceSha256(readFile),
    'B04 の証拠と現行ソースが不一致です。ビルド後に B04 実行器で証拠を再生成してください。',
  );
}
