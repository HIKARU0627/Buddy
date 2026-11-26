// 家計簿の経路（月ごとの合計・1 か月・分類の変更・削除、ADR 0161）の試験。
// DB は一時ディレクトリに作り、保存の命令は同じプロセスで実行する（worker の往復は保存層の試験で確かめている）。
// 経路の検査（端末トークン・自宅判定・接続範囲・ロック・画面操作）は api-route-order.test.ts と契約の api-cases が受け持つ。
// 店名・金額・データ鍵は合成で、実データ・実機は使わない。期待値は ADR 0158・0161 の判断から手で書いた値。

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  HouseholdEntryContent,
  HouseholdSourceParts,
} from '@buddy/domain';
import {
  applyMigrations,
  executeHouseholdOp,
  initStoreGeneration,
  openWriteConnection,
} from '@buddy/storage';
import type {
  DataKeyMaterial,
  DbWorkerClient,
  HouseholdOp,
} from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { createHouseholdRoutes } from './api-household.js';
import type { HouseholdRoutesOptions } from './api-household.js';
import type { ApiRouteHandler } from './api-server.js';
import { recordHouseholdEntry } from './household-ledger.js';
import type { HouseholdPorts } from './household-ledger.js';
import type { JsonObject } from './strict-json.js';

type Json = Record<string, unknown>;

const STORE_GENERATION = '00000000-0000-4000-8000-0000000000aa';
// 日本時間では 2030-11-01 00:30（UTC ではまだ 10 月）。今月は本人のタイムゾーンで 11 月になる。
const NOW = Date.parse('2030-10-31T15:30:00Z');
const ZONE = 'Asia/Tokyo';
const SCOPE = '00000000-0000-4000-8000-000000009002';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const contract = createApiContract();

type Store = Pick<DbWorkerClient, 'household'>;

function withDb(t: test.TestContext): {
  readonly store: Store;
  readonly dataKey: DataKeyMaterial;
  readonly ports: HouseholdPorts;
} {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-household-api-'));
  const db = openWriteConnection(join(dir, 'buddy.db'), { platform: 'macos' });
  applyMigrations(db);
  initStoreGeneration(db, STORE_GENERATION);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = {
    household: (op: HouseholdOp) =>
      Promise.resolve(
        executeHouseholdOp(db, op, { platform: 'macos', halted: false }).result,
      ),
  } as unknown as Store;
  const dataKey: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
  return {
    store,
    dataKey,
    ports: {
      client: store,
      dataKey,
      sha256Hex: (material) =>
        createHash('sha256').update(material, 'utf8').digest('hex'),
      newId: () => randomUUID(),
      now: () => '2030-10-20T00:00:00.000Z',
    },
  };
}

function routes(
  store: Store,
  dataKey: DataKeyMaterial | null,
  over: Partial<HouseholdRoutesOptions> = {},
) {
  return createHouseholdRoutes({
    store,
    dataKey: () => Promise.resolve(dataKey),
    zone: () => ZONE,
    now: () => NOW,
    ...over,
  }).handlers;
}

