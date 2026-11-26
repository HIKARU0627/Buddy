// 家計簿の経路（HouseholdBridge。ADR 0162）の試験。接続は模擬（中枢への要求を記録して手で答える）で、世代を手で動かす。
// 期待値（表示用の値・本文・理由）は手で書いた合成の値。実データ・実 API は使わない。
// 確かめること: 画面へ記録の ID・内容版を渡さない、月を指定しなければ中枢の今月を読む、読めなかったことを「記録なし」に
// しない、変更・削除は読んだ内容版を送り、受け付けられたら読み直す、409 は preview_stale、422 は core_rejected、結果不明は
// 送り直さず次の読み取りまで操作させない、後から始めた読み取りに追い越された読み取りは反映しない、世代をまたいだ値は捨てる。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import type { DesktopHouseholdView } from '@buddy/contracts';
import { createDesktopContract, loadContractSchema } from './contract.js';
import {
  HouseholdBridge,
  decodeHouseholdExport,
  householdImportBatches,
} from './household-bridge.js';
import type {
  HouseholdExportSaveResult,
  HouseholdExportSaver,
  HouseholdHost,
  ReceiptImageCodec,
  ReceiptOpenedImage,
} from './household-bridge.js';

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
  recurring: {
    items: [
      {
        merchant: '合成モバイル',
        category: 'communication',
        typical_yen: 3000,
        months_seen: 4,
        last_on: '2030-11-03',
      },
    ],
    monthly_total_yen: 3000,
  },
  budget: {
    budget_revision: '1',
    items: [{ category: 'food', budget_yen: 40000 }],
    total_budget_yen: 40000,
  },
  receipt_reading: 'off',
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
  // 請求予定（ADR 0176）。2030-11 にだけ 1 件ある。記録・集計・書き出しには入らない。
  bills:
    month === '2030-11'
      ? {
          items: [
            { issuer: '合成のカード', amount_yen: 25800, due_on: '2030-11-27' },
          ],
          total_yen: 25800,
          unreadable: 0,
          truncated: false,
        }
      : { items: [], total_yen: 0, unreadable: 0, truncated: false },
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
    receipt_reading: 'off',
    last_import: null,
    last_export: null,
    recurring: overview().recurring,
    bills: {
      items: [
        { issuer: '合成のカード', amount_yen: 25800, due_on: '2030-11-27' },
      ],
      total_yen: 25800,
      unreadable: 0,
      truncated: false,
    },
    budget: {
      items: [{ category: 'food', budget_yen: 40000 }],
      total_budget_yen: 40000,
    },
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

test('a budget change sends the budget revision it read and re-reads', async () => {
  const r = rig();
  assert.deepEqual(await r.bridge.budget([]), {
    ok: false,
    reason: 'entry_not_found',
  });
  ok(await r.bridge.show(null));
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: {
      budget_revision: '2',
      items: [{ category: 'food', budget_yen: 30000 }],
      total_budget_yen: 30000,
    },
  });
  ok(await r.bridge.budget([{ category: 'food', budget_yen: 30000 }]));
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: '/v1/household/budget',
      body: {
        expected_budget_revision: '1',
        items: [{ category: 'food', budget_yen: 30000 }],
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(
    JSON.stringify(r.bridge.view()).includes('budget_revision'),
    false,
  );
  r.post = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'conflict' },
  });
  assert.deepEqual(await r.bridge.budget([]), {
    ok: false,
    reason: 'preview_stale',
  });
  r.post = () => ({ kind: 'unknown' });
  assert.deepEqual(await r.bridge.budget([]), {
    ok: false,
    reason: 'outcome_unknown',
  });
});

test('a manual entry is sent as typed and the month of the entry is read', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  const entry = {
    direction: 'expense' as const,
    amount_yen: 680,
    occurred_on: '2030-10-04',
    occurred_time: null,
    category: 'food' as const,
    merchant: '合成のパン屋',
    memo: '現金',
    payment: null,
  };
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: {
      ...entry,
      entry_id: uuid(0xc09),
      content_revision: '1',
      source_kind: 'manual',
      created_at: '2030-11-05T00:00:00Z',
      updated_at: '2030-11-05T00:00:00Z',
    },
  });
  const view = ok(await r.bridge.add(entry));
  assert.equal(view.month, '2030-10');
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: '/v1/household/entries',
      body: { entry },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(r.calls.at(-1)?.path, '/v1/household/months/2030-10');
  r.post = () => ({
    kind: 'response',
    status: 422,
    body: { code: 'invalid_input' },
  });
  assert.deepEqual(await r.bridge.add(entry), {
    ok: false,
    reason: 'core_rejected',
  });
  r.post = () => ({ kind: 'unknown' });
  assert.deepEqual(await r.bridge.add(entry), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(r.posts().length, 3);
});

