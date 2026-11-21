// 関連集合の解析計画と実行直前の照合（B10-05 P4、ADR 0103）。QA32・QA45・X64・X65 の解析の層。
// 期待値は設計の規則から手で書いた値（hash は固定の文字列を別に計算して置いた）で、実装から作らない。
// 模擬の試験だけで、DB の transaction・実メール・実機は未実施。
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AnalysisState,
  EntityRecord,
  ResolvedChange,
} from '@buddy/domain';
import {
  entityOutcome,
  finalGuard,
  planRelatedAnalysis,
} from './related-analysis.js';
import type {
  AnalysisReader,
  AnalysisSnapshot,
  EntityReader,
  FinalGuardInput,
  PlannedSource,
  PlanRelatedAnalysisInput,
} from './related-analysis.js';

const HASH_M1_M2 =
  '058db7f97b85023c3ebd28aeef8d891cd196ec3ba6d223b092305ab803f124b0';
const HASH_M1_M2_M3 =
  'ff5d5d98061a31654b15a1c24be242808766db64c6b91b8a4821760b4c5c7e9e';
const HASH_M1 =
  'b8fa8328beef9cd7fd90114d66e5db7fa47d5271677e3c80f24238d08aa704f1';

const ENTITY_A = '3f8a1c52-7b64-4d0e-9a21-5c6e8f1b2a40';

const analyzed = { state: 'analyzed', rule_id: null } as const;
const source = (
  id: string,
  analysis: PlannedSource['analysis'] = analyzed,
  changes: readonly ResolvedChange[] = [],
  revision = 'r1',
): PlannedSource => ({
  source_id: id,
  source_revision: revision,
  analysis,
  changes,
});

const cancelOfA: ResolvedChange = {
  relation: 'cancel',
  target_request_entity_id: ENTITY_A,
  resolution: 'resolved',
};

const plan = (
  sources: readonly PlannedSource[],
  overrides: Partial<PlanRelatedAnalysisInput> = {},
) =>
  planRelatedAnalysis({
    group_id: 'g-1',
    published_generation: '1',
    enumeration_complete: true,
    sources,
    previous: null,
    ...overrides,
  });

test('a complete set of analyzed mails is ready, with a version fixed by ids and revisions only', () => {
  const result = plan([source('m2'), source('m1')]);
  assert.equal(result.related.status, 'ready');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.related.source_set_hash, HASH_M1_M2);
  assert.equal(result.related.analysis_revision, '1');
  assert.equal(result.related.published_generation, '1');
  assert.equal(result.related.plan_complete, true);
  assert.equal(result.related.unresolved_change_count, 0);
  // 必要ソースは ID の昇順（到着順・配列順に依存しない）。
  assert.deepEqual(
    result.related.sources.map((item) => item.source_id),
    ['m1', 'm2'],
  );
});

test('the plan is the same for any arrival order of sources and any order of their changes', () => {
  const sources = [
    source('m1'),
    source('m2', analyzed, [cancelOfA]),
    source('m3', { state: 'pending', rule_id: null }),
  ];
  const first = plan(sources);
  for (const order of [
    [0, 1, 2],
    [2, 1, 0],
    [1, 2, 0],
    [2, 0, 1],
  ]) {
    assert.deepEqual(
      plan(order.map((index) => sources[index] as PlannedSource)),
      first,
    );
  }
});

test('QA45: while the cancel mail is pending, unread, failed or waiting for budget, the set is not ready and no empty result passes', () => {
  const cases: readonly [PlannedSource['analysis'], string, string][] = [
    [{ state: 'pending', rule_id: null }, 'source_pending', 'pending'],
    [{ state: 'unread', rule_id: null }, 'source_unread', 'blocked'],
    [{ state: 'failed', rule_id: null }, 'source_failed', 'blocked'],
  ];
  for (const [state, reason, status] of cases) {
    const result = plan([source('a'), source('b', state)]);
    assert.deepEqual(result.reasons, [reason], reason);
    assert.equal(result.related.status, status, reason);
    assert.equal(result.analysis.sources[1]?.state, state.state);
  }
});

