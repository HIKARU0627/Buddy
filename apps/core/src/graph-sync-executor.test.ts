// 同期の走査の実行器（Outlook／Graph、B09-04、ADR 0138）の試験。DB は実際の worker（startCore の保存層）を
// 使い、connector は台本で応答する偽物にする。期待値は設計 11 §1・§1A から手で書いた値で、実装から生成しない。
// 実 API・実アカウント・実トークンは使わない（トークンは合成値）。

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { GRAPH_CONNECTOR_CAPABILITY } from '@buddy/connectors';
import type {
  GraphMailConnector,
  GraphMailMessage,
  GraphMessagePage,
  GraphMessageQuery,
  GraphReadResult,
} from '@buddy/connectors';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import type { DbWorkerClient } from '@buddy/storage';
import { startEventCore } from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { DB_FILE } from './paths.js';
import { createGraphSyncExecutor } from './graph-sync-executor.js';
import type { GraphSyncExecutorOptions } from './graph-sync-executor.js';

const CONN = 'conn-ms';
const CONN_GOOGLE = 'conn-google';
const ACCOUNT = 'acct-ms';
const SCOPE = 'scope-ms-mail';

const TARGETS = JSON.stringify({
  calendar_ids: [],
  mail_container_ids: ['folder-inbox', 'folder-work'],
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
      `INSERT INTO connections VALUES ('${CONN}', 'microsoft', NULL, 'keystore:synthetic', 'active', 'read', '[]', '${TARGETS}', 1, 1)`,
    );
    db.exec(
      `INSERT INTO connections VALUES ('${CONN_GOOGLE}', 'google', NULL, 'keystore:synthetic', 'active', 'read', '[]', '${TARGETS}', 1, 1)`,
    );
    db.exec(
      `INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation, committed_watermark, provider_cursor, executor_generation, last_incremental_completed_at, last_full_reconciled_at, pending_incremental, pending_full, analysis_plan_complete_generation)
       VALUES ('${SCOPE}', '${CONN}', 1, NULL, 0, NULL, NULL, 1, NULL, NULL, 0, 0, NULL)`,
    );
  });
  return { core, store: core.handle.store, sql };
}

// 台本で応答する偽の connector。ページは呼出し順に消費し、要求（フォルダー・条件・cursor）を記録する。
class FakeConnector {
  readonly requests: {
    folderId: string;
    modifiedSince: string | undefined;
    receivedSince: string | undefined;
    cursor: string | undefined;
  }[] = [];
  pages: GraphReadResult<GraphMessagePage>[] = [];

  build(): GraphMailConnector {
    return buildFakeConnector(this);
  }
}

function buildFakeConnector(fake: FakeConnector): GraphMailConnector {
  return {
    capability: GRAPH_CONNECTOR_CAPABILITY,
    async readAccount() {
      throw new Error('unused');
    },
    async listMailFolders() {
      throw new Error('unused');
    },
    async listMessagesPage(
      folderId: string,
      query: GraphMessageQuery = {},
    ): Promise<GraphReadResult<GraphMessagePage>> {
      fake.requests.push({
        folderId,
        modifiedSince: query.modifiedSince,
        receivedSince: query.receivedSince,
        cursor: query.cursor,
      });
      const page = fake.pages.shift();
      if (page === undefined)
        return {
          kind: 'ok',
          value: { messages: [], skipped_without_id: 0, next_cursor: null },
        };
      return page;
    },
    async listMessages() {
      throw new Error('unused');
    },
    async listCategories() {
      throw new Error('unused');
    },
    async listAttachments() {
      throw new Error('unused');
    },
    async getAttachment() {
      throw new Error('unused');
    },
  };
}

const okPage = (
  messages: readonly GraphMailMessage[],
  next_cursor: string | null = null,
): GraphReadResult<GraphMessagePage> => ({
  kind: 'ok',
  value: { messages, skipped_without_id: 0, next_cursor },
});

const msg = (
  id: string,
  over: Partial<GraphMailMessage> = {},
): GraphMailMessage => ({
  immutable_id: id,
  folder_id: 'folder-inbox',
  received_at: '2030-10-04T00:00:00.000Z',
  last_modified_at: '2030-10-04T01:00:00.000Z',
  subject: null,
  sender_name: null,
  sender_address: null,
  categories: [],
  has_attachments: false,
  is_read: true,
  conversation_id: null,
  ...over,
});

let scanSequence = 0;