const call = async (
  handler: ApiRouteHandler,
  params: Readonly<Record<string, string>> = {},
  body: JsonObject | null = null,
): Promise<{ status: number; body: Json }> => {
  const response = await handler({
    route: undefined as never,
    device: null,
    body,
    params,
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  return { status: response.status, body: response.body as Json };
};

let sequence = 0;
const mail = (): HouseholdSourceParts => {
  sequence += 1;
  return {
    kind: 'mail_notice',
    provider: 'google',
    account_id: 'acct-synthetic',
    remote_id: `m-${String(sequence)}`,
    index: 0,
  };
};

const content = (
  over: Partial<HouseholdEntryContent> = {},
): HouseholdEntryContent => ({
  direction: 'expense',
  amount_yen: 1000,
  occurred_on: '2030-11-01',
  occurred_time: null,
  category: 'uncategorized',
  merchant: null,
  memo: null,
  payment: null,
  ...over,
});

async function record(
  ports: HouseholdPorts,
  over: Partial<HouseholdEntryContent> = {},
): Promise<string> {
  const result = await recordHouseholdEntry(ports, mail(), content(over));
  assert.equal(result.outcome, 'created', JSON.stringify(result));
  if (result.outcome !== 'created') throw new Error('unreachable');
  return result.entry_id;
}

const zeroMonth = (month: string) => ({
  month,
  expense_yen: 0,
  income_yen: 0,
  balance_yen: 0,
  transfer_yen: 0,
  entry_count: 0,
  unreadable: 0,
});

const changeBody = (expected: string, category: string): JsonObject => ({
  request_id: '00000000-0000-4000-8000-0000000c0101',
  command_scope_id: SCOPE,
  expected_content_revision: expected,
  category,
});

const deleteBody = (expected: string): JsonObject => ({
  request_id: '00000000-0000-4000-8000-0000000c0102',
  command_scope_id: SCOPE,
  expected_content_revision: expected,
});

test('月ごとの合計: 今月は本人のタイムゾーンで決め、今月から 11 か月前までを新しい月から返す。振替は支出・収入に入れない', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  await record(ports, { amount_yen: 1200, category: 'food' });
  await record(ports, { amount_yen: 300, occurred_on: '2030-11-02' });
  await record(ports, {
    direction: 'income',
    category: 'income',
    amount_yen: 50000,
    occurred_on: '2030-10-25',
  });
  await record(ports, {
    direction: 'transfer',
    category: 'transfer',
    amount_yen: 40000,
    occurred_on: '2030-10-27',
  });
  await record(ports, { amount_yen: 700, occurred_on: '2029-12-31' });
  // 範囲の外（12 か月前）は数えない。
  await record(ports, { amount_yen: 9999, occurred_on: '2029-11-30' });
  const response = await call(routes(store, dataKey).listHouseholdMonths);
  assert.equal(response.status, 200);
  assert(contract.valid('HouseholdOverview', response.body));
  assert.deepEqual(response.body, {
    time_zone: ZONE,
    current_month: '2030-11',
    generated_at: '2030-10-31T15:30:00.000Z',
    months: [
      {
        month: '2030-11',
        expense_yen: 1500,
        income_yen: 0,
        balance_yen: -1500,
        transfer_yen: 0,
        entry_count: 2,
        unreadable: 0,
      },
      {
        month: '2030-10',
        expense_yen: 0,
        income_yen: 50000,
        balance_yen: 50000,
        transfer_yen: 40000,
        entry_count: 2,
        unreadable: 0,
      },
      zeroMonth('2030-09'),
      zeroMonth('2030-08'),
      zeroMonth('2030-07'),
      zeroMonth('2030-06'),
      zeroMonth('2030-05'),
      zeroMonth('2030-04'),
      zeroMonth('2030-03'),
      zeroMonth('2030-02'),
      zeroMonth('2030-01'),
      {
        month: '2029-12',
        expense_yen: 700,
        income_yen: 0,
        balance_yen: -700,
        transfer_yen: 0,
        entry_count: 1,
        unreadable: 0,
      },
    ],
    truncated: false,
    settings: { mail_intake: 'on', settings_revision: '0' },
    recurring: { items: [], monthly_total_yen: 0 },
    budget: { budget_revision: '0', items: [], total_budget_yen: 0 },
  });
});

test('月ごとの合計: 毎月決まって払っている支出を定期の支出として返し、固定費の目安を出す（ADR 0165）', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  for (const day of ['2030-09-27', '2030-10-27', '2030-11-01'])
    await record(ports, {
      amount_yen: 3000,
      occurred_on: day,
      category: 'communication',
      merchant: '合成モバイル',
    });
  // 2 か月だけの店は数えない。
  for (const day of ['2030-10-02', '2030-11-02'])
    await record(ports, {
      amount_yen: 990,
      occurred_on: day,
      merchant: '合成動画',
    });
  const response = await call(routes(store, dataKey).listHouseholdMonths);
  assert(contract.valid('HouseholdOverview', response.body));
  assert.deepEqual(response.body['recurring'], {
    items: [
      {
        merchant: '合成モバイル',
        category: 'communication',
        typical_yen: 3000,
        months_seen: 3,
        last_on: '2030-11-01',
      },
    ],
    monthly_total_yen: 3000,
  });
});

test('月ごとの合計: タイムゾーンが決まらない・読めない・データ鍵がない・範囲が 2000 年より前に出るときは 503', async (t) => {
  const { store, dataKey } = withDb(t);
  const unavailable = {
    code: 'dependency_unavailable',
    message: '中枢が要求を処理できません。',
    request_id: null,
  };
  for (const over of [
    { zone: () => null },
    { zone: () => 'Not/AZone' },
    // 2000 年 11 月からは 11 か月さかのぼると 1999 年になる（中枢の時計の狂い）。
    { now: () => Date.parse('2000-11-15T00:00:00Z') },
  ] satisfies Partial<HouseholdRoutesOptions>[]) {
    const response = await call(
      routes(store, dataKey, over).listHouseholdMonths,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, unavailable);
  }
  const noKey = await call(routes(store, null).listHouseholdMonths);
  assert.equal(noKey.status, 503);
  // 2001 年 11 月なら 2000 年 12 月から読める。
  const edge = await call(
    routes(store, dataKey, { now: () => Date.parse('2001-11-15T00:00:00Z') })
      .listHouseholdMonths,
  );
  assert.equal(edge.status, 200);
  const months = edge.body['months'] as Json[];
  assert.equal(months[0]?.['month'], '2001-11');
  assert.equal(months[11]?.['month'], '2000-12');
});

