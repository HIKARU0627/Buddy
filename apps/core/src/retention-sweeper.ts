// 保存期限の掃除の job（設計 03 保存期限、ADR 0043・0048・0051・0053・0058、B06-06d1・B06-07a-1）。
//
// 起動の直後と、起動中は 5 分ごと（SWEEP_INTERVAL_MS）に、次の順で行う。
//   1. 時計の状態ファイルを読む（最初の掃除だけ。時計の最終確認時刻と epoch。ADR 0058 の U136）。
//   2. DB の行を読む（retention.sweep_rows。操作・予算の月・発言・元情報・記憶・派生物）。
//   3. domain の sweepPlan で計画を作る（時計は注入。時計が巻き戻ったら、命令へ渡す now を最終確認の時刻にする）。
//      最終確認時刻は命令の前にファイルへ書く（書けなければ消さずに失敗として閉じる）。
//   4. 計画の操作を DB worker の命令で実行する（本文の削除・90 日の削除・予算の月の削除・取り消しの記録の掃除・
//      発言／元情報／派生物の期限削除・記憶の見直し待ちと期限削除）。
//   5. 掃除の記録（SweepRecord）を確定してゲートを開き、実際に消せた物の知らせを NoticeSink に渡す。
//   6. 削除を伴ったときだけ WAL を切り詰め、間隔（既定 1 日）を空けて VACUUM する（後始末は記録の外。ADR 0053）。
// 掃除の記録（SweepRecord）を startupGate に渡し、済むまで検索・クラウドへの送信・自動利用を許さない。
// 復帰（スリープ明け）は起動と同じく新しい epoch にして、前の掃除を数えず、もう一度掃除が済むまでゲートを閉じる。
//
// 消せなかった理由は原因別に扱う（ADR 0058 の U137。本人が 2026-10-31 に決定）。待てば直るもの・成否不明は失敗に数えて
// ゲートを閉じ、その行を消そうとするたびに起きる恒久の原因は、その行だけを使えない行（use_blocked の undeletable）として
// 隔離し続け、ゲート全体は開く。表は domain の RETENTION_FAILURE_CLASSES。
//
// LLM とクライアントは、何を消すか・ゲートが開いているかを決めない。計画は domain、実行は DB worker が持つ。

import { randomUUID } from 'node:crypto';
import {
  SWEEP_INTERVAL_MS,
  classifyRetentionFailure,
  isRowUsable,
  startupGate,
  sweepDue,
  sweepPlan,
} from '@buddy/domain';
import type {
  ClockStateStatus,
  RetentionFailureClass,
  StartupGateDecision,
  SweepAction,
  SweepNoticeDraft,
  SweepRecord,
  SweepRow,
  SweepUseBlock,
} from '@buddy/domain';
import type { RetentionNotice } from '@buddy/contracts';
import type {
  BudgetBackfillValue,
  BudgetPurgeValue,
  CheckpointValue,
  DbWorkerClient,
  ExpiryDeleteValue,
  ExpiryFamily,
  MemoryScheduleValue,
  OperationCursor,
  RetentionBatchValue,
  UndoPurgeValue,
} from '@buddy/storage';
import {
  CLOCK_RECHECK_HISTORY_MAX,
  CLOCK_STATE_SCHEMA,
} from './clock-state.js';
import type { ClockStateContent, ClockStatePort } from './clock-state.js';
import { isNoticeItemId } from './notice-sink.js';
import type { NoticeSink } from './notice-sink.js';

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
  // 以下は B06-07a-1。省略した口に当たる計画の操作は、実行できないので失敗に数える（ゲートを閉じる）。
  // 発言・元情報・派生物を、ID を指して消す（DB が行を読み直し、期限の来たものだけ消す）。
  deleteExpired?(
    family: ExpiryFamily,
    ids: readonly string[],
    now: number,
  ): Promise<ExpiryDeleteValue>;
  startMemoryReview?(
    memoryId: string,
    now: number,
  ): Promise<MemoryScheduleValue>;
  deleteDueMemory?(
    memoryId: string,
    now: number,
  ): Promise<{ readonly memory_id: string; readonly deleted: boolean }>;
  // 0010 より前の予算の行の delete_at を月ごとに埋める。
  backfillBudget?(month: string): Promise<BudgetBackfillValue>;
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
    async deleteExpired(family, ids, now) {
      const result = await store.retention({
        kind: 'retention.delete_expired',
        family,
        ids,
        now,
      });
      failure(result);
      return result.value;
    },
    async startMemoryReview(memoryId, now) {
      const result = await store.memory({
        kind: 'memory.start_review',
        memory_id: memoryId,
        now,
      });
      failure(result);
      return result.value;
    },
    async deleteDueMemory(memoryId, now) {
      const result = await store.memory({
        kind: 'memory.delete_due',
        memory_id: memoryId,
        now,
      });
      failure(result);
      return result.value;
    },
    async backfillBudget(month) {
      const result = await store.budget({
        kind: 'budget.backfill_delete_at',
        budget_month: month,
      });
      failure(result);
      return result.value;
    },
  };
}

