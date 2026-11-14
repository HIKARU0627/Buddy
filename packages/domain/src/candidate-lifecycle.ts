// 気づき（候補）の時間による遷移・根拠の失効・保持の段階（設計 11 §4・§5B、設計 03 保存と忘却、ADR 0073・0116）。
// 時計は引数で注入する。DB・外部へは触れず、「どの遷移を起こすか」「いまどの段階か」を返すだけで、
// 遷移の実行と削除は B11-03・B11-04 が持つ。

import {
  candidateDeadlineEnded,
  type CandidateOrderItem,
} from './candidate-order.js';
import {
  isCandidateZone,
  parseCandidateUtc as parseUtc,
} from './candidate-time.js';
import {
  CANDIDATE_CONTENT_RETENTION_DAYS,
  CANDIDATE_IDENTIFIER_RETENTION_DAYS,
  type CandidateEvent,
  type CandidateState,
} from './candidate.js';

const DAY_MS = 86_400_000;

// --- 時間による遷移 ---

export interface CandidateClockInput {
  readonly state: CandidateState;
  readonly deadline: CandidateOrderItem['deadline'];
  readonly initial_import: boolean;
  // 候補を作った UTC 時刻。初回取り込みの過去の期限（作った時にすでに過ぎていたもの）を見分ける。
  readonly created_at: string;
  // スヌーズの再通知の UTC 時刻。`snoozed` のときだけ使う。Core が持つ。
  readonly snooze_until: string | null;
}

export type CandidateDueResult =
  | { readonly ok: true; readonly event: CandidateEvent | null }
  | { readonly ok: false; readonly reason: 'now_invalid' | 'zone_invalid' };

// 時計だけで起こす遷移を 1 つ返す。期限切れ（deadline_passed）がスヌーズの終わりより先で、
// 期限が過ぎた候補を new に戻さない。dismissed・resolved は終端で、何も起こさない。
// 初回取り込みで、作った時にすでに過ぎていた期限は、期限切れで自動に解決しない（U274。本人が操作するまで残る）。
export function candidateDueEvent(
  candidate: CandidateClockInput,
  now: string,
  zone: string,
): CandidateDueResult {
  const nowMillis = parseUtc(now);
  if (nowMillis === null) return { ok: false, reason: 'now_invalid' };
  // タイムゾーンが読めないときは、端末の既定へ置き換えず拒む。
  if (!isCandidateZone(zone)) return { ok: false, reason: 'zone_invalid' };
  if (candidate.state === 'dismissed' || candidate.state === 'resolved')
    return { ok: true, event: null };

  const ended = candidateDeadlineEnded(candidate.deadline, nowMillis, zone);
  if (ended === true) {
    const createdMillis = parseUtc(candidate.created_at);
    // 作った時刻が読めない初回取り込みは、解決せず残す側へ倒す（候補を黙って消さない）。
    const pastAtCreation =
      candidate.initial_import &&
      (createdMillis === null ||
        candidateDeadlineEnded(candidate.deadline, createdMillis, zone) ===
          true);
    if (!pastAtCreation) return { ok: true, event: 'deadline_passed' };
  }
  if (candidate.state === 'snoozed') {
    const until = parseUtc(candidate.snooze_until);
    // 再通知の時刻が欠けている・読めないスヌーズは、隠れたままにせず new に戻す（U276）。
    if (until === null || until <= nowMillis)
      return { ok: true, event: 'snooze_elapsed' };
  }
  return { ok: true, event: null };
}

export type SnoozeCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'now_invalid' | 'until_invalid' | 'not_in_future';
    };

// スヌーズの再通知の時刻は、いまより後の UTC 時刻だけ。上限は原本に決めがなく置かない。
export function checkSnoozeUntil(now: string, until: string): SnoozeCheck {
  const nowMillis = parseUtc(now);
  if (nowMillis === null) return { ok: false, reason: 'now_invalid' };
  const untilMillis = parseUtc(until);
  if (untilMillis === null) return { ok: false, reason: 'until_invalid' };
  return untilMillis > nowMillis
    ? { ok: true }
    : { ok: false, reason: 'not_in_future' };
}

// --- 根拠の失効 ---

