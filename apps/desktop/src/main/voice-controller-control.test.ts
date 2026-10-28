// main の音声の制御の、返し方（声／文字）の切り替えと会話の操作（B05-05、ADR 0052。設計 10 §1A・§5・§6A、09 X47・X49・X58・
// QA43 の模擬）。模擬のレンダラー（合成の PCM）・端末状態・手で進める時計・端末の中の模擬の中枢だけを使う。Electron・実際の音声・
// マイク・実 API は使わない。期待値（理由・世代・送った命令）は手で書き、実装から作らない。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopVoiceView } from '@buddy/contracts';
import { voiceHarness, type HarnessOptions } from './voice-test-support.js';
import type { LocalVoiceConsent } from './voice-consent.js';

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

type Harness = ReturnType<typeof voiceHarness>;
const granted = (extra: HarnessOptions = {}) =>
  voiceHarness({ consent: GRANTED, ...extra });

async function ready(h: Harness): Promise<void> {
  h.unlock();
  await h.clock.advance(10);
}

// 「続ける」で会話を始め、開始の ACK まで待つ。
async function live(h: Harness): Promise<void> {
  await ready(h);
  const result = h.voice.continueConversation();
  await h.clock.advance(100);
  assert.equal(await result, 'ok');
  await h.clock.advance(100);
}

const shown = (view: DesktopVoiceView) => {
  assert.equal(view.visibility, 'shown');
  return view as Extract<DesktopVoiceView, { visibility: 'shown' }>;
};

const control = (action: unknown) => ({
  channel: 'desktop.voice_control',
  request_id: ID,
  payload: { action },
});

// 送った音声レンダラーへの命令（チャネルと理由）。
const sentAfter = (h: Harness, from: number) =>
  h.sent
    .slice(from)
    .map((entry) => [
      String(entry.request['channel']),
      String(
        (entry.request['payload'] as Record<string, unknown>)['reason'] ?? '',
      ),
    ]);

test('the view carries the reply mode: voice by default, text when the saved mode is text, and text blocks "続ける"', async () => {
  const voiceMode = granted();
  await ready(voiceMode);
  assert.equal(shown(voiceMode.voice.view()).reply_mode, 'voice');
  assert.equal(shown(voiceMode.voice.view()).can_continue, true);
  const textMode = granted({ replyMode: 'text' });
  await ready(textMode);
  const view = shown(textMode.voice.view());
  assert.equal(view.reply_mode, 'text');
  assert.equal(view.voice_state, 'waiting_wake_word');
  assert.equal(view.external_send, false);
  assert.equal(view.can_continue, false);
  // 文字で返す設定では、同意・リース・Live の接続を一切求めない（音声を外へ送らない）。
  assert.equal(
    await textMode.voice.continueConversation(),
    'voice_unavailable',
  );
  await textMode.clock.advance(500);
  assert.deepEqual(textMode.dialogs, []);
  assert.deepEqual(textMode.renewals, []);
  assert.deepEqual(textMode.opens, []);
  assert.deepEqual(textMode.sentChannels(), []);
  assert.equal(textMode.voice.externalSend, false);
  // 画面のボタン（IPC）でも同じ。
  const response = await textMode.voice.handleIpc(
    'desktop.voice_continue',
    { channel: 'desktop.voice_continue', request_id: ID, payload: null },
    FOCUSED,
  );
  assert.deepEqual(response, {
    request_id: ID,
    channel: 'desktop.voice_continue',
    outcome: 'rejected',
    reason: 'voice_unavailable',
  });
  assert.deepEqual(textMode.opens, []);
});

test('X47: switching voice to text closes the open live at once (output_mode_text), keeps the conversation, and the mark stays until the ACK', async () => {
  const h = granted();
  await live(h);
  const before = h.sent.length;
  assert.equal(h.voice.externalSend, true);
  h.voice.setReplyMode('text');
  // 中枢へ閉じる要求（第 3 層の起点）と、音声レンダラーへ close_voice_session（理由 output_mode_text）。
  assert.deepEqual(
    h.closed.map((entry) => entry.reason),
    ['output_mode_text'],
  );
  assert.deepEqual(sentAfter(h, before), [
    ['voice.close_voice_session', 'output_mode_text'],
  ]);
  assert.deepEqual(h.replySaved, ['text']);
  assert.equal(h.voice.replyMode, 'text');
  const view = shown(h.voice.view());
  assert.equal(view.reply_mode, 'text');
  assert.equal(view.can_continue, false);
  // 閉じた ACK を受けるまで、外部へ送っている印は消さない。
  assert.equal(view.external_send, true);
  await h.clock.advance(5);
  assert.equal(h.voice.externalSend, false);
  assert.equal(shown(h.voice.view()).voice_state, 'waiting_wake_word');
  // 切り替えは入出力の停止ではない（端末は止まらない）。収音の許可は保つ。
  assert.equal(h.device.state.stopScope, 'none');
  assert.deepEqual(h.kills, []);
  // 文字では、もう会話を始められない。
  assert.equal(await h.voice.continueConversation(), 'voice_unavailable');
});

