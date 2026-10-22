import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CANVAS_HEADING_LIMIT,
  CANVAS_HEADING_MARKUP_PATTERNS,
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
  applyCanvasBatchToStore,
  beginPrivateCanvas,
  canvasBatchErrors,
  canvasDocumentErrors,
  canvasForDisplay,
  desktopChannelAllowedForRole,
  endPrivateCanvas,
  nextCarriedSummary,
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
    // PR #102 のレビュー: 見出しのマークアップ・URL（add と update）と、要約の期限。
    'canvas-heading-script',
    'canvas-heading-javascript',
    'canvas-heading-dash-https',
    'canvas-heading-kelvin-http',
    'canvas-add-heading-script',
    'canvas-add-heading-javascript',
    'canvas-update-heading-url',
    'canvas-update-heading-tag',
    'segment-summary-expired',
    'segment-summary-from-self',
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
  'desktop.operation_preview',
  'desktop.operation_approve',
  'desktop.operation_cancel',
  'desktop.operation_reconcile',
  'desktop.operation_retry',
  'desktop.operation_check',
];

test('window roles: the canvas cannot use stop, resume, approval or quit channels', () => {
  assert.deepEqual([...DESKTOP_WINDOW_ROLES], ['canvas', 'status', 'input']);
  assert.deepEqual([...DESKTOP_ROLE_CHANNELS.canvas], ['desktop.get_state']);
  assert.deepEqual(
    [...DESKTOP_ROLE_CHANNELS.input],
    ['desktop.get_state', 'desktop.turn_submit'],
  );
  // 発言は入力バーだけ（キャンバスと状態の層は使えない）。
  assert.equal(
    desktopChannelAllowedForRole('input', 'desktop.turn_submit'),
    true,
  );
  assert.equal(
    desktopChannelAllowedForRole('canvas', 'desktop.turn_submit'),
    false,
  );
  assert.equal(
    desktopChannelAllowedForRole('status', 'desktop.turn_submit'),
    false,
  );
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
  // 手で数えた数（現在の DesktopIpcChannel は 24 個。B04-05 の 7 個を含む）。
  assert.equal(channels.size, 24);
  assert.equal(CANVAS_FORBIDDEN.length + 2, 24);
});

// PR #102 のレビュー（ADR 0032）: 見出しのマークアップ・URL、既存の text の更新、記録しない区切りの一時の記述、
// 要約の由来と期限。期待値は手で書く。
test('headings with markup or URLs are refused by both the schema and the domain; plain headings pass', () => {
  const base = fixture('canvas-document-valid');
  for (const heading of [
    '<script>1</script>',
    '<img src=x onerror=x>',
    '予定</b>',
    '<!--x',
    '<?xml',
    'A<B>C',
    '<img src=x onerror=x',
    // 空白なしの自己終了タグと、/ で区切った属性（PR #102 の再々確認）。
    '<br/>',
    '<br />',
    '<img/>',
    '<svg/>',
    '<wbr/>',
    '<img/src=x>',
    '<img/src=x',
    'https://example.invalid',
    'HTTP://EXAMPLE.INVALID',
    'javascript:alert(1)',
    '見る JavaScript:x',
    'data:text/html,x',
    'vbscript:x',
    'file:///etc',
    'mailto:a@example.invalid',
    'www.example.invalid',
    '詳細は WWW.example',
    // 記号を前に付けた URL（PR #102 の再確認）。
    '-https://example.invalid',
    '+https://example.invalid',
    '.https://example.invalid',
    '-www.example.invalid',
    'https ://x',
    // ケルビンの記号（U+212A）は ASCII の英数字でないので、その後の http: を拒否する。
    '\u212Ahttp://x',
  ]) {
    assert.equal(validators.CanvasHeading(heading), false, heading);
    const document = structuredClone(base);
    document.items[0].heading = heading;
    assert.deepEqual(
      canvasDocumentErrors(document),
      ['heading_markup'],
      heading,
    );
  }
  for (const heading of [
    '3/5 の予定',
    'A < B の比較',
    'A > B の比較',
    '比較: A と B',
    'http の設定',
    'www の話',
    'metadata:2 件',
    '＜予定＞の確認',
    'A<B の比較',
    'A < B > C',
    '2<3 と 5>4',
    'A</B の比較',
    '1/2 と 3/4',
    // ſ（U+017F）は [Ss] に含めない。/iu の大文字・小文字の対応を使わない。
    'http\u017F://x',
    // プレーンテキストで描くので通してよい（ADR 0032）。
    '＜script＞x＜/script＞',
    'https%3A%2F%2Fx',
    'java script:x',
  ]) {
    assert.equal(validators.CanvasHeading(heading), true, heading);
    const document = structuredClone(base);
    document.items[0].heading = heading;
    assert.deepEqual(canvasDocumentErrors(document), [], heading);
  }
  // Schema と domain は同じパターンの文字列を同じ u フラグで使う（判定の食い違いをなくす）。
  assert.deepEqual(
    schema.$defs.CanvasHeading.not.anyOf.map((entry) => entry.pattern),
    [...CANVAS_HEADING_MARKUP_PATTERNS],
  );
  for (const pattern of CANVAS_HEADING_MARKUP_PATTERNS)
    assert.equal(/[^\x20-\x7e]/u.test(pattern), false, pattern);
  // update の見出しも domain が拒否する。
  const batch = fixture('canvas-batch-valid');
  batch.ops = [
    {
      op: 'update',
      item_id: 'tasks-today',
      changes: { heading: 'javascript:alert(1)' },
    },
  ];
  assert.deepEqual(canvasBatchErrors(batch), ['heading_markup']);
});

