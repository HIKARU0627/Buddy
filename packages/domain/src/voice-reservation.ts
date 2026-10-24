// Live の会話予算の追加予約の計画・予算到達の閉じ方・精算の秒数（B05-02、ADR 0041。設計 10 §2・§3・§9、
// 09 X26・X34、質問 109、J17）。秒数だけを扱う。金額は B07 の予算の規則（live_seconds の単価・最小量）が決める。
// 時刻は呼び出し側が単調時計で渡す。実際の予約・精算の保存は DB worker（B05-03）。

import { AUDIO_CONTROL_RULES } from './audio.js';

// GPT-Live-1 は接続ごとに 15 秒分の最低課金がある（公式資料。10 §2）。
export const LIVE_MIN_BILLED_SECONDS = 15;
// 接続の開始時の予約は 15 秒 + 180 秒。
export const LIVE_INITIAL_EXTRA_SECONDS = 180;
export const LIVE_INITIAL_RESERVE_SECONDS =
  LIVE_MIN_BILLED_SECONDS + LIVE_INITIAL_EXTRA_SECONDS;
// 会話中は 60 秒ごとに 60 秒分を追加予約する。
export const LIVE_TOP_UP_INTERVAL_MS = 60000;
export const LIVE_TOP_UP_SECONDS = 60;
// 予約に失敗したあと、一言伝えてから閉じるまでの上限（発話の終わりと早い方。10 §3）。
export const BUDGET_CLOSE_GRACE_MS = 10000;

export type LiveReservationAdmission =
  | { readonly ok: true }
  | {
      readonly ok: false;
      // device_precheck: 端末の最初の確認（予算の残りが 15 秒分未満）。initial_reserve: 中枢の予約（195 秒に足りない。422）。
      readonly stage: 'device_precheck' | 'initial_reserve';
      readonly code: 'budget_insufficient';
    };

// 接続を開く前の予算の確認。端末は残りが 15 秒分以上あるか（満たさなければ状態欄に理由と低い効果音だけ）、
// 中枢は 15 秒 + 180 秒を予約できるか（できなければ 422 で拒否し、端末は③へ）を見る。
export function admitLiveReservation(
  available_seconds: number,
): LiveReservationAdmission {
  if (
    !Number.isFinite(available_seconds) ||
    available_seconds < LIVE_MIN_BILLED_SECONDS
  )
    return { ok: false, stage: 'device_precheck', code: 'budget_insufficient' };
  if (available_seconds < LIVE_INITIAL_RESERVE_SECONDS)
    return { ok: false, stage: 'initial_reserve', code: 'budget_insufficient' };
  return { ok: true };
}

export interface TopUpSchedule {
  // 今までに予約済みの秒数（開始の予約 + 追加予約の回数 × 60 秒）。
  readonly reserved_seconds: number;
  // 経過時間で予約しているべきだった追加予約の回数のうち、まだ行っていない回数。
  readonly due: number;
  // 次の追加予約の時刻（接続を始めてからの経過 ms）。
  readonly next_at_ms: number;
  // 予約した秒数のうち、経過時間を引いた残り（秒）。0 以下なら予約が切れている。
  readonly coverage_seconds: number;
  readonly exhausted: boolean;
}

// 追加予約の計画。elapsed_ms は接続の予約を取ってからの経過（単調時計）、completed は成功した追加予約の回数。
// 60 秒ちょうどで 1 回目が期限になる。経過が負（時計の戻り）なら追加予約は期限になっていないとして扱う。
export function topUpSchedule(
  elapsed_ms: number,
  completed: number,
): TopUpSchedule {
  const elapsed = Number.isFinite(elapsed_ms) ? Math.max(0, elapsed_ms) : 0;
  const done = Math.max(0, Math.trunc(completed));
  const reached = Math.floor(elapsed / LIVE_TOP_UP_INTERVAL_MS);
  const reserved = LIVE_INITIAL_RESERVE_SECONDS + done * LIVE_TOP_UP_SECONDS;
  const coverage = reserved - elapsed / 1000;
  return {
    reserved_seconds: reserved,
    due: Math.max(0, reached - done),
    next_at_ms: (done + 1) * LIVE_TOP_UP_INTERVAL_MS,
    coverage_seconds: coverage,
    exhausted: coverage <= 0,
  };
}

