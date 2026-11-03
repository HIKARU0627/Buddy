// 影モード（比較の記録）。B10-03 P3、ADR 0092。X48（記録しない会話では 0 件・300 件で止まる・会話に影響しない）。
// 比較モデルは ai の偽のアダプター（実 API・API キーなし）、保存先はメモリ上の偽。期待値は手で書いた値。
// 模擬の試験だけで、実機・実 API・実請求は未実施。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { IntentShadowRecord, ModelUsage } from '@buddy/contracts';
import { createFakeAdapter, syntheticProfile } from '@buddy/ai/testing';
import type { FakeAdapterStep } from '@buddy/ai/testing';
import { createApiContract, loadContractSchema } from './api-contract.js';
import { createShadowRecorder, SHADOW_MAX_INPUTS } from './shadow-mode.js';
import type {
  SaveShadowResult,
  ShadowEvent,
  ShadowObservation,
  ShadowRecordStore,
  ShadowSettings,
} from './shadow-mode.js';
import { createModelInterpreter } from './model-interpreter.js';
import type { ModelCallGuard } from './model-interpreter.js';
import { TEST_TURN_POLICY } from './turn-ports.js';
import type { InterpreterReply, ProviderReader } from './turn-ports.js';
import {
  bootstrap,
  getJson,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';

const contract = createApiContract();
const schema = loadContractSchema() as Record<string, unknown>;
const outputSchema = { ...schema, $ref: '#/$defs/WireResponse' };
const schemaValidator = {
  valid: (value: unknown) => contract.valid('WireResponse', value),
};

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-05T09:00:00+09:00');
const CAMPAIGN = '5b1f0c3e-2d4a-4e6b-8c7d-9a0b1c2d3e4f';
const PRIMARY_DEPLOYMENT = '6c2a1d4f-3e5b-4f7c-9d8e-0b1c2d3e4f5a';
const SHADOW_DEPLOYMENT = '7d3b2e5a-4f6c-4a8d-8e9f-1c2d3e4f5a6b';
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';

const usage: ModelUsage = {
  input_tokens: 900,
  cached_input_tokens: 0,
  output_tokens: 50,
  reasoning_tokens: null,
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
    confidence: 0.8,
    ...over,
  });
const response = (
  text: string,
  flags: { refused?: boolean; truncated?: boolean } = {},
): FakeAdapterStep => ({
  kind: 'response',
  text,
  usage,
  provider_request_id: 'req',
  refused: flags.refused ?? false,
  truncated: flags.truncated ?? false,
});

// メモリ上の保存先。上限の判定は保存と同じ処理の中で原子的に行う（同時の保存で 300 を超えない）。
function memoryStore(seed = 0) {
  const records: IntentShadowRecord[] = [];
  const preexisting = seed;
  const store: ShadowRecordStore = {
    count: () => Promise.resolve(preexisting + records.length),
    save(record, limit): Promise<SaveShadowResult> {
      if (
        records.some(
          (item) =>
            item.campaign_id === record.campaign_id &&
            item.input_id === record.input_id &&
            item.request_revision === record.request_revision,
        )
      )
        return Promise.resolve('duplicate');
      if (preexisting + records.length >= limit)
        return Promise.resolve('limit_reached');
      records.push(record);
      return Promise.resolve('saved');
    },
  };
  return { store, records };
}

