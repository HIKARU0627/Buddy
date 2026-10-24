import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseStrictJson, root } from './contract-tools.mjs';
import {
  assertB04EvidenceSources,
  b04SourceFiles,
  b04SourceSha256,
  runtimeSpecifiers,
} from './b04-evidence-sources.mjs';
import {
  assertB07EvidenceSources,
  b07SourceFiles,
  b07SourceSha256,
} from './b07-evidence-sources.mjs';

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
  for (const id of ['X10']) {
    assert.equal(
      map.tests.find((e) => e.id === id).product_test,
      'simulated_partial',
    );
    assert(!evidence.records.some((r) => r.case_id === id));
  }
  // QA27（B04-07）: 外部の下書きの保存を含む 3 経路と、全経路の権限・期限の記録がそろうときだけ simulated。
  const qa27 = map.tests.find((e) => e.id === 'QA27');
  assert.equal(qa27.product_test, 'simulated');
  assert.deepEqual(
    qa27.product_evidence.map((ref) => ref.split('#')[1]),
    ['QA27-read', 'QA27-local', 'QA27-remote', 'QA27-auth', 'QA27-expiry'],
  );
  const remote = faults.qa_cases.find((c) => c.id === 'QA27-remote');
  assert.equal(remote.operation, 'draft_reply');
  assert.deepEqual(Object.keys(remote.expected.step_receives), [
    '1-create_draft',
  ]);
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

// 証拠の hash の対象は、B04 の実行器が実際に読み込むファイルと期待値・fixture だけ（司令塔の依頼、PR #107）。
const readOverridden = (overrides) => (path) =>
  path in overrides
    ? overrides[path]
    : readFileSync(new URL(path, root), 'utf8');

test('B04 の証拠の対象は実行器が読み込むファイルだけで、画面など関係のないファイルを含めない', () => {
  const files = b04SourceFiles();
  // 手で決めた、含めるべきファイル（実行器・Core の実行担当・模擬 provider・保存・期待値・fixture・マイグレーション）。
  for (const path of [
    'tests/integration/b04.test.mjs',
    'tests/integration/b04-cases.mjs',
    'tests/integration/b04-support.mjs',
    'tests/integration/fault-points.json',
    'scripts/b04-evidence-sources.mjs',
    'apps/core/src/operation-runner.ts',
    'apps/core/src/operation-runner-test-support.ts',
    'apps/core/src/api-turns.ts',
    'apps/desktop/src/main/hub-transport.ts',
    'packages/connectors/src/provider/server.ts',
    'packages/storage/src/db-worker.ts',
    'packages/storage/migrations/0005_runner.sql',
    'packages/contracts/schemas/buddy.schema.json',
    'packages/contracts/fixtures/h01.json',
    'packages/contracts/fixtures/operation-transitions.json',
  ])
    assert(files.includes(path), path);
  // 手で決めた、含めないファイル（画面・デスクトップの main の他の部品・別の試験・文書・証拠）。
  for (const path of [
    'apps/desktop/src/renderer/screens/work/WorkPanel.tsx',
    'apps/desktop/src/renderer/state/work-state.ts',
    'apps/desktop/src/main/operation-bridge.ts',
    'apps/desktop/src/main/two-clients.test.ts',
    'apps/core/src/draft-save.test.ts',
    'apps/core/src/cli.ts',
    'packages/storage/migrations/README.md',
    'tests/integration/evidence-b04-simulated.json',
    'docs/b04/README.md',
  ])
    assert(!files.includes(path), path);
  assert(files.every((path) => !path.startsWith('apps/desktop/src/renderer/')));
});

test('B04 の証拠は exports の解決に使った package.json を含み、対象のファイル同士で参照先を差し替えると失敗する', async () => {
  const files = b04SourceFiles();
  for (const path of [
    'packages/domain/package.json',
    'packages/storage/package.json',
    'packages/connectors/package.json',
    'packages/contracts/package.json',
  ])
    assert(files.includes(path), path);
  const evidence = await read('tests/integration/evidence-b04-simulated.json');
  // domain の入口を、すでに対象にある別のファイル（api.ts）へ差し替える。ファイルの集合は変わらなくても失敗する。
  const manifest = JSON.parse(
    readOverridden({})('packages/domain/package.json'),
  );
  manifest.exports['.'].default = './dist/api.js';
  const swapped = readOverridden({
    'packages/domain/package.json': `${JSON.stringify(manifest, null, 2)}\n`,
  });
  assert(b04SourceFiles(swapped).includes('packages/domain/src/api.ts'));
  assert.notDeepEqual(b04SourceSha256(swapped), b04SourceSha256());
  assert.throws(
    () => assertB04EvidenceSources(evidence, swapped),
    /B04 の証拠と現行ソースが不一致/u,
  );
});

