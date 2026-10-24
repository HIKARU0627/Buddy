import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  sealOperationIntent,
  DbWorkerClient,
} from '../../packages/storage/dist/index.js';
import { nextStepDecision } from '../../packages/domain/dist/index.js';
import {
  pinnedRequest,
  onCleanup,
} from '../../apps/core/dist/api-test-support.js';
import {
  DATA_KEY_MATERIAL,
  approve,
  approveBody,
  cancel,
  postJson,
  submitDurable,
} from '../../apps/core/dist/event-test-support.js';
import {
  startRig,
  startCore,
  session,
  createOperation,
  previewOf,
  approveOperation,
  operationOf,
  idle,
  reached,
  LABEL,
  CLOCK_START,
  DRAFT_TEXT,
  SCHEDULE_TEXT,
  TASK_TEXT,
  preview,
} from '../../apps/core/dist/operation-runner-test-support.js';

import {
  installHistory,
  database,
  observe,
  observeProviderDrafts,
  observeProviderLabels,
  restart,
  client,
  waitClient,
  until,
  shuffled,
} from './b04-support.mjs';

const TASK = TASK_TEXT;
const command = (id, expected, who = null) => ({
  command_id: randomUUID(),
  operation_id: id,
  expected_state_revision: expected,
  request_revision: who ? '1' : null,
  permission_revision: '1',
  forgetting_generation: '0',
  connection_id: null,
  request: null,
});
const stateRequest = (who, revision) => ({
  request_id: randomUUID(),
  command_scope_id: who.scope,
  expected_state_revision: revision,
});

async function reconcile(core, who, id) {
  const view = await operationOf(core, who, id);
  const result = await postJson(
    core,
    who.device,
    `/v1/operations/${id}/reconcile`,
    stateRequest(who, view.state_revision),
  );
  assert.equal(result.status, 202);
}

async function turn(core, who, text, body = {}) {
  const session = await postJson(core, who.device, '/v1/sessions', {
    request_id: randomUUID(),
    command_scope_id: who.scope,
    storage_mode: 'normal',
  });
  assert.equal(session.status, 201);
  const path = `/v1/sessions/${session.json.session_id}/turns`;
  const request = {
    request_id: randomUUID(),
    command_scope_id: who.scope,
    text,
    input_kind: 'text',
    ...body,
  };
  const response = await postJson(core, who.device, path, request);
  return { path, request, response };
}

// 発言の文。下書きの保存のケース（operation: draft_reply）は外部の下書き、QA27-local は用事、他はラベル。
const textOf = (spec) =>
  spec.operation === 'draft_reply'
    ? DRAFT_TEXT
    : spec.id === 'QA27-local'
      ? TASK
      : LABEL;

