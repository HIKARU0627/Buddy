// B07 専用の装置。製品の src を直接 import せず、ビルド済みの試験用部品（予算の門・DB worker・模擬の有料 provider）を
// 再利用する。期待値は b07-expectations.json の手書きの値だけで、ここでは作らない（突き合わせの規則だけを持つ）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ManualTimers,
  MockPaidProvider,
  NOV_02,
  OCT_15,
  TOKYO_NOV_START,
  barrier,
  loadedConfig,
  syntheticConfig,
  textRequest,
  uuid,
  withBudgetStore,
} from '../../apps/core/dist/budget-test-support.js';
import {
  checkBudgetConfigText,
  loadBudgetConfig,
} from '../../apps/core/dist/budget-config.js';
import { createApiContract } from '../../apps/core/dist/api-contract.js';

export {
  ManualTimers,
  MockPaidProvider,
  NOV_02,
  OCT_15,
  TOKYO_NOV_START,
  barrier,
  checkBudgetConfigText,
  createApiContract,
  loadBudgetConfig,
  loadedConfig,
  syntheticConfig,
  textRequest,
  uuid,
  withBudgetStore,
};

export const specification = JSON.parse(
  readFileSync(new URL('./b07-expectations.json', import.meta.url), 'utf8'),
);

// 順序だけを固定する PRNG。受付の ID・鍵などの乱数は固定しない（ID は予約ごとの連番を使う）。
export function shuffled(values, seed) {
  let state = seed >>> 0;
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// 試験ごとに予約の ID を連番にする（記録を再現できるようにする。予約の ID は秘密ではない）。
export function counterIds(start = 5000) {
  let next = start;
  return () => uuid(next++);
}

// 要求の名前（ラベル）と UUID の対応。ラベルは試験の中の呼び名で、DB・provider は UUID だけを知っている。
export class Labels {
  #byLabel = new Map();
  #byId = new Map();
  #next = 1;
  id(label) {
    let id = this.#byLabel.get(label);
    if (id === undefined) {
      id = uuid(this.#next++);
      this.#byLabel.set(label, id);
      this.#byId.set(id, label);
    }
    return id;
  }
  label(id) {
    return this.#byId.get(id) ?? id;
  }
}

// 予約の行（SQL で直接読む。DB worker・domain を通さない）。金額は文字列にそろえる。
export function reservationRows(harness) {
  return harness
    .sql((db) =>
      db
        .prepare(
          `SELECT reservation_id, request_id, pool_id, requested_pool_id, origin, budget_month, price_version,
                  status, reserved_amount, max_liability, actual_gross, dispatch_intent_at, approval_id,
                  provider_reconciliation_id, settlement_kind, overrun_reviewed
             FROM budget_reservations ORDER BY rowid`,
        )
        .all(),
    )
    .map((row) => ({
      reservation_id: row.reservation_id,
      request_id: row.request_id,
      pool_id: row.pool_id,
      requested_pool_id: row.requested_pool_id,
      origin: row.origin,
      budget_month: row.budget_month,
      price_version: row.price_version,
      status: row.status,
      reserved: String(row.reserved_amount),
      max_liability: String(row.max_liability),
      actual_gross: row.actual_gross === null ? null : String(row.actual_gross),
      dispatched: row.dispatch_intent_at !== null,
      approval_id: row.approval_id,
      reconciliation_id: row.provider_reconciliation_id,
      settlement_kind: row.settlement_kind,
      overrun_reviewed: row.overrun_reviewed === 1,
    }));
}

export function approvalRows(harness) {
  return harness
    .sql((db) =>
      db
        .prepare(
          `SELECT approval_id, request_id, status, max_liability, consumed_reservation_id
             FROM budget_overage_approvals ORDER BY approval_id`,
        )
        .all(),
    )
    .map((row) => ({
      approval_id: row.approval_id,
      request_id: row.request_id,
      status: row.status,
      max_liability: String(row.max_liability),
      consumed_reservation_id: row.consumed_reservation_id,
    }));
}

// 利用状況（DB worker の summary）。枠・月ごとの表示用の値。
export async function usage(harness, month, poolId) {
  const summary = await harness.store.budget({
    kind: 'budget.summary',
    settings: loadedConfig().settings,
    config_valid: true,
    now: harness.clock.now(),
  });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  const pool = summary.value.months
    .find((item) => item.budget_month === month)
    ?.pools.find((item) => item.pool_id === poolId);
  assert(pool !== undefined, `${month} ${poolId}`);
  return {
    settled: pool.settled.amount,
    reserved: pool.unsettled_reserved.amount,
    max: pool.unsettled_max_liability.amount,
    unknown: pool.usage_unknown_count,
    holds: [...pool.hold_reasons],
  };
}

export async function currentMonth(harness) {
  const summary = await harness.store.budget({
    kind: 'budget.summary',
    settings: loadedConfig().settings,
    config_valid: true,
    now: harness.clock.now(),
  });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  return summary.value.current_month;
}

// 試験の中で使う要求の作り方（M は合成の単価 1 で、入力 + 出力の上限）。
export const owner = (id, overrides = {}) => textRequest(id, overrides);
export const sized = (id, input, output, overrides = {}) =>
  textRequest(id, {
    quantities: {
      input_tokens: String(input),
      output_tokens: String(output),
    },
    ...overrides,
  });
export const live = (id, seconds, overrides = {}) =>
  textRequest(id, {
    service: 'voice',
    price_key: 'synthetic.live',
    quantities: { live_seconds: String(seconds) },
    ...overrides,
  });

// 受け付けて送出意図を記録し、模擬の provider へ送る（run() を使わず、精算を呼び出し側で試すための手順）。
export async function admitAndSend(gate, provider, request) {
  const admitted = await gate.admit(request);
  assert(
    admitted.ok,
    `admit ${request.request_id}: ${JSON.stringify(admitted)}`,
  );
  const dispatched = await gate.dispatch(admitted.ticket);
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  const outcome = await provider.send({
    request_id: request.request_id,
    reservation_id: admitted.ticket.reservation_id,
    signal: new AbortController().signal,
  });
  return { ticket: admitted.ticket, outcome };
}

// 予約の行と provider の受信の記録・真の usage を突き合わせる。手書きの枠の表（pools: 上限と経路）だけを使い、
// domain の判定は使わない。戻り値の配列・件数がすべて空・0 でなければ不一致。
export function findings({ rows, receipts, truth, pools }) {
  const byRequest = new Map(rows.map((row) => [row.request_id, row]));
  const count = new Map();
  for (const receipt of receipts)
    count.set(receipt.request_id, (count.get(receipt.request_id) ?? 0) + 1);
  const duplicateReceipts = [...count]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
  const receiptWithoutDispatchedRow = receipts
    .filter((receipt) => byRequest.get(receipt.request_id)?.dispatched !== true)
    .map((receipt) => receipt.request_id);
  const receiptReservationMismatch = receipts
    .filter((receipt) => {
      const row = byRequest.get(receipt.request_id);
      return row !== undefined && row.reservation_id !== receipt.reservation_id;
    })
    .map((receipt) => receipt.request_id);
  // 送出意図があって受信のない予約は、送ったか分からない（usage 不明）のものだけ。
  const dispatchedWithoutReceiptNotUnknown = rows
    .filter(
      (row) =>
        row.dispatched &&
        !count.has(row.request_id) &&
        row.status !== 'usage_unknown',
    )
    .map((row) => row.request_id);
  // 送出意図または provider の受信がある予約を、解放（released）にしてはいけない（送った可能性のある費用を落とす）。
  const releasedAfterSend = rows
    .filter(
      (row) =>
        row.status === 'released' &&
        (row.dispatched || count.has(row.request_id)),
    )
    .map((row) => row.request_id);
  // provider の usage で精算した予約は、実費が provider 側の真の usage と同じ（二重に数えない・取り違えない）。
  const settledNotMatchingTruth = rows
    .filter(
      (row) => row.status === 'settled' && row.settlement_kind === 'provider',
    )
    .filter((row) => truth.get(row.request_id) !== row.actual_gross)
    .map((row) => row.request_id);
  // 精算した予約の照合 ID は予約ごとに違う。
  const reconciliation = new Map();
  for (const row of rows)
    if (row.reconciliation_id !== null)
      reconciliation.set(
        row.reconciliation_id,
        (reconciliation.get(row.reconciliation_id) ?? 0) + 1,
      );
  const reusedReconciliation = [...reconciliation]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
  // 枠ごと・予算月ごとの使用量（解放しない予約。精算済みは実費、それ以外は M）が上限以内。
  const used = new Map();
  for (const row of rows) {
    if (row.status === 'released') continue;
    const amount = BigInt(
      row.status === 'settled' ? row.actual_gross : row.max_liability,
    );
    const path = pools[row.pool_id]?.path;
    assert(
      path !== undefined,
      `枠の経路が手書きの表にありません: ${row.pool_id}`,
    );
    for (const poolId of path) {
      const key = `${row.budget_month} ${poolId}`;
      used.set(key, (used.get(key) ?? 0n) + amount);
    }
  }
  const overLimit = [...used]
    .filter(([key, amount]) => amount > BigInt(pools[key.split(' ')[1]].limit))
    .map(([key]) => key)
    .sort();
  return {
    duplicate_receipts: duplicateReceipts,
    receipt_without_dispatched_row: receiptWithoutDispatchedRow,
    receipt_reservation_mismatch: receiptReservationMismatch,
    dispatched_without_receipt_not_unknown: dispatchedWithoutReceiptNotUnknown,
    released_after_send: releasedAfterSend,
    settled_not_matching_truth: settledNotMatchingTruth,
    reused_reconciliation_ids: reusedReconciliation,
    over_limit_pools: overLimit,
  };
}

export const CLEAN = {
  duplicate_receipts: [],
  receipt_without_dispatched_row: [],
  receipt_reservation_mismatch: [],
  dispatched_without_receipt_not_unknown: [],
  released_after_send: [],
  settled_not_matching_truth: [],
  reused_reconciliation_ids: [],
  over_limit_pools: [],
};

// 同時の予約では、受付の命令がすべて精算の前に並ぶ（関門）ので、M の合計も上限以内でなければならない。
export function waveMaxOverLimit({ rows, pools }) {
  const sums = new Map();
  for (const row of rows) {
    if (row.status === 'released') continue;
    for (const poolId of pools[row.pool_id].path) {
      const key = `${row.budget_month} ${poolId}`;
      sums.set(key, (sums.get(key) ?? 0n) + BigInt(row.max_liability));
    }
  }
  return [...sums]
    .filter(([key, amount]) => amount > BigInt(pools[key.split(' ')[1]].limit))
    .map(([key]) => key)
    .sort();
}

// provider の真の usage（request_id → 実費の文字列または null）。受信の記録ではなく provider 自身の記録。
export async function providerTruth(provider, rows) {
  const truth = new Map();
  for (const row of rows) {
    const found = await provider.reconciler.lookup({
      request_id: row.request_id,
      reservation_id: row.reservation_id,
    });
    truth.set(row.request_id, found === null ? null : found.actual_gross);
  }
  return truth;
}

export const statusSummary = (rows) => {
  const counts = { settled: 0, usage_unknown: 0, released: 0, reserved: 0 };
  for (const row of rows) counts[row.status] += 1;
  return `settled:${counts.settled},usage_unknown:${counts.usage_unknown},released:${counts.released},reserved:${counts.reserved}`;
};

// 手書きの枠の表が、試験の合成の設定と一致することを確かめる（表を設定から作らない）。
export function assertPoolTable(pools) {
  const config = loadedConfig().config.budget;
  assert.deepEqual(
    Object.keys(pools).sort(),
    config.pools.map((pool) => pool.pool_id).sort(),
  );
  for (const pool of config.pools) {
    assert.equal(pools[pool.pool_id].limit, pool.limit.amount, pool.pool_id);
    const path = [];
    for (
      let current = pool;
      current !== undefined;
      current = config.pools.find(
        (item) => item.pool_id === current.parent_pool_id,
      )
    )
      path.push(current.pool_id);
    assert.deepEqual(pools[pool.pool_id].path, path, pool.pool_id);
  }
}
