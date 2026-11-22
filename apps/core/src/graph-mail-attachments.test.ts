// Outlook（Graph）添付の取得と抽出の試験（B09-03）。模擬の Graph connector だけを使い、
// 実ネットワーク・実データは使わない。期待値はすべて手で書いた値で、実装の処理から作らない。
// PDF の実抽出（unpdf）も合成の最小 PDF で確かめる（Gmail 側の試験と同じ組み立て）。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailAttachmentInput } from '@buddy/ai';
import type {
  GraphMailAttachment,
  GraphMailAttachmentContent,
  GraphMailAttachmentList,
  GraphReadResult,
} from '@buddy/connectors';
import { initialFetchScope } from '@buddy/domain';
import type { FetchScope } from '@buddy/domain';
import { createGraphMailAttachmentLoader } from './graph-mail-attachments.js';

const MESSAGE_ID = 'msg-1';
const REVISION = '2026-11-21T02:00:00Z';
const SCOPE: FetchScope = initialFetchScope('folder-inbox');

interface GetCall {
  readonly messageId: string;
  readonly attachmentId: string;
}

// 台本で応答する模擬の Graph。呼ばれた要求を記録する。
function fakeGraph(script: {
  readonly list: GraphReadResult<GraphMailAttachmentList>;
  readonly contents?: Readonly<
    Record<string, GraphReadResult<GraphMailAttachmentContent>>
  >;
}) {
  const listCalls: string[] = [];
  const getCalls: GetCall[] = [];
  const graph = {
    listAttachments: (messageId: string) => {
      listCalls.push(messageId);
      return Promise.resolve(script.list);
    },
    getAttachment: (messageId: string, attachmentId: string) => {
      getCalls.push({ messageId, attachmentId });
      const result = script.contents?.[attachmentId];
      assert(result !== undefined, `想定外の取得: ${attachmentId}`);
      return Promise.resolve(result);
    },
  };
  return { graph, listCalls, getCalls };
}

function attachment(
  over: Partial<GraphMailAttachment> & { attachment_id: string },
): GraphMailAttachment {
  return {
    name: 'note.txt',
    content_type: 'text/plain',
    size_bytes: 5,
    is_inline: false,
    type: 'file',
    ...over,
  };
}

const listed = (
  attachments: readonly GraphMailAttachment[],
): GraphReadResult<GraphMailAttachmentList> => ({
  kind: 'ok',
  value: { attachments, skipped_without_id: 0, pages: 1 },
});

const content = (
  data: Uint8Array | null,
  sizeBytes: number | null = data?.length ?? null,
): GraphReadResult<GraphMailAttachmentContent> => ({
  kind: 'ok',
  value: { data, size_bytes: sizeBytes },
});

const utf8 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'utf8'));

test('添付が無いメッセージは列挙を呼ばず空を返す', async () => {
  const { graph, listCalls } = fakeGraph({
    list: { kind: 'unavailable', reason: 'server_error' },
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: SCOPE });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: false,
  });
  assert.deepEqual(listCalls, []);
  assert.deepEqual(result, []);
});

