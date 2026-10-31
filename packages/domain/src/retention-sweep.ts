// 保存期限の掃除の計画（設計 03 保存期限・今回選ぶ会話以外の運用データの扱い・忘却と再取り込み、ADR 0010・0032・0040、B06-02）。
// 時計は引数で注入し、DB・ファイル・外部へは触れない。何を消すか・何を残すか・なぜ残すかを返すだけで、削除の実行（transaction・
// 外部キーの順序・secure_delete）は B06-06 の DB worker が持つ。期限は延ばさない。迷ったら、個人の内容は消す・使わない側、
// 予算の記録は消さない側へ倒す（J4・J5、03 の「混在部分を分離できなければ短い期限」）。
// 原本に決めがないこと（時計の巻き戻りの解消の条件・掃除の間隔・巻き戻りの許容幅など）は docs/b00/contract-map.md の U53〜U57 に記録した。

import { AMOUNT_PATTERN, budgetMonthStart } from './budget-rules.js';
import {
  MEMORY_DELETE_AFTER_REVIEW_DAYS,
  applyMemoryEvent,
  type MemorySchedule,
} from './memory.js';
import { RETENTION_RULES, type RetentionRule } from './retention.js';
import type { OperationState } from './operations.js';

// --- 時刻の読み取り ---

const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/u;

// UTC の RFC 3339 だけを受け付ける。読めない時刻・暦にない日付（2 月 30 日は Date.parse が 3 月 2 日にしてしまう）は
// null（緩い読み取りで期限を黙って延ばさない）。
function parseUtc(time: unknown): number | null {
  if (typeof time !== 'string' || !UTC_TIME.test(time)) return null;
  const millis = Date.parse(time);
  if (Number.isNaN(millis)) return null;
  // 日付・時刻の部分が、読み取った後の値と同じであること（繰り上がりを拒否する）。
  return new Date(millis).toISOString().slice(0, 19) === time.slice(0, 19)
    ? millis
    : null;
}

const toIso = (millis: number): string =>
  new Date(millis).toISOString().replace('.000Z', 'Z');

const earliest = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.min(...values);

// --- 時計 ---

export type ClockCheck =
  | {
      readonly ok: true;
      // 'regressed' は now が最終確認時刻より前（時計が巻き戻った）。
      readonly state: 'ok' | 'regressed';
      // 期限の判定に使う時刻。巻き戻っても now には戻らず、最終確認時刻を使う（期限を延ばさない）。
      readonly effective_now: string;
      // 次に保存する最終確認時刻。戻らない（now と今の最終確認時刻の遅い方）。
      readonly next_last_checked_at: string;
      readonly regressed_by_ms: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid_now' | 'invalid_last_checked_at';
    };

// 時計の巻き戻りの判定（03 保存期限）。「大きく」の幅は原本に決めがなく、許容幅は置かない（少しの巻き戻りでも
// 最終確認時刻に追いつくまで自動利用を止める。追いつけば自然に解ける）。最終確認時刻が読めないときは、時計を信じず止める。
export function checkClock(
  now: string,
  lastCheckedAt: string | null,
): ClockCheck {
  const nowMillis = parseUtc(now);
  if (nowMillis === null) return { ok: false, reason: 'invalid_now' };
  let last: number | null = null;
  if (lastCheckedAt !== null) {
    last = parseUtc(lastCheckedAt);
    if (last === null) return { ok: false, reason: 'invalid_last_checked_at' };
  }
  const effective = last === null ? nowMillis : Math.max(nowMillis, last);
  return {
    ok: true,
    state: effective > nowMillis ? 'regressed' : 'ok',
    effective_now: toIso(effective),
    next_last_checked_at: toIso(effective),
    regressed_by_ms: effective - nowMillis,
  };
}

// --- 期限の計算 ---

// 定義済みの規則だけを返す。`constructor`・`toString`・`__proto__` のような継承されたプロパティ名は未知の規則（undefined）。
function ruleOf(ruleId: string): RetentionRule | undefined {
  return Object.hasOwn(RETENTION_RULES, ruleId)
    ? RETENTION_RULES[ruleId]
    : undefined;
}

// 保存した期限と、起点＋規則から求めた期限のうち早い方。保存した期限が規則より遅いとき（延ばされたとき）は規則に戻す。
// どちらも読めなければ null。
export function clampedDeadline(
  ruleId: string,
  anchorAt: string | null,
  storedDeleteAt: string | null,
): {
  readonly delete_at: string;
  readonly clamped: boolean;
} | null {
  const rule = ruleOf(ruleId);
  if (rule === undefined || rule.months !== undefined) return null;
  const anchor = anchorAt === null ? null : parseUtc(anchorAt);
  const computed = anchor === null ? null : anchor + rule.ms;
  const stored = storedDeleteAt === null ? null : parseUtc(storedDeleteAt);
  const best = earliest(
    [computed, stored].filter((value): value is number => value !== null),
  );
  if (best === null) return null;
  return {
    delete_at: toIso(best),
    clamped: computed !== null && stored !== null && stored > computed,
  };
}

