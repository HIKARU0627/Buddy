// 忘却の計画の経路を、HTTPS の受付（端末トークン・自宅判定・接続範囲・ロック解除・画面操作の起源の検査）と一緒に確かめる
// （U433、ADR 0185）。製品の Core は忘却の公開ゲートが閉じていて計画を作れない（forget-core.test.ts・memory-core.test.ts）
// ので、ここはゲートを開いた試験用の組み立て（forget-service.test.ts と同じ形）を HTTPS の受付に載せる。
// - 計画の応答は、消える指示の本文と範囲を返し、元の発言の ID・台帳の HMAC・内容の HMAC を返さない。開けない指示は本文が null。
// - ロック中・ロック状態不明・自宅の外・画面でない起源・起源なし・トークンなしは、計画を作る前（系譜を読む前）に拒否する。
// - 別の端末は、他の端末の計画を実行できない（409。本文も返らない）。ゲートを閉じれば 503 で、系譜を読まない。
// DB worker の口は合成の系譜を返す模擬（系譜と封筒の読み出しは forget-service.test.ts が実際の DB で確かめる）。
// 端末の登録と接続範囲は実際の DB worker。指示の本文は試験用のデータ鍵で本当に封じた値。期待値は手で書いた。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMockTlsKeyStore } from '@buddy/platform';
import { sealBlob } from '@buddy/storage';
import type {
  DataKeyMaterial,
  ForgetDirectiveRow,
  MemoryBlobOutput,
  MemoryOp,
} from '@buddy/storage';
import { createForgetRoutes } from './api-forget.js';
import type { RequestEnvironment } from './api-environment.js';
import { createApiServer } from './api-server.js';
import {
  insertDevice,
  onCleanup,
  pinnedRequest,
  sharedApiContract,
  startTestStore,
  tempDir,
} from './api-test-support.js';
import type {
  ApiResponse,
  PinnedTarget,
  TestDevice,
} from './api-test-support.js';
import { createForgetService } from './forget-service.js';
import type { ForgetLedgerStore } from './forget-ledger.js';
import { loadOrCreateTlsIdentity } from './tls-identity.js';

const contract = sharedApiContract();
const CORE_INSTANCE = '00000000-0000-4000-8000-0000000000c1';
const KEY: DataKeyMaterial = { keyId: 'data-key-v1', key: Buffer.alloc(32, 9) };
const OTHER_KEY: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: Buffer.alloc(32, 10),
};
const MEMORY = 'c2000000-0000-4000-8000-000000000001';
const TURN = 'c2000000-0000-4000-8000-000000000002';
const READABLE = 'c2000000-0000-4000-8000-000000000003';
const UNREADABLE = 'c2000000-0000-4000-8000-000000000004';
const SOURCE_HMAC = 'a1'.repeat(32);
const CONTENT_HMAC = 'c1'.repeat(32);
const READABLE_TEXT = 'この会話では敬語をやめて';
const SCREEN = { 'buddy-input-origin': 'screen' };

function sealed(
  directiveId: string,
  text: string,
  key: DataKeyMaterial,
): MemoryBlobOutput {
  const result = sealBlob(key, new TextEncoder().encode(text), {
    ownerTable: 'user_directives',
    ownerId: directiveId,
    ownerVersion: 0,
    purpose: 'directive_text',
  });
  assert(result.ok);
  return {
    blob_id: randomUUID(),
    format_version: result.envelope.formatVersion,
    key_id: result.envelope.keyId,
    nonce: result.envelope.nonce,
    ciphertext: result.envelope.ciphertext,
    tag: result.envelope.tag,
  };
}

interface Started {
  readonly target: PinnedTarget;
  readonly env: { lock: 'unlocked' | 'locked' | 'unknown'; home: boolean };
  readonly gate: { open: boolean };
  // 系譜を読んだ回数（計画を作りに行った回数）。
  readonly graphReads: { count: number };
  readonly a: TestDevice;
  readonly b: TestDevice;
  readonly scopeA: string;
  readonly scopeB: string;
}

