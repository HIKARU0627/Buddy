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
// 結果の理由にはコードだけを入れ、金額・本文を記録へ出さない。

import { randomUUID } from 'node:crypto';
import { computeReservation, overageRouteOf, routePool } from '@buddy/domain';
import type {
  BudgetHoldReason,
  BudgetOrigin,
  BudgetService,
  P95Measurement,
  PriceCategory,
} from '@buddy/domain';
import type {
  BudgetCalendarCheck,
  BudgetOp,
  BudgetOpKind,
  BudgetOpOutcome,
  BudgetReservationValue,
} from '@buddy/storage';
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
  readonly reserved: string;
  readonly max_liability: string;
  readonly revision: string;
  // 超過枠で受け付けた（承認を使った）。
  readonly routed: boolean;
  // 応答の期限（UTC のミリ秒）。
  readonly deadline: number;
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

// 契約の BudgetHoldState と同じ形。
export interface BudgetHoldStateView {
  readonly held: boolean;
  readonly reasons: readonly BudgetGateHoldReason[];
  readonly held_pools: readonly {
    readonly pool_id: string;
    readonly hold_reasons: readonly BudgetHoldReason[];
  }[];
}

export interface BudgetResumeEvent {
  // month_rolled: 予算月が替わった。hold_cleared: 本人の確かめ直しで予算月の保留が解けた。
  readonly kind: 'month_rolled' | 'hold_cleared';
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
  readonly timers?: GateTimers;
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
      /^(r_limit|m_limit|overrun_hold):/u.test(code),
  );

const HOLD_ORDER: readonly BudgetGateHoldReason[] = [
  'config_invalid',
  'clock_regressed',
  'calendar_mismatch',
  'reservation_pool_unknown',
  'calendar_unavailable',
];

const iso = (millis: number): string => new Date(millis).toISOString();

const toTicket = (
  reservation: BudgetReservationValue,
  routed: boolean,
  deadline: number,
): BudgetTicket => ({
  reservation_id: reservation.reservationId,
  request_id: reservation.requestId,
  pool_id: reservation.poolId,
  budget_month: reservation.budgetMonth,
  reserved: reservation.reserved,
  max_liability: reservation.maxLiability,
  revision: reservation.revision,
  routed,
  deadline,
});

export class BudgetGate {
  readonly #store: BudgetStore;
  readonly #config: LoadedBudgetConfig;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #newId: () => string;
  readonly #p95ProfileIds: readonly string[];
  readonly #timers: GateTimers;
  readonly #beforeAdmit: (request: PaidRequest) => Promise<void> | void;
  readonly #beforeDispatch: (ticket: BudgetTicket) => Promise<void> | void;
  readonly #afterDispatch: (ticket: BudgetTicket) => Promise<void> | void;
  readonly #listeners = new Set<(event: BudgetResumeEvent) => void>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: BudgetGateOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#now = options.now;
    this.#log = options.log ?? (() => undefined);
    this.#newId = options.newId ?? (() => randomUUID());
    this.#p95ProfileIds = options.p95ProfileIds ?? [];
    this.#timers = options.timers ?? DEFAULT_TIMERS;
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
    return true;
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
    for (let attempt = 0; ; attempt += 1) {
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
      const estimate = computeReservation({
        budgetCurrency: config.settings.currency,
        priceKey: request.price_key,
        priceVersions: config.config.price_versions,
        verifiedPriceVersions: config.settings.verifiedPriceVersions,
        billableFrom: iso(now),
        billableUntil: iso(deadline),
        quantities: request.quantities,
        profileId: request.profile_id,
        profileRevision: request.profile_revision,
        p95ProfileIds: this.#p95ProfileIds,
        measurement: request.p95 ?? null,
      });
      if (!estimate.ok) return reject(estimate.reasonCodes);
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
      if (!value.admitted || value.reservation === null)
        return reject(value.reason_codes);
      return {
        ok: true,
        ticket: toTicket(value.reservation, value.routed, deadline),
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
    const result = await this.#store.budget({
      kind: 'budget.dispatch_intent',
      reservation_id: ticket.reservation_id,
      now: this.#now(),
      deadline: ticket.deadline,
    });
    if (result.ok) return { ok: true };
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
    const result = await this.#store.budget({
      kind: 'budget.settle',
      reservation_id: ticket.reservation_id,
      request_id: ticket.request_id,
      provider: usage.provider,
      provider_reconciliation_id: usage.reconciliation_id,
      actual_gross: usage.actual_gross,
      now: this.#now(),
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
    const result = await this.#store.budget({
      kind: 'budget.top_up',
      reservation_id: ticket.reservation_id,
      expected_revision: ticket.revision,
      delta_reserved: delta.reserved,
      delta_max_liability: delta.max_liability,
      settings: config.settings,
      now: this.#now(),
    });
    if (!result.ok) return { ok: false, reasons: result.reasons };
    return {
      ok: true,
      ticket: toTicket(
        result.value.reservation,
        ticket.routed,
        ticket.deadline,
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
    // 時計は 1 回だけ読み、期限の判定と timer の残り時間に同じ値を使う（読み直した時計で期限を過ぎていても送る
    // 隙間を作らない。Codex の再確認 P1）。
    const remaining = ticket.deadline - this.#now();
    const stopped = callerAborted()
      ? 'discarded'
      : remaining <= 0
        ? 'reservation_expired'
        : null;
    if (stopped !== null) {
      await this.unknown(ticket);
      return { kind: 'usage_unknown', ticket, reasons: [stopped, 'not_sent'] };
    }
    const controller = new AbortController();
    const cancelTimer = this.#timers.set(remaining, () =>
      controller.abort('timeout'),
    );
    const discard = () => controller.abort('discarded');
    options.signal?.addEventListener('abort', discard, { once: true });
    // timer と listener を用意する間に中断された（timer がすぐ発火した・呼び出し側が中断した）なら送らない。
    if (controller.signal.aborted || callerAborted()) {
      cancelTimer();
      options.signal?.removeEventListener('abort', discard);
      await this.unknown(ticket);
      return {
        kind: 'usage_unknown',
        ticket,
        reasons: [
          controller.signal.reason === 'timeout'
            ? 'reservation_expired'
            : 'discarded',
          'not_sent',
        ],
      };
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
      const ticket = toTicket(reservation, reservation.approvalId !== null, 0);
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
    return {
      held: ordered.length > 0 || heldPools.length > 0,
      reasons: ordered,
      held_pools: heldPools,
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
