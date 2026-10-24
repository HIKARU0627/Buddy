// 予算の門（ADR 0037）を、DB worker（一時ディレクトリの DB）と模擬の有料 provider（同じプロセス）で確かめる。
// 同時の 2 要求（関門）・応答の喪失・結果の破棄・timeout・月替わり（時計の注入）・精算の重複と競合・M 超過の保留・
// 未送信の解放・再起動の照合・追加予約・予算月の確かめ直し、予約の行と provider の受信の記録の突き合わせ。
// 期待値（受付の可否・理由・金額・件数）は合成の設定（XTS、縮めた上限、M = 入力 10 + 出力の上限 30 = 40）から手で
// 書いた値で、実装の処理から作っていない。待ち合わせは関門・受信の知らせ・手で発火する timer で行い、固定の sleep を
// 使わない。模擬の試験だけで、実 API・実請求・実機は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import { overageRouteOf, routePool } from '@buddy/domain';
import type { BudgetOrigin, BudgetService } from '@buddy/domain';
import type { SqliteDatabase } from '@buddy/storage';
import type { BudgetResumeEvent, BudgetTicket } from './budget-gate.js';
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
} from './budget-test-support.js';
import type { BudgetHarness } from './budget-test-support.js';

const TIMEOUT = { timeout: 60_000 };

interface Row {
  reservation_id: string;
  request_id: string;
  pool_id: string;
  budget_month: string;
  status: string;
  reserved_amount: number;
  max_liability: number;
  actual_gross: number | null;
  dispatch_intent_at: number | null;
  reservation_revision: number;
}

const rows = (harness: BudgetHarness): Row[] =>
  harness.sql(
    (db: SqliteDatabase) =>
      db
        .prepare(
          'SELECT reservation_id, request_id, pool_id, budget_month, status, reserved_amount, max_liability, actual_gross, dispatch_intent_at, reservation_revision FROM budget_reservations ORDER BY created_at, request_id',
        )
        .all() as Row[],
  );

const rowOf = (harness: BudgetHarness, requestId: string): Row => {
  const found = rows(harness).find((row) => row.request_id === requestId);
  assert(found !== undefined, requestId);
  return found;
};

async function poolUsage(
  harness: BudgetHarness,
  month: string,
  poolId: string,
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
    ?.pools.find((item) => item.pool_id === poolId);
  assert(pool !== undefined, `${month} ${poolId}`);
  return {
    settled: pool.settled.amount,
    reserved: pool.unsettled_reserved.amount,
    max: pool.unsettled_max_liability.amount,
    unknown: pool.usage_unknown_count,
    holds: pool.hold_reasons,
  };
}

test('the origin decides the leaf pool from the routing, and only owner LLM and search pools are routable to the overage pool', () => {
  const routing = loadedConfig().config.routing;
  const expected: Record<BudgetOrigin, Record<BudgetService, string | null>> = {
    owner_request: { llm: 'llm', search: 'search', voice: 'voice' },
    autonomous_analysis: {
      llm: 'llm.background',
      search: 'search',
      voice: null,
    },
    auto_execution: { llm: 'llm.background', search: 'search', voice: null },
    initial_import: { llm: 'llm.background', search: 'search', voice: null },
    shadow_mode: { llm: 'llm.background', search: null, voice: null },
  };
  for (const [origin, services] of Object.entries(expected))
    for (const [service, pool] of Object.entries(services))
      assert.equal(
        routePool(routing, origin as BudgetOrigin, service as BudgetService),
        pool,
        `${origin} ${service}`,
      );
  assert.deepEqual(overageRouteOf(routing), {
    routablePoolIds: ['llm', 'search'],
    overagePoolId: 'overage',
  });
  // 超過枠がない・本人の依頼の LLM・検索の枠がないなら回さない（空の許可リストは閉じた側）。
  assert.equal(overageRouteOf({ ...routing, overage_pool_id: null }), null);
  assert.equal(
    overageRouteOf({
      ...routing,
      routes: {
        ...routing.routes,
        owner_request: { llm: null, search: null, voice: 'voice' },
      },
    }),
    null,
  );
});

test(
  'two requests aligned at a barrier admit only what fits and the provider receives only the admitted one',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate({ faults: { beforeAdmit: barrier(2) } });
      await gate.start();
      const ids = [uuid(1), uuid(2)];
      for (const id of ids) provider.plan(id, { kind: 'usage', actual: '25' });
      // 自発の解析の枠（50）に M = 40 の要求が 2 つ。両方が関門でそろってから受付の命令を送る。
      const results = await Promise.all(
        ids.map((id) =>
          gate.run(
            textRequest(id, { origin: 'autonomous_analysis' }),
            provider.send,
          ),
        ),
      );
      const kinds = results.map((result) => result.kind).sort();
      assert.deepEqual(kinds, ['rejected', 'settled']);
      const rejected = results.find((result) => result.kind === 'rejected');
      assert.deepEqual(rejected, {
        kind: 'rejected',
        // 自発の処理は承認があっても超過枠へ回さない（本人の依頼でない・許可リストにない枠）。
        reasons: [
          'r_limit:llm.background',
          'm_limit:llm.background',
          'not_owner_request',
          'pool_not_routable',
        ],
        budgetHeld: true,
      });
      assert.equal(provider.receipts.length, 1);
      assert.deepEqual(
        rows(harness).map((row) => [row.status, row.actual_gross]),
        [['settled', 25]],
      );
    });
  },
);

