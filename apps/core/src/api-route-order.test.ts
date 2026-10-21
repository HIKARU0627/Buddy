// 登録した全経路の検査の順が domain の ROUTE_CHECKS と一致することを、HTTPS の要求で確かめる（ADR 0020）。
//
// 経路ごとに、検査を一つずつ満たさない要求と、二つずつ満たさない要求（全部の組）を実際に送り、
// 返る拒否が「表の順で最初に満たさない検査」の拒否であることを確かめる。二つずつの組で、どの二つの検査も
// 表の順に優先されることが分かる（実行時の順が表と同じ）。経路にない検査を満たさなくても拒否しないことも確かめる。
// 検査を満たさない状態は、端末トークン（送らない）・接続範囲（古い ID）・Buddy-Input-Origin（voice）は
// 実際の要求で、判定の元がまだない文脈（自宅判定・ロック状態など）は注入した環境で作る。
// 拒否の期待値（HTTP の状態・コード）は試験に手で書き、admitRequest から作らない。
// 要求の本文・パスの値は契約 fixture（api-cases.json）の合成値を使う。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ROUTE_CHECKS } from '@buddy/domain';
import type { CoreCheck } from '@buddy/domain';
import { createMockTlsKeyStore } from '@buddy/platform';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';
import { createApiServer } from './api-server.js';
import { API_ROUTES } from './api-routes.js';
import type { ApiRoute } from './api-routes.js';
import {
  insertDevice,
  onCleanup,
  withTimeout,
  pinnedCheck,
  pinnedRequest,
  startTestStore,
  tempDir,
} from './api-test-support.js';
import type { PinnedTarget } from './api-test-support.js';
import { loadOrCreateTlsIdentity } from './tls-identity.js';

const REJECTION: Readonly<Record<CoreCheck, readonly [number, string]>> = {
  device_token: [401, 'unauthenticated'],
  claim_secret: [401, 'unauthenticated'],
  home_network: [403, 'outside_home_network'],
  command_scope: [410, 'expired_scope'],
  unlocked: [403, 'device_locked'],
  screen_operation: [403, 'screen_operation_required'],
  hub_screen: [403, 'hub_screen_required'],
  audio_owner: [403, 'audio_ownership_required'],
  expected_revision: [409, 'conflict'],
};
const ALL_CHECKS = Object.keys(REJECTION) as CoreCheck[];

interface FixtureEntry {
  readonly params?: Readonly<Record<string, string>>;
  readonly request?: Readonly<Record<string, unknown>>;
}