function buildExecutor(
  h: Harness,
  fake: FakeConnector,
  over: Partial<GraphSyncExecutorOptions> = {},
): ReturnType<typeof createGraphSyncExecutor> {
  let tick = 0;
  return createGraphSyncExecutor({
    store: h.store,
    tokenSourceFor: () => () => Promise.resolve('synthetic-token'),
    createConnector: () => fake.build(),
    now: () => new Date(Date.parse('2030-10-05T00:00:00Z') + tick++ * 60_000),
    newScanId: () => `scan-${++scanSequence}`,
    ...over,
  });
}

const publishedItems = async (
  h: Harness,
): Promise<{ remote_id: string; source_revision: string }[]> => {
  const result = await h.store.sync({
    kind: 'sync.list_published',
    scope_id: SCOPE,
    provider: 'microsoft',
    account_id: ACCOUNT,
  });
  assert(result.ok);
  return [...result.value];
};

const request = (kind: 'full' | 'incremental') => ({
  connection_id: CONN,
  account_id: ACCOUNT,
  scope_id: SCOPE,
  resource: 'mail' as const,
  kind,
});

test('full scan walks folders page by page and publishes only the diff', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.pages = [
    okPage([msg('m1'), msg('m2', { last_modified_at: null })], 'link-a2'),
    okPage([msg('m3', { last_modified_at: '2030-10-04T02:00:00.000Z' })]),
    okPage([
      msg('m4', {
        folder_id: 'folder-work',
        last_modified_at: '2030-10-04T03:00:00.000Z',
      }),
    ]),
  ];
  const outcome = await buildExecutor(h, fake).runScan(request('full'));
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  assert.equal(outcome.diff_count, 4);
  assert.equal(outcome.resumed, false);
  assert.equal(outcome.scope.active_generation, '1');
  // watermark は走査開始時刻。Graph は provider cursor を持たない。
  assert.equal(outcome.scope.committed_watermark, '2030-10-05T00:00:00.000Z');
  assert.equal(outcome.scope.provider_cursor, null);
  assert.equal(outcome.scope.last_full_reconciled_at !== null, true);
  // 版は lastModifiedDateTime。無いメールは ID から決まる固定値。
  assert.deepEqual(await publishedItems(h), [
    { remote_id: 'm1', source_revision: '2030-10-04T01:00:00.000Z' },
    { remote_id: 'm2', source_revision: 'no-revision:m2' },
    { remote_id: 'm3', source_revision: '2030-10-04T02:00:00.000Z' },
    { remote_id: 'm4', source_revision: '2030-10-04T03:00:00.000Z' },
  ]);
  // 窓は過去 90 日（mail_lookback_days）。2 ページ目は cursor をそのまま渡す。
  assert.deepEqual(fake.requests, [
    {
      folderId: 'folder-inbox',
      modifiedSince: undefined,
      receivedSince: '2030-07-07T00:00:00.000Z',
      cursor: undefined,
    },
    {
      folderId: 'folder-inbox',
      modifiedSince: undefined,
      receivedSince: undefined,
      cursor: 'link-a2',
    },
    {
      folderId: 'folder-work',
      modifiedSince: undefined,
      receivedSince: '2030-07-07T00:00:00.000Z',
      cursor: undefined,
    },
  ]);

  // 2 回目の全量: m1 は版変更、m2 は不在（削除）、m5 が新規。差分は 3。
  const fake2 = new FakeConnector();
  fake2.pages = [
    okPage([
      msg('m1', { last_modified_at: '2030-10-05T01:00:00.000Z' }),
      msg('m3', { last_modified_at: '2030-10-04T02:00:00.000Z' }),
      msg('m5', { last_modified_at: '2030-10-05T02:00:00.000Z' }),
    ]),
    okPage([
      msg('m4', {
        folder_id: 'folder-work',
        last_modified_at: '2030-10-04T03:00:00.000Z',
      }),
    ]),
  ];
  const outcome2 = await buildExecutor(h, fake2).runScan(request('full'));
  assert.equal(outcome2.status, 'published', JSON.stringify(outcome2));
  if (outcome2.status !== 'published') return;
  assert.equal(outcome2.diff_count, 3);
  assert.equal(outcome2.scope.active_generation, '2');
  assert.deepEqual(await publishedItems(h), [
    { remote_id: 'm1', source_revision: '2030-10-05T01:00:00.000Z' },
    { remote_id: 'm3', source_revision: '2030-10-04T02:00:00.000Z' },
    { remote_id: 'm4', source_revision: '2030-10-04T03:00:00.000Z' },
    { remote_id: 'm5', source_revision: '2030-10-05T02:00:00.000Z' },
  ]);
});