const EDITED = {
  direction: 'expense' as const,
  amount_yen: 1500,
  occurred_on: '2030-11-02',
  occurred_time: '09:05',
  category: 'social' as const,
  merchant: '合成の食堂',
  memo: '直した',
  payment: null,
};

test('a content edit sends the revision it read and the typed entry, then re-reads the month of the entry', async () => {
  const r = rig();
  const view = ok(await r.bridge.show(null));
  const lunchRef = view.entries[0]?.ref as string;
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: lunch({
      ...EDITED,
      content_revision: '4',
      updated_at: '2030-11-05T00:00:00Z',
    }),
  });
  r.month = () => ({
    kind: 'response',
    status: 200,
    body: monthBody('2030-11', [
      lunch({ ...EDITED, content_revision: '4' }),
      salary(),
    ]),
  });
  const changed = ok(await r.bridge.edit(lunchRef, EDITED));
  assert.equal(changed.entries[0]?.amount_yen, 1500);
  assert.equal(changed.entries[0]?.memo, '直した');
  assert.equal(changed.entries[0]?.ref, lunchRef);
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: `/v1/household/entries/${LUNCH}/content`,
      body: { expected_content_revision: '3', entry: EDITED },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(r.calls.at(-1)?.path, '/v1/household/months/2030-11');
  // 内容版は画面へ出さない。
  assert.doesNotMatch(JSON.stringify(changed), /content_revision|"3"|"4"/u);
});

test('a content edit that moves the date reads the month it moved to', async () => {
  const r = rig();
  const view = ok(await r.bridge.show(null));
  const moved = { ...EDITED, occurred_on: '2030-10-30' };
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: lunch({ ...moved, content_revision: '4' }),
  });
  r.month = (month) => ({
    kind: 'response',
    status: 200,
    body: monthBody(
      month,
      month === '2030-10' ? [lunch({ ...moved, content_revision: '4' })] : [],
    ),
  });
  const after = ok(await r.bridge.edit(view.entries[0]?.ref as string, moved));
  assert.equal(after.month, '2030-10');
  assert.equal(after.entries[0]?.occurred_on, '2030-10-30');
  assert.equal(r.calls.at(-1)?.path, '/v1/household/months/2030-10');
});

