// キャンバスの経路（canvas-bridge.ts。UI-03、ADR 0032）の部品の試験。中枢との接続は模擬（応答を決めた順に返す）で、
// 形式（Ajv）・意味（domain）・世代・取得の順・不透明な参照の置き換え・発言の結果の扱いを確かめる。期待値は手で書く。
// 中枢の実物（127.0.0.1 の Core）を使う統合の試験は canvas-vertical.test.ts。
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanvasDocument,
  DesktopCanvasView,
  StreamTurnResponse,
} from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import { CanvasBridge } from './canvas-bridge.js';
import type { CanvasHost } from './canvas-bridge.js';
import { createDesktopContract, loadContractSchema } from './contract.js';

const contract = createDesktopContract(loadContractSchema());

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const card = (refs: number[], overrides: Record<string, unknown> = {}) => ({
  item_id: 'errands',
  kind: 'card',
  component: 'list',
  heading: '今日の用事',
  emphasis: 'high',
  group: null,
  relations: [],
  grid: { column: 2, span: 4, rows: 3 },
  placement: 'canvas',
  data: {
    item_refs: refs.map((n) => ({ kind: 'calendar_event', id: id(n) })),
    more_count: 0,
  },
  ...overrides,
});

const document = (
  revision: string,
  refs: number[] = [0x80, 0x81],
  overrides: Record<string, unknown> = {},
): CanvasDocument =>
  ({
    canvas_revision: revision,
    items: [card(refs, overrides)],
    reading_order: ['errands'],
  }) as unknown as CanvasDocument;

type Outcome =
  | { kind: 'not_sent'; reason: 'not_connected' }
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' };

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
}

function setup(
  options: {
    readonly unlocked?: () => boolean;
    readonly permitted?: () => boolean;
    readonly epoch?: () => string;
  } = {},
) {
  const sent: Sent[] = [];
  // 応答を決めた順に返す。Promise なら、その解決まで応答を保つ（取得の順・世代の競合を作る）。
  const script: (Outcome | Promise<Outcome>)[] = [];
  const published: (DesktopCanvasView | null)[] = [];
  const logs: string[] = [];
  let refCounter = 0x1000;
  const connection = {
    state: { commandScopeId: id(0x500) },
    request: (request: {
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }) => {
      sent.push({
        method: request.method,
        path: request.path,
        body: request.body,
      });
      const next = script.shift();
      if (next === undefined) throw new Error('unscripted_request');
      return Promise.resolve(next);
    },
  } as unknown as ClientConnection;
  const host: CanvasHost = {
    contract,
    connection: () => connection,
    newRef: () => id(refCounter++),
    unlocked: options.unlocked ?? (() => true),
    io: () => ({
      permitted: options.permitted?.() ?? true,
      epoch: options.epoch?.() ?? '0',
    }),
    publish: (canvas) => published.push(canvas),
    turnResult: (turn) => ({
      status: turn.status,
      reply_text: turn.reply_text,
      result: null,
    }),
    log: (code) => logs.push(code),
  };
  return {
    bridge: new CanvasBridge(host),
    sent,
    script,
    published,
    logs,
  };
}

const ok = (body: unknown): Outcome => ({
  kind: 'response',
  status: 200,
  body,
});

test('a valid description is adopted with every id replaced by an opaque ref; the real ids stay in main', async () => {
  const { bridge, script, published, sent } = setup();
  script.push(ok(document('1')));
  await bridge.refresh();
  assert.deepEqual(sent, [
    { method: 'GET', path: '/v1/canvas', body: undefined },
  ]);
  assert.equal(published.length, 1);
  const view = published[0] as DesktopCanvasView;
  assert.equal(view.canvas_revision, '1');
  assert.deepEqual(view.reading_order, ['errands']);
  assert.equal(view.items.length, 1);
  const item = view.items[0];
  assert.equal(item?.heading, '今日の用事');
  assert.equal(item?.component, 'list');
  assert.equal(item?.emphasis, 'high');
  assert.deepEqual(item?.grid, { column: 2, span: 4, rows: 3 });
  const refs = item?.data.item_refs ?? [];
  assert.equal(refs.length, 2);
  for (const entry of refs) {
    assert.equal(entry.kind, 'calendar_event');
    assert.match(entry.ref, UUID);
    assert.equal('id' in entry, false);
  }
  assert.notEqual(refs[0]?.ref, refs[1]?.ref);
  // 中枢の識別子は画面へ渡す値のどこにも入らない（手で書いた元の ID）。
  const text = JSON.stringify(view);
  assert(!text.includes(id(0x80)) && !text.includes(id(0x81)));
  assert(contract.valid('DesktopCanvasView', view));
  assert.equal(bridge.refCount, 2);
  assert.deepEqual(bridge.view, view);
});

