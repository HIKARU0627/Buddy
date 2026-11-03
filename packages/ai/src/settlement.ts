// usage を B07 の精算へ渡す計画（B10-02 P3、ADR 0082）。設計 05「予約と最大負担の区別」、ADR 0037。
// - usage が確定していれば、実費（actual_gross）と単価の版を返す。呼び出し側は BudgetGate.settle に渡す。
// - usage が null か usage_complete が false なら、実費を確定せず usage 不明として R と M を保持する
//   （予約を解放しない。ADR 0070）。timeout・拒否・不正な応答でも、usage が分かれば精算する（費用を捨てない）。
// - 金額の計算は cost.ts、予約 R・M は B07 の computeReservation。ここは二つをつながない（作り直さない）。
import type { ModelUsage } from '@buddy/contracts';
import type { PriceVersionInput } from '@buddy/domain';
import { usageCost, type UsageCostLine } from './cost.js';

export interface UsageSettlementRequest {
  readonly priceVersion: PriceVersionInput;
  readonly budgetCurrency: string;
}

export type UsageSettlement =
  | {
      readonly kind: 'settle';
      readonly actual_gross: string;
      readonly price_version: string;
      readonly lines: readonly UsageCostLine[];
    }
  | {
      readonly kind: 'usage_unknown';
      readonly reason: 'usage_missing' | 'usage_incomplete';
    }
  | { readonly kind: 'invalid'; readonly reasonCodes: readonly string[] };

export function planUsageSettlement(
  usage: ModelUsage | null,
  request: UsageSettlementRequest,
): UsageSettlement {
  if (usage === null) return { kind: 'usage_unknown', reason: 'usage_missing' };
  if (usage.usage_complete !== true)
    return { kind: 'usage_unknown', reason: 'usage_incomplete' };
  const cost = usageCost({ usage, ...request });
  if (!cost.ok) return { kind: 'invalid', reasonCodes: cost.reasonCodes };
  return {
    kind: 'settle',
    actual_gross: cost.amount,
    price_version: cost.price_version,
    lines: cost.lines,
  };
}
