import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  REQUIRED_METRICS,
  ROLE_USES,
  adoptionReasons,
  advanceDeployment,
  applyMemoryEvent,
  artifactIssues,
  driftReasons,
  expiryUsableReasons,
  initialReviewAt,
  memoryAdmission,
  memoryUsableReasons,
  restoreReasons,
  rollbackReasons,
  shadowAdmission,
  shouldExtractMemories,
  updateShadowCampaign,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';
import {
  judgmentCases,
  parseExpectedArgs,
  splitLeaks,
  toEvalCase,
} from './eval-tools.mjs';

// ビルド後の domain を、手書きの期待値（fixtures）で検査する。
const { schema, validators } = await loadContracts();
const defs = schema.$defs;
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));
const memorySpec = await read('packages/contracts/fixtures/memory-cases.json');
const evalSpec = await read(
  'packages/contracts/fixtures/evaluation-cases.json',
);

test('forgotten sources and their derivatives never come back as memories', () => {
  const { base_candidate, base_context, cases } = memorySpec.admission;
  for (const entry of cases) {
    const candidate = { ...base_candidate, ...entry.candidate };
    const context = { ...base_context, ...entry.context };
    assert.deepEqual(
      memoryAdmission(candidate, context),
      entry.expected,
      entry.id,
    );
  }
});

test('use, re-summary and re-extraction never extend memory deadlines', () => {
  for (const entry of memorySpec.initial_review)
    assert.equal(
      initialReviewAt(entry.created_at, entry.source_review_ats),
      entry.expected,
      entry.id,
    );
  const { initial, steps, unanswered } = memorySpec.lifecycle;
  let memory = initial;
  for (const [index, step] of steps.entries()) {
    const result = applyMemoryEvent(memory, step.event, step.now);
    const label = `#${index + 1} ${step.event}`;
    assert.equal(result.rejected, step.rejected, label);
    assert.deepEqual(result.memory, step.expected, label);
    memory = result.memory;
  }
  const last = applyMemoryEvent(
    unanswered.initial,
    unanswered.event,
    unanswered.now,
  );
  assert.equal(last.rejected, null);
  assert.deepEqual(last.memory, unanswered.expected);
});

test('expired rows and a rolled-back clock block automatic use; restore needs the latest ledger', () => {
  for (const entry of memorySpec.usable)
    assert.deepEqual(
      entry.memory
        ? memoryUsableReasons(entry.memory, entry.now, entry.last_checked_at)
        : expiryUsableReasons(
            entry.expires_at,
            entry.now,
            entry.last_checked_at,
          ),
      entry.expected,
      entry.id,
    );
  for (const entry of memorySpec.restore)
    assert.deepEqual(restoreReasons(entry.input), entry.expected, entry.id);
  for (const entry of memorySpec.extraction_trigger)
    assert.equal(shouldExtractMemories(entry.input), entry.expected, entry.id);
});

test('memory contracts keep the model output apart from Core-owned generations', () => {
  const wire = {
    kind: 'preference',
    text: '返信は短め',
    source_turn_ids: ['turn-1'],
    target_key: '返信の長さ',
  };
  assert(validators.MemoryCandidateWire(wire));
  for (const extra of [
    { forgetting_generation: '1' },
    { dedupe_key: 'a'.repeat(64) },
    { origin: 'explicit_request' },
  ])
    assert(!validators.MemoryCandidateWire({ ...wire, ...extra }));
  assert(validators.MemoryCandidateWire({ ...wire, text: 'あ'.repeat(80) }));
  assert(!validators.MemoryCandidateWire({ ...wire, text: 'あ'.repeat(81) }));
  // 由来の種類は 3 つだけで、本文を持たせない。
  assert(
    !validators.MemorySourceRef({
      source_kind: 'turn',
      source_id: 'x',
      text: 'y',
    }),
  );
});

const merge = (base, change = {}) => ({
  ...base,
  ...change,
  ...(change.conditions
    ? { conditions: { ...base.conditions, ...change.conditions } }
    : {}),
});

test('adoption is per deployment and use; intent accuracy and shadow mode never adopt other uses', () => {
  const { base_deployment, base_evaluation, adoption } = evalSpec;
  for (const entry of adoption) {
    const deployment = merge(base_deployment, entry.deployment);
    const evaluations = (entry.evaluations ?? [{}]).map((change) =>
      merge(base_evaluation, change),
    );
    assert.deepEqual(
      adoptionReasons(deployment, entry.use, evaluations),
      entry.expected,
      entry.id,
    );
  }
});

