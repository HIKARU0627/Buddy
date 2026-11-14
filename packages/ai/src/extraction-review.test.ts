// Codex の指摘への回帰試験（B10-05 P2）。期限の原文の曖昧一致と、期限の欄の組み合わせの矛盾。
// 期待値は手書きで、契約の JSON Schema を正本にする。模擬の試験だけ。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ExtractionWire, ModelUsage } from '@buddy/contracts';
import { autoOperationReasons, candidateCommonReasons } from '@buddy/domain';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { extractMail } from './extraction.js';
import { extractionWireErrors, timeExpressed } from './extraction-evidence.js';
import type { ExtractionMailInput } from './extraction-input.js';
import { createFakeAdapter, syntheticProfile } from './testing.js';

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;
const schema = JSON.parse(
  readFileSync(
    new URL('../../contracts/schemas/buddy.schema.json', import.meta.url),
    'utf8',
  ),
) as { $id: string };
const ajv = new Ajv2020({ strict: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(schema);
const wireValidate = ajv.getSchema(`${schema.$id}#/$defs/ExtractionWire`);
if (wireValidate === undefined) throw new Error('ExtractionWire is missing');
const validator = { valid: (value: unknown) => wireValidate(value) === true };

const USAGE: ModelUsage = {
  input_tokens: 1000,
  cached_input_tokens: 0,
  output_tokens: 100,
  reasoning_tokens: null,
  usage_complete: true,
};
const HEADER = {
  source_account_id: '3f8a1c52-7b64-4d0e-9a21-5c6e8f1b2a40',
  thread_id: 'thread-1',
  message_id: 'message-1',
  source_revision: 'r1',
  profile_id: 'background-low',
  prompt_hash: 'a'.repeat(64),
  schema_hash: 'b'.repeat(64),
};
const RECEIVED = '2030-10-05T08:30';
const TEXT = '2030年10月9日17時までに';
const ASK = '参加可否を返信してください';

type Deadline = ExtractionWire['requests'][number]['deadline'];
const deadline = (
  resolution: Deadline['resolution'],
  over: Partial<Deadline>,
): Deadline => ({
  resolution,
  local_datetime: null,
  local_date: null,
  original_text: null,
  unresolved_reason: null,
  ...over,
});
const request = (
  over: Partial<ExtractionWire['requests'][number]> = {},
): ExtractionWire['requests'][number] => ({
  kind: 'reply_required',
  summary: '参加可否の返信',
  deadline: deadline('exact_datetime', {
    local_datetime: '2030-10-09T17:00',
    original_text: TEXT,
  }),
  evidence: [
    { part: 'body', source_id: 'body', source_revision: 'r1', quote: ASK },
  ],
  in_quoted_text: false,
  confidence: 'high',
  ...over,
});
const wireOf = (
  requests: ExtractionWire['requests'],
  changes: ExtractionWire['changes'] = [],
): ExtractionWire => ({ language: 'ja', requests, changes });

const mail = (
  body: string,
  attachments: ExtractionMailInput['attachments'] = [],
): ExtractionMailInput => ({
  received_at_local: RECEIVED,
  zone: 'Asia/Tokyo',
  owner_name: '試験太郎',
  subject: 'ご案内',
  message_revision: 'r1',
  body: { state: 'extracted', text: body },
  attachments,
});

async function run(wire: unknown, input: ExtractionMailInput) {
  const adapter = createFakeAdapter({
    kind: 'response',
    text: JSON.stringify(wire),
    usage: USAGE,
    provider_request_id: null,
    refused: false,
    truncated: false,
  });
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
    facts: { addressed_to_me: true, from_automated_sender: false },
  });
}

