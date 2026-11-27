// 選べる取得対象の発見（ADR 0145）の試験。connector は偽物（読み取りの結果を台本で返す）で、実アカウント・実トークン・
// 実ネットワークは使わない。期待値は手で書いた値（提供元の結果から、契約の ConnectionTargetDiscovery の形へ写したもの）。
// 経路の処理（createConnectionRoutes の listConnectionTargetOptions）は保存層の偽物で確かめる。
// 模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GoogleApiError,
  GoogleTransportFailure,
  type GoogleAccessTokenSource,
  type GoogleCalendarListEntry,
  type GoogleGmailLabel,
  type GraphMailFolder,
  type GraphMasterCategory,
  type GraphReadResult,
} from '@buddy/connectors';
import { targetDiscoveryErrors } from '@buddy/domain';
import type { ConnectionRecord } from '@buddy/storage';
import { sharedApiContract } from './api-test-support.js';
import { createConnectionRoutes } from './api-connections.js';
import type { ConnectionRoutesStore } from './api-connections.js';
import type { ApiHandlerRequest } from './api-server.js';
import { createConnectionDiscovery } from './connection-discovery.js';
import type {
  GoogleDiscoveryReader,
  GraphDiscoveryReader,
  TargetDiscoveryPort,
} from './connection-discovery.js';

const contract = sharedApiContract();

const record = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  connection_id: '00000000-0000-4000-8000-000000000e01',
  provider: 'google',
  status: 'active',
  access: 'read',
  granted_scopes: [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ],
  targets: {
    calendar_ids: ['primary-cal@example.invalid'],
    mail_container_ids: ['INBOX'],
    attachment_kinds: ['pdf'],
    mail_lookback_days: 90,
    calendar_past_days: 30,
    calendar_future_days: 90,
    attachment_max_bytes: 10000000,
  },
  targets_state: 'complete',
  permission_revision: '3',
  scope_revision: '5',
  ...over,
});

const TOKEN_SOURCE: GoogleAccessTokenSource = {
  getAccessToken: () => Promise.resolve('SYNTHETIC_TOKEN'),
};

function googleReader(script: {
  readonly calendars: () => Promise<readonly GoogleCalendarListEntry[]>;
  readonly labels: () => Promise<readonly GoogleGmailLabel[]>;
}): GoogleDiscoveryReader {
  return {
    calendar: { listCalendars: script.calendars },
    gmail: { listLabels: script.labels },
  };
}

function graphReader(script: {
  readonly folders: () => Promise<GraphReadResult<readonly GraphMailFolder[]>>;
  readonly categories: () => Promise<
    GraphReadResult<readonly GraphMasterCategory[]>
  >;
}): GraphDiscoveryReader {
  return {
    listMailFolders: script.folders,
    listCategories: script.categories,
  };
}

test('Google: カレンダーとラベルを写し、本人が付けた名前を優先し、名前が無ければ null、カテゴリは not_supported', async () => {
  const seen: GoogleAccessTokenSource[] = [];
  const discover = createConnectionDiscovery({
    googleTokenSourceFor: () => TOKEN_SOURCE,
    createGoogleReader: (tokenSource) => {
      seen.push(tokenSource);
      return googleReader({
        calendars: () =>
          Promise.resolve([
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
          ]),
        labels: () =>
          Promise.resolve([
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'Label_1', name: '合成のラベル', type: 'user' },
          ]),
      });
    },
  });
  const outcome = await discover(record());
  assert.deepEqual(outcome, {
    kind: 'ok',
    value: {
      calendars: {
        status: 'loaded',
        options: [
          {
            id: 'primary-cal@example.invalid',
            display_name: '合成のメイン',
            kind: 'calendar',
            primary: true,
          },
          {
            id: 'team-cal@example.invalid',
            display_name: '本人が付けた名前',
            kind: 'calendar',
            primary: false,
          },
          {
            id: 'nameless@example.invalid',
            display_name: null,
            kind: 'calendar',
            primary: false,
          },
        ],
      },
      mail_containers: {
        status: 'loaded',
        options: [
          {
            id: 'INBOX',
            display_name: 'INBOX',
            kind: 'mail_label',
            primary: false,
          },
          {
            id: 'Label_1',
            display_name: '合成のラベル',
            kind: 'mail_label',
            primary: false,
          },
        ],
      },
      categories: { status: 'not_supported', categories: [] },
    },
  });
  assert.deepEqual(seen, [TOKEN_SOURCE]);
  assert(outcome.kind === 'ok');
  assert.deepEqual(targetDiscoveryErrors('google', outcome.value), []);
});

