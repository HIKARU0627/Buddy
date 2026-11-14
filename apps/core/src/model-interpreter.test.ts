// モデルを使う解釈の接続（B10-03 P2、ADR 0091）。X58・QA01・QA02・QA03・QA04 の解釈の層。
// アダプターは ai の偽の実装（実 API・API キーなし）、予算の口は偽。期待値は手で書いた値で、実装から作らない。
// 模擬の試験だけで、実機・実 API・実請求は未実施。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ModelProfile, ModelUsage } from '@buddy/contracts';
import { createFakeAdapter, syntheticProfile } from '@buddy/ai/testing';
import type { FakeAdapterStep } from '@buddy/ai/testing';
import { createApiContract, loadContractSchema } from './api-contract.js';
import { createModelInterpreter } from './model-interpreter.js';
import type {
  JudgmentDiagnostic,
  ModelCallGuard,
} from './model-interpreter.js';
import { TEST_TURN_POLICY } from './turn-ports.js';
import type {
  Interpreter,
  InterpreterReply,
  ProviderReader,
} from './turn-ports.js';
import type { TestDevice } from './api-test-support.js';
import {
  bootstrap,
  getJson,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';

const contract = createApiContract();
const schema = loadContractSchema() as Record<string, unknown>;
const outputSchema = { ...schema, $ref: '#/$defs/WireResponse' };
const schemaValidator = {
  valid: (value: unknown) => contract.valid('WireResponse', value),
};

const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ID = '00000000-0000-4000-8000-0000000000c9';

const profile: ModelProfile = syntheticProfile({
  profile_id: 'intent-primary',
  role: 'intent',
  provider: 'gemini',
});

const usage: ModelUsage = {
  input_tokens: 1000,
  cached_input_tokens: 0,
  output_tokens: 60,
  reasoning_tokens: 10,
  usage_complete: true,
};

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

const wireJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    intent: 'create_task',
    args: { ...emptyArgs, title: '歯医者の予約' },
    relation: 'new',
    target_workflow_id: null,
    reply_text: null,
    clarify_question: null,
    confidence: 0.9,
    ...over,
  });

const response = (text: string, extra: object = {}): FakeAdapterStep => ({
  kind: 'response',
  text,
  usage,
  provider_request_id: 'req-1',
  refused: false,
  truncated: false,
  ...extra,
});

// 予算の口の偽: 受付の回数・精算した usage を記録する。
function fakeGuard(options: { deny?: boolean; throws?: boolean } = {}) {
  const log = {
    admitted: [] as string[],
    settled: [] as (ModelUsage | null)[],
  };
  const guard: ModelCallGuard = {
    admit(call) {
      if (options.throws === true) return Promise.reject(new Error('down'));
      if (options.deny === true)
        return Promise.resolve({ ok: false, reasons: ['month_limit'] });
      log.admitted.push(call.request_id);
      return Promise.resolve({
        ok: true,
        release: () => Promise.resolve(),
        settle: (used) => {
          log.settled.push(used);
          return Promise.resolve();
        },
      });
    },
  };
  return { guard, log };
}

// 固定の時計（判定時間の期待値を手で書けるように、呼ぶたびに 25ms 進める）。
let tick = 0;
const clock = (): number => {
  tick += 25;
  return tick;
};

const context = (text: string, over: object = {}) => ({
  text,
  today: '2026-10-05',
  mail_candidates: [{ candidate_id: MAIL_CANDIDATE, remote_id: 'mail-001' }],
  ...over,
});

function build(
  steps: FakeAdapterStep | readonly FakeAdapterStep[],
  guard: ModelCallGuard,
  diagnostics: JudgmentDiagnostic[] = [],
) {
  const adapter = createFakeAdapter(steps);
  const raw = createModelInterpreter({
    adapter,
    profile,
    output_schema: outputSchema,
    schema: schemaValidator,
    guard,
    onJudged: (diagnostic) => diagnostics.push(diagnostic),
    now: clock,
  });
  // 試験の期待値は判定時間を含めない（判定時間は別の試験で確かめる）。
  const interpreter: Interpreter = {
    interpret: async (input) => {
      const reply = await raw.interpret(input);
      return Object.fromEntries(
        Object.entries(reply).filter(([key]) => key !== 'elapsed_ms'),
      ) as InterpreterReply;
    },
  };
  return { adapter, interpreter, raw, diagnostics };
}

