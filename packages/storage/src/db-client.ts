// Core main 側の DB worker のクライアントと送出の許可（設計 11 §9 P06、08 §3、07 §2、ADR 0018）。
//
// - 命令を DB worker へ送り、受付 ACK（received）と結果（durable・accepted・rejected・unknown）を待つ。
//   受付 ACK だけでは「保存済み」「送出」へ進まない。
// - worker の異常終了・応答なし・起動の失敗は成否不明（unknown）として扱い、以後の命令を受け付けない
//   （broken）。commit の応答を失った命令は未 commit と決めつけず、新しい worker で永続レコードを照会する。
// - 送出の許可（DispatchPermit）は、この世代の worker が送出意図の COMMIT の成功を返したときにだけ作る。
//   再到着（replayed）・失敗・成否不明・耐久設定の不一致・古い世代の応答からは作らない。
//   許可は一度だけ使える（consumeDispatchPermit）。外部送出そのものは B04 の担当。

import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { storagePlatform } from './connection.js';
import type { StoragePlatform } from './connection.js';
import { timestamp } from './db-protocol.js';
import type {
  DbQuery,
  DbQueryValue,
  DbWorkerData,
  DbWorkerFaults,
  MainToWorker,
  WorkerTimings,
  WorkerToMain,
} from './db-protocol.js';
import { StorageError } from './errors.js';
import type {
  DbCommand,
  DbCommandKind,
  StoreOutcome,
} from './operation-commands.js';
import type {
  CommandReceiptRecord,
  InterruptedOperation,
  OperationRecord,
  OutboxEventRecord,
} from './operation-store.js';
import type { StoreBindingInput, StoreBindingResult } from './store-binding.js';
import { DEVICE_WRITE_OPS } from './device-store.js';
import type { EventQuery, EventQueryValues } from './event-store.js';
import type {
  CommandScopeRecord,
  DeviceOp,
  DeviceOpResult,
  DeviceRecord,
} from './device-store.js';
import { PAIRING_WRITE_OPS } from './pairing-store.js';
import type {
  PairingOp,
  PairingOpKind,
  PairingOpResult,
  PairingOpValues,
} from './pairing-store.js';
import { HOME_NETWORK_WRITE_OPS } from './home-network-store.js';
import type {
  HomeNetworkOp,
  HomeNetworkOpResult,
  HomeRegistrationRecord,
  HomeReportRecord,
} from './home-network-store.js';
import { CONVERSATION_WRITE_OPS } from './conversation-store.js';
import type {
  ConversationOp,
  ConversationOpResult,
  OperationIntentBlob,
  SessionRecord,
  TurnRecordValue,
} from './conversation-store.js';
import { BUDGET_WRITE_OPS } from './budget-store.js';
import { VOICE_WRITE_OPS } from './voice-store.js';
import { RETENTION_WRITE_OPS } from './retention-store.js';
import type {
  RetentionOp,
  RetentionOpKind,
  RetentionOpResult,
  RetentionOpValues,
} from './retention-store.js';
import type {
  VoiceOp,
  VoiceOpKind,
  VoiceOpResult,
  VoiceOpValues,
} from './voice-store.js';
import type {
  BudgetOp,
  BudgetOpKind,
  BudgetOpResult,
  BudgetOpValues,
} from './budget-store.js';

const MINT = Symbol('DispatchPermit');

// 送出意図の durable commit が成功したことを表す値。DbWorkerClient だけが作る。
export class DispatchPermit {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly content_version: string;
  readonly content_hash: string;
  readonly command_id: string;
  readonly committed_state_revision: string;
  readonly worker_generation: string;
  readonly store_generation: string;

  constructor(
    token: symbol,
    fields: {
      readonly operation_id: string;
      readonly attempt_id: string;
      readonly content_version: string;
      readonly content_hash: string;
      readonly command_id: string;
      readonly committed_state_revision: string;
      readonly worker_generation: string;
      readonly store_generation: string;
    },
  ) {
    if (token !== MINT)
      throw new StorageError(
        'dispatch_permit_forged',
        '送出の許可は DB worker のクライアントだけが作ります。',
      );
    this.operation_id = fields.operation_id;
    this.attempt_id = fields.attempt_id;
    this.content_version = fields.content_version;
    this.content_hash = fields.content_hash;
    this.command_id = fields.command_id;
    this.committed_state_revision = fields.committed_state_revision;
    this.worker_generation = fields.worker_generation;
    this.store_generation = fields.store_generation;
    Object.freeze(this);
  }
}

