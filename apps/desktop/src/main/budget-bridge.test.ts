// 予算の確認の経路（BudgetBridge。B07-05、ADR 0038）の試験。接続は模擬（中枢への要求を記録して手で答える）で、
// 確認（OS の確認ダイアログ）・世代・入出力の停止・時計を手で動かす。実際の中枢との通しは budget-link.test.ts。
// 期待値（項目・本文・順序・理由）は手で書いた合成の値（通貨 XTS）。個人の金額は使わない。
// 確かめること: 確認は 1 回だけで確認の前に何も送らない、確認の前後で項目が変わっていれば送らない、承認は 1 つの予算の要求と M に
// 固定、結果不明は送り直さず次の読み取りで解く、二度押しで 2 回送らない、世代をまたいだ処理は何も送らない、画面へ ID を渡さない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import { BudgetBridge } from './budget-bridge.js';
import type {
  BudgetConfirmRequest,
  BudgetConfirmResult,
  BudgetHost,
} from './budget-bridge.js';
import { createDesktopContract, loadContractSchema } from './contract.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const xts = (amount: string) => ({ currency: 'XTS', amount });

const SCOPE = uuid(0x5c);
const APPROVAL_ID = uuid(0xa1);
const BUDGET_REQUEST_ID = uuid(0xa2);
const UNKNOWN_RESERVATION = uuid(0xb1);
const OVERRUN_RESERVATION = uuid(0xb2);
const NOW = Date.parse('2030-10-15T00:00:00.000Z');
const EXPIRES = '2030-10-15T00:10:00.000Z';

const reservation = (fields: Record<string, unknown>) => ({
  reservation_id: uuid(0xb0),
  reservation_revision: '1',
  request_id: uuid(0xb9),
  profile_id: 'synthetic.text.v1',
  price_version: 'xts.text.2030a',
  budget_month: '2030-10',
  pool_id: 'llm',
  reserved_amount: xts('40000000'),
  max_liability: xts('40000000'),
  status: 'usage_unknown',
  provider_reconciliation_id: null,
  actual_gross: null,
  credit_applied: null,
  additional_spend: null,
  credit_cycle_id: null,
  approval_id: null,
  overrun_reviewed: false,
  ...fields,
});

const pool = (id: string, parent: string | null) => ({
  pool_id: id,
  parent_pool_id: parent,
  limit: xts('100000000'),
  settled: xts('0'),
  unsettled_reserved: xts('0'),
  unsettled_max_liability: xts('0'),
  usage_unknown_count: 0,
  overrun_review_count: 0,
  hold_reasons: [],
});

interface UsageOptions {
  readonly approval?: boolean;
  readonly unknown?: boolean;
  readonly overrun?: boolean;
  readonly expires?: string;
  readonly max?: string;
}

// 合成の利用状況（契約の BudgetUsageSummary）。
function usageBody(options: UsageOptions = {}) {
  const {
    approval = true,
    unknown = true,
    overrun = true,
    expires = EXPIRES,
    max = '40000000',
  } = options;
  return {
    currency: 'XTS',
    time_zone: 'Asia/Tokyo',
    current_month: '2030-10',
    generated_at: '2030-10-15T00:00:00Z',
    months: [
      {
        budget_month: '2030-10',
        pools: [pool('total', null), pool('llm', 'total')],
      },
    ],
    overage_approvals: approval
      ? [
          {
            approval_id: APPROVAL_ID,
            request_id: BUDGET_REQUEST_ID,
            pool_id: 'llm',
            budget_month: '2030-10',
            max_liability: xts(max),
            overage_remaining: xts('60000000'),
            status: 'pending',
            requested_at: '2030-10-15T00:00:00Z',
            expires_at: expires,
            decided_at: null,
          },
        ]
      : [],
    pending_reservations: [
      ...(unknown
        ? [
            reservation({
              reservation_id: UNKNOWN_RESERVATION,
              budget_month: '2030-09',
              status: 'usage_unknown',
            }),
          ]
        : []),
      ...(overrun
        ? [
            reservation({
              reservation_id: OVERRUN_RESERVATION,
              pool_id: 'llm.background',
              status: 'settled',
              provider_reconciliation_id: 'synthetic-usage-1',
              actual_gross: xts('55000000'),
              credit_applied: xts('0'),
              additional_spend: xts('55000000'),
            }),
          ]
        : []),
    ],
  };
}

