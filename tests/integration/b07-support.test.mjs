// B07 の突き合わせの規則（findings・waveMaxOverLimit）自体の試験。合成の予約の行と受信の記録を手で作り、
// 正しい記録は通し、上限の超過・二重の受信・取り違え・実費の食い違いは検出できることを確かめる。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLEAN,
  Labels,
  findings,
  shuffled,
  specification,
  statusSummary,
  waveMaxOverLimit,
} from './b07-support.mjs';

const pools = specification.pools;
const row = (id, overrides = {}) => ({
  reservation_id: `res-${id}`,
  request_id: id,
  pool_id: 'llm',
  budget_month: '2030-10',
  status: 'settled',
  max_liability: '40',
  actual_gross: '30',
  dispatched: true,
  reconciliation_id: `mockpaid:rcpt-${id}`,
  settlement_kind: 'provider',
  ...overrides,
});
const receipt = (id) => ({ request_id: id, reservation_id: `res-${id}` });

test('B07 の突き合わせ: 一致した記録は指摘なし', () => {
  assert.deepEqual(
    findings({
      rows: [row('a'), row('b')],
      receipts: [receipt('a'), receipt('b')],
      truth: new Map([
        ['a', '30'],
        ['b', '30'],
      ]),
      pools,
    }),
    CLEAN,
  );
});

test('B07 の突き合わせ: 二重の受信・送出意図のない受信・予約の取り違えを検出する', () => {
  const duplicate = findings({
    rows: [row('a')],
    receipts: [receipt('a'), receipt('a')],
    truth: new Map([['a', '30']]),
    pools,
  });
  assert.deepEqual(duplicate.duplicate_receipts, ['a']);
  const undispatched = findings({
    rows: [
      row('a', {
        dispatched: false,
        status: 'reserved',
        actual_gross: null,
        reconciliation_id: null,
        settlement_kind: null,
      }),
    ],
    receipts: [receipt('a')],
    truth: new Map([['a', null]]),
    pools,
  });
  assert.deepEqual(undispatched.receipt_without_dispatched_row, ['a']);
  const mismatch = findings({
    rows: [row('a')],
    receipts: [{ request_id: 'a', reservation_id: 'res-other' }],
    truth: new Map([['a', '30']]),
    pools,
  });
  assert.deepEqual(mismatch.receipt_reservation_mismatch, ['a']);
});

test('B07 の突き合わせ: 送出意図があって受信のない予約は usage 不明だけ許す', () => {
  const unknown = findings({
    rows: [
      row('a', {
        status: 'usage_unknown',
        actual_gross: null,
        reconciliation_id: null,
        settlement_kind: null,
      }),
    ],
    receipts: [],
    truth: new Map([['a', null]]),
    pools,
  });
  assert.deepEqual(unknown, CLEAN);
  for (const status of ['settled', 'reserved']) {
    const found = findings({
      rows: [
        row('a', {
          status,
          ...(status === 'reserved'
            ? {
                actual_gross: null,
                reconciliation_id: null,
                settlement_kind: null,
              }
            : {}),
        }),
      ],
      receipts: [],
      truth: new Map([['a', '30']]),
      pools,
    });
    assert.deepEqual(
      found.dispatched_without_receipt_not_unknown,
      ['a'],
      status,
    );
  }
});

test('B07 の突き合わせ: provider の真の usage と違う精算・照合 ID の使い回しを検出する', () => {
  const wrong = findings({
    rows: [row('a')],
    receipts: [receipt('a')],
    truth: new Map([['a', '29']]),
    pools,
  });
  assert.deepEqual(wrong.settled_not_matching_truth, ['a']);
  // 手での精算は provider の真の usage と比べない。
  const manual = findings({
    rows: [
      row('a', { settlement_kind: 'manual', reconciliation_id: 'manual:inv' }),
    ],
    receipts: [receipt('a')],
    truth: new Map([['a', '29']]),
    pools,
  });
  assert.deepEqual(manual, CLEAN);
  const reused = findings({
    rows: [row('a'), row('b', { reconciliation_id: 'mockpaid:rcpt-a' })],
    receipts: [receipt('a'), receipt('b')],
    truth: new Map([
      ['a', '30'],
      ['b', '30'],
    ]),
    pools,
  });
  assert.deepEqual(reused.reused_reconciliation_ids, ['mockpaid:rcpt-a']);
});

