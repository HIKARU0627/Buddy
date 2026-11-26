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
  changeHouseholdContent,
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

// 店名に覚えた分類（なければ null）。保存層へ直接聞き、記録の当て方（rule_applied）を経由しない。
async function ruleOf(
  ports: HouseholdPorts,
  merchant: string,
): Promise<string | null> {
  const key = HouseholdMerchantKey.fromDataKey(ports.dataKey).merchant(
    merchant,
  );
  assert.notEqual(key, null);
  const got = await ports.client.household({
    kind: 'household.rule_get',
    merchant_key: key as string,
  });
  assert.equal(got.ok, true);
  if (!got.ok) throw new Error('unreachable');
  return got.value === null ? null : got.value.category;
}

// 本人の規則「合成フリマ → 日用品」を作る（支出の記録の分類を直す）。
async function learnExpenseRule(ports: HouseholdPorts): Promise<void> {
  const id = await created(
    ports,
    mail('rule-source'),
    expense({ merchant: '合成フリマ' }),
  );
  const changed = await changeHouseholdCategory(ports, id, '1', 'daily_goods');
  assert.equal(changed.outcome, 'changed');
  assert.equal(await ruleOf(ports, '合成フリマ'), 'daily_goods');
}

test('規則の向き: 収入・振替の記録の分類を直しても、同じ店名の支出の規則を上書きしない（ADR 0175）', async (t) => {
  const { ports } = withDb(t);
  await learnExpenseRule(ports);
  for (const [direction, category] of [
    ['income', 'income'],
    ['transfer', 'transfer'],
  ] as const) {
    const id = await created(
      ports,
      mail(`other-${direction}`),
      expense({ direction, category, merchant: '合成フリマ' }),
    );
    const changed = await changeHouseholdCategory(ports, id, '1', category);
    assert.deepEqual(changed, {
      outcome: 'changed',
      entry_id: id,
      content_revision: '2',
      rule_learned: false,
    });
    assert.equal(await ruleOf(ports, '合成フリマ'), 'daily_goods', direction);
  }
  // 規則が残っているので、次の同じ店名の支出の利用には今までどおり当たる。
  const next = await recordHouseholdEntry(
    ports,
    mail('next'),
    expense({ merchant: '合成フリマ' }),
  );
  assert.equal(next.outcome === 'created' && next.rule_applied, true);
});

test('規則の向き: 収入・振替の記録の中身を直しても、支出の規則を上書きせず、収入・振替の規則も作らない（ADR 0175）', async (t) => {
  const { ports } = withDb(t);
  await learnExpenseRule(ports);
  for (const [direction, category] of [
    ['income', 'income'],
    ['transfer', 'transfer'],
  ] as const) {
    const merchant = '合成フリマ';
    const entry = expense({ direction, category, merchant });
    const id = await created(ports, mail(`edit-${direction}`), entry);
    const changed = await changeHouseholdContent(ports, id, '1', {
      ...entry,
      amount_yen: 3000,
    });
    assert.deepEqual(changed, {
      outcome: 'changed',
      entry_id: id,
      content_revision: '2',
      rule_learned: false,
    });
    assert.equal(await ruleOf(ports, '合成フリマ'), 'daily_goods', direction);
  }
  // 収入だけの店名にも、収入の規則は作らない。
  const only = expense({
    direction: 'income',
    category: 'income',
    merchant: '合成の勤め先',
  });
  const id = await created(ports, mail('income-only'), only);
  const changed = await changeHouseholdContent(ports, id, '1', {
    ...only,
    amount_yen: 250000,
  });
  assert.equal(changed.outcome === 'changed' && changed.rule_learned, false);
  assert.equal(await ruleOf(ports, '合成の勤め先'), null);
});

test('規則の向き: 支出の記録の中身の変更は、今までどおり規則を覚える（ADR 0175）', async (t) => {
  const { ports } = withDb(t);
  const entry = expense({ merchant: '合成の本屋', category: 'hobby' });
  const id = await created(ports, mail('book'), entry);
  const changed = await changeHouseholdContent(ports, id, '1', {
    ...entry,
    category: 'education',
  });
  assert.equal(changed.outcome === 'changed' && changed.rule_learned, true);
  assert.equal(await ruleOf(ports, '合成の本屋'), 'education');
});

test('規則の向き: 中身の変更で支出の記録を未分類へ直すと、店名が同じならその店名の規則を未分類で上書きし、次の利用に分類を当てない（ADR 0175 追補）', async (t) => {
  const { ports } = withDb(t);
  const entry = expense({ merchant: '合成の薬局', category: 'hobby' });
  const id = await created(ports, mail('drug'), entry);
  const learned = await changeHouseholdCategory(ports, id, '1', 'daily_goods');
  assert.equal(learned.outcome === 'changed' && learned.rule_learned, true);
  assert.equal(await ruleOf(ports, '合成の薬局'), 'daily_goods');
  // 店名は同じまま、金額を直して未分類へ戻す。
  const reset = await changeHouseholdContent(ports, id, '2', {
    ...entry,
    category: 'uncategorized',
    amount_yen: 999,
  });
  assert.deepEqual(reset, {
    outcome: 'changed',
    entry_id: id,
    content_revision: '3',
    rule_learned: true,
  });
  assert.equal(await ruleOf(ports, '合成の薬局'), 'uncategorized');
  const nextId = await created(ports, mail('drug-next'), {
    ...entry,
    category: 'uncategorized',
  });
  const view = await month(ports, '2030-10');
  assert.equal(
    view.entries.find((row) => row.entry_id === nextId)?.content.category,
    'uncategorized',
  );
});

