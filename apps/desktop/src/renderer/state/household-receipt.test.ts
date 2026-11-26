// レシートの写真からの家計の記録の候補（ADR 0177）の画面の状態の試験。期待値は手で書く。
// 確かめること: 設定が切・読み取りの口がないときは送らない、写真は main が選ばせるので画面からはチャネルだけを送る、
// 候補は画面のメモリーにだけ置き、入力欄で開いても記録は作らない（「足す」を押したときだけ desktop.household_add）、
// 閉じる・ロックで捨てる、結果不明は送り直さない、本人が入れている途中の欄を候補で書き換えない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DesktopHouseholdReceiptView,
  DesktopHouseholdView,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import {
  inputFromReceipt,
  receiptCandidateText,
  receiptMessage,
  receiptStateText,
} from './household-receipt.js';
import { HouseholdStore, manualEntryFromInput } from './household-state.js';

const view = (
  overrides: Partial<DesktopHouseholdView> = {},
): DesktopHouseholdView => ({
  fetch: 'loaded',
  fetched_at: '2030-11-05T03:00:00Z',
  current_month: '2030-11',
  months: [],
  month: '2030-11',
  entries: [],
  summary: null,
  unreadable: 0,
  truncated: false,
  list_seq: 2,
  mail_intake: 'on',
  receipt_reading: 'on',
  last_import: null,
  last_export: null,
  recurring: null,
  bills: null,
  budget: null,
  ...overrides,
});

const CANDIDATE = {
  amount_yen: 1280,
  occurred_on: '2030-11-04',
  occurred_time: '12:34',
  merchant: '合成の商店',
  payment: '現金',
};

const okView = (
  request: DesktopIpcRequest,
  household: DesktopHouseholdView,
): DesktopIpcResponse =>
  ({
    request_id: request.request_id,
    channel: request.channel,
    outcome: 'ok',
    household,
  }) as DesktopIpcResponse;

