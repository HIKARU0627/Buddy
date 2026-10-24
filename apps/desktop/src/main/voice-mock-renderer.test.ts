// 模擬の音声レンダラー（B05-06、ADR 0050）。合成の PCM と手で書いた命令だけを使う。期待値は手で書く。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MockVoiceRenderer,
  NO_FAULTS,
  PCM_FRAME_SAMPLES,
  PCM_RING_FRAMES,
  parseMockFaults,
  syntheticFrame,
  type MockAck,
  type MockFaults,
} from './voice-mock-renderer.js';

const AT = '2030-10-05T00:00:00.000Z';

function setup(faults: MockFaults = NO_FAULTS) {
  const acks: MockAck[] = [];
  const scheduled: { ms: number; task: () => void }[] = [];
  let hangs = 0;
  const renderer = new MockVoiceRenderer(
    {
      ack: (ack) => acks.push(ack),
      schedule: (ms, task) => scheduled.push({ ms, task }),
      wallNow: () => AT,
      hang: () => {
        hangs += 1;
      },
    },
    faults,
  );
  return { renderer, acks, scheduled, hangs: () => hangs };
}

let seq = 0;
const id = () =>
  `00000000-0000-4000-8000-${(seq += 1).toString(16).padStart(12, '0')}`;

const start = (epochs: {
  io: string;
  audio: string;
  output: string;
  session: string;
}) => ({
  channel: 'voice.start',
  request_id: id(),
  ack_timeout_ms: 3000,
  payload: {
    live_session_id: id(),
    purpose: 'conversation',
    sdp_answer: 'v=0\r\n',
    io_epoch: epochs.io,
    audio_epoch: epochs.audio,
    output_epoch: epochs.output,
    session_epoch: epochs.session,
  },
});
const suspend = (io: string, output: string, audio: string | null = '1') => ({
  channel: 'voice.suspend_io',
  request_id: id(),
  ack_timeout_ms: 300,
  payload: {
    reason: 'os_lock',
    scope: 'local',
    io_epoch: io,
    audio_epoch: audio,
    output_epoch: output,
  },
});
const stopPlayback = (io: string, output: string) => ({
  channel: 'voice.stop_playback',
  request_id: id(),
  ack_timeout_ms: 300,
  payload: {
    reason: 'user_stop',
    scope: null,
    io_epoch: io,
    audio_epoch: '1',
    output_epoch: output,
  },
});

test('the fault spec is parsed strictly; anything unknown disables all faults', () => {
  assert.deepEqual(parseMockFaults(null), NO_FAULTS);
  assert.deepEqual(
    parseMockFaults(
      'delay=250,hang=suspend_io,drop=stop_playback:play,fail=start',
    ),
    {
      delayMs: 250,
      hangOn: 'voice.suspend_io',
      dropAck: ['voice.stop_playback', 'voice.play'],
      fail: ['voice.start'],
    },
  );
  for (const bad of [
    'delay=-1',
    'delay=250ms',
    'hang=get_device_token',
    'drop=stop_playback:fetch',
    'unknown=1',
    'hang',
  ])
    assert.deepEqual(parseMockFaults(bad), NO_FAULTS, bad);
});

test('the synthetic PCM frame is 20 ms of 16 kHz mono 16-bit samples', () => {
  const frame = syntheticFrame(0);
  assert.equal(frame.length, 320);
  assert.equal(PCM_FRAME_SAMPLES, 320);
  assert.equal(PCM_RING_FRAMES, 3000);
  assert.ok(frame.some((sample) => sample !== 0));
  assert.ok(frame.every((sample) => Math.abs(sample) <= 1000));
});

test('start captures and sends; the applied ACK returns the request epochs as they are', () => {
  const { renderer, acks } = setup();
  const request = start({ io: '0', audio: '1', output: '0', session: '1' });
  renderer.receive(request);
  assert.deepEqual(acks, [
    {
      request_id: request.request_id,
      channel: 'voice.start',
      outcome: 'applied',
      io_epoch: '0',
      audio_epoch: '1',
      output_epoch: '0',
      session_epoch: '1',
      acked_at: AT,
    },
  ]);
  for (let i = 0; i < 10; i += 1) renderer.tick();
  assert.equal(renderer.stats.sentFrames, 10);
  assert.equal(renderer.stats.ringFrames, 10);
});

test('suspend_io stops sending and capturing and clears the ring at once; later ticks send nothing', () => {
  const { renderer, acks } = setup();
  renderer.receive(start({ io: '0', audio: '1', output: '0', session: '1' }));
  for (let i = 0; i < 5; i += 1) renderer.tick();
  const request = suspend('1', '1');
  renderer.receive(request);
  assert.equal(renderer.stats.ringFrames, 0);
  assert.equal(renderer.stats.sending, false);
  assert.equal(renderer.stats.capturing, false);
  assert.equal(renderer.stats.lastLocalStop, 'voice.suspend_io');
  assert.equal(acks.at(-1)?.outcome, 'applied');
  assert.equal(acks.at(-1)?.io_epoch, '1');
  for (let i = 0; i < 100; i += 1) renderer.tick();
  assert.equal(renderer.stats.sentFrames, 5);
  assert.equal(renderer.stats.ringFrames, 0);
});

