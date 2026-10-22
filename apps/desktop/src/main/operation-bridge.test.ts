// OperationBridge の試験（B04-05、ADR 0031）。中枢と接続の代わりに、決まった応答を返す模擬を差し込む。
// 期待値は試験に手で書いた値で、検査対象の関数から作っていない。中枢との実際のやり取りは two-clients.test.ts。
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import type { OperationIntent, OperationSnapshot } from '@buddy/contracts';
import type { ClientConnection } from '@buddy/client';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { OperationBridge, previewView } from './operation-bridge.js';
import type {
  OperationConfirmRequest,
  OperationConfirmResult,
} from './operation-bridge.js';

// 各試験に時間切れを付ける。
const test = (name: string, fn: () => void | Promise<void>) =>
  nodeTest(name, { timeout: 10_000 }, fn);

const contract = createDesktopContract(loadContractSchema());
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const HASH = 'ab'.repeat(32);
const SCOPE = id(0x5c);
const OP = id(0x101);

const snapshot = (
  overrides: Partial<OperationSnapshot> = {},
): OperationSnapshot => ({
  operation_id: OP,
  operation_kind: 'task.create',
  content_version: '1',
  content_hash: HASH,
  state_revision: '1',
  state: 'awaiting_approval',
  approval_state: 'none',
  allowed_actions: ['preview', 'approve', 'cancel'],
  result: null,
  ...overrides,
});

const taskIntent: OperationIntent = {
  schema: 'buddy.operation.v1',
  operation_id: OP,
  content_version: '1',
  permission_revision: '0',
  target: { list_id: 'inbox' },
  action: {
    kind: 'task.create',
    title: '牛乳を買う',
    due: '2030-10-06',
    body: null,
  },
  effects: { external_recipients: [], reconcile_scope: 'local_transaction' },
};

type Reply =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' }
  | { kind: 'not_sent'; reason: 'not_connected' };

interface Harness {
  bridge: OperationBridge;
  readonly requests: { path: string; body: unknown }[];
  readonly sent: unknown[];
  readonly confirms: OperationConfirmRequest[];
  readonly changed: { count: number };
  operations: OperationSnapshot[];
  replies: Reply[];
  sendOutcome: unknown;
  confirm: () => OperationConfirmResult | Promise<OperationConfirmResult>;
  // 確認の最中に呼ぶ（確かめている間に操作が変わった状況を作る）。
  duringConfirm: () => void;
}

function harness(): Harness {
  let refs = 0x900;
  const h: Harness = {
    bridge: undefined as unknown as OperationBridge,
    requests: [],
    sent: [],
    confirms: [],
    changed: { count: 0 },
    operations: [snapshot()],
    replies: [],
    sendOutcome: {
      kind: 'accepted',
      requestId: id(1),
      receipt: { status: 'accepted' },
    },
    confirm: () => ({ scope: SCOPE }),
    duringConfirm: () => undefined,
  };
  const connection = {
    get state() {
      return { commandScopeId: SCOPE, operations: h.operations };
    },
    request(request: { path: string; body?: unknown }) {
      h.requests.push({ path: request.path, body: request.body });
      return Promise.resolve(h.replies.shift() ?? { kind: 'unknown' });
    },
    send(command: unknown) {
      h.sent.push(command);
      return Promise.resolve(h.sendOutcome);
    },
  } as unknown as ClientConnection;
  h.bridge = new OperationBridge({
    contract,
    connection: () => connection,
    newRef: () => id(refs++),
    confirm: async (request) => {
      h.confirms.push(request);
      h.duringConfirm();
      return h.confirm();
    },
    changed: () => {
      h.changed.count += 1;
    },
    log: () => undefined,
  });
  return h;
}

const previewReply = (
  intent: OperationIntent = taskIntent,
  revision = '1',
): Reply => ({
  kind: 'response',
  status: 200,
  body: {
    preview_id: id(0x777),
    intent,
    content_hash: HASH,
    state_revision: revision,
  },
});

async function openPreview(h: Harness) {
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  h.replies.push(previewReply());
  const result = await h.bridge.preview(ref);
  assert(result.ok);
  return { ref, preview: result.value };
}

test('entries give references, not operation IDs, and show the newest operation first', () => {
  const h = harness();
  h.operations = [
    snapshot({ operation_id: id(0x201) }),
    snapshot({
      operation_id: id(0x202),
      state: 'succeeded',
      allowed_actions: [],
    }),
  ];
  const first = h.bridge.entries(h.operations);
  assert.equal(first.length, 2);
  // 最初に見た順の逆（後から現れた操作が先）。参照は呼び出しをまたいで同じ。
  assert.equal(first[0]?.state, 'succeeded');
  const again = h.bridge.entries(h.operations);
  assert.deepEqual(
    again.map((entry) => entry.ref),
    first.map((entry) => entry.ref),
  );
  const shown = JSON.stringify(first);
  for (const value of [id(0x201), id(0x202), HASH])
    assert.equal(shown.includes(value), false);
  // 消えた操作の参照は捨てる（同じ ID が戻ってきても別の参照）。
  h.bridge.entries([]);
  assert.notEqual(
    h.bridge.entries([snapshot({ operation_id: id(0x201) })])[0]?.ref,
    first[1]?.ref,
  );
});

