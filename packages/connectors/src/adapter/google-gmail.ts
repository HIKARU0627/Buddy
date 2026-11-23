// Gmail の読み取り（B08-03、設計 11 §1）。
// 全量は選択ラベルごとに messages.list（labelIds・q=after:）で全ページ、増分は history.list で全ページ読む。
// history の 404 は startHistoryId の期限切れとして GoogleHistoryExpiredError にする。
// ラベル・期間は呼び出し側が渡した値だけを使い、connector 側で広げない。
// ラベルの一覧（labels.list）は取得対象の発見の表示用（ADR 0145）。読んだラベルを取得対象へ足すのは本人の選択だけ。
import {
  collectPages,
  GoogleApiError,
  invalidResponse,
  isRecord,
  optionalString,
  readNextPageToken,
  type GoogleHttpClient,
  type GooglePage,
} from './google-http.js';

export interface GoogleGmailMessageRef {
  readonly id: string;
  readonly threadId?: string;
}

export interface GoogleGmailHeader {
  readonly name: string;
  readonly value: string;
}

export interface GoogleGmailPart {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers: readonly GoogleGmailHeader[];
  readonly bodySize: number;
  readonly bodyAttachmentId?: string;
  readonly bodyData?: string;
  readonly parts: readonly GoogleGmailPart[];
}

export interface GoogleGmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly labelIds: readonly string[];
  readonly snippet?: string;
  readonly historyId?: string;
  readonly internalDate?: string;
  readonly sizeEstimate?: number;
  readonly payload?: GoogleGmailPart;
}

export interface GoogleHistoryLabelChange {
  readonly messageId: string;
  readonly labelIds: readonly string[];
}

export interface GoogleHistoryEntry {
  readonly id: string;
  readonly addedMessageIds: readonly string[];
  readonly deletedMessageIds: readonly string[];
  readonly labelsAdded: readonly GoogleHistoryLabelChange[];
  readonly labelsRemoved: readonly GoogleHistoryLabelChange[];
}

export interface GoogleHistoryResult {
  readonly historyId: string;
  readonly entries: readonly GoogleHistoryEntry[];
}

// attachments.get の結果。data は base64url をバイト列へ戻したもの。size は API が申告する復号後のバイト数で、
// 実際のバイト数と一致しない応答は不正として拒否する（呼び出し側は data.length を使う）。
export interface GoogleGmailAttachment {
  readonly size: number;
  readonly data: Uint8Array;
}

// payload の木から拾った添付パート（B08-04）。ファイル名を持つ末端のパートだけを添付として扱う。
// 本文パート（ファイル名なし）や、入れ物の multipart パートは含めない。取得してよいかの判定は domain の
// fetch-scope（checkAttachment）が正本で、ここは構造の列挙だけを行う。
export interface GoogleGmailAttachmentPart {
  // メッセージ内での位置（partId）。応答に無い場合は null。
  readonly partId: string | null;
  // attachments.get に使う識別子。インラインでデータが届いている場合は null になることがある。
  readonly attachmentId: string | null;
  // format=full で小さな添付が本文と一緒に届いた場合のデータ（base64url）。無ければ null。
  readonly inlineData: string | null;
  readonly filename: string;
  // パートの MIME。応答に無い場合は空文字列（種類を決められず、取得対象にならない）。
  readonly mimeType: string;
  // provider が申告するサイズ（body.size）。分からない場合は null（checkAttachment はサイズ不明を取らない）。
  readonly sizeBytes: number | null;
  // Content-Type の charset など、抽出に要るヘッダーだけを残す。
  readonly contentType: string | null;
}

export type GoogleGmailMessageFormat = 'minimal' | 'metadata' | 'full';

// labels.list の 1 件（ADR 0145）。type は system（INBOX など Gmail が持つラベル）か user（本人が作ったラベル）。
// それ以外・無い場合は null（種別を断定しない）。
export interface GoogleGmailLabel {
  readonly id: string;
  readonly name: string;
  readonly type: 'system' | 'user' | null;
}

