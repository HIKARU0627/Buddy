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

test('削除: 内容版を照合して消し、月から外す。再送・古い版・削除済みは 409、ない記録は 422', async (t) => {
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
  const read = await call(handlers.getHouseholdMonth, { month: '2030-11' });
  assert.deepEqual(
    (read.body['entries'] as Json[]).map((item) => item['entry_id']),
    [kept],
  );
  assert.equal((read.body['summary'] as Json)['expense_yen'], 100);
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
