// 操作の内部状態と許される遷移（設計 08 §3・§4、ADR 0027）。
// dispatching 以降は取消済みにせず、結果不明を自動再送しない。

export type OperationState =
  | 'awaiting_approval'
  | 'approved'
  | 'preparing'
  | 'dispatching'
  | 'reconciling'
  | 'succeeded'
  | 'unknown_held'
  | 'not_executed'
  | 'cancelled'
  | 'superseded';

// 変更を伴う操作の経路。Read は操作にならない（intents.ts の ExecutionRoute と同じ値）。
export type OperationRoute = 'local_command' | 'remote_mutation';

// 経路に共通の遷移。
// D1（ADR 0027）: 内容版の更新は同じ operation_id のまま content_version を上げ、awaiting_approval に戻る
// （承認待ちの自分自身への遷移を含む）。送出境界（dispatching）の手前と、未実行が確定した後だけ。
// superseded は操作そのものを別の操作で置き換えるとき（種類や口座が変わるなど）に残す。
export const OPERATION_TRANSITIONS: Readonly<
  Record<OperationState, readonly OperationState[]>
> = {
  awaiting_approval: [
    'awaiting_approval',
    'approved',
    'cancelled',
    'superseded',
  ],
  approved: ['awaiting_approval', 'preparing', 'cancelled', 'superseded'],
  // 対象の前提が変われば送出せず、内容版を上げて承認待ちへ戻す（X09、D1）。
  preparing: ['awaiting_approval', 'dispatching', 'cancelled', 'superseded'],
  dispatching: ['reconciling', 'unknown_held'],
  reconciling: ['succeeded', 'unknown_held', 'not_executed'],
  unknown_held: ['reconciling', 'succeeded', 'not_executed'],
  // 未実行が確定した同じ内容への本人の明示再試行は新しい試行で準備へ戻る。内容を変えるなら D1。
  not_executed: ['awaiting_approval', 'preparing', 'superseded'],
  succeeded: [],
  cancelled: [],
  superseded: [],
};

// 経路だけに許す遷移。
// D5（ADR 0027）: LocalCommand は外部 HTTP を使わず、承認の後に一つの transaction で適用するので、
// approved から succeeded へ直接進める。RemoteMutation は必ず送出境界と照合を通る。
export const ROUTE_ONLY_TRANSITIONS: Readonly<
  Record<
    OperationRoute,
    Readonly<Partial<Record<OperationState, readonly OperationState[]>>>
  >
> = {
  local_command: { approved: ['succeeded'] },
  remote_mutation: {},
};

// 自動実行（方針による自動承認）は awaiting_approval を通らず approved から始まる。
export const INITIAL_OPERATION_STATES: readonly OperationState[] = [
  'awaiting_approval',
  'approved',
];

// 経路を渡さなければ共通の遷移だけを許す（経路だけの遷移は、経路が分かる呼び出し側だけが使える）。
export function canTransition(
  from: OperationState,
  to: OperationState,
  route: OperationRoute | null = null,
): boolean {
  if (OPERATION_TRANSITIONS[from].includes(to)) return true;
  if (route === null) return false;
  return ROUTE_ONLY_TRANSITIONS[route][from]?.includes(to) ?? false;
}

// D1: 内容版を更新してよい状態。送出境界を越えた状態（dispatching・reconciling・unknown_held）と終端では更新しない。
export const CONTENT_REVISABLE_STATES: readonly OperationState[] = [
  'awaiting_approval',
  'approved',
  'preparing',
  'not_executed',
];

export interface ContentRevisionInput {
  readonly state: OperationState;
  readonly current_content_version: string;
  readonly current_content_hash: string;
  readonly next_content_hash: string;
  // 現在の内容版に有効な承認（valid）があるか。使い終えた（consumed）承認は成功の後だけなので、ここには来ない。
  readonly has_valid_approval: boolean;
  // 実行中の試行（preparing）があるか。送出意図を保存した試行はここに来ない（状態が dispatching 以降になる）。
  readonly has_active_attempt: boolean;
}

export type ContentRevisionDecision =
  | {
      readonly ok: true;
      readonly next_state: 'awaiting_approval';
      readonly next_content_version: string;
      // 旧版の承認を revoked にする。
      readonly revoke_approval: boolean;
      // 旧版の実行中の試行を superseded にする。
      readonly supersede_attempt: boolean;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly string[];
    };

const DECIMAL = /^(0|[1-9][0-9]*)$/u;

// D1: 内容版の更新を決める純粋な判定。内容（hash）が変わらなければ版を上げない（ContentVersion の定義）。
// 最終の保証は DB worker の transaction（旧版の承認の失効・試行の置換・新しい版の保存を一つで行う）。
export function planContentRevision(
  input: ContentRevisionInput,
): ContentRevisionDecision {
  const reasons: string[] = [];
  if (!CONTENT_REVISABLE_STATES.includes(input.state))
    reasons.push(
      ['dispatching', 'reconciling', 'unknown_held'].includes(input.state)
        ? 'dispatch_boundary_crossed'
        : 'operation_finished',
    );
  if (!DECIMAL.test(input.current_content_version))
    reasons.push('content_version_invalid');
  if (input.next_content_hash === input.current_content_hash)
    reasons.push('content_unchanged');
  if (input.has_active_attempt && input.state !== 'preparing')
    reasons.push('attempt_state_mismatch');
  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    next_state: 'awaiting_approval',
    next_content_version: String(BigInt(input.current_content_version) + 1n),
    revoke_approval: input.has_valid_approval,
    supersede_attempt: input.has_active_attempt,
  };
}
