// 家計簿の欄（HouseholdPanel。ADR 0162）の試験。サーバー描画（react-dom/server）で、頭の取得状態と最終取得、
// 月の合計と分類ごとの支出、記録の行（日付・店名・金額・支払い手段・出所）と分類の選択（向きが同じ分類だけ）、削除の
// 確かめ、月ごとの合計の一覧、未取得を「記録はありません」と言わないこと、内部の ID を出さないことを確かめる。
// 期待値は手で書く（基準の時刻は 2030-11-05T03:00:00Z）。実際の見た目・クリックは Electron の画面で確かめる（未実施）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopHouseholdEntry,
  DesktopHouseholdView,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  INITIAL_HOUSEHOLD_STATE,
  addFromConversationNote,
} from '../../state/household-state.js';
import type {
  HouseholdActions,
  HouseholdViewState,
} from '../../state/household-state.js';
import { HouseholdPanel } from './HouseholdPanel.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2030-11-05T03:00:00.000Z');

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

const totals = (month: string, expense = 0, income = 0) => ({
  month,
  expense_yen: expense,
  income_yen: income,
  balance_yen: income - expense,
  transfer_yen: 0,
  entry_count: 0,
  unreadable: 0,
});

const view = (
  entries: DesktopHouseholdEntry[],
  overrides: Partial<DesktopHouseholdView> = {},
): DesktopHouseholdView => ({
  fetch: 'loaded',
  fetched_at: '2030-11-05T02:55:00Z',
  current_month: '2030-11',
  months: [totals('2030-11', 1280, 200000), totals('2030-10', 5400)],
  month: '2030-11',
  entries,
  summary: {
    expense_yen: 1280,
    income_yen: 200000,
    balance_yen: 198720,
    entry_count: 2,
    expense_by_category: [{ category: 'food', total_yen: 1280, count: 1 }],
    transfer_yen: 0,
  },
  unreadable: 0,
  truncated: false,
  list_seq: 2,
  mail_intake: 'on',
  last_import: null,
  last_export: null,
  recurring: null,
  bills: null,
  budget: null,
  ...overrides,
});

const noop = () => undefined;
const ACTIONS: HouseholdActions = {
  refresh: noop,
  selectMonth: noop,
  changeCategory: noop,
  startDelete: noop,
  cancelDelete: noop,
  confirmDelete: noop,
  setIntake: noop,
  importExport: noop,
  exportCsv: noop,
  startBudget: noop,
  cancelBudget: noop,
  saveBudget: noop,
  startAdd: noop,
  startAddFrom: () => false,
  cancelAdd: noop,
  addEntry: noop,
  startEdit: noop,
  cancelEdit: noop,
  editEntry: noop,
};

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

const panel = (state: Partial<HouseholdViewState>) =>
  render(
    <HouseholdPanel
      state={{ ...INITIAL_HOUSEHOLD_STATE, ...state }}
      actions={ACTIONS}
      now={NOW}
    />,
  );

const text = (html: string) => html.replace(/<[^>]+>/gu, ' ');
// 空白（改行しない空白を含む）は 1 つの空白にそろえる。
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gu)].map((match) =>
    text(match[1] ?? '')
      .replace(/\s+/gu, ' ')
      .trim(),
  );
const options = (html: string) =>
  [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/gu)].map(
    (match) => match[1],
  );

test('nothing read yet says so and never says there are no entries', () => {
  const html = text(panel({}));
  assert.match(html, /家計簿/u);
  assert.match(html, /まだ取得できていません/u);
  assert.doesNotMatch(html, /記録はありません/u);
  assert.doesNotMatch(html, /最終取得/u);
  assert.doesNotMatch(html, /支出/u);
});

