// Microsoft Graph の読み取り connector の試験（B09-02、ADR 0134）。
// 模擬 transport（要求を記録し、手書きの応答を順に返す）を注入する。実ネットワーク・実 API は使わない。
// 期待値は手で書いた値で、実装の処理から作らない。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyGraphError,
  createGraphMailConnector,
  GRAPH_PERSONAL_TENANT_ID,
  type GraphHttpCall,
  type GraphHttpOutcome,
  type GraphMailConnectorOptions,
} from './index.js';
import { TEST_TIMEOUT_MS } from './test-support.js';

const OPTIONS = { timeout: TEST_TIMEOUT_MS };
// 合成の目印。結果・例外のどこにも現れてはいけない。
const TOKEN = 'SECRET_TOKEN_DO_NOT_LEAK';
const BASE = 'https://graph.microsoft.com/v1.0';
// 全試験で送られた要求の URL（最後に差分取得の経路が無いことを確かめる）。
const ALL_URLS: string[] = [];

type Reply = GraphHttpOutcome | ((call: GraphHttpCall) => GraphHttpOutcome);

// 応答を順に返す模擬 transport。要求はすべて記録する。
function setup(
  replies: Reply[],
  extra: Partial<GraphMailConnectorOptions> = {},
) {
  const calls: GraphHttpCall[] = [];
  let tokenCalls = 0;
  const connector = createGraphMailConnector({
    accessToken: () => {
      tokenCalls += 1;
      return Promise.resolve(TOKEN);
    },
    transport: (call) => {
      calls.push(call);
      ALL_URLS.push(call.url);
      const reply = replies.shift();
      assert(reply !== undefined, `想定外の要求: ${call.url}`);
      return Promise.resolve(typeof reply === 'function' ? reply(call) : reply);
    },
    ...extra,
  });
  return { connector, calls, tokenCalls: () => tokenCalls, replies };
}

const ok = (
  body: unknown,
  headers: Record<string, string> = {},
): GraphHttpOutcome => ({ kind: 'response', status: 200, headers, body });
const status = (
  code: number,
  body: unknown,
  headers: Record<string, string> = {},
): GraphHttpOutcome => ({ kind: 'response', status: code, headers, body });

const pathOf = (call: GraphHttpCall) => new URL(call.url).pathname;
const param = (call: GraphHttpCall, name: string) =>
  new URL(call.url).searchParams.get(name);

// 合成のメッセージ（Graph の応答の形）。
function rawMessage(id: string | undefined, folder: string, extra = {}) {
  return {
    ...(id === undefined ? {} : { id }),
    receivedDateTime: '2026-11-20T01:00:00Z',
    lastModifiedDateTime: '2026-11-21T02:00:00Z',
    subject: '（合成）件名',
    from: {
      emailAddress: {
        name: '合成 送信者',
        address: 'synthetic-sender@example.com',
      },
    },
    categories: ['（合成）カテゴリ'],
    hasAttachments: false,
    isRead: true,
    parentFolderId: folder,
    conversationId: 'conv-1',
    ...extra,
  };
}

test(
  'フォルダーの列挙: nextLink を最終ページまで辿り、各要求に Prefer と Authorization を付ける',
  OPTIONS,
  async () => {
    const next = `${BASE}/me/mailFolders?%24select=id&%24top=100&%24skip=100`;
    const { connector, calls, tokenCalls } = setup([
      ok({
        value: [
          {
            id: 'folder-inbox',
            displayName: 'Inbox',
            parentFolderId: 'root',
            totalItemCount: 12,
            unreadItemCount: 3,
          },
        ],
        '@odata.nextLink': next,
      }),
      ok({
        value: [
          {
            id: 'folder-archive',
            displayName: 'Archive',
            parentFolderId: null,
          },
        ],
      }),
    ]);
    assert.deepEqual(await connector.listMailFolders(), {
      kind: 'ok',
      value: [
        {
          folder_id: 'folder-inbox',
          display_name: 'Inbox',
          parent_folder_id: 'root',
          total_item_count: 12,
          unread_item_count: 3,
        },
        {
          folder_id: 'folder-archive',
          display_name: 'Archive',
          parent_folder_id: null,
          total_item_count: null,
          unread_item_count: null,
        },
      ],
    });
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0]!.url,
      'https://graph.microsoft.com/v1.0/me/mailFolders?%24select=id%2CdisplayName%2CparentFolderId%2CtotalItemCount%2CunreadItemCount&%24top=100',
    );
    // nextLink は組み直さず、そのまま使う。
    assert.equal(calls[1]!.url, next);
    for (const call of calls) {
      assert.equal(call.method, 'GET');
      assert.deepEqual(call.headers, {
        Authorization: 'Bearer SECRET_TOKEN_DO_NOT_LEAK',
        Prefer: 'IdType="ImmutableId"',
      });
      assert.equal(call.timeoutMs, 15_000);
    }
    // トークンは要求ごとに取得する（connector は保持しない）。
    assert.equal(tokenCalls(), 2);
  },
);

