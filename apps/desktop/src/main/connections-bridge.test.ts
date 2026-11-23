// 連携の接続の経路（ConnectionsBridge。B08-02 P3・B09-05、ADR 0142・0145）の試験。接続は模擬（中枢への要求を記録して
// 手で答える）で、世代を手で動かす。期待値（表示用の値・本文・理由）は手で書いた合成の値。実アカウント・実 API は使わない。
// 確かめること: 画面へ接続 ID・版を渡さない、読めなかったことを「接続なし」にしない、取得範囲の変更は一覧で読んだ
// permission_revision を expected_permission_revision にして送り、保存できたら読み直す、409 は読み直して
// preview_stale、結果不明は送り直さず次の読み取りまで変更させない、今の保存値にない対象の追加と範囲外の値は
// 送らずに拒否する、世代をまたいだ読み取りは反映しない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import type { ConnectionTargets } from '@buddy/contracts';
import { ConnectionsBridge } from './connections-bridge.js';
import type { ConnectionsHost } from './connections-bridge.js';
import { createDesktopContract, loadContractSchema } from './contract.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const SCOPE = uuid(0x5c);
const GOOGLE = uuid(0x601);
const MICROSOFT = uuid(0x602);

const googleSummary = (fields: Record<string, unknown> = {}) => ({
  connection_id: GOOGLE,
  provider: 'google',
  status: 'active',
  access: 'read',
  granted_scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  targets: {
    calendar_ids: ['primary'],
    mail_container_ids: ['INBOX'],
    attachment_kinds: ['pdf', 'text'],
    mail_lookback_days: 90,
    calendar_past_days: 30,
    calendar_future_days: 90,
    attachment_max_bytes: 10000000,
  },
  permission_revision: '3',
  scope_revision: '5',
  graph_account: null,
  ...fields,
});

const microsoftSummary = (fields: Record<string, unknown> = {}) => ({
  connection_id: MICROSOFT,
  provider: 'microsoft',
  status: 'needs_attention',
  access: 'read',
  granted_scopes: ['Mail.Read'],
  targets: {
    calendar_ids: [],
    mail_container_ids: ['inbox'],
    attachment_kinds: ['pdf'],
    mail_lookback_days: 30,
    calendar_past_days: 0,
    calendar_future_days: 90,
    attachment_max_bytes: 5000000,
  },
  permission_revision: '1',
  scope_revision: '2',
  graph_account: {
    account_kind: 'work_or_school',
    delegation: 'delegated_user',
    rejection_reason: 'admin_consent_required',
    category_updates: 'display_only',
  },
  ...fields,
});

const listBody = (
  connections: unknown[] = [googleSummary(), microsoftSummary()],
) => ({
  connections,
});

type Outcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' }
  | { kind: 'not_sent'; reason: 'not_connected' };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly scoped?: boolean;
  readonly screenOperation?: boolean;
  readonly expectedScopeId?: string;
}

interface Rig {
  readonly bridge: ConnectionsBridge;
  readonly calls: Call[];
  readonly logs: string[];
  list: () => Outcome;
  put: (call: Call) => Outcome;
  // 選べる対象の読み取り（GET …/target-options。ADR 0145）の答え。
  discover: (call: Call) => Outcome;
  // 中枢への要求の答えを返す前に待つ（途中で世代が変わる状況を作る）。
  delay: (() => Promise<void>) | null;
  scope: string | null;
  puts(): Call[];
}

function rig(): Rig {
  const calls: Call[] = [];
  const logs: string[] = [];
  const state: Rig = {
    calls,
    logs,
    list: () => ({ kind: 'response', status: 200, body: listBody() }),
    put: () => ({ kind: 'unknown' }),
    discover: () => ({ kind: 'unknown' }),
    delay: null,
    scope: SCOPE,
    puts: () => calls.filter((call) => call.method === 'PUT'),
    bridge: undefined as unknown as ConnectionsBridge,
  };
  const connection = {
    get state() {
      return { commandScopeId: state.scope, phase: 'live' };
    },
    request: async (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (state.delay !== null) await state.delay();
      if (call.method === 'GET' && call.path === '/v1/connections')
        return state.list();
      if (call.method === 'GET' && call.path.endsWith('/target-options'))
        return state.discover(call);
      return state.put(call);
    },
  } as unknown as ClientConnection;
  let counter = 0x100;
  const host: ConnectionsHost = {
    contract,
    connection: () => connection,
    newRef: () => uuid(counter++),
    log: (code) => logs.push(code),
  };
  return Object.assign(state, { bridge: new ConnectionsBridge(host) });
}