test('X47: switching to text while "続ける" is still waiting for the consent dialog drops the start without sending anything', async () => {
  const h = voiceHarness({ dialog: [true], dialogMs: 100 });
  await ready(h);
  const result = h.voice.continueConversation();
  await h.clock.advance(10);
  assert.equal(h.dialogs.length, 1);
  h.voice.setReplyMode('text');
  // 出している同意の確認を閉じ、始めている手順を捨てる。
  assert.equal(h.cancelled.length, 1);
  await h.clock.advance(300);
  assert.notEqual(await result, 'ok');
  assert.deepEqual(h.opens, []);
  assert.equal(h.voice.externalSend, false);
  assert.deepEqual(h.sentChannels(), []);
});

test('text to voice only restores the setting: no live is opened or resumed, and the next start is a new live with newer epochs', async () => {
  const h = granted({ replyMode: 'text' });
  await ready(h);
  h.voice.setReplyMode('voice');
  await h.clock.advance(500);
  assert.deepEqual(h.replySaved, ['voice']);
  assert.equal(shown(h.voice.view()).can_continue, true);
  assert.deepEqual(h.opens, []);
  assert.deepEqual(h.sentChannels(), []);
  const result = h.voice.continueConversation();
  await h.clock.advance(100);
  assert.equal(await result, 'ok');
  assert.equal(h.opens.length, 1);
  const start = h.sent.at(-1)?.request;
  assert.equal(start?.['channel'], 'voice.start');
  assert.equal(
    (start?.['payload'] as Record<string, unknown>)['audio_epoch'],
    '1',
  );
  // もう一度文字へ切り替えてから戻すと、新しい接続（世代が進む）。同じ接続・閉じた接続は戻らない。
  h.voice.setReplyMode('text');
  await h.clock.advance(20);
  h.voice.setReplyMode('voice');
  const again = h.voice.continueConversation();
  await h.clock.advance(100);
  assert.equal(await again, 'ok');
  assert.equal(h.opens.length, 2);
  assert.equal(
    (h.sent.at(-1)?.request['payload'] as Record<string, unknown>)[
      'audio_epoch'
    ],
    '2',
  );
});

test('the button channel: reply mode, stop playback and end conversation go through the same paths; refusals follow the screen rules', async () => {
  const h = granted();
  await live(h);
  let from = h.sent.length;
  const textual = await h.voice.handleIpc(
    'desktop.voice_control',
    control('reply_in_text'),
    FOCUSED,
  );
  assert.equal(textual.outcome, 'ok');
  assert.equal(
    shown((textual as { voice: DesktopVoiceView }).voice).reply_mode,
    'text',
  );
  assert.deepEqual(sentAfter(h, from), [
    ['voice.close_voice_session', 'output_mode_text'],
  ]);
  await h.clock.advance(5);
  const spoken = await h.voice.handleIpc(
    'desktop.voice_control',
    control('reply_in_voice'),
    FOCUSED,
  );
  assert.equal(
    shown((spoken as { voice: DesktopVoiceView }).voice).reply_mode,
    'voice',
  );
  // 続けて、新しい会話を始めてから、読み上げの停止（再生だけ止める）と会話の終了。
  const start = h.voice.continueConversation();
  await h.clock.advance(100);
  assert.equal(await start, 'ok');
  await h.clock.advance(100);
  from = h.sent.length;
  const stopped = await h.voice.handleIpc(
    'desktop.voice_control',
    control('stop_playback'),
    FOCUSED,
  );
  assert.equal(stopped.outcome, 'ok');
  assert.deepEqual(sentAfter(h, from), [['voice.stop_playback', 'user_stop']]);
  // 再生の停止では接続を閉じず、中枢にも閉じる要求を送らない。
  assert.equal(h.voice.externalSend, true);
  assert.deepEqual(
    h.closed.map((entry) => entry.reason),
    ['output_mode_text'],
  );
  from = h.sent.length;
  const ended = await h.voice.handleIpc(
    'desktop.voice_control',
    control('end_conversation'),
    FOCUSED,
  );
  assert.equal(ended.outcome, 'ok');
  assert.deepEqual(sentAfter(h, from), [
    ['voice.close_voice_session', 'conversation_ended'],
  ]);
  assert.deepEqual(
    h.closed.map((entry) => entry.reason),
    ['output_mode_text', 'conversation_ended'],
  );
  // 画面の操作の規則: 前面でない・信頼できない送信元・ロック中は受け付けない。
  assert.deepEqual(
    await h.voice.handleIpc(
      'desktop.voice_control',
      control('stop_playback'),
      BACKGROUND,
    ),
    {
      request_id: ID,
      channel: 'desktop.voice_control',
      outcome: 'rejected',
      reason: 'screen_operation_required',
    },
  );
  assert.deepEqual(
    await h.voice.handleIpc(
      'desktop.voice_control',
      control('stop_playback'),
      UNTRUSTED,
    ),
    {
      request_id: ID,
      channel: 'desktop.voice_control',
      outcome: 'rejected',
      reason: 'untrusted_sender',
    },
  );
  // 照合表にない操作（処理の取り消し・記録しない会話）や形の違う値は、契約の検査で拒否する。
  for (const action of [
    'cancel_workflow',
    'start_private_conversation',
    7,
    null,
  ])
    assert.deepEqual(
      await h.voice.handleIpc(
        'desktop.voice_control',
        control(action),
        FOCUSED,
      ),
      {
        request_id: null,
        channel: null,
        outcome: 'rejected',
        reason: 'invalid_request',
      },
      String(action),
    );
  h.device.recordOsEvent('lock_screen');
  assert.deepEqual(
    await h.voice.handleIpc(
      'desktop.voice_control',
      control('stop_playback'),
      FOCUSED,
    ),
    {
      request_id: ID,
      channel: 'desktop.voice_control',
      outcome: 'rejected',
      reason: 'device_locked',
    },
  );
});

