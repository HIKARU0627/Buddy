// 予算の受付・追加予約・精算・usage 不明・未送信の解放・M 超過の確認・手での精算・超過枠の承認・利用状況・予算月の
// 保存（設計 05 F02・D15、09 QA42・QA20・X18・X53、ADR 0006・0034・0035・0036、マイグレーション 0006）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、判定は domain の
// 純粋な規則（admitBudget・admitWithOverage・topUpReservation・settleReservation・markUsageUnknown・releaseUnsent・
// reviewOverrun・settleManually・summarizeUsage・advanceBudgetMonth）に任せる。最終の保証は 0006 の一意制約・CHECK・
// trigger に置く。provider への通信は transaction に入れない（H04。呼び出し側が transaction の外で行う）。
// - 受付は、transaction の中で予算月の状態・同じ月の行・M 超過の確認待ちの行・超過の承認を読み、domain の判定で
//   決めてから挿入する。同じ request_id の再要求は、同じ内容なら保存済みの予約を返し（worker が COMMIT の直後に
//   落ちた後の再送で二重に受け付けない）、違う内容なら request_conflict。
// - 追加予約は版の CAS（UPDATE … WHERE reservation_revision = 期待の版）。超過の承認で受け付けた予約は M に固定する。
// - 精算・手での精算は request_id と照合 ID の一意性で冪等にする（同じ値は duplicate、違う値は conflict）。provider の
//   照合 ID は provider の名前を前に付けて保存し、provider をまたいで一意にする。
// - 超過の承認は 1 回だけ使う（受付と同じ transaction で consumed にする）。同じ request_id の生きている承認は 1 つ。
// - 端末からの要求（承認の決定・M 超過の確認・手での精算）は、受付（command_receipts）を同じ transaction で書く。
// 結果の理由にはコードだけを入れ、SQL・金額の値を入れない。

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  BUDGET_AMOUNT_MAX,
  MANUAL_RECONCILIATION_ID,
  RETENTION_RULES,
  admitBudget,
  admitWithOverage,
  advanceBudgetMonth,
  allocateCredit,
  budgetMonthStart,
  creditAdmission,
  creditAdoptionDecision,
  creditBasesOf,
  creditCycleStart,
  creditStillCovers,
  creditTopUp,
  dispatchReasons,
  markUsageUnknown,
  releaseUnsent,
  reviewOverrun,
  settleManually,
  settleReservation,
  summarizeUsage,
  topUpReservation,
} from '@buddy/domain';
import type {
  AdmissionRequest,
  BudgetCreditConfigInput,
  CreditObservationInput,
  BudgetCalendarResult,
  BudgetCalendarState,
  BudgetOrigin,
  BudgetSettings,
  BudgetUsageSummaryView,
  CreditBasis,
  CreditLedger,
  OverageApprovalRecord,
  ReservationRecord,
} from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';

const RECEIPT_TTL_MS = RETENTION_RULES['command_receipt']?.ms ?? 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const AMOUNT = /^(0|[1-9][0-9]{0,17})$/u;
const REVISION = /^[1-9][0-9]{0,14}$/u;
// 契約の BudgetPoolId・ProfileId・PriceVersionId と同じ形（128 文字まで）。
const NAME = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const YEAR_MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/u;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;
// provider の名前（照合 ID の前に付ける）。manual は手での精算の印なので使わない。
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/u;
// 9999-12-31T23:59:59.999Z（予算月の暦年の上限、ADR 0035）。
const MAX_TIME = 253_402_300_799_999;
const BUDGET_ORIGINS: readonly BudgetOrigin[] = [
  'owner_request',
  'autonomous_analysis',
  'auto_execution',
  'initial_import',
  'shadow_mode',
];

// 0001 の行を移したときの profile の印（0006）。新しい受付では使わない。
export const LEGACY_PROFILE_ID = 'legacy:unrecorded';

// 端末の要求の受付（07 §3）。command_id は Core が接続範囲と request_id から決める値。
export interface BudgetRequestRef {
  readonly command_scope_id: string;
  readonly request_id: string;
  readonly request_hash: string;
  readonly command_id: string;
}

// 保存した予約。domain の ReservationRecord に、0006 で足した列を加えたもの。
export interface BudgetReservationValue extends ReservationRecord {
  // 受付の要求の枠（超過枠へ回したときの元の枠）と処理の起点。0001 から移した行の起点は null。
  readonly requestedPoolId: string;
  readonly origin: BudgetOrigin | null;
  readonly settlementKind: 'provider' | 'manual' | null;
  readonly settledAt: number | null;
  readonly overrunReviewedAt: number | null;
  readonly createdAt: number;
  // 送出意図の時刻（0007）。provider へ送る直前に記録する。記録した予約は解放しない。
  readonly dispatchIntentAt: number | null;
  // クレジットの受付の消費の見積もり（精算した予約。0008）。精算の区分（creditApplied）とは別で、台帳の残りから引く。
  readonly creditEstimate: string;
  // 受付で結び付けたクレジットの有効期限（UTC のミリ秒）と、採用した観測の番号（0008）。周期に結び付かない予約は null。
  readonly creditExpiresAt: number | null;
  readonly creditObservationSeq: number | null;
}

// 保存した超過の承認（契約の BudgetOverageApproval の形）と、使った予約。
export interface BudgetApprovalValue {
  readonly approval: OverageApprovalRecord;
  readonly consumed_reservation_id: string | null;
}

// 超過枠へ回す経路（domain の OverageRoute から起点・承認・時刻を除いたもの。起点は受付の命令に、承認は DB にある）。
export interface BudgetOverageRouteInput {
  readonly routable_pool_ids: readonly string[];
  readonly overage_pool_id: string;
}

// クレジットの入力（B07-07、ADR 0042）。設定の credit と、本人が書いた観測（ファイルの内容）。Core は観測を DB の
// transaction の中で採用し（巻き戻った観測を拒否し、採用済みの観測を永続化する）、採用済みの観測から周期ごとの基準と台帳を
// 求めて判定する。観測を判定の外で読んだ値に頼らない。
export interface BudgetCreditInput {
  readonly config: BudgetCreditConfigInput;
  // 予算の通貨（残高をこの通貨へ換算する）。
  readonly budget_currency: string;
  readonly observations: readonly CreditObservationInput[];
}

export type BudgetOp =
  // 受付。予算月の状態・同じ月の行・M 超過の確認待ち・承認を読み、domain の判定で決めてから挿入する。
  | {
      readonly kind: 'budget.admit';
      readonly reservation_id: string;
      readonly request_id: string;
      readonly profile_id: string;
      readonly pool_id: string;
      // 処理の起点（本人の依頼か、自発の処理か）。予約に保存し、送り直しの照合に使う。
      readonly origin: BudgetOrigin;
      readonly budget_month: string;
      readonly price_version: string;
      readonly currency: string;
      readonly reserved_amount: string;
      readonly max_liability: string;
      readonly settings: BudgetSettings;
      readonly overage: BudgetOverageRouteInput | null;
      // クレジットを充てる profile の LLM の要求だけ。残高が不明・失効・枯渇・古い・M に足りなければ受け付けず、
      // 受け付けた予約は今の周期・その有効期限・採用した観測に結び付ける。充てない要求は null（結び付けない）。
      // 省略は null（充てない）。
      readonly credit?: BudgetCreditInput | null;
      readonly now: number;
    }
  // 追加予約（版の CAS）。
  | {
      readonly kind: 'budget.top_up';
      readonly reservation_id: string;
      readonly expected_revision: string;
      readonly delta_reserved: string;
      readonly delta_max_liability: string;
      readonly settings: BudgetSettings;
      // 予算月の状態の検査に使う時刻（計上先は予約の元の月のまま）。
      readonly now: number;
      // 予約がクレジットの周期に結び付いているとき、追加の M も同じ transaction で検査する（観測・失効・古さ・残り）。
      // 結び付いているのに null・省略なら、確認できないので拒否する（credit_unknown）。
      readonly credit?: BudgetCreditInput | null;
    }
  // provider の usage による精算。照合 ID は provider の名前を前に付けて保存する。
  | {
      readonly kind: 'budget.settle';
      readonly reservation_id: string;
      readonly request_id: string;
      readonly provider: string;
      readonly provider_reconciliation_id: string;
      readonly actual_gross: string;
      // 予約が周期に結び付いているとき、その周期の台帳でクレジットを分ける。null ならクレジット 0・追加の支出＝実費。
      // 省略は null。
      readonly credit?: BudgetCreditInput | null;
      readonly now: number;
    }
  | { readonly kind: 'budget.mark_unknown'; readonly reservation_id: string }
  // provider へ送っていないことが記録上確実な場合だけ解放する。
  | {
      readonly kind: 'budget.release_unsent';
      readonly reservation_id: string;
      readonly provider_request_sent: boolean;
    }
  | {
      readonly kind: 'budget.review_overrun';
      readonly reservation_id: string;
      readonly expected_revision: string;
      readonly currency: string;
      readonly actual_gross: string;
      readonly max_liability: string;
      readonly now: number;
      readonly request: BudgetRequestRef | null;
    }
  | {
      readonly kind: 'budget.settle_manual';
      readonly reservation_id: string;
      readonly expected_revision: string;
      readonly manual_reconciliation_id: string;
      readonly currency: string;
      readonly actual_gross: string;
      // 本人が請求の照合で得た区分。クレジットは予約が受付時に結び付いた同じ周期にだけ充てられる。
      // 省略は初期の規則（クレジット 0・追加の支出＝実費・周期なし）。
      readonly credit_applied?: string;
      readonly additional_spend?: string;
      readonly credit_cycle_id?: string | null;
      readonly now: number;
      readonly request: BudgetRequestRef | null;
    }
  // 超過の承認を求める（pending の記録）。同じ request_id の生きている承認は 1 つ。
  | {
      readonly kind: 'budget.request_overage';
      readonly approval_id: string;
      readonly request_id: string;
      readonly pool_id: string;
      readonly budget_month: string;
      readonly currency: string;
      readonly max_liability: string;
      readonly overage_remaining: string;
      readonly now: number;
      readonly expires_at: number;
    }
  // 超過の承認・拒否（main の OS の確認ダイアログの結果）。二度押しでも承認は 1 件。
  | {
      readonly kind: 'budget.approve_overage';
      readonly approval_id: string;
      readonly budget_request_id: string;
      readonly currency: string;
      readonly max_liability: string;
      readonly decision: 'approve' | 'reject';
      readonly now: number;
      readonly request: BudgetRequestRef | null;
    }
  // 利用状況（今月は保存した予算月の状態から読む）。
  | {
      readonly kind: 'budget.summary';
      readonly settings: BudgetSettings;
      readonly config_valid: boolean;
      readonly now: number;
    }
  // 予算月を進める（初めての起動は記録を作る）。
  | {
      readonly kind: 'budget.calendar_advance';
      readonly now: number;
      readonly time_zone: string;
    }
  | { readonly kind: 'budget.calendar_read' }
  // 観測を採用して、今のクレジットの状態を返す（本人の観測のファイルを採用する書込み。巻き戻った観測は拒否する）。
  | {
      readonly kind: 'budget.credit_state';
      readonly credit: BudgetCreditInput;
      readonly now: number;
    }
  // 周期の台帳（書かない）。観測の時刻以後に精算したクレジットと、未精算の最大負担 M の合計（B07-07）。
  // exclude_reservation_id の予約の M は未精算に数えない（その予約を精算するとき）。
  | {
      readonly kind: 'budget.credit_ledger';
      readonly cycle_id: string;
      readonly since: number;
      readonly exclude_reservation_id: string | null;
    }
  // 予算月の状態の確認（書かない）。時計の戻り・tz データの食い違い・月を進めていないことを、今の月の
  // タイムゾーンで確かめる（予算保留の表示と、本人が確かめ直す前の表示に使う。0007）。
  | { readonly kind: 'budget.calendar_check'; readonly now: number }
  // 本人による予算月の確かめ直し（0007、ADR 0037）。本人が見た月と始まりが今の状態と一致するときだけ記録する。
  // invalid_calendar_state: 求め直した始まりを今の月の始まりにする。clock_regressed: 予算月を戻さずに今の月のまま
  // 受け付けを続け、今の時計を下限にする。
  | {
      readonly kind: 'budget.calendar_confirm';
      readonly confirmation_id: string;
      readonly reason: 'invalid_calendar_state' | 'clock_regressed';
      readonly month: string;
      readonly month_start: number;
      // 本人が見た状態の版（calendar_check の confirmation_revision）と、そのときの時計（checked_at）。古い入力の
      // 送り直しが、その後の新しい時計の戻りを承認しないように照合する（Codex のレビュー P2）。
      readonly expected_revision: string;
      readonly observed_at: number;
      readonly now: number;
    }
  // 送る直前の最終検査と送出意図の記録（08 §3 P01 の reservation_valid、0007）。予約が reserved で、まだ送出意図が
  // なく、安全停止していないときだけ記録する。記録できたときだけ provider へ一度送ってよい。
  | {
      readonly kind: 'budget.dispatch_intent';
      readonly reservation_id: string;
      readonly now: number;
      // 応答の期限（受付で M を計算した課金期間の終わり）。この時刻以降は送らない。
      readonly deadline: number;
      // 予約がクレジットの周期に結び付いているとき、送る直前にクレジットを確かめ直す（失効・不明・古い・枯渇なら送らない）。
      // 結び付いているのに null・省略なら、確認できないので送らない（credit_unknown）。
      readonly credit?: BudgetCreditInput | null;
    }
  // 精算していない受付中（reserved）の予約。再起動の照合に使う（X28 の仕組み）。
  | { readonly kind: 'budget.unsettled_list' }
  | {
      readonly kind: 'budget.reservation_find';
      readonly reservation_id: string | null;
      readonly request_id: string | null;
    }
  | { readonly kind: 'budget.approval_find'; readonly approval_id: string };