test('1 か月: 記録を新しい順に返し、出所の識別子を返さない。復号できない記録は数だけ返す', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const lunch = await record(ports, {
    amount_yen: 1280,
    occurred_time: '12:34',
    category: 'food',
    merchant: '合成の食堂',
    payment: '合成のカード',
  });
  const kiosk = await record(ports, {
    amount_yen: 540,
    occurred_on: '2030-11-02',
    merchant: '合成の売店',
  });
  const salary = await record(ports, {
    direction: 'income',
    category: 'income',
    amount_yen: 200000,
    memo: '合成の給与',
  });
  // 別のデータ鍵で作った記録（鍵の作り直しの後に残ったもの）は読めない。
  await recordHouseholdEntry(
    { ...ports, dataKey: { keyId: 'k-other', key: randomBytes(32) } },
    mail(),
    content({ amount_yen: 777 }),
  );
  await record(ports, { amount_yen: 5, occurred_on: '2030-10-31' });
  const response = await call(routes(store, dataKey).getHouseholdMonth, {
    month: '2030-11',
  });
  assert.equal(response.status, 200);
  assert(contract.valid('HouseholdMonth', response.body));
  const entries = response.body['entries'] as Json[];
  // 11-02 の記録、11-01 の時刻なし（時刻のない記録はその日の最後の時刻として並べる）、11-01 12:34 の順。
  assert.deepEqual(
    entries.map((entry) => entry['entry_id']),
    [kiosk, salary, lunch],
  );
  assert.deepEqual(entries[2], {
    entry_id: lunch,
    content_revision: '1',
    source_kind: 'mail_notice',
    direction: 'expense',
    amount_yen: 1280,
    occurred_on: '2030-11-01',
    occurred_time: '12:34',
    category: 'food',
    merchant: '合成の食堂',
    memo: null,
    payment: '合成のカード',
    created_at: '2030-10-20T00:00:00.000Z',
    updated_at: '2030-10-20T00:00:00.000Z',
  });
  assert.deepEqual(response.body['summary'], {
    expense_yen: 1820,
    income_yen: 200000,
    balance_yen: 198180,
    entry_count: 3,
    expense_by_category: [
      { category: 'food', total_yen: 1280, count: 1 },
      { category: 'uncategorized', total_yen: 540, count: 1 },
    ],
    transfer_yen: 0,
  });
  assert.equal(response.body['unreadable'], 1);
  assert.equal(response.body['truncated'], false);
  assert(!JSON.stringify(response.body).includes('acct-synthetic'));
});

test('1 か月: 記録のない月は空で返す。2000〜2099 年の外は 422、データ鍵がなければ 503', async (t) => {
  const { store, dataKey } = withDb(t);
  const empty = await call(routes(store, dataKey).getHouseholdMonth, {
    month: '2031-01',
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, {
    month: '2031-01',
    entries: [],
    summary: {
      expense_yen: 0,
      income_yen: 0,
      balance_yen: 0,
      entry_count: 0,
      expense_by_category: [],
      transfer_yen: 0,
    },
    unreadable: 0,
    truncated: false,
  });
  for (const month of ['1999-12', '2100-01', '2030-13', '']) {
    const response = await call(routes(store, dataKey).getHouseholdMonth, {
      month,
    });
    assert.equal(response.status, 422, month);
    assert.equal(response.body['code'], 'invalid_input');
  }
  const noKey = await call(routes(store, null).getHouseholdMonth, {
    month: '2030-11',
  });
  assert.equal(noKey.status, 503);
});

test('分類の変更: 内容版を照合して変え、店名の規則を覚える。同じ要求の再送・古い版は 409、向きの違う分類・ない記録は 422', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const handlers = routes(store, dataKey);
  const kiosk = await record(ports, { merchant: '合成の売店' });
  const changed = await call(
    handlers.changeHouseholdCategory,
    { entry_id: kiosk },
    changeBody('1', 'daily_goods'),
  );
  assert.equal(changed.status, 200);
  assert(contract.valid('HouseholdCategoryChangeResult', changed.body));
  assert.deepEqual(changed.body, {
    entry_id: kiosk,
    content_revision: '2',
    rule_learned: true,
  });
  // 同じ要求の再送は、内容版が進んでいるので 409（二重に効かない）。
  const resent = await call(
    handlers.changeHouseholdCategory,
    { entry_id: kiosk },
    changeBody('1', 'daily_goods'),
  );
  assert.equal(resent.status, 409);
  assert.deepEqual(resent.body, {
    code: 'conflict',
    message: '内容または状態が変わりました。',
    request_id: '00000000-0000-4000-8000-0000000c0101',
  });
  // 覚えた規則は、次の同じ店の未分類の利用に当たる。
  const next = await recordHouseholdEntry(
    ports,
    mail(),
    content({ merchant: '合成の売店', occurred_on: '2030-11-03' }),
  );
  assert.equal(next.outcome, 'created');
  assert.equal(next.outcome === 'created' && next.rule_applied, true);
  // 店名のない記録は規則を覚えない。
  const plain = await record(ports);
  const noRule = await call(
    handlers.changeHouseholdCategory,
    { entry_id: plain },
    changeBody('1', 'food'),
  );
  assert.deepEqual(noRule.body, {
    entry_id: plain,
    content_revision: '2',
    rule_learned: false,
  });
  // 支出の記録に収入の分類は付けられない。ない記録も 422。
  for (const [entryId, category] of [
    [kiosk, 'income'],
    [MISSING, 'food'],
  ] as const) {
    const response = await call(
      handlers.changeHouseholdCategory,
      { entry_id: entryId },
      changeBody(entryId === kiosk ? '2' : '1', category),
    );
    assert.equal(response.status, 422, category);
    assert.equal(response.body['code'], 'invalid_input');
  }
  // データ鍵がなければ 503。
  const noKey = await call(
    routes(store, null).changeHouseholdCategory,
    { entry_id: kiosk },
    changeBody('2', 'food'),
  );
  assert.equal(noKey.status, 503);
  // 変えた分類で月が読める。
  const read = await call(handlers.getHouseholdMonth, { month: '2030-11' });
  const entry = (read.body['entries'] as Json[]).find(
    (item) => item['entry_id'] === kiosk,
  );
  assert.equal(entry?.['category'], 'daily_goods');
  assert.equal(entry?.['content_revision'], '2');
});