async function start(t: test.TestContext): Promise<Started> {
  const identity = await loadOrCreateTlsIdentity({
    dataDir: await tempDir(t, 'buddy-forget-route-tls-'),
    tlsKeyStore: createMockTlsKeyStore(),
    now: new Date(),
  });
  const store = await startTestStore(t);
  const env: Started['env'] = { lock: 'unlocked', home: true };
  const gate = { open: true };
  const graphReads = { count: 0 };
  // 記憶 MEMORY は発言 TURN から作った。同じ発言から作った指示が 2 件（1 件は別の鍵で封じてあり開けない）。
  const directives: ForgetDirectiveRow[] = [
    {
      directive_id: READABLE,
      scope: 'this_time',
      text: sealed(READABLE, READABLE_TEXT, KEY),
    },
    {
      directive_id: UNREADABLE,
      scope: 'from_now_on',
      text: sealed(UNREADABLE, '別の鍵の指示', OTHER_KEY),
    },
  ];
  const forgetStore = {
    memory: (op: MemoryOp) => {
      if (op.kind !== 'forget.graph')
        return Promise.resolve({
          ok: false,
          outcome: 'rejected',
          reasons: ['not_in_this_test'],
        });
      graphReads.count += 1;
      return Promise.resolve({
        ok: true,
        value: {
          graph: {
            edges: [
              {
                artifact: { kind: 'memory', id: MEMORY },
                source: { kind: 'turn', id: TURN },
              },
              {
                artifact: { kind: 'user_directive', id: READABLE },
                source: { kind: 'turn', id: TURN },
              },
              {
                artifact: { kind: 'user_directive', id: UNREADABLE },
                source: { kind: 'turn', id: TURN },
              },
            ],
            unattributed: [],
            turn_sessions: [],
            memories: [{ memory_id: MEMORY, dedupe_key: CONTENT_HMAC }],
            operations: [],
          },
          forgetting_generation: '4',
          target_exists: true,
          ledger_id: null,
          directives,
        },
      });
    },
  } as unknown as ForgetLedgerStore;
  const service = createForgetService({
    store: forgetStore,
    ledgerPath: '',
    gate: () => gate.open,
    sourceHmac: () => Promise.resolve(() => SOURCE_HMAC),
    dataKey: () => Promise.resolve(KEY),
    truncateLog: () => Promise.resolve(true),
    now: () => Date.parse('2031-03-04T05:06:07.000Z'),
  });
  const routes = createForgetRoutes({
    service,
    store: forgetStore as never,
  });
  const environment: RequestEnvironment = {
    homeNetwork: () => env.home,
    lockState: () => env.lock,
    hubLocal: () => false,
    audioOwner: () => 'none',
    revisionMatches: () => true,
    claimSecretMatches: () => false,
  };
  const api = createApiServer({
    host: '127.0.0.1',
    port: 0,
    identity,
    store,
    coreInstanceId: CORE_INSTANCE,
    environment,
    limits: { preAuthMaxRequests: 1000 },
    handlers: routes.handlers,
  });
  await api.listen();
  onCleanup(t, () => api.close(0));
  const target: PinnedTarget = {
    host: '127.0.0.1',
    port: api.port,
    certificatePem: identity.certificatePem,
    fingerprint: identity.fingerprint,
  };
  const a = await insertDevice(store, { name: '合成の端末 A' });
  const b = await insertDevice(store, { name: '合成の端末 B' });
  const scopeOf = async (device: TestDevice): Promise<string> => {
    const response = await pinnedRequest(target, {
      method: 'GET',
      path: '/v1/bootstrap',
      headers: { authorization: `Bearer ${device.token}` },
    });
    assert.equal(response.status, 200, response.text);
    return String(response.json?.['command_scope_id']);
  };
  return {
    target,
    env,
    gate,
    graphReads,
    a,
    b,
    scopeA: await scopeOf(a),
    scopeB: await scopeOf(b),
  };
}

function plan(
  started: Started,
  device: TestDevice | null,
  scope: string,
  headers: Readonly<Record<string, string>> = SCREEN,
): Promise<ApiResponse> {
  return pinnedRequest(started.target, {
    method: 'POST',
    path: '/v1/memory/forget-plans',
    headers: {
      'content-type': 'application/json',
      ...(device === null ? {} : { authorization: `Bearer ${device.token}` }),
      ...headers,
    },
    body: JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: scope,
      memory_id: MEMORY,
    }),
  });
}

