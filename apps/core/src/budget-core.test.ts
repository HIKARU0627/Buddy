// Core に組み込んだ予算の門（ADR 0037）: データディレクトリの設定ファイルの読み込み、スナップショットの予算保留
// （budget_hold）、制御チャネルの予算月の状態と確かめ直し、制御の要求の形の検査。Core は同じプロセスの startCore
// （HTTPS は 127.0.0.1、鍵は模擬）。期待値は手で書いた値。模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createApiContract } from './api-contract.js';
import { tempDir } from './api-test-support.js';
import { BUDGET_CONFIG_FILE } from './budget-config.js';
import { OCT_15, syntheticConfig } from './budget-test-support.js';
import { callControl } from './control-channel.js';
import { parseControlRequest } from './control-protocol.js';
import { getJson, insertDevice, startEventCore } from './event-test-support.js';

const contract = createApiContract();
const bytes = (text: string) => new TextEncoder().encode(text);
// 制御チャネルの応答は原型のないオブジェクトなので、比べる前に普通の値にする。
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test(
  'without a budget configuration file the snapshot shows the budget hold as config_invalid, and locked views carry none',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    assert.equal(core.handle.budget.configured, false);
    const device = await insertDevice(core.handle.store);
    const full = await getJson(core, device, '/v1/snapshot');
    assert.equal(full.status, 200, full.text);
    assert(contract.valid('Snapshot', full.json), full.text);
    assert.deepEqual(full.json?.['budget_hold'], {
      held: true,
      reasons: ['config_invalid'],
      held_pools: [],
    });
    core.env.lock = 'locked';
    const hidden = await getJson(core, device, '/v1/snapshot');
    assert(contract.valid('Snapshot', hidden.json), hidden.text);
    assert.equal(hidden.json?.['budget_hold'], null);
  },
);

test(
  'a configuration file in the data directory enables the gate, and the control channel shows and confirms the budget month',
  { timeout: 30_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-budget-core-'), 'data');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dataDir, BUDGET_CONFIG_FILE),
      JSON.stringify(syntheticConfig()),
      { mode: 0o600 },
    );
    const core = await startEventCore(t, {
      dataDir,
      budget: { tickIntervalMs: 0, now: () => OCT_15 },
    });
    assert.equal(core.handle.budget.configured, true);
    const device = await insertDevice(core.handle.store);
    const full = await getJson(core, device, '/v1/snapshot');
    assert(contract.valid('Snapshot', full.json), full.text);
    assert.deepEqual(full.json?.['budget_hold'], {
      held: false,
      reasons: [],
      held_pools: [],
    });
    const status = await callControl(
      core.handle.endpoint,
      'budget_calendar_status',
      5000,
    );
    assert.equal(status.kind, 'response');
    if (status.kind !== 'response') return;
    assert.equal(status.body['ok'], true, JSON.stringify(status.body));
    assert.deepEqual(plain(status.body['budget_calendar']), {
      configured: true,
      configured_time_zone: 'Asia/Tokyo',
      month: '2030-10',
      time_zone: 'Asia/Tokyo',
      month_start: '2030-09-30T15:00:00.000Z',
      month_start_time_zone: 'Asia/Tokyo',
      recorded_month_start: '2030-09-30T15:00:00.000Z',
      recomputed_month_start: '2030-09-30T15:00:00.000Z',
      regression_floor: null,
      hold_reasons: [],
      checked_at: '2030-10-15T00:00:00.000Z',
    });
    // 止まっていない予算月の確かめ直しは記録しない。
    const confirm = await callControl(
      core.handle.endpoint,
      'budget_calendar_confirm',
      5000,
      {
        reason: 'clock_regressed',
        month: '2030-10',
        month_start: '2030-09-30T15:00:00.000Z',
      },
    );
    assert.equal(confirm.kind, 'response');
    if (confirm.kind !== 'response') return;
    assert.deepEqual(plain(confirm.body), {
      ok: false,
      error: 'refused',
      reason: 'nothing_to_confirm',
    });
  },
);

test('the budget calendar control requests are checked strictly', () => {
  const id = randomUUID();
  const confirm = (fields: Record<string, unknown>) => {
    const result = parseControlRequest(
      bytes(
        JSON.stringify({
          op: 'budget_calendar_confirm',
          request_id: id,
          reason: 'calendar_mismatch',
          month: '2030-10',
          month_start: '2030-09-30T15:00:00.000Z',
          ...fields,
        }),
      ),
    );
    return result.ok ? result.request : result.reason;
  };
  assert.deepEqual(confirm({}), {
    op: 'budget_calendar_confirm',
    request_id: id,
    reason: 'calendar_mismatch',
    month: '2030-10',
    month_start: '2030-09-30T15:00:00.000Z',
  });
  assert.equal(confirm({ reason: 'month_rolled' }), 'invalid_reason');
  assert.equal(confirm({ month: '2030-13' }), 'invalid_month');
  // 秒までの時刻・暦にない日付・UTC 以外は受け付けない。
  assert.equal(
    confirm({ month_start: '2030-09-30T15:00:00Z' }),
    'invalid_month_start',
  );
  assert.equal(
    confirm({ month_start: '2030-02-30T15:00:00.000Z' }),
    'invalid_month_start',
  );
  assert.equal(
    confirm({ month_start: '2030-09-30T15:00:00.000+09:00' }),
    'invalid_month_start',
  );
  assert.equal(confirm({ month: 202010 }), 'invalid_type');
  assert.equal(confirm({ extra: 'x' }), 'unknown_field');
  assert.deepEqual(
    parseControlRequest(
      bytes(JSON.stringify({ op: 'budget_calendar_status', request_id: id })),
    ),
    { ok: true, request: { op: 'budget_calendar_status', request_id: id } },
  );
  // 状態の確認は理由・月を持たない。
  const status = parseControlRequest(
    bytes(
      JSON.stringify({
        op: 'budget_calendar_status',
        request_id: id,
        month: '2030-10',
      }),
    ),
  );
  assert.deepEqual(status, { ok: false, reason: 'unknown_field' });
});
