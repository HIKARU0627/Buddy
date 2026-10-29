// main の音声の制御（B05-06、ADR 0050。設計 10 §1・§1A・§2・§3、09 X13・X30・QA43・T04 の模擬）。
// 模擬のレンダラー（合成の PCM）・端末状態・手で進める時計・端末の中の模擬の中枢だけを使う。Electron・実際の音声・
// マイク・WebRTC・実 API は使わない。期待値（時刻・世代・理由）は手で書き、実装から作らない。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopVoiceView } from '@buddy/contracts';
import { NO_FAULTS, type MockFaults } from './voice-mock-renderer.js';
import { voiceHarness, type HarnessOptions } from './voice-test-support.js';
import type { LocalVoiceConsent } from './voice-consent.js';
import { notifyVoiceDeviceChanged } from './voice-controller.js';

const GRANTED: LocalVoiceConsent = {
  kind: 'voice_live_audio',
  provider: 'openai_live',
  policy_version: '1',
  state: 'granted',
  method: 'os_dialog_main',
  confirmed_at: '2030-10-04T00:00:00.000Z',
  revoked_at: null,
};
const ID = '5d0e3c1a-7b2f-4a6e-8c9d-0e1f2a3b4c5d';
const FOCUSED = { trustedSender: true, windowFocused: true };
const BACKGROUND = { trustedSender: true, windowFocused: false };
const UNTRUSTED = { trustedSender: false, windowFocused: true };

const faults = (value: Partial<MockFaults>): MockFaults => ({
  ...NO_FAULTS,
  ...value,
});

type Harness = ReturnType<typeof voiceHarness>;

// ロック解除を確かめ、音声レンダラーの読み込みを待つ。
async function ready(h: Harness): Promise<void> {
  h.unlock();
  await h.clock.advance(10);
}

// 「続ける」で会話を始め、開始の ACK まで待つ（同意は済み）。
async function live(h: Harness): Promise<void> {
  await ready(h);
  const result = h.voice.continueConversation();
  await h.clock.advance(100);
  assert.equal(await result, 'ok');
  await h.clock.advance(100);
}

const lastSent = (h: Harness) => h.sent.at(-1);
const mock = (h: Harness) => {
  const slot = h.current();
  assert.ok(slot);
  return slot.mock;
};
const shown = (view: DesktopVoiceView) => {
  assert.equal(view.visibility, 'shown');
  return view as Extract<DesktopVoiceView, { visibility: 'shown' }>;
};
const statusVoice = (h: Harness) => {
  const status = h.device.statusBar;
  return status.visibility === 'shown' ? status.voice_state : 'hidden';
};
const granted = (extra: HarnessOptions = {}) =>
  voiceHarness({ consent: GRANTED, ...extra });

// 「続ける」を待っている間にリースを失い、もう一度「続ける」を押した組み立て（Issue #162）。
// 1 回目の接続の答えは 3 秒後に届き、2 回目のリースは受け付ける。
async function supersededContinue() {
  let calls = 0;
  const h = granted({
    openMs: 3000,
    renew: (body) => {
      calls += 1;
      return calls === 2
        ? {
            request_id: body.request_id,
            lease_id: body.lease_id,
            nonce: body.nonce,
            result: 'rejected',
            ttl_ms: null,
          }
        : {
            request_id: body.request_id,
            lease_id: body.lease_id,
            nonce: body.nonce,
            result: 'renewed',
            ttl_ms: body.ttl_ms,
          };
    },
  });
  await ready(h);
  const first = h.voice.continueConversation();
  await h.clock.advance(2100);
  // 1 回目のリースは拒否され、待っている手順は捨てられた。
  assert.equal(h.voice.leaseActive, false);
  const second = h.voice.continueConversation();
  await h.clock.advance(20);
  // 2 回目のリースは受け付けられた。
  assert.equal(h.voice.leaseActive, true);
  return { h, first, second };
}

test('the renderer is prepared only after the lock is confirmed open; nothing is shown before', async () => {
  const h = granted();
  // 起動直後はロック状態が分からない: 音声レンダラーを作らず、音声の状態を隠す。
  assert.deepEqual(h.voice.view(), { visibility: 'hidden' });
  assert.equal(h.slots.length, 0);
  h.unlock();
  assert.equal(h.slots.length, 1);
  // 読み込みが終わるまでは音声の状態がない（「続ける」は押せない）。
  assert.deepEqual(h.voice.view(), {
    visibility: 'shown',
    voice_state: null,
    external_send: false,
    consent: 'granted',
    can_continue: false,
    notice: null,
  });
  assert.equal(await h.voice.continueConversation(), 'voice_unavailable');
  await h.clock.advance(5);
  assert.deepEqual(h.voice.view(), {
    visibility: 'shown',
    voice_state: 'waiting_wake_word',
    external_send: false,
    consent: 'granted',
    can_continue: true,
    notice: null,
  });
  assert.equal(statusVoice(h), 'waiting_wake_word');
  // 用意しただけでは収音も送信も始めない（命令を送っていない）。
  assert.deepEqual(h.sentChannels(), []);
  assert.equal(mock(h).stats.capturing, false);
});

