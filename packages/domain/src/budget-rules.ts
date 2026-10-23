// B07-02: 予算の純粋な規則（設計 05 予約と最大負担の区別 F02・費用の計算の単価の管理 D15、09 QA42・QA20・X18・X53、
// ADR 0006・0034・0035）。最大負担 M と予約 R の計算・予算月・利用状況の集計・超過枠への経路・手での精算と M 超過の確認。
// 金額は通貨単位の百万分の一の整数文字列（契約の Amount、18 桁まで）で受け、BigInt で計算する。浮動小数点数を使わない。
// 個人の金額・単価・為替はコードに置かず、実行時の設定（BudgetRuntimeConfig）から渡す。ADR 0006 の既存の関数（budget.ts）は変えない。

import {
  admitBudget,
  poolPath,
  type AdmissionRequest,
  type BudgetSettings,
  type Failure,
  type ReservationRecord,
} from './budget.js';

// 契約の Amount の上限（18 桁）。SQLite の 64 ビット整数に収まる（ADR 0034）。
export const BUDGET_AMOUNT_MAX = 999_999_999_999_999_999n;

const INTEGER = /^(0|[1-9][0-9]*)$/u;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/u;
const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;
const YEAR_MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/u;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;
const MICRO = 1_000_000n;
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

const toInteger = (text: string | null | undefined): bigint | null =>
  typeof text === 'string' && INTEGER.test(text) ? BigInt(text) : null;