test('Google: 403 は rejected、通信・形の失敗は unavailable で、種類ごとに独立して返す', async () => {
  const cases: readonly {
    readonly calendars: unknown;
    readonly labels: unknown;
    readonly expected: readonly [string, string];
  }[] = [
    {
      calendars: new GoogleApiError('http_error', 1, 403),
      labels: new GoogleTransportFailure('no_response'),
      expected: ['rejected', 'unavailable'],
    },
    {
      calendars: new GoogleApiError('http_error', 1, 401),
      labels: new GoogleApiError('wait_limit_exceeded', 2, 429),
      expected: ['unavailable', 'unavailable'],
    },
    {
      calendars: new GoogleApiError('invalid_response', 1),
      labels: new Error('token_source_failed'),
      expected: ['unavailable', 'unavailable'],
    },
  ];
  for (const item of cases) {
    const discover = createConnectionDiscovery({
      googleTokenSourceFor: () => TOKEN_SOURCE,
      createGoogleReader: () =>
        googleReader({
          calendars: () => Promise.reject(item.calendars),
          labels: () => Promise.reject(item.labels),
        }),
    });
    assert.deepEqual(await discover(record()), {
      kind: 'ok',
      value: {
        calendars: { status: item.expected[0], options: [] },
        mail_containers: { status: item.expected[1], options: [] },
        categories: { status: 'not_supported', categories: [] },
      },
    });
  }
  // 片方が読めなくても、読めた方は出す。
  const partial = createConnectionDiscovery({
    googleTokenSourceFor: () => TOKEN_SOURCE,
    createGoogleReader: () =>
      googleReader({
        calendars: () =>
          Promise.reject(new GoogleApiError('http_error', 1, 403)),
        labels: () =>
          Promise.resolve([{ id: 'INBOX', name: 'INBOX', type: 'system' }]),
      }),
  });
  assert.deepEqual(await partial(record()), {
    kind: 'ok',
    value: {
      calendars: { status: 'rejected', options: [] },
      mail_containers: {
        status: 'loaded',
        options: [
          {
            id: 'INBOX',
            display_name: 'INBOX',
            kind: 'mail_label',
            primary: false,
          },
        ],
      },
      categories: { status: 'not_supported', categories: [] },
    },
  });
});

test('Google: 同じ ID が 2 回・メインが 2 つある一覧は断定できないので unavailable', async () => {
  const discover = createConnectionDiscovery({
    googleTokenSourceFor: () => TOKEN_SOURCE,
    createGoogleReader: () =>
      googleReader({
        calendars: () =>
          Promise.resolve([
            { id: 'a@example.invalid', primary: true },
            { id: 'b@example.invalid', primary: true },
          ]),
        labels: () =>
          Promise.resolve([
            { id: 'Label_1', name: 'x', type: 'user' },
            { id: 'Label_1', name: 'y', type: 'user' },
          ]),
      }),
  });
  assert.deepEqual(await discover(record()), {
    kind: 'ok',
    value: {
      calendars: { status: 'unavailable', options: [] },
      mail_containers: { status: 'unavailable', options: [] },
      categories: { status: 'not_supported', categories: [] },
    },
  });
});

test('トークンの出所が無い接続は token_unavailable で、connector を作らない', async () => {
  let created = 0;
  const discover = createConnectionDiscovery({
    googleTokenSourceFor: () => null,
    createGoogleReader: () => {
      created += 1;
      throw new Error('作らないはず');
    },
    createGraphReader: () => {
      created += 1;
      throw new Error('作らないはず');
    },
  });
  assert.deepEqual(await discover(record()), { kind: 'token_unavailable' });
  // Graph の出所を渡していない。
  assert.deepEqual(await discover(record({ provider: 'microsoft' })), {
    kind: 'token_unavailable',
  });
  assert.equal(created, 0);
});

