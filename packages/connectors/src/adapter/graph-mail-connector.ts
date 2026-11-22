// Microsoft Graph（Outlook）の読み取り connector（B09-02、ADR 0134）。
// 読み取りだけを持ち、状態を変える要求（カテゴリの付与・移動・送信）は作らない（ADR 0072: カテゴリは display_only）。
// - 委任トークンは取得関数の注入で受け取り、保持・記録しない。Authorization ヘッダーにだけ使う。
// - すべての要求（nextLink を含む）に Prefer: IdType="ImmutableId" を付ける（設計 04）。基本キーは immutable_id で、
//   所属フォルダーは別の関係（folder_id）として持つ。フォルダー移動を新しいメールとして扱わない（QA23）。
// - 差分取得（/delta・$deltatoken）は実装しない。初期はポーリング（設計 04）。
// - 拒否（403 など）は結果型の rejected で返し、成功扱いにしない。通信・応答の失敗はすべて結果型で返し、
//   例外を投げるのはプログラムの誤り（引数の不正・ページ数の上限）だけ。トークンの値・応答本文は結果にも例外にも載せない。
// domain（@buddy/domain）は import しない。語彙の値は domain の graph.ts と同じにし、一致は
// scripts/graph-mail-connector.test.mjs が照合する。
import type { MinimalConnectorCapability } from './capability.js';
import {
  defaultGraphTransport,
  type GraphHttpOutcome,
  type GraphTransport,
} from './graph-transport.js';

// domain の GRAPH_REJECTION_REASONS と同じ値（ADR 0072）。
export const GRAPH_REJECTION_REASONS = [
  'insufficient_permission',
  'organization_policy',
  'admin_consent_required',
  'tenant_restriction',
  'unknown',
] as const;
export type GraphRejectionReason = (typeof GRAPH_REJECTION_REASONS)[number];

// domain の GRAPH_ACCOUNT_KINDS と同じ値（ADR 0072）。
export const GRAPH_ACCOUNT_KINDS = ['personal', 'work_or_school'] as const;
export type GraphAccountKind = (typeof GRAPH_ACCOUNT_KINDS)[number];

// Microsoft の個人アカウント（Microsoft アカウント）用のテナント。
// 模擬の判定規則。実 API でこの値になることは B15 で検証する。
export const GRAPH_PERSONAL_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** 全ページ版の読み取りが辿るページ数の上限（安全のため。超えたらプログラムの誤りとして例外）。 */
export const GRAPH_MAX_PAGES = 1000;

/** 既定の Graph の入口。 */
export const GRAPH_DEFAULT_BASE_URL = 'https://graph.microsoft.com/v1.0';

// HTTP タイムアウトの初期値 15 秒（設計 04 再試行の初期値。domain の CONNECTOR_RETRY_POLICY.read_timeout_ms と同じ）。
const DEFAULT_TIMEOUT_MS = 15_000;
// 設計 11 §1 の Outlook の増分の $top。
const DEFAULT_PAGE_SIZE = 50;

// 要求する項目の最小集合（設計 04: 最小の select）。本文（body）は取らない。
const MESSAGE_SELECT =
  'id,receivedDateTime,lastModifiedDateTime,subject,from,categories,hasAttachments,isRead,parentFolderId,conversationId';
const FOLDER_SELECT =
  'id,displayName,parentFolderId,totalItemCount,unreadItemCount';
const ACCOUNT_SELECT = 'id,displayName,mail,userPrincipalName';
const CATEGORY_SELECT = 'id,displayName,color';

// フィルターに入れる日時（ISO 8601 の日時。式の注入を防ぐため、この形だけを受け付ける）。
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/u;