test('the month shows its totals, the spending by category and the rows', () => {
  const html = panel({
    view: view([
      entry(0),
      entry(1, {
        source_kind: 'csv_import',
        direction: 'income',
        amount_yen: 200000,
        occurred_on: '2030-11-01',
        occurred_time: null,
        category: 'income',
        merchant: null,
        memo: '合成の給与',
        payment: null,
      }),
    ]),
    seq: 2,
  });
  const plain = text(html);
  assert.match(plain, /取得できています/u);
  assert.match(plain, /最終取得 5\u00a0分前/u);
  assert.match(plain, /2030\u00a0年\u00a011\u00a0月（今月）/u);
  assert.match(plain, /支出 +1,280\u00a0円/u);
  assert.match(plain, /収支 +198,720\u00a0円/u);
  assert.match(plain, /食費 +1,280\u00a0円/u);
  assert.match(
    plain,
    /11\u00a0月\u00a03\u00a0日 12:34 +合成の食堂 +1,280\u00a0円/u,
  );
  assert.match(plain, /合成のカード ・ 利用通知メール/u);
  assert.match(plain, /合成の給与 +収入 200,000\u00a0円/u);
  // 支出の行は支出の分類だけ、収入の行は収入だけを選べる（選べるのが 1 つなら選択を止める）。
  const all = options(html);
  assert.equal(all.filter((label) => label === '食費').length, 1);
  assert.equal(all.filter((label) => label === '収入').length, 1);
  // 支出の行の分類 18 と収入の行の分類 1 に、書き出しの期間の選択肢 4 つ（ADR 0172）を足した数。
  assert.equal(all.length, 18 + 1 + 4);
  assert.match(html, /<select[^>]*disabled=""[^>]*>[^]*?<option[^>]*>収入/u);
  // 削除のボタンが行ごとにある。月の一覧に今月と 10 月がある。
  assert.equal(buttons(html).filter((label) => label === '削除する').length, 2);
  assert(buttons(html).includes('2030 年 10 月'));
  assert(buttons(html).includes('2030 年 11 月（今月）'));
  // 内部の参照・ID は文字として出さない。
  assert.doesNotMatch(plain, /00000000-0000-4000/u);
});

test('an empty month says there are no entries only after it was read', () => {
  const html = text(
    panel({
      view: view([], {
        month: '2030-10',
        summary: {
          expense_yen: 0,
          income_yen: 0,
          balance_yen: 0,
          entry_count: 0,
          expense_by_category: [],
          transfer_yen: 0,
        },
      }),
      seq: 2,
    }),
  );
  assert.match(html, /この月の記録はありません。/u);
  assert.match(html, /2030\u00a0年\u00a010\u00a0月/u);
  assert.doesNotMatch(html, /分類ごとの支出/u);
});

test('the deletion asks once in the screen; an unknown result disables the row', () => {
  const asking = panel({ view: view([entry(0)]), seq: 2, confirming: id(0) });
  assert.match(text(asking), /この記録を削除しますか。/u);
  assert.deepEqual(
    buttons(asking).filter(
      (label) => label === 'やめる' || label === '削除する',
    ),
    ['やめる', '削除する'],
  );
  const unknown = text(
    panel({ view: view([entry(0, { delivery_unknown: true })]), seq: 2 }),
  );
  assert.match(unknown, /変更の結果を確認できませんでした/u);
  assert.doesNotMatch(unknown, /削除する/u);
});

test('a stale read, unreadable records and truncation are said', () => {
  const html = text(
    panel({
      view: view([entry(0)], {
        fetch: 'stale',
        unreadable: 2,
        truncated: true,
      }),
      seq: 2,
    }),
  );
  assert.match(html, /最新の取得に失敗しました/u);
  assert.match(html, /読めない記録が\u00a02\u00a0件あります/u);
  assert.match(html, /一部の記録を読み込めていません/u);
});

