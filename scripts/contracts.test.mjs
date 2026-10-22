import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canonicalJson,
  contentHash,
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
const fixture = (id) =>
  structuredClone(cases.find((entry) => entry.id === id).value);

test('H01: independently specified JCS SHA-256 and key-order invariance', async () => {
  const { intent, expected_sha256 } = parseStrictJson(
    await readFile(
      new URL('packages/contracts/fixtures/h01.json', root),
      'utf8',
    ),
  );
  assert.equal(contentHash(JSON.stringify(intent)), expected_sha256);
  assert.equal(
    contentHash(
      JSON.stringify(Object.fromEntries(Object.entries(intent).reverse())),
    ),
    expected_sha256,
  );
  for (const mutate of [
    (v) => {
      v.permission_revision = '2';
    },
    (v) => {
      v.target.remote_id = 'different';
    },
    (v) => {
      v.action.add = ['different'];
    },
    (v) => {
      v.content_version = '2';
    },
  ]) {
    const changed = structuredClone(intent);
    mutate(changed);
    assert.notEqual(contentHash(JSON.stringify(changed)), expected_sha256);
  }
});

test('canonicalization preserves Unicode, whitespace and array order', () => {
  assert.equal(canonicalJson('{"z":1,"a":2}'), '{"a":2,"z":1}');
  assert.equal(canonicalJson('{"\uE000":2,"😀":1}'), '{"😀":1,"\uE000":2}');
  assert.equal(canonicalJson('{"x":1e-7,"y":-0}'), '{"x":1e-7,"y":0}');
  assert.notEqual(contentHash('["a","b"]'), contentHash('["b","a"]'));
  assert.notEqual(contentHash('"é"'), contentHash('"é"'));
  assert.notEqual(contentHash('"text "'), contentHash('"text"'));
});

for (const [name, text] of [
  ['duplicate key', '{"a":1,"a":2}'],
  ['escaped duplicate key', '{"a":1,"\\u0061":2}'],
  ['nested duplicate key', '{"x":[{"a":1,"a":2}]}'],
  ['lone surrogate value', '"\\ud800"'],
  ['lone surrogate key', '{"\\udc00":1}'],
  ['overflowing number', '1e999'],
  ['NaN', 'NaN'],
  ['comment', '{/*comment*/"a":1}'],
  ['trailing comma', '{"a":1,}'],
  ['trailing document', '{}{}'],
  ['empty document', ''],
  ['deep nesting', '['.repeat(70) + '0' + ']'.repeat(70)],
])
  test(`raw JSON refuses ${name}`, () =>
    assert.throws(() => parseStrictJson(text)));

test('all explicit positive and negative schema fixtures', () => {
  for (const entry of cases) {
    assert.equal(validators[entry.schema](entry.value), entry.valid, entry.id);
    if (entry.valid)
      assert.deepEqual(
        semanticErrors(entry.schema, entry.value),
        entry.semantic_errors ?? [],
        entry.id,
      );
  }
});

test('task due dates that do not exist are rejected in intents and previews', () => {
  for (const id of [
    'intent-task-create-impossible-due',
    'intent-task-create-impossible-due-as-operation',
    'preview-task-create-impossible-due',
  ]) {
    const entry = cases.find((c) => c.id === id);
    assert.deepEqual(entry.semantic_errors, ['invalid_local_datetime'], id);
  }
  const task = fixture('intent-task-create');
  task.action.due = '2030-02-28T23:59';
  assert.deepEqual(semanticErrors('OperationIntent', task), []);
  task.action.due = '2030-02-29T00:00';
  assert.deepEqual(semanticErrors('OperationIntent', task), [
    'invalid_local_datetime',
  ]);
  task.action.due = null;
  assert.deepEqual(semanticErrors('TaskOperationIntent', task), []);
});