const fail = (reason: string) => ({ ok: false, reason });

// Google の取得範囲を狭めた変更（対象は今の保存値の部分集合、期間は上限以内）。
const narrower: ConnectionTargets = {
  calendar_ids: [],
  mail_container_ids: ['INBOX'],
  attachment_kinds: ['pdf'],
  mail_lookback_days: 30,
  calendar_past_days: 7,
  calendar_future_days: 30,
  attachment_max_bytes: 1000000,
};

async function listedRig(): Promise<{ r: Rig; googleRef: string }> {
  const r = rig();
  const listed = await r.bridge.list();
  assert.equal(listed.ok, true);
  const google = r.bridge.view().entries[0];
  assert(google !== undefined);
  return { r, googleRef: google.ref };
}

test('before any read the view says unavailable, not "no connections"', () => {
  const r = rig();
  assert.deepEqual(r.bridge.view(), {
    fetch: 'unavailable',
    entries: [],
    list_seq: 1,
  });
});

test('the list gives the screen only refs and display values (no connection id, no revisions)', async () => {
  const r = rig();
  const listed = await r.bridge.list();
  assert.equal(listed.ok, true);
  assert.deepEqual(r.calls, [
    { method: 'GET', path: '/v1/connections', expectedScopeId: SCOPE },
  ]);
  const view = r.bridge.view();
  assert.equal(view.fetch, 'loaded');
  assert.equal(view.entries.length, 2);
  const [google, microsoft] = view.entries as [
    (typeof view.entries)[number],
    (typeof view.entries)[number],
  ];
  assert.deepEqual(
    { ...google, ref: 'r' },
    {
      ref: 'r',
      provider: 'google',
      status: 'active',
      access: 'read',
      granted_scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.readonly',
      ],
      targets: {
        calendar_ids: ['primary'],
        mail_container_ids: ['INBOX'],
        attachment_kinds: ['pdf', 'text'],
        mail_lookback_days: 90,
        calendar_past_days: 30,
        calendar_future_days: 90,
        attachment_max_bytes: 10000000,
      },
      graph_account: null,
      discovery: null,
      delivery_unknown: false,
    },
  );
  assert.deepEqual(
    { ...microsoft, ref: 'r' },
    {
      ref: 'r',
      provider: 'microsoft',
      status: 'needs_attention',
      access: 'read',
      granted_scopes: ['Mail.Read'],
      targets: {
        calendar_ids: [],
        mail_container_ids: ['inbox'],
        attachment_kinds: ['pdf'],
        mail_lookback_days: 30,
        calendar_past_days: 0,
        calendar_future_days: 90,
        attachment_max_bytes: 5000000,
      },
      graph_account: {
        account_kind: 'work_or_school',
        delegation: 'delegated_user',
        rejection_reason: 'admin_consent_required',
        category_updates: 'display_only',
      },
      discovery: null,
      delivery_unknown: false,
    },
  );
  assert.notEqual(google.ref, microsoft.ref);
  assert(!JSON.stringify(view).includes(GOOGLE));
  assert(!JSON.stringify(view).includes(MICROSOFT));
});

test('a failed first read stays unavailable; a failed later read is stale and keeps the entries', async () => {
  const r = rig();
  r.list = () => ({ kind: 'response', status: 503, body: {} });
  const first = await r.bridge.list();
  assert.equal(first.ok, true);
  assert.equal(r.bridge.view().fetch, 'unavailable');
  assert.deepEqual(r.bridge.view().entries, []);

  r.list = () => ({ kind: 'response', status: 200, body: listBody() });
  await r.bridge.list();
  assert.equal(r.bridge.view().fetch, 'loaded');

  r.list = () => ({ kind: 'response', status: 200, body: { wrong: true } });
  await r.bridge.list();
  const view = r.bridge.view();
  assert.equal(view.fetch, 'stale');
  assert.equal(view.entries.length, 2);
});

