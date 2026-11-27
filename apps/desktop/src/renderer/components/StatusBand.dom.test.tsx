// 上の中央の島（ADR 0181 の段階 2）を happy-dom に React で実際に描き、時間が過ぎると畳むこと、島にフォーカスがある間は
// 畳まないこと、「確認が必要な操作を見る」が同じ画面の見出しへフォーカスを移すこと（確認・承認の要求は送らない）を確かめる。
// 期待値は手で書いた。本物のブラウザ・物理の入力ではない（見た目はスクリーンショットで確かめる）。
import { happy } from '../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopStatusBar } from '@buddy/contracts';
import { AppProviders } from '../app/AppProviders.js';
import type { IslandSignals } from '../state/island-state.js';
import { StatusBand } from './StatusBand.js';

after(async () => {
  await happy.happyDOM.close();
});

const T = 2_000_000;

const status: DesktopStatusBar = {
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '3',
  voice_state: null,
  hub_connection: 'not_connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
};

const attention: IslandSignals = {
  attentionCount: 1,
  attentionRaisedAt: T,
  attentionRaisedCount: 1,
  result: null,
};

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let stops = 0;
  const draw = (now: number, signals: IslandSignals) =>
    act(() =>
      root.render(
        <AppProviders>
          <StatusBand
            status={status}
            connection={null}
            now={now}
            onStop={() => {
              stops += 1;
            }}
            island={signals}
          />
          <h2 id="attention-heading" tabIndex={-1}>
            確認が必要な操作
          </h2>
        </AppProviders>,
      ),
    );
  const section = () => host.querySelector('section[aria-label="状態の島"]');
  const cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, draw, section, cleanup, stops: () => stops };
}

const buttonNamed = (host: Element, name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === name,
  );
  assert.ok(found, name);
  return found as HTMLButtonElement;
};

test('the island closes after its time and stays open while focus is inside', async () => {
  const realNow = Date.now;
  const view = mount();
  try {
    await view.draw(T + 1_000, attention);
    assert.equal(view.section()?.getAttribute('data-island'), 'expanded');
    // 8 秒が過ぎると畳む。
    await view.draw(T + 8_000, attention);
    assert.equal(view.section()?.getAttribute('data-island'), 'compact');
    // 3 秒後に島の中のボタンへフォーカスを置くと、時間が過ぎても畳まない。
    await view.draw(T + 1_000, attention);
    Date.now = () => T + 3_000;
    await act(async () =>
      buttonNamed(view.host, '確認が必要な操作を見る').focus(),
    );
    await view.draw(T + 20_000, attention);
    assert.equal(view.section()?.getAttribute('data-island'), 'expanded');
    // フォーカスが島の外へ出ると畳む。
    await act(async () =>
      buttonNamed(view.host, '確認が必要な操作を見る').blur(),
    );
    await view.draw(T + 20_001, attention);
    assert.equal(view.section()?.getAttribute('data-island'), 'compact');
  } finally {
    Date.now = realNow;
    view.cleanup();
  }
});

test('the way to the list moves focus to the heading on the same screen and stops nothing', async () => {
  const view = mount();
  try {
    await view.draw(T + 1_000, attention);
    await act(async () =>
      buttonNamed(view.host, '確認が必要な操作を見る').click(),
    );
    assert.equal(document.activeElement?.id, 'attention-heading');
    assert.equal(view.stops(), 0);
    // 停止は 1 回で効く（確認を挟まない）。
    await act(async () => buttonNamed(view.host, '■ 入出力を停止').click());
    assert.equal(view.stops(), 1);
  } finally {
    view.cleanup();
  }
});
