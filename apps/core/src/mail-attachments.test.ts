// メール添付の取得と抽出の試験（B08-04）。模擬の Gmail だけを使い、実ネットワーク・実データは使わない。
// 期待値はすべて手で書いた値で、実装の処理から作らない。PDF の実抽出（unpdf）も合成の最小 PDF で確かめる。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailAttachmentInput } from '@buddy/ai';
import type { GoogleGmailPart } from '@buddy/connectors';
import { initialFetchScope } from '@buddy/domain';
import type { FetchScope } from '@buddy/domain';
import { createMailAttachmentLoader } from './mail-attachments.js';

const MESSAGE_ID = 'msg-1';
const REVISION = 'rev-42';
const SCOPE: FetchScope = initialFetchScope('INBOX');

interface AttachmentCall {
  readonly messageId: string;
  readonly attachmentId: string;
}

// 台本で応答する模擬の Gmail。呼ばれた要求を記録する。
function fakeGmail(
  handler: (request: AttachmentCall) => Promise<{
    readonly size: number;
    readonly data: Uint8Array;
  }>,
) {
  const calls: AttachmentCall[] = [];
  const gmail = {
    getAttachment: (request: AttachmentCall) => {
      calls.push(request);
      return handler(request);
    },
  };
  return { gmail, calls };
}

const failingGmail = () =>
  fakeGmail(() => Promise.reject(new Error('合成の取得失敗')));

function part(over: Partial<GoogleGmailPart>): GoogleGmailPart {
  return { headers: [], bodySize: 0, parts: [], ...over };
}

function payloadOf(parts: readonly GoogleGmailPart[]): GoogleGmailPart {
  return part({ mimeType: 'multipart/mixed', parts });
}

const utf8 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'utf8'));

test('許可したテキスト添付を attachments.get で取得し、そのままの文で抽出する', async () => {
  const text = '提出期限は12月1日です';
  const { gmail, calls } = fakeGmail(() =>
    Promise.resolve({ size: 30, data: utf8(text) }),
  );
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'note.txt',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
        bodySize: 30,
        bodyAttachmentId: 'ATT-1',
      }),
    ]),
  });

  assert.deepEqual(calls, [{ messageId: MESSAGE_ID, attachmentId: 'ATT-1' }]);
  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text,
    },
  ] satisfies readonly MailAttachmentInput[]);
});

test('インラインで届いたテキスト添付は attachments.get を呼ばずに抽出する', async () => {
  const { gmail, calls } = failingGmail();
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/markdown',
        filename: 'memo.md',
        bodySize: 5,
        bodyData: Buffer.from('hello', 'utf8').toString('base64url'),
      }),
    ]),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'hello',
    },
  ]);
});

test('Shift_JIS のテキスト添付は charset の宣言に従って復号する', async () => {
  // 'A' と「あ」「い」（Shift_JIS: 41 / 82A0 / 82A2）。
  const bytes = new Uint8Array([0x41, 0x82, 0xa0, 0x82, 0xa2]);
  const { gmail } = fakeGmail(() =>
    Promise.resolve({ size: bytes.length, data: bytes }),
  );
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'annai.txt',
        headers: [
          { name: 'Content-Type', value: 'text/plain; charset=shift_jis' },
        ],
        bodySize: bytes.length,
        bodyAttachmentId: 'ATT-SJIS',
      }),
    ]),
  });

  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'Aあい',
    },
  ]);
});

test('UTF-8 として不正なバイト列のテキスト添付は failed にする', async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x30]);
  const { gmail } = fakeGmail(() =>
    Promise.resolve({ size: bytes.length, data: bytes }),
  );
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'broken.txt',
        bodySize: bytes.length,
        bodyAttachmentId: 'ATT-BAD',
      }),
    ]),
  });

  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ]);
});

test('取得に失敗した許可対象は failed にし、未読として扱わせる', async () => {
  const { gmail, calls } = failingGmail();
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'doc.pdf',
        bodySize: 100,
        bodyAttachmentId: 'ATT-X',
      }),
    ]),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ]);
});

test('画像の添付は範囲外として取得しない', async () => {
  const { gmail, calls } = failingGmail();
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'image/png',
        filename: 'photo.png',
        bodySize: 100,
        bodyAttachmentId: 'ATT-IMG',
      }),
    ]),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: false,
      state: 'unread',
      source_revision: null,
    },
  ]);
});