test('an intent judgment is returned as an intent reply and the usage is settled once', async () => {
  const { guard, log } = fakeGuard();
  const { adapter, interpreter, diagnostics } = build(
    response(wireJson()),
    guard,
  );
  const reply = await interpreter.interpret(
    context('用事に歯医者の予約を追加して'),
  );
  assert.deepEqual(reply, {
    kind: 'intent',
    intent: 'create_task',
    args: { ...emptyArgs, title: '歯医者の予約' },
    relation: 'new',
  });
  assert.equal(adapter.commands.length, 1);
  assert.equal(log.admitted.length, 1);
  assert.deepEqual(log.settled, [usage]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.result, 'intent');
  assert.equal(diagnostics[0]?.sent, true);
  // 診断に発話の本文を含めない。
  assert.ok(!JSON.stringify(diagnostics).includes('歯医者'));
});

test('the reply carries the elapsed time of the judgment for diagnostics', async () => {
  const { guard } = fakeGuard();
  const { raw } = build(response(wireJson()), guard);
  const reply = await raw.interpret(context('用事を足して'));
  // 時計は呼ぶたびに 25ms 進む: 開始と終了の間に診断の時刻の読みが入るので 50ms。
  assert.equal(typeof (reply as { elapsed_ms?: number }).elapsed_ms, 'number');
  assert.ok(((reply as { elapsed_ms?: number }).elapsed_ms ?? -1) >= 25);
});

test('candidates are sent with neutral labels only: no provider ID, subject, or sender', async () => {
  const { guard } = fakeGuard();
  const { adapter, interpreter } = build(response(wireJson()), guard);
  await interpreter.interpret(context('1番目のメールにラベルを付けて'));
  const sent = adapter.commands[0]?.messages
    .map((message) => message.content)
    .join('\n');
  assert.ok(sent?.includes(`candidate_id=${MAIL_CANDIDATE} 目印=メール1`));
  assert.ok(!sent?.includes('mail-001'));
});

test('open workflows are offered, and a target outside them is invalid_semantics (QA04)', async () => {
  const offered = '00000000-0000-4000-8000-0000000000a1';
  const second = '00000000-0000-4000-8000-0000000000a2';
  const openWorkflows = [
    { workflow_id: offered, intent: null, state: 'in_flight' as const },
    { workflow_id: second, intent: null, state: 'in_flight' as const },
  ];
  const { guard } = fakeGuard();
  // 2 候補のうち 1 つを指す訂正は通す。
  const ok = build(
    response(
      wireJson({
        intent: 'create_event',
        args: { ...emptyArgs, title: '面談', start: '2026-10-06T16:00:00' },
        relation: 'correction',
        target_workflow_id: offered,
      }),
    ),
    guard,
  );
  const accepted = await ok.interpreter.interpret(
    context('いや16時にして', { open_workflows: openWorkflows }),
  );
  assert.equal(accepted.kind, 'intent');
  assert.equal(
    accepted.kind === 'intent' ? accepted.target_workflow_id : null,
    offered,
  );
  const sent = ok.adapter.commands[0]?.messages[1]?.content ?? '';
  assert.ok(sent.includes(`workflow_id=${offered} 状態=in_flight`));
  assert.ok(sent.includes(`workflow_id=${second} 状態=in_flight`));
  // 渡していない依頼を指す訂正は拒否（実行へ進まない）。
  const bad = build(
    response(wireJson({ relation: 'cancel', target_workflow_id: OTHER_ID })),
    guard,
  );
  assert.deepEqual(
    await bad.interpreter.interpret(
      context('それやめて', { open_workflows: openWorkflows }),
    ),
    { kind: 'failed', failure: 'invalid_semantics', retryable: false },
  );
  // 2 候補で対象を決めない取消は通る（relation は cancel、対象なし → Live が聞き返す）。
  const undecided = build(
    response(wireJson({ relation: 'cancel', target_workflow_id: null })),
    guard,
  );
  assert.deepEqual(
    await undecided.interpreter.interpret(
      context('それやめて', { open_workflows: openWorkflows }),
    ),
    {
      kind: 'intent',
      intent: 'create_task',
      args: { ...emptyArgs, title: '歯医者の予約' },
      relation: 'cancel',
    },
  );
});

