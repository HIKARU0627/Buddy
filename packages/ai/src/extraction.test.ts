import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  ExtractionResult,
  ExtractionWire,
  ModelUsage,
} from '@buddy/contracts';
import {
  analysisReadiness,
  autoOperationReasons,
  candidateCommonReasons,
} from '@buddy/domain';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { extractMail, analysisStateOfExtraction } from './extraction.js';
import type { ExtractMailParams, MailExtraction } from './extraction.js';
import {
  checkQuote,
  extractionWireErrors,
  locateQuote,
  yearJustified,
} from './extraction-evidence.js';
import type { ExtractionMailInput } from './extraction-input.js';
import { createFakeAdapter, syntheticProfile } from './testing.js';
import type { AdapterResult } from './types.js';

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;

// 契約の JSON Schema を正本にする（実装から期待値を作らない）。
const schema = JSON.parse(
  readFileSync(
    new URL('../../contracts/schemas/buddy.schema.json', import.meta.url),
    'utf8',
  ),
) as { $id: string };
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  validateFormats: true,
});
addFormats(ajv);
ajv.addSchema(schema);
const wireValidate = ajv.getSchema(`${schema.$id}#/$defs/ExtractionWire`);
if (wireValidate === undefined) throw new Error('ExtractionWire is missing');
const validator = { valid: (value: unknown) => wireValidate(value) === true };

const USAGE: ModelUsage = {
  input_tokens: 1200,
  cached_input_tokens: 0,
  output_tokens: 180,
  reasoning_tokens: null,
  usage_complete: true,
};

// 合成の値（UUID v4 の形・64 桁の hash）。実在の対象ではない。
const HEADER = {
  source_account_id: '3f8a1c52-7b64-4d0e-9a21-5c6e8f1b2a40',
  thread_id: 'thread-1',
  message_id: 'message-1',
  source_revision: 'r1',
  profile_id: 'background-low',
  prompt_hash: 'a'.repeat(64),
  schema_hash: 'b'.repeat(64),
};
const FACTS = { addressed_to_me: true, from_automated_sender: false };
const RECEIVED = '2030-10-05T08:30';
const DEADLINE_TEXT = '2030年10月7日17時までに';
const ASK_TEXT = '参加可否を返信してください';
const BODY = `${DEADLINE_TEXT}${ASK_TEXT}`;

const mail = (
  body: string | null,
  overrides: Partial<ExtractionMailInput> = {},
): ExtractionMailInput => ({
  received_at_local: RECEIVED,
  zone: 'Asia/Tokyo',
  owner_name: '試験太郎',
  subject: '参加可否のお願い',
  message_revision: 'r1',
  body:
    body === null ? { state: 'unread' } : { state: 'extracted', text: body },
  attachments: [],
  ...overrides,
});

const quote = (
  text: string,
  overrides: Partial<
    ExtractionWire['requests'][number]['evidence'][number]
  > = {},
): ExtractionWire['requests'][number]['evidence'][number] => ({
  part: 'body',
  source_id: 'body',
  source_revision: 'r1',
  quote: text,
  ...overrides,
});

const exact = (
  text: string,
  datetime: string,
): ExtractionWire['requests'][number]['deadline'] => ({
  resolution: 'exact_datetime',
  local_datetime: datetime,
  local_date: null,
  original_text: text,
  unresolved_reason: null,
});

const noDeadline: ExtractionWire['requests'][number]['deadline'] = {
  resolution: 'none',
  local_datetime: null,
  local_date: null,
  original_text: null,
  unresolved_reason: null,
};

function request(
  overrides: Partial<ExtractionWire['requests'][number]> = {},
): ExtractionWire['requests'][number] {
  return {
    kind: 'reply_required',
    summary: '参加可否の返信',
    deadline: exact(DEADLINE_TEXT, '2030-10-07T17:00'),
    evidence: [quote(DEADLINE_TEXT), quote(ASK_TEXT)],
    in_quoted_text: false,
    confidence: 'high',
    ...overrides,
  };
}

const wireOf = (
  requests: ExtractionWire['requests'],
  changes: ExtractionWire['changes'] = [],
): ExtractionWire => ({ language: 'ja', requests, changes });

const respond = (wire: unknown): AdapterResult => ({
  kind: 'response',
  text: JSON.stringify(wire),
  usage: USAGE,
  provider_request_id: null,
  refused: false,
  truncated: false,
});

