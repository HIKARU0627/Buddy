// 表示のリースの保持（UI-05 の段階 4、ADR 0188）。手で進める時計と模擬の中枢の応答だけを使い、実時間を待たない。
// 期待値（送った時刻・期限・nonce の連鎖・状態の移り・取り直しの間隔）は手で書く。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISPLAY_LEASE_RETRY_MS,
  DisplayLeaseKeeper,
  type DisplayLeaseContext,
  type DisplayLeaseResponse,
  type DisplayLeaseState,
} from './display-lease-keeper.js';
import type { LeaseRenewalBody } from './voice-lease-keeper.js';
import { ManualVoiceClock } from './voice-test-support.js';

type Answer = DisplayLeaseResponse | null | 'never' | 'throw';

const CONTEXT: DisplayLeaseContext = {
  deviceId: '00000000-0000-4000-8000-00000000d001',
  coreInstanceId: '00000000-0000-4000-8000-00000000c001',
  commandScopeId: '00000000-0000-4000-8000-00000000a001',
  ioEpoch: '3',
};

function setup(answer: (body: LeaseRenewalBody, n: number) => Answer) {
  const clock = new ManualVoiceClock();
  const bodies: LeaseRenewalBody[] = [];
  // 送った時点の単調時計（取り直しの間隔を確かめる）。
  const sentAt: number[] = [];
  const states: DisplayLeaseState[] = [];
  const logs: string[] = [];
  let context: DisplayLeaseContext | null = CONTEXT;
  const keeper = new DisplayLeaseKeeper({
    port: {
      wanted: () => context,
      renew: (body) => {
        bodies.push(body);
        sentAt.push(clock.mono);
        const value = answer(body, bodies.length);
        if (value === 'never') return new Promise(() => undefined);
        if (value === 'throw') return Promise.reject(new Error('network'));
        return new Promise((resolve) =>
          clock.setTimer(10, () => resolve(value)),
        );
      },
    },
    clock: {
      mono: () => clock.mono,
      wall: () => clock.wall,
      setTimer: clock.setTimer,
      newId: clock.newId,
    },
    onChange: (state) => states.push(state),
    log: (code) => logs.push(code),
  });
  return {
    clock,
    keeper,
    bodies,
    sentAt,
    states,
    logs,
    setContext: (value: DisplayLeaseContext | null) => {
      context = value;
    },
  };
}

const renewed = (body: LeaseRenewalBody): DisplayLeaseResponse => ({
  request_id: body.request_id,
  lease_id: body.lease_id,
  nonce: body.nonce,
  result: 'renewed',
  reasons: [],
  ttl_ms: body.ttl_ms,
});
const rejected = (
  body: LeaseRenewalBody,
  reasons: string[] = ['io_suspended'],
): DisplayLeaseResponse => ({
  request_id: body.request_id,
  lease_id: body.lease_id,
  nonce: body.nonce,
  result: 'rejected',
  reasons,
  ttl_ms: null,
});

