// 復元の後の保留（J3、設計 03 バックアップ・復元、08 §3・§4、ADR 0040・0047、B06-05）。
// - 承認はすべて失効させる（隔離の印の有無・経路によらない。B06-01 の Codex の P3）。
// - 外部サービスを変える操作の、再実行に届き得る 7 つの状態に「復元後の未確認」の印を付けて隔離する。進行中の 4 つは結果不明へ。
// - 印を外せるのは、実行済みの積極的な証拠か、本人の手による決着だけ。
// - 予算の保留、同意・世代・接続範囲・カーソルの取り直し、候補を起点にした自動実行の停止（再取り込みまで）。
// DB の transaction と trigger（最後の保証）は B06-06。ここは純粋な判定だけ。判別できないときは保留の側へ倒す。

import { budgetMonthOf } from './budget-rules.js';
import {
  CONTENT_REVISABLE_STATES,
  canTransition,
  type OperationState,
} from './operations.js';
import { parseBackupTime } from './backup-plan.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

const OPERATION_STATES: readonly OperationState[] = [
  'awaiting_approval',
  'approved',
  'preparing',
  'dispatching',
  'reconciling',
  'succeeded',
  'unknown_held',
  'not_executed',
  'cancelled',
  'superseded',
];

// 復元の時点から再実行に届き得る状態（ADR 0040 の表。OPERATION_TRANSITIONS から手で列挙した）。
export const RESTORE_QUARANTINE_STATES: readonly OperationState[] = [
  'awaiting_approval',
  'approved',
  'preparing',
  'dispatching',
  'reconciling',
  'unknown_held',
  'not_executed',
];
// 復元の後に結果不明（unknown_held）にする、進行中の 4 つ。
export const RESTORE_IN_FLIGHT_STATES: readonly OperationState[] = [
  'approved',
  'preparing',
  'dispatching',
  'reconciling',
];

export interface OperationBeforeRestore {
  readonly operation_id: string;
  readonly effect_route: string;
  readonly state: string;
  readonly content_version: string;
  readonly valid_approval_count: number;
}

// 契約の RestoredOperation の形。
export interface RestoredOperationLike {
  readonly schema: 'buddy.restored-operation.v1';
  readonly operation_id: string;
  readonly effect_route: 'local_command' | 'remote_mutation';
  readonly state: OperationState;
  readonly content_version: string;
  readonly restore_unverified_at: string | null;
  readonly valid_approval_count: number;
}

export type RestoredOperationProblem =
  | 'local_command_quarantined'
  | 'not_quarantined'
  | 'terminal_quarantined'
  | 'in_flight_not_held'
  | 'approval_not_revoked';

// 復元の直後の記録の検査（契約の意味検査と同じ）。承認の失効は、印の有無・経路によらず検査する（J3 は全承認）。
export function restoredOperationProblems(
  op: RestoredOperationLike,
): RestoredOperationProblem[] {
  const problems: RestoredOperationProblem[] = [];
  const marked = op.restore_unverified_at !== null;
  if (op.effect_route === 'local_command') {
    if (marked) problems.push('local_command_quarantined');
  } else {
    const open = RESTORE_QUARANTINE_STATES.includes(op.state);
    if (open && !marked) problems.push('not_quarantined');
    if (!open && marked) problems.push('terminal_quarantined');
    if (RESTORE_IN_FLIGHT_STATES.includes(op.state))
      problems.push('in_flight_not_held');
  }
  if (op.valid_approval_count > 0) problems.push('approval_not_revoked');
  return problems;
}

export type QuarantinePlan =
  | {
      readonly ok: true;
      readonly operations: readonly RestoredOperationLike[];
      // RestoreAftermath の件数。
      readonly approvals_revoked_count: number;
      // 復元の後に結果不明（unknown_held）にある外部変更の操作（もともと結果不明だったものを含む）。
      readonly operations_held_count: number;
      // 印を付けた操作。
      readonly operations_unverified_count: number;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly (
        | 'restored_at_invalid'
        | 'operation_invalid'
        | 'unknown_operation_state'
        | 'unknown_effect_route'
        | 'duplicate_operation'
      )[];
      readonly operation_ids: readonly string[];
    };

