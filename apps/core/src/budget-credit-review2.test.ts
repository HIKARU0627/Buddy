// PR #149 の Codex の再確認（P1 5 件・P2 1 件・P3 2 件）の再現を、手書きの期待値の回帰試験にする（B07-07、ADR 0042）。
// 観測の採用は予約の判定と別の transaction で先に確定する（P1-1）、判定の時刻は観測を読んだ後に取り、送る直前まで失効を守る
// （P1-2）、消費の控除は壁時計ではなく採用の連番で解く（P1-3）、割り当てが 0 でも消費の見積もりは残る（P1-4）、送出直前に残りが
// 足りなくて解放した要求の再開を知らせる（P2-6）、観測の読み込みの待ち時間に上限がある（P3）。期待値は合成の設定（予算の通貨
// XTS、残高の通貨 XXX は換算 2、M = 入力 10 + 出力の上限 30 = 40）から手で書いた値で、実装の処理から作っていない。
// 模擬の試験だけで、実 API・実請求は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqliteDatabase } from '@buddy/storage';
import type { BudgetResumeEvent } from './budget-gate.js';
import {
  ManualTimers,
  MemoryCreditSource,
  MockPaidProvider,
  OCT_15,
  claudeRequest,
  creditConfig,
  creditObservation,
  loadedConfig,
  uuid,
  withBudgetStore,
} from './budget-test-support.js';
import type { BudgetHarness } from './budget-test-support.js';

const TIMEOUT = { timeout: 60_000 };
// 残高 1 XXX は 2 XTS。
const xxx = (amount: string) => ({ currency: 'XXX', amount });
const at = (seconds: number): string =>
  new Date(OCT_15 + seconds * 1000).toISOString();

function ids(start = 7000): () => string {
  let next = start;
  return () => uuid(next++);
}

function creditGate(
  harness: BudgetHarness,
  source: MemoryCreditSource,
  options: Parameters<BudgetHarness['gate']>[0] = {},
) {
  return harness.gate({
    config: loadedConfig(creditConfig()),
    creditObservations: source,
    newId: ids(),
    ...options,
  });
}

interface Row {
  request_id: string;
  status: string;
  max_liability: number;
  actual_gross: number | null;
  credit_applied: number | null;
  additional_spend: number | null;
  credit_estimate: number;
}

const rowOf = (harness: BudgetHarness, requestId: string): Row => {
  const found = harness.sql(
    (db: SqliteDatabase) =>
      db
        .prepare(
          'SELECT request_id, status, max_liability, actual_gross, credit_applied, additional_spend, credit_estimate FROM budget_reservations WHERE request_id = ?',
        )
        .get(requestId) as Row | undefined,
  );
  assert(found !== undefined, requestId);
  return found;
};

const observationRows = (harness: BudgetHarness): number =>
  harness.sql(
    (db: SqliteDatabase) =>
      db
        .prepare('SELECT count(*) FROM budget_credit_observations')
        .pluck()
        .get() as number,
  );

async function admitted(
  gate: ReturnType<typeof creditGate>,
  request: ReturnType<typeof claudeRequest>,
) {
  const result = await gate.admit(request);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('not admitted');
  return result.ticket;
}

const usage = (actual: string, id: string) =>
  ({
    kind: 'usage',
    provider: 'mockpaid',
    reconciliation_id: id,
    actual_gross: actual,
  }) as const;

// --- P1-1: 拒否した判定でも、判定に使った新しい観測は残る ---

test(
  'P1-1: a refused dispatch and a refused top-up keep the newer observation that decided them, so putting the old file back lets nothing through',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      // 残高 20 XXX = 40 XTS で M 40 を受け付ける。
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('20') }),
      ]);
      const gate = creditGate(harness, source);
      await gate.start();
      const ticket = await admitted(gate, claudeRequest(uuid(1)));
      assert.equal(observationRows(harness), 1);
      // 本人が残高 0 の新しい観測（1 秒後）を書いた。送出は拒否される。
      source.observations.push(
        creditObservation({ observed_at: at(1), balance: xxx('0') }),
      );
      harness.clock.set(OCT_15 + 2000);
      assert.deepEqual(await gate.dispatch(ticket), {
        ok: false,
        reasons: ['credit_exhausted'],
        uncertain: false,
      });
      // 拒否した後も、新しい観測は採用済み（以前は判定と一緒に巻き戻って、残高 40 だけが残った）。
      assert.equal(observationRows(harness), 2);
      // ファイルを元（残高 40 XTS だけ）に戻しても、同じ予約の送出は拒否される。
      source.observations = [creditObservation({ balance: xxx('20') })];
      assert.deepEqual(await gate.dispatch(ticket), {
        ok: false,
        reasons: ['credit_exhausted'],
        uncertain: false,
      });
      // 追加予約も同じ。
      assert.deepEqual(
        await gate.topUp(ticket, { reserved: '1', max_liability: '1' }),
        { ok: false, reasons: ['credit_exhausted'] },
      );
      assert.equal(observationRows(harness), 2);
      assert.equal(rowOf(harness, uuid(1)).status, 'reserved');
    });
  },
);

