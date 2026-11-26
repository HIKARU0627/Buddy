// 家計簿の欄の手入力の入力欄（ADR 0167・0171・0174）の操作の試験。会話の一言の収入の候補で開いた欄で、本人が向きを支出へ
// 変えたら、欄の頭の説明も支出の説明（分類を選ぶ）に変わることを、happy-dom の文書に React で描いて確かめる。
// 期待値は手で書いた。Electron の実際の画面での見た目・操作は未実施。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopHouseholdView } from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import { INITIAL_HOUSEHOLD_STATE } from '../../state/household-state.js';
import type { HouseholdActions } from '../../state/household-state.js';
import { HouseholdPanel } from './HouseholdPanel.js';

after(async () => {
  await happy.happyDOM.close();
});

const VIEW: DesktopHouseholdView = {
  fetch: 'loaded',
  fetched_at: '2030-11-26T02:55:00Z',
  current_month: '2030-11',
  months: [
    {
      month: '2030-11',
      expense_yen: 0,
      income_yen: 0,
      balance_yen: 0,
      transfer_yen: 0,
      entry_count: 0,
      unreadable: 0,
    },
  ],
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
  list_seq: 1,
  mail_intake: 'on',
  last_import: null,
  last_export: null,
  recurring: null,
  bills: null,
  budget: null,
};

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

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    happy.HTMLSelectElement.prototype,
    'value',
  )?.set;
  setter?.call(select, value);
  select.dispatchEvent(
    new happy.Event('change', { bubbles: true }) as unknown as Event,
  );
}

test('changing the direction of the form opened from an income candidate changes its note to the expense note', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProviders>
        <HouseholdPanel
          state={{
            ...INITIAL_HOUSEHOLD_STATE,
            view: VIEW,
            seq: 1,
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
          }}
          actions={ACTIONS}
          now={Date.parse('2030-11-26T03:00:00.000Z')}
        />
      </AppProviders>,
    );
  });
  const form = container.querySelector(
    '[role="group"][aria-label="記録を足す"]',
  );
  assert(form !== null);
  assert.match(
    form.textContent,
    /会話の一言から読んだ値を、収入として入れました。/u,
  );
  const direction = container.querySelector<HTMLSelectElement>(
    '#household-add-direction',
  );
  assert(direction !== null);
  await act(async () => {
    choose(direction, 'expense');
  });
  assert.equal(direction.value, 'expense');
  assert.match(
    form.textContent,
    /会話の一言から読んだ値を入れました。まだ記録していません。金額・日付・店名を確かめ、分類を選んでから「足す」を押してください。/u,
  );
  assert.doesNotMatch(form.textContent, /収入として入れました/u);
  // 収入に戻すと、収入の説明に戻る。
  await act(async () => {
    choose(direction, 'income');
  });
  assert.match(
    form.textContent,
    /会話の一言から読んだ値を、収入として入れました。/u,
  );
  await act(async () => root.unmount());
  container.remove();
});
