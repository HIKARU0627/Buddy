// 家計の記録と分類の規則の保存（ADR 0158、マイグレーション 0016）。
// DB は一時ディレクトリに作って消す。暗号文は合成のデータ鍵で実際に暗号化し、復号して中身を確かめる。
// 期待値は ADR 0158 の判断（出所の鍵で作り直さない・内容版の照合・削除は行を残す・本人の規則を取込みで上書きしない）
// から手で書いた値。店名・金額は合成で、実データは使わない。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type {
  HouseholdBillContent,
  HouseholdEntryContent,
} from '@buddy/domain';
import {
  DbWorkerClient,
  HOUSEHOLD_BILL_LIST_LIMIT,
  applyMigrations,
  executeHouseholdOp,
  loadMigrations,
  openWriteConnection,
  openHouseholdBill,
  openHouseholdBudget,
  openHouseholdContent,
  sealHouseholdBill,
  sealHouseholdBudget,
  sealHouseholdContent,
} from './index.js';
import type {
  DataKeyMaterial,
  HouseholdBillDeleteValue,
  HouseholdBillListValue,
  HouseholdBillRecord,
  HouseholdBillRecordValue,
  HouseholdEntryRecord,
  HouseholdListValue,
  HouseholdMailPendingValue,
  HouseholdOp,
  HouseholdOpResult,
  HouseholdRecordValue,
  HouseholdRevisionValue,
  HouseholdBudgetValue,
  HouseholdSettingsValue,
  SealedBlobInput,
} from './index.js';
import type { SqliteDatabase } from './connection.js';
import {
  STORE_GENERATION,
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const T0 = '2030-10-01T00:00:00.000Z';
const T1 = '2030-10-01T01:00:00.000Z';
const T2 = '2030-10-01T02:00:00.000Z';
const KEY: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const MERCHANT_KEY = 'c'.repeat(64);

const LUNCH: HouseholdEntryContent = {
  direction: 'expense',
  amount_yen: 1280,
  occurred_on: '2030-10-01',
  occurred_time: '12:30',
  category: 'food',
  merchant: '合成食堂',
  memo: null,
  payment: '合成カード',
};

function sealed(
  entryId: string,
  revision: number,
  content: HouseholdEntryContent,
): SealedBlobInput {
  const result = sealHouseholdContent(KEY, entryId, revision, content);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.content;
}

function run(
  db: SqliteDatabase,
  op: HouseholdOp,
  halted = false,
): HouseholdOpResult {
  return executeHouseholdOp(db, op, { platform: 'macos', halted }).result;
}

function value<T>(result: HouseholdOpResult): T {
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(','));
  if (!result.ok) throw new Error('unreachable');
  return result.value as T;
}

function reasons(result: HouseholdOpResult): readonly string[] {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.outcome, 'rejected');
  return result.reasons;
}

function recordOp(
  entryId: string,
  over: Partial<Extract<HouseholdOp, { kind: 'household.record' }>> = {},
  content: HouseholdEntryContent = LUNCH,
): HouseholdOp {
  return {
    kind: 'household.record',
    entry_id: entryId,
    source_kind: 'mail_notice',
    source_key: SOURCE_A,
    month: '2030-10',
    content: sealed(entryId, 1, content),
    now: T0,
    ...over,
  };
}

function get(db: SqliteDatabase, entryId: string): HouseholdEntryRecord {
  const record = value<HouseholdEntryRecord | null>(
    run(db, { kind: 'household.get', entry_id: entryId }),
  );
  assert.ok(record);
  return record;
}

function blobCount(db: SqliteDatabase): number {
  return (
    db
      .prepare(
        "SELECT count(*) AS n FROM sealed_blobs WHERE purpose = 'household_entry'",
      )
      .get() as { n: number }
  ).n;
}

function open(record: HouseholdEntryRecord): HouseholdEntryContent {
  assert.ok(record.content);
  const opened = openHouseholdContent(
    KEY,
    record.entry_id,
    Number(record.content_revision),
    {
      formatVersion: record.content.format_version,
      keyId: record.content.key_id,
      nonce: record.content.nonce,
      ciphertext: record.content.ciphertext,
      tag: record.content.tag,
    },
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error('unreachable');
  return opened.content;
}

async function withDb(body: (db: SqliteDatabase) => void): Promise<void> {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      body(db);
    } finally {
      db.close();
    }
  });
}

test('household.record: 記録と暗号文を書き、同じ出所の鍵では書かずに duplicate を返す', async () => {
  await withDb((db) => {
    const id = randomUUID();
    assert.deepEqual(value<HouseholdRecordValue>(run(db, recordOp(id))), {
      outcome: 'created',
      entry_id: id,
      content_revision: '1',
    });
    const record = get(db, id);
    assert.equal(record.state, 'active');
    assert.equal(record.month, '2030-10');
    assert.equal(record.source_kind, 'mail_notice');
    assert.equal(record.created_at, T0);
    assert.deepEqual(open(record), LUNCH);
    // 同じメールの再同期（同じ出所の鍵・別の ID）。二つ目を作らない。
    const second = randomUUID();
    assert.deepEqual(
      value<HouseholdRecordValue>(run(db, recordOp(second, { now: T1 }))),
      { outcome: 'duplicate', entry_id: id, state: 'active' },
    );
    assert.equal(blobCount(db), 1);
    assert.equal(
      value<HouseholdEntryRecord | null>(
        run(db, { kind: 'household.get', entry_id: second }),
      ),
      null,
    );
    // 別の出所で同じ ID は使い回せない。
    assert.deepEqual(reasons(run(db, recordOp(id, { source_key: SOURCE_B }))), [
      'entry_id_reused',
    ]);
  });
});

test('household.update: 内容版を照合して差し替え、古い暗号文を消す。古い版では拒否する', async () => {
  await withDb((db) => {
    const id = randomUUID();
    value(run(db, recordOp(id)));
    const changed: HouseholdEntryContent = {
      ...LUNCH,
      category: 'social',
      occurred_on: '2030-11-02',
    };
    assert.deepEqual(
      value<HouseholdRevisionValue>(
        run(db, {
          kind: 'household.update',
          entry_id: id,
          expected_revision: '1',
          month: '2030-11',
          content: sealed(id, 2, changed),
          now: T1,
        }),
      ),
      { entry_id: id, content_revision: '2' },
    );
    const record = get(db, id);
    assert.equal(record.content_revision, '2');
    assert.equal(record.month, '2030-11');
    assert.equal(record.updated_at, T1);
    assert.deepEqual(open(record), changed);
    assert.equal(blobCount(db), 1);
    // 見ていた版が古い。
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.update',
          entry_id: id,
          expected_revision: '1',
          month: '2030-11',
          content: sealed(id, 2, LUNCH),
          now: T2,
        }),
      ),
      ['revision_mismatch'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.update',
          entry_id: randomUUID(),
          expected_revision: '1',
          month: '2030-11',
          content: sealed(id, 2, LUNCH),
          now: T2,
        }),
      ),
      ['entry_missing'],
    );
  });
});

