// Muse 向けの窓口の試験（認証・経路の絞り込み・中継・調べ物の会話の持ち回し）。期待値は手で書く。
import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeTokenHash, emptyConfig } from './config.js';
import type { BridgeConfig } from './config.js';
import type { CoreClient, CoreClientOutcome } from './core-client.js';
import { createBridgeServer } from './server.js';
import type { AuditEntry } from './server.js';

const TOKEN = 'bridge-token-for-server-tests-000000000001';

interface RecordedCall {
  readonly kind: 'read' | 'command' | 'preAuth';
  readonly method: string;
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly inputOrigin?: string;
}

function mockClient(handler: (call: RecordedCall) => CoreClientOutcome): {
  client: CoreClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: CoreClient = {
    read: async (path) => {
      const call: RecordedCall = { kind: 'read', method: 'GET', path };
      calls.push(call);
      return handler(call);
    },
    command: async (method, path, body, options) => {
      const call: RecordedCall = {
        kind: 'command',
        method,
        path,
        body,
        ...(options?.inputOrigin === undefined
          ? {}
          : { inputOrigin: options.inputOrigin }),
      };
      calls.push(call);
      return handler(call);
    },
    preAuth: async (method, path, body) => {
      const call: RecordedCall = { kind: 'preAuth', method, path, body };
      calls.push(call);
      return handler(call);
    },
  };
  return { client, calls };
}

const config: BridgeConfig = {
  ...emptyConfig(),
  bridgeTokenHash: bridgeTokenHash(TOKEN),
  listen: { host: '127.0.0.1', port: 0 },
};

async function withServer(
  handler: (call: RecordedCall) => CoreClientOutcome,
  body: (
    base: string,
    calls: RecordedCall[],
    audit: AuditEntry[],
  ) => Promise<void>,
): Promise<void> {
  const { client, calls } = mockClient(handler);
  const audit: AuditEntry[] = [];
  const server = createBridgeServer({
    config,
    client,
    audit: (entry) => audit.push(entry),
    now: () => new Date('2030-10-09T03:00:00Z'),
  });
  await server.listen();
  try {
    await body(`http://127.0.0.1:${server.port}`, calls, audit);
  } finally {
    await server.close();
  }
}

const auth = { authorization: `Bearer ${TOKEN}` };
const jsonHeaders = { ...auth, 'content-type': 'application/json' };

const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

