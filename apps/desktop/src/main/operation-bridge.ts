// デスクトップの main の発言・承認の経路（B04-05、ADR 0031。設計 01 承認画面の必須内容、07 §2〜§3、08 §3）。
//
// - 画面へ渡すのは参照（ref・preview_ref）だけ。操作 ID・内容版・hash・preview_id・会話 ID は main の中に持ち、
//   画面へ出さない（画面から送られた ref を main が解決する。解決できなければ entry_not_found）。
// - 承認・取消・再試行は main の OS の確認ダイアログで 1 回だけ確かめる（本人の判断 2026-10-22 D2 と、取消・再試行への
//   適用）。ダイアログに出す値は main が中枢から読んだ値で、画面から受け取らない。確認は対象・状態・世代に結び付け、
//   確認の前後で操作の内容・状態が変わっていれば、また、確認の最中に入出力が止まっていれば（停止・io_epoch）送らない。
// - 結果が分からない命令（承認・取消・再試行）は、操作の状態が進むか、本人が読み取りだけで状態を確かめる（check）まで、
//   同じ参照では送らせない。自動では送り直さない（照合は参照だけで、再送ではない。ADR 0030 の D4）。
// - 世代（ロック・切断）: reset で参照・preview・保留・会話・内容を捨て、非同期の処理は各 await の後・内部の状態を変える前・
//   次を送る前に世代を照合する（またいだ処理は何も送らず、何も変えない）。
// - 承認表示の準備（preview）は同じ操作について直列に行い、要求の番号が最新のものだけが有効（古い要求は発行しない）。
// - 一覧の行の見出しにする内容（題名・件名）は、承認表示の準備で読んだ値を main の中にだけ持つ（イベント・
//   スナップショットには本文を入れない）。承認待ちの操作を見つけたら、main が自分で準備して読む。
// Electron に依存しない（node:test で試験する）。
import type {
  DesktopOperationEntry,
  DesktopOperationPreview,
  DesktopTurnResult,
  OperationIntent,
  OperationDisplay,
  OperationPreview,
  OperationSnapshot,
  TurnResponse,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';

// 承認の前の OS の確認ダイアログに出す値（main が中枢の preview から作る。画面からは受け取らない）。
export interface ApproveConfirmRequest {
  readonly action: 'approve_operation';
  readonly operationKind: DesktopOperationPreview['operation_kind'];
  readonly service: DesktopOperationPreview['service'];
  readonly target: string | null;
  readonly accountLabel: string | null;
  readonly targetDetail: DesktopOperationPreview['target_detail'];
  readonly fields: DesktopOperationPreview['fields'];
}

// 取消・再試行の前の OS の確認ダイアログに出す値（対象の内容と今の状態。main が持つ値）。
export interface CommandConfirmRequest {
  readonly action: 'cancel_operation' | 'retry_operation';
  readonly operationKind: DesktopOperationPreview['operation_kind'];
  readonly headline: string | null;
  readonly detail: string | null;
  readonly state: OperationSnapshot['state'];
}

export type OperationConfirmRequest =
  ApproveConfirmRequest | CommandConfirmRequest;

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
  // 端末の今の入出力の状態（送る直前に確かめる）。permitted は停止していないこと、epoch は io_epoch。
  readonly io: () => { readonly permitted: boolean; readonly epoch: string };
  // 結果が分からなかった・保留が解けた・内容を読んだなど、画面に出す値が変わった（接続の状態の通知を起こす）。
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
  readonly approvable: boolean;
  readonly display: ApproveConfirmRequest;
}

// 一覧の行の見出しにする内容（main の中にだけ持つ）。
interface ContentRecord {
  readonly key: string;
  // 外部変更で、口座と対象のメールを確認できているか（できていなければ取消・再試行の確認も出さない）。
  readonly identified: boolean;
  readonly headline: string | null;
  readonly detail: string | null;
}

// 結果が分からなかった命令（保留）。送った命令の種類と、そのときの状態版を持つ。
interface HeldRecord {
  readonly revision: string;
  readonly kind: 'approve' | 'cancel' | 'retry';
}

