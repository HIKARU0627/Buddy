// 公開 Web 調査の上限の数え方と、失敗・0 件・完了の最終状態の決め方（B12-02 P2、ADR 0128・0129）。
// 1 依頼あたり 3 検索・5 ページ・2MB・15 秒・3 リダイレクト（設計 05。初期値）。品質の保証ではなく処理と費用の上限で、
// 超える要求は拒否し、範囲を減らして完了にするか保留にする。失敗と 0 件と読めない形式を同じものにしない。
// 実 API の呼出し・取得はここでは行わない（B12-03・B12-04）。

import {
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TIMEOUT_MS,
  WEB_RESEARCH_MAX_PAGES,
  WEB_SEARCH_MAX_SEARCHES,
  webFetchUsageErrors,
  webResearchUsageErrors,
  type WebResearchUsage,
  type WebUsagePolicyLike,
} from './web-research.js';
import {
  webResearchDisplayLabel,
  webResearchStatusErrors,
  type WebResearchDisplayLabel,
  type WebResearchStatusLike,
} from './web-research-status.js';

export interface WebSearchAttemptLike {
  readonly search_index: number;
  readonly query_id: string;
  readonly outcome: string;
  readonly hit_count: number;
  readonly failure_cause: string | null;
}

export interface WebPageAttemptLike {
  readonly page_index: number;
  readonly query_id: string;
  readonly outcome: string;
  readonly source_id: string | null;
  readonly http_status: number | null;
  readonly redirects: number;
  readonly bytes: number;
  readonly elapsed_ms: number;
}

export interface WebResearchAttemptsLike {
  readonly workflow_id: string;
  readonly request_revision: string;
  readonly searches: readonly WebSearchAttemptLike[];
  readonly search_denials: readonly string[];
  readonly pages: readonly WebPageAttemptLike[];
  readonly page_limit_denials: number;
  readonly summary: string;
}

// 数えるのは「試行」: 送った検索（失敗も含む）と、取得を試みたページ（読めない・拒否・失敗も含む）。
// 断った（送らなかった）検索は数えない。取得の費用は無いが、時間と接続先への負荷の上限として、失敗した取得も数える（U295）。
export function webResearchUsageOf(
  attempts: Pick<WebResearchAttemptsLike, 'searches' | 'pages'>,
): WebResearchUsage {
  return {
    searches: attempts.searches.length,
    pages: attempts.pages.length,
  };
}

// 次の検索を送ってよいか。3 回送ったら、4 回目は拒否する（範囲を減らすか保留する）。
export function webSearchAdmissionLimitErrors(
  attempts: Pick<WebResearchAttemptsLike, 'searches'>,
): string[] {
  return attempts.searches.length >= WEB_SEARCH_MAX_SEARCHES
    ? ['search_limit']
    : [];
}

// 次のページを取得してよいか。5 ページ試みたら、6 ページ目は拒否する。検索で見つかった件数より多くは取らない。
export function webPageAdmissionLimitErrors(
  attempts: Pick<WebResearchAttemptsLike, 'searches' | 'pages'>,
): string[] {
  const errors: string[] = [];
  if (attempts.pages.length >= WEB_RESEARCH_MAX_PAGES)
    errors.push('page_limit');
  if (attempts.pages.length >= hitTotal(attempts.searches))
    errors.push('no_more_hits');
  return errors;
}

function hitTotal(searches: readonly WebSearchAttemptLike[]): number {
  return searches
    .filter((search) => search.outcome === 'hits')
    .reduce((sum, search) => sum + search.hit_count, 0);
}

// 検索 1 回の記録の整合。hits は 1 件以上、zero_hits は 0 件、failed は原因を持つ（失敗と 0 件を同じにしない）。
export function webSearchAttemptErrors(
  attempt: WebSearchAttemptLike,
): string[] {
  const errors: string[] = [];
  if (attempt.outcome === 'hits') {
    if (attempt.hit_count < 1) errors.push('hits_without_hit');
    if (attempt.failure_cause !== null) errors.push('hits_with_failure_cause');
  } else if (attempt.outcome === 'zero_hits') {
    if (attempt.hit_count !== 0) errors.push('zero_hits_with_hit');
    if (attempt.failure_cause !== null)
      errors.push('zero_hits_with_failure_cause');
  } else if (attempt.outcome === 'failed') {
    if (attempt.hit_count !== 0) errors.push('failed_with_hit');
    if (attempt.failure_cause === null) errors.push('failed_without_cause');
  } else errors.push('outcome_unknown');
  return errors;
}

