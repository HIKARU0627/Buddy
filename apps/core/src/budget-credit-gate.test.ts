// 付帯クレジットの区分と保留（B07-07、ADR 0042、09 MA03〜MA06）を、予算の門・DB worker（一時ディレクトリの DB）・
// 模擬の有料 provider・メモリの観測で確かめる。
// 期待値（受付の可否・理由・クレジット・追加の支出・残り）は合成の設定（予算の通貨 XTS、残高の通貨 XXX を 1 単位あたり 2、
// 縮めた上限、M = 入力 10 + 出力の上限 30 = 40）から手で書いた値で、実装の処理から作っていない。待ち合わせは関門・手で
// 進める時計で行い、固定の sleep を使わない。模擬の試験だけで、実 API・実請求・Console の実残高との照合は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqliteDatabase } from '@buddy/storage';
import type { PaidUsage } from './budget-gate.js';
import {
  CREDIT_PROFILE,
  MemoryCreditSource,
  MockPaidProvider,
  OCT_15,
  TOKYO_NOV_START,
  barrier,
  claudeRequest,
  creditConfig,
  creditObservation,
  loadedConfig,
  syntheticConfig,
  textRequest,
  uuid,
  withBudgetStore,
} from './budget-test-support.js';
import type { BudgetHarness } from './budget-test-support.js';

const TIMEOUT = { timeout: 60_000 };
const CYCLE_OCT = 'anthropic:2030-10-01';
const CYCLE_NOV = 'anthropic:2030-11-01';
const EXPIRY = Date.parse('2030-11-01T00:00:00.000Z');

interface Row {
  request_id: string;
  status: string;
  max_liability: number;
  actual_gross: number | null;
  credit_applied: number | null;
  additional_spend: number | null;
  credit_cycle_id: string | null;
  settlement_kind: string | null;
}

const rows = (harness: BudgetHarness): Row[] =>
  harness.sql(
    (db: SqliteDatabase) =>
      db
        .prepare(
          'SELECT request_id, status, max_liability, actual_gross, credit_applied, additional_spend, credit_cycle_id, settlement_kind FROM budget_reservations ORDER BY created_at, request_id',
        )
        .all() as Row[],
  );

// 予約の行を、要求の ID から [状態, 実費, クレジット, 追加の支出, 周期] の形にする。
function view(
  harness: BudgetHarness,
  requestId: string,
): readonly [
  string,
  number | null,
  number | null,
  number | null,
  string | null,
] {
  const row = rows(harness).find((item) => item.request_id === requestId);
  assert(row !== undefined, requestId);
  return [
    row.status,
    row.actual_gross,
    row.credit_applied,
    row.additional_spend,
    row.credit_cycle_id,
  ];
}

async function llmUsage(
  harness: BudgetHarness,
  month: string,
): Promise<Record<string, unknown>> {
  const summary = await harness.store.budget({
    kind: 'budget.summary',
    settings: loadedConfig().settings,
    config_valid: true,
    now: harness.clock.now(),
  });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  if (!summary.ok) return {};
  const pool = summary.value.months
    .find((item) => item.budget_month === month)
    ?.pools.find((item) => item.pool_id === 'llm');
  assert(pool !== undefined, month);
  return {
    settled: pool.settled.amount,
    max: pool.unsettled_max_liability.amount,
    unknown: pool.usage_unknown_count,
    holds: pool.hold_reasons,
  };
}

const usageOf = (
  provider: MockPaidProvider,
  requestId: string,
  actual: string,
): PaidUsage => ({
  kind: 'usage',
  provider: 'mockpaid',
  reconciliation_id: `rcpt-${requestId}`,
  actual_gross: actual,
});

// 受け付けて送出意図を記録し、模擬の provider へ送る（精算は呼び出し側が時刻を決めて行う）。
async function admitAndSend(
  gate: ReturnType<BudgetHarness['gate']>,
  provider: MockPaidProvider,
  request: ReturnType<typeof claudeRequest>,
) {
  const admitted = await gate.admit(request);
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  if (!admitted.ok) throw new Error('not admitted');
  assert.deepEqual(await gate.dispatch(admitted.ticket), { ok: true });
  const outcome = await provider.send({
    request_id: request.request_id,
    reservation_id: admitted.ticket.reservation_id,
    signal: new AbortController().signal,
  });
  return { ticket: admitted.ticket, outcome };
}

// クレジットの設定と観測（メモリ）をつけた門。
function creditGate(
  harness: BudgetHarness,
  source: MemoryCreditSource,
  newId: () => string,
  options: Parameters<BudgetHarness['gate']>[0] = {},
) {
  return harness.gate({
    config: loadedConfig(creditConfig()),
    creditObservations: source,
    newId,
    ...options,
  });
}

function ids(start = 7000): () => string {
  let next = start;
  return () => uuid(next++);
}

