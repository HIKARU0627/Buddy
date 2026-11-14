// メール抽出の入口（B10-05 P3、ADR 0102）。X38・X62・QA10・QA45 の入口の層。
// アダプターは ai の偽の実装（実 API・API キーなし）、予算の口は偽。期待値は手で書いた値で、実装から作らない。
// 模擬の試験だけで、実機・実 API・実請求・実メールは未実施。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtractionWire, ModelUsage } from '@buddy/contracts';
import type { ExtractionMailInput } from '@buddy/ai';
import { createFakeAdapter, syntheticProfile } from '@buddy/ai/testing';
import type { FakeAdapter } from '@buddy/ai/testing';
import { analysisReadiness, prefilterCounts } from '@buddy/domain';
import type {
  MailRecipients,
  PrefilterContext,
  PrefilterHeaders,
  PrefilterRecord,
} from '@buddy/domain';
import { createApiContract, loadContractSchema } from './api-contract.js';
import {
  CALENDAR_INVITE_RULE_ID,
  analysisSourceOf,
  createMailExtractor,
} from './mail-extraction.js';
import type {
  MailExtractionOutcome,
  MailExtractionRequest,
} from './mail-extraction.js';
import type { ModelCallAdmission } from './model-interpreter.js';

const contract = createApiContract();
const schema = loadContractSchema() as Record<string, unknown>;
const outputSchema = { ...schema, $ref: '#/$defs/ExtractionWire' };
const schemaValidator = {
  valid: (value: unknown) => contract.valid('ExtractionWire', value),
};

const USAGE: ModelUsage = {
  input_tokens: 900,
  cached_input_tokens: 0,
  output_tokens: 120,
  reasoning_tokens: null,
  usage_complete: true,
};
const ACCOUNT = '3f8a1c52-7b64-4d0e-9a21-5c6e8f1b2a40';
const profile = syntheticProfile({
  profile_id: 'background-low',
  role: 'background_text',
});

const human: PrefilterHeaders = {
  auto_submitted: null,
  precedence: null,
  has_list_unsubscribe: false,
  from_local_part: 'tanaka',
  is_calendar_invite: false,
};
const automated: PrefilterHeaders = {
  ...human,
  auto_submitted: 'auto-generated',
};
const recipients: MailRecipients = {
  to: ['me@example.invalid'],
  cc: [],
};
const context: PrefilterContext = {
  user_requested: false,
  thread_has_activity: false,
  filter_enabled: true,
};

const mailOf = (
  body: string | null,
  overrides: Partial<ExtractionMailInput> = {},
): ExtractionMailInput => ({
  received_at_local: '2030-10-05T08:30',
  zone: 'Asia/Tokyo',
  owner_name: '試験太郎',
  subject: 'ご案内',
  message_revision: 'r1',
  body:
    body === null ? { state: 'unread' } : { state: 'extracted', text: body },
  attachments: [],
  ...overrides,
});

const requestOf = (
  overrides: Partial<MailExtractionRequest> = {},
): MailExtractionRequest => ({
  source_account_id: ACCOUNT,
  thread_id: 'thread-1',
  message_id: 'message-1',
  mail: mailOf('2030年10月7日17時までに参加可否を返信してください'),
  headers: human,
  recipients,
  own_addresses: ['Me@Example.invalid'],
  context,
  ...overrides,
});

const DEADLINE = '2030年10月7日17時までに';
const ASK = '参加可否を返信してください';
const goodWire: ExtractionWire = {
  language: 'ja',
  requests: [
    {
      kind: 'reply_required',
      summary: '参加可否の返信',
      deadline: {
        resolution: 'exact_datetime',
        local_datetime: '2030-10-07T17:00',
        local_date: null,
        original_text: DEADLINE,
        unresolved_reason: null,
      },
      evidence: [
        {
          part: 'body',
          source_id: 'body',
          source_revision: 'r1',
          quote: DEADLINE,
        },
        { part: 'body', source_id: 'body', source_revision: 'r1', quote: ASK },
      ],
      in_quoted_text: false,
      confidence: 'high',
    },
  ],
  changes: [],
};

interface Rig {
  readonly adapter: FakeAdapter;
  readonly records: PrefilterRecord[];
  readonly admits: number[];
  readonly settled: (ModelUsage | null)[];
  readonly released: number[];
  extract(request: MailExtractionRequest): Promise<MailExtractionOutcome>;
}

