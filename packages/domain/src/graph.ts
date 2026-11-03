// Outlook（Microsoft Graph）のアカウント種別・委任・拒否の理由・カテゴリの扱い（設計 04 接続・権限、
// 設計 11 §5A、QA22・QA23、ADR 0072）。Graph の実装は B09-02。ここは純粋な語彙と接続の状態の検査だけを持つ。

export const GRAPH_ACCOUNT_KINDS = ['personal', 'work_or_school'] as const;
export type GraphAccountKind = (typeof GRAPH_ACCOUNT_KINDS)[number];

export const GRAPH_DELEGATION_SCOPES = ['delegated_user'] as const;
export type GraphDelegationScope = (typeof GRAPH_DELEGATION_SCOPES)[number];

export const GRAPH_REJECTION_REASONS = [
  'insufficient_permission',
  'organization_policy',
  'admin_consent_required',
  'tenant_restriction',
  'unknown',
] as const;
export type GraphRejectionReason = (typeof GRAPH_REJECTION_REASONS)[number];

// 初期版は案の表示だけ。If-Match の検証ができるまで自動付与しない（D7、設計 11 §5A）。
export const GRAPH_CATEGORY_UPDATE_MODES = ['display_only'] as const;
export type GraphCategoryUpdateMode =
  (typeof GRAPH_CATEGORY_UPDATE_MODES)[number];

export interface GraphAccountStateLike {
  readonly account_kind: GraphAccountKind;
  readonly delegation: GraphDelegationScope;
  readonly rejection_reason: GraphRejectionReason | null;
  readonly category_updates: GraphCategoryUpdateMode;
}

// 接続の要約と Outlook の状態の整合。拒否の理由がある接続を active にしない。
export function connectionAccountErrors(input: {
  readonly provider: string;
  readonly status: string;
  readonly graph_account: GraphAccountStateLike | null | undefined;
}): string[] {
  const errors: string[] = [];
  if (input.provider === 'microsoft' && !input.graph_account)
    errors.push('graph_account_missing');
  if (input.provider !== 'microsoft' && input.graph_account)
    errors.push('graph_account_unexpected');
  if (
    input.graph_account?.rejection_reason !== null &&
    input.graph_account?.rejection_reason !== undefined &&
    input.status === 'active'
  )
    errors.push('rejection_with_active');
  return errors;
}
