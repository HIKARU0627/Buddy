// 家計簿の画面の状態（household-state.ts。ADR 0162）の試験。期待値は手で書く。
// 金額・月・日付の書き方を端末の言語の設定に依らずに書くこと、向きごとの分類の選択肢、未取得を「記録なし」にしないこと、
// 分類の変更は選んだらすぐ参照で送ること、削除は確かめてから参照で送ること、拒否で読み直すこと、古い値と世代をまたいだ
// 応答を捨てることを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DesktopHouseholdEntry,
  DesktopHouseholdView,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import {
  HouseholdStore,
  INITIAL_HOUSEHOLD_STATE,
  applyViewResponse,
  categoryChoices,
  categoryLabel,
  budgetItemsFromInput,
  budgetUseText,
  dayText,
  importResultText,
  inputFromEntry,
  manualEntryFromInput,
  monthText,
  yenText,
} from './household-state.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const entry = (
  n: number,
  overrides: Partial<DesktopHouseholdEntry> = {},
): DesktopHouseholdEntry => ({
  ref: id(n),
  position: n,
  source_kind: 'mail_notice',
  direction: 'expense',
  amount_yen: 1280,
  occurred_on: '2030-11-03',
  occurred_time: '12:34',
  category: 'food',
  merchant: '合成の食堂',
  memo: null,
  payment: '合成のカード',
  delivery_unknown: false,
  ...overrides,
});

const view = (
  entries: DesktopHouseholdEntry[],
  overrides: Partial<DesktopHouseholdView> = {},
): DesktopHouseholdView => ({
  fetch: 'loaded',
  fetched_at: '2030-11-05T03:00:00Z',
  current_month: '2030-11',
  months: [],
  month: '2030-11',
  entries,
  summary: {
    expense_yen: 1280,
    income_yen: 0,
    balance_yen: -1280,
    entry_count: 1,
    expense_by_category: [{ category: 'food', total_yen: 1280, count: 1 }],
    transfer_yen: 0,
  },
  unreadable: 0,
  truncated: false,
  list_seq: 2,
  mail_intake: 'on',
  last_import: null,
  recurring: null,
  budget: null,
  ...overrides,
});

const okResponse = (
  request: DesktopIpcRequest,
  household: DesktopHouseholdView,
): DesktopIpcResponse =>
  ({
    request_id: request.request_id,
    channel: request.channel,
    outcome: 'ok',
    household,
  }) as DesktopIpcResponse;

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

test('amounts, months and days are written the same way whatever the system language', () => {
  assert.equal(yenText(1280), '1,280\u00a0円');
  assert.equal(yenText(1234567), '1,234,567\u00a0円');
  assert.equal(yenText(-3000), '-3,000\u00a0円');
  assert.equal(yenText(0), '0\u00a0円');
  assert.equal(monthText('2030-01'), '2030\u00a0年\u00a01\u00a0月');
  assert.equal(monthText('bad'), 'bad');
  assert.equal(dayText(entry(0)), '11\u00a0月\u00a03\u00a0日 12:34');
  assert.equal(
    dayText(entry(0, { occurred_time: null, occurred_on: '2030-11-01' })),
    '11\u00a0月\u00a01\u00a0日',
  );
});

test('the category choices follow the direction of the entry', () => {
  const expense = categoryChoices('expense');
  assert.equal(expense.length, 18);
  assert.deepEqual(expense[0], { id: 'food', label: '食費' });
  assert.deepEqual(expense.at(-1), { id: 'uncategorized', label: '未分類' });
  assert.deepEqual(categoryChoices('income'), [
    { id: 'income', label: '収入' },
  ]);
  assert.deepEqual(categoryChoices('transfer'), [
    { id: 'transfer', label: '振替' },
  ]);
  assert.equal(categoryLabel('utilities'), '水道・光熱費');
});

