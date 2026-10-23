// キャンバスの物の中身（UI-07、ADR 0032）の契約と意味の検査の試験。形式（JSON Schema の CanvasContent）と意味（domain の
// canvasContentErrors）を別に確かめる。期待値は fixtures（canvas-stream-cases.json の content-*）に手で書いたもので、
// domain の実装から作らない。Schema と domain の上限・禁止文字・URL の規則の一致も確かめる。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  CANVAS_CONTENT_LIMITS,
  canvasContentErrors,
  isCanvasHttpsUrl,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

const { schema, validators } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/canvas-stream-cases.json', root),
    'utf8',
  ),
);
const contentCases = cases.filter((entry) => entry.id.startsWith('content-'));
const defs = schema.$defs;

test('content fixtures: the schema verdict and the hand-written semantic errors agree', () => {
  let semantic = 0;
  for (const entry of contentCases) {
    assert.equal(entry.schema, 'CanvasContent', entry.id);
    assert.equal(validators.CanvasContent(entry.value), entry.valid, entry.id);
    if (entry.content_expect === undefined) {
      assert.equal(entry.content_errors, undefined, entry.id);
      continue;
    }
    assert(entry.valid, entry.id);
    const {
      component,
      ref_count: refCount,
      open_index: openIndex,
    } = entry.content_expect;
    assert.deepEqual(
      canvasContentErrors(entry.value, { component, refCount, openIndex }),
      entry.content_errors,
      entry.id,
    );
    semantic += 1;
  }
  assert(semantic >= 30, `only ${semantic} semantic cases`);
  // 拒否の種類がそろっている。
  const errors = new Set(
    contentCases.flatMap((entry) => entry.content_errors ?? []),
  );
  for (const code of [
    'component_mismatch',
    'refs_mismatch',
    'columns_mismatch',
    'limit_exceeded',
    'range_invalid',
    'progress_invalid',
    'chart_invalid',
    'body_not_opened',
    'text_invalid',
  ])
    assert(errors.has(code), code);
});

test('every canvas component has exactly one content shape with the same name, and the shapes are closed', () => {
  const variants = defs.CanvasContent.oneOf.map((entry) =>
    entry.$ref.slice('#/$defs/'.length),
  );
  assert.equal(variants.length, 9);
  const components = variants.map(
    (name) => defs[name].properties.component.const,
  );
  assert.deepEqual(
    [...components].sort(),
    [...defs.CanvasComponent.enum].sort(),
  );
  for (const name of variants) {
    assert.equal(defs[name].additionalProperties, false, name);
    assert.deepEqual(
      defs[name].required.sort(),
      Object.keys(defs[name].properties).sort(),
      name,
    );
  }
  // 説明文・HTML の項目を持たない。本文を持つのは text の text とメールの body だけ。
  for (const name of variants)
    for (const key of [
      'html',
      'markup',
      'description',
      'note',
      'caption',
      'ref',
      'id',
    ])
      assert.equal(defs[name].properties[key], undefined, `${name}.${key}`);
});

test('the domain limits agree with the schema limits', () => {
  const L = CANVAS_CONTENT_LIMITS;
  assert.equal(L.rows, 50);
  for (const [name, key] of [
    ['CanvasContentList', 'rows'],
    ['CanvasContentTable', 'rows'],
    ['CanvasContentTimeline', 'events'],
    ['CanvasContentMail', 'mails'],
    ['CanvasContentSources', 'sources'],
  ])
    assert.equal(defs[name].properties[key].maxItems, L.rows, `${name}.${key}`);
  assert.equal(defs.CanvasContentTable.properties.columns.maxItems, 8);
  assert.equal(L.tableColumns, 8);
  assert.equal(defs.CanvasContentTableRow.properties.cells.maxItems, 8);
  assert.equal(
    defs.CanvasContentCompare.properties.columns.maxItems,
    L.compareColumns.max,
  );
  assert.equal(
    defs.CanvasContentCompare.properties.rows.maxItems,
    L.compareRows,
  );
  assert.equal(
    defs.CanvasContentCompareRow.properties.values.maxItems,
    L.compareColumns.max,
  );
  assert.equal(
    defs.CanvasContentMailEntry.properties.labels.maxItems,
    L.mailLabels,
  );
  assert.equal(
    defs.CanvasContentProgress.properties.steps.maxItems,
    L.progressSteps,
  );
  assert.equal(
    defs.CanvasContentChart.properties.x_labels.maxItems,
    L.chartPoints.max,
  );
  assert.equal(
    defs.CanvasContentSeries.properties.values.maxItems,
    L.chartPoints.max,
  );
  assert.equal(
    defs.CanvasContentChart.properties.series.maxItems,
    L.chartSeries.max,
  );
  assert.equal(
    defs.CanvasContentTimeline.properties.day_end_minute.maximum,
    L.minutesPerDay,
  );
  assert.equal(defs.CanvasContentText.maxLength, L.textLength);
  assert.equal(defs.CanvasContentLabel.maxLength, L.labelLength);
  assert.equal(defs.CanvasContentBody.maxLength, L.bodyLength);
  // 参照の件数の上限（物のデータ）と、本文を開く位置の上限が同じ。
  assert.equal(defs.CanvasData.properties.item_refs.maxItems, L.rows);
  assert.equal(defs.CanvasOpenIndex.maximum, L.rows - 1);
});

