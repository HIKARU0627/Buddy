// デスクトップの main の忘却の画面の経路（UI-10、Issue #180。設計 03 忘却と再取り込み、ADR 0040・0044・0054・0180・0183）。
//
// - 計画は中枢が作る。画面は計画を見せて確認を返すだけ。承認・実行権限・閉包の判定の正本は中枢にある。
// - 画面へ渡すのは参照（ref）と表示用の値（記憶の本文・種類・期限・由来の件数、計画の件数と行の参照、消える指示の本文と
//   範囲）だけ。記憶 ID・計画 ID・本人の指示の ID・操作 ID・接続範囲は main の中に持ち、画面へも IPC へもログへも出さない
//   （画面から送られた ref を main が解決する。解決できなければ entry_not_found）。消える指示は、計画ごとに main が参照を
//   作り、中枢の本文（読めない指示は null）と範囲を写す（U433、ADR 0185）。
// - 一覧は中枢の GET /v1/memory/records を本人の画面操作として読む。読めなかったとき（接続の失敗・503・形の違う応答）は
//   前の値のまま、取得の状態を stale（読めたことがなければ unavailable）にする。読めなかったことを「記憶なし」にしない。
// - 忘却の公開ゲート（U112）は中枢の一覧が返す値を写す。計画・実行に中枢が 503 を返したら、理由を区別せずに忘却を
//   「使えない」にし、forget_unavailable を返す（次に一覧を読めたら、中枢の値に戻す）。main はゲートを開けない。
// - 実行は、画面に出した計画（同じ参照）だけを送る。送る前に OS の確認ダイアログを 1 回だけ出す（本人が「忘れる」を選んだ
//   ときだけ送る）。計画の後に台帳・系譜が変わった（409）は、何も消えていないので計画を捨てて preview_stale を返し、自動では
//   計画を作り直さない（本人が見ていない物を消さない）。結果が分からない（届いたか分からない・503 outcome_unknown・ほかの
//   5xx・形の違う 2xx）は、消えたかもしれないので計画を捨て、結果を「分からない」として残し、自動では送り直さない。
// - 世代（ロック・切断）: reset で一覧・参照・計画・結果を捨て、非同期の処理は await の後に世代を照合する。
// Electron に依存しない（node:test で試験する）。
import type {
  DesktopForgetPlanView,
  DesktopForgetResultView,
  DesktopMemoryEntry,
  DesktopMemoryView,
  ForgetPlanView,
  MemoryListItem,
  MemoryListResponse,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import { displayText } from './admin-confirm.js';
import type { DesktopContract } from './contract.js';

// 忘却の実行の前の OS の確認（admin-confirm.ts の forgetConfirmText が文言にする）。値は main が中枢から読んだ一覧と計画の
// 値だけで、画面からは受け取らない。
export interface ForgetConfirmRequest {
  readonly action: 'forget_memory';
  // 忘れる記憶の本文（中枢の一覧の値）。
  readonly memoryText: string;
  // 消える物の件数の合計・消える記憶の数・消える本人の指示の数・残る操作の数。
  readonly removedTotal: number;
  readonly memoryCount: number;
  readonly directiveCount: number;
  // 消える本人の指示のうち、中枢が本文を読めなかった数（U433、ADR 0185）。
  readonly unreadableDirectiveCount: number;
  readonly keptOperations: number;
}

export interface MemoryHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  readonly newRef: () => string;
  // UTC のミリ秒（最後に読めた時刻・計画の期限の判定）。
  readonly now: () => number;
  // 本人の確認（OS の確認ダイアログ）。確かめたときの接続範囲か、拒否の理由を返す（core-link の #confirm）。
  readonly confirm: (
    request: ForgetConfirmRequest,
  ) => Promise<{ readonly scope: string } | DesktopIpcRejectReason>;
  readonly log: (code: string) => void;
}

export type MemoryOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DesktopIpcRejectReason };

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

const errorCode = (body: unknown): string | null =>
  typeof body === 'object' &&
  body !== null &&
  typeof (body as Record<string, unknown>)['code'] === 'string'
    ? ((body as Record<string, unknown>)['code'] as string)
    : null;

interface HeldPlan {
  readonly ref: string;
  readonly planId: string;
  readonly memoryId: string;
  readonly view: ForgetPlanView;
  // 消える指示の参照（view.removed.directives と同じ順）。指示 ID の代わりに画面へ渡す。
  readonly directiveRefs: readonly string[];
}