test('failures are returned as failed (never unclear) and usage is still settled when it is known', async () => {
  const cases: [string, FakeAdapterStep, string][] = [
    ['refused', response('', { refused: true }), 'refused'],
    ['truncated', response('{"intent":', { truncated: true }), 'truncated'],
    ['mid json', response('{"intent":"create_ta'), 'invalid_schema'],
    ['timeout', { kind: 'timeout', usage: null }, 'timeout'],
    ['unavailable', { kind: 'unavailable', usage: null }, 'unavailable'],
    ['cancelled', { kind: 'cancelled', usage: null }, 'cancelled'],
    [
      'unknown intent',
      response(wireJson({ intent: 'delete_everything' })),
      'invalid_schema',
    ],
    [
      'wrong type',
      response(wireJson({ confidence: 'high' })),
      'invalid_schema',
    ],
    [
      'candidate not offered',
      response(
        wireJson({
          intent: 'trash_mail',
          args: { ...emptyArgs, target_candidate_id: OTHER_ID },
        }),
      ),
      'invalid_semantics',
    ],
  ];
  for (const [name, step, failure] of cases) {
    const { guard, log } = fakeGuard();
    const { adapter, interpreter } = build(step, guard);
    const reply = await interpreter.interpret(context('なにか'));
    assert.equal(reply.kind, 'failed', name);
    assert.equal(reply.kind === 'failed' && reply.failure, failure, name);
    // 1 回だけ送り、自動の再送をしない。
    assert.equal(adapter.commands.length, 1, name);
    assert.equal(log.settled.length, 1, name);
  }
});

test('a model that says unclear is an unclear reply, not a failure', async () => {
  const { guard } = fakeGuard();
  const { interpreter } = build(
    response(
      wireJson({
        intent: 'unclear',
        args: { ...emptyArgs },
        clarify_question: 'どうしたいか教えてください',
        confidence: 0.1,
      }),
    ),
    guard,
  );
  assert.deepEqual(await interpreter.interpret(context('えーと')), {
    kind: 'unclear',
  });
});

test('a denied or failing budget guard stops before sending', async () => {
  const denied = fakeGuard({ deny: true });
  const a = build(response(wireJson()), denied.guard);
  assert.deepEqual(await a.interpreter.interpret(context('用事を足して')), {
    kind: 'failed',
    failure: 'budget_denied',
    retryable: true,
  });
  assert.equal(a.adapter.commands.length, 0);
  const broken = fakeGuard({ throws: true });
  const b = build(response(wireJson()), broken.guard);
  assert.equal(
    (await b.interpreter.interpret(context('用事を足して'))).kind,
    'failed',
  );
  assert.equal(b.adapter.commands.length, 0);
});

test('an invalid input is refused before the budget is touched', async () => {
  const { guard, log } = fakeGuard();
  const { adapter, interpreter } = build(response(wireJson()), guard);
  assert.deepEqual(await interpreter.interpret(context('   ')), {
    kind: 'failed',
    failure: 'invalid_semantics',
    retryable: false,
  });
  assert.equal(log.admitted.length, 0);
  assert.equal(adapter.commands.length, 0);
});

test('an adapter exception keeps the reservation as usage unknown and does not resend', async () => {
  const { guard, log } = fakeGuard();
  // 台本が尽きた偽のアダプターは例外を投げる。
  const { adapter, interpreter } = build([], guard);
  const reply = await interpreter.interpret(context('用事を足して'));
  assert.equal(reply.kind, 'failed');
  assert.equal(adapter.commands.length, 1);
  assert.deepEqual(log.settled, [null]);
});

// --- HTTP の経路（会話の操作はモデルの前にコードで照合する） ---

const provider: ProviderReader = {
  connection: () => Promise.resolve(null),
  readPermission: () => Promise.resolve(null),
  readTarget: () => Promise.resolve(null),
  listEvents: () => Promise.resolve([]),
};