test('a rejected read warns at the head and an overtaken read waits for the later one', () => {
  const request = {
    channel: 'desktop.household_view',
    request_id: id(1),
    payload: { month: null },
  } as DesktopIpcRequest;
  const reading = { ...INITIAL_HOUSEHOLD_STATE, reading: true };
  const warned = applyViewResponse(reading, rejected(request, 'not_connected'));
  assert.equal(warned.reading, false);
  assert.match(warned.notice?.text ?? '', /中枢に接続していないため/u);
  assert.equal(warned.notice?.place, null);
  assert.equal(
    applyViewResponse(reading, rejected(request, 'list_superseded')),
    reading,
  );
  // 古い通し番号の値は反映しない。
  const shown = applyViewResponse(
    reading,
    okResponse(request, view([entry(0)], { list_seq: 5 })),
  );
  assert.equal(shown.seq, 5);
  assert.equal(
    applyViewResponse(shown, okResponse(request, view([], { list_seq: 4 })))
      .view?.entries.length,
    1,
  );
});

test('opening reads the current month, choosing a month reads it, and refresh keeps the shown month', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  assert.deepEqual(fake.sent.at(-1)?.payload, { month: null });
  assert.equal(store.snapshot().reading, true);
  fake.answer((request) => okResponse(request, view([entry(0)])));
  await settle();
  assert.equal(store.snapshot().reading, false);
  assert.equal(store.snapshot().view?.month, '2030-11');
  store.actions.selectMonth('2030-10');
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_view');
  assert.deepEqual(fake.sent.at(-1)?.payload, { month: '2030-10' });
  fake.answer((request) =>
    okResponse(request, view([], { month: '2030-10', list_seq: 3 })),
  );
  await settle();
  store.actions.refresh();
  assert.deepEqual(fake.sent.at(-1)?.payload, { month: '2030-10' });
});

test('a category change is sent by reference at once; the same category is not sent', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => okResponse(request, view([entry(0)])));
  await settle();
  store.actions.changeCategory(id(0), 'food');
  assert.equal(fake.sent.length, 1);
  store.actions.changeCategory(id(0), 'social');
  assert.deepEqual(fake.sent.at(-1), {
    channel: 'desktop.household_category',
    request_id: fake.sent.at(-1)?.request_id,
    payload: { ref: id(0), category: 'social' },
  });
  assert.equal(store.snapshot().busy, id(0));
  // 待っている間は別の行を操作させない。
  store.actions.changeCategory(id(1), 'social');
  store.actions.startDelete(id(0));
  assert.equal(fake.sent.length, 2);
  fake.answer((request) =>
    okResponse(
      request,
      view([entry(0, { category: 'social' })], { list_seq: 3 }),
    ),
  );
  await settle();
  const state = store.snapshot();
  assert.equal(state.busy, null);
  assert.equal(state.view?.entries[0]?.category, 'social');
  assert.equal(state.notice?.tone, 'success');
  assert.equal(state.notice?.place, id(0));
});

test('a deletion is confirmed in the screen first, then sent by reference', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => okResponse(request, view([entry(0), entry(1)])));
  await settle();
  // 確かめを出さずに確定はできない。
  store.actions.confirmDelete();
  assert.equal(fake.sent.length, 1);
  store.actions.startDelete(id(1));
  assert.equal(store.snapshot().confirming, id(1));
  store.actions.cancelDelete();
  assert.equal(store.snapshot().confirming, null);
  store.actions.startDelete(id(1));
  store.actions.confirmDelete();
  assert.deepEqual(fake.sent.at(-1)?.payload, { ref: id(1) });
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_delete');
  fake.answer((request) =>
    okResponse(request, view([entry(0)], { list_seq: 3 })),
  );
  await settle();
  const state = store.snapshot();
  assert.equal(state.confirming, null);
  assert.equal(state.notice?.text, '記録を削除しました。');
  // 消えた行の代わりに欄の頭へ出す。
  assert.equal(state.notice?.place, null);
});