// 既存の text を 2 つ持つキャンバス（手で作る）。
function canvasWithTwoTexts() {
  const document = fixture('canvas-document-valid');
  const second = {
    ...structuredClone(document.items[2]),
    item_id: 'reply-old',
    grid: { column: 1, span: 4, rows: 1 },
  };
  document.items.push(second);
  document.reading_order = [...document.reading_order, 'reply-old'];
  return document;
}

test('updating the content of existing text items counts toward one text per answer', () => {
  const document = canvasWithTwoTexts();
  assert.deepEqual(canvasDocumentErrors(document), []);
  const batch = (ops, readingOrder = document.reading_order) => ({
    base_canvas_revision: '7',
    canvas_revision: '8',
    ops,
    reading_order: readingOrder,
  });
  const newText = {
    ...structuredClone(document.items[2]),
    item_id: 'reply-new',
    grid: { column: 5, span: 4, rows: 1 },
  };
  // update 2 件（見出しと、データ）。
  assert.deepEqual(
    applyCanvasBatch(
      document,
      batch([
        { op: 'update', item_id: 'reply', changes: { heading: '新しい答え' } },
        {
          op: 'update',
          item_id: 'reply-old',
          changes: { data: { item_refs: [], more_count: 0 } },
        },
      ]),
    ),
    { ok: false, errors: ['text_limit'] },
  );
  // add と update。
  assert.deepEqual(
    applyCanvasBatch(
      document,
      batch(
        [
          { op: 'add', item: newText },
          { op: 'update', item_id: 'reply', changes: { heading: '答え 2' } },
        ],
        [...document.reading_order, 'reply-new'],
      ),
    ),
    { ok: false, errors: ['text_limit'] },
  );
  // 1 件だけの中身の更新と、強調だけの更新は数えない（境界）。
  assert.equal(
    applyCanvasBatch(
      document,
      batch([
        { op: 'update', item_id: 'reply', changes: { heading: '答え 3' } },
        { op: 'update', item_id: 'reply-old', changes: { emphasis: 'low' } },
      ]),
    ).ok,
    true,
  );
  assert.equal(
    applyCanvasBatch(
      document,
      batch(
        [
          { op: 'add', item: newText },
          { op: 'update', item_id: 'reply-old', changes: { emphasis: 'low' } },
        ],
        [...document.reading_order, 'reply-new'],
      ),
    ).ok,
    true,
  );
  // text でない物の中身の更新は数えない。
  assert.equal(
    applyCanvasBatch(
      document,
      batch([
        { op: 'update', item_id: 'reply', changes: { heading: '答え 4' } },
        {
          op: 'update',
          item_id: 'tasks-today',
          changes: { heading: '今日の用事 2' },
        },
      ]),
    ).ok,
    true,
  );
});

test('changes during a private segment stay temporary and are discarded when it ends', () => {
  const persisted = fixture('canvas-document-valid');
  let store = beginPrivateCanvas({ persisted, ephemeral: null });
  assert.deepEqual(store.ephemeral, persisted);
  // 既存のカードの見出しの変更・移動・閉じる・足す。
  const first = applyCanvasBatchToStore(store, {
    base_canvas_revision: '7',
    canvas_revision: '8',
    ops: [
      {
        op: 'update',
        item_id: 'tasks-today',
        changes: { heading: '内緒の相談' },
      },
      { op: 'move', item_id: 'plan-compare', placement: 'shelf' },
      { op: 'close', item_id: 'reply' },
      {
        op: 'add',
        item: {
          ...structuredClone(persisted.items[0]),
          item_id: 'secret',
          heading: '内緒のメモ',
        },
      },
    ],
    reading_order: ['tasks-today', 'secret'],
  });
  assert.equal(first.ok, true);
  store = first.store;
  // 保存してよい記述は変わらない。描くのは一時の記述。
  assert.deepEqual(store.persisted, fixture('canvas-document-valid'));
  assert.equal(canvasForDisplay(store).canvas_revision, '8');
  assert.deepEqual(
    canvasForDisplay(store)
      .items.map((item) => item.heading)
      .sort(),
    ['2 つの案', '内緒のメモ', '内緒の相談', '先週のメール'].sort(),
  );
  // 入り直しても一時の記述を保つ。
  assert.equal(beginPrivateCanvas(store), store);
  // 終わったら捨てて、前の記述に戻す。版は一時の記述の版より進める。
  const ended = endPrivateCanvas(store);
  assert.equal(ended.ephemeral, null);
  assert.equal(ended.persisted.canvas_revision, '9');
  assert.deepEqual(
    { ...ended.persisted, canvas_revision: '7' },
    fixture('canvas-document-valid'),
  );
  assert.equal(
    JSON.stringify(ended).includes('内緒'),
    false,
    'private headings must not survive',
  );
  assert.equal(canvasForDisplay(ended), ended.persisted);
  // 記録しない区切りでなければ、そのまま保存してよい記述に当てる。
  const normal = applyCanvasBatchToStore(
    { persisted, ephemeral: null },
    fixture('canvas-batch-valid'),
  );
  assert.equal(normal.ok, true);
  assert.equal(normal.store.persisted.canvas_revision, '8');
  assert.equal(normal.store.ephemeral, null);
  assert.equal(endPrivateCanvas(normal.store), normal.store);
  // 一時の記述に合わない束（版が古い・一時の記述で閉じた reply を閉じる）は拒否し、何も変えない。
  const stale = applyCanvasBatchToStore(store, fixture('canvas-batch-valid'));
  assert.deepEqual(stale, {
    ok: false,
    errors: ['base_revision_mismatch', 'item_not_found'],
  });
});

