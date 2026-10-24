// 予算の門（BudgetGate。設計 05 F02・D15、09 X18・QA42・QA02・X28・X34・X53、08 §3 P01、ADR 0006・0034〜0037、
// 本人の判断 2026-10-23）。
//
// LLM・検索・音声のアダプターが有料の provider へ送る前に必ず通る口。流れは「受付（admit）→ 送る直前の最終検査と
// 送出意図（dispatch）→ 送る → 精算（settle）・usage 不明（unknown）・未送信の解放（release）」。run() がこの流れを
// 一度にまとめる。判定は domain の純粋な規則と DB worker の予算の命令（packages/storage の budget-store.ts）に任せ、
// この門は設定・時計・順序だけを持つ。
// - 枠: 起点（本人の依頼か自発か）とサービスから、実行時の設定の routing で計上する葉の枠を決める（domain の
//   routePool）。超過枠へ回せる通常の枠の許可リストも設定から作る（overageRouteOf。空なら回さない）。
// - R と M: domain の computeReservation（単価の版・為替・安全係数・課金され得る期間）。期間は受付の時刻から応答の
//   期限（timeout）まで。
// - 予算月: 受付のたびに本人が設定したタイムゾーンで進める。時計の戻り・tz データの食い違い・経路を解けない予約の
//   ときは受け付けない（予算保留）。本人の確かめ直し（confirmCalendar）で解く。
// - 送出意図を記録した予約は解放しない。応答の喪失・timeout・結果の破棄は usage 不明で R と M を保持し、自動で
//   送り直さない。遅れて届いた usage は精算する（usage 不明 → 精算は DB が許す）。
// - 再起動の照合（reconcile）: 送出意図のない受付中の予約は解放し、ある予約は provider の照合の口で usage が分かれば
//   精算、分からなければ usage 不明にする（X28 の仕組み）。provider へ送り直さない。
// - 月替わり・保留の解除を知らせる（onResumable）。予算を待っている解析（B10）が再開に使う。
// - 付帯クレジット（B07-07、ADR 0042）: 設定の credit で指定した profile の LLM の要求だけ、クレジットの残りで M の全額を
//   賄えるときに受け付け（残高が不明・失効・枯渇・古い・足りないなら保留。購入残高・後払いへ自動で移らない）、予約を
//   今の周期に結び付ける。精算は通常料金の実費をクレジットと追加の支出に一度だけ分ける（枠の上限は実費の全額で守る）。
//   音声・検索・指定のない profile にはクレジットを充てない。残高の観測は本人が書くファイルから読む。
// 結果の理由にはコードだけを入れ、金額・本文を記録へ出さない。

import { randomUUID } from 'node:crypto';
import {
  computeLiveSecondsAmount,
  computeReservation,
  creditAvailability,
  creditEligible,
  overageRouteOf,
  routePool,
  toReservationView,
} from '@buddy/domain';
import type {
  BudgetHoldReason,
  BudgetOrigin,
  BudgetReservationView,
  BudgetService,
  BudgetUsageSummaryView,
  CreditHoldReason,
  OverageApprovalRecord,
  P95Measurement,
  PriceCategory,
} from '@buddy/domain';
import type {
  BudgetCalendarCheck,
  BudgetCreditInput,
  BudgetCreditSettings,
  BudgetCreditState,
  BudgetOp,
  BudgetOpKind,
  BudgetOpOutcome,
  BudgetRequestRef,
  BudgetReservationValue,
} from '@buddy/storage';
import type { CreditObservationSource } from './budget-credit.js';
import type { LoadedBudgetConfig } from './budget-config.js';

export interface BudgetStore {
  budget<K extends BudgetOpKind>(
    op: Extract<BudgetOp, { kind: K }>,
  ): Promise<BudgetOpOutcome<K>>;
}

// 有料の要求。量は profile と送る内容から呼び出し側（アダプター）が決める。
export interface PaidRequest {
  // 予算の要求の ID（UUID）。同じ要求の送り直しは同じ ID で、保存済みの予約を返す。
  readonly request_id: string;
  readonly origin: BudgetOrigin;
  readonly service: BudgetService;
  readonly profile_id: string;
  // profile の設定の版（p95 の測定と照合する）。
  readonly profile_revision: string;
  // 単価の系列（PriceVersion.price_key）。
  readonly price_key: string;
  // 区分ごとの 1 要求の最大量（入力は送る量、出力は profile の出力上限、ツール・検索・会話の秒は呼出し上限）。
  readonly quantities: Readonly<Partial<Record<PriceCategory, string>>>;
  // 応答の期限（ミリ秒）。課金され得る期間の終わりと、run() の timeout に使う。
  readonly timeout_ms: number;
  readonly p95?: P95Measurement | null;
}

// 受け付けた予約。送る・精算する・追加予約するときに渡す。
export interface BudgetTicket {
  readonly reservation_id: string;
  readonly request_id: string;
  readonly pool_id: string;
  readonly budget_month: string;
  // 受付で固定した単価の版（追加予約・精算の金額を同じ版で求める。B05-04）。
  readonly price_version: string;
  readonly reserved: string;
  readonly max_liability: string;
  readonly revision: string;
  // 超過枠で受け付けた（承認を使った）。
  readonly routed: boolean;
  // 応答の期限（UTC のミリ秒）。
  readonly deadline: number;
  // 課金され得る期間（UTC のミリ秒。予約の受付から応答の期限まで）。会話の秒数の金額は、この窓にかかる
  // 単価の版のうち高い方で求める（ADR 0049・U85）。
  readonly billable_from: number;
  readonly billable_until: number;
  // 受付で結び付けたクレジットの有効期限（UTC のミリ秒。クレジットを充てない予約は null）。provider へ送る直前にも
  // この時刻を過ぎていないことを確かめる。
  readonly credit_expires_at: number | null;
}

export type AdmitResult =
  | {
      readonly ok: true;
      readonly ticket: BudgetTicket;
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly string[];
      // 予算による拒否（上限・M 超過の確認待ち・予算保留）。予算を待つ処理は onResumable で再開を待てる。
      readonly budgetHeld: boolean;
    };

// provider の usage（通常料金の実費）。照合 ID は provider の受付 ID など。
export interface PaidUsage {
  readonly kind: 'usage';
  readonly provider: string;
  readonly reconciliation_id: string;
  readonly actual_gross: string;
}

// アダプターの送信の結果。usage が分からない（応答の喪失・接続断・不正な応答）なら unknown。例外も unknown として扱う。
export type PaidOutcome = PaidUsage | { readonly kind: 'unknown' };

export interface PaidSendContext {
  readonly request_id: string;
  readonly reservation_id: string;
  // timeout・結果の破棄で中断する。中断した後に届いた usage は精算する。
  readonly signal: AbortSignal;
}

export type RunResult =
  | {
      readonly kind: 'rejected';
      readonly reasons: readonly string[];
      readonly budgetHeld: boolean;
    }
  // 送っていない（送出意図を記録していない）ので解放した。
  | { readonly kind: 'released'; readonly reasons: readonly string[] }
  | {
      readonly kind: 'settled';
      readonly ticket: BudgetTicket;
      readonly overrun: boolean;
      readonly duplicate: boolean;
    }
  // 送った可能性があり usage が分からない。R と M を保持する（解放しない）。
  | {
      readonly kind: 'usage_unknown';
      readonly ticket: BudgetTicket;
      readonly reasons: readonly string[];
    };

