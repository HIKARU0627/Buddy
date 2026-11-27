// 連携の接続の一覧・取得対象の読み取りと変更の経路（B08-02、ADR 0086〜0089）の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬）。接続・取得対象は合成で、実アカウント・実トークン・実データは使わない。
// 期待値は設計の値（過去 90 日・カレンダーは過去 30 日〜今後 90 日・添付は PDF とテキストで 1 件 10,000,000 バイトまで）と、
// 本人の決定 D5（範囲を広げる既定値を作らない）、設計 11 §1A（範囲の変更は版を上げ旧走査を無効にする）から手で書いた値。
// 模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { fetchRequestStale } from '@buddy/domain';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import {
  bearer,
  bootstrap,
  insertDevice,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { pinnedRequest, sharedApiContract } from './api-test-support.js';
import type { ApiResponse, TestDevice } from './api-test-support.js';
import { DB_FILE } from './paths.js';

const contract = sharedApiContract();
type Json = Record<string, unknown>;
const SCREEN = { 'buddy-input-origin': 'screen' } as const;
const CONNECTION = '00000000-0000-4000-8000-000000000014';
const OTHER = '00000000-0000-4000-8000-000000000015';
const DISCONNECTED = '00000000-0000-4000-8000-000000000016';
const UNKNOWN = '00000000-0000-4000-8000-0000000000ff';

interface Harness {
  readonly core: EventCore;
  readonly device: TestDevice;
  readonly scope: string;
  sql<T>(body: (db: ReturnType<typeof openWriteConnection>) => T): T;
}

async function start(
  t: test.TestContext,
  options: Parameters<typeof startEventCore>[1] = {},
): Promise<Harness> {
  const core = await startEventCore(t, options);
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
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
    // 4 項目が無い古い形の接続（許可版 2・取得範囲の版 2）、別の接続、切断済みの接続。
    db.exec(
      `INSERT INTO connections VALUES ('${CONNECTION}', 'google', NULL, 'keystore:synthetic-1', 'active', 'read', '["calendar.events.readonly"]', '{}', 2, 2)`,
    );
    db.exec(
      `INSERT INTO connections VALUES ('${OTHER}', 'google', NULL, 'keystore:synthetic-2', 'active', 'read', '[]', '{}', 5, 5)`,
    );
    db.exec(
      `INSERT INTO connections VALUES ('${DISCONNECTED}', 'google', NULL, NULL, 'disconnected', 'read', '[]', '{}', 9, 9)`,
    );
  });
  return { core, device, scope, sql };
}

const targets = (over: Json = {}): Json => ({
  calendar_ids: ['primary'],
  mail_container_ids: ['INBOX', 'Label_1'],
  attachment_kinds: ['pdf'],
  mail_lookback_days: 30,
  calendar_past_days: 30,
  calendar_future_days: 90,
  attachment_max_bytes: 5000000,
  ...over,
});

const get = (
  h: Harness,
  path: string,
  token = h.device.token,
): Promise<ApiResponse> =>
  pinnedRequest(h.core.target, {
    method: 'GET',
    path,
    headers: bearer(token),
  });

const put = (
  h: Harness,
  id: string,
  expected: string,
  body: Json = {},
  headers: Record<string, string> = SCREEN,
  requestId: string = randomUUID(),
): Promise<ApiResponse> =>
  pinnedRequest(h.core.target, {
    method: 'PUT',
    path: `/v1/connections/${id}/targets`,
    headers: {
      ...bearer(h.device.token),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      request_id: requestId,
      command_scope_id: h.scope,
      expected_permission_revision: expected,
      targets: targets(),
      ...body,
    }),
  });

const row = (h: Harness, id = CONNECTION) =>
  h.sql(
    (db) =>
      db
        .prepare(
          'SELECT targets, permission_revision, scope_revision FROM connections WHERE connection_id = ?',
        )
        .get(id) as {
        targets: string;
        permission_revision: number;
        scope_revision: number;
      },
  );

const LEGACY_VIEW = {
  calendar_ids: [],
  mail_container_ids: [],
  attachment_kinds: [],
  mail_lookback_days: 90,
  calendar_past_days: 30,
  calendar_future_days: 90,
  attachment_max_bytes: 10000000,
};