test('household.delete: 行を残して暗号文と月を消し、同じ出所から作り直さない', async () => {
  await withDb((db) => {
    const id = randomUUID();
    value(run(db, recordOp(id)));
    assert.deepEqual(
      value<HouseholdRevisionValue>(
        run(db, {
          kind: 'household.delete',
          entry_id: id,
          expected_revision: '1',
          now: T1,
        }),
      ),
      { entry_id: id, content_revision: '2' },
    );
    const record = get(db, id);
    assert.equal(record.state, 'deleted');
    assert.equal(record.month, null);
    assert.equal(record.content, null);
    assert.equal(blobCount(db), 0);
    assert.deepEqual(
      value<HouseholdListValue>(
        run(db, {
          kind: 'household.list',
          month_from: '2030-01',
          month_to: '2030-12',
        }),
      ).entries,
      [],
    );
    // 同じメールをもう一度読んでも作り直さない。
    assert.deepEqual(
      value<HouseholdRecordValue>(run(db, recordOp(randomUUID()))),
      { outcome: 'duplicate', entry_id: id, state: 'deleted' },
    );
    assert.equal(blobCount(db), 0);
    // 消した記録は変えられない。
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.delete',
          entry_id: id,
          expected_revision: '2',
          now: T2,
        }),
      ),
      ['entry_deleted'],
    );
  });
});

test('household.list: 月の範囲の記録だけを新しい月から返す。範囲の誤りと 24 か月を超える範囲は拒否する', async () => {
  await withDb((db) => {
    const sep = randomUUID();
    const oct = randomUUID();
    const nov = randomUUID();
    value(
      run(
        db,
        recordOp(
          sep,
          { source_key: '1'.repeat(64), month: '2030-09' },
          { ...LUNCH, occurred_on: '2030-09-30' },
        ),
      ),
    );
    value(run(db, recordOp(oct, { source_key: '2'.repeat(64) })));
    value(
      run(
        db,
        recordOp(
          nov,
          { source_key: '3'.repeat(64), month: '2030-11' },
          { ...LUNCH, occurred_on: '2030-11-01' },
        ),
      ),
    );
    const listed = value<HouseholdListValue>(
      run(db, {
        kind: 'household.list',
        month_from: '2030-10',
        month_to: '2030-11',
      }),
    );
    assert.equal(listed.truncated, false);
    assert.deepEqual(
      listed.entries.map((entry) => entry.entry_id),
      [nov, oct],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.list',
          month_from: '2030-11',
          month_to: '2030-10',
        }),
      ),
      ['month_range_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.list',
          month_from: '2029-01',
          month_to: '2031-01',
        }),
      ),
      ['month_range_too_wide'],
    );
    // 24 か月ちょうどは通る。
    assert.equal(
      run(db, {
        kind: 'household.list',
        month_from: '2029-01',
        month_to: '2030-12',
      }).ok,
      true,
    );
  });
});

test('household.rule_set: 取込みの規則は本人の規則を上書きしない。本人の規則は取込みの規則を上書きする', async () => {
  await withDb((db) => {
    const ruleSet = (
      category: string,
      origin: 'user' | 'import',
    ): { written: boolean } =>
      value<{ written: boolean }>(
        run(db, {
          kind: 'household.rule_set',
          merchant_key: MERCHANT_KEY,
          category,
          origin,
          now: T0,
        }),
      );
    const ruleGet = (): unknown =>
      value(
        run(db, { kind: 'household.rule_get', merchant_key: MERCHANT_KEY }),
      );
    assert.equal(ruleGet(), null);
    assert.deepEqual(ruleSet('food', 'import'), { written: true });
    assert.deepEqual(ruleGet(), { category: 'food', origin: 'import' });
    assert.deepEqual(ruleSet('daily_goods', 'import'), { written: true });
    assert.deepEqual(ruleSet('social', 'user'), { written: true });
    assert.deepEqual(ruleGet(), { category: 'social', origin: 'user' });
    assert.deepEqual(ruleSet('food', 'import'), { written: false });
    assert.deepEqual(ruleGet(), { category: 'social', origin: 'user' });
    assert.deepEqual(ruleSet('hobby', 'user'), { written: true });
    assert.deepEqual(ruleGet(), { category: 'hobby', origin: 'user' });
    // 保存層を通さない書き換えも trigger が拒否する。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE household_category_rules SET origin = 'import' WHERE merchant_key = ?",
          )
          .run(MERCHANT_KEY),
      /household_rule_user_kept/u,
    );
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.rule_set',
          merchant_key: MERCHANT_KEY,
          category: 'groceries',
          origin: 'user',
          now: T0,
        }),
      ),
      ['category_invalid'],
    );
  });
});

function seedMail(
  db: SqliteDatabase,
  remoteId: string,
  fetchedAt: number,
  scopeId = 'sc-1',
): void {
  db.prepare(
    "INSERT OR IGNORE INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES (?, 'c-1', 0, 0, 0)",
  ).run(scopeId);
  db.prepare(
    "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-a', ?, 'rev-1', ?, 0, ?, NULL)",
  ).run(remoteId, scopeId, fetchedAt);
}

const pending = (
  db: SqliteDatabase,
  over: Partial<Extract<HouseholdOp, { kind: 'household.mail_pending' }>> = {},
): HouseholdMailPendingValue =>
  value<HouseholdMailPendingValue>(
    run(db, {
      kind: 'household.mail_pending',
      provider: 'google',
      account_id: 'acct-a',
      scope_id: 'sc-1',
      limit: 50,
      now: T1,
      ...over,
    }),
  );

const checked = (db: SqliteDatabase, remoteId: string): HouseholdOpResult =>
  run(db, {
    kind: 'household.mail_checked',
    provider: 'google',
    account_id: 'acct-a',
    remote_id: remoteId,
    now: T2,
  });

test('household.mail_pending: 口座の基準があっても、新しい取得集合の過去のメールは読まない（基準は取得集合ごと。ADR 0170）', async () => {
  await withDb((db) => {
    seedMail(db, 'm-old-1', 1000);
    assert.deepEqual(pending(db), {
      paused: false,
      baseline: true,
      remote_ids: [],
    });
    seedMail(db, 'm-new-1', 2000);
    assert.deepEqual(pending(db).remote_ids, ['m-new-1']);
    // 後から足した取得集合。口座の基準はあるが、この取得集合の基準はないので、いまあるメールを確かめ済みにして空を返す。
    seedMail(db, 'm-scope2-old', 3000, 'sc-2');
    assert.deepEqual(pending(db, { scope_id: 'sc-2' }), {
      paused: false,
      baseline: true,
      remote_ids: [],
    });
    // 基準ができた後の新しいメールだけを返す。もとの取得集合の未確認は変わらない。
    seedMail(db, 'm-scope2-new', 4000, 'sc-2');
    assert.deepEqual(pending(db, { scope_id: 'sc-2' }), {
      paused: false,
      baseline: false,
      remote_ids: ['m-scope2-new'],
    });
    assert.deepEqual(pending(db).remote_ids, ['m-new-1']);
    assert.equal(
      (
        db
          .prepare('SELECT count(*) AS n FROM household_mail_baselines')
          .get() as { n: number }
      ).n,
      2,
    );
  });
});