test('削除: 内容版を照合して消し、月から外す。再送・古い版・削除済みは 409、ない記録・内容版 0 は 422', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const handlers = routes(store, dataKey);
  const kept = await record(ports, { amount_yen: 100 });
  const removed = await record(ports, { amount_yen: 900 });
  const stale = await call(
    handlers.deleteHouseholdEntry,
    { entry_id: removed },
    deleteBody('2'),
  );
  assert.equal(stale.status, 409);
  const deleted = await call(
    handlers.deleteHouseholdEntry,
    { entry_id: removed },
    deleteBody('1'),
  );
  assert.equal(deleted.status, 200);
  assert(contract.valid('HouseholdEntryDeleteResult', deleted.body));
  assert.deepEqual(deleted.body, { entry_id: removed, state: 'deleted' });
  const resent = await call(
    handlers.deleteHouseholdEntry,
    { entry_id: removed },
    deleteBody('1'),
  );
  assert.equal(resent.status, 409);
  assert.equal(
    resent.body['request_id'],
    '00000000-0000-4000-8000-0000000c0102',
  );
  // 削除した記録の分類も変えられない。
  const change = await call(
    handlers.changeHouseholdCategory,
    { entry_id: removed },
    changeBody('1', 'food'),
  );
  assert.equal(change.status, 409);
  const missing = await call(
    handlers.deleteHouseholdEntry,
    { entry_id: MISSING },
    deleteBody('1'),
  );
  assert.equal(missing.status, 422);
  // 内容版 0 は契約の形には合うが、保存する版（1 から）にはないので、変更も削除も 422。
  const zeroDelete = await call(
    handlers.deleteHouseholdEntry,
    { entry_id: kept },
    deleteBody('0'),
  );
  assert.equal(zeroDelete.status, 422);
  const zeroChange = await call(
    handlers.changeHouseholdCategory,
    { entry_id: kept },
    changeBody('0', 'food'),
  );
  assert.equal(zeroChange.status, 422);
  const read = await call(handlers.getHouseholdMonth, { month: '2030-11' });
  assert.deepEqual(
    (read.body['entries'] as Json[]).map((item) => item['entry_id']),
    [kept],
  );
  assert.equal((read.body['summary'] as Json)['expense_yen'], 100);
});

