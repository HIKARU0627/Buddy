// 予算の確認（超過枠の承認・M 超過の確認・手での精算）の画面の状態の試験（B07-05、ADR 0039）。期待値の文言・値は手で書く
// （通貨は合成の XTS。個人の金額は使わない）。送る要求は参照だけで、承認 ID・予約 ID・版・金額（承認・確認）を含まない。
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import type {
  DesktopBudgetEntry,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import {
  BUDGET_LABELS,
  BudgetStore,
  INITIAL_BUDGET_STATE,
  INITIAL_MANUAL_INPUT,
  applyBudgetFailure,
  applyBudgetResponse,
  budgetBar,
  budgetFailureText,
  entryExpired,
  expiryText,
  occurredText,
  originText,
  poolText,
  manualProblems,
  manualReady,
  markBusy,
  overAmount,
  setManualInput,
  syncBudget,
} from './budget-state.js';
import type { BudgetViewState } from './budget-state.js';

const test = (name: string, fn: () => void | Promise<void>) =>
  nodeTest(name, { timeout: 10_000 }, fn);

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const xts = (amount: string) => ({ currency: 'XTS', amount });

const approval = (
  overrides: Partial<DesktopBudgetEntry> = {},
): DesktopBudgetEntry => ({
  ref: id(1),
  kind: 'overage_approval',
  pool_id: 'llm',
  budget_month: '2030-10',
  origin: null,
  profile_id: null,
  occurred_at: '2030-10-15T00:02:00.000Z',
  max_liability: xts('40000000'),
  overage_remaining: xts('60000000'),
  actual_gross: null,
  expires_at: '2030-10-15T00:10:00.000Z',
  delivery_unknown: false,
  ...overrides,
});
const overrun = (
  overrides: Partial<DesktopBudgetEntry> = {},
): DesktopBudgetEntry => ({
  ref: id(2),
  kind: 'overrun_review',
  pool_id: 'llm.background',
  budget_month: '2030-10',
  origin: 'autonomous_analysis',
  profile_id: 'synthetic.text.v1',
  occurred_at: '2030-10-14T09:30:00.000Z',
  max_liability: xts('40000000'),
  overage_remaining: null,
  actual_gross: xts('55000000'),
  expires_at: null,
  delivery_unknown: false,
  ...overrides,
});
const manual = (
  overrides: Partial<DesktopBudgetEntry> = {},
): DesktopBudgetEntry => ({
  ref: id(3),
  kind: 'manual_settlement',
  pool_id: 'llm',
  budget_month: '2030-09',
  origin: 'owner_request',
  profile_id: 'synthetic.text.v1',
  occurred_at: '2030-09-28T22:15:00.000Z',
  max_liability: xts('40000000'),
  overage_remaining: null,
  actual_gross: null,
  expires_at: null,
  delivery_unknown: false,
  ...overrides,
});

const NOW = Date.parse('2030-10-15T00:00:00.000Z');

test('the bar shows the share of M in the remaining overage, and the part over M in an overrun', () => {
  // M 40 / 残り 60 = 66.7%（表示の目安）。
  assert.deepEqual(budgetBar(approval()), { base: 67, overflow: 0 });
  // 残りに収まらない M は、帯いっぱい。
  assert.deepEqual(budgetBar(approval({ max_liability: xts('90000000') })), {
    base: 100,
    overflow: 0,
  });
  // 実費 55 のうち M 40 までが 73%、超えた分が 27%。
  assert.deepEqual(budgetBar(overrun()), { base: 73, overflow: 27 });
  assert.equal(budgetBar(manual()), null);
  // 超過額は実費 − M（超えていなければなし）。
  assert.deepEqual(overAmount(overrun()), xts('15000000'));
  assert.equal(overAmount(overrun({ actual_gross: xts('40000000') })), null);
  assert.equal(overAmount(manual()), null);
});

test('the expiry reads as a time and turns into "expired" at the exact limit', () => {
  assert.match(expiryText(approval(), NOW) ?? '', /まで$/u);
  assert.equal(
    expiryText(approval(), Date.parse('2030-10-15T00:10:00.000Z')),
    '期限切れ',
  );
  assert.equal(
    expiryText(approval(), Date.parse('2030-10-15T00:09:59.999Z'))?.endsWith(
      'まで',
    ),
    true,
  );
  assert.equal(expiryText(overrun(), NOW), null);
  assert.equal(
    entryExpired(approval(), Date.parse('2030-10-15T00:10:00.000Z')),
    true,
  );
  assert.equal(entryExpired(approval(), NOW), false);
  assert.equal(entryExpired(manual(), NOW), false);
});

test('a manual reconciliation id starts with manual: and the amount is a decimal of up to six places', () => {
  assert.deepEqual(manualProblems(INITIAL_MANUAL_INPUT).amount !== null, true);
  assert.equal(INITIAL_MANUAL_INPUT.reconciliationId, 'manual:');
  assert.equal(manualReady(INITIAL_MANUAL_INPUT), false);
  const good = { reconciliationId: 'manual:invoice-2030-09-a', amount: '3.5' };
  assert.deepEqual(manualProblems(good), {
    reconciliationId: null,
    amount: null,
  });
  assert.equal(manualReady(good), true);
  for (const wrong of [
    { reconciliationId: 'rcpt-1', amount: '3' },
    { reconciliationId: 'manual:someone@example.com', amount: '3' },
    { reconciliationId: 'manual:', amount: '3' },
    { reconciliationId: 'manual:invoice a', amount: '3' },
    { reconciliationId: 'manual:invoice-a', amount: '' },
    { reconciliationId: 'manual:invoice-a', amount: '-3' },
    { reconciliationId: 'manual:invoice-a', amount: '3.1234567' },
    { reconciliationId: 'manual:invoice-a', amount: '1e3' },
  ])
    assert.equal(manualReady(wrong), false, JSON.stringify(wrong));
});

test('failure texts are plain sentences and never carry a reason code or an API name', () => {
  const reasons = [
    'confirmation_declined',
    'preview_stale',
    'core_rejected',
    'outcome_unknown',
    'not_connected',
    'input_stopped',
    'entry_not_found',
    'screen_operation_required',
    'device_locked',
  ] as const;
  for (const channel of [
    'desktop.budget_overage_decide',
    'desktop.budget_overrun_review',
    'desktop.budget_manual_settle',
  ] as const)
    for (const reason of reasons) {
      const text = budgetFailureText(channel, reason);
      assert(text.length > 0);
      assert.doesNotMatch(
        text,
        /[a-z]+_[a-z_]+|\/v1\/|overage_|reservation|approval_id|budget_/u,
        `${channel} ${reason}`,
      );
    }
  assert.equal(
    budgetFailureText('desktop.budget_overage_decide', 'confirmation_declined'),
    '確認でやめたため、承認していません。',
  );
  assert.equal(
    budgetFailureText('desktop.budget_manual_settle', 'confirmation_declined'),
    '確認でやめたため、精算していません。',
  );
  assert.equal(
    budgetFailureText('desktop.budget_overrun_review', 'confirmation_declined'),
    '確認でやめたため、確認していません。',
  );
});

const rejected = (
  reason: Extract<DesktopIpcResponse, { outcome: 'rejected' }>['reason'],
  channel: DesktopIpcRequest['channel'] = 'desktop.budget_overage_decide',
): DesktopIpcResponse => ({
  request_id: id(9),
  channel,
  outcome: 'rejected',
  reason,
});
const durable = (
  channel:
    | 'desktop.budget_overage_decide'
    | 'desktop.budget_overrun_review'
    | 'desktop.budget_manual_settle',
): DesktopIpcResponse => ({
  request_id: id(9),
  channel,
  outcome: 'ok',
  receipt: 'durable',
});

test('a response ends the busy state with a one-line notice; the typed manual input is kept on a refusal and dropped on success', () => {
  let state: BudgetViewState = INITIAL_BUDGET_STATE;
  state = setManualInput(state, id(3), {
    reconciliationId: 'manual:invoice-a',
    amount: '3',
  });
  state = markBusy(state, id(3));
  assert.deepEqual(state.busy, [id(3)]);
  const refused = applyBudgetResponse(
    state,
    id(3),
    'desktop.budget_manual_settle',
    'approve',
    rejected('confirmation_declined', 'desktop.budget_manual_settle'),
  );
  assert.deepEqual(refused.busy, []);
  assert.deepEqual(refused.notices[id(3)], {
    tone: 'warning',
    text: '確認でやめたため、精算していません。',
  });
  assert.equal(refused.inputs[id(3)]?.amount, '3', 'the input stays');
  const settled = applyBudgetResponse(
    state,
    id(3),
    'desktop.budget_manual_settle',
    'approve',
    durable('desktop.budget_manual_settle'),
  );
  assert.deepEqual(settled.notices[id(3)], {
    tone: 'success',
    text: '精算しました。',
  });
  assert.equal(settled.inputs[id(3)], undefined);
  assert.equal(
    applyBudgetResponse(
      markBusy(INITIAL_BUDGET_STATE, id(1)),
      id(1),
      'desktop.budget_overage_decide',
      'reject',
      durable('desktop.budget_overage_decide'),
    ).notices[id(1)]?.text,
    '見送りました。',
  );
  assert.equal(
    applyBudgetResponse(
      markBusy(INITIAL_BUDGET_STATE, id(2)),
      id(2),
      'desktop.budget_overrun_review',
      'approve',
      durable('desktop.budget_overrun_review'),
    ).notices[id(2)]?.text,
    '確認しました。',
  );
  const failed = applyBudgetFailure(
    markBusy(INITIAL_BUDGET_STATE, id(1)),
    id(1),
  );
  assert.deepEqual(failed.busy, []);
  assert.equal(failed.notices[id(1)]?.tone, 'warning');
});

test('syncing drops what belongs to entries that are gone', () => {
  let state: BudgetViewState = INITIAL_BUDGET_STATE;
  state = setManualInput(state, id(3), { amount: '3' });
  state = markBusy(state, id(1));
  state = applyBudgetFailure(state, id(2));
  const kept = syncBudget(state, [approval(), overrun(), manual()]);
  assert.equal(
    kept,
    state,
    'nothing changes while every entry is still listed',
  );
  const dropped = syncBudget(state, [approval()]);
  assert.deepEqual(dropped.inputs, {});
  assert.deepEqual(dropped.notices, {});
  assert.deepEqual(dropped.busy, [id(1)]);
});

test('actions send only the ref (and the typed id and amount for a settlement) and never twice while busy', async () => {
  const sent: DesktopIpcRequest[] = [];
  const store = new BudgetStore({
    invoke: (request) => {
      sent.push(request);
      return Promise.resolve(
        durable(
          request.channel as
            | 'desktop.budget_overage_decide'
            | 'desktop.budget_overrun_review'
            | 'desktop.budget_manual_settle',
        ),
      );
    },
  });
  store.actions.decide(id(1), 'approve');
  store.actions.decide(id(1), 'approve');
  assert.equal(sent.length, 1, 'a second press while busy sends nothing');
  assert.equal(store.snapshot().busy.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.snapshot().busy, []);
  store.actions.decide(id(1), 'reject');
  store.actions.review(id(2));
  // 精算: 入力が足りなければ送らず、問題の文言を出す。
  store.actions.settle(id(3));
  assert.deepEqual(store.snapshot().checked, [id(3)]);
  store.actions.setReconciliationId(id(3), 'manual:invoice-a');
  store.actions.setAmount(id(3), '3.5');
  store.actions.settle(id(3));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.map((request) => ({
      channel: request.channel,
      payload: request.payload,
    })),
    [
      {
        channel: 'desktop.budget_overage_decide',
        payload: { ref: id(1), decision: 'approve' },
      },
      {
        channel: 'desktop.budget_overage_decide',
        payload: { ref: id(1), decision: 'reject' },
      },
      { channel: 'desktop.budget_overrun_review', payload: { ref: id(2) } },
      {
        channel: 'desktop.budget_manual_settle',
        payload: {
          ref: id(3),
          reconciliation_id: 'manual:invoice-a',
          actual_amount: '3500000',
        },
      },
    ],
  );
  const text = JSON.stringify(sent);
  assert(!text.includes('max_liability'), 'no amount of an approval is sent');
});