test('B04 の証拠の対象外のファイルが変わっても検査は通り、対象のファイルが変われば失敗する', async () => {
  const evidence = await read('tests/integration/evidence-b04-simulated.json');
  const base = b04SourceSha256();
  // 対象外（画面・デスクトップの main の他の部品）を変えても、対象と hash は同じ。
  const outside = readOverridden({
    'apps/desktop/src/renderer/screens/work/WorkPanel.tsx': '// 合成の変更\n',
    'apps/desktop/src/main/operation-bridge.ts': '// 合成の変更\n',
  });
  assert.deepEqual(b04SourceSha256(outside), base);
  assertB04EvidenceSources(evidence, outside);
  // 対象（実行担当・期待値）を変えると失敗する。
  for (const path of [
    'apps/core/src/operation-runner.ts',
    'tests/integration/fault-points.json',
  ]) {
    const inside = readOverridden({
      [path]: `${readOverridden({})(path)}\n// 合成の変更\n`,
    });
    assert.notDeepEqual(b04SourceSha256(inside), base, path);
    assert.throws(
      () => assertB04EvidenceSources(evidence, inside),
      /B04 の証拠と現行ソースが不一致/u,
      path,
    );
  }
});

test('B04 の証拠の対象は import を機械的に辿り、型だけの import は辿らない', () => {
  const cases = readOverridden({})('tests/integration/b04-cases.mjs');
  const files = b04SourceFiles(
    readOverridden({
      'tests/integration/b04-cases.mjs': `${cases}
import '../../apps/desktop/dist/main/operation-bridge.js';
`,
      'apps/core/src/operation-runner.ts': `${readOverridden({})('apps/core/src/operation-runner.ts')}
import type { AdminConfirmRequest } from '@buddy/desktop/admin-confirm';
export type { Missing } from '../../desktop/src/main/admin-confirm.js';
`,
    }),
  );
  // 実行器に足した import の先（とその先）は対象に入る。
  assert(files.includes('apps/desktop/src/main/operation-bridge.ts'));
  // 型だけの import / export の先は対象に入らない。
  assert(!files.includes('apps/desktop/src/main/admin-confirm.ts'));
  assert.deepEqual(
    runtimeSpecifiers(
      "import type { A } from './a.js';\nimport { b } from './b.js';\nexport { c } from './c.js';\nexport type { D } from './d.js';\nconst e = await import('./e.js');\nconst f = new URL('./f.json', import.meta.url);\n",
    ).sort(),
    ['./b.js', './c.js', './e.js', './f.json'],
  );
});

// B07 の証拠（B07-06）。手書きの期待値・全ケース・seed・対応表の範囲・証拠の対象を、B04 と同じ規則で検査する。
// 模擬の予算の門と DB worker の統合だけで、実 API・実請求・実機の合格を意味しない。
const collectLedgers = (value, found = []) => {
  if (Array.isArray(value))
    for (const item of value) collectLedgers(item, found);
  else if (value !== null && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (key === 'ledger') found.push(item);
      else collectLedgers(item, found);
    }
  return found;
};

