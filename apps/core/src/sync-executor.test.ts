// 同期の走査の実行器（B08-05、ADR 0136）の試験。DB は実際の worker（startCore の保存層）を使い、
// connector は台本で応答する偽物にする。期待値は設計 11 §1・§1A から手で書いた値で、実装から生成しない。
// 実 API・実アカウント・実トークンは使わない（トークンは合成値）。

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { GoogleApiError, GoogleHistoryExpiredError } from '@buddy/connectors';
import type {
  GoogleCalendarEvent,
  GoogleGmailMessage,
  GoogleGmailMessageFormat,
  GoogleHistoryEntry,
  GooglePage,
  GoogleReadConnector,
  ListCalendarEventsRequest,
} from '@buddy/connectors';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import type { DbWorkerClient } from '@buddy/storage';
import { startEventCore } from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { DB_FILE } from './paths.js';
import { createSyncExecutor } from './sync-executor.js';
import type { SyncExecutorOptions } from './sync-executor.js';

const CONN = 'conn-1';
const ACCOUNT = 'acct-1';
const SCOPE_CAL = 'scope-cal';
const SCOPE_MAIL = 'scope-mail';

const TARGETS = JSON.stringify({
  calendar_ids: ['cal-1'],
  mail_container_ids: ['INBOX'],
  attachment_kinds: ['pdf'],
  mail_lookback_days: 90,
  calendar_past_days: 30,
  calendar_future_days: 90,
  attachment_max_bytes: 10000000,
});

interface Harness {
  readonly core: EventCore;
  readonly store: DbWorkerClient;
  sql<T>(body: (db: ReturnType<typeof openWriteConnection>) => T): T;
}

async function start(t: test.TestContext): Promise<Harness> {
  const core = await startEventCore(t);
  // 起動直後の保存期限の掃除（非同期）が済むまで待つ。待たないと、掃除の読み取りが後から入れる種の行
  // （fetched_at が 1970 年の公開済み行は 24 時間の期限切れ）を消し、差分が 0 件になることがある。
  await core.handle.retention.idle();
  const sql = <T>(
    body: (db: ReturnType<typeof openWriteConnection>) => T,
  ): T => {
    const db = openWriteConnection(join(core.dataDir, DB_FILE), {
      platform: storagePlatform(),
    });
    try {
      return body(db);
    } finally {
      db.close();
    }
  };
  sql((db) => {
    db.exec(
      `INSERT INTO connections VALUES ('${CONN}', 'google', NULL, 'keystore:synthetic', 'active', 'read', '[]', '${TARGETS}', 1, 1)`,
    );
    db.exec(
      `INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation, committed_watermark, provider_cursor, executor_generation, last_incremental_completed_at, last_full_reconciled_at, pending_incremental, pending_full, analysis_plan_complete_generation)
       VALUES ('${SCOPE_CAL}', '${CONN}', 1, NULL, 0, NULL, NULL, 1, NULL, NULL, 0, 0, NULL)`,
    );
    db.exec(
      `INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation, committed_watermark, provider_cursor, executor_generation, last_incremental_completed_at, last_full_reconciled_at, pending_incremental, pending_full, analysis_plan_complete_generation)
       VALUES ('${SCOPE_MAIL}', '${CONN}', 1, NULL, 0, NULL, NULL, 1, NULL, NULL, 0, 0, NULL)`,
    );
  });
  return { core, store: core.handle.store, sql };
}

// 台本で応答する偽の connector。ページは呼出し順に消費し、要求（窓・updatedMin・ページトークン）を記録する。
class FakeConnector {
  readonly calendarRequests: {
    updatedMin: string | undefined;
    pageToken: string | undefined;
  }[] = [];
  readonly mailListRequests: { pageToken: string | undefined }[] = [];
  readonly historyRequests: {
    startHistoryId: string;
    pageToken: string | undefined;
  }[] = [];
  readonly getMessageIds: string[] = [];
  calendarPages: (GooglePage<GoogleCalendarEvent> | Error)[] = [];
  mailPages: (GooglePage<{ id: string; threadId?: string }> | Error)[] = [];
  historyPages: (GooglePage<GoogleHistoryEntry> & { historyId: string })[] = [];
  historyError: Error | null = null;
  messages = new Map<string, GoogleGmailMessage>();
  onCalendarPage: ((index: number) => Promise<void>) | null = null;

  build(): GoogleReadConnector {
    return buildFakeConnector(this);
  }
}