export async function runCase(t, spec, seed, round) {
  if (spec.id === 'QA28') return qa28(t, spec);
  if (spec.id.startsWith('X10')) return steps(t, spec);
  if (spec.id === 'QA27-auth' || spec.id === 'QA27-expiry')
    return qa27Guards(t, spec);
  const controller = new AbortController();
  const rig = await startRig(t, { writeSignal: controller.signal });
  let core = await startCore(t, rig);
  installHistory(core);
  const who = await session(core);
  const expected = spec.expected;
  if (spec.id === 'QA27-read') {
    const { response } = await turn(core, who, '今日の予定を見せて');
    assert.equal(response.status, 200);
    assert.equal(response.json.result_view.kind, expected.result_kind);
    const counts = database(core, (db) =>
      Object.fromEntries(
        ['operations', 'approvals', 'operation_attempts'].map((table) => [
          table,
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
        ]),
      ),
    );
    assert.deepEqual(counts, {
      operations: expected.operations,
      approvals: expected.approvals,
      operation_attempts: expected.attempts,
    });
    assert.equal(rig.provider.truth.requestCount(), expected.provider_requests);
    assert.equal(
      rig.provider.truth.stateChangeCount(),
      expected.provider_state_changes,
    );
    const providerLabels = observeProviderLabels(rig.provider.truth, expected);
    return {
      provider_labels: providerLabels,
      provider_receipts: [],
      provider_requests: rig.provider.truth.requestCount(),
      provider_state_changes: rig.provider.truth.stateChangeCount(),
      approval_count: counts.approvals,
      db_version: String(core.handle.store.schemaVersion),
      final_state: response.json.status,
      counts,
    };
  }
  // LocalCommand の外部呼出し（読み取りを含む）は、発言の受付の前から数える。
  const callsBeforeTurn = rig.ports.calls;
  const id = await createOperation(core, who, textOf(spec));
  const detail = {};
  // 下書きの保存の X ケースは、同じ故障の手順をラベルのケースと共有する（照合が目印になるだけ）。
  const base = spec.id.replace(/-draft$/u, '');
  switch (base) {
    case 'X01': {
      // 通常の完了後の再起動と、preparing での再起動の両方を固定順序で実行する。
      if (round % 2 === 1)
        rig.injector.arm('after_target_recheck', { mode: 'pause' });
      await approveOperation(core, who, id);
      if (round % 2 === 1) await reached(rig.injector, 'after_target_recheck');
      else await idle(core);
      core = await restart(t, rig, core, [who]);
      break;
    }
    case 'X02': {
      const other = await session(core);
      // 2 端末の製品クライアント（TLS/WSS）で同じ候補を確認する。
      const ref = { current: core };
      const clients = await Promise.all([
        client(t, ref, who.device),
        client(t, ref, other.device),
      ]);
      [who.scope, other.scope] = clients.map(
        (c) => c.link.state.commandScopeId,
      );
      for (const c of clients) {
        await waitClient(c.link, (s) =>
          s.operations.some((o) => o.operation_id === id),
        );
        const op = c.link.state.operations.find((o) => o.operation_id === id);
        assert.equal(op.content_version, '1');
        assert.equal(op.state, 'awaiting_approval');
      }
      const previews = await Promise.all([
        previewOf(core, who, id),
        previewOf(core, other, id),
      ]);
      assert.equal(previews[0].hash, previews[1].hash);
      const requests = [who, other].map((w, i) => ({
        who: w,
        body: approveBody(w.scope, {
          previewId: previews[i].previewId,
          hash: previews[i].hash,
        }),
      }));
      const order = shuffled([0, 1], seed + round);
      rig.injector.arm('approval_barrier', { mode: 'barrier', parties: 2 });
      const approvals = [];
      for (const [position, i] of order.entries()) {
        const r = requests[i];
        approvals.push(approve(core, r.who.device, id, r.body));
        if (position === 0) await reached(rig.injector, 'approval_barrier');
      }
      const outcomes = await Promise.all(approvals);
      assert.deepEqual(
        outcomes.map((r) => r.status),
        [202, 202],
      );
      assert.equal(rig.injector.hitCount('approval_barrier'), 2);
      const again = await approve(core, who.device, id, requests[0].body);
      assert.equal(again.status, 202);
      assert.deepEqual(again.json, outcomes[order.indexOf(0)].json);
      await idle(core);
      for (const c of clients)
        await waitClient(
          c.link,
          (s) =>
            s.operations.find((o) => o.operation_id === id)?.state ===
            expected.core_final_state,
        );
      detail.approval_entry_order = order.map((i) => (i === 0 ? 'A' : 'B'));
      break;
    }
    case 'X03': {
      const path = `/v1/operations/${id}/preview`;
      const shown = await postJson(core, who.device, path, {
        request_id: randomUUID(),
        command_scope_id: who.scope,
      });
      const intent = shown.json.intent;
      const reordered = Object.fromEntries(Object.entries(intent).reverse());
      const sealed = sealOperationIntent(
        DATA_KEY_MATERIAL,
        { operationId: id, contentVersion: 1 },
        reordered,
      );
      assert(sealed.ok);
      assert.equal(sealed.content_hash, shown.json.content_hash);
      const revised = sealOperationIntent(
        DATA_KEY_MATERIAL,
        { operationId: id, contentVersion: 2 },
        {
          ...intent,
          content_version: '2',
          action: { ...intent.action, add: ['review'] },
        },
      );
      assert(revised.ok);
      assert.notEqual(revised.content_hash, shown.json.content_hash);
      await submitDurable(core, {
        ...command(id, '1', who),
        kind: 'operation.revise_content',
        content_version: '2',
        content_hash: revised.content_hash,
        intent: revised.intent,
      });
      const stale = await approve(
        core,
        who.device,
        id,
        approveBody(who.scope, {
          previewId: shown.json.preview_id,
          hash: shown.json.content_hash,
        }),
      );
      assert.equal(stale.status, expected.stale_preview_status);
      const bad = await pinnedRequest(core.target, {
        method: 'POST',
        path: `/v1/operations/${id}/approve`,
        headers: {
          authorization: `Bearer ${who.device.token}`,
          'content-type': 'application/json',
          'buddy-input-origin': 'screen',
        },
        body: '{"request_id":',
      });
      assert.equal(bad.status, expected.invalid_json_status);
      break;
    }
    case 'X04': {
      // 同じ発言 request_id を別内容で再利用しても新しい操作は作らない。
      const first = await turn(core, who, '知らない合成の発言');
      assert.equal(first.response.status, 200);
      const conflict = await postJson(core, who.device, first.path, {
        ...first.request,
        text: TASK,
      });
      assert.equal(conflict.status, expected.responses.request_id_reused);
      const shown = await previewOf(core, who, id);
      const old = approveBody(who.scope, {
        previewId: shown.previewId,
        hash: shown.hash,
      });
      core = await restart(t, rig, core, [who]);
      const stale = await approve(core, who.device, id, old);
      assert.equal(stale.status, expected.responses.old_scope);
      assert.equal(
        database(
          core,
          (db) => db.prepare('SELECT count(*) AS n FROM operations').get().n,
        ),
        1,
      );
      break;
    }
    case 'X05-before-dispatch':
    case 'X05-after-dispatch': {
      const point = spec.faults[0];
      rig.injector.arm(point, { mode: 'pause' });
      await approveOperation(core, who, id);
      await reached(rig.injector, point);
      const view = await operationOf(core, who, id);
      const receipt = await cancel(
        core,
        who.device,
        id,
        stateRequest(who, view.state_revision),
      );
      assert.equal(receipt.status, 202);
      assert.equal(
        receipt.json.status,
        spec.id.endsWith('before-dispatch') ? 'durable' : 'accepted',
      );
      rig.injector.release(point);
      break;
    }
    case 'X06': {
      rig.injector.arm('after_dispatch_intent_before_send', { mode: 'pause' });
      await approveOperation(core, who, id);
      await reached(rig.injector, 'after_dispatch_intent_before_send');
      core = await restart(t, rig, core, [who]);
      // 一度目だけでなく再開要求・二度目の再起動でも送らない。
      core.handle.runner.start(id);
      await idle(core);
      core = await restart(t, rig, core, [who]);
      assert.deepEqual((await operationOf(core, who, id)).allowed_actions, [
        'reconcile',
      ]);
      break;
    }
    case 'X07':
    case 'X08': {
      const point = spec.faults[0];
      rig.injector.arm('after_target_recheck', { mode: 'pause' });
      rig.injector.arm(point, {
        mode: base === 'X07' ? 'drop_response' : 'hold_then_apply',
      });
      await approveOperation(core, who, id);
      await reached(rig.injector, 'after_target_recheck');
      const calls = rig.ports.calls;
      rig.injector.release('after_target_recheck');
      await reached(rig.injector, point);
      if (base === 'X08') controller.abort();
      await idle(core);
      // 以後の呼出しは書込み 1 回と自動照合の読み取り 1 回。
      assert.equal(rig.ports.calls - calls - 1, expected.automatic_lookups);
      detail.automatic_lookups = rig.ports.calls - calls - 1;
      if (base === 'X08') {
        const held = await operationOf(core, who, id);
        assert.equal(held.state, expected.before_late_apply.state);
        assert.equal(
          rig.provider.truth.requestCount(),
          expected.before_late_apply.provider_requests,
        );
        assert.equal(
          rig.provider.truth.stateChangeCount(),
          expected.before_late_apply.provider_state_changes,
        );
        core.handle.runner.start(id);
        await idle(core);
        assert.equal(rig.ports.calls - calls - 1, expected.automatic_lookups);
        rig.provider.truth.releaseLateApplies();
        assert.equal(
          (await operationOf(core, who, id)).state,
          expected.before_late_apply.state,
        );
        await reconcile(core, who, id);
      }
      break;
    }
    case 'X09': {
      rig.injector.arm('after_approval_save', { mode: 'pause' });
      await approveOperation(core, who, id);
      await reached(rig.injector, 'after_approval_save');
      // 両方の故障を別の一時 DB / provider で反復する。
      if (round % 2 === 0)
        rig.provider.truth.setSourceRevision('mail-001', 'r2');
      else
        rig.provider.truth.setPermission({
          permission_revision: '2',
          scopes: ['mail.read'],
        });
      detail.change = round % 2 === 0 ? 'source_revision' : 'permission';
      rig.injector.release('after_approval_save');
      await idle(core);
      const record = await core.handle.store.query({
        kind: 'operation',
        operation_id: id,
      });
      assert.equal(record.attempts[0].status, 'superseded');
      break;
    }
    case 'X11': {
      const ref = { current: core };
      let gap = true;
      const c = await client(t, ref, who.device, {
        holdEvents: true,
        beforeSubscribe: async (state) => {
          if (!gap) return;
          gap = false;
          who.scope = state.commandScopeId;
          // snapshot の後・購読の前の境目で完了させる。
          await approveOperation(core, who, id);
          await idle(core);
        },
      });
      await until(t, () =>
        c.pending.some(
          (e) => e.data.event.state_revision === expected.client_state_revision,
        ),
      );
      const events = [...c.pending];

      // 配信された最終イベントの受領（cursor の反映）を落としたまま中枢だけを再起動。
      assert.equal(
        c.link.state.operations.find((o) => o.operation_id === id).state,
        'awaiting_approval',
      );
      const instance = c.link.state.coreInstanceId;
      ref.current = core = await restart(t, rig, core);
      await waitClient(
        c.link,
        (s) => s.phase === 'live' && s.coreInstanceId !== instance,
      );
      await until(t, () =>
        c.pending
          .slice(events.length)
          .some(
            (e) =>
              e.data.event.state_revision === expected.client_state_revision,
          ),
      );
      const replayed = c.pending.slice(events.length);
      assert.deepEqual(
        replayed.map((e) => e.data.event.event_id),
        events.map((e) => e.data.event.event_id),
      );
      // 再送されたイベント自体を受け取る（古い接続の callback は使わない）。
      const newest = replayed.find(
        (e) => e.data.event.state_revision === expected.client_state_revision,
      );
      // 再接続後、最新を先に渡し、重複と古いイベントを固定 seed で並べ替える。
      c.deliver(newest);
      await waitClient(
        c.link,
        (s) =>
          s.operations.find((o) => o.operation_id === id)?.state ===
          expected.client_state,
      );
      const before = c.requests.filter(
        (r) => r === `GET /v1/operations/${id}`,
      ).length;
      for (const event of shuffled([...events, newest], seed)) c.deliver(event);
      assert.equal(
        c.link.state.operations.find((o) => o.operation_id === id)
          .state_revision,
        expected.client_state_revision,
      );
      assert.equal(
        c.requests.filter((r) => r === `GET /v1/operations/${id}`).length,
        before,
      );
      detail.delivered_revisions = [
        newest,
        ...shuffled([...events, newest], seed),
      ].map((e) => e.data.event.state_revision);
      break;
    }
    case 'QA27-local': {
      const first = await approveOperation(core, who, id);
      await idle(core);
      const replay = await approve(core, who.device, id, first.body);
      assert.deepEqual(replay.json, first.response.json);
      // 発言の受付から適用・再要求まで、アダプターの呼出し（読み取りを含む）は 0。
      assert.equal(rig.ports.calls - callsBeforeTurn, expected.external_calls);
      detail.external_calls = rig.ports.calls - callsBeforeTurn;
      assert.equal(
        database(
          core,
          (db) => db.prepare('SELECT count(*) AS n FROM tasks').get().n,
        ),
        expected.tasks,
      );
      break;
    }
    case 'QA27-remote':
      await approveOperation(core, who, id);
      break;
    default:
      assert.fail(`未登録のケース: ${spec.id}`);
  }
  const result = await observe(core, rig, id, expected);
  return { ...result, ...detail };
}