test('nothing is sent while the conditions are not met; the first lease is a display lease with a new id and the core io epoch', async () => {
  const s = setup((body) => renewed(body));
  s.setContext(null);
  s.keeper.update();
  await s.clock.advance(20_000);
  assert.equal(s.bodies.length, 0);
  assert.equal(s.keeper.state, 'idle');
  assert.deepEqual(s.states, []);

  s.setContext(CONTEXT);
  s.keeper.update();
  assert.equal(s.keeper.state, 'acquiring');
  // 同じ条件で何度呼んでも、取りに行くのは 1 回だけ。
  s.keeper.update();
  await s.clock.advance(10);
  assert.equal(s.bodies.length, 1);
  const first = s.bodies[0];
  assert.ok(first);
  assert.equal(first.kind, 'display');
  assert.equal(first.lease_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(first.previous_nonce, null);
  assert.equal(first.device_id, CONTEXT.deviceId);
  assert.equal(first.core_instance_id, CONTEXT.coreInstanceId);
  assert.equal(first.command_scope_id, CONTEXT.commandScopeId);
  // 中枢が持つ入出力の世代（端末の世代ではない）。
  assert.equal(first.io_epoch, '3');
  assert.equal(first.heartbeat_ms, 2000);
  assert.equal(first.ttl_ms, 6000);
  assert.equal(first.requested_at_mono_ms, 21_000);
  assert.equal(s.keeper.state, 'held');
  // 期限は要求を送った時点（21000）から数える（応答の受信 21010 からではない）。
  assert.equal(s.keeper.held?.expires_at_mono_ms, 27_000);
  assert.deepEqual(s.states, ['acquiring', 'held']);
});

test('the lease is renewed every 2 s, before it runs out, with a chained nonce on the same lease id', async () => {
  const s = setup((body) => renewed(body));
  s.keeper.update();
  await s.clock.advance(10);
  await s.clock.advance(2000);
  assert.equal(s.bodies.length, 2);
  assert.equal(s.bodies[1]?.requested_at_mono_ms, 3010);
  assert.equal(s.bodies[1]?.lease_id, s.bodies[0]?.lease_id);
  assert.equal(s.bodies[1]?.previous_nonce, s.bodies[0]?.nonce);
  // 2 回目の更新を送ったのは、1 回目の期限（7000）より前。応答を受けたら、期限は 2 回目を送った時点から数え直す。
  assert.equal(s.keeper.held?.expires_at_mono_ms, 7000);
  await s.clock.advance(10);
  assert.equal(s.keeper.held?.expires_at_mono_ms, 9010);
  await s.clock.advance(20_000);
  assert.equal(s.bodies.length, 12);
  // 最初の取得（1000）の応答を受けた 1010 から 2 秒ごと（3010・5010…）。
  for (let i = 1; i < s.bodies.length; i += 1) {
    assert.equal(s.bodies[i]?.previous_nonce, s.bodies[i - 1]?.nonce);
    assert.equal(s.bodies[i]?.requested_at_mono_ms, 1010 + 2000 * i);
  }
  assert.equal(s.keeper.state, 'held');
  assert.deepEqual(s.states, ['acquiring', 'held']);
});

test('renewals stop when the window hides, the device locks or stops, or the link drops; showing again takes a new lease', async () => {
  const s = setup((body) => renewed(body));
  s.keeper.update();
  await s.clock.advance(10);
  await s.clock.advance(2000);
  assert.equal(s.bodies.length, 2);
  // 隠れた・ロック・停止・切断は、どれも呼び出し側の条件（wanted）が null になること。
  s.setContext(null);
  s.keeper.update();
  assert.equal(s.keeper.state, 'idle');
  assert.equal(s.keeper.held, null);
  // 待っていた更新の応答・予約していた更新は使わない。
  await s.clock.advance(30_000);
  assert.equal(s.bodies.length, 2);
  assert.deepEqual(s.states, ['acquiring', 'held', 'idle']);
  // 見えたら新しい lease_id で、前の nonce を持たずに取り直す。
  s.setContext(CONTEXT);
  s.keeper.update();
  await s.clock.advance(10);
  assert.equal(s.bodies.length, 3);
  assert.notEqual(s.bodies[2]?.lease_id, s.bodies[0]?.lease_id);
  assert.equal(s.bodies[2]?.previous_nonce, null);
  assert.deepEqual(s.states, [
    'acquiring',
    'held',
    'idle',
    'acquiring',
    'held',
  ]);
  // 終了でも止まる。
  s.keeper.stop();
  await s.clock.advance(10_000);
  assert.equal(s.bodies.length, 3);
  assert.equal(s.keeper.state, 'idle');
});

test('a rejection while held loses the lease at once; it is taken again with a new id after 2 s and the state returns to held', async () => {
  const s = setup((body, n) => (n === 2 ? rejected(body) : renewed(body)));
  s.keeper.update();
  await s.clock.advance(10);
  await s.clock.advance(2000);
  assert.equal(s.keeper.state, 'held');
  await s.clock.advance(10);
  // 2 回目（3010 に送った）の拒否を 3020 に受けた。
  assert.equal(s.keeper.state, 'lost');
  assert.equal(s.keeper.held, null);
  assert.deepEqual(s.states, ['acquiring', 'held', 'lost']);
  assert(s.logs.includes('display_lease_lost:renewal_rejected'));
  await s.clock.advance(1999);
  assert.equal(s.bodies.length, 2);
  await s.clock.advance(1);
  assert.equal(s.bodies.length, 3);
  assert.equal(s.sentAt[2], 5020);
  assert.notEqual(s.bodies[2]?.lease_id, s.bodies[0]?.lease_id);
  assert.equal(s.bodies[2]?.previous_nonce, null);
  await s.clock.advance(10);
  assert.equal(s.keeper.state, 'held');
  assert.deepEqual(s.states, ['acquiring', 'held', 'lost', 'held']);
});

test('repeated failures keep the lease lost and retry at 2, 4, 8, 16 and then every 30 s', async () => {
  const s = setup((body) => rejected(body, ['stale_io_epoch']));
  s.keeper.update();
  await s.clock.advance(10);
  assert.equal(s.keeper.state, 'lost');
  await s.clock.advance(120_000);
  // 1000 に最初の取得、拒否を 1010 に受け、その後は受けた時点から 2・4・8・16・30・30・30 秒。
  assert.deepEqual(
    s.sentAt,
    [1000, 3010, 7020, 15_030, 31_040, 61_050, 91_060],
  );
  assert.deepEqual(DISPLAY_LEASE_RETRY_MS, [2000, 4000, 8000, 16_000, 30_000]);
  // 失ったことは 1 回だけ知らせる（取り直しの失敗ごとに状態を出し直さない）。
  assert.deepEqual(s.states, ['acquiring', 'lost']);
  // 毎回、新しい lease_id。
  assert.equal(new Set(s.bodies.map((body) => body.lease_id)).size, 7);
  // 条件が外れたら取り直しもやめ、失った印も消す。
  s.setContext(null);
  s.keeper.update();
  await s.clock.advance(120_000);
  assert.equal(s.bodies.length, 7);
  assert.deepEqual(s.states, ['acquiring', 'lost', 'idle']);
});

test('when renewals go unanswered the lease runs out at its expiry and is lost', async () => {
  const s = setup((body, n) => (n === 1 ? renewed(body) : 'never'));
  s.keeper.update();
  await s.clock.advance(10);
  assert.equal(s.keeper.held?.expires_at_mono_ms, 7000);
  // 3010 に送った更新に答えがない（待っている間は重ねて送らない）。
  await s.clock.advance(5989);
  assert.equal(s.clock.mono, 6999);
  assert.equal(s.keeper.state, 'held');
  assert.equal(s.bodies.length, 2);
  await s.clock.advance(1);
  assert.equal(s.keeper.state, 'lost');
  assert(s.logs.includes('display_lease_lost:expired'));
});

test('an unknown answer to the first request, or a thrown error, is a loss; while held it only waits for the expiry', async () => {
  const unknown = setup(() => null);
  unknown.keeper.update();
  await unknown.clock.advance(10);
  assert.equal(unknown.keeper.state, 'lost');
  assert(unknown.logs.includes('display_lease_lost:outcome_unknown'));
  const thrown = setup(() => 'throw');
  thrown.keeper.update();
  await thrown.clock.advance(0);
  assert.equal(thrown.keeper.state, 'lost');
  // 持っている間の結果の分からない更新では延ばさず、期限（7000）まで持つ。
  const held = setup((body, n) => (n === 1 ? renewed(body) : null));
  held.keeper.update();
  await held.clock.advance(10);
  await held.clock.advance(2000);
  assert.equal(held.keeper.state, 'held');
  assert.equal(held.keeper.held?.expires_at_mono_ms, 7000);
  await held.clock.advance(3990);
  assert.equal(held.clock.mono, 7000);
  assert.equal(held.keeper.state, 'lost');
});

test('the renewal limit or a nonce mismatch takes a new lease id once while the current lease keeps the canvas drawn', async () => {
  const s = setup((body, n) =>
    n === 2 ? rejected(body, ['lease_rotation_required']) : renewed(body),
  );
  s.keeper.update();
  await s.clock.advance(10);
  await s.clock.advance(2000);
  await s.clock.advance(20);
  assert.equal(s.bodies.length, 3);
  // 拒否を受けた 3020 に、新しい lease_id で前の nonce を持たずに取り直す。
  assert.equal(s.sentAt[2], 3020);
  assert.notEqual(s.bodies[2]?.lease_id, s.bodies[0]?.lease_id);
  assert.equal(s.bodies[2]?.previous_nonce, null);
  assert.equal(s.keeper.state, 'held');
  assert.equal(s.keeper.held?.lease_id, s.bodies[2]?.lease_id);
  assert.deepEqual(s.states, ['acquiring', 'held']);
  // 以後は新しいリースで続ける。
  await s.clock.advance(2000);
  assert.equal(s.bodies[3]?.lease_id, s.bodies[2]?.lease_id);
  assert.equal(s.bodies[3]?.previous_nonce, s.bodies[2]?.nonce);

  // 取り直しも拒否されたら失う（取り直しを続けない）。
  const twice = setup((body, n) =>
    n === 1 ? renewed(body) : rejected(body, ['nonce_replayed']),
  );
  twice.keeper.update();
  await twice.clock.advance(10);
  await twice.clock.advance(2000);
  await twice.clock.advance(20);
  assert.equal(twice.bodies.length, 3);
  assert.equal(twice.keeper.state, 'lost');
  assert.deepEqual(twice.states, ['acquiring', 'held', 'lost']);
});

test('an answer for another request is not used, and a new scope or core io epoch takes a new lease', async () => {
  const s = setup((body, n) =>
    n === 1 ? { ...renewed(body), nonce: 'other-nonce' } : renewed(body),
  );
  s.keeper.update();
  await s.clock.advance(10);
  // 違う nonce の成功は使わない（最初の取得で使えなければ取れなかった）。
  assert.equal(s.keeper.state, 'lost');
  await s.clock.advance(2010);
  assert.equal(s.keeper.state, 'held');
  const leaseId = s.keeper.leaseId;
  // 接続し直して接続範囲と中枢の世代が変わった: 前のリースを捨てて取り直す。
  s.setContext({
    ...CONTEXT,
    commandScopeId: '00000000-0000-4000-8000-00000000a002',
    ioEpoch: '4',
  });
  s.keeper.update();
  assert.equal(s.keeper.state, 'acquiring');
  await s.clock.advance(10);
  const last = s.bodies.at(-1);
  assert.notEqual(last?.lease_id, leaseId);
  assert.equal(last?.command_scope_id, '00000000-0000-4000-8000-00000000a002');
  assert.equal(last?.io_epoch, '4');
  assert.equal(last?.previous_nonce, null);
  assert.equal(s.keeper.state, 'held');
});