test('continue opens a conversation: lease, live session and start with the issued epochs; the external mark comes first', async () => {
  const h = granted();
  await ready(h);
  const result = h.voice.continueConversation();
  // 始めている途中は「続ける」を押せず、まだ送っていない。
  assert.equal(shown(h.voice.view()).can_continue, false);
  assert.equal(shown(h.voice.view()).external_send, false);
  await h.clock.advance(10);
  assert.equal(h.renewals.length, 1);
  assert.equal(h.renewals[0]?.kind, 'audio');
  assert.equal(h.renewals[0]?.previous_nonce, null);
  assert.equal(h.renewals[0]?.heartbeat_ms, 2000);
  assert.equal(h.renewals[0]?.ttl_ms, 6000);
  assert.equal(h.opens.length, 1);
  await h.clock.advance(50);
  assert.equal(await result, 'ok');
  // 開始の命令を出した時点で、ACK の前から「音声を外部へ送っている」を出す。
  const start = lastSent(h)?.request;
  assert.equal(start?.['channel'], 'voice.start');
  assert.equal(start?.['ack_timeout_ms'], 3000);
  assert.deepEqual(
    {
      ...(start?.['payload'] as Record<string, unknown>),
      live_session_id: 'x',
    },
    {
      live_session_id: 'x',
      purpose: 'conversation',
      sdp_answer: 'v=0\r\ns=buddy-test\r\n',
      io_epoch: '0',
      audio_epoch: '1',
      output_epoch: '0',
      session_epoch: '1',
    },
  );
  assert.equal(h.voice.externalSend, true);
  assert.equal(shown(h.voice.view()).external_send, true);
  assert.equal(shown(h.voice.view()).voice_state, 'conversation_live');
  assert.equal(statusVoice(h), 'conversation_live');
  await h.clock.advance(2);
  // 模擬のレンダラーは会話中: 合成の PCM を収音し、外部へ送った数が増える。
  await h.clock.advance(200);
  assert.equal(mock(h).stats.live, true);
  assert.ok(mock(h).stats.sentFrames >= 9);
  assert.ok(mock(h).stats.ringFrames >= 9);
});

test('X13/QA43: an OS lock suspends IO at once; after the ACK nothing more is sent, and unlocking does not resume', async () => {
  const h = granted();
  await live(h);
  const t0 = h.clock.mono;
  h.device.recordOsEvent('lock_screen');
  // ロックはこの端末の停止（io_epoch 0 → 1）と suspend_io（os_lock）。出力の世代も進める（0 → 1）。
  const suspend = lastSent(h);
  assert.equal(suspend?.at, t0);
  assert.deepEqual(suspend?.request['payload'], {
    reason: 'os_lock',
    scope: 'local',
    io_epoch: '1',
    audio_epoch: '1',
    output_epoch: '1',
  });
  assert.equal(suspend?.request['ack_timeout_ms'], 300);
  // 第 3 層の起点: 中枢へ閉じる要求を送り、リースの更新をやめる。
  assert.equal(h.closed.at(-1)?.reason, 'os_lock');
  assert.equal(h.voice.leaseActive, false);
  assert.deepEqual(h.voice.view(), { visibility: 'hidden' });
  await h.clock.advance(1);
  // 第 1 層: ACK を待たずに、送信・収音を止め、リングを消した。
  assert.equal(mock(h).stats.sending, false);
  assert.equal(mock(h).stats.capturing, false);
  assert.equal(mock(h).stats.ringFrames, 0);
  const frames = mock(h).stats.sentFrames;
  // 印は ACK を受けるまで消さない。
  assert.equal(h.voice.externalSend, true);
  await h.clock.advance(1);
  assert.equal(h.voice.externalSend, false);
  await h.clock.advance(5000);
  // suspend_io の後の音声の送信は 0。強制終了もしていない。
  assert.equal(mock(h).stats.sentFrames, frames);
  assert.deepEqual(h.kills, []);
  // 解除しても自動で再開しない（この端末の停止のまま）。
  h.device.recordOsEvent('unlock_screen');
  assert.deepEqual(h.voice.view(), {
    visibility: 'shown',
    voice_state: 'device_stopped',
    external_send: false,
    consent: 'granted',
    can_continue: false,
    notice: null,
  });
  assert.equal(statusVoice(h), 'device_stopped');
  assert.equal(await h.voice.continueConversation(), 'input_stopped');
  // 画面で明示再開しても、呼びかけ待ちに戻るだけで会話は始めない。
  const resumed = h.device.handleIpc(
    'desktop.io_resume',
    {
      channel: 'desktop.io_resume',
      request_id: ID,
      payload: { expected_io_epoch: '1' },
    },
    FOCUSED,
  );
  assert.equal(resumed.response.outcome, 'ok');
  await h.clock.advance(1000);
  assert.equal(shown(h.voice.view()).voice_state, 'waiting_wake_word');
  assert.deepEqual(
    h.sentChannels().filter((channel) => channel === 'voice.start'),
    ['voice.start'],
  );
  assert.equal(mock(h).stats.sentFrames, frames);
  assert.equal(h.voice.generation, 1);
});

test('X30/T04: a suspend ACK at exactly 300 ms is in time; at 301 ms the renderer is killed and the late ACK is not used', async () => {
  // 片道の IPC は 1 ms。ACK の遅延 298 ms → main に 300 ms で届く。299 ms → 301 ms。
  for (const [delay, killed] of [
    [298, false],
    [299, true],
  ] as const) {
    const h = granted({ faults: [faults({ delayMs: delay })] });
    await live(h);
    const t0 = h.clock.mono;
    h.device.stopFromMain();
    assert.equal(lastSent(h)?.request['channel'], 'voice.suspend_io');
    assert.equal(
      (lastSent(h)?.request['payload'] as Record<string, unknown>)['reason'],
      'device_io_stop',
    );
    await h.clock.advance(300);
    assert.equal(h.clock.mono, t0 + 300);
    assert.deepEqual(h.kills, [], `${delay}: not killed at 300 ms`);
    await h.clock.advance(1);
    assert.deepEqual(h.kills, killed ? [1] : [], `${delay}`);
    assert.equal(h.voice.externalSend, false);
    assert.equal(h.voice.rendererAlive, !killed);
    if (killed)
      assert.ok(h.logs.includes('voice_ack_missing:voice.suspend_io'));
  }
});