const snapshotBody = (
  budgetHold: {
    held: boolean;
    reasons: string[];
    held_pools: unknown[];
  } | null,
  view: 'full' | 'management_only' = 'full',
) => ({
  store_generation: uuid(2),
  core_instance_id: uuid(1),
  event_cursor: 'c-1',
  view,
  io_state: {
    device_id: uuid(0x50),
    io_epoch: '4',
    output_epoch: '12',
    lock_state: 'unlocked',
    stop_scope: 'none',
    input_permitted: true,
    voice_state: 'waiting_wake_word',
    output_mode: 'text',
    private_conversation: false,
    audio_lease_valid: false,
  },
  budget_hold: budgetHold,
  sessions: [],
  candidates: [],
  operations: [],
});

type Outcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' }
  | { kind: 'not_sent'; reason: 'not_connected' };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly scoped?: boolean;
  readonly screenOperation?: boolean;
  readonly expectedScopeId?: string;
}

interface Rig {
  readonly bridge: BudgetBridge;
  readonly calls: Call[];
  readonly confirms: BudgetConfirmRequest[];
  readonly io: { permitted: boolean; epoch: string };
  readonly clock: { now: number };
  readonly changes: { count: number };
  // 利用状況・スナップショット・命令への答え（試験が差し替える）。
  usage: () => Outcome;
  snapshot: () => Outcome;
  post: (call: Call) => Outcome;
  // 中枢への要求の答えを返す前に待つ（読み取りの途中で世代が変わる状況を作る）。
  delay: (() => Promise<void>) | null;
  // 本人の確認の答え（差し替えられる。確認の最中に何かを起こすときは、ここで起こす）。
  answer: (request: BudgetConfirmRequest) => Promise<BudgetConfirmResult>;
  posts(): Call[];
}

function rig(): Rig {
  const calls: Call[] = [];
  const confirms: BudgetConfirmRequest[] = [];
  const changes = { count: 0 };
  const state: Rig = {
    calls,
    confirms,
    changes,
    io: { permitted: true, epoch: '3' },
    clock: { now: NOW },
    usage: () => ({ kind: 'response', status: 200, body: usageBody() }),
    snapshot: () => ({
      kind: 'response',
      status: 200,
      body: snapshotBody({ held: false, reasons: [], held_pools: [] }),
    }),
    post: () => ({ kind: 'unknown' }),
    delay: null,
    answer: () => Promise.resolve({ scope: SCOPE }),
    posts: () => calls.filter((call) => call.method === 'POST'),
    bridge: undefined as unknown as BudgetBridge,
  };
  const connection = {
    state: { commandScopeId: SCOPE, phase: 'live' },
    request: async (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (state.delay !== null) await state.delay();
      if (call.method === 'GET' && call.path === '/v1/budget/usage')
        return state.usage();
      if (call.method === 'GET' && call.path === '/v1/snapshot')
        return state.snapshot();
      return state.post(call);
    },
  } as unknown as ClientConnection;
  let counter = 0x100;
  const host: BudgetHost = {
    contract,
    connection: () => connection,
    newRef: () => uuid(counter++),
    confirm: (request) => {
      confirms.push(request);
      return state.answer(request);
    },
    io: () => ({ ...state.io }),
    now: () => state.clock.now,
    changed: () => {
      changes.count += 1;
    },
    log: () => undefined,
  };
  return Object.assign(state, { bridge: new BudgetBridge(host) });
}

