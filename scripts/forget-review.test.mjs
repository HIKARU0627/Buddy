import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORGET_LEDGER_DELTA_LIMIT,
  FORGET_VIEW_ID_LIMIT,
  forgetLedgerDelta,
  forgetPlanView,
} from '../packages/domain/dist/index.js';

// ビルド後の domain の忘却の計画の見せ方と台帳の配信の判定（B06-07b-2、ADR 0180）を、手書きの期待値で検査する。
// 計画と台帳は手で組んだ合成の値で、planForget・DB の書き出しから作らない。hash は判定に使う文字列で、計算はしない。

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (c) => c.repeat(64);
const ZERO = hash('0');

// 計画の形だけを持つ合成の計画（planForget の結果の形）。
function plan(overrides = {}) {
  return {
    targets: [{ kind: 'memory', id: id(1) }],
    deletions: [
      { kind: 'intent_shadow', id: id(30) },
      { kind: 'session_summary', id: id(40) },
      { kind: 'memory', id: id(2) },
      { kind: 'memory', id: id(1) },
      { kind: 'user_directive', id: id(50) },
      { kind: 'turn', id: id(60) },
    ],
    user_directives: [id(50)],
    operation_contents: {
      purge: [id(70)],
      retained: [
        {
          operation_id: id(81),
          state: 'dispatching',
          reason: 'in_flight',
          send_blocked: true,
          provenance: [],
          provenance_complete: false,
        },
        {
          operation_id: id(82),
          state: 'unknown',
          reason: 'state_unknown',
          send_blocked: true,
          provenance: [],
          provenance_complete: false,
        },
        {
          operation_id: id(83),
          state: 'awaiting_approval',
          reason: 'in_flight',
          send_blocked: true,
          provenance: [],
          provenance_complete: false,
        },
      ],
    },
    ledger: {
      forgotten: [],
      blocked_source_hmacs: [hash('b'), hash('c')],
      blocked_content_keys: [hash('d')],
    },
    notice: { forgotten: [], derived_from_forgotten: [] },
    ...overrides,
  };
}

test('the plan view counts what is removed and separates kept operations from lineage-only nodes', () => {
  // 操作 81・83 は行がある。82 は 90 日の削除で行がなく、系譜だけに残る（ADR 0054 の引き継ぎ）。
  const result = forgetPlanView(plan(), new Set([id(81), id(83), id(70)]));
  assert.deepEqual(result, {
    ok: true,
    view: {
      removed_counts: [
        { kind: 'intent_shadow', count: 1 },
        { kind: 'session_summary', count: 1 },
        { kind: 'memory', count: 2 },
        { kind: 'user_directive', count: 1 },
        { kind: 'turn', count: 1 },
        { kind: 'operation_content', count: 1 },
      ],
      removed_memory_ids: [id(1), id(2)],
      removed_directive_ids: [id(50)],
      kept_operations: [
        { operation_id: id(81), state: 'dispatching' },
        { operation_id: id(83), state: 'awaiting_approval' },
      ],
      kept_lineage_only: 1,
      blocked_source_count: 2,
    },
  });
});

test('an existing operation with an unreadable state is shown as unknown, not as a finished one', () => {
  const result = forgetPlanView(
    plan({
      operation_contents: {
        purge: [],
        retained: [
          {
            operation_id: id(82),
            state: 'unknown',
            reason: 'state_unknown',
            send_blocked: true,
            provenance: [],
            provenance_complete: false,
          },
        ],
      },
    }),
    new Set([id(82)]),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.view.kept_operations, [
    { operation_id: id(82), state: 'unknown' },
  ]);
  assert.equal(result.view.kept_lineage_only, 0);
  assert.equal(
    result.view.removed_counts.some(
      (item) => item.kind === 'operation_content',
    ),
    false,
  );
});

test('a plan larger than the view limit is refused instead of being cut short', () => {
  assert.equal(FORGET_VIEW_ID_LIMIT, 1000);
  const memories = (n) =>
    Array.from({ length: n }, (_, i) => ({ kind: 'memory', id: id(1000 + i) }));
  const atLimit = forgetPlanView(
    plan({ deletions: memories(1000), user_directives: [] }),
    new Set(),
  );
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.view.removed_memory_ids.length, 1000);
  assert.deepEqual(
    forgetPlanView(
      plan({ deletions: memories(1001), user_directives: [] }),
      new Set(),
    ),
    { ok: false, reasons: ['plan_too_large'] },
  );
  const directives = Array.from({ length: 1001 }, (_, i) => id(5000 + i));
  assert.deepEqual(
    forgetPlanView(plan({ user_directives: directives }), new Set()),
    { ok: false, reasons: ['plan_too_large'] },
  );
});

// 中枢の台帳: 世代 1〜3（系譜 L）。
const LEDGER = id(900);
const chain = (n) =>
  Array.from({ length: n }, (_, i) => ({
    entry: { forgetting_generation: String(i + 1) },
    entry_hash: hash('abcdef'[i % 6]),
  }));
