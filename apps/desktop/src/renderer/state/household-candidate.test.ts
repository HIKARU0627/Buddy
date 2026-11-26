// 会話の一言からの家計の記録の候補（household-candidate.ts・work-state.ts・household-state.ts。ADR 0171・0174）の試験。
// 期待値は手で書く。
// 候補は会話の発言が受け付けられたときだけ出ること、中枢へは発言の本文だけを送ること（候補の値を送らない）、候補で開いた
// 手入力の欄は本人が「足す」を押すまで何も送らないこと、閉じても何も送らないこと、足すのは一度だけで結果不明でも自動では
// 送り直さないこと、ロック・切断で捨てることを確かめる。
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import type {
  DesktopHouseholdView,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import {
  HOUSEHOLD_UNREADABLE_TEXT,
  householdCandidateNote,
  householdCandidateText,
  inputFromCandidate,
  localDateText,
} from './household-candidate.js';
import {
  HouseholdStore,
  INITIAL_HOUSEHOLD_STATE,
  canStartAddFrom,
  manualEntryFromInput,
} from './household-state.js';
import { INITIAL_WORK_STATE, WorkStore } from './work-state.js';

const test = (name: string, fn: () => void | Promise<void>) =>
  nodeTest(name, { timeout: 10_000 }, fn);

// 送った要求を記録し、答えを手で返す。
function fakeApi() {
  const sent: DesktopIpcRequest[] = [];
  const pending: ((response: DesktopIpcResponse) => void)[] = [];
  return {
    sent,
    answer(response: (request: DesktopIpcRequest) => DesktopIpcResponse) {
      const index = sent.length - pending.length;
      const resolve = pending.shift();
      const request = sent[index];
      if (resolve === undefined || request === undefined)
        throw new Error('nothing pending');
      resolve(response(request));
    },
    api: {
      invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse> {
        sent.push(request);
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const turnOk = (request: DesktopIpcRequest): DesktopIpcResponse => ({
  request_id: request.request_id,
  channel: 'desktop.turn_submit',
  outcome: 'ok',
  turn: { status: 'answered', reply_text: '了解です。', result: null },
});

const rejected = (
  request: DesktopIpcRequest,
  reason: string,
): DesktopIpcResponse =>
  ({
    request_id: request.request_id,
    channel: request.channel,
    outcome: 'rejected',
    reason,
  }) as DesktopIpcResponse;

const view = (
  overrides: Partial<DesktopHouseholdView> = {},
): DesktopHouseholdView => ({
  fetch: 'loaded',
  fetched_at: '2030-11-05T03:00:00Z',
  current_month: '2030-11',
  months: [],
  month: '2030-11',
  entries: [],
  summary: {
    expense_yen: 0,
    income_yen: 0,
    balance_yen: 0,
    entry_count: 0,
    expense_by_category: [],
    transfer_yen: 0,
  },
  unreadable: 0,
  truncated: false,
  list_seq: 2,
  mail_intake: 'on',
  last_import: null,
  last_export: null,
  recurring: null,
  budget: null,
  ...overrides,
});

const householdOk = (
  request: DesktopIpcRequest,
  household: DesktopHouseholdView,
): DesktopIpcResponse =>
  ({
    request_id: request.request_id,
    channel: request.channel,
    outcome: 'ok',
    household,
  }) as DesktopIpcResponse;

const DRAFT = {
  direction: 'expense',
  amount_yen: 500,
  occurred_on: '2030-11-26',
  merchant: 'コンビニ',
  memo: null,
  payment: '現金',
} as const;

// 収入の候補（ADR 0174）。出どころはメモに入れる。
const INCOME_DRAFT = {
  direction: 'income',
  amount_yen: 250000,
  occurred_on: '2030-11-25',
  merchant: null,
  memo: '給料',
  payment: null,
} as const;

test('the candidate is written with no-break spaces, and a missing date asks for it', () => {
  assert.equal(
    householdCandidateText(DRAFT),
    '支出 500\u00a0円・コンビニ・現金・11\u00a0月\u00a026\u00a0日',
  );
  assert.equal(
    householdCandidateText({
      direction: 'expense',
      amount_yen: 12000,
      occurred_on: null,
      merchant: null,
      memo: null,
      payment: null,
    }),
    '支出 12,000\u00a0円・日付は入力欄で入れてください',
  );
  assert.equal(
    householdCandidateText(INCOME_DRAFT),
    '収入 250,000\u00a0円・給料・11\u00a0月\u00a025\u00a0日',
  );
  assert.equal(
    householdCandidateText({ ...INCOME_DRAFT, memo: null, payment: '現金' }),
    '収入 250,000\u00a0円・現金・11\u00a0月\u00a025\u00a0日',
  );
  // 支出は分類を選ぶように、収入は収入として記録することを書く。
  assert.match(householdCandidateNote(DRAFT), /分類を選んでから/u);
  assert.match(householdCandidateNote(INCOME_DRAFT), /収入として記録します/u);
  assert.doesNotMatch(householdCandidateNote(INCOME_DRAFT), /分類を選んで/u);
  assert.equal(localDateText(new Date(2030, 0, 5, 23, 59)), '2030-01-05');
  // 理由のコードを画面の文に出さない。
  for (const [reason, text] of Object.entries(HOUSEHOLD_UNREADABLE_TEXT)) {
    assert.ok(!text.includes(reason), reason);
    assert.match(text, /家計簿の欄/u, reason);
  }
});

test('the candidate fills the manual form as an uncategorized expense; a missing date cannot be sent', () => {
  const input = inputFromCandidate(DRAFT);
  assert.deepEqual(input, {
    direction: 'expense',
    amount: '500',
    date: '2030-11-26',
    time: '',
    category: 'uncategorized',
    merchant: 'コンビニ',
    memo: '',
    payment: '現金',
  });
  assert.deepEqual(manualEntryFromInput(input), {
    direction: 'expense',
    amount_yen: 500,
    occurred_on: '2030-11-26',
    occurred_time: null,
    category: 'uncategorized',
    merchant: 'コンビニ',
    memo: null,
    payment: '現金',
  });
  assert.equal(
    manualEntryFromInput(
      inputFromCandidate({ ...DRAFT, occurred_on: null, merchant: null }),
    ),
    null,
  );
});

test('an accepted turn shows the candidate; Core receives only the text, and the next turn replaces it', async () => {
  const fake = fakeApi();
  const store = new WorkStore(fake.api, () => '2030-11-26');
  store.actions.setDraft('  昨日コンビニで 500 円使った  ');
  store.actions.submit();
  assert.deepEqual(fake.sent[0]?.payload, {
    text: '昨日コンビニで 500 円使った',
  });
  // 受け付けられるまでは出さない。
  assert.equal(store.snapshot().householdCandidate, null);
  fake.answer(turnOk);
  await settle();
  assert.deepEqual(store.snapshot().householdCandidate, {
    kind: 'draft',
    draft: {
      direction: 'expense',
      amount_yen: 500,
      occurred_on: '2030-11-25',
      merchant: 'コンビニ',
      memo: null,
      payment: null,
    },
  });
  // 拒否された発言は候補を変えない（入力は残る）。
  store.actions.setDraft('タクシーで 100 ドル払った');
  store.actions.submit();
  fake.answer((request) => rejected(request, 'not_connected'));
  await settle();
  assert.equal(store.snapshot().householdCandidate?.kind, 'draft');
  // 受け付けられた次の発言で置き換える（読めない理由を出す）。
  store.actions.submit();
  fake.answer(turnOk);
  await settle();
  assert.deepEqual(store.snapshot().householdCandidate, {
    kind: 'unreadable',
    reason: 'foreign_currency',
  });
  // 支出の話でなければ何も出さない。
  store.actions.setDraft('今日の予定を見せて');
  store.actions.submit();
  fake.answer(turnOk);
  await settle();
  assert.equal(store.snapshot().householdCandidate, null);
  // 候補のために送った要求は、発言の 4 件だけ。
  assert.deepEqual(
    fake.sent.map((request) => request.channel),
    [
      'desktop.turn_submit',
      'desktop.turn_submit',
      'desktop.turn_submit',
      'desktop.turn_submit',
    ],
  );
});

test('closing the candidate sends nothing, and a lock or a disconnect drops it with the late answer', async () => {
  const fake = fakeApi();
  const store = new WorkStore(fake.api, () => '2030-11-26');
  store.actions.setDraft('コンビニで 500 円使った');
  store.actions.submit();
  fake.answer(turnOk);
  await settle();
  assert.equal(store.snapshot().householdCandidate?.kind, 'draft');
  store.actions.dismissHouseholdCandidate();
  assert.equal(store.snapshot().householdCandidate, null);
  assert.equal(fake.sent.length, 1);
  // 送っている間にロック・切断: 候補ごと捨て、遅い応答から候補を出さない。
  store.actions.setDraft('コンビニで 600 円使った');
  store.actions.submit();
  store.hide();
  fake.answer(turnOk);
  await settle();
  assert.deepEqual(store.snapshot(), INITIAL_WORK_STATE);
});

test('the form opens from the candidate only after a read and never over a form being filled', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  const input = inputFromCandidate(DRAFT);
  // まだ読めていない。
  assert.equal(store.actions.startAddFrom(input), false);
  assert.equal(store.snapshot().adding, false);
  store.actions.refresh();
  fake.answer((request) =>
    householdOk(request, view({ fetch: 'unavailable' })),
  );
  await settle();
  assert.equal(canStartAddFrom(store.snapshot()), false);
  assert.equal(store.actions.startAddFrom(input), false);
  store.actions.refresh();
  fake.answer((request) => householdOk(request, view({ list_seq: 3 })));
  await settle();
  assert.equal(canStartAddFrom(store.snapshot()), true);
  assert.equal(store.actions.startAddFrom(input), true);
  assert.equal(store.snapshot().adding, true);
  assert.deepEqual(store.snapshot().addPrefill, input);
  // 欄を開いている間は、別の候補で書き換えない。
  assert.equal(canStartAddFrom(store.snapshot()), false);
  assert.equal(
    store.actions.startAddFrom(inputFromCandidate({ ...DRAFT, amount_yen: 9 })),
    false,
  );
  assert.deepEqual(store.snapshot().addPrefill, input);
  // 確定せずに閉じる: 何も送らない（読み取りの 2 件だけ）。
  store.actions.cancelAdd();
  assert.equal(store.snapshot().adding, false);
  assert.equal(store.snapshot().addPrefill, null);
  assert.deepEqual(
    fake.sent.map((request) => request.channel),
    ['desktop.household_view', 'desktop.household_view'],
  );
  // 手で開く欄は空にする。
  store.actions.startAddFrom(input);
  store.actions.cancelAdd();
  store.actions.startAdd();
  assert.equal(store.snapshot().addPrefill, null);
  // ロック・切断で捨てる。
  store.actions.cancelAdd();
  store.actions.startAddFrom(input);
  store.hide();
  assert.deepEqual(store.snapshot(), INITIAL_HOUSEHOLD_STATE);
});

test('the candidate becomes a record only by pressing add, once; an unknown result is not sent again', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => householdOk(request, view()));
  await settle();
  const input = inputFromCandidate(DRAFT);
  store.actions.startAddFrom(input);
  const entry = manualEntryFromInput(input);
  assert.notEqual(entry, null);
  if (entry === null) return;
  store.actions.addEntry(entry);
  // 二度押しても一度だけ送る。
  store.actions.addEntry(entry);
  const adds = () =>
    fake.sent.filter((request) => request.channel === 'desktop.household_add');
  assert.equal(adds().length, 1);
  assert.deepEqual(adds()[0]?.payload, {
    entry: {
      direction: 'expense',
      amount_yen: 500,
      occurred_on: '2030-11-26',
      occurred_time: null,
      category: 'uncategorized',
      merchant: 'コンビニ',
      memo: null,
      payment: '現金',
    },
  });
  fake.answer((request) => rejected(request, 'outcome_unknown'));
  await settle();
  // 結果不明: 送り直さず、読み直すだけ。欄は残る（本人が読み直して確かめる）。
  assert.equal(adds().length, 1);
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_view');
  assert.equal(store.snapshot().adding, true);
  assert.match(store.snapshot().notice?.text ?? '', /自動では送り直しません/u);
  fake.answer((request) => householdOk(request, view({ list_seq: 3 })));
  await settle();
  // 本人がもう一度押したときだけ送り、足せたら欄と候補の値をしまう。
  store.actions.addEntry(entry);
  assert.equal(adds().length, 2);
  fake.answer((request) => householdOk(request, view({ list_seq: 4 })));
  await settle();
  assert.equal(store.snapshot().adding, false);
  assert.equal(store.snapshot().addPrefill, null);
  assert.equal(store.snapshot().notice?.text, '記録を足しました。');
});

test('an income candidate fills the manual form as income with the income category and the source in the memo', () => {
  const input = inputFromCandidate(INCOME_DRAFT);
  assert.deepEqual(input, {
    direction: 'income',
    amount: '250000',
    date: '2030-11-25',
    time: '',
    category: 'income',
    merchant: '',
    memo: '給料',
    payment: '',
  });
  assert.deepEqual(manualEntryFromInput(input), {
    direction: 'income',
    amount_yen: 250000,
    occurred_on: '2030-11-25',
    occurred_time: null,
    category: 'income',
    merchant: null,
    memo: '給料',
    payment: null,
  });
  // 日付がなければ送れない（支出と同じ）。
  assert.equal(
    manualEntryFromInput(
      inputFromCandidate({ ...INCOME_DRAFT, occurred_on: null }),
    ),
    null,
  );
});

test('an accepted income turn shows an income candidate, and an utterance with both directions shows only the reason', async () => {
  const fake = fakeApi();
  const store = new WorkStore(fake.api, () => '2030-11-26');
  store.actions.setDraft('昨日給料が 25 万円入った');
  store.actions.submit();
  assert.deepEqual(fake.sent[0]?.payload, {
    text: '昨日給料が 25 万円入った',
  });
  assert.equal(store.snapshot().householdCandidate, null);
  fake.answer(turnOk);
  await settle();
  assert.deepEqual(store.snapshot().householdCandidate, {
    kind: 'draft',
    draft: {
      direction: 'income',
      amount_yen: 250000,
      occurred_on: '2030-11-25',
      merchant: null,
      memo: '給料',
      payment: null,
    },
  });
  store.actions.setDraft('本を 3000 円で売った後、別の本を買った');
  store.actions.submit();
  fake.answer(turnOk);
  await settle();
  assert.deepEqual(store.snapshot().householdCandidate, {
    kind: 'unreadable',
    reason: 'direction_unclear',
  });
  // 返金は収入にしない。
  store.actions.setDraft('返金で 500 円入った');
  store.actions.submit();
  fake.answer(turnOk);
  await settle();
  assert.deepEqual(store.snapshot().householdCandidate, {
    kind: 'unreadable',
    reason: 'cancellation',
  });
  // 閉じても何も送らない（発言の 3 件だけ）。
  store.actions.dismissHouseholdCandidate();
  assert.equal(store.snapshot().householdCandidate, null);
  assert.deepEqual(
    fake.sent.map((request) => request.channel),
    ['desktop.turn_submit', 'desktop.turn_submit', 'desktop.turn_submit'],
  );
});

test('the form opened from an income candidate sends nothing when closed, and sends one income entry only when add is pressed', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => householdOk(request, view()));
  await settle();
  const input = inputFromCandidate(INCOME_DRAFT);
  assert.equal(store.actions.startAddFrom(input), true);
  assert.equal(store.snapshot().addPrefill?.direction, 'income');
  assert.equal(store.snapshot().addPrefill?.category, 'income');
  // 確定せずに閉じる: 何も送らない（読み取りの 1 件だけ）。
  store.actions.cancelAdd();
  assert.equal(store.snapshot().adding, false);
  assert.equal(store.snapshot().addPrefill, null);
  assert.deepEqual(
    fake.sent.map((request) => request.channel),
    ['desktop.household_view'],
  );
  // もう一度開いて「足す」を押したときだけ、収入の記録を一度だけ送る。
  assert.equal(store.actions.startAddFrom(input), true);
  const entry = manualEntryFromInput(input);
  assert.notEqual(entry, null);
  if (entry === null) return;
  store.actions.addEntry(entry);
  store.actions.addEntry(entry);
  const adds = fake.sent.filter(
    (request) => request.channel === 'desktop.household_add',
  );
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0]?.payload, {
    entry: {
      direction: 'income',
      amount_yen: 250000,
      occurred_on: '2030-11-25',
      occurred_time: null,
      category: 'income',
      merchant: null,
      memo: '給料',
      payment: null,
    },
  });
});