test('the intake line says whether card notices are read and offers to stop or resume', () => {
  const on = panel({ view: view([entry(0)]), seq: 2 });
  assert.match(text(on), /カードの利用通知メールを取り込んでいます。/u);
  assert(buttons(on).includes('取り込みを止める'));
  assert.doesNotMatch(text(on), /止めていた間に届いた通知は読みません/u);
  const off = panel({ view: view([entry(0)], { mail_intake: 'off' }), seq: 2 });
  assert.match(text(off), /取り込みを止めています。/u);
  assert(buttons(off).includes('取り込みを再開する'));
  assert.match(text(off), /止めていた間に届いた通知は読みません/u);
  // 読めていなければ入・切を出さない。
  const unknown = text(
    panel({ view: view([entry(0)], { mail_intake: null }), seq: 2 }),
  );
  assert.doesNotMatch(unknown, /取り込んでいます|止めています/u);
});

test('the import block offers to pick a file and shows the last result', () => {
  const none = panel({ view: view([entry(0)]), seq: 2 });
  assert(buttons(none).includes('ファイルを選んで取り込む'));
  assert.match(text(none), /入出金履歴の CSV を取り込みます/u);
  const done = text(
    panel({
      view: view([entry(0)], {
        last_import: {
          outcome: 'done',
          created: 3,
          duplicate: 0,
          matched: 1,
          rejected: 0,
          skipped: 0,
          rules_learned: 0,
        },
      }),
      seq: 2,
    }),
  );
  assert.match(done, /取り込みました（新しく記録\u00a03\u00a0件/u);
  // 読めていなければ取り込みの欄を出さない。
  assert.doesNotMatch(text(panel({})), /ファイルを選んで取り込む/u);
});

test('the export block warns that the file is plain text, offers the periods, and shows the last result', () => {
  const none = panel({ view: view([entry(0)]), seq: 2 });
  assert(buttons(none).includes('保存先を選んで書き出す'));
  assert.match(text(none), /金額・店名・メモがそのまま（暗号化せず）入ります/u);
  for (const label of [
    '今出している月だけ',
    '直近 12\u00a0か月',
    '直近 36\u00a0か月',
    '直近 10\u00a0年（120\u00a0か月）',
  ])
    assert.match(text(none), new RegExp(label, 'u'));
  const saved = text(
    panel({
      view: view([entry(0)], {
        last_export: {
          outcome: 'saved',
          months: 12,
          entries: 40,
          truncated_months: 0,
          unreadable: 0,
        },
      }),
      seq: 2,
    }),
  );
  assert.match(
    saved,
    /書き出しました（12\u00a0か月分、記録\u00a040\u00a0件）/u,
  );
  const incomplete = text(
    panel({
      view: view([entry(0)], {
        last_export: {
          outcome: 'incomplete',
          months: 3,
          entries: 9,
          truncated_months: 1,
          unreadable: 0,
        },
      }),
      seq: 2,
    }),
  );
  assert.match(incomplete, /欠けたファイルになるので書き出しませんでした/u);
  // 書き出し中は表示が変わり、読めていなければ欄を出さない。
  const busy = panel({ view: view([entry(0)]), seq: 2, busy: 'export' });
  assert.match(busy, /書き出しています…/u);
  assert.doesNotMatch(text(panel({})), /保存先を選んで書き出す/u);
});

test('the recurring block lists fixed costs with the monthly estimate, and says when there are none', () => {
  const html = text(
    panel({
      view: view([entry(0)], {
        recurring: {
          items: [
            {
              merchant: '合成モバイル',
              category: 'communication',
              typical_yen: 3000,
              months_seen: 4,
              last_on: '2030-11-03',
            },
          ],
          monthly_total_yen: 3000,
        },
      }),
      seq: 2,
    }),
  );
  assert.match(html, /定期の支出（固定費の目安）/u);
  assert.match(html, /月の固定費の目安 +3,000\u00a0円/u);
  assert.match(html, /合成モバイル（通信費）/u);
  assert.match(html, /12\u00a0か月中\u00a04\u00a0か月/u);
  const none = text(
    panel({
      view: view([entry(0)], {
        recurring: { items: [], monthly_total_yen: 0 },
      }),
      seq: 2,
    }),
  );
  assert.match(none, /まだ定期の支出は見つかっていません。/u);
  // 読めていなければ出さない。
  assert.doesNotMatch(
    text(panel({ view: view([entry(0)]), seq: 2 })),
    /定期の支出/u,
  );
});