test(
  'a lost response keeps R and M as usage unknown, is never resent, and stays in the original month',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate();
      await gate.start();
      provider.plan(uuid(1), { kind: 'drop', actual: '33' });
      const result = await gate.run(textRequest(uuid(1)), provider.send);
      assert.equal(result.kind, 'usage_unknown');
      assert.deepEqual(result.kind === 'usage_unknown' ? result.reasons : [], [
        'response_lost',
      ]);
      assert.equal(provider.receipts.length, 1);
      assert.deepEqual(await poolUsage(harness, '2030-10', 'llm'), {
        settled: '0',
        reserved: '40',
        max: '40',
        unknown: 1,
        holds: [],
      });
      // 同じ request_id の送り直しは受け付けない（保存済みの予約はもう reserved ではない）。provider へも送らない。
      const again = await gate.run(textRequest(uuid(1)), provider.send);
      assert.deepEqual(again, {
        kind: 'rejected',
        reasons: ['duplicate_request'],
        budgetHeld: false,
      });
      assert.equal(provider.receipts.length, 1);
      // 月が替わっても前の月の usage 不明は解放せず、今月には数えない。
      harness.clock.set(NOV_02);
      await gate.tick();
      assert.deepEqual(await poolUsage(harness, '2030-10', 'llm'), {
        settled: '0',
        reserved: '40',
        max: '40',
        unknown: 1,
        holds: [],
      });
      assert.deepEqual(await poolUsage(harness, '2030-11', 'llm'), {
        settled: '0',
        reserved: '0',
        max: '0',
        unknown: 0,
        holds: [],
      });
    });
  },
);

test(
  'a discarded result is usage unknown at once and a usage that arrives later settles into the original month',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate();
      await gate.start();
      provider.plan(uuid(1), { kind: 'hold' });
      const controller = new AbortController();
      const running = gate.run(textRequest(uuid(1)), provider.send, {
        signal: controller.signal,
      });
      await provider.received(uuid(1));
      controller.abort();
      const result = await running;
      assert.equal(result.kind, 'usage_unknown');
      assert.deepEqual(result.kind === 'usage_unknown' ? result.reasons : [], [
        'discarded',
      ]);
      assert.equal(rowOf(harness, uuid(1)).status, 'usage_unknown');
      // 月が替わった後に、遅れて usage が届く。元の月（10 月）に一度だけ精算する。
      harness.clock.set(NOV_02);
      await gate.tick();
      provider.deliver(uuid(1), '12');
      await gate.idle();
      const row = rowOf(harness, uuid(1));
      assert.deepEqual(
        [row.status, row.actual_gross, row.budget_month, row.pool_id],
        ['settled', 12, '2030-10', 'llm'],
      );
      assert.equal(provider.receipts.length, 1);
    });
  },
);

test(
  'a timeout aborts the wait, keeps R and M, and does not send again',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const timers = new ManualTimers();
      const gate = harness.gate({ timers });
      await gate.start();
      provider.plan(uuid(1), { kind: 'hold' });
      const running = gate.run(textRequest(uuid(1)), provider.send);
      await provider.received(uuid(1));
      assert.equal(timers.size, 1);
      timers.fireAll();
      const result = await running;
      assert.equal(result.kind, 'usage_unknown');
      assert.deepEqual(result.kind === 'usage_unknown' ? result.reasons : [], [
        'timeout',
      ]);
      const row = rowOf(harness, uuid(1));
      assert.deepEqual(
        [row.status, row.reserved_amount, row.max_liability],
        ['usage_unknown', 40, 40],
      );
      assert.equal(provider.receipts.length, 1);
      // timer は済んだら残さない（成功の経路でも取り消す）。
      provider.plan(uuid(2), { kind: 'usage', actual: '5' });
      assert.equal(
        (await gate.run(textRequest(uuid(2)), provider.send)).kind,
        'settled',
      );
      assert.equal(timers.size, 0);
    });
  },
);

