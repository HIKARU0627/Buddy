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
  // 意図の承認の要否（ADR 0004 の意図表。memory_forget・memory_save・handoff_screen などは none）。省略は required
  // として扱う（承認待ちへ戻すのが保留の側）。
  readonly approval_requirement?: 'required' | 'none';
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
  | 'approval_not_revoked'
  | 'local_command_unapproved_state';

// 復元の直後の記録の検査（契約の意味検査と同じ）。承認の失効は、印の有無・経路によらず検査する（J3 は全承認）。
// 承認が失効した後に、LocalCommand が承認済み・準備中のまま残っていないことも検査する（Sonnet の P3-5）。
export function restoredOperationProblems(
  op: RestoredOperationLike,
): RestoredOperationProblem[] {
  const problems: RestoredOperationProblem[] = [];
  const marked = op.restore_unverified_at !== null;
  if (op.effect_route === 'local_command') {
    if (marked) problems.push('local_command_quarantined');
    if (op.state === 'approved' || op.state === 'preparing')
      problems.push('local_command_unapproved_state');
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
      // （承認のないまま承認済みに残すと、本人がもう一度承認する経路がない。U77）。承認の要らない意図（none）は
      // 承認待ちへ戻すと行き場がないので取り消す（本人がもう一度頼む。復元した DB では適用されていない。Sonnet の P3-5）。
      const inFlight = state === 'approved' || state === 'preparing';
      const next = !inFlight
        ? state
        : op.approval_requirement === 'none'
          ? 'cancelled'
          : 'awaiting_approval';
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
      // 本人が画面で見て決着させた内容版と、その確認の ID（Sonnet の P3-3。見ていない内容版の印を外さない）。
      readonly confirmed_content_version?: string;
      readonly confirmation_id?: string;
    };

// 復元の証拠による遷移（08 §3 の通常の遷移表の外。Sonnet の P3-4）。印のある操作は、復元の後に承認待ち・結果不明・
// 未実行のどれかにある。積極的な証拠（import_result）と本人の「実行済み」は、そこから成功へ直接進める（バックアップの後に
// 承認・送出・成功したことを取り込む。再送しない）。ほかの状態からは進めない。
export const RESTORE_EVIDENCE_TRANSITIONS: Readonly<
  Partial<Record<OperationState, readonly OperationState[]>>
> = {
  awaiting_approval: ['succeeded'],
  unknown_held: ['succeeded'],
  not_executed: ['succeeded'],
};

const evidenceAllows = (from: OperationState): boolean =>
  RESTORE_EVIDENCE_TRANSITIONS[from]?.includes('succeeded') ?? false;

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
      if (!marked) return { result: 'rejected', reason: 'not_quarantined' };
      // 本人が見た内容版が今の内容版と同じで、確認の ID があるときだけ印を外す。
      return step.confirmed_content_version === op.content_version &&
        typeof step.confirmation_id === 'string' &&
        UUID_V4.test(step.confirmation_id)
        ? { result: 'released', reason: null }
        : { result: 'rejected', reason: 'owner_confirmation_mismatch' };
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
      if (!evidenceAllows(op.state)) return reject('transition_not_allowed');
      return {
        decision: guard,
        operation: { ...op, state: 'succeeded', restore_unverified_at: null },
      };
    case 'owner_resolve': {
      const resolution = step.resolution;
      if (resolution === 'executed') {
        if (!evidenceAllows(op.state)) return reject('transition_not_allowed');
        return {
          decision: guard,
          operation: { ...op, state: 'succeeded', restore_unverified_at: null },
        };
      }
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
// 復元していれば、保留の月が空（計画できなかった）でも止める。確認は、復元の時刻以後にしたものだけを数える（復元した
// DB に残っていた古い確認で解かない。Sonnet の P3-2）。
export function restoreBudgetHoldReasons(input: {
  // 効いている復元の時刻（復元していなければ null）。
  readonly restored_at: string | null;
  readonly held_months: readonly string[];
  readonly current_month: string | null;
  readonly confirmations: readonly {
    readonly month: string;
    readonly confirmed_at: string;
  }[];
}): readonly 'budget_restore_hold'[] {
  if (input.restored_at === null) return [];
  const restored = parseBackupTime(input.restored_at);
  const current = input.current_month;
  if (
    restored === null ||
    current === null ||
    !/^[0-9]{4}-(0[1-9]|1[0-2])$/u.test(current) ||
    input.held_months.length === 0
  )
    return ['budget_restore_hold'];
  const last = [...input.held_months].sort().at(-1) ?? current;
  if (current > last) return [];
  const confirmed = input.confirmations.some((row) => {
    const at = parseBackupTime(row.confirmed_at);
    return row.month === current && at !== null && at >= restored;
  });
  if (input.held_months.includes(current) && confirmed) return [];
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
  // 端末ごとの音声・出力先の世代（device_epochs の io・output・audio・session）を、復元した値と復元の前の値の大きい方
  // より 1 つ進め、復元の前の結果を受け付けない（巻き戻さない。ADR 0005。restoreVoicePlan）。
  'advance_epochs',
  // 入出力を止めた状態に倒す（io_stop_state の全体停止・端末ごとの停止。ADR 0046 の残ること。restoreVoicePlan）。
  'stop_io',
  // 復元で開いたままに戻った Live の接続を lost・close_unconfirmed にする（新しい Live を開けなくなる 409 を防ぎ、
  // 使用量は確認できないとして扱う。restoreVoicePlan）。
  'close_restored_live_sessions',
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
  // 中枢以外のすべての端末を、ペアリングし直すまで認可しない（本人の判断 2026-10-24。U78。restoreDevicePlan）。
  'revoke_non_hub_devices',
  // 予算の超過枠の承認（pending・approved）を失効させる（restoreOverageApprovalPlan。Sonnet の P2-1）。
  'expire_overage_approvals',
  // 安全停止を stopped にし、本人が再開するまで自動実行を止める（司令塔の判断。restoreSafetyBreaker）。
  'stop_safety_breaker',
  // 有効だった配備を evaluated に落とし、有効にし直すのは本人の操作にする（司令塔の判断。restoreDeploymentPlan）。
  'demote_active_deployments',
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

// --- 端末・超過枠の承認・安全停止・配備（差し替えと同じ transaction で書く） ---

export interface RestoredDevice {
  readonly device_id: string;
  // 中枢と同じマシンの端末（devices.hub_local）。
  readonly hub_local: boolean;
  readonly revoked_at: string | null;
}

export type RestoreDevicePlan =
  | {
      readonly ok: true;
      // 復元の時刻で失効させる端末（まだ失効していないもの。中枢と同じマシンの端末は、下の条件のときだけ）。
      readonly revoke: readonly string[];
      readonly devices_revoked_count: number;
    }
  | { readonly ok: false; readonly reason: 'restored_at_invalid' };

// 復元したバックアップは古いので、バックアップの後に取り消した端末が有効に戻る（revoked_at・token_hash の巻き戻り。
// Sonnet の P1-1）。本人の判断（2026-10-24。U78）で、中枢以外のすべての端末を、ペアリングし直すまで認可しない。
// 失効済みの端末は元の時刻のまま。中枢と同じマシンの端末（hub_local）は、復元の前の中枢が生きていて（復元の前の
// devices が読める）、その時点で同じ端末が失効していないときだけ残す（中枢の画面の操作の経路）。復元の前に失効していた・
// 復元の前の DB にない hub_local の端末と、中枢を失ったとき（復元の前の値がない。新しい中枢で付け直す）は失効させる
// （Sonnet の再確認の P2-C）。
export function restoreDevicePlan(
  devices: readonly RestoredDevice[],
  restoredAt: string,
  preRestoreDevices: readonly RestoredDevice[] | null = null,
): RestoreDevicePlan {
  if (parseBackupTime(restoredAt) === null)
    return { ok: false, reason: 'restored_at_invalid' };
  const liveBefore = new Set(
    (preRestoreDevices ?? [])
      .filter((device) => device.revoked_at === null)
      .map((device) => device.device_id),
  );
  const keepHub = (device: RestoredDevice): boolean =>
    device.hub_local &&
    preRestoreDevices !== null &&
    liveBefore.has(device.device_id);
  const revoke = devices
    .filter((device) => device.revoked_at === null && !keepHub(device))
    .map((device) => device.device_id)
    .sort();
  return { ok: true, revoke, devices_revoked_count: revoke.length };
}

// 超過枠の承認（budget_overage_approvals）。バックアップの時点で approved でも、その後に使った（consumed）かもしれない。
// 復元で approved に戻ると、もう一度使えて二重に払い得る（Sonnet の P2-1）。pending・approved を expired にする。
export function restoreOverageApprovalPlan(
  approvals: readonly {
    readonly approval_id: string;
    readonly status: string;
  }[],
): {
  readonly expire: readonly string[];
  readonly overage_approvals_expired_count: number;
} {
  const expire = approvals
    .filter((row) => row.status === 'pending' || row.status === 'approved')
    .map((row) => row.approval_id)
    .sort();
  return { expire, overage_approvals_expired_count: expire.length };
}

export type RestoreSafetyState =
  | {
      readonly ok: true;
      readonly state: 'stopped';
      readonly safety_revision: string;
      readonly stop_reason: 'restored_from_backup';
      readonly stopped_at: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'restored_at_invalid' | 'safety_revision_invalid';
    };

// 安全停止（safety_breaker）。復元で running に戻ると、バックアップの後に止めた自動実行が動き出す（Sonnet の P2-2）。
// 司令塔の判断で、復元の後は止めて、本人が画面で再開するまで止める（03 の解除は本人の画面操作だけ）。理由は契約の
// SafetyState.stop_reason に足した restored_from_backup（既存の 3 つは件数・同じ対象・補償の失敗で、意味が違う）。
// 止めている間は、方針による自動承認（候補起点・本人の依頼起点の両方。auto_actions・取り消しの補償を含む）が起きない。
// safety_revision は、復元した値と復元の前の値（中枢を失ったときは null）の大きい方に 1 を足す（端末が持つ古い版で
// 解除の操作を通さない。Sonnet の再確認の P3-2）。
export function restoreSafetyBreaker(input: {
  readonly safety_revision: string;
  readonly pre_restore_safety_revision?: string | null;
  readonly restored_at: string;
}): RestoreSafetyState {
  if (parseBackupTime(input.restored_at) === null)
    return { ok: false, reason: 'restored_at_invalid' };
  const before = input.pre_restore_safety_revision ?? null;
  if (
    !DECIMAL.test(input.safety_revision) ||
    (before !== null && !DECIMAL.test(before))
  )
    return { ok: false, reason: 'safety_revision_invalid' };
  const restored = BigInt(input.safety_revision);
  const previous = before === null ? 0n : BigInt(before);
  return {
    ok: true,
    state: 'stopped',
    safety_revision: String((restored > previous ? restored : previous) + 1n),
    stop_reason: 'restored_from_backup',
    stopped_at: input.restored_at,
  };
}

// 配備（deployments）。復元で、バックアップの後に停止・退役した配備が active に戻り得る（Sonnet の P2-7）。司令塔の判断で、
// active は evaluated に落とし、有効にし直すのは本人の操作にする。suspended・retired はそのまま（有効に戻さない）。
// settings_only で戻すときも同じ。
export function restoreDeploymentPlan(
  deployments: readonly {
    readonly deployment_id: string;
    readonly stage: string;
  }[],
): {
  readonly demote: readonly string[];
  readonly deployments_demoted_count: number;
} {
  const demote = deployments
    .filter((row) => row.stage === 'active')
    .map((row) => row.deployment_id)
    .sort();
  return { demote, deployments_demoted_count: demote.length };
}

// --- 音声の世代・入出力の停止・Live の接続（0009、B05-03。ADR 0005・0038・0046） ---

export interface DeviceEpochRow {
  readonly device_id: string;
  readonly io_epoch: string;
  readonly output_epoch: string;
  readonly audio_epoch: string;
  readonly session_epoch: string;
  readonly local_stop: boolean;
}

export interface IoStopRow {
  readonly guest_mode: boolean;
  readonly global_stop: boolean;
}

export interface RestoredLiveSession {
  readonly live_session_id: string;
  readonly control_state: string;
  readonly control_epoch: string;
  readonly closure: string;
  readonly ended_at?: string | null;
  readonly end_reason?: string | null;
}

// 復元の後の Live の接続（変える行だけ）。中枢の起動時の照合（voice-control.ts の start()）が nextLiveControl でたどる
// 連鎖（connecting・ready → core_restarted → lost、open → close_requested → closing、closing → close_unconfirmed →
// closed）と同じ形にする。closed・close_unconfirmed は使用量の照合（usage_reconciled）と遅着の
// session_closed_received を受け付ける形で、未完了として数え直されない（Sonnet の再確認の P2-A）。
export interface RestoredLiveSessionUpdate {
  readonly live_session_id: string;
  readonly control_state: 'closed';
  readonly control_epoch: string;
  readonly closure: 'close_unconfirmed';
  readonly usage_seconds: null;
  readonly ended_at: string;
  readonly end_reason: string;
}

export type RestoreVoicePlan =
  | {
      readonly ok: true;
      readonly device_epochs: readonly DeviceEpochRow[];
      readonly io_stop: IoStopRow;
      readonly live_sessions: readonly RestoredLiveSessionUpdate[];
    }
  | {
      readonly ok: false;
      readonly reasons: readonly (
        | 'restored_at_invalid'
        | 'epoch_invalid'
        | 'duplicate_device'
        | 'live_session_invalid'
      )[];
    };

const EPOCH_KEYS = [
  'io_epoch',
  'output_epoch',
  'audio_epoch',
  'session_epoch',
] as const;

// 状態機械（nextLiveControl）で到達できる制御の状態と閉じ方の組。これ以外の組の記録は、何が起きたか分からないので
// 計画しない（保留の側）。
const LIVE_REACHABLE: Readonly<Record<string, readonly string[]>> = {
  connecting: ['open'],
  ready: ['open'],
  lost: ['open'],
  closing: ['close_requested'],
  closed: ['close_confirmed', 'close_unconfirmed'],
};

// 復元の後の音声の状態（ADR 0047。原本に決めなし）。
// - 世代: 復元した device_epochs は、バックアップの後に進めた世代を失っている（巻き戻り）。復元した devices の端末ごとに
//   4 つの世代を、復元した値と復元の前の DB の値（中枢を失ったときは null）の大きい方より 1 つ進める（ADR 0005 の巻き
//   戻さない、ADR 0038 の「復元後の最初の発行の前に進める」）。復元した device_epochs に行がない端末（devices にはある）は、
//   復元の前の値があればそれより 1 つ、なければ 0 より 1 つ進めた行を作る（再確認の P2-B）。中枢を失ったときは復元の前の
//   値を取り戻せないが、DB の世代の更新と端末の失効（U78）で、古い世代を持つ接続は受け付けない。
// - 停止: 全体停止と端末ごとの停止を立てる（本人が解除するまで止める。07 §5 の自動解除しない）。来客モードは、復元した
//   値と復元の前の値のどちらかで立っていれば立てる（解除された状態に戻さない）。
// - Live の接続: 閉じ終えていない接続（closed 以外）は、中枢の起動時の照合と同じ連鎖で
//   closed・close_unconfirmed・usage_seconds null にする。connecting・ready は control_epoch を 1 進める。終了の時刻がなければ
//   復元の時刻、理由がなければ core_lease_lost（起動時の照合と同じ）。予約は restoreBudgetHold で使用量不明のまま残る。
export function restoreVoicePlan(input: {
  readonly restored_at: string;
  // 復元した devices の端末（世代の行を作る相手）。
  readonly restored_device_ids: readonly string[];
  readonly device_epochs: readonly DeviceEpochRow[];
  readonly pre_restore_device_epochs: readonly DeviceEpochRow[] | null;
  readonly io_stop: IoStopRow;
  readonly pre_restore_io_stop: IoStopRow | null;
  readonly live_sessions: readonly RestoredLiveSession[];
}): RestoreVoicePlan {
  const reasons = new Set<
    | 'restored_at_invalid'
    | 'epoch_invalid'
    | 'duplicate_device'
    | 'live_session_invalid'
  >();
  if (parseBackupTime(input.restored_at) === null)
    reasons.add('restored_at_invalid');
  const rows = [
    ...input.device_epochs,
    ...(input.pre_restore_device_epochs ?? []),
  ];
  if (rows.some((row) => EPOCH_KEYS.some((key) => !DECIMAL.test(row[key]))))
    reasons.add('epoch_invalid');
  const lists = [
    input.restored_device_ids,
    input.device_epochs.map((row) => row.device_id),
    (input.pre_restore_device_epochs ?? []).map((row) => row.device_id),
  ];
  if (lists.some((ids) => new Set(ids).size !== ids.length))
    reasons.add('duplicate_device');
  if (
    input.live_sessions.some(
      (row) =>
        !Object.hasOwn(LIVE_REACHABLE, row.control_state) ||
        !(LIVE_REACHABLE[row.control_state] ?? []).includes(row.closure) ||
        !DECIMAL.test(row.control_epoch),
    )
  )
    reasons.add('live_session_invalid');
  if (reasons.size > 0) return { ok: false, reasons: [...reasons] };
  const restored = new Map(
    input.device_epochs.map((row) => [row.device_id, row]),
  );
  const pre = new Map(
    (input.pre_restore_device_epochs ?? []).map((row) => [row.device_id, row]),
  );
  // 復元した devices の端末の順、続けて devices にないが device_epochs にある行（外部キーの上ではない形。進めて残す）。
  const ids = [
    ...input.restored_device_ids,
    ...input.device_epochs
      .map((row) => row.device_id)
      .filter((id) => !input.restored_device_ids.includes(id)),
  ];
  const device_epochs = ids.map((id): DeviceEpochRow => {
    const now = restored.get(id);
    const before = pre.get(id);
    const next = (key: (typeof EPOCH_KEYS)[number]): string => {
      const a = now === undefined ? 0n : BigInt(now[key]);
      const b = before === undefined ? 0n : BigInt(before[key]);
      return ((a > b ? a : b) + 1n).toString();
    };
    return {
      device_id: id,
      io_epoch: next('io_epoch'),
      output_epoch: next('output_epoch'),
      audio_epoch: next('audio_epoch'),
      session_epoch: next('session_epoch'),
      local_stop: true,
    };
  });
  const live_sessions = input.live_sessions.flatMap(
    (row): RestoredLiveSessionUpdate[] => {
      // 閉じ終えた接続（closed）は触らない（起動時の照合の対象外）。
      if (row.control_state === 'closed') return [];
      const bumped =
        row.control_state === 'connecting' || row.control_state === 'ready';
      return [
        {
          live_session_id: row.live_session_id,
          control_state: 'closed',
          control_epoch: bumped
            ? (BigInt(row.control_epoch) + 1n).toString()
            : row.control_epoch,
          closure: 'close_unconfirmed',
          usage_seconds: null,
          ended_at: row.ended_at ?? input.restored_at,
          end_reason: row.end_reason ?? 'core_lease_lost',
        },
      ];
    },
  );
  return {
    ok: true,
    device_epochs,
    io_stop: {
      guest_mode:
        input.io_stop.guest_mode ||
        (input.pre_restore_io_stop?.guest_mode ?? false),
      global_stop: true,
    },
    live_sessions,
  };
}