test('a content edit answered with 409 is preview_stale and with 422 core_rejected; both re-read the shown month without resending', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  for (const [status, reason] of [
    [409, 'preview_stale'],
    [422, 'core_rejected'],
  ] as const) {
    r.post = () => ({ kind: 'response', status, body: { code: 'conflict' } });
    const before = r.calls.length;
    assert.deepEqual(await r.bridge.edit(uuid(0x100), EDITED), {
      ok: false,
      reason,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const after = r.calls.slice(before);
    assert.equal(after.filter((call) => call.method === 'POST').length, 1);
    assert(after.some((call) => call.path === '/v1/household/months'));
    assert(after.some((call) => call.path === '/v1/household/months/2030-11'));
  }
});

test('a content edit with an unknown outcome is not resent and holds the entry until a later read succeeds', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  // 届いたか分からない。読み直しも失敗する。
  r.post = () => ({ kind: 'unknown' });
  r.overview = () => ({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await r.bridge.edit(uuid(0x100), EDITED), {
    ok: false,
    reason: 'outcome_unknown',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.bridge.view().entries[0]?.delivery_unknown, true);
  assert.deepEqual(await r.bridge.edit(uuid(0x100), EDITED), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(r.posts().length, 1);
  assert(r.logs.includes('household_change_outcome_unknown'));
  // 次の読み取りが成功すれば操作できる。5xx と形の違う 2xx も結果不明。
  r.overview = () => ({ kind: 'response', status: 200, body: overview() });
  ok(await r.bridge.show('2030-11'));
  for (const outcome of [
    { kind: 'response', status: 503, body: {} },
    { kind: 'response', status: 200, body: { entry_id: LUNCH } },
  ] as const) {
    r.post = () => outcome;
    assert.deepEqual(await r.bridge.edit(uuid(0x100), EDITED), {
      ok: false,
      reason: 'outcome_unknown',
    });
    await new Promise((resolve) => setImmediate(resolve));
    ok(await r.bridge.show('2030-11'));
  }
});

test('a content edit of an unknown reference or without a scope sends nothing, and one that crosses a reset is an unknown outcome', async () => {
  const r = rig();
  ok(await r.bridge.show(null));
  assert.deepEqual(await r.bridge.edit(uuid(0xfff), EDITED), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(r.posts().length, 0);
  // 送った後にロック・切断で世代が進んだら、当たったか分からないので結果不明（送り直さない）。
  r.post = () => {
    r.bridge.reset();
    return {
      kind: 'response',
      status: 200,
      body: lunch({ ...EDITED, content_revision: '4' }),
    };
  };
  assert.deepEqual(await r.bridge.edit(uuid(0x100), EDITED), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(r.posts().length, 1);
  // 読み直したあとで接続範囲がなければ送らない。
  ok(await r.bridge.show(null));
  r.scope = null;
  assert.deepEqual(await r.bridge.edit(uuid(0x100), EDITED), {
    ok: false,
    reason: 'not_connected',
  });
  assert.equal(r.posts().length, 1);
});

// --- 記録の CSV への書き出し（ADR 0172）。期待値の CSV は手で書いた文字列。 ---

const EXPORT_HEADER_LINE =
  '計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID,時刻,向き,出所の種類';

interface Saved {
  name: string;
  text: string;
  stillValid: boolean;
}

// 保存先の選択の模擬。呼ばれた内容を記録し、決めた結果を返す。
function saver(
  result: HouseholdExportSaveResult | 'throw' = 'saved',
  during: () => void = () => undefined,
) {
  const saved: Saved[] = [];
  const save = (file: {
    name: string;
    text: string;
    stillValid: () => boolean;
  }): Promise<HouseholdExportSaveResult> => {
    during();
    const stillValid = file.stillValid();
    saved.push({ name: file.name, text: file.text, stillValid });
    // 本物の保存の処理と同じく、書く直前に世代が進んでいたら何も書かず 'cancelled' を返す。
    if (!stillValid) return Promise.resolve('cancelled');
    if (result === 'throw') return Promise.reject(new Error('disk'));
    return Promise.resolve(result);
  };
  return { saved, save };
}

test('export: reads each month with the existing read, writes a hand-checked CSV, and keeps no plaintext in the view', async () => {
  const r = rig();
  const s = saver();
  const view = ok(await r.bridge.exportCsv('2030-10', '2030-11', s.save));
  // 月ごとの読み取りだけ（月ごとの合計・書き込みは送らない）。古い月から。
  assert.deepEqual(r.calls, [
    {
      method: 'GET',
      path: '/v1/household/months/2030-10',
      expectedScopeId: SCOPE,
    },
    {
      method: 'GET',
      path: '/v1/household/months/2030-11',
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(s.saved.length, 1);
  assert.equal(s.saved[0]?.name, 'buddy-household-2030-10_2030-11.csv');
  assert.equal(s.saved[0]?.stillValid, true);
  // 日付の古い順（給与 11/01、昼食 11/03）。支出は負、収入は正。時刻は昼食だけ。BOM と CRLF。
  assert.equal(
    s.saved[0]?.text,
    `\uFEFF${EXPORT_HEADER_LINE}\r\n` +
      '1,2030/11/01,,200000,,収入,,合成の給与,0,buddy:00000000-0000-4000-8000-000000000c02,,収入,書き出しの取り込み\r\n' +
      '1,2030/11/03,合成の食堂,-1280,合成のカード,食費,,,0,buddy:00000000-0000-4000-8000-000000000c01,12:34,支出,利用通知メール\r\n',
  );
  assert.deepEqual(view.last_export, {
    outcome: 'saved',
    months: 2,
    entries: 2,
    truncated_months: 0,
    unreadable: 0,
  });
  // 画面の値に記録も保存先も入らない（書き出しは今の表示を読み込まない）。
  assert.equal(view.fetch, 'unavailable');
  assert.deepEqual(view.entries, []);
  const text = JSON.stringify(view);
  for (const plain of ['合成の食堂', '合成の給与', LUNCH, 'buddy:', '1280'])
    assert.equal(text.includes(plain), false, plain);
  assert.deepEqual(
    contract.responseErrors({
      request_id: uuid(1),
      channel: 'desktop.household_export',
      outcome: 'ok',
      household: view,
    }),
    [],
  );
  assert.deepEqual(r.logs, []);
  // 次の書き出しを始めると、前の結果は消える（やめたときに古い結果を見せない）。
  const cancelled = saver('cancelled');
  const after = ok(
    await r.bridge.exportCsv('2030-11', '2030-11', cancelled.save),
  );
  assert.equal(after.last_export, null);
  assert.equal(cancelled.saved[0]?.name, 'buddy-household-2030-11.csv');
});

test('export: an empty range writes a header-only file; the same month alone has one name', async () => {
  const r = rig();
  r.month = (month) => ({
    kind: 'response',
    status: 200,
    body: monthBody(month, []),
  });
  const s = saver();
  const view = ok(await r.bridge.exportCsv('2030-01', '2030-03', s.save));
  assert.equal(s.saved[0]?.text, `\uFEFF${EXPORT_HEADER_LINE}\r\n`);
  assert.equal(s.saved[0]?.name, 'buddy-household-2030-01_2030-03.csv');
  assert.deepEqual(view.last_export, {
    outcome: 'saved',
    months: 3,
    entries: 0,
    truncated_months: 0,
    unreadable: 0,
  });
  assert.equal(r.calls.length, 3);
});

test('export: a truncated month or unreadable records write no file and say why', async () => {
  const r = rig();
  r.month = (month) => ({
    kind: 'response',
    status: 200,
    body:
      month === '2030-10'
        ? { ...monthBody(month, []), truncated: true }
        : month === '2030-11'
          ? { ...monthBody(month), unreadable: 2 }
          : monthBody(month, []),
  });
  const s = saver();
  const view = ok(await r.bridge.exportCsv('2030-09', '2030-11', s.save));
  assert.equal(s.saved.length, 0);
  assert.deepEqual(view.last_export, {
    outcome: 'incomplete',
    months: 3,
    entries: 2,
    truncated_months: 1,
    unreadable: 2,
  });
  assert.deepEqual(r.logs, []);
});

test('export: a month that cannot be read, or reads inconsistently, writes no file', async () => {
  const bad: Record<string, (month: string) => Outcome> = {
    '503': () => ({ kind: 'response', status: 503, body: {} }),
    unknown: () => ({ kind: 'unknown' }),
    'wrong shape': () => ({
      kind: 'response',
      status: 200,
      body: { month: '2030-11' },
    }),
    'other month': () => ({
      kind: 'response',
      status: 200,
      body: monthBody('2030-09', []),
    }),
    'entry outside the month': (month) => ({
      kind: 'response',
      status: 200,
      body: monthBody(month, [lunch({ occurred_on: '2030-12-01' })]),
    }),
    'same entry twice': (month) => ({
      kind: 'response',
      status: 200,
      body: monthBody(month, [lunch(), lunch()]),
    }),
    'impossible date': (month) => ({
      kind: 'response',
      status: 200,
      body: monthBody(month, [lunch({ occurred_on: '2030-11-31' })]),
    }),
  };
  for (const [name, outcome] of Object.entries(bad)) {
    const r = rig();
    // 10 月は読めて、11 月で問題が起きる（途中で止まる）。
    r.month = (month) =>
      month === '2030-11'
        ? outcome(month)
        : { kind: 'response', status: 200, body: monthBody(month, []) };
    const s = saver();
    const view = ok(await r.bridge.exportCsv('2030-10', '2030-11', s.save));
    assert.equal(s.saved.length, 0, name);
    assert.equal(view.last_export?.outcome, 'read_failed', name);
    // 日付が暦にない記録は、読んだ後の CSV を作る段階で見つかる（2 か月とも読めている）。
    assert.equal(
      view.last_export?.months,
      name === 'impossible date' ? 2 : 1,
      name,
    );
    assert.deepEqual(r.logs, ['household_export_read_failed'], name);
  }
});

test('export: cancelling the save leaves no result; a write failure or exception is reported and logged', async () => {
  const r = rig();
  const cancelled = saver('cancelled');
  const none = ok(
    await r.bridge.exportCsv('2030-11', '2030-11', cancelled.save),
  );
  assert.equal(none.last_export, null);
  assert.equal(cancelled.saved.length, 1);
  assert.deepEqual(r.logs, []);
  // 結果の種類ごとに、手で書いた結果の種類とログのコードになる。例外は、保存先の状態が分からないので「残っているかもしれない」。
  const expectations: ReadonlyArray<
    readonly [
      HouseholdExportSaveResult | 'throw',
      NonNullable<DesktopHouseholdView['last_export']>['outcome'],
    ]
  > = [
    ['failed_removed', 'write_failed'],
    ['failed_unchanged', 'write_failed_unchanged'],
    ['failed_left', 'write_failed_left'],
    ['link_refused', 'link_refused'],
    ['throw', 'write_failed_left'],
  ];
  for (const [result, outcome] of expectations) {
    const s = saver(result);
    const view = ok(await r.bridge.exportCsv('2030-11', '2030-11', s.save));
    assert.deepEqual(
      view.last_export,
      {
        outcome,
        months: 1,
        entries: 2,
        truncated_months: 0,
        unreadable: 0,
      },
      result,
    );
  }
  assert.deepEqual(r.logs, [
    'household_export_write_failed',
    'household_export_write_failed',
    'household_export_write_failed',
    'household_export_write_failed',
    'household_export_write_failed',
  ]);
  // ログに記録も保存先も入らない（コードだけ）。
  assert.equal(r.logs.join('').includes('合成'), false);
});

test('export: locking or disconnecting while writing still returns the write result (the file exists), and drops the data', async () => {
  for (const [result, outcome, logs] of [
    ['saved', 'saved', []],
    ['failed_left', 'write_failed_left', ['household_export_write_failed']],
  ] as const) {
    const r = rig();
    const s = saver(result);
    // 書き終えた後（保存の処理が返った後）に切断する。
    const save: HouseholdExportSaver = async (file) => {
      const written = await s.save(file);
      r.bridge.reset();
      return written;
    };
    const view = ok(await r.bridge.exportCsv('2030-11', '2030-11', save));
    assert.deepEqual(
      view.last_export,
      { outcome, months: 1, entries: 2, truncated_months: 0, unreadable: 0 },
      result,
    );
    assert.deepEqual(r.logs, logs, result);
    // 新しい世代の状態には結果を残さず、読んだ記録も持たない。
    assert.equal(r.bridge.view().last_export, null);
    assert.deepEqual(r.bridge.view().entries, []);
  }
});

test('export: a bad range or no connection sends nothing and writes nothing', async () => {
  const r = rig();
  r.month = (month) => ({
    kind: 'response',
    status: 200,
    body: monthBody(month, []),
  });
  const s = saver();
  for (const [from, to] of [
    ['2030-12', '2030-11'],
    ['2020-11', '2030-11'],
    ['1999-12', '2000-01'],
    ['2099-12', '2100-01'],
    ['2030-1', '2030-11'],
    ['2030-11', '2030-13'],
  ] as const)
    assert.deepEqual(await r.bridge.exportCsv(from, to, s.save), {
      ok: false,
      reason: 'invalid_request',
    });
  assert.equal(r.calls.length, 0);
  // ちょうど 120 か月は読める（上限）。
  const ten = ok(await r.bridge.exportCsv('2021-01', '2030-12', s.save));
  assert.equal(ten.last_export?.months, 120);
  assert.equal(r.calls.length, 120);
  const before = r.calls.length;
  r.scope = null;
  assert.deepEqual(await r.bridge.exportCsv('2030-11', '2030-11', s.save), {
    ok: false,
    reason: 'not_connected',
  });
  assert.equal(r.calls.length, before);
  assert.equal(s.saved.length, 1);
});

test('export: locking or disconnecting while reading or choosing the place writes nothing and drops the data', async () => {
  // 読んでいる最中（2 か月目の応答の前）に世代が進む: 保存先を出さない。
  const reading = rig();
  let count = 0;
  reading.gate = () => {
    count += 1;
    if (count === 2) reading.bridge.reset();
    return Promise.resolve();
  };
  const first = saver();
  assert.deepEqual(
    await reading.bridge.exportCsv('2030-10', '2030-11', first.save),
    { ok: false, reason: 'not_connected' },
  );
  assert.equal(first.saved.length, 0);
  assert.equal(reading.bridge.view().last_export, null);
  // 保存先を選んでいる間に世代が進む: stillValid が false になり、結果は残さない。
  const choosing = rig();
  const second = saver('saved', () => choosing.bridge.reset());
  assert.deepEqual(
    await choosing.bridge.exportCsv('2030-11', '2030-11', second.save),
    { ok: false, reason: 'not_connected' },
  );
  assert.equal(second.saved[0]?.stillValid, false);
  assert.equal(choosing.bridge.view().last_export, null);
});

// --- レシートの写真の読み取り（ADR 0177） ---
// 写真は合成のバイト列（JPEG・PNG の頭と縦横だけ）。縮める口（codec）は模擬で、渡された段（長い辺・品質）を記録し、決めた
// 大きさの合成の JPEG を返す。実際の画像・実 API は使わない。

const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];

function syntheticJpeg(width: number, height: number, size = 0): Uint8Array {
  const head = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
    ...be16(8),
    1,
    1,
    0,
    0,
    0x3f,
    0,
    0xff,
    0xd9,
  ];
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head);
  return out;
}

class MockCodec implements ReceiptImageCodec {
  readonly opened: Uint8Array[] = [];
  readonly steps: [number, number][] = [];
  readonly outputs: Uint8Array[] = [];
  // 段ごとに返すバイト数（足りなければ最後の値）。
  sizes: number[] = [40_000];
  openable = true;
  open(bytes: Uint8Array): ReceiptOpenedImage | null {
    this.opened.push(new Uint8Array(bytes));
    if (!this.openable) return null;
    return {
      width: 3024,
      height: 4032,
      jpeg: (longSide, quality) => {
        this.steps.push([longSide, quality]);
        const size =
          this.sizes[this.steps.length - 1] ?? (this.sizes.at(-1) as number);
        const out = syntheticJpeg(
          Math.round((3024 * longSide) / 4032),
          longSide,
          size,
        );
        this.outputs.push(out);
        return out;
      },
    };
  }
}

const RECEIPT_CANDIDATE = {
  amount_yen: 1280,
  occurred_on: '2030-11-04',
  occurred_time: '12:34',
  merchant: '合成の商店',
  payment: '現金',
};

const receiptRig = async (reading: 'on' | 'off' | 'unavailable' = 'on') => {
  const r = rig();
  r.overview = () => ({
    kind: 'response',
    status: 200,
    body: { ...overview(), receipt_reading: reading },
  });
  ok(await r.bridge.show(null));
  r.calls.length = 0;
  return r;
};

test('receipt setting: turning on asks the OS confirmation first and never sends when declined', async () => {
  const r = await receiptRig('off');
  let asked = 0;
  // 確かめで「やめる」: 送らない。
  assert.deepEqual(
    await r.bridge.receiptSetting('on', () => {
      asked += 1;
      return Promise.resolve(false);
    }),
    { ok: false, reason: 'confirmation_declined' },
  );
  assert.equal(asked, 1);
  assert.deepEqual(r.posts(), []);
  // 確かめの間にロックした（世代が進んだ）: 送らない。
  assert.deepEqual(
    await r.bridge.receiptSetting('on', () => {
      r.bridge.reset();
      return Promise.resolve(true);
    }),
    { ok: false, reason: 'not_connected' },
  );
  assert.deepEqual(r.posts(), []);
  ok(await r.bridge.show(null));
  // 「送る設定にする」: 望む値だけを送り、読み直して今の設定を見せる。
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: { receipt_reading: 'on' },
  });
  r.overview = () => ({
    kind: 'response',
    status: 200,
    body: { ...overview(), receipt_reading: 'on' },
  });
  const view = ok(
    await r.bridge.receiptSetting('on', () => Promise.resolve(true)),
  );
  assert.equal(view.receipt_reading, 'on');
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: '/v1/household/receipt-setting',
      body: { receipt_reading: 'on' },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  // 今と同じ値は送らない。切にするときは確かめを出さない。
  ok(
    await r.bridge.receiptSetting('on', () => {
      throw new Error('not asked');
    }),
  );
  assert.equal(r.posts().length, 1);
  r.post = () => ({ kind: 'unknown' });
  assert.deepEqual(
    await r.bridge.receiptSetting('off', () => {
      throw new Error('not asked');
    }),
    { ok: false, reason: 'outcome_unknown' },
  );
  // 結果不明は送り直さない。
  assert.equal(r.posts().length, 2);
  assert.ok(r.logs.includes('household_receipt_setting_outcome_unknown'));
});

test('receipt setting: without a reader on the hub it cannot be turned on', async () => {
  const r = await receiptRig('unavailable');
  assert.deepEqual(
    await r.bridge.receiptSetting('on', () => {
      throw new Error('not asked');
    }),
    { ok: false, reason: 'core_rejected' },
  );
  ok(await r.bridge.receiptSetting('off', () => Promise.resolve(true)));
  assert.deepEqual(r.posts(), []);
});

test('receipt read: nothing is picked or sent while the setting is off, or when the owner closes the picker', async () => {
  const off = await receiptRig('off');
  let picked = 0;
  const codec = new MockCodec();
  assert.deepEqual(
    ok(
      await off.bridge.readReceipt(
        () => {
          picked += 1;
          return Promise.resolve(syntheticJpeg(3024, 4032));
        },
        codec,
        () => true,
      ),
    ),
    { outcome: 'setting_off', candidate: null, reasons: [] },
  );
  assert.equal(picked, 0);
  const r = await receiptRig('on');
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => Promise.resolve(null),
        codec,
        () => true,
      ),
    ),
    { outcome: 'cancelled', candidate: null, reasons: [] },
  );
  assert.deepEqual(r.posts(), []);
  assert.equal(codec.opened.length, 0);
});

