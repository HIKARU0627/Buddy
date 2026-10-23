// キャンバスの物の中身（本文）の読み取り（canvas-bridge.ts の content。UI-07、ADR 0032）の部品の試験。中枢との接続は模擬
// （応答を決めた順に返す）で、送る要求・形式（Ajv）と意味（domain）の検査・世代・版の食い違い・本文を画面の記述・ログ・通知に
// 載せないことを確かめる。期待値は手で書く。127.0.0.1 の Core と通す統合の試験は canvas-vertical.test.ts。
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanvasContent,
  CanvasDocument,
  DesktopCanvasView,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import { CanvasBridge } from './canvas-bridge.js';
import type { CanvasHost } from './canvas-bridge.js';
import { createDesktopContract, loadContractSchema } from './contract.js';

const contract = createDesktopContract(loadContractSchema());

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SCOPE = id(0x500);

const item = (
  itemId: string,
  component: string,
  refs: number[],
): Record<string, unknown> => ({
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

const document = (
  revision: string,
  items: Record<string, unknown>[],
): CanvasDocument =>
  ({
    canvas_revision: revision,
    items,
    reading_order: items.map((entry) => entry['item_id']),
  }) as unknown as CanvasDocument;

// 手で書いた中身（件数は参照と同じ）。
const LIST: CanvasContent = {
  component: 'list',
  rows: [
    { title: '歯医者の予約を入れる', due_at: null, state: 'open' },
    { title: '書類を郵送する', due_at: '2026-10-24T01:00:00Z', state: 'done' },
  ],
};
const MAILS = (openIndex: number | null): CanvasContent =>
  ({
    component: 'mail_card',
    mails: [0, 1, 2].map((index) => ({
      from: `差出人${index}`,
      subject: `件名${index}`,
      received_at: '2026-10-24T00:30:00Z',
      labels: [],
      body: index === openIndex ? '本文の 1 行目\n本文の 2 行目' : null,
    })),
  }) as unknown as CanvasContent;

type Outcome =
  | { kind: 'not_sent'; reason: 'not_connected' }
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' };

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
  readonly scoped: boolean | undefined;
  readonly screenOperation: boolean | undefined;
}

function setup(
  options: {
    readonly unlocked?: () => boolean;
    readonly permitted?: () => boolean;
    readonly connected?: () => boolean;
  } = {},
) {
  const sent: Sent[] = [];
  const script: (Outcome | Promise<Outcome>)[] = [];
  const published: (DesktopCanvasView | null)[] = [];
  const logs: string[] = [];
  let refCounter = 0x1000;
  const connection = {
    state: { commandScopeId: SCOPE },
    request: (request: {
      method: string;
      path: string;
      body?: Record<string, unknown>;
      scoped?: boolean;
      screenOperation?: boolean;
    }) => {
      sent.push({
        method: request.method,
        path: request.path,
        body: request.body,
        scoped: request.scoped,
        screenOperation: request.screenOperation,
      });
      const next = script.shift();
      if (next === undefined) throw new Error('unscripted_request');
      return Promise.resolve(next);
    },
  } as unknown as ClientConnection;
  const host: CanvasHost = {
    contract,
    connection: () => (options.connected?.() === false ? null : connection),
    newRef: () => id(refCounter++),
    unlocked: options.unlocked ?? (() => true),
    io: () => ({ permitted: options.permitted?.() ?? true, epoch: '0' }),
    publish: (canvas) => published.push(canvas),
    turnResult: (turn) => ({
      status: turn.status,
      reply_text: turn.reply_text,
      result: null,
    }),
    log: (code) => logs.push(code),
  };
  return { bridge: new CanvasBridge(host), sent, script, published, logs };
}

const ok = (body: unknown): Outcome => ({
  kind: 'response',
  status: 200,
  body,
});

const response = (
  revision: string,
  itemId: string,
  openIndex: number | null,
  content: unknown,
) => ({
  request_id: id(0x900),
  canvas_revision: revision,
  item_id: itemId,
  open_index: openIndex,
  content,
});

// 記述を取り込んで、画面の記述（不透明な参照つき）を返す。
async function adopted(
  items: Record<string, unknown>[],
  revision = '3',
  options: Parameters<typeof setup>[0] = {},
) {
  const harness = setup(options);
  harness.script.push(ok(document(revision, items)));
  await harness.bridge.refresh();
  harness.sent.length = 0;
  const view = harness.bridge.view as DesktopCanvasView;
  return { ...harness, view };
}

test('the content request names only the item, the revision and the opened row (as a position); the body goes back and nowhere else', async () => {
  const { bridge, sent, script, published, logs, view } = await adopted([
    item('errands', 'list', [0x80, 0x81]),
  ]);
  script.push(ok(response('3', 'errands', null, LIST)));
  const result = await bridge.content('errands', '3', null);
  assert.deepEqual(result, {
    ok: true,
    value: {
      canvas_revision: '3',
      item_id: 'errands',
      open_index: null,
      content: LIST,
    },
  });
  // 送った要求: 読み取りの POST・接続範囲つき・画面操作の印は付けない。中枢の識別子（参照の ID）も画面の参照も本文もない。
  assert.deepEqual(sent, [
    {
      method: 'POST',
      path: '/v1/canvas/content',
      body: {
        expected_canvas_revision: '3',
        item_id: 'errands',
        open_index: null,
      },
      scoped: true,
      screenOperation: undefined,
    },
  ]);
  // 画面の記述は変わらず、通知は増えず、ログも出ない（本文を載せない）。
  assert.equal(published.length, 1);
  assert.deepEqual(bridge.view, view);
  assert.deepEqual(logs, []);
  assert(!JSON.stringify(view).includes('歯医者'));
  // 結果は中枢の識別子を含まない。
  assert(!JSON.stringify(result).includes(id(0x80)));
});

test('opening a mail turns the opaque ref of the row into its position, and only the opened row carries the body', async () => {
  const { bridge, sent, script, view } = await adopted([
    item('mails', 'mail_card', [0x80, 0x81, 0x82]),
  ]);
  const refs = view.items[0]?.data.item_refs ?? [];
  assert.equal(refs.length, 3);
  script.push(ok(response('3', 'mails', 1, MAILS(1))));
  const result = await bridge.content('mails', '3', refs[1]?.ref ?? '');
  assert(result.ok);
  assert.equal(result.value.open_index, 1);
  assert(result.value.content.component === 'mail_card');
  assert.deepEqual(
    result.value.content.mails.map((mail) => mail.body === null),
    [true, false, true],
  );
  // 中枢へ送るのは位置（1）で、画面の参照（ref）でも中枢の識別子でもない。
  assert.deepEqual(sent[0]?.body, {
    expected_canvas_revision: '3',
    item_id: 'mails',
    open_index: 1,
  });
  const text = JSON.stringify(sent);
  for (const entry of refs) assert(!text.includes(entry.ref));
  for (const n of [0x80, 0x81, 0x82]) assert(!text.includes(id(n)));
});

test('a request that cannot be matched to what is on screen is refused before anything is sent', async () => {
  const { bridge, sent, view } = await adopted([
    item('mails', 'mail_card', [0x80, 0x81]),
    item('errands', 'list', [0x90]),
  ]);
  const mailRef = view.items[0]?.data.item_refs[0]?.ref ?? '';
  const listRef = view.items[1]?.data.item_refs[0]?.ref ?? '';
  const refused = async (
    label: string,
    call: Promise<unknown>,
    reason: string,
  ) => {
    assert.deepEqual(await call, { ok: false, reason }, label);
  };
  // 画面が描いている版と違う（古い・新しい）。
  await refused(
    'stale revision',
    bridge.content('mails', '2', null),
    'canvas_conflict',
  );
  await refused(
    'newer revision',
    bridge.content('mails', '4', null),
    'canvas_conflict',
  );
  // 物がない。
  await refused(
    'unknown item',
    bridge.content('ghost', '3', null),
    'canvas_conflict',
  );
  // 本文を開く参照が、その物の行の参照でない（別の物の参照・作り話の参照）。
  await refused(
    'ref of another item',
    bridge.content('mails', '3', listRef),
    'canvas_conflict',
  );
  await refused(
    'unknown ref',
    bridge.content('mails', '3', id(0xdead)),
    'canvas_conflict',
  );
  // メール以外は本文を開けない。
  await refused(
    'open a list',
    bridge.content('errands', '3', listRef),
    'canvas_conflict',
  );
  assert.deepEqual(sent, []);
  // 参照が合えば送れる（比較のため。ここでは応答を用意しないので送る前で止める）。
  assert.notEqual(mailRef, '');
});

test('locked, stopped and disconnected states send nothing and return no content', async () => {
  for (const [label, patch, reason] of [
    ['locked', { locked: true }, 'device_locked'],
    ['stopped', { stopped: true }, 'input_stopped'],
    ['disconnected', { connected: false }, 'not_connected'],
  ] as const) {
    // 取り込みはふつうの状態で行ってから、状態を切り替える。
    const state = { locked: false, stopped: false, connected: true };
    const { bridge, sent } = await adopted(
      [item('errands', 'list', [0x80, 0x81])],
      '3',
      {
        unlocked: () => !state.locked,
        permitted: () => !state.stopped,
        connected: () => state.connected,
      },
    );
    Object.assign(state, patch);
    assert.deepEqual(
      await bridge.content('errands', '3', null),
      { ok: false, reason },
      label,
    );
    assert.deepEqual(sent, [], label);
  }
});

test('answers that break the contract, the meaning or the request are not passed on; the log has only a code', async () => {
  const mails = (openIndex: number | null) => MAILS(openIndex);
  const cases: [string, Record<string, unknown>[], unknown, string][] = [
    // Schema: 本文の項目・HTML の項目・上限（行 51 件）・未知の部品。
    [
      'extra field',
      [item('errands', 'list', [0x80, 0x81])],
      response('3', 'errands', null, { ...LIST, html: '<b>x</b>' }),
      'core_rejected',
    ],
    [
      'unknown component',
      [item('errands', 'list', [0x80, 0x81])],
      response('3', 'errands', null, { component: 'script', code: 'x' }),
      'core_rejected',
    ],
    [
      'not an object',
      [item('errands', 'list', [0x80, 0x81])],
      'x',
      'core_rejected',
    ],
    // domain だけが拒否する（Schema は通る）: 行の数が参照と違う・部品が違う・開いていない行の本文。
    [
      'rows differ from refs',
      [item('errands', 'list', [0x80, 0x81, 0x82])],
      response('3', 'errands', null, LIST),
      'core_rejected',
    ],
    [
      'component differs from the item',
      [item('errands', 'table', [0x80, 0x81])],
      response('3', 'errands', null, LIST),
      'core_rejected',
    ],
    [
      'body of a row that was not opened',
      [item('mails', 'mail_card', [0x80, 0x81, 0x82])],
      response('3', 'mails', null, mails(0)),
      'core_rejected',
    ],
    // 要求と応答が食い違う: 別の物・別の版・別の位置。
    [
      'another item',
      [item('errands', 'list', [0x80, 0x81])],
      response('3', 'other', null, LIST),
      'canvas_conflict',
    ],
    [
      'another revision',
      [item('errands', 'list', [0x80, 0x81])],
      response('4', 'errands', null, LIST),
      'canvas_conflict',
    ],
    [
      'another open position',
      [item('errands', 'list', [0x80, 0x81])],
      response('3', 'errands', 0, LIST),
      'canvas_conflict',
    ],
  ];
  for (const [label, items, body, reason] of cases) {
    const { bridge, script, logs, published } = await adopted(items);
    script.push(ok(body));
    const result = await bridge.content(
      String(items[0]?.['item_id']),
      '3',
      null,
    );
    assert.deepEqual(result, { ok: false, reason }, label);
    assert(!JSON.stringify(logs).includes('歯医者'), label);
    assert(
      logs.every((code) => /^[a-z_]+$/u.test(code)),
      `${label}: ${logs.join(',')}`,
    );
    // 画面の記述は変わらない。
    assert.equal(published.length, 1, label);
  }
});

test('a 409 from Core means the description moved on: the content is not returned and the description is fetched again', async () => {
  const { bridge, script, sent } = await adopted([
    item('errands', 'list', [0x80, 0x81]),
  ]);
  script.push({ kind: 'response', status: 409, body: { code: 'conflict' } });
  script.push(ok(document('4', [item('errands', 'list', [0x80, 0x81, 0x82])])));
  assert.deepEqual(await bridge.content('errands', '3', null), {
    ok: false,
    reason: 'canvas_conflict',
  });
  await bridge.idle();
  assert.deepEqual(
    sent.map((entry) => `${entry.method} ${entry.path}`),
    ['POST /v1/canvas/content', 'GET /v1/canvas'],
  );
  assert.equal(bridge.view?.canvas_revision, '4');
  // 取れなかった・結果不明は中身を返さない。
  script.push({ kind: 'response', status: 503, body: {} });
  assert.deepEqual(await bridge.content('errands', '4', null), {
    ok: false,
    reason: 'core_rejected',
  });
  script.push({ kind: 'unknown' });
  assert.deepEqual(await bridge.content('errands', '4', null), {
    ok: false,
    reason: 'not_connected',
  });
  script.push({ kind: 'not_sent', reason: 'not_connected' });
  assert.deepEqual(await bridge.content('errands', '4', null), {
    ok: false,
    reason: 'not_connected',
  });
});

test('the content of a generation that has ended is dropped: a reset, a lock or a newer description while waiting returns nothing', async () => {
  // 取っている間に reset（切断・世代の変化）。
  {
    const { bridge, script } = await adopted([
      item('errands', 'list', [0x80, 0x81]),
    ]);
    let release: (outcome: Outcome) => void = () => undefined;
    script.push(new Promise<Outcome>((resolve) => (release = resolve)));
    const pending = bridge.content('errands', '3', null);
    bridge.reset();
    release(ok(response('3', 'errands', null, LIST)));
    assert.deepEqual(await pending, { ok: false, reason: 'not_connected' });
    assert.equal(bridge.view, null);
  }
  // 取っている間にロック。
  {
    let locked = false;
    const { bridge, script } = await adopted(
      [item('errands', 'list', [0x80, 0x81])],
      '3',
      { unlocked: () => !locked },
    );
    let release: (outcome: Outcome) => void = () => undefined;
    script.push(new Promise<Outcome>((resolve) => (release = resolve)));
    const pending = bridge.content('errands', '3', null);
    locked = true;
    release(ok(response('3', 'errands', null, LIST)));
    assert.deepEqual(await pending, { ok: false, reason: 'device_locked' });
  }
  // 取っている間に停止。
  {
    let permitted = true;
    const { bridge, script } = await adopted(
      [item('errands', 'list', [0x80, 0x81])],
      '3',
      { permitted: () => permitted },
    );
    let release: (outcome: Outcome) => void = () => undefined;
    script.push(new Promise<Outcome>((resolve) => (release = resolve)));
    const pending = bridge.content('errands', '3', null);
    permitted = false;
    release(ok(response('3', 'errands', null, LIST)));
    assert.deepEqual(await pending, { ok: false, reason: 'input_stopped' });
  }
  // 取っている間に画面の記述が新しい版に進んだ（参照の位置がずれる）。
  {
    const { bridge, script } = await adopted([
      item('errands', 'list', [0x80, 0x81]),
    ]);
    let release: (outcome: Outcome) => void = () => undefined;
    script.push(new Promise<Outcome>((resolve) => (release = resolve)));
    const pending = bridge.content('errands', '3', null);
    script.push(ok(document('4', [item('errands', 'list', [0x80])])));
    await bridge.refresh();
    assert.equal(bridge.view?.canvas_revision, '4');
    release(ok(response('3', 'errands', null, LIST)));
    assert.deepEqual(await pending, { ok: false, reason: 'canvas_conflict' });
  }
});

const refsOf = (view: DesktopCanvasView | null, itemId: string): string[] =>
  (
    view?.items.find((entry) => entry.item_id === itemId)?.data.item_refs ?? []
  ).map((entry) => entry.ref);

test('within one generation the same target of the same item keeps the same opaque ref, so a layout-only revision does not make the screen drop its content', async () => {
  const items = (errandsRefs: number[]) => [
    item('errands', 'list', errandsRefs),
    item('mails', 'mail_card', [0x90, 0x91, 0x92]),
  ];
  const { bridge, script, published } = await adopted(items([0x80, 0x81]));
  const first = bridge.view;
  const errands = refsOf(first, 'errands');
  const mails = refsOf(first, 'mails');
  assert.equal(errands.length, 2);
  // 配置だけが変わった版（ユーザーの置き場所が付き、版が進む）: 参照は同じ。
  script.push(
    ok({
      ...document('4', items([0x80, 0x81])),
      user_pins: [
        { item_id: 'errands', cell: { column: 2, row: 1, span: 4, rows: 3 } },
      ],
    }),
  );
  await bridge.refresh();
  assert.equal(bridge.view?.canvas_revision, '4');
  assert.deepEqual(refsOf(bridge.view, 'errands'), errands);
  assert.deepEqual(refsOf(bridge.view, 'mails'), mails);
  assert.equal(published.length, 2);
  // 前の版で渡した参照で、本文を開く要求がそのまま通る（参照が変わらないので位置に直せる）。
  script.push(ok(response('4', 'mails', 1, MAILS(1))));
  const opened = await bridge.content('mails', '4', mails[1] ?? '');
  assert(opened.ok);
  assert.equal(opened.value.open_index, 1);
  // 参照が一部だけ変わった物: 残る対象は同じ参照、新しい対象は新しい参照、なくなった対象の参照は捨てる。
  script.push(ok(document('5', items([0x80, 0x82]))));
  await bridge.refresh();
  const changed = refsOf(bridge.view, 'errands');
  assert.equal(changed[0], errands[0]);
  assert.notEqual(changed[1], errands[1]);
  assert(!changed.includes(errands[1] ?? ''));
  assert.equal(bridge.refCount, 5);
  assert.deepEqual(refsOf(bridge.view, 'mails'), mails);
  // 同じ対象が 1 つの物に 2 回あれば、2 つの参照（出てきた順に同じ参照を保つ）。
  script.push(ok(document('6', items([0x80, 0x80]))));
  await bridge.refresh();
  const twice = refsOf(bridge.view, 'errands');
  assert.equal(new Set(twice).size, 2);
  assert.equal(twice[0], changed[0]);
  script.push(ok(document('7', items([0x80, 0x80]))));
  await bridge.refresh();
  assert.deepEqual(refsOf(bridge.view, 'errands'), twice);
  // 世代が進んだ（ロック・切断・窓が隠れる）と、すべて作り直す。
  bridge.reset();
  script.push(ok(document('8', items([0x80, 0x81]))));
  await bridge.refresh();
  const after = refsOf(bridge.view, 'errands');
  for (const ref of [...errands, ...changed, ...twice])
    assert(!after.includes(ref), 'no ref survives a new generation');
  assert(!refsOf(bridge.view, 'mails').some((ref) => mails.includes(ref)));
});
