// 予算の 4 経路（利用状況・超過の承認・M 超過の確認・不明な費用の手での精算。ADR 0034・0039）の処理の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬、予算の設定は合成の XTS・縮めた上限）。有料の provider は
// 同じプロセスの模擬（budget-test-support.ts）。期待値は手で書いた値（M = 入力 10 ＋ 出力の上限 30 = 40、枠の上限は
// llm 100・overage 60）で、実装の処理から作っていない。模擬の試験だけで、実機・実 API・実請求は未実施。
// 確かめること: 未登録・失効した端末は 401、承認のない超過枠の使用が 0 回、承認の二度押しでも承認が 1 件、版が古ければ 409、
// 個人の金額（XTS 以外の通貨）が fixture にないこと。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { createBudgetRoutes } from './api-budget.js';
import type { BudgetGate } from './budget-gate.js';
import { API_ROUTES } from './api-routes.js';
import { pinnedRequest, tempDir } from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import { BUDGET_CONFIG_FILE } from './budget-config.js';
import {
  MockPaidProvider,
  OCT_15,
  syntheticConfig,
  textRequest,
  uuid,
} from './budget-test-support.js';
import {
  bearer,
  bootstrap,
  getJson,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { DB_FILE } from './paths.js';

const contract = createApiContract();
// 応答の JSON（契約の形は contract.valid で確かめた後に、値を手で書いた期待値と比べる）。
type Json = Record<string, unknown>;
type Usage = Json & {
  months: { budget_month: string; pools: Json[] }[];
  pending_reservations: Json[];
};
const SCREEN = { 'buddy-input-origin': 'screen' } as const;
const xts = (amount: string) => ({ currency: 'XTS', amount });
const MINUTE = 60_000;

interface Fixtures {
  readonly operations: Readonly<
    Record<
      string,
      {
        readonly params?: Readonly<Record<string, string>>;
        readonly request?: Readonly<Record<string, unknown>>;
        readonly response?: unknown;
      }
    >
  >;
}
const fixtures = JSON.parse(
  await readFile(
    new URL(
      '../../../packages/contracts/fixtures/api-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as Fixtures;

interface Harness {
  readonly core: EventCore;
  readonly device: TestDevice;
  readonly scope: string;
  readonly provider: MockPaidProvider;
  readonly clock: { now: number };
  sql<T>(body: (db: ReturnType<typeof openWriteConnection>) => T): T;
}

async function start(t: test.TestContext): Promise<Harness> {
  const dataDir = join(await tempDir(t, 'buddy-api-budget-'), 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDir, BUDGET_CONFIG_FILE),
    JSON.stringify(syntheticConfig()),
    { mode: 0o600 },
  );
  const clock = { now: OCT_15 };
  const core = await startEventCore(t, {
    dataDir,
    lockFromHeader: false,
    budget: { tickIntervalMs: 0, now: () => clock.now },
  });
  assert.equal(core.handle.budget.configured, true);
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
  return {
    core,
    device,
    scope,
    provider: new MockPaidProvider(),
    clock,
    sql: (body) => {
      const db = openWriteConnection(join(dataDir, DB_FILE), {
        platform: storagePlatform(),
      });
      try {
        return body(db);
      } finally {
        db.close();
      }
    },
  };
}

// 枠 llm（上限 100）の精算済みを 80（40 + 40）にする。以後、M = 40 の本人の依頼は上限（精算済み 80 + M 40 > 100）で落ちる。
async function fillLlm(h: Harness): Promise<void> {
  for (const n of [1, 2]) {
    h.provider.plan(uuid(n), { kind: 'usage', actual: '40' });
    const run = await h.core.handle.budget.run(
      textRequest(uuid(n)),
      h.provider.send,
    );
    assert.equal(run.kind, 'settled');
  }
}

const decide = (
  h: Harness,
  approvalId: string,
  fields: Record<string, unknown>,
  requestId: string = randomUUID(),
) =>
  postJson(
    h.core,
    h.device,
    `/v1/budget/overage-approvals/${approvalId}/decision`,
    {
      request_id: requestId,
      command_scope_id: h.scope,
      ...fields,
    },
    SCREEN,
  );

const reviewRoute = (
  h: Harness,
  reservationId: string,
  fields: Record<string, unknown>,
  requestId: string = randomUUID(),
) =>
  postJson(
    h.core,
    h.device,
    `/v1/budget/reservations/${reservationId}/overrun-review`,
    { request_id: requestId, command_scope_id: h.scope, ...fields },
    SCREEN,
  );

const settleBody = (fields: Record<string, unknown>) => ({
  expected_reservation_revision: '1',
  manual_reconciliation_id: 'manual:invoice-a',
  actual_gross: xts('3'),
  credit_applied: xts('0'),
  additional_spend: xts('3'),
  credit_cycle_id: null,
  ...fields,
});

const settle = (
  h: Harness,
  reservationId: string,
  fields: Record<string, unknown>,
  requestId: string = randomUUID(),
) =>
  postJson(
    h.core,
    h.device,
    `/v1/budget/reservations/${reservationId}/manual-settlement`,
    {
      request_id: requestId,
      command_scope_id: h.scope,
      ...settleBody(fields),
    },
    SCREEN,
  );

const usage = async (h: Harness) => {
  const response = await getJson(h.core, h.device, '/v1/budget/usage');
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('BudgetUsageSummary', response.json), response.text);
  return response.json as Usage;
};

const overageReservations = (h: Harness): number =>
  h.sql(
    (db) =>
      db
        .prepare(
          "SELECT COUNT(*) FROM budget_reservations WHERE pool_id = 'overage'",
        )
        .pluck()
        .get() as number,
  );

const approvalRows = (h: Harness) =>
  h.sql(
    (db) =>
      db
        .prepare(
          'SELECT status, COUNT(*) AS n FROM budget_overage_approvals GROUP BY status ORDER BY status',
        )
        .all() as { status: string; n: number }[],
  );

const first = (list: Json[]): Json => {
  const item = list[0];
  assert(item !== undefined, 'a first item');
  return item;
};

const poolOf = (summary: Usage, month: string, id: string): Json => {
  const found = summary.months
    .find((item) => item.budget_month === month)
    ?.pools.find((pool) => pool['pool_id'] === id);
  assert(found !== undefined, `${month} ${id}`);
  return found;
};

test(
  'an unregistered or revoked device gets 401 on all four budget routes, and a locked, non-screen or stale-scope request is refused before any budget work',
  { timeout: 60_000 },
  async (t) => {
    const h = await start(t);
    const routes = [
      'getBudgetUsage',
      'decideBudgetOverage',
      'reviewBudgetOverrun',
      'settleBudgetManually',
    ];
    const send = (
      operationId: string,
      options: {
        readonly token?: string | null;
        readonly lock?: string;
        readonly origin?: string;
        readonly scope?: string;
      } = {},
    ) => {
      const route = API_ROUTES.find((item) => item.operationId === operationId);
      assert(route, operationId);
      const fixture = fixtures.operations[operationId] ?? {};
      const path = route.path.replace(
        /\{([a-z_]+)\}/gu,
        (_all, name: string) => fixture.params?.[name] ?? '',
      );
      const token =
        options.token === undefined ? h.device.token : options.token;
      h.core.env.lock = options.lock === 'locked' ? 'locked' : 'unlocked';
      const headers: Record<string, string> = {
        ...(token === null ? {} : bearer(token)),
      };
      if (route.inputOrigin)
        headers['buddy-input-origin'] = options.origin ?? 'screen';
      if (route.body === null)
        return pinnedRequest(h.core.target, { method: 'GET', path, headers });
      headers['content-type'] = 'application/json';
      return pinnedRequest(h.core.target, {
        method: route.method,
        path,
        headers,
        body: JSON.stringify({
          ...fixture.request,
          command_scope_id: options.scope ?? h.scope,
        }),
      });
    };
    const expect = async (
      operationId: string,
      options: Parameters<typeof send>[1],
      status: number,
      code: string,
    ) => {
      const response = await send(operationId, options);
      assert.equal(response.status, status, `${operationId} ${response.text}`);
      assert.equal(response.json?.['code'], code, operationId);
    };
    for (const id of routes) {
      // 登録していない（トークンなし・知らないトークン）。
      await expect(id, { token: null }, 401, 'unauthenticated');
      await expect(id, { token: 'A'.repeat(43) }, 401, 'unauthenticated');
      // ロック中は 403。
      await expect(id, { lock: 'locked' }, 403, 'device_locked');
    }
    for (const id of routes.slice(1)) {
      await expect(id, { scope: uuid(0xd1) }, 410, 'expired_scope');
      await expect(id, { origin: 'voice' }, 403, 'screen_operation_required');
    }
    // 失効した端末は同じ 401。
    const revoked = await h.core.handle.store.device({
      kind: 'device.revoke',
      device_id: h.device.device.device_id,
      revoked_at: Date.now(),
    });
    assert(revoked.ok);
    for (const id of routes) await expect(id, {}, 401, 'unauthenticated');
    // 拒否された要求は予算に何も書かない。
    assert.deepEqual(approvalRows(h), []);
    assert.equal(overageReservations(h), 0);
  },
);

test(
  'the usage route returns the contract summary with the pending approval and the reasons a pool is held',
  { timeout: 60_000 },
  async (t) => {
    const h = await start(t);
    await fillLlm(h);
    const empty = await usage(h);
    assert.equal(empty['currency'], 'XTS');
    assert.equal(empty['time_zone'], 'Asia/Tokyo');
    assert.equal(empty['current_month'], '2030-10');
    assert.deepEqual(empty['overage_approvals'], []);
    assert.deepEqual(empty['pending_reservations'], []);
    const llm = poolOf(empty, '2030-10', 'llm');
    assert.deepEqual(llm['limit'], xts('100'));
    assert.deepEqual(llm['settled'], xts('80'));
    assert.deepEqual(llm['unsettled_max_liability'], xts('0'));
    assert.deepEqual(llm['hold_reasons'], []);

    const ask = await h.core.handle.budget.requestOverage(textRequest(uuid(3)));
    assert(ask.ok);
    const withApproval = await usage(h);
    assert.deepEqual(withApproval['overage_approvals'], [
      {
        approval_id: ask.value.approval.approval_id,
        request_id: uuid(3),
        pool_id: 'overage',
        budget_month: '2030-10',
        max_liability: xts('40'),
        overage_remaining: xts('60'),
        status: 'pending',
        requested_at: '2030-10-15T00:00:00.000Z',
        expires_at: '2030-10-15T00:10:00.000Z',
        decided_at: null,
      },
    ]);

    // 10 分たつと、期限切れの承認は一覧から消える。
    h.clock.now = OCT_15 + 10 * MINUTE;
    assert.deepEqual((await usage(h))['overage_approvals'], []);
  },
);

test(
  'an overage reservation without an approved decision is used 0 times, and a double-pressed approval is one approval',
  { timeout: 60_000 },
  async (t) => {
    const h = await start(t);
    await fillLlm(h);
    const budget = h.core.handle.budget;
    // 上限（精算済み 80 + M 40 > 100）で落ちた依頼にだけ、承認を求められる。
    const blocked = await budget.admit(textRequest(uuid(3)));
    assert.equal(blocked.ok, false);
    const ask = await budget.requestOverage(textRequest(uuid(3)));
    assert(ask.ok);
    assert.equal(ask.value.duplicate, false);
    const approvalId = ask.value.approval.approval_id;
    // 同じ依頼の二度目の要求（二度押し）は保存済みの承認を返す。
    const again = await budget.requestOverage(textRequest(uuid(3)));
    assert(again.ok);
    assert.equal(again.value.duplicate, true);
    assert.equal(again.value.approval.approval_id, approvalId);

    // 承認の前（pending）は、超過枠を 0 回使う。
    const pending = await budget.admit(textRequest(uuid(3)));
    assert.equal(pending.ok, false);
    if (!pending.ok) assert(pending.reasons.includes('approval_pending'));
    assert.equal(overageReservations(h), 0);

    // 画面で見せた値と記録が違えば決めない（別の M・別の予算の要求・知らない承認）。
    const good = {
      budget_request_id: uuid(3),
      max_liability: xts('40'),
      decision: 'approve',
    };
    for (const wrong of [
      { max_liability: xts('39') },
      { max_liability: { currency: 'XXX', amount: '40' } },
      { budget_request_id: uuid(4) },
    ]) {
      const response = await decide(h, approvalId, { ...good, ...wrong });
      assert.equal(response.status, 409, response.text);
      assert.equal(response.json?.['code'], 'conflict');
    }
    const unknown = await decide(h, uuid(0x99), good);
    assert.equal(unknown.status, 409, unknown.text);
    assert.deepEqual(approvalRows(h), [{ status: 'pending', n: 1 }]);
    assert.equal(overageReservations(h), 0);

    // 承認。応答は契約の BudgetOverageApproval。
    const firstRequest = randomUUID();
    const approved = await decide(h, approvalId, good, firstRequest);
    assert.equal(approved.status, 200, approved.text);
    assert(
      contract.valid('BudgetOverageApproval', approved.json),
      approved.text,
    );
    assert.deepEqual(approved.json, {
      approval_id: approvalId,
      request_id: uuid(3),
      pool_id: 'overage',
      budget_month: '2030-10',
      max_liability: xts('40'),
      overage_remaining: xts('60'),
      status: 'approved',
      requested_at: '2030-10-15T00:00:00.000Z',
      expires_at: '2030-10-15T00:10:00.000Z',
      decided_at: '2030-10-15T00:00:00.000Z',
    });
    // 二度押し: 同じ命令の再送も、新しい命令での同じ決定も、同じ承認を返す。承認は 1 件のまま。
    for (const requestId of [firstRequest, randomUUID(), randomUUID()]) {
      const repeated = await decide(h, approvalId, good, requestId);
      assert.equal(repeated.status, 200, repeated.text);
      assert.deepEqual(repeated.json, approved.json);
    }
    // 同じ命令 ID で内容を変えれば 409。決めた後の拒否も 409（承認を 1 つの決定に固定する）。
    const reused = await decide(
      h,
      approvalId,
      { ...good, decision: 'reject' },
      firstRequest,
    );
    assert.equal(reused.status, 409, reused.text);
    const flipped = await decide(h, approvalId, {
      ...good,
      decision: 'reject',
    });
    assert.equal(flipped.status, 409, flipped.text);
    assert.deepEqual(approvalRows(h), [{ status: 'approved', n: 1 }]);
    assert.equal(overageReservations(h), 0);

    // 承認した依頼だけが超過枠を 1 回使う。別の依頼は同じ承認を使えない。
    const other = await budget.admit(textRequest(uuid(5)));
    assert.equal(other.ok, false);
    assert.equal(overageReservations(h), 0);
    const used = await budget.admit(textRequest(uuid(3)));
    assert(used.ok);
    assert.equal(used.ticket.pool_id, 'overage');
    assert.equal(used.ticket.routed, true);
    assert.equal(used.ticket.max_liability, '40');
    assert.equal(overageReservations(h), 1);
    assert.deepEqual(approvalRows(h), [{ status: 'consumed', n: 1 }]);
    // 使った後の承認は、決め直せず、別の受付に使えない。
    const spent = await decide(h, approvalId, good);
    assert.equal(spent.status, 409, spent.text);
    const reuse = await budget.admit(textRequest(uuid(6)));
    assert.equal(reuse.ok, false);
    assert.equal(overageReservations(h), 1);
  },
);

test(
  'a rejected, expired or autonomous request never uses the overage pool',
  { timeout: 60_000 },
  async (t) => {
    const h = await start(t);
    await fillLlm(h);
    const budget = h.core.handle.budget;
    const good = {
      budget_request_id: uuid(3),
      max_liability: xts('40'),
      decision: 'approve',
    };

    // 拒否した承認では使えない。
    const first = await budget.requestOverage(textRequest(uuid(3)));
    assert(first.ok);
    const rejected = await decide(h, first.value.approval.approval_id, {
      ...good,
      decision: 'reject',
    });
    assert.equal(rejected.status, 200, rejected.text);
    assert.equal(rejected.json?.['status'], 'rejected');
    const afterReject = await budget.admit(textRequest(uuid(3)));
    assert.equal(afterReject.ok, false);
    assert.equal(overageReservations(h), 0);

    // 期限（10 分）ちょうどは決められない。期限切れの承認では使えない。
    const second = await budget.requestOverage(textRequest(uuid(4)));
    assert(second.ok);
    const secondBody = {
      budget_request_id: uuid(4),
      max_liability: xts('40'),
      decision: 'approve',
    };
    h.clock.now = OCT_15 + 10 * MINUTE;
    const expired = await decide(
      h,
      second.value.approval.approval_id,
      secondBody,
    );
    assert.equal(expired.status, 409, expired.text);
    const afterExpiry = await budget.admit(textRequest(uuid(4)));
    assert.equal(afterExpiry.ok, false);
    assert.equal(overageReservations(h), 0);

    // 自発的な処理には承認を求められず、超過枠へ回らない。
    const autonomous = await budget.requestOverage(
      textRequest(uuid(7), { origin: 'autonomous_analysis' }),
    );
    assert.equal(autonomous.ok, false);
    if (!autonomous.ok)
      assert.deepEqual(autonomous.reasons, ['not_owner_request']);
    const autoAdmit = await budget.admit(
      textRequest(uuid(7), { origin: 'autonomous_analysis' }),
    );
    assert.equal(autoAdmit.ok, false);
    assert.equal(overageReservations(h), 0);
    // 承認の記録は、拒否した 1 件と、期限を過ぎて決められなかった 1 件（期限切れにするのは求め直したときだけ）。
    assert.deepEqual(approvalRows(h), [
      { status: 'pending', n: 1 },
      { status: 'rejected', n: 1 },
    ]);
    // 超過枠に収まらない M には承認を求めない（残り 60 < M 70: 入力 40 ＋ 出力の上限 30）。
    h.clock.now = OCT_15 + 20 * MINUTE;
    const tooBig = await budget.requestOverage(
      textRequest(uuid(8), {
        quantities: { input_tokens: '40', output_tokens: '30' },
      }),
    );
    assert.equal(tooBig.ok, false);
    if (!tooBig.ok) assert.deepEqual(tooBig.reasons, ['overage_insufficient']);
  },
);

test(
  'the overrun review releases the hold once, refuses a stale revision or different values, and replays the same command',
  { timeout: 60_000 },
  async (t) => {
    const h = await start(t);
    // 実費 55 が M 40 を超えた（切り捨てずに 55 を記録し、確認まで枠 llm の新しい受付を止める）。
    h.provider.plan(uuid(1), { kind: 'usage', actual: '55' });
    const run = await h.core.handle.budget.run(
      textRequest(uuid(1)),
      h.provider.send,
    );
    assert.equal(run.kind, 'settled');
    assert(run.kind === 'settled' && run.overrun);
    const held = await usage(h);
    assert.deepEqual(poolOf(held, '2030-10', 'llm')['hold_reasons'], [
      'overrun_review_pending',
    ]);
    assert.equal(held['pending_reservations'].length, 1);
    const pending = first(held['pending_reservations']);
    assert.equal(pending['status'], 'settled');
    assert.equal(pending['reservation_revision'], '1');
    assert.equal(pending['created_at'], '2030-10-15T00:00:00.000Z');
    assert.equal(pending['origin'], 'owner_request');
    assert.deepEqual(pending['actual_gross'], xts('55'));
    assert.deepEqual(pending['max_liability'], xts('40'));
    assert.equal(pending['overrun_reviewed'], false);
    const reservationId = pending['reservation_id'] as string;
    const blocked = await h.core.handle.budget.run(
      textRequest(uuid(2)),
      h.provider.send,
    );
    assert.equal(blocked.kind, 'rejected');
    assert.equal(h.provider.receipts.length, 1);

    const body = {
      expected_reservation_revision: '1',
      actual_gross: xts('55'),
      max_liability: xts('40'),
    };
    // 版が古い・見た値が記録と違う・別の予約は 409。何も変わらない。
    for (const wrong of [
      { expected_reservation_revision: '2' },
      { actual_gross: xts('54') },
      { max_liability: xts('41') },
    ]) {
      const response = await reviewRoute(h, reservationId, {
        ...body,
        ...wrong,
      });
      assert.equal(response.status, 409, response.text);
    }
    const unknown = await reviewRoute(h, uuid(0x98), body);
    assert.equal(unknown.status, 409, unknown.text);
    assert.equal(
      (await usage(h))['pending_reservations'].length,
      1,
      'a refused review changes nothing',
    );

    const command = randomUUID();
    const reviewed = await reviewRoute(h, reservationId, body, command);
    assert.equal(reviewed.status, 200, reviewed.text);
    assert(contract.valid('BudgetReservation', reviewed.json), reviewed.text);
    assert.equal(reviewed.json?.['overrun_reviewed'], true);
    assert.deepEqual(reviewed.json?.['actual_gross'], xts('55'));
    assert.equal(reviewed.json?.['pool_id'], 'llm');
    assert.equal(reviewed.json?.['budget_month'], '2030-10');
    // 同じ命令の再送と、新しい命令での同じ確認は、同じ結果。実費・枠・月は変わらない。
    for (const requestId of [command, randomUUID()]) {
      const repeated = await reviewRoute(h, reservationId, body, requestId);
      assert.equal(repeated.status, 200, repeated.text);
      assert.deepEqual(repeated.json, reviewed.json);
    }
    const after = await usage(h);
    assert.deepEqual(after['pending_reservations'], []);
    assert.deepEqual(poolOf(after, '2030-10', 'llm')['hold_reasons'], []);
    assert.deepEqual(poolOf(after, '2030-10', 'llm')['settled'], xts('55'));
    // 確認の後は、その枠の受付が戻る。
    const resumed = await h.core.handle.budget.run(
      textRequest(uuid(2)),
      h.provider.send,
    );
    assert.equal(resumed.kind, 'settled');
    assert.equal(h.provider.receipts.length, 2);
  },
);

test(
  'a manual settlement settles an unknown cost once in its original month with a manual reconciliation id, and refuses a stale revision, a provider-style id or credit fields',
  { timeout: 60_000 },
  async (t) => {
    const h = await start(t);
    // provider は費用を記録したが応答が届かなかった（usage 不明。R と M の 40 を保持する）。
    h.provider.plan(uuid(1), { kind: 'drop', actual: '3' });
    const run = await h.core.handle.budget.run(
      textRequest(uuid(1)),
      h.provider.send,
    );
    assert.equal(run.kind, 'usage_unknown');
    const held = await usage(h);
    assert.equal(held['pending_reservations'].length, 1);
    const unknown = first(held['pending_reservations']);
    assert.equal(unknown['status'], 'usage_unknown');
    assert.equal(unknown['reservation_revision'], '1');
    assert.deepEqual(unknown['reserved_amount'], xts('40'));
    assert.deepEqual(unknown['max_liability'], xts('40'));
    const llm = poolOf(held, '2030-10', 'llm');
    assert.equal(llm['usage_unknown_count'], 1);
    assert.deepEqual(llm['unsettled_max_liability'], xts('40'));
    const reservationId = unknown['reservation_id'] as string;

    // 月が替わっても元の月に計上する。
    h.clock.now = Date.parse('2030-11-02T00:00:00.000Z');
    const rolled = await usage(h);
    assert.equal(rolled['current_month'], '2030-11');
    assert.equal(
      first(rolled['pending_reservations'])['budget_month'],
      '2030-10',
    );

    // 版が古い・provider の照合 ID の形・クレジットの区分・通貨違いは決めない。
    const stale = await settle(h, reservationId, {
      expected_reservation_revision: '5',
    });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json?.['code'], 'conflict');
    for (const wrong of [
      { manual_reconciliation_id: 'rcpt-1' },
      { credit_applied: xts('1') },
      { additional_spend: xts('2') },
      { credit_cycle_id: 'anthropic:2030-10-01' },
      { actual_gross: { currency: 'XXX', amount: '3' } },
    ]) {
      const response = await settle(h, reservationId, wrong);
      assert.equal(response.status, 422, JSON.stringify(wrong) + response.text);
    }
    assert.equal(
      first((await usage(h))['pending_reservations'])['status'],
      'usage_unknown',
      'refused settlements change nothing',
    );

    const command = randomUUID();
    const settled = await settle(h, reservationId, {}, command);
    assert.equal(settled.status, 200, settled.text);
    assert(contract.valid('BudgetReservation', settled.json), settled.text);
    assert.deepEqual(settled.json, {
      reservation_id: reservationId,
      reservation_revision: '1',
      request_id: uuid(1),
      profile_id: 'intent.synthetic.v1',
      price_version: 'xts.text.v1',
      budget_month: '2030-10',
      pool_id: 'llm',
      reserved_amount: xts('40'),
      max_liability: xts('40'),
      status: 'settled',
      provider_reconciliation_id: 'manual:invoice-a',
      actual_gross: xts('3'),
      credit_applied: xts('0'),
      additional_spend: xts('3'),
      credit_cycle_id: null,
      approval_id: null,
      overrun_reviewed: false,
      // 対象を見分ける表示用の値（受付の時刻と処理の起点）。
      created_at: '2030-10-15T00:00:00.000Z',
      origin: 'owner_request',
    });
    // 同じ命令の再送・同じ値の再適用は同じ結果。別の値・別の照合 ID は 409（二度は精算しない）。
    for (const requestId of [command, randomUUID()]) {
      const repeated = await settle(h, reservationId, {}, requestId);
      assert.equal(repeated.status, 200, repeated.text);
      assert.deepEqual(repeated.json, settled.json);
    }
    for (const wrong of [
      { actual_gross: xts('4'), additional_spend: xts('4') },
      { manual_reconciliation_id: 'manual:invoice-b' },
    ]) {
      const response = await settle(h, reservationId, wrong);
      assert.equal(response.status, 409, response.text);
    }
    // 元の月に実費 3 で計上され、未精算は消え、今月（11 月）には何も数えない。
    const after = await usage(h);
    assert.deepEqual(after['pending_reservations'], []);
    assert.deepEqual(poolOf(after, '2030-11', 'llm')['settled'], xts('0'));
    // 精算後の同じ照合 ID は別の予約に使えない（B15 の請求の照合で一意）。
    h.provider.plan(uuid(2), { kind: 'drop', actual: '2' });
    h.clock.now = Date.parse('2030-11-02T00:01:00.000Z');
    const second = await h.core.handle.budget.run(
      textRequest(uuid(2)),
      h.provider.send,
    );
    assert.equal(second.kind, 'usage_unknown');
    const next = first((await usage(h))['pending_reservations']);
    const conflict = await settle(h, next['reservation_id'] as string, {});
    assert.equal(conflict.status, 409, conflict.text);
  },
);

test('the budget fixtures use only the synthetic currency XTS (no personal amounts)', async () => {
  const currencies = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'currency' && typeof inner === 'string')
          currencies.add(inner);
        else walk(inner);
      }
  };
  for (const id of [
    'getBudgetUsage',
    'decideBudgetOverage',
    'reviewBudgetOverrun',
    'settleBudgetManually',
  ]) {
    const fixture = fixtures.operations[id];
    assert(fixture, id);
    walk(fixture.request);
    walk(fixture.response);
  }
  assert.deepEqual([...currencies], ['XTS']);
});

