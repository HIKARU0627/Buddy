// 実行担当（設計 08 §1〜4、09 §4、ADR 0018・0019・0027・0030）。承認の後に操作を一度だけ実行する。
//
// - RemoteMutation: prepare（準備権）→ アダプターで対象と許可を確かめ直す → dispatch_intent（送出意図の COMMIT、
//   DispatchPermit）→ 許可を一度だけ使って 1 回だけ送る → record_result。
//   - 確かめ直しで対象の版・許可の版が変わっていれば送らず、同じ operation_id で内容版を上げて承認待ちへ戻す（D1、X09）。
//   - 応答を失ったら直後に 1 回だけ参照で照合する（D4、AUTO_RECONCILE_LIMIT）。正確な対象で変更を確かめられれば
//     succeeded、できなければ unknown_held。結果不明の自動再送はしない。以後の照合は本人の操作（reconcile）だけ。
//   - 送出境界を越えた後に取消を受け付けた操作（X05）は、結果が分かっても reconciling で止め、本人の照合に委ねる。
// - LocalCommand（task.create）: 外部 HTTP を使わず、operation.apply_local の一つの transaction で適用する（D5）。
// - 起動時: approved・preparing から再開する（送出意図の前なので送っていないことが記録上確か）。dispatching は回復で
//   unknown_held になっており、送らない（recovery.ts）。
// - 経路と照合の方法はコードの表（OPERATION_KIND_RULES）が決める。表と経路が食い違う操作は実行しない。
// - 停止（close）の後は、外部へ送らない。故障点（FaultHook）で止まっていても、再開した後に送らずに終える。

import { randomUUID } from 'node:crypto';
import {
  OPERATION_KIND_RULES,
  SWEEP_INTERVAL_MS,
  canAutoReconcile,
  isOperationKind,
  nextStepDecision,
  operationMarker,
  reconcileOutcome,
} from '@buddy/domain';
import type {
  OperationStepKind,
  OperationStepRecord,
  ReconcileObservation,
  StepResultStatus,
} from '@buddy/domain';
import {
  openOperationIntent,
  openTaskContent,
  sameTaskContent,
  sealOperationIntent,
  sealTaskContent,
  taskContentFromIntent,
} from '@buddy/storage';
import type {
  DataKeyMaterial,
  DataKeyProvider,
  DbCommand,
  DbCommandOutcome,
  DbWorkerClient,
  DeviceRequestRef,
  OperationView,
  ResultState,
} from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import type { TurnRouteStore } from './api-turns.js';
import { canRead, canWrite, replyFields } from './turn-ports.js';
import type {
  FaultHook,
  ProviderDraft,
  ProviderMailTarget,
  ProviderReader,
  ProviderWriter,
} from './turn-ports.js';

export interface RunnerStore extends TurnRouteStore {
  consumeDispatchPermit: DbWorkerClient['consumeDispatchPermit'];
}

export interface OperationRunnerOptions {
  readonly store: RunnerStore;
  readonly keyStore: DataKeyProvider;
  readonly provider: ProviderReader | null;
  readonly writer: ProviderWriter | null;
  readonly faults: FaultHook;
  readonly contract: ApiContract;
  readonly log: (message: string) => void;
  // 保存期限の掃除のゲート（ADR 0043・0053）。外部へ送る前に、掃除が済んでクラウド送信が許されていることを確かめる。
  // 閉じていれば送らず、次の周期（gateRetryMs）に最初から確かめ直す。省略したときは確かめない（試験）。
  readonly cloudGate?: {
    readonly ready: () => Promise<void>;
    readonly open: () => boolean;
    // 送出の区間（ゲートの確認から送信の終わりまで）を掃除の本体と直列にする貸し出し。ゲートが閉じている・
    // 掃除が動いている・待っているときは null。返した関数を送信の後に呼ぶ。
    readonly lease: () => (() => void) | null;
  };
  readonly gateRetryMs?: number;
}

export interface OperationRunner {
  // 承認の保存の後に呼ぶ。同じ操作の実行が進んでいれば何もしない。
  afterApproval(operationId: string): void;
  // 再開（起動時・本人の再試行の後）。approved・preparing の操作を進める。
  start(operationId: string): void;
  // 本人の照合（D4）。unknown_held・reconciling の操作を参照だけで照合する。照合中・対象外なら null。
  reconcile(
    operationId: string,
    expectedStateRevision: string,
    request: DeviceRequestRef,
    commandId: string,
  ): Promise<DbCommandOutcome | null>;
  // 進行中の実行がすべて終わるまで待つ（試験・停止の診断用）。
  idle(): Promise<void>;
  // 停止。以後は外部へ送らず、新しい実行を始めない。
  close(): void;
}

