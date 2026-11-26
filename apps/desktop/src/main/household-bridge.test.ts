// 家計簿の経路（HouseholdBridge。ADR 0162）の試験。接続は模擬（中枢への要求を記録して手で答える）で、世代を手で動かす。
// 期待値（表示用の値・本文・理由）は手で書いた合成の値。実データ・実 API は使わない。
// 確かめること: 画面へ記録の ID・内容版を渡さない、月を指定しなければ中枢の今月を読む、読めなかったことを「記録なし」に
// しない、変更・削除は読んだ内容版を送り、受け付けられたら読み直す、409 は preview_stale、422 は core_rejected、結果不明は
// 送り直さず次の読み取りまで操作させない、後から始めた読み取りに追い越された読み取りは反映しない、世代をまたいだ値は捨てる。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import { createDesktopContract, loadContractSchema } from './contract.js';
import {
  HouseholdBridge,
  decodeHouseholdExport,
  householdImportBatches,
} from './household-bridge.js';
import type { HouseholdHost } from './household-bridge.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const SCOPE = uuid(0x5c);
const LUNCH = uuid(0xc01);
const SALARY = uuid(0xc02);
const NOW = Date.parse('2030-11-05T03:00:00.000Z');

const totals = (month: string, fields: Record<string, number> = {}) => ({
  month,
  expense_yen: 0,
  income_yen: 0,
  balance_yen: 0,
  transfer_yen: 0,
  entry_count: 0,
  unreadable: 0,
  ...fields,
});

const MONTHS = [
  '2030-11',
  '2030-10',
  '2030-09',
  '2030-08',
  '2030-07',
  '2030-06',
  '2030-05',
  '2030-04',
  '2030-03',
  '2030-02',
  '2030-01',
  '2029-12',
];

const overview = () => ({
  time_zone: 'Asia/Tokyo',
  current_month: '2030-11',
  generated_at: '2030-11-05T03:00:00Z',
  months: MONTHS.map((month) =>
    month === '2030-11'
      ? totals(month, {
          expense_yen: 1280,
          income_yen: 200000,
          balance_yen: 198720,
          entry_count: 2,
        })
      : totals(month),
  ),
  truncated: false,
  settings: { mail_intake: 'on', settings_revision: '2' },
});

const lunch = (fields: Record<string, unknown> = {}) => ({
  entry_id: LUNCH,
  content_revision: '3',
  source_kind: 'mail_notice',
  direction: 'expense',
  amount_yen: 1280,
  occurred_on: '2030-11-03',
  occurred_time: '12:34',
  category: 'food',
  merchant: '合成の食堂',
  memo: null,
  payment: '合成のカード',
  created_at: '2030-11-03T03:40:00Z',
  updated_at: '2030-11-04T00:00:00Z',
  ...fields,
});

const salary = () => ({
  entry_id: SALARY,
  content_revision: '1',
  source_kind: 'csv_import',
  direction: 'income',
  amount_yen: 200000,
  occurred_on: '2030-11-01',
  occurred_time: null,
  category: 'income',
  merchant: null,
  memo: '合成の給与',
  payment: null,
  created_at: '2030-11-05T00:00:00Z',
  updated_at: '2030-11-05T00:00:00Z',
});