async function run(
  wire: unknown,
  input: ExtractionMailInput = mail(BODY),
  overrides: Partial<ExtractMailParams> = {},
): Promise<MailExtraction> {
  const adapter = createFakeAdapter(respond(wire));
  return extractMail(adapter, {
    request_id: 'req-1',
    profile: syntheticProfile({
      profile_id: 'background-low',
      role: 'background_text',
    }),
    input,
    output_schema: schema,
    schema: validator,
    header: HEADER,
    facts: FACTS,
    ...overrides,
  });
}

function extracted(result: MailExtraction): ExtractionResult {
  assert.equal(result.status, 'extracted', JSON.stringify(result));
  if (result.status !== 'extracted') throw new Error('unreachable');
  return result.result;
}

// 自動実行の対象にならない理由（domain の共通検査）。空なら共通検査を通る。
function commonReasons(result: ExtractionResult): string[] {
  const first = result.requests[0];
  if (first === undefined) throw new Error('no request');
  return candidateCommonReasons(first, result.completeness, RECEIVED);
}

test('a verified extraction gets code-assigned positions and passes the common checks', async () => {
  const result = extracted(await run(wireOf([request()])));
  assert.equal(result.schema, 'buddy.extraction.v2');
  assert.equal(result.source_revision, 'r1');
  assert.equal(result.prompt_hash, 'a'.repeat(64));
  assert.deepEqual(result.completeness, {
    source_revisions: [
      { source_id: 'subject', source_revision: 'r1' },
      { source_id: 'body', source_revision: 'r1' },
    ],
    unread_source_ids: [],
    truncated_source_ids: [],
  });
  const [item] = result.requests;
  assert.deepEqual(item?.deadline, {
    kind: 'instant',
    local_datetime: '2030-10-07T17:00',
    zone: 'Asia/Tokyo',
    original_text: DEADLINE_TEXT,
  });
  // 「2030年10月7日17時までに」は 16 コードポイント、「参加可否を返信してください」は 13。
  const deadlineRef = {
    source_id: 'body',
    source_revision: 'r1',
    quote: DEADLINE_TEXT,
    start: 0,
    end: 16,
  };
  const summaryRefs = [
    deadlineRef,
    {
      source_id: 'body',
      source_revision: 'r1',
      quote: ASK_TEXT,
      start: 16,
      end: 29,
    },
  ];
  assert.deepEqual(item?.fields, [
    { field: 'summary', status: 'explicit', refs: summaryRefs, rule_id: null },
    { field: 'kind', status: 'explicit', refs: summaryRefs, rule_id: null },
    {
      field: 'target',
      status: 'derived',
      refs: [],
      rule_id: 'recipient_header_v1',
    },
    {
      field: 'deadline',
      status: 'explicit',
      refs: [deadlineRef],
      rule_id: null,
    },
  ]);
  assert.equal(item?.confidence_observed, 'high');
  assert.equal(item?.addressed_to_me, true);
  assert.equal(item?.request_entity_id, null);
  assert.deepEqual(commonReasons(result), []);
  assert.deepEqual(
    autoOperationReasons('create_task', item as never, {
      ownCalendarSelected: true,
      labelAssigned: true,
      draftExists: false,
      budgetAvailable: true,
    }),
    [],
  );
});

test('positions count code points (emoji before the quote) and end is exclusive', () => {
  assert.deepEqual(locateQuote('あ😀い確認です', '確認'), {
    kind: 'found',
    start: 3,
    end: 5,
  });
  assert.deepEqual(locateQuote('あ😀い確認です', '😀い'), {
    kind: 'found',
    start: 1,
    end: 3,
  });
});

test('quotes that cannot be matched uniquely are not explicit (QA11)', () => {
  assert.deepEqual(locateQuote('😀確認\n確認', '確認'), { kind: 'ambiguous' });
  // 重なる一致も二重に数える。
  assert.deepEqual(locateQuote('aaa', 'aa'), { kind: 'ambiguous' });
  assert.deepEqual(locateQuote('依頼です', '期限'), { kind: 'not_found' });
  assert.deepEqual(locateQuote('依頼です', ''), { kind: 'not_found' });
  // 結合文字: 分解形の引用は合成形の本文に一致しない（正規化して救わない）。
  assert.deepEqual(locateQuote('café', 'café'), {
    kind: 'not_found',
  });
  // 対になったサロゲートの途中から始まる一致は、コードポイントの境界ではない。
  assert.deepEqual(locateQuote('😀', '\ude00'), {
    kind: 'not_found',
  });
});

