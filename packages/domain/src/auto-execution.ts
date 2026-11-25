// 候補起点の自動実行の判定表（設計 11 §5・§5A・§5B、08 §9、04 の自動実行の範囲、ADR 0146）。
// B00 からある部品（共通検査・行の条件・重複・関連解析・安全停止の時間窓・方針）を、
// 1 つの候補の 1 つの操作についての判定にまとめる。auto_eligible は B13-04 の最終ガード
// （LocalCommand の変更 transaction・RemoteMutation の dispatching 直前 transaction）へ進む資格であり、
// 送出の許可ではない。判定は Core が別に確かめた事実だけから作り、モデル・端末の申告を入れない。

import {
  analysisReadiness,
  autoCreationReasons,
  type AnalysisState,
  type EntityRecord,
  type ResolvedChange,
} from './analysis.js';
import {
  autoApprovalAllowed,
  autoExecutionEnabled,
  type AutoApprovalCounter,
  type AutoExecutionPolicy,
  type AutoExecutionRule,
} from './approval.js';
import {
  autoOperationReasons,
  candidateCommonReasons,
  type AutoOperation,
  type AutoOperationContext,
  type CandidateRequest,
  type Completeness,
} from './extraction.js';

// 判定表の 4 行と、方針の規則（ADR 0074 の AUTO_EXECUTION_RULES）の対応。
export const AUTO_OPERATION_RULES: Readonly<
  Record<AutoOperation, AutoExecutionRule>
> = {
  create_task: 'task.register',
  create_event: 'event.create_own',
  label_mail: 'mail.apply_existing_label',
  draft_reply: 'mail.save_draft',
};

// 判定の結果。
// auto_eligible: 方針による自動承認へ進める（最終ガードは B13-04）。
// needs_approval: 自動では実行せず、画面上の案として本人の承認へ回す（Outlook のカテゴリ付与、質問 133）。
// hold: 今は判定できない。解除・解析の完了・版の更新の後に、同じ候補を判定し直す。
// notice_only: この候補の版からは自動実行も承認待ちも作らず、気づきだけにする（11 §5 の最後の行）。
export type AutoExecutionDecision =
  'auto_eligible' | 'needs_approval' | 'hold' | 'notice_only';

// ラベル・カテゴリを付ける元サービス。Gmail のラベル追加は加算の操作として先に自動実行し、
// Outlook のカテゴリ付与は If-Match の検証までは画面上の案に留める（04、11 §5A、質問 133）。
export type LabelProvider = 'google' | 'microsoft' | 'mock';

// Outlook のカテゴリ付与で If-Match を検証済みか。検証は B13-04 の connector の書込みと実 API の確認
// （B15）で行う。検証が済むまで false のまま変えない。
export const GRAPH_CATEGORY_AUTO_VERIFIED = false;

// 重複キーの対象（11 §5 の表）。用事は対象アカウント、予定は対象アカウントとカレンダー。
// ラベルと下書きは原本に重複キーの記述が無く、ADR 0146 で「依頼・操作・アカウント」に決めた（U298）。
export interface AutoOperationTarget {
  readonly account_id: string;
  readonly calendar_id: string | null;
}

// Core が別の検査で確かめた事実。
export interface AutoExecutionFacts {
  readonly operation: AutoOperation;
  readonly policy: AutoExecutionPolicy | null | undefined;
  // 判定に使う方針の版が現在の版か。古い版で判定した結果を新しい内容へ流用しない（08 §1）。
  readonly policy_current: boolean;
  // 許可の版（取得範囲・接続の許可）が現在の版か。
  readonly permission_current: boolean;
  readonly safety_stopped: boolean;
  readonly auto_approvals: AutoApprovalCounter | null | undefined;
  readonly now: string;
  // 初回取り込みで作った候補か。初回取り込みと過去の期限は候補起点の対象外（04、11 §5）。
  readonly initial_import: boolean;
  readonly request: CandidateRequest;
  readonly completeness: Completeness;
  readonly received_at_local: string;
  readonly context: AutoOperationContext;
  readonly label_provider: LabelProvider | null;
  readonly analysis: AnalysisState;
  readonly current_published_generation: string;
  readonly entity: EntityRecord;
  readonly changes: readonly ResolvedChange[];
  readonly target: AutoOperationTarget;
}

