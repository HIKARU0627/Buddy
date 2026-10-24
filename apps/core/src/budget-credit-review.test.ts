// PR #149 の Codex のレビュー（P1 4 件・P2 2 件）の再現を、手書きの期待値の回帰試験にする（B07-07、ADR 0042）。
// 追加予約・送出の直前のクレジットの検査、観測の採用と巻き戻りの拒否、未照合の消費の見積もり、確認の直列化、残高が足りずに
// 保留した要求の再開の通知。期待値は合成の設定（予算の通貨 XTS、残高の通貨 XXX は換算 2、M = 入力 10 + 出力の上限 30 = 40）
// から手で書いた値で、実装の処理から作っていない。模擬の試験だけで、実 API・実請求は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqliteDatabase } from '@buddy/storage';
import type { BudgetResumeEvent } from './budget-gate.js';
import {
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
const EXPIRY = Date.parse('2030-11-01T00:00:00.000Z');
// 残高 1 XXX は 2 XTS。
const xxx = (amount: string) => ({ currency: 'XXX', amount });

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
  reserved_amount: number;
  max_liability: number;
  reservation_revision: number;
  actual_gross: number | null;
  credit_applied: number | null;
  additional_spend: number | null;
  credit_estimate: number;
  credit_cycle_id: string | null;
}

const rows = (harness: BudgetHarness): Row[] =>
  harness.sql(
    (db: SqliteDatabase) =>
      db
        .prepare(
          'SELECT request_id, status, reserved_amount, max_liability, reservation_revision, actual_gross, credit_applied, additional_spend, credit_estimate, credit_cycle_id FROM budget_reservations ORDER BY created_at, request_id',
        )
        .all() as Row[],
  );

const rowOf = (harness: BudgetHarness, requestId: string): Row => {
  const found = rows(harness).find((row) => row.request_id === requestId);
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

// --- P1-1: 追加予約でもクレジットを検査する ---

test(
  'P1-1: a top-up cannot take more M than the remaining credit, and the reservation is left as it was',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      // 残高 20 XXX = 40 XTS。M 40 を受け付けた後は、追加の 20 は賄えない（以前は成功して M が 60 になった）。
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('20') }),
      ]);
      const gate = creditGate(harness, source);
      await gate.start();
      const ticket = await admitted(gate, claudeRequest(uuid(1)));
      assert.deepEqual(
        await gate.topUp(ticket, { reserved: '20', max_liability: '20' }),
        { ok: false, reasons: ['credit_exhausted'] },
      );
      const row = rowOf(harness, uuid(1));
      assert.deepEqual(
        [
          row.status,
          row.reserved_amount,
          row.max_liability,
          row.reservation_revision,
        ],
        ['reserved', 40, 40, 1],
      );
    });
  },
);

test(
  'P1-1: concurrent top-ups share the remaining credit once, and only the ones that fit are applied',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      // 残高 35 XXX = 70 XTS。M 20 の予約が 2 つ（確保 40）で、残り 30。追加の 20 を 2 件同時に求めると 1 件だけ通る。
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('35') }),
      ]);
      const gate = creditGate(harness, source);
      await gate.start();
      const small = { quantities: { input_tokens: '10', output_tokens: '10' } };
      const a = await admitted(gate, claudeRequest(uuid(1), small));
      const b = await admitted(gate, claudeRequest(uuid(2), small));
      const results = await Promise.all([
        gate.topUp(a, { reserved: '20', max_liability: '20' }),
        gate.topUp(b, { reserved: '20', max_liability: '20' }),
      ]);
      assert.deepEqual(
        results
          .map((result) => (result.ok ? 'ok' : result.reasons.join(',')))
          .sort(),
        ['credit_insufficient', 'ok'],
      );
      const total = rows(harness).reduce(
        (sum, row) => sum + row.max_liability,
        0,
      );
      assert.equal(total, 60);
      assert.equal((await gate.creditStatus()).outstanding, '60');
      assert.equal((await gate.creditStatus()).available, '10');
    });
  },
);

