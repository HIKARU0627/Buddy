// Live の再起動の後の照合の口（UsageReconciler。B05-04、ADR 0049。設計 10 §2A・09 X28、ADR 0037）。
//
// 予算の門の再起動の照合（BudgetGate.start）は、受付中（reserved）の予約のうち送った可能性があるもの（会話の接続を作ったものを
// 含む）を、provider の照合の口で調べる。Live の口は、予約から Live の記録を探し、provider へ live_session_id で照会して、
// 閉じていて使用秒数が分かれば、その実費（15 秒との大きい方）を返す。開いたままの孤児のセッションを閉じるのは
// VoiceControl.reconcileHeld（サイドバンドが要るため）で、ここは読み取りだけ。見つからない・まだ開いている・照会できないときは
// null を返し、予算の門は使用量不明として保持する（provider へ送り直さない。自動で解放もしない）。

import type { BudgetGate, PaidUsage, UsageReconciler } from './budget-gate.js';
import { liveUsageGross } from './live-budget.js';
import type { LiveProvider, VoiceStore } from './voice-control.js';

// provider の照会の期限（ms）。原本に決めなし（仮置き。切れたら null）。起動を止めないための上限。
export const LIVE_LOOKUP_TIMEOUT_MS = 5000;

export function createLiveUsageReconciler(input: {
  readonly gate: BudgetGate;
  readonly store: VoiceStore;
  readonly provider: LiveProvider;
  readonly timeoutMs?: number;
}): UsageReconciler {
  const limit = input.timeoutMs ?? LIVE_LOOKUP_TIMEOUT_MS;
  return {
    async lookup({ reservation_id }): Promise<PaidUsage | null> {
      const [unfinished, held] = await Promise.all([
        input.store.voice({ kind: 'voice.live_unfinished' }),
        input.store.voice({ kind: 'voice.live_held' }),
      ]);
      if (!unfinished.ok || !held.ok) return null;
      const record = [...unfinished.value, ...held.value].find(
        (item) => item.reservation_id === reservation_id,
      );
      if (record === undefined) return null;
      let timer: NodeJS.Timeout | null = null;
      const looked = await Promise.race([
        input.provider.lookupSession(record.live_session_id),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), limit);
          timer.unref();
        }),
      ]).finally(() => {
        if (timer !== null) clearTimeout(timer);
      });
      if (looked === null || looked.state !== 'closed') return null;
      const ticket = await input.gate.ticketOf(reservation_id);
      if (ticket === null || ticket === 'unavailable') return null;
      return (
        liveUsageGross(
          input.gate,
          ticket,
          record.live_session_id,
          looked.usage_seconds,
        )?.usage ?? null
      );
    },
  };
}

// 先に見つけた照合の口を使う（LLM・検索・音声の照合の口を 1 つにまとめる）。
export function combineReconcilers(
  ...reconcilers: readonly (UsageReconciler | null | undefined)[]
): UsageReconciler | undefined {
  const list = reconcilers.filter(
    (item): item is UsageReconciler => item !== null && item !== undefined,
  );
  if (list.length === 0) return undefined;
  return {
    async lookup(request) {
      for (const reconciler of list) {
        const found = await reconciler.lookup(request);
        if (found !== null) return found;
      }
      return null;
    },
  };
}