export type DbCommandOutcome =
  | (Extract<StoreOutcome, { outcome: 'durable' }> & {
      readonly dispatch_permit: DispatchPermit | null;
    })
  | Exclude<StoreOutcome, { outcome: 'durable' }>;

export interface DbSubmission {
  // 受付 ACK。worker が受け取れば true、受け取る前に失われれば false。保存済みの意味はない。
  readonly received: Promise<boolean>;
  readonly result: Promise<DbCommandOutcome>;
}

// 命令ごとの計測（11 §9 の transaction・commit・IPC の待ち）。
export interface DbCommandMetrics {
  readonly command_id: string;
  readonly kind: DbCommandKind;
  readonly outcome: StoreOutcome['outcome'];
  // 送ってから worker が処理を始めるまで。
  readonly queue_wait_ms: number | null;
  readonly transaction_ms: number | null;
  readonly commit_ms: number | null;
  // 送ってから結果を受け取るまで。
  readonly round_trip_ms: number;
}

export interface DbWorkerOptions {
  // DB ファイルの絶対パス。
  readonly path: string;
  readonly platform?: StoragePlatform;
  // 初回の store_generation（試験用）。既存の値は書き換えない。binding を渡したときは使わない。
  readonly storeGeneration?: string;
  // Core の起動で、命令の受付の前に DB と鍵・世代を結び付ける（ADR 0019）。
  // 健全性・鍵の照合値・store_generation のどれかが合わなければ起動に失敗する。
  readonly binding?: StoreBindingInput;
  // 応答を待つ上限。超えたら成否不明として扱う。
  readonly responseTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  readonly onMetrics?: (metrics: DbCommandMetrics) => void;
  // 故障注入の試験用（製品の起動では渡さない）。
  readonly connectionSql?: string;
  readonly faults?: DbWorkerFaults;
}

export type DbWorkerState = 'running' | 'broken' | 'closed';

interface PendingCommand {
  readonly kind: 'command';
  readonly command: DbCommand;
  readonly sentAt: number;
  readonly timer: NodeJS.Timeout;
  readonly resolveReceived: (received: boolean) => void;
  readonly resolve: (outcome: DbCommandOutcome) => void;
}

interface PendingQuery {
  readonly kind: 'query';
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: DbQueryValue) => void;
  readonly reject: (error: Error) => void;
}

interface PendingDevice {
  readonly kind: 'device';
  readonly op: DeviceOp;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (result: DeviceOpResult) => void;
}

interface PendingPairing {
  readonly kind: 'pairing';
  readonly op: PairingOp;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (result: PairingOpResult) => void;
}

// ペアリング・端末の一覧の命令と照会の結果の型（ADR 0021）。
export type PairingOpOutcome<K extends PairingOpKind> =
  | { readonly ok: true; readonly value: PairingOpValues[K] }
  | Extract<PairingOpResult, { ok: false }>;

// 自宅の命令と照会（ADR 0022）。
interface PendingHome {
  readonly kind: 'home';
  readonly op: HomeNetworkOp;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (result: HomeNetworkOpResult) => void;
}

// 会話の命令と照会（ADR 0029）。
interface PendingConversation {
  readonly kind: 'conversation';
  readonly op: ConversationOp;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (result: ConversationOpResult) => void;
}

// 予算の命令と照会（ADR 0036）。
interface PendingBudget {
  readonly kind: 'budget';
  readonly op: BudgetOp;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (result: BudgetOpResult) => void;
}

interface PendingVoice {
  readonly kind: 'voice';
  readonly op: VoiceOp;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (result: VoiceOpResult) => void;
}

interface PendingRetention {
  readonly kind: 'retention';
  readonly op: RetentionOp;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (result: RetentionOpResult) => void;
}

