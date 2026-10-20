// Core の起動・停止（設計 02 処理の配置・運用上の境界、07 §1・§4、08 §4、ADR 0012・0019）。
//
// 起動: 起動前の検査（鍵保護）→ データディレクトリ → 排他ロック → データ鍵の読み直し（作成しない）
//   → B01 の状態ファイルの読み取り → DB worker（書込み接続・耐久設定の読み戻し・マイグレーション・
//   健全性・鍵の照合値・store_generation）→ 状態ファイルの片付け → 起動時の回復 → 制御チャネル → running。
//   どこかで失敗したら書込みを始めず（DB worker を閉じ、ロックを返し）、理由を付けて起動を拒否する。
// 停止: 新しい要求の受付停止（stopping）→ 制御チャネルを閉じる → DB worker を閉じる
//   → ソケット・ロックの解放 → stopped。ロックは DB を閉じた後に返す（同じ DB の書き手を一つに保つ）。
// Electron には依存せず、クライアントの終了は Core の状態に影響しない。

import { randomUUID } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DbWorkerClient,
  StorageError,
  dataKeyCheckValue,
} from '@buddy/storage';
import type {
  DataKeyMaterial,
  DataKeyProvider,
  DbWorkerOptions,
  StoreBindingResult,
  StoreGenerationSource,
} from '@buddy/storage';
import { callControl, listenControlServer } from './control-channel.js';
import type { ControlServer } from './control-channel.js';
import type {
  ControlRequest,
  ControlResponse,
  ControlStatus,
} from './control-protocol.js';
import {
  DataDirError,
  prepareDataDir,
  readLegacyCoreState,
  removeLegacyCoreState,
} from './data-dir.js';
import { Lifecycle, controlOpDisposition } from './lifecycle.js';
import type { LifecycleState } from './lifecycle.js';
import {
  LockError,
  acquireLock,
  defaultIsPidAlive,
  releaseLock,
} from './lock.js';
import type { LockRefusal } from './lock.js';
import { DB_FILE, controlEndpoint, socketPathTooLong } from './paths.js';
import { runPreflight } from './preflight.js';
import type { PreflightCheck } from './preflight.js';
import { RecoveryError, recoverInterruptedOperations } from './recovery.js';
import type { RecoveryReport } from './recovery.js';

export type CoreStartRefusal =
  | 'preflight_failed'
  | LockRefusal
  | 'data_dir_unsafe'
  | 'state_file_invalid'
  | 'socket_path_too_long'
  | 'endpoint_in_use'
  // ロックの後にデータ鍵を読み直せない（作成はしない。ADR 0019）。
  | 'data_key_unavailable'
  // DB の鍵の照合値と今のデータ鍵が合わない・照合値がないのに暗号文がある。
  | 'data_key_mismatch'
  // 状態ファイルと DB の store_generation が合わない。
  | 'store_generation_mismatch'
  // DB を書込み可能にできない（耐久設定・版・健全性・権限など）。
  | 'store_open_failed'
  // 起動時の回復を記録できない。
  | 'store_recovery_failed';

export class CoreStartError extends Error {
  readonly code: CoreStartRefusal;
  readonly reasons: readonly string[];
  constructor(code: CoreStartRefusal, reasons: readonly string[]) {
    super(`${code}: ${reasons.join(', ')}`);
    this.name = 'CoreStartError';
    this.code = code;
    this.reasons = reasons;
  }
}

export interface StartCoreOptions {
  readonly dataDir: string;
  // 起動前の検査。理由を一つでも返せば起動しない。
  readonly preflight?: readonly PreflightCheck[];
  // データ鍵の取得元（@buddy/platform の KeyStore）。ロックの後に loadDataKey（作成しない）で読み直し、
  // DB の鍵の照合値と比べる。鍵そのものは DB worker へ渡さず、Core も保持しない。
  readonly keyStore: DataKeyProvider;
  // DB worker の設定（試験用）。製品の起動では渡さない。
  readonly storeOptions?: Pick<
    DbWorkerOptions,
    'connectionSql' | 'responseTimeoutMs' | 'startTimeoutMs'
  >;
  // 試験用に差し替えられる。既定は process.kill(pid, 0)。
  readonly isPidAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
  readonly probeTimeoutMs?: number;
  // 停止時に残りの接続を待つ時間。過ぎたら切断する。
  readonly shutdownGraceMs?: number;
  readonly log?: (message: string) => void;
}

