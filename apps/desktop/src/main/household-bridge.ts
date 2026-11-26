// デスクトップの main の家計簿の経路（ADR 0162。API は ADR 0161）。
//
// - 画面へ渡すのは参照（ref）と表示用の値（金額・日付・時刻・分類・店名・メモ・支払い手段・出所の種類・月ごとの合計・
//   集計）だけ。記録の ID・内容版は main の中に持ち、画面へも IPC へもログへも出さない（画面から送られた ref を main が
//   解決する。解決できなければ entry_not_found）。接続範囲は接続が本文に付ける。
// - 読み取りは中枢の GET /v1/household/months（月ごとの合計と今月）と GET /v1/household/months/{month}（1 か月の記録）。
//   月を指定しなければ中枢が決めた今月を読む（端末の時計で今月を決めない。U331）。読めなかったとき（接続の失敗・503・
//   形の違う応答）は前の値のまま、取得の状態を stale（読めたことがなければ unavailable）にする。読めなかったことを
//   「記録なし」にしない。
// - 分類の変更・削除は、読んだ内容版を expected_content_revision にして送る。受け付けられたら読み直す。表示が古かった
//   （409）は preview_stale、中枢が受け付けなかった（422 など）は core_rejected にして読み直す。結果が分からない
//   （届いたか分からない・5xx・形の違う 2xx）は自動では送り直さず、その記録を次の読み取りまで操作させない。
// - 世代（ロック・切断）: reset で記録・参照・保留を捨て、非同期の処理は await の後に世代を照合する（またいだ読み取りは
//   反映しない。またいだ変更は結果不明として返す）。
// - 読み取りが重なったときは、後から始めた読み取りだけを反映する（古い月の応答で新しい月の表示を戻さない）。
// Electron に依存しない（node:test で試験する）。
import type {
  DesktopHouseholdEntry,
  DesktopHouseholdView,
  HouseholdCategoryId,
  HouseholdEntry,
  HouseholdMonth,
  HouseholdOverview,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';

export interface HouseholdHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  readonly newRef: () => string;
  // UTC のミリ秒（最後に読めた時刻）。
  readonly now: () => number;
  readonly log: (code: string) => void;
}

export type HouseholdOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DesktopIpcRejectReason };

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

const MONTH = /^20[0-9]{2}-(0[1-9]|1[0-2])$/u;

interface HouseholdRecord {
  readonly entry: HouseholdEntry;
  // 中枢が並べた順。
  readonly position: number;
}

export class HouseholdBridge {
  readonly #host: HouseholdHost;
  #overview: HouseholdOverview | null = null;
  #month: HouseholdMonth | null = null;
  // 最新の読み取りの記録（記録の ID → 記録）と、記録の ID → 参照。参照は同じ記録のあいだ変えない。
  #records = new Map<string, HouseholdRecord>();
  readonly #refs = new Map<string, string>();
  // 結果が分からなかった記録（記録の ID → そのときの読み取りの通し番号）。それより後に始めた読み取りが成功するまで操作させない。
  readonly #held = new Map<string, number>();
  #fetchedAt: string | null = null;
  #failed = false;
  #gen = 0;
  // 始めた読み取りの通し番号。
  #seq = 0;
  // 画面へ渡す値の通し番号（読み取りが終わるたび・世代が進むたびに増える。減らない）。
  #listSeq = 1;

  constructor(host: HouseholdHost) {
    this.#host = host;
  }

  // 表示の権限の世代が進んだ（ロック・切断）: 記録・参照・保留を捨てる。進行中の読み取りは反映しない。
  reset(): void {
    this.#gen += 1;
    this.#overview = null;
    this.#month = null;
    this.#records = new Map();
    this.#refs.clear();
    this.#held.clear();
    this.#fetchedAt = null;
    this.#failed = false;
    this.#listSeq += 1;
  }