const monthBody = (
  month = '2030-11',
  entries: unknown[] = [lunch(), salary()],
) => ({
  month,
  entries,
  summary:
    entries.length === 0
      ? {
          expense_yen: 0,
          income_yen: 0,
          balance_yen: 0,
          entry_count: 0,
          expense_by_category: [],
          transfer_yen: 0,
        }
      : {
          expense_yen: 1280,
          income_yen: 200000,
          balance_yen: 198720,
          entry_count: 2,
          expense_by_category: [
            { category: 'food', total_yen: 1280, count: 1 },
          ],
          transfer_yen: 0,
        },
  unreadable: 0,
  truncated: false,
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
  readonly bridge: HouseholdBridge;
  readonly calls: Call[];
  readonly logs: string[];
  overview: () => Outcome;
  month: (month: string) => Outcome;
  post: (call: Call) => Outcome;
  // GET の応答の前に待つ（重なった読み取りの試験）。
  gate: ((call: Call) => Promise<void>) | null;
  scope: string | null;
  posts(): Call[];
}

function rig(): Rig {
  const calls: Call[] = [];
  const logs: string[] = [];
  const state: Rig = {
    calls,
    logs,
    overview: () => ({ kind: 'response', status: 200, body: overview() }),
    month: (month) => ({
      kind: 'response',
      status: 200,
      body: monthBody(month, month === '2030-11' ? undefined : []),
    }),
    post: () => ({ kind: 'unknown' }),
    gate: null,
    scope: SCOPE,
    posts: () => calls.filter((call) => call.method === 'POST'),
    bridge: undefined as unknown as HouseholdBridge,
  };
  const connection = {
    get state() {
      return { commandScopeId: state.scope, phase: 'live' };
    },
    request: async (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (call.method === 'GET' && state.gate !== null) await state.gate(call);
      if (call.method === 'GET' && call.path === '/v1/household/months')
        return state.overview();
      if (call.method === 'GET')
        return state.month(call.path.slice('/v1/household/months/'.length));
      return state.post(call);
    },
  } as unknown as ClientConnection;
  let counter = 0x100;
  const host: HouseholdHost = {
    contract,
    connection: () => connection,
    newRef: () => uuid(counter++),
    now: () => NOW,
    log: (code) => logs.push(code),
  };
  return Object.assign(state, { bridge: new HouseholdBridge(host) });
}

const ok = <T>(outcome: { ok: boolean; value?: T }): T => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.value as T;
};

test('the view carries refs and display values only, and reads the current month decided by the hub', async () => {
  const r = rig();
  const view = ok(await r.bridge.show(null));
  assert.deepEqual(view, {
    fetch: 'loaded',
    fetched_at: '2030-11-05T03:00:00.000Z',
    current_month: '2030-11',
    months: overview().months,
    month: '2030-11',
    entries: [
      {
        ref: uuid(0x100),
        position: 0,
        source_kind: 'mail_notice',
        direction: 'expense',
        amount_yen: 1280,
        occurred_on: '2030-11-03',
        occurred_time: '12:34',
        category: 'food',
        merchant: '合成の食堂',
        memo: null,
        payment: '合成のカード',
        delivery_unknown: false,
      },
      {
        ref: uuid(0x101),
        position: 1,
        source_kind: 'csv_import',
        direction: 'income',
        amount_yen: 200000,
        occurred_on: '2030-11-01',
        occurred_time: null,
        category: 'income',
        merchant: null,
        memo: '合成の給与',
        payment: null,
        delivery_unknown: false,
      },
    ],
    summary: monthBody().summary,
    unreadable: 0,
    truncated: false,
    list_seq: 2,
    mail_intake: 'on',
    last_import: null,
  });
  assert.deepEqual(
    contract.responseErrors({
      request_id: uuid(1),
      channel: 'desktop.household_view',
      outcome: 'ok',
      household: view,
    }),
    [],
  );
  const text = JSON.stringify(view);
  for (const secret of [LUNCH, SALARY, '"3"', 'content_revision', 'created_at'])
    assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(r.calls, [
    { method: 'GET', path: '/v1/household/months', expectedScopeId: SCOPE },
    {
      method: 'GET',
      path: '/v1/household/months/2030-11',
      expectedScopeId: SCOPE,
    },
  ]);
  // 読み直しても同じ記録は同じ参照のまま。別の月を選べばその月を読む。
  const again = ok(await r.bridge.show('2030-11'));
  assert.deepEqual(
    again.entries.map((entry) => entry.ref),
    [uuid(0x100), uuid(0x101)],
  );
  const october = ok(await r.bridge.show('2030-10'));
  assert.equal(october.month, '2030-10');
  assert.deepEqual(october.entries, []);
  assert.equal(r.calls.at(-1)?.path, '/v1/household/months/2030-10');
  // 形の違う月は送らない。
  assert.deepEqual(await r.bridge.show('2030-13'), {
    ok: false,
    reason: 'invalid_request',
  });
});