function rig(
  steps: Parameters<typeof createFakeAdapter>[0] = [],
  admission: 'ok' | 'denied' | 'throws' = 'ok',
): Rig {
  const adapter = createFakeAdapter(steps);
  const records: PrefilterRecord[] = [];
  const admits: number[] = [];
  const settled: (ModelUsage | null)[] = [];
  const released: number[] = [];
  const extractor = createMailExtractor({
    adapter,
    profile,
    output_schema: outputSchema,
    schema: schemaValidator,
    guard: {
      async admit(): Promise<ModelCallAdmission> {
        admits.push(1);
        if (admission === 'throws') throw new Error('guard down');
        if (admission === 'denied')
          return { ok: false, reasons: ['month_full'] };
        return {
          ok: true,
          settle: async (usage) => {
            settled.push(usage);
          },
          release: async () => {
            released.push(1);
          },
        };
      },
    },
    fingerprints: { prompt_hash: 'a'.repeat(64), schema_hash: 'b'.repeat(64) },
    records: { record: (entry) => void records.push(entry) },
    now: () => new Date('2030-10-05T00:00:00.000Z'),
    newRequestId: () => 'req-1',
  });
  return {
    adapter,
    records,
    admits,
    settled,
    released,
    extract: extractor.extract,
  };
}

const response = (wire: unknown) => ({
  kind: 'response' as const,
  text: JSON.stringify(wire),
  usage: USAGE,
  provider_request_id: null,
  refused: false,
  truncated: false,
});

const ready = (outcome: MailExtractionOutcome): boolean => {
  const source = analysisSourceOf(outcome);
  return analysisReadiness(
    {
      group_id: 'g-1',
      analysis_revision: '1',
      source_set_hash: 'h'.repeat(64),
      published_generation: '1',
      plan_complete: true,
      sources: [source],
      unresolved_change_count: 0,
    },
    '1',
  ).ready;
};

test('X38: an automated mail without any cue never reaches the budget gate or the model', async () => {
  const r = rig([]);
  const outcome = await r.extract(
    requestOf({
      headers: automated,
      mail: mailOf(
        'ご利用ありがとうございます。明細は会員サイトでご確認いただけます。',
      ),
    }),
  );
  assert.equal(outcome.status, 'filtered');
  assert.equal(r.adapter.commands.length, 0);
  assert.equal(r.admits.length, 0);
  assert.deepEqual(r.records, [
    {
      source_account_id: ACCOUNT,
      message_id: 'message-1',
      source_revision: 'r1',
      decision: 'skipped_automated',
      reasons: ['automated_no_cue'],
      rule_id: 'prefilter_automated_no_cue_v1',
      decided_at: '2030-10-05T00:00:00.000Z',
    },
  ]);
  // 外したメールは、規則 ID 付きの除外として関連解析を ready にできる（規則 ID なしの除外とは違う）。
  assert.deepEqual(analysisSourceOf(outcome), {
    state: 'excluded',
    rule_id: 'prefilter_automated_no_cue_v1',
  });
  assert.equal(ready(outcome), true);
});

test('X38: an automated mail with a deadline is analyzed, and a user request analyzes the cue-less one too', async () => {
  const withCue = rig(response(goodWire));
  const analyzed = await withCue.extract(requestOf({ headers: automated }));
  assert.equal(analyzed.status, 'extraction');
  assert.equal(withCue.adapter.commands.length, 1);
  assert.equal(withCue.records[0]?.decision, 'analyzed');

  const requested = rig(
    response({ language: 'ja', requests: [], changes: [] }),
  );
  const outcome = await requested.extract(
    requestOf({
      headers: automated,
      mail: mailOf('ご利用ありがとうございます。'),
      context: { ...context, user_requested: true },
    }),
  );
  assert.equal(outcome.status, 'extraction');
  assert.equal(requested.adapter.commands.length, 1);
  assert.deepEqual(requested.records[0]?.reasons, ['user_requested']);
});

test('the diagnostic counts follow the records and nothing is surfaced as a candidate', async () => {
  const r = rig(response(goodWire));
  await r.extract(
    requestOf({ headers: automated, mail: mailOf('お知らせです。') }),
  );
  await r.extract(requestOf({ message_id: 'message-2' }));
  assert.deepEqual(prefilterCounts(r.records), {
    analyzed: 1,
    skipped_automated: 1,
    handled_elsewhere: 0,
  });
  // 判定の記録は本文・件名・宛先を持たない。
  for (const record of r.records)
    assert.equal(JSON.stringify(record).includes('お知らせ'), false);
});

