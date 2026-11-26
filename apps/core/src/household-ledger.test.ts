// 家計簿の Core の手順の試験（ADR 0158）。DB は一時ディレクトリに作り、保存の命令は同じプロセスで実行する
// （worker の往復は保存層の試験で確かめている）。データ鍵・店名・金額は合成で、実データは使わない。
// 期待値は ADR 0158 の判断（未分類のときだけ規則を当てる・本人の変更を規則として覚える・向きの違う分類を拒む・
// 削除した出所から作り直さない・復号できない記録を集計に入れない）から手で書いた値。

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
  SqliteDatabase,
} from '@buddy/storage';
import {
  HouseholdMerchantKey,
  changeHouseholdCategory,
  deleteHouseholdEntry,
  householdRevisionNumber,
  nextHouseholdRevision,
  readHouseholdMonths,
  recordHouseholdEntry,
} from './household-ledger.js';
import type { HouseholdPorts } from './household-ledger.js';

const STORE_GENERATION = '00000000-0000-4000-8000-0000000000aa';
const NOW = '2030-10-05T09:00:00.000Z';

function withDb(t: test.TestContext): {
  readonly db: SqliteDatabase;
  readonly ports: HouseholdPorts;
} {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-household-'));
  const db = openWriteConnection(join(dir, 'buddy.db'), { platform: 'macos' });
  applyMigrations(db);
  initStoreGeneration(db, STORE_GENERATION);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = {
    household: (op: HouseholdOp) =>
      Promise.resolve(
        executeHouseholdOp(db, op, { platform: 'macos', halted: false }).result,
      ),
  } as unknown as Pick<DbWorkerClient, 'household'>;
  const dataKey: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
  return {
    db,
    ports: {
      client,
      dataKey,
      sha256Hex: (material) =>
        createHash('sha256').update(material, 'utf8').digest('hex'),
      newId: () => randomUUID(),
      now: () => NOW,
    },
  };
}

const mail = (remoteId: string, index = 0): HouseholdSourceParts => ({
  kind: 'mail_notice',
  provider: 'google',
  account_id: 'acct-synthetic',
  remote_id: remoteId,
  index,
});

const expense = (
  over: Partial<HouseholdEntryContent> = {},
): HouseholdEntryContent => ({
  direction: 'expense',
  amount_yen: 1280,
  occurred_on: '2030-10-01',
  occurred_time: '12:30',
  category: 'uncategorized',
  merchant: '合成食堂',
  memo: null,
  payment: '合成カード',
  ...over,
});

async function created(
  ports: HouseholdPorts,
  source: HouseholdSourceParts,
  content: HouseholdEntryContent,
): Promise<string> {
  const result = await recordHouseholdEntry(ports, source, content);
  assert.equal(result.outcome, 'created', JSON.stringify(result));
  if (result.outcome !== 'created') throw new Error('unreachable');
  return result.entry_id;
}

async function month(ports: HouseholdPorts, value: string) {
  const read = await readHouseholdMonths(ports, value, value);
  assert.equal(read.outcome, 'ok');
  if (read.outcome !== 'ok') throw new Error('unreachable');
  const view = read.months[0];
  assert.ok(view);
  return view;
}

test('記録: 同じ出所の二つ目は作らず duplicate を返す。分類の誤りと不正な出所は拒否する', async (t) => {
  const { ports } = withDb(t);
  const id = await created(ports, mail('m-1'), expense());
  assert.deepEqual(await recordHouseholdEntry(ports, mail('m-1'), expense()), {
    outcome: 'duplicate',
    entry_id: id,
    state: 'active',
  });
  // 同じメールの二つ目の利用（index 1）は別の出所。
  await created(ports, mail('m-1', 1), expense({ amount_yen: 300 }));
  assert.deepEqual(
    await recordHouseholdEntry(
      ports,
      mail('m-2'),
      expense({ category: 'salary' }),
    ),
    { outcome: 'rejected', reasons: ['category_invalid'] },
  );
  assert.deepEqual(await recordHouseholdEntry(ports, mail(''), expense()), {
    outcome: 'rejected',
    reasons: ['source_invalid'],
  });
  assert.equal((await month(ports, '2030-10')).entries.length, 2);
});