test('X30: a renderer that hangs on suspend keeps sending until main kills it at 301 ms; then sending stops for good', async () => {
  const h = granted({ faults: [faults({ hangOn: 'voice.suspend_io' })] });
  await live(h);
  const t0 = h.clock.mono;
  h.device.stopFromMain();
  await h.clock.advance(1);
  assert.equal(mock(h).stats.hung, true);
  const atHang = mock(h).stats.sentFrames;
  await h.clock.advance(299);
  // 固まった音声レンダラーは送信を止められない（WebRTC は別のスレッド）。強制終了までは印を出したまま。
  assert.ok(mock(h).stats.sentFrames > atHang);
  assert.equal(h.voice.externalSend, true);
  assert.equal(shown(h.voice.view()).external_send, true);
  assert.deepEqual(h.kills, []);
  await h.clock.advance(1);
  assert.equal(h.clock.mono, t0 + 301);
  assert.deepEqual(h.kills, [1]);
  assert.equal(h.voice.externalSend, false);
  // 窓を壊したときにその場で届く閉じた出来事は、二重に扱わない。
  assert.deepEqual(
    h.logs.filter((code) => code.startsWith('voice_renderer_killed')),
    ['voice_renderer_killed:ack_missing:voice.suspend_io'],
  );
  assert.ok(!h.logs.includes('voice_renderer_gone:closed'));
  const atKill = mock(h).stats.sentFrames;
  await h.clock.advance(5000);
  assert.equal(mock(h).stats.sentFrames, atKill);
  assert.deepEqual(h.voice.view(), {
    visibility: 'shown',
    voice_state: 'device_stopped',
    external_send: false,
    consent: 'granted',
    can_continue: false,
    notice: null,
  });
  // 前の音声レンダラーから遅れて届く ACK は使わない。
  h.voice.receiveAck(1, {
    request_id: String(lastSent(h)?.request['request_id']),
    channel: 'voice.suspend_io',
    outcome: 'applied',
    io_epoch: '1',
    audio_epoch: '1',
    output_epoch: '1',
    session_epoch: '1',
    acked_at: '2030-10-05T00:00:01.000Z',
  });
  assert.ok(h.logs.includes('voice_ack_from_old_renderer'));
  // 画面で明示再開すると新しい音声レンダラーを用意する（会話は始めない）。
  h.device.handleIpc(
    'desktop.io_resume',
    {
      channel: 'desktop.io_resume',
      request_id: ID,
      payload: { expected_io_epoch: '1' },
    },
    FOCUSED,
  );
  assert.equal(h.voice.generation, 2);
  await h.clock.advance(10);
  assert.equal(shown(h.voice.view()).voice_state, 'waiting_wake_word');
  assert.ok(!h.sent.some((entry) => entry.generation === 2));
});

test('a dropped suspend ACK stops locally at once but still kills at 301 ms; a failed ACK kills without waiting', async () => {
  const dropped = granted({
    faults: [faults({ dropAck: ['voice.suspend_io'] })],
  });
  await live(dropped);
  const t0 = dropped.clock.mono;
  dropped.device.stopFromMain();
  await dropped.clock.advance(1);
  const frames = mock(dropped).stats.sentFrames;
  assert.equal(mock(dropped).stats.sending, false);
  await dropped.clock.advance(299);
  assert.deepEqual(dropped.kills, []);
  await dropped.clock.advance(1);
  assert.equal(dropped.clock.mono, t0 + 301);
  assert.deepEqual(dropped.kills, [1]);
  assert.equal(mock(dropped).stats.sentFrames, frames);

  const failed = granted({ faults: [faults({ fail: ['voice.suspend_io'] })] });
  await live(failed);
  const t1 = failed.clock.mono;
  failed.device.stopFromMain();
  await failed.clock.advance(2);
  // 適用に失敗した ACK（2 ms で届く）: 期限を待たずに強制終了する。
  assert.equal(failed.clock.mono, t1 + 2);
  assert.deepEqual(failed.kills, [1]);
  assert.ok(failed.logs.includes('voice_ack_missing:voice.suspend_io'));
});

test('QA43: a missing stop_playback ACK escalates to a full stop and tells the screen the input was interrupted', async () => {
  const h = granted({ faults: [faults({ dropAck: ['voice.stop_playback'] })] });
  await live(h);
  const t0 = h.clock.mono;
  h.voice.stopPlayback('user_stop');
  assert.deepEqual(lastSent(h)?.request['payload'], {
    reason: 'user_stop',
    scope: null,
    io_epoch: '0',
    audio_epoch: '1',
    output_epoch: '1',
  });
  await h.clock.advance(1);
  // 再生だけを止め、会話は続ける（送信は止めない）。
  assert.equal(mock(h).stats.live, true);
  assert.equal(mock(h).stats.sending, true);
  await h.clock.advance(299);
  assert.equal(h.device.state.stopScope, 'none');
  await h.clock.advance(1);
  assert.equal(h.clock.mono, t0 + 301);
  // 全停止: この端末の停止（io_epoch 0 → 1）と suspend_io（device_io_stop）。
  assert.equal(h.device.state.stopScope, 'local');
  assert.equal(lastSent(h)?.at, t0 + 301);
  assert.deepEqual(lastSent(h)?.request['payload'], {
    reason: 'device_io_stop',
    scope: 'local',
    io_epoch: '1',
    audio_epoch: '1',
    output_epoch: '2',
  });
  assert.equal(shown(h.voice.view()).notice, 'input_interrupted');
  await h.clock.advance(2);
  // suspend_io の ACK は返る（この故障は再生停止の ACK だけ）。強制終了はしない。
  assert.deepEqual(h.kills, []);
  assert.equal(mock(h).stats.sending, false);
  assert.equal(h.voice.externalSend, false);
});