// QA27 の全経路の権限（QA27-auth）と期限（QA27-expiry）。用事と下書きの操作を作って preview を出した後、
// 失効した端末・期限の切れた接続範囲で 3 種の発言と 2 種の承認を送り、何も作らず送らないことを確かめる。
async function qa27Guards(t, spec) {
  const expected = spec.expected;
  const rig = await startRig(t);
  const clock = { ms: CLOCK_START };
  const core = await startCore(t, rig, { clock });
  installHistory(core);
  const who = await session(core);
  const ids = [
    await createOperation(core, who, TASK),
    await createOperation(core, who, DRAFT_TEXT),
  ];
  const shown = [];
  for (const id of ids) {
    const response = await preview(core, who, id);
    assert.equal(response.status, 200);
    shown.push(response.json);
  }
  const opened = await postJson(core, who.device, '/v1/sessions', {
    request_id: randomUUID(),
    command_scope_id: who.scope,
    storage_mode: 'normal',
  });
  assert.equal(opened.status, 201);
  const detail = {};
  if (spec.id === 'QA27-auth') {
    // 連携の許可: 予定の読み取りの範囲がなければ Read も聞き返す。
    rig.provider.truth.setPermission({
      scopes: ['mail.read', 'mail.labels.change', 'mail.drafts.create'],
    });
    const { response } = await turn(core, who, SCHEDULE_TEXT);
    assert.equal(response.json.status, 'clarification');
    assert.equal(response.json.reply_text, expected.read_scope_missing_reply);
    detail.read_scope_missing = response.json.status;
    const revoked = await core.handle.store.device({
      kind: 'device.revoke',
      device_id: who.device.device.device_id,
      revoked_at: CLOCK_START,
    });
    assert(revoked.ok);
  } else clock.ms = CLOCK_START + expected.clock_advance_ms;
  const turnStatuses = [];
  for (const text of [SCHEDULE_TEXT, TASK, DRAFT_TEXT]) {
    const response = await postJson(
      core,
      who.device,
      `/v1/sessions/${opened.json.session_id}/turns`,
      {
        request_id: randomUUID(),
        command_scope_id: who.scope,
        text,
        input_kind: 'text',
      },
    );
    assert.equal(response.status, expected.turn_status, text);
    if (expected.error_code)
      assert.equal(response.json.code, expected.error_code);
    turnStatuses.push(response.status);
  }
  const approveStatuses = [];
  for (const [i, id] of ids.entries()) {
    const response = await approve(
      core,
      who.device,
      id,
      approveBody(who.scope, {
        previewId: shown[i].preview_id,
        hash: shown[i].content_hash,
      }),
    );
    assert.equal(response.status, expected.approve_status);
    approveStatuses.push(response.status);
  }
  await idle(core);
  const counts = database(core, (db) =>
    Object.fromEntries(
      ['operations', 'approvals', 'operation_attempts'].map((table) => [
        table,
        db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
      ]),
    ),
  );
  assert.deepEqual(counts, {
    operations: expected.operations,
    approvals: expected.approvals,
    operation_attempts: expected.attempts,
  });
  const states = [];
  for (const id of ids) {
    const record = await core.handle.store.query({
      kind: 'operation',
      operation_id: id,
    });
    states.push(record.state);
  }
  assert.deepEqual(states, expected.operation_states);
  assert.equal(rig.ports.counts.write, expected.adapter_writes);
  assert.equal(rig.provider.truth.requestCount(), expected.provider_requests);
  assert.equal(
    rig.provider.truth.stateChangeCount(),
    expected.provider_state_changes,
  );
  const providerLabels = observeProviderLabels(rig.provider.truth, expected);
  const providerDrafts = observeProviderDrafts(rig.provider.truth, expected);
  return {
    provider_labels: providerLabels,
    provider_drafts: providerDrafts,
    provider_receipts: [],
    provider_requests: rig.provider.truth.requestCount(),
    provider_state_changes: rig.provider.truth.stateChangeCount(),
    approval_count: counts.approvals,
    db_version: String(core.handle.store.schemaVersion),
    final_state: `refused_${expected.turn_status}`,
    counts,
    operation_states: states,
    turn_statuses: turnStatuses,
    approve_statuses: approveStatuses,
    ...detail,
  };
}

