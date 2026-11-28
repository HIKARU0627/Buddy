// デスクトップの main の記録しない会話の独立した確認の経路（ADR 0197、U503。ADR 0045・0192）。
//
// - 承認を待つ確認の一覧（GET /v1/private-confirmations）を中枢から読み、画面へは参照（ref）と、何をどう変えるか（どのメールの
//   ラベルを付ける・外すか）だけを渡す。確認の ID・内容版・内容の hash は main の中に持ち、画面へも IPC へもログへも出さない。
// - 記録しない会話の間（中枢の流れの保存モードが private と読めている間）だけ画面へ出す。出た・不明なら出さない。
// - 承認は本人の画面操作（受付は core-link が admitDesktopRequest で確かめる）の後に、main の OS の確認ダイアログを 1 回だけ
//   出す（通常の承認と同じ）。ダイアログに出す値は main が中枢の一覧から読んだ値で、画面から受け取らない。確認の前後で
//   確認が今も同じ内容か、世代（ロック・切断）・接続範囲・入出力の停止が変わっていないかを確かめ、違えば送らない。
//   口座と対象のメールを確認できない確認は承認させない（断るだけ）。断るは確認を挟まない（記録も外部変更も作らない）。
// - 結果が分からない承認・断るは、送り直さずに一覧を読み直す。それより後に始めた読み取りが成功するまで、同じ確認から送らせない。
// - 世代（ロック・切断）: reset で一覧・参照・保留を捨て、非同期の処理は世代を照合して、またいだ結果を反映しない。
// - 中枢は確認を RAM にだけ持つ（記録しない会話を出る・ロック・忘却・停止で捨てる）。main も RAM にだけ持つ。
// Electron に依存しない（node:test で試験する）。
import type {
  DesktopPrivateConfirmationEntry,
  PrivateConfirmationEntry,
  PrivateConfirmationList,
  PrivateConfirmationResult,
  StorageMode,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import type { DesktopContract } from './contract.js';
import type { BridgeOutcome } from './operation-bridge.js';

// 承認の前の OS の確認ダイアログに出す値（main が中枢の一覧から作る。画面からは受け取らない）。
export interface PrivateConfirmRequest {
  readonly action: 'approve_private_confirmation';
  readonly service: PrivateConfirmationEntry['service'];
  readonly accountLabel: string | null;
  readonly target: PrivateConfirmationEntry['target'];
  readonly labelsAdd: readonly string[];
  readonly labelsRemove: readonly string[];
}

export type PrivateConfirmResult =
  { readonly scope: string } | DesktopIpcRejectReason;

export interface PrivateConfirmationHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  readonly newRef: () => string;
  // 中枢の流れの今の保存モード（読めていなければ null）。private のときだけ画面へ出す。
  readonly storageMode: () => StorageMode | null;
  // 本人の確認（OS の確認ダイアログ）。世代・接続範囲の照合は呼び出し側が行う。
  readonly confirm: (
    request: PrivateConfirmRequest,
  ) => Promise<PrivateConfirmResult>;
  // 端末の今の入出力の状態（承認を送る直前に確かめる）。
  readonly io: () => { readonly permitted: boolean; readonly epoch: string };
  // 画面に出す値が変わった（接続の状態の通知を起こす）。
  readonly changed: () => void;
  readonly log: (code: string) => void;
}

export type PrivateDecision = PrivateConfirmationResult['result'];

const fail = (
  reason: DesktopIpcRejectReason,
): { readonly ok: false; readonly reason: DesktopIpcRejectReason } => ({
  ok: false,
  reason,
});

// 口座の表示名と対象のメール（件名か差出人）を確認できたか（通常の承認の approvable と同じ考え方）。
const approvable = (entry: PrivateConfirmationEntry): boolean =>
  entry.account_label !== null &&
  entry.target !== null &&
  (entry.target.subject !== null || entry.target.sender !== null);

const sameEntry = (
  a: PrivateConfirmationEntry,
  b: PrivateConfirmationEntry,
): boolean => JSON.stringify(a) === JSON.stringify(b);

