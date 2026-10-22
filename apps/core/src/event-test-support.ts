// スナップショット・イベント・操作の経路の試験で使う道具（試験専用。index.ts から export しない）。
//
// - Core は同じプロセスの startCore で、HTTPS は 127.0.0.1。鍵は模擬の KeyStore（実機のキーチェーンに触れない）。
// - 操作は DB worker の命令で直接作る（確定 intent は H01 の合成値を封じたもの）。端末トークンは試験の中で作る
//   合成の値で、出力・例外のメッセージに入れない。
// - WSS のクライアントはピン留め（信頼の起点は中枢の証明書 1 枚・指紋の照合）で接続する。
// - 待ちはどれも、応答・切断・時間切れのどれかで必ず終える。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type test from 'node:test';
import { createMockKeyStore, createMockTlsKeyStore } from '@buddy/platform';
import type { MockTlsKeyStore } from '@buddy/platform';
import { sealOperationIntent } from '@buddy/storage';
import type {
  CreateOperationCommand,
  DataKeyMaterial,
  DbCommand,
  DbCommandOutcome,
} from '@buddy/storage';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';
import type { RequestEnvironment } from './api-environment.js';
import {
  insertDevice,
  onCleanup,
  pinnedCheck,
  pinnedRequest,
  tempDir,
  withTimeout,
} from './api-test-support.js';
import type {
  ApiResponse,
  PinnedTarget,
  TestDevice,
} from './api-test-support.js';
import { startCore } from './core.js';
import type { CoreHandle, StartCoreOptions } from './core.js';
import { TLS_CERTIFICATE_FILE } from './tls-identity.js';

// 合成のデータ鍵（値に意味はない）。
const DATA_KEY = Buffer.alloc(32, 0x6e);
export const DATA_KEY_MATERIAL: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: DATA_KEY,
};

const h01 = JSON.parse(
  await readFile(
    new URL('../../../packages/contracts/fixtures/h01.json', import.meta.url),
    'utf8',
  ),
) as { intent: Record<string, unknown> };
// 設計 08 §2 の H01 の操作 ID と hash（手で写した値）。
export const H01_OPERATION = String(h01.intent['operation_id']);
export const H01_SHA256 =
  '72c8a8c172bda32f8df7933dca1c490198a0f3670ce03adc40445d55a68b00bf';

// 切り替えた環境（試験の途中で自宅判定・ロック状態を変える）。
export interface MutableEnvironment {
  home: boolean;
  lock: 'unlocked' | 'locked' | 'unknown';
}

export interface EventCore {
  readonly handle: CoreHandle;
  readonly target: PinnedTarget;
  readonly env: MutableEnvironment;
  readonly dataDir: string;
  readonly tlsKeyStore: MockTlsKeyStore;
}

export async function startEventCore(
  t: test.TestContext,
  options: {
    readonly dataDir?: string;
    readonly tlsKeyStore?: MockTlsKeyStore;
    readonly previewValid?: boolean;
    readonly pingIntervalMs?: number;
    readonly events?: StartCoreOptions['events'];
    readonly env?: MutableEnvironment;
    // true なら lockState を注入せず、Core の既定（Buddy-Lock-State の申告。ADR 0025）を使う。
    readonly lockFromHeader?: boolean;
  } = {},
): Promise<EventCore> {
  const dataDir =
    options.dataDir ?? join(await tempDir(t, 'buddy-events-'), 'data');
  const tlsKeyStore = options.tlsKeyStore ?? createMockTlsKeyStore();
  const env: MutableEnvironment = options.env ?? {
    home: true,
    lock: 'unlocked',
  };
  const environment: Partial<RequestEnvironment> = {
    homeNetwork: () => env.home,
    ...(options.lockFromHeader === true ? {} : { lockState: () => env.lock }),
    hubLocal: () => true,
    audioOwner: () => 'self',
    claimSecretMatches: () => false,
  };
  const handle = await startCore({
    dataDir,
    keyStore: createMockKeyStore({ stored: DATA_KEY.toString('base64') }),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    https: {
      host: '127.0.0.1',
      port: 0,
      tlsKeyStore,
      environment,
      ...(options.previewValid === false ? {} : { previewValid: () => true }),
      eventStream: { pingIntervalMs: options.pingIntervalMs ?? 200 },
    },
    ...(options.events === undefined ? {} : { events: options.events }),
  });
  onCleanup(t, () => handle.stop('test').catch(() => undefined));
  assert(handle.https !== null);
  const certificatePem = await readFile(
    join(dataDir, TLS_CERTIFICATE_FILE),
    'utf8',
  );
  return {
    handle,
    env,
    dataDir,
    tlsKeyStore,
    target: {
      host: handle.https.host,
      port: handle.https.port,
      certificatePem,
      fingerprint: handle.https.certificateFingerprint,
    },
  };
}

// --- 操作の命令（接続のない LocalCommand） ---

const commandBase = (operationId: string, expected: string) => ({
  command_id: randomUUID(),
  operation_id: operationId,
  expected_state_revision: expected,
  request_revision: null,
  permission_revision: '0',
  forgetting_generation: '0',
  connection_id: null,
  request: null,
});

// 承認待ち（state_revision 1）の操作を作る命令。auto なら方針の自動承認で approved から始める。
export function createCommand(
  operationId: string,
  options: { readonly auto?: boolean } = {},
): CreateOperationCommand {
  const sealed = sealOperationIntent(
    DATA_KEY_MATERIAL,
    { operationId, contentVersion: 1 },
    { ...h01.intent, operation_id: operationId },
  );
  assert(sealed.ok);
  return {
    ...commandBase(operationId, '0'),
    kind: 'operation.create',
    workflow_id: null,
    operation_kind: 'mail.labels.change',
    effect_route: 'local_command',
    content_hash: sealed.content_hash,
    intent: sealed.intent,
    auto_approval:
      options.auto === true
        ? {
            approval_id: randomUUID(),
            policy_version: '3',
            current_policy_version: '3',
          }
        : null,
  };
}