test('a quote that is not in the source lowers confidence and is not explicit (X39)', async () => {
  const result = extracted(
    await run(
      wireOf([
        request({
          evidence: [quote('2030年10月8日17時までに'), quote(ASK_TEXT)],
        }),
      ]),
    ),
  );
  const [item] = result.requests;
  assert.equal(item?.confidence_observed, 'low');
  const summary = item?.fields.find((field) => field.field === 'summary');
  // 照合できた引用が一部だけあっても explicit にしない。
  assert.equal(summary?.status, 'conflicting');
  assert.equal(summary?.refs.length, 1);
  assert.deepEqual(commonReasons(result), [
    'confidence_low',
    'evidence_conflicting:summary',
    'evidence_conflicting:kind',
  ]);
});

test('every failed quote lowers confidence and no auto operation is allowed (X39)', async () => {
  const cases: readonly [
    string,
    ExtractionWire['requests'][number]['evidence'][number],
  ][] = [
    ['revision_mismatch', quote(ASK_TEXT, { source_revision: 'r0' })],
    [
      'source_unknown',
      quote(ASK_TEXT, { source_id: 'att-9', part: 'attachment' }),
    ],
    ['part_mismatch', quote(ASK_TEXT, { part: 'subject' })],
    ['not_found', quote('参加の可否を返信してください')],
  ];
  for (const [reason, evidence] of cases) {
    const outcome = await run(wireOf([request({ evidence: [evidence] })]));
    const result = extracted(outcome);
    assert.equal(result.requests[0]?.confidence_observed, 'low', reason);
    assert.equal(
      result.requests[0]?.fields.find((field) => field.field === 'summary')
        ?.status,
      'missing',
      reason,
    );
    if (outcome.status === 'extracted')
      assert.equal(
        (outcome.diagnostics.quote_failures as Record<string, number>)[reason],
        1,
        reason,
      );
    const first = result.requests[0];
    for (const operation of [
      'create_task',
      'create_event',
      'label_mail',
      'draft_reply',
    ] as const) {
      const reasons = [
        ...commonReasons(result),
        ...autoOperationReasons(operation, first as never, {
          ownCalendarSelected: true,
          labelAssigned: true,
          draftExists: false,
          budgetAvailable: true,
        }),
      ];
      assert.equal(
        reasons.includes('confidence_low'),
        true,
        `${reason} ${operation}`,
      );
      assert.equal(reasons.includes('evidence_missing:summary'), true, reason);
    }
  }
});

test('a request with no evidence at all is not explicit', async () => {
  const result = extracted(await run(wireOf([request({ evidence: [] })])));
  const [item] = result.requests;
  assert.equal(item?.confidence_observed, 'low');
  assert.equal(item?.fields[0]?.status, 'missing');
  // 期限の原文が送ったソースに一意にあるので、期限の根拠だけは照合できる。
  assert.equal(
    item?.fields.find((field) => field.field === 'deadline')?.status,
    'explicit',
  );
});

test('the quote must come from the attachment that really contains it (X62)', async () => {
  const input = mail('詳細は添付をご覧ください', {
    attachments: [
      {
        attachment_id: 'att-1',
        permitted: true,
        state: 'extracted',
        source_revision: 'a1',
        text: '2030年10月9日17時までに回答をお願いします',
      },
      {
        attachment_id: 'att-2',
        permitted: true,
        state: 'extracted',
        source_revision: 'a2',
        text: '別の添付です',
      },
    ],
  });
  const text = '2030年10月9日17時までに';
  const good = extracted(
    await run(
      wireOf([
        request({
          kind: 'action_required',
          deadline: exact(text, '2030-10-09T17:00'),
          evidence: [
            quote(text, {
              part: 'attachment',
              source_id: 'att-1',
              source_revision: 'a1',
            }),
          ],
        }),
      ]),
      input,
    ),
  );
  assert.deepEqual(
    good.requests[0]?.fields.find((field) => field.field === 'deadline'),
    {
      field: 'deadline',
      status: 'explicit',
      refs: [
        {
          source_id: 'att-1',
          source_revision: 'a1',
          quote: text,
          start: 0,
          end: 16,
        },
      ],
      rule_id: null,
    },
  );
  assert.equal(good.requests[0]?.confidence_observed, 'high');
  // 引用が別の添付にしかない（添付 2 を指しているが、本文は添付 1 にある）。
  const wrong = extracted(
    await run(
      wireOf([
        request({
          deadline: exact(text, '2030-10-09T17:00'),
          evidence: [
            quote(text, {
              part: 'attachment',
              source_id: 'att-2',
              source_revision: 'a2',
            }),
          ],
        }),
      ]),
      input,
    ),
  );
  assert.equal(wrong.requests[0]?.confidence_observed, 'low');
  assert.equal(
    wrong.requests[0]?.fields.find((field) => field.field === 'summary')
      ?.status,
    'missing',
  );
});