test(
  'MA03: one usage is split once into the normal charge, the credit and the additional spend, and the pool limits still count the gross charge',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      // 残高 20 XXX = 40 XTS（1 単位あたり 2）。
      const source = new MemoryCreditSource([
        creditObservation({ balance: { currency: 'XXX', amount: '20' } }),
      ]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      // a: M 40 は残り 40 にちょうど収まる。実費 25 は全額クレジット。
      provider.plan(uuid(1), { kind: 'usage', actual: '25' });
      const a = await gate.run(claudeRequest(uuid(1)), provider.send);
      assert.equal(a.kind, 'settled');
      assert.deepEqual(view(harness, uuid(1)), [
        'settled',
        25,
        25,
        0,
        CYCLE_OCT,
      ]);
      // b: M 15 は残り 40 − 25 = 15 にちょうど収まる。実費 12 は全額クレジット（残り 3）。
      provider.plan(uuid(2), { kind: 'usage', actual: '12' });
      const b = await gate.run(
        claudeRequest(uuid(2), {
          quantities: { input_tokens: '10', output_tokens: '5' },
        }),
        provider.send,
      );
      assert.equal(b.kind, 'settled');
      assert.deepEqual(view(harness, uuid(2)), [
        'settled',
        12,
        12,
        0,
        CYCLE_OCT,
      ]);
      // c: M 40 は残り 3 に足りない。クレジットの保留で、provider へ送らない。
      const c = await gate.run(claudeRequest(uuid(3)), provider.send);
      assert.deepEqual(c, {
        kind: 'rejected',
        reasons: ['credit_insufficient'],
        budgetHeld: true,
      });
      assert.equal(provider.receipts.length, 2);
      // 追加の支出は 0 でも、通常料金の実費 37 は llm の上限に数える（クレジットの分も上限を空けない）。
      assert.deepEqual(await llmUsage(harness, '2030-10'), {
        settled: '37',
        max: '0',
        unknown: 0,
        holds: [],
      });
      // 同じ usage の再適用は変化なし（区分は 25・0 のまま）。違う実費は競合で、区分も変わらない。
      const again = await gate.settle(
        (a as Extract<typeof a, { kind: 'settled' }>).ticket,
        usageOf(provider, uuid(1), '25'),
      );
      assert.deepEqual(again, { ok: true, overrun: false, duplicate: true });
      const conflict = await gate.settle(
        (a as Extract<typeof a, { kind: 'settled' }>).ticket,
        usageOf(provider, uuid(1), '26'),
      );
      assert.deepEqual(conflict, {
        ok: false,
        reasons: ['settlement_conflict'],
      });
      assert.deepEqual(view(harness, uuid(1)), [
        'settled',
        25,
        25,
        0,
        CYCLE_OCT,
      ]);
      // クレジットを充てない profile（Luna）は同じ上限で数える: 40 が 1 件入り（37 + 40 = 77）、もう 1 件は上限を超える。
      provider.plan(uuid(4), { kind: 'usage', actual: '40' });
      const d = await gate.run(textRequest(uuid(4)), provider.send);
      assert.equal(d.kind, 'settled');
      assert.deepEqual(view(harness, uuid(4)), ['settled', 40, 0, 40, null]);
      const e = await gate.run(textRequest(uuid(5)), provider.send);
      assert.deepEqual(e, {
        kind: 'rejected',
        reasons: ['r_limit:llm', 'm_limit:llm', 'approval_required'],
        budgetHeld: true,
      });
      // 精算した行の合計: 通常料金 77 = クレジット 37 + 追加の支出 40。
      const settled = rows(harness).filter((row) => row.status === 'settled');
      assert.equal(
        settled.reduce((sum, row) => sum + (row.actual_gross ?? 0), 0),
        77,
      );
      assert.equal(
        settled.reduce((sum, row) => sum + (row.credit_applied ?? 0), 0),
        37,
      );
      assert.equal(
        settled.reduce((sum, row) => sum + (row.additional_spend ?? 0), 0),
        40,
      );
    });
  },
);

test(
  'MA03: an actual cost above M is credited only up to M, and an unknown usage keeps M reserved from the credit',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([creditObservation()]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      // b: 応答を失った（usage 不明）。実費を 0 と確定せず、M 40 を解放せず、クレジットの残りからも確保し続ける。
      provider.plan(uuid(2), { kind: 'drop', actual: '8' });
      const b = await gate.run(claudeRequest(uuid(2)), provider.send);
      assert.equal(b.kind, 'usage_unknown');
      assert.deepEqual(view(harness, uuid(2)), [
        'usage_unknown',
        null,
        null,
        null,
        CYCLE_OCT,
      ]);
      // a: M 40 に対して実費 55（M 超過）。受付は残り 100 − 40（b の確保）= 60 に収まる。クレジットは M の 40 まで
      // （b の確保を食わない）、残り 15 は追加の支出。
      provider.plan(uuid(1), { kind: 'usage', actual: '55' });
      const a = await gate.run(claudeRequest(uuid(1)), provider.send);
      assert.deepEqual(a.kind === 'settled' ? [a.kind, a.overrun] : a.kind, [
        'settled',
        true,
      ]);
      assert.deepEqual(view(harness, uuid(1)), [
        'settled',
        55,
        40,
        15,
        CYCLE_OCT,
      ]);
      assert.deepEqual(await gate.creditStatus(), {
        configured: true,
        profile_ids: [CREDIT_PROFILE],
        cycle_id: CYCLE_OCT,
        status: 'observed',
        shared: false,
        expires_at: '2030-11-01T00:00:00.000Z',
        observed_at: '2030-10-15T00:00:00.000Z',
        balance: '100',
        // 精算した a の消費の見積もり 55（実費。M 40 を超えた分も provider は引くので M で止めない。クレジットの割り当ては
        // 40）、未精算の b の M 40。残り 100 − 55 − 40 = 5。
        allocated_since: '55',
        outstanding: '40',
        available: '5',
        hold: null,
      });
      // 通常料金の枠: a の実費 55 は精算済み、b の M 40 は未精算の最大負担として残る。
      assert.deepEqual(await llmUsage(harness, '2030-10'), {
        settled: '55',
        max: '40',
        unknown: 1,
        holds: ['overrun_review_pending'],
      });
    });
  },
);