export interface RetentionSweeperOptions {
  readonly port: RetentionSweepPort;
  // 起動・復帰ごとの識別子（startupGate の epoch）。復帰（スリープ明け）は起動と同じく新しい値にする。
  readonly epoch: string;
  readonly now: () => number;
  readonly log?: (message: string) => void;
  // VACUUM の間隔。原本に決めがないので 1 日に 1 回を仮の値にする（ADR 0053）。
  readonly vacuumIntervalMs?: number;
  // 定期実行の間隔（ADR 0043 の U55。既定は 5 分）。
  readonly sweepIntervalMs?: number;
  // 時計の最終確認時刻と epoch を置くファイル（ADR 0058 の U136）。省略するとメモリーだけ（従来どおり。試験用）。
  readonly clock?: ClockStatePort;
  // 初めての起動（DB を新しく作った）。ファイルがなくても新しく作る。それ以外でファイルがなければ判定できないものとして
  // 自動利用を止める。
  readonly freshClockState?: boolean;
  // 復帰で発行する新しい epoch（既定は乱数の UUID）。
  readonly newEpoch?: () => string;
  // 単調時計（ms）。復帰の検知で壁時計との差を見る（省略すると壁時計だけ）。
  readonly monotonic?: () => number;
  // 期限切れの知らせの受け取り（運搬は UI-05。U40）。
  readonly notices?: NoticeSink;
  readonly newNoticeId?: () => string;
}

const DEFAULT_VACUUM_INTERVAL_MS = 24 * 60 * 60_000;
// 隔離できる行の上限。超えたら（原因の見極めが要る異常なので）失敗に数えてゲートを閉じる。
export const MAX_UNDELETABLE_ROWS = 1000;
// 採り直しの要求が見た「今」と中枢の時計の許容差。見た値が古い（別の時計だった）ものを拒否する。
export const CLOCK_RECHECK_TOLERANCE_MS = 10 * 60_000;
const EXPIRY_BATCH = 50;

const iso = (millis: number): string =>
  new Date(millis).toISOString().replace('.000Z', 'Z');

// 時計の状態の見え方（制御チャネルの確認用。本人が見て採り直しを承認する）。
export interface ClockStatusView {
  readonly state: ClockStateStatus;
  readonly last_checked_at: string | null;
  // 採り直しの要求に渡す版（ファイルの revision。ファイルがなければ 'missing'、読めなければ 'invalid'）。
  readonly revision: string;
  readonly epoch: string;
  readonly now: string;
  // 時計が最終確認時刻より前か（巻き戻り、または進めすぎた後に戻した）。
  readonly regressed: boolean;
  readonly regressed_by_ms: number;
  readonly needs_recheck: boolean;
  readonly rechecks: ClockStateContent['rechecks'];
}

export interface ClockRecheckInput {
  readonly request_id: string;
  readonly revision: string;
  readonly observed_last_checked_at: string | null;
  readonly observed_now: string;
}

export type ClockRecheckResult =
  | { readonly ok: true; readonly last_checked_at: string }
  | { readonly ok: false; readonly reasons: readonly string[] };