const APPROVAL_CONFIRM: BudgetConfirmRequest = {
  action: 'approve_overage',
  poolId: 'llm',
  budgetMonth: '2030-10',
  maxLiability: xts('40000000'),
  overageRemaining: xts('60000000'),
  expiresAt: EXPIRES,
  actualGross: null,
  reconciliationId: null,
};

const ok = { ok: true, value: 'durable' } as const;
const fail = (reason: string) => ({ ok: false, reason });
const applied = (body: unknown): Outcome => ({
  kind: 'response',
  status: 200,
  body,
});
const approvedBody = () => ({
  ...usageBody().overage_approvals[0],
  status: 'approved',
  decided_at: '2030-10-15T00:01:00Z',
});

function refOf(r: Rig, kind: string): string {
  const entry = r.bridge.entries().find((item) => item.kind === kind);
  assert(entry !== undefined, kind);
  return entry.ref;
}

test('refresh builds the entries in a fixed order from the usage, and the screen never receives an ID or a version', async () => {
  const r = rig();
  await r.bridge.refresh();
  const entries = r.bridge.entries();
  // 承認待ち → M 超過の確認 → 手での精算。金額・枠・予算月・期限は表示用。ID・版は含まない。
  assert.deepEqual(
    entries.map((entry) => ({ ...entry, ref: 'ref' })),
    [
      {
        ref: 'ref',
        kind: 'overage_approval',
        pool_id: 'llm',
        budget_month: '2030-10',
        max_liability: xts('40000000'),
        overage_remaining: xts('60000000'),
        actual_gross: null,
        expires_at: EXPIRES,
        delivery_unknown: false,
      },
      {
        ref: 'ref',
        kind: 'overrun_review',
        pool_id: 'llm.background',
        budget_month: '2030-10',
        max_liability: xts('40000000'),
        overage_remaining: null,
        actual_gross: xts('55000000'),
        expires_at: null,
        delivery_unknown: false,
      },
      {
        ref: 'ref',
        kind: 'manual_settlement',
        pool_id: 'llm',
        budget_month: '2030-09',
        max_liability: xts('40000000'),
        overage_remaining: null,
        actual_gross: null,
        expires_at: null,
        delivery_unknown: false,
      },
    ],
  );
  const text = JSON.stringify(entries);
  for (const secret of [
    APPROVAL_ID,
    BUDGET_REQUEST_ID,
    UNKNOWN_RESERVATION,
    OVERRUN_RESERVATION,
    'reservation_revision',
    'approval_id',
    'request_id',
    'reservation_id',
  ])
    assert(!text.includes(secret), secret);
  // 画面へ渡す値は契約の形（IPC の接続の状態に入れて検査される）。
  for (const entry of entries)
    assert(contract.valid('DesktopBudgetEntry', entry), entry.kind);
  assert.equal(r.bridge.hold, false);
});

test('the budget hold follows the snapshot and is unknown when the view is management only or unreadable', async () => {
  const r = rig();
  await r.bridge.refresh();
  assert.equal(r.bridge.hold, false);
  r.snapshot = () => ({
    kind: 'response',
    status: 200,
    body: snapshotBody({
      held: true,
      reasons: ['config_invalid'],
      held_pools: [],
    }),
  });
  await r.bridge.refresh();
  assert.equal(r.bridge.hold, true);
  // 管理情報だけの表示（ロック中）は保留を出さない。
  r.snapshot = () => ({
    kind: 'response',
    status: 200,
    body: snapshotBody(null, 'management_only'),
  });
  await r.bridge.refresh();
  assert.equal(r.bridge.hold, null);
  // 読めなければ前の値のまま（読めなかったことを「保留なし」にしない）。
  r.snapshot = () => ({
    kind: 'response',
    status: 200,
    body: snapshotBody({
      held: true,
      reasons: ['clock_regressed'],
      held_pools: [],
    }),
  });
  await r.bridge.refresh();
  assert.equal(r.bridge.hold, true);
  r.snapshot = () => ({ kind: 'unknown' });
  await r.bridge.refresh();
  assert.equal(r.bridge.hold, true);
  // 形が契約に合わない応答は使わない。
  r.snapshot = () => ({ kind: 'response', status: 200, body: { held: false } });
  await r.bridge.refresh();
  assert.equal(r.bridge.hold, true);
});

