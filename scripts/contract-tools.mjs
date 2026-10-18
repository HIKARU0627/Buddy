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
  if (name === 'FieldEvidence' && value.start_utf16 >= value.end_utf16)
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
  if (name === 'LabelMailWireResponse') {
    if ((value.relation === 'new') !== (value.target_workflow_id === null))
      errors.push('relation_target');
  }
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