test('previewView lists what changes for each operation kind without IDs or hashes', () => {
  const labelsIntent: OperationIntent = {
    schema: 'buddy.operation.v1',
    operation_id: OP,
    content_version: '1',
    permission_revision: '0',
    provider: 'mock',
    account_id: id(0xa1),
    target: { remote_id: 'mail-001', source_revision: '3' },
    action: { kind: 'mail.labels.change', add: ['follow-up'], remove: [] },
    effects: { external_recipients: [], reconcile_scope: 'exact_target' },
  };
  const labels = previewView(labelsIntent, id(0x1));
  assert.deepEqual(labels, {
    preview_ref: id(0x1),
    operation_kind: 'mail.labels.change',
    service: 'mock',
    target: 'mail-001',
    fields: [{ field: 'labels_add', values: ['follow-up'] }],
  });
  const draftIntent: OperationIntent = {
    schema: 'buddy.operation.v1',
    operation_id: OP,
    content_version: '1',
    permission_revision: '0',
    provider: 'mock',
    account_id: id(0xa1),
    target: { remote_id: 'mail-001', source_revision: '3' },
    action: {
      kind: 'mail.draft.create',
      to: ['a@example.com'],
      cc: [],
      subject: '件名',
      body: '本文',
    },
    effects: { external_recipients: [], reconcile_scope: 'operation_marker' },
  };
  const draft = previewView(draftIntent, id(0x2));
  assert.deepEqual(
    draft.fields.map((entry) => entry.field),
    ['draft_to', 'draft_subject', 'draft_body'],
  );
  const task = previewView(taskIntent, id(0x3));
  assert.deepEqual(task, {
    preview_ref: id(0x3),
    operation_kind: 'task.create',
    service: 'buddy',
    target: 'inbox',
    fields: [
      { field: 'task_title', values: ['牛乳を買う'] },
      { field: 'task_due', values: ['2030-10-06'] },
    ],
  });
  const shown = JSON.stringify([labels, draft, task]);
  for (const value of [id(0xa1), id(0x101), HASH, 'account_id', 'content_hash'])
    assert.equal(shown.includes(value), false, value);
});

test('a schedule answer becomes counts only: no event IDs reach the screen', async () => {
  const h = harness();
  const events = [id(0x31), id(0x32), id(0x33)];
  h.replies.push(
    {
      kind: 'response',
      status: 201,
      body: {
        request_id: id(1),
        session_id: id(0x44),
        storage_mode: 'normal',
        route_revision: '0',
      },
    },
    {
      kind: 'response',
      status: 200,
      body: {
        request_id: id(2),
        session_id: id(0x44),
        turn_id: id(0x45),
        input_id: id(0x46),
        workflow_id: id(0x47),
        status: 'answered',
        reply_text: null,
        result_view: {
          workflow_id: id(0x47),
          request_revision: '1',
          intent: 'query_schedule',
          kind: 'schedule_cards',
          status: 'needs_review',
          item_refs: [
            ...events.map((event) => ({ kind: 'calendar_event', id: event })),
            { kind: 'calendar_overlap', id: events[0] },
            { kind: 'calendar_overlap', id: events[1] },
          ],
          more_count: 4,
          template_id: null,
          template_version: null,
        },
      },
    },
  );
  const result = await h.bridge.submitTurn('今日の予定を見せて');
  assert(result.ok);
  assert.deepEqual(result.value, {
    status: 'answered',
    reply_text: null,
    result: {
      kind: 'schedule_cards',
      status: 'needs_review',
      intent: 'query_schedule',
      event_count: 3,
      overlap_count: 2,
      more_count: 4,
      operation_ref: null,
    },
  });
  const shown = JSON.stringify(result.value);
  for (const value of [...events, id(0x44), id(0x47)])
    assert.equal(shown.includes(value), false);
  // 会話は接続範囲ごとに 1 つ。2 回目の発言では作らない。
  assert.deepEqual(
    h.requests.map((request) => request.path),
    ['/v1/sessions', `/v1/sessions/${id(0x44)}/turns`],
  );
});

