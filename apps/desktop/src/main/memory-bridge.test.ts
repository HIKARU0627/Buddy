// 忘却の画面の経路（MemoryBridge。UI-10、Issue #180、ADR 0183）の試験。接続は模擬（中枢への要求を記録して手で答える）で、
// 本人の確認（OS の確認ダイアログ）も模擬。期待値（表示用の値・送る本文・理由）は手で書いた合成の値。実データは使わない。
// 確かめること: 画面へ記憶 ID・計画 ID・指示 ID・操作 ID を渡さない、ゲートの閉と中枢の 503 を画面の状態に写す、計画の前は
// 何も消さない（実行の要求を送らない）、実行は確認の後に 1 回だけ送る、やめたら送らない、409 は計画を捨てて作り直させ自動では
// 作り直さない、結果が分からなければ「分からない」を残して送り直さない、世代をまたいだ値は反映しない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import type { DesktopIpcRejectReason } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { MemoryBridge } from './memory-bridge.js';
import type { ForgetConfirmRequest, MemoryHost } from './memory-bridge.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const SCOPE = uuid(0x5c);
const M1 = uuid(0xa01);
const M2 = uuid(0xa02);
const M3 = uuid(0xa03);
const PLAN = uuid(0xb01);
const DIRECTIVE = uuid(0xc01);
const OPERATION = uuid(0xd01);
const NOW = Date.parse('2030-11-04T09:00:00.000Z');

const item = (memoryId: string, text: string, fields = {}) => ({
  memory_id: memoryId,
  origin: 'explicit_request',
  kind: 'preference',
  text,
  status: 'active',
  created_at: '2030-10-01T00:00:00.000Z',
  review_at: '2030-12-30T00:00:00.000Z',
  delete_at: null,
  source_counts: { turn: 1, source_item: 0, memory: 0 },
  ...fields,
});

const listBody = (gate: 'open' | 'closed' = 'open', items?: unknown[]) => ({
  schema: 'buddy.memory-list.v1',
  forget_gate: gate,
  items: items ?? [
    item(M1, '返信は短めが好み'),
    item(M2, '短い返信の言い回し', {
      origin: 'auto_extraction',
      source_counts: { turn: 0, source_item: 0, memory: 1 },
    }),
    item(M3, '毎朝 7 時に散歩する', { kind: 'routine' }),
  ],
  truncated: false,
});

const planBody = (fields = {}) => ({
  schema: 'buddy.forget-plan-view.v1',
  plan_id: PLAN,
  target: { source_kind: 'memory', source_id: M1 },
  forgetting_generation: '3',
  expires_at: '2030-11-04T09:10:00.000Z',
  removed: {
    counts: [
      { kind: 'session_summary', count: 1 },
      { kind: 'memory', count: 2 },
      { kind: 'user_directive', count: 1 },
      { kind: 'operation_content', count: 1 },
    ],
    // M2 は一覧にある派生の記憶。もう 1 件は一覧にない記憶（上限の外など）。
    memory_ids: [M1, M2, uuid(0xa09)],
    directives: [
      {
        directive_id: DIRECTIVE,
        scope: 'from_now_on',
        text: '今後は返信を短めにして',
      },
    ],
  },
  kept: {
    operations: [{ operation_id: OPERATION, state: 'awaiting_approval' }],
    lineage_only: 1,
  },
  blocked_source_count: 1,
  ...fields,
});

const settingsBody = (kinds: string[], revision: string) => ({
  schema: 'buddy.memory-settings.v1',
  allowed_kinds: kinds,
  memory_settings_revision: revision,
});

type Outcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' }
  | { kind: 'not_sent'; reason: 'not_connected' };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly scoped?: boolean;
  readonly screenOperation?: boolean;
  readonly expectedScopeId?: string;
}

interface Rig {
  readonly bridge: MemoryBridge;
  readonly calls: Call[];
  readonly confirms: ForgetConfirmRequest[];
  list: () => Outcome;
  // 保存してよい記憶の種類の設定の読み取りと変更（ADR 0191）。
  settings: () => Outcome;
  settingsChange: () => Outcome;
  plan: () => Outcome;
  execute: () => Outcome;
  confirm: () => Promise<{ scope: string } | DesktopIpcRejectReason>;
  now: number;
  // 実行の送信の応答を、これが解けるまで待たせる（null なら待たせない）。
  executeGate: Promise<void> | null;
  executes(): Call[];
}

