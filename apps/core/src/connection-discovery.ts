// 接続で選べる取得対象の発見（ADR 0145。設計 01 接続・端末の対象選択、設計 04 接続・権限／取得する対象、
// 設計 06 B08 の対象選択・B09 のカテゴリ一覧）。
//
// - Google はカレンダーの一覧（calendarList.list）と Gmail のラベルの一覧（labels.list）、Microsoft は
//   メールのフォルダーの一覧（listMailFolders）と既存のカテゴリ（listCategories。表示だけ、ADR 0072）を読む。
//   Microsoft のカレンダーは Buddy の Graph の読み取りに無い（ADR 0134・0138）ので not_supported。
// - 読んだ値は保存しない・記録しない（表示名は本人の個人の内容になりうるので、ログにも出さない）。取得対象へ足すのは
//   本人の取得対象の変更（PUT …/targets、許可版の CAS）だけで、ここは見つけた対象を自動で足さない（設計 04）。
// - トークンの出所は同期の走査と同じ口（CoreSyncOptions の tokenSourceFor・graphTokenSourceFor。接続の作成
//   B03-04 が用意する）。出所が無い接続は token_unavailable で、提供元へは送らない。
// - 提供元の拒否（403 など）は rejected、読めない（通信・提供元の障害・待ち時間の上限・トークンの期限切れ・
//   形の違う応答・重複した ID）は unavailable にし、種類ごとに返す（片方が読めなくても、読めた方は出す）。
//   読めないことを「対象が無い」に見せない（loaded 以外は一覧を空にし、状態で区別する）。自動の再試行は
//   Google の HTTP 土台の再試行の規則（CONNECTOR_RETRY_POLICY）の中だけで、ここでは重ねない。
// - 保存期限の掃除のゲート（ADR 0053）は通さない。検索・クラウドへの送信・自動利用ではなく、本人の画面操作で
//   入れ物の名前を一度読むだけで、何も保存しないため（retention-entries.test.ts の exempt）。
import {
  createGoogleReadConnector,
  createGraphMailConnector,
  GoogleApiError,
  type GoogleAccessTokenSource,
  type GoogleCalendarReader,
  type GoogleGmailReader,
  type GraphMailConnector,
  type GraphReadResult,
} from '@buddy/connectors';
import type { ConnectionRecord } from '@buddy/storage';
import type { GraphAccessTokenSource } from './graph-sync-executor.js';

export type DiscoveryStatus =
  'loaded' | 'rejected' | 'unavailable' | 'not_supported';

export interface TargetOption {
  readonly id: string;
  readonly display_name: string | null;
  readonly kind: 'calendar' | 'mail_label' | 'mail_folder';
  readonly primary: boolean;
}

export interface TargetOptionList {
  readonly status: DiscoveryStatus;
  readonly options: readonly TargetOption[];
}

export interface CategoryOption {
  readonly category_id: string;
  readonly display_name: string;
  readonly color: string | null;
}

export interface CategoryList {
  readonly status: DiscoveryStatus;
  readonly categories: readonly CategoryOption[];
}

export interface TargetDiscoveryValue {
  readonly calendars: TargetOptionList;
  readonly mail_containers: TargetOptionList;
  readonly categories: CategoryList;
}

export type TargetDiscoveryOutcome =
  | { readonly kind: 'ok'; readonly value: TargetDiscoveryValue }
  // トークンの出所が無い（接続の作成 B03-04 が用意していない）。提供元へは何も送っていない。
  | { readonly kind: 'token_unavailable' };

/** 接続 1 件の選べる対象を読む口（api-connections.ts へ注入する）。 */
export type TargetDiscoveryPort = (
  connection: ConnectionRecord,
) => Promise<TargetDiscoveryOutcome>;

export interface GoogleDiscoveryReader {
  readonly calendar: Pick<GoogleCalendarReader, 'listCalendars'>;
  readonly gmail: Pick<GoogleGmailReader, 'listLabels'>;
}

export type GraphDiscoveryReader = Pick<
  GraphMailConnector,
  'listMailFolders' | 'listCategories'
>;

export interface ConnectionDiscoveryOptions {
  // 接続ごとのアクセストークンの出所（Google）。null を返す・省略した接続は読まない。
  readonly googleTokenSourceFor?: (
    connection: ConnectionRecord,
  ) => GoogleAccessTokenSource | null;
  // 接続ごとのアクセストークンの出所（Microsoft Graph）。null を返す・省略した接続は読まない。
  readonly graphTokenSourceFor?: (
    connection: ConnectionRecord,
  ) => GraphAccessTokenSource | null;
  // connector の作り方（試験で差し替える）。省略時は読み取り connector。
  readonly createGoogleReader?: (
    tokenSource: GoogleAccessTokenSource,
  ) => GoogleDiscoveryReader;
  readonly createGraphReader?: (
    accessToken: GraphAccessTokenSource,
  ) => GraphDiscoveryReader;
}