const toMicros = (text: string): bigint | null => {
  if (!DECIMAL.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
};

// 暦にない日付（2 月 30 日・4 月 31 日）や 24:00 は、Date.parse が別の時刻へずらすので拒否する。
// 秒までを toISOString と往復して比べる（小数秒はミリ秒より細かい桁を Date が捨てる。ADR 0034）。
// 扱う時刻は 1970-01-01T00:00:00Z 以降（暦年の範囲 1970〜9999 と合わせる。ADR 0035）。
const toMillis = (text: string): number | null => {
  if (!UTC_TIME.test(text)) return null;
  const value = Date.parse(text);
  if (Number.isNaN(value) || value < 0) return null;
  return new Date(value).toISOString().slice(0, 19) === text.slice(0, 19)
    ? value
    : null;
};

const unique = (items: readonly string[]): string[] =>
  items.filter((item, index) => items.indexOf(item) === index);

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

// ---------------------------------------------------------------------------
// 1. 最大負担 M（computeLiability）

// 契約の PriceCategory。cached_input_tokens は精算だけに使い、M は非命中の input_tokens の単価で見積もる（05 固定部分の節）。
export type PriceCategory =
  | 'input_tokens'
  | 'cached_input_tokens'
  | 'output_tokens'
  | 'tool_calls'
  | 'search_requests'
  | 'live_seconds';

// 契約の PriceRate・CurrencyConversion・PriceVersion と同じ形（snake_case）。実行時の設定ファイルの値をそのまま渡す。
export interface PriceRateInput {
  readonly category: PriceCategory;
  readonly unit_price: string;
  readonly per_quantity: string;
  readonly minimum_quantity: string;
  readonly max_quantity_per_request: string | null;
}

export interface CurrencyConversionInput {
  readonly conversion_version: string;
  readonly to_currency: string;
  readonly rate: string;
  readonly safety_factor: string;
}

export interface PriceVersionInput {
  readonly price_version: string;
  readonly price_key: string;
  readonly currency: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly rates: readonly PriceRateInput[];
  readonly conversion: CurrencyConversionInput;
}

export interface LiabilityRequest {
  // 予算の通貨（BudgetConfig.currency）。換算後の通貨と一致しなければ拒否する。
  readonly budgetCurrency: string;
  // 課金対象の単価の系列（PriceVersion.price_key）。
  readonly priceKey: string;
  readonly priceVersions: readonly PriceVersionInput[];
  readonly verifiedPriceVersions: readonly string[];
  // 課金され得る期間。受付の時刻から、応答の期限（timeout）まで。両端を含む。
  readonly billableFrom: string;
  readonly billableUntil: string;
  // 区分ごとの 1 要求の最大量。入力は実際に送る量、出力は profile の出力上限、ツール・検索は呼出し上限。
  // 省略した区分は単価の版の max_quantity_per_request を使う。入力は送る量を input_tokens にすべて入れ、
  // cached_input_tokens に分けない（キャッシュの命中を見込まない）。
  readonly quantities: Readonly<Partial<Record<PriceCategory, string>>>;
}

export interface LiabilityLine {
  readonly category: PriceCategory;
  readonly quantity: string;
  readonly amount: string;
}

export interface LiabilityResult {
  readonly ok: true;
  readonly maxLiability: string;
  // 受付時に予約へ固定する版（billableFrom に適用される版）。
  readonly priceVersion: string;
  // 期間に掛かるすべての版（境界を跨げば 2 つ以上）。
  readonly priceVersions: string[];
  readonly lines: LiabilityLine[];
}

interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

const greater = (a: Rational, b: Rational): boolean => a.n * b.d > b.n * a.d;

// 期間 [from, until] に掛かる版を、適用開始の順に並べる。期間の一部でも単価が決まっていなければ null。
function coveringVersions(
  versions: readonly PriceVersionInput[],
  priceKey: string,
  from: number,
  until: number,
): PriceVersionInput[] | null {
  const end = (version: PriceVersionInput): number =>
    version.effective_to === null
      ? Infinity
      : (toMillis(version.effective_to) ?? -Infinity);
  const start = (version: PriceVersionInput): number =>
    toMillis(version.effective_from) ?? Infinity;
  const hits = versions
    .filter(
      (version) =>
        version.price_key === priceKey &&
        start(version) <= until &&
        from < end(version),
    )
    .sort((a, b) => start(a) - start(b));
  const first = hits[0];
  if (first === undefined || start(first) > from) return null;
  for (let index = 1; index < hits.length; index += 1) {
    const previous = hits[index - 1] as PriceVersionInput;
    const current = hits[index] as PriceVersionInput;
    if (start(current) !== end(previous)) return null;
  }
  const last = hits[hits.length - 1] as PriceVersionInput;
  if (end(last) <= until) return null;
  return hits;
}

// 入力の 1 つの版の単価（非命中と命中）。版に cached の単価がなければ、命中した分も入力の単価で課金する。
interface InputTerm {
  readonly quantity: bigint;
  readonly price: bigint;
  readonly per: bigint;
  readonly minimum: bigint;
  readonly cachedPrice: bigint;
  readonly cachedPer: bigint;
  readonly cachedMinimum: bigint;
  readonly factor: Rational;
}

const addRational = (a: Rational, b: Rational): Rational => ({
  n: a.n * b.d + b.n * a.d,
  d: a.d * b.d,
});

// 課金量は「1 単位以上あれば最低課金量との大きい方、0 なら 0」。
const billedAmount = (amount: bigint, minimum: bigint): bigint =>
  amount <= 0n ? 0n : amount > minimum ? amount : minimum;

// 区分ごと・版ごとの高い方（換算と安全係数を掛けた後）の、丸める前の費用。
function maxTermCost(
  terms: readonly InputTerm[],
  amount: bigint,
  cached: boolean,
): Rational {
  let worst: Rational = { n: 0n, d: 1n };
  for (const term of terms) {
    const billed = billedAmount(
      amount,
      cached ? term.cachedMinimum : term.minimum,
    );
    const cost: Rational = {
      n: billed * (cached ? term.cachedPrice : term.price) * term.factor.n,
      d: (cached ? term.cachedPer : term.per) * term.factor.d,
    };
    if (greater(cost, worst)) worst = cost;
  }
  return worst;
}

// 送る量のうち何 token がキャッシュに当たっても下回らない、入力（非命中＋命中）の M の上限。
// 分け方 a（非命中 a、命中 q−a）の本当の費用は ⌈FI(a)⌉＋⌈FC(q−a)⌉（区分ごとに版の高い方を選んで切り上げる）。
// - 端（a＝q・a＝0）は片方だけなので、⌈FI(q)⌉・⌈FC(q)⌉ をそのまま比べる。
// - 両方が 1 以上の分け方（1 ≦ a ≦ q−1）では、FI(a) は max(a, 最低課金量)×単価 の版ごとの最大で a について
//   凸、FC(q−a) も同じく a について凸なので、和は凸で、最大は a＝1 か a＝q−1 にある。⌈x⌉＋⌈y⌉ ≦ ⌈x＋y⌉＋1 な
//   ので、⌈max(FI(1)＋FC(q−1), FI(q−1)＋FC(1))⌉＋1 はどの分け方の費用も下回らない（多くても 1 単位多いだけ）。
// 版ごとに送る量の上限が違えば、大きい方の量で見積もる（費用は量について増えるだけなので少なくならない）。
function inputSplitBound(terms: readonly InputTerm[]): bigint {
  const total = terms.reduce(
    (max, term) => (term.quantity > max ? term.quantity : max),
    0n,
  );
  if (total === 0n) return 0n;
  const ceil = (value: Rational): bigint => ceilDiv(value.n, value.d);
  let bound = ceil(maxTermCost(terms, total, false));
  const allCached = ceil(maxTermCost(terms, total, true));
  if (allCached > bound) bound = allCached;
  if (total >= 2n)
    for (const uncached of [1n, total - 1n]) {
      const mixed =
        ceil(
          addRational(
            maxTermCost(terms, uncached, false),
            maxTermCost(terms, total - uncached, true),
          ),
        ) + 1n;
      if (mixed > bound) bound = mixed;
    }
  return bound;
}

// outputCap は予約 R の算出（p95 × 1.2）で出力の量だけを絞るときに使う。M では使わない。
function estimate(
  request: LiabilityRequest,
  outputCap: bigint | null,
): LiabilityResult | Failure {
  const reasons: string[] = [];
  const from = toMillis(request.billableFrom);
  const until = toMillis(request.billableUntil);
  if (from === null || until === null || until < from)
    return { ok: false, reasonCodes: ['invalid_billable_period'] };
  const versions = coveringVersions(
    request.priceVersions,
    request.priceKey,
    from,
    until,
  );
  if (versions === null)
    return { ok: false, reasonCodes: ['price_not_covered'] };
  if (request.quantities.cached_input_tokens !== undefined)
    reasons.push('cached_input_not_estimated');
  for (const version of versions) {
    if (!request.verifiedPriceVersions.includes(version.price_version))
      reasons.push(`price_unverified:${version.price_version}`);
    if (version.conversion.to_currency !== request.budgetCurrency)
      reasons.push('currency_mismatch');
    const rate = toMicros(version.conversion.rate);
    const safety = toMicros(version.conversion.safety_factor);
    if (rate === null || rate === 0n || safety === null || safety < MICRO)
      reasons.push('invalid_conversion');
  }
  // M に入れる区分: 期間に掛かる版のどれかに単価がある区分と、要求が量を示した区分（キャッシュの区分は除く）。
  const categories = unique([
    ...versions.flatMap((version) =>
      version.rates.map((rate) => rate.category),
    ),
    ...(Object.keys(request.quantities) as PriceCategory[]),
  ]).filter(
    (category) => category !== 'cached_input_tokens',
  ) as PriceCategory[];
  const lines: LiabilityLine[] = [];
  let total = 0n;
  for (const category of categories) {
    const requested = request.quantities[category];
    const requestedQuantity =
      requested === undefined ? undefined : toInteger(requested);
    if (requestedQuantity === null) {
      reasons.push(`invalid_quantity:${category}`);
      continue;
    }
    let highest: Rational | null = null;
    let billedQuantity = 0n;
    const inputTerms: InputTerm[] = [];
    let hasCachedRate = false;
    for (const version of versions) {
      const rate = version.rates.find((item) => item.category === category);
      if (rate === undefined) {
        reasons.push(`unpriced_category:${category}`);
        continue;
      }
      const unitPrice = toInteger(rate.unit_price);
      const perQuantity = toInteger(rate.per_quantity);
      const minimum = toInteger(rate.minimum_quantity);
      const maximum =
        rate.max_quantity_per_request === null
          ? null
          : toInteger(rate.max_quantity_per_request);
      if (
        unitPrice === null ||
        perQuantity === null ||
        perQuantity === 0n ||
        minimum === null ||
        (rate.max_quantity_per_request !== null && maximum === null)
      ) {
        reasons.push(`invalid_price:${category}`);
        continue;
      }
      if (
        requestedQuantity !== undefined &&
        maximum !== null &&
        requestedQuantity > maximum
      ) {
        reasons.push(`quantity_exceeds_max:${category}`);
        continue;
      }
      let quantity = requestedQuantity ?? maximum;
      if (quantity === null) {
        // 上限がなく、送る量も分からない。M を有限にできないので拒否する（F02）。
        reasons.push(`unbounded_category:${category}`);
        continue;
      }
      if (category === 'output_tokens' && outputCap !== null)
        quantity = quantity < outputCap ? quantity : outputCap;
      const billed = quantity > minimum ? quantity : minimum;
      const rateMicros = toMicros(version.conversion.rate) ?? 0n;
      const safetyMicros = toMicros(version.conversion.safety_factor) ?? 0n;
      const cost: Rational = {
        n: billed * unitPrice * rateMicros * safetyMicros,
        d: perQuantity * MICRO * MICRO,
      };
      // 入力はキャッシュなしの単価で見積もる前提（05 固定部分の節）。版に cached の単価があれば、
      // 何 token がキャッシュに当たっても少なく見積もらないよう、後で inputSplitBound の上限も比べる
      // （cached の単価が高い版・cached の最低課金量が大きい版も含む。ADR 0035）。
      if (category === 'input_tokens') {
        const cachedRate = version.rates.find(
          (item) => item.category === 'cached_input_tokens',
        );
        const cachedPrice =
          cachedRate === undefined
            ? unitPrice
            : toInteger(cachedRate.unit_price);
        const cachedPer =
          cachedRate === undefined
            ? perQuantity
            : toInteger(cachedRate.per_quantity);
        const cachedMinimum =
          cachedRate === undefined
            ? minimum
            : toInteger(cachedRate.minimum_quantity);
        if (
          cachedPrice === null ||
          cachedPer === null ||
          cachedPer === 0n ||
          cachedMinimum === null
        ) {
          reasons.push('invalid_price:cached_input_tokens');
        } else {
          if (cachedRate !== undefined) hasCachedRate = true;
          inputTerms.push({
            quantity,
            price: unitPrice,
            per: perQuantity,
            minimum,
            cachedPrice,
            cachedPer,
            cachedMinimum,
            factor: { n: rateMicros * safetyMicros, d: MICRO * MICRO },
          });
        }
      }
      // 境界を跨ぐ要求は、換算と安全係数を掛けた後の高い方を使う（05 F02）。
      if (highest === null || greater(cost, highest)) highest = cost;
      if (billed > billedQuantity) billedQuantity = billed;
    }
    if (highest === null) continue;
    // 丸めは区分ごとに切り上げる（少なく見積もらない。原本に決めなし、ADR 0035）。
    let amount = ceilDiv(highest.n, highest.d);
    if (hasCachedRate) {
      const split = inputSplitBound(inputTerms);
      if (split > amount) amount = split;
    }
    total += amount;
    lines.push({
      category,
      quantity: billedQuantity.toString(),
      amount: amount.toString(),
    });
  }
  if (total > BUDGET_AMOUNT_MAX) reasons.push('amount_overflow');
  if (reasons.length > 0) return { ok: false, reasonCodes: unique(reasons) };
  return {
    ok: true,
    maxLiability: total.toString(),
    priceVersion: (versions[0] as PriceVersionInput).price_version,
    priceVersions: versions.map((version) => version.price_version),
    lines,
  };
}

// 最大負担 M。区分ごとの最大量 × 単価（境界を跨げば高い方）× 為替 × 安全係数を、区分ごとに切り上げて足す。
// 単価の決まっていない期間・確認されていない版・上限のない区分・18 桁を超える合計は拒否する（開始しない）。
export function computeLiability(
  request: LiabilityRequest,
): LiabilityResult | Failure {
  return estimate(request, null);
}

// ---------------------------------------------------------------------------
// 2. 予約 R（computeReservation）

// 評価で測った課金対象の出力（思考を含む）の p95。測ったときの profile の版に結び付ける。
export interface P95Measurement {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly outputP95Tokens: string;
}

export interface ReservationEstimateRequest extends LiabilityRequest {
  readonly profileId: string;
  // profile の設定の版（出力上限・思考設定・評価 suite の版などを変えたら変わる）。
  readonly profileRevision: string;
  // p95 × 1.2 で予約してよい profile（05 は意図判定の比較 profile だけに限り、他へ自動で広げない）。
  readonly p95ProfileIds: readonly string[];
  readonly measurement: P95Measurement | null;
}

export type ReservationBasis =
  'p95' | 'not_designated' | 'p95_unmeasured' | 'profile_changed';

export interface ReservationEstimate {
  readonly ok: true;
  readonly reserved: string;
  readonly maxLiability: string;
  readonly basis: ReservationBasis;
  readonly priceVersion: string;
  readonly priceVersions: string[];
}

// 予約 R。指定の profile だけ、出力を p95 × 1.2（切り上げ。profile の最大課金出力まで）にして M と同じ単価で計算する。
// 指定外・p95 未測定・測った後に設定を変えた profile は最大額（R = M）。R は M を超えない。
export function computeReservation(
  request: ReservationEstimateRequest,
): ReservationEstimate | Failure {
  const liability = computeLiability(request);
  if (!liability.ok) return liability;
  const base = {
    maxLiability: liability.maxLiability,
    priceVersion: liability.priceVersion,
    priceVersions: liability.priceVersions,
  };
  const maxBasis = (basis: ReservationBasis): ReservationEstimate => ({
    ok: true,
    reserved: liability.maxLiability,
    basis,
    ...base,
  });
  if (!request.p95ProfileIds.includes(request.profileId))
    return maxBasis('not_designated');
  const measurement = request.measurement;
  if (measurement === null || measurement.profileId !== request.profileId)
    return maxBasis('p95_unmeasured');
  if (measurement.profileRevision !== request.profileRevision)
    return maxBasis('profile_changed');
  const p95 = toInteger(measurement.outputP95Tokens);
  if (p95 === null) return { ok: false, reasonCodes: ['invalid_p95'] };
  const reservation = estimate(request, ceilDiv(p95 * 6n, 5n));
  if (!reservation.ok) return reservation;
  const reserved = BigInt(reservation.maxLiability);
  const max = BigInt(liability.maxLiability);
  return {
    ok: true,
    reserved: (reserved < max ? reserved : max).toString(),
    basis: 'p95',
    ...base,
  };
}

// ---------------------------------------------------------------------------
// 3. 予算月（budgetMonthOf・advanceBudgetMonth）

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function monthFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (!TIME_ZONE.test(timeZone)) return null;
  if (!formatters.has(timeZone)) {
    let formatter: Intl.DateTimeFormat | null;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
      });
    } catch {
      formatter = null;
    }
    formatters.set(timeZone, formatter);
  }
  return formatters.get(timeZone) ?? null;
}