test('an automated sender keeps the existing task and draft limits even when the attachment is read (X62)', async () => {
  const input = mail('詳細は添付', {
    attachments: [
      {
        attachment_id: 'att-1',
        permitted: true,
        state: 'extracted',
        source_revision: 'a1',
        text: '2030年10月9日17時までに回答をお願いします',
      },
    ],
  });
  const text = '2030年10月9日17時までに';
  const result = extracted(
    await run(
      wireOf([
        request({
          deadline: exact(text, '2030-10-09T17:00'),
          evidence: [
            quote(text, {
              part: 'attachment',
              source_id: 'att-1',
              source_revision: 'a1',
            }),
          ],
        }),
      ]),
      input,
      { facts: { addressed_to_me: true, from_automated_sender: true } },
    ),
  );
  const first = result.requests[0];
  const context = {
    ownCalendarSelected: true,
    labelAssigned: true,
    draftExists: false,
    budgetAvailable: true,
  };
  assert.equal(first?.from_automated_sender, true);
  for (const operation of ['create_task', 'draft_reply'] as const)
    assert.equal(
      autoOperationReasons(operation, first as never, context).includes(
        'automated_sender',
      ),
      true,
      operation,
    );
});

test('unread and truncated sources are fixed by the input code and stop auto operations (QA10, X39)', async () => {
  // 読取失敗の添付があるメール。依頼は読めた本文から取れるが、未読があるので自動実行は 0 件。
  const failedAttachment = mail(BODY, {
    attachments: [
      {
        attachment_id: 'att-1',
        permitted: true,
        state: 'failed',
        source_revision: null,
      },
    ],
  });
  const withUnread = await run(wireOf([request()]), failedAttachment);
  const unreadResult = extracted(withUnread);
  assert.deepEqual(unreadResult.completeness.unread_source_ids, ['att-1']);
  assert.equal(commonReasons(unreadResult).includes('unread_sources'), true);
  assert.equal(analysisStateOfExtraction(withUnread), 'unread');

  // 本文の切詰め。
  const truncated = await run(
    wireOf([request({ evidence: [quote(ASK_TEXT.slice(0, 5))] })]),
    mail(`${BODY}${'あ'.repeat(7000)}`),
  );
  const truncatedResult = extracted(truncated);
  assert.deepEqual(truncatedResult.completeness.truncated_source_ids, ['body']);
  assert.equal(
    commonReasons(truncatedResult).includes('truncated_sources'),
    true,
  );
  assert.equal(analysisStateOfExtraction(truncated), 'unread');
});

test('the model cannot report or change unread/truncated: extra keys are invalid_schema (QA10)', async () => {
  const outcome = await run({
    ...wireOf([request()]),
    unread_truncated: false,
    unread_sources: [],
  });
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.failure, 'invalid_schema');
    assert.equal(outcome.detail, 'schema');
  }
  // request_entity_id をモデルに作らせない。
  const withId = await run(
    wireOf([{ ...request(), request_entity_id: 'x' } as never]),
  );
  assert.equal(withId.status, 'failed');
});

test('no deadline with unread sources is not confirmed as "no deadline"', async () => {
  const result = extracted(
    await run(
      wireOf([request({ deadline: noDeadline, evidence: [quote(ASK_TEXT)] })]),
      mail(BODY, {
        attachments: [
          {
            attachment_id: 'att-1',
            permitted: true,
            state: 'unread',
            source_revision: null,
          },
        ],
      }),
    ),
  );
  assert.deepEqual(
    result.requests[0]?.fields.find((field) => field.field === 'deadline'),
    { field: 'deadline', status: 'unread', refs: [], rule_id: null },
  );
  assert.equal(
    commonReasons(result).includes('evidence_unread:deadline'),
    true,
  );
  // 全部読めていて期限がないときは、期限の項目を作らない（返信の下書きを止めない）。
  const complete = extracted(
    await run(
      wireOf([request({ deadline: noDeadline, evidence: [quote(ASK_TEXT)] })]),
    ),
  );
  assert.equal(
    complete.requests[0]?.fields.some((field) => field.field === 'deadline'),
    false,
  );
  assert.deepEqual(commonReasons(complete), []);
});

