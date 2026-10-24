import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  OPERATION_TRANSITIONS,
  buildLedgerEntry,
  chunkNoticeItems,
  commandGuard,
  forgetOperationContent,
  lateResultCheck,
  operationContentPurgeable,
  planForget,
  resolveForgetTarget,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// ビルド後の domain を、手書きの期待値（packages/contracts/fixtures/forget-plan-cases.json）で検査する。
// 期待値は fixture に手で書き、計画の関数から作らない。HMAC は対応表の関数を注入する（domain は鍵を持たない）。
const spec = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/forget-plan-cases.json', root),
    'utf8',
  ),
);

const node = (text) => {
  const at = text.indexOf(':');
  return { kind: text.slice(0, at), id: text.slice(at + 1) };
};
const ref = (text) => {
  const { kind, id } = node(text);
  return { source_kind: kind, source_id: id };
};
const nodeText = (value) => `${value.kind}:${value.id}`;
const refText = (value) => `${value.source_kind}:${value.source_id}`;

function hmacFrom(...tables) {
  const table = Object.assign({}, ...tables);
  return (source) => {
    const value = table[`${source.source_kind}:${source.source_id}`];
    assert.ok(
      value,
      `hmac missing for ${source.source_kind}:${source.source_id}`,
    );
    return value;
  };
}

function graphOf(world, overrides = {}) {
  return {
    edges: (world.edges ?? [])
      .concat(overrides.extra_edges ?? [])
      .map(([artifact, source]) => ({
        artifact: node(artifact),
        source: node(source),
      })),
    unattributed: world.unattributed.map(([artifact, scope]) => ({
      artifact: node(artifact),
      scope: node(scope),
    })),
    turn_sessions: world.turn_sessions.map(([turn_id, session_id]) => ({
      turn_id,
      session_id,
    })),
    memories: (overrides.memories ?? world.memories).map(
      ([memory_id, dedupe_key]) => ({ memory_id, dedupe_key }),
    ),
    operations: world.operations.map(([operation_id, state]) => ({
      operation_id,
      state,
    })),
  };
}

function planInput(entry, extra = {}) {
  const world = spec.worlds[entry.world];
  return {
    target: ref(entry.input.target),
    instruction_turn_id: entry.input.instruction_turn_id,
    executing_operation_id: entry.input.executing_operation_id,
    graph: graphOf(world, {
      extra_edges: entry.extra_edges,
      memories: entry.memories_override,
    }),
    sourceHmac:
      entry.hmac_mode === 'raw_id'
        ? (source) => source.source_id
        : hmacFrom(spec.hmacs),
    ...extra,
  };
}

function summarize(plan) {
  return {
    targets: plan.targets.map(nodeText),
    deletions: plan.deletions.map(nodeText),
    purge_operation_contents: [...plan.operation_contents.purge],
    retained_operations: plan.operation_contents.retained.map((item) => [
      item.operation_id,
      item.state,
      item.reason,
    ]),
    ledger: plan.ledger,
    notice_forgotten: plan.notice.forgotten.map(
      (item) => `${item.item_kind}:${item.item_id}`,
    ),
    notice_derived: plan.notice.derived_from_forgotten.map(
      (item) => `${item.item_kind}:${item.item_id}`,
    ),
  };
}

test('forget targets resolve to exactly one row, otherwise the user is asked', () => {
  const known = spec.resolve.known.map(ref);
  for (const entry of spec.resolve.cases) {
    const request =
      entry.request.by === 'id'
        ? { by: 'id', ref: ref(entry.request.ref) }
        : { by: 'query', matches: entry.request.matches.map(ref) };
    const result = resolveForgetTarget(request, known);
    const expected = entry.expected;
    const wire =
      expected.outcome === 'resolved'
        ? { outcome: 'resolved', target: refText(result.target) }
        : {
            outcome: 'ask_back',
            reason: result.reason,
            candidates: result.candidates.map(refText),
          };
    assert.deepEqual(wire, expected, entry.id);
  }
});