test(
  'the month rolls over by the injected clock: the notice resumes waiting work and the new month has the whole limit',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate();
      await gate.start();
      const events: BudgetResumeEvent[] = [];
      gate.onResumable((event) => events.push(event));
      provider.plan(uuid(1), { kind: 'usage', actual: '40' });
      provider.plan(uuid(2), { kind: 'drop', actual: '40' });
      await gate.run(textRequest(uuid(1)), provider.send);
      await gate.run(textRequest(uuid(2)), provider.send);
      // 10 月の llm（100）は精算 40 ＋ usage 不明の M 40 = 80。M 40 の次の要求は M で拒否する。
      const october = await gate.admit(textRequest(uuid(3)));
      // 本人の依頼の枠は超過枠へ回せるが、承認がないので回さない。
      assert.deepEqual(october, {
        ok: false,
        reasons: ['r_limit:llm', 'm_limit:llm', 'approval_required'],
        budgetHeld: true,
      });
      // 東京の 11 月の始まりの 1 ミリ秒前は 10 月のまま。ちょうどで 11 月。
      harness.clock.set(TOKYO_NOV_START - 1);
      assert.equal(await gate.tick(), true);
      assert.deepEqual(events, []);
      harness.clock.set(TOKYO_NOV_START);
      await gate.tick();
      assert.deepEqual(events, [{ kind: 'month_rolled', month: '2030-11' }]);
      const first = await gate.admit(textRequest(uuid(4)));
      const second = await gate.admit(textRequest(uuid(5)));
      assert.equal(first.ok && first.ticket.budget_month, '2030-11');
      assert.equal(second.ok && second.ticket.budget_month, '2030-11');
      // 同じ月の中で二度目の月替わりの知らせはない。
      await gate.tick();
      assert.equal(events.length, 1);
    });
  },
);

test(
  'a settlement applies once: the same usage is a duplicate and a different usage is a conflict',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate();
      await gate.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '20' });
      const result = await gate.run(textRequest(uuid(1)), provider.send);
      assert.equal(result.kind, 'settled');
      if (result.kind !== 'settled') return;
      const usage = {
        kind: 'usage' as const,
        provider: 'mockpaid',
        reconciliation_id: `rcpt-${uuid(1)}`,
        actual_gross: '20',
      };
      assert.deepEqual(await gate.settle(result.ticket, usage), {
        ok: true,
        overrun: false,
        duplicate: true,
      });
      assert.deepEqual(
        await gate.settle(result.ticket, { ...usage, actual_gross: '21' }),
        { ok: false, reasons: ['settlement_conflict'] },
      );
      assert.deepEqual(
        await gate.settle(result.ticket, {
          ...usage,
          reconciliation_id: 'rcpt-other',
        }),
        { ok: false, reasons: ['settlement_conflict'] },
      );
      // 同じ照合 ID を別の予約に使わない。
      const other = await gate.admit(textRequest(uuid(2)));
      assert(other.ok);
      assert.deepEqual(await gate.dispatch(other.ticket), { ok: true });
      assert.deepEqual(await gate.settle(other.ticket, usage), {
        ok: false,
        reasons: ['reconciliation_id_used'],
      });
      assert.equal(rowOf(harness, uuid(1)).actual_gross, 20);
    });
  },
);

test(
  'an actual cost above M holds the pool and its descendants until the owner reviews it',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate();
      await gate.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '55' });
      const result = await gate.run(textRequest(uuid(1)), provider.send);
      assert.deepEqual(
        result.kind === 'settled' ? [result.overrun, result.duplicate] : [],
        [true, false],
      );
      // llm と子の llm.background は止まる。兄弟の search は止まらない。
      // M 超過の保留は上限だけの拒否ではないので、超過枠へも回さない（not_limit_only）。
      assert.deepEqual(await gate.admit(textRequest(uuid(2))), {
        ok: false,
        reasons: ['overrun_hold:llm', 'not_limit_only'],
        budgetHeld: true,
      });
      assert.deepEqual(
        await gate.admit(textRequest(uuid(3), { origin: 'auto_execution' })),
        {
          ok: false,
          reasons: [
            'overrun_hold:llm',
            'not_owner_request',
            'pool_not_routable',
            'not_limit_only',
          ],
          budgetHeld: true,
        },
      );
      const search = await gate.admit(
        textRequest(uuid(4), { service: 'search' }),
      );
      assert.equal(search.ok && search.ticket.pool_id, 'search');
      assert.deepEqual(await gate.holdState(), {
        held: true,
        reasons: [],
        held_pools: [
          { pool_id: 'llm', hold_reasons: ['overrun_review_pending'] },
          { pool_id: 'llm.background', hold_reasons: ['ancestor_held'] },
          // search（40）は受付中の M 40 で上限に達している。
          { pool_id: 'search', hold_reasons: ['limit_reached'] },
        ],
      });
      const reservation = rowOf(harness, uuid(1));
      const reviewed = await harness.store.budget({
        kind: 'budget.review_overrun',
        reservation_id: reservation.reservation_id,
        expected_revision: '1',
        currency: 'XTS',
        actual_gross: '55',
        max_liability: '40',
        now: harness.clock.now(),
        request: null,
      });
      assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
      const after = await gate.admit(textRequest(uuid(5)));
      assert.equal(after.ok, true);
    });
  },
);