test('a description that fails the schema or the domain check is dropped and the previous version stays', async () => {
  const { bridge, script, published, logs } = setup();
  script.push(ok(document('1')));
  await bridge.refresh();
  assert.equal(published.length, 1);
  const before = JSON.stringify(bridge.view);
  const bad: [string, unknown][] = [
    // Schema: 説明文の項目・見出しのマークアップ・上限を超える見出し・未知の部品。
    ['description', document('2', [0x80], { description: '説明' })],
    ['markup', document('2', [0x80], { heading: '<b>x</b>' })],
    ['long', document('2', [0x80], { heading: 'あ'.repeat(25) })],
    ['component', document('2', [0x80], { component: 'script' })],
    ['not an object', 'x'],
    // domain だけが拒否する（Schema は通る）: 読む順に見える物がない・参照が 51 件・more_count だけが残る。
    ['reading order missing', { ...document('2'), reading_order: [] }],
    [
      'more count without 50 refs',
      document('2', [0x80], {
        data: {
          item_refs: [{ kind: 'calendar_event', id: id(0x80) }],
          more_count: 4,
        },
      }),
    ],
    [
      'grid overflow',
      document('2', [0x80], { grid: { column: 10, span: 6, rows: 1 } }),
    ],
  ];
  for (const [, body] of bad) script.push(ok(body));
  for (const [name] of bad) {
    await bridge.refresh();
    assert.equal(JSON.stringify(bridge.view), before, name);
  }
  assert.equal(published.length, 1);
  assert.deepEqual(
    logs,
    bad.map(() => 'canvas_document_rejected'),
  );
  // 取れなかった（状態が 200 でない・結果不明）ときも前の版を残す。
  script.push({ kind: 'response', status: 503, body: {} });
  script.push({ kind: 'unknown' });
  script.push({ kind: 'not_sent', reason: 'not_connected' });
  await bridge.refresh();
  await bridge.refresh();
  await bridge.refresh();
  assert.equal(JSON.stringify(bridge.view), before);
  assert.equal(published.length, 1);
  // 正しい版は受け付ける。
  script.push(ok(document('2', [0x82])));
  await bridge.refresh();
  assert.equal(published.length, 2);
  assert.equal(bridge.view?.canvas_revision, '2');
});

test('the version never goes back in a generation, and the same version is not handed over again', async () => {
  const { bridge, script, published } = setup();
  script.push(ok(document('3')));
  await bridge.refresh();
  script.push(ok(document('3')));
  await bridge.refresh();
  script.push(ok(document('2')));
  await bridge.refresh();
  assert.equal(published.length, 1);
  assert.equal(bridge.view?.canvas_revision, '3');
  script.push(ok(document('10')));
  await bridge.refresh();
  assert.equal(bridge.view?.canvas_revision, '10');
});

test('reset discards the description and the refs and tells the window once', async () => {
  const { bridge, script, published } = setup();
  bridge.reset();
  // まだ何も渡していなければ通知しない。
  assert.deepEqual(published, []);
  script.push(ok(document('1')));
  await bridge.refresh();
  assert.equal(bridge.refCount, 2);
  bridge.reset();
  assert.deepEqual(published.at(-1), null);
  assert.equal(published.length, 2);
  assert.equal(bridge.view === null, true);
  assert.equal(bridge.refCount, 0);
  bridge.reset();
  assert.equal(published.length, 2);
  // 捨てた後は版が戻っても（0 から）受け取れる（新しい世代）。
  script.push(ok(document('0', [])));
  await bridge.refresh();
  assert.equal(bridge.view?.canvas_revision, '0');
});

test('an answer that arrives after the generation changed (lock, disconnect) changes nothing', async () => {
  const { bridge, script, published } = setup();
  let release: (outcome: Outcome) => void = () => undefined;
  script.push(new Promise<Outcome>((resolve) => (release = resolve)));
  const pending = bridge.refresh();
  bridge.reset();
  release(ok(document('1')));
  await pending;
  assert.deepEqual(published, []);
  assert.equal(bridge.view, null);
  assert.equal(bridge.refCount, 0);
});

