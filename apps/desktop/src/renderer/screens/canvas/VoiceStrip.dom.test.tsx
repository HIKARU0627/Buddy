// 状態の層のパネルの音声の段（B05-06、ADR 0050）の画面側の試験。音声の状態から決める表示（純粋な関数）と、happy-dom に
// React で実際に描いた段（記号・印・「続ける」・同意の取り消し・知らせ）を確かめる。期待値は手で書いた。
// 本物のブラウザ・物理の入力・OS の確認ダイアログではない（見た目はスクリーンショットで確かめる）。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopStatusBar, DesktopVoiceView } from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  applyNotification,
  applyResponse,
  INITIAL_VIEW_STATE,
} from '../../state/desktop-state.js';
import {
  privacyMarks,
  voiceStripView,
} from '../../state/status-panel-state.js';
import { VoiceStrip, VOICE_LABELS } from './VoiceStrip.js';

after(async () => {
  await happy.happyDOM.close();
});

const ID = '00000000-0000-4000-8000-000000000001';

const shownVoice = (
  overrides: Partial<Extract<DesktopVoiceView, { visibility: 'shown' }>> = {},
): DesktopVoiceView =>
  ({
    visibility: 'shown',
    voice_state: 'waiting_wake_word',
    external_send: false,
    consent: 'granted',
    can_continue: true,
    notice: null,
    ...overrides,
  }) as DesktopVoiceView;

const status: DesktopStatusBar = {
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '3',
  voice_state: 'waiting_wake_word',
  hub_connection: 'not_connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
};

test('the strip view: state mark, external mark, continue and revoke follow the main view only', () => {
  assert.deepEqual(voiceStripView(shownVoice()), {
    kind: 'shown',
    line: { tone: 'neutral', mark: 'circle', text: '呼びかけ待ち' },
    external: 'off',
    continueState: 'ready',
    revocable: true,
    notice: null,
  });
  assert.deepEqual(
    voiceStripView(
      shownVoice({
        voice_state: 'conversation_live',
        external_send: true,
        can_continue: false,
      }),
    ),
    {
      kind: 'shown',
      line: { tone: 'warning', mark: 'warning', text: '会話中' },
      external: 'on',
      continueState: 'unavailable',
      revocable: true,
      notice: null,
    },
  );
  // 止めた直後で、停止の ACK を待っている間: 状態は停止中でも、外部へ送っている印は消さない。
  assert.deepEqual(
    voiceStripView(
      shownVoice({
        voice_state: 'device_stopped',
        external_send: true,
        can_continue: false,
        consent: 'required',
        notice: 'input_interrupted',
      }),
    ),
    {
      kind: 'shown',
      line: { tone: 'warning', mark: 'warning', text: 'この端末では停止中' },
      external: 'on',
      continueState: 'unavailable',
      revocable: false,
      notice: '入力を中断しました。',
    },
  );
  // 始めている途中（呼びかけ待ちで送っていないが、押せない）。
  assert.equal(
    voiceStripView(shownVoice({ can_continue: false })).continueState,
    'starting',
  );
  assert.deepEqual(
    voiceStripView(
      shownVoice({
        voice_state: null,
        can_continue: false,
        notice: 'not_started',
      }),
    ),
    {
      kind: 'shown',
      line: { tone: 'neutral', mark: 'none', text: '未受信' },
      external: 'unknown',
      continueState: 'unavailable',
      revocable: true,
      notice: '声の会話を始められませんでした。',
    },
  );
  assert.equal(voiceStripView({ visibility: 'hidden' }).kind, 'hidden');
  assert.equal(voiceStripView(null).kind, 'hidden');
});

test('the tab mark for sending voice outside follows the voice view first (including the time before the stop ACK)', () => {
  const mark = (
    voice: DesktopVoiceView | null,
    bar: DesktopStatusBar = status,
  ) =>
    privacyMarks(bar, voice).find((entry) => entry.key === 'voice_external')
      ?.state;
  assert.equal(mark(shownVoice()), 'off');
  assert.equal(
    mark(
      shownVoice({
        voice_state: 'device_stopped',
        external_send: true,
        can_continue: false,
      }),
      {
        ...status,
        stop_scope: 'local',
        input_permitted: false,
        voice_state: 'device_stopped',
      },
    ),
    'on',
  );
  assert.equal(
    mark(shownVoice({ voice_state: null, can_continue: false })),
    'unknown',
  );
  // 音声の状態がまだない（受け取る前）: 状態欄の音声の状態から決める。
  assert.equal(mark(null), 'off');
  assert.equal(
    mark(null, { visibility: 'hidden', lock_state: 'locked' }),
    'hidden',
  );
});