test('deployments advance one verified stage at a time and stop on drift', () => {
  for (const entry of evalSpec.transitions)
    assert.deepEqual(
      advanceDeployment(entry.stage, entry.event, entry.adoption_ok),
      entry.expected,
      entry.id ?? `${entry.stage} ${entry.event}`,
    );
  const { artifacts, drift, rollback } = evalSpec;
  for (const entry of artifacts.cases)
    assert.deepEqual(
      artifactIssues(artifacts.expected, entry.observed),
      entry.expected,
      entry.id,
    );
  for (const entry of drift.cases)
    assert.deepEqual(
      driftReasons(drift.manifest, entry.observed),
      entry.expected,
      entry.id,
    );
  for (const entry of rollback)
    assert.deepEqual(
      rollbackReasons(entry.target, entry.use),
      entry.expected,
      entry.id,
    );
});

test('the shadow campaign stops at its first limit and never waits the primary judgment', () => {
  const { initial, scenarios } = evalSpec.shadow_campaign;
  for (const scenario of scenarios) {
    let campaign = initial;
    for (const [index, step] of scenario.steps.entries()) {
      campaign = updateShadowCampaign(campaign, step);
      const label = `${scenario.id} #${index + 1}`;
      assert.equal(campaign.status, step.expected.status, label);
      assert.equal(campaign.stop_reason, step.expected.stop_reason, label);
      if (step.confirmed_inputs !== undefined)
        assert.equal(campaign.confirmed_inputs, step.confirmed_inputs, label);
    }
  }
  for (const entry of evalSpec.shadow_admission)
    assert.deepEqual(shadowAdmission(entry.input), entry.expected, entry.id);
});

test('evaluation contracts separate model IDs, versions, uses, conditions and evidence', () => {
  const uses = defs.EvaluationUse.enum;
  assert(!uses.includes('all'));
  assert.deepEqual(Object.keys(REQUIRED_METRICS).sort(), [...uses].sort());
  assert.deepEqual(
    Object.keys(ROLE_USES).sort(),
    [...defs.ModelProfile.properties.role.enum].sort(),
  );
  assert.deepEqual(
    defs.ModelProfile.properties.role.enum,
    defs.ModelCandidate.properties.role.enum,
  );
  for (const list of Object.values(ROLE_USES))
    for (const use of list) assert(uses.includes(use), use);
  // 採否の根拠は EvaluationResult の ID だけ。影モードの集計に合否・正答率の欄はない。
  const summary = {
    campaign_id: '00000000-0000-4000-8000-000000000101',
    primary_deployment_id: '00000000-0000-4000-8000-000000000102',
    shadow_deployment_id: '00000000-0000-4000-8000-000000000103',
    compared: 300,
    intent_agreement: '0.9',
    args_agreement: null,
    latency_ms: { p50: 400, p95: 900 },
    cost_total: { currency: 'XTS', amount: '1000' },
  };
  assert(validators.ShadowCampaignSummary(summary));
  for (const extra of [
    { verdict: 'pass' },
    { intent_accuracy: '0.9' },
    { adopted: true },
  ])
    assert(!validators.ShadowCampaignSummary({ ...summary, ...extra }));
  assert.deepEqual(
    semanticErrors('ShadowCampaignSummary', {
      ...summary,
      shadow_deployment_id: summary.primary_deployment_id,
    }),
    ['shadow_is_primary'],
  );
  const adoption = {
    use: 'intent_args',
    decision: 'adopted',
    evaluation_ids: ['00000000-0000-4000-8000-000000000104'],
    decided_by: 'user',
    decided_at: '2030-10-10T00:00:00Z',
  };
  assert(validators.DeploymentAdoption(adoption));
  assert(!validators.DeploymentAdoption({ ...adoption, decided_by: 'model' }));
  assert(!validators.DeploymentAdoption({ ...adoption, use: 'all' }));
  assert(!validators.DeploymentAdoption({ ...adoption, decision: 'shadow' }));
});

