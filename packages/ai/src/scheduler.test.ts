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

test('the job rule is the authority for shadow, and a conflicting flag is rejected', () => {
  // フラグを省略しても intent_shadow は影モードとして扱い、既定 OFF を迂回させない。
  assert.deepEqual(
    planModelCalls(config, { running: [], shadow_enabled: false }, [
      { task: 'intent_shadow' },
    ]),
    [{ admit: false, action: 'skip', reasons: ['shadow_disabled'] }],
  );
  // 影モードのジョブに false を明示する矛盾した要求は受け付けない。
  assert.deepEqual(
    planModelCalls(
      config,
      { running: [], shadow_enabled: true, budget_available: true },
      [{ task: 'intent_shadow', shadow: false }],
    ),
    [{ admit: false, action: 'wait', reasons: ['shadow_flag_mismatch'] }],
  );
  // 通常のジョブに影モードを名乗る要求も受け付けない。
  assert.deepEqual(
    planModelCalls(config, { running: [] }, [
      { task: 'intent_judgment', shadow: true },
    ]),
    [{ admit: false, action: 'wait', reasons: ['shadow_flag_mismatch'] }],
  );
});

test('a running shadow consumes lane B and the text concurrency', () => {
  const state: SchedulerState = {
    running: [{ task: 'intent_shadow', provider: 'cloud-d', shadow: true }],
    shadow_enabled: true,
    budget_available: true,
  };
  // 影モードが枠 B を使っている間、P1 は枠 B を待つ。P0 は枠 A で待たない。
  assert.deepEqual(
    planModelCalls(config, state, [
      { task: 'intent_judgment' },
      { task: 'research_summary' },
    ]),
    [
      { admit: true, lane: 'A', priority: 'P0' },
      { admit: false, action: 'wait', reasons: ['lane_b_busy'] },
    ],
  );
  assert.deepEqual(
    planModelCalls(config, state, [{ task: 'intent_judgment' }]),
    [{ admit: true, lane: 'A', priority: 'P0' }],
  );
  // 別の provider の影モードでも、枠 B が埋まっていれば重ねない。
  const altShadow = syntheticProfile({
    profile_id: 'shadow-alt',
    role: 'intent',
    provider: 'cloud-e',
    reasoning: null,
    max_concurrency: 1,
    verified_capabilities: ['json_schema_strict'],
  });
  assert.deepEqual(
    planModelCalls(
      {
        ...config,
        profiles: [...config.profiles, altShadow],
        routes: { ...config.routes, intent_shadow: 'shadow-alt' },
      },
      state,
      [{ task: 'intent_shadow' }],
    ),
    [{ admit: false, action: 'skip', reasons: ['shadow_wait'] }],
  );
});

test('a running call recorded with a conflicting shadow flag is still shadow', () => {
  const state: SchedulerState = {
    running: [{ task: 'intent_shadow', provider: 'cloud-d', shadow: false }],
    shadow_enabled: true,
    budget_available: true,
  };
  assert.deepEqual(
    planModelCalls(config, state, [{ task: 'research_summary' }]),
    [{ admit: false, action: 'wait', reasons: ['lane_b_busy'] }],
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

test('a local provider is limited to one generation even for text jobs', () => {
  const localIntent = syntheticProfile({
    profile_id: 'local-intent',
    role: 'intent',
    provider: 'local',
    max_concurrency: 2,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  const localResearch = syntheticProfile({
    profile_id: 'local-research',
    role: 'background_text',
    provider: 'local',
    reasoning: 'medium',
    max_concurrency: 2,
    verified_capabilities: ['json_schema_strict', 'reasoning:medium'],
  });
  const localConfig: ModelRoutingConfig = {
    profiles: [localIntent, localResearch],
    routes: {
      intent_judgment: 'local-intent',
      research_summary: 'local-research',
    },
    verified_price_versions: ['price-2026-01'],
  };
  assert.deepEqual(
    planModelCalls(localConfig, { running: [] }, [
      { task: 'intent_judgment' },
      { task: 'research_summary' },
    ]),
    [
      { admit: true, lane: 'A', priority: 'P0' },
      { admit: false, action: 'wait', reasons: ['local_limit'] },
    ],
  );
  // 実行中のローカルのテキスト生成も数える。
  assert.deepEqual(
    planModelCalls(
      localConfig,
      {
        running: [
          { task: 'research_summary', provider: 'local', shadow: false },
        ],
      },
      [{ task: 'intent_judgment' }],
    ),
    [{ admit: false, action: 'wait', reasons: ['local_limit'] }],
  );
});

test('a disabled shadow with no route is skipped instead of waiting', () => {
  const noShadowRoute: ModelRoutingConfig = {
    ...config,
    routes: { ...config.routes, intent_shadow: null },
  };
  assert.deepEqual(
    planModelCalls(noShadowRoute, { running: [] }, [{ task: 'intent_shadow' }]),
    [{ admit: false, action: 'skip', reasons: ['shadow_disabled'] }],
  );
  // 有効なのに経路がない設定は、設定の誤りとして待機にする。
  assert.deepEqual(
    planModelCalls(
      noShadowRoute,
      { running: [], shadow_enabled: true, budget_available: true },
      [{ task: 'intent_shadow' }],
    ),
    [{ admit: false, action: 'wait', reasons: ['route_missing'] }],
  );
});

test('a shadow request skips when the local generation slot is full', () => {
  const localExtraction = syntheticProfile({
    profile_id: 'local-extraction',
    role: 'background_text',
    provider: 'local',
    reasoning: 'low',
    max_concurrency: 1,
    verified_capabilities: ['json_schema_strict', 'reasoning:low'],
  });
  const localShadow = syntheticProfile({
    profile_id: 'local-shadow',
    role: 'intent',
    provider: 'local',
    reasoning: null,
    max_concurrency: 1,
    verified_capabilities: ['json_schema_strict'],
  });
  const localConfig: ModelRoutingConfig = {
    ...config,
    profiles: [...config.profiles, localExtraction, localShadow],
    routes: {
      ...config.routes,
      mail_extraction: 'local-extraction',
      intent_shadow: 'local-shadow',
      // ローカルの P0 は置かない（P2 のローカルだけの有効な設定）。
      local_asr: null,
    },
  };
  // 実行中のローカル抽出がある間の影モードは、待機ではなく skip。
  assert.deepEqual(
    planModelCalls(
      localConfig,
      {
        running: [
          { task: 'mail_extraction', provider: 'local', shadow: false },
        ],
        shadow_enabled: true,
        budget_available: true,
      },
      [{ task: 'intent_shadow' }],
    ),
    [{ admit: false, action: 'skip', reasons: ['shadow_wait'] }],
  );
  // 同じバッチでローカルの P2 を先に受けた場合も同じ。
  assert.deepEqual(
    planModelCalls(
      localConfig,
      { running: [], shadow_enabled: true, budget_available: true },
      [{ task: 'mail_extraction' }, { task: 'intent_shadow' }],
    ),
    [
      { admit: true, lane: 'B', priority: 'P2' },
      { admit: false, action: 'skip', reasons: ['shadow_wait'] },
    ],
  );
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