test('Microsoft: フォルダーとカテゴリを写し、空の色は null、カレンダーは not_supported', async () => {
  const discover = createConnectionDiscovery({
    graphTokenSourceFor: () => () => Promise.resolve('SYNTHETIC_TOKEN'),
    createGraphReader: () =>
      graphReader({
        folders: () =>
          Promise.resolve({
            kind: 'ok',
            value: [
              {
                folder_id: 'AAMkFolderInbox',
                display_name: '受信トレイ',
                parent_folder_id: null,
                total_item_count: 10,
                unread_item_count: 2,
              },
              {
                folder_id: 'AAMkFolderWork',
                display_name: '合成の仕事',
                parent_folder_id: 'root',
                total_item_count: null,
                unread_item_count: null,
              },
            ],
          }),
        categories: () =>
          Promise.resolve({
            kind: 'ok',
            value: [
              {
                category_id: 'cat-1',
                display_name: '合成の赤',
                color: 'preset0',
              },
              { category_id: 'cat-2', display_name: '色なし', color: '' },
              { category_id: 'cat-3', display_name: '色不明', color: null },
            ],
          }),
      }),
  });
  const outcome = await discover(record({ provider: 'microsoft' }));
  assert.deepEqual(outcome, {
    kind: 'ok',
    value: {
      calendars: { status: 'not_supported', options: [] },
      mail_containers: {
        status: 'loaded',
        options: [
          {
            id: 'AAMkFolderInbox',
            display_name: '受信トレイ',
            kind: 'mail_folder',
            primary: false,
          },
          {
            id: 'AAMkFolderWork',
            display_name: '合成の仕事',
            kind: 'mail_folder',
            primary: false,
          },
        ],
      },
      categories: {
        status: 'loaded',
        categories: [
          { category_id: 'cat-1', display_name: '合成の赤', color: 'preset0' },
          { category_id: 'cat-2', display_name: '色なし', color: null },
          { category_id: 'cat-3', display_name: '色不明', color: null },
        ],
      },
    },
  });
  assert(outcome.kind === 'ok');
  assert.deepEqual(targetDiscoveryErrors('microsoft', outcome.value), []);
});

test('Microsoft: 拒否は rejected、期限切れ・混雑・例外は unavailable で、拒否の理由のコードは載せない', async () => {
  const discover = createConnectionDiscovery({
    graphTokenSourceFor: () => () => Promise.resolve('SYNTHETIC_TOKEN'),
    createGraphReader: () =>
      graphReader({
        folders: () =>
          Promise.resolve({
            kind: 'rejected',
            status: 403,
            reason: 'admin_consent_required',
            code: 'Authorization_RequestDenied',
          }),
        categories: () =>
          Promise.resolve({
            kind: 'authentication_expired',
            status: 401,
            code: 'InvalidAuthenticationToken',
          }),
      }),
  });
  assert.deepEqual(await discover(record({ provider: 'microsoft' })), {
    kind: 'ok',
    value: {
      calendars: { status: 'not_supported', options: [] },
      mail_containers: { status: 'rejected', options: [] },
      categories: { status: 'unavailable', categories: [] },
    },
  });
  const throwing = createConnectionDiscovery({
    graphTokenSourceFor: () => () => Promise.resolve('SYNTHETIC_TOKEN'),
    createGraphReader: () =>
      graphReader({
        folders: () => Promise.reject(new Error('ページ数の上限を超えました')),
        categories: () =>
          Promise.resolve({
            kind: 'rate_limited',
            status: 429,
            retry_after_ms: 1000,
          }),
      }),
  });
  assert.deepEqual(await throwing(record({ provider: 'microsoft' })), {
    kind: 'ok',
    value: {
      calendars: { status: 'not_supported', options: [] },
      mail_containers: { status: 'unavailable', options: [] },
      categories: { status: 'unavailable', categories: [] },
    },
  });
});