test(
  'only a certainly unsent reservation is released: an abort before dispatch and a safety stop at the final check',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate();
      await gate.start();
      const controller = new AbortController();
      controller.abort();
      assert.deepEqual(
        await gate.run(textRequest(uuid(1)), provider.send, {
          signal: controller.signal,
        }),
        { kind: 'released', reasons: ['aborted_before_dispatch'] },
      );
      harness.sql((db) =>
        db.exec(
          "INSERT OR REPLACE INTO safety_breaker (singleton, state, safety_revision, stop_reason, stopped_at) VALUES (1, 'stopped', 1, 'rate_exceeded', 1000)",
        ),
      );
      assert.deepEqual(await gate.run(textRequest(uuid(2)), provider.send), {
        kind: 'released',
        reasons: ['safety_stopped'],
      });
      assert.equal(provider.receipts.length, 0);
      assert.deepEqual(
        rows(harness).map((row) => [row.status, row.dispatch_intent_at]),
        [
          ['released', null],
          ['released', null],
        ],
      );
      // 解放した分は使用量に数えない。
      assert.deepEqual(await poolUsage(harness, '2030-10', 'llm'), {
        settled: '0',
        reserved: '0',
        max: '0',
        unknown: 0,
        holds: [],
      });
      // 送出意図を記録した予約は、送る前に止まっても解放しない（送った可能性がある）。
      harness.sql((db) =>
        db.exec(
          "UPDATE safety_breaker SET state = 'running', stop_reason = NULL, stopped_at = NULL WHERE singleton = 1",
        ),
      );
      const admitted = await gate.admit(textRequest(uuid(3)));
      assert(admitted.ok);
      assert.deepEqual(await gate.dispatch(admitted.ticket), { ok: true });
      assert.deepEqual(await gate.release(admitted.ticket), {
        ok: false,
        reasons: ['possibly_sent'],
      });
    });
  },
);

test(
  'restart reconciliation releases unsent reservations, settles found usage and holds the rest without resending',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const before = harness.gate();
      await before.start();
      // 1: 受け付けただけ（送出意図なし）。2: 送出意図の後に送り、provider は usage を記録したが応答の前に止まった。
      // 3: 送出意図の後に止まった（provider は受信していない。検索の枠）。
      const tickets: BudgetTicket[] = [];
      for (const n of [1, 2, 3]) {
        const admitted = await before.admit(
          textRequest(uuid(n), n === 3 ? { service: 'search' } : {}),
        );
        assert(admitted.ok);
        tickets.push(admitted.ticket);
      }
      for (const ticket of tickets.slice(1))
        assert.deepEqual(await before.dispatch(ticket), { ok: true });
      provider.recordWithoutResponse(
        uuid(2),
        (tickets[1] as BudgetTicket).reservation_id,
        '17',
      );
      await harness.restart();
      const after = harness.gate();
      assert.deepEqual(await after.start(provider.reconciler), {
        released: 1,
        settled: 1,
        usage_unknown: 1,
        failed: 0,
      });
      assert.deepEqual(
        rows(harness).map((row) => [
          row.request_id,
          row.status,
          row.actual_gross,
        ]),
        [
          [uuid(1), 'released', null],
          [uuid(2), 'settled', 17],
          [uuid(3), 'usage_unknown', null],
        ],
      );
      // 照合は provider へ送り直さない。二度目の照合は何もしない。
      assert.equal(provider.receipts.length, 1);
      assert.deepEqual(await after.reconcile(provider.reconciler), {
        released: 0,
        settled: 0,
        usage_unknown: 0,
        failed: 0,
      });
    });
  },
);

test(
  'a voice top-up grows the same row, checks only the added amount and never borrows from the LLM pools',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const gate = harness.gate();
      await gate.start();
      // 会話の最低課金 15 秒 × 1 単位 = 15。
      const admitted = await gate.admit(
        textRequest(uuid(1), {
          service: 'voice',
          price_key: 'synthetic.live',
          quantities: { live_seconds: '15' },
        }),
      );
      assert(admitted.ok);
      assert.deepEqual(
        [
          admitted.ticket.pool_id,
          admitted.ticket.reserved,
          admitted.ticket.max_liability,
          admitted.ticket.revision,
        ],
        ['voice', '15', '15', '1'],
      );
      const grown = await gate.topUp(admitted.ticket, {
        reserved: '15',
        max_liability: '15',
      });
      assert(grown.ok);
      assert.deepEqual(
        [grown.ticket.max_liability, grown.ticket.revision],
        ['30', '2'],
      );
      // 古い版の追加予約は競合。
      assert.deepEqual(
        await gate.topUp(admitted.ticket, {
          reserved: '1',
          max_liability: '1',
        }),
        { ok: false, reasons: ['revision_conflict'] },
      );
      // voice（50）は 30 ＋ 25 = 55 で超える。LLM・検索の枠に空きがあっても融通しない。
      assert.deepEqual(
        await gate.topUp(grown.ticket, { reserved: '25', max_liability: '25' }),
        { ok: false, reasons: ['r_limit:voice', 'm_limit:voice'] },
      );
      const row = rowOf(harness, uuid(1));
      assert.deepEqual(
        [row.max_liability, row.reservation_revision, row.pool_id],
        [30, 2, 'voice'],
      );
    });
  },
);