// 派生物（要約・気づきの抄録・抽出結果など）の期限は、由来の期限のうち最も早いもの（ADR 0032、03）。
// 由来がない・読めない由来がある派生物は期限を決められない（null）。作ってはならず、すでにあるなら期限切れとして扱う（ADR 0040）。
export function derivedDeadline(
  originDeadlines: readonly string[],
): string | null {
  if (originDeadlines.length === 0) return null;
  const millis: number[] = [];
  for (const deadline of originDeadlines) {
    const parsed = parseUtc(deadline);
    if (parsed === null) return null;
    millis.push(parsed);
  }
  const first = earliest(millis);
  return first === null ? null : toIso(first);
}

export interface SummaryMaterial {
  readonly origin_id: string;
  readonly expires_at: string;
}

// 要約し直すときの期限。期限内（now が期限より前）の材料だけを使い、前の要約の期限があればそれも上限にする。
// 何回し直しても期限は伸びない。期限内の材料がなければ null（作らない）。期限ちょうどの材料は切れている。
export function resummarizedDeadline(input: {
  readonly now: string;
  readonly previous_delete_at: string | null;
  readonly materials: readonly SummaryMaterial[];
}): { readonly delete_at: string; readonly origin_ids: string[] } | null {
  const now = parseUtc(input.now);
  if (now === null) return null;
  const usable = input.materials.filter((material) => {
    const expires = parseUtc(material.expires_at);
    return expires !== null && expires > now;
  });
  if (usable.length === 0) return null;
  const candidates = usable.map((material) => Date.parse(material.expires_at));
  if (input.previous_delete_at !== null) {
    const previous = parseUtc(input.previous_delete_at);
    // 前の要約が期限切れ・読めないなら、それを材料にしない（上限にもしない。材料の期限がそのまま上限）。
    if (previous !== null && previous > now) candidates.push(previous);
  }
  const first = earliest(candidates);
  if (first === null) return null;
  return {
    delete_at: toIso(first),
    origin_ids: [...new Set(usable.map((material) => material.origin_id))],
  };
}

export type TurnStorageMode = 'normal' | 'extended' | 'private';

// 保存モードを変えたときの、すでにある発言の期限。期限は延ばさない（03 の「継続や再開で古い発言の期限を伸ばさない」）。
// 保存した期限と、新しい規則（normal 7 日・extended 30 日）で起点から求めた期限の早い方。記録しない会話への切り替えは
// 前の発言の期限に触れない（記録しない会話は保存しないので、その区切りの発言はもともとない）。保存した期限が読めないときは
// 最も短い規則（normal）で求める。
export function deadlineAfterModeChange(input: {
  readonly created_at: string;
  readonly stored_delete_at: string | null;
  readonly to: TurnStorageMode;
}): { readonly delete_at: string | null } {
  const stored =
    input.stored_delete_at === null ? null : parseUtc(input.stored_delete_at);
  const created = parseUtc(input.created_at);
  const shortest =
    created === null
      ? null
      : created + (RETENTION_RULES['turn_normal']?.ms ?? 0);
  const base = stored ?? shortest;
  if (input.to === 'private')
    return { delete_at: base === null ? null : toIso(base) };
  const rule =
    RETENTION_RULES[input.to === 'extended' ? 'turn_extended' : 'turn_normal'];
  const computed =
    created === null || rule === undefined ? null : created + rule.ms;
  const best = earliest(
    [base, computed].filter((value): value is number => value !== null),
  );
  return { delete_at: best === null ? null : toIso(best) };
}

// --- 予算の記録（J4） ---

export const BUDGET_RECORD_RETENTION_MONTHS = 13;

