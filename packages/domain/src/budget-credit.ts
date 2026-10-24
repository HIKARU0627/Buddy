// B07-07: 付帯クレジットの区分と保留の純粋な規則（設計 05 モデル再選定 A 案とクレジットの追補・09 MA03〜MA06、
// ADR 0006・0034・0042、本人の判断 2026-10-23）。
//
// 設計 05 の決め（設計担当判断）をそのまま規則にする。
// - 通常料金の利用額・付帯クレジットの消費・クレジット適用後の支出を分ける。上限（枠）は通常料金の R と M で守り、
//   クレジットがあるから費用 0 として無制限に実行しない。この区分は精算の記録で、枠の上限の判定には使わない。
// - クレジットの周期（請求周期）と Buddy の予算月は別に管理する。予算月が替わっても残高を戻さず、周期の終わり
//   （失効）は別に扱う。古い周期の未精算の要求を新しい周期へ付け替えない。
// - 残高が不明・失効・枯渇・古い（共有の組織）・M に足りないとき、クレジットを充てる profile（Claude）の処理を保留し、
//   購入残高・後払いへ自動で移らない。共有の組織の残高を Buddy が専有できるとは主張しない。
// - クレジットを充てるのは設定で指定した profile の LLM の要求だけ。音声・検索・他社の LLM には充てない（MA06）。
//   本文・応答の実料金が不明なものを 0 円と確定せず、クレジットを充てた扱いにもしない。
// - 残高を取得する公式の手段が決まるまで、非公開の API を推測して使わない。残高の観測は本人が書く（原本）。
// 金額は予算の通貨の百万分の一の整数文字列で受け、BigInt で計算する。個人の金額はコードに置かない。

import type { BudgetService } from './budget-gate.js';

// 契約の BudgetCreditConfig と同じ形（snake_case）。
export interface BudgetCreditConfigInput {
  readonly provider: string;
  readonly profile_ids: readonly string[];
  readonly balance_currency: string;
  readonly balance_to_budget_rate: string;
  readonly shared_observation_max_age_ms: number;
}

// 契約の CreditObservation と同じ形。
export interface CreditObservationInput {
  readonly provider: string;
  readonly organization_ref: string;
  readonly cycle_id: string;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly balance: {
    readonly currency: string;
    readonly amount: string;
  } | null;
  readonly status: 'observed' | 'unknown' | 'expired';
  readonly shared: boolean;
}

// 契約の BudgetCreditObservations と同じ形。
export interface BudgetCreditObservationsInput {
  readonly schema: string;
  readonly observations: readonly CreditObservationInput[];
}

// 契約の BudgetCreditHoldReason。
export type CreditHoldReason =
  'credit_unknown' | 'credit_expired' | 'credit_stale' | 'credit_exhausted';

// 受付の理由に出る保留（M に足りないときの credit_insufficient を含む）。
export type CreditAdmissionReason = CreditHoldReason | 'credit_insufficient';

