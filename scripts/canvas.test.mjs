import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CANVAS_HEADING_LIMIT,
  CANVAS_ITEM_LIMIT,
  CANVAS_OPS_LIMIT,
  CANVAS_REFS_LIMIT,
  CANVAS_VISIBLE_LIMIT,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_NOTIFICATION_CHANNELS,
  DESKTOP_ROLE_CHANNELS,
  DESKTOP_ROLE_NOTIFICATIONS,
  DESKTOP_WINDOW_ROLES,
  applyCanvasBatch,
  canvasBatchErrors,
  canvasDocumentErrors,
  desktopChannelAllowedForRole,
  streamSegmentErrors,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

// UI-01（ADR 0032）: キャンバスの記述・流れの区切りの意味の検査と、窓の役割ごとのチャネル。
// 期待値は fixtures と下の表に手で書いたもので、domain の実装から作らない。Schema の検査とは別に確かめる。
const { schema, validators } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/canvas-stream-cases.json', root),
    'utf8',
  ),
);
const fixture = (id) =>
  structuredClone(cases.find((entry) => entry.id === id).value);

const SEMANTIC = {
  CanvasDocument: canvasDocumentErrors,
  CanvasOpBatch: canvasBatchErrors,
  StreamSegment: streamSegmentErrors,
};

test('canvas and segment fixtures: schema-valid examples get the hand-written semantic errors', () => {
  let checked = 0;
  for (const entry of cases) {
    assert.equal(validators[entry.schema](entry.value), entry.valid, entry.id);
    if (entry.semantic_errors === undefined) continue;
    assert(entry.valid, entry.id);
    assert.deepEqual(
      SEMANTIC[entry.schema](entry.value),
      entry.semantic_errors,
      entry.id,
    );
    checked += 1;
  }
  assert(checked >= 30, `only ${checked} semantic cases`);
});

test('the issue #93 rejections are present: limits, bidi overrides, unknown kinds, reading order, description fields', () => {
  const rejected = (id) => {
    const entry = cases.find((candidate) => candidate.id === id);
    assert(entry, id);
    return (
      !entry.valid ||
      (entry.semantic_errors !== undefined && entry.semantic_errors.length > 0)
    );
  };
  for (const id of [
    'canvas-heading-25',
    'canvas-batch-13-ops',
    'canvas-refs-51',
    'canvas-document-49-items',
    'canvas-document-25-visible',
    'canvas-batch-two-texts',
    'canvas-heading-rlo',
    'canvas-heading-lri',
    'canvas-unknown-component',
    'canvas-unknown-kind',
    'canvas-unknown-op',
    'canvas-reading-order-missing',
    'canvas-reading-order-duplicate',
    'canvas-item-description',
    'canvas-item-note',
    'canvas-item-caption',
  ])
    assert(rejected(id), id);
});

test('domain limits agree with the schema limits', () => {
  const defs = schema.$defs;
  assert.equal(CANVAS_HEADING_LIMIT, 24);
  assert.equal(defs.CanvasHeading.maxLength, 24);
  assert.equal(CANVAS_OPS_LIMIT, 12);
  assert.equal(defs.CanvasOpBatch.properties.ops.maxItems, 12);
  assert.equal(CANVAS_REFS_LIMIT, 50);
  assert.equal(defs.CanvasData.properties.item_refs.maxItems, 50);
  assert.equal(CANVAS_VISIBLE_LIMIT, 24);
  assert.equal(defs.CanvasDocument.properties.reading_order.maxItems, 24);
  assert.equal(CANVAS_ITEM_LIMIT, 48);
  assert.equal(defs.CanvasDocument.properties.items.maxItems, 48);
  // 説明文の項目を持たない（Schema の形で）。
  for (const name of ['CanvasItem', 'CanvasItemChanges'])
    for (const key of ['description', 'note', 'caption', 'body', 'text'])
      assert.equal(defs[name].properties[key], undefined, `${name}.${key}`);
  assert.deepEqual(defs.CanvasComponent.enum, [
    'list',
    'table',
    'schedule_timeline',
    'mail_card',
    'compare',
    'progress',
    'chart',
    'source_list',
    'text',
  ]);
});