test('a stale or unknown result warns on the row and re-reads the shown month', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => okResponse(request, view([entry(0)])));
  await settle();
  store.actions.changeCategory(id(0), 'social');
  fake.answer((request) => rejected(request, 'preview_stale'));
  await settle();
  assert.match(
    store.snapshot().notice?.text ?? '',
    /その後に変わっていました/u,
  );
  assert.equal(store.snapshot().notice?.place, id(0));
  // 読み直しを送った（今出している月）。
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_view');
  assert.deepEqual(fake.sent.at(-1)?.payload, { month: '2030-11' });
  fake.answer((request) =>
    okResponse(
      request,
      view([entry(0, { category: 'social' })], { list_seq: 3 }),
    ),
  );
  await settle();
  // 知らせは残したまま、値だけ新しくする。
  assert.match(
    store.snapshot().notice?.text ?? '',
    /その後に変わっていました/u,
  );
  assert.equal(store.snapshot().view?.entries[0]?.category, 'social');
  // 結果の分からなかった行は操作させない。
  store.actions.startDelete(id(0));
  store.actions.confirmDelete();
  fake.answer((request) => rejected(request, 'outcome_unknown'));
  await settle();
  assert.match(store.snapshot().notice?.text ?? '', /送り直しません/u);
  fake.answer((request) =>
    okResponse(
      request,
      view([entry(0, { delivery_unknown: true })], { list_seq: 4 }),
    ),
  );
  await settle();
  const sentBefore = fake.sent.length;
  store.actions.changeCategory(id(0), 'food');
  assert.equal(fake.sent.length, sentBefore);
});

test('responses that cross a hide are dropped', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  store.hide();
  fake.answer((request) => okResponse(request, view([entry(0)])));
  await settle();
  assert.deepEqual(store.snapshot(), INITIAL_HOUSEHOLD_STATE);
  // 通信できなかったときは欄の頭に知らせる。
  const failing = new HouseholdStore({
    invoke: () => Promise.reject(new Error('ipc')),
  });
  failing.actions.refresh();
  await settle();
  assert.match(failing.snapshot().notice?.text ?? '', /通信できませんでした/u);
  assert.equal(failing.snapshot().reading, false);
});

test('the intake switch sends the other value once and re-reads on a stale answer', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => okResponse(request, view([entry(0)])));
  await settle();
  // 今と同じ値は送らない。
  store.actions.setIntake('on');
  assert.equal(fake.sent.length, 1);
  store.actions.setIntake('off');
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_intake');
  assert.deepEqual(fake.sent.at(-1)?.payload, { mail_intake: 'off' });
  assert.equal(store.snapshot().busy, 'intake');
  store.actions.setIntake('off');
  assert.equal(fake.sent.length, 2);
  fake.answer((request) => rejected(request, 'preview_stale'));
  await settle();
  assert.match(
    store.snapshot().notice?.text ?? '',
    /取り込みの設定はその後に変わっていました/u,
  );
  assert.equal(store.snapshot().notice?.place, 'intake');
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_view');
  fake.answer((request) =>
    okResponse(request, view([entry(0)], { mail_intake: 'off', list_seq: 3 })),
  );
  await settle();
  assert.equal(store.snapshot().view?.mail_intake, 'off');
  assert.equal(store.snapshot().busy, null);
});

test('the import is one request with no file data from the screen, and its result is written in counts', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  // 読む前は取り込ませない。
  store.actions.importExport();
  assert.equal(fake.sent.length, 0);
  store.actions.refresh();
  fake.answer((request) => okResponse(request, view([entry(0)])));
  await settle();
  store.actions.importExport();
  assert.deepEqual(fake.sent.at(-1)?.payload, null);
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_import');
  assert.equal(store.snapshot().busy, 'import');
  const result = {
    outcome: 'done' as const,
    created: 3,
    duplicate: 1,
    matched: 2,
    rejected: 0,
    skipped: 4,
    rules_learned: 1,
  };
  fake.answer((request) =>
    okResponse(request, view([entry(0)], { last_import: result, list_seq: 3 })),
  );
  await settle();
  assert.equal(store.snapshot().busy, null);
  assert.equal(
    importResultText(result),
    '取り込みました（新しく記録\u00a03\u00a0件、取り込み済み\u00a01\u00a0件、利用通知と同じ\u00a02\u00a0件、集計から外した行など\u00a04\u00a0件。）',
  );
  assert.match(
    importResultText({ ...result, outcome: 'stopped', skipped: 0 }),
    /^途中で中枢に送れなくなったため止めました（新しく記録\u00a03\u00a0件、取り込み済み\u00a01\u00a0件、利用通知と同じ\u00a02\u00a0件。）もう一度取り込むと/u,
  );
  assert.match(
    importResultText({ ...result, outcome: 'unreadable' }),
    /^ファイルを読めませんでした。/u,
  );
});