test(
  'MA03: the manual settlement of an unknown usage takes the split the owner reconciled, once, and only in the cycle the reservation belongs to',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([creditObservation()]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      provider.plan(uuid(1), { kind: 'drop', actual: '30' });
      const a = await gate.run(claudeRequest(uuid(1)), provider.send);
      assert.equal(a.kind, 'usage_unknown');
      const ticket = (a as Extract<typeof a, { kind: 'usage_unknown' }>).ticket;
      const manual = (overrides: Record<string, unknown>) =>
        gate.settleManual({
          reservation_id: ticket.reservation_id,
          expected_revision: ticket.revision,
          manual_reconciliation_id: 'manual:invoice-a',
          actual_gross: { currency: 'XTS', amount: '30' },
          request: {
            command_scope_id: uuid(0x501),
            request_id: uuid(0x502),
            request_hash: 'a'.repeat(64),
            command_id: uuid(0x503),
          },
          ...overrides,
        });
      // 別の周期への付け替え・実費と合わない区分は記録しない。
      assert.deepEqual(
        await manual({
          credit_applied: { currency: 'XTS', amount: '20' },
          additional_spend: { currency: 'XTS', amount: '10' },
          credit_cycle_id: CYCLE_NOV,
        }),
        { ok: false, reasons: ['credit_cycle_mismatch'], unknown: false },
      );
      assert.deepEqual(
        await manual({
          credit_applied: { currency: 'XTS', amount: '20' },
          additional_spend: { currency: 'XTS', amount: '9' },
          credit_cycle_id: CYCLE_OCT,
        }),
        { ok: false, reasons: ['settlement_sum'], unknown: false },
      );
      assert.deepEqual(
        await manual({
          credit_applied: { currency: 'XTS', amount: '20' },
          additional_spend: { currency: 'XTS', amount: '10' },
          credit_cycle_id: null,
        }),
        { ok: false, reasons: ['missing_credit_cycle'], unknown: false },
      );
      assert.deepEqual(view(harness, uuid(1)), [
        'usage_unknown',
        null,
        null,
        null,
        CYCLE_OCT,
      ]);
      // 本人が請求の照合で得た区分（クレジット 20・追加の支出 10）を、予約の周期で一度だけ記録する。
      const settled = await manual({
        credit_applied: { currency: 'XTS', amount: '20' },
        additional_spend: { currency: 'XTS', amount: '10' },
        credit_cycle_id: CYCLE_OCT,
      });
      assert.equal(settled.ok, true, JSON.stringify(settled));
      assert.deepEqual(view(harness, uuid(1)), [
        'settled',
        30,
        20,
        10,
        CYCLE_OCT,
      ]);
      // 同じ入力の再送は保存済みの結果。区分を変えた再適用は拒否し、記録は変わらない。
      const replay = await manual({
        credit_applied: { currency: 'XTS', amount: '20' },
        additional_spend: { currency: 'XTS', amount: '10' },
        credit_cycle_id: CYCLE_OCT,
      });
      assert.equal(replay.ok, true, JSON.stringify(replay));
      const changed = await gate.settleManual({
        reservation_id: ticket.reservation_id,
        expected_revision: ticket.revision,
        manual_reconciliation_id: 'manual:invoice-a',
        actual_gross: { currency: 'XTS', amount: '30' },
        credit_applied: { currency: 'XTS', amount: '30' },
        additional_spend: { currency: 'XTS', amount: '0' },
        credit_cycle_id: CYCLE_OCT,
        request: {
          command_scope_id: uuid(0x511),
          request_id: uuid(0x512),
          request_hash: 'b'.repeat(64),
          command_id: uuid(0x513),
        },
      });
      assert.deepEqual(changed, {
        ok: false,
        reasons: ['already_settled'],
        unknown: false,
      });
      assert.deepEqual(view(harness, uuid(1)), [
        'settled',
        30,
        20,
        10,
        CYCLE_OCT,
      ]);
      // 手で精算した後の provider の精算は拒否する（二重に数えない）。
      const late = await gate.settle(ticket, usageOf(provider, uuid(1), '30'));
      assert.deepEqual(late, { ok: false, reasons: ['settlement_conflict'] });
    });
  },
);

