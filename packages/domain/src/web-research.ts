// 公開 Web 調査の上限と利用条件（B12-01、ADR 0077、設計 05）。
// 検索結果は操作中の一時保持だけにし、モデルの訓練・評価に使わない（Brave 利用条件 3(b)(i)・(xiii)）。
// 実 API の呼出し・取得・保存はここでは行わない。

export const WEB_SEARCH_PROVIDER = 'brave';

export const WEB_SEARCH_MAX_SEARCHES = 3;
export const WEB_RESEARCH_MAX_PAGES = 5;
export const WEB_FETCH_MAX_BYTES = 2_000_000;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_REDIRECTS = 3;

// ---- 取得先の判定（B12-04 が接続ごと・各リダイレクトの後に使う） --------------------------------

function ipv4Private(parts: readonly number[]): boolean {
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return true;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  const c = parts[2] ?? -1;
  // 0/8・10/8・127/8・100.64/10（CGNAT・Tailscale）・169.254/16・172.16/12・192.168/16。
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 192.0.0/24・192.0.2/24・198.18/15・198.51.100/24・203.0.113/24 と、224/4・240/4。
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

// 10 進・8 進（先頭 0）・16 進（0x）の部品を数にする。読めなければ null。
function ipv4Part(value: string): number | null {
  if (/^0x[0-9a-f]*$/iu.test(value)) {
    const digits = value.slice(2);
    return digits.length === 0 ? 0 : Number.parseInt(digits, 16);
  }
  if (/^0[0-7]+$/u.test(value)) return Number.parseInt(value.slice(1), 8);
  if (/^\d+$/u.test(value)) return Number.parseInt(value, 10);
  return null;
}

// inet_aton と同じく、1〜4 個の部品を 32 ビットの IPv4 にする。
// 127.1・2130706433・0x7f000001 のような別表記も同じアドレスとして扱う。
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const values = parts.map(ipv4Part);
  if (values.some((value) => value === null || value < 0)) return null;
  const numbers = values as number[];
  let value: number;
  if (numbers.length === 4) {
    if (numbers.some((part) => part > 255)) return null;
    value =
      ((numbers[0] ?? 0) * 0x1000000 +
        (numbers[1] ?? 0) * 0x10000 +
        (numbers[2] ?? 0) * 0x100 +
        (numbers[3] ?? 0)) >>>
      0;
  } else if (numbers.length === 3) {
    if ((numbers[0] ?? 0) > 255 || (numbers[1] ?? 0) > 255) return null;
    if ((numbers[2] ?? 0) > 0xffff) return null;
    value =
      ((numbers[0] ?? 0) * 0x1000000 +
        (numbers[1] ?? 0) * 0x10000 +
        (numbers[2] ?? 0)) >>>
      0;
  } else if (numbers.length === 2) {
    if ((numbers[0] ?? 0) > 255) return null;
    if ((numbers[1] ?? 0) > 0xffffff) return null;
    value = ((numbers[0] ?? 0) * 0x1000000 + (numbers[1] ?? 0)) >>> 0;
  } else {
    if ((numbers[0] ?? 0) > 0xffffffff) return null;
    value = (numbers[0] ?? 0) >>> 0;
  }
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

// IPv6 を 8 個の 16 ビットに展開する。:: の省略と IPv4 末尾に対応する。
function parseIpv6(host: string): number[] | null {
  let text = host.toLowerCase();
  const embedded = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);
  if (embedded) {
    const octets = (embedded[1] ?? '').split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => part > 255)) return null;
    const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    text = `${text.slice(0, text.length - (embedded[1] ?? '').length)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toHextets = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const values = part.split(':');
    if (values.length > 8) return null;
    const parsed = values.map((value) =>
      /^[0-9a-f]{1,4}$/u.test(value) ? Number.parseInt(value, 16) : null,
    );
    return parsed.some((value) => value === null) ? null : (parsed as number[]);
  };
  const left = toHextets(halves[0] ?? '');
  const right = halves.length === 2 ? toHextets(halves[1] ?? '') : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function ipv6Private(host: string): boolean {
  const parts = parseIpv6(host);
  if (!parts) return true;
  const [first, second] = [parts[0] ?? 0, parts[1] ?? 0];
  // ::（未指定）・::1（ループバック）・IPv4 mapped/compatible。
  const zeroPrefix = parts.slice(0, 5).every((part) => part === 0);
  if (zeroPrefix && parts[5] === 0) {
    if (parts[6] === 0 && parts[7] === 0) return true;
    if (parts[6] === 0 && parts[7] === 1) return true;
  }
  if (zeroPrefix && parts[5] === 0xffff)
    return ipv4Private([
      (parts[6] ?? 0) >> 8,
      (parts[6] ?? 0) & 255,
      (parts[7] ?? 0) >> 8,
      (parts[7] ?? 0) & 255,
    ]);
  // fc00::/7（ULA）・fe80::/10（リンクローカル）・fec0::/10（サイトローカル）・ff00::/8（マルチキャスト）。
  if (
    (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xfe80 && first <= 0xfeff) ||
    (first >= 0xff00 && first <= 0xffff)
  )
    return true;
  // 2001:db8::/32（文書用）。
  return first === 0x2001 && second === 0xdb8;
}

// 取得先がローカル・プライベート・リンクローカルでないか。拒否する理由を返し、よければ null。
// リテラルの IP だけを見る。名前解決の結果とリダイレクト先は B12-04 が接続ごとに確かめる。
export function privateWebTargetReason(value: string): string | null {
  const match = /^https:\/\/([^/?#]+)/iu.exec(value);
  if (!match) return 'invalid_url';
  const authority = match[1] ?? '';
  // バックスラッシュ・認証情報（@）・百分率符号・空白・非 ASCII は、URL の解釈と
  // 自前の切り出しが食い違うため拒否する（安全側）。全角数字や percent-encoded の
  // ループバックを公開先と誤認しない。
  if (/[\\%@\s]/u.test(authority) || !/^[\x21-\x7e]+$/u.test(authority))
    return 'private_target';
  let host: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return 'invalid_url';
    host = authority.slice(0, end + 1).toLowerCase();
  } else {
    host = (authority.split(':')[0] ?? '').toLowerCase();
  }
  host = host.replace(/\.$/u, '');
  if (host.length === 0) return 'invalid_url';
  if (host === 'localhost' || host.endsWith('.localhost'))
    return 'private_target';
  if (host.startsWith('[') && host.endsWith(']')) {
    const address = host.slice(1, -1);
    if (address.includes(':'))
      return ipv6Private(address) ? 'private_target' : null;
  }
  if (host.endsWith('.local') || host.endsWith('.internal'))
    return 'private_target';
  if (host.includes(':')) return ipv6Private(host) ? 'private_target' : null;
  // 数字だけに見えるホストは inet_aton の別表記として IPv4 に直す。読めなければ拒否する。
  if (!/^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+))*$/iu.test(host))
    return null;
  const ipv4 = parseIpv4(host);
  if (!ipv4) return 'private_target';
  return ipv4Private(ipv4) ? 'private_target' : null;
}

// ---- 上限と利用条件 ------------------------------------------------------------------------------

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
  if (!Number.isSafeInteger(usage.bytes) || usage.bytes < 0)
    errors.push('bytes_invalid');
  else if (usage.bytes > WEB_FETCH_MAX_BYTES) errors.push('bytes_limit');
  if (!Number.isSafeInteger(usage.timeout_ms) || usage.timeout_ms < 0)
    errors.push('timeout_invalid');
  else if (usage.timeout_ms > WEB_FETCH_TIMEOUT_MS)
    errors.push('timeout_limit');
  if (!Number.isSafeInteger(usage.redirects) || usage.redirects < 0)
    errors.push('redirects_invalid');
  else if (usage.redirects > WEB_FETCH_MAX_REDIRECTS)
    errors.push('redirect_limit');
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