test('a turn that created an operation points to it by the same reference the list uses', async () => {
  const h = harness();
  h.replies.push(
    {
      kind: 'response',
      status: 201,
      body: {
        request_id: id(1),
        session_id: id(0x44),
        storage_mode: 'normal',
        route_revision: '0',
      },
    },
    {
      kind: 'response',
      status: 200,
      body: {
        request_id: id(2),
        session_id: id(0x44),
        turn_id: id(0x45),
        input_id: id(0x46),
        workflow_id: id(0x47),
        status: 'answered',
        reply_text: null,
        result_view: {
          workflow_id: id(0x47),
          request_revision: '1',
          intent: 'create_task',
          kind: 'approval_link',
          status: 'needs_review',
          item_refs: [{ kind: 'operation', id: OP }],
          more_count: 0,
          template_id: null,
          template_version: null,
        },
      },
    },
  );
  const result = await h.bridge.submitTurn('「牛乳を買う」を用事に登録して');
  assert(result.ok);
  // 操作がまだ一覧に現れていなくても参照を渡し、現れたら同じ参照になる。
  const ref = result.value.result?.operation_ref;
  assert.match(String(ref), /^00000000-0000-4000-8000-/u);
  assert.equal(h.bridge.entries(h.operations)[0]?.ref, ref);
});

test('a turn whose outcome is unknown is not resent; a conflict drops the conversation so the next one starts anew', async () => {
  const h = harness();
  const session: Reply = {
    kind: 'response',
    status: 201,
    body: {
      request_id: id(1),
      session_id: id(0x44),
      storage_mode: 'normal',
      route_revision: '0',
    },
  };
  h.replies.push(session, { kind: 'unknown' });
  const unknown = await h.bridge.submitTurn('こんにちは');
  assert.deepEqual(unknown, { ok: false, reason: 'outcome_unknown' });
  assert.equal(h.requests.length, 2);
  // 会話が中枢にない（409）: 会話を捨て、次の発言で作り直す。
  h.replies.push({ kind: 'response', status: 409, body: {} });
  const conflict = await h.bridge.submitTurn('こんにちは');
  assert.deepEqual(conflict, { ok: false, reason: 'core_rejected' });
  h.replies.push(session, { kind: 'unknown' });
  await h.bridge.submitTurn('こんにちは');
  assert.equal(
    h.requests.filter((request) => request.path === '/v1/sessions').length,
    2,
  );
  // 会話の作成で結果が分からないときは、発言を送っていない。
  const fresh = harness();
  fresh.replies.push({ kind: 'unknown' });
  assert.deepEqual(await fresh.bridge.submitTurn('こんにちは'), {
    ok: false,
    reason: 'not_connected',
  });
  assert.equal(fresh.requests.length, 1);
});

