import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseStrictJson, root } from './contract-tools.mjs';

// 試験 ID の対応表・B04 へ渡す故障点・証拠の形式を検査する（B00-10 #29、ADR 0011）。
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));
const map = await read('tests/test-map.json');
const faults = await read('tests/integration/fault-points.json');
const transitions = await read(
  'packages/contracts/fixtures/operation-transitions.json',
);
const ledger = await readFile(
  new URL('docs/b00/contract-map.md', root),
  'utf8',
);

const range = (prefix, count) =>
  Array.from(
    { length: count },
    (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`,
  );
const ALL = [...range('X', 66), ...range('QA', 45), ...range('MA', 6)];
const T_CODES = range('T', 10);

test('every test ID has an owner phase, a fixture or follow-up, and an unrun product state', async () => {
  assert.deepEqual(
    map.tests.map((entry) => entry.id),
    ALL,
  );
  assert.deepEqual(Object.keys(map.statuses).sort(), [
    'contract_fixture',
    'specified',
  ]);
  assert.deepEqual(Object.keys(map.product_tests).sort(), [
    'deferred',
    'not_run',
  ]);
  const known = new Set(ALL);
  for (const entry of map.tests) {
    assert(entry.status in map.statuses, entry.id);
    assert(entry.product_test in map.product_tests, entry.id);
    assert.equal(
      entry.status === 'contract_fixture',
      entry.contract_fixtures.length > 0,
      entry.id,
    );
    if (entry.product_test !== 'deferred')
      assert(entry.phases.length > 0, `${entry.id} has no phase`);
    for (const phase of entry.phases)
      assert.match(phase, /^B(0[1-9]|1[0-5])$/u, entry.id);
    if (entry.id.startsWith('X')) {
      assert(entry.t.length > 0, entry.id);
      for (const code of entry.t)
        assert(T_CODES.includes(code), `${entry.id} ${code}`);
    }
    if (entry.id.startsWith('QA')) assert(entry.targets.length > 0, entry.id);
    for (const related of entry.related ?? [])
      assert(known.has(related), `${entry.id} ${related}`);
    for (const ref of entry.contract_fixtures) {
      const [file, caseId] = ref.split('#');
      const text = await readFile(new URL(file, root), 'utf8');
      assert(
        text.toUpperCase().includes(entry.id),
        `${ref} does not mention ${entry.id}`,
      );
      assert(text.includes(`"${caseId}"`), `${ref} has no case ${caseId}`);
    }
  }
  // 台帳に出てくる試験 ID は、すべて対応表にある。
  for (const match of ledger.matchAll(/\b(X|QA|MA)(\d{2})\b/gu))
    assert(known.has(`${match[1]}${match[2]}`), match[0]);
  // 合格を表す値を置かない。
  const text = JSON.stringify(map);
  assert(!/"(?:passed|pass|合格)"/u.test(text));
});

test('X01〜X11 fault points and expected transitions are ready for B04', () => {
  const byId = new Map(transitions.cases.map((entry) => [entry.id, entry]));
  assert.equal(faults.mock_service.persists_across_core_restart, true);
  assert.equal(faults.mock_service.deduplicates_requests, false);
  for (const field of [
    'operation_id',
    'attempt_id',
    'step_id',
    'receive_order',
    'applied_change',
    'responded',
  ])
    assert(faults.mock_service.records.includes(field), field);
  const covered = new Set(faults.cases.map((entry) => entry.id.slice(0, 3)));
  for (const id of range('X', 11))
    assert(covered.has(id), `${id} has no fault case`);
  for (const entry of faults.cases) {
    for (const point of entry.faults)
      assert(point in faults.fault_points, `${entry.id} ${point}`);
    if (entry.transition_case === null) {
      assert(entry.scenario, entry.id);
      continue;
    }
    const transition = byId.get(entry.transition_case);
    assert(transition, `${entry.id} → ${entry.transition_case}`);
    assert.equal(entry.expected.approvals, transition.approvals, entry.id);
    assert.equal(
      entry.expected.provider_requests,
      transition.external_writes,
      entry.id,
    );
    assert.equal(
      entry.expected.core_final_state,
      transition.path.at(-1),
      entry.id,
    );
    // 試験装置だけが知る真の結果と、中枢が観測できる結果を別に持つ。
    assert(
      entry.expected.provider_truth && entry.expected.core_observed,
      entry.id,
    );
  }
});

test('test evidence records separate mock, device, real API and billing runs', async () => {
  const schema = await read('tests/integration/test-evidence.schema.json');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const evidence = {
    case_id: 'X06',
    kind: 'mock_service',
    commit: 'abcdef1',
    contract_version: '1.0.0',
    db_version: '1',
    environment: { os: 'macOS', hub: '合成の中枢', devices: ['合成の端末'] },
    seed: '42',
    fault_point: 'after_dispatch_intent_before_send',
    provider_requests: 0,
    provider_state_changes: 0,
    approvals: 1,
    final_state: 'unknown_held',
    observed_at: '2026-10-05T09:00:00+09:00',
    deviation: null,
    voice_stop_ms: null,
    outcome: 'matched_expectation',
  };
  assert(validate(evidence), JSON.stringify(validate.errors));
  for (const change of [
    { kind: 'passed' },
    { outcome: 'passed' },
    { mail_body: '本文' },
    { case_id: 'X67' },
  ])
    assert(!validate({ ...evidence, ...change }), JSON.stringify(change));
  const { deviation, ...missing } = evidence;
  assert.equal(deviation, null);
  assert(!validate(missing));
});

test('recorded device evidence follows the evidence format and stays separate from mock runs', async () => {
  const { readdir } = await import('node:fs/promises');
  const schema = await read('tests/integration/test-evidence.schema.json');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const files = (await readdir(new URL('tests/integration/', root))).filter(
    (name) => /^evidence-.+\.json$/u.test(name),
  );
  assert(files.length > 0);
  for (const name of files) {
    const doc = await read(`tests/integration/${name}`);
    assert(doc.records.length > 0, name);
    const ids = new Set();
    for (const record of doc.records) {
      assert(validate(record), `${name}: ${JSON.stringify(validate.errors)}`);
      assert(!ids.has(record.case_id), `${name}: ${record.case_id}`);
      ids.add(record.case_id);
      // 実機の記録の名前の付いたファイルに、模擬の結果を混ぜない。
      assert.equal(record.kind, 'real_device', `${name}: ${record.case_id}`);
    }
  }
});