export type BudgetOpKind = BudgetOp['kind'];

export interface BudgetAdmitValue {
  readonly admitted: boolean;
  readonly reason_codes: readonly string[];
  readonly reservation: BudgetReservationValue | null;
  // 同じ request_id・同じ内容の受付が既にあり、新しく作らなかった。
  readonly duplicate: boolean;
  // 超過枠で受け付けた（承認を使った）。
  readonly routed: boolean;
}

export interface BudgetReservationChange {
  readonly reservation: BudgetReservationValue;
  // 変化なし（同じ値の再適用）。
  readonly duplicate: boolean;
}

export interface BudgetSettlementChange extends BudgetReservationChange {
  readonly overrun: boolean;
}

export interface BudgetCalendarValue {
  readonly state: BudgetCalendarState;
  readonly rolled_over: boolean;
  // 今回の命令で月の記録を足した。
  readonly recorded: boolean;
}

// 予算月の状態の確認の結果。state は今の月（確かめ直しを重ねたもの）。reasons が空なら受付できる。
export interface BudgetCalendarCheck {
  readonly state: BudgetCalendarState | null;
  readonly reasons: readonly string[];
  // 今の月のタイムゾーンで次の月の始まりを越えている（calendar_advance で進める）。
  readonly stale: boolean;
  // 予算月の記録（budget_months）の始まりと、tz データで求め直した始まり（本人が確かめ直すときに見せる）。
  readonly recorded_month_start: string | null;
  readonly recomputed_month_start: string | null;
  // 時計の戻りを受け入れた下限。なければ null。
  readonly regression_floor: string | null;
  // 今の月の確かめ直しの版（記録した確かめ直しの件数）。確かめ直しの要求はこの版を送る。
  readonly confirmation_revision: string | null;
}

export interface BudgetUnsettledItem {
  readonly reservation: BudgetReservationValue;
  // 会話の接続（live_sessions）を作った予約。送った可能性がある。
  readonly live_session: boolean;
}

export interface BudgetOpValues {
  'budget.admit': BudgetAdmitValue;
  'budget.top_up': BudgetReservationChange;
  'budget.settle': BudgetSettlementChange;
  'budget.mark_unknown': BudgetReservationChange;
  'budget.release_unsent': BudgetReservationChange;
  'budget.review_overrun': BudgetReservationChange & {
    readonly replayed: boolean;
  };
  'budget.settle_manual': BudgetSettlementChange & {
    readonly replayed: boolean;
  };
  'budget.request_overage': BudgetApprovalValue & {
    readonly duplicate: boolean;
  };
  'budget.approve_overage': BudgetApprovalValue & {
    readonly duplicate: boolean;
    readonly replayed: boolean;
  };
  'budget.summary': BudgetUsageSummaryView;
  'budget.calendar_advance': BudgetCalendarValue;
  'budget.calendar_read': BudgetCalendarState | null;
  'budget.credit_ledger': {
    readonly allocated_since: string;
    readonly outstanding: string;
  };
  'budget.credit_state': BudgetCreditState;
  'budget.calendar_check': BudgetCalendarCheck;
  'budget.calendar_confirm': BudgetCalendarCheck & {
    readonly confirmation_id: string;
  };
  'budget.dispatch_intent': BudgetReservationChange;
  'budget.unsettled_list': readonly BudgetUnsettledItem[];
  'budget.reservation_find': BudgetReservationValue | null;
  'budget.approval_find': BudgetApprovalValue | null;
}

export interface BudgetCreditState {
  // 採用済みの観測から求めた、周期ごとの基準（開始が新しい順）と今の周期。
  readonly bases: readonly CreditBasis[];
  readonly current: CreditBasis | null;
  // 拒否した観測の理由（credit_observation_rollback・credit_observation_conflict・credit_observation_cycle_regression）。
  readonly rejected: readonly string[];
  // 今の周期の台帳。観測がなければ null。
  readonly ledger: {
    readonly allocated_since: string;
    readonly outstanding: string;
  } | null;
}

export type BudgetOpValue = BudgetOpValues[BudgetOpKind];

export type BudgetOpResult =
  | { readonly ok: true; readonly value: BudgetOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface BudgetStoreResult {
  readonly result: BudgetOpResult;
  // 以後の書込みを止めるべき失敗（成否不明・想定外の失敗・耐久設定の不一致）。
  readonly halt: boolean;
}

export const BUDGET_WRITE_OPS: ReadonlySet<BudgetOpKind> = new Set([
  'budget.admit',
  'budget.top_up',
  'budget.settle',
  'budget.mark_unknown',
  'budget.release_unsent',
  'budget.review_overrun',
  'budget.settle_manual',
  'budget.request_overage',
  'budget.approve_overage',
  'budget.calendar_advance',
  'budget.calendar_confirm',
  'budget.dispatch_intent',
  'budget.credit_state',
]);

class BudgetRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'BudgetRejection';
    this.reasons = reasons;
  }
}

// --- 形の検査 ---

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
const isAmount = (value: unknown): value is string =>
  typeof value === 'string' && AMOUNT.test(value);
const isName = (value: unknown): value is string =>
  typeof value === 'string' && NAME.test(value);
const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && REVISION.test(value);
const isTime = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_TIME;
const isCurrency = (value: unknown): value is string =>
  typeof value === 'string' && CURRENCY.test(value);
const isMonth = (value: unknown): value is string =>
  typeof value === 'string' && YEAR_MONTH.test(value);

// provider の照合 ID。形は provider ごとに違うので、長さと制御文字・空白だけを見る。
function isReconciliationText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    ![...value].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 0x20 || code === 0x7f;
    })
  );
}

function settingsReasons(settings: BudgetSettings | undefined): string[] {
  if (
    typeof settings !== 'object' ||
    settings === null ||
    !isCurrency(settings.currency) ||
    !Array.isArray(settings.pools) ||
    settings.pools.length === 0 ||
    settings.pools.length > 64 ||
    !Array.isArray(settings.verifiedPriceVersions) ||
    !settings.verifiedPriceVersions.every(isName)
  )
    return ['settings_invalid'];
  const ids = new Set<string>();
  for (const pool of settings.pools) {
    if (
      typeof pool !== 'object' ||
      pool === null ||
      !isName(pool.poolId) ||
      ids.has(pool.poolId) ||
      !(pool.parentPoolId === null || isName(pool.parentPoolId)) ||
      !isAmount(pool.limit) ||
      typeof pool.requiresApproval !== 'boolean'
    )
      return ['settings_invalid'];
    ids.add(pool.poolId);
  }
  return [];
}