// Graph の読み取りの能力。カテゴリ一覧（masterCategories）の読み取りは CONNECTOR_READ_KINDS に種別が無いため
// 能力の reads に含めず、この connector 固有の読み取り（listCategories）として持つ（ADR 0134）。
// 書込みは無い（カテゴリの付与は If-Match の検証と B13 の承認の設計まで作らない。ADR 0072）。
export const GRAPH_CONNECTOR_CAPABILITY: MinimalConnectorCapability = {
  provider: 'microsoft',
  reads: [
    { kind: 'permission', effect_kind: 'Read' },
    { kind: 'mail.message', effect_kind: 'Read' },
  ],
  writes: [],
};

export type GraphReadResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** 拒否（権限不足・組織の方針・管理者の同意・テナントの制限・不明）。成功ではない。 */
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly reason: GraphRejectionReason;
      /** Graph の error.code（読めなければ 'unknown'）。message 全文は個人情報を含みうるので持たない。 */
      readonly code: string;
    }
  /** 委任トークンの期限切れ・失効（401）。再認証が要る。 */
  | {
      readonly kind: 'authentication_expired';
      readonly status: number;
      readonly code: string;
    }
  | {
      readonly kind: 'rate_limited';
      readonly status: 429;
      /** Retry-After（秒）をミリ秒にした値。無い・読めなければ null。 */
      readonly retry_after_ms: number | null;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'not_sent'
        | 'timeout'
        | 'connection_lost'
        | 'server_error'
        | 'invalid_response';
    };

export type GraphReadFailure = Exclude<
  GraphReadResult<never>,
  { readonly kind: 'ok' }
>;

export interface GraphAccount {
  readonly account_id: string;
  readonly display_name: string | null;
  readonly mail: string | null;
  readonly user_principal_name: string | null;
  /** 接続側が渡したテナントからの判定。判定できなければ null（断定しない）。 */
  readonly account_kind: GraphAccountKind | null;
}

export interface GraphMailFolder {
  readonly folder_id: string;
  readonly display_name: string;
  readonly parent_folder_id: string | null;
  readonly total_item_count: number | null;
  readonly unread_item_count: number | null;
}

export interface GraphMailMessage {
  /** 基本キー（ImmutableId）。所属フォルダーが変わっても変わらない前提の識別子。 */
  readonly immutable_id: string;
  /** 所属フォルダー（別の関係として持つ）。parentFolderId、無ければ要求したフォルダー。 */
  readonly folder_id: string | null;
  readonly received_at: string | null;
  readonly last_modified_at: string | null;
  readonly subject: string | null;
  readonly sender_name: string | null;
  readonly sender_address: string | null;
  readonly categories: readonly string[];
  readonly has_attachments: boolean;
  readonly is_read: boolean | null;
  readonly conversation_id: string | null;
}

export interface GraphMessagePage {
  readonly messages: readonly GraphMailMessage[];
  /** id の無い・空の項目の数。同一と断定できないので messages に入れない（QA23）。 */
  readonly skipped_without_id: number;
  /** 次のページの @odata.nextLink（完全な URL）。最終ページなら null。 */
  readonly next_cursor: string | null;
}

export interface GraphMessageList {
  readonly messages: readonly GraphMailMessage[];
  readonly skipped_without_id: number;
  readonly pages: number;
}

export interface GraphMasterCategory {
  readonly category_id: string;
  readonly display_name: string;
  readonly color: string | null;
}

export interface GraphMessageQuery {
  /** receivedDateTime ge の条件（ISO 8601 の日時）。 */
  readonly receivedSince?: string;
  /** lastModifiedDateTime ge の条件（増分。前回成功時刻の 5 分前を渡すのは呼び出し側。設計 11 §1）。 */
  readonly modifiedSince?: string;
  /** $top。既定 50。正の整数。 */
  readonly pageSize?: number;
  /** 前のページの next_cursor。あれば query を組み直さず、その URL をそのまま使う。 */
  readonly cursor?: string;
}

