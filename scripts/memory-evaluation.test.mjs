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
  explicitMemoryText,
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
  const { base_candidate, base_context, cases, source_hmacs } =
    memorySpec.admission;
  // 鍵は domain が持たないので、手書きの対応表を HMAC の関数として注入する。表にない由来は試験の誤り。
  const sourceHmac = (source) => {
    const value = source_hmacs[`${source.source_kind}:${source.source_id}`];
    assert.ok(
      value,
      `hmac missing for ${source.source_kind}:${source.source_id}`,
    );
    return value;
  };
  for (const entry of cases) {
    const candidate = { ...base_candidate, ...entry.candidate };
    const context = { ...base_context, ...entry.context, sourceHmac };
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

// Issue #180 の Q10（保存してよい記憶の種類の設定）は ADR 0191 で作った（U432。ADR 0183 の暫定は別の Issue）。既定は空なので、本人が
// 許可するまでは、会話からの自動の抽出のどの種類も保存しない。保存の直前の検査（memoryAdmission）が、許可した種類が空のとき
// 6 つの種類をすべて kind_not_allowed で拒否することを、fixture の基本の候補（台帳と関係のない由来）で確かめる。期待値は手で書いた。
test('with no allowed memory kinds (the default until the setting exists) automatic extraction saves nothing', () => {
  const { base_candidate, base_context, source_hmacs } = memorySpec.admission;
  const sourceHmac = (source) =>
    source_hmacs[`${source.source_kind}:${source.source_id}`];
  for (const kind of [
    'preference',
    'goal',
    'person',
    'routine',
    'lexicon',
    'progress',
  ]) {
    assert.deepEqual(
      memoryAdmission(
        { ...base_candidate, origin: 'auto_extraction', kind },
        { ...base_context, allowedKinds: [], sourceHmac },
      ),
      {
        action: 'reject',
        reasons: ['kind_not_allowed'],
        conflictingMemoryIds: [],
      },
      kind,
    );
  }
  // 同じ候補は、種類を許せば保存へ進む（拒否の理由が種類だけであることの確かめ）。
  assert.equal(
    memoryAdmission(
      { ...base_candidate, origin: 'auto_extraction', kind: 'preference' },
      { ...base_context, allowedKinds: ['preference'], sourceHmac },
    ).action,
    'save',
  );
});

// Q10（U432）は ADR 0191 で保存してよい記憶の種類の設定を作った（既定は空）。製品の Core から記憶を保存するのは、本人の明示の
// 依頼（memory_save・memory_correct）を発言と同じ transaction で保存する経路（memory-save.ts と api-turns.ts の turn.record の
// memory）だけで、保存の直前に設定を通す。自動の抽出から保存する経路はまだないこと（auto_extraction の値を使う所がないこと）と、
// 保存層の memory.save の命令を直接呼ぶ所がないことを、製品の Core のソース（試験を除く）で確かめる。自動の抽出の経路を
// 足すときは、この試験を外す前に、保存してよい記憶の種類の設定（既定は空）を通すこと。
test('the product Core saves memories only from explicit requests through the settings, never from automatic extraction yet', async () => {
  const { readdir } = await import('node:fs/promises');
  const dir = new URL('../apps/core/src/', import.meta.url);
  const sources = (await readdir(dir)).filter(
    (name) =>
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.includes('test-support'),
  );
  assert(sources.length > 0);
  const callers = [];
  const automatic = [];
  const explicit = [];
  for (const name of sources) {
    const text = await readFile(new URL(name, dir), 'utf8');
    if (/kind:\s*'memory\.save'/u.test(text)) callers.push(name);
    if (/'auto_extraction'/u.test(text)) automatic.push(name);
    if (/origin:\s*'explicit_request'/u.test(text)) explicit.push(name);
  }
  assert.deepEqual(callers, []);
  assert.deepEqual(automatic, []);
  assert.deepEqual(explicit, ['memory-save.ts']);
});

// 本人の明示の依頼の本文を記憶の本文にする規則（ADR 0191）。期待値は手で書いた（80 コードポイントの境界・空白のまとめ・
// 見えない文字の拒否）。
test('explicit memory text: whitespace is folded, 80 code points is the limit and hidden characters are refused', () => {
  assert.deepEqual(explicitMemoryText('  返信は\n\t短めが好み  '), {
    ok: true,
    text: '返信は 短めが好み',
  });
  assert.deepEqual(explicitMemoryText('あ'.repeat(80)), {
    ok: true,
    text: 'あ'.repeat(80),
  });
  assert.deepEqual(explicitMemoryText('あ'.repeat(81)), {
    ok: false,
    reason: 'too_long',
  });
  // サロゲートペアの文字は 1 文字と数える。
  assert.equal(explicitMemoryText('😀'.repeat(80)).ok, true);
  assert.deepEqual(explicitMemoryText(' \n '), { ok: false, reason: 'empty' });
  for (const hidden of ['‮', '​', '\u0007', '﻿', '⁦'])
    assert.deepEqual(
      explicitMemoryText(`合成${hidden}の好み`),
      { ok: false, reason: 'control_character' },
      JSON.stringify(hidden),
    );
  // 分解した文字は NFC にそろえる（「が」= か + 濁点）。
  assert.deepEqual(explicitMemoryText('が'), { ok: true, text: 'が' });
});
