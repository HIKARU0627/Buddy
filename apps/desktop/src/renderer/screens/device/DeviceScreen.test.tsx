// 端末の画面の試験（ADR 0015・0024）。HeroUI の部品をサーバー描画（react-dom/server）で HTML にして、
// 表示する内容・読み上げのラベル・ボタンの要素を確かめる。押したときの要求は、ボタンの onPress を呼んで確かめる
// （DOM を使わない。クリック・キーボードでの実際の操作は Electron の画面で確かめる）。期待値の文言は手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopStatusBar,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import { deviceActions } from '../../state/desktop-state.js';
import type {
  DesktopViewState,
  DeviceActions,
} from '../../state/desktop-state.js';
import { DeviceScreen } from './DeviceScreen.js';
import { IoControls } from './IoControls.js';

const STOP = '■ この端末の入出力を停止';
const RESUME = '▶ この端末で再開する';
const HIDE = 'ウィンドウを閉じる（トレイに残ります）';
const QUIT = 'クライアントを終了（中枢は止めません）';

const shown = (
  stop_scope: 'none' | 'local' | 'guest' | 'global',
): DesktopStatusBar => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope,
  input_permitted: stop_scope === 'none',
  io_epoch: '7',
  voice_state: null,
  hub_connection: 'not_connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: false,
  safety_stopped: null,
});

const lockEvent: Extract<
  DesktopIpcNotification,
  { channel: 'desktop.power_event' }
> = {
  channel: 'desktop.power_event',
  event: 'lock_screen',
  source: 'os_event',
  observed_at: '2026-10-21T01:02:03.000Z',
};

const noop: DeviceActions = {
  stop: () => undefined,
  resume: null,
  hideWindow: () => undefined,
  quit: () => undefined,
};

function render(state: DesktopViewState, actions?: DeviceActions): string {
  return renderToStaticMarkup(
    <AppProviders>
      <DeviceScreen
        state={state}
        actions={actions ?? deviceActions(state.status, () => undefined)}
      />
    </AppProviders>,
  );
}

const view = (
  status: DesktopStatusBar | null,
  extra: Partial<DesktopViewState> = {},
): DesktopViewState => ({
  status,
  powerLog: [],
  message: null,
  connection: null,
  ...extra,
});

// HTML の button 要素の文字（React Aria の Button は <button type="button"> を出す）。
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/gu)].map(
    (match) => {
      assert.match(match[1] ?? '', /\btype="button"/u);
      assert.doesNotMatch(match[1] ?? '', /tabindex="-1"/u);
      assert.doesNotMatch(match[1] ?? '', /\bdisabled\b/u);
      return match[2] ?? '';
    },
  );
}

// 要素の木から onPress を持つ部品を探す（IoControls はフックを使わないので関数として呼べる）。
function pressables(node: ReactNode): Map<string, () => void> {
  const found = new Map<string, () => void>();
  const walk = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current as ReactNode[]) walk(child);
      return;
    }
    if (!isValidElement(current)) return;
    const props = current.props as {
      onPress?: unknown;
      children?: ReactNode;
    };
    if (
      typeof props.onPress === 'function' &&
      typeof props.children === 'string'
    )
      found.set(props.children, props.onPress as () => void);
    walk(props.children);
  };
  walk(node);
  return found;
}

test('before the first status the screen says it is checking and hides content', () => {
  const html = render(view(null));
  assert.match(html, /<header role="status">/u);
  assert.match(html, /状態を確認しています…/u);
  assert.deepEqual(buttonLabels(html), [STOP, HIDE, QUIT]);
  assert.doesNotMatch(html, /電源とロックの記録/u);
  assert.doesNotMatch(html, /aria-label="内容"/u);
});

test('while locked or unknown the status, content and log are not drawn', () => {
  const locked = render(
    view(
      { visibility: 'hidden', lock_state: 'locked' },
      { powerLog: [lockEvent] },
    ),
  );
  assert.match(locked, /🔒 端末がロック中のため、内容を隠しています。/u);
  assert.doesNotMatch(locked, /<dt|世代|電源とロックの記録|画面のロック/u);
  assert.deepEqual(buttonLabels(locked), [STOP, HIDE, QUIT]);

  const unknown = render(view({ visibility: 'hidden', lock_state: 'unknown' }));
  assert.match(
    unknown,
    /？ ロック状態を確認できないため、内容を隠しています。/u,
  );
  assert.doesNotMatch(unknown, /電源とロックの記録/u);
});