function rig(): Rig {
  const calls: Call[] = [];
  const confirms: ForgetConfirmRequest[] = [];
  const state: Rig = {
    calls,
    confirms,
    list: () => ({ kind: 'response', status: 200, body: listBody() }),
    settings: () => ({
      kind: 'response',
      status: 200,
      body: settingsBody([], '0'),
    }),
    settingsChange: () => ({
      kind: 'response',
      status: 200,
      body: settingsBody(['preference'], '1'),
    }),
    plan: () => ({ kind: 'response', status: 200, body: planBody() }),
    execute: () => ({
      kind: 'response',
      status: 200,
      body: {
        schema: 'buddy.forget-execute-result.v1',
        plan_id: PLAN,
        forgetting_generation: '4',
      },
    }),
    confirm: () => Promise.resolve({ scope: SCOPE }),
    now: NOW,
    executeGate: null,
    executes: () => calls.filter((call) => call.path.endsWith('/execute')),
    bridge: undefined as unknown as MemoryBridge,
  };
  const connection = {
    get state() {
      return { commandScopeId: SCOPE, phase: 'live' };
    },
    request: (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (call.path === '/v1/memory/settings')
        return Promise.resolve(
          call.method === 'GET' ? state.settings() : state.settingsChange(),
        );
      if (call.method === 'GET') return Promise.resolve(state.list());
      if (call.path === '/v1/memory/forget-plans')
        return Promise.resolve(state.plan());
      const gate = state.executeGate;
      if (gate !== null) return gate.then(() => state.execute());
      return Promise.resolve(state.execute());
    },
  } as unknown as ClientConnection;
  let counter = 0x100;
  const host: MemoryHost = {
    contract,
    connection: () => connection,
    newRef: () => uuid(counter++),
    now: () => state.now,
    confirm: (request) => {
      confirms.push(request);
      return state.confirm();
    },
    log: () => undefined,
  };
  return Object.assign(state, { bridge: new MemoryBridge(host) });
}

const ok = <T>(outcome: { ok: boolean; value?: T }): T => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.value as T;
};

const leaks = (value: unknown): string[] => {
  const text = JSON.stringify(value);
  return [M1, M2, M3, PLAN, DIRECTIVE, OPERATION, SCOPE].filter((id) =>
    text.includes(id),
  );
};

