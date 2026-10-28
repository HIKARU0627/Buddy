// 状態の層のパネルの音声の会話の操作（B05-05、ADR 0052）の画面側の試験。返し方（声／文字）の 2 択・読み上げの停止・会話の終了の
// 表示は main の音声の状態から決める（純粋な関数）。happy-dom に React で実際に描いた段で、押したときに main へ渡す操作を確かめる。
// 説明文は置かず、並びと形で伝える方針（本人）の確認も含む。本物のブラウザ・物理の入力ではない（見た目はスクリーンショットで確かめる）。
// 期待値は手で書いた。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopVoiceView } from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  voiceControlsView,
  voiceStripView,
} from '../../state/status-panel-state.js';
import { VoiceStrip, VOICE_LABELS } from './VoiceStrip.js';

after(async () => {
  await happy.happyDOM.close();
});

type Shown = Extract<DesktopVoiceView, { visibility: 'shown' }>;

const shownVoice = (
  overrides: Record<string, unknown> = {},
): DesktopVoiceView =>
  ({
    visibility: 'shown',
    voice_state: 'waiting_wake_word',
    external_send: false,
    consent: 'granted',
    can_continue: true,
    notice: null,
    reply_mode: 'voice',
    ...overrides,
  }) as DesktopVoiceView;

const talking = (overrides: Record<string, unknown> = {}) =>
  shownVoice({
    voice_state: 'conversation_live',
    external_send: true,
    can_continue: false,
    ...overrides,
  });

test('the controls view: reply mode always, stop and end only while talking, end also while the external mark is on', () => {
  assert.equal(voiceControlsView(null), null);
  assert.equal(voiceControlsView({ visibility: 'hidden' }), null);
  assert.deepEqual(voiceControlsView(shownVoice()), {
    replyMode: 'voice',
    canStopPlayback: false,
    canEnd: false,
  });
  assert.deepEqual(voiceControlsView(shownVoice({ reply_mode: 'text' })), {
    replyMode: 'text',
    canStopPlayback: false,
    canEnd: false,
  });
  assert.deepEqual(voiceControlsView(talking()), {
    replyMode: 'voice',
    canStopPlayback: true,
    canEnd: true,
  });
  assert.deepEqual(
    voiceControlsView(talking({ voice_state: 'reading_aloud' })),
    { replyMode: 'voice', canStopPlayback: true, canEnd: true },
  );
  // 止めた直後で、閉じた ACK を待っている間: 再生はもう止めるものがないが、外へ送っている間は終了を押せる。
  assert.deepEqual(
    voiceControlsView(
      shownVoice({
        voice_state: 'waiting_wake_word',
        external_send: true,
        can_continue: false,
      }),
    ),
    { replyMode: 'voice', canStopPlayback: false, canEnd: true },
  );
  // 値が来ていない古い形（reply_mode なし）は声として扱う。
  assert.equal(
    voiceControlsView({
      ...(shownVoice() as Shown),
      reply_mode: undefined,
    } as never)?.replyMode,
    'voice',
  );
});

test('the strip view: in text mode "続ける" stays unavailable without the "starting" mark', () => {
  const text = voiceStripView(
    shownVoice({ reply_mode: 'text', can_continue: false }),
  );
  assert.equal(text.continueState, 'unavailable');
  // 声のときに押せない（始めている途中）は従来どおり。
  assert.equal(
    voiceStripView(shownVoice({ can_continue: false })).continueState,
    'starting',
  );
  assert.equal(voiceStripView(shownVoice()).continueState, 'ready');
});