export interface GoogleGmailReader {
  // 本人のラベルの一覧（labels.list はページを持たない）。取得対象の発見の表示用（ADR 0145）。
  listLabels(): Promise<readonly GoogleGmailLabel[]>;
  listMessageIds(request: {
    readonly labelIds: readonly string[];
    readonly afterEpochSeconds: number;
  }): Promise<readonly GoogleGmailMessageRef[]>;
  // ページ単位の読み取り（B08-05）。page_cursor の保存・再開は呼び出し側（Core の走査実行器）が持つ。
  listMessageIdsPage(request: {
    readonly labelIds: readonly string[];
    readonly afterEpochSeconds: number;
    readonly pageToken?: string;
  }): Promise<GooglePage<GoogleGmailMessageRef>>;
  getMessage(request: {
    readonly id: string;
    readonly format: GoogleGmailMessageFormat;
  }): Promise<GoogleGmailMessage>;
  // 添付 1 件の内容の取得（B08-04、設計 04 J16）。取得してよい添付かの判定は呼び出し側（domain の
  // checkAttachment を通したものだけを渡す）。RAW 全体取得は使わない。
  getAttachment(request: {
    readonly messageId: string;
    readonly attachmentId: string;
  }): Promise<GoogleGmailAttachment>;
  listHistory(request: {
    readonly startHistoryId: string;
    readonly labelId?: string;
  }): Promise<GoogleHistoryResult>;
  // ページ単位の読み取り（B08-05）。historyId はそのページの応答の値で、最終ページの値が次の起点になる。
  listHistoryPage(request: {
    readonly startHistoryId: string;
    readonly labelId?: string;
    readonly pageToken?: string;
  }): Promise<GooglePage<GoogleHistoryEntry> & { readonly historyId: string }>;
}

// history の startHistoryId が期限切れ（404）。呼び出し側は全量の読み直しに切り替える。
export class GoogleHistoryExpiredError extends Error {
  constructor() {
    super('Gmail の履歴の起点が期限切れです');
    this.name = 'GoogleHistoryExpiredError';
  }
}

const MESSAGES_PAGE_SIZE = '500';
const HISTORY_TYPES: readonly string[] = [
  'messageAdded',
  'messageDeleted',
  'labelAdded',
  'labelRemoved',
];

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw invalidResponse();
  return value;
}

function stringArray(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map((item) => {
    if (typeof item !== 'string') throw invalidResponse();
    return item;
  });
}

// Gmail の一覧系は、該当が無いと配列のキーごと省略する。省略は空、配列以外は不正。
function optionalArray(
  record: Record<string, unknown>,
  key: string,
): unknown[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidResponse();
  return value;
}

function toMessageRef(value: unknown): GoogleGmailMessageRef {
  if (!isRecord(value)) throw invalidResponse();
  const id = requiredString(value, 'id');
  const threadId = optionalString(value, 'threadId');
  return threadId === undefined ? { id } : { id, threadId };
}

function toMessageRefsPage(body: unknown): GooglePage<GoogleGmailMessageRef> {
  if (!isRecord(body)) throw invalidResponse();
  return {
    items: optionalArray(body, 'messages').map(toMessageRef),
    ...readNextPageToken(body),
  };
}

function toHeader(value: unknown): GoogleGmailHeader {
  if (!isRecord(value)) throw invalidResponse();
  const name = value['name'];
  const headerValue = value['value'];
  if (typeof name !== 'string' || typeof headerValue !== 'string')
    throw invalidResponse();
  return { name, value: headerValue };
}

function toPart(value: unknown): GoogleGmailPart {
  if (!isRecord(value)) throw invalidResponse();
  const body = value['body'];
  if (body !== undefined && body !== null && !isRecord(body))
    throw invalidResponse();
  const bodyRecord = isRecord(body) ? body : {};
  const rawSize = bodyRecord['size'];
  let size = 0;
  if (rawSize !== undefined && rawSize !== null) {
    if (typeof rawSize !== 'number' || rawSize < 0) throw invalidResponse();
    size = rawSize;
  }
  const part: {
    partId?: string;
    mimeType?: string;
    filename?: string;
    headers: readonly GoogleGmailHeader[];
    bodySize: number;
    bodyAttachmentId?: string;
    bodyData?: string;
    parts: readonly GoogleGmailPart[];
  } = {
    headers: optionalArray(value, 'headers').map(toHeader),
    bodySize: size,
    parts: optionalArray(value, 'parts').map(toPart),
  };
  const partId = optionalString(value, 'partId');
  const mimeType = optionalString(value, 'mimeType');
  const filename = optionalString(value, 'filename');
  const attachmentId = optionalString(bodyRecord, 'attachmentId');
  const data = optionalString(bodyRecord, 'data');
  if (partId !== undefined) part.partId = partId;
  if (mimeType !== undefined) part.mimeType = mimeType;
  if (filename !== undefined) part.filename = filename;
  if (attachmentId !== undefined) part.bodyAttachmentId = attachmentId;
  if (data !== undefined) part.bodyData = data;
  return part;
}