test('a failure to read the reservation is a 503 (an exception for the route check), not a stale revision; a missing reservation and a real mismatch stay 409', async () => {
  let revision: string | null | 'unavailable' = 'unavailable';
  let receipt = false;
  const routes = createBudgetRoutes({
    gate: {
      reservationRevision: () => Promise.resolve(revision),
    } as unknown as BudgetGate,
    receiptExists: () => Promise.resolve(receipt),
  });
  const input = (operationId: string, expected: string) => ({
    operationId,
    device: null,
    remoteAddress: '127.0.0.1',
    params: { reservation_id: uuid(0xb1) },
    body: {
      request_id: uuid(1),
      command_scope_id: uuid(2),
      expected_reservation_revision: expected,
    },
    declaredLockState: null,
  });
  for (const operationId of ['reviewBudgetOverrun', 'settleBudgetManually']) {
    // 読めない障害: 版の不一致（false）にせず、例外にする（サーバーは 503 で閉じる）。
    revision = 'unavailable';
    await assert.rejects(
      routes.revisionMatches(input(operationId, '1')),
      /budget_reservation_unavailable/u,
      operationId,
    );
    // 予約がない・実際に版が違う: 合わない（409）。
    revision = null;
    assert.equal(await routes.revisionMatches(input(operationId, '1')), false);
    revision = '2';
    assert.equal(await routes.revisionMatches(input(operationId, '1')), false);
    // 版が合う・保存済みの受付がある（再送）: 通す。
    assert.equal(await routes.revisionMatches(input(operationId, '2')), true);
    receipt = true;
    assert.equal(await routes.revisionMatches(input(operationId, '1')), true);
    receipt = false;
  }
});

