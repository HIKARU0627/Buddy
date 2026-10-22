import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

const { validators } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/schema-cases.json', root),
    'utf8',
  ),
);
const ids = new Set();
for (const entry of cases) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  const valid = validate(entry.value);
  assert.equal(
    valid,
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  // 形は正しいが意味検査で拒否する例は semantic_errors に期待する理由を手で書く（ADR 0027）。
  if (valid)
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
  else assert.equal(entry.semantic_errors, undefined, entry.id);
}
// キャンバスと流れの区切りの例（ADR 0032）。ここは形式だけを確かめ、意味の検査（semantic_errors）は
// domain の関数で scripts/canvas.test.mjs が確かめる（contracts:check は build の前に走るため）。
const canvasCases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/canvas-stream-cases.json', root),
    'utf8',
  ),
);
for (const entry of canvasCases) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  assert.equal(
    validate(entry.value),
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  if (!entry.valid) assert.equal(entry.semantic_errors, undefined, entry.id);
}
const plan = parseStrictJson(
  await readFile(
    new URL('packages/contracts/model-evaluation.json', root),
    'utf8',
  ),
);
assert(
  validators['ModelEvaluationPlan'](plan),
  'Invalid model evaluation plan',
);
await SwaggerParser.validate(
  fileURLToPath(new URL('packages/contracts/openapi.yaml', root)),
  {
    resolve: { http: false },
  },
);
console.log(
  `${cases.length + canvasCases.length} schema fixtures and OpenAPI 3.1.2 validated. No product or provider test was run.`,
);