test('B07 のケース・seed・観測値・対応表の範囲が証拠と一致する', async () => {
  const spec = await read('tests/integration/b07-expectations.json');
  const evidence = await read('tests/integration/evidence-b07-simulated.json');
  const ids = spec.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(evidence.runs.length, ids.length * spec.seeds.length);
  const orders = new Set();
  for (const seed of spec.seeds) {
    const runs = evidence.runs.filter((r) => r.seed === String(seed));
    assert.deepEqual(runs.map((r) => r.case_id).sort(), [...ids].sort());
    // 実行した順序は、その seed の並べ替えの順序と同じ。
    assert.deepEqual(
      runs.map((r) => r.case_id),
      runs[0].order,
    );
    orders.add(runs[0].order.join(','));
    for (const run of runs) {
      const entry = spec.cases.find((c) => c.id === run.case_id);
      // 観測した値は、手書きの期待値と完全に一致する。
      assert.deepEqual(run.observed.checked, entry.expected, run.case_id);
      const ledgers = collectLedgers(entry.expected);
      assert(ledgers.length > 0, run.case_id);
      const sum = (key) => ledgers.reduce((n, l) => n + l[key], 0);
      assert.equal(run.observed.provider_requests, sum('provider_requests'));
      assert.equal(
        run.observed.provider_state_changes,
        sum('provider_state_changes'),
      );
      assert.equal(run.observed.approvals, sum('approvals'));
      assert.equal(
        run.observed.final_state,
        ledgers.map((l) => l.final_state).join(' | '),
      );
      // 予約の行と provider の記録の突き合わせは、すべての世界で指摘なし。
      for (const ledger of run.observed.ledgers)
        for (const found of Object.values(ledger.findings))
          assert.deepEqual(found, [], run.case_id);
      assert.deepEqual(run.faults, entry.faults);
    }
  }
  // seed ごとに実行の順序が違う（順序の並べ替えを実際に行った）。
  assert(orders.size > 1);
  assert.equal(evidence.records.length, ids.length);
  for (const entry of spec.cases) {
    const record = evidence.records.find((r) => r.case_id === entry.id);
    assert(record, entry.id);
    assert.equal(record.kind, 'simulated');
    assert.equal(record.outcome, 'matched_expectation');
    assert.equal(record.seed, spec.seeds.join(','));
    assert.equal(record.db_version, spec.db_version);
    assert.match(record.deviation, /実請求.*未実施/u);
  }
  // 対応表: B07 だけが担当の X18・X53・MA03〜MA06 は simulated。QA42 は B04 の送出の境界（操作の送出意図と予約の送出意図の
  // 結び付け）、QA20 は B10 の評価（意図判定）が未実施なので simulated_partial。クレジットの実残高の照合は B15。
  const expectedMap = {
    X18: [
      'X18-boundary-concurrency',
      'X18-overage-concurrency',
      'X18-pools-concurrency',
      'X18-topup-concurrency',
    ],
    X53: ['X53-autonomous-own-slot'],
    QA42: [
      'QA42-admission-by-m',
      'QA42-usage-duplicate-missing',
      'QA42-timeout-discard',
      'QA42-month-rollover',
      'QA42-overrun-hold',
      'QA42-overage-approval',
      'QA42-voice-isolation',
    ],
    QA20: ['QA20-price-boundary', 'QA20-limit-unknown'],
    MA03: ['MA03-credit-split-once'],
    MA04: ['MA04-cycle-and-month-are-separate'],
    MA05: [
      'MA05-hold-until-balance-is-known',
      'MA05-credit-rechecked-before-sending-and-top-up',
      'MA05-observations-are-adopted-once',
    ],
    MA06: ['MA06-credit-only-for-claude'],
  };
  for (const [id, cases] of Object.entries(expectedMap)) {
    const entry = map.tests.find((e) => e.id === id);
    assert.equal(
      entry.product_test,
      id === 'QA20' || id === 'QA42' ? 'simulated_partial' : 'simulated',
      id,
    );
    assert.deepEqual(
      entry.product_evidence.map((ref) => ref.split('#')[1]),
      cases,
      id,
    );
    for (const ref of entry.product_evidence)
      assert(ref.startsWith('tests/integration/evidence-b07-simulated.json#'));
    assert.match(entry.product_scope, /実請求.*未実施/u, id);
    assert.match(entry.product_scope, /B15/u, id);
  }
  // クレジットの区分（MA03〜MA06）は B07-07 の模擬で確認した。Console の実残高との照合・実請求・実 API は未実施。
  for (const id of ['MA03', 'MA04', 'MA05', 'MA06']) {
    const entry = map.tests.find((e) => e.id === id);
    assert.match(entry.product_scope, /Console|実残高|実請求/u, id);
    assert.match(entry.product_scope, /未実施/u, id);
  }
  // 期待値は個人の金額を含まない（合成の通貨 XTS だけ）。
  const text = JSON.stringify(spec);
  assert(!/"(JPY|USD|EUR)"/u.test(text));
});

test('B07 の証拠は現行ソースの全対象ファイルと hash が一致する', async () => {
  const evidence = await read('tests/integration/evidence-b07-simulated.json');
  assertB07EvidenceSources(evidence);
});

test('B07 の証拠の古い hash・欠落・余分なファイルを拒否する', async () => {
  const evidence = await read('tests/integration/evidence-b07-simulated.json');
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
      () => assertB07EvidenceSources(changed),
      /B07 の証拠と現行ソースが不一致/u,
    );
  }
});