export interface CoreHandle {
  readonly dataDir: string;
  readonly endpoint: string;
  readonly coreInstanceId: string;
  readonly storeGeneration: string;
  readonly startedAt: string;
  // store_generation の出どころ（DB の値・状態ファイルから移行・新規作成）。
  readonly storeGenerationSource: StoreGenerationSource;
  // DB の鍵の照合値を今回保存したか、保存済みの値と一致したか。
  readonly dataKeyCheck: 'stored' | 'matched';
  readonly schemaVersion: number;
  // 起動時の回復の結果。
  readonly recovery: RecoveryReport;
  // DB worker のクライアント（受付・照会は B03 以降でここを使う）。停止すると閉じる。
  readonly store: DbWorkerClient;
  readonly state: LifecycleState;
  status(): ControlStatus;
  // 停止を要求する。二度目以降は進行中の終了処理を返す。
  stop(reason: string): Promise<void>;
  // 終了処理が終わると解決する。解放に失敗した場合は拒否する。
  readonly closed: Promise<void>;
}

const GENERATION_LABEL: Readonly<Record<StoreGenerationSource, string>> = {
  database: 'DB の値',
  state_file: '状態ファイルから移行',
  created: '新規作成',
};

const REASON_CODE = /^[a-z0-9_:.-]{1,128}$/u;

// ロックの後にデータ鍵を読み直す。作成はしない（作成は起動前の検査だけ）。
async function loadDataKeyAfterLock(
  keyStore: DataKeyProvider,
): Promise<DataKeyMaterial> {
  let result: Awaited<ReturnType<DataKeyProvider['loadDataKey']>>;
  try {
    result = await keyStore.loadDataKey();
  } catch {
    throw new CoreStartError('data_key_unavailable', [
      'data_key_unavailable:load_failed',
    ]);
  }
  if (result.ok) return result.dataKey;
  const reason = REASON_CODE.test(result.reason) ? result.reason : 'unknown';
  throw new CoreStartError('data_key_unavailable', [
    `data_key_unavailable:${reason}`,
  ]);
}

// DB worker の起動の失敗を起動の拒否へ写す。理由コードだけを出し、パス・SQL・鍵の値を出さない。
function storeRefusal(error: StorageError): CoreStartError {
  const reasons = [
    error.reason,
    ...error.reasons.filter((reason) => reason !== error.reason),
  ];
  if (
    error.reason === 'data_key_check_mismatch' ||
    error.reason === 'data_key_check_missing' ||
    error.reason === 'data_key_check_invalid'
  )
    return new CoreStartError('data_key_mismatch', reasons);
  if (error.reason === 'store_generation_mismatch')
    return new CoreStartError('store_generation_mismatch', reasons);
  return new CoreStartError('store_open_failed', reasons);
}

interface OpenedStore {
  readonly store: DbWorkerClient;
  readonly binding: StoreBindingResult;
  readonly recovery: RecoveryReport;
}