// UTC の時刻が、IANA タイムゾーンで何年何月か（YYYY-MM）。時刻・タイムゾーンが不正なら null。
export function budgetMonthOf(time: string, timeZone: string): string | null {
  const millis = toMillis(time);
  const formatter = monthFormatter(timeZone);
  if (millis === null || formatter === null) return null;
  return monthAtMillis(millis, formatter);
}

// 扱う暦年は 1970〜9999（ADR 0035）。範囲の外は null。
function monthAtMillis(
  millis: number,
  formatter: Intl.DateTimeFormat,
): string | null {
  const parts = formatter.formatToParts(new Date(millis));
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = parts.find((part) => part.type === 'month')?.value;
  if (
    !Number.isInteger(year) ||
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    month === undefined
  )
    return null;
  return `${String(year).padStart(4, '0')}-${month}`;
}

// 使っている予算月・その月の境目に使うタイムゾーン・その月が実際に始まった時刻（UTC、ミリ秒まで）と、
// 始まりを決めたタイムゾーン。月ごとに Core が記録する（ADR 0034・0035）。monthStart は、monthStartTimeZone
// でこの月に初めてなった時刻（前の月のタイムゾーンでの境目。最初の月は、そのタイムゾーンでの月の初め）。
export interface BudgetCalendarState {
  readonly month: string;
  readonly timeZone: string;
  readonly monthStart: string;
  readonly monthStartTimeZone: string;
}

