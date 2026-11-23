// デスクトップの main の連携の接続の経路（B08-02 P3・B09-05、ADR 0142。設計 01 接続・端末、設計 04 接続・権限／
// 取得する対象、ADR 0072・0086・0089）。
//
// - 画面へ渡すのは参照（ref）と表示用の値（提供元・状態・権限・取得範囲・Microsoft のアカウントの状態）だけ。
//   接続 ID・permission_revision・scope_revision は main の中に持ち、画面へも IPC へもログへも出さない
//   （画面から送られた ref を main が解決する。解決できなければ entry_not_found）。接続範囲（command_scope_id）は
//   接続が本文に付ける。
// - 一覧は中枢の GET /v1/connections を読む。読めなかったとき（接続の失敗・503・形の違う応答）は前の値のまま、
//   取得の状態を stale（読めたことがなければ unavailable）にする。読めなかったことを「接続なし」にしない（設計 01）。
// - 取得範囲の変更は、一覧で読んだ permission_revision を expected_permission_revision にして送る。保存できたら
//   一覧を読み直す。版が変わっていた（409）なら読み直して preview_stale。結果が分からない（届いたか分からない・
//   5xx・形の違う 2xx）は自動では送り直さず、その接続を次の読み取りまで変更させない（delivery_unknown）。
// - 画面から足せる対象はない。今保存されているカレンダー・フォルダー／ラベル以外の ID を含む変更は送らずに
//   invalid_request で拒否する（新しい対象の追加は接続時（B03-04）に行う。発見した対象の一覧を中枢から画面へ
//   渡す経路は契約にない）。期間・添付の範囲は domain の validateFetchScope で送る前に確かめる（正本は中枢の検査）。
// - 世代（ロック・切断）: reset で一覧・参照・保留を捨て、非同期の処理は await の後に世代を照合する（またいだ
//   読み取りは反映しない。またいだ変更は結果不明として返す）。
// Electron に依存しない（node:test で試験する）。
import type {
  ConnectionList,
  ConnectionSummary,
  ConnectionTargets,
  DesktopConnectionEntry,
  DesktopProviderConnectionsView,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import { validateFetchScope } from '@buddy/domain';
import type { DesktopIpcRejectReason, FetchScope } from '@buddy/domain';
import type { DesktopContract } from './contract.js';

export interface ConnectionsHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  readonly newRef: () => string;
  readonly log: (code: string) => void;
}

export type ConnectionsOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DesktopIpcRejectReason };

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

// 契約の形（snake_case）から domain の取得範囲の形へ直す。
const toFetchScope = (targets: ConnectionTargets): FetchScope => ({
  calendarIds: targets.calendar_ids,
  mailContainerIds: targets.mail_container_ids,
  attachmentKinds: targets.attachment_kinds,
  mailLookbackDays: targets.mail_lookback_days,
  calendarPastDays: targets.calendar_past_days,
  calendarFutureDays: targets.calendar_future_days,
  attachmentMaxBytes: targets.attachment_max_bytes,
});

const copyTargets = (targets: ConnectionTargets): ConnectionTargets => ({
  calendar_ids: [...targets.calendar_ids],
  mail_container_ids: [...targets.mail_container_ids],
  attachment_kinds: [...targets.attachment_kinds],
  mail_lookback_days: targets.mail_lookback_days,
  calendar_past_days: targets.calendar_past_days,
  calendar_future_days: targets.calendar_future_days,
  attachment_max_bytes: targets.attachment_max_bytes,
});