test(
  'a regressed clock holds paid admission until the owner confirms the month, and the hold state says so',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const gate = harness.gate();
      harness.clock.set(NOV_02);
      await gate.start();
      const events: BudgetResumeEvent[] = [];
      gate.onResumable((event) => events.push(event));
      // 時計が 10 月 15 日へ戻った。
      harness.clock.set(OCT_15);
      assert.deepEqual(await gate.admit(textRequest(uuid(1))), {
        ok: false,
        reasons: ['clock_regressed'],
        budgetHeld: true,
      });
      assert.deepEqual(await gate.holdState(), {
        held: true,
        reasons: ['clock_regressed'],
        held_pools: [],
      });
      const status = await gate.calendarStatus();
      assert.deepEqual(
        [
          status.configured_time_zone,
          status.check?.state?.month,
          status.check?.state?.monthStart,
          status.check?.reasons,
          status.check?.confirmation_revision,
          status.checked_at,
        ],
        [
          'Asia/Tokyo',
          '2030-11',
          '2030-10-31T15:00:00.000Z',
          ['clock_regressed'],
          '0',
          '2030-10-15T00:00:00.000Z',
        ],
      );
      const seen = {
        month: '2030-11',
        month_start: '2030-10-31T15:00:00.000Z',
        revision: '0',
        observed_at: '2030-10-15T00:00:00.000Z',
      };
      // 本人が見た値と違う確かめ直しは記録しない。
      assert.deepEqual(
        await gate.confirmCalendar({ ...seen, reason: 'calendar_mismatch' }),
        { ok: false, reasons: ['nothing_to_confirm'] },
      );
      const confirmed = await gate.confirmCalendar({
        ...seen,
        reason: 'clock_regressed',
      });
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
      assert.deepEqual(events, [{ kind: 'hold_cleared', month: '2030-11' }]);
      // 同じ入力の送り直しは古い入力として拒否する（時計がさらに戻っても承認しない）。
      harness.clock.set(OCT_15 - 86_400_000);
      assert.deepEqual(
        await gate.confirmCalendar({ ...seen, reason: 'clock_regressed' }),
        { ok: false, reasons: ['confirmation_stale'] },
      );
      assert.deepEqual(await gate.admit(textRequest(uuid(3))), {
        ok: false,
        reasons: ['clock_regressed'],
        budgetHeld: true,
      });
      harness.clock.set(OCT_15);
      const admitted = await gate.admit(textRequest(uuid(2)));
      assert.equal(admitted.ok && admitted.ticket.budget_month, '2030-11');
      assert.deepEqual(await gate.holdState(), {
        held: false,
        reasons: [],
        held_pools: [],
      });
    });
  },
);

test(
  'a stored month start that differs from the time zone data holds admission until the owner re-verifies it',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      // 東京の 10 月の始まりより 1 時間遅い記録（古い tz データで作った記録の模擬）。
      harness.sql((db) =>
        db.exec(
          "INSERT INTO budget_months (month, time_zone, month_start, month_start_time_zone, recorded_at) VALUES ('2030-10', 'Asia/Tokyo', 1917014400000, 'Asia/Tokyo', 1917014400000)",
        ),
      );
      const gate = harness.gate();
      await gate.start();
      assert.deepEqual(await gate.admit(textRequest(uuid(1))), {
        ok: false,
        reasons: ['invalid_calendar_state'],
        budgetHeld: true,
      });
      assert.deepEqual((await gate.holdState()).reasons, ['calendar_mismatch']);
      const status = await gate.calendarStatus();
      assert.deepEqual(
        [
          status.check?.recorded_month_start,
          status.check?.recomputed_month_start,
        ],
        ['2030-09-30T16:00:00.000Z', '2030-09-30T15:00:00.000Z'],
      );
      assert.deepEqual(
        await gate.confirmCalendar({
          reason: 'calendar_mismatch',
          month: '2030-10',
          month_start: '2030-09-30T16:00:00.000Z',
          revision: '0',
          observed_at: status.checked_at,
        }),
        { ok: false, reasons: ['confirmation_mismatch'] },
      );
      const confirmed = await gate.confirmCalendar({
        reason: 'calendar_mismatch',
        month: '2030-10',
        month_start: '2030-09-30T15:00:00.000Z',
        revision: '0',
        observed_at: status.checked_at,
      });
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
      assert.equal((await gate.admit(textRequest(uuid(2)))).ok, true);
    });
  },
);

