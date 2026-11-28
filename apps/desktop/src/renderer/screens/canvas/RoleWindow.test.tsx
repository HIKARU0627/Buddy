// キャンバス表示の窓の画面（UI-02 の試作、ADR 0032・0181）の試験。窓の役割の読み取り・最初に送る要求・状態の要約（記号と数）・
// 上の中央の島（段階 4）・入力バーの有効と無効を、純粋な関数とサーバー描画（react-dom/server）で確かめる。期待値は手で書く。
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
  canvasContentShown,
  canvasWithheldLine,
  contentShown,
  initialChannelsFor,
  inputBarEnabled,
  inputDraftAfter,
  rendererWindowRole,
  statusSummaryView,
  transparentSurfaceFor,
} from '../../state/window-role-state.js';
import { CanvasGround } from './CanvasGround.js';
import { CanvasIsland } from './CanvasIsland.js';
import { CanvasWithheld } from './CanvasWithheld.js';
import { InputBar } from './InputBar.js';

import { islandView } from '../../state/island-state.js';
import type { IslandSignals } from '../../state/island-state.js';
import { privacyMarks } from '../../state/status-panel-state.js';

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
  budget_items: [],
  private_confirmations: [],
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
  // 上の中央の島（ADR 0181 の段階 4）。
  assert.equal(rendererWindowRole('island'), 'island');
  assert.equal(rendererWindowRole(null), null);
  assert.equal(rendererWindowRole('admin'), null);
  assert.equal(rendererWindowRole('Canvas'), null);
});

test('each window asks only for what its role may read', () => {
  assert.deepEqual(initialChannelsFor('canvas'), ['desktop.get_state']);
  assert.deepEqual(initialChannelsFor('input'), ['desktop.get_state']);
  // 状態の層は音声の状態（B05-06）も取る。
  assert.deepEqual(initialChannelsFor('status'), [
    'desktop.get_state',
    'desktop.get_connection',
    'desktop.get_voice',
  ]);
  // 島は確認が必要な操作の数（接続の状態）と、外部へ送っている印（音声の状態）を読む（読むだけ。役割の表の U391）。
  assert.deepEqual(initialChannelsFor('island'), [
    'desktop.get_state',
    'desktop.get_connection',
    'desktop.get_voice',
  ]);
});