test(
  'over HTTPS, a failure to read the reservation answers 503 for the overrun review and the manual settlement, while a missing reservation and a stale revision answer 409',
  { timeout: 60_000 },
  async (t) => {
    const h = await start(t);
    // 予約を作る（usage 不明。版 1）。
    h.provider.plan(uuid(1), { kind: 'drop', actual: '3' });
    await h.core.handle.budget.run(textRequest(uuid(1)), h.provider.send);
    const reservationId = first((await usage(h))['pending_reservations'])[
      'reservation_id'
    ] as string;
    const review = {
      expected_reservation_revision: '1',
      actual_gross: xts('55'),
      max_liability: xts('40'),
    };
    const send = (route: 'review' | 'settle', id: string, revision = '1') =>
      route === 'review'
        ? reviewRoute(h, id, {
            ...review,
            expected_reservation_revision: revision,
          })
        : settle(h, id, { expected_reservation_revision: revision });
    // 読み取りの障害を注入する: 予約の検索だけが失敗する（ほかの命令は動く）。
    const store = h.core.handle.store;
    const original = store.budget.bind(store);
    let failing = true;
    (store as { budget: unknown }).budget = (op: { kind: string }) =>
      failing && op.kind === 'budget.reservation_find'
        ? Promise.resolve({
            ok: false as const,
            outcome: 'rejected' as const,
            reasons: ['worker_unavailable'],
          })
        : original(op as never);
    for (const route of ['review', 'settle'] as const) {
      const response = await send(route, reservationId);
      assert.equal(response.status, 503, `${route} ${response.text}`);
      assert.equal(response.json?.['code'], 'dependency_unavailable');
    }
    // 障害がなくなれば、同じ予約が読め、版の不一致は 409、予約がなければ 409（内容が変わった）。
    failing = false;
    for (const route of ['review', 'settle'] as const) {
      assert.equal((await send(route, reservationId, '9')).status, 409, route);
      assert.equal((await send(route, uuid(0xb1))).status, 409, route);
    }
    // 障害の間に何も記録していない。
    const after = first((await usage(h))['pending_reservations']);
    assert.equal(after['status'], 'usage_unknown');
  },
);