export class PrivateConfirmationBridge {
  readonly #host: PrivateConfirmationHost;
  // 最新の読み取りの確認（確認の ID → 中枢の値）と、確認の ID → 参照。参照は同じ確認のあいだ変えない。
  #entries = new Map<string, PrivateConfirmationEntry>();
  readonly #refs = new Map<string, string>();
  // 結果が分からなかった確認（確認の ID → そのときの読み取りの通し番号）。それより後に始めた読み取りが成功するまで送らせない。
  readonly #held = new Map<string, number>();
  // 中枢が承認・断るを受け付けた確認（確認の ID → そのときの通し番号）。次の読み取りまで一覧から隠し、二重に送らせない。
  readonly #done = new Map<string, number>();
  // 承認・断るを送っている確認（OS の確認ダイアログを出している間を含む）。
  readonly #sending = new Set<string>();
  #gen = 0;
  #seq = 0;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(host: PrivateConfirmationHost) {
    this.#host = host;
  }

  // ロック・切断: 一覧・参照・保留を捨て、またいだ結果を反映しない。
  reset(): void {
    this.#gen += 1;
    this.#entries = new Map();
    this.#refs.clear();
    this.#held.clear();
    this.#done.clear();
    this.#sending.clear();
  }

  // 画面に出す確認（記録しない会話の間だけ）。
  entries(): DesktopPrivateConfirmationEntry[] {
    if (this.#host.storageMode() !== 'private') return [];
    return [...this.#entries]
      .filter(([id]) => !this.#done.has(id))
      .map(([id, entry]) => ({
        ref: this.#refs.get(id) as string,
        service: entry.service,
        account_label: entry.account_label,
        target: entry.target === null ? null : { ...entry.target },
        labels_add: [...entry.add],
        labels_remove: [...entry.remove],
        approvable: approvable(entry),
        delivery_unknown: this.#held.has(id),
      }));
  }

  // 中枢の今の一覧を読む。読めなかったときは前の一覧と保留のまま（読めなかったことを「確認なし」の証拠にしない）。
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
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/private-confirmations',
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return;
    if (
      outcome.kind !== 'response' ||
      outcome.status !== 200 ||
      !this.#host.contract.valid('PrivateConfirmationList', outcome.body)
    ) {
      this.#host.log(
        `private_confirmation_list_failed:${outcome.kind === 'response' ? String(outcome.status) : outcome.kind}`,
      );
      return;
    }
    const before = JSON.stringify(this.#view());
    const next = new Map<string, PrivateConfirmationEntry>();
    for (const entry of (outcome.body as PrivateConfirmationList)
      .confirmations) {
      // 付ける・外すラベルの両方が空、または重なる確認は意味の検査に通らない。画面に出さず、理由のコードだけを残す
      // （契約の道具の PrivateConfirmationList の意味検査と同じ）。
      if (
        (entry.add.length === 0 && entry.remove.length === 0) ||
        entry.add.some((label) => entry.remove.includes(label))
      ) {
        this.#host.log('private_confirmation_entry_invalid');
        continue;
      }
      next.set(entry.confirmation_id, entry);
      if (!this.#refs.has(entry.confirmation_id))
        this.#refs.set(entry.confirmation_id, this.#host.newRef());
    }
    for (const id of [...this.#refs.keys()])
      if (!next.has(id)) {
        this.#refs.delete(id);
        this.#held.delete(id);
        this.#done.delete(id);
      }
    for (const [id, at] of [...this.#held]) if (at < seq) this.#held.delete(id);
    for (const [id, at] of [...this.#done]) if (at < seq) this.#done.delete(id);
    this.#entries = next;
    if (JSON.stringify(this.#view()) !== before) this.#host.changed();
  }

  // 保存モードに関わらない一覧の写し（変化の検出用）。
  #view(): unknown {
    return [...this.#entries.keys()].map((id) => [
      this.#refs.get(id),
      this.#entries.get(id),
      this.#held.has(id),
      this.#done.has(id),
    ]);
  }

  #idOf(ref: string): string | null {
    for (const [id, candidate] of this.#refs) if (candidate === ref) return id;
    return null;
  }

  // 承認する・断る（本人の画面操作。受付は呼び出し側が確かめる）。
  async decide(
    ref: string,
    decision: 'approve' | 'decline',
  ): Promise<BridgeOutcome<PrivateDecision>> {
    // 同じ確認を送っている間（OS の確認ダイアログを出している間を含む）の 2 回目は、ダイアログを出さず送らない。
    const id = this.#idOf(ref);
    if (id !== null && this.#sending.has(id))
      return fail('confirmation_pending');
    if (id !== null) this.#sending.add(id);
    try {
      return await this.#decide(id, decision);
    } finally {
      if (id !== null) this.#sending.delete(id);
    }
  }

  async #decide(
    id: string | null,
    decision: 'approve' | 'decline',
  ): Promise<BridgeOutcome<PrivateDecision>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    // 記録しない会話の外では出さない確認なので、送らない。
    if (this.#host.storageMode() !== 'private') return fail('entry_not_found');
    const entry = id === null ? undefined : this.#entries.get(id);
    if (
      id === null ||
      entry === undefined ||
      this.#held.has(id) ||
      this.#done.has(id)
    )
      return fail('entry_not_found');
    if (decision === 'approve') {
      // 口座と対象のメールを確認できない確認は承認させない（画面も承認を出さない）。中枢は何も受けていないので、拒否の理由は
      // 内容を確かめられないこと（content_unavailable）にする。
      if (!approvable(entry)) return fail('content_unavailable');
      // 承認は外部変更につながるので、停止していないときだけ。確認は本人が 1 回だけ。
      const io = this.#host.io();
      if (!io.permitted) return fail('input_stopped');
      const confirmed = await this.#host.confirm({
        action: 'approve_private_confirmation',
        service: entry.service,
        accountLabel: entry.account_label,
        target: entry.target === null ? null : { ...entry.target },
        labelsAdd: [...entry.add],
        labelsRemove: [...entry.remove],
      });
      if (gen !== this.#gen) return fail('not_connected');
      const live = this.#host.connection();
      if (live === null || live.state.commandScopeId !== scope)
        return fail('not_connected');
      const now = this.#host.io();
      if (!now.permitted || now.epoch !== io.epoch)
        return fail('input_stopped');
      if (typeof confirmed === 'string') return fail(confirmed);
      // 確認している間に確認が変わった・消えた・送った・保留になったら送らない。
      const current = this.#entries.get(id);
      if (
        current === undefined ||
        !sameEntry(current, entry) ||
        this.#held.has(id) ||
        this.#done.has(id) ||
        this.#host.storageMode() !== 'private'
      )
        return fail('preview_stale');
    }
    const live = this.#host.connection();
    if (live === null) return fail('not_connected');
    const outcome = await live.request({
      method: 'POST',
      path: `/v1/private-confirmations/${encodeURIComponent(id)}/${decision}`,
      body:
        decision === 'approve'
          ? {
              content_version: entry.content_version,
              content_hash: entry.content_hash,
            }
          : {},
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    if (gen !== this.#gen) return fail('outcome_unknown');
    // 届いたか・中枢で何が起きたか分からない（接続が切れた・5xx・202 なのに形の違う応答）。送り直さず、一覧を読み直すまで
    // 同じ確認から送らせない。
    if (
      outcome.kind === 'unknown' ||
      outcome.status >= 500 ||
      (outcome.status === 202 &&
        !this.#host.contract.valid('PrivateConfirmationResult', outcome.body))
    ) {
      this.#held.set(id, this.#seq);
      this.#host.log(
        `private_confirmation_outcome_unknown:${outcome.kind === 'unknown' ? 'unknown' : String(outcome.status)}`,
      );
      this.#host.changed();
      void this.refresh();
      return fail('outcome_unknown');
    }
    if (outcome.status !== 202) {
      // 中枢が断った（取り下げた・捨てた・他の端末・内容の違い・口が閉じている）。一覧を中枢の値にそろえる。
      this.#host.log(`private_confirmation_rejected:${String(outcome.status)}`);
      void this.refresh();
      return fail('core_rejected');
    }
    const result = (outcome.body as PrivateConfirmationResult).result;
    this.#done.set(id, this.#seq);
    this.#host.log(`private_confirmation_${result}`);
    this.#host.changed();
    void this.refresh();
    return { ok: true, value: result };
  }
}
