// Google の読み取り connector の試験（B08-03）。模擬 transport だけを使い、実ネットワーク・実トークンは使わない。
// 期待値はすべて手で書いた値で、実装の処理から作らない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkConnectorCapability } from '@buddy/domain';
import {
  createGoogleReadConnector,
  GOOGLE_READ_CAPABILITY,
  GoogleApiError,
  GoogleHistoryExpiredError,
  GoogleTransportFailure,
  listAttachmentParts,
  type GoogleGmailPart,
  type GoogleHttpTransportRequest,
  type GoogleHttpTransportResponse,
} from './index.js';

// 合成のトークン（実在しない値）。
const TOKEN = 'SECRET_TOKEN_FOR_TEST';
const NOW = Date.parse('2026-11-22T00:00:00Z');

type Step = GoogleHttpTransportResponse | GoogleTransportFailure;

function json(body: unknown): GoogleHttpTransportResponse {
  return { status: 200, headers: {}, bodyText: JSON.stringify(body) };
}

function status(
  code: number,
  headers: Record<string, string> = {},
): GoogleHttpTransportResponse {
  // 応答本文にトークンに似た値を入れても、エラーへ漏れないことを確かめる。
  return { status: code, headers, bodyText: `{"error":"${TOKEN}"}` };
}

function setup(script: readonly Step[]) {
  const requests: GoogleHttpTransportRequest[] = [];
  const sleeps: number[] = [];
  const steps = [...script];
  const connector = createGoogleReadConnector({
    tokenSource: { getAccessToken: () => Promise.resolve(TOKEN) },
    transport: (request) => {
      requests.push(request);
      const step = steps.shift();
      if (step === undefined) throw new Error('台本の応答が尽きました');
      if (step instanceof GoogleTransportFailure) return Promise.reject(step);
      return Promise.resolve(step);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    now: () => NOW,
  });
  const urls = () => requests.map((request) => new URL(request.url));
  return { connector, requests, sleeps, urls, remaining: () => steps.length };
}

function assertNoToken(error: unknown): void {
  assert.ok(error instanceof Error);
  assert.ok(!error.message.includes(TOKEN));
  assert.ok(!String(error).includes(TOKEN));
  assert.ok(!(error.stack ?? '').includes(TOKEN));
}

const WINDOW = {
  calendarId: 'primary',
  timeMin: '2026-11-01T00:00:00+09:00',
  timeMax: '2026-12-01T00:00:00+09:00',
};

test('Calendar: 空のページを挟む 3 ページを最後まで読み、順に連結する', async () => {
  const { connector, urls, requests } = setup([
    json({
      items: [
        {
          id: 'ev-1',
          status: 'confirmed',
          summary: '合成の予定 1',
          start: { dateTime: '2026-11-03T10:00:00+09:00' },
          end: { dateTime: '2026-11-03T11:00:00+09:00' },
          unknownField: 'drop-me',
        },
      ],
      nextPageToken: 'p2',
    }),
    json({ items: [], nextPageToken: 'p3' }),
    json({
      items: [
        {
          id: 'ev-2',
          status: 'confirmed',
          etag: '"e2"',
          start: { date: '2026-11-10' },
          end: { date: '2026-11-11' },
          recurringEventId: 'series-1',
          originalStartTime: { date: '2026-11-10' },
          sequence: 2,
        },
      ],
    }),
  ]);

  const events = await connector.calendar.listEvents(WINDOW);

  assert.deepEqual(events, [
    {
      id: 'ev-1',
      status: 'confirmed',
      summary: '合成の予定 1',
      start: { dateTime: '2026-11-03T10:00:00+09:00' },
      end: { dateTime: '2026-11-03T11:00:00+09:00' },
    },
    {
      id: 'ev-2',
      status: 'confirmed',
      etag: '"e2"',
      start: { date: '2026-11-10' },
      end: { date: '2026-11-11' },
      recurringEventId: 'series-1',
      originalStartTime: { date: '2026-11-10' },
      sequence: 2,
    },
  ]);
  const [first, second, third] = urls();
  assert.equal(requests.length, 3);
  assert.equal(first?.origin, 'https://www.googleapis.com');
  assert.equal(first?.pathname, '/calendar/v3/calendars/primary/events');
  assert.equal(first?.searchParams.get('singleEvents'), 'true');
  assert.equal(first?.searchParams.get('showDeleted'), 'true');
  assert.equal(first?.searchParams.get('timeMin'), '2026-11-01T00:00:00+09:00');
  assert.equal(first?.searchParams.get('timeMax'), '2026-12-01T00:00:00+09:00');
  assert.equal(first?.searchParams.get('maxResults'), '250');
  assert.equal(first?.searchParams.has('pageToken'), false);
  assert.equal(first?.searchParams.has('updatedMin'), false);
  assert.equal(first?.searchParams.has('syncToken'), false);
  assert.equal(second?.searchParams.get('pageToken'), 'p2');
  assert.equal(third?.searchParams.get('pageToken'), 'p3');
  // 窓は全ページで呼び出し側の値のまま。
  assert.equal(third?.searchParams.get('timeMin'), '2026-11-01T00:00:00+09:00');
  assert.equal(third?.searchParams.get('timeMax'), '2026-12-01T00:00:00+09:00');
});

test('Calendar: updatedMin を伝え、取消の予定は status=cancelled のまま返す', async () => {
  const { connector, urls } = setup([
    json({
      items: [{ id: 'ev-9', status: 'cancelled' }],
    }),
  ]);

  const events = await connector.calendar.listEvents({
    ...WINDOW,
    calendarId: 'team@example.invalid',
    updatedMin: '2026-11-21T23:55:00Z',
  });

  assert.deepEqual(events, [{ id: 'ev-9', status: 'cancelled' }]);
  const [first] = urls();
  assert.equal(first?.searchParams.get('updatedMin'), '2026-11-21T23:55:00Z');
  assert.equal(
    first?.pathname,
    '/calendar/v3/calendars/team%40example.invalid/events',
  );
});

test('Gmail listMessageIds: 2 ページを読み切り、labelIds を繰り返し、q を after: にする', async () => {
  const { connector, urls } = setup([
    json({
      messages: [
        { id: 'm1', threadId: 't1' },
        { id: 'm2', threadId: 't1' },
      ],
      nextPageToken: 'n2',
      resultSizeEstimate: 3,
    }),
    json({ messages: [{ id: 'm3', threadId: 't3' }] }),
  ]);

  const refs = await connector.gmail.listMessageIds({
    labelIds: ['INBOX', 'Label_7'],
    afterEpochSeconds: 1700000000,
  });

  assert.deepEqual(refs, [
    { id: 'm1', threadId: 't1' },
    { id: 'm2', threadId: 't1' },
    { id: 'm3', threadId: 't3' },
  ]);
  const [first, second] = urls();
  assert.equal(first?.pathname, '/gmail/v1/users/me/messages');
  assert.deepEqual(first?.searchParams.getAll('labelIds'), [
    'INBOX',
    'Label_7',
  ]);
  assert.equal(first?.searchParams.get('q'), 'after:1700000000');
  assert.equal(first?.searchParams.get('maxResults'), '500');
  assert.equal(first?.searchParams.has('pageToken'), false);
  assert.equal(second?.searchParams.get('pageToken'), 'n2');
  assert.deepEqual(second?.searchParams.getAll('labelIds'), [
    'INBOX',
    'Label_7',
  ]);
});

test('Gmail getMessage（metadata）: headers と payload の木を正規化する', async () => {
  const { connector, urls } = setup([
    json({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: '合成の本文の冒頭',
      historyId: '9001',
      internalDate: '1700000123000',
      sizeEstimate: 4321,
      payload: {
        partId: '',
        mimeType: 'multipart/mixed',
        filename: '',
        headers: [
          { name: 'Subject', value: '合成の件名' },
          { name: 'From', value: 'sender@example.invalid' },
        ],
        body: { size: 0 },
        parts: [
          {
            partId: '0',
            mimeType: 'text/plain',
            filename: '',
            headers: [{ name: 'Content-Type', value: 'text/plain' }],
            body: { size: 12, data: 'U1lOVEhFVElD' },
          },
          {
            partId: '1',
            mimeType: 'application/pdf',
            filename: 'synthetic.pdf',
            headers: [],
            body: { size: 2048, attachmentId: 'att-1' },
          },
        ],
      },
    }),
  ]);

  const message = await connector.gmail.getMessage({
    id: 'm1',
    format: 'metadata',
  });

  assert.deepEqual(message, {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: '合成の本文の冒頭',
    historyId: '9001',
    internalDate: '1700000123000',
    sizeEstimate: 4321,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [
        { name: 'Subject', value: '合成の件名' },
        { name: 'From', value: 'sender@example.invalid' },
      ],
      bodySize: 0,
      parts: [
        {
          partId: '0',
          mimeType: 'text/plain',
          filename: '',
          headers: [{ name: 'Content-Type', value: 'text/plain' }],
          bodySize: 12,
          bodyData: 'U1lOVEhFVElD',
          parts: [],
        },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'synthetic.pdf',
          headers: [],
          bodySize: 2048,
          bodyAttachmentId: 'att-1',
          parts: [],
        },
      ],
    },
  });
  const [first] = urls();
  assert.equal(first?.pathname, '/gmail/v1/users/me/messages/m1');
  assert.equal(first?.searchParams.get('format'), 'metadata');
});