test('the list carries refs and display values only, and the gate is copied from the hub', async () => {
  const r = rig();
  r.list = () => ({ kind: 'response', status: 200, body: listBody('closed') });
  const view = ok(await r.bridge.list());
  assert(contract.valid('DesktopMemoryView', view));
  assert.deepEqual(leaks(view), []);
  assert.equal(view.forget, 'closed');
  assert.equal(view.fetch, 'loaded');
  assert.equal(view.plan, null);
  assert.deepEqual(
    view.entries.map((entry) => [entry.ref, entry.kind, entry.text]),
    [
      [uuid(0x100), 'preference', '返信は短めが好み'],
      [uuid(0x101), 'preference', '短い返信の言い回し'],
      [uuid(0x102), 'routine', '毎朝 7 時に散歩する'],
    ],
  );
  // 一覧と保存してよい種類の設定は本人の画面操作として読み、接続範囲は本文に入れない（GET）。
  assert.deepEqual(r.calls, [
    {
      method: 'GET',
      path: '/v1/memory/records',
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
    {
      method: 'GET',
      path: '/v1/memory/settings',
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  // 設定は種類と参照だけを渡し、版は渡さない（既定は空）。
  assert.deepEqual(
    (view.settings as { allowed_kinds: string[] } | null)?.allowed_kinds,
    [],
  );
  // 同じ記憶は読み直しても同じ参照。
  const again = ok(await r.bridge.list());
  assert.deepEqual(
    again.entries.map((entry) => entry.ref),
    [uuid(0x100), uuid(0x101), uuid(0x102)],
  );
});

test('a list that cannot be read is stale or unavailable, never an empty list', async () => {
  const r = rig();
  r.list = () => ({ kind: 'response', status: 503, body: {} });
  const first = ok(await r.bridge.list());
  assert.equal(first.fetch, 'unavailable');
  assert.equal(first.forget, 'unavailable');
  r.list = () => ({ kind: 'response', status: 200, body: listBody() });
  ok(await r.bridge.list());
  r.list = () => ({ kind: 'unknown' });
  const stale = ok(await r.bridge.list());
  assert.equal(stale.fetch, 'stale');
  assert.equal(stale.entries.length, 3);
});

test('a plan shows what goes and what stays by refs and counts, and nothing is executed', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  const view = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  assert(contract.valid('DesktopMemoryView', view));
  assert.deepEqual(leaks(view), []);
  assert.deepEqual(view.plan, {
    ref: uuid(0x103),
    target_ref: uuid(0x100),
    forgetting_generation: '3',
    expires_at: '2030-11-04T09:10:00.000Z',
    removed: {
      counts: [
        { kind: 'session_summary', count: 1 },
        { kind: 'memory', count: 2 },
        { kind: 'user_directive', count: 1 },
        { kind: 'operation_content', count: 1 },
      ],
      memory_refs: [uuid(0x100), uuid(0x101)],
      unlisted_memory_count: 1,
      // 指示は main の参照と本文・範囲だけ（指示 ID は出さない）。
      directives: [
        {
          ref: uuid(0x104),
          scope: 'from_now_on',
          text: '今後は返信を短めにして',
        },
      ],
    },
    kept: { operation_states: ['awaiting_approval'], lineage_only: 1 },
    blocked_source_count: 1,
  });
  // 計画を求めたのは記憶 ID だけで、実行の要求は送っていない。
  assert.deepEqual(r.calls.at(-1), {
    method: 'POST',
    path: '/v1/memory/forget-plans',
    body: { memory_id: M1 },
    scoped: true,
    screenOperation: true,
    expectedScopeId: SCOPE,
  });
  assert.equal(r.executes().length, 0);
  assert.equal(r.confirms.length, 0);
});

test('a 503 to the plan maps to forget_unavailable and the view says forgetting cannot be used until the next list', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  r.plan = () => ({
    kind: 'response',
    status: 503,
    body: { code: 'dependency_unavailable' },
  });
  assert.deepEqual(await r.bridge.plan(listed.entries[0]?.ref as string), {
    ok: false,
    reason: 'forget_unavailable',
  });
  assert.equal(r.bridge.view().forget, 'unavailable');
  assert.equal(r.bridge.view().plan, null);
  // 次に一覧を読めたら、中枢の値に戻す。
  const relisted = ok(await r.bridge.list());
  assert.equal(relisted.forget, 'open');
});

test('execute confirms once with the hub values, then sends the plan generation once and rereads', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  const planned = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  const planRef = planned.plan?.ref as string;
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody('open', [
      item(M3, '毎朝 7 時に散歩する', { kind: 'routine' }),
    ]),
  });
  const done = ok(await r.bridge.execute(planRef));
  assert.deepEqual(r.confirms, [
    {
      action: 'forget_memory',
      memoryText: '返信は短めが好み',
      removedTotal: 5,
      memoryCount: 3,
      directiveCount: 1,
      unreadableDirectiveCount: 0,
      keptOperations: 1,
    },
  ]);
  assert.deepEqual(r.executes(), [
    {
      method: 'POST',
      path: `/v1/memory/forget-plans/${PLAN}/execute`,
      body: { forgetting_generation: '3' },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(done.plan, null);
  assert.deepEqual(done.result, {
    outcome: 'forgotten',
    removed_total: 5,
    at: '2030-11-04T09:00:00.000Z',
  });
  assert.deepEqual(
    done.entries.map((entry) => entry.text),
    ['毎朝 7 時に散歩する'],
  );
  // 同じ計画は二度送らない（計画は捨てた）。
  assert.deepEqual(await r.bridge.execute(planRef), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(r.executes().length, 1);
});

test('declining the confirmation sends nothing and keeps the plan', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  const planned = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  r.confirm = () => Promise.resolve('confirmation_declined');
  assert.deepEqual(await r.bridge.execute(planned.plan?.ref as string), {
    ok: false,
    reason: 'confirmation_declined',
  });
  assert.equal(r.executes().length, 0);
  assert.equal(r.bridge.hasPlan(), true);
});

test('a 409 after the plan drops the plan, deletes nothing and does not replan or resend by itself', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  const planned = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  r.execute = () => ({
    kind: 'response',
    status: 409,
    body: { code: 'conflict' },
  });
  const plansBefore = r.calls.filter(
    (call) => call.path === '/v1/memory/forget-plans',
  ).length;
  assert.deepEqual(await r.bridge.execute(planned.plan?.ref as string), {
    ok: false,
    reason: 'preview_stale',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.bridge.hasPlan(), false);
  assert.equal(r.executes().length, 1);
  assert.equal(
    r.calls.filter((call) => call.path === '/v1/memory/forget-plans').length,
    plansBefore,
  );
  assert.equal(r.bridge.view().result, null);
});

test('an unknown outcome is kept as "may have been forgotten" and is never resent', async () => {
  for (const outcome of [
    { kind: 'unknown' },
    { kind: 'response', status: 503, body: { code: 'outcome_unknown' } },
    { kind: 'response', status: 500, body: {} },
    { kind: 'response', status: 200, body: { schema: 'wrong' } },
  ] as Outcome[]) {
    const r = rig();
    const listed = ok(await r.bridge.list());
    const planned = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
    r.execute = () => outcome;
    assert.deepEqual(await r.bridge.execute(planned.plan?.ref as string), {
      ok: false,
      reason: 'outcome_unknown',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const view = r.bridge.view();
    assert.equal(view.plan, null, JSON.stringify(outcome));
    assert.deepEqual(view.result, {
      outcome: 'outcome_unknown',
      removed_total: 5,
      at: '2030-11-04T09:00:00.000Z',
    });
    assert.equal(r.executes().length, 1, JSON.stringify(outcome));
    // 計画は捨てたので、同じ参照で押し直しても送らない。
    assert.deepEqual(await r.bridge.execute(planned.plan?.ref as string), {
      ok: false,
      reason: 'entry_not_found',
    });
    assert.equal(r.executes().length, 1);
  }
});

test('a 503 other than outcome_unknown on execute means nothing was deleted and forgetting is unavailable', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  const planned = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  r.execute = () => ({
    kind: 'response',
    status: 503,
    body: { code: 'dependency_unavailable' },
  });
  assert.deepEqual(await r.bridge.execute(planned.plan?.ref as string), {
    ok: false,
    reason: 'forget_unavailable',
  });
  const view = r.bridge.view();
  assert.equal(view.forget, 'unavailable');
  assert.equal(view.plan, null);
  assert.equal(view.result, null);
});

test('an old plan ref, an expired plan and a plan of a memory gone from the list are not sent', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  const first = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  const second = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  assert.notEqual(first.plan?.ref, second.plan?.ref);
  assert.deepEqual(await r.bridge.execute(first.plan?.ref as string), {
    ok: false,
    reason: 'preview_stale',
  });
  // 期限ちょうどは送らない。
  r.now = Date.parse('2030-11-04T09:10:00.000Z');
  assert.deepEqual(await r.bridge.execute(second.plan?.ref as string), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.equal(r.bridge.hasPlan(), false);
  r.now = NOW;
  const third = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  // 読み直したら対象の記憶が消えていた（期限・別の画面での忘却）。計画を出さない。
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody('open', [item(M3, '毎朝 7 時に散歩する')]),
  });
  ok(await r.bridge.list());
  assert.deepEqual(await r.bridge.execute(third.plan?.ref as string), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(r.confirms.length, 0);
  assert.equal(r.executes().length, 0);
});

test('a plan for another memory than asked is not shown; unknown refs are entry_not_found', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  r.plan = () => ({
    kind: 'response',
    status: 200,
    body: planBody({ target: { source_kind: 'memory', source_id: M3 } }),
  });
  assert.deepEqual(await r.bridge.plan(listed.entries[0]?.ref as string), {
    ok: false,
    reason: 'core_rejected',
  });
  assert.equal(r.bridge.hasPlan(), false);
  assert.deepEqual(await r.bridge.plan(uuid(0xfff)), {
    ok: false,
    reason: 'entry_not_found',
  });
});

test('a lock or disconnect during the confirmation sends nothing; a reset drops the list and the plan', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  const planned = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  r.confirm = () => {
    r.bridge.reset();
    return Promise.resolve({ scope: SCOPE });
  };
  assert.deepEqual(await r.bridge.execute(planned.plan?.ref as string), {
    ok: false,
    reason: 'not_connected',
  });
  assert.equal(r.executes().length, 0);
  const view = r.bridge.view();
  assert.equal(view.entries.length, 0);
  assert.equal(view.plan, null);
  assert.equal(view.fetch, 'unavailable');
});