test('receipt read: images over the limits or in other formats are not sent, and the bytes are cleared', async () => {
  const r = await receiptRig('on');
  const codec = new MockCodec();
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => Promise.resolve('too_large'),
        codec,
        () => true,
      ),
    ),
    {
      outcome: 'image_rejected',
      candidate: null,
      reasons: ['image_too_large'],
    },
  );
  const gif = new TextEncoder().encode('GIF89a000000000000000000');
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => Promise.resolve(gif),
        codec,
        () => true,
      ),
    ),
    {
      outcome: 'image_rejected',
      candidate: null,
      reasons: ['image_format_unsupported'],
    },
  );
  assert.ok(gif.every((byte) => byte === 0));
  const huge = syntheticJpeg(12_001, 3000);
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => Promise.resolve(huge),
        codec,
        () => true,
      ),
    ),
    {
      outcome: 'image_rejected',
      candidate: null,
      reasons: ['image_dimensions_too_large'],
    },
  );
  assert.equal(codec.opened.length, 0);
  // 開けない画像。
  codec.openable = false;
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => Promise.resolve(syntheticJpeg(3024, 4032)),
        codec,
        () => true,
      ),
    ),
    {
      outcome: 'image_rejected',
      candidate: null,
      reasons: ['image_unreadable'],
    },
  );
  // どの段でも 180 KiB（184,320 バイト）に収まらない: 4 段を試して送らない。
  codec.openable = true;
  codec.sizes = [184_321];
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => Promise.resolve(syntheticJpeg(3024, 4032)),
        codec,
        () => true,
      ),
    ),
    {
      outcome: 'image_rejected',
      candidate: null,
      reasons: ['image_too_large'],
    },
  );
  assert.deepEqual(codec.steps, [
    [1280, 80],
    [1280, 65],
    [1024, 65],
    [1024, 50],
  ]);
  assert.ok(codec.outputs.every((out) => out.every((byte) => byte === 0)));
  assert.deepEqual(r.posts(), []);
});