test('a deadline whose text is not in any source is not explicit and lowers confidence', async () => {
  const result = extracted(
    await run(
      wireOf([
        request({
          deadline: exact('2030年10月9日17時までに', '2030-10-09T17:00'),
        }),
      ]),
    ),
  );
  const [item] = result.requests;
  assert.equal(item?.confidence_observed, 'low');
  assert.deepEqual(
    item?.fields.find((field) => field.field === 'deadline'),
    { field: 'deadline', status: 'missing', refs: [], rule_id: null },
  );
  assert.equal(
    commonReasons(result).includes('evidence_missing:deadline'),
    true,
  );
});

// --- 年（X63・QA09）。受信は 2030-10-08T10:00 ---

const RECEIVED_LATE = '2030-10-08T10:00';

async function deadlineOf(
  body: string,
  deadline: ExtractionWire['requests'][number]['deadline'],
  evidenceText: string,
): Promise<ExtractionResult['requests'][number]> {
  const result = extracted(
    await run(
      wireOf([
        request({
          deadline,
          evidence: [quote(evidenceText)],
        }),
      ]),
      mail(body, { received_at_local: RECEIVED_LATE }),
    ),
  );
  const first = result.requests[0];
  if (first === undefined) throw new Error('no request');
  return first;
}

test('a yearless date is never turned into a year the text does not state (X63, QA09)', async () => {
  // 「締切は10月7日でした」: モデルが同じ年の日付にしても、年の根拠がないので確定しない（翌年へも繰り上げない）。
  const past = await deadlineOf(
    '締切は10月7日でした',
    {
      resolution: 'date_only',
      local_datetime: null,
      local_date: '2030-10-07',
      original_text: '10月7日',
      unresolved_reason: null,
    },
    '締切は10月7日でした',
  );
  assert.deepEqual(past.deadline, {
    kind: 'unresolved',
    reason: 'missing_year',
    original_text: '10月7日',
  });
  // 年の記載のない日付を翌年の日時へ繰り上げた出力も確定しない。
  const rolled = await deadlineOf(
    '10月7日17時までにご連絡ください',
    exact('10月7日17時までに', '2031-10-07T17:00'),
    '10月7日17時までにご連絡ください',
  );
  assert.equal(rolled.deadline.kind, 'unresolved');
  // 本文の年と食い違う年も確定しない。
  const mismatch = await deadlineOf(
    '2031年10月7日17時までにご連絡ください',
    exact('2031年10月7日17時までに', '2030-10-07T17:00'),
    '2031年10月7日17時までにご連絡ください',
  );
  assert.equal(mismatch.deadline.kind, 'unresolved');
  // モデルが年不明と答えたものはそのまま。
  const unresolved = await deadlineOf(
    '10月7日までにお願いします',
    {
      resolution: 'relative_unresolved',
      local_datetime: null,
      local_date: null,
      original_text: '10月7日までに',
      unresolved_reason: 'missing_year',
    },
    '10月7日までにお願いします',
  );
  assert.deepEqual(unresolved.deadline, {
    kind: 'unresolved',
    reason: 'missing_year',
    original_text: '10月7日までに',
  });
  for (const item of [past, rolled, mismatch, unresolved]) {
    const reasons = candidateCommonReasons(
      item,
      { unread_source_ids: [], truncated_source_ids: [] },
      RECEIVED_LATE,
    );
    assert.equal(reasons.includes('deadline_unresolved:missing_year'), true);
  }
});

test('a year stated by the text or by 来年 is kept (X63)', async () => {
  // 「来年の10月7日まで」は受信年（2030）の翌年 2031。
  const next = await deadlineOf(
    '来年の10月7日までに提出してください',
    {
      resolution: 'date_only',
      local_datetime: null,
      local_date: '2031-10-07',
      original_text: '来年の10月7日までに',
      unresolved_reason: null,
    },
    '来年の10月7日までに提出してください',
  );
  assert.deepEqual(next.deadline, {
    kind: 'date',
    date: '2031-10-07',
    original_text: '来年の10月7日までに',
  });
  // 日付だけの期限は時刻を補わない。
  const dated = await deadlineOf(
    '2031年10月7日までに提出してください',
    {
      resolution: 'date_only',
      local_datetime: null,
      local_date: '2031-10-07',
      original_text: '2031年10月7日までに',
      unresolved_reason: null,
    },
    '2031年10月7日までに提出してください',
  );
  assert.equal(dated.deadline.kind, 'date');
});

test('a past explicit deadline stays past and is not an auto-run target (X63)', async () => {
  const past = await deadlineOf(
    '2030年10月7日17時までに、と連絡しました',
    exact('2030年10月7日17時までに', '2030-10-07T17:00'),
    '2030年10月7日17時までに、と連絡しました',
  );
  assert.equal(past.deadline.kind, 'instant');
  assert.equal(
    candidateCommonReasons(
      past,
      { unread_source_ids: [], truncated_source_ids: [] },
      RECEIVED_LATE,
    ).includes('deadline_past'),
    true,
  );
});

