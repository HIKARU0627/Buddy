import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProfile, ModelUsage } from '@buddy/contracts';
import { createHttpAdapter } from './adapter.js';
import type { ProviderCodec } from './provider.js';
import { createFakeAdapter, createFakeTransport } from './testing.js';
import type { ModelCommand } from './types.js';

// 合成の profile。endpoint は予約済みの .invalid ドメインで、実 API・個人の設定を持たない。
const profile: ModelProfile = {
  profile_id: 'intent-primary',
  role: 'intent',
  provider: 'synthetic',
  endpoint: 'https://llm.invalid/v1/complete',
  api_version: null,
  sdk_version: null,
  model_request_id: 'synthetic-model-1',
  reasoning: 'low',
  structured_output: 'json_schema_strict',
  output_limit_tokens: 500,
  timeout_ms: 8000,
  max_concurrency: 2,
  price_version: 'price-2026-01',
  reservation_method: 'max_liability',
  verified_capabilities: ['json_schema_strict', 'reasoning:low'],
};

const usage: ModelUsage = {
  input_tokens: 100,
  cached_input_tokens: 0,
  output_tokens: 20,
  reasoning_tokens: 5,
  usage_complete: true,
};

const command: ModelCommand = {
  request_id: '00000000-0000-4000-8000-000000000401',
  role: 'intent',
  profile,
  messages: [{ role: 'user', content: '合成の発話' }],
  output_schema: null,
};

const codec: ProviderCodec = {
  provider: 'synthetic',
  encode(value) {
    return {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: value.profile.model_request_id,
        messages: value.messages,
      }),
    };
  },
  decode(response) {
    const body = JSON.parse(response.body) as {
      id?: string;
      text?: string;
      usage?: ModelUsage | null;
      refused?: boolean;
      finish?: string;
    };
    return {
      kind: 'response',
      text: body.text ?? '',
      usage: body.usage ?? null,
      provider_request_id: body.id ?? null,
      refused: body.refused === true,
      truncated: body.finish === 'length',
    };
  },
};

const okResponse = {
  kind: 'response' as const,
  response: {
    status: 200,
    headers: {},
    body: JSON.stringify({
      id: 'provider-request-1',
      text: '{"intent":"smalltalk"}',
      usage,
      finish: 'stop',
    }),
  },
};

test('the fake adapter returns the scripted results in order and records commands', async () => {
  const adapter = createFakeAdapter([
    { kind: 'timeout', usage: null },
    {
      kind: 'response',
      text: 'ok',
      usage,
      provider_request_id: null,
      refused: false,
      truncated: false,
    },
  ]);
  assert.deepEqual(await adapter.complete(command), {
    kind: 'timeout',
    usage: null,
  });
  assert.equal((await adapter.complete(command)).kind, 'response');
  assert.equal(adapter.commands.length, 2);
  assert.equal(adapter.commands[0]?.profile.profile_id, 'intent-primary');
});

test('the HTTP adapter sends the profile endpoint and timeout and decodes the response', async () => {
  const transport = createFakeTransport(okResponse);
  const adapter = createHttpAdapter(transport, codec);
  const result = await adapter.complete(command);
  assert.equal(result.kind, 'response');
  assert.equal(transport.requests.length, 1);
  const request = transport.requests[0];
  assert.equal(request?.url, profile.endpoint);
  assert.equal(request?.timeout_ms, profile.timeout_ms);
  assert.equal(request?.method, 'POST');
  assert.deepEqual(JSON.parse(request?.body ?? ''), {
    model: 'synthetic-model-1',
    messages: [{ role: 'user', content: '合成の発話' }],
  });
  if (result.kind === 'response') {
    assert.equal(result.text, '{"intent":"smalltalk"}');
    assert.deepEqual(result.usage, usage);
    assert.equal(result.provider_request_id, 'provider-request-1');
    assert.equal(result.truncated, false);
  }
});

test('a timeout is reported without a second send', async () => {
  const transport = createFakeTransport([{ kind: 'timeout' }, okResponse]);
  const adapter = createHttpAdapter(transport, codec);
  const result = await adapter.complete(command);
  assert.deepEqual(result, { kind: 'timeout', usage: null });
  assert.equal(transport.requests.length, 1, 'no automatic retry');
});

test('an unavailable transport is reported without a second send', async () => {
  const transport = createFakeTransport([{ kind: 'unavailable' }, okResponse]);
  const adapter = createHttpAdapter(transport, codec);
  const result = await adapter.complete(command);
  assert.deepEqual(result, { kind: 'unavailable', usage: null });
  assert.equal(transport.requests.length, 1);
});

test('cancellation before sending does not send', async () => {
  const transport = createFakeTransport(okResponse);
  const adapter = createHttpAdapter(transport, codec);
  const result = await adapter.complete(command, { aborted: true });
  assert.deepEqual(result, { kind: 'cancelled', usage: null });
  assert.equal(transport.requests.length, 0);
});

test('cancellation after receiving keeps the observed usage', async () => {
  const transport = createFakeTransport(okResponse);
  const adapter = createHttpAdapter(transport, codec);
  const cancellation = {
    get aborted() {
      return transport.requests.length > 0;
    },
  };
  const result = await adapter.complete(command, cancellation);
  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(result.usage, usage);
});

test('a malformed provider envelope becomes unavailable instead of throwing', async () => {
  const transport = createFakeTransport({
    kind: 'response',
    response: { status: 200, headers: {}, body: 'not json' },
  });
  const adapter = createHttpAdapter(transport, codec);
  const result = await adapter.complete(command);
  assert.deepEqual(result, { kind: 'unavailable', usage: null });
});
