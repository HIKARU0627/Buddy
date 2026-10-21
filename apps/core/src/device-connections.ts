// 端末ごとの開いている接続（WSS など）を閉じる差し込み口（ADR 0021）。
//
// 端末の失効（B03-02）・自宅判定の不成立（B03-03）で、その端末の接続を閉じる。接続を開く側（WSS の配信、
// B03-04）は開いたときに register し、閉じたら戻り値の関数で外す。閉じる処理は理由を受け取り、
// WebSocket の閉じるコードなどへ写す。閉じる処理の失敗で他の接続の処理を止めない。

export type DeviceCloseReason = 'device_revoked' | 'outside_home_network';

export class DeviceConnections {
  readonly #byDevice = new Map<
    string,
    Set<(reason: DeviceCloseReason) => void>
  >();

  // 端末の接続を登録する。戻り値を呼ぶと登録を外す（何度呼んでもよい）。
  register(
    deviceId: string,
    close: (reason: DeviceCloseReason) => void,
  ): () => void {
    let closers = this.#byDevice.get(deviceId);
    if (closers === undefined) {
      closers = new Set();
      this.#byDevice.set(deviceId, closers);
    }
    // 同じ関数を二度登録しても一つとして扱うため、登録ごとに包む。
    const entry = (reason: DeviceCloseReason) => close(reason);
    closers.add(entry);
    return () => {
      const current = this.#byDevice.get(deviceId);
      if (current === undefined) return;
      current.delete(entry);
      if (current.size === 0) this.#byDevice.delete(deviceId);
    };
  }

  // 端末の接続をすべて閉じ、登録を外す。閉じた数を返す。
  closeDevice(deviceId: string, reason: DeviceCloseReason): number {
    const closers = this.#byDevice.get(deviceId);
    if (closers === undefined) return 0;
    this.#byDevice.delete(deviceId);
    let closed = 0;
    for (const close of closers) {
      closed += 1;
      try {
        close(reason);
      } catch {
        // 閉じる処理の失敗で他の接続を残さない。
      }
    }
    return closed;
  }

  // 登録している接続の数（試験・診断用）。
  count(deviceId: string): number {
    return this.#byDevice.get(deviceId)?.size ?? 0;
  }
}
