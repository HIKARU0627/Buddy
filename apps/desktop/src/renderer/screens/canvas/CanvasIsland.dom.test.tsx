// キャンバス表示の上の中央の島（ADR 0181 の段階 4）を happy-dom に React で実際に描き、停止が 1 回で効くこと・止まった後は
// 停止を出さないこと、パネルを出すボタンと「確認が必要な操作を見る」がパネルを出す要求だけを送ること（停止・承認は送らない）、
// ポインターが島にある間は広げた形を畳まず、離れると畳むことを確かめる。期待値は手で書いた。
// 本物のブラウザ・Electron の窓（キー入力を受けない窓・透明な窓）・物理の入力ではない。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopStatusBar } from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import { islandView } from '../../state/island-state.js';
import type { IslandSignals } from '../../state/island-state.js';
import { privacyMarks } from '../../state/status-panel-state.js';
import { CanvasIsland, useIslandHold } from './CanvasIsland.js';

after(async () => {
  await happy.happyDOM.close();
});

const T = 3_000_000;

const running: DesktopStatusBar = {
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '4',
  voice_state: null,
  hub_connection: 'connected',
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

// 島の窓（RoleWindow の IslandWindow）と同じ組み立て: 触れている時刻を useIslandHold で持ち、islandView で形を決める。
function Harness({
  status,
  now,
  signals,
  onStop,
  onOpenPanel,
}: {
  readonly status: DesktopStatusBar;
  readonly now: number;
  readonly signals: IslandSignals;
  readonly onStop: () => void;
  readonly onOpenPanel: () => void;
}) {
  const [holdingSince, onHoldChange] = useIslandHold();
  return (
    <CanvasIsland
      view={islandView({
        status,
        connection: null,
        now,
        signals,
        holdingSince,
      })}
      pending={1}
      summaryLabel={'Buddy の状態: 受付中、確認が必要な操作 1\u00a0件'}
      privacy={privacyMarks(status)}
      onStop={onStop}
      onOpenPanel={onOpenPanel}
      onHoldChange={onHoldChange}
    />
  );
}

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const sent: string[] = [];
  const draw = (
    now: number,
    signals: IslandSignals,
    status: DesktopStatusBar = running,
  ) =>
    act(() =>
      root.render(
        <AppProviders>
          <Harness
            status={status}
            now={now}
            signals={signals}
            onStop={() => sent.push('stop')}
            onOpenPanel={() => sent.push('panel')}
          />
        </AppProviders>,
      ),
    );
  const section = () => host.querySelector('section[aria-label="状態の島"]');
  const button = (name: string): HTMLButtonElement | null =>
    ([...host.querySelectorAll('button')].find(
      (entry) =>
        entry.getAttribute('aria-label')?.startsWith(name) === true ||
        entry.textContent === name,
    ) as HTMLButtonElement | undefined) ?? null;
  const cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, draw, section, button, cleanup, sent };
}

test('the stop works with one press; once stopped the island offers no stop', async () => {
  const view = mount();
  try {
    await view.draw(T, attention);
    const stop = view.button('入出力を停止');
    assert.ok(stop);
    await act(async () => stop.click());
    // 確認を挟まず 1 回で効く（停止の要求だけ。パネル・承認は送らない）。
    assert.deepEqual(view.sent, ['stop']);
    await view.draw(T, attention, {
      ...running,
      stop_scope: 'local',
      input_permitted: false,
    });
    assert.equal(view.button('入出力を停止'), null);
    // パネルを出すボタンは残る（再開はパネルから）。
    assert.ok(view.button('状態のパネルを出す'));
  } finally {
    view.cleanup();
  }
});

test('the panel button and the way to the list only ask for the panel', async () => {
  const view = mount();
  try {
    await view.draw(T + 1_000, attention);
    assert.equal(view.section()?.getAttribute('data-island'), 'expanded');
    const panel = view.button('状態のパネルを出す');
    const list = view.button('確認が必要な操作を見る');
    assert.ok(panel);
    assert.ok(list);
    await act(async () => panel.click());
    await act(async () => list.click());
    assert.deepEqual(view.sent, ['panel', 'panel']);
  } finally {
    view.cleanup();
  }
});

test('the expanded island stays open while the pointer is on it and closes after the pointer leaves', async () => {
  const realNow = Date.now;
  const view = mount();
  try {
    await view.draw(T + 1_000, attention);
    assert.equal(view.section()?.getAttribute('data-island'), 'expanded');
    // 2 秒後にポインターが島に入る。8 秒を過ぎても畳まない（WCAG 2.2.1。U395）。
    Date.now = () => T + 2_000;
    const section = view.section();
    assert.ok(section);
    await act(async () => {
      section.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, relatedTarget: null }),
      );
    });
    await view.draw(T + 20_000, attention);
    assert.equal(view.section()?.getAttribute('data-island'), 'expanded');
    // ポインターが島の外へ出ると畳む。
    await act(async () => {
      section.dispatchEvent(
        new PointerEvent('pointerout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    await view.draw(T + 20_001, attention);
    assert.equal(view.section()?.getAttribute('data-island'), 'compact');
  } finally {
    Date.now = realNow;
    view.cleanup();
  }
});
