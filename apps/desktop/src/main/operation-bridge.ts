// デスクトップの main の発言・承認の経路（B04-05、ADR 0031。設計 01 承認画面の必須内容、07 §2〜§3、08 §3）。
//
// - 画面へ渡すのは参照（ref・preview_ref）だけ。操作 ID・内容版・hash・preview_id・会話 ID は main の中に持ち、
//   画面へ出さない（画面から送られた ref を main が解決する。解決できなければ entry_not_found）。
// - 承認は main の OS の確認ダイアログで 1 回だけ行う（本人の判断 2026-10-22 D2）。ダイアログに出す値は、main が
//   中枢の preview から作った値で、画面から受け取らない。確認の前後で操作の内容・状態が変わっていれば送らない。
// - 結果が分からない命令（承認・取消）は、操作の状態が進むまで同じ参照では送らせない。自動では送り直さない
//   （照合は参照だけで、再送ではない。ADR 0030 の D4）。
// - 表示の権限の世代（ロック・切断）をまたいだ参照・preview は reset で捨てる。
// Electron に依存しない（node:test で試験する）。
import type {
  DesktopOperationEntry,
  DesktopOperationPreview,
  DesktopTurnResult,
  OperationIntent,
  OperationPreview,
  OperationSnapshot,
  TurnResponse,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';

// 承認の前の OS の確認ダイアログに出す値（main が中枢の preview から作る。画面からは受け取らない）。
export interface OperationConfirmRequest {
  readonly action: 'approve_operation';
  readonly operationKind: DesktopOperationPreview['operation_kind'];
  readonly service: DesktopOperationPreview['service'];
  readonly target: string | null;
  readonly fields: DesktopOperationPreview['fields'];
}

export type OperationConfirmResult =
  { readonly scope: string } | DesktopIpcRejectReason;

export interface OperationHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  readonly newRef: () => string;
  // 本人の確認（OS の確認ダイアログ）。世代・接続範囲の照合は呼び出し側が行う。
  readonly confirm: (
    request: OperationConfirmRequest,
  ) => Promise<OperationConfirmResult>;
  // 結果が分からなかった・保留が解けたなど、画面に出す値が変わった（接続の状態の通知を起こす）。
  readonly changed: () => void;
  readonly log: (code: string) => void;
}

export type BridgeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DesktopIpcRejectReason };

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

interface RefRecord {
  readonly ref: string;
  // 一度でもスナップショットに現れたか（現れてから消えた参照だけを捨てる。発言の直後はまだ現れない）。
  seen: boolean;
  // 最初に見た順（新しい操作を先に出す）。
  readonly order: number;
}

interface PreviewRecord {
  readonly ref: string;
  readonly operationId: string;
  readonly previewId: string;
  readonly contentVersion: string;
  readonly contentHash: string;
  readonly stateRevision: string;
  readonly scope: string;
  readonly display: OperationConfirmRequest;
}

const MAX_PREVIEWS = 20;
const MAX_UNSEEN_REFS = 200;