const CYCLE_ID = /^[a-z][a-z0-9-]*:[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const isCycleId = (value: unknown): value is string =>
  typeof value === 'string' && CYCLE_ID.test(value);

const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/u;

// 観測 1 件の形。時刻は Date で読めること。
function isObservation(value: unknown): value is CreditObservationInput {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  const balance = item['balance'];
  return (
    typeof item['provider'] === 'string' &&
    PROVIDER.test(item['provider']) &&
    typeof item['organization_ref'] === 'string' &&
    item['organization_ref'].length >= 1 &&
    item['organization_ref'].length <= 128 &&
    isCycleId(item['cycle_id']) &&
    typeof item['observed_at'] === 'string' &&
    !Number.isNaN(Date.parse(item['observed_at'])) &&
    typeof item['expires_at'] === 'string' &&
    !Number.isNaN(Date.parse(item['expires_at'])) &&
    (item['status'] === 'observed' ||
      item['status'] === 'unknown' ||
      item['status'] === 'expired') &&
    typeof item['shared'] === 'boolean' &&
    (balance === null ||
      (typeof balance === 'object' &&
        isCurrency((balance as Record<string, unknown>)['currency']) &&
        isAmount((balance as Record<string, unknown>)['amount']))) &&
    (item['status'] !== 'observed' || balance !== null)
  );
}

// クレジットの入力の形（設定・予算の通貨・観測の一覧）。観測は 120 件まで（契約の BudgetCreditObservations と同じ）。
function creditInputOk(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  const config = input['config'];
  if (typeof config !== 'object' || config === null) return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c['provider'] === 'string' &&
    PROVIDER.test(c['provider']) &&
    Array.isArray(c['profile_ids']) &&
    c['profile_ids'].every(isName) &&
    isCurrency(c['balance_currency']) &&
    typeof c['balance_to_budget_rate'] === 'string' &&
    DECIMAL.test(c['balance_to_budget_rate']) &&
    typeof c['shared_observation_max_age_ms'] === 'number' &&
    Number.isSafeInteger(c['shared_observation_max_age_ms']) &&
    c['shared_observation_max_age_ms'] >= 1 &&
    isCurrency(input['budget_currency']) &&
    Array.isArray(input['observations']) &&
    input['observations'].length <= 120 &&
    input['observations'].every(isObservation)
  );
}

function requestReasons(
  request: BudgetRequestRef | null | undefined,
): string[] {
  if (request === null) return [];
  if (
    typeof request !== 'object' ||
    !isUuid(request.command_scope_id) ||
    !isUuid(request.request_id) ||
    !isUuid(request.command_id) ||
    typeof request.request_hash !== 'string' ||
    !HASH.test(request.request_hash)
  )
    return ['request_invalid'];
  return [];
}

// 形の検査。structured clone を通った値を信用せず、DB に書く前に確かめる。
export function budgetOpShapeReasons(op: BudgetOp): string[] {
  const reasons: string[] = [];
  const check = (ok: boolean, reason: string): void => {
    if (!ok) reasons.push(reason);
  };
  switch (op.kind) {
    case 'budget.admit': {
      check(isUuid(op.reservation_id), 'reservation_id_invalid');
      check(isUuid(op.request_id), 'request_id_invalid');
      check(
        isName(op.profile_id) && !op.profile_id.startsWith('legacy:'),
        'profile_id_invalid',
      );
      check(isName(op.pool_id), 'pool_id_invalid');
      check(BUDGET_ORIGINS.includes(op.origin), 'origin_invalid');
      check(isMonth(op.budget_month), 'budget_month_invalid');
      check(isName(op.price_version), 'price_version_invalid');
      check(isCurrency(op.currency), 'currency_invalid');
      check(isAmount(op.reserved_amount), 'amount_invalid');
      check(isAmount(op.max_liability), 'amount_invalid');
      check(isTime(op.now), 'now_invalid');
      reasons.push(...settingsReasons(op.settings));
      check(creditInputOk(op.credit), 'credit_invalid');
      const route = op.overage;
      if (
        route !== null &&
        (typeof route !== 'object' ||
          !Array.isArray(route.routable_pool_ids) ||
          !route.routable_pool_ids.every(isName) ||
          !isName(route.overage_pool_id))
      )
        reasons.push('overage_route_invalid');
      break;
    }
    case 'budget.top_up':
      check(isUuid(op.reservation_id), 'reservation_id_invalid');
      check(isRevision(op.expected_revision), 'revision_invalid');
      check(isAmount(op.delta_reserved), 'amount_invalid');
      check(isAmount(op.delta_max_liability), 'amount_invalid');
      check(isTime(op.now), 'now_invalid');
      check(creditInputOk(op.credit), 'credit_invalid');
      reasons.push(...settingsReasons(op.settings));
      break;
    case 'budget.settle':
      check(isUuid(op.reservation_id), 'reservation_id_invalid');
      check(isUuid(op.request_id), 'request_id_invalid');
      check(
        typeof op.provider === 'string' &&
          PROVIDER.test(op.provider) &&
          op.provider !== 'manual',
        'provider_invalid',
      );
      check(
        isReconciliationText(op.provider_reconciliation_id),
        'reconciliation_id_invalid',
      );
      check(isAmount(op.actual_gross), 'amount_invalid');
      check(creditInputOk(op.credit), 'credit_invalid');
      check(isTime(op.now), 'now_invalid');
      break;
    case 'budget.mark_unknown':
      check(isUuid(op.reservation_id), 'reservation_id_invalid');
      break;
    case 'budget.release_unsent':
      check(isUuid(op.reservation_id), 'reservation_id_invalid');
      check(
        typeof op.provider_request_sent === 'boolean',
        'provider_request_sent_invalid',
      );
      break;
    case 'budget.review_overrun':
      check(isUuid(op.reservation_id), 'reservation_id_invalid');
      check(isRevision(op.expected_revision), 'revision_invalid');
      check(isCurrency(op.currency), 'currency_invalid');
      check(isAmount(op.actual_gross), 'amount_invalid');
      check(isAmount(op.max_liability), 'amount_invalid');
      check(isTime(op.now), 'now_invalid');
      reasons.push(...requestReasons(op.request));
      break;
    case 'budget.settle_manual':
      check(isUuid(op.reservation_id), 'reservation_id_invalid');
      check(isRevision(op.expected_revision), 'revision_invalid');
      check(
        typeof op.manual_reconciliation_id === 'string' &&
          MANUAL_RECONCILIATION_ID.test(op.manual_reconciliation_id),
        'manual_id_invalid',
      );
      check(isCurrency(op.currency), 'currency_invalid');
      check(isAmount(op.actual_gross), 'amount_invalid');
      check(
        op.credit_applied === undefined || isAmount(op.credit_applied),
        'amount_invalid',
      );
      check(
        op.additional_spend === undefined || isAmount(op.additional_spend),
        'amount_invalid',
      );
      check(
        op.credit_cycle_id === undefined ||
          op.credit_cycle_id === null ||
          isCycleId(op.credit_cycle_id),
        'credit_cycle_invalid',
      );
      check(isTime(op.now), 'now_invalid');
      reasons.push(...requestReasons(op.request));
      break;
    case 'budget.request_overage':
      check(isUuid(op.approval_id), 'approval_id_invalid');
      check(isUuid(op.request_id), 'request_id_invalid');
      check(isName(op.pool_id), 'pool_id_invalid');
      check(isMonth(op.budget_month), 'budget_month_invalid');
      check(isCurrency(op.currency), 'currency_invalid');
      check(isAmount(op.max_liability), 'amount_invalid');
      check(isAmount(op.overage_remaining), 'amount_invalid');
      check(isTime(op.now), 'now_invalid');
      check(
        isTime(op.expires_at) && isTime(op.now) && op.expires_at > op.now,
        'expires_at_invalid',
      );
      break;
    case 'budget.approve_overage':
      check(isUuid(op.approval_id), 'approval_id_invalid');
      check(isUuid(op.budget_request_id), 'request_id_invalid');
      check(isCurrency(op.currency), 'currency_invalid');
      check(isAmount(op.max_liability), 'amount_invalid');
      check(
        op.decision === 'approve' || op.decision === 'reject',
        'decision_invalid',
      );
      check(isTime(op.now), 'now_invalid');
      reasons.push(...requestReasons(op.request));
      break;
    case 'budget.summary':
      reasons.push(...settingsReasons(op.settings));
      check(typeof op.config_valid === 'boolean', 'config_valid_invalid');
      check(isTime(op.now), 'now_invalid');
      break;
    case 'budget.calendar_advance':
      check(isTime(op.now), 'now_invalid');
      check(
        typeof op.time_zone === 'string' &&
          op.time_zone.length <= 64 &&
          TIME_ZONE.test(op.time_zone),
        'time_zone_invalid',
      );
      break;
    case 'budget.calendar_read':
    case 'budget.unsettled_list':
      break;
    case 'budget.credit_state':
      check(
        typeof op.credit === 'object' &&
          op.credit !== null &&
          creditInputOk(op.credit),
        'credit_invalid',
      );
      check(isTime(op.now), 'now_invalid');
      break;
    case 'budget.credit_ledger':
      check(isCycleId(op.cycle_id), 'credit_cycle_invalid');
      check(isTime(op.since), 'now_invalid');
      check(
        op.exclude_reservation_id === null || isUuid(op.exclude_reservation_id),
        'reservation_id_invalid',
      );
      break;
    case 'budget.calendar_check':
      check(isTime(op.now), 'now_invalid');
      break;
    case 'budget.calendar_confirm':
      check(isUuid(op.confirmation_id), 'confirmation_id_invalid');
      check(
        op.reason === 'invalid_calendar_state' ||
          op.reason === 'clock_regressed',
        'confirmation_reason_invalid',
      );
      check(isMonth(op.month), 'budget_month_invalid');
      check(isTime(op.month_start), 'month_start_invalid');
      check(
        typeof op.expected_revision === 'string' &&
          /^(0|[1-9][0-9]{0,14})$/u.test(op.expected_revision),
        'revision_invalid',
      );
      check(isTime(op.observed_at), 'observed_at_invalid');
      check(isTime(op.now), 'now_invalid');
      break;
    case 'budget.dispatch_intent':
      check(isUuid(op.reservation_id), 'reservation_id_invalid');
      check(isTime(op.now), 'now_invalid');
      check(isTime(op.deadline), 'deadline_invalid');
      check(creditInputOk(op.credit), 'credit_invalid');
      break;
    case 'budget.reservation_find':
      check(
        (op.reservation_id === null) !== (op.request_id === null) &&
          (op.reservation_id === null || isUuid(op.reservation_id)) &&
          (op.request_id === null || isUuid(op.request_id)),
        'find_key_invalid',
      );
      break;
    case 'budget.approval_find':
      check(isUuid(op.approval_id), 'approval_id_invalid');
      break;
    default:
      reasons.push('kind_invalid');
  }
  return [...new Set(reasons)];
}

// --- 読み取り ---

const RESERVATION_COLUMNS =
  'reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, approval_id, actual_gross, provider_reconciliation_id, settlement_kind, settled_at, overrun_reviewed, overrun_reviewed_at, created_at, dispatch_intent_at, credit_applied, additional_spend, credit_cycle_id, credit_estimate, credit_expires_at, credit_observation_seq';

