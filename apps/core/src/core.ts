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

import { createHash, randomUUID } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DbWorkerClient,
  StorageError,
  dataKeyCheckValue,
  restoreSourceHmac,
} from '@buddy/storage';
import type {
  ConnectionRecord,
  DataKeyMaterial,
  DataKeyProvider,
  DbWorkerOptions,
  StoreBindingResult,
  StoreGenerationSource,
} from '@buddy/storage';
import { webResearchNotificationParts } from '@buddy/domain';
import { createGoogleReadConnector } from '@buddy/connectors';
import type { ResearchJobRecord } from '@buddy/storage';
import {
  UNAVAILABLE_TAILSCALE_STATUS,
  createUnsupportedBackupKeyStore,
} from '@buddy/platform';
import type {
  BackupKeyStore,
  OAuthTokenStore,
  TailscaleStatusSource,
  TlsKeyStore,
} from '@buddy/platform';
import { createCandidateRoutes } from './api-candidates.js';
import { createForgetRoutes } from './api-forget.js';
import { createMemoryRoutes } from './api-memory.js';
import { createHouseholdRoutes } from './api-household.js';
import { createCandidateListRefresh } from './candidate-list-refresh.js';
import {
  CONNECTION_REVISION_CHECKED_ROUTES,
  createConnectionRoutes,
} from './api-connections.js';
import {
  AUTO_ACTION_REVISION_CHECKED_ROUTES,
  createAutoActionRoutes,
} from './api-auto-actions.js';
import { createConnectionDiscovery } from './connection-discovery.js';
import type { TargetDiscoveryPort } from './connection-discovery.js';
import { HomeNetworkKey, createHomeNetworkGate } from './api-home-network.js';
import type { HomeNetworkGate } from './api-home-network.js';
import {
  ApiListenError,
  DEFAULT_API_LIMITS,
  createApiServer,
} from './api-server.js';
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
import { deviceTimeZone } from './device-time-zone.js';
import { createHouseholdMailIntake } from './household-mail-intake.js';
import {
  createHouseholdReceiptRoutes,
  receiptBudgetOf,
} from './household-receipt.js';
import type { ReceiptReadingSetup } from './household-receipt.js';
import { receiptSettingStoreOf } from './household-receipt-setting.js';
import {
  HOUSEHOLD_RECEIPT_ENDPOINT_HOST,
  householdReceiptSetup,
  receiptEndpointAllowed,
} from './household-receipt-reader.js';
import type { ReceiptHttpTransport } from './household-receipt-reader.js';
import { createModelHttpsTransport } from './model-https.js';
import {
  TaskMigrationError,
  migrateTaskContents,
} from './task-content-migration.js';
import { ForgetLedgerError, syncForgetLedger } from './forget-ledger.js';
import {
  FORGET_PUBLIC_GATE_OPEN,
  createForgetService,
} from './forget-service.js';
import type { ForgetService } from './forget-service.js';
import { createClockStateFile } from './clock-state.js';
import type { NoticeSink } from './notice-sink.js';
import { StorageModeGate } from './storage-gate.js';
import {
  RestoreInstallError,
  recoverRestoreInstall,
} from './restore-install.js';
import { createTurnRoutes } from './api-turns.js';
import type { TurnRoutesOptions } from './api-turns.js';
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
import { createShadowRecorder } from './shadow-mode.js';
import { createDbShadowRecordStore } from './shadow-store.js';
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
import { LiveConversation, createLiveScreenSink } from './live-conversation.js';
import {
  createLiveBudget,
  DEFAULT_LIVE_PROFILE_ID,
  DEFAULT_LIVE_PROFILE_REVISION,
} from './live-budget.js';
import {
  combineReconcilers,
  createLiveUsageReconciler,
} from './live-reconcile.js';
import { REAL_VOICE_TIMERS, VoiceControl } from './voice-control.js';
import type {
  LiveBudgetPort,
  LiveProvider,
  VoiceControlOptions,
  VoiceTimers,
} from './voice-control.js';
import type { UsageReconciler } from './budget-gate.js';
import { createOperationRunner } from './operation-runner.js';
import type { OperationRunner } from './operation-runner.js';
import { createSyncExecutor } from './sync-executor.js';
import type { SyncExecutor, SyncExecutorOptions } from './sync-executor.js';
import { createGraphSyncExecutor } from './graph-sync-executor.js';
import type { GraphSyncExecutorOptions } from './graph-sync-executor.js';
import { createProviderSyncExecutor } from './provider-sync-executor.js';
import { createResearchExecutor } from './research-executor.js';
import type {
  ResearchExecutor,
  ResearchFetchPort,
  ResearchSearchPort,
  ResearchSummarizePort,
} from './research-executor.js';
import { persistCandidateDrafts } from './candidate-intake.js';
import type { BackgroundJobAcceptor } from './turn-ports.js';
import { createSyncScheduler } from './sync-scheduler.js';
import type { SyncScheduler, SyncSchedulerTarget } from './sync-scheduler.js';
import { createOAuthService } from './oauth.js';
import type { OAuthCallbackOutcome, OAuthService } from './oauth.js';
import { createOAuthCallbackServer } from './oauth-callback-server.js';
import type { OAuthCallbackServer } from './oauth-callback-server.js';
import {
  createGoogleOAuthPort,
  createMicrosoftOAuthPort,
} from './oauth-provider.js';
import type { OAuthProviderName, OAuthProviderPort } from './oauth-provider.js';
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
  | 'https_listen_failed'
  // OAuth のループバックの戻り先の待ち受けに失敗した（B03-04、ADR 0144）。
  | 'oauth_callback_listen_failed';

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
  // 家計簿（ADR 0177）。省略したものは、レシートの写真の読み取りの口なし（設定は unavailable）。
  readonly household?: CoreHouseholdOptions;
}

export interface CoreHouseholdOptions {
  // レシートの写真の読み取りの口と profile をそのまま渡す（試験の模擬）。渡せば receiptProvider より優先する。
  readonly receiptReading?: ReceiptReadingSetup;
  // 外部のモデル（Gemini）で読み取るときの鍵と送信の口（ADR 0178）。CLI が起動の環境変数 BUDDY_GEMINI_API_KEY から
  // 鍵を渡す。鍵がない・予算の設定に確認済みの単価の版がないときは、読み取りは unavailable のまま。
  readonly receiptProvider?: CoreReceiptProviderOptions;
}