test('QA45: A-first and B-first converge to the same entity state and block all four creations once the cancel is confirmed', () => {
  const entity: EntityRecord = {
    request_entity_id: ENTITY_A,
    state: 'active',
    recreation_suppressed: false,
    created_operations: [],
  };
  // A だけ解析した段階では、取消が分からないので ready にならない（B が pending）。
  const early = plan([
    source('a'),
    source('b', { state: 'pending', rule_id: null }),
  ]);
  assert.equal(early.related.status, 'pending');
  // B が確定した後。変更の並びや到着の順が違っても同じ状態。
  const orders: readonly (readonly ResolvedChange[])[] = [
    [cancelOfA],
    [
      {
        relation: 'new',
        target_request_entity_id: null,
        resolution: 'resolved',
      },
      cancelOfA,
    ],
    [
      cancelOfA,
      {
        relation: 'new',
        target_request_entity_id: null,
        resolution: 'resolved',
      },
    ],
  ];
  for (const changes of orders) {
    const outcome = entityOutcome(entity, changes);
    assert.equal(outcome.state, 'cancelled');
    for (const kind of [
      'create_task',
      'create_event',
      'label_mail',
      'draft_reply',
    ])
      assert.deepEqual(
        outcome.auto_creation_blocked({
          kind,
          accountId: 'acct-1',
          calendarId: null,
        }),
        ['entity_cancelled'],
        kind,
      );
  }
  const done = plan([source('a'), source('b', analyzed, [cancelOfA])]);
  assert.equal(done.related.status, 'ready');
  // 取消の対象が一意に決まらなければ、状態は変えず、集合を ready にしない。
  const ambiguous: ResolvedChange = {
    relation: 'cancel',
    target_request_entity_id: null,
    resolution: 'ambiguous',
  };
  assert.equal(entityOutcome(entity, [ambiguous]).state, 'active');
  const blocked = plan([source('a'), source('b', analyzed, [ambiguous])]);
  assert.deepEqual(blocked.reasons, ['unresolved_changes']);
  assert.equal(blocked.related.unresolved_change_count, 1);
  assert.equal(blocked.related.status, 'blocked');
  const uncertain: ResolvedChange = {
    relation: 'uncertain',
    target_request_entity_id: null,
    resolution: 'unresolved',
  };
  assert.equal(
    plan([source('b', analyzed, [uncertain])]).related.unresolved_change_count,
    1,
  );
});

test('X64/X65: an already created operation, or one the user cancelled, is not created again', () => {
  const entity: EntityRecord = {
    request_entity_id: ENTITY_A,
    state: 'active',
    recreation_suppressed: false,
    created_operations: [
      {
        operation_kind: 'create_task',
        account_id: 'acct-1',
        calendar_id: null,
      },
    ],
  };
  const task = { kind: 'create_task', accountId: 'acct-1', calendarId: null };
  assert.deepEqual(entityOutcome(entity, []).auto_creation_blocked(task), [
    'already_created',
  ]);
  assert.deepEqual(
    entityOutcome(
      { ...entity, created_operations: [], recreation_suppressed: true },
      [],
    ).auto_creation_blocked(task),
    ['recreation_suppressed'],
  );
  assert.deepEqual(
    entityOutcome(
      { ...entity, created_operations: [] },
      [],
    ).auto_creation_blocked(task),
    [],
  );
});

test('the enumeration must be complete and non-empty before anything is ready (QA32)', () => {
  const partial = plan([source('a')], { enumeration_complete: false });
  assert.deepEqual(partial.reasons, ['plan_incomplete']);
  assert.equal(partial.related.status, 'pending');
  assert.equal(partial.related.plan_complete, false);
  const empty = plan([]);
  assert.deepEqual(empty.reasons, ['plan_incomplete']);
  assert.equal(empty.related.status, 'pending');
});