test(
  'MA04: the budget month rolling over never restores the credit balance, and the end of the cycle is a separate expiry',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([creditObservation()]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      // 10 月の予算月に a（実費 30）を精算: クレジット 30。残り 100 − 30 = 70。
      provider.plan(uuid(1), { kind: 'usage', actual: '30' });
      assert.equal(
        (await gate.run(claudeRequest(uuid(1)), provider.send)).kind,
        'settled',
      );
      assert.deepEqual(view(harness, uuid(1)), [
        'settled',
        30,
        30,
        0,
        CYCLE_OCT,
      ]);
      // 東京の 11 月の始まりの 1 時間後（2030-10-31T16:00Z）。予算月は 11 月へ替わるが、周期は 11 月 1 日 0 時（UTC）まで続く。
      harness.clock.set(TOKYO_NOV_START + 3_600_000);
      assert.equal(await gate.tick(), true);
      const afterRoll = await gate.creditStatus();
      assert.equal(afterRoll.allocated_since, '30');
      assert.equal(afterRoll.available, '70');
      assert.equal(afterRoll.hold, null);
      // b: 11 月の予算月の受付だが、結び付く周期は 10 月のまま。残り 70 から 40 を充てる（100 に戻らない）。
      provider.plan(uuid(2), { kind: 'usage', actual: '40' });
      assert.equal(
        (await gate.run(claudeRequest(uuid(2)), provider.send)).kind,
        'settled',
      );
      assert.deepEqual(view(harness, uuid(2)), [
        'settled',
        40,
        40,
        0,
        CYCLE_OCT,
      ]);
      assert.equal((await gate.creditStatus()).available, '30');
      // 周期の終わりの 1 ミリ秒前: c（M 10）はまだ受け付ける。送ったが、精算は周期の終わりより後になる。
      harness.clock.set(EXPIRY - 1);
      provider.plan(uuid(3), { kind: 'usage', actual: '8' });
      const c = await admitAndSend(
        gate,
        provider,
        claudeRequest(uuid(3), {
          quantities: { input_tokens: '5', output_tokens: '5' },
        }),
      );
      // f: 応答を失い、usage 不明のまま残る（周期 10 月）。
      provider.plan(uuid(6), { kind: 'drop', actual: '8' });
      const f = await gate.run(
        claudeRequest(uuid(6), {
          quantities: { input_tokens: '5', output_tokens: '5' },
        }),
        provider.send,
      );
      assert.equal(f.kind, 'usage_unknown');
      // 周期の終わりちょうど: Claude の処理は失効で保留、予算月は変わらず、Luna は受け付ける。
      harness.clock.set(EXPIRY);
      const held = await gate.run(claudeRequest(uuid(4)), provider.send);
      assert.deepEqual(held, {
        kind: 'rejected',
        reasons: ['credit_expired'],
        budgetHeld: true,
      });
      assert.deepEqual((await gate.holdState()).credit_hold, {
        reason: 'credit_expired',
        profile_ids: [CREDIT_PROFILE],
      });
      provider.plan(uuid(5), { kind: 'usage', actual: '3' });
      assert.equal(
        (await gate.run(textRequest(uuid(5)), provider.send)).kind,
        'settled',
      );
      // 本人が新しい周期（11 月 1 日開始）の観測を書く。残高は観測の値（200 XTS）で、前の周期の残りを引き継がない。
      harness.clock.set(EXPIRY + 1);
      source.observations.push(
        creditObservation({
          cycle_id: CYCLE_NOV,
          observed_at: '2030-11-01T00:00:00.001Z',
          expires_at: '2030-12-01T00:00:00.000Z',
          balance: { currency: 'XXX', amount: '100' },
        }),
      );
      // 古い周期の未精算の c を精算する: 周期 10 月は終わっているので、クレジットを確認できず 0（追加の支出＝実費）。
      // 新しい周期へ付け替えない（周期は 10 月のまま）。
      const settledC = await gate.settle(c.ticket, c.outcome as PaidUsage);
      assert.equal(settledC.ok, true, JSON.stringify(settledC));
      assert.deepEqual(view(harness, uuid(3)), ['settled', 8, 0, 8, CYCLE_OCT]);
      assert.deepEqual(await gate.creditStatus(), {
        configured: true,
        profile_ids: [CREDIT_PROFILE],
        cycle_id: CYCLE_NOV,
        status: 'observed',
        shared: false,
        expires_at: '2030-12-01T00:00:00.000Z',
        observed_at: '2030-11-01T00:00:00.001Z',
        balance: '200',
        // 古い周期の c・f は新しい周期の台帳に入らない。
        allocated_since: '0',
        outstanding: '0',
        available: '200',
        hold: null,
      });
      // 新しい周期の受付は新しい周期に結び付く。M 30・実費 25 は全額クレジット（残り 200 − 25 = 175）。
      provider.plan(uuid(7), { kind: 'usage', actual: '25' });
      assert.equal(
        (
          await gate.run(
            claudeRequest(uuid(7), {
              quantities: { input_tokens: '10', output_tokens: '20' },
            }),
            provider.send,
          )
        ).kind,
        'settled',
      );
      assert.deepEqual(view(harness, uuid(7)), [
        'settled',
        25,
        25,
        0,
        CYCLE_NOV,
      ]);
      assert.equal((await gate.creditStatus()).available, '175');
      // 古い周期の usage 不明 f は、新しい周期へ付け替える精算を拒否し、周期 10 月のままの区分だけを受け付ける。
      const ticketF = (f as Extract<typeof f, { kind: 'usage_unknown' }>)
        .ticket;
      const toNov = await gate.settleManual({
        reservation_id: ticketF.reservation_id,
        expected_revision: ticketF.revision,
        manual_reconciliation_id: 'manual:invoice-f',
        actual_gross: { currency: 'XTS', amount: '8' },
        credit_applied: { currency: 'XTS', amount: '6' },
        additional_spend: { currency: 'XTS', amount: '2' },
        credit_cycle_id: CYCLE_NOV,
        request: {
          command_scope_id: uuid(0x601),
          request_id: uuid(0x602),
          request_hash: 'c'.repeat(64),
          command_id: uuid(0x603),
        },
      });
      assert.deepEqual(toNov, {
        ok: false,
        reasons: ['credit_cycle_mismatch'],
        unknown: false,
      });
      const toOct = await gate.settleManual({
        reservation_id: ticketF.reservation_id,
        expected_revision: ticketF.revision,
        manual_reconciliation_id: 'manual:invoice-f',
        actual_gross: { currency: 'XTS', amount: '8' },
        credit_applied: { currency: 'XTS', amount: '6' },
        additional_spend: { currency: 'XTS', amount: '2' },
        credit_cycle_id: CYCLE_OCT,
        request: {
          command_scope_id: uuid(0x611),
          request_id: uuid(0x612),
          request_hash: 'd'.repeat(64),
          command_id: uuid(0x613),
        },
      });
      assert.equal(toOct.ok, true, JSON.stringify(toOct));
      assert.deepEqual(view(harness, uuid(6)), ['settled', 8, 6, 2, CYCLE_OCT]);
      // 新しい周期の台帳は、古い周期の精算に影響されない（残り 175 のまま）。
      assert.equal((await gate.creditStatus()).available, '175');
    });
  },
);

