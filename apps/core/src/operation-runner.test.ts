// B04 の共通装置は統合実行器でも使う。追加の回帰試験はここに残す。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FaultInjector } from '@buddy/connectors/testing';
import type { DataKeyProvider } from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { createOperationRunner } from './operation-runner.js';
import type { RunnerStore } from './operation-runner.js';
import { withTimeout } from './api-test-support.js';
import {
  approve,
  approveBody,
  cancel,
  postJson,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import {
  expectedOf,
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
  SCHEDULE_TEXT,
  TASK_TEXT,
  turn,
  stepsOf,
  assertProvider,
  TIMEOUT,
} from './operation-runner-test-support.js';
import type { Session } from './operation-runner-test-support.js';

test(
  'X01: a restart while preparing resumes from the recheck and sends once',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    rig.injector.arm('after_target_recheck', { mode: 'pause' });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'after_target_recheck');
    // 中枢だけを止める（模擬 provider は止めない）。止めた後は送らない。
    await core.handle.stop('test');
    rig.injector.release('after_target_recheck');
    assert.equal(rig.provider.truth.requestCount(), 0);
    const restarted = await startCore(t, rig, {
      restartOf: core,
      faults: new FaultInjector(),
    });
    assert.deepEqual(restarted.handle.recovery.resumable, [operationId]);
    await idle(restarted);
    const again = await session(restarted);
    const view = await operationOf(restarted, again, operationId);
    assert.equal(view['state'], expectedOf('X01').core_final_state);
    assertProvider(rig, 'X01');
    // 工程（D3）: 1 工程だけを送出意図つきで記録し、成功で確定した。
    assert.deepEqual(await stepsOf(restarted, operationId), [
      {
        step_id: '1-apply_labels',
        intent: true,
        result_status: 'confirmed_success',
      },
    ]);
  },
);

test(
  'X02: two devices approving at the same barrier and a double click send once',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const a = await session(core);
    const b = await session(core);
    const operationId = await createOperation(core, a, LABEL);
    const shownA = await previewOf(core, a, operationId);
    const shownB = await previewOf(core, b, operationId);
    rig.injector.arm('approval_barrier', { mode: 'barrier', parties: 2 });
    const bodyA = approveBody(a.scope, {
      previewId: shownA.previewId,
      hash: shownA.hash,
    });
    const [first, second] = await Promise.all([
      approve(core, a.device, operationId, bodyA),
      approve(
        core,
        b.device,
        operationId,
        approveBody(b.scope, {
          previewId: shownB.previewId,
          hash: shownB.hash,
        }),
      ),
    ]);
    assert.equal(first.status, 202, first.text);
    assert.equal(second.status, 202, second.text);
    // 端末 A の二度押し（同じ request_id）は保存済みの結果。
    const double = await approve(core, a.device, operationId, bodyA);
    assert.equal(double.status, 202, double.text);
    assert.deepEqual(double.json, first.json);
    await idle(core);
    const view = await operationOf(core, a, operationId);
    assert.equal(view['state'], expectedOf('X02').core_final_state);
    assertProvider(rig, 'X02');
  },
);