test('設定: 取り込みを止める・再開する。版を照合し、古い版・同じ要求の再送は 409（ADR 0163）', async (t) => {
  const { store, dataKey } = withDb(t);
  const handlers = routes(store, dataKey);
  const body = (expected: string, mailIntake: string): JsonObject => ({
    request_id: '00000000-0000-4000-8000-0000000c0103',
    command_scope_id: SCOPE,
    expected_settings_revision: expected,
    mail_intake: mailIntake,
  });
  const off = await call(
    handlers.changeHouseholdSettings,
    {},
    body('0', 'off'),
  );
  assert.equal(off.status, 200);
  assert(contract.valid('HouseholdSettings', off.body));
  assert.deepEqual(off.body, { mail_intake: 'off', settings_revision: '1' });
  const resent = await call(
    handlers.changeHouseholdSettings,
    {},
    body('0', 'off'),
  );
  assert.equal(resent.status, 409);
  assert.equal(
    resent.body['request_id'],
    '00000000-0000-4000-8000-0000000c0103',
  );
  const overview = await call(handlers.listHouseholdMonths);
  assert.deepEqual(overview.body['settings'], {
    mail_intake: 'off',
    settings_revision: '1',
  });
  assert(contract.valid('HouseholdOverview', overview.body));
  const on = await call(handlers.changeHouseholdSettings, {}, body('1', 'on'));
  assert.deepEqual(on.body, { mail_intake: 'on', settings_revision: '2' });
  const bad = await call(
    handlers.changeHouseholdSettings,
    {},
    body('2', 'paused'),
  );
  assert.equal(bad.status, 422);
  // 書込みの成否不明は 503。
  const real = store.household as (op: HouseholdOp) => Promise<unknown>;
  const unknown: Store = {
    household: ((op: HouseholdOp) =>
      op.kind === 'household.settings_set'
        ? Promise.resolve({
            ok: false,
            outcome: 'unknown',
            reasons: ['commit_failed'],
          })
        : real(op)) as Store['household'],
  };
  const lost = await call(
    routes(unknown, dataKey).changeHouseholdSettings,
    {},
    body('2', 'off'),
  );
  assert.equal(lost.status, 503);
});

const importRow = (rowId: string, over: Record<string, unknown> = {}) => ({
  row_id: rowId,
  direction: 'expense',
  amount_yen: 1280,
  occurred_on: '2030-11-03',
  category: 'food',
  merchant: '合成の食堂',
  memo: null,
  payment: '合成のカード',
  ...over,
});

const importBody = (rows: unknown[]): JsonObject =>
  ({
    request_id: '00000000-0000-4000-8000-0000000c0104',
    command_scope_id: SCOPE,
    origin: 'moneyforward',
    rows,
  }) as JsonObject;

test('取り込み: 行を記録し、同じ行は二度記録せず、利用通知と同じ支出は一つの通知に一つだけ取り込まない（ADR 0164）', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const handlers = routes(store, dataKey);
  // 利用通知で記録済みの 1,280 円（11 月 3 日）。
  await record(ports, {
    amount_yen: 1280,
    occurred_on: '2030-11-03',
    merchant: '合成の食堂',
  });
  const rows = [
    // 同じ日・同じ金額の支出が二つ。利用通知は一つなので、一つだけ同じ利用として取り込まない。
    importRow('mf-1'),
    importRow('mf-2', { merchant: '合成の別の店', category: 'social' }),
    importRow('mf-3', {
      direction: 'income',
      category: 'income',
      amount_yen: 250000,
      merchant: '合成の給与',
      payment: '合成の銀行',
    }),
    importRow('mf-4', {
      direction: 'transfer',
      category: 'transfer',
      amount_yen: 40000,
      merchant: null,
      occurred_on: '2030-10-27',
    }),
    // 中身の検査に合わない行（支出に収入の分類）は数えて飛ばす。
    importRow('mf-5', { category: 'income', amount_yen: 10 }),
  ];
  const first = await call(handlers.importHouseholdRows, {}, importBody(rows));
  assert.equal(first.status, 200);
  assert(contract.valid('HouseholdImportResult', first.body));
  assert.deepEqual(first.body, {
    created: 3,
    duplicate: 0,
    matched: 1,
    rejected: 1,
    rules_learned: 1,
  });
  // 取り込み直しても増えない（同じ通知に当たる行はまた取り込まない）。
  const again = await call(handlers.importHouseholdRows, {}, importBody(rows));
  assert.deepEqual(again.body, {
    created: 0,
    duplicate: 3,
    matched: 1,
    rejected: 1,
    rules_learned: 0,
  });
  const november = await call(handlers.getHouseholdMonth, {
    month: '2030-11',
  });
  // 同じ日・同じ作成時刻の記録の並びは決まらないので、並びを問わずに比べる。
  assert.deepEqual(
    (november.body['entries'] as Json[])
      .map((entry) =>
        [entry['source_kind'], entry['amount_yen'], entry['category']].join(
          ' ',
        ),
      )
      .sort(),
    [
      'csv_import 1280 social',
      'csv_import 250000 income',
      'mail_notice 1280 uncategorized',
    ],
  );
  // 取り込みで覚えた規則は、次の同じ店の未分類の利用に当たる。
  const next = await recordHouseholdEntry(
    ports,
    {
      kind: 'mail_notice',
      provider: 'google',
      account_id: 'acct-synthetic',
      remote_id: 'm-rule',
      index: 0,
    },
    content({ merchant: '合成の別の店', occurred_on: '2030-11-04' }),
  );
  assert.equal(next.outcome === 'created' && next.rule_applied, true);
  // 書き出しの元が違う・データ鍵がない。
  const other = await call(handlers.importHouseholdRows, {}, {
    ...importBody(rows),
    origin: 'zaim',
  } as JsonObject);
  assert.equal(other.status, 422);
  const noKey = await call(
    routes(store, null).importHouseholdRows,
    {},
    importBody(rows),
  );
  assert.equal(noKey.status, 503);
  // 一度に 101 行は契約の形が拒否する。
  assert.equal(
    contract.valid(
      'HouseholdImportRequest',
      importBody(
        Array.from({ length: 101 }, (_, i) => importRow(`mf-x-${String(i)}`)),
      ),
    ),
    false,
  );
});