test(
  'P1-1: a top-up after the cycle ended, or without the credit setting, is refused',
  TIMEOUT,
  async () => {
    await withBudgetStore(
      async (harness) => {
        const source = new MemoryCreditSource([creditObservation()]);
        const gate = creditGate(harness, source);
        await gate.start();
        // 周期の終わりの 1 ミリ秒前に受け付け、終わりちょうどに追加を求める。
        const ticket = await admitted(gate, claudeRequest(uuid(1)));
        harness.clock.set(EXPIRY);
        assert.deepEqual(
          await gate.topUp(ticket, { reserved: '10', max_liability: '10' }),
          { ok: false, reasons: ['credit_expired'] },
        );
        // クレジットの設定がない門からは、周期に結び付いた予約の追加予約を確認できないので拒否する。
        const plain = harness.gate({ newId: ids(9000) });
        assert.deepEqual(
          await plain.topUp(ticket, { reserved: '10', max_liability: '10' }),
          { ok: false, reasons: ['credit_unknown'] },
        );
        assert.equal(rowOf(harness, uuid(1)).max_liability, 40);
      },
      { start: EXPIRY - 1 },
    );
  },
);

// --- P1-2: 送出の直前にクレジットを確かめ直す ---

const DISPATCH_CASES: readonly {
  readonly title: string;
  readonly reasons: readonly string[];
  // 受付の後・送る直前に起こること（時計と観測）。
  readonly change: (harness: BudgetHarness, source: MemoryCreditSource) => void;
  readonly observation?: Parameters<typeof creditObservation>[0];
  readonly start?: number;
  // 応答の期限（既定の 60 秒では、送る直前に時計を大きく進められない）。
  readonly timeoutMs?: number;
}[] = [
  {
    title:
      'the credit expires between admission and sending (Codex reproduction)',
    reasons: ['credit_expired'],
    start: OCT_15 + 2000,
    observation: { expires_at: '2030-10-15T00:00:03.000Z' },
    change: (harness) => harness.clock.set(OCT_15 + 3000),
  },
  {
    title: 'the balance drops below what is reserved',
    reasons: ['credit_exhausted'],
    change: (harness, source) => {
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-15T00:00:01.000Z',
          balance: xxx('10'),
        }),
      );
      harness.clock.set(OCT_15 + 2000);
    },
  },
  {
    title: 'the balance becomes unknown',
    reasons: ['credit_unknown'],
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
  {
    title: 'a shared observation is older than the limit',
    reasons: ['credit_stale'],
    observation: { shared: true },
    timeoutMs: 7_200_000,
    change: (harness) => harness.clock.set(OCT_15 + 3_600_001),
  },
];

for (const item of DISPATCH_CASES)
  test(
    `P1-2: the credit is verified again right before sending, and nothing is sent when it fails: ${item.title}`,
    TIMEOUT,
    async () => {
      await withBudgetStore(
        async (harness) => {
          const provider = new MockPaidProvider();
          const source = new MemoryCreditSource([
            creditObservation(item.observation ?? {}),
          ]);
          const gate = creditGate(harness, source, {
            faults: { beforeDispatch: () => item.change(harness, source) },
          });
          await gate.start();
          provider.plan(uuid(1), { kind: 'usage', actual: '30' });
          const result = await gate.run(
            claudeRequest(
              uuid(1),
              item.timeoutMs === undefined
                ? {}
                : { timeout_ms: item.timeoutMs },
            ),
            provider.send,
          );
          // 送らず、送出意図を記録せず、未送信として解放する（購入残高・後払いへ移らない）。
          assert.deepEqual(result, { kind: 'released', reasons: item.reasons });
          assert.equal(provider.receipts.length, 0);
          assert.equal(rowOf(harness, uuid(1)).status, 'released');
        },
        { start: item.start ?? OCT_15 },
      );
    },
  );

test(
  'P1-2: a reservation that is still covered is sent once, and one bound to a cycle cannot be sent by a gate without the credit setting',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([creditObservation()]);
      const gate = creditGate(harness, source);
      await gate.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '30' });
      assert.equal(
        (await gate.run(claudeRequest(uuid(1)), provider.send)).kind,
        'settled',
      );
      assert.equal(provider.receipts.length, 1);
      const ticket = await admitted(gate, claudeRequest(uuid(2)));
      const plain = harness.gate({ newId: ids(9000) });
      assert.deepEqual(await plain.dispatch(ticket), {
        ok: false,
        reasons: ['credit_unknown'],
        uncertain: false,
      });
    });
  },
);

// --- P1-3: 未照合の消費の見積もり ---