export interface CoreReceiptProviderOptions {
  readonly apiKey: string | null;
  // 省略すると node:https の送信（createModelHttpsTransport）。試験は模擬に差し替える。
  readonly transport?: ReceiptHttpTransport;
  // 試験だけ: endpoint の差し替え。transport も差し替えるときだけ任意のホストを許す。transport を省略した（製品の
  // 送信の口の）ときは generativelanguage.googleapis.com 以外は設定の段階で拒否し、読み取りは unavailable になる。
  readonly endpoint?: string;
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
  // 発言を保存したときに、保存した時点の生成の時刻と期限を受け取る（UI-05 の区切り。試験でも使う）。
  readonly onTurnRecorded?: (event: {
    readonly session_id: string;
    readonly turn_id: string;
    readonly created_at: string;
    readonly expires_at: string;
  }) => void;
  // 影モードの比較の入口（ADR 0092）。既定は無し（OFF。D4）。発言の解釈を保存した後に呼ばれる。
  readonly onInterpreted?: TurnRoutesOptions['onInterpreted'];
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
  // 保存期限の掃除（ADR 0058）。省略したものは、時計の状態ファイルはデータディレクトリの clock-state.json、
  // 知らせの受け取りはなし（運搬は UI-05）。
  readonly retention?: CoreRetentionOptions;
  // 同期の走査（B08-06、ADR 0137）。実行器は常に作り、掃除のゲートを渡す。周期の起動は scheduler を
  // 渡したときだけ動かす（CLI の start が有効にする）。
  readonly sync?: CoreSyncOptions;
  // 公開 Web 調査（B12-05、ADR 0141）。検索・取得・要約の口を渡したときだけ、受付器と実行器を作り、
  // 起動時の回復（再開・再通知・孤児の取消）を回す。実アダプターは B12-03・B12-04 で、渡されなければ
  // 調査の受付は従来どおり閉じたまま（受け付けだけを先に生かすことはない。ADR 0135）。
  readonly research?: CoreResearchOptions;
  // 接続の作成・OAuth（B03-04、ADR 0144）。トークンの KeyStore を渡したときだけ、認可の開始・解除の経路と
  // ループバックの戻り先を開き、同期の対象とトークンの出所の既定として OAuth サービスを使う
  // （sync 側で明示的に渡されたものが優先）。プロバイダのクライアント設定が無いプロバイダは認可を開始できない。
  readonly oauth?: CoreOAuthOptions;
}

export interface CoreOAuthOptions {
  readonly tokenStore: OAuthTokenStore;
  readonly providers?: {
    readonly google?: CoreGoogleOAuthProviderOptions;
    readonly microsoft?: CoreOAuthProviderOptions;
  };
  // ループバックの戻り先。省略時は 127.0.0.1:47445。false なら受付を開かない（認可の開始もできない）。
  readonly callback?:
    { readonly host?: string; readonly port?: number } | false;
}

export interface CoreOAuthProviderOptions {
  readonly clientId: string;
  /** Microsoft のテナント（既定は common）。 */
  readonly tenant?: string;
  /** プロバイダの口の差し替え（試験用）。省略時は実プロバイダ向けの口を作る。 */
  readonly port?: OAuthProviderPort;
}

export interface CoreGoogleOAuthProviderOptions extends CoreOAuthProviderOptions {
  /** Google のクライアントシークレット（任意、ADR 0144 追補）。保存せず、プロバイダの口へ渡すだけ。 */
  readonly clientSecret?: string;
}

export interface CoreResearchOptions {
  readonly search: ResearchSearchPort;
  readonly fetch: ResearchFetchPort;
  readonly summarize: ResearchSummarizePort;
}

export interface CoreSyncOptions {
  // 接続ごとのアクセストークンの出所（Google）。接続の作成（B03-04）が用意する。省略した接続は走査しない。
  readonly tokenSourceFor?: SyncExecutorOptions['tokenSourceFor'];
  // 接続ごとのアクセストークンの出所（Microsoft Graph、B09-04）。接続の作成（B03-04）が用意する。
  readonly graphTokenSourceFor?: GraphSyncExecutorOptions['tokenSourceFor'];
  // 接続ごとの走査対象（account_id・資源種別）。接続の作成（B03-04）が持つ値。省略した接続は走査しない。
  readonly targetsFor?: (
    connection: ConnectionRecord,
  ) => readonly SyncSchedulerTarget[] | Promise<readonly SyncSchedulerTarget[]>;
  // 周期の起動（60 秒ポーリング＋ジッター、起動時の回復と全量照合）。省略すれば動かさない。
  readonly scheduler?: {
    readonly pollIntervalMs?: number;
    readonly jitterMs?: number;
  };
}

export interface CoreBackupOptions {
  readonly keyStore?: BackupKeyStore;
  // 定期の実行（1 日 1 回、または忘却の置き換えを待つとき）。省略すれば動かさない（CLI の start が有効にする）。
  readonly scheduler?: {
    readonly checkIntervalMs?: number;
    readonly retryAfterFailureMs?: number;
  };
  // 試験用: 封筒を書く直前に呼ぶ。
  readonly beforeWrite?: () => void | Promise<void>;
  // 試験用: 停止が実行中のバックアップの終わりを待つ上限（ミリ秒。既定は 5 分）。
  readonly drainMs?: number;
  // 試験用: 封筒の削除（一時的な失敗の再現）。
  readonly removeFile?: (path: string) => Promise<void>;
  // 試験用: 掃除の開始時に呼ぶ（掃除が始まる前の失敗の再現）。
  readonly beforeSweep?: () => void | Promise<void>;
  // 試験用: 状態ファイルを書く直前に呼ぶ（状態の保存の途中で止まる再現）。
  readonly beforeStateWrite?: () => void | Promise<void>;
}

