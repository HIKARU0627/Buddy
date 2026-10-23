// 予算の確認の一覧（BudgetItems。B07-05、ADR 0038）の試験。サーバー描画（react-dom/server）で、見出し・金額・枠・帯・ボタン・
// 入力欄・結果不明・期限切れ・停止中の出し分けと、説明の文章・理由のコード・API の名前を出さないことを確かめる。期待値は手で書く。
// 実際の見た目・クリック・OS の確認ダイアログは Electron の画面で確かめる（docs/ui/status-layer.md）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesktopBudgetEntry } from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  INITIAL_BUDGET_STATE,
  markChecked,
  markBusy,
  setManualInput,
} from '../../state/budget-state.js';
import type {
  BudgetActions,
  BudgetViewState,
} from '../../state/budget-state.js';
import { BudgetItems, barStep, itemLabel } from './BudgetItems.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const xts = (amount: string) => ({ currency: 'XTS', amount });
const NOW = Date.parse('2030-10-15T00:00:00.000Z');

const approval = (
  overrides: Partial<DesktopBudgetEntry> = {},
): DesktopBudgetEntry => ({
  ref: id(1),
  kind: 'overage_approval',
  pool_id: 'llm',
  budget_month: '2030-10',
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
  max_liability: xts('40000000'),
  overage_remaining: null,
  actual_gross: null,
  expires_at: null,
  delivery_unknown: false,
  ...overrides,
});

const noop = () => undefined;
const actions: BudgetActions = {
  decide: noop,
  review: noop,
  settle: noop,
  setReconciliationId: noop,
  setAmount: noop,
};

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

function list(
  items: readonly DesktopBudgetEntry[],
  options: { state?: BudgetViewState; stopped?: boolean; now?: number } = {},
) {
  return render(
    <BudgetItems
      items={items}
      state={options.state ?? INITIAL_BUDGET_STATE}
      actions={actions}
      stopped={options.stopped ?? false}
      now={options.now ?? NOW}
    />,
  );
}

const buttonTexts = (html: string) =>
  (html.match(/<button[\s\S]*?<\/button>/gu) ?? []).map((button) =>
    button
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  );

// 読める文字（タグを除いた本文と、読み上げの名前になる属性）。
const readable = (html: string): string[] => [
  ...html
    .replace(/<[^>]+>/gu, '\n')
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text.length > 0),
  ...[...html.matchAll(/aria-label="([^"]*)"/gu)].map((match) =>
    (match[1] as string).trim(),
  ),
];

test('nothing is drawn when there are no items (no empty heading)', () => {
  assert.equal(list([]), '');
});

test('the approval row puts the request M beside the remaining overage, with a bar of the share, and two buttons', () => {
  const html = list([approval()]);
  const text = readable(html);
  for (const expected of [
    '予算の確認',
    '超過枠の承認',
    'llm',
    '2030-10',
    '最大負担',
    'XTS 40.00',
    '超過枠の残り',
    'XTS 60.00',
  ])
    assert(text.includes(expected), expected);
  // 期限は時刻で（端末の時刻の書き方。まで）。
  assert(text.some((item) => /\d{1,2}:\d{2}\u00a0まで$/u.test(item)));
  // 帯: 最大負担が残りの 67%（5% きざみで 65）。読み上げの名前に両方の金額。
  assert.match(html, /role="img"/u);
  assert.match(html, /data-bar-base="65"/u);
  assert.match(html, /data-bar-overflow="0"/u);
  assert.match(html, /w-\[65%\]/u);
  assert(text.includes('最大負担 XTS 40.00 / 超過枠の残り XTS 60.00'));
  // ボタンは見送る（secondary）と承認する（primary）。読み上げの名前に枠と金額を足す。
  assert.deepEqual(buttonTexts(html), ['見送る', '承認する']);
  assert(text.includes('承認する（llm・XTS 40.00）'));
  assert(text.includes('見送る（llm・XTS 40.00）'));
});

test('the overrun row shows the actual cost, M and the part over M in the danger color with a plus sign, and one button', () => {
  const html = list([overrun()]);
  const text = readable(html);
  for (const expected of [
    'M 超過',
    'llm.background',
    '最大負担',
    'XTS 40.00',
    '実費',
    'XTS 55.00',
    '超過',
    '+XTS 15.00',
  ])
    assert(text.includes(expected), expected);
  // M までが 73%（75）、超えた分が 27%（25）。超えた分は別の色の帯。
  assert.match(html, /data-bar-base="75"/u);
  assert.match(html, /data-bar-overflow="25"/u);
  assert.match(html, /bg-danger/u);
  assert.deepEqual(buttonTexts(html), ['確認する']);
});