function fakeGuard(deny = false) {
  const log = { admitted: 0, settled: [] as (ModelUsage | null)[] };
  const guard: ModelCallGuard = {
    admit() {
      if (deny) return Promise.resolve({ ok: false, reasons: ['pool_empty'] });
      log.admitted += 1;
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

const profile = syntheticProfile({
  profile_id: 'shadow-lite',
  role: 'intent',
  provider: 'gemini',
  reasoning: null,
  verified_capabilities: ['json_schema_strict'],
});

const settingsFor = (
  adapter: ReturnType<typeof createFakeAdapter>,
  over: Partial<ShadowSettings> = {},
): ShadowSettings => ({
  campaign_id: CAMPAIGN,
  primary_deployment_id: PRIMARY_DEPLOYMENT,
  started_at: '2026-10-01T00:00:00Z',
  max_inputs: SHADOW_MAX_INPUTS,
  max_spend: '1000000',
  max_days: 30,
  targets: [{ deployment_id: SHADOW_DEPLOYMENT, profile, adapter }],
  ...over,
});

const primaryReply: InterpreterReply = {
  kind: 'intent',
  intent: 'create_task',
  args: { ...emptyArgs, title: '歯医者の予約' },
  relation: 'new',
  elapsed_ms: 420,
};

let inputCounter = 0;
const observation = (
  over: Partial<ShadowObservation> = {},
): ShadowObservation => {
  inputCounter += 1;
  return {
    storage_mode: 'normal',
    live_session_open: false,
    input_id: `00000000-0000-4000-8000-${String(inputCounter).padStart(12, '0')}`,
    request_revision: '1',
    turn_expires_at: NOW + 7 * DAY,
    context: {
      text: '用事に歯医者の予約を追加して',
      today: '2026-10-05',
      mail_candidates: [
        { candidate_id: MAIL_CANDIDATE, remote_id: 'mail-001' },
      ],
    },
    primary: primaryReply,
    ...over,
  };
};

function recorder(options: {
  settings: ShadowSettings | null;
  store: ShadowRecordStore;
  slot?: boolean;
  deny?: boolean;
  spent?: string;
}) {
  const events: ShadowEvent[] = [];
  const { guard, log } = fakeGuard(options.deny === true);
  let tick = 0;
  const shadow = createShadowRecorder({
    settings: () => options.settings,
    store: options.store,
    slotAvailable: () => options.slot !== false,
    guard,
    spent: () => Promise.resolve(options.spent ?? '0'),
    contract,
    output_schema: outputSchema,
    schema: schemaValidator,
    now: () => {
      tick += 10;
      return NOW + tick;
    },
    newId: () => randomUUID(),
    onEvent: (event) => events.push(event),
  });
  return { shadow, events, log };
}

test('default OFF: with no settings nothing is called and nothing is recorded (D4)', async () => {
  const adapter = createFakeAdapter([response(wireJson())]);
  const memory = memoryStore();
  const { shadow, log } = recorder({ settings: null, store: memory.store });
  shadow.observe(observation());
  await shadow.idle();
  assert.equal(adapter.commands.length, 0);
  assert.equal(log.admitted, 0);
  assert.equal(memory.records.length, 0);
});

test('a normal conversation records one comparison without a body and never marks it used for execution', async () => {
  const adapter = createFakeAdapter([
    response(
      wireJson({
        intent: 'create_event',
        args: { ...emptyArgs, title: '面談', start: '2026-10-06T16:00:00' },
      }),
    ),
  ]);
  const memory = memoryStore();
  const { shadow, events, log } = recorder({
    settings: settingsFor(adapter),
    store: memory.store,
  });
  const seen = observation();
  shadow.observe(seen);
  await shadow.idle();
  assert.equal(adapter.commands.length, 1);
  assert.deepEqual(events, [{ kind: 'recorded', result: 'saved' }]);
  assert.equal(memory.records.length, 1);
  const record = memory.records[0] as IntentShadowRecord;
  assert.ok(contract.valid('IntentShadowRecord', record));
  assert.equal(record.schema, 'buddy.intent-shadow.v1');
  assert.equal(record.campaign_id, CAMPAIGN);
  assert.equal(record.input_id, seen.input_id);
  assert.equal(record.request_revision, '1');
  assert.equal(record.used_for_execution, false);
  // 本線と比較モデルの判定が並ぶ。
  assert.equal(record.primary.deployment_id, PRIMARY_DEPLOYMENT);
  assert.equal(record.primary.outcome, 'ok');
  assert.equal(record.primary.intent, 'create_task');
  assert.equal(record.primary.latency_ms, 420);
  assert.equal(record.shadows.length, 1);
  assert.equal(record.shadows[0]?.deployment_id, SHADOW_DEPLOYMENT);
  assert.equal(record.shadows[0]?.outcome, 'ok');
  assert.equal(record.shadows[0]?.intent, 'create_event');
  assert.equal(typeof record.shadows[0]?.latency_ms, 'number');
  // 発話の本文を記録に持たない。
  assert.ok(!JSON.stringify(record).includes('用事に歯医者の予約を追加して'));
  // 保存期限は会話全文と同じ（通常の会話は 7 日）。手で書いた期限（2026-10-12T09:00+09:00）と一致する。
  assert.equal(record.expires_at, '2026-10-12T00:00:00.000Z');
  assert.deepEqual(log.settled, [usage]);
});

test('an extended conversation keeps the record as long as the conversation text (30 days)', async () => {
  const adapter = createFakeAdapter([response(wireJson())]);
  const memory = memoryStore();
  const { shadow } = recorder({
    settings: settingsFor(adapter),
    store: memory.store,
  });
  shadow.observe(
    observation({ storage_mode: 'extended', turn_expires_at: NOW + 30 * DAY }),
  );
  await shadow.idle();
  const record = memory.records[0] as IntentShadowRecord;
  assert.equal(record.expires_at, '2026-11-04T00:00:00.000Z');
});

test('a slow comparison never extends the record past the conversation text; an already expired turn leaves no record', async () => {
  // 比較の完了が元の発言から遅れても、期限は発言の期限のまま（比較の完了時刻 + 7 日にしない）。
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = createFakeAdapter([response(wireJson())]);
  const slow = {
    commands: inner.commands,
    complete: async (command: Parameters<typeof inner.complete>[0]) => {
      await gate;
      return inner.complete(command);
    },
  };
  const memory = memoryStore();
  const clock = { value: NOW };
  const events: ShadowEvent[] = [];
  const shadow = createShadowRecorder({
    settings: () =>
      settingsFor(slow as unknown as ReturnType<typeof createFakeAdapter>),
    store: memory.store,
    slotAvailable: () => true,
    spent: () => Promise.resolve('0'),
    guard: fakeGuard().guard,
    contract,
    output_schema: outputSchema,
    schema: schemaValidator,
    now: () => clock.value,
    newId: () => randomUUID(),
    onEvent: (event) => events.push(event),
  });
  shadow.observe(observation({ turn_expires_at: NOW + 7 * DAY }));
  // 比較の待ちの間に 3 日たつ。
  clock.value = NOW + 3 * DAY;
  release();
  await shadow.idle();
  const record = memory.records[0] as IntentShadowRecord;
  assert.equal(record.recorded_at, '2026-10-08T00:00:00.000Z');
  assert.equal(record.expires_at, '2026-10-12T00:00:00.000Z');
  // 比較が終わる前に発言が失効していたら、記録を残さない。
  const lateMemory = memoryStore();
  clock.value = NOW;
  const lateInner = createFakeAdapter([response(wireJson())]);
  let lateRelease = (): void => undefined;
  const lateGate = new Promise<void>((resolve) => {
    lateRelease = resolve;
  });
  const lateShadow = createShadowRecorder({
    settings: () =>
      settingsFor({
        commands: lateInner.commands,
        complete: async (command: Parameters<typeof lateInner.complete>[0]) => {
          await lateGate;
          return lateInner.complete(command);
        },
      } as unknown as ReturnType<typeof createFakeAdapter>),
    store: lateMemory.store,
    slotAvailable: () => true,
    spent: () => Promise.resolve('0'),
    guard: fakeGuard().guard,
    contract,
    output_schema: outputSchema,
    schema: schemaValidator,
    now: () => clock.value,
    newId: () => randomUUID(),
    onEvent: (event) => events.push(event),
  });
  lateShadow.observe(observation({ turn_expires_at: NOW + 1 * DAY }));
  clock.value = NOW + 2 * DAY;
  lateRelease();
  await lateShadow.idle();
  assert.equal(lateMemory.records.length, 0);
  assert.deepEqual(events.at(-1), {
    kind: 'skipped',
    reasons: ['turn_expired'],
  });
});

test('X48: a private conversation runs no comparison and leaves 0 records', async () => {
  const adapter = createFakeAdapter([response(wireJson())]);
  const memory = memoryStore();
  const { shadow, events, log } = recorder({
    settings: settingsFor(adapter),
    store: memory.store,
  });
  shadow.observe(observation({ storage_mode: 'private' }));
  shadow.observe(observation({ storage_mode: 'unknown_mode' }));
  await shadow.idle();
  assert.equal(adapter.commands.length, 0);
  assert.equal(log.admitted, 0);
  assert.equal(memory.records.length, 0);
  assert.deepEqual(events, [
    { kind: 'skipped', reasons: ['private_conversation'] },
    { kind: 'skipped', reasons: ['private_conversation'] },
  ]);
});

test('an open voice connection, no spare capacity, or an empty budget skip the comparison without a record', async () => {
  const cases: [string, ShadowObservation, boolean, boolean, string[]][] = [
    [
      'live open',
      observation({ live_session_open: true }),
      true,
      false,
      ['live_session_open'],
    ],
    ['busy', observation(), false, false, ['no_capacity']],
    ['budget', observation(), true, true, ['shadow_budget']],
  ];
  for (const [name, seen, slot, deny, reasons] of cases) {
    const adapter = createFakeAdapter([response(wireJson())]);
    const memory = memoryStore();
    const { shadow, events } = recorder({
      settings: settingsFor(adapter),
      store: memory.store,
      slot,
      deny,
    });
    shadow.observe(seen);
    await shadow.idle();
    assert.equal(adapter.commands.length, 0, name);
    assert.equal(memory.records.length, 0, name);
    assert.deepEqual(events, [{ kind: 'skipped', reasons }], name);
  }
});

test('observe returns before the comparison finishes: a slow comparison model never delays the conversation', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 門が開くまで応答しない遅い比較モデル。
  const inner = createFakeAdapter([response(wireJson())]);
  const delayed = {
    commands: inner.commands,
    complete: async (command: Parameters<typeof inner.complete>[0]) => {
      await gate;
      return inner.complete(command);
    },
  };
  const memory = memoryStore();
  const { shadow } = recorder({
    settings: settingsFor(
      delayed as unknown as ReturnType<typeof createFakeAdapter>,
    ),
    store: memory.store,
  });
  shadow.observe(observation());
  // 比較はまだ終わっていない（observe は待たない）。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(memory.records.length, 0);
  release();
  await shadow.idle();
  assert.equal(memory.records.length, 1);
});

test('comparison failures are recorded as outcomes and never throw into the conversation', async () => {
  const steps: [string, FakeAdapterStep, string][] = [
    ['timeout', { kind: 'timeout', usage: null }, 'timeout'],
    ['unavailable', { kind: 'unavailable', usage: null }, 'unavailable'],
    ['refused', response('', { refused: true }), 'refused'],
    ['truncated', response('{"intent":', { truncated: true }), 'truncated'],
    ['invalid', response('not json'), 'invalid_output'],
    [
      'wrong type',
      response(wireJson({ confidence: 'high' })),
      'invalid_output',
    ],
    [
      'unclear',
      response(wireJson({ intent: 'unclear', args: { ...emptyArgs } })),
      'needs_clarification',
    ],
  ];
  for (const [name, step, outcome] of steps) {
    const adapter = createFakeAdapter([step]);
    const memory = memoryStore();
    const { shadow } = recorder({
      settings: settingsFor(adapter),
      store: memory.store,
    });
    shadow.observe(observation());
    await shadow.idle();
    assert.equal(memory.records.length, 1, name);
    assert.equal(memory.records[0]?.shadows[0]?.outcome, outcome, name);
    assert.equal(adapter.commands.length, 1, name);
  }
  // アダプターが例外を投げても、記録は unavailable で残り、予約は usage 不明として保持する。
  const throwing = createFakeAdapter([]);
  const memory = memoryStore();
  const { shadow, log } = recorder({
    settings: settingsFor(throwing),
    store: memory.store,
  });
  shadow.observe(observation());
  await shadow.idle();
  assert.equal(memory.records[0]?.shadows[0]?.outcome, 'unavailable');
  assert.deepEqual(log.settled, [null]);
});

test('X48: the comparison stops at 300 records, even with concurrent comparisons at 299', async () => {
  // 299 件の状態から、同時に 2 件が走る: 保存側の上限で 1 件だけが保存され、合計は 300 を超えない。
  const adapter = createFakeAdapter([
    response(wireJson()),
    response(wireJson()),
  ]);
  const memory = memoryStore(299);
  const { shadow, events } = recorder({
    settings: settingsFor(adapter),
    store: memory.store,
  });
  shadow.observe(observation());
  shadow.observe(observation());
  await shadow.idle();
  assert.equal(memory.records.length, 1);
  assert.deepEqual(
    events
      .map((event) => (event.kind === 'recorded' ? event.result : event.kind))
      .sort(),
    ['limit_reached', 'saved'],
  );
  assert.equal(await memory.store.count(CAMPAIGN), 300);
  // 300 件に達した後は、比較モデルを呼ばない。
  const before = adapter.commands.length;
  shadow.observe(observation());
  await shadow.idle();
  assert.equal(adapter.commands.length, before);
  assert.equal(memory.records.length, 1);
});

test('a context over the input limits is trimmed the same way for the comparison as for the primary', async () => {
  const candidates = Array.from({ length: 21 }, (_, index) => ({
    candidate_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '1')}`,
    remote_id: `mail-${index}`,
  }));
  const workflows = Array.from({ length: 6 }, (_, index) => ({
    workflow_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '2')}`,
    intent: null,
    state: 'in_flight' as const,
  }));
  const over = observation({
    context: {
      text: '一番目のメールを確認して',
      today: '2026-10-05',
      mail_candidates: candidates,
      open_workflows: workflows,
    },
  });
  // 本線: 同じ context を共通の入力生成で絞った送信内容。
  const primary = createFakeAdapter([response(wireJson())]);
  const interpreter = createModelInterpreter({
    adapter: primary,
    profile,
    output_schema: outputSchema,
    schema: schemaValidator,
    guard: fakeGuard().guard,
  });
  await interpreter.interpret(over.context);
  const adapter = createFakeAdapter([response(wireJson())]);
  const memory = memoryStore();
  const { shadow } = recorder({
    settings: settingsFor(adapter),
    store: memory.store,
  });
  shadow.observe(over);
  await shadow.idle();
  // 比較もモデルを呼び、入力の生成の差で invalid_output にならない。
  assert.equal(adapter.commands.length, 1);
  assert.deepEqual(
    adapter.commands[0]?.messages,
    primary.commands[0]?.messages,
  );
  const sent = adapter.commands[0]?.messages[1]?.content ?? '';
  assert.equal(sent.split('candidate_id=').length - 1, 20);
  assert.equal(sent.split('workflow_id=').length - 1, 5);
  assert.equal(memory.records[0]?.shadows[0]?.outcome, 'ok');
});