test('規則の向き: 中身の変更で店名も変えて未分類へ直したときは、新しい店名の規則を書かず、元の店名の規則も変えない（ADR 0175 追補）', async (t) => {
  const { ports } = withDb(t);
  const entry = expense({
    merchant: '合成の旧店名',
    category: 'uncategorized',
  });
  const id = await created(ports, mail('rename'), entry);
  await changeHouseholdCategory(ports, id, '1', 'food');
  assert.equal(await ruleOf(ports, '合成の旧店名'), 'food');
  // 別の新しい店名の規則も、あらかじめ持っておく。
  const other = expense({
    merchant: '合成の新店名',
    category: 'uncategorized',
  });
  const otherId = await created(ports, mail('rename-other'), other);
  await changeHouseholdCategory(ports, otherId, '1', 'hobby');
  const changed = await changeHouseholdContent(ports, id, '2', {
    ...entry,
    merchant: '合成の新店名',
    category: 'uncategorized',
  });
  assert.deepEqual(changed, {
    outcome: 'changed',
    entry_id: id,
    content_revision: '3',
    rule_learned: false,
  });
  assert.equal(await ruleOf(ports, '合成の新店名'), 'hobby');
  assert.equal(await ruleOf(ports, '合成の旧店名'), 'food');
});

test('規則の向き: 中身の変更で、もともと未分類の支出の記録を直しても、規則を未分類で上書きしない。店名がない記録は何も書かない（ADR 0175 追補）', async (t) => {
  const { ports } = withDb(t);
  // 規則ができる前に作られ、未分類のままの記録。
  const entry = expense({ merchant: '合成フリマ', category: 'uncategorized' });
  const id = await created(ports, mail('still-plain'), entry);
  await learnExpenseRule(ports);
  const content = { ...entry, memo: '直した' };
  const changed = await changeHouseholdContent(ports, id, '1', content);
  assert.equal(changed.outcome === 'changed' && changed.rule_learned, false);
  assert.equal(await ruleOf(ports, '合成フリマ'), 'daily_goods');
  // 収入・振替の記録は未分類へ直せない（規則も書かれない）。
  for (const [direction, category] of [
    ['income', 'income'],
    ['transfer', 'transfer'],
  ] as const) {
    const base = expense({ direction, category, merchant: '合成フリマ' });
    const baseId = await created(ports, mail(`no-reset-${direction}`), base);
    const rejected = await changeHouseholdContent(ports, baseId, '1', {
      ...base,
      category: 'uncategorized',
    });
    assert.deepEqual(rejected, {
      outcome: 'rejected',
      reasons: ['category_direction_mismatch'],
    });
  }
  assert.equal(await ruleOf(ports, '合成フリマ'), 'daily_goods');
  // 店名がない記録を未分類へ直しても、書く規則がない。
  const bare = expense({ merchant: null, category: 'hobby' });
  const bareId = await created(ports, mail('bare'), bare);
  const bareChanged = await changeHouseholdContent(ports, bareId, '1', {
    ...bare,
    category: 'uncategorized',
  });
  assert.equal(
    bareChanged.outcome === 'changed' && bareChanged.rule_learned,
    false,
  );
});

test('規則の向き: 支出の記録の分類を未分類へ直すと、その店名の規則を未分類で上書きし、次の利用に分類を当てない（ADR 0158・0175）', async (t) => {
  const { ports } = withDb(t);
  const entry = expense({
    merchant: '合成の雑貨店',
    category: 'uncategorized',
  });
  const id = await created(ports, mail('goods-1'), entry);
  const learned = await changeHouseholdCategory(ports, id, '1', 'daily_goods');
  assert.equal(learned.outcome === 'changed' && learned.rule_learned, true);
  assert.equal(await ruleOf(ports, '合成の雑貨店'), 'daily_goods');
  // 本人が未分類へ戻すと、覚えた分類を未分類で上書きする（次から自動では分類しない）。
  const reset = await changeHouseholdCategory(ports, id, '2', 'uncategorized');
  assert.equal(reset.outcome === 'changed' && reset.rule_learned, true);
  assert.equal(await ruleOf(ports, '合成の雑貨店'), 'uncategorized');
  const nextId = await created(ports, mail('goods-2'), entry);
  const view = await month(ports, '2030-10');
  assert.equal(
    view.entries.find((row) => row.entry_id === nextId)?.content.category,
    'uncategorized',
  );
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