test(
  'X05: a cancel before the dispatch intent cancels; after it, the cancel is accepted and the result waits in reconciling',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);

    // 送出意図の前（対象の確かめ直しの後）に取消: cancelled、要求 0 回。
    const before = await createOperation(core, who, LABEL);
    rig.injector.arm('after_target_recheck', { mode: 'pause' });
    await approveOperation(core, who, before);
    await reached(rig.injector, 'after_target_recheck');
    const preparing = await operationOf(core, who, before);
    assert.equal(preparing['state'], 'preparing');
    const cancelled = await cancel(core, who.device, before, {
      request_id: randomUUID(),
      command_scope_id: who.scope,
      expected_state_revision: preparing['state_revision'],
    });
    assert.equal(cancelled.status, 202, cancelled.text);
    assert.equal(cancelled.json?.['status'], 'durable');
    rig.injector.release('after_target_recheck');
    await idle(core);
    assert.equal(
      (await operationOf(core, who, before))['state'],
      expectedOf('X05-before-dispatch').core_final_state,
    );
    assertProvider(rig, 'X05-before-dispatch');

    // 送出意図の後に取消: 受付だけ（取消済みにしない）。送った結果は照合中で止まる。
    const after = await createOperation(core, who, LABEL);
    rig.injector.arm('after_dispatch_intent_before_send', { mode: 'pause' });
    await approveOperation(core, who, after);
    await reached(rig.injector, 'after_dispatch_intent_before_send');
    const dispatching = await operationOf(core, who, after);
    assert.equal(dispatching['state'], 'dispatching');
    const accepted = await cancel(core, who.device, after, {
      request_id: randomUUID(),
      command_scope_id: who.scope,
      expected_state_revision: dispatching['state_revision'],
    });
    assert.equal(accepted.status, 202, accepted.text);
    assert.equal(accepted.json?.['status'], 'accepted');
    rig.injector.release('after_dispatch_intent_before_send');
    await idle(core);
    const held = await operationOf(core, who, after);
    assert.equal(
      held['state'],
      expectedOf('X05-after-dispatch').core_final_state,
    );
    assert.deepEqual(held['allowed_actions'], ['reconcile']);
    assertProvider(rig, 'X05-after-dispatch');
    // 本人の照合（参照だけ）で成功を確かめる。要求は増えない。
    const reconciled = await postJson(
      core,
      who.device,
      `/v1/operations/${after}/reconcile`,
      {
        request_id: randomUUID(),
        command_scope_id: who.scope,
        expected_state_revision: held['state_revision'],
      },
    );
    assert.equal(reconciled.status, 202, reconciled.text);
    assert.equal((await operationOf(core, who, after))['state'], 'succeeded');
    assertProvider(rig, 'X05-after-dispatch');
  },
);

test(
  'X06: a restart after the dispatch intent holds the operation as unknown and never resends',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    rig.injector.arm('after_dispatch_intent_before_send', { mode: 'pause' });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'after_dispatch_intent_before_send');
    await core.handle.stop('test');
    rig.injector.release('after_dispatch_intent_before_send');
    const restarted = await startCore(t, rig, {
      restartOf: core,
      faults: new FaultInjector(),
    });
    assert.deepEqual(restarted.handle.recovery.held, [operationId]);
    await idle(restarted);
    const again = await session(restarted);
    const view = await operationOf(restarted, again, operationId);
    const expected = expectedOf('X06');
    assert.equal(view['state'], expected.core_final_state);
    assert.equal(expected.automatic_retry, false);
    assertProvider(rig, 'X06');
    // 送出意図を記録した工程は結果不明（再送せず照合だけ。nextStepDecision は reconcile を返す）。
    assert.deepEqual(await stepsOf(restarted, operationId), [
      { step_id: '1-apply_labels', intent: true, result_status: 'unknown' },
    ]);
  },
);

test(
  'a stop before the result is saved leaves the sent request unknown after restart without resending',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    rig.injector.arm('before_result_save', { mode: 'throw' });
    await approveOperation(core, who, operationId);
    await idle(core);
    assert.equal(
      (await operationOf(core, who, operationId))['state'],
      'dispatching',
    );
    await core.handle.stop('test');
    const restarted = await startCore(t, rig, {
      restartOf: core,
      faults: new FaultInjector(),
    });
    await idle(restarted);
    const again = await session(restarted);
    assert.equal(
      (await operationOf(restarted, again, operationId))['state'],
      'unknown_held',
    );
    // 外部には 1 回だけ届き（適用 1 回）、再起動の後も再送しない。
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.equal(rig.provider.truth.stateChangeCount(), 1);
  },
);

test(
  'X07: a lost response is reconciled once against the exact target and succeeds',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    rig.injector.arm('after_external_apply_before_response', {
      mode: 'drop_response',
    });
    await approveOperation(core, who, operationId);
    await idle(core);
    const view = await operationOf(core, who, operationId);
    assert.equal(view['state'], expectedOf('X07').core_final_state);
    assertProvider(rig, 'X07');
  },
);