test('stop_playback keeps the conversation and capture; close_voice_session ends sending but keeps local capture', () => {
  const { renderer } = setup();
  renderer.receive(start({ io: '0', audio: '1', output: '0', session: '1' }));
  renderer.receive(stopPlayback('0', '1'));
  assert.equal(renderer.stats.live, true);
  assert.equal(renderer.stats.sending, true);
  renderer.receive({
    channel: 'voice.close_voice_session',
    request_id: id(),
    ack_timeout_ms: 1500,
    payload: {
      reason: 'silence',
      scope: null,
      io_epoch: '0',
      audio_epoch: '1',
      output_epoch: '2',
    },
  });
  assert.equal(renderer.stats.live, false);
  assert.equal(renderer.stats.sending, false);
  assert.equal(renderer.stats.capturing, true);
  renderer.tick();
  assert.equal(renderer.stats.sentFrames, 0);
});

test('an older command is ignored and answered with the renderer epochs (ignored_stale_epoch)', () => {
  const { renderer, acks } = setup();
  renderer.receive(start({ io: '3', audio: '2', output: '4', session: '2' }));
  const old = start({ io: '2', audio: '3', output: '5', session: '3' });
  renderer.receive(old);
  assert.deepEqual(acks.at(-1), {
    request_id: old.request_id,
    channel: 'voice.start',
    outcome: 'ignored_stale_epoch',
    io_epoch: '3',
    audio_epoch: '2',
    output_epoch: '4',
    session_epoch: '2',
    acked_at: AT,
  });
  // 古い命令の play は鳴らさない。
  renderer.receive({
    channel: 'voice.play',
    request_id: id(),
    ack_timeout_ms: 500,
    payload: { clip_id: 'refused', io_epoch: '3', output_epoch: '3' },
  });
  assert.deepEqual(renderer.stats.clipsPlayed, []);
  assert.equal(acks.at(-1)?.outcome, 'ignored_stale_epoch');
});

test('invalid commands are answered rejected_invalid or dropped when they cannot be answered', () => {
  const { renderer, acks } = setup();
  renderer.receive(null);
  renderer.receive({
    channel: 'voice.get_device_token',
    request_id: id(),
    ack_timeout_ms: 1,
    payload: {},
  });
  renderer.receive({ channel: 'voice.start', ack_timeout_ms: 1, payload: {} });
  assert.equal(acks.length, 0);
  // os_lock に global の範囲（理由と範囲の組が合わない）。
  const wrongScope = suspend('1', '1');
  (wrongScope.payload as { scope: string }).scope = 'global';
  renderer.receive(wrongScope);
  // ACK の待ち時間が上限（suspend_io は 300 ms）を超える。
  const slow = { ...suspend('1', '1'), ack_timeout_ms: 301 };
  renderer.receive(slow);
  assert.deepEqual(
    acks.map((ack) => ack.outcome),
    ['rejected_invalid', 'rejected_invalid'],
  );
  assert.equal(renderer.stats.lastLocalStop, null);
});

test('faults: delay schedules the ACK but stops locally at once; drop applies without ACK; fail does not apply', () => {
  const delayed = setup({ ...NO_FAULTS, delayMs: 250 });
  delayed.renderer.receive(
    start({ io: '0', audio: '1', output: '0', session: '1' }),
  );
  delayed.scheduled.splice(0).forEach((entry) => entry.task());
  delayed.renderer.receive(suspend('1', '1'));
  assert.equal(delayed.renderer.stats.sending, false);
  assert.equal(delayed.acks.length, 1);
  assert.equal(delayed.scheduled[0]?.ms, 250);
  delayed.scheduled[0]?.task();
  assert.equal(delayed.acks.length, 2);

  const dropped = setup({ ...NO_FAULTS, dropAck: ['voice.suspend_io'] });
  dropped.renderer.receive(
    start({ io: '0', audio: '1', output: '0', session: '1' }),
  );
  dropped.renderer.receive(suspend('1', '1'));
  assert.equal(dropped.renderer.stats.sending, false);
  assert.deepEqual(
    dropped.acks.map((ack) => ack.channel),
    ['voice.start'],
  );

  const failed = setup({ ...NO_FAULTS, fail: ['voice.suspend_io'] });
  failed.renderer.receive(
    start({ io: '0', audio: '1', output: '0', session: '1' }),
  );
  failed.renderer.receive(suspend('1', '1'));
  assert.equal(failed.renderer.stats.sending, true);
  assert.equal(failed.acks.at(-1)?.outcome, 'failed');
});

test('a hang stops all command handling but an open send track keeps sending until the process is killed', () => {
  const { renderer, acks, hangs, scheduled } = setup({
    ...NO_FAULTS,
    hangOn: 'voice.suspend_io',
    delayMs: 10,
  });
  renderer.receive(start({ io: '0', audio: '1', output: '0', session: '1' }));
  renderer.receive(stopPlayback('0', '1'));
  renderer.receive(suspend('1', '2'));
  assert.equal(hangs(), 1);
  assert.equal(renderer.stats.hung, true);
  // 固まる前に予約した遅れた ACK も返さない。
  scheduled.forEach((entry) => entry.task());
  assert.equal(acks.length, 0);
  renderer.receive(suspend('2', '3'));
  for (let i = 0; i < 7; i += 1) renderer.tick();
  assert.equal(renderer.stats.sentFrames, 7);
  assert.equal(renderer.stats.lastLocalStop, 'voice.stop_playback');
});