test('every target is judged on the same input and kept in one record; a target the budget refuses is recorded as skipped', async () => {
  const SECOND_DEPLOYMENT = '8e4c3f6b-5a7d-4b9e-9f0a-2d3e4f5a6b7c';
  const THIRD_DEPLOYMENT = '9f5d4a7c-6b8e-4c0f-8a1b-3e4f5a6b7c8d';
  const first = createFakeAdapter([response(wireJson())]);
  const second = createFakeAdapter([{ kind: 'timeout', usage: null }]);
  const third = createFakeAdapter([response(wireJson())]);
  const profileOf = (id: string) =>
    syntheticProfile({
      profile_id: id,
      role: 'intent',
      provider: 'gemini',
      reasoning: null,
      verified_capabilities: ['json_schema_strict'],
    });
  const settings = settingsFor(first, {
    targets: [
      {
        deployment_id: SHADOW_DEPLOYMENT,
        profile: profileOf('lite-a'),
        adapter: first,
      },
      {
        deployment_id: SECOND_DEPLOYMENT,
        profile: profileOf('lite-b'),
        adapter: second,
      },
      {
        deployment_id: THIRD_DEPLOYMENT,
        profile: profileOf('lite-c'),
        adapter: third,
      },
    ],
  });
  const memory = memoryStore();
  const settled: string[] = [];
  const shadow = createShadowRecorder({
    settings: () => settings,
    store: memory.store,
    slotAvailable: () => true,
    spent: () => Promise.resolve('0'),
    // lite-c だけ予算の口が拒否する。
    guard: {
      admit: (call) =>
        Promise.resolve(
          call.profile.profile_id === 'lite-c'
            ? { ok: false, reasons: ['pool_empty'] }
            : {
                ok: true,
                release: () => Promise.resolve(),
                settle: () => {
                  settled.push(call.profile.profile_id);
                  return Promise.resolve();
                },
              },
        ),
    },
    contract,
    output_schema: outputSchema,
    schema: schemaValidator,
    now: () => NOW,
    newId: () => randomUUID(),
  });
  shadow.observe(observation());
  await shadow.idle();
  assert.equal(memory.records.length, 1);
  const record = memory.records[0] as IntentShadowRecord;
  assert.deepEqual(
    record.shadows.map((item) => [item.deployment_id, item.outcome]),
    [
      [SHADOW_DEPLOYMENT, 'ok'],
      [SECOND_DEPLOYMENT, 'timeout'],
      [THIRD_DEPLOYMENT, 'skipped'],
    ],
  );
  // 呼ばれたのは受け付けられた 2 対象で、入力は同じ。拒否された対象は呼ばない。
  assert.equal(first.commands.length, 1);
  assert.equal(second.commands.length, 1);
  assert.equal(third.commands.length, 0);
  assert.deepEqual(first.commands[0]?.messages, second.commands[0]?.messages);
  assert.deepEqual(settled.sort(), ['lite-a', 'lite-b']);
});