export class MemoryBridge {
  readonly #host: MemoryHost;
  // 最新の一覧の記憶（記憶 ID → 項目）と、記憶 ID → 参照。参照は同じ記憶のあいだ変えない。
  #items = new Map<string, MemoryListItem>();
  readonly #refs = new Map<string, string>();
  #gate: MemoryListResponse['forget_gate'] | null = null;
  #truncated = false;
  // 中枢が計画・実行に 503 を返した（次に一覧を読めるまで、忘却を使えないとして見せる）。
  #unavailable = false;
  #plan: HeldPlan | null = null;
  #result: DesktopForgetResultView | null = null;
  #fetchedAt: string | null = null;
  #failed = false;
  #gen = 0;
  // 画面へ渡す値の通し番号（変わるたびに増える。減らない）。
  #listSeq = 1;
  #running: Promise<void> | null = null;
  #again = false;
  // 実行の旗。確認の前に立て、結果が出るか失敗したら下ろす。立っている間の 2 回目の実行は、確認も送信もせずに断る
  // （同じ計画の確認が 2 回通り、実行が 2 回送られて、結果不明の「送り直さない」が破れるのを防ぐ）。
  #executing = false;

  constructor(host: MemoryHost) {
    this.#host = host;
  }

  // 表示の権限の世代が進んだ（ロック・切断）: 一覧・参照・計画・結果を捨てる。進行中の読み取りは反映しない。
  reset(): void {
    this.#gen += 1;
    this.#items = new Map();
    this.#refs.clear();
    this.#gate = null;
    this.#truncated = false;
    this.#unavailable = false;
    this.#plan = null;
    this.#result = null;
    this.#fetchedAt = null;
    this.#failed = false;
    this.#listSeq += 1;
  }
  // 実行の旗は reset では下ろさない（古い世代の実行が終わるときに、その実行の finally が下ろす）。

  // 計画を持っているか（試験用）。
  hasPlan(): boolean {
    return this.#plan !== null;
  }

  #forgetState(): DesktopMemoryView['forget'] {
    if (this.#unavailable || this.#gate === null) return 'unavailable';
    return this.#gate;
  }