test('a deadline text that is ambiguous anywhere is not made unique by one match elsewhere', async () => {
  // 原文が本文に 2 回、添付に 1 回。依頼の根拠は別の一意な依頼文だけ。
  const input = mail(`${TEXT}\n${TEXT}\n${ASK}`, [
    {
      attachment_id: 'att-1',
      permitted: true,
      state: 'extracted',
      source_revision: 'a1',
      text: `${TEXT}回答をお願いします`,
    },
  ]);
  const outcome = await run(wireOf([request()]), input);
  assert.equal(outcome.status, 'extracted');
  if (outcome.status !== 'extracted') return;
  const first = outcome.result.requests[0];
  assert.deepEqual(
    first?.fields.find((field) => field.field === 'deadline'),
    { field: 'deadline', status: 'missing', refs: [], rule_id: null },
  );
  assert.equal(first?.confidence_observed, 'low');
  assert.equal(
    candidateCommonReasons(
      first as never,
      outcome.result.completeness,
      RECEIVED,
    ).includes('evidence_missing:deadline'),
    true,
  );
  // 対照: 全体で一度だけなら照合できる。
  const single = await run(wireOf([request()]), mail(`${TEXT}${ASK}`));
  assert.equal(single.status, 'extracted');
  if (single.status === 'extracted')
    assert.equal(
      single.result.requests[0]?.fields.find(
        (field) => field.field === 'deadline',
      )?.status,
      'explicit',
    );
});

test('every resolution rejects values in fields it does not use, for requests and for a change deadline', async () => {
  const bad: readonly Deadline[] = [
    // 確定した日時・日付に unresolved_reason が付く。
    deadline('exact_datetime', {
      local_datetime: '2030-10-09T17:00',
      original_text: TEXT,
      unresolved_reason: 'conflict',
    }),
    deadline('date_only', {
      local_date: '2030-10-09',
      original_text: TEXT,
      unresolved_reason: 'missing_year',
    }),
    // 必要な欄の欠落。
    deadline('exact_datetime', { original_text: TEXT }),
    deadline('exact_datetime', { local_datetime: '2030-10-09T17:00' }),
    deadline('date_only', { original_text: TEXT }),
    deadline('relative_unresolved', { original_text: TEXT }),
    deadline('relative_unresolved', { unresolved_reason: 'relative' }),
    // none に値が付く。
    deadline('none', { original_text: TEXT }),
    deadline('none', { unresolved_reason: 'relative' }),
    deadline('none', { local_date: '2030-10-09' }),
    // relative_unresolved に日付が付く。
    deadline('relative_unresolved', {
      local_date: '2030-10-09',
      original_text: TEXT,
      unresolved_reason: 'relative',
    }),
  ];
  for (const item of bad) {
    const label = JSON.stringify(item);
    assert.equal(
      extractionWireErrors(wireOf([request({ deadline: item })])).length > 0,
      true,
      label,
    );
    assert.equal(
      extractionWireErrors(
        wireOf(
          [],
          [
            {
              relation: 'correction',
              target_evidence: [],
              change_evidence: [],
              new_deadline: item,
            },
          ],
        ),
      ).length > 0,
      true,
      label,
    );
    // 実行でも失敗として返り、確定した期限・高い confidence の結果にならない。
    const outcome = await run(
      wireOf([request({ deadline: item })]),
      mail(`${TEXT}${ASK}`),
    );
    assert.equal(outcome.status, 'failed', label);
    if (outcome.status === 'failed')
      assert.equal(outcome.failure, 'invalid_semantics', label);
  }
  // 対照: 矛盾のない 4 つの形は通る。
  const good: readonly Deadline[] = [
    deadline('exact_datetime', {
      local_datetime: '2030-10-09T17:00',
      original_text: TEXT,
    }),
    deadline('date_only', { local_date: '2030-10-09', original_text: TEXT }),
    deadline('relative_unresolved', {
      original_text: TEXT,
      unresolved_reason: 'relative',
    }),
    deadline('none', {}),
  ];
  for (const item of good)
    assert.deepEqual(
      extractionWireErrors(wireOf([request({ deadline: item })])),
      [],
    );
});