test('budget input accepts empty, full-width digits and commas, and refuses anything else', () => {
  assert.deepEqual(
    budgetItemsFromInput({
      food: '４０，０００',
      utilities: ' 12000 ',
      hobby: '',
    }),
    [
      { category: 'food', budget_yen: 40000 },
      { category: 'utilities', budget_yen: 12000 },
    ],
  );
  assert.deepEqual(budgetItemsFromInput({}), []);
  for (const bad of ['0', '-1', '1.5', '１万', '10000000000'])
    assert.equal(budgetItemsFromInput({ food: bad }), null, bad);
  assert.equal(
    budgetUseText({
      budget_yen: 40000,
      spent_yen: 12000,
      remaining_yen: 28000,
    }),
    '12,000\u00a0円 / 40,000\u00a0円（残り 28,000\u00a0円）',
  );
  assert.equal(
    budgetUseText({
      budget_yen: 40000,
      spent_yen: 42000,
      remaining_yen: -2000,
    }),
    '42,000\u00a0円 / 40,000\u00a0円（2,000\u00a0円の超過）',
  );
});

test('the budget editor opens only with a read budget, saves once and closes on success', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.startBudget();
  assert.equal(store.snapshot().editingBudget, false);
  store.actions.refresh();
  fake.answer((request) =>
    okResponse(
      request,
      view([entry(0)], { budget: { items: [], total_budget_yen: 0 } }),
    ),
  );
  await settle();
  store.actions.startBudget();
  assert.equal(store.snapshot().editingBudget, true);
  store.actions.saveBudget([{ category: 'food', budget_yen: 40000 }]);
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_budget');
  assert.deepEqual(fake.sent.at(-1)?.payload, {
    items: [{ category: 'food', budget_yen: 40000 }],
  });
  store.actions.saveBudget([]);
  assert.equal(fake.sent.length, 2);
  fake.answer((request) =>
    okResponse(
      request,
      view([entry(0)], {
        budget: {
          items: [{ category: 'food', budget_yen: 40000 }],
          total_budget_yen: 40000,
        },
        list_seq: 3,
      }),
    ),
  );
  await settle();
  assert.equal(store.snapshot().editingBudget, false);
  assert.equal(store.snapshot().notice?.text, '予算を保存しました。');
  // 拒否なら入力欄を残す。
  store.actions.startBudget();
  store.actions.saveBudget([]);
  fake.answer((request) => rejected(request, 'preview_stale'));
  await settle();
  assert.equal(store.snapshot().editingBudget, true);
  assert.match(
    store.snapshot().notice?.text ?? '',
    /予算はその後に変わっていました/u,
  );
});

test('a manual entry is built from the inputs and refused when the amount, date or time is malformed', () => {
  const base = {
    direction: 'expense' as const,
    amount: '６８０',
    date: '2030-11-04',
    time: '08:15',
    category: 'food' as const,
    merchant: ' 合成のパン屋 ',
    memo: '',
    payment: '',
  };
  assert.deepEqual(manualEntryFromInput(base), {
    direction: 'expense',
    amount_yen: 680,
    occurred_on: '2030-11-04',
    occurred_time: '08:15',
    category: 'food',
    merchant: '合成のパン屋',
    memo: null,
    payment: null,
  });
  // 収入にしたら分類は収入にそろえる。
  assert.equal(
    manualEntryFromInput({ ...base, direction: 'income' })?.category,
    'income',
  );
  for (const over of [
    { amount: '0' },
    { amount: '1.5' },
    { date: '2030-02-30' },
    { date: '1999-12-31' },
    { date: '' },
    { time: '8:15' },
  ])
    assert.equal(
      manualEntryFromInput({ ...base, ...over }),
      null,
      JSON.stringify(over),
    );
});