const NOT_SUPPORTED_TARGETS: TargetOptionList = {
  status: 'not_supported',
  options: [],
};
const NOT_SUPPORTED_CATEGORIES: CategoryList = {
  status: 'not_supported',
  categories: [],
};
const empty = (status: 'rejected' | 'unavailable'): TargetOptionList => ({
  status,
  options: [],
});

// 同じ ID が 2 回返った・メインのカレンダーが 2 つある一覧は、どちらを選んだのか断定できないので読めない扱い。
function checkedTargets(options: readonly TargetOption[]): TargetOptionList {
  const ids = new Set(options.map((option) => option.id));
  if (ids.size !== options.length) return empty('unavailable');
  if (options.filter((option) => option.primary).length > 1)
    return empty('unavailable');
  return { status: 'loaded', options };
}

// Google の読み取りの失敗を状態へ。提供元の拒否（403）だけを rejected にし、ほかはすべて読めない。
function googleFailure(error: unknown): 'rejected' | 'unavailable' {
  return error instanceof GoogleApiError &&
    error.kind === 'http_error' &&
    error.status === 403
    ? 'rejected'
    : 'unavailable';
}

async function googleCalendars(
  reader: GoogleDiscoveryReader,
): Promise<TargetOptionList> {
  try {
    const entries = await reader.calendar.listCalendars();
    return checkedTargets(
      entries.map((entry) => ({
        id: entry.id,
        // 本人が付けた名前を優先する。どちらも無ければ表示名は無い（推測で作らない）。
        display_name: entry.summaryOverride ?? entry.summary ?? null,
        kind: 'calendar',
        primary: entry.primary,
      })),
    );
  } catch (error) {
    return empty(googleFailure(error));
  }
}

async function googleLabels(
  reader: GoogleDiscoveryReader,
): Promise<TargetOptionList> {
  try {
    const labels = await reader.gmail.listLabels();
    return checkedTargets(
      labels.map((label) => ({
        id: label.id,
        display_name: label.name,
        kind: 'mail_label',
        primary: false,
      })),
    );
  } catch (error) {
    return empty(googleFailure(error));
  }
}

function graphStatus(
  result: GraphReadResult<unknown>,
): 'rejected' | 'unavailable' {
  return result.kind === 'rejected' ? 'rejected' : 'unavailable';
}

async function graphFolders(
  reader: GraphDiscoveryReader,
): Promise<TargetOptionList> {
  try {
    const result = await reader.listMailFolders();
    if (result.kind !== 'ok') return empty(graphStatus(result));
    return checkedTargets(
      result.value.map((folder) => ({
        id: folder.folder_id,
        display_name: folder.display_name,
        kind: 'mail_folder',
        primary: false,
      })),
    );
  } catch {
    // ページ数の上限など、connector がプログラムの誤りとして投げたもの。読めない扱いにする。
    return empty('unavailable');
  }
}

async function graphCategories(
  reader: GraphDiscoveryReader,
): Promise<CategoryList> {
  try {
    const result = await reader.listCategories();
    if (result.kind !== 'ok')
      return { status: graphStatus(result), categories: [] };
    const categories = result.value.map((category) => ({
      category_id: category.category_id,
      display_name: category.display_name,
      color:
        category.color === null || category.color.length === 0
          ? null
          : category.color,
    }));
    if (
      new Set(categories.map((category) => category.category_id)).size !==
      categories.length
    )
      return { status: 'unavailable', categories: [] };
    return { status: 'loaded', categories };
  } catch {
    return { status: 'unavailable', categories: [] };
  }
}

export function createConnectionDiscovery(
  options: ConnectionDiscoveryOptions,
): TargetDiscoveryPort {
  const createGoogleReader =
    options.createGoogleReader ??
    ((tokenSource: GoogleAccessTokenSource) =>
      createGoogleReadConnector({ tokenSource }));
  const createGraphReader =
    options.createGraphReader ??
    ((accessToken: GraphAccessTokenSource) =>
      createGraphMailConnector({ accessToken }));

  return async (connection) => {
    if (connection.provider === 'google') {
      const tokenSource = options.googleTokenSourceFor?.(connection) ?? null;
      if (tokenSource === null) return { kind: 'token_unavailable' };
      const reader = createGoogleReader(tokenSource);
      const [calendars, mailContainers] = await Promise.all([
        googleCalendars(reader),
        googleLabels(reader),
      ]);
      return {
        kind: 'ok',
        value: {
          calendars,
          mail_containers: mailContainers,
          categories: NOT_SUPPORTED_CATEGORIES,
        },
      };
    }
    const accessToken = options.graphTokenSourceFor?.(connection) ?? null;
    if (accessToken === null) return { kind: 'token_unavailable' };
    const reader = createGraphReader(accessToken);
    const [mailContainers, categories] = await Promise.all([
      graphFolders(reader),
      graphCategories(reader),
    ]);
    return {
      kind: 'ok',
      value: {
        calendars: NOT_SUPPORTED_TARGETS,
        mail_containers: mailContainers,
        categories,
      },
    };
  };
}