export class ConnectionsBridge {
  readonly #host: ConnectionsHost;
  // 最新の読み取りの接続（接続 ID → 概要）と、接続 ID → 参照。参照は同じ接続のあいだ変えない。
  #records = new Map<string, ConnectionSummary>();
  readonly #refs = new Map<string, string>();
  // 結果が分からなかった接続（接続 ID → そのときの読み取りの通し番号）。それより後に始めた読み取りが成功するまで変更させない。
  readonly #held = new Map<string, number>();
  // 直近の読み取りが成功したことがあるか・失敗したか。
  #read = false;
  #failed = false;
  #gen = 0;
  // 始めた読み取りの通し番号。
  #seq = 0;
  // 画面へ渡す一覧の通し番号（読み取りが終わるたび・世代が進むたびに増える。減らない）。
  #listSeq = 1;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(host: ConnectionsHost) {
    this.#host = host;
  }

  // 表示の権限の世代が進んだ（ロック・切断）: 一覧・参照・保留を捨てる。進行中の読み取りは反映しない。
  reset(): void {
    this.#gen += 1;
    this.#records = new Map();
    this.#refs.clear();
    this.#held.clear();
    this.#read = false;
    this.#failed = false;
    this.#listSeq += 1;
  }

  // 画面に出す値。中枢が返した順に並べる。
  view(): DesktopProviderConnectionsView {
    const entries = [...this.#records.entries()].map(
      ([connectionId, summary]): DesktopConnectionEntry => ({
        ref: this.#refs.get(connectionId) as string,
        provider: summary.provider,
        status: summary.status,
        access: summary.access,
        granted_scopes: [...summary.granted_scopes],
        targets: copyTargets(summary.targets),
        graph_account: summary.graph_account ?? null,
        delivery_unknown: this.#held.has(connectionId),
      }),
    );
    return {
      fetch: !this.#read ? 'unavailable' : this.#failed ? 'stale' : 'loaded',
      entries,
      list_seq: this.#listSeq,
    };
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
          await this.#readOnce();
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = running;
    return running;
  }

  async #readOnce(): Promise<void> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return;
    const seq = ++this.#seq;
    const listed = await connection.request({
      method: 'GET',
      path: '/v1/connections',
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return;
    this.#listSeq += 1;
    if (
      listed.kind === 'response' &&
      listed.status === 200 &&
      this.#host.contract.valid('ConnectionList', listed.body)
    ) {
      this.#apply(listed.body as ConnectionList, seq);
      return;
    }
    // 読めなかった。前の一覧のまま、読めなかったことを画面に出す（「接続なし」の証拠にしない）。
    this.#failed = true;
    this.#host.log('connection_list_unavailable');
  }

  // 読み取った一覧を反映する。同じ接続は同じ参照を保つ。この読み取りより前に結果が分からなくなった接続の保留は解く
  // （今の保存値を読めたので、変更が当たったかどうかは一覧が示す）。
  #apply(body: ConnectionList, seq: number): void {
    const next = new Map<string, ConnectionSummary>();
    for (const summary of body.connections) {
      next.set(summary.connection_id, summary);
      if (!this.#refs.has(summary.connection_id))
        this.#refs.set(summary.connection_id, this.#host.newRef());
    }
    for (const key of [...this.#refs.keys()])
      if (!next.has(key)) {
        this.#refs.delete(key);
        this.#held.delete(key);
      }
    for (const [key, heldAt] of [...this.#held])
      if (heldAt < seq) this.#held.delete(key);
    this.#records = next;
    this.#read = true;
    this.#failed = false;
  }

  // 一覧を読み直して返す（画面を開いたとき・本人が読み直すとき）。
  async list(): Promise<ConnectionsOutcome<DesktopProviderConnectionsView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    if (connection === null || connection.state.commandScopeId === null)
      return fail('not_connected');
    await this.refresh();
    if (gen !== this.#gen) return fail('not_connected');
    return { ok: true, value: this.view() };
  }

  #connectionOf(ref: string): string | null {
    for (const [connectionId, candidate] of this.#refs)
      if (candidate === ref) return connectionId;
    return null;
  }

  // --- 取得範囲の変更 ---

  async updateTargets(
    ref: string,
    targets: ConnectionTargets,
  ): Promise<ConnectionsOutcome<DesktopProviderConnectionsView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const connectionId = this.#connectionOf(ref);
    const record =
      connectionId === null ? undefined : this.#records.get(connectionId);
    if (
      connectionId === null ||
      record === undefined ||
      this.#held.has(connectionId)
    )
      return fail('entry_not_found');
    // 期間・添付の範囲の検査（正本は中枢の検査）。契約の上限と同じ規則で送る前に確かめる。
    if (validateFetchScope(toFetchScope(targets)).length > 0)
      return fail('invalid_request');
    // 新しい対象の追加は画面からはしない。今保存されている対象のうちの選択だけを送る。
    const saved = record.targets;
    if (
      targets.calendar_ids.some((id) => !saved.calendar_ids.includes(id)) ||
      targets.mail_container_ids.some(
        (id) => !saved.mail_container_ids.includes(id),
      )
    )
      return fail('invalid_request');
    const outcome = await connection.request({
      method: 'PUT',
      path: `/v1/connections/${encodeURIComponent(connectionId)}/targets`,
      body: {
        request_id: this.#host.newRef(),
        expected_permission_revision: record.permission_revision,
        targets: copyTargets(targets),
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 送った後に世代が変わった: 当たったかどうかを今の世代の一覧で示せないので結果不明（自動では送り直さない）。
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (outcome.kind === 'unknown') {
      this.#hold(connectionId);
      return fail('outcome_unknown');
    }
    if (
      outcome.status === 200 &&
      this.#host.contract.valid('ConnectionSummary', outcome.body)
    ) {
      // 保存できた。読み直して一覧を合わせる（読み直せなければ取得の状態が stale になる）。
      await this.refresh();
      if (gen !== this.#gen) return fail('not_connected');
      return { ok: true, value: this.view() };
    }
    // 形の違う 2xx と 5xx（中枢は保存の成否が分からないときも 503 を返す）は結果不明。読み直しで解く。
    if (
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#hold(connectionId);
      void this.refresh();
      return fail('outcome_unknown');
    }
    // 版が変わっていた（古い画面）。読み直して、新しい保存値から操作し直させる。
    void this.refresh();
    return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
  }

  #hold(connectionId: string): void {
    this.#held.set(connectionId, this.#seq);
    this.#listSeq += 1;
    this.#host.log('connection_targets_outcome_unknown');
  }
}