test('receipt read: sends the shrunk JPEG once and returns only a candidate, never a record', async () => {
  const r = await receiptRig('on');
  const codec = new MockCodec();
  // 1 段目は 1 バイト多く、2 段目でちょうど上限に収まる。
  codec.sizes = [184_321, 184_320];
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: { result: 'candidate', candidate: RECEIPT_CANDIDATE, reasons: [] },
  });
  const source = syntheticJpeg(3024, 4032, 4096);
  const result = ok(
    await r.bridge.readReceipt(
      () => Promise.resolve(source),
      codec,
      () => true,
    ),
  );
  assert.deepEqual(result, {
    outcome: 'candidate',
    candidate: RECEIPT_CANDIDATE,
    reasons: [],
  });
  assert.deepEqual(
    contract.responseErrors({
      request_id: uuid(1),
      channel: 'desktop.household_receipt_read',
      outcome: 'ok',
      receipt: result,
    }),
    [],
  );
  assert.deepEqual(codec.steps, [
    [1280, 80],
    [1280, 65],
  ]);
  const posts = r.posts();
  assert.equal(posts.length, 1);
  const post = posts[0] as Call;
  assert.equal(post.path, '/v1/household/receipt-readings');
  assert.equal(post.screenOperation, true);
  assert.equal(post.scoped, true);
  // 送った画像は 2 段目の JPEG（長い辺 1280 の合成の JPEG を 184,320 バイトにしたもの）。
  const sent = Buffer.from(
    (post.body?.['image'] as { data_base64: string }).data_base64,
    'base64',
  );
  assert.deepEqual(new Uint8Array(sent), syntheticJpeg(960, 1280, 184_320));
  assert.deepEqual(Object.keys(post.body ?? {}), ['image']);
  // 元の写真も縮めた画像も 0 で埋めて捨てた。記録を作る要求（POST /v1/household/entries）は送っていない。
  assert.ok(source.every((byte) => byte === 0));
  assert.ok(codec.outputs.every((out) => out.every((byte) => byte === 0)));
  assert.equal(
    r.calls.some((call) => call.path === '/v1/household/entries'),
    false,
  );
  // 候補にしなかった理由も渡す。
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: {
      result: 'not_candidate',
      candidate: null,
      reasons: ['currency_not_yen'],
    },
  });
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => Promise.resolve(syntheticJpeg(3024, 4032)),
        new MockCodec(),
        () => true,
      ),
    ),
    {
      outcome: 'not_candidate',
      candidate: null,
      reasons: ['currency_not_yen'],
    },
  );
});

