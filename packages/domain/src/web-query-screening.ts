// 公開 Web 検索の検索語の検査（B12-02、ADR 0127、設計 05「公開Web調査」）。
// 設計 05: 検索語は本人の質問から必要な一般語を作り、メール全文・API キー・個人の詳細予定を含めない。
// ここは機械検査の「下限」で、氏名・予定の詳細・社名などの私的情報は見分けられない。見分けられない分は、
// 検索語の入力元を本人の質問に限る前提（input_sources）と、検査を通った記録がなければ検索を受け付けない規則で守る。
// 検査は Brave の入力上限（600 文字・75 語。比較表 §3.4）の内側に置き、誤って拒否した検索語は本人に聞き直す。

export const WEB_QUERY_SCREENING_VERSION = 1;
export const WEB_QUERY_MAX_CODE_POINTS = 512;
export const WEB_QUERY_MAX_WORDS = 75;

export type WebQueryRejectReason =
  | 'empty'
  | 'too_long'
  | 'too_many_words'
  | 'line_break'
  | 'email_address'
  | 'phone_number'
  | 'secret_like_token'
  | 'contains_url';

const SECRET_PATTERNS: readonly RegExp[] = [
  // API キー・トークンの代表的な形（検出値は報告・ログに出さない）。
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  // 空白のない 32 文字以上の英数字の連なりは、鍵・ハッシュ・ID とみなす。
  /[A-Za-z0-9+/_=-]{32,}/u,
];

// 検索語に含まれる私的情報・秘密のように見える形を、見つけた理由の一覧で返す（空なら検査を通る）。
// 全角の英数字・記号は NFKC で半角に直してから見る（全角の ＠ や数字で検査を避けられないようにする）。
export function webQueryRejectReasons(query: string): WebQueryRejectReason[] {
  const reasons: WebQueryRejectReason[] = [];
  const normalized = query.normalize('NFKC');
  if (normalized.trim().length === 0) return ['empty'];
  if ([...query].length > WEB_QUERY_MAX_CODE_POINTS) reasons.push('too_long');
  if (normalized.trim().split(/\s+/u).length > WEB_QUERY_MAX_WORDS)
    reasons.push('too_many_words');
  // メール本文や予定の貼り付けは複数行になる。検索語は 1 行だけにする。
  if (/[\p{Zl}\p{Zp}\r\n]/u.test(normalized)) reasons.push('line_break');
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/u.test(normalized))
    reasons.push('email_address');
  // 電話番号らしい数字の連なり（区切りを除いて 10 桁以上）。日付など短い数字は通す。
  for (const run of normalized.match(/\+?\d[\d\-().\s]{7,}\d/gu) ?? []) {
    if (run.replace(/\D/gu, '').length >= 10) {
      reasons.push('phone_number');
      break;
    }
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized)))
    reasons.push('secret_like_token');
  // 検索語に URL を入れない。共有リンクや認証つきの URL は私的情報になりうる。
  if (/\bhttps?:\/\//iu.test(normalized)) reasons.push('contains_url');
  return reasons;
}

export interface WebQueryScreeningLike {
  readonly query_id: string;
  readonly screened_query: string | null;
  readonly input_sources: readonly string[];
  readonly rules_version: number;
  readonly outcome: string;
  readonly rejected_reasons: readonly string[];
}

// 検査の記録そのものの整合。passed は拒否の理由が無く検索語を持ち、rejected は理由があり検索語を持たない
// （拒否した検索語を保存しない）。入力の元は本人の質問だけ。
export function webQueryScreeningErrors(
  screening: WebQueryScreeningLike,
): string[] {
  const errors: string[] = [];
  if (screening.outcome === 'passed') {
    if (screening.rejected_reasons.length > 0)
      errors.push('passed_with_reasons');
    if (screening.screened_query === null) errors.push('passed_without_query');
  } else if (screening.outcome === 'rejected') {
    if (screening.rejected_reasons.length === 0)
      errors.push('rejected_without_reasons');
    if (screening.screened_query !== null) errors.push('rejected_query_stored');
  } else errors.push('outcome_unknown');
  if (
    screening.input_sources.length !== 1 ||
    screening.input_sources[0] !== 'user_question'
  )
    errors.push('input_source');
  if (screening.rules_version !== WEB_QUERY_SCREENING_VERSION)
    errors.push('rules_version');
  return errors;
}

export interface WebSearchRequestLike {
  readonly query_id: string;
  readonly query: string;
}

// 検索を受け付けてよいか。検査を通った記録が無い・別の検索語・整合しない記録・古い規則の版なら拒否する（B12-03 が毎回の呼出しの前に使う）。
// 記録を信用せず、検索語そのものも検査し直す（記録の改ざん・取り違えで私的情報を送らない）。
export function webSearchAdmissionErrors(
  request: WebSearchRequestLike,
  screening: WebQueryScreeningLike | null,
): string[] {
  const errors: string[] = [];
  if (screening === null) errors.push('screening_missing');
  else {
    if (screening.query_id !== request.query_id)
      errors.push('screening_query_id_mismatch');
    if (screening.outcome !== 'passed') errors.push('screening_not_passed');
    if (screening.screened_query !== request.query)
      errors.push('screening_query_mismatch');
    // 記録そのものの整合（拒否理由を持つ passed・検索語の無い passed・入力元・規則の版）も、受付の拒否に反映する。
    for (const error of webQueryScreeningErrors(screening))
      errors.push(`screening_${error}`);
  }
  for (const reason of webQueryRejectReasons(request.query))
    errors.push(`query_${reason}`);
  return errors;
}