test(
  'MA04: the cycle id is the provider and the UTC start date of the cycle, and an observation with another start is a separate cycle',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      // 同じ周期の 2 つの観測は、新しい方（観測の時刻が後）が残高。古い方に戻らない。
      const source = new MemoryCreditSource([
        creditObservation({
          observed_at: '2030-10-16T00:00:00.000Z',
          balance: { currency: 'XXX', amount: '10' },
        }),
        creditObservation(),
      ]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      harness.clock.set(Date.parse('2030-10-16T00:00:00.000Z'));
      assert.equal((await gate.creditStatus()).balance, '20');
      // 今より後の観測は読まない（10 月 20 日の観測は、10 月 16 日の時点では存在しない）。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-20T00:00:00.000Z',
          balance: { currency: 'XXX', amount: '50' },
        }),
      );
      assert.equal((await gate.creditStatus()).balance, '20');
      harness.clock.set(Date.parse('2030-10-20T00:00:00.000Z'));
      assert.equal((await gate.creditStatus()).balance, '100');
      // 観測の後に精算したクレジットだけが残高から引かれる。10 月 20 日の観測の前に精算した分は引かない。
      provider.plan(uuid(1), { kind: 'usage', actual: '30' });
      harness.clock.set(Date.parse('2030-10-20T00:00:01.000Z'));
      await gate.run(claudeRequest(uuid(1)), provider.send);
      const status = await gate.creditStatus();
      assert.deepEqual(
        [status.allocated_since, status.available],
        ['30', '70'],
      );
      // 新しい観測が同じ周期で届いたら、観測の時刻より前の精算は引かない（観測した残高に含まれている）。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-20T00:00:02.000Z',
          balance: { currency: 'XXX', amount: '30' },
        }),
      );
      harness.clock.set(Date.parse('2030-10-20T00:00:03.000Z'));
      const renewed = await gate.creditStatus();
      assert.deepEqual(
        [renewed.balance, renewed.allocated_since, renewed.available],
        ['60', '0', '60'],
      );
    });
  },
);

// 残高が確認できない場合。観測は採用すると永続化され、同じ時刻で内容の違う観測は採用しないので、場合ごとに新しい DB で確かめる。
const UNCONFIRMED: readonly {
  readonly title: string;
  readonly reasons: readonly string[];
  readonly observations: () => ReturnType<typeof creditObservation>[];
  readonly failure?: 'missing' | 'unreadable';
}[] = [
  {
    title: 'no observation',
    reasons: ['credit_unknown'],
    observations: () => [],
  },
  {
    title: 'the file is missing',
    reasons: ['credit_unknown'],
    observations: () => [],
    failure: 'missing',
  },
  {
    title: 'the file is unreadable',
    reasons: ['credit_unknown'],
    observations: () => [],
    failure: 'unreadable',
  },
  {
    title: 'the status is unknown',
    reasons: ['credit_unknown'],
    observations: () => [
      creditObservation({ status: 'unknown', balance: null, shared: true }),
    ],
  },
  {
    title: 'the status is expired',
    reasons: ['credit_expired'],
    observations: () => [creditObservation({ status: 'expired' })],
  },
  {
    title: 'the balance is zero',
    reasons: ['credit_exhausted'],
    observations: () => [
      creditObservation({ balance: { currency: 'XXX', amount: '0' } }),
    ],
  },
  {
    title: 'the balance is in another currency',
    reasons: ['credit_unknown'],
    observations: () => [
      creditObservation({ balance: { currency: 'XTS', amount: '500' } }),
    ],
  },
  {
    title: 'the observation is of another provider',
    reasons: ['credit_unknown'],
    observations: () => [
      creditObservation({ provider: 'openai', cycle_id: 'openai:2030-10-01' }),
    ],
  },
];

for (const item of UNCONFIRMED)
  test(
    `MA05: an unconfirmed balance holds the credit profile without sending, and other profiles are not held: ${item.title}`,
    TIMEOUT,
    async () => {
      await withBudgetStore(async (harness) => {
        const provider = new MockPaidProvider();
        const source = new MemoryCreditSource(item.observations());
        if (item.failure !== undefined) source.failure = item.failure;
        const gate = creditGate(harness, source, ids());
        await gate.start();
        const held = await gate.admit(claudeRequest(uuid(1)));
        assert.deepEqual(held.ok ? 'admitted' : held.reasons, item.reasons);
        assert.deepEqual(held.ok ? null : held.budgetHeld, true);
        // provider へ送らず、予約も作らない。
        assert.equal(provider.receipts.length, 0);
        assert.equal(rows(harness).length, 0);
        assert.equal(
          (await gate.holdState()).credit_hold?.reason,
          item.reasons[0],
        );
        // クレジットを充てない profile は、観測がなくても保留しない。
        provider.plan(uuid(2), { kind: 'usage', actual: '5' });
        assert.equal(
          (await gate.run(textRequest(uuid(2)), provider.send)).kind,
          'settled',
        );
        assert.deepEqual(view(harness, uuid(2)), ['settled', 5, 0, 5, null]);
      });
    },
  );

