import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  RETENTION_FAILURE_CLASSES,
  classifyRetentionFailure,
  isRowUsable,
  startupGate,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// 消せなかった理由の分け方（ADR 0058 の U137）。期待値は tests/fixtures/retention-failure-cases.json に手で書いたもので、
// domain の出力から作らない。表に理由を足す・分類を変えるときは、この fixture も一緒に直す。
const cases = parseStrictJson(
  await readFile(
    new URL('tests/fixtures/retention-failure-cases.json', root),
    'utf8',
  ),
);

test('the failure class table is exactly the hand-written table (adding or moving a cause needs a decision)', () => {
  const actual = { expected_hold: [], transient: [], permanent: [] };
  for (const [reason, kind] of Object.entries(RETENTION_FAILURE_CLASSES))
    actual[kind].push(reason);
  for (const list of Object.values(actual)) list.sort();
  assert.deepEqual(actual, cases.table);
});

test('hand-written classification cases', () => {
  const seen = new Set();
  for (const entry of cases.classify_cases) {
    assert(!seen.has(entry.id), `duplicate ${entry.id}`);
    seen.add(entry.id);
    assert.equal(
      classifyRetentionFailure(entry.outcome, entry.reasons),
      entry.expected,
      entry.id,
    );
  }
});

test('hand-written gate cases: the clock state file and undeletable rows', () => {
  const seen = new Set();
  for (const entry of cases.gate_cases) {
    assert(!seen.has(entry.id), `duplicate ${entry.id}`);
    seen.add(entry.id);
    const decision = startupGate({
      epoch: 'e1',
      now: entry.now,
      last_checked_at: entry.last_checked_at,
      sweep: entry.sweep,
      ...(entry.clock_state === undefined
        ? {}
        : { clock_state: entry.clock_state }),
    });
    assert.deepEqual(decision.reasons, entry.expected_reasons, entry.id);
    assert.equal(decision.search, entry.expected_reasons.length === 0);
    assert.equal(decision.cloud_send, entry.expected_reasons.length === 0);
    assert.equal(decision.auto_use, entry.expected_reasons.length === 0);
    for (const row of entry.usable ?? [])
      assert.equal(
        isRowUsable(decision, row.family, row.id),
        row.usable,
        `${entry.id}: ${row.family}/${row.id}`,
      );
  }
});