test(
  'P1-1: a refused admission keeps the newer observation too',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('20') }),
      ]);
      const gate = creditGate(harness, source);
      await gate.start();
      // 残高 0 の新しい観測で、受付は止まる。
      source.observations.push(
        creditObservation({ observed_at: at(1), balance: xxx('0') }),
      );
      harness.clock.set(OCT_15 + 2000);
      const held = await gate.admit(claudeRequest(uuid(1)));
      assert.deepEqual(held.ok ? 'admitted' : held.reasons, [
        'credit_exhausted',
      ]);
      // ファイルを戻しても、受付は止まったまま。
      source.observations = [creditObservation({ balance: xxx('20') })];
      const again = await gate.admit(claudeRequest(uuid(2)));
      assert.deepEqual(again.ok ? 'admitted' : again.reasons, [
        'credit_exhausted',
      ]);
    });
  },
);

// --- P1-2: 観測を読んだ後の時刻で検査し、送る直前まで失効を守る ---

test(
  'P1-2: a credit that expires while the observation file is being read is not sent (Codex reproduction)',
  TIMEOUT,
  async () => {
    await withBudgetStore(
      async (harness) => {
        // 失効は 3 秒後、受付と送出の開始は 2 秒後。
        const source = new MemoryCreditSource([
          creditObservation({ expires_at: at(3) }),
        ]);
        const gate = creditGate(harness, source);
        await gate.start();
        const ticket = await admitted(gate, claudeRequest(uuid(1)));
        // 観測を読んでいる間に時計が 3 秒後へ進む。判定の時刻は読んだ後に取るので、失効として拒否する。
        source.beforeRead = () => {
          harness.clock.set(OCT_15 + 3000);
          return Promise.resolve();
        };
        assert.deepEqual(await gate.dispatch(ticket), {
          ok: false,
          reasons: ['credit_expired'],
          uncertain: false,
        });
        assert.equal(rowOf(harness, uuid(1)).status, 'reserved');
      },
      { start: OCT_15 + 2000 },
    );
  },
);

test(
  'P1-2: a credit that expires after the dispatch intent but before the provider call is not sent either, and the reservation is kept as usage unknown',
  TIMEOUT,
  async () => {
    await withBudgetStore(
      async (harness) => {
        const provider = new MockPaidProvider();
        const source = new MemoryCreditSource([
          creditObservation({ expires_at: at(3) }),
        ]);
        const gate = creditGate(harness, source, {
          // 送出意図を記録した後、send を呼ぶ前に時計が失効の時刻へ進む。
          faults: { afterDispatch: () => harness.clock.set(OCT_15 + 3000) },
        });
        await gate.start();
        provider.plan(uuid(1), { kind: 'usage', actual: '30' });
        const result = await gate.run(claudeRequest(uuid(1)), provider.send);
        assert.equal(result.kind, 'usage_unknown');
        assert.deepEqual(
          result.kind === 'usage_unknown' ? result.reasons : [],
          ['credit_expired', 'not_sent'],
        );
        assert.equal(provider.receipts.length, 0);
        assert.equal(rowOf(harness, uuid(1)).status, 'usage_unknown');
      },
      { start: OCT_15 + 2000 },
    );
  },
);

// --- P1-3: 時計を戻した後の消費も、採用の連番で台帳から引く ---

test(
  'P1-3: a settlement made after the clock was set back is still deducted, because the order of adoption decides it',
  TIMEOUT,
  async () => {
    await withBudgetStore(
      async (harness) => {
        // 2 秒後に観測した残高 20 XXX = 40 XTS を、3 秒後に採用して M 40 を受け付ける。
        const source = new MemoryCreditSource([
          creditObservation({ observed_at: at(2), balance: xxx('20') }),
        ]);
        const gate = creditGate(harness, source);
        await gate.start();
        const ticket = await admitted(gate, claudeRequest(uuid(1)));
        // 時計が 1 秒後へ戻った。実費 30 で精算する。
        harness.clock.set(OCT_15 + 1000);
        assert.equal((await gate.settle(ticket, usage('30', 'p-1'))).ok, true);
        const row = rowOf(harness, uuid(1));
        assert.deepEqual(
          [row.credit_applied, row.additional_spend, row.credit_estimate],
          [30, 0, 30],
        );
        // 残り = 40 − 30 = 10（壁時計だけで引くと、精算の時刻が観測より前になって控除が消え、40 に戻っていた）。
        harness.clock.set(OCT_15 + 1500);
        const status = await gate.creditStatus();
        assert.equal(status.available, '10');
        const next = await gate.admit(claudeRequest(uuid(2)));
        assert.deepEqual(next.ok ? 'admitted' : next.reasons, [
          'credit_insufficient',
        ]);
      },
      { start: OCT_15 + 3000 },
    );
  },
);

// --- P1-4: 割り当てが 0 でも、消費の見積もりは残る ---