const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export class OperationBridge {
  readonly #host: OperationHost;
  readonly #refs = new Map<string, RefRecord>();
  readonly #previews = new Map<string, PreviewRecord>();
  // 結果が分からなかった命令: 操作 ID → 保留を付けたときの state_revision。これより新しい版が来たら解く。
  readonly #held = new Map<string, string>();
  #order = 0;
  // 会話（接続範囲ごとに 1 つ。発言のたびに作らない）。
  #session: { readonly scope: string; readonly sessionId: string } | null =
    null;

  constructor(host: OperationHost) {
    this.#host = host;
  }

  // 表示の権限の世代が進んだ（ロック・切断）: 参照・preview・保留・会話を捨てる。
  reset(): void {
    this.#refs.clear();
    this.#previews.clear();
    this.#held.clear();
    this.#session = null;
  }

  #refOf(operationId: string, seen: boolean): string {
    const found = this.#refs.get(operationId);
    if (found !== undefined) {
      if (seen) found.seen = true;
      return found.ref;
    }
    const ref = this.#host.newRef();
    this.#refs.set(operationId, { ref, seen, order: this.#order++ });
    if (!seen) {
      const unseen = [...this.#refs.entries()].filter(([, r]) => !r.seen);
      for (const [id] of unseen.slice(0, unseen.length - MAX_UNSEEN_REFS))
        this.#refs.delete(id);
    }
    return ref;
  }

  // 画面に出す操作の一覧（新しい操作が先）。スナップショットに現れて消えた操作の参照・保留・preview は捨てる。
  entries(operations: readonly OperationSnapshot[]): DesktopOperationEntry[] {
    const present = new Set(operations.map((op) => op.operation_id));
    for (const [id, record] of this.#refs)
      if (record.seen && !present.has(id)) {
        this.#refs.delete(id);
        this.#held.delete(id);
        this.#dropPreviews(id);
      }
    for (const [id, revision] of this.#held) {
      const current = operations.find((op) => op.operation_id === id);
      if (current !== undefined && newer(current.state_revision, revision))
        this.#held.delete(id);
    }
    const entries = operations.map((op) => {
      this.#refOf(op.operation_id, true);
      const record = this.#refs.get(op.operation_id) as RefRecord;
      const entry: DesktopOperationEntry = {
        ref: record.ref,
        operation_kind: op.operation_kind,
        state: op.state,
        approval_state: op.approval_state,
        allowed_actions: [...op.allowed_actions],
        result: op.result === null ? null : op.result.status,
        state_revision: op.state_revision,
        delivery_unknown: this.#held.has(op.operation_id),
      };
      return { entry, order: record.order };
    });
    return entries.sort((a, b) => b.order - a.order).map((item) => item.entry);
  }

  #dropPreviews(operationId: string): void {
    for (const [ref, preview] of this.#previews)
      if (preview.operationId === operationId) this.#previews.delete(ref);
  }

  #operationOf(
    ref: string,
    connection: ClientConnection,
  ): { id: string; snapshot: OperationSnapshot } | null {
    for (const [id, record] of this.#refs)
      if (record.ref === ref) {
        const snapshot = connection.state.operations.find(
          (op) => op.operation_id === id,
        );
        return snapshot === undefined ? null : { id, snapshot };
      }
    return null;
  }

  // --- 発言 ---

  async submitTurn(text: string): Promise<BridgeOutcome<DesktopTurnResult>> {
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    let session = this.#session;
    if (session === null || session.scope !== scope) {
      const created = await connection.request({
        method: 'POST',
        path: '/v1/sessions',
        body: { storage_mode: 'normal' },
        scoped: true,
        expectedScopeId: scope,
      });
      // 会話の作成は発言の前なので、結果が分からなくても発言は送っていない（もう一度送れる）。
      if (created.kind !== 'response') return fail('not_connected');
      if (
        created.status !== 201 ||
        !this.#host.contract.valid('SessionReceipt', created.body)
      )
        return fail('core_rejected');
      const body = created.body as { session_id: string };
      session = { scope, sessionId: body.session_id };
      this.#session = session;
    }
    const outcome = await connection.request({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(session.sessionId)}/turns`,
      body: { text, input_kind: 'text' },
      scoped: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 発言は読み取り・聞き返し・承認待ちの操作の作成だけで外部変更ではない。結果が分からなければ、
    // 自動では送り直さず、本人がもう一度送る（同じ発言の再送は新しい受付になる）。
    if (outcome.kind === 'unknown') return fail('outcome_unknown');
    if (
      outcome.status !== 200 ||
      !this.#host.contract.valid('TurnResponse', outcome.body)
    ) {
      // 会話が中枢にない（作り直せば進める）。
      if (outcome.status === 409) this.#session = null;
      return fail('core_rejected');
    }
    return { ok: true, value: this.#turnResult(outcome.body as TurnResponse) };
  }

  #turnResult(turn: TurnResponse): DesktopTurnResult {
    const view = turn.result_view;
    if (view === null)
      return { status: turn.status, reply_text: turn.reply_text, result: null };
    const count = (kind: string) =>
      view.item_refs.filter((item) => item.kind === kind).length;
    const operation = view.item_refs.find((item) => item.kind === 'operation');
    return {
      status: turn.status,
      reply_text: turn.reply_text,
      result: {
        kind: view.kind,
        status: view.status,
        intent: view.intent,
        event_count: count('calendar_event'),
        overlap_count: count('calendar_overlap'),
        more_count: view.more_count,
        operation_ref:
          operation === undefined ? null : this.#refOf(operation.id, false),
      },
    };
  }

  // --- 承認表示の準備 ---

  async preview(ref: string): Promise<BridgeOutcome<DesktopOperationPreview>> {
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const target = this.#operationOf(ref, connection);
    if (target === null || this.#held.has(target.id))
      return fail('entry_not_found');
    if (target.snapshot.state !== 'awaiting_approval')
      return fail('preview_stale');
    const outcome = await connection.request({
      method: 'POST',
      path: `/v1/operations/${encodeURIComponent(target.id)}/preview`,
      body: {},
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 準備は外部変更ではない。分からなければ、もう一度押せる。
    if (outcome.kind === 'unknown') return fail('not_connected');
    if (
      outcome.status !== 200 ||
      !this.#host.contract.valid('OperationPreview', outcome.body)
    )
      return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
    const preview = outcome.body as OperationPreview;
    const previewRef = this.#host.newRef();
    const view = previewView(preview.intent, previewRef);
    this.#dropPreviews(target.id);
    this.#previews.set(previewRef, {
      ref: previewRef,
      operationId: target.id,
      previewId: preview.preview_id,
      contentVersion: preview.intent.content_version,
      contentHash: preview.content_hash,
      stateRevision: preview.state_revision,
      scope,
      display: {
        action: 'approve_operation',
        operationKind: view.operation_kind,
        service: view.service,
        target: view.target,
        fields: view.fields,
      },
    });
    while (this.#previews.size > MAX_PREVIEWS) {
      const oldest = this.#previews.keys().next();
      if (oldest.done === true) break;
      this.#previews.delete(oldest.value);
    }
    return { ok: true, value: view };
  }

  // --- 承認 ---

  // 確認した内容・状態が今も同じか（版が進んだ・hash が違う・承認待ちでなくなった・結果不明の保留）。
  #fresh(
    record: PreviewRecord,
    connection: ClientConnection,
  ): DesktopIpcRejectReason | null {
    const snapshot = connection.state.operations.find(
      (op) => op.operation_id === record.operationId,
    );
    if (snapshot === undefined) return 'entry_not_found';
    if (this.#held.has(record.operationId)) return 'entry_not_found';
    if (
      snapshot.state !== 'awaiting_approval' ||
      snapshot.content_hash !== record.contentHash ||
      snapshot.content_version !== record.contentVersion ||
      newer(snapshot.state_revision, record.stateRevision)
    )
      return 'preview_stale';
    return null;
  }

  async approve(
    previewRef: string,
  ): Promise<BridgeOutcome<'accepted' | 'durable'>> {
    const record = this.#previews.get(previewRef);
    const connection = this.#host.connection();
    if (record === undefined) return fail('entry_not_found');
    if (connection === null) return fail('not_connected');
    const before = this.#fresh(record, connection);
    if (before !== null) return fail(before);
    // 本人の確認（OS の確認ダイアログ）。承認はここで 1 回だけ。やめる・閉じる・前面でなくなったときは送らない。
    const confirmed = await this.#host.confirm(record.display);
    if (typeof confirmed === 'string') return fail(confirmed);
    // 確認している間に内容・状態が変わっていたら送らない（確認した内容と違う内容を承認させない）。
    const live = this.#host.connection();
    if (live === null || live.state.commandScopeId !== record.scope)
      return fail('not_connected');
    const after = this.#fresh(record, live);
    if (after !== null) return fail(after);
    // 1 回の確認で使えるのは 1 回だけ（再度の承認は、内容を確かめ直して新しい確認を出す）。
    this.#previews.delete(previewRef);
    const outcome = await live.send({
      kind: 'approve',
      operationId: record.operationId,
      previewId: record.previewId,
      contentVersion: record.contentVersion,
      contentHash: record.contentHash,
      expectedStateRevision: record.stateRevision,
      commandScopeId: record.scope,
    });
    return this.#sent(outcome, record.operationId, record.stateRevision);
  }

  #sent(
    outcome: Awaited<ReturnType<ClientConnection['send']>>,
    operationId: string,
    revision: string,
  ): BridgeOutcome<'accepted' | 'durable'> {
    switch (outcome.kind) {
      case 'accepted':
        return { ok: true, value: outcome.receipt.status };
      case 'not_sent':
        return fail(
          outcome.reason === 'device_locked'
            ? 'device_locked'
            : 'not_connected',
        );
      case 'rejected':
        return fail('core_rejected');
      case 'unknown':
        // 届いたか分からない。操作の状態が進むまで、同じ命令を送らせない（自動では送り直さない）。
        this.#held.set(operationId, revision);
        this.#host.log('operation_command_outcome_unknown');
        this.#host.changed();
        return fail('outcome_unknown');
    }
  }

  // --- 取消・照合 ---

  async command(
    kind: 'cancel' | 'reconcile',
    ref: string,
  ): Promise<BridgeOutcome<'accepted' | 'durable'>> {
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const target = this.#operationOf(ref, connection);
    if (target === null || this.#held.has(target.id))
      return fail('entry_not_found');
    const outcome = await connection.send({
      kind,
      operationId: target.id,
      expectedStateRevision: target.snapshot.state_revision,
      commandScopeId: scope,
    });
    // 照合は参照だけで再送ではない。結果が分からなくても保留にせず、もう一度押せる。
    if (kind === 'reconcile' && outcome.kind === 'unknown')
      return fail('outcome_unknown');
    return this.#sent(outcome, target.id, target.snapshot.state_revision);
  }
}

// 中枢の確定 intent から、承認画面に出す値を作る（preview_id・hash・アカウント ID は含めない）。
export function previewView(
  intent: OperationIntent,
  previewRef: string,
): DesktopOperationPreview {
  const fields: DesktopOperationPreview['fields'] = [];
  const add = (
    field: DesktopOperationPreview['fields'][number]['field'],
    values: readonly string[],
  ) => {
    if (values.length > 0) fields.push({ field, values: [...values] });
  };
  const action = intent.action;
  switch (action.kind) {
    case 'mail.labels.change':
      add('labels_add', action.add);
      add('labels_remove', action.remove);
      break;
    case 'mail.draft.create':
      add('draft_to', action.to);
      add('draft_cc', action.cc);
      add('draft_subject', [action.subject]);
      add('draft_body', [action.body]);
      break;
    case 'task.create':
      add('task_title', [action.title]);
      add('task_due', action.due === null ? [] : [action.due]);
      add('task_body', action.body === null ? [] : [action.body]);
      break;
  }
  return {
    preview_ref: previewRef,
    operation_kind: action.kind,
    service: 'provider' in intent ? intent.provider : 'buddy',
    target:
      'list_id' in intent.target
        ? intent.target.list_id
        : intent.target.remote_id,
    fields,
  };
}