export interface GraphMailConnectorOptions {
  /** 委任トークンの取得関数。要求ごとに呼ぶ。connector は値を保持・記録しない。 */
  readonly accessToken: () => Promise<string>;
  readonly transport?: GraphTransport;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** アカウント種別の判定入力（接続時に接続側が渡す）。 */
  readonly tenantId?: string;
  /** 試験用: 中止されたら、時間切れとして扱う。 */
  readonly timeoutSignal?: AbortSignal;
  /** 試験用: 全ページ版の読み取りのページ数の上限（既定 GRAPH_MAX_PAGES）。 */
  readonly maxPages?: number;
}

export interface GraphMailConnector {
  readonly capability: MinimalConnectorCapability;
  readAccount(): Promise<GraphReadResult<GraphAccount>>;
  listMailFolders(): Promise<GraphReadResult<readonly GraphMailFolder[]>>;
  /** 1 ページだけ読む。 */
  listMessagesPage(
    folderId: string,
    query?: GraphMessageQuery,
  ): Promise<GraphReadResult<GraphMessagePage>>;
  /** next_cursor が無くなるまで辿る。途中のページの失敗はそのまま返す（取得完了にしない。設計 04）。 */
  listMessages(
    folderId: string,
    query?: Omit<GraphMessageQuery, 'cursor'>,
  ): Promise<GraphReadResult<GraphMessageList>>;
  /** connector 固有の読み取り（能力の reads に種別が無い）。表示用（display_only）。 */
  listCategories(): Promise<GraphReadResult<readonly GraphMasterCategory[]>>;
}

/** テナントからアカウント種別を判定する。未取得・空は null（断定しない）。模擬の判定規則（実 API は B15）。 */
export function graphAccountKindForTenant(
  tenantId: string | null | undefined,
): GraphAccountKind | null {
  if (typeof tenantId !== 'string') return null;
  const normalized = tenantId.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return normalized === GRAPH_PERSONAL_TENANT_ID
    ? 'personal'
    : 'work_or_school';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const countOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

// error・innerError（innererror）の文字列の値を集める（分類にだけ使い、結果には載せない）。
function errorTexts(error: Record<string, unknown>, depth = 0): string[] {
  const texts: string[] = [];
  for (const [key, value] of Object.entries(error)) {
    if (typeof value === 'string') texts.push(value);
    else if (depth < 3 && isRecord(value) && key.toLowerCase() === 'innererror')
      texts.push(...errorTexts(value, depth + 1));
  }
  return texts;
}

function classifyForbidden(
  error: Record<string, unknown> | null,
): GraphRejectionReason {
  if (error === null) return 'unknown';
  const texts = errorTexts(error).map((text) => text.toLowerCase());
  const has = (needle: string) => texts.some((text) => text.includes(needle));
  if (has('aadsts65001') || has('aadsts90093') || has('admin consent'))
    return 'admin_consent_required';
  if (has('aadsts500021') || has('tenant')) return 'tenant_restriction';
  if (has('policy')) return 'organization_policy';
  return typeof error['code'] === 'string' && error['code'].length > 0
    ? 'insufficient_permission'
    : 'unknown';
}

/**
 * Graph のエラー応答（2xx 以外）を結果型に分類する。結果には status と error.code だけを持つ。
 * 429 の retry_after_ms はここでは null（ヘッダーは connector 本体が見て埋め直す）。
 * 対応表は模擬の判定規則で、実 API のエラーとの対応は未検証（U174、ADR 0134）。
 */
export function classifyGraphError(
  status: number,
  body: unknown,
): GraphReadFailure {
  const rawError = isRecord(body) ? body['error'] : undefined;
  const error = isRecord(rawError) ? rawError : null;
  const rawCode = error?.['code'];
  const code =
    typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : 'unknown';
  if (status === 401) return { kind: 'authentication_expired', status, code };
  if (status === 403)
    return { kind: 'rejected', status, reason: classifyForbidden(error), code };
  if (status === 429)
    return { kind: 'rate_limited', status: 429, retry_after_ms: null };
  if (status >= 500 && status <= 599)
    return { kind: 'unavailable', reason: 'server_error' };
  if (status >= 400 && status <= 499)
    return { kind: 'rejected', status, reason: 'unknown', code };
  // 1xx・3xx など、読み取りの応答として想定しない状態。
  return { kind: 'unavailable', reason: 'invalid_response' };
}

// Retry-After は秒の整数だけを読む（HTTP 日付は時計に依存するので読まず null）。
function retryAfterMs(
  headers: Readonly<Record<string, string>>,
): number | null {
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'retry-after',
  );
  if (entry === undefined) return null;
  const text = entry[1].trim();
  if (!/^\d{1,9}$/u.test(text)) return null;
  return Number(text) * 1000;
}

