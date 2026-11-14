import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import {
  loadContracts,
  parseStrictJson,
  restoreGuard,
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
// 音声の契約の例（B05-01、ADR 0038）。形式と、契約の検証ツールが持つ意味検査（リースの期限・同意の時刻）を確かめる。
// VoiceRendererRequest の意味検査（理由と範囲の組・ACK の待ち時間）は domain の関数で scripts/voice-contract.test.mjs が確かめる。
const voiceCases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/voice-contract-cases.json', root),
    'utf8',
  ),
);
for (const entry of voiceCases.cases) {
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
  else if (entry.schema !== 'VoiceRendererRequest')
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
}
// 保存の契約の例（B06-01、ADR 0040）。忘却台帳の別ファイル・端末の複製・バックアップの封筒・復元の結果・
// 期限切れと忘却の知らせ・保存モード・復旧キー・置き場所。形式と、契約の検証ツールの意味検査（世代の欠番・
// hash の連鎖・復元の段階の整合など）を確かめる。期待値は手書きで、検査する関数から作っていない。
const storageCases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/storage-contract-cases.json', root),
    'utf8',
  ),
);
for (const entry of storageCases.cases) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  assert.equal(
    validate(entry.value),
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  if (entry.valid)
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors,
      entry.id,
    );
  else assert.equal(entry.semantic_errors, undefined, entry.id);
}
// 復元後の隔離のシナリオ（Codex の再確認 P1。ADR 0040）。初期の記録は形と意味検査を通し（意図的に漏れを含む対照は
// initial_semantic_errors に手書きの理由を持つ）、各手順の結果は手書きの期待値と restoreGuard の出力を照合する。
for (const entry of storageCases.scenarios) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  assert(
    validators['RestoredOperation'](entry.initial),
    `${entry.id}: ${JSON.stringify(validators['RestoredOperation'].errors)}`,
  );
  assert.deepEqual(
    semanticErrors('RestoredOperation', entry.initial),
    entry.initial_semantic_errors,
    entry.id,
  );
  for (const [index, step] of entry.steps.entries())
    assert.deepEqual(
      restoreGuard(entry.initial, step),
      step.expect,
      `${entry.id} step ${index + 1} ${step.event}`,
    );
}
// 表示・読み上げの計画とモデル呼出しの結果（B10-01、ADR 0070）。許可例・拒否例と、24 意図すべての
// 手書きの対応表を検査する。対応表は domain の結果の種類の表と scripts/response-plan.test.mjs で照合する。
const responsePlanCases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/response-plan-cases.json', root),
    'utf8',
  ),
);
const responsePlanEntries = [
  ...responsePlanCases.plans,
  ...responsePlanCases.outcomes,
  ...responsePlanCases.invalid,
  ...responsePlanCases.semantic_cases,
];
for (const entry of responsePlanEntries) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  assert.equal(
    validate(entry.value),
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  if (entry.valid)
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
  else assert.equal(entry.semantic_errors, undefined, entry.id);
}
// 24 意図の手書きの対応表から最小の計画を組み立て、形式と段の一致を確かめる。期待値（結果の種類）は
// fixture に手で書いた値で、実装の表から作らない。
const planUuid = (index) =>
  `00000000-0000-4000-8000-${String(300 + index).padStart(12, '0')}`;