test('only the latest fetch counts: an older answer that arrives late does not replace a newer description', async () => {
  const { bridge, script, published } = setup();
  let releaseFirst: (outcome: Outcome) => void = () => undefined;
  script.push(new Promise<Outcome>((resolve) => (releaseFirst = resolve)));
  script.push(ok(document('2', [0x82])));
  const first = bridge.refresh();
  const second = bridge.refresh();
  await second;
  assert.equal(bridge.view?.canvas_revision, '2');
  releaseFirst(ok(document('1', [0x81])));
  await first;
  assert.equal(bridge.view?.canvas_revision, '2');
  assert.equal(published.length, 1);
});

test('while locked or unknown nothing is fetched, and a version notice is ignored', async () => {
  let unlocked = false;
  const { bridge, script, sent, published } = setup({
    unlocked: () => unlocked,
  });
  await bridge.refresh();
  bridge.onRevision('5');
  assert.deepEqual(sent, []);
  // ロック中に取得を始めて、結果が届く前にロックした: 反映しない。
  unlocked = true;
  script.push(ok(document('1')));
  const pending = bridge.refresh();
  unlocked = false;
  await pending;
  assert.deepEqual(published, []);
  assert.equal(bridge.view, null);
});

test('a version notice fetches only when it is newer than the description in hand', async () => {
  const { bridge, script, sent } = setup();
  script.push(ok(document('3')));
  await bridge.refresh();
  assert.equal(sent.length, 1);
  bridge.onRevision('3');
  bridge.onRevision('2');
  assert.equal(sent.length, 1);
  script.push(ok(document('4', [0x90])));
  bridge.onRevision('4');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.equal(bridge.view?.canvas_revision, '4');
});

const turnBody = (canvas: unknown): StreamTurnResponse =>
  ({
    request_id: id(1),
    segment: {
      segment_id: id(2),
      storage_mode: 'normal',
      opened_at: '2026-10-05T00:00:00.000Z',
      open_reason: 'stream_started',
      carried_summary: null,
    },
    turn_id: id(3),
    input_id: id(4),
    workflow_id: null,
    status: 'answered',
    result_view: null,
    reply_text: null,
    canvas,
  }) as unknown as StreamTurnResponse;

test('a message is sent to the stream with the version in hand, and no conversation or segment id', async () => {
  const { bridge, script, sent } = setup();
  script.push(ok(turnBody(null)));
  const first = await bridge.submitTurn('今日の用事を見せて');
  assert.deepEqual(first, {
    ok: true,
    value: { status: 'answered', reply_text: null, result: null },
  });
  assert.equal(sent[0]?.method, 'POST');
  assert.equal(sent[0]?.path, '/v1/stream/turns');
  assert.deepEqual(sent[0]?.body, {
    text: '今日の用事を見せて',
    input_kind: 'text',
    expected_canvas_revision: '0',
    // scoped の要求に付く値は、模擬の接続が付けないので、ここには入らない。
  });
  // 描いている版を添える。
  script.push(ok(document('4')));
  await bridge.refresh();
  script.push(ok(turnBody(null)));
  await bridge.submitTurn('もう一度');
  assert.equal(sent.at(-1)?.body?.['expected_canvas_revision'], '4');
});

test('when the answer changed the canvas the description is fetched; otherwise it is not', async () => {
  const { bridge, script, sent } = setup();
  script.push(ok(turnBody(null)));
  await bridge.submitTurn('こんにちは');
  assert.equal(sent.length, 1);
  script.push(
    ok(
      turnBody({
        base_canvas_revision: '0',
        canvas_revision: '1',
        ops: [{ op: 'close', item_id: 'x' }],
        reading_order: [],
      }),
    ),
  );
  script.push(ok(document('1')));
  await bridge.submitTurn('今日の用事を見せて');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 3);
  assert.equal(sent[2]?.path, '/v1/canvas');
  assert.equal(bridge.view?.canvas_revision, '1');
});

