// 保存期限の掃除の job（設計 03 保存期限、ADR 0043・0048・0051・0053、B06-06d1）。
//
// 起動の直後と、起動中は 5 分ごと（SWEEP_INTERVAL_MS）に、次の順で行う。
//   1. DB の行を読む（retention.sweep_rows）。
//   2. domain の sweepPlan で計画を作る（時計は注入。時計が巻き戻ったら、命令へ渡す now を最終確認の時刻にする）。
//   3. 計画の操作を DB worker の命令で実行する（本文の削除・90 日の削除・予算の月の削除・undo_records の掃除）。
//   4. 掃除の記録（SweepRecord）を確定してゲートを開いた後で、削除を伴ったときだけ WAL を切り詰め、間隔（既定 1 日）を
//      空けて VACUUM する（後始末は記録の外。VACUUM の間もゲートを閉じない。ADR 0053）。
// 掃除の記録（SweepRecord）を startupGate に渡し、済むまで検索・クラウドへの送信・自動利用を許さない。
// 時計・最終確認時刻・epoch は Core のメモリーだけに置く（保存・復帰の検知は B06-07）。
//
// LLM とクライアントは、何を消すか・ゲートが開いているかを決めない。計画は domain、実行は DB worker が持つ。

import {
  SWEEP_INTERVAL_MS,
  isRowUsable,
  startupGate,
  sweepDue,
  sweepPlan,
} from '@buddy/domain';
import type { StartupGateDecision, SweepRecord, SweepRow } from '@buddy/domain';
import type {
  BudgetPurgeValue,
  CheckpointValue,
  DbWorkerClient,
  OperationCursor,
  RetentionBatchValue,
  UndoPurgeValue,
} from '@buddy/storage';

// 掃除の入力の読み出しと、計画の操作の実行の口。Core の試験では差し替える。
export interface RetentionSweepPort {
  readRows(now: number): Promise<readonly SweepRow[]>;
  eraseDueBodies(
    now: number,
    after: OperationCursor | null,
  ): Promise<RetentionBatchValue>;
  purgeDueOperations(
    now: number,
    after: OperationCursor | null,
  ): Promise<RetentionBatchValue>;
  purgeBudgetMonth(month: string, now: number): Promise<BudgetPurgeValue>;
  purgeUndoRecords(now: number): Promise<UndoPurgeValue>;
  checkpoint(): Promise<CheckpointValue>;
  vacuum(): Promise<void>;
}

export class RetentionSweepCallError extends Error {
  readonly reasons: readonly string[];
  readonly outcome: 'rejected' | 'unknown';
  constructor(reasons: readonly string[], outcome: 'rejected' | 'unknown') {
    super(reasons.join(', '));
    this.name = 'RetentionSweepCallError';
    this.reasons = reasons;
    this.outcome = outcome;
  }
}

type SweepCallResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

function failure<T extends SweepCallResult>(
  result: T,
): asserts result is Extract<T, { readonly ok: true }> {
  if (!result.ok)
    throw new RetentionSweepCallError(result.reasons, result.outcome);
}

// DB worker の命令へつなぐ口。domain の計画の種類と、命令の種類をここだけで対応させる。
export function createRetentionSweepPort(
  store: DbWorkerClient,
): RetentionSweepPort {
  return {
    async readRows(now) {
      const result = await store.retention({
        kind: 'retention.sweep_rows',
        now,
      });
      failure(result);
      return result.value.rows;
    },
    async eraseDueBodies(now, after) {
      const result = await store.retention({
        kind: 'retention.erase_due_bodies',
        now,
        limit: 50,
        after,
      });
      failure(result);
      return result.value;
    },
    async purgeDueOperations(now, after) {
      const result = await store.retention({
        kind: 'retention.purge_due_operations',
        now,
        limit: 50,
        after,
      });
      failure(result);
      return result.value;
    },
    async purgeBudgetMonth(month, now) {
      const result = await store.budget({
        kind: 'budget.purge_month',
        budget_month: month,
        now,
      });
      failure(result);
      return result.value;
    },
    async purgeUndoRecords(now) {
      const result = await store.retention({
        kind: 'retention.purge_undo_records',
        now,
      });
      failure(result);
      return result.value;
    },
    async checkpoint() {
      const result = await store.retention({ kind: 'retention.checkpoint' });
      failure(result);
      return result.value;
    },
    async vacuum() {
      const result = await store.retention({ kind: 'retention.vacuum' });
      failure(result);
    },
  };
}