  #planView(plan: HeldPlan): DesktopForgetPlanView {
    const memoryRefs: string[] = [];
    let unlisted = 0;
    for (const memoryId of plan.view.removed.memory_ids) {
      const ref = this.#items.has(memoryId) ? this.#refs.get(memoryId) : null;
      if (ref === undefined || ref === null) unlisted += 1;
      else memoryRefs.push(ref);
    }
    return {
      ref: plan.ref,
      target_ref: this.#refs.get(plan.memoryId) as string,
      forgetting_generation: plan.view.forgetting_generation,
      expires_at: plan.view.expires_at,
      removed: {
        // 中枢の計画の件数の並び（1〜13 件。契約の形のまま写す）。
        counts: plan.view.removed.counts.map((entry) => ({
          kind: entry.kind,
          count: entry.count,
        })) as DesktopForgetPlanView['removed']['counts'],
        memory_refs: memoryRefs,
        unlisted_memory_count: unlisted,
        // 本文は、確認のダイアログと同じく制御文字・書字方向の制御文字・ゼロ幅の文字を除き、空白を 1 つにまとめて
        // 渡す（見かけを紛らわしくしない。長さは中枢が 200 文字までにしている）。除いて空になれば読めない指示と同じ扱い。
        directives: plan.view.removed.directives.map((directive, index) => ({
          ref: plan.directiveRefs[index] as string,
          scope: directive.scope,
          text:
            directive.text === null
              ? null
              : displayText(directive.text, 200) || null,
        })),
      },
      kept: {
        operation_states: plan.view.kept.operations.map(
          (operation) => operation.state,
        ),
        lineage_only: plan.view.kept.lineage_only,
      },
      blocked_source_count: plan.view.blocked_source_count,
    };
  }

  // 画面に出す値。計画の対象が一覧にない（読み直して消えた）計画は出さない。
  view(): DesktopMemoryView {
    const entries = [...this.#items.values()].map(
      (item): DesktopMemoryEntry => ({
        ref: this.#refs.get(item.memory_id) as string,
        kind: item.kind,
        origin: item.origin,
        text: item.text,
        status: item.status,
        created_at: item.created_at,
        review_at: item.review_at,
        delete_at: item.delete_at,
        source_counts: { ...item.source_counts },
      }),
    );
    const plan =
      this.#plan !== null && this.#items.has(this.#plan.memoryId)
        ? this.#planView(this.#plan)
        : null;
    return {
      fetch:
        this.#fetchedAt === null
          ? 'unavailable'
          : this.#failed
            ? 'stale'
            : 'loaded',
      fetched_at: this.#fetchedAt,
      forget: this.#forgetState(),
      truncated: this.#truncated,
      entries,
      plan,
      result: this.#result,
      list_seq: this.#listSeq,
    };
  }

  // --- 読み取り ---

  // 中枢の一覧を読む。進行中なら、その後でもう一度だけ読み、同じ約束を返す。
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
    const listed = await connection.request({
      method: 'GET',
      path: '/v1/memory/records',
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return;
    this.#listSeq += 1;
    if (
      listed.kind === 'response' &&
      listed.status === 200 &&
      this.#host.contract.valid('MemoryListResponse', listed.body)
    ) {
      this.#apply(listed.body as MemoryListResponse);
      return;
    }
    // 読めなかった。前の値のまま、読めなかったことを画面に出す（「記憶なし」の証拠にしない）。
    this.#failed = true;
    this.#host.log('memory_list_unavailable');
  }

  // 読み取った一覧を反映する。同じ記憶は同じ参照を保つ。ゲートの値は中枢の値に戻す（503 の「使えない」を解く）。
  #apply(body: MemoryListResponse): void {
    const next = new Map<string, MemoryListItem>();
    for (const item of body.items) {
      next.set(item.memory_id, item);
      if (!this.#refs.has(item.memory_id))
        this.#refs.set(item.memory_id, this.#host.newRef());
    }
    for (const key of [...this.#refs.keys()])
      if (!next.has(key)) this.#refs.delete(key);
    this.#items = next;
    this.#gate = body.forget_gate;
    this.#truncated = body.truncated;
    this.#unavailable = false;
    // 計画の対象が一覧から消えた（期限・別の画面での忘却）。計画を捨てる（自動では作り直さない）。
    if (this.#plan !== null && !next.has(this.#plan.memoryId))
      this.#plan = null;
    this.#fetchedAt = new Date(this.#host.now()).toISOString();
    this.#failed = false;
  }

  // 一覧を読み直して返す（画面を開いたとき・本人が読み直すとき）。
  async list(): Promise<MemoryOutcome<DesktopMemoryView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    if (connection === null || connection.state.commandScopeId === null)
      return fail('not_connected');
    await this.refresh();
    if (gen !== this.#gen) return fail('not_connected');
    return { ok: true, value: this.view() };
  }

  #memoryOf(ref: string): string | null {
    for (const [memoryId, memoryRef] of this.#refs)
      if (memoryRef === ref && this.#items.has(memoryId)) return memoryId;
    return null;
  }

  // 中枢が 503 を返した: 忘却を「使えない」にする（一覧を読み直すまで）。
  #markUnavailable(): void {
    this.#unavailable = true;
    this.#listSeq += 1;
    this.#host.log('forget_unavailable');
  }

  // --- 計画 ---

  async plan(ref: string): Promise<MemoryOutcome<DesktopMemoryView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const memoryId = this.#memoryOf(ref);
    if (memoryId === null) return fail('entry_not_found');
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/memory/forget-plans',
      body: { memory_id: memoryId },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (gen !== this.#gen) return fail('not_connected');
    // 計画の段階では何も消えない。結果が分からなければ、前の計画も使わない（中枢は同じ端末の古い計画を捨てている）。
    if (outcome.kind === 'unknown') {
      this.#dropPlan();
      return fail('outcome_unknown');
    }
    if (
      outcome.status === 200 &&
      this.#host.contract.valid('ForgetPlanView', outcome.body)
    ) {
      const view = outcome.body as ForgetPlanView;
      // 頼んだ記憶の計画でなければ使わない（中枢の取り違えを本人に見せない）。
      if (view.target.source_id !== memoryId) {
        this.#dropPlan();
        return fail('core_rejected');
      }
      this.#plan = {
        ref: this.#host.newRef(),
        planId: view.plan_id,
        memoryId,
        view,
        directiveRefs: view.removed.directives.map(() => this.#host.newRef()),
      };
      this.#result = null;
      this.#listSeq += 1;
      return { ok: true, value: this.view() };
    }
    this.#dropPlan();
    if (outcome.status === 503) {
      this.#markUnavailable();
      return fail('forget_unavailable');
    }
    // 対象の記憶がもうない（409）。一覧を読み直して、今の状態を見せる。
    if (outcome.status === 409) {
      void this.refresh();
      return fail('preview_stale');
    }
    return fail('core_rejected');
  }

  #dropPlan(): void {
    if (this.#plan === null) return;
    this.#plan = null;
    this.#listSeq += 1;
  }

  // --- 実行 ---

  #removedTotal(plan: HeldPlan): number {
    let total = 0;
    for (const entry of plan.view.removed.counts) total += entry.count;
    return total;
  }

  #outcomeUnknown(plan: HeldPlan): void {
    this.#plan = null;
    this.#result = {
      outcome: 'outcome_unknown',
      removed_total: this.#removedTotal(plan),
      at: new Date(this.#host.now()).toISOString(),
    };
    this.#listSeq += 1;
    this.#host.log('forget_execute_outcome_unknown');
  }

  async execute(ref: string): Promise<MemoryOutcome<DesktopMemoryView>> {
    // 実行が進んでいる間の 2 回目は、確認ダイアログも送信も出さずに断る。
    if (this.#executing) return fail('confirmation_pending');
    this.#executing = true;
    try {
      return await this.#execute(ref);
    } finally {
      this.#executing = false;
    }
  }

  async #execute(ref: string): Promise<MemoryOutcome<DesktopMemoryView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    if (connection === null || connection.state.commandScopeId === null)
      return fail('not_connected');
    const plan = this.#plan;
    if (plan === null) return fail('entry_not_found');
    // 画面が見ている計画が今の計画でない（作り直した・捨てた）。見ていない計画を実行しない。
    if (plan.ref !== ref) return fail('preview_stale');
    // 画面の時計で期限を過ぎた計画は送らない（正本は中枢の検査。自動では作り直さない）。
    if (this.#host.now() >= Date.parse(plan.view.expires_at)) {
      this.#dropPlan();
      return fail('preview_stale');
    }
    const memory = this.#items.get(plan.memoryId);
    if (memory === undefined) {
      this.#dropPlan();
      return fail('preview_stale');
    }
    const confirmed = await this.#host.confirm({
      action: 'forget_memory',
      memoryText: memory.text,
      removedTotal: this.#removedTotal(plan),
      memoryCount: plan.view.removed.memory_ids.length,
      directiveCount: plan.view.removed.directives.length,
      unreadableDirectiveCount: plan.view.removed.directives.filter(
        (directive) => directive.text === null,
      ).length,
      keptOperations: plan.view.kept.operations.length,
    });
    if (typeof confirmed === 'string') return fail(confirmed);
    if (gen !== this.#gen) return fail('not_connected');
    // 確認の間に計画が変わった・捨てた。確かめた計画でなければ送らない。
    if (this.#plan !== plan) return fail('preview_stale');
    const outcome = await connection.request({
      method: 'POST',
      path: `/v1/memory/forget-plans/${encodeURIComponent(plan.planId)}/execute`,
      body: { forgetting_generation: plan.view.forgetting_generation },
      scoped: true,
      screenOperation: true,
      expectedScopeId: confirmed.scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 送った後に世代が変わった: 消えたかどうかを今の世代で示せないので結果不明（自動では送り直さない）。
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (outcome.kind === 'unknown') {
      this.#outcomeUnknown(plan);
      return fail('outcome_unknown');
    }
    if (
      outcome.status === 200 &&
      this.#host.contract.valid('ForgetExecuteResult', outcome.body)
    ) {
      this.#plan = null;
      this.#result = {
        outcome: 'forgotten',
        removed_total: this.#removedTotal(plan),
        at: new Date(this.#host.now()).toISOString(),
      };
      await this.refresh();
      if (gen !== this.#gen) return fail('not_connected');
      return { ok: true, value: this.view() };
    }
    // 計画の後に台帳・系譜が変わった・計画が無効になった。何も消えていない。計画を捨てて読み直す（作り直しは本人が押す）。
    if (outcome.status === 409) {
      this.#dropPlan();
      void this.refresh();
      return fail('preview_stale');
    }
    if (
      outcome.status === 503 &&
      errorCode(outcome.body) !== 'outcome_unknown'
    ) {
      this.#dropPlan();
      this.#markUnavailable();
      return fail('forget_unavailable');
    }
    // 503 outcome_unknown・ほかの 5xx・形の違う 2xx は、消えたかもしれない。送り直さない。
    if (
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#outcomeUnknown(plan);
      void this.refresh();
      return fail('outcome_unknown');
    }
    // 4xx（ロック・画面操作でない など）は中枢が受け付けていない（何も消えていない）。
    this.#dropPlan();
    return fail('core_rejected');
  }
}
