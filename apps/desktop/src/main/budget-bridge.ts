// デスクトップの main の予算の確認の経路（B07-05、ADR 0038。設計 05 F02、01 設定・運用・承認画面、本人の判断 2026-10-23）。
//
// - 画面へ渡すのは参照（ref）だけ。承認 ID・予算の要求 ID・予約 ID・予約の版は main の中に持ち、画面へも IPC へもログへも
//   出さない（画面から送られた ref を main が解決する。解決できなければ entry_not_found）。金額・枠・予算月・期限は本人が
//   見て決める値なので、表示用に画面へ渡す（個人の金額なので、ログ・契約の例・撮影には出さない。合成の XTS だけを使う）。
// - 超過枠の承認・M 超過の確認・手での精算は、main の OS の確認ダイアログを 1 回だけ出す（本人の判断: 承認は main の OS の
//   確認ダイアログで 1 回）。ダイアログに出す値は main が中枢の利用状況から読んだ値（手での精算は本人が入力した値）で、
//   画面から受け取らない。確認は対象・状態・世代に結び付ける: 確認の前後で項目が今も同じか（同じ項目・同じ M・同じ版・
//   期限内）、世代（ロック・切断）と接続範囲が同じか、確認の最中に入出力が止まっていないか（承認・確認）を確かめ、
//   違えば送らない。承認は 1 つの予算の要求と M に固定して送る（中枢も記録と照合して拒否する）。
// - 見送り（承認の reject）は承認を増やさないので確認を挟まない。
// - 結果が分からない命令は、次の利用状況の読み取りで中枢の今の状態を読むまで、同じ項目から送らせない（自動では送り直さない）。
//   中枢は承認・確認・精算を命令の再送でも別の命令でも同じ結果にする（二度押しでも承認は 1 件）。
// - 世代（ロック・切断）: reset で項目・参照・保留を捨て、非同期の処理は各 await の後・内部の状態を変える前・送る前に世代を
//   照合する（またいだ処理は何も送らず、何も変えない）。
// - 予算保留（中枢のスナップショットの budget_hold）は、利用状況と一緒に読み、状態欄へ渡す。
// Electron に依存しない（node:test で試験する）。
import type {
  BudgetUsageSummary,
  DesktopBudgetEntry,
  Snapshot,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';

interface Money {
  readonly currency: string;
  readonly amount: string;
}

// 本人の確認（OS の確認ダイアログ）に出す値。main が中枢の利用状況から作る（手での精算の実費・照合 ID は本人の入力）。
export interface BudgetConfirmRequest {
  readonly action: 'approve_overage' | 'review_overrun' | 'settle_manual';
  readonly poolId: string;
  readonly budgetMonth: string;
  readonly maxLiability: Money;
  // approve_overage: 承認を求めた時点の超過枠の残りと承認の期限（UTC）。
  readonly overageRemaining: Money | null;
  readonly expiresAt: string | null;
  // review_overrun: 記録した実費。settle_manual: 本人が入力した実費。
  readonly actualGross: Money | null;
  // settle_manual: 本人が入力した照合 ID。
  readonly reconciliationId: string | null;
}

export type BudgetConfirmResult =
  { readonly scope: string } | DesktopIpcRejectReason;

export interface BudgetHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  readonly newRef: () => string;
  // 本人の確認（OS の確認ダイアログ）。世代・接続範囲の照合は呼び出し側が行う。
  readonly confirm: (
    request: BudgetConfirmRequest,
  ) => Promise<BudgetConfirmResult>;
  // 端末の今の入出力の状態（送る直前に確かめる）。permitted は停止していないこと、epoch は io_epoch。
  readonly io: () => { readonly permitted: boolean; readonly epoch: string };
  // UTC のミリ秒（承認の期限の判定）。
  readonly now: () => number;
  // 画面に出す値（項目・予算保留）が変わった（接続の状態の通知を起こす）。
  readonly changed: () => void;
  readonly log: (code: string) => void;
}

export type BudgetOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DesktopIpcRejectReason };

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

// 項目の中身（main の中にだけ持つ。画面へは DesktopBudgetEntry の表示用の値だけを渡す）。
type BudgetRecord =
  | {
      readonly kind: 'overage_approval';
      readonly key: string;
      readonly approvalId: string;
      // 承認する予算の要求（BudgetOverageApproval.request_id）。承認はこの依頼と M に固定する。
      readonly budgetRequestId: string;
      readonly poolId: string;
      readonly budgetMonth: string;
      readonly maxLiability: Money;
      readonly overageRemaining: Money;
      readonly expiresAt: string;
    }
  | {
      readonly kind: 'overrun_review';
      readonly key: string;
      readonly reservationId: string;
      readonly revision: string;
      readonly poolId: string;
      readonly budgetMonth: string;
      readonly maxLiability: Money;
      readonly actualGross: Money;
    }
  | {
      readonly kind: 'manual_settlement';
      readonly key: string;
      readonly reservationId: string;
      readonly revision: string;
      readonly poolId: string;
      readonly budgetMonth: string;
      readonly maxLiability: Money;
    };