test('a calendar invite is handled elsewhere without a model call', async () => {
  const r = rig([]);
  const outcome = await r.extract(
    requestOf({ headers: { ...human, is_calendar_invite: true } }),
  );
  assert.equal(outcome.status, 'filtered');
  assert.equal(r.adapter.commands.length, 0);
  assert.equal(r.records[0]?.decision, 'handled_elsewhere');
  assert.deepEqual(analysisSourceOf(outcome), {
    state: 'excluded',
    rule_id: CALENDAR_INVITE_RULE_ID,
  });
});

test('X62: an automated mail whose deadline is only in a selected attachment is analyzed and grounded in the attachment', async () => {
  const text = '2030年10月9日17時までに';
  const wire: ExtractionWire = {
    language: 'ja',
    requests: [
      {
        kind: 'action_required',
        summary: '回答',
        deadline: {
          resolution: 'exact_datetime',
          local_datetime: '2030-10-09T17:00',
          local_date: null,
          original_text: text,
          unresolved_reason: null,
        },
        evidence: [
          {
            part: 'attachment',
            source_id: 'att-1',
            source_revision: 'a1',
            quote: text,
          },
        ],
        in_quoted_text: false,
        confidence: 'high',
      },
    ],
    changes: [],
  };
  const r = rig(response(wire));
  const outcome = await r.extract(
    requestOf({
      headers: automated,
      mail: mailOf('詳細は添付をご覧ください。', {
        attachments: [
          {
            attachment_id: 'att-1',
            permitted: true,
            state: 'extracted',
            source_revision: 'a1',
            text: `${text}回答をお願いします`,
          },
        ],
      }),
    }),
  );
  assert.equal(outcome.status, 'extraction');
  if (outcome.status !== 'extraction') return;
  assert.equal(outcome.extraction.status, 'extracted');
  if (outcome.extraction.status !== 'extracted') return;
  const first = outcome.extraction.result.requests[0];
  assert.equal(first?.confidence_observed, 'high');
  assert.equal(first?.from_automated_sender, true);
  assert.equal(first?.addressed_to_me, true);
  assert.deepEqual(
    first?.fields.find((field) => field.field === 'deadline')?.refs,
    [
      {
        source_id: 'att-1',
        source_revision: 'a1',
        quote: text,
        start: 0,
        end: 16,
      },
    ],
  );
  assert.equal(ready(outcome), true);
});

test('X62: a failed, unread or truncated attachment is never a reason to drop the mail, and the result is not ready', async () => {
  const unreadAttachments: ExtractionMailInput['attachments'][] = [
    [
      {
        attachment_id: 'att-1',
        permitted: true,
        state: 'failed',
        source_revision: null,
      },
    ],
    [
      {
        attachment_id: 'att-1',
        permitted: true,
        state: 'unread',
        source_revision: null,
      },
    ],
    [
      {
        attachment_id: 'att-1',
        permitted: true,
        state: 'extracted',
        source_revision: 'a1',
        text: '冒頭だけ',
        extraction_truncated: true,
      },
    ],
  ];
  for (const attachments of unreadAttachments) {
    const r = rig(response({ language: 'ja', requests: [], changes: [] }));
    const outcome = await r.extract(
      requestOf({
        headers: automated,
        mail: mailOf('詳細は添付をご覧ください。', { attachments }),
      }),
    );
    // 手がかりを確かめられないので外さず、解析する。
    assert.equal(r.adapter.commands.length, 1, JSON.stringify(attachments));
    assert.deepEqual(r.records[0]?.reasons, ['cue_undetermined']);
    // 依頼 0 件の結果でも、未読・切詰めがあるので関連解析は ready にならない（QA10・QA45）。
    assert.equal(analysisSourceOf(outcome).state, 'unread');
    assert.equal(ready(outcome), false);
  }
});