test('household.mail_pending: 初回はいまあるメールを確かめ済みにして空を返し、その後は新しいメールだけを新しい順に返す', async () => {
  await withDb((db) => {
    seedMail(db, 'm-old-1', 1000);
    seedMail(db, 'm-old-2', 2000);
    assert.deepEqual(pending(db), {
      paused: false,
      baseline: true,
      remote_ids: [],
    });
    assert.deepEqual(pending(db), {
      paused: false,
      baseline: false,
      remote_ids: [],
    });
    seedMail(db, 'm-new-1', 3000);
    seedMail(db, 'm-new-2', 4000);
    // 別の取得集合のメールは返さない。
    seedMail(db, 'm-other-scope', 5000, 'sc-2');
    assert.deepEqual(pending(db), {
      paused: false,
      baseline: false,
      remote_ids: ['m-new-2', 'm-new-1'],
    });
    assert.deepEqual(pending(db, { limit: 1 }).remote_ids, ['m-new-2']);
    assert.deepEqual(value(checked(db, 'm-new-2')), { written: true });
    assert.deepEqual(value(checked(db, 'm-new-2')), { written: false });
    assert.deepEqual(pending(db).remote_ids, ['m-new-1']);
    // 同期で消えたメールは確かめ済みにしない。
    assert.deepEqual(value(checked(db, 'm-missing')), { written: false });
    // 同期のメールの行が消えると、確かめ済みの行も一緒に消える。
    db.prepare(
      "DELETE FROM source_items WHERE provider = 'google' AND account_id = 'acct-a' AND remote_id = 'm-new-2'",
    ).run();
    assert.equal(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM household_mail_checks WHERE remote_id = 'm-new-2'",
          )
          .get() as { n: number }
      ).n,
      0,
    );
    // 別の口座は、その口座の初回として基準を作る。
    assert.deepEqual(pending(db, { account_id: 'acct-b' }), {
      paused: false,
      baseline: true,
      remote_ids: [],
    });
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.mail_pending',
          provider: 'yahoo' as 'google',
          account_id: 'acct-a',
          scope_id: 'sc-1',
          limit: 0,
          now: 'later',
        }),
      ),
      ['provider_invalid', 'limit_invalid', 'now_invalid'],
    );
  });
});

const settings = (db: SqliteDatabase): HouseholdSettingsValue =>
  value<HouseholdSettingsValue>(run(db, { kind: 'household.settings_get' }));

const setIntake = (
  db: SqliteDatabase,
  expected: string,
  mailIntake: 'on' | 'off',
): HouseholdOpResult =>
  run(db, {
    kind: 'household.settings_set',
    expected_revision: expected,
    mail_intake: mailIntake,
    now: T2,
  });

test('household.settings: 行がなければ取り込みは入で版 0。止めている間は確かめるメールを返さず、再開すると止めていた間のメールを読まない', async () => {
  await withDb((db) => {
    assert.deepEqual(settings(db), {
      mail_intake: 'on',
      receipt_reading: 'off',
      settings_revision: '0',
    });
    seedMail(db, 'm-before', 1000);
    assert.equal(pending(db).baseline, true);
    seedMail(db, 'm-new', 2000);
    assert.deepEqual(pending(db).remote_ids, ['m-new']);
    // 止める。古い版では拒否する。
    assert.deepEqual(value(setIntake(db, '0', 'off')), {
      mail_intake: 'off',
      receipt_reading: 'off',
      settings_revision: '1',
    });
    assert.deepEqual(reasons(setIntake(db, '0', 'on')), ['revision_mismatch']);
    assert.deepEqual(settings(db), {
      mail_intake: 'off',
      receipt_reading: 'off',
      settings_revision: '1',
    });
    // 止めている間は何も返さず、基準も作らない（別の口座でも）。
    seedMail(db, 'm-while-off', 3000);
    assert.deepEqual(pending(db), {
      paused: true,
      baseline: false,
      remote_ids: [],
    });
    assert.deepEqual(pending(db, { account_id: 'acct-b' }), {
      paused: true,
      baseline: false,
      remote_ids: [],
    });
    assert.equal(
      (
        db
          .prepare('SELECT count(*) AS n FROM household_mail_baselines')
          .get() as { n: number }
      ).n,
      1,
    );
    // 再開すると基準を作り直し、止めていた間のメール（と確かめていなかったメール）を読まない。
    assert.deepEqual(value(setIntake(db, '1', 'on')), {
      mail_intake: 'on',
      receipt_reading: 'off',
      settings_revision: '2',
    });
    assert.deepEqual(pending(db), {
      paused: false,
      baseline: true,
      remote_ids: [],
    });
    seedMail(db, 'm-after', 4000);
    assert.deepEqual(pending(db).remote_ids, ['m-after']);
    // 入のまま入にしても版は進む（基準は消さない）。
    assert.deepEqual(value(setIntake(db, '2', 'on')), {
      mail_intake: 'on',
      receipt_reading: 'off',
      settings_revision: '3',
    });
    assert.deepEqual(pending(db).remote_ids, ['m-after']);
    // 形の誤り。版を飛ばす更新は trigger が拒否する。
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.settings_set',
          expected_revision: '-1',
          mail_intake: 'paused' as 'on',
          now: 'later',
        }),
      ),
      ['expected_revision_invalid', 'mail_intake_invalid', 'now_invalid'],
    );
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE household_settings SET settings_revision = 9 WHERE setting_id = 1',
          )
          .run(),
      /household_settings_revision_step/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO household_settings (setting_id, mail_intake, settings_revision, updated_at) VALUES (2, 'on', 1, 0)",
          )
          .run(),
      /CHECK constraint failed/u,
    );
  });
});

function budgetBlob(
  revision: number,
  items: { category: string; budget_yen: number }[],
): SealedBlobInput {
  const result = sealHouseholdBudget(KEY, revision, items);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.content;
}