export interface RetentionSweeperOptions {
  readonly port: RetentionSweepPort;
  // 起動・復帰ごとの識別子（startupGate の epoch）。復帰は起動と同じく新しい値にする（B06-07）。
  readonly epoch: string;
  readonly now: () => number;
  readonly log?: (message: string) => void;
  // VACUUM の間隔。原本に決めがないので 1 日に 1 回を仮の値にする（ADR 0053）。
  readonly vacuumIntervalMs?: number;
  // 定期実行の間隔（ADR 0043 の U55。既定は 5 分）。
  readonly sweepIntervalMs?: number;
}

const DEFAULT_VACUUM_INTERVAL_MS = 24 * 60 * 60_000;
// 命令の拒否のうち、計画の側でも保留にしている理由。失敗の件数に数えない（ゲートを閉じない）。
const EXPECTED_HOLDS: ReadonlySet<string> = new Set([
  'not_due',
  'compensation_open',
  'month_has_open_rows',
  'calendar_invalid',
  'task_content_not_migrated',
  'unknown_held',
  'operation_not_finished',
  'completed_at_missing',
  'operation_not_found',
]);

const iso = (millis: number): string =>
  new Date(millis).toISOString().replace('.000Z', 'Z');

export class RetentionSweeper {
  readonly #port: RetentionSweepPort;
  readonly #epoch: string;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #vacuumIntervalMs: number;
  readonly #sweepIntervalMs: number;
  #lastCheckedAt: string | null = null;
  #lastCompletedAt: string | null = null;
  // 起動時の VACUUM はしない（間隔は起動の時刻から数える。前回の時刻は保存しない。U114）。
  #lastVacuumAt: number;
  // 削除を伴った掃除の後の後始末が済んでいない。checkpoint（ログの切り詰め）と VACUUM は別々に持つ
  // （checkpoint が済んでも、間隔で延期した VACUUM は次の掃除へ引き継ぐ）。
  #checkpointPending = false;
  #vacuumPending = false;
  // 外部送出の区間を保持している数（lease）。0 になるまで、新しい掃除は本体に入らない。
  #sendLeases = 0;
  #leasesDrained: (() => void) | null = null;
  #maintenance: Promise<void> | null = null;
  #record: SweepRecord;
  // まだ一度も掃除を始めていない（ゲートは sweep_not_started）。
  #started = false;
  #running: Promise<SweepRecord> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: RetentionSweeperOptions) {
    this.#port = options.port;
    this.#epoch = options.epoch;
    this.#now = options.now;
    this.#log = options.log ?? (() => undefined);
    this.#vacuumIntervalMs =
      options.vacuumIntervalMs ?? DEFAULT_VACUUM_INTERVAL_MS;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.#lastVacuumAt = this.#now();
    this.#record = {
      epoch: this.#epoch,
      status: 'running',
      completed_at: null,
      failed_actions: 0,
      use_blocked: [],
    };
  }

  // 起動の直後はゲートを閉じたまま、最初の掃除を始める（済むまで検索・送信・自動利用を許さない）。
  // 定期の確認は sweepIntervalMs の 1/5（既定は 1 分）ごとに sweepDue を見る。前回の完了から間隔が過ぎた最初の確認で
  // 始めるので、掃除の所要時間の分だけ周期が 2 倍にずれることがない（P3）。
  start(): void {
    if (this.#closed) return;
    void this.runOnce(true).catch(() => undefined);
    this.#timer = setInterval(
      () => {
        const now = this.#now();
        if (sweepDue(this.#lastCompletedAt, iso(now)))
          void this.runOnce(false).catch(() => undefined);
      },
      Math.max(1, Math.floor(this.#sweepIntervalMs / 5)),
    );
    this.#timer.unref?.();
  }

  // 新しい掃除を始めず、実行中の掃除は次の区切りで中断する（失敗の記録は作らない。ゲートは閉じたまま）。
  // 終わるまで待つのは drain()。
  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  // 今のゲートの判定。startupGate の結果をそのまま返す（検索・クラウド送信・自動利用の入口が読む）。
  // 呼ぶたびに今の時計で判定し直し、掃除の記録が古くなった（sweep_stale）ことも取り逃さない。
  gate(): StartupGateDecision {
    return this.#gateAt(this.#now());
  }

  // 行 1 件を検索・送信・自動利用に使ってよいか（use_blocked を通す）。
  isRowUsable(family: SweepRow['family'], id: string): boolean {
    return isRowUsable(this.gate(), family, id);
  }

  record(): SweepRecord {
    return this.#record;
  }

  // 掃除が済むまで待つ（起動の直後の要求・試験）。失敗しても拒否しない（ゲートが閉じたままになる）。
  // 後始末（checkpoint・VACUUM）は待たない（ゲートの判定に関わらないので、ターンを VACUUM の分だけ待たせない）。
  idle(): Promise<SweepRecord> {
    return this.#running ?? Promise.resolve(this.#record);
  }

  // 掃除と後始末がすべて終わるまで待つ（停止の前。DB を閉じる前に呼ぶ）。
  async drain(): Promise<void> {
    for (;;) {
      const pending = this.#running ?? this.#maintenance;
      if (pending === null) return;
      await pending.then(
        () => undefined,
        () => undefined,
      );
    }
  }

  // 外部への送出の区間（ゲートの確認から送信の終わりまで）を、掃除の本体と直列にする貸し出し。
  // 掃除が動いている・待っている・ゲートが閉じているときは null を返し、呼び出し側は送出意図を記録する前に止める。
  // 貸し出し中に始まった掃除は、返した release が呼ばれる（送信が終わる）までは本体に入らない（ADR 0053）。
  lease(): (() => void) | null {
    if (this.#closed || this.#running !== null || !this.gate().cloud_send)
      return null;
    this.#sendLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#sendLeases -= 1;
      if (this.#sendLeases === 0) {
        const wake = this.#leasesDrained;
        this.#leasesDrained = null;
        wake?.();
      }
    };
  }

  #waitForLeases(): Promise<void> {
    if (this.#sendLeases === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#leasesDrained = resolve;
    });
  }

  // 1 回の掃除。force が false のときは、前回から間隔が過ぎていなければ何もしない。
  runOnce(force: boolean): Promise<SweepRecord> {
    if (this.#running !== null) return this.#running;
    const now = this.#now();
    if (!force && !sweepDue(this.#lastCompletedAt, iso(now))) {
      return Promise.resolve(this.#record);
    }
    this.#started = true;
    this.#record = {
      epoch: this.#epoch,
      status: 'running',
      completed_at: null,
      failed_actions: 0,
      use_blocked: [],
    };
    // 掃除の間は running の記録でゲートが閉じる（済んだことの記録だけを根拠に開く）。
    // 送出中の区間があれば、その終わりを待ってから本体に入る（記録は running なので、新しい送出は始まらない）。
    this.#running = this.#waitForLeases()
      .then(() => this.#sweep(this.#now()))
      .then((record) => {
        // 記録を確定した後に後始末を始める（ゲートはもう開いている）。
        this.#startMaintenance();
        return record;
      })
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  async #sweep(startedAt: number): Promise<SweepRecord> {
    let failed = 0;
    let usedBlocked: SweepRecord['use_blocked'] = [];
    let completedAt: number;
    try {
      this.#checkOpen();
      const rows = await this.#port.readRows(startedAt);
      const plan = sweepPlan({
        now: iso(startedAt),
        last_checked_at: this.#lastCheckedAt,
        rows,
      });
      if (!plan.ok) {
        // 時計・最終確認時刻が読めない。何も消さず、ゲートを閉じたままにする。
        this.#record = {
          epoch: this.#epoch,
          status: 'failed',
          completed_at: iso(startedAt),
          failed_actions: 1,
          use_blocked: [],
        };
        return this.#record;
      }
      this.#checkOpen();
      usedBlocked = plan.use_blocked;
      // 巻き戻り中は、命令へ渡す now を最終確認の時刻にする（期限を延ばさない。ADR 0043）。
      const effectiveNow = Date.parse(plan.clock.effective_now);
      let deleted = 0;

      const bodyPlanned = plan.actions.some(
        (action) =>
          action.family === 'operation' && action.action === 'erase_body',
      );
      const receiptPlanned = plan.actions.some(
        (action) =>
          action.family === 'operation' && action.action === 'delete_row',
      );

      // 補償のない取り消しの記録を先に消し、90 日の削除が止まらないようにする（ADR 0051 の引き継ぎ）。
      if (receiptPlanned) {
        this.#checkOpen();
        try {
          const undo = await this.#port.purgeUndoRecords(effectiveNow);
          deleted += undo.purged;
        } catch (error) {
          // 取り消しの記録が消せなくても、本文・予算の削除は続ける（失敗に数え、ゲートは閉じる）。
          if (!isExpectedHold(error)) failed += 1;
        }
      }
      if (bodyPlanned) {
        this.#checkOpen();
        const count = await this.#runBatch('body', effectiveNow);
        failed += count.failed;
        deleted += count.processed;
      }
      if (receiptPlanned) {
        this.#checkOpen();
        const count = await this.#runBatch('receipt', effectiveNow);
        failed += count.failed;
        deleted += count.processed;
      }

      // 月は、計画の操作の ID（live_session・承認・予約の ID）から、入力の予算の月の行を引いて決める。
      const monthOf = budgetMonthOf(rows);
      const months = new Set<string>();
      for (const action of plan.actions) {
        if (action.family !== 'budget_month' || action.table === undefined)
          continue;
        const month = monthOf.get(`${action.table}:${action.id}`);
        // 入力に無い ID は計画の不整合。消さずに失敗に数える。
        if (month === undefined) failed += 1;
        else months.add(month);
      }
      for (const month of months) {
        this.#checkOpen();
        try {
          const purged = await this.#port.purgeBudgetMonth(month, effectiveNow);
          deleted +=
            purged.deleted_live_sessions +
            purged.deleted_approvals +
            purged.deleted_reservations;
        } catch (error) {
          if (!isExpectedHold(error)) failed += 1;
        }
      }

      // 時計の判定は進める（next_last_checked_at は戻らない）。予算の記録は巻き戻り中に消していない。
      this.#lastCheckedAt = plan.clock.next_last_checked_at;

      // 最後の命令を待っている間に停止された掃除は、完了の記録を作らない（ゲートを開けない）。
      this.#checkOpen();
      // 削除があれば、記録の確定の後に checkpoint・VACUUM をする（記録の外）。
      if (deleted > 0) {
        this.#checkpointPending = true;
        this.#vacuumPending = true;
      }

      completedAt = this.#now();
      this.#lastCompletedAt = iso(completedAt);
      this.#record = {
        epoch: this.#epoch,
        status: failed === 0 ? 'completed' : 'failed',
        completed_at: iso(completedAt),
        failed_actions: failed,
        use_blocked: usedBlocked,
      };
    } catch (error) {
      // 停止による中断。失敗の記録は作らない（記録は running のまま。ゲートは閉じている）。
      if (error instanceof SweepAborted) return this.#record;
      failed += 1;
      this.#log(
        `保存期限の掃除に失敗しました（${reasonOf(error)}）。検索・クラウドへの送信・自動利用は止めたままにします。`,
      );
      completedAt = this.#now();
      this.#record = {
        epoch: this.#epoch,
        status: 'failed',
        completed_at: iso(completedAt),
        failed_actions: failed,
        use_blocked: usedBlocked,
      };
    }
    return this.#record;
  }

  async #runBatch(
    kind: 'body' | 'receipt',
    now: number,
  ): Promise<{ processed: number; failed: number }> {
    let after: OperationCursor | null = null;
    let processed = 0;
    let failed = 0;
    // 同じ next を繰り返さない（命令が進まないときに無限に呼ばない）。
    const seen = new Set<string>();
    for (;;) {
      this.#checkOpen();
      let batch: RetentionBatchValue;
      try {
        batch =
          kind === 'body'
            ? await this.#port.eraseDueBodies(now, after)
            : await this.#port.purgeDueOperations(now, after);
      } catch (error) {
        if (!isExpectedHold(error)) failed += 1;
        return { processed, failed };
      }
      processed += batch.processed.length;
      failed += batch.skipped.filter(
        (item) => !item.reasons.every((reason) => EXPECTED_HOLDS.has(reason)),
      ).length;
      if (batch.next === null) return { processed, failed };
      const key = `${batch.next.completed_at}:${batch.next.operation_id}`;
      if (seen.has(key)) {
        // 進まない異常。静かに通さず、失敗に数える。
        this.#log(
          '保存期限の掃除の続きの位置が進みませんでした。この回の続きは次の周期にします。',
        );
        return { processed, failed: failed + 1 };
      }
      seen.add(key);
      after = batch.next;
    }
  }

  #checkOpen(): void {
    if (this.#closed) throw new SweepAborted();
  }

  // 後始末（記録の外）。同時に 1 つだけ。済んでいない分は、次の掃除の後にもう一度試す（削除がなくても引き継ぐ）。
  #startMaintenance(): void {
    if (
      (!this.#checkpointPending && !this.#vacuumPending) ||
      this.#maintenance !== null ||
      this.#closed
    )
      return;
    this.#maintenance = this.#maintain()
      .catch((error: unknown) => {
        this.#log(
          `保存期限の掃除の後始末（checkpoint・VACUUM）に失敗しました（${reasonOf(error)}）。次の掃除の後にもう一度試します。`,
        );
      })
      .finally(() => {
        this.#maintenance = null;
      });
  }

  // checkpoint → VACUUM（間隔を過ぎたとき）→ checkpoint。ログが切り詰められなかった（busy）ときは、その段の
  // 保留を残して次の掃除の後に試す。VACUUM の成功時刻は、後の checkpoint の結果と分けて持つ。
  async #maintain(): Promise<void> {
    if (this.#checkpointPending) {
      this.#checkOpen();
      if (!(await this.#truncatedLog())) return;
      this.#checkpointPending = false;
    }
    if (!this.#vacuumPending) return;
    const now = this.#now();
    if (now - this.#lastVacuumAt < this.#vacuumIntervalMs) return;
    this.#checkOpen();
    await this.#port.vacuum();
    this.#lastVacuumAt = now;
    this.#vacuumPending = false;
    // VACUUM は DB 全体の写しをログに残す。次の自動 checkpoint まで大きいままにしない。
    this.#checkOpen();
    if (!(await this.#truncatedLog())) this.#checkpointPending = true;
  }

  // WAL を切り詰める。他の接続が使用中（busy）で切り詰められなかったときは false。
  async #truncatedLog(): Promise<boolean> {
    const result = await this.#port.checkpoint();
    if (result.busy === 0) return true;
    this.#log(
      '保存期限の掃除の後始末で、ログを切り詰められませんでした（他の接続が使用中）。次の掃除の後にもう一度試します。',
    );
    return false;
  }

  #gateAt(now: number): StartupGateDecision {
    return startupGate({
      epoch: this.#epoch,
      now: iso(now),
      last_checked_at: this.#lastCheckedAt,
      sweep: this.#started ? this.#record : null,
    });
  }
}

// 停止による中断（失敗ではない）。
class SweepAborted extends Error {
  constructor() {
    super('sweep_aborted');
    this.name = 'SweepAborted';
  }
}

// 予算の月の行から、計画の操作の ID（表と ID）→ 月 を引く表。
function budgetMonthOf(rows: readonly SweepRow[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.family !== 'budget_month') continue;
    for (const reservation of row.reservations) {
      map.set(
        `budget_reservations:${reservation.reservation_id}`,
        row.budget_month,
      );
      for (const id of reservation.live_session_ids)
        map.set(`live_sessions:${id}`, row.budget_month);
      for (const id of reservation.approval_ids)
        map.set(`budget_overage_approvals:${id}`, row.budget_month);
    }
    for (const id of row.unused_approval_ids)
      map.set(`budget_overage_approvals:${id}`, row.budget_month);
  }
  return map;
}

function isExpectedHold(error: unknown): boolean {
  return (
    error instanceof RetentionSweepCallError &&
    error.outcome === 'rejected' &&
    error.reasons.length > 0 &&
    error.reasons.every((reason) => EXPECTED_HOLDS.has(reason))
  );
}

function reasonOf(error: unknown): string {
  if (error instanceof RetentionSweepCallError) return error.reasons.join(',');
  return error instanceof Error ? error.name : 'unknown';
}