test('large revisions are strings without floating-point loss', () => {
  const input = fixture('input-text');
  input.request_revision = '9007199254740993123456789';
  assert(validators['InputSnapshot'](input));
  assert.equal(
    parseStrictJson(JSON.stringify(input)).request_revision,
    '9007199254740993123456789',
  );
  assert(!validators['NonNegativeDecimal']('1.0'));
  assert(!validators['NonNegativeDecimal']('-1'));
});

test('UTC and calendar dates reject impossible dates and local timestamps', () => {
  assert(validators['LocalDate']('2032-02-29'));
  assert(!validators['LocalDate']('2031-02-29'));
  assert(!validators['UtcTime']('2030-01-01T09:00:00+09:00'));
  assert(!validators['UtcTime']('2030-01-01T00:00:00'));
});

test('F01 shape: Live evidence cannot impersonate full capture or text correction', () => {
  const input = fixture('input-text');
  input.seal_reason = 'live_transcript_policy';
  input.origin = 'live_fragment';
  input.input_evidence = 'live_policy_observed';
  input.policy_version = '1';
  input.transcript_revision = '1';
  input.audio = {
    audio_epoch: '7',
    first_frame_seq: '1',
    last_frame_seq: '2',
    start_sample: '0',
    end_sample: '320',
  };
  assert(validators['InputSnapshot'](input));
  assert.deepEqual(semanticErrors('InputSnapshot', input), []);
  const fake = { ...input, input_evidence: 'full_audio_segment' };
  assert(!validators['InputSnapshot'](fake));
  assert(
    !validators['InputSnapshot']({ ...input, seal_reason: 'user_corrected' }),
  );
  assert(!validators['InputSnapshot']({ ...input, policy_version: null }));
  input.audio.end_sample = '0';
  assert.deepEqual(semanticErrors('InputSnapshot', input), ['sample_order']);
});

test('label actions reject no-op and overlapping add/remove semantics', () => {
  const intent = fixture('intent-h01');
  intent.action.remove = ['follow-up'];
  assert(validators['LabelOperationIntent'](intent));
  assert.deepEqual(semanticErrors('LabelOperationIntent', intent), [
    'conflicting_labels',
  ]);
  intent.action = { kind: 'mail.labels.change', add: [], remove: [] };
  assert.deepEqual(semanticErrors('LabelOperationIntent', intent), [
    'empty_change',
  ]);
});

test('corrections need a target; new requests cannot target an old workflow', () => {
  const wire = fixture('wire-label');
  wire.relation = 'correction';
  assert.deepEqual(semanticErrors('WireResponse', wire), ['relation_target']);
  wire.target_workflow_id = '00000000-0000-4000-8000-000000000061';
  assert.deepEqual(semanticErrors('WireResponse', wire), []);
  wire.relation = 'new';
  assert.deepEqual(semanticErrors('WireResponse', wire), ['relation_target']);
});

test('budget facts distinguish R/M, uncertain usage and credit settlement', () => {
  const value = fixture('budget-pending');
  const money = (amount) => ({ currency: 'USD', amount });
  assert.deepEqual(semanticErrors('BudgetReservation', value), []);
  value.reserved_amount = money('401');
  assert(
    semanticErrors('BudgetReservation', value).includes(
      'reservation_exceeds_max',
    ),
  );
  value.reserved_amount = money('100');
  value.actual_gross = money('0');
  assert(
    semanticErrors('BudgetReservation', value).includes('unconfirmed_usage'),
  );
  value.status = 'settled';
  assert(
    semanticErrors('BudgetReservation', value).includes('missing_settlement'),
  );
  value.provider_reconciliation_id = 'synthetic-receipt';
  value.actual_gross = money('300');
  value.credit_applied = money('300');
  value.additional_spend = money('0');
  assert(
    semanticErrors('BudgetReservation', value).includes('missing_credit_cycle'),
  );
  value.credit_cycle_id = 'synthetic-cycle';
  assert.deepEqual(semanticErrors('BudgetReservation', value), []);
  value.additional_spend = money('1');
  assert(semanticErrors('BudgetReservation', value).includes('settlement_sum'));
  value.additional_spend = { currency: 'JPY', amount: '0' };
  assert(
    semanticErrors('BudgetReservation', value).includes('currency_mismatch'),
  );
  value.actual_gross = money('500');
  value.additional_spend = money('200');
  assert.deepEqual(
    semanticErrors('BudgetReservation', value),
    [],
    'M overrun must remain recordable; stopping future work is a Core guard',
  );
});