test('both the schema and the domain reject each forbidden heading character', () => {
  // 手で並べた文字（制御・C1・改行・双方向の上書き・埋め込み・分離・方向の印）。
  const forbidden = [
    0x00, 0x07, 0x0a, 0x0d, 0x1f, 0x7f, 0x85, 0x9f, 0x061c, 0x200e, 0x200f,
    0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
    0x2068, 0x2069,
  ];
  const base = fixture('canvas-document-valid');
  for (const code of forbidden) {
    const heading = `予定${String.fromCodePoint(code)}x`;
    assert.equal(validators.CanvasHeading(heading), false, code.toString(16));
    const document = structuredClone(base);
    document.items[0].heading = heading;
    assert.deepEqual(
      canvasDocumentErrors(document),
      ['heading_invalid'],
      code.toString(16),
    );
  }
  // 許す文字: 全角の空白（見出しが空白だけでなければ）・絵文字・結合文字。
  for (const heading of ['予定　確認', '🗓 明日', 'が']) {
    assert.equal(validators.CanvasHeading(heading), true, heading);
    const document = structuredClone(base);
    document.items[0].heading = heading;
    assert.deepEqual(canvasDocumentErrors(document), [], heading);
  }
  // 25 コードポイントは長すぎる。24 は通る（サロゲートの組は 1 文字）。
  const document = structuredClone(base);
  document.items[0].heading = '🗓'.repeat(25);
  assert.deepEqual(canvasDocumentErrors(document), ['heading_invalid']);
  document.items[0].heading = '🗓'.repeat(24);
  assert.deepEqual(canvasDocumentErrors(document), []);
});

test('the domain counts ops and texts per answer even without the schema', () => {
  const batch = fixture('canvas-batch-valid');
  batch.ops = Array.from({ length: 13 }, (_, n) => ({
    op: 'close',
    item_id: `i${n}`,
  }));
  assert.deepEqual(canvasBatchErrors(batch), ['ops_limit']);
  batch.ops = batch.ops.slice(0, 12);
  assert.deepEqual(canvasBatchErrors(batch), []);
  // text を 1 つだけ足すのはよい。
  const one = fixture('canvas-batch-two-texts');
  one.ops = one.ops.slice(0, 1);
  assert.deepEqual(canvasBatchErrors(one), []);
  // 参照 51 件と、50 件ちょうどの more_count。
  const document = fixture('canvas-document-valid');
  const refs = (n) =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'task',
      id: `00000000-0000-4000-8000-${String(500 + i).padStart(12, '0')}`,
    }));
  document.items[0].data = { item_refs: refs(51), more_count: 0 };
  assert.deepEqual(canvasDocumentErrors(document), ['refs_limit']);
  document.items[0].data = { item_refs: refs(50), more_count: 9 };
  assert.deepEqual(canvasDocumentErrors(document), []);
  document.items[0].data = { item_refs: refs(49), more_count: 1 };
  assert.deepEqual(canvasDocumentErrors(document), [
    'more_count_without_full_refs',
  ]);
});

test('applying a batch gives the hand-written result and refuses partial application', () => {
  const document = fixture('canvas-document-valid');
  const batch = fixture('canvas-batch-valid');
  const result = applyCanvasBatch(document, batch);
  assert.equal(result.ok, true);
  assert.equal(result.canvas.canvas_revision, '8');
  assert.deepEqual(result.canvas.reading_order, [
    'progress',
    'tasks-today',
    'plan-compare',
    'old-mail',
  ]);
  const byId = Object.fromEntries(
    result.canvas.items.map((item) => [item.item_id, item]),
  );
  assert.deepEqual(Object.keys(byId).sort(), [
    'old-mail',
    'plan-compare',
    'progress',
    'tasks-today',
  ]);
  assert.equal(byId['tasks-today'].emphasis, 'low');
  assert.equal(byId['tasks-today'].heading, '今日の用事');
  assert.equal(byId['old-mail'].placement, 'canvas');
  // 入力は変えない。
  assert.deepEqual(document, fixture('canvas-document-valid'));

  const stale = fixture('canvas-batch-valid');
  stale.base_canvas_revision = '6';
  stale.canvas_revision = '7';
  assert.deepEqual(applyCanvasBatch(document, stale), {
    ok: false,
    errors: ['base_revision_mismatch'],
  });
  const exists = fixture('canvas-batch-valid');
  exists.ops[0].item.item_id = 'plan-compare';
  exists.ops = [exists.ops[0]];
  exists.reading_order = ['tasks-today', 'plan-compare', 'reply'];
  assert.deepEqual(applyCanvasBatch(document, exists), {
    ok: false,
    errors: ['item_exists'],
  });
  const missing = fixture('canvas-batch-valid');
  missing.ops = [{ op: 'close', item_id: 'nothing' }];
  missing.reading_order = ['tasks-today', 'plan-compare', 'reply'];
  assert.deepEqual(applyCanvasBatch(document, missing), {
    ok: false,
    errors: ['item_not_found'],
  });
  // 読む順に新しい物がない（欠け）・閉じた物が残る（ない物）。
  const order = fixture('canvas-batch-valid');
  order.reading_order = ['reply', 'tasks-today', 'plan-compare', 'old-mail'];
  assert.deepEqual(applyCanvasBatch(document, order), {
    ok: false,
    errors: ['reading_order_missing', 'reading_order_unknown'],
  });
  // 関係の先を閉じた。
  const dangling = fixture('canvas-batch-valid');
  dangling.ops = [{ op: 'close', item_id: 'tasks-today' }];
  dangling.reading_order = ['plan-compare', 'reply'];
  assert.deepEqual(applyCanvasBatch(document, dangling), {
    ok: false,
    errors: ['relation_unknown_target'],
  });
});