test('a renderer that hangs on stop_playback is stopped in two steps: full stop at 301 ms, kill at 602 ms', async () => {
  const h = granted({ faults: [faults({ hangOn: 'voice.stop_playback' })] });
  await live(h);
  const t0 = h.clock.mono;
  h.voice.stopPlayback('barge_in');
  await h.clock.advance(301);
  assert.equal(h.device.state.stopScope, 'local');
  assert.equal(lastSent(h)?.request['channel'], 'voice.suspend_io');
  assert.deepEqual(h.kills, []);
  await h.clock.advance(300);
  assert.deepEqual(h.kills, []);
  await h.clock.advance(1);
  assert.equal(h.clock.mono, t0 + 602);
  assert.deepEqual(h.kills, [1]);
  const frames = mock(h).stats.sentFrames;
  await h.clock.advance(1000);
  assert.equal(mock(h).stats.sentFrames, frames);
});

test('an ACK of an older request that arrives after a newer stop is not used and does not escalate', async () => {
  const h = granted({ faults: [faults({ delayMs: 250 })] });
  await live(h);
  const t0 = h.clock.mono;
  h.voice.stopPlayback('user_stop');
  await h.clock.advance(100);
  h.device.recordOsEvent('lock_screen');
  // 再生停止の要求は世代が古くなったので待ちから外れた。suspend_io だけを待つ。
  assert.deepEqual(h.voice.pendingChannels, ['voice.suspend_io']);
  await h.clock.advance(152);
  assert.equal(h.clock.mono, t0 + 252);
  assert.ok(h.logs.includes('voice_ack_ignored:no_pending_request'));
  await h.clock.advance(100);
  // suspend_io の ACK（ロックから 252 ms）は間に合い、再生停止の ACK がないことで全停止へ上げない。
  assert.deepEqual(h.kills, []);
  assert.equal(h.voice.externalSend, false);
  await h.clock.advance(1000);
  assert.equal(h.device.state.lockState, 'locked');
  assert.ok(!h.logs.some((code) => code.startsWith('voice_ack_missing')));
});

test('forged or mismatched ACKs are ignored: unknown request, regressed epoch, wrong shape', async () => {
  const h = granted({ faults: [faults({ dropAck: ['voice.suspend_io'] })] });
  await live(h);
  h.device.stopFromMain();
  const suspend = lastSent(h)?.request;
  const base = {
    request_id: String(suspend?.['request_id']),
    channel: 'voice.suspend_io',
    outcome: 'applied',
    io_epoch: '1',
    audio_epoch: '1',
    output_epoch: '1',
    session_epoch: '1',
    acked_at: '2030-10-05T00:00:01.000Z',
  };
  h.voice.receiveAck(1, { ...base, request_id: ID });
  h.voice.receiveAck(1, { ...base, output_epoch: '0' });
  h.voice.receiveAck(1, { ...base, token: 'x' });
  h.voice.receiveAck(1, { ...base, channel: 'voice.get_device_token' });
  assert.ok(h.logs.includes('voice_ack_ignored:no_pending_request'));
  assert.ok(
    h.logs.includes('voice_ack_ignored:epoch_regressed+request_epoch_stale') ||
      h.logs.some((code) =>
        code.startsWith('voice_ack_ignored:epoch_regressed'),
      ),
  );
  assert.equal(h.logs.filter((code) => code === 'voice_ack_invalid').length, 2);
  // どれも停止の完了として使わない: 期限で強制終了する。
  await h.clock.advance(301);
  assert.deepEqual(h.kills, [1]);
});

test('a missing start ACK closes the session after 3001 ms (the renderer had applied it)', async () => {
  const h = granted({ faults: [faults({ dropAck: ['voice.start'] })] });
  await ready(h);
  const result = h.voice.continueConversation();
  await h.clock.advance(60);
  assert.equal(await result, 'ok');
  const t0 = lastSent(h)?.at ?? 0;
  assert.equal(lastSent(h)?.request['channel'], 'voice.start');
  await h.clock.advance(t0 + 3000 - h.clock.mono);
  assert.equal(lastSent(h)?.request['channel'], 'voice.start');
  await h.clock.advance(1);
  assert.equal(lastSent(h)?.request['channel'], 'voice.close_voice_session');
  assert.deepEqual(lastSent(h)?.request['payload'], {
    reason: 'provider_failure',
    scope: null,
    io_epoch: '0',
    audio_epoch: '1',
    output_epoch: '1',
  });
  assert.equal(h.closed.at(-1)?.reason, 'provider_failure');
  assert.equal(h.voice.externalSend, true);
  await h.clock.advance(2);
  assert.equal(h.voice.externalSend, false);
  assert.equal(mock(h).stats.sending, false);
  assert.equal(shown(h.voice.view()).can_continue, true);
});

test('a missing close ACK kills the renderer and stops the device (all stop)', async () => {
  const h = granted({
    faults: [faults({ dropAck: ['voice.close_voice_session'] })],
  });
  await live(h);
  const t0 = h.clock.mono;
  h.voice.closeConversation('conversation_ended');
  await h.clock.advance(1500);
  assert.deepEqual(h.kills, []);
  await h.clock.advance(1);
  assert.equal(h.clock.mono, t0 + 1501);
  assert.deepEqual(h.kills, [1]);
  assert.equal(h.device.state.stopScope, 'local');
  assert.equal(shown(h.voice.view()).voice_state, 'device_stopped');
});