test('Gmail listHistory: 4 種の変更を正規化し、全ページを追い、最後の historyId を返す', async () => {
  const { connector, urls } = setup([
    json({
      history: [
        {
          id: '101',
          messages: [{ id: 'm5' }],
          messagesAdded: [
            { message: { id: 'm5', threadId: 't5', labelIds: ['INBOX'] } },
          ],
        },
        {
          id: '102',
          messagesDeleted: [{ message: { id: 'm2' } }],
        },
      ],
      historyId: '150',
      nextPageToken: 'h2',
    }),
    json({ history: [], historyId: '160', nextPageToken: 'h3' }),
    json({
      history: [
        {
          id: '103',
          labelsAdded: [
            { message: { id: 'm5' }, labelIds: ['STARRED', 'Label_7'] },
          ],
          labelsRemoved: [{ message: { id: 'm1' }, labelIds: ['UNREAD'] }],
        },
      ],
      historyId: '170',
    }),
  ]);

  const result = await connector.gmail.listHistory({
    startHistoryId: '100',
    labelId: 'INBOX',
  });

  assert.deepEqual(result, {
    historyId: '170',
    entries: [
      {
        id: '101',
        addedMessageIds: ['m5'],
        deletedMessageIds: [],
        labelsAdded: [],
        labelsRemoved: [],
      },
      {
        id: '102',
        addedMessageIds: [],
        deletedMessageIds: ['m2'],
        labelsAdded: [],
        labelsRemoved: [],
      },
      {
        id: '103',
        addedMessageIds: [],
        deletedMessageIds: [],
        labelsAdded: [{ messageId: 'm5', labelIds: ['STARRED', 'Label_7'] }],
        labelsRemoved: [{ messageId: 'm1', labelIds: ['UNREAD'] }],
      },
    ],
  });
  const [first, second, third] = urls();
  assert.equal(first?.pathname, '/gmail/v1/users/me/history');
  assert.equal(first?.searchParams.get('startHistoryId'), '100');
  assert.deepEqual(first?.searchParams.getAll('historyTypes'), [
    'messageAdded',
    'messageDeleted',
    'labelAdded',
    'labelRemoved',
  ]);
  assert.equal(first?.searchParams.get('labelId'), 'INBOX');
  assert.equal(first?.searchParams.has('pageToken'), false);
  assert.equal(second?.searchParams.get('pageToken'), 'h2');
  assert.equal(third?.searchParams.get('pageToken'), 'h3');
  assert.equal(third?.searchParams.get('startHistoryId'), '100');
});