test('a failed read keeps the last values as stale and never reads as empty', async () => {
  const r = rig();
  r.overview = () => ({ kind: 'response', status: 503, body: {} });
  const first = ok(await r.bridge.show(null));
  assert.equal(first.fetch, 'unavailable');
  assert.equal(first.month, null);
  assert.equal(first.summary, null);
  assert.deepEqual(first.months, []);
  r.overview = () => ({ kind: 'response', status: 200, body: overview() });
  ok(await r.bridge.show(null));
  // 1 か月の読み取りが形の違う応答（別の月）を返した。
  r.month = () => ({
    kind: 'response',
    status: 200,
    body: monthBody('2030-10', []),
  });
  const stale = ok(await r.bridge.show('2030-11'));
  assert.equal(stale.fetch, 'stale');
  assert.equal(stale.month, '2030-11');
  assert.equal(stale.entries.length, 2);
  r.month = () => ({ kind: 'unknown' });
  assert.equal(ok(await r.bridge.show('2030-11')).fetch, 'stale');
  assert.deepEqual(r.logs, [
    'household_unavailable',
    'household_unavailable',
    'household_unavailable',
  ]);
});

test('a category change sends the revision it read, then re-reads the month', async () => {
  const r = rig();
  const view = ok(await r.bridge.show(null));
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: { entry_id: LUNCH, content_revision: '4', rule_learned: true },
  });
  r.month = () => ({
    kind: 'response',
    status: 200,
    body: monthBody('2030-11', [
      lunch({ content_revision: '4', category: 'social' }),
      salary(),
    ]),
  });
  const changed = ok(
    await r.bridge.category(view.entries[0]?.ref as string, 'social'),
  );
  assert.equal(changed.entries[0]?.category, 'social');
  assert.equal(changed.entries[0]?.ref, uuid(0x100));
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: `/v1/household/entries/${LUNCH}/category`,
      body: { expected_content_revision: '3', category: 'social' },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  // 今と同じ分類は送らない。
  ok(await r.bridge.category(uuid(0x100), 'social'));
  assert.equal(r.posts().length, 1);
  // 知らない参照は送らない。
  assert.deepEqual(await r.bridge.category(uuid(0xfff), 'food'), {
    ok: false,
    reason: 'entry_not_found',
  });
});

test('a deletion sends the revision it read and the deleted entry leaves the view', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: { entry_id: LUNCH, state: 'deleted' },
  });
  r.month = () => ({
    kind: 'response',
    status: 200,
    body: {
      ...monthBody('2030-11', [salary()]),
      summary: {
        expense_yen: 0,
        income_yen: 200000,
        balance_yen: 200000,
        entry_count: 1,
        expense_by_category: [],
        transfer_yen: 0,
      },
    },
  });
  const after = ok(await r.bridge.remove(uuid(0x100)));
  assert.deepEqual(
    after.entries.map((entry) => entry.ref),
    [uuid(0x101)],
  );
  assert.deepEqual(r.posts()[0]?.body, { expected_content_revision: '3' });
  assert.equal(r.posts()[0]?.path, `/v1/household/entries/${LUNCH}/delete`);
  // 消えた記録の参照は解決できない。
  assert.deepEqual(await r.bridge.remove(uuid(0x100)), {
    ok: false,
    reason: 'entry_not_found',
  });
});

test('409 is preview_stale and 422 is core_rejected; both re-read without resending', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  for (const [status, reason] of [
    [409, 'preview_stale'],
    [422, 'core_rejected'],
  ] as const) {
    r.post = () => ({ kind: 'response', status, body: { code: 'conflict' } });
    const before = r.calls.length;
    assert.deepEqual(await r.bridge.category(uuid(0x100), 'social'), {
      ok: false,
      reason,
    });
    // 一度だけ送り、読み直しを始めた。
    await new Promise((resolve) => setImmediate(resolve));
    const after = r.calls.slice(before);
    assert.equal(after.filter((call) => call.method === 'POST').length, 1);
    assert(after.some((call) => call.path === '/v1/household/months'));
  }
});

