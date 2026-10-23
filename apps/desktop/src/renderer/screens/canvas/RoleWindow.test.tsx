// 3 つの窓の画面（UI-02 の試作、ADR 0032）の試験。窓の役割の読み取り・最初に送る要求・端のつまみの記号と数・
// 入力バーの有効と無効を、純粋な関数とサーバー描画（react-dom/server）で確かめる。期待値は手で書く。
// 実際のクリック・キー入力・IME は Electron の画面で確かめる（docs/ui/window-prototype.md）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopConnectionView,
  DesktopOperationEntry,
  DesktopStatusBar,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  canSummonCanvas,
  contentShown,
  initialChannelsFor,
  inputBarEnabled,
  inputDraftAfter,
  rendererWindowRole,
  statusTabView,
} from '../../state/window-role-state.js';
import { CanvasGround } from './CanvasGround.js';
import { InputBar } from './InputBar.js';
import { StatusTab } from './StatusTab.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const entry = (
  n: number,
  overrides: Partial<DesktopOperationEntry> = {},
): DesktopOperationEntry => ({
  ref: id(n),
  operation_kind: 'task.create',
  state: 'awaiting_approval',
  approval_state: 'none',
  allowed_actions: ['preview', 'approve', 'cancel'],
  result: null,
  state_revision: '1',
  delivery_unknown: false,
  headline: null,
  detail: null,
  ...overrides,
});

const shown = (
  overrides: Partial<Extract<DesktopStatusBar, { visibility: 'shown' }>> = {},
): DesktopStatusBar => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '0',
  voice_state: null,
  hub_connection: 'connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
  ...overrides,
});

const connected = (
  operations: DesktopOperationEntry[],
  registration: 'registered' | 'unregistered' = 'registered',
): DesktopConnectionView => ({
  visibility: 'shown',
  registration,
  link: 'connected',
  link_reason: null,
  last_confirmed_at: null,
  retry_at: null,
  pairing: null,
  home_network: null,
  operations,
  hub_screen: false,
  hub_target: null,
});

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

test('the window role from the preload picks the screen; unknown roles draw nothing', () => {
  assert.equal(rendererWindowRole(undefined), 'legacy');
  assert.equal(rendererWindowRole('legacy'), 'legacy');
  assert.equal(rendererWindowRole('canvas'), 'canvas');
  assert.equal(rendererWindowRole('status'), 'status');
  assert.equal(rendererWindowRole('input'), 'input');
  assert.equal(rendererWindowRole(null), null);
  assert.equal(rendererWindowRole('admin'), null);
  assert.equal(rendererWindowRole('Canvas'), null);
});

test('each window asks only for what its role may read', () => {
  assert.deepEqual(initialChannelsFor('canvas'), ['desktop.get_state']);
  assert.deepEqual(initialChannelsFor('input'), ['desktop.get_state']);
  assert.deepEqual(initialChannelsFor('status'), [
    'desktop.get_state',
    'desktop.get_connection',
  ]);
});

test('the status tab shows one mark and the number of operations needing attention', () => {
  const ops = [
    entry(1),
    entry(2, { state: 'unknown_held', allowed_actions: ['reconcile'] }),
    entry(3, { state: 'preparing', allowed_actions: [] }),
    entry(4, { state: 'succeeded', allowed_actions: [] }),
  ];
  assert.deepEqual(statusTabView(shown(), connected(ops)), {
    line: { tone: 'success', mark: 'dot', text: '受付中' },
    pending: 2,
    // 数と単位の間は折り返さない空白（U+00A0。ADR 0024 の約束 1）。
    label: 'Buddy の状態: 受付中、確認が必要な操作 2 件',
  });
  assert.deepEqual(
    statusTabView(shown({ stop_scope: 'local', input_permitted: false }), null),
    {
      line: { tone: 'neutral', mark: 'square', text: '停止中' },
      pending: null,
      label: 'Buddy の状態: 停止中',
    },
  );
  // 未登録では数を出さない。
  assert.equal(
    statusTabView(shown(), connected(ops, 'unregistered')).pending,
    null,
  );
  assert.equal(statusTabView(shown(), connected([])).pending, 0);
  // ロック中・不明・受け取る前は数を出さない。
  assert.deepEqual(
    statusTabView(
      { visibility: 'hidden', lock_state: 'locked' },
      connected(ops),
    ),
    {
      line: { tone: 'muted', mark: 'circle', text: 'ロック中' },
      pending: null,
      label: 'Buddy の状態: ロック中',
    },
  );
  assert.equal(
    statusTabView({ visibility: 'hidden', lock_state: 'unknown' }, null).label,
    'Buddy の状態: ロック状態を確認中',
  );
  assert.equal(statusTabView(null, null).line.mark, 'spinner');
});

