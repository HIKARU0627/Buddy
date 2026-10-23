// キャンバスの物の中身（本文）の経路の画面側の試験（UI-07、ADR 0032）。happy-dom の文書に React で実際に描き、main への
// 要求（loadContent の模擬）・中身の持ち方（画面のメモリーだけ）・メールの本文を開く／閉じる・ロック（記述がなくなる）での
// 破棄・遅れて届いた答えを使わないこと・Web の保存の API を使わないこと・ドラッグの途中で画面の幅が変わったときの中断
// （PR #121 の P3 の持ち越し）を確かめる。期待値は手で書いた。本物のブラウザ・物理の入力ではない。
import { happy } from '../../test-support/happy-dom.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CanvasContent,
  CanvasUserOp,
  DesktopCanvasView,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import type { CanvasViewItem } from '../../state/canvas-state.js';
import type { ContentLoader } from '../../state/use-canvas-contents.js';
import { CanvasBoard } from './CanvasBoard.js';

after(async () => {
  await happy.happyDOM.close();
});

const ref = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const item = (
  id: string,
  component: CanvasViewItem['component'],
  refs: number[],
  overrides: Partial<CanvasViewItem> = {},
): CanvasViewItem => ({
  item_id: id,
  kind: 'card',
  component,
  heading: `見出し${id}`,
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 1, span: 6, rows: 3 },
  placement: 'canvas',
  data: {
    item_refs: refs.map((n) => ({ kind: 'calendar_event', ref: ref(n) })),
    more_count: 0,
  },
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

const LIST = (titles: string[]): CanvasContent => ({
  component: 'list',
  rows: titles.map((title) => ({
    title,
    due_at: null,
    state: 'open' as const,
  })),
});

// 3 通のメールの物（6 列 × 6 行 = 本文の高さ 434 で、1 通を開いても 3 通が入る）。
const mail = () =>
  item('m', 'mail_card', [1, 2, 3], {
    grid: { column: 1, span: 6, rows: 6 },
  });

const MAILS = (open: number | null): CanvasContent =>
  ({
    component: 'mail_card',
    mails: [0, 1, 2].map((index) => ({
      from: `差出人${index}`,
      subject: `件名${index}`,
      received_at: '2026-10-24T00:30:00Z',
      labels: [],
      body: index === open ? `本文${index}\n<b>x</b>` : null,
    })),
  }) as unknown as CanvasContent;

interface Call {
  readonly itemId: string;
  readonly revision: string;
  readonly openRef: string | null;
}

interface Mounted {
  readonly calls: Call[];
  readonly sent: [CanvasUserOp, string][];
  render(
    canvas: DesktopCanvasView | null,
    options?: {
      front?: boolean;
      size?: { width: number; height: number };
      insets?: { top: number; right: number; bottom: number; left: number };
    },
  ): Promise<void>;
  unmount(): void;
}

// loader の答えは handler が決める（Promise を返せば、その解決まで保つ）。
async function mount(
  handler: (call: Call) => ReturnType<ContentLoader>,
): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls: Call[] = [];
  const sent: [CanvasUserOp, string][] = [];
  const loader: ContentLoader = (itemId, revision, openRef) => {
    const call = { itemId, revision, openRef };
    calls.push(call);
    return handler(call);
  };
  const onUserOp = (op: CanvasUserOp, revision: string) => {
    sent.push([op, revision]);
    return Promise.resolve('9');
  };
  return {
    calls,
    sent,
    async render(canvas, options = {}) {
      await act(async () => {
        root.render(
          <AppProviders>
            <CanvasBoard
              view={canvas}
              front={options.front ?? false}
              viewport={options.size ?? { width: 1280, height: 800 }}
              {...(options.insets === undefined
                ? {}
                : { insets: options.insets })}
              loadContent={loader}
              onUserOp={onUserOp}
              now={new Date(2026, 9, 24, 12).getTime()}
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

const textNow = () => document.body.textContent ?? '';

const button = (label: string): HTMLElement => {
  const found = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  assert(found instanceof HTMLElement, label);
  return found;
};

const press = async (target: HTMLElement) => {
  await act(async () => {
    target.click();
  });
};

test('the content is asked for once per item, drawn when it arrives, and kept across revisions that do not change the data', async () => {
  const board = await mount(({ itemId }) =>
    Promise.resolve({
      content: LIST(itemId === 'a' ? ['朝の用事', '昼の用事'] : ['夜の用事']),
      open_index: null,
    }),
  );
  await board.render(
    view('4', [item('a', 'list', [1, 2]), item('b', 'list', [3])]),
  );
  assert.deepEqual(
    board.calls.map((call) => [call.itemId, call.revision, call.openRef]),
    [
      ['a', '4', null],
      ['b', '4', null],
    ],
  );
  assert(textNow().includes('朝の用事'));
  assert(textNow().includes('昼の用事'));
  assert(textNow().includes('夜の用事'));
  // 版だけが進んだ（動かした・大きさを変えた）: 取り直さない。中身はそのまま。
  await board.render(
    view('5', [item('a', 'list', [1, 2]), item('b', 'list', [3])], {
      user_pins: [
        { item_id: 'a', cell: { column: 2, row: 1, span: 4, rows: 3 } },
      ],
    }),
  );
  assert.equal(board.calls.length, 2);
  assert(textNow().includes('朝の用事'));
  // b のデータ（参照）が変わった: b だけ取り直す。a は取り直さない。
  await board.render(
    view('6', [item('a', 'list', [1, 2]), item('b', 'list', [3, 4])]),
  );
  assert.deepEqual(
    board.calls.slice(2).map((call) => [call.itemId, call.revision]),
    [['b', '6']],
  );
  board.unmount();
});

test('when the description goes away (lock, stop, disconnect) the content is dropped; a late answer is not shown and the next description is fetched afresh', async () => {
  const gates: ((value: {
    content: CanvasContent;
    open_index: null;
  }) => void)[] = [];
  const board = await mount(
    () =>
      new Promise((resolve) => {
        gates.push(resolve);
      }),
  );
  await board.render(view('4', [item('a', 'list', [1])]));
  assert.equal(board.calls.length, 1);
  // 答えを待つ間にロック（記述がなくなる）。
  await board.render(null);
  assert.equal(document.querySelector('[data-item]'), null);
  // 遅れて答えが届いても、何も描かない。
  await act(async () => {
    gates[0]?.({ content: LIST(['古い用事']), open_index: null });
  });
  assert(!textNow().includes('古い用事'));
  // 解除して同じ記述が届いたら、取り直す。前の答えは使わない。
  await board.render(view('5', [item('a', 'list', [1])]));
  assert.equal(board.calls.length, 2);
  assert(!textNow().includes('古い用事'));
  await act(async () => {
    gates[1]?.({ content: LIST(['新しい用事']), open_index: null });
  });
  assert(textNow().includes('新しい用事'));
  // もう一度ロックしたら、中身は画面からも消える。
  await board.render(null);
  assert(!textNow().includes('新しい用事'));
  board.unmount();
});

test('a fetch that failed shows only a mark with a spoken name and is tried again once when a newer revision arrives', async () => {
  let fail = true;
  const board = await mount(() =>
    Promise.resolve(
      fail ? null : { content: LIST(['戻った用事']), open_index: null },
    ),
  );
  await board.render(view('4', [item('a', 'list', [1])]));
  assert.notEqual(
    document.querySelector('[aria-label="中身を表示できません"]'),
    null,
  );
  assert.equal(board.calls.length, 1);
  // 同じ版を描き直しても取り直さない。
  await board.render(view('4', [item('a', 'list', [1])]));
  assert.equal(board.calls.length, 1);
  fail = false;
  await board.render(view('5', [item('a', 'list', [1])]));
  assert.equal(board.calls.length, 2);
  assert.equal(board.calls[1]?.revision, '5');
  assert(textNow().includes('戻った用事'));
  assert.equal(
    document.querySelector('[aria-label="中身を表示できません"]'),
    null,
  );
  board.unmount();
});

test('a mail body is asked for only when a row is opened (with the opaque ref of that row), shown as plain text, replaced by the next row and dropped on close', async () => {
  const board = await mount(({ openRef }) => {
    const open =
      openRef === null ? null : [ref(1), ref(2), ref(3)].indexOf(openRef);
    return Promise.resolve({ content: MAILS(open), open_index: open });
  });
  await board.render(view('4', [mail()]), {
    front: true,
  });
  // 取った中身には本文がない（開くまで取らない）。
  assert.deepEqual(
    board.calls.map((call) => call.openRef),
    [null],
  );
  assert(textNow().includes('件名1'));
  assert(!textNow().includes('本文1'));
  // 2 通目を開く: その行の不透明な参照を main へ送る。
  await press(button('件名1'));
  assert.deepEqual(board.calls.at(-1), {
    itemId: 'm',
    revision: '4',
    openRef: ref(2),
  });
  assert(textNow().includes('本文1'));
  // HTML はそのまま文字で、要素にならない。
  assert.equal(document.querySelector('[data-mail-body] b'), null);
  assert(textNow().includes('<b>x</b>'));
  // 3 通目を開く: 前の本文はこの時点で捨て、3 通目の本文だけを持つ。
  await press(button('件名2'));
  assert.equal(board.calls.at(-1)?.openRef, ref(3));
  assert(!textNow().includes('本文1'));
  assert(textNow().includes('本文2'));
  assert.equal(document.querySelectorAll('[data-mail-body]').length, 1);
  // 同じ行をもう一度押すと閉じ、本文を捨てる（取り直さない）。
  const before = board.calls.length;
  await press(button('件名2'));
  assert(!textNow().includes('本文2'));
  assert.equal(board.calls.length, before);
  // 後ろにある間は開けない（ボタンが押せない）。
  await board.render(view('4', [mail()]), {
    front: false,
  });
  const disabled = [...document.querySelectorAll('button')].filter(
    (candidate) => candidate.textContent?.includes('件名'),
  );
  assert(disabled.length > 0);
  assert(disabled.every((candidate) => candidate.hasAttribute('disabled')));
  board.unmount();
});

test('an opened mail body disappears with the description, and a late answer for it is not shown', async () => {
  const gates: ((value: {
    content: CanvasContent;
    open_index: number | null;
  }) => void)[] = [];
  const board = await mount(({ openRef }) =>
    openRef === null
      ? Promise.resolve({ content: MAILS(null), open_index: null })
      : new Promise((resolve) => {
          gates.push(resolve);
        }),
  );
  await board.render(view('4', [mail()]), {
    front: true,
  });
  await press(button('件名0'));
  assert.equal(gates.length, 1);
  // 本文を待つ間にロック。
  await board.render(null, { front: true });
  await act(async () => {
    gates[0]?.({ content: MAILS(0), open_index: 0 });
  });
  assert(!textNow().includes('本文0'));
  // 開いて本文を出した後にロックしても、本文は残らない。
  await board.render(view('5', [mail()]), {
    front: true,
  });
  await press(button('件名0'));
  await act(async () => {
    gates[1]?.({ content: MAILS(0), open_index: 0 });
  });
  assert(textNow().includes('本文0'));
  await board.render(null, { front: true });
  assert(!textNow().includes('本文0'));
  board.unmount();
});

test('content never reaches the Web storage of the window, and every string stays plain text (no element, no link) except the https source link', async () => {
  const evil = '<img src=x onerror=1> <a href="https://a.test">x</a>';
  const board = await mount(({ itemId }) =>
    Promise.resolve({
      content:
        itemId === 'l'
          ? LIST([evil])
          : ({
              component: 'source_list',
              sources: [
                { title: evil, url: 'https://www.example.com/a' },
                { title: '平文', url: 'http://www.example.com/' },
              ],
            } as unknown as CanvasContent),
      open_index: null,
    }),
  );
  await board.render(
    view('4', [item('l', 'list', [1]), item('s', 'source_list', [2, 3])]),
  );
  assert(textNow().includes(evil));
  assert.equal(document.querySelectorAll('img').length, 0);
  // リンクは https の出典の 1 つだけ。外部のブラウザーで開く印（target と rel）が付く。
  const links = [...document.querySelectorAll('a')];
  assert.equal(links.length, 1);
  assert.equal(links[0]?.getAttribute('href'), 'https://www.example.com/a');
  assert.equal(links[0]?.getAttribute('target'), '_blank');
  assert.equal(links[0]?.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(window.localStorage.length, 0);
  assert.equal(window.sessionStorage.length, 0);
  assert.equal(document.cookie, '');
  board.unmount();
});

test('a drag is stopped when the screen width changes in the middle of it: nothing is sent and the card is no longer held', async () => {
  const board = await mount(() =>
    Promise.resolve({ content: LIST(['用事']), open_index: null }),
  );
  const a = item('a', 'list', [1], { grid: { column: 1, span: 4, rows: 2 } });
  await board.render(view('3', [a]), { front: true });
  const card = () => {
    const found = document.querySelector('[data-item="a"]');
    assert(found instanceof HTMLElement);
    return found;
  };
  const grip = card().querySelector('.cursor-grab');
  assert(grip instanceof HTMLElement);
  await act(async () => {
    grip.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: 60,
        clientY: 40,
      }),
    );
  });
  // 98 ピクセル右へ（1 列分）動かす途中で、掴んだ物は持ち上がっている。
  await act(async () => {
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        clientX: 158,
        clientY: 40,
      }),
    );
  });
  assert.equal(card().getAttribute('data-dragging'), 'true');
  assert.equal(card().getAttribute('data-source'), 'held');
  // 画面の幅が変わった（1280 → 1000。格子の列の幅が変わる）: ドラッグを中断する。
  await board.render(view('3', [a]), {
    front: true,
    size: { width: 1000, height: 800 },
  });
  assert.equal(card().getAttribute('data-dragging'), null);
  assert.notEqual(card().getAttribute('data-source'), 'held');
  // その後に離しても、操作は送らない（中断した）。動かしても何も起きない。
  await act(async () => {
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        clientX: 300,
        clientY: 40,
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        clientX: 300,
        clientY: 40,
      }),
    );
  });
  assert.deepEqual(board.sent, []);
  assert.equal(card().getAttribute('data-dragging'), null);
  // 作業領域の外の幅だけが変わる場合（窓の大きさは同じ。Dock の表示など）も中断する。
  await act(async () => {
    grip.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 2,
        clientX: 60,
        clientY: 40,
      }),
    );
  });
  assert.equal(card().getAttribute('data-dragging'), 'true');
  await board.render(view('3', [a]), {
    front: true,
    size: { width: 1000, height: 800 },
    insets: { top: 0, right: 0, bottom: 70, left: 0 },
  });
  assert.equal(card().getAttribute('data-dragging'), null);
  await act(async () => {
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 2,
        clientX: 300,
        clientY: 40,
      }),
    );
  });
  assert.deepEqual(board.sent, []);
  board.unmount();
});

