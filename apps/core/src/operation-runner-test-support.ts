// 実行担当（ADR 0030）を、同じプロセスの Core（127.0.0.1 の HTTPS）・#87 の模擬 provider（127.0.0.1 の HTTP、
// 状態は Core と別のディレクトリ）・アダプター・故障注入（FaultInjector）で確かめる。
// 期待値（provider の要求回数・状態の変更回数・中枢の最終状態・自動再送の有無）は tests/integration/fault-points.json
// の手書きの値を読む（実装の処理から作らない）。待ち合わせは故障点の関門（pause・barrier・waitReached）と
// runner.idle() で行い、固定時間の sleep を使わない。模擬の試験だけで、実機・実 API・実請求は未実施。
// B04-07: 下書きの保存と QA27 の試験の道具（呼び出しの種類ごとの回数・接続先の差し替え・進められる時計・発言の応答・
// 承認と試行の件数）もここに置く（draft-save.test.ts・qa27-paths.test.ts・tests/integration/b04-cases.mjs が使う）。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type test from 'node:test';
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
  getJson,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { mockMailPorts } from './mock-mail-ports.js';
import type {
  Interpreter,
  ProviderReader,
  ProviderWriter,
} from './turn-ports.js';

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
      new URL('../../../tests/integration/fault-points.json', import.meta.url),
      'utf8',
    ),
  ) as { readonly cases: readonly FaultCase[] }
).cases;

const expectedOf = (id: string): FaultCase['expected'] => {
  const found = FAULT_CASES.find((entry) => entry.id === id);
  assert(found !== undefined, id);
  return found.expected;
};

const CLOCK_START = Date.parse('2026-10-05T09:00:00+09:00');
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';
const TIMEOUT = 60_000;
const DRAFT_TEXT =
  'mail-001 に「（合成）承知しました。」と返信の下書きを保存して';
const TASK_TEXT = '「牛乳を買う」を用事に登録して';
const SCHEDULE_TEXT = '今日の予定を見せて';

// 呼び出しの種類ごとの回数（read: 接続・許可・対象・予定の読み取り、write: 書込み、find: 目印での照合）。
interface CallCounts {
  read: number;
  write: number;
  find: number;
}

// 呼び出しを数える（LocalCommand の外部 HTTP が 0 件であることを、アダプターの手前で確かめる）。calls は全種類の合計。
// accountOverride を入れると、接続先のアカウントを差し替えて見せる（provider の状態は変えない）。
interface Counted {
  readonly reader: ProviderReader;
  readonly writer: ProviderWriter;
  calls: number;
  readonly counts: CallCounts;
  accountOverride: string | null;
}

function counted(reader: ProviderReader, writer: ProviderWriter): Counted {
  const counts: CallCounts = { read: 0, write: 0, find: 0 };
  const box: Counted = {
    calls: 0,
    counts,
    accountOverride: null,
    reader: {
      async connection() {
        box.calls++;
        counts.read++;
        const connection = await reader.connection();
        return connection === null || box.accountOverride === null
          ? connection
          : { ...connection, account_id: box.accountOverride };
      },
      // 差し替えた接続先のアカウントの許可は、合成の口座の許可をそのアカウントのものとして見せる。
      async readPermission(id) {
        box.calls++;
        counts.read++;
        if (box.accountOverride === null || id !== box.accountOverride)
          return reader.readPermission(id);
        const permission = await reader.readPermission(SYNTHETIC_ACCOUNT_ID);
        return permission === null
          ? null
          : { ...permission, account_id: box.accountOverride };
      },
      readTarget: (id) => (box.calls++, counts.read++, reader.readTarget(id)),
      listEvents: () => (box.calls++, counts.read++, reader.listEvents()),
      findDrafts: (marker) => {
        box.calls++;
        counts.find++;
        assert(reader.findDrafts !== undefined);
        return reader.findDrafts(marker);
      },
    },
    writer: {
      changeLabels: (identity, change) => (
        box.calls++,
        counts.write++,
        writer.changeLabels(identity, change)
      ),
      createDraft: (identity, draft) => {
        box.calls++;
        counts.write++;
        assert(writer.createDraft !== undefined);
        return writer.createDraft(identity, draft);
      },
    },
  };
  return box;
}