export type BudgetCalendarResult =
  | {
      readonly ok: true;
      readonly state: BudgetCalendarState;
      readonly rolledOver: boolean;
    }
  | Failure;

const MONTH_SEARCH_SPAN = 33 * 24 * 60 * 60 * 1000;
// 暦月が一時的に戻る区間を探す幅と刻み（夏時間の終わりが月の初めに重なるタイムゾーン）。
const REGRESSION_SCAN_SPAN = 6 * 60 * 60 * 1000;
const REGRESSION_SCAN_STEP = 60 * 1000;

const monthBefore = (month: string): string => {
  const [year = 0, value = 1] = month.split('-').map(Number);
  return value === 1
    ? `${String(year - 1).padStart(4, '0')}-12`
    : `${String(year).padStart(4, '0')}-${String(value - 1).padStart(2, '0')}`;
};

const isAfter = (
  formatter: Intl.DateTimeFormat,
  millis: number,
  month: string,
): boolean => (monthAtMillis(millis, formatter) ?? '') > month;

// lo では month 以前、hi では month より後のとき、その間で month 以前から後へ変わる時刻の 1 つ。
function bisectMonth(
  formatter: Intl.DateTimeFormat,
  month: string,
  lo: number,
  hi: number,
): number {
  let low = lo;
  let high = hi;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (isAfter(formatter, middle, month)) high = middle;
    else low = middle;
  }
  return high;
}

// formatter のタイムゾーンで month より後の月に初めてなった時刻（ミリ秒）。夏時間の終わりで暦月が一時的に
// 戻るタイムゾーン（例: America/St_Johns の 2009-11-01）では二分探索が後の方の境目を返し得るので、見つけた
// 境目の前 6 時間を 1 分刻みで調べ、より早く後の月になっている時刻があれば、そこまでで探し直す。1 分より短い
// 戻りは見つけられない（ADR 0035 の制限）。
function firstMillisAfter(
  formatter: Intl.DateTimeFormat,
  month: string,
  lo: number,
  hi: number,
): number {
  let high = hi;
  for (;;) {
    const found = bisectMonth(formatter, month, lo, high);
    let earlier: number | null = null;
    for (
      let probe = found - REGRESSION_SCAN_STEP;
      probe > lo && probe >= found - REGRESSION_SCAN_SPAN;
      probe -= REGRESSION_SCAN_STEP
    )
      if (isAfter(formatter, probe, month)) earlier = probe;
    if (earlier === null) return found;
    high = earlier;
  }
}

// 記録した状態の中身が食い違っていないか。monthStart は、monthStartTimeZone で month の最初のミリ秒
// （その 1 ミリ秒前は前の月）。今の月のタイムゾーン（timeZone）が始まりを決めたタイムゾーンと違うのは、
// タイムゾーンを変えた月の正当なずれ。
function validCalendarState(state: BudgetCalendarState): number | null {
  const startMillis = toMillis(state.monthStart);
  const startFormatter = monthFormatter(state.monthStartTimeZone);
  if (
    monthFormatter(state.timeZone) === null ||
    startFormatter === null ||
    !YEAR_MONTH.test(state.month) ||
    startMillis === null
  )
    return null;
  if (monthAtMillis(startMillis, startFormatter) !== state.month) return null;
  const before = monthAtMillis(startMillis - 1, startFormatter);
  if (before !== null && before >= state.month) return null;
  return startMillis;
}