async function mount(
  voice: DesktopVoiceView,
  options: { controls?: boolean } = {},
) {
  const calls: string[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProviders>
        <VoiceStrip
          view={voiceStripView(voice)}
          message={null}
          onContinue={() => calls.push('continue')}
          onRevoke={() => calls.push('revoke')}
          {...(options.controls === false
            ? {}
            : {
                controls: voiceControlsView(voice),
                onReplyMode: (mode: 'voice' | 'text') =>
                  calls.push(`reply:${mode}`),
                onStopPlayback: () => calls.push('stop'),
                onEndConversation: () => calls.push('end'),
              })}
        />
      </AppProviders>,
    );
  });
  return {
    calls,
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const button = (container: HTMLElement, name: string) => {
  const found = container.querySelector(`[aria-label="${name}"]`);
  assert(found instanceof HTMLElement, name);
  return found as HTMLButtonElement;
};

test('waiting in voice mode: the voice choice is selected, stop and end are disabled outlines, and choosing text asks main to switch', async () => {
  const strip = await mount(shownVoice());
  const row = strip.container.querySelector('[data-controls-row]');
  assert.ok(row);
  const voice = button(strip.container, VOICE_LABELS.replyVoice);
  const text = button(strip.container, VOICE_LABELS.replyText);
  assert.equal(
    voice.getAttribute('aria-pressed') ?? voice.getAttribute('aria-checked'),
    'true',
  );
  assert.equal(
    text.getAttribute('aria-pressed') ?? text.getAttribute('aria-checked'),
    'false',
  );
  // 記号だけ（文字を重ねない）。名前は読み上げのためだけに持つ。
  for (const node of [voice, text])
    assert.equal((node.textContent ?? '').trim(), '');
  const stop = button(strip.container, VOICE_LABELS.stopPlayback);
  const end = button(strip.container, VOICE_LABELS.endConversation);
  assert.equal(stop.disabled, true);
  assert.equal(end.disabled, true);
  assert.equal(stop.getAttribute('data-stop-playback'), 'off');
  assert.equal(end.getAttribute('data-end-conversation'), 'off');
  // 位置: 返し方の 2 択が左、停止・終了が右（同じ段の中）。
  assert.ok(
    (voice.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING) !==
      0,
  );
  await act(async () => text.click());
  await act(async () => stop.click());
  await act(async () => end.click());
  assert.deepEqual(strip.calls, ['reply:text']);
  strip.unmount();
});

test('talking: stop and end are enabled and hand main their own operations; choosing the selected mode again does nothing', async () => {
  const strip = await mount(talking());
  const stop = button(strip.container, VOICE_LABELS.stopPlayback);
  const end = button(strip.container, VOICE_LABELS.endConversation);
  assert.equal(stop.disabled, false);
  assert.equal(end.disabled, false);
  assert.equal(stop.getAttribute('data-stop-playback'), 'ready');
  await act(async () => stop.click());
  await act(async () => end.click());
  await act(async () =>
    button(strip.container, VOICE_LABELS.replyVoice).click(),
  );
  assert.deepEqual(strip.calls, ['stop', 'end']);
  const text = strip.container.textContent ?? '';
  for (const banned of [
    'OpenAI',
    'openai',
    'voice.',
    'output_mode_text',
    'session',
  ])
    assert.ok(!text.includes(banned), banned);
  strip.unmount();
});

test('text mode: the text choice is selected, "続ける" is disabled without a spinner, and choosing voice asks main to switch back', async () => {
  const strip = await mount(
    shownVoice({ reply_mode: 'text', can_continue: false }),
  );
  const voice = button(strip.container, VOICE_LABELS.replyVoice);
  const text = button(strip.container, VOICE_LABELS.replyText);
  assert.equal(
    text.getAttribute('aria-pressed') ?? text.getAttribute('aria-checked'),
    'true',
  );
  assert.equal(
    voice.getAttribute('aria-pressed') ?? voice.getAttribute('aria-checked'),
    'false',
  );
  const continueButton = button(strip.container, VOICE_LABELS.continueName);
  assert.equal(continueButton.disabled, true);
  assert.equal(continueButton.getAttribute('data-continue'), 'unavailable');
  assert.equal(continueButton.querySelector('svg'), null);
  await act(async () => voice.click());
  assert.deepEqual(strip.calls, ['reply:voice']);
  strip.unmount();
});

test('without controls (an older view) the strip draws no controls row, and hidden voice draws nothing to operate', async () => {
  const plain = await mount(shownVoice(), { controls: false });
  assert.equal(plain.container.querySelector('[data-controls-row]'), null);
  plain.unmount();
  const hidden = await mount({ visibility: 'hidden' });
  assert.equal(hidden.container.querySelector('[data-controls-row]'), null);
  assert.equal(
    hidden.container.querySelector(
      `[aria-label="${VOICE_LABELS.stopPlayback}"]`,
    ),
    null,
  );
  hidden.unmount();
});
