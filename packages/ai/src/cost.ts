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
// token の料金区分。ツールは実使用量を別に受け取り、検索・会話の秒数はこの段階では精算しない。
const TOKEN_CATEGORIES: readonly PriceCategory[] = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
];

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
  // 1 回の要求で実際に使ったツールの呼び出し数。単価の版がツールを課金するときに必須。
  readonly tool_calls?: number;
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
  // token 以外の料金区分のうち、ツールは実使用量を別に受け取れば精算できる。検索・会話の秒数は
  // この段階では実使用量を確定できないので、少なく数えないよう拒否する（U192）。
  const toolCalls = request.tool_calls;
  if (
    toolCalls !== undefined &&
    (!Number.isSafeInteger(toolCalls) || toolCalls < 0)
  )
    return { ok: false, reasonCodes: ['invalid_tool_calls'] };
  const priced = new Set(priceVersion.rates.map((rate) => rate.category));
  const unsupported = [...priced].filter(
    (category) =>
      !TOKEN_CATEGORIES.includes(category) && category !== 'tool_calls',
  );
  if (unsupported.length > 0)
    return {
      ok: false,
      reasonCodes: unique(
        unsupported.map((category) => `unsettled_category:${category}`),
      ),
    };
  // ツールの単価がある版では、実使用量（0 も既知の値）を受け取るまで精算しない。
  if (priced.has('tool_calls') && toolCalls === undefined)
    return { ok: false, reasonCodes: ['unsettled_category:tool_calls'] };
  if (
    priced.has('tool_calls') === false &&
    toolCalls !== undefined &&
    toolCalls > 0
  )
    return { ok: false, reasonCodes: ['unsettled_category:tool_calls'] };

  const reasons: string[] = [];
  const lines: UsageCostLine[] = [];
  const rateOf = (category: PriceCategory) =>
    priceVersion.rates.find((rate) => rate.category === category);
  const bill = (category: PriceCategory, quantity: bigint): void => {
    const rate = rateOf(category);
    if (rate === undefined) {
      // 出力は最低課金量を決められないので、量が 0 でも単価の欠落を拒否する。
      if (quantity > 0n || category === 'output_tokens')
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
    // 入力と cache は量が 0 のときは課金しない（B07 の estimate のゼロ免除と同じ）。
    // 出力は「1 回の最低課金量」があるので、量が 0 でも minimum_quantity を掛ける
    // （拒否・打ち切りで出力が 0 の応答も、出力の最低料金を落とさない）。
    const zeroExempt =
      category === 'input_tokens' || category === 'cached_input_tokens';
    if (zeroExempt && quantity === 0n) return;
    const billed = quantity > minimum ? quantity : minimum;
    if (billed === 0n) return;
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
  // ツールの実使用量が分かっているときだけ、ツールの区分を課金する（0 は既知の 0）。
  if (priced.has('tool_calls') && toolCalls !== undefined)
    bill('tool_calls', BigInt(toolCalls));

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