test('household.budget: 行がなければ版 0。版を照合して暗号文を差し替え、古い暗号文を消す（ADR 0166）', async () => {
  await withDb((db) => {
    const get = () =>
      value<HouseholdBudgetValue>(run(db, { kind: 'household.budget_get' }));
    assert.deepEqual(get(), { budget_revision: '0', content: null });
    const first = value<HouseholdBudgetValue>(
      run(db, {
        kind: 'household.budget_set',
        expected_revision: '0',
        content: budgetBlob(1, [
          { category: 'utilities', budget_yen: 12000 },
          { category: 'food', budget_yen: 40000 },
        ]),
        now: T1,
      }),
    );
    assert.equal(first.budget_revision, '1');
    assert.ok(first.content);
    const opened = openHouseholdBudget(KEY, 1, {
      formatVersion: first.content.format_version,
      keyId: first.content.key_id,
      nonce: first.content.nonce,
      ciphertext: first.content.ciphertext,
      tag: first.content.tag,
    });
    // 分類の表示の順にそろえて保存する。
    assert.deepEqual(opened, {
      ok: true,
      items: [
        { category: 'food', budget_yen: 40000 },
        { category: 'utilities', budget_yen: 12000 },
      ],
    });
    // 古い版では拒否する。
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.budget_set',
          expected_revision: '0',
          content: budgetBlob(1, [{ category: 'food', budget_yen: 1 }]),
          now: T2,
        }),
      ),
      ['revision_mismatch'],
    );
    const second = value<HouseholdBudgetValue>(
      run(db, {
        kind: 'household.budget_set',
        expected_revision: '1',
        content: budgetBlob(2, []),
        now: T2,
      }),
    );
    assert.equal(second.budget_revision, '2');
    assert.equal(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM sealed_blobs WHERE purpose = 'household_budget'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
    // 版 1 の暗号文を版 2 として開くことはできない（持ち主の版が AAD に入る）。
    assert.equal(
      openHouseholdBudget(KEY, 1, {
        formatVersion: second.content?.format_version ?? 1,
        keyId: second.content?.key_id ?? '',
        nonce: second.content?.nonce ?? new Uint8Array(),
        ciphertext: second.content?.ciphertext ?? new Uint8Array(),
        tag: second.content?.tag ?? new Uint8Array(),
      }).ok,
      false,
    );
    // 収入の分類・0 円・同じ分類が二つは暗号化しない。
    for (const items of [
      [{ category: 'income', budget_yen: 1000 }],
      [{ category: 'food', budget_yen: 0 }],
      [
        { category: 'food', budget_yen: 1 },
        { category: 'food', budget_yen: 2 },
      ],
    ])
      assert.equal(sealHouseholdBudget(KEY, 3, items).ok, false);
    // 版を飛ばす更新と、別の持ち主の暗号文を指す行は DB が拒否する。
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE household_budgets SET budget_revision = 9 WHERE budget_id = 1',
          )
          .run(),
      /household_budget/u,
    );
  });
});

test('命令の形の誤りは書かずに拒否し、書込みを止めた worker は読み取りだけを続ける', async () => {
  await withDb((db) => {
    const id = randomUUID();
    assert.deepEqual(
      reasons(
        run(
          db,
          recordOp(id, {
            source_key: 'A'.repeat(64),
            month: '2030-13',
            now: '2030-10-01 00:00',
          }),
        ),
      ),
      ['source_key_invalid', 'month_invalid', 'now_invalid'],
    );
    assert.deepEqual(reasons(run(db, recordOp('not-a-uuid'))), [
      'entry_id_invalid',
    ]);
    assert.deepEqual(reasons(run(db, recordOp(id), true)), ['worker_halted']);
    assert.equal(blobCount(db), 0);
    assert.equal(
      run(
        db,
        { kind: 'household.list', month_from: '2030-10', month_to: '2030-10' },
        true,
      ).ok,
      true,
    );
  });
});

test('DB の trigger: 行は消せず、出所は変えられず、暗号文は自分の記録の自分の版だけを指す', async () => {
  await withDb((db) => {
    const id = randomUUID();
    value(run(db, recordOp(id)));
    assert.throws(
      () =>
        db.prepare('DELETE FROM household_entries WHERE entry_id = ?').run(id),
      /household_entry_no_delete/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE household_entries SET source_key = ?, content_revision = 2 WHERE entry_id = ?',
          )
          .run(SOURCE_B, id),
      /household_entry_fixed/u,
    );
    // 内容版を上げずに書き換えない。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE household_entries SET month = '2030-11' WHERE entry_id = ?",
          )
          .run(id),
      /household_entry_fixed/u,
    );
    // 別の記録の暗号文を指す行は作れない。
    const other = randomUUID();
    value(run(db, recordOp(other, { source_key: SOURCE_B })));
    const otherBlob = get(db, other).content?.blob_id;
    assert.ok(otherBlob);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO household_entries (entry_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, updated_at, deleted_at) VALUES (?, 'manual', ?, 'active', '2030-10', 1, ?, 1, 1, NULL)",
          )
          .run(randomUUID(), 'd'.repeat(64), otherBlob),
      /household_blob_owner_mismatch|UNIQUE/u,
    );
  });
});

test('DB worker を通しても記録・読み取り・規則の命令が往復する', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    openSeededDatabase(path).close();
    const client = await DbWorkerClient.start({
      path,
      storeGeneration: STORE_GENERATION,
      responseTimeoutMs: 10_000,
    });
    try {
      const id = randomUUID();
      const created = await client.household(
        recordOp(id) as Extract<HouseholdOp, { kind: 'household.record' }>,
      );
      assert.deepEqual(created, {
        ok: true,
        value: { outcome: 'created', entry_id: id, content_revision: '1' },
      });
      const listed = await client.household({
        kind: 'household.list',
        month_from: '2030-10',
        month_to: '2030-10',
      });
      assert.equal(listed.ok, true);
      if (!listed.ok) throw new Error('unreachable');
      assert.equal(listed.value.entries.length, 1);
      const entry = listed.value.entries[0];
      assert.ok(entry);
      assert.deepEqual(open(entry), LUNCH);
      assert.deepEqual(
        await client.household({
          kind: 'household.rule_set',
          merchant_key: MERCHANT_KEY,
          category: 'food',
          origin: 'user',
          now: T0,
        }),
        { ok: true, value: { written: true } },
      );
      assert.deepEqual(
        await client.household({
          kind: 'household.rule_get',
          merchant_key: MERCHANT_KEY,
        }),
        { ok: true, value: { category: 'food', origin: 'user' } },
      );
    } finally {
      await client.close();
    }
  });
});

// --- 請求予定（ADR 0176、マイグレーション 0021） ---

const BILL: HouseholdBillContent = {
  issuer: '合成カードA',
  amount_yen: 12345,
  due_on: '2030-12-10',
};

function billOp(
  billId: string,
  over: Partial<Extract<HouseholdOp, { kind: 'household.bill_record' }>> = {},
  content: HouseholdBillContent = BILL,
): Extract<HouseholdOp, { kind: 'household.bill_record' }> {
  const result = sealHouseholdBill(KEY, billId, content);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return {
    kind: 'household.bill_record',
    bill_id: billId,
    source_key: SOURCE_A,
    month: '2030-12',
    content: result.content,
    now: T0,
    ...over,
  };
}