test('Gmail listHistory: 404 は期限切れの専用エラーにし、再試行しない', async () => {
  const { connector, requests, sleeps } = setup([status(404), json({})]);

  await assert.rejects(
    connector.gmail.listHistory({ startHistoryId: '1' }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleHistoryExpiredError);
      assertNoToken(error);
      return true;
    },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(sleeps, []);
});

test('ページング途中の失敗: 2 ページ目が 500 を 3 回返すと、部分結果を返さず失敗する', async () => {
  const { connector, requests, sleeps } = setup([
    json({ items: [{ id: 'ev-1', status: 'confirmed' }], nextPageToken: 'p2' }),
    status(500),
    status(500),
    status(500),
  ]);

  let caught: unknown;
  let result: unknown;
  try {
    result = await connector.calendar.listEvents(WINDOW);
  } catch (error) {
    caught = error;
  }
  assert.equal(result, undefined);
  assert.ok(caught instanceof GoogleApiError);
  assert.equal(caught.kind, 'http_error');
  assert.equal(caught.status, 500);
  assert.equal(caught.attempts, 3);
  assertNoToken(caught);
  assert.equal(requests.length, 4);
  assert.deepEqual(sleeps, [2000, 10000]);
  // 要求の authorization は合成トークンの Bearer。
  for (const request of requests) {
    assert.equal(request.headers['authorization'], `Bearer ${TOKEN}`);
    assert.equal(request.headers['accept'], 'application/json');
    assert.equal(request.timeoutMs, 15000);
  }
});

