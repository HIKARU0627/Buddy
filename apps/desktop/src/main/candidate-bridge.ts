// デスクトップの main の気づき（候補）の経路（B11-05、ADR 0132。設計 01 気づき、設計 11 §4、ADR 0073・0130）。
//
// - 画面へ渡すのは参照（ref）と表示用の値（題・期限・種類・状態・注記の材料）だけ。候補 ID・通知キー・依頼と根拠の版・
//   操作 ID・期待する状態（expected_state）は main の中に持ち、画面へも IPC へもログへも出さない（画面から送られた ref を
//   main が解決する。解決できなければ entry_not_found）。接続範囲（command_scope_id）は接続が本文に付ける。
// - 一覧は中枢の GET /v1/candidates を読む（中枢は一覧の前に時間による遷移と保持の掃除を回す。ADR 0132）。
//   読めなかったとき（接続の失敗・503・形の違う応答）は前の値のまま、取得の状態を stale（読めたことがなければ
//   unavailable）にする。読めなかったことを「候補なし」にしない（設計 01）。
// - 状態の変更（開く・今回は扱わない・再通知）は、一覧で読んだ状態を expected_state にして送る。記録できたら一覧を読み直して
//   件数と合わせる。状態が変わっていた（409）なら読み直して preview_stale。結果が分からない（届いたか分からない・5xx・
//   形の違う 2xx）は自動では送り直さず、その候補を次の読み取りまで操作させない（delivery_unknown）。
// - 再通知の時刻は画面が本人のタイムゾーンで解釈して UTC で送る。main も送る前に checkSnoozeUntil（いまより後）で確かめる
//   （正本は中枢の検査）。
// - 世代（ロック・切断）: reset で一覧・参照・保留を捨て、非同期の処理は await の後に世代を照合する（またいだ読み取りは
//   反映しない。またいだ変更は結果不明として返す）。
// Electron に依存しない（node:test で試験する）。
import type {
  CandidateListResponse,
  CandidateSnapshot,
  CandidateStateCounts,
  DesktopCandidateEntry,
  DesktopCandidateView,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import { checkSnoozeUntil } from '@buddy/domain';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';

export interface CandidateHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  readonly newRef: () => string;
  // UTC のミリ秒（再通知の時刻の確かめ）。
  readonly now: () => number;
  readonly log: (code: string) => void;
}

export type CandidateOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DesktopIpcRejectReason };

// 画面から起こせる操作（設計 01 気づきの操作のうち、状態を変えるもの）。
export type CandidateUserEvent = 'open' | 'dismiss' | 'snooze';

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

interface CandidateRecord {
  readonly snapshot: CandidateSnapshot;
  // 中枢が並べた順。
  readonly position: number;
}

const counts = (value: CandidateStateCounts): CandidateStateCounts => ({
  new: value.new,
  seen: value.seen,
  acted: value.acted,
  dismissed: value.dismissed,
  snoozed: value.snoozed,
  resolved: value.resolved,
});