test('year justification only accepts a standalone year or a year word relative to the received year', () => {
  assert.equal(yearJustified(2030, '2030年10月7日', 2030), true);
  assert.equal(yearJustified(2030, 'No.12030 の件 10月7日', 2030), false);
  assert.equal(yearJustified(2030, '10月7日', 2030), false);
  assert.equal(yearJustified(2030, '今年の10月7日', 2030), true);
  assert.equal(yearJustified(2031, '来年の10月7日', 2030), true);
  assert.equal(yearJustified(2032, '再来年の10月7日', 2030), true);
  assert.equal(yearJustified(2029, '昨年の10月7日', 2030), true);
  assert.equal(yearJustified(2029, '去年の10月7日', 2030), true);
  // 「来年」と書いてあっても、確定した年が来年でなければ根拠にならない。
  assert.equal(yearJustified(2030, '来年の10月7日', 2030), false);
  // 「再来年」は「来年」を含むが、来年（2031）の根拠にはならない。
  assert.equal(yearJustified(2031, '再来年の10月7日', 2030), false);
});

test('inconsistent or impossible deadlines are an invalid_semantics failure, not a repaired result (ADR 0007)', async () => {
  const inconsistent = await run(
    wireOf([
      request({
        deadline: {
          resolution: 'exact_datetime',
          local_datetime: '2030-10-07T17:00',
          local_date: '2030-10-07',
          original_text: DEADLINE_TEXT,
          unresolved_reason: null,
        },
      }),
    ]),
  );
  assert.equal(inconsistent.status, 'failed');
  if (inconsistent.status === 'failed') {
    assert.equal(inconsistent.failure, 'invalid_semantics');
    assert.deepEqual(inconsistent.reasons, ['deadline_inconsistent:request:0']);
    assert.equal(inconsistent.usage?.output_tokens, 180);
  }
  const impossible = await run(
    wireOf([request({ deadline: exact(DEADLINE_TEXT, '2030-02-30T17:00') })]),
  );
  assert.equal(impossible.status, 'failed');
  if (impossible.status === 'failed')
    assert.deepEqual(impossible.reasons, ['deadline_date_invalid:request:0']);
  assert.deepEqual(
    extractionWireErrors(
      wireOf([request({ deadline: exact('x', '2030-10-07T25:00') })]),
    ),
    ['deadline_date_invalid:request:0'],
  );
});

test('text inside a quoted reply makes the request quoted even if the model says it is not (X39)', async () => {
  const quoted = `承知しました。\n> ${BODY}`;
  const result = extracted(
    await run(wireOf([request({ in_quoted_text: false })]), mail(quoted)),
  );
  assert.equal(result.requests[0]?.in_quoted_text, true);
  assert.equal(commonReasons(result).includes('in_quoted_text'), true);
  // モデルの申告も尊重する（どちらかが引用なら引用）。
  const claimed = extracted(
    await run(wireOf([request({ in_quoted_text: true })])),
  );
  assert.equal(claimed.requests[0]?.in_quoted_text, true);
});

test('confidence is never raised and the model confidence is only an observation', async () => {
  const result = extracted(await run(wireOf([request({ confidence: 'low' })])));
  assert.equal(result.requests[0]?.confidence_observed, 'low');
  const medium = extracted(
    await run(wireOf([request({ confidence: 'medium' })])),
  );
  assert.equal(medium.requests[0]?.confidence_observed, 'medium');
});

test('recipient and automated flags come from the headers, not the model', async () => {
  const result = extracted(
    await run(wireOf([request()]), mail(BODY), {
      facts: { addressed_to_me: false, from_automated_sender: true },
    }),
  );
  const first = result.requests[0];
  assert.equal(first?.addressed_to_me, false);
  assert.equal(first?.from_automated_sender, true);
  const reasons = autoOperationReasons('create_task', first as never, {
    ownCalendarSelected: true,
    labelAssigned: true,
    draftExists: false,
    budgetAvailable: true,
  });
  assert.equal(reasons.includes('not_addressed_to_me'), true);
  assert.equal(reasons.includes('automated_sender'), true);
});

// --- 変更（取消・完了・訂正。QA45 の抽出の部分） ---

const cancelWire = (
  relation: ExtractionWire['changes'][number]['relation'],
  targetText: string,
  changeText: string,
): ExtractionWire =>
  wireOf(
    [],
    [
      {
        relation,
        target_evidence: [quote(targetText)],
        change_evidence: [quote(changeText)],
        new_deadline: null,
      },
    ],
  );