test(
  'X08: a timeout is held as unknown without resending, and the late apply is confirmed only by the user reconcile',
  { timeout: TIMEOUT },
  async (t) => {
    const timeout = new AbortController();
    const rig = await startRig(t, { writeSignal: timeout.signal });
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    rig.injector.arm('response_timeout_then_late_apply', {
      mode: 'hold_then_apply',
    });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'response_timeout_then_late_apply');
    // 保留に届いてから時間切れを起こす（時計に依存しない）。
    timeout.abort();
    await idle(core);
    const held = await operationOf(core, who, operationId);
    assert.equal(held['state'], 'unknown_held');
    assert.deepEqual(held['allowed_actions'], ['reconcile']);
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.equal(rig.provider.truth.stateChangeCount(), 0);
    // 遅れて適用された後、本人の照合だけで成功にする。再送はしない。
    assert.equal(rig.provider.truth.releaseLateApplies(), 1);
    const body = {
      request_id: randomUUID(),
      command_scope_id: who.scope,
      expected_state_revision: held['state_revision'],
    };
    const reconciled = await postJson(
      core,
      who.device,
      `/v1/operations/${operationId}/reconcile`,
      body,
    );
    assert.equal(reconciled.status, 202, reconciled.text);
    // 同じ照合の再送は保存済みの結果（照合し直さない）。内容が違えば 409。
    const replay = await postJson(
      core,
      who.device,
      `/v1/operations/${operationId}/reconcile`,
      body,
    );
    assert.equal(replay.status, 202, replay.text);
    assert.deepEqual(replay.json, reconciled.json);
    const conflict = await postJson(
      core,
      who.device,
      `/v1/operations/${operationId}/reconcile`,
      { ...body, expected_state_revision: '1' },
    );
    assert.equal(conflict.status, 409, conflict.text);
    const view = await operationOf(core, who, operationId);
    const expected = expectedOf('X08');
    assert.equal(view['state'], expected.core_final_state);
    assert.equal(expected.automatic_retry, false);
    assertProvider(rig, 'X08');
  },
);

test(
  'X09: a target or permission change after approval sends nothing and returns to approval with content version 2',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const expected = expectedOf('X09');

    // 対象の版が r2 に変わる。
    const target = await createOperation(core, who, LABEL);
    rig.injector.arm('after_approval_save', { mode: 'pause' });
    await approveOperation(core, who, target);
    await reached(rig.injector, 'after_approval_save');
    rig.provider.truth.setSourceRevision('mail-001', 'r2');
    rig.injector.release('after_approval_save');
    await idle(core);
    const changed = await operationOf(core, who, target);
    assert.equal(changed['state'], expected.core_final_state);
    assert.equal(changed['content_version'], '2');
    assert.equal(changed['approval_state'], 'none');
    assertProvider(rig, 'X09');

    // 許可の失効（許可の版が変わり、変更の範囲がなくなる）。
    const permission = await createOperation(core, who, LABEL);
    rig.injector.arm('after_approval_save', { mode: 'pause' });
    await approveOperation(core, who, permission);
    await reached(rig.injector, 'after_approval_save');
    rig.provider.truth.setPermission({
      permission_revision: '2',
      scopes: ['mail.read'],
    });
    rig.injector.release('after_approval_save');
    await idle(core);
    const revoked = await operationOf(core, who, permission);
    assert.equal(revoked['state'], expected.core_final_state);
    assert.equal(revoked['content_version'], '2');
    assertProvider(rig, 'X09');
  },
);

test(
  'D5 / QA28: a task is applied in one local transaction without external HTTP, once per command, and a changed replay is refused',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(
      core,
      who,
      '「牛乳を買う」を用事に登録して',
    );
    const shown = await previewOf(core, who, operationId);
    const body = approveBody(who.scope, {
      previewId: shown.previewId,
      hash: shown.hash,
    });
    rig.ports.calls = 0;
    const first = await approve(core, who.device, operationId, body);
    assert.equal(first.status, 202, first.text);
    await idle(core);
    const done = await operationOf(core, who, operationId);
    assert.equal(done['state'], 'succeeded');
    // approved → succeeded（承認待ち 1、承認 2、成功 3）。
    assert.equal(done['state_revision'], '3');
    const result = done['result'] as Record<string, unknown>;
    assert.equal(result['status'], 'confirmed_success');
    assert.equal(typeof result['provider_receipt_id'], 'string');
    // 外部 HTTP は 0 件（アダプターの呼び出しも、模擬 provider の受信もない）。
    assert.equal(rig.ports.calls, 0);
    assert.equal(rig.provider.truth.requestCount(), 0);
    // 同じ command（同じ request_id・同じ内容）の再要求: 保存済みの結果で、DB の変更は 1 回のまま。
    const replay = await approve(core, who.device, operationId, body);
    assert.equal(replay.status, 202, replay.text);
    assert.deepEqual(replay.json, first.json);
    await idle(core);
    const after = await operationOf(core, who, operationId);
    assert.equal(after['state_revision'], '3');
    assert.deepEqual(after['result'], done['result']);
    // 照合値が違えば拒否する（409）。
    const changed = await approve(core, who.device, operationId, {
      ...body,
      content_hash: 'f'.repeat(64),
    });
    assert.equal(changed.status, 409, changed.text);
    assert.equal(rig.ports.calls, 0);
  },
);