test(
  'without a valid configuration nothing paid is admitted and the hold state is config_invalid',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const gate = harness.gate({
        config: { ok: false, reasons: ['config_missing'] },
      });
      await gate.start();
      const provider = new MockPaidProvider();
      assert.deepEqual(await gate.run(textRequest(uuid(1)), provider.send), {
        kind: 'rejected',
        reasons: ['config_invalid'],
        budgetHeld: true,
      });
      assert.deepEqual(await gate.holdState(), {
        held: true,
        reasons: ['config_invalid'],
        held_pools: [],
      });
      assert.equal(provider.receipts.length, 0);
      assert.equal(rows(harness).length, 0);
      // 経路のない起点・サービス（影モードの音声）も受け付けない。
      const configured = harness.gate();
      assert.deepEqual(
        await configured.admit(
          textRequest(uuid(2), { origin: 'shadow_mode', service: 'voice' }),
        ),
        { ok: false, reasons: ['route_missing'], budgetHeld: false },
      );
      // 単価の版が確認されていない設定（domain の拒否）。
      const unverified = harness.gate({
        config: loadedConfig(
          syntheticConfig((config) => {
            (
              config['budget'] as { verified_price_versions: string[] }
            ).verified_price_versions = ['xts.live.v1'];
          }),
        ),
      });
      assert.deepEqual(await unverified.admit(textRequest(uuid(3))), {
        ok: false,
        reasons: ['price_unverified:xts.text.v1'],
        budgetHeld: false,
      });
    });
  },
);

test(
  'many concurrent requests never leave a reservation above a limit and every provider receipt matches one dispatched reservation',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const requests = [
        ...[1, 2, 3, 4].map((n) =>
          textRequest(uuid(n), { origin: 'autonomous_analysis' }),
        ),
        ...[5, 6, 7, 8].map((n) => textRequest(uuid(n))),
        ...[9, 10].map((n) => textRequest(uuid(n), { service: 'search' })),
      ];
      const gate = harness.gate({
        faults: { beforeAdmit: barrier(requests.length) },
      });
      await gate.start();
      for (const [index, request] of requests.entries())
        provider.plan(
          request.request_id,
          index % 3 === 0
            ? { kind: 'drop', actual: '30' }
            : { kind: 'usage', actual: '30' },
        );
      const results = await Promise.all(
        requests.map((request) => gate.run(request, provider.send)),
      );
      const all = rows(harness);
      // 上限（設定に手で書いた値）: 経路上の各枠で、精算済みは実費、usage 不明は M を数える（M 超過はない）。
      const LIMITS: Record<string, number> = {
        total: 200,
        llm: 100,
        'llm.background': 50,
        search: 40,
      };
      const PATHS: Record<string, readonly string[]> = {
        'llm.background': ['llm.background', 'llm', 'total'],
        llm: ['llm', 'total'],
        search: ['search', 'total'],
      };
      const used = new Map<string, number>();
      for (const row of all) {
        if (row.status === 'released') continue;
        const amount =
          row.status === 'settled'
            ? (row.actual_gross as number)
            : row.max_liability;
        for (const pool of PATHS[row.pool_id] ?? [])
          used.set(pool, (used.get(pool) ?? 0) + amount);
      }
      for (const [pool, amount] of used)
        assert(amount <= (LIMITS[pool] as number), `${pool}: ${amount}`);
      // 受付の時点の M でも上限を超えない（全予約の M の合計）。
      const maxUsed = new Map<string, number>();
      for (const row of all)
        for (const pool of PATHS[row.pool_id] ?? [])
          maxUsed.set(pool, (maxUsed.get(pool) ?? 0) + row.max_liability);
      for (const [pool, amount] of maxUsed)
        assert(amount <= (LIMITS[pool] as number), `M ${pool}: ${amount}`);
      // 受信の記録は、送出意図のある予約と 1 対 1。同じ要求を二度受信しない。
      const received = provider.receipts.map((receipt) => receipt.request_id);
      assert.equal(new Set(received).size, received.length);
      assert.deepEqual(
        [...received].sort(),
        all
          .filter((row) => row.dispatch_intent_at !== null)
          .map((row) => row.request_id)
          .sort(),
      );
      for (const receipt of provider.receipts)
        assert.equal(
          all.find((row) => row.request_id === receipt.request_id)
            ?.reservation_id,
          receipt.reservation_id,
        );
      // 受け付けなかった要求は送っていない。受け付けた数は結果の数と合う。
      const admittedCount = results.filter(
        (result) => result.kind !== 'rejected',
      ).length;
      assert.equal(admittedCount, all.length);
      assert.equal(received.length, all.length);
      // llm（100）に M 40 の受付は多くても 2 件、search（40）は 1 件。
      assert(all.filter((row) => row.pool_id !== 'search').length <= 2);
      assert.equal(all.filter((row) => row.pool_id === 'search').length, 1);
    });
  },
);