export interface AutoExecutionJudgment {
  readonly decision: AutoExecutionDecision;
  readonly rule: AutoExecutionRule;
  // 重複キー。auto_eligible と needs_approval のときだけ持つ。
  readonly duplicate_key: string | null;
  readonly reason_codes: readonly string[];
}

const unique = (reasons: readonly string[]): string[] =>
  reasons.filter((reason, index) => reasons.indexOf(reason) === index);

// 重複キーを、区切りの曖昧さが無い形（JSON の配列）で作る。予定だけがカレンダーを含む。
export function autoExecutionDuplicateKey(
  requestEntityId: string,
  operation: AutoOperation,
  target: AutoOperationTarget,
): string {
  if (operation === 'create_event' && target.calendar_id === null)
    throw new TypeError('create_event needs a calendar_id');
  if (operation !== 'create_event' && target.calendar_id !== null)
    throw new TypeError(`${operation} does not take a calendar_id`);
  return JSON.stringify(
    operation === 'create_event'
      ? [requestEntityId, operation, target.account_id, target.calendar_id]
      : [requestEntityId, operation, target.account_id],
  );
}

// 1 つの候補の 1 つの操作の判定。理由は次の順に見て、先に当たった種類で決める。
// 1. この候補の版では自動実行の資格が無い（方針で無効・初回取り込み・根拠・行の条件）→ notice_only
// 2. 待てば判定が変わりうる（安全停止・時間窓の上限・版の変化・関連解析の未完了）→ hold
// 3. 関連解析が済んだうえで、依頼が取消・完了・抑止・作成済み → notice_only
// 4. Outlook のカテゴリ付与（If-Match の検証前）→ needs_approval
// 5. それ以外 → auto_eligible
// 関連解析が済む前は、取消・完了の解決（3）を確定させない（11 §5B）。
export function judgeAutoExecution(
  facts: AutoExecutionFacts,
): AutoExecutionJudgment {
  const rule = AUTO_OPERATION_RULES[facts.operation];
  const notice: string[] = [];
  if (!autoExecutionEnabled(facts.policy, rule)) notice.push('policy_disabled');
  if (facts.initial_import) notice.push('initial_import');
  notice.push(
    ...candidateCommonReasons(
      facts.request,
      facts.completeness,
      facts.received_at_local,
    ),
    ...autoOperationReasons(facts.operation, facts.request, facts.context),
  );
  if (facts.operation === 'label_mail' && facts.label_provider === null)
    notice.push('label_provider_unknown');
  if (notice.length)
    return {
      decision: 'notice_only',
      rule,
      duplicate_key: null,
      reason_codes: unique(notice),
    };

  const hold: string[] = [];
  if (facts.safety_stopped) hold.push('safety_stopped');
  else if (!autoApprovalAllowed(facts.auto_approvals, facts.now))
    hold.push('rate_exceeded');
  if (!facts.policy_current) hold.push('policy_changed');
  if (!facts.permission_current) hold.push('permission_changed');
  hold.push(
    ...analysisReadiness(facts.analysis, facts.current_published_generation)
      .reasons,
  );
  if (hold.length)
    return {
      decision: 'hold',
      rule,
      duplicate_key: null,
      reason_codes: unique(hold),
    };

  const entity = autoCreationReasons(facts.entity, facts.changes, {
    kind: facts.operation,
    accountId: facts.target.account_id,
    calendarId: facts.target.calendar_id,
  });
  if (entity.length)
    return {
      decision: 'notice_only',
      rule,
      duplicate_key: null,
      reason_codes: unique(entity),
    };

  const duplicate_key = autoExecutionDuplicateKey(
    facts.entity.request_entity_id,
    facts.operation,
    facts.target,
  );
  if (
    facts.operation === 'label_mail' &&
    facts.label_provider === 'microsoft' &&
    !GRAPH_CATEGORY_AUTO_VERIFIED
  )
    return {
      decision: 'needs_approval',
      rule,
      duplicate_key,
      reason_codes: ['graph_category_unverified'],
    };
  return { decision: 'auto_eligible', rule, duplicate_key, reason_codes: [] };
}