test('consent is asked once with the OS dialog; declining sends nothing; revoking closes the conversation at once', async () => {
  const h = voiceHarness({ dialog: [false, 'not_shown', true] });
  await ready(h);
  assert.equal(shown(h.voice.view()).consent, 'required');
  assert.equal(await h.voice.continueConversation(), 'confirmation_declined');
  assert.equal(
    await h.voice.continueConversation(),
    'screen_operation_required',
  );
  assert.equal(h.dialogs.length, 2);
  assert.deepEqual(h.renewals, []);
  assert.deepEqual(h.opens, []);
  assert.deepEqual(h.sentChannels(), []);
  assert.equal(h.consentRecord(), null);
  const result = h.voice.continueConversation();
  await h.clock.advance(100);
  assert.equal(await result, 'ok');
  assert.equal(h.dialogs.length, 3);
  assert.equal(h.consentRecord()?.state, 'granted');
  assert.equal(h.consentRecord()?.method, 'os_dialog_main');
  assert.equal(shown(h.voice.view()).consent, 'granted');
  // 会話を終えて、もう一度「続ける」: 同意は済んでいるので確認を出さない。
  await h.clock.advance(10);
  h.voice.closeConversation('conversation_ended');
  await h.clock.advance(10);
  const again = h.voice.continueConversation();
  await h.clock.advance(100);
  assert.equal(await again, 'ok');
  assert.equal(h.dialogs.length, 3);
  await h.clock.advance(10);
  // 取り消し: 確認なしで、開いている会話を consent_revoked で閉じる。
  h.voice.revokeConsent();
  assert.equal(h.consentRecord()?.state, 'revoked');
  assert.equal(lastSent(h)?.request['channel'], 'voice.close_voice_session');
  assert.equal(
    (lastSent(h)?.request['payload'] as Record<string, unknown>)['reason'],
    'consent_revoked',
  );
  assert.equal(h.closed.at(-1)?.reason, 'consent_revoked');
  assert.equal(h.voice.leaseActive, false);
  await h.clock.advance(5);
  assert.equal(mock(h).stats.sending, false);
  assert.equal(shown(h.voice.view()).consent, 'required');
  // 取り消した後は、もう一度確認する（答えがなければ「やめる」）。
  assert.equal(await h.voice.continueConversation(), 'confirmation_declined');
  assert.equal(h.dialogs.length, 4);
});

test('stopping or locking while the consent dialog or the connection is pending starts nothing', async () => {
  const h = voiceHarness({ dialog: [true], dialogMs: 100 });
  await ready(h);
  const result = h.voice.continueConversation();
  await h.clock.advance(50);
  h.device.stopFromMain();
  // 出している確認を閉じる。
  assert.equal(h.cancelled.length, 1);
  await h.clock.advance(100);
  assert.equal(await result, 'input_stopped');
  assert.equal(h.consentRecord(), null);
  assert.deepEqual(h.renewals, []);

  const g = granted({ openMs: 100 });
  await ready(g);
  const pending = g.voice.continueConversation();
  await g.clock.advance(30);
  assert.equal(g.opens.length, 1);
  g.device.recordOsEvent('lock_screen');
  await g.clock.advance(100);
  assert.equal(await pending, 'input_stopped');
  // 中枢が開いた接続は閉じ、音声レンダラーへは渡さない。
  assert.equal(g.closed.at(-1)?.reason, 'os_lock');
  assert.ok(!g.sentChannels().includes('voice.start'));
});

test('an answer whose audio epoch is not newer than the last one is not given to the renderer', async () => {
  const h = granted({
    open: () => ({
      kind: 'answer',
      liveSessionId: '00000000-0000-4000-8000-0000000000aa',
      sdpAnswer: 'v=0\r\n',
      audioEpoch: '1',
      sessionEpoch: '1',
    }),
  });
  await live(h);
  h.voice.closeConversation('conversation_ended');
  await h.clock.advance(10);
  const result = h.voice.continueConversation();
  await h.clock.advance(100);
  assert.equal(await result, 'voice_unavailable');
  assert.equal(h.closed.at(-1)?.reason, 'provider_failure');
  assert.equal(
    h.sentChannels().filter((channel) => channel === 'voice.start').length,
    1,
  );
});

test('the lease is renewed every 2 s with a chained nonce while the conversation lasts', async () => {
  const h = granted();
  await live(h);
  const first = h.renewals[0];
  assert.ok(first);
  await h.clock.advance(first.requested_at_mono_ms + 10 + 2000 - h.clock.mono);
  assert.equal(h.renewals.length, 2);
  assert.equal(h.renewals[1]?.previous_nonce, first.nonce);
  assert.equal(h.renewals[1]?.lease_id, first.lease_id);
  assert.notEqual(h.renewals[1]?.nonce, first.nonce);
  await h.clock.advance(2010);
  assert.equal(h.renewals.length, 3);
  assert.equal(h.renewals[2]?.previous_nonce, h.renewals[1]?.nonce);
  assert.equal(h.voice.leaseActive, true);
  // 会話を閉じたら更新をやめる。
  h.voice.closeConversation('silence');
  await h.clock.advance(10_000);
  assert.equal(h.renewals.length, 3);
});

test('a rejected renewal during the conversation suspends IO with core_lease_lost', async () => {
  let calls = 0;
  const h = granted({
    renew: (body) => {
      calls += 1;
      return calls === 1
        ? {
            request_id: body.request_id,
            lease_id: body.lease_id,
            nonce: body.nonce,
            result: 'renewed',
            ttl_ms: body.ttl_ms,
          }
        : {
            request_id: body.request_id,
            lease_id: body.lease_id,
            nonce: body.nonce,
            result: 'rejected',
            ttl_ms: null,
          };
    },
  });
  await live(h);
  await h.clock.advance(2100);
  assert.equal(h.device.state.stopScope, 'local');
  const suspend = h.sent.find(
    (entry) => entry.request['channel'] === 'voice.suspend_io',
  );
  assert.deepEqual(suspend?.request['payload'], {
    reason: 'core_lease_lost',
    scope: 'local',
    io_epoch: '1',
    audio_epoch: '1',
    output_epoch: '1',
  });
  assert.equal(h.closed.at(-1)?.reason, 'core_lease_lost');
});