interface ReservationRow {
  reservation_id: string;
  request_id: string;
  profile_id: string;
  pool_id: string;
  requested_pool_id: string;
  origin: BudgetOrigin | null;
  budget_month: string;
  currency: string;
  price_version: string;
  reserved_amount: bigint;
  max_liability: bigint;
  status: ReservationRecord['status'];
  reservation_revision: bigint;
  approval_id: string | null;
  actual_gross: bigint | null;
  provider_reconciliation_id: string | null;
  settlement_kind: 'provider' | 'manual' | null;
  settled_at: bigint | null;
  overrun_reviewed: bigint;
  overrun_reviewed_at: bigint | null;
  created_at: bigint;
  dispatch_intent_at: bigint | null;
  credit_applied: bigint | null;
  additional_spend: bigint | null;
  credit_cycle_id: string | null;
  credit_estimate: bigint;
  credit_expires_at: bigint | null;
  credit_observation_seq: bigint | null;
}

const timeOrNull = (value: bigint | null): number | null =>
  value === null ? null : Number(value);

function toReservation(row: ReservationRow): BudgetReservationValue {
  return {
    reservationId: row.reservation_id,
    requestId: row.request_id,
    profileId: row.profile_id,
    priceVersion: row.price_version,
    poolId: row.pool_id,
    budgetMonth: row.budget_month,
    currency: row.currency,
    reserved: row.reserved_amount.toString(),
    maxLiability: row.max_liability.toString(),
    status: row.status,
    actualGross: row.actual_gross === null ? null : row.actual_gross.toString(),
    providerReconciliationId: row.provider_reconciliation_id,
    approvalId: row.approval_id,
    revision: row.reservation_revision.toString(),
    overrunReviewed: row.overrun_reviewed === 1n,
    settlementKind: row.settlement_kind,
    settledAt: timeOrNull(row.settled_at),
    overrunReviewedAt: timeOrNull(row.overrun_reviewed_at),
    createdAt: Number(row.created_at),
    requestedPoolId: row.requested_pool_id,
    origin: row.origin,
    dispatchIntentAt: timeOrNull(row.dispatch_intent_at),
    creditApplied:
      row.credit_applied === null ? null : row.credit_applied.toString(),
    additionalSpend:
      row.additional_spend === null ? null : row.additional_spend.toString(),
    creditCycleId: row.credit_cycle_id,
    creditEstimate: row.credit_estimate.toString(),
    creditExpiresAt: timeOrNull(row.credit_expires_at),
    creditObservationSeq: timeOrNull(row.credit_observation_seq),
  };
}

// 金額は 18 桁まであり、JavaScript の数値（2^53）を超え得るので BigInt で読む。
function selectReservations(
  db: SqliteDatabase,
  where: string,
  ...params: unknown[]
): BudgetReservationValue[] {
  const rows = db
    .prepare(`SELECT ${RESERVATION_COLUMNS} FROM budget_reservations ${where}`)
    .safeIntegers(true)
    .all(...params) as ReservationRow[];
  return rows.map(toReservation);
}

function findReservation(
  db: SqliteDatabase,
  reservationId: string,
): BudgetReservationValue | null {
  return (
    selectReservations(db, 'WHERE reservation_id = ?', reservationId)[0] ?? null
  );
}

function requireReservation(
  db: SqliteDatabase,
  reservationId: string,
): BudgetReservationValue {
  const reservation = findReservation(db, reservationId);
  if (reservation === null) throw new BudgetRejection(['unknown_reservation']);
  return reservation;
}

// 受付・追加予約の検査に使う行: その月の行と、月を問わず M 超過の確認待ちの行（ADR 0006 の overrun_hold）。
function admissionRows(
  db: SqliteDatabase,
  month: string,
): BudgetReservationValue[] {
  return selectReservations(
    db,
    "WHERE budget_month = ? OR (status = 'settled' AND overrun_reviewed = 0 AND actual_gross > max_liability) ORDER BY created_at, reservation_id",
    month,
  );
}

// 周期の台帳（B07-07）。その周期に結び付いた予約から、観測の時刻以後に精算したクレジットと、未精算の最大負担 M の
// 合計を数える。金額は 18 桁まであるので BigInt で足す（SQL の SUM を使わない）。観測した残高にはその時刻までの使用が
// 入っているので、観測より前に精算した分は数えない。観測より前の受付で、まだ精算していない予約の M は数える
// （残りを少なく見積もる側）。クレジットを充てない予約（周期に結び付かない）は数えない。
function creditLedger(
  db: SqliteDatabase,
  cycleId: string,
  since: number,
  excludeReservationId: string | null,
): CreditLedger {
  const rows = db
    .prepare(
      'SELECT reservation_id, status, max_liability, credit_estimate, settled_at FROM budget_reservations WHERE credit_cycle_id = ?',
    )
    .safeIntegers(true)
    .all(cycleId) as {
    reservation_id: string;
    status: ReservationRecord['status'];
    max_liability: bigint;
    credit_estimate: bigint;
    settled_at: bigint | null;
  }[];
  let allocatedSince = 0n;
  let outstanding = 0n;
  for (const row of rows) {
    if (row.status === 'settled') {
      // 精算の区分（credit_applied）ではなく、受付の消費の見積もり（credit_estimate）を引く。観測がなくてクレジット 0 で
      // 記録した精算も、provider が消費したかもしれない分を、新しい観測が届くまで引き続ける（ADR 0042）。
      if (row.settled_at !== null && row.settled_at >= BigInt(since))
        allocatedSince += row.credit_estimate;
    } else if (
      (row.status === 'reserved' || row.status === 'usage_unknown') &&
      row.reservation_id !== excludeReservationId
    )
      outstanding += row.max_liability;
  }
  return { allocatedSince, outstanding };
}

// --- 残高の観測の採用（0008） ---

interface ObservationRow {
  observation_seq: bigint;
  cycle_id: string;
  cycle_start: bigint;
  observed_at: bigint;
  expires_at: bigint;
  status: 'observed' | 'unknown' | 'expired';
  shared: bigint;
  organization_ref: string;
  balance_currency: string | null;
  balance_amount: bigint | null;
  content_id: string;
}

// 観測の内容の識別子（採用した観測と、ファイルの観測が同じ内容かを比べる）。
function observationContentId(item: CreditObservationInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        item.provider,
        item.organization_ref,
        item.cycle_id,
        Date.parse(item.observed_at),
        Date.parse(item.expires_at),
        item.balance === null
          ? null
          : [item.balance.currency, item.balance.amount],
        item.status,
        item.shared,
      ]),
    )
    .digest('hex');
}

// 本人が書いた観測を採用する。今より後の観測は採用しない（時刻が来たら採用する）。採用済みの観測は永続化され、巻き戻った
// 観測（同じ周期で古い時刻・古い周期）と、同じ時刻で内容の違う観測は拒否する（ファイルを古い状態へ戻しても、時計を戻しても、
// 採用済みの観測は変わらない）。拒否した理由のコードを返す。
function adoptObservations(
  db: SqliteDatabase,
  credit: BudgetCreditInput,
  now: number,
): string[] {
  const rejected = new Set<string>();
  const candidates = credit.observations
    .map((item) => ({
      item,
      observedAt: Date.parse(item.observed_at),
      expiresAt: Date.parse(item.expires_at),
      cycleStart: creditCycleStart(item.cycle_id),
      contentId: observationContentId(item),
    }))
    .filter(
      (candidate) =>
        candidate.item.provider === credit.config.provider &&
        candidate.cycleStart !== null &&
        candidate.observedAt <= now,
    )
    .sort(
      (a, b) =>
        a.observedAt - b.observedAt || (a.contentId < b.contentId ? -1 : 1),
    );
  for (const candidate of candidates) {
    const cycleStart = candidate.cycleStart as number;
    const sameTime = db
      .prepare(
        'SELECT content_id FROM budget_credit_observations WHERE cycle_id = ? AND observed_at = ?',
      )
      .get(candidate.item.cycle_id, candidate.observedAt) as
      { content_id: string } | undefined;
    const latest = db
      .prepare(
        'SELECT max(observed_at) FROM budget_credit_observations WHERE cycle_id = ?',
      )
      .pluck()
      .safeIntegers(false)
      .get(candidate.item.cycle_id) as number | null;
    const maxCycle = db
      .prepare('SELECT max(cycle_start) FROM budget_credit_observations')
      .pluck()
      .get() as number | null;
    const decision = creditAdoptionDecision({
      cycleStart,
      observedAt: candidate.observedAt,
      contentId: candidate.contentId,
      sameTime:
        sameTime === undefined ? null : { contentId: sameTime.content_id },
      latestObservedAtOfCycle: latest,
      maxCycleStart: maxCycle,
    });
    if (decision === 'adopt') {
      const balance = candidate.item.balance;
      db.prepare(
        'INSERT INTO budget_credit_observations (cycle_id, cycle_start, observed_at, expires_at, status, shared, organization_ref, balance_currency, balance_amount, content_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        candidate.item.cycle_id,
        cycleStart,
        candidate.observedAt,
        candidate.expiresAt,
        candidate.item.status,
        candidate.item.shared ? 1 : 0,
        candidate.item.organization_ref,
        balance === null ? null : balance.currency,
        balance === null ? null : BigInt(balance.amount),
        candidate.contentId,
        now,
      );
    } else if (decision !== 'same')
      rejected.add(`credit_observation_${decision}`);
  }
  return [...rejected];
}

interface ResolvedCredit extends BudgetCreditState {
  // 周期ごとの、基準にした観測の番号。
  readonly seqOf: ReadonlyMap<string, number>;
}

// 観測を採用してから、採用済みの観測（周期ごとに最も新しいもの）から周期ごとの基準を求める。採用済みの観測は時計を戻しても
// 消えないので、今より後の観測でも基準にする。
function resolveCredit(
  db: SqliteDatabase,
  credit: BudgetCreditInput,
  now: number,
): ResolvedCredit {
  const rejected = adoptObservations(db, credit, now);
  const rows = db
    .prepare(
      'SELECT o.* FROM budget_credit_observations o WHERE o.observed_at = (SELECT max(observed_at) FROM budget_credit_observations WHERE cycle_id = o.cycle_id)',
    )
    .safeIntegers(true)
    .all() as ObservationRow[];
  const observations: CreditObservationInput[] = rows.map((row) => ({
    provider: row.cycle_id.split(':')[0] ?? '',
    organization_ref: row.organization_ref,
    cycle_id: row.cycle_id,
    observed_at: iso(row.observed_at),
    expires_at: iso(row.expires_at),
    balance:
      row.balance_currency === null || row.balance_amount === null
        ? null
        : {
            currency: row.balance_currency,
            amount: row.balance_amount.toString(),
          },
    status: row.status,
    shared: row.shared === 1n,
  }));
  const seqOf = new Map(
    rows.map((row) => [row.cycle_id, Number(row.observation_seq)]),
  );
  const { bases, current } = creditBasesOf({
    config: credit.config,
    budgetCurrency: credit.budget_currency,
    observations,
    now: MAX_TIME,
  });
  const ledger =
    current === null
      ? null
      : (() => {
          const value = creditLedger(
            db,
            current.cycleId,
            current.observedAt,
            null,
          );
          return {
            allocated_since: value.allocatedSince.toString(),
            outstanding: value.outstanding.toString(),
          };
        })();
  return { bases, current, rejected, ledger, seqOf };
}