test('a second execute of the same ref while the first is confirming or awaiting the response is refused without a dialog or a send', async () => {
  // 確認の待ちの間。
  const r = rig();
  const listed = ok(await r.bridge.list());
  const planned = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  const planRef = planned.plan?.ref as string;
  let answer: (value: { scope: string }) => void = () => undefined;
  r.confirm = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const first = r.bridge.execute(planRef);
  assert.deepEqual(await r.bridge.execute(planRef), {
    ok: false,
    reason: 'confirmation_pending',
  });
  assert.equal(r.confirms.length, 1);
  answer({ scope: SCOPE });
  assert.equal((await first).ok, true);
  assert.equal(r.confirms.length, 1);
  assert.equal(r.executes().length, 1);

  // 送信の応答の待ちの間（結果不明になっても、2 回目は送られない）。
  const q = rig();
  const listedQ = ok(await q.bridge.list());
  const plannedQ = ok(await q.bridge.plan(listedQ.entries[0]?.ref as string));
  const refQ = plannedQ.plan?.ref as string;
  let release: () => void = () => undefined;
  q.executeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  q.execute = () => ({ kind: 'unknown' }) as Outcome;
  const firstQ = q.bridge.execute(refQ);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.equal(q.executes().length, 1);
  assert.deepEqual(await q.bridge.execute(refQ), {
    ok: false,
    reason: 'confirmation_pending',
  });
  assert.equal(q.confirms.length, 1);
  assert.equal(q.executes().length, 1);
  release();
  assert.deepEqual(await firstQ, { ok: false, reason: 'outcome_unknown' });
  assert.equal(q.executes().length, 1);
  assert.equal(q.confirms.length, 1);
  // 終わった後は旗が下りている（計画は捨てたので entry_not_found）。
  assert.deepEqual(await q.bridge.execute(refQ), {
    ok: false,
    reason: 'entry_not_found',
  });
});

