// 端末の画面の試験（ADR 0015・0024）。HeroUI の部品をサーバー描画（react-dom/server）で HTML にして、
// 表示する内容・読み上げのラベル・ボタンの要素を確かめる。押したときの要求は、フックを使わない部品を関数として呼び、
// 要素の木の onPress を呼んで確かめる（DOM を使わない。クリック・キーボードでの実際の操作は Electron の画面で確かめる）。
// 期待値の文言は手で書く。時刻は端末の地域時間で組み立てる（clockOf と同じ計算はしない）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopConnectionView,
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopStatusBar,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import { AppFooter } from '../../components/AppFooter.js';
import { StopButton } from '../../components/StatusBand.js';
import {
  INITIAL_VIEW_STATE,
  deviceActions,
} from '../../state/desktop-state.js';
import type {
  DesktopViewState,
  DeviceActions,
  ShownStatus,
} from '../../state/desktop-state.js';
import { DeviceScreen } from './DeviceScreen.js';
import { StopBanner } from './StopBanner.js';

const STOP = '■ 入出力を停止';
const RESUME = 'この端末で再開する';
const HIDE = 'ウィンドウを閉じる';
const QUIT = 'Buddy を終了';

// 地域時間の 2026-10-21 10:02:03 と、その 1 分後を「今」にする。
const AT = new Date(2026, 9, 21, 10, 2, 3).toISOString();
const NOW = new Date(2026, 9, 21, 10, 3, 3).getTime();

const shown = (
  stop_scope: 'none' | 'local' | 'guest' | 'global',
  extra: Partial<ShownStatus> = {},
): ShownStatus => ({
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
  budget_held: null,
  safety_stopped: null,
  ...extra,
});

const lockEvent: Extract<
  DesktopIpcNotification,
  { channel: 'desktop.power_event' }
> = {
  channel: 'desktop.power_event',
  event: 'lock_screen',
  source: 'os_event',
  observed_at: AT,
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
        now={NOW}
        actions={actions ?? deviceActions(state.status, () => undefined)}
      />
    </AppProviders>,
  );
}

const view = (
  status: DesktopStatusBar | null,
  extra: Partial<DesktopViewState> = {},
): DesktopViewState => ({ ...INITIAL_VIEW_STATE, status, ...extra });

// HTML の button 要素の文字（React Aria の Button は <button type="button"> を出す）。
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gu)]
    .filter((match) => !/aria-expanded/u.test(match[1] ?? ''))
    .map((match) => {
      assert.match(match[1] ?? '', /\btype="button"/u);
      assert.doesNotMatch(match[1] ?? '', /tabindex="-1"/u);
      assert.doesNotMatch(match[1] ?? '', /\bdisabled\b/u);
      return (match[2] ?? '').replace(/<[^>]+>/gu, '');
    });
}

// 要素の木から onPress を持つ部品を探す（呼んだ部品はフックを使わない）。
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
  assert.match(html, /role="status"[^>]*>(<[^>]+>)*状態を確かめています。/u);
  assert.deepEqual(buttonLabels(html), [STOP, HIDE, QUIT]);
  assert.doesNotMatch(html, /電源とロックの記録|<main\b/u);
});

test('while locked or unknown the status, content and log are not drawn', () => {
  const locked = render(
    view(
      { visibility: 'hidden', lock_state: 'locked' },
      { powerLog: [lockEvent] },
    ),
  );
  assert.match(locked, /画面がロックされているため、内容を隠しています。/u);
  assert.doesNotMatch(locked, /<dt|電源とロックの記録|画面のロック|<main\b/u);
  assert.deepEqual(buttonLabels(locked), [STOP, HIDE, QUIT]);

  const unknown = render(view({ visibility: 'hidden', lock_state: 'unknown' }));
  assert.match(
    unknown,
    /ロック状態を確かめられないため、内容を隠しています。/u,
  );
  assert.doesNotMatch(unknown, /電源とロックの記録/u);
});