test('a ref stays the same while the item stays, a removed item is forgotten, and the screen is told only when something changed', async () => {
  const r = rig();
  await r.bridge.refresh();
  const before = r.bridge.entries().map((entry) => entry.ref);
  const changed = r.changes.count;
  assert(changed >= 1);
  await r.bridge.refresh();
  assert.deepEqual(
    r.bridge.entries().map((entry) => entry.ref),
    before,
  );
  assert.equal(r.changes.count, changed, 'same values are not announced');
  // 承認待ちが消えた（決まった・期限切れ）。
  r.usage = () => applied(usageBody({ approval: false }));
  await r.bridge.refresh();
  assert.equal(r.bridge.entries().length, 2);
  assert(!r.bridge.entries().some((entry) => entry.ref === before[0]));
  assert.equal(
    (await r.bridge.decide(before[0] as string, 'approve')).ok,
    false,
  );
  assert.equal(r.confirms.length, 0);
});

test('approving shows the confirmation once with the values the bridge read, then sends the decision fixed to the budget request and M', async () => {
  const r = rig();
  await r.bridge.refresh();
  // 中枢は承認を記録した（次の読み取りでは、その承認を載せない）。
  r.post = () => {
    r.usage = () => applied(usageBody({ approval: false }));
    return applied(approvedBody());
  };
  const ref = refOf(r, 'overage_approval');
  assert.deepEqual(await r.bridge.decide(ref, 'approve'), ok);
  assert.deepEqual(r.confirms, [APPROVAL_CONFIRM]);
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: `/v1/budget/overage-approvals/${APPROVAL_ID}/decision`,
      body: {
        budget_request_id: BUDGET_REQUEST_ID,
        max_liability: xts('40000000'),
        decision: 'approve',
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  // 受け付けた項目は、次の読み取りが済むまで一覧から隠れ、同じ参照からは送れない（二度押しでも送るのは 1 回）。
  assert(!r.bridge.entries().some((entry) => entry.ref === ref));
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('entry_not_found'),
  );
  assert.equal(r.confirms.length, 1);
  assert.equal(r.posts().length, 1);
});

test('a recorded item stays hidden until the next read; if the core still lists it, it comes back', async () => {
  const r = rig();
  await r.bridge.refresh();
  const ref = refOf(r, 'overage_approval');
  // 命令を受け付けた後の読み取りを、手で止める。
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  r.post = () => {
    r.delay = () => gate;
    return applied(approvedBody());
  };
  assert.deepEqual(await r.bridge.decide(ref, 'approve'), ok);
  assert(!r.bridge.entries().some((entry) => entry.ref === ref));
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('entry_not_found'),
  );
  // 読み取りが済み、中枢が項目をまだ載せていれば戻す（隠したまま失わない）。
  r.delay = null;
  release();
  await r.bridge.refresh();
  assert(r.bridge.entries().some((entry) => entry.ref === ref));
  // 中枢が項目を載せなくなれば、消える。
  r.post = () => applied(approvedBody());
  assert.deepEqual(await r.bridge.decide(ref, 'approve'), ok);
  r.usage = () => applied(usageBody({ approval: false }));
  await r.bridge.refresh();
  assert(!r.bridge.entries().some((entry) => entry.ref === ref));
});

test('nothing is sent before the confirmation, and declining or closing it sends nothing', async () => {
  const r = rig();
  await r.bridge.refresh();
  const ref = refOf(r, 'overage_approval');
  r.answer = () => {
    // 確認の最中には、まだ何も送っていない。
    assert.equal(r.posts().length, 0);
    return Promise.resolve('confirmation_declined');
  };
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('confirmation_declined'),
  );
  r.answer = () => Promise.resolve('screen_operation_required');
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('screen_operation_required'),
  );
  assert.equal(r.posts().length, 0);
  // やめた項目は一覧に残り、もう一度確かめられる。
  assert(r.bridge.entries().some((entry) => entry.ref === ref));
});

