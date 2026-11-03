// usage から実費（金額）を求める（B10-02 P3、ADR 0082）。設計 05「費用の計算」「予約と最大負担の区別」、
// ADR 0006・0034・0035。金額は通貨単位の百万分の一の整数文字列（契約の Amount）で、BigInt で計算する。
// - 予約 R・最大負担 M の見積もり（安全係数を含む）は B07 の computeLiability / computeReservation が行う。
//   ここは**精算する実費**だけを求める。実費に安全係数を掛けない（B07 の会話の実費と同じ）。
// - PriceCategory の output_tokens は思考を含む（契約の説明）。reasoning_tokens を足して二重に数えない。
// - cached_input_tokens は input_tokens の内数。命中分は cached の単価、残りは input の単価で課金する。
//   cached の単価がない版では、命中分も input の単価で課金する。
// - usage_complete が false のときは実費を確定しない（ADR 0070）。呼び出し側は usage 不明として R と M を保持する。
import type { ModelUsage } from '@buddy/contracts';
import type { PriceCategory, PriceVersionInput } from '@buddy/domain';

const AMOUNT_MAX = 999_999_999_999_999_999n;
const INTEGER = /^(0|[1-9][0-9]*)$/u;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/u;
const MICRO = 1_000_000n;

const integer = (text: string): bigint | null =>
  INTEGER.test(text) ? BigInt(text) : null;

const micros = (text: string): bigint | null => {
  if (!DECIMAL.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
};

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

const unique = (items: readonly string[]): string[] =>
  items.filter((item, index) => items.indexOf(item) === index);

export interface UsageCostRequest {
  readonly usage: ModelUsage;
  readonly priceVersion: PriceVersionInput;
  readonly budgetCurrency: string;
}

export interface UsageCostLine {
  readonly category: PriceCategory;
  readonly quantity: string;
  readonly amount: string;
}

export interface UsageCostResult {
  readonly amount: string;
  // 予約に固定した単価の版（B07 の BudgetTicket.price_version と同じ）。
  readonly price_version: string;
  readonly lines: readonly UsageCostLine[];
}

export type UsageCostOutcome =
  | ({ readonly ok: true } & UsageCostResult)
  | { readonly ok: false; readonly reasonCodes: readonly string[] };

const usageInvalid = (usage: ModelUsage): boolean =>
  !Number.isSafeInteger(usage.input_tokens) ||
  usage.input_tokens < 0 ||
  !Number.isSafeInteger(usage.cached_input_tokens) ||
  usage.cached_input_tokens < 0 ||
  !Number.isSafeInteger(usage.output_tokens) ||
  usage.output_tokens < 0 ||
  (usage.reasoning_tokens !== null &&
    (!Number.isSafeInteger(usage.reasoning_tokens) ||
      usage.reasoning_tokens < 0));

export function usageCost(request: UsageCostRequest): UsageCostOutcome {
  const { usage, priceVersion, budgetCurrency } = request;
  if (usage.usage_complete !== true)
    return { ok: false, reasonCodes: ['usage_incomplete'] };
  if (usageInvalid(usage)) return { ok: false, reasonCodes: ['usage_invalid'] };
  if (usage.cached_input_tokens > usage.input_tokens)
    return { ok: false, reasonCodes: ['cached_exceeds_input'] };
  // output_tokens は思考を含む（契約の PriceCategory の説明）。思考が出力を超える記録は矛盾している。
  if (
    usage.reasoning_tokens !== null &&
    usage.reasoning_tokens > usage.output_tokens
  )
    return { ok: false, reasonCodes: ['reasoning_exceeds_output'] };
  if (priceVersion.conversion.to_currency !== budgetCurrency)
    return { ok: false, reasonCodes: ['currency_mismatch'] };
  const exchange = micros(priceVersion.conversion.rate);
  if (exchange === null || exchange === 0n)
    return { ok: false, reasonCodes: ['invalid_conversion'] };

  const reasons: string[] = [];
  const lines: UsageCostLine[] = [];
  const rateOf = (category: PriceCategory) =>
    priceVersion.rates.find((rate) => rate.category === category);
  const bill = (category: PriceCategory, quantity: bigint): void => {
    if (quantity <= 0n) return;
    const rate = rateOf(category);
    if (rate === undefined) {
      reasons.push(`unpriced_category:${category}`);
      return;
    }
    const unitPrice = integer(rate.unit_price);
    const per = integer(rate.per_quantity);
    const minimum = integer(rate.minimum_quantity);
    if (unitPrice === null || per === null || per === 0n || minimum === null) {
      reasons.push(`invalid_price:${category}`);
      return;
    }
    // 1 回の最低課金量。量が 0 のときは掛けない（B07 の billedAmount と同じ）。
    const billed = quantity > minimum ? quantity : minimum;
    const amount = ceilDiv(billed * unitPrice * exchange, per * MICRO);
    lines.push({
      category,
      quantity: billed.toString(),
      amount: amount.toString(),
    });
  };

  const cached = BigInt(usage.cached_input_tokens);
  const input = BigInt(usage.input_tokens);
  const cachedRate = rateOf('cached_input_tokens');
  if (cachedRate === undefined) {
    // cached の単価がない版は、命中分も含めて input の単価で課金する。
    bill('input_tokens', input);
  } else {
    bill('input_tokens', input - cached);
    bill('cached_input_tokens', cached);
  }
  // output_tokens は思考を含む（契約の PriceCategory の説明）。reasoning_tokens は内訳で、足さない。
  bill('output_tokens', BigInt(usage.output_tokens));

  const total = lines.reduce((sum, line) => sum + BigInt(line.amount), 0n);
  if (total > AMOUNT_MAX) reasons.push('amount_overflow');
  if (reasons.length > 0) return { ok: false, reasonCodes: unique(reasons) };
  return {
    ok: true,
    amount: total.toString(),
    price_version: priceVersion.price_version,
    lines,
  };
}
