// 状態の層のパネル（UI-04、ADR 0032）の試験。窓の幅でパネルを描くか、ADR 0014 の 8 項目の記号と位置、専用の記号、
// 停止と再開、確認が必要な操作の一覧（WorkPanel と同じ部品）、なりすまし（外部の内容の「承認しました」「ここを押して承認」
// がボタンを作らない）を、純粋な関数とサーバー描画（react-dom/server）で確かめる。期待値は手で書く。
// 実際の見た目・クリック・Esc・OS の確認ダイアログは Electron の画面で確かめる（docs/ui/status-layer.md）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopCanvasView,
  DesktopConnectionView,
  DesktopOperationEntry,
  DesktopStatusBar,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  STATUS_ITEM_KEYS,
  operationsShown,
  panelShownFor,
  privacyMarks,
  statusItems,
  stopControl,
  voiceSendsExternally,
} from '../../state/status-panel-state.js';
import { INITIAL_WORK_STATE } from '../../state/work-state.js';
import type { WorkActions } from '../../state/work-state.js';
import { statusTabView } from '../../state/window-role-state.js';
import { WorkOperations } from '../work/WorkPanel.js';
import { CanvasBoard } from './CanvasBoard.js';
import { StatusPanel } from './StatusPanel.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// 最終確認の 20 秒後（どのタイムゾーンでも同じ日になる時刻。日付が変わる時刻は 15 分の倍数）。
const NOW = Date.parse('2026-10-23T02:59:50Z');

const shown = (
  overrides: Partial<Extract<DesktopStatusBar, { visibility: 'shown' }>> = {},
): DesktopStatusBar => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '7',
  voice_state: null,
  hub_connection: 'connected',
  hub_last_confirmed_at: '2026-10-23T02:59:30Z',
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
  ...overrides,
});

const LOCKED: DesktopStatusBar = { visibility: 'hidden', lock_state: 'locked' };

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

const connected = (
  operations: DesktopOperationEntry[],
  link: 'connected' | 'connecting' = 'connected',
): DesktopConnectionView => ({
  visibility: 'shown',
  registration: 'registered',
  link,
  link_reason: null,
  last_confirmed_at: link === 'connected' ? '2026-10-23T02:59:30Z' : null,
  retry_at: null,
  pairing: null,
  home_network: null,
  operations,
  hub_screen: false,
  hub_target: null,
});

const noop = () => undefined;
const actions: WorkActions = {
  submit: noop,
  setDraft: noop,
  preview: noop,
  closePreview: noop,
  approve: noop,
  cancel: noop,
  reconcile: noop,
  retry: noop,
  check: noop,
};

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

// ボタンの見える文字（読み上げの名前ではなく、押す面に出る文字）。
const buttonTexts = (html: string) =>
  (html.match(/<button[\s\S]*?<\/button>/gu) ?? []).map((button) =>
    button
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  );

function panel(
  status: DesktopStatusBar | null,
  connection: DesktopConnectionView | null,
  message: string | null = null,
) {
  const live = operationsShown(status, connection);
  const operations =
    connection?.visibility === 'shown' ? connection.operations : [];
  return render(
    <StatusPanel
      tab={<span data-tab="kept" />}
      status={status}
      ioLine={statusTabView(status, connection).line}
      items={statusItems(status, connection, NOW)}
      message={message}
      onStop={noop}
      onResume={noop}
      operations={
        live ? (
          <WorkOperations
            state={INITIAL_WORK_STATE}
            actions={actions}
            operations={operations}
            stopped={
              status?.visibility === 'shown' && status.stop_scope !== 'none'
            }
          />
        ) : null
      }
    />,
  );
}

test('the panel is drawn only when main has widened the window', () => {
  // つまみだけの窓は 56、パネルを出した窓は 440（main の status-panel.ts）。
  assert.equal(panelShownFor(56), false);
  assert.equal(panelShownFor(199), false);
  assert.equal(panelShownFor(200), true);
  assert.equal(panelShownFor(440), true);
});