test('予算: 分類ごとの予算を丸ごと差し替え、月ごとの合計で返す。古い版は 409、支出でない分類・同じ分類は 422（ADR 0166）', async (t) => {
  const { store, dataKey } = withDb(t);
  const handlers = routes(store, dataKey);
  const body = (expected: string, items: unknown[]): JsonObject =>
    ({
      request_id: '00000000-0000-4000-8000-0000000c0105',
      command_scope_id: SCOPE,
      expected_budget_revision: expected,
      items,
    }) as JsonObject;
  const set = await call(
    handlers.changeHouseholdBudget,
    {},
    body('0', [
      { category: 'utilities', budget_yen: 12000 },
      { category: 'food', budget_yen: 40000 },
    ]),
  );
  assert.equal(set.status, 200);
  assert(contract.valid('HouseholdBudget', set.body));
  assert.deepEqual(set.body, {
    budget_revision: '1',
    items: [
      { category: 'food', budget_yen: 40000 },
      { category: 'utilities', budget_yen: 12000 },
    ],
    total_budget_yen: 52000,
  });
  const overview = await call(handlers.listHouseholdMonths);
  assert.deepEqual(overview.body['budget'], set.body);
  const stale = await call(handlers.changeHouseholdBudget, {}, body('0', []));
  assert.equal(stale.status, 409);
  for (const items of [
    [{ category: 'income', budget_yen: 1000 }],
    [
      { category: 'food', budget_yen: 1 },
      { category: 'food', budget_yen: 2 },
    ],
  ]) {
    const bad = await call(
      handlers.changeHouseholdBudget,
      {},
      body('1', items),
    );
    assert.equal(bad.status, 422);
  }
  // 空にすれば予算なし。
  const cleared = await call(handlers.changeHouseholdBudget, {}, body('1', []));
  assert.deepEqual(cleared.body, {
    budget_revision: '2',
    items: [],
    total_budget_yen: 0,
  });
  // 別のデータ鍵では予算を開けないので、月ごとの合計も返さない。
  const otherKey = routes(store, { keyId: 'k-other', key: randomBytes(32) });
  assert.equal((await call(otherKey.listHouseholdMonths)).status, 503);
  assert.equal(
    (await call(routes(store, null).changeHouseholdBudget, {}, body('2', [])))
      .status,
    503,
  );
});

test('手入力: 記録を足して返し、同じ要求の再送は二つ目を作らない。分類を選べば店名の規則を覚える（ADR 0167）', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const handlers = routes(store, dataKey);
  const requestId = '00000000-0000-4000-8000-0000000c0106';
  const body = (
    over: Record<string, unknown> = {},
    id = requestId,
  ): JsonObject =>
    ({
      request_id: id,
      command_scope_id: SCOPE,
      entry: {
        direction: 'expense',
        amount_yen: 680,
        occurred_on: '2030-11-04',
        occurred_time: '08:15',
        category: 'food',
        merchant: '合成のパン屋',
        memo: '現金',
        payment: null,
        ...over,
      },
    }) as JsonObject;
  const created = await call(handlers.createHouseholdEntry, {}, body());
  assert.equal(created.status, 200);
  assert(contract.valid('HouseholdEntry', created.body));
  assert.equal(created.body['source_kind'], 'manual');
  assert.equal(created.body['amount_yen'], 680);
  assert.equal(created.body['category'], 'food');
  // 同じ要求の再送は同じ記録を返す。
  const resent = await call(handlers.createHouseholdEntry, {}, body());
  assert.equal(resent.status, 200);
  assert.equal(resent.body['entry_id'], created.body['entry_id']);
  const month = await call(handlers.getHouseholdMonth, { month: '2030-11' });
  assert.equal((month.body['entries'] as Json[]).length, 1);
  // 覚えた規則は、次の同じ店の未分類の利用に当たる。
  const next = await recordHouseholdEntry(
    ports,
    {
      kind: 'mail_notice',
      provider: 'google',
      account_id: 'acct-synthetic',
      remote_id: 'm-bakery',
      index: 0,
    },
    content({ merchant: '合成のパン屋', occurred_on: '2030-11-05' }),
  );
  assert.equal(next.outcome === 'created' && next.rule_applied, true);
  // 向きの違う分類・口座番号らしい店名は 422。
  for (const over of [
    { category: 'income' },
    { merchant: '振込 1234 5678 9012 3456' },
  ]) {
    const bad = await call(
      handlers.createHouseholdEntry,
      {},
      body(over, '00000000-0000-4000-8000-0000000c0107'),
    );
    assert.equal(bad.status, 422);
  }
  // 消した記録の再送は作り直さず 409。
  const removed = await call(
    handlers.deleteHouseholdEntry,
    { entry_id: created.body['entry_id'] as string },
    {
      request_id: '00000000-0000-4000-8000-0000000c0108',
      command_scope_id: SCOPE,
      expected_content_revision: '1',
    },
  );
  assert.equal(removed.status, 200);
  assert.equal(
    (await call(handlers.createHouseholdEntry, {}, body())).status,
    409,
  );
  assert.equal(
    (await call(routes(store, null).createHouseholdEntry, {}, body())).status,
    503,
  );
});