test('receipt read: a lock, stop or disconnect while picking sends nothing; an unknown outcome is not resent', async () => {
  const r = await receiptRig('on');
  // 選ぶ間にロック・入出力の停止があった（main の確かめが false）: 送らない。
  const locked = syntheticJpeg(3024, 4032);
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => Promise.resolve(locked),
        new MockCodec(),
        () => false,
      ),
    ),
    { outcome: 'cancelled', candidate: null, reasons: [] },
  );
  assert.ok(locked.every((byte) => byte === 0));
  // 選ぶ間に世代が進んだ（切断）: 送らない。
  assert.deepEqual(
    ok(
      await r.bridge.readReceipt(
        () => {
          r.bridge.reset();
          return Promise.resolve(syntheticJpeg(3024, 4032));
        },
        new MockCodec(),
        () => true,
      ),
    ),
    { outcome: 'cancelled', candidate: null, reasons: [] },
  );
  assert.deepEqual(r.posts(), []);
  ok(await r.bridge.show(null));
  // 結果不明（届いたか分からない・503・形の違う 200）: 送り直さない。
  const unknowns: Outcome[] = [
    { kind: 'unknown' },
    {
      kind: 'response',
      status: 503,
      body: { code: 'dependency_unavailable' },
    },
    { kind: 'response', status: 200, body: { result: 'candidate' } },
  ];
  for (const answer of unknowns) {
    const before = r.posts().length;
    r.post = () => answer;
    assert.deepEqual(
      await r.bridge.readReceipt(
        () => Promise.resolve(syntheticJpeg(3024, 4032)),
        new MockCodec(),
        () => true,
      ),
      { ok: false, reason: 'outcome_unknown' },
    );
    assert.equal(r.posts().length, before + 1);
  }
  assert.ok(r.logs.includes('household_receipt_outcome_unknown'));
  // 送っている間に世代が進んだ: 結果は渡さない（結果不明）。
  r.post = () => {
    r.bridge.reset();
    return {
      kind: 'response',
      status: 200,
      body: { result: 'candidate', candidate: RECEIPT_CANDIDATE, reasons: [] },
    };
  };
  assert.deepEqual(
    await r.bridge.readReceipt(
      () => Promise.resolve(syntheticJpeg(3024, 4032)),
      new MockCodec(),
      () => true,
    ),
    { ok: false, reason: 'outcome_unknown' },
  );
});

