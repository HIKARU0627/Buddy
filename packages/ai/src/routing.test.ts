import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProfile } from '@buddy/contracts';
import {
  MODEL_TASKS,
  TASK_RULES,
  modelProfileErrors,
  providerConcurrencyLimits,
  resolveModelRoute,
  routingErrors,
  type ModelRoutingConfig,
} from './routing.js';
import { syntheticProfile } from './testing.js';

// 手で書いた合成の profile。endpoint は .invalid で、実 API・個人の設定を持たない。
const voice = syntheticProfile({
  profile_id: 'voice-primary',
  role: 'voice',
  provider: 'voice-cloud',
  reasoning: null,
  structured_output: 'none',
  verified_capabilities: [],
});
const intent = syntheticProfile({
  profile_id: 'intent-primary',
  role: 'intent',
  provider: 'cloud-intent',
  verified_capabilities: ['json_schema_strict', 'reasoning:low'],
});
const backgroundLow = syntheticProfile({
  profile_id: 'background-low',
  role: 'background_text',
  provider: 'cloud-background',
  reasoning: 'low',
  max_concurrency: 1,
  verified_capabilities: ['json_schema_strict', 'reasoning:low'],
});
const replyDraft = syntheticProfile({
  profile_id: 'reply-draft',
  role: 'background_text',
  provider: 'cloud-reply',
  reasoning: 'low',
  max_concurrency: 2,
  verified_capabilities: ['json_schema_strict', 'reasoning:low'],
});
const backgroundMedium = syntheticProfile({
  profile_id: 'background-medium',
  role: 'background_text',
  provider: 'cloud-background',
  reasoning: 'medium',
  max_concurrency: 1,
  verified_capabilities: ['json_schema_strict', 'reasoning:medium'],
});
const consultHigh = syntheticProfile({
  profile_id: 'consult-high',
  role: 'advanced_consult',
  provider: 'cloud-consult',
  reasoning: 'high',
  max_concurrency: 1,
  verified_capabilities: ['json_schema_strict', 'reasoning:high'],
});
const localAsr = syntheticProfile({
  profile_id: 'local-asr',
  role: 'local_asr',
  provider: 'local',
  reasoning: null,
  structured_output: 'none',
  price_version: null,
  max_concurrency: 1,
  verified_capabilities: [],
});

const profiles: ModelProfile[] = [
  voice,
  intent,
  backgroundLow,
  backgroundMedium,
  replyDraft,
  consultHigh,
  localAsr,
];

const config = (
  overrides: Partial<ModelRoutingConfig> = {},
): ModelRoutingConfig => ({
  profiles,
  routes: {
    voice_reply: 'voice-primary',
    intent_judgment: 'intent-primary',
    text_chat: 'intent-primary',
    intent_shadow: null,
    mail_extraction: 'background-low',
    reply_draft: 'reply-draft',
    research_summary: 'background-medium',
    consult: 'consult-high',
    memory_extraction: 'background-low',
    conversation_summary: 'background-low',
    local_asr: 'local-asr',
  },
  verified_price_versions: ['price-2026-01'],
  ...overrides,
});

test('every task has a hand-written rule with a consistent lane and priority', () => {
  assert.deepEqual(Object.keys(TASK_RULES), [...MODEL_TASKS]);
  for (const task of MODEL_TASKS) {
    const rule = TASK_RULES[task];
    assert(rule.max_timeout_ms > 0, task);
    if (rule.lane === 'A')
      assert.equal(rule.priority, 'P0', `${task} lane A must be P0 only`);
    if (rule.lane === 'B')
      assert.notEqual(rule.priority, 'P0', `${task} lane B must not be P0`);
    if (rule.shadow) assert.equal(rule.lane, 'B', `${task} shadow uses lane B`);
    if (rule.shadow) assert.equal(rule.required, false, task);
  }
});

test('the valid synthetic routing has no errors', () => {
  assert.deepEqual(routingErrors(config()), []);
  assert.deepEqual(providerConcurrencyLimits(config()), {
    'voice-cloud': 2,
    'cloud-intent': 2,
    'cloud-background': 1,
    'cloud-reply': 2,
    'cloud-consult': 1,
    local: 1,
  });
});