test('a search term never reaches the confirmed content, plan, ledger entry or notices', () => {
  // Core が RAM で検索語を当てる。domain には当たった対象の参照だけが渡り、検索語を受け取る口はない。
  const query = 'Q-SECRET-ZEBRA-synthetic-query';
  const matches = [ref('memory:mem-tea')];
  const resolution = resolveForgetTarget(
    { by: 'query', matches },
    spec.resolve.known.map(ref),
  );
  assert.equal(resolution.outcome, 'resolved');
  const content = forgetOperationContent(resolution.target);
  assert.deepEqual(Object.keys(content), ['targets']);
  assert.deepEqual(content, {
    targets: [{ source_kind: 'memory', source_id: 'mem-tea' }],
  });
  const entry = spec.plans.find(
    (item) => item.id === 'x15-forget-memory-closure',
  );
  const result = planForget(planInput(entry));
  assert.equal(result.ok, true);
  const ledger = buildLedgerEntry(result.plan.ledger, {
    entry_id: 'e-1',
    previous_generation: '0',
    recorded_at: '2030-10-24T00:00:00Z',
  });
  assert.equal(ledger.ok, true);
  const all = JSON.stringify([resolution, content, result, ledger]);
  assert.ok(!all.includes(query));
  assert.ok(!all.includes('SECRET'));
  // 聞き返しの候補にも、検索語・本文は入らない（参照だけ）。
  const ask = resolveForgetTarget(
    { by: 'query', matches: [ref('memory:mem-tea'), ref('memory:mem-other')] },
    spec.resolve.known.map(ref),
  );
  assert.equal(ask.outcome, 'ask_back');
  for (const candidate of ask.candidates)
    assert.deepEqual(Object.keys(candidate).sort(), [
      'source_id',
      'source_kind',
    ]);
});

test('operation contents are purged only for finished operations (all states)', () => {
  const states = Object.keys(spec.operation_content_purgeable.expected);
  for (const state of Object.keys(OPERATION_TRANSITIONS))
    assert.ok(states.includes(state), `${state} is missing from the fixture`);
  for (const [state, expected] of Object.entries(
    spec.operation_content_purgeable.expected,
  ))
    assert.equal(operationContentPurgeable(state), expected, state);
});

test('the derivation closure matches the hand-written plans', () => {
  for (const entry of spec.plans) {
    const result = planForget(planInput(entry));
    assert.equal(result.ok, true, entry.id);
    const { survivors, ok, ...expected } = entry.expected;
    assert.equal(ok, true);
    assert.deepEqual(summarize(result.plan), expected, entry.id);
    // 残る物は、消す一覧に入らない（元の発言・メールは再登録の禁止だけで、消さない）。
    const deleted = new Set(result.plan.deletions.map(nodeText));
    for (const survivor of survivors ?? [])
      assert.ok(!deleted.has(survivor), `${entry.id}: ${survivor} survives`);
  }
});

test('the closure leaves no live derivative of a forgotten item', () => {
  for (const entry of spec.plans) {
    const world = spec.worlds[entry.world];
    const result = planForget(planInput(entry));
    const gone = new Set(result.plan.deletions.map(nodeText));
    // 忘れた物（台帳の forgotten）から作られた物は、消えるか、確定内容の扱い（進行中の操作）に回る。
    const forgotten = new Set(
      result.plan.ledger.forgotten
        .filter((item) => item.source_kind !== 'source_item')
        .map((item) => `${item.source_kind}:${item.source_id}`),
    );
    for (const target of result.plan.targets) forgotten.add(nodeText(target));
    const retained = new Set(
      result.plan.operation_contents.retained.map(
        (item) => `operation_content:${item.operation_id}`,
      ),
    );
    const purged = new Set(
      result.plan.operation_contents.purge.map(
        (id) => `operation_content:${id}`,
      ),
    );
    for (const [artifact, source] of world.edges) {
      const doomedSource = forgotten.has(source) || gone.has(source);
      if (!doomedSource) continue;
      assert.ok(
        gone.has(artifact) || retained.has(artifact) || purged.has(artifact),
        `${entry.id}: ${artifact} derives from the forgotten ${source} but is left behind`,
      );
    }
    // 計画に、操作の状態を変える・取り消す・失効する・送り直す項目はない。
    assert.deepEqual(Object.keys(result.plan).sort(), [
      'deletions',
      'ledger',
      'notice',
      'operation_contents',
      'targets',
    ]);
    assert.deepEqual(Object.keys(result.plan.operation_contents).sort(), [
      'purge',
      'retained',
    ]);
    assert.ok(
      [...gone].every((item) => !item.startsWith('operation')),
      `${entry.id}: no operation row is deleted`,
    );
  }
});

