import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { WireResponse } from '@buddy/contracts';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { createHttpAdapter } from './adapter.js';
import { createGeminiCodec, geminiWireSchema } from './gemini-codec.js';
import { judgeIntent } from './intent-judgment.js';
import type { IntentJudgmentInput } from './intent-judgment.js';
import { createFakeTransport, syntheticProfile } from './testing.js';

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;

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
const wireValidate = ajv.getSchema(`${schema.$id}#/$defs/WireResponse`);
if (wireValidate === undefined) throw new Error('WireResponse is missing');
const validator = { valid: (value: unknown) => wireValidate(value) === true };
// Core が渡す出力の schema の形（根の $defs と WireResponse への参照）。
const outputSchema = {
  ...schema,
  $ref: '#/$defs/WireResponse',
};

const profile = syntheticProfile({
  profile_id: 'intent-primary',
  role: 'intent',
  provider: 'gemini',
  reasoning: 'low',
  output_limit_tokens: 500,
});
const input: IntentJudgmentInput = {
  utterance: '用事に歯医者の予約を追加して',
  today: '2026-11-03',
  candidates: [],
  open_workflows: [],
};
const emptyArgs = {
  target_candidate_id: null,
  start: null,
  end: null,
  due: null,
  title: null,
  body: null,
  subject: null,
  add_labels: null,
  remove_labels: null,
  task_change: null,
  memory_kind: null,
  query: null,
  device_name: null,
};
const wire: WireResponse = {
  intent: 'create_task',
  args: { ...emptyArgs, title: '歯医者の予約' },
  relation: 'new',
  target_workflow_id: null,
  reply_text: null,
  clarify_question: null,
  confidence: 0.95,
};

const envelope = (over: object = {}) =>
  JSON.stringify({
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(wire) }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 1500,
      cachedContentTokenCount: 1200,
      candidatesTokenCount: 80,
      thoughtsTokenCount: 30,
    },
    responseId: 'resp-1',
    ...over,
  });
const http = (body: string, status = 200) => ({
  kind: 'response' as const,
  response: { status, headers: {}, body },
});

test('the wire schema has no $ref, pattern, format, or annotations, and keeps the shape', () => {
  const sent = geminiWireSchema(outputSchema) as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  const text = JSON.stringify(sent);
  for (const dropped of ['$ref', '"pattern"', '"format"', '$defs', '$id'])
    assert.ok(!text.includes(dropped), dropped);
  assert.equal(sent.type, 'object');
  assert.equal(sent.additionalProperties, false);
  assert.deepEqual(sent.required, [
    'intent',
    'args',
    'relation',
    'target_workflow_id',
    'reply_text',
    'clarify_question',
    'confidence',
  ]);
  // 列挙は残る（24 意図）。
  assert.equal(
    (sent.properties['intent'] as { enum: string[] }).enum.length,
    24,
  );
});

test('encode puts the fixed part in systemInstruction, pins thinkingLevel, and omits temperature', async () => {
  const transport = createFakeTransport(http(envelope()));
  const adapter = createHttpAdapter(transport, createGeminiCodec());
  const result = await judgeIntent(adapter, {
    request_id: 'r',
    profile,
    input,
    output_schema: outputSchema,
    schema: validator,
  });
  assert.equal(transport.requests.length, 1);
  const request = transport.requests[0];
  assert.equal(request?.url, 'https://llm.invalid/v1/complete');
  assert.equal(request?.timeout_ms, 8000);
  assert.deepEqual(request?.headers, { 'content-type': 'application/json' });
  const body = JSON.parse(request?.body ?? '') as {
    systemInstruction: { parts: { text: string }[] };
    contents: { role: string; parts: { text: string }[] }[];
    generationConfig: Record<string, unknown>;
  };
  assert.ok(body.systemInstruction.parts[0]?.text.includes('意図判定器'));
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0]?.role, 'user');
  assert.ok(body.contents[0]?.parts[0]?.text.includes('歯医者の予約'));
  assert.ok(!body.systemInstruction.parts[0]?.text.includes('歯医者の予約'));
  assert.equal(body.generationConfig['responseMimeType'], 'application/json');
  assert.equal(body.generationConfig['maxOutputTokens'], 500);
  assert.deepEqual(body.generationConfig['thinkingConfig'], {
    thinkingLevel: 'low',
  });
  assert.ok(!('temperature' in body.generationConfig));
  assert.ok(!request?.body.includes('authorization'));
  // 応答は契約の ModelOutcome になり、usage は思考を含む出力と内数の cached で表す。
  assert.equal(result.outcome.kind, 'ok');
  assert.deepEqual(result.outcome.usage, {
    input_tokens: 1500,
    cached_input_tokens: 1200,
    output_tokens: 110,
    reasoning_tokens: 30,
    usage_complete: true,
  });
  assert.equal(
    result.judgment.kind === 'intent' && result.judgment.intent,
    'create_task',
  );
});