test(
  'フォルダーの列挙: id の無い項目があれば全体を invalid_response にする',
  OPTIONS,
  async () => {
    const { connector } = setup([
      ok({
        value: [
          { id: 'folder-inbox', displayName: 'Inbox' },
          { displayName: '（id なし）' },
        ],
      }),
    ]);
    assert.deepEqual(await connector.listMailFolders(), {
      kind: 'unavailable',
      reason: 'invalid_response',
    });
  },
);

test(
  'メッセージの列挙: 3 ページを辿り、途中のページが 0 件でも nextLink があれば続ける',
  OPTIONS,
  async () => {
    const page2 = `${BASE}/me/mailFolders/folder-inbox/messages?%24skiptoken=p2`;
    const page3 = `${BASE}/me/mailFolders/folder-inbox/messages?%24skiptoken=p3`;
    const { connector, calls } = setup([
      ok({
        value: [
          rawMessage('m-1', 'folder-inbox'),
          rawMessage('m-2', 'folder-inbox'),
        ],
        '@odata.nextLink': page2,
      }),
      ok({ value: [], '@odata.nextLink': page3 }),
      ok({ value: [rawMessage('m-3', 'folder-inbox')] }),
    ]);
    const result = await connector.listMessages('folder-inbox');
    assert.equal(result.kind, 'ok');
    assert(result.kind === 'ok');
    assert.equal(result.value.pages, 3);
    assert.equal(result.value.skipped_without_id, 0);
    assert.deepEqual(
      result.value.messages.map((m) => m.immutable_id),
      ['m-1', 'm-2', 'm-3'],
    );
    assert.deepEqual(calls.map((c) => c.url).slice(1), [page2, page3]);
    assert.equal(
      pathOf(calls[0]!),
      '/v1.0/me/mailFolders/folder-inbox/messages',
    );
    // 変換の形（手書き）。
    assert.deepEqual(result.value.messages[0], {
      immutable_id: 'm-1',
      folder_id: 'folder-inbox',
      received_at: '2026-11-20T01:00:00Z',
      last_modified_at: '2026-11-21T02:00:00Z',
      subject: '（合成）件名',
      sender_name: '合成 送信者',
      sender_address: 'synthetic-sender@example.com',
      categories: ['（合成）カテゴリ'],
      has_attachments: false,
      is_read: true,
      conversation_id: 'conv-1',
    });
  },
);

test(
  '増分の形: modifiedSince は lastModifiedDateTime の条件と降順、$top は既定 50',
  OPTIONS,
  async () => {
    const { connector, calls } = setup([
      ok({ value: [] }),
      ok({ value: [] }),
      ok({ value: [] }),
      ok({ value: [] }),
    ]);
    await connector.listMessagesPage('folder-inbox', {
      modifiedSince: '2026-11-21T08:55:00Z',
    });
    assert.equal(
      param(calls[0]!, '$filter'),
      'lastModifiedDateTime ge 2026-11-21T08:55:00Z',
    );
    assert.equal(param(calls[0]!, '$orderby'), 'lastModifiedDateTime desc');
    assert.equal(param(calls[0]!, '$top'), '50');

    await connector.listMessagesPage('folder-inbox', {
      receivedSince: '2026-11-01T00:00:00Z',
      pageSize: 10,
    });
    assert.equal(
      param(calls[1]!, '$filter'),
      'receivedDateTime ge 2026-11-01T00:00:00Z',
    );
    assert.equal(param(calls[1]!, '$orderby'), 'receivedDateTime desc');
    assert.equal(param(calls[1]!, '$top'), '10');

    // 両方: modifiedSince を優先し、receivedSince を and で足す。
    await connector.listMessagesPage('folder-inbox', {
      receivedSince: '2026-11-01T00:00:00Z',
      modifiedSince: '2026-11-21T08:55:00Z',
    });
    assert.equal(
      param(calls[2]!, '$filter'),
      'lastModifiedDateTime ge 2026-11-21T08:55:00Z and receivedDateTime ge 2026-11-01T00:00:00Z',
    );
    assert.equal(param(calls[2]!, '$orderby'), 'lastModifiedDateTime desc');

    // 条件なし: フィルターなし、受信日時の降順。
    await connector.listMessagesPage('folder-inbox');
    assert.equal(param(calls[3]!, '$filter'), null);
    assert.equal(param(calls[3]!, '$orderby'), 'receivedDateTime desc');
  },
);