test('the add form opens only after a read, sends once and closes on success', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.startAdd();
  assert.equal(store.snapshot().adding, false);
  store.actions.refresh();
  fake.answer((request) => okResponse(request, view([entry(0)])));
  await settle();
  store.actions.startAdd();
  assert.equal(store.snapshot().adding, true);
  const manual = {
    direction: 'expense' as const,
    amount_yen: 680,
    occurred_on: '2030-11-04',
    occurred_time: null,
    category: 'food' as const,
    merchant: null,
    memo: null,
    payment: null,
  };
  store.actions.addEntry(manual);
  store.actions.addEntry(manual);
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_add');
  assert.deepEqual(fake.sent.at(-1)?.payload, { entry: manual });
  fake.answer((request) =>
    okResponse(request, view([entry(0), entry(1)], { list_seq: 3 })),
  );
  await settle();
  assert.equal(store.snapshot().adding, false);
  assert.equal(store.snapshot().notice?.text, '記録を足しました。');
  store.actions.startAdd();
  store.actions.addEntry(manual);
  fake.answer((request) => rejected(request, 'core_rejected'));
  await settle();
  assert.equal(store.snapshot().adding, true);
  assert.match(
    store.snapshot().notice?.text ?? '',
    /中身を受け付けませんでした/u,
  );
});

const EDITED = {
  direction: 'expense' as const,
  amount_yen: 1500,
  occurred_on: '2030-12-02',
  occurred_time: '09:05',
  category: 'social' as const,
  merchant: '合成の食堂',
  memo: 'メモを直した',
  payment: null,
};

test('the edit form is filled with the current values of the row', () => {
  assert.deepEqual(inputFromEntry(entry(0)), {
    direction: 'expense',
    amount: '1280',
    date: '2030-11-03',
    time: '12:34',
    category: 'food',
    merchant: '合成の食堂',
    memo: '',
    payment: '合成のカード',
  });
  assert.deepEqual(
    inputFromEntry(
      entry(1, {
        direction: 'income',
        category: 'income',
        occurred_time: null,
        merchant: null,
        payment: null,
        memo: '賞与',
      }),
    ),
    {
      direction: 'income',
      amount: '1280',
      date: '2030-11-03',
      time: '',
      category: 'income',
      merchant: '',
      memo: '賞与',
      payment: '',
    },
  );
});

test('the edit form opens on a row that can be changed, sends once by reference and closes on success', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  // まだ読んでいない・知らない参照では開かない。
  store.actions.startEdit(id(0));
  assert.equal(store.snapshot().editing, null);
  store.actions.refresh();
  fake.answer((request) =>
    okResponse(request, view([entry(0), entry(1, { delivery_unknown: true })])),
  );
  await settle();
  store.actions.startEdit(id(9));
  assert.equal(store.snapshot().editing, null);
  // 結果の分からない行は直させない。
  store.actions.startEdit(id(1));
  assert.equal(store.snapshot().editing, null);
  // 欄を開く前は送らない。
  store.actions.editEntry(id(0), EDITED);
  assert.equal(fake.sent.length, 1);
  store.actions.startEdit(id(0));
  assert.equal(store.snapshot().editing, id(0));
  store.actions.editEntry(id(0), EDITED);
  store.actions.editEntry(id(0), EDITED);
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_edit');
  assert.deepEqual(fake.sent.at(-1)?.payload, {
    ref: id(0),
    entry: EDITED,
  });
  assert.equal(store.snapshot().busy, id(0));
  fake.answer((request) =>
    okResponse(
      request,
      view([entry(0, { amount_yen: 1500 })], { list_seq: 3 }),
    ),
  );
  await settle();
  assert.equal(store.snapshot().editing, null);
  assert.equal(store.snapshot().busy, null);
  assert.equal(store.snapshot().notice?.tone, 'success');
  // 日付を直すと別の月へ移ることがあるので、知らせは欄の頭に出す。
  assert.equal(store.snapshot().notice?.place, null);
  assert.match(store.snapshot().notice?.text ?? '', /中身を直しました/u);
  assert.equal(store.snapshot().view?.entries[0]?.amount_yen, 1500);
});