test(
  'MA05: a valid observation that arrives later resumes the credit profile',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      assert.equal((await gate.admit(claudeRequest(uuid(1)))).ok, false);
      source.observations = [creditObservation()];
      provider.plan(uuid(2), { kind: 'usage', actual: '20' });
      assert.equal(
        (await gate.run(claudeRequest(uuid(2)), provider.send)).kind,
        'settled',
      );
      assert.deepEqual(view(harness, uuid(2)), [
        'settled',
        20,
        20,
        0,
        CYCLE_OCT,
      ]);
      assert.equal((await gate.holdState()).credit_hold, undefined);
    });
  },
);

test(
  'MA05: the exact end of the cycle is expired, and one millisecond before it the request is still admitted',
  TIMEOUT,
  async () => {
    await withBudgetStore(
      async (harness) => {
        const source = new MemoryCreditSource([
          creditObservation({ balance: { currency: 'XXX', amount: '20' } }),
        ]);
        const gate = creditGate(harness, source, ids());
        await gate.start();
        // 周期の終わりの 1 ミリ秒前は受け付ける（残り 40 に M 40 がちょうど収まる）。
        const early = await gate.admit(claudeRequest(uuid(1)));
        assert.equal(early.ok, true, JSON.stringify(early));
        // 終わりちょうどは失効。
        harness.clock.set(EXPIRY);
        const expired = await gate.admit(claudeRequest(uuid(2)));
        assert.deepEqual(expired.ok ? 'admitted' : expired.reasons, [
          'credit_expired',
        ]);
      },
      { start: EXPIRY - 1 },
    );
  },
);

test(
  'MA05: an exhausted balance holds the credit profile, and a new observation releases it without counting what was settled before the observation',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([
        creditObservation({ balance: { currency: 'XXX', amount: '20' } }),
      ]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      // a: 実費 40 は残り 40 の全額クレジット。残り 0。
      provider.plan(uuid(1), { kind: 'usage', actual: '40' });
      assert.equal(
        (await gate.run(claudeRequest(uuid(1)), provider.send)).kind,
        'settled',
      );
      assert.deepEqual(view(harness, uuid(1)), [
        'settled',
        40,
        40,
        0,
        CYCLE_OCT,
      ]);
      const exhausted = await gate.admit(claudeRequest(uuid(3)));
      assert.deepEqual(exhausted.ok ? 'admitted' : exhausted.reasons, [
        'credit_exhausted',
      ]);
      // 本人が新しい観測（残高 30 XXX = 60 XTS）を書くと解ける。観測の時刻より前の精算（a）は残高に含まれているので引かない。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-15T00:00:02.000Z',
          balance: { currency: 'XXX', amount: '30' },
        }),
      );
      harness.clock.set(OCT_15 + 3000);
      const released = await gate.admit(claudeRequest(uuid(4)));
      assert.equal(released.ok, true, JSON.stringify(released));
      assert.equal((await gate.creditStatus()).available, '20');
    });
  },
);

test(
  'MA05: another use of a shared organization is not trusted past the age limit, and a lower balance in a new observation holds what no longer fits',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const source = new MemoryCreditSource([
        creditObservation({ shared: true }),
      ]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      const at = (offset: number) => harness.clock.set(OCT_15 + offset);
      // 観測から 1 時間ちょうどまでは新しい（上限は 3,600,000 ミリ秒）。
      at(3_600_000);
      const fresh = await gate.admit(claudeRequest(uuid(1)));
      assert.equal(fresh.ok, true, JSON.stringify(fresh));
      // 1 ミリ秒でも過ぎたら古い。新しい観測が届くまで保留。
      at(3_600_001);
      const stale = await gate.admit(claudeRequest(uuid(2)));
      assert.deepEqual(stale.ok ? 'admitted' : stale.reasons, ['credit_stale']);
      assert.deepEqual((await gate.holdState()).credit_hold, {
        reason: 'credit_stale',
        profile_ids: [CREDIT_PROFILE],
      });
      // 他の用途が使って残高が 5 XXX = 10 XTS に減った新しい観測。未精算の a（M 40）の確保はそのまま数えるので、
      // 残り 10 − 40 は負で、枯渇として保留する。
      at(7_200_000);
      source.observations.push(
        creditObservation({
          shared: true,
          observed_at: '2030-10-15T02:00:00.000Z',
          balance: { currency: 'XXX', amount: '5' },
        }),
      );
      const afterOther = await gate.admit(claudeRequest(uuid(3)));
      assert.deepEqual(afterOther.ok ? 'admitted' : afterOther.reasons, [
        'credit_exhausted',
      ]);
      // a を精算する（実費 8）。観測（2 時間後）より後の精算なので、残り 10 の範囲で 8 がクレジットになり、観測の後の
      // 精算として残高から引かれる。未精算の確保は外れる。
      const ticket = fresh.ok ? fresh.ticket : null;
      assert(ticket !== null);
      const settled = await gate.settle(
        ticket,
        usageOf(new MockPaidProvider(), uuid(1), '8'),
      );
      assert.equal(settled.ok, true, JSON.stringify(settled));
      assert.deepEqual(view(harness, uuid(1)), ['settled', 8, 8, 0, CYCLE_OCT]);
      // 残り 10 − 8 = 2。M 11 は足りず、M 2 はちょうど収まる。
      const tooBig = await gate.admit(
        claudeRequest(uuid(4), {
          quantities: { input_tokens: '5', output_tokens: '6' },
        }),
      );
      assert.deepEqual(tooBig.ok ? 'admitted' : tooBig.reasons, [
        'credit_insufficient',
      ]);
      const small = await gate.admit(
        claudeRequest(uuid(5), {
          quantities: { input_tokens: '1', output_tokens: '1' },
        }),
      );
      assert.equal(small.ok, true, JSON.stringify(small));
    });
  },
);