async function startCore(
  t: test.TestContext,
  steps: FakeAdapterStep | readonly FakeAdapterStep[],
) {
  const { guard, log } = fakeGuard();
  const built = build(steps, guard);
  const core: EventCore = await startEventCore(t, {
    previewValid: false,
    now: () => CLOCK,
    turns: {
      provider,
      interpreter: built.interpreter,
      candidates: {
        mailCandidates: () =>
          Promise.resolve([
            { candidate_id: MAIL_CANDIDATE, remote_id: 'mail-001' },
          ]),
      },
      policy: TEST_TURN_POLICY,
      utcOffset: '+09:00',
    },
  });
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
  const created = await postJson(core, device, '/v1/sessions', {
    request_id: randomUUID(),
    command_scope_id: scope,
    storage_mode: 'normal',
  });
  assert.equal(created.status, 201, created.text);
  return {
    core,
    device,
    scope,
    session: String(created.json?.['session_id']),
    generation: String(created.json?.['segment_generation']),
    adapter: built.adapter,
    log,
  };
}

const say = (
  ctx: Awaited<ReturnType<typeof startCore>>,
  text: string,
  requestId: string = randomUUID(),
) =>
  postJson(
    ctx.core,
    ctx.device as TestDevice,
    `/v1/sessions/${ctx.session}/turns`,
    {
      request_id: requestId,
      command_scope_id: ctx.scope,
      text,
      input_kind: 'text',
      origin: {
        segment_id: ctx.session,
        segment_generation: ctx.generation,
      },
    },
  );

test(
  'X58: session control phrases never reach the model, while a request that merely contains the phrase does',
  { timeout: 60_000 },
  async (t) => {
    const ctx = await startCore(t, [response(wireJson())]);
    const wait = await say(ctx, 'ちょっと待って');
    assert.equal(wait.status, 200, wait.text);
    assert.equal(wait.json?.['status'], 'session_control');
    assert.equal(wait.json?.['session_control'], 'extend_silence');
    const end = await say(ctx, 'もう終わり');
    assert.equal(end.json?.['status'], 'session_control');
    assert.equal(ctx.adapter.commands.length, 0);
    assert.equal(ctx.log.admitted.length, 0);
    // 似た言い回しを含む依頼はモデルへ回る（会話は切れない）。
    const request = await say(ctx, '終わりの時間を教えて');
    assert.equal(request.status, 200, request.text);
    assert.notEqual(request.json?.['status'], 'session_control');
    assert.equal(ctx.adapter.commands.length, 1);
  },
);

test(
  'QA01·QA02·QA03: a bad or failed judgment becomes a clarification and creates no operation',
  { timeout: 60_000 },
  async (t) => {
    const bad: [string, FakeAdapterStep, string][] = [
      [
        'unknown intent',
        response(wireJson({ intent: 'wire_money' })),
        'うまく読み取れませんでした',
      ],
      ['null body', response('null'), 'うまく読み取れませんでした'],
      [
        'extra key',
        response(wireJson({ extra: 1 })),
        'うまく読み取れませんでした',
      ],
      [
        'refused',
        response('', { refused: true }),
        'うまく読み取れませんでした',
      ],
      ['timeout', { kind: 'timeout', usage: null }, '今は判定できませんでした'],
      [
        'unavailable',
        { kind: 'unavailable', usage: null },
        '今は判定できませんでした',
      ],
    ];
    for (const [name, step, text] of bad) {
      const ctx = await startCore(t, [step]);
      const reply = await say(ctx, '用事に歯医者の予約を追加して');
      assert.equal(reply.status, 200, `${name}: ${reply.text}`);
      assert.equal(reply.json?.['status'], 'clarification', name);
      assert.ok(String(reply.json?.['reply_text']).startsWith(text), name);
      // 失敗は依頼を作らず、操作も作らない。
      assert.equal(reply.json?.['result_view'], null, name);
      const snapshot = await getJson(ctx.core, ctx.device, '/v1/snapshot');
      assert.deepEqual(snapshot.json?.['operations'], [], name);
      assert.equal(ctx.adapter.commands.length, 1, name);
    }
  },
);

