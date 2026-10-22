// 操作の種類ごとの規則と、connector（元サービスとの接続部）が宣言する能力（設計 08 §1〜4・09 §1、ADR 0027）。
// 経路・照合の範囲はコードの表が決め、connector やモデルの申告で広げない。照合は参照だけ（D4）。

import type { OperationRoute } from './operations.js';

// 操作の種類（契約の OperationKind、確定 intent の action.kind と同じ値）。
export const OPERATION_KINDS = [
  'mail.labels.change',
  'mail.draft.create',
  'task.create',
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

// 送出の直前に前提（対象の版・許可）を確かめる方法。
// conditional_request: 元サービスが版の一致を条件にした要求で、前提の崩れを原子的に拒否できる。
// recheck_before_dispatch: 送出の直前に Core が対象を読み直す。原子的ではないので、読み直しと送出の間の変更は照合で扱う。
// not_required: 外部の対象の前提がない（Buddy 内の用事など）。
export type PreconditionMethod =
  'conditional_request' | 'recheck_before_dispatch' | 'not_required';

// 結果不明のときに外部の状態を探す方法。
// by_remote_id: 対象 ID で読み、変更が適用済みかを見る。
// by_operation_marker: 作成物に付けた操作の目印（operationMarker）でアカウント内を探す。
// none: 外部を探さない（LocalCommand は transaction の結果が正本）。
export type LookupMethod = 'by_remote_id' | 'by_operation_marker' | 'none';

// 照合の範囲（契約の確定 intent の effects.reconcile_scope と同じ値）。
export type ReconcileScope =
  'exact_target' | 'operation_marker' | 'local_transaction';

// 操作の工程（operation_steps.step_kind）。2 工程の操作（下書き → 送信）は D3 で仕組みだけを作り、X10 の合格は B14。
export type OperationStepKind =
  'apply_labels' | 'create_draft' | 'send' | 'create_task';
// connector が読める対象（Read。承認なし）。照合の lookup もこの読み取りで行う。
export type ConnectorReadKind =
  'permission' | 'mail.message' | 'mail.draft' | 'calendar.events';

export interface OperationKindRule {
  readonly route: OperationRoute;
  readonly reconcile_scope: ReconcileScope;
  readonly lookup: LookupMethod;
  // lookup に要る読み取り。LocalCommand は null。
  readonly lookup_read: ConnectorReadKind | null;
  // connector が宣言してよい前提の確かめ方。
  readonly preconditions: readonly PreconditionMethod[];
  // 工程の並び。この順にだけ進める。
  readonly steps: readonly OperationStepKind[];
}

export const OPERATION_KIND_RULES: Readonly<
  Record<OperationKind, OperationKindRule>
> = {
  'mail.labels.change': {
    route: 'remote_mutation',
    reconcile_scope: 'exact_target',
    lookup: 'by_remote_id',
    lookup_read: 'mail.message',
    preconditions: ['conditional_request', 'recheck_before_dispatch'],
    steps: ['apply_labels'],
  },
  // 返信元（target）の版を前提にする。作成物は対象 ID が送出前に分からないので、目印で探す。
  'mail.draft.create': {
    route: 'remote_mutation',
    reconcile_scope: 'operation_marker',
    lookup: 'by_operation_marker',
    lookup_read: 'mail.draft',
    preconditions: ['conditional_request', 'recheck_before_dispatch'],
    steps: ['create_draft'],
  },
  // D5: 外部 HTTP なし。承認の後に一つの transaction で適用する（approved → succeeded）。
  'task.create': {
    route: 'local_command',
    reconcile_scope: 'local_transaction',
    lookup: 'none',
    lookup_read: null,
    preconditions: ['not_required'],
    steps: ['create_task'],
  },
};

export function isOperationKind(value: unknown): value is OperationKind {
  return (
    typeof value === 'string' &&
    (OPERATION_KINDS as readonly string[]).includes(value)
  );
}

export interface ConnectorReadCapability {
  readonly kind: ConnectorReadKind;
  readonly effect_kind: 'Read';
}

// 変更の能力。RemoteMutation だけ（LocalCommand は connector を持たない）。
export interface ConnectorWriteCapability {
  // 確定 intent の action.kind。
  readonly action_kind: OperationKind;
  readonly effect_kind: 'RemoteMutation';
  // HTTP の自動再送の回数。書込みは常に 0（結果不明の外部変更を自動再送しない）。
  readonly automatic_http_retries: 0;
  readonly precondition: PreconditionMethod;
  readonly lookup: LookupMethod;
  readonly reconcile_scope: ReconcileScope;
  readonly steps: readonly OperationStepKind[];
}

// connector（模擬 provider を含む）が宣言する能力。
export interface ConnectorCapability {
  readonly provider: string;
  readonly reads: readonly ConnectorReadCapability[];
  readonly writes: readonly ConnectorWriteCapability[];
}

// 宣言された能力が、種類ごとの規則に合うか。理由（書込みの理由は `action_kind:理由`）を返し、合えば空。
// 型を通らない値（JSON から読んだ設定など）も拒否できるよう、実行時にも確かめる。
export function checkConnectorCapability(
  capability: ConnectorCapability,
): string[] {
  const reasons: string[] = [];
  if (capability.provider.length === 0) reasons.push('provider_missing');
  const reads = new Set<string>();
  for (const read of capability.reads) {
    if (read.effect_kind !== 'Read')
      reasons.push(`${read.kind}:effect_kind_mismatch`);
    if (reads.has(read.kind)) reasons.push(`${read.kind}:duplicate_read`);
    reads.add(read.kind);
  }
  const seen = new Set<string>();
  for (const write of capability.writes) {
    const kind: string = write.action_kind;
    const add = (reason: string) => reasons.push(`${kind}:${reason}`);
    if (seen.has(kind)) add('duplicate_write');
    seen.add(kind);
    if (!isOperationKind(kind)) {
      add('operation_kind_unknown');
      continue;
    }
    const rule = OPERATION_KIND_RULES[kind];
    if (rule.route !== 'remote_mutation')
      add('local_command_without_connector');
    if (write.effect_kind !== 'RemoteMutation') add('effect_kind_mismatch');
    if (write.automatic_http_retries !== 0) add('automatic_retry_forbidden');
    if (!rule.preconditions.includes(write.precondition))
      add('precondition_not_allowed');
    if (write.lookup !== rule.lookup) add('lookup_mismatch');
    if (rule.lookup_read !== null && !reads.has(rule.lookup_read))
      add('lookup_read_missing');
    if (write.reconcile_scope !== rule.reconcile_scope)
      add('reconcile_scope_mismatch');
    if (
      write.steps.length !== rule.steps.length ||
      write.steps.some((step, index) => step !== rule.steps[index])
    )
      add('steps_mismatch');
  }
  return reasons;
}

const ID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

// 作成物に付ける操作の目印。operation_id と content_version だけから作り、試行 ID を含めない
// （未実行の確定の後の再試行でも、前の試行の遅れた適用を同じ目印で見つけるため）。
export function operationMarker(
  operationId: string,
  contentVersion: string,
): string {
  if (!ID_TEXT.test(operationId))
    throw new TypeError('operation_id は小文字の UUID にしてください。');
  if (!DECIMAL.test(contentVersion) || contentVersion === '0')
    throw new TypeError('content_version は 1 以上の 10 進にしてください。');
  return `buddy-op:${operationId}:${contentVersion}`;
}

// 照合で外部を一度読んだ結果。
// found: 対象に変更が適用済み、または目印の作成物がちょうど一つ。
// not_found: 見つからない。遅れて適用されうる（X08）ので、未実行の確定にはしない。
// multiple: 目印の作成物が複数。重複の可能性があり、本人の確認が要る。
// unreadable: 読めなかった（権限・通信）。
export type ReconcileObservation =
  | { readonly kind: 'found'; readonly external_id: string | null }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'multiple'; readonly count: number }
  | { readonly kind: 'unreadable' };

// D4: 応答を失った直後に一度だけ自動で照合し、その後は本人の「照合」だけ。照合は参照だけで、再送しない。
export const AUTO_RECONCILE_LIMIT = 1;

export function canAutoReconcile(autoReconcileCount: number): boolean {
  return (
    Number.isSafeInteger(autoReconcileCount) &&
    autoReconcileCount >= 0 &&
    autoReconcileCount < AUTO_RECONCILE_LIMIT
  );
}

// 照合の結果から次の状態を決める。成功の証拠があるときだけ succeeded、それ以外は unknown_held に留める。
// 照合だけで not_executed にはしない（未実行の確定は元サービスの確定した拒否など、別の証拠による）。
export function reconcileOutcome(observation: ReconcileObservation): {
  readonly state: 'succeeded' | 'unknown_held';
  readonly reasons: readonly string[];
} {
  switch (observation.kind) {
    case 'found':
      return { state: 'succeeded', reasons: [] };
    case 'not_found':
      return { state: 'unknown_held', reasons: ['not_found_may_apply_late'] };
    case 'multiple':
      return { state: 'unknown_held', reasons: ['multiple_matches'] };
    case 'unreadable':
      return { state: 'unknown_held', reasons: ['lookup_unreadable'] };
  }
}