test('moving a shelved item onto a full canvas is refused at 25 visible', () => {
  const items = Array.from({ length: 24 }, (_, n) => ({
    ...fixture('canvas-document-valid').items[0],
    item_id: `v${n}`,
  }));
  const shelved = { ...items[0], item_id: 'shelved', placement: 'shelf' };
  const document = {
    canvas_revision: '1',
    items: [...items, shelved],
    reading_order: items.map((item) => item.item_id),
  };
  assert.deepEqual(canvasDocumentErrors(document), []);
  const batch = {
    base_canvas_revision: '1',
    canvas_revision: '2',
    ops: [{ op: 'move', item_id: 'shelved', placement: 'canvas' }],
    reading_order: [...document.reading_order, 'shelved'],
  };
  assert.deepEqual(applyCanvasBatch(document, batch), {
    ok: false,
    errors: ['visible_limit'],
  });
  // 1 つ棚へ片付けてから出すならよい。
  batch.ops.unshift({ op: 'move', item_id: 'v0', placement: 'shelf' });
  batch.reading_order = [...document.reading_order.slice(1), 'shelved'];
  assert.equal(applyCanvasBatch(document, batch).ok, true);
});

// 窓の役割ごとのチャネル（ADR 0032）。期待は手で書いた表。
const CANVAS_FORBIDDEN = [
  'desktop.io_stop',
  'desktop.io_resume',
  'desktop.window_hide',
  'desktop.client_quit',
  'desktop.get_connection',
  'desktop.pairing_begin',
  'desktop.pairing_confirm',
  'desktop.pairing_submit',
  'desktop.pairing_cancel',
  'desktop.claims_list',
  'desktop.claim_decide',
  'desktop.devices_list',
  'desktop.device_revoke',
  'desktop.pairing_open',
  'desktop.home_status',
  'desktop.home_register',
];

test('window roles: the canvas cannot use stop, resume, approval or quit channels', () => {
  assert.deepEqual([...DESKTOP_WINDOW_ROLES], ['canvas', 'status', 'input']);
  assert.deepEqual([...DESKTOP_ROLE_CHANNELS.canvas], ['desktop.get_state']);
  assert.deepEqual([...DESKTOP_ROLE_CHANNELS.input], ['desktop.get_state']);
  for (const channel of CANVAS_FORBIDDEN) {
    assert.equal(desktopChannelAllowedForRole('canvas', channel), false);
    assert.equal(desktopChannelAllowedForRole('input', channel), false);
    assert.equal(desktopChannelAllowedForRole('status', channel), true);
  }
  for (const role of DESKTOP_WINDOW_ROLES) {
    assert.equal(desktopChannelAllowedForRole(role, 'desktop.get_state'), true);
    assert.equal(desktopChannelAllowedForRole(role, 'desktop.unknown'), false);
    assert.equal(desktopChannelAllowedForRole(role, 'toString'), false);
  }
  // 状態の層だけが電源の記録と接続の通知を受ける。
  assert.deepEqual(
    [...DESKTOP_ROLE_NOTIFICATIONS.canvas],
    ['desktop.state_changed'],
  );
  assert.deepEqual(
    [...DESKTOP_ROLE_NOTIFICATIONS.input],
    ['desktop.state_changed'],
  );
});

test('window roles: every request and notification channel of the schema has a role', () => {
  const channels = new Set(Object.values(DESKTOP_ROLE_CHANNELS).flat());
  assert.deepEqual(
    [...channels].sort(),
    [...schema.$defs.DesktopIpcChannel.enum].sort(),
  );
  assert.deepEqual([...channels].sort(), [...DESKTOP_IPC_CHANNELS].sort());
  const notifications = new Set(
    Object.values(DESKTOP_ROLE_NOTIFICATIONS).flat(),
  );
  assert.deepEqual(
    [...notifications].sort(),
    [...DESKTOP_NOTIFICATION_CHANNELS].sort(),
  );
  // 手で数えた数（現在の DesktopIpcChannel は 17 個）。
  assert.equal(channels.size, 17);
  assert.equal(CANVAS_FORBIDDEN.length + 1, 17);
});