function openBill(record: HouseholdBillRecord): HouseholdBillContent {
  assert.ok(record.content);
  const opened = openHouseholdBill(KEY, record.bill_id, {
    formatVersion: record.content.format_version,
    keyId: record.content.key_id,
    nonce: record.content.nonce,
    ciphertext: record.content.ciphertext,
    tag: record.content.tag,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error('unreachable');
  return opened.content;
}

function bills(db: SqliteDatabase, month: string): HouseholdBillListValue {
  return value<HouseholdBillListValue>(
    run(db, { kind: 'household.bill_list', month }),
  );
}

test('household.bill_record: 請求予定と暗号文を書き、同じ出所の鍵では書かずに duplicate を返す。家計の記録には入らない', async () => {
  await withDb((db) => {
    const id = randomUUID();
    assert.deepEqual(value<HouseholdBillRecordValue>(run(db, billOp(id))), {
      outcome: 'created',
      bill_id: id,
    });
    // 同じメールの読み直し（同じ出所の鍵・別の ID）。二つ目を作らない。
    assert.deepEqual(
      value<HouseholdBillRecordValue>(
        run(db, billOp(randomUUID(), { now: T1 })),
      ),
      { outcome: 'duplicate', bill_id: id, state: 'active' },
    );
    // 別の出所で同じ ID は使い回せない。
    assert.deepEqual(reasons(run(db, billOp(id, { source_key: SOURCE_B }))), [
      'bill_id_reused',
    ]);
    const listed = bills(db, '2030-12');
    assert.equal(listed.truncated, false);
    assert.equal(listed.bills.length, 1);
    const [record] = listed.bills;
    assert.ok(record);
    assert.equal(record.bill_id, id);
    assert.equal(record.month, '2030-12');
    assert.equal(record.content_revision, '1');
    assert.equal(record.created_at, T0);
    assert.deepEqual(openBill(record), BILL);
    // 平文の列は出所の種類と鍵・状態・月・内容版・時刻だけで、暗号文は household_bill の用途。
    assert.deepEqual(
      db
        .prepare(
          'SELECT source_kind, source_key, state, month, content_revision, deleted_at FROM household_bills WHERE bill_id = ?',
        )
        .get(id),
      {
        source_kind: 'mail_bill',
        source_key: SOURCE_A,
        state: 'active',
        month: '2030-12',
        content_revision: 1,
        deleted_at: null,
      },
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM sealed_blobs WHERE purpose = 'household_bill' AND owner_table = 'household_bills'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
    // 別の月には出ない。家計の記録の読み取りにも出ない（月の集計・予算・定期の支出の元にならない）。
    assert.deepEqual(bills(db, '2030-11').bills, []);
    assert.deepEqual(
      value<HouseholdListValue>(
        run(db, {
          kind: 'household.list',
          month_from: '2030-01',
          month_to: '2030-12',
        }),
      ).entries,
      [],
    );
  });
});

test('household.bill_list: 1 か月の上限を超えたら新しく作った方を返して truncated にする', async () => {
  await withDb((db) => {
    for (let index = 0; index <= HOUSEHOLD_BILL_LIST_LIMIT; index += 1)
      value(
        run(
          db,
          billOp(randomUUID(), {
            source_key: index.toString(16).padStart(64, '0'),
            now: new Date(Date.parse(T0) + index * 1000).toISOString(),
          }),
        ),
      );
    const listed = bills(db, '2030-12');
    assert.equal(HOUSEHOLD_BILL_LIST_LIMIT, 100);
    assert.equal(listed.truncated, true);
    assert.equal(listed.bills.length, 100);
    // 一番古い 1 件（T0）を切り、残りを作った順に返す。
    assert.equal(listed.bills[0]?.created_at, '2030-10-01T00:00:01.000Z');
    assert.equal(listed.bills.at(-1)?.created_at, '2030-10-01T00:01:40.000Z');
  });
});

test('household.bill_*: 形の誤りは書かずに拒否し、書込みを止めた worker は読み取りだけを続ける', async () => {
  await withDb((db) => {
    assert.deepEqual(
      reasons(
        run(
          db,
          billOp(randomUUID(), {
            source_key: 'x',
            month: '2030-13',
            now: 'now',
          }),
        ),
      ),
      ['source_key_invalid', 'month_invalid', 'now_invalid'],
    );
    assert.deepEqual(reasons(run(db, billOp('not-a-uuid'))), [
      'bill_id_invalid',
    ]);
    assert.deepEqual(
      reasons(run(db, { kind: 'household.bill_list', month: '1999-12' })),
      ['month_invalid'],
    );
    assert.deepEqual(reasons(run(db, billOp(randomUUID()), true)), [
      'worker_halted',
    ]);
    assert.equal(
      run(db, { kind: 'household.bill_list', month: '2030-12' }, true).ok,
      true,
    );
    assert.deepEqual(bills(db, '2030-12').bills, []);
  });
});

test('DB の trigger: 請求予定の行は変えられず消せず、暗号文は自分の請求予定のものだけを指す', async () => {
  await withDb((db) => {
    const id = randomUUID();
    value(run(db, billOp(id)));
    assert.throws(
      () => db.prepare('DELETE FROM household_bills WHERE bill_id = ?').run(id),
      /household_bill_no_delete/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE household_bills SET month = '2030-11' WHERE bill_id = ?",
          )
          .run(id),
      /household_bill_fixed/u,
    );
    // 家計の記録の暗号文は請求予定から指せない。
    const entryId = randomUUID();
    value(run(db, recordOp(entryId, { source_key: SOURCE_B })));
    const entryBlob = get(db, entryId).content?.blob_id;
    assert.ok(entryBlob);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO household_bills (bill_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at) VALUES (?, 'mail_bill', ?, 'active', '2030-12', 1, ?, 1)",
          )
          .run(randomUUID(), 'd'.repeat(64), entryBlob),
      /household_bill_blob_owner_mismatch/u,
    );
    // 出所の種類は mail_bill だけ。
    const other = randomUUID();
    const sealedBill = billOp(other, { source_key: 'e'.repeat(64) });
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO household_bills (bill_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at) VALUES (?, 'manual', ?, 'active', '2030-12', 1, ?, 1)",
          )
          .run(other, 'e'.repeat(64), sealedBill.content.blob_id),
      /CHECK|household_bill_blob_owner_mismatch/u,
    );
  });
});

test('DB worker を通しても請求予定の記録と読み取りが往復する', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    openSeededDatabase(path).close();
    const client = await DbWorkerClient.start({
      path,
      storeGeneration: STORE_GENERATION,
      responseTimeoutMs: 10_000,
    });
    try {
      const id = randomUUID();
      assert.deepEqual(await client.household(billOp(id)), {
        ok: true,
        value: { outcome: 'created', bill_id: id },
      });
      const listed = await client.household({
        kind: 'household.bill_list',
        month: '2030-12',
      });
      assert.equal(listed.ok, true);
      if (!listed.ok) throw new Error('unreachable');
      assert.equal(listed.value.bills.length, 1);
      const [record] = listed.value.bills;
      assert.ok(record);
      assert.deepEqual(openBill(record), BILL);
    } finally {
      await client.close();
    }
  });
});

// --- 請求予定を消す・レシートの写真の読み取りの設定（ADR 0179、マイグレーション 0022） ---

const deleteBill = (
  db: SqliteDatabase,
  billId: string,
  expected: string,
  now = T1,
): HouseholdOpResult =>
  run(db, {
    kind: 'household.bill_delete',
    bill_id: billId,
    expected_revision: expected,
    now,
  });