test('exclusions need a rule id; one without a rule blocks the set', () => {
  const withRule = plan([
    source('a'),
    source('b', {
      state: 'excluded',
      rule_id: 'prefilter_automated_no_cue_v1',
    }),
  ]);
  assert.equal(withRule.related.status, 'ready');
  const withoutRule = plan([
    source('a'),
    source('b', { state: 'excluded', rule_id: null }),
  ]);
  assert.deepEqual(withoutRule.reasons, ['excluded_without_rule']);
  assert.equal(withoutRule.related.status, 'blocked');
});

test('the version advances only when the set, a state, an unresolved count or the generation changes, and survives a restart', () => {
  const first = plan([source('m1'), source('m2')]);
  assert.equal(first.related.analysis_revision, '1');
  // 再起動: 同じ記録と保存した snapshot から作り直しても、同じ計画。
  const restarted = plan([source('m2'), source('m1')], {
    previous: first.snapshot,
  });
  assert.deepEqual(restarted, first);
  // 新しいメールの公開（集合が変わる）→ 版が進み、まだ解析していないので ready にならない。
  const grown = plan(
    [
      source('m1'),
      source('m2'),
      source('m3', { state: 'pending', rule_id: null }),
    ],
    { previous: first.snapshot },
  );
  assert.equal(grown.related.analysis_revision, '2');
  assert.equal(grown.related.source_set_hash, HASH_M1_M2_M3);
  assert.equal(grown.related.status, 'pending');
  // 解析が終わる（状態が変わる）→ さらに進む。
  const analyzedAll = plan([source('m1'), source('m2'), source('m3')], {
    previous: grown.snapshot,
  });
  assert.equal(analyzedAll.related.analysis_revision, '3');
  assert.equal(analyzedAll.related.status, 'ready');
  // 同じ入力では進まない。
  assert.equal(
    plan([source('m1'), source('m2'), source('m3')], {
      previous: analyzedAll.snapshot,
    }).related.analysis_revision,
    '3',
  );
  // 同じメールの版が変わる（訂正・削除後の再取得）と集合の版が変わる。
  const revised = plan([source('m1', analyzed, [], 'r2'), source('m2')], {
    previous: first.snapshot,
  });
  assert.notEqual(revised.related.source_set_hash, HASH_M1_M2);
  assert.equal(revised.related.analysis_revision, '2');
  // 公開世代が進むと、同じ集合でも版が進む。
  const generation = plan([source('m1'), source('m2')], {
    previous: first.snapshot,
    published_generation: '2',
  });
  assert.equal(generation.related.analysis_revision, '2');
  assert.equal(plan([source('m1')]).related.source_set_hash, HASH_M1);
});

test('a duplicated source id is a bug in the caller, not a plan', () => {
  assert.throws(() => plan([source('a'), source('a')]), /duplicate_source/u);
});

// --- 実行直前の照合 ---

const used = {
  group_id: 'g-1',
  analysis_revision: '1',
  source_set_hash: HASH_M1_M2,
  published_generation: '1',
};
const entityRecord: EntityRecord = {
  request_entity_id: ENTITY_A,
  state: 'active',
  recreation_suppressed: false,
  created_operations: [],
};
const baseGuard: FinalGuardInput = {
  used,
  entity: { request_entity_id: ENTITY_A, request_revision: '1' },
  current_published_generation: '1',
  operation: { kind: 'create_task', accountId: 'acct-1', calendarId: null },
  changes: [],
};

function readers(
  states: Readonly<Record<string, AnalysisState>>,
  entity: { record: EntityRecord; request_revision: string } | null = {
    record: entityRecord,
    request_revision: '1',
  },
): { analyses: AnalysisReader; entities: EntityReader } {
  return {
    analyses: { current: (groupId) => states[groupId] ?? null },
    entities: { current: () => entity },
  };
}

const currentOf = (
  sources: readonly PlannedSource[],
  previous: AnalysisSnapshot | null = null,
  overrides: Partial<PlanRelatedAnalysisInput> = {},
): AnalysisState => plan(sources, { previous, ...overrides }).analysis;