function buildFakeConnector(fake: FakeConnector): GoogleReadConnector {
  return {
    capability: {
      provider: 'google',
      reads: [
        { kind: 'mail.message', effect_kind: 'Read' },
        { kind: 'calendar.events', effect_kind: 'Read' },
      ],
      writes: [],
    },
    calendar: {
      async listEvents() {
        throw new Error('unused');
      },
      async listEventsPage(
        request: ListCalendarEventsRequest & { pageToken?: string },
      ) {
        fake.calendarRequests.push({
          updatedMin: request.updatedMin,
          pageToken: request.pageToken,
        });
        await fake.onCalendarPage?.(fake.calendarRequests.length - 1);
        const page = fake.calendarPages.shift();
        if (page === undefined) return { items: [] };
        if (page instanceof Error) throw page;
        return page;
      },
    },
    gmail: {
      async listMessageIds() {
        throw new Error('unused');
      },
      async listMessageIdsPage(request: {
        labelIds: readonly string[];
        afterEpochSeconds: number;
        pageToken?: string;
      }) {
        fake.mailListRequests.push({ pageToken: request.pageToken });
        const page = fake.mailPages.shift();
        if (page === undefined) return { items: [] };
        if (page instanceof Error) throw page;
        return page;
      },
      async getMessage(request: {
        id: string;
        format: GoogleGmailMessageFormat;
      }) {
        fake.getMessageIds.push(request.id);
        const message = fake.messages.get(request.id);
        if (message === undefined)
          throw new GoogleApiError('http_error', 1, 404);
        return message;
      },
      async listHistory() {
        throw new Error('unused');
      },
      async listHistoryPage(request: {
        startHistoryId: string;
        labelId?: string;
        pageToken?: string;
      }) {
        fake.historyRequests.push({
          startHistoryId: request.startHistoryId,
          pageToken: request.pageToken,
        });
        if (fake.historyError !== null) throw fake.historyError;
        const page = fake.historyPages.shift();
        if (page === undefined)
          return { items: [], historyId: request.startHistoryId };
        return page;
      },
    },
  } as unknown as GoogleReadConnector;
}

let scanSequence = 0;

function buildExecutor(
  h: Harness,
  fake: FakeConnector,
  over: Partial<SyncExecutorOptions> = {},
): ReturnType<typeof createSyncExecutor> {
  let tick = 0;
  return createSyncExecutor({
    store: h.store,
    tokenSourceFor: () => ({
      getAccessToken: () => Promise.resolve('synthetic-token'),
    }),
    createConnector: () => fake.build(),
    now: () => new Date(Date.parse('2030-10-05T00:00:00Z') + tick++ * 60_000),
    newScanId: () => `scan-${++scanSequence}`,
    ...over,
  });
}

const publishedItems = async (
  h: Harness,
  scopeId: string,
): Promise<{ remote_id: string; source_revision: string }[]> => {
  const result = await h.store.sync({
    kind: 'sync.list_published',
    scope_id: scopeId,
    provider: 'google',
    account_id: ACCOUNT,
  });
  assert(result.ok);
  return [...result.value];
};

const event = (
  id: string,
  etag: string,
  status = 'confirmed',
): GoogleCalendarEvent => ({ id, status, etag });

test('calendar full scan stages page by page and publishes only the diff', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.calendarPages = [
    {
      items: [event('e1', 'v1'), event('e2', 'v1')],
      nextPageToken: 'p2',
    },
    { items: [event('e3', 'v1', 'cancelled')] },
  ];
  const executor = buildExecutor(h, fake);
  const outcome = await executor.runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'full',
  });
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  // 新規 2 件が差分（取消は未公開なので差分にならない）。世代は 1 に進み、watermark は走査開始時刻。
  assert.equal(outcome.diff_count, 2);
  assert.equal(outcome.resumed, false);
  assert.equal(outcome.scope.active_generation, '1');
  assert.equal(outcome.scope.committed_watermark, '2030-10-05T00:00:00.000Z');
  assert.equal(outcome.scope.last_full_reconciled_at !== null, true);
  // 公開の結果に走査の種類と窓の終わり（開始の 90 日後）を添える（ADR 0194）。
  assert.equal(outcome.kind, 'full');
  assert.equal(outcome.window_end, '2031-01-03T00:00:00.000Z');
  assert.deepEqual(await publishedItems(h, SCOPE_CAL), [
    { remote_id: 'e1', source_revision: 'v1' },
    { remote_id: 'e2', source_revision: 'v1' },
  ]);

  // 2 回目の全量: e1 は版変更、e2 は不在（削除）、e4 が新規。差分は 3。
  const fake2 = new FakeConnector();
  fake2.calendarPages = [{ items: [event('e1', 'v2'), event('e4', 'v1')] }];
  const outcome2 = await buildExecutor(h, fake2).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'full',
  });
  assert.equal(outcome2.status, 'published', JSON.stringify(outcome2));
  if (outcome2.status !== 'published') return;
  assert.equal(outcome2.diff_count, 3);
  assert.equal(outcome2.scope.active_generation, '2');
  assert.deepEqual(await publishedItems(h, SCOPE_CAL), [
    { remote_id: 'e1', source_revision: 'v2' },
    { remote_id: 'e4', source_revision: 'v1' },
  ]);
});

