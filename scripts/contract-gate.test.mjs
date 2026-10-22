import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// contracts:check が壊れた契約を本当に拒否するかを、作業ツリーの写しを壊して確かめる（B00-10 の CI ゲート）。
// 写しは一時ディレクトリに作り、リポジトリのファイルは変更しない。
const root = fileURLToPath(new URL('../', import.meta.url));
const FILES = [
  'scripts/contract-tools.mjs',
  'scripts/check-contracts.mjs',
  'scripts/generate-contract-types.mjs',
  'prettier.config.mjs',
  'packages/contracts/schemas/buddy.schema.json',
  'packages/contracts/fixtures/schema-cases.json',
  'packages/contracts/fixtures/canvas-stream-cases.json',
  'packages/contracts/openapi.yaml',
  'packages/contracts/model-evaluation.json',
  'packages/contracts/src/generated.ts',
];

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-gate-'));
  for (const file of FILES) {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await cp(join(root, file), join(dir, file));
  }
  await symlink(
    join(root, 'node_modules'),
    join(dir, 'node_modules'),
    'junction',
  );
  return dir;
}

function run(dir, script, ...args) {
  const result = spawnSync(process.execPath, [join(dir, script), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const gate = (dir) => [
  run(dir, 'scripts/generate-contract-types.mjs', '--check'),
  run(dir, 'scripts/check-contracts.mjs'),
];

async function edit(dir, file, change) {
  const path = join(dir, file);
  await writeFile(path, change(await readFile(path, 'utf8')));
}

const SCHEMA = 'packages/contracts/schemas/buddy.schema.json';
const CASES = 'packages/contracts/fixtures/schema-cases.json';
const OPENAPI = 'packages/contracts/openapi.yaml';

const breakages = [
  {
    name: 'stale generated types',
    change: [
      SCHEMA,
      (text) => {
        const schema = JSON.parse(text);
        schema.$defs.Hash.description = '生成型を古くするための変更';
        return JSON.stringify(schema, null, 2);
      },
    ],
    failing: 0,
  },
  {
    name: 'unresolved schema reference',
    change: [
      SCHEMA,
      (text) => {
        const schema = JSON.parse(text);
        schema.$defs.ApiError.properties.request_id = {
          $ref: '#/$defs/DoesNotExist',
        };
        return JSON.stringify(schema, null, 2);
      },
    ],
    failing: 1,
  },
  {
    name: 'invalid contract keyword',
    change: [
      SCHEMA,
      (text) => {
        const schema = JSON.parse(text);
        schema.$defs.Hash.patern = '^x$';
        return JSON.stringify(schema, null, 2);
      },
    ],
    failing: 1,
  },
  {
    name: 'unresolved OpenAPI reference',
    change: [
      OPENAPI,
      (text) =>
        text.replace('$defs/Bootstrap\n', '$defs/BootstrapThatDoesNotExist\n'),
    ],
    failing: 1,
  },
  {
    name: 'rejection fixture marked as accepted',
    change: [
      CASES,
      (text) => {
        const cases = JSON.parse(text);
        const rejected = cases.find((entry) => entry.valid === false);
        rejected.valid = true;
        return JSON.stringify(cases, null, 2);
      },
    ],
    failing: 1,
  },
  {
    name: 'duplicate JSON key in a fixture',
    change: [
      CASES,
      (text) => text.replace('[\n  {', '[\n  {\n    "id": "dup",'),
    ],
    failing: 1,
  },
];

test('the clean copy passes and every kind of broken contract fails the gate', async () => {
  const clean = await workspace();
  try {
    for (const result of gate(clean))
      assert.equal(result.status, 0, result.output);
  } finally {
    await rm(clean, { recursive: true, force: true });
  }
  for (const breakage of breakages) {
    const dir = await workspace();
    try {
      await edit(dir, ...breakage.change);
      const results = gate(dir);
      assert.notEqual(
        results[breakage.failing].status,
        0,
        `${breakage.name} was not detected`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
