import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import canonicalize from 'canonicalize';
import { parseTree } from 'jsonc-parser';

export const root = new URL('../', import.meta.url);
export const schemaUrl = new URL(
  'packages/contracts/schemas/buddy.schema.json',
  root,
);

// B00の検証用。生のJSONを検査してから値にする。製品のHTTP接続は未実装。
export function parseStrictJson(text) {
  if (typeof text !== 'string' || text.length > 1_000_000)
    throw new Error('Invalid JSON size');
  const errors = [];
  const tree = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (!tree || errors.length) throw new Error('Invalid JSON syntax');
  function visit(node, depth) {
    if (depth > 64) throw new Error('JSON nesting limit');
    if (node.type === 'string' && !node.value.isWellFormed())
      throw new Error('Invalid Unicode');
    if (node.type === 'number' && !Number.isFinite(node.value))
      throw new Error('Non-finite number');
    if (node.type === 'object') {
      const keys = new Set();
      for (const property of node.children ?? []) {
        const key = property.children[0].value;
        if (keys.has(key)) throw new Error('Duplicate JSON key');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  visit(tree, 0);
  return JSON.parse(text);
}

export function canonicalJson(text) {
  return canonicalize(parseStrictJson(text));
}

export function contentHash(text) {
  return createHash('sha256').update(canonicalJson(text), 'utf8').digest('hex');
}

export async function loadContracts() {
  const schema = parseStrictJson(await readFile(schemaUrl, 'utf8'));
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
  });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validators = Object.fromEntries(
    Object.keys(schema.$defs).map((name) => [
      name,
      ajv.getSchema(`${schema.$id}#/$defs/${name}`),
    ]),
  );
  if (Object.values(validators).some((validator) => !validator))
    throw new Error('Missing contract validator');
  return { schema, validators };
}

// 文書に明記した局所的不変条件だけ。認可・DB状態・外部照合は検証しない。
export function semanticErrors(name, value) {
  const errors = [];
  if (name === 'CreditObservation') {
    if (value.status === 'observed' && value.balance === null)
      errors.push('missing_observed_balance');
    if (
      Date.parse(value.observed_at) >= Date.parse(value.expires_at) &&
      value.status === 'observed'
    )
      errors.push('expired_observation');
  }
  if (name === 'BudgetConfig') {
    const pools = new Map();
    for (const pool of value.pools) {
      if (pools.has(pool.pool_id)) errors.push('duplicate_pool');
      pools.set(pool.pool_id, pool);
      if (pool.limit.currency !== value.currency)
        errors.push('currency_mismatch');
    }
    for (const pool of value.pools) {
      const seen = new Set([pool.pool_id]);
      let parent = pool.parent_pool_id;
      while (parent !== null) {
        const node = pools.get(parent);
        if (!node) {
          errors.push('unknown_parent_pool');
          break;
        }
        if (seen.has(parent)) {
          errors.push('pool_cycle');
          break;
        }
        seen.add(parent);
        parent = node.parent_pool_id;
      }
      const direct = pools.get(pool.parent_pool_id);
      if (direct && BigInt(pool.limit.amount) > BigInt(direct.limit.amount))
        errors.push('child_limit_exceeds_parent');
    }
  }
  if (name === 'SourceRef' && value.start >= value.end)
    errors.push('quote_range');
  if (name === 'FieldEvidence') {
    if (value.status === 'explicit' && value.refs.length === 0)
      errors.push('explicit_without_ref');
    if (value.status === 'derived' && value.rule_id === null)
      errors.push('derived_without_rule');
    for (const item of value.refs)
      errors.push(...semanticErrors('SourceRef', item));
  }
  if (name === 'ExtractionResult') {
    const ids = new Set(
      value.completeness.source_revisions.map((item) => item.source_id),
    );
    for (const id of [
      ...value.completeness.unread_source_ids,
      ...value.completeness.truncated_source_ids,
    ])
      if (!ids.has(id)) errors.push('completeness_unknown_source');
    for (const request of value.requests) {
      if (
        (request.request_entity_id === null) !==
        (request.request_revision === null)
      )
        errors.push('entity_revision_pair');
      for (const field of request.fields)
        errors.push(...semanticErrors('FieldEvidence', field));
    }
  }
  if (name === 'RelatedAnalysis') {
    if (value.sources.some((s) => s.state === 'excluded' && s.rule_id === null))
      errors.push('excluded_without_rule');
    if (
      value.status === 'ready' &&
      (!value.plan_complete ||
        value.unresolved_change_count > 0 ||
        value.sources.some((s) => !['analyzed', 'excluded'].includes(s.state)))
    )
      errors.push('ready_before_analysis_complete');
  }
  if (
    name === 'MemoryCandidate' &&
    value.origin === 'explicit_request' &&
    !value.sources.some((s) => s.source_kind === 'turn')
  )
    errors.push('explicit_without_turn');
  if (name === 'MemoryRecord') {
    if (Date.parse(value.review_at) <= Date.parse(value.created_at))
      errors.push('review_before_created');
    if (value.status === 'active' && value.delete_at !== null)
      errors.push('active_with_delete_at');
    if (value.status !== 'active' && value.delete_at === null)
      errors.push('missing_delete_at');
    if (
      value.delete_at !== null &&
      Date.parse(value.delete_at) <= Date.parse(value.review_at)
    )
      errors.push('delete_before_review');
  }
  if (name === 'ForgetLedgerEntry') {
    const keys = value.forgotten.map((s) => `${s.source_kind}:${s.source_id}`);
    if (new Set(keys).size !== keys.length) errors.push('duplicate_forgotten');
  }
  if (name === 'DeploymentManifest') {
    const uses = value.adoptions.map((a) => a.use);
    if (new Set(uses).size !== uses.length)
      errors.push('duplicate_adoption_use');
    if (
      value.stage === 'active' &&
      !value.adoptions.some((a) => a.decision === 'adopted')
    )
      errors.push('active_without_adoption');
    if (value.version_kind === 'local_digest' && value.artifacts.length === 0)
      errors.push('local_without_artifacts');
    // p95 予約は意図判定の比較 profile だけ。他用途へ広げない（05 質問132）。
    if (
      value.profile.reservation_method === 'measured_p95' &&
      value.profile.role !== 'intent'
    )
      errors.push('p95_reservation_outside_intent');
  }
  if (name === 'EvaluationResult') {
    if (value.verdict === 'pass') {
      if (value.mandatory_violations > 0) errors.push('pass_with_violation');
      if (value.samples.confirmed === 0) errors.push('pass_without_confirmed');
      if (value.suite.split === 'tuning') errors.push('pass_on_tuning_split');
    }
    if (value.latency_ms && value.latency_ms.p50 > value.latency_ms.p95)
      errors.push('latency_order');
    const names = value.metrics.map((m) => m.name);
    if (new Set(names).size !== names.length) errors.push('duplicate_metric');
  }
  if (name === 'ShadowJudgment') {
    const answered = ['ok', 'needs_clarification'].includes(value.outcome);
    if (answered && value.intent === null) errors.push('missing_intent');
    if (!answered && (value.intent !== null || value.args !== null))
      errors.push('judgment_without_result');
  }
  if (name === 'IntentShadowRecord') {
    if (value.primary.outcome === 'skipped') errors.push('primary_skipped');
    if (Date.parse(value.expires_at) <= Date.parse(value.recorded_at))
      errors.push('expires_before_recorded');
    for (const judgment of [value.primary, ...value.shadows])
      errors.push(...semanticErrors('ShadowJudgment', judgment));
    if (
      value.shadows.some((s) => s.deployment_id === value.primary.deployment_id)
    )
      errors.push('shadow_is_primary');
  }
  if (name === 'ShadowCampaignState') {
    if ((value.status === 'stopped') !== (value.stop_reason !== null))
      errors.push('stop_reason_mismatch');
    if (value.spent.currency !== value.limits.max_spend.currency)
      errors.push('currency_mismatch');
  }
  if (
    name === 'ShadowCampaignSummary' &&
    value.shadow_deployment_id === value.primary_deployment_id
  )
    errors.push('shadow_is_primary');
  if (
    name === 'Snapshot' &&
    value.view === 'management_only' &&
    (value.sessions.length > 0 ||
      value.candidates.length > 0 ||
      value.operations.length > 0)
  )
    errors.push('content_in_management_view');
  if (name === 'IoStopResult') {
    const confirmed = value.devices.every((d) => d.stop_state === 'confirmed');
    if (value.all_confirmed !== confirmed)
      errors.push('all_confirmed_mismatch');
  }
  if (name === 'SyncBatch') {
    if (Date.parse(value.window_start) >= Date.parse(value.window_end))
      errors.push('window_order');
    if (value.status === 'published' && value.diff_count === null)
      errors.push('published_without_diff_count');
  }
  if (name === 'TimeZone') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
    } catch {
      errors.push('unknown_time_zone');
    }
  }
  if (name === 'InputFieldEvidence' && value.start_utf16 >= value.end_utf16)
    errors.push('quote_range');
  if (name === 'OperationSnapshot') {
    if (
      value.state === 'succeeded' &&
      value.result?.status !== 'confirmed_success'
    )
      errors.push('missing_success_evidence');
    if (
      value.state !== 'succeeded' &&
      value.result?.status === 'confirmed_success'
    )
      errors.push('inconsistent_success');
    if (
      value.state === 'unknown_held' &&
      value.allowed_actions.includes('retry')
    )
      errors.push('unknown_retry');
  }
  if (name === 'InputSnapshot' && value.audio) {
    if (
      BigInt(value.audio.first_frame_seq) > BigInt(value.audio.last_frame_seq)
    )
      errors.push('frame_order');
    if (BigInt(value.audio.start_sample) >= BigInt(value.audio.end_sample))
      errors.push('sample_order');
  }
  if (name === 'LabelOperationIntent') {
    const { add, remove } = value.action;
    if (!add.length && !remove.length) errors.push('empty_change');
    if (add.some((label) => remove.includes(label)))
      errors.push('conflicting_labels');
  }
  if (name === 'WireResponse' || name === 'Interpretation') {
    if ((value.relation === 'new') !== (value.target_workflow_id === null))
      errors.push('relation_target');
  }
  if (name === 'Interpretation')
    for (const evidence of value.evidence) {
      if (
        evidence.input_id !== value.input_id ||
        evidence.request_revision !== value.request_revision
      )
        errors.push('evidence_input_mismatch');
      if (value.args[evidence.field] === null)
        errors.push('evidence_for_empty_field');
    }
  if (name === 'LocalDateTime') {
    const [date, time] = value.split('T');
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute, second = 0] = time.split(':').map(Number);
    const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (
      at.getUTCFullYear() !== year ||
      at.getUTCMonth() !== month - 1 ||
      at.getUTCDate() !== day ||
      at.getUTCHours() !== hour ||
      at.getUTCMinutes() !== minute ||
      at.getUTCSeconds() !== second
    )
      errors.push('invalid_local_datetime');
  }
  if (name === 'WorkflowRequest') {
    const previous = value.supersedes_request_revision;
    if ((value.relation === 'new') !== (previous === null))
      errors.push('relation_supersedes');
    if (previous !== null && BigInt(previous) >= BigInt(value.request_revision))
      errors.push('revision_not_increasing');
  }
  if (name === 'OutputTarget' && value.mode === 'voice' && !value.session_epoch)
    errors.push('voice_without_session_epoch');
  if (name === 'WorkContext' && value.output)
    errors.push(...semanticErrors('OutputTarget', value.output));
  if (name === 'DelegationResult') {
    if (value.output.mode !== 'voice')
      errors.push('delegation_result_not_voice');
    errors.push(...semanticErrors('OutputTarget', value.output));
  }
  if (name === 'LiveControlState') {
    if (value.closure === 'close_confirmed' && value.usage_seconds === null)
      errors.push('confirmed_without_usage');
    if (
      value.reservation_state === 'settled' &&
      (value.closure !== 'close_confirmed' || value.usage_seconds === null)
    )
      errors.push('settled_without_confirmed_usage');
  }
  if (name === 'DeviceIOState') {
    if (
      value.input_permitted &&
      (value.lock_state !== 'unlocked' || value.stop_scope !== 'none')
    )
      errors.push('input_permitted_while_locked_or_stopped');
    if (
      value.voice_state === 'conversation_live' &&
      (!value.input_permitted ||
        !value.audio_lease_valid ||
        value.output_mode !== 'voice' ||
        value.private_conversation)
    )
      errors.push('live_without_voice_conditions');
  }
  // デスクトップの状態欄（ADR 0014）。ロック中・不明の内容の非表示は schema の形で拒否する。
  if (name === 'DesktopStatusBar' && value.visibility === 'shown') {
    if (value.input_permitted && value.stop_scope !== 'none')
      errors.push('input_permitted_while_stopped');
    // 来客モードも全端末の停止なので「全体停止中」と表示する（ADR 0014 の読み取り）。
    const stopped = {
      local: 'device_stopped',
      guest: 'global_stopped',
      global: 'global_stopped',
    };
    if (
      value.voice_state !== null &&
      (value.stop_scope === 'none'
        ? Object.values(stopped).includes(value.voice_state)
        : value.voice_state !== stopped[value.stop_scope])
    )
      errors.push('voice_state_conflicts_with_stop');
    const hubValues = [
      value.display_target,
      value.storage_mode,
      value.budget_held,
      value.safety_stopped,
    ];
    // 接続中は最終確認時刻を必ず持つ。中枢がまだ正本を持たない値は接続中でも null（不明）にできる（ADR 0025）。
    if (
      value.hub_connection === 'connected' &&
      value.hub_last_confirmed_at === null
    )
      errors.push('connected_without_values');
    if (
      value.hub_connection !== 'connected' &&
      (hubValues.some((v) => v !== null) ||
        (value.hub_connection === 'not_connected' &&
          value.hub_last_confirmed_at !== null))
    )
      errors.push('hub_values_without_connection');
  }
  // 中枢との接続・ペアリングの状態（ADR 0025）。
  if (name === 'DesktopConnectionView' && value.visibility === 'shown') {
    const pairing = value.pairing;
    if (pairing !== null) {
      if ((pairing.step === 'failed') !== (pairing.failure !== null))
        errors.push('pairing_failure_mismatch');
      if (
        [
          'fingerprint_check',
          'code_entry',
          'claiming',
          'waiting_approval',
        ].includes(pairing.step) &&
        pairing.fingerprint === null
      )
        errors.push('pairing_without_fingerprint');
      if (
        pairing.step === 'fetching_certificate' &&
        pairing.fingerprint !== null
      )
        errors.push('fingerprint_before_certificate');
      // 確認コードは申請を受け付けた後の承認待ちのときだけ（B03-06）。
      if (pairing.claim_check !== null && pairing.step !== 'waiting_approval')
        errors.push('claim_check_outside_waiting');
    }
    // 中枢の画面の判定は接続している間だけ（B03-06）。
    if (value.hub_screen && value.link !== 'connected')
      errors.push('hub_screen_without_connection');
    if (value.link !== 'connected' && value.operations.length > 0)
      errors.push('operations_without_connection');
    if (value.link === 'connected' && value.last_confirmed_at === null)
      errors.push('connected_without_confirmation');
    if ((value.link === 'waiting_retry') !== (value.retry_at !== null))
      errors.push('retry_at_mismatch');
    if (
      value.registration === 'reregistration_required'
        ? value.link !== 'reregistration_required'
        : value.registration === 'registered'
          ? value.link === 'reregistration_required'
          : value.link !== 'not_connected'
    )
      errors.push('link_conflicts_with_registration');
  }
  // 中枢の画面の自宅のネットワーク（B03-08、ADR 0022）。登録の参照はゲートウェイの MAC とサブネットが取れたとき
  // だけ。SSID は伏せた表示か取れない理由のどちらか一方。先頭の文字は 4 文字以上の SSID だけ。どの要素も
  // 取れないときは observation を null にする（読み取りの失敗と同じ扱い）。
  if (name === 'DesktopHomeObservation') {
    if (
      value.ref !== null &&
      (value.gateway_mac_tail === null || value.subnet === null)
    )
      errors.push('home_ref_without_fingerprint');
    if ((value.ssid_hint === null) === (value.ssid_unavailable_reason === null))
      errors.push('ssid_hint_reason_mismatch');
    if (
      value.ssid_hint !== null &&
      value.ssid_hint.first !== null &&
      value.ssid_hint.length < 4
    )
      errors.push('ssid_hint_too_revealing');
    if (
      value.gateway_mac_tail === null &&
      value.subnet === null &&
      value.ssid_hint === null
    )
      errors.push('empty_home_observation');
  }
  if (name === 'DesktopHomeView' && value.observation)
    errors.push(...semanticErrors('DesktopHomeObservation', value.observation));
  if (name === 'DesktopIpcResponse' && value.home) {
    errors.push(...semanticErrors('DesktopHomeView', value.home));
    // 登録の応答は、登録した後の状態を持つ。今のネットワークの表示・参照は、登録の成功とは別で、登録の最中の
    // 読み取りで取得できなかった（表示なし・MAC が欠けて参照なし）ときは null になれる（PR #79 の Codex の最終確認）。
    if (
      value.channel === 'desktop.home_register' &&
      value.home.registration === null
    )
      errors.push('home_register_without_registration');
  }
  if (name === 'DesktopIpcResponse' && value.connection)
    errors.push(...semanticErrors('DesktopConnectionView', value.connection));
  if (name === 'DesktopIpcResponse' && value.status) {
    errors.push(...semanticErrors('DesktopStatusBar', value.status));
    const shown = value.status.visibility === 'shown';
    if (
      value.channel === 'desktop.io_stop' &&
      shown &&
      value.status.stop_scope === 'none'
    )
      errors.push('stop_not_reflected');
    if (
      value.channel === 'desktop.io_resume' &&
      (!shown || value.status.stop_scope !== 'none')
    )
      errors.push('resume_not_reflected');
  }
  if (name === 'DesktopIpcNotification') {
    if (value.status)
      errors.push(...semanticErrors('DesktopStatusBar', value.status));
    if (value.connection)
      errors.push(...semanticErrors('DesktopConnectionView', value.connection));
    if (
      value.source === 'os_query' &&
      !['lock_screen', 'unlock_screen'].includes(value.event)
    )
      errors.push('query_without_lock_state');
  }
  if (name === 'Lease' && value.heartbeat_ms >= value.ttl_ms)
    errors.push('heartbeat_not_shorter_than_ttl');
  if (
    name === 'PendingClarification' &&
    Date.parse(value.expires_at) <= Date.parse(value.created_at)
  )
    errors.push('expires_before_created');
  if (name === 'BudgetReservation') {
    const amounts = [
      value.reserved_amount,
      value.max_liability,
      value.actual_gross,
      value.credit_applied,
      value.additional_spend,
    ].filter((v) => v !== null);
    if (amounts.some((v) => v.currency !== value.reserved_amount.currency))
      errors.push('currency_mismatch');
    if (
      BigInt(value.reserved_amount.amount) > BigInt(value.max_liability.amount)
    )
      errors.push('reservation_exceeds_max');
    const settled = value.status === 'settled';
    if (
      settled &&
      (!value.actual_gross ||
        !value.credit_applied ||
        !value.additional_spend ||
        !value.provider_reconciliation_id)
    )
      errors.push('missing_settlement');
    if (
      !settled &&
      (value.actual_gross || value.credit_applied || value.additional_spend)
    )
      errors.push('unconfirmed_usage');
    if (value.status === 'released' && value.provider_reconciliation_id)
      errors.push('released_with_provider_receipt');
    if (value.overrun_reviewed && !settled) errors.push('review_without_usage');
    if (
      settled &&
      value.actual_gross &&
      value.credit_applied &&
      value.additional_spend
    ) {
      if (
        BigInt(value.actual_gross.amount) !==
        BigInt(value.credit_applied.amount) +
          BigInt(value.additional_spend.amount)
      )
        errors.push('settlement_sum');
      if (
        BigInt(value.credit_applied.amount) > 0n &&
        value.credit_cycle_id === null
      )
        errors.push('missing_credit_cycle');
      // M超過の実績は拒否・切捨てせず保存し、Coreが以後の課金を止める。
    }
  }
  return errors;
}
