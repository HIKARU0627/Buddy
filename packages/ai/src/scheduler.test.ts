import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProfile } from '@buddy/contracts';
import {
  planModelCalls,
  type CallDecision,
  type SchedulerState,
} from './scheduler.js';
import type { ModelRoutingConfig } from './routing.js';
import { syntheticProfile } from './testing.js';

const intent = syntheticProfile({
  profile_id: 'intent-primary',
  role: 'intent',
  provider: 'cloud-a',
  verified_capabilities: ['json_schema_strict', 'reasoning:low'],
});
const research = syntheticProfile({
  profile_id: 'research-medium',
  role: 'background_text',
  provider: 'cloud-b',
  reasoning: 'medium',
  verified_capabilities: ['json_schema_strict', 'reasoning:medium'],
});
const extraction = syntheticProfile({
  profile_id: 'extraction-low',
  role: 'background_text',
  provider: 'cloud-c',
  reasoning: 'low',
  verified_capabilities: ['json_schema_strict', 'reasoning:low'],
});
const shadow = syntheticProfile({
  profile_id: 'shadow-minimal',
  role: 'intent',
  provider: 'cloud-d',
  reasoning: null,
  max_concurrency: 1,
  verified_capabilities: ['json_schema_strict'],
});
const local = syntheticProfile({
  profile_id: 'local-asr',
  role: 'local_asr',
  provider: 'local',
  reasoning: null,
  structured_output: 'none',
  price_version: null,
  max_concurrency: 1,
  verified_capabilities: [],
});

const profiles: ModelProfile[] = [intent, research, extraction, shadow, local];

const config: ModelRoutingConfig = {
  profiles,
  routes: {
    intent_judgment: 'intent-primary',
    text_chat: 'intent-primary',
    research_summary: 'research-medium',
    mail_extraction: 'extraction-low',
    intent_shadow: 'shadow-minimal',
    local_asr: 'local-asr',
  },
  verified_price_versions: ['price-2026-01'],
};

const noUnplanned = (decisions: readonly CallDecision[]): void => {
  for (const decision of decisions)
    if (!decision.admit)
      assert(
        !decision.reasons.includes('not_planned'),
        'every request must be planned',
      );
};

test('QA13: P0 and P1 are admitted, P2 waits, shadow is skipped', () => {
  const decisions = planModelCalls(
    config,
    { running: [], shadow_enabled: true, budget_available: true },
    [
      { task: 'intent_judgment' },
      { task: 'research_summary' },
      { task: 'mail_extraction' },
      { task: 'intent_shadow', shadow: true },
    ],
  );
  assert.deepEqual(decisions, [
    { admit: true, lane: 'A', priority: 'P0' },
    { admit: true, lane: 'B', priority: 'P1' },
    { admit: false, action: 'wait', reasons: ['lane_b_busy'] },
    { admit: false, action: 'skip', reasons: ['shadow_busy'] },
  ]);
  noUnplanned(decisions);
});

test('QA37: P0 does not wait for a running P2 on another provider', () => {
  const state: SchedulerState = {
    running: [{ task: 'mail_extraction', provider: 'cloud-c', shadow: false }],
  };
  const decisions = planModelCalls(config, state, [
    { task: 'intent_judgment' },
  ]);
  assert.deepEqual(decisions, [{ admit: true, lane: 'A', priority: 'P0' }]);
});

test('shadow runs on lane B only when nothing else is running or pending', () => {
  assert.deepEqual(
    planModelCalls(
      config,
      { running: [], shadow_enabled: true, budget_available: true },
      [{ task: 'intent_shadow', shadow: true }],
    ),
    [{ admit: true, lane: 'B', priority: 'P2' }],
  );
  assert.deepEqual(
    planModelCalls(config, { running: [], shadow_enabled: false }, [
      { task: 'intent_shadow', shadow: true },
    ]),
    [{ admit: false, action: 'skip', reasons: ['shadow_disabled'] }],
  );
  assert.deepEqual(
    planModelCalls(
      config,
      { running: [], shadow_enabled: true, budget_available: false },
      [{ task: 'intent_shadow', shadow: true }],
    ),
    [{ admit: false, action: 'skip', reasons: ['shadow_budget'] }],
  );
});

test('local generation is limited to one at a time', () => {
  const decisions = planModelCalls(
    config,
    {
      running: [{ task: 'local_asr', provider: 'local', shadow: false }],
    },
    [{ task: 'local_asr' }],
  );
  assert.deepEqual(decisions, [
    { admit: false, action: 'wait', reasons: ['local_limit'] },
  ]);
});

test('a provider concurrency limit of one renders the second lane as wait', () => {
  const singleIntent = syntheticProfile({
    profile_id: 'single-intent',
    role: 'intent',
    provider: 'single',
    max_concurrency: 1,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  const singleResearch = syntheticProfile({
    profile_id: 'single-research',
    role: 'background_text',
    provider: 'single',
    reasoning: 'medium',
    max_concurrency: 1,
    verified_capabilities: ['json_schema_strict', 'reasoning:medium'],
  });
  const decisions = planModelCalls(
    {
      profiles: [singleIntent, singleResearch],
      routes: {
        intent_judgment: 'single-intent',
        research_summary: 'single-research',
      },
      verified_price_versions: ['price-2026-01'],
    },
    { running: [] },
    [{ task: 'intent_judgment' }, { task: 'research_summary' }],
  );
  assert.deepEqual(decisions, [
    { admit: true, lane: 'A', priority: 'P0' },
    { admit: false, action: 'wait', reasons: ['provider_limit:single'] },
  ]);
  noUnplanned(decisions);
});
