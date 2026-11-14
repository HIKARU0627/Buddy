// 公開 Web 調査の状態・出典・完了の知らせ（B12-02 P1、ADR 0125・0126）。
// 失敗・0 件・保留・取消は、完了と表示できない。完了は「自分で取得した本文を 1 ページ以上読み、要約を作れた」ときだけ。
// 検索結果（URL・タイトル・スニペット）は永続保存しない（Brave 利用条件 3(b)(i)、ADR 0077）。
// 実 API の呼出し・取得・保存はここでは行わない。

import {
  WEB_RESEARCH_MAX_PAGES,
  type WebUsagePolicyLike,
} from './web-research.js';

export type WebResearchState =
  | 'accepted'
  | 'searching'
  | 'reading'
  | 'summarizing'
  | 'completed'
  | 'no_results'
  | 'held'
  | 'failed'
  | 'canceled';

export type WebResearchStopReason =
  | 'zero_hits'
  | 'budget_held'
  | 'query_rejected'
  | 'search_failed'
  | 'no_readable_page'
  | 'summary_failed'
  | 'user_canceled'
  | 'superseded';

export const WEB_RESEARCH_STATES: readonly WebResearchState[] = [
  'accepted',
  'searching',
  'reading',
  'summarizing',
  'completed',
  'no_results',
  'held',
  'failed',
  'canceled',
];

// 終端。ここから動かず、やり直しは新しい依頼（新しい workflow_id か request_revision）で行う。
const TERMINAL: ReadonlySet<WebResearchState> = new Set([
  'completed',
  'no_results',
  'failed',
  'canceled',
]);

export function webResearchIsTerminal(state: WebResearchState): boolean {
  return TERMINAL.has(state);
}

// 手で書いた遷移表（設計 05・10 §5）。held からの再開は検索からやり直す:
// 検索結果と取得本文は永続保存しないので、止まった後に続きから読み直せる材料が残らない。
const NEXT: Readonly<Record<WebResearchState, readonly WebResearchState[]>> = {
  accepted: ['searching', 'held', 'failed', 'canceled'],
  searching: ['reading', 'no_results', 'held', 'failed', 'canceled'],
  reading: ['searching', 'summarizing', 'held', 'failed', 'canceled'],
  summarizing: ['completed', 'held', 'failed', 'canceled'],
  completed: [],
  no_results: [],
  held: ['searching', 'canceled'],
  failed: [],
  canceled: [],
};

export function webResearchNextStates(
  state: WebResearchState,
): readonly WebResearchState[] {
  return NEXT[state];
}

// kind（= 状態と同じ名前）ごとに許す理由。検索の失敗と 0 件は別の種類にし、読めたページが無いことは失敗にする。
const STOP_REASONS: Readonly<Record<string, readonly WebResearchStopReason[]>> =
  {
    no_results: ['zero_hits'],
    held: ['budget_held', 'query_rejected'],
    failed: ['search_failed', 'no_readable_page', 'summary_failed'],
    canceled: ['user_canceled', 'superseded'],
  };

export interface WebSourceRecordLike {
  readonly source_id: string;
  readonly basis: string;
  readonly fetched_at: string;
  readonly excerpt: string | null;
  readonly summary: string | null;
  readonly url: string | null;
}

// 永続保存してよい出典か。URL は WebUsagePolicy.url_storage が allowed のときだけ持てる（未決・不許可では持たない）。
// 検索結果の要約だけのものは、永続の出典にならない（basis は page_read だけ）。
export function webSourceRecordErrors(
  source: WebSourceRecordLike,
  policy: Pick<WebUsagePolicyLike, 'url_storage'>,
): string[] {
  const errors: string[] = [];
  if (source.basis !== 'page_read') errors.push('basis_not_page_read');
  if (source.excerpt === null && source.summary === null)
    errors.push('missing_page_evidence');
  if (source.url !== null && policy.url_storage !== 'allowed')
    errors.push('url_not_storable');
  return errors;
}

export interface WebResearchStatusLike {
  readonly workflow_id: string;
  readonly request_revision: string;
  readonly state_revision: string;
  readonly state: string;
  readonly accepted_at: string;
  readonly updated_at: string;
  readonly finished_at: string | null;
  readonly result: {
    readonly summary: string;
    readonly sources: readonly WebSourceRecordLike[];
    readonly unread_count: number;
    readonly scope_reduced: boolean;
  } | null;
  readonly stop: { readonly kind: string; readonly reason: string } | null;
  readonly transient_links: {
    readonly retention: string;
    readonly items: readonly { readonly source_id: string }[];
  } | null;
}

// a が b より後の時刻か。
function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