// --- 経路の処理（保存層の偽物） ---

function routes(
  found: ConnectionRecord | null | 'invalid' | 'down',
  discover?: TargetDiscoveryPort,
) {
  const store = {
    connectionTargets: () =>
      Promise.resolve(
        found === 'invalid'
          ? { ok: false, reasons: ['connection_id_invalid'] }
          : found === 'down'
            ? { ok: false, reasons: ['store_unavailable'] }
            : { ok: true, value: found },
      ),
    sync: () => Promise.reject(new Error('使わない')),
  } as unknown as ConnectionRoutesStore;
  const built = createConnectionRoutes({
    store,
    ...(discover === undefined ? {} : { discover }),
  });
  return (id: string) =>
    built.handlers.listConnectionTargetOptions({
      params: { connection_id: id },
    } as unknown as ApiHandlerRequest);
}

const DISCOVERED = {
  calendars: {
    status: 'loaded' as const,
    options: [
      {
        id: 'primary-cal@example.invalid',
        display_name: '合成のメイン',
        kind: 'calendar' as const,
        primary: true,
      },
    ],
  },
  mail_containers: { status: 'rejected' as const, options: [] },
  categories: { status: 'not_supported' as const, categories: [] },
};

test('経路: active の接続は接続 ID と提供元を付けて 200 で返し、契約と意味検査に合う', async () => {
  const calls: string[] = [];
  const handle = routes(record(), (connection) => {
    calls.push(connection.connection_id);
    return Promise.resolve({ kind: 'ok', value: DISCOVERED });
  });
  const response = await handle('00000000-0000-4000-8000-000000000e01');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    connection_id: '00000000-0000-4000-8000-000000000e01',
    provider: 'google',
    calendars: {
      status: 'loaded',
      options: [
        {
          id: 'primary-cal@example.invalid',
          display_name: '合成のメイン',
          kind: 'calendar',
          primary: true,
        },
      ],
    },
    mail_containers: { status: 'rejected', options: [] },
    categories: { status: 'not_supported', categories: [] },
  });
  assert(contract.valid('ConnectionTargetDiscovery', response.body));
  // トークン・許可版・取得範囲の版は載せない。
  const text = JSON.stringify(response.body);
  for (const word of [
    'SYNTHETIC_TOKEN',
    'permission_revision',
    'scope_revision',
  ])
    assert(!text.includes(word), word);
  assert.deepEqual(calls, ['00000000-0000-4000-8000-000000000e01']);
});

test('経路: active でない接続は提供元へ読みに行かず 409、無い・形の違う ID は 422、保存層・口・出所の失敗は 503', async () => {
  let calls = 0;
  const port: TargetDiscoveryPort = () => {
    calls += 1;
    return Promise.resolve({ kind: 'ok', value: DISCOVERED });
  };
  for (const status of [
    'needs_reauth',
    'needs_attention',
    'disconnected',
  ] as const) {
    const response = await routes(record({ status }), port)('x');
    assert.equal(response.status, 409, status);
    assert.equal((response.body as { code: string }).code, 'conflict');
  }
  assert.equal(calls, 0);
  const expectStatus = async (
    handle: ReturnType<typeof routes>,
    status: number,
    code: string,
  ) => {
    const response = await handle('x');
    assert.equal(response.status, status);
    assert.equal((response.body as { code: string }).code, code);
  };
  await expectStatus(routes(null, port), 422, 'invalid_input');
  await expectStatus(routes('invalid', port), 422, 'invalid_input');
  await expectStatus(routes('down', port), 503, 'dependency_unavailable');
  assert.equal(calls, 0);
  await expectStatus(routes(record()), 503, 'dependency_unavailable');
  await expectStatus(
    routes(record(), () => Promise.resolve({ kind: 'token_unavailable' })),
    503,
    'dependency_unavailable',
  );
  await expectStatus(
    routes(record(), () => Promise.reject(new Error('想定外'))),
    503,
    'dependency_unavailable',
  );
});