export type RetentionOpOutcome<K extends RetentionOpKind> =
  | { readonly ok: true; readonly value: RetentionOpValues[K] }
  | Extract<RetentionOpResult, { ok: false }>;

export type VoiceOpOutcome<K extends VoiceOpKind> =
  | { readonly ok: true; readonly value: VoiceOpValues[K] }
  | Extract<VoiceOpResult, { ok: false }>;

export type BudgetOpOutcome<K extends BudgetOpKind> =
  | { readonly ok: true; readonly value: BudgetOpValues[K] }
  | Extract<BudgetOpResult, { ok: false }>;

export type ConversationOpOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | Extract<ConversationOpResult, { ok: false }>;

export type HomeNetworkOpOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | Extract<HomeNetworkOpResult, { ok: false }>;

// 端末・接続範囲の命令と照会の結果の型（ADR 0020）。
export type DeviceOpOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | Extract<DeviceOpResult, { ok: false }>;

const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const WORKER_URL = new URL('./db-worker.js', import.meta.url);

export class DbWorkerClient {
  readonly workerGeneration: string;
  readonly storeGeneration: string;
  readonly schemaVersion: number;
  // binding を渡して起動したときの結果。渡していなければ null。
  readonly binding: StoreBindingResult | null;
  #worker: Worker;
  #state: DbWorkerState = 'running';
  #brokenReason: string | null = null;
  #nextId = 1;
  #pending = new Map<
    number,
    | PendingCommand
    | PendingQuery
    | PendingDevice
    | PendingPairing
    | PendingHome
    | PendingConversation
    | PendingBudget
    | PendingVoice
    | PendingRetention
  >();
  #issued = new WeakSet<DispatchPermit>();
  #consumed = new WeakSet<DispatchPermit>();
  #responseTimeoutMs: number;
  #onMetrics: ((metrics: DbCommandMetrics) => void) | undefined;
  #exited: Promise<number>;

