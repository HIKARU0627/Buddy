// Google Calendar の読み取り（B08-03、設計 04・11 §1）。
// syncToken は timeMin/timeMax と併用できないので使わない。固定窓＋updatedMin＋singleEvents＋showDeleted で列挙し、
// 取消は status='cancelled' で受け取る。窓・カレンダーは呼び出し側が渡した値だけを使い、connector 側で広げない。
// カレンダーの一覧（calendarList.list）は取得対象の発見の表示用（ADR 0145）。読んだ一覧を取得対象へ足すのは本人の選択だけで、
// connector も Core も自動では足さない（設計 04 取得する対象）。
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
  // 空き時間扱いか（opaque・transparent）。予定の重複の判定に使う（ADR 0194）。
  readonly transparency?: string;
  // 予定の種類（default・outOfOffice・focusTime・workingLocation・birthday など）。
  readonly eventType?: string;
  // 本人の出欠（attendees のうち self が真の 1 件の responseStatus）。ほかの参加者・アドレスは写さない。
  readonly selfResponseStatus?: string;
}

export interface ListCalendarEventsRequest {
  readonly calendarId: string;
  readonly timeMin: string;
  readonly timeMax: string;
  readonly updatedMin?: string;
}

// calendarList.list の 1 件（ADR 0145）。表示名は summaryOverride（本人が付けた名前）を優先し、無ければ summary。
// どちらも無ければ表示名は無い（推測で名前を作らない）。
export interface GoogleCalendarListEntry {
  readonly id: string;
  readonly summary?: string;
  readonly summaryOverride?: string;
  readonly primary: boolean;
  readonly accessRole?: string;
}

export interface GoogleCalendarReader {
  // 本人のカレンダーの一覧（全ページ。calendar.calendarlist.readonly、設計 04 接続・権限）。取得対象の発見の表示用。
  listCalendars(): Promise<readonly GoogleCalendarListEntry[]>;
  listEvents(
    request: ListCalendarEventsRequest,
  ): Promise<readonly GoogleCalendarEvent[]>;
  // ページ単位の読み取り（B08-05）。page_cursor の保存・再開は呼び出し側（Core の走査実行器）が持つ。
  listEventsPage(
    request: ListCalendarEventsRequest & { readonly pageToken?: string },
  ): Promise<GoogleCalendarEventsPage>;
  // 1 件の予定（events.get、ADR 0201）。気づきの根拠を取り直すのに使う。カレンダーと予定の ID は呼び出し側が控えた値だけで、
  // ほかのカレンダーを探さない。消えた予定は GoogleApiError（404・410）。取り消された予定は status が cancelled。
  getEvent(request: {
    readonly calendarId: string;
    readonly eventId: string;
  }): Promise<GoogleCalendarEvent>;
}

const CALENDAR_PAGE_SIZE = '250';
// calendarList.list の最大の maxResults。項目は表示に要る最小の集合だけを求める（設計 04: 最小の select）。
const CALENDAR_LIST_PAGE_SIZE = '250';
const CALENDAR_LIST_FIELDS =
  'items(id,summary,summaryOverride,primary,accessRole),nextPageToken';
// events.get で求める項目（ADR 0201）。根拠の判定に要る最小の集合で、本文（description）・場所・参加者のアドレスは求めない
// （参加者は本人の出欠だけを写すために self と responseStatus だけ）。
const EVENT_FIELDS =
  'id,status,updated,etag,iCalUID,summary,start,end,recurringEventId,originalStartTime,sequence,transparency,eventType,attendees(self,responseStatus)';

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
    transparency?: string;
    eventType?: string;
    selfResponseStatus?: string;
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
  // 予定の重複の判定のために足した項目（ADR 0194）は、形が想定外なら「無し」として読み、頁を拒まない（同期と発言の読み取りに
  // 影響させない）。
  const transparency = lenientString(value['transparency']);
  const eventType = lenientString(value['eventType']);
  if (transparency !== undefined) event.transparency = transparency;
  if (eventType !== undefined) event.eventType = eventType;
  const selfResponseStatus = selfResponse(value['attendees']);
  if (selfResponseStatus !== undefined)
    event.selfResponseStatus = selfResponseStatus;
  return event;
}

