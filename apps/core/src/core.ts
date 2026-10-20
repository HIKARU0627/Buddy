// Core の起動・停止（設計 02 処理の配置・運用上の境界、07 §1・§4、08 §4、ADR 0012）。
//
// 起動: 起動前の検査 → データディレクトリ → 排他ロック → 状態ファイル → 制御チャネル → running。
// 停止: 新しい要求の受付停止（stopping）→ 制御チャネルを閉じる → ソケット・ロックの解放 → stopped。
// Electron には依存せず、クライアントの終了は Core の状態に影響しない。

import { randomUUID } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { callControl, listenControlServer } from './control-channel.js';
import type { ControlServer } from './control-channel.js';
import type {
  ControlRequest,
  ControlResponse,
  ControlStatus,
} from './control-protocol.js';
import {
  DataDirError,
  loadOrCreateCoreState,
  prepareDataDir,
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
import { controlEndpoint, socketPathTooLong } from './paths.js';
import { runPreflight } from './preflight.js';
import type { PreflightCheck } from './preflight.js';

export type CoreStartRefusal =
  | 'preflight_failed'
  | LockRefusal
  | 'data_dir_unsafe'
  | 'state_file_invalid'
  | 'socket_path_too_long'
  | 'endpoint_in_use';

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
  // 今回の起動で状態ファイルを新しく作ったか。
  readonly createdState: boolean;
  readonly state: LifecycleState;
  status(): ControlStatus;
  // 停止を要求する。二度目以降は進行中の終了処理を返す。
  stop(reason: string): Promise<void>;
  // 終了処理が終わると解決する。解放に失敗した場合は拒否する。
  readonly closed: Promise<void>;
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

  // ここから先の失敗では、取ったロックを必ず返す。
  let storeGeneration: string;
  let createdState: boolean;
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
    store_generation: storeGeneration,
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
    const loaded = await loadOrCreateCoreState(dataDir, now());
    storeGeneration = loaded.state.store_generation;
    createdState = loaded.created;
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
  log(
    createdState
      ? '状態ファイルを作成しました。'
      : '既存の状態ファイルを使います。',
  );

  return {
    dataDir,
    endpoint,
    coreInstanceId,
    storeGeneration,
    startedAt,
    createdState,
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