test(
  'the plan route returns the directive texts only to an unlocked screen at home, and only the owner device executes it',
  { timeout: 30_000 },
  async (t) => {
    const s = await start(t);
    const made = await plan(s, s.a, s.scopeA);
    assert.equal(made.status, 200, made.text);
    assert(contract.valid('ForgetPlanView', made.json));
    const view = made.json as {
      plan_id: string;
      forgetting_generation: string;
      removed: Record<string, unknown>;
    };
    assert.deepEqual(view.removed, {
      counts: [
        { kind: 'memory', count: 1 },
        { kind: 'user_directive', count: 2 },
      ],
      memory_ids: [MEMORY],
      directives: [
        { directive_id: READABLE, scope: 'this_time', text: READABLE_TEXT },
        { directive_id: UNREADABLE, scope: 'from_now_on', text: null },
      ],
    });
    assert.equal(view.forgetting_generation, '4');
    // 元の発言の ID・台帳の HMAC・内容の HMAC・開けない指示の本文は返さない。
    for (const hidden of [TURN, SOURCE_HMAC, CONTENT_HMAC, '別の鍵の指示'])
      assert(!made.text.includes(hidden), hidden);
    assert.equal(s.graphReads.count, 1);

    // 計画を作る前に拒否する（系譜を読まない）。
    const refusals: [string, () => Promise<ApiResponse>, number, string][] = [
      ['no token', () => plan(s, null, s.scopeA), 401, 'unauthenticated'],
      [
        'voice origin',
        () => plan(s, s.a, s.scopeA, { 'buddy-input-origin': 'voice' }),
        403,
        'screen_operation_required',
      ],
      [
        'chat origin',
        () => plan(s, s.a, s.scopeA, { 'buddy-input-origin': 'chat' }),
        403,
        'screen_operation_required',
      ],
      ['no origin', () => plan(s, s.a, s.scopeA, {}), 422, 'invalid_input'],
    ];
    for (const [label, send, status, code] of refusals) {
      const refused = await send();
      assert.equal(refused.status, status, label);
      assert.equal(refused.json?.['code'], code, label);
      assert(!refused.text.includes(READABLE_TEXT), label);
    }
    for (const lock of ['locked', 'unknown'] as const) {
      s.env.lock = lock;
      const locked = await plan(s, s.a, s.scopeA);
      assert.equal(locked.status, 403, lock);
      assert.equal(locked.json?.['code'], 'device_locked', lock);
      assert(!locked.text.includes(READABLE_TEXT), lock);
    }
    s.env.lock = 'unlocked';
    s.env.home = false;
    const outside = await plan(s, s.a, s.scopeA);
    assert.equal(outside.status, 403);
    assert.equal(outside.json?.['code'], 'outside_home_network');
    s.env.home = true;
    assert.equal(s.graphReads.count, 1);

    // 別の端末は、端末 A の計画を実行できない（何も消さず、本文も返さない）。
    const stolen = await pinnedRequest(s.target, {
      method: 'POST',
      path: `/v1/memory/forget-plans/${view.plan_id}/execute`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.b.token}`,
        ...SCREEN,
      },
      body: JSON.stringify({
        request_id: randomUUID(),
        command_scope_id: s.scopeB,
        forgetting_generation: view.forgetting_generation,
      }),
    });
    assert.equal(stolen.status, 409, stolen.text);
    assert.equal(stolen.json?.['code'], 'conflict');
    assert(!stolen.text.includes(READABLE_TEXT));
    // 端末 A の接続範囲を端末 B が使っても、計画は作れない。
    const borrowed = await plan(s, s.b, s.scopeA);
    assert.equal(borrowed.status, 410, borrowed.text);
    assert.equal(borrowed.json?.['code'], 'expired_scope');
    assert(!borrowed.text.includes(READABLE_TEXT));
    assert.equal(s.graphReads.count, 1);

    // ゲートを閉じれば 503 で、系譜を読まない。
    s.gate.open = false;
    const closed = await plan(s, s.a, s.scopeA);
    assert.equal(closed.status, 503);
    assert.equal(closed.json?.['code'], 'dependency_unavailable');
    assert.equal(s.graphReads.count, 1);
  },
);
