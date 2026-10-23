// QA27（設計 09 §16.7・H01・H02、Issue #106）: 同じ経路（発言 → 内容の確認 → 承認）で、予定の参照（Read）・用事の登録
// （LocalCommand）・外部の下書きの保存（RemoteMutation）を実行し、経路が期待どおりに分かれることを確かめる。
// - Read: 変更の承認・試行を作らず、外部への書込みも 0。
// - LocalCommand: 外部の HTTP が 0（アダプターの呼び出しも模擬 provider の受信もない）。
// - RemoteMutation: 送出の境界（送出意図つきの工程）を通るのはこの経路だけ。
// - どの経路も、権限（端末の認可・連携の許可）と期限（接続範囲）を検査する。
// 期待値はこの試験に手で書いた値。模擬だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { approve, approveBody, postJson } from './event-test-support.js';
import {
  CLOCK_START,
  DRAFT_TEXT,
  SCHEDULE_TEXT,
  TASK_TEXT,
  approveOperation,
  createOperation,
  idle,
  operationOf,
  preview,
  recordOf,
  session,
  snapshotOperations,
  startCore,
  startRig,
  turn,
} from './operation-runner-test-support.js';
import type { Clock } from './operation-runner-test-support.js';
import { bootstrap } from './event-test-support.js';

const TIMEOUT = 60_000;
// 接続範囲の最長の期限（24 時間）より 1 ミリ秒後。
const PAST_SCOPE_EXPIRY_MS = 24 * 60 * 60 * 1000 + 1;

test(
  'QA27: the same routes run a schedule read, a task and a remote draft save, and only the draft crosses the dispatch boundary',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);

    // Read: 予定の照会。承認・試行・操作を作らず、外部への書込みは 0。
    const read = await turn(core, who, SCHEDULE_TEXT);
    assert.equal(read['status'], 'answered');
    const view = read['result_view'] as Record<string, unknown>;
    assert.equal(view['kind'], 'schedule_cards');
    // 合成の予定 2 件（13:30〜14:00 が重なる）。
    assert.deepEqual(
      (view['item_refs'] as { kind: string }[]).map((ref) => ref.kind),
      [
        'calendar_event',
        'calendar_event',
        'calendar_overlap',
        'calendar_overlap',
      ],
    );
    assert.equal(await snapshotOperations(core, who), 0);
    assert.equal(rig.ports.counts.write, 0);
    assert.equal(rig.ports.counts.find, 0);
    assert.equal(rig.provider.truth.requestCount(), 0);

    // LocalCommand: 用事の登録。発言の受付から承認・適用の完了まで、アダプターの呼び出し（読み取りを含む）は 0。
    const before = { calls: rig.ports.calls, ...rig.ports.counts };
    const task = await createOperation(core, who, TASK_TEXT);
    await approveOperation(core, who, task);
    await idle(core);
    assert.equal((await operationOf(core, who, task))['state'], 'succeeded');
    assert.deepEqual({ calls: rig.ports.calls, ...rig.ports.counts }, before);
    assert.equal(rig.provider.truth.requestCount(), 0);
    assert.deepEqual(await recordOf(core, task), {
      state: 'succeeded',
      approvals: 1,
      attempts: 1,
      // 送出の境界（送出意図つきの工程）を使わない。
      steps: [],
    });

    // RemoteMutation: 外部の下書きの保存。送出意図つきの工程を通り、模擬 provider へ 1 回だけ送る。
    const draft = await createOperation(core, who, DRAFT_TEXT);
    await approveOperation(core, who, draft);
    await idle(core);
    assert.equal((await operationOf(core, who, draft))['state'], 'succeeded');
    assert.deepEqual(await recordOf(core, draft), {
      state: 'succeeded',
      approvals: 1,
      attempts: 1,
      steps: [
        {
          step_id: '1-create_draft',
          intent: true,
          result_status: 'confirmed_success',
        },
      ],
    });
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.equal(rig.provider.truth.stateChangeCount(), 1);
    assert.deepEqual(
      rig.provider.truth.receipts().map((r) => [r.route, r.operation_id]),
      [['mail.draft.create', draft]],
    );
    // 操作は 2 件（用事と下書き）。Read は操作を作っていない。
    assert.equal(await snapshotOperations(core, who), 2);
  },
);