test(
  '最小の select: 要求の $select が固定の最小集合と一致し、本文を取らない',
  OPTIONS,
  async () => {
    const { connector, calls } = setup([ok({ value: [] })]);
    await connector.listMessagesPage('folder-inbox');
    assert.equal(
      param(calls[0]!, '$select'),
      'id,receivedDateTime,lastModifiedDateTime,subject,from,categories,hasAttachments,isRead,parentFolderId,conversationId',
    );
    assert(!param(calls[0]!, '$select')!.split(',').includes('body'));
  },
);

test(
  'cursor があれば query を組み直さず、その URL をそのまま使う',
  OPTIONS,
  async () => {
    const cursor = `${BASE}/me/mailFolders/folder-inbox/messages?%24skiptoken=abc`;
    const { connector, calls } = setup([ok({ value: [] })]);
    assert.deepEqual(
      await connector.listMessagesPage('folder-inbox', {
        cursor,
        modifiedSince: '2026-11-21T08:55:00Z',
      }),
      {
        kind: 'ok',
        value: { messages: [], skipped_without_id: 0, next_cursor: null },
      },
    );
    assert.equal(calls[0]!.url, cursor);
  },
);

test(
  'QA23 フォルダー移動: 同じ immutable id は別フォルダーでも同じ ID のまま、folder_id だけが違う',
  OPTIONS,
  async () => {
    const { connector } = setup([
      ok({ value: [rawMessage('imm-1', 'folder-inbox')] }),
      ok({ value: [rawMessage('imm-1', 'folder-archive')] }),
    ]);
    const before = await connector.listMessagesPage('folder-inbox');
    const after = await connector.listMessagesPage('folder-archive');
    assert(before.kind === 'ok' && after.kind === 'ok');
    assert.equal(before.value.messages[0]!.immutable_id, 'imm-1');
    assert.equal(after.value.messages[0]!.immutable_id, 'imm-1');
    assert.equal(before.value.messages[0]!.folder_id, 'folder-inbox');
    assert.equal(after.value.messages[0]!.folder_id, 'folder-archive');
  },
);

test(
  'QA23 所属フォルダーが応答に無ければ、要求したフォルダーを folder_id にする',
  OPTIONS,
  async () => {
    const { connector } = setup([ok({ value: [{ id: 'imm-2' }] })]);
    assert.deepEqual(await connector.listMessagesPage('folder-inbox'), {
      kind: 'ok',
      value: {
        messages: [
          {
            immutable_id: 'imm-2',
            folder_id: 'folder-inbox',
            received_at: null,
            last_modified_at: null,
            subject: null,
            sender_name: null,
            sender_address: null,
            categories: [],
            has_attachments: false,
            is_read: null,
            conversation_id: null,
          },
        ],
        skipped_without_id: 0,
        next_cursor: null,
      },
    });
  },
);

test(
  'QA23 header 欠落: id の無い・空の項目は messages に入れず skipped_without_id に数える',
  OPTIONS,
  async () => {
    const { connector } = setup([
      ok({
        value: [
          rawMessage(undefined, 'folder-inbox'),
          rawMessage('', 'folder-inbox'),
          rawMessage('imm-3', 'folder-inbox'),
          'not-an-object',
        ],
      }),
    ]);
    const result = await connector.listMessagesPage('folder-inbox');
    assert(result.kind === 'ok');
    assert.deepEqual(
      result.value.messages.map((m) => m.immutable_id),
      ['imm-3'],
    );
    assert.equal(result.value.skipped_without_id, 3);
  },
);

