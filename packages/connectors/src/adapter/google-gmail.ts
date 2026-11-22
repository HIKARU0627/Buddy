// Gmail の読み取り（B08-03、設計 11 §1）。
// 全量は選択ラベルごとに messages.list（labelIds・q=after:）で全ページ、増分は history.list で全ページ読む。
// history の 404 は startHistoryId の期限切れとして GoogleHistoryExpiredError にする。
// ラベル・期間は呼び出し側が渡した値だけを使い、connector 側で広げない。
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

export type GoogleGmailMessageFormat = 'minimal' | 'metadata' | 'full';

export interface GoogleGmailReader {
  listMessageIds(request: {
    readonly labelIds: readonly string[];
    readonly afterEpochSeconds: number;
  }): Promise<readonly GoogleGmailMessageRef[]>;
  getMessage(request: {
    readonly id: string;
    readonly format: GoogleGmailMessageFormat;
  }): Promise<GoogleGmailMessage>;
  listHistory(request: {
    readonly startHistoryId: string;
    readonly labelId?: string;
  }): Promise<GoogleHistoryResult>;
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

export function createGoogleGmailReader(
  client: GoogleHttpClient,
): GoogleGmailReader {
  return {
    async listMessageIds(request) {
      return collectPages(async (pageToken) =>
        toMessageRefsPage(
          await client.getJson('/gmail/v1/users/me/messages', {
            labelIds: request.labelIds,
            q: `after:${request.afterEpochSeconds}`,
            maxResults: MESSAGES_PAGE_SIZE,
            pageToken,
          }),
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

    async listHistory(request) {
      // 閉包の中で書き換えるので、変数の絞り込みに頼らずオブジェクトに置く。
      const last: { historyId?: string } = {};
      let entries: readonly GoogleHistoryEntry[];
      try {
        entries = await collectPages(async (pageToken) => {
          const body = await client.getJson('/gmail/v1/users/me/history', {
            startHistoryId: request.startHistoryId,
            historyTypes: HISTORY_TYPES,
            labelId: request.labelId,
            pageToken,
          });
          if (!isRecord(body)) throw invalidResponse();
          // 最後の応答の historyId を次回の起点にする。
          last.historyId = requiredString(body, 'historyId');
          return {
            items: optionalArray(body, 'history').map(toHistoryEntry),
            ...readNextPageToken(body),
          };
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
      const { historyId } = last;
      if (historyId === undefined) throw invalidResponse();
      return { historyId, entries };
    },
  };
}