const stateCommand = (who: Session, expected: unknown) => ({
  request_id: randomUUID(),
  command_scope_id: who.scope,
  expected_state_revision: expected,
});

test(
  'retry is refused unless the operation is not_executed, so an approved operation still runs once (review P2)',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    rig.injector.arm('after_approval_save', { mode: 'pause' });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'after_approval_save');
    const approved = await operationOf(core, who, operationId);
    assert.equal(approved['state'], 'approved');
    const retried = await postJson(
      core,
      who.device,
      `/v1/operations/${operationId}/retry`,
      stateCommand(who, approved['state_revision']),
      { 'buddy-input-origin': 'screen' },
    );
    assert.equal(retried.status, 409, retried.text);
    assert.equal(
      (await operationOf(core, who, operationId))['state'],
      'approved',
    );
    rig.injector.release('after_approval_save');
    await idle(core);
    const done = await operationOf(core, who, operationId);
    assert.equal(done['state'], 'succeeded');
    // 成功の後の再試行も拒否する。
    const after = await postJson(
      core,
      who.device,
      `/v1/operations/${operationId}/retry`,
      stateCommand(who, done['state_revision']),
      { 'buddy-input-origin': 'screen' },
    );
    assert.equal(after.status, 409, after.text);
    assert.equal(rig.provider.truth.requestCount(), 1);
  },
);

test(
  'a user reconcile that finds the change succeeds even after a cancel was accepted on the unknown result (review P2)',
  { timeout: TIMEOUT },
  async (t) => {
    const timeout = new AbortController();
    const rig = await startRig(t, { writeSignal: timeout.signal });
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    rig.injector.arm('response_timeout_then_late_apply', {
      mode: 'hold_then_apply',
    });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'response_timeout_then_late_apply');
    timeout.abort();
    await idle(core);
    const held = await operationOf(core, who, operationId);
    assert.equal(held['state'], 'unknown_held');
    // 結果不明の後の取消は受付だけ。
    const cancelled = await cancel(
      core,
      who.device,
      operationId,
      stateCommand(who, held['state_revision']),
    );
    assert.equal(cancelled.status, 202, cancelled.text);
    assert.equal(cancelled.json?.['status'], 'accepted');
    assert.equal(rig.provider.truth.releaseLateApplies(), 1);
    const reconciled = await postJson(
      core,
      who.device,
      `/v1/operations/${operationId}/reconcile`,
      stateCommand(who, held['state_revision']),
    );
    assert.equal(reconciled.status, 202, reconciled.text);
    assert.equal(
      (await operationOf(core, who, operationId))['state'],
      'succeeded',
    );
    assert.equal(rig.provider.truth.requestCount(), 1);
  },
);