// ---- 消える指示の本文（U433、ADR 0185） ----

const DIRECTIVE_2 = uuid(0xc02);
const DIRECTIVE_3 = uuid(0xc03);

test('the plan passes each disappearing directive as a ref with its text and scope, unreadable ones as null, and the confirmation counts them', async () => {
  const r = rig();
  const long = '長'.repeat(200);
  r.plan = () => ({
    kind: 'response',
    status: 200,
    body: planBody({
      removed: {
        counts: [
          { kind: 'memory', count: 1 },
          { kind: 'user_directive', count: 3 },
        ],
        memory_ids: [M1],
        directives: [
          { directive_id: DIRECTIVE, scope: 'from_now_on', text: long },
          { directive_id: DIRECTIVE_2, scope: 'this_time', text: null },
          {
            directive_id: DIRECTIVE_3,
            scope: 'this_time',
            text: 'この会話では敬語をやめて',
          },
        ],
      },
    }),
  });
  const listed = ok(await r.bridge.list());
  const view = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  assert(contract.valid('DesktopMemoryView', view));
  assert.deepEqual(view.plan?.removed.directives, [
    { ref: uuid(0x104), scope: 'from_now_on', text: long },
    { ref: uuid(0x105), scope: 'this_time', text: null },
    { ref: uuid(0x106), scope: 'this_time', text: 'この会話では敬語をやめて' },
  ]);
  const text = JSON.stringify(view);
  for (const id of [DIRECTIVE, DIRECTIVE_2, DIRECTIVE_3, PLAN, M1])
    assert(!text.includes(id), id);
  // 同じ計画を見ている間は、指示の参照を変えない。
  assert.deepEqual(
    r.bridge.view().plan?.removed.directives.map((item) => item.ref),
    [uuid(0x104), uuid(0x105), uuid(0x106)],
  );
  // 確認には、指示の数と本文を読めない指示の数を渡す（本文は画面で見せる）。
  ok(await r.bridge.execute(view.plan?.ref as string));
  assert.deepEqual(r.confirms, [
    {
      action: 'forget_memory',
      memoryText: '返信は短めが好み',
      removedTotal: 4,
      memoryCount: 1,
      directiveCount: 3,
      unreadableDirectiveCount: 1,
      keptOperations: 1,
    },
  ]);
});