// DB を書込み可能にし、起動時の回復まで済ませる。失敗すれば起動した DB worker を閉じてから投げる。
async function openStore(
  dataDir: string,
  options: StartCoreOptions,
  log: (message: string) => void,
): Promise<OpenedStore> {
  // データ鍵をロックの後に読み直す（作成しない）。起動前の検査で作った鍵が、同時に起動した別の Core に
  // 上書きされていても、この時点の鍵と DB の照合値を比べれば食い違いを検出できる（ADR 0019）。
  const dataKey = await loadDataKeyAfterLock(options.keyStore);
  const dataKeyCheck = dataKeyCheckValue(dataKey);
  const legacy = await readLegacyCoreState(dataDir);
  let store: DbWorkerClient;
  try {
    store = await DbWorkerClient.start({
      ...options.storeOptions,
      path: join(dataDir, DB_FILE),
      binding: {
        dataKeyCheck,
        legacyStoreGeneration: legacy?.store_generation ?? null,
      },
    });
  } catch (error) {
    if (error instanceof StorageError) throw storeRefusal(error);
    throw error;
  }
  try {
    const binding = store.binding;
    if (binding === null)
      throw new CoreStartError('store_open_failed', ['store_binding_missing']);
    if (legacy !== null) {
      // DB へ移した（または DB の値と一致した）状態ファイルを消す。消せなければ起動しない。
      try {
        await removeLegacyCoreState(dataDir);
      } catch {
        throw new CoreStartError('store_open_failed', [
          'state_file_remove_failed',
        ]);
      }
      log(
        '状態ファイルの store_generation を DB へ移し、状態ファイルを消しました。',
      );
    }
    let recovery: RecoveryReport;
    try {
      recovery = await recoverInterruptedOperations(store);
    } catch (error) {
      if (error instanceof RecoveryError)
        throw new CoreStartError('store_recovery_failed', error.reasons);
      if (error instanceof StorageError)
        throw new CoreStartError('store_recovery_failed', [error.reason]);
      throw error;
    }
    log(
      `DB を開きました（版 ${store.schemaVersion}、世代: ${GENERATION_LABEL[binding.storeGenerationSource]}、鍵の照合値: ${binding.dataKeyCheck === 'stored' ? '保存' : '一致'}）。`,
    );
    if (recovery.held.length > 0 || recovery.resumable.length > 0)
      log(
        `起動時の回復: 結果不明として保留（unknown_held）${recovery.held.length} 件、送出前（preparing）のまま ${recovery.resumable.length} 件。自動では送りません。`,
      );
    return { store, binding, recovery };
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}

export async function startCore(
  options: StartCoreOptions,
): Promise<CoreHandle> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const lifecycle = new Lifecycle();

  const reasons = await runPreflight(options.preflight ?? []);
  if (reasons.length > 0) throw new CoreStartError('preflight_failed', reasons);

  let dataDir: string;
  try {
    dataDir = await prepareDataDir(resolve(options.dataDir));
  } catch (error) {
    if (error instanceof DataDirError)
      throw new CoreStartError('data_dir_unsafe', [error.reason]);
    throw error;
  }
  const platform = process.platform;
  const endpoint = controlEndpoint(dataDir, platform);
  if (socketPathTooLong(endpoint, platform))
    throw new CoreStartError('socket_path_too_long', ['socket_path_too_long']);
  const removeSocketFile = async () => {
    if (platform !== 'win32') await rm(endpoint, { force: true });
  };

  const coreInstanceId = randomUUID();
  const startedAt = now().toISOString();
  const startedMono = performance.now();
  const probeTimeoutMs = options.probeTimeoutMs ?? 1000;
  try {
    await acquireLock({
      dataDir,
      endpoint,
      record: {
        pid: process.pid,
        core_instance_id: coreInstanceId,
        started_at: startedAt,
      },
      isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
      probeTimeoutMs,
      removeStaleEndpoint: removeSocketFile,
    });
  } catch (error) {
    if (error instanceof LockError)
      throw new CoreStartError(error.reason, [error.reason]);
    throw error;
  }

  // ここから先の失敗では、取ったロックを必ず返す（DB worker を起動していれば先に閉じる）。
  let opened: OpenedStore | null = null;
  let control: ControlServer;
  let shutdown: Promise<void> | null = null;
  let closedResolve: () => void = () => undefined;
  let closedReject: (error: unknown) => void = () => undefined;
  const closed = new Promise<void>((ok, fail) => {
    closedResolve = ok;
    closedReject = fail;
  });
  // 未処理の拒否にしない。呼び出し側は closed / stop の戻り値で結果を受け取る。
  closed.catch(() => undefined);
  const status = (): ControlStatus => ({
    state: lifecycle.state,
    core_instance_id: coreInstanceId,
    store_generation: opened?.store.storeGeneration ?? '',
    started_at: startedAt,
    uptime_ms: Math.max(0, Math.floor(performance.now() - startedMono)),
    pid: process.pid,
  });
  const reply = (request: ControlRequest): ControlResponse => ({
    ok: true,
    request_id: request.request_id,
    ...status(),
  });

  const runShutdown = async (gate: Promise<void> | undefined) => {
    if (gate) await gate;
    const errors: unknown[] = [];
    const step = async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    await step(() => control.close(options.shutdownGraceMs ?? 2000));
    // 処理中の命令を終えてから DB を閉じる。ロックはその後に返す。
    await step(async () => opened?.store.close());
    await step(removeSocketFile);
    await step(() => releaseLock(dataDir, coreInstanceId));
    lifecycle.apply('released');
    log('Core を停止しました。');
    if (errors.length > 0)
      throw new AggregateError(errors, 'Core の解放に失敗しました。');
  };
  const requestStop = (reason: string, gate?: Promise<void>): Promise<void> => {
    if (shutdown) return shutdown;
    lifecycle.apply(reason === 'failure' ? 'failed' : 'stop_requested');
    log(`停止を開始します（${reason}）。新しい要求の受付を止めました。`);
    shutdown = runShutdown(gate);
    shutdown.then(closedResolve, closedReject);
    return shutdown;
  };

  try {
    opened = await openStore(dataDir, options, log);
    const handle = (request: ControlRequest) => {
      const disposition = controlOpDisposition(lifecycle.state, request.op);
      if (disposition === 'unavailable')
        return { response: { ok: false, error: 'unavailable' } as const };
      if (disposition !== 'begin_stop') return { response: reply(request) };
      // stop は応答を書き終えてから終了処理に入る（書けない場合も 1 秒で進める）。
      let release = () => undefined as void;
      const written = new Promise<void>((done) => {
        release = done;
        setTimeout(done, 1000).unref();
      });
      void requestStop('control', written).catch(() => undefined);
      return { response: reply(request), afterWrite: release };
    };
    control = await listenWithRecovery(
      endpoint,
      platform,
      handle,
      probeTimeoutMs,
      removeSocketFile,
    );
  } catch (error) {
    await opened?.store.close().catch(() => undefined);
    await releaseLock(dataDir, coreInstanceId).catch(() => undefined);
    if (error instanceof DataDirError)
      throw new CoreStartError('state_file_invalid', [error.reason]);
    throw error;
  }
  control.server.on('error', (error) => {
    log(`制御チャネルの障害: ${error.message}`);
    void requestStop('failure').catch(() => undefined);
  });

  lifecycle.apply('started');
  const { store, binding, recovery } = opened;

  return {
    dataDir,
    endpoint,
    coreInstanceId,
    storeGeneration: store.storeGeneration,
    startedAt,
    storeGenerationSource: binding.storeGenerationSource,
    dataKeyCheck: binding.dataKeyCheck,
    schemaVersion: store.schemaVersion,
    recovery,
    store,
    get state() {
      return lifecycle.state;
    },
    status,
    stop: (reason) => requestStop(reason),
    closed,
  };
}

// 接続先が使用中なら、動いている Core か、残ったソケットファイルかを見分ける。
async function listenWithRecovery(
  endpoint: string,
  platform: NodeJS.Platform,
  handle: Parameters<typeof listenControlServer>[0]['handle'],
  probeTimeoutMs: number,
  removeSocketFile: () => Promise<void>,
): Promise<ControlServer> {
  for (let attempt = 0; ; attempt += 1) {
    let server: ControlServer;
    try {
      server = await listenControlServer({ endpoint, handle });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      const probe = await callControl(endpoint, 'status', probeTimeoutMs);
      if (probe.kind === 'response')
        throw new CoreStartError('already_running', ['already_running']);
      // ロックを持っているので、誰も受け付けていないソケットファイルは前回の残り。
      if (attempt > 0 || platform === 'win32' || probe.kind !== 'absent')
        throw new CoreStartError('endpoint_in_use', ['endpoint_in_use']);
      await removeSocketFile();
      continue;
    }
    // ソケットファイルは本人だけ（0600）。作成直後の隙間は 0700 のデータディレクトリが守る。
    if (platform !== 'win32') {
      try {
        await chmod(endpoint, 0o600);
      } catch (error) {
        await server.close(0);
        throw error;
      }
    }
    return server;
  }
}
