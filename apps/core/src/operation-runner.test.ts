// 実行担当（ADR 0030）を、同じプロセスの Core（127.0.0.1 の HTTPS）・#87 の模擬 provider（127.0.0.1 の HTTP、
// 状態は Core と別のディレクトリ）・アダプター・故障注入（FaultInjector）で確かめる。
// 期待値（provider の要求回数・状態の変更回数・中枢の最終状態・自動再送の有無）は tests/integration/fault-points.json
// の手書きの値を読む（実装の処理から作らない）。待ち合わせは故障点の関門（pause・barrier・waitReached）と
// runner.idle() で行い、固定時間の sleep を使わない。模擬の試験だけで、実機・実 API・実請求は未実施。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMockMailConnector } from '@buddy/connectors';
import {
  FaultInjector,
  SYNTHETIC_ACCOUNT_ID,
  createMockProvider,
} from '@buddy/connectors/testing';
import type { MockProvider } from '@buddy/connectors/testing';
import { onCleanup, tempDir, withTimeout } from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import {
  approve,
  approveBody,
  bootstrap,
  cancel,
  getJson,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { mockMailPorts } from './mock-mail-ports.js';
import type { ProviderReader, ProviderWriter } from './turn-ports.js';

interface FaultCase {
  readonly id: string;
  readonly expected: {
    readonly provider_requests: number;
    readonly provider_state_changes: number;
    readonly approvals: number;
    readonly core_final_state: string;
    readonly automatic_retry?: boolean;
  };
}

const FAULT_CASES = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../tests/integration/fault-points.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { readonly cases: readonly FaultCase[] }
).cases;

const expectedOf = (id: string): FaultCase['expected'] => {
  const found = FAULT_CASES.find((entry) => entry.id === id);
  assert(found !== undefined, id);
  return found.expected;
};

const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';
const TIMEOUT = 60_000;

// 呼び出しを数える（LocalCommand の外部 HTTP が 0 件であることを、アダプターの手前で確かめる）。
interface Counted {
  readonly reader: ProviderReader;
  readonly writer: ProviderWriter;
  calls: number;
}

function counted(reader: ProviderReader, writer: ProviderWriter): Counted {
  const box: Counted = {
    calls: 0,
    reader: {
      connection: () => (box.calls++, reader.connection()),
      readPermission: (id) => (box.calls++, reader.readPermission(id)),
      readTarget: (id) => (box.calls++, reader.readTarget(id)),
      listEvents: () => (box.calls++, reader.listEvents()),
    },
    writer: {
      changeLabels: (identity, change) => (
        box.calls++,
        writer.changeLabels(identity, change)
      ),
    },
  };
  return box;
}

interface Rig {
  readonly provider: MockProvider;
  readonly providerDir: string;
  readonly injector: FaultInjector;
  readonly ports: Counted;
}

// 模擬 provider（Core と別のディレクトリ）とアダプター。writeSignal は書込みの時間切れを試験が起こすため。
async function startRig(
  t: test.TestContext,
  options: { readonly writeSignal?: AbortSignal } = {},
): Promise<Rig> {
  const providerDir = join(await tempDir(t, 'buddy-runner-provider-'), 'p');
  const injector = new FaultInjector();
  const provider = await createMockProvider({ dir: providerDir, injector });
  onCleanup(t, () => provider.close());
  const read = createMockMailConnector({ baseUrl: provider.url });
  const write = createMockMailConnector({
    baseUrl: provider.url,
    ...(options.writeSignal === undefined
      ? {}
      : { timeoutSignal: options.writeSignal }),
  });
  const ports = mockMailPorts({
    accountId: SYNTHETIC_ACCOUNT_ID,
    read,
    write,
  });
  return {
    provider,
    providerDir,
    injector,
    ports: counted(ports.reader, ports.writer),
  };
}