test('the bills block shows the month bills by company, amount and debit day apart from the spending total (ADR 0176)', () => {
  const html = text(
    panel({
      view: view([entry(0)], {
        bills: {
          items: [
            { issuer: '合成カードA', amount_yen: 12345, due_on: '2030-11-10' },
            { issuer: '合成カードB', amount_yen: 3000, due_on: '2030-11-27' },
          ],
          total_yen: 15345,
          unreadable: 1,
          truncated: true,
        },
      }),
      seq: 2,
    }),
  );
  assert.match(html, /請求予定/u);
  assert.match(html, /支出の合計・予算・定期の支出には入れていません/u);
  assert.match(html, /請求予定の合計 +15,345\u00a0円/u);
  assert.match(
    html,
    /合成カードA *12,345\u00a0円 ・ 引き落とし\u00a011\u00a0月\u00a010\u00a0日/u,
  );
  assert.match(
    html,
    /合成カードB *3,000\u00a0円 ・ 引き落とし\u00a011\u00a0月\u00a027\u00a0日/u,
  );
  assert.match(html, /読めない請求予定が\u00a01\u00a0件あります/u);
  assert.match(html, /請求予定が多いため、一部だけを出しています。/u);
  // 支出の合計は記録の値のまま（請求予定を足さない）。
  assert.doesNotMatch(html, /16,625/u);
  const none = text(
    panel({
      view: view([entry(0)], {
        bills: { items: [], total_yen: 0, unreadable: 0, truncated: false },
      }),
      seq: 2,
    }),
  );
  assert.match(none, /この月に引き落とされる請求予定はありません。/u);
  assert.doesNotMatch(none, /請求予定の合計/u);
  // 読めていなければ出さない。
  assert.doesNotMatch(
    text(panel({ view: view([entry(0)]), seq: 2 })),
    /請求予定/u,
  );
});

test('the budget block compares the month spending with the budget, and the editor lists the expense categories', () => {
  const html = text(
    panel({
      view: view([entry(0)], {
        budget: {
          items: [
            { category: 'food', budget_yen: 1000 },
            { category: 'utilities', budget_yen: 12000 },
          ],
          total_budget_yen: 13000,
        },
      }),
      seq: 2,
    }),
  );
  assert.match(html, /予算の合計 +13,000\u00a0円/u);
  assert.match(
    html,
    /食費 +1,280\u00a0円 \/ 1,000\u00a0円（280\u00a0円の超過）/u,
  );
  assert.match(
    html,
    /水道・光熱費 +0\u00a0円 \/ 12,000\u00a0円（残り 12,000\u00a0円）/u,
  );
  const empty = panel({
    view: view([entry(0)], { budget: { items: [], total_budget_yen: 0 } }),
    seq: 2,
  });
  assert.match(text(empty), /まだ予算を決めていません。/u);
  assert(buttons(empty).includes('予算を決める'));
  const editing = panel({
    view: view([entry(0)], {
      budget: {
        items: [{ category: 'food', budget_yen: 1000 }],
        total_budget_yen: 1000,
      },
    }),
    seq: 2,
    editingBudget: true,
  });
  assert.equal((editing.match(/<input /gu) ?? []).length, 18);
  assert.match(editing, /id="household-budget-food"[^>]*value="1000"/u);
  assert(buttons(editing).includes('予算を保存する'));
  // 読めていなければ出さない。
  assert.doesNotMatch(text(panel({ view: view([entry(0)]), seq: 2 })), /予算/u);
});