test(
  'P1-3: a settlement that could not confirm the credit keeps the consumed amount deducted until an observation made after it arrives',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      // 残高 20 XXX = 40 XTS。M 40 を受け付け、provider は実費 30 を消費した。
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('20') }),
      ]);
      const gate = creditGate(harness, source);
      await gate.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '30' });
      const ticket = await admitted(gate, claudeRequest(uuid(1)));
      // 精算の前に、本人が残高を「不明」と書いた。精算ではクレジットを確認できないので、クレジット 0・追加の支出＝実費だが、
      // 消費の見積もり min(30, M 40) = 30 は残す。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-15T00:00:01.000Z',
          status: 'unknown',
          balance: null,
        }),
      );
      harness.clock.set(OCT_15 + 2000);
      const sent = await provider.send({
        request_id: uuid(1),
        reservation_id: ticket.reservation_id,
        signal: new AbortController().signal,
      });
      assert.equal(
        (await gate.settle(ticket, sent as Parameters<typeof gate.settle>[1]))
          .ok,
        true,
      );
      const row = rowOf(harness, uuid(1));
      assert.deepEqual(
        [
          row.actual_gross,
          row.credit_applied,
          row.additional_spend,
          row.credit_estimate,
        ],
        [30, 0, 30, 30],
      );
      assert.equal((await gate.creditStatus()).hold, 'credit_unknown');
      // 精算の前（+1.5 秒）に観測した残高 40 XXX = 80 XTS は、精算の見積もり 30 を引く（残り 50）。以前は引かずに 80。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-15T00:00:01.500Z',
          balance: xxx('40'),
        }),
      );
      harness.clock.set(OCT_15 + 3000);
      const before = await gate.creditStatus();
      assert.deepEqual(
        [before.balance, before.allocated_since, before.available],
        ['80', '30', '50'],
      );
      // 精算の後（+2.5 秒）に観測した残高 40 XXX は、観測に消費が含まれているので、そのまま 80。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-15T00:00:02.500Z',
          balance: xxx('40'),
        }),
      );
      harness.clock.set(OCT_15 + 4000);
      const after = await gate.creditStatus();
      assert.deepEqual(
        [after.balance, after.allocated_since, after.available],
        ['80', '0', '80'],
      );
    });
  },
);

test(
  'P1-3: omitting the file at settlement no longer lets the consumed balance be reused (Codex reproduction)',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const provider = new MockPaidProvider();
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('20') }),
      ]);
      const gate = creditGate(harness, source);
      await gate.start();
      provider.plan(uuid(1), { kind: 'usage', actual: '30' });
      const result = await gate.run(claudeRequest(uuid(1)), (context) => {
        source.failure = 'missing';
        return provider.send(context);
      });
      assert.equal(result.kind, 'settled');
      // ファイルを戻しても、残り 40 − 30 = 10。M 40 は収まらない（以前は 40 に戻って受け付けた）。
      source.failure = null;
      const again = await gate.admit(claudeRequest(uuid(2)));
      assert.deepEqual(again.ok ? 'admitted' : again.reasons, [
        'credit_insufficient',
      ]);
    });
  },
);

// --- P1-4: 観測の巻き戻りの拒否 ---

test(
  'P1-4: a confirmed exhaustion is not undone by a rolled-back file, a conflicting observation or a clock set back (Codex reproduction)',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const t0 = creditObservation({ shared: true, balance: xxx('20') });
      const t1 = creditObservation({
        shared: true,
        observed_at: '2030-10-15T00:00:01.000Z',
        balance: xxx('0'),
      });
      const source = new MemoryCreditSource([t0, t1]);
      const gate = creditGate(harness, source);
      await gate.start();
      harness.clock.set(OCT_15 + 2000);
      const exhausted = async () => {
        const result = await gate.admit(claudeRequest(uuid(1)));
        return result.ok ? 'admitted' : result.reasons;
      };
      assert.deepEqual(await exhausted(), ['credit_exhausted']);
      assert.equal(observationRows(harness), 2);
      // ファイルを古い観測だけに戻しても、採用済みの残高 0 のまま。
      source.observations = [t0];
      assert.deepEqual(await exhausted(), ['credit_exhausted']);
      // 同じ時刻で残高の違う観測（矛盾）と、採用済みより古い時刻の観測（巻き戻り）は採用しない。
      source.observations = [
        t0,
        { ...t1, balance: xxx('20') },
        creditObservation({
          shared: true,
          observed_at: '2030-10-15T00:00:00.500Z',
          balance: xxx('50'),
        }),
      ];
      assert.deepEqual(await exhausted(), ['credit_exhausted']);
      assert.equal(observationRows(harness), 2);
      // 同じ月の中で時計を戻しても、採用済みの観測を「未来」として捨てて古い残高 40 へ戻らない。
      source.observations = [t0, t1];
      harness.clock.set(OCT_15 + 500);
      assert.deepEqual(await exhausted(), ['credit_exhausted']);
      assert.equal((await gate.creditStatus()).balance, '0');
      // 本人が新しい残高を書けば再開する（採用済みの時刻より後）。
      harness.clock.set(OCT_15 + 5000);
      source.observations = [
        t0,
        t1,
        creditObservation({
          shared: true,
          observed_at: '2030-10-15T00:00:04.000Z',
          balance: xxx('30'),
        }),
      ];
      assert.equal((await gate.admit(claudeRequest(uuid(2)))).ok, true);
    });
  },
);