// 現在の時刻で予算月を進める。設定のタイムゾーンを変えても、今の月の境目は今の月のタイムゾーンで決め、
// 新しいタイムゾーンは翌月から使う（本人の判断 2026-10-23）。止まっている間に境目を 2 つ以上越えていたら、
// 越えた境目ごとに 1 か月ずつ進め、2 つ目からは新しいタイムゾーンの境目を使う。時計が今の月の始まり
// （monthStart）より前へ戻ったら clock_regressed を返し、予算月を戻さずに有料の受付を保留する（原本に
// 決めなし、ADR 0035）。進んだタイムゾーン・遅れたタイムゾーンのどちらへ変えた後も、実際の始まりで比べる。
// 中身の食い違った状態は invalid_calendar_state。扱う時刻は 1970 年以降で、暦年 1970〜9999 の外は invalid_time。
export function advanceBudgetMonth(
  state: BudgetCalendarState | null,
  now: string,
  configuredTimeZone: string,
): BudgetCalendarResult {
  const configured = monthFormatter(configuredTimeZone);
  if (configured === null)
    return { ok: false, reasonCodes: ['invalid_time_zone'] };
  const nowMillis = toMillis(now);
  if (nowMillis === null) return { ok: false, reasonCodes: ['invalid_time'] };
  if (state === null) {
    const month = monthAtMillis(nowMillis, configured);
    if (month === null) return { ok: false, reasonCodes: ['invalid_time'] };
    // この月の初め（前の月より後になる最初の時刻）。33 日前は必ず前の月以前なので、そこから今までを探す。
    const start = firstMillisAfter(
      configured,
      monthBefore(month),
      nowMillis - MONTH_SEARCH_SPAN,
      nowMillis,
    );
    return {
      ok: true,
      rolledOver: false,
      state: {
        month,
        timeZone: configuredTimeZone,
        monthStart: new Date(start).toISOString(),
        monthStartTimeZone: configuredTimeZone,
      },
    };
  }
  const startMillis = validCalendarState(state);
  if (startMillis === null)
    return { ok: false, reasonCodes: ['invalid_calendar_state'] };
  if (nowMillis < startMillis)
    return { ok: false, reasonCodes: ['clock_regressed'] };
  let current: BudgetCalendarState = state;
  let currentStart = startMillis;
  for (;;) {
    const formatter = monthFormatter(current.timeZone) as Intl.DateTimeFormat;
    const shown = monthAtMillis(nowMillis, formatter);
    if (shown === null) return { ok: false, reasonCodes: ['invalid_time'] };
    if (shown <= current.month) break;
    // 今の月のタイムゾーンで、今の月より後に初めてなる時刻が次の月の始まり。
    const boundary = firstMillisAfter(
      formatter,
      current.month,
      currentStart,
      nowMillis,
    );
    current = {
      month: monthAtMillis(boundary, formatter) as string,
      timeZone: configuredTimeZone,
      monthStart: new Date(boundary).toISOString(),
      monthStartTimeZone: current.timeZone,
    };
    currentStart = boundary;
  }
  return current === state
    ? { ok: true, rolledOver: false, state }
    : { ok: true, rolledOver: true, state: current };
}

// ---------------------------------------------------------------------------
// 4. 利用状況（summarizeUsage）

// 契約の BudgetOverageApproval と同じ形。
export interface OverageApprovalRecord {
  readonly approval_id: string;
  readonly request_id: string;
  readonly pool_id: string;
  readonly budget_month: string;
  readonly max_liability: {
    readonly currency: string;
    readonly amount: string;
  };
  readonly overage_remaining: {
    readonly currency: string;
    readonly amount: string;
  };
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  readonly requested_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
}

interface Money {
  readonly currency: string;
  readonly amount: string;
}

export type BudgetHoldReason =
  | 'limit_reached'
  | 'overrun_review_pending'
  | 'ancestor_held'
  | 'config_invalid';

// 以下は契約の BudgetPoolUsage・BudgetMonthUsage・BudgetReservation・BudgetUsageSummary と同じ形。
export interface BudgetPoolUsageView {
  readonly pool_id: string;
  readonly parent_pool_id: string | null;
  readonly limit: Money;
  readonly settled: Money;
  readonly unsettled_reserved: Money;
  readonly unsettled_max_liability: Money;
  readonly usage_unknown_count: number;
  readonly overrun_review_count: number;
  readonly hold_reasons: BudgetHoldReason[];
}

export interface BudgetMonthUsageView {
  readonly budget_month: string;
  readonly pools: BudgetPoolUsageView[];
}

export interface BudgetReservationView {
  readonly reservation_id: string;
  readonly reservation_revision: string;
  readonly request_id: string;
  readonly profile_id: string;
  readonly price_version: string;
  readonly budget_month: string;
  readonly pool_id: string;
  readonly reserved_amount: Money;
  readonly max_liability: Money;
  readonly status: ReservationRecord['status'];
  readonly provider_reconciliation_id: string | null;
  readonly actual_gross: Money | null;
  readonly credit_applied: Money | null;
  readonly additional_spend: Money | null;
  readonly credit_cycle_id: string | null;
  readonly approval_id: string | null;
  readonly overrun_reviewed: boolean;
}

export interface BudgetUsageSummaryView {
  readonly currency: string;
  readonly time_zone: string;
  readonly current_month: string;
  readonly generated_at: string;
  readonly months: BudgetMonthUsageView[];
  readonly overage_approvals: OverageApprovalRecord[];
  readonly pending_reservations: BudgetReservationView[];
}