test('読み取り: 月ごとに新しい日付から並べ、振替を支出から外して集計する。記録のない月も 0 で返す', async (t) => {
  const { ports } = withDb(t);
  await created(ports, mail('a'), expense({ category: 'food' }));
  await created(
    ports,
    mail('b'),
    expense({
      amount_yen: 5000,
      occurred_on: '2030-10-03',
      occurred_time: null,
      category: 'daily_goods',
      merchant: '合成薬局',
    }),
  );
  await created(
    ports,
    mail('c'),
    expense({
      direction: 'income',
      amount_yen: 200000,
      occurred_on: '2030-10-25',
      category: 'income',
      merchant: null,
    }),
  );
  await created(
    ports,
    mail('d'),
    expense({
      direction: 'transfer',
      amount_yen: 40000,
      occurred_on: '2030-10-27',
      category: 'transfer',
      merchant: null,
    }),
  );
  const read = await readHouseholdMonths(ports, '2030-09', '2030-10');
  assert.equal(read.outcome, 'ok');
  if (read.outcome !== 'ok') throw new Error('unreachable');
  assert.deepEqual(
    read.months.map((view) => view.month),
    ['2030-10', '2030-09'],
  );
  const october = read.months[0];
  assert.ok(october);
  assert.deepEqual(
    october.entries.map((entry) => entry.content.amount_yen),
    [40000, 200000, 5000, 1280],
  );
  assert.equal(october.unreadable, 0);
  assert.equal(october.summary.expense_yen, 6280);
  assert.equal(october.summary.income_yen, 200000);
  assert.equal(october.summary.balance_yen, 193720);
  assert.equal(october.summary.transfer_yen, 40000);
  assert.equal(october.summary.entry_count, 4);
  assert.deepEqual(
    october.summary.expense_by_category.map((row) => row.category),
    ['daily_goods', 'food'],
  );
  const september = read.months[1];
  assert.ok(september);
  assert.equal(september.entries.length, 0);
  assert.equal(september.summary.expense_yen, 0);
  assert.deepEqual(await readHouseholdMonths(ports, '2030-10', '2030-09'), {
    outcome: 'rejected',
    reasons: ['month_range_invalid'],
  });
});

test('分類の変更: 本人の分類を規則として覚え、次の同じ店の未分類の利用に当てる。分類済みの利用には当てない', async (t) => {
  const { ports } = withDb(t);
  const first = await created(ports, mail('a'), expense());
  const changed = await changeHouseholdCategory(ports, first, '1', 'food');
  assert.deepEqual(changed, {
    outcome: 'changed',
    entry_id: first,
    content_revision: '2',
    rule_learned: true,
  });
  // 表記の揺れ（全角・大文字・空白）は正規化して同じ店とみなす。
  const second = await recordHouseholdEntry(
    ports,
    mail('b'),
    expense({ merchant: ' 合成食堂 ', occurred_on: '2030-10-02' }),
  );
  assert.equal(second.outcome, 'created');
  if (second.outcome !== 'created') throw new Error('unreachable');
  assert.equal(second.rule_applied, true);
  const third = await recordHouseholdEntry(
    ports,
    mail('c'),
    expense({ category: 'social', occurred_on: '2030-10-03' }),
  );
  assert.equal(third.outcome, 'created');
  if (third.outcome !== 'created') throw new Error('unreachable');
  assert.equal(third.rule_applied, false);
  const view = await month(ports, '2030-10');
  const categories = Object.fromEntries(
    view.entries.map((entry) => [
      entry.content.occurred_on,
      entry.content.category,
    ]),
  );
  assert.deepEqual(categories, {
    '2030-10-01': 'food',
    '2030-10-02': 'food',
    '2030-10-03': 'social',
  });
});

