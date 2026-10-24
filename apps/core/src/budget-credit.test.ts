// 付帯クレジットの残高の観測の読み込み（B07-07、ADR 0042）。合成の観測（予算の通貨は XTS、残高の通貨は XXX）で、形・意味の
// 検査とファイルの扱いを確かめる。期待値（理由コード・読めた件数）は手で書いた値。意味検査は domain と契約で同じ理由コードを
// 返す（scripts/budget-credit.test.mjs が契約の例と照合する）。

import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiContract } from './api-contract.js';
import {
  MAX_BUDGET_CREDIT_BYTES,
  checkCreditObservationsText,
  fileCreditSource,
  loadCreditObservations,
} from './budget-credit.js';
import {
  MockPaidProvider,
  claudeRequest,
  creditConfig,
  creditObservation,
  loadedConfig,
  uuid,
  withBudgetStore,
} from './budget-test-support.js';

const contract = createApiContract();

const file = (...observations: unknown[]) =>
  JSON.stringify({
    schema: 'buddy.budget-credit-observations.v1',
    observations,
  });

const check = (text: string) => checkCreditObservationsText(text, contract);
const reasonsOf = (result: ReturnType<typeof check>): readonly string[] =>
  result.ok ? [] : result.reasons;

test('a valid list of observations loads as it is written, and an empty list is valid', () => {
  const loaded = check(file(creditObservation()));
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.ok ? loaded.observations : [], [creditObservation()]);
  const empty = check(file());
  assert.deepEqual(empty, { ok: true, observations: [] });
});

test('malformed, duplicated, unknown-field and inconsistent observations are refused with reason codes only', () => {
  assert.deepEqual(reasonsOf(check('{')), ['credit_invalid_json']);
  assert.deepEqual(
    reasonsOf(
      check(
        '{"schema":"buddy.budget-credit-observations.v1","observations":[],"observations":[]}',
      ),
    ),
    ['credit_duplicate_key'],
  );
  assert.deepEqual(
    reasonsOf(check('{"schema":"buddy.budget-credit-observations.v0"}')),
    ['credit_schema_invalid'],
  );
  assert.deepEqual(
    reasonsOf(
      check(
        file({ ...creditObservation(), email: 'synthetic@example.invalid' }),
      ),
    ),
    ['credit_schema_invalid'],
  );
  assert.deepEqual(
    reasonsOf(check(file({ ...creditObservation(), balance: null }))),
    ['credit_semantic:missing_observed_balance'],
  );
  assert.deepEqual(
    reasonsOf(
      check(file(creditObservation(), creditObservation({ shared: true }))),
    ),
    ['credit_semantic:duplicate_observation'],
  );
  assert.deepEqual(
    reasonsOf(
      check(file(creditObservation({ cycle_id: 'anthropic:2030-02-30' }))),
    ),
    ['credit_semantic:invalid_cycle_date'],
  );
  // 理由のコードだけで、残高・組織の名前などの中身を返さない。
  const text = JSON.stringify(
    reasonsOf(check(file({ ...creditObservation(), balance: null }))),
  );
  assert(!text.includes('50') && !text.includes('synthetic-organization'));
});

test('the observation file must be a small regular file that only the owner can write, and a missing file is told apart from an unreadable one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-budget-credit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'budget-credit-observations.json');
  const load = () => loadCreditObservations({ path, contract });
  assert.deepEqual(await load(), {
    ok: false,
    reasons: ['credit_missing'],
    missing: true,
  });
  await writeFile(path, file(creditObservation()), { mode: 0o600 });
  assert.equal((await load()).ok, true);
  if (process.platform !== 'win32') {
    await chmod(path, 0o664);
    assert.deepEqual(await load(), {
      ok: false,
      reasons: ['credit_writable_by_others'],
      missing: false,
    });
    await chmod(path, 0o600);
    const link = join(dir, 'link.json');
    await symlink(path, link);
    assert.deepEqual(await loadCreditObservations({ path: link, contract }), {
      ok: false,
      reasons: ['credit_not_regular_file'],
      missing: false,
    });
  }
  const folder = join(dir, 'folder');
  await mkdir(folder);
  assert.deepEqual(await loadCreditObservations({ path: folder, contract }), {
    ok: false,
    reasons: ['credit_not_regular_file'],
    missing: false,
  });
  await writeFile(path, Buffer.alloc(MAX_BUDGET_CREDIT_BYTES + 1, 0x20), {
    mode: 0o600,
  });
  assert.deepEqual(await load(), {
    ok: false,
    reasons: ['credit_too_large'],
    missing: false,
  });
  await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]), { mode: 0o600 });
  assert.deepEqual(await load(), {
    ok: false,
    reasons: ['credit_unreadable'],
    missing: false,
  });
});

