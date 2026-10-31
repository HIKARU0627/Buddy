// Core の起動・停止（設計 02 処理の配置・運用上の境界、07 §1・§4、08 §4、ADR 0012・0019）。
//
// 起動: 起動前の検査（鍵保護）→ データディレクトリ → 排他ロック → データ鍵の読み直し（作成しない）
//   → B01 の状態ファイルの読み取り → DB worker（書込み接続・耐久設定の読み戻し・マイグレーション・
//   健全性・鍵の照合値・store_generation）→ 状態ファイルの片付け → 起動時の回復 → 用事の暗号文の移行（ADR 0051）
//   → 予算の門（設定ファイルの読み込み・予算の再起動の照合・予算月。ADR 0037）→ イベントの配信の元
//   →（HTTPS を設定したとき）TLS の身元（秘密鍵はキーチェーン）→ HTTPS の待ち受け（スナップショット・イベント・
//   操作の経路と WSS の配信、ADR 0023）→ 制御チャネル → running。
//   どこかで失敗したら書込みを始めず（DB worker を閉じ、ロックを返し）、理由を付けて起動を拒否する。
// 停止: 新しい要求の受付停止（stopping）→ WSS の購読を 1001 で閉じる → HTTPS を閉じる → 制御チャネルを閉じる
//   → DB worker を閉じる
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
import {
  UNAVAILABLE_TAILSCALE_STATUS,
  createUnsupportedBackupKeyStore,
} from '@buddy/platform';
import type {
  BackupKeyStore,
  TailscaleStatusSource,
  TlsKeyStore,
} from '@buddy/platform';
import { HomeNetworkKey, createHomeNetworkGate } from './api-home-network.js';
import type { HomeNetworkGate } from './api-home-network.js';
import { ApiListenError, createApiServer } from './api-server.js';
import type { ApiLimits, ApiRouteHandler, ApiServer } from './api-server.js';
import {
  SAFE_REQUEST_ENVIRONMENT,
  declaredLockState,
} from './api-environment.js';
import type { RequestEnvironment } from './api-environment.js';
import {
  PairingStoreError,
  controlDevice,
  createPairingService,
  isSameMachine,
  listDeviceRecords,
  revokeDeviceRecord,
} from './api-pairing.js';
import type {
  DeviceAdministrationOptions,
  PairingService,
} from './api-pairing.js';
import {
  REVISION_CHECKED_ROUTES,
  createOperationRoutes,
} from './api-operations.js';
import type { PreviewCheck } from './api-operations.js';
import { DeviceConnections } from './device-connections.js';
import {
  TaskMigrationError,
  migrateTaskContents,
} from './task-content-migration.js';
import { ForgetLedgerError, syncForgetLedger } from './forget-ledger.js';
import {
  RestoreInstallError,
  recoverRestoreInstall,
} from './restore-install.js';
import { createTurnRoutes } from './api-turns.js';
import { CanvasHub, createStreamRoutes } from './canvas-stream.js';
import { PreviewRegistry } from './previews.js';
import {
  NO_FAULTS,
  TEST_TURN_POLICY,
  createMockInterpreter,
} from './turn-ports.js';
import type {
  CandidateSource,
  FaultHook,
  Interpreter,
  ProviderReader,
  ProviderWriter,
  TurnPolicy,
} from './turn-ports.js';
import { createApiContract } from './api-contract.js';
import { backupControl, isBackupControlRequest } from './backup-control.js';
import type { BackupControlContext } from './backup-control.js';
import { createBackupService, startBackupScheduler } from './backup-service.js';
import type { BackupScheduler, BackupService } from './backup-service.js';
import {
  BUDGET_REVISION_CHECKED_ROUTES,
  createBudgetRoutes,
} from './api-budget.js';
import { BUDGET_CONFIG_FILE, loadBudgetConfig } from './budget-config.js';
import { BUDGET_CREDIT_FILE, fileCreditSource } from './budget-credit.js';
import type { CreditObservationSource } from './budget-credit.js';
import { BudgetGate } from './budget-gate.js';
import { createVoiceRoutes } from './api-voice.js';
import {
  createLiveBudget,
  DEFAULT_LIVE_PROFILE_ID,
  DEFAULT_LIVE_PROFILE_REVISION,
} from './live-budget.js';
import {
  combineReconcilers,
  createLiveUsageReconciler,
} from './live-reconcile.js';
import { VoiceControl } from './voice-control.js';
import type {
  LiveBudgetPort,
  LiveProvider,
  VoiceControlOptions,
  VoiceTimers,
} from './voice-control.js';
import type { UsageReconciler } from './budget-gate.js';
import { createOperationRunner } from './operation-runner.js';
import type { OperationRunner } from './operation-runner.js';
import { EventFeed } from './event-feed.js';
import type { EventFeedOptions } from './event-feed.js';
import { createEventStream } from './event-stream.js';
import type { EventStreamManager, EventStreamOptions } from './event-stream.js';
import { callControl, listenControlServer } from './control-channel.js';
import type { ControlServer } from './control-channel.js';
import type {
  ControlBudgetCalendar,
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
import {
  DB_FILE,
  FORGET_LEDGER_FILE,
  controlEndpoint,
  socketPathTooLong,
} from './paths.js';
import { runPreflight } from './preflight.js';
import type { PreflightCheck } from './preflight.js';
import { RecoveryError, recoverInterruptedOperations } from './recovery.js';
import type { RecoveryReport } from './recovery.js';
import {
  RetentionSweeper,
  createRetentionSweepPort,
} from './retention-sweeper.js';
import { TlsIdentityError, loadOrCreateTlsIdentity } from './tls-identity.js';
import type { TlsIdentityCreation } from './tls-identity.js';

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
  | 'store_recovery_failed'
  // HTTPS の設定（待ち受けるアドレス・ポート）が不正。
  | 'https_config_invalid'
  // TLS の秘密鍵を鍵保護から取得できない・証明書が使えない（HTTPS を開かない）。
  | 'tls_unavailable'
  // HTTPS の待ち受けに失敗した（使用中のポート・存在しないアドレスなど）。
  | 'https_listen_failed';

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

// HTTPS の受付の設定（ADR 0020）。渡さなければ HTTPS を開かない（B01・B02 の起動と同じ）。
export interface CoreHttpsOptions {
  // 待ち受ける IP アドレス。製品は Tailscale のアドレス、試験は 127.0.0.1。全アドレスは拒否する。
  readonly host: string;
  // 0 は OS が選ぶ（試験用）。
  readonly port: number;
  // TLS の秘密鍵の取得元（@buddy/platform の TlsKeyStore。macOS はキーチェーンの tls-key-v1）。
  readonly tlsKeyStore: TlsKeyStore;
  // 判定の元がまだない文脈（ロック状態など）。試験で差し替える。省略したものは安全側。
  // homeNetwork を渡すと自宅判定（B03-03）を置き換える（試験用）。
  readonly environment?: Partial<RequestEnvironment>;
  readonly limits?: Partial<ApiLimits>;
  // 中枢の Tailscale の状態（ADR 0022。製品は `tailscale status --json`）。省略すると取得できない扱いで、
  // 中枢と同じマシンのクライアント以外は自宅判定が成り立たない（安全側）。
  readonly tailscale?: TailscaleStatusSource;
  // 接続元が中枢と同じマシンか（試験で差し替える。既定はループバックか待ち受けのアドレスと同じ IP）。
  readonly sameMachine?: (remoteAddress: string) => boolean;
  // preview の有効性の差し替え（試験用、ADR 0023）。省略すると previewOperation で発行した preview と照合する
  // （ADR 0029）。
  readonly previewValid?: PreviewCheck;
  // 発言の解釈・対象の解決・方針（ADR 0029）。省略したものは、解釈は模擬（モデルを使わない）、provider は
  // 接続なし、候補はなし、方針は試験用の表（自動実行はすべて off）、時差は +09:00。
  readonly turns?: CoreTurnOptions;
  // WSS の配信の設定（試験用。ping の間隔・送り先に溜めてよい量）。
  readonly eventStream?: Pick<
    EventStreamOptions,
    'pingIntervalMs' | 'maxBufferedBytes'
  >;
  // 音声の制御（B05-03、ADR 0046）。省略したものは、provider・予算の門の境界はなし（Live の接続は 503）、同意は
  // missing（開かない）、表示先はなし、時計は performance.now と実際のタイマー。
  readonly voice?: CoreVoiceOptions;
}

export interface CoreVoiceOptions {
  readonly provider?: LiveProvider | null;
  readonly budget?: LiveBudgetPort | null;
  readonly consent?: VoiceControlOptions['consent'];
  readonly displayTarget?: () => string | null;
  readonly timers?: VoiceTimers;
  readonly monoNow?: () => number;
}

export interface CoreTurnOptions {
  readonly interpreter?: Interpreter;
  readonly provider?: ProviderReader | null;
  readonly candidates?: CandidateSource;
  readonly policy?: TurnPolicy;
  readonly utcOffset?: string;
  // 連携の provider への書込み（ADR 0030）。null なら外部変更を実行しない（承認の後も approved のまま）。
  readonly writer?: ProviderWriter | null;
  // Core 側の故障点（試験用）。既定は何もしない。
  readonly faults?: FaultHook;
}

export interface CoreHttpsInfo {
  readonly host: string;
  readonly port: number;
  // 証明書の DER 全体の SHA-256 の小文字の 16 進。
  readonly certificateFingerprint: string;
  readonly certificateCreation: TlsIdentityCreation;
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
  // HTTPS の受付。省略すれば開かない。
  readonly https?: CoreHttpsOptions;
  // イベントの配信の元の設定（試験用。読み直しの間隔・1 ページの件数・故障点）。
  readonly events?: Pick<
    EventFeedOptions,
    'pollIntervalMs' | 'pageSize' | 'afterRead'
  >;
  // 予算の門（ADR 0037）。省略したものは、設定ファイルはデータディレクトリの budget-runtime.json、OS のタイムゾーンは
  // Intl の既定、provider の照合の口はなし（送出意図のある予約は usage 不明として保持）、月の確認は 1 分ごと。
  readonly budget?: CoreBudgetOptions;
  // バックアップ（ADR 0055）。鍵の KeyStore を渡さなければ、対応しない OS と同じく鍵を扱えない（設定があっても取らない）。
  readonly backup?: CoreBackupOptions;
}

export interface CoreBackupOptions {
  readonly keyStore?: BackupKeyStore;
  // 定期の実行（1 日 1 回、または忘却の置き換えを待つとき）。省略すれば動かさない（CLI の start が有効にする）。
  readonly scheduler?: {
    readonly checkIntervalMs?: number;
    readonly retryAfterFailureMs?: number;
  };
  // 試験用: 封筒を書く直前に呼ぶ。
  readonly beforeWrite?: () => void;
  // 試験用: 封筒の削除（一時的な失敗の再現）。
  readonly removeFile?: (path: string) => Promise<void>;
  // 試験用: 掃除の開始時に呼ぶ（掃除が始まる前の失敗の再現）。
  readonly beforeSweep?: () => void | Promise<void>;
}

export interface CoreBudgetOptions {
  readonly configPath?: string;
  // 付帯クレジットの残高の観測（ADR 0042）。省略したものは、データディレクトリの budget-credit-observations.json を
  // 受付・精算・状態欄のたびに読む。設定（budget-runtime.json）に credit がなければ使わない。
  readonly creditPath?: string;
  readonly creditObservations?: CreditObservationSource;
  readonly osTimeZone?: () => string;
  readonly reconciler?: UsageReconciler;
  // 予算月を進める間隔（月替わりの知らせ）。0 なら定期には進めない（受付のたびには進める）。
  readonly tickIntervalMs?: number;
  readonly p95ProfileIds?: readonly string[];
  // 予算の門の時計（試験で予算月を動かす）。省略すると Core の時計。
  readonly now?: () => number;
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
  // HTTPS の受付。設定しなければ null。
  readonly https: CoreHttpsInfo | null;
  // 実行担当（ADR 0030）。HTTPS を設定しなければ null。idle() は試験・診断の待ち合わせに使う。
  readonly runner: OperationRunner | null;
  // イベントの配信の元（ADR 0023）。操作の命令を別の経路で送ったら notify() を呼ぶ（呼ばなくても一定の間隔で読み直す）。
  readonly events: EventFeed;
  // 端末の接続（WSS の購読）を閉じる差し込み口。失効（B03-02、ADR 0021）・自宅判定の不成立（B03-03）が呼ぶ。
  readonly deviceConnections: DeviceConnections;
  // 予算の門（ADR 0037）。有料の provider へ送るアダプターはここを通す。設定がなければ有料の処理を受け付けない。
  readonly budget: BudgetGate;
  // バックアップの作成と掃除（ADR 0055）。設定（backup-config.json）と鍵の包みがなければ取らない。
  readonly backup: BackupService;
  // ペアリング（最初の端末の CLI の承認を含む。ADR 0021）。HTTPS を設定しなければ null。
  readonly pairing: PairingService | null;
  // 自宅判定（ADR 0022）。HTTPS を設定しなければ null。onDenied で WSS を閉じる（配信は B03-04）。
  readonly homeNetwork: HomeNetworkGate | null;
  // 保存期限の掃除の job（ADR 0053）。gate() が開くまで検索・クラウドへの送信・自動利用を許さない。
  readonly retention: RetentionSweeper;
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
  // データ鍵から導いた自宅の HMAC の鍵（ADR 0022）。データ鍵そのものは保持しない。
  readonly homeNetworkKey: HomeNetworkKey;
}

// DB を書込み可能にし、起動時の回復まで済ませる。失敗すれば起動した DB worker を閉じてから投げる。
async function openStore(
  dataDir: string,
  options: StartCoreOptions,
  log: (message: string) => void,
): Promise<OpenedStore> {
  // 途中で止まった復元の差し替えを、DB を開く前に終えるか元へ戻す（ADR 0054 U113）。DB がないまま新しい DB を作らない。
  try {
    const restored = await recoverRestoreInstall(dataDir);
    if (restored !== 'none')
      log(
        restored === 'completed'
          ? '途中で止まった復元の差し替えを終えました。'
          : '途中で止まった復元の差し替えを取りやめ、元の DB に戻しました。',
      );
  } catch (error) {
    if (error instanceof RestoreInstallError)
      throw new CoreStartError('store_recovery_failed', [
        'restore_install',
        error.reason,
      ]);
    throw error;
  }
  // データ鍵をロックの後に読み直す（作成しない）。起動前の検査で作った鍵が、同時に起動した別の Core に
  // 上書きされていても、この時点の鍵と DB の照合値を比べれば食い違いを検出できる（ADR 0019）。
  const dataKey = await loadDataKeyAfterLock(options.keyStore);
  const dataKeyCheck = dataKeyCheckValue(dataKey);
  const homeNetworkKey = HomeNetworkKey.fromDataKey(dataKey);
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
    // 起動時のデータ移行（ADR 0051）: 0010 までの用事の正本を、確定 intent から用事自身の暗号文へ移す。
    // 移していない用事がある操作だけを J5 の本文の削除と 90 日の削除から残し、ほかの操作の削除は進める。
    try {
      const migration = await migrateTaskContents(store, dataKey);
      if (migration.migrated > 0 || migration.pending > 0)
        log(
          `用事の暗号文の移行: 移した ${migration.migrated} 件、移せなかった ${migration.failed.length} 件、残り ${migration.pending} 件。残りの用事がある操作だけが、終わった操作の本文の削除から残ります。`,
        );
    } catch (error) {
      if (error instanceof TaskMigrationError)
        throw new CoreStartError('store_recovery_failed', [
          'task_content_migration_failed',
          error.reason,
        ]);
      throw error;
    }
    // 忘却台帳の別ファイルを DB にそろえる（ADR 0054）。COMMIT の後・書く前に止まった忘却はここで書き直す。ファイルが
    // DB より進んでいる・食い違う・壊れているときは起動しない（DB が古い状態へ戻された疑い）。
    try {
      const ledger = await syncForgetLedger(
        store,
        join(dataDir, FORGET_LEDGER_FILE),
        new Date(),
      );
      if (ledger.action === 'written')
        log(
          `忘却台帳のファイルを DB に合わせて書きました（世代 ${ledger.forgetting_generation}）。`,
        );
    } catch (error) {
      if (error instanceof ForgetLedgerError)
        throw new CoreStartError('store_recovery_failed', [
          'forget_ledger_file',
          error.reason,
          ...error.reasons,
        ]);
      throw error;
    }
    log(
      `DB を開きました（版 ${store.schemaVersion}、世代: ${GENERATION_LABEL[binding.storeGenerationSource]}、鍵の照合値: ${binding.dataKeyCheck === 'stored' ? '保存' : '一致'}）。`,
    );
    if (recovery.held.length > 0 || recovery.resumable.length > 0)
      log(
        `起動時の回復: 結果不明として保留（unknown_held）${recovery.held.length} 件、送出意図の前（approved・preparing）${recovery.resumable.length} 件。保留は自動では送らず、送出意図の前の操作は対象を確かめ直してから再開します。`,
      );
    return { store, binding, recovery, homeNetworkKey };
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
  let api: ApiServer | null = null;
  let streams: EventStreamManager | null = null;
  let runner: OperationRunner | null = null;
  let feed: EventFeed | null = null;
  const deviceConnections = new DeviceConnections();
  let httpsInfo: CoreHttpsInfo | null = null;
  let homeNetwork: HomeNetworkGate | null = null;
  let pairing: PairingService | null = null;
  let budget: BudgetGate | null = null;
  let budgetTimer: NodeJS.Timeout | null = null;
  let backup: BackupService | undefined;
  let backupContext: BackupControlContext | null = null;
  let backupScheduler: BackupScheduler | null = null;
  let retention: RetentionSweeper | null = null;
  let voice: VoiceControl | null = null;
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
    // 実行担当を止める（以後は外部へ送らない。送出意図の後に止まった試行は次の起動で unknown_held になる）。
    runner?.close();
    // 予算月の定期の確認と、保存期限の掃除の定期実行を止める。
    if (budgetTimer !== null) clearInterval(budgetTimer);
    backupScheduler?.stop();
    retention?.close();
    // WSS の購読を理由つき（1001）で閉じ、配信の元を止めてから HTTPS を閉じる。
    await step(async () => {
      await streams?.closeAll();
      feed?.close();
    });
    await step(async () => api?.close(options.shutdownGraceMs ?? 2000));
    await step(() => control.close(options.shutdownGraceMs ?? 2000));
    // 音声の制御のタイマーとサイドバンドを止める（閉じ終えていない Live は次の起動の照合が扱う）。
    await step(async () => voice?.close());
    // 実行中の掃除と後始末を終えてから DB を閉じる（閉じた後の命令で失敗を出さない）。掃除は次の区切りで中断する。
    await step(async () => retention?.drain());
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
    // 保存期限の掃除（ADR 0053）。起動の直後はゲートを閉じたまま、最初の掃除を始める。検索・クラウドへの
    // 送信・自動利用の入口は、済むまで retention.gate() が閉じていることを確かめる。
    retention = new RetentionSweeper({
      port: createRetentionSweepPort(opened.store),
      epoch: coreInstanceId,
      now: () => now().getTime(),
      log,
    });
    retention.start();
    const startedBudget = await startBudgetGate(
      dataDir,
      options,
      opened.store,
      now,
      log,
    );
    budget = startedBudget.gate;
    budgetTimer = startedBudget.timer;
    {
      const backupKeys =
        options.backup?.keyStore ??
        createUnsupportedBackupKeyStore(process.platform);
      const contract = createApiContract();
      backup = createBackupService({
        dataDir,
        contract,
        store: opened.store,
        backupKeys,
        now,
        log,
        ...(options.backup?.beforeWrite === undefined
          ? {}
          : { beforeWrite: options.backup.beforeWrite }),
        ...(options.backup?.removeFile === undefined
          ? {}
          : { removeFile: options.backup.removeFile }),
        ...(options.backup?.beforeSweep === undefined
          ? {}
          : { beforeSweep: options.backup.beforeSweep }),
      });
      backupContext = {
        dataDir,
        contract,
        service: backup,
        store: opened.store,
        backupKeys,
      };
      if (options.backup?.scheduler !== undefined)
        backupScheduler = startBackupScheduler({
          service: backup,
          log,
          now,
          setTimer: (run, ms) => {
            const timer = setTimeout(run, ms);
            timer.unref();
            return timer;
          },
          clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
          ...options.backup.scheduler,
        });
    }
    feed = new EventFeed({
      store: opened.store,
      now: () => now().getTime(),
      ...options.events,
    });
    if (options.https !== undefined) {
      const started = await startHttps(
        dataDir,
        options.https,
        opened,
        coreInstanceId,
        () => lifecycle.state === 'running',
        now,
        feed,
        deviceConnections,
        log,
        options.keyStore,
        budget,
        retention,
      );
      api = started.api;
      streams = started.streams;
      runner = started.runner;
      voice = started.voice;
      httpsInfo = started.info;
      homeNetwork = started.homeNetwork;
      pairing = started.pairing;
      log(
        `HTTPS を待ち受けました（${httpsInfo.host}:${httpsInfo.port}、証明書の指紋 ${httpsInfo.certificateFingerprint}）。`,
      );
      if (httpsInfo.certificateCreation !== 'existing')
        log(
          '証明書を新しく作りました。登録済みの端末は指紋が合わなくなるため、再登録が必要です。',
        );
    }
    const handle = (request: ControlRequest) => {
      if (
        request.op === 'pairing_first_start' ||
        request.op === 'pairing_first_approve'
      )
        return firstDeviceControl(request, lifecycle.state, pairing);
      if (request.op === 'device_list' || request.op === 'device_revoke')
        return deviceControl(
          request,
          lifecycle.state,
          opened === null
            ? null
            : {
                store: opened.store,
                deviceConnections,
                now: () => now().getTime(),
                log,
              },
        );
      if (
        request.op === 'budget_calendar_status' ||
        request.op === 'budget_calendar_confirm'
      )
        return budgetControl(request, lifecycle.state, budget);
      if (isBackupControlRequest(request))
        return backupControl(request, lifecycle.state, backupContext);
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
    if (budgetTimer !== null) clearInterval(budgetTimer);
    backupScheduler?.stop();
    retention?.close();
    feed?.close();
    await api?.close(0).catch(() => undefined);
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
  const events = feed;
  const budgetGate = budget as BudgetGate;
  const backupService = backup as BackupService;

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
    https: httpsInfo,
    runner,
    homeNetwork,
    events,
    deviceConnections,
    budget: budgetGate,
    backup: backupService,
    retention: retention as RetentionSweeper,
    pairing,
    get state() {
      return lifecycle.state;
    },
    status,
    stop: (reason) => requestStop(reason),
    closed,
  };
}

// TLS の身元を読み込み（初回は作り）、HTTPS を待ち受ける。鍵保護が使えなければ開かない。
async function startHttps(
  dataDir: string,
  https: CoreHttpsOptions,
  opened: OpenedStore,
  coreInstanceId: string,
  accepting: () => boolean,
  now: () => Date,
  feed: EventFeed,
  deviceConnections: DeviceConnections,
  log: (message: string) => void,
  keyStore: DataKeyProvider,
  budget: BudgetGate,
  retention: RetentionSweeper | null,
): Promise<{
  readonly api: ApiServer;
  readonly info: CoreHttpsInfo;
  readonly streams: EventStreamManager;
  readonly pairing: PairingService;
  readonly homeNetwork: HomeNetworkGate;
  readonly runner: OperationRunner;
  readonly voice: VoiceControl;
}> {
  const store = opened.store;
  let identity;
  try {
    identity = await loadOrCreateTlsIdentity({
      dataDir,
      tlsKeyStore: https.tlsKeyStore,
      now: now(),
    });
  } catch (error) {
    if (error instanceof TlsIdentityError)
      throw new CoreStartError('tls_unavailable', error.reasons);
    throw error;
  }
  // 接続元が中枢と同じマシンか。ペアリング（中枢の画面・登録前の申請）と自宅判定（免除）で同じ判定を使う。
  const sameMachine =
    https.sameMachine ??
    ((remote: string) => isSameMachine(remote, https.host));
  // 待ち受けのアドレスとポート（listen の後に決まる。ポート 0 の試験では実際のポート）。
  let listening: { readonly host: string; readonly port: number } | null = null;
  const pairing = createPairingService({
    store,
    fingerprint: identity.fingerprint,
    host: https.host,
    endpoint: () => listening,
    now: () => now().getTime(),
    deviceConnections,
    log,
    sameMachine,
  });
  // 自宅判定（ADR 0022）。不成立なら接続範囲を失効させ、その端末の WSS の購読を閉じる（4403）。
  const homeNetwork = createHomeNetworkGate({
    store,
    key: opened.homeNetworkKey,
    tailscale: https.tailscale ?? UNAVAILABLE_TAILSCALE_STATUS,
    sameMachine,
    now: () => now().getTime(),
    log,
  });
  homeNetwork.onDenied((deviceId) => {
    deviceConnections.closeDevice(deviceId, 'outside_home_network');
  });
  // 証明書が変わっていれば、前の証明書で登録した端末を受付の前に失効する（自動で承認せず、再登録にする）。
  try {
    await pairing.revokeCertificateMismatch();
  } catch (error) {
    if (error instanceof PairingStoreError)
      throw new CoreStartError('store_recovery_failed', [
        'certificate_device_revocation_failed',
        ...error.reasons,
      ]);
    throw error;
  }
  // 操作の命令の後にイベントを配るよう、命令を送る store を通知つきにする（ADR 0023）。
  const watched = feed.watchStore(store);
  // 音声の制御（ADR 0046）。世代と停止の状態は DB が正本。起動時に前の起動の閉じ終えていない Live を照合する。
  const voiceOptions = https.voice ?? {};
  const voice = new VoiceControl({
    store,
    coreInstanceId,
    monoNow: voiceOptions.monoNow ?? (() => performance.now()),
    wallNow: () => now().getTime(),
    ...(voiceOptions.timers === undefined
      ? {}
      : { timers: voiceOptions.timers }),
    provider: voiceOptions.provider ?? null,
    // 会話の予約は予算の門から作る（設定に live_seconds の単価の系列がちょうど 1 つあるときだけ。なければ Live は開かない）。
    budget:
      voiceOptions.budget ??
      (budget.livePriceKey() === null
        ? null
        : createLiveBudget(budget, {
            profile_id: DEFAULT_LIVE_PROFILE_ID,
            profile_revision: DEFAULT_LIVE_PROFILE_REVISION,
            price_key: budget.livePriceKey() as string,
          })),
    ...(voiceOptions.consent === undefined
      ? {}
      : { consent: voiceOptions.consent }),
    ...(voiceOptions.displayTarget === undefined
      ? {}
      : { displayTarget: voiceOptions.displayTarget }),
    log,
  });
  try {
    await voice.start();
  } catch {
    throw new CoreStartError('store_recovery_failed', [
      'voice_reconcile_failed',
    ]);
  }
  // 注入した環境（試験）が、ペアリングの判定（中枢の画面・申請用の秘密）と自宅判定（B03-03）より優先する。
  // ロック状態は端末の main が Buddy-Lock-State で申告した値（認証した端末だけ。B03-05、ADR 0025）。
  const merged: RequestEnvironment = {
    ...SAFE_REQUEST_ENVIRONMENT,
    lockState: declaredLockState,
    ...pairing.environment,
    homeNetwork: homeNetwork.homeNetwork,
    // 音声所有権は中枢の音声リース（ADR 0046）。
    audioOwner: (input) => voice.audioOwner(input.device),
    ...https.environment,
  };
  // 発行した preview（ADR 0029）。Core のメモリーだけに置き、再起動で無効になる。端末の接続の終了（失効・自宅判定の
  // 不成立）とロック（ロック中・不明の判定）で、その端末の preview を無効にする。
  const previews = new PreviewRegistry();
  deviceConnections.onDeviceClosed((deviceId) => {
    previews.invalidateDevice(deviceId);
  });
  const base: RequestEnvironment = {
    ...merged,
    lockState: async (input) => {
      const state = await merged.lockState(input);
      if (state !== 'unlocked' && input.device !== null)
        previews.invalidateDevice(input.device.device_id);
      return state;
    },
  };
  let routes: ReturnType<typeof createOperationRoutes> | null = null;
  // 予算の 4 経路（ADR 0039）。M 超過の確認・手での精算の版は予約の行の現在値で照合する。
  const budgetRoutes = createBudgetRoutes({
    gate: budget,
    receiptExists: (commandScopeId, requestId) =>
      store.query({
        kind: 'receipt_exists',
        command_scope_id: commandScopeId,
        request_id: requestId,
      }),
  });
  // 承認・取消・予算の版の照合は DB の現在値で行う。他の経路は注入した環境（なければ安全側の既定）。
  const environment: RequestEnvironment = {
    ...base,
    revisionMatches: (input) =>
      routes !== null && REVISION_CHECKED_ROUTES.has(input.operationId)
        ? routes.revisionMatches(input)
        : BUDGET_REVISION_CHECKED_ROUTES.has(input.operationId)
          ? budgetRoutes.revisionMatches(input)
          : input.operationId === 'resumeIo'
            ? voice.revisionMatches(input.device, input.body)
            : base.revisionMatches(input),
  };
  const turnOptions = https.turns ?? {};
  const turns = createTurnRoutes({
    store: watched,
    keyStore,
    interpreter: turnOptions.interpreter ?? createMockInterpreter(),
    provider: turnOptions.provider ?? null,
    candidates: turnOptions.candidates ?? {
      mailCandidates: () => Promise.resolve([]),
    },
    policy: turnOptions.policy ?? TEST_TURN_POLICY,
    previews,
    utcOffset: turnOptions.utcOffset ?? '+09:00',
    now: () => now().getTime(),
    onOperationCreated: () => feed.notify(),
    // 検索・クラウドへの送信の前に、掃除のゲートを通す（ADR 0053）。今ある入口（予定の照会・下書き・ラベル）だけ。
    ...(retention === null
      ? {}
      : {
          retention: {
            ready: async () => {
              await retention?.idle();
            },
            gate: () => (retention as RetentionSweeper).gate(),
            lease: () => (retention as RetentionSweeper).lease(),
          },
        }),
  });
  // 連携の口座と許可の版を一度確かめておく（発言の入力の時点の版を外部へ問い合わせずに持つ。B04-07）。
  await turns.prime().catch(() => undefined);
  // 流れへの発言とキャンバスの記述（UI-03、ADR 0032）。キャンバスの正本は Core（RAM）。発言は既存の発言の処理を呼ぶ。
  const canvas = new CanvasHub();
  const stream = createStreamRoutes({
    canvas,
    createSession: turns.handlers['createSession'] as ApiRouteHandler,
    postTurn: turns.handlers['postTurn'] as ApiRouteHandler,
    now: () => now().getTime(),
  });
  // 実行担当（ADR 0030）。承認の後・起動時の再開・本人の照合と再試行を受け持つ。
  const faults = turnOptions.faults ?? NO_FAULTS;
  const runner = createOperationRunner({
    store: watched,
    keyStore,
    provider: turnOptions.provider ?? null,
    writer: turnOptions.writer ?? null,
    faults,
    contract: createApiContract(),
    log,
    // 外部へ送る前に、掃除が済んでクラウド送信が許されていることを確かめる（ADR 0053 の U108）。
    ...(retention === null
      ? {}
      : {
          cloudGate: {
            ready: async () => {
              await retention?.idle();
            },
            open: () => (retention as RetentionSweeper).gate().cloud_send,
            lease: () => (retention as RetentionSweeper).lease(),
          },
        }),
  });
  routes = createOperationRoutes({
    store: watched,
    feed,
    coreInstanceId,
    environment,
    now: () => now().getTime(),
    ...(https.previewValid === undefined
      ? {
          previewValid: turns.previewValid,
          previewCurrent: turns.previewCurrent,
        }
      : { previewValid: https.previewValid }),
    runner,
    faults,
    budgetHold: () => budget.holdState(),
  });
  const streams = createEventStream({
    feed,
    store,
    coreInstanceId,
    environment,
    deviceConnections,
    canvas,
    voice: {
      subscribe: (deviceId, listener) => voice.subscribe(deviceId, listener),
    },
    now: () => now().getTime(),
    faults,
    ...https.eventStream,
  });
  const voiceRoutes = createVoiceRoutes(voice);
  // 経路の処理の表は重ならない（同じ operationId を二つの処理が持たない）。重なれば起動しない。
  const handlerKeys = [
    pairing.handlers,
    routes.handlers,
    homeNetwork.handlers,
    turns.handlers,
    stream.handlers,
    budgetRoutes.handlers,
    voiceRoutes.handlers,
  ].flatMap((handlers) => Object.keys(handlers));
  if (new Set(handlerKeys).size !== handlerKeys.length)
    throw new Error('route_handlers_overlap');
  let api: ApiServer;
  try {
    api = createApiServer({
      host: https.host,
      port: https.port,
      identity,
      store,
      coreInstanceId,
      accepting,
      now: () => now().getTime(),
      environment,
      handlers: {
        ...pairing.handlers,
        ...routes.handlers,
        ...homeNetwork.handlers,
        ...turns.handlers,
        ...stream.handlers,
        ...budgetRoutes.handlers,
        ...voiceRoutes.handlers,
      },
      eventStream: streams,
      ioState: (device, lock) => voice.ioState(device, lock),
      ...(https.limits === undefined ? {} : { limits: https.limits }),
    });
  } catch (error) {
    if (error instanceof ApiListenError)
      throw new CoreStartError('https_config_invalid', [error.reason]);
    throw error;
  }
  try {
    await api.listen();
  } catch (error) {
    await api.close(0).catch(() => undefined);
    if (error instanceof ApiListenError)
      throw new CoreStartError('https_listen_failed', [error.reason]);
    throw error;
  }
  listening = { host: api.host, port: api.port };
  // 起動時の再開: 送出意図の前（approved・preparing）の操作を、対象の確かめ直しから進める。
  for (const operationId of opened.recovery.resumable)
    runner.start(operationId);
  return {
    runner,
    api,
    homeNetwork,
    pairing,
    voice,
    streams,
    info: {
      host: api.host,
      port: api.port,
      certificateFingerprint: identity.fingerprint,
      certificateCreation: identity.creation,
    },
  };
}

// 制御チャネルの最初の端末の命令（ADR 0021）。running のときだけ、HTTPS を設定したときだけ受け付ける。
// 応答に載るペアリングのコードは CLI の画面に出す値で、Core のログには出さない。
async function firstDeviceControl(
  request: Extract<
    ControlRequest,
    { op: 'pairing_first_start' | 'pairing_first_approve' }
  >,
  state: LifecycleState,
  pairing: PairingService | null,
): Promise<{ readonly response: ControlResponse }> {
  if (state !== 'running')
    return { response: { ok: false, error: 'unavailable' } };
  if (pairing === null)
    return {
      response: { ok: false, error: 'refused', reason: 'https_not_configured' },
    };
  const result =
    request.op === 'pairing_first_start'
      ? await pairing.startFirstDevice()
      : await pairing.approveFirstDevice(request.pairing_id);
  if (!result.ok)
    return { response: { ok: false, error: 'refused', reason: result.reason } };
  return { response: { ...result, request_id: request.request_id } };
}

// 制御チャネルの端末の一覧と失効（ADR 0021 の追記。中枢の画面が使えないときの保守の手段）。running のときだけ。
// HTTPS の有無によらず DB の端末を扱う。失効は中枢の画面の経路と同じ処理（接続範囲の無効化と接続を閉じる）。
// 承認の命令はない。応答にトークン・その hash・証明書の指紋を含めない。
async function deviceControl(
  request: Extract<ControlRequest, { op: 'device_list' | 'device_revoke' }>,
  state: LifecycleState,
  administration: DeviceAdministrationOptions | null,
): Promise<{ readonly response: ControlResponse }> {
  if (state !== 'running' || administration === null)
    return { response: { ok: false, error: 'unavailable' } };
  if (request.op === 'device_list') {
    const listed = await listDeviceRecords(administration.store);
    if (!listed.ok)
      return {
        response: { ok: false, error: 'refused', reason: listed.reason },
      };
    return {
      response: {
        ok: true,
        request_id: request.request_id,
        devices: listed.devices.map(controlDevice),
      },
    };
  }
  const revoked = await revokeDeviceRecord(
    administration,
    request.device_id,
    'ローカルの制御チャネル',
  );
  if (!revoked.ok)
    return {
      response: { ok: false, error: 'refused', reason: revoked.reason },
    };
  return {
    response: {
      ok: true,
      request_id: request.request_id,
      device: controlDevice(revoked.device),
    },
  };
}

const BUDGET_TICK_MS = 60_000;

// 予算の門を作る（ADR 0037）。設定ファイルを読み（読めない・不正なら有料の処理を無効にする）、再起動の照合をして
// から予算月を進める。月替わりを知らせるため、一定の間隔で予算月を確かめる。照合・月の失敗では起動を止めない
// （予算の受付は DB の検査で閉じた側に倒れる）。
async function startBudgetGate(
  dataDir: string,
  options: StartCoreOptions,
  store: DbWorkerClient,
  now: () => Date,
  log: (message: string) => void,
): Promise<{
  readonly gate: BudgetGate;
  readonly timer: NodeJS.Timeout | null;
}> {
  const settings = options.budget ?? {};
  const config = await loadBudgetConfig({
    path: settings.configPath ?? join(dataDir, BUDGET_CONFIG_FILE),
    contract: createApiContract(),
    ...(settings.osTimeZone === undefined
      ? {}
      : { osTimeZone: settings.osTimeZone }),
  });
  if (config.ok) {
    log(
      `予算の設定を読み込みました（予算月のタイムゾーン ${config.timeZone}）。`,
    );
    if (config.warnings.includes('time_zone_normalized'))
      log(
        `予算の設定のタイムゾーンを正規の名前 ${config.timeZone} にして記録します。設定ファイルの名前もそろえてください。`,
      );
  } else
    log(
      `予算の設定を使えないため、有料の処理を受け付けません（${config.reasons.join(', ')}）。`,
    );
  const gate = new BudgetGate({
    store,
    config,
    now: settings.now ?? (() => now().getTime()),
    log,
    creditObservations:
      settings.creditObservations ??
      fileCreditSource({
        path: settings.creditPath ?? join(dataDir, BUDGET_CREDIT_FILE),
        contract: createApiContract(),
      }),
    ...(settings.p95ProfileIds === undefined
      ? {}
      : { p95ProfileIds: settings.p95ProfileIds }),
  });
  // 再起動の照合の口。provider があれば、会話（Live）の使用量も provider へ照会する（読み取りだけ。送り直さない）。
  const liveProvider = options.https?.voice?.provider ?? null;
  const reconciler = combineReconcilers(
    settings.reconciler,
    liveProvider === null
      ? null
      : createLiveUsageReconciler({ gate, store, provider: liveProvider }),
  );
  try {
    await gate.start(reconciler);
  } catch {
    log(
      '予算の再起動の照合に失敗しました。有料の受付は DB の検査で止まります。',
    );
  }
  const interval = settings.tickIntervalMs ?? BUDGET_TICK_MS;
  const timer =
    interval > 0
      ? setInterval(() => {
          void gate.tick().catch(() => undefined);
        }, interval)
      : null;
  timer?.unref();
  return { gate, timer };
}

// 制御チャネルの予算月の状態と、本人による確かめ直し（ADR 0037）。中枢のローカルの CLI（OS の本人の利用者だけが
// 使える制御チャネル）から、本人が見た値を明示して行う承認の操作。running のときだけ。
async function budgetControl(
  request: Extract<
    ControlRequest,
    { op: 'budget_calendar_status' | 'budget_calendar_confirm' }
  >,
  state: LifecycleState,
  gate: BudgetGate | null,
): Promise<{ readonly response: ControlResponse }> {
  if (state !== 'running' || gate === null)
    return { response: { ok: false, error: 'unavailable' } };
  if (request.op === 'budget_calendar_confirm') {
    const confirmed = await gate.confirmCalendar({
      reason: request.reason,
      month: request.month,
      month_start: request.month_start,
      revision: request.revision,
      observed_at: request.observed_at,
    });
    if (!confirmed.ok)
      return {
        response: {
          ok: false,
          error: 'refused',
          reason: confirmed.reasons.join(','),
        },
      };
  }
  const status = await gate.calendarStatus();
  const check = status.check;
  const calendar: ControlBudgetCalendar = {
    configured: status.configured,
    configured_time_zone: status.configured_time_zone,
    month: check?.state?.month ?? null,
    time_zone: check?.state?.timeZone ?? null,
    month_start: check?.state?.monthStart ?? null,
    month_start_time_zone: check?.state?.monthStartTimeZone ?? null,
    recorded_month_start: check?.recorded_month_start ?? null,
    recomputed_month_start: check?.recomputed_month_start ?? null,
    regression_floor: check?.regression_floor ?? null,
    confirmation_revision: check?.confirmation_revision ?? null,
    hold_reasons: check === null ? ['calendar_unavailable'] : check.reasons,
    checked_at: status.checked_at,
  };
  return {
    response: {
      ok: true,
      request_id: request.request_id,
      budget_calendar: calendar,
    },
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