const MAX_PREVIEWS = 20;
const MAX_UNSEEN_REFS = 200;
const MAX_FETCH = 30;

const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export class OperationBridge {
  readonly #host: OperationHost;
  readonly #refs = new Map<string, RefRecord>();
  readonly #previews = new Map<string, PreviewRecord>();
  readonly #held = new Map<string, HeldRecord>();
  readonly #content = new Map<string, ContentRecord>();
  // 「状態を確かめる」で読み取った今の状態（クライアントの状態がまだ追いついていない間、一覧に反映する）。
  readonly #observed = new Map<string, OperationSnapshot>();
  // 内容を読もうとした (操作 ID → 状態版)。同じ状態版では読み直さない（失敗を繰り返さない）。
  readonly #prefetched = new Map<string, string>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #previewSeq = new Map<string, number>();
  #order = 0;
  // 表示の権限の世代。reset で進める。
  #gen = 0;
  // 会話（接続範囲ごとに 1 つ。発言のたびに作らない）。
  #session: { readonly scope: string; readonly sessionId: string } | null =
    null;

  constructor(host: OperationHost) {
    this.#host = host;
  }

  // 表示の権限の世代が進んだ（ロック・切断）: 参照・preview・保留・会話・内容を捨てる。進行中の非同期の処理は、
  // 世代の照合で何も送らず何も変えずに終わる。
  reset(): void {
    this.#gen += 1;
    this.#refs.clear();
    this.#previews.clear();
    this.#held.clear();
    this.#content.clear();
    this.#observed.clear();
    this.#prefetched.clear();
    this.#queues.clear();
    this.#previewSeq.clear();
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

  // 画面に出す操作の一覧（新しい操作が先）。スナップショットに現れて消えた操作の参照・保留・内容・preview は捨てる。
  // 承認待ちの操作の内容を持っていなければ、main が準備して読む（読めたら画面へ知らせる）。
  entries(operations: readonly OperationSnapshot[]): DesktopOperationEntry[] {
    const present = new Set(operations.map((op) => op.operation_id));
    for (const [id, record] of this.#refs)
      if (record.seen && !present.has(id)) {
        this.#refs.delete(id);
        this.#held.delete(id);
        this.#content.delete(id);
        this.#observed.delete(id);
        this.#prefetched.delete(id);
        this.#previewSeq.delete(id);
        this.#dropPreviews(id);
      }
    const merged = operations.map((op) => this.#current(op));
    for (const [id, held] of this.#held) {
      const current = merged.find((op) => op.operation_id === id);
      if (current !== undefined && newer(current.state_revision, held.revision))
        this.#held.delete(id);
    }
    const entries = merged.map((op) => {
      this.#refOf(op.operation_id, true);
      const record = this.#refs.get(op.operation_id) as RefRecord;
      const content = this.#contentFor(op);
      const entry: DesktopOperationEntry = {
        ref: record.ref,
        operation_kind: op.operation_kind,
        state: op.state,
        approval_state: op.approval_state,
        allowed_actions: [...op.allowed_actions],
        result: op.result === null ? null : op.result.status,
        state_revision: op.state_revision,
        delivery_unknown: this.#held.has(op.operation_id),
        headline: content?.headline ?? null,
        detail: content?.detail ?? null,
      };
      return { entry, order: record.order };
    });
    entries.sort((a, b) => b.order - a.order);
    // 新しい操作から、内容（見出し）を持っていないものを読む（多いときは新しい 30 件まで）。
    for (const item of entries.slice(0, MAX_FETCH)) {
      const op = merged.find(
        (m) => this.#refs.get(m.operation_id)?.ref === item.entry.ref,
      );
      if (op !== undefined) this.#maybeFetch(op);
    }
    return entries.map((item) => item.entry);
  }

  // クライアントの状態と、読み取りで確かめた状態のうち、状態版が新しい方（クライアントが追いついたら読み取りは捨てる）。
  #current(op: OperationSnapshot): OperationSnapshot {
    const observed = this.#observed.get(op.operation_id);
    if (observed === undefined) return op;
    if (newer(observed.state_revision, op.state_revision)) return observed;
    this.#observed.delete(op.operation_id);
    return op;
  }

  // 今の内容版・hash と一致する内容（見出し）だけを使う。別端末の改訂などで古くなった内容は使わない。
  #contentFor(op: OperationSnapshot): ContentRecord | undefined {
    const record = this.#content.get(op.operation_id);
    return record?.key === `${op.content_version}:${op.content_hash}`
      ? record
      : undefined;
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
        const found = connection.state.operations.find(
          (op) => op.operation_id === id,
        );
        return found === undefined
          ? null
          : { id, snapshot: this.#current(found) };
      }
    return null;
  }

  // 同じ操作についての要求を直列に行う。前の要求が失敗しても次を進める。
  #serial<T>(operationId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(operationId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(operationId, tail);
    void tail.then(() => {
      if (this.#queues.get(operationId) === tail)
        this.#queues.delete(operationId);
    });
    return next;
  }

  // --- 発言 ---

  async submitTurn(text: string): Promise<BridgeOutcome<DesktopTurnResult>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const io = this.#host.io();
    if (!io.permitted) return fail('input_stopped');
    let session = this.#session;
    if (session === null || session.scope !== scope) {
      const created = await connection.request({
        method: 'POST',
        path: '/v1/sessions',
        body: { storage_mode: 'normal' },
        scoped: true,
        expectedScopeId: scope,
      });
      // 世代をまたいだ（ロック・切断）: 会話を戻さず、発言も送らない。
      if (gen !== this.#gen) return fail('not_connected');
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
      // 会話を作っている間に停止した: 発言を送らない。
      const after = this.#host.io();
      if (!after.permitted || after.epoch !== io.epoch)
        return fail('input_stopped');
    }
    const outcome = await connection.request({
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(session.sessionId)}/turns`,
      body: { text, input_kind: 'text' },
      scoped: true,
      expectedScopeId: scope,
    });
    // 送る前に送れなかった（未送信）だけを not_connected にする。送った後に世代が変わったときは、結果を画面へ返さず、
    // 結果不明にする（未送信と答えると、本人も試験も同じ発言を別の要求として送り直し、二重に届く）。
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (gen !== this.#gen) return fail('outcome_unknown');
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

  // 流れへの発言の結果（StreamTurnResponse）も、会話への発言と同じ表示用の値にする（UI-03、ADR 0032）。
  streamTurnResult(
    turn: Pick<
      TurnResponse,
      'status' | 'reply_text' | 'result_view' | 'session_control'
    >,
  ): DesktopTurnResult {
    return this.#turnResult(turn);
  }

  #turnResult(
    turn: Pick<
      TurnResponse,
      'status' | 'reply_text' | 'result_view' | 'session_control'
    >,
  ): DesktopTurnResult {
    const view = turn.result_view;
    // 会話の操作（照合表に当たった発言。B05-05）は、操作の名前だけを画面・main の音声の制御へ渡す。
    const control =
      turn.session_control == null
        ? {}
        : { session_control: turn.session_control };
    if (view === null)
      return {
        status: turn.status,
        reply_text: turn.reply_text,
        result: null,
        ...control,
      };
    const count = (kind: string) =>
      view.item_refs.filter((item) => item.kind === kind).length;
    const operation = view.item_refs.find((item) => item.kind === 'operation');
    return {
      status: turn.status,
      reply_text: turn.reply_text,
      ...control,
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

  // 操作の内容（見出し）を持っていなければ、内容の表示用の読み取り（POST /v1/operations/{id}/display）で読む。
  // 読み取りだけで preview は発行しないので、表示中の確認を失効させない。同じ状態版では 1 回だけ。
  #maybeFetch(op: OperationSnapshot): void {
    if (this.#held.has(op.operation_id)) return;
    const key = `${op.content_version}:${op.content_hash}`;
    if (this.#content.get(op.operation_id)?.key === key) return;
    if (this.#prefetched.get(op.operation_id) === `${key}:${op.state_revision}`)
      return;
    this.#prefetched.set(op.operation_id, `${key}:${op.state_revision}`);
    const gen = this.#gen;
    void this.#serial(op.operation_id, async () => {
      if (gen !== this.#gen) return;
      if (this.#content.get(op.operation_id)?.key === key) return;
      await this.#fetchDisplay(op.operation_id, gen);
    }).catch(() => undefined);
  }

  // 内容の表示用の読み取り。承認待ち以外の操作（取消・再試行ができる状態）も読める。呼び出しは #serial の中だけ。
  async #fetchDisplay(operationId: string, gen: number): Promise<boolean> {
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return false;
    const outcome = await connection.request({
      method: 'POST',
      path: `/v1/operations/${encodeURIComponent(operationId)}/display`,
      body: {},
      scoped: true,
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return false;
    if (
      outcome.kind !== 'response' ||
      outcome.status !== 200 ||
      !this.#host.contract.valid('OperationDisplay', outcome.body)
    )
      return false;
    const shown = outcome.body as OperationDisplay;
    const summary = contentOf(shown.intent, shown.display);
    this.#content.set(operationId, {
      key: `${shown.content_version}:${shown.content_hash}`,
      identified: identifiedOf(shown.intent, shown.display),
      headline: summary.headline,
      detail: summary.detail,
    });
    this.#host.changed();
    return true;
  }

  // 準備して読み、内容と preview の記録を作る。呼び出しは #serial の中だけ。
  async #issue(
    operationId: string,
    gen: number,
  ): Promise<BridgeOutcome<DesktopOperationPreview>> {
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const outcome = await connection.request({
      method: 'POST',
      path: `/v1/operations/${encodeURIComponent(operationId)}/preview`,
      body: {},
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return fail('not_connected');
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
    const view = previewView(preview.intent, previewRef, preview.display);
    this.#remember(operationId, previewRef, preview, view, scope);
    const summary = contentOf(preview.intent, preview.display);
    this.#content.set(operationId, {
      key: `${preview.intent.content_version}:${preview.content_hash}`,
      identified: view.approvable,
      headline: summary.headline,
      detail: summary.detail,
    });
    this.#host.changed();
    return { ok: true, value: view };
  }

  // 承認用の preview の記録（上限 MAX_PREVIEWS。見出し用の読み取りとは分ける）。
  #remember(
    operationId: string,
    previewRef: string,
    preview: OperationPreview,
    view: DesktopOperationPreview,
    scope: string,
  ): void {
    // 同じ操作の前の確認は捨てる（中枢も古い preview を失効させる）。
    this.#dropPreviews(operationId);
    this.#previews.set(previewRef, {
      ref: previewRef,
      operationId,
      previewId: preview.preview_id,
      contentVersion: preview.intent.content_version,
      contentHash: preview.content_hash,
      stateRevision: preview.state_revision,
      scope,
      approvable: view.approvable,
      display: {
        action: 'approve_operation',
        operationKind: view.operation_kind,
        service: view.service,
        target: view.target,
        accountLabel: view.account_label,
        targetDetail: view.target_detail,
        fields: view.fields,
      },
    });
    while (this.#previews.size > MAX_PREVIEWS) {
      const oldest = this.#previews.keys().next();
      if (oldest.done === true) break;
      this.#previews.delete(oldest.value);
    }
  }

  async preview(ref: string): Promise<BridgeOutcome<DesktopOperationPreview>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    if (connection === null) return fail('not_connected');
    const target = this.#operationOf(ref, connection);
    if (target === null || this.#held.has(target.id))
      return fail('entry_not_found');
    if (target.snapshot.state !== 'awaiting_approval')
      return fail('preview_stale');
    // 要求の番号: 同じ操作の後の要求が来ていたら、前の要求は発行しない（逆順の応答で新しい確認を失効させない）。
    const seq = (this.#previewSeq.get(target.id) ?? 0) + 1;
    this.#previewSeq.set(target.id, seq);
    return this.#serial(target.id, async () => {
      if (gen !== this.#gen) return fail('not_connected');
      if (this.#previewSeq.get(target.id) !== seq) return fail('preview_stale');
      return this.#issue(target.id, gen);
    });
  }

  // --- 承認 ---

  // 確認した内容・状態が今も同じか（版が進んだ・hash が違う・承認待ちでなくなった・結果不明の保留）。
  #fresh(
    record: PreviewRecord,
    connection: ClientConnection,
  ): DesktopIpcRejectReason | null {
    const raw = connection.state.operations.find(
      (op) => op.operation_id === record.operationId,
    );
    if (raw === undefined) return 'entry_not_found';
    const snapshot = this.#current(raw);
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

  // 確認の後に送ってよいか: 世代・接続範囲・（必要なら）停止していないこと・io_epoch が確認を出したときと同じ。
  #stillAllowed(
    gen: number,
    scope: string,
    io: { readonly permitted: boolean; readonly epoch: string } | null,
  ): DesktopIpcRejectReason | null {
    if (gen !== this.#gen) return 'not_connected';
    const live = this.#host.connection();
    if (live === null || live.state.commandScopeId !== scope)
      return 'not_connected';
    if (io !== null) {
      const now = this.#host.io();
      if (!now.permitted || now.epoch !== io.epoch) return 'input_stopped';
    }
    return null;
  }

  async approve(
    previewRef: string,
  ): Promise<BridgeOutcome<'accepted' | 'durable'>> {
    const gen = this.#gen;
    const record = this.#previews.get(previewRef);
    const connection = this.#host.connection();
    if (record === undefined) return fail('entry_not_found');
    if (connection === null) return fail('not_connected');
    // 外部変更で、口座と対象のメールを確認できていない内容は承認させない（画面も承認を出さない）。
    if (!record.approvable) return fail('core_rejected');
    const before = this.#fresh(record, connection);
    if (before !== null) return fail(before);
    const io = this.#host.io();
    if (!io.permitted) return fail('input_stopped');
    // 本人の確認（OS の確認ダイアログ）。承認はここで 1 回だけ。やめる・閉じる・前面でなくなったときは送らない。
    const confirmed = await this.#host.confirm(record.display);
    const stopped = this.#stillAllowed(gen, record.scope, io);
    if (stopped !== null) return fail(stopped);
    if (typeof confirmed === 'string') return fail(confirmed);
    const live = this.#host.connection();
    if (live === null) return fail('not_connected');
    // 確認している間に内容・状態が変わっていたら送らない（確認した内容と違う内容を承認させない）。
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
    return this.#sent(
      outcome,
      gen,
      record.operationId,
      record.stateRevision,
      'approve',
    );
  }

  #sent(
    outcome: Awaited<ReturnType<ClientConnection['send']>>,
    gen: number,
    operationId: string,
    revision: string,
    kind: HeldRecord['kind'],
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
        // 世代をまたいだ後は、今の世代の保留を作らない。
        if (gen !== this.#gen) return fail('outcome_unknown');
        // 届いたか分からない。操作の状態が進むか、本人が読み取りだけで状態を確かめる（check）まで、同じ命令を
        // 送らせない（自動では送り直さない）。
        this.#held.set(operationId, { revision, kind });
        this.#host.log('operation_command_outcome_unknown');
        this.#host.changed();
        return fail('outcome_unknown');
    }
  }

  // --- 取消・再試行・照合 ---

  async command(
    kind: 'cancel' | 'reconcile' | 'retry',
    ref: string,
  ): Promise<BridgeOutcome<'accepted' | 'durable'>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const target = this.#operationOf(ref, connection);
    if (target === null || this.#held.has(target.id))
      return fail('entry_not_found');
    // 再試行は、実行されなかったと確定した（not_executed）操作だけ。結果不明の操作は照合を使う（中枢も 409 で拒む）。
    if (kind === 'retry' && target.snapshot.state !== 'not_executed')
      return fail('core_rejected');
    const revision = target.snapshot.state_revision;
    if (kind !== 'reconcile') {
      // 取消・再試行は本人の確認（OS の確認ダイアログ）を 1 回だけ。確認は対象・状態・世代に結び付ける。
      // 再試行は外部変更をもう一度行うので、停止していないこと・io_epoch も送る直前に確かめる。
      const io = kind === 'retry' ? this.#host.io() : null;
      if (io !== null && !io.permitted) return fail('input_stopped');
      // 確認に出す見出しは、今の内容版・hash と一致する内容だけ。なければ（ロック・切断の後、別端末での改訂など）、
      // 内容の表示用の読み取りで取り直し、取れなければ確認へ進ませない。
      // 以前に読んだ内容が「確認できていない」（provider の一時的な失敗など）だったときも、本人が押したこのときに読み直す。
      let content = this.#contentFor(target.snapshot);
      if (content === undefined || !content.identified) {
        const before = content;
        await this.#serial(target.id, async () => {
          if (gen !== this.#gen) return;
          // 待っている間に、別の読み取りが同じ内容を確認できる形で読めていたら、読み直さない。
          const now = this.#contentFor(target.snapshot);
          if (now !== undefined && now !== before && now.identified) return;
          await this.#fetchDisplay(target.id, gen);
        });
        if (gen !== this.#gen) return fail('not_connected');
        content = this.#contentFor(target.snapshot);
      }
      // 内容がない・外部変更で口座か対象のメールを確認できない（接続先が替わったなど）ときは、確認を出さない。
      if (content === undefined || !content.identified)
        return fail('content_unavailable');
      const confirmed = await this.#host.confirm({
        action: kind === 'cancel' ? 'cancel_operation' : 'retry_operation',
        operationKind: target.snapshot.operation_kind,
        headline: content.headline,
        detail: content.detail,
        state: target.snapshot.state,
      });
      const stopped = this.#stillAllowed(gen, scope, io);
      if (stopped !== null) return fail(stopped);
      if (typeof confirmed === 'string') return fail(confirmed);
      const live = this.#host.connection();
      const rawCurrent = live?.state.operations.find(
        (op) => op.operation_id === target.id,
      );
      const current =
        rawCurrent === undefined ? undefined : this.#current(rawCurrent);
      if (
        live === null ||
        current === undefined ||
        this.#contentFor(current) === undefined ||
        this.#held.has(target.id) ||
        current.state !== target.snapshot.state ||
        current.state_revision !== revision
      )
        return fail('preview_stale');
    }
    const live = this.#host.connection();
    if (live === null) return fail('not_connected');
    const outcome = await live.send({
      kind,
      operationId: target.id,
      expectedStateRevision: revision,
      commandScopeId: scope,
    });
    // 照合は参照だけで再送ではない。結果が分からなくても保留にせず、本人がもう一度押せる。
    if (kind === 'reconcile') {
      if (outcome.kind === 'unknown') return fail('outcome_unknown');
      return this.#sent(outcome, gen, target.id, revision, 'cancel');
    }
    return this.#sent(outcome, gen, target.id, revision, kind);
  }

  // --- 結果不明の保留を、読み取りだけで確かめる（命令の再送ではない） ---

  async check(
    ref: string,
  ): Promise<BridgeOutcome<'state_changed' | 'state_unchanged'>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    let id: string | null = null;
    for (const [operationId, record] of this.#refs)
      if (record.ref === ref) id = operationId;
    const held = id === null ? undefined : this.#held.get(id);
    if (id === null || held === undefined) return fail('entry_not_found');
    const outcome = await connection.request({
      method: 'GET',
      path: `/v1/operations/${encodeURIComponent(id)}`,
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return fail('not_connected');
    // 読めなければ保留のまま（読み取りは何も変えない）。
    if (outcome.kind !== 'response') return fail('not_connected');
    if (
      outcome.status !== 200 ||
      !this.#host.contract.valid('OperationSnapshot', outcome.body)
    )
      return fail('core_rejected');
    const snapshot = outcome.body as OperationSnapshot;
    // 保留を付けたときより状態が進んでいれば、命令は届いていた。進んでいなければ届いていない（遅れて届いても、
    // 期待する状態版で守られ、二重には適用されない）。どちらも保留を解き、本人が今の状態から操作できるようにする。
    const advanced = newer(snapshot.state_revision, held.revision);
    // 読み取った今の状態を一覧に反映する（クライアントの状態が追いつくまで）。到達したかは断定しない。
    // 保存済みの状態（クライアントの状態・前に読んだ状態）より新しい応答だけを入れる（遅れて届いた古い応答で戻さない）。
    const known = connection.state.operations.find(
      (op) => op.operation_id === id,
    );
    const latest = this.#observed.get(id);
    const baseline = [known, latest]
      .filter((item): item is OperationSnapshot => item !== undefined)
      .reduce<string | null>(
        (best, item) =>
          best === null || newer(item.state_revision, best)
            ? item.state_revision
            : best,
        null,
      );
    if (baseline === null || newer(snapshot.state_revision, baseline))
      this.#observed.set(id, snapshot);
    this.#held.delete(id);
    this.#host.log(
      advanced ? 'operation_hold_released_advanced' : 'operation_hold_released',
    );
    this.#host.changed();
    return { ok: true, value: advanced ? 'state_changed' : 'state_unchanged' };
  }
}

type PreviewDisplay = OperationPreview['display'];

// 外部変更は、口座の表示名と対象のメールの件名・差出人・受信日時がすべてそろうまで確認できない（承認・取消・再試行の
// 確認に出せない）。Buddy 内の用事は常に確認できる。
function identifiedOf(
  intent: OperationIntent,
  display: PreviewDisplay,
): boolean {
  if (!('provider' in intent)) return true;
  const target = display?.target ?? null;
  return (
    (display?.account_label ?? null) !== null &&
    target !== null &&
    target.subject !== null &&
    target.sender !== null &&
    target.received_at !== null
  );
}

// 一覧の行の見出しと補足（承認待ちの内容から。1 行ずつ）。
function contentOf(
  intent: OperationIntent,
  display: PreviewDisplay,
): { headline: string | null; detail: string | null } {
  const action = intent.action;
  switch (action.kind) {
    case 'task.create':
      return {
        headline: action.title,
        detail: action.due === null ? null : `期限 ${action.due}`,
      };
    case 'mail.labels.change': {
      const parts: string[] = [];
      if (action.add.length > 0) parts.push(`付ける: ${action.add.join('、')}`);
      if (action.remove.length > 0)
        parts.push(`外す: ${action.remove.join('、')}`);
      return {
        headline:
          display?.target?.subject ??
          ('remote_id' in intent.target ? intent.target.remote_id : null),
        detail: parts.length === 0 ? null : parts.join(' / '),
      };
    }
    case 'mail.draft.create':
      return {
        headline: action.subject,
        detail: `宛先 ${action.to.join('、')}`,
      };
  }
}

// 中枢の確定 intent と表示用の値から、承認画面に出す値を作る（preview_id・hash・アカウント ID は含めない）。
// 外部変更で、口座の表示名と対象のメール（件名か差出人）を確認できなければ、承認へ進ませない（approvable: false）。
export function previewView(
  intent: OperationIntent,
  previewRef: string,
  display: PreviewDisplay,
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
  const external = 'provider' in intent;
  const target = display?.target ?? null;
  const accountLabel = external ? (display?.account_label ?? null) : null;
  const identified = identifiedOf(intent, display);
  return {
    preview_ref: previewRef,
    operation_kind: action.kind,
    service: external ? intent.provider : 'buddy',
    target:
      'list_id' in intent.target
        ? intent.target.list_id
        : intent.target.remote_id,
    fields,
    account_label: accountLabel,
    target_detail: external && target !== null ? { ...target } : null,
    approvable: identified,
  };
}
