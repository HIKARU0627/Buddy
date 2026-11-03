import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  GRAPH_ACCOUNT_KINDS,
  GRAPH_CATEGORY_UPDATE_MODES,
  GRAPH_DELEGATION_SCOPES,
  GRAPH_REJECTION_REASONS,
  connectionAccountErrors,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B09-01 の Outlook のアカウント種別・委任・拒否の理由・カテゴリの扱い（ADR 0072）。
// 形式は contracts:check が確かめる。ここでは契約の列挙と domain の語彙が同じであること、
// 拒否を active として扱わないこと、カテゴリの自動付与の値が存在しないことを確かめる。
const { validators, schema } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/graph-account-cases.json', root),
    'utf8',
  ),
);

test('graph account enums match the domain vocabulary', () => {
  const defs = schema.$defs;
  assert.deepEqual([...GRAPH_ACCOUNT_KINDS], defs.GraphAccountKind.enum);
  assert.deepEqual(
    [...GRAPH_DELEGATION_SCOPES],
    defs.GraphDelegationScope.enum,
  );
  assert.deepEqual(
    [...GRAPH_REJECTION_REASONS],
    defs.GraphRejectionReason.enum,
  );
  assert.deepEqual(
    [...GRAPH_CATEGORY_UPDATE_MODES],
    defs.GraphCategoryUpdateMode.enum,
  );
  assert.deepEqual(defs.GraphCategoryUpdateMode.enum, ['display_only']);
});

test('every fixture keeps the hand-written validity and semantic errors', () => {
  for (const entry of cases.cases) {
    const validate = validators[entry.schema];
    assert(validate, entry.schema);
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
});

test('a rejection is never an active connection and the domain check agrees', () => {
  for (const entry of cases.domain_cases) {
    assert.deepEqual(
      connectionAccountErrors(entry.input),
      entry.expected_errors,
      entry.id,
    );
  }
  // 拒否の理由がある接続を active にした fixture は、契約の意味検査でも拒否する。
  const rejected = cases.cases.find(
    (entry) => entry.id === 'graph-rejection-with-active',
  );
  assert.deepEqual(semanticErrors('ConnectionSummary', rejected.value), [
    'rejection_with_active',
  ]);
  assert(
    !validators['GraphAccountState']({
      account_kind: 'personal',
      delegation: 'delegated_user',
      rejection_reason: null,
      category_updates: 'automatic',
    }),
  );
});
