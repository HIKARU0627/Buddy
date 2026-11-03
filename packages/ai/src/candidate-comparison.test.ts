// X57 の模擬の候補比較（B10-03）。候補モデルに同じ指示・同じ基準時刻・同じ入力を渡し、結果を候補ごとに分けて残せる。
// 本人確認済みの評価セット・採点・採否は B10-07。ここは「同じ条件で解かせる」仕組みだけを模擬で確かめる。
// 期待値は手で書いた値。実 API・実請求・実機は未実施で、合格扱いにしない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { WireResponse } from '@buddy/contracts';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { judgeIntent } from './intent-judgment.js';
import type { IntentJudgmentInput } from './intent-judgment.js';
import { createFakeAdapter, syntheticProfile } from './testing.js';

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;
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
const wireSchema = ajv.getSchema(`${schema.$id}#/$defs/WireResponse`);
if (wireSchema === undefined) throw new Error('WireResponse is missing');
const validator = { valid: (value: unknown) => wireSchema(value) === true };

const emptyArgs = {
  target_candidate_id: null,
  start: null,
  end: null,
  due: null,
  title: null,
  body: null,
  subject: null,
  add_labels: null,
  remove_labels: null,
  task_change: null,
  memory_kind: null,
  query: null,
  device_name: null,
};
const wire = (over: Partial<WireResponse>): string =>
  JSON.stringify({
    intent: 'query_schedule',
    args: { ...emptyArgs, start: '2026-11-04' },
    relation: 'new',
    target_workflow_id: null,
    reply_text: null,
    clarify_question: null,
    confidence: 0.9,
    ...over,
  });
const usage = {
  input_tokens: 1000,
  cached_input_tokens: 0,
  output_tokens: 40,
  reasoning_tokens: null,
  usage_complete: true,
};
const response = (text: string, flags: { refused?: boolean } = {}) => ({
  kind: 'response' as const,
  text,
  usage,
  provider_request_id: 'req',
  refused: flags.refused ?? false,
  truncated: false,
});

const input: IntentJudgmentInput = {
  utterance: '来週の月曜の会議を教えて',
  today: '2026-11-03',
  candidates: [],
  open_workflows: [],
};

test('X57: every candidate model gets the same instruction, base date, and input, and each result is kept apart', async () => {
  const candidates = [
    {
      profile: syntheticProfile({ profile_id: 'candidate-a', role: 'intent' }),
      step: response(wire({})),
    },
    {
      profile: syntheticProfile({
        profile_id: 'candidate-b',
        role: 'intent',
        reasoning: null,
      }),
      // 別の候補は意図を取り違える。
      step: response(
        wire({
          intent: 'query_tasks',
          args: { ...emptyArgs, start: '2026-11-04' },
        }),
      ),
    },
    {
      // 拒否した候補があっても、ほかの候補の結果を消さない。
      profile: syntheticProfile({ profile_id: 'candidate-c', role: 'intent' }),
      step: response('', { refused: true }),
    },
  ];
  const sent: string[][] = [];
  const results = [];
  for (const candidate of candidates) {
    const adapter = createFakeAdapter([candidate.step]);
    const result = await judgeIntent(adapter, {
      request_id: `compare-${candidate.profile.profile_id}`,
      profile: candidate.profile,
      input,
      output_schema: { marker: 'wire' },
      schema: validator,
    });
    sent.push(
      (adapter.commands[0]?.messages ?? []).map((message) => message.content),
    );
    results.push({
      id: candidate.profile.profile_id,
      judgment: result.judgment,
    });
  }
  // 指示（固定部分）・基準日・候補・発話は、候補によらず同じ文字列。
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(sent[2], sent[0]);
  assert.ok(sent[0]?.[1]?.includes('基準日: 2026-11-03'));
  // 結果は候補ごとに分かれる。
  assert.deepEqual(
    results.map((entry) => [
      entry.id,
      entry.judgment.kind === 'intent'
        ? entry.judgment.intent
        : entry.judgment.kind === 'failed'
          ? `failed:${entry.judgment.failure}`
          : 'unclear',
    ]),
    [
      ['candidate-a', 'query_schedule'],
      ['candidate-b', 'query_tasks'],
      ['candidate-c', 'failed:refused'],
    ],
  );
});