function signal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const [observation, finalState] of [
  ['found', 'succeeded'],
  ['unreadable', 'unknown_held'],
] as const)
  for (const arrival of ['waiting', 'after_release', 'revision_check'] as const)
    test(
      `the same reconcile request arriving twice gets the same receipt: ${arrival}, ${observation} (review P2)`,
      { timeout: TIMEOUT },
      async (t) => {
        const rig = await startRig(t);
        const core = await startCore(t, rig);
        const who = await session(core);
        const operationId = await createOperation(core, who, LABEL);
        // 送出の後に取消を受け付け、照合中で止める（X05）。
        rig.injector.arm('after_dispatch_intent_before_send', {
          mode: 'pause',
        });
        await approveOperation(core, who, operationId);
        await reached(rig.injector, 'after_dispatch_intent_before_send');
        const dispatching = await operationOf(core, who, operationId);
        const cancelRequest = stateCommand(who, dispatching['state_revision']);
        const accepted = await cancel(
          core,
          who.device,
          operationId,
          cancelRequest,
        );
        assert.equal(accepted.status, 202, accepted.text);
        rig.injector.release('after_dispatch_intent_before_send');
        await idle(core);
        const held = await operationOf(core, who, operationId);
        assert.equal(held['state'], 'reconciling');
        const body = stateCommand(who, held['state_revision']);
        rig.ports.calls = 0;
        const path = `/v1/operations/${operationId}/reconcile`;
        const submissions = t.mock.method(core.handle.store, 'submit');
        const lookupReached = signal();
        const finishLookup = signal();
        const secondReached = signal();
        const continueSecond = signal();
        t.after(() => {
          finishLookup.resolve();
          continueSecond.resolve();
        });
        const readTarget = rig.ports.reader.readTarget;
        t.mock.method(rig.ports.reader, 'readTarget', async (id: string) => {
          lookupReached.resolve();
          await finishLookup.promise;
          const target = await readTarget(id);
          return observation === 'found' ? target : null;
        });
        const runner = core.handle.runner;
        assert(runner !== null);
        const reconcile = runner.reconcile;
        let arrivals = 0;
        t.mock.method(
          runner,
          'reconcile',
          async (...args: Parameters<typeof reconcile>) => {
            arrivals += 1;
            if (arrivals === 2 && arrival === 'after_release') {
              // 二つ目は古い view と「受付なし」を読んだところで止める。
              secondReached.resolve();
              await continueSecond.promise;
            }
            const result = reconcile(...args);
            if (arrivals === 2 && arrival === 'waiting')
              secondReached.resolve();
            return result;
          },
        );
        const first = postJson(core, who.device, path, body);
        await withTimeout(lookupReached.promise, 5_000, 'first lookup');
        if (arrival === 'revision_check') {
          const query = core.handle.store.query.bind(core.handle.store);
          t.mock.method(core.handle.store, 'query', (async (
            input: Parameters<typeof query>[0],
          ) => {
            const value = await query(input);
            if (
              input.kind === 'receipt_exists' &&
              input.request_id === body.request_id &&
              value === false
            ) {
              // 経路の版検査が「受付なし」を読んだ後に一つ目を完了させる。
              // 修正前はこの後で新しい状態版だけを読み、同じ要求を 409 にしていた。
              secondReached.resolve();
              await continueSecond.promise;
            }
            return value;
          }) as typeof query);
        }
        const second = postJson(core, who.device, path, body);
        await withTimeout(secondReached.promise, 5_000, 'second arrival');
        // 別の要求は排他待ちせず 409。先の照合はまだ関門で止まっている。
        const different = await postJson(core, who.device, path, {
          ...body,
          request_id: randomUUID(),
        });
        assert.equal(different.status, 409, different.text);
        finishLookup.resolve();
        const one = await first;
        await idle(core);
        continueSecond.resolve();
        const two = await second;
        assert.equal(one.status, 202, one.text);
        assert.equal(two.status, 202, two.text);
        assert.deepEqual(one.json, two.json);
        // 排他が外れた後に届く再送も、同じ受付を読み取るだけ。
        const replay = await postJson(core, who.device, path, body);
        assert.equal(replay.status, 202, replay.text);
        assert.deepEqual(replay.json, one.json);
        const changed = await postJson(core, who.device, path, {
          ...body,
          expected_state_revision: '1',
        });
        assert.equal(changed.status, 409, changed.text);
        // 照合の受付を別の経路へ流用しても 409。
        const otherRoute = await cancel(core, who.device, operationId, body);
        assert.equal(otherRoute.status, 409, otherRoute.text);
        // 取消の accepted 受付も、照合の受付として返さない。
        const reusedCancel = await postJson(
          core,
          who.device,
          path,
          cancelRequest,
        );
        assert.equal(reusedCancel.status, 409, reusedCancel.text);
        // 照合（対象の読み取り）は 1 回だけ。受付の再読取りで結果記録の命令を送らない。
        assert.equal(rig.ports.calls, 1);
        const resultCommands = submissions.mock.calls.filter(
          (call) => call.arguments[0].kind === 'operation.record_result',
        );
        assert.equal(resultCommands.length, 1);
        assert.equal(rig.provider.truth.requestCount(), 1);
        assert.equal(rig.provider.truth.stateChangeCount(), 1);
        assert.equal(
          (await operationOf(core, who, operationId))['state'],
          finalState,
        );
      },
    );

