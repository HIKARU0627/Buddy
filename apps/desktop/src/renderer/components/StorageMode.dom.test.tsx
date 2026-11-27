// 保存モードの切り替えの欄と、記録しない間の島の印（UI-05 の段階 6、ADR 0189）を happy-dom に React で実際に描いて確かめる。
// 確かめること: 欄は 3 つの選択肢を決まった順で出し、今の値（中枢の値）だけを押された形（aria-pressed・primary）にする、
// 今の値を押しても送らず、ほかを押すとその保存モードだけを送る（押しても表示は変えない）、受け取っていない・出せないときの
// 形、拒否の文言、島の小さい形の「記録しない」の札（記号と文字。読み上げの名前）が記録しない間だけ出ること（従来の窓の島と
// キャンバス表示の島の両方。ロック中は出さない）。期待値は手で書いた。本物のブラウザ・Electron の窓ではない。
import { happy } from '../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { DesktopStatusBar, StorageMode } from '@buddy/contracts';
import { AppProviders } from '../app/AppProviders.js';
import { islandView } from '../state/island-state.js';
import { privacyMarks } from '../state/status-panel-state.js';
import { storageModeControlView } from '../state/storage-mode-state.js';
import { CanvasIsland } from '../screens/canvas/CanvasIsland.js';
import { InputBar } from '../screens/canvas/InputBar.js';
import { StatusBand } from './StatusBand.js';
import { StorageModeControl } from './StorageMode.js';

after(async () => {
  await happy.happyDOM.close();
});

const T = 3_000_000;

const shown = (storage: StorageMode | null): DesktopStatusBar => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '4',
  voice_state: null,
  hub_connection: 'connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: storage,
  budget_held: null,
  safety_stopped: null,
});

const LOCKED: DesktopStatusBar = { visibility: 'hidden', lock_state: 'locked' };

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
  const buttons = () => [
    ...host.querySelectorAll<HTMLButtonElement>('button[data-storage-mode]'),
  ];
  const mark = () => host.querySelector('[data-private-mark]');
  return { host, draw, cleanup, buttons, mark };
}

test('the control shows three fixed choices and presses only the hub value', async () => {
  const view = mount();
  const sent: StorageMode[] = [];
  try {
    await view.draw(
      <StorageModeControl
        view={storageModeControlView(shown('extended'))}
        message={null}
        onChange={(mode) => sent.push(mode)}
      />,
    );
    assert.deepEqual(
      view
        .buttons()
        .map((button) => [
          button.getAttribute('data-storage-mode'),
          button.textContent,
          button.getAttribute('aria-pressed'),
        ]),
      [
        ['normal', '通常（7\u00a0日）', 'false'],
        ['extended', '継続相談（30\u00a0日）', 'true'],
        ['private', '記録しない', 'false'],
      ],
    );
    // 見出しと今の値（記号と文言）。欄は見出しで名前を持つ。
    const group = view.host.querySelector('[role="group"]');
    assert.ok(group);
    const heading = view.host.querySelector(
      `#${group.getAttribute('aria-labelledby') ?? ''}`,
    );
    assert.equal(heading?.textContent, '保存モード');
    assert.match(group.textContent ?? '', /●継続相談（30\u00a0日）/u);
    // 今の値を押しても送らない。ほかを押すとその保存モードだけを送る。押しても表示（押された形）は変えない。
    const [normal, extended, privateMode] = view.buttons();
    await act(async () => extended?.click());
    assert.deepEqual(sent, []);
    await act(async () => privateMode?.click());
    await act(async () => normal?.click());
    assert.deepEqual(sent, ['private', 'normal']);
    assert.equal(
      view.buttons()[1]?.getAttribute('aria-pressed'),
      'true',
      'the pressed state follows the hub value only',
    );
  } finally {
    view.cleanup();
  }
});

test('the control while private, before the value arrives, hidden, and with a refusal', async () => {
  const view = mount();
  try {
    await view.draw(
      <StorageModeControl
        view={storageModeControlView(shown('private'))}
        message={null}
        onChange={() => undefined}
      />,
    );
    // 記録しない間は「記録しない」が押された形で、今の値は ■ と文言。
    assert.equal(view.buttons()[2]?.getAttribute('aria-pressed'), 'true');
    assert.match(
      view.host.querySelector('[role="group"]')?.textContent ?? '',
      /■記録しない/u,
    );
    // 受け取っていない: どれも押された形にせず、受け取っていないことを文字で出す（選ぶことはできる）。
    await view.draw(
      <StorageModeControl
        view={storageModeControlView(shown(null))}
        message={null}
        onChange={() => undefined}
      />,
    );
    assert.deepEqual(
      view.buttons().map((button) => button.getAttribute('aria-pressed')),
      ['false', 'false', 'false'],
    );
    assert.match(
      view.host.textContent ?? '',
      /今の保存モードを中枢から受け取っていません。/u,
    );
    // 拒否の文言は欄のすぐ下に alert で出す。
    await view.draw(
      <StorageModeControl
        view={storageModeControlView(shown('normal'))}
        message="保存モードを切り替えられませんでした。"
        onChange={() => undefined}
      />,
    );
    assert.equal(
      view.host.querySelector('[role="alert"]')?.textContent,
      '保存モードを切り替えられませんでした。',
    );
    // ロック中・中枢に接続していないときは欄を出さない。
    for (const status of [
      LOCKED,
      { ...shown('normal'), hub_connection: 'unreachable' } as DesktopStatusBar,
    ]) {
      await view.draw(
        <StorageModeControl
          view={storageModeControlView(status)}
          message={null}
          onChange={() => undefined}
        />,
      );
      assert.equal(view.host.querySelector('[role="group"]'), null);
    }
  } finally {
    view.cleanup();
  }
});

