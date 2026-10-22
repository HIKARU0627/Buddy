// 端末ごとの開いている接続（WSS の購読）と、それを閉じる差し込み口（ADR 0023）。
//
// 端末の失効（B03-02）・自宅判定の不成立（B03-03）が closeDevice を呼び、その端末の接続を理由つきで閉じる。
// 接続の側（WSS の購読）は開いたときに register し、閉じたら戻り値の関数で外す。
// 形は B03-02・B03-03 と合わせた（同じ名前・同じ引数）。

export type DeviceCloseReason = 'device_revoked' | 'outside_home_network';

export class DeviceConnections {
  readonly #closedListeners = new Set<(deviceId: string) => void>();
  readonly #closers = new Map<
    string,
    Set<(reason: DeviceCloseReason) => void>
  >();

  // 端末の接続を登録する。戻り値の関数で外す（二度呼んでもよい）。
  register(
    deviceId: string,
    close: (reason: DeviceCloseReason) => void,
  ): () => void {
    let set = this.#closers.get(deviceId);
    if (set === undefined) {
      set = new Set();
      this.#closers.set(deviceId, set);
    }
    set.add(close);
    return () => {
      const current = this.#closers.get(deviceId);
      if (current === undefined) return;
      current.delete(close);
      if (current.size === 0) this.#closers.delete(deviceId);
    };
  }

  // 端末の接続を閉じたこと（開いている接続がなくても）を知らせる（preview の無効化、ADR 0029）。
  onDeviceClosed(listener: (deviceId: string) => void): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  // 端末の接続をすべて閉じ、閉じた数を返す。閉じる処理の失敗で他の接続を閉じ残さない。
  closeDevice(deviceId: string, reason: DeviceCloseReason): number {
    for (const listener of this.#closedListeners) {
      try {
        listener(deviceId);
      } catch {
        // 次の通知先へ進む。
      }
    }
    const set = this.#closers.get(deviceId);
    if (set === undefined) return 0;
    this.#closers.delete(deviceId);
    let closed = 0;
    for (const close of set) {
      try {
        close(reason);
        closed += 1;
      } catch {
        // 次の接続へ進む。
      }
    }
    return closed;
  }

  // 開いている接続の数（診断・試験用）。
  count(deviceId?: string): number {
    if (deviceId !== undefined) return this.#closers.get(deviceId)?.size ?? 0;
    let total = 0;
    for (const set of this.#closers.values()) total += set.size;
    return total;
  }
}