test('in-flight operations are never deleted, cancelled or sent again by forgetting', () => {
  const entry = spec.plans.find(
    (item) => item.id === 'x15-in-flight-operations-are-never-touched',
  );
  const result = planForget(planInput(entry));
  assert.equal(result.ok, true);
  const retained = new Map(
    result.plan.operation_contents.retained.map((item) => [
      item.operation_id,
      item,
    ]),
  );
  for (const state of [
    'awaiting_approval',
    'approved',
    'preparing',
    'dispatching',
    'reconciling',
    'unknown_held',
    'not_executed',
  ])
    assert.equal(retained.get(`op-${state}`)?.reason, 'in_flight', state);
  // 状態の記録が見つからない操作も、消さずに残す。
  assert.equal(retained.get('op-no-record')?.reason, 'state_unknown');
  for (const state of ['succeeded', 'cancelled', 'superseded'])
    assert.ok(result.plan.operation_contents.purge.includes(`op-${state}`));
  // 実行中の memory_forget だけは、同じ transaction で完了するので、進行中の状態でも確定内容を消してよい。
  const executing = planForget(
    planInput(
      {
        ...entry,
        input: { ...entry.input, executing_operation_id: 'op-approved' },
      },
      {},
    ),
  );
  assert.ok(executing.plan.operation_contents.purge.includes('op-approved'));
  assert.ok(
    !executing.plan.operation_contents.retained.some(
      (item) => item.operation_id === 'op-approved',
    ),
  );
  assert.equal(executing.plan.operation_contents.retained.length, 7);
});

test('plans are refused instead of guessing when the graph or the HMAC is wrong', () => {
  for (const entry of spec.plan_rejections) {
    const result = planForget(planInput(entry));
    assert.equal(result.ok, false, entry.id);
    assert.deepEqual(result.reasons, entry.expected_reasons, entry.id);
  }
});

test('the ledger entry carries only IDs and HMACs, one generation after the previous', () => {
  const plans = new Map(spec.plans.map((item) => [item.id, item]));
  const section = spec.ledger_entry;
  const result = planForget(planInput(plans.get(section.plan)));
  const built = buildLedgerEntry(result.plan.ledger, section.meta);
  assert.equal(built.ok, true);
  assert.deepEqual(built.entry, section.expected_entry);
  // 元情報の生の ID は、台帳のどこにも出ない。
  const text = JSON.stringify(built.entry);
  for (const raw of ['mail-a', 'mail-z']) assert.ok(!text.includes(raw), raw);
  const withSourceItem = planForget(
    planInput(plans.get('x15-forget-source-item')),
  );
  const sourceEntry = buildLedgerEntry(
    withSourceItem.plan.ledger,
    section.meta,
  );
  assert.ok(!JSON.stringify(sourceEntry.entry).includes('mail-a'));
  for (const rejection of section.rejections) {
    const outcome = buildLedgerEntry(rejection.ledger, {
      ...section.meta,
      ...(rejection.meta_override ?? {}),
    });
    assert.equal(outcome.ok, false, rejection.id);
    assert.deepEqual(outcome.reasons, rejection.expected_reasons, rejection.id);
  }
});

test('notices are split into chunks the retention notice accepts', () => {
  const items = Array.from({ length: 513 }, (_, index) => ({
    item_kind: 'memory',
    item_id: `m-${index}`,
  }));
  const chunks = chunkNoticeItems(items);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [256, 256, 1],
  );
  assert.deepEqual(chunkNoticeItems([]), []);
});

test('late results are judged by whether their sources relate to a forgetting', () => {
  const late = spec.late_results;
  const hmac = hmacFrom(spec.hmacs, late.extra_hmacs);
  for (const entry of late.cases) {
    const result = {
      ...late.base_result,
      ...entry.result,
    };
    result.sources = result.sources.map(ref);
    const context = {
      ...late.base_context,
      ...entry.context,
      sourceHmac: hmac,
    };
    assert.deepEqual(
      lateResultCheck(result, context),
      entry.expected,
      entry.id,
    );
  }
});

// 忘却と遅着の順序をすべて入れ替える。保存の内容は小さな模擬の保存先（このファイルの中）で、台帳への追記と
// 派生物の削除は domain の計画をそのまま適用する。期待値は fixture に手で書いた。
function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