const lenientString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

// 参加者の一覧から、本人（self が真）の出欠だけを取り出す。一覧そのもの・ほかの参加者のアドレスは返さない。形が想定外なら
// 「無し」（頁を拒まない）。
function selfResponse(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const attendee of value)
    if (isRecord(attendee) && attendee['self'] === true)
      return lenientString(attendee['responseStatus']);
  return undefined;
}

// events.list の 1 頁。accessRole は本人のこのカレンダーへの権限（owner・writer・reader・freeBusyReader）。予定の重複を
// 本人の持ち物のカレンダーだけで求めるのに使う（ADR 0194、U550）。形が想定外なら無し。
export interface GoogleCalendarEventsPage extends GooglePage<GoogleCalendarEvent> {
  readonly accessRole?: string;
}

function toEventsPage(body: unknown): GoogleCalendarEventsPage {
  if (!isRecord(body)) throw invalidResponse();
  const items = body['items'];
  // Calendar の events.list は空でも items を返す。配列でなければ不正。
  if (!Array.isArray(items)) throw invalidResponse();
  const accessRole = lenientString(body['accessRole']);
  return {
    items: items.map(toEvent),
    ...readNextPageToken(body),
    ...(accessRole === undefined ? {} : { accessRole }),
  };
}

// 未知のフィールドは落とす。id は必須。primary は true のときだけ真（無い・false は偽）。
function toCalendarListEntry(value: unknown): GoogleCalendarListEntry {
  if (!isRecord(value)) throw invalidResponse();
  const id = value['id'];
  if (typeof id !== 'string' || id.length === 0) throw invalidResponse();
  const primary = value['primary'];
  if (primary !== undefined && primary !== null && typeof primary !== 'boolean')
    throw invalidResponse();
  const entry: {
    id: string;
    summary?: string;
    summaryOverride?: string;
    primary: boolean;
    accessRole?: string;
  } = { id, primary: primary === true };
  const summary = optionalString(value, 'summary');
  const summaryOverride = optionalString(value, 'summaryOverride');
  const accessRole = optionalString(value, 'accessRole');
  if (summary !== undefined) entry.summary = summary;
  if (summaryOverride !== undefined) entry.summaryOverride = summaryOverride;
  if (accessRole !== undefined) entry.accessRole = accessRole;
  return entry;
}

function toCalendarListPage(
  body: unknown,
): GooglePage<GoogleCalendarListEntry> {
  if (!isRecord(body)) throw invalidResponse();
  const items = body['items'];
  // 該当が無いと items を省略することがある。省略は空、配列以外は不正。
  if (items !== undefined && items !== null && !Array.isArray(items))
    throw invalidResponse();
  return {
    items: (Array.isArray(items) ? items : []).map(toCalendarListEntry),
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
    async listCalendars() {
      return collectPages(async (pageToken) =>
        toCalendarListPage(
          await client.getJson('/calendar/v3/users/me/calendarList', {
            maxResults: CALENDAR_LIST_PAGE_SIZE,
            fields: CALENDAR_LIST_FIELDS,
            pageToken,
          }),
        ),
      );
    },
    listEventsPage,
    async getEvent(request) {
      return toEvent(
        await client.getJson(
          `/calendar/v3/calendars/${encodeURIComponent(
            request.calendarId,
          )}/events/${encodeURIComponent(request.eventId)}`,
          { fields: EVENT_FIELDS },
        ),
      );
    },
    async listEvents(request) {
      return collectPages(async (pageToken) =>
        listEventsPage(
          pageToken === undefined ? request : { ...request, pageToken },
        ),
      );
    },
  };
}