test('a disabled controller ignores every control and never sends to a renderer', async () => {
  const h = granted({ enabled: false });
  await ready(h);
  const response = await h.voice.handleIpc(
    'desktop.voice_control',
    control('stop_playback'),
    FOCUSED,
  );
  assert.deepEqual(response, {
    request_id: ID,
    channel: 'desktop.voice_control',
    outcome: 'rejected',
    reason: 'voice_unavailable',
  });
  h.voice.applyTurnControl('end_conversation');
  assert.deepEqual(h.sentChannels(), []);
  assert.deepEqual(h.closed, []);
});

test('X58: a session control from a text turn does the same thing as the button, one effect per control', async () => {
  const run = async (
    action: Parameters<Harness['voice']['applyTurnControl']>[0],
  ) => {
    const h = granted();
    await live(h);
    const from = h.sent.length;
    h.voice.applyTurnControl(action);
    return { h, from };
  };
  {
    const { h, from } = await run('extend_silence');
    // 無音の延長だけ。接続も再生も触らない。
    assert.deepEqual(h.silence, [60000]);
    assert.deepEqual(sentAfter(h, from), []);
    assert.deepEqual(h.closed, []);
    assert.equal(h.voice.replyMode, 'voice');
  }
  {
    const { h, from } = await run('stop_playback');
    assert.deepEqual(sentAfter(h, from), [
      ['voice.stop_playback', 'user_stop'],
    ]);
    assert.deepEqual(h.closed, []);
    assert.deepEqual(h.silence, []);
  }
  {
    const { h, from } = await run('end_conversation');
    assert.deepEqual(sentAfter(h, from), [
      ['voice.close_voice_session', 'conversation_ended'],
    ]);
    assert.deepEqual(
      h.closed.map((entry) => entry.reason),
      ['conversation_ended'],
    );
    // 会話を終えても返し方は変えない。
    assert.equal(h.voice.replyMode, 'voice');
    assert.deepEqual(h.replySaved, []);
  }
  {
    const { h, from } = await run('start_private_conversation');
    assert.deepEqual(sentAfter(h, from), [
      ['voice.close_voice_session', 'private_conversation'],
    ]);
    assert.equal(h.voice.replyMode, 'voice');
  }
  {
    const { h, from } = await run('reply_in_text');
    assert.deepEqual(sentAfter(h, from), [
      ['voice.close_voice_session', 'output_mode_text'],
    ]);
    assert.equal(h.voice.replyMode, 'text');
    assert.deepEqual(h.replySaved, ['text']);
  }
});

// ---- 中枢の音声イベント ----------------------------------------------------------------------------------------

