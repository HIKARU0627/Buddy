// 中枢への要求の組み立て（bootstrap・接続範囲・再送の規則）の試験。期待値は手で書く。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoreClient } from './core-client.js';
import type {
  CoreTransport,
  CoreTransportOutcome,
  CoreTransportRequest,
} from './core-transport.js';

const SCOPE = 'scope-1';
const BOOTSTRAP_OK: CoreTransportOutcome = {
  kind: 'response',
  status: 200,
  body: {
    command_scope_id: SCOPE,
    command_scope_expires_at: '2030-10-09T04:00:00Z',
  },
};

function mockTransport(outcomes: readonly CoreTransportOutcome[]) {
  const requests: CoreTransportRequest[] = [];
  const queue = [...outcomes];
  const transport: CoreTransport = {
    request: async (request) => {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error('no scripted outcome');
      return next;
    },
    fetchPeerCertificate: async () => ({
      kind: 'unreachable',
      reason: 'not_used',
    }),
  };
  return { transport, requests };
}

let idCounter = 0;
const newRequestId = () => `req-${(idCounter += 1)}`;
const NOW = Date.parse('2030-10-09T03:00:00Z');

test('a command bootstraps once and injects request_id and command_scope_id', async () => {
  idCounter = 0;
  const ok: CoreTransportOutcome = { kind: 'response', status: 200, body: {} };
  const { transport, requests } = mockTransport([BOOTSTRAP_OK, ok, ok]);
  const client = createCoreClient({
    transport,
    deviceToken: 'device-token',
    newRequestId,
    now: () => NOW,
  });
  await client.command('POST', '/v1/candidates/c-1/state', {
    event: 'dismiss',
    expected_state: 'new',
    snooze_until: null,
  });
  await client.command('POST', '/v1/candidates/c-2/state', {
    event: 'open',
    expected_state: 'new',
    snooze_until: null,
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.path, '/v1/bootstrap');
  assert.equal(requests[0]?.deviceToken, 'device-token');
  assert.deepEqual(requests[1]?.body, {
    event: 'dismiss',
    expected_state: 'new',
    snooze_until: null,
    request_id: 'req-1',
    command_scope_id: SCOPE,
  });
  assert.deepEqual(requests[2]?.body, {
    event: 'open',
    expected_state: 'new',
    snooze_until: null,
    request_id: 'req-2',
    command_scope_id: SCOPE,
  });
  // ロック状態の申告は認証した要求に付ける。起点は指定した経路だけ。
  assert.equal(requests[1]?.lockState, 'unlocked');
  assert.equal(requests[1]?.inputOrigin, undefined);
});

test('the chat origin is passed only when the caller asks for it', async () => {
  const ok: CoreTransportOutcome = { kind: 'response', status: 200, body: {} };
  const { transport, requests } = mockTransport([BOOTSTRAP_OK, ok]);
  const client = createCoreClient({
    transport,
    deviceToken: 'device-token',
    newRequestId,
    now: () => NOW,
  });
  await client.command(
    'POST',
    '/v1/candidates/c-1/state',
    { event: 'open', expected_state: 'new', snooze_until: null },
    { inputOrigin: 'chat' },
  );
  assert.equal(requests[1]?.inputOrigin, 'chat');
});

test('an expired scope is refreshed once and the command resent with a new request_id', async () => {
  idCounter = 0;
  const expired: CoreTransportOutcome = {
    kind: 'response',
    status: 410,
    body: { code: 'expired_scope' },
  };
  const ok: CoreTransportOutcome = {
    kind: 'response',
    status: 200,
    body: { done: true },
  };
  const { transport, requests } = mockTransport([
    BOOTSTRAP_OK,
    expired,
    BOOTSTRAP_OK,
    ok,
  ]);
  const client = createCoreClient({
    transport,
    deviceToken: 'device-token',
    newRequestId,
    now: () => NOW,
  });
  const outcome = await client.command('POST', '/v1/sessions', {
    storage_mode: 'normal',
  });
  assert.deepEqual(outcome, ok);
  assert.equal(
    requests.filter((request) => request.path === '/v1/bootstrap').length,
    2,
  );
  const sends = requests.filter((request) => request.path === '/v1/sessions');
  assert.equal(sends.length, 2);
  assert.equal(sends[0]?.body?.['request_id'], 'req-1');
  assert.equal(sends[1]?.body?.['request_id'], 'req-2');
});

test('an unreachable command is not resent (the outcome is unknown)', async () => {
  const down: CoreTransportOutcome = {
    kind: 'unreachable',
    reason: 'ECONNREFUSED',
  };
  const { transport, requests } = mockTransport([BOOTSTRAP_OK, down]);
  const client = createCoreClient({
    transport,
    deviceToken: 'device-token',
    newRequestId,
    now: () => NOW,
  });
  const outcome = await client.command('POST', '/v1/sessions', {
    storage_mode: 'normal',
  });
  assert.deepEqual(outcome, down);
  assert.equal(
    requests.filter((request) => request.path === '/v1/sessions').length,
    1,
  );
});

test('without a device token, commands fail locally and nothing is sent', async () => {
  const { transport, requests } = mockTransport([]);
  const client = createCoreClient({
    transport,
    deviceToken: null,
    newRequestId,
    now: () => NOW,
  });
  const outcome = await client.command('POST', '/v1/sessions', {
    storage_mode: 'normal',
  });
  assert.deepEqual(outcome, {
    kind: 'unreachable',
    reason: 'device_not_paired',
  });
  assert.equal(requests.length, 0);
});

test('a scope past its expiry is bootstrapped again before the next command', async () => {
  const ok: CoreTransportOutcome = { kind: 'response', status: 200, body: {} };
  const { transport, requests } = mockTransport([
    BOOTSTRAP_OK,
    ok,
    BOOTSTRAP_OK,
    ok,
  ]);
  let nowMs = NOW;
  const client = createCoreClient({
    transport,
    deviceToken: 'device-token',
    newRequestId,
    now: () => nowMs,
  });
  await client.command('POST', '/v1/sessions', { storage_mode: 'normal' });
  nowMs = Date.parse('2030-10-09T04:00:00Z'); // ちょうど期限。期限の前だけ使う。
  await client.command('POST', '/v1/sessions', { storage_mode: 'normal' });
  assert.equal(
    requests.filter((request) => request.path === '/v1/bootstrap').length,
    2,
  );
});