test('decode distinguishes refused, truncated, thought parts, missing usage, and bad envelopes', async () => {
  const run = async (step: ReturnType<typeof http>) => {
    const transport = createFakeTransport(step);
    const adapter = createHttpAdapter(transport, createGeminiCodec());
    const result = await judgeIntent(adapter, {
      request_id: 'r',
      profile,
      input,
      output_schema: outputSchema,
      schema: validator,
    });
    assert.equal(transport.requests.length, 1);
    return result;
  };
  const blocked = await run(
    http(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })),
  );
  assert.deepEqual(blocked.judgment, {
    kind: 'failed',
    failure: 'refused',
    retryable: false,
  });
  const safety = await run(
    http(
      envelope({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
      }),
    ),
  );
  assert.equal(safety.outcome.kind, 'refused');
  const cut = await run(
    http(
      envelope({
        candidates: [
          {
            finishReason: 'MAX_TOKENS',
            content: { parts: [{ text: '{"intent":' }] },
          },
        ],
      }),
    ),
  );
  assert.equal(cut.outcome.kind, 'truncated');
  // 思考の要約は出力に混ぜない。
  const thought = await run(
    http(
      envelope({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { text: '考え中', thought: true },
                { text: JSON.stringify(wire) },
              ],
            },
          },
        ],
      }),
    ),
  );
  assert.equal(thought.outcome.kind, 'ok');
  // usage が読めなくても出力は捨てず、usage_complete は false（推測で埋めない。U191）。
  const noUsage = await run(http(envelope({ usageMetadata: undefined })));
  assert.equal(noUsage.outcome.kind, 'ok');
  assert.equal(noUsage.outcome.usage?.usage_complete, false);
  // 想定外の封筒・状態・終了理由は利用不可（送った可能性があるので再送しない）。
  for (const step of [
    http('not json'),
    http(JSON.stringify({ candidates: [] })),
    http(envelope({ candidates: [{ finishReason: 'OTHER', content: {} }] })),
    http('{}', 429),
    http('{}', 500),
  ]) {
    const bad = await run(step);
    assert.deepEqual(bad.judgment, {
      kind: 'failed',
      failure: 'unavailable',
      retryable: true,
    });
  }
});

test('timeout and unavailable transports become failures and are sent once', async () => {
  for (const [step, failure] of [
    [{ kind: 'timeout' as const }, 'timeout'],
    [{ kind: 'unavailable' as const }, 'unavailable'],
  ] as const) {
    const transport = createFakeTransport(step);
    const adapter = createHttpAdapter(transport, createGeminiCodec());
    const result = await judgeIntent(adapter, {
      request_id: 'r',
      profile,
      input,
      output_schema: outputSchema,
      schema: validator,
    });
    assert.equal(
      result.judgment.kind === 'failed' && result.judgment.failure,
      failure,
    );
    assert.equal(transport.requests.length, 1);
  }
});