test('the canvas island shows the private mark with a symbol and words only while private', async () => {
  const view = mount();
  const island = (status: DesktopStatusBar, privateMode: boolean) => (
    <CanvasIsland
      view={islandView({
        status,
        connection: null,
        now: T,
        signals: null,
        holdingSince: null,
      })}
      pending={0}
      summaryLabel="Buddy の状態: 受付中"
      privacy={privacyMarks(status)}
      privateMode={privateMode}
      onStop={() => undefined}
      onOpenPanel={() => undefined}
    />
  );
  try {
    await view.draw(island(shown('private'), true));
    const mark = view.mark();
    assert.ok(mark);
    assert.equal(mark.getAttribute('role'), 'img');
    assert.equal(mark.getAttribute('aria-label'), '記録しないモード中');
    // 記号（記録の丸に斜めの線の SVG）と文字の両方。面は accent-soft・縁は accent-soft-foreground・錠剤型。
    assert.ok(mark.querySelector('svg'));
    assert.equal(mark.textContent, '記録しない');
    assert.match(mark.className, /rounded-full/u);
    assert.match(mark.className, /h-6/u);
    assert.match(mark.className, /bg-accent-soft/u);
    assert.match(mark.className, /border-accent-soft-foreground/u);
    // 専用の記号の「記録しないモード」も塗った面（on）。
    assert.equal(
      view.host
        .querySelector('[data-privacy="private_mode"]')
        ?.getAttribute('data-state'),
      'on',
    );
    // 島から切り替えるボタンはない。
    assert.equal(view.buttons().length, 0);
    await view.draw(island(shown('normal'), false));
    assert.equal(view.mark(), null);
    // ロック中（内容を隠す形）は、渡されても札を出さない。
    await view.draw(island(LOCKED, true));
    assert.equal(view.mark(), null);
  } finally {
    view.cleanup();
  }
});

test('the legacy island shows the private mark next to the hub line only while private', async () => {
  const view = mount();
  const band = (status: DesktopStatusBar) => (
    <StatusBand
      status={status}
      connection={null}
      now={T}
      onStop={() => undefined}
    />
  );
  try {
    await view.draw(band(shown('private')));
    const mark = view.mark();
    assert.ok(mark);
    assert.equal(mark.textContent, '記録しない');
    // 島の中（状態の島の領域）にある。
    assert.ok(mark.closest('section[aria-label="状態の島"]'));
    // 項目の行の保存モードも「記録しない」。
    assert.match(view.host.textContent ?? '', /保存モード記録しない/u);
    await view.draw(band(shown('extended')));
    assert.equal(view.mark(), null);
    await view.draw(band(LOCKED));
    assert.equal(view.mark(), null);
  } finally {
    view.cleanup();
  }
});

// U477 の直し: キャンバス表示の入力バーは、記録しないと表示していたのに記録された発言の 1 文を、広がった領域に warning の
// 記号（⚠）と文言で出す（読み上げは status）。広がっていないときは出さない。
test('the input bar shows the recorded sentence with a warning mark', async () => {
  const view = mount();
  const sentence =
    '記録しないモードは送る前に終わっていたため、この発言は記録されました。';
  const bar = (expanded: boolean, notice: string | null) => (
    <InputBar
      line={{ tone: 'success', mark: 'dot', text: '受付中' }}
      enabled
      value=""
      onChange={() => undefined}
      onSubmit={() => undefined}
      sending={false}
      attention={false}
      canSummon
      onSummon={() => undefined}
      expanded={expanded}
      storageNotice={notice}
    />
  );
  try {
    await view.draw(bar(true, sentence));
    const notice = view.host.querySelector('[data-storage-notice]');
    assert.ok(notice);
    assert.equal(notice.getAttribute('role'), 'status');
    assert.equal(notice.textContent, sentence);
    assert.ok(notice.querySelector('svg[aria-hidden="true"]'));
    await view.draw(bar(false, sentence));
    assert.equal(view.host.querySelector('[data-storage-notice]'), null);
    await view.draw(bar(true, null));
    assert.equal(view.host.querySelector('[data-storage-notice]'), null);
  } finally {
    view.cleanup();
  }
});