test('the manual settlement row has the id and amount fields with the manual: prefix, and one button', () => {
  const html = list([manual()]);
  const text = readable(html);
  for (const expected of [
    '不明な費用',
    'llm',
    '2030-09',
    '最大負担',
    'XTS 40.00',
    '照合 ID',
    '実費（XTS）',
  ])
    assert(text.includes(expected), expected);
  assert.match(html, /value="manual:"/u);
  assert.match(html, /inputMode="decimal"|inputmode="decimal"/u);
  assert.deepEqual(buttonTexts(html), ['精算する']);
  // 入力の問題は、送ろうとしたときだけ出す（最初は出さない）。
  assert.doesNotMatch(html, /数字で入力してください/u);
  const checked = list([manual()], {
    state: markChecked(INITIAL_BUDGET_STATE, id(3)),
  });
  assert.match(checked, /数字で入力してください/u);
  // 入力済みの値は欄に残る。
  const typed = list([manual()], {
    state: setManualInput(INITIAL_BUDGET_STATE, id(3), {
      reconciliationId: 'manual:invoice-a',
      amount: '3.5',
    }),
  });
  assert.match(typed, /value="manual:invoice-a"/u);
  assert.match(typed, /value="3.5"/u);
});

test('while input is stopped, the approve and review buttons are not drawn; reject and settle stay', () => {
  const html = list([approval(), overrun(), manual()], { stopped: true });
  assert.deepEqual(buttonTexts(html), ['見送る', '精算する']);
});

test('an item whose command outcome is unknown shows only the mark and no button or field', () => {
  const html = list([
    approval({ delivery_unknown: true }),
    overrun({ delivery_unknown: true }),
    manual({ delivery_unknown: true }),
  ]);
  assert.deepEqual(buttonTexts(html), []);
  assert.equal((html.match(/結果不明/gu) ?? []).length, 3);
  assert.doesNotMatch(html, /<input/u);
});

test('an expired approval shows "expired" and no approve or reject button', () => {
  const html = list([approval()], {
    now: Date.parse('2030-10-15T00:10:00.000Z'),
  });
  assert.deepEqual(buttonTexts(html), []);
  assert(readable(html).includes('期限切れ'));
});

test('a busy row shows the sending label and a notice sits under its row', () => {
  const busy = markBusy(INITIAL_BUDGET_STATE, id(1));
  const html = list([approval()], { state: busy });
  assert(buttonTexts(html).includes('送っています…'));
  const noticed = list([overrun()], {
    state: {
      ...INITIAL_BUDGET_STATE,
      notices: {
        [id(2)]: {
          tone: 'warning',
          text: '確認でやめたため、確認していません。',
        },
      },
    },
  });
  assert(readable(noticed).includes('確認でやめたため、確認していません。'));
});

test('the visible copy never carries a reason code, an API name or an ID, and never an explanatory sentence', () => {
  const html = list([approval(), overrun(), manual()], {
    state: markChecked(INITIAL_BUDGET_STATE, id(3)),
  });
  for (const item of readable(html)) {
    assert.doesNotMatch(
      item,
      /overage_|overrun_|manual_|reservation|approval_|budget_|\/v1\/|[a-z]+_[a-z_]+/u,
      item,
    );
    assert.doesNotMatch(item, new RegExp(id(1).slice(0, 24), 'u'), item);
  }
  // 説明の文章（。で終わる文）を置かない。入力の問題の文言だけが例外（欄の下の短い 1 文）。
  const sentences = readable(html).filter((item) => item.endsWith('。'));
  assert.deepEqual(sentences, [
    '「manual:」に続けて、英数字と「.」「_」「-」で入力してください。',
    '数字で入力してください（小数は 6 桁まで）。',
  ]);
});

test('the bar widths come from a fixed table (no inline style), and the label names both amounts', () => {
  assert.equal(barStep(0), 0);
  assert.equal(barStep(2), 0);
  assert.equal(barStep(3), 5);
  assert.equal(barStep(67), 65);
  assert.equal(barStep(73), 75);
  assert.equal(barStep(100), 100);
  assert.equal(barStep(150), 100);
  assert.equal(itemLabel('承認する', approval()), '承認する（llm・XTS 40.00）');
  const html = list([approval(), overrun()]);
  assert.doesNotMatch(html, /style="/u);
});
