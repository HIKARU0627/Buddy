// 予算の 4 経路（ADR 0034）は処理が未実装（B07-05 で足す）。Core の既定の構成（版の照合を注入しない
// startCore）で、認可の検査を通った要求は 503 で閉じ、版の不一致の 409 にならないことを確かめる。
// 認可の検査（接続範囲・ロック・画面操作）は先に効く。期待値（状態・コード）は試験に手で書いた値。
// 要求の本文とパスの値は契約 fixture（api-cases.json）の合成値を使う。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createApiServer } from './api-server.js';
import type { ApiServerOptions } from './api-server.js';
import { API_ROUTES, PENDING_ROUTE_IDS } from './api-routes.js';
import { pinnedRequest } from './api-test-support.js';
import {
  bearer,
  bootstrap,
  insertDevice,
  startEventCore,
} from './event-test-support.js';

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

const STALE_SCOPE = '00000000-0000-4000-8000-0000000000d1';

test('the pending routes are exactly the four budget routes', () => {
  assert.deepEqual([...PENDING_ROUTE_IDS].sort(), [
    'decideBudgetOverage',
    'getBudgetUsage',
    'reviewBudgetOverrun',
    'settleBudgetManually',
  ]);
});

test('a pending route cannot be given a handler', () => {
  assert.throws(
    () =>
      createApiServer({
        host: '127.0.0.1',
        port: 0,
        handlers: {
          settleBudgetManually: () =>
            Promise.resolve({ status: 200, body: {} }),
        },
      } as unknown as ApiServerOptions),
    /pending route has a handler: settleBudgetManually/u,
  );
});

test(
  'with the default Core environment the budget routes answer 503 after authorization, not 409',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t, { lockFromHeader: true });
    const device = await insertDevice(core.handle.store, { hubLocal: true });
    const scope = await bootstrap(core, device);
    const send = (
      operationId: string,
      options: {
        readonly scope?: string;
        readonly lock?: string;
        readonly origin?: string;
      } = {},
    ) => {
      const route = API_ROUTES.find((item) => item.operationId === operationId);
      assert(route, operationId);
      const fixture = fixtures.operations[operationId] ?? {};
      const path = route.path.replace(
        /\{([a-z_]+)\}/gu,
        (_all, name: string) => fixture.params?.[name] ?? '',
      );
      const headers: Record<string, string> = {
        ...bearer(device.token),
        'buddy-lock-state': options.lock ?? 'unlocked',
      };
      if (route.inputOrigin)
        headers['buddy-input-origin'] = options.origin ?? 'screen';
      if (route.body === null)
        return pinnedRequest(core.target, { method: 'GET', path, headers });
      headers['content-type'] = 'application/json';
      return pinnedRequest(core.target, {
        method: route.method,
        path,
        headers,
        body: JSON.stringify({
          ...fixture.request,
          command_scope_id: options.scope ?? scope,
        }),
      });
    };
    const expect = async (
      operationId: string,
      options: Parameters<typeof send>[1],
      status: number,
      code: string,
    ) => {
      const response = await send(operationId, options);
      assert.equal(response.status, status, `${operationId} ${response.text}`);
      assert.equal(response.json?.['code'], code, operationId);
    };

    for (const id of [
      'getBudgetUsage',
      'decideBudgetOverage',
      'reviewBudgetOverrun',
      'settleBudgetManually',
    ]) {
      // 認可を満たせば 503（版を照合する経路も、照合の先がないので 409 にしない）。
      await expect(id, {}, 503, 'dependency_unavailable');
      // ロック中は先に 403。
      await expect(id, { lock: 'locked' }, 403, 'device_locked');
    }
    for (const id of [
      'decideBudgetOverage',
      'reviewBudgetOverrun',
      'settleBudgetManually',
    ]) {
      // 古い接続範囲は 410、画面操作でなければ 403。
      await expect(id, { scope: STALE_SCOPE }, 410, 'expired_scope');
      await expect(id, { origin: 'voice' }, 403, 'screen_operation_required');
    }
    // 対照: 未実装でも pending の印のない、版を照合する経路は、既定の構成で版が合わず 409 のまま。
    await expect('disconnectConnection', {}, 409, 'conflict');
  },
);
