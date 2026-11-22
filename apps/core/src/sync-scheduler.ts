// 同期の周期起動（設計 11 §1・§1A、設計 04 同期方式の選定、B08-06、ADR 0137）。
//
// 起動時に担当世代の回復と全量照合を行い、その後は 60 秒ごとに増分を回す（周期へ ±10 秒のジッター）。
// 全量照合の間隔は資源ごと（メール 6 時間・予定 15 分、設計 11 §1 の表）で、走査の実体は実行器（B08-05）が持つ。
// ここは「いつ・どの種類で呼ぶか」と、接続ごとの指数バックオフ（上限 15 分）だけを持つ。
// - 再起動の回復は、旧実行担当の終了が製品の排他ロックで担保された後に行う（11 §1A）。回復は保存層の
//   sync.recover が担当世代を進め、残っていた有効な走査を abandoned にする。旧世代の遅着は実行器・保存層が拒否する。
// - 429／5xx の再試行そのもの（Retry-After の優先を含む）は connector の再試行方針（ADR 0071）が担う。
//   ここでのバックオフは、走査が失敗した接続について次の周期の呼出しを遅らせる段だけを持つ。
// - account_id と資源種別は接続の作成（B03-04）が持つ値で、呼び出し側（targetsFor）から渡されたものだけを使う。
//   対象が無い接続は走査しない。実接続が無い間、製品の起動では実行器は呼ばれない（ADR 0136 と同じ）。

import type { ConnectionRecord, DbWorkerClient } from '@buddy/storage';
import type {
  SyncExecutor,
  SyncResourceKind,
  SyncScanKind,
} from './sync-executor.js';

export interface SyncSchedulerTarget {
  // source_items のキー（provider のアカウント識別子）。接続の作成（B03-04）が持つ値。
  readonly account_id: string;
  readonly scope_id: string;
  readonly resource: SyncResourceKind;
}

export interface SyncSchedulerOptions {
  readonly store: Pick<DbWorkerClient, 'connectionTargets' | 'sync'>;
  readonly executor: SyncExecutor;
  // 接続ごとの走査対象。省略した接続・対象が無い接続は走査しない。
  readonly targetsFor?: (
    connection: ConnectionRecord,
  ) => readonly SyncSchedulerTarget[] | Promise<readonly SyncSchedulerTarget[]>;
  readonly now?: () => Date;
  // ジッターの乱数（0 以上 1 未満）。試験で差し替える。
  readonly random?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  // ポーリングの間隔（設計 11 §1・設計 04 の初期値 60 秒）。
  readonly pollIntervalMs?: number;
  // 周期へ加えるジッターの幅（±。設計 11 §1 の ±10 秒）。
  readonly jitterMs?: number;
  // 全量照合の間隔（設計 11 §1 の表。メール 6 時間・予定 15 分）。
  readonly fullIntervalMs?: {
    readonly mail: number;
    readonly calendar: number;
  };
  // 接続ごとの指数バックオフの上限（設計 11 §1 の 15 分）。初項はポーリングの間隔、倍率は 2。
  readonly backoffMaxMs?: number;
  readonly log?: (message: string) => void;
}

export interface SyncScheduler {
  // 起動時の回復と全量照合を始める。二度目以降は無視する。実行中の処理は idle() で待てる。
  start(): void;
  // 周期を止める。実行中の走査は止めない（走査は再開可能な形で保存される。11 §1A）。
  stop(): void;
  // 実行中の周期処理が終わるまで待つ（試験・診断用）。
  idle(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_JITTER_MS = 10_000;
const DEFAULT_FULL_INTERVAL_MS = {
  mail: 6 * 60 * 60_000,
  calendar: 15 * 60_000,
} as const;
const DEFAULT_BACKOFF_MAX_MS = 15 * 60_000;

export function createSyncScheduler(
  options: SyncSchedulerOptions,
): SyncScheduler {
  const { store, executor } = options;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      timer.unref();
      return timer;
    });
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const fullIntervalMs = options.fullIntervalMs ?? DEFAULT_FULL_INTERVAL_MS;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const log = options.log ?? (() => undefined);

  let started = false;
  let stopped = false;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  // 接続ごとの連続失敗回数と、次に呼んでよい時刻（指数バックオフ）。
  const failures = new Map<string, number>();
  const backoffUntil = new Map<string, number>();

  // 全量にする条件（設計 11 §1）。起動時は常に全量。あとは未照合・間隔の経過・pending_full の順に見る。
  function decideKind(
    resource: SyncResourceKind,
    scope: {
      readonly pending_full: boolean;
      readonly last_full_reconciled_at: string | null;
    },
    startup: boolean,
  ): SyncScanKind {
    if (startup) return 'full';
    if (scope.pending_full) return 'full';
    if (scope.last_full_reconciled_at === null) return 'full';
    const elapsed = now().getTime() - Date.parse(scope.last_full_reconciled_at);
    return elapsed >= fullIntervalMs[resource] ? 'full' : 'incremental';
  }