// Schema と domain が同じ文字を拒否する（手で並べた文字: 制御・C1・双方向の上書き・埋め込み・分離・方向の印・行の区切り）。
const FORBIDDEN_LINE = [
  0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x85, 0x9f, 0x061c, 0x200e, 0x200f,
  0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069,
];

test('both the schema and the domain reject every forbidden character in a line of text, and plain text (markup, URLs, symbols) passes', () => {
  const withTitle = (title) => ({
    component: 'list',
    rows: [{ title, due_at: null, state: 'open' }],
  });
  for (const code of FORBIDDEN_LINE) {
    const content = withTitle(`題名${String.fromCodePoint(code)}末尾`);
    assert.equal(
      validators.CanvasContent(content),
      false,
      `schema U+${code.toString(16)}`,
    );
    assert.deepEqual(
      canvasContentErrors(content, {
        component: 'list',
        refCount: 1,
        openIndex: null,
      }),
      ['text_invalid'],
      `domain U+${code.toString(16)}`,
    );
  }
  // 見出しと違い、中身のマークアップ・URL の文字は文字として通る（描くのはプレーンテキストだけ）。
  for (const title of [
    '<b>太字</b>',
    'https://example.com/',
    'A<B>C',
    '＜予定＞',
    'a & b',
    '100%',
  ]) {
    const content = withTitle(title);
    assert.equal(validators.CanvasContent(content), true, title);
    assert.deepEqual(
      canvasContentErrors(content, {
        component: 'list',
        refCount: 1,
        openIndex: null,
      }),
      [],
      title,
    );
  }
  // 本文は改行だけを許し、ほかの制御文字・方向の制御文字は拒否する。
  const textOf = (text) => ({ component: 'text', text });
  assert.equal(validators.CanvasContent(textOf('一行目\n二行目')), true);
  for (const code of FORBIDDEN_LINE.filter((c) => c !== 0x0a)) {
    const content = textOf(`本文${String.fromCodePoint(code)}末尾`);
    assert.equal(
      validators.CanvasContent(content),
      false,
      `body schema U+${code.toString(16)}`,
    );
    assert.deepEqual(
      canvasContentErrors(content, {
        component: 'text',
        refCount: 0,
        openIndex: null,
      }),
      ['text_invalid'],
      `body domain U+${code.toString(16)}`,
    );
  }
});

test('source URLs: the schema and the domain agree, https only, no credentials, no spaces or control characters, at most 2048', () => {
  const accepted = [
    'https://example.com',
    'https://example.com/',
    'https://www.example.com/guide/overview',
    'https://support.example.net/faq?topic=schedule',
    'https://example.org:8443/a#b',
    'https://例え.example/パス',
  ];
  const refused = [
    'http://example.com/',
    'HTTPS://example.com/',
    'javascript:alert(1)',
    'data:text/html,x',
    'mailto:a@example.com',
    '//example.com/',
    // ユーザー名とパスワード（公開前の検査に引っかからないよう、実行時に組み立てる）。
    ['https://', 'user', ':', 'pw', '@example.com/'].join(''),
    'https://user@example.com/',
    'https:///path',
    'https://',
    'https://example.com/a b',
    'https://example.com/\u0000',
    'https://example.com/\u007f',
    ` https://example.com/`,
    'https://example.com/\n',
    `https://example.com/${'a'.repeat(2048)}`,
  ];
  const sources = (url) => ({
    component: 'source_list',
    sources: [{ title: '出典', url }],
  });
  for (const url of accepted) {
    assert.equal(isCanvasHttpsUrl(url), true, url);
    assert.equal(validators.CanvasContent(sources(url)), true, url);
  }
  for (const url of refused) {
    assert.equal(isCanvasHttpsUrl(url), false, JSON.stringify(url));
    assert.equal(
      validators.CanvasContent(sources(url)),
      false,
      JSON.stringify(url),
    );
  }
  // ちょうど 2048 文字は通る。
  const longest = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  assert.equal(longest.length, 2048);
  assert.equal(isCanvasHttpsUrl(longest), true);
  assert.equal(validators.CanvasContent(sources(longest)), true);
});

test('the content request and response carry no Core identifier and no body field', () => {
  assert.deepEqual(Object.keys(defs.CanvasContentRequest.properties).sort(), [
    'command_scope_id',
    'expected_canvas_revision',
    'item_id',
    'open_index',
    'request_id',
  ]);
  assert.deepEqual(Object.keys(defs.CanvasContentResponse.properties).sort(), [
    'canvas_revision',
    'content',
    'item_id',
    'open_index',
    'request_id',
  ]);
  // 画面への要求は物の名前・版・不透明な参照だけ（中枢の識別子・URL・本文を送らない）。
  const request = defs.DesktopIpcRequest.oneOf.find(
    (entry) => entry.properties.channel.const === 'desktop.canvas_content',
  );
  assert.deepEqual(Object.keys(request.properties.payload.properties).sort(), [
    'expected_canvas_revision',
    'item_id',
    'open_ref',
  ]);
});
