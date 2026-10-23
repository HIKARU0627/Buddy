// キャンバスの窓の操作の試験（UI-06、PR #121 のレビュー）。happy-dom の文書の上に React で実際に描き、フォーカス・ポインター・
// キーの事象を送って、選んだ物とキーボードの操作の対象がそろうこと・札から物を見せること・送信中の保護・作業領域だけの
// 変化での計算し直しを確かめる。期待値は手で書いた（1280 × 800: 左 24・上 24、列の送り 98、行の送り 88）。
// 本物のブラウザ・物理の入力ではない（docs/ui/canvas-layout.md）。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CanvasUserOp,
  DesktopCanvasView,
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopStatusBar,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import type { CanvasViewItem } from '../../state/canvas-state.js';
import { CanvasBoard } from './CanvasBoard.js';
import { RoleWindow } from './RoleWindow.js';

after(async () => {
  await happy.happyDOM.close();
});

const item = (
  id: string,
  overrides: Partial<CanvasViewItem> = {},
): CanvasViewItem => ({
  item_id: id,
  kind: 'card',
  component: 'list',
  heading: `見出し${id}`,
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 1, span: 4, rows: 2 },
  placement: 'canvas',
  data: { item_refs: [], more_count: 0 },
  ...overrides,
});

const view = (
  revision: string,
  items: CanvasViewItem[],
  extra: Partial<DesktopCanvasView> = {},
): DesktopCanvasView => ({
  canvas_revision: revision,
  items,
  reading_order: items
    .filter((entry) => entry.placement === 'canvas')
    .map((entry) => entry.item_id),
  ...extra,
});

interface Mounted {
  readonly sent: [CanvasUserOp, string][];
  render(
    canvas: DesktopCanvasView,
    size?: { width: number; height: number },
  ): Promise<void>;
  unmount(): void;
}

// CanvasBoard を前に出した状態で描く。onUserOp は送った操作を覚え、answer の値（当てた版か null）を返す。
async function mountBoard(
  answer: (op: CanvasUserOp) => string | null = () => '9',
): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sent: [CanvasUserOp, string][] = [];
  const onUserOp = (op: CanvasUserOp, revision: string) => {
    sent.push([op, revision]);
    return Promise.resolve(answer(op));
  };
  return {
    sent,
    async render(canvas, size = { width: 1280, height: 800 }) {
      await act(async () => {
        root.render(
          <AppProviders>
            <CanvasBoard
              view={canvas}
              front
              viewport={size}
              onUserOp={onUserOp}
            />
          </AppProviders>,
        );
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const card = (id: string): HTMLElement => {
  const found = document.querySelector(`[data-item="${id}"]`);
  assert(found instanceof HTMLElement, id);
  return found;
};

const press = async (label: string) => {
  const button = document.querySelector(`[aria-label="${label}"]`);
  assert(button instanceof HTMLElement, label);
  await act(async () => {
    button.click();
  });
};

test('Tab to A, then grab B with the mouse, then Delete: B is closed (focus follows the grabbed card)', async () => {
  const board = await mountBoard();
  await board.render(
    view('3', [
      item('a'),
      item('b', { grid: { column: 7, span: 4, rows: 2 } }),
    ]),
  );
  // Tab で A にフォーカス。
  await act(async () => {
    card('a').focus();
  });
  assert.equal(document.activeElement, card('a'));
  // B の見出しの帯を掴んで、動かさずに離す。
  const grip = card('b').querySelector('.cursor-grab');
  assert(grip instanceof HTMLElement);
  await act(async () => {
    grip.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: 700,
        clientY: 40,
      }),
    );
  });
  await act(async () => {
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        clientX: 700,
        clientY: 40,
      }),
    );
  });
  assert.equal(document.activeElement, card('b'));
  await act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.deepEqual(board.sent, [[{ kind: 'close', item_id: 'b' }, '3']]);
  board.unmount();
});

