// 再接続の間隔（設計 07 §3、ADR 0025）。原本に数値がないため、初期値はこの表で決めた（レビュー対象）。
// 指数（2 倍ずつ）で増やし上限で止め、端末が同時に接続し直さないように揺らぎを掛ける。

export interface BackoffPolicy {
  // 1 回目の待ち時間。
  readonly baseMs: number;
  // 上限。
  readonly maxMs: number;
  // 揺らぎの割合（0.2 なら ±20%）。
  readonly jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 60_000,
  jitterRatio: 0.2,
};

// attempt は 0 から数える失敗の回数。random は [0, 1) の値（試験では固定の値を渡す）。
export function reconnectDelay(
  attempt: number,
  random: () => number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): number {
  const step = Math.min(Math.max(0, Math.trunc(attempt)), 30);
  const raw = Math.min(policy.maxMs, policy.baseMs * 2 ** step);
  const r = Math.min(Math.max(random(), 0), 1);
  const factor = 1 - policy.jitterRatio + 2 * policy.jitterRatio * r;
  return Math.max(0, Math.round(Math.min(policy.maxMs, raw * factor)));
}