// X10 は工程の命令・保存・復旧後の照合判断だけ。製品の下書き送信経路は実行していない。
async function steps(t, spec) {
  const rig = await startRig(t);
  let core = await startCore(t, rig);
  installHistory(core);
  core.handle.runner.close();
  const who = await session(core);
  const id = await createOperation(core, who, LABEL);
  await approveOperation(core, who, id);
  const attempt = randomUUID();
  await submitDurable(core, {
    ...command(id, '2', who),
    kind: 'operation.prepare',
    attempt_id: attempt,
  });
  const step = spec.step === 'create_draft' ? '1-create_draft' : '2-send';
  await submitDurable(core, {
    ...command(id, '3', who),
    kind: 'operation.dispatch_intent',
    attempt_id: attempt,
    reservation_id: null,
    observed_connection: {
      status: 'active',
      access: 'read_write',
      permission_revision: '1',
    },
    step: { step_id: step, step_kind: spec.step },
  });
  core = await restart(t, rig, core, [who]);
  const view = await core.handle.store.query({
    kind: 'operation_view',
    operation_id: id,
  });
  const records = view.steps;
  // 先行工程の成功は合成の入力。B04 では 2 工程を完走した証拠としない。
  const previous =
    spec.step === 'send'
      ? [
          {
            step_id: '1-create_draft',
            step_kind: 'create_draft',
            dispatch_intent_at: 1,
            result_status: 'confirmed_success',
            external_id: 'synthetic-draft',
          },
        ]
      : [];
  const decision = nextStepDecision(
    ['create_draft', 'send'],
    [...previous, ...records],
  );
  assert.deepEqual(decision, spec.b04_expected.decision);
  const observation = await observe(core, rig, id, spec.b04_expected);
  return { ...observation, decision, scope: spec.b04_expected.scope };
}