test('calendar incremental reads from five minutes before the watermark and keeps the generation when nothing changed', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.calendarPages = [{ items: [event('e1', 'v1')] }];
  const first = await buildExecutor(h, fake).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'full',
  });
  assert.equal(first.status, 'published');

  const fake2 = new FakeConnector();
  fake2.calendarPages = [{ items: [event('e1', 'v1')] }];
  const outcome = await buildExecutor(h, fake2).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'incremental',
  });
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  // updatedMin は watermark（1 回目の開始時刻 00:00）の 5 分前。
  assert.equal(
    fake2.calendarRequests[0]?.updatedMin,
    '2030-10-04T23:55:00.000Z',
  );
  assert.equal(outcome.diff_count, 0);
  assert.equal(outcome.scope.active_generation, '1');
  assert.equal(outcome.scope.last_incremental_completed_at !== null, true);
});

test('mail full scan fetches metadata only for new messages and advances the history cursor', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.mailPages = [{ items: [{ id: 'm1' }, { id: 'm2' }] }];
  fake.messages.set('m1', {
    id: 'm1',
    labelIds: ['INBOX'],
    historyId: '150',
    internalDate: String(Date.parse('2030-10-04T00:00:00Z')),
  });
  fake.messages.set('m2', {
    id: 'm2',
    labelIds: ['INBOX'],
    historyId: '140',
    internalDate: String(Date.parse('2030-10-04T00:00:00Z')),
  });
  const outcome = await buildExecutor(h, fake).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_MAIL,
    resource: 'mail',
    kind: 'full',
  });
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  assert.equal(outcome.diff_count, 2);
  // provider cursor は見た historyId の最大値。
  assert.equal(outcome.scope.provider_cursor, '150');
  assert.deepEqual(fake.getMessageIds.sort(), ['m1', 'm2']);

  // 2 回目: 既知の m1 は取得し直さず、新しい m3 だけ取得する。
  const fake2 = new FakeConnector();
  fake2.mailPages = [{ items: [{ id: 'm1' }, { id: 'm3' }] }];
  fake2.messages.set('m3', {
    id: 'm3',
    labelIds: ['INBOX'],
    historyId: '160',
    internalDate: String(Date.parse('2030-10-04T12:00:00Z')),
  });
  const outcome2 = await buildExecutor(h, fake2).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_MAIL,
    resource: 'mail',
    kind: 'full',
  });
  assert.equal(outcome2.status, 'published', JSON.stringify(outcome2));
  if (outcome2.status !== 'published') return;
  assert.deepEqual(fake2.getMessageIds, ['m3']);
  // m2 は全量で見なかったので不在として消える。差分は m3 の新規と m2 の削除で 2。
  assert.equal(outcome2.diff_count, 2);
  assert.equal(outcome2.scope.provider_cursor, '160');
});