function runOrder(order, jobSources, section) {
  const hmac = hmacFrom(section.hmacs);
  const store = {
    edges: section.initial_store.edges.map(([a, s]) => [a, s]),
    present: new Set(section.initial_store.surviving_before),
    ledger: [],
  };
  const forgets = {
    F1: { target: 'turn:t-a', id: 'e-1' },
    F2: { target: 'turn:t-c', id: 'e-2' },
  };
  let startedGeneration = null;
  let decision = null;
  for (const step of order) {
    if (step === 'S') {
      startedGeneration = String(store.ledger.length);
    } else if (step === 'A') {
      decision = lateResultCheck(
        {
          use: 'persist',
          sources: jobSources.map(ref),
          provenance: 'complete',
          started_generation: startedGeneration,
          permission_revision: '1',
          content_key: null,
        },
        {
          privateConversation: false,
          currentForgettingGeneration: String(store.ledger.length),
          currentPermissionRevision: '1',
          ledger: store.ledger,
          sourceHmac: hmac,
          expiredSourceIds: [],
        },
      );
      if (decision.action === 'accept') {
        store.present.add('session_summary:art-job');
        for (const source of jobSources)
          store.edges.push(['session_summary:art-job', source]);
      }
    } else {
      const forget = forgets[step];
      const result = planForget({
        target: ref(forget.target),
        instruction_turn_id: null,
        executing_operation_id: null,
        graph: {
          edges: store.edges
            .filter(([artifact]) => store.present.has(artifact))
            .map(([artifact, source]) => ({
              artifact: node(artifact),
              source: node(source),
            })),
          unattributed: [],
          turn_sessions: [],
          memories: [],
          operations: [],
        },
        sourceHmac: hmac,
      });
      assert.equal(result.ok, true);
      const entry = buildLedgerEntry(result.plan.ledger, {
        entry_id: forget.id,
        previous_generation: String(store.ledger.length),
        recorded_at: '2030-10-24T00:00:00Z',
      });
      assert.equal(entry.ok, true);
      store.ledger.push(entry.entry);
      for (const gone of result.plan.deletions)
        store.present.delete(nodeText(gone));
    }
  }
  return { decision, present: [...store.present].sort(), store };
}

test('every order of forgetting and late arrival leaves no forgotten derivative behind', () => {
  const section = spec.ordering;
  const orders = permutations(['S', 'A', 'F1', 'F2'])
    .filter((order) => order.indexOf('S') < order.indexOf('A'))
    .map((order) => order.join(' '));
  // 手で書いた 12 通りと、入れ替えて得た順序が一致する（抜けも余りもない）。
  assert.deepEqual(
    [...orders].sort(),
    Object.keys(section.related.expected_by_order).sort(),
  );
  for (const order of orders) {
    const steps = order.split(' ');
    const related = runOrder(steps, section.related.job_sources, section);
    assert.equal(
      related.decision.action,
      section.related.expected_by_order[order],
      `related ${order}`,
    );
    assert.deepEqual(
      related.present,
      [...section.related.final_present].sort(),
      `related ${order}`,
    );
    assert.equal(
      String(related.store.ledger.length),
      section.final_ledger_generation,
    );
    const unrelated = runOrder(steps, section.unrelated.job_sources, section);
    assert.equal(unrelated.decision.action, 'accept', `unrelated ${order}`);
    assert.deepEqual(
      unrelated.present,
      [...section.unrelated.final_present].sort(),
      `unrelated ${order}`,
    );
  }
});

test('the forgetting generation check of DB commands can be scoped to related sources', () => {
  const section = spec.scoped_command_guard;
  for (const entry of section.cases) {
    const command = { ...section.base_command, ...entry.command };
    const ledger = section.base_ledger.filter(
      (item) =>
        entry.scope.ledger_generations === undefined ||
        entry.scope.ledger_generations.includes(item.forgetting_generation),
    );
    const scope = {
      provenance: entry.scope.provenance,
      sources: entry.scope.sources.map(ref),
      ledger,
      sourceHmac: hmacFrom(section.hmacs),
    };
    assert.deepEqual(
      commandGuard(command, section.base_current, {
        external: false,
        forgetting: scope,
      }),
      entry.expected_scoped,
      `${entry.id} (scoped)`,
    );
    assert.deepEqual(
      commandGuard(command, section.base_current, { external: false }),
      entry.expected_strict,
      `${entry.id} (strict)`,
    );
  }
});