test(
  'MA05: concurrent requests never reserve more than the credit, and the one that no longer fits is held',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      // 残高 30 XXX = 60 XTS。M 25 の要求 3 つを関門で同時に受付へ送る。
      const source = new MemoryCreditSource([
        creditObservation({ balance: { currency: 'XXX', amount: '30' } }),
      ]);
      const racing = creditGate(harness, source, ids(), {
        faults: { beforeAdmit: barrier(3) },
      });
      await racing.start();
      const results = await Promise.all(
        [1, 2, 3].map((n) =>
          racing.admit(
            claudeRequest(uuid(n), {
              quantities: { input_tokens: '10', output_tokens: '15' },
            }),
          ),
        ),
      );
      assert.equal(results.filter((item) => item.ok).length, 2);
      const losers = results.flatMap((item) => (item.ok ? [] : [item.reasons]));
      assert.deepEqual(losers, [['credit_insufficient']]);
      // 確保した M の合計 50 は残高 60 以内。provider へは送っていない。
      const reserved = rows(harness).reduce(
        (sum, row) => sum + row.max_liability,
        0,
      );
      assert.equal(reserved, 50);
      assert.equal(provider.receipts.length, 0);
      const status = await racing.creditStatus();
      assert.deepEqual([status.outstanding, status.available], ['50', '10']);
    });
  },
);

test(
  'MA05: a settlement does not depend on the observation file: the adopted observation stays when the file is unreadable or missing',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([creditObservation()]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '25' });
      // 送っている間に観測のファイルが読めなくなる（書き換えの途中など）。受付で採用した観測のまま精算する。
      const first = await gate.run(claudeRequest(uuid(1)), (context) => {
        source.failure = 'unreadable';
        return provider.send(context);
      });
      assert.equal(first.kind, 'settled');
      assert.deepEqual(view(harness, uuid(1)), [
        'settled',
        25,
        25,
        0,
        CYCLE_OCT,
      ]);
      // ファイルがない（消した）ときも、採用済みの観測から受け付け、精算できる（残り 100 − 25 = 75）。
      provider.plan(uuid(2), { kind: 'usage', actual: '10' });
      source.failure = 'missing';
      const second = await gate.run(claudeRequest(uuid(2)), provider.send);
      assert.equal(second.kind, 'settled');
      assert.deepEqual(view(harness, uuid(2)), [
        'settled',
        10,
        10,
        0,
        CYCLE_OCT,
      ]);
      assert.equal((await gate.creditStatus()).available, '65');
    });
  },
);

test(
  'MA06: voice, search and profiles that are not listed never receive the credit, even for the listed profile id on a voice or search request',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      // 観測が一つもない状態でも、Claude の保留は音声・検索・Luna に及ばない。
      const source = new MemoryCreditSource([]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '12' });
      const voice = await gate.run(
        claudeRequest(uuid(1), {
          service: 'voice',
          price_key: 'synthetic.live',
          quantities: { live_seconds: '20' },
        }),
        provider.send,
      );
      assert.equal(voice.kind, 'settled');
      assert.deepEqual(view(harness, uuid(1)), ['settled', 12, 0, 12, null]);
      provider.plan(uuid(2), { kind: 'usage', actual: '7' });
      const search = await gate.run(
        claudeRequest(uuid(2), { service: 'search' }),
        provider.send,
      );
      assert.equal(search.kind, 'settled');
      assert.deepEqual(view(harness, uuid(2)), ['settled', 7, 0, 7, null]);
      provider.plan(uuid(3), { kind: 'usage', actual: '9' });
      const luna = await gate.run(textRequest(uuid(3)), provider.send);
      assert.equal(luna.kind, 'settled');
      assert.deepEqual(view(harness, uuid(3)), ['settled', 9, 0, 9, null]);
      // 観測があっても同じ: クレジットの残りは動かない。
      source.observations = [creditObservation()];
      provider.plan(uuid(4), { kind: 'usage', actual: '11' });
      const voice2 = await gate.run(
        claudeRequest(uuid(4), {
          service: 'voice',
          price_key: 'synthetic.live',
          quantities: { live_seconds: '20' },
        }),
        provider.send,
      );
      assert.equal(voice2.kind, 'settled');
      assert.deepEqual(view(harness, uuid(4)), ['settled', 11, 0, 11, null]);
      assert.deepEqual(
        [await gate.creditStatus()].map((item) => [
          item.allocated_since,
          item.outstanding,
          item.available,
        ]),
        [['0', '0', '100']],
      );
      // 周期に結び付かない予約へのクレジットは、手での精算でも記録しない。
      const ticket = (voice2 as Extract<typeof voice2, { kind: 'settled' }>)
        .ticket;
      const manual = await gate.settleManual({
        reservation_id: ticket.reservation_id,
        expected_revision: ticket.revision,
        manual_reconciliation_id: 'manual:voice',
        actual_gross: { currency: 'XTS', amount: '11' },
        credit_applied: { currency: 'XTS', amount: '5' },
        additional_spend: { currency: 'XTS', amount: '6' },
        credit_cycle_id: CYCLE_OCT,
        request: {
          command_scope_id: uuid(0x701),
          request_id: uuid(0x702),
          request_hash: 'e'.repeat(64),
          command_id: uuid(0x703),
        },
      });
      assert.deepEqual(manual, {
        ok: false,
        reasons: ['credit_cycle_mismatch'],
        unknown: false,
      });
      // 音声・検索・Luna の行は、周期にも結び付かず、クレジットも持たない。
      const credited = rows(harness).filter(
        (row) => (row.credit_applied ?? 0) > 0,
      );
      assert.equal(credited.length, 0);
    });
  },
);