export const prepareCommand = (
  operationId: string,
  expected: string,
): DbCommand => ({
  ...commandBase(operationId, expected),
  kind: 'operation.prepare',
  attempt_id: randomUUID(),
});

export const dispatchCommand = (
  operationId: string,
  expected: string,
  attemptId: string,
): DbCommand => ({
  ...commandBase(operationId, expected),
  kind: 'operation.dispatch_intent',
  attempt_id: attemptId,
  reservation_id: null,
});

export async function submitDurable(
  core: EventCore,
  command: DbCommand,
): Promise<DbCommandOutcome> {
  const outcome = await withTimeout(
    core.handle.store.submit(command).result,
    10_000,
    `submit ${command.kind}`,
  );
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
  return outcome;
}

// --- HTTP ---

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

export async function bootstrap(
  core: EventCore,
  device: TestDevice,
): Promise<string> {
  const response = await pinnedRequest(core.target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: bearer(device.token),
  });
  assert.equal(response.status, 200, response.text);
  return String(response.json?.['command_scope_id']);
}

export const getJson = (
  core: EventCore,
  device: TestDevice,
  path: string,
): Promise<ApiResponse> =>
  pinnedRequest(core.target, {
    method: 'GET',
    path,
    headers: bearer(device.token),
  });

export const postJson = (
  core: EventCore,
  device: TestDevice,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ApiResponse> =>
  pinnedRequest(core.target, {
    method: 'POST',
    path,
    headers: {
      ...bearer(device.token),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });

export const approveBody = (
  scope: string,
  options: {
    readonly requestId?: string;
    readonly expected?: string;
    readonly hash?: string;
    readonly previewId?: string;
  } = {},
): Record<string, unknown> => ({
  request_id: options.requestId ?? randomUUID(),
  command_scope_id: scope,
  preview_id: options.previewId ?? randomUUID(),
  content_version: '1',
  content_hash: options.hash ?? H01_SHA256,
  expected_state_revision: options.expected ?? '1',
});

export const approve = (
  core: EventCore,
  device: TestDevice,
  operationId: string,
  body: Record<string, unknown>,
): Promise<ApiResponse> =>
  postJson(core, device, `/v1/operations/${operationId}/approve`, body, {
    'buddy-input-origin': 'screen',
  });

export const cancel = (
  core: EventCore,
  device: TestDevice,
  operationId: string,
  body: Record<string, unknown>,
): Promise<ApiResponse> =>
  postJson(core, device, `/v1/operations/${operationId}/cancel`, body);

export { insertDevice };

// --- WSS ---

export interface StreamMessage {
  readonly type: string;
  readonly event?: Record<string, unknown>;
  readonly reason?: string;
}

export interface StreamClient {
  readonly messages: StreamMessage[];
  // 切り替えの結果（open か、HTTP の拒否の状態）。
  readonly opened: Promise<
    { readonly ok: true } | { readonly ok: false; readonly status: number }
  >;
  // 閉じた（コードと理由）。
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  // 条件を満たすメッセージがそろうまで待つ（閉じた・時間切れなら失敗）。
  waitFor(
    predicate: (messages: readonly StreamMessage[]) => boolean,
    label: string,
    ms?: number,
  ): Promise<void>;
  close(): void;
  readonly socket: WebSocket;
}

export function openStream(
  t: test.TestContext,
  core: EventCore,
  device: TestDevice | null,
  cursor: string | null,
  options: { readonly autoPong?: boolean } = {},
): StreamClient {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  const socket = new WebSocket(
    `wss://127.0.0.1:${core.target.port}/v1/events/stream${query}`,
    {
      headers: device === null ? {} : bearer(device.token),
      ca: [core.target.certificatePem],
      checkServerIdentity: pinnedCheck(
        core.target.fingerprint,
      ) as unknown as ClientOptions['checkServerIdentity'],
      autoPong: options.autoPong ?? true,
    },
  );
  onCleanup(t, () => socket.terminate());
  const messages: StreamMessage[] = [];
  const listeners = new Set<() => void>();
  let isClosed = false;
  const opened = new Promise<
    { readonly ok: true } | { readonly ok: false; readonly status: number }
  >((resolve) => {
    socket.once('open', () => resolve({ ok: true }));
    socket.once('unexpected-response', (request, response) => {
      resolve({ ok: false, status: response.statusCode ?? 0 });
      request.destroy();
    });
    socket.once('close', () => resolve({ ok: false, status: 0 }));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => {
      isClosed = true;
      for (const listener of listeners) listener();
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
  socket.on('error', () => undefined);
  socket.on('message', (data) => {
    messages.push(JSON.parse(String(data)) as StreamMessage);
    for (const listener of listeners) listener();
  });
  return {
    messages,
    opened,
    closed,
    socket,
    close: () => socket.close(),
    waitFor(predicate, label, ms = 10_000) {
      return withTimeout(
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (predicate(messages)) {
              listeners.delete(check);
              resolve();
            } else if (isClosed) {
              listeners.delete(check);
              reject(new Error(`closed before: ${label}`));
            }
          };
          listeners.add(check);
          check();
        }),
        ms,
        label,
      );
    },
  };
}

export const eventsOf = (messages: readonly StreamMessage[]) =>
  messages
    .filter((message) => message.type === 'event')
    .map((message) => message.event as Record<string, unknown>);