test('requests without a device token, from outside home or while locked are refused', async (t) => {
  const h = await start(t);
  for (const [method, path] of [
    ['GET', '/v1/connections'],
    ['GET', `/v1/connections/${CONNECTION}/targets`],
    ['PUT', `/v1/connections/${CONNECTION}/targets`],
  ] as const) {
    const response = await pinnedRequest(h.core.target, {
      method,
      path,
      headers: SCREEN,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  h.core.env.lock = 'locked';
  assert.equal((await get(h, '/v1/connections')).status, 403);
  assert.equal(
    (await get(h, `/v1/connections/${CONNECTION}/targets`)).json?.['code'],
    'device_locked',
  );
  const locked = await put(h, CONNECTION, '2');
  assert.equal(locked.status, 403);
  assert.equal(row(h).targets, '{}');
  h.core.env.lock = 'unlocked';
  h.core.env.home = false;
  const outside = await get(h, '/v1/connections');
  assert.equal(outside.status, 403);
  assert.equal(outside.json?.['code'], 'outside_home_network');
});

test('the list and the targets read an incomplete row as nothing selected and never widen it', async (t) => {
  const h = await start(t);
  const list = await get(h, '/v1/connections');
  assert.equal(list.status, 200, list.text);
  assert(contract.valid('ConnectionList', list.json), list.text);
  const connections = list.json?.['connections'] as Json[];
  assert.deepEqual(
    connections.map((c) => c['connection_id']),
    [CONNECTION, OTHER, DISCONNECTED],
  );
  assert.deepEqual(connections[0], {
    connection_id: CONNECTION,
    provider: 'google',
    status: 'active',
    access: 'read',
    granted_scopes: ['calendar.events.readonly'],
    targets: LEGACY_VIEW,
    permission_revision: '2',
    scope_revision: '2',
  });
  // トークンの参照（credential_ref）は返さない。
  assert(!list.text.includes('keystore'), list.text);
  const one = await get(h, `/v1/connections/${CONNECTION}/targets`);
  assert.equal(one.status, 200, one.text);
  assert(contract.valid('ConnectionSummary', one.json), one.text);
  assert.deepEqual((one.json as Json)['targets'], LEGACY_VIEW);
  // 読んだだけでは保存しない。
  assert.equal(row(h).targets, '{}');
  assert.equal(row(h).permission_revision, 2);
});

test('an unknown connection or a malformed id is an invalid input, not a 404', async (t) => {
  const h = await start(t);
  assert.equal(
    (await get(h, `/v1/connections/${UNKNOWN}/targets`)).status,
    422,
  );
  assert.equal((await get(h, '/v1/connections/not-an-id/targets')).status, 422);
});

test('a screen operation narrows the selection: the response, the stored row and both revisions follow', async (t) => {
  const h = await start(t);
  const saved = await put(h, CONNECTION, '2');
  assert.equal(saved.status, 200, saved.text);
  assert(contract.valid('ConnectionSummary', saved.json), saved.text);
  assert.deepEqual(saved.json, {
    connection_id: CONNECTION,
    provider: 'google',
    status: 'active',
    access: 'read',
    granted_scopes: ['calendar.events.readonly'],
    targets: targets(),
    permission_revision: '3',
    scope_revision: '3',
  });
  assert.deepEqual(JSON.parse(row(h).targets), targets());
  assert.equal(row(h).permission_revision, 3);
  assert.equal(row(h).scope_revision, 3);
  const again = await get(h, `/v1/connections/${CONNECTION}/targets`);
  assert.deepEqual(again.json, saved.json);
  // 別の接続は変わらない。
  assert.equal(row(h, OTHER).targets, '{}');
  assert.equal(row(h, OTHER).permission_revision, 5);
  // 古い版（変更前の 2/2）で作った取得要求は拒否される。
  assert.equal(
    fetchRequestStale(
      { permissionRevision: '3', scopeRevision: '3' },
      { permissionRevision: '2', scopeRevision: '2' },
    ),
    'scope_revision_stale',
  );
});

test('a stale permission revision, a replay and an unknown or disconnected connection are conflicts and write nothing', async (t) => {
  const h = await start(t);
  const stale = await put(h, CONNECTION, '1');
  assert.equal(stale.status, 409);
  assert.equal(stale.json?.['code'], 'conflict');
  assert.equal(row(h).targets, '{}');
  const requestId = randomUUID();
  assert.equal(
    (await put(h, CONNECTION, '2', {}, SCREEN, requestId)).status,
    200,
  );
  // 同じ request_id の再送は、許可版が進んでいるので二重には効かない。
  const replay = await put(h, CONNECTION, '2', {}, SCREEN, requestId);
  assert.equal(replay.status, 409);
  assert.equal(row(h).permission_revision, 3);
  assert.equal(row(h).scope_revision, 3);
  assert.equal((await put(h, UNKNOWN, '1')).status, 409);
  const off = await put(h, DISCONNECTED, '9');
  assert.equal(off.status, 409);
  assert.equal(row(h, DISCONNECTED).permission_revision, 9);
  assert.equal(row(h, DISCONNECTED).targets, '{}');
});

test('the same selection again does not raise the revisions', async (t) => {
  const h = await start(t);
  assert.equal((await put(h, CONNECTION, '2')).status, 200);
  const again = await put(h, CONNECTION, '3', {
    targets: targets({ mail_container_ids: ['Label_1', 'INBOX'] }),
  });
  assert.equal(again.status, 200, again.text);
  assert.equal((again.json as Json)['permission_revision'], '3');
  assert.equal((again.json as Json)['scope_revision'], '3');
  assert.equal(row(h).permission_revision, 3);
});

test('a selection wider than the design limits is refused and the edges are accepted', async (t) => {
  const h = await start(t);
  const refused: [Json, string][] = [
    [{ mail_lookback_days: 91 }, 'mail_lookback_days'],
    [{ mail_lookback_days: 0 }, 'mail_lookback_days'],
    [{ calendar_past_days: 31 }, 'calendar_past_days'],
    [{ calendar_future_days: 91 }, 'calendar_future_days'],
    [{ attachment_max_bytes: 10000001 }, 'attachment_max_bytes'],
    [{ attachment_max_bytes: 0 }, 'attachment_max_bytes'],
    [{ attachment_kinds: ['pdf', 'docx'] }, 'attachment_kinds'],
    [{ unlimited: true }, 'unlimited'],
  ];
  for (const [over, name] of refused) {
    const response = await put(h, CONNECTION, '2', { targets: targets(over) });
    assert.equal(response.status, 422, name);
    assert.equal(response.json?.['code'], 'invalid_input', name);
  }
  // 項目が欠けた要求も、既定値で補わずに拒否する。
  const missing = targets();
  delete missing['mail_lookback_days'];
  assert.equal(
    (await put(h, CONNECTION, '2', { targets: missing })).status,
    422,
  );
  // 前後に空白のある ID は、契約の形では通るが保存層の規則で拒否する。
  const spaced = await put(h, CONNECTION, '2', {
    targets: targets({ mail_container_ids: [' INBOX'] }),
  });
  assert.equal(spaced.status, 422, spaced.text);
  // どれも書いていない。
  assert.equal(row(h).targets, '{}');
  assert.equal(row(h).permission_revision, 2);
  // 上限ちょうどと下限ちょうどは受け付ける。
  const edges = await put(h, CONNECTION, '2', {
    targets: targets({
      mail_lookback_days: 90,
      calendar_past_days: 30,
      calendar_future_days: 90,
      attachment_max_bytes: 10000000,
      attachment_kinds: ['pdf', 'text'],
    }),
  });
  assert.equal(edges.status, 200, edges.text);
  const lowest = await put(h, CONNECTION, '3', {
    targets: targets({
      mail_lookback_days: 1,
      calendar_past_days: 0,
      calendar_future_days: 0,
      attachment_max_bytes: 1,
      attachment_kinds: [],
      calendar_ids: [],
      mail_container_ids: [],
    }),
  });
  assert.equal(lowest.status, 200, lowest.text);
  assert.equal(row(h).permission_revision, 4);
});

test('changing the selection needs a screen operation', async (t) => {
  const h = await start(t);
  // 入力の出どころの申告が無い要求は、契約の必須ヘッダーの欠落（422）。
  const missing = await put(h, CONNECTION, '2', {}, {});
  assert.equal(missing.status, 422);
  assert.equal(missing.json?.['code'], 'invalid_input');
  // 音声など画面以外からの変更は、検査で拒否する（403）。
  const voice = await put(
    h,
    CONNECTION,
    '2',
    {},
    { 'buddy-input-origin': 'voice' },
  );
  assert.equal(voice.status, 403);
  assert.equal(voice.json?.['code'], 'screen_operation_required');
  assert.equal(row(h).targets, '{}');
  assert.equal(row(h).permission_revision, 2);
});

test('a change abandons the running scan of that connection only', async (t) => {
  const h = await start(t);
  h.sql((db) => {
    for (const [scopeId, connectionId, scanId] of [
      ['s-mine', CONNECTION, 'scan-mine'],
      ['s-other', OTHER, 'scan-other'],
    ] as const) {
      db.prepare(
        `INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation, executor_generation)
         VALUES (?, ?, 2, ?, 0, 0)`,
      ).run(scopeId, connectionId, scanId);
      db.prepare(
        `INSERT INTO sync_batches (scan_id, scope_id, scope_revision, kind, base_generation, scan_started_at, window_start, window_end,
           query_fingerprint, executor_generation, status, delete_at)
         VALUES (?, ?, 2, 'full', 0, 1000, 0, 1000, 'fp', 0, 'fetching', 99999)`,
      ).run(scanId, scopeId);
    }
  });
  assert.equal((await put(h, CONNECTION, '2')).status, 200);
  const state = h.sql((db) => ({
    mine: db
      .prepare(
        'SELECT s.scope_revision, s.active_scan_id, s.pending_full, b.status FROM sync_scopes s JOIN sync_batches b ON b.scan_id = ? WHERE s.scope_id = ?',
      )
      .get('scan-mine', 's-mine'),
    other: db
      .prepare(
        'SELECT s.scope_revision, s.active_scan_id, b.status FROM sync_scopes s JOIN sync_batches b ON b.scan_id = ? WHERE s.scope_id = ?',
      )
      .get('scan-other', 's-other'),
  }));
  assert.deepEqual(state.mine, {
    scope_revision: 3,
    active_scan_id: null,
    pending_full: 1,
    status: 'abandoned',
  });
  assert.deepEqual(state.other, {
    scope_revision: 2,
    active_scan_id: 'scan-other',
    status: 'fetching',
  });
});

test('the sync state returns the stored scope, the active batch and the retry defaults without any token', async (t) => {
  const h = await start(t);
  h.sql((db) => {
    db.prepare(
      `INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation, committed_watermark, provider_cursor, executor_generation, last_incremental_completed_at, last_full_reconciled_at, pending_incremental, pending_full, analysis_plan_complete_generation)
       VALUES ('00000000-0000-4000-8000-000000000402', ?, 2, '00000000-0000-4000-8000-000000000403', 3, 1000, 'h100', 1, NULL, 2000, 0, 1, NULL)`,
    ).run(CONNECTION);
    db.prepare(
      `INSERT INTO sync_batches (scan_id, scope_id, scope_revision, kind, base_generation, base_watermark, base_provider_cursor, scan_started_at, window_start, window_end, query_fingerprint, executor_generation, status, page_cursor, diff_count, delete_at)
       VALUES ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000402', 2, 'full', 3, 1000, 'h100', 3000, 0, 4000, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 'fetching', 'tok-1', NULL, 999999)`,
    ).run();
  });
  const response = await get(h, `/v1/connections/${CONNECTION}/sync`);
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('SyncStateResponse', response.json), response.text);
  assert.deepEqual(response.json, {
    connection_id: CONNECTION,
    provider: 'google',
    scope_revision: '2',
    state: {
      scope_id: '00000000-0000-4000-8000-000000000402',
      scope_revision: '2',
      active_scan_id: '00000000-0000-4000-8000-000000000403',
      active_generation: '3',
      committed_watermark: '1970-01-01T00:00:01.000Z',
      provider_cursor: 'h100',
      executor_generation: '1',
      last_incremental_completed_at: null,
      last_full_reconciled_at: '1970-01-01T00:00:02.000Z',
      pending_incremental: false,
      pending_full: true,
      analysis_plan_complete_generation: null,
    },
    active_batch: {
      scan_id: '00000000-0000-4000-8000-000000000403',
      scope_id: '00000000-0000-4000-8000-000000000402',
      scope_revision: '2',
      kind: 'full',
      status: 'fetching',
      scan_started_at: '1970-01-01T00:00:03.000Z',
      window_start: '1970-01-01T00:00:00.000Z',
      window_end: '1970-01-01T00:00:04.000Z',
      query_fingerprint:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      base_generation: '3',
      base_watermark: '1970-01-01T00:00:01.000Z',
      base_provider_cursor: 'h100',
      executor_generation: '1',
      page_cursor: 'tok-1',
      diff_count: null,
    },
    retry: {
      read_timeout_ms: 15000,
      read_max_attempts: 3,
      read_base_delay_ms: [2000, 10000],
      read_max_total_wait_ms: 120000,
      read_failure_threshold: 3,
      write_automatic_retries: 0,
    },
    last_attempt_at: '1970-01-01T00:00:03.000Z',
  });
  // 取得集合が無い接続は状態を作らず 503、存在しない接続は 422。
  const noScope = await get(h, `/v1/connections/${OTHER}/sync`);
  assert.equal(noScope.status, 503);
  assert.equal(noScope.json?.['code'], 'dependency_unavailable');
  const unknown = await get(h, `/v1/connections/${UNKNOWN}/sync`);
  assert.equal(unknown.status, 422);
});

// --- 選べる取得対象（ADR 0145） ---
// 提供元への読み取りの 200 の形は connection-discovery.test.ts（偽の connector）で確かめる。ここは経路の検査と、
// 提供元へ読みに行く前に閉じる場合（存在しない・active でない・トークンの出所が無い）を実 Core で確かめる。

const options = (id: string) => `/v1/connections/${id}/target-options`;

test('target options need a device token, home, an unlocked device and the hub screen', async (t) => {
  const h = await start(t);
  const anonymous = await pinnedRequest(h.core.target, {
    method: 'GET',
    path: options(CONNECTION),
    headers: {},
  });
  assert.equal(anonymous.status, 401);
  h.core.env.lock = 'locked';
  const locked = await get(h, options(CONNECTION));
  assert.equal(locked.status, 403);
  assert.equal(locked.json?.['code'], 'device_locked');
  h.core.env.lock = 'unlocked';
  h.core.env.hub = false;
  const remote = await get(h, options(CONNECTION));
  assert.equal(remote.status, 403);
  assert.equal(remote.json?.['code'], 'hub_screen_required');
  h.core.env.hub = true;
  h.core.env.home = false;
  const outside = await get(h, options(CONNECTION));
  assert.equal(outside.status, 403);
  assert.equal(outside.json?.['code'], 'outside_home_network');
});

test('target options close before any provider read: unknown is 422, disconnected is 409, no token source is 503', async (t) => {
  const asked: string[] = [];
  const h = await start(t, {
    sync: {
      // 出所を求められたら記録し、出所は無いと答える（提供元へは送らない）。
      tokenSourceFor: (connection) => {
        asked.push(connection.connection_id);
        return null;
      },
    },
  });
  assert.equal((await get(h, options(UNKNOWN))).status, 422);
  assert.equal((await get(h, options('not-an-id'))).status, 422);
  const disconnected = await get(h, options(DISCONNECTED));
  assert.equal(disconnected.status, 409);
  assert.equal(disconnected.json?.['code'], 'conflict');
  assert.deepEqual(asked, []);
  const noToken = await get(h, options(CONNECTION));
  assert.equal(noToken.status, 503);
  assert.equal(noToken.json?.['code'], 'dependency_unavailable');
  assert.deepEqual(asked, [CONNECTION]);
  // 読むだけで、取得対象も版も変えない。
  assert.equal(row(h).targets, '{}');
  assert.equal(row(h).permission_revision, 2);
  assert.equal(row(h).scope_revision, 2);
});