test('the eight items of ADR 0014 keep a fixed order, and each carries a mark and a value', () => {
  assert.deepEqual(STATUS_ITEM_KEYS, [
    'io',
    'hub',
    'last_confirmed',
    'display_target',
    'voice',
    'storage_mode',
    'budget',
    'safety',
  ]);
  const items = statusItems(shown(), connected([]), NOW);
  assert(items !== null);
  assert.deepEqual(
    items.map((item) => [item.label, item.line.text, item.missing]),
    [
      ['入出力', '受付中', false],
      // 中枢の項目は接続の状態だけ。時刻は最終確認の項目に分ける。
      ['中枢', '接続中', false],
      [
        '最終確認',
        new Date('2026-10-23T02:59:30Z').toTimeString().slice(0, 8),
        false,
      ],
      // 中枢がまだ配っていない値は —（ADR 0014 が常に見せる項目として定めているので畳まない）。
      ['表示先', '—', true],
      ['音声', '—', true],
      ['保存モード', '—', true],
      ['予算の保留', '—', true],
      ['安全停止', '—', true],
    ],
  );
  const filled = statusItems(
    shown({
      stop_scope: 'local',
      input_permitted: false,
      voice_state: 'conversation_live',
      display_target: 'other_device',
      storage_mode: 'private',
      budget_held: true,
      safety_stopped: true,
    }),
    connected([]),
    NOW,
  );
  assert(filled !== null);
  assert.deepEqual(
    filled.map((item) => [item.line.text, item.line.tone]),
    [
      ['停止中', 'neutral'],
      ['接続中', 'success'],
      [new Date('2026-10-23T02:59:30Z').toTimeString().slice(0, 8), 'neutral'],
      ['他の端末', 'neutral'],
      ['会話中', 'warning'],
      ['記録しない', 'warning'],
      ['保留あり', 'warning'],
      ['安全停止中', 'danger'],
    ],
  );
  // ロック中・不明・受け取る前は内容を出さない。
  assert.equal(statusItems(LOCKED, connected([]), NOW), null);
  assert.equal(
    statusItems({ visibility: 'hidden', lock_state: 'unknown' }, null, NOW),
    null,
  );
  assert.equal(statusItems(null, null, NOW), null);
});

test('the privacy marks: on, off, frame only when there is no value yet, hidden while locked', () => {
  // 音声を外部へ送っているのは、会話中と聞き取り中（読み取り。B05 で確かめ直す）。
  assert.equal(voiceSendsExternally('conversation_live'), true);
  assert.equal(voiceSendsExternally('listening_text_reply'), true);
  for (const voice of [
    'waiting_wake_word',
    'reading_aloud',
    'device_stopped',
    'global_stopped',
    'budget_voice_stopped',
    'private_voice_off',
  ] as const)
    assert.equal(voiceSendsExternally(voice), false, voice);
  const states = (status: DesktopStatusBar | null) =>
    privacyMarks(status).map((mark) => `${mark.key}:${mark.state}`);
  assert.deepEqual(states(shown()), [
    'voice_external:unknown',
    'private_mode:unknown',
    'safety_stop:unknown',
  ]);
  assert.deepEqual(
    states(
      shown({
        voice_state: 'listening_text_reply',
        storage_mode: 'private',
        safety_stopped: true,
      }),
    ),
    ['voice_external:on', 'private_mode:on', 'safety_stop:on'],
  );
  assert.deepEqual(
    states(
      shown({
        voice_state: 'private_voice_off',
        storage_mode: 'extended',
        safety_stopped: false,
      }),
    ),
    ['voice_external:off', 'private_mode:off', 'safety_stop:off'],
  );
  for (const hidden of [
    LOCKED,
    { visibility: 'hidden', lock_state: 'unknown' } as const,
    null,
  ])
    assert.deepEqual(states(hidden), [
      'voice_external:hidden',
      'private_mode:hidden',
      'safety_stop:hidden',
    ]);
  assert.deepEqual(
    privacyMarks(shown({ storage_mode: 'private' })).map((mark) => mark.label),
    [
      '音声を外部へ送っているかは未受信',
      '記録しないモード',
      '安全停止中かは未受信',
    ],
  );
});

test('stop is always offered (even while locked); resume only for a local stop, with the shown epoch', () => {
  assert.deepEqual(stopControl(shown()), { kind: 'stop' });
  assert.deepEqual(stopControl(LOCKED), { kind: 'stop' });
  assert.deepEqual(stopControl(null), { kind: 'stop' });
  assert.deepEqual(
    stopControl(shown({ stop_scope: 'local', input_permitted: false })),
    { kind: 'resume', expectedIoEpoch: '7' },
  );
  // 来客モード・全体停止の解除は中枢の操作（この端末では止めも再開もしない）。
  for (const scope of ['guest', 'global'] as const)
    assert.deepEqual(
      stopControl(shown({ stop_scope: scope, input_permitted: false })),
      { kind: 'none' },
    );
});