  // 画面に出す値。
  view(): DesktopHouseholdView {
    const entries = [...this.#records.entries()]
      .sort((a, b) => a[1].position - b[1].position)
      .map(([entryId, record]): DesktopHouseholdEntry => {
        const entry = record.entry;
        return {
          ref: this.#refs.get(entryId) as string,
          position: record.position,
          source_kind: entry.source_kind,
          direction: entry.direction,
          amount_yen: entry.amount_yen,
          occurred_on: entry.occurred_on,
          occurred_time: entry.occurred_time,
          category: entry.category,
          merchant: entry.merchant,
          memo: entry.memo,
          payment: entry.payment,
          delivery_unknown: this.#held.has(entryId),
        };
      });
    return {
      fetch:
        this.#fetchedAt === null
          ? 'unavailable'
          : this.#failed
            ? 'stale'
            : 'loaded',
      fetched_at: this.#fetchedAt,
      current_month: this.#overview?.current_month ?? null,
      months: this.#overview === null ? [] : [...this.#overview.months],
      month: this.#month?.month ?? null,
      entries,
      summary: this.#month?.summary ?? null,
      unreadable: this.#month?.unreadable ?? 0,
      truncated:
        (this.#overview?.truncated ?? false) ||
        (this.#month?.truncated ?? false),
      list_seq: this.#listSeq,
    };
  }

  // --- 読み取り ---

  // 月ごとの合計と、指定した月（null は中枢が決めた今月）の記録を読む。読めなかったら false。
  async #read(month: string | null): Promise<boolean> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return false;
    const seq = ++this.#seq;
    const superseded = (): boolean => gen !== this.#gen || seq !== this.#seq;
    const listed = await connection.request({
      method: 'GET',
      path: '/v1/household/months',
      expectedScopeId: scope,
    });
    if (superseded()) return false;
    if (
      listed.kind !== 'response' ||
      listed.status !== 200 ||
      !this.#host.contract.valid('HouseholdOverview', listed.body)
    )
      return this.#unreadable();
    const overview = listed.body as HouseholdOverview;
    const target = month ?? overview.current_month;
    const read = await connection.request({
      method: 'GET',
      path: `/v1/household/months/${encodeURIComponent(target)}`,
      expectedScopeId: scope,
    });
    if (superseded()) return false;
    if (
      read.kind !== 'response' ||
      read.status !== 200 ||
      !this.#host.contract.valid('HouseholdMonth', read.body) ||
      (read.body as HouseholdMonth).month !== target
    )
      return this.#unreadable();
    this.#apply(overview, read.body as HouseholdMonth, seq);
    return true;
  }

  // 読めなかった。前の値のまま、読めなかったことを画面に出す（「記録なし」の証拠にしない）。
  #unreadable(): false {
    this.#listSeq += 1;
    this.#failed = true;
    this.#host.log('household_unavailable');
    return false;
  }

  // 読み取った値を反映する。同じ記録は同じ参照を保つ。この読み取りより前に結果が分からなくなった記録の保留は解く
  // （今の状態を読めたので、変更・削除が当たったかどうかは読んだ値が示す）。
  #apply(overview: HouseholdOverview, month: HouseholdMonth, seq: number) {
    const next = new Map<string, HouseholdRecord>();
    month.entries.forEach((entry, position) => {
      next.set(entry.entry_id, { entry, position });
      if (!this.#refs.has(entry.entry_id))
        this.#refs.set(entry.entry_id, this.#host.newRef());
    });
    for (const key of [...this.#refs.keys()])
      if (!next.has(key)) {
        this.#refs.delete(key);
        this.#held.delete(key);
      }
    for (const [key, heldAt] of [...this.#held])
      if (heldAt < seq) this.#held.delete(key);
    this.#records = next;
    this.#overview = overview;
    this.#month = month;
    this.#fetchedAt = new Date(this.#host.now()).toISOString();
    this.#failed = false;
    this.#listSeq += 1;
  }

  // 画面を開いたとき・月を選んだとき・本人が読み直すとき。month が null なら今月。
  async show(
    month: string | null,
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    if (connection === null || connection.state.commandScopeId === null)
      return fail('not_connected');
    if (month !== null && !MONTH.test(month)) return fail('invalid_request');
    const seq = this.#seq + 1;
    await this.#read(month);
    if (gen !== this.#gen) return fail('not_connected');
    // 後から始めた読み取りに追い越された（古い月で表示を戻さない）。
    if (this.#seq !== seq) return fail('list_superseded');
    return { ok: true, value: this.view() };
  }

  #entryOf(ref: string): string | null {
    for (const [entryId, entryRef] of this.#refs)
      if (entryRef === ref) return entryId;
    return null;
  }

  // 今出している月を読み直す（変更・削除の後）。
  #reread(): Promise<boolean> {
    return this.#read(this.#month?.month ?? null);
  }

  // --- 分類の変更・削除 ---

  category(
    ref: string,
    category: HouseholdCategoryId,
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    return this.#change(ref, (entryId, entry) => ({
      path: `/v1/household/entries/${encodeURIComponent(entryId)}/category`,
      body: { expected_content_revision: entry.content_revision, category },
      result: 'HouseholdCategoryChangeResult',
      same: entry.category === category,
    }));
  }

  remove(ref: string): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    return this.#change(ref, (entryId, entry) => ({
      path: `/v1/household/entries/${encodeURIComponent(entryId)}/delete`,
      body: { expected_content_revision: entry.content_revision },
      result: 'HouseholdEntryDeleteResult',
      same: false,
    }));
  }

  async #change(
    ref: string,
    build: (
      entryId: string,
      entry: HouseholdEntry,
    ) => {
      readonly path: string;
      readonly body: Record<string, string>;
      readonly result: string;
      // 今と同じ値（送らずに今の値を返す）。
      readonly same: boolean;
    },
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const entryId = this.#entryOf(ref);
    const record = entryId === null ? undefined : this.#records.get(entryId);
    if (entryId === null || record === undefined || this.#held.has(entryId))
      return fail('entry_not_found');
    const built = build(entryId, record.entry);
    if (built.same) return { ok: true, value: this.view() };
    const outcome = await connection.request({
      method: 'POST',
      path: built.path,
      body: built.body,
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 送った後に世代が変わった: 当たったかどうかを今の世代の値で示せないので結果不明（自動では送り直さない）。
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (outcome.kind === 'unknown') {
      this.#hold(entryId);
      void this.#reread();
      return fail('outcome_unknown');
    }
    if (
      outcome.status === 200 &&
      this.#host.contract.valid(built.result, outcome.body)
    ) {
      await this.#reread();
      if (gen !== this.#gen) return fail('not_connected');
      return { ok: true, value: this.view() };
    }
    // 形の違う 2xx と 5xx（中枢は保存の成否が分からないときも 503 を返す）は結果不明。読み直しで解く。
    if (
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#hold(entryId);
      void this.#reread();
      return fail('outcome_unknown');
    }
    // 表示が古かった（内容版が進んでいた・消えていた）・中枢が受け付けなかった。読み直して今の値を見せる。
    void this.#reread();
    return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
  }

  #hold(entryId: string): void {
    this.#held.set(entryId, this.#seq);
    this.#listSeq += 1;
    this.#host.log('household_change_outcome_unknown');
  }
}
