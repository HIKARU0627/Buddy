// Live（音声会話）の予算の門への境界（B05-04、ADR 0049。設計 10 §2・§3、05 の音声の費用、ADR 0035・0037・0042）。
//
// VoiceControl（voice-control.ts）が呼ぶ LiveBudgetPort を、予算の門（BudgetGate）の上に作る。秒数だけを受け取り、金額は門の
// 単価の版（予約の受付で固定した版）で求める。
// - 予約: 15 秒 + 180 秒を live_seconds の量として受け付ける（枠・上限・クレジットを使わない音声の検査は門と DB が行う）。
//   本人の依頼の起点で、音声の枠へ計上する（経路は設定の routing。音声は LLM・検索の枠から補わない）。
// - 追加予約: 60 秒分の追加の最大負担 M と予約 R を、同じ予約の行へ版の compare-and-set で足す（門の topUp）。
// - 精算: 確認した使用秒数（最低課金 15 秒との大きい方）を実費にして、照合 ID を Live の ID から決めて一度だけ精算する。
//   同じ照合 ID・同じ金額の再精算は変化なし、違う金額は settlement_conflict で拒否される（二重に数えない）。
// - 送出意図・解放・保持は門へそのまま渡す。結果が分からないときは自動で送り直さない。

import { settleLiveSeconds } from '@buddy/domain';
import type { BudgetGate, BudgetTicket, PaidUsage } from './budget-gate.js';
import type { LiveBudgetPort } from './voice-control.js';

// 精算の provider 名。実費の照合 ID は Live の ID から決めるので、同じ Live の精算は何度呼んでも 1 回にしかならない。
export const LIVE_PROVIDER_NAME = 'openai-live';
// 会話の最長（接続中の通話は 2 時間まで。設計 10 の確認した事実）。課金され得る期間の終わりに使う。
export const LIVE_SESSION_MAX_MS = 7_200_000;

export interface LiveBudgetProfile {
  // 予算の記録に残す profile（会話の接続の設定の版を結び付ける）。
  readonly profile_id: string;
  readonly profile_revision: string;
  // 単価の系列（PriceVersion.price_key）。live_seconds の単価がある系列。
  readonly price_key: string;
}

export const DEFAULT_LIVE_PROFILE_ID = 'live.gpt-live-1';
export const DEFAULT_LIVE_PROFILE_REVISION = '1';

export const liveReconciliationId = (liveSessionId: string): string =>
  `live:${liveSessionId}`;

// 確認した使用秒数から、精算する金額（実費）を求める。使用秒数が確認できない・不正・金額を求められないときは null。
export function liveUsageGross(
  gate: BudgetGate,
  ticket: BudgetTicket,
  liveSessionId: string,
  usageSeconds: number | null,
): { readonly usage: PaidUsage; readonly billable_seconds: number } | null {
  // 精算してよい秒数かの判定は domain の規則（15 秒と使用秒数の大きい方）。reserved_seconds は照会の項目で、精算の可否には関係しない。
  const settlement = settleLiveSeconds(usageSeconds, 0);
  if (!settlement.settled) return null;
  const amount = gate.liveSecondsAmount(
    ticket,
    settlement.billable_seconds,
    'actual',
  );
  if (!amount.ok) return null;
  return {
    billable_seconds: settlement.billable_seconds,
    usage: {
      kind: 'usage',
      provider: LIVE_PROVIDER_NAME,
      reconciliation_id: liveReconciliationId(liveSessionId),
      actual_gross: amount.amount,
    },
  };
}

export function createLiveBudget(
  gate: BudgetGate,
  profile: LiveBudgetProfile,
): LiveBudgetPort {
  return {
    async reserve({ request_id, seconds }) {
      const admitted = await gate.admit({
        request_id,
        origin: 'owner_request',
        service: 'voice',
        profile_id: profile.profile_id,
        profile_revision: profile.profile_revision,
        price_key: profile.price_key,
        quantities: { live_seconds: String(seconds) },
        timeout_ms: LIVE_SESSION_MAX_MS,
      });
      return admitted.ok
        ? {
            ok: true,
            reservation_id: admitted.ticket.reservation_id,
            ticket: admitted.ticket,
          }
        : { ok: false, budget_held: admitted.budgetHeld };
    },
    async dispatch(ticket) {
      const result = await gate.dispatch(ticket as BudgetTicket);
      return result.ok
        ? { ok: true, uncertain: false }
        : { ok: false, uncertain: result.uncertain };
    },
    async release(ticket) {
      await gate.release(ticket as BudgetTicket);
    },
    async topUp(ticket, seconds) {
      const current = ticket as BudgetTicket;
      const amount = gate.liveSecondsAmount(current, seconds, 'increment');
      if (!amount.ok) return { ok: false, reasons: amount.reasons };
      const grown = await gate.topUp(current, {
        reserved: amount.amount,
        max_liability: amount.amount,
      });
      return grown.ok
        ? { ok: true, ticket: grown.ticket }
        : { ok: false, reasons: grown.reasons };
    },
    async settle(ticket, { live_session_id, usage_seconds }) {
      const gross = liveUsageGross(
        gate,
        ticket as BudgetTicket,
        live_session_id,
        usage_seconds,
      );
      if (gross === null) return { ok: false, reasons: ['usage_not_priced'] };
      const settled = await gate.settle(ticket as BudgetTicket, gross.usage);
      return settled.ok
        ? { ok: true, duplicate: settled.duplicate }
        : { ok: false, reasons: settled.reasons };
    },
    async hold(ticket) {
      await gate.unknown(ticket as BudgetTicket);
    },
    async ticketOf(reservationId) {
      return gate.ticketOf(reservationId);
    },
  };
}