test('a required task without a route is rejected', () => {
  const routes = { ...config().routes, intent_judgment: null };
  assert.deepEqual(routingErrors(config({ routes })), [
    'required_route_missing:intent_judgment',
  ]);
});

test('a route to an unknown profile is rejected', () => {
  const routes = { ...config().routes, intent_judgment: 'missing-profile' };
  assert.deepEqual(routingErrors(config({ routes })), [
    'unknown_profile:intent_judgment',
  ]);
});

test('a profile whose role differs from the job is rejected', () => {
  const routes = { ...config().routes, text_chat: 'reply-draft' };
  assert.deepEqual(routingErrors(config({ routes })), [
    'role_mismatch:text_chat',
  ]);
});

test('a reasoning level that differs from the job table is rejected', () => {
  const wrong = syntheticProfile({
    profile_id: 'intent-medium',
    role: 'intent',
    provider: 'cloud-intent',
    reasoning: 'medium',
    verified_capabilities: ['json_schema_strict', 'reasoning:medium'],
  });
  const routes = { ...config().routes, intent_judgment: 'intent-medium' };
  assert.deepEqual(
    routingErrors(config({ profiles: [...profiles, wrong], routes })),
    ['reasoning_mismatch:intent_judgment'],
  );
});

test('structured output and verified capabilities are required for structured jobs', () => {
  const noStructured = syntheticProfile({
    profile_id: 'intent-none',
    role: 'intent',
    provider: 'cloud-intent',
    structured_output: 'none',
    verified_capabilities: ['reasoning:low'],
  });
  assert.deepEqual(
    routingErrors(
      config({
        profiles: [...profiles, noStructured],
        routes: { ...config().routes, intent_judgment: 'intent-none' },
      }),
    ),
    ['structured_output_missing:intent_judgment'],
  );

  const unverified = syntheticProfile({
    profile_id: 'intent-unverified',
    role: 'intent',
    provider: 'cloud-intent',
    verified_capabilities: ['reasoning:low'],
  });
  assert.deepEqual(
    routingErrors(
      config({
        profiles: [...profiles, unverified],
        routes: { ...config().routes, intent_judgment: 'intent-unverified' },
      }),
    ),
    ['capability_unverified'],
  );
});

