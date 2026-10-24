// 状態欄の音声の状態と、中枢との音声の経路（製品の起動では使えない・開発の模擬）（B05-06、ADR 0050）。期待値は手で書く。
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStatusBar, statusVoiceState } from './status-bar.js';
import { contract } from './voice-test-support.js';
import {
  mockVoiceCorePort,
  unavailableVoiceCorePort,
} from './voice-core-port.js';
import { suspendReasonFor } from './voice-controller.js';

const states = [
  {
    stopScope: 'none',
    voice: 'conversation_live',
    expected: 'conversation_live',
  },
  {
    stopScope: 'none',
    voice: 'waiting_wake_word',
    expected: 'waiting_wake_word',
  },
  { stopScope: 'none', voice: 'reading_aloud', expected: 'reading_aloud' },
  { stopScope: 'none', voice: null, expected: null },
  {
    stopScope: 'local',
    voice: 'conversation_live',
    expected: 'device_stopped',
  },
  {
    stopScope: 'guest',
    voice: 'conversation_live',
    expected: 'global_stopped',
  },
  { stopScope: 'global', voice: null, expected: 'global_stopped' },
] as const;

test('the status bar voice state follows the stop scope first, then the voice controller', () => {
  for (const entry of states) {
    const io = {
      lockState: 'unlocked',
      stopScope: entry.stopScope,
      ioEpoch: '3',
    } as const;
    const voice = { enabled: true, state: entry.voice };
    assert.equal(
      statusVoiceState(io, voice),
      entry.expected,
      JSON.stringify(entry),
    );
    const status = buildStatusBar(io, undefined, voice);
    assert.deepEqual(
      contract.statusBarErrors(status),
      [],
      JSON.stringify(entry),
    );
    // 音声を使わない組み立てでは、いつも null（音声機能がない）。
    assert.equal(
      statusVoiceState(io, { enabled: false, state: entry.voice }),
      null,
    );
  }
  // ロック中は状態欄の中身を出さない。
  assert.deepEqual(
    buildStatusBar(
      { lockState: 'locked', stopScope: 'local', ioEpoch: '3' },
      undefined,
      { enabled: true, state: 'conversation_live' },
    ),
    { visibility: 'hidden', lock_state: 'locked' },
  );
});

test('the suspend reason comes from the device state: lock first, then the hub stops, then the local stop', () => {
  assert.deepEqual(
    suspendReasonFor({
      lockState: 'locked',
      stopScope: 'global',
      ioEpoch: '1',
    }),
    { reason: 'os_lock', scope: 'local' },
  );
  assert.deepEqual(
    suspendReasonFor({
      lockState: 'unknown',
      stopScope: 'local',
      ioEpoch: '1',
    }),
    { reason: 'os_lock', scope: 'local' },
  );
  assert.deepEqual(
    suspendReasonFor({
      lockState: 'unlocked',
      stopScope: 'global',
      ioEpoch: '1',
    }),
    { reason: 'global_stop', scope: 'global' },
  );
  assert.deepEqual(
    suspendReasonFor({
      lockState: 'unlocked',
      stopScope: 'guest',
      ioEpoch: '1',
    }),
    { reason: 'guest_mode', scope: 'guest' },
  );
  assert.deepEqual(
    suspendReasonFor({
      lockState: 'unlocked',
      stopScope: 'local',
      ioEpoch: '1',
    }),
    { reason: 'device_io_stop', scope: 'local' },
  );
});

test('the product start has no voice route to the hub: no lease context, no renewal, every live session refused', async () => {
  const port = unavailableVoiceCorePort();
  assert.equal(port.context(), null);
  assert.equal(
    await port.renew({
      request_id: 'r',
      lease_id: 'l',
      kind: 'audio',
      device_id: 'd',
      core_instance_id: 'c',
      command_scope_id: 's',
      io_epoch: '0',
      nonce: 'n',
      previous_nonce: null,
      requested_at_mono_ms: 0,
      heartbeat_ms: 2000,
      ttl_ms: 6000,
    }),
    null,
  );
  assert.deepEqual(await port.openLive({ purpose: 'conversation' }), {
    kind: 'refused',
  });
});

test('the development mock hub echoes the lease request and issues newer epochs for each live session', async () => {
  let n = 0;
  const port = mockVoiceCorePort({
    newId: () =>
      `00000000-0000-4000-8000-${(n += 1).toString(16).padStart(12, '0')}`,
    delay: () => Promise.resolve(),
  });
  const context = port.context();
  assert.ok(context);
  const body = {
    request_id: '00000000-0000-4000-8000-0000000000a1',
    lease_id: '00000000-0000-4000-8000-0000000000a2',
    kind: 'audio' as const,
    device_id: context.deviceId,
    core_instance_id: context.coreInstanceId,
    command_scope_id: context.commandScopeId,
    io_epoch: '0',
    nonce: 'nonce-1',
    previous_nonce: null,
    requested_at_mono_ms: 10,
    heartbeat_ms: 2000,
    ttl_ms: 6000,
  };
  const response = await port.renew(body);
  assert.deepEqual(response, {
    request_id: body.request_id,
    lease_id: body.lease_id,
    nonce: 'nonce-1',
    result: 'renewed',
    reasons: [],
    ttl_ms: 6000,
  });
  assert.equal(contract.valid('LeaseRenewalResponse', response), true);
  assert.equal(contract.valid('LeaseRenewalRequest', body), true);
  const first = await port.openLive({ purpose: 'conversation' });
  const second = await port.openLive({ purpose: 'conversation' });
  assert.equal(first.kind === 'answer' && first.audioEpoch, '1');
  assert.equal(second.kind === 'answer' && second.audioEpoch, '2');
  assert.equal(second.kind === 'answer' && second.sessionEpoch, '2');
  port.closeLive('x', 'silence');
  assert.deepEqual(port.closed, [{ id: 'x', reason: 'silence' }]);
});