test('when accepting, the status, content notice and empty log are shown without resume', () => {
  const html = render(view(shown('none')));
  assert.match(html, /この端末の入出力:/u);
  assert.match(html, /<strong>● 受付中<\/strong>/u);
  assert.match(html, /（世代 7）/u);
  assert.match(html, /<dd[^>]*>未接続<\/dd>/u);
  assert.match(html, /未対応（B05 で追加）/u);
  assert.match(html, /<dd[^>]*>なし<\/dd>/u);
  assert.match(html, /会話・候補の表示は B02 以降で追加します。/u);
  assert.match(html, /記録はまだありません。/u);
  assert.deepEqual(buttonLabels(html), [STOP, HIDE, QUIT]);
});

test('when this device is stopped, resume is offered and the log is listed', () => {
  const html = render(view(shown('local'), { powerLog: [lockEvent] }));
  assert.match(html, /<strong>■ 停止中（この端末）<\/strong>/u);
  assert.match(
    html,
    /「この端末で再開する」を押すまで、内容の受付と表示を再開しません。/u,
  );
  assert.deepEqual(buttonLabels(html), [STOP, RESUME, HIDE, QUIT]);
  assert.match(html, /<time[^>]*dateTime="2026-10-21T01:02:03.000Z"/iu);
  assert.match(html, /画面のロック/u);
  assert.match(html, /OS からの通知/u);
});

test('guest and global stops are shown without the resume button', () => {
  for (const [scope, label] of [
    ['guest', '■ 停止中（来客モード）'],
    ['global', '■ 停止中（全体停止）'],
  ] as const) {
    const html = render(view(shown(scope)));
    assert.match(html, new RegExp(`<strong>${label}</strong>`, 'u'));
    assert.deepEqual(buttonLabels(html), [STOP, HIDE, QUIT]);
  }
});

test('a rejection message is announced as an alert with a symbol', () => {
  const html = render(
    view(shown('local'), {
      message: 'ウィンドウを前面に表示してから操作してください。',
    }),
  );
  assert.match(
    html,
    /role="alert"[^>]*>.*⚠ ウィンドウを前面に表示してから操作してください。/u,
  );
  assert.doesNotMatch(render(view(shown('local'))), /role="alert"/u);
});

test('sections and headings keep their labels for screen readers', () => {
  const html = render(view(shown('none')));
  assert.match(html, /<section aria-label="操作">/u);
  assert.match(html, /<section aria-label="内容">/u);
  assert.match(html, /<section aria-label="電源とロックの記録">/u);
  assert.match(html, /<h2[^>]*>内容<\/h2>/u);
  assert.match(html, /<h2[^>]*>電源とロックの記録<\/h2>/u);
  assert.match(html, /<main\b/u);
});

test('pressing stop sends desktop.io_stop', () => {
  const sent: DesktopIpcRequest[] = [];
  const actions = deviceActions(shown('none'), (built) => sent.push(built));
  const buttons = pressables(IoControls({ actions }));
  assert.deepEqual([...buttons.keys()], [STOP, HIDE, QUIT]);
  buttons.get(STOP)?.();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.channel, 'desktop.io_stop');
  assert.equal(sent[0]?.payload, null);
});

test('pressing resume sends desktop.io_resume with the shown io_epoch', () => {
  const sent: DesktopIpcRequest[] = [];
  const actions = deviceActions(shown('local'), (built) => sent.push(built));
  const buttons = pressables(IoControls({ actions }));
  assert.deepEqual([...buttons.keys()], [STOP, RESUME, HIDE, QUIT]);
  buttons.get(RESUME)?.();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.channel, 'desktop.io_resume');
  assert.deepEqual(sent[0]?.payload, { expected_io_epoch: '7' });
});

test('pressing hide and quit sends their channels and nothing else', () => {
  const sent: DesktopIpcRequest[] = [];
  const actions = deviceActions(shown('local'), (built) => sent.push(built));
  const buttons = pressables(IoControls({ actions }));
  buttons.get(HIDE)?.();
  buttons.get(QUIT)?.();
  assert.deepEqual(
    sent.map((built) => built.channel),
    ['desktop.window_hide', 'desktop.client_quit'],
  );
});

test('the screen draws with given actions without calling them', () => {
  let called = false;
  const spy: DeviceActions = {
    ...noop,
    stop: () => {
      called = true;
    },
  };
  render(view(shown('local')), spy);
  assert.equal(called, false);
});
