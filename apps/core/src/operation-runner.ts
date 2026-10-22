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
  canAutoReconcile,
  isOperationKind,
  reconcileOutcome,
  stepId,
} from '@buddy/domain';
import type { ReconcileObservation } from '@buddy/domain';
import { openOperationIntent, sealOperationIntent } from '@buddy/storage';
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
import type {
  FaultHook,
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

// ラベル変更の確定 intent のうち、実行に使う項目。
interface LabelIntent {
  readonly raw: Record<string, unknown>;
  readonly account_id: string;
  readonly permission_revision: string;
  readonly remote_id: string;
  readonly source_revision: string;
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

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

export function createOperationRunner(
  options: OperationRunnerOptions,
): OperationRunner {
  const { store, faults, log } = options;
  const running = new Map<string, Promise<void>>();
  let closed = false;

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

  const labelIntent = (raw: Record<string, unknown>): LabelIntent | null => {
    const target = raw['target'] as Record<string, unknown> | undefined;
    const action = raw['action'] as Record<string, unknown> | undefined;
    const add = strings(action?.['add']);
    const remove = strings(action?.['remove']);
    if (
      action?.['kind'] !== 'mail.labels.change' ||
      typeof raw['account_id'] !== 'string' ||
      typeof raw['permission_revision'] !== 'string' ||
      typeof target?.['remote_id'] !== 'string' ||
      typeof target['source_revision'] !== 'string' ||
      add === null ||
      remove === null
    )
      return null;
    return {
      raw,
      account_id: raw['account_id'],
      permission_revision: raw['permission_revision'],
      remote_id: target['remote_id'],
      source_revision: target['source_revision'],
      add,
      remove,
    };
  };

  // アダプターで対象と許可を確かめ直す（送出の直前の接続の照合を含む）。読み取りだけ。
  const recheck = async (intent: LabelIntent): Promise<Recheck> => {
    const provider = options.provider;
    if (provider === null) return { kind: 'blocked', reason: 'no_provider' };
    try {
      const connection = await provider.connection();
      if (connection === null || connection.account_id !== intent.account_id)
        return { kind: 'blocked', reason: 'connection_missing' };
      const permission = await provider.readPermission(intent.account_id);
      if (permission === null || permission.account_id !== intent.account_id)
        return { kind: 'blocked', reason: 'permission_unreadable' };
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
        };
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
  const lookup = async (intent: LabelIntent): Promise<ReconcileObservation> => {
    if (options.provider === null) return { kind: 'unreadable' };
    try {
      return labelChangeObserved(
        await options.provider.readTarget(intent.remote_id),
        intent,
      );
    } catch {
      return { kind: 'unreadable' };
    }
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
  const recordObservation = async (
    operationId: string,
    attemptId: string,
    observation: ReconcileObservation,
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
    if (current.cancel_requested) {
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
    intent: LabelIntent,
    change: Extract<Recheck, { kind: 'changed' }>,
  ): Promise<void> => {
    const next = String(BigInt(current.current_content_version) + 1n);
    const content = {
      ...intent.raw,
      content_version: next,
      permission_revision: change.permission_revision,
      target: {
        ...(intent.raw['target'] as Record<string, unknown>),
        source_revision: change.source_revision,
      },
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

  const runRemote = async (initial: OperationView): Promise<void> => {
    const writer = options.writer;
    if (writer === null || options.provider === null) return;
    if (initial.operation_kind !== 'mail.labels.change') {
      // 下書き（目印での照合）の実行は、下書きを作る発言（B04 の範囲外）と一緒に足す。
      log(`操作 ${initial.operation_id} の種類はまだ実行できません。`);
      return;
    }
    const raw = await openIntent(initial);
    const intent = raw === null ? null : labelIntent(raw);
    if (intent === null) return;
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
    });
    if (dispatched.outcome !== 'durable' || dispatched.dispatch_permit === null)
      return;
    const operationId = current.operation_id;
    const step = stepId(0, 'apply_labels');
    await faults.hit('after_dispatch_intent_before_send', {
      operation_id: operationId,
      step_id: step,
    });
    // 停止の後・許可を使えないときは送らない（起動時の回復で unknown_held になり、自動では送らない）。
    if (closed || !store.consumeDispatchPermit(dispatched.dispatch_permit))
      return;
    const sent = await writer.changeLabels(
      { operation_id: operationId, attempt_id: attemptId, step_id: step },
      { remote_id: intent.remote_id, add: intent.add, remove: intent.remove },
    );
    let observation: ReconcileObservation | 'not_executed';
    if (sent.kind === 'applied')
      observation = { kind: 'found', external_id: sent.value.remote_id };
    else if (sent.kind === 'rejected' || sent.kind === 'not_sent')
      observation = 'not_executed';
    // 応答を失った: 直後に 1 回だけ参照で照合する（D4）。
    else
      observation = canAutoReconcile(0)
        ? await lookup(intent)
        : { kind: 'unreadable' };
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
    const outcome = await submit({
      ...base(current, String(intent?.['permission_revision'] ?? '0')),
      kind: 'operation.apply_local',
      attempt_id: randomUUID(),
      task_id: randomUUID(),
      list_id: listId,
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

  const launch = (operationId: string, afterApproval: boolean): void => {
    if (closed || running.has(operationId)) return;
    const task = run(operationId, afterApproval)
      .catch((error: unknown) => {
        // 故障の注入・停止の後の DB worker の拒否など。状態は DB の正本に残る（起動時に再開・回復する）。
        log(
          `操作 ${operationId} の実行を中断しました: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      })
      .finally(() => {
        running.delete(operationId);
      });
    running.set(operationId, task);
  };

  const reconcile = async (
    operationId: string,
    expectedStateRevision: string,
    request: DeviceRequestRef,
    commandId: string,
  ): Promise<DbCommandOutcome | null> => {
    if (closed || running.has(operationId)) return null;
    const current = await view(operationId);
    if (
      current === null ||
      current.attempt_id === null ||
      !['unknown_held', 'reconciling'].includes(current.state)
    )
      return null;
    const raw = await openIntent(current);
    const intent = raw === null ? null : labelIntent(raw);
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
        await recordObservation(operationId, attemptId, observation);
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
    const task = work();
    running.set(
      operationId,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await task;
    } finally {
      running.delete(operationId);
    }
  };

  return {
    afterApproval: (operationId) => launch(operationId, true),
    start: (operationId) => launch(operationId, false),
    reconcile,
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
    close() {
      closed = true;
    },
  };
}