test('health needs no token; other routes reject a missing or wrong token', async () => {
  await withServer(
    () => ({ kind: 'response', status: 200, body: { candidates: [] } }),
    async (base, calls) => {
      const health = await fetch(`${base}/bridge/v1/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok' });

      const noToken = await fetch(`${base}/bridge/v1/candidates`);
      assert.equal(noToken.status, 401);
      assert.equal((await bodyOf(noToken))['code'], 'unauthenticated');

      const wrong = await fetch(`${base}/bridge/v1/candidates`, {
        headers: { authorization: 'Bearer not-the-token' },
      });
      assert.equal(wrong.status, 401);
      assert.equal(calls.length, 0);
    },
  );
});

test('the candidate list is relayed as-is from Core', async () => {
  await withServer(
    () => ({
      kind: 'response',
      status: 200,
      body: { candidates: [{ candidate_id: 'c-1' }], counts: { new: 1 } },
    }),
    async (base, calls) => {
      const response = await fetch(`${base}/bridge/v1/candidates`, {
        headers: auth,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        candidates: [{ candidate_id: 'c-1' }],
        counts: { new: 1 },
      });
      assert.deepEqual(calls, [
        { kind: 'read', method: 'GET', path: '/v1/candidates' },
      ]);
    },
  );
});

test('routes outside the v1 scope do not exist and never reach Core', async () => {
  await withServer(
    () => ({ kind: 'response', status: 200, body: {} }),
    async (base, calls) => {
      for (const path of [
        '/bridge/v1/operations/op-1/approve',
        '/bridge/v1/pairing/claims',
        '/bridge/v1/devices',
        '/bridge/v1/connections/oauth/start',
        '/bridge/v1/live/sessions',
      ]) {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: jsonHeaders,
          body: '{}',
        });
        assert.equal(response.status, 404, path);
        assert.equal((await bodyOf(response))['code'], 'not_found');
      }
      assert.equal(calls.length, 0);
    },
  );
});

test('a candidate state change is relayed with the chat origin', async () => {
  await withServer(
    () => ({
      kind: 'response',
      status: 200,
      body: { candidate_id: 'c-1', state: 'dismissed' },
    }),
    async (base, calls) => {
      const response = await fetch(`${base}/bridge/v1/candidates/c-1/state`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          event: 'dismiss',
          expected_state: 'new',
          snooze_until: null,
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        candidate_id: 'c-1',
        state: 'dismissed',
      });
      assert.deepEqual(calls, [
        {
          kind: 'command',
          method: 'POST',
          path: '/v1/candidates/c-1/state',
          body: { event: 'dismiss', expected_state: 'new', snooze_until: null },
          inputOrigin: 'chat',
        },
      ]);
    },
  );
});

test('a malformed state change is rejected by the bridge before Core', async () => {
  await withServer(
    () => ({ kind: 'response', status: 200, body: {} }),
    async (base, calls) => {
      const response = await fetch(`${base}/bridge/v1/candidates/c-1/state`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ event: 'dismiss' }),
      });
      assert.equal(response.status, 422);
      assert.equal((await bodyOf(response))['code'], 'invalid_input');
      assert.equal(calls.length, 0);
    },
  );
});

test('research creates one session, reuses it, and returns the background acceptance', async () => {
  await withServer(
    (call) => {
      if (call.path === '/v1/sessions')
        return {
          kind: 'response',
          status: 201,
          body: { session_id: 's-1', segment_generation: '3' },
        };
      return {
        kind: 'response',
        status: 200,
        body: {
          status: 'background',
          workflow_id: 'w-1',
          reply_text: '受け付けました。終わったら知らせます。',
        },
      };
    },
    async (base, calls) => {
      const first = await fetch(`${base}/bridge/v1/research`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ text: '蔵書の数を調べて' }),
      });
      assert.equal(first.status, 200);
      assert.equal((await bodyOf(first))['status'], 'background');
      const second = await fetch(`${base}/bridge/v1/research`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ text: 'もう一つ調べて' }),
      });
      assert.equal(second.status, 200);
      const sessions = calls.filter((call) => call.path === '/v1/sessions');
      assert.equal(sessions.length, 1);
      const turns = calls.filter(
        (call) => call.path === '/v1/sessions/s-1/turns',
      );
      assert.equal(turns.length, 2);
      assert.deepEqual(turns[0]?.body, {
        text: '蔵書の数を調べて',
        input_kind: 'text',
        origin: { segment_id: 's-1', segment_generation: '3' },
      });
    },
  );
});

test('a research turn conflicted by a moved segment recreates the session once', async () => {
  let sessionCount = 0;
  await withServer(
    (call) => {
      if (call.path === '/v1/sessions') {
        sessionCount += 1;
        return {
          kind: 'response',
          status: 201,
          body: {
            session_id: `s-${sessionCount}`,
            segment_generation: String(sessionCount),
          },
        };
      }
      if (call.path === '/v1/sessions/s-1/turns')
        return { kind: 'response', status: 409, body: { code: 'conflict' } };
      return { kind: 'response', status: 200, body: { status: 'answered' } };
    },
    async (base) => {
      const response = await fetch(`${base}/bridge/v1/research`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ text: '調べて' }),
      });
      assert.equal(response.status, 200);
      assert.equal(sessionCount, 2);
    },
  );
});

test('events require a cursor and pass it to Core', async () => {
  await withServer(
    () => ({
      kind: 'response',
      status: 200,
      body: { events: [], event_cursor: 'cur-2', resnapshot_required: false },
    }),
    async (base, calls) => {
      const missing = await fetch(`${base}/bridge/v1/events`, {
        headers: auth,
      });
      assert.equal(missing.status, 422);
      const ok = await fetch(`${base}/bridge/v1/events?cursor=cur-1`, {
        headers: auth,
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(calls, [
        { kind: 'read', method: 'GET', path: '/v1/events?cursor=cur-1' },
      ]);
    },
  );
});

test('an unreachable Core becomes a bridge 503 with a code only', async () => {
  await withServer(
    () => ({ kind: 'unreachable', reason: 'ECONNREFUSED' }),
    async (base) => {
      const response = await fetch(`${base}/bridge/v1/snapshot`, {
        headers: auth,
      });
      assert.equal(response.status, 503);
      const body = await bodyOf(response);
      assert.equal(body['code'], 'core_unreachable');
    },
  );
});

test('the audit log records route names and statuses, never tokens or bodies', async () => {
  await withServer(
    (call) =>
      call.path === '/v1/sessions'
        ? {
            kind: 'response',
            status: 201,
            body: { session_id: 's-1', segment_generation: '1' },
          }
        : { kind: 'response', status: 200, body: { status: 'answered' } },
    async (base, _calls, audit) => {
      await fetch(`${base}/bridge/v1/research`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ text: '秘密の調べ物テキスト' }),
      });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.route, 'research');
      assert.equal(audit[0]?.status, 200);
      const serialized = JSON.stringify(audit);
      assert.equal(serialized.includes(TOKEN), false);
      assert.equal(serialized.includes('秘密の調べ物テキスト'), false);
    },
  );
});