test(
  'カテゴリ一覧: masterCategories を表示用の形に変換し、nextLink も辿る',
  OPTIONS,
  async () => {
    const next = `${BASE}/me/outlook/masterCategories?%24skip=1`;
    const { connector, calls } = setup([
      ok({
        value: [{ id: 'cat-1', displayName: '（合成）赤', color: 'preset0' }],
        '@odata.nextLink': next,
      }),
      ok({ value: [{ id: 'cat-2', displayName: '（合成）色なし' }] }),
    ]);
    assert.deepEqual(await connector.listCategories(), {
      kind: 'ok',
      value: [
        { category_id: 'cat-1', display_name: '（合成）赤', color: 'preset0' },
        { category_id: 'cat-2', display_name: '（合成）色なし', color: null },
      ],
    });
    assert.equal(pathOf(calls[0]!), '/v1.0/me/outlook/masterCategories');
    assert.equal(param(calls[0]!, '$select'), 'id,displayName,color');
  },
);

test('拒否の判別: classifyGraphError の対応表（手書き）', OPTIONS, () => {
  const err = (code: string, message = '（合成）', extra = {}) => ({
    error: { code, message, ...extra },
  });
  const cases: [number, unknown, unknown][] = [
    [
      401,
      err('InvalidAuthenticationToken'),
      {
        kind: 'authentication_expired',
        status: 401,
        code: 'InvalidAuthenticationToken',
      },
    ],
    [
      401,
      null,
      { kind: 'authentication_expired', status: 401, code: 'unknown' },
    ],
    [
      403,
      err(
        'Authorization_RequestDenied',
        'AADSTS65001: The user or administrator has not consented',
      ),
      {
        kind: 'rejected',
        status: 403,
        reason: 'admin_consent_required',
        code: 'Authorization_RequestDenied',
      },
    ],
    [
      403,
      err('ErrorAccessDenied', 'Need admin approval', {
        innerError: { code: 'AADSTS90093' },
      }),
      {
        kind: 'rejected',
        status: 403,
        reason: 'admin_consent_required',
        code: 'ErrorAccessDenied',
      },
    ],
    [
      403,
      err('ErrorAccessDenied', 'This app requires Admin Consent.'),
      {
        kind: 'rejected',
        status: 403,
        reason: 'admin_consent_required',
        code: 'ErrorAccessDenied',
      },
    ],
    [
      403,
      err('ErrorTenantRestriction'),
      {
        kind: 'rejected',
        status: 403,
        reason: 'tenant_restriction',
        code: 'ErrorTenantRestriction',
      },
    ],
    [
      403,
      err(
        'AccessDenied',
        'AADSTS500021: Access to the requested tenant is denied.',
      ),
      {
        kind: 'rejected',
        status: 403,
        reason: 'tenant_restriction',
        code: 'AccessDenied',
      },
    ],
    [
      403,
      err('ErrorAccessDenied', 'Blocked by a conditional access policy.'),
      {
        kind: 'rejected',
        status: 403,
        reason: 'organization_policy',
        code: 'ErrorAccessDenied',
      },
    ],
    [
      403,
      err(
        'ErrorAccessDenied',
        'Access is denied. Check credentials and try again.',
      ),
      {
        kind: 'rejected',
        status: 403,
        reason: 'insufficient_permission',
        code: 'ErrorAccessDenied',
      },
    ],
    [
      403,
      err(
        'Authorization_RequestDenied',
        'Insufficient privileges to complete the operation.',
      ),
      {
        kind: 'rejected',
        status: 403,
        reason: 'insufficient_permission',
        code: 'Authorization_RequestDenied',
      },
    ],
    [
      403,
      null,
      { kind: 'rejected', status: 403, reason: 'unknown', code: 'unknown' },
    ],
    [
      403,
      { error: 'not-an-object' },
      { kind: 'rejected', status: 403, reason: 'unknown', code: 'unknown' },
    ],
    [
      429,
      err('TooManyRequests'),
      { kind: 'rate_limited', status: 429, retry_after_ms: null },
    ],
    [
      503,
      err('ServiceUnavailable'),
      { kind: 'unavailable', reason: 'server_error' },
    ],
    [500, null, { kind: 'unavailable', reason: 'server_error' }],
    [
      404,
      err('ErrorItemNotFound'),
      {
        kind: 'rejected',
        status: 404,
        reason: 'unknown',
        code: 'ErrorItemNotFound',
      },
    ],
  ];
  for (const [code, body, expected] of cases)
    assert.deepEqual(
      classifyGraphError(code, body),
      expected,
      JSON.stringify(body),
    );
  // 結果には message 全文を持たない。
  const result = classifyGraphError(
    403,
    err(
      'ErrorAccessDenied',
      'synthetic-private@example.com の権限がありません',
    ),
  );
  assert(!JSON.stringify(result).includes('synthetic-private@example.com'));
});