test('成否不明・保存の失敗は 503 にし、成功にも競合にも見せない', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const entry = await record(ports, { merchant: '合成の売店' });
  // 書込みだけ成否不明・失敗にする（読み取りは本物の DB）。
  const real = store.household as (op: HouseholdOp) => Promise<unknown>;
  const failing = (outcome: 'unknown' | 'rejected'): Store => ({
    household: ((op: HouseholdOp) =>
      op.kind === 'household.update' || op.kind === 'household.delete'
        ? Promise.resolve({
            ok: false,
            outcome,
            reasons: [outcome === 'unknown' ? 'commit_failed' : 'store_halted'],
          })
        : real(op)) as Store['household'],
  });
  for (const outcome of ['unknown', 'rejected'] as const) {
    const handlers = routes(failing(outcome), dataKey);
    const change = await call(
      handlers.changeHouseholdCategory,
      { entry_id: entry },
      changeBody('1', 'food'),
    );
    assert.equal(change.status, 503, outcome);
    assert.equal(change.body['code'], 'dependency_unavailable');
    const removal = await call(
      handlers.deleteHouseholdEntry,
      { entry_id: entry },
      deleteBody('1'),
    );
    assert.equal(removal.status, 503, outcome);
  }
  // 読み取りの失敗も 503。
  const broken: Store = {
    household: (() =>
      Promise.resolve({
        ok: false,
        outcome: 'rejected',
        reasons: ['read_failed'],
      })) as unknown as Store['household'],
  };
  assert.equal(
    (await call(routes(broken, dataKey).listHouseholdMonths)).status,
    503,
  );
  assert.equal(
    (
      await call(routes(broken, dataKey).getHouseholdMonth, {
        month: '2030-11',
      })
    ).status,
    503,
  );
});

const contentBody = (
  expected: string,
  over: Record<string, unknown> = {},
): JsonObject =>
  ({
    request_id: '00000000-0000-4000-8000-0000000c0110',
    command_scope_id: SCOPE,
    expected_content_revision: expected,
    entry: {
      direction: 'expense',
      amount_yen: 1500,
      occurred_on: '2030-10-31',
      occurred_time: '09:05',
      category: 'food',
      merchant: '合成のパン屋',
      memo: '直した',
      payment: '現金',
      ...over,
    },
  }) as JsonObject;

test('中身の変更: 金額・日付・店名・分類・メモを直し、月を移し、内容版を進め、店名の規則を覚える（ADR 0169）', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const handlers = routes(store, dataKey);
  const entry = await record(ports, { merchant: '合成の食堂' });
  const changed = await call(
    handlers.changeHouseholdEntry,
    { entry_id: entry },
    contentBody('1'),
  );
  assert.equal(changed.status, 200);
  assert(contract.valid('HouseholdEntry', changed.body));
  assert.equal(changed.body['entry_id'], entry);
  assert.equal(changed.body['content_revision'], '2');
  // 出所の種類は変わらない。
  assert.equal(changed.body['source_kind'], 'mail_notice');
  assert.equal(changed.body['amount_yen'], 1500);
  assert.equal(changed.body['occurred_on'], '2030-10-31');
  assert.equal(changed.body['occurred_time'], '09:05');
  assert.equal(changed.body['category'], 'food');
  assert.equal(changed.body['merchant'], '合成のパン屋');
  assert.equal(changed.body['memo'], '直した');
  assert.equal(changed.body['payment'], '現金');
  // 日付を 10 月に直したので、記録は 10 月へ移った。
  const october = await call(handlers.getHouseholdMonth, { month: '2030-10' });
  assert.deepEqual(
    (october.body['entries'] as Json[]).map((item) => item['entry_id']),
    [entry],
  );
  assert.deepEqual(
    (await call(handlers.getHouseholdMonth, { month: '2030-11' })).body[
      'entries'
    ],
    [],
  );
  // 店名と分類があるので規則を覚え、次の同じ店の未分類の利用に当たる。
  const next = await recordHouseholdEntry(
    ports,
    mail(),
    content({ merchant: '合成のパン屋' }),
  );
  assert.equal(next.outcome === 'created' && next.rule_applied, true);
  // 古い内容版のままの再送は 409（二重に効かない）。
  const replay = await call(
    handlers.changeHouseholdEntry,
    { entry_id: entry },
    contentBody('1', { amount_yen: 9999 }),
  );
  assert.equal(replay.status, 409);
  assert.equal(
    (
      (await call(handlers.getHouseholdMonth, { month: '2030-10' })).body[
        'entries'
      ] as Json[]
    )[0]?.['amount_yen'],
    1500,
  );
  // 分類が未分類なら規則は覚えない。
  const other = await record(ports, { merchant: '合成の薬局' });
  const plain = await call(
    handlers.changeHouseholdEntry,
    { entry_id: other },
    contentBody('1', { merchant: '合成の薬局', category: 'uncategorized' }),
  );
  assert.equal(plain.status, 200);
  const unmatched = await recordHouseholdEntry(
    ports,
    mail(),
    content({ merchant: '合成の薬局' }),
  );
  assert.equal(
    unmatched.outcome === 'created' && unmatched.rule_applied,
    false,
  );
});