// 排他の単体の試験（レビュー P2）。DB worker の照会を関門で止めた偽物の store で、照合の最中に届いた実行の開始を
// 捨てないこと、別の要求の照合はすぐに断ること、同じ要求の照合だけを待つことを確かめる。
test(
  'a start arriving while a reconcile holds the operation is run afterwards, and only the same reconcile request waits',
  { timeout: TIMEOUT },
  async () => {
    const views: ((value: unknown) => void)[] = [];
    let viewCalls = 0;
    const store = {
      storeGeneration: 'g',
      query: () => {
        viewCalls += 1;
        return new Promise((resolve) => views.push(resolve));
      },
      submit: () => assert.fail('submit は呼ばない'),
      conversation: () => assert.fail('conversation は呼ばない'),
      consumeDispatchPermit: () => false,
    };
    const runner = createOperationRunner({
      store: store as unknown as RunnerStore,
      keyStore: {
        loadDataKey: () => Promise.reject(new Error('unused')),
      } as unknown as DataKeyProvider,
      provider: null,
      writer: null,
      faults: new FaultInjector(),
      contract: createApiContract(),
      log: () => undefined,
    });
    const operationId = randomUUID();
    const request = {
      command_scope_id: randomUUID(),
      request_id: randomUUID(),
      request_hash: 'a'.repeat(64),
    };
    const first = runner.reconcile(operationId, '6', request, 'cmd-a');
    assert.equal(viewCalls, 1);
    // 別の要求の照合は、待たずに断る。
    assert.equal(
      await runner.reconcile(operationId, '6', request, 'cmd-b'),
      null,
    );
    // 同じ要求の照合は、先の照合が終わるまで待つ。
    let sameDone = false;
    const same = runner
      .reconcile(operationId, '6', request, 'cmd-a')
      .then((value) => {
        sameDone = true;
        return value;
      });
    // 照合の最中に届いた実行の開始（retry の保存の後）。
    runner.start(operationId);
    assert.equal(viewCalls, 1);
    await Promise.resolve();
    assert.equal(sameDone, false);
    // 照合は対象外の状態（not_executed）を読んで終わる。
    views.shift()?.({
      operation_id: operationId,
      state: 'not_executed',
      attempt_id: 'at-1',
    });
    assert.equal(await first, null);
    assert.equal(await same, null);
    // 排他が外れた後に、預かった開始が状態を読み直す。
    await withTimeout(
      (async () => {
        while (viewCalls < 2)
          await new Promise((resolve) => setImmediate(resolve));
      })(),
      5_000,
      'pending start',
    );
    views.shift()?.(null);
    await idle({ handle: { runner } } as unknown as EventCore);
    assert.equal(viewCalls, 2);
  },
);

test(
  'a remote mutation is not prepared or sent while the retention gate is closed, and is tried again after the retry interval',
  { timeout: TIMEOUT },
  async () => {
    const operationId = randomUUID();
    let queries = 0;
    let conversations = 0;
    const store = {
      storeGeneration: 'g',
      query: () => {
        queries += 1;
        return Promise.resolve({
          operation_id: operationId,
          state: 'approved',
          operation_kind: 'mail.labels.change',
          effect_route: 'remote_mutation',
          attempt_id: null,
        });
      },
      // 準備権・送出意図は submit。閉じている間は一度も呼ばない。
      submit: () => assert.fail('ゲートが閉じている間は submit を呼ばない'),
      // 確定 intent を読もうとした = ゲートを通った。ここで止める（読めない）。
      conversation: () => {
        conversations += 1;
        return Promise.resolve({ ok: false });
      },
      consumeDispatchPermit: () => false,
    };
    let open = false;
    let readyCalls = 0;
    const logs: string[] = [];
    const runner = createOperationRunner({
      store: store as unknown as RunnerStore,
      keyStore: {
        loadDataKey: () => Promise.reject(new Error('unused')),
      } as unknown as DataKeyProvider,
      provider: {} as never,
      writer: {} as never,
      faults: new FaultInjector(),
      contract: createApiContract(),
      log: (message) => logs.push(message),
      cloudGate: {
        ready: () => {
          readyCalls += 1;
          return Promise.resolve();
        },
        open: () => open,
        lease: () => (open ? () => undefined : null),
      },
      gateRetryMs: 20,
    });
    runner.start(operationId);
    await runner.idle();
    assert.equal(conversations, 0);
    assert.equal(readyCalls, 1);
    assert.equal(logs.length, 1);
    // ゲートが開いた後の再試行で、最初から確かめ直して進む。
    open = true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await runner.idle();
    assert.equal(conversations, 1);
    assert.equal(queries, 2);
    runner.close();
  },
);

