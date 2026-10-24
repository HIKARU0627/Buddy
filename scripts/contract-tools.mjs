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
// DecimalString（小数点以下 6 桁まで）を百万分の一の整数にする。浮動小数点数を使わない。
function decimalMicros(text) {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

// 起点から計上する枠と超過枠（B07-04、ADR 0037）。各理由は 1 回だけ返す。
// - unknown_route_pool: 経路・超過枠に設定にない枠がある。
// - route_pool_requires_approval / route_under_approval_pool: 通常の経路の枠かその祖先が承認の要る枠。
// - overage_pool_invalid: 超過枠が承認の要る枠でない。
// - overage_pool_not_independent: 超過枠が根の枠でない（ADR 0006 の独立した枠。音声などの木を消費しない）。
// - autonomous_not_under_owner_pool: 自発の起点の LLM の枠が、本人の依頼の LLM の枠の子孫でない（同じ枠・枠の外。
//   本人の判断で分け、自発の枠の上限を迂回させない。本人の LLM の経路が null で自発の LLM の経路があるときも拒否）。
// - voice_pool_shared: 音声の枠の経路が LLM・検索の枠の経路と重なる（J17。融通しない）。
function routingErrors(budget, routing) {
  const errors = new Set();
  const pools = new Map(budget.pools.map((pool) => [pool.pool_id, pool]));
  const path = (id) => {
    const seen = [];
    let current = id;
    while (current !== null && pools.has(current) && !seen.includes(current)) {
      seen.push(current);
      current = pools.get(current).parent_pool_id;
    }
    return seen;
  };
  const routes = Object.entries(routing.routes);
  const textPools = [];
  const voicePools = [];
  for (const [, services] of routes)
    for (const [service, id] of Object.entries(services)) {
      if (id === null) continue;
      if (!pools.has(id)) {
        errors.add('unknown_route_pool');
        continue;
      }
      if (pools.get(id).requires_approval)
        errors.add('route_pool_requires_approval');
      else if (path(id).some((item) => pools.get(item).requires_approval))
        errors.add('route_under_approval_pool');
      (service === 'voice' ? voicePools : textPools).push(id);
    }
  const overage = routing.overage_pool_id;
  if (overage !== null) {
    if (!pools.has(overage)) errors.add('unknown_route_pool');
    else if (!pools.get(overage).requires_approval)
      errors.add('overage_pool_invalid');
    else if (pools.get(overage).parent_pool_id !== null)
      errors.add('overage_pool_not_independent');
  }
  const ownerLlm = routing.routes.owner_request.llm;
  for (const [origin, services] of routes)
    if (
      origin !== 'owner_request' &&
      services.llm !== null &&
      pools.has(services.llm) &&
      // 本人の LLM の経路がなければ、配下に限る制約を確かめられないので拒否する（閉じた側）。
      (ownerLlm === null ||
        (pools.has(ownerLlm) &&
          (services.llm === ownerLlm ||
            !path(services.llm).includes(ownerLlm))))
    )
      errors.add('autonomous_not_under_owner_pool');
  const textPaths = new Set(textPools.flatMap(path));
  if (voicePools.some((id) => path(id).some((item) => textPaths.has(item))))
    errors.add('voice_pool_shared');
  return [...errors];
}

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
  // 単価・為替・実行時の設定・利用状況・超過の承認・手での精算（ADR 0034）。
  if (
    name === 'BudgetSettlement' &&
    value.provider_reconciliation_id.startsWith('manual:')
  )
    errors.push('manual_prefix_reserved');
  if (name === 'CurrencyConversion') {
    if (decimalMicros(value.rate) === 0n) errors.push('non_positive_rate');
    if (decimalMicros(value.safety_factor) < 1_000_000n)
      errors.push('safety_factor_below_one');
  }
  if (name === 'PriceVersion') {
    if (
      value.effective_to !== null &&
      Date.parse(value.effective_from) >= Date.parse(value.effective_to)
    )
      errors.push('effective_period_order');
    const categories = value.rates.map((rate) => rate.category);
    if (new Set(categories).size !== categories.length)
      errors.push('duplicate_category');
    if (
      categories.includes('cached_input_tokens') &&
      !categories.includes('input_tokens')
    )
      errors.push('cache_without_input');
    // M は入力をキャッシュなしの単価で見積もる（05 固定部分の節）。cached の 1 単位あたりの単価が入力より高い版は、
    // 前提が崩れて M を少なく見積もり得るので拒否する（ADR 0035。domain も高い方を使って二重に守る）。
    const inputRate = value.rates.find(
      (rate) => rate.category === 'input_tokens',
    );
    const cachedRate = value.rates.find(
      (rate) => rate.category === 'cached_input_tokens',
    );
    if (
      inputRate &&
      cachedRate &&
      BigInt(cachedRate.unit_price) * BigInt(inputRate.per_quantity) >
        BigInt(inputRate.unit_price) * BigInt(cachedRate.per_quantity)
    )
      errors.push('cached_price_above_input');
    for (const rate of value.rates) {
      const input = ['input_tokens', 'cached_input_tokens'].includes(
        rate.category,
      );
      if (rate.max_quantity_per_request === null && !input)
        errors.push('unbounded_category');
      if (
        rate.max_quantity_per_request !== null &&
        BigInt(rate.minimum_quantity) > BigInt(rate.max_quantity_per_request)
      )
        errors.push('minimum_exceeds_max');
    }
    if (
      value.currency === value.conversion.to_currency &&
      decimalMicros(value.conversion.rate) !== 1_000_000n
    )
      errors.push('same_currency_rate');
    errors.push(...semanticErrors('CurrencyConversion', value.conversion));
  }
  if (name === 'BudgetRuntimeConfig') {
    if (value.time_zone !== null)
      errors.push(...semanticErrors('TimeZone', value.time_zone));
    errors.push(...semanticErrors('BudgetConfig', value.budget));
    const ids = value.price_versions.map((item) => item.price_version);
    if (new Set(ids).size !== ids.length)
      errors.push('duplicate_price_version');
    for (const id of value.budget.verified_price_versions)
      if (!ids.includes(id)) errors.push('unknown_verified_price_version');
    for (const [index, item] of value.price_versions.entries()) {
      errors.push(...semanticErrors('PriceVersion', item));
      if (item.conversion.to_currency !== value.budget.currency)
        errors.push('currency_mismatch');
      const end = (v) =>
        v.effective_to === null ? Infinity : Date.parse(v.effective_to);
      for (const other of value.price_versions.slice(index + 1))
        if (
          other.price_key === item.price_key &&
          Date.parse(item.effective_from) < end(other) &&
          Date.parse(other.effective_from) < end(item)
        )
          errors.push('price_period_overlap');
    }
    errors.push(...routingErrors(value.budget, value.routing));
  }
  if (name === 'BudgetOverageApproval') {
    if (Date.parse(value.expires_at) <= Date.parse(value.requested_at))
      errors.push('expires_before_requested');
    if (value.max_liability.currency !== value.overage_remaining.currency)
      errors.push('currency_mismatch');
    const decided = ['approved', 'rejected', 'consumed'].includes(value.status);
    if (decided !== (value.decided_at !== null))
      errors.push('decided_at_mismatch');
    if (
      value.decided_at !== null &&
      (Date.parse(value.decided_at) < Date.parse(value.requested_at) ||
        Date.parse(value.decided_at) > Date.parse(value.expires_at))
    )
      errors.push('decided_outside_period');
  }
  if (name === 'BudgetUsageSummary') {
    errors.push(...semanticErrors('TimeZone', value.time_zone));
    const months = value.months.map((item) => item.budget_month);
    if (new Set(months).size !== months.length) errors.push('duplicate_month');
    if (!months.includes(value.current_month))
      errors.push('missing_current_month');
    if (months.some((month) => month > value.current_month))
      errors.push('future_month');
    for (const month of value.months) {
      const pools = month.pools.map((pool) => pool.pool_id);
      if (new Set(pools).size !== pools.length) errors.push('duplicate_pool');
      // 親の枠の数は子孫の枠の分を含む（ADR 0006）。直下の子の合計が、精算済み・未精算の R・未精算の M の
      // それぞれで親を超えることはない。親子は循環しない。この月に出ていない親の枠は比べない。
      const byId = new Map(month.pools.map((pool) => [pool.pool_id, pool]));
      for (const pool of month.pools) {
        const seen = new Set([pool.pool_id]);
        let parent = pool.parent_pool_id;
        while (parent !== null && byId.has(parent)) {
          if (seen.has(parent)) {
            errors.push('pool_cycle');
            break;
          }
          seen.add(parent);
          parent = byId.get(parent).parent_pool_id;
        }
      }
      for (const parent of month.pools) {
        const children = month.pools.filter(
          (pool) => pool.parent_pool_id === parent.pool_id,
        );
        if (
          ['settled', 'unsettled_reserved', 'unsettled_max_liability'].some(
            (key) =>
              children.reduce(
                (sum, pool) => sum + BigInt(pool[key].amount),
                0n,
              ) > BigInt(parent[key].amount),
          )
        )
          errors.push('children_exceed_parent');
      }
      for (const pool of month.pools) {
        const amounts = [
          pool.limit,
          pool.settled,
          pool.unsettled_reserved,
          pool.unsettled_max_liability,
        ];
        if (amounts.some((item) => item.currency !== value.currency))
          errors.push('currency_mismatch');
        if (
          BigInt(pool.unsettled_reserved.amount) >
          BigInt(pool.unsettled_max_liability.amount)
        )
          errors.push('reservation_exceeds_max');
        if (
          pool.overrun_review_count > 0 &&
          !pool.hold_reasons.includes('overrun_review_pending')
        )
          errors.push('overrun_without_hold');
      }
    }
    for (const approval of value.overage_approvals) {
      errors.push(...semanticErrors('BudgetOverageApproval', approval));
      if (approval.status !== 'pending') errors.push('decided_approval_listed');
      if (approval.max_liability.currency !== value.currency)
        errors.push('currency_mismatch');
    }
    // 本人の操作を待つ予約（手での精算を待つ usage 不明と、M 超過の確認待ち）だけを並べる。
    const ids = value.pending_reservations.map((item) => item.reservation_id);
    if (new Set(ids).size !== ids.length) errors.push('duplicate_reservation');
    for (const item of value.pending_reservations) {
      errors.push(...semanticErrors('BudgetReservation', item));
      const overrun =
        item.status === 'settled' &&
        !item.overrun_reviewed &&
        item.actual_gross !== null &&
        BigInt(item.actual_gross.amount) > BigInt(item.max_liability.amount);
      if (item.status !== 'usage_unknown' && !overrun)
        errors.push('reservation_not_pending');
      if (!months.includes(item.budget_month))
        errors.push('reservation_month_missing');
      if (item.max_liability.currency !== value.currency)
        errors.push('currency_mismatch');
    }
  }
  if (name === 'BudgetOverrunReview') {
    if (value.actual_gross.currency !== value.max_liability.currency)
      errors.push('currency_mismatch');
    if (BigInt(value.actual_gross.amount) <= BigInt(value.max_liability.amount))
      errors.push('no_overrun');
  }
  if (name === 'BudgetManualSettlement') {
    const amounts = [
      value.actual_gross,
      value.credit_applied,
      value.additional_spend,
    ];
    if (amounts.some((item) => item.currency !== value.actual_gross.currency))
      errors.push('currency_mismatch');
    else if (
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
  // 予算保留（ADR 0037）。management_only では持たない。held は理由か保留の枠があるときだけ true。
  if (name === 'Snapshot' && value.budget_hold !== null) {
    if (value.view === 'management_only')
      errors.push('budget_hold_in_management_view');
    const hold = value.budget_hold;
    if (hold.held !== (hold.reasons.length > 0 || hold.held_pools.length > 0))
      errors.push('budget_hold_mismatch');
    const ids = hold.held_pools.map((pool) => pool.pool_id);
    if (new Set(ids).size !== ids.length) errors.push('duplicate_pool');
  }
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
  // 宛先と CC に同じ相手を重ねない（ADR 0027）。
  if (
    name === 'DraftReplyOperationIntent' &&
    value.action.cc.some((address) => value.action.to.includes(address))
  )
    errors.push('duplicate_recipient');
  // 用事の期限が地域日時なら、実在の日時かを確かめる（日付だけの値は format: date が確かめる、ADR 0027）。
  if (
    name === 'TaskOperationIntent' &&
    typeof value.action.due === 'string' &&
    value.action.due.includes('T')
  )
    errors.push(...semanticErrors('LocalDateTime', value.action.due));
  // 一般化した intent と preview は、action.kind で種類ごとの意味検査へ回す（ADR 0027）。
  if (name === 'OperationIntent') {
    const byKind = {
      'mail.labels.change': 'LabelOperationIntent',
      'mail.draft.create': 'DraftReplyOperationIntent',
      'task.create': 'TaskOperationIntent',
    };
    const kind = byKind[value.action.kind];
    if (kind) errors.push(...semanticErrors(kind, value));
  }
  if (name === 'OperationPreview')
    errors.push(...semanticErrors('OperationIntent', value.intent));
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
    // 予算の確認の項目（B07-05、ADR 0039）。接続している間だけ。種類ごとに持つ値が決まっている。
    if (value.link !== 'connected' && value.budget_items.length > 0)
      errors.push('budget_items_without_connection');
    if (
      value.budget_items.some(
        (item) =>
          (item.kind === 'overage_approval') !==
            (item.overage_remaining !== null && item.expires_at !== null) ||
          (item.kind === 'overage_approval') !==
            (item.overage_remaining !== null || item.expires_at !== null) ||
          (item.kind === 'overrun_review') !== (item.actual_gross !== null),
      )
    )
      errors.push('budget_entry_kind_mismatch');
    if (
      value.budget_items.some(
        (item) =>
          item.ordinal !== null && item.ordinal.position > item.ordinal.of,
      )
    )
      errors.push('budget_ordinal_out_of_range');
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
  // リースの更新の入力（B05-01、ADR 0038）。期限が確認の間隔より短い・同じなら更新が間に合わない。
  if (name === 'LeaseRenewalRequest' && value.heartbeat_ms >= value.ttl_ms)
    errors.push('heartbeat_not_shorter_than_ttl');
  // 外部への送信の同意（B05-01、ADR 0038）。取り消しが同意より前の時刻にならない。
  if (
    name === 'ExternalSendConsent' &&
    value.revoked_at !== null &&
    Date.parse(value.revoked_at) < Date.parse(value.granted_at)
  )
    errors.push('revoked_before_granted');
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