const billBlobCount = (db: SqliteDatabase): number =>
  (
    db
      .prepare(
        "SELECT count(*) AS n FROM sealed_blobs WHERE purpose = 'household_bill'",
      )
      .get() as { n: number }
  ).n;

test('household.bill_delete: 内容版を照合して消し、行は残して月と暗号文を消す。同じメールから作り直さない', async () => {
  await withDb((db) => {
    const id = randomUUID();
    const other = randomUUID();
    value(run(db, billOp(id)));
    value(
      run(
        db,
        billOp(other, { source_key: SOURCE_B }, { ...BILL, amount_yen: 500 }),
      ),
    );
    assert.equal(billBlobCount(db), 2);
    // 内容版が違えば消さない。
    assert.deepEqual(reasons(deleteBill(db, id, '2')), ['revision_mismatch']);
    assert.equal(bills(db, '2030-12').bills.length, 2);
    // 消す。内容版は 2 に進み、暗号文は消える。
    assert.deepEqual(value<HouseholdBillDeleteValue>(deleteBill(db, id, '1')), {
      bill_id: id,
      content_revision: '2',
    });
    assert.deepEqual(
      db
        .prepare(
          'SELECT state, month, content_revision, content_blob_id, deleted_at FROM household_bills WHERE bill_id = ?',
        )
        .get(id),
      {
        state: 'deleted',
        month: null,
        content_revision: 2,
        content_blob_id: null,
        deleted_at: Date.parse(T1),
      },
    );
    assert.equal(billBlobCount(db), 1);
    // 月の一覧に出ない（もう一つの請求予定だけ）。
    const listed = bills(db, '2030-12');
    assert.deepEqual(
      listed.bills.map((bill) => bill.bill_id),
      [other],
    );
    // 消した後の再送（同じ版・新しい版）は消した請求予定として拒否する。
    assert.deepEqual(reasons(deleteBill(db, id, '1')), ['bill_deleted']);
    assert.deepEqual(reasons(deleteBill(db, id, '2')), ['bill_deleted']);
    // ない請求予定。
    assert.deepEqual(reasons(deleteBill(db, randomUUID(), '1')), [
      'bill_missing',
    ]);
    // 同じメール（同じ出所の鍵）の読み直しでは作り直さない。
    assert.deepEqual(
      value<HouseholdBillRecordValue>(
        run(db, billOp(randomUUID(), { now: T2 })),
      ),
      { outcome: 'duplicate', bill_id: id, state: 'deleted' },
    );
    assert.equal(bills(db, '2030-12').bills.length, 1);
    // 作成時刻より前の時刻で消しても、消した時刻は作成時刻より前にならない。
    assert.equal(
      value<HouseholdBillDeleteValue>(
        deleteBill(db, other, '1', '2030-09-01T00:00:00.000Z'),
      ).content_revision,
      '2',
    );
    assert.equal(
      (
        db
          .prepare('SELECT deleted_at FROM household_bills WHERE bill_id = ?')
          .get(other) as { deleted_at: number }
      ).deleted_at,
      Date.parse(T0),
    );
    assert.equal(billBlobCount(db), 0);
    assert.deepEqual(bills(db, '2030-12').bills, []);
  });
});

test('household.bill_delete: 形の誤りは書かずに拒否し、書込みを止めた worker は消さない', async () => {
  await withDb((db) => {
    const id = randomUUID();
    value(run(db, billOp(id)));
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.bill_delete',
          bill_id: 'not-a-uuid',
          expected_revision: '0',
          now: 'later',
        }),
      ),
      ['bill_id_invalid', 'expected_revision_invalid', 'now_invalid'],
    );
    assert.deepEqual(
      reasons(
        run(
          db,
          {
            kind: 'household.bill_delete',
            bill_id: id,
            expected_revision: '1',
            now: T1,
          },
          true,
        ),
      ),
      ['worker_halted'],
    );
    assert.equal(bills(db, '2030-12').bills.length, 1);
  });
});

test('DB の trigger（0022）: 請求予定の変更は有効から消したへの変更だけで、行は消せない', async () => {
  await withDb((db) => {
    const id = randomUUID();
    value(run(db, billOp(id)));
    const blob = bills(db, '2030-12').bills[0]?.content?.blob_id;
    assert.ok(blob);
    // 有効のまま月・出所・作成時刻を変える。
    for (const sql of [
      "UPDATE household_bills SET month = '2030-11' WHERE bill_id = ?",
      "UPDATE household_bills SET source_key = '" +
        'f'.repeat(64) +
        "' WHERE bill_id = ?",
      'UPDATE household_bills SET created_at = 2 WHERE bill_id = ?',
      'UPDATE household_bills SET content_revision = 2 WHERE bill_id = ?',
    ])
      assert.throws(
        () => db.prepare(sql).run(id),
        /household_bill_fixed/u,
        sql,
      );
    // 内容版を飛ばして消す。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE household_bills SET state = 'deleted', month = NULL, content_blob_id = NULL, content_revision = 3, deleted_at = 5 WHERE bill_id = ?",
          )
          .run(id),
      /household_bill_fixed/u,
    );
    // 消したのに月・暗号文を残す形は表の CHECK が拒否する。
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE household_bills SET state = 'deleted', content_revision = 2, deleted_at = 5 WHERE bill_id = ?",
          )
          .run(id),
      /CHECK constraint failed/u,
    );
    assert.throws(
      () => db.prepare('DELETE FROM household_bills WHERE bill_id = ?').run(id),
      /household_bill_no_delete/u,
    );
    // 保存層の手順で消した後は、有効へ戻す・消した行を変えることもできない。
    value(deleteBill(db, id, '1'));
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE household_bills SET state = 'active', month = '2030-12', content_revision = 3, content_blob_id = ?, deleted_at = NULL WHERE bill_id = ?",
          )
          .run(blob, id),
      /household_bill_fixed/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE household_bills SET deleted_at = deleted_at + 1 WHERE bill_id = ?',
          )
          .run(id),
      /household_bill_fixed/u,
    );
    assert.throws(
      () => db.prepare('DELETE FROM household_bills WHERE bill_id = ?').run(id),
      /household_bill_no_delete/u,
    );
    // 作るときは有効・内容版 1 だけ。
    const fresh = billOp(randomUUID(), { source_key: 'e'.repeat(64) });
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO household_bills (bill_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, deleted_at) VALUES (?, 'mail_bill', ?, 'deleted', NULL, 2, NULL, 1, 1)",
          )
          .run(fresh.bill_id, 'e'.repeat(64)),
      /household_bill_insert_active/u,
    );
  });
});

const INSERT_ENTRY_OR_REPLACE =
  "INSERT OR REPLACE INTO household_entries (entry_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, updated_at, deleted_at) VALUES (?, 'manual', ?, 'active', '2030-10', 1, ?, 1, 1, NULL)";