test('the status summary shows one mark and the number of operations needing attention', () => {
  const ops = [
    entry(1),
    entry(2, { state: 'unknown_held', allowed_actions: ['reconcile'] }),
    entry(3, { state: 'preparing', allowed_actions: [] }),
    entry(4, { state: 'succeeded', allowed_actions: [] }),
  ];
  assert.deepEqual(statusSummaryView(shown(), connected(ops)), {
    line: { tone: 'success', mark: 'dot', text: '受付中' },
    pending: 2,
    // 数と単位の間は折り返さない空白（U+00A0。ADR 0024 の約束 1）。
    label: 'Buddy の状態: 受付中、確認が必要な操作 2\u00a0件',
  });
  assert.deepEqual(
    statusSummaryView(
      shown({ stop_scope: 'local', input_permitted: false }),
      null,
    ),
    {
      line: { tone: 'neutral', mark: 'square', text: '停止中' },
      pending: null,
      label: 'Buddy の状態: 停止中',
    },
  );
  // 未登録では数を出さない。
  assert.equal(
    statusSummaryView(shown(), connected(ops, 'unregistered')).pending,
    null,
  );
  assert.equal(statusSummaryView(shown(), connected([])).pending, 0);
  // ロック中・不明・受け取る前は数を出さない。
  assert.deepEqual(
    statusSummaryView(
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
    statusSummaryView({ visibility: 'hidden', lock_state: 'unknown' }, null)
      .label,
    'Buddy の状態: ロック状態を確認中',
  );
  assert.equal(statusSummaryView(null, null).line.mark, 'spinner');
});

const noop = () => undefined;
const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

// ADR 0181 の段階 4: 上の中央の島（キャンバス表示）。端のつまみの中身（入出力の記号・確認が必要な操作の数・専用の記号 3 つ）
// を島の小さい形へ移し、停止とパネルを出すボタンを置く。キャンバスを前に出す・承認・取消のボタンは島にない。
const islandOf = (
  status: DesktopStatusBar | null,
  connection: DesktopConnectionView | null,
  options: {
    readonly signals?: IslandSignals | null;
    readonly now?: number;
    readonly privacy?: ReturnType<typeof privacyMarks>;
  } = {},
) => {
  const summary = statusSummaryView(status, connection);
  return render(
    <CanvasIsland
      view={islandView({
        status,
        connection,
        now: options.now ?? 0,
        signals: options.signals ?? null,
        holdingSince: null,
      })}
      pending={summary.pending}
      summaryLabel={summary.label}
      privacy={options.privacy ?? privacyMarks(status)}
      onStop={noop}
      onOpenPanel={noop}
    />,
  );
};

test('the island draws the IO line, the panel button with the count and three privacy slots, and the stop', () => {
  const html = islandOf(shown(), connected([entry(1), entry(2)]));
  assert.match(
    html,
    /<section[^>]*aria-label="状態の島"[^>]*data-island="compact"/u,
  );
  // 島の面は完全な丸に近い島の丸み（28px）と縁取りの線。影は使わない。
  assert.match(html, /rounded-island border border-border bg-surface/u);
  assert.doesNotMatch(html, /shadow/u);
  // 入出力の 1 行はライブ領域（パネルから島へ移した。同じ文を 2 か所で読ませない）。
  assert.match(html, /<p role="status"[^>]*>(?:(?!<\/p>)[\s\S])*受付中/u);
  const buttons = html.match(/<button[\s\S]*?<\/button>/gu) ?? [];
  assert.equal(buttons.length, 2);
  // パネルを出すボタン: 読み上げの名前に要約と専用の記号の状態が入る。出す・しまうの切り替えではない（aria-expanded なし）。
  const panelButton = buttons[0] ?? '';
  assert.match(
    panelButton,
    /aria-label="状態のパネルを出す（Buddy の状態: 受付中、確認が必要な操作 2\u00a0件。音声を外部へ送っているかは未受信、記録しないモードかは未受信、安全停止中かは未受信）"/u,
  );
  assert.doesNotMatch(panelButton, /aria-expanded/u);
  // 停止: 見える文字は「■ 停止」、読み上げの名前は「入出力を停止」（U396）。停止の重さ（danger-soft）。
  const stopButton = buttons[1] ?? '';
  assert.match(stopButton, /aria-label="入出力を停止"/u);
  assert.match(stopButton, /button--danger-soft/u);
  // 専用の記号 3 つは決まった順。値がまだないので点線の枠。
  assert.deepEqual(
    [...html.matchAll(/data-privacy="([a-z_]+)" data-state="([a-z]+)"/gu)].map(
      (match) => `${match[1]}:${match[2]}`,
    ),
    ['voice_external:unknown', 'private_mode:unknown', 'safety_stop:unknown'],
  );
  assert.equal((html.match(/border-dashed/gu) ?? []).length, 3);
  // 見える文字は入出力の 1 行・数・停止だけ。
  assert.equal(visibleText(html), '● 受付中 2 ■ 停止');
  // 島からキャンバスを前に出す・承認・取消はできない（ボタンを作らない）。
  assert.doesNotMatch(html, /キャンバスを前に出す|承認|取り消す|再開/u);
  assert.doesNotMatch(html, /<button[^>]*\bdisabled/u);
});

test('the island while stopped has no stop; while locked it hides the content but keeps the panel button and the stop', () => {
  const stopped = islandOf(
    shown({ stop_scope: 'local', input_permitted: false }),
    connected([]),
  );
  // 止まった後は停止を出さない（ADR 0024 UI レビュー 2 回目 1）。再開はパネルから。
  assert.equal(visibleText(stopped), '■ 停止中 0');
  assert.equal((stopped.match(/<button\b/gu) ?? []).length, 1);
  assert.doesNotMatch(stopped, /aria-label="入出力を停止"/u);
  const locked = islandOf({ visibility: 'hidden', lock_state: 'locked' }, null);
  assert.equal(
    visibleText(locked),
    '画面がロックされているため、内容を隠しています。 ■ 停止',
  );
  assert.match(locked, /<p role="status"/u);
  // ロック中でもパネルを出せる（停止へ届く）。数と専用の記号は描かない。
  assert.match(
    locked,
    /<button[^>]*aria-label="状態のパネルを出す（Buddy の状態: ロック中。/u,
  );
  assert.match(locked, /aria-label="入出力を停止"/u);
  assert.doesNotMatch(locked, /data-privacy|tabular-nums/u);
  assert.doesNotMatch(locked, /<button[^>]*\bdisabled/u);
  // 受け取る前も同じく停止を出す。
  const unknown = islandOf(null, null);
  assert.equal(visibleText(unknown), '状態を確かめています。 ■ 停止');
});

test('the island privacy slots stay in place and fill in when the state is on', () => {
  const on = islandOf(shown(), null, {
    privacy: privacyMarks(
      shown({
        voice_state: 'conversation_live',
        storage_mode: 'private',
        safety_stopped: true,
      }),
    ),
  });
  assert.deepEqual(
    [...on.matchAll(/data-privacy="([a-z_]+)" data-state="([a-z]+)"/gu)].map(
      (match) => `${match[1]}:${match[2]}`,
    ),
    ['voice_external:on', 'private_mode:on', 'safety_stop:on'],
  );
  assert.match(on, /bg-warning-soft/u);
  assert.match(on, /bg-accent-soft/u);
  assert.match(on, /bg-danger-soft/u);
  // 読み上げの名前に専用の記号の状態が入る（画面には出さない）。
  assert.match(on, /音声を外部へ送っている、記録しないモード、安全停止中/u);
  // 未登録・接続の状態がない間は数を出さない。
  assert.equal(visibleText(on), '● 受付中 ■ 停止');
  const off = islandOf(shown(), null, {
    privacy: privacyMarks(
      shown({
        voice_state: 'waiting_wake_word',
        storage_mode: 'normal',
        safety_stopped: false,
      }),
    ),
  });
  assert.equal((off.match(/data-state="off"/gu) ?? []).length, 3);
  assert.doesNotMatch(
    off,
    /border-dashed|bg-warning-soft|bg-accent-soft|bg-danger-soft/u,
  );
});

test('the island expands only for operations needing attention and for results; the way to the list opens the panel, never an approval', () => {
  const attention: IslandSignals = {
    attentionCount: 2,
    attentionRaisedAt: 1_000,
    attentionRaisedCount: 2,
    result: null,
  };
  const ops = [entry(1), entry(2)];
  const expanded = islandOf(shown(), connected(ops), {
    signals: attention,
    now: 2_000,
  });
  assert.match(expanded, /data-island="expanded"/u);
  // 件数だけを polite で読む（操作の名前・時刻は入れない）。
  assert.match(
    expanded,
    /<div role="status" data-island-live="status"><p data-island-line="attention"[\s\S]*確認が必要な操作が2\u00a0件あります。/u,
  );
  // 広がった形の動きは動きを減らす設定で付けない（motion-safe）。
  assert.match(expanded, /motion-safe:animate-island-in/u);
  assert.deepEqual(
    (expanded.match(/<button[\s\S]*?<\/button>/gu) ?? []).map((button) =>
      visibleText(button),
    ),
    ['2', '■ 停止', '確認が必要な操作を見る'],
  );
  assert.doesNotMatch(expanded, /承認|取り消す/u);
  // 8 秒が過ぎたら畳む（件数は小さい形の数に残る）。
  const collapsed = islandOf(shown(), connected(ops), {
    signals: attention,
    now: 9_000,
  });
  assert.match(collapsed, /data-island="compact"/u);
  assert.doesNotMatch(collapsed, /確認が必要な操作が/u);
  // 失敗の結果は alert で読む。
  const failure = islandOf(shown(), connected([]), {
    signals: {
      attentionCount: 0,
      attentionRaisedAt: null,
      attentionRaisedCount: 0,
      result: {
        line: {
          tone: 'warning',
          mark: 'warning',
          text: 'タスクを作る: 結果を確認できませんでした',
        },
        failure: true,
        at: 1_000,
        announcedNearby: false,
      },
    },
    now: 2_000,
  });
  assert.match(
    failure,
    /<div role="alert" data-island-live="alert">[\s\S]*結果を確認できませんでした/u,
  );
  assert.doesNotMatch(failure, />確認が必要な操作を見る</u);
});

test('the island and the input bar paint no window ground; the canvas and the panel keep theirs', () => {
  assert.equal(transparentSurfaceFor('island'), true);
  assert.equal(transparentSurfaceFor('input'), true);
  assert.equal(transparentSurfaceFor('canvas'), false);
  assert.equal(transparentSurfaceFor('status'), false);
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
  // キャンバスの記号（4 つの四角）と、押せる縁。
  assert.equal((enabled.match(/<rect\b/gu) ?? []).length, 4);
  assert.match(enabled, /button--outline/u);
  // 小さめはカプセル（窓の高さ 56 と同じ h-14・完全な丸）。窓の地は透明で、角の外は透ける（ADR 0181 の段階 4・U399）。
  assert.match(
    enabled,
    /<form class="[^"]*\bh-14\b[^"]*\brounded-full border border-border bg-surface/u,
  );
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
  // 入力するときは窓が広がり、入力欄が複数行になる（UI-08）。
  const expanded = render(
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
      expanded
      clarification="どちらの予定ですか。"
    />,
  );
  assert.equal((expanded.match(/<textarea\b/gu) ?? []).length, 1);
  // 入力中は島の丸み（28px）の面。
  assert.match(
    expanded,
    /<form class="[^"]*\bh-screen\b[^"]*\brounded-island border border-border bg-surface/u,
  );
  assert.doesNotMatch(expanded, /<form class="[^"]*rounded-full/u);
  assert.match(expanded, /rows="5"/u);
  assert.doesNotMatch(expanded, /<input\b/u);
  assert.match(expanded, /どちらの予定ですか。/u);
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
        line={statusSummaryView(status, null).line}
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
  // ロック中・不明では、広がった入力バーの聞き返し本文も描かない。
  const hiddenClarification = render(
    <InputBar
      line={statusSummaryView(locked, null).line}
      enabled={false}
      value=""
      onChange={noop}
      onSubmit={noop}
      sending={false}
      attention={false}
      canSummon={false}
      onSummon={noop}
      expanded
      clarification="どちらの予定ですか。"
    />,
  );
  assert.doesNotMatch(hiddenClarification, /どちらの予定ですか。/u);
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

// 停止中はキャンバスの記述を描かない（入力バーの下書きと違い、停止中も隠す）。
test('the canvas content is shown only while unlocked and not stopped', () => {
  assert.equal(canvasContentShown(shown()), true);
  assert.equal(
    canvasContentShown(shown({ stop_scope: 'local', input_permitted: false })),
    false,
  );
  assert.equal(
    canvasContentShown(shown({ stop_scope: 'guest', input_permitted: false })),
    false,
  );
  assert.equal(
    canvasContentShown({ visibility: 'hidden', lock_state: 'locked' }),
    false,
  );
  assert.equal(canvasContentShown(null), false);
  // 下書きは停止中も残る（打てないだけ）。キャンバスだけが隠れる。
  assert.equal(
    contentShown(shown({ stop_scope: 'local', input_permitted: false })),
    true,
  );
});

// UI-05 の段階 4（ADR 0188）: 表示のリースを失った間は、物の代わりに理由の 1 文だけを記号と文言で出す（tones.ts の warning の ○、
// 共通の枠 FRAME_CLASS の箱の丸み）。理由がなければ何も出さない。ロック中・停止中は地の中身ごと描かない。
test('the withheld canvas shows one sentence with the warning circle in the shared frame, and nothing without a reason', () => {
  assert.equal(canvasWithheldLine(null), null);
  const line = canvasWithheldLine('display_lease_lost');
  assert.deepEqual(line, {
    tone: 'warning',
    mark: 'circle',
    text: '中枢との表示の確認が途切れたため、キャンバスの物を隠しています（確認し直せたら戻ります）。',
  });
  assert(line !== null);
  const html = render(
    <CanvasGround front={false} shown>
      <CanvasWithheld line={line} />
    </CanvasGround>,
  );
  assert.match(html, /role="status"/u);
  assert.match(html, /data-canvas-withheld="true"/u);
  assert.match(html, /rounded-box border border-separator/u);
  // 記号（○）は warning の文字色で、読み上げない。文言は 1 文。
  assert.match(
    html,
    /<span aria-hidden="true" class="text-warning-soft-foreground">○<\/span>/u,
  );
  const text = html.replace(/<[^>]+>/gu, '');
  assert.equal(
    text,
    '○中枢との表示の確認が途切れたため、キャンバスの物を隠しています（確認し直せたら戻ります）。',
  );
  assert.equal(text.match(/。/gu)?.length, 1);
  // ロック中・停止中（shown が false）は理由も描かない。
  const hidden = render(
    <CanvasGround front={false} shown={false}>
      <CanvasWithheld line={line} />
    </CanvasGround>,
  );
  assert.doesNotMatch(hidden, /中枢との表示の確認/u);
});