test("approve asks main for one confirmation with main's own values and sends once with the previewed versions", async () => {
  const h = harness();
  const { preview } = await openPreview(h);
  const result = await h.bridge.approve(preview.preview_ref);
  assert.deepEqual(result, { ok: true, value: 'accepted' });
  assert.deepEqual(h.confirms, [
    {
      action: 'approve_operation',
      operationKind: 'task.create',
      service: 'buddy',
      target: 'inbox',
      fields: [
        { field: 'task_title', values: ['牛乳を買う'] },
        { field: 'task_due', values: ['2030-10-06'] },
      ],
    },
  ]);
  assert.deepEqual(h.sent, [
    {
      kind: 'approve',
      operationId: OP,
      previewId: id(0x777),
      contentVersion: '1',
      contentHash: HASH,
      expectedStateRevision: '1',
      commandScopeId: SCOPE,
    },
  ]);
  // 確認は使い切り。同じ参照では二度目の確認を出さない。
  assert.deepEqual(await h.bridge.approve(preview.preview_ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(h.confirms.length, 1);
  assert.equal(h.sent.length, 1);
});

test('approve does not send when the person declines, the dialog is closed, or the content changed meanwhile', async () => {
  const declined = harness();
  const first = await openPreview(declined);
  declined.confirm = () => 'confirmation_declined';
  assert.deepEqual(await declined.bridge.approve(first.preview.preview_ref), {
    ok: false,
    reason: 'confirmation_declined',
  });
  assert.equal(declined.sent.length, 0);

  // 確かめている間に内容（hash）が変わった: 確かめた内容と違うので送らない。
  const changed = harness();
  const second = await openPreview(changed);
  changed.duringConfirm = () => {
    changed.operations = [
      snapshot({ content_hash: 'cd'.repeat(32), content_version: '2' }),
    ];
  };
  assert.deepEqual(await changed.bridge.approve(second.preview.preview_ref), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.equal(changed.sent.length, 0);

  // 確認の前に状態が進んでいた（版が新しい）: 確認も出さない。
  const moved = harness();
  const third = await openPreview(moved);
  moved.operations = [snapshot({ state_revision: '2' })];
  assert.deepEqual(await moved.bridge.approve(third.preview.preview_ref), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.equal(moved.confirms.length, 0);

  // 承認待ちでなくなった（取り消された）: 確認も出さない。
  const cancelled = harness();
  const fourth = await openPreview(cancelled);
  cancelled.operations = [
    snapshot({ state: 'cancelled', state_revision: '2', allowed_actions: [] }),
  ];
  assert.deepEqual(await cancelled.bridge.approve(fourth.preview.preview_ref), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.equal(cancelled.confirms.length, 0);
});

test('a lost approval is held as unknown and released only when the operation moves; nothing is resent', async () => {
  const h = harness();
  const { ref, preview } = await openPreview(h);
  h.sendOutcome = { kind: 'unknown', requestId: id(2) };
  assert.deepEqual(await h.bridge.approve(preview.preview_ref), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(h.sent.length, 1);
  assert(h.changed.count > 0);
  assert.equal(h.bridge.entries(h.operations)[0]?.delivery_unknown, true);
  // 保留の間は、確認・取消・照合・承認のどれも送らない。
  for (const result of [
    await h.bridge.command('cancel', ref),
    await h.bridge.command('reconcile', ref),
    await h.bridge.preview(ref),
  ])
    assert.deepEqual(result, { ok: false, reason: 'entry_not_found' });
  assert.equal(h.sent.length, 1);
  // 同じ版のままなら解けない。進んだら解ける。
  assert.equal(h.bridge.entries(h.operations)[0]?.delivery_unknown, true);
  h.operations = [
    snapshot({
      state: 'approved',
      state_revision: '2',
      allowed_actions: ['cancel'],
    }),
  ];
  assert.equal(h.bridge.entries(h.operations)[0]?.delivery_unknown, false);
});

test('reconcile is a reference-only command: a lost reply is not held and may be asked again by the person', async () => {
  const h = harness();
  h.operations = [
    snapshot({
      state: 'unknown_held',
      state_revision: '4',
      allowed_actions: ['reconcile'],
    }),
  ];
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  h.sendOutcome = { kind: 'unknown', requestId: id(3) };
  assert.deepEqual(await h.bridge.command('reconcile', ref), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(h.bridge.entries(h.operations)[0]?.delivery_unknown, false);
  assert.deepEqual(h.sent, [
    {
      kind: 'reconcile',
      operationId: OP,
      expectedStateRevision: '4',
      commandScopeId: SCOPE,
    },
  ]);
  h.sendOutcome = {
    kind: 'accepted',
    requestId: id(4),
    receipt: { status: 'durable' },
  };
  assert.deepEqual(await h.bridge.command('reconcile', ref), {
    ok: true,
    value: 'durable',
  });
});

test('a preview is refused for an operation that is not waiting for approval, and reset drops every reference', async () => {
  const h = harness();
  h.operations = [snapshot({ state: 'succeeded', allowed_actions: [] })];
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  assert.deepEqual(await h.bridge.preview(ref), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.equal(h.requests.length, 0);
  h.operations = [snapshot()];
  const live = await openPreview(h);
  h.bridge.reset();
  assert.deepEqual(await h.bridge.approve(live.preview.preview_ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.deepEqual(await h.bridge.preview(live.ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(h.confirms.length, 0);
});

test('retry is sent only for an operation known not to have run, as a screen command, and a lost reply is held', async () => {
  const h = harness();
  // 実行されなかった（not_executed）以外は送らない（結果不明は照合を使う）。
  for (const state of [
    'unknown_held',
    'succeeded',
    'awaiting_approval',
  ] as const) {
    h.operations = [snapshot({ state, allowed_actions: [] })];
    const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
    assert.deepEqual(await h.bridge.command('retry', ref), {
      ok: false,
      reason: 'core_rejected',
    });
  }
  assert.equal(h.sent.length, 0);
  h.operations = [
    snapshot({
      state: 'not_executed',
      state_revision: '5',
      allowed_actions: ['retry'],
    }),
  ];
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  assert.deepEqual(await h.bridge.command('retry', ref), {
    ok: true,
    value: 'accepted',
  });
  assert.deepEqual(h.sent, [
    {
      kind: 'retry',
      operationId: OP,
      expectedStateRevision: '5',
      commandScopeId: SCOPE,
    },
  ]);
  // 返事が分からなければ、操作が進むまで保留（再試行は外部変更をもう一度行うので、自動でも画面からも送り直さない）。
  h.sendOutcome = { kind: 'unknown', requestId: id(7) };
  assert.deepEqual(await h.bridge.command('retry', ref), {
    ok: false,
    reason: 'outcome_unknown',
  });
  assert.equal(h.bridge.entries(h.operations)[0]?.delivery_unknown, true);
  assert.deepEqual(await h.bridge.command('retry', ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(h.sent.length, 2);
});