test('the final guard passes only when the version, readiness and entity are all current', () => {
  const ok = readers({ 'g-1': currentOf([source('m1'), source('m2')]) });
  assert.deepEqual(finalGuard(baseGuard, ok.analyses, ok.entities), {
    ok: true,
  });
});

test('QA45: a mail published after the decision but before dispatch rejects the old version', () => {
  const first = plan([source('m1'), source('m2')]);
  // 判定後に B（m3）が公開された。DB の現在値は新しい版で、まだ解析されていない。
  const later = plan(
    [
      source('m1'),
      source('m2'),
      source('m3', { state: 'pending', rule_id: null }),
    ],
    { previous: first.snapshot },
  );
  const r = readers({ 'g-1': later.analysis });
  const result = finalGuard(baseGuard, r.analyses, r.entities);
  assert.equal(result.ok, false);
  if (!result.ok) {
    for (const reason of [
      'analysis_revision_changed',
      'source_set_changed',
      'analysis_source_pending',
    ])
      assert.equal(result.reasons.includes(reason), true, reason);
  }
  // B の解析が終わって集合が ready に戻っても、旧版の判定は通らない（再判定が要る）。
  const done = plan([source('m1'), source('m2'), source('m3')], {
    previous: later.snapshot,
  });
  const afterRepair = readers({ 'g-1': done.analysis });
  const second = finalGuard(
    baseGuard,
    afterRepair.analyses,
    afterRepair.entities,
  );
  assert.equal(second.ok, false);
  if (!second.ok)
    assert.deepEqual(second.reasons, [
      'analysis_revision_changed',
      'source_set_changed',
    ]);
});

test('a newer published generation, a stale used generation or a not-ready current set is rejected', () => {
  const current = currentOf([source('m1'), source('m2')]);
  const r = readers({ 'g-1': current });
  const generation = finalGuard(
    { ...baseGuard, current_published_generation: '2' },
    r.analyses,
    r.entities,
  );
  assert.equal(generation.ok, false);
  if (!generation.ok)
    for (const reason of ['generation_changed', 'used_generation_stale'])
      assert.equal(generation.reasons.includes(reason), true, reason);
  // 版は同じでも、集合に未解決の変更がある（ready でない）なら通さない。
  const blockedState = currentOf([
    source('m1'),
    source('m2', analyzed, [
      {
        relation: 'cancel',
        target_request_entity_id: null,
        resolution: 'ambiguous',
      },
    ]),
  ]);
  const blocked = readers({
    'g-1': { ...blockedState, analysis_revision: '1' },
  });
  const result = finalGuard(baseGuard, blocked.analyses, blocked.entities);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.deepEqual(result.reasons, ['analysis_unresolved_changes']);
});

test('missing information is a rejection, never a pass', () => {
  const none = readers({});
  assert.deepEqual(finalGuard(baseGuard, none.analyses, none.entities), {
    ok: false,
    reasons: ['analysis_not_found'],
  });
  const ok = readers({ 'g-1': currentOf([source('m1'), source('m2')]) }, null);
  assert.deepEqual(finalGuard(baseGuard, ok.analyses, ok.entities), {
    ok: false,
    reasons: ['entity_not_found'],
  });
  assert.deepEqual(
    finalGuard(
      { ...baseGuard, used: null, entity: null },
      ok.analyses,
      ok.entities,
    ),
    { ok: false, reasons: ['related_analysis_missing', 'entity_missing'] },
  );
});