test('a failure that arrives after a newer revision is retried once at that revision, not left as a failed mark', async () => {
  const gates: ((
    value: { content: CanvasContent; open_index: null } | null,
  ) => void)[] = [];
  const board = await mount(
    () =>
      new Promise((resolve) => {
        gates.push(resolve);
      }),
  );
  const text = (revision: string) => view(revision, [item('t', 'text', [])]);
  await board.render(text('1'));
  assert.deepEqual(
    board.calls.map((call) => call.revision),
    ['1'],
  );
  // 版 1 の取得の途中に版 2 が届く（物のデータは同じなので、重ねて取らない）。
  await board.render(text('2'));
  assert.equal(board.calls.length, 1);
  // main が古い取得を拒否した（canvas_conflict）: 失敗の応答。新しい版 2 で 1 度だけ取り直す。
  await act(async () => {
    gates[0]?.(null);
  });
  assert.deepEqual(
    board.calls.map((call) => call.revision),
    ['1', '2'],
  );
  assert.equal(
    document.querySelector('[aria-label="中身を表示できません"]'),
    null,
  );
  // 取り直しが同じ版のまま失敗したら、印のまま（さらに取り直さない）。
  await act(async () => {
    gates[1]?.(null);
  });
  assert.equal(board.calls.length, 2);
  assert.notEqual(
    document.querySelector('[aria-label="中身を表示できません"]'),
    null,
  );
  board.unmount();
});