test('a response that arrives after the store was hidden (lock or disconnect) is thrown away', async () => {
  let release: (response: DesktopIpcResponse) => void = () => undefined;
  const store = new BudgetStore({
    invoke: () =>
      new Promise<DesktopIpcResponse>((resolve) => {
        release = resolve;
      }),
  });
  store.actions.decide(id(1), 'approve');
  assert.deepEqual(store.snapshot().busy, [id(1)]);
  store.hide();
  assert.deepEqual(store.snapshot(), INITIAL_BUDGET_STATE);
  release(durable('desktop.budget_overage_decide'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    store.snapshot(),
    INITIAL_BUDGET_STATE,
    'nothing comes back',
  );
  // 読み上げのための見出しの名前は、画面の固定の文言（理由のコードではない）。
  assert.equal(BUDGET_LABELS.section, '予算の確認');
});

test('the pool, the origin and the time are shown by names the person can read, never by an internal ID', () => {
  assert.equal(poolText(approval()), '会話');
  assert.equal(poolText(overrun()), '自動の解析');
  assert.equal(poolText(manual({ pool_id: 'search' })), '検索');
  assert.equal(poolText(manual({ pool_id: 'voice' })), '音声');
  assert.equal(poolText(manual({ pool_id: 'overage' })), '超過枠');
  // 対応表にない枠（設定で足した枠）は内部の ID を出さない。
  assert.equal(
    poolText(manual({ pool_id: 'llm.secret-experiment' })),
    '別の枠',
  );
  assert.equal(originText(approval()), null);
  assert.equal(originText(overrun()), '自動の解析');
  assert.equal(originText(manual()), '本人の依頼');
  assert.equal(occurredText(approval({ occurred_at: null })), null);
  // 端末の地域時間の「月/日 時:分」（今日でも月日を付ける）。
  const local = new Date('2030-10-14T09:30:00.000Z');
  const pad = (n: number) => String(n).padStart(2, '0');
  assert.equal(
    occurredText(overrun()),
    `${local.getMonth() + 1}/${local.getDate()} ${pad(local.getHours())}:${pad(local.getMinutes())}`,
  );
});