test(
  'a missing required argument is a clarification that keeps the intent (no execution)',
  { timeout: 60_000 },
  async (t) => {
    const ctx = await startCore(t, [
      response(
        wireJson({
          args: { ...emptyArgs },
          clarify_question: '用事の題名を教えてください',
        }),
      ),
    ]);
    const reply = await say(ctx, '用事を登録して');
    assert.equal(reply.json?.['status'], 'clarification');
    assert.equal(reply.json?.['reply_text'], '用事の題名を教えてください。');
    const view = reply.json?.['result_view'] as Record<string, unknown>;
    assert.equal(view['kind'], 'clarification');
    assert.equal(view['intent'], 'create_task');
    const snapshot = await getJson(ctx.core, ctx.device, '/v1/snapshot');
    assert.deepEqual(snapshot.json?.['operations'], []);
  },
);

test(
  'a valid judgment creates one awaiting operation, and a resend of the same request does not call the model again',
  { timeout: 60_000 },
  async (t) => {
    const ctx = await startCore(t, [response(wireJson())]);
    const requestId = randomUUID();
    const first = await say(ctx, '用事に歯医者の予約を追加して', requestId);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json?.['status'], 'answered');
    const view = first.json?.['result_view'] as Record<string, unknown>;
    // 自動実行は試験の方針表ですべて off: 承認待ち。
    assert.equal(view['kind'], 'approval_link');
    const again = await say(ctx, '用事に歯医者の予約を追加して', requestId);
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json, first.json);
    assert.equal(ctx.adapter.commands.length, 1);
    assert.equal(ctx.log.settled.length, 1);
    const snapshot = await getJson(ctx.core, ctx.device, '/v1/snapshot');
    assert.equal((snapshot.json?.['operations'] as unknown[]).length, 1);
  },
);

// ---- B10-04 P2a: 返答文 reply_text の通過と表示（U217 の本人決定 (b)。ADR 0106） --------------------------------------

test('the reply text of the model is passed through as plain data only when it is not null', async () => {
  const { guard } = fakeGuard();
  const talk = build(
    response(
      wireJson({
        intent: 'smalltalk',
        args: { ...emptyArgs },
        reply_text: 'こんにちは。',
      }),
    ),
    guard,
  );
  assert.deepEqual(await talk.interpreter.interpret(context('こんにちは')), {
    kind: 'intent',
    intent: 'smalltalk',
    args: { ...emptyArgs },
    relation: 'new',
    reply_text: 'こんにちは。',
  });
  // reply_text が null の判定は、項目を持たない（従来の返り値のまま）。
  const none = build(response(wireJson()), fakeGuard().guard);
  assert.deepEqual(await none.interpreter.interpret(context('用事を足して')), {
    kind: 'intent',
    intent: 'create_task',
    args: { ...emptyArgs, title: '歯医者の予約' },
    relation: 'new',
  });
});

test(
  'U217: with the real model path, a typed smalltalk is answered with the reply text, a link reply falls back to the fixed sentence, and a reply on an intent that may not carry one is rejected by the judgment itself',
  { timeout: 60_000 },
  async (t) => {
    const talk = (reply: string | null, intent = 'smalltalk') =>
      response(wireJson({ intent, args: { ...emptyArgs }, reply_text: reply }));
    const shown = await startCore(t, [
      talk('こんにちは。ゆっくりやりましょう。'),
    ]);
    const ok = await say(shown, 'こんにちは');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json?.['status'], 'answered');
    assert.equal(ok.json?.['reply_text'], 'こんにちは。ゆっくりやりましょう。');
    assert.equal(
      (ok.json?.['result_view'] as Record<string, unknown>)['kind'],
      'speech_bubble',
    );
    const link = await startCore(t, [talk('詳しくは https://example.com へ')]);
    const hidden = await say(link, 'こんにちは');
    assert.equal(hidden.json?.['status'], 'clarification');
    assert.equal(
      hidden.json?.['reply_text'],
      'その依頼にはまだ対応していません。',
    );
    // 表示の対象でない意図に返答文を付けた判定は、判定の層で意味の不正になり、実行へ進まない（従来の規則）。
    const wrong = await startCore(t, [
      response(wireJson({ reply_text: '用事を作りました。' })),
    ]);
    const refused = await say(wrong, '用事に歯医者の予約を追加して');
    assert.equal(refused.json?.['status'], 'clarification');
    assert(!refused.text.includes('用事を作りました'));
    const snapshot = await getJson(wrong.core, wrong.device, '/v1/snapshot');
    assert.deepEqual(snapshot.json?.['operations'], []);
  },
);