const planRows = [
  ...responsePlanCases.intent_views.map((row) => ({
    ...row,
    outcome: 'done',
  })),
  ...responsePlanCases.outcome_cases,
];
for (const [index, row] of planRows.entries()) {
  const workflowId = planUuid(index);
  const value = {
    schema: 'buddy.response-plan.v1',
    workflow_id: workflowId,
    request_revision: '1',
    intent: row.intent,
    outcome: row.outcome,
    view: {
      workflow_id: workflowId,
      request_revision: '1',
      intent: row.intent,
      kind: row.view_kind,
      status: 'ready',
      item_refs: [],
      more_count: 0,
      template_id: null,
      template_version: null,
    },
    facts: [],
    speech: null,
  };
  assert(
    validators['ResponsePlan'](value),
    `${row.intent}: ${JSON.stringify(validators['ResponsePlan'].errors)}`,
  );
  assert.deepEqual(
    semanticErrors('ResponsePlan', value),
    [],
    row.id ?? row.intent,
  );
}
assert.equal(
  new Set(responsePlanCases.intent_views.map((row) => row.intent)).size,
  responsePlanCases.intent_views.length,
  'Duplicate intent in intent_views',
);
// connector の能力と再試行の契約（B08-01、ADR 0027・0071）。読み取り・書込みの宣言と、
// トークン・本文を返さない同期の状態の形式を検査する。規則との一致は scripts/connector-capability.test.mjs が確かめる。
const connectorCases = parseStrictJson(
  await readFile(
    new URL(
      'packages/contracts/fixtures/connector-capability-cases.json',
      root,
    ),
    'utf8',
  ),
);
for (const entry of connectorCases.cases) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  assert.equal(
    validate(entry.value),
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  if (entry.valid)
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
  else assert.equal(entry.semantic_errors, undefined, entry.id);
}
assert(
  validators['ConnectorRetryPolicy'](connectorCases.retry_policy),
  'Invalid connector retry policy',
);
// Outlook のアカウント種別・委任・拒否の理由・カテゴリの扱い（B09-01、ADR 0072）。
const graphCases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/graph-account-cases.json', root),
    'utf8',
  ),
);
for (const entry of graphCases.cases) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  assert.equal(
    validate(entry.value),
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  if (entry.valid)
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
  else assert.equal(entry.semantic_errors, undefined, entry.id);
}
// 気づき（候補）の一覧・根拠（B11-01、ADR 0073）。
const candidateCases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/candidate-cases.json', root),
    'utf8',
  ),
);
for (const entry of candidateCases.cases) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  assert.equal(
    validate(entry.value),
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  if (entry.valid)
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
  else assert.equal(entry.semantic_errors, undefined, entry.id);
}

// 方針による自動承認・安全停止の件数・取り消しの対象版（B13-01、ADR 0074）。
const policyCases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/policy-approval-cases.json', root),
    'utf8',
  ),
);
for (const entry of policyCases.cases) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  assert.equal(
    validate(entry.value),
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  if (entry.valid)
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
  else assert.equal(entry.semantic_errors, undefined, entry.id);
}

// 送信・予定の変更・参加者のいる予定・ごみ箱と送出直前の照合（B14-01、ADR 0075）。
const approvalOperationCases = parseStrictJson(
  await readFile(
    new URL(
      'packages/contracts/fixtures/approval-required-operations-cases.json',
      root,
    ),
    'utf8',
  ),
);
for (const entry of approvalOperationCases.cases) {
  assert(!ids.has(entry.id), `Duplicate fixture id: ${entry.id}`);
  ids.add(entry.id);
  const validate = validators[entry.schema];
  assert(validate, `Unknown schema: ${entry.schema}`);
  assert.equal(
    validate(entry.value),
    entry.valid,
    `${entry.id}: ${JSON.stringify(validate.errors)}`,
  );
  if (entry.valid)
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
  else assert.equal(entry.semantic_errors, undefined, entry.id);
  // 4 種類の intent は、一般化した OperationIntent としても解決できる。
  if (entry.schema.endsWith('OperationIntent') && entry.valid)
    assert(
      validators['OperationIntent'](entry.value),
      `${entry.id}: OperationIntent`,
    );
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
  `${cases.length + canvasCases.length + voiceCases.cases.length + storageCases.cases.length + storageCases.scenarios.length + responsePlanEntries.length + responsePlanCases.intent_views.length + connectorCases.cases.length + graphCases.cases.length + candidateCases.cases.length + policyCases.cases.length + approvalOperationCases.cases.length} schema fixtures and OpenAPI 3.1.2 validated. No product or provider test was run.`,
);