test('an unknown outcome is not resent and holds the entry until a later read succeeds', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  // 結果が分からず、読み直しも失敗する。
  r.post = () => ({ kind: 'unknown' });
  r.overview = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await r.bridge.remove(uuid(0x100)), {
    ok: false,
    reason: 'outcome_unknown',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const held = r.bridge.view();
  assert.equal(held.fetch, 'stale');
  assert.equal(held.entries[0]?.delivery_unknown, true);
  assert.deepEqual(await r.bridge.remove(uuid(0x100)), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(r.posts().length, 1);
  assert(r.logs.includes('household_change_outcome_unknown'));
  // 5xx も結果不明。
  r.overview = () => ({ kind: 'response', status: 200, body: overview() });
  const reread = ok(await r.bridge.show('2030-11'));
  assert.equal(reread.entries[0]?.delivery_unknown, false);
  r.post = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await r.bridge.category(uuid(0x101), 'income'), {
    ok: true,
    value: r.bridge.view(),
  });
  assert.deepEqual(await r.bridge.category(uuid(0x100), 'social'), {
    ok: false,
    reason: 'outcome_unknown',
  });
});

test('a read overtaken by a later read is not applied, and a reset drops everything', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  // 10 月の読み取りの途中で 9 月の読み取りを始める。
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  r.gate = async (call) => {
    if (first && call.path === '/v1/household/months') {
      first = false;
      await held;
    }
  };
  const slow = r.bridge.show('2030-10');
  r.gate = null;
  const fast = ok(await r.bridge.show('2030-09'));
  assert.equal(fast.month, '2030-09');
  release();
  assert.deepEqual(await slow, { ok: false, reason: 'list_superseded' });
  assert.equal(r.bridge.view().month, '2030-09');
  // 世代が進んだら捨てる。またいだ読み取りは反映しない。
  r.gate = async () => {
    r.bridge.reset();
  };
  assert.deepEqual(await r.bridge.show(null), {
    ok: false,
    reason: 'not_connected',
  });
  r.gate = null;
  const reset = r.bridge.view();
  assert.equal(reset.fetch, 'unavailable');
  assert.deepEqual(reset.entries, []);
  assert.equal(reset.month, null);
  // 接続範囲がなければ送らない。
  r.scope = null;
  assert.deepEqual(await r.bridge.show(null), {
    ok: false,
    reason: 'not_connected',
  });
});

test('the intake switch sends the settings revision it read and re-reads; the same value is not sent', async () => {
  const r = rig();
  // まだ読んでいなければ送らない。
  assert.deepEqual(await r.bridge.intake('off'), {
    ok: false,
    reason: 'entry_not_found',
  });
  ok(await r.bridge.show(null));
  ok(await r.bridge.intake('on'));
  assert.equal(r.posts().length, 0);
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: { mail_intake: 'off', settings_revision: '3' },
  });
  r.overview = () => ({
    kind: 'response',
    status: 200,
    body: {
      ...overview(),
      settings: { mail_intake: 'off', settings_revision: '3' },
    },
  });
  const after = ok(await r.bridge.intake('off'));
  assert.equal(after.mail_intake, 'off');
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: '/v1/household/settings',
      body: { expected_settings_revision: '2', mail_intake: 'off' },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(JSON.stringify(after).includes('settings_revision'), false);
  r.post = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'conflict' },
  });
  assert.deepEqual(await r.bridge.intake('on'), {
    ok: false,
    reason: 'preview_stale',
  });
  r.post = () => ({ kind: 'unknown' });
  assert.deepEqual(await r.bridge.intake('on'), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(r.posts().length, 3);
});

const EXPORT_HEADER =
  '"計算対象","日付","内容","金額（円）","保有金融機関","大項目","中項目","メモ","振替","ID"';

const exportText = (rows: readonly string[][]): string =>
  [
    EXPORT_HEADER,
    ...rows.map((cells) => cells.map((cell) => `"${cell}"`).join(',')),
  ].join('\r\n');

test('the export is read as UTF-8 when valid and as Shift_JIS otherwise', () => {
  const text = '日付,内容';
  assert.equal(decodeHouseholdExport(new TextEncoder().encode(text)), text);
  // 「日付」を Shift_JIS で書いたバイト（93 FA 95 74）。
  assert.equal(
    decodeHouseholdExport(new Uint8Array([0x93, 0xfa, 0x95, 0x74])),
    '日付',
  );
  assert.equal(decodeHouseholdExport(new Uint8Array([0xff, 0xff, 0xff])), null);
});

