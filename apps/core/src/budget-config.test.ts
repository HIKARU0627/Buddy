// 予算の実行時の設定ファイルの読み込み（ADR 0034・0037）。合成の設定（XTS、縮めた上限）で、形・意味・タイムゾーンの
// 検査とファイルの扱いを確かめる。期待値（理由コード・正規化した名前）は手で書いた値。domain の意味検査は、契約の
// 例（schema-cases.json）に手で書いた semantic_errors と一致することを確かめる（Core は scripts を読まない）。

import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { budgetRuntimeConfigErrors, normalizeTimeZone } from '@buddy/domain';
import type { BudgetRuntimeConfigInput } from '@buddy/domain';
import { createApiContract } from './api-contract.js';
import {
  MAX_BUDGET_CONFIG_BYTES,
  checkBudgetConfigText,
  loadBudgetConfig,
} from './budget-config.js';
import { syntheticConfig } from './budget-test-support.js';

const contract = createApiContract();
const TOKYO = () => 'Asia/Tokyo';

const check = (
  config: Record<string, unknown>,
  osTimeZone: () => string = TOKYO,
) => checkBudgetConfigText(JSON.stringify(config), contract, osTimeZone);

const reasonsOf = (result: ReturnType<typeof check>): readonly string[] =>
  result.ok ? [] : result.reasons;

test('a valid synthetic configuration loads with its settings and time zone', () => {
  const loaded = check(syntheticConfig());
  assert(loaded.ok);
  assert.equal(loaded.timeZone, 'Asia/Tokyo');
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(loaded.settings.currency, 'XTS');
  assert.deepEqual(
    loaded.settings.pools.map((pool) => [
      pool.poolId,
      pool.parentPoolId,
      pool.limit,
      pool.requiresApproval,
    ]),
    [
      ['total', null, '200', false],
      ['llm', 'total', '100', false],
      ['llm.background', 'llm', '50', false],
      ['search', 'total', '40', false],
      ['voice', null, '50', false],
      ['overage', null, '60', true],
    ],
  );
  assert.deepEqual(loaded.settings.verifiedPriceVersions, [
    'xts.text.v1',
    'xts.live.v1',
  ]);
});

test('broken JSON, duplicate keys, unknown fields and semantic errors disable paid processing', () => {
  assert.deepEqual(
    reasonsOf(checkBudgetConfigText('{"schema":', contract, TOKYO)),
    ['config_invalid_json'],
  );
  assert.deepEqual(
    reasonsOf(
      checkBudgetConfigText(
        '{"schema":"buddy.budget-runtime.v1","schema":"x"}',
        contract,
        TOKYO,
      ),
    ),
    ['config_duplicate_key'],
  );
  // 秘密情報の項目は形で拒否する。
  assert.deepEqual(
    reasonsOf(check(syntheticConfig((config) => (config['api_key'] = 'x')))),
    ['config_schema_invalid'],
  );
  assert.deepEqual(
    reasonsOf(check(syntheticConfig((config) => delete config['routing']))),
    ['config_schema_invalid'],
  );
  // 同じ系列の単価の版の期間が重なる。
  assert.deepEqual(
    reasonsOf(
      check(
        syntheticConfig((config) => {
          const versions = config['price_versions'] as Record<
            string,
            unknown
          >[];
          versions.push({
            ...versions[0],
            price_version: 'xts.text.v2',
            effective_from: '2030-06-01T00:00:00.000Z',
          });
        }),
      ),
    ),
    ['config_semantic:price_period_overlap'],
  );
  // 自発の処理を本人の依頼の LLM の枠へ計上する設定。
  assert.deepEqual(
    reasonsOf(
      check(
        syntheticConfig((config) => {
          const routing = config['routing'] as {
            routes: Record<string, { llm: string | null }>;
          };
          (routing.routes['initial_import'] as { llm: string | null }).llm =
            'llm';
        }),
      ),
    ),
    ['config_semantic:autonomous_shares_owner_pool'],
  );
});