test('B07 の証拠の対象は実行器が読み込むファイルだけで、B04 の実行器・画面・別の試験を含めない', () => {
  const files = b07SourceFiles();
  for (const path of [
    'tests/integration/b07.test.mjs',
    'tests/integration/b07-cases.mjs',
    'tests/integration/b07-support.mjs',
    'tests/integration/b07-expectations.json',
    'scripts/b07-evidence-sources.mjs',
    'scripts/evidence-sources.mjs',
    'apps/core/src/budget-gate.ts',
    'apps/core/src/budget-config.ts',
    'apps/core/src/budget-test-support.ts',
    'packages/domain/src/budget-rules.ts',
    'packages/domain/src/budget-credit.ts',
    'packages/storage/src/budget-store.ts',
    'packages/storage/src/db-worker.ts',
    'packages/storage/migrations/0006_budget.sql',
    'packages/storage/migrations/0007_budget_gate.sql',
    'packages/storage/migrations/0008_budget_credit.sql',
    'packages/contracts/schemas/buddy.schema.json',
    'packages/domain/package.json',
    'packages/storage/package.json',
  ])
    assert(files.includes(path), path);
  for (const path of [
    'apps/desktop/src/renderer/screens/work/WorkPanel.tsx',
    'apps/core/src/operation-runner.ts',
    'apps/core/src/budget-gate.test.ts',
    'apps/core/src/budget-core.test.ts',
    'apps/core/src/api-budget-pending.test.ts',
    'tests/integration/b04-cases.mjs',
    'tests/integration/fault-points.json',
    'scripts/b04-evidence-sources.mjs',
    'packages/contracts/fixtures/budget-scenarios.json',
    'tests/integration/evidence-b07-simulated.json',
    'docs/b07/README.md',
  ])
    assert(!files.includes(path), path);
  assert(files.every((path) => !path.startsWith('apps/desktop/src/renderer/')));
  // 集め方は B04 と共通で、B04 の対象にも共通の部品が入り、互いの実行器は入らない。
  const b04 = b04SourceFiles();
  assert(b04.includes('scripts/evidence-sources.mjs'));
  assert(!b04.includes('tests/integration/b07-cases.mjs'));
  assert(!b04.includes('apps/core/src/budget-test-support.ts'));
});

test('B07 の証拠の対象外のファイルが変わっても検査は通り、対象のファイルが変われば失敗する', async () => {
  const evidence = await read('tests/integration/evidence-b07-simulated.json');
  const base = b07SourceSha256();
  const outside = readOverridden({
    'apps/desktop/src/renderer/screens/work/WorkPanel.tsx': '// 合成の変更\n',
    'apps/core/src/budget-gate.test.ts': '// 合成の変更\n',
    'apps/core/src/operation-runner.ts': '// 合成の変更\n',
  });
  assert.deepEqual(b07SourceSha256(outside), base);
  assertB07EvidenceSources(evidence, outside);
  for (const path of [
    'apps/core/src/budget-gate.ts',
    'packages/storage/src/budget-store.ts',
    'packages/storage/migrations/0007_budget_gate.sql',
    'tests/integration/b07-expectations.json',
  ]) {
    const inside = readOverridden({
      [path]: `${readOverridden({})(path)}\n// 合成の変更\n`,
    });
    assert.notDeepEqual(b07SourceSha256(inside), base, path);
    assert.throws(
      () => assertB07EvidenceSources(evidence, inside),
      /B07 の証拠と現行ソースが不一致/u,
      path,
    );
  }
});

test('B07 の証拠の対象は import を機械的に辿り、型だけの import は辿らない', () => {
  const cases = readOverridden({})('tests/integration/b07-cases.mjs');
  const files = b07SourceFiles(
    readOverridden({
      'tests/integration/b07-cases.mjs': `${cases}
import '../../apps/desktop/dist/main/operation-bridge.js';
`,
      'apps/core/src/budget-gate.ts': `${readOverridden({})('apps/core/src/budget-gate.ts')}
import type { AdminConfirmRequest } from '@buddy/desktop/admin-confirm';
export type { Missing } from '../../desktop/src/main/admin-confirm.js';
`,
    }),
  );
  assert(files.includes('apps/desktop/src/main/operation-bridge.ts'));
  assert(!files.includes('apps/desktop/src/main/admin-confirm.ts'));
});

// B07 の完了条件 4（設定値・単価・請求通貨は実行時の入力で、個人の金額をコードへ固定しない）の静的な確認。
// 予算の製品のコード（門・設定の読み込み・domain の規則・保存・マイグレーション）に、実在の通貨コードの文字列がない。
test('B07 の製品のコードに通貨コード・単価を固定していない', () => {
  const sources = b07SourceFiles().filter(
    (path) =>
      /budget/u.test(path) &&
      /\.(ts|sql)$/u.test(path) &&
      !/(\.test\.ts|test-support\.ts)$/u.test(path),
  );
  assert(sources.length >= 6, sources.join(','));
  assert(sources.includes('apps/core/src/budget-gate.ts'));
  assert(sources.includes('packages/domain/src/budget-rules.ts'));
  assert(sources.includes('packages/storage/migrations/0006_budget.sql'));
  const reader = readOverridden({});
  for (const path of sources)
    assert(
      !/\b(JPY|USD|EUR|GBP|CNY|KRW|AUD|CAD)\b/u.test(reader(path)),
      `${path} に実在の通貨コードがあります`,
    );
});