test('incremental reads from five minutes before the watermark and keeps the generation when nothing changed', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.pages = [okPage([msg('m1')]), okPage([])];
  const first = await buildExecutor(h, fake).runScan(request('full'));
  assert.equal(first.status, 'published');

  const fake2 = new FakeConnector();
  fake2.pages = [okPage([msg('m1')]), okPage([])];
  const outcome = await buildExecutor(h, fake2).runScan(request('incremental'));
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  // modifiedSince は watermark（1 回目の開始時刻 2030-10-05T00:00）の 5 分前。フォルダーごとに聞く。
  assert.deepEqual(
    fake2.requests.map((r) => [r.folderId, r.modifiedSince]),
    [
      ['folder-inbox', '2030-10-04T23:55:00.000Z'],
      ['folder-work', '2030-10-04T23:55:00.000Z'],
    ],
  );
  assert.equal(outcome.diff_count, 0);
  assert.equal(outcome.scope.active_generation, '1');
  assert.equal(outcome.scope.last_incremental_completed_at !== null, true);
});

test('incremental applies a modification and moves a folder as a revision change', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.pages = [okPage([msg('m1')]), okPage([])];
  const first = await buildExecutor(h, fake).runScan(request('full'));
  assert.equal(first.status, 'published');

  // m1 が folder-work へ移動し、lastModifiedDateTime が進んだ。増分では移動先のフォルダーで届く。
  const fake2 = new FakeConnector();
  fake2.pages = [
    okPage([]),
    okPage([
      msg('m1', {
        folder_id: 'folder-work',
        last_modified_at: '2030-10-05T00:30:00.000Z',
      }),
    ]),
  ];
  const outcome = await buildExecutor(h, fake2).runScan(request('incremental'));
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  // 基本キーは immutable_id なので、新しいメールにはならず版の差分 1 件だけ。
  assert.equal(outcome.diff_count, 1);
  assert.deepEqual(await publishedItems(h), [
    { remote_id: 'm1', source_revision: '2030-10-05T00:30:00.000Z' },
  ]);
});

test('incremental stages a message received outside the window as out_of_scope', async (t) => {
  const h = await start(t);
  // 窓の外（受信が 2030-06-01）で公開済みのメールと、前回成功時刻を用意する。
  h.sql((db) => {
    db.exec(
      `INSERT INTO source_items VALUES ('microsoft', '${ACCOUNT}', 'm-old', '2030-09-01T00:00:00.000Z', '${SCOPE}', 0, 1000, NULL)`,
    );
    db.exec(
      `UPDATE sync_scopes SET committed_watermark = ${Date.parse('2030-10-04T00:00:00Z')} WHERE scope_id = '${SCOPE}'`,
    );
  });
  const fake = new FakeConnector();
  fake.pages = [
    okPage([
      msg('m-old', {
        received_at: '2030-06-01T00:00:00.000Z',
        last_modified_at: '2030-10-04T12:00:00.000Z',
      }),
    ]),
    okPage([]),
  ];
  const outcome = await buildExecutor(h, fake).runScan(request('incremental'));
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  assert.equal(outcome.diff_count, 1);
  assert.deepEqual(await publishedItems(h), []);
});

test('incremental without a watermark falls back to a full scan', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.pages = [okPage([msg('m1')]), okPage([])];
  const outcome = await buildExecutor(h, fake).runScan(request('incremental'));
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  // 起点が無いので、増分の条件ではなく全量の条件（receivedSince）で聞いている。
  assert.equal(fake.requests[0]?.modifiedSince, undefined);
  assert.equal(fake.requests[0]?.receivedSince, '2030-07-07T00:00:00.000Z');
});

test('a pending full scan takes priority over an incremental request', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.pages = [okPage([msg('m1')]), okPage([])];
  const first = await buildExecutor(h, fake).runScan(request('full'));
  assert.equal(first.status, 'published');
  h.sql((db) => {
    db.exec(
      `UPDATE sync_scopes SET pending_full = 1 WHERE scope_id = '${SCOPE}'`,
    );
  });
  const fake2 = new FakeConnector();
  fake2.pages = [okPage([msg('m1')]), okPage([])];
  const outcome = await buildExecutor(h, fake2).runScan(request('incremental'));
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  assert.equal(fake2.requests[0]?.receivedSince, '2030-07-07T00:00:00.000Z');
  assert.equal(fake2.requests[0]?.modifiedSince, undefined);
});