function audioControlEvent(
  h: Harness,
  over: {
    readonly action?: string;
    readonly reason?: string;
    readonly issued_by?: string;
    readonly live?: string | null;
    readonly device?: string;
    readonly audio_epoch?: string | null;
    readonly event_audio_epoch?: string | null;
  } = {},
) {
  const audio = over.audio_epoch === undefined ? '1' : over.audio_epoch;
  const close = (over.action ?? 'stop_playback') === 'close_voice_session';
  return {
    schema: 'buddy.voice-event.v1',
    event_id: ID,
    event_type: 'audio_control',
    device_id: over.device ?? h.deviceId,
    session_id: null,
    live_session_id:
      over.live === undefined ? (h.liveIds[0] ?? null) : over.live,
    audio_epoch:
      over.event_audio_epoch === undefined ? audio : over.event_audio_epoch,
    control_epoch: '0',
    candidate_ids: [],
    audio_control: {
      action: over.action ?? 'stop_playback',
      reason: over.reason ?? (close ? 'conversation_ended' : 'user_stop'),
      device_id: over.device ?? h.deviceId,
      scope: null,
      io_epoch: '0',
      audio_epoch: close ? (audio ?? '1') : audio,
      output_epoch: '0',
      issued_by: over.issued_by ?? 'core',
      issued_at: '2030-10-05T00:00:00Z',
    },
    occurred_at: '2030-10-05T00:00:00Z',
  };
}

test('X58: a stop event from the core mutes only; an end event closes the live; a reply-in-text event also sets this device to text', async () => {
  {
    const h = granted();
    await live(h);
    const from = h.sent.length;
    h.voice.onCoreVoiceEvent(audioControlEvent(h));
    assert.deepEqual(sentAfter(h, from), [
      ['voice.stop_playback', 'user_stop'],
    ]);
    assert.deepEqual(h.closed, []);
    assert.equal(h.voice.replyMode, 'voice');
  }
  {
    const h = granted();
    await live(h);
    const from = h.sent.length;
    h.voice.onCoreVoiceEvent(
      audioControlEvent(h, {
        action: 'close_voice_session',
        reason: 'conversation_ended',
      }),
    );
    assert.deepEqual(sentAfter(h, from), [
      ['voice.close_voice_session', 'conversation_ended'],
    ]);
    assert.equal(h.voice.replyMode, 'voice');
  }
  {
    const h = granted();
    await live(h);
    const from = h.sent.length;
    h.voice.onCoreVoiceEvent(
      audioControlEvent(h, {
        action: 'close_voice_session',
        reason: 'output_mode_text',
      }),
    );
    assert.deepEqual(sentAfter(h, from), [
      ['voice.close_voice_session', 'output_mode_text'],
    ]);
    assert.equal(h.voice.replyMode, 'text');
    assert.deepEqual(h.replySaved, ['text']);
  }
});

test('X58: "wait a moment" from the core extends the next silence by the given milliseconds and nothing else', async () => {
  const h = granted();
  await live(h);
  const from = h.sent.length;
  h.voice.onCoreVoiceEvent({
    ...audioControlEvent(h),
    event_type: 'silence_extension',
    audio_control: null,
    silence_extension_ms: 60000,
  });
  assert.deepEqual(h.silence, [60000]);
  assert.deepEqual(sentAfter(h, from), []);
  assert.deepEqual(h.closed, []);
});

test('events from the core that do not match this device, this live or this epoch, or that are not core-issued or not valid, change nothing', async () => {
  const h = granted();
  await live(h);
  const from = h.sent.length;
  const logs = h.logs.length;
  const ignored: unknown[] = [
    // 別の端末宛て。
    audioControlEvent(h, { device: '00000000-0000-4000-8000-0000000000ee' }),
    // 別の Live・古い世代・まだ発行していない世代。
    audioControlEvent(h, { live: '00000000-0000-4000-8000-0000000000ee' }),
    audioControlEvent(h, { event_audio_epoch: '0', audio_epoch: '0' }),
    audioControlEvent(h, { event_audio_epoch: '9', audio_epoch: '9' }),
    audioControlEvent(h, { event_audio_epoch: null }),
    // 端末が出した停止を中枢の経路で受けない。
    audioControlEvent(h, { issued_by: 'device' }),
    // 形が違う（知らない項目・種類）。
    { ...audioControlEvent(h), transcript: '本文を載せない' },
    { ...audioControlEvent(h), event_type: 'open_everything' },
    {
      ...audioControlEvent(h),
      silence_extension_ms: 60000,
      event_type: 'silence_extension',
      audio_control: null,
      live_session_id: null,
    },
    null,
    'stop',
  ];
  for (const event of ignored) h.voice.onCoreVoiceEvent(event);
  assert.deepEqual(sentAfter(h, from), []);
  assert.deepEqual(h.silence, []);
  assert.deepEqual(h.closed, []);
  assert.equal(h.voice.externalSend, true);
  assert.ok(h.logs.length > logs);
  // Live がないときは、止めるイベントでも何も送らない。
  const idle = granted();
  await ready(idle);
  idle.voice.onCoreVoiceEvent(audioControlEvent(idle, { live: null }));
  assert.deepEqual(idle.sentChannels(), []);
});