test(
  'MA06: an unknown real charge is never confirmed as zero, a settled credit needs the cycle of the reservation, and without the credit setting the initial rule applies',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([creditObservation()]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      // 応答を失った Claude の要求は usage 不明。実費を 0 と記録せず、クレジットを充てた扱いにもしない。
      provider.plan(uuid(1), { kind: 'drop', actual: '17' });
      const lost = await gate.run(claudeRequest(uuid(1)), provider.send);
      assert.equal(lost.kind, 'usage_unknown');
      assert.deepEqual(view(harness, uuid(1)), [
        'usage_unknown',
        null,
        null,
        null,
        CYCLE_OCT,
      ]);
      // DB の最終の保証: 実費 = クレジット + 追加の支出（CHECK）。合わない区分の精算は SQL でも書けない。
      assert.throws(() =>
        harness.sql((db: SqliteDatabase) =>
          db
            .prepare(
              "UPDATE budget_reservations SET status = 'settled', actual_gross = 5, credit_applied = 4, additional_spend = 2, provider_reconciliation_id = 'x:bad', settlement_kind = 'provider', settled_at = 1 WHERE request_id = ?",
            )
            .run(uuid(1)),
        ),
      );
      // 設定に credit がなければ、Claude の profile も初期の規則（クレジット 0・追加の支出＝実費・周期なし）。観測は見ない。
      const plain = harness.gate({
        newId: ids(9000),
        creditObservations: source,
      });
      provider.plan(uuid(2), { kind: 'usage', actual: '14' });
      const result = await plain.run(claudeRequest(uuid(2)), provider.send);
      assert.equal(result.kind, 'settled');
      assert.deepEqual(view(harness, uuid(2)), ['settled', 14, 0, 14, null]);
      assert.equal((await plain.creditStatus()).configured, false);
      assert.equal((await plain.holdState()).credit_hold, undefined);
    });
  },
);

test(
  'MA05: the periodic check tells a waiting analysis once when a new observation clears the credit hold, and tells nothing while the hold stays or when credit is not configured',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const source = new MemoryCreditSource([]);
      const gate = creditGate(harness, source, ids());
      await gate.start();
      const events: string[] = [];
      gate.onResumable((event) => events.push(event.kind));
      // 観測がない間は保留のまま。何度確認しても知らせない。
      await gate.tick();
      await gate.tick();
      assert.deepEqual(events, []);
      // 本人が観測を書く。次の確認で、保留が解けたことを一度だけ知らせる。
      source.observations = [creditObservation()];
      await gate.tick();
      await gate.tick();
      assert.deepEqual(events, ['credit_resumed']);
      // 再び保留（失効）になり、また観測が届いたら、もう一度知らせる。
      // 周期の終わりの時刻は、予算月（東京）では 11 月に入った後で、月替わりも一緒に知らせる。
      harness.clock.set(EXPIRY);
      await gate.tick();
      assert.deepEqual(events, ['credit_resumed', 'month_rolled']);
      source.observations.push(
        creditObservation({
          cycle_id: CYCLE_NOV,
          observed_at: '2030-11-01T00:00:00.000Z',
          expires_at: '2030-12-01T00:00:00.000Z',
        }),
      );
      await gate.tick();
      assert.deepEqual(events, [
        'credit_resumed',
        'month_rolled',
        'credit_resumed',
      ]);
      // クレジットの設定がなければ、確認しても知らせない。
      const plain = harness.gate({ newId: ids(9000) });
      const plainEvents: string[] = [];
      plain.onResumable((event) => plainEvents.push(event.kind));
      await plain.tick();
      await plain.tick();
      assert.deepEqual(plainEvents, []);
    });
  },
);

test('the runtime config without credit is unchanged, and the credit setting rejects a zero rate and a same-currency rate other than one', () => {
  assert.equal(syntheticConfig()['credit'], undefined);
  assert.throws(
    () =>
      loadedConfig(
        creditConfig((config) => {
          (config['credit'] as Record<string, unknown>)[
            'balance_to_budget_rate'
          ] = '0';
        }),
      ),
    /credit_non_positive_rate/u,
  );
  assert.throws(
    () =>
      loadedConfig(
        creditConfig((config) => {
          Object.assign(config['credit'] as Record<string, unknown>, {
            balance_currency: 'XTS',
            balance_to_budget_rate: '2',
          });
        }),
      ),
    /credit_same_currency_rate/u,
  );
});