test('a budget guard that throws for one target does not lose the other target', async () => {
  const OTHER = '8e4c3f6b-5a7d-4b9e-9f0a-2d3e4f5a6b7c';
  const good = createFakeAdapter([response(wireJson())]);
  const broken = createFakeAdapter([response(wireJson())]);
  const profileOf = (id: string) =>
    syntheticProfile({
      profile_id: id,
      role: 'intent',
      provider: 'gemini',
      reasoning: null,
      verified_capabilities: ['json_schema_strict'],
    });
  const settled: string[] = [];
  const memory = memoryStore();
  const events: ShadowEvent[] = [];
  const shadow = createShadowRecorder({
    settings: () =>
      settingsFor(good, {
        targets: [
          {
            deployment_id: SHADOW_DEPLOYMENT,
            profile: profileOf('ok-a'),
            adapter: good,
          },
          {
            deployment_id: OTHER,
            profile: profileOf('broken-b'),
            adapter: broken,
          },
        ],
      }),
    store: memory.store,
    slotAvailable: () => true,
    spent: () => Promise.resolve('0'),
    guard: {
      admit: (call) =>
        call.profile.profile_id === 'broken-b'
          ? Promise.reject(new Error('guard down'))
          : Promise.resolve({
              ok: true,
              release: () => Promise.resolve(),
              settle: () => {
                settled.push(call.profile.profile_id);
                return Promise.resolve();
              },
            }),
    },
    contract,
    output_schema: outputSchema,
    schema: schemaValidator,
    now: () => NOW,
    newId: () => randomUUID(),
    onEvent: (event) => events.push(event),
  });
  shadow.observe(observation());
  await shadow.idle();
  assert.equal(memory.records.length, 1);
  assert.deepEqual(
    memory.records[0]?.shadows.map((item) => [
      item.deployment_id,
      item.outcome,
    ]),
    [
      [SHADOW_DEPLOYMENT, 'ok'],
      [OTHER, 'unavailable'],
    ],
  );
  assert.equal(good.commands.length, 1);
  assert.equal(broken.commands.length, 0);
  assert.deepEqual(settled, ['ok-a']);
  assert.deepEqual(events, [{ kind: 'recorded', result: 'saved' }]);
});