test('a tag shows its card by click and moves another card to a tag; the tag can also close or shelve', async () => {
  const board = await mountBoard();
  // 480 × 800 の 1 列。3 行ずつの a・b が入り、c は札。
  const items = ['a', 'b', 'c'].map((id) =>
    item(id, { grid: { column: 1, span: 4, rows: 3 } }),
  );
  await board.render(view('3', items), { width: 480, height: 800 });
  assert.equal(document.querySelector('[data-item="c"]'), null);
  assert.notEqual(document.querySelector('[data-overflow="c"]'), null);
  await press('見出しcを見せる');
  // c が見える場所に出て（a の下、y 24 + 248 + 16 = 288）フォーカスを受け、b が札に回る。記述は変えない（送らない）。
  assert.equal(card('c').style.top, '288px');
  assert.equal(document.activeElement, card('c'));
  assert.equal(document.querySelector('[data-item="b"]'), null);
  assert.notEqual(document.querySelector('[data-overflow="b"]'), null);
  assert.deepEqual(board.sent, []);
  // 札から閉じる・片付ける。
  await press('見出しbを閉じる');
  assert.deepEqual(board.sent, [[{ kind: 'close', item_id: 'b' }, '3']]);
  board.unmount();
  const second = await mountBoard();
  await second.render(view('3', items), { width: 480, height: 800 });
  await press('見出しcを棚へ片付ける');
  assert.deepEqual(second.sent, [[{ kind: 'shelve', item_id: 'c' }, '3']]);
  second.unmount();
});