test('中身の変更: 内容版の違い・削除済みは 409、向きの違い・検査に合わない中身・ない記録は 422（ADR 0169）', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const handlers = routes(store, dataKey);
  const entry = await record(ports, { merchant: '合成の食堂' });
  const send = (
    id: string,
    body: JsonObject,
  ): Promise<{ status: number; body: Json }> =>
    call(handlers.changeHouseholdEntry, { entry_id: id }, body);
  // 内容版が今と違う。
  assert.equal((await send(entry, contentBody('2'))).status, 409);
  // 向きは変えられない（支出を収入にはできない）。
  const direction = await send(
    entry,
    contentBody('1', { direction: 'income', category: 'income' }),
  );
  assert.equal(direction.status, 422);
  assert.equal(direction.body['code'], 'invalid_input');
  // 検査に合わない中身: 金額 0・向きと違う分類・口座番号らしい店名・存在しない日付・形の違う時刻。
  for (const over of [
    { amount_yen: 0 },
    { category: 'income' },
    { merchant: '振込 1234 5678 9012 3456' },
    { occurred_on: '2030-02-30' },
    { occurred_time: '9:5' },
  ]) {
    assert.equal(
      (await send(entry, contentBody('1', over))).status,
      422,
      JSON.stringify(over),
    );
  }
  // 内容版の形が違う（0 や小数）・ない記録。
  for (const expected of ['0', '1.0']) {
    assert.equal((await send(entry, contentBody(expected))).status, 422);
  }
  assert.equal((await send(MISSING, contentBody('1'))).status, 422);
  // どれも記録は変わっていない。
  const month = await call(handlers.getHouseholdMonth, { month: '2030-11' });
  assert.equal((month.body['entries'] as Json[])[0]?.['content_revision'], '1');
  assert.equal((month.body['entries'] as Json[])[0]?.['amount_yen'], 1000);
  // 削除済みは 409。
  const removed = await call(
    handlers.deleteHouseholdEntry,
    { entry_id: entry },
    deleteBody('1'),
  );
  assert.equal(removed.status, 200);
  assert.equal((await send(entry, contentBody('1'))).status, 409);
});

test('中身の変更: データ鍵が読めない・成否不明・保存の失敗は 503 にし、成功にも競合にも見せない（ADR 0169）', async (t) => {
  const { store, dataKey, ports } = withDb(t);
  const entry = await record(ports, { merchant: '合成の食堂' });
  assert.equal(
    (
      await call(
        routes(store, null).changeHouseholdEntry,
        { entry_id: entry },
        contentBody('1'),
      )
    ).status,
    503,
  );
  const real = store.household as (op: HouseholdOp) => Promise<unknown>;
  for (const outcome of ['unknown', 'rejected'] as const) {
    const failing: Store = {
      household: ((op: HouseholdOp) =>
        op.kind === 'household.update'
          ? Promise.resolve({
              ok: false,
              outcome,
              reasons: [
                outcome === 'unknown' ? 'commit_failed' : 'store_halted',
              ],
            })
          : real(op)) as Store['household'],
    };
    const failed = await call(
      routes(failing, dataKey).changeHouseholdEntry,
      { entry_id: entry },
      contentBody('1'),
    );
    assert.equal(failed.status, 503, outcome);
    assert.equal(failed.body['code'], 'dependency_unavailable');
  }
  // 別のデータ鍵では今の中身を開けないので、変えない（503）。
  const otherKey = routes(store, { keyId: 'k-other', key: randomBytes(32) });
  assert.equal(
    (
      await call(
        otherKey.changeHouseholdEntry,
        { entry_id: entry },
        contentBody('1'),
      )
    ).status,
    503,
  );
});