test('an attachment outside the permitted scope is neither read nor sent', async () => {
  const r = rig([]);
  const outcome = await r.extract(
    requestOf({
      headers: automated,
      mail: mailOf('詳細は添付をご覧ください。', {
        attachments: [
          {
            attachment_id: 'att-out',
            permitted: false,
            state: 'extracted',
            source_revision: 'a1',
            text: '2030年10月9日17時までに回答',
          },
        ],
      }),
    }),
  );
  assert.equal(outcome.status, 'filtered');
  assert.equal(r.adapter.commands.length, 0);
});

test('an active thread, or a disabled filter, keeps an automated mail without cues', async () => {
  for (const override of [
    { thread_has_activity: true },
    { filter_enabled: false },
  ]) {
    const r = rig(response({ language: 'ja', requests: [], changes: [] }));
    const outcome = await r.extract(
      requestOf({
        headers: automated,
        mail: mailOf('お知らせです。'),
        context: { ...context, ...override },
      }),
    );
    assert.equal(outcome.status, 'extraction');
    assert.equal(r.adapter.commands.length, 1);
  }
});

test('recipient and automated flags are decided from the headers before the model sees anything', async () => {
  const r = rig(response(goodWire));
  const outcome = await r.extract(
    requestOf({
      recipients: { to: ['other@example.invalid'], cc: ['me@example.invalid'] },
    }),
  );
  assert.equal(outcome.status, 'extraction');
  if (outcome.status !== 'extraction') return;
  assert.equal(outcome.extraction.status, 'extracted');
  if (outcome.extraction.status !== 'extracted') return;
  assert.equal(outcome.extraction.result.requests[0]?.addressed_to_me, false);
  // モデルへ渡した入力にアドレスは含まれない。
  const sent = JSON.stringify(r.adapter.commands[0]?.messages);
  assert.equal(sent.includes('example.invalid'), false);
});

test('budget: denial or a failing gate sends nothing and leaves the source pending, never ready', async () => {
  const denied = rig([], 'denied');
  const deniedOutcome = await denied.extract(requestOf());
  assert.equal(denied.adapter.commands.length, 0);
  assert.equal(deniedOutcome.status, 'extraction');
  if (deniedOutcome.status === 'extraction')
    assert.deepEqual(deniedOutcome.extraction, {
      status: 'failed',
      failure: 'budget_denied',
      retryable: true,
      detail: null,
      reasons: ['month_full'],
      usage: null,
    });
  assert.equal(analysisSourceOf(deniedOutcome).state, 'pending');
  assert.equal(ready(deniedOutcome), false);

  const down = rig([], 'throws');
  const downOutcome = await down.extract(requestOf());
  assert.equal(down.adapter.commands.length, 0);
  assert.equal(analysisSourceOf(downOutcome).state, 'pending');
});

test('a successful call settles the observed usage once; an adapter that throws keeps the reservation as usage-unknown', async () => {
  const ok = rig(response(goodWire));
  await ok.extract(requestOf());
  assert.deepEqual(ok.settled, [USAGE]);
  assert.equal(ok.released.length, 0);
  assert.equal(ok.adapter.commands.length, 1);

  const throwing = rig([
    () => {
      throw new Error('network');
    },
  ]);
  const outcome = await throwing.extract(requestOf());
  assert.deepEqual(throwing.settled, [null]);
  assert.equal(analysisSourceOf(outcome).state, 'pending');
  assert.equal(throwing.adapter.commands.length, 1);
});

test('model failures are never turned into an empty success and are not retried', async () => {
  const cases: readonly [Parameters<typeof createFakeAdapter>[0], string][] = [
    [{ kind: 'timeout', usage: null }, 'pending'],
    [
      {
        kind: 'response',
        text: '{"language":"ja"}',
        usage: USAGE,
        provider_request_id: null,
        refused: false,
        truncated: false,
      },
      'failed',
    ],
  ];
  for (const [step, state] of cases) {
    const r = rig(step);
    const outcome = await r.extract(requestOf());
    assert.equal(analysisSourceOf(outcome).state, state);
    assert.equal(ready(outcome), false);
    assert.equal(r.adapter.commands.length, 1);
  }
});

test('a mail with nothing readable is not sent and does not reserve budget', async () => {
  const r = rig([]);
  const outcome = await r.extract(
    requestOf({ mail: mailOf(null, { subject: '' }) }),
  );
  assert.equal(r.admits.length, 0);
  assert.equal(r.adapter.commands.length, 0);
  assert.equal(analysisSourceOf(outcome).state, 'unread');
  assert.equal(ready(outcome), false);
});