test('B07 の突き合わせ: 枠・予算月ごとの使用量が上限を超えたら検出し、解放した予約と別の月は数えない', () => {
  // llm（100）: 精算 30 + usage 不明の M 40 + 受付中の M 40 = 110。
  const over = findings({
    rows: [
      row('a'),
      row('b', {
        status: 'usage_unknown',
        actual_gross: null,
        reconciliation_id: null,
        settlement_kind: null,
      }),
      row('c', {
        status: 'reserved',
        dispatched: false,
        actual_gross: null,
        reconciliation_id: null,
        settlement_kind: null,
      }),
    ],
    receipts: [receipt('a')],
    truth: new Map([['a', '30']]),
    pools,
  });
  assert.deepEqual(over.over_limit_pools, ['2030-10 llm']);
  // 子の枠（llm.background、上限 50）の使用は親の llm にも数える。
  const child = findings({
    rows: [
      row('a', {
        pool_id: 'llm.background',
        max_liability: '40',
        actual_gross: '40',
      }),
      row('b', {
        pool_id: 'llm.background',
        max_liability: '40',
        actual_gross: '40',
      }),
    ],
    receipts: [receipt('a'), receipt('b')],
    truth: new Map([
      ['a', '40'],
      ['b', '40'],
    ]),
    pools,
  });
  assert.deepEqual(child.over_limit_pools, ['2030-10 llm.background']);
  // 解放した予約と、別の月の使用は数えない。
  const fine = findings({
    rows: [
      row('a'),
      row('b', {
        status: 'released',
        dispatched: false,
        actual_gross: null,
        reconciliation_id: null,
        settlement_kind: null,
      }),
      row('c', {
        budget_month: '2030-11',
        max_liability: '100',
        actual_gross: '100',
      }),
    ],
    receipts: [receipt('a'), receipt('c')],
    truth: new Map([
      ['a', '30'],
      ['c', '100'],
    ]),
    pools,
  });
  assert.deepEqual(fine.over_limit_pools, []);
  assert.throws(
    () =>
      findings({
        rows: [row('a', { pool_id: 'unknown-pool' })],
        receipts: [],
        truth: new Map(),
        pools,
      }),
    /枠の経路が手書きの表にありません/u,
  );
});

test('B07 の同時の受付: M の合計が上限を超えたら検出する（精算の前に受付がそろう場合）', () => {
  const reserved = (id) =>
    row(id, {
      status: 'reserved',
      actual_gross: null,
      reconciliation_id: null,
      settlement_kind: null,
    });
  assert.deepEqual(
    waveMaxOverLimit({ rows: [reserved('a'), reserved('b')], pools }),
    [],
  );
  assert.deepEqual(
    waveMaxOverLimit({
      rows: [reserved('a'), reserved('b'), reserved('c')],
      pools,
    }),
    ['2030-10 llm'],
  );
  // 精算済みでも、同時の受付では M で数える（受付の命令は精算の前に並ぶ）。
  assert.deepEqual(
    waveMaxOverLimit({ rows: [row('a'), row('b'), row('c')], pools }),
    ['2030-10 llm'],
  );
});

test('B07 の補助: seed が同じなら並べ替えも同じで、seed が違えば並びが変わり、要素は変わらない', () => {
  const values = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.deepEqual(shuffled(values, 7), shuffled(values, 7));
  assert.notDeepEqual(shuffled(values, 7), shuffled(values, 1007));
  for (const seed of specification.seeds)
    assert.deepEqual([...shuffled(values, seed)].sort(), values);
  assert.notDeepEqual(shuffled(values, specification.seeds[0]), values);
  const labels = new Labels();
  const id = labels.id('a');
  assert.equal(labels.id('a'), id);
  assert.notEqual(labels.id('b'), id);
  assert.equal(labels.label(id), 'a');
  assert.equal(
    statusSummary([
      { status: 'settled' },
      { status: 'released' },
      { status: 'settled' },
    ]),
    'settled:2,usage_unknown:0,released:1,reserved:0',
  );
});

test('B07 の期待値は手書きの枠の表と全ケースの形がそろい、ID が重複しない', () => {
  const ids = specification.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const spec of specification.cases) {
    assert.match(spec.id, /^(X18|X53|QA20|QA42|B07)-[a-z0-9-]+$/u);
    assert(spec.title.length > 0, spec.id);
    assert(Array.isArray(spec.faults), spec.id);
    assert.equal(typeof spec.expected, 'object', spec.id);
  }
  assert.deepEqual(specification.seeds.length, 3);
  assert.equal(new Set(specification.seeds).size, 3);
});
