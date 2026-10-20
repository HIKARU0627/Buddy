// モデル配備の採否・状態・影モードの規則（設計 05 評価の進め方・再選定する条件 P09・影モードの運用 P05、
// 09 X48・X57・X66・QA13・QA21・QA26・MA01・MA02、ADR 0008）。

export type EvaluationUse =
  | 'intent_args'
  | 'mail_extraction'
  | 'reply_draft'
  | 'research_summary'
  | 'consult_summary'
  | 'memory_extraction'
  | 'voice_conversation'
  | 'local_asr';

export type ModelRole =
  'voice' | 'intent' | 'background_text' | 'advanced_consult' | 'local_asr';

// 役割ごとに採用を判断できる用途（05 冒頭の追補 D16、docs/design/model-routing.md）。
export const ROLE_USES: Readonly<Record<ModelRole, readonly EvaluationUse[]>> =
  {
    voice: ['voice_conversation'],
    intent: ['intent_args'],
    background_text: [
      'mail_extraction',
      'reply_draft',
      'research_summary',
      'consult_summary',
      'memory_extraction',
    ],
    advanced_consult: ['research_summary', 'consult_summary'],
    local_asr: ['local_asr'],
  };

// 用途ごとに記録が必要な指標（05 の用途別評価の表、09 X57・X66）。
// null の用途は指標を B05 の実機試験で決めるまで採用できない。
export const REQUIRED_METRICS: Readonly<
  Record<EvaluationUse, readonly string[] | null>
> = {
  intent_args: [
    'intent_accuracy',
    'args_match',
    'clarification_correct',
    'format_valid',
    'false_auto_execution',
  ],
  mail_extraction: [
    'request_match',
    'deadline_match',
    'evidence_position_match',
    'missed',
    'false_detection',
    'appropriate_abstention',
    'false_auto_execution',
  ],
  reply_draft: [
    'evidence_consistency',
    'fabrication',
    'unapproved_commitment',
    'placeholder_correct',
    'user_edit_amount',
  ],
  research_summary: [
    'claim_source_match',
    'date_number_accuracy',
    'contradiction_kept',
    'key_info_missed',
  ],
  consult_summary: [
    'fact_proposal_decision_separation',
    'context_kept',
    'correction_applied',
    'storage_condition_violation',
  ],
  memory_extraction: [
    'kind_accuracy',
    'target_key_match',
    'length_valid',
    'forgotten_or_private_mixed',
  ],
  voice_conversation: null,
  local_asr: null,
};

export interface ProfileFingerprint {
  readonly model_request_id: string;
  readonly response_model_id: string | null;
  readonly schema_hash: string | null;
  readonly prompt_hash: string | null;
  readonly artifact_digest: string | null;
  readonly reasoning: string | null;
  readonly output_limit_tokens: number | null;
}

export interface DeploymentState extends ProfileFingerprint {
  readonly deployment_id: string;
  readonly role: ModelRole;
  readonly provider: string;
  readonly price_version: string | null;
  readonly stage:
    | 'downloaded'
    | 'integrity_checked'
    | 'contract_tested'
    | 'evaluated'
    | 'active'
    | 'suspended'
    | 'retired';
  readonly adoptions: readonly {
    readonly use: EvaluationUse;
    readonly decision: 'adopted' | 'rejected';
    readonly evaluation_ids: readonly string[];
  }[];
}

export interface EvaluationRecord {
  readonly evaluation_id: string;
  readonly deployment_id: string;
  readonly use: EvaluationUse;
  readonly split: 'tuning' | 'judgment';
  readonly evidence_kind: 'mock_provider' | 'real_api' | 'real_device';
  readonly conditions: ProfileFingerprint;
  readonly confirmed: number;
  readonly metric_names: readonly string[];
  readonly mandatory_violations: number;
  readonly verdict: 'pass' | 'fail' | 'incomplete';
}

const FINGERPRINT_KEYS = [
  'model_request_id',
  'response_model_id',
  'schema_hash',
  'prompt_hash',
  'artifact_digest',
  'reasoning',
  'output_limit_tokens',
] as const;

const REASON_ORDER = [
  'use_not_in_role',
  'stage_not_evaluated',
  'price_unverified',
  'metrics_not_defined',
  'not_evaluated',
  'conditions_mismatch',
  'mock_evidence_only',
  'device_evidence_missing',
  'tuning_split',
  'no_confirmed_samples',
  'metrics_missing',
  'not_passed',
  'mandatory_violation',
  'no_user_decision',
  'rejected_by_user',
  'adoption_evidence_mismatch',
];