export class CandidateBridge {
  readonly #host: CandidateHost;
  // 最新の読み取りの候補（候補 ID → 項目）と、候補 ID → 参照。参照は同じ候補のあいだ変えない。
  #records = new Map<string, CandidateRecord>();
  readonly #refs = new Map<string, string>();
  // 結果が分からなかった候補（候補 ID → そのときの読み取りの通し番号）。それより後に始めた読み取りが成功するまで操作させない。
  readonly #held = new Map<string, number>();
  #fetchedAt: string | null = null;
  #zone: string | null = null;
  #counts: CandidateStateCounts | null = null;
  #truncated = false;
  // 直近の読み取りが失敗したか。
  #failed = false;
  #gen = 0;
  // 始めた読み取りの通し番号。
  #seq = 0;
  // 画面へ渡す一覧の通し番号（読み取りが終わるたび・世代が進むたびに増える。減らない）。
  #listSeq = 1;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(host: CandidateHost) {
    this.#host = host;
  }

  // 表示の権限の世代が進んだ（ロック・切断）: 一覧・参照・保留を捨てる。進行中の読み取りは反映しない。
  reset(): void {
    this.#gen += 1;
    this.#records = new Map();
    this.#refs.clear();
    this.#held.clear();
    this.#fetchedAt = null;
    this.#zone = null;
    this.#counts = null;
    this.#truncated = false;
    this.#failed = false;
    this.#listSeq += 1;
  }

  // 画面に出す値。
  view(): DesktopCandidateView {
    const entries = [...this.#records.entries()]
      .sort((a, b) => a[1].position - b[1].position)
      .map(([candidateId, record]): DesktopCandidateEntry => {
        const snapshot = record.snapshot;
        return {
          ref: this.#refs.get(candidateId) as string,
          position: record.position,
          kind: snapshot.kind,
          state: snapshot.state,
          title: snapshot.title,
          deadline: snapshot.deadline,
          initial_import: snapshot.initial_import,
          unread_partial: snapshot.unread_partial,
          has_operations: snapshot.operation_ids.length > 0,
          delivery_unknown: this.#held.has(candidateId),
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
      zone: this.#zone,
      counts: this.#counts === null ? null : counts(this.#counts),
      entries,
      truncated: this.#truncated,
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
      path: '/v1/candidates',
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return;
    this.#listSeq += 1;
    if (
      listed.kind === 'response' &&
      listed.status === 200 &&
      this.#host.contract.valid('CandidateListResponse', listed.body)
    ) {
      this.#apply(listed.body as CandidateListResponse, seq);
      return;
    }
    // 読めなかった。前の一覧のまま、読めなかったことを画面に出す（「候補なし」の証拠にしない）。
    this.#failed = true;
    this.#host.log('candidate_list_unavailable');
  }

  // 読み取った一覧を反映する。同じ候補は同じ参照を保つ。この読み取りより前に結果が分からなくなった候補の保留は解く
  // （今の状態を読めたので、変更が当たったかどうかは一覧が示す）。
  #apply(body: CandidateListResponse, seq: number): void {
    const next = new Map<string, CandidateRecord>();
    body.candidates.forEach((snapshot, position) => {
      next.set(snapshot.candidate_id, { snapshot, position });
      if (!this.#refs.has(snapshot.candidate_id))
        this.#refs.set(snapshot.candidate_id, this.#host.newRef());
    });
    for (const key of [...this.#refs.keys()])
      if (!next.has(key)) {
        this.#refs.delete(key);
        this.#held.delete(key);
      }
    for (const [key, heldAt] of [...this.#held])
      if (heldAt < seq) this.#held.delete(key);
    this.#records = next;
    this.#fetchedAt = body.as_of;
    this.#zone = body.zone;
    this.#counts = counts(body.counts);
    this.#truncated = body.next_cursor !== null;
    this.#failed = false;
  }

  // 一覧を読み直して返す（画面を開いたとき・本人が読み直すとき）。
  async list(): Promise<CandidateOutcome<DesktopCandidateView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    if (connection === null || connection.state.commandScopeId === null)
      return fail('not_connected');
    await this.refresh();
    if (gen !== this.#gen) return fail('not_connected');
    return { ok: true, value: this.view() };
  }

  #candidateOf(ref: string): string | null {
    for (const [candidateId, candidate] of this.#refs)
      if (candidate === ref) return candidateId;
    return null;
  }

  // --- 状態の変更 ---

  async change(
    ref: string,
    event: CandidateUserEvent,
    snoozeUntil: string | null,
  ): Promise<CandidateOutcome<DesktopCandidateView>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const candidateId = this.#candidateOf(ref);
    const record =
      candidateId === null ? undefined : this.#records.get(candidateId);
    if (
      candidateId === null ||
      record === undefined ||
      this.#held.has(candidateId)
    )
      return fail('entry_not_found');
    // 再通知はいまより後の時刻だけ（正本は中枢の検査）。再通知以外に時刻を付けない。
    if (event === 'snooze') {
      if (
        snoozeUntil === null ||
        !checkSnoozeUntil(new Date(this.#host.now()).toISOString(), snoozeUntil)
          .ok
      )
        return fail('invalid_request');
    } else if (snoozeUntil !== null) return fail('invalid_request');
    const outcome = await connection.request({
      method: 'POST',
      path: `/v1/candidates/${encodeURIComponent(candidateId)}/state`,
      body: {
        event,
        expected_state: record.snapshot.state,
        snooze_until: snoozeUntil,
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 送った後に世代が変わった: 当たったかどうかを今の世代の一覧で示せないので結果不明（自動では送り直さない）。
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (outcome.kind === 'unknown') {
      this.#hold(candidateId);
      return fail('outcome_unknown');
    }
    if (
      outcome.status === 200 &&
      this.#host.contract.valid('CandidateSnapshot', outcome.body)
    ) {
      // 記録できた。読み直して件数と一覧を合わせる（読み直せなければ取得の状態が stale になる）。
      await this.refresh();
      if (gen !== this.#gen) return fail('not_connected');
      return { ok: true, value: this.view() };
    }
    // 形の違う 2xx と 5xx（中枢は保存の成否が分からないときも 503 を返す）は結果不明。読み直しで解く。
    if (
      outcome.status >= 500 ||
      (outcome.status >= 200 && outcome.status < 300)
    ) {
      this.#hold(candidateId);
      void this.refresh();
      return fail('outcome_unknown');
    }
    // 状態が変わっていた（古い画面・時間による遷移）。読み直して、新しい状態から操作し直させる。
    void this.refresh();
    return fail(outcome.status === 409 ? 'preview_stale' : 'core_rejected');
  }

  #hold(candidateId: string): void {
    this.#held.set(candidateId, this.#seq);
    this.#listSeq += 1;
    this.#host.log('candidate_state_outcome_unknown');
  }
}