test('the entity must be the same version, still active and not already created', () => {
  const state = currentOf([source('m1'), source('m2')]);
  const changed = readers(
    { 'g-1': state },
    {
      record: entityRecord,
      request_revision: '2',
    },
  );
  assert.deepEqual(finalGuard(baseGuard, changed.analyses, changed.entities), {
    ok: false,
    reasons: ['request_revision_changed'],
  });
  // 判定後に取消が公開された（変更を含めて見る）。
  const normal = readers({ 'g-1': state });
  assert.deepEqual(
    finalGuard(
      { ...baseGuard, changes: [cancelOfA] },
      normal.analyses,
      normal.entities,
    ),
    { ok: false, reasons: ['entity_cancelled'] },
  );
  const created = readers(
    { 'g-1': state },
    {
      record: {
        ...entityRecord,
        created_operations: [
          {
            operation_kind: 'create_task',
            account_id: 'acct-1',
            calendar_id: null,
          },
        ],
      },
      request_revision: '1',
    },
  );
  assert.deepEqual(finalGuard(baseGuard, created.analyses, created.entities), {
    ok: false,
    reasons: ['already_created'],
  });
  const suppressed = readers(
    { 'g-1': state },
    {
      record: { ...entityRecord, recreation_suppressed: true },
      request_revision: '1',
    },
  );
  assert.deepEqual(
    finalGuard(baseGuard, suppressed.analyses, suppressed.entities),
    {
      ok: false,
      reasons: ['recreation_suppressed'],
    },
  );
});

test('QA45: a failure in another thread does not stop this one', () => {
  const other = plan(
    [source('x1'), source('x2', { state: 'failed', rule_id: null })],
    {
      group_id: 'g-2',
    },
  );
  assert.equal(other.related.status, 'blocked');
  const r = readers({
    'g-1': currentOf([source('m1'), source('m2')]),
    'g-2': other.analysis,
  });
  assert.deepEqual(finalGuard(baseGuard, r.analyses, r.entities), { ok: true });
  // g-2 の判定は通らない。
  const result = finalGuard(
    {
      ...baseGuard,
      used: {
        ...used,
        group_id: 'g-2',
        source_set_hash: other.related.source_set_hash,
      },
    },
    r.analyses,
    r.entities,
  );
  assert.equal(result.ok, false);
});

test('the version also advances when a resolved change appears or its target changes, but not when the changes are only reordered (review)', () => {
  const entityB = 'b8c1e2d3-4a5f-4b6c-8d7e-9f0a1b2c3d4e';
  const base = plan([source('m1'), source('m2')]);
  // 解析のやり直しで、変更が [] から確定した取消に変わる（未解決の数は 0 のまま）。
  const cancelled = plan([source('m1'), source('m2', analyzed, [cancelOfA])], {
    previous: base.snapshot,
  });
  assert.equal(cancelled.related.unresolved_change_count, 0);
  assert.equal(cancelled.related.source_set_hash, base.related.source_set_hash);
  assert.equal(cancelled.related.analysis_revision, '2');
  // 取消の対象が A から B に変わる。
  const retargeted = plan(
    [
      source('m1'),
      source('m2', analyzed, [
        { ...cancelOfA, target_request_entity_id: entityB },
      ]),
    ],
    { previous: cancelled.snapshot },
  );
  assert.equal(retargeted.related.analysis_revision, '3');
  // 関係が取消から完了に変わる。
  const completed = plan(
    [
      source('m1'),
      source('m2', analyzed, [{ ...cancelOfA, relation: 'complete' }]),
    ],
    { previous: cancelled.snapshot },
  );
  assert.equal(completed.related.analysis_revision, '3');
  // 変更の並び替えだけでは進まない。
  const other: ResolvedChange = {
    relation: 'new',
    target_request_entity_id: null,
    resolution: 'resolved',
  };
  const two = plan([source('m1'), source('m2', analyzed, [cancelOfA, other])], {
    previous: cancelled.snapshot,
  });
  assert.equal(two.related.analysis_revision, '3');
  const reordered = plan(
    [source('m1'), source('m2', analyzed, [other, cancelOfA])],
    {
      previous: two.snapshot,
    },
  );
  assert.equal(reordered.related.analysis_revision, '3');
  assert.deepEqual(reordered, two);
  // 版が進んだので、旧版を使った候補の最終ガードは失効する。
  const reader = {
    analyses: { current: () => cancelled.analysis },
    entities: {
      current: () => ({ record: entityRecord, request_revision: '1' }),
    },
  };
  const guard = finalGuard(baseGuard, reader.analyses, reader.entities);
  assert.equal(guard.ok, false);
  if (!guard.ok)
    assert.equal(guard.reasons.includes('analysis_revision_changed'), true);
});
