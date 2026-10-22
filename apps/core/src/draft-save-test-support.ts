// 下書きの保存（B04-07）と QA27 の 3 経路の試験の道具（試験専用。index.ts から export しない）。
//
// - Core は同じプロセスの startEventCore（127.0.0.1 の HTTPS）。模擬 provider は Core と別のディレクトリ。
// - アダプターの呼び出しを数える（LocalCommand の外部 HTTP 0 件・Read の書込み 0 件を、アダプターの手前で確かめる）。
// - 接続先のアカウントを試験で差し替えられる（アカウントが違うときの拒否）。
// - 時計を試験で進められる（接続範囲の期限切れ）。
// - B04-06（PR #105）の operation-runner-test-support.ts と同じ形にしてある。#105 のマージ後に寄せられる。
// 期待値はこのファイルでは作らない（各試験に手で書く）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type test from 'node:test';
import { createMockMailConnector } from '@buddy/connectors';
import {
  FaultInjector,
  SYNTHETIC_ACCOUNT_ID,
  createMockProvider,
} from '@buddy/connectors/testing';
import type { MockProvider } from '@buddy/connectors/testing';
import { tempDir, onCleanup, withTimeout } from './api-test-support.js';
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
import type { ProviderReader, ProviderWriter } from './turn-ports.js';

export const CLOCK_START = Date.parse('2026-10-05T09:00:00+09:00');
export const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';
export const DRAFT_TEXT =
  'mail-001 に「（合成）承知しました。」と返信の下書きを保存して';
export const TASK_TEXT = '「牛乳を買う」を用事に登録して';
export const SCHEDULE_TEXT = '今日の予定を見せて';

// アダプターの呼び出しの回数（種類ごと）。
export interface Calls {
  read: number;
  write: number;
  find: number;
}

export interface Ports {
  readonly reader: ProviderReader;
  readonly writer: ProviderWriter;
  readonly calls: Calls;
  // 接続先のアカウントを差し替える（null で戻す）。provider の状態は変えない。
  accountOverride: string | null;
}

function countedPorts(reader: ProviderReader, writer: ProviderWriter): Ports {
  const calls: Calls = { read: 0, write: 0, find: 0 };
  const box: Ports = {
    calls,
    accountOverride: null,
    reader: {
      async connection() {
        calls.read += 1;
        const connection = await reader.connection();
        return connection === null || box.accountOverride === null
          ? connection
          : { ...connection, account_id: box.accountOverride };
      },
      readPermission: (id) => (calls.read++, reader.readPermission(id)),
      readTarget: (id) => (calls.read++, reader.readTarget(id)),
      listEvents: () => (calls.read++, reader.listEvents()),
      findDrafts: (marker) => {
        calls.find += 1;
        assert(reader.findDrafts !== undefined);
        return reader.findDrafts(marker);
      },
    },
    writer: {
      changeLabels: (identity, change) => (
        calls.write++,
        writer.changeLabels(identity, change)
      ),
      createDraft: (identity, draft) => {
        calls.write += 1;
        assert(writer.createDraft !== undefined);
        return writer.createDraft(identity, draft);
      },
    },
  };
  return box;
}

export interface Rig {
  readonly provider: MockProvider;
  readonly injector: FaultInjector;
  readonly ports: Ports;
}

// 模擬 provider（Core と別のディレクトリ）とアダプター。writeSignal は書込みの時間切れを試験が起こすため。
export async function startRig(
  t: test.TestContext,
  options: { readonly writeSignal?: AbortSignal } = {},
): Promise<Rig> {
  const providerDir = join(await tempDir(t, 'buddy-draft-provider-'), 'p');
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
    injector,
    ports: countedPorts(ports.reader, ports.writer),
  };
}

// 試験で進められる時計。
export interface Clock {
  ms: number;
}

export async function startCore(
  t: test.TestContext,
  rig: Rig,
  options: {
    readonly restartOf?: EventCore;
    readonly faults?: FaultInjector;
    readonly clock?: Clock;
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

export interface Session {
  readonly device: TestDevice;
  scope: string;
}

export async function session(core: EventCore): Promise<Session> {
  const device = await insertDevice(core.handle.store);
  return { device, scope: await bootstrap(core, device) };
}

// 会話を作って発言する。応答をそのまま返す（状態の検査は試験が行う）。
export async function turn(
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

// 発言から操作を作り、操作 ID を返す。
export async function createOperation(
  core: EventCore,
  who: Session,
  text: string,
): Promise<string> {
  const body = await turn(core, who, text);
  const view = body['result_view'] as Record<string, unknown>;
  const refs = view['item_refs'] as { kind: string; id: string }[];
  assert.equal(refs[0]?.kind, 'operation', JSON.stringify(body));
  return String(refs[0]?.id);
}

export async function preview(
  core: EventCore,
  who: Session,
  operationId: string,
) {
  return postJson(core, who.device, `/v1/operations/${operationId}/preview`, {
    request_id: randomUUID(),
    command_scope_id: who.scope,
  });
}

export async function approveOperation(
  core: EventCore,
  who: Session,
  operationId: string,
) {
  const shown = await preview(core, who, operationId);
  assert.equal(shown.status, 200, shown.text);
  const body = approveBody(who.scope, {
    previewId: String(shown.json?.['preview_id']),
    hash: String(shown.json?.['content_hash']),
  });
  const response = await approve(core, who.device, operationId, body);
  assert.equal(response.status, 202, response.text);
  return { body, response, preview: shown.json as Record<string, unknown> };
}

export async function operationOf(
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

// 本人の照合（参照だけ）。
export async function reconcile(
  core: EventCore,
  who: Session,
  operationId: string,
) {
  const view = await operationOf(core, who, operationId);
  return postJson(core, who.device, `/v1/operations/${operationId}/reconcile`, {
    request_id: randomUUID(),
    command_scope_id: who.scope,
    expected_state_revision: view['state_revision'],
  });
}

export const idle = (core: EventCore) => {
  const runner = core.handle.runner;
  assert(runner !== null);
  return withTimeout(runner.idle(), 20_000, 'runner idle');
};

export const reached = (
  injector: FaultInjector,
  point: Parameters<FaultInjector['waitReached']>[0],
) => withTimeout(injector.waitReached(point), 20_000, `reach ${point}`);

// 操作の記録（承認・試行の件数）と工程（DB worker の照会で読む）。
export async function recordOf(core: EventCore, operationId: string) {
  const record = await core.handle.store.query({
    kind: 'operation',
    operation_id: operationId,
  });
  const view = await core.handle.store.query({
    kind: 'operation_view',
    operation_id: operationId,
  });
  assert(record !== null && view !== null);
  return {
    state: record.state,
    approvals: record.approvals.length,
    attempts: record.attempts.length,
    steps: view.steps.map((step) => ({
      step_id: step.step_id,
      intent: step.dispatch_intent_at !== null,
      result_status: step.result_status,
    })),
  };
}

// 中枢のスナップショットの操作の件数（Read で操作を作らないこと）。
export async function snapshotOperations(
  core: EventCore,
  who: Session,
): Promise<number> {
  const response = await getJson(core, who.device, '/v1/snapshot');
  assert.equal(response.status, 200, response.text);
  return (response.json?.['operations'] as unknown[]).length;
}