test('carried summaries expire with their earliest source, across several segments', () => {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  // 区切り A（normal）: 発言の期限は 10/29 と 10/30。
  const a = nextCarriedSummary({
    previous: null,
    closing: {
      segment_id: id(1),
      storage_mode: 'normal',
      turn_expires_at: ['2026-10-29T08:00:00Z', '2026-10-30T08:00:00Z'],
    },
    open_reason: 'idle_timeout',
    now: '2026-10-22T09:00:00Z',
  });
  assert.deepEqual(a, {
    source_segment_ids: [id(1)],
    expires_at: '2026-10-29T08:00:00Z',
  });
  // 区切り B（extended）: 要約し直しても A の由来と早い期限を引き継ぐ。
  const b = nextCarriedSummary({
    previous: a,
    closing: {
      segment_id: id(2),
      storage_mode: 'extended',
      turn_expires_at: ['2026-11-21T10:00:00Z'],
    },
    open_reason: 'date_changed',
    now: '2026-10-23T00:00:00Z',
  });
  assert.deepEqual(b, {
    source_segment_ids: [id(1), id(2)],
    expires_at: '2026-10-29T08:00:00Z',
  });
  // 区切り C の終わり（A の期限の後）: 期限の切れた要約は材料にせず、C の発言だけから作る。
  const c = nextCarriedSummary({
    previous: b,
    closing: {
      segment_id: id(3),
      storage_mode: 'normal',
      turn_expires_at: ['2026-11-05T12:00:00Z'],
    },
    open_reason: 'user_requested',
    now: '2026-10-29T08:00:00Z',
  });
  assert.deepEqual(c, {
    source_segment_ids: [id(3)],
    expires_at: '2026-11-05T12:00:00Z',
  });
  // 材料が何も期限内でなければつながない。
  assert.equal(
    nextCarriedSummary({
      previous: a,
      closing: {
        segment_id: id(4),
        storage_mode: 'normal',
        turn_expires_at: ['2026-10-29T07:00:00Z'],
      },
      open_reason: 'idle_timeout',
      now: '2026-10-29T09:00:00Z',
    }),
    null,
  );
  // 発言のない区切りでも、期限内の前の要約は引き継ぐ。
  assert.deepEqual(
    nextCarriedSummary({
      previous: b,
      closing: {
        segment_id: id(5),
        storage_mode: 'normal',
        turn_expires_at: [],
      },
      open_reason: 'idle_timeout',
      now: '2026-10-24T00:00:00Z',
    }),
    b,
  );
  // つながない始まり方と、記録しない区切りから。
  for (const reason of [
    'stream_started',
    'forget_requested',
    'private_started',
    'private_ended',
  ])
    assert.equal(
      nextCarriedSummary({
        previous: a,
        closing: {
          segment_id: id(6),
          storage_mode: 'normal',
          turn_expires_at: ['2026-10-30T00:00:00Z'],
        },
        open_reason: reason,
        now: '2026-10-22T09:00:00Z',
      }),
      null,
      reason,
    );
  assert.equal(
    nextCarriedSummary({
      previous: null,
      closing: {
        segment_id: id(7),
        storage_mode: 'private',
        turn_expires_at: ['2026-10-30T00:00:00Z'],
      },
      open_reason: 'idle_timeout',
      now: '2026-10-22T09:00:00Z',
    }),
    null,
  );
  // 由来が 256 区切りを超えるなら、つながない。
  const many = {
    source_segment_ids: Array.from({ length: 256 }, (_, n) => id(100 + n)),
    expires_at: '2026-10-29T08:00:00Z',
  };
  assert.equal(
    nextCarriedSummary({
      previous: many,
      closing: {
        segment_id: id(9),
        storage_mode: 'normal',
        turn_expires_at: ['2026-10-30T00:00:00Z'],
      },
      open_reason: 'idle_timeout',
      now: '2026-10-22T09:00:00Z',
    }),
    null,
  );
});