test('列挙に失敗したら、添付なしと偽らず failed を 1 件だけ返す', async () => {
  const { graph, getCalls } = fakeGraph({
    list: { kind: 'authentication_expired', status: 401, code: 'x' },
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: SCOPE });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(getCalls, []);
  assert.deepEqual(result, [
    {
      attachment_id: 'attachment-0',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ] satisfies readonly MailAttachmentInput[]);
});

test('許可したテキスト添付を個別取得し、charset の宣言に従って復号する', async () => {
  // 'A' と「あ」「い」（Shift_JIS: 41 / 82A0 / 82A2）。
  const bytes = new Uint8Array([0x41, 0x82, 0xa0, 0x82, 0xa2]);
  const { graph, getCalls } = fakeGraph({
    list: listed([
      attachment({
        attachment_id: 'att-1',
        name: 'annai.txt',
        content_type: 'text/plain; charset=shift_jis',
        size_bytes: bytes.length,
      }),
    ]),
    contents: { 'att-1': content(bytes) },
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: SCOPE });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(getCalls, [
    { messageId: MESSAGE_ID, attachmentId: 'att-1' },
  ]);
  assert.deepEqual(result, [
    {
      attachment_id: 'att-1',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'Aあい',
    },
  ]);
});

test('範囲外の添付（画像・上限超過・サイズ不明）は取得せず permitted: false にする', async () => {
  const { graph, getCalls } = fakeGraph({
    list: listed([
      attachment({
        attachment_id: 'att-img',
        name: 'photo.png',
        content_type: 'image/png',
        size_bytes: 100,
      }),
      attachment({
        attachment_id: 'att-big',
        name: 'big.pdf',
        content_type: 'application/pdf',
        size_bytes: 10_000_001,
      }),
      attachment({
        attachment_id: 'att-unknown',
        name: 'doc.pdf',
        content_type: 'application/pdf',
        size_bytes: null,
      }),
    ]),
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: SCOPE });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(getCalls, []);
  assert.deepEqual(result, [
    {
      attachment_id: 'att-img',
      permitted: false,
      state: 'unread',
      source_revision: null,
    },
    {
      attachment_id: 'att-big',
      permitted: false,
      state: 'unread',
      source_revision: null,
    },
    {
      attachment_id: 'att-unknown',
      permitted: false,
      state: 'unread',
      source_revision: null,
    },
  ]);
});

test('選択していない種類の添付は取得しない', async () => {
  const pdfOnly: FetchScope = { ...SCOPE, attachmentKinds: ['pdf'] };
  const { graph, getCalls } = fakeGraph({
    list: listed([attachment({ attachment_id: 'att-1' })]),
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: pdfOnly });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(getCalls, []);
  assert.deepEqual(result, [
    {
      attachment_id: 'att-1',
      permitted: false,
      state: 'unread',
      source_revision: null,
    },
  ]);
});

test('名前の無い添付は列挙にあっても対象にしない', async () => {
  const { graph, getCalls } = fakeGraph({
    list: listed([
      attachment({ attachment_id: 'att-inline', name: '', size_bytes: 10 }),
      attachment({ attachment_id: 'att-1' }),
    ]),
    contents: { 'att-1': content(utf8('hello')) },
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: SCOPE });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(getCalls, [
    { messageId: MESSAGE_ID, attachmentId: 'att-1' },
  ]);
  assert.deepEqual(result, [
    {
      attachment_id: 'att-1',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'hello',
    },
  ]);
});

test('バイト列で取れない添付（item）と取得の失敗は failed にする', async () => {
  const { graph } = fakeGraph({
    list: listed([
      attachment({
        attachment_id: 'att-item',
        name: 'memo.txt',
        size_bytes: 10,
        type: 'item',
      }),
      attachment({ attachment_id: 'att-denied', name: 'denied.txt' }),
    ]),
    contents: {
      'att-item': content(null, 10),
      'att-denied': {
        kind: 'rejected',
        status: 403,
        reason: 'insufficient_permission',
        code: 'ErrorAccessDenied',
      },
    },
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: SCOPE });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(result, [
    {
      attachment_id: 'att-item',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
    {
      attachment_id: 'att-denied',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ]);
});

test('申告サイズは上限内でも、実物が上限を超えていたら使わない', async () => {
  const narrow: FetchScope = { ...SCOPE, attachmentMaxBytes: 4 };
  const { graph } = fakeGraph({
    list: listed([attachment({ attachment_id: 'att-1', size_bytes: 3 })]),
    contents: { 'att-1': content(utf8('hello'), 3) },
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: narrow });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(result, [
    {
      attachment_id: 'att-1',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ]);
});

// テキストを持つ最小の PDF を手で組み立てる（非圧縮ストリーム、WinAnsi）。
// 期待する抽出テキストは、この中へ書いた 2 行そのもの。
function syntheticPdf(): Uint8Array {
  const contentText =
    'BT /F1 24 Tf 100 700 Td (Hello Buddy) Tj 0 -40 Td (Deadline: 2026-12-01) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contentText.length} >>\nstream\n${contentText}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

test('PDF の添付は unpdf でテキストを抽出する', async () => {
  const pdf = syntheticPdf();
  const { graph } = fakeGraph({
    list: listed([
      attachment({
        attachment_id: 'att-pdf',
        name: 'doc.pdf',
        content_type: 'application/pdf',
        size_bytes: pdf.length,
      }),
    ]),
    contents: { 'att-pdf': content(pdf) },
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: SCOPE });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(result, [
    {
      attachment_id: 'att-pdf',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'Hello Buddy\nDeadline: 2026-12-01',
    },
  ]);
});

test('PDF からテキストが取れない場合は failed にする', async () => {
  const { graph } = fakeGraph({
    list: listed([
      attachment({
        attachment_id: 'att-pdf',
        name: 'scan.pdf',
        content_type: 'application/pdf',
        size_bytes: 4,
      }),
    ]),
    contents: { 'att-pdf': content(new Uint8Array([1, 2, 3, 4])) },
  });
  const loader = createGraphMailAttachmentLoader({ graph, scope: SCOPE });
  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });
  assert.deepEqual(result, [
    {
      attachment_id: 'att-pdf',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ]);
});

test('掃除ゲートが閉じている間は列挙も取得もせず、未読を 1 件返す', async () => {
  const { graph, listCalls, getCalls } = fakeGraph({
    list: listed([attachment({ attachment_id: 'a1' })]),
    contents: { a1: content(utf8('hello')) },
  });
  const loader = createGraphMailAttachmentLoader({
    graph,
    scope: SCOPE,
    retention: {
      ready: () => Promise.resolve(),
      gate: () => ({
        search: false,
        cloud_send: false,
        auto_use: false,
        reasons: ['sweep_pending'],
        use_blocked: [],
      }),
      lease: () => null,
    },
  });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });

  assert.deepEqual(listCalls, []);
  assert.deepEqual(getCalls, []);
  assert.deepEqual(result, [
    {
      attachment_id: 'attachment-0',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ] satisfies readonly MailAttachmentInput[]);
});

test('掃除ゲートが開いていれば貸し出しを保持して取得し、終わりに返す', async () => {
  let released = false;
  const { graph, getCalls } = fakeGraph({
    list: listed([attachment({ attachment_id: 'a1' })]),
    contents: { a1: content(utf8('hello')) },
  });
  const loader = createGraphMailAttachmentLoader({
    graph,
    scope: SCOPE,
    retention: {
      ready: () => Promise.resolve(),
      gate: () => ({
        search: true,
        cloud_send: true,
        auto_use: true,
        reasons: [],
        use_blocked: [],
      }),
      lease: () => () => {
        released = true;
      },
    },
  });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    hasAttachments: true,
  });

  assert.equal(getCalls.length, 1);
  assert.equal(result[0]?.state, 'extracted');
  assert.equal(released, true);
});