// provider の usage の照合の口（再起動の照合で使う）。見つからなければ null。送り直しはしない。
export interface UsageReconciler {
  lookup(input: {
    readonly request_id: string;
    readonly reservation_id: string;
  }): Promise<PaidUsage | null>;
}

export interface ReconcileReport {
  readonly released: number;
  readonly settled: number;
  readonly usage_unknown: number;
  readonly failed: number;
}

export type BudgetGateHoldReason =
  | 'config_invalid'
  | 'clock_regressed'
  | 'calendar_mismatch'
  | 'reservation_pool_unknown'
  | 'calendar_unavailable';

// 契約の BudgetCreditHold と同じ形（クレジットを充てる profile の保留。金額・残高を含めない）。
export interface BudgetCreditHoldView {
  readonly reason: CreditHoldReason;
  readonly profile_ids: readonly string[];
}

// 契約の BudgetHoldState と同じ形。
export interface BudgetHoldStateView {
  readonly held: boolean;
  readonly reasons: readonly BudgetGateHoldReason[];
  readonly held_pools: readonly {
    readonly pool_id: string;
    readonly hold_reasons: readonly BudgetHoldReason[];
  }[];
  readonly credit_hold?: BudgetCreditHoldView;
}

// 本人が見るクレジットの状態（ローカルの確認・試験用。金額は予算の通貨の百万分の一）。API・スナップショットには
// 出さない（スナップショットの保留は BudgetCreditHold の理由だけ）。
export interface CreditStatusView {
  readonly configured: boolean;
  readonly profile_ids: readonly string[];
  readonly cycle_id: string | null;
  readonly status: 'observed' | 'unknown' | 'expired' | null;
  readonly shared: boolean | null;
  readonly expires_at: string | null;
  readonly observed_at: string | null;
  // 予算の通貨にした残高と、観測の後に精算したクレジット・未精算の最大負担 M の合計・残り。
  readonly balance: string | null;
  readonly allocated_since: string | null;
  readonly outstanding: string | null;
  readonly available: string | null;
  // 保留の理由（受け付けられるなら null）。
  readonly hold: CreditHoldReason | null;
}

export interface BudgetResumeEvent {
  // month_rolled: 予算月が替わった。hold_cleared: 本人の確かめ直しで予算月の保留が解けた。credit_resumed: クレジットを
  // 充てる profile の保留（残高不明・失効・枯渇・古い）が、新しい観測で解けた（定期の確認で気づく。B07-07）。
  readonly kind: 'month_rolled' | 'hold_cleared' | 'credit_resumed';
  readonly month: string;
}

export interface CalendarStatus {
  readonly configured: boolean;
  // 予算月の境目に使う設定のタイムゾーン（正規化した名前）。設定がなければ null。
  readonly configured_time_zone: string | null;
  readonly check: BudgetCalendarCheck | null;
  // 確認した時刻（門の時計）。確かめ直しの要求に observed_at として渡す。
  readonly checked_at: string;
}

export type CalendarConfirmReason = 'clock_regressed' | 'calendar_mismatch';

// 超過枠の承認の期限の長さ（ADR 0039。原本に決めなし。承認の画面を開いて OS の確認で 1 回決めるのに足りる 10 分。
// 期限を過ぎた承認は使えず、新しく求め直す）。
export const OVERAGE_APPROVAL_TTL_MS = 10 * 60_000;

// 本人の操作（超過の承認・M 超過の確認・手での精算・利用状況）の結果。reasons は理由のコードだけ（金額・本文を含めない）。
// unknown は書込みの成否が分からない（COMMIT の失敗。自動では送り直さず、同じ要求の再送で保存済みの結果を返す）。
export type GateResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reasons: readonly string[];
      readonly unknown: boolean;
    };

const gateFailure = (
  reasons: readonly string[],
  unknown = false,
): {
  readonly ok: false;
  readonly reasons: readonly string[];
  readonly unknown: boolean;
} => ({
  ok: false,
  reasons,
  unknown,
});

export interface Money {
  readonly currency: string;
  readonly amount: string;
}

export interface GateTimers {
  // ms 後に fn を呼ぶ。戻り値で取り消す。
  set(ms: number, fn: () => void): () => void;
}

export interface BudgetGateOptions {
  readonly store: BudgetStore;
  readonly config: LoadedBudgetConfig;
  readonly now: () => number;
  readonly log?: (message: string) => void;
  readonly newId?: () => string;
  // p95 × 1.2 で予約してよい profile（05: 意図判定の比較 profile だけ。他は R = M）。
  readonly p95ProfileIds?: readonly string[];
  // 付帯クレジットの残高の観測の口（設定に credit があるとき使う。なければ「観測なし」＝保留）。
  readonly creditObservations?: CreditObservationSource;
  readonly timers?: GateTimers;
  // 観測のファイルを読む待ち時間の上限（ミリ秒。既定 10 秒）。超えたら観測なしとして続け、遅れて届いた結果は採用しない。
  readonly creditReadTimeoutMs?: number;
  // 試験用の故障点。受付の命令を送る直前に呼ぶ（同時の受付を関門でそろえる）。
  readonly faults?: {
    readonly beforeAdmit?: (request: PaidRequest) => Promise<void> | void;
    // 送出意図の命令の前と後（期限・中断の検査の試験）。
    readonly beforeDispatch?: (ticket: BudgetTicket) => Promise<void> | void;
    readonly afterDispatch?: (ticket: BudgetTicket) => Promise<void> | void;
  };
}

