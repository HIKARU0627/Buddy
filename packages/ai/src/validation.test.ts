import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ModelUsage, WireResponse } from '@buddy/contracts';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { modelOutcomeFromAdapter } from './validation.js';

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;

// 契約の JSON Schema を正本として、手書きの fixture を検査する。実装から期待値を作らない。
const schema = JSON.parse(
  readFileSync(
    new URL('../../contracts/schemas/buddy.schema.json', import.meta.url),
    'utf8',
  ),
) as { $id: string };
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  validateFormats: true,
});
addFormats(ajv);
ajv.addSchema(schema);
const wire = ajv.getSchema(`${schema.$id}#/$defs/WireResponse`);
const outcomeSchema = ajv.getSchema(`${schema.$id}#/$defs/ModelOutcome`);
if (wire === undefined || outcomeSchema === undefined)
  throw new Error('contract schema is missing WireResponse or ModelOutcome');

const cases = JSON.parse(
  readFileSync(
    new URL(
      '../../contracts/fixtures/response-plan-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  outcomes: {
    id: string;
    value: { kind: string; value?: WireResponse; usage?: ModelUsage | null };
  }[];
};
const okCase = cases.outcomes.find((entry) => entry.id === 'qa02-outcome-ok');
if (okCase === undefined || okCase.value.usage === undefined)
  throw new Error('qa02-outcome-ok fixture is missing');
const wireValue = JSON.parse(
  JSON.stringify(okCase.value.value),
) as WireResponse;
const usage = okCase.value.usage as ModelUsage;

const options = {
  profile_id: 'intent-primary',
  schema: { valid: (value: unknown) => wire(value) === true },
  output_limit_tokens: 500,
};

const response = (
  text: string,
  overrides: Partial<{
    usage: ModelUsage | null;
    refused: boolean;
    truncated: boolean;
  }> = {},
) => ({
  kind: 'response' as const,
  text,
  usage,
  provider_request_id: 'provider-request-1',
  refused: false,
  truncated: false,
  ...overrides,
});

test('a valid WireResponse becomes an ok ModelOutcome that satisfies the contract', () => {
  const result = modelOutcomeFromAdapter(
    response(JSON.stringify(wireValue)),
    options,
  );
  assert.equal(result.detail, null);
  assert.deepEqual(result.outcome, {
    kind: 'ok',
    value: wireValue,
    profile_id: 'intent-primary',
    usage,
    retryable: false,
  });
  assert.equal(outcomeSchema(result.outcome), true);
});

test('a successful response without usage keeps the output with usage_complete false', () => {
  const result = modelOutcomeFromAdapter(
    response(JSON.stringify(wireValue), { usage: null }),
    options,
  );
  assert.equal(result.detail, null);
  assert.deepEqual(result.outcome, {
    kind: 'ok',
    value: wireValue,
    profile_id: 'intent-primary',
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: null,
      usage_complete: false,
    },
    retryable: false,
  });
  assert.equal(outcomeSchema(result.outcome), true);
});

test('distinguishes empty, mid-JSON, and schema-invalid outputs', () => {
  const empty = modelOutcomeFromAdapter(response('   '), options);
  assert.equal(empty.outcome.kind, 'invalid_schema');
  assert.equal(empty.detail, 'empty');
  assert.equal(empty.outcome.retryable, false);

  const midJson = modelOutcomeFromAdapter(response('{"intent":'), options);
  assert.equal(midJson.outcome.kind, 'invalid_schema');
  assert.equal(midJson.detail, 'json_parse');

  const wrongType = modelOutcomeFromAdapter(
    response(JSON.stringify({ ...wireValue, confidence: 'high' })),
    options,
  );
  assert.equal(wrongType.outcome.kind, 'invalid_schema');
  assert.equal(wrongType.detail, 'schema');
});

test('a semantic rejection is invalid_semantics and keeps the reasons out of the contract', () => {
  const value: WireResponse = {
    ...wireValue,
    args: { ...wireValue.args, title: 'not allowed for smalltalk' },
  };
  const result = modelOutcomeFromAdapter(response(JSON.stringify(value)), {
    ...options,
    semantics: {
      errors: (candidate) =>
        candidate.args.title === null ? [] : ['title_not_allowed'],
    },
  });
  assert.equal(result.outcome.kind, 'invalid_semantics');
  assert.equal(result.detail, 'semantics');
  assert.deepEqual(result.reasons, ['title_not_allowed']);
  assert.equal(outcomeSchema(result.outcome), true);
});

test('provider refusal and truncation are kept as their own outcomes', () => {
  const refused = modelOutcomeFromAdapter(
    response(JSON.stringify(wireValue), { refused: true }),
    options,
  );
  assert.deepEqual(refused.outcome, {
    kind: 'refused',
    retryable: false,
    usage,
  });
  assert.equal(refused.detail, 'provider_refused');

  const truncated = modelOutcomeFromAdapter(
    response(JSON.stringify(wireValue), { truncated: true }),
    options,
  );
  assert.deepEqual(truncated.outcome, {
    kind: 'truncated',
    retryable: false,
    usage,
  });
  assert.equal(truncated.detail, 'provider_truncated');
});

test('an output above the profile limit or the character guard is truncated', () => {
  const overTokens = modelOutcomeFromAdapter(
    response(JSON.stringify(wireValue), {
      usage: { ...usage, output_tokens: 501 },
    }),
    options,
  );
  assert.equal(overTokens.outcome.kind, 'truncated');
  assert.equal(overTokens.detail, 'output_limit');

  const overChars = modelOutcomeFromAdapter(
    response(JSON.stringify(wireValue)),
    {
      ...options,
      max_output_chars: 10,
    },
  );
  assert.equal(overChars.outcome.kind, 'truncated');
  assert.equal(overChars.detail, 'chars_limit');
});

test('transport failures keep the retryable meaning and observed usage', () => {
  const timeout = modelOutcomeFromAdapter({ kind: 'timeout', usage }, options);
  assert.deepEqual(timeout.outcome, {
    kind: 'timeout',
    retryable: true,
    usage,
  });
  assert.equal(timeout.detail, null);

  const unavailable = modelOutcomeFromAdapter(
    { kind: 'unavailable', usage: null },
    options,
  );
  assert.deepEqual(unavailable.outcome, {
    kind: 'unavailable',
    retryable: true,
    usage: null,
  });

  const cancelled = modelOutcomeFromAdapter(
    { kind: 'cancelled', usage },
    options,
  );
  assert.deepEqual(cancelled.outcome, {
    kind: 'cancelled',
    retryable: false,
    usage,
  });
});