test('a plan whose directive carries a raw id field or a too long text is not shown', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  for (const directive of [
    {
      directive_id: DIRECTIVE,
      scope: 'from_now_on',
      text: '今後は返信を短めにして',
      turn_id: uuid(0xe01),
    },
    { directive_id: DIRECTIVE, scope: 'from_now_on', text: '長'.repeat(201) },
    { directive_id: DIRECTIVE, scope: 'from_now_on', text: '' },
  ]) {
    r.plan = () => ({
      kind: 'response',
      status: 200,
      body: planBody({
        removed: {
          counts: [{ kind: 'memory', count: 1 }],
          memory_ids: [M1],
          directives: [directive],
        },
      }),
    });
    assert.deepEqual(
      await r.bridge.plan(listed.entries[0]?.ref as string),
      { ok: false, reason: 'core_rejected' },
      JSON.stringify(directive).slice(0, 80),
    );
    assert.equal(r.bridge.view().plan, null);
  }
  assert.equal(r.executes().length, 0);
});

test('directive texts reach the screen without control, bidi or zero-width characters, and a text that is only such characters is unreadable', async () => {
  const r = rig();
  const listed = ok(await r.bridge.list());
  r.plan = () => ({
    kind: 'response',
    status: 200,
    body: planBody({
      removed: {
        counts: [
          { kind: 'memory', count: 1 },
          { kind: 'user_directive', count: 2 },
        ],
        memory_ids: [M1],
        directives: [
          {
            directive_id: DIRECTIVE,
            scope: 'from_now_on',
            text: '今後は\n\u202e返信を\u200b短めに\tして',
          },
          {
            directive_id: uuid(0xc02),
            scope: 'this_time',
            text: '\u202e\u200b\n',
          },
        ],
      },
    }),
  });
  const view = ok(await r.bridge.plan(listed.entries[0]?.ref as string));
  assert(contract.valid('DesktopMemoryView', view));
  assert.deepEqual(
    view.plan?.removed.directives.map((directive) => directive.text),
    ['今後は 返信を 短めに して', null],
  );
});

// ---- 保存してよい記憶の種類の設定（ADR 0191） ----

const settingsOf = (view: { readonly settings: unknown }) =>
  view.settings as { readonly ref: string; readonly allowed_kinds: string[] };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

test('ADR 0191: a settings change sends every allowed kind with the revision main holds and shows only the kinds and a reference', async () => {
  const r = rig();
  r.settings = () => ({
    kind: 'response',
    status: 200,
    body: settingsBody(['goal'], '4'),
  });
  const listed = ok(await r.bridge.list());
  assert.deepEqual(settingsOf(listed).allowed_kinds, ['goal']);
  const ref = settingsOf(listed).ref;
  assert.match(ref, UUID);
  // 同じ版の読み直しでは参照を変えない。
  assert.equal(settingsOf(ok(await r.bridge.list())).ref, ref);
  r.settingsChange = () => ({
    kind: 'response',
    status: 200,
    body: settingsBody(['preference', 'goal'], '5'),
  });
  const changed = ok(
    await r.bridge.changeSettings(ref, ['preference', 'goal']),
  );
  assert(contract.valid('DesktopMemoryView', changed));
  assert.deepEqual(settingsOf(changed).allowed_kinds, ['preference', 'goal']);
  // 版が変わったので参照も変わる。
  assert.notEqual(settingsOf(changed).ref, ref);
  assert(changed.list_seq > listed.list_seq);
  // 版は main が付ける（画面は版を送らない・受け取らない）。
  assert.deepEqual(r.calls.at(-1), {
    method: 'POST',
    path: '/v1/memory/settings',
    body: {
      expected_memory_settings_revision: '4',
      allowed_kinds: ['preference', 'goal'],
    },
    scoped: true,
    screenOperation: true,
    expectedScopeId: SCOPE,
  });
  assert(!JSON.stringify(changed).includes('settings_revision'));
});