// 差し替えと同じ transaction で書く、復元の直後の操作の記録を決める。読めない状態・経路の操作が 1 つでもあれば
// 計画しない（Core は段階 4 を db_integrity_failed で止める。何が起きたか分からない操作を通常の流れに戻さない）。
export function quarantineRestoredOperations(
  operations: readonly OperationBeforeRestore[],
  restoredAt: string,
): QuarantinePlan {
  const reasons = new Set<
    | 'restored_at_invalid'
    | 'operation_invalid'
    | 'unknown_operation_state'
    | 'unknown_effect_route'
    | 'duplicate_operation'
  >();
  const bad = new Set<string>();
  if (parseBackupTime(restoredAt) === null) reasons.add('restored_at_invalid');
  const seen = new Set<string>();
  for (const op of operations) {
    if (seen.has(op.operation_id)) {
      reasons.add('duplicate_operation');
      bad.add(op.operation_id);
    }
    seen.add(op.operation_id);
    if (
      !UUID_V4.test(op.operation_id) ||
      !DECIMAL.test(op.content_version) ||
      !Number.isSafeInteger(op.valid_approval_count) ||
      op.valid_approval_count < 0
    ) {
      reasons.add('operation_invalid');
      bad.add(op.operation_id);
    }
    if (!(OPERATION_STATES as readonly string[]).includes(op.state)) {
      reasons.add('unknown_operation_state');
      bad.add(op.operation_id);
    }
    if (
      op.effect_route !== 'local_command' &&
      op.effect_route !== 'remote_mutation'
    ) {
      reasons.add('unknown_effect_route');
      bad.add(op.operation_id);
    }
  }
  if (reasons.size > 0)
    return { ok: false, reasons: [...reasons], operation_ids: [...bad].sort() };
  let revoked = 0;
  let held = 0;
  let unverified = 0;
  const restored = operations.map((op): RestoredOperationLike => {
    const state = op.state as OperationState;
    revoked += op.valid_approval_count;
    if (op.effect_route === 'local_command') {
      // LocalCommand の効果は DB と一緒に戻るので隔離しない。承認は失効するので、承認済み・準備中は承認待ちへ戻す
      // （承認のないまま承認済みに残すと、本人がもう一度承認する経路がない。U77）。
      const next =
        state === 'approved' || state === 'preparing'
          ? 'awaiting_approval'
          : state;
      return {
        schema: 'buddy.restored-operation.v1',
        operation_id: op.operation_id,
        effect_route: 'local_command',
        state: next,
        content_version: op.content_version,
        restore_unverified_at: null,
        valid_approval_count: 0,
      };
    }
    const quarantined = RESTORE_QUARANTINE_STATES.includes(state);
    const next = RESTORE_IN_FLIGHT_STATES.includes(state)
      ? 'unknown_held'
      : state;
    if (quarantined) unverified += 1;
    if (next === 'unknown_held') held += 1;
    return {
      schema: 'buddy.restored-operation.v1',
      operation_id: op.operation_id,
      effect_route: 'remote_mutation',
      state: next,
      content_version: op.content_version,
      restore_unverified_at: quarantined ? restoredAt : null,
      valid_approval_count: 0,
    };
  });
  return {
    ok: true,
    operations: restored,
    approvals_revoked_count: revoked,
    operations_held_count: held,
    operations_unverified_count: unverified,
  };
}

// --- 印の守り（DB の trigger と同じ規則。契約の restoreGuard と同じ結果） ---

export interface RestoreReconcileObservation {
  readonly kind:
    'found' | 'not_found' | 'multiple' | 'unreadable' | 'unsupported';
  // 見つかった作成物の目印の内容版（buddy-op:<operation_id>:<content_version>。operation_id の接頭辞で検索する）。
  readonly marker_content_version: string | null;
  // 作成物の内容を、復元した確定内容と照合できたか（null は照合していない）。
  readonly content_matches: boolean | null;
}

