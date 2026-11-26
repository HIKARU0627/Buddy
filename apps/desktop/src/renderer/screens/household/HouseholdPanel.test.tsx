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
import { INITIAL_HOUSEHOLD_STATE } from '../../state/household-state.js';
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
  recurring: null,
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
  assert.equal(all.length, 19);
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