function toMessage(body: unknown): GoogleGmailMessage {
  if (!isRecord(body)) throw invalidResponse();
  const message: {
    id: string;
    threadId?: string;
    labelIds: readonly string[];
    snippet?: string;
    historyId?: string;
    internalDate?: string;
    sizeEstimate?: number;
    payload?: GoogleGmailPart;
  } = {
    id: requiredString(body, 'id'),
    labelIds: stringArray(body['labelIds']),
  };
  const threadId = optionalString(body, 'threadId');
  const snippet = optionalString(body, 'snippet');
  const historyId = optionalString(body, 'historyId');
  const internalDate = optionalString(body, 'internalDate');
  const sizeEstimate = body['sizeEstimate'];
  if (threadId !== undefined) message.threadId = threadId;
  if (snippet !== undefined) message.snippet = snippet;
  if (historyId !== undefined) message.historyId = historyId;
  if (internalDate !== undefined) message.internalDate = internalDate;
  if (sizeEstimate !== undefined && sizeEstimate !== null) {
    if (typeof sizeEstimate !== 'number') throw invalidResponse();
    message.sizeEstimate = sizeEstimate;
  }
  const payload = body['payload'];
  if (payload !== undefined && payload !== null)
    message.payload = toPart(payload);
  return message;
}

// base64url の厳密な復号。余分な文字や書き換えを受け付けず、符号化し直して一致するものだけを通す
// （緩い復号で壊れたバイト列を「取得できた」としない）。添付の data と、インラインの body.data の両方で使う。
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value.replace(/=+$/, '')) return null;
  return new Uint8Array(bytes);
}

