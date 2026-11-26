// 家計簿の分類ごとの予算（家計簿 段階 2、ADR 0166）。
//
// - 予算は支出の分類ごとの月の金額（円の正の整数）。予算のない分類は持たない（0 円の予算は「予算なし」と同じなので持たない）。
// - 収入・振替の分類には予算を置かない（支出の分類だけ）。
// - 月の比べ方: その月の分類ごとの支出（domain の summarizeHouseholdMonth）と予算を並べ、残り（負なら超過）を出す。
// 保存・暗号・時計はここで扱わない（金額は DB で暗号文にする）。

import {
  HOUSEHOLD_AMOUNT_MAX,
  HOUSEHOLD_CATEGORIES,
  householdCategory,
} from './household.js';
import type { HouseholdMonthSummary } from './household.js';

export interface HouseholdBudgetItem {
  readonly category: string;
  readonly budget_yen: number;
}

const ORDER: ReadonlyMap<string, number> = new Map(
  HOUSEHOLD_CATEGORIES.map((category, index) => [category.id, index]),
);

/** 予算の一覧の検査。理由が空なら正しい。 */
export function householdBudgetErrors(
  items: readonly HouseholdBudgetItem[],
): string[] {
  const errors = new Set<string>();
  const seen = new Set<string>();
  for (const item of items) {
    const category = householdCategory(item.category);
    if (category === null) errors.add('category_invalid');
    else if (category.direction !== 'expense')
      errors.add('category_not_expense');
    if (seen.has(item.category)) errors.add('category_duplicate');
    seen.add(item.category);
    if (
      !Number.isSafeInteger(item.budget_yen) ||
      item.budget_yen < 1 ||
      item.budget_yen > HOUSEHOLD_AMOUNT_MAX
    )
      errors.add('budget_invalid');
  }
  return [...errors];
}

/** 予算の一覧を分類の表示の順に並べる（保存と比べ方の順をそろえる）。 */
export function sortHouseholdBudget(
  items: readonly HouseholdBudgetItem[],
): HouseholdBudgetItem[] {
  return [...items].sort(
    (a, b) => (ORDER.get(a.category) ?? 0) - (ORDER.get(b.category) ?? 0),
  );
}

export interface HouseholdBudgetUse {
  readonly category: string;
  readonly budget_yen: number;
  readonly spent_yen: number;
  // 予算 − 支出（負なら超過）。
  readonly remaining_yen: number;
}

/** その月の分類ごとの支出と予算を並べる（予算のある分類だけ。分類の表示の順）。 */
export function householdBudgetUse(
  items: readonly HouseholdBudgetItem[],
  summary: Pick<HouseholdMonthSummary, 'expense_by_category'>,
): HouseholdBudgetUse[] {
  const spent = new Map(
    summary.expense_by_category.map((item) => [item.category, item.total_yen]),
  );
  return sortHouseholdBudget(items).map((item) => {
    const used = spent.get(item.category) ?? 0;
    return {
      category: item.category,
      budget_yen: item.budget_yen,
      spent_yen: used,
      remaining_yen: item.budget_yen - used,
    };
  });
}