export interface CoreRetentionOptions {
  // 期限切れの知らせの受け取り口（U40。運搬は UI-05）。
  readonly notices?: NoticeSink;
  // 復帰の検知に使う単調時計（試験で差し替える）。
  readonly monotonic?: () => number;
  // 掃除の間隔（試験用。既定は 5 分）。
  readonly sweepIntervalMs?: number;
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
  // 同期の走査の実行器（B08-05、ADR 0136）。掃除のゲートを渡してある。走査の開始は周期の起動が持つ。
  readonly syncExecutor: SyncExecutor;
  // 同期の周期起動（B08-06、ADR 0137）。scheduler を有効にしなければ null。
  readonly syncScheduler: SyncScheduler | null;
  // 公開 Web 調査の実行器（B12-05、ADR 0141）。research の口を渡さなければ null（受付も閉じたまま）。
  readonly researchExecutor: ResearchExecutor | null;
  // 接続の作成・OAuth（B03-04、ADR 0144）。oauth を渡さなければ null。callbackPort は戻り先の待ち受けポート
  // （HTTPS の受付が無い・戻り先を開かない構成では null）。
  readonly oauth: { readonly callbackPort: number | null } | null;
  // 保存境界の保持者（記録しない会話のゲート。ADR 0045・0059）。今の保存モード・区切りの世代・由来の照合を持つ。
  readonly storage: StorageModeGate;
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
  let storageGate: StorageModeGate | null = null;
  let forgetService: ForgetService;
  let syncRun: {
    executor: SyncExecutor;
    scheduler: SyncScheduler | null;
  } | null = null;
  let oauthRun: {
    service: OAuthService;
    callback: OAuthCallbackServer | null;
  } | null = null;
  let researchRun: ResearchExecutor | null = null;
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
    // 同期の周期起動を止める（実行中の走査は止めない。走査は再開可能な形で保存され、次の起動で回復する）。
    syncRun?.scheduler?.stop();
    // 実行中のバックアップ・掃除の終わりを待つ（新しい実行は断る）。DB を閉じて排他ロックを解放する前に待ち、旧い Core が
    // 再起動した Core と封筒・状態ファイルを取り合わないようにする（上限を過ぎたら待たずに進む）。
    await step(async () => {
      await backup?.close();
    });
    // 実行中の調査の終わりを待つ（調査は再開可能な形で保存されるので、待ち切れなくても次の起動で回復する）。
    await step(async () => {
      await researchRun?.drain();
    });
    retention?.close();
    // 入る・出るを受けなくし、合わせ直せていない世代の書き込みが残っていれば最後に試す。
    await step(async () => {
      await storageGate?.close();
    });
    // WSS の購読を理由つき（1001）で閉じ、配信の元を止めてから HTTPS を閉じる。
    await step(async () => {
      await streams?.closeAll();
      feed?.close();
    });
    await step(async () => api?.close(options.shutdownGraceMs ?? 2000));
    // OAuth のループバックの戻り先を閉じる（B03-04）。
    await step(async () => {
      await oauthRun?.callback?.close();
    });
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
    // 順序（ADR 0058）: 台帳のファイルの同期（openStore）→ 掃除 → ゲートが開く。時計の最終確認時刻と epoch は
    // データディレクトリのファイルに置く（初めての起動＝DB を新しく作ったときだけファイルを作る）。
    // 時計の状態ファイルは掃除の job と保存境界の保持者が同じ口（読んで書き換える処理を 1 つずつ行う）で使う（ADR 0059）。
    const clockFile = createClockStateFile(dataDir);
    retention = new RetentionSweeper({
      port: createRetentionSweepPort(opened.store),
      epoch: coreInstanceId,
      now: () => now().getTime(),
      log,
      clock: clockFile,
      freshClockState: opened.binding.storeGenerationSource === 'created',
      monotonic: options.retention?.monotonic ?? (() => performance.now()),
      ...(options.retention?.notices === undefined
        ? {}
        : { notices: options.retention.notices }),
      ...(options.retention?.sweepIntervalMs === undefined
        ? {}
        : { sweepIntervalMs: options.retention.sweepIntervalMs }),
    });
    retention.start();
    // 保存境界の保持者（ADR 0059）。前の起動で記録しない区切りが開いていたら、通常の区切りへ戻して知らせる。HTTPS の受付
    // （Live の開始・入出力の状態）より前に作る。命令のうち Live を閉じるだけを音声の制御へつなぐ（ほかの保存先は次の段階）。
    storageGate = await StorageModeGate.open({
      clock: clockFile,
      ...(options.retention?.notices === undefined
        ? {}
        : { notices: options.retention.notices }),
      effects: {
        run: (command) => {
          if (command.type === 'close_voice_session')
            voice?.closeForPrivateConversation();
        },
      },
      now: () => now().getTime(),
      log,
    });
    // 接続の作成・OAuth（B03-04、ADR 0144）。トークンの KeyStore が渡されたときだけ作る。ループバックの
    // 戻り先はこの時点で組み立て、待ち受けは HTTPS の受付の後に始める。同期の対象とトークンの出所は、
    // sync 側で明示が無ければこのサービスが既定になる。
    if (options.oauth !== undefined) {
      const oauthOptions = options.oauth;
      const providers: Partial<
        Record<OAuthProviderName, { port: OAuthProviderPort }>
      > = {};
      const googleConfig = oauthOptions.providers?.google;
      if (googleConfig !== undefined) {
        providers.google = {
          port:
            googleConfig.port ??
            createGoogleOAuthPort({
              clientId: googleConfig.clientId,
              ...(googleConfig.clientSecret === undefined
                ? {}
                : { clientSecret: googleConfig.clientSecret }),
            }),
        };
      }
      const microsoftConfig = oauthOptions.providers?.microsoft;
      if (microsoftConfig !== undefined) {
        providers.microsoft = {
          port:
            microsoftConfig.port ??
            createMicrosoftOAuthPort({
              clientId: microsoftConfig.clientId,
              ...(microsoftConfig.tenant === undefined
                ? {}
                : { tenant: microsoftConfig.tenant }),
            }),
        };
      }
      let callback: OAuthCallbackServer | null = null;
      let service: OAuthService;
      if (oauthOptions.callback === false) {
        // 戻り先を開かない構成。トークンの出所・対象・解除は働くが、認可の開始は閉じる
        // （サービス側が redirectUri の空を見て 503 を返す）。
        service = createOAuthService({
          store: opened.store,
          keyStore: options.keyStore,
          tokenStore: oauthOptions.tokenStore,
          providers,
          redirectUri: '',
          now,
          log,
        });
      } else {
        // 戻り先の受付はサービスの参照を後から受ける（受付が redirectUri を先に決めるため）。
        let serviceRef: OAuthService | null = null;
        callback = createOAuthCallbackServer({
          ...(oauthOptions.callback?.host === undefined
            ? {}
            : { host: oauthOptions.callback.host }),
          ...(oauthOptions.callback?.port === undefined
            ? {}
            : { port: oauthOptions.callback.port }),
          handleCallback: (query): Promise<OAuthCallbackOutcome> =>
            serviceRef === null
              ? Promise.resolve({ kind: 'failed', reason: 'exchange_failed' })
              : serviceRef.handleCallback(query),
          log,
        });
        service = createOAuthService({
          store: opened.store,
          keyStore: options.keyStore,
          tokenStore: oauthOptions.tokenStore,
          providers,
          redirectUri: callback.redirectUri,
          now,
          log,
        });
        serviceRef = service;
      }
      oauthRun = { service, callback };
    }
    // 同期の走査の実行器（B08-05・B09-04）と周期起動（B08-06）。走査は外部の読み取りなので、掃除のゲートを渡す
    // （ADR 0053・0136）。実行器は provider ごとに作り、scheduler と CoreHandle には provider で振り分ける
    // 実行器を渡す（ADR 0138）。実行器は常に作るが、周期の起動は scheduler を有効にしたときだけ動かす。
    // 対象（account_id・資源種別）とトークンの出所は接続の作成（B03-04）が用意するもので、渡されなければ
    // 実行器は呼ばれない。起動時の回復は、排他ロックで旧 Core の終了が担保された後に scheduler が行う。
    const googleTokenSourceFor =
      options.sync?.tokenSourceFor ??
      (oauthRun === null
        ? undefined
        : (connection: ConnectionRecord) =>
            oauthRun?.service.googleTokenSourceFor(connection) ?? null);
    const graphTokenSourceFor =
      options.sync?.graphTokenSourceFor ??
      (oauthRun === null
        ? undefined
        : (connection: ConnectionRecord) =>
            oauthRun?.service.graphTokenSourceFor(connection) ?? null);
    const googleSyncExecutor = createSyncExecutor({
      store: opened.store,
      ...(googleTokenSourceFor === undefined
        ? {}
        : { tokenSourceFor: googleTokenSourceFor }),
      retention: {
        ready: async () => {
          await retention?.idle();
        },
        gate: () => (retention as RetentionSweeper).gate(),
        lease: () => (retention as RetentionSweeper).lease(),
      },
    });
    const graphSyncExecutor = createGraphSyncExecutor({
      store: opened.store,
      ...(graphTokenSourceFor === undefined
        ? {}
        : { tokenSourceFor: graphTokenSourceFor }),
      retention: {
        ready: async () => {
          await retention?.idle();
        },
        gate: () => (retention as RetentionSweeper).gate(),
        lease: () => (retention as RetentionSweeper).lease(),
      },
    });
    const syncExecutor = createProviderSyncExecutor({
      store: opened.store,
      google: googleSyncExecutor,
      microsoft: graphSyncExecutor,
    });
    const syncTargetsFor =
      options.sync?.targetsFor ??
      (oauthRun === null
        ? undefined
        : (connection: ConnectionRecord) =>
            oauthRun?.service.targetsFor(connection) ??
            Promise.resolve([] as readonly SyncSchedulerTarget[]));
    // 家計簿の利用通知メールの取り込み（ADR 0160）。Gmail のトークンの口があるときだけ、メールの走査の公開の後に呼ぶ。
    const householdMailIntake =
      googleTokenSourceFor === undefined
        ? null
        : createHouseholdMailIntake({
            store: opened.store,
            gmailFor: (connection) => {
              const tokenSource = googleTokenSourceFor(connection);
              return tokenSource === null
                ? null
                : createGoogleReadConnector({ tokenSource }).gmail;
            },
            dataKey: async () => {
              const keyResult = await options.keyStore.loadDataKey();
              return keyResult.ok ? keyResult.dataKey : null;
            },
            timeZone: () => deviceTimeZone(),
            now,
            log,
            retention: {
              ready: async () => {
                await retention?.idle();
              },
              gate: () => (retention as RetentionSweeper).gate(),
              lease: () => (retention as RetentionSweeper).lease(),
            },
          });
    let syncScheduler: SyncScheduler | null = null;
    if (options.sync?.scheduler !== undefined) {
      syncScheduler = createSyncScheduler({
        store: opened.store,
        executor: syncExecutor,
        log,
        ...(syncTargetsFor === undefined ? {} : { targetsFor: syncTargetsFor }),
        ...(householdMailIntake === null
          ? {}
          : {
              onPublished: async (connection, target) => {
                if (target.resource !== 'mail') return;
                const result = await householdMailIntake.run({
                  connection,
                  account_id: target.account_id,
                  scope_id: target.scope_id,
                });
                if (
                  result.recorded > 0 ||
                  result.bills > 0 ||
                  result.outcome === 'stopped'
                )
                  log(
                    `家計簿の利用通知を取り込みました（記録 ${String(result.recorded)} 件・請求予定 ${String(result.bills)} 件・確かめたメール ${String(result.checked)} 通${result.reason === null ? '' : `・${result.reason}`}）。`,
                  );
              },
            }),
        ...options.sync.scheduler,
      });
      syncScheduler.start();
    }
    syncRun = { executor: syncExecutor, scheduler: syncScheduler };
    // 公開 Web 調査の受付と実行器（B12-05、ADR 0141）。口が渡されたときだけ作る。完了の知らせは
    // 候補（research_done）の作成で、識別子は kind・workflow_id・完了の版（domain が正本）。
    // データ鍵は保持せず、知らせるたびに鍵の保管庫から読み直す（候補の経路と同じ）。
    // 起動時の回復は、排他ロックで旧 Core の終了が担保された後に回す（HTTPS の受付より前）。
    if (options.research !== undefined) {
      const researchStore = opened.store;
      researchRun = createResearchExecutor({
        store: researchStore,
        search: options.research.search,
        fetch: options.research.fetch,
        summarize: options.research.summarize,
        retention: {
          ready: async () => {
            await retention?.idle();
          },
          gate: () => (retention as RetentionSweeper).gate(),
          lease: () => (retention as RetentionSweeper).lease(),
        },
        log,
        notify: async (record: ResearchJobRecord) => {
          const parts = webResearchNotificationParts(record.status, {
            url_storage: 'disallowed',
          });
          if (parts === null) return;
          const keyResult = await options.keyStore.loadDataKey();
          if (!keyResult.ok) throw new Error('data_key_unavailable');
          const summary = record.status.result?.summary ?? '';
          const results = await persistCandidateDrafts(
            {
              client: researchStore,
              dataKey: keyResult.dataKey,
              sha256Hex: (material: string) =>
                createHash('sha256').update(material, 'utf8').digest('hex'),
              newId: () => randomUUID(),
              now: () => now().toISOString(),
            },
            [
              {
                candidate_kind: 'research_done',
                key_parts: parts,
                title: '調査の完了',
                deadline: { kind: 'none' },
                excerpt: [...summary].slice(0, 200).join(''),
                request_entity_id: null,
                request_revision: null,
                source_revision: null,
                initial_import: false,
                unread_partial: (record.status.result?.unread_count ?? 0) > 0,
                related_analysis: null,
                received_at: record.status.finished_at ?? now().toISOString(),
                origins:
                  record.turn_id === null
                    ? []
                    : [{ source_kind: 'turn', source_id: record.turn_id }],
              },
            ],
          );
          const outcome = results[0]?.outcome;
          if (outcome === 'rejected' || outcome === 'unknown')
            throw new Error(`candidate_${outcome}`);
        },
      });
      const recovered = await researchRun.recover();
      if (recovered.orphans_canceled > 0 || recovered.expired > 0)
        log(
          `調査の回復: 孤児の取消 ${recovered.orphans_canceled} 件・保持を過ぎた削除 ${recovered.expired} 件。`,
        );
    }
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
        ...(options.backup?.drainMs === undefined
          ? {}
          : { drainMs: options.backup.drainMs }),
        ...(options.backup?.beforeSweep === undefined
          ? {}
          : { beforeSweep: options.backup.beforeSweep }),
        ...(options.backup?.beforeStateWrite === undefined
          ? {}
          : { beforeStateWrite: options.backup.beforeStateWrite }),
      });
      backupContext = {
        dataDir,
        contract,
        service: backup,
        store: opened.store,
        backupKeys,
      };
      // 記憶の忘却の経路（B06-07b-2、ADR 0180）。忘却の公開ゲート（U112）は既定で閉じ、開けるのは忘却の画面（UI-10）の
      // PR だけ。台帳用の HMAC は、バックアップの設定で記録した台帳の鍵から要求ごとに求める（鍵がなければ計画を作らない。U384）。
      const forgetStore = opened.store;
      forgetService = createForgetService({
        store: forgetStore,
        ledgerPath: join(dataDir, FORGET_LEDGER_FILE),
        gate: () => FORGET_PUBLIC_GATE_OPEN,
        sourceHmac: async () => {
          const facts = await forgetStore.memory({ kind: 'backup.facts' });
          if (!facts.ok || facts.value.recorded_ledger_key_id === null)
            return null;
          const key = await backupKeys.read(
            'ledger_hmac_key',
            facts.value.recorded_ledger_key_id,
          );
          return key.ok ? restoreSourceHmac(key.key.key) : null;
        },
        // 消える指示の本文を開くデータ鍵（U433、ADR 0185）。保持せず計画のたびに読む。
        dataKey: async () => {
          const result = await options.keyStore.loadDataKey();
          return result.ok ? result.dataKey : null;
        },
        // 忘却の COMMIT の後の WAL の切り詰め（U440、ADR 0186）。掃除の後始末と同じ命令で、busy・失敗のときは掃除の
        // job が次の掃除の後に試す。
        truncateLog: () =>
          retention?.truncateLogAfterForget() ?? Promise.resolve(false),
        ...(options.retention?.notices === undefined
          ? {}
          : { notices: options.retention.notices }),
        now: () => now().getTime(),
        log,
      });
      // 排他ロックを取った後（動いている写しはない）に、前の異常終了で残った作業用の写しを消す。
      await backup.recover();
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
        storageGate,
        researchRun?.acceptor,
        oauthRun === null ? undefined : oauthRun.service,
        forgetService,
        // 選べる取得対象の読み取り（ADR 0145）。走査の実行器と同じ、解決済みのトークンの出所を使う
        // （sync の明示が無ければ OAuth サービスが既定、B03-04）。出所が両方とも無ければ口を作らない。
        googleTokenSourceFor === undefined && graphTokenSourceFor === undefined
          ? undefined
          : createConnectionDiscovery({
              ...(googleTokenSourceFor === undefined
                ? {}
                : { googleTokenSourceFor }),
              ...(graphTokenSourceFor === undefined
                ? {}
                : { graphTokenSourceFor }),
            }),
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
      // OAuth のループバックの戻り先（B03-04）。API の受付があって初めて意味を持つので、ここで開く。
      if (oauthRun?.callback != null) {
        try {
          await oauthRun.callback.listen();
          log(
            `OAuth の戻り先を待ち受けました（${oauthRun.callback.host}:${oauthRun.callback.port}）。`,
          );
        } catch {
          throw new CoreStartError('oauth_callback_listen_failed', [
            'oauth_callback_listen_failed',
          ]);
        }
      }
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
      if (request.op === 'clock_status' || request.op === 'clock_recheck')
        return clockControl(request, lifecycle.state, retention);
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
    syncRun?.scheduler?.stop();
    await researchRun?.drain().catch(() => undefined);
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
    syncExecutor: (
      syncRun as { executor: SyncExecutor; scheduler: SyncScheduler | null }
    ).executor,
    syncScheduler: (
      syncRun as { executor: SyncExecutor; scheduler: SyncScheduler | null }
    ).scheduler,
    researchExecutor: researchRun,
    oauth:
      oauthRun === null
        ? null
        : {
            callbackPort:
              oauthRun.callback === null || httpsInfo === null
                ? null
                : oauthRun.callback.port,
          },
    storage: storageGate as StorageModeGate,
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
  storage: StorageModeGate,
  // 公開 Web 調査の受付器（B12-05、ADR 0141）。口が無ければ undefined で、調査は未対応のまま。
  researchAcceptor?: BackgroundJobAcceptor,
  // 接続の作成・OAuth のサービス（B03-04、ADR 0144）。無ければ undefined で、認可の開始・解除の経路は無い。
  oauthService?: OAuthService,
  // 記憶の忘却の経路（B06-07b-2、ADR 0180）。無ければ計画・実行の経路は 503（処理のない経路）。
  forgetService?: ForgetService | null,
  // 選べる取得対象の読み取り口（ADR 0145）。無ければ undefined で、その経路は 503 で閉じる。
  discovery?: TargetDiscoveryPort,
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
    // 記録しない会話の間は Live を開かない・入力を受けない（保存境界の保持者の値。ADR 0059）。
    privateConversation: () => storage.privateConversation(),
    storageBoundary: () => storage.origin().segment_generation,
    // Live の開始は外部への送信。起動・復帰の掃除が済むまで開かない（ADR 0058 の U108）。
    ...(retention === null
      ? {}
      : {
          retention: {
            ready: async () => {
              await retention?.idle();
            },
            lease: () => (retention as RetentionSweeper).lease(),
          },
        }),
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
  // 連携の接続の一覧・取得対象の読み取りと変更（B08-02、ADR 0089）。許可版の照合は DB の現在値で行う。
  // 選べる取得対象の読み取り（ADR 0145）は口があるときだけ開き、読んだ値は保存しない。
  const connectionRoutes = createConnectionRoutes({
    store,
    ...(discovery === undefined ? {} : { discover: discovery }),
  });
  // 気づき（候補）の一覧・根拠の再取得・状態の変更（B11-04 P2、ADR 0130）。データ鍵は保持せず要求ごとに読む。
  // 本人のタイムゾーン（IANA）の出所は端末（OS）のタイムゾーン（本人の決定 2026-11-21、ADR 0131）で、要求ごとに読む。
  // 取得不能・不正なときだけ zone が null になり、一覧・状態の変更は 503 で閉じる（黙って代替しない）。
  // 根拠を取り直す connector は B08・B09 なので渡さない（根拠の経路は引き続き 503）。
  const candidateRoutes = createCandidateRoutes({
    store,
    dataKey: async () => {
      const result = await keyStore.loadDataKey();
      return result.ok ? result.dataKey : null;
    },
    zone: () => deviceTimeZone(),
    now: () => now().toISOString(),
  });
  // 一覧を開くたびの状態の見直し（B11-05、ADR 0132）。一覧の前に保守の時間による遷移と保持の掃除を回す（根拠の再確認は
  // connector が無いので渡さない）。時計は掃除のゲート（retention.gate()）の理由のうち時計のもの（clock_*: 巻き戻り・
  // 時計の状態ファイルの欠け・不正・読めない時刻）で確かめ、該当すれば保守を保留して一覧だけ返す。掃除の進み具合
  // （sweep_*）は候補の保守の可否に関わらないので見ない（clockStatus() のように掃除の完了を待たず、一覧を遅らせない）。
  // 掃除の仕組みが無い組み立て（試験）は、時計の状態ファイルが無いときの掃除と同じく今の時刻をそのまま使う。
  // 保守の失敗・スキップは一覧の応答を止めない。zone が null なら保守を回さず、一覧が 503 で閉じる。
  const candidateRefresh = createCandidateListRefresh({
    client: store,
    zone: () => deviceTimeZone(),
    clock: async () => {
      const at = now().toISOString();
      if (retention === null) return { ok: true, now: at } as const;
      const held = retention
        .gate()
        .reasons.filter((reason) => reason.startsWith('clock_'))
        .sort();
      return held.length > 0
        ? ({ ok: false, reason: held.join('+') } as const)
        : ({ ok: true, now: at } as const);
    },
    log,
  });
  // 自動実行の一覧・安全停止の解除・取り消し（B13-05、ADR 0152・0153）。版の照合は DB の現在値で行う。
  // 取り消しは提供元の読み書きの口があるときだけ開く（無ければ一覧は取り消せるように見せず、経路は 503）。
  // 補償の操作は保存の後に実行担当へ渡す（実行担当はこの後で作るので、呼ばれた時点の値を使う）。
  const undoProvider = https.turns?.provider ?? null;
  const autoActionRoutes = createAutoActionRoutes({
    store,
    now: () => now().getTime(),
    undo:
      undoProvider === null || (https.turns?.writer ?? null) === null
        ? null
        : {
            provider: undoProvider,
            contract: createApiContract(),
            dataKey: async () => {
              const result = await keyStore.loadDataKey();
              return result.ok ? result.dataKey : null;
            },
            afterApproval: (operationId) => runner.afterApproval(operationId),
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
          },
  });
  // 家計簿の月ごとの合計・1 か月・分類の変更・削除（ADR 0161）。データ鍵は保持せず要求ごとに読む。今月は本人の
  // タイムゾーン（気づきの一覧と同じ出所）で決め、決まっていなければ月ごとの合計を 503 で閉じる。
  // レシートの写真の読み取り（ADR 0177）。読み取りの口（provider と profile）は起動の設定で渡し、なければ使えない。
  // 予算の門（本人の依頼の枠）と保存期限の掃除の門を通してから外部へ送る。設定は既定で切。掃除の門は待たない（掃除の
  // 途中なら送らずに 503 not_sent。端末が待つのをやめた後に送らないため。ADR 0177 の追補）。https.limits で
  // requestTimeout・確かめる間隔を上書きして、端末の時間切れ（150 秒）との関係が破れるなら、読み取りを使わない
  // （unavailable。ADR 0177 の追補 2）。入・切は家計簿の設定の行に保存し、起動し直しても変わらない（ADR 0179）。
  // 外部のモデルの鍵が起動の設定にあれば、Gemini の読み取りの口と profile を作る（ADR 0178）。単価の版は予算の設定から
  // 今の時刻で見積もれるものだけ（なければ unavailable）。
  const receiptProvider = https.household?.receiptProvider;
  // 送信の口を差し替えない（製品の）ときは、鍵を送る宛先を generativelanguage.googleapis.com に限る。それ以外の
  // endpoint が渡されたら、鍵を渡さずに読み取りを使えなくする（receipt_endpoint_invalid）。
  const receiptEndpointRefused =
    receiptProvider !== undefined &&
    receiptProvider.transport === undefined &&
    receiptProvider.endpoint !== undefined &&
    !receiptEndpointAllowed(receiptProvider.endpoint);
  if (receiptEndpointRefused)
    log(
      '家計簿のレシートの写真の読み取りを使えなくしました（receipt_endpoint_invalid）。',
    );
  const receiptSetup =
    https.household?.receiptReading ??
    (receiptProvider === undefined || receiptEndpointRefused
      ? null
      : householdReceiptSetup({
          apiKey: receiptProvider.apiKey,
          transport:
            receiptProvider.transport ??
            createModelHttpsTransport({
              allowedHosts: [HOUSEHOLD_RECEIPT_ENDPOINT_HOST],
            }),

          priceVersionFor: (request) => budget.priceVersionFor(request),
          ...(receiptProvider.endpoint === undefined
            ? {}
            : { endpoint: receiptProvider.endpoint }),
          log,
        }));
  const apiLimits: ApiLimits = { ...DEFAULT_API_LIMITS, ...https.limits };
  const householdReceipt = createHouseholdReceiptRoutes({
    setup: receiptSetup,
    budget:
      receiptSetup === null ? null : receiptBudgetOf(budget, receiptSetup),
    zone: () => deviceTimeZone(),
    now: () => now().getTime(),
    requestLimits: {
      requestTimeoutMs: apiLimits.requestTimeoutMs,
      connectionsCheckingIntervalMs: apiLimits.connectionsCheckingIntervalMs,
    },
    log,
    settings: receiptSettingStoreOf(store, () => now().getTime()),
    ...(retention === null
      ? {}
      : {
          cloudGate: {
            open: () => (retention as RetentionSweeper).gate().cloud_send,
            lease: () => (retention as RetentionSweeper).lease(),
          },
        }),
  });
  // 読み取りの口がなく保存した値が入なら、切に倒して保存する（口が戻っても入で始まらないように。ADR 0179）。
  await householdReceipt.closeWhenUnavailable();
  const householdRoutes = createHouseholdRoutes({
    store,
    dataKey: async () => {
      const result = await keyStore.loadDataKey();
      return result.ok ? result.dataKey : null;
    },
    zone: () => deviceTimeZone(),
    now: () => now().getTime(),
    receipt: householdReceipt,
  });
  const candidateHandlers = {
    ...candidateRoutes.handlers,
    listCandidates: candidateRefresh.wrap(
      candidateRoutes.handlers.listCandidates,
    ),
  };
  // 承認・取消・予算・接続の取得対象の版の照合は DB の現在値で行う。他の経路は注入した環境（なければ安全側の既定）。
  const environment: RequestEnvironment = {
    ...base,
    revisionMatches: (input) =>
      routes !== null && REVISION_CHECKED_ROUTES.has(input.operationId)
        ? routes.revisionMatches(input)
        : BUDGET_REVISION_CHECKED_ROUTES.has(input.operationId)
          ? budgetRoutes.revisionMatches(input)
          : CONNECTION_REVISION_CHECKED_ROUTES.has(input.operationId)
            ? connectionRoutes.revisionMatches(input)
            : AUTO_ACTION_REVISION_CHECKED_ROUTES.has(input.operationId)
              ? autoActionRoutes.revisionMatches(input)
              : input.operationId === 'resumeIo'
                ? voice.revisionMatches(input.device, input.body)
                : base.revisionMatches(input),
  };
  const turnOptions = https.turns ?? {};
  // 影モード（B10-03 P3、ADR 0092・0110、B06-06e）。比較の記録の入口（onInterpreted）を SQLite の保存先につなぐ。
  // 設定（campaign・比較モデルの配備・endpoint・認証）と、予算・余力・出力の検証の口は B15 と本人の承認まで
  // 読まない・作らない。設定が無い間は observe が何もしない（既定 OFF・D4）ので、比較の呼出しも保存も 0 件。
  const shadow = createShadowRecorder({
    settings: () => null,
    store: createDbShadowRecordStore(watched),
    // 余力（ai の planModelCalls の判定）は B15 の配線。設定が無い間は届かない。届いたときに走らせない側に倒す。
    slotAvailable: () => false,
    // 音声の接続（Live）が開いている間は走らせない（設計 10 §5）。Core がメモリーに置いている接続の数で見る。
    liveSessionOpen: () => voice.liveCount > 0,
    // 記録しない会話（StorageModeGate の今の値）。受付の前後・保存の直前にも読み直される。
    privateConversation: () => storage.privateConversation(),
    // 比較の費用（B07 の門）・実費の合計・出力の検証は B15。設定が無い間は呼ばれない。呼ばれても始めない側にする。
    guard: {
      admit: () =>
        Promise.resolve({ ok: false, reasons: ['shadow_not_wired'] }),
    },
    spent: () => Promise.resolve(''),
    contract: createApiContract(),
    output_schema: null,
    schema: { valid: () => false },
    now: () => now().getTime(),
  });
  // 流れの区切り（UI-05）は、上の turns より後に作る。保存した発言の期限は、この口を通して区切りへ渡す。
  let streamRecordTurn:
    | ((event: {
        readonly session_id: string;
        readonly turn_id: string;
        readonly created_at: string;
        readonly expires_at: string;
      }) => void)
    | null = null;
  const turns = createTurnRoutes({
    store: watched,
    keyStore,
    ...(researchAcceptor === undefined
      ? {}
      : { backgroundJobs: researchAcceptor }),
    interpreter: turnOptions.interpreter ?? createMockInterpreter(),
    provider: turnOptions.provider ?? null,
    candidates: turnOptions.candidates ?? {
      mailCandidates: () => Promise.resolve([]),
    },
    policy: turnOptions.policy ?? TEST_TURN_POLICY,
    previews,
    storage,
    utcOffset: turnOptions.utcOffset ?? '+09:00',
    now: () => now().getTime(),
    onOperationCreated: () => feed.notify(),
    // 比較の入口。同期で戻り、失敗しても発言の結果を変えない（ADR 0092）。呼び出し側の口（試験・診断）にも渡す。
    onInterpreted: (event) => {
      shadow.observe({
        storage_mode: event.storage_mode,
        live_session_open: voice.liveCount > 0,
        input_id: event.input_id,
        request_revision: event.request_revision,
        turn_expires_at: event.turn_expires_at,
        context: event.context,
        primary: event.primary,
      });
      turnOptions.onInterpreted?.(event);
    },
    // 会話の操作（照合表に当たった文字の発言）は、その端末の開いている Live へも行う（画面のボタンと同じ処理。B05-05）。
    onSessionControl: ({ device_id, action }) =>
      voice.applySessionControlForDevice(device_id, action),
    // 保存した発言の生成の時刻と期限を、流れの区切りへ渡す（UI-05。再送では呼ばれない）。
    onTurnRecorded: (event) => {
      streamRecordTurn?.(event);
      turnOptions.onTurnRecorded?.(event);
    },
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
    storage,
    now: () => now().getTime(),
    // 自動の区切りの日付は、発言の解釈と同じ本人の時間帯で判定する（UI-05、ADR 0068）。
    utcOffset: turnOptions.utcOffset ?? '+09:00',
  });
  // 保存した発言の期限を、流れの区切りへ渡す口をつなぐ（UI-05）。
  streamRecordTurn = stream.recordTurn;
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
  // Live（声）の会話の処理（B05-05、ADR 0052）。委譲・文字起こしは共通の workflow（発言の処理）へ進め、声で返せない結果は
  // 画面（キャンバス）へ回す。provider が渡されない起動（製品の既定）では何も受けない。
  voice.setConversation(
    new LiveConversation({
      host: voice.conversationHost(),
      turns: { interpret: turns.interpret, commitLive: turns.commitLive },
      screen: createLiveScreenSink({
        placeLate: (turn, text) => stream.placeLate(turn, text),
        placeNotice: (notice) => stream.placeNotice(notice),
        log,
      }),
      monoNow: voiceOptions.monoNow ?? (() => performance.now()),
      timers: voiceOptions.timers ?? REAL_VOICE_TIMERS,
      log,
    }),
  );
  const voiceRoutes = createVoiceRoutes(voice);
  // 忘却の計画・実行（公開ゲートは ForgetService が見る）と台帳の配信（B06-07b-2、ADR 0180）。
  const forgetRoutes =
    forgetService === undefined || forgetService === null
      ? null
      : createForgetRoutes({ service: forgetService, store });
  // 記憶の一覧（UI-10 の忘却の画面、ADR 0183）。データ鍵は保持せず要求ごとに読む。忘却の公開ゲートの値は表示のために読むだけ
  // （計画・実行のゲートは ForgetService が見る。どちらも同じ定数）。一覧は忘却の経路の有無にかかわらず返す。
  const memoryRoutes = createMemoryRoutes({
    store,
    dataKey: async () => {
      const result = await keyStore.loadDataKey();
      return result.ok ? result.dataKey : null;
    },
    gate: () => FORGET_PUBLIC_GATE_OPEN,
    now: () => now().getTime(),
  });
  // 経路の処理の表は重ならない（同じ operationId を二つの処理が持たない）。重なれば起動しない。
  const handlerKeys = [
    pairing.handlers,
    routes.handlers,
    homeNetwork.handlers,
    turns.handlers,
    stream.handlers,
    budgetRoutes.handlers,
    connectionRoutes.handlers,
    candidateHandlers,
    autoActionRoutes.handlers,
    householdRoutes.handlers,
    voiceRoutes.handlers,
    memoryRoutes.handlers,
    ...(oauthService === undefined ? [] : [oauthService.handlers]),
    ...(forgetRoutes === null ? [] : [forgetRoutes.handlers]),
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
        ...connectionRoutes.handlers,
        ...candidateHandlers,
        ...autoActionRoutes.handlers,
        ...householdRoutes.handlers,
        ...voiceRoutes.handlers,
        ...memoryRoutes.handlers,
        ...(oauthService === undefined ? {} : oauthService.handlers),
        ...(forgetRoutes === null ? {} : forgetRoutes.handlers),
      },
      eventStream: streams,
      ioState: (device, lock) => voice.ioState(device, lock),
      // レシートの写真の読み取り（ADR 0177）だけ、端末の切断を経路の処理へ伝え、読んだ本文のバイト列を 0 で埋める。
      abortOnCloseRoutes: ['readHouseholdReceipt'],
      wipeBodyRoutes: ['readHouseholdReceipt'],
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