test('without a way to read the spend the comparison never starts, so the spend limit cannot be bypassed', async () => {
  for (const [name, spent] of [
    ['missing', undefined],
    ['rejects', () => Promise.reject(new Error('ledger down'))],
    ['not a number', () => Promise.resolve('12.5')],
  ] as const) {
    const adapter = createFakeAdapter([response(wireJson())]);
    const memory = memoryStore();
    const events: ShadowEvent[] = [];
    const { guard, log } = fakeGuard();
    const shadow = createShadowRecorder({
      settings: () => settingsFor(adapter),
      store: memory.store,
      slotAvailable: () => true,
      spent: spent as never,
      guard,
      contract,
      output_schema: outputSchema,
      schema: schemaValidator,
      now: () => NOW,
      newId: () => randomUUID(),
      onEvent: (event) => events.push(event),
    });
    shadow.observe(observation());
    await shadow.idle();
    assert.equal(adapter.commands.length, 0, name);
    assert.equal(log.admitted, 0, name);
    assert.equal(memory.records.length, 0, name);
    assert.deepEqual(
      events,
      [{ kind: 'skipped', reasons: ['spent_unavailable'] }],
      name,
    );
  }
});

test('turning the shadow mode off while a reservation is pending sends nothing and releases the reservation', async () => {
  const adapter = createFakeAdapter([response(wireJson())]);
  const memory = memoryStore();
  const state = { on: true };
  const released: string[] = [];
  let finishAdmit = (): void => undefined;
  const pending = new Promise<void>((resolve) => {
    finishAdmit = resolve;
  });
  const events: ShadowEvent[] = [];
  const shadow = createShadowRecorder({
    settings: () => (state.on ? settingsFor(adapter) : null),
    store: memory.store,
    slotAvailable: () => true,
    spent: () => Promise.resolve('0'),
    guard: {
      admit: async () => {
        await pending;
        return {
          ok: true,
          settle: () => Promise.resolve(),
          release: () => {
            released.push('released');
            return Promise.resolve();
          },
        };
      },
    },
    contract,
    output_schema: outputSchema,
    schema: schemaValidator,
    now: () => NOW,
    newId: () => randomUUID(),
    onEvent: (event) => events.push(event),
  });
  shadow.observe(observation());
  // 受付を保留している間に、本人が影モードを OFF にする。
  await new Promise((resolve) => setImmediate(resolve));
  state.on = false;
  finishAdmit();
  await shadow.idle();
  assert.equal(adapter.commands.length, 0);
  assert.equal(memory.records.length, 0);
  assert.deepEqual(released, ['released']);
  assert.deepEqual(events, [{ kind: 'skipped', reasons: ['shadow_disabled'] }]);
  // 別の campaign に入れ替わった場合も送らない。
  const swapped = createFakeAdapter([response(wireJson())]);
  const state2 = { campaign: CAMPAIGN };
  let finish2 = (): void => undefined;
  const pending2 = new Promise<void>((resolve) => {
    finish2 = resolve;
  });
  const memory2 = memoryStore();
  const shadow2 = createShadowRecorder({
    settings: () => settingsFor(swapped, { campaign_id: state2.campaign }),
    store: memory2.store,
    slotAvailable: () => true,
    spent: () => Promise.resolve('0'),
    guard: {
      admit: async () => {
        await pending2;
        return {
          ok: true,
          settle: () => Promise.resolve(),
          release: () => Promise.resolve(),
        };
      },
    },
    contract,
    output_schema: outputSchema,
    schema: schemaValidator,
    now: () => NOW,
    newId: () => randomUUID(),
  });
  shadow2.observe(observation());
  await new Promise((resolve) => setImmediate(resolve));
  state2.campaign = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  finish2();
  await shadow2.idle();
  assert.equal(swapped.commands.length, 0);
  assert.equal(memory2.records.length, 0);
});