// 試験で進められる時計（接続範囲の期限切れ）。
interface Clock {
  ms: number;
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
  options: {
    readonly restartOf?: EventCore;
    readonly faults?: FaultInjector;
    readonly clock?: Clock;
    // 解釈の差し替え（解釈の間に状況を変える試験）。既定は模擬の解釈。
    readonly interpreter?: Interpreter;
  } = {},
): Promise<EventCore> {
  const previous = options.restartOf;
  const clock = options.clock ?? { ms: CLOCK_START };
  return startEventCore(t, {
    previewValid: false,
    now: () => new Date(clock.ms),
    ...(previous === undefined
      ? {}
      : { dataDir: previous.dataDir, tlsKeyStore: previous.tlsKeyStore }),
    turns: {
      provider: rig.ports.reader,
      writer: rig.ports.writer,
      faults: options.faults ?? rig.injector,
      ...(options.interpreter === undefined
        ? {}
        : { interpreter: options.interpreter }),
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
  // 再起動・期限切れの後に接続範囲を取り直せる。
  scope: string;
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

const reached = (
  injector: FaultInjector,
  point: Parameters<FaultInjector['waitReached']>[0],
) => withTimeout(injector.waitReached(point), 20_000, `reach ${point}`);

const LABEL = 'mail-001 に follow-up を付けて';

// 最新の試行の工程（operation_steps）。DB worker の表示用の照会で読む。
async function stepsOf(core: EventCore, operationId: string) {
  const view = await core.handle.store.query({
    kind: 'operation_view',
    operation_id: operationId,
  });
  assert(view !== null);
  return view.steps.map((step) => ({
    step_id: step.step_id,
    intent: step.dispatch_intent_at !== null,
    result_status: step.result_status,
  }));
}

function assertProvider(rig: Rig, id: string): void {
  const expected = expectedOf(id);
  assert.equal(
    rig.provider.truth.requestCount(),
    expected.provider_requests,
    id,
  );
  assert.equal(
    rig.provider.truth.stateChangeCount(),
    expected.provider_state_changes,
    id,
  );
}

// 会話を作って発言し、応答の本文を返す（状態の検査は試験が行う）。
async function turn(
  core: EventCore,
  who: Session,
  text: string,
): Promise<Record<string, unknown>> {
  const created = await postJson(core, who.device, '/v1/sessions', {
    request_id: randomUUID(),
    command_scope_id: who.scope,
    storage_mode: 'normal',
  });
  assert.equal(created.status, 201, created.text);
  const response = await postJson(
    core,
    who.device,
    `/v1/sessions/${String(created.json?.['session_id'])}/turns`,
    {
      request_id: randomUUID(),
      command_scope_id: who.scope,
      text,
      input_kind: 'text',
    },
  );
  assert.equal(response.status, 200, response.text);
  return response.json as Record<string, unknown>;
}

// preview の要求（応答をそのまま返す。拒否の試験に使う）。
const preview = (core: EventCore, who: Session, operationId: string) =>
  postJson(core, who.device, `/v1/operations/${operationId}/preview`, {
    request_id: randomUUID(),
    command_scope_id: who.scope,
  });

// 本人の照合（参照だけ）。
async function reconcile(core: EventCore, who: Session, operationId: string) {
  const view = await operationOf(core, who, operationId);
  return postJson(core, who.device, `/v1/operations/${operationId}/reconcile`, {
    request_id: randomUUID(),
    command_scope_id: who.scope,
    expected_state_revision: view['state_revision'],
  });
}

// 操作の承認・試行の件数と工程（DB worker の照会で読む）。
async function recordOf(core: EventCore, operationId: string) {
  const record = await core.handle.store.query({
    kind: 'operation',
    operation_id: operationId,
  });
  assert(record !== null);
  return {
    state: record.state,
    approvals: record.approvals.length,
    attempts: record.attempts.length,
    steps: await stepsOf(core, operationId),
  };
}

// 中枢のスナップショットの操作の件数（Read で操作を作らないこと）。
async function snapshotOperations(
  core: EventCore,
  who: Session,
): Promise<number> {
  const response = await getJson(core, who.device, '/v1/snapshot');
  assert.equal(response.status, 200, response.text);
  return (response.json?.['operations'] as unknown[]).length;
}

export {
  CLOCK_START,
  DRAFT_TEXT,
  MAIL_CANDIDATE,
  SCHEDULE_TEXT,
  TASK_TEXT,
  turn,
  preview,
  reconcile,
  recordOf,
  snapshotOperations,
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
  stepsOf,
  assertProvider,
  TIMEOUT,
};
export type { CallCounts, Clock, Session };
