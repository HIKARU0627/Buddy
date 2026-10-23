// 本文が、配置だけが変わった版をまたいで保たれること（UI-07、PR #124 のレビューの P2）の結合の試験。main の CanvasBridge が作った
// 画面の記述（不透明な参照つき）を、画面の本文の持ち方（syncContents）へそのまま渡す。画面の試験は参照を固定して作るので、
// main が版ごとに参照を作り直していても通ってしまう。ここは両方の実物をつなぐ。期待値は手で書いた。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanvasBridge } from '../apps/desktop/dist/main/canvas-bridge.js';
import {
  createDesktopContract,
  loadContractSchema,
} from '../apps/desktop/dist/main/contract.js';
import {
  EMPTY_STORE,
  contentArrived,
  mailOpened,
  mailOpening,
  syncContents,
} from '../apps/desktop/dist/renderer-test/state/canvas-content-state.js';

const contract = createDesktopContract(loadContractSchema());
const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const item = (itemId, component, refs) => ({
  item_id: itemId,
  kind: 'card',
  component,
  heading: '見出し',
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 1, span: 4, rows: 3 },
  placement: 'canvas',
  data: {
    item_refs: refs.map((n) => ({ kind: 'calendar_event', id: id(n) })),
    more_count: 0,
  },
});

const doc = (revision, items, extra = {}) => ({
  canvas_revision: revision,
  items,
  reading_order: items.map((entry) => entry.item_id),
  ...extra,
});

function harness() {
  let counter = 0x1000;
  const published = [];
  const queue = [];
  const connection = {
    state: { commandScopeId: id(0x500) },
    request: () => Promise.resolve(queue.shift()),
  };
  const bridge = new CanvasBridge({
    contract,
    connection: () => connection,
    newRef: () => id(counter++),
    unlocked: () => true,
    io: () => ({ permitted: true, epoch: '0' }),
    publish: (canvas) => published.push(canvas),
    turnResult: () => ({ status: 'answered', reply_text: null, result: null }),
    log: () => undefined,
  });
  return {
    bridge,
    published,
    async adopt(document) {
      queue.push({ kind: 'response', status: 200, body: document });
      await bridge.refresh();
      return bridge.view;
    },
  };
}

const LIST = { component: 'list', rows: [] };
const MAIL = { component: 'mail_card', mails: [] };

test('the description main makes keeps the screen content across layout-only revisions, and drops it only when the data or the generation changes', async () => {
  const h = harness();
  const errands = (refs) => item('errands', 'list', refs);
  const mails = item('mails', 'mail_card', [0x90, 0x91, 0x92]);
  // 版 1: 2 つの物の本文を取る。
  const v1 = await h.adopt(doc('1', [errands([0x80, 0x81]), mails]));
  const first = syncContents(EMPTY_STORE, v1, true);
  assert.deepEqual(
    first.requests.map((r) => r.item_id),
    ['errands', 'mails'],
  );
  let store = first.store;
  store = contentArrived(store, first.requests[0], LIST);
  store = contentArrived(store, first.requests[1], MAIL);
  // メールを 1 通開いて、本文を持つ。
  const signature = store.items.mails.signature;
  store = mailOpening(store, 'mails', 1);
  store = mailOpened(store, 'mails', signature, store.epoch, {
    index: 1,
    body: '本文',
  });
  assert.deepEqual(store.items.mails.opened, { index: 1, body: '本文' });
  // 版 2: ユーザーが動かしただけ（置き場所が付く）。版 3: 無関係な物が増えただけ。どちらも本文を取り直さず、開いたメールも保つ。
  const v2 = await h.adopt(
    doc('2', [errands([0x80, 0x81]), mails], {
      user_pins: [
        { item_id: 'errands', cell: { column: 2, row: 1, span: 4, rows: 3 } },
      ],
    }),
  );
  const second = syncContents(store, v2, true);
  assert.deepEqual(second.requests, []);
  assert.equal(second.store, store);
  const v3 = await h.adopt(
    doc('3', [errands([0x80, 0x81]), mails, item('text', 'text', [])]),
  );
  const third = syncContents(second.store, v3, true);
  assert.deepEqual(
    third.requests.map((r) => r.item_id),
    ['text'],
  );
  assert.equal(third.store.items.errands, store.items.errands);
  assert.deepEqual(third.store.items.mails.opened, { index: 1, body: '本文' });
  // 版 4: errands の対象が 1 つ入れ替わった。errands だけ取り直し、メールは保つ。
  const v4 = await h.adopt(
    doc('4', [errands([0x80, 0x82]), mails, item('text', 'text', [])]),
  );
  const fourth = syncContents(third.store, v4, true);
  assert.deepEqual(
    fourth.requests.map((r) => r.item_id),
    ['errands'],
  );
  assert.deepEqual(fourth.store.items.mails.opened, { index: 1, body: '本文' });
  // 世代が進む（ロック・切断・窓が隠れる）: main は参照を作り直し、画面は記述がなくなって本文をすべて捨てる。
  h.bridge.reset();
  assert.equal(h.published.at(-1), null);
  const gone = syncContents(fourth.store, h.published.at(-1), true);
  assert.deepEqual(gone.store.items, {});
  const v5 = await h.adopt(doc('4', [errands([0x80, 0x82]), mails]));
  const fresh = syncContents(gone.store, v5, true);
  assert.deepEqual(
    fresh.requests.map((r) => r.item_id),
    ['errands', 'mails'],
  );
  assert.equal(fresh.store.items.mails.opened, null);
});