export interface UsageSummaryInput {
  readonly settings: BudgetSettings;
  readonly reservations: readonly ReservationRecord[];
  readonly currentMonth: string;
  // 今月の境目に使っているタイムゾーン（BudgetCalendarState.timeZone）。
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly overageApprovals: readonly OverageApprovalRecord[];
  // 実行時の設定の検査に通っているか。通っていなければ全枠を config_invalid で保留する。
  readonly configValid: boolean;
}

const isOverrunPending = (item: ReservationRecord): boolean =>
  item.status === 'settled' &&
  !item.overrunReviewed &&
  BigInt(item.actualGross ?? '0') > BigInt(item.maxLiability);

// 契約の BudgetReservation へ写す。クレジットの区分は B07-07 までの初期の規則（クレジット 0・追加の支出＝実費、ADR 0034）。
export function toReservationView(
  item: ReservationRecord,
): BudgetReservationView {
  const money = (amount: string): Money => ({
    currency: item.currency,
    amount,
  });
  const settled = item.status === 'settled' && item.actualGross !== null;
  return {
    reservation_id: item.reservationId,
    reservation_revision: item.revision,
    request_id: item.requestId,
    profile_id: item.profileId,
    price_version: item.priceVersion,
    budget_month: item.budgetMonth,
    pool_id: item.poolId,
    reserved_amount: money(item.reserved),
    max_liability: money(item.maxLiability),
    status: item.status,
    provider_reconciliation_id: item.providerReconciliationId,
    actual_gross: settled ? money(item.actualGross as string) : null,
    credit_applied: settled ? money('0') : null,
    additional_spend: settled ? money(item.actualGross as string) : null,
    credit_cycle_id: null,
    approval_id: item.approvalId,
    overrun_reviewed: item.overrunReviewed,
  };
}