export type RestoreEvent =
  | { readonly event: 'create_approval' }
  | { readonly event: 'enter_approved' }
  | { readonly event: 'enter_preparing' }
  | { readonly event: 'create_attempt' }
  | { readonly event: 'revise_content' }
  | {
      readonly event: 'reconcile';
      readonly observation: RestoreReconcileObservation;
    }
  | {
      readonly event: 'owner_resolve';
      // 実行済みとして取り込む・元サービスで確かめて未実行とする・取り消す（ADR 0040）。
      readonly resolution?: 'executed' | 'not_executed' | 'cancel';
    };

export type RestoreGuardResult =
  | { readonly result: 'allowed'; readonly reason: null }
  | { readonly result: 'rejected'; readonly reason: string }
  | { readonly result: 'hold'; readonly reason: string }
  | { readonly result: 'import_result'; readonly reason: null }
  | { readonly result: 'released'; readonly reason: null };

// 印だけを見た判定。承認の作成・approved と preparing への遷移・試行の作成は印があれば拒否。内容の更新は外に出ない
// ので印では止めない（印は付いたまま）。照合で結果を取り込むのは、目印つきの作成物がちょうど一つ・目印の内容版が
// 同じ・内容を照合できたときだけ。「見つからない」は未実行の証拠にしない。本人の決着は印を外す。
export function restoreMarkGuard(
  op: Pick<RestoredOperationLike, 'restore_unverified_at' | 'content_version'>,
  step: RestoreEvent,
): RestoreGuardResult {
  const marked = op.restore_unverified_at !== null;
  switch (step.event) {
    case 'create_approval':
    case 'enter_approved':
    case 'enter_preparing':
    case 'create_attempt':
      return marked
        ? { result: 'rejected', reason: 'restore_unverified' }
        : { result: 'allowed', reason: null };
    case 'revise_content':
      return { result: 'allowed', reason: null };
    case 'reconcile': {
      if (!marked) return { result: 'rejected', reason: 'not_quarantined' };
      const o = step.observation;
      switch (o.kind) {
        case 'found':
          if (o.marker_content_version !== op.content_version)
            return { result: 'hold', reason: 'content_version_mismatch' };
          if (o.content_matches !== true)
            return { result: 'hold', reason: 'content_unverified' };
          return { result: 'import_result', reason: null };
        case 'not_found':
          return { result: 'hold', reason: 'not_found_may_apply_late' };
        case 'multiple':
          return { result: 'hold', reason: 'multiple_matches' };
        case 'unreadable':
          return { result: 'hold', reason: 'lookup_unreadable' };
        default:
          // unsupported と、知らない観測の種類（保留の側）。
          return { result: 'hold', reason: 'lookup_unsupported' };
      }
    }
    case 'owner_resolve':
      return marked
        ? { result: 'released', reason: null }
        : { result: 'rejected', reason: 'not_quarantined' };
    default:
      return { result: 'rejected', reason: 'unknown_event' };
  }
}

export interface RestoreEventOutcome {
  readonly decision: RestoreGuardResult;
  readonly operation: RestoredOperationLike;
}

