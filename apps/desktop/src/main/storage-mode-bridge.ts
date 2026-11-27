// デスクトップの main の保存モードの経路（UI-05 の段階 6、ADR 0189。設計 03 記録しない会話の境界・保存期限、ADR 0045・
// 0059・0060・0068）。
//
// - 保存モード（通常 7 日・継続相談 30 日・記録しない）の正本は中枢。main は中枢の流れの経路を読むだけで、画面へは状態欄の
//   保存モード（DesktopStatusBar の storage_mode）として渡す。読めていなければ null（不明。状態欄では「—」、島とパネルでは
//   点線の枠の「未受信」）。
// - 読む時: 接続した（live になった）・ロックを解除した・中枢の保存の区切りの知らせ（StorageBoundaryNotice）が届いた・
//   切り替えの結果が分からなかった・切り替えが拒否された・発言の後（従来の窓の会話の経路は応答に区切りを持たないため）。
//   流れへの発言の応答（区切りの保存モード）は読み直さずにそのまま使う（observe）。
// - 切り替え（change）は本人の画面操作だけ（受付は core-link が admitDesktopRequest で確かめる）。中枢へは画面操作として
//   送る（Buddy-Input-Origin: screen）。結果が分からなければ、送り直さずに読み直す（ADR 0060 の再送の扱いは request_id が
//   同じときだけ。main は送り直さないので、本人がもう一度押す）。
// - 世代（ロック・切断）: reset で値を捨て、非同期の読み取り・切り替えは世代を照合して、またいだ結果を反映しない。
// - 区切り・会話の ID・世代は持たない（中枢は返さない。UI-01 の方針）。ログは理由のコードだけ。
// Electron に依存しない（node:test で試験する）。
import type {
  StorageMode,
  StorageModeChangeResponse,
  StreamStorageModeView,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import type { DesktopContract } from './contract.js';
import type { BridgeOutcome } from './operation-bridge.js';

export interface StorageModeHost {
  readonly contract: DesktopContract;
  readonly connection: () => ClientConnection | null;
  // 画面に出す値が変わった（状態欄を作り直して通知する）。
  readonly changed: () => void;
  readonly log: (code: string) => void;
}

const fail = (
  reason: Extract<BridgeOutcome<never>, { ok: false }>['reason'],
): Extract<BridgeOutcome<never>, { ok: false }> => ({ ok: false, reason });

export class StorageModeBridge {
  readonly #host: StorageModeHost;
  #mode: StorageMode | null = null;
  // 表示の権限の世代（ロック・切断で進める）。
  #gen = 0;
  // 読み取りの通し番号。後から始めた読み取り・切り替えの結果より古い読み取りの結果を反映しない。
  #seq = 0;
  #applied = 0;

  constructor(host: StorageModeHost) {
    this.#host = host;
  }

  // 中枢の今の保存モード（読めていなければ null）。
  get mode(): StorageMode | null {
    return this.#mode;
  }

  // ロック・切断: 値を捨て、またいだ結果を反映しない。
  reset(): void {
    this.#gen += 1;
    this.#set(null, ++this.#seq);
  }

  // 中枢の今の保存モードを読む。読めなかった（送れない・結果不明・形の違う応答・拒否）ときは前の値のまま（読めなかった
  // ことを「通常」の証拠にしない。null にもしない）。
  async refresh(): Promise<void> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return;
    const seq = ++this.#seq;
    const outcome = await connection.request({
      method: 'GET',
      path: '/v1/stream/storage-mode',
      expectedScopeId: scope,
    });
    if (gen !== this.#gen) return;
    if (
      outcome.kind !== 'response' ||
      outcome.status !== 200 ||
      !this.#host.contract.valid('StreamStorageModeView', outcome.body)
    ) {
      this.#host.log(
        `storage_mode_read_failed:${outcome.kind === 'response' ? String(outcome.status) : outcome.kind}`,
      );
      return;
    }
    this.#set((outcome.body as StreamStorageModeView).storage_mode, seq);
  }

  // 流れへの発言の応答の区切りの保存モード（中枢が今の区切りを返した）。読み直さずに使う。
  observe(mode: StorageMode): void {
    this.#set(mode, ++this.#seq);
  }

  // 保存モードを切り替える（本人の画面操作。受付は呼び出し側が確かめる）。同じモードでも中枢へ送る（中枢は何も動かさず
  // 今の区切りを返す）。受け付けられたら切り替えた後の保存モードを返す。
  async change(target: StorageMode): Promise<BridgeOutcome<StorageMode>> {
    const gen = this.#gen;
    const connection = this.#host.connection();
    const scope = connection?.state.commandScopeId ?? null;
    if (connection === null || scope === null) return fail('not_connected');
    const seq = ++this.#seq;
    const outcome = await connection.request({
      method: 'POST',
      path: '/v1/stream/storage-mode',
      body: { storage_mode: target },
      scoped: true,
      screenOperation: true,
      expectedScopeId: scope,
    });
    if (outcome.kind === 'not_sent') return fail('not_connected');
    // 送った後に世代が変わった（ロック・切断）: 結果を画面へ返さない。切り替わったかは分からない。
    if (gen !== this.#gen) return fail('outcome_unknown');
    if (outcome.kind === 'unknown') {
      // 切り替わったか分からない。送り直さず、今の保存モードを読み直す（本人がもう一度押すかを決める）。
      this.#host.log('storage_mode_change_unknown');
      void this.refresh();
      return fail('outcome_unknown');
    }
    if (
      outcome.status !== 200 ||
      !this.#host.contract.valid('StorageModeChangeResponse', outcome.body)
    ) {
      // 中枢が拒否した（世代を書けない 503・規則の拒否 409・画面操作でない 403 など）。中枢は状態を動かしていないはずだが、
      // 表示を中枢の値にそろえるために読み直す。
      this.#host.log(`storage_mode_change_rejected:${String(outcome.status)}`);
      void this.refresh();
      return fail('core_rejected');
    }
    const mode = (outcome.body as StorageModeChangeResponse).segment
      .storage_mode;
    this.#set(mode, seq);
    return { ok: true, value: mode };
  }

  #set(mode: StorageMode | null, seq: number): void {
    // 後から始めた読み取り・切り替えの結果を、先に始めた読み取りの結果で戻さない。
    if (seq < this.#applied) return;
    this.#applied = seq;
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#host.changed();
  }
}