// 版 1 の暗号文を、持ち主を指定した記録の ID として直接書く（置き換えの試験で、有効な行を作るため）。
function insertEntryBlob(db: SqliteDatabase, entryId: string): string {
  const blob = sealed(entryId, 1, LUNCH);
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'household_entry', 'household_entries', ?, 1, ?, ?, ?, ?, ?, 1000, NULL)",
  ).run(
    blob.blob_id,
    entryId,
    blob.format_version,
    blob.key_id,
    Buffer.from(blob.nonce),
    Buffer.from(blob.ciphertext),
    Buffer.from(blob.tag),
  );
  return blob.blob_id;
}

test('DB の trigger（0023）: 同じ ID・同じ出所の鍵の INSERT OR REPLACE は、消した印の行を置き換えられない。新しい記録の普通の INSERT は通る', async () => {
  await withDb((db) => {
    const id = randomUUID();
    value(run(db, recordOp(id)));
    value(
      run(db, {
        kind: 'household.delete',
        entry_id: id,
        expected_revision: '1',
        now: T1,
      }),
    );
    const before = db
      .prepare('SELECT * FROM household_entries WHERE entry_id = ?')
      .get(id);
    // 同じ出所の鍵で別の ID。
    const otherId = randomUUID();
    const otherBlob = insertEntryBlob(db, otherId);
    assert.throws(
      () =>
        db.prepare(INSERT_ENTRY_OR_REPLACE).run(otherId, SOURCE_A, otherBlob),
      /household_entry_no_replace/u,
    );
    // 同じ ID で別の出所の鍵。
    const sameIdBlob = insertEntryBlob(db, id);
    assert.throws(
      () => db.prepare(INSERT_ENTRY_OR_REPLACE).run(id, SOURCE_B, sameIdBlob),
      /household_entry_no_replace/u,
    );
    // 消した印の行は変わらない。
    assert.deepEqual(
      db.prepare('SELECT * FROM household_entries WHERE entry_id = ?').get(id),
      before,
    );
    assert.equal(
      (
        db
          .prepare('SELECT state FROM household_entries WHERE source_key = ?')
          .get(SOURCE_A) as { state: string }
      ).state,
      'deleted',
    );
    // 新しい ID・新しい出所の鍵なら、INSERT OR REPLACE でも衝突しないので入る。
    const freshId = randomUUID();
    const freshBlob = insertEntryBlob(db, freshId);
    db.prepare(INSERT_ENTRY_OR_REPLACE).run(freshId, 'e'.repeat(64), freshBlob);
    // 保存層の普通の INSERT（新しい記録）は今までどおり通る。
    assert.equal(
      value<HouseholdRecordValue>(
        run(db, recordOp(randomUUID(), { source_key: SOURCE_B })),
      ).outcome,
      'created',
    );
  });
});

test('マイグレーション 0023: 版 22 の DB の家計の記録は変わらず残り、置き換えの trigger が足される', async () => {
  await withTempDir((dir) => {
    const all = loadMigrations();
    const db = openWriteConnection(databasePath(dir), { platform: 'macos' });
    try {
      assert.deepEqual(applyMigrations(db, all.slice(0, 22)).to, 22);
      const active = randomUUID();
      const removed = randomUUID();
      const activeBlob = insertEntryBlob(db, active);
      db.prepare(
        "INSERT INTO household_entries (entry_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, updated_at, deleted_at) VALUES (?, 'manual', ?, 'active', '2030-10', 1, ?, 1000, 1000, NULL)",
      ).run(active, SOURCE_A, activeBlob);
      db.prepare(
        "INSERT INTO household_entries (entry_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, updated_at, deleted_at) VALUES (?, 'manual', ?, 'deleted', NULL, 2, NULL, 1000, 2000, 2000)",
      ).run(removed, SOURCE_B);
      const snapshot = (): unknown =>
        db.prepare('SELECT * FROM household_entries ORDER BY entry_id').all();
      const before = snapshot();
      const triggers = (): string[] =>
        (
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE tbl_name = 'household_entries' AND type = 'trigger' ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((row) => row.name);
      assert.ok(!triggers().includes('household_entries_no_replace'));
      assert.deepEqual(applyMigrations(db, all), {
        from: 22,
        to: 25,
        applied: [23, 24, 25],
      });
      assert.deepEqual(snapshot(), before);
      assert.ok(triggers().includes('household_entries_no_replace'));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      // 移した記録は読めて、消した印の行は置き換えられない。
      assert.ok(get(db, active).content);
      const replaceBlob = insertEntryBlob(db, randomUUID());
      assert.throws(
        () =>
          db
            .prepare(INSERT_ENTRY_OR_REPLACE)
            .run(removed, SOURCE_B, replaceBlob),
        /household_entry_no_replace/u,
      );
      assert.deepEqual(snapshot(), before);
    } finally {
      db.close();
    }
  });
});

test('DB の trigger（0022）: 同じ ID・同じ出所の鍵の INSERT OR REPLACE は、消した印の行を置き換えられない', async () => {
  await withDb((db) => {
    const id = randomUUID();
    const key = 'c'.repeat(64);
    value(run(db, billOp(id, { source_key: key })));
    value(deleteBill(db, id, '1'));
    const before = db
      .prepare('SELECT * FROM household_bills WHERE bill_id = ?')
      .get(id);
    const replace =
      "INSERT OR REPLACE INTO household_bills (bill_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, deleted_at) VALUES (?, 'mail_bill', ?, 'active', '2030-12', 1, NULL, 1, NULL)";
    // 同じ出所の鍵で別の ID。
    assert.throws(
      () => db.prepare(replace).run(randomUUID(), key),
      /household_bill_no_replace/u,
    );
    // 同じ ID で別の出所の鍵。
    assert.throws(
      () => db.prepare(replace).run(id, 'd'.repeat(64)),
      /household_bill_no_replace/u,
    );
    // 消した印の行は変わらない。
    assert.deepEqual(
      db.prepare('SELECT * FROM household_bills WHERE bill_id = ?').get(id),
      before,
    );
    assert.equal(
      (
        db
          .prepare('SELECT state FROM household_bills WHERE source_key = ?')
          .get(key) as { state: string }
      ).state,
      'deleted',
    );
  });
});

const setReceipt = (
  db: SqliteDatabase,
  expected: string,
  receiptReading: 'on' | 'off',
): HouseholdOpResult =>
  run(db, {
    kind: 'household.receipt_setting_set',
    expected_revision: expected,
    receipt_reading: receiptReading,
    now: T2,
  });

test('household.receipt_setting_set: 既定は切。版を照合して保存し、利用通知の取り込みの入・切と同じ版を進める', async () => {
  await withDb((db) => {
    assert.deepEqual(settings(db), {
      mail_intake: 'on',
      receipt_reading: 'off',
      settings_revision: '0',
    });
    // 行がないときに入にすると、利用通知の取り込みは入のまま行を作る。
    assert.deepEqual(value(setReceipt(db, '0', 'on')), {
      mail_intake: 'on',
      receipt_reading: 'on',
      settings_revision: '1',
    });
    // 入にする要求は古い版では変えない。
    assert.deepEqual(reasons(setReceipt(db, '0', 'on')), ['revision_mismatch']);
    assert.equal(settings(db).receipt_reading, 'on');
    // 切にする要求は安全な向きなので、版が違っても保存する（今の版 1 から 1 進めて 2）。
    assert.deepEqual(value(setReceipt(db, '0', 'off')), {
      mail_intake: 'on',
      receipt_reading: 'off',
      settings_revision: '2',
    });
    // 同じ値でも版は進む。
    assert.deepEqual(value(setReceipt(db, '2', 'on')), {
      mail_intake: 'on',
      receipt_reading: 'on',
      settings_revision: '3',
    });
    assert.deepEqual(reasons(setReceipt(db, '2', 'on')), ['revision_mismatch']);
    // 利用通知の取り込みを変えても、レシートの設定は入のまま。版は共通に進む。
    assert.deepEqual(value(setIntake(db, '3', 'off')), {
      mail_intake: 'off',
      receipt_reading: 'on',
      settings_revision: '4',
    });
    // 取り込みの入・切を変えた後に、前の版（3）で切にしても保存する（版は 5）。取り込みの切は残る。
    assert.deepEqual(value(setReceipt(db, '3', 'off')), {
      mail_intake: 'off',
      receipt_reading: 'off',
      settings_revision: '5',
    });
    // 前の版で入にする要求は拒否する。
    assert.deepEqual(reasons(setReceipt(db, '3', 'on')), ['revision_mismatch']);
    assert.equal(settings(db).receipt_reading, 'off');
    // 形の誤り。DB の CHECK は on・off 以外を拒否する。
    assert.deepEqual(
      reasons(
        run(db, {
          kind: 'household.receipt_setting_set',
          expected_revision: '01',
          receipt_reading: 'unavailable' as 'on',
          now: 'later',
        }),
      ),
      ['expected_revision_invalid', 'receipt_reading_invalid', 'now_invalid'],
    );
    // 書込みを止めた worker は保存しない。
    assert.deepEqual(
      reasons(
        run(
          db,
          {
            kind: 'household.receipt_setting_set',
            expected_revision: '4',
            receipt_reading: 'on',
            now: T2,
          },
          true,
        ),
      ),
      ['worker_halted'],
    );
    assert.equal(settings(db).receipt_reading, 'off');
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE household_settings SET receipt_reading = 'unavailable', settings_revision = settings_revision + 1 WHERE setting_id = 1",
          )
          .run(),
      /CHECK constraint failed/u,
    );
  });
});