const sameMoney = (a: Money, b: Money): boolean =>
  a.currency === b.currency && a.amount === b.amount;

// 確認した項目が、最新の読み取りの項目と同じ内容か（同じ承認・同じ M・同じ予約の版・同じ実費）。
function sameRecord(a: BudgetRecord, b: BudgetRecord): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.poolId !== b.poolId || a.budgetMonth !== b.budgetMonth) return false;
  if (!sameMoney(a.maxLiability, b.maxLiability)) return false;
  if (a.kind === 'overage_approval' && b.kind === 'overage_approval')
    return (
      a.budgetRequestId === b.budgetRequestId &&
      a.expiresAt === b.expiresAt &&
      sameMoney(a.overageRemaining, b.overageRemaining)
    );
  if (a.kind === 'overrun_review' && b.kind === 'overrun_review')
    return a.revision === b.revision && sameMoney(a.actualGross, b.actualGross);
  if (a.kind === 'manual_settlement' && b.kind === 'manual_settlement')
    return a.revision === b.revision;
  return false;
}

const money = (value: Money): Money => ({
  currency: value.currency,
  amount: value.amount,
});

function recordsOf(summary: BudgetUsageSummary): BudgetRecord[] {
  const records: BudgetRecord[] = [];
  for (const approval of summary.overage_approvals)
    if (approval.status === 'pending')
      records.push({
        kind: 'overage_approval',
        key: `approval:${approval.approval_id}`,
        approvalId: approval.approval_id,
        budgetRequestId: approval.request_id,
        poolId: approval.pool_id,
        budgetMonth: approval.budget_month,
        maxLiability: money(approval.max_liability),
        overageRemaining: money(approval.overage_remaining),
        expiresAt: approval.expires_at,
      });
  for (const reservation of summary.pending_reservations) {
    if (reservation.status === 'usage_unknown')
      records.push({
        kind: 'manual_settlement',
        key: `manual:${reservation.reservation_id}`,
        reservationId: reservation.reservation_id,
        revision: reservation.reservation_revision,
        poolId: reservation.pool_id,
        budgetMonth: reservation.budget_month,
        maxLiability: money(reservation.max_liability),
      });
    else if (
      reservation.status === 'settled' &&
      !reservation.overrun_reviewed &&
      reservation.actual_gross !== null &&
      BigInt(reservation.actual_gross.amount) >
        BigInt(reservation.max_liability.amount)
    )
      records.push({
        kind: 'overrun_review',
        key: `overrun:${reservation.reservation_id}`,
        reservationId: reservation.reservation_id,
        revision: reservation.reservation_revision,
        poolId: reservation.pool_id,
        budgetMonth: reservation.budget_month,
        maxLiability: money(reservation.max_liability),
        actualGross: money(reservation.actual_gross),
      });
  }
  return records;
}

// 項目の並び: 承認待ち（期限の早い順）→ M 超過の確認 → 手での精算。同じ種類は予算月の古い順。
const KIND_ORDER: Readonly<Record<BudgetRecord['kind'], number>> = {
  overage_approval: 0,
  overrun_review: 1,
  manual_settlement: 2,
};

export class BudgetBridge {
  readonly #host: BudgetHost;
  // 最新の読み取りの項目（キー → 項目）と、キー → 参照。参照は同じ項目のあいだ変えない（画面の入力を保つ）。
  #records = new Map<string, BudgetRecord>();
  readonly #refs = new Map<string, string>();
  // 結果が分からなかった項目（キー → そのときの読み取りの通し番号）。それより後に始めた読み取りが成功するまで送らせない。
  readonly #held = new Map<string, number>();
  // 中枢が記録した項目（キー → そのときの読み取りの通し番号）。次の読み取りが項目を一覧から外す（外さなければ戻す）まで、
  // 一覧から隠し、同じ項目から二重に送らせない（二度押しでも承認は 1 件）。
  readonly #done = new Map<string, number>();
  // 中枢のスナップショットの予算保留。null は不明（読めていない・ロック中で中枢が出さない）。
  #hold: boolean | null = null;
  #gen = 0;
  #seq = 0;
  // 読み取りの直列化（同時に 1 つ。進行中に呼ばれたら、その後でもう一度だけ読む）。
  #running: Promise<void> | null = null;
  #again = false;