test('a rejected edit keeps the form, a stale one re-reads, an unknown result closes the form and locks the row', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => okResponse(request, view([entry(0)])));
  await settle();
  // 422（core_rejected）: 欄を残して直させる。読み直す。
  store.actions.startEdit(id(0));
  store.actions.editEntry(id(0), EDITED);
  fake.answer((request) => rejected(request, 'core_rejected'));
  await settle();
  assert.equal(store.snapshot().editing, id(0));
  assert.equal(store.snapshot().busy, null);
  assert.equal(store.snapshot().notice?.tone, 'warning');
  assert.equal(store.snapshot().notice?.place, id(0));
  assert.match(
    store.snapshot().notice?.text ?? '',
    /中身を受け付けませんでした.*向きは変えられません/u,
  );
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_view');
  fake.answer((request) =>
    okResponse(request, view([entry(0)], { list_seq: 3 })),
  );
  await settle();
  assert.equal(store.snapshot().editing, id(0));
  // 409（preview_stale）: 読み直して今の値を見せる。欄は残る。
  store.actions.editEntry(id(0), EDITED);
  fake.answer((request) => rejected(request, 'preview_stale'));
  await settle();
  assert.match(
    store.snapshot().notice?.text ?? '',
    /その後に変わっていました/u,
  );
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_view');
  fake.answer((request) =>
    okResponse(request, view([entry(0, { amount_yen: 999 })], { list_seq: 4 })),
  );
  await settle();
  assert.equal(store.snapshot().view?.entries[0]?.amount_yen, 999);
  // 結果不明: 読み直しで行が「結果を確認できない」になれば、欄をしまい、その行は操作させない。
  store.actions.editEntry(id(0), EDITED);
  fake.answer((request) => rejected(request, 'outcome_unknown'));
  await settle();
  assert.match(store.snapshot().notice?.text ?? '', /送り直しません/u);
  fake.answer((request) =>
    okResponse(
      request,
      view([entry(0, { delivery_unknown: true })], { list_seq: 5 }),
    ),
  );
  await settle();
  assert.equal(store.snapshot().editing, null);
  const sentBefore = fake.sent.length;
  store.actions.startEdit(id(0));
  store.actions.editEntry(id(0), EDITED);
  assert.equal(store.snapshot().editing, null);
  assert.equal(fake.sent.length, sentBefore);
});

test('cancelling closes the edit form, opening another action closes it, and a hide drops the form and the late answer', async () => {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => okResponse(request, view([entry(0), entry(1)])));
  await settle();
  store.actions.startEdit(id(0));
  store.actions.cancelEdit();
  assert.equal(store.snapshot().editing, null);
  store.actions.startEdit(id(0));
  store.actions.startDelete(id(0));
  assert.equal(store.snapshot().editing, null);
  assert.equal(store.snapshot().confirming, id(0));
  store.actions.cancelDelete();
  // 送っている間はしまえず、別の行の欄も開けない。
  store.actions.startEdit(id(0));
  store.actions.editEntry(id(0), EDITED);
  store.actions.cancelEdit();
  assert.equal(store.snapshot().editing, id(0));
  store.actions.startEdit(id(1));
  assert.equal(store.snapshot().editing, id(0));
  // ロック・切断をまたいだ遅い応答は反映しない。
  store.hide();
  fake.answer((request) =>
    okResponse(request, view([entry(0)], { list_seq: 9 })),
  );
  await settle();
  assert.deepEqual(store.snapshot(), INITIAL_HOUSEHOLD_STATE);
});
