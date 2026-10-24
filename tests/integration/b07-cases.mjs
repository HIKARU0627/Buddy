// B07 の統合のケース。予算の門（apps/core の BudgetGate）・DB worker（一時ディレクトリの DB）・模擬の有料 provider を
// つないで実行し、予約の行（SQL で直接読む）と provider の受信の記録・真の usage を突き合わせる。
// 期待値は b07-expectations.json の手書きの値（合成の通貨 XTS、縮めた上限、M = 入力 10 + 出力の上限 30 = 40）。
// 待ち合わせは関門（barrier）・受信の知らせ・手で発火する timer と手で進める時計で行い、固定の sleep を使わない。
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLEAN,
  CLEAN_CREDIT,
  Labels,
  ManualTimers,
  MemoryCreditSource,
  MockPaidProvider,
  OCT_15,
  TOKYO_NOV_START,
  admitAndSend,
  approvalRows,
  assertPoolTable,
  barrier,
  checkBudgetConfigText,
  claudeRequest,
  counterIds,
  createApiContract,
  creditConfig,
  creditFindings,
  creditObservation,
  currentMonth,
  findings,
  live,
  loadBudgetConfig,
  loadedConfig,
  owner,
  providerTruth,
  reservationRows,
  shuffled,
  sized,
  specification,
  statusSummary,
  syntheticConfig,
  textRequest,
  usage,
  uuid,
  waveMaxOverLimit,
  withBudgetStore,
} from './b07-support.mjs';

const HOUR = 3_600_000;
const BASE = Date.parse('2030-10-15T00:00:00.000Z');
// クレジットの周期（B07-07）。周期 2030-10-01 は 2030-11-01T00:00:00Z まで。予算月（東京）の境目 2030-10-31T15:00Z とは別。
const CYCLE_OCT = 'anthropic:2030-10-01';
const CYCLE_NOV = 'anthropic:2030-11-01';
const CYCLE_END = Date.parse('2030-11-01T00:00:00.000Z');

// 結果の正規化（金額・ID・時刻の乱数を含めず、手書きの期待値と同じ形にする）。
function outcome(result) {
  switch (result.kind) {
    case 'rejected':
      return {
        kind: 'rejected',
        reasons: [...result.reasons],
        budget_held: result.budgetHeld,
      };
    case 'released':
      return { kind: 'released', reasons: [...result.reasons] };
    case 'usage_unknown':
      return { kind: 'usage_unknown', reasons: [...result.reasons] };
    case 'settled':
      return {
        kind: 'settled',
        pool: result.ticket.pool_id,
        month: result.ticket.budget_month,
        routed: result.ticket.routed,
        overrun: result.overrun,
      };
    default:
      throw new Error(`unexpected result ${JSON.stringify(result)}`);
  }
}

function admission(result) {
  return result.ok
    ? {
        ok: true,
        pool: result.ticket.pool_id,
        month: result.ticket.budget_month,
        reserved: result.ticket.reserved,
        max: result.ticket.max_liability,
        routed: result.ticket.routed,
      }
    : {
        ok: false,
        reasons: [...result.reasons],
        budget_held: result.budgetHeld,
      };
}

// 1 つの試験の世界（一時 DB・DB worker・模擬 provider・手で進める時計）。終わりに予約の行と provider の記録を突き合わせる。
async function world(ctx, options, body) {
  let checked;
  await withBudgetStore(
    async (harness) => {
      const env = {
        harness,
        provider: new MockPaidProvider(),
        labels: new Labels(),
        newId: counterIds(),
        pools: specification.pools,
        gate: (gateOptions = {}) =>
          harness.gate({ newId: env.newId, ...gateOptions }),
        // クレジットの設定（B07-07）と、観測の口（メモリ）をつけた門。
        creditGate: (source, gateOptions = {}) =>
          harness.gate({
            newId: env.newId,
            config: loadedConfig(creditConfig()),
            creditObservations: source,
            ...gateOptions,
          }),
      };
      const bodyChecked = await body(env);
      await env.settled?.();
      assert.equal(
        String(harness.store.schemaVersion),
        specification.db_version,
        '手書きの DB の版',
      );
      const rows = reservationRows(harness);
      const approvals = approvalRows(harness);
      const truth = await providerTruth(env.provider, rows);
      const found = findings({
        rows,
        receipts: env.provider.receipts,
        truth,
        pools: env.pools,
      });
      assert.deepEqual(found, CLEAN, '予約の行と provider の記録の不一致');
      // クレジットの区分の突き合わせ（B07-07）。クレジットを使わない世界では、すべての行にクレジットがない。
      assert.deepEqual(
        creditFindings({ rows, cap: options.creditCap }),
        CLEAN_CREDIT,
        'クレジットの区分の不一致',
      );
      if (options.wave)
        assert.deepEqual(
          waveMaxOverLimit({ rows, pools: env.pools }),
          [],
          '同時の受付の M の合計が上限を超えた',
        );
      const ledger = {
        final_state: statusSummary(rows),
        provider_requests: env.provider.receipts.length,
        provider_state_changes: [...truth.values()].filter((v) => v !== null)
          .length,
        approvals: approvals.length,
        findings: found,
      };
      ctx.ledgers.push({
        ...ledger,
        rows: rows.map((row) => ({
          request: env.labels.label(row.request_id),
          status: row.status,
          pool: row.pool_id,
          month: row.budget_month,
          reserved: row.reserved,
          max: row.max_liability,
          actual: row.actual_gross,
          dispatched: row.dispatched,
        })),
        receipts: env.provider.receipts.map((receipt) =>
          env.labels.label(receipt.request_id),
        ),
      });
      checked = { ...bodyChecked, ledger };
    },
    { start: options.start ?? OCT_15 },
  );
  return checked;
}

// 予算月・枠ごとの精算済みの実費の合計（行から直接足す。summary を通さない）。
const settledTotal = (harness, month, pool) =>
  reservationRows(harness)
    .filter(
      (row) =>
        row.status === 'settled' &&
        row.budget_month === month &&
        row.pool_id === pool,
    )
    .reduce((sum, row) => sum + BigInt(row.actual_gross), 0n)
    .toString();

// クレジットの区分を含む予約の行（精算済みは実費・クレジット・追加の支出、周期）。
const creditRowsView = (env) =>
  reservationRows(env.harness).map((row) => [
    env.labels.label(row.request_id),
    row.status,
    row.budget_month,
    row.actual_gross,
    row.credit_applied,
    row.additional_spend,
    row.credit_cycle_id,
  ]);

// 本人が見るクレジットの状態（予算の通貨の百万分の一）。
const creditView = (status) => ({
  cycle: status.cycle_id,
  status: status.status,
  balance: status.balance,
  allocated_since: status.allocated_since,
  outstanding: status.outstanding,
  available: status.available,
  hold: status.hold,
});

const rowsView = (env) =>
  reservationRows(env.harness).map((row) => [
    env.labels.label(row.request_id),
    row.status,
    row.pool_id,
    row.budget_month,
    row.max_liability,
    row.actual_gross,
  ]);

