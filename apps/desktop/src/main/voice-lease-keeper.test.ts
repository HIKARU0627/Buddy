// 音声リースの heartbeat（B05-06、ADR 0050。設計 07 §5、10 §2・§2A）。手で進める時計と模擬の中枢の応答だけを使う。
// 期待値（時刻・nonce の連鎖・失う理由）は手で書く。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { LeaseRenewalResponseLike } from '@buddy/domain';
import {
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  VoiceLeaseKeeper,
  type LeaseLostReason,
  type LeaseRenewalBody,
} from './voice-lease-keeper.js';
import { ManualVoiceClock } from './voice-test-support.js';

type Answer = LeaseRenewalResponseLike | null | 'never' | 'throw';

function setup(
  answer: (body: LeaseRenewalBody, n: number) => Answer,
  delayMs: number | ((n: number) => number) = 10,
) {
  const clock = new ManualVoiceClock();
  const bodies: LeaseRenewalBody[] = [];
  const lost: LeaseLostReason[] = [];
  const io = { ioEpoch: '4', suspended: false };
  let context: {
    deviceId: string;
    coreInstanceId: string;
    commandScopeId: string;
  } | null = {
    deviceId: '00000000-0000-4000-8000-00000000d001',
    coreInstanceId: '00000000-0000-4000-8000-00000000c001',
    commandScopeId: '00000000-0000-4000-8000-00000000a001',
  };
  const keeper = new VoiceLeaseKeeper({
    port: {
      context: () => context,
      renew: (body) => {
        bodies.push(body);
        const value = answer(body, bodies.length);
        if (value === 'never') return new Promise(() => undefined);
        if (value === 'throw') return Promise.reject(new Error('network'));
        const wait =
          typeof delayMs === 'number' ? delayMs : delayMs(bodies.length);
        return new Promise((resolve) =>
          clock.setTimer(wait, () => resolve(value)),
        );
      },
    },
    clock: {
      mono: () => clock.mono,
      wall: () => clock.wall,
      setTimer: clock.setTimer,
      newId: clock.newId,
    },
    ioState: () => io,
    onLost: (reason) => lost.push(reason),
  });
  return {
    clock,
    keeper,
    bodies,
    lost,
    io,
    setContext: (value: typeof context) => {
      context = value;
    },
  };
}

const renewed = (
  body: LeaseRenewalBody,
  ttl = body.ttl_ms,
): LeaseRenewalResponseLike => ({
  request_id: body.request_id,
  lease_id: body.lease_id,
  nonce: body.nonce,
  result: 'renewed',
  ttl_ms: ttl,
});
const rejected = (body: LeaseRenewalBody): LeaseRenewalResponseLike => ({
  request_id: body.request_id,
  lease_id: body.lease_id,
  nonce: body.nonce,
  result: 'rejected',
  ttl_ms: null,
});

test('the first renewal carries a new lease id, no previous nonce, heartbeat 2 s and ttl 6 s', async () => {
  const s = setup((body) => renewed(body));
  const started = s.keeper.start();
  await s.clock.advance(10);
  assert.equal(await started, true);
  const first = s.bodies[0];
  assert.ok(first);
  assert.equal(first.kind, 'audio');
  assert.equal(first.previous_nonce, null);
  assert.equal(first.heartbeat_ms, 2000);
  assert.equal(first.ttl_ms, 6000);
  assert.equal(LEASE_HEARTBEAT_MS, 2000);
  assert.equal(LEASE_TTL_MS, 6000);
  assert.equal(first.io_epoch, '4');
  assert.equal(first.requested_at_mono_ms, 1000);
  // 期限は要求を送った時点（1000）から数える（応答の受信 1010 からではない）。
  assert.equal(s.keeper.held?.expires_at_mono_ms, 7000);
});

test('renewals continue every 2 s with a chained nonce and keep the lease alive', async () => {
  const s = setup((body) => renewed(body));
  const started = s.keeper.start();
  await s.clock.advance(10);
  await started;
  await s.clock.advance(2000);
  assert.equal(s.bodies.length, 2);
  assert.equal(s.bodies[1]?.requested_at_mono_ms, 3010);
  assert.equal(s.bodies[1]?.previous_nonce, s.bodies[0]?.nonce);
  await s.clock.advance(20_000);
  assert.ok(s.bodies.length >= 11);
  for (let i = 1; i < s.bodies.length; i += 1)
    assert.equal(s.bodies[i]?.previous_nonce, s.bodies[i - 1]?.nonce);
  assert.deepEqual(s.lost, []);
  assert.equal(s.keeper.active, true);
});

test('a rejection before the first lease means "cannot start" and is not reported as a loss', async () => {
  const s = setup((body) => rejected(body));
  const started = s.keeper.start();
  await s.clock.advance(10);
  assert.equal(await started, false);
  assert.deepEqual(s.lost, []);
  assert.equal(s.keeper.active, false);
  const none = setup((body) => renewed(body));
  none.setContext(null);
  assert.equal(await none.keeper.start(), false);
  assert.deepEqual(none.bodies, []);
});