test('申告サイズが上限を超える添付は取得しない（上限ちょうどは取得する）', async () => {
  const over = fakeGmail(() => Promise.resolve({ size: 2, data: utf8('hi') }));
  const overLoader = createMailAttachmentLoader({
    gmail: over.gmail,
    scope: SCOPE,
  });
  const overResult = await overLoader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'big.txt',
        bodySize: 10_000_001,
        bodyAttachmentId: 'ATT-BIG',
      }),
    ]),
  });
  assert.deepEqual(over.calls, []);
  assert.deepEqual(overResult, [
    {
      attachment_id: '1',
      permitted: false,
      state: 'unread',
      source_revision: null,
    },
  ]);

  const just = fakeGmail(() => Promise.resolve({ size: 2, data: utf8('hi') }));
  const justLoader = createMailAttachmentLoader({
    gmail: just.gmail,
    scope: SCOPE,
  });
  const justResult = await justLoader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'just.txt',
        bodySize: 10_000_000,
        bodyAttachmentId: 'ATT-JUST',
      }),
    ]),
  });
  assert.equal(just.calls.length, 1);
  assert.deepEqual(justResult, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'hi',
    },
  ]);
});

test('申告は上限内でも、実物が上限を超えたら使わない', async () => {
  const narrow: FetchScope = { ...SCOPE, attachmentMaxBytes: 4 };
  const { gmail } = fakeGmail(() =>
    Promise.resolve({ size: 5, data: utf8('hello') }),
  );
  const loader = createMailAttachmentLoader({ gmail, scope: narrow });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'sneaky.txt',
        bodySize: 3,
        bodyAttachmentId: 'ATT-S',
      }),
    ]),
  });

  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ]);
});

test('拡張子が PDF でも MIME が実行ファイルの添付は範囲外にする', async () => {
  const { gmail, calls } = failingGmail();
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'application/x-msdownload',
        filename: 'report.pdf',
        bodySize: 10,
        bodyAttachmentId: 'ATT-E',
      }),
    ]),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: false,
      state: 'unread',
      source_revision: null,
    },
  ]);
});

test('選択していない種類の添付は取得しない', async () => {
  const pdfOnly: FetchScope = { ...SCOPE, attachmentKinds: ['pdf'] };
  const { gmail, calls } = failingGmail();
  const loader = createMailAttachmentLoader({ gmail, scope: pdfOnly });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'note.txt',
        bodySize: 5,
        bodyAttachmentId: 'ATT-T',
      }),
    ]),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: false,
      state: 'unread',
      source_revision: null,
    },
  ]);
});

test('partId が無い添付には出現順の ID を付ける', async () => {
  const { gmail } = fakeGmail(() =>
    Promise.resolve({ size: 2, data: utf8('hi') }),
  );
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: part({
      mimeType: 'text/plain',
      filename: 'single.txt',
      bodySize: 2,
      bodyAttachmentId: 'ATT-0',
    }),
  });

  assert.deepEqual(result, [
    {
      attachment_id: 'attachment-0',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'hi',
    },
  ]);
});

test('添付が無いメールでは空の一覧を返す', async () => {
  const { gmail, calls } = failingGmail();
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: part({ mimeType: 'text/plain', bodySize: 5, bodyData: 'aGVsbG8' }),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, []);
});

// テキストを持つ最小の PDF を手で組み立てる（非圧縮ストリーム、WinAnsi）。
// 期待する抽出テキストは、この中へ書いた 2 行そのもの。
function syntheticPdf(): Uint8Array {
  const content =
    'BT /F1 24 Tf 100 700 Td (Hello Buddy) Tj 0 -40 Td (Deadline: 2026-12-01) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
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

test('PDF の添付は unpdf でテキストを抽出する（インラインのデータ）', async () => {
  const pdf = syntheticPdf();
  const { gmail, calls } = failingGmail();
  const loader = createMailAttachmentLoader({ gmail, scope: SCOPE });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '2',
        mimeType: 'application/pdf',
        filename: 'doc.pdf',
        bodySize: pdf.length,
        bodyData: Buffer.from(pdf).toString('base64url'),
      }),
    ]),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, [
    {
      attachment_id: '2',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'Hello Buddy\nDeadline: 2026-12-01',
    },
  ]);
});

