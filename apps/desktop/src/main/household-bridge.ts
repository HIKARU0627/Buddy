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
// - 中身の変更（ADR 0169）も同じ流れで、受け付けたらその記録の月（日付を直したときは直した後の月）を読み直す。
// - 利用通知の取り込みの入・切（ADR 0163）は、月ごとの合計で読んだ設定の版で照合して送る。
// - 世代（ロック・切断）: reset で記録・参照・保留を捨て、非同期の処理は await の後に世代を照合する（またいだ読み取りは
//   反映しない。またいだ変更は結果不明として返す）。
// - 読み取りが重なったときは、後から始めた読み取りだけを反映する（古い月の応答で新しい月の表示を戻さない）。
// Electron に依存しない（node:test で試験する）。
import type {
  DesktopHouseholdEntry,
  DesktopHouseholdView,
  HouseholdBudgetItem,
  HouseholdCategoryId,
  HouseholdManualEntry,
  HouseholdEntry,
  HouseholdMonth,
  HouseholdOverview,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import {
  buildHouseholdCsv,
  householdExportFileName,
  householdExportMonths,
  readMoneyforwardExport,
} from '@buddy/domain';
import type {
  DesktopIpcRejectReason,
  HouseholdExportEntry,
  HouseholdImportRow,
} from '@buddy/domain';
import type { DesktopContract } from './contract.js';
import type { HouseholdExportWriteResult } from './household-export-file.js';

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

// 中枢へ一度に送る行の数（契約の上限）。
export const HOUSEHOLD_IMPORT_BATCH = 100;

type LastImport = NonNullable<DesktopHouseholdView['last_import']>;
type LastExport = NonNullable<DesktopHouseholdView['last_export']>;

const EXPORT_OUTCOME_OF_SAVE: Readonly<
  Record<Exclude<HouseholdExportSaveResult, 'cancelled'>, LastExport['outcome']>
> = {
  saved: 'saved',
  link_refused: 'link_refused',
  failed_unchanged: 'write_failed_unchanged',
  failed_removed: 'write_failed',
  failed_left: 'write_failed_left',
};

/**
 * 保存の結果。cancelled は何も書かなかった。それ以外は書こうとした結果で、writeHouseholdExportFile の結果と同じ（saved・
 * link_refused・failed_unchanged・failed_removed・failed_left）。
 */
export type HouseholdExportSaveResult =
  'cancelled' | HouseholdExportWriteResult;

/**
 * 書き出す CSV を本人が選んだ場所へ書く処理（Electron の層が OS の保存先の選択で作る。ADR 0172）。本人が保存先を選ばずに
 * やめたら 'cancelled'（何も書かない）、書けなかったら保存先がどうなったかを分けて返す。stillValid は保存先が決まった後・
 * 書く直前に呼び、false（その間にロック・切断した）なら何も書かずに 'cancelled' を返す。
 */
export type HouseholdExportSaver = (file: {
  readonly name: string;
  readonly text: string;
  readonly stillValid: () => boolean;
}) => Promise<HouseholdExportSaveResult>;

/**
 * 書き出しのファイルの中身を文字にする。UTF-8（BOM の有無を問わない）として正しければ UTF-8、そうでなければ Shift_JIS と
 * して読む（書き出しの文字コードは公式の案内で確かめられていない。U336）。どちらでも読めなければ null。
 */
export function decodeHouseholdExport(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // UTF-8 でない。
  }
  try {
    return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 行を送る組に分ける。同じ日の行は同じ組に入れる（中枢が同じ日・同じ金額の利用通知と一つずつ突き合わせるため。
 * 一日の行が上限を超えるときだけ分ける）。日付の順。
 */
export function householdImportBatches(
  rows: readonly HouseholdImportRow[],
  size = HOUSEHOLD_IMPORT_BATCH,
): HouseholdImportRow[][] {
  const byDay = new Map<string, HouseholdImportRow[]>();
  for (const row of rows) {
    const day = byDay.get(row.content.occurred_on) ?? [];
    day.push(row);
    byDay.set(row.content.occurred_on, day);
  }
  const batches: HouseholdImportRow[][] = [];
  let current: HouseholdImportRow[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const dayRows = byDay.get(day) as HouseholdImportRow[];
    if (current.length > 0 && current.length + dayRows.length > size) {
      batches.push(current);
      current = [];
    }
    for (const row of dayRows) {
      if (current.length === size) {
        batches.push(current);
        current = [];
      }
      current.push(row);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

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
  #lastImport: LastImport | null = null;
  #lastExport: LastExport | null = null;
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
    this.#lastImport = null;
    this.#lastExport = null;
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
      mail_intake: this.#overview?.settings.mail_intake ?? null,
      recurring: this.#overview?.recurring ?? null,
      budget:
        this.#overview === null
          ? null
          : {
              items: [...this.#overview.budget.items],
              total_budget_yen: this.#overview.budget.total_budget_yen,
            },
      last_import: this.#lastImport,
      last_export: this.#lastExport,
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

  // 利用通知の取り込みを止める・再開する（ADR 0163）。読んだ設定の版で照合して送る。今と同じなら送らない。
  async intake(
    mailIntake: 'on' | 'off',
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const settings = this.#overview?.settings ?? null;
    if (settings === null) return fail('entry_not_found');
    if (settings.mail_intake === mailIntake)
      return { ok: true, value: this.view() };
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/household/settings',
      body: {
        expected_settings_revision: settings.settings_revision,
        mail_intake: mailIntake,
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (
      outcome.kind === 'response' &&
      outcome.status === 200 &&
      this.#host.contract.valid('HouseholdSettings', outcome.body)
    ) {
      await this.#reread();
      if (gen !== this.#gen) return fail('not_connected');
      return { ok: true, value: this.view() };
    }
    // 結果が分からない・表示が古い・受け付けなかった: 送り直さず、読み直して今の設定を見せる。
    void this.#reread();
    if (
      outcome.kind === 'unknown' ||
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#host.log('household_settings_outcome_unknown');
      return fail('outcome_unknown');
    }
    return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
  }

  // 外部の家計簿サービスの書き出しを取り込む（ADR 0164）。read は本人にファイルを選ばせて中身を返す（やめたら null）。
  // 行を日付の順に組に分けて一つずつ送り、途中で送れなくなったら止める（取り込み直せば記録済みの行は増えない）。
  // 結果は last_import に残し、最後に今の月を読み直す。
  async importExport(
    read: () => Promise<Uint8Array | null>,
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    let bytes: Uint8Array | null;
    try {
      bytes = await read();
    } catch {
      bytes = new Uint8Array();
    }
    if (gen !== this.#gen) return fail('not_connected');
    // 本人がファイルを選ばなかった。
    if (bytes === null) return { ok: true, value: this.view() };
    const totals: LastImport = {
      outcome: 'done',
      created: 0,
      duplicate: 0,
      matched: 0,
      rejected: 0,
      skipped: 0,
      rules_learned: 0,
    };
    const text = decodeHouseholdExport(bytes);
    const parsed = text === null ? null : readMoneyforwardExport(text);
    if (parsed === null || !parsed.ok) {
      this.#finishImport({ ...totals, outcome: 'unreadable' });
      return { ok: true, value: this.view() };
    }
    totals.skipped =
      parsed.skipped.excluded +
      parsed.skipped.zero_amount +
      parsed.skipped.unreadable;
    for (const batch of householdImportBatches(parsed.rows)) {
      const outcome = await connection.request({
        method: 'POST',
        path: '/v1/household/imports',
        body: {
          origin: 'moneyforward',
          rows: batch.map((row) => ({
            row_id: row.row_id,
            direction: row.content.direction,
            amount_yen: row.content.amount_yen,
            occurred_on: row.content.occurred_on,
            category: row.content.category,
            merchant: row.content.merchant,
            memo: row.content.memo,
            payment: row.content.payment,
          })),
        },
        scoped: true,
        screenOperation: true,
        expectedScopeId: scope,
      });
      if (gen !== this.#gen) return fail('outcome_unknown');
      if (
        outcome.kind !== 'response' ||
        outcome.status !== 200 ||
        !this.#host.contract.valid('HouseholdImportResult', outcome.body)
      ) {
        // 送れなかった・結果が分からない: 自動では送り直さず止める（取り込み直しても記録済みの行は増えない）。
        this.#host.log('household_import_stopped');
        this.#finishImport({ ...totals, outcome: 'stopped' });
        void this.#reread();
        return { ok: true, value: this.view() };
      }
      const result = outcome.body as Omit<LastImport, 'outcome' | 'skipped'>;
      totals.created += result.created;
      totals.duplicate += result.duplicate;
      totals.matched += result.matched;
      totals.rejected += result.rejected;
      totals.rules_learned += result.rules_learned;
    }
    this.#finishImport(totals);
    await this.#reread();
    if (gen !== this.#gen) return fail('not_connected');
    return { ok: true, value: this.view() };
  }

  #finishImport(result: LastImport): void {
    this.#lastImport = result;
    this.#listSeq += 1;
  }

  // 家計の記録を月の範囲で CSV に書き出す（ADR 0172）。月ごとに既存の GET /v1/household/months/{month} で読み（新しい API は
  // 足さない）、全部の月を欠けなく読めたときだけ、保存先を本人に選ばせて書く。打ち切られた月・読めない記録・読めない月が
  // あれば、ファイルは作らず結果だけを残す（欠けたファイルを黙って作らない）。読んだ記録は画面の表示（今の月）に混ぜず、
  // この関数の中の変数だけに持ち、保存先へ渡したら捨てる（画面・ログ・一時ファイルへ出さない）。ロック・切断をまたいだら
  // 何も書かない。本人が保存先を選ばずにやめたときは、結果を残さずに今の表示を返す。
  async exportCsv(
    from: string,
    to: string,
    save: HouseholdExportSaver,
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const months = householdExportMonths(from, to);
    if (months === null) return fail('invalid_request');
    this.#lastExport = null;
    this.#listSeq += 1;
    const entries: HouseholdExportEntry[] = [];
    const seen = new Set<string>();
    let read = 0;
    let truncatedMonths = 0;
    let unreadable = 0;
    const finish = (
      outcome: LastExport['outcome'],
    ): HouseholdOutcome<DesktopHouseholdView> => {
      this.#lastExport = {
        outcome,
        months: read,
        entries: entries.length,
        truncated_months: truncatedMonths,
        unreadable,
      };
      this.#listSeq += 1;
      return { ok: true, value: this.view() };
    };
    for (const month of months) {
      const response = await connection.request({
        method: 'GET',
        path: `/v1/household/months/${encodeURIComponent(month)}`,
        expectedScopeId: scope,
      });
      if (gen !== this.#gen) return fail('not_connected');
      if (
        response.kind !== 'response' ||
        response.status !== 200 ||
        !this.#host.contract.valid('HouseholdMonth', response.body)
      ) {
        this.#host.log('household_export_read_failed');
        return finish('read_failed');
      }
      const body = response.body as HouseholdMonth;
      // 月の指定と記録の日付が合わない・同じ記録が二度出る（月をまたいでも、同じ月の中でも）応答は信じない。
      const inMonth = new Set<string>();
      if (
        body.month !== month ||
        body.entries.some((entry) => {
          const twice = seen.has(entry.entry_id) || inMonth.has(entry.entry_id);
          inMonth.add(entry.entry_id);
          return !entry.occurred_on.startsWith(`${month}-`) || twice;
        })
      ) {
        this.#host.log('household_export_read_failed');
        return finish('read_failed');
      }
      read += 1;
      if (body.truncated) truncatedMonths += 1;
      unreadable += body.unreadable;
      for (const entry of body.entries) {
        seen.add(entry.entry_id);
        entries.push({
          entry_id: entry.entry_id,
          source_kind: entry.source_kind,
          direction: entry.direction,
          amount_yen: entry.amount_yen,
          occurred_on: entry.occurred_on,
          occurred_time: entry.occurred_time,
          category: entry.category,
          merchant: entry.merchant,
          memo: entry.memo,
          payment: entry.payment,
        });
      }
    }
    if (truncatedMonths > 0 || unreadable > 0) return finish('incomplete');
    const text = buildHouseholdCsv(entries);
    if (text === null) {
      this.#host.log('household_export_read_failed');
      return finish('read_failed');
    }
    let saved: HouseholdExportSaveResult;
    try {
      saved = await save({
        name: householdExportFileName(from, to),
        text,
        stillValid: () => gen === this.#gen,
      });
    } catch {
      // 保存の処理が例外を出した。保存先がどうなったか分からない（書きかけが残っているかもしれない）。
      saved = 'failed_left';
    }
    if (saved === 'cancelled') {
      if (gen !== this.#gen) return fail('not_connected');
      this.#listSeq += 1;
      return { ok: true, value: this.view() };
    }
    if (saved !== 'saved') this.#host.log('household_export_write_failed');
    const outcome = EXPORT_OUTCOME_OF_SAVE[saved];
    if (gen !== this.#gen) {
      // 書こうとした後にロック・切断した。ファイルの状態は変わっているので、not_connected にせず結果を返す。読んだ記録は
      // ここで捨てる。新しい世代の状態には結果を残さない。
      return {
        ok: true,
        value: {
          ...this.view(),
          last_export: {
            outcome,
            months: read,
            entries: entries.length,
            truncated_months: truncatedMonths,
            unreadable,
          },
        },
      };
    }
    return finish(outcome);
  }

  // 分類ごとの予算を丸ごと差し替える（ADR 0166）。月ごとの合計で読んだ予算の版で照合して送る。
  async budget(
    items: readonly HouseholdBudgetItem[],
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const current = this.#overview?.budget ?? null;
    if (current === null) return fail('entry_not_found');
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/household/budget',
      body: {
        expected_budget_revision: current.budget_revision,
        items: items.map((item) => ({
          category: item.category,
          budget_yen: item.budget_yen,
        })),
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (
      outcome.kind === 'response' &&
      outcome.status === 200 &&
      this.#host.contract.valid('HouseholdBudget', outcome.body)
    ) {
      await this.#reread();
      if (gen !== this.#gen) return fail('not_connected');
      return { ok: true, value: this.view() };
    }
    void this.#reread();
    if (
      outcome.kind === 'unknown' ||
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#host.log('household_budget_outcome_unknown');
      return fail('outcome_unknown');
    }
    return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
  }

  // 家計の記録を手で足す（ADR 0167）。受け付けたら足した記録の月を読み直す（その月を出す）。
  async add(
    entry: HouseholdManualEntry,
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/household/entries',
      body: { entry: { ...entry } },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (
      outcome.kind === 'response' &&
      outcome.status === 200 &&
      this.#host.contract.valid('HouseholdEntry', outcome.body)
    ) {
      await this.#read(entry.occurred_on.slice(0, 7));
      if (gen !== this.#gen) return fail('not_connected');
      return { ok: true, value: this.view() };
    }
    void this.#reread();
    if (
      outcome.kind === 'unknown' ||
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#host.log('household_add_outcome_unknown');
      return fail('outcome_unknown');
    }
    return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
  }

  // 記録の中身（金額・日付・時刻・店名・メモ・支払い手段・分類）を直す（ADR 0169）。向きは変えられない（中枢が 422）。読んだ
  // 内容版で照合して送り、受け付けたらその記録の月を読み直す。結果が分からないときは送り直さず、その記録を次の読み取りまで
  // 操作させない。
  edit(
    ref: string,
    entry: HouseholdManualEntry,
  ): Promise<HouseholdOutcome<DesktopHouseholdView>> {
    return this.#change(ref, (entryId, current) => ({
      path: `/v1/household/entries/${encodeURIComponent(entryId)}/content`,
      body: {
        expected_content_revision: current.content_revision,
        entry: { ...entry },
      },
      result: 'HouseholdEntry',
      same: false,
      month: entry.occurred_on.slice(0, 7),
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
      readonly body: Record<string, unknown>;
      readonly result: string;
      // 今と同じ値（送らずに今の値を返す）。
      readonly same: boolean;
      // 受け付けた後に読み直す月。省略すると今出している月。
      readonly month?: string;
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
      await (built.month === undefined
        ? this.#reread()
        : this.#read(built.month));
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