const DEFAULT_TIMERS: GateTimers = {
  set(ms, fn) {
    const timer = setTimeout(fn, Math.max(0, ms));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

const GATE_HOLD_CODES: ReadonlySet<string> = new Set([
  'config_invalid',
  'clock_regressed',
  'invalid_calendar_state',
  'reservation_pool_unknown',
  'calendar_not_initialized',
]);

const isBudgetHeld = (reasons: readonly string[]): boolean =>
  reasons.some(
    (code) =>
      GATE_HOLD_CODES.has(code) ||
      /^(r_limit|m_limit|overrun_hold):/u.test(code) ||
      // クレジットを充てる profile の保留（残高の観測が届く・周期が替わると再開できる。B07-07）。
      /^credit_(unknown|expired|stale|exhausted|insufficient)$/u.test(code),
  );

const HOLD_ORDER: readonly BudgetGateHoldReason[] = [
  'config_invalid',
  'clock_regressed',
  'calendar_mismatch',
  'reservation_pool_unknown',
  'calendar_unavailable',
];

const iso = (millis: number): string => new Date(millis).toISOString();

// 会話の課金され得る期間（予約から 2 時間。live-budget.ts の LIVE_SESSION_MAX_MS がこの値を参照する）。保存した
// 予約から券を作り直すとき、受付の時刻（createdAt）にこの長さを足して窓を作る。
export const LIVE_BILLABLE_WINDOW_MS = 7_200_000;

// 観測の採用の結果。設定がなければ configured: false。採用の書込みが失敗したときは state が null（理由つき）。
type CreditAdoptionResult =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly settings: BudgetCreditSettings;
      readonly state: BudgetCreditState | null;
      readonly reasons: readonly string[];
    };

// 送出の直前にこの理由で止めた要求は、クレジットが回復したときに知らせる（credit_resumed）。
const CREDIT_WAIT_REASONS: ReadonlySet<string> = new Set([
  'credit_exhausted',
  'credit_insufficient',
  'credit_expired',
  'credit_unknown',
  'credit_stale',
]);

const toTicket = (
  reservation: BudgetReservationValue,
  routed: boolean,
  deadline: number,
  billableFrom: number,
  billableUntil: number,
): BudgetTicket => ({
  reservation_id: reservation.reservationId,
  request_id: reservation.requestId,
  pool_id: reservation.poolId,
  budget_month: reservation.budgetMonth,
  price_version: reservation.priceVersion,
  reserved: reservation.reserved,
  max_liability: reservation.maxLiability,
  revision: reservation.revision,
  routed,
  deadline,
  billable_from: billableFrom,
  billable_until: billableUntil,
  credit_expires_at: reservation.creditExpiresAt,
});

export class BudgetGate {
  readonly #store: BudgetStore;
  readonly #config: LoadedBudgetConfig;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #newId: () => string;
  readonly #p95ProfileIds: readonly string[];
  readonly #creditSource: CreditObservationSource | null;
  readonly #timers: GateTimers;
  readonly #creditReadTimeoutMs: number;
  readonly #beforeAdmit: (request: PaidRequest) => Promise<void> | void;
  readonly #beforeDispatch: (ticket: BudgetTicket) => Promise<void> | void;
  readonly #afterDispatch: (ticket: BudgetTicket) => Promise<void> | void;
  readonly #listeners = new Set<(event: BudgetResumeEvent) => void>();
  // 前回の確認でクレジットの保留があったか（null は設定なし・まだ確認していない）。保留が解けたときだけ知らせる。
  #creditHeld: boolean | null = null;
  // クレジットの確認は直列にする（並行する確認が古い結果で状態を上書きして、再開を重複して知らせないように。Codex P2）。
  #creditWatch: Promise<void> = Promise.resolve();
  // 残りが M に足りず保留した要求の必要な M（request_id → M）。残りが増えて足りるようになったら再開を知らせる。
  readonly #creditWaiting = new Map<string, bigint>();
  // 拒否した観測の理由を記録に出した組（同じ理由を繰り返し出さない）。
  readonly #creditRejectedLogged = new Set<string>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: BudgetGateOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#now = options.now;
    this.#log = options.log ?? (() => undefined);
    this.#newId = options.newId ?? (() => randomUUID());
    this.#p95ProfileIds = options.p95ProfileIds ?? [];
    this.#creditSource = options.creditObservations ?? null;
    this.#timers = options.timers ?? DEFAULT_TIMERS;
    this.#creditReadTimeoutMs = options.creditReadTimeoutMs ?? 10_000;
    this.#beforeAdmit = options.faults?.beforeAdmit ?? (() => undefined);
    this.#beforeDispatch = options.faults?.beforeDispatch ?? (() => undefined);
    this.#afterDispatch = options.faults?.afterDispatch ?? (() => undefined);
  }

  // 実行時の設定の検査に通っているか（通っていなければ有料の処理を受け付けない）。
  get configured(): boolean {
    return this.#config.ok;
  }

  // 月替わり・保留の解除の知らせ。戻り値で購読をやめる。
  onResumable(listener: (event: BudgetResumeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: BudgetResumeEvent): void {
    this.#log(
      event.kind === 'month_rolled'
        ? `予算月が ${event.month} に替わりました。予算を待っている処理を再開できます。`
        : event.kind === 'credit_resumed'
          ? 'クレジットの残高を確認できました。クレジットを待っている処理を再開できます。'
          : `予算月 ${event.month} の保留が本人の確認で解けました。`,
    );
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // 購読者の失敗で他の購読者と門を止めない。
      }
    }
  }

  #track<T>(promise: Promise<T>): void {
    const tracked = promise.catch(() => undefined);
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  // 付帯クレジットの設定（B07-07）。設定に credit がなければ null。
  #creditSettings(): BudgetCreditSettings | null {
    const config = this.#config;
    if (!config.ok) return null;
    const credit = config.config.credit;
    if (credit === undefined) return null;
    return { config: credit, budget_currency: config.settings.currency };
  }

  // 本人が書いた観測のファイルを、待ち時間の上限つきで読む。口がない・読めない・ファイルがない・待ち時間を超えたときは観測
  // なし。超えた後に届いた結果は捨てる（採用しない）。観測を採用するか（巻き戻りを拒否するか）は DB が決める。
  async #readObservations(): Promise<BudgetCreditInput['observations']> {
    const source = this.#creditSource;
    if (source === null) return [];
    const read = (async (): Promise<BudgetCreditInput['observations']> => {
      try {
        const loaded = await source.read();
        if (!loaded.ok && !loaded.missing)
          this.#noteReadFailure(loaded.reasons);
        return loaded.ok ? loaded.observations : [];
      } catch {
        return [];
      }
    })();
    return new Promise((resolve) => {
      let done = false;
      const cancel = this.#timers.set(this.#creditReadTimeoutMs, () => {
        if (done) return;
        done = true;
        this.#log(
          'クレジットの観測のファイルを待ち時間内に読めませんでした。観測なしとして続けます（遅れて届いた結果は採用しません）。',
        );
        resolve([]);
      });
      void read.then((value) => {
        if (done) return;
        done = true;
        cancel();
        resolve(value);
      });
    });
  }

  // 観測のファイルを読み、予約の判定とは別の transaction で採用して確定する。判定を拒否しても、判定に使った新しい観測は
  // 残る（拒否した判定の巻き戻しに巻き込まない）。ファイルを読めなくても採用済みの観測は残る。設定がなければ configured:
  // false。採用の書込みが失敗したときは state が null（理由つき）。
  async #adoptCredit(): Promise<CreditAdoptionResult> {
    const settings = this.#creditSettings();
    if (settings === null) return { configured: false };
    const observations = await this.#readObservations();
    const adopted = await this.#store.budget({
      kind: 'budget.credit_adopt',
      credit: { ...settings, observations },
      now: this.#now(),
    });
    if (!adopted.ok)
      return {
        configured: true,
        settings,
        state: null,
        reasons: adopted.reasons,
      };
    this.#noteRejected(adopted.value.rejected);
    return { configured: true, settings, state: adopted.value, reasons: [] };
  }

  // 予約がクレジットの周期に結び付いている（受付で有効期限を結び付けた）ときだけ、観測を読んで採用する。結び付かない予約
  // （対象外の profile・音声・検索）は観測のファイルを待たず、クレジットなしで判定する（読み込みが詰まっても巻き込まない）。
  async #adoptForTicket(ticket: BudgetTicket): Promise<CreditAdoptionResult> {
    return ticket.credit_expires_at === null
      ? { configured: false }
      : this.#adoptCredit();
  }

  // 残りが M に足りずに止めた要求の必要な M を覚える（残りが増えて足りるようになったら credit_resumed を知らせる）。
  #waitForCredit(requestId: string, needed: bigint): void {
    if (this.#creditWaiting.size >= 256) {
      const oldest = this.#creditWaiting.keys().next();
      if (oldest.done !== true) this.#creditWaiting.delete(oldest.value);
    }
    this.#creditWaiting.set(requestId, needed);
  }

  // 観測のファイルを読めなかった理由（件数の上限・形の誤りなど）を、同じ理由を繰り返さず記録に出す。残高・中身は出さない。
  #noteReadFailure(reasons: readonly string[]): void {
    for (const reason of reasons) {
      const key = `read:${reason}`;
      if (this.#creditRejectedLogged.has(key)) continue;
      this.#creditRejectedLogged.add(key);
      this.#log(
        `クレジットの観測のファイルを読めませんでした（${reason}）。観測なしとして続けます。`,
      );
    }
  }

  #noteRejected(reasons: readonly string[]): void {
    for (const reason of reasons) {
      if (this.#creditRejectedLogged.has(reason)) continue;
      this.#creditRejectedLogged.add(reason);
      this.#log(
        `クレジットの観測を採用しませんでした（${reason}）。採用済みの観測のまま判定します。`,
      );
    }
  }

  // 遅れて届いた usage の精算など、門が後ろで続けている処理を待つ（試験・停止の前に使う）。
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  // 起動時: 再起動の照合をしてから、設定があれば予算月を進める（初めての起動は記録を作る）。
  async start(reconciler?: UsageReconciler): Promise<ReconcileReport> {
    const report = await this.reconcile(reconciler);
    if (
      report.released + report.settled + report.usage_unknown + report.failed >
      0
    )
      this.#log(
        `予算の再起動の照合: 解放 ${report.released} 件、精算 ${report.settled} 件、usage 不明として保持 ${report.usage_unknown} 件、失敗 ${report.failed} 件。provider へは送り直していません。`,
      );
    await this.tick();
    return report;
  }

  // 予算月を進める（月替わりなら知らせる）。Core が一定の間隔で呼ぶ。受付のたびにも進める。
  async tick(): Promise<boolean> {
    const config = this.#config;
    if (!config.ok) return false;
    const advanced = await this.#store.budget({
      kind: 'budget.calendar_advance',
      now: this.#now(),
      time_zone: config.timeZone,
    });
    if (!advanced.ok) return false;
    if (advanced.value.rolled_over)
      this.#emit({ kind: 'month_rolled', month: advanced.value.state.month });
    await this.#watchCredit(advanced.value.state.month);
    return true;
  }

  // クレジットを充てる profile の保留が解けたら知らせる（本人が観測を書いても、予算を待つ処理はファイルを見ないので、
  // 定期の確認で気づく）。保留が続いている間・保留のなかった間・設定がない間は知らせない。残りが M に足りずに保留した要求は、
  // 残りが増えて足りるようになったときに知らせる。確認は直列で、古い結果が新しい結果を上書きしない。
  #watchCredit(month: string): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        const status = await this.creditStatus();
        if (!status.configured) {
          this.#creditHeld = null;
          this.#creditWaiting.clear();
          return;
        }
        const held = status.hold !== null;
        const resumed = this.#creditHeld === true && !held;
        this.#creditHeld = held;
        let satisfied = false;
        if (status.available !== null) {
          const available = BigInt(status.available);
          for (const [id, needed] of [...this.#creditWaiting])
            if (needed <= available) {
              this.#creditWaiting.delete(id);
              satisfied = true;
            }
        }
        if (resumed || satisfied) this.#emit({ kind: 'credit_resumed', month });
      } catch {
        // 確認の失敗で月の確認を止めない（次の確認でやり直す）。
      }
    };
    this.#creditWatch = this.#creditWatch.then(run, run);
    return this.#creditWatch;
  }

  // R と M の計算（受付と超過の承認の要求で同じ値を使う）。課金され得る期間は受付の時刻から応答の期限まで。
  #estimate(
    config: Extract<LoadedBudgetConfig, { readonly ok: true }>,
    request: PaidRequest,
    now: number,
  ): ReturnType<typeof computeReservation> {
    return computeReservation({
      budgetCurrency: config.settings.currency,
      priceKey: request.price_key,
      priceVersions: config.config.price_versions,
      verifiedPriceVersions: config.settings.verifiedPriceVersions,
      billableFrom: iso(now),
      billableUntil: iso(now + request.timeout_ms),
      quantities: request.quantities,
      profileId: request.profile_id,
      profileRevision: request.profile_revision,
      p95ProfileIds: this.#p95ProfileIds,
      measurement: request.p95 ?? null,
    });
  }

  // 受付。枠を決め、予算月を進め、R と M を計算して、DB の 1 つの transaction で受け付ける。
  async admit(request: PaidRequest): Promise<AdmitResult> {
    const reject = (reasons: readonly string[]): AdmitResult => ({
      ok: false,
      reasons,
      budgetHeld: isBudgetHeld(reasons),
    });
    const config = this.#config;
    if (!config.ok) return reject(['config_invalid']);
    const poolId = routePool(
      config.config.routing,
      request.origin,
      request.service,
    );
    if (poolId === null) return reject(['route_missing']);
    if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms <= 0)
      return reject(['timeout_invalid']);
    const route = overageRouteOf(config.config.routing);
    const eligible = creditEligible(
      config.config.credit,
      request.service,
      request.profile_id,
    );
    for (let attempt = 0; ; attempt += 1) {
      // クレジットを充てる要求（設定で指定した profile の LLM）は、先に観測を採用して確定する（受付を拒否しても残る）。
      // 判定の時刻は、観測を読んだ後に取る。それ以外は周期に結び付けない。
      const adoption = eligible ? await this.#adoptCredit() : null;
      if (adoption !== null && adoption.configured && adoption.state === null)
        return reject(['credit_adoption_failed', ...adoption.reasons]);
      const now = this.#now();
      const calendar = await this.#store.budget({
        kind: 'budget.calendar_advance',
        now,
        time_zone: config.timeZone,
      });
      if (!calendar.ok) return reject(calendar.reasons);
      if (calendar.value.rolled_over)
        this.#emit({ kind: 'month_rolled', month: calendar.value.state.month });
      const deadline = now + request.timeout_ms;
      const estimate = this.#estimate(config, request, now);
      if (!estimate.ok) return reject(estimate.reasonCodes);
      const creditInput =
        adoption !== null && adoption.configured ? adoption.settings : null;
      await this.#beforeAdmit(request);
      const admitted = await this.#store.budget({
        kind: 'budget.admit',
        reservation_id: this.#newId(),
        request_id: request.request_id,
        profile_id: request.profile_id,
        pool_id: poolId,
        origin: request.origin,
        budget_month: calendar.value.state.month,
        price_version: estimate.priceVersion,
        currency: config.settings.currency,
        reserved_amount: estimate.reserved,
        max_liability: estimate.maxLiability,
        settings: config.settings,
        overage:
          route === null
            ? null
            : {
                routable_pool_ids: route.routablePoolIds,
                overage_pool_id: route.overagePoolId,
              },
        credit: creditInput,
        now,
      });
      if (!admitted.ok) {
        // 受付の間に月を越えた（先に月を進めてから一度だけ受け付け直す）。
        if (
          attempt === 0 &&
          admitted.outcome === 'rejected' &&
          admitted.reasons.some(
            (code) =>
              code === 'calendar_stale' || code === 'budget_month_not_current',
          )
        )
          continue;
        return reject(
          admitted.outcome === 'unknown'
            ? ['admission_unknown', ...admitted.reasons]
            : admitted.reasons,
        );
      }
      const value = admitted.value;
      if (!value.admitted || value.reservation === null) {
        // 残りが M に足りずに保留した要求は、残りが増えて足りるようになったときに知らせるため、必要な M を覚える。
        if (value.reason_codes.includes('credit_insufficient'))
          this.#waitForCredit(
            request.request_id,
            BigInt(estimate.maxLiability),
          );
        return reject(value.reason_codes);
      }
      this.#creditWaiting.delete(request.request_id);
      return {
        ok: true,
        ticket: toTicket(
          value.reservation,
          value.routed,
          deadline,
          now,
          deadline,
        ),
        duplicate: value.duplicate,
      };
    }
  }

  // 送る直前の最終検査と送出意図の記録。ok のときだけ provider へ一度送ってよい。
  async dispatch(ticket: BudgetTicket): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reasons: readonly string[];
        // 成否不明（送出意図を記録したかもしれない。解放しない）。
        readonly uncertain: boolean;
      }
  > {
    // クレジットの周期に結び付いた予約は、送る直前にクレジットを確かめ直す（失効・不明・古い・枯渇なら送らない）。先に観測を
    // 採用して確定し（拒否しても残る）、判定の時刻は観測を読んだ後に取る。
    const adoption = await this.#adoptForTicket(ticket);
    if (adoption.configured && adoption.state === null)
      return {
        ok: false,
        reasons: ['credit_adoption_failed', ...adoption.reasons],
        uncertain: false,
      };
    const result = await this.#store.budget({
      kind: 'budget.dispatch_intent',
      reservation_id: ticket.reservation_id,
      now: this.#now(),
      deadline: ticket.deadline,
      credit: adoption.configured ? adoption.settings : null,
    });
    if (result.ok) return { ok: true };
    // 送出直前にクレジットの理由（残りが M に足りない・失効・不明・古い）で止めて解放する要求は、回復したら知らせるため、
    // 必要な M を覚える。
    if (
      result.outcome !== 'unknown' &&
      result.reasons.some((reason) => CREDIT_WAIT_REASONS.has(reason))
    )
      this.#waitForCredit(ticket.request_id, BigInt(ticket.max_liability));
    return {
      ok: false,
      reasons: result.reasons,
      uncertain: result.outcome === 'unknown',
    };
  }

  async settle(
    ticket: BudgetTicket,
    usage: PaidUsage,
  ): Promise<
    | {
        readonly ok: true;
        readonly overrun: boolean;
        readonly duplicate: boolean;
      }
    | { readonly ok: false; readonly reasons: readonly string[] }
  > {
    // クレジットの区分は、DB の transaction が採用済みの観測から決める。観測を先に採用して確定する。観測のファイルを読めなく
    // ても・採用に失敗しても、採用済みの観測で精算できる（精算は止めない）。採用済みの観測がなく確認できないときは、
    // クレジット 0（追加の支出＝実費）で、消費の見積もりは残る。
    const adoption = await this.#adoptForTicket(ticket);
    const creditInput = adoption.configured ? adoption.settings : null;
    const now = this.#now();
    const result = await this.#store.budget({
      kind: 'budget.settle',
      reservation_id: ticket.reservation_id,
      request_id: ticket.request_id,
      provider: usage.provider,
      provider_reconciliation_id: usage.reconciliation_id,
      actual_gross: usage.actual_gross,
      credit: creditInput,
      now,
    });
    if (!result.ok) return { ok: false, reasons: result.reasons };
    if (result.value.overrun && !result.value.duplicate)
      this.#log(
        `実費が最大負担 M を超えました（枠 ${ticket.pool_id}）。本人が確認するまで、その枠と子孫の枠の新しい受付を止めます。`,
      );
    return {
      ok: true,
      overrun: result.value.overrun,
      duplicate: result.value.duplicate,
    };
  }

  // 送った可能性があり usage が分からない。R と M を保持する。
  async unknown(
    ticket: BudgetTicket,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reasons: readonly string[] }
  > {
    const result = await this.#store.budget({
      kind: 'budget.mark_unknown',
      reservation_id: ticket.reservation_id,
    });
    return result.ok ? { ok: true } : { ok: false, reasons: result.reasons };
  }

  // 送っていない（送出意図を記録していない）予約を解放する。記録があれば DB が拒否する。
  async release(
    ticket: BudgetTicket,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reasons: readonly string[] }
  > {
    const result = await this.#store.budget({
      kind: 'budget.release_unsent',
      reservation_id: ticket.reservation_id,
      provider_request_sent: false,
    });
    return result.ok ? { ok: true } : { ok: false, reasons: result.reasons };
  }

  // 追加予約（同じ行の R と M を増やす。会話の延長など B05 が使う）。追加分だけを受付検査する。
  async topUp(
    ticket: BudgetTicket,
    delta: { readonly reserved: string; readonly max_liability: string },
  ): Promise<
    | { readonly ok: true; readonly ticket: BudgetTicket }
    | { readonly ok: false; readonly reasons: readonly string[] }
  > {
    const config = this.#config;
    if (!config.ok) return { ok: false, reasons: ['config_invalid'] };
    // クレジットの周期に結び付いた予約は、追加の M もクレジットの残りで賄えるときだけ増やす。先に観測を採用して確定する。
    const adoption = await this.#adoptForTicket(ticket);
    if (adoption.configured && adoption.state === null)
      return {
        ok: false,
        reasons: ['credit_adoption_failed', ...adoption.reasons],
      };
    const result = await this.#store.budget({
      kind: 'budget.top_up',
      reservation_id: ticket.reservation_id,
      expected_revision: ticket.revision,
      delta_reserved: delta.reserved,
      delta_max_liability: delta.max_liability,
      settings: config.settings,
      now: this.#now(),
      credit: adoption.configured ? adoption.settings : null,
    });
    if (!result.ok) return { ok: false, reasons: result.reasons };
    return {
      ok: true,
      ticket: toTicket(
        result.value.reservation,
        ticket.routed,
        ticket.deadline,
        ticket.billable_from,
        ticket.billable_until,
      ),
    };
  }

  // 受付 → 送出意図 → 送る → 精算・usage 不明・解放をまとめる。send は一度だけ呼ぶ（自動の再送はしない）。
  async run(
    request: PaidRequest,
    send: (context: PaidSendContext) => Promise<PaidOutcome>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<RunResult> {
    const admitted = await this.admit(request);
    if (!admitted.ok)
      return {
        kind: 'rejected',
        reasons: admitted.reasons,
        budgetHeld: admitted.budgetHeld,
      };
    const ticket = admitted.ticket;
    const unsent = async (reasons: readonly string[]): Promise<RunResult> => {
      const released = await this.release(ticket);
      if (released.ok) return { kind: 'released', reasons };
      // 解放できない（送出意図があった・DB に書けない）。送った可能性として扱い、R と M を保持する。
      await this.unknown(ticket);
      return {
        kind: 'usage_unknown',
        ticket,
        reasons: [...reasons, ...released.reasons],
      };
    };
    // 待ちをまたいで呼び出し側の中断を確かめる（関数で読み、途中の await の後も今の値を見る）。
    const callerAborted = (): boolean => options.signal?.aborted === true;
    if (callerAborted()) return unsent(['aborted_before_dispatch']);
    // 期限を過ぎた予約は送らない（M は受付の時刻から期限までの単価で計算した。Codex のレビュー P1）。送出意図の前
    // なので解放する。送り直すなら新しい request_id で受け付け直し、課金期間と M・上限・承認を検査し直す。
    if (this.#now() >= ticket.deadline) return unsent(['reservation_expired']);
    await this.#beforeDispatch(ticket);
    const dispatched = await this.dispatch(ticket);
    if (!dispatched.ok) {
      if (!dispatched.uncertain) return unsent(dispatched.reasons);
      // 送出意図の記録が成否不明。送らず、解放もしない（再起動の照合が決める）。
      return { kind: 'usage_unknown', ticket, reasons: dispatched.reasons };
    }
    await this.#afterDispatch(ticket);
    // 送出意図を記録した後は解放しない。記録を待つ間に中断された・期限を過ぎたなら送らず、usage 不明として保持する
    // （記録の上では送った可能性があるため。Codex のレビュー P1・P2）。ここから send を呼ぶまでは同期で進める。
    const stop = async (
      reason: 'discarded' | 'reservation_expired' | 'credit_expired',
    ): Promise<RunResult> => {
      await this.unknown(ticket);
      return { kind: 'usage_unknown', ticket, reasons: [reason, 'not_sent'] };
    };
    // 準備の前の判定（期限・中断）。timer の残り時間はこの読みから決める。
    const planned = ticket.deadline - this.#now();
    if (callerAborted()) return stop('discarded');
    if (planned <= 0) return stop('reservation_expired');
    // 準備: 中断の controller・呼び出し側の中断の listener・timeout の timer。
    const controller = new AbortController();
    const discard = () => controller.abort('discarded');
    options.signal?.addEventListener('abort', discard, { once: true });
    const cancelTimer = this.#timers.set(planned, () =>
      controller.abort('timeout'),
    );
    const teardown = (): void => {
      cancelTimer();
      options.signal?.removeEventListener('abort', discard);
    };
    // 最後の判定は、準備をすべて終えた後、send を呼ぶ文の直前に置く（間に何も挟まない）。準備の間に時計が進んで
    // 期限に達した・呼び出し側が中断した・timer がすぐ発火したなら、準備を外して送らない（Codex の再確認 P1・P3）。
    const sendAt = this.#now();
    if (
      controller.signal.aborted ||
      callerAborted() ||
      sendAt >= ticket.deadline
    ) {
      teardown();
      const expired =
        controller.signal.reason === 'timeout' || sendAt >= ticket.deadline;
      return stop(expired ? 'reservation_expired' : 'discarded');
    }
    // 受付で結び付けたクレジットの有効期限も、送る直前まで守る（観測の読み込みや待ちの間に失効したら送らない）。
    if (
      ticket.credit_expires_at !== null &&
      sendAt >= ticket.credit_expires_at
    ) {
      teardown();
      return stop('credit_expired');
    }
    let sending: Promise<PaidOutcome>;
    try {
      sending = Promise.resolve(
        send({
          request_id: ticket.request_id,
          reservation_id: ticket.reservation_id,
          signal: controller.signal,
        }),
      ).then(
        (outcome) => outcome,
        (): PaidOutcome => ({ kind: 'unknown' }),
      );
    } catch {
      sending = Promise.resolve({ kind: 'unknown' });
    }
    const aborted = new Promise<'aborted'>((resolve) => {
      if (controller.signal.aborted) resolve('aborted');
      controller.signal.addEventListener('abort', () => resolve('aborted'), {
        once: true,
      });
    });
    const first = await Promise.race([sending, aborted]);
    cancelTimer();
    options.signal?.removeEventListener('abort', discard);
    if (first === 'aborted') {
      const reason =
        controller.signal.reason === 'timeout' ? 'timeout' : 'discarded';
      const marked = this.unknown(ticket);
      // 中断の後に届いた usage は、usage 不明の記録の後で精算する（遅れた結果を捨てても費用は記録する）。
      this.#track(
        marked
          .then(() => sending)
          .then((outcome) =>
            outcome.kind === 'usage' ? this.settle(ticket, outcome) : null,
          ),
      );
      await marked;
      return { kind: 'usage_unknown', ticket, reasons: [reason] };
    }
    if (first.kind !== 'usage') {
      await this.unknown(ticket);
      return { kind: 'usage_unknown', ticket, reasons: ['response_lost'] };
    }
    const settled = await this.settle(ticket, first);
    if (settled.ok)
      return {
        kind: 'settled',
        ticket,
        overrun: settled.overrun,
        duplicate: settled.duplicate,
      };
    await this.unknown(ticket);
    return { kind: 'usage_unknown', ticket, reasons: settled.reasons };
  }

  // 再起動の照合（X28 の仕組み）。受付中（reserved）の予約のうち、送出意図のないものは解放し、あるもの（会話の接続を
  // 作ったもの・記録のない 0001 の行を含む）は provider の照合で usage が分かれば精算、分からなければ usage 不明にする。
  async reconcile(reconciler?: UsageReconciler): Promise<ReconcileReport> {
    const listed = await this.#store.budget({ kind: 'budget.unsettled_list' });
    if (!listed.ok)
      return { released: 0, settled: 0, usage_unknown: 0, failed: 1 };
    let released = 0;
    let settled = 0;
    let unknown = 0;
    let failed = 0;
    for (const item of listed.value) {
      const reservation = item.reservation;
      const ticket = toTicket(
        reservation,
        reservation.approvalId !== null,
        0,
        reservation.createdAt,
        reservation.createdAt + LIVE_BILLABLE_WINDOW_MS,
      );
      const possiblySent =
        reservation.dispatchIntentAt !== null ||
        item.live_session ||
        reservation.origin === null;
      if (!possiblySent) {
        const result = await this.release(ticket);
        if (result.ok) released += 1;
        else failed += 1;
        continue;
      }
      let usage: PaidUsage | null = null;
      if (reconciler !== undefined) {
        try {
          usage = await reconciler.lookup({
            request_id: reservation.requestId,
            reservation_id: reservation.reservationId,
          });
        } catch {
          usage = null;
        }
      }
      if (usage !== null) {
        const result = await this.settle(ticket, usage);
        if (result.ok) {
          settled += 1;
          continue;
        }
      }
      const marked = await this.unknown(ticket);
      if (marked.ok) unknown += 1;
      else failed += 1;
    }
    return { released, settled, usage_unknown: unknown, failed };
  }

  // --- 本人の操作と利用状況（B07-05、ADR 0039） ---

  // 利用状況（契約の BudgetUsageSummary）。先に予算月を進める（月替わりの受付を待たずに今月を見せる）。設定が使えない
  // ときは返さない。
  async usage(): Promise<GateResult<BudgetUsageSummaryView>> {
    const config = this.#config;
    if (!config.ok) return gateFailure(['config_invalid']);
    await this.tick().catch(() => false);
    const result = await this.#store.budget({
      kind: 'budget.summary',
      settings: config.settings,
      config_valid: true,
      now: this.#now(),
    });
    return result.ok
      ? { ok: true, value: result.value }
      : gateFailure(result.reasons, result.outcome === 'unknown');
  }

  // 超過枠の個別の承認を求める（pending の承認を作る。承認は本人が main の OS の確認ダイアログで 1 回決める）。
  // 本人の依頼で、超過枠へ回せる通常の枠の要求だけ。承認はこの request_id・M（要求の時点の価格で計算した値）・
  // 超過枠・今の予算月に固定され、別の M・期限後の受付には使えない。超過枠の残りが M に足りなければ求めない。
  // 同じ request_id の期限内の再要求（二度押し）は保存済みの承認を返す。
  async requestOverage(request: PaidRequest): Promise<
    GateResult<{
      readonly approval: OverageApprovalRecord;
      readonly duplicate: boolean;
    }>
  > {
    const config = this.#config;
    if (!config.ok) return gateFailure(['config_invalid']);
    const poolId = routePool(
      config.config.routing,
      request.origin,
      request.service,
    );
    if (poolId === null) return gateFailure(['route_missing']);
    const route = overageRouteOf(config.config.routing);
    if (route === null) return gateFailure(['overage_unavailable']);
    if (request.origin !== 'owner_request')
      return gateFailure(['not_owner_request']);
    if (!route.routablePoolIds.includes(poolId))
      return gateFailure(['pool_not_routable']);
    if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms <= 0)
      return gateFailure(['timeout_invalid']);
    const now = this.#now();
    const calendar = await this.#store.budget({
      kind: 'budget.calendar_advance',
      now,
      time_zone: config.timeZone,
    });
    if (!calendar.ok)
      return gateFailure(calendar.reasons, calendar.outcome === 'unknown');
    if (calendar.value.rolled_over)
      this.#emit({ kind: 'month_rolled', month: calendar.value.state.month });
    const estimate = this.#estimate(config, request, now);
    if (!estimate.ok) return gateFailure(estimate.reasonCodes);
    const summary = await this.#store.budget({
      kind: 'budget.summary',
      settings: config.settings,
      config_valid: true,
      now,
    });
    if (!summary.ok)
      return gateFailure(summary.reasons, summary.outcome === 'unknown');
    const month = summary.value.months.find(
      (item) => item.budget_month === calendar.value.state.month,
    );
    const pool = month?.pools.find(
      (item) => item.pool_id === route.overagePoolId,
    );
    if (pool === undefined) return gateFailure(['overage_unavailable']);
    const remaining =
      BigInt(pool.limit.amount) -
      BigInt(pool.settled.amount) -
      BigInt(pool.unsettled_max_liability.amount);
    if (remaining < BigInt(estimate.maxLiability))
      return gateFailure(['overage_insufficient']);
    const requested = await this.#store.budget({
      kind: 'budget.request_overage',
      approval_id: this.#newId(),
      request_id: request.request_id,
      pool_id: route.overagePoolId,
      budget_month: calendar.value.state.month,
      currency: config.settings.currency,
      max_liability: estimate.maxLiability,
      overage_remaining: remaining.toString(),
      now,
      expires_at: now + OVERAGE_APPROVAL_TTL_MS,
    });
    if (!requested.ok)
      return gateFailure(requested.reasons, requested.outcome === 'unknown');
    return {
      ok: true,
      value: {
        approval: requested.value.approval,
        duplicate: requested.value.duplicate,
      },
    };
  }

  // 超過枠の承認・拒否（main の OS の確認ダイアログの後に端末から届く）。画面で見せた request_id と M が記録と一致する
  // ときだけ決める。二度押しでも承認は 1 件。
  async decideOverage(input: {
    readonly approval_id: string;
    readonly budget_request_id: string;
    readonly max_liability: Money;
    readonly decision: 'approve' | 'reject';
    readonly request: BudgetRequestRef;
  }): Promise<GateResult<OverageApprovalRecord>> {
    const result = await this.#store.budget({
      kind: 'budget.approve_overage',
      approval_id: input.approval_id,
      budget_request_id: input.budget_request_id,
      currency: input.max_liability.currency,
      max_liability: input.max_liability.amount,
      decision: input.decision,
      now: this.#now(),
      request: input.request,
    });
    return result.ok
      ? { ok: true, value: result.value.approval }
      : gateFailure(result.reasons, result.outcome === 'unknown');
  }

  // M 超過の確認（本人が見た実費と M が記録と一致して、実費が M を超えるときだけ、その枠と子孫の枠の受付の停止を解く）。
  async reviewOverrun(input: {
    readonly reservation_id: string;
    readonly expected_revision: string;
    readonly actual_gross: Money;
    readonly max_liability: Money;
    readonly request: BudgetRequestRef;
  }): Promise<GateResult<BudgetReservationView>> {
    if (input.actual_gross.currency !== input.max_liability.currency)
      return gateFailure(['currency_mismatch']);
    const result = await this.#store.budget({
      kind: 'budget.review_overrun',
      reservation_id: input.reservation_id,
      expected_revision: input.expected_revision,
      currency: input.actual_gross.currency,
      actual_gross: input.actual_gross.amount,
      max_liability: input.max_liability.amount,
      now: this.#now(),
      request: input.request,
    });
    return result.ok
      ? { ok: true, value: toReservationView(result.value.reservation) }
      : gateFailure(result.reasons, result.outcome === 'unknown');
  }

  // 不明な費用の手での精算（usage 不明の予約に、本人が請求の照合で得た実額を一度だけ。元の月・元の枠のまま）。
  async settleManual(input: {
    readonly reservation_id: string;
    readonly expected_revision: string;
    readonly manual_reconciliation_id: string;
    readonly actual_gross: Money;
    // 本人が請求の照合で得た区分（省略は「クレジット 0・追加の支出＝実費・周期なし」）。クレジットは予約が受付時に
    // 結び付いた同じ周期にだけ充てられる（B07-07）。
    readonly credit_applied?: Money;
    readonly additional_spend?: Money;
    readonly credit_cycle_id?: string | null;
    readonly request: BudgetRequestRef;
  }): Promise<GateResult<BudgetReservationView>> {
    const split = [input.credit_applied, input.additional_spend];
    if (
      split.some(
        (item) =>
          item !== undefined && item.currency !== input.actual_gross.currency,
      )
    )
      return gateFailure(['currency_mismatch']);
    const result = await this.#store.budget({
      kind: 'budget.settle_manual',
      reservation_id: input.reservation_id,
      expected_revision: input.expected_revision,
      manual_reconciliation_id: input.manual_reconciliation_id,
      currency: input.actual_gross.currency,
      actual_gross: input.actual_gross.amount,
      ...(input.credit_applied === undefined
        ? {}
        : { credit_applied: input.credit_applied.amount }),
      ...(input.additional_spend === undefined
        ? {}
        : { additional_spend: input.additional_spend.amount }),
      ...(input.credit_cycle_id === undefined
        ? {}
        : { credit_cycle_id: input.credit_cycle_id }),
      now: this.#now(),
      request: input.request,
    });
    return result.ok
      ? { ok: true, value: toReservationView(result.value.reservation) }
      : gateFailure(result.reasons, result.outcome === 'unknown');
  }

  // 会話（Live）の秒数を、予約に固定した単価の版で金額にする（追加予約は increment、精算の実費は actual。ADR 0049）。
  // 設定が使えない・版がない・確認されていない・通貨が違う・単価がないときは理由のコードを返す。
  liveSecondsAmount(
    ticket: BudgetTicket,
    seconds: number,
    basis: 'increment' | 'actual',
  ):
    | { readonly ok: true; readonly amount: string }
    | { readonly ok: false; readonly reasons: readonly string[] } {
    const config = this.#config;
    if (!config.ok) return { ok: false, reasons: ['config_invalid'] };
    const version = config.config.price_versions.find(
      (item) => item.price_version === ticket.price_version,
    );
    if (version === undefined)
      return { ok: false, reasons: ['price_version_unknown'] };
    const result = computeLiveSecondsAmount({
      budgetCurrency: config.settings.currency,
      priceKey: version.price_key,
      priceVersion: ticket.price_version,
      priceVersions: config.config.price_versions,
      verifiedPriceVersions: config.settings.verifiedPriceVersions,
      billableFrom: iso(ticket.billable_from),
      billableUntil: iso(ticket.billable_until),
      seconds,
      basis,
    });
    return result.ok
      ? { ok: true, amount: result.amount }
      : { ok: false, reasons: result.reasonCodes };
  }

  // live_seconds の単価がある単価の系列（price_key）。ちょうど 1 つあるときだけ返す（なければ・複数あれば、どれを使うか
  // 設定からは決められないので null。会話の予約を受け付けない）。
  livePriceKey(): string | null {
    const config = this.#config;
    if (!config.ok) return null;
    const keys = new Set(
      config.config.price_versions
        .filter((version) =>
          version.rates.some((rate) => rate.category === 'live_seconds'),
        )
        .map((version) => version.price_key),
    );
    return keys.size === 1 ? ([...keys][0] ?? null) : null;
  }

  // 保存済みの予約から、精算・追加予約に渡す券を作り直す（再起動の後の照合・遅れて届いた使用量の精算で使う）。
  // 応答の期限は保存されていないので 0（精算・追加予約では使わない）。なければ null、読めなければ 'unavailable'。
  async ticketOf(
    reservationId: string,
  ): Promise<BudgetTicket | null | 'unavailable'> {
    const result = await this.#store.budget({
      kind: 'budget.reservation_find',
      reservation_id: reservationId,
      request_id: null,
    });
    if (!result.ok) return 'unavailable';
    if (result.value === null) return null;
    // 保存した予約の受付の時刻から、会話の課金され得る期間（2 時間）を作る。
    return toTicket(
      result.value,
      result.value.approvalId !== null,
      0,
      result.value.createdAt,
      result.value.createdAt + LIVE_BILLABLE_WINDOW_MS,
    );
  }

  // 予約の今の版（経路の検査の「版の照合」に使う）。読めなければ 'unavailable'、なければ null。
  async reservationRevision(
    reservationId: string,
  ): Promise<string | null | 'unavailable'> {
    const result = await this.#store.budget({
      kind: 'budget.reservation_find',
      reservation_id: reservationId,
      request_id: null,
    });
    if (!result.ok) return 'unavailable';
    return result.value === null ? null : result.value.revision;
  }

  // 状態欄の「予算保留」（契約の BudgetHoldState）。金額を含めない。
  async holdState(): Promise<BudgetHoldStateView> {
    const config = this.#config;
    if (!config.ok)
      return { held: true, reasons: ['config_invalid'], held_pools: [] };
    const reasons = new Set<BudgetGateHoldReason>();
    const now = this.#now();
    const check = await this.#store.budget({
      kind: 'budget.calendar_check',
      now,
    });
    if (!check.ok) reasons.add('calendar_unavailable');
    else
      for (const code of check.value.reasons)
        reasons.add(
          code === 'clock_regressed'
            ? 'clock_regressed'
            : code === 'invalid_calendar_state'
              ? 'calendar_mismatch'
              : 'calendar_unavailable',
        );
    let heldPools: BudgetHoldStateView['held_pools'] = [];
    const summary = await this.#store.budget({
      kind: 'budget.summary',
      settings: config.settings,
      config_valid: true,
      now,
    });
    if (summary.ok) {
      const current = summary.value.months.find(
        (month) => month.budget_month === summary.value.current_month,
      );
      heldPools = (current?.pools ?? [])
        .filter((pool) => pool.hold_reasons.length > 0)
        .map((pool) => ({
          pool_id: pool.pool_id,
          hold_reasons: [...pool.hold_reasons],
        }));
    } else if (summary.reasons.includes('unknown_pool'))
      reasons.add('reservation_pool_unknown');
    else reasons.add('calendar_unavailable');
    const ordered = HOLD_ORDER.filter((reason) => reasons.has(reason));
    const creditStatus = await this.creditStatus();
    const creditHold: BudgetCreditHoldView | null =
      creditStatus.hold === null
        ? null
        : { reason: creditStatus.hold, profile_ids: creditStatus.profile_ids };
    return {
      held: ordered.length > 0 || heldPools.length > 0 || creditHold !== null,
      reasons: ordered,
      held_pools: heldPools,
      ...(creditHold === null ? {} : { credit_hold: creditHold }),
    };
  }

  // クレジットを充てる profile の今の状態（B07-07）。設定に credit がなければ configured: false。周期の基準と台帳から、
  // 受け付けられる残りか、保留の理由を求める。台帳を読めないときは不明として保留する（閉じた側）。
  async creditStatus(): Promise<CreditStatusView> {
    const config = this.#config;
    const adoption = await this.#adoptCredit();
    if (!adoption.configured || !config.ok)
      return {
        configured: false,
        profile_ids: [],
        cycle_id: null,
        status: null,
        shared: null,
        expires_at: null,
        observed_at: null,
        balance: null,
        allocated_since: null,
        outstanding: null,
        available: null,
        hold: null,
      };
    // 採用した観測から今の状態を求める。採用に失敗したときは不明として保留する（閉じた側）。判定の時刻は観測を読んだ後に取る。
    const now = this.#now();
    const input = adoption.settings;
    const basis = adoption.state?.current ?? null;
    const stored = adoption.state?.ledger ?? null;
    const ledger =
      stored === null
        ? null
        : {
            allocatedSince: BigInt(stored.allocated_since),
            outstanding: BigInt(stored.outstanding),
          };
    const availability = creditAvailability({
      basis,
      ledger,
      now,
      sharedMaxAgeMs: input.config.shared_observation_max_age_ms,
    });
    return {
      configured: true,
      profile_ids: [...input.config.profile_ids],
      cycle_id: basis?.cycleId ?? null,
      status: basis?.status ?? null,
      shared: basis?.shared ?? null,
      expires_at: basis === null ? null : iso(basis.expiresAt),
      observed_at: basis === null ? null : iso(basis.observedAt),
      balance: basis?.balance ?? null,
      allocated_since:
        ledger === null ? null : ledger.allocatedSince.toString(),
      outstanding: ledger === null ? null : ledger.outstanding.toString(),
      available: availability.ok ? availability.available.toString() : null,
      hold: availability.ok ? null : availability.reason,
    };
  }

  // 本人が予算月を確かめ直す前に見る状態（CLI が表示する）。
  async calendarStatus(): Promise<CalendarStatus> {
    const config = this.#config;
    const now = this.#now();
    const check = await this.#store.budget({
      kind: 'budget.calendar_check',
      now,
    });
    return {
      configured: config.ok,
      configured_time_zone: config.ok ? config.timeZone : null,
      check: check.ok ? check.value : null,
      checked_at: iso(now),
    };
  }

  // 本人による予算月の確かめ直し（承認を伴う操作。中枢のローカルの CLI から呼ぶ）。本人が見た月と始まりを渡し、
  // 今の状態と一致するときだけ記録する。本人が見た状態の版（confirmation_revision）と時計（checked_at）も渡し、
  // 古い入力の送り直しで新しい状態を承認しない。保留が解ければ知らせる。
  async confirmCalendar(input: {
    readonly reason: CalendarConfirmReason;
    readonly month: string;
    readonly month_start: string;
    readonly revision: string;
    readonly observed_at: string;
  }): Promise<
    | { readonly ok: true; readonly check: BudgetCalendarCheck }
    | { readonly ok: false; readonly reasons: readonly string[] }
  > {
    const monthStart = Date.parse(input.month_start);
    if (Number.isNaN(monthStart))
      return { ok: false, reasons: ['month_start_invalid'] };
    const observedAt = Date.parse(input.observed_at);
    if (Number.isNaN(observedAt))
      return { ok: false, reasons: ['observed_at_invalid'] };
    const result = await this.#store.budget({
      kind: 'budget.calendar_confirm',
      confirmation_id: this.#newId(),
      reason:
        input.reason === 'clock_regressed'
          ? 'clock_regressed'
          : 'invalid_calendar_state',
      month: input.month,
      month_start: monthStart,
      expected_revision: input.revision,
      observed_at: observedAt,
      now: this.#now(),
    });
    if (!result.ok) return { ok: false, reasons: result.reasons };
    const check: BudgetCalendarCheck = {
      state: result.value.state,
      reasons: result.value.reasons,
      stale: result.value.stale,
      recorded_month_start: result.value.recorded_month_start,
      recomputed_month_start: result.value.recomputed_month_start,
      regression_floor: result.value.regression_floor,
      confirmation_revision: result.value.confirmation_revision,
    };
    if (check.reasons.length === 0 && check.state !== null)
      this.#emit({ kind: 'hold_cleared', month: check.state.month });
    return { ok: true, check };
  }
}
