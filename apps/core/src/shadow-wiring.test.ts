// Core の影モードの配線（B06-06e、ADR 0092・0110）。設定（campaign・比較モデル・endpoint・認証）は B15 まで
// 読まないので、Core の入口はつながっていても比較の呼出しも保存も 0 件（既定 OFF・D4）。
// onInterpreted の口（試験・診断）には今までどおり渡り、発言の結果を変えない。
// 期待値は手で書く（実装から作らない）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { TEST_TURN_POLICY } from './turn-ports.js';
import type { TestDevice } from './api-test-support.js';
import {
  bootstrap,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';

const CAMPAIGN = 'a1000000-0000-4000-8000-000000000001';
const DAY_MS = 86_400_000;
const CLOCK = new Date('2026-10-05T09:00:00+09:00');

test('Core は比較の入口をつなぎ、設定が無い間は比較も保存もしない', async (t) => {
  const seen: {
    storage_mode: string;
    input_id: string;
    request_revision: string;
    turn_expires_at: number;
  }[] = [];
  const core = await startEventCore(t, {
    previewValid: false,
    now: () => CLOCK,
    turns: {
      policy: TEST_TURN_POLICY,
      utcOffset: '+09:00',
      onInterpreted: (event) => {
        seen.push({
          storage_mode: event.storage_mode,
          input_id: event.input_id,
          request_revision: event.request_revision,
          turn_expires_at: event.turn_expires_at,
        });
      },
    },
  });
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
  const created = await postJson(core, device, '/v1/sessions', {
    request_id: randomUUID(),
    command_scope_id: scope,
    storage_mode: 'normal',
  });
  assert.equal(created.status, 201, created.text);
  const session = String(created.json?.['session_id']);
  const generation = String(created.json?.['segment_generation']);
  const turn = await postJson(
    core,
    device as TestDevice,
    `/v1/sessions/${session}/turns`,
    {
      request_id: randomUUID(),
      command_scope_id: scope,
      text: '今日の予定を見せて',
      input_kind: 'text',
      // 会話の作成が返した区切りの由来（#233 で必須）。設定が無い間は比較も保存もしないことを見る試験で、
      // 由来は受け付けるための前提だけ。
      origin: { segment_id: session, segment_generation: generation },
    },
  );
  assert.equal(turn.status, 200, turn.text);
  // 入口は 1 回だけ。観測した保存モードと、発言の版・期限が渡る。
  assert.equal(seen.length, 1);
  const first = seen[0] as (typeof seen)[number];
  assert.equal(first.storage_mode, 'normal');
  assert.equal(first.request_revision, '1');
  assert.match(first.input_id, /^[0-9a-f-]{36}$/u);
  // 通常の会話の保存期限は 7 日（発言の行の期限。ADR 0092）。
  assert.equal(first.turn_expires_at, CLOCK.getTime() + 7 * DAY_MS);
  // 設定が無い（既定 OFF）ので、比較の記録の行は 0 件。
  const count = await core.handle.store.intentShadow({
    kind: 'intent_shadow.count',
    campaign_id: CAMPAIGN,
  });
  assert.deepEqual(count, {
    ok: true,
    value: { campaign_id: CAMPAIGN, count: 0 },
  });
});