test('X13: when renewals stop arriving, the lease expires 6 s after the last accepted request and IO is suspended', async () => {
  let calls = 0;
  const h = granted({
    renew: (body) => {
      calls += 1;
      return calls === 1
        ? {
            request_id: body.request_id,
            lease_id: body.lease_id,
            nonce: body.nonce,
            result: 'renewed',
            ttl_ms: body.ttl_ms,
          }
        : 'never';
    },
  });
  await live(h);
  const sentAt = h.renewals[0]?.requested_at_mono_ms ?? 0;
  await h.clock.advance(sentAt + 5999 - h.clock.mono);
  assert.equal(h.device.state.stopScope, 'none');
  await h.clock.advance(1);
  assert.equal(h.clock.mono, sentAt + 6000);
  assert.equal(h.device.state.stopScope, 'local');
  assert.equal(lastSent(h)?.at, sentAt + 6000);
  assert.equal(
    (lastSent(h)?.request['payload'] as Record<string, unknown>)['reason'],
    'core_lease_lost',
  );
});

// PR #160 のレビュー P1: 「続ける」の途中（Live の接続を待っている間）にリースを失ったら、リースのないまま始めない。
test('a lease lost while the live session is pending (rejected or expired) starts nothing and closes the opened session', async () => {
  const renewed = (body: {
    request_id: string;
    lease_id: string;
    nonce: string;
    ttl_ms: number;
  }) => ({
    request_id: body.request_id,
    lease_id: body.lease_id,
    nonce: body.nonce,
    result: 'renewed' as const,
    ttl_ms: body.ttl_ms,
  });
  // (a) 2 回目の更新（最初の更新の受付から 2 秒後）が拒否される。接続の答えは 3 秒後。
  let calls = 0;
  const rejected = granted({
    openMs: 3000,
    renew: (body) => {
      calls += 1;
      return calls === 1
        ? renewed(body)
        : {
            request_id: body.request_id,
            lease_id: body.lease_id,
            nonce: body.nonce,
            result: 'rejected',
            ttl_ms: null,
          };
    },
  });
  await ready(rejected);
  const a = rejected.voice.continueConversation();
  await rejected.clock.advance(2100);
  assert.equal(rejected.voice.leaseActive, false);
  await rejected.clock.advance(1000);
  assert.equal(await a, 'voice_unavailable');
  assert.ok(!rejected.sentChannels().includes('voice.start'));
  assert.equal(rejected.closed.at(-1)?.reason, 'core_lease_lost');
  assert.equal(rejected.voice.externalSend, false);
  assert.equal(shown(rejected.voice.view()).notice, 'not_started');
  // 会話は始まっていないので、端末は止めない（呼びかけ待ちに戻る）。
  assert.equal(rejected.device.state.stopScope, 'none');
  assert.equal(shown(rejected.voice.view()).can_continue, true);
  await rejected.clock.advance(30_000);
  assert.ok(!rejected.sentChannels().includes('voice.start'));

  // (b) 2 回目以降の更新が届かない: 最初の要求から 6 秒で切れる。接続の答えは 7 秒後。
  let n = 0;
  const expired = granted({
    openMs: 7000,
    renew: (body) => ((n += 1) === 1 ? renewed(body) : 'never'),
  });
  await ready(expired);
  const b = expired.voice.continueConversation();
  await expired.clock.advance(7100);
  assert.equal(await b, 'voice_unavailable');
  assert.ok(!expired.sentChannels().includes('voice.start'));
  assert.equal(expired.closed.at(-1)?.reason, 'core_lease_lost');
  assert.equal(expired.voice.leaseActive, false);
});

// Issue #162 の P3-1: 置き換えられた古い手順の応答で、新しい手順のリースを止めない。
test('a superseded continue does not stop the lease of the newer flow', async () => {
  const { h, first, second } = await supersededContinue();
  assert.equal(h.opens.length, 2);
  await h.clock.advance(1000);
  // 1 回目の接続の答え（3 秒後）が届いた。古い手順は捨てるが、2 回目のリースは止めない。
  assert.equal(await first, 'input_stopped');
  assert.equal(h.voice.leaseActive, true);
  assert.ok(!h.sentChannels().includes('voice.start'));
  assert.equal(h.device.state.stopScope, 'none');
  // 2 回目の接続の答え（さらに 2 秒後）で、新しい手順は会話を始める。
  await h.clock.advance(2100);
  assert.equal(await second, 'ok');
  assert.equal(h.voice.leaseActive, true);
  assert.deepEqual(
    h.sentChannels().filter((channel) => channel === 'voice.start'),
    ['voice.start'],
  );
});

// Issue #162 の P3-2: 古い手順が閉じる Live の理由は、端末の停止ではない。
test('a superseded continue closes its live session with provider_failure, not device_io_stop', async () => {
  const { h, first } = await supersededContinue();
  await h.clock.advance(1000);
  assert.equal(await first, 'input_stopped');
  assert.deepEqual(
    h.closed.map((entry) => entry.reason),
    ['provider_failure'],
  );
  assert.equal(h.device.state.stopScope, 'none');
});