test('the add block offers to add a record and the form lists the fields', () => {
  const closed = panel({ view: view([entry(0)]), seq: 2 });
  assert(buttons(closed).includes('記録を手で足す'));
  const open = panel({ view: view([entry(0)]), seq: 2, adding: true });
  for (const id of ['amount', 'date', 'time', 'merchant', 'memo', 'payment'])
    assert.match(open, new RegExp(`id="household-add-${id}"`, 'u'));
  assert.match(open, /id="household-add-direction"/u);
  assert(buttons(open).includes('足す'));
  assert.match(text(open), /カード番号・口座番号は入れないでください/u);
});

test('the add form opened from a conversation candidate holds its values and says nothing is recorded yet', () => {
  const html = panel({
    view: view([entry(0)]),
    seq: 2,
    adding: true,
    addPrefill: {
      direction: 'expense',
      amount: '500',
      date: '2030-11-26',
      time: '',
      category: 'uncategorized',
      merchant: 'コンビニ',
      memo: '',
      payment: '現金',
    },
  });
  assert.match(html, /id="household-add-amount"[^>]*value="500"/u);
  assert.match(html, /id="household-add-date"[^>]*value="2030-11-26"/u);
  assert.match(html, /id="household-add-merchant"[^>]*value="コンビニ"/u);
  assert.match(html, /id="household-add-payment"[^>]*value="現金"/u);
  assert.match(
    text(html),
    /会話の一言から読んだ値を入れました。まだ記録していません。/u,
  );
  assert.doesNotMatch(text(html), /カード番号・口座番号は入れないでください/u);
  assert(buttons(html).includes('足す'));
});

test('the add form opened from an income candidate is set to income with the income category and the source in the memo', () => {
  const html = panel({
    view: view([entry(0)]),
    seq: 2,
    adding: true,
    addPrefill: {
      direction: 'income',
      amount: '250000',
      date: '2030-11-25',
      time: '',
      category: 'income',
      merchant: '',
      memo: '給料',
      payment: '',
    },
  });
  assert.match(
    html,
    /<select id="household-add-direction"[^>]*>[^]*?<option value="income" selected="">収入<\/option>/u,
  );
  // 収入の分類は「収入」だけなので、分類の選択は押せない。
  assert.match(
    html,
    /<select id="household-add-category"[^>]*disabled=""[^>]*><option value="income" selected="">収入<\/option><\/select>/u,
  );
  assert.match(html, /id="household-add-amount"[^>]*value="250000"/u);
  assert.match(html, /id="household-add-date"[^>]*value="2030-11-25"/u);
  assert.match(html, /id="household-add-memo"[^>]*value="給料"/u);
  assert.match(html, /id="household-add-merchant"[^>]*value=""/u);
  assert.match(
    text(html),
    /会話の一言から読んだ値を、収入として入れました。まだ記録していません。/u,
  );
  assert.doesNotMatch(text(html), /分類を選んでから/u);
});

test('the note of the form opened from a conversation candidate follows the current direction, not the candidate', () => {
  // 欄の頭の説明は今の入力の向きから選ぶ。収入の候補で開いた後に向きを支出へ変えたら、支出の説明になる
  // （向きを変える操作そのものは HouseholdPanel.dom.test.tsx で確かめる）。
  assert.equal(
    addFromConversationNote('income'),
    '会話の一言から読んだ値を、収入として入れました。まだ記録していません。向き・金額・日付・メモを確かめてから「足す」を押してください。',
  );
  assert.equal(
    addFromConversationNote('expense'),
    '会話の一言から読んだ値を入れました。まだ記録していません。金額・日付・店名を確かめ、分類を選んでから「足す」を押してください。',
  );
  assert.equal(
    addFromConversationNote('transfer'),
    '会話の一言から読んだ値を入れました。まだ記録していません。向きは振替です。金額・日付を確かめてから「足す」を押してください。',
  );
  // 候補の向きが支出でも、入力の向きが振替なら振替の説明を出す（候補の向きでは選ばない）。
  const html = panel({
    view: view([entry(0)]),
    seq: 2,
    adding: true,
    addPrefill: {
      direction: 'transfer',
      amount: '30000',
      date: '2030-11-26',
      time: '',
      category: 'transfer',
      merchant: '',
      memo: '',
      payment: '',
    },
  });
  assert.match(text(html), /向きは振替です。/u);
  assert.doesNotMatch(text(html), /収入として入れました/u);
  assert.doesNotMatch(text(html), /分類を選んでから/u);
});