test('an approval is not sent when the item changed or expired while the confirmation was open', async () => {
  // 確認の最中に期限が過ぎた。
  let r = rig();
  await r.bridge.refresh();
  let ref = refOf(r, 'overage_approval');
  r.answer = () => {
    r.clock.now = Date.parse(EXPIRES);
    return Promise.resolve({ scope: SCOPE });
  };
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('preview_stale'),
  );
  assert.equal(r.posts().length, 0);

  // 確認の最中に承認がなくなった（別の端末で決まった）。
  r = rig();
  await r.bridge.refresh();
  ref = refOf(r, 'overage_approval');
  r.answer = async () => {
    r.usage = () => applied(usageBody({ approval: false }));
    await r.bridge.refresh();
    return { scope: SCOPE };
  };
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('preview_stale'),
  );
  assert.equal(r.posts().length, 0);

  // 確認の最中に M が変わった（別の依頼の値）: 確認した内容と違うので送らない。
  r = rig();
  await r.bridge.refresh();
  ref = refOf(r, 'overage_approval');
  r.answer = async () => {
    r.usage = () => applied(usageBody({ max: '41000000' }));
    await r.bridge.refresh();
    return { scope: SCOPE };
  };
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('preview_stale'),
  );
  assert.equal(r.posts().length, 0);

  // 期限を過ぎた承認は、確認を出さない。
  r = rig();
  await r.bridge.refresh();
  ref = refOf(r, 'overage_approval');
  r.clock.now = Date.parse(EXPIRES) + 1;
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('preview_stale'),
  );
  assert.equal(r.confirms.length, 0);
});

test('while input is stopped, approving and the overrun review are refused without a confirmation, and rejecting and settling stay possible', async () => {
  const r = rig();
  await r.bridge.refresh();
  r.io.permitted = false;
  assert.deepEqual(
    await r.bridge.decide(refOf(r, 'overage_approval'), 'approve'),
    fail('input_stopped'),
  );
  assert.deepEqual(
    await r.bridge.reviewOverrun(refOf(r, 'overrun_review')),
    fail('input_stopped'),
  );
  assert.equal(r.confirms.length, 0);
  assert.equal(r.posts().length, 0);
  // 見送りは承認を増やさないので、確認なしで送れる。
  r.post = () => applied({ ...approvedBody(), status: 'rejected' });
  assert.deepEqual(
    await r.bridge.decide(refOf(r, 'overage_approval'), 'reject'),
    ok,
  );
  assert.equal(r.confirms.length, 0);
  assert.equal(r.posts().length, 1);
  assert.equal((r.posts()[0]?.body as { decision: string }).decision, 'reject');
  // 手での精算は記録の操作で、停止中でも確認を経て送れる。
  r.post = () => applied(reservation({ status: 'settled' }));
  assert.deepEqual(
    await r.bridge.settleManually(
      refOf(r, 'manual_settlement'),
      'manual:invoice-a',
      '3000000',
    ),
    ok,
  );
  assert.equal(r.confirms.length, 1);
});

test('input stopped during the confirmation (or a new io epoch) sends nothing', async () => {
  for (const change of [
    (io: Rig['io']) => {
      io.permitted = false;
    },
    (io: Rig['io']) => {
      io.epoch = '4';
    },
  ]) {
    const r = rig();
    await r.bridge.refresh();
    const ref = refOf(r, 'overage_approval');
    r.answer = () => {
      change(r.io);
      return Promise.resolve({ scope: SCOPE });
    };
    assert.deepEqual(
      await r.bridge.decide(ref, 'approve'),
      fail('input_stopped'),
    );
    assert.equal(r.posts().length, 0);
  }
});