// Issue #162 の P3-3: 音声の制御が例外を投げても、状態の通知の残りの処理を飛ばさない。
test('a throwing voice controller does not skip the rest of the device state notification', () => {
  const logs: string[] = [];
  const order: string[] = [];
  const state = {
    lockState: 'locked',
    stopScope: 'none',
    ioEpoch: '1',
  } as const;
  notifyVoiceDeviceChanged(
    {
      deviceChanged: (seen) => {
        assert.equal(seen.ioEpoch, '1');
        order.push('voice');
        throw new Error('voice failed');
      },
      failSafeStop: () => order.push('fail_safe'),
    },
    state,
    (code) => logs.push(code),
  );
  // 音声の制御の後に続く処理（トレイ・状態の通知・ロックしたときのキャンバスを戻す処理）は飛ばさない。
  order.push('tray');
  order.push('state_changed');
  order.push('canvas_restored');
  assert.deepEqual(order, [
    'voice',
    'fail_safe',
    'tray',
    'state_changed',
    'canvas_restored',
  ]);
  assert.deepEqual(logs, ['voice_device_changed_failed']);
  // 例外がなければ記録せず、フォールバックも呼ばない。
  notifyVoiceDeviceChanged(
    {
      deviceChanged: () => order.push('voice_ok'),
      failSafeStop: () => order.push('fail_safe_unexpected'),
    },
    state,
    (code) => logs.push(code),
  );
  assert.equal(order.at(-1), 'voice_ok');
  assert.deepEqual(logs, ['voice_device_changed_failed']);
});

// Issue #162 の P2: 会話中に中枢へ閉じる要求（closeLive）が例外を投げても、停止（suspend_io）を飛ばさない。
test('a raising closeLive during a conversation still sends suspend_io and stops the external send', async () => {
  const h = granted({ closeFails: true });
  await live(h);
  assert.equal(h.voice.externalSend, true);
  const t0 = h.clock.mono;
  h.device.stopFromMain();
  // 中枢へ閉じる要求は失敗した。記録だけして、この端末の停止を続ける。
  assert.ok(h.logs.includes('voice_core_close_failed'));
  assert.deepEqual(h.closed, []);
  const suspend = lastSent(h);
  assert.equal(suspend?.at, t0);
  assert.equal(suspend?.request['channel'], 'voice.suspend_io');
  assert.equal(suspend?.request['ack_timeout_ms'], 300);
  assert.deepEqual(suspend?.request['payload'], {
    reason: 'device_io_stop',
    scope: 'local',
    io_epoch: '1',
    audio_epoch: '1',
    output_epoch: '1',
  });
  assert.equal(h.device.state.stopScope, 'local');
  assert.equal(h.voice.leaseActive, false);
  await h.clock.advance(1);
  // 第 1 層: ACK を待たずに、音声レンダラーが送信・収音を止めた。
  assert.equal(mock(h).stats.sending, false);
  assert.equal(mock(h).stats.capturing, false);
  const frames = mock(h).stats.sentFrames;
  await h.clock.advance(1);
  // suspend_io の ACK を受けて、外部へ送っている印を消した。
  assert.equal(h.voice.externalSend, false);
  await h.clock.advance(5000);
  assert.equal(mock(h).stats.sentFrames, frames);
  // 300 ms の見張りが始まり、ACK が返ったので強制終了はしない。
  assert.deepEqual(h.kills, []);
  assert.ok(!h.logs.some((code) => code.startsWith('voice_ack_missing')));
});

// Issue #162 の P2: 状態の通知で音声の制御が例外を投げたら、フォールバックで音声レンダラーを強制終了し端末を止める。
test('the notification fallback kills the renderer and stops the device, even if closeLive raises', async () => {
  const h = granted({ closeFails: true });
  await live(h);
  const order: string[] = [];
  notifyVoiceDeviceChanged(
    {
      deviceChanged: () => {
        order.push('voice');
        throw new Error('voice failed');
      },
      failSafeStop: () => {
        order.push('fail_safe');
        h.voice.failSafeStop();
      },
    },
    h.device.state,
    (code) => h.logs.push(code),
  );
  order.push('tray');
  assert.deepEqual(order, ['voice', 'fail_safe', 'tray']);
  assert.ok(h.logs.includes('voice_device_changed_failed'));
  assert.ok(h.logs.includes('voice_core_close_failed'));
  // 音声レンダラーを強制終了したので、外部への送信は止まる。
  assert.deepEqual(h.kills, [1]);
  assert.equal(h.voice.externalSend, false);
  assert.equal(h.voice.rendererAlive, false);
  assert.equal(h.device.state.stopScope, 'local');
  assert.deepEqual(h.voice.view(), {
    visibility: 'shown',
    voice_state: 'device_stopped',
    external_send: false,
    consent: 'granted',
    can_continue: false,
    notice: null,
  });
});

// Issue #162 の P2: フォールバック自体が例外を投げても、状態の通知は投げ直さない。
test('a raising fallback is logged and does not escape the device state notification', () => {
  const logs: string[] = [];
  const order: string[] = [];
  notifyVoiceDeviceChanged(
    {
      deviceChanged: () => {
        throw new Error('voice failed');
      },
      failSafeStop: () => {
        throw new Error('stop failed');
      },
    },
    { lockState: 'locked', stopScope: 'none', ioEpoch: '1' },
    (code) => logs.push(code),
  );
  order.push('tray');
  assert.deepEqual(order, ['tray']);
  assert.deepEqual(logs, [
    'voice_device_changed_failed',
    'voice_fail_safe_stop_failed',
  ]);
});

test('a renewal with an unknown result is not treated as success (the lease runs out)', async () => {
  let n = 0;
  const h = granted({
    renew: (body) =>
      (n += 1) === 1
        ? {
            request_id: body.request_id,
            lease_id: body.lease_id,
            nonce: body.nonce,
            result: 'renewed',
            ttl_ms: body.ttl_ms,
          }
        : null,
  });
  await live(h);
  const sentAt = h.renewals[0]?.requested_at_mono_ms ?? 0;
  await h.clock.advance(sentAt + 6000 - h.clock.mono);
  assert.equal(h.device.state.stopScope, 'local');
  assert.equal(
    (lastSent(h)?.request['payload'] as Record<string, unknown>)['reason'],
    'core_lease_lost',
  );
});