function evaluationIssues(
  deployment: DeploymentState,
  evaluation: EvaluationRecord,
): string[] {
  const issues: string[] = [];
  if (
    FINGERPRINT_KEYS.some(
      (key) => evaluation.conditions[key] !== deployment[key],
    )
  )
    issues.push('conditions_mismatch');
  // ローカル・音声・端末内の認識は実機の測定だけを証拠にする（05 ローカル profile の採用条件）。
  const needsDevice =
    deployment.provider === 'local' ||
    evaluation.use === 'voice_conversation' ||
    evaluation.use === 'local_asr';
  if (evaluation.evidence_kind === 'mock_provider')
    issues.push('mock_evidence_only');
  else if (needsDevice && evaluation.evidence_kind !== 'real_device')
    issues.push('device_evidence_missing');
  if (evaluation.split === 'tuning') issues.push('tuning_split');
  if (evaluation.confirmed === 0) issues.push('no_confirmed_samples');
  const required = REQUIRED_METRICS[evaluation.use] ?? [];
  if (required.some((name) => !evaluation.metric_names.includes(name)))
    issues.push('metrics_missing');
  if (evaluation.verdict !== 'pass') issues.push('not_passed');
  return issues;
}

// ある配備をある用途で有効にできるか。根拠は同じ配備・同じ用途の評価だけで、
// 意図判定の合格を他の用途へ流用しない。影モードの集計は評価として受け付けない。
export function adoptionReasons(
  deployment: DeploymentState,
  use: EvaluationUse,
  evaluations: readonly EvaluationRecord[],
): { readonly ok: boolean; readonly reasons: string[] } {
  const reasons = new Set<string>();
  if (!ROLE_USES[deployment.role].includes(use)) reasons.add('use_not_in_role');
  if (deployment.stage !== 'evaluated' && deployment.stage !== 'active')
    reasons.add('stage_not_evaluated');
  if (deployment.provider !== 'local' && deployment.price_version === null)
    reasons.add('price_unverified');
  if (REQUIRED_METRICS[use] === null) reasons.add('metrics_not_defined');
  const applicable = evaluations.filter(
    (evaluation) =>
      evaluation.deployment_id === deployment.deployment_id &&
      evaluation.use === use,
  );
  const usable = new Set<string>();
  if (applicable.length === 0) reasons.add('not_evaluated');
  else {
    const issues = applicable.map((evaluation) =>
      evaluationIssues(deployment, evaluation),
    );
    issues.forEach((list, index) => {
      if (list.length === 0) usable.add(applicable[index]!.evaluation_id);
    });
    if (usable.size === 0)
      for (const list of issues) for (const issue of list) reasons.add(issue);
    // 必須境界例の違反は 1 件でも、その用途を不採用にする（05、09 X66）。
    if (applicable.some((evaluation) => evaluation.mandatory_violations > 0))
      reasons.add('mandatory_violation');
  }
  const adoption = deployment.adoptions.find((item) => item.use === use);
  if (!adoption) reasons.add('no_user_decision');
  else if (adoption.decision === 'rejected') reasons.add('rejected_by_user');
  else if (adoption.evaluation_ids.some((id) => !usable.has(id)))
    reasons.add('adoption_evidence_mismatch');
  const ordered = REASON_ORDER.filter((reason) => reasons.has(reason));
  return { ok: ordered.length === 0, reasons: ordered };
}

export type DeploymentEvent =
  | 'integrity_passed'
  | 'contract_passed'
  | 'evaluation_recorded'
  | 'activate'
  | 'drift_detected'
  | 'startup_failed'
  | 'regression_passed'
  | 'retire';

const DEPLOYMENT_TRANSITIONS: Readonly<
  Record<string, Readonly<Partial<Record<DeploymentEvent, string>>>>
> = {
  downloaded: { integrity_passed: 'integrity_checked', retire: 'retired' },
  integrity_checked: { contract_passed: 'contract_tested', retire: 'retired' },
  contract_tested: { evaluation_recorded: 'evaluated', retire: 'retired' },
  evaluated: { activate: 'active', retire: 'retired' },
  active: {
    drift_detected: 'suspended',
    startup_failed: 'suspended',
    retire: 'retired',
  },
  suspended: { regression_passed: 'evaluated', retire: 'retired' },
  retired: {},
};

// 配備の段階を一つずつ進める。active にするには adoptionReasons が通っている必要がある。
export function advanceDeployment(
  stage: DeploymentState['stage'],
  event: DeploymentEvent,
  adoptionOk: boolean,
): { readonly stage: string; readonly rejected: string | null } {
  const next = DEPLOYMENT_TRANSITIONS[stage]?.[event];
  if (next === undefined) return { stage, rejected: 'invalid_transition' };
  if (event === 'activate' && !adoptionOk)
    return { stage, rejected: 'adoption_not_ready' };
  return { stage: next, rejected: null };
}