const okReceipt = (
  request: DesktopIpcRequest,
  receipt: DesktopHouseholdReceiptView,
): DesktopIpcResponse =>
  ({
    request_id: request.request_id,
    channel: request.channel,
    outcome: 'ok',
    receipt,
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

async function loaded(overrides: Partial<DesktopHouseholdView> = {}) {
  const fake = fakeApi();
  const store = new HouseholdStore(fake.api);
  store.actions.refresh();
  fake.answer((request) => okView(request, view(overrides)));
  await settle();
  return { fake, store };
}

test('the candidate text and the input use no-break spaces and stay an uncategorized expense', () => {
  assert.equal(
    receiptCandidateText(CANDIDATE),
    '支出 1,280\u00a0円・合成の商店・現金・11\u00a0月\u00a04\u00a0日',
  );
  assert.equal(
    receiptCandidateText({
      ...CANDIDATE,
      occurred_on: null,
      merchant: null,
      payment: null,
    }),
    '支出 1,280\u00a0円・日付は入力欄で入れてください',
  );
  assert.deepEqual(inputFromReceipt(CANDIDATE), {
    direction: 'expense',
    amount: '1280',
    date: '2030-11-04',
    time: '12:34',
    category: 'uncategorized',
    merchant: '合成の商店',
    memo: '',
    payment: '現金',
  });
  // 日付がなければ、本人が入れるまで送れない。
  assert.equal(
    manualEntryFromInput(inputFromReceipt({ ...CANDIDATE, occurred_on: null })),
    null,
  );
  assert.equal(
    receiptStateText('unavailable'),
    'この中枢には写真の読み取りの口がないため、レシートの写真からは読めません。',
  );
});

test('messages say why nothing was sent or why it is not a candidate', () => {
  const message = (
    outcome: DesktopHouseholdReceiptView['outcome'],
    reasons: DesktopHouseholdReceiptView['reasons'] = [],
  ) => receiptMessage({ outcome, candidate: null, reasons });
  assert.equal(message('candidate'), null);
  assert.equal(message('cancelled'), null);
  assert.equal(
    message('setting_off'),
    'レシートの写真を外部へ送る設定が切になっていたため、送っていません。',
  );
  assert.match(message('budget_held') ?? '', /予算を予約できなかった/u);
  assert.equal(
    message('image_rejected', ['image_too_large']),
    '写真が大きすぎるため、送っていません（20\u00a0MB まで。縮めても 180\u00a0KB に収まらない写真は送りません）。',
  );
  assert.match(
    message('not_candidate', ['items_total_mismatch']) ?? '',
    /品目の金額の和が合計と合わなかった/u,
  );
  assert.match(
    message('not_candidate', ['long_digits']) ?? '',
    /カード番号や口座番号のような長い数字/u,
  );
  assert.match(
    message('not_candidate', ['currency_not_yen']) ?? '',
    /円の金額と確かめられませんでした/u,
  );
});

test('the setting is sent only as the other value, and never while unavailable', async () => {
  const unavailable = await loaded({ receipt_reading: 'unavailable' });
  unavailable.store.actions.setReceiptReading('on');
  assert.equal(unavailable.fake.sent.length, 1);
  const { fake, store } = await loaded({ receipt_reading: 'off' });
  store.actions.setReceiptReading('off');
  assert.equal(fake.sent.length, 1);
  store.actions.setReceiptReading('on');
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_receipt_setting');
  assert.deepEqual(fake.sent.at(-1)?.payload, { receipt_reading: 'on' });
  // 本人が OS の確かめで「やめる」を選んだ。
  fake.answer((request) => rejected(request, 'confirmation_declined'));
  await settle();
  assert.equal(
    store.snapshot().notice?.text,
    '送る設定にしませんでした。写真は外部へ送りません。',
  );
  assert.equal(store.snapshot().notice?.place, 'receipt_setting');
  assert.equal(store.snapshot().view?.receipt_reading, 'off');
});

test('nothing is read while the setting is off', async () => {
  const { fake, store } = await loaded({ receipt_reading: 'off' });
  store.actions.readReceipt();
  assert.equal(fake.sent.length, 1);
  assert.equal(store.snapshot().busy, null);
});

test('a candidate stays on the screen only, and opening it fills the form without recording', async () => {
  const { fake, store } = await loaded();
  store.actions.readReceipt();
  const read = fake.sent.at(-1);
  // 写真のファイルも中身も画面からは送らない（main が選ばせる）。
  assert.equal(read?.channel, 'desktop.household_receipt_read');
  assert.equal(read?.payload, null);
  assert.equal(store.snapshot().busy, 'receipt');
  // 読み取り中の二度押しは送らない。
  store.actions.readReceipt();
  assert.equal(fake.sent.length, 2);
  fake.answer((request) =>
    okReceipt(request, {
      outcome: 'candidate',
      candidate: CANDIDATE,
      reasons: [],
    }),
  );
  await settle();
  assert.deepEqual(store.snapshot().receipt, {
    outcome: 'candidate',
    candidate: CANDIDATE,
    reasons: [],
  });
  assert.equal(store.snapshot().busy, null);
  // 入力欄で開く: 値を入れて開くだけで、何も送らない。
  assert.equal(store.actions.openReceipt(inputFromReceipt(CANDIDATE)), true);
  assert.equal(fake.sent.length, 2);
  const opened = store.snapshot();
  assert.equal(opened.adding, true);
  assert.equal(opened.addFromReceipt, true);
  assert.equal(opened.receipt, null);
  assert.deepEqual(opened.addPrefill, inputFromReceipt(CANDIDATE));
  // 同じ候補から二度は開かない。
  assert.equal(store.actions.openReceipt(inputFromReceipt(CANDIDATE)), false);
  // 本人が「足す」を押したときだけ、手入力と同じ経路で 1 回送る。
  const entry = manualEntryFromInput(inputFromReceipt(CANDIDATE));
  assert.notEqual(entry, null);
  if (entry !== null) store.actions.addEntry(entry);
  assert.equal(fake.sent.length, 3);
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_add');
  assert.deepEqual(fake.sent.at(-1)?.payload, {
    entry: {
      direction: 'expense',
      amount_yen: 1280,
      occurred_on: '2030-11-04',
      occurred_time: '12:34',
      category: 'uncategorized',
      merchant: '合成の商店',
      memo: null,
      payment: '現金',
    },
  });
});

test('closing a candidate or locking sends nothing and forgets it', async () => {
  const { fake, store } = await loaded();
  const readOnce = async () => {
    store.actions.readReceipt();
    fake.answer((request) =>
      okReceipt(request, {
        outcome: 'candidate',
        candidate: CANDIDATE,
        reasons: [],
      }),
    );
    await settle();
  };
  await readOnce();
  const sent = fake.sent.length;
  store.actions.dismissReceipt();
  assert.equal(store.snapshot().receipt, null);
  assert.equal(fake.sent.length, sent);
  // 開いた欄を確定せずに閉じても送らない。
  await readOnce();
  assert.equal(store.actions.openReceipt(inputFromReceipt(CANDIDATE)), true);
  store.actions.cancelAdd();
  assert.equal(store.snapshot().adding, false);
  assert.equal(store.snapshot().addFromReceipt, false);
  assert.equal(
    fake.sent.some((request) => request.channel === 'desktop.household_add'),
    false,
  );
  // ロック・切断で捨てる。
  await readOnce();
  store.hide();
  assert.equal(store.snapshot().receipt, null);
  assert.equal(store.snapshot().view, null);
});

test('a candidate does not overwrite a form the owner is filling in', async () => {
  const { fake, store } = await loaded();
  store.actions.startAdd();
  store.actions.readReceipt();
  fake.answer((request) =>
    okReceipt(request, {
      outcome: 'candidate',
      candidate: CANDIDATE,
      reasons: [],
    }),
  );
  await settle();
  assert.equal(store.actions.openReceipt(inputFromReceipt(CANDIDATE)), false);
  assert.equal(store.snapshot().addPrefill, null);
  assert.equal(store.snapshot().addFromReceipt, false);
  assert.notEqual(store.snapshot().receipt, null);
});

test('an unknown outcome is not resent, and a picker closed without a file shows nothing', async () => {
  const { fake, store } = await loaded();
  store.actions.readReceipt();
  fake.answer((request) => rejected(request, 'outcome_unknown'));
  await settle();
  assert.equal(
    store.snapshot().notice?.text,
    '読み取りの結果を確かめられませんでした。自動では送り直しません。読み直すときは、もう一度写真を選んでください。',
  );
  assert.equal(store.snapshot().notice?.place, 'receipt');
  assert.equal(fake.sent.length, 2);
  store.actions.readReceipt();
  fake.answer((request) =>
    okReceipt(request, { outcome: 'cancelled', candidate: null, reasons: [] }),
  );
  await settle();
  assert.equal(store.snapshot().receipt, null);
  assert.equal(fake.sent.length, 3);
  // 中枢の設定が切だった: 理由を出し、今の設定を読み直す。
  store.actions.readReceipt();
  fake.answer((request) =>
    okReceipt(request, {
      outcome: 'setting_off',
      candidate: null,
      reasons: [],
    }),
  );
  await settle();
  assert.equal(store.snapshot().receipt?.outcome, 'setting_off');
  assert.equal(fake.sent.at(-1)?.channel, 'desktop.household_view');
  fake.answer((request) =>
    okView(request, view({ receipt_reading: 'off', list_seq: 3 })),
  );
  await settle();
  assert.equal(store.snapshot().view?.receipt_reading, 'off');
});
