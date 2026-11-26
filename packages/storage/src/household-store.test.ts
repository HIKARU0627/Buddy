// 家計の記録と分類の規則の保存（ADR 0158、マイグレーション 0016）。
// DB は一時ディレクトリに作って消す。暗号文は合成のデータ鍵で実際に暗号化し、復号して中身を確かめる。
// 期待値は ADR 0158 の判断（出所の鍵で作り直さない・内容版の照合・削除は行を残す・本人の規則を取込みで上書きしない）
// から手で書いた値。店名・金額は合成で、実データは使わない。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { HouseholdEntryContent } from '@buddy/domain';
import {
  DbWorkerClient,
  executeHouseholdOp,
  openHouseholdBudget,
  openHouseholdContent,
  sealHouseholdBudget,
  sealHouseholdContent,
} from './index.js';
import type {
  DataKeyMaterial,
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
      settings_revision: '0',
    });
    seedMail(db, 'm-before', 1000);
    assert.equal(pending(db).baseline, true);
    seedMail(db, 'm-new', 2000);
    assert.deepEqual(pending(db).remote_ids, ['m-new']);
    // 止める。古い版では拒否する。
    assert.deepEqual(value(setIntake(db, '0', 'off')), {
      mail_intake: 'off',
      settings_revision: '1',
    });
    assert.deepEqual(reasons(setIntake(db, '0', 'on')), ['revision_mismatch']);
    assert.deepEqual(settings(db), {
      mail_intake: 'off',
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