test('an input the primary refused to send (too long or blank) reserves nothing for the comparison', async () => {
  for (const [name, text] of [
    ['too long', 'あ'.repeat(2001)],
    ['blank', '   '],
  ] as const) {
    const adapter = createFakeAdapter([response(wireJson())]);
    const memory = memoryStore();
    const events: ShadowEvent[] = [];
    const { guard, log } = fakeGuard();
    const shadow = createShadowRecorder({
      settings: () => settingsFor(adapter),
      store: memory.store,
      slotAvailable: () => true,
      spent: () => Promise.resolve('0'),
      guard,
      contract,
      output_schema: outputSchema,
      schema: schemaValidator,
      now: () => NOW,
      newId: () => randomUUID(),
      onEvent: (event) => events.push(event),
    });
    shadow.observe(
      observation({
        context: { text, today: '2026-10-05', mail_candidates: [] },
        primary: {
          kind: 'failed',
          failure: 'invalid_semantics',
          retryable: false,
        },
      }),
    );
    await shadow.idle();
    assert.equal(adapter.commands.length, 0, name);
    // 予約（受付）も、使用量不明の精算も作らない。
    assert.equal(log.admitted, 0, name);
    assert.deepEqual(log.settled, [], name);
    assert.equal(memory.records.length, 0, name);
    assert.deepEqual(
      events,
      [{ kind: 'skipped', reasons: ['input_invalid'] }],
      name,
    );
  }
});