export interface ArtifactRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

// ローカル一式の照合（QA26）。欠けた・大きさの違う・digest の違う成果物があれば integrity_passed にしない。
export function artifactIssues(
  expected: readonly ArtifactRecord[],
  observed: readonly ArtifactRecord[],
): string[] {
  const issues: string[] = [];
  if (expected.length === 0) issues.push('no_artifacts');
  for (const item of expected) {
    const found = observed.find((entry) => entry.path === item.path);
    if (!found || found.bytes !== item.bytes)
      issues.push(`incomplete:${item.path}`);
    else if (found.sha256 !== item.sha256)
      issues.push(`digest_mismatch:${item.path}`);
  }
  return issues;
}

// 同じモデル ID のまま変わった点の検知（QA21）。一つでもあれば drift_detected として新規の自動処理を止める。
export function driftReasons(
  manifest: {
    readonly response_model_id: string | null;
    readonly api_version: string | null;
    readonly verified_capabilities: readonly string[];
  },
  observed: {
    readonly response_model_id: string | null;
    readonly api_version: string | null;
    readonly capabilities: readonly string[];
  },
): string[] {
  const reasons: string[] = [];
  if (observed.response_model_id !== manifest.response_model_id)
    reasons.push('response_model_changed');
  if (observed.api_version !== manifest.api_version)
    reasons.push('api_version_changed');
  if (
    manifest.verified_capabilities.some(
      (capability) => !observed.capabilities.includes(capability),
    )
  )
    reasons.push('capability_regressed');
  return reasons;
}

// 戻し先にできるか。可変名を同じ名前で指定し直すことは旧版への復帰ではない（05 P09）。
export function rollbackReasons(
  target: {
    readonly version_kind:
      'immutable_snapshot' | 'mutable_alias' | 'local_digest';
    readonly stage: DeploymentState['stage'];
    readonly adoptedUses: readonly EvaluationUse[];
  },
  use: EvaluationUse,
): string[] {
  const reasons: string[] = [];
  if (target.version_kind === 'mutable_alias')
    reasons.push('alias_not_rollback');
  if (target.stage !== 'evaluated' && target.stage !== 'suspended')
    reasons.push('rollback_target_unverified');
  if (!target.adoptedUses.includes(use)) reasons.push('not_adopted_for_use');
  return reasons;
}

export interface ShadowCampaign {
  readonly started_at: string;
  readonly confirmed_inputs: number;
  readonly spent: string;
  readonly max_inputs: number;
  readonly max_spend: string;
  readonly max_days: number;
  readonly status: 'running' | 'stopped';
  readonly stop_reason:
    'max_inputs' | 'max_spend' | 'max_days' | 'user_stopped' | null;
}

const DAY_MS = 86_400_000;

// 比較 campaign の停止（05・11 §9 P05）。件数・実費・日数の最初の到達で止める。同時に届いたら件数・実費・日数の順。
export function updateShadowCampaign(
  campaign: ShadowCampaign,
  update: {
    readonly addedInputs: number;
    readonly addedCost: string;
    readonly now: string;
  },
): ShadowCampaign {
  if (campaign.status === 'stopped') return campaign;
  const next = {
    ...campaign,
    confirmed_inputs: campaign.confirmed_inputs + update.addedInputs,
    spent: (BigInt(campaign.spent) + BigInt(update.addedCost)).toString(),
  };
  const stop =
    next.confirmed_inputs >= next.max_inputs
      ? 'max_inputs'
      : BigInt(next.spent) >= BigInt(next.max_spend)
        ? 'max_spend'
        : Date.parse(update.now) - Date.parse(next.started_at) >=
            next.max_days * DAY_MS
          ? 'max_days'
          : null;
  return stop ? { ...next, status: 'stopped', stop_reason: stop } : next;
}

// 影モードを今回の入力で動かすか。本人の依頼を待たせず、余力がなければ skip する（11 §9、10 §5、X48）。
export function shadowAdmission(input: {
  readonly privateConversation: boolean;
  readonly liveSessionOpen: boolean;
  readonly slotAvailable: boolean;
  readonly campaign: Pick<ShadowCampaign, 'status'>;
}): {
  readonly run: boolean;
  readonly record: boolean;
  readonly reasons: string[];
} {
  const reasons: string[] = [];
  if (input.privateConversation) reasons.push('private_conversation');
  if (input.liveSessionOpen) reasons.push('live_session_open');
  if (!input.slotAvailable) reasons.push('no_capacity');
  if (input.campaign.status !== 'running') reasons.push('campaign_stopped');
  // 記録しない会話では比較記録を作らない。他の理由の skip は記録に残す。
  return {
    run: reasons.length === 0,
    record: !input.privateConversation,
    reasons,
  };
}