test('message failures: not sent, unknown, rejected, malformed, stopped input, and a generation change after sending', async () => {
  const ctx = setup();
  const { bridge, script } = ctx;
  script.push({ kind: 'not_sent', reason: 'not_connected' });
  assert.deepEqual(await bridge.submitTurn('a'), {
    ok: false,
    reason: 'not_connected',
  });
  // 結果が分からないときは自動で送り直さず、そのまま返す。
  script.push({ kind: 'unknown' });
  assert.deepEqual(await bridge.submitTurn('a'), {
    ok: false,
    reason: 'outcome_unknown',
  });
  script.push({ kind: 'response', status: 409, body: {} });
  assert.deepEqual(await bridge.submitTurn('a'), {
    ok: false,
    reason: 'core_rejected',
  });
  // 契約に合わない 200（canvas の項目がない）。
  const withoutCanvas: Record<string, unknown> = { ...turnBody(null) };
  delete withoutCanvas['canvas'];
  script.push(ok(withoutCanvas));
  assert.deepEqual(await bridge.submitTurn('a'), {
    ok: false,
    reason: 'core_rejected',
  });
  // 送った後に世代が変わった: 結果を渡さず、結果不明（未送信と答えない）。
  let release: (outcome: Outcome) => void = () => undefined;
  script.push(new Promise<Outcome>((resolve) => (release = resolve)));
  const pending = bridge.submitTurn('a');
  bridge.reset();
  release(ok(turnBody(null)));
  assert.deepEqual(await pending, { ok: false, reason: 'outcome_unknown' });
  // 入出力が止まっている間は送らない。
  let permitted = false;
  const stopped = setup({ permitted: () => permitted });
  assert.deepEqual(await stopped.bridge.submitTurn('a'), {
    ok: false,
    reason: 'input_stopped',
  });
  assert.deepEqual(stopped.sent, []);
  permitted = true;
});

test('stopping input discards the description; nothing is fetched while stopped; resuming fetches again', async () => {
  let permitted = true;
  const { bridge, script, published, sent } = setup({
    permitted: () => permitted,
  });
  script.push(ok(document('1')));
  await bridge.refresh();
  assert.equal(bridge.refCount, 2);
  permitted = false;
  bridge.ioChanged();
  assert.equal(bridge.view === null, true);
  assert.equal(bridge.refCount, 0);
  assert.deepEqual(published.at(-1), null);
  const sentBefore = sent.length;
  // 停止中は取得も版の知らせの処理もしない。
  await bridge.refresh();
  bridge.onRevision('9');
  await bridge.idle();
  assert.equal(sent.length, sentBefore);
  // 再開: 取り直して渡す。
  permitted = true;
  script.push(ok(document('2', [0x82])));
  bridge.ioChanged();
  await bridge.idle();
  assert.equal(bridge.view?.canvas_revision, '2');
});

test('a fetch that is answered after input was stopped is dropped', async () => {
  let permitted = true;
  const { bridge, script, published } = setup({ permitted: () => permitted });
  let release: (outcome: Outcome) => void = () => undefined;
  script.push(new Promise<Outcome>((resolve) => (release = resolve)));
  const pending = bridge.refresh();
  // 世代を進めずに、停止の状態だけが変わった（通知の前に応答が届く順序）。
  permitted = false;
  release(ok(document('1')));
  await pending;
  assert.deepEqual(published, []);
  assert.equal(bridge.view === null, true);
});

test('a new io_epoch discards the description even when the stop was not seen', async () => {
  let epoch = '0';
  const { bridge, script, published } = setup({ epoch: () => epoch });
  script.push(ok(document('1')));
  await bridge.refresh();
  // 世代が進んだ通知: 前の記述を捨てて（空を通知）、取り直す。
  epoch = '2';
  script.push(ok(document('2', [0x82])));
  bridge.ioChanged();
  assert.deepEqual(published.at(-1), null);
  await bridge.idle();
  assert.equal(bridge.view?.canvas_revision, '2');
  // ioChanged を見逃した場合でも、次の取得の前に世代の違いで前の記述を捨てる（版 2 から 3 へ進むだけでなく、必ず空を挟む）。
  const count = published.length;
  epoch = '4';
  script.push(ok(document('3', [0x83])));
  await bridge.refresh();
  assert.deepEqual(
    published.slice(count).map((view) => view?.canvas_revision ?? null),
    [null, '3'],
  );
});

test('resend hands the description over again, or fetches it when there is none', async () => {
  const { bridge, script, published } = setup();
  script.push(ok(document('1')));
  bridge.resend();
  await bridge.idle();
  assert.equal(published.length, 1);
  assert.equal(published[0]?.canvas_revision, '1');
  bridge.resend();
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], published[0]);
});