test('the overrun review shows the recorded actual cost and M, and sends the version it saw', async () => {
  const r = rig();
  await r.bridge.refresh();
  r.post = () =>
    applied(reservation({ status: 'settled', overrun_reviewed: true }));
  const ref = refOf(r, 'overrun_review');
  assert.deepEqual(await r.bridge.reviewOverrun(ref), ok);
  assert.deepEqual(r.confirms, [
    {
      action: 'review_overrun',
      poolId: 'llm.background',
      budgetMonth: '2030-10',
      maxLiability: xts('40000000'),
      overageRemaining: null,
      expiresAt: null,
      actualGross: xts('55000000'),
      reconciliationId: null,
    },
  ]);
  assert.deepEqual(r.posts()[0], {
    method: 'POST',
    path: `/v1/budget/reservations/${OVERRUN_RESERVATION}/overrun-review`,
    body: {
      expected_reservation_revision: '1',
      actual_gross: xts('55000000'),
      max_liability: xts('40000000'),
    },
    scoped: true,
    screenOperation: true,
    expectedScopeId: SCOPE,
  });
});

test('the manual settlement shows the typed values and sends the initial credit rule with the version it saw', async () => {
  const r = rig();
  await r.bridge.refresh();
  r.post = () => applied(reservation({ status: 'settled' }));
  const ref = refOf(r, 'manual_settlement');
  assert.deepEqual(
    await r.bridge.settleManually(ref, 'manual:invoice-2030-09-a', '3000000'),
    ok,
  );
  assert.deepEqual(r.confirms, [
    {
      action: 'settle_manual',
      poolId: 'llm',
      budgetMonth: '2030-09',
      maxLiability: xts('40000000'),
      overageRemaining: null,
      expiresAt: null,
      actualGross: xts('3000000'),
      reconciliationId: 'manual:invoice-2030-09-a',
    },
  ]);
  assert.deepEqual(r.posts()[0], {
    method: 'POST',
    path: `/v1/budget/reservations/${UNKNOWN_RESERVATION}/manual-settlement`,
    body: {
      expected_reservation_revision: '1',
      manual_reconciliation_id: 'manual:invoice-2030-09-a',
      actual_gross: xts('3000000'),
      credit_applied: xts('0'),
      additional_spend: xts('3000000'),
      credit_cycle_id: null,
    },
    scoped: true,
    screenOperation: true,
    expectedScopeId: SCOPE,
  });
});

test('a ref of another kind cannot be used for a command (a settlement ref cannot approve)', async () => {
  const r = rig();
  await r.bridge.refresh();
  assert.deepEqual(
    await r.bridge.decide(refOf(r, 'manual_settlement'), 'approve'),
    fail('entry_not_found'),
  );
  assert.deepEqual(
    await r.bridge.reviewOverrun(refOf(r, 'overage_approval')),
    fail('entry_not_found'),
  );
  assert.deepEqual(
    await r.bridge.settleManually(
      refOf(r, 'overrun_review'),
      'manual:invoice-a',
      '1',
    ),
    fail('entry_not_found'),
  );
  assert.deepEqual(
    await r.bridge.decide(uuid(0xdead), 'approve'),
    fail('entry_not_found'),
  );
  assert.equal(r.confirms.length, 0);
  assert.equal(r.posts().length, 0);
});

test('an unknown outcome is held, never sent again by itself, and released by the next successful read', async () => {
  const r = rig();
  await r.bridge.refresh();
  const ref = refOf(r, 'overage_approval');
  r.post = () => ({ kind: 'unknown' });
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('outcome_unknown'),
  );
  assert.equal(
    r.bridge.entries().find((entry) => entry.ref === ref)?.delivery_unknown,
    true,
  );
  // 保留の間は、確認も送信もさせない。
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('entry_not_found'),
  );
  assert.equal(r.confirms.length, 1);
  assert.equal(r.posts().length, 1);
  // 中枢の今の状態を読めると保留が解ける（承認は適用されていない: 項目が残っている）。もう一度、本人が確かめて送れる。
  await r.bridge.refresh();
  assert.equal(
    r.bridge.entries().find((entry) => entry.ref === ref)?.delivery_unknown,
    false,
  );
  r.post = () => applied(approvedBody());
  assert.deepEqual(await r.bridge.decide(ref, 'approve'), ok);
  assert.equal(r.confirms.length, 2);
  assert.equal(r.posts().length, 2);
});