test('batches keep the rows of one day together and follow the date order', () => {
  const row = (day: string, id: string) => ({
    row_id: id,
    content: {
      direction: 'expense' as const,
      amount_yen: 100,
      occurred_on: day,
      occurred_time: null,
      category: 'food',
      merchant: null,
      memo: null,
      payment: null,
    },
    categorized: true,
  });
  const rows = [
    row('2030-10-02', 'a'),
    row('2030-10-01', 'b'),
    row('2030-10-02', 'c'),
    row('2030-10-03', 'd'),
  ];
  assert.deepEqual(
    householdImportBatches(rows, 3).map((batch) =>
      batch.map((item) => item.row_id),
    ),
    [['b', 'a', 'c'], ['d']],
  );
  assert.deepEqual(
    householdImportBatches(rows, 2).map((batch) =>
      batch.map((item) => item.row_id),
    ),
    [['b'], ['a', 'c'], ['d']],
  );
  // 一日の行が上限を超えるときだけ分ける。
  assert.deepEqual(
    householdImportBatches(
      [row('2030-10-01', 'x'), row('2030-10-01', 'y'), row('2030-10-01', 'z')],
      2,
    ).map((batch) => batch.map((item) => item.row_id)),
    [['x', 'y'], ['z']],
  );
});

test('an import sends the rows read from the chosen file, sums the results and re-reads', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  const file = new TextEncoder().encode(
    exportText([
      [
        '1',
        '2030/11/02',
        '合成の食堂',
        '-1280',
        '合成のカード',
        '食費',
        '',
        '',
        '0',
        'mf-1',
      ],
      [
        '0',
        '2030/11/03',
        '合成の売店',
        '-100',
        '合成のカード',
        '食費',
        '',
        '',
        '0',
        'mf-2',
      ],
    ]),
  );
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: {
      created: 1,
      duplicate: 0,
      matched: 0,
      rejected: 0,
      rules_learned: 1,
    },
  });
  const view = ok(await r.bridge.importExport(() => Promise.resolve(file)));
  assert.deepEqual(view.last_import, {
    outcome: 'done',
    created: 1,
    duplicate: 0,
    matched: 0,
    rejected: 0,
    skipped: 1,
    rules_learned: 1,
  });
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: '/v1/household/imports',
      body: {
        origin: 'moneyforward',
        rows: [
          {
            row_id: 'mf-1',
            direction: 'expense',
            amount_yen: 1280,
            occurred_on: '2030-11-02',
            category: 'food',
            merchant: '合成の食堂',
            memo: null,
            payment: '合成のカード',
          },
        ],
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  // 取り込みの後に読み直した。
  assert.equal(r.calls.at(-1)?.method, 'GET');
});

test('a cancelled pick sends nothing, an unreadable file says so, and a failed batch stops without resending', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  const cancelled = ok(
    await r.bridge.importExport(() => Promise.resolve(null)),
  );
  assert.equal(cancelled.last_import, null);
  const unreadable = ok(
    await r.bridge.importExport(() =>
      Promise.resolve(new TextEncoder().encode('日付,内容\n2030/11/01,a')),
    ),
  );
  assert.equal(unreadable.last_import?.outcome, 'unreadable');
  assert.equal(r.posts().length, 0);
  // 2 つの日に分かれた行で、最初の組が成否不明。
  const rows = Array.from({ length: 101 }, (_, i) => [
    '1',
    i < 100 ? '2030/11/02' : '2030/11/03',
    '合成の店',
    '-100',
    '合成のカード',
    '食費',
    '',
    '',
    '0',
    `mf-${String(i)}`,
  ]);
  r.post = () => ({ kind: 'unknown' });
  const stopped = ok(
    await r.bridge.importExport(() =>
      Promise.resolve(new TextEncoder().encode(exportText(rows))),
    ),
  );
  assert.equal(stopped.last_import?.outcome, 'stopped');
  assert.equal(r.posts().length, 1);
  assert(r.logs.includes('household_import_stopped'));
  // 世代が進んだら結果も捨てる。
  r.bridge.reset();
  assert.equal(r.bridge.view().last_import, null);
});