  async function runConnection(
    connection: ConnectionRecord,
    startup: boolean,
  ): Promise<void> {
    const listed = await store.sync({
      kind: 'sync.list_scopes',
      connection_id: connection.connection_id,
    });
    if (!listed.ok) {
      log(
        `同期の取得集合を読めませんでした（接続 ${connection.connection_id}、${listed.reasons.join(', ')}）。`,
      );
      return;
    }
    let snapshots = listed.value;
    if (startup) {
      // 再起動の回復（11 §1A）。担当世代を進め、残っていた有効な走査を abandoned にする。
      // 回復の結果（pending・世代）を後の種類の判定に使うため、返った snapshot で置き換える。
      const recovered = new Map(
        snapshots.map((snapshot) => [snapshot.scope.scope_id, snapshot]),
      );
      for (const snapshot of snapshots) {
        const result = await store.sync({
          kind: 'sync.recover',
          scope_id: snapshot.scope.scope_id,
        });
        if (result.ok) recovered.set(result.value.scope.scope_id, result.value);
        else
          log(
            `同期の回復ができませんでした（取得集合 ${snapshot.scope.scope_id}、${result.reasons.join(', ')}）。`,
          );
      }
      snapshots = [...recovered.values()];
    }
    const until = backoffUntil.get(connection.connection_id);
    if (!startup && until !== undefined && now().getTime() < until) return;
    const targets = (await options.targetsFor?.(connection)) ?? ([] as const);
    if (targets.length === 0) return;
    const byScope = new Map(
      snapshots.map((snapshot) => [snapshot.scope.scope_id, snapshot]),
    );
    // バックオフは接続ごとに数える（同じ周期で複数の対象が失敗しても 1 回分）。
    let failedReason: string | null = null;
    let published = false;
    for (const target of targets) {
      if (stopped) return;
      const snapshot = byScope.get(target.scope_id);
      if (snapshot === undefined) continue;
      const outcome = await executor.runScan({
        connection_id: connection.connection_id,
        account_id: target.account_id,
        scope_id: target.scope_id,
        resource: target.resource,
        kind: decideKind(target.resource, snapshot.scope, startup),
      });
      if (outcome.status === 'published') published = true;
      else if (outcome.status === 'failed' && failedReason === null)
        failedReason = outcome.reason;
    }
    if (failedReason !== null) {
      const count = (failures.get(connection.connection_id) ?? 0) + 1;
      failures.set(connection.connection_id, count);
      const delay = Math.min(backoffMaxMs, pollIntervalMs * 2 ** (count - 1));
      backoffUntil.set(connection.connection_id, now().getTime() + delay);
      log(
        `同期の走査が失敗しました（接続 ${connection.connection_id}、${failedReason}）。次の確認を ${Math.round(delay / 1000)} 秒遅らせます。`,
      );
    } else if (published) {
      failures.delete(connection.connection_id);
      backoffUntil.delete(connection.connection_id);
    }
  }

  async function runPass(startup: boolean): Promise<void> {
    try {
      const listed = await store.connectionTargets({
        kind: 'connections.list',
      });
      if (!listed.ok) {
        log(
          `同期の接続一覧を読めませんでした（${listed.reasons.join(', ')}）。`,
        );
        return;
      }
      for (const connection of listed.value) {
        if (stopped) return;
        await runConnection(connection, startup);
      }
    } catch {
      // 周期処理の失敗で scheduler 自体は止めない。次の周期で確かめ直す。
      log('同期の周期処理で失敗しました。次の周期で確かめ直します。');
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    const jitter = (random() * 2 - 1) * jitterMs;
    timer = setTimer(onTick, Math.max(0, pollIntervalMs + jitter));
  }

  function begin(startup: boolean): void {
    const pass = runPass(startup);
    inFlight = pass;
    void pass.then(
      () => {
        if (inFlight === pass) inFlight = null;
        scheduleNext();
      },
      () => {
        if (inFlight === pass) inFlight = null;
        scheduleNext();
      },
    );
  }

  function onTick(): void {
    timer = null;
    if (stopped) return;
    // 前の周期がまだ終わっていない間は重ねない（走査の排他は保存層も持つが、呼出し自体を重ねない）。
    if (inFlight !== null) {
      scheduleNext();
      return;
    }
    begin(false);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      stopped = false;
      begin(true);
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    async idle(): Promise<void> {
      while (inFlight !== null) await inFlight;
    },
  };
}