async function startCore(
  t: test.TestContext,
  rig: Rig,
  options: { readonly restartOf?: EventCore; readonly faults?: FaultInjector } = {},
): Promise<EventCore> {
  const previous = options.restartOf;
  return startEventCore(t, {
    previewValid: false,
    now: () => CLOCK,
    ...(previous === undefined
      ? {}
      : { dataDir: previous.dataDir, tlsKeyStore: previous.tlsKeyStore }),
    turns: {
      provider: rig.ports.reader,
      writer: rig.ports.writer,
      faults: options.faults ?? rig.injector,
      candidates: {
        mailCandidates: () =>
          Promise.resolve([
            { candidate_id: MAIL_CANDIDATE, remote_id: 'mail-001' },
          ]),
      },
      utcOffset: '+09:00',
    },
  });
}

interface Session {
  readonly device: TestDevice;
  readonly scope: string;
}

async function session(core: EventCore): Promise<Session> {
  const device = await insertDevice(core.handle.store);
  return { device, scope: await bootstrap(core, device) };
}

// 発言から操作を作り、操作 ID を返す。
async function createOperation(
  core: EventCore,
  who: Session,
  text: string,
): Promise<string> {
  const created = await postJson(core, who.device, '/v1/sessions', {
    request_id: randomUUID(),
    command_scope_id: who.scope,
    storage_mode: 'normal',
  });
  assert.equal(created.status, 201, created.text);
  const sessionId = String(created.json?.['session_id']);
  const turn = await postJson(
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
  assert.equal(turn.status, 200, turn.text);
  const view = turn.json?.['result_view'] as Record<string, unknown>;
  const refs = view['item_refs'] as { kind: string; id: string }[];
  assert.equal(refs[0]?.kind, 'operation', turn.text);
  return String(refs[0]?.id);
}

async function previewOf(
  core: EventCore,
  who: Session,
  operationId: string,
): Promise<{ readonly previewId: string; readonly hash: string }> {
  const shown = await postJson(
    core,
    who.device,
    `/v1/operations/${operationId}/preview`,
    { request_id: randomUUID(), command_scope_id: who.scope },
  );
  assert.equal(shown.status, 200, shown.text);
  return {
    previewId: String(shown.json?.['preview_id']),
    hash: String(shown.json?.['content_hash']),
  };
}

async function approveOperation(
  core: EventCore,
  who: Session,
  operationId: string,
  requestId: string = randomUUID(),
) {
  const shown = await previewOf(core, who, operationId);
  const body = approveBody(who.scope, {
    previewId: shown.previewId,
    hash: shown.hash,
    requestId,
  });
  const response = await approve(core, who.device, operationId, body);
  assert.equal(response.status, 202, response.text);
  return { body, response };
}

async function operationOf(
  core: EventCore,
  who: Session,
  operationId: string,
): Promise<Record<string, unknown>> {
  const response = await getJson(
    core,
    who.device,
    `/v1/operations/${operationId}`,
  );
  assert.equal(response.status, 200, response.text);
  return response.json as Record<string, unknown>;
}

const idle = (core: EventCore) => {
  const runner = core.handle.runner;
  assert(runner !== null);
  return withTimeout(runner.idle(), 20_000, 'runner idle');
};

const reached = (injector: FaultInjector, point: Parameters<FaultInjector['waitReached']>[0]) =>
  withTimeout(injector.waitReached(point), 20_000, `reach ${point}`);

const LABEL = 'mail-001 に follow-up を付けて';

function assertProvider(rig: Rig, id: string): void {
  const expected = expectedOf(id);
  assert.equal(rig.provider.truth.requestCount(), expected.provider_requests, id);
  assert.equal(
    rig.provider.truth.stateChangeCount(),
    expected.provider_state_changes,
    id,
  );
}

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
        approveBody(b.scope, { previewId: shownB.previewId, hash: shownB.hash }),
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
    assert.equal((await operationOf(core, who, operationId))['state'], 'dispatching');
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