test('a read that fails keeps the hold: nothing says the command did not arrive', async () => {
  const r = rig();
  await r.bridge.refresh();
  const ref = refOf(r, 'overage_approval');
  r.post = () => ({ kind: 'unknown' });
  await r.bridge.decide(ref, 'approve');
  r.usage = () => ({ kind: 'unknown' });
  await r.bridge.refresh();
  assert.equal(
    r.bridge.entries().find((entry) => entry.ref === ref)?.delivery_unknown,
    true,
  );
});

test('the core refusing a stale value asks to read again (409), and other refusals are plain refusals; both read the usage again', async () => {
  for (const [status, reason] of [
    [409, 'preview_stale'],
    [403, 'core_rejected'],
    [422, 'core_rejected'],
    [503, 'core_rejected'],
  ] as const) {
    const r = rig();
    await r.bridge.refresh();
    const readsBefore = r.calls.filter((call) => call.method === 'GET').length;
    r.post = () => ({
      kind: 'response',
      status,
      body: { code: 'conflict', message: 'x', request_id: null },
    });
    assert.deepEqual(
      await r.bridge.decide(refOf(r, 'overage_approval'), 'approve'),
      fail(reason),
      String(status),
    );
    await r.bridge.refresh();
    assert(
      r.calls.filter((call) => call.method === 'GET').length > readsBefore,
      'the usage is read again',
    );
    // 受け付けなかった項目は一覧に残る。
    assert.equal(r.bridge.entries().length, 3);
  }
});

test('a 2xx answer that does not fit the contract is an unknown outcome, not a success', async () => {
  const r = rig();
  await r.bridge.refresh();
  const ref = refOf(r, 'overage_approval');
  r.post = () => applied({ nonsense: true });
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('outcome_unknown'),
  );
  assert.equal(
    r.bridge.entries().find((entry) => entry.ref === ref)?.delivery_unknown,
    true,
  );
});

test('a generation change (lock or disconnect) drops the entries and refs, and a command that was waiting for the confirmation sends nothing', async () => {
  const r = rig();
  await r.bridge.refresh();
  const ref = refOf(r, 'overage_approval');
  r.answer = () => {
    r.bridge.reset();
    return Promise.resolve({ scope: SCOPE });
  };
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('not_connected'),
  );
  assert.equal(r.posts().length, 0);
  assert.deepEqual(r.bridge.entries(), []);
  assert.equal(r.bridge.hold, null);
  // 古い参照は、読み直した後でも使えない（参照は世代ごとに新しい）。
  await r.bridge.refresh();
  assert.deepEqual(
    await r.bridge.decide(ref, 'approve'),
    fail('entry_not_found'),
  );
  assert.equal(r.posts().length, 0);
});

test('a read that started before a generation change is thrown away', async () => {
  const r = rig();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  r.delay = () => gate;
  const reading = r.bridge.refresh();
  // 読み取りが中枢への要求を出して待っている間に、世代が進む（ロック・切断）。
  assert.equal(r.calls.length, 2);
  r.bridge.reset();
  r.delay = null;
  release();
  await reading;
  assert.deepEqual(r.bridge.entries(), [], 'the old generation is not shown');
  assert.equal(r.bridge.hold, null);
});

test('a refusal from the core (a closed scope) drops nothing the screen shows and does not hold', async () => {
  const r = rig();
  await r.bridge.refresh();
  const ref = refOf(r, 'overrun_review');
  r.post = () => ({ kind: 'not_sent', reason: 'not_connected' });
  assert.deepEqual(await r.bridge.reviewOverrun(ref), fail('not_connected'));
  assert.equal(
    r.bridge.entries().find((entry) => entry.ref === ref)?.delivery_unknown,
    false,
  );
});