test('429 + Retry-After: 3 は 3 秒ちょうど待って再試行する（ジッターなし）', async () => {
  const { connector, requests, sleeps } = setup([
    status(429, { 'retry-after': '3' }),
    json({ items: [{ id: 'ev-1', status: 'confirmed' }] }),
  ]);

  const events = await connector.calendar.listEvents(WINDOW);

  assert.deepEqual(events, [{ id: 'ev-1', status: 'confirmed' }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(sleeps, [3000]);
});

test('503 + Retry-After（HTTP 日付）は now との差だけ待つ', async () => {
  const { connector, sleeps } = setup([
    status(503, { 'retry-after': 'Sun, 22 Nov 2026 00:00:05 GMT' }),
    json({ items: [] }),
  ]);

  assert.deepEqual(await connector.calendar.listEvents(WINDOW), []);
  assert.deepEqual(sleeps, [5000]);
});

test('500, 500, 200: 基本待機 2 秒・10 秒（random=0.5 で係数 1.0）で成功する', async () => {
  const { connector, requests, sleeps } = setup([
    status(500),
    status(500),
    json({ messages: [{ id: 'm1' }] }),
  ]);

  const refs = await connector.gmail.listMessageIds({
    labelIds: ['INBOX'],
    afterEpochSeconds: 1700000000,
  });

  assert.deepEqual(refs, [{ id: 'm1' }]);
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [2000, 10000]);
});

test('429 + Retry-After: 200 は待機上限 120 秒を超えるので待たずに失敗する', async () => {
  const { connector, requests, sleeps } = setup([
    status(429, { 'retry-after': '200' }),
    json({ items: [] }),
  ]);

  await assert.rejects(
    connector.calendar.listEvents(WINDOW),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, 'wait_limit_exceeded');
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(sleeps, []);
});

test('403 は再試行せず即座に失敗する', async () => {
  const { connector, requests, sleeps } = setup([status(403), json({})]);

  await assert.rejects(
    connector.gmail.getMessage({ id: 'm1', format: 'minimal' }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, 'http_error');
      assert.equal(error.status, 403);
      assert.equal(error.attempts, 1);
      assertNoToken(error);
      assert.equal(
        error.message,
        'Google API の読み取りに失敗しました（種別: http_error, 状態: 403）',
      );
      return true;
    },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(requests[0]?.headers['authorization'], `Bearer ${TOKEN}`);
});

test('通信の失敗（no_response）は再試行し、2 回の後に成功する', async () => {
  const { connector, requests, sleeps } = setup([
    new GoogleTransportFailure('no_response'),
    new GoogleTransportFailure('no_response'),
    json({ id: 'm1', labelIds: [] }),
  ]);

  const message = await connector.gmail.getMessage({
    id: 'm1',
    format: 'minimal',
  });

  assert.deepEqual(message, { id: 'm1', labelIds: [] });
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [2000, 10000]);
});

test('通信の失敗（no_response）が 3 回続くと kind=no_response・attempts=3 で失敗する', async () => {
  const { connector, requests } = setup([
    new GoogleTransportFailure('no_response'),
    new GoogleTransportFailure('no_response'),
    new GoogleTransportFailure('no_response'),
  ]);

  await assert.rejects(
    connector.gmail.getMessage({ id: 'm1', format: 'minimal' }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, 'no_response');
      assert.equal(error.attempts, 3);
      assert.equal(error.status, undefined);
      assertNoToken(error);
      return true;
    },
  );
  assert.equal(requests.length, 3);
});