test('マイグレーション 0022: 版 21 の DB の請求予定は有効・内容版 1 で残り、設定は版を保ったままレシートの設定が切になる', async () => {
  await withTempDir((dir) => {
    const all = loadMigrations();
    const db = openWriteConnection(databasePath(dir), { platform: 'macos' });
    try {
      assert.deepEqual(applyMigrations(db, all.slice(0, 21)).to, 21);
      const id = randomUUID();
      const sealedBill = billOp(id).content;
      // 版 21 の形で請求予定と暗号文、設定の行を書く。
      db.prepare(
        "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'household_bill', 'household_bills', ?, 1, ?, ?, ?, ?, ?, 1000, NULL)",
      ).run(
        sealedBill.blob_id,
        id,
        sealedBill.format_version,
        sealedBill.key_id,
        Buffer.from(sealedBill.nonce),
        Buffer.from(sealedBill.ciphertext),
        Buffer.from(sealedBill.tag),
      );
      db.prepare(
        "INSERT INTO household_bills (bill_id, source_kind, source_key, month, content_blob_id, created_at) VALUES (?, 'mail_bill', ?, '2030-12', ?, 1000)",
      ).run(id, SOURCE_A, sealedBill.blob_id);
      db.prepare(
        "INSERT INTO household_settings (setting_id, mail_intake, settings_revision, updated_at) VALUES (1, 'off', 3, 1000)",
      ).run();
      assert.deepEqual(applyMigrations(db, all.slice(0, 22)), {
        from: 21,
        to: 22,
        applied: [22],
      });
      assert.deepEqual(
        db
          .prepare(
            'SELECT bill_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, deleted_at FROM household_bills',
          )
          .all(),
        [
          {
            bill_id: id,
            source_kind: 'mail_bill',
            source_key: SOURCE_A,
            state: 'active',
            month: '2030-12',
            content_revision: 1,
            content_blob_id: sealedBill.blob_id,
            created_at: 1000,
            deleted_at: null,
          },
        ],
      );
      // 移した請求予定は読めて、消せる。設定は版 3 のまま、レシートの設定は切。
      const [record] = bills(db, '2030-12').bills;
      assert.ok(record);
      assert.deepEqual(openBill(record), BILL);
      assert.deepEqual(settings(db), {
        mail_intake: 'off',
        receipt_reading: 'off',
        settings_revision: '3',
      });
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(
        value<HouseholdBillDeleteValue>(deleteBill(db, id, '1')),
        {
          bill_id: id,
          content_revision: '2',
        },
      );
      assert.equal(billBlobCount(db), 0);
      // trigger と索引は作り直されている。
      assert.deepEqual(
        (
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE tbl_name = 'household_bills' AND type IN ('trigger', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((row) => row.name),
        [
          'household_bills_blob_owner',
          'household_bills_delete_only',
          'household_bills_insert_active',
          'household_bills_month',
          'household_bills_no_delete',
          'household_bills_no_replace',
        ],
      );
    } finally {
      db.close();
    }
  });
});

test('DB worker を通しても請求予定を消す操作とレシートの設定の保存が往復する', async () => {
  await withTempDir(async (dir) => {
    const path = databasePath(dir);
    openSeededDatabase(path).close();
    const client = await DbWorkerClient.start({
      path,
      storeGeneration: STORE_GENERATION,
      responseTimeoutMs: 10_000,
    });
    try {
      const id = randomUUID();
      await client.household(billOp(id));
      assert.deepEqual(
        await client.household({
          kind: 'household.bill_delete',
          bill_id: id,
          expected_revision: '1',
          now: T1,
        }),
        { ok: true, value: { bill_id: id, content_revision: '2' } },
      );
      assert.deepEqual(
        await client.household({
          kind: 'household.receipt_setting_set',
          expected_revision: '0',
          receipt_reading: 'on',
          now: T1,
        }),
        {
          ok: true,
          value: {
            mail_intake: 'on',
            receipt_reading: 'on',
            settings_revision: '1',
          },
        },
      );
    } finally {
      await client.close();
    }
    // DB を開き直しても（中枢を起動し直しても）入のまま。
    const reopened = openWriteConnection(path, { platform: 'macos' });
    try {
      assert.deepEqual(settings(reopened), {
        mail_intake: 'on',
        receipt_reading: 'on',
        settings_revision: '1',
      });
    } finally {
      reopened.close();
    }
  });
});
