// 公開 Web 調査の上限と利用条件（B12-01、ADR 0077、設計 05）。
// 検索結果は操作中の一時保持だけにし、モデルの訓練・評価に使わない（Brave 利用条件 3(b)(i)・(xiii)）。
// 実 API の呼出し・取得・保存はここでは行わない。

export const WEB_SEARCH_PROVIDER = 'brave';

export const WEB_SEARCH_MAX_SEARCHES = 3;
export const WEB_RESEARCH_MAX_PAGES = 5;
export const WEB_FETCH_MAX_BYTES = 2_000_000;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_REDIRECTS = 3;

export interface WebResearchUsage {
  readonly searches: number;
  readonly pages: number;
}

// 1 依頼あたりの検索回数と参照ページ数。超えたら範囲を減らすか保留する。
export function webResearchUsageErrors(usage: WebResearchUsage): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(usage.searches) || usage.searches < 0)
    errors.push('search_count_invalid');
  else if (usage.searches > WEB_SEARCH_MAX_SEARCHES)
    errors.push('search_limit');
  if (!Number.isSafeInteger(usage.pages) || usage.pages < 0)
    errors.push('page_count_invalid');
  else if (usage.pages > WEB_RESEARCH_MAX_PAGES) errors.push('page_limit');
  return errors;
}

export interface WebFetchUsage {
  readonly bytes: number;
  readonly timeout_ms: number;
  readonly redirects: number;
}

// 1 ページの取得の上限。読めない・大きすぎる・遅すぎる取得は根拠にしない。
export function webFetchUsageErrors(usage: WebFetchUsage): string[] {
  const errors: string[] = [];
  if (usage.bytes > WEB_FETCH_MAX_BYTES) errors.push('bytes_limit');
  if (usage.timeout_ms > WEB_FETCH_TIMEOUT_MS) errors.push('timeout_limit');
  if (usage.redirects > WEB_FETCH_MAX_REDIRECTS) errors.push('redirect_limit');
  return errors;
}

export interface WebResearchSourceLike {
  readonly basis: 'page_read' | 'search_summary_only';
  readonly fetched_at: string | null;
  readonly excerpt: string | null;
  readonly summary: string | null;
}

// 出典の抜粋・要約は、自分で取得した本文から作る。検索結果の要約だけのものは、
// 抜粋・要約を永続保存しない（ADR 0077）。
export function webSourceErrors(source: WebResearchSourceLike): string[] {
  const errors: string[] = [];
  if (source.basis === 'page_read') {
    if (source.fetched_at === null) errors.push('missing_fetched_at');
    if (source.excerpt === null && source.summary === null)
      errors.push('missing_page_evidence');
  } else {
    if (source.fetched_at !== null) errors.push('summary_source_fetched');
    if (source.excerpt !== null) errors.push('summary_source_excerpt_stored');
    if (source.summary !== null) errors.push('summary_source_summary_stored');
  }
  return errors;
}

export interface WebUsagePolicyLike {
  readonly provider: string;
  readonly retention: string;
  readonly model_use: string;
  readonly url_storage: string;
}

// 検索サービスの利用条件。検索結果を保存せず、モデルの訓練・評価に使わない。
export function webUsagePolicyErrors(policy: WebUsagePolicyLike): string[] {
  const errors: string[] = [];
  if (policy.provider !== WEB_SEARCH_PROVIDER)
    errors.push('unsupported_provider');
  if (policy.retention !== 'transient_only')
    errors.push('persistent_retention');
  if (policy.model_use !== 'grounding_only') errors.push('model_training');
  if (!['undecided', 'allowed', 'disallowed'].includes(policy.url_storage))
    errors.push('url_storage_unknown');
  return errors;
}