function addMonths(month: string, count: number): string | null {
  const match = /^([0-9]{4})-(0[1-9]|1[0-2])$/u.exec(month);
  if (match === null) return null;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + count;
  const year = Math.floor(index / 12);
  if (year < 1970 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// 予算月 month（その月のタイムゾーンで締める）の記録を消してよくなる時刻。月の締め（次の予算月の始まり）から 13 か月後
// ＝ 14 か月後の月の始まり。暦（夏時間を含む）はタイムゾーンで求める。求められないとき（不正なタイムゾーン・範囲の外）は null。
export function budgetRecordDeleteAt(
  month: string,
  timeZone: string,
): string | null {
  const target = addMonths(month, 1 + BUDGET_RECORD_RETENTION_MONTHS);
  if (target === null) return null;
  const start = budgetMonthStart(target, timeZone);
  const millis = start === null ? null : parseUtc(start);
  return millis === null ? null : toIso(millis);
}

export interface BudgetReservationRow {
  readonly reservation_id: string;
  readonly status: 'reserved' | 'usage_unknown' | 'settled' | 'released';
  // 10 進文字列。settled のとき実費、M は最大負担。
  readonly actual_gross: string | null;
  readonly max_liability: string;
  readonly overrun_reviewed: boolean;
  // この予約を指す行（外部キーの順序で先に消す）。
  readonly live_session_ids: readonly string[];
  readonly approval_ids: readonly string[];
}

// 金額は契約の Amount（budget-rules.ts の AMOUNT_PATTERN。先頭ゼロのない非負の 10 進整数・18 桁まで）。空文字・符号・空白・小数・19 桁以上は不正。
const AMOUNT = AMOUNT_PATTERN;

// 消してよい状態か（J4）。精算済み・解放済みで、M 超過の確認が済んでいる（または実費が M 以内）もの。
// reserved・usage_unknown・M 超過の確認待ちは、手で精算（確認）するまで消さない。実費・最大負担が契約の金額として読めない行は、
// 確認済みのフラグより先に拒否する（読めない金額の月を消して使用額が少なく見えるのを防ぐ）。
export function budgetReservationDeletable(row: BudgetReservationRow): boolean {
  if (typeof row.max_liability !== 'string' || !AMOUNT.test(row.max_liability))
    return false;
  if (
    row.actual_gross !== null &&
    (typeof row.actual_gross !== 'string' || !AMOUNT.test(row.actual_gross))
  )
    return false;
  if (row.status === 'released') return true;
  if (row.status !== 'settled' || row.actual_gross === null) return false;
  return (
    row.overrun_reviewed ||
    BigInt(row.actual_gross) <= BigInt(row.max_liability)
  );
}

// --- 掃除の入力 ---

export interface TimedRow {
  readonly family: 'timed';
  // RETENTION_RULES の ID（行を書いたときの規則。今の保存モードではなく、書いたときの規則で数える）。
  readonly rule: string;
  readonly id: string;
  readonly anchor_at: string | null;
  readonly delete_at: string | null;
  // 自動実行の取り消しの行（undo_window）で、補償の操作がまだ終わっていないとき。終わるまで残す。
  readonly compensation_open?: boolean;
}

export interface MemoryRow {
  readonly family: 'memory';
  readonly id: string;
  readonly status: 'active' | 'review_pending' | 'deleted';
  readonly review_at: string;
  readonly delete_at: string | null;
}

export interface DerivedOrigin {
  readonly origin_id: string;
  // 由来の期限。由来がすでに消えているときは null（存在しない由来は期限切れ。ADR 0040）。
  readonly expires_at: string | null;
}

export interface DerivedRow {
  readonly family: 'derived';
  // carried_summary（つないだ要約。知らせの対象）か、ほかの派生物（要約・抄録・抽出結果など）。
  readonly artifact_kind: 'carried_summary' | 'other';
  readonly id: string;
  readonly origins: readonly DerivedOrigin[];
  // 派生物自身の保存した期限（作る・要約し直すときに決めた値）。今の由来の最も早い期限との小さい方で判定する。
  // 再要約で前の要約の期限を上限にした値が、由来だけからの計算し直しで失われないようにする。まだ決めていなければ null。
  readonly delete_at: string | null;
}

const COMPLETED_STATES: readonly OperationState[] = [
  'succeeded',
  'not_executed',
  'cancelled',
  'superseded',
];

export interface OperationRow {
  readonly family: 'operation';
  readonly id: string;
  readonly operation_state: OperationState;
  readonly completed_at: string | null;
  // 本文（確定 intent の暗号文）をすでに消したか。
  readonly body_erased: boolean;
  // 取り消しの補償の操作がまだ終わっていないとき。終わるまで 90 日の削除をしない。
  readonly compensation_open: boolean;
  // 生きている用事が、この操作の暗号文・行をまだ参照しているとき（ADR 0040 の一時の代案）。用事の正本を分けた後は常に false。
  readonly task_depends: boolean;
  readonly body_delete_at: string | null;
  readonly row_delete_at: string | null;
}

export interface BudgetMonthGroup {
  readonly family: 'budget_month';
  readonly budget_month: string;
  // その月の境目に使ったタイムゾーン（budget_months の記録）。
  readonly time_zone: string;
  readonly reservations: readonly BudgetReservationRow[];
  // どの予約にも使われなかった承認（pending・rejected・expired）。
  readonly unused_approval_ids: readonly string[];
}

// 本人が確定保存した内容（用事・メモ）。本人の削除操作だけで消え、掃除の対象にしない（03、J5）。
export interface OwnerContentRow {
  readonly family: 'owner_content';
  readonly kind: 'task' | 'note';
  readonly id: string;
}

export type SweepRow =
  | TimedRow
  | MemoryRow
  | DerivedRow
  | OperationRow
  | BudgetMonthGroup
  | OwnerContentRow;

export interface SweepInput {
  readonly now: string;
  readonly last_checked_at: string | null;
  readonly rows: readonly SweepRow[];
}

// --- 掃除の出力 ---

export type SweepActionKind = 'delete_row' | 'erase_body' | 'start_review';

export type SweepActionReason =
  | 'due'
  | 'deadline_unreadable'
  | 'origin_expired'
  | 'origin_gone'
  | 'no_origin'
  | 'review_due'
  | 'review_unanswered'
  | 'status_deleted';

export interface SweepAction {
  readonly action: SweepActionKind;
  readonly family: SweepRow['family'];
  readonly rule: string;
  readonly id: string;
  // 予算の記録だけ。外部キーの順序（live_sessions → budget_overage_approvals → budget_reservations）で並べる。
  readonly table?:
    'live_sessions' | 'budget_overage_approvals' | 'budget_reservations';
  readonly reason: SweepActionReason;
  // 判定に使った期限。start_review では見直し待ちの削除期限。
  readonly delete_at: string | null;
  // 保存した期限が規則より遅かった（延ばされていた）ので、規則の期限に戻した。
  readonly clamped: boolean;
}

export type SweepHoldReason =
  | 'unknown_unit'
  | 'unknown_held'
  | 'task_depends'
  | 'compensation_open'
  | 'owner_content_excluded'
  | 'deadline_unreadable'
  | 'calendar_invalid'
  | 'clock_regression'
  | 'month_has_open_rows';

// 期限が来ている（または対象外の）のに、残すもの。理由つき。
export interface SweepHold {
  readonly family: SweepRow['family'];
  readonly rule: string;
  readonly id: string;
  readonly reason: SweepHoldReason;
  // month_has_open_rows のとき、消せない予約の ID。
  readonly blocking_ids?: readonly string[];
}

export interface SweepUseBlock {
  readonly family: SweepRow['family'];
  readonly id: string;
  readonly reason: 'deadline_unreadable' | 'unknown_unit';
}

export type NoticeReason =
  'retention_due' | 'review_unanswered' | 'summary_origin_expired';

export type NoticeItemKind =
  'turn' | 'source_item' | 'memory' | 'carried_summary';

// 契約の RetentionNotice（kind: expired）の下書き。notice_id・occurred_at は Core が付ける（純粋な関数に乱数と時計を入れない）。
// 1 件に最大 256 件（契約の上限）。ID と理由だけで、本文を持たない。
export interface SweepNoticeDraft {
  readonly kind: 'expired';
  readonly reason: NoticeReason;
  readonly items: readonly {
    readonly item_kind: NoticeItemKind;
    readonly item_id: string;
  }[];
}

export type SweepPlanResult =
  | { readonly ok: false; readonly reasons: string[] }
  | {
      readonly ok: true;
      readonly clock: {
        readonly state: 'ok' | 'regressed';
        readonly effective_now: string;
        readonly next_last_checked_at: string;
      };
      readonly actions: SweepAction[];
      readonly holds: SweepHold[];
      readonly notice_drafts: SweepNoticeDraft[];
      // 時計が巻き戻っている間、残る行の自動利用を止める（期限内でも）。
      readonly auto_use_blocked: boolean;
      // 期限を判定できないので残して使わない行（U57）。掃除の記録（SweepRecord.use_blocked）に必ず写し、
      // startupGate の判定（use_blocked）と isRowUsable で利用の側へ渡す。用事・メモ（owner_content_excluded）は含まない。
      readonly use_blocked: SweepUseBlock[];
    };

const NOTICE_ITEMS_MAX = 256;

const TIMED_NOTICE_KIND: ReadonlyMap<string, NoticeItemKind> = new Map([
  ['turn_normal', 'turn'],
  ['turn_extended', 'turn'],
  ['source_body', 'source_item'],
]);

const OWNER_CONTENT_RULE = { task: 'task_content', note: 'user_note' } as const;

// 掃除の計画。now が読めない・最終確認時刻が読めないときは、何も消さず ok: false（起動時のゲートも閉じる）。
export function sweepPlan(input: SweepInput): SweepPlanResult {
  const clock = checkClock(input.now, input.last_checked_at);
  if (!clock.ok) return { ok: false, reasons: [clock.reason] };
  const effective = Date.parse(clock.effective_now);
  const regressed = clock.state === 'regressed';
  const actions: SweepAction[] = [];
  const holds: SweepHold[] = [];
  const notices: {
    reason: NoticeReason;
    item_kind: NoticeItemKind;
    item_id: string;
  }[] = [];

  const due = (deadline: string): boolean => {
    const millis = parseUtc(deadline);
    return millis !== null && effective >= millis;
  };
  const notice = (
    reason: NoticeReason,
    itemKind: NoticeItemKind | undefined,
    itemId: string,
  ): void => {
    if (itemKind !== undefined)
      notices.push({ reason, item_kind: itemKind, item_id: itemId });
  };

  for (const row of input.rows) {
    if (row.family === 'owner_content') {
      holds.push({
        family: row.family,
        rule: OWNER_CONTENT_RULE[row.kind],
        id: row.id,
        reason: 'owner_content_excluded',
      });
    } else if (row.family === 'timed') {
      const rule = ruleOf(row.rule);
      if (
        rule === undefined ||
        rule.months !== undefined ||
        row.rule === 'operation_body' ||
        row.rule === 'operation_receipt'
      ) {
        holds.push({
          family: row.family,
          rule: row.rule,
          id: row.id,
          reason: 'unknown_unit',
        });
        continue;
      }
      const deadline = clampedDeadline(row.rule, row.anchor_at, row.delete_at);
      if (deadline === null) {
        // 期限を決められない行は、短い側（消す）へ倒す（03「混在部分を分離できなければ短い期限」）。
        if (row.compensation_open === true) {
          holds.push({
            family: row.family,
            rule: row.rule,
            id: row.id,
            reason: 'compensation_open',
          });
          continue;
        }
        actions.push({
          action: 'delete_row',
          family: row.family,
          rule: row.rule,
          id: row.id,
          reason: 'deadline_unreadable',
          delete_at: null,
          clamped: false,
        });
        notice('retention_due', TIMED_NOTICE_KIND.get(row.rule), row.id);
        continue;
      }
      if (!due(deadline.delete_at)) continue;
      if (row.compensation_open === true) {
        holds.push({
          family: row.family,
          rule: row.rule,
          id: row.id,
          reason: 'compensation_open',
        });
        continue;
      }
      actions.push({
        action: 'delete_row',
        family: row.family,
        rule: row.rule,
        id: row.id,
        reason: 'due',
        delete_at: deadline.delete_at,
        clamped: deadline.clamped,
      });
      notice('retention_due', TIMED_NOTICE_KIND.get(row.rule), row.id);
    } else if (row.family === 'memory') {
      planMemory(row, effective, actions, holds, notice);
    } else if (row.family === 'derived') {
      planDerived(row, effective, actions, notice);
    } else if (row.family === 'operation') {
      planOperation(row, due, actions, holds);
    } else {
      planBudgetMonth(row, effective, regressed, actions, holds);
    }
  }

  return {
    ok: true,
    clock: {
      state: clock.state,
      effective_now: clock.effective_now,
      next_last_checked_at: clock.next_last_checked_at,
    },
    actions,
    holds,
    notice_drafts: noticeDrafts(notices),
    auto_use_blocked: regressed,
    use_blocked: useBlocked(holds),
  };
}

// 期限を判定できない行は、残すが使わない（U57）。同じ行の重複は 1 件にする。
function useBlocked(holds: readonly SweepHold[]): SweepUseBlock[] {
  const blocked: SweepUseBlock[] = [];
  for (const hold of holds) {
    if (hold.reason !== 'deadline_unreadable' && hold.reason !== 'unknown_unit')
      continue;
    if (
      blocked.some((item) => item.family === hold.family && item.id === hold.id)
    )
      continue;
    blocked.push({ family: hold.family, id: hold.id, reason: hold.reason });
  }
  return blocked;
}

function planMemory(
  row: MemoryRow,
  effective: number,
  actions: SweepAction[],
  holds: SweepHold[],
  notice: (
    reason: NoticeReason,
    kind: NoticeItemKind | undefined,
    id: string,
  ) => void,
): void {
  const base = {
    family: row.family,
    rule: 'memory_review',
    id: row.id,
    clamped: false,
  } as const;
  if (row.status === 'deleted') {
    actions.push({
      ...base,
      action: 'delete_row',
      reason: 'status_deleted',
      delete_at: row.delete_at,
    });
    return;
  }
  // 範囲外の状態は判定できない。残して使わない。
  if (row.status !== 'active' && row.status !== 'review_pending') {
    holds.push({
      family: row.family,
      rule: 'memory_review',
      id: row.id,
      reason: 'unknown_unit',
    });
    return;
  }
  const reviewAt = parseUtc(row.review_at);
  const storedDelete = row.delete_at === null ? null : parseUtc(row.delete_at);
  // 見直し日が読めない記憶は、削除日が読めて過去でも消さずに残して使わない（見直し日がないと期限を確かめられない）。
  if (reviewAt === null) {
    holds.push({
      family: row.family,
      rule: 'memory_review',
      id: row.id,
      reason: 'deadline_unreadable',
    });
    return;
  }
  const now = toIso(effective);
  // 削除の期限は、保存した期限と、見直し日＋30 日の小さい方（保存した期限が 30 日を超えて延ばされていても戻す）。
  // memory.ts は変えず、ここで制限してから既存の遷移に渡す。
  const cap = reviewAt + MEMORY_DELETE_AFTER_REVIEW_DAYS * 86_400_000;
  // 見直し待ちで削除日がない（または読めない）ときは、見直し日＋30 日をそのまま削除日にする（延ばさない側）。
  const stored =
    storedDelete === null
      ? row.status === 'review_pending'
        ? cap
        : null
      : Math.min(storedDelete, cap);
  const clamped = storedDelete !== null && storedDelete > cap;
  let memory: MemorySchedule = {
    status: row.status,
    review_at: row.review_at,
    delete_at: stored === null ? null : toIso(stored),
  };
  const wasActive = row.status === 'active';
  if (wasActive) {
    const reviewed = applyMemoryEvent(memory, 'review_due', now);
    if (reviewed.rejected !== null) return;
    memory = reviewed.memory;
  }
  // 見直し待ちの 30 日も過ぎているなら、見直し待ちを経ずに消す（絶対の期限。止まっていた間も数える）。
  const deleted = applyMemoryEvent(memory, 'delete_due', now);
  if (deleted.rejected === null) {
    actions.push({
      ...base,
      action: 'delete_row',
      reason: 'review_unanswered',
      delete_at: memory.delete_at,
      clamped,
    });
    notice('review_unanswered', 'memory', row.id);
  } else if (wasActive) {
    actions.push({
      ...base,
      action: 'start_review',
      reason: 'review_due',
      delete_at: memory.delete_at,
      clamped,
    });
  }
}

function planDerived(
  row: DerivedRow,
  effective: number,
  actions: SweepAction[],
  notice: (
    reason: NoticeReason,
    kind: NoticeItemKind | undefined,
    id: string,
  ) => void,
): void {
  const base = {
    action: 'delete_row',
    family: row.family,
    rule:
      row.artifact_kind === 'carried_summary' ? 'carried_summary' : 'derived',
    id: row.id,
    clamped: false,
  } as const;
  let reason: SweepActionReason | null = null;
  let deleteAt: string | null = null;
  let clamped = false;
  const stored = row.delete_at === null ? null : parseUtc(row.delete_at);
  // 保存した期限があるのに読めないときは、由来の期限に戻すと延ばす側に倒れる。閉じる側（消す）へ倒す。
  if (row.delete_at !== null && stored === null) reason = 'deadline_unreadable';
  else if (row.origins.length === 0) reason = 'no_origin';
  else if (row.origins.some((origin) => origin.expires_at === null))
    reason = 'origin_gone';
  else {
    const fromOrigins = derivedDeadline(
      row.origins.map((origin) => origin.expires_at as string),
    );
    // 読めない由来の期限は期限切れとして扱う（閉じた側）。
    if (fromOrigins === null) reason = 'origin_gone';
    else {
      // 保存した期限と、今の由来の最も早い期限の小さい方。保存した期限の方が遅ければ（延ばされていれば）由来の期限に戻す。
      const originMillis = Date.parse(fromOrigins);
      const limit =
        stored === null ? originMillis : Math.min(stored, originMillis);
      clamped = stored !== null && stored > originMillis;
      deleteAt = toIso(limit);
      if (effective >= limit)
        reason = limit < originMillis ? 'due' : 'origin_expired';
    }
  }
  if (reason === null) return;
  actions.push({ ...base, reason, delete_at: deleteAt, clamped });
  // 要約全体を捨てる（一部の由来だけを残さない）。知らせの対象は要約をつないだ区間。
  if (row.artifact_kind === 'carried_summary')
    notice('summary_origin_expired', 'carried_summary', row.id);
}

function planOperation(
  row: OperationRow,
  due: (deadline: string) => boolean,
  actions: SweepAction[],
  holds: SweepHold[],
): void {
  const hold = (rule: string, reason: SweepHoldReason): void => {
    holds.push({ family: row.family, rule, id: row.id, reason });
  };
  if (row.operation_state === 'unknown_held') {
    // 結果不明は完了ではない。照合のために本文を残す（ADR 0040）。
    hold('operation_body', 'unknown_held');
    return;
  }
  if (!COMPLETED_STATES.includes(row.operation_state)) return;
  // 起点（completed_at）が読めない完了済みの操作は消さない（U96）。DB worker の最後の保証
  // （completed_at_missing）と同じ側にそろえ、計画と命令の結果を食い違わせない。0011 は適用の時刻で
  // 起点を埋めるので、通常の経路ではこの分岐に入らない（復元などの異常な行だけ）。
  if (row.completed_at === null || parseUtc(row.completed_at) === null) {
    if (!row.body_erased) hold('operation_body', 'deadline_unreadable');
    hold('operation_receipt', 'deadline_unreadable');
    return;
  }
  const body = clampedDeadline(
    'operation_body',
    row.completed_at,
    row.body_delete_at,
  );
  const receipt = clampedDeadline(
    'operation_receipt',
    row.completed_at,
    row.row_delete_at,
  );
  if (!row.body_erased) {
    if (body === null) {
      // 起点は読めるが、保存した期限と規則のどちらも読めない。残して使わない（消す側へ倒さない）。
      hold('operation_body', 'deadline_unreadable');
    } else if (due(body.delete_at)) {
      if (row.task_depends) hold('operation_body', 'task_depends');
      else
        actions.push({
          action: 'erase_body',
          family: row.family,
          rule: 'operation_body',
          id: row.id,
          reason: 'due',
          delete_at: body.delete_at,
          clamped: body.clamped,
        });
    }
  }
  if (receipt === null) {
    hold('operation_receipt', 'deadline_unreadable');
    return;
  }
  if (!due(receipt.delete_at)) return;
  if (row.compensation_open) hold('operation_receipt', 'compensation_open');
  else if (row.task_depends) hold('operation_receipt', 'task_depends');
  else
    actions.push({
      action: 'delete_row',
      family: row.family,
      rule: 'operation_receipt',
      id: row.id,
      reason: 'due',
      delete_at: receipt.delete_at,
      clamped: receipt.clamped,
    });
}

function planBudgetMonth(
  group: BudgetMonthGroup,
  effective: number,
  regressed: boolean,
  actions: SweepAction[],
  holds: SweepHold[],
): void {
  const groupId = `budget_month:${group.budget_month}`;
  const hold = (
    reason: SweepHoldReason,
    blocking?: readonly string[],
  ): void => {
    holds.push({
      family: group.family,
      rule: 'budget_record',
      id: groupId,
      reason,
      ...(blocking === undefined ? {} : { blocking_ids: blocking }),
    });
  };
  const deleteAt = budgetRecordDeleteAt(group.budget_month, group.time_zone);
  if (deleteAt === null) {
    hold('calendar_invalid');
    return;
  }
  if (effective < Date.parse(deleteAt)) return;
  // 予算の記録は、時計を信じられないときは消さない側へ倒す（使用額が少なく見えるのを防ぐ。J4）。
  // 巻き戻り中は最終確認時刻でも消さない（個人の内容とは逆）。
  if (regressed) {
    hold('clock_regression');
    return;
  }
  const blocking = group.reservations
    .filter((reservation) => !budgetReservationDeletable(reservation))
    .map((reservation) => reservation.reservation_id);
  if (blocking.length > 0) {
    // 月ごとにまとめて消す。1 件でも消せない行があれば、その月の行は 1 つも消さない。
    hold('month_has_open_rows', blocking);
    return;
  }
  const base = {
    action: 'delete_row',
    family: group.family,
    rule: 'budget_record',
    reason: 'due',
    delete_at: deleteAt,
    clamped: false,
  } as const;
  for (const reservation of group.reservations)
    for (const id of reservation.live_session_ids)
      actions.push({ ...base, table: 'live_sessions', id });
  for (const id of [
    ...group.reservations.flatMap((reservation) => reservation.approval_ids),
    ...group.unused_approval_ids,
  ])
    actions.push({ ...base, table: 'budget_overage_approvals', id });
  for (const reservation of group.reservations)
    actions.push({
      ...base,
      table: 'budget_reservations',
      id: reservation.reservation_id,
    });
}

function noticeDrafts(
  entries: readonly {
    reason: NoticeReason;
    item_kind: NoticeItemKind;
    item_id: string;
  }[],
): SweepNoticeDraft[] {
  const drafts: SweepNoticeDraft[] = [];
  const reasons: NoticeReason[] = [
    'retention_due',
    'review_unanswered',
    'summary_origin_expired',
  ];
  for (const reason of reasons) {
    const seen = new Set<string>();
    const items: { item_kind: NoticeItemKind; item_id: string }[] = [];
    for (const entry of entries) {
      if (entry.reason !== reason) continue;
      const key = `${entry.item_kind}:${entry.item_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ item_kind: entry.item_kind, item_id: entry.item_id });
    }
    for (let index = 0; index < items.length; index += NOTICE_ITEMS_MAX)
      drafts.push({
        kind: 'expired',
        reason,
        items: items.slice(index, index + NOTICE_ITEMS_MAX),
      });
  }
  return drafts;
}

// --- 起動時・復帰時のゲート ---

// 掃除の間隔（起動中の定期実行）。原本は「起動中も定期実行」とだけ書く。最も短い期限（ペアリングコード 5 分）に合わせた設計判断。
export const SWEEP_INTERVAL_MS = 5 * 60_000;
// 最後の掃除からこれより長く経ったら、定期実行が止まっているとみなして閉じる。
export const SWEEP_STALE_MS = 3 * SWEEP_INTERVAL_MS;

export interface SweepRecord {
  // 起動・復帰ごとの識別子。この掃除をどの起動・復帰のために行ったか。
  readonly epoch: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly completed_at: string | null;
  // 計画のうち実行に失敗した件数（0 のときだけ済みとみなす）。
  readonly failed_actions: number;
  // 計画の use_blocked（期限を判定できず、残して使わない行）。必ず写す（空なら空の配列）。
  readonly use_blocked: readonly SweepUseBlock[];
}

export interface StartupGateInput {
  // 今の起動・復帰の識別子（起動のたび・スリープからの復帰のたびに新しくする）。
  readonly epoch: string;
  readonly now: string;
  readonly last_checked_at: string | null;
  readonly sweep: SweepRecord | null;
}

export interface StartupGateDecision {
  readonly search: boolean;
  readonly cloud_send: boolean;
  readonly auto_use: boolean;
  readonly reasons: string[];
  // 門が開いていても使ってはならない行（掃除の記録の use_blocked）。個々の利用は isRowUsable で判定する。
  readonly use_blocked: readonly SweepUseBlock[];
}

// 行 1 件を検索・送信・自動利用に使ってよいか。門が閉じている・その行が use_blocked にある、ならば使わない。
export function isRowUsable(
  decision: StartupGateDecision,
  family: SweepRow['family'],
  id: string,
): boolean {
  return (
    decision.search &&
    decision.cloud_send &&
    decision.auto_use &&
    !decision.use_blocked.some(
      (item) => item.family === family && item.id === id,
    )
  );
}

// 掃除が済むまで、検索とクラウドへの送信を許さない（03「期限処理は起動時・復帰時に検索やクラウド送信より先に行う」）。
// 時計が巻き戻っている間、掃除の記録が古い間も許さない。判定が読めないときは閉じる。
export function startupGate(input: StartupGateInput): StartupGateDecision {
  const reasons: string[] = [];
  const sweep = input.sweep;
  const clock = checkClock(input.now, input.last_checked_at);
  const now = parseUtc(input.now);
  // 掃除の完了時刻も時計の後退の判定に使う。完了時刻が今より先なら、掃除の後に時計が戻った（または記録が偽）。
  const completed =
    sweep === null || sweep.completed_at === null
      ? null
      : parseUtc(sweep.completed_at);
  const completedInFuture =
    now !== null && completed !== null && completed > now;
  if (!clock.ok) reasons.push(`clock_${clock.reason}`);
  else if (clock.state === 'regressed' || completedInFuture)
    reasons.push('clock_regression');
  if (sweep === null) reasons.push('sweep_not_started');
  else if (sweep.epoch !== input.epoch) reasons.push('sweep_for_other_epoch');
  else if (sweep.status === 'running') reasons.push('sweep_running');
  else if (sweep.status === 'failed') reasons.push('sweep_failed');
  else {
    if (sweep.failed_actions !== 0) reasons.push('sweep_incomplete');
    // 使ってはならない行の一覧を必ず写す（欠けた記録では、何を使わないかが分からないので閉じる）。
    if (!Array.isArray(sweep.use_blocked))
      reasons.push('sweep_use_blocked_missing');
    if (completed === null) reasons.push('sweep_time_unreadable');
    else if (completedInFuture) reasons.push('sweep_time_in_future');
    else if (now !== null && now - completed > SWEEP_STALE_MS)
      reasons.push('sweep_stale');
  }
  const open = reasons.length === 0;
  return {
    search: open,
    cloud_send: open,
    auto_use: open,
    reasons,
    use_blocked:
      sweep !== null && Array.isArray(sweep.use_blocked)
        ? [...sweep.use_blocked]
        : [],
  };
}

// 起動中の定期実行で、次の掃除を始めるか。まだ一度も済んでいない・間隔が過ぎた・記録が読めないときは始める。
export function sweepDue(lastCompletedAt: string | null, now: string): boolean {
  const current = parseUtc(now);
  if (current === null) return true;
  const last = lastCompletedAt === null ? null : parseUtc(lastCompletedAt);
  if (last === null) return true;
  return current < last || current - last >= SWEEP_INTERVAL_MS;
}
