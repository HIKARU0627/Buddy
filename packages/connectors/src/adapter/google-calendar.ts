// Google Calendar の読み取り（B08-03、設計 04・11 §1）。
// syncToken は timeMin/timeMax と併用できないので使わない。固定窓＋updatedMin＋singleEvents＋showDeleted で列挙し、
// 取消は status='cancelled' で受け取る。窓・カレンダーは呼び出し側が渡した値だけを使い、connector 側で広げない。
import {
  collectPages,
  invalidResponse,
  isRecord,
  optionalString,
  readNextPageToken,
  type GoogleHttpClient,
  type GooglePage,
} from './google-http.js';

export interface GoogleCalendarEventTime {
  readonly dateTime?: string;
  readonly date?: string;
  readonly timeZone?: string;
}

export interface GoogleCalendarEvent {
  readonly id: string;
  readonly status: string;
  readonly updated?: string;
  readonly etag?: string;
  readonly iCalUID?: string;
  readonly summary?: string;
  readonly start?: GoogleCalendarEventTime;
  readonly end?: GoogleCalendarEventTime;
  readonly recurringEventId?: string;
  readonly originalStartTime?: GoogleCalendarEventTime;
  readonly sequence?: number;
}

export interface ListCalendarEventsRequest {
  readonly calendarId: string;
  readonly timeMin: string;
  readonly timeMax: string;
  readonly updatedMin?: string;
}

export interface GoogleCalendarReader {
  listEvents(
    request: ListCalendarEventsRequest,
  ): Promise<readonly GoogleCalendarEvent[]>;
  // ページ単位の読み取り（B08-05）。page_cursor の保存・再開は呼び出し側（Core の走査実行器）が持つ。
  listEventsPage(
    request: ListCalendarEventsRequest & { readonly pageToken?: string },
  ): Promise<GooglePage<GoogleCalendarEvent>>;
}

const CALENDAR_PAGE_SIZE = '250';

function toEventTime(value: unknown): GoogleCalendarEventTime | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalidResponse();
  const time: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  } = {};
  const dateTime = optionalString(value, 'dateTime');
  const date = optionalString(value, 'date');
  const timeZone = optionalString(value, 'timeZone');
  if (dateTime !== undefined) time.dateTime = dateTime;
  if (date !== undefined) time.date = date;
  if (timeZone !== undefined) time.timeZone = timeZone;
  return time;
}

// 未知のフィールドは落とし、GoogleCalendarEvent に写す。cancelled の予定は start/end/summary が無くてよい。
function toEvent(value: unknown): GoogleCalendarEvent {
  if (!isRecord(value)) throw invalidResponse();
  const id = value['id'];
  if (typeof id !== 'string' || id.length === 0) throw invalidResponse();
  const status = optionalString(value, 'status');
  if (status === undefined) throw invalidResponse();
  const event: {
    id: string;
    status: string;
    updated?: string;
    etag?: string;
    iCalUID?: string;
    summary?: string;
    start?: GoogleCalendarEventTime;
    end?: GoogleCalendarEventTime;
    recurringEventId?: string;
    originalStartTime?: GoogleCalendarEventTime;
    sequence?: number;
  } = { id, status };
  const updated = optionalString(value, 'updated');
  const etag = optionalString(value, 'etag');
  const iCalUID = optionalString(value, 'iCalUID');
  const summary = optionalString(value, 'summary');
  const recurringEventId = optionalString(value, 'recurringEventId');
  const start = toEventTime(value['start']);
  const end = toEventTime(value['end']);
  const originalStartTime = toEventTime(value['originalStartTime']);
  const sequence = value['sequence'];
  if (sequence !== undefined && sequence !== null) {
    if (typeof sequence !== 'number' || !Number.isInteger(sequence))
      throw invalidResponse();
    event.sequence = sequence;
  }
  if (updated !== undefined) event.updated = updated;
  if (etag !== undefined) event.etag = etag;
  if (iCalUID !== undefined) event.iCalUID = iCalUID;
  if (summary !== undefined) event.summary = summary;
  if (start !== undefined) event.start = start;
  if (end !== undefined) event.end = end;
  if (recurringEventId !== undefined) event.recurringEventId = recurringEventId;
  if (originalStartTime !== undefined)
    event.originalStartTime = originalStartTime;
  return event;
}

function toEventsPage(body: unknown): GooglePage<GoogleCalendarEvent> {
  if (!isRecord(body)) throw invalidResponse();
  const items = body['items'];
  // Calendar の events.list は空でも items を返す。配列でなければ不正。
  if (!Array.isArray(items)) throw invalidResponse();
  return {
    items: items.map(toEvent),
    ...readNextPageToken(body),
  };
}

export function createGoogleCalendarReader(
  client: GoogleHttpClient,
): GoogleCalendarReader {
  const listEventsPage: GoogleCalendarReader['listEventsPage'] = async (
    request,
  ) => {
    const path = `/calendar/v3/calendars/${encodeURIComponent(
      request.calendarId,
    )}/events`;
    return toEventsPage(
      await client.getJson(path, {
        singleEvents: 'true',
        showDeleted: 'true',
        timeMin: request.timeMin,
        timeMax: request.timeMax,
        updatedMin: request.updatedMin,
        maxResults: CALENDAR_PAGE_SIZE,
        pageToken: request.pageToken,
      }),
    );
  };
  return {
    listEventsPage,
    async listEvents(request) {
      return collectPages(async (pageToken) =>
        listEventsPage(
          pageToken === undefined ? request : { ...request, pageToken },
        ),
      );
    },
  };
}