test('200 でも JSON として読めない応答は invalid_response で、再試行しない', async () => {
  const { connector, requests } = setup([
    { status: 200, headers: {}, bodyText: 'not-json' },
    json({ items: [] }),
  ]);

  await assert.rejects(
    connector.calendar.listEvents(WINDOW),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, 'invalid_response');
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test('Calendar: items が配列でない・id が無い応答は invalid_response', async () => {
  const missingItems = setup([json({ nextPageToken: 'x' })]);
  await assert.rejects(
    missingItems.connector.calendar.listEvents(WINDOW),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === 'invalid_response',
  );
  const missingId = setup([json({ items: [{ status: 'confirmed' }] })]);
  await assert.rejects(
    missingId.connector.calendar.listEvents(WINDOW),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === 'invalid_response',
  );
});

test('能力: 読み取りだけを宣言し、規則に合う', () => {
  assert.deepEqual(checkConnectorCapability(GOOGLE_READ_CAPABILITY), []);
  assert.equal(GOOGLE_READ_CAPABILITY.provider, 'google');
  assert.deepEqual(GOOGLE_READ_CAPABILITY.writes, []);
  assert.deepEqual(GOOGLE_READ_CAPABILITY.reads, [
    { kind: 'mail.message', effect_kind: 'Read' },
    { kind: 'calendar.events', effect_kind: 'Read' },
  ]);
  const { connector } = setup([]);
  assert.equal(connector.capability, GOOGLE_READ_CAPABILITY);
});

test('Calendar listEventsPage: pageToken を伝え、1 ページだけ読んで nextPageToken を返す', async () => {
  const { connector, urls, requests } = setup([
    json({
      items: [
        {
          id: 'ev-1',
          status: 'confirmed',
          summary: '合成の予定 1',
          start: { dateTime: '2026-11-03T10:00:00+09:00' },
          end: { dateTime: '2026-11-03T11:00:00+09:00' },
        },
      ],
      nextPageToken: 'p-next',
    }),
    // 2 ページ目以降は読まないので、台本に置いても消費されない。
    json({ items: [{ id: 'ev-2', status: 'confirmed' }] }),
  ]);

  const page = await connector.calendar.listEventsPage({
    ...WINDOW,
    pageToken: 'cursor-1',
  });

  assert.deepEqual(page, {
    items: [
      {
        id: 'ev-1',
        status: 'confirmed',
        summary: '合成の予定 1',
        start: { dateTime: '2026-11-03T10:00:00+09:00' },
        end: { dateTime: '2026-11-03T11:00:00+09:00' },
      },
    ],
    nextPageToken: 'p-next',
  });
  // ページ版は次ページを自動で追わない（要求は 1 回だけ）。
  assert.equal(requests.length, 1);
  const [first] = urls();
  assert.equal(first?.pathname, '/calendar/v3/calendars/primary/events');
  assert.equal(first?.searchParams.get('pageToken'), 'cursor-1');
  assert.equal(first?.searchParams.get('timeMin'), '2026-11-01T00:00:00+09:00');
  assert.equal(first?.searchParams.get('timeMax'), '2026-12-01T00:00:00+09:00');
  assert.equal(first?.searchParams.get('maxResults'), '250');
});

test('Calendar listEventsPage: items が 0 件でも nextPageToken を返す', async () => {
  const { connector, requests } = setup([
    json({ items: [], nextPageToken: 'still-more' }),
  ]);

  const page = await connector.calendar.listEventsPage(WINDOW);

  assert.deepEqual(page, { items: [], nextPageToken: 'still-more' });
  assert.equal(requests.length, 1);
});

test('Calendar listEventsPage: 最終ページは nextPageToken を含まない', async () => {
  const { connector } = setup([
    json({ items: [{ id: 'ev-9', status: 'cancelled' }] }),
  ]);

  const page = await connector.calendar.listEventsPage({
    ...WINDOW,
    pageToken: 'last-cursor',
  });

  assert.deepEqual(page, { items: [{ id: 'ev-9', status: 'cancelled' }] });
});

test('Calendar listEventsPage: 空き時間・種類・本人の出欠だけを写し、ほかの参加者は写さない', async () => {
  const { connector } = setup([
    json({
      items: [
        {
          id: 'ev-1',
          status: 'confirmed',
          transparency: 'transparent',
          eventType: 'workingLocation',
          attendees: [
            { email: 'other@example.com', responseStatus: 'accepted' },
            {
              email: 'me@example.com',
              self: true,
              responseStatus: 'declined',
            },
          ],
        },
        // 本人が参加者に居ない予定は出欠を持たない。
        {
          id: 'ev-2',
          status: 'confirmed',
          attendees: [
            { email: 'other@example.com', responseStatus: 'accepted' },
          ],
        },
      ],
    }),
  ]);

  const page = await connector.calendar.listEventsPage(WINDOW);

  assert.deepEqual(page, {
    items: [
      {
        id: 'ev-1',
        status: 'confirmed',
        transparency: 'transparent',
        eventType: 'workingLocation',
        selfResponseStatus: 'declined',
      },
      { id: 'ev-2', status: 'confirmed' },
    ],
  });
});

test('Calendar listEventsPage: 参加者の一覧が配列でなければ不正な応答として拒む', async () => {
  const { connector } = setup([
    json({ items: [{ id: 'ev-1', status: 'confirmed', attendees: 'x' }] }),
  ]);

  await assert.rejects(connector.calendar.listEventsPage(WINDOW));
});

test('Gmail listMessageIdsPage: pageToken を伝え、1 ページだけ読んで nextPageToken を返す', async () => {
  const { connector, urls, requests } = setup([
    json({
      messages: [
        { id: 'm1', threadId: 't1' },
        { id: 'm2', threadId: 't1' },
      ],
      nextPageToken: 'n-next',
    }),
    json({ messages: [{ id: 'm3', threadId: 't3' }] }),
  ]);

  const page = await connector.gmail.listMessageIdsPage({
    labelIds: ['INBOX', 'Label_7'],
    afterEpochSeconds: 1700000000,
    pageToken: 'cursor-9',
  });

  assert.deepEqual(page, {
    items: [
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't1' },
    ],
    nextPageToken: 'n-next',
  });
  assert.equal(requests.length, 1);
  const [first] = urls();
  assert.equal(first?.pathname, '/gmail/v1/users/me/messages');
  assert.equal(first?.searchParams.get('pageToken'), 'cursor-9');
  assert.deepEqual(first?.searchParams.getAll('labelIds'), [
    'INBOX',
    'Label_7',
  ]);
  assert.equal(first?.searchParams.get('q'), 'after:1700000000');
  assert.equal(first?.searchParams.get('maxResults'), '500');
});

test('Gmail listMessageIdsPage: messages が省略された 0 件でも nextPageToken を返す', async () => {
  const { connector, requests } = setup([json({ nextPageToken: 'n-more' })]);

  const page = await connector.gmail.listMessageIdsPage({
    labelIds: ['INBOX'],
    afterEpochSeconds: 1700000000,
  });

  assert.deepEqual(page, { items: [], nextPageToken: 'n-more' });
  assert.equal(requests.length, 1);
});

test('Gmail listHistoryPage: そのページの historyId と nextPageToken を返し、pageToken を伝える', async () => {
  const { connector, urls, requests } = setup([
    json({
      history: [
        {
          id: '101',
          messagesAdded: [{ message: { id: 'm5', threadId: 't5' } }],
        },
      ],
      historyId: '150',
      nextPageToken: 'h-next',
    }),
    json({ history: [], historyId: '160' }),
  ]);

  const page = await connector.gmail.listHistoryPage({
    startHistoryId: '100',
    labelId: 'INBOX',
    pageToken: 'h-cursor',
  });

  assert.deepEqual(page, {
    items: [
      {
        id: '101',
        addedMessageIds: ['m5'],
        deletedMessageIds: [],
        labelsAdded: [],
        labelsRemoved: [],
      },
    ],
    nextPageToken: 'h-next',
    historyId: '150',
  });
  assert.equal(requests.length, 1);
  const [first] = urls();
  assert.equal(first?.pathname, '/gmail/v1/users/me/history');
  assert.equal(first?.searchParams.get('pageToken'), 'h-cursor');
  assert.equal(first?.searchParams.get('startHistoryId'), '100');
  assert.equal(first?.searchParams.get('labelId'), 'INBOX');
});

test('Gmail listHistoryPage: history が 0 件でもそのページの historyId を返す', async () => {
  const { connector } = setup([json({ historyId: '160' })]);

  const page = await connector.gmail.listHistoryPage({
    startHistoryId: '100',
  });

  assert.deepEqual(page, { items: [], historyId: '160' });
});

test('Gmail listHistoryPage: 404 は期限切れの専用エラーにする', async () => {
  const { connector, requests } = setup([status(404), json({})]);

  await assert.rejects(
    connector.gmail.listHistoryPage({ startHistoryId: '1' }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleHistoryExpiredError);
      assertNoToken(error);
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test('同じ nextPageToken が繰り返し返ると invalid_response で止まる', async () => {
  const { connector, requests } = setup([
    json({ items: [], nextPageToken: 'loop' }),
    json({ items: [], nextPageToken: 'loop' }),
    json({ items: [], nextPageToken: 'loop' }),
  ]);

  await assert.rejects(
    connector.calendar.listEvents(WINDOW),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, 'invalid_response');
      return true;
    },
  );
  assert.equal(requests.length, 2);
});

// ---- B08-04: 添付の取得（attachments.get）と添付パートの列挙 ----

test('Gmail 添付: attachments.get で取得し、base64url をバイト列へ戻す', async () => {
  // "%PDF" の 4 バイト（base64url では JVBERg）。
  const { connector, urls, requests } = setup([
    json({ size: 4, data: 'JVBERg' }),
  ]);

  const attachment = await connector.gmail.getAttachment({
    messageId: 'msg-1',
    attachmentId: 'att-1',
  });

  assert.equal(attachment.size, 4);
  assert.deepEqual([...attachment.data], [0x25, 0x50, 0x44, 0x46]);
  assert.equal(requests.length, 1);
  assert.equal(
    urls()[0]?.pathname,
    '/gmail/v1/users/me/messages/msg-1/attachments/att-1',
  );
});

test('Gmail 添付: 申告サイズと実際のバイト数が違う応答は invalid_response', async () => {
  const { connector } = setup([json({ size: 5, data: 'JVBERg' })]);

  await assert.rejects(
    connector.gmail.getAttachment({ messageId: 'msg-1', attachmentId: 'a' }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, 'invalid_response');
      return true;
    },
  );
});

test('Gmail 添付: base64url でない data は invalid_response', async () => {
  // '+' を含む標準 base64 の形は受け付けない。
  const { connector } = setup([json({ size: 4, data: 'JVBE+g==' })]);

  await assert.rejects(
    connector.gmail.getAttachment({ messageId: 'msg-1', attachmentId: 'a' }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, 'invalid_response');
      return true;
    },
  );
});