const noop = () => undefined;
const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

test('the status tab draws a mark and a count with no visible sentence', () => {
  const html = render(
    <StatusTab
      view={statusTabView(shown(), connected([entry(1), entry(2)]))}
      canSummon
      onSummon={noop}
    />,
  );
  assert.match(html, /role="status"/u);
  assert.match(
    html,
    /aria-label="Buddy の状態: 受付中、確認が必要な操作 2\u00a0件"/u,
  );
  // つまみの下に、入力バーと同じキャンバスの記号のボタン（縁つき）がある。読み上げの名前だけで、見える説明文はない。
  assert.match(html, /<button[^>]*aria-label="キャンバスを前に出す"/u);
  assert.match(html, /button--outline/u);
  assert.equal((html.match(/<rect\b/gu) ?? []).length, 4);
  // 状態を見る部分（記号と数）はボタンの外にある（押せるのは縁のあるボタンだけ）。
  const button = /<button[\s\S]*?<\/button>/u.exec(html)?.[0] ?? '';
  assert.doesNotMatch(button, /●/u);
  assert.doesNotMatch(html, /<button[^>]*\bdisabled/u);
  // 見える文字は記号と数だけ。
  assert.equal(visibleText(html), '● 2');
  const locked = render(
    <StatusTab
      view={statusTabView({ visibility: 'hidden', lock_state: 'locked' }, null)}
      canSummon={canSummonCanvas({
        visibility: 'hidden',
        lock_state: 'locked',
      })}
      onSummon={noop}
    />,
  );
  assert.equal(visibleText(locked), '○');
  // ロック中はキャンバスを呼べない。
  assert.match(locked, /<button[^>]*\bdisabled/u);
});

test('the input bar is a mark, one field and the canvas button; it is disabled while stopped or locked', () => {
  assert.equal(inputBarEnabled(shown()), true);
  assert.equal(
    inputBarEnabled(shown({ stop_scope: 'local', input_permitted: false })),
    false,
  );
  assert.equal(
    inputBarEnabled({ visibility: 'hidden', lock_state: 'locked' }),
    false,
  );
  assert.equal(inputBarEnabled(null), false);
  const enabled = render(
    <InputBar
      line={{ tone: 'success', mark: 'dot', text: '受付中' }}
      enabled
      value=""
      onChange={noop}
      onSubmit={noop}
      sending={false}
      attention={false}
      canSummon
      onSummon={noop}
    />,
  );
  assert.match(enabled, /aria-label="Buddy への入力"/u);
  assert.equal((enabled.match(/<input\b/gu) ?? []).length, 1);
  assert.doesNotMatch(enabled, /<input[^>]*\bdisabled/u);
  assert.doesNotMatch(enabled, /placeholder=/u);
  assert.match(enabled, /<button[^>]*aria-label="キャンバスを前に出す"/u);
  // つまみと同じキャンバスの記号（4 つの四角）と、押せる縁。
  assert.equal((enabled.match(/<rect\b/gu) ?? []).length, 4);
  assert.match(enabled, /button--outline/u);
  const disabled = render(
    <InputBar
      line={{ tone: 'neutral', mark: 'square', text: '停止中' }}
      enabled={false}
      value=""
      onChange={noop}
      onSubmit={noop}
      sending={false}
      attention={false}
      canSummon={false}
      onSummon={noop}
    />,
  );
  assert.match(disabled, /<input[^>]*\bdisabled/u);
  assert.match(disabled, /<button[^>]*\bdisabled/u);
});