const CREDIT_CYCLE_ID =
  /^([a-z][a-z0-9-]*):([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/u;
const MICRO = 1_000_000n;
// 契約の Amount の上限（18 桁）。budget-rules.ts の BUDGET_AMOUNT_MAX と同じ値（循環を避けて持つ）。
const AMOUNT_MAX = 999_999_999_999_999_999n;

// 周期の開始（UTC の日付の 0 時のミリ秒）。暦にない日付・1970 年より前は null。
export function creditCycleStart(cycleId: string): number | null {
  const match = CREDIT_CYCLE_ID.exec(cycleId);
  if (match === null) return null;
  const year = Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (year < 1970) return null;
  const value = Date.UTC(year, month - 1, day);
  const date = new Date(value);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : null;
}

const toMicros = (text: string): bigint | null => {
  if (!DECIMAL.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
};

// --- 設定と観測の意味検査（契約の semanticErrors と同じ理由コード・順序） ---

// 実行時の設定の credit の検査。budgetCurrency は予算の通貨。
export function creditConfigErrors(
  credit: BudgetCreditConfigInput,
  budgetCurrency: string,
): string[] {
  const errors: string[] = [];
  const rate = toMicros(credit.balance_to_budget_rate);
  if (rate === 0n) errors.push('credit_non_positive_rate');
  if (credit.balance_currency === budgetCurrency && rate !== MICRO)
    errors.push('credit_same_currency_rate');
  return errors;
}

// 残高の観測の一覧の検査。形（JSON Schema）の検査に通った値を渡す。空なら有効。
export function creditObservationsErrors(
  value: BudgetCreditObservationsInput,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of value.observations) {
    const observed = Date.parse(item.observed_at);
    const expires = Date.parse(item.expires_at);
    if (item.status === 'observed' && item.balance === null)
      errors.push('missing_observed_balance');
    if (item.status === 'observed' && observed >= expires)
      errors.push('expired_observation');
    if (item.status === 'unknown' && item.balance !== null)
      errors.push('unknown_with_balance');
    const start = creditCycleStart(item.cycle_id);
    if (start === null) errors.push('invalid_cycle_date');
    else {
      if (start > observed) errors.push('cycle_after_observation');
      if (expires <= start) errors.push('expiry_not_after_cycle');
    }
    if (item.cycle_id.split(':')[0] !== item.provider)
      errors.push('cycle_provider_mismatch');
    const key = `${item.cycle_id} ${observed}`;
    if (seen.has(key)) errors.push('duplicate_observation');
    seen.add(key);
  }
  return errors;
}

// --- 周期ごとの残高の基準 ---

// 周期ごとの最新の観測を、予算の通貨にした基準。残高は予算の通貨へ切り捨てて換算する（クレジットを多く見積もらない）。
export interface CreditBasis {
  readonly cycleId: string;
  // 周期の開始（UTC の日付の 0 時）・観測の時刻・周期の終わり（UTC のミリ秒）。
  readonly cycleStart: number;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly status: 'observed' | 'unknown' | 'expired';
  readonly shared: boolean;
  // 予算の通貨にした残高。status が observed のときだけ。
  readonly balance: string | null;
}

// 受付・精算を判定するときの、周期ごとの使用の台帳（DB の予約の行から数える）。
export interface CreditLedger {
  // 観測の時刻以後に精算した予約のクレジット（観測した残高にはまだ引かれていない分）。
  readonly allocatedSince: bigint;
  // 未精算（reserved・usage_unknown）の予約の最大負担 M の合計。精算するまで、クレジットで賄う分として確保し続ける
  // （usage 不明の M も解放しない）。
  readonly outstanding: bigint;
}

export interface CreditBasesInput {
  readonly config: BudgetCreditConfigInput;
  // 予算の通貨（残高をこの通貨へ換算する）。
  readonly budgetCurrency: string;
  readonly observations: readonly CreditObservationInput[];
  // 今の時刻（UTC のミリ秒）。今より後の観測は読まない。
  readonly now: number;
}

// 周期ごとに、今より前の最も新しい観測を基準にする。provider が違う観測は読まない。残高の通貨が設定と違う観測は、
// 残高として読まず「不明」にする（通貨を取り違えて換算しない）。current は周期の開始が最も新しい周期（なければ null）。
export function creditBasesOf(input: CreditBasesInput): {
  readonly bases: readonly CreditBasis[];
  readonly current: CreditBasis | null;
} {
  const rate = toMicros(input.config.balance_to_budget_rate) ?? 0n;
  const latest = new Map<
    string,
    { readonly item: CreditObservationInput; readonly observedAt: number }
  >();
  for (const item of input.observations) {
    if (item.provider !== input.config.provider) continue;
    const observedAt = Date.parse(item.observed_at);
    if (Number.isNaN(observedAt) || observedAt > input.now) continue;
    const known = latest.get(item.cycle_id);
    if (known === undefined || observedAt > known.observedAt)
      latest.set(item.cycle_id, { item, observedAt });
  }
  const bases: CreditBasis[] = [];
  for (const { item, observedAt } of latest.values()) {
    const cycleStart = creditCycleStart(item.cycle_id);
    const expiresAt = Date.parse(item.expires_at);
    if (cycleStart === null || Number.isNaN(expiresAt)) continue;
    let status = item.status;
    let balance: string | null = null;
    if (status === 'observed') {
      const amount = item.balance;
      if (
        amount === null ||
        amount.currency !== input.config.balance_currency ||
        !/^(0|[1-9][0-9]{0,17})$/u.test(amount.amount)
      )
        status = 'unknown';
      else {
        const converted = (BigInt(amount.amount) * rate) / MICRO;
        balance = (converted > AMOUNT_MAX ? AMOUNT_MAX : converted).toString();
      }
    }
    bases.push({
      cycleId: item.cycle_id,
      cycleStart,
      observedAt,
      expiresAt,
      status,
      shared: item.shared,
      balance,
    });
  }
  bases.sort((a, b) => b.cycleStart - a.cycleStart);
  return { bases, current: bases[0] ?? null };
}

// --- 誰にクレジットを充てるか（MA06） ---

// クレジットを充てる要求か。設定で指定した profile の LLM の要求だけ。音声・検索は profile が指定されていても充てない。
export function creditEligible(
  config: BudgetCreditConfigInput | null | undefined,
  service: BudgetService,
  profileId: string,
): boolean {
  return (
    config !== null &&
    config !== undefined &&
    service === 'llm' &&
    config.profile_ids.includes(profileId)
  );
}

// --- 受付（残高が不明・失効・枯渇・古い・足りないなら保留） ---

export interface CreditAvailabilityInput {
  readonly basis: CreditBasis | null;
  // basis の周期の台帳。basis がなければ null。
  readonly ledger: CreditLedger | null;
  readonly now: number;
  // 共有の組織の観測を古いとみなす長さ（ミリ秒）。
  readonly sharedMaxAgeMs: number;
}

// 観測と台帳から、残り（観測した残高 − 観測の後に精算した分 − 未精算の M。負になり得る）か、保留の理由を求める。
// 判定の順序: 観測なし → 周期の終わり・失効 → 不明 → 共有の観測が古い。台帳を読めなければ不明（閉じた側）。
// boundExpiresAt は、予約が受付で結び付けたクレジットの有効期限（受付の後の送出・追加予約で、観測が後から延びても
// 受付の時点の期限を過ぎたら失効とする）。受付では null。
function creditBalanceState(
  input: CreditAvailabilityInput & { readonly boundExpiresAt?: number | null },
):
  | { readonly ok: true; readonly remaining: bigint }
  | { readonly ok: false; readonly reason: CreditHoldReason } {
  const { basis, ledger } = input;
  if (basis === null) return { ok: false, reason: 'credit_unknown' };
  if (
    basis.status === 'expired' ||
    input.now >= basis.expiresAt ||
    (input.boundExpiresAt !== undefined &&
      input.boundExpiresAt !== null &&
      input.now >= input.boundExpiresAt)
  )
    return { ok: false, reason: 'credit_expired' };
  if (basis.status !== 'observed' || basis.balance === null)
    return { ok: false, reason: 'credit_unknown' };
  if (ledger === null) return { ok: false, reason: 'credit_unknown' };
  if (basis.shared && input.now - basis.observedAt > input.sharedMaxAgeMs)
    return { ok: false, reason: 'credit_stale' };
  return {
    ok: true,
    remaining:
      BigInt(basis.balance) - ledger.allocatedSince - ledger.outstanding,
  };
}

// 今、クレジットを充てて受け付けられる残り（予算の通貨）。保留の理由は MA05 の注入の種類に対応する。
// 残りが 0 以下なら枯渇。
export function creditAvailability(
  input: CreditAvailabilityInput,
):
  | { readonly ok: true; readonly available: bigint }
  | { readonly ok: false; readonly reason: CreditHoldReason } {
  const state = creditBalanceState(input);
  if (!state.ok) return state;
  if (state.remaining <= 0n) return { ok: false, reason: 'credit_exhausted' };
  return { ok: true, available: state.remaining };
}

// クレジットを充てる要求の受付。最大負担 M の全額を、残りで賄えるときだけ受け付ける（賄えない分が購入残高・後払い
// へ移らないように。同時の要求は、未精算の M を引いた残りで数える）。受け付けた予約は周期に結び付ける。
export function creditAdmission(
  input: CreditAvailabilityInput & { readonly maxLiability: bigint },
):
  | { readonly ok: true; readonly cycleId: string }
  | { readonly ok: false; readonly reason: CreditAdmissionReason } {
  const result = creditAvailability(input);
  if (!result.ok) return result;
  if (input.maxLiability > result.available)
    return { ok: false, reason: 'credit_insufficient' };
  return { ok: true, cycleId: (input.basis as CreditBasis).cycleId };
}

// 受け付けた予約の送出の直前の再検査。ledger はこの予約自身の M を未精算に含む。失効・不明・古い・残りが負（受付の後に
// 観測が減って、確保した分を賄えなくなった）なら送らず、購入残高・後払いへ移らない（ADR 0042）。受付の時点の期限
// （boundExpiresAt）も過ぎていないこと。
export function creditStillCovers(
  input: CreditAvailabilityInput & { readonly boundExpiresAt: number | null },
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CreditHoldReason } {
  const state = creditBalanceState(input);
  if (!state.ok) return state;
  if (state.remaining < 0n) return { ok: false, reason: 'credit_exhausted' };
  return { ok: true };
}

// 追加予約（受け付けた予約の M を増やす）の検査。ledger はこの予約自身の M を含むので、残りは追加の分だけを
// 賄えればよい。受付と同じ理由で拒否する。
export function creditTopUp(
  input: CreditAvailabilityInput & {
    readonly deltaMaxLiability: bigint;
    readonly boundExpiresAt: number | null;
  },
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CreditAdmissionReason } {
  const state = creditBalanceState(input);
  if (!state.ok) return state;
  if (input.deltaMaxLiability === 0n && state.remaining >= 0n)
    return { ok: true };
  if (state.remaining <= 0n) return { ok: false, reason: 'credit_exhausted' };
  if (input.deltaMaxLiability > state.remaining)
    return { ok: false, reason: 'credit_insufficient' };
  return { ok: true };
}

// --- 観測の採用（巻き戻りの拒否） ---

export type CreditAdoption =
  'adopt' | 'same' | 'conflict' | 'rollback' | 'cycle_regression';

export interface CreditAdoptionInput {
  // 採用しようとする観測の周期の開始・観測の時刻・内容の識別子（内容のハッシュ）。
  readonly cycleStart: number;
  readonly observedAt: number;
  readonly contentId: string;
  // 同じ周期・同じ観測の時刻で採用済みの観測（なければ null）。
  readonly sameTime: { readonly contentId: string } | null;
  // 同じ周期で採用済みの最も新しい観測の時刻（なければ null）。
  readonly latestObservedAtOfCycle: number | null;
  // 採用済みの周期の開始の最大（なければ null）。
  readonly maxCycleStart: number | null;
}

// 採用した観測を永続化し、巻き戻った観測を拒否する（ADR 0042）。同じ周期・同じ時刻で内容が同じなら変化なし（ファイルを
// 前の状態へ戻しても、採用済みの観測は残る）、内容が違えば矛盾（conflict）。周期の開始が採用済みより古い（cycle_regression）、
// 同じ周期の観測の時刻が採用済みより古い（rollback）なら拒否する。時計を戻しても、採用済みの観測は消えない。
export function creditAdoptionDecision(
  input: CreditAdoptionInput,
): CreditAdoption {
  if (input.sameTime !== null)
    return input.sameTime.contentId === input.contentId ? 'same' : 'conflict';
  if (input.maxCycleStart !== null && input.cycleStart < input.maxCycleStart)
    return 'cycle_regression';
  if (
    input.latestObservedAtOfCycle !== null &&
    input.observedAt < input.latestObservedAtOfCycle
  )
    return 'rollback';
  return 'adopt';
}

// --- 精算（通常料金を、クレジットと追加の支出へ一度だけ分ける） ---

export interface CreditAllocationInput {
  // 予約が受付時に結び付いた周期。なければ（クレジットを充てない予約）クレジット 0。
  readonly cycleId: string | null;
  readonly actualGross: bigint;
  readonly maxLiability: bigint;
  // 予約の周期の基準（今の周期とは限らない）。観測がなければ null。
  readonly basis: CreditBasis | null;
  // 予約の周期の台帳。この予約自身の M は outstanding に含めない。
  readonly ledger: CreditLedger | null;
  readonly now: number;
}

export interface CreditAllocation {
  readonly creditApplied: bigint;
  readonly additionalSpend: bigint;
  // 受付の残りから引く消費の見積もり（精算の区分とは別。ADR 0042）。周期に結び付いた予約（クレジットの対象の要求）は、
  // Buddy が割り当てた額（creditApplied）に関わらず min(実費, M) を見積もる。ほかの予約が残りを占めていて割り当てが 0 でも、
  // provider がクレジットから消費したかもしれないので、後の連番の観測が採用されるまで引き続ける（消費済みの残高を使い回さない）。
  // 周期に結び付かない予約だけ 0。
  readonly estimate: bigint;
}

// クレジットは、予約の周期の、確認できる残りの範囲で、実費と最大負担 M の小さい方まで充てる。
// - 確認できない（周期に結び付かない・観測がない・不明・失効・周期が終わった）ときは 0。別の周期の残高へ付け替えない。
//   追加の支出は「クレジットで賄えたと確認できない分」で、確認できない間は実費の全額になる（実費を多く見せる側。
//   請求の照合（B15）が確定する）。
// - M を超えた分は、ほかの未精算の予約が確保したクレジットを食わないよう、追加の支出にする。
// - 残りは、観測した残高から、観測の後に精算したクレジットと、ほかの予約の未精算の M を引いた値。
// この区分は精算の記録で、枠の上限の判定（実費の全額を数える）には使わない。
export function allocateCredit(input: CreditAllocationInput): CreditAllocation {
  const capped =
    input.maxLiability < input.actualGross
      ? input.maxLiability
      : input.actualGross;
  if (input.cycleId === null)
    return {
      creditApplied: 0n,
      additionalSpend: input.actualGross,
      estimate: 0n,
    };
  const unconfirmed: CreditAllocation = {
    creditApplied: 0n,
    additionalSpend: input.actualGross,
    estimate: capped,
  };
  const { basis, ledger } = input;
  if (
    basis === null ||
    ledger === null ||
    basis.cycleId !== input.cycleId ||
    basis.status !== 'observed' ||
    basis.balance === null ||
    input.now >= basis.expiresAt
  )
    return unconfirmed;
  const remaining =
    BigInt(basis.balance) - ledger.allocatedSince - ledger.outstanding;
  if (remaining <= 0n) return unconfirmed;
  let credit = input.actualGross;
  if (input.maxLiability < credit) credit = input.maxLiability;
  if (remaining < credit) credit = remaining;
  return {
    creditApplied: credit,
    additionalSpend: input.actualGross - credit,
    estimate: capped,
  };
}