test(
  '拒否の判別: connector 経由の 403 は rejected で返り、成功扱いにしない',
  OPTIONS,
  async () => {
    const forbidden = status(403, {
      error: {
        code: 'ErrorAccessDenied',
        message: 'Organization policy blocks access.',
      },
    });
    const { connector } = setup([forbidden, forbidden, forbidden, forbidden]);
    const expected = {
      kind: 'rejected',
      status: 403,
      reason: 'organization_policy',
      code: 'ErrorAccessDenied',
    };
    assert.deepEqual(await connector.readAccount(), expected);
    assert.deepEqual(await connector.listMailFolders(), expected);
    assert.deepEqual(await connector.listMessages('folder-inbox'), expected);
    assert.deepEqual(await connector.listCategories(), expected);
  },
);

test(
  'Retry-After: 429 の Retry-After: 7 は retry_after_ms 7000、無ければ null',
  OPTIONS,
  async () => {
    const { connector } = setup([
      status(
        429,
        { error: { code: 'TooManyRequests' } },
        { 'Retry-After': '7' },
      ),
      status(429, null, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
      status(429, null),
    ]);
    assert.deepEqual(await connector.listMessagesPage('folder-inbox'), {
      kind: 'rate_limited',
      status: 429,
      retry_after_ms: 7000,
    });
    assert.deepEqual(await connector.listMessagesPage('folder-inbox'), {
      kind: 'rate_limited',
      status: 429,
      retry_after_ms: null,
    });
    assert.deepEqual(await connector.listMessagesPage('folder-inbox'), {
      kind: 'rate_limited',
      status: 429,
      retry_after_ms: null,
    });
  },
);

test(
  'トークンの秘匿: 成功・拒否・失敗・例外のどれにも目印が現れず、Authorization ヘッダーにだけ現れる',
  OPTIONS,
  async () => {
    const { connector, calls } = setup(
      [
        ok({ id: 'acc-1', displayName: '（合成）', mail: null }),
        status(401, {
          error: { code: 'InvalidAuthenticationToken', message: TOKEN },
        }),
        status(403, {
          error: { code: 'ErrorAccessDenied', message: `token=${TOKEN}` },
        }),
        { kind: 'no_response', reason: 'timeout' },
        () => {
          throw new Error(`transport failed with ${TOKEN}`);
        },
        ok({ value: [], '@odata.nextLink': `${BASE}/me/mailFolders?p=2` }),
      ],
      { maxPages: 1 },
    );
    const results = [
      await connector.readAccount(),
      await connector.readAccount(),
      await connector.listMailFolders(),
      await connector.listMailFolders(),
      await connector.listMailFolders(),
    ];
    assert.deepEqual(results.slice(1), [
      {
        kind: 'authentication_expired',
        status: 401,
        code: 'InvalidAuthenticationToken',
      },
      {
        kind: 'rejected',
        status: 403,
        reason: 'insufficient_permission',
        code: 'ErrorAccessDenied',
      },
      { kind: 'unavailable', reason: 'timeout' },
      { kind: 'unavailable', reason: 'connection_lost' },
    ]);
    for (const result of results)
      assert(!JSON.stringify(result).includes(TOKEN));
    // ページ数の上限（プログラムの誤りとしての例外）にも目印が現れない。
    await assert.rejects(connector.listMailFolders(), (error: Error) => {
      assert.equal(error.message, 'ページ数の上限を超えました');
      assert(!String(error.stack).includes(TOKEN));
      return true;
    });
    // 引数の誤りの例外にも現れない。
    await assert.rejects(
      connector.listMessagesPage('folder-inbox', { pageSize: 0 }),
      (error: Error) => {
        assert(error instanceof TypeError);
        assert(!error.message.includes(TOKEN));
        return true;
      },
    );
    // 目印は transport の Authorization ヘッダーにだけ現れる。
    assert.equal(calls.length, 6);
    for (const call of calls) {
      assert.equal(call.headers['Authorization'], `Bearer ${TOKEN}`);
      assert(!call.url.includes(TOKEN));
      assert(!call.headers['Prefer']!.includes(TOKEN));
      assert.deepEqual(Object.keys(call.headers).sort(), [
        'Authorization',
        'Prefer',
      ]);
    }
  },
);

test(
  'トークンの取得に失敗したら要求を送らず not_sent を返す',
  OPTIONS,
  async () => {
    const calls: GraphHttpCall[] = [];
    const connector = createGraphMailConnector({
      accessToken: () => Promise.reject(new Error(`expired ${TOKEN}`)),
      transport: (call) => {
        calls.push(call);
        return Promise.resolve(ok({}));
      },
    });
    const result = await connector.readAccount();
    assert.deepEqual(result, { kind: 'unavailable', reason: 'not_sent' });
    assert(!JSON.stringify(result).includes(TOKEN));
    assert.equal(calls.length, 0);
  },
);

test(
  '別の宛先の nextLink は辿らず invalid_response にする（トークンを他へ送らない）',
  OPTIONS,
  async () => {
    const { connector, calls } = setup([
      ok({
        value: [rawMessage('m-1', 'folder-inbox')],
        '@odata.nextLink': 'https://attacker.example.com/v1.0/me/messages?x=1',
      }),
      ok({
        value: [],
        '@odata.nextLink': 'https://graph.microsoft.com/beta/me/messages',
      }),
    ]);
    assert.deepEqual(await connector.listMessages('folder-inbox'), {
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    assert.deepEqual(await connector.listMessagesPage('folder-inbox'), {
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    assert.equal(calls.length, 2);
    // 呼び出し側が渡す別の宛先の cursor はプログラムの誤り。
    await assert.rejects(
      connector.listMessagesPage('folder-inbox', {
        cursor: 'https://attacker.example.com/v1.0/x',
      }),
      TypeError,
    );
    assert.equal(calls.length, 2);
  },
);

test(
  'アカウント種別: 個人テナントは personal、別のテナントは work_or_school、未指定は null',
  OPTIONS,
  async () => {
    const account = ok({
      id: 'acc-1',
      displayName: '（合成）利用者',
      mail: 'synthetic-user@example.com',
      userPrincipalName: 'synthetic-user@example.com',
    });
    const personal = setup([account], {
      tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
    });
    assert.deepEqual(await personal.connector.readAccount(), {
      kind: 'ok',
      value: {
        account_id: 'acc-1',
        display_name: '（合成）利用者',
        mail: 'synthetic-user@example.com',
        user_principal_name: 'synthetic-user@example.com',
        account_kind: 'personal',
      },
    });
    assert.equal(
      personal.calls[0]!.url,
      'https://graph.microsoft.com/v1.0/me?%24select=id%2CdisplayName%2Cmail%2CuserPrincipalName',
    );
    const work = setup([account], {
      tenantId: '00000000-0000-4000-8000-0000000000aa',
    });
    const workResult = await work.connector.readAccount();
    assert(workResult.kind === 'ok');
    assert.equal(workResult.value.account_kind, 'work_or_school');
    for (const tenantId of [undefined, '', '   ']) {
      const unknown = setup(
        [account],
        tenantId === undefined ? {} : { tenantId },
      );
      const result = await unknown.connector.readAccount();
      assert(result.kind === 'ok');
      assert.equal(result.value.account_kind, null, String(tenantId));
    }
    assert.equal(
      GRAPH_PERSONAL_TENANT_ID,
      '9188040d-6c67-4c5b-b112-36a304b66dad',
    );
  },
);

test(
  '途中のページの失敗: 2 ページ目が 503 なら unavailable を返し、1 ページ目を成功として返さない',
  OPTIONS,
  async () => {
    const { connector, calls } = setup([
      ok({
        value: [rawMessage('m-1', 'folder-inbox')],
        '@odata.nextLink': `${BASE}/me/mailFolders/folder-inbox/messages?%24skiptoken=p2`,
      }),
      status(503, { error: { code: 'ServiceUnavailable' } }),
    ]);
    assert.deepEqual(await connector.listMessages('folder-inbox'), {
      kind: 'unavailable',
      reason: 'server_error',
    });
    assert.equal(calls.length, 2);
  },
);

test(
  '応答の形の誤り・送れない場合は unavailable、例外にしない',
  OPTIONS,
  async () => {
    const { connector } = setup([
      ok(null),
      ok({ value: 'x' }),
      ok({ value: [], '@odata.nextLink': 42 }),
      { kind: 'not_sent' },
    ]);
    assert.deepEqual(await connector.readAccount(), {
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    assert.deepEqual(await connector.listCategories(), {
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    assert.deepEqual(await connector.listMessagesPage('folder-inbox'), {
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    assert.deepEqual(await connector.listMailFolders(), {
      kind: 'unavailable',
      reason: 'not_sent',
    });
  },
);

test(
  '引数の誤りは例外: pageSize が 0・負・非整数、空の folderId、日時でない条件',
  OPTIONS,
  async () => {
    const { connector, calls } = setup([]);
    for (const pageSize of [0, -1, 1.5])
      await assert.rejects(
        connector.listMessagesPage('folder-inbox', { pageSize }),
        TypeError,
      );
    await assert.rejects(connector.listMessages(''), TypeError);
    await assert.rejects(
      connector.listMessages('folder-inbox', {
        modifiedSince: "2026-11-21 or subject eq 'x'",
      }),
      TypeError,
    );
    assert.equal(calls.length, 0);
    // 999 を超える pageSize も丸めずにそのまま送る（範囲は呼び出し側の前提）。
    const large = setup([ok({ value: [] })]);
    await large.connector.listMessagesPage('folder-inbox', { pageSize: 1000 });
    assert.equal(param(large.calls[0]!, '$top'), '1000');
  },
);

test(
  'ページ数の上限: maxPages を超えて nextLink が残れば例外にする',
  OPTIONS,
  async () => {
    const link = (n: number) =>
      `${BASE}/me/mailFolders/folder-inbox/messages?%24skiptoken=${n}`;
    const { connector, calls } = setup(
      [
        ok({ value: [], '@odata.nextLink': link(2) }),
        ok({ value: [], '@odata.nextLink': link(3) }),
      ],
      { maxPages: 2 },
    );
    await assert.rejects(connector.listMessages('folder-inbox'), {
      message: 'ページ数の上限を超えました',
    });
    assert.equal(calls.length, 2);
    // 上限ちょうどで最終ページなら成功する。
    const exact = setup(
      [ok({ value: [], '@odata.nextLink': link(2) }), ok({ value: [] })],
      { maxPages: 2 },
    );
    const result = await exact.connector.listMessages('folder-inbox');
    assert(result.kind === 'ok');
    assert.equal(result.value.pages, 2);
  },
);

test(
  '読み取り専用: 能力は microsoft の Read だけで、書込みを持たない',
  OPTIONS,
  () => {
    const { connector } = setup([]);
    assert.deepEqual(connector.capability, {
      provider: 'microsoft',
      reads: [
        { kind: 'permission', effect_kind: 'Read' },
        { kind: 'mail.message', effect_kind: 'Read' },
      ],
      writes: [],
    });
  },
);

// 合成の添付（Graph の応答の形）。
function rawAttachment(id: string | undefined, extra = {}) {
  return {
    ...(id === undefined ? {} : { id }),
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: 'doc.pdf',
    contentType: 'application/pdf',
    size: 100,
    isInline: false,
    ...extra,
  };
}

test(
  '添付の列挙: nextLink を辿り、種別・サイズ・名前を写し、id の無い項目は数えるだけにする',
  OPTIONS,
  async () => {
    const next = `${BASE}/me/messages/msg-1/attachments?%24skip=5`;
    const { connector, calls } = setup([
      ok({
        value: [
          rawAttachment('att-1'),
          rawAttachment('att-2', {
            '@odata.type': '#microsoft.graph.itemAttachment',
            name: '埋め込みメール',
            contentType: null,
            size: 200,
          }),
          rawAttachment(undefined),
          rawAttachment('att-3', { name: undefined, size: 10 }),
          rawAttachment('att-4', {
            '@odata.type': '#microsoft.graph.referenceAttachment',
            name: '共有リンク',
            contentType: null,
            size: null,
          }),
        ],
        '@odata.nextLink': next,
      }),
      ok({
        value: [
          rawAttachment('att-5', {
            name: 'note.txt',
            contentType: 'text/plain',
            size: 5,
          }),
        ],
      }),
    ]);
    assert.deepEqual(await connector.listAttachments('msg-1'), {
      kind: 'ok',
      value: {
        attachments: [
          {
            attachment_id: 'att-1',
            name: 'doc.pdf',
            content_type: 'application/pdf',
            size_bytes: 100,
            is_inline: false,
            type: 'file',
          },
          {
            attachment_id: 'att-2',
            name: '埋め込みメール',
            content_type: null,
            size_bytes: 200,
            is_inline: false,
            type: 'item',
          },
          {
            attachment_id: 'att-3',
            name: '',
            content_type: 'application/pdf',
            size_bytes: 10,
            is_inline: false,
            type: 'file',
          },
          {
            attachment_id: 'att-4',
            name: '共有リンク',
            content_type: null,
            size_bytes: null,
            is_inline: false,
            type: 'reference',
          },
          {
            attachment_id: 'att-5',
            name: 'note.txt',
            content_type: 'text/plain',
            size_bytes: 5,
            is_inline: false,
            type: 'file',
          },
        ],
        skipped_without_id: 1,
        pages: 2,
      },
    });
    assert.equal(calls.length, 2);
    // 一覧では内容（contentBytes）を要求しない（最小の select）。
    assert.equal(
      calls[0]!.url,
      'https://graph.microsoft.com/v1.0/me/messages/msg-1/attachments?%24select=id%2Cname%2CcontentType%2Csize%2CisInline&%24top=100',
    );
    assert.equal(calls[1]!.url, next);
  },
);

test(
  '添付の個別取得: contentBytes を復号し、申告サイズと一致するものだけを返す',
  OPTIONS,
  async () => {
    const { connector, calls } = setup([
      ok(
        rawAttachment('att-1', {
          name: 'note.txt',
          contentType: 'text/plain',
          size: 5,
          contentBytes: 'aGVsbG8=',
        }),
      ),
    ]);
    const result = await connector.getAttachment('msg-1', 'att-1');
    assert(result.kind === 'ok');
    assert.equal(result.value.size_bytes, 5);
    assert.deepEqual(
      result.value.data,
      new Uint8Array([104, 101, 108, 108, 111]),
    );
    assert.equal(
      calls[0]!.url,
      'https://graph.microsoft.com/v1.0/me/messages/msg-1/attachments/att-1',
    );
  },
);

test(
  '添付の個別取得: 申告サイズと実バイト数が違う・base64 でない・file なのに内容が無い応答は invalid_response',
  OPTIONS,
  async () => {
    const mismatch = setup([
      ok(rawAttachment('att-1', { size: 4, contentBytes: 'aGVsbG8=' })),
    ]);
    assert.deepEqual(await mismatch.connector.getAttachment('msg-1', 'att-1'), {
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    const notBase64 = setup([
      ok(rawAttachment('att-1', { size: 5, contentBytes: 'aGVs bG8=' })),
    ]);
    assert.deepEqual(
      await notBase64.connector.getAttachment('msg-1', 'att-1'),
      { kind: 'unavailable', reason: 'invalid_response' },
    );
    const noContent = setup([ok(rawAttachment('att-1'))]);
    assert.deepEqual(
      await noContent.connector.getAttachment('msg-1', 'att-1'),
      {
        kind: 'unavailable',
        reason: 'invalid_response',
      },
    );
  },
);

test(
  '添付の個別取得: item・reference は内容なし（data: null）で返し、失敗にしない',
  OPTIONS,
  async () => {
    const item = setup([
      ok(
        rawAttachment('att-2', {
          '@odata.type': '#microsoft.graph.itemAttachment',
          name: '埋め込みメール',
          contentType: null,
          size: 200,
        }),
      ),
    ]);
    assert.deepEqual(await item.connector.getAttachment('msg-1', 'att-2'), {
      kind: 'ok',
      value: { data: null, size_bytes: 200 },
    });
  },
);

test(
  '添付の読み取り: 拒否と認証切れは結果型のまま返し、成功扱いにしない',
  OPTIONS,
  async () => {
    const denied = setup([
      status(403, {
        error: { code: 'ErrorAccessDenied', message: '（合成）拒否' },
      }),
    ]);
    assert.deepEqual(await denied.connector.getAttachment('msg-1', 'att-1'), {
      kind: 'rejected',
      status: 403,
      reason: 'insufficient_permission',
      code: 'ErrorAccessDenied',
    });
    const expired = setup([
      status(401, { error: { code: 'InvalidAuthenticationToken' } }),
    ]);
    assert.deepEqual(await expired.connector.listAttachments('msg-1'), {
      kind: 'authentication_expired',
      status: 401,
      code: 'InvalidAuthenticationToken',
    });
  },
);

// 最後に実行する（node:test はファイル内の試験を順に実行する）。
test(
  '差分取得なし: この試験ファイルで送ったどの要求にも /delta・$deltatoken が無い',
  OPTIONS,
  () => {
    assert(ALL_URLS.length >= 30, String(ALL_URLS.length));
    for (const url of ALL_URLS) {
      assert(!url.includes('/delta'), url);
      assert(!decodeURIComponent(url).includes('$deltatoken'), url);
      assert(!decodeURIComponent(url).includes('$deltaToken'), url);
    }
  },
);