// 状態と、その状態が持てる項目の組み合わせ。完了だけが結果を持ち、失敗・0 件・保留・取消は結果を持てない。
export function webResearchStatusErrors(
  status: WebResearchStatusLike,
  policy: Pick<WebUsagePolicyLike, 'url_storage'>,
): string[] {
  const errors: string[] = [];
  const state = status.state;
  if (!WEB_RESEARCH_STATES.includes(state as WebResearchState)) {
    errors.push('state_unknown');
    return errors;
  }
  if (isAfter(status.accepted_at, status.updated_at))
    errors.push('updated_before_accepted');
  const finishes = state !== 'held' && TERMINAL.has(state as WebResearchState);
  if (finishes && status.finished_at === null)
    errors.push('finished_at_missing');
  if (!finishes && status.finished_at !== null)
    errors.push('finished_at_unexpected');
  if (
    status.finished_at !== null &&
    isAfter(status.accepted_at, status.finished_at)
  )
    errors.push('finished_before_accepted');

  if (state === 'completed') {
    if (status.stop !== null) errors.push('completed_with_stop');
    if (status.result === null) {
      errors.push('completed_without_result');
    } else {
      const { result } = status;
      if (result.sources.length === 0) errors.push('completed_without_source');
      if (result.summary.trim().length === 0)
        errors.push('completed_without_summary');
      // 読んだページと読めなかったページの合計は、1 依頼のページ数の上限を超えない。
      if (result.sources.length + result.unread_count > WEB_RESEARCH_MAX_PAGES)
        errors.push('page_limit');
      for (const source of result.sources)
        for (const error of webSourceRecordErrors(source, policy))
          errors.push(`source_${error}`);
      const ids = result.sources.map((source) => source.source_id);
      if (new Set(ids).size !== ids.length) errors.push('source_id_duplicate');
      if (status.transient_links !== null) {
        if (status.transient_links.retention !== 'transient_only')
          errors.push('transient_links_retention');
        for (const item of status.transient_links.items)
          if (!ids.includes(item.source_id))
            errors.push('transient_link_unknown_source');
      }
    }
  } else {
    // 完了以外は結果と出典のリンクを持てない（失敗を完了のように見せない）。
    if (status.result !== null) errors.push('result_without_completion');
    if (status.transient_links !== null)
      errors.push('transient_links_without_completion');
    if (TERMINAL.has(state as WebResearchState) || state === 'held') {
      if (status.stop === null) errors.push('stop_missing');
      else {
        if (status.stop.kind !== state) errors.push('stop_kind_mismatch');
        const allowed = STOP_REASONS[status.stop.kind] ?? [];
        if (!allowed.includes(status.stop.reason as WebResearchStopReason))
          errors.push('stop_reason_mismatch');
      }
    } else if (status.stop !== null) errors.push('stop_in_progress');
  }
  return errors;
}

// 1 つ前の応答から次の応答への移り方。状態の版は 1 ずつ進み、終端からは動かない。
export function webResearchTransitionErrors(
  previous: WebResearchStatusLike,
  next: WebResearchStatusLike,
): string[] {
  const errors: string[] = [];
  if (
    previous.workflow_id !== next.workflow_id ||
    previous.request_revision !== next.request_revision
  )
    errors.push('other_request');
  if (
    !/^(0|[1-9][0-9]*)$/u.test(previous.state_revision) ||
    !/^(0|[1-9][0-9]*)$/u.test(next.state_revision)
  )
    errors.push('state_revision_invalid');
  else if (BigInt(next.state_revision) !== BigInt(previous.state_revision) + 1n)
    errors.push('state_revision_not_next');
  if (previous.accepted_at !== next.accepted_at)
    errors.push('accepted_at_changed');
  const from = previous.state as WebResearchState;
  const to = next.state as WebResearchState;
  if (!WEB_RESEARCH_STATES.includes(from) || !WEB_RESEARCH_STATES.includes(to))
    errors.push('state_unknown');
  else if (!NEXT[from].includes(to)) errors.push('transition_not_allowed');
  return errors;
}

export type WebResearchDisplayLabel =
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'no_results'
  | 'held'
  | 'failed'
  | 'canceled'
  | 'unconfirmed';

// 画面で「完了」と出してよいか。完了の状態でも、項目の整合が取れないものは完了と出さない（unconfirmed）。
// ほかの状態は、どれも completed にならない。
export function webResearchDisplayLabel(
  status: WebResearchStatusLike,
  policy: Pick<WebUsagePolicyLike, 'url_storage'>,
): WebResearchDisplayLabel {
  if (webResearchStatusErrors(status, policy).length > 0) return 'unconfirmed';
  switch (status.state as WebResearchState) {
    case 'accepted':
      return 'accepted';
    case 'searching':
    case 'reading':
    case 'summarizing':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'no_results':
      return 'no_results';
    case 'held':
      return 'held';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
  }
}

export interface WebResearchNotificationParts {
  readonly kind: 'research_done';
  readonly workflow_id: string;
  readonly completion_version: string;
}

// 完了の気づき（候補の種類 research_done）の識別子の材料。完了のときだけ作り、失敗・0 件・保留・取消では作らない。
// 材料は ADR 0073 の「kind・workflow_id・完了の版」で、完了の版は完了した応答の state_revision（U291）。
export function webResearchNotificationParts(
  status: WebResearchStatusLike,
  policy: Pick<WebUsagePolicyLike, 'url_storage'>,
): WebResearchNotificationParts | null {
  if (webResearchDisplayLabel(status, policy) !== 'completed') return null;
  return {
    kind: 'research_done',
    workflow_id: status.workflow_id,
    completion_version: status.state_revision,
  };
}
