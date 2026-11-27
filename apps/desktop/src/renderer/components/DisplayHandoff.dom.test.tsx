// 流れの表示先「このPCに出す」の欄（UI-05 の段階 5、ADR 0193）を happy-dom に React で実際に描いて確かめる。
// 確かめること: 見出しと今の表示先（記号と文言）、ボタンは表示先がこの端末でないときだけ出て、押すと何も持たずに 1 回呼ぶ
// （押しても表示は変えない）、止まっている間は押せず理由の 1 文を出す、出せないときは何も描かない、拒否の文言。
// 期待値は手で書いた。本物のブラウザ・Electron の窓ではない。
import { happy } from '../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { DesktopStatusBar } from '@buddy/contracts';
import { AppProviders } from '../app/AppProviders.js';
import { displayHandoffView } from '../state/display-handoff-state.js';
import { DisplayHandoffControl } from './DisplayHandoff.js';

after(async () => {
  await happy.happyDOM.close();
});

const shown = (
  target: 'this_device' | 'other_device' | null,
  permitted = true,
): DesktopStatusBar => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: permitted ? 'none' : 'local',
  input_permitted: permitted,
  io_epoch: '4',
  voice_state: null,
  hub_connection: 'connected',
  hub_last_confirmed_at: null,
  display_target: target,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (node: ReactNode) =>
    act(() => root.render(<AppProviders>{node}</AppProviders>));
  const cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  const button = () =>
    host.querySelector<HTMLButtonElement>(
      'button[data-display-handoff-button]',
    );
  return { host, draw, cleanup, button };
}

test('another device shows: the field names the target and the button calls once with nothing', async () => {
  const view = mount();
  let calls = 0;
  try {
    await view.draw(
      <DisplayHandoffControl
        view={displayHandoffView(shown('other_device'))}
        message={null}
        onHandoff={() => {
          calls += 1;
        }}
      />,
    );
    const group = view.host.querySelector('[role="group"]');
    assert.ok(group);
    const heading = view.host.querySelector(
      `#${group.getAttribute('aria-labelledby') ?? ''}`,
    );
    assert.equal(heading?.textContent, '表示先');
    assert.match(group.textContent ?? '', /他の端末/u);
    const button = view.button();
    assert.equal(button?.textContent, 'このPCに出す');
    assert.equal(
      button?.getAttribute('aria-label'),
      'キャンバスの表示先をこの端末に移す',
    );
    await act(async () => button?.click());
    assert.equal(calls, 1);
    // 押しても表示は変えない（今の表示先は中枢の値のまま）。
    assert.match(group.textContent ?? '', /他の端末/u);
  } finally {
    view.cleanup();
  }
});

test('this device shows: no button; unknown target: the button and the not-yet-received line', async () => {
  const view = mount();
  try {
    await view.draw(
      <DisplayHandoffControl
        view={displayHandoffView(shown('this_device'))}
        message={null}
        onHandoff={() => undefined}
      />,
    );
    assert.equal(view.button(), null);
    assert.match(view.host.textContent ?? '', /●この端末/u);
    await view.draw(
      <DisplayHandoffControl
        view={displayHandoffView(shown(null))}
        message={null}
        onHandoff={() => undefined}
      />,
    );
    assert.ok(view.button());
    assert.match(
      view.host.textContent ?? '',
      /表示先を中枢から受け取っていません。/u,
    );
  } finally {
    view.cleanup();
  }
});

test('while input is stopped the button is not offered and the reason is said; the refusal text sits under the field', async () => {
  const view = mount();
  try {
    await view.draw(
      <DisplayHandoffControl
        view={displayHandoffView(shown('other_device', false))}
        message="表示先が移ったか確かめられませんでした。"
        onHandoff={() => undefined}
      />,
    );
    assert.equal(view.button(), null);
    assert.match(
      view.host.textContent ?? '',
      /この端末の入出力を止めている間は、表示先を移せません。/u,
    );
    assert.match(
      view.host.textContent ?? '',
      /表示先が移ったか確かめられませんでした。/u,
    );
  } finally {
    view.cleanup();
  }
});

test('nothing is drawn while locked, unknown or not connected', async () => {
  const view = mount();
  try {
    for (const status of [
      null,
      { visibility: 'hidden', lock_state: 'locked' } as const,
      { visibility: 'hidden', lock_state: 'unknown' } as const,
      { ...shown('other_device'), hub_connection: 'unreachable' } as const,
    ]) {
      await view.draw(
        <DisplayHandoffControl
          view={displayHandoffView(status)}
          message="拒否の文言"
          onHandoff={() => undefined}
        />,
      );
      assert.equal(view.host.textContent, '');
    }
  } finally {
    view.cleanup();
  }
});