test('a successful update sends the read permission revision and re-reads the list', async () => {
  const { r, googleRef } = await listedRig();
  r.put = () => ({
    kind: 'response',
    status: 200,
    body: googleSummary({
      targets: narrower,
      permission_revision: '4',
      scope_revision: '6',
    }),
  });
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([
      googleSummary({
        targets: narrower,
        permission_revision: '4',
        scope_revision: '6',
      }),
      microsoftSummary(),
    ]),
  });
  const updated = await r.bridge.updateTargets(googleRef, narrower);
  assert.equal(updated.ok, true);
  // 参照 2 つ（Google・Microsoft）の次に作る参照が request_id になる。
  assert.deepEqual(r.puts(), [
    {
      method: 'PUT',
      path: `/v1/connections/${GOOGLE}/targets`,
      body: {
        request_id: uuid(0x102),
        expected_permission_revision: '3',
        targets: narrower,
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  const view = r.bridge.view();
  assert.equal(view.fetch, 'loaded');
  assert.deepEqual(view.entries[0]?.targets, narrower);
});

test('adding a target that is not saved is refused before sending', async () => {
  const { r, googleRef } = await listedRig();
  const added: ConnectionTargets = {
    ...narrower,
    calendar_ids: ['primary', 'brand-new-calendar'],
  };
  assert.deepEqual(await r.bridge.updateTargets(googleRef, added), {
    ok: false,
    reason: 'invalid_request',
  });
  const addedContainer: ConnectionTargets = {
    ...narrower,
    mail_container_ids: ['INBOX', 'brand-new-label'],
  };
  assert.deepEqual(await r.bridge.updateTargets(googleRef, addedContainer), {
    ok: false,
    reason: 'invalid_request',
  });
  assert.deepEqual(r.puts(), []);
});

test('out-of-range values are refused before sending', async () => {
  const { r, googleRef } = await listedRig();
  for (const targets of [
    { ...narrower, mail_lookback_days: 91 },
    { ...narrower, mail_lookback_days: 0 },
    { ...narrower, calendar_past_days: 31 },
    { ...narrower, calendar_future_days: 91 },
    { ...narrower, attachment_max_bytes: 10000001 },
    { ...narrower, attachment_max_bytes: 0 },
  ])
    assert.deepEqual(await r.bridge.updateTargets(googleRef, targets), {
      ok: false,
      reason: 'invalid_request',
    });
  assert.deepEqual(r.puts(), []);
});

test('an unknown ref and a held connection are entry_not_found', async () => {
  const { r, googleRef } = await listedRig();
  assert.deepEqual(await r.bridge.updateTargets(uuid(0x999), narrower), {
    ok: false,
    reason: 'entry_not_found',
  });
  r.put = () => ({ kind: 'unknown' });
  assert.deepEqual(await r.bridge.updateTargets(googleRef, narrower), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.deepEqual(await r.bridge.updateTargets(googleRef, narrower), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(r.puts().length, 1);
});

test('an unknown outcome holds the connection until a later read succeeds', async () => {
  const { r, googleRef } = await listedRig();
  r.put = () => ({ kind: 'unknown' });
  const unknown = await r.bridge.updateTargets(googleRef, narrower);
  assert.deepEqual(unknown, fail('outcome_unknown'));
  assert.equal(r.bridge.view().entries[0]?.delivery_unknown, true);
  // 読み直せば保留は解け、今の保存値で表示する（変更が当たったかどうかは一覧が示す）。
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([
      googleSummary({
        targets: narrower,
        permission_revision: '4',
        scope_revision: '6',
      }),
      microsoftSummary(),
    ]),
  });
  await r.bridge.list();
  const view = r.bridge.view();
  assert.equal(view.entries[0]?.delivery_unknown, false);
  assert.deepEqual(view.entries[0]?.targets, narrower);
});

test('a 503 from the hub is an unknown outcome, not a success', async () => {
  const { r, googleRef } = await listedRig();
  r.put = () => ({ kind: 'response', status: 503, body: {} });
  // 読み直しも失敗している間は、結果不明のまま変更させない。
  r.list = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await r.bridge.updateTargets(googleRef, narrower), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(r.bridge.view().entries[0]?.delivery_unknown, true);
});

test('a malformed 2xx is an unknown outcome', async () => {
  const { r, googleRef } = await listedRig();
  r.put = () => ({ kind: 'response', status: 200, body: { wrong: true } });
  r.list = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await r.bridge.updateTargets(googleRef, narrower), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(r.bridge.view().entries[0]?.delivery_unknown, true);
});

test('a 409 re-reads and answers preview_stale', async () => {
  const { r, googleRef } = await listedRig();
  r.put = () => ({ kind: 'response', status: 409, body: {} });
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([
      googleSummary({ permission_revision: '9', scope_revision: '9' }),
      microsoftSummary(),
    ]),
  });
  assert.deepEqual(await r.bridge.updateTargets(googleRef, narrower), {
    ok: false,
    reason: 'preview_stale',
  });
  // 読み直した後の版で送り直せる。
  r.put = () => ({
    kind: 'response',
    status: 200,
    body: googleSummary({ permission_revision: '10', scope_revision: '10' }),
  });
  const retried = await r.bridge.updateTargets(googleRef, narrower);
  assert.equal(retried.ok, true);
  assert.equal(
    (r.puts().at(-1)?.body as Record<string, unknown>)[
      'expected_permission_revision'
    ],
    '9',
  );
});

