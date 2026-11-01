import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  INTENT_NAMES,
  RESULT_VIEW_BY_INTENT,
  resultViewKind,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B10-01 の表示・読み上げの計画（ADR 0070）。形式の検査は contracts:check が済ませているので、
// ここでは domain の意図と結果の種類の対応が契約で変わっていないこと、24 意図すべてに手書きの
// 計画の対応表があることを確かめる。期待値は fixture に手で書き、実装の表から作らない。
const { validators } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/response-plan-cases.json', root),
    'utf8',
  ),
);

test('all 24 intents have a hand-written response plan view and keep the existing mapping', () => {
  assert.deepEqual(
    cases.intent_views.map((row) => row.intent),
    [...INTENT_NAMES],
  );
  for (const row of cases.intent_views) {
    assert.equal(
      row.view_kind,
      RESULT_VIEW_BY_INTENT[row.intent],
      `${row.intent} must keep its result view kind`,
    );
    assert.equal(resultViewKind(row.intent, 'done'), row.view_kind, row.intent);
    assert.equal(
      resultViewKind(row.intent, 'needs_clarification'),
      'clarification',
      row.intent,
    );
    assert.equal(
      resultViewKind(row.intent, 'needs_approval'),
      'approval_link',
      row.intent,
    );
  }
});

test('a plan view whose kind differs from the intent table is rejected', () => {
  for (const entry of cases.domain_cases) {
    const actual =
      entry.view_kind === RESULT_VIEW_BY_INTENT[entry.intent]
        ? []
        : ['view_kind_mismatch'];
    assert.deepEqual(actual, entry.expected_errors, entry.id);
  }
});

test('model outcomes keep the failure causes and never mark a success retryable', () => {
  const failureKinds = [
    'refused',
    'truncated',
    'invalid_schema',
    'invalid_semantics',
    'timeout',
    'unavailable',
    'budget_denied',
    'cancelled',
    'stale',
  ];
  for (const entry of cases.outcomes) {
    assert(validators['ModelOutcome'](entry.value), entry.id);
    assert.deepEqual(
      semanticErrors('ModelOutcome', entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
    if (entry.value.kind === 'ok') assert.equal(entry.value.retryable, false);
    else assert(failureKinds.includes(entry.value.kind), entry.id);
  }
  for (const id of [
    'qa01-outcome-ok-retryable',
    'qa01-outcome-unknown-kind',
    'qa02-outcome-failure-with-value',
  ]) {
    const entry = cases.invalid.find((item) => item.id === id);
    assert(entry, id);
    assert.equal(validators['ModelOutcome'](entry.value), false, id);
  }
});

test('response plans have no field for the response body, recipients, approval or route', () => {
  for (const id of [
    'qa01-plan-reply-text',
    'qa01-plan-body',
    'qa01-plan-approved-route',
  ]) {
    const entry = cases.invalid.find((item) => item.id === id);
    assert(entry, id);
    assert.equal(validators['ResponsePlan'](entry.value), false, id);
  }
  const plan = cases.plans[0].value;
  for (const field of [
    'reply_text',
    'body',
    'subject',
    'recipients',
    'approved',
    'route',
    'effect_kind',
  ])
    assert(
      !validators['ResponsePlan']({ ...plan, [field]: 'forbidden' }),
      field,
    );
});