test(
  'QA27: every route checks the permission — a revoked device is refused and the provider read and write scopes are checked per kind',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const task = await createOperation(core, who, TASK_TEXT);
    const draft = await createOperation(core, who, DRAFT_TEXT);
    const shownTask = await preview(core, who, task);
    const shownDraft = await preview(core, who, draft);

    // 連携の許可: 予定の読み取りの範囲がなければ Read も聞き返す（書込みの範囲だけでは読めない）。
    rig.provider.truth.setPermission({
      scopes: ['mail.read', 'mail.labels.change', 'mail.drafts.create'],
    });
    const noCalendar = await turn(core, who, SCHEDULE_TEXT);
    assert.equal(noCalendar['status'], 'clarification');
    assert.equal(
      noCalendar['reply_text'],
      '連携の接続が使えません。接続を確かめてください。',
    );
    rig.provider.truth.setPermission({
      scopes: [
        'mail.read',
        'calendar.read',
        'mail.labels.change',
        'mail.drafts.create',
        'mail.drafts.send',
      ],
    });

    // 端末の認可: 失効した端末は、発言（3 経路とも）も承認も 401 で、何も作らず送らない。
    const opened = await postJson(core, who.device, '/v1/sessions', {
      request_id: randomUUID(),
      command_scope_id: who.scope,
      storage_mode: 'normal',
    });
    assert.equal(opened.status, 201, opened.text);
    const sessionId = String(opened.json?.['session_id']);
    const revoked = await core.handle.store.device({
      kind: 'device.revoke',
      device_id: who.device.device.device_id,
      revoked_at: CLOCK_START,
    });
    assert(revoked.ok);
    for (const text of [SCHEDULE_TEXT, TASK_TEXT, DRAFT_TEXT]) {
      const response = await postJson(
        core,
        who.device,
        `/v1/sessions/${sessionId}/turns`,
        {
          request_id: randomUUID(),
          command_scope_id: who.scope,
          text,
          input_kind: 'text',
        },
      );
      assert.equal(response.status, 401, `${text}: ${response.text}`);
    }
    for (const [id, shown] of [
      [task, shownTask],
      [draft, shownDraft],
    ] as const) {
      const refused = await approve(
        core,
        who.device,
        id,
        approveBody(who.scope, {
          previewId: String(shown.json?.['preview_id']),
          hash: String(shown.json?.['content_hash']),
        }),
      );
      assert.equal(refused.status, 401, refused.text);
    }
    await idle(core);
    const other = await session(core);
    assert.equal(
      (await operationOf(core, other, task))['state'],
      'awaiting_approval',
    );
    assert.equal(
      (await operationOf(core, other, draft))['state'],
      'awaiting_approval',
    );
    assert.equal(await snapshotOperations(core, other), 2);
    assert.equal(rig.provider.truth.requestCount(), 0);
  },
);

test(
  'QA27: every route checks the expiry — after the command scope expires the message and the approval are 410 and nothing is made or sent',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const clock: Clock = { ms: CLOCK_START };
    const core = await startCore(t, rig, { clock });
    const who = await session(core);
    const task = await createOperation(core, who, TASK_TEXT);
    const draft = await createOperation(core, who, DRAFT_TEXT);
    const shownTask = await preview(core, who, task);
    const shownDraft = await preview(core, who, draft);
    const sessionResponse = await postJson(core, who.device, '/v1/sessions', {
      request_id: randomUUID(),
      command_scope_id: who.scope,
      storage_mode: 'normal',
    });
    assert.equal(sessionResponse.status, 201, sessionResponse.text);
    const sessionId = String(sessionResponse.json?.['session_id']);

    clock.ms = CLOCK_START + PAST_SCOPE_EXPIRY_MS;
    for (const text of [SCHEDULE_TEXT, TASK_TEXT, DRAFT_TEXT]) {
      const response = await postJson(
        core,
        who.device,
        `/v1/sessions/${sessionId}/turns`,
        {
          request_id: randomUUID(),
          command_scope_id: who.scope,
          text,
          input_kind: 'text',
        },
      );
      assert.equal(response.status, 410, `${text}: ${response.text}`);
      assert.equal(response.json?.['code'], 'expired_scope');
    }
    for (const [id, shown] of [
      [task, shownTask],
      [draft, shownDraft],
    ] as const) {
      const refused = await approve(
        core,
        who.device,
        id,
        approveBody(who.scope, {
          previewId: String(shown.json?.['preview_id']),
          hash: String(shown.json?.['content_hash']),
        }),
      );
      assert.equal(refused.status, 410, refused.text);
    }
    await idle(core);
    // 新しい接続範囲では読める（期限による拒否で、端末の認可の失敗ではない）。何も作られず、送られていない。
    who.scope = await bootstrap(core, who.device);
    assert.equal(
      (await operationOf(core, who, task))['state'],
      'awaiting_approval',
    );
    assert.equal(
      (await operationOf(core, who, draft))['state'],
      'awaiting_approval',
    );
    assert.equal(await snapshotOperations(core, who), 2);
    assert.equal(rig.ports.counts.write, 0);
    assert.equal(rig.provider.truth.requestCount(), 0);
  },
);