test('a rejected read fails the scan with the reason code and publishes nothing', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.pages = [
    {
      kind: 'rejected',
      status: 403,
      reason: 'insufficient_permission',
      code: 'ErrorAccessDenied',
    },
  ];
  const outcome = await buildExecutor(h, fake).runScan(request('full'));
  assert.equal(outcome.status, 'failed', JSON.stringify(outcome));
  if (outcome.status !== 'failed') return;
  assert.equal(outcome.reason, 'graph_rejected:insufficient_permission');
  assert.notEqual(outcome.scan_id, null);
  assert.deepEqual(await publishedItems(h), []);
  const scope = await h.store.sync({ kind: 'sync.get_scope', scope_id: SCOPE });
  assert(scope.ok);
  if (scope.ok && scope.value !== null)
    assert.equal(scope.value.scope.committed_watermark, null);
});

test('authentication, rate limit and unavailability map to distinct failure codes', async (t) => {
  const cases: [GraphReadResult<GraphMessagePage>, string][] = [
    [
      {
        kind: 'authentication_expired',
        status: 401,
        code: 'InvalidAuthenticationToken',
      },
      'graph_authentication_expired',
    ],
    [
      { kind: 'rate_limited', status: 429, retry_after_ms: 30000 },
      'graph_rate_limited',
    ],
    [
      { kind: 'unavailable', reason: 'server_error' },
      'graph_unavailable:server_error',
    ],
  ];
  for (const [page, reason] of cases) {
    const h = await start(t);
    const fake = new FakeConnector();
    fake.pages = [page];
    const outcome = await buildExecutor(h, fake).runScan(request('full'));
    assert.equal(outcome.status, 'failed', JSON.stringify(outcome));
    if (outcome.status === 'failed') assert.equal(outcome.reason, reason);
    assert.deepEqual(await publishedItems(h), []);
  }
});

test('a scan interrupted mid-way resumes from the saved cursor', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  fake.pages = [
    okPage([msg('m1')], 'link-a2'),
    { kind: 'unavailable', reason: 'server_error' },
  ];
  const first = await buildExecutor(h, fake).runScan(request('full'));
  assert.equal(first.status, 'failed', JSON.stringify(first));
  if (first.status === 'failed')
    assert.equal(first.reason, 'graph_unavailable:server_error');
  assert.deepEqual(await publishedItems(h), []);

  // 2 回目は保存済みの cursor から続きを読む（folder-inbox の 1 ページ目を読み直さない）。
  const fake2 = new FakeConnector();
  fake2.pages = [
    okPage([msg('m2', { last_modified_at: '2030-10-04T02:00:00.000Z' })]),
    okPage([
      msg('m3', {
        folder_id: 'folder-work',
        last_modified_at: '2030-10-04T03:00:00.000Z',
      }),
    ]),
  ];
  const outcome = await buildExecutor(h, fake2).runScan(request('full'));
  assert.equal(outcome.status, 'published', JSON.stringify(outcome));
  if (outcome.status !== 'published') return;
  assert.equal(outcome.resumed, true);
  assert.deepEqual(fake2.requests[0], {
    folderId: 'folder-inbox',
    modifiedSince: undefined,
    receivedSince: undefined,
    cursor: 'link-a2',
  });
  assert.deepEqual(await publishedItems(h), [
    { remote_id: 'm1', source_revision: '2030-10-04T01:00:00.000Z' },
    { remote_id: 'm2', source_revision: '2030-10-04T02:00:00.000Z' },
    { remote_id: 'm3', source_revision: '2030-10-04T03:00:00.000Z' },
  ]);
});

test('guards: other providers, calendar, and a missing token source are unavailable', async (t) => {
  const h = await start(t);
  const fake = new FakeConnector();
  const executor = buildExecutor(h, fake);

  const wrongProvider = await executor.runScan({
    connection_id: CONN_GOOGLE,
    account_id: ACCOUNT,
    scope_id: SCOPE,
    resource: 'mail',
    kind: 'full',
  });
  assert.deepEqual(wrongProvider, {
    status: 'unavailable',
    reason: 'provider_unsupported',
  });

  const calendar = await executor.runScan({
    connection_id: CONN,
    account_id: ACCOUNT,
    scope_id: SCOPE,
    resource: 'calendar',
    kind: 'full',
  });
  assert.deepEqual(calendar, {
    status: 'unavailable',
    reason: 'resource_unsupported',
  });

  const noToken = buildExecutor(h, fake, { tokenSourceFor: () => null });
  const tokenOutcome = await noToken.runScan(request('full'));
  assert.deepEqual(tokenOutcome, {
    status: 'unavailable',
    reason: 'token_unavailable',
  });
  assert.equal(fake.requests.length, 0);
});