test('losing the spare capacity while a reservation is pending sends nothing and releases the reservation', async () => {
  const adapter = createFakeAdapter([response(wireJson())]);
  const memory = memoryStore();
  const state = { spare: true };
  const released: string[] = [];
  let finishAdmit = (): void => undefined;
  const pending = new Promise<void>((resolve) => {
    finishAdmit = resolve;
  });
  const events: ShadowEvent[] = [];
  const shadow = createShadowRecorder({
    settings: () => settingsFor(adapter),
    store: memory.store,
    slotAvailable: () => state.spare,
    spent: () => Promise.resolve('0'),
    guard: {
      admit: async () => {
        await pending;
        return {
          ok: true,
          settle: () => Promise.resolve(),
          release: () => {
            released.push('released');
            return Promise.resolve();
          },
        };
      },
    },
    contract,
    output_schema: outputSchema,
    schema: schemaValidator,
    now: () => NOW,
    newId: () => randomUUID(),
    onEvent: (event) => events.push(event),
  });
  shadow.observe(observation());
  await new Promise((resolve) => setImmediate(resolve));
  // 受付を待つ間に、本人の依頼（P0）が入って余力がなくなる。
  state.spare = false;
  finishAdmit();
  await shadow.idle();
  assert.equal(adapter.commands.length, 0);
  assert.equal(memory.records.length, 0);
  assert.deepEqual(released, ['released']);
  assert.deepEqual(events, [{ kind: 'skipped', reasons: ['no_capacity'] }]);
});

test('a configured limit above 300 is clamped to 300', async () => {
  const adapter = createFakeAdapter([response(wireJson())]);
  const memory = memoryStore(300);
  const { shadow, events } = recorder({
    settings: settingsFor(adapter, { max_inputs: 1000 }),
    store: memory.store,
  });
  shadow.observe(observation());
  await shadow.idle();
  assert.equal(adapter.commands.length, 0);
  assert.deepEqual(events, [
    { kind: 'skipped', reasons: ['campaign_stopped'] },
  ]);
});