// 制御チャネルの時計の最終確認時刻の状態と、本人による採り直し（ADR 0058 の U136）。中枢のローカルの CLI（OS の本人の
// 利用者だけが使える制御チャネル）から、本人が見た値を明示して行う承認の操作。running のときだけ。
async function clockControl(
  request: Extract<ControlRequest, { op: 'clock_status' | 'clock_recheck' }>,
  state: LifecycleState,
  retention: RetentionSweeper | null,
): Promise<{ readonly response: ControlResponse }> {
  if (state !== 'running' || retention === null)
    return { response: { ok: false, error: 'unavailable' } };
  if (request.op === 'clock_recheck') {
    const rechecked = await retention.recheckClock({
      request_id: request.request_id,
      revision: request.revision,
      observed_last_checked_at: request.observed_last_checked_at,
      observed_now: request.observed_now,
    });
    if (!rechecked.ok)
      return {
        response: {
          ok: false,
          error: 'refused',
          reason: rechecked.reasons.join(','),
        },
      };
  }
  const view = await retention.clockStatus();
  return {
    response: {
      ok: true,
      request_id: request.request_id,
      clock: {
        state: view.state,
        last_checked_at: view.last_checked_at,
        revision: view.revision,
        epoch: view.epoch,
        now: view.now,
        regressed: view.regressed,
        regressed_by_ms: view.regressed_by_ms,
        needs_recheck: view.needs_recheck,
        rechecks: view.rechecks,
      },
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
