import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GRAPH_ACCOUNT_KINDS as CONNECTOR_ACCOUNT_KINDS,
  GRAPH_CONNECTOR_CAPABILITY,
  GRAPH_REJECTION_REASONS as CONNECTOR_REJECTION_REASONS,
} from '../packages/connectors/dist/index.js';
import {
  CONNECTOR_READ_KINDS,
  GRAPH_ACCOUNT_KINDS,
  GRAPH_REJECTION_REASONS,
  checkConnectorCapability,
} from '../packages/domain/dist/index.js';

// B09-02 の Graph の読み取り connector（ADR 0134）。connectors は domain を import しないので、
// 語彙の値が domain と同じであること、能力の宣言が domain の規則を通ること、書込みが無いことをここで照合する。
// 期待値は手書き。

test('connector の語彙が domain の Graph の語彙と同じ', () => {
  assert.deepEqual(
    [...CONNECTOR_REJECTION_REASONS],
    [...GRAPH_REJECTION_REASONS],
  );
  assert.deepEqual([...CONNECTOR_ACCOUNT_KINDS], [...GRAPH_ACCOUNT_KINDS]);
  assert.deepEqual(
    [...CONNECTOR_REJECTION_REASONS],
    [
      'insufficient_permission',
      'organization_policy',
      'admin_consent_required',
      'tenant_restriction',
      'unknown',
    ],
  );
  assert.deepEqual(
    [...CONNECTOR_ACCOUNT_KINDS],
    ['personal', 'work_or_school'],
  );
});

test('Graph の能力は読み取りだけの宣言として domain の規則を通る', () => {
  // MinimalConnectorCapability と domain の ConnectorCapability は別の型。読み取りだけの宣言として渡す。
  const declared = {
    provider: GRAPH_CONNECTOR_CAPABILITY.provider,
    reads: GRAPH_CONNECTOR_CAPABILITY.reads.map((read) => ({ ...read })),
    writes: [],
  };
  assert.deepEqual(checkConnectorCapability(declared), []);
  assert.equal(GRAPH_CONNECTOR_CAPABILITY.provider, 'microsoft');
  for (const read of GRAPH_CONNECTOR_CAPABILITY.reads)
    assert(CONNECTOR_READ_KINDS.includes(read.kind), read.kind);
  assert.deepEqual(GRAPH_CONNECTOR_CAPABILITY.reads, [
    { kind: 'permission', effect_kind: 'Read' },
    { kind: 'mail.message', effect_kind: 'Read' },
  ]);
});

test('Graph の能力に書込みが無い（カテゴリの付与・移動・送信を作らない）', () => {
  assert.deepEqual(GRAPH_CONNECTOR_CAPABILITY.writes, []);
});