test('the gate reads the file every time, so a balance the owner writes takes effect without restarting Core', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-budget-credit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'budget-credit-observations.json');
  const source = fileCreditSource({ path, contract });
  await withBudgetStore(async (harness) => {
    const provider = new MockPaidProvider();
    let next = 100;
    const gate = harness.gate({
      config: loadedConfig(creditConfig()),
      creditObservations: source,
      newId: () => uuid(next++),
    });
    await gate.start();
    // ファイルがない: Claude の処理は保留（残高不明）。
    assert.deepEqual(await gate.run(claudeRequest(uuid(1)), provider.send), {
      kind: 'rejected',
      reasons: ['credit_unknown'],
      budgetHeld: true,
    });
    // 本人が残高 50 XXX（= 100 XTS）を書く: 受け付けて、実費 30 を全額クレジットにする。
    await writeFile(path, file(creditObservation()), { mode: 0o600 });
    provider.plan(uuid(2), { kind: 'usage', actual: '30' });
    const settled = await gate.run(claudeRequest(uuid(2)), provider.send);
    assert.equal(settled.kind, 'settled');
    assert.equal((await gate.creditStatus()).available, '70');
    // 本人が残高を 5 XXX（= 10 XTS）に書き直す（他の用途が使った）。観測の時刻が新しい方が残高になる。
    await writeFile(
      path,
      file(
        creditObservation(),
        creditObservation({
          observed_at: '2030-10-15T00:00:01.000Z',
          balance: { currency: 'XXX', amount: '5' },
        }),
      ),
      { mode: 0o600 },
    );
    harness.clock.set(Date.parse('2030-10-15T00:00:02.000Z'));
    assert.deepEqual(await gate.run(claudeRequest(uuid(3)), provider.send), {
      kind: 'rejected',
      reasons: ['credit_insufficient'],
      budgetHeld: true,
    });
    // 壊れた書き込み（不正な JSON）は、新しい観測を採用しないだけで、採用済みの観測（残高 10）のまま判定する。壊れた書き込みを
    // 残高が戻った（読めた）扱いにも、古い残高 100 へ戻る扱いにもしない。
    await writeFile(path, '{"schema":', { mode: 0o600 });
    assert.deepEqual(await gate.run(claudeRequest(uuid(4)), provider.send), {
      kind: 'rejected',
      reasons: ['credit_insufficient'],
      budgetHeld: true,
    });
    // 古い観測だけに書き戻しても、採用済みの新しい観測（残高 10）のまま。
    await writeFile(path, file(creditObservation()), { mode: 0o600 });
    assert.deepEqual(await gate.run(claudeRequest(uuid(5)), provider.send), {
      kind: 'rejected',
      reasons: ['credit_insufficient'],
      budgetHeld: true,
    });
    assert.equal(provider.receipts.length, 1);
  });
});

test('a list above the count limit is refused with a reason that names the limit, not a generic shape error', () => {
  const many = Array.from({ length: 121 }, (_, index) =>
    creditObservation({
      observed_at: new Date(Date.UTC(2030, 9, 1, 0, 0, index)).toISOString(),
    }),
  );
  assert.deepEqual(reasonsOf(check(file(...many))), [
    'credit_too_many_observations',
  ]);
  // 120 件までは読める。
  assert.equal(check(file(...many.slice(0, 120))).ok, true);
});