// 外部変更の確定 intent のうち、実行に使う共通の項目（口座・許可の版・前提の対象）。
interface RemoteIntentBase {
  readonly raw: Record<string, unknown>;
  readonly account_id: string;
  readonly permission_revision: string;
  // 前提の対象（ラベル変更は対象のメール、下書きは返信元）。送出の直前に版を読み直す。
  readonly remote_id: string;
  readonly source_revision: string;
}

// ラベル変更の確定 intent のうち、実行に使う項目。
interface LabelIntent extends RemoteIntentBase {
  readonly kind: 'mail.labels.change';
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

// 返信の下書きの保存の確定 intent のうち、実行に使う項目（B04-07）。
interface DraftIntent extends RemoteIntentBase {
  readonly kind: 'mail.draft.create';
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
  // 作成物に付ける目印（operation_id と content_version から決める。試行 ID を含めない）。
  readonly marker: string;
}

type RemoteIntent = LabelIntent | DraftIntent;

type Recheck =
  | {
      readonly kind: 'ok';
      readonly status:
        'active' | 'needs_reauth' | 'needs_attention' | 'disconnected';
      readonly access: 'read' | 'read_write';
      readonly permission_revision: string;
    }
  // 対象の版・許可の版が変わった。送らずに内容版を上げる（D1）。
  | {
      readonly kind: 'changed';
      readonly source_revision: string;
      readonly permission_revision: string;
      // 読み直した対象（下書きは返信元から宛先・件名を作り直す）。
      readonly target: ProviderMailTarget;
    }
  // 確かめられない（接続なし・対象なし・書込み不可）。送らず、準備のまま残す（本人の取消か再開を待つ）。
  | { readonly kind: 'blocked'; readonly reason: string };

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;

// 正確な対象での照合（exact_target）。対象のラベルに、追加したラベルがすべてあり、外したラベルがないこと。
export function labelChangeObserved(
  target: ProviderMailTarget | null,
  intent: Pick<LabelIntent, 'remote_id' | 'add' | 'remove'>,
): ReconcileObservation {
  if (target === null || target.remote_id !== intent.remote_id)
    return { kind: 'unreadable' };
  const applied =
    intent.add.every((label) => target.labels.includes(label)) &&
    intent.remove.every((label) => !target.labels.includes(label));
  return applied
    ? { kind: 'found', external_id: target.remote_id }
    : { kind: 'not_found' };
}

// 目印での照合（operation_marker）。同じ目印の下書きがちょうど 1 件なら found、0 件は not_found
// （遅れて適用されうる）、2 件以上は multiple（重複の可能性があり、本人の確認が要る）。
// 目印が同じで返信元が違う作成物があれば、Buddy の作成物として説明できないので unreadable にする。
export function draftSaveObserved(
  drafts: readonly ProviderDraft[],
  intent: Pick<DraftIntent, 'marker' | 'remote_id'>,
): ReconcileObservation {
  const matched = drafts.filter((draft) => draft.marker === intent.marker);
  if (matched.some((draft) => draft.in_reply_to !== intent.remote_id))
    return { kind: 'unreadable' };
  if (matched.length === 0) return { kind: 'not_found' };
  if (matched.length > 1) return { kind: 'multiple', count: matched.length };
  return { kind: 'found', external_id: (matched[0] as ProviderDraft).draft_id };
}

const STEP_KINDS: readonly string[] = [
  'apply_labels',
  'create_draft',
  'send',
  'create_task',
];
const STEP_RESULTS: readonly string[] = [
  'confirmed_success',
  'confirmed_not_executed',
  'unknown',
];

// 保存した工程の行を domain の形にする。知らない値の行は、順序の食い違いとして nextStepDecision に止めさせる。
function stepRecords(current: OperationView): OperationStepRecord[] {
  return current.steps.map((row) => ({
    step_id: row.step_id,
    step_kind: (STEP_KINDS.includes(row.step_kind)
      ? row.step_kind
      : 'unknown') as OperationStepKind,
    dispatch_intent_at: row.dispatch_intent_at,
    result_status:
      row.result_status === null || STEP_RESULTS.includes(row.result_status)
        ? (row.result_status as StepResultStatus | null)
        : 'unknown',
    external_id: row.external_id,
  }));
}

export function createOperationRunner(
  options: OperationRunnerOptions,
): OperationRunner {
  const { store, faults, log } = options;
  // 操作ごとの排他。照合（reconcile）の登録は、どの要求の照合かを持つ（同じ要求だけを待たせるため）。
  interface Held {
    readonly done: Promise<void>;
    readonly reconcileCommandId: string | null;
  }
  const running = new Map<string, Held>();
  // 排他の間に届いた実行の開始（afterApproval なら true）。排他を外した後に始める（要求を捨てない）。
  const pendingStarts = new Map<string, boolean>();
  let closed = false;
  // ゲートが閉じていて送らなかった操作の再試行（close で止める）。
  const retryTimers = new Set<NodeJS.Timeout>();

  const loadKey = async (): Promise<DataKeyMaterial | null> => {
    try {
      const result = await options.keyStore.loadDataKey();
      return result.ok ? result.dataKey : null;
    } catch {
      return null;
    }
  };

  const view = (operationId: string) =>
    store.query({ kind: 'operation_view', operation_id: operationId });

  const submit = async (command: DbCommand): Promise<DbCommandOutcome> =>
    store.submit(command).result;

  // 端末の要求（request あり）の命令 ID は、接続範囲と request_id から決めた値（deviceCommandId）を使う。
  const base = (
    current: OperationView,
    permissionRevision: string,
    request: DeviceRequestRef | null = null,
    expected: string = current.state_revision,
    commandId: string = randomUUID(),
  ) => ({
    command_id: commandId,
    operation_id: current.operation_id,
    expected_state_revision: expected,
    request_revision: current.request_revision,
    permission_revision: permissionRevision,
    forgetting_generation: current.forgetting_generation,
    // 操作に連携の接続の列がない（0001）。外部変更の送出意図では observed_connection で照合する（ADR 0030）。
    connection_id: null,
    request,
  });

  // 今の内容版の確定 intent を復号する（保存した hash と照合する）。
  const openIntent = async (
    current: OperationView,
  ): Promise<Record<string, unknown> | null> => {
    const blob = await store.conversation({
      kind: 'operation.intent',
      operation_id: current.operation_id,
      content_version: current.current_content_version,
    });
    if (!blob.ok || blob.value === null) return null;
    if (blob.value.content_hash !== current.content_hash) return null;
    const key = await loadKey();
    if (key === null) return null;
    const opened = openOperationIntent(
      key,
      {
        operationId: current.operation_id,
        contentVersion: Number(current.current_content_version),
      },
      {
        formatVersion: blob.value.format_version,
        keyId: blob.value.key_id,
        nonce: blob.value.nonce,
        ciphertext: blob.value.ciphertext,
        tag: blob.value.tag,
      },
      current.content_hash,
    );
    if (!opened.ok) return null;
    const intent = JSON.parse(opened.canonical) as Record<string, unknown>;
    return options.contract.valid('OperationIntent', intent) ? intent : null;
  };

  // 確定 intent から実行に使う項目を取り出す。保存した操作の種類と action.kind が違えば実行しない。
  const remoteIntent = (
    raw: Record<string, unknown>,
    operationKind: string,
  ): RemoteIntent | null => {
    const target = raw['target'] as Record<string, unknown> | undefined;
    const action = raw['action'] as Record<string, unknown> | undefined;
    if (
      action?.['kind'] !== operationKind ||
      typeof raw['account_id'] !== 'string' ||
      typeof raw['permission_revision'] !== 'string' ||
      typeof target?.['remote_id'] !== 'string' ||
      typeof target['source_revision'] !== 'string'
    )
      return null;
    const base = {
      raw,
      account_id: raw['account_id'],
      permission_revision: raw['permission_revision'],
      remote_id: target['remote_id'],
      source_revision: target['source_revision'],
    };
    if (operationKind === 'mail.labels.change') {
      const add = strings(action['add']);
      const remove = strings(action['remove']);
      if (add === null || remove === null) return null;
      return { ...base, kind: 'mail.labels.change', add, remove };
    }
    if (operationKind === 'mail.draft.create') {
      const to = strings(action['to']);
      const cc = strings(action['cc']);
      const subject = action['subject'];
      const body = action['body'];
      if (
        to === null ||
        cc === null ||
        typeof subject !== 'string' ||
        typeof body !== 'string' ||
        typeof raw['operation_id'] !== 'string' ||
        typeof raw['content_version'] !== 'string'
      )
        return null;
      let marker: string;
      try {
        marker = operationMarker(raw['operation_id'], raw['content_version']);
      } catch {
        return null;
      }
      return {
        ...base,
        kind: 'mail.draft.create',
        to,
        cc,
        subject,
        body,
        marker,
      };
    }
    return null;
  };

  // 種類ごとの書込み・照合の差し込み口が provider にあるか（ない provider では送らない）。
  const supported = (intent: RemoteIntent): boolean =>
    intent.kind === 'mail.labels.change' ||
    (options.writer?.createDraft !== undefined &&
      options.provider?.findDrafts !== undefined);

  // アダプターで対象と許可を確かめ直す（送出の直前の接続の照合を含む）。読み取りだけ。
  const recheck = async (intent: RemoteIntent): Promise<Recheck> => {
    const provider = options.provider;
    if (provider === null) return { kind: 'blocked', reason: 'no_provider' };
    try {
      const connection = await provider.connection();
      if (connection === null || connection.account_id !== intent.account_id)
        return { kind: 'blocked', reason: 'connection_missing' };
      const permission = await provider.readPermission(intent.account_id);
      if (permission === null || permission.account_id !== intent.account_id)
        return { kind: 'blocked', reason: 'permission_unreadable' };
      // 対象のメールを読む前に、メールの読み取りが許可に含まれることを確かめる（B04-07）。
      if (!canRead(connection, 'mail.message'))
        return { kind: 'blocked', reason: 'not_readable' };
      const target = await provider.readTarget(intent.remote_id);
      if (target === null || target.remote_id !== intent.remote_id)
        return { kind: 'blocked', reason: 'target_missing' };
      if (
        target.source_revision !== intent.source_revision ||
        permission.permission_revision !== intent.permission_revision
      )
        return {
          kind: 'changed',
          source_revision: target.source_revision,
          permission_revision: permission.permission_revision,
          target,
        };
      // 書込みの範囲がこの種類を許していなければ送らない（B04-07。範囲は種類ごと）。
      if (!canWrite(connection, intent.kind))
        return { kind: 'blocked', reason: 'not_writable' };
      return {
        kind: 'ok',
        status: connection.status,
        access: connection.access,
        permission_revision: permission.permission_revision,
      };
    } catch {
      return { kind: 'blocked', reason: 'provider_unreadable' };
    }
  };

  // 参照だけの照合（D4）。再送しない。
  const lookup = async (
    intent: RemoteIntent,
  ): Promise<ReconcileObservation> => {
    const provider = options.provider;
    if (provider === null) return { kind: 'unreadable' };
    try {
      if (intent.kind === 'mail.labels.change')
        return labelChangeObserved(
          await provider.readTarget(intent.remote_id),
          intent,
        );
      // 下書きは作成物の目印で探す（by_operation_marker）。
      if (provider.findDrafts === undefined) return { kind: 'unreadable' };
      return draftSaveObserved(
        await provider.findDrafts(intent.marker),
        intent,
      );
    } catch {
      return { kind: 'unreadable' };
    }
  };

  // 1 回だけ送る。どの結果でも再送しない。応答を失ったら直後に 1 回だけ参照で照合する（D4）。
  const send = async (
    writer: ProviderWriter,
    intent: RemoteIntent,
    identity: { operation_id: string; attempt_id: string; step_id: string },
  ): Promise<ReconcileObservation | 'not_executed'> => {
    let outcome:
      | { readonly kind: 'applied'; readonly external_id: string }
      | { readonly kind: 'rejected' | 'not_sent' | 'unknown' };
    if (intent.kind === 'mail.labels.change') {
      const labels = await writer.changeLabels(identity, {
        remote_id: intent.remote_id,
        add: intent.add,
        remove: intent.remove,
      });
      outcome =
        labels.kind === 'applied'
          ? { kind: 'applied', external_id: labels.value.remote_id }
          : { kind: labels.kind };
    } else {
      if (writer.createDraft === undefined) return { kind: 'unreadable' };
      const created = await writer.createDraft(identity, {
        in_reply_to: intent.remote_id,
        to: intent.to,
        cc: intent.cc,
        subject: intent.subject,
        body: intent.body,
        marker: intent.marker,
      });
      outcome =
        created.kind === 'applied'
          ? { kind: 'applied', external_id: created.value.draft_id }
          : { kind: created.kind };
    }
    if (outcome.kind === 'applied')
      return { kind: 'found', external_id: outcome.external_id };
    if (outcome.kind === 'rejected' || outcome.kind === 'not_sent')
      return 'not_executed';
    return canAutoReconcile(0) ? lookup(intent) : { kind: 'unreadable' };
  };

  const record = (
    current: OperationView,
    attemptId: string,
    to: ResultState,
    expected: string,
    externalId: string | null,
    request: DeviceRequestRef | null = null,
    commandId?: string,
  ) =>
    submit({
      ...base(current, '0', request, expected, commandId),
      kind: 'operation.record_result',
      attempt_id: attemptId,
      to,
      external_id: externalId,
    });

  // 照合の観測を記録する。成功の証拠（found）だけを succeeded にし、他は unknown_held に留める。
  // 送出境界の後に取消を受け付けた操作は reconciling で止める（X05、本人の照合へ）。
  // byUser: 本人が要求した照合。found なら、取消の受付があっても成功として確定する（本人が結果を見て決めた）。
  const recordObservation = async (
    operationId: string,
    attemptId: string,
    observation: ReconcileObservation,
    byUser = false,
  ): Promise<void> => {
    let current = await view(operationId);
    if (current === null || current.attempt_id !== attemptId) return;
    const outcome = reconcileOutcome(observation);
    if (outcome.state === 'unknown_held') {
      if (current.state === 'dispatching' || current.state === 'reconciling')
        await record(
          current,
          attemptId,
          'unknown_held',
          current.state_revision,
          null,
        );
      log(
        `操作 ${operationId} は結果不明として保留しました（${outcome.reasons.join(', ')}）。自動では再送しません。`,
      );
      return;
    }
    const externalId =
      observation.kind === 'found' ? observation.external_id : null;
    if (current.state === 'dispatching') {
      const step = await record(
        current,
        attemptId,
        'reconciling',
        current.state_revision,
        externalId,
      );
      if (step.outcome !== 'durable') return;
      current = await view(operationId);
      if (current === null) return;
    }
    if (current.state !== 'reconciling') return;
    if (current.cancel_requested && !byUser) {
      log(
        `操作 ${operationId} は送出の後に取消を受け付けたため、照合中のまま本人の確認を待ちます。`,
      );
      return;
    }
    await record(
      current,
      attemptId,
      'succeeded',
      current.state_revision,
      externalId,
    );
  };

  // 確定した未実行（拒否・未送信）。reconciling を経て not_executed にする。
  const recordNotExecuted = async (
    operationId: string,
    attemptId: string,
  ): Promise<void> => {
    let current = await view(operationId);
    if (current === null || current.state !== 'dispatching') return;
    const step = await record(
      current,
      attemptId,
      'reconciling',
      current.state_revision,
      null,
    );
    if (step.outcome !== 'durable') return;
    current = await view(operationId);
    if (current === null || current.state !== 'reconciling') return;
    await record(
      current,
      attemptId,
      'not_executed',
      current.state_revision,
      null,
    );
  };

  // D1: 対象・許可の版が変わったら送らず、同じ operation_id で内容版を上げる（旧版の承認は revoked、試行は superseded）。
  const revise = async (
    current: OperationView,
    intent: RemoteIntent,
    change: Extract<Recheck, { kind: 'changed' }>,
  ): Promise<void> => {
    const next = String(BigInt(current.current_content_version) + 1n);
    // 下書きは、読み直した返信元から宛先・件名を作り直す（返信元の差出人・件名が変わっていれば新しい値になる）。
    // 作り直せない（差出人か件名が読めない）なら内容版を上げず、準備のまま残す。本文と CC は変えない。
    let action = intent.raw['action'] as Record<string, unknown>;
    if (intent.kind === 'mail.draft.create') {
      const reply = replyFields(change.target);
      if (reply === null) {
        log(
          `操作 ${current.operation_id} の返信元の差出人か件名を読めないため、送らずに準備のまま残しました。`,
        );
        return;
      }
      action = { ...action, to: [...reply.to], subject: reply.subject };
    }
    const content = {
      ...intent.raw,
      content_version: next,
      permission_revision: change.permission_revision,
      target: {
        ...(intent.raw['target'] as Record<string, unknown>),
        source_revision: change.source_revision,
      },
      action,
    };
    if (!options.contract.valid('OperationIntent', content)) return;
    const key = await loadKey();
    if (key === null) return;
    const sealed = sealOperationIntent(
      key,
      { operationId: current.operation_id, contentVersion: Number(next) },
      content,
    );
    if (!sealed.ok) return;
    const outcome = await submit({
      ...base(current, change.permission_revision),
      kind: 'operation.revise_content',
      content_version: next,
      content_hash: sealed.content_hash,
      intent: sealed.intent,
    });
    if (outcome.outcome === 'durable')
      log(
        `操作 ${current.operation_id} の対象か許可が変わったため、送らずに内容版 ${next} の承認待ちへ戻しました。`,
      );
  };

  // ゲートが閉じていて送らなかった操作を、次の周期に最初から確かめ直す。
  const holdForGate = (operationId: string): void => {
    log(
      `操作 ${operationId} は保存期限の掃除が済むまで送りません。次の周期に確かめ直します。`,
    );
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      launch(operationId, false);
    }, options.gateRetryMs ?? SWEEP_INTERVAL_MS);
    timer.unref?.();
    retryTimers.add(timer);
  };

  // 準備権の前のゲート。掃除の完了を待ち、クラウド送信が許されていなければ送らず、次の周期に再試行する。
  // 送出意図の前の判定なので、閉じていても結果不明は作らない（状態は approved・preparing のまま残る）。
  const cloudSendAllowed = async (operationId: string): Promise<boolean> => {
    const gate = options.cloudGate;
    if (gate === undefined) return true;
    await gate.ready();
    if (closed) return false;
    if (gate.open()) return true;
    holdForGate(operationId);
    return false;
  };

  // 送出意図の記録から送信の終わりまでの貸し出しを受ける。ゲートの確認と貸し出しは同じ同期の区間で行うので、
  // 確認の後に掃除が本体に入ることはない（掃除は貸し出しが返るまで待つ）。取れなければ送出意図の前で止める
  // （保存後に止めると、送っていない操作に結果不明を作る）。
  const leaseSend = async (
    operationId: string,
  ): Promise<(() => void) | null> => {
    const gate = options.cloudGate;
    if (gate === undefined) return () => undefined;
    await gate.ready();
    if (closed) return null;
    const release = gate.lease();
    if (release === null) holdForGate(operationId);
    return release;
  };

  const runRemote = async (initial: OperationView): Promise<void> => {
    const writer = options.writer;
    if (writer === null || options.provider === null) return;
    // 準備権を取る前に確かめる（閉じていれば approved のまま、何も記録しない）。
    if (!(await cloudSendAllowed(initial.operation_id))) return;
    const raw = await openIntent(initial);
    const intent =
      raw === null ? null : remoteIntent(raw, initial.operation_kind);
    if (intent === null) return;
    if (!supported(intent)) {
      log(
        `操作 ${initial.operation_id} の種類は、この接続では実行できません。`,
      );
      return;
    }
    let current: OperationView | null = initial;
    let attemptId: string;
    if (current.state === 'approved') {
      attemptId = randomUUID();
      const prepared = await submit({
        ...base(current, intent.permission_revision),
        kind: 'operation.prepare',
        attempt_id: attemptId,
      });
      if (prepared.outcome !== 'durable') return;
      current = await view(current.operation_id);
    } else if (
      current.state === 'preparing' &&
      current.attempt_id !== null &&
      current.attempt_status === 'preparing'
    )
      attemptId = current.attempt_id;
    else return;
    if (current === null || current.state !== 'preparing' || closed) return;
    const checked = await recheck(intent);
    if (checked.kind === 'changed') {
      await revise(current, intent, checked);
      return;
    }
    if (checked.kind === 'blocked') {
      log(
        `操作 ${current.operation_id} は対象か接続を確かめられないため、送らずに準備のまま残しました（${checked.reason}）。`,
      );
      return;
    }
    await faults.hit('after_target_recheck', {
      operation_id: current.operation_id,
    });
    if (closed) return;
    // 確かめ直しの間に取消・内容の変更があれば、状態版の照合で送出意図が拒否される。
    current = await view(current.operation_id);
    if (
      current === null ||
      current.state !== 'preparing' ||
      current.attempt_id !== attemptId
    )
      return;
    // 工程の仕組み（D3）: 保存した工程から次に行うことを決める。送出意図のある工程は再送しない（照合だけ）。
    const decision = nextStepDecision(
      OPERATION_KIND_RULES[intent.kind].steps,
      stepRecords(current),
    );
    if (decision.action !== 'dispatch') {
      log(
        `操作 ${current.operation_id} の工程は送出できません（${decision.action}）。`,
      );
      return;
    }
    const step = decision.step_id;
    // 確かめ直しの間に定期の掃除が始まった・失敗した場合も、送出意図を記録する前に止める。貸し出しは
    // 送信が終わるまで持つ（その間は掃除の本体が始まらない）。結果の保存は外部へ送らないので貸し出しの外。
    const release = await leaseSend(current.operation_id);
    if (release === null) return;
    const operationId = current.operation_id;
    let observation: Awaited<ReturnType<typeof send>>;
    try {
      const dispatched = await submit({
        ...base(current, intent.permission_revision),
        kind: 'operation.dispatch_intent',
        attempt_id: attemptId,
        reservation_id: null,
        observed_connection: {
          status: checked.status,
          access: checked.access,
          permission_revision: checked.permission_revision,
        },
        step: { step_id: step, step_kind: decision.step_kind },
      });
      if (
        dispatched.outcome !== 'durable' ||
        dispatched.dispatch_permit === null
      )
        return;
      await faults.hit('after_dispatch_intent_before_send', {
        operation_id: operationId,
        step_id: step,
      });
      // 停止の後・許可を使えないときは送らない（起動時の回復で unknown_held になり、自動では送らない）。
      if (closed || !store.consumeDispatchPermit(dispatched.dispatch_permit))
        return;
      observation = await send(writer, intent, {
        operation_id: operationId,
        attempt_id: attemptId,
        step_id: step,
      });
    } finally {
      release();
    }
    await faults.hit('before_result_save', {
      operation_id: operationId,
      step_id: step,
    });
    if (observation === 'not_executed')
      await recordNotExecuted(operationId, attemptId);
    else await recordObservation(operationId, attemptId, observation);
  };

  const runLocal = async (current: OperationView): Promise<void> => {
    if (
      current.state !== 'approved' ||
      current.operation_kind !== 'task.create'
    )
      return;
    const intent = await openIntent(current);
    const target = intent?.['target'] as Record<string, unknown> | undefined;
    const listId = target?.['list_id'];
    if (typeof listId !== 'string') return;
    // 用事の正本（題名・期限・本文）を、用事を所有者にして暗号化する（ADR 0051）。確定 intent は完了から 7 日で
    // 消えるので、用事の内容をそこに置かない。暗号文は書く前に復号して同じ内容に戻ることを確かめる。
    const content = taskContentFromIntent(intent);
    const key = content === null ? null : await loadKey();
    const unsealed = () =>
      log(
        `用事の内容を暗号化できず、登録を適用しませんでした（操作 ${current.operation_id}）。`,
      );
    if (content === null || key === null) {
      unsealed();
      return;
    }
    const taskId = randomUUID();
    const sealed = sealTaskContent(key, taskId, content);
    if (!sealed.ok) {
      unsealed();
      return;
    }
    const reopened = openTaskContent(key, taskId, {
      formatVersion: sealed.content.format_version,
      keyId: sealed.content.key_id,
      nonce: sealed.content.nonce,
      ciphertext: sealed.content.ciphertext,
      tag: sealed.content.tag,
    });
    if (!reopened.ok || !sameTaskContent(reopened.content, content)) {
      unsealed();
      return;
    }
    const outcome = await submit({
      ...base(current, String(intent?.['permission_revision'] ?? '0')),
      kind: 'operation.apply_local',
      attempt_id: randomUUID(),
      task_id: taskId,
      list_id: listId,
      content: sealed.content,
    });
    if (outcome.outcome !== 'durable')
      log(`用事の登録を適用できませんでした（操作 ${current.operation_id}）。`);
  };

  const run = async (
    operationId: string,
    afterApproval: boolean,
  ): Promise<void> => {
    if (afterApproval)
      await faults.hit('after_approval_save', { operation_id: operationId });
    if (closed) return;
    const current = await view(operationId);
    if (current === null) return;
    // 経路はコードの表で決める。表と保存した経路が食い違う操作は実行しない。
    if (
      !isOperationKind(current.operation_kind) ||
      OPERATION_KIND_RULES[current.operation_kind].route !==
        current.effect_route
    )
      return;
    if (current.effect_route === 'local_command') await runLocal(current);
    else await runRemote(current);
  };

  // 操作ごとの排他。最初の await より前に登録し、終わったら自分の登録だけを外す。
  const hold = (
    operationId: string,
    task: Promise<unknown>,
    reconcileCommandId: string | null,
  ): void => {
    const held: Held = {
      done: task.then(
        () => undefined,
        () => undefined,
      ),
      reconcileCommandId,
    };
    running.set(operationId, held);
    void held.done.then(() => {
      if (running.get(operationId) !== held) return;
      running.delete(operationId);
      // 排他の間に届いた開始を、ここで始める。
      const pending = pendingStarts.get(operationId);
      if (pending !== undefined) {
        pendingStarts.delete(operationId);
        launch(operationId, pending);
      }
    });
  };

  const launch = (operationId: string, afterApproval: boolean): void => {
    if (closed) return;
    if (running.has(operationId)) {
      // 実行・照合の最中に届いた開始（retry の保存の後など）は捨てずに預かる。始めた実行は状態を読み直すので、
      // 進める必要がなければ何もせずに終わる。
      pendingStarts.set(
        operationId,
        (pendingStarts.get(operationId) ?? false) || afterApproval,
      );
      return;
    }
    hold(
      operationId,
      run(operationId, afterApproval).catch((error: unknown) => {
        // 故障の注入・停止の後の DB worker の拒否など。状態は DB の正本に残る（起動時に再開・回復する）。
        log(
          `操作 ${operationId} の実行を中断しました: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }),
      null,
    );
  };

  // 同じ照合の要求を待つ上限。打ち切っても実行そのものの排他は外さない（HTTP の応答だけを返す）。
  const RECONCILE_WAIT_MS = 10_000;

  // 本人の照合。別の要求・通常の実行と重なれば、すぐに null（呼び出し側は 409）。同じ要求の照合が進んでいれば、
  // 期限つきで終わるのを待ってから null を返す（呼び出し側が保存済みの受付を読み直す。照合は 1 回）。
  const reconcile = async (
    operationId: string,
    expectedStateRevision: string,
    request: DeviceRequestRef,
    commandId: string,
  ): Promise<DbCommandOutcome | null> => {
    if (closed) return null;
    const busy = running.get(operationId);
    if (busy !== undefined) {
      if (busy.reconcileCommandId !== commandId) return null;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        busy.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RECONCILE_WAIT_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
      return null;
    }
    const task = reconcileWork(
      operationId,
      expectedStateRevision,
      request,
      commandId,
    );
    hold(operationId, task, commandId);
    return task;
  };

  const reconcileWork = async (
    operationId: string,
    expectedStateRevision: string,
    request: DeviceRequestRef,
    commandId: string,
  ): Promise<DbCommandOutcome | null> => {
    const current = await view(operationId);
    if (
      current === null ||
      current.attempt_id === null ||
      // 経路が受付を調べてから排他を取るまでに先行要求が完了した場合も、再び対象を読まない。
      // 呼び出し側が保存済みの受付を照会する（別の要求なら 409）。
      current.state_revision !== expectedStateRevision ||
      !['unknown_held', 'reconciling'].includes(current.state)
    )
      return null;
    const raw = await openIntent(current);
    const intent =
      raw === null ? null : remoteIntent(raw, current.operation_kind);
    if (intent === null) return null;
    const attemptId = current.attempt_id;
    const work = async (): Promise<DbCommandOutcome | null> => {
      if (current.state === 'unknown_held') {
        // 本人の照合の受付を記録して照合中へ。同じ要求の再送は保存済みの結果を返し、照合し直さない。
        const accepted = await record(
          current,
          attemptId,
          'reconciling',
          expectedStateRevision,
          null,
          request,
          commandId,
        );
        if (accepted.outcome !== 'durable' || accepted.replayed)
          return accepted;
        const observation = await lookup(intent);
        await recordObservation(operationId, attemptId, observation, true);
        return accepted;
      }
      // 照合中（X05 の取消の後など）: 参照で照合し、結果を本人の要求として記録する。
      const observation = await lookup(intent);
      const outcome = reconcileOutcome(observation);
      return record(
        current,
        attemptId,
        outcome.state,
        expectedStateRevision,
        observation.kind === 'found' ? observation.external_id : null,
        request,
        commandId,
      );
    };
    return work();
  };

  return {
    afterApproval: (operationId) => launch(operationId, true),
    start: (operationId) => launch(operationId, false),
    reconcile,
    async idle() {
      while (running.size > 0)
        await Promise.allSettled(
          [...running.values()].map((held) => held.done),
        );
    },
    close() {
      closed = true;
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    },
  };
}
