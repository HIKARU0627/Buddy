// デスクトップの main の自動実行の一覧・取り消し・安全停止の解除の経路（B13-05、ADR 0154。設計 03「取り消しと安全停止」、
// J12、ADR 0152・0153）。
//
// - 画面へ渡すのは参照（ref）と表示用の値（種類・完了の時刻・取り消しの状態と期限・安全停止の状態と理由）だけ。操作 ID・
//   state_revision・方針の版・取り消しの対象の内容版・safety_revision・自動承認の件数は main の中に持ち、画面へも IPC へも
//   ログへも出さない（画面から送られた ref を main が解決する。解決できなければ entry_not_found）。接続範囲は接続が本文に付ける。
// - 一覧は中枢の GET /v1/auto-actions を読む（安全停止の状態と自動実行した操作を一つの読み取りで返す）。読めなかったとき
//   （接続の失敗・503・形の違う応答）は前の値のまま、取得の状態を stale（読めたことがなければ unavailable）にする。
//   読めなかったことを「自動実行なし」「動いている」にしない。
// - 取り消しは一覧で読んだ state_revision を expected_state_revision にして送る（本人の押下が J12 の確認。ADR 0153）。
//   受け付けられたら一覧を読み直す。対象がその後に変わっていた（409 target_changed）は undo_target_changed、ほかの 409・
//   410（期限切れ）は preview_stale にして読み直す。結果が分からない（届いたか分からない・5xx・形の違う 2xx）は自動では
//   送り直さず、その操作を次の読み取りまで取り消させない（delivery_unknown）。
// - 解除は画面が表示している安全停止の参照で指す。参照は safety_revision が変わるたびに作り直すので、画面が古い停止を見て
//   押したなら送らずに preview_stale を返す（新しい停止を本人が見ないまま解除しない）。送るのは一覧で読んだ
//   safety_revision で、中枢も同じ値で照合し直す。結果が分からなければ送り直さず、読み直して確かめさせる。
// - 世代（ロック・切断）: reset で一覧・参照・保留を捨て、非同期の処理は await の後に世代を照合する（またいだ読み取りは
//   反映しない。またいだ変更は結果不明として返す）。
// Electron に依存しない（node:test で試験する）。
import type {
  AutoActionItem,
  AutoActionList,
  DesktopAutoActionEntry,
  DesktopAutoActionView,
  DesktopSafetyView,
  SafetyState,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';

export interface AutoActionHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  readonly newRef: () => string;
  // UTC のミリ秒（最後に読めた時刻）。
  readonly now: () => number;
  readonly log: (code: string) => void;
}

export type AutoActionOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DesktopIpcRejectReason };

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

interface AutoActionRecord {
  readonly item: AutoActionItem;
  // 中枢が並べた順。
  readonly position: number;
}

const errorCode = (body: unknown): string | null =>
  typeof body === 'object' &&
  body !== null &&
  typeof (body as Record<string, unknown>)['code'] === 'string'
    ? ((body as Record<string, unknown>)['code'] as string)
    : null;