test('metadata events cannot carry mail, transcripts or authorization', () => {
  const event = fixture('metadata-event');
  for (const field of ['body', 'recipients', 'transcript', 'approved', 'token'])
    assert(
      !validators['EventEnvelope']({ ...event, [field]: 'forbidden' }),
      field,
    );
});

test('unknown operation results cannot offer retry or claim success', () => {
  const value = fixture('operation-unknown');
  value.allowed_actions.push('retry');
  assert(semanticErrors('OperationSnapshot', value).includes('unknown_retry'));
  value.allowed_actions = ['reconcile'];
  value.state = 'succeeded';
  assert(
    semanticErrors('OperationSnapshot', value).includes(
      'missing_success_evidence',
    ),
  );
  value.result.status = 'confirmed_success';
  assert.deepEqual(semanticErrors('OperationSnapshot', value), []);
  value.state = 'preparing';
  assert(
    semanticErrors('OperationSnapshot', value).includes('inconsistent_success'),
  );
});

test('unknown and expired credit observations are not confirmed balances', () => {
  const value = fixture('credit-unknown');
  assert(validators['CreditObservation'](value));
  value.status = 'observed';
  assert(
    semanticErrors('CreditObservation', value).includes(
      'missing_observed_balance',
    ),
  );
  value.balance = { currency: 'USD', amount: '1000' };
  assert.deepEqual(semanticErrors('CreditObservation', value), []);
  value.observed_at = value.expires_at;
  assert(
    semanticErrors('CreditObservation', value).includes('expired_observation'),
  );
});

test('synthetic evidence refers to the exact source revision and UTF-16 range', () => {
  const input = fixture('input-text');
  const value = fixture('interpretation-label');
  for (const evidence of value.evidence) {
    assert.equal(evidence.input_id, input.input_id);
    assert.equal(evidence.request_revision, input.request_revision);
    assert.equal(
      input.text.slice(evidence.start_utf16, evidence.end_utf16),
      evidence.quote,
    );
    assert.deepEqual(semanticErrors('InputFieldEvidence', evidence), []);
    assert.deepEqual(
      semanticErrors('InputFieldEvidence', {
        ...evidence,
        end_utf16: evidence.start_utf16,
      }),
      ['quote_range'],
    );
  }
  assert(validators['Interpretation'](value));
  assert.deepEqual(semanticErrors('Interpretation', value), []);
  const stale = structuredClone(value);
  stale.evidence[0].request_revision = '2';
  assert.deepEqual(semanticErrors('Interpretation', stale), [
    'evidence_input_mismatch',
  ]);
  const empty = structuredClone(value);
  empty.evidence[0].field = 'title';
  assert.deepEqual(semanticErrors('Interpretation', empty), [
    'evidence_for_empty_field',
  ]);
});

test('model plan is candidate-only and does not activate fallbacks', async () => {
  const plan = parseStrictJson(
    await readFile(
      new URL('packages/contracts/model-evaluation.json', root),
      'utf8',
    ),
  );
  assert(validators['ModelEvaluationPlan'](plan));
  assert(
    !validators['ModelEvaluationPlan']({
      ...plan,
      automatic_paid_fallback: true,
    }),
  );
  plan.candidates[0].status = 'active';
  assert(!validators['ModelEvaluationPlan'](plan));
});