test('the view state takes the voice notification and the voice response', () => {
  const notified = applyNotification(INITIAL_VIEW_STATE, {
    channel: 'desktop.voice_changed',
    voice: shownVoice(),
  });
  assert.deepEqual(notified.voice, shownVoice());
  const responded = applyResponse(notified, {
    request_id: ID,
    channel: 'desktop.voice_continue',
    outcome: 'ok',
    voice: shownVoice({ can_continue: false }),
  });
  assert.deepEqual(responded.voice, shownVoice({ can_continue: false }));
  const rejected = applyResponse(responded, {
    request_id: ID,
    channel: 'desktop.voice_continue',
    outcome: 'rejected',
    reason: 'voice_unavailable',
  });
  // 拒否は文言だけで、音声の状態は変えない。理由のコードを文言に出さない。
  assert.deepEqual(rejected.voice, shownVoice({ can_continue: false }));
  assert.equal(rejected.message?.channel, 'desktop.voice_continue');
  assert.doesNotMatch(rejected.message?.text ?? '', /voice_unavailable|_/u);
});

async function mount(
  view: ReturnType<typeof voiceStripView>,
  message: string | null = null,
) {
  const calls: string[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProviders>
        <VoiceStrip
          view={view}
          message={message}
          onContinue={() => calls.push('continue')}
          onRevoke={() => calls.push('revoke')}
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

const buttonNamed = (container: HTMLElement, name: string) => {
  const found = container.querySelector(`button[aria-label="${name}"]`);
  assert(found instanceof HTMLElement, name);
  return found as HTMLButtonElement;
};

test('waiting: "続ける" is enabled and calls main; the revoke button sits next to the external mark', async () => {
  const strip = await mount(voiceStripView(shownVoice()));
  const continueButton = buttonNamed(
    strip.container,
    VOICE_LABELS.continueName,
  );
  assert.equal(continueButton.textContent, VOICE_LABELS.continue);
  assert.equal(continueButton.disabled, false);
  await act(async () => continueButton.click());
  const revoke = buttonNamed(strip.container, VOICE_LABELS.revokeName);
  await act(async () => revoke.click());
  assert.deepEqual(strip.calls, ['continue', 'revoke']);
  const external = strip.container.querySelector('[data-external]');
  assert.equal(external?.getAttribute('data-external'), 'off');
  assert.equal(
    external?.getAttribute('aria-label'),
    '音声を外部へ送っていない',
  );
  // 印と取り消しは同じ段の枠の中にあり、取り消しは印の後（下の行）に並ぶ。
  assert.equal(external?.parentElement, revoke.parentElement?.parentElement);
  assert.ok(
    external !== null &&
      (external.compareDocumentPosition(revoke) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
  );
  strip.unmount();
});

test('talking: the external mark is filled, "続ける" is disabled, no reason codes or provider names appear', async () => {
  const strip = await mount(
    voiceStripView(
      shownVoice({
        voice_state: 'conversation_live',
        external_send: true,
        can_continue: false,
      }),
    ),
  );
  assert.equal(
    strip.container
      .querySelector('[data-external]')
      ?.getAttribute('data-external'),
    'on',
  );
  assert.equal(
    buttonNamed(strip.container, VOICE_LABELS.continueName).disabled,
    true,
  );
  const text = strip.container.textContent ?? '';
  assert.match(text, /会話中/u);
  for (const banned of [
    'OpenAI',
    'openai',
    'os_lock',
    'device_io_stop',
    'voice.',
  ])
    assert.ok(!text.includes(banned), banned);
  await act(async () =>
    buttonNamed(strip.container, VOICE_LABELS.continueName).click(),
  );
  assert.deepEqual(strip.calls, []);
  strip.unmount();
});

test('without consent there is no revoke button; notices and refusals are shown under the strip', async () => {
  const strip = await mount(
    voiceStripView(
      shownVoice({
        consent: 'required',
        notice: 'input_interrupted',
        voice_state: 'device_stopped',
        can_continue: false,
      }),
    ),
    '今は声の会話を始められません。少し待ってから、もう一度押してください。',
  );
  assert.equal(
    strip.container.querySelector(
      `button[aria-label="${VOICE_LABELS.revokeName}"]`,
    ),
    null,
  );
  const alerts = [...strip.container.querySelectorAll('[role="alert"]')].map(
    (node) => node.textContent,
  );
  assert.deepEqual(alerts, [
    '入力を中断しました。',
    '今は声の会話を始められません。少し待ってから、もう一度押してください。',
  ]);
  strip.unmount();
});

test('while locked the strip keeps its place as a grey block with no content', async () => {
  const strip = await mount(voiceStripView({ visibility: 'hidden' }));
  const block = strip.container.querySelector('[data-voice="hidden"]');
  assert.ok(block);
  assert.equal(block.getAttribute('aria-label'), VOICE_LABELS.hidden);
  assert.equal(strip.container.querySelectorAll('button').length, 0);
  strip.unmount();
});