test(
  'closing the runner cancels the retry of an operation held by the retention gate',
  { timeout: TIMEOUT },
  async () => {
    const operationId = randomUUID();
    let queries = 0;
    const store = {
      storeGeneration: 'g',
      query: () => {
        queries += 1;
        return Promise.resolve({
          operation_id: operationId,
          state: 'approved',
          operation_kind: 'mail.labels.change',
          effect_route: 'remote_mutation',
          attempt_id: null,
        });
      },
      submit: () => assert.fail('submit は呼ばない'),
      conversation: () => assert.fail('conversation は呼ばない'),
      consumeDispatchPermit: () => false,
    };
    const runner = createOperationRunner({
      store: store as unknown as RunnerStore,
      keyStore: {
        loadDataKey: () => Promise.reject(new Error('unused')),
      } as unknown as DataKeyProvider,
      provider: {} as never,
      writer: {} as never,
      faults: new FaultInjector(),
      contract: createApiContract(),
      log: () => undefined,
      cloudGate: {
        ready: () => Promise.resolve(),
        open: () => false,
        lease: () => null,
      },
      gateRetryMs: 20,
    });
    runner.start(operationId);
    await runner.idle();
    runner.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(queries, 1);
  },
);

test(
  'a sweep that starts while the send is in flight waits for the send and does not run its body (review P1)',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    const retention = core.handle.retention;
    rig.injector.arm('after_dispatch_intent_before_send', { mode: 'pause' });
    await approveOperation(core, who, operationId);
    // 送出意図を保存した後・送る前（貸し出しを持っている区間）で止める。
    await reached(rig.injector, 'after_dispatch_intent_before_send');
    const sweep = retention.runOnce(true);
    let swept = false;
    void sweep.then(() => {
      swept = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // 掃除は本体に入れず、記録は running のまま。まだ何も送っていない。
    assert.equal(swept, false);
    assert.equal(retention.record().status, 'running');
    assert.equal(retention.gate().cloud_send, false);
    assert.equal(rig.provider.truth.requestCount(), 0);
    // 送信が終わると貸し出しが返り、掃除が進んで完了する。送出は 1 回だけ。
    rig.injector.release('after_dispatch_intent_before_send');
    await idle(core);
    const record = await sweep;
    assert.equal(record.status, 'completed');
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.equal(retention.gate().cloud_send, true);
  },
);

test(
  'a send whose gate closes after the recheck is held before the dispatch intent and resumes when the gate opens',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const clock = { ms: CLOCK_START };
    const core = await startCore(t, rig, { clock });
    const who = await session(core);
    const operationId = await createOperation(core, who, LABEL);
    rig.injector.arm('after_target_recheck', { mode: 'pause' });
    await approveOperation(core, who, operationId);
    await reached(rig.injector, 'after_target_recheck');
    // 確かめ直しの間に、掃除の記録が古くなった（20 分。sweep_stale）。
    clock.ms += 20 * 60_000;
    assert.equal(core.handle.retention.gate().cloud_send, false);
    rig.injector.release('after_target_recheck');
    await idle(core);
    // 送出意図の前で止まっている: 何も送らず、工程の記録もない（結果不明を作らない）。
    assert.equal(rig.provider.truth.requestCount(), 0);
    assert.deepEqual(await stepsOf(core, operationId), []);
    const held = await operationOf(core, who, operationId);
    assert.equal(held['state'], 'preparing');
    // 時計が戻ってゲートが開けば、最初から確かめ直して 1 回だけ送る。
    clock.ms = CLOCK_START;
    core.handle.runner?.start(operationId);
    await idle(core);
    assert.equal(rig.provider.truth.requestCount(), 1);
    assert.deepEqual(await stepsOf(core, operationId), [
      {
        step_id: '1-apply_labels',
        intent: true,
        result_status: 'confirmed_success',
      },
    ]);
  },
);