  constructor(host: BudgetHost) {
    this.#host = host;
  }

  // 表示の権限の世代が進んだ（ロック・切断）: 項目・参照・保留・予算保留を捨てる。進行中の非同期の処理は、世代の照合で
  // 何も送らず何も変えずに終わる。
  reset(): void {
    this.#gen += 1;
    this.#records = new Map();
    this.#refs.clear();
    this.#held.clear();
    this.#done.clear();
    this.#hold = null;
  }

  // 状態欄の予算保留（中枢のスナップショットの budget_hold.held）。不明は null。
  get hold(): boolean | null {
    return this.#hold;
  }

  // 画面に出す項目。
  entries(): DesktopBudgetEntry[] {
    const sorted = [...this.#records.values()]
      .filter((record) => !this.#done.has(record.key))
      .sort(
        (a, b) =>
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          a.budgetMonth.localeCompare(b.budgetMonth) ||
          (a.kind === 'overage_approval' && b.kind === 'overage_approval'
            ? a.expiresAt.localeCompare(b.expiresAt)
            : 0) ||
          a.key.localeCompare(b.key),
      );
    return sorted.map((record): DesktopBudgetEntry => {
      const ref = this.#refs.get(record.key) as string;
      const base = {
        ref,
        pool_id: record.poolId,
        budget_month: record.budgetMonth,
        max_liability: money(record.maxLiability),
        delivery_unknown: this.#held.has(record.key),
      };
      switch (record.kind) {
        case 'overage_approval':
          return {
            ...base,
            kind: 'overage_approval',
            overage_remaining: money(record.overageRemaining),
            actual_gross: null,
            expires_at: record.expiresAt,
          };
        case 'overrun_review':
          return {
            ...base,
            kind: 'overrun_review',
            overage_remaining: null,
            actual_gross: money(record.actualGross),
            expires_at: null,
          };
        case 'manual_settlement':
          return {
            ...base,
            kind: 'manual_settlement',
            overage_remaining: null,
            actual_gross: null,
            expires_at: null,
          };
      }
    });
  }

  #recordOf(ref: string): BudgetRecord | null {
    for (const [key, candidate] of this.#refs)
      if (candidate === ref)
        return this.#done.has(key) ? null : (this.#records.get(key) ?? null);
    return null;
  }

  // --- 読み取り（利用状況と予算保留） ---

  // 中枢の利用状況と予算保留を読む。読めたものだけを反映する（読めなければ前の値のまま）。世代をまたいだ・古い読み取りは
  // 反映しない。画面に出す値が変わったときだけ知らせる。
  refresh(): Promise<void> {
    // 進行中の読み取りがあれば、その後でもう一度だけ読み、同じ約束を返す（待った人は、最新の読み取りの反映まで待つ）。
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    const running = (async () => {
      try {
        do {
          this.#again = false;
          await this.#read();
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = running;
    return running;
  }

  async #read(): Promise<void> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return;
    const seq = ++this.#seq;
    const [usage, snapshot] = await Promise.all([
      connection.request({
        method: 'GET',
        path: '/v1/budget/usage',
        expectedScopeId: scope,
      }),
      connection.request({
        method: 'GET',
        path: '/v1/snapshot',
        expectedScopeId: scope,
      }),
    ]);
    if (gen !== this.#gen) return;
    const before = this.#signature();
    if (
      usage.kind === 'response' &&
      usage.status === 200 &&
      this.#host.contract.valid('BudgetUsageSummary', usage.body)
    ) {
      this.#apply(recordsOf(usage.body as BudgetUsageSummary), seq);
    } else if (
      usage.kind === 'response' &&
      (usage.status === 503 || usage.status === 403)
    ) {
      // 中枢が利用状況を返せない（設定が使えない・ロック中）。古い項目を残さない。
      this.#apply([], seq);
    }
    if (
      snapshot.kind === 'response' &&
      snapshot.status === 200 &&
      this.#host.contract.valid('Snapshot', snapshot.body)
    ) {
      const body = snapshot.body as Snapshot;
      this.#hold =
        body.view === 'full' && body.budget_hold !== null
          ? body.budget_hold.held
          : null;
    }
    if (this.#signature() !== before) this.#host.changed();
  }

  // 読み取った項目を反映する。同じ項目は同じ参照を保つ。この読み取りより前に結果が分からなくなった項目の保留は、
  // 今の状態を読めたので解く（まだ残っていれば命令は適用されていない。残っていなければ適用された）。
  #apply(records: readonly BudgetRecord[], seq: number): void {
    const next = new Map<string, BudgetRecord>();
    for (const record of records) {
      next.set(record.key, record);
      if (!this.#refs.has(record.key))
        this.#refs.set(record.key, this.#host.newRef());
    }
    for (const key of [...this.#refs.keys()])
      if (!next.has(key)) {
        this.#refs.delete(key);
        this.#held.delete(key);
        this.#done.delete(key);
      }
    for (const [key, heldAt] of [...this.#held])
      if (heldAt < seq) this.#held.delete(key);
    for (const [key, doneAt] of [...this.#done])
      if (doneAt < seq) this.#done.delete(key);
    this.#records = next;
  }

  #signature(): string {
    return JSON.stringify([this.entries(), this.#hold]);
  }

  // --- 送る直前の確かめ ---

  // 確認の後に送ってよいか: 世代・接続範囲が確認を出したときと同じ（必要なら停止していない・io_epoch も同じ）。
  #stillAllowed(
    gen: number,
    scope: string,
    io: { readonly permitted: boolean; readonly epoch: string } | null,
  ): DesktopIpcRejectReason | null {
    if (gen !== this.#gen) return 'not_connected';
    const live = this.#host.connection();
    if (live === null || live.state.commandScopeId !== scope)
      return 'not_connected';
    if (io !== null) {
      const now = this.#host.io();
      if (!now.permitted || now.epoch !== io.epoch) return 'input_stopped';
    }
    return null;
  }

  // 承認の期限内か（期限ちょうどは使えない。中枢の規則と同じ）。
  #expired(record: BudgetRecord): boolean {
    return (
      record.kind === 'overage_approval' &&
      this.#host.now() >= Date.parse(record.expiresAt)
    );
  }

  // 確認した項目が、今の項目と同じ内容で、期限内で、結果不明の保留でないか。
  #fresh(confirmed: BudgetRecord): DesktopIpcRejectReason | null {
    const current = this.#records.get(confirmed.key);
    if (current === undefined) return 'preview_stale';
    if (this.#held.has(confirmed.key)) return 'entry_not_found';
    if (!sameRecord(confirmed, current) || this.#expired(current))
      return 'preview_stale';
    return null;
  }

  // 命令を送り、結果を返す。受け付けられたら（200）利用状況を読み直す。
  async #send(
    gen: number,
    scope: string,
    record: BudgetRecord,
    path: string,
    body: Readonly<Record<string, unknown>>,
    schema: 'BudgetOverageApproval' | 'BudgetReservation',
  ): Promise<BudgetOutcome<'durable'>> {
    const live = this.#host.connection();
    if (live === null) return fail('not_connected');
    const outcome = await live.request({
      method: 'POST',
      path,
      body,
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (outcome.kind === 'unknown') {
      // 世代をまたいだ後は、今の世代の保留を作らない。
      if (gen !== this.#gen) return fail('outcome_unknown');
      this.#held.set(record.key, this.#seq);
      this.#host.log('budget_command_outcome_unknown');
      this.#host.changed();
      return fail('outcome_unknown');
    }
    if (
      outcome.status === 200 &&
      this.#host.contract.valid(schema, outcome.body)
    ) {
      // 中枢が記録した。次の読み取りまで、この項目を一覧から隠す（二重に送らせない）。
      if (gen === this.#gen) {
        this.#done.set(record.key, this.#seq);
        this.#host.changed();
      }
      void this.refresh();
      return { ok: true, value: 'durable' };
    }
    // 2xx でも形が契約に合わなければ結果は分からない（自動では送り直さない）。
    if (outcome.status >= 200 && outcome.status < 300) {
      if (gen === this.#gen) {
        this.#held.set(record.key, this.#seq);
        this.#host.changed();
      }
      return fail('outcome_unknown');
    }
    // 記録と合わない（承認の期限切れ・M や版が変わった・決定済みなど）。読み直して、新しい内容から確かめ直す。
    void this.refresh();
    return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
  }

  // --- 超過枠の承認・見送り ---

  async decide(
    ref: string,
    decision: 'approve' | 'reject',
  ): Promise<BudgetOutcome<'durable'>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const record = this.#recordOf(ref);
    if (
      record === null ||
      record.kind !== 'overage_approval' ||
      this.#held.has(record.key)
    )
      return fail('entry_not_found');
    if (this.#expired(record)) return fail('preview_stale');
    if (decision === 'approve') {
      // 承認は支出を許すので、停止していないときだけ。確認は本人が 1 回だけ。
      const io = this.#host.io();
      if (!io.permitted) return fail('input_stopped');
      const confirmed = await this.#host.confirm({
        action: 'approve_overage',
        poolId: record.poolId,
        budgetMonth: record.budgetMonth,
        maxLiability: record.maxLiability,
        overageRemaining: record.overageRemaining,
        expiresAt: record.expiresAt,
        actualGross: null,
        reconciliationId: null,
      });
      const stopped = this.#stillAllowed(gen, scope, io);
      if (stopped !== null) return fail(stopped);
      if (typeof confirmed === 'string') return fail(confirmed);
      // 確認している間に項目・期限が変わっていたら送らない（確認した内容と違う内容を承認させない）。
      const after = this.#fresh(record);
      if (after !== null) return fail(after);
    }
    return this.#send(
      gen,
      scope,
      record,
      `/v1/budget/overage-approvals/${encodeURIComponent(record.approvalId)}/decision`,
      {
        budget_request_id: record.budgetRequestId,
        max_liability: money(record.maxLiability),
        decision,
      },
      'BudgetOverageApproval',
    );
  }

  // --- M 超過の確認 ---

  async reviewOverrun(ref: string): Promise<BudgetOutcome<'durable'>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const record = this.#recordOf(ref);
    if (
      record === null ||
      record.kind !== 'overrun_review' ||
      this.#held.has(record.key)
    )
      return fail('entry_not_found');
    // 確認は、その枠の新しい受付を再開させる（支出を許す）ので、停止していないときだけ。
    const io = this.#host.io();
    if (!io.permitted) return fail('input_stopped');
    const confirmed = await this.#host.confirm({
      action: 'review_overrun',
      poolId: record.poolId,
      budgetMonth: record.budgetMonth,
      maxLiability: record.maxLiability,
      overageRemaining: null,
      expiresAt: null,
      actualGross: record.actualGross,
      reconciliationId: null,
    });
    const stopped = this.#stillAllowed(gen, scope, io);
    if (stopped !== null) return fail(stopped);
    if (typeof confirmed === 'string') return fail(confirmed);
    const after = this.#fresh(record);
    if (after !== null) return fail(after);
    return this.#send(
      gen,
      scope,
      record,
      `/v1/budget/reservations/${encodeURIComponent(record.reservationId)}/overrun-review`,
      {
        expected_reservation_revision: record.revision,
        actual_gross: money(record.actualGross),
        max_liability: money(record.maxLiability),
      },
      'BudgetReservation',
    );
  }

  // --- 不明な費用の手での精算 ---

  // reconciliationId は manual: で始まる照合 ID、amount は通貨単位の百万分の一の整数（画面が入力を変換して送る。通貨は
  // 予約の通貨）。契約の形は IPC の検査（schema）が済ませている。
  async settleManually(
    ref: string,
    reconciliationId: string,
    amount: string,
  ): Promise<BudgetOutcome<'durable'>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const record = this.#recordOf(ref);
    if (
      record === null ||
      record.kind !== 'manual_settlement' ||
      this.#held.has(record.key)
    )
      return fail('entry_not_found');
    const actual: Money = { currency: record.maxLiability.currency, amount };
    const confirmed = await this.#host.confirm({
      action: 'settle_manual',
      poolId: record.poolId,
      budgetMonth: record.budgetMonth,
      maxLiability: record.maxLiability,
      overageRemaining: null,
      expiresAt: null,
      actualGross: actual,
      reconciliationId,
    });
    // 精算は記録の操作で支出を許さないので、停止中でも使える（io は照合しない）。
    const stopped = this.#stillAllowed(gen, scope, null);
    if (stopped !== null) return fail(stopped);
    if (typeof confirmed === 'string') return fail(confirmed);
    const after = this.#fresh(record);
    if (after !== null) return fail(after);
    // クレジットの区分は B07-07 まで初期の規則（クレジット 0・追加の支出＝実費・周期なし。ADR 0034・0038）。
    return this.#send(
      gen,
      scope,
      record,
      `/v1/budget/reservations/${encodeURIComponent(record.reservationId)}/manual-settlement`,
      {
        expected_reservation_revision: record.revision,
        manual_reconciliation_id: reconciliationId,
        actual_gross: actual,
        credit_applied: { currency: actual.currency, amount: '0' },
        additional_spend: actual,
        credit_cycle_id: null,
      },
      'BudgetReservation',
    );
  }
}