test('ADR 0191: a stale revision or an unknown outcome is not re-sent; the settings are read again', async () => {
  const r = rig();
  r.settings = () => ({
    kind: 'response',
    status: 200,
    body: settingsBody([], '2'),
  });
  const ref = settingsOf(ok(await r.bridge.list())).ref;
  r.settingsChange = () => ({ kind: 'response', status: 409, body: {} });
  // 別の画面で変わっていた: 読み直した後の値は中枢の今の値。
  r.settings = () => ({
    kind: 'response',
    status: 200,
    body: settingsBody(['person'], '3'),
  });
  assert.deepEqual(await r.bridge.changeSettings(ref, ['goal']), {
    ok: false,
    reason: 'preview_stale',
  });
  await r.bridge.refresh();
  assert.deepEqual(settingsOf(r.bridge.view()).allowed_kinds, ['person']);
  const posts = () =>
    r.calls.filter(
      (call) => call.method === 'POST' && call.path === '/v1/memory/settings',
    ).length;
  assert.equal(posts(), 1);
  r.settingsChange = () => ({ kind: 'unknown' });
  assert.deepEqual(
    await r.bridge.changeSettings(settingsOf(r.bridge.view()).ref, ['goal']),
    { ok: false, reason: 'outcome_unknown' },
  );
  await r.bridge.refresh();
  // 自動では送り直さない（送ったのは押した 2 回だけ）。
  assert.equal(posts(), 2);
});

test('ADR 0191 review: after a 409 main reads the new revision first; a change made from the old screen is refused without sending and does not overwrite the other change', async () => {
  const r = rig();
  r.settings = () => ({
    kind: 'response',
    status: 200,
    body: settingsBody(['goal'], '2'),
  });
  // 画面が見ている設定（版 2・目標だけ）。
  const shownRef = settingsOf(ok(await r.bridge.list())).ref;
  // 別の端末が人を足した（中枢は版 3）。この端末の変更は 409 で、main は先に読み直して版 3 を持つ。
  r.settingsChange = () => ({ kind: 'response', status: 409, body: {} });
  r.settings = () => ({
    kind: 'response',
    status: 200,
    body: settingsBody(['goal', 'person'], '3'),
  });
  assert.deepEqual(
    await r.bridge.changeSettings(shownRef, ['preference', 'goal']),
    { ok: false, reason: 'preview_stale' },
  );
  await r.bridge.refresh();
  // 画面はまだ古い表示（目標だけ）のまま、もう一度押した: 古い表示から作った全部（好み・目標。人がない）は送らない。
  r.settingsChange = () => ({
    kind: 'response',
    status: 200,
    body: settingsBody(['preference', 'goal'], '4'),
  });
  assert.deepEqual(
    await r.bridge.changeSettings(shownRef, ['preference', 'goal']),
    { ok: false, reason: 'preview_stale' },
  );
  const posts = r.calls.filter(
    (call) => call.method === 'POST' && call.path === '/v1/memory/settings',
  );
  assert.equal(posts.length, 1);
  assert.deepEqual(settingsOf(r.bridge.view()).allowed_kinds, [
    'goal',
    'person',
  ]);
  // 画面が新しい表示（参照）を受け取ってから押せば送る。
  const fresh = settingsOf(r.bridge.view()).ref;
  assert.notEqual(fresh, shownRef);
  const changed = ok(
    await r.bridge.changeSettings(fresh, ['preference', 'goal', 'person']),
  );
  assert.deepEqual(r.calls.at(-1)?.body, {
    expected_memory_settings_revision: '3',
    allowed_kinds: ['preference', 'goal', 'person'],
  });
  assert.deepEqual(settingsOf(changed).allowed_kinds, ['preference', 'goal']);
});

test('ADR 0191: settings that were never read cannot be changed, unreadable settings keep the last value, and a reset drops them', async () => {
  const r = rig();
  r.settings = () => ({ kind: 'response', status: 503, body: {} });
  const first = ok(await r.bridge.list());
  // 読めたことがない設定は null（「何も許可していない」と区別する）。変更は送らない。
  assert.equal(first.settings, null);
  assert.deepEqual(
    await r.bridge.changeSettings('00000000-0000-4000-8000-000000000999', [
      'goal',
    ]),
    { ok: false, reason: 'entry_not_found' },
  );
  assert.equal(r.calls.filter((call) => call.method === 'POST').length, 0);
  r.settings = () => ({
    kind: 'response',
    status: 200,
    body: settingsBody(['lexicon'], '1'),
  });
  ok(await r.bridge.list());
  // 次に読めなかった: 前の値のまま。
  r.settings = () => ({ kind: 'unknown' });
  assert.deepEqual(settingsOf(ok(await r.bridge.list())).allowed_kinds, [
    'lexicon',
  ]);
  // ロック・切断: 捨てる。
  r.bridge.reset();
  assert.equal(r.bridge.view().settings, null);
});