// 予約が結び付いた周期の基準（採用済みの観測から）と、その台帳（この予約自身の M を未精算に含む）。
function reservationCredit(
  db: SqliteDatabase,
  reservation: BudgetReservationValue,
  resolved: ResolvedCredit,
):
  | {
      readonly basis: CreditBasis;
      readonly ledger: CreditLedger;
    }
  | { readonly basis: null; readonly ledger: null } {
  const basis =
    resolved.bases.find((item) => item.cycleId === reservation.creditCycleId) ??
    null;
  if (basis === null) return { basis: null, ledger: null };
  return {
    basis,
    ledger: creditLedger(db, basis.cycleId, basis.observedAt, null),
  };
}

interface ApprovalRow {
  approval_id: string;
  request_id: string;
  pool_id: string;
  budget_month: string;
  currency: string;
  max_liability: bigint;
  overage_remaining: bigint;
  status: OverageApprovalRecord['status'];
  requested_at: bigint;
  expires_at: bigint;
  decided_at: bigint | null;
  consumed_reservation_id: string | null;
}

const iso = (millis: bigint | number): string =>
  new Date(Number(millis)).toISOString();

function toApproval(row: ApprovalRow): BudgetApprovalValue {
  return {
    approval: {
      approval_id: row.approval_id,
      request_id: row.request_id,
      pool_id: row.pool_id,
      budget_month: row.budget_month,
      max_liability: {
        currency: row.currency,
        amount: row.max_liability.toString(),
      },
      overage_remaining: {
        currency: row.currency,
        amount: row.overage_remaining.toString(),
      },
      status: row.status,
      requested_at: iso(row.requested_at),
      expires_at: iso(row.expires_at),
      decided_at: row.decided_at === null ? null : iso(row.decided_at),
    },
    consumed_reservation_id: row.consumed_reservation_id,
  };
}

function selectApprovals(
  db: SqliteDatabase,
  where: string,
  ...params: unknown[]
): ApprovalRow[] {
  return db
    .prepare(
      `SELECT approval_id, request_id, pool_id, budget_month, currency, max_liability, overage_remaining, status, requested_at, expires_at, decided_at, consumed_reservation_id FROM budget_overage_approvals ${where}`,
    )
    .safeIntegers(true)
    .all(...params) as ApprovalRow[];
}

function readCalendar(db: SqliteDatabase): BudgetCalendarState | null {
  const row = db
    .prepare(
      'SELECT month, time_zone, month_start, month_start_time_zone FROM budget_months ORDER BY month DESC LIMIT 1',
    )
    .get() as
    | {
        month: string;
        time_zone: string;
        month_start: number;
        month_start_time_zone: string;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    month: row.month,
    timeZone: row.time_zone,
    monthStart: iso(row.month_start),
    monthStartTimeZone: row.month_start_time_zone,
  };
}

// 今の月の状態（0007）。最も新しい月の行に、同じ月の最も新しい確かめ直し（本人が確かめた始まりと時計の戻りの
// 下限）を重ねる。記録の始まり（budget_months.month_start）は書き換えない。
interface EffectiveCalendar {
  readonly state: BudgetCalendarState;
  readonly recordedStart: string;
  readonly floor: number | null;
}

function readEffectiveCalendar(db: SqliteDatabase): EffectiveCalendar | null {
  const base = readCalendar(db);
  if (base === null) return null;
  const row = db
    .prepare(
      'SELECT month_start, regression_floor FROM budget_month_confirmations WHERE month = ? ORDER BY rowid DESC LIMIT 1',
    )
    .get(base.month) as
    { month_start: number; regression_floor: number | null } | undefined;
  if (row === undefined)
    return { state: base, recordedStart: base.monthStart, floor: null };
  return {
    state: { ...base, monthStart: iso(row.month_start) },
    recordedStart: base.monthStart,
    floor: row.regression_floor,
  };
}

// advanceBudgetMonth に、本人が受け入れた時計の戻り（下限以上で、今の月の始まりより前）を重ねる。受け入れた
// 間は予算月を戻さず、今の月のまま受け付ける（下限よりさらに戻れば clock_regressed のまま）。
function evaluateCalendar(
  effective: EffectiveCalendar,
  now: number,
  timeZone: string,
): BudgetCalendarResult {
  const result = advanceBudgetMonth(effective.state, iso(now), timeZone);
  if (
    !result.ok &&
    result.reasonCodes.length === 1 &&
    result.reasonCodes[0] === 'clock_regressed' &&
    effective.floor !== null &&
    now >= effective.floor
  )
    return { ok: true, rolledOver: false, state: effective.state };
  return result;
}

// 今の予算月。保存した状態を今の月のタイムゾーンで確かめ、次の月の始まりを越えていれば calendar_stale
// （先に calendar_advance で進める）。tz データの更新などで保存した始まりと求め直した始まりが食い違えば
// invalid_calendar_state（記録は書き換えず、有料の受付を止める。ADR 0036）。時計の戻りは clock_regressed。
// 本人が確かめ直した値（0007）を重ねて判定する。
function currentMonth(db: SqliteDatabase, now: number): BudgetCalendarState {
  const effective = readEffectiveCalendar(db);
  if (effective === null)
    throw new BudgetRejection(['calendar_not_initialized']);
  const checked = evaluateCalendar(effective, now, effective.state.timeZone);
  if (!checked.ok) throw new BudgetRejection(checked.reasonCodes);
  if (checked.rolledOver) throw new BudgetRejection(['calendar_stale']);
  return effective.state;
}

function checkCalendar(db: SqliteDatabase, now: number): BudgetCalendarCheck {
  const effective = readEffectiveCalendar(db);
  if (effective === null)
    return {
      state: null,
      reasons: ['calendar_not_initialized'],
      stale: false,
      recorded_month_start: null,
      recomputed_month_start: null,
      regression_floor: null,
      confirmation_revision: null,
    };
  const checked = evaluateCalendar(effective, now, effective.state.timeZone);
  return {
    state: effective.state,
    reasons: checked.ok ? [] : checked.reasonCodes,
    stale: checked.ok && checked.rolledOver,
    recorded_month_start: effective.recordedStart,
    recomputed_month_start: budgetMonthStart(
      effective.state.month,
      effective.state.monthStartTimeZone,
    ),
    regression_floor: effective.floor === null ? null : iso(effective.floor),
    confirmation_revision: confirmationRevision(db, effective.state.month),
  };
}

// 今の月の確かめ直しの版（記録した件数）。記録は消さないので、確かめ直すたびに 1 つ増える。
function confirmationRevision(db: SqliteDatabase, month: string): string {
  return String(
    db
      .prepare(
        'SELECT count(*) FROM budget_month_confirmations WHERE month = ?',
      )
      .pluck()
      .get(month) as number,
  );
}

// --- 端末の要求の受付（command_receipts） ---

interface ReceiptRow {
  request_hash: string;
  command_id: string;
  target_id: string;
}

// 同じ接続範囲・request_id の受付があれば true（照合値・命令 ID・対象が違えば request_conflict）。
function replayed(
  db: SqliteDatabase,
  request: BudgetRequestRef | null,
  targetId: string,
): boolean {
  if (request === null) return false;
  const byRequest = db
    .prepare(
      'SELECT request_hash, command_id, target_id FROM command_receipts WHERE command_scope_id = ? AND request_id = ?',
    )
    .get(request.command_scope_id, request.request_id) as
    ReceiptRow | undefined;
  if (byRequest !== undefined) {
    if (
      byRequest.request_hash !== request.request_hash ||
      byRequest.command_id !== request.command_id ||
      byRequest.target_id !== targetId
    )
      throw new BudgetRejection(['request_conflict']);
    return true;
  }
  if (
    db
      .prepare('SELECT 1 FROM command_receipts WHERE command_id = ?')
      .get(request.command_id) !== undefined
  )
    throw new BudgetRejection(['request_conflict']);
  return false;
}

function writeReceipt(
  db: SqliteDatabase,
  request: BudgetRequestRef | null,
  targetId: string,
  committed: string,
  now: number,
): void {
  if (request === null) return;
  db.prepare(
    "INSERT INTO command_receipts (command_scope_id, request_id, request_hash, command_id, target_id, status, committed_state_revision, created_at, delete_at) VALUES (?, ?, ?, ?, ?, 'durable', ?, ?, ?)",
  ).run(
    request.command_scope_id,
    request.request_id,
    request.request_hash,
    request.command_id,
    targetId,
    Number(committed),
    now,
    now + RECEIPT_TTL_MS,
  );
}

// --- 書込み ---

function settledUpdate(
  db: SqliteDatabase,
  reservationId: string,
  actualGross: string,
  creditApplied: string,
  additionalSpend: string,
  creditEstimate: string,
  reconciliationId: string,
  kind: 'provider' | 'manual',
  now: number,
): void {
  // 実費をクレジットと追加の支出に分けて記録する（B07-07。実費 = クレジット + 追加の支出は DB の CHECK が守る）。
  // 周期（credit_cycle_id）は受付時に結び付けた値のまま変えない。
  const updated = db
    .prepare(
      "UPDATE budget_reservations SET status = 'settled', actual_gross = ?, credit_applied = ?, additional_spend = ?, credit_estimate = ?, provider_reconciliation_id = ?, settlement_kind = ?, settled_at = ? WHERE reservation_id = ? AND status IN ('reserved', 'usage_unknown')",
    )
    .run(
      BigInt(actualGross),
      BigInt(creditApplied),
      BigInt(additionalSpend),
      BigInt(creditEstimate),
      reconciliationId,
      kind,
      now,
      reservationId,
    );
  if (updated.changes !== 1) throw new BudgetRejection(['not_settleable']);
}

// 照合 ID が別の予約に使われていれば拒否する（同じ ID で二つの予約を精算しない。一意制約が最終の保証）。
function requireReconciliationFree(
  db: SqliteDatabase,
  reconciliationId: string,
  reservationId: string,
): void {
  const used = db
    .prepare(
      'SELECT reservation_id FROM budget_reservations WHERE provider_reconciliation_id = ?',
    )
    .get(reconciliationId) as { reservation_id: string } | undefined;
  if (used !== undefined && used.reservation_id !== reservationId)
    throw new BudgetRejection(['reconciliation_id_used']);
}