// PR #104 のレビュー（P2）: 打てるかと内容を出せるかを分け、ロック中・不明では打った文字を描かない。
test('typed text disappears when the device locks or the lock state becomes unknown', () => {
  const typed = '明日の予定を確認';
  const running = shown();
  const stopped = shown({ stop_scope: 'local', input_permitted: false });
  const locked: DesktopStatusBar = {
    visibility: 'hidden',
    lock_state: 'locked',
  };
  const unknown: DesktopStatusBar = {
    visibility: 'hidden',
    lock_state: 'unknown',
  };
  assert.equal(contentShown(running), true);
  assert.equal(contentShown(stopped), true);
  assert.equal(contentShown(locked), false);
  assert.equal(contentShown(unknown), false);
  assert.equal(contentShown(null), false);
  // 文字を入れてから止める: 打てないが、文字は残る。
  assert.equal(inputDraftAfter(typed, running), typed);
  assert.equal(inputDraftAfter(typed, stopped), typed);
  // 文字を入れてからロック・不明にする: 文字は消える。解除しても戻らない（捨てた後の下書きは空）。
  for (const hidden of [locked, unknown, null]) {
    const after = inputDraftAfter(typed, hidden);
    assert.equal(after, '');
    assert.equal(inputDraftAfter(after, running), '');
  }
  const draw = (status: DesktopStatusBar) =>
    render(
      <InputBar
        line={statusTabView(status, null).line}
        enabled={inputBarEnabled(status)}
        value={inputDraftAfter(typed, status)}
        onChange={noop}
        onSubmit={noop}
        sending={false}
        attention={false}
        canSummon={canSummonCanvas(status)}
        onSummon={noop}
      />,
    );
  assert.match(draw(running), /value="明日の予定を確認"/u);
  assert.match(draw(stopped), /value="明日の予定を確認"/u);
  for (const hidden of [locked, unknown]) {
    const html = draw(hidden);
    assert.doesNotMatch(html, /明日の予定を確認/u);
    assert.match(html, /<input[^>]*\bdisabled/u);
  }
});

test('the canvas is an empty ground; in front it shows an accent frame; locked it draws nothing inside', () => {
  const behind = render(<CanvasGround front={false} shown />);
  assert.match(behind, /aria-label="Buddy のキャンバス"/u);
  assert.match(behind, /data-front="false"/u);
  assert.doesNotMatch(behind, /ring-accent/u);
  assert.equal(behind.replace(/<[^>]+>/gu, '').trim(), '');
  // 後ろにある間は Esc のキーの形を出さない。
  assert.doesNotMatch(behind, /<kbd\b/u);
  const front = render(<CanvasGround front shown />);
  assert.match(front, /data-front="true"/u);
  assert.match(front, /ring-accent/u);
  // 前に出ている間は、枠の右上に Esc のキーの形を出して戻し方を示す。キーの中は「Esc」だけ（⎋ の記号は使わない）。
  assert.match(front, /<kbd\b[^>]*aria-hidden="true"/u);
  const kbd = /<kbd\b[\s\S]*?<\/kbd>/u.exec(front)?.[0] ?? '';
  assert.equal(kbd.replace(/<[^>]+>/gu, '').trim(), 'Esc');
  assert.doesNotMatch(front, /⎋|<abbr\b/u);
  // ロック中・不明は中身（UI-03 以降のカード）を描かない。
  const hidden = render(
    <CanvasGround front={false} shown={false}>
      <p>カード</p>
    </CanvasGround>,
  );
  assert.doesNotMatch(hidden, /カード/u);
  const visible = render(
    <CanvasGround front={false} shown>
      <p>カード</p>
    </CanvasGround>,
  );
  assert.match(visible, /カード/u);
});