// ページ 1 件の取得の記録の整合。根拠になるのは read だけで、read は出典の ID を持ち、ほかは持たない。
export function webPageAttemptErrors(attempt: WebPageAttemptLike): string[] {
  const errors: string[] = [];
  const status = attempt.http_status;
  const succeeded = status !== null && status >= 200 && status <= 299;
  for (const error of webFetchUsageErrors({
    bytes: attempt.bytes,
    timeout_ms: attempt.elapsed_ms,
    redirects: attempt.redirects,
  }))
    errors.push(`fetch_${error}`);
  if (attempt.outcome === 'read') {
    if (attempt.source_id === null) errors.push('read_without_source');
    if (!succeeded) errors.push('read_without_success_status');
    return errors;
  }
  if (attempt.source_id !== null) errors.push('source_without_read');
  switch (attempt.outcome) {
    case 'unreadable_format':
    case 'empty_text':
      if (!succeeded) errors.push('response_status_missing');
      break;
    case 'login_required':
      if (status === null) errors.push('response_status_missing');
      break;
    case 'blocked_target':
      // 接続の前に拒否したので、本文は読んでいない。
      if (attempt.bytes !== 0) errors.push('blocked_with_bytes');
      break;
    case 'too_large':
      if (attempt.bytes !== WEB_FETCH_MAX_BYTES)
        errors.push('too_large_below_cap');
      break;
    case 'timeout':
      if (attempt.elapsed_ms !== WEB_FETCH_TIMEOUT_MS)
        errors.push('timeout_below_cap');
      break;
    case 'redirect_limit':
      if (attempt.redirects !== WEB_FETCH_MAX_REDIRECTS)
        errors.push('redirect_limit_below_cap');
      break;
    case 'redirect_loop':
      if (attempt.redirects < 1) errors.push('redirect_loop_without_redirect');
      break;
    case 'http_error':
      if (status === null || status < 400) errors.push('http_error_status');
      break;
    case 'network_error':
      if (status !== null) errors.push('network_error_with_status');
      break;
    default:
      errors.push('outcome_unknown');
  }
  return errors;
}

// 1 依頼の試行の記録全体の整合。上限・順序・取得した件数と検索の件数の関係・要約の前提を確かめる。
export function webResearchAttemptsErrors(
  attempts: WebResearchAttemptsLike,
): string[] {
  const errors: string[] = [];
  errors.push(...webResearchUsageErrors(webResearchUsageOf(attempts)));
  attempts.searches.forEach((search, index) => {
    if (search.search_index !== index + 1) errors.push('search_index_order');
    for (const error of webSearchAttemptErrors(search))
      errors.push(`search_${error}`);
  });
  attempts.pages.forEach((page, index) => {
    if (page.page_index !== index + 1) errors.push('page_index_order');
    for (const error of webPageAttemptErrors(page))
      errors.push(`page_${error}`);
  });
  const hitQueryIds = new Set(
    attempts.searches
      .filter((search) => search.outcome === 'hits')
      .map((search) => search.query_id),
  );
  if (attempts.pages.length > hitTotal(attempts.searches))
    errors.push('pages_exceed_hits');
  if (attempts.pages.some((page) => !hitQueryIds.has(page.query_id)))
    errors.push('page_query_unknown');
  const sourceIds = attempts.pages
    .filter((page) => page.source_id !== null)
    .map((page) => page.source_id);
  if (new Set(sourceIds).size !== sourceIds.length)
    errors.push('source_id_duplicate');
  // 断りの記録は、本当にそうなったときだけ持つ。
  if (
    attempts.search_denials.includes('search_limit') &&
    attempts.searches.length < WEB_SEARCH_MAX_SEARCHES
  )
    errors.push('search_limit_denial_early');
  if (
    attempts.page_limit_denials > 0 &&
    attempts.pages.length < WEB_RESEARCH_MAX_PAGES
  )
    errors.push('page_limit_denial_early');
  if (
    attempts.summary !== 'not_attempted' &&
    !attempts.pages.some((page) => page.outcome === 'read')
  )
    errors.push('summary_without_page');
  return errors;
}

export interface WebResearchFinal {
  readonly state: 'completed' | 'no_results' | 'held' | 'failed';
  readonly stop: { readonly kind: string; readonly reason: string } | null;
  readonly unread_count: number;
  readonly scope_reduced: boolean;
}

function stopped(
  state: 'no_results' | 'held' | 'failed',
  reason: string,
): WebResearchFinal {
  return {
    state,
    stop: { kind: state, reason },
    unread_count: 0,
    scope_reduced: false,
  };
}