const BLOCKED_TEXT = '今は進められません';

test(
  'the retention gate: a closed gate blocks a schedule read, a local command passes, and an open gate waits for a running sweep',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const clock = { ms: CLOCK_START };
    const core = await startCore(t, rig, { clock });
    const who = await session(core);
    const retention = core.handle.retention;

    // 掃除の記録が古い（20 分）: 検索（予定の照会）は聞き返し、外部へは何も問い合わせない。
    clock.ms += 20 * 60_000;
    assert.equal(retention.gate().search, false);
    const readsBefore = rig.ports.counts.read;
    const blocked = await turn(core, who, SCHEDULE_TEXT);
    assert.ok(JSON.stringify(blocked).includes(BLOCKED_TEXT), 'blocked');
    assert.equal(rig.ports.counts.read, readsBefore);
    // ローカルの命令（用事の登録）は外部へ送らないので、ゲートに関係なく進む。
    const task = await turn(core, who, TASK_TEXT);
    assert.equal(
      (task['result_view'] as { item_refs: { kind: string }[] }).item_refs[0]
        ?.kind,
      'operation',
    );

    // ゲートが開いていても、掃除の本体を待っている間は答えを返さず、済んでから進む。
    clock.ms = CLOCK_START;
    assert.equal(retention.gate().search, true);
    const release = retention.lease();
    assert.notEqual(release, null);
    const sweep = retention.runOnce(true);
    let answered = false;
    const pending = turn(core, who, SCHEDULE_TEXT).then((value) => {
      answered = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(answered, false);
    release?.();
    await sweep;
    const read = await pending;
    assert.equal(JSON.stringify(read).includes(BLOCKED_TEXT), false);
  },
);

test(
  'stopping the Core ends a sweep waiting on a send lease before it closes the DB, and the stopped sweep leaves no completion record',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const retention = core.handle.retention;
    // 送出中の区間を模して貸し出しを持つ。そこへ始まった掃除は本体に入れず待つ。
    const release = retention.lease();
    assert.notEqual(release, null);
    const sweep = retention.runOnce(true);
    let stopped = false;
    const stopping = core.handle.stop('test').then(() => {
      stopped = true;
    });
    // 返却を待たずに、停止は掃除の中断（drain）を終えて DB を閉じる。
    await withTimeout(stopping, 10_000, 'stop while a sweep waits for a lease');
    assert.equal(stopped, true);
    const record = await sweep;
    // 停止で中断した掃除は、完了の記録を作らない（ゲートは開かない）。
    assert.equal(record.status, 'running');
    assert.equal(retention.gate().cloud_send, false);
    // 遅れて返しても、例外も状態の崩れもない。
    release?.();
    release?.();
    assert.equal(retention.record().status, 'running');
  },
);

test(
  'stopping the Core ends a sweep that waits for a send lease even when the lease is never released, and a late release is safe',
  { timeout: TIMEOUT },
  async (t) => {
    const rig = await startRig(t);
    const core = await startCore(t, rig);
    const retention = core.handle.retention;
    // 送出中の区間を模して貸し出しを持つ。そこへ始まった掃除は本体に入れず待つ。
    const release = retention.lease();
    assert.notEqual(release, null);
    const sweep = retention.runOnce(true);
    let stopped = false;
    const stopping = core.handle.stop('test').then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // 貸し出しを返さないままでも、停止は掃除の中断を待って終わる（返さないと終わらなければ失敗）。
    await withTimeout(
      Promise.all([stopping, sweep]),
      10_000,
      'stop while a sweep waits for a lease that is not released',
    );
    assert.equal(stopped, true);
    const record = await sweep;
    // 停止で中断した掃除は、完了の記録を作らない（ゲートは開かない）。
    assert.equal(record.status, 'running');
    assert.equal(retention.gate().cloud_send, false);
    // 返さない貸し出しが残っていても、停止の後の掃除は待たずに中断する。
    const afterClose = await withTimeout(
      retention.runOnce(true),
      10_000,
      'sweep after the Core stopped',
    );
    assert.equal(afterClose.status, 'running');
    // 遅れて返しても、例外も状態の崩れもない。
    release?.();
    release?.();
    assert.equal(retention.record().status, 'running');
    assert.equal(retention.gate().cloud_send, false);
  },
);