test('when accepting, the band shows the state and the five items with dashes', () => {
  const html = render(view(shown('none')));
  assert.match(html, /role="status"[^>]*><span[^>]*>入出力:<\/span>/u);
  assert.match(html, /受付中/u);
  assert.match(html, /中枢:<\/span>/u);
  assert.match(html, /未接続/u);
  for (const label of ['表示先', '音声', '保存モード', '予算保留', '安全停止'])
    assert.match(
      html,
      new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>—</dd>`, 'u'),
    );
  assert.match(html, /（— は中枢から未受信）/u);
  assert.doesNotMatch(html, /この端末の入出力を止めています/u);
  assert.doesNotMatch(html, /世代|B0\d/u);
  assert.deepEqual(buttonLabels(html), [STOP, HIDE, QUIT]);
});

test('received items are shown with their labels and the note disappears', () => {
  const html = render(
    view(
      shown('none', {
        storage_mode: 'private',
        budget_held: false,
        safety_stopped: true,
      }),
    ),
  );
  assert.match(html, /<dt[^>]*>保存モード<\/dt><dd[^>]*>記録しない<\/dd>/u);
  assert.match(html, /<dt[^>]*>予算保留<\/dt><dd[^>]*>なし<\/dd>/u);
  assert.match(html, /<dt[^>]*>安全停止<\/dt><dd[^>]*>安全停止中<\/dd>/u);
  assert.match(html, /（— は中枢から未受信）/u);
  const all = render(
    view(
      shown('none', {
        display_target: 'this_device',
        voice_state: 'waiting_wake_word',
        storage_mode: 'normal',
        budget_held: true,
        safety_stopped: false,
      }),
    ),
  );
  assert.doesNotMatch(all, /（— は中枢から未受信）/u);
});

test('when this device is stopped, the banner gives the cause, time and resume', () => {
  const html = render(
    view(shown('local'), {
      powerLog: [lockEvent],
      stopCause: { kind: 'power', event: 'lock_screen', at: AT },
    }),
  );
  assert.match(html, /この端末の入出力を止めています/u);
  assert.match(html, /10:02:03 に画面のロックで止まりました。/u);
  assert.match(html, /ウィンドウが前面にあるときだけ再開できます。/u);
  // main が止まっていることを確かめた後は、状態帯の停止のボタンを出さない（再開は帯の中）。
  assert.deepEqual(buttonLabels(html), [RESUME, HIDE, QUIT]);
  assert.match(html, /電源とロックの記録（1 件）/u);
  const button = render(
    view(shown('local'), { stopCause: { kind: 'button', at: AT } }),
  );
  assert.match(button, /10:02:03 に停止ボタンで止めました。/u);
});

test('guest and global stops are shown as needing the hub, without resume', () => {
  for (const [scope, label, reason] of [
    ['guest', '停止中（来客モード）', '来客モードのため止まっています。'],
    ['global', '全体停止中', '全体停止のため止まっています。'],
  ] as const) {
    const html = render(view(shown(scope)));
    assert.match(html, new RegExp(label, 'u'));
    assert.match(html, new RegExp(`${reason}解除は中枢で行います。`, 'u'));
    assert.deepEqual(buttonLabels(html), [HIDE, QUIT]);
    // 要対応の帯には ⚠ の記号を付ける。
    assert.match(html, /alert--warning.*alert__indicator/su);
  }
});

test('a resume rejection is announced right under the resume button', () => {
  const html = render(
    view(shown('local'), {
      message: { channel: 'desktop.io_resume', text: '再開の拒否の文言' },
    }),
  );
  assert.match(
    html,
    new RegExp(
      `${RESUME}.*ウィンドウが前面にあるときだけ再開できます。.*role="alert"[^>]*>再開の拒否の文言`,
      'u',
    ),
  );
  // 他の操作の拒否は、再開のボタンの下には出さない。
  const other = render(
    view(shown('local'), {
      message: { channel: 'desktop.window_hide', text: '閉じるの拒否' },
    }),
  );
  assert.doesNotMatch(other, /role="alert"[^>]*>(<[^>]+>)*再開/u);
  assert.match(other, /role="alert"[^>]*>閉じるの拒否/u);
  assert.doesNotMatch(render(view(shown('local'))), /role="alert"/u);
});

test('the one-time registration notice is shown only after registering', () => {
  assert.match(
    render(view(shown('none'), { justRegistered: true })),
    /この端末を中枢に登録しました。/u,
  );
  assert.doesNotMatch(
    render(view(shown('none'))),
    /この端末を中枢に登録しました。/u,
  );
  // 停止の帯と同時には出さない（Alert は 1 画面に 1 つ）。
  assert.doesNotMatch(
    render(view(shown('local'), { justRegistered: true })),
    /この端末を中枢に登録しました。/u,
  );
});

const connection = (
  extra: Partial<Extract<DesktopConnectionView, { visibility: 'shown' }>>,
): DesktopConnectionView => ({
  visibility: 'shown',
  registration: 'registered',
  link: 'connected',
  link_reason: null,
  last_confirmed_at: AT,
  retry_at: null,
  pairing: null,
  hub_screen: false,
  hub_target: { host: '100.64.0.10', port: 47823 },
  home_network: null,
  operations: [],
  ...extra,
});

test('the hub line and connection section do not repeat the same state', () => {
  const html = render(view(shown('none'), { connection: connection({}) }));
  assert.match(html, /接続中（10:02:03 確認）/u);
  assert.match(html, /<h2[^>]*>中枢との接続<\/h2>/u);
  assert.match(html, /中枢の操作はありません。/u);
  assert.doesNotMatch(html, /理由/u);
  // 接続し直し待ちは時刻と何秒後かを出し、状態の言い換えの理由は出さない。
  const retry = new Date(2026, 9, 21, 10, 3, 33).toISOString();
  const waiting = render(
    view(shown('none'), {
      connection: connection({
        link: 'waiting_retry',
        link_reason: 'unreachable',
        retry_at: retry,
      }),
    }),
  );
  assert.match(waiting, /接続し直しを待っています。次は 10:03:33（30 秒後）/u);
  assert.doesNotMatch(waiting, /<dt[^>]*>理由<\/dt>/u);
});

test('sections, headings and landmarks keep their labels for screen readers', () => {
  const html = render(
    view(shown('local'), { connection: connection({}), powerLog: [lockEvent] }),
  );
  assert.match(html, /<h1[^>]*>Buddy<\/h1>/u);
  assert.match(html, /<main\b/u);
  assert.match(html, /<footer\b/u);
  assert.match(html, /<section aria-labelledby="power-log-heading"/u);
  assert.match(html, /id="power-log-heading"/u);
  assert.match(html, /<section[^>]*aria-labelledby="connection-heading"/u);
});

test('pressing stop sends desktop.io_stop', () => {
  const sent: DesktopIpcRequest[] = [];
  const actions = deviceActions(shown('none'), (built) => sent.push(built));
  const buttons = pressables(StopButton({ onStop: actions.stop }));
  assert.deepEqual([...buttons.keys()], [STOP]);
  buttons.get(STOP)?.();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.channel, 'desktop.io_stop');
  assert.equal(sent[0]?.payload, null);
});

test('pressing resume sends desktop.io_resume with the shown io_epoch', () => {
  const sent: DesktopIpcRequest[] = [];
  const status = shown('local');
  const actions = deviceActions(status, (built) => sent.push(built));
  const buttons = pressables(
    StopBanner({ status, reason: null, resume: actions.resume, message: null }),
  );
  assert.deepEqual([...buttons.keys()], [RESUME]);
  buttons.get(RESUME)?.();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.channel, 'desktop.io_resume');
  assert.deepEqual(sent[0]?.payload, { expected_io_epoch: '7' });
});

test('pressing hide and quit sends their channels and nothing else', () => {
  const sent: DesktopIpcRequest[] = [];
  const actions = deviceActions(shown('local'), (built) => sent.push(built));
  const buttons = pressables(
    AppFooter({ onHide: actions.hideWindow, onQuit: actions.quit }),
  );
  assert.deepEqual([...buttons.keys()], [HIDE, QUIT]);
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