test('a 422 answers core_rejected', async () => {
  const { r, googleRef } = await listedRig();
  r.put = () => ({ kind: 'response', status: 422, body: {} });
  assert.deepEqual(await r.bridge.updateTargets(googleRef, narrower), {
    ok: false,
    reason: 'core_rejected',
  });
  assert.equal(r.bridge.view().entries[0]?.delivery_unknown, false);
});

test('not sent answers not_connected; no scope answers not_connected', async () => {
  const { r, googleRef } = await listedRig();
  r.put = () => ({ kind: 'not_sent', reason: 'not_connected' });
  assert.deepEqual(await r.bridge.updateTargets(googleRef, narrower), {
    ok: false,
    reason: 'not_connected',
  });
  const fresh = rig();
  fresh.scope = null;
  assert.deepEqual(await fresh.bridge.list(), {
    ok: false,
    reason: 'not_connected',
  });
});

test('reset drops the list and a read across the reset is not applied', async () => {
  const r = rig();
  let release: () => void = () => undefined;
  r.delay = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = r.bridge.list();
  r.bridge.reset();
  release();
  const listed = await pending;
  assert.deepEqual(listed, { ok: false, reason: 'not_connected' });
  assert.deepEqual(r.bridge.view(), {
    fetch: 'unavailable',
    entries: [],
    list_seq: 2,
  });
});

// --- 選べる対象（ADR 0145） ---

