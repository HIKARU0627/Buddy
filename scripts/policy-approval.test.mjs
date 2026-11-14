import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  POLICY_AUTO_LIMIT,
  POLICY_AUTO_WINDOW_MINUTES,
  autoApprovalAllowed,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

// B13-01 の方針による自動承認・安全停止の件数・取り消しの対象版（ADR 0074）。
// 形式は contracts:check が確かめる。ここでは時間窓の境界と、契約の形を検査する。
const { validators } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/policy-approval-cases.json', root),
    'utf8',
  ),
);

test('the initial policy window is ten minutes and twenty actions', () => {
  assert.equal(POLICY_AUTO_WINDOW_MINUTES, 10);
  assert.equal(POLICY_AUTO_LIMIT, 20);
});

test('the hand-written auto approval boundaries are kept', () => {
  for (const entry of cases.domain_cases)
    assert.equal(
      autoApprovalAllowed(entry.counter, entry.now),
      entry.expected,
      entry.id,
    );
});

test('policy approval records, counters and undo targets keep their shape', () => {
  for (const entry of cases.cases) {
    const validate = validators[entry.schema];
    assert(validate, entry.schema);
    assert.equal(
      validate(entry.value),
      entry.valid,
      `${entry.id}: ${JSON.stringify(validate.errors)}`,
    );
  }
  const approval = cases.cases.find(
    (entry) => entry.id === 'policy-approval',
  ).value;
  for (const field of ['access_token', 'header', 'body'])
    assert(
      !validators['PolicyApprovalRecord']({
        ...approval,
        [field]: 'forbidden',
      }),
      field,
    );
  const safety = cases.cases.find(
    (entry) => entry.id === 'safety-with-counters',
  ).value;
  assert(validators['SafetyState'](safety));
  assert.equal(safety.auto_approvals.limit, 20);
  assert.equal(safety.auto_approvals.window_minutes, 10);
});