test('a rejection during the lease is reported once as renewal_rejected and renewals stop', async () => {
  const s = setup((body, n) => (n === 1 ? renewed(body) : rejected(body)));
  const started = s.keeper.start();
  await s.clock.advance(10);
  await started;
  await s.clock.advance(2010);
  assert.deepEqual(s.lost, ['renewal_rejected']);
  await s.clock.advance(10_000);
  assert.equal(s.bodies.length, 2);
  assert.deepEqual(s.lost, ['renewal_rejected']);
});

test('unanswered renewals do not extend the lease: it expires exactly 6 s after the last accepted request', async () => {
  for (const missing of ['never', null, 'throw'] as const) {
    const s = setup((body, n) => (n === 1 ? renewed(body) : missing));
    const started = s.keeper.start();
    await s.clock.advance(10);
    await started;
    await s.clock.advance(7000 - 1 - s.clock.mono);
    assert.deepEqual(s.lost, [], String(missing));
    await s.clock.advance(1);
    assert.equal(s.clock.mono, 7000);
    assert.deepEqual(s.lost, ['expired'], String(missing));
  }
});

test('a renewal is counted from its request time; a response that arrives after expiry does not revive the lease', async () => {
  const s = setup((body) => renewed(body));
  const started = s.keeper.start();
  await s.clock.advance(10);
  await started;
  assert.equal(s.keeper.held?.expires_at_mono_ms, 7000);
  await s.clock.advance(2010);
  // 2 回目の要求（3010）+ 6000。応答の受信（3020）から足し直さない。
  assert.equal(s.keeper.held?.expires_at_mono_ms, 9010);
  // 2 回目の応答が 5 秒遅れる（3010 に送り 8010 に届く）: 1 回目の期限 7000 で失い、遅れた応答では戻らない。
  const late = setup(
    (body) => renewed(body),
    (n) => (n === 1 ? 10 : 5000),
  );
  const lateStarted = late.keeper.start();
  await late.clock.advance(10);
  await lateStarted;
  await late.clock.advance(7000 - late.clock.mono);
  assert.deepEqual(late.lost, ['expired']);
  await late.clock.advance(2000);
  assert.equal(late.keeper.held, null);
  assert.equal(late.keeper.active, false);
  assert.deepEqual(late.lost, ['expired']);
});

test('a response that does not match the pending request is not used', async () => {
  const s = setup((body, n) =>
    n === 1 ? renewed(body) : { ...renewed(body), nonce: 'other-nonce' },
  );
  const started = s.keeper.start();
  await s.clock.advance(10);
  await started;
  await s.clock.advance(2010);
  assert.equal(s.keeper.held?.expires_at_mono_ms, 7000);
  // 違う要求の拒否も拒否として扱わない。
  const t = setup((body, n) =>
    n === 1
      ? renewed(body)
      : {
          ...rejected(body),
          request_id: '00000000-0000-4000-8000-0000000000ff',
        },
  );
  const tStarted = t.keeper.start();
  await t.clock.advance(10);
  await tStarted;
  await t.clock.advance(2010);
  assert.deepEqual(t.lost, []);
});

test('a change of core instance or IO epoch while a renewal is pending makes the response unusable', async () => {
  const s = setup((body) => renewed(body), 100);
  const started = s.keeper.start();
  await s.clock.advance(100);
  await started;
  await s.clock.advance(2050);
  // 2 回目の要求を送った後に、中枢が再起動した。
  s.setContext({
    deviceId: '00000000-0000-4000-8000-00000000d001',
    coreInstanceId: '00000000-0000-4000-8000-00000000c002',
    commandScopeId: '00000000-0000-4000-8000-00000000a001',
  });
  await s.clock.advance(100);
  assert.equal(s.keeper.held?.expires_at_mono_ms, 7000);
});

test('a monotonic clock that goes back or jumps away from the wall clock discards the lease', async () => {
  const s = setup((body) => renewed(body));
  const started = s.keeper.start();
  await s.clock.advance(10);
  await started;
  // スリープ復帰の模型: 壁時計だけが 10 秒進んだ（単調時計との差が 1 秒の許容を超える）。
  s.clock.wall += 10_000;
  await s.clock.advance(2000);
  assert.deepEqual(s.lost, ['clock_unusable']);
});

test('stop() drops the pending renewal; its late response is ignored and nothing is reported', async () => {
  const s = setup((body) => renewed(body), 50);
  const started = s.keeper.start();
  await s.clock.advance(50);
  await started;
  await s.clock.advance(2010);
  s.keeper.stop();
  await s.clock.advance(10_000);
  assert.equal(s.bodies.length, 2);
  assert.deepEqual(s.lost, []);
  assert.equal(s.keeper.held, null);
});