test('receipt read: the hub refusing because of the setting or the budget sends nothing again', async () => {
  const r = await receiptRig('on');
  const read = () =>
    r.bridge.readReceipt(
      () => Promise.resolve(syntheticJpeg(3024, 4032)),
      new MockCodec(),
      () => true,
    );
  r.post = () => ({
    kind: 'response',
    status: 403,
    body: { code: 'external_send_consent_required' },
  });
  r.overview = () => ({
    kind: 'response',
    status: 200,
    body: { ...overview(), receipt_reading: 'off' },
  });
  assert.deepEqual(ok(await read()), {
    outcome: 'setting_off',
    candidate: null,
    reasons: [],
  });
  // 読み直して今の設定（切）を見せる。切になったので次は選ばせもしない。
  assert.equal(r.bridge.view().receipt_reading, 'off');
  const before = r.posts().length;
  assert.equal(ok(await read()).outcome, 'setting_off');
  assert.equal(r.posts().length, before);
  const budget = await receiptRig('on');
  const readBudget = () =>
    budget.bridge.readReceipt(
      () => Promise.resolve(syntheticJpeg(3024, 4032)),
      new MockCodec(),
      () => true,
    );
  budget.post = () => ({
    kind: 'response',
    status: 422,
    body: { code: 'budget_held' },
  });
  assert.equal(ok(await readBudget()).outcome, 'budget_held');
  budget.post = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'conflict' },
  });
  assert.deepEqual(await readBudget(), {
    ok: false,
    reason: 'core_rejected',
  });
  assert.equal(budget.posts().length, 2);
});