// これ以上試せない（上限に達した・取得する件が尽きた・要約まで済んだ）ときの最終状態。まだ続けられる間は
// 呼び出し側（B12-05）が呼ばない。結論が出せない（試行がまだ足りない）ときは null。
// 表（ADR 0129。手で書いた期待値は fixture）:
// - 検索が 1 つも成功せず: 検索語の拒否だけ → 保留（query_rejected）／予算の拒否 → 保留（budget_held）／失敗 → 失敗（search_failed）。
// - 検索が成功: 件数 0 でも、別の検索が失敗していれば 0 件と言い切れず失敗（search_failed）。追加の検索を予算で断っていれば保留（budget_held）。
//   全部成功し、断りも無く 0 件 → no_results。
// - 件数あり: 読めたページが無ければ、予算で検索を断ったとき保留、それ以外は失敗（no_readable_page）。検索の件数があるだけで完了にしない。
// - 読めたページあり: 要約が ok のときだけ完了（unread_count・scope_reduced を付ける）。予算で断れば保留、失敗は失敗（summary_failed）。
export function webResearchFinalState(
  attempts: WebResearchAttemptsLike,
): WebResearchFinal | null {
  const succeeded = attempts.searches.filter(
    (search) => search.outcome !== 'failed',
  );
  const failed = attempts.searches.filter(
    (search) => search.outcome === 'failed',
  );
  // 予算で断った記録は、まだ検索を送れる（検索の枠が残っている）間だけ保留の理由になる。再開して枠を使い切った後は、
  // 古い断りで保留を続けず、結果（失敗・0 件・読めない）で終える。
  const budgetDenied =
    attempts.search_denials.includes('budget_denied') &&
    attempts.searches.length < WEB_SEARCH_MAX_SEARCHES;
  if (succeeded.length === 0) {
    if (
      attempts.search_denials.includes('query_rejected') &&
      failed.length === 0
    )
      return stopped('held', 'query_rejected');
    if (budgetDenied) return stopped('held', 'budget_held');
    if (failed.length > 0) return stopped('failed', 'search_failed');
    return null;
  }
  const hits = hitTotal(attempts.searches);
  if (hits === 0) {
    if (failed.length > 0) return stopped('failed', 'search_failed');
    // 追加の検索を予算で断られたまま、0 件と確定しない（取りこぼしの可能性があるので保留）。
    if (budgetDenied) return stopped('held', 'budget_held');
    return stopped('no_results', 'zero_hits');
  }
  if (attempts.pages.length === 0) return null;
  const reads = attempts.pages.filter((page) => page.outcome === 'read').length;
  if (reads === 0)
    return budgetDenied
      ? stopped('held', 'budget_held')
      : stopped('failed', 'no_readable_page');
  switch (attempts.summary) {
    case 'ok':
      return {
        state: 'completed',
        stop: null,
        unread_count: attempts.pages.length - reads,
        scope_reduced:
          failed.length > 0 ||
          attempts.search_denials.length > 0 ||
          attempts.page_limit_denials > 0 ||
          (attempts.pages.length >= WEB_RESEARCH_MAX_PAGES &&
            hits > attempts.pages.length),
      };
    case 'budget_denied':
      return stopped('held', 'budget_held');
    case 'failed':
      return stopped('failed', 'summary_failed');
    default:
      return null;
  }
}

// 応答（status）が、試行の記録から決まる最終状態と合っているか。完了・0 件・失敗・保留の応答は、
// 記録が示す状態と同じでなければならない（読めたページが無いのに完了、検索の失敗を 0 件、など）。取消は記録に依らない。
export function webResearchOutcomeErrors(
  status: WebResearchStatusLike,
  attempts: WebResearchAttemptsLike,
): string[] {
  const errors: string[] = [];
  // 別の依頼の記録で確認済みにしない。
  if (status.workflow_id !== attempts.workflow_id)
    errors.push('workflow_id_mismatch');
  if (status.request_revision !== attempts.request_revision)
    errors.push('request_revision_mismatch');
  if (errors.length > 0) return errors;
  if (
    status.state !== 'completed' &&
    status.state !== 'no_results' &&
    status.state !== 'failed' &&
    status.state !== 'held'
  )
    return errors;
  const final = webResearchFinalState(attempts);
  if (final === null) return ['attempts_unfinished'];
  if (final.state !== status.state) errors.push('state_mismatch');
  else if (status.stop?.reason !== final.stop?.reason)
    errors.push('stop_reason_mismatch_attempts');
  if (
    status.state === 'completed' &&
    final.state === 'completed' &&
    status.result !== null
  ) {
    const readIds = attempts.pages
      .filter((page) => page.outcome === 'read')
      .map((page) => page.source_id);
    const ids = status.result.sources.map((source) => source.source_id);
    if (
      ids.length !== readIds.length ||
      ids.some((id) => !readIds.includes(id))
    )
      errors.push('sources_mismatch_attempts');
    if (status.result.unread_count !== final.unread_count)
      errors.push('unread_count_mismatch');
    if (status.result.scope_reduced !== final.scope_reduced)
      errors.push('scope_reduced_mismatch');
  }
  return errors;
}

// 画面で「完了」などと出してよいか。応答の整合と、試行の記録との一致の両方が取れたときだけ状態どおりに出し、
// 取れないものは unconfirmed にする（失敗を完了と表示しない）。
export function webResearchConfirmedLabel(
  status: WebResearchStatusLike,
  attempts: WebResearchAttemptsLike,
  policy: Pick<WebUsagePolicyLike, 'url_storage'>,
): WebResearchDisplayLabel {
  if (webResearchStatusErrors(status, policy).length > 0) return 'unconfirmed';
  if (webResearchAttemptsErrors(attempts).length > 0) return 'unconfirmed';
  if (webResearchOutcomeErrors(status, attempts).length > 0)
    return 'unconfirmed';
  return webResearchDisplayLabel(status, policy);
}