  private constructor(
    worker: Worker,
    ready: Extract<WorkerToMain, { type: 'ready' }>,
    exited: Promise<number>,
    options: DbWorkerOptions,
  ) {
    this.#worker = worker;
    this.workerGeneration = ready.worker_generation;
    this.storeGeneration = ready.store_generation;
    this.schemaVersion = ready.schema_version;
    this.binding = ready.binding;
    this.#exited = exited;
    this.#responseTimeoutMs =
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.#onMetrics = options.onMetrics;
    worker.on('message', (message: WorkerToMain) => this.#onMessage(message));
    worker.on('error', () => this.#break('worker_error'));
    worker.on('exit', () => {
      if (this.#state === 'running') this.#break('worker_exited');
      else this.#failPending(this.#brokenReason ?? 'worker_closed');
    });
  }

  // worker を起動し、接続の耐久設定とマイグレーションの確認が終わるまで待つ。
  // 失敗すれば worker の終了を待ってから StorageError を投げる（送出の許可は出せない）。
  static async start(options: DbWorkerOptions): Promise<DbWorkerClient> {
    const data: DbWorkerData = {
      path: options.path,
      platform: options.platform ?? storagePlatform(),
      workerGeneration: randomUUID(),
      storeGeneration: options.storeGeneration ?? null,
      connectionSql: options.connectionSql ?? null,
      faults: options.faults ?? {},
      binding: options.binding ?? null,
    };
    const worker = new Worker(WORKER_URL, { workerData: data });
    const exited = new Promise<number>((resolve) =>
      worker.once('exit', resolve),
    );
    const ready = await new Promise<Extract<WorkerToMain, { type: 'ready' }>>(
      (resolve, reject) => {
        const fail = (error: StorageError): void => {
          cleanup();
          reject(error);
        };
        const timer = setTimeout(
          () =>
            fail(
              new StorageError(
                'db_worker_start_timeout',
                'DB worker の起動が時間内に終わりませんでした。',
              ),
            ),
          options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        );
        const onMessage = (message: WorkerToMain): void => {
          if (message.type === 'ready') {
            cleanup();
            resolve(message);
          } else if (message.type === 'start_failed')
            fail(
              new StorageError(
                message.reason,
                'DB worker が書込み接続を開けませんでした。',
                message.reasons,
              ),
            );
        };
        const onError = (): void =>
          fail(
            new StorageError(
              'db_worker_start_failed',
              'DB worker の起動に失敗しました。',
            ),
          );
        const onExit = (): void =>
          fail(
            new StorageError(
              'db_worker_start_failed',
              'DB worker が起動の途中で終了しました。',
            ),
          );
        const cleanup = (): void => {
          clearTimeout(timer);
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
      },
    ).catch(async (error: unknown) => {
      await worker.terminate();
      await exited;
      throw error;
    });
    if (ready.worker_generation !== data.workerGeneration) {
      await worker.terminate();
      await exited;
      throw new StorageError(
        'db_worker_generation_mismatch',
        'DB worker の世代が一致しません。',
      );
    }
    return new DbWorkerClient(worker, ready, exited, options);
  }

  get state(): DbWorkerState {
    return this.#state;
  }

  // 書込みを止めた理由（broken のとき）。
  get brokenReason(): string | null {
    return this.#brokenReason;
  }

  submit(command: DbCommand): DbSubmission {
    let resolveReceived: (received: boolean) => void = () => undefined;
    const received = new Promise<boolean>((resolve) => {
      resolveReceived = resolve;
    });
    const result = new Promise<DbCommandOutcome>((resolve) => {
      if (this.#state !== 'running') {
        resolveReceived(false);
        // 送っていないので適用していないことが確か。
        resolve({
          outcome: 'rejected',
          command_id: command.command_id,
          kind: command.kind,
          reasons: [
            this.#state === 'closed' ? 'worker_closed' : 'worker_unavailable',
          ],
        });
        return;
      }
      const id = this.#nextId++;
      const sentAt = timestamp();
      const timer = setTimeout(() => {
        // 応答なし。worker の中で commit したかどうか分からない。
        this.#break('worker_timeout');
      }, this.#responseTimeoutMs);
      this.#pending.set(id, {
        kind: 'command',
        command,
        sentAt,
        timer,
        resolveReceived,
        resolve,
      });
      const message: MainToWorker = {
        type: 'command',
        id,
        sent_at: sentAt,
        command,
      };
      this.#worker.postMessage(message);
    });
    return { received, result };
  }

  query(query: {
    kind: 'operation';
    operation_id: string;
  }): Promise<OperationRecord | null>;
  query(query: {
    kind: 'command';
    command_id: string;
  }): Promise<CommandReceiptRecord | null>;
  query(query: {
    kind: 'events';
    after_sequence: number;
    limit: number;
  }): Promise<readonly OutboxEventRecord[]>;
  query(query: {
    kind: 'interrupted';
  }): Promise<readonly InterruptedOperation[]>;
  // スナップショット・イベント・操作の表示用の照会（ADR 0023）。
  query<Q extends EventQuery>(query: Q): Promise<EventQueryValues[Q['kind']]>;
  query(query: DbQuery): Promise<DbQueryValue> {
    return new Promise<DbQueryValue>((resolve, reject) => {
      if (this.#state !== 'running') {
        reject(
          new StorageError(
            'worker_unavailable',
            'DB worker が利用できません。',
          ),
        );
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(
        () => this.#break('worker_timeout'),
        this.#responseTimeoutMs,
      );
      this.#pending.set(id, { kind: 'query', timer, resolve, reject });
      const message: MainToWorker = { type: 'query', id, query };
      this.#worker.postMessage(message);
    });
  }

  // 端末・接続範囲の命令と照会（ADR 0020）。worker が使えなければ送らずに rejected を返す。
  // 書込みの応答を失ったときは成否不明（unknown）とし、以後の命令を送らない（broken）。
  device(
    op: Extract<DeviceOp, { kind: 'device.insert' }>,
  ): Promise<DeviceOpOutcome<DeviceRecord>>;
  device(
    op: Extract<DeviceOp, { kind: 'device.revoke' }>,
  ): Promise<DeviceOpOutcome<{ readonly revoked_scopes: number }>>;
  device(
    op: Extract<DeviceOp, { kind: 'device.find_by_token_hash' }>,
  ): Promise<DeviceOpOutcome<DeviceRecord | null>>;
  device(
    op: Extract<DeviceOp, { kind: 'scope.issue' }>,
  ): Promise<DeviceOpOutcome<CommandScopeRecord>>;
  device(
    op: Extract<DeviceOp, { kind: 'scope.find' }>,
  ): Promise<DeviceOpOutcome<CommandScopeRecord | null>>;
  device(op: DeviceOp): Promise<DeviceOpResult> {
    return new Promise<DeviceOpResult>((resolve) => {
      if (this.#state !== 'running') {
        resolve({
          ok: false,
          outcome: 'rejected',
          reasons: [
            this.#state === 'closed' ? 'worker_closed' : 'worker_unavailable',
          ],
        });
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(
        () => this.#break('worker_timeout'),
        this.#responseTimeoutMs,
      );
      this.#pending.set(id, { kind: 'device', op, timer, resolve });
      const message: MainToWorker = { type: 'device', id, op };
      this.#worker.postMessage(message);
    });
  }

  // ペアリング・端末の一覧の命令と照会（ADR 0021）。扱いは device と同じで、worker が使えなければ
  // 送らずに rejected、書込みの応答を失ったときは成否不明（unknown）にして以後の命令を送らない。
  pairing<K extends PairingOpKind>(
    op: Extract<PairingOp, { kind: K }>,
  ): Promise<PairingOpOutcome<K>> {
    return new Promise<PairingOpResult>((resolve) => {
      if (this.#state !== 'running') {
        resolve({
          ok: false,
          outcome: 'rejected',
          reasons: [
            this.#state === 'closed' ? 'worker_closed' : 'worker_unavailable',
          ],
        });
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(
        () => this.#break('worker_timeout'),
        this.#responseTimeoutMs,
      );
      this.#pending.set(id, { kind: 'pairing', op, timer, resolve });
      const message: MainToWorker = { type: 'pairing', id, op };
      this.#worker.postMessage(message);
    }) as Promise<PairingOpOutcome<K>>;
  }

  // 自宅の命令と照会（ADR 0022）。扱いは device と同じ（使えなければ送らずに rejected、
  // 書込みの応答を失えば成否不明で broken）。
  home(
    op: Extract<HomeNetworkOp, { kind: 'home.register' }>,
  ): Promise<HomeNetworkOpOutcome<HomeRegistrationRecord>>;
  home(
    op: Extract<HomeNetworkOp, { kind: 'home.get' }>,
  ): Promise<HomeNetworkOpOutcome<HomeRegistrationRecord | null>>;
  home(
    op: Extract<HomeNetworkOp, { kind: 'home.report' }>,
  ): Promise<HomeNetworkOpOutcome<HomeReportRecord>>;
  home(
    op: Extract<HomeNetworkOp, { kind: 'home.find_report' }>,
  ): Promise<HomeNetworkOpOutcome<HomeReportRecord | null>>;
  home(
    op: Extract<HomeNetworkOp, { kind: 'home.revoke_scopes' }>,
  ): Promise<HomeNetworkOpOutcome<{ readonly revoked_scopes: number }>>;
  home(op: HomeNetworkOp): Promise<HomeNetworkOpResult> {
    return new Promise<HomeNetworkOpResult>((resolve) => {
      if (this.#state !== 'running') {
        resolve({
          ok: false,
          outcome: 'rejected',
          reasons: [
            this.#state === 'closed' ? 'worker_closed' : 'worker_unavailable',
          ],
        });
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(
        () => this.#break('worker_timeout'),
        this.#responseTimeoutMs,
      );
      this.#pending.set(id, { kind: 'home', op, timer, resolve });
      const message: MainToWorker = { type: 'home', id, op };
      this.#worker.postMessage(message);
    });
  }

  // 会話・発言・依頼・入力スナップショットの命令と照会（ADR 0029）。扱いは home と同じ。
  conversation(
    op: Extract<ConversationOp, { kind: 'session.create' | 'session.get' }>,
  ): Promise<ConversationOpOutcome<SessionRecord | null>>;
  conversation(
    op: Extract<ConversationOp, { kind: 'turn.record' }>,
  ): Promise<ConversationOpOutcome<TurnRecordValue>>;
  conversation(
    op: Extract<ConversationOp, { kind: 'turn.find' }>,
  ): Promise<ConversationOpOutcome<TurnRecordValue | null>>;
  conversation(
    op: Extract<ConversationOp, { kind: 'operation.intent' }>,
  ): Promise<ConversationOpOutcome<OperationIntentBlob | null>>;
  conversation(op: ConversationOp): Promise<ConversationOpResult> {
    return new Promise<ConversationOpResult>((resolve) => {
      if (this.#state !== 'running') {
        resolve({
          ok: false,
          outcome: 'rejected',
          reasons: [
            this.#state === 'closed' ? 'worker_closed' : 'worker_unavailable',
          ],
        });
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(
        () => this.#break('worker_timeout'),
        this.#responseTimeoutMs,
      );
      this.#pending.set(id, { kind: 'conversation', op, timer, resolve });
      const message: MainToWorker = { type: 'conversation', id, op };
      this.#worker.postMessage(message);
    });
  }

  // 予算の命令と照会（ADR 0036）。扱いは home と同じ（使えなければ送らずに rejected、書込みの応答を失えば
  // 成否不明で broken。成否不明の受付は、新しい worker で同じ request_id を送り直すと保存済みの予約を返す）。
  budget<K extends BudgetOpKind>(
    op: Extract<BudgetOp, { kind: K }>,
  ): Promise<BudgetOpOutcome<K>> {
    return new Promise<BudgetOpResult>((resolve) => {
      if (this.#state !== 'running') {
        resolve({
          ok: false,
          outcome: 'rejected',
          reasons: [
            this.#state === 'closed' ? 'worker_closed' : 'worker_unavailable',
          ],
        });
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(
        () => this.#break('worker_timeout'),
        this.#responseTimeoutMs,
      );
      this.#pending.set(id, { kind: 'budget', op, timer, resolve });
      const message: MainToWorker = { type: 'budget', id, op };
      this.#worker.postMessage(message);
    }) as Promise<BudgetOpOutcome<K>>;
  }

  // 音声の世代・入出力の停止・Live の制御の状態の命令と照会（ADR 0046）。扱いは budget と同じ（使えなければ送らずに
  // rejected、書込みの応答を失えば成否不明で broken）。
  voice<K extends VoiceOpKind>(
    op: Extract<VoiceOp, { kind: K }>,
  ): Promise<VoiceOpOutcome<K>> {
    return new Promise<VoiceOpResult>((resolve) => {
      if (this.#state !== 'running') {
        resolve({
          ok: false,
          outcome: 'rejected',
          reasons: [
            this.#state === 'closed' ? 'worker_closed' : 'worker_unavailable',
          ],
        });
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(
        () => this.#break('worker_timeout'),
        this.#responseTimeoutMs,
      );
      this.#pending.set(id, { kind: 'voice', op, timer, resolve });
      const message: MainToWorker = { type: 'voice', id, op };
      this.#worker.postMessage(message);
    }) as Promise<VoiceOpOutcome<K>>;
  }

  // 終わった操作の本文の削除・90 日の削除・用事の正本の移行（ADR 0051）。扱いは budget と同じ。
  retention<K extends RetentionOpKind>(
    op: Extract<RetentionOp, { kind: K }>,
  ): Promise<RetentionOpOutcome<K>> {
    return new Promise<RetentionOpResult>((resolve) => {
      if (this.#state !== 'running') {
        resolve({
          ok: false,
          outcome: 'rejected',
          reasons: [
            this.#state === 'closed' ? 'worker_closed' : 'worker_unavailable',
          ],
        });
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(
        () => this.#break('worker_timeout'),
        this.#responseTimeoutMs,
      );
      this.#pending.set(id, { kind: 'retention', op, timer, resolve });
      const message: MainToWorker = { type: 'retention', id, op };
      this.#worker.postMessage(message);
    }) as Promise<RetentionOpOutcome<K>>;
  }

  // 許可がこのクライアントの現在の世代で作られ、まだ使っておらず、worker が動いているか。
  isDispatchPermitCurrent(permit: DispatchPermit): boolean {
    return (
      this.#state === 'running' &&
      this.#issued.has(permit) &&
      !this.#consumed.has(permit) &&
      permit.worker_generation === this.workerGeneration
    );
  }

  // 送出の直前に一度だけ呼ぶ。true のときだけ外部へ一度送ってよい（自動リトライ 0 回）。
  consumeDispatchPermit(permit: DispatchPermit): boolean {
    if (!this.isDispatchPermitCurrent(permit)) return false;
    this.#consumed.add(permit);
    return true;
  }

  // 処理中の命令を終えてから接続を閉じ、worker の終了を待つ。
  async close(): Promise<void> {
    if (this.#state === 'running') {
      const id = this.#nextId++;
      const message: MainToWorker = { type: 'close', id };
      this.#state = 'closed';
      this.#worker.postMessage(message);
      const timer = setTimeout(() => {
        void this.#worker.terminate();
      }, this.#responseTimeoutMs);
      await this.#exited;
      clearTimeout(timer);
      return;
    }
    await this.#worker.terminate();
    await this.#exited;
  }

  // worker を強制終了する（応答なしの後始末・試験）。処理中の命令は成否不明になる。
  async terminate(): Promise<void> {
    if (this.#state === 'running') this.#break('worker_terminated');
    await this.#worker.terminate();
    await this.#exited;
  }

  #break(reason: string): void {
    if (this.#state === 'running') {
      this.#state = 'broken';
      this.#brokenReason = reason;
    }
    this.#failPending(reason);
    // 応答のない worker を残さない。前の世代の終了は exited で確かめられる。
    void this.#worker.terminate();
  }

  #failPending(reason: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (pending.kind === 'query') {
        pending.reject(
          new StorageError(reason, 'DB worker から応答がありませんでした。'),
        );
        continue;
      }
      if (pending.kind === 'pairing') {
        pending.resolve({
          ok: false,
          outcome: PAIRING_WRITE_OPS.has(pending.op.kind)
            ? 'unknown'
            : 'rejected',
          reasons: [reason],
        });
        continue;
      }
      if (pending.kind === 'device') {
        // 照会は何も書いていない。書込みは commit したかどうか分からない。
        pending.resolve({
          ok: false,
          outcome: DEVICE_WRITE_OPS.has(pending.op.kind)
            ? 'unknown'
            : 'rejected',
          reasons: [reason],
        });
        continue;
      }
      if (pending.kind === 'home') {
        pending.resolve({
          ok: false,
          outcome: HOME_NETWORK_WRITE_OPS.has(pending.op.kind)
            ? 'unknown'
            : 'rejected',
          reasons: [reason],
        });
        continue;
      }
      if (pending.kind === 'budget') {
        pending.resolve({
          ok: false,
          outcome: BUDGET_WRITE_OPS.has(pending.op.kind)
            ? 'unknown'
            : 'rejected',
          reasons: [reason],
        });
        continue;
      }
      if (pending.kind === 'retention') {
        pending.resolve({
          ok: false,
          outcome: RETENTION_WRITE_OPS.has(pending.op.kind)
            ? 'unknown'
            : 'rejected',
          reasons: [reason],
        });
        continue;
      }
      if (pending.kind === 'voice') {
        pending.resolve({
          ok: false,
          outcome: VOICE_WRITE_OPS.has(pending.op.kind)
            ? 'unknown'
            : 'rejected',
          reasons: [reason],
        });
        continue;
      }
      if (pending.kind === 'conversation') {
        pending.resolve({
          ok: false,
          outcome: CONVERSATION_WRITE_OPS.has(pending.op.kind)
            ? 'unknown'
            : 'rejected',
          reasons: [reason],
        });
        continue;
      }
      pending.resolveReceived(false);
      const outcome: DbCommandOutcome = {
        outcome: 'unknown',
        command_id: pending.command.command_id,
        kind: pending.command.kind,
        reason,
      };
      this.#report(pending, outcome, null);
      pending.resolve(outcome);
    }
  }

  #report(
    pending: PendingCommand,
    outcome: DbCommandOutcome,
    timings: WorkerTimings | null,
  ): void {
    if (this.#onMetrics === undefined) return;
    try {
      this.#onMetrics({
        command_id: pending.command.command_id,
        kind: pending.command.kind,
        outcome: outcome.outcome,
        queue_wait_ms: timings?.queue_wait_ms ?? null,
        transaction_ms: timings?.transaction_ms ?? null,
        commit_ms: timings?.commit_ms ?? null,
        round_trip_ms: timestamp() - pending.sentAt,
      });
    } catch {
      // 計測の失敗で結果を変えない。
    }
  }

  #onMessage(message: WorkerToMain): void {
    if (message.type === 'received') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind === 'command') pending.resolveReceived(true);
      return;
    }
    if (message.type === 'query_result' || message.type === 'query_failed') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind !== 'query') return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.type === 'query_result') pending.resolve(message.value);
      else
        pending.reject(
          new StorageError(message.reason, 'DB の照会に失敗しました。'),
        );
      return;
    }
    if (message.type === 'device_result') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind !== 'device') return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.halted && this.#state === 'running') {
        this.#state = 'broken';
        this.#brokenReason = 'worker_halted';
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'pairing_result') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind !== 'pairing') return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.halted && this.#state === 'running') {
        this.#state = 'broken';
        this.#brokenReason = 'worker_halted';
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'home_result') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind !== 'home') return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.halted && this.#state === 'running') {
        this.#state = 'broken';
        this.#brokenReason = 'worker_halted';
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'conversation_result') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind !== 'conversation') return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.halted && this.#state === 'running') {
        this.#state = 'broken';
        this.#brokenReason = 'worker_halted';
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'retention_result') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind !== 'retention') return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.halted && this.#state === 'running') {
        this.#state = 'broken';
        this.#brokenReason = 'worker_halted';
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'voice_result') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind !== 'voice') return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.halted && this.#state === 'running') {
        this.#state = 'broken';
        this.#brokenReason = 'worker_halted';
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'budget_result') {
      const pending = this.#pending.get(message.id);
      if (pending?.kind !== 'budget') return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.halted && this.#state === 'running') {
        this.#state = 'broken';
        this.#brokenReason = 'worker_halted';
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type !== 'result') return;
    const pending = this.#pending.get(message.id);
    if (pending?.kind !== 'command') return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    pending.resolveReceived(true);
    if (message.halted && this.#state === 'running') {
      // worker が書込みを止めた。以後の命令は送らない（接続の作り直しは新しい世代で）。
      this.#state = 'broken';
      this.#brokenReason = 'worker_halted';
    }
    const outcome = this.#toOutcome(pending.command, message);
    this.#report(pending, outcome, message.timings);
    pending.resolve(outcome);
  }

  #toOutcome(
    command: DbCommand,
    message: Extract<WorkerToMain, { type: 'result' }>,
  ): DbCommandOutcome {
    const outcome = message.outcome;
    if (outcome.outcome !== 'durable') return outcome;
    // 古い世代・別の命令の応答を送出の根拠にしない。
    const current =
      message.worker_generation === this.workerGeneration &&
      outcome.command_id === command.command_id &&
      outcome.operation_id === command.operation_id &&
      outcome.kind === command.kind;
    if (!current)
      return {
        outcome: 'unknown',
        command_id: command.command_id,
        kind: command.kind,
        reason: 'response_mismatch',
      };
    let permit: DispatchPermit | null = null;
    if (
      command.kind === 'operation.dispatch_intent' &&
      !outcome.replayed &&
      outcome.dispatched !== null &&
      outcome.dispatched.attempt_id === command.attempt_id &&
      this.#state === 'running'
    ) {
      permit = new DispatchPermit(MINT, {
        operation_id: outcome.operation_id,
        attempt_id: outcome.dispatched.attempt_id,
        content_version: outcome.dispatched.content_version,
        content_hash: outcome.dispatched.content_hash,
        command_id: outcome.command_id,
        committed_state_revision: outcome.committed_state_revision,
        worker_generation: this.workerGeneration,
        store_generation: this.storeGeneration,
      });
      this.#issued.add(permit);
    }
    return { ...outcome, dispatch_permit: permit };
  }
}