export interface BudgetFailurePlan {
  // サイドバンドが使えるなら、instructions.append で「予算の上限に達した。会話を終えることを一言で伝え、質問を続けない」と指示する。
  readonly instruct: boolean;
  // 指示を送れない（サイドバンドが使えない）ときは、伝える相手がいないのですぐ閉じる（原本に決めなし。安全側）。
  readonly close_immediately: boolean;
  readonly close_reason: 'budget_reached';
  // 閉じたあとは③（声で話しかけて文字で返す）へ自動で切り替え、予約ができるまで①を開かない。
  readonly resume: 'local_asr_until_budget';
  readonly switch_to_local_asr: true;
}

// 追加予約に失敗したときの対応（10 §3、X26）。追加の接続要求は予算の保留で拒否される（admitLiveStart の 422）。
export function planBudgetFailure(sideband_ready: boolean): BudgetFailurePlan {
  return {
    instruct: sideband_ready,
    close_immediately: !sideband_ready,
    close_reason: 'budget_reached',
    resume: AUDIO_CONTROL_RULES.budget_reached
      .resume as 'local_asr_until_budget',
    switch_to_local_asr: true,
  };
}

// 一言伝えてから閉じる時刻。モデルの発話の終わりと、指示から 10 秒のどちらか早い方。
// 指示より前の発話の終わりは、その指示への発話ではないので使わない。
export function budgetCloseDeadline(
  instructed_at_ms: number,
  utterance_ended_at_ms: number | null,
): number {
  const limit = instructed_at_ms + BUDGET_CLOSE_GRACE_MS;
  if (
    utterance_ended_at_ms === null ||
    utterance_ended_at_ms < instructed_at_ms
  )
    return limit;
  return Math.min(limit, utterance_ended_at_ms);
}

// now が閉じる時刻に達したか（ちょうどで閉じる）。予算の上限に達した後なので、時計を信用できないとき
// （now が指示の時刻より前・直前の観測より前＝時計の逆行、または有限でない）は、10 秒以内に閉じることを数えられないので、
// 待たずに閉じる（継続できる側に倒さない。原本に決めなし。ADR 0041）。
export function shouldCloseForBudget(
  now_ms: number,
  instructed_at_ms: number,
  utterance_ended_at_ms: number | null,
  previous_observed_ms: number | null,
): boolean {
  if (
    !Number.isFinite(now_ms) ||
    now_ms < instructed_at_ms ||
    (previous_observed_ms !== null && now_ms < previous_observed_ms)
  )
    return true;
  return now_ms >= budgetCloseDeadline(instructed_at_ms, utterance_ended_at_ms);
}

export type LiveSettlement =
  | {
      readonly settled: true;
      // 精算する秒数。15 秒と確認した使用秒数の大きい方。
      readonly billable_seconds: number;
      // 最低課金の 15 秒で精算した（使用秒数がそれより短い）。
      readonly floor_applied: boolean;
      // 予約していた秒数を超えた（超えた分も全額記録する。M の検査は予算の規則）。
      readonly exceeds_reserved: boolean;
    }
  | {
      readonly settled: false;
      readonly reason: 'usage_unconfirmed' | 'usage_invalid';
      // 確認できるまで予約を解放しない。
      readonly hold_reservation: true;
    };

// 精算の秒数。精算済みにできるのは、確認した使用秒数（session.closed の usage.seconds）があるときだけ。
// 額は「15 秒と実際の時間の大きい方」。端末の close の通知だけで 0 秒・精算済みにしない（10 §2A）。
export function settleLiveSeconds(
  usage_seconds: number | null,
  reserved_seconds: number,
): LiveSettlement {
  if (usage_seconds === null)
    return {
      settled: false,
      reason: 'usage_unconfirmed',
      hold_reservation: true,
    };
  if (!Number.isInteger(usage_seconds) || usage_seconds < 0)
    return { settled: false, reason: 'usage_invalid', hold_reservation: true };
  const billable = Math.max(LIVE_MIN_BILLED_SECONDS, usage_seconds);
  return {
    settled: true,
    billable_seconds: billable,
    floor_applied: usage_seconds < LIVE_MIN_BILLED_SECONDS,
    exceeds_reserved: billable > reserved_seconds,
  };
}