test('the campaign also stops on the spend limit and on the day limit', async () => {
  for (const [name, over, spent] of [
    ['spend', {}, '1000000'],
    ['days', { started_at: '2026-08-01T00:00:00Z' }, '0'],
  ] as const) {
    const adapter = createFakeAdapter([response(wireJson())]);
    const memory = memoryStore();
    const { shadow, events } = recorder({
      settings: settingsFor(adapter, over),
      store: memory.store,
      spent,
    });
    shadow.observe(observation());
    await shadow.idle();
    assert.equal(adapter.commands.length, 0, name);
    assert.equal(memory.records.length, 0, name);
    assert.deepEqual(
      events,
      [{ kind: 'skipped', reasons: ['campaign_stopped'] }],
      name,
    );
  }
});

// --- HTTP の経路（会話への影響がないこと） ---

const provider: ProviderReader = {
  connection: () => Promise.resolve(null),
  readPermission: () => Promise.resolve(null),
  readTarget: () => Promise.resolve(null),
  listEvents: () => Promise.resolve([]),
};
const primaryAdapter = (): ReturnType<typeof createFakeAdapter> =>
  createFakeAdapter([response(wireJson())]);

async function startWith(
  t: test.TestContext,
  shadowSteps: FakeAdapterStep[] | null,
) {
  const memory = memoryStore();
  const adapter = createFakeAdapter(shadowSteps ?? []);
  const { shadow, events } = recorder({
    settings: shadowSteps === null ? null : settingsFor(adapter),
    store: memory.store,
  });
  const { guard } = fakeGuard();
  const primary = primaryAdapter();
  const core = await startEventCore(t, {
    previewValid: false,
    now: () => new Date(NOW),
    turns: {
      provider,
      interpreter: createModelInterpreter({
        adapter: primary,
        profile: syntheticProfile({
          profile_id: 'intent-primary',
          role: 'intent',
          provider: 'gemini',
        }),
        output_schema: outputSchema,
        schema: schemaValidator,
        guard,
      }),
      candidates: { mailCandidates: () => Promise.resolve([]) },
      policy: TEST_TURN_POLICY,
      utcOffset: '+09:00',
      onInterpreted: (event) =>
        shadow.observe({
          storage_mode: event.storage_mode,
          live_session_open: false,
          input_id: event.input_id,
          request_revision: event.request_revision,
          turn_expires_at: event.turn_expires_at,
          context: event.context,
          primary: event.primary,
        }),
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
  const session = String(created.json?.['session_id']);
  const say = (text: string, requestId: string = randomUUID()) =>
    postJson(core, device, `/v1/sessions/${session}/turns`, {
      request_id: requestId,
      command_scope_id: scope,
      text,
      input_kind: 'text',
    });
  return { core, device, say, memory, shadow, adapter, events, primary };
}

test(
  'X48: through the real turn path, a comparison is recorded once per new turn and the conversation response does not depend on it',
  { timeout: 60_000 },
  async (t) => {
    // 比較モデルが失敗しても、本線の応答は同じ（承認待ちの操作が 1 件）。
    const failing = await startWith(t, [{ kind: 'timeout', usage: null }]);
    const requestId = randomUUID();
    const first = await failing.say('用事に歯医者の予約を追加して', requestId);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json?.['status'], 'answered');
    const view = first.json?.['result_view'] as Record<string, unknown>;
    assert.equal(view['kind'], 'approval_link');
    await failing.shadow.idle();
    assert.equal(failing.memory.records.length, 1);
    const record = failing.memory.records[0] as IntentShadowRecord;
    assert.equal(record.input_id, first.json?.['input_id']);
    assert.equal(record.primary.intent, 'create_task');
    assert.equal(record.shadows[0]?.outcome, 'timeout');
    // 同じ要求の再送・会話の操作では比較を増やさない。
    const again = await failing.say('用事に歯医者の予約を追加して', requestId);
    assert.deepEqual(again.json, first.json);
    const control = await failing.say('ちょっと待って');
    assert.equal(control.json?.['status'], 'session_control');
    await failing.shadow.idle();
    assert.equal(failing.memory.records.length, 1);
    assert.equal(failing.adapter.commands.length, 1);
    const snapshot = await getJson(
      failing.core,
      failing.device,
      '/v1/snapshot',
    );
    assert.equal((snapshot.json?.['operations'] as unknown[]).length, 1);
  },
);

test(
  'default OFF through the real turn path: no comparison call and no record',
  { timeout: 60_000 },
  async (t) => {
    const off = await startWith(t, null);
    const reply = await off.say('用事に歯医者の予約を追加して');
    assert.equal(reply.status, 200, reply.text);
    await off.shadow.idle();
    assert.equal(off.memory.records.length, 0);
    assert.equal(off.adapter.commands.length, 0);
  },
);
