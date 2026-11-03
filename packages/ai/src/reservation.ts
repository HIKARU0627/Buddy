// 予約 R・最大負担 M の見積もりに渡す量（B10-02 P3、ADR 0082）。設計 05「予約と最大負担の区別」F02、ADR 0034。
// B07 の門（BudgetGate.admit）は profile と timeout から金額を計算する。ここは、入力の実量と profile の出力上限を
// PaidRequest.quantities の形（契約の PriceCategory の文字列）にするだけ。金額・単価・為替は扱わない。
// - 出力は profile の output_limit_tokens（思考を含む）。null の profile は M を有限にできないので受け付けない。
// - 入力は実際に送る量を input_tokens にすべて入れる（cached に分けない。B07 の M の見積もりと同じ）。
// - 有料の provider は price_version が要る。ローカルは B07 の門を通さない（price_version なし）。
import type { ModelProfile } from '@buddy/contracts';
import type { PriceCategory, PriceVersionInput } from '@buddy/domain';

export type ReservationQuantities = Readonly<
  Partial<Record<PriceCategory, string>>
>;

export interface ReservationInput {
  readonly profile: ModelProfile;
  readonly input_tokens: number;
  // 1 回の要求で使うツールの呼び出し数（省略は 0）。
  readonly tool_calls?: number;
  // 実行時の単価の版。ツールの料金区分があるかを確かめ、既知の 0 を渡すために使う。
  readonly priceVersion?: PriceVersionInput;
}

export interface ReservationPlan {
  readonly quantities: ReservationQuantities;
  readonly price_version: string;
}

export type ReservationOutcome =
  | { readonly ok: true; readonly plan: ReservationPlan }
  | { readonly ok: false; readonly reasonCodes: readonly string[] };

const unique = (items: readonly string[]): string[] =>
  items.filter((item, index) => items.indexOf(item) === index);

export function planReservation(input: ReservationInput): ReservationOutcome {
  const reasons: string[] = [];
  const toolCalls = input.tool_calls ?? 0;
  if (!Number.isSafeInteger(input.input_tokens) || input.input_tokens < 0)
    reasons.push('invalid_input_tokens');
  if (!Number.isSafeInteger(toolCalls) || toolCalls < 0)
    reasons.push('invalid_tool_calls');
  const outputLimit = input.profile.output_limit_tokens;
  const priceVersion = input.profile.price_version;
  if (outputLimit === null) reasons.push('output_limit_missing');
  if (priceVersion === null) reasons.push('price_version_missing');
  // 予約に使う単価の版は、profile に固定した版と一致しなければならない（区分の判定をすり替えない）。
  if (
    input.priceVersion !== undefined &&
    priceVersion !== null &&
    input.priceVersion.price_version !== priceVersion
  )
    reasons.push('price_version_mismatch');
  // ツールの実使用量は usage と別に渡す。単価の版がツールを課金するときだけ件数を渡せる。
  const pricedTools =
    input.priceVersion?.rates.some((rate) => rate.category === 'tool_calls') ===
    true;
  if (toolCalls > 0 && !pricedTools) reasons.push('tool_calls_unpriced');
  if (outputLimit === null || priceVersion === null || reasons.length > 0)
    return { ok: false, reasonCodes: unique(reasons) };

  const quantities: Partial<Record<PriceCategory, string>> = {
    input_tokens: String(input.input_tokens),
    output_tokens: String(outputLimit),
  };
  // B07 は単価の版にある区分をすべて見て、省略した区分は max_quantity_per_request を使う。
  // ツールの単価がある版では、使わない要求でも既知の 0 を渡して最大回数を予約しない。
  if (pricedTools) quantities.tool_calls = String(toolCalls);
  return { ok: true, plan: { quantities, price_version: priceVersion } };
}
