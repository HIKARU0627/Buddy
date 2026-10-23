// 予算の門の常設の回帰試験（B07-03 の Codex のレビュー P3、ADR 0036・0037）。
// 1. 精算済みの予約が残る枠を設定から消すと、その月の受付を止める（reservation_pool_unknown）。
// 2. 前の月の M 超過は、本人が確認するまで今月の受付も止める。確認の後は受け付ける。
// 3. 承認済みの超過枠の承認があっても、本人の依頼でない・許可リストにない枠からは超過枠へ回さない（迂回の拒否）。
// 期待値（理由・件数・枠）は合成の設定（XTS、M = 40）から手で書いた値。模擬の試験だけで、実 API・実請求は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MockPaidProvider,
  NOV_02,
  loadedConfig,
  syntheticConfig,
  textRequest,
  uuid,
  withBudgetStore,
} from './budget-test-support.js';

const TIMEOUT = { timeout: 60_000 };

test(
  'P3: a settled reservation left in a pool removed from the settings holds the month until the pool is restored',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const before = harness.gate();
      await before.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '20' });
      assert.equal(
        (
          await before.run(
            textRequest(uuid(1), { service: 'search' }),
            provider.send,
          )
        ).kind,
        'settled',
      );
      // 検索の枠を設定から消した（経路も null にした有効な設定）。
      const removed = loadedConfig(
        syntheticConfig((config) => {
          const budget = config['budget'] as {
            pools: { pool_id: string }[];
          };
          budget.pools = budget.pools.filter(
            (pool) => pool.pool_id !== 'search',
          );
          const routing = config['routing'] as {
            routes: Record<string, { search: string | null }>;
          };
          for (const routes of Object.values(routing.routes))
            routes.search = null;
        }),
      );
      const after = harness.gate({ config: removed });
      await after.start();
      // 消えた枠の精算済み 20 を親（total）に数えられないので、どの枠の受付も止める。
      assert.deepEqual(await after.admit(textRequest(uuid(2))), {
        ok: false,
        reasons: ['reservation_pool_unknown', 'not_limit_only'],
        budgetHeld: true,
      });
      assert.deepEqual(await after.holdState(), {
        held: true,
        reasons: ['reservation_pool_unknown'],
        held_pools: [],
      });
      // 本人が枠を戻すと受付が戻る。
      const restored = harness.gate();
      assert.equal((await restored.admit(textRequest(uuid(3)))).ok, true);
    });
  },
);

test(
  'P3: an overrun in the previous month holds the pool in the current month until the owner reviews it',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const gate = harness.gate();
      await gate.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '55' });
      const result = await gate.run(textRequest(uuid(1)), provider.send);
      assert.equal(result.kind === 'settled' && result.overrun, true);
      harness.clock.set(NOV_02);
      await gate.tick();
      // 11 月の llm は使用 0 でも、10 月の M 超過の確認待ちで止まる（子の llm.background も）。
      assert.deepEqual(await gate.admit(textRequest(uuid(2))), {
        ok: false,
        reasons: ['overrun_hold:llm', 'not_limit_only'],
        budgetHeld: true,
      });
      assert.deepEqual(await gate.holdState(), {
        held: true,
        reasons: [],
        held_pools: [
          { pool_id: 'llm', hold_reasons: ['overrun_review_pending'] },
          { pool_id: 'llm.background', hold_reasons: ['ancestor_held'] },
        ],
      });
      const reservation = await harness.store.budget({
        kind: 'budget.reservation_find',
        reservation_id: null,
        request_id: uuid(1),
      });
      assert(reservation.ok && reservation.value !== null);
      assert.equal(reservation.value.budgetMonth, '2030-10');
      const reviewed = await harness.store.budget({
        kind: 'budget.review_overrun',
        reservation_id: reservation.value.reservationId,
        expected_revision: reservation.value.revision,
        currency: 'XTS',
        actual_gross: '55',
        max_liability: '40',
        now: harness.clock.now(),
        request: null,
      });
      assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
      const admitted = await gate.admit(textRequest(uuid(3)));
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
  'P3: an approved overage approval is not a detour for autonomous work or for pools outside the allow list',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const gate = harness.gate();
      await gate.start();
      // llm（100）を本人の依頼 2 件（M 40 ＋ 40）で埋める。
      for (const n of [1, 2])
        assert.equal((await gate.admit(textRequest(uuid(n)))).ok, true);
      const target = uuid(10);
      const approvalId = uuid(20);
      const now = harness.clock.now();
      const requested = await harness.store.budget({
        kind: 'budget.request_overage',
        approval_id: approvalId,
        request_id: target,
        pool_id: 'overage',
        budget_month: '2030-10',
        currency: 'XTS',
        max_liability: '40',
        overage_remaining: '60',
        now,
        expires_at: now + 3_600_000,
      });
      assert.equal(requested.ok, true, JSON.stringify(requested));
      const approved = await harness.store.budget({
        kind: 'budget.approve_overage',
        approval_id: approvalId,
        budget_request_id: target,
        currency: 'XTS',
        max_liability: '40',
        decision: 'approve',
        now: now + 1,
        request: null,
      });
      assert.equal(approved.ok, true, JSON.stringify(approved));
      harness.clock.set(now + 2);
      // 同じ request_id の自発の解析（llm.background）は、承認済みでも超過枠へ回さない。
      assert.deepEqual(
        await gate.admit(
          textRequest(target, { origin: 'autonomous_analysis' }),
        ),
        {
          ok: false,
          reasons: [
            'r_limit:llm',
            'm_limit:llm',
            'not_owner_request',
            'pool_not_routable',
          ],
          budgetHeld: true,
        },
      );
      const unused = await harness.store.budget({
        kind: 'budget.approval_find',
        approval_id: approvalId,
      });
      assert.equal(unused.ok && unused.value?.approval.status, 'approved');
      // 承認のない本人の依頼は超過枠へ回さない（承認が要る）。
      assert.deepEqual(await gate.admit(textRequest(uuid(11))), {
        ok: false,
        reasons: ['r_limit:llm', 'm_limit:llm', 'approval_required'],
        budgetHeld: true,
      });
      // 承認した request_id と M の本人の依頼だけが超過枠で受け付けられ、承認は使用済みになる。
      const routed = await gate.admit(textRequest(target));
      assert.deepEqual(
        routed.ok ? [routed.ticket.pool_id, routed.ticket.routed] : routed,
        ['overage', true],
      );
      const consumed = await harness.store.budget({
        kind: 'budget.approval_find',
        approval_id: approvalId,
      });
      assert.equal(consumed.ok && consumed.value?.approval.status, 'consumed');
    });
  },
);
