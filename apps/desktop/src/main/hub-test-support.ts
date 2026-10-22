// デスクトップの main の試験で使う道具（試験専用。製品のコード・Electron の層からは読み込まない。ADR 0025）。
//
// - 中枢は同じプロセスの startCore（HTTPS は 127.0.0.1）。鍵は模擬の KeyStore で、実機のキーチェーンに触れない。
// - safeStorage の代わりに模擬の SecretProtector（試験ごとの乱数の鍵の AES-256-GCM）を注入する。
// - 端末トークン・申請用の秘密は試験の中の合成の値で、アサーションのメッセージ・出力に入れない。
// - 後始末は onCleanup（後に登録したものから先に。閉じてから削除）。待ちはどれも成立・時間切れで必ず終える。

import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type test from 'node:test';
import { startCore } from '@buddy/core';
import type { CoreHandle } from '@buddy/core';
import { createMockKeyStore, createMockTlsKeyStore } from '@buddy/platform';
import type { MockTlsKeyStore } from '@buddy/platform';
import { sealOperationIntent } from '@buddy/storage';
import type {
  CreateOperationCommand,
  DataKeyMaterial,
  DbCommand,
} from '@buddy/storage';
import type { SecretProtector } from './credential-store.js';

const cleanups = new WeakMap<object, (() => unknown)[]>();

// 試験の後始末を「後に登録したものから先に」行う（node:test の t.after は登録した順に動く。ADR 0020）。
export function onCleanup(t: test.TestContext, cleanup: () => unknown): void {
  let stack = cleanups.get(t);
  if (stack === undefined) {
    const created: (() => unknown)[] = [];
    stack = created;
    cleanups.set(t, created);
    t.after(async () => {
      for (const run of created.reverse()) {
        try {
          await run();
        } catch {
          // 後始末の失敗で他の後始末を止めない。
        }
      }
    });
  }
  stack.push(cleanup);
}

export async function tempDir(
  t: test.TestContext,
  prefix: string,
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  onCleanup(t, () =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return base;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 条件が成り立つまで短い間隔で確かめる（時間切れなら名前つきの失敗）。
export async function waitUntil(
  predicate: () => boolean,
  label: string,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// 空いているポート（中枢を同じポートで再起動するため）。
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// 模擬の safeStorage。試験ごとの乱数の鍵の AES-256-GCM で、平文を残さない。
export interface MockProtector extends SecretProtector {
  // 試験だけが保存したトークンを読むための復号（製品の経路では使わない）。
  readonly reveal: (cipher: Buffer) => string;
}

export function mockProtector(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly available?: boolean;
    readonly backend?: string | null;
  } = {},
): MockProtector {
  const key = randomBytes(32);
  const decrypt = (cipher: Buffer) => {
    if (cipher.length < 28) throw new Error('mock_cipher_short');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      cipher.subarray(0, 12),
    );
    decipher.setAuthTag(cipher.subarray(12, 28));
    return Buffer.concat([
      decipher.update(cipher.subarray(28)),
      decipher.final(),
    ]).toString('utf8');
  };
  return {
    platform: options.platform ?? 'darwin',
    isEncryptionAvailable: () => options.available ?? true,
    selectedBackend: () => options.backend ?? null,
    encryptString(plain) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([
        cipher.update(plain, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decryptString: decrypt,
    reveal: decrypt,
  };
}

// --- 中枢 ---

const DATA_KEY = Buffer.alloc(32, 0x5d);
export const DATA_KEY_MATERIAL: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: DATA_KEY,
};

export interface TestHub {
  readonly handle: CoreHandle;
  readonly dataDir: string;
  readonly tlsKeyStore: MockTlsKeyStore;
  readonly port: number;
}

// 中枢を起動する。ロック状態・自宅判定は注入せず、Core の既定（Buddy-Lock-State の申告・同じマシンの免除）を使う。
export async function startHub(
  t: test.TestContext,
  options: {
    readonly dataDir: string;
    readonly port: number;
    readonly tlsKeyStore?: MockTlsKeyStore;
  },
): Promise<TestHub> {
  const tlsKeyStore = options.tlsKeyStore ?? createMockTlsKeyStore();
  const handle = await startCore({
    dataDir: options.dataDir,
    keyStore: createMockKeyStore({ stored: DATA_KEY.toString('base64') }),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    https: {
      host: '127.0.0.1',
      port: options.port,
      tlsKeyStore,
      eventStream: { pingIntervalMs: 200 },
    },
    events: { pollIntervalMs: 100 },
  });
  onCleanup(t, () => handle.stop('test').catch(() => undefined));
  assert(handle.https !== null);
  return { handle, dataDir: options.dataDir, tlsKeyStore, port: options.port };
}

// --- 操作の命令（H01 の合成の確定 intent を封じたもの） ---

// 契約の合成の fixture は @buddy/contracts の公開出口から読む（別のワークスペースを相対パスで読まない）。
const h01 = JSON.parse(
  await readFile(
    new URL(import.meta.resolve('@buddy/contracts/fixtures/h01.json')),
    'utf8',
  ),
) as { intent: Record<string, unknown> };

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
    operation_kind: 'synthetic.local_change',
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

export function prepareCommand(
  operationId: string,
  expected: string,
): DbCommand & { readonly attempt_id: string } {
  return {
    ...commandBase(operationId, expected),
    kind: 'operation.prepare',
    attempt_id: randomUUID(),
  };
}

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
  hub: TestHub,
  command: DbCommand,
): Promise<void> {
  const outcome = await withTimeout(
    hub.handle.store.submit(command).result,
    10_000,
    `submit ${command.kind}`,
  );
  assert.equal(outcome.outcome, 'durable', JSON.stringify(outcome));
}
