// 登録の画面の入力の誤りの 1 文（ADR 0181 の段階 3）を happy-dom に React で実際に描き、tones.ts の danger の対応（⚠ の記号と
// danger-soft-foreground の文字色。記号は読み上げない）で出ることを確かめる。押す前は出さない。期待値は手で書いた。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '../../app/AppProviders.js';
import { pairingActions } from '../../state/connection-state.js';
import type {
  PairingView,
  ShownConnection,
} from '../../state/connection-state.js';
import {
  INITIAL_VIEW_STATE,
  deviceActions,
} from '../../state/desktop-state.js';
import { PairingScreen } from './PairingScreen.js';

// InputOTP（input-otp）は Node の Event で input の要素へ dispatchEvent する。happy-dom の要素は自分の Event しか受けないので、
// この試験の間だけ Event を happy-dom のものにする（終わったら戻す）。
const nodeEvent = globalThis.Event;
globalThis.Event = happy.Event as unknown as typeof Event;

after(async () => {
  globalThis.Event = nodeEvent;
  await happy.happyDOM.close();
});

const FP = '0123456789abcdef'.repeat(4);

const connectionAt = (step: PairingView['step']): ShownConnection => ({
  visibility: 'shown',
  registration: 'unregistered',
  link: 'not_connected',
  link_reason: null,
  last_confirmed_at: null,
  retry_at: null,
  pairing: {
    step,
    host: '100.64.0.10',
    port: 47443,
    fingerprint: FP,
    claim_expires_at: null,
    failure: null,
    claim_check: null,
    cancelable: true,
  },
  hub_screen: false,
  hub_target: null,
  home_network: null,
  operations: [],
  budget_items: [],
});

async function mount(step: PairingView['step']) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const connection = connectionAt(step);
  await act(async () =>
    root.render(
      <AppProviders>
        <PairingScreen
          state={{ ...INITIAL_VIEW_STATE, connection }}
          connection={connection}
          actions={deviceActions(null, () => undefined)}
          pairing={pairingActions(() => undefined)}
          now={Date.now()}
        />
      </AppProviders>,
    ),
  );
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const press = async (host: Element, label: string) => {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  assert.ok(button, label);
  await act(async () => (button as HTMLButtonElement).click());
};

// 文を含む段落（p）を探す。
const paragraphWith = (host: Element, text: string) =>
  [...host.querySelectorAll('p')].find((p) => p.textContent === text) ?? null;

const assertDangerLine = (p: Element | null) => {
  assert.ok(p);
  // 記号は ⚠ の単色の SVG（読み上げない）で、文字色と同じ danger-soft-foreground。
  const icon = p.querySelector('svg');
  assert.ok(icon);
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.match(
    icon.getAttribute('class') ?? '',
    /text-danger-soft-foreground/u,
  );
};

test('a wrong fingerprint tail is an alert with the warning mark', async () => {
  const view = await mount('fingerprint_check');
  try {
    const text = '指紋の最後の 4 桁（0〜9・a〜f）を入れてください。';
    assert.equal(paragraphWith(view.host, text), null);
    await press(view.host, '最後の 4 桁を確かめて次へ');
    const p = paragraphWith(view.host, text);
    assertDangerLine(p);
    assert.equal(p?.getAttribute('role'), 'alert');
  } finally {
    view.cleanup();
  }
});

test('a missing one-time code is shown with the warning mark', async () => {
  const view = await mount('code_entry');
  try {
    const text = '8 桁の数字を入れてください。';
    assert.equal(paragraphWith(view.host, text), null);
    await press(view.host, '申請する');
    assertDangerLine(paragraphWith(view.host, text));
  } finally {
    view.cleanup();
  }
});