// 印の守りに、状態の遷移を重ねて、次の記録を返す（順序を入れ替えた試験に使う）。印を外すのは import_result と
// released のときだけ。状態の遷移として許されないものは、印がなくても拒否する（transition_not_allowed など）。
export function applyRestoreEvent(
  op: RestoredOperationLike,
  step: RestoreEvent,
): RestoreEventOutcome {
  const guard = restoreMarkGuard(op, step);
  const reject = (reason: string): RestoreEventOutcome => ({
    decision: { result: 'rejected', reason },
    operation: op,
  });
  if (guard.result === 'rejected' || guard.result === 'hold')
    return { decision: guard, operation: op };
  switch (step.event) {
    case 'create_approval':
      if (op.state !== 'awaiting_approval')
        return reject('transition_not_allowed');
      if (op.valid_approval_count > 0) return reject('approval_exists');
      return {
        decision: guard,
        operation: { ...op, valid_approval_count: 1 },
      };
    case 'enter_approved':
    case 'enter_preparing': {
      const to = step.event === 'enter_approved' ? 'approved' : 'preparing';
      if (!canTransition(op.state, to, op.effect_route))
        return reject('transition_not_allowed');
      if (to === 'approved' && op.valid_approval_count === 0)
        return reject('approval_missing');
      return { decision: guard, operation: { ...op, state: to } };
    }
    case 'create_attempt':
      if (op.state !== 'preparing') return reject('transition_not_allowed');
      return { decision: guard, operation: op };
    case 'revise_content':
      if (!CONTENT_REVISABLE_STATES.includes(op.state))
        return reject(
          ['dispatching', 'reconciling', 'unknown_held'].includes(op.state)
            ? 'dispatch_boundary_crossed'
            : 'operation_finished',
        );
      // 内容版を上げて承認待ちへ。旧版の承認は失効。印は外れない。
      return {
        decision: guard,
        operation: {
          ...op,
          state: 'awaiting_approval',
          content_version: String(BigInt(op.content_version) + 1n),
          valid_approval_count: 0,
        },
      };
    case 'reconcile':
      // import_result: 結果を取り込む（再送しない）。
      return {
        decision: guard,
        operation: { ...op, state: 'succeeded', restore_unverified_at: null },
      };
    case 'owner_resolve': {
      const resolution = step.resolution;
      if (resolution === 'executed')
        return {
          decision: guard,
          operation: { ...op, state: 'succeeded', restore_unverified_at: null },
        };
      if (resolution === 'not_executed')
        return {
          decision: guard,
          operation: {
            ...op,
            // 承認待ちは承認待ちのまま通常の流れへ。それ以外は未実行の確定。
            state:
              op.state === 'awaiting_approval'
                ? 'awaiting_approval'
                : 'not_executed',
            restore_unverified_at: null,
          },
        };
      if (resolution === 'cancel') {
        if (!canTransition(op.state, 'cancelled'))
          return reject('transition_not_allowed');
        return {
          decision: guard,
          operation: { ...op, state: 'cancelled', restore_unverified_at: null },
        };
      }
      // 決着の中身がない（知らない）ときは印を外さない。
      return reject('resolution_missing');
    }
    default:
      return reject('unknown_event');
  }
}

// --- 予算の保留 ---

export type RestoreBudgetHold =
  | {
      readonly ok: true;
      // バックアップの月から復元の月まで（この間の予約の記録はバックアップの後の分が失われ、少なく数え得る）。
      readonly held_months: readonly string[];
      // 予約中（reserved）の行は、バックアップの後に送られた可能性があるので使用量不明にする（未送信として解放しない）。
      readonly mark_usage_unknown: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'time_invalid' | 'clock_regression' | 'too_many_months';
    };

const nextMonth = (month: string): string => {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(5, 7));
  return value === 12
    ? `${String(year + 1).padStart(4, '0')}-01`
    : `${month.slice(0, 4)}-${String(value + 1).padStart(2, '0')}`;
};

// 予算の保留を決める（原本に決めなし。U77）。予約の行はバックアップの時点のもので、その後の予約と精算は失われる。
// 今月の使用額を少なく数えて上限を超えないように、保留の月が今月である間は、本人が確かめるまで有料の受付を止める。
export function restoreBudgetHold(input: {
  readonly backup_created_at: string;
  readonly restored_at: string;
  readonly time_zone: string;
  readonly reservations: readonly {
    readonly reservation_id: string;
    readonly status: string;
  }[];
}): RestoreBudgetHold {
  const from = budgetMonthOf(input.backup_created_at, input.time_zone);
  const to = budgetMonthOf(input.restored_at, input.time_zone);
  if (from === null || to === null)
    return { ok: false, reason: 'time_invalid' };
  if (to < from) return { ok: false, reason: 'clock_regression' };
  const months: string[] = [from];
  while ((months.at(-1) ?? to) < to) {
    if (months.length >= 120) return { ok: false, reason: 'too_many_months' };
    months.push(nextMonth(months.at(-1) ?? to));
  }
  return {
    ok: true,
    held_months: months,
    mark_usage_unknown: input.reservations
      .filter((row) => row.status === 'reserved')
      .map((row) => row.reservation_id)
      .sort(),
  };
}