test('mail incremental applies history changes and moves the cursor to the history result', async (t) => {
  const h = await start(t);
  // 公開済みの土台（m1・m2）と cursor 100 を直接用意する。
  h.sql((db) => {
    db.exec(
      `INSERT INTO source_items VALUES ('google', '${ACCOUNT}', 'm1', '100', '${SCOPE_MAIL}', 0, 1000, NULL)`,
    );
    db.exec(
      `INSERT INTO source_items VALUES ('google', '${ACCOUNT}', 'm2', '100', '${SCOPE_MAIL}', 0, 1000, NULL)`,
    );
    db.exec(
      `UPDATE sync_scopes SET provider_cursor = '100', committed_watermark = ${Date.parse('2030-10-04T00:00:00Z')} WHERE scope_id = '${SCOPE_MAIL}'`,
    );
  });
  const fake = new FakeConnector();
  fake.historyPages = [
    {
      items: [
        {
          id: '900',
          addedMessageIds: ['m3'],
          deletedMessageIds: ['m2'],
          labelsAdded: [],
          labelsRemoved: [{ messageId: 'm1', labelIds: ['INBOX'] }],
        },
      ],
      historyId: '180',
    },
  ];
  fake.messages.set('m3', {
    id: 'm3',
    labelIds: ['INBOX'],
    historyId: '170',
    internalDate: String(Date.parse('2030-10-04T06:00:00Z')),
  });
  fake.messages.set('m1', {
    id: 'm1',
    labelIds: ['SENT'],
    historyId: '175',
    internalDate: String(Date.parse('2030-10-03T06:00:00Z')),
  });
  const outcome = await buildExecutor(h, fake).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_MAIL,
    resource: 'mail',
    kind: 'incremental',
  });
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  assert.equal(fake.historyRequests[0]?.startHistoryId, '100');
  // m3 の新規、m2 の削除、m1 の範囲外への移動で差分 3。cursor は履歴の結果 180。
  assert.equal(outcome.diff_count, 3);
  assert.equal(outcome.scope.provider_cursor, '180');
  assert.deepEqual(await publishedItems(h, SCOPE_MAIL), [
    { remote_id: 'm3', source_revision: '170' },
  ]);
});

test('an expired history start abandons the scan and falls back to a full scan', async (t) => {
  const h = await start(t);
  h.sql((db) => {
    db.exec(
      `UPDATE sync_scopes SET provider_cursor = '100', committed_watermark = ${Date.parse('2030-10-04T00:00:00Z')} WHERE scope_id = '${SCOPE_MAIL}'`,
    );
  });
  const fake = new FakeConnector();
  fake.historyError = new GoogleHistoryExpiredError();
  fake.mailPages = [{ items: [{ id: 'm1' }] }];
  fake.messages.set('m1', {
    id: 'm1',
    labelIds: ['INBOX'],
    historyId: '200',
    internalDate: String(Date.parse('2030-10-04T00:00:00Z')),
  });
  const outcome = await buildExecutor(h, fake).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_MAIL,
    resource: 'mail',
    kind: 'incremental',
  });
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  assert.equal(outcome.diff_count, 1);
  assert.equal(outcome.scope.provider_cursor, '200');
  const batches = h.sql((db) =>
    db
      .prepare('SELECT kind, status FROM sync_batches ORDER BY scan_started_at')
      .all(),
  ) as { kind: string; status: string }[];
  assert.deepEqual(batches, [
    { kind: 'incremental', status: 'abandoned' },
    { kind: 'full', status: 'published' },
  ]);
});

test('a failed scan stays resumable and the next call continues from the stored page cursor', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.calendarPages = [
    { items: [event('e1', 'v1')], nextPageToken: 'p2' },
    new GoogleApiError('not_sent', 3),
  ];
  const executor = buildExecutor(h, fake);
  const request = {
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'full',
  } as const;
  const first = await executor.runScan(request);
  assert.equal(first.status, 'failed', JSON.stringify(first));
  if (first.status !== 'failed') return;
  assert.equal(first.reason, 'google_api_error:not_sent:none');
  const snapshot = await h.store.sync({
    kind: 'sync.get_scope',
    scope_id: SCOPE_CAL,
  });
  assert(snapshot.ok && snapshot.value !== null);
  assert.equal(snapshot.value.active_batch?.status, 'staged');
  assert.equal(
    snapshot.value.active_batch?.page_cursor,
    JSON.stringify({ container: 0, token: 'p2' }),
  );

  // 2 回目は保存済みのトークンから続きを読み、再開として公開する。
  fake.calendarPages = [{ items: [event('e2', 'v1')] }];
  const second = await executor.runScan(request);
  assert.equal(second.status, 'published', JSON.stringify(second));
  if (second.status !== 'published') return;
  assert.equal(second.resumed, true);
  assert.equal(fake.calendarRequests[1]?.pageToken, 'p2');
  assert.equal(second.diff_count, 2);
  assert.deepEqual(await publishedItems(h, SCOPE_CAL), [
    { remote_id: 'e1', source_revision: 'v1' },
    { remote_id: 'e2', source_revision: 'v1' },
  ]);
});