// 根拠を許可範囲から取り直したときに観測した結果。
export const EVIDENCE_OBSERVATIONS = [
  // 元情報があり、候補を作った版のまま。
  'available',
  // 同じ依頼の元情報が新しい版になった（期限・内容の訂正）。
  'revised',
  // 取得範囲から外れた（フォルダー・ラベル・カレンダーの選択の解除、窓の外）。
  'out_of_scope',
  // 元情報が削除された・見つからない。
  'removed',
  // 取り直せない（接続の失敗・予算待ち・本文キャッシュの期限切れで再取得待ち）。
  'temporarily_unavailable',
  // 本人が忘却を指示し、元情報が消された。
  'forgotten',
] as const;
export type EvidenceObservation = (typeof EVIDENCE_OBSERVATIONS)[number];

export interface EvidenceDecision {
  // 状態の遷移。無ければ null。
  readonly event: CandidateEvent | null;
  // 根拠の扱い。valid のときだけ自動実行などの資格を引き継げる。
  readonly evidence: 'valid' | 'refresh_required' | 'unconfirmed' | 'gone';
  // 候補の題・抄録・識別子を忘却の計画で物理削除するか。
  readonly purge: boolean;
}

const NO_CHANGE_STATES: readonly CandidateState[] = ['dismissed', 'resolved'];

// 根拠の取り直しの結果を、候補の状態と根拠の扱いへ変える（設計 11 §4・§5B 5）。
// - 取得範囲外・削除: 活動中の候補は resolved（元情報が取得範囲から外れた）。
// - 版が変わった: 状態は変えず、新しい版から作り直すまで資格を失効する（U275）。
// - 取り直せない: 状態を変えず、根拠は未確認にして資格を失効する。保留であり、解決しない（U275）。
// - 忘却: 状態の遷移でなく、題・抄録・識別子の物理削除。状態を残さない。
// dismissed・resolved は終端で、観測では状態を動かさない（根拠の扱いだけ返す）。
export function evidenceDecision(
  state: CandidateState,
  observation: EvidenceObservation,
): EvidenceDecision {
  const terminal = NO_CHANGE_STATES.includes(state);
  switch (observation) {
    case 'available':
      return { event: null, evidence: 'valid', purge: false };
    case 'revised':
      return { event: null, evidence: 'refresh_required', purge: false };
    case 'temporarily_unavailable':
      return { event: null, evidence: 'unconfirmed', purge: false };
    case 'out_of_scope':
    case 'removed':
      return {
        event: terminal ? null : 'source_out_of_scope',
        evidence: 'gone',
        purge: false,
      };
    case 'forgotten':
      return { event: null, evidence: 'gone', purge: true };
  }
}

// --- 保持の段階 ---

export type CandidateRetentionPhase =
  // 活動中（new・seen・acted・snoozed）。期限を切らない。
  | 'active'
  // resolved・dismissed から 7 日まで。題・抄録を残す。
  | 'content_kept'
  // 7 日以降 97 日まで。題・抄録を消し、notification_key と状態だけ残す。
  | 'identifier_only'
  // 97 日以降。行ごと消す。
  | 'delete';

// いまの保持の段階。境界は掃除の規則と同じく「期限 ≦ いま」で期限切れ。
// 状態を変えた時刻が読めないときは、個人の内容は消す側へ倒す（identifier_only）。識別子は残して再通知を防ぐ。
export function candidateRetentionPhase(
  state: CandidateState,
  changedAt: string,
  now: string,
): CandidateRetentionPhase {
  if (state !== 'dismissed' && state !== 'resolved') return 'active';
  const changed = parseUtc(changedAt);
  const nowMillis = parseUtc(now);
  if (changed === null || nowMillis === null) return 'identifier_only';
  if (nowMillis < changed + CANDIDATE_CONTENT_RETENTION_DAYS * DAY_MS)
    return 'content_kept';
  const identifierEnd =
    changed +
    (CANDIDATE_CONTENT_RETENTION_DAYS + CANDIDATE_IDENTIFIER_RETENTION_DAYS) *
      DAY_MS;
  return nowMillis < identifierEnd ? 'identifier_only' : 'delete';
}