test(
  'P1-4: a request that was given no credit because another reservation held the remainder still counts what it consumed',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      // 残高 50 XXX = 100 XTS で、A・B を M 40 で受け付け、A を送る。
      const source = new MemoryCreditSource([creditObservation()]);
      const gate = creditGate(harness, source);
      await gate.start();
      const a = await admitted(gate, claudeRequest(uuid(1)));
      const b = await admitted(gate, claudeRequest(uuid(2)));
      assert.deepEqual(await gate.dispatch(a), { ok: true });
      // 他の用途の消費の後、本人が残高 20 XXX = 40 XTS を観測した（1 秒後）。
      source.observations.push(
        creditObservation({ observed_at: at(1), balance: xxx('20') }),
      );
      harness.clock.set(OCT_15 + 2000);
      // A が 30 を消費して精算する。残り = 40 − 台帳 0 − B の M 40 = 0 なので割り当ては 0・追加の支出 30。見積もりは 30。
      assert.equal((await gate.settle(a, usage('30', 'p-1'))).ok, true);
      const row = rowOf(harness, uuid(1));
      assert.deepEqual(
        [row.credit_applied, row.additional_spend, row.credit_estimate],
        [0, 30, 30],
      );
      // 未送信の B を解放する。残り = 40 − 30 = 10。次の M 40 は収まらない（以前は 40 に戻って受け付けた）。
      assert.equal((await gate.release(b)).ok, true);
      assert.equal((await gate.creditStatus()).available, '10');
      const next = await gate.admit(claudeRequest(uuid(3)));
      assert.deepEqual(next.ok ? 'admitted' : next.reasons, [
        'credit_insufficient',
      ]);
    });
  },
);

// --- P2-6: 送出直前に残りが足りなくて解放した要求 ---

test(
  'P2-6: a request released at dispatch because the remaining credit no longer covered its M is told once when the balance recovers',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('20') }),
      ]);
      const gate = creditGate(harness, source, {
        // 受付の後・送る直前に、残高が 10 XXX = 20 XTS へ減る。
        faults: {
          beforeDispatch: () => {
            source.observations.push(
              creditObservation({ observed_at: at(1), balance: xxx('10') }),
            );
            harness.clock.set(OCT_15 + 2000);
          },
        },
      });
      await gate.start();
      const events: BudgetResumeEvent['kind'][] = [];
      gate.onResumable((event) => events.push(event.kind));
      const result = await gate.run(claudeRequest(uuid(1)), provider.send);
      assert.deepEqual(result, {
        kind: 'released',
        reasons: ['credit_exhausted'],
      });
      assert.equal(provider.receipts.length, 0);
      // 解放した後の保留の状態は、残りが正なので保留なし。それでも要求の必要な M を待つ。
      assert.equal((await gate.holdState()).held, false);
      await gate.tick();
      assert.deepEqual(events, []);
      // 残高が 20 XXX = 40 XTS へ回復して M 40 に足りる。一度だけ知らせる。
      source.observations.push(
        creditObservation({ observed_at: at(3), balance: xxx('20') }),
      );
      harness.clock.set(OCT_15 + 4000);
      await gate.tick();
      await gate.tick();
      assert.deepEqual(events, ['credit_resumed']);
    });
  },
);

// --- P3: 観測の読み込みの待ち時間 ---

test(
  'P3: a read of the observation file that never returns stops waiting at the limit, the later checks go on, and the late result is never adopted',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const timers = new ManualTimers();
      const source = new MemoryCreditSource([creditObservation()]);
      const gate = creditGate(harness, source, {
        timers,
        creditReadTimeoutMs: 5,
      });
      await gate.start();
      // 起動の確認は読めて採用した。待ち時間の timer は読めた時に取り消す。
      assert.equal(observationRows(harness), 1);
      assert.equal(timers.size, 0);
      // 次の読み込みが止まる。この読み込みが持つ観測は残高 5 XXX の新しい観測（採用してはいけない）。
      source.observations.push(
        creditObservation({ observed_at: at(1), balance: xxx('5') }),
      );
      harness.clock.set(OCT_15 + 2000);
      let release: () => void = () => undefined;
      source.beforeRead = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const reads = source.reads;
      const stuck = gate.tick();
      while (source.reads === reads)
        await new Promise((resolve) => setImmediate(resolve));
      // 待ち時間（5 ミリ秒）の timer が発火して、観測なしとして続ける。確認は終わる。
      assert.deepEqual(timers.delays.slice(-1), [5]);
      timers.fireAll();
      assert.equal(await stuck, true);
      // 続く確認は、止まった読み込みを待たない。
      source.beforeRead = null;
      assert.equal(await gate.tick(), true);
      // 遅れて届いた結果は採用しない。続く確認が読んだ同じ観測は採用する（連番 2）。
      release();
      await gate.idle();
      assert.equal(observationRows(harness), 2);
      const status = await gate.creditStatus();
      // 5 XXX は予算の通貨で 10 XTS。
      assert.equal(status.balance, '10');
    });
  },
);
