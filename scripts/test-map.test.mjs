import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseStrictJson, root } from './contract-tools.mjs';
import { assertB04EvidenceSources } from './b04-evidence-sources.mjs';

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

test('全試験 ID の担当・契約例・実施範囲と証拠を追跡する', async () => {
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
    'simulated',
    'simulated_partial',
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
    assert.deepEqual(entry.expected.state_history, transition.path, entry.id);
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

test('記録済み証拠は Schema に従い模擬と実機を混ぜない', async () => {
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
      assert.equal(
        record.kind,
        name.endsWith('-simulated.json') ? 'simulated' : 'real_device',
        `${name}: ${record.case_id}`,
      );
    }
  }
});

// B04 の部分確認を全体合格に昇格させない。証拠の欠落・架空の実施済み状態も拒否する。
test('B04 のケース・seed・観測値・対応表の範囲が証拠と一致する', async () => {
  const evidence = await read('tests/integration/evidence-b04-simulated.json');
  const cases = [...faults.cases, ...faults.qa_cases];
  const expectedIds = cases.map((c) => c.id);
  assert.equal(evidence.runs.length, cases.length * faults.seeds.length);
  for (const seed of faults.seeds) {
    const runs = evidence.runs.filter((r) => r.seed === String(seed));
    assert.deepEqual(
      runs.map((r) => r.case_id).sort(),
      [...expectedIds].sort(),
    );
    assert.deepEqual(
      runs.map((r) => r.case_id),
      runs[0].order,
    );
    for (const run of runs) {
      const spec = cases.find((c) => c.id === run.case_id);
      const expected = spec.b04_expected ?? spec.expected;
      assert.equal(run.observed.provider_requests, expected.provider_requests);
      assert.equal(
        run.observed.provider_state_changes,
        expected.provider_state_changes,
      );
      assert.equal(run.observed.approval_count, expected.approvals);
      assert.deepEqual(
        run.observed.provider_receipts.map((r) => r.applied_change),
        expected.provider_applied_changes,
      );
      assert.deepEqual(run.observed.provider_labels, expected.provider_labels);
      if (expected.state_history) {
        assert.deepEqual(
          run.observed.state_history.map((h) => h.state),
          expected.state_history,
        );
        assert.equal(run.observed.final_state, expected.core_final_state);
      }
    }
  }
  for (const entry of map.tests) {
    if (!entry.product_test.startsWith('simulated')) continue;
    assert(entry.product_scope, entry.id);
    assert(entry.product_evidence.length > 0, entry.id);
    for (const ref of entry.product_evidence) {
      const [file, id] = ref.split('#');
      const doc = await read(file);
      const record = doc.records.find((r) => r.case_id === id);
      assert(record, ref);
      assert.equal(record.kind, 'simulated');
      assert.equal(record.outcome, 'matched_expectation');
    }
  }
  for (const id of ['X10', 'QA27']) {
    assert.equal(
      map.tests.find((e) => e.id === id).product_test,
      'simulated_partial',
    );
    assert(!evidence.records.some((r) => r.case_id === id));
  }
});

test('B04 の証拠は現行ソースの全対象ファイルと hash が一致する', async () => {
  const evidence = await read('tests/integration/evidence-b04-simulated.json');
  assertB04EvidenceSources(evidence);
});

test('B04 の証拠の古い hash・欠落・余分なファイルを拒否する', async () => {
  const evidence = await read('tests/integration/evidence-b04-simulated.json');
  for (const mutate of [
    (sources) => {
      sources[0].sha256 = '0'.repeat(64);
    },
    (sources) => {
      sources.pop();
    },
    (sources) => {
      sources.push({ path: 'tests/removed.mjs', sha256: '0'.repeat(64) });
    },
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed.source_sha256);
    assert.throws(
      () => assertB04EvidenceSources(changed),
      /B04 の証拠と現行ソースが不一致/u,
    );
  }
});