// 有料の受付の前の検査（予算の門に足す理由）。今の予算月が保留の月で、本人が確かめていなければ止める。保留の月より
// 前（時計が戻った）・読めない月も止める。保留の月を過ぎた新しい月は、失われた予約がないので止めない。
export function restoreBudgetHoldReasons(input: {
  readonly held_months: readonly string[];
  readonly current_month: string | null;
  readonly confirmed_months: readonly string[];
}): readonly 'budget_restore_hold'[] {
  const current = input.current_month;
  if (current === null || !/^[0-9]{4}-(0[1-9]|1[0-2])$/u.test(current))
    return ['budget_restore_hold'];
  if (input.held_months.length === 0) return [];
  const last = [...input.held_months].sort().at(-1) ?? current;
  if (current > last) return [];
  if (
    input.held_months.includes(current) &&
    input.confirmed_months.includes(current)
  )
    return [];
  return ['budget_restore_hold'];
}

// --- 付帯クレジットの観測（B07-07 の budget_credit_observations。ADR 0042） ---

// 復元した DB の採用済みの観測はバックアップの時点まで。その後に採用した観測（残高の減少・枯渇）と、その後の精算（消費の
// 見積もり）は失われるので、古い観測から求めた残りは実際より多く見え得る（購入残高・後払いへ移る受付を許し得る）。
// 復元の後は、観測の時刻が復元の時刻以後の観測を新しく採用するまで、クレジットを充てる受付・追加予約・送出を止める
// （ADR 0042 の credit_unknown と同じ側）。採用の連番（observation_seq）は復元した DB の続きから振り直され、復元の前の
// DB で使った番号と重なり得るが、番号を参照するのは同じ DB の予約の行だけなので、DB の中では食い違わない（DB の外へ番号を
// 出さない前提）。ADR 0047。
export function restoreCreditReasons(input: {
  // 効いている復元の時刻（復元していなければ null）。
  readonly restored_at: string | null;
  // 採用済みの観測のうち、最も新しい観測の時刻（なければ null）。
  readonly latest_observed_at: string | null;
}): readonly 'credit_restore_unverified'[] {
  if (input.restored_at === null) return [];
  const restored = parseBackupTime(input.restored_at);
  const observed =
    input.latest_observed_at === null
      ? null
      : parseBackupTime(input.latest_observed_at);
  if (restored === null || observed === null || observed < restored)
    return ['credit_restore_unverified'];
  return [];
}

// --- 取り直し（差し替えと同じ transaction で行う） ---

// 復元の後に取り直すもの（この順で記録する。順序は transaction の中なので意味を持たないが、漏れを試験で確かめる）。
export const RESTORE_RESETS = [
  // J3: 有効な承認をすべて失効させる（経路・印によらない）。
  'revoke_all_approvals',
  // 外部変更の 7 状態に印を付け、進行中の 4 つを結果不明へ。
  'quarantine_operations',
  // 外部への送信の同意を取り直す（ADR 0038。RestoreAftermath.consents_reset）。
  'reset_send_consents',
  // DB の世代を新しくする（イベントのカーソル・端末の snapshot を取り直させる）。
  'renew_store_generation',
  // 音声のリース・出力先の世代（io_epoch・session_epoch・audio_epoch）を進め、復元の前の結果を受け付けない。
  'advance_epochs',
  // 接続範囲（command_scopes）をすべて失効させ、端末に取り直させる。
  'revoke_command_scopes',
  // 外部サービスの接続を再認証が要る状態にする（OAuth トークンはバックアップにない）。
  'require_connection_reauth',
  // 同期のカーソルを捨てて全体を走査し直す（provider_cursor を消し、pending_full を立て、進行中の走査を外す）。
  'reset_sync_cursors',
  // 候補を起点にした自動実行を、取得範囲ごとに再取り込みが済むまで止める。
  'block_candidate_auto_execution',
  // 予算の保留（restoreBudgetHold）。
  'hold_budget',
  // 付帯クレジットは、復元の後に採用した新しい観測まで充てない（restoreCreditReasons）。
  'require_new_credit_observation',
] as const;
export type RestoreReset = (typeof RESTORE_RESETS)[number];