test('PDF からテキストが取れない・抽出が失敗する場合は failed にする', async () => {
  const { gmail } = fakeGmail(() =>
    Promise.resolve({ size: 4, data: new Uint8Array([1, 2, 3, 4]) }),
  );
  const payload = payloadOf([
    part({
      partId: '2',
      mimeType: 'application/pdf',
      filename: 'scan.pdf',
      bodySize: 4,
      bodyAttachmentId: 'ATT-PDF',
    }),
  ]);

  const emptyLoader = createMailAttachmentLoader({
    gmail,
    scope: SCOPE,
    extractPdfText: () => Promise.resolve('  \n'),
  });
  assert.deepEqual(
    await emptyLoader.load({
      messageId: MESSAGE_ID,
      messageRevision: REVISION,
      payload,
    }),
    [
      {
        attachment_id: '2',
        permitted: true,
        state: 'failed',
        source_revision: REVISION,
      },
    ],
  );

  const brokenLoader = createMailAttachmentLoader({
    gmail,
    scope: SCOPE,
    extractPdfText: () => Promise.reject(new Error('合成の抽出失敗')),
  });
  assert.deepEqual(
    await brokenLoader.load({
      messageId: MESSAGE_ID,
      messageRevision: REVISION,
      payload,
    }),
    [
      {
        attachment_id: '2',
        permitted: true,
        state: 'failed',
        source_revision: REVISION,
      },
    ],
  );
});

test('mimeType が空でも Content-Type ヘッダーから種類を補って PDF を抽出する', async () => {
  const { gmail } = fakeGmail(() =>
    Promise.resolve({ size: 4, data: new Uint8Array([1, 2, 3, 4]) }),
  );
  const loader = createMailAttachmentLoader({
    gmail,
    scope: SCOPE,
    extractPdfText: () => Promise.resolve('ヘッダーから補った PDF の文'),
  });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '2',
        filename: 'noname.pdf',
        headers: [{ name: 'Content-Type', value: 'application/pdf' }],
        bodySize: 4,
        bodyAttachmentId: 'ATT-H',
      }),
    ]),
  });

  assert.deepEqual(result, [
    {
      attachment_id: '2',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text: 'ヘッダーから補った PDF の文',
    },
  ]);
});

test('掃除のゲートが閉じている間は添付を取得せず、許可した添付を未読にする', async () => {
  const { gmail, calls } = fakeGmail(() =>
    Promise.resolve({ size: 30, data: utf8('読めてはいけない文') }),
  );
  const loader = createMailAttachmentLoader({
    gmail,
    scope: SCOPE,
    retention: {
      ready: () => Promise.resolve(),
      gate: () => ({
        search: false,
        cloud_send: false,
        auto_use: false,
        reasons: ['sweep_incomplete'],
        use_blocked: [],
      }),
      lease: () => () => {},
    },
  });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'note.txt',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
        bodySize: 30,
        bodyAttachmentId: 'ATT-1',
      }),
    ]),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'failed',
      source_revision: REVISION,
    },
  ] satisfies readonly MailAttachmentInput[]);
});

test('掃除のゲートが開いていれば貸し出しを持って取得し、終わりに返す', async () => {
  const text = 'ゲートを通した文';
  const { gmail, calls } = fakeGmail(() =>
    Promise.resolve({ size: 30, data: utf8(text) }),
  );
  let releases = 0;
  const loader = createMailAttachmentLoader({
    gmail,
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
        releases += 1;
      },
    },
  });

  const result = await loader.load({
    messageId: MESSAGE_ID,
    messageRevision: REVISION,
    payload: payloadOf([
      part({
        partId: '1',
        mimeType: 'text/plain',
        filename: 'note.txt',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
        bodySize: 30,
        bodyAttachmentId: 'ATT-1',
      }),
    ]),
  });

  assert.deepEqual(calls, [{ messageId: MESSAGE_ID, attachmentId: 'ATT-1' }]);
  assert.deepEqual(result, [
    {
      attachment_id: '1',
      permitted: true,
      state: 'extracted',
      source_revision: REVISION,
      text,
    },
  ] satisfies readonly MailAttachmentInput[]);
  assert.equal(releases, 1);
});
