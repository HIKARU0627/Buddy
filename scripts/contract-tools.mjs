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
