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
  initialChannelsFor,
  inputBarEnabled,
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

test('the status tab draws a mark and a count with no visible sentence', () => {
  const html = render(
    <StatusTab
      view={statusTabView(shown(), connected([entry(1), entry(2)]))}
    />,
  );
  assert.match(html, /role="status"/u);
  assert.match(
    html,
    /aria-label="Buddy の状態: 受付中、確認が必要な操作 2\u00a0件"/u,
  );
  // 見える文字は記号と数だけ。
  const visible = html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  assert.equal(visible, '● 2');
  const locked = render(
    <StatusTab
      view={statusTabView({ visibility: 'hidden', lock_state: 'locked' }, null)}
    />,
  );
  assert.equal(
    locked
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
    '○',
  );
});

test('the input bar is a mark and one field; it is disabled while stopped or locked', () => {
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
    />,
  );
  assert.match(enabled, /aria-label="Buddy への入力"/u);
  assert.equal((enabled.match(/<input\b/gu) ?? []).length, 1);
  assert.doesNotMatch(enabled, /<input[^>]*\bdisabled/u);
  assert.doesNotMatch(enabled, /placeholder=/u);
  const disabled = render(
    <InputBar
      line={{ tone: 'neutral', mark: 'square', text: '停止中' }}
      enabled={false}
    />,
  );
  assert.match(disabled, /<input[^>]*\bdisabled/u);
});

test('the canvas is an empty ground', () => {
  const html = render(<CanvasGround />);
  assert.match(html, /aria-label="Buddy のキャンバス"/u);
  assert.equal(html.replace(/<[^>]+>/gu, '').trim(), '');
});