// 同じ受付の送り直しか。要求した枠と起点は保存した値と完全に一致し、計上した枠は要求した枠か、超過枠へ回したなら
// 送り直しの経路の超過枠（B07-03 の Codex のレビュー P2: 計上先だけを比べると、元の枠や起点を変えた送り直しを
// 見逃す）。追加予約の後は R と M が変わるので、最初の受付の送り直しは request_conflict になる（呼び出し側は
// reservation_find で予約を読む）。
function sameAdmission(
  existing: BudgetReservationValue,
  op: Extract<BudgetOp, { kind: 'budget.admit' }>,
): boolean {
  const pools = [op.pool_id];
  if (op.overage !== null) pools.push(op.overage.overage_pool_id);
  return (
    existing.requestedPoolId === op.pool_id &&
    existing.origin === op.origin &&
    existing.profileId === op.profile_id &&
    existing.priceVersion === op.price_version &&
    existing.currency === op.currency &&
    existing.budgetMonth === op.budget_month &&
    pools.includes(existing.poolId) &&
    existing.reserved === op.reserved_amount &&
    existing.maxLiability === op.max_liability
  );
}

function admit(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.admit' }>,
): BudgetAdmitValue {
  // 同じ request_id の再要求（COMMIT の直後に worker が落ちた後の再送を含む）。同じ内容なら保存済みの予約を返す。
  const existing =
    selectReservations(db, 'WHERE request_id = ?', op.request_id)[0] ?? null;
  if (existing !== null) {
    if (!sameAdmission(existing, op))
      throw new BudgetRejection(['request_conflict']);
    const active = existing.status === 'reserved';
    return {
      admitted: active,
      reason_codes: active ? [] : ['duplicate_request'],
      reservation: existing,
      duplicate: true,
      routed: existing.approvalId !== null,
    };
  }
  const month = currentMonth(db, op.now);
  if (month.month !== op.budget_month)
    throw new BudgetRejection(['budget_month_not_current']);
  const rows = admissionRows(db, op.budget_month);
  // クレジットを充てる要求は、枠の上限の検査と別に、クレジットの残りで M の全額を賄えるときだけ受け付ける
  // （残高が不明・失効・枯渇・古い・足りないなら保留。賄えない分が購入残高・後払いへ移らないように）。
  let creditCycleId: string | null = null;
  let creditReasons: string[] = [];
  let creditExpiresAt: number | null = null;
  let creditSeq: number | null = null;
  if (op.credit !== undefined && op.credit !== null) {
    const resolved = resolveCredit(db, op.credit, op.now);
    const basis = resolved.current;
    const credit = creditAdmission({
      basis,
      ledger:
        basis === null
          ? null
          : creditLedger(db, basis.cycleId, basis.observedAt, null),
      now: op.now,
      sharedMaxAgeMs: op.credit.config.shared_observation_max_age_ms,
      maxLiability: BigInt(op.max_liability),
    });
    if (credit.ok && basis !== null) {
      creditCycleId = credit.cycleId;
      creditExpiresAt = basis.expiresAt;
      creditSeq = resolved.seqOf.get(basis.cycleId) ?? null;
    } else if (!credit.ok) creditReasons = [credit.reason];
  }
  const request: AdmissionRequest = {
    requestId: op.request_id,
    profileId: op.profile_id,
    poolId: op.pool_id,
    budgetMonth: op.budget_month,
    priceVersion: op.price_version,
    currency: op.currency,
    reserved: op.reserved_amount,
    maxLiability: op.max_liability,
    approvalId: null,
  };
  let poolId: string;
  let approvalId: string | null = null;
  let routed = false;
  if (op.overage === null) {
    const decision = admitBudget(op.settings, rows, request);
    if (!decision.admitted || creditReasons.length > 0)
      return {
        admitted: false,
        reason_codes: [...decision.reasonCodes, ...creditReasons],
        reservation: null,
        duplicate: false,
        routed: false,
      };
    poolId = op.pool_id;
  } else {
    // 同じ request_id の生きている承認（一意の索引で 1 つまで）。照合（request_id・M・枠・月・期限・状態）は domain。
    const approvalRow =
      selectApprovals(
        db,
        "WHERE request_id = ? AND status IN ('pending', 'approved', 'consumed')",
        op.request_id,
      )[0] ?? null;
    const decision = admitWithOverage(op.settings, rows, request, {
      origin: op.origin,
      routablePoolIds: op.overage.routable_pool_ids,
      overagePoolId: op.overage.overage_pool_id,
      approval: approvalRow === null ? null : toApproval(approvalRow).approval,
      now: iso(op.now),
    });
    if (
      !decision.admitted ||
      decision.poolId === null ||
      creditReasons.length > 0
    )
      return {
        admitted: false,
        reason_codes: [...decision.reasonCodes, ...creditReasons],
        reservation: null,
        duplicate: false,
        routed: decision.routed,
      };
    poolId = decision.poolId;
    approvalId = decision.approvalId;
    routed = decision.routed;
  }
  db.prepare(
    "INSERT INTO budget_reservations (reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, approval_id, credit_cycle_id, credit_expires_at, credit_observation_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1, ?, ?, ?, ?, ?)",
  ).run(
    op.reservation_id,
    op.request_id,
    op.profile_id,
    poolId,
    op.pool_id,
    op.origin,
    op.budget_month,
    op.currency,
    op.price_version,
    BigInt(op.reserved_amount),
    BigInt(op.max_liability),
    approvalId,
    creditCycleId,
    creditExpiresAt,
    creditSeq,
    op.now,
  );
  if (approvalId !== null) {
    // 承認は 1 回だけ使う。受付と同じ transaction で consumed にする（trigger が予約との一致を確かめる）。
    const consumed = db
      .prepare(
        "UPDATE budget_overage_approvals SET status = 'consumed', consumed_at = ?, consumed_reservation_id = ? WHERE approval_id = ? AND status = 'approved'",
      )
      .run(op.now, op.reservation_id, approvalId);
    if (consumed.changes !== 1)
      throw new BudgetRejection(['approval_not_approved']);
  }
  return {
    admitted: true,
    reason_codes: [],
    reservation: requireReservation(db, op.reservation_id),
    duplicate: false,
    routed,
  };
}

function topUp(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.top_up' }>,
): BudgetReservationChange {
  // 予算月の状態が食い違う（U23）・時計が戻った・月の終わりを越えて進めていないときは、受付と同じく追加予約も
  // 止める（B07-03 の Codex のレビュー P2）。計上先は予約の元の月のまま。
  currentMonth(db, op.now);
  const current = requireReservation(db, op.reservation_id);
  // 超過の承認は 1 つの M に固定する（本人の判断 2026-10-23）。承認した M を追加予約で増やさない。
  if (current.approvalId !== null)
    throw new BudgetRejection(['approval_fixes_max_liability']);
  // 予約の元の月の行（この予約を含む）と M 超過の確認待ちの行で、追加分だけを検査する。
  const decision = topUpReservation(
    op.settings,
    admissionRows(db, current.budgetMonth),
    op.reservation_id,
    op.expected_revision,
    op.delta_reserved,
    op.delta_max_liability,
  );
  if (!decision.ok) throw new BudgetRejection(decision.reasonCodes);
  const next = decision.reservation;
  if (BigInt(next.maxLiability) > BUDGET_AMOUNT_MAX)
    throw new BudgetRejection(['amount_overflow']);
  // クレジットの周期に結び付いた予約は、追加の M もクレジットの残りで賄えるときだけ増やす（更新と同じ transaction。
  // 観測・失効・古さ・残りを受付と同じ規則で確かめ、確認できなければ拒否する。ADR 0042）。
  if (current.creditCycleId !== null && current.creditCycleId !== undefined) {
    if (op.credit === undefined || op.credit === null)
      throw new BudgetRejection(['credit_unknown']);
    const resolved = resolveCredit(db, op.credit, op.now);
    const found = reservationCredit(db, current, resolved);
    const covered = creditTopUp({
      basis: found.basis,
      ledger: found.ledger,
      now: op.now,
      sharedMaxAgeMs: op.credit.config.shared_observation_max_age_ms,
      deltaMaxLiability: BigInt(op.delta_max_liability),
      boundExpiresAt: current.creditExpiresAt ?? null,
    });
    if (!covered.ok) throw new BudgetRejection([covered.reason]);
  }
  // 版の CAS。期待の版と reserved のときだけ 1 行を更新する。
  const updated = db
    .prepare(
      "UPDATE budget_reservations SET reserved_amount = ?, max_liability = ?, reservation_revision = reservation_revision + 1 WHERE reservation_id = ? AND reservation_revision = ? AND status = 'reserved'",
    )
    .run(
      BigInt(next.reserved),
      BigInt(next.maxLiability),
      op.reservation_id,
      Number(op.expected_revision),
    );
  if (updated.changes !== 1) throw new BudgetRejection(['revision_conflict']);
  return {
    reservation: requireReservation(db, op.reservation_id),
    duplicate: false,
  };
}

function settle(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.settle' }>,
): BudgetSettlementChange {
  const current = requireReservation(db, op.reservation_id);
  const reconciliationId = `${op.provider}:${op.provider_reconciliation_id}`;
  requireReconciliationFree(db, reconciliationId, op.reservation_id);
  // クレジットの区分（B07-07）。精算済みの再適用は、保存した区分のまま変化なしにする（台帳は精算した後の値なので
  // 求め直さない）。まだ精算していない予約だけ、予約が結び付いた周期の台帳で分ける。結び付かない予約はクレジット 0・見積もり 0。
  // 結び付いた予約で、確認できない（観測がない・不明・失効・周期が終わった）ときはクレジット 0（追加の支出＝実費）だが、
  // 受付の消費の見積もりは min(実費, M) を残し、新しい観測が届くまで残りから引き続ける。
  let credit = 0n;
  let estimate = 0n;
  if (
    current.status !== 'settled' &&
    current.creditCycleId !== null &&
    current.creditCycleId !== undefined
  ) {
    const bases =
      op.credit === undefined || op.credit === null
        ? []
        : resolveCredit(db, op.credit, op.now).bases;
    const basis =
      bases.find((item) => item.cycleId === current.creditCycleId) ?? null;
    const allocation = allocateCredit({
      cycleId: current.creditCycleId,
      actualGross: BigInt(op.actual_gross),
      maxLiability: BigInt(current.maxLiability),
      basis,
      ledger:
        basis === null
          ? null
          : creditLedger(
              db,
              basis.cycleId,
              basis.observedAt,
              current.reservationId,
            ),
      now: op.now,
    });
    credit = allocation.creditApplied;
    estimate = allocation.estimate;
  }
  const decision = settleReservation(current, {
    requestId: op.request_id,
    providerReconciliationId: reconciliationId,
    actualGross: op.actual_gross,
    creditApplied: credit.toString(),
  });
  if (!decision.ok) throw new BudgetRejection(decision.reasonCodes);
  if (decision.duplicate)
    return { reservation: current, duplicate: true, overrun: decision.overrun };
  settledUpdate(
    db,
    op.reservation_id,
    op.actual_gross,
    credit.toString(),
    (BigInt(op.actual_gross) - credit).toString(),
    estimate.toString(),
    reconciliationId,
    'provider',
    op.now,
  );
  return {
    reservation: requireReservation(db, op.reservation_id),
    duplicate: false,
    overrun: decision.overrun,
  };
}