test('a cancel without a new deadline is extracted with no requests and resolved only through the injected resolver (QA45)', async () => {
  const body = '先日の参加可否の件は取り消します';
  const wire = cancelWire('cancel', '先日の参加可否の件', '取り消します');
  const none = extracted(await run(wire, mail(body)));
  assert.deepEqual(none.requests, []);
  assert.equal(none.changes[0]?.resolution, 'unresolved');
  assert.equal(none.changes[0]?.target_request_entity_id, null);
  assert.deepEqual(
    none.changes[0]?.fields.map((field) => [field.field, field.status]),
    [
      ['target', 'explicit'],
      ['change', 'explicit'],
    ],
  );
  const calls: unknown[] = [];
  const one = extracted(
    await run(wire, mail(body), {
      resolveTarget: (refs, relation) => {
        calls.push([refs.map((ref) => [ref.start, ref.end]), relation]);
        return ['b8c1e2d3-4a5f-4b6c-8d7e-9f0a1b2c3d4e'];
      },
    }),
  );
  assert.equal(one.changes[0]?.resolution, 'resolved');
  assert.equal(
    one.changes[0]?.target_request_entity_id,
    'b8c1e2d3-4a5f-4b6c-8d7e-9f0a1b2c3d4e',
  );
  // 「先日の参加可否の件」は 9 コードポイント。
  assert.deepEqual(calls, [[[[0, 9]], 'cancel']]);
  const many = extracted(
    await run(wire, mail(body), {
      resolveTarget: () => ['id-1', 'id-2'],
    }),
  );
  assert.equal(many.changes[0]?.resolution, 'ambiguous');
  assert.equal(many.changes[0]?.target_request_entity_id, null);
});

test('an unverifiable target or an uncertain relation is never resolved (QA45)', async () => {
  const body = '先日の参加可否の件は取り消します';
  let called = 0;
  const resolver = (): readonly string[] => {
    called += 1;
    return ['id-1'];
  };
  const badTarget = extracted(
    await run(
      cancelWire('cancel', '存在しない引用', '取り消します'),
      mail(body),
      {
        resolveTarget: resolver,
      },
    ),
  );
  assert.equal(badTarget.changes[0]?.resolution, 'unresolved');
  assert.equal(
    badTarget.changes[0]?.fields.find((field) => field.field === 'target')
      ?.status,
    'missing',
  );
  const uncertain = extracted(
    await run(
      cancelWire('uncertain', '先日の参加可否の件', '取り消します'),
      mail(body),
      { resolveTarget: resolver },
    ),
  );
  assert.equal(uncertain.changes[0]?.resolution, 'unresolved');
  assert.equal(called, 0);
});

test('a correction with a new deadline keeps the year rule', async () => {
  const body = '参加可否の期限は10月9日に変更します';
  const result = extracted(
    await run(
      wireOf(
        [],
        [
          {
            relation: 'correction',
            target_evidence: [quote('参加可否の期限')],
            change_evidence: [quote('10月9日に変更します')],
            new_deadline: {
              resolution: 'date_only',
              local_datetime: null,
              local_date: '2030-10-09',
              original_text: '10月9日',
              unresolved_reason: null,
            },
          },
        ],
      ),
      mail(body),
    ),
  );
  assert.deepEqual(result.changes[0]?.new_deadline, {
    kind: 'unresolved',
    reason: 'missing_year',
    original_text: '10月9日',
  });
});

// --- 実行（送信・失敗・状態の写し） ---

test('invalid input is not sent and a mail with nothing readable is "unread", not empty success', async () => {
  const adapter = createFakeAdapter(respond(wireOf([])));
  const params = {
    request_id: 'req-1',
    profile: syntheticProfile({
      profile_id: 'background-low',
      role: 'background_text' as const,
    }),
    output_schema: schema,
    schema: validator,
    header: HEADER,
    facts: FACTS,
  };
  const unreadable = await extractMail(adapter, {
    ...params,
    input: mail(null, { subject: '' }),
  });
  assert.deepEqual(unreadable, {
    status: 'not_sent',
    errors: ['nothing_readable'],
  });
  assert.equal(analysisStateOfExtraction(unreadable), 'unread');
  const badInput = await extractMail(adapter, {
    ...params,
    input: mail(BODY, { received_at_local: 'not-a-date' }),
  });
  assert.equal(analysisStateOfExtraction(badInput), 'failed');
  assert.equal(adapter.commands.length, 0);
});