test('a sent move stays where it was sent while an unrelated revision arrives, until the applied revision comes', async () => {
  const board = await mountBoard(() => '5');
  const b = item('b', { grid: { column: 7, span: 4, rows: 2 } });
  await board.render(view('3', [item('a'), b]));
  // a は列 1（left 24）。→ で列 2 へ（left 24 + 98 = 122）。応答は当てた版 5。
  assert.equal(card('a').style.left, '24px');
  await act(async () => {
    card('a').focus();
  });
  await act(async () => {
    card('a').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.deepEqual(board.sent, [
    [
      {
        kind: 'move',
        item_id: 'a',
        cell: { row: 1, column: 2, span: 4, rows: 2 },
      },
      '3',
    ],
  ]);
  assert.equal(card('a').style.left, '122px');
  // ほかの物（b）だけが変わった版 4 が届く: a は送った位置のまま（守る）。
  await board.render(view('4', [item('a'), { ...b, emphasis: 'high' }]));
  assert.equal(card('a').style.left, '122px');
  assert.equal(card('a').getAttribute('data-source'), 'held');
  // 当てた版 5（ユーザーの置き場所を持つ）が届くと、ユーザーの置き場所として描く。
  await board.render(
    view('5', [item('a'), b], {
      user_pins: [
        { item_id: 'a', cell: { column: 2, row: 1, span: 4, rows: 2 } },
      ],
    }),
  );
  assert.equal(card('a').style.left, '122px');
  assert.equal(card('a').getAttribute('data-source'), 'user');
  board.unmount();
});

test('a tag shows its card even when it does not fit as is: a focus card shrinks at 480 × 400, a user pin steps aside at 1280 × 300', async () => {
  const board = await mountBoard();
  // 480 × 400: 置ける高さ 200。焦点 f（3 行 = 248）は入らず札。見せると 2 行（160）に縮めて出る。
  await board.render(
    view('3', [
      item('a'),
      item('f', { emphasis: 'high', grid: { column: 1, span: 4, rows: 3 } }),
    ]),
    { width: 480, height: 400 },
  );
  assert.equal(document.querySelector('[data-item="f"]'), null);
  await press('見出しfを見せる');
  assert.equal(card('f').style.height, '160px');
  assert.equal(document.activeElement, card('f'));
  assert.notEqual(document.querySelector('[data-overflow="a"]'), null);
  board.unmount();
  // 1280 × 300（2 行）: ユーザーの置き場所 p が全体を埋め、x は札。見せると x が列 1 に出て（left 24・4 列 × 2 行）、
  // p は列 5 から 8 列 × 1 行（left 24 + 4 × 98 = 416・高さ 72）へ下がる。
  const second = await mountBoard();
  await second.render(
    view(
      '3',
      [item('p'), item('x', { grid: { column: 1, span: 4, rows: 2 } })],
      {
        user_pins: [
          { item_id: 'p', cell: { column: 1, row: 1, span: 12, rows: 2 } },
        ],
      },
    ),
    { width: 1280, height: 300 },
  );
  assert.equal(document.querySelector('[data-item="x"]'), null);
  await press('見出しxを見せる');
  assert.equal(card('x').style.left, '24px');
  assert.equal(card('x').style.height, '160px');
  assert.equal(card('p').style.left, '416px');
  assert.equal(card('p').style.height, '72px');
  assert.deepEqual(second.sent, []);
  second.unmount();
});

test('a card shown from its tag at 840 × 272 keeps a readable heading: at least 160 px wide, the heading on its own row above the controls', async () => {
  const board = await mountBoard();
  // ユーザーの置き場所 p が列 1 から 10 列を埋め、周辺の x（4 列）は札。最小の幅は 3 列（168）なので、残りの 2 列
  // （107）には縮めない。見せると x が列 1 から 4 列（幅 229）に出て、p が下がる。
  await board.render(
    view(
      '3',
      [
        item('p'),
        item('x', {
          emphasis: 'low',
          grid: { column: 1, span: 4, rows: 2 },
        }),
      ],
      {
        user_pins: [
          { item_id: 'p', cell: { column: 1, row: 1, span: 10, rows: 1 } },
        ],
      },
    ),
    { width: 840, height: 272 },
  );
  assert.equal(document.querySelector('[data-item="x"]'), null);
  await press('見出しxを見せる');
  assert.equal(card('x').style.width, '229px');
  assert(Number.parseInt(card('x').style.width, 10) >= 160);
  // 狭い箱（240 未満）: 見出しは 1 行目に幅いっぱい（操作の印と同じ行に並べない）、件数と操作の印はその下の行。
  const header = card('x').querySelector('[data-header]');
  assert(header instanceof HTMLElement);
  assert.equal(header.getAttribute('data-header'), 'stacked');
  const title = header.firstElementChild;
  assert(title instanceof HTMLElement);
  assert.equal(title.textContent, '見出しx');
  assert.match(title.className, /w-full/u);
  const tools = header.querySelector('[data-header-tools]');
  assert(tools instanceof HTMLElement);
  assert.notEqual(tools.querySelector('[aria-label="見出しxを閉じる"]'), null);
  assert.equal(title.contains(tools), false);
  // 広い箱（p、幅 475）は 1 行に並べる。
  assert.equal(
    card('p').querySelector('[data-header]')?.getAttribute('data-header'),
    'inline',
  );
  board.unmount();
});

test('below the minimum height the tags cannot show a card: no show button, only shelve and close', async () => {
  const board = await mountBoard();
  await board.render(view('3', [item('a'), item('b')]), {
    width: 1280,
    height: 200,
  });
  assert.equal(document.querySelector('[aria-label="見出しaを見せる"]'), null);
  assert.equal(
    document.querySelectorAll('[data-revealable="false"]').length,
    2,
  );
  await press('見出しaを棚へ片付ける');
  assert.deepEqual(board.sent, [[{ kind: 'shelve', item_id: 'a' }, '3']]);
  board.unmount();
});

const STATUS: DesktopStatusBar = {
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
};

test('when only the work area changes (the window keeps its size), the canvas window lays out again from the notified insets', async () => {
  let listener: ((notification: DesktopIpcNotification) => void) | null = null;
  const api = {
    windowRole: 'canvas',
    invoke: (request: DesktopIpcRequest): Promise<DesktopIpcResponse> =>
      Promise.resolve({
        request_id: request.request_id,
        channel: 'desktop.get_state',
        outcome: 'ok',
        status: STATUS,
      } as DesktopIpcResponse),
    onNotification: (next: (notification: DesktopIpcNotification) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  const notify = async (notification: DesktopIpcNotification) => {
    await act(async () => {
      listener?.(notification);
    });
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProviders>
        <RoleWindow api={api} role="canvas" />
      </AppProviders>,
    );
  });
  await notify({
    channel: 'desktop.canvas_changed',
    canvas: view('3', [item('a'), item('s', { placement: 'shelf' })]),
  });
  // 作業領域の外がない: a は上 24、棚は y 800 − 16 − 56 = 728。
  assert.equal(card('a').style.top, '24px');
  const shelf = () => {
    const found = document.querySelector('[data-shelf]');
    assert(found instanceof HTMLElement);
    return found;
  };
  assert.equal(shelf().style.top, '728px');
  const width = window.innerWidth;
  const height = window.innerHeight;
  // main が作業領域の変化（メニューバー 25・Dock 75）を知らせる。窓の大きさは変わらない。
  await notify({
    channel: 'desktop.canvas_work_area',
    insets: { top: 25, right: 0, bottom: 75, left: 0 },
  });
  assert.equal(window.innerWidth, width);
  assert.equal(window.innerHeight, height);
  // a は上 25 + 24 = 49、棚は作業領域の下端 725 から 16 + 56 上の 653。
  assert.equal(card('a').style.top, '49px');
  assert.equal(shelf().style.top, '653px');
  act(() => root.unmount());
  container.remove();
});