// 月と枠ごとの利用状況。月は今月と、未精算（reserved・usage_unknown）か M 超過の確認待ちが残る前の月だけ。
// 予約は元の予算月だけに数え、前の月の usage 不明は今月に数えない（ADR 0006）。親の枠の金額と usage 不明の件数は
// 子孫の枠の分を含む。M 超過の確認待ちの件数はその枠に計上した予約だけ（保留はその枠と子孫に掛かり、祖先には
// 掛からないため）。合計が 18 桁を超えたら拒否する。
export function summarizeUsage(
  input: UsageSummaryInput,
): { readonly ok: true; readonly summary: BudgetUsageSummaryView } | Failure {
  const { settings, reservations, currentMonth } = input;
  const reasons: string[] = [];
  if (!YEAR_MONTH.test(currentMonth)) reasons.push('invalid_month');
  for (const item of reservations) {
    if (item.currency !== settings.currency) reasons.push('currency_mismatch');
    if (poolPath(settings, item.poolId) === null) reasons.push('unknown_pool');
    if (item.budgetMonth > currentMonth) reasons.push('future_month');
  }
  if (reasons.length > 0) return { ok: false, reasonCodes: unique(reasons) };
  const paths = new Map(
    reservations.map((item) => [
      item.reservationId,
      poolPath(settings, item.poolId) as string[],
    ]),
  );
  const pastMonths = unique(
    reservations
      .filter(
        (item) =>
          item.budgetMonth < currentMonth &&
          (item.status === 'reserved' ||
            item.status === 'usage_unknown' ||
            isOverrunPending(item)),
      )
      .map((item) => item.budgetMonth),
  ).sort((a, b) => (a < b ? 1 : -1));
  // M 超過の確認待ちによる保留は月を問わない（ADR 0006 の overrun_hold と同じ）。
  const overrunPools = new Set(
    reservations.filter(isOverrunPending).map((item) => item.poolId),
  );
  const money = (amount: bigint): Money => ({
    currency: settings.currency,
    amount: amount.toString(),
  });
  const months: BudgetMonthUsageView[] = [];
  for (const month of [currentMonth, ...pastMonths]) {
    const inMonth = reservations.filter((item) => item.budgetMonth === month);
    const own = new Map<string, BudgetPoolUsageView>();
    for (const pool of settings.pools) {
      let settled = 0n;
      let reserved = 0n;
      let max = 0n;
      let unknown = 0;
      let overrun = 0;
      for (const item of inMonth) {
        if (!(paths.get(item.reservationId) ?? []).includes(pool.poolId))
          continue;
        if (item.status === 'settled')
          settled += BigInt(item.actualGross ?? '0');
        else if (item.status !== 'released') {
          reserved += BigInt(item.reserved);
          max += BigInt(item.maxLiability);
        }
        if (item.status === 'usage_unknown') unknown += 1;
        if (item.poolId === pool.poolId && isOverrunPending(item)) overrun += 1;
      }
      if ([settled, reserved, max].some((sum) => sum > BUDGET_AMOUNT_MAX))
        return { ok: false, reasonCodes: ['amount_overflow'] };
      const holds: BudgetHoldReason[] = [];
      if (settled + max >= BigInt(pool.limit)) holds.push('limit_reached');
      if (overrunPools.has(pool.poolId)) holds.push('overrun_review_pending');
      own.set(pool.poolId, {
        pool_id: pool.poolId,
        parent_pool_id: pool.parentPoolId,
        limit: money(BigInt(pool.limit)),
        settled: money(settled),
        unsettled_reserved: money(reserved),
        unsettled_max_liability: money(max),
        usage_unknown_count: unknown,
        overrun_review_count: overrun,
        hold_reasons: holds,
      });
    }
    // 祖先の枠が上限到達か M 超過の確認待ちなら、子孫の枠も受け付けられない（ancestor_held）。
    const pools = settings.pools.map((pool) => {
      const view = own.get(pool.poolId) as BudgetPoolUsageView;
      const ancestors = (poolPath(settings, pool.poolId) ?? []).slice(1);
      const held = ancestors.some((id) =>
        own
          .get(id)
          ?.hold_reasons.some(
            (reason) =>
              reason === 'limit_reached' || reason === 'overrun_review_pending',
          ),
      );
      const holds = [...view.hold_reasons];
      if (held) holds.push('ancestor_held');
      if (!input.configValid) holds.push('config_invalid');
      return { ...view, hold_reasons: holds };
    });
    months.push({ budget_month: month, pools });
  }
  const generatedAt = toMillis(input.generatedAt) ?? Infinity;
  const pending = reservations
    .filter((item) => item.status === 'usage_unknown' || isOverrunPending(item))
    .sort((a, b) =>
      a.budgetMonth === b.budgetMonth
        ? 0
        : a.budgetMonth < b.budgetMonth
          ? -1
          : 1,
    )
    .map(toReservationView);
  return {
    ok: true,
    summary: {
      currency: settings.currency,
      time_zone: input.timeZone,
      current_month: currentMonth,
      generated_at: input.generatedAt,
      months,
      overage_approvals: input.overageApprovals.filter(
        (approval) =>
          approval.status === 'pending' &&
          (toMillis(approval.expires_at) ?? -Infinity) > generatedAt,
      ),
      pending_reservations: pending,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. 超過枠への経路（overageRouteReasons・matchOverageApproval・admitWithOverage）

// 処理の起点。本人が頼んだ背景の処理は owner_request（本人の依頼の枠を使う）。他は自発の枠（本人の判断 2026-10-23）。
export type BudgetOrigin =
  | 'owner_request'
  | 'autonomous_analysis'
  | 'auto_execution'
  | 'initial_import'
  | 'shadow_mode';

export interface OverageRouteInput {
  readonly settings: BudgetSettings;
  readonly origin: BudgetOrigin;
  readonly normalPoolId: string;
  readonly normalReasonCodes: readonly string[];
  // 超過枠へ回せる通常の枠（本人の依頼の枠の ID）の許可リスト。完全一致で照合し、子孫の枠
  // （自発の llm.background など）は含めない。音声の枠は入れない（LLM・検索と融通しない。J17）。
  // 空なら何も回さない（閉じた側に倒す）。どの起点をどの枠に計上するかは B07-04 の門で決める。
  readonly routablePoolIds: readonly string[];
  readonly overagePoolId: string;
}

// 超過枠へ回せない理由。空なら回せる。本人の依頼で、許可リストの枠の通常の受付が上限（m_limit）だけで落ちたときだけ。
export function overageRouteReasons(input: OverageRouteInput): string[] {
  const reasons: string[] = [];
  if (input.origin !== 'owner_request') reasons.push('not_owner_request');
  const path = poolPath(input.settings, input.normalPoolId) ?? [];
  if (!input.routablePoolIds.includes(input.normalPoolId))
    reasons.push('pool_not_routable');
  if (input.normalReasonCodes.length === 0) reasons.push('normal_admitted');
  else if (
    !input.normalReasonCodes.every((code) => /^[rm]_limit:/u.test(code)) ||
    !input.normalReasonCodes.some((code) => code.startsWith('m_limit:'))
  )
    reasons.push('not_limit_only');
  const overage = input.settings.pools.find(
    (pool) => pool.poolId === input.overagePoolId,
  );
  if (
    !overage?.requiresApproval ||
    path.includes(input.overagePoolId) ||
    input.routablePoolIds.includes(input.overagePoolId)
  )
    reasons.push('overage_pool_invalid');
  return reasons;
}

export interface OverageApprovalExpectation {
  readonly approvalId: string | null;
  readonly requestId: string;
  readonly poolId: string;
  readonly budgetMonth: string;
  readonly currency: string;
  readonly maxLiability: string;
  readonly now: string;
}

// 承認が、この要求の request_id・M・枠・予算月に固定されていて、承認済みかつ期限内か。空なら一致。
export function matchOverageApproval(
  approval: OverageApprovalRecord | null,
  expected: OverageApprovalExpectation,
): string[] {
  if (approval === null || expected.approvalId === null)
    return ['approval_required'];
  const reasons: string[] = [];
  if (approval.approval_id !== expected.approvalId)
    reasons.push('approval_unknown');
  if (approval.status !== 'approved')
    reasons.push(`approval_${approval.status}`);
  const now = toMillis(expected.now);
  const expires = toMillis(approval.expires_at);
  if (now === null || expires === null || now >= expires)
    reasons.push('approval_expired');
  // 承認済みなら、承認を求めた後・期限の前に決めた記録がある（requested_at ≦ decided_at < expires_at）。
  // 今の時刻より後に決めたことになっている承認（時計の戻りなど）は使わない（decided_at ≦ now）。
  if (approval.status === 'approved') {
    const requested = toMillis(approval.requested_at);
    const decided =
      approval.decided_at === null ? null : toMillis(approval.decided_at);
    if (
      requested === null ||
      decided === null ||
      expires === null ||
      decided < requested ||
      decided >= expires
    )
      reasons.push('approval_decision_invalid');
    if (decided !== null && (now === null || now < decided))
      reasons.push('approval_decided_in_future');
  }
  if (approval.request_id !== expected.requestId)
    reasons.push('approval_request_mismatch');
  if (
    approval.max_liability.currency !== expected.currency ||
    approval.max_liability.amount !== expected.maxLiability
  )
    reasons.push('approval_m_mismatch');
  if (approval.pool_id !== expected.poolId)
    reasons.push('approval_pool_mismatch');
  if (approval.budget_month !== expected.budgetMonth)
    reasons.push('approval_month_mismatch');
  return unique(reasons);
}

export interface OverageRoute {
  readonly origin: BudgetOrigin;
  readonly routablePoolIds: readonly string[];
  readonly overagePoolId: string;
  readonly approval: OverageApprovalRecord | null;
  readonly now: string;
}

export interface RoutedAdmission {
  readonly admitted: boolean;
  // 計上する枠。通常の枠か超過枠のどちらか一方だけ（ADR 0006）。受け付けなければ null。
  readonly poolId: string | null;
  readonly approvalId: string | null;
  readonly routed: boolean;
  readonly reasonCodes: string[];
}

// 通常の枠で受付し、落ちたら超過枠へ回せるか・承認が一致するかを確かめて、超過枠で受付する。
// 承認済みでも超過枠の上限は M で守る（admitBudget）。
export function admitWithOverage(
  settings: BudgetSettings,
  reservations: readonly ReservationRecord[],
  request: AdmissionRequest,
  route: OverageRoute,
): RoutedAdmission {
  const normal = admitBudget(settings, reservations, {
    ...request,
    approvalId: null,
  });
  if (normal.admitted)
    return {
      admitted: true,
      poolId: request.poolId,
      approvalId: null,
      routed: false,
      reasonCodes: [],
    };
  const reject = (extra: readonly string[]): RoutedAdmission => ({
    admitted: false,
    poolId: null,
    approvalId: null,
    routed: false,
    reasonCodes: [...normal.reasonCodes, ...extra],
  });
  const routeReasons = overageRouteReasons({
    settings,
    origin: route.origin,
    normalPoolId: request.poolId,
    normalReasonCodes: normal.reasonCodes,
    routablePoolIds: route.routablePoolIds,
    overagePoolId: route.overagePoolId,
  });
  if (routeReasons.length > 0) return reject(routeReasons);
  const approvalReasons = matchOverageApproval(route.approval, {
    approvalId: route.approval?.approval_id ?? null,
    requestId: request.requestId,
    poolId: route.overagePoolId,
    budgetMonth: request.budgetMonth,
    currency: request.currency,
    maxLiability: request.maxLiability,
    now: route.now,
  });
  if (approvalReasons.length > 0) return reject(approvalReasons);
  const approvalId = (route.approval as OverageApprovalRecord).approval_id;
  const overage = admitBudget(settings, reservations, {
    ...request,
    poolId: route.overagePoolId,
    approvalId,
  });
  return overage.admitted
    ? {
        admitted: true,
        poolId: route.overagePoolId,
        approvalId,
        routed: true,
        reasonCodes: [],
      }
    : {
        admitted: false,
        poolId: null,
        approvalId: null,
        routed: true,
        reasonCodes: [...normal.reasonCodes, ...overage.reasonCodes],
      };
}

// ---------------------------------------------------------------------------
// 6. 手での精算と M 超過の確認（settleManually・reviewOverrun）

// 契約の BudgetManualSettlement.manual_reconciliation_id と同じ形。
export const MANUAL_RECONCILIATION_ID =
  /^manual:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface ManualSettlementInput {
  readonly expectedRevision: string;
  readonly manualReconciliationId: string;
  readonly currency: string;
  readonly actualGross: string;
}

// 不明な費用の手での精算（本人の判断 2026-10-23）。usage 不明の予約だけに、元の月・元の枠のまま一度だけ適用する。
// 同じ照合 ID・同じ実費の再適用は変化なし（duplicate）。それ以外の二度目の精算（provider の精算の後を含む）は拒否する。
// 予約の版は追加予約だけで上がる（ADR 0006）ので、精算では変えない。
export function settleManually(
  reservation: ReservationRecord,
  input: ManualSettlementInput,
):
  | {
      readonly ok: true;
      readonly reservation: ReservationRecord;
      readonly duplicate: boolean;
      readonly overrun: boolean;
    }
  | Failure {
  const reasons: string[] = [];
  if (!MANUAL_RECONCILIATION_ID.test(input.manualReconciliationId))
    reasons.push('manual_id_invalid');
  if (input.currency !== reservation.currency)
    reasons.push('currency_mismatch');
  const actual = toInteger(input.actualGross);
  if (actual === null || actual > BUDGET_AMOUNT_MAX)
    reasons.push('invalid_amount');
  if (reservation.revision !== input.expectedRevision)
    reasons.push('revision_conflict');
  if (reasons.length > 0) return { ok: false, reasonCodes: reasons };
  const overrun = (actual as bigint) > BigInt(reservation.maxLiability);
  if (reservation.status === 'settled') {
    const same =
      reservation.providerReconciliationId === input.manualReconciliationId &&
      reservation.actualGross === input.actualGross;
    return same
      ? { ok: true, reservation, duplicate: true, overrun }
      : { ok: false, reasonCodes: ['already_settled'] };
  }
  if (reservation.status === 'released')
    return { ok: false, reasonCodes: ['released'] };
  if (reservation.status !== 'usage_unknown')
    return { ok: false, reasonCodes: ['not_usage_unknown'] };
  return {
    ok: true,
    duplicate: false,
    overrun,
    reservation: {
      ...reservation,
      status: 'settled',
      actualGross: (actual as bigint).toString(),
      providerReconciliationId: input.manualReconciliationId,
    },
  };
}

export interface OverrunReviewInput {
  readonly expectedRevision: string;
  readonly currency: string;
  readonly actualGross: string;
  readonly maxLiability: string;
}

// M 超過の確認。本人が見た実費と M が記録と一致し、実費が M を超えるときだけ overrun_reviewed にする。
// 実費・月・枠は変えない（ADR 0034）。確認済みへの同じ確認は変化なし（duplicate）。
export function reviewOverrun(
  reservation: ReservationRecord,
  input: OverrunReviewInput,
):
  | {
      readonly ok: true;
      readonly reservation: ReservationRecord;
      readonly duplicate: boolean;
    }
  | Failure {
  if (reservation.revision !== input.expectedRevision)
    return { ok: false, reasonCodes: ['revision_conflict'] };
  if (reservation.status !== 'settled' || reservation.actualGross === null)
    return { ok: false, reasonCodes: ['not_settled'] };
  if (
    input.currency !== reservation.currency ||
    input.actualGross !== reservation.actualGross ||
    input.maxLiability !== reservation.maxLiability
  )
    return { ok: false, reasonCodes: ['review_mismatch'] };
  if (BigInt(reservation.actualGross) <= BigInt(reservation.maxLiability))
    return { ok: false, reasonCodes: ['no_overrun'] };
  if (reservation.overrunReviewed)
    return { ok: true, reservation, duplicate: true };
  return {
    ok: true,
    duplicate: false,
    reservation: { ...reservation, overrunReviewed: true },
  };
}