test('the time zone is normalized by Intl, an old alias warns and Etc/* is refused', () => {
  const japan = check(
    syntheticConfig((config) => (config['time_zone'] = 'Japan')),
  );
  assert(japan.ok);
  assert.equal(japan.timeZone, 'Asia/Tokyo');
  assert.deepEqual(japan.warnings, ['time_zone_normalized']);
  const utc = check(syntheticConfig((config) => (config['time_zone'] = 'UTC')));
  assert(utc.ok);
  assert.deepEqual([utc.timeZone, utc.warnings], ['UTC', []]);
  // Etc/GMT+9 は UTC−9（符号の取り違えが起きやすい）なので受け付けない。
  assert.deepEqual(
    reasonsOf(
      check(syntheticConfig((config) => (config['time_zone'] = 'Etc/GMT+9'))),
    ),
    ['time_zone_rejected:etc_time_zone'],
  );
  // null は中枢の OS の設定。OS の設定にも同じ規則を当てる。
  const os = check(
    syntheticConfig((config) => (config['time_zone'] = null)),
    () => 'America/New_York',
  );
  assert(os.ok);
  assert.equal(os.timeZone, 'America/New_York');
  assert.deepEqual(
    reasonsOf(
      check(
        syntheticConfig((config) => (config['time_zone'] = null)),
        () => 'Etc/GMT-9',
      ),
    ),
    ['time_zone_rejected:etc_time_zone'],
  );
  assert.deepEqual(normalizeTimeZone('Etc/UTC'), {
    ok: true,
    timeZone: 'UTC',
    normalized: true,
  });
  assert.deepEqual(normalizeTimeZone('+09:00'), {
    ok: false,
    reason: 'unknown_time_zone',
  });
  assert.deepEqual(normalizeTimeZone('Mars/Olympus'), {
    ok: false,
    reason: 'unknown_time_zone',
  });
});

test('the configuration file must be a small regular file that only the owner can write', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-budget-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'budget-runtime.json');
  const load = () => loadBudgetConfig({ path, contract, osTimeZone: TOKYO });
  assert.deepEqual(await load(), { ok: false, reasons: ['config_missing'] });
  await writeFile(path, JSON.stringify(syntheticConfig()), { mode: 0o600 });
  assert.equal((await load()).ok, true);
  if (process.platform !== 'win32') {
    await chmod(path, 0o664);
    assert.deepEqual(await load(), {
      ok: false,
      reasons: ['config_writable_by_others'],
    });
    await chmod(path, 0o600);
    const link = join(dir, 'link.json');
    await symlink(path, link);
    assert.deepEqual(
      await loadBudgetConfig({ path: link, contract, osTimeZone: TOKYO }),
      { ok: false, reasons: ['config_not_regular_file'] },
    );
  }
  const folder = join(dir, 'folder');
  await mkdir(folder);
  assert.deepEqual(
    await loadBudgetConfig({ path: folder, contract, osTimeZone: TOKYO }),
    { ok: false, reasons: ['config_not_regular_file'] },
  );
  await writeFile(path, Buffer.alloc(MAX_BUDGET_CONFIG_BYTES + 1, 0x20), {
    mode: 0o600,
  });
  assert.deepEqual(await load(), { ok: false, reasons: ['config_too_large'] });
  await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]), { mode: 0o600 });
  assert.deepEqual(await load(), {
    ok: false,
    reasons: ['config_unreadable'],
  });
});

test('the domain semantic check agrees with the hand-written semantic errors of the contract examples', () => {
  const cases = JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/contracts/fixtures/schema-cases.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    id: string;
    schema: string;
    valid: boolean;
    value: unknown;
    semantic_errors?: string[];
  }[];
  const runtime = cases.filter(
    (entry) => entry.schema === 'BudgetRuntimeConfig' && entry.valid,
  );
  assert(runtime.length >= 15, String(runtime.length));
  for (const entry of runtime)
    assert.deepEqual(
      budgetRuntimeConfigErrors(entry.value as BudgetRuntimeConfigInput),
      entry.semantic_errors ?? [],
      entry.id,
    );
});
