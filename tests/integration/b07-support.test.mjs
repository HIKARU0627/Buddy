// B07 の突き合わせの規則（findings・waveMaxOverLimit）自体の試験。合成の予約の行と受信の記録を手で作り、
// 正しい記録は通し、上限の超過・二重の受信・取り違え・実費の食い違いは検出できることを確かめる。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLEAN,
  CLEAN_CREDIT,
  CREDIT_PROFILE,
  Labels,
  creditFindings,
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

test('B07 の突き合わせ: 送出意図または受信のある予約の解放を検出し、送っていない予約の解放は許す', () => {
  const released = {
    status: 'released',
    actual_gross: null,
    reconciliation_id: null,
    settlement_kind: null,
  };
  // 受信があり、送出意図もあり、provider に真の usage がある予約が released（費用を落としている）。
  const received = findings({
    rows: [row('a', released)],
    receipts: [receipt('a')],
    truth: new Map([['a', '30']]),
    pools,
  });
  assert.deepEqual(received.released_after_send, ['a']);
  // 受信の記録だけがあり送出意図の記録がない場合も、送出意図のない受信として別に検出する。
  const receivedOnly = findings({
    rows: [row('a', { ...released, dispatched: false })],
    receipts: [receipt('a')],
    truth: new Map([['a', '30']]),
    pools,
  });
  assert.deepEqual(receivedOnly.released_after_send, ['a']);
  assert.deepEqual(receivedOnly.receipt_without_dispatched_row, ['a']);
  // 送出意図だけがあり受信のない予約が released でも拒否する（送った可能性は消えない）。
  const intentOnly = findings({
    rows: [row('a', released)],
    receipts: [],
    truth: new Map([['a', null]]),
    pools,
  });
  assert.deepEqual(intentOnly.released_after_send, ['a']);
  // 送出意図も受信もない予約の解放は正しい。
  assert.deepEqual(
    findings({
      rows: [row('a', { ...released, dispatched: false })],
      receipts: [],
      truth: new Map([['a', null]]),
      pools,
    }),
    CLEAN,
  );
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
    assert.match(spec.id, /^(X18|X53|QA20|QA42|B07|MA0[3-6])-[a-z0-9-]+$/u);
    assert(spec.title.length > 0, spec.id);
    assert(Array.isArray(spec.faults), spec.id);
    assert.equal(typeof spec.expected, 'object', spec.id);
  }
  assert.deepEqual(specification.seeds.length, 3);
  assert.equal(new Set(specification.seeds).size, 3);
});

// クレジットの区分の突き合わせ（B07-07）自体の試験。正しい行は通し、周期のない行のクレジット・実費と合わない区分・
// M を超えるクレジット・音声や検索や指定のない profile の周期・未精算の行の区分・観測した残高を超えるクレジットを検出する。
const credited = (id, overrides = {}) => ({
  request_id: id,
  profile_id: CREDIT_PROFILE,
  pool_id: 'llm',
  status: 'settled',
  max_liability: '40',
  actual_gross: '30',
  credit_applied: '30',
  additional_spend: '0',
  credit_cycle_id: 'anthropic:2030-10-01',
  credit_estimate: '30',
  credit_expires_at: 1919000000000,
  credit_observation_seq: 1,
  ...overrides,
});

test('B07 のクレジットの突き合わせ: 正しい行は指摘なし、未精算の行・周期のない行は区分を持たない', () => {
  assert.deepEqual(
    creditFindings({
      rows: [
        credited('a'),
        credited('b', {
          status: 'usage_unknown',
          actual_gross: null,
          credit_applied: null,
          additional_spend: null,
          credit_estimate: '0',
        }),
        credited('c', {
          profile_id: 'intent.synthetic.v1',
          credit_applied: '0',
          additional_spend: '30',
          credit_cycle_id: null,
          credit_estimate: '0',
          credit_expires_at: null,
          credit_observation_seq: null,
        }),
      ],
      cap: { 'anthropic:2030-10-01': '100' },
    }),
    CLEAN_CREDIT,
  );
});

test('B07 のクレジットの突き合わせ: 区分の誤りを検出する', () => {
  const found = (overrides, cap) =>
    creditFindings({ rows: [credited('a', overrides)], cap });
  assert.deepEqual(found({ credit_cycle_id: null }).credit_without_cycle, [
    'a',
  ]);
  assert.deepEqual(found({ additional_spend: '1' }).split_not_adding_up, ['a']);
  assert.deepEqual(found({ max_liability: '29' }).credit_above_m, ['a']);
  assert.deepEqual(found({ pool_id: 'voice' }).cycle_on_uncredited_row, ['a']);
  assert.deepEqual(found({ pool_id: 'search' }).cycle_on_uncredited_row, ['a']);
  assert.deepEqual(
    found({ profile_id: 'intent.synthetic.v1' }).cycle_on_uncredited_row,
    ['a'],
  );
  assert.deepEqual(found({ status: 'usage_unknown' }).split_on_unsettled_row, [
    'a',
  ]);
  // 周期に結び付く行は有効期限と観測の番号を持つ。持たない行は周期もない。
  assert.deepEqual(found({ credit_expires_at: null }).cycle_without_binding, [
    'a',
  ]);
  assert.deepEqual(
    found({ credit_observation_seq: null }).cycle_without_binding,
    ['a'],
  );
  assert.deepEqual(
    found({
      credit_cycle_id: null,
      credit_applied: '0',
      additional_spend: '30',
      credit_estimate: '0',
    }).cycle_without_binding,
    ['a'],
  );
  // 見積もりは、精算した行ではクレジット以上、精算していない行・周期のない行では 0。
  assert.deepEqual(
    found({ credit_estimate: '29' }).estimate_below_credit_or_misplaced,
    ['a'],
  );
  assert.deepEqual(
    found({
      status: 'usage_unknown',
      actual_gross: null,
      credit_applied: null,
      additional_spend: null,
    }).estimate_below_credit_or_misplaced,
    ['a'],
  );
  assert.deepEqual(
    found({ credit_estimate: '31' }).estimate_below_credit_or_misplaced,
    [],
  );
  // 観測した最も大きい残高（予算の通貨）を超えるクレジット。
  assert.deepEqual(
    found({}, { 'anthropic:2030-10-01': '29' }).credit_over_observed_balance,
    ['anthropic:2030-10-01'],
  );
  assert.deepEqual(
    found({}, { 'anthropic:2030-10-01': '30' }).credit_over_observed_balance,
    [],
  );
});