const googleDiscovery = (fields: Record<string, unknown> = {}) => ({
  connection_id: GOOGLE,
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
      {
        id: 'team-cal@example.invalid',
        display_name: '合成のチーム',
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
  ...fields,
});

test('discover reads the hub once by the connection id and shows the result on that row only', async () => {
  const { r, googleRef } = await listedRig();
  r.discover = () => ({
    kind: 'response',
    status: 200,
    body: googleDiscovery(),
  });
  const before = r.bridge.view().list_seq;
  const found = await r.bridge.discover(googleRef);
  assert.equal(found.ok, true);
  assert.deepEqual(
    r.calls.filter((call) => call.path.endsWith('/target-options')),
    [
      {
        method: 'GET',
        path: `/v1/connections/${GOOGLE}/target-options`,
        expectedScopeId: SCOPE,
      },
    ],
  );
  const view = r.bridge.view();
  assert(view.list_seq > before);
  assert.deepEqual(view.entries[0]?.discovery, {
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
          display_name: '合成のチーム',
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
  });
  assert.equal(view.entries[1]?.discovery, null);
  // 画面の値に接続 ID は出さない。
  assert(!JSON.stringify(view).includes(GOOGLE));
  // 一覧を読み直しても、この世代の結果は残る。
  await r.bridge.list();
  assert.notEqual(r.bridge.view().entries[0]?.discovery, null);
});

test('after discovery a discovered target of the right kind can be added; others are still refused', async () => {
  const { r, googleRef } = await listedRig();
  r.discover = () => ({
    kind: 'response',
    status: 200,
    body: googleDiscovery(),
  });
  await r.bridge.discover(googleRef);
  r.put = () => ({ kind: 'response', status: 200, body: googleSummary() });
  const wider: ConnectionTargets = {
    ...narrower,
    calendar_ids: ['primary', 'team-cal@example.invalid'],
    mail_container_ids: ['INBOX', 'Label_1'],
  };
  const saved = await r.bridge.updateTargets(googleRef, wider);
  assert.equal(saved.ok, true);
  assert.deepEqual(
    (r.puts().at(-1)?.body as Record<string, unknown>)['targets'],
    wider,
  );
  // 一覧に無い ID、種類の違う ID（ラベルをカレンダーへ）は送らない。
  for (const targets of [
    { ...narrower, calendar_ids: ['brand-new-calendar'] },
    { ...narrower, calendar_ids: ['Label_1'] },
    { ...narrower, mail_container_ids: ['team-cal@example.invalid'] },
  ])
    assert.deepEqual(await r.bridge.updateTargets(googleRef, targets), {
      ok: false,
      reason: 'invalid_request',
    });
  assert.equal(r.puts().length, 1);
});

test('a list that was not loaded adds nothing to what can be sent', async () => {
  const { r, googleRef } = await listedRig();
  r.discover = () => ({
    kind: 'response',
    status: 200,
    body: googleDiscovery({
      calendars: { status: 'rejected', options: [] },
      mail_containers: { status: 'unavailable', options: [] },
    }),
  });
  assert.equal((await r.bridge.discover(googleRef)).ok, true);
  assert.deepEqual(
    await r.bridge.updateTargets(googleRef, {
      ...narrower,
      calendar_ids: ['team-cal@example.invalid'],
    }),
    { ok: false, reason: 'invalid_request' },
  );
  assert.deepEqual(r.puts(), []);
});

test('a malformed, mismatched or semantically wrong discovery is not used', async () => {
  const { r, googleRef } = await listedRig();
  for (const body of [
    { wrong: true },
    googleDiscovery({ connection_id: MICROSOFT }),
    googleDiscovery({ provider: 'microsoft' }),
    googleDiscovery({ categories: { status: 'loaded', categories: [] } }),
    googleDiscovery({
      calendars: {
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
    }),
  ]) {
    r.discover = () => ({ kind: 'response', status: 200, body });
    assert.deepEqual(await r.bridge.discover(googleRef), {
      ok: false,
      reason: 'core_rejected',
    });
  }
  assert.equal(r.bridge.view().entries[0]?.discovery, null);
  assert.deepEqual(
    await r.bridge.updateTargets(googleRef, {
      ...narrower,
      calendar_ids: ['team-cal@example.invalid'],
    }),
    { ok: false, reason: 'invalid_request' },
  );
});

test('discover failures: 409 re-reads and is preview_stale, 503 is core_rejected, unknown and not sent are not_connected, a bad ref is entry_not_found', async () => {
  const { r, googleRef } = await listedRig();
  assert.deepEqual(await r.bridge.discover(uuid(0x999)), {
    ok: false,
    reason: 'entry_not_found',
  });
  const reads = () =>
    r.calls.filter((call) => call.path === '/v1/connections').length;
  const before = reads();
  r.discover = () => ({ kind: 'response', status: 409, body: {} });
  assert.deepEqual(await r.bridge.discover(googleRef), fail('preview_stale'));
  assert.equal(reads(), before + 1);
  r.discover = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await r.bridge.discover(googleRef), fail('core_rejected'));
  r.discover = () => ({ kind: 'unknown' });
  assert.deepEqual(await r.bridge.discover(googleRef), fail('not_connected'));
  r.discover = () => ({ kind: 'not_sent', reason: 'not_connected' });
  assert.deepEqual(await r.bridge.discover(googleRef), fail('not_connected'));
  // 読み取りの失敗では行を保留にしない（何も変えていない）。
  assert.equal(r.bridge.view().entries[0]?.delivery_unknown, false);
  assert.deepEqual(r.puts(), []);
});

test('reset drops the discovery and a discovery across the reset is not applied', async () => {
  const { r, googleRef } = await listedRig();
  r.discover = () => ({
    kind: 'response',
    status: 200,
    body: googleDiscovery(),
  });
  await r.bridge.discover(googleRef);
  r.bridge.reset();
  await r.bridge.list();
  const ref = r.bridge.view().entries[0]?.ref ?? '';
  assert.equal(r.bridge.view().entries[0]?.discovery, null);
  // 世代をまたいだ読み取りは反映しない。
  let release: () => void = () => undefined;
  r.delay = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = r.bridge.discover(ref);
  r.bridge.reset();
  release();
  assert.deepEqual(await pending, fail('not_connected'));
  r.delay = null;
  await r.bridge.list();
  assert.equal(r.bridge.view().entries[0]?.discovery, null);
});