test('Gmail 添付: data が無い・size が負の応答は invalid_response', async () => {
  const noData = setup([json({ size: 4 })]);
  await assert.rejects(
    noData.connector.gmail.getAttachment({
      messageId: 'msg-1',
      attachmentId: 'a',
    }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === 'invalid_response',
  );

  const badSize = setup([json({ size: -1, data: 'JVBERg' })]);
  await assert.rejects(
    badSize.connector.gmail.getAttachment({
      messageId: 'msg-1',
      attachmentId: 'a',
    }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === 'invalid_response',
  );
});

test('添付パートの列挙: ファイル名のあるパートだけを出現順に拾い、添付メールの内側はたどらない', () => {
  const payload: GoogleGmailPart = {
    mimeType: 'multipart/mixed',
    headers: [],
    bodySize: 0,
    parts: [
      {
        partId: '0',
        mimeType: 'text/plain',
        headers: [],
        bodySize: 12,
        bodyData: 'aGVsbG8gdGV4dA',
        parts: [],
      },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'doc.pdf',
        headers: [{ name: 'Content-Type', value: 'application/pdf' }],
        bodySize: 123,
        bodyAttachmentId: 'ATT-1',
        parts: [],
      },
      {
        partId: '2',
        mimeType: 'message/rfc822',
        filename: 'forwarded.eml',
        headers: [],
        bodySize: 999,
        bodyAttachmentId: 'ATT-2',
        parts: [
          {
            partId: '2.1',
            mimeType: 'application/pdf',
            filename: 'inner.pdf',
            headers: [],
            bodySize: 5,
            bodyAttachmentId: 'ATT-INNER',
            parts: [],
          },
        ],
      },
      {
        partId: '3',
        mimeType: 'text/csv',
        filename: 'data.csv',
        headers: [
          { name: 'Content-Type', value: 'text/csv; charset=shift_jis' },
        ],
        bodySize: 7,
        bodyData: 'YSxiCjEsMg',
        parts: [],
      },
    ],
  };

  const parts = listAttachmentParts(payload);

  assert.deepEqual(parts, [
    {
      partId: '1',
      attachmentId: 'ATT-1',
      inlineData: null,
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 123,
      contentType: 'application/pdf',
    },
    {
      partId: '2',
      attachmentId: 'ATT-2',
      inlineData: null,
      filename: 'forwarded.eml',
      mimeType: 'message/rfc822',
      sizeBytes: 999,
      contentType: null,
    },
    {
      partId: '3',
      attachmentId: null,
      inlineData: 'YSxiCjEsMg',
      filename: 'data.csv',
      mimeType: 'text/csv',
      sizeBytes: 7,
      contentType: 'text/csv; charset=shift_jis',
    },
  ]);
});

test('添付パートの列挙: 添付が無い payload では空になる', () => {
  const parts = listAttachmentParts({
    mimeType: 'text/plain',
    headers: [],
    bodySize: 3,
    bodyData: 'aGk',
    parts: [],
  });
  assert.deepEqual(parts, []);
});

// --- 取得対象の発見（ADR 0145） ---

test('Calendar listCalendars: 2 ページを読み切り、最小の fields で求め、表示名の元と primary を写す', async () => {
  const { connector, urls } = setup([
    json({
      items: [
        {
          id: 'primary-cal@example.invalid',
          summary: '合成のメイン',
          primary: true,
          accessRole: 'owner',
          colorId: '7',
        },
        {
          id: 'team-cal@example.invalid',
          summary: '合成のチーム',
          summaryOverride: '本人が付けた名前',
        },
      ],
      nextPageToken: 'cal-page-2',
    }),
    json({ items: [{ id: 'nameless@example.invalid', primary: false }] }),
  ]);
  assert.deepEqual(await connector.calendar.listCalendars(), [
    {
      id: 'primary-cal@example.invalid',
      summary: '合成のメイン',
      primary: true,
      accessRole: 'owner',
    },
    {
      id: 'team-cal@example.invalid',
      summary: '合成のチーム',
      summaryOverride: '本人が付けた名前',
      primary: false,
    },
    { id: 'nameless@example.invalid', primary: false },
  ]);
  const [first, second] = urls();
  assert.equal(first?.pathname, '/calendar/v3/users/me/calendarList');
  assert.equal(first?.searchParams.get('maxResults'), '250');
  assert.equal(
    first?.searchParams.get('fields'),
    'items(id,summary,summaryOverride,primary,accessRole),nextPageToken',
  );
  assert.equal(first?.searchParams.get('pageToken'), null);
  assert.equal(second?.searchParams.get('pageToken'), 'cal-page-2');
});

test('Calendar listCalendars: items の省略は空、id の無い項目・型の違う primary は invalid_response', async () => {
  assert.deepEqual(
    await setup([json({})]).connector.calendar.listCalendars(),
    [],
  );
  for (const body of [
    { items: [{ summary: 'id なし' }] },
    { items: [{ id: 'x', primary: 'yes' }] },
    { items: 'not-array' },
  ]) {
    await assert.rejects(
      setup([json(body)]).connector.calendar.listCalendars(),
      (error: unknown) =>
        error instanceof GoogleApiError && error.kind === 'invalid_response',
    );
  }
});

test('Calendar listCalendars: 403 は再試行せず http_error で失敗し、トークンを漏らさない', async () => {
  const { connector, requests } = setup([status(403)]);
  await assert.rejects(connector.calendar.listCalendars(), (error: unknown) => {
    assertNoToken(error);
    return (
      error instanceof GoogleApiError &&
      error.kind === 'http_error' &&
      error.status === 403
    );
  });
  assert.equal(requests.length, 1);
});

test('Gmail listLabels: 種別を写し、未知の種別は null にし、最小の fields で 1 回だけ読む', async () => {
  const { connector, urls } = setup([
    json({
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 3 },
        { id: 'Label_1', name: '合成のラベル', type: 'user' },
        { id: 'Label_2', name: '種別なし' },
        { id: 'Label_3', name: '未知の種別', type: 'other' },
      ],
    }),
  ]);
  assert.deepEqual(await connector.gmail.listLabels(), [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'Label_1', name: '合成のラベル', type: 'user' },
    { id: 'Label_2', name: '種別なし', type: null },
    { id: 'Label_3', name: '未知の種別', type: null },
  ]);
  const [only] = urls();
  assert.equal(only?.pathname, '/gmail/v1/users/me/labels');
  assert.equal(only?.searchParams.get('fields'), 'labels(id,name,type)');
  assert.equal(urls().length, 1);
});

test('Gmail listLabels: labels の省略は空、id・name の無い項目は invalid_response', async () => {
  assert.deepEqual(await setup([json({})]).connector.gmail.listLabels(), []);
  for (const body of [
    { labels: [{ name: 'id なし' }] },
    { labels: [{ id: 'Label_9' }] },
    { labels: {} },
  ]) {
    await assert.rejects(
      setup([json(body)]).connector.gmail.listLabels(),
      (error: unknown) =>
        error instanceof GoogleApiError && error.kind === 'invalid_response',
    );
  }
});