test('分類の変更: 向きの違う分類・古い内容版・知らない分類・ない記録は拒否する', async (t) => {
  const { ports } = withDb(t);
  const id = await created(ports, mail('a'), expense());
  assert.deepEqual(await changeHouseholdCategory(ports, id, '1', 'income'), {
    outcome: 'rejected',
    reasons: ['category_direction_mismatch'],
  });
  assert.deepEqual(await changeHouseholdCategory(ports, id, '1', 'salary'), {
    outcome: 'rejected',
    reasons: ['category_invalid'],
  });
  assert.equal(
    (await changeHouseholdCategory(ports, id, '1', 'food')).outcome,
    'changed',
  );
  assert.deepEqual(await changeHouseholdCategory(ports, id, '1', 'social'), {
    outcome: 'rejected',
    reasons: ['revision_mismatch'],
  });
  assert.deepEqual(
    await changeHouseholdCategory(ports, randomUUID(), '1', 'food'),
    { outcome: 'rejected', reasons: ['entry_missing'] },
  );
  // 店名のない記録は分類だけ変え、規則は覚えない。
  const noMerchant = await created(
    ports,
    mail('b'),
    expense({ merchant: null }),
  );
  const changed = await changeHouseholdCategory(ports, noMerchant, '1', 'food');
  assert.equal(changed.outcome, 'changed');
  if (changed.outcome !== 'changed') throw new Error('unreachable');
  assert.equal(changed.rule_learned, false);
});

test('削除: 記録は集計から消え、同じ出所からは作り直さない。消した記録は変えられない', async (t) => {
  const { ports } = withDb(t);
  const id = await created(ports, mail('a'), expense({ category: 'food' }));
  assert.deepEqual(await deleteHouseholdEntry(ports, id, '1'), {
    outcome: 'deleted',
    entry_id: id,
  });
  const view = await month(ports, '2030-10');
  assert.equal(view.entries.length, 0);
  assert.equal(view.summary.expense_yen, 0);
  assert.deepEqual(await recordHouseholdEntry(ports, mail('a'), expense()), {
    outcome: 'duplicate',
    entry_id: id,
    state: 'deleted',
  });
  assert.deepEqual(await changeHouseholdCategory(ports, id, '2', 'social'), {
    outcome: 'rejected',
    reasons: ['entry_deleted'],
  });
});

test('読み取り: 別のデータ鍵の記録は復号できない数として返し、集計に入れない', async (t) => {
  const { ports } = withDb(t);
  await created(ports, mail('a'), expense({ category: 'food' }));
  const other: HouseholdPorts = {
    ...ports,
    dataKey: { keyId: 'k-test', key: randomBytes(32) },
  };
  await created(
    other,
    mail('b'),
    expense({ category: 'food', amount_yen: 999 }),
  );
  const view = await month(ports, '2030-10');
  assert.equal(view.entries.length, 1);
  assert.equal(view.unreadable, 1);
  assert.equal(view.summary.expense_yen, 1280);
});

test('店名の鍵: データ鍵ごとに違う値になり、文字列にしても鍵を出さない', () => {
  const a = HouseholdMerchantKey.fromDataKey({
    keyId: 'k-a',
    key: Buffer.alloc(32, 1),
  });
  const b = HouseholdMerchantKey.fromDataKey({
    keyId: 'k-b',
    key: Buffer.alloc(32, 1),
  });
  const value = a.merchant('合成食堂');
  assert.match(value ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(a.merchant('ＡＢＣ　Store'), a.merchant('abc store'));
  assert.notEqual(value, b.merchant('合成食堂'));
  assert.equal(a.merchant('   '), null);
  assert.equal(JSON.stringify({ a }), '{"a":"[redacted]"}');
  assert.throws(
    () =>
      HouseholdMerchantKey.fromDataKey({ keyId: 'k', key: Buffer.alloc(16) }),
    /household_data_key_invalid/u,
  );
});

test('内容版の数: 今の版も次の版も安全な整数のときだけ数にし、変更は精度が落ちる版を拒否する', async (t) => {
  const { ports } = withDb(t);
  assert.equal(householdRevisionNumber('1'), 1);
  assert.equal(householdRevisionNumber('9007199254740991'), 9007199254740991);
  assert.equal(householdRevisionNumber('9007199254740993'), null);
  assert.equal(nextHouseholdRevision('9007199254740990'), 9007199254740991);
  assert.equal(nextHouseholdRevision('9007199254740991'), null);
  assert.equal(nextHouseholdRevision('9999999999999999'), null);
  const id = await created(ports, mail('a'), expense());
  assert.deepEqual(
    await changeHouseholdCategory(ports, id, '9007199254740991', 'food'),
    { outcome: 'rejected', reasons: ['expected_revision_invalid'] },
  );
  // 境の版は検査を通り、保存済みの版との照合で拒否される。
  assert.deepEqual(
    await changeHouseholdCategory(ports, id, '9007199254740990', 'food'),
    { outcome: 'rejected', reasons: ['revision_mismatch'] },
  );
});