// --- P2-5: 確認の直列化 ---

test(
  'P2-5: concurrent checks never overwrite a newer result with an older one, so a resume is told once',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const source = new MemoryCreditSource([]);
      const gate = creditGate(harness, source);
      await gate.start();
      const events: BudgetResumeEvent['kind'][] = [];
      gate.onResumable((event) => events.push(event.kind));
      // 確認 A は古い「観測なし」を読んだところで待たされる。その間に観測が書かれ、確認 B が始まる。
      let release: () => void = () => undefined;
      source.beforeRead = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const a = gate.tick();
      // A が読み始めるまで待つ。
      while (source.reads < 2)
        await new Promise((resolve) => setImmediate(resolve));
      source.beforeRead = null;
      source.observations = [creditObservation()];
      const b = gate.tick();
      // 確認は直列なので、A が済むまで B は観測を読み始めない（直列でない実装では B が先に読み終わり、古い A の結果が後から
      // 状態を上書きし得る）。B が動き出すだけの時間（上限 200 ミリ秒）の間、B が読んでいないことを確かめてから A を放す。
      for (let i = 0; i < 200; i++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(source.reads, 2);
      release();
      await Promise.all([a, b]);
      assert.deepEqual(events, ['credit_resumed']);
      // その後の確認でも、再開を重ねて知らせない。
      await gate.tick();
      await gate.tick();
      assert.deepEqual(events, ['credit_resumed']);
    });
  },
);

// --- P2-6: 残高が足りずに保留した要求 ---

test(
  'P2-6: a request held because the remaining credit did not cover its M is told when the balance recovers, once',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('20') }),
      ]);
      const gate = creditGate(harness, source);
      await gate.start();
      const events: BudgetResumeEvent['kind'][] = [];
      gate.onResumable((event) => events.push(event.kind));
      // 残高 40 XTS で M 60 を求めて、残りに足りず保留（残りは正なので、保留の状態には現れない）。
      const big = {
        quantities: { input_tokens: '30', output_tokens: '30' },
      };
      const held = await gate.admit(claudeRequest(uuid(1), big));
      assert.deepEqual(held.ok ? 'admitted' : held.reasons, [
        'credit_insufficient',
      ]);
      await gate.tick();
      assert.deepEqual(events, []);
      // 残高が 25 XXX = 50 XTS に増えても、まだ足りない。通知しない。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-15T00:00:01.000Z',
          balance: xxx('25'),
        }),
      );
      harness.clock.set(OCT_15 + 2000);
      await gate.tick();
      assert.deepEqual(events, []);
      // 残高が 30 XXX = 60 XTS になって足りる。一度だけ通知する。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-15T00:00:03.000Z',
          balance: xxx('30'),
        }),
      );
      harness.clock.set(OCT_15 + 4000);
      await gate.tick();
      await gate.tick();
      assert.deepEqual(events, ['credit_resumed']);
    });
  },
);

test(
  'P2-6: a held request that was admitted later is no longer waited for',
  TIMEOUT,
  async () => {
    await withBudgetStore(async (harness) => {
      const source = new MemoryCreditSource([
        creditObservation({ balance: xxx('20') }),
      ]);
      const gate = creditGate(harness, source);
      await gate.start();
      const events: BudgetResumeEvent['kind'][] = [];
      gate.onResumable((event) => events.push(event.kind));
      const big = { quantities: { input_tokens: '30', output_tokens: '30' } };
      assert.equal((await gate.admit(claudeRequest(uuid(1), big))).ok, false);
      // 残高が増えて、同じ要求を送り直して受け付けられた。確認の前なので、その要求のために通知しない。
      source.observations.push(
        creditObservation({
          observed_at: '2030-10-15T00:00:01.000Z',
          balance: xxx('100'),
        }),
      );
      harness.clock.set(OCT_15 + 2000);
      assert.equal((await gate.admit(claudeRequest(uuid(1), big))).ok, true);
      await gate.tick();
      await gate.tick();
      assert.deepEqual(events, []);
    });
  },
);