test('a paid profile needs a finite output limit and a verified price version', () => {
  const noLimit = syntheticProfile({
    profile_id: 'intent-no-limit',
    role: 'intent',
    provider: 'cloud-intent',
    output_limit_tokens: null,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  assert.deepEqual(
    routingErrors(
      config({
        profiles: [...profiles, noLimit],
        routes: { ...config().routes, intent_judgment: 'intent-no-limit' },
      }),
    ),
    ['output_limit_missing:intent_judgment'],
  );

  assert.deepEqual(
    routingErrors(
      config({
        verified_price_versions: [],
      }),
    ),
    [
      'price_version_unverified:voice_reply',
      'price_version_unverified:intent_judgment',
      'price_version_unverified:text_chat',
      'price_version_unverified:mail_extraction',
      'price_version_unverified:reply_draft',
      'price_version_unverified:research_summary',
      'price_version_unverified:consult',
      'price_version_unverified:memory_extraction',
      'price_version_unverified:conversation_summary',
    ],
  );
});

test('a timeout above the job limit is rejected', () => {
  const slow = syntheticProfile({
    profile_id: 'intent-slow',
    role: 'intent',
    provider: 'cloud-intent',
    timeout_ms: 20_001,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  assert.deepEqual(
    routingErrors(
      config({
        profiles: [...profiles, slow],
        routes: { ...config().routes, intent_judgment: 'intent-slow' },
      }),
    ),
    ['timeout_out_of_range:intent_judgment'],
  );
});

test('duplicate profile ids and differing provider concurrency are rejected', () => {
  const duplicate = syntheticProfile({
    profile_id: 'intent-primary',
    role: 'intent',
    provider: 'cloud-intent',
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  assert.deepEqual(
    routingErrors(config({ profiles: [...profiles, duplicate] })),
    ['duplicate_profile:intent-primary'],
  );

  const wide = syntheticProfile({
    profile_id: 'background-wide',
    role: 'background_text',
    provider: 'cloud-background',
    reasoning: 'low',
    max_concurrency: 2,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  assert.deepEqual(routingErrors(config({ profiles: [...profiles, wide] })), [
    'provider_concurrency_mismatch:cloud-background',
  ]);
});

test('QA37: a concurrency-1 provider is not shared between P0 and P1/P2', () => {
  const sharedIntent = syntheticProfile({
    profile_id: 'shared-intent',
    role: 'intent',
    provider: 'shared',
    max_concurrency: 1,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  const sharedBackground = syntheticProfile({
    profile_id: 'shared-background',
    role: 'background_text',
    provider: 'shared',
    reasoning: 'low',
    max_concurrency: 1,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  const routes = {
    ...config().routes,
    intent_judgment: 'shared-intent',
    text_chat: 'shared-intent',
    mail_extraction: 'shared-background',
    reply_draft: 'shared-background',
    memory_extraction: 'shared-background',
    conversation_summary: 'shared-background',
  };
  assert.deepEqual(
    routingErrors(
      config({
        profiles: [...profiles, sharedIntent, sharedBackground],
        routes,
      }),
    ),
    ['provider_shared_between_priorities:shared'],
  );
});

test('QA37: the effective local limit rejects sharing local between P0 and P2', () => {
  // ローカルは max_concurrency が 2 でも実効 1。宣言値だけを見ると共有を見逃す。
  const localIntent = syntheticProfile({
    profile_id: 'local-intent',
    role: 'intent',
    provider: 'local',
    max_concurrency: 2,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  const localExtraction = syntheticProfile({
    profile_id: 'local-extraction',
    role: 'background_text',
    provider: 'local',
    reasoning: 'low',
    max_concurrency: 2,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  const localProfiles = profiles.map((profile) =>
    profile.profile_id === 'local-asr'
      ? { ...profile, max_concurrency: 2 }
      : profile,
  );
  const routes = {
    ...config().routes,
    intent_judgment: 'local-intent',
    text_chat: 'local-intent',
    mail_extraction: 'local-extraction',
  };
  assert.deepEqual(
    routingErrors(
      config({
        profiles: [...localProfiles, localIntent, localExtraction],
        routes,
      }),
    ),
    ['provider_shared_between_priorities:local'],
  );
});

test('p95 reservation is accepted only for the intent judgment route', () => {
  const p95Intent = syntheticProfile({
    profile_id: 'intent-p95',
    role: 'intent',
    provider: 'cloud-intent',
    reservation_method: 'measured_p95',
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  const onlyIntent = {
    ...config().routes,
    intent_judgment: 'intent-p95',
  };
  assert.deepEqual(
    routingErrors(
      config({ profiles: [...profiles, p95Intent], routes: onlyIntent }),
    ),
    [],
  );
  // 同じ intent の役割でも、文字会話へ流用したら拒否する。
  assert.deepEqual(
    routingErrors(
      config({
        profiles: [...profiles, p95Intent],
        routes: { ...onlyIntent, text_chat: 'intent-p95' },
      }),
    ),
    ['p95_not_judgment:text_chat'],
  );
});

test('p95 reservation is limited to intent profiles and local ASR uses the local provider', () => {
  const p95Background = syntheticProfile({
    profile_id: 'p95-background',
    role: 'background_text',
    provider: 'cloud-background',
    reasoning: 'low',
    reservation_method: 'measured_p95',
    max_concurrency: 1,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  assert.deepEqual(modelProfileErrors(p95Background), ['p95_not_intent']);

  const remoteAsr = syntheticProfile({
    profile_id: 'remote-asr',
    role: 'local_asr',
    provider: 'cloud-intent',
    reasoning: null,
    structured_output: 'none',
    verified_capabilities: [],
  });
  assert.deepEqual(modelProfileErrors(remoteAsr), ['local_provider_required']);
});

test('resolveModelRoute returns the rule and profile for a routed job', () => {
  const route = resolveModelRoute(config(), 'intent_judgment');
  assert.equal(route.ok, true);
  if (route.ok) {
    assert.equal(route.rule.priority, 'P0');
    assert.equal(route.profile.profile_id, 'intent-primary');
  }
  assert.deepEqual(resolveModelRoute(config(), 'intent_shadow'), {
    ok: false,
    reasons: ['route_missing'],
  });
});