test(
  'a reservation whose deadline passed before the dispatch intent is released and never sent (Codex P1)',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate({
        // 受付の後、送出意図の命令の前に応答の期限（受付の時刻 ＋ 60 秒）ちょうどになった。
        faults: {
          beforeDispatch: () => harness.clock.set(OCT_15 + 60_000),
        },
      });
      await gate.start();
      assert.deepEqual(await gate.run(textRequest(uuid(1)), provider.send), {
        kind: 'released',
        reasons: ['reservation_expired'],
      });
      assert.equal(provider.receipts.length, 0);
      assert.deepEqual(
        rows(harness).map((row) => [row.status, row.dispatch_intent_at]),
        [['released', null]],
      );
    });
  },
);

test(
  'a deadline or an abort while the dispatch intent is being recorded stops the send and holds R and M (Codex P1・P2)',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const controller = new AbortController();
      let step = 0;
      const gate = harness.gate({
        faults: {
          afterDispatch: () => {
            step += 1;
            // 1 件目: 送出意図の記録を待つ間に期限を過ぎた。2 件目: 待つ間に呼び出し側が中断した。
            if (step === 1) harness.clock.set(OCT_15 + 60_000);
            else controller.abort();
          },
        },
      });
      await gate.start();
      assert.deepEqual(await gate.run(textRequest(uuid(1)), provider.send), {
        kind: 'usage_unknown',
        ticket: (await reservationTicket(harness, uuid(1))) as BudgetTicket,
        reasons: ['reservation_expired', 'not_sent'],
      });
      harness.clock.set(OCT_15);
      const second = await gate.run(textRequest(uuid(2)), provider.send, {
        signal: controller.signal,
      });
      assert.deepEqual(
        second.kind === 'usage_unknown' ? second.reasons : second,
        ['discarded', 'not_sent'],
      );
      // provider へは送っていない。送出意図を記録したので解放せず、usage 不明として R と M を保持する。
      assert.equal(provider.receipts.length, 0);
      assert.deepEqual(
        rows(harness).map((row) => [
          row.request_id,
          row.status,
          row.max_liability,
          row.dispatch_intent_at !== null,
        ]),
        [
          [uuid(1), 'usage_unknown', 40, true],
          [uuid(2), 'usage_unknown', 40, true],
        ],
      );
    });
  },
);

// 期限を過ぎた例の ticket（受付の時刻 OCT_15 と期限 60 秒から手で決めた値と、DB の予約の ID）。
async function reservationTicket(
  harness: BudgetHarness,
  requestId: string,
): Promise<BudgetTicket | null> {
  const found = await harness.store.budget({
    kind: 'budget.reservation_find',
    reservation_id: null,
    request_id: requestId,
  });
  if (!found.ok || found.value === null) return null;
  return {
    reservation_id: found.value.reservationId,
    request_id: requestId,
    pool_id: 'llm',
    budget_month: '2030-10',
    price_version: 'xts.text.v1',
    reserved: '40',
    max_liability: '40',
    revision: '1',
    routed: false,
    deadline: OCT_15 + 60_000,
    credit_expires_at: null,
  };
}

test(
  'the final deadline check is the last step before send: a clock that moves after the first reading never sends past the deadline (Codex re-check P1)',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const timers = new ManualTimers();
      // 送出意図の記録の後に読む時計の値を、読む順に手で決める（1 回目は準備の前、2 回目は send の直前）。
      let readings: number[] = [];
      const now = (): number =>
        readings.length > 0
          ? (readings.shift() as number)
          : harness.clock.now();
      const deadline = OCT_15 + 60_000;
      const gateWith = (values: readonly number[]) =>
        harness.gate({
          now,
          timers,
          faults: {
            afterDispatch: () => {
              readings = [...values];
            },
          },
        });
      const first = gateWith([deadline - 2, deadline - 1]);
      await first.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '30' });
      // 準備の前の読み（残り 2 ミリ秒）で timer を決め、send の直前の読み（残り 1 ミリ秒）で送る。
      assert.equal(
        (await first.run(textRequest(uuid(1)), provider.send)).kind,
        'settled',
      );
      assert.deepEqual(timers.delays, [2]);
      assert.equal(provider.receipts.length, 1);
      // 準備の前は期限の 1 ミリ秒前でも、send の直前の読みが期限ちょうどなら送らない。準備（timer）を外す。
      const second = await gateWith([deadline - 1, deadline]).run(
        textRequest(uuid(2)),
        provider.send,
      );
      assert.deepEqual(
        second.kind === 'usage_unknown' ? second.reasons : second,
        ['reservation_expired', 'not_sent'],
      );
      assert.deepEqual(timers.delays, [2, 1]);
      assert.equal(timers.size, 0);
      assert.equal(provider.receipts.length, 1);
      assert.equal(rowOf(harness, uuid(2)).status, 'usage_unknown');
    });
  },
);