export class RetentionSweeper {
  readonly #port: RetentionSweepPort;
  #epoch: string;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #vacuumIntervalMs: number;
  readonly #sweepIntervalMs: number;
  readonly #clock: ClockStatePort | undefined;
  readonly #freshClockState: boolean;
  readonly #newEpoch: () => string;
  readonly #monotonic: (() => number) | undefined;
  readonly #notices: NoticeSink | undefined;
  readonly #newNoticeId: () => string;
  #clockState: ClockStateStatus;
  #clockContent: ClockStateContent | null = null;
  #clockLoaded: boolean;
  #lastCheckedAt: string | null = null;
  #lastCompletedAt: string | null = null;
  // 復帰の検知（定期の確認の間隔を壁時計と単調時計で比べる）。
  #lastTickWall: number;
  #lastTickMono: number | null;
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
  // 掃除の途中で復帰・採り直しがあった。今の掃除が終わったら、新しい epoch でもう一度掃除する。
  #forceAfter = false;
  #rechecking = false;
  // 予算の行の delete_at の埋め直しを済ませた月（0010 より前の行。起動ごとに 1 回）。
  readonly #backfilled = new Set<string>();
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
    this.#clock = options.clock;
    this.#freshClockState = options.freshClockState ?? false;
    this.#newEpoch = options.newEpoch ?? randomUUID;
    this.#monotonic = options.monotonic;
    this.#notices = options.notices;
    this.#newNoticeId = options.newNoticeId ?? randomUUID;
    // ファイルを使うときは、読み終えるまで判定できない（missing 扱い。最初の掃除が読む）。
    this.#clockState = this.#clock === undefined ? 'verified' : 'missing';
    this.#clockLoaded = this.#clock === undefined;
    this.#lastVacuumAt = this.#now();
    this.#lastTickWall = this.#now();
    this.#lastTickMono = this.#monotonic?.() ?? null;
    this.#record = this.#runningRecord();
  }

  #runningRecord(): SweepRecord {
    return {
      epoch: this.#epoch,
      status: 'running',
      completed_at: null,
      failed_actions: 0,
      use_blocked: [],
    };
  }

  // 起動の直後はゲートを閉じたまま、最初の掃除を始める（済むまで検索・送信・自動利用を許さない）。
  // 定期の確認は sweepIntervalMs の 1/5（既定は 1 分）ごとに復帰と sweepDue を見る。前回の完了から間隔が過ぎた最初の確認で
  // 始めるので、掃除の所要時間の分だけ周期が 2 倍にずれることがない（P3）。
  start(): void {
    if (this.#closed) return;
    void this.runOnce(true).catch(() => undefined);
    this.#timer = setInterval(
      () => {
        this.tick();
      },
      Math.max(1, Math.floor(this.#sweepIntervalMs / 5)),
    );
    this.#timer.unref?.();
  }

  // 定期の確認 1 回（タイマーが呼ぶ。試験は直接呼ぶ）。復帰を検知したら新しい epoch で掃除し直し、そうでなければ
  // 間隔が過ぎているときだけ掃除する。
  tick(): void {
    if (this.#closed) return;
    const now = this.#now();
    if (this.#detectResume(now)) {
      this.#log(
        '復帰（スリープ明けなど）を検知しました。新しい epoch で保存期限の掃除をやり直すまで、検索・クラウドへの送信・自動利用を止めます。',
      );
      this.beginEpoch();
      return;
    }
    if (sweepDue(this.#lastCompletedAt, iso(now)))
      void this.runOnce(false).catch(() => undefined);
  }

  // 壁時計の進みが確認の間隔に比べて大きく離れた（スリープ・長い停止・時計の操作）か、単調時計より壁時計が大きく進んだ。
  // 誤って検知しても安全側（掃除をやり直すだけ）。
  #detectResume(now: number): boolean {
    const tickMs = Math.max(1, Math.floor(this.#sweepIntervalMs / 5));
    const wallGap = now - this.#lastTickWall;
    const mono = this.#monotonic?.() ?? null;
    const monoGap =
      mono !== null && this.#lastTickMono !== null
        ? mono - this.#lastTickMono
        : null;
    this.#lastTickWall = now;
    this.#lastTickMono = mono;
    if (wallGap > 3 * tickMs) return true;
    return monoGap !== null && wallGap - monoGap > 2 * tickMs;
  }

  // 新しい epoch を始める（復帰・採り直し）。前の掃除は数えず、ゲートは掃除が済むまで閉じる。
  beginEpoch(epoch: string = this.#newEpoch()): void {
    if (this.#closed) return;
    this.#epoch = epoch;
    this.#record = this.#runningRecord();
    this.#started = true;
    if (this.#running !== null) this.#forceAfter = true;
    else void this.runOnce(true).catch(() => undefined);
  }

  // 新しい掃除を始めず、実行中の掃除は次の区切りで中断する（失敗の記録は作らない。ゲートは閉じたまま）。
  // 終わるまで待つのは drain()。
  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    // 貸し出しの返却を待っている掃除も中断する。待ちを解除して、本体に入る前の中断確認で終える
    // （失敗の記録は作らない。ADR 0053）。返却は close の後でも安全（#sendLeases を戻すだけ）。
    const wake = this.#leasesDrained;
    this.#leasesDrained = null;
    wake?.();
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
    if (
      this.#closed ||
      this.#running !== null ||
      this.#rechecking ||
      !this.gate().cloud_send
    )
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
    // 停止しているときは待たずに本体へ進む（先頭の中断確認で終わる。停止した後の runOnce も止めない）。
    if (this.#sendLeases === 0 || this.#closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#leasesDrained = resolve;
    });
  }

  // 1 回の掃除。force が false のときは、前回から間隔が過ぎていなければ何もしない。
  runOnce(force: boolean): Promise<SweepRecord> {
    if (this.#running !== null) return this.#running;
    // 採り直しの途中は掃除を始めない（採り直しが済んで新しい epoch で掃除する）。
    if (this.#rechecking) return Promise.resolve(this.#record);
    const now = this.#now();
    if (!force && !sweepDue(this.#lastCompletedAt, iso(now))) {
      return Promise.resolve(this.#record);
    }
    this.#started = true;
    this.#record = this.#runningRecord();
    const epoch = this.#epoch;
    // 掃除の間は running の記録でゲートが閉じる（済んだことの記録だけを根拠に開く）。
    // 送出中の区間があれば、その終わりを待ってから本体に入る（記録は running なので、新しい送出は始まらない）。
    this.#running = this.#waitForLeases()
      .then(() => this.#sweep(this.#now(), epoch))
      .then((record) => {
        // 記録を確定した後に後始末を始める（ゲートはもう開いている）。
        this.#startMaintenance();
        return record;
      })
      .finally(() => {
        this.#running = null;
        // 掃除の途中で復帰・採り直しがあった。新しい epoch で掃除し直す。
        if (this.#forceAfter && !this.#closed) {
          this.#forceAfter = false;
          void this.runOnce(true).catch(() => undefined);
        }
      });
    return this.#running;
  }

  // --- 時計の状態ファイル（ADR 0058 の U136） ---

  async #loadClock(startedAt: number): Promise<void> {
    if (this.#clock === undefined || this.#clockLoaded) return;
    const loaded = await this.#clock.load();
    if (loaded.status === 'verified') {
      this.#clockContent = loaded.content;
      this.#clockState = 'verified';
      this.#lastCheckedAt = loaded.content.last_checked_at;
    } else if (loaded.status === 'missing' && this.#freshClockState) {
      // 初めての起動（DB を新しく作った）。判定する過去がないので、今を最終確認時刻にしてファイルを作る。
      const content = this.#contentAt(null, iso(startedAt), startedAt, []);
      await this.#clock.save(content);
      this.#clockContent = content;
      this.#clockState = 'verified';
      this.#lastCheckedAt = content.last_checked_at;
    } else {
      this.#clockState = loaded.status === 'missing' ? 'missing' : 'invalid';
      this.#log(
        `時計の状態ファイルが${loaded.status === 'missing' ? 'ありません' : '読めません'}。巻き戻りを判定できないので、検索・クラウドへの送信・自動利用を止めます。中枢の機器の前で時計の採り直し（clock recheck）を行ってください。`,
      );
    }
    this.#clockLoaded = true;
  }

  #contentAt(
    previous: ClockStateContent | null,
    lastCheckedAt: string,
    nowMs: number,
    rechecks: ClockStateContent['rechecks'],
  ): ClockStateContent {
    const sameEpoch = previous?.epoch === this.#epoch;
    return {
      schema: CLOCK_STATE_SCHEMA,
      revision: (previous?.revision ?? 0) + 1,
      last_checked_at: lastCheckedAt,
      epoch: this.#epoch,
      epoch_started_at:
        sameEpoch && previous !== null ? previous.epoch_started_at : iso(nowMs),
      written_at: iso(nowMs),
      rechecks,
      storage_boundary: previous?.storage_boundary ?? null,
    };
  }

  // 次の最終確認時刻を、命令の前にファイルへ書く（書けなければ throw。掃除は失敗として閉じる）。
  async #persistClock(nextLastCheckedAt: string, nowMs: number): Promise<void> {
    if (
      this.#clock === undefined ||
      this.#clockState !== 'verified' ||
      this.#clockContent === null
    )
      return;
    const previous = this.#clockContent;
    if (
      previous.last_checked_at === nextLastCheckedAt &&
      previous.epoch === this.#epoch
    )
      return;
    const content = this.#contentAt(
      previous,
      nextLastCheckedAt,
      nowMs,
      previous.rechecks,
    );
    await this.#clock.save(content);
    this.#clockContent = content;
  }

  // 本人が見る時計の状態。
  async clockStatus(): Promise<ClockStatusView> {
    await this.idle();
    const nowMs = this.#now();
    const last = this.#clockContent?.last_checked_at ?? null;
    const lastMs = last === null ? null : Date.parse(last);
    const regressedBy = lastMs !== null && lastMs > nowMs ? lastMs - nowMs : 0;
    return {
      state: this.#clockState,
      last_checked_at: last,
      revision:
        this.#clockState === 'verified' && this.#clockContent !== null
          ? String(this.#clockContent.revision)
          : this.#clockState === 'invalid'
            ? 'invalid'
            : 'missing',
      epoch: this.#epoch,
      now: iso(nowMs),
      regressed: regressedBy > 0,
      regressed_by_ms: regressedBy,
      needs_recheck: this.#clockState !== 'verified' || regressedBy > 0,
      rechecks: this.#clockContent?.rechecks ?? [],
    };
  }

  // 時計の採り直し（ADR 0058 の U136）。中枢の機器の前で本人が行うローカル制御の操作。status で見た値を明示して渡し、
  // 今の状態と一致するときだけ、最終確認時刻を今の時計に置き直す（記録をファイルに残す）。新しい epoch で掃除し直す。
  async recheckClock(input: ClockRecheckInput): Promise<ClockRecheckResult> {
    const refuse = (...reasons: string[]): ClockRecheckResult => ({
      ok: false,
      reasons,
    });
    if (this.#closed) return refuse('closed');
    if (this.#clock === undefined) return refuse('clock_file_unavailable');
    if (this.#rechecking) return refuse('recheck_in_progress');
    this.#rechecking = true;
    let renewed: string | null = null;
    try {
      await this.idle();
      const view = await this.clockStatus();
      if (!view.needs_recheck) return refuse('not_needed');
      if (input.revision !== view.revision) return refuse('revision_mismatch');
      if (input.observed_last_checked_at !== view.last_checked_at)
        return refuse('observed_last_checked_at_mismatch');
      const observedNow = Date.parse(input.observed_now);
      const nowMs = this.#now();
      if (
        Number.isNaN(observedNow) ||
        Math.abs(nowMs - observedNow) > CLOCK_RECHECK_TOLERANCE_MS
      )
        return refuse('observed_now_stale');
      const previous = this.#clockContent;
      const epoch = this.#newEpoch();
      const to = iso(nowMs);
      const history = [
        ...(previous?.rechecks ?? []),
        {
          at: to,
          request_id: input.request_id,
          from_last_checked_at: view.last_checked_at,
          to_last_checked_at: to,
        },
      ].slice(-CLOCK_RECHECK_HISTORY_MAX);
      const previousEpoch = this.#epoch;
      this.#epoch = epoch;
      const content = this.#contentAt(previous, to, nowMs, history);
      try {
        await this.#clock.save(content);
      } catch {
        this.#epoch = previousEpoch;
        return refuse('save_failed');
      }
      renewed = epoch;
      this.#clockContent = content;
      this.#clockState = 'verified';
      this.#lastCheckedAt = to;
      this.#log(
        `時計の最終確認時刻を採り直しました（${view.last_checked_at ?? 'なし'} → ${to}、要求 ${input.request_id}）。`,
      );
      return { ok: true, last_checked_at: to };
    } finally {
      this.#rechecking = false;
      // 採り直しができたときだけ、新しい epoch で掃除し直す（ゲートは掃除が済むまで閉じる）。
      if (renewed !== null) this.beginEpoch(renewed);
    }
  }

  // --- 掃除の本体 ---

  async #sweep(startedAt: number, epoch: string): Promise<SweepRecord> {
    let failed = 0;
    let usedBlocked: SweepRecord['use_blocked'] = [];
    let completedAt: number;
    const quarantined: SweepUseBlock[] = [];
    const removed = new Set<string>();
    const settle = (
      error: unknown,
      family: SweepRow['family'] | null,
      id: string | null,
    ): void => {
      const kind = this.#failureClass(error);
      if (kind === 'expected_hold') return;
      if (kind === 'permanent' && family !== null && id !== null) {
        this.#quarantine(quarantined, family, id);
        return;
      }
      failed += 1;
    };
    try {
      this.#checkOpen();
      await this.#loadClock(startedAt);
      const rows = await this.#port.readRows(startedAt);
      const plan = sweepPlan({
        now: iso(startedAt),
        last_checked_at: this.#lastCheckedAt,
        rows,
      });
      if (!plan.ok) {
        // 時計・最終確認時刻が読めない。何も消さず、ゲートを閉じたままにする。
        this.#record = {
          epoch,
          status: 'failed',
          completed_at: iso(startedAt),
          failed_actions: 1,
          use_blocked: [],
        };
        return this.#record;
      }
      this.#checkOpen();
      usedBlocked = plan.use_blocked;
      // 最終確認時刻は命令の前に書く（書けなければここで throw し、何も消さずに失敗として閉じる）。
      await this.#persistClock(plan.clock.next_last_checked_at, startedAt);
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

      // 取り消しの記録（期限は 30 日。90 日のレシートより早い）を先に消し、90 日の削除が止まらないようにする
      // （ADR 0051 の引き継ぎ）。レシートの計画の有無に関わらず毎回行う（30 日を過ぎた記録だけが残る DB でも消す）。
      this.#checkOpen();
      try {
        const undo = await this.#port.purgeUndoRecords(effectiveNow);
        deleted += undo.purged;
      } catch (error) {
        // 取り消しの記録が消せなくても、本文・予算の削除は続ける（行を特定できないので失敗に数え、ゲートは閉じる）。
        settle(error, null, null);
      }
      if (bodyPlanned) {
        this.#checkOpen();
        const count = await this.#runBatch('body', effectiveNow, quarantined);
        failed += count.failed;
        deleted += count.processed;
      }
      if (receiptPlanned) {
        this.#checkOpen();
        const count = await this.#runBatch(
          'receipt',
          effectiveNow,
          quarantined,
        );
        failed += count.failed;
        deleted += count.processed;
      }

      // 発言・元情報・派生物（ID を指して消す）と、記憶（見直し待ち・期限削除）。
      const byKey = rowsByKey(rows);
      const noticeKeys = noticeKeysOf(plan.actions, byKey);
      const expiry = await this.#runExpiry(
        plan.actions,
        byKey,
        effectiveNow,
        quarantined,
        removed,
      );
      failed += expiry.failed;
      deleted += expiry.deleted;

      // 予算の記録。時計の状態が判定できない間は消さない（巻き戻りを見逃して早く消さない側へ倒す。J4）。
      if (this.#clockState === 'verified') {
        const budget = await this.#runBudget(
          plan.actions,
          rows,
          effectiveNow,
          quarantined,
        );
        failed += budget.failed;
        deleted += budget.deleted;
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

      if (quarantined.length > MAX_UNDELETABLE_ROWS) {
        // 隔離する行が多すぎるのは、個々の行ではなく仕組みの異常。原因の見極めが済むまで閉じる。
        failed += 1;
        quarantined.length = MAX_UNDELETABLE_ROWS;
        this.#log(
          `保存期限の掃除で消せない行が ${MAX_UNDELETABLE_ROWS} 件を超えました。原因を確かめるまで検索・クラウドへの送信・自動利用を止めます。`,
        );
      }
      if (quarantined.length > 0)
        this.#log(
          `保存期限の掃除で、恒久の原因で消せない行が ${quarantined.length} 件あります。その行だけを使えない行として隔離し、ほかは続けます。`,
        );

      completedAt = this.#now();
      this.#lastCompletedAt = iso(completedAt);
      this.#record = {
        epoch,
        status: failed === 0 ? 'completed' : 'failed',
        completed_at: iso(completedAt),
        failed_actions: failed,
        use_blocked: mergeBlocked(usedBlocked, quarantined),
      };
      this.#publishNotices(
        plan.notice_drafts,
        noticeKeys,
        removed,
        completedAt,
      );
    } catch (error) {
      // 停止による中断。失敗の記録は作らない（記録は running のまま。ゲートは閉じている）。
      if (error instanceof SweepAborted) return this.#record;
      failed += 1;
      this.#log(
        `保存期限の掃除に失敗しました（${reasonOf(error)}）。検索・クラウドへの送信・自動利用は止めたままにします。`,
      );
      completedAt = this.#now();
      this.#record = {
        epoch,
        status: 'failed',
        completed_at: iso(completedAt),
        failed_actions: failed,
        use_blocked: mergeBlocked(usedBlocked, quarantined),
      };
    }
    return this.#record;
  }

  #failureClass(error: unknown): RetentionFailureClass {
    if (error instanceof SweepAborted) throw error;
    if (error instanceof RetentionSweepCallError)
      return classifyRetentionFailure(error.outcome, error.reasons);
    return 'transient';
  }

  #quarantine(
    list: SweepUseBlock[],
    family: SweepRow['family'],
    id: string,
  ): void {
    if (list.some((item) => item.family === family && item.id === id)) return;
    list.push({ family, id, reason: 'undeletable' });
  }

  // 発言・元情報・派生物（family ごとに 50 件ずつ ID を指して）と記憶（1 件ずつ）。
  async #runExpiry(
    actions: readonly SweepAction[],
    byKey: ReadonlyMap<string, SweepRow>,
    now: number,
    quarantined: SweepUseBlock[],
    removed: Set<string>,
  ): Promise<{ failed: number; deleted: number }> {
    let failed = 0;
    let deleted = 0;
    const groups: Record<ExpiryFamily, SweepAction[]> = {
      turn: [],
      source_item: [],
      derived: [],
    };
    const memory: SweepAction[] = [];
    for (const action of actions) {
      if (action.family === 'timed') {
        if (action.rule.startsWith('turn_')) groups.turn.push(action);
        else if (action.rule === 'source_body') groups.source_item.push(action);
        else {
          // 掃除の入力に出さない規則の行。入力を足したのに実行が追いついていない設計の不整合（失敗に数える）。
          failed += 1;
        }
      } else if (action.family === 'derived') groups.derived.push(action);
      else if (action.family === 'memory') memory.push(action);
    }
    for (const family of ['turn', 'source_item', 'derived'] as const) {
      const planned = groups[family];
      for (let at = 0; at < planned.length; at += EXPIRY_BATCH) {
        this.#checkOpen();
        const chunk = planned.slice(at, at + EXPIRY_BATCH);
        const ids = chunk.map((action) => action.id);
        const deleteExpired = this.#port.deleteExpired;
        if (deleteExpired === undefined) {
          failed += chunk.length;
          continue;
        }
        let value: ExpiryDeleteValue;
        try {
          value = await deleteExpired.call(this.#port, family, ids, now);
        } catch (error) {
          // 呼び出し全体の失敗は行を特定できない。待てば直る・成否不明は失敗。
          if (this.#failureClass(error) !== 'expected_hold') failed += 1;
          continue;
        }
        deleted += value.deleted.length;
        for (const id of value.deleted) removed.add(`${family}:${id}`);
        for (const item of value.skipped) {
          const kind = classifyRetentionFailure('rejected', item.reasons);
          if (kind === 'expected_hold') continue;
          if (kind === 'permanent')
            this.#quarantine(quarantined, planFamilyOf(family), item.id);
          else failed += 1;
        }
      }
    }
    for (const action of memory) {
      this.#checkOpen();
      const row = byKey.get(`memory:${action.id}`);
      const status = row?.family === 'memory' ? row.status : null;
      const outcome = await this.#runMemory(action, status, now, quarantined);
      failed += outcome.failed;
      if (outcome.deleted) {
        deleted += 1;
        removed.add(`memory:${action.id}`);
      }
    }
    return { failed, deleted };
  }

  // 記憶 1 件。見直し日を過ぎたものは見直し待ちへ、見直し待ちの 30 日も過ぎたものは見直し待ちを経て（有効なまま
  // 止まっていた記憶は先に見直し待ちにして）期限削除する。期限切れは忘却ではないので台帳には書かない。
  async #runMemory(
    action: SweepAction,
    status: 'active' | 'review_pending' | 'deleted' | null,
    now: number,
    quarantined: SweepUseBlock[],
  ): Promise<{ failed: number; deleted: boolean }> {
    const start = this.#port.startMemoryReview;
    const remove = this.#port.deleteDueMemory;
    if (start === undefined || remove === undefined)
      return { failed: 1, deleted: false };
    const fail = (error: unknown): { failed: number; deleted: boolean } => {
      const kind = this.#failureClass(error);
      if (kind === 'expected_hold') return { failed: 0, deleted: false };
      if (kind === 'permanent') {
        this.#quarantine(quarantined, 'memory', action.id);
        return { failed: 0, deleted: false };
      }
      return { failed: 1, deleted: false };
    };
    if (action.action === 'start_review') {
      try {
        await start.call(this.#port, action.id, now);
      } catch (error) {
        return fail(error);
      }
      return { failed: 0, deleted: false };
    }
    try {
      if (status === 'active') await start.call(this.#port, action.id, now);
      const result = await remove.call(this.#port, action.id, now);
      return { failed: 0, deleted: result.deleted };
    } catch (error) {
      return fail(error);
    }
  }

  // 予算の月。月は入力の budget_month 行から引く（計画の操作の ID は live_session・承認・予約の ID）。
  async #runBudget(
    actions: readonly SweepAction[],
    rows: readonly SweepRow[],
    now: number,
    quarantined: SweepUseBlock[],
  ): Promise<{ failed: number; deleted: number }> {
    let failed = 0;
    let deleted = 0;
    // 0010 より前の予算の行の delete_at を月ごとに埋める（起動ごとに 1 回。ADR 0048 の U80）。
    const backfill = this.#port.backfillBudget;
    if (backfill !== undefined) {
      for (const row of rows) {
        if (row.family !== 'budget_month') continue;
        if (this.#backfilled.has(row.budget_month)) continue;
        this.#checkOpen();
        try {
          await backfill.call(this.#port, row.budget_month);
          this.#backfilled.add(row.budget_month);
        } catch (error) {
          const kind = this.#failureClass(error);
          if (kind === 'expected_hold') this.#backfilled.add(row.budget_month);
          else failed += 1;
        }
      }
    }
    // 月は、計画の操作の ID（live_session・承認・予約の ID）から、入力の予算の月の行を引いて決める。
    const monthOf = budgetMonthOf(rows);
    const months = new Map<string, SweepAction[]>();
    for (const action of actions) {
      if (action.family !== 'budget_month' || action.table === undefined)
        continue;
      const month = monthOf.get(`${action.table}:${action.id}`);
      // 入力に無い ID は計画の不整合。消さずに失敗に数える。
      if (month === undefined) failed += 1;
      else months.set(month, [...(months.get(month) ?? []), action]);
    }
    for (const [month, monthActions] of months) {
      this.#checkOpen();
      try {
        const purged = await this.#port.purgeBudgetMonth(month, now);
        deleted +=
          purged.deleted_live_sessions +
          purged.deleted_approvals +
          purged.deleted_reservations;
      } catch (error) {
        const kind = this.#failureClass(error);
        if (kind === 'expected_hold') continue;
        // 月は 1 つの transaction で消す。恒久の原因ならその月の行だけを隔離する（ほかの月は続ける）。
        if (kind === 'permanent')
          for (const action of monthActions)
            this.#quarantine(quarantined, 'budget_month', action.id);
        else failed += 1;
      }
    }
    return { failed, deleted };
  }

  // 実際に消せた物だけの知らせを渡す（運搬は UI-05。配信の失敗は掃除の失敗にしない）。
  #publishNotices(
    drafts: readonly SweepNoticeDraft[],
    noticeKeys: ReadonlyMap<string, string>,
    removed: ReadonlySet<string>,
    occurredAt: number,
  ): void {
    const sink = this.#notices;
    if (sink === undefined) return;
    const deletedKeys = new Set<string>();
    for (const [actionKey, noticeKey] of noticeKeys)
      if (removed.has(actionKey)) deletedKeys.add(noticeKey);
    for (const draft of drafts) {
      const items = draft.items.filter(
        (item) =>
          deletedKeys.has(`${item.item_kind}:${item.item_id}`) &&
          isNoticeItemId(item.item_id),
      );
      if (items.length === 0) continue;
      const [first, ...rest] = items;
      if (first === undefined) continue;
      const notice: RetentionNotice = {
        schema: 'buddy.retention-notice.v1',
        notice_id: this.#newNoticeId(),
        occurred_at: iso(occurredAt),
        kind: 'expired',
        reason: draft.reason,
        forgetting_generation: null,
        items: [first, ...rest],
      };
      try {
        const sent = sink.publish(notice);
        if (sent instanceof Promise)
          sent.catch(() =>
            this.#log(
              '期限切れの知らせを渡せませんでした（掃除には影響しません）。',
            ),
          );
      } catch {
        this.#log(
          '期限切れの知らせを渡せませんでした（掃除には影響しません）。',
        );
      }
    }
  }

  async #runBatch(
    kind: 'body' | 'receipt',
    now: number,
    quarantined: SweepUseBlock[],
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
        if (this.#failureClass(error) !== 'expected_hold') failed += 1;
        return { processed, failed };
      }
      processed += batch.processed.length;
      for (const item of batch.skipped) {
        const cause = classifyRetentionFailure('rejected', item.reasons);
        if (cause === 'expected_hold') continue;
        // 恒久の原因の操作は、その操作だけを使えない行として隔離する（後ろの操作の削除は続ける）。
        if (cause === 'permanent')
          this.#quarantine(quarantined, 'operation', item.operation_id);
        else failed += 1;
      }
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
    // 呼ぶ前に保留を立て、成功したときだけ解除する（例外・busy のときは次の掃除の後に試す）。
    this.#checkOpen();
    this.#checkpointPending = true;
    if (await this.#truncatedLog()) this.#checkpointPending = false;
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
      // ファイルを読み終えるまでは状態を決めない（掃除が済んでいないことだけが理由になる）。
      ...(this.#clockLoaded ? { clock_state: this.#clockState } : {}),
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

// 計画の行（発言・元情報・記憶・派生物）を「種類:ID」で引く表。
function rowsByKey(rows: readonly SweepRow[]): ReadonlyMap<string, SweepRow> {
  const map = new Map<string, SweepRow>();
  for (const row of rows) {
    if (row.family === 'timed') map.set(`timed:${row.id}`, row);
    else if (row.family === 'memory') map.set(`memory:${row.id}`, row);
    else if (row.family === 'derived') map.set(`derived:${row.id}`, row);
  }
  return map;
}

// 隔離する行の、計画上の family（発言・元情報は timed、派生物は derived）。
function planFamilyOf(family: ExpiryFamily): SweepRow['family'] {
  return family === 'derived' ? 'derived' : 'timed';
}

// 計画の操作 →（消せたときに知らせる対象）。「命令に渡した family:ID」→「知らせの種類:知らせの ID」。
function noticeKeysOf(
  actions: readonly SweepAction[],
  byKey: ReadonlyMap<string, SweepRow>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const action of actions) {
    if (action.action !== 'delete_row') continue;
    if (action.family === 'timed') {
      const row = byKey.get(`timed:${action.id}`);
      const noticeId =
        row?.family === 'timed' ? (row.notice_item_id ?? row.id) : action.id;
      if (action.rule.startsWith('turn_'))
        map.set(`turn:${action.id}`, `turn:${noticeId}`);
      else if (action.rule === 'source_body')
        map.set(`source_item:${action.id}`, `source_item:${noticeId}`);
    } else if (
      action.family === 'memory' &&
      action.reason === 'review_unanswered'
    ) {
      map.set(`memory:${action.id}`, `memory:${action.id}`);
    } else if (
      action.family === 'derived' &&
      action.rule === 'carried_summary'
    ) {
      const row = byKey.get(`derived:${action.id}`);
      const noticeId =
        row?.family === 'derived' ? (row.notice_item_id ?? row.id) : action.id;
      map.set(`derived:${action.id}`, `carried_summary:${noticeId}`);
    }
  }
  return map;
}

// 計画の use_blocked と、実行で隔離した行をまとめる（同じ行は 1 件）。
function mergeBlocked(
  planned: readonly SweepUseBlock[],
  quarantined: readonly SweepUseBlock[],
): SweepUseBlock[] {
  const merged: SweepUseBlock[] = [...planned];
  for (const item of quarantined)
    if (
      !merged.some(
        (existing) =>
          existing.family === item.family && existing.id === item.id,
      )
    )
      merged.push(item);
  return merged;
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

function reasonOf(error: unknown): string {
  if (error instanceof RetentionSweepCallError) return error.reasons.join(',');
  return error instanceof Error ? error.name : 'unknown';
}