test('a time the model adds to a date-only original is not made a confirmed instant (review)', async () => {
  // 原文は日付だけ。モデルが 23:59 を補って exact_datetime にした。
  const body = '2030年10月9日までに参加可否を返信してください';
  const original = '2030年10月9日までに';
  const outcome = await run(
    wireOf([
      request({
        deadline: deadline('exact_datetime', {
          local_datetime: '2030-10-09T23:59',
          original_text: original,
        }),
        evidence: [
          {
            part: 'body',
            source_id: 'body',
            source_revision: 'r1',
            quote: body,
          },
        ],
      }),
    ]),
    mail(body),
  );
  assert.equal(outcome.status, 'extracted');
  if (outcome.status !== 'extracted') return;
  const first = outcome.result.requests[0];
  // 日付だけの期限へ下げる（時刻を補わない）。予定の自動作成に必要な instant にならない。
  assert.deepEqual(first?.deadline, {
    kind: 'date',
    date: '2030-10-09',
    original_text: original,
  });
  assert.equal(outcome.diagnostics.time_downgrades, 1);
  const reasons = autoOperationReasons('create_event', first as never, {
    ownCalendarSelected: true,
    labelAssigned: true,
    draftExists: false,
    budgetAvailable: true,
  });
  assert.equal(reasons.includes('deadline_not_instant'), true);
  // 用事は日付だけの期限で作れる（時刻なし）。
  assert.equal(
    autoOperationReasons('create_task', first as never, {
      ownCalendarSelected: true,
      labelAssigned: true,
      draftExists: false,
      budgetAvailable: true,
    }).includes('deadline_not_fixed'),
    false,
  );
  // 日付だけの期限にも年の規則が働く（年の記載がなければ確定しない）。
  const noYear = await run(
    wireOf([
      request({
        deadline: deadline('exact_datetime', {
          local_datetime: '2030-10-09T23:59',
          original_text: '10月9日までに',
        }),
        evidence: [
          {
            part: 'body',
            source_id: 'body',
            source_revision: 'r1',
            quote: '10月9日までに参加可否を返信してください',
          },
        ],
      }),
    ]),
    mail('10月9日までに参加可否を返信してください'),
  );
  assert.equal(noYear.status, 'extracted');
  if (noYear.status === 'extracted')
    assert.equal(noYear.result.requests[0]?.deadline.kind, 'unresolved');
});

test('a time stated in the original text keeps the confirmed instant, for requests and change deadlines (review)', async () => {
  for (const text of [
    '2030年10月9日17時までに',
    '2030年10月9日 17:00 までに',
    '2030年10月9日午後5時までに',
    '2030年10月9日正午までに',
    'by 5pm on 2030-10-09',
  ]) {
    const body = `${text}${ASK}`;
    const outcome = await run(
      wireOf([
        request({
          deadline: deadline('exact_datetime', {
            local_datetime: '2030-10-09T17:00',
            original_text: text,
          }),
          evidence: [
            {
              part: 'body',
              source_id: 'body',
              source_revision: 'r1',
              quote: body,
            },
          ],
        }),
      ]),
      mail(body),
    );
    assert.equal(outcome.status, 'extracted', text);
    if (outcome.status === 'extracted')
      assert.equal(outcome.result.requests[0]?.deadline.kind, 'instant', text);
  }
  // 訂正の新しい期限にも同じ規則を当てる。
  const body = '参加可否の期限は2030年10月9日に変更します';
  const change = await run(
    wireOf(
      [],
      [
        {
          relation: 'correction',
          target_evidence: [
            {
              part: 'body',
              source_id: 'body',
              source_revision: 'r1',
              quote: '参加可否の期限',
            },
          ],
          change_evidence: [
            {
              part: 'body',
              source_id: 'body',
              source_revision: 'r1',
              quote: '2030年10月9日に変更します',
            },
          ],
          new_deadline: deadline('exact_datetime', {
            local_datetime: '2030-10-09T23:59',
            original_text: '2030年10月9日',
          }),
        },
      ],
    ),
    mail(body),
  );
  assert.equal(change.status, 'extracted');
  if (change.status === 'extracted')
    assert.deepEqual(change.result.changes[0]?.new_deadline, {
      kind: 'date',
      date: '2030-10-09',
      original_text: '2030年10月9日',
    });
});

test('timeExpressed recognises time words and rejects dates alone', () => {
  for (const yes of [
    '17時',
    '5:30',
    '１７：００',
    '午後',
    '午前中',
    '正午',
    '5pm',
    '5 P.M.',
    'noon',
    'midnight',
  ])
    assert.equal(timeExpressed(yes), true, yes);
  for (const no of [
    '2030年10月9日までに',
    '10月9日',
    '来週の金曜',
    'Oct 9, 2030',
    '2030-10-09',
    '時間をください',
    'cannon',
    'spam',
  ])
    assert.equal(timeExpressed(no), false, no);
});