type ItemParse<T> = { readonly item: T } | 'skip' | 'invalid';

interface PageOutcome<T> {
  readonly items: readonly T[];
  readonly skipped: number;
  readonly next: string | null;
}

export function createGraphMailConnector(
  options: GraphMailConnectorOptions,
): GraphMailConnector {
  if (typeof options.accessToken !== 'function')
    throw new TypeError('accessToken は関数で渡してください。');
  const transport = options.transport ?? defaultGraphTransport;
  const baseUrl = (options.baseUrl ?? GRAPH_DEFAULT_BASE_URL).replace(
    /\/+$/u,
    '',
  );
  const origin = new URL(baseUrl).origin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('timeoutMs は正の数で渡してください。');
  const maxPages = options.maxPages ?? GRAPH_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages <= 0)
    throw new TypeError('maxPages は正の整数で渡してください。');
  const accountKind = graphAccountKindForTenant(options.tenantId);

  // nextLink・cursor は同じ入口（origin とパスの接頭辞）の URL だけを辿る（別の宛先へトークンを送らない）。
  const sameService = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      const target = `${parsed.origin}${parsed.pathname}`;
      return parsed.origin === origin && target.startsWith(`${baseUrl}/`);
    } catch {
      return false;
    }
  };

  const buildUrl = (path: string, params: Record<string, string>): string => {
    const url = new URL(`${baseUrl}${path}`);
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  };

  // 1 回の GET。成功（2xx）の本文か、失敗の結果を返す。
  async function get(
    url: string,
  ): Promise<{ readonly ok: true; readonly body: unknown } | GraphReadFailure> {
    let token: string;
    try {
      token = await options.accessToken();
    } catch {
      // トークンを取れなければ要求を送らない（取得の失敗の内容は載せない）。
      return { kind: 'unavailable', reason: 'not_sent' };
    }
    if (typeof token !== 'string' || token.length === 0)
      return { kind: 'unavailable', reason: 'not_sent' };
    let outcome: GraphHttpOutcome;
    try {
      outcome = await transport({
        method: 'GET',
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: 'IdType="ImmutableId"',
        },
        timeoutMs,
        ...(options.timeoutSignal === undefined
          ? {}
          : { signal: options.timeoutSignal }),
      });
    } catch {
      // 注入した transport の例外は、送ったか分からないので応答なしとして扱う（内容は載せない）。
      return { kind: 'unavailable', reason: 'connection_lost' };
    }
    if (outcome.kind === 'not_sent')
      return { kind: 'unavailable', reason: 'not_sent' };
    if (outcome.kind === 'no_response')
      return { kind: 'unavailable', reason: outcome.reason };
    if (outcome.status >= 200 && outcome.status <= 299)
      return { ok: true, body: outcome.body };
    const failure = classifyGraphError(outcome.status, outcome.body);
    return failure.kind === 'rate_limited'
      ? { ...failure, retry_after_ms: retryAfterMs(outcome.headers) }
      : failure;
  }

  // コレクションの 1 ページを読む（{ value: [...], '@odata.nextLink'?: string }）。
  async function readPage<T>(
    url: string,
    parse: (raw: unknown) => ItemParse<T>,
  ): Promise<GraphReadResult<PageOutcome<T>>> {
    const result = await get(url);
    if (!('ok' in result)) return result;
    const body = result.body;
    if (!isRecord(body) || !Array.isArray(body['value']))
      return { kind: 'unavailable', reason: 'invalid_response' };
    const rawNext = body['@odata.nextLink'];
    if (
      rawNext !== undefined &&
      rawNext !== null &&
      typeof rawNext !== 'string'
    )
      return { kind: 'unavailable', reason: 'invalid_response' };
    const next = typeof rawNext === 'string' ? rawNext : null;
    if (next !== null && !sameService(next))
      return { kind: 'unavailable', reason: 'invalid_response' };
    const items: T[] = [];
    let skipped = 0;
    for (const raw of body['value'] as unknown[]) {
      const parsed = parse(raw);
      if (parsed === 'invalid')
        return { kind: 'unavailable', reason: 'invalid_response' };
      if (parsed === 'skip') skipped += 1;
      else items.push(parsed.item);
    }
    return { kind: 'ok', value: { items, skipped, next } };
  }

  // 最初の URL から nextLink が無くなるまで辿る。途中の失敗はそのまま返す。
  async function readAll<T>(
    firstUrl: string,
    parse: (raw: unknown) => ItemParse<T>,
  ): Promise<
    GraphReadResult<{
      readonly items: readonly T[];
      readonly skipped: number;
      readonly pages: number;
    }>
  > {
    const items: T[] = [];
    let skipped = 0;
    let pages = 0;
    let url: string | null = firstUrl;
    while (url !== null) {
      if (pages >= maxPages) throw new Error('ページ数の上限を超えました');
      const page: GraphReadResult<PageOutcome<T>> = await readPage(url, parse);
      if (page.kind !== 'ok') return page;
      pages += 1;
      items.push(...page.value.items);
      skipped += page.value.skipped;
      url = page.value.next;
    }
    return { kind: 'ok', value: { items, skipped, pages } };
  }

  const parseFolder = (raw: unknown): ItemParse<GraphMailFolder> => {
    if (!isRecord(raw)) return 'invalid';
    const id = raw['id'];
    const name = raw['displayName'];
    if (typeof id !== 'string' || id.length === 0) return 'invalid';
    if (typeof name !== 'string') return 'invalid';
    return {
      item: {
        folder_id: id,
        display_name: name,
        parent_folder_id: textOrNull(raw['parentFolderId']),
        total_item_count: countOrNull(raw['totalItemCount']),
        unread_item_count: countOrNull(raw['unreadItemCount']),
      },
    };
  };

  const parseMessage =
    (requestedFolderId: string | null) =>
    (raw: unknown): ItemParse<GraphMailMessage> => {
      // id の無い・空の項目は同一と断定できないので数えるだけにする（QA23）。
      if (!isRecord(raw)) return 'skip';
      const id = raw['id'];
      if (typeof id !== 'string' || id.length === 0) return 'skip';
      const from = isRecord(raw['from']) ? raw['from'] : null;
      const address =
        from !== null && isRecord(from['emailAddress'])
          ? from['emailAddress']
          : null;
      const categories = Array.isArray(raw['categories'])
        ? (raw['categories'] as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
      const isRead = raw['isRead'];
      return {
        item: {
          immutable_id: id,
          folder_id: textOrNull(raw['parentFolderId']) ?? requestedFolderId,
          received_at: textOrNull(raw['receivedDateTime']),
          last_modified_at: textOrNull(raw['lastModifiedDateTime']),
          subject: textOrNull(raw['subject']),
          sender_name: textOrNull(address?.['name']),
          sender_address: textOrNull(address?.['address']),
          categories,
          has_attachments: raw['hasAttachments'] === true,
          is_read: typeof isRead === 'boolean' ? isRead : null,
          conversation_id: textOrNull(raw['conversationId']),
        },
      };
    };

  const parseCategory = (raw: unknown): ItemParse<GraphMasterCategory> => {
    if (!isRecord(raw)) return 'invalid';
    const id = raw['id'];
    const name = raw['displayName'];
    if (typeof id !== 'string' || id.length === 0) return 'invalid';
    if (typeof name !== 'string') return 'invalid';
    return {
      item: {
        category_id: id,
        display_name: name,
        color: textOrNull(raw['color']),
      },
    };
  };

  function messagesUrl(
    folderId: string,
    query: Omit<GraphMessageQuery, 'cursor'>,
  ): string {
    if (typeof folderId !== 'string' || folderId.length === 0)
      throw new TypeError('folderId は空でない文字列で渡してください。');
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize <= 0)
      throw new TypeError('pageSize は正の整数で渡してください。');
    for (const value of [query.receivedSince, query.modifiedSince])
      if (value !== undefined && !DATE_TIME.test(value))
        throw new TypeError('日時は ISO 8601 の日時で渡してください。');
    const params: Record<string, string> = {};
    if (query.modifiedSince !== undefined) {
      params['$filter'] =
        query.receivedSince === undefined
          ? `lastModifiedDateTime ge ${query.modifiedSince}`
          : `lastModifiedDateTime ge ${query.modifiedSince} and receivedDateTime ge ${query.receivedSince}`;
      params['$orderby'] = 'lastModifiedDateTime desc';
    } else if (query.receivedSince !== undefined) {
      params['$filter'] = `receivedDateTime ge ${query.receivedSince}`;
      params['$orderby'] = 'receivedDateTime desc';
    } else {
      params['$orderby'] = 'receivedDateTime desc';
    }
    params['$select'] = MESSAGE_SELECT;
    params['$top'] = String(pageSize);
    return buildUrl(
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
      params,
    );
  }

  return {
    capability: GRAPH_CONNECTOR_CAPABILITY,

    async readAccount() {
      const result = await get(buildUrl('/me', { $select: ACCOUNT_SELECT }));
      if (!('ok' in result)) return result;
      const body = result.body;
      if (
        !isRecord(body) ||
        typeof body['id'] !== 'string' ||
        body['id'].length === 0
      )
        return { kind: 'unavailable', reason: 'invalid_response' };
      return {
        kind: 'ok',
        value: {
          account_id: body['id'],
          display_name: textOrNull(body['displayName']),
          mail: textOrNull(body['mail']),
          user_principal_name: textOrNull(body['userPrincipalName']),
          account_kind: accountKind,
        },
      };
    },

    async listMailFolders() {
      const result = await readAll(
        buildUrl('/me/mailFolders', { $select: FOLDER_SELECT, $top: '100' }),
        parseFolder,
      );
      return result.kind === 'ok'
        ? { kind: 'ok', value: result.value.items }
        : result;
    },

    async listMessagesPage(folderId, query = {}) {
      let url: string;
      if (query.cursor !== undefined) {
        if (!sameService(query.cursor))
          throw new TypeError('cursor は Graph の nextLink を渡してください。');
        if (typeof folderId !== 'string' || folderId.length === 0)
          throw new TypeError('folderId は空でない文字列で渡してください。');
        url = query.cursor;
      } else {
        url = messagesUrl(folderId, query);
      }
      const page = await readPage(url, parseMessage(folderId));
      if (page.kind !== 'ok') return page;
      return {
        kind: 'ok',
        value: {
          messages: page.value.items,
          skipped_without_id: page.value.skipped,
          next_cursor: page.value.next,
        },
      };
    },

    async listMessages(folderId, query = {}) {
      const result = await readAll(
        messagesUrl(folderId, query),
        parseMessage(folderId),
      );
      if (result.kind !== 'ok') return result;
      return {
        kind: 'ok',
        value: {
          messages: result.value.items,
          skipped_without_id: result.value.skipped,
          pages: result.value.pages,
        },
      };
    },

    async listCategories() {
      const result = await readAll(
        buildUrl('/me/outlook/masterCategories', { $select: CATEGORY_SELECT }),
        parseCategory,
      );
      return result.kind === 'ok'
        ? { kind: 'ok', value: result.value.items }
        : result;
    },
  };
}