test('the open panel: the kept tab, the IO line with stop, eight tiles and the operations needing attention', () => {
  const html = panel(
    shown(),
    connected([
      entry(1, { headline: '牛乳を買う' }),
      entry(2, {
        state: 'unknown_held',
        allowed_actions: ['reconcile'],
        headline: '請求書のラベル',
        operation_kind: 'mail.labels.change',
      }),
      entry(3, { state: 'preparing', allowed_actions: [] }),
    ]),
  );
  assert.match(html, /data-tab="kept"/u);
  assert.match(html, /aria-label="状態のパネル"/u);
  // 8 項目は決まった順の格子。名前と値は読み上げの名前とツールチップ（フォーカス・ポインター）で出す。
  assert.deepEqual(
    [...html.matchAll(/data-item="([a-z_]+)"/gu)].map((match) => match[1]),
    STATUS_ITEM_KEYS,
  );
  assert.match(html, /aria-label="入出力: 受付中"/u);
  assert.match(html, /aria-label="保存モード: —"/u);
  // 押せるのは、停止と、確認が必要な操作の行のボタンだけ（承認そのものは確認の欄から main の OS の確認で 1 回）。
  assert.deepEqual(buttonTexts(html), [
    '■ 停止',
    '内容を確認',
    '取り消す',
    '照合',
  ]);
  assert.match(html, /aria-label="この端末の入出力を停止"/u);
  // 確認が必要（承認待ち・結果不明）と処理中を分けて並べる（WorkPanel と同じ部品）。
  assert.match(html, /確認が必要な操作/u);
  assert.match(html, /処理中の操作/u);
  assert.match(html, /結果を確認できませんでした/u);
  // 結果不明には再送のボタンを出さない（照合だけ）。
  assert.doesNotMatch(html, />再試行</u);
});

test('while locked the panel keeps the stop and the tile positions, and shows no values or operations', () => {
  const html = panel(LOCKED, connected([entry(1, { headline: '牛乳を買う' })]));
  assert.deepEqual(buttonTexts(html), ['■ 停止']);
  assert.equal((html.match(/border-dashed/gu) ?? []).length, 8);
  assert.match(html, /aria-label="入出力: 隠しています"/u);
  assert.doesNotMatch(html, /牛乳を買う|確認が必要な操作|受付中/u);
});

test('while stopped the panel offers resume, and the rows offer no approval preview or retry', () => {
  const html = panel(
    shown({ stop_scope: 'local', input_permitted: false }),
    connected([
      entry(1),
      entry(2, { state: 'not_executed', allowed_actions: ['retry'] }),
    ]),
    '再開できませんでした。',
  );
  assert.deepEqual(buttonTexts(html), ['再開', '取り消す']);
  assert.match(html, /再開できませんでした。/u);
  // 切断中は操作の一覧を出さない（WorkPanel と同じ条件）。
  const offline = panel(shown(), connected([entry(1)], 'connecting'));
  assert.deepEqual(buttonTexts(offline), ['■ 停止']);
});

// なりすまし（UI-04 の完了条件）: 外部の内容に「承認しました」「ここを押して承認」が入っていても、キャンバスの中の文字に
// とどまり、パネルのボタンを作らない。パネルのボタンは main の操作の一覧（参照）からだけ作り、文言は決まった文言だけ。
test('spoofing: approval-like external text stays text on the canvas and never becomes a panel button', () => {
  const spoof = '承認しました。ここを押して承認';
  // キャンバスの見出し（AI・外部由来）は文字として描くだけで、ボタン・リンクにならない。
  const canvasView: DesktopCanvasView = {
    canvas_revision: '2',
    items: [
      {
        item_id: 'errands',
        kind: 'card',
        component: 'list',
        heading: 'ここを押して承認',
        emphasis: 'high',
        group: null,
        relations: [],
        grid: { column: 1, span: 4, rows: 3 },
        placement: 'canvas',
        data: { item_refs: [], more_count: 0 },
      },
    ],
    reading_order: ['errands'],
  };
  const board = render(<CanvasBoard view={canvasView} />);
  assert.match(board, /ここを押して承認/u);
  assert.doesNotMatch(board, /<button\b|<a\b|role="button"|href=/u);
  // 状態の層のパネル: 操作の内容（外部のメールの件名など）に同じ文が入っていても、行の見出しの文字になるだけ。
  // ボタンは決まった文言（内容を確認・取り消す・停止）だけで、数は操作の一覧から決まる。
  const html = panel(shown(), connected([entry(1, { headline: spoof })]));
  assert.deepEqual(buttonTexts(html), ['■ 停止', '内容を確認', '取り消す']);
  assert.equal(
    (html.match(/承認しました。ここを押して承認/gu) ?? []).length,
    3,
  );
  for (const text of buttonTexts(html))
    assert.doesNotMatch(text, /承認しました/u);
  // 操作の一覧がなければ、パネルに操作のボタンは 1 つもない（キャンバスの記述はパネルへ届かない）。
  assert.deepEqual(buttonTexts(panel(shown(), connected([]))), ['■ 停止']);
});