const fixtures = JSON.parse(
  await readFile(
    new URL(
      '../../../packages/contracts/fixtures/api-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { operations: Readonly<Record<string, FixtureEntry>> };

type Outcome =
  | {
      readonly kind: 'http';
      readonly status: number;
      readonly code: string | null;
    }
  | { readonly kind: 'upgraded'; readonly closeCode: number };

test(
  'every registered route applies its checks in the ROUTE_CHECKS order at run time',
  { timeout: 120_000 },
  async (t) => {
    // 経路の表と ROUTE_CHECKS の経路の集まりが同じ（表にない経路を登録していない・登録漏れがない）。
    assert.deepEqual(
      API_ROUTES.map((route) => route.operationId).sort(),
      Object.keys(ROUTE_CHECKS).sort(),
    );

    const dir = await tempDir(t, 'buddy-route-order-');
    const identity = await loadOrCreateTlsIdentity({
      dataDir: dir,
      tlsKeyStore: createMockTlsKeyStore(),
      now: new Date(),
    });
    const store = await startTestStore(t);
    const { token } = await insertDevice(store);
    let failing = new Set<CoreCheck>();
    const api = createApiServer({
      host: '127.0.0.1',
      port: 0,
      identity,
      store,
      coreInstanceId: '00000000-0000-4000-8000-0000000000c1',
      // 認証前の要求も同じ端末の要求も多く送るので、頻度の上限を試験の間だけ上げる。
      limits: { preAuthMaxRequests: 100_000, deviceMaxRequests: 100_000 },
      environment: {
        homeNetwork: () => !failing.has('home_network'),
        lockState: () => (failing.has('unlocked') ? 'locked' : 'unlocked'),
        hubLocal: () => !failing.has('hub_screen'),
        audioOwner: () => (failing.has('audio_owner') ? 'none' : 'self'),
        revisionMatches: () => !failing.has('expected_revision'),
        claimSecretMatches: () => !failing.has('claim_secret'),
      },
    });
    await api.listen();
    onCleanup(t, () => api.close(0));
    const target: PinnedTarget = {
      host: '127.0.0.1',
      port: api.port,
      certificatePem: identity.certificatePem,
      fingerprint: identity.fingerprint,
    };

    // 今の接続範囲。getBootstrap が通るたびに新しい接続範囲になる（古いものは無効）。
    let currentScope: string | null = null;
    const STALE_SCOPE = '00000000-0000-4000-8000-0000000000d1';

    const send = async (route: ApiRoute): Promise<Outcome> => {
      const fixture = fixtures.operations[route.operationId] ?? {};
      let path = route.path.replace(
        /\{([a-z_]+)\}/gu,
        (_all, name: string) => fixture.params?.[name] ?? '',
      );
      if (route.query['cursor'] !== undefined)
        path += `?cursor=${encodeURIComponent(fixture.params?.['cursor'] ?? '')}`;
      const headers: Record<string, string> = {};
      if (!failing.has('device_token'))
        headers['authorization'] = `Bearer ${token}`;
      if (route.inputOrigin)
        headers['buddy-input-origin'] = failing.has('screen_operation')
          ? 'voice'
          : 'screen';
      if (route.websocket) {
        return withTimeout(
          new Promise<Outcome>((resolve, reject) => {
            const socket = new WebSocket(`wss://127.0.0.1:${api.port}${path}`, {
              headers,
              ca: [identity.certificatePem],
              // ws は tls.connect へそのまま渡す（Node の checkServerIdentity は Error か undefined を返す）。
              checkServerIdentity: pinnedCheck(
                identity.fingerprint,
              ) as unknown as ClientOptions['checkServerIdentity'],
              minVersion: 'TLSv1.3',
            });
            socket.on('unexpected-response', (request, response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () => {
                const body = JSON.parse(
                  Buffer.concat(chunks).toString('utf8'),
                ) as {
                  code?: string;
                };
                resolve({
                  kind: 'http',
                  status: response.statusCode ?? 0,
                  code: body.code ?? null,
                });
                request.destroy();
              });
            });
            socket.on('close', (code) =>
              resolve({ kind: 'upgraded', closeCode: code }),
            );
            socket.on('error', (error) => {
              if (socket.readyState !== WebSocket.CLOSED) reject(error);
            });
          }),
          10_000,
          `${route.operationId} upgrade`,
        );
      }
      let body: string | undefined;
      if (route.body !== null) {
        const request: Record<string, unknown> = { ...fixture.request };
        if ('command_scope_id' in request)
          request['command_scope_id'] = failing.has('command_scope')
            ? STALE_SCOPE
            : (currentScope ?? STALE_SCOPE);
        body = JSON.stringify(request);
        headers['content-type'] = 'application/json';
      }
      const response = await pinnedRequest(target, {
        method: route.method,
        path,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      if (route.operationId === 'getBootstrap' && response.status === 200)
        currentScope = String(response.json?.['command_scope_id']);
      return {
        kind: 'http',
        status: response.status,
        code:
          typeof response.json?.['code'] === 'string'
            ? response.json['code']
            : null,
      };
    };

    // 検査をすべて満たしたときの結果。getBootstrap は 200、WebSocket は切り替えた後に 1013 で閉じ、
    // B03-01 で作らない経路は 503（dependency_unavailable）。
    const passed = (route: ApiRoute): Outcome =>
      route.websocket
        ? { kind: 'upgraded', closeCode: 1013 }
        : route.operationId === 'getBootstrap'
          ? { kind: 'http', status: 200, code: null }
          : { kind: 'http', status: 503, code: 'dependency_unavailable' };

    // 接続範囲を一つ発行しておく。
    failing = new Set();
    const bootstrap = API_ROUTES.find(
      (route) => route.operationId === 'getBootstrap',
    );
    assert(bootstrap);
    assert.deepEqual(await send(bootstrap), passed(bootstrap));
    assert.notEqual(currentScope, null);

    let requests = 0;
    for (const route of API_ROUTES) {
      const checks = ROUTE_CHECKS[route.operationId] ?? [];
      const id = route.operationId;
      // 全部を満たす。
      failing = new Set();
      assert.deepEqual(await send(route), passed(route), `${id} all pass`);
      // 経路にない検査をすべて満たさなくても、拒否しない。
      failing = new Set(ALL_CHECKS.filter((check) => !checks.includes(check)));
      assert.deepEqual(
        await send(route),
        passed(route),
        `${id} other checks fail`,
      );
      requests += 2;
      // 一つずつ・二つずつ満たさない。期待値は表の順で最初の検査の拒否。
      for (let i = 0; i < checks.length; i += 1) {
        for (let j = i; j < checks.length; j += 1) {
          const first = checks[i] as CoreCheck;
          const second = checks[j] as CoreCheck;
          failing = new Set([first, second]);
          const [status, code] = REJECTION[first];
          assert.deepEqual(
            await send(route),
            { kind: 'http', status, code },
            `${id} fails ${first}${first === second ? '' : ` and ${second}`}`,
          );
          requests += 1;
        }
      }
    }
    // すべての要求が中枢に届いている（ピン留めの照合に通った接続の上で送った）。
    assert(api.requestsReceived >= requests);
  },
);