async function qa28(t, spec) {
  const rig = await startRig(t);
  const core = await startCore(t, rig);
  installHistory(core);
  core.handle.runner.close();
  const who = await session(core);
  const id = await createOperation(core, who, TASK);
  await approveOperation(core, who, id);
  await core.handle.stop('test');
  const path = join(core.dataDir, 'buddy.sqlite');
  const generation = core.handle.storeGeneration;
  let store = await DbWorkerClient.start({
    path,
    storeGeneration: generation,
    faults: { exitAfterCommit: 'operation.apply_local' },
  });
  onCleanup(t, () => store.close());
  const send = async (c) => {
    const r = await store.submit(c).result;
    assert.equal(r.outcome, 'durable', JSON.stringify(r));
    return r;
  };
  const apply = {
    ...command(id, '2', who),
    permission_revision: '0',
    kind: 'operation.apply_local',
    attempt_id: randomUUID(),
    task_id: randomUUID(),
    list_id: 'inbox',
    // 用事の正本の暗号文（ADR 0051。DB worker は中身を復号しないので合成の乱数でよい）。
    content: {
      blob_id: randomUUID(),
      format_version: 1,
      key_id: 'data-key-v1',
      nonce: randomBytes(12),
      ciphertext: randomBytes(24),
      tag: randomBytes(16),
    },
  };
  const lost = await store.submit(apply).result;
  assert.equal(lost.outcome, spec.expected.lost_ack_outcome);
  await store.close();
  store = await DbWorkerClient.start({
    path,
    storeGeneration: generation,
  });
  const saved = await store.query({
    kind: 'command',
    command_id: apply.command_id,
  });
  assert.equal(saved.committed_state_revision, '3');
  const replay = await send(apply);
  assert.equal(replay.replayed, spec.expected.replayed);
  const refused = await store.submit({ ...apply, list_id: 'other' }).result;
  assert.equal(refused.outcome, 'rejected');
  assert.deepEqual(refused.reasons, [spec.expected.changed_replay_reason]);
  assert.equal(
    database(
      core,
      (db) => db.prepare('SELECT count(*) AS n FROM tasks').get().n,
    ),
    spec.expected.tasks,
  );
  assert.equal(
    database(
      core,
      (db) =>
        db
          .prepare(
            'SELECT count(*) AS n FROM command_receipts WHERE command_id=?',
          )
          .get(apply.command_id).n,
    ),
    1,
  );
  return {
    ...(await observe(
      { ...core, handle: { store, runner: { idle: () => Promise.resolve() } } },
      rig,
      id,
      spec.expected,
    )),
    lost_ack_outcome: lost.outcome,
    replayed: replay.replayed,
  };
}
