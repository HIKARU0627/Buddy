// 家計簿の定期の支出と固定費の目安（家計簿 段階 2、ADR 0165）。
//
// 毎月決まって払っている支出（サブスクリプション・公共料金・保険・家賃など）を、記録から見つける。保存はせず、Core が
// 記録を復号してから毎回この規則で計算する（本人が分類や店を直せば、次の計算に反映される）。
// - 同じ店: 店名を正規化して比べる（ADR 0158 の normalizeHouseholdMerchant）。店名のない記録は数えない。
// - 定期とみなす条件: 支出で、見る範囲（既定 12 か月）のうち 3 か月以上に現れ、最後に現れたのが今月か先月で、
//   1 か月の回数が平均 2 回以下（毎日の買い物を固定費にしない）、月ごとの金額の最大が最小の 2 倍以下（公共料金の
//   季節の変動は許し、たまたま同じ店で買った額の大きな違いは外す）。
// - 月の金額の目安は、現れた月ごとの合計の中央値（偶数個なら小さい方。円の整数のまま）。
// - 固定費の目安は、定期の支出の目安の合計。
// 時計・暗号・DB はここで扱わない。

import { normalizeHouseholdMerchant } from './household.js';
import type { HouseholdEntryContent } from './household.js';

export const HOUSEHOLD_RECURRING_MIN_MONTHS = 3;
export const HOUSEHOLD_RECURRING_MAX_PER_MONTH = 2;
export const HOUSEHOLD_RECURRING_MAX_RATIO = 2;

export interface HouseholdRecurringItem {
  // 最後に現れた記録の店名（表示用）。
  readonly merchant: string;
  // 最後に現れた記録の分類。
  readonly category: string;
  // 月の金額の目安（現れた月ごとの合計の中央値）。
  readonly typical_yen: number;
  // 現れた月の数。
  readonly months_seen: number;
  // 最後に現れた日（YYYY-MM-DD）。
  readonly last_on: string;
}

export interface HouseholdRecurringSummary {
  // 目安の大きい順（同じなら店名の順）。
  readonly items: readonly HouseholdRecurringItem[];
  // 固定費の目安（目安の合計）。
  readonly monthly_total_yen: number;
}

const monthIndex = (month: string): number =>
  Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

// 小さい方の中央値（偶数個なら真ん中の二つの小さい方）。
function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/**
 * 記録（形の検査済み）から定期の支出を見つける。currentMonth は今月（YYYY-MM）で、最後に現れたのが今月か先月の店だけを
 * 残す（やめたサブスクリプションを数え続けない）。範囲の外の記録は呼び出し側が渡さない。
 */
export function detectHouseholdRecurring(
  entries: readonly Pick<
    HouseholdEntryContent,
    'direction' | 'amount_yen' | 'occurred_on' | 'category' | 'merchant'
  >[],
  currentMonth: string,
): HouseholdRecurringSummary {
  const groups = new Map<
    string,
    {
      perMonth: Map<string, { total: number; count: number }>;
      last: { on: string; merchant: string; category: string };
    }
  >();
  for (const entry of entries) {
    if (entry.direction !== 'expense' || entry.merchant === null) continue;
    const key = normalizeHouseholdMerchant(entry.merchant);
    if (key === null) continue;
    const month = entry.occurred_on.slice(0, 7);
    const group = groups.get(key) ?? {
      perMonth: new Map<string, { total: number; count: number }>(),
      last: {
        on: entry.occurred_on,
        merchant: entry.merchant,
        category: entry.category,
      },
    };
    const current = group.perMonth.get(month) ?? { total: 0, count: 0 };
    group.perMonth.set(month, {
      total: current.total + entry.amount_yen,
      count: current.count + 1,
    });
    if (entry.occurred_on >= group.last.on)
      group.last = {
        on: entry.occurred_on,
        merchant: entry.merchant,
        category: entry.category,
      };
    groups.set(key, group);
  }
  const current = monthIndex(currentMonth);
  const items: HouseholdRecurringItem[] = [];
  for (const group of groups.values()) {
    const months = [...group.perMonth.values()];
    if (months.length < HOUSEHOLD_RECURRING_MIN_MONTHS) continue;
    const lastMonth = monthIndex(group.last.on.slice(0, 7));
    if (current - lastMonth > 1 || lastMonth > current) continue;
    const count = months.reduce((sum, month) => sum + month.count, 0);
    if (count > months.length * HOUSEHOLD_RECURRING_MAX_PER_MONTH) continue;
    const totals = months.map((month) => month.total);
    if (
      Math.max(...totals) >
      Math.min(...totals) * HOUSEHOLD_RECURRING_MAX_RATIO
    )
      continue;
    items.push({
      merchant: group.last.merchant,
      category: group.last.category,
      typical_yen: lowerMedian(totals),
      months_seen: months.length,
      last_on: group.last.on,
    });
  }
  items.sort(
    (a, b) =>
      b.typical_yen - a.typical_yen ||
      (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0),
  );
  return {
    items,
    monthly_total_yen: items.reduce((sum, item) => sum + item.typical_yen, 0),
  };
}