export class AutoActionBridge {
  readonly #host: AutoActionHost;
  // 最新の読み取りの操作（操作 ID → 項目）と、操作 ID → 参照。参照は同じ操作のあいだ変えない。
  #records = new Map<string, AutoActionRecord>();
  readonly #refs = new Map<string, string>();
  // 結果が分からなかった操作（操作 ID → そのときの読み取りの通し番号）。それより後に始めた読み取りが成功するまで取り消させない。
  readonly #held = new Map<string, number>();
  #safety: SafetyState | null = null;
  // 今の安全停止の状態の参照（safety_revision が変わるたびに作り直す）。
  #safetyRef: string | null = null;
  #fetchedAt: string | null = null;
  // 直近の読み取りが失敗したか。
  #failed = false;
  #gen = 0;
  // 始めた読み取りの通し番号。
  #seq = 0;
  // 画面へ渡す一覧の通し番号（読み取りが終わるたび・世代が進むたびに増える。減らない）。
  #listSeq = 1;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(host: AutoActionHost) {
    this.#host = host;
  }

  // 表示の権限の世代が進んだ（ロック・切断）: 一覧・参照・保留を捨てる。進行中の読み取りは反映しない。
  reset(): void {
    this.#gen += 1;
    this.#records = new Map();
    this.#refs.clear();
    this.#held.clear();
    this.#safety = null;
    this.#safetyRef = null;
    this.#fetchedAt = null;
    this.#failed = false;
    this.#listSeq += 1;
  }

  // 画面に出す値。
  view(): DesktopAutoActionView {
    const entries = [...this.#records.entries()]
      .sort((a, b) => a[1].position - b[1].position)
      .map(([operationId, record]): DesktopAutoActionEntry => {
        const item = record.item;
        return {
          ref: this.#refs.get(operationId) as string,
          position: record.position,
          kind: item.action_kind,
          completed_at: item.completed_at,
          undo_state: item.undo_state,
          undo_deadline: item.undo_deadline,
          delivery_unknown: this.#held.has(operationId),
        };
      });
    const safety: DesktopSafetyView | null =
      this.#safety === null || this.#safetyRef === null
        ? null
        : {
            ref: this.#safetyRef,
            state: this.#safety.state,
            stop_reason: this.#safety.stop_reason,
            stopped_at: this.#safety.stopped_at,
          };
    return {
      fetch:
        this.#fetchedAt === null
          ? 'unavailable'
          : this.#failed
            ? 'stale'
            : 'loaded',
      fetched_at: this.#fetchedAt,
      safety,
      entries,
      list_seq: this.#listSeq,
    };
  }

  // 安全停止中か（状態欄の安全停止の値。読めていなければ null）。
  safetyStopped(): boolean | null {
    return this.#safety === null ? null : this.#safety.state === 'stopped';
  }

  // --- 読み取り ---

  // 中枢の一覧を読む。進行中なら、その後でもう一度だけ読み、同じ約束を返す（待った人は最新の読み取りの反映まで待つ）。
  refresh(): Promise<void> {
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    const running = (async () => {
      try {
        do {
          this.#again = false;
          await this.#read();
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = running;
    return running;
  }

  async #read(): Promise<void> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return;
    const seq = ++this.#seq;
    const listed = await connection.request({
      method: 'GET',
      path: '/v1/auto-actions',
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return;
    this.#listSeq += 1;
    if (
      listed.kind === 'response' &&
      listed.status === 200 &&
      this.#host.contract.valid('AutoActionList', listed.body)
    ) {
      this.#apply(listed.body as AutoActionList, seq);
      return;
    }
    // 読めなかった。前の値のまま、読めなかったことを画面に出す（「自動実行なし」「動いている」の証拠にしない）。
    this.#failed = true;
    this.#host.log('auto_action_list_unavailable');
  }

  // 読み取った一覧を反映する。同じ操作は同じ参照を保つ。この読み取りより前に結果が分からなくなった操作の保留は解く
  // （今の状態を読めたので、取り消しが当たったかどうかは一覧が示す）。安全停止の版が変わったら参照を作り直す。
  #apply(body: AutoActionList, seq: number): void {
    const next = new Map<string, AutoActionRecord>();
    body.items.forEach((item, position) => {
      next.set(item.operation_id, { item, position });
      if (!this.#refs.has(item.operation_id))
        this.#refs.set(item.operation_id, this.#host.newRef());
    });
    for (const key of [...this.#refs.keys()])
      if (!next.has(key)) {
        this.#refs.delete(key);
        this.#held.delete(key);
      }
    for (const [key, heldAt] of [...this.#held])
      if (heldAt < seq) this.#held.delete(key);
    this.#records = next;
    if (
      this.#safety === null ||
      this.#safety.safety_revision !== body.safety.safety_revision
    )
      this.#safetyRef = this.#host.newRef();
    this.#safety = body.safety;
    this.#fetchedAt = new Date(this.#host.now()).toISOString();
    this.#failed = false;
  }

  // 一覧を読み直して返す（画面を開いたとき・本人が読み直すとき）。
  async list(): Promise<AutoActionOutcome<DesktopAutoActionView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    if (connection === null || connection.state.commandScopeId === null)
      return fail('not_connected');
    await this.refresh();
    if (gen !== this.#gen) return fail('not_connected');
    return { ok: true, value: this.view() };
  }

  #operationOf(ref: string): string | null {
    for (const [operationId, operationRef] of this.#refs)
      if (operationRef === ref) return operationId;
    return null;
  }

  // 読み直してから一覧を返す（取り消し・解除が受け付けられた後）。
  async #reread(
    gen: number,
  ): Promise<AutoActionOutcome<DesktopAutoActionView>> {
    await this.refresh();
    if (gen !== this.#gen) return fail('not_connected');
    return { ok: true, value: this.view() };
  }

  // --- 取り消し ---

  async undo(ref: string): Promise<AutoActionOutcome<DesktopAutoActionView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const operationId = this.#operationOf(ref);
    const record =
      operationId === null ? undefined : this.#records.get(operationId);
    if (
      operationId === null ||
      record === undefined ||
      this.#held.has(operationId)
    )
      return fail('entry_not_found');
    // 取り消せると読めた操作だけを送る（期限・種類・状態の正本は中枢の検査）。
    if (record.item.undo_state !== 'available') return fail('preview_stale');
    const outcome = await connection.request({
      method: 'POST',
      path: `/v1/auto-actions/${encodeURIComponent(operationId)}/undo`,
      body: { expected_state_revision: record.item.state_revision },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 送った後に世代が変わった: 当たったかどうかを今の世代の一覧で示せないので結果不明（自動では送り直さない）。
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (outcome.kind === 'unknown') {
      this.#hold(operationId);
      return fail('outcome_unknown');
    }
    if (
      (outcome.status === 200 || outcome.status === 202) &&
      this.#host.contract.valid('CommandReceipt', outcome.body)
    )
      return this.#reread(gen);
    // 形の違う 2xx と 5xx（中枢は保存の成否が分からないときも 503 を返す）は結果不明。読み直しで解く。
    if (
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#hold(operationId);
      void this.refresh();
      return fail('outcome_unknown');
    }
    // 中枢が戻さなかった・状態が変わっていた・期限が過ぎた。読み直して、今の状態を見せる。
    void this.refresh();
    if (outcome.status === 409 && errorCode(outcome.body) === 'target_changed')
      return fail('undo_target_changed');
    return fail(
      outcome.status === 409 || outcome.status === 410
        ? 'preview_stale'
        : 'core_rejected',
    );
  }

  #hold(operationId: string): void {
    this.#held.set(operationId, this.#seq);
    this.#listSeq += 1;
    this.#host.log('auto_action_undo_outcome_unknown');
  }

  // --- 安全停止の解除 ---

  async resume(ref: string): Promise<AutoActionOutcome<DesktopAutoActionView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const safety = this.#safety;
    if (safety === null || this.#safetyRef === null)
      return fail('entry_not_found');
    // 画面が見ている停止が今の停止でない（版が変わった）。新しい停止を本人が見ないまま解除しない。
    if (ref !== this.#safetyRef) return fail('preview_stale');
    if (safety.state !== 'stopped') return fail('preview_stale');
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/safety/resume',
      body: { expected_safety_revision: safety.safety_revision },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (outcome.kind === 'unknown') {
      this.#resumeUnknown();
      return fail('outcome_unknown');
    }
    if (
      outcome.status === 200 &&
      this.#host.contract.valid('SafetyState', outcome.body)
    )
      return this.#reread(gen);
    if (
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#resumeUnknown();
      return fail('outcome_unknown');
    }
    void this.refresh();
    return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
  }

  // 解除の結果が分からない: 送り直さず、読み直して今の状態を見せる。
  #resumeUnknown(): void {
    this.#host.log('safety_resume_outcome_unknown');
    void this.refresh();
  }
}