test(
  'a clock that reaches the deadline, a caller abort or a timer that fires at once during the preparation stops the send (Codex re-check P1・P3)',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const timers = new ManualTimers();
      const deadline = OCT_15 + 60_000;
      const gate = harness.gate({ timers });
      await gate.start();
      // 1: timer を用意する途中で時計が期限に達した（検索の枠）。
      timers.onSet = () => harness.clock.set(deadline);
      const reached = await gate.run(
        textRequest(uuid(1), { service: 'search' }),
        provider.send,
      );
      assert.deepEqual(
        reached.kind === 'usage_unknown' ? reached.reasons : reached,
        ['reservation_expired', 'not_sent'],
      );
      harness.clock.set(OCT_15);
      // 2: 準備の途中で呼び出し側が中断した（本人の依頼の LLM の枠）。
      const controller = new AbortController();
      timers.onSet = () => controller.abort();
      const aborted = await gate.run(textRequest(uuid(2)), provider.send, {
        signal: controller.signal,
      });
      assert.deepEqual(
        aborted.kind === 'usage_unknown' ? aborted.reasons : aborted,
        ['discarded', 'not_sent'],
      );
      // 3: timer が用意した時点ですぐ発火した（自発の解析の枠）。
      timers.onSet = (fire) => fire();
      const fired = await gate.run(
        textRequest(uuid(3), { origin: 'autonomous_analysis' }),
        provider.send,
      );
      assert.deepEqual(fired.kind === 'usage_unknown' ? fired.reasons : fired, [
        'reservation_expired',
        'not_sent',
      ]);
      // どれも provider へ送らず、準備を外し、送出意図を記録した予約は R と M を保持する。
      assert.equal(provider.receipts.length, 0);
      assert.equal(timers.size, 0);
      assert.deepEqual(
        rows(harness).map((row) => [
          row.request_id,
          row.status,
          row.max_liability,
          row.dispatch_intent_at !== null,
        ]),
        [
          [uuid(1), 'usage_unknown', 40, true],
          [uuid(2), 'usage_unknown', 40, true],
          [uuid(3), 'usage_unknown', 40, true],
        ],
      );
    });
  },
);

test(
  '会話（Live）の単価の系列は、live_seconds の単価がある系列がちょうど 1 つあるときだけ決まる（ADR 0049）',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      assert.equal(
        harness.gate({ config: loadedConfig() }).livePriceKey(),
        'synthetic.live',
      );
      // live_seconds の単価がなければ決まらない（会話の系列の単価を別の区分へ変える）。
      const none = loadedConfig(
        syntheticConfig((config) => {
          for (const price of config['price_versions'] as {
            rates: { category: string }[];
          }[])
            for (const rate of price.rates)
              if (rate.category === 'live_seconds')
                rate.category = 'search_requests';
        }),
      );
      assert.equal(harness.gate({ config: none }).livePriceKey(), null);
      // 別の系列にも live_seconds の単価があれば、どちらか決められないので決まらない。
      const two = loadedConfig(
        syntheticConfig((config) => {
          const prices = config['price_versions'] as Record<string, unknown>[];
          const live = prices.find(
            (price) => price['price_key'] === 'synthetic.live',
          );
          prices.push({
            ...(live as Record<string, unknown>),
            price_version: 'xts.live2.v1',
            price_key: 'synthetic.secondary',
          });
          (
            config['budget'] as { verified_price_versions: string[] }
          ).verified_price_versions.push('xts.live2.v1');
        }),
      );
      assert.equal(harness.gate({ config: two }).livePriceKey(), null);
      // 券は保存済みの予約から作り直せて、会話の秒数は券の版の単価で金額になる。
      const gate = harness.gate({ config: loadedConfig() });
      await gate.start();
      const admitted = await gate.admit(
        textRequest(uuid(1), {
          service: 'voice',
          price_key: 'synthetic.live',
          quantities: { live_seconds: '15' },
        }),
      );
      assert(admitted.ok);
      const rebuilt = await gate.ticketOf(admitted.ticket.reservation_id);
      assert(rebuilt !== null && rebuilt !== 'unavailable');
      assert.deepEqual(
        [rebuilt.price_version, rebuilt.reserved, rebuilt.revision],
        ['xts.live.v1', '15', '1'],
      );
      assert.deepEqual(gate.liveSecondsAmount(rebuilt, 60, 'increment'), {
        ok: true,
        amount: '60',
      });
      assert.deepEqual(gate.liveSecondsAmount(rebuilt, 5, 'actual'), {
        ok: true,
        amount: '15',
      });
      assert.equal(await gate.ticketOf(uuid(0x99)), null);
    });
  },
);