function markUnknown(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.mark_unknown' }>,
): BudgetReservationChange {
  const current = requireReservation(db, op.reservation_id);
  if (current.status === 'usage_unknown')
    return { reservation: current, duplicate: true };
  const decision = markUsageUnknown(current);
  if (!decision.ok) throw new BudgetRejection(decision.reasonCodes);
  const updated = db
    .prepare(
      "UPDATE budget_reservations SET status = 'usage_unknown' WHERE reservation_id = ? AND status = 'reserved'",
    )
    .run(op.reservation_id);
  if (updated.changes !== 1) throw new BudgetRejection(['not_active']);
  return {
    reservation: requireReservation(db, op.reservation_id),
    duplicate: false,
  };
}

function release(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.release_unsent' }>,
): BudgetReservationChange {
  const current = requireReservation(db, op.reservation_id);
  if (current.status === 'released')
    return { reservation: current, duplicate: true };
  // 会話の接続を作った予約は、provider へ送った可能性がある（記録上確実に未送信とは言えない）。
  const live =
    db
      .prepare('SELECT 1 FROM live_sessions WHERE reservation_id = ?')
      .get(op.reservation_id) !== undefined;
  // 送出意図を記録した予約と、記録のない 0001 から移した行（起点がない）も、送った可能性がある（0007）。
  const decision = releaseUnsent(
    current,
    op.provider_request_sent ||
      live ||
      current.dispatchIntentAt !== null ||
      current.origin === null,
  );
  if (!decision.ok) throw new BudgetRejection(decision.reasonCodes);
  const updated = db
    .prepare(
      "UPDATE budget_reservations SET status = 'released' WHERE reservation_id = ? AND status = 'reserved'",
    )
    .run(op.reservation_id);
  if (updated.changes !== 1) throw new BudgetRejection(['not_active']);
  return {
    reservation: requireReservation(db, op.reservation_id),
    duplicate: false,
  };
}

function review(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.review_overrun' }>,
): BudgetOpValues['budget.review_overrun'] {
  if (replayed(db, op.request, op.reservation_id))
    return {
      reservation: requireReservation(db, op.reservation_id),
      duplicate: true,
      replayed: true,
    };
  const current = requireReservation(db, op.reservation_id);
  const decision = reviewOverrun(current, {
    expectedRevision: op.expected_revision,
    currency: op.currency,
    actualGross: op.actual_gross,
    maxLiability: op.max_liability,
  });
  if (!decision.ok) throw new BudgetRejection(decision.reasonCodes);
  if (!decision.duplicate) {
    const updated = db
      .prepare(
        "UPDATE budget_reservations SET overrun_reviewed = 1, overrun_reviewed_at = ? WHERE reservation_id = ? AND status = 'settled' AND overrun_reviewed = 0",
      )
      .run(op.now, op.reservation_id);
    if (updated.changes !== 1) throw new BudgetRejection(['not_settled']);
  }
  writeReceipt(db, op.request, op.reservation_id, current.revision, op.now);
  return {
    reservation: requireReservation(db, op.reservation_id),
    duplicate: decision.duplicate,
    replayed: false,
  };
}

function settleByHand(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.settle_manual' }>,
): BudgetOpValues['budget.settle_manual'] {
  if (replayed(db, op.request, op.reservation_id)) {
    const stored = requireReservation(db, op.reservation_id);
    return {
      reservation: stored,
      duplicate: true,
      overrun:
        stored.actualGross !== null &&
        BigInt(stored.actualGross) > BigInt(stored.maxLiability),
      replayed: true,
    };
  }
  const current = requireReservation(db, op.reservation_id);
  requireReconciliationFree(db, op.manual_reconciliation_id, op.reservation_id);
  const decision = settleManually(current, {
    expectedRevision: op.expected_revision,
    manualReconciliationId: op.manual_reconciliation_id,
    currency: op.currency,
    actualGross: op.actual_gross,
    ...(op.credit_applied === undefined
      ? {}
      : { creditApplied: op.credit_applied }),
    ...(op.additional_spend === undefined
      ? {}
      : { additionalSpend: op.additional_spend }),
    ...(op.credit_cycle_id === undefined
      ? {}
      : { creditCycleId: op.credit_cycle_id }),
  });
  if (!decision.ok) throw new BudgetRejection(decision.reasonCodes);
  if (!decision.duplicate)
    settledUpdate(
      db,
      op.reservation_id,
      op.actual_gross,
      op.credit_applied ?? '0',
      op.additional_spend ?? op.actual_gross,
      // 本人が請求の照合で得た区分なので、見積もりも同じ（確認できないものではない）。
      op.credit_applied ?? '0',
      op.manual_reconciliation_id,
      'manual',
      op.now,
    );
  writeReceipt(db, op.request, op.reservation_id, current.revision, op.now);
  return {
    reservation: requireReservation(db, op.reservation_id),
    duplicate: decision.duplicate,
    overrun: decision.overrun,
    replayed: false,
  };
}

function requireApproval(
  db: SqliteDatabase,
  approvalId: string,
): BudgetApprovalValue {
  const row = selectApprovals(db, 'WHERE approval_id = ?', approvalId)[0];
  if (row === undefined) throw new BudgetRejection(['approval_unknown']);
  return toApproval(row);
}

function requestOverage(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.request_overage' }>,
): BudgetOpValues['budget.request_overage'] {
  if (
    db
      .prepare('SELECT 1 FROM budget_reservations WHERE request_id = ?')
      .get(op.request_id) !== undefined
  )
    throw new BudgetRejection(['already_admitted']);
  const live =
    selectApprovals(
      db,
      "WHERE request_id = ? AND status IN ('pending', 'approved', 'consumed')",
      op.request_id,
    )[0] ?? null;
  if (live !== null) {
    if (live.status === 'consumed')
      throw new BudgetRejection(['approval_consumed']);
    const same =
      live.pool_id === op.pool_id &&
      live.budget_month === op.budget_month &&
      live.currency === op.currency &&
      live.max_liability.toString() === op.max_liability;
    // 期限内の同じ承認の再要求（二度押し）は、保存済みの承認を返す。
    if (Number(live.expires_at) > op.now) {
      if (!same) throw new BudgetRejection(['approval_conflict']);
      return { ...toApproval(live), duplicate: true };
    }
    // 期限を過ぎた承認は使えないので expired にしてから、新しい承認を求める。
    db.prepare(
      "UPDATE budget_overage_approvals SET status = 'expired' WHERE approval_id = ? AND status IN ('pending', 'approved')",
    ).run(live.approval_id);
  }
  db.prepare(
    "INSERT INTO budget_overage_approvals (approval_id, request_id, pool_id, budget_month, currency, max_liability, overage_remaining, status, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).run(
    op.approval_id,
    op.request_id,
    op.pool_id,
    op.budget_month,
    op.currency,
    BigInt(op.max_liability),
    BigInt(op.overage_remaining),
    op.now,
    op.expires_at,
  );
  return { ...requireApproval(db, op.approval_id), duplicate: false };
}

function decideOverage(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.approve_overage' }>,
): BudgetOpValues['budget.approve_overage'] {
  if (replayed(db, op.request, op.approval_id))
    return {
      ...requireApproval(db, op.approval_id),
      duplicate: true,
      replayed: true,
    };
  const stored = requireApproval(db, op.approval_id);
  const approval = stored.approval;
  // 承認は 1 つの request_id と M に固定する。画面で見せた値と記録が違えば決めない。
  if (
    approval.request_id !== op.budget_request_id ||
    approval.max_liability.currency !== op.currency ||
    approval.max_liability.amount !== op.max_liability
  )
    throw new BudgetRejection(['approval_mismatch']);
  const target = op.decision === 'approve' ? 'approved' : 'rejected';
  let duplicate = false;
  if (approval.status === target) duplicate = true;
  else if (approval.status !== 'pending')
    throw new BudgetRejection([`approval_${approval.status}`]);
  else {
    if (op.now >= Date.parse(approval.expires_at))
      throw new BudgetRejection(['approval_expired']);
    const updated = db
      .prepare(
        "UPDATE budget_overage_approvals SET status = ?, decided_at = ? WHERE approval_id = ? AND status = 'pending'",
      )
      .run(target, op.now, op.approval_id);
    if (updated.changes !== 1) throw new BudgetRejection(['approval_changed']);
  }
  writeReceipt(db, op.request, op.approval_id, '0', op.now);
  return {
    ...requireApproval(db, op.approval_id),
    duplicate,
    replayed: false,
  };
}

function advanceCalendar(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.calendar_advance' }>,
): BudgetCalendarValue {
  const stored = readEffectiveCalendar(db);
  const result =
    stored === null
      ? advanceBudgetMonth(null, iso(op.now), op.time_zone)
      : evaluateCalendar(stored, op.now, op.time_zone);
  if (!result.ok) throw new BudgetRejection(result.reasonCodes);
  const recorded = stored === null || result.rolledOver;
  if (recorded)
    db.prepare(
      'INSERT INTO budget_months (month, time_zone, month_start, month_start_time_zone, recorded_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      result.state.month,
      result.state.timeZone,
      Date.parse(result.state.monthStart),
      result.state.monthStartTimeZone,
      op.now,
    );
  return { state: result.state, rolled_over: result.rolledOver, recorded };
}