test('evaluation set rows convert to IntentEvalCase without guessing keys or formats', async () => {
  const spec = await read(
    'packages/contracts/fixtures/eval-conversion-cases.json',
  );
  for (const entry of spec.args)
    assert.deepEqual(
      parseExpectedArgs(entry.text, spec.options.offset),
      entry.expected,
      entry.id,
    );
  for (const entry of spec.rows) {
    const result = toEvalCase(entry.row, spec.options);
    if (entry.expected.ok === false) {
      assert.deepEqual(result, entry.expected, entry.id);
      continue;
    }
    assert(result.ok, entry.id);
    assert.deepEqual(result.value, entry.expected, entry.id);
    assert(
      validators.IntentEvalCase(result.value),
      JSON.stringify(validators.IntentEvalCase.errors),
    );
  }
  const { cases, expected_judgment, expected_leaks } = spec.selection;
  assert.deepEqual(
    judgmentCases(cases).map((entry) => entry.case_id),
    expected_judgment,
  );
  assert.deepEqual(splitLeaks(cases), expected_leaks);
  // 正解の引数は IntentArgs の項目名だけで、null を書かない。
  assert.deepEqual(
    Object.keys(defs.ExpectedIntentArgs.properties).sort(),
    Object.keys(defs.IntentArgs.properties).sort(),
  );
  assert(!validators.ExpectedIntentArgs({ date_from: '2030-10-09T12:00' }));
  assert(!validators.ExpectedIntentArgs({ title: null }));
});

test('local invariants of memory and evaluation records are checked semantically', async () => {
  const cases = await read('packages/contracts/fixtures/schema-cases.json');
  const value = (id) =>
    structuredClone(cases.find((entry) => entry.id === id).value);
  const candidate = value('memory-candidate-explicit');
  candidate.sources = [{ source_kind: 'memory', source_id: 'memory-1' }];
  assert.deepEqual(semanticErrors('MemoryCandidate', candidate), [
    'explicit_without_turn',
  ]);
  const record = value('memory-record-review-pending');
  assert.deepEqual(
    semanticErrors('MemoryRecord', { ...record, delete_at: null }),
    ['missing_delete_at'],
  );
  assert.deepEqual(
    semanticErrors('MemoryRecord', { ...record, status: 'active' }),
    ['active_with_delete_at'],
  );
  assert.deepEqual(
    semanticErrors('MemoryRecord', {
      ...record,
      delete_at: '2030-12-01T00:00:00Z',
    }),
    ['delete_before_review'],
  );
  const ledger = value('forget-ledger-entry');
  ledger.forgotten.push({ ...ledger.forgotten[0] });
  assert.deepEqual(semanticErrors('ForgetLedgerEntry', ledger), [
    'duplicate_forgotten',
  ]);
  const manifest = value('deployment-active');
  assert.deepEqual(
    semanticErrors('DeploymentManifest', { ...manifest, adoptions: [] }),
    ['active_without_adoption'],
  );
  assert.deepEqual(
    semanticErrors('DeploymentManifest', {
      ...manifest,
      adoptions: [manifest.adoptions[0], manifest.adoptions[0]],
    }),
    ['duplicate_adoption_use'],
  );
  const textProfile = value('deployment-active');
  textProfile.profile.role = 'background_text';
  assert.deepEqual(semanticErrors('DeploymentManifest', textProfile), [
    'p95_reservation_outside_intent',
  ]);
  const local = value('deployment-local');
  assert.deepEqual(
    semanticErrors('DeploymentManifest', { ...local, artifacts: [] }),
    ['local_without_artifacts'],
  );
  const evaluation = value('evaluation-result');
  assert.deepEqual(
    semanticErrors('EvaluationResult', {
      ...evaluation,
      mandatory_violations: 1,
      samples: { ...evaluation.samples, confirmed: 0 },
      suite: { ...evaluation.suite, split: 'tuning' },
      latency_ms: { p50: 3000, p95: 2000 },
    }),
    [
      'pass_with_violation',
      'pass_without_confirmed',
      'pass_on_tuning_split',
      'latency_order',
    ],
  );
  const shadow = value('intent-shadow-record');
  shadow.primary.outcome = 'skipped';
  shadow.shadows[1].intent = 'query_tasks';
  shadow.shadows[0].deployment_id = shadow.primary.deployment_id;
  assert.deepEqual(semanticErrors('IntentShadowRecord', shadow), [
    'primary_skipped',
    'judgment_without_result',
    'judgment_without_result',
    'shadow_is_primary',
  ]);
  const campaign = value('shadow-campaign-stopped');
  assert.deepEqual(
    semanticErrors('ShadowCampaignState', { ...campaign, stop_reason: null }),
    ['stop_reason_mismatch'],
  );
});