async function requestApproval(env, label, maxLiability, options = {}) {
  const now = env.harness.clock.now();
  const approvalId = options.approvalId;
  const requested = await env.harness.store.budget({
    kind: 'budget.request_overage',
    approval_id: approvalId,
    request_id: env.labels.id(label),
    pool_id: 'overage',
    budget_month: '2030-10',
    currency: 'XTS',
    max_liability: maxLiability,
    overage_remaining: '60',
    now,
    expires_at: now + (options.lifetime ?? HOUR),
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  return now;
}

async function decide(env, approvalId, label, maxLiability, decision, at) {
  return env.harness.store.budget({
    kind: 'budget.approve_overage',
    approval_id: approvalId,
    budget_request_id: env.labels.id(label),
    currency: 'XTS',
    max_liability: maxLiability,
    decision,
    now: at,
    request: null,
  });
}

// llm（100）を 40 + 40 + 20 の精算で埋める（M 40・40・20、実費 = M）。
async function fillLlm(env, gate, names) {
  const [a, b, c] = names;
  for (const [label, request, actual] of [
    [a, (id) => owner(id), '40'],
    [b, (id) => owner(id), '40'],
    [c, (id) => sized(id, 10, 10), '20'],
  ]) {
    const id = env.labels.id(label);
    env.provider.plan(id, { kind: 'usage', actual });
    const result = await gate.run(request(id), env.provider.send);
    assert.equal(result.kind, 'settled', label);
  }
}

export const cases = {
  // X18: 境界で同時の予約。上限ちょうどまでは受け付け、1 つでも超える予約は受け付けない。
  async 'X18-boundary-concurrency'(ctx) {
    // 競合の勝ち負けは受付の命令の並びで決まる。c → d と d → c の両方の投入順を明示して実行する。
    const race = (order) =>
      world(ctx, { wave: false }, async (env) => {
        const { provider, labels } = env;
        const gate = env.gate();
        await gate.start();
        const serial = [];
        for (const label of ['a', 'b']) {
          provider.plan(labels.id(label), { kind: 'usage', actual: '30' });
          serial.push(
            (await gate.run(owner(labels.id(label)), provider.send)).kind,
          );
        }
        // llm の使用は精算の 30 + 30 = 60。M 40 の要求 2 つを関門でそろえて同時に受付へ送る。
        const racing = env.gate({ faults: { beforeAdmit: barrier(2) } });
        for (const label of order)
          provider.plan(labels.id(label), { kind: 'usage', actual: '40' });
        const results = (
          await Promise.all(
            order.map((label) =>
              racing.run(owner(labels.id(label)), provider.send),
            ),
          )
        ).map(outcome);
        const rejected = results.filter((r) => r.kind === 'rejected');
        const settled = results.filter((r) => r.kind === 'settled');
        const over = await gate.run(sized(labels.id('e'), 1, 0), provider.send);
        return {
          submitted_order: order,
          serial,
          concurrent: {
            settled: settled.length,
            rejected: rejected.map((r) => ({
              reasons: r.reasons,
              budget_held: r.budget_held,
            })),
          },
          one_unit_over: outcome(over),
          llm: await usage(env.harness, '2030-10', 'llm'),
          rows: rowsView(env).filter((row) => row[0] !== 'c' && row[0] !== 'd'),
        };
      });
    return {
      c_then_d: await race(['c', 'd']),
      d_then_c: await race(['d', 'c']),
    };
  },

  // X18: 超過枠の同時の予約。承認済みの 2 つの依頼が同時に来ても、超過枠の上限（60）を超える予約は 1 件もできない。
  async 'X18-overage-concurrency'(ctx) {
    return world(ctx, { wave: true }, async (env) => {
      const { provider, labels } = env;
      const gate = env.gate();
      await gate.start();
      await fillLlm(env, gate, ['a', 'b', 'c']);
      // 承認は 1 つの request_id と M（40）に固定する。d・e・g（自発）に承認を出す。f は承認なし。
      for (const [index, label] of ['d', 'e', 'g'].entries()) {
        const approvalId = uuid(900 + index);
        const now = await requestApproval(env, label, '40', { approvalId });
        const decided = await decide(
          env,
          approvalId,
          label,
          '40',
          'approve',
          now + 1,
        );
        assert.equal(decided.ok, true, JSON.stringify(decided));
      }
      env.harness.clock.set(BASE + 2);
      const racing = env.gate({ faults: { beforeAdmit: barrier(4) } });
      const requests = {
        d: owner(labels.id('d')),
        e: owner(labels.id('e')),
        f: owner(labels.id('f')),
        g: owner(labels.id('g'), { origin: 'autonomous_analysis' }),
      };
      for (const label of ['d', 'e'])
        provider.plan(labels.id(label), { kind: 'usage', actual: '35' });
      const order = shuffled(Object.keys(requests), ctx.seed);
      const results = new Map();
      await Promise.all(
        order.map(async (label) =>
          results.set(
            label,
            outcome(await racing.run(requests[label], provider.send)),
          ),
        ),
      );
      const pair = ['d', 'e'].map((label) => results.get(label));
      const winners = pair.filter((r) => r.kind === 'settled');
      const losers = pair.filter((r) => r.kind === 'rejected');
      const approvals = approvalRows(env.harness);
      return {
        approved_pair: {
          settled: winners.map((r) => ({
            pool: r.pool,
            routed: r.routed,
            overrun: r.overrun,
          })),
          rejected: losers.map((r) => r.reasons),
        },
        no_approval: results.get('f'),
        autonomous_with_approval: results.get('g'),
        approval_statuses: approvals.map((a) => a.status).sort(),
        overage: await usage(env.harness, '2030-10', 'overage'),
        llm: await usage(env.harness, '2030-10', 'llm'),
        overage_rows: rowsView(env).filter((row) => row[2] === 'overage')
          .length,
      };
    });
  },

  // X18・同時予約: LLM・検索・音声の 11 件を関門で同時に受付へ送る。枠ごとの受付の数は上限で決まり、順序で変わらない。
  async 'X18-pools-concurrency'(ctx) {
    return world(ctx, { wave: true }, async (env) => {
      const { provider, labels } = env;
      const requests = [
        ...[1, 2, 3, 4, 5].map((n) => ['llm', `l${n}`]),
        ...[1, 2, 3].map((n) => ['search', `s${n}`]),
        ...[1, 2, 3].map((n) => ['voice', `v${n}`]),
      ];
      const build = ([group, label]) => {
        const id = labels.id(label);
        if (group === 'llm') return owner(id);
        if (group === 'search') return owner(id, { service: 'search' });
        return live(id, 30);
      };
      const order = shuffled(requests, ctx.seed);
      const gate = env.gate({ faults: { beforeAdmit: barrier(order.length) } });
      await gate.start();
      // 枠ごとに失敗の形を決める（誰が受け付けられるかは順序で変わるので、受け付けた数ごとの状態は枠で決まる）。
      for (const [group, label] of order)
        provider.plan(
          labels.id(label),
          group === 'llm'
            ? { kind: 'drop', actual: '20' }
            : { kind: 'usage', actual: '25' },
        );
      const results = await Promise.all(
        order.map(async (entry) => [
          entry,
          await gate.run(build(entry), provider.send),
        ]),
      );
      const admitted = { llm: 0, search: 0, voice: 0 };
      const reasons = { llm: new Set(), search: new Set(), voice: new Set() };
      let agreement = true;
      for (const [[group, label], result] of results) {
        if (result.kind === 'rejected')
          reasons[group].add(JSON.stringify(result.reasons));
        else admitted[group] += 1;
        const row = reservationRows(env.harness).find(
          (r) => r.request_id === labels.id(label),
        );
        if (result.kind === 'rejected') agreement &&= row === undefined;
        else agreement &&= row?.status === result.kind;
      }
      const rows = reservationRows(env.harness);
      return {
        admitted,
        rejected_reasons: Object.fromEntries(
          Object.entries(reasons).map(([group, set]) => [
            group,
            [...set].map((text) => JSON.parse(text)),
          ]),
        ),
        max_liability_sorted: rows
          .map((row) => Number(row.max_liability))
          .sort((x, y) => x - y),
        row_states_follow_results: agreement,
        only_settled_or_unknown: rows.every(
          (row) => row.status === 'settled' || row.status === 'usage_unknown',
        ),
      };
    });
  },

  // QA42: 受付は M で判定する。R が収まっても M が上限を超える要求は受け付けず、上限ちょうどは受け付ける。
  async 'QA42-admission-by-m'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels } = env;
      const gate = env.gate({ p95ProfileIds: ['intent.synthetic.v1'] });
      await gate.start();
      // a: 応答を失う（provider の真の usage は 10 だが分からない）。M 40 を保持する。b: 精算 30。
      provider.plan(labels.id('a'), { kind: 'drop', actual: '10' });
      provider.plan(labels.id('b'), { kind: 'usage', actual: '30' });
      const a = await gate.run(owner(labels.id('a')), provider.send);
      const b = await gate.run(owner(labels.id('b')), provider.send);
      // 使用は 精算 30 + 保持 40 = 70。p95 で R = 22 の要求は R なら収まる（92）が M = 40 は収まらない（110）。
      const p95 = await gate.run(
        owner(labels.id('c'), {
          p95: {
            profileId: 'intent.synthetic.v1',
            profileRevision: '1',
            outputP95Tokens: '10',
          },
        }),
        provider.send,
      );
      const plain = await gate.run(owner(labels.id('c2')), provider.send);
      // M = 30 は 70 + 30 = 100 で上限ちょうど。
      provider.plan(labels.id('d'), { kind: 'usage', actual: '20' });
      const exact = await gate.run(
        sized(labels.id('d'), 10, 20),
        provider.send,
      );
      // p95 の予約は R < M で行に残る（入力 3・出力の上限 6 で M = 9、p95 2 → 3 で R = 6）。使用は 50 + 40 = 90。
      const small = await gate.admit(
        sized(labels.id('e'), 3, 6, {
          p95: {
            profileId: 'intent.synthetic.v1',
            profileRevision: '1',
            outputP95Tokens: '2',
          },
        }),
      );
      return {
        lost_response: outcome(a),
        settled_30: outcome(b),
        r_fits_but_m_does_not: outcome(p95),
        plain_over: outcome(plain),
        exactly_at_limit: outcome(exact),
        p95_reservation: admission(small),
        llm: await usage(env.harness, '2030-10', 'llm'),
      };
    });
  },

  // QA42: usage の重複と欠落。同じ usage の重複は一度だけ数え、違う値と別の照合 ID は競合。欠落は M を保持して自動で送り直さない。
  async 'QA42-usage-duplicate-missing'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels } = env;
      const gate = env.gate();
      await gate.start();
      provider.plan(labels.id('a'), { kind: 'usage', actual: '20' });
      const a = await gate.run(owner(labels.id('a')), provider.send);
      assert.equal(a.kind, 'settled');
      const usageA = {
        kind: 'usage',
        provider: 'mockpaid',
        reconciliation_id: `rcpt-${labels.id('a')}`,
        actual_gross: '20',
      };
      const duplicate = await gate.settle(a.ticket, usageA);
      const differentAmount = await gate.settle(a.ticket, {
        ...usageA,
        actual_gross: '21',
      });
      const differentId = await gate.settle(a.ticket, {
        ...usageA,
        reconciliation_id: 'rcpt-other',
      });
      // b: 応答を失う（provider の真の usage は 12）。M を保持する。同じ request_id は受け付けず、provider へ送り直さない。
      provider.plan(labels.id('b'), { kind: 'drop', actual: '12' });
      const b = await gate.run(owner(labels.id('b')), provider.send);
      const afterLoss = await usage(env.harness, '2030-10', 'llm');
      const resend = await gate.run(owner(labels.id('b')), provider.send);
      const receiptsAfterResend = provider.receipts.length;
      // 遅れて分かった usage は、usage 不明の予約を精算する（一度だけ）。
      assert.equal(b.kind, 'usage_unknown');
      const late = await provider.reconciler.lookup({
        request_id: labels.id('b'),
        reservation_id: b.ticket.reservation_id,
      });
      const lateSettle = await gate.settle(b.ticket, late);
      const lateAgain = await gate.settle(b.ticket, late);
      // c: provider が usage を記録しないまま失敗（欠落）。実費は不明のまま M を保持し続ける。
      provider.plan(labels.id('c'), { kind: 'throw' });
      const c = await gate.run(owner(labels.id('c')), provider.send);
      return {
        settled_20: outcome(a),
        duplicate_same_usage: duplicate,
        different_amount: differentAmount,
        different_reconciliation_id: differentId,
        lost_response: outcome(b),
        after_loss: afterLoss,
        resend_same_request: outcome(resend),
        receipts_after_resend: receiptsAfterResend,
        late_settle: lateSettle,
        late_settle_again: lateAgain,
        missing_usage: outcome(c),
        llm: await usage(env.harness, '2030-10', 'llm'),
      };
    });
  },

  // QA42: timeout と結果の破棄。待つのをやめて usage 不明で M を保持し、送り直さない。遅れて届いた usage は元の月に精算する。
  async 'QA42-timeout-discard'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const timers = new ManualTimers();
      const gate = env.gate({ timers });
      await gate.start();
      const events = [];
      gate.onResumable((event) => events.push(event));
      env.settled = () => gate.idle();
      provider.plan(labels.id('a'), { kind: 'hold' });
      const running = gate.run(owner(labels.id('a')), provider.send);
      await provider.received(labels.id('a'));
      timers.fireAll();
      const a = await running;
      provider.plan(labels.id('b'), { kind: 'hold' });
      const abort = new AbortController();
      const discarding = gate.run(owner(labels.id('b')), provider.send, {
        signal: abort.signal,
      });
      await provider.received(labels.id('b'));
      abort.abort();
      const b = await discarding;
      const delays = [...timers.delays];
      const held = await usage(harness, '2030-10', 'llm');
      const resend = await gate.run(owner(labels.id('a')), provider.send);
      const receiptsAfterResend = provider.receipts.length;
      // 月が替わってから usage が届く。精算は元の月（10 月）で、新しい月には数えない。
      harness.clock.set(TOKYO_NOV_START);
      await gate.tick();
      provider.deliver(labels.id('a'), '25');
      provider.deliver(labels.id('b'), '30');
      await gate.idle();
      const c = await gate.run(owner(labels.id('c')), provider.send);
      return {
        timeout: outcome(a),
        discarded: outcome(b),
        timer_delays_ms: delays,
        held_after_both: held,
        resend_same_request: outcome(resend),
        receipts_after_resend: receiptsAfterResend,
        month_events: events,
        late_usage_rows: rowsView(env).filter((row) => row[0] !== 'c'),
        october_settled_total: settledTotal(harness, '2030-10', 'llm'),
        november_request: outcome(c),
        november: await usage(harness, '2030-11', 'llm'),
      };
    });
  },

  // QA42: 月替わり。境目の 1 ミリ秒前は元の月、ちょうどで新しい月。前の月の usage 不明は今月に数えず、
  // 手での精算は元の月・元の枠に一度だけ行う。
  async 'QA42-month-rollover'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      const events = [];
      gate.onResumable((event) => events.push(event));
      provider.plan(labels.id('a'), { kind: 'usage', actual: '40' });
      provider.plan(labels.id('b'), { kind: 'drop', actual: '33' });
      const a = await gate.run(owner(labels.id('a')), provider.send);
      const b = await gate.run(owner(labels.id('b')), provider.send);
      const octoberFull = await gate.run(owner(labels.id('c')), provider.send);
      harness.clock.set(TOKYO_NOV_START - 1);
      await gate.tick();
      const monthBefore = await currentMonth(harness);
      const eventsBefore = [...events];
      harness.clock.set(TOKYO_NOV_START);
      await gate.tick();
      const monthAt = await currentMonth(harness);
      await gate.tick();
      for (const label of ['d', 'e'])
        provider.plan(labels.id(label), { kind: 'usage', actual: '40' });
      const d = await gate.run(owner(labels.id('d')), provider.send);
      const e = await gate.run(owner(labels.id('e')), provider.send);
      const novemberFull = await gate.run(owner(labels.id('f')), provider.send);
      // b の手での精算（本人が請求書で確かめた実費。元の月・元の枠に一度だけ）。
      assert.equal(b.kind, 'usage_unknown');
      const manual = (actual) =>
        harness.store.budget({
          kind: 'budget.settle_manual',
          reservation_id: b.ticket.reservation_id,
          expected_revision: b.ticket.revision,
          manual_reconciliation_id: 'manual:inv-oct',
          currency: 'XTS',
          actual_gross: actual,
          now: harness.clock.now(),
          request: null,
        });
      const first = await manual('33');
      const again = await manual('33');
      const different = await manual('34');
      const late = await provider.reconciler.lookup({
        request_id: labels.id('b'),
        reservation_id: b.ticket.reservation_id,
      });
      const providerLate = await gate.settle(b.ticket, late);
      const view = (result) =>
        result.ok
          ? {
              ok: true,
              duplicate: result.value.duplicate,
              overrun: result.value.overrun,
            }
          : { ok: false, reasons: [...result.reasons] };
      const manualRow = reservationRows(harness).find(
        (row) => row.request_id === labels.id('b'),
      );
      return {
        october_settled_and_lost: [outcome(a), outcome(b)],
        october_full: outcome(octoberFull),
        month_one_ms_before: monthBefore,
        events_one_ms_before: eventsBefore,
        month_at_boundary: monthAt,
        events_after_two_ticks: events,
        november_requests: [outcome(d), outcome(e)],
        november_full: outcome(novemberFull),
        manual_first: view(first),
        manual_again: view(again),
        manual_different_amount: view(different),
        provider_after_manual: providerLate.ok
          ? { ok: true }
          : { ok: false, reasons: [...providerLate.reasons] },
        manual_row: {
          status: manualRow.status,
          pool: manualRow.pool_id,
          month: manualRow.budget_month,
          actual: manualRow.actual_gross,
          reconciliation_id: manualRow.reconciliation_id,
          kind: manualRow.settlement_kind,
        },
        october_settled_total: settledTotal(harness, '2030-10', 'llm'),
        november: await usage(harness, '2030-11', 'llm'),
      };
    });
  },

  // QA42: M 超過の保留。実費が M を超えたら、その枠と子孫の受付を止め、承認があっても超過枠へ回さない。兄弟の枠は止めない。
  async 'QA42-overrun-hold'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      provider.plan(labels.id('a'), { kind: 'usage', actual: '55' });
      const a = await gate.run(owner(labels.id('a')), provider.send);
      // 保留の間に、対象の request_id と M（40）に一致する承認済みの承認を出しても、超過枠へ回さない。
      const approvalNow = await requestApproval(env, 'b', '40', {
        approvalId: uuid(931),
      });
      const decided = await decide(
        env,
        uuid(931),
        'b',
        '40',
        'approve',
        approvalNow + 1,
      );
      assert.equal(decided.ok, true, JSON.stringify(decided));
      harness.clock.set(approvalNow + 2);
      const ownerHeld = await gate.admit(owner(labels.id('b')));
      const receiptsBefore = provider.receipts.length;
      const ownerRunHeld = await gate.run(owner(labels.id('b')), provider.send);
      const heldReceipts = provider.receipts.length;
      const heldApprovals = approvalRows(harness).map((row) => row.status);
      const autonomousHeld = await gate.admit(
        owner(labels.id('b2'), { origin: 'auto_execution' }),
      );
      const searchResult = await gate.admit(
        owner(labels.id('s'), { service: 'search' }),
      );
      assert(searchResult.ok);
      assert.deepEqual(await gate.release(searchResult.ticket), { ok: true });
      const holding = await gate.holdState();
      const reservation = reservationRows(harness).find(
        (row) => row.request_id === labels.id('a'),
      );
      const review = (actual) =>
        harness.store.budget({
          kind: 'budget.review_overrun',
          reservation_id: reservation.reservation_id,
          expected_revision: '1',
          currency: 'XTS',
          actual_gross: actual,
          max_liability: '40',
          now: harness.clock.now(),
          request: null,
        });
      const wrong = await review('54');
      const right = await review('55');
      const again = await review('55');
      const view = (result) =>
        result.ok
          ? { ok: true, duplicate: result.value.duplicate }
          : { ok: false, reasons: [...result.reasons] };
      provider.plan(labels.id('b'), { kind: 'usage', actual: '30' });
      const resumed = await gate.run(owner(labels.id('b')), provider.send);
      return {
        overrun: outcome(a),
        owner_held: admission(ownerHeld),
        owner_run_with_approval_while_held: outcome(ownerRunHeld),
        receipts_while_held: [receiptsBefore, heldReceipts],
        approval_statuses_while_held: heldApprovals,
        autonomous_held: admission(autonomousHeld),
        sibling_search: admission(searchResult),
        hold_state: holding,
        review_wrong_actual: view(wrong),
        review: view(right),
        review_again: view(again),
        after_review: outcome(resumed),
        approval_statuses_after: approvalRows(harness).map((row) => row.status),
        hold_state_after: await gate.holdState(),
        llm: await usage(harness, '2030-10', 'llm'),
      };
    });
  },

  // QA42: 承認のない超過枠の使用。通常の枠が上限だけで落ちた本人の依頼で、request_id と M に固定した承認が承認済み・期限内の
  // ときだけ超過枠で受け付ける。承認の再利用・別の M・期限切れ・自発の処理は受け付けない。
  async 'QA42-overage-approval'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      await fillLlm(env, gate, ['a', 'b', 'c']);
      const noApproval = await gate.admit(owner(labels.id('d')));
      const now = await requestApproval(env, 'd', '40', {
        approvalId: uuid(901),
      });
      const pending = await gate.admit(owner(labels.id('d')));
      const wrongM = await decide(
        env,
        uuid(901),
        'd',
        '30',
        'approve',
        now + 1,
      );
      const approved = await decide(
        env,
        uuid(901),
        'd',
        '40',
        'approve',
        now + 1,
      );
      assert.equal(approved.ok, true, JSON.stringify(approved));
      harness.clock.set(now + 2);
      const smallerM = await gate.admit(sized(labels.id('d'), 5, 20));
      // autonomous（自発）の g にも承認を出すが、超過枠へは回さない。
      const nowG = await requestApproval(env, 'g', '40', {
        approvalId: uuid(903),
      });
      assert.equal(
        (await decide(env, uuid(903), 'g', '40', 'approve', nowG + 1)).ok,
        true,
      );
      harness.clock.set(nowG + 2);
      const autonomous = await gate.admit(
        owner(labels.id('g'), { origin: 'autonomous_analysis' }),
      );
      provider.plan(labels.id('d'), { kind: 'usage', actual: '35' });
      const routed = await gate.run(owner(labels.id('d')), provider.send);
      const reuse = await gate.admit(owner(labels.id('d')));
      const other = await gate.admit(owner(labels.id('e')));
      // 期限が切れた承認（f）。決めた後に期限を過ぎる。
      const nowF = await requestApproval(env, 'f', '40', {
        approvalId: uuid(902),
        lifetime: 10_000,
      });
      assert.equal(
        (await decide(env, uuid(902), 'f', '40', 'approve', nowF + 1)).ok,
        true,
      );
      harness.clock.set(nowF + 20_000);
      const expired = await gate.admit(owner(labels.id('f')));
      const view = (result) =>
        result.ok ? { ok: true } : { ok: false, reasons: [...result.reasons] };
      return {
        no_approval: admission(noApproval),
        pending: admission(pending),
        approval_with_other_m_on_screen: view(wrongM),
        smaller_m_than_approved: admission(smallerM),
        autonomous_with_approval: admission(autonomous),
        routed: outcome(routed),
        approval_reuse_same_request: admission(reuse),
        other_request_without_approval: admission(other),
        expired: admission(expired),
        approval_statuses: approvalRows(harness)
          .map((row) => row.status)
          .sort(),
        overage: await usage(harness, '2030-10', 'overage'),
        llm: await usage(harness, '2030-10', 'llm'),
      };
    });
  },

  // QA42・音声の予算から融通しない。音声が満杯でも LLM は受け付け、LLM・検索が満杯でも音声の枠は音声だけで数える。
  // 音声は超過枠へも回さず、自発の処理には音声の枠がない。
  async 'QA42-voice-isolation'(ctx) {
    const voiceFull = await world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      for (const [label, seconds] of [
        ['v1', 30],
        ['v2', 20],
      ]) {
        provider.plan(labels.id(label), {
          kind: 'usage',
          actual: String(seconds),
        });
        const result = await gate.run(
          live(labels.id(label), seconds),
          provider.send,
        );
        assert.equal(result.kind, 'settled');
      }
      // 承認済みの承認があっても、音声は超過枠へ回さない。
      const now = await requestApproval(env, 'v3', '15', {
        approvalId: uuid(911),
      });
      assert.equal(
        (await decide(env, uuid(911), 'v3', '15', 'approve', now + 1)).ok,
        true,
      );
      harness.clock.set(now + 2);
      const v3 = await gate.admit(live(labels.id('v3'), 15));
      provider.plan(labels.id('l1'), { kind: 'usage', actual: '40' });
      const llm = await gate.run(owner(labels.id('l1')), provider.send);
      const autonomous = await gate.admit(
        live(labels.id('v4'), 15, { origin: 'autonomous_analysis' }),
      );
      return {
        voice_over_limit: admission(v3),
        llm_still_admitted: outcome(llm),
        autonomous_voice: admission(autonomous),
        approval_unused: approvalRows(harness).map((row) => row.status),
        voice: await usage(harness, '2030-10', 'voice'),
        llm: await usage(harness, '2030-10', 'llm'),
      };
    });
    const llmFull = await world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      await fillLlm(env, gate, ['a', 'b', 'c']);
      provider.plan(labels.id('s1'), { kind: 'usage', actual: '40' });
      const search = await gate.run(
        owner(labels.id('s1'), { service: 'search' }),
        provider.send,
      );
      assert.equal(search.kind, 'settled');
      const llm = await gate.admit(owner(labels.id('l1')));
      provider.plan(labels.id('w1'), { kind: 'usage', actual: '50' });
      const voice = await gate.run(live(labels.id('w1'), 50), provider.send);
      const voiceOver = await gate.admit(live(labels.id('w2'), 15));
      return {
        llm_over_limit: admission(llm),
        voice_admitted_to_its_own_limit: outcome(voice),
        voice_over_limit: admission(voiceOver),
        voice: await usage(harness, '2030-10', 'voice'),
        llm_pool: await usage(harness, '2030-10', 'llm'),
        search: await usage(harness, '2030-10', 'search'),
      };
    });
    return { voice_full: voiceFull, llm_full: llmFull };
  },

  // QA20: 単価の版の境界。M は掛かる版の区分ごとの高い単価で計算する。境目ちょうど・1 ミリ秒前・版が確認されていない場合を含む。
  async 'QA20-price-boundary'(ctx) {
    const rate = (category, price, max) => ({
      category,
      unit_price: price,
      per_quantity: '1',
      minimum_quantity: '0',
      max_quantity_per_request: max,
    });
    const same = {
      conversion_version: 'xts.same.v1',
      to_currency: 'XTS',
      rate: '1',
      safety_factor: '1',
    };
    const config = (verified) =>
      loadedConfig(
        syntheticConfig((value) => {
          value.price_versions = [
            {
              price_version: 'xts.text.v1',
              price_key: 'synthetic.text',
              currency: 'XTS',
              effective_from: '2030-01-01T00:00:00.000Z',
              effective_to: '2030-10-20T00:00:00.000Z',
              rates: [
                rate('input_tokens', '1', null),
                rate('output_tokens', '3', '100'),
              ],
              conversion: same,
            },
            {
              price_version: 'xts.text.v2',
              price_key: 'synthetic.text',
              currency: 'XTS',
              effective_from: '2030-10-20T00:00:00.000Z',
              effective_to: null,
              rates: [
                rate('input_tokens', '2', null),
                rate('output_tokens', '1', '100'),
              ],
              conversion: same,
            },
            ...value.price_versions.filter(
              (version) => version.price_version === 'xts.live.v1',
            ),
          ];
          value.budget.verified_price_versions = verified;
        }),
      );
    const request = (id, timeout) => sized(id, 5, 10, { timeout_ms: timeout });
    const verifiedBoth = await world(
      ctx,
      { start: Date.parse('2030-10-19T23:58:00.000Z') },
      async (env) => {
        const { labels, harness } = env;
        const gate = env.gate({
          config: config(['xts.text.v1', 'xts.text.v2', 'xts.live.v1']),
        });
        await gate.start();
        const view = (result, label) => {
          const row = reservationRows(harness).find(
            (r) => r.request_id === labels.id(label),
          );
          return { ...admission(result), price_version: row?.price_version };
        };
        // 受付 23:58:00.000、課金され得る最後の時刻は境目の 1 ミリ秒前（23:59:59.999）。
        const before = await gate.admit(request(labels.id('a'), 119_999));
        // 受付 23:59:00.000、最後の時刻がちょうど境目（期間は両端を含む）。
        harness.clock.set(Date.parse('2030-10-19T23:59:00.000Z'));
        const atEnd = await gate.admit(request(labels.id('b'), 60_000));
        // 受付がちょうど新しい版の開始。古い版は掛からない。
        harness.clock.set(Date.parse('2030-10-20T00:00:00.000Z'));
        const after = await gate.admit(request(labels.id('c'), 60_000));
        return {
          ends_one_ms_before_boundary: view(before, 'a'),
          ends_exactly_at_boundary: view(atEnd, 'b'),
          starts_at_new_version: view(after, 'c'),
        };
      },
    );
    const unverifiedNew = await world(
      ctx,
      { start: Date.parse('2030-10-19T23:58:00.000Z') },
      async (env) => {
        const { labels, harness } = env;
        const gate = env.gate({
          config: config(['xts.text.v1', 'xts.live.v1']),
        });
        await gate.start();
        const before = await gate.admit(request(labels.id('a'), 119_999));
        harness.clock.set(Date.parse('2030-10-19T23:59:00.000Z'));
        const straddle = await gate.admit(request(labels.id('b'), 60_000));
        harness.clock.set(Date.parse('2030-10-20T00:00:00.000Z'));
        const after = await gate.admit(request(labels.id('c'), 60_000));
        return {
          old_version_only: admission(before),
          straddles_unverified_new_version: admission(straddle),
          new_version_only_unverified: admission(after),
        };
      },
    );
    const notCovered = await world(
      ctx,
      { start: Date.parse('2029-12-31T23:59:59.500Z') },
      async (env) => {
        const gate = env.gate({
          config: config(['xts.text.v1', 'xts.text.v2', 'xts.live.v1']),
        });
        await gate.start();
        const result = await gate.admit(request(env.labels.id('a'), 1_000));
        return { starts_before_first_version: admission(result) };
      },
    );
    return {
      verified_both: verifiedBoth,
      unverified_new_version: unverifiedNew,
      not_covered: notCovered,
    };
  },

  // QA20: 上限が不明。M を有限にできない・単価や期限・設定が不明な要求は受け付けず、provider へ送らない。
  async 'QA20-limit-unknown'(ctx) {
    const rejectedWorld = await world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      const id = (label) => labels.id(label);
      const attempts = {
        input_unbounded: textRequest(id('a'), {
          quantities: { output_tokens: '30' },
        }),
        output_missing_uses_rate_maximum: textRequest(id('b'), {
          quantities: { input_tokens: '10' },
        }),
        output_above_rate_maximum: sized(id('c'), 10, 101),
        cached_input_estimated: textRequest(id('d'), {
          quantities: {
            input_tokens: '5',
            cached_input_tokens: '5',
            output_tokens: '10',
          },
        }),
        unpriced_category: textRequest(id('e'), {
          quantities: { input_tokens: '10', search_requests: '1' },
        }),
        non_integer_quantity: textRequest(id('f'), {
          quantities: { input_tokens: '1.5', output_tokens: '10' },
        }),
        unknown_price_key: textRequest(id('g'), {
          price_key: 'synthetic.unknown',
        }),
        timeout_zero: textRequest(id('h'), { timeout_ms: 0 }),
        timeout_fraction: textRequest(id('i'), { timeout_ms: 1.5 }),
        no_route: textRequest(id('j'), {
          origin: 'shadow_mode',
          service: 'search',
        }),
      };
      const observed = {};
      for (const [name, request] of Object.entries(attempts))
        observed[name] = admission(await gate.admit(request));
      const before = reservationRows(harness).length;
      const receipts = provider.receipts.length;
      // 受け付けなかった後も門は止まらない（残った予約はない）。
      provider.plan(id('k'), { kind: 'usage', actual: '30' });
      const next = await gate.run(owner(id('k')), provider.send);
      return {
        rejected: observed,
        reservations_after_rejections: before,
        receipts_after_rejections: receipts,
        next_request: outcome(next),
      };
    });
    const unverified = await world(ctx, {}, async (env) => {
      const { labels } = env;
      const gate = env.gate({
        config: loadedConfig(
          syntheticConfig((value) => {
            value.budget.verified_price_versions = ['xts.text.v1'];
          }),
        ),
      });
      await gate.start();
      const voice = await gate.admit(live(labels.id('a'), 30));
      const text = await gate.admit(owner(labels.id('b')));
      return {
        voice_price_unverified: admission(voice),
        text_price_verified: admission(text),
      };
    });
    const configInvalid = await world(ctx, {}, async (env) => {
      const { labels } = env;
      const invalid = checkBudgetConfigText(
        JSON.stringify({ schema: 'buddy.budget-runtime.v1' }),
        createApiContract(),
        () => 'Asia/Tokyo',
      );
      assert.equal(invalid.ok, false);
      const gate = env.gate({ config: invalid });
      const result = await gate.admit(owner(labels.id('a')));
      return {
        admission: admission(result),
        hold_state: await gate.holdState(),
      };
    });
    return {
      rejected: rejectedWorld,
      unverified_price: unverified,
      config_invalid: configInvalid,
    };
  },

  // X53: 自発の処理は本人の枠を使わない。自発の枠（llm.background）を使い切っても本人の依頼は LLM の上限まで続き、
  // 自発・自動実行・初回の読み込み・影モードは承認があっても超過枠へ回らない。
  async 'X53-autonomous-own-slot'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      provider.plan(labels.id('a'), { kind: 'usage', actual: '40' });
      const a = await gate.run(
        owner(labels.id('a'), { origin: 'autonomous_analysis' }),
        provider.send,
      );
      const refused = {};
      for (const [label, origin] of [
        ['b', 'autonomous_analysis'],
        ['c', 'shadow_mode'],
        ['d', 'initial_import'],
      ])
        refused[origin] = admission(
          await gate.admit(owner(labels.id(label), { origin })),
        );
      const voice = await gate.admit(
        live(labels.id('v'), 15, { origin: 'auto_execution' }),
      );
      // 本人の依頼（背景の処理を頼んだ場合も同じ起点）は LLM の上限まで続く: 使用は 自発 40 + 40 + 20 = 100。
      for (const label of ['e', 'f'])
        provider.plan(labels.id(label), {
          kind: 'usage',
          actual: label === 'e' ? '40' : '20',
        });
      const e = await gate.run(owner(labels.id('e')), provider.send);
      const f = await gate.run(sized(labels.id('f'), 10, 10), provider.send);
      const g = await gate.admit(sized(labels.id('g'), 1, 0));
      // 自動実行 h に承認を出しても、超過枠へは回さない。
      const now = await requestApproval(env, 'h', '40', {
        approvalId: uuid(921),
      });
      assert.equal(
        (await decide(env, uuid(921), 'h', '40', 'approve', now + 1)).ok,
        true,
      );
      harness.clock.set(now + 2);
      const h = await gate.admit(
        owner(labels.id('h'), { origin: 'auto_execution' }),
      );
      return {
        autonomous_uses_background: outcome(a),
        background_exhausted: refused,
        autonomous_voice_has_no_pool: admission(voice),
        owner_continues: [outcome(e), outcome(f)],
        owner_over_limit: admission(g),
        auto_execution_with_approval: admission(h),
        approval_statuses: approvalRows(harness).map((row) => row.status),
        background: await usage(harness, '2030-10', 'llm.background'),
        llm: await usage(harness, '2030-10', 'llm'),
      };
    });
  },

  // X18: 追加予約（会話の延長）。同じ版の追加予約は 1 つだけ通り、同時の追加予約でも音声の上限（50）を超えない。
  // 追加予約の後も、精算は provider の実費で一度だけ行う。
  async 'X18-topup-concurrency'(ctx) {
    // 上限の競合の勝ち負けは命令の並びで決まる。v1 → v2 と v2 → v1 の両方の投入順を明示して実行する。
    const run = (order) =>
      world(ctx, { wave: true }, async (env) => {
        const { provider, labels, harness } = env;
        const gate = env.gate();
        await gate.start();
        // 会話の最低課金 15 秒の予約を 2 つ受け付け、provider へ送る（provider の実費は 10 ずつ）。使用は 15 + 15 = 30。
        const tickets = [];
        for (const label of ['v1', 'v2']) {
          provider.plan(labels.id(label), { kind: 'usage', actual: '10' });
          tickets.push(
            await admitAndSend(gate, provider, live(labels.id(label), 15)),
          );
        }
        // 同じ版（1）の追加予約を 4 つ同時に送る。版の CAS で 1 つだけ通る（使用は 31）。
        const same = await Promise.all(
          [1, 2, 3, 4].map(() =>
            gate.topUp(tickets[0].ticket, {
              reserved: '1',
              max_liability: '1',
            }),
          ),
        );
        const winners = same.filter((result) => result.ok);
        assert.equal(winners.length, 1);
        const grown = winners[0].ticket;
        // 残り 19 の枠へ、2 つの予約が同時に +19 を求める。1 つだけ通り、もう 1 つは音声の上限で拒否する。
        const current = { v1: grown, v2: tickets[1].ticket };
        const race = await Promise.all(
          order.map((label) =>
            gate.topUp(current[label], { reserved: '19', max_liability: '19' }),
          ),
        );
        const before = await usage(harness, '2030-10', 'voice');
        // 追加予約の後の精算は、provider の実費（10 ずつ）で一度だけ。
        const settled = [];
        for (const { ticket, outcome: sent } of tickets)
          settled.push(await gate.settle(ticket, sent));
        const unique = (results) =>
          [
            ...new Set(results.map((result) => JSON.stringify(result.reasons))),
          ].map((text) => JSON.parse(text));
        return {
          submitted_order: order,
          same_version_four_times: {
            ok: winners.length,
            rejected: unique(same.filter((result) => !result.ok)),
            grown: {
              reserved: grown.reserved,
              max: grown.max_liability,
              revision: grown.revision,
            },
          },
          limit_race: {
            ok: race.filter((result) => result.ok).length,
            rejected: unique(race.filter((result) => !result.ok)),
          },
          voice_before_settlement: before,
          settlements: settled.map((result) => result.ok && !result.duplicate),
          voice_after_settlement: await usage(harness, '2030-10', 'voice'),
        };
      });
    return {
      v1_then_v2: await run(['v1', 'v2']),
      v2_then_v1: await run(['v2', 'v1']),
    };
  },

  // 設定値・単価・請求通貨は実行時の入力（設定ファイル）。本番と同じ読み込み（loadBudgetConfig）で読んだ値だけが上限と M を
  // 決め、通貨も設定で変わる。ファイルがない・不正・他人が書ける設定は有料の処理を受け付けない。
  async 'B07-runtime-config'(ctx) {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-b07-config-'));
    const contract = createApiContract();
    const load = (name) =>
      loadBudgetConfig({
        path: join(directory, name),
        contract,
        osTimeZone: () => 'Asia/Tokyo',
      });
    const write = (name, text) =>
      writeFile(join(directory, name), text, { mode: 0o600 });
    try {
      // 設定 A: 合成の標準の設定（llm の上限 100、M 40）。
      await write('a.json', JSON.stringify(syntheticConfig()));
      const a = await load('a.json');
      assert.equal(a.ok, true);
      const fromFileA = await world(ctx, {}, async (env) => {
        const { provider, labels } = env;
        const gate = env.gate({ config: a });
        await gate.start();
        const results = [];
        for (const label of ['a1', 'a2', 'a3']) {
          provider.plan(labels.id(label), { kind: 'usage', actual: '40' });
          results.push(
            outcome(await gate.run(owner(labels.id(label)), provider.send)),
          );
        }
        return { loaded: true, requests: results };
      });
      // 設定 B: 入力の単価 2・llm の上限 60・通貨 XXX（同じコード・同じ DB の形のまま、設定だけで M・上限・通貨が変わる）。
      const edited = syntheticConfig((value) => {
        value.price_versions[0].rates[0].unit_price = '2';
        value.budget.pools.find((pool) => pool.pool_id === 'llm').limit.amount =
          '60';
      });
      await write('b.json', JSON.stringify(edited).replaceAll('XTS', 'XXX'));
      const b = await load('b.json');
      assert.equal(b.ok, true, JSON.stringify(b));
      const fromFileB = await world(ctx, {}, async (env) => {
        const { provider, labels, harness } = env;
        const gate = env.gate({ config: b });
        await gate.start();
        provider.plan(labels.id('b1'), { kind: 'usage', actual: '45' });
        const first = await gate.run(owner(labels.id('b1')), provider.send);
        const second = await gate.admit(owner(labels.id('b2')));
        const currencies = harness.sql((db) =>
          db
            .prepare(
              'SELECT DISTINCT currency FROM budget_reservations ORDER BY currency',
            )
            .all()
            .map((row) => row.currency),
        );
        return {
          loaded: true,
          first: outcome(first),
          second: admission(second),
          currencies,
          reserved_max: reservationRows(harness).map(
            (row) => row.max_liability,
          ),
        };
      });
      // 読めない・不正な設定は、有料の処理を受け付けない（理由コードだけを返し、中身・金額を出さない）。
      await write('json.json', '{');
      await write('schema.json', '{"schema":"buddy.budget-runtime.v1"}');
      const unbounded = syntheticConfig((value) => {
        value.price_versions[0].rates[1].max_quantity_per_request = null;
      });
      await write('unbounded.json', JSON.stringify(unbounded));
      const overlapping = syntheticConfig((value) => {
        value.price_versions.push({
          ...value.price_versions[0],
          price_version: 'xts.text.v2',
        });
      });
      await write('overlap.json', JSON.stringify(overlapping));
      const invalid = {
        missing: await load('missing.json'),
        invalid_json: await load('json.json'),
        schema_invalid: await load('schema.json'),
        output_limit_unknown: await load('unbounded.json'),
        price_periods_overlap: await load('overlap.json'),
      };
      const posixOnly = {};
      if (process.platform !== 'win32') {
        await write('writable.json', JSON.stringify(syntheticConfig()));
        await chmod(join(directory, 'writable.json'), 0o664);
        invalid.writable_by_others = await load('writable.json');
        posixOnly.writable_by_others = invalid.writable_by_others.reasons;
      }
      const refused = await world(ctx, {}, async (env) => {
        const { labels } = env;
        const admissions = {};
        for (const [name, config] of Object.entries(invalid)) {
          assert.equal(config.ok, false, name);
          const gate = env.gate({ config });
          admissions[name] = admission(
            await gate.admit(owner(labels.id(name))),
          );
        }
        return {
          load_reasons: Object.fromEntries(
            Object.entries(invalid)
              .filter(([name]) => name !== 'writable_by_others')
              .map(([name, config]) => [name, [...config.reasons]]),
          ),
          admissions: Object.fromEntries(
            Object.entries(admissions).filter(
              ([name]) => name !== 'writable_by_others',
            ),
          ),
          reservations: reservationRows(env.harness).length,
        };
      });
      return {
        settings_a: fromFileA,
        settings_b: fromFileB,
        invalid_settings: refused,
        ...(process.platform === 'win32' ? {} : { posix_only: posixOnly }),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },

  // MA03: 同じ usage を通常料金・クレジット・追加の支出へ一度だけ分ける。クレジットで追加の支出が 0 でも、通常料金の
  // R / M で枠の上限を守る。usage 不明では M を解放せず、クレジットの残りからも確保し続ける。
  async 'MA03-credit-split-once'(ctx) {
    // 残高 20 XXX（1 単位あたり 2 で 40 XTS）。
    const split = await world(
      ctx,
      { creditCap: { [CYCLE_OCT]: 40n } },
      async (env) => {
        const { provider, labels } = env;
        const source = new MemoryCreditSource([
          creditObservation({ balance: { currency: 'XXX', amount: '20' } }),
        ]);
        const gate = env.creditGate(source);
        await gate.start();
        // a: M 40 は残り 40 にちょうど収まる。実費 25 は全額クレジット。同じ精算 5 件の同時は 1 件だけ。
        provider.plan(labels.id('a'), { kind: 'usage', actual: '25' });
        const a = await admitAndSend(
          gate,
          provider,
          claudeRequest(labels.id('a')),
        );
        const same = await Promise.all(
          [1, 2, 3, 4, 5].map(() => gate.settle(a.ticket, a.outcome)),
        );
        const conflict = await gate.settle(a.ticket, {
          ...a.outcome,
          actual_gross: '26',
        });
        // b: M 15 は残り 15 にちょうど収まる。実費 12 は全額クレジット。
        provider.plan(labels.id('b'), { kind: 'usage', actual: '12' });
        const b = await gate.run(
          claudeRequest(labels.id('b'), {
            quantities: { input_tokens: '10', output_tokens: '5' },
          }),
          provider.send,
        );
        // c: M 40 は残り 3 に足りない。provider へ送らない。
        const c = await gate.run(claudeRequest(labels.id('c')), provider.send);
        // 追加の支出 0 でも通常料金は llm の上限に数える。クレジットを充てない Luna は、40 が入り、次は上限で止まる。
        const llmAfterClaude = await usage(env.harness, '2030-10', 'llm');
        provider.plan(labels.id('d'), { kind: 'usage', actual: '40' });
        const d = await gate.run(owner(labels.id('d')), provider.send);
        const e = await gate.run(owner(labels.id('e')), provider.send);
        return {
          concurrent_settle_of_a: {
            ok: same.filter((r) => r.ok).length,
            fresh: same.filter((r) => r.ok && !r.duplicate).length,
            duplicate: same.filter((r) => r.ok && r.duplicate).length,
          },
          different_amount_for_settled: conflict.ok
            ? { ok: true }
            : { ok: false, reasons: [...conflict.reasons] },
          second_settles: outcome(b),
          third_is_held: outcome(c),
          llm_after_claude_settlements: llmAfterClaude,
          luna_settles: outcome(d),
          luna_over_the_gross_limit: outcome(e),
          rows: creditRowsView(env),
          credit: creditView(await gate.creditStatus()),
          provider_requests: provider.receipts.length,
          llm: await usage(env.harness, '2030-10', 'llm'),
        };
      },
    );
    // 残高 100 XTS（50 XXX）。応答を失った要求は usage 不明のまま M を保持し、クレジットの残りから確保し続ける。
    const unknown = await world(
      ctx,
      { creditCap: { [CYCLE_OCT]: 100n } },
      async (env) => {
        const { provider, labels } = env;
        const source = new MemoryCreditSource([creditObservation()]);
        const gate = env.creditGate(source);
        await gate.start();
        provider.plan(labels.id('b'), { kind: 'drop', actual: '8' });
        const b = await gate.run(claudeRequest(labels.id('b')), provider.send);
        // a: 実費 55 は M 40 を超える。クレジットは M までで、b の確保を食わない。超えた 15 は追加の支出。消費の見積もりは M で止めず実費 55 なので、残りは 100 − 55 − b の M 40 = 5。
        provider.plan(labels.id('a'), { kind: 'usage', actual: '55' });
        const a = await gate.run(claudeRequest(labels.id('a')), provider.send);
        return {
          lost_response: outcome(b),
          over_m: outcome(a),
          rows: creditRowsView(env),
          credit: creditView(await gate.creditStatus()),
          llm: await usage(env.harness, '2030-10', 'llm'),
        };
      },
    );
    // 影モード（自発の枠 llm.background、上限 50）の Claude の要求は、クレジットで追加の支出が 0 でも、通常料金の実費で
    // その枠の上限に達したら止まる。
    const shadow = await world(
      ctx,
      { creditCap: { [CYCLE_OCT]: 100n } },
      async (env) => {
        const { provider, labels } = env;
        const source = new MemoryCreditSource([creditObservation()]);
        const gate = env.creditGate(source);
        await gate.start();
        provider.plan(labels.id('s1'), { kind: 'usage', actual: '40' });
        const first = await gate.run(
          claudeRequest(labels.id('s1'), { origin: 'shadow_mode' }),
          provider.send,
        );
        const second = await gate.run(
          claudeRequest(labels.id('s2'), { origin: 'shadow_mode' }),
          provider.send,
        );
        return {
          first_settles: outcome(first),
          second_is_stopped_by_the_pool: outcome(second),
          rows: creditRowsView(env),
          credit: creditView(await gate.creditStatus()),
          llm_background: await usage(env.harness, '2030-10', 'llm.background'),
        };
      },
    );
    return {
      split,
      unknown_usage_keeps_m: unknown,
      shadow_mode_limit_with_credit: shadow,
    };
  },

  // MA04: 請求周期の終わり（失効）と暦月の予算の更新を別々に起こす。月替わりで残高を戻さず、古い周期の未精算の要求を
  // 新しい周期へ付け替えない。
  async 'MA04-cycle-and-month-are-separate'(ctx) {
    return world(
      ctx,
      { creditCap: { [CYCLE_OCT]: 100n, [CYCLE_NOV]: 200n } },
      async (env) => {
        const { provider, labels, harness } = env;
        const source = new MemoryCreditSource([creditObservation()]);
        const gate = env.creditGate(source);
        await gate.start();
        provider.plan(labels.id('a'), { kind: 'usage', actual: '30' });
        const a = await gate.run(claudeRequest(labels.id('a')), provider.send);
        // 東京の 11 月の始まりの 1 時間後: 予算月は 11 月へ替わる。周期は 11 月 1 日 0 時（UTC）まで続き、残高は戻らない。
        harness.clock.set(TOKYO_NOV_START + HOUR);
        await gate.tick();
        const rolled = {
          month: await currentMonth(harness),
          credit: creditView(await gate.creditStatus()),
        };
        provider.plan(labels.id('b'), { kind: 'usage', actual: '40' });
        const b = await gate.run(claudeRequest(labels.id('b')), provider.send);
        const afterB = creditView(await gate.creditStatus());
        // 周期の終わりの 1 ミリ秒前: c は受け付ける（送ったが、精算は周期の終わりより後）。f は応答を失う。
        harness.clock.set(CYCLE_END - 1);
        provider.plan(labels.id('c'), { kind: 'usage', actual: '8' });
        const c = await admitAndSend(
          gate,
          provider,
          claudeRequest(labels.id('c'), {
            quantities: { input_tokens: '5', output_tokens: '5' },
          }),
        );
        provider.plan(labels.id('f'), { kind: 'drop', actual: '8' });
        const f = await gate.run(
          claudeRequest(labels.id('f'), {
            quantities: { input_tokens: '5', output_tokens: '5' },
          }),
          provider.send,
        );
        assert.equal(f.kind, 'usage_unknown');
        // 周期の終わりちょうど: Claude は失効で保留。予算月は変わらず、Luna は受け付ける。
        harness.clock.set(CYCLE_END);
        const expired = await gate.run(
          claudeRequest(labels.id('d')),
          provider.send,
        );
        const hold = (await gate.holdState()).credit_hold ?? null;
        provider.plan(labels.id('e'), { kind: 'usage', actual: '3' });
        const luna = await gate.run(owner(labels.id('e')), provider.send);
        const monthAtExpiry = await currentMonth(harness);
        // 本人が新しい周期の観測を書く。古い周期の c の精算は、周期が終わっているのでクレジット 0 で、周期は古いまま。
        harness.clock.set(CYCLE_END + 1);
        source.observations.push(
          creditObservation({
            cycle_id: CYCLE_NOV,
            observed_at: '2030-11-01T00:00:00.001Z',
            expires_at: '2030-12-01T00:00:00.000Z',
            balance: { currency: 'XXX', amount: '100' },
          }),
        );
        const settledC = await gate.settle(c.ticket, c.outcome);
        const newCycle = creditView(await gate.creditStatus());
        provider.plan(labels.id('g'), { kind: 'usage', actual: '25' });
        const g = await gate.run(
          claudeRequest(labels.id('g'), {
            quantities: { input_tokens: '10', output_tokens: '20' },
          }),
          provider.send,
        );
        // 古い周期の usage 不明 f は、新しい周期への付け替えを拒否し、古い周期のままの区分だけを受け付ける。
        const ticketF = f.ticket;
        const manual = (cycle) =>
          harness.store.budget({
            kind: 'budget.settle_manual',
            reservation_id: ticketF.reservation_id,
            expected_revision: ticketF.revision,
            manual_reconciliation_id: 'manual:invoice-f',
            currency: 'XTS',
            actual_gross: '8',
            credit_applied: '6',
            additional_spend: '2',
            credit_cycle_id: cycle,
            now: harness.clock.now(),
            request: null,
          });
        const toNew = await manual(CYCLE_NOV);
        const toOld = await manual(CYCLE_OCT);
        return {
          first_settlement: outcome(a),
          after_month_rolled: rolled,
          second_in_new_month: outcome(b),
          after_second: afterB,
          at_cycle_end: {
            claude: outcome(expired),
            hold,
            luna: outcome(luna),
            budget_month: monthAtExpiry,
          },
          old_cycle_unsettled_settles: settledC.ok,
          new_cycle_after_observation: newCycle,
          new_cycle_request: outcome(g),
          after_new_cycle_request: creditView(await gate.creditStatus()),
          manual_into_new_cycle: toNew.ok
            ? { ok: true }
            : { ok: false, reasons: [...toNew.reasons] },
          manual_into_own_cycle: toOld.ok
            ? { ok: true }
            : { ok: false, reasons: [...toOld.reasons] },
          rows: creditRowsView(env),
        };
      },
    );
  },

  // MA05: 残高不明・失効・枯渇・共有の組織の他用途消費・同時要求を注入する。Claude の処理を保留し、provider へ送らず、
  // 購入残高・後払いへ移らない。共有の組織の観測は、古くなったら信じずに保留する（専有できるとは扱わない）。
  async 'MA05-hold-until-balance-is-known'(ctx) {
    // 残高が確認できない場合。観測は採用すると永続化され、同じ時刻で内容の違う観測は採用しないので、場合ごとに新しい世界で確かめる。
    const unconfirmed = {
      no_observation: { observations: [], reason: 'credit_unknown' },
      file_missing: {
        observations: [],
        failure: 'missing',
        reason: 'credit_unknown',
      },
      file_unreadable: {
        observations: [],
        failure: 'unreadable',
        reason: 'credit_unknown',
      },
      status_unknown: {
        observations: [
          creditObservation({ status: 'unknown', balance: null, shared: true }),
        ],
        reason: 'credit_unknown',
      },
      status_expired: {
        observations: [creditObservation({ status: 'expired' })],
        reason: 'credit_expired',
      },
      zero_balance: {
        observations: [
          creditObservation({ balance: { currency: 'XXX', amount: '0' } }),
        ],
        reason: 'credit_exhausted',
      },
      balance_in_another_currency: {
        observations: [
          creditObservation({ balance: { currency: 'XTS', amount: '500' } }),
        ],
        reason: 'credit_unknown',
      },
      another_provider: {
        observations: [
          creditObservation({
            provider: 'openai',
            cycle_id: 'openai:2030-10-01',
          }),
        ],
        reason: 'credit_unknown',
      },
    };
    const matrix = {};
    for (const [name, item] of Object.entries(unconfirmed))
      matrix[name] = await world(ctx, {}, async (env) => {
        const { provider, labels } = env;
        const source = new MemoryCreditSource(item.observations);
        if (item.failure !== undefined) source.failure = item.failure;
        const gate = env.creditGate(source);
        await gate.start();
        const result = await gate.admit(claudeRequest(labels.id('held')));
        assert.equal(result.ok, false, name);
        const hold = (await gate.holdState()).credit_hold ?? null;
        // クレジットを充てない profile は保留しない。
        provider.plan(labels.id('luna'), { kind: 'usage', actual: '5' });
        const luna = await gate.run(owner(labels.id('luna')), provider.send);
        return {
          admission: {
            ok: false,
            reasons: [...result.reasons],
            budget_held: result.budgetHeld,
          },
          status_hold: hold,
          luna_is_not_held: outcome(luna),
          provider_requests: provider.receipts.length,
          rows: creditRowsView(env),
        };
      });
    // 有効な観測が後から届けば再開する。
    const resumed = await world(ctx, {}, async (env) => {
      const { provider, labels } = env;
      const source = new MemoryCreditSource([]);
      const gate = env.creditGate(source);
      await gate.start();
      const before = await gate.admit(claudeRequest(labels.id('first')));
      source.observations = [creditObservation()];
      provider.plan(labels.id('resume'), { kind: 'usage', actual: '20' });
      const after = await gate.run(
        claudeRequest(labels.id('resume')),
        provider.send,
      );
      return {
        before_the_observation: before.ok ? 'admitted' : [...before.reasons],
        after_the_observation: outcome(after),
        provider_requests: provider.receipts.length,
        rows: creditRowsView(env),
      };
    });
    const shared = await world(ctx, {}, async (env) => {
      const source = new MemoryCreditSource([
        creditObservation({ shared: true }),
      ]);
      const gate = env.creditGate(source);
      await gate.start();
      const at = (offset) => env.harness.clock.set(OCT_15 + offset);
      const reasons = (result) =>
        result.ok ? 'admitted' : [...result.reasons];
      // 観測から上限（1 時間）ちょうどまでは新しい。1 ミリ秒でも過ぎたら古く、新しい観測が届くまで保留。
      at(HOUR);
      env.provider.plan(env.labels.id('a'), { kind: 'usage', actual: '8' });
      const fresh = await admitAndSend(
        gate,
        env.provider,
        claudeRequest(env.labels.id('a')),
      );
      at(HOUR + 1);
      const stale = await gate.admit(claudeRequest(env.labels.id('b')));
      const staleHold = (await gate.holdState()).credit_hold ?? null;
      // 他の用途が使って残高が減った新しい観測（5 XXX = 10 XTS）。未精算の a の M 40 を引くと残りがない。
      at(2 * HOUR);
      source.observations.push(
        creditObservation({
          shared: true,
          observed_at: '2030-10-15T02:00:00.000Z',
          balance: { currency: 'XXX', amount: '5' },
        }),
      );
      const afterOther = await gate.admit(claudeRequest(env.labels.id('c')));
      // a を精算すると（実費 8）観測の後の精算としてクレジット 8、残り 2。M 11 は足りず、M 2 はちょうど収まる。
      const settled = await gate.settle(fresh.ticket, fresh.outcome);
      const tooBig = await gate.admit(
        claudeRequest(env.labels.id('d'), {
          quantities: { input_tokens: '5', output_tokens: '6' },
        }),
      );
      const small = await gate.admit(
        claudeRequest(env.labels.id('e'), {
          quantities: { input_tokens: '1', output_tokens: '1' },
        }),
      );
      return {
        at_the_age_limit: 'admitted',
        one_ms_past_the_limit: reasons(stale),
        status_hold_when_stale: staleHold,
        after_other_use_lowered_the_balance: reasons(afterOther),
        settled_after_the_new_observation: settled.ok,
        m_above_the_remaining: reasons(tooBig),
        m_exactly_the_remaining: reasons(small),
        rows: creditRowsView(env),
        credit: creditView(await gate.creditStatus()),
      };
    });
    // 同時要求: M 25 の 3 つを関門で同時に受付へ送る。残高 60 XTS に収まる 2 つだけ受け付け、確保した M の合計は残高以内。
    const concurrent = await world(
      ctx,
      { wave: true, creditCap: { [CYCLE_OCT]: 60n } },
      async (env) => {
        const { labels } = env;
        const source = new MemoryCreditSource([
          creditObservation({ balance: { currency: 'XXX', amount: '30' } }),
        ]);
        const gate = env.creditGate(source, {
          faults: { beforeAdmit: barrier(3) },
        });
        await gate.start();
        const order = shuffled(['x', 'y', 'z'], ctx.seed);
        const results = new Map();
        await Promise.all(
          order.map(async (label) =>
            results.set(
              label,
              await gate.admit(
                claudeRequest(labels.id(label), {
                  quantities: { input_tokens: '10', output_tokens: '15' },
                }),
              ),
            ),
          ),
        );
        const all = [...results.values()];
        return {
          admitted: all.filter((r) => r.ok).length,
          held: all.filter((r) => !r.ok).map((r) => [...r.reasons]),
          reserved_m_total: reservationRows(env.harness)
            .reduce((sum, row) => sum + BigInt(row.max_liability), 0n)
            .toString(),
          provider_requests: env.provider.receipts.length,
          credit: creditView(await gate.creditStatus()),
        };
      },
    );
    // 精算は観測のファイルに頼らない: 受付で採用した観測のまま精算でき、ファイルが読めない・ない間も残りを数える。
    const independent = await world(
      ctx,
      { creditCap: { [CYCLE_OCT]: 100n } },
      async (env) => {
        const { provider, labels } = env;
        const source = new MemoryCreditSource([creditObservation()]);
        const gate = env.creditGate(source);
        await gate.start();
        provider.plan(labels.id('a'), { kind: 'usage', actual: '25' });
        const a = await gate.run(claudeRequest(labels.id('a')), (context) => {
          source.failure = 'unreadable';
          return provider.send(context);
        });
        provider.plan(labels.id('b'), { kind: 'usage', actual: '10' });
        source.failure = 'missing';
        const b = await gate.run(claudeRequest(labels.id('b')), provider.send);
        return {
          file_unreadable_while_sending: outcome(a),
          file_missing_at_admission: outcome(b),
          rows: creditRowsView(env),
          credit: creditView(await gate.creditStatus()),
        };
      },
    );
    return {
      hold_matrix: matrix,
      resumed_by_a_later_observation: resumed,
      shared_organization: shared,
      concurrent_requests: concurrent,
      settlement_does_not_depend_on_the_file: independent,
    };
  },

  // MA05（レビューの反映）: 受付の後の失効・不明・残高の減少で送らず（購入残高・後払いへ移らない）、追加予約もクレジットの
  // 残りで賄えるときだけ増やす。
  async 'MA05-credit-rechecked-before-sending-and-top-up'(ctx) {
    const dispatch = {
      expiry_between_admission_and_sending: {
        start: OCT_15 + 2000,
        observation: { expires_at: '2030-10-15T00:00:03.000Z' },
        change: (harness) => harness.clock.set(OCT_15 + 3000),
      },
      balance_drops_below_the_reservation: {
        change: (harness, source) => {
          source.observations.push(
            creditObservation({
              observed_at: '2030-10-15T00:00:01.000Z',
              balance: { currency: 'XXX', amount: '10' },
            }),
          );
          harness.clock.set(OCT_15 + 2000);
        },
      },
      balance_becomes_unknown: {
        change: (harness, source) => {
          source.observations.push(
            creditObservation({
              observed_at: '2030-10-15T00:00:01.000Z',
              status: 'unknown',
              balance: null,
            }),
          );
          harness.clock.set(OCT_15 + 2000);
        },
      },
      shared_observation_gets_stale: {
        observation: { shared: true },
        timeoutMs: 2 * HOUR,
        change: (harness) => harness.clock.set(OCT_15 + HOUR + 1),
      },
    };
    const results = {};
    for (const [name, item] of Object.entries(dispatch))
      results[name] = await world(
        ctx,
        { start: item.start ?? OCT_15 },
        async (env) => {
          const { provider, labels, harness } = env;
          const source = new MemoryCreditSource([
            creditObservation(item.observation ?? {}),
          ]);
          const gate = env.creditGate(source, {
            faults: { beforeDispatch: () => item.change(harness, source) },
          });
          await gate.start();
          provider.plan(labels.id('a'), { kind: 'usage', actual: '30' });
          const result = await gate.run(
            claudeRequest(
              labels.id('a'),
              item.timeoutMs === undefined
                ? {}
                : { timeout_ms: item.timeoutMs },
            ),
            provider.send,
          );
          return {
            result: outcome(result),
            provider_requests: provider.receipts.length,
            rows: creditRowsView(env),
          };
        },
      );
    // 追加予約: 残高 20 XXX（40 XTS）で M 40 を受け付けた後は、追加の 20 を賄えない。
    const overRemaining = await world(ctx, {}, async (env) => {
      const { labels } = env;
      const source = new MemoryCreditSource([
        creditObservation({ balance: { currency: 'XXX', amount: '20' } }),
      ]);
      const gate = env.creditGate(source);
      await gate.start();
      const admitted = await gate.admit(claudeRequest(labels.id('a')));
      assert(admitted.ok);
      const topUp = await gate.topUp(admitted.ticket, {
        reserved: '20',
        max_liability: '20',
      });
      return {
        top_up: topUp.ok
          ? { ok: true }
          : { ok: false, reasons: [...topUp.reasons] },
        max_liability: reservationRows(env.harness).map(
          (row) => row.max_liability,
        ),
        credit: creditView(await gate.creditStatus()),
      };
    });
    // 同時の追加予約: 残高 70 XTS、M 20 の予約 2 つ（確保 40）で残り 30。追加の 20 を 2 件同時に求めると 1 件だけ通る。
    const concurrent = await world(
      ctx,
      { creditCap: { [CYCLE_OCT]: 70n } },
      async (env) => {
        const { labels } = env;
        const source = new MemoryCreditSource([
          creditObservation({ balance: { currency: 'XXX', amount: '35' } }),
        ]);
        const gate = env.creditGate(source);
        await gate.start();
        const small = {
          quantities: { input_tokens: '10', output_tokens: '10' },
        };
        const tickets = new Map();
        for (const label of ['x', 'y']) {
          const admitted = await gate.admit(
            claudeRequest(labels.id(label), small),
          );
          assert(admitted.ok);
          tickets.set(label, admitted.ticket);
        }
        const order = shuffled(['x', 'y'], ctx.seed);
        const results = await Promise.all(
          order.map((label) =>
            gate.topUp(tickets.get(label), {
              reserved: '20',
              max_liability: '20',
            }),
          ),
        );
        return {
          results: results
            .map((r) => (r.ok ? 'ok' : r.reasons.join(',')))
            .sort(),
          max_liability_total: reservationRows(env.harness)
            .reduce((sum, row) => sum + BigInt(row.max_liability), 0n)
            .toString(),
          credit: creditView(await gate.creditStatus()),
        };
      },
    );
    // 周期の終わりの後の追加予約と、クレジットの設定がない門からの追加予約は拒否する。
    const afterExpiry = await world(
      ctx,
      { start: CYCLE_END - 1 },
      async (env) => {
        const { labels, harness } = env;
        const source = new MemoryCreditSource([creditObservation()]);
        const gate = env.creditGate(source);
        await gate.start();
        const admitted = await gate.admit(claudeRequest(labels.id('a')));
        assert(admitted.ok);
        harness.clock.set(CYCLE_END);
        const late = await gate.topUp(admitted.ticket, {
          reserved: '10',
          max_liability: '10',
        });
        const plain = env.gate();
        const without = await plain.topUp(admitted.ticket, {
          reserved: '10',
          max_liability: '10',
        });
        return {
          after_the_cycle_ended: late.ok
            ? { ok: true }
            : { ok: false, reasons: [...late.reasons] },
          without_the_credit_setting: without.ok
            ? { ok: true }
            : { ok: false, reasons: [...without.reasons] },
          max_liability: reservationRows(harness).map(
            (row) => row.max_liability,
          ),
        };
      },
    );
    return {
      dispatch: results,
      top_up_over_the_remaining: overRemaining,
      concurrent_top_ups: concurrent,
      top_up_after_expiry: afterExpiry,
    };
  },

  // MA05（レビューの反映）: 採用した観測は永続化し、ファイルの巻き戻し・矛盾する観測・時計の巻き戻りで、一度確認した枯渇を
  // 取り消さない。観測がなくてクレジットを確認できない精算も、消費した分を、後の観測が届くまで残りから引き続ける。
  async 'MA05-observations-are-adopted-once'(ctx) {
    const rollback = await world(ctx, {}, async (env) => {
      const { labels, harness } = env;
      const t0 = creditObservation({
        shared: true,
        balance: { currency: 'XXX', amount: '20' },
      });
      const t1 = creditObservation({
        shared: true,
        observed_at: '2030-10-15T00:00:01.000Z',
        balance: { currency: 'XXX', amount: '0' },
      });
      const source = new MemoryCreditSource([t0, t1]);
      const gate = env.creditGate(source);
      await gate.start();
      harness.clock.set(OCT_15 + 2000);
      let n = 0;
      const attempt = async () => {
        n += 1;
        const result = await gate.admit(claudeRequest(labels.id(`h${n}`)));
        return result.ok ? 'admitted' : [...result.reasons];
      };
      const rowsAdopted = () =>
        harness.sql((db) =>
          db
            .prepare('SELECT count(*) FROM budget_credit_observations')
            .pluck()
            .get(),
        );
      const first = await attempt();
      const adoptedAfterFirst = rowsAdopted();
      source.observations = [t0];
      const rolledBackFile = await attempt();
      source.observations = [
        t0,
        { ...t1, balance: { currency: 'XXX', amount: '20' } },
        creditObservation({
          shared: true,
          observed_at: '2030-10-15T00:00:00.500Z',
          balance: { currency: 'XXX', amount: '50' },
        }),
      ];
      const conflictingAndOlder = await attempt();
      const adoptedAfterConflicts = rowsAdopted();
      source.observations = [t0, t1];
      harness.clock.set(OCT_15 + 500);
      const clockSetBack = await attempt();
      const balanceAfterClockBack = (await gate.creditStatus()).balance;
      harness.clock.set(OCT_15 + 5000);
      source.observations = [
        t0,
        t1,
        creditObservation({
          shared: true,
          observed_at: '2030-10-15T00:00:04.000Z',
          balance: { currency: 'XXX', amount: '30' },
        }),
      ];
      const resumed = await attempt();
      return {
        first_check: first,
        adopted_after_first_check: adoptedAfterFirst,
        file_rolled_back_to_the_old_observation: rolledBackFile,
        conflicting_and_older_observations: conflictingAndOlder,
        adopted_after_conflicts: adoptedAfterConflicts,
        clock_set_back: clockSetBack,
        balance_after_the_clock_was_set_back: balanceAfterClockBack,
        after_a_newer_observation: resumed,
        adopted_at_the_end: rowsAdopted(),
        rows: creditRowsView(env),
      };
    });
    // 精算の時にクレジットを確認できない（精算の前に、本人が残高を「不明」と書いた）: クレジット 0・追加の支出＝実費だが、消費の
    // 見積もり min(実費, M) は、後の観測が届くまで残りから引き続ける。精算より後に観測した残高は、消費を含むので引かない。
    const unconfirmed = await world(
      ctx,
      { creditCap: { [CYCLE_OCT]: 80n } },
      async (env) => {
        const { provider, labels, harness } = env;
        const source = new MemoryCreditSource([
          creditObservation({ balance: { currency: 'XXX', amount: '20' } }),
        ]);
        const gate = env.creditGate(source);
        await gate.start();
        provider.plan(labels.id('a'), { kind: 'usage', actual: '30' });
        const a = await admitAndSend(
          gate,
          provider,
          claudeRequest(labels.id('a')),
        );
        source.observations.push(
          creditObservation({
            observed_at: '2030-10-15T00:00:01.000Z',
            status: 'unknown',
            balance: null,
          }),
        );
        harness.clock.set(OCT_15 + 2000);
        const settled = await gate.settle(a.ticket, a.outcome);
        const held = (await gate.holdState()).credit_hold ?? null;
        source.observations.push(
          creditObservation({
            observed_at: '2030-10-15T00:00:01.500Z',
            balance: { currency: 'XXX', amount: '40' },
          }),
        );
        harness.clock.set(OCT_15 + 3000);
        const beforeSettlement = creditView(await gate.creditStatus());
        source.observations.push(
          creditObservation({
            observed_at: '2030-10-15T00:00:02.500Z',
            balance: { currency: 'XXX', amount: '40' },
          }),
        );
        harness.clock.set(OCT_15 + 4000);
        const afterSettlement = creditView(await gate.creditStatus());
        return {
          settled: settled.ok,
          rows: creditRowsView(env),
          estimates: reservationRows(harness).map((row) => row.credit_estimate),
          hold_after_the_unknown_observation: held,
          observation_made_before_the_settlement: beforeSettlement,
          observation_made_after_the_settlement: afterSettlement,
        };
      },
    );
    return {
      rollback_is_refused: rollback,
      unconfirmed_settlement_keeps_the_consumed_amount: unconfirmed,
    };
  },

  // MA06: 音声・Luna・検索に Claude のクレジットを充てない。本文・応答の実料金が不明なものを 0 円と確定しない。
  async 'MA06-credit-only-for-claude'(ctx) {
    const others = await world(ctx, {}, async (env) => {
      const { provider, labels } = env;
      // 観測がない状態でも、Claude の保留は音声・検索・Luna に及ばない。
      const source = new MemoryCreditSource([]);
      const gate = env.creditGate(source);
      await gate.start();
      const voiceRequest = (id) =>
        claudeRequest(id, {
          service: 'voice',
          price_key: 'synthetic.live',
          quantities: { live_seconds: '20' },
        });
      provider.plan(labels.id('voice'), { kind: 'usage', actual: '12' });
      const voice = await gate.run(
        voiceRequest(labels.id('voice')),
        provider.send,
      );
      provider.plan(labels.id('search'), { kind: 'usage', actual: '7' });
      const search = await gate.run(
        claudeRequest(labels.id('search'), { service: 'search' }),
        provider.send,
      );
      provider.plan(labels.id('luna'), { kind: 'usage', actual: '9' });
      const luna = await gate.run(owner(labels.id('luna')), provider.send);
      // 観測があっても同じ。クレジットの残りは動かない。
      source.observations = [creditObservation()];
      provider.plan(labels.id('voice2'), { kind: 'usage', actual: '11' });
      const voice2 = await gate.run(
        voiceRequest(labels.id('voice2')),
        provider.send,
      );
      const credit = creditView(await gate.creditStatus());
      // 周期に結び付かない予約へのクレジットは、手での精算でも記録しない。
      const manual = await env.harness.store.budget({
        kind: 'budget.settle_manual',
        reservation_id: voice2.ticket.reservation_id,
        expected_revision: voice2.ticket.revision,
        manual_reconciliation_id: 'manual:voice',
        currency: 'XTS',
        actual_gross: '11',
        credit_applied: '5',
        additional_spend: '6',
        credit_cycle_id: CYCLE_OCT,
        now: env.harness.clock.now(),
        request: null,
      });
      return {
        voice: outcome(voice),
        search: outcome(search),
        luna: outcome(luna),
        voice_with_an_observation: outcome(voice2),
        credit_untouched: credit,
        manual_credit_on_voice: manual.ok
          ? { ok: true }
          : { ok: false, reasons: [...manual.reasons] },
        rows: creditRowsView(env),
      };
    });
    const unknown = await world(
      ctx,
      { creditCap: { [CYCLE_OCT]: 100n } },
      async (env) => {
        const { provider, labels } = env;
        const source = new MemoryCreditSource([creditObservation()]);
        const gate = env.creditGate(source);
        await gate.start();
        // 応答を失った Claude の要求は usage 不明。実費を 0 と確定せず、クレジットを充てた扱いにもしない。
        provider.plan(labels.id('a'), { kind: 'drop', actual: '17' });
        const lost = await gate.run(
          claudeRequest(labels.id('a')),
          provider.send,
        );
        // 設定に credit がなければ、Claude の profile も初期の規則（クレジット 0・追加の支出＝実費・周期なし）。
        const plain = env.gate({ creditObservations: source });
        provider.plan(labels.id('b'), { kind: 'usage', actual: '14' });
        const initial = await plain.run(
          claudeRequest(labels.id('b')),
          provider.send,
        );
        return {
          lost_response: outcome(lost),
          without_the_credit_setting: outcome(initial),
          status_without_the_setting: creditView(await plain.creditStatus()),
          rows: creditRowsView(env),
          credit: creditView(await gate.creditStatus()),
        };
      },
    );
    return { not_credited: others, unknown_is_not_zero: unknown };
  },

  // 失敗: provider の例外は usage 不明で M を保持し送り直さない。送る前の中断と期限切れは解放し、provider へ送らない。
  async 'B07-failure-paths'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      provider.plan(labels.id('a'), { kind: 'throw' });
      const a = await gate.run(owner(labels.id('a')), provider.send);
      const abort = new AbortController();
      abort.abort();
      const b = await gate.run(owner(labels.id('b')), provider.send, {
        signal: abort.signal,
      });
      // 送出意図の前に応答の期限に達する（受付から 60 秒後）。
      const expiring = env.gate({
        faults: {
          beforeDispatch: () => harness.clock.set(harness.clock.now() + 60_000),
        },
      });
      const c = await expiring.run(owner(labels.id('c')), provider.send);
      const resend = await gate.run(owner(labels.id('a')), provider.send);
      const receiptsAfterResend = provider.receipts.length;
      provider.plan(labels.id('e'), { kind: 'usage', actual: '25' });
      const e = await gate.run(owner(labels.id('e')), provider.send);
      return {
        provider_throws: outcome(a),
        aborted_before_dispatch: outcome(b),
        deadline_before_dispatch: outcome(c),
        resend_same_request: outcome(resend),
        receipts_after_resend: receiptsAfterResend,
        new_request: outcome(e),
        rows: rowsView(env),
        llm: await usage(harness, '2030-10', 'llm'),
      };
    });
  },

  // 精算の重複: 同時の同じ精算は一度だけ、違う値・照合 ID の使い回しは拒否、手での精算も一度だけ。
  async 'B07-settlement-once'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const gate = env.gate();
      await gate.start();
      const view = (result) =>
        result.ok
          ? { ok: true, duplicate: result.duplicate }
          : { ok: false, reasons: [...result.reasons] };
      provider.plan(labels.id('a'), { kind: 'usage', actual: '15' });
      const a = await admitAndSend(gate, provider, owner(labels.id('a')));
      const same = await Promise.all(
        [1, 2, 3, 4, 5].map(() => gate.settle(a.ticket, a.outcome)),
      );
      provider.plan(labels.id('b'), { kind: 'usage', actual: '12' });
      const b = await admitAndSend(gate, provider, owner(labels.id('b')));
      const first = await gate.settle(b.ticket, b.outcome);
      const conflict = await gate.settle(b.ticket, {
        ...b.outcome,
        actual_gross: '13',
      });
      // c: 別の予約の照合 ID を使い回した精算は拒否し、自分の照合 ID なら精算できる。
      provider.plan(labels.id('c'), { kind: 'usage', actual: '9' });
      const c = await admitAndSend(gate, provider, owner(labels.id('c')));
      const reused = await gate.settle(c.ticket, {
        ...c.outcome,
        reconciliation_id: a.outcome.reconciliation_id,
      });
      const own = await gate.settle(c.ticket, c.outcome);
      // d: 応答を失った予約は、手での精算を同時に 3 回行っても一度だけ。後から届いた provider の精算は拒否する。
      provider.plan(labels.id('d'), { kind: 'drop', actual: '8' });
      const d = await gate.run(owner(labels.id('d')), provider.send);
      assert.equal(d.kind, 'usage_unknown');
      const manual = () =>
        harness.store.budget({
          kind: 'budget.settle_manual',
          reservation_id: d.ticket.reservation_id,
          expected_revision: d.ticket.revision,
          manual_reconciliation_id: 'manual:inv-d',
          currency: 'XTS',
          actual_gross: '8',
          now: harness.clock.now(),
          request: null,
        });
      const manuals = await Promise.all([manual(), manual(), manual()]);
      const late = await provider.reconciler.lookup({
        request_id: labels.id('d'),
        reservation_id: d.ticket.reservation_id,
      });
      const providerLate = await gate.settle(d.ticket, late);
      return {
        same_usage_five_times: {
          ok: same.filter((r) => r.ok).length,
          fresh: same.filter((r) => r.ok && !r.duplicate).length,
          duplicate: same.filter((r) => r.ok && r.duplicate).length,
        },
        different_amount_for_settled: view(conflict),
        first_settlement: view(first),
        reconciliation_id_of_another_reservation: view(reused),
        own_reconciliation_id: view(own),
        manual_three_times: {
          ok: manuals.filter((r) => r.ok).length,
          fresh: manuals.filter((r) => r.ok && !r.value.duplicate).length,
          duplicate: manuals.filter((r) => r.ok && r.value.duplicate).length,
        },
        provider_after_manual: view(providerLate),
        llm: await usage(harness, '2030-10', 'llm'),
      };
    });
  },

  // 失敗・再起動: 受付中の予約は、送出意図がなければ解放、あれば provider の記録で精算・分からなければ usage 不明。
  // provider へは送り直さない。
  async 'B07-restart-reconcile'(ctx) {
    return world(ctx, {}, async (env) => {
      const { provider, labels, harness } = env;
      const before = env.gate();
      await before.start();
      const tickets = [];
      for (const [label, overrides] of [
        ['r1', {}],
        ['r2', {}],
        ['r3', { service: 'search' }],
      ]) {
        const admitted = await before.admit(owner(labels.id(label), overrides));
        assert(admitted.ok);
        tickets.push(admitted.ticket);
      }
      // r2: 送出意図の後に provider へ届き、provider は usage 17 を記録したが、応答の前に中枢が止まった。
      // r3: 送出意図の後に止まった（provider は受信していない）。
      for (const ticket of tickets.slice(1))
        assert.deepEqual(await before.dispatch(ticket), { ok: true });
      provider.recordWithoutResponse(
        labels.id('r2'),
        tickets[1].reservation_id,
        '17',
      );
      await harness.restart();
      const after = env.gate();
      const report = await after.start(provider.reconciler);
      const rows = rowsView(env);
      const second = await after.reconcile(provider.reconciler);
      const resend = await after.run(owner(labels.id('r2')), provider.send);
      return {
        report,
        rows,
        receipts_after_restart: provider.receipts.length,
        second_reconcile: second,
        resend_same_request: outcome(resend),
        llm: await usage(harness, '2030-10', 'llm'),
        search: await usage(harness, '2030-10', 'search'),
      };
    });
  },
};

// ケースを 1 回実行し、手書きの期待値と照合する。戻り値は証拠に残す観測。
export async function runCase(spec, seed, round) {
  assertPoolTable(specification.pools);
  const run = cases[spec.id];
  assert(run !== undefined, `未登録のケース: ${spec.id}`);
  const ctx = { seed, round, ledgers: [] };
  const checked = await run(ctx);
  // POSIX の権限の確認は Windows では行わない（その場合だけ期待値から外す）。
  const expected = structuredClone(spec.expected);
  if (process.platform === 'win32') delete expected.posix_only;
  assert.deepEqual(checked, expected, `${spec.id} seed=${seed}`);
  const ledgers = ctx.ledgers;
  return {
    checked,
    ledgers,
    provider_requests: ledgers.reduce((n, l) => n + l.provider_requests, 0),
    provider_state_changes: ledgers.reduce(
      (n, l) => n + l.provider_state_changes,
      0,
    ),
    approvals: ledgers.reduce((n, l) => n + l.approvals, 0),
    final_state: ledgers.map((l) => l.final_state).join(' | '),
    db_version: specification.db_version,
  };
}