function toAttachment(body: unknown): GoogleGmailAttachment {
  if (!isRecord(body)) throw invalidResponse();
  const size = body['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    throw invalidResponse();
  const data = body['data'];
  if (typeof data !== 'string' || data.length === 0) throw invalidResponse();
  const bytes = decodeBase64Url(data);
  if (bytes === null || bytes.length !== size) throw invalidResponse();
  return { size, data: bytes };
}

// payload の木から添付パートを列挙する（B08-04）。ファイル名が空でないパートを添付とし、その中はたどらない
// （添付されたメール（message/rfc822）の中の添付を、このメールの添付として扱わない）。
// ファイル名を持たない入れ物のパート（multipart）はたどるだけで含めない。
// 並びは木の出現順（抽出入力の添付の並びと source の対応を安定させる）。
export function listAttachmentParts(
  payload: GoogleGmailPart,
): readonly GoogleGmailAttachmentPart[] {
  const found: GoogleGmailAttachmentPart[] = [];
  const walk = (part: GoogleGmailPart): void => {
    const filename = part.filename ?? '';
    if (filename !== '') {
      const contentTypeHeader = part.headers.find(
        (header) => header.name.toLowerCase() === 'content-type',
      );
      found.push({
        partId: part.partId ?? null,
        attachmentId: part.bodyAttachmentId ?? null,
        inlineData: part.bodyData ?? null,
        filename,
        mimeType: part.mimeType ?? '',
        sizeBytes: part.bodySize,
        contentType: contentTypeHeader?.value ?? null,
      });
      return;
    }
    for (const child of part.parts) walk(child);
  };
  walk(payload);
  return found;
}

function toLabel(value: unknown): GoogleGmailLabel {
  if (!isRecord(value)) throw invalidResponse();
  const id = requiredString(value, 'id');
  const name = value['name'];
  if (typeof name !== 'string') throw invalidResponse();
  const type = optionalString(value, 'type');
  return {
    id,
    name,
    type: type === 'system' || type === 'user' ? type : null,
  };
}

function toLabels(body: unknown): readonly GoogleGmailLabel[] {
  if (!isRecord(body)) throw invalidResponse();
  return optionalArray(body, 'labels').map(toLabel);
}

function messageIdOf(value: unknown): string {
  if (!isRecord(value)) throw invalidResponse();
  const message = value['message'];
  if (!isRecord(message)) throw invalidResponse();
  return requiredString(message, 'id');
}

function toLabelChange(value: unknown): GoogleHistoryLabelChange {
  if (!isRecord(value)) throw invalidResponse();
  return {
    messageId: messageIdOf(value),
    labelIds: stringArray(value['labelIds']),
  };
}

function toHistoryEntry(value: unknown): GoogleHistoryEntry {
  if (!isRecord(value)) throw invalidResponse();
  return {
    id: requiredString(value, 'id'),
    addedMessageIds: optionalArray(value, 'messagesAdded').map(messageIdOf),
    deletedMessageIds: optionalArray(value, 'messagesDeleted').map(messageIdOf),
    labelsAdded: optionalArray(value, 'labelsAdded').map(toLabelChange),
    labelsRemoved: optionalArray(value, 'labelsRemoved').map(toLabelChange),
  };
}

function toHistoryPage(
  body: unknown,
): GooglePage<GoogleHistoryEntry> & { readonly historyId: string } {
  if (!isRecord(body)) throw invalidResponse();
  return {
    items: optionalArray(body, 'history').map(toHistoryEntry),
    ...readNextPageToken(body),
    // そのページの応答の historyId。呼び出し側は最終ページの値を次の起点にする。
    historyId: requiredString(body, 'historyId'),
  };
}

export function createGoogleGmailReader(
  client: GoogleHttpClient,
): GoogleGmailReader {
  const listMessageIdsPage: GoogleGmailReader['listMessageIdsPage'] = async (
    request,
  ) =>
    toMessageRefsPage(
      await client.getJson('/gmail/v1/users/me/messages', {
        labelIds: request.labelIds,
        q: `after:${request.afterEpochSeconds}`,
        maxResults: MESSAGES_PAGE_SIZE,
        pageToken: request.pageToken,
      }),
    );

  const listHistoryPage: GoogleGmailReader['listHistoryPage'] = async (
    request,
  ) => {
    let body: unknown;
    try {
      body = await client.getJson('/gmail/v1/users/me/history', {
        startHistoryId: request.startHistoryId,
        historyTypes: HISTORY_TYPES,
        labelId: request.labelId,
        pageToken: request.pageToken,
      });
    } catch (error) {
      if (
        error instanceof GoogleApiError &&
        error.kind === 'http_error' &&
        error.status === 404
      ) {
        throw new GoogleHistoryExpiredError();
      }
      throw error;
    }
    return toHistoryPage(body);
  };

  return {
    async listLabels() {
      return toLabels(
        await client.getJson('/gmail/v1/users/me/labels', {
          fields: 'labels(id,name,type)',
        }),
      );
    },
    listMessageIdsPage,
    async listMessageIds(request) {
      return collectPages(async (pageToken) =>
        listMessageIdsPage(
          pageToken === undefined ? request : { ...request, pageToken },
        ),
      );
    },

    async getMessage(request) {
      return toMessage(
        await client.getJson(
          `/gmail/v1/users/me/messages/${encodeURIComponent(request.id)}`,
          { format: request.format },
        ),
      );
    },

    async getAttachment(request) {
      return toAttachment(
        await client.getJson(
          `/gmail/v1/users/me/messages/${encodeURIComponent(request.messageId)}/attachments/${encodeURIComponent(request.attachmentId)}`,
          {},
        ),
      );
    },

    listHistoryPage,
    async listHistory(request) {
      // 閉包の中で書き換えるので、変数の絞り込みに頼らずオブジェクトに置く。
      const last: { historyId?: string } = {};
      // 404 → GoogleHistoryExpiredError の変換は listHistoryPage が持つ。
      const entries = await collectPages(async (pageToken) => {
        const page = await listHistoryPage(
          pageToken === undefined ? request : { ...request, pageToken },
        );
        // 最後の応答の historyId を次回の起点にする。
        last.historyId = page.historyId;
        return page;
      });
      const { historyId } = last;
      if (historyId === undefined) throw invalidResponse();
      return { historyId, entries };
    },
  };
}