// 本人による予算月の確かめ直し（0007、ADR 0037）。本人が見た月と始まりが今の状態と一致し、今の状態がその理由で
// 止まっているときだけ記録する。記録の後の状態を返す（始まりを確かめ直した後に時計の戻りが残れば、その理由を返す）。
function confirmCalendar(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.calendar_confirm' }>,
): BudgetOpValues['budget.calendar_confirm'] {
  const effective = readEffectiveCalendar(db);
  if (effective === null)
    throw new BudgetRejection(['calendar_not_initialized']);
  const state = effective.state;
  if (state.month !== op.month)
    throw new BudgetRejection(['confirmation_mismatch']);
  // 本人が見た後に別の確かめ直しが記録された・時計が見た時刻よりさらに戻った入力は古い（送り直しで新しい状態を
  // 承認しない）。
  if (
    confirmationRevision(db, state.month) !== op.expected_revision ||
    op.now < op.observed_at
  )
    throw new BudgetRejection(['confirmation_stale']);
  const checked = evaluateCalendar(effective, op.now, state.timeZone);
  const reasons = checked.ok ? [] : checked.reasonCodes;
  if (reasons.length !== 1 || reasons[0] !== op.reason)
    throw new BudgetRejection(['nothing_to_confirm']);
  const currentStart = Date.parse(state.monthStart);
  if (op.reason === 'invalid_calendar_state') {
    const recomputed = budgetMonthStart(state.month, state.monthStartTimeZone);
    if (recomputed === null) throw new BudgetRejection(['invalid_time']);
    if (Date.parse(recomputed) !== op.month_start)
      throw new BudgetRejection(['confirmation_mismatch']);
    // 前の月の始まりより後でなければならない（月は前へだけ進む）。
    const previous = db
      .prepare('SELECT max(month_start) FROM budget_months WHERE month < ?')
      .pluck()
      .get(state.month) as number | null;
    if (previous !== null && previous >= op.month_start)
      throw new BudgetRejection(['month_start_not_after_previous']);
    db.prepare(
      "INSERT INTO budget_month_confirmations (confirmation_id, month, kind, previous_month_start, month_start, regression_floor, confirmed_at) VALUES (?, ?, 'start_reverified', ?, ?, NULL, ?)",
    ).run(
      op.confirmation_id,
      state.month,
      currentStart,
      op.month_start,
      op.now,
    );
  } else {
    // 本人が見た時計は今の月の始まりより前（戻っていた）。下限は本人が見た時計で、実行時の時計ではない。
    if (currentStart !== op.month_start || op.observed_at >= currentStart)
      throw new BudgetRejection(['confirmation_mismatch']);
    db.prepare(
      "INSERT INTO budget_month_confirmations (confirmation_id, month, kind, previous_month_start, month_start, regression_floor, confirmed_at) VALUES (?, ?, 'clock_regression_accepted', ?, ?, ?, ?)",
    ).run(
      op.confirmation_id,
      state.month,
      currentStart,
      currentStart,
      op.observed_at,
      op.now,
    );
  }
  return {
    ...checkCalendar(db, op.now),
    confirmation_id: op.confirmation_id,
  };
}

// 送る直前の最終検査と送出意図の記録。記録できたときだけ provider へ一度送ってよい（自動の再送はしない）。
function dispatchIntent(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.dispatch_intent' }>,
): BudgetReservationChange {
  const current = requireReservation(db, op.reservation_id);
  const breaker = db
    .prepare('SELECT state FROM safety_breaker WHERE singleton = 1')
    .get() as { state: string } | undefined;
  const reasons = dispatchReasons({
    status: current.status,
    // 起点のない 0001 から移した行は、送出の記録がないので送った可能性があるとみなす。
    dispatched: current.dispatchIntentAt !== null || current.origin === null,
    safetyStopped: breaker?.state === 'stopped',
    now: op.now,
    deadline: op.deadline,
  });
  if (reasons.length > 0) throw new BudgetRejection(reasons);
  // クレジットの周期に結び付いた予約は、送る直前にクレジットを確かめ直す（受付の後の失効・不明・古い・残高の減少。
  // 送れないなら記録せず、購入残高・後払いへ移らない）。確認できなければ送らない。ADR 0042。
  if (current.creditCycleId !== null && current.creditCycleId !== undefined) {
    if (op.credit === undefined || op.credit === null)
      throw new BudgetRejection(['credit_unknown']);
    const resolved = resolveCredit(db, op.credit, op.now);
    const found = reservationCredit(db, current, resolved);
    const covered = creditStillCovers({
      basis: found.basis,
      ledger: found.ledger,
      now: op.now,
      sharedMaxAgeMs: op.credit.config.shared_observation_max_age_ms,
      boundExpiresAt: current.creditExpiresAt ?? null,
    });
    if (!covered.ok) throw new BudgetRejection([covered.reason]);
  }
  const updated = db
    .prepare(
      "UPDATE budget_reservations SET dispatch_intent_at = ? WHERE reservation_id = ? AND status = 'reserved' AND dispatch_intent_at IS NULL",
    )
    .run(op.now, op.reservation_id);
  if (updated.changes !== 1) throw new BudgetRejection(['reservation_invalid']);
  return {
    reservation: requireReservation(db, op.reservation_id),
    duplicate: false,
  };
}

function applyWrite(db: SqliteDatabase, op: BudgetOp): BudgetOpValue {
  switch (op.kind) {
    case 'budget.admit':
      return admit(db, op);
    case 'budget.top_up':
      return topUp(db, op);
    case 'budget.settle':
      return settle(db, op);
    case 'budget.mark_unknown':
      return markUnknown(db, op);
    case 'budget.release_unsent':
      return release(db, op);
    case 'budget.review_overrun':
      return review(db, op);
    case 'budget.settle_manual':
      return settleByHand(db, op);
    case 'budget.request_overage':
      return requestOverage(db, op);
    case 'budget.approve_overage':
      return decideOverage(db, op);
    case 'budget.calendar_advance':
      return advanceCalendar(db, op);
    case 'budget.calendar_confirm':
      return confirmCalendar(db, op);
    case 'budget.dispatch_intent':
      return dispatchIntent(db, op);
    case 'budget.credit_state': {
      const resolved = resolveCredit(db, op.credit, op.now);
      return {
        bases: resolved.bases,
        current: resolved.current,
        rejected: resolved.rejected,
        ledger: resolved.ledger,
      };
    }
    default:
      throw new BudgetRejection(['kind_invalid']);
  }
}

// --- 照会 ---

function summary(
  db: SqliteDatabase,
  op: Extract<BudgetOp, { kind: 'budget.summary' }>,
): BudgetUsageSummaryView {
  const state = readEffectiveCalendar(db)?.state ?? null;
  if (state === null) throw new BudgetRejection(['calendar_not_initialized']);
  // 今月と、未精算か M 超過の確認待ちが残る前の月の行。今月より後の月の行があれば future_month で拒否する。
  const months = db
    .prepare(
      "SELECT DISTINCT budget_month FROM budget_reservations WHERE budget_month < ? AND (status IN ('reserved', 'usage_unknown') OR (status = 'settled' AND overrun_reviewed = 0 AND actual_gross > max_liability))",
    )
    .pluck()
    .all(state.month) as string[];
  const wanted = [state.month, ...months];
  const rows = selectReservations(
    db,
    `WHERE budget_month IN (${wanted.map(() => '?').join(', ')}) OR budget_month > ? ORDER BY budget_month, created_at, reservation_id`,
    ...wanted,
    state.month,
  );
  const approvals = selectApprovals(
    db,
    "WHERE status = 'pending' ORDER BY requested_at, approval_id",
  ).map((row) => toApproval(row).approval);
  const result = summarizeUsage({
    settings: op.settings,
    reservations: rows,
    currentMonth: state.month,
    timeZone: state.timeZone,
    generatedAt: iso(op.now),
    overageApprovals: approvals,
    configValid: op.config_valid,
  });
  if (!result.ok) throw new BudgetRejection(result.reasonCodes);
  return result.summary;
}

function readOnly(db: SqliteDatabase, op: BudgetOp): BudgetOpValue {
  switch (op.kind) {
    case 'budget.summary':
      return db.transaction(() => summary(db, op))();
    case 'budget.calendar_read':
      return readEffectiveCalendar(db)?.state ?? null;
    case 'budget.credit_ledger': {
      const ledger = db.transaction(() =>
        creditLedger(db, op.cycle_id, op.since, op.exclude_reservation_id),
      )();
      return {
        allocated_since: ledger.allocatedSince.toString(),
        outstanding: ledger.outstanding.toString(),
      };
    }
    case 'budget.calendar_check':
      return db.transaction(() => checkCalendar(db, op.now))();
    case 'budget.unsettled_list':
      return selectReservations(
        db,
        "WHERE status = 'reserved' ORDER BY created_at, reservation_id",
      ).map((reservation) => ({
        reservation,
        live_session:
          db
            .prepare('SELECT 1 FROM live_sessions WHERE reservation_id = ?')
            .get(reservation.reservationId) !== undefined,
      }));
    case 'budget.reservation_find':
      return op.reservation_id !== null
        ? findReservation(db, op.reservation_id)
        : (selectReservations(db, 'WHERE request_id = ?', op.request_id)[0] ??
            null);
    case 'budget.approval_find': {
      const row = selectApprovals(
        db,
        'WHERE approval_id = ?',
        op.approval_id,
      )[0];
      return row === undefined ? null : toApproval(row);
    }
    default:
      throw new BudgetRejection(['kind_invalid']);
  }
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): BudgetOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

export interface BudgetContext {
  readonly platform: StoragePlatform;
  readonly halted: boolean;
  // 故障注入の試験用。transaction の本体の後・COMMIT の前に呼ぶ。
  readonly beforeCommit?: (op: { readonly kind: string }) => void;
}

// 予算の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeBudgetOp(
  db: SqliteDatabase,
  op: BudgetOp,
  context: BudgetContext,
): BudgetStoreResult {
  const shape = budgetOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (!BUDGET_WRITE_OPS.has(op.kind)) {
    try {
      return { result: { ok: true, value: readOnly(db, op) }, halt: false };
    } catch (error) {
      if (error instanceof BudgetRejection)
        return { result: rejected(error.reasons), halt: false };
      throw error;
    }
  }
  // 書込みを止めた worker は書かない（ADR 0018）。照会は続ける。
  if (context.halted)
    return { result: rejected(['worker_halted']), halt: false };
  const durability = writeConnectionReasons(db, context.platform);
  if (durability.length > 0)
    return {
      result: rejected(['durability_mismatch', ...durability]),
      halt: true,
    };
  try {
    const run = runImmediate(
      db,
      () => applyWrite(db, op),
      context.beforeCommit === undefined
        ? undefined
        : () => context.beforeCommit?.(op),
    );
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof BudgetRejection)
      return { result: rejected(error.reasons), halt: false };
    if (error instanceof Error && error.name === 'CommitUncertain')
      return {
        result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
        halt: true,
      };
    const code = sqliteCode(error);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
      return { result: rejected(['database_busy']), halt: false };
    if (code?.startsWith('SQLITE_CONSTRAINT'))
      return { result: rejected(['constraint_violation']), halt: false };
    return {
      result: rejected([
        code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
      ]),
      halt: true,
    };
  }
}