const three = { ledger_id: LEDGER, entries: chain(3) };
const gens = (decision) =>
  decision.entries.map((link) => link.entry.forgetting_generation);

test('a replica with nothing receives the whole ledger from generation 1', () => {
  const decision = forgetLedgerDelta(three, {
    ledger_id: null,
    forgetting_generation: '0',
    entry_hash: ZERO,
  });
  assert.equal(decision.outcome, 'entries');
  assert.deepEqual(gens(decision), ['1', '2', '3']);
  assert.equal(decision.has_more, false);
});

test('a replica receives only the generations after its head, and nothing once caught up', () => {
  const after1 = forgetLedgerDelta(three, {
    ledger_id: LEDGER,
    forgetting_generation: '1',
    entry_hash: hash('a'),
  });
  assert.deepEqual(gens(after1), ['2', '3']);
  const caughtUp = forgetLedgerDelta(three, {
    ledger_id: LEDGER,
    forgetting_generation: '3',
    entry_hash: hash('c'),
  });
  assert.deepEqual(caughtUp, {
    outcome: 'entries',
    entries: [],
    has_more: false,
  });
});

test('long ledgers are returned in pages of 256 and the next page starts after the last one', () => {
  assert.equal(FORGET_LEDGER_DELTA_LIMIT, 256);
  const long = { ledger_id: LEDGER, entries: chain(600) };
  const first = forgetLedgerDelta(long, {
    ledger_id: null,
    forgetting_generation: '0',
    entry_hash: ZERO,
  });
  assert.equal(first.entries.length, 256);
  assert.equal(first.entries[0].entry.forgetting_generation, '1');
  assert.equal(first.entries[255].entry.forgetting_generation, '256');
  assert.equal(first.has_more, true);
  const second = forgetLedgerDelta(long, {
    ledger_id: LEDGER,
    forgetting_generation: '512',
    entry_hash: long.entries[511].entry_hash,
  });
  assert.equal(second.entries.length, 88);
  assert.equal(second.entries[0].entry.forgetting_generation, '513');
  assert.equal(second.has_more, false);
});

test('a replica that is not a prefix of the ledger is told to start again, and receives nothing', () => {
  // 同じ世代の hash が違う（書き換え・別の連鎖）。
  assert.deepEqual(
    forgetLedgerDelta(three, {
      ledger_id: LEDGER,
      forgetting_generation: '2',
      entry_hash: hash('9'),
    }),
    { outcome: 'diverged', reason: 'hash_mismatch' },
  );
  // 系譜が違う（別の中枢の台帳）。
  assert.deepEqual(
    forgetLedgerDelta(three, {
      ledger_id: id(901),
      forgetting_generation: '1',
      entry_hash: hash('a'),
    }),
    { outcome: 'diverged', reason: 'lineage_mismatch' },
  );
  // 世代 1 以上を持つのに系譜を持たない（部分の複製）。
  assert.deepEqual(
    forgetLedgerDelta(three, {
      ledger_id: null,
      forgetting_generation: '1',
      entry_hash: hash('a'),
    }),
    { outcome: 'diverged', reason: 'lineage_mismatch' },
  );
  // 何も持たないのに 0 でない hash。
  assert.deepEqual(
    forgetLedgerDelta(three, {
      ledger_id: null,
      forgetting_generation: '0',
      entry_hash: hash('a'),
    }),
    { outcome: 'diverged', reason: 'hash_mismatch' },
  );
});

test('a replica ahead of the hub is never rewound (the hub ledger may have been rolled back)', () => {
  assert.deepEqual(
    forgetLedgerDelta(three, {
      ledger_id: LEDGER,
      forgetting_generation: '4',
      entry_hash: hash('d'),
    }),
    { outcome: 'replica_ahead' },
  );
  // 中枢の台帳が空（系譜もない）で、端末が系譜と世代を持つ。
  assert.deepEqual(
    forgetLedgerDelta(
      { ledger_id: null, entries: [] },
      { ledger_id: LEDGER, forgetting_generation: '2', entry_hash: hash('b') },
    ),
    { outcome: 'replica_ahead' },
  );
});

test('a hub ledger with a missing generation is not served', () => {
  const gap = {
    ledger_id: LEDGER,
    entries: [chain(3)[0], chain(3)[2]],
  };
  assert.deepEqual(
    forgetLedgerDelta(gap, {
      ledger_id: null,
      forgetting_generation: '0',
      entry_hash: ZERO,
    }),
    { outcome: 'ledger_invalid' },
  );
  assert.deepEqual(
    forgetLedgerDelta(
      { ledger_id: null, entries: chain(1) },
      { ledger_id: null, forgetting_generation: '0', entry_hash: ZERO },
    ),
    { outcome: 'ledger_invalid' },
  );
});

test('an empty hub ledger returns nothing to an empty replica', () => {
  assert.deepEqual(
    forgetLedgerDelta(
      { ledger_id: null, entries: [] },
      { ledger_id: null, forgetting_generation: '0', entry_hash: ZERO },
    ),
    { outcome: 'entries', entries: [], has_more: false },
  );
});