test('rows that look like the same purchase from two sources are marked, and the list says so', () => {
  const html = text(
    panel({
      view: view([
        entry(0),
        entry(1, { source_kind: 'manual', merchant: '合成の食堂（手入力）' }),
        entry(2, { amount_yen: 999 }),
      ]),
      seq: 2,
    }),
  );
  assert.match(html, /同じ日・同じ金額の記録が別の出所からも入っています/u);
  assert.equal((html.match(/重なっているかもしれません/gu) ?? []).length, 2);
  const single = text(
    panel({ view: view([entry(0), entry(2, { amount_yen: 999 })]), seq: 2 }),
  );
  assert.doesNotMatch(single, /重なっているかもしれません/u);
});

test('each row offers to edit its content; the edit form is opened in the row with the current values and a fixed direction', () => {
  const closed = panel({ view: view([entry(0)]), seq: 2 });
  assert(buttons(closed).includes('中身を直す'));
  assert.doesNotMatch(closed, /household-edit-/u);
  const open = panel({ view: view([entry(0)]), seq: 2, editing: id(0) });
  const prefix = `household-edit-${id(0)}`;
  for (const name of ['amount', 'date', 'time', 'merchant', 'memo', 'payment'])
    assert.match(open, new RegExp(`id="${prefix}-${name}"`, 'u'));
  // 今の値が入っている。
  assert.match(open, new RegExp(`id="${prefix}-amount"[^>]*value="1280"`, 'u'));
  assert.match(
    open,
    new RegExp(`id="${prefix}-date"[^>]*value="2030-11-03"`, 'u'),
  );
  assert.match(open, new RegExp(`id="${prefix}-time"[^>]*value="12:34"`, 'u'));
  assert.match(
    open,
    new RegExp(`id="${prefix}-merchant"[^>]*value="合成の食堂"`, 'u'),
  );
  // 向きは変えられない。
  assert.match(
    open,
    new RegExp(`<select id="${prefix}-direction"[^>]*disabled`, 'u'),
  );
  assert.match(text(open), /向きは変えられません/u);
  assert(buttons(open).includes('直す'));
  assert(buttons(open).includes('やめる'));
  // 手入力の欄とは別の id（重ならない）。
  assert.doesNotMatch(open, /id="household-add-amount"/u);
});

test('the edit form shows the sending state, and a row whose result is unknown offers no edit', () => {
  const sending = panel({
    view: view([entry(0)]),
    seq: 2,
    editing: id(0),
    busy: id(0),
  });
  assert(buttons(sending).includes('直しています…'));
  const unknown = panel({
    view: view([entry(0, { delivery_unknown: true })]),
    seq: 2,
  });
  assert(!buttons(unknown).includes('中身を直す'));
  // 送っている間は、ほかの行の「中身を直す」を押せない。
  const other = panel({
    view: view([entry(0), entry(1, { amount_yen: 300 })]),
    seq: 2,
    busy: id(0),
  });
  assert.equal(
    (other.match(/<button[^>]*disabled[^>]*>\s*中身を直す/gu) ?? []).length +
      (other.match(/<button[^>]*isDisabled[^>]*>\s*中身を直す/gu) ?? []).length,
    2,
  );
});