test('a second request while a scan is active is queued, and unavailable cases never start a scan', async (t) => {
  const h = await start(t);
  // 増分の起点（watermark）を用意してから、実行中の全量走査を手で始める。
  h.sql((db) => {
    db.exec(
      `UPDATE sync_scopes SET committed_watermark = ${Date.parse('2030-10-04T00:00:00Z')} WHERE scope_id = '${SCOPE_CAL}'`,
    );
  });
  const began = await h.store.sync({
    kind: 'sync.begin',
    scope_id: SCOPE_CAL,
    scan_id: 'scan-manual',
    scan_kind: 'full',
    now: '2030-10-05T00:00:00.000Z',
    window_start: '2030-09-05T00:00:00.000Z',
    window_end: '2031-01-03T00:00:00.000Z',
    query_fingerprint: 'manual',
  });
  assert(began.ok && began.value.outcome === 'started');
  const fake = new FakeConnector();
  const queued = await buildExecutor(h, fake).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'incremental',
  });
  assert.equal(queued.status, 'queued', JSON.stringify(queued));
  if (queued.status === 'queued')
    assert.equal(queued.scope.pending_incremental, true);

  const noToken = await buildExecutor(h, fake, {
    tokenSourceFor: () => null,
  }).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_MAIL,
    resource: 'mail',
    kind: 'full',
  });
  assert.deepEqual(noToken, {
    status: 'unavailable',
    reason: 'token_unavailable',
  });
  const missing = await buildExecutor(h, fake).runScan({
    connection_id: 'conn-unknown',
    account_id: ACCOUNT,
    scope_id: SCOPE_MAIL,
    resource: 'mail',
    kind: 'full',
  });
  assert.deepEqual(missing, {
    status: 'unavailable',
    reason: 'connection_not_found',
  });
});

test('the retention gate keeps scans out until the sweep is done and holds a lease while scanning', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.calendarPages = [{ items: [event('e1', 'v1')] }];
  const closed = buildExecutor(h, fake, {
    retention: {
      ready: () => Promise.resolve(),
      gate: () => ({
        search: false,
        cloud_send: false,
        auto_use: false,
        reasons: ['sweep_pending'],
        use_blocked: [],
      }),
      lease: () => null,
    },
  });
  const refused = await closed.runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'full',
  });
  assert.deepEqual(refused, {
    status: 'unavailable',
    reason: 'retention_gate_closed',
  });
  // ゲートが閉じている間は走査を始めない（batch を作らない）。
  const untouched = await h.store.sync({
    kind: 'sync.get_scope',
    scope_id: SCOPE_CAL,
  });
  assert(untouched.ok && untouched.value !== null);
  assert.equal(untouched.value.scope.active_scan_id, null);

  let released = 0;
  const open = buildExecutor(h, fake, {
    retention: {
      ready: () => Promise.resolve(),
      gate: () => ({
        search: true,
        cloud_send: true,
        auto_use: true,
        reasons: [],
        use_blocked: [],
      }),
      lease: () => () => {
        released += 1;
      },
    },
  });
  const published = await open.runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'full',
  });
  assert.equal(published.status, 'published', JSON.stringify(published));
  // 公開が終わったら貸し出しを返している。
  assert.equal(released, 1);
});

test('changing the targets mid-scan refuses the late pages and the scan is abandoned by the update', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.calendarPages = [
    { items: [event('e1', 'v1')], nextPageToken: 'p2' },
    { items: [event('e2', 'v1')] },
  ];
  fake.onCalendarPage = async (index) => {
    if (index !== 0) return;
    // 1 ページ目の取得の直後（staging の前）に本人が範囲を変える。保存層が旧走査を abandoned にする。
    const updated = await h.store.connectionTargets({
      kind: 'connections.update_targets',
      connection_id: CONN,
      expected_permission_revision: '1',
      targets: {
        calendar_ids: ['cal-1'],
        mail_container_ids: ['INBOX'],
        attachment_kinds: ['pdf'],
        mail_lookback_days: 30,
        calendar_past_days: 30,
        calendar_future_days: 90,
        attachment_max_bytes: 10000000,
      },
    });
    assert(updated.ok);
  };
  const outcome = await buildExecutor(h, fake).runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE_CAL,
    resource: 'calendar',
    kind: 'full',
  });
  assert.equal(outcome.status, 'failed', JSON.stringify(outcome));
  const batches = h.sql((db) =>
    db.prepare('SELECT status FROM sync_batches').all(),
  ) as { status: string }[];
  assert.deepEqual(batches, [{ status: 'abandoned' }]);
  assert.deepEqual(await publishedItems(h, SCOPE_CAL), []);
});