test('failures are separate from "no requests" and are never retried or repaired', async () => {
  const cases: readonly [AdapterResult, string, string][] = [
    [{ kind: 'timeout', usage: null }, 'timeout', 'pending'],
    [{ kind: 'unavailable', usage: null }, 'unavailable', 'pending'],
    [{ kind: 'cancelled', usage: null }, 'cancelled', 'pending'],
    [
      {
        kind: 'response',
        text: '',
        usage: USAGE,
        provider_request_id: null,
        refused: true,
        truncated: false,
      },
      'refused',
      'failed',
    ],
    [
      {
        kind: 'response',
        text: '{"language":"ja","requests":[',
        usage: USAGE,
        provider_request_id: null,
        refused: false,
        truncated: true,
      },
      'truncated',
      'failed',
    ],
    [
      {
        kind: 'response',
        text: '{"language":"ja","requests":[',
        usage: USAGE,
        provider_request_id: null,
        refused: false,
        truncated: false,
      },
      'invalid_schema',
      'failed',
    ],
  ];
  for (const [step, failure, state] of cases) {
    const adapter = createFakeAdapter(step);
    const outcome = await extractMail(adapter, {
      request_id: 'req-1',
      profile: syntheticProfile({
        profile_id: 'background-low',
        role: 'background_text',
      }),
      input: mail(BODY),
      output_schema: schema,
      schema: validator,
      header: HEADER,
      facts: FACTS,
    });
    assert.equal(outcome.status, 'failed', failure);
    if (outcome.status === 'failed') assert.equal(outcome.failure, failure);
    assert.equal(analysisStateOfExtraction(outcome), state, failure);
    // 1 回だけ送り、送り直さない（FakeAdapter は 2 回目で例外を投げる）。
    assert.equal(adapter.commands.length, 1, failure);
  }
});

test('an extraction with no requests is analyzed only when nothing was unread or truncated (QA45, 5B)', async () => {
  const empty = await run(
    wireOf([]),
    mail('お疲れさまです。会議室の件は了解です。'),
  );
  assert.equal(analysisStateOfExtraction(empty), 'analyzed');
  const unreadEmpty = await run(
    wireOf([]),
    mail('お疲れさまです。', {
      attachments: [
        {
          attachment_id: 'att-1',
          permitted: true,
          state: 'unread',
          source_revision: null,
        },
      ],
    }),
  );
  // 空の結果は返るが、未読があるので analyzed にならず、関連解析は ready にならない。
  assert.deepEqual(extracted(unreadEmpty).requests, []);
  assert.equal(analysisStateOfExtraction(unreadEmpty), 'unread');
  const base = {
    group_id: 'g-1',
    analysis_revision: '1',
    source_set_hash: 'h'.repeat(64),
    published_generation: '1',
    plan_complete: true,
    unresolved_change_count: 0,
  };
  const ready = (state: ReturnType<typeof analysisStateOfExtraction>) =>
    analysisReadiness({ ...base, sources: [{ state, rule_id: null }] }, '1')
      .ready;
  assert.equal(ready(analysisStateOfExtraction(empty)), true);
  assert.equal(ready(analysisStateOfExtraction(unreadEmpty)), false);
});

test('checkQuote reports the exact reason for each mismatch', () => {
  const sources = [
    {
      source_id: 'body',
      part: 'body' as const,
      source_revision: 'r1',
      text: '依頼です。依頼です。',
      quoted_ranges: [],
    },
  ];
  const check = (
    overrides: Partial<Parameters<typeof checkQuote>[0]>,
  ): ReturnType<typeof checkQuote> =>
    checkQuote(
      {
        part: 'body',
        source_id: 'body',
        source_revision: 'r1',
        quote: '依頼',
        ...overrides,
      },
      sources,
    );
  assert.deepEqual(check({ quote: '依頼です。依頼' }), {
    ok: true,
    ref: {
      source_id: 'body',
      source_revision: 'r1',
      quote: '依頼です。依頼',
      start: 0,
      end: 7,
    },
  });
  assert.deepEqual(check({}), { ok: false, reason: 'ambiguous' });
  assert.deepEqual(check({ source_id: 'x' }), {
    ok: false,
    reason: 'source_unknown',
  });
  assert.deepEqual(check({ part: 'subject' }), {
    ok: false,
    reason: 'part_mismatch',
  });
  assert.deepEqual(check({ source_revision: 'r2' }), {
    ok: false,
    reason: 'revision_mismatch',
  });
  assert.deepEqual(check({ quote: '期限' }), {
    ok: false,
    reason: 'not_found',
  });
});
