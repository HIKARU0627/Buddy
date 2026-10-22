// 発行した preview の記録（設計 07 §2・§3、01 承認画面の必須内容、ADR 0029）。
//
// - preview は端末・接続範囲・操作・内容版・content_hash と、外部変更なら連携の口座と許可の版に結び付ける。
// - Core のメモリーにだけ置く。中枢の再起動で preview はすべて無効になる（DB に正本を置かない）。
// - 無効にするのは: 端末の接続の終了（失効・自宅判定の不成立）・ロック（ロック中・不明の申告）・新しい preview の
//   発行（同じ端末・同じ操作の古いもの）。内容の変更・接続範囲の変更・許可の版の変更は、承認のときの照合
//   （api-turns.ts の previewValid）で無効と判定する。
// - preview は承認ではない。承認の可否の最終の判定は DB worker の operation.approve（approvalDecision）。

export interface PreviewBinding {
  readonly preview_id: string;
  readonly device_id: string;
  readonly command_scope_id: string;
  readonly operation_id: string;
  readonly content_version: string;
  readonly content_hash: string;
  // 外部変更（RemoteMutation）の連携の口座と許可の版。LocalCommand は null。
  readonly account: {
    readonly account_id: string;
    readonly permission_revision: string;
  } | null;
  readonly issued_at: number;
}

export class PreviewRegistry {
  readonly #byId = new Map<string, PreviewBinding>();

  // 発行する。同じ端末・同じ操作の古い preview は無効にする（最後に見せた内容だけを承認に使う）。
  issue(binding: PreviewBinding): void {
    for (const [id, existing] of this.#byId)
      if (
        existing.device_id === binding.device_id &&
        existing.operation_id === binding.operation_id
      )
        this.#byId.delete(id);
    this.#byId.set(binding.preview_id, binding);
  }

  get(previewId: string): PreviewBinding | null {
    return this.#byId.get(previewId) ?? null;
  }

  // 端末の preview をすべて無効にし、無効にした数を返す（接続の終了・ロック）。
  invalidateDevice(deviceId: string): number {
    let removed = 0;
    for (const [id, existing] of this.#byId)
      if (existing.device_id === deviceId) {
        this.#byId.delete(id);
        removed += 1;
      }
    return removed;
  }

  // 有効な preview の数（診断・試験用）。
  count(): number {
    return this.#byId.size;
  }
}