// PR #160 のレビュー P2: 取り消しを保存できなければ記録を消す。消せなければ画面で知らせ、やり直させる。
test('a revoke that cannot be saved removes the record; if that also fails the screen is told and can retry', async () => {
  const removed = granted({ consentSaveFails: true });
  await ready(removed);
  removed.voice.revokeConsent();
  assert.equal(removed.consentRecord(), null);
  assert.equal(shown(removed.voice.view()).consent, 'required');
  assert.equal(shown(removed.voice.view()).notice, null);

  const stuck = granted({ consentSaveFails: true, consentRemoveFails: true });
  await ready(stuck);
  stuck.voice.revokeConsent();
  // この起動の間は取り消したまま。記録は残っているので、知らせてやり直させる。
  assert.equal(shown(stuck.voice.view()).consent, 'required');
  assert.equal(shown(stuck.voice.view()).notice, 'consent_not_saved');
  assert.equal(stuck.consentRecord()?.state, 'granted');
  assert.ok(stuck.logs.includes('voice_consent_revoke_unsaved'));
  assert.equal(
    await stuck.voice.continueConversation(),
    'confirmation_declined',
  );
});

test('without a core connection (product start), continue does not start and plays the refused sound', async () => {
  const h = granted({ coreConnected: false });
  await ready(h);
  assert.equal(await h.voice.continueConversation(), 'voice_unavailable');
  assert.equal(shown(h.voice.view()).notice, 'not_started');
  assert.equal(lastSent(h)?.request['channel'], 'voice.play');
  assert.equal(
    (lastSent(h)?.request['payload'] as Record<string, unknown>)['clip_id'],
    'refused',
  );
  assert.deepEqual(h.opens, []);
  assert.ok(!h.sentChannels().includes('voice.start'));
});

test('an unresponsive or crashed renderer is killed and IO is stopped, whether idle or in a conversation', async () => {
  const idle = granted();
  await ready(idle);
  idle.voice.rendererGone(1, 'unresponsive');
  assert.deepEqual(idle.kills, [1]);
  assert.equal(idle.device.state.stopScope, 'local');
  // 前の番号の出来事は使わない。
  idle.voice.rendererGone(1, 'process_gone');
  assert.deepEqual(idle.kills, [1]);

  const talking = granted();
  await live(talking);
  talking.voice.rendererGone(1, 'process_gone');
  assert.deepEqual(talking.kills, [1]);
  assert.equal(talking.voice.externalSend, false);
  assert.equal(talking.device.state.stopScope, 'local');
  assert.equal(talking.closed.at(-1)?.reason, 'device_io_stop');
});

test('the screen never receives reason codes, API names or provider names', async () => {
  const h = voiceHarness({
    dialog: [true],
    faults: [faults({ dropAck: ['voice.stop_playback'] })],
  });
  await live(h);
  h.voice.stopPlayback('user_stop');
  await h.clock.advance(400);
  h.device.recordOsEvent('lock_screen');
  await h.clock.advance(400);
  const text = JSON.stringify(h.notifications);
  for (const banned of [
    'os_lock',
    'device_io_stop',
    'core_lease_lost',
    'user_stop',
    'provider',
    'openai',
    'OpenAI',
    'voice.',
    'sdp',
    'lease',
    'epoch_regressed',
  ])
    assert.ok(!text.includes(banned), banned);
});

test('the IPC follows the role rules: continue needs a focused unlocked screen; revoke and get work while locked', async () => {
  const h = granted();
  const req = (channel: string) => ({ channel, request_id: ID, payload: null });
  assert.deepEqual(
    await h.voice.handleIpc(
      'desktop.get_voice',
      req('desktop.get_voice'),
      UNTRUSTED,
    ),
    {
      request_id: ID,
      channel: 'desktop.get_voice',
      outcome: 'rejected',
      reason: 'untrusted_sender',
    },
  );
  assert.deepEqual(
    await h.voice.handleIpc(
      'desktop.get_voice',
      req('desktop.get_voice'),
      BACKGROUND,
    ),
    {
      request_id: ID,
      channel: 'desktop.get_voice',
      outcome: 'ok',
      voice: { visibility: 'hidden' },
    },
  );
  assert.deepEqual(
    await h.voice.handleIpc(
      'desktop.voice_continue',
      req('desktop.voice_continue'),
      FOCUSED,
    ),
    {
      request_id: ID,
      channel: 'desktop.voice_continue',
      outcome: 'rejected',
      reason: 'device_locked',
    },
  );
  const revoked = await h.voice.handleIpc(
    'desktop.voice_consent_revoke',
    req('desktop.voice_consent_revoke'),
    BACKGROUND,
  );
  assert.equal(revoked.outcome, 'ok');
  assert.equal(h.consentRecord()?.state, 'revoked');
  await ready(h);
  assert.deepEqual(
    await h.voice.handleIpc(
      'desktop.voice_continue',
      req('desktop.voice_continue'),
      BACKGROUND,
    ),
    {
      request_id: ID,
      channel: 'desktop.voice_continue',
      outcome: 'rejected',
      reason: 'screen_operation_required',
    },
  );
  // 要求の形が違う・チャネルが合わないものは invalid_request。
  assert.deepEqual(
    await h.voice.handleIpc(
      'desktop.get_voice',
      req('desktop.voice_continue'),
      FOCUSED,
    ),
    {
      request_id: null,
      channel: null,
      outcome: 'rejected',
      reason: 'invalid_request',
    },
  );
});

test('a disabled controller never creates a renderer and continue is unavailable', async () => {
  const h = granted({ enabled: false });
  await ready(h);
  assert.equal(h.slots.length, 0);
  assert.deepEqual(h.voice.view(), {
    visibility: 'shown',
    voice_state: null,
    external_send: false,
    consent: 'granted',
    can_continue: false,
    notice: null,
  });
  assert.equal(statusVoice(h), null);
  h.device.stopFromMain();
  assert.equal(statusVoice(h), null);
  assert.equal(await h.voice.continueConversation(), 'voice_unavailable');
});