export interface RestoreScopeResync {
  readonly scope_id: string;
  // 復元の後に公開した、全体の走査の世代（null はまだ）。
  readonly full_resync_generation: string | null;
  // 対象の列挙が済んだ世代（11 §5B の analysis_plan_complete_generation）。
  readonly analysis_plan_complete_generation: string | null;
}

// 候補を起点にした自動実行を、その取得範囲の再取り込みが済むまで止める。復元の後に全体を走査して公開し、その世代の
// 対象の列挙が済んだときだけ通す（復元の前の候補・解析から自動実行しない）。知らない取得範囲は止める。
export function restoreCandidateAutoReasons(input: {
  readonly scope_id: string;
  readonly restore_hold_active: boolean;
  readonly scopes: readonly RestoreScopeResync[];
}): readonly 'restore_resync_pending'[] {
  if (!input.restore_hold_active) return [];
  const scope = input.scopes.find((item) => item.scope_id === input.scope_id);
  if (
    scope === undefined ||
    scope.full_resync_generation === null ||
    scope.analysis_plan_complete_generation === null ||
    !DECIMAL.test(scope.full_resync_generation) ||
    !DECIMAL.test(scope.analysis_plan_complete_generation) ||
    BigInt(scope.analysis_plan_complete_generation) <
      BigInt(scope.full_resync_generation)
  )
    return ['restore_resync_pending'];
  return [];
}

// --- RestoreAftermath の組み立て ---

export type RestoreAftermathBuild =
  | {
      readonly ok: true;
      readonly after_restore: {
        readonly new_store_generation: string;
        readonly applied_forgetting_generation: string;
        readonly expired_deleted_count: number;
        readonly forgotten_applied_count: number;
        readonly approvals_revoked_count: number;
        readonly operations_held_count: number;
        readonly operations_unverified_count: number;
        readonly consents_reset: true;
        readonly connections_reauth_required: true;
      };
    }
  | {
      readonly ok: false;
      readonly reasons: readonly (
        | 'store_generation_invalid'
        | 'store_generation_not_renewed'
        | 'generation_invalid'
        | 'count_invalid'
        | 'quarantine_failed'
      )[];
    };

// 新しい DB の世代は、バックアップの世代とも、復元の前の今の世代とも違う値（端末が古いイベントのカーソルを使えない）。
export function buildRestoreAftermath(input: {
  readonly new_store_generation: string;
  readonly backup_store_generation: string;
  readonly current_store_generation: string | null;
  readonly applied_forgetting_generation: string;
  readonly expired_deleted_count: number;
  readonly forgotten_applied_count: number;
  readonly quarantine: QuarantinePlan;
}): RestoreAftermathBuild {
  const reasons = new Set<
    | 'store_generation_invalid'
    | 'store_generation_not_renewed'
    | 'generation_invalid'
    | 'count_invalid'
    | 'quarantine_failed'
  >();
  if (!UUID_V4.test(input.new_store_generation))
    reasons.add('store_generation_invalid');
  if (
    input.new_store_generation === input.backup_store_generation ||
    input.new_store_generation === input.current_store_generation
  )
    reasons.add('store_generation_not_renewed');
  if (!DECIMAL.test(input.applied_forgetting_generation))
    reasons.add('generation_invalid');
  for (const count of [
    input.expired_deleted_count,
    input.forgotten_applied_count,
  ])
    if (!Number.isSafeInteger(count) || count < 0) reasons.add('count_invalid');
  if (!input.quarantine.ok) reasons.add('quarantine_failed');
  if (reasons.size > 0 || !input.quarantine.ok)
    return { ok: false, reasons: [...reasons] };
  return {
    ok: true,
    after_restore: {
      new_store_generation: input.new_store_generation,
      applied_forgetting_generation: input.applied_forgetting_generation,
      expired_deleted_count: input.expired_deleted_count,
      forgotten_applied_count: input.forgotten_applied_count,
      approvals_revoked_count: input.quarantine.approvals_revoked_count,
      operations_held_count: input.quarantine.operations_held_count,
      operations_unverified_count: input.quarantine.operations_unverified_count,
      consents_reset: true,
      connections_reauth_required: true,
    },
  };
}
