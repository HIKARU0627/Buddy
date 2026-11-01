import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import {
  discoverTests,
  parseShard,
  partition,
  readWeights,
} from './test-shards.mjs';

const synthetic = Array.from(
  { length: 23 },
  (_, i) => `apps/x/dist/t${String(i).padStart(2, '0')}.test.js`,
);

function assertExactlyOnce(files, shards) {
  const seen = shards.flat();
  assert.equal(seen.length, files.length, '重複または欠落');
  assert.deepEqual([...seen].sort(), [...files].sort());
}

test('どの総数でも、各ファイルはちょうど 1 つの shard に入る（実在の試験ファイルと重みで）', async () => {
  const files = await discoverTests();
  const weights = await readWeights();
  assert.ok(files.length > 100);
  for (let total = 1; total <= 8; total += 1) {
    assertExactlyOnce(files, partition(files, total, weights));
  }
});

test('割り当ては入力の並びに依らず決まる', async () => {
  const weights = await readWeights();
  const files = await discoverTests();
  assert.deepEqual(
    partition([...files].reverse(), 4, weights),
    partition(files, 4, weights),
  );
});

test('重みが無い新しいファイルも漏れなく分散する', () => {
  const shards = partition(synthetic, 4, { default_weight: 1 });
  assertExactlyOnce(synthetic, shards);
  const sizes = shards.map((list) => list.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, sizes.join(','));
});

test('重いファイルは別の shard に分かれ、予約した負荷の shard には入りにくい', () => {
  const weights = {
    default_weight: 1,
    reserved: { 1: 100 },
    files: { 'a.test.mjs': 50, 'b.test.mjs': 50, 'c.test.mjs': 50 },
  };
  const shards = partition(
    ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs'],
    3,
    weights,
  );
  assert.deepEqual(shards[0], [], '予約した負荷の shard には入れない');
  const where = (name) => shards.findIndex((list) => list.includes(name));
  assert.notEqual(where('a.test.mjs'), where('b.test.mjs'));
  assertExactlyOnce(
    ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs'],
    shards,
  );
});

test('B04 と B07 の統合試験は同じ shard に入らず、全体の総数 4 でも別々になる', async () => {
  const shards = partition(await discoverTests(), 4, await readWeights());
  const where = (name) => shards.findIndex((list) => list.includes(name));
  const b07 = where('tests/integration/b07.test.mjs');
  const b04 = where('tests/integration/b04.test.mjs');
  assert.ok(b07 >= 0 && b04 >= 0);
  assert.notEqual(b07, b04);
});

test('--shard の指定を検査する', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, total: 4 });
  for (const bad of ['0/4', '5/4', '1/0', 'a/b', '1', '', undefined])
    assert.throws(() => parseShard(bad), bad);
  assert.throws(() => partition(synthetic, 0, {}));
});

// CI の構成: Verify (<os>) の名前が必須チェックとして成立し、shard の欠落が構成の時点で検出されること。
const ci = parse(
  await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ),
);
const verifyOs = parse(
  await readFile(
    new URL('../.github/workflows/verify-os.yml', import.meta.url),
    'utf8',
  ),
);

test('必須チェックの 4 つの名前が成立している', () => {
  const names = Object.values(ci.jobs).map((job) => job.name);
  for (const required of [
    'Public content / secrets',
    'Verify (macos-latest)',
    'Verify (ubuntu-latest)',
    'Verify (windows-latest)',
  ])
    assert.equal(names.filter((name) => name === required).length, 1, required);
});

test('Verify (<os>) は、その OS の試験が成功しなければ必ず失敗する', () => {
  for (const [os, key] of [
    ['ubuntu-latest', 'ubuntu'],
    ['windows-latest', 'windows'],
    ['macos-latest', 'macos'],
  ]) {
    const caller = ci.jobs[`test-${key}`];
    assert.equal(caller.uses, './.github/workflows/verify-os.yml');
    assert.equal(caller.with.os, os);
    const job = ci.jobs[`verify-${key}`];
    assert.equal(job.name, `Verify (${os})`);
    assert.deepEqual(job.needs, [`test-${key}`]);
    assert.match(String(job.if), /always\(\)/u);
    const [step] = job.steps;
    assert.match(step.env.RESULT, new RegExp(`needs\\.test-${key}\\.result`));
    assert.match(step.run, /test "\$RESULT" = "success"/u);
  }
});

test('shard の matrix は 1..N の連番で、総数は job-total から取る（欠落できない）', () => {
  const job = verifyOs.jobs.shard;
  const shards = job.strategy.matrix.shard;
  assert.deepEqual(
    shards,
    Array.from({ length: shards.length }, (_, i) => i + 1),
  );
  assert.deepEqual(Object.keys(job.strategy.matrix), ['shard']);
  assert.equal(job.strategy['fail-fast'], false);
  const testStep = job.steps.find((step) => /run-tests\.mjs/u.test(step.run));
  assert.match(
    testStep.run,
    /--shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}$/u,
  );
});

test('従来の pnpm run check の検査はすべて OS ごとの shard 1 かすべての shard で行う', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const check = pkg.scripts.check.split(' && ');
  const runs = verifyOs.jobs.shard.steps.map((step) => step.run ?? '');
  const covered = (name) => runs.some((run) => run === name);
  assert.deepEqual(check, [
    'pnpm run doctor',
    'pnpm run format:check',
    'pnpm run contracts:check',
    'pnpm run lint',
    'pnpm run build',
    'pnpm run typecheck',
    'pnpm test',
    'pnpm run security:check',
  ]);
  for (const name of check.filter((name) => name !== 'pnpm test'))
    assert.ok(covered(name), name);
  // pnpm test = 全ファイルの実行。shard 実行はその分割。
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs');
  // 静的検査と署名・秘密の検査は、必ず実行される shard 1 に置く。
  for (const step of verifyOs.jobs.shard.steps) {
    if (step.if !== undefined) assert.equal(step.if, 'matrix.shard == 1');
  }
  assert.ok(covered('pnpm run security:staged'));
});

test('権限を広げない・pull_request_target を使わない', () => {
  assert.deepEqual(ci.permissions, { contents: 'read' });
  assert.deepEqual(verifyOs.permissions, { contents: 'read' });
  assert.equal(ci.on.pull_request_target, undefined);
  for (const job of Object.values(ci.jobs)) {
    assert.equal(job.permissions, undefined);
  }
  for (const job of Object.values(verifyOs.jobs)) {
    assert.equal(job.permissions, undefined);
  }
});
