import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CONNECTOR_READ_KINDS,
  CONNECTOR_RETRY_POLICY,
  LOOKUP_METHODS,
  OPERATION_STEP_KINDS,
  PRECONDITION_METHODS,
  RECONCILE_SCOPES,
  checkConnectorCapability,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

// B08-01 の connector の能力と再試行の契約（ADR 0027・0071）。形式は contracts:check が確かめる。
// ここでは、契約の列挙と domain の表が同じであること、domain の規則が宣言を拒否することを確かめる。
// 期待値は fixture に手で書き、実装の表から作らない。
const { validators, schema } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL(
      'packages/contracts/fixtures/connector-capability-cases.json',
      root,
    ),
    'utf8',
  ),
);

test('connector capability enums match the domain tables', () => {
  const defs = schema.$defs;
  assert.deepEqual([...CONNECTOR_READ_KINDS], defs.ConnectorReadKind.enum);
  assert.deepEqual([...PRECONDITION_METHODS], defs.PreconditionMethod.enum);
  assert.deepEqual([...LOOKUP_METHODS], defs.LookupMethod.enum);
  assert.deepEqual([...RECONCILE_SCOPES], defs.ReconcileScope.enum);
  assert.deepEqual([...OPERATION_STEP_KINDS], defs.OperationStepKind.enum);
});

test('the retry policy is the hand-written initial table and forbids write retries', () => {
  assert.deepEqual(CONNECTOR_RETRY_POLICY, cases.retry_policy);
  assert(validators['ConnectorRetryPolicy'](cases.retry_policy));
  assert.equal(cases.retry_policy.write_automatic_retries, 0);
  assert.equal(cases.retry_policy.read_max_attempts, 3);
  assert.deepEqual(cases.retry_policy.read_base_delay_ms, [2000, 10000]);
  assert.equal(cases.retry_policy.read_max_total_wait_ms, 120000);
});

test('every valid capability passes the domain rules and every invalid one is rejected', () => {
  for (const entry of cases.cases.filter(
    (item) => item.schema === 'ConnectorCapability' && item.valid,
  )) {
    assert(
      validators['ConnectorCapability'](entry.value),
      `${entry.id}: ${JSON.stringify(validators['ConnectorCapability'].errors)}`,
    );
    assert.deepEqual(
      checkConnectorCapability(entry.value),
      entry.expected_errors ?? [],
      entry.id,
    );
  }
  for (const entry of cases.cases.filter(
    (item) => item.schema === 'ConnectorCapability' && !item.valid,
  ))
    assert.equal(
      validators['ConnectorCapability'](entry.value),
      false,
      entry.id,
    );
});

test('the domain rules keep the hand-written rejections', () => {
  for (const entry of cases.domain_cases) {
    assert(
      validators['ConnectorCapability'](entry.capability),
      `${entry.id}: ${JSON.stringify(validators['ConnectorCapability'].errors)}`,
    );
    assert.deepEqual(
      checkConnectorCapability(entry.capability),
      entry.expected_errors,
      entry.id,
    );
  }
});

test('the sync state never carries a token or message body', () => {
  const valid = cases.cases.find((entry) => entry.id === 'sync-state').value;
  assert(validators['SyncStateResponse'](valid));
  for (const field of [
    'access_token',
    'refresh_token',
    'body',
    'text',
    'subjects',
  ])
    assert(
      !validators['SyncStateResponse']({ ...valid, [field]: 'forbidden' }),
      field,
    );
});
