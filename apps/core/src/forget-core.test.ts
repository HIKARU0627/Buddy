// 製品の Core（startCore、HTTPS は 127.0.0.1・鍵は模擬）での忘却の経路（B06-07b-2、ADR 0180）。
// - 忘却の公開ゲート（U112）は閉じているので、計画・実行の経路は 503 で、台帳は動かない。
// - 忘却台帳の配信は、登録済みの端末に、端末の head の続きを返す（ロック中でも返す。自宅の外は 403）。
// 忘却は保存層の命令で直接適用する（ゲートを通らない試験の手順。元情報は行がなくても台帳に書ける）。HMAC は試験用に
// 決めた 64 桁の値。期待値は手で書いた。実機・実データは使わない。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { planForget } from '@buddy/domain';
import type { MemorySource } from '@buddy/domain';
import { sharedApiContract } from './api-test-support.js';
import {
  bootstrap,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';

const contract = sharedApiContract();
const ZERO = '0'.repeat(64);
const SOURCE: MemorySource = {
  source_kind: 'source_item',
  source_id: 'mail-synthetic-001',
};
const SOURCE_HMAC = 'a7'.repeat(32);
const MEMORY = 'c0000000-0000-4000-8000-0000000000c1';
const SCREEN = { 'buddy-input-origin': 'screen' };

async function ledgerGeneration(core: EventCore): Promise<string> {
  const exported = await core.handle.store.memory({
    kind: 'forget.ledger_export',
  });
  assert(exported.ok);
  return exported.value.head.forgetting_generation;
}

async function forgetSource(core: EventCore): Promise<void> {
  const read = await core.handle.store.memory({
    kind: 'forget.graph',
    target: SOURCE,
  });
  assert(read.ok);
  const plan = planForget({
    target: SOURCE,
    instruction_turn_id: null,
    executing_operation_id: null,
    graph: read.value.graph,
    sourceHmac: () => SOURCE_HMAC,
  });
  assert(plan.ok);
  const applied = await core.handle.store.memory({
    kind: 'forget.apply',
    target: SOURCE,
    instruction_turn_id: null,
    plan: plan.plan,
    source_hmacs: [{ ...SOURCE, hmac: SOURCE_HMAC }],
    entry_id: randomUUID(),
    previous_generation: read.value.forgetting_generation,
    new_ledger_id: randomUUID(),
    now: Date.parse('2031-01-01T00:00:00.000Z'),
  });
  assert(applied.ok, JSON.stringify(applied));
}

test(
  'the product Core keeps the forget routes closed and serves the ledger to registered devices',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);

    // 忘却の公開ゲートが閉じている: 計画も実行も 503 で、台帳は動かない。
    const planned = await postJson(
      core,
      device,
      '/v1/memory/forget-plans',
      { request_id: randomUUID(), command_scope_id: scope, memory_id: MEMORY },
      SCREEN,
    );
    assert.equal(planned.status, 503, planned.text);
    assert.equal(planned.json?.['code'], 'dependency_unavailable');
    const executed = await postJson(
      core,
      device,
      `/v1/memory/forget-plans/${randomUUID()}/execute`,
      {
        request_id: randomUUID(),
        command_scope_id: scope,
        forgetting_generation: '0',
      },
      SCREEN,
    );
    assert.equal(executed.status, 503, executed.text);
    assert.equal(await ledgerGeneration(core), '0');

    // 配信: 空の台帳。
    const sync = (body: Record<string, unknown>) =>
      postJson(core, device, '/v1/forget-ledger/sync', body);
    const empty = await sync({
      ledger_id: null,
      forgetting_generation: '0',
      entry_hash: ZERO,
    });
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.json, {
      schema: 'buddy.forget-ledger-delta.v1',
      outcome: 'entries',
      ledger_id: null,
      head: { forgetting_generation: '0', entry_hash: ZERO },
      entries: [],
      has_more: false,
    });

    // 忘却（保存層の命令で直接）の後は、世代 1 の 1 件を返す。元情報は HMAC だけで、生の ID は出ない。
    await forgetSource(core);
    const after = await sync({
      ledger_id: null,
      forgetting_generation: '0',
      entry_hash: ZERO,
    });
    assert.equal(after.status, 200, after.text);
    assert(contract.valid('ForgetLedgerDelta', after.json));
    const body = after.json as {
      ledger_id: string;
      entries: {
        entry: { forgetting_generation: string; forgotten: unknown[] };
        entry_hash: string;
      }[];
    };
    assert.equal(body.entries.length, 1);
    assert.deepEqual(body.entries[0]?.entry.forgotten, [
      { source_kind: 'source_item', source_id_hmac: SOURCE_HMAC },
    ]);
    assert(!after.text.includes(SOURCE.source_id));

    // ロック中でも返す（本文のない台帳。端末の複製を保つ）。自宅の外は拒否する。
    core.env.lock = 'locked';
    const locked = await sync({
      ledger_id: body.ledger_id,
      forgetting_generation: '1',
      entry_hash: body.entries[0]?.entry_hash,
    });
    assert.equal(locked.status, 200, locked.text);
    assert.deepEqual(locked.json?.['entries'], []);
    core.env.home = false;
    const outside = await sync({
      ledger_id: null,
      forgetting_generation: '0',
      entry_hash: ZERO,
    });
    assert.equal(outside.status, 403);
    assert.equal(outside.json?.['code'], 'outside_home_network');
  },
);
