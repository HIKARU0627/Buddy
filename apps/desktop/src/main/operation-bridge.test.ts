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
  // 端末の今の入出力の状態（送る直前に確かめる）。
  io: { permitted: boolean; epoch: string };
  // 準備（preview）の応答を遅らせる（番号 n の要求の応答を、返す関数が呼ばれるまで待つ）。
  previewGate: ((n: number) => Promise<void>) | null;
  // 操作の読み取り（GET）の応答。
  getReply: Reply;
  // 準備を受けた順の番号。
  previewCount: number;
  // 内容の表示用の読み取り（POST .../display）の応答の列と、受けた数。空なら今の内容（taskIntent）を返す。
  displayQueue: Reply[];
  displayCount: number;
  // 表示用の読み取りの応答を遅らせる。
  displayGate: ((n: number) => Promise<void>) | null;
  // 「状態を確かめる」の読み取りの応答の列（空なら getReply）。
  getQueue: Reply[];
  getGate: ((n: number) => Promise<void>) | null;
  getCount: number;
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
    io: { permitted: true, epoch: '1' },
    previewGate: null,
    getReply: { kind: 'unknown' },
    previewCount: 0,
    displayQueue: [],
    displayCount: 0,
    displayGate: null,
    getQueue: [],
    getGate: null,
    getCount: 0,
  };
  const connection = {
    get state() {
      return { commandScopeId: SCOPE, operations: h.operations };
    },
    async request(request: { path: string; body?: unknown }) {
      h.requests.push({ path: request.path, body: request.body });
      if (request.path.endsWith('/preview')) {
        h.previewCount += 1;
        await h.previewGate?.(h.previewCount);
        return h.replies.shift() ?? previewReply();
      }
      if (request.path.endsWith('/display')) {
        h.displayCount += 1;
        await h.displayGate?.(h.displayCount);
        return h.displayQueue.shift() ?? displayReply();
      }
      if (request.path === `/v1/operations/${OP}`) {
        h.getCount += 1;
        const reply = h.getQueue.shift() ?? h.getReply;
        await h.getGate?.(h.getCount);
        return reply;
      }
      return h.replies.shift() ?? { kind: 'unknown' };
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
    io: () => h.io,
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

const displayReply = (
  intent: OperationIntent = taskIntent,
  hash = HASH,
  version = '1',
): Reply => ({
  kind: 'response',
  status: 200,
  body: {
    content_version: version,
    content_hash: hash,
    state_revision: '1',
    intent,
    display: { account_label: null, target: null },
  },
});

async function openPreview(h: Harness) {
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
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
  const labels = previewView(labelsIntent, id(0x1), {
    account_label: 'synthetic-user@example.com',
    target: {
      subject: '件名',
      sender: 'sender@example.com',
      received_at: '2026-10-04T18:30:00+09:00',
    },
  });
  assert.deepEqual(labels, {
    preview_ref: id(0x1),
    operation_kind: 'mail.labels.change',
    service: 'mock',
    target: 'mail-001',
    fields: [{ field: 'labels_add', values: ['follow-up'] }],
    account_label: 'synthetic-user@example.com',
    target_detail: {
      subject: '件名',
      sender: 'sender@example.com',
      received_at: '2026-10-04T18:30:00+09:00',
    },
    approvable: true,
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
  // 口座の表示名・対象のメールを読めていない外部変更は、承認へ進ませない。
  const draft = previewView(draftIntent, id(0x2), undefined);
  assert.equal(draft.approvable, false);
  assert.equal(draft.account_label, null);
  assert.equal(draft.target_detail, null);
  assert.equal(
    previewView(draftIntent, id(0x2), {
      account_label: 'a@example.com',
      target: { subject: null, sender: null, received_at: null },
    }).approvable,
    false,
  );
  assert.equal(
    previewView(draftIntent, id(0x2), {
      account_label: null,
      target: { subject: '件名', sender: null, received_at: null },
    }).approvable,
    false,
  );
  assert.deepEqual(
    draft.fields.map((entry) => entry.field),
    ['draft_to', 'draft_subject', 'draft_body'],
  );
  const task = previewView(taskIntent, id(0x3), undefined);
  assert.deepEqual(task, {
    preview_ref: id(0x3),
    operation_kind: 'task.create',
    service: 'buddy',
    target: 'inbox',
    fields: [
      { field: 'task_title', values: ['牛乳を買う'] },
      { field: 'task_due', values: ['2030-10-06'] },
    ],
    account_label: null,
    target_detail: null,
    approvable: true,
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
      accountLabel: null,
      targetDetail: null,
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
  // 承認表示の準備は出さない（内容の表示用の読み取りは出てよい）。
  assert.equal(
    h.requests.filter((request) => request.path.endsWith('/preview')).length,
    0,
  );
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
  await seed(h);
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

const labelIntent: OperationIntent = {
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 承認待ちのときに内容（見出し）を読ませておく（その後の状態は、同じ内容版・hash のまま変える）。
async function seed(h: Harness): Promise<void> {
  h.bridge.entries(h.operations);
  await flush();
  await flush();
}

test('cancel and retry ask main for one confirmation with the content and the state, and send only after it', async () => {
  for (const [kind, action, state, allowed] of [
    ['cancel', 'cancel_operation', 'awaiting_approval', ['cancel']],
    ['retry', 'retry_operation', 'not_executed', ['retry']],
  ] as const) {
    const h = harness();
    await seed(h);
    h.operations = [
      snapshot({ state, state_revision: '4', allowed_actions: [...allowed] }),
    ];
    const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
    // 内容（見出し）を持つ状態にする（取消の確認に、何を取り消すかを出すため）。
    if (kind === 'cancel') await openPreview(h);
    h.confirms.length = 0;
    // 「やめる」: 送らない。
    h.confirm = () => 'confirmation_declined';
    assert.deepEqual(await h.bridge.command(kind, ref), {
      ok: false,
      reason: 'confirmation_declined',
    });
    assert.equal(h.sent.length, 0);
    // 確定: 1 回の確認の後に 1 回だけ送る。
    h.confirm = () => ({ scope: SCOPE });
    assert.deepEqual(await h.bridge.command(kind, ref), {
      ok: true,
      value: 'accepted',
    });
    assert.equal(h.sent.length, 1);
    assert.equal(h.confirms.length, 2);
    assert.deepEqual(h.confirms[1], {
      action,
      operationKind: 'task.create',
      headline: '牛乳を買う',
      detail: '期限 2030-10-06',
      state,
    });
  }
});

test('cancel and retry are not sent when the state changed while the confirmation was open', async () => {
  const h = harness();
  await seed(h);
  h.operations = [
    snapshot({
      state: 'not_executed',
      state_revision: '4',
      allowed_actions: ['retry'],
    }),
  ];
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  h.duringConfirm = () => {
    h.operations = [
      snapshot({
        state: 'preparing',
        state_revision: '5',
        allowed_actions: ['cancel'],
      }),
    ];
  };
  assert.deepEqual(await h.bridge.command('retry', ref), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.equal(h.sent.length, 0);
});

test('approval and retry are not sent when the input was stopped while the confirmation was open, even after a resume', async () => {
  const approve = harness();
  const { preview } = await openPreview(approve);
  approve.duringConfirm = () => {
    approve.io = { permitted: false, epoch: '2' };
  };
  assert.deepEqual(await approve.bridge.approve(preview.preview_ref), {
    ok: false,
    reason: 'input_stopped',
  });
  assert.equal(approve.sent.length, 0);

  // 停止して再開した（今は停止していないが io_epoch が進んでいる）: 確認を出したときと別の世代なので送らない。
  const resumed = harness();
  const second = await openPreview(resumed);
  resumed.duringConfirm = () => {
    resumed.io = { permitted: true, epoch: '3' };
  };
  assert.deepEqual(await resumed.bridge.approve(second.preview.preview_ref), {
    ok: false,
    reason: 'input_stopped',
  });
  assert.equal(resumed.sent.length, 0);

  const retry = harness();
  await seed(retry);
  retry.operations = [
    snapshot({
      state: 'not_executed',
      state_revision: '4',
      allowed_actions: ['retry'],
    }),
  ];
  const ref = retry.bridge.entries(retry.operations)[0]?.ref ?? '';
  retry.duringConfirm = () => {
    retry.io = { permitted: false, epoch: '2' };
  };
  assert.deepEqual(await retry.bridge.command('retry', ref), {
    ok: false,
    reason: 'input_stopped',
  });
  assert.equal(retry.sent.length, 0);
  // 停止している間は、確認も出さない。
  const stopped = harness();
  const third = await openPreview(stopped);
  stopped.io = { permitted: false, epoch: '2' };
  assert.deepEqual(await stopped.bridge.approve(third.preview.preview_ref), {
    ok: false,
    reason: 'input_stopped',
  });
  assert.equal(stopped.confirms.length, 0);
});

test('a lost command is checked by reading only: not delivered releases the hold, an advanced state releases it too, and nothing is resent', async () => {
  const h = harness();
  const { ref, preview } = await openPreview(h);
  h.sendOutcome = { kind: 'unknown', requestId: id(2) };
  await h.bridge.approve(preview.preview_ref);
  assert.equal(h.bridge.entries(h.operations)[0]?.delivery_unknown, true);
  assert.equal(h.sent.length, 1);
  // 状態が変わっていない: 届いていない。保留を解く（単独の端末でも復旧できる）。命令は送らない。
  h.getReply = {
    kind: 'response',
    status: 200,
    body: { ...snapshot(), state_revision: '1' },
  };
  assert.deepEqual(await h.bridge.check(ref), {
    ok: true,
    value: 'state_unchanged',
  });
  assert.equal(h.bridge.entries(h.operations)[0]?.delivery_unknown, false);
  assert.equal(h.sent.length, 1);
  assert.equal(
    h.requests.filter((r) => r.path === `/v1/operations/${OP}`).length,
    1,
  );
  // 保留でない操作は確かめない。
  assert.deepEqual(await h.bridge.check(ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  // 解けた後は、内容を確かめ直して、もう一度承認できる（新しい確認・新しい命令）。
  h.sendOutcome = {
    kind: 'accepted',
    requestId: id(6),
    receipt: { status: 'accepted' },
  };
  const again = await h.bridge.preview(ref);
  assert(again.ok);
  assert.deepEqual(await h.bridge.approve(again.value.preview_ref), {
    ok: true,
    value: 'accepted',
  });
  assert.equal(h.sent.length, 2);

  // 状態が進んでいた（届いていた）: 保留を解き、進んだ状態を見せる。
  const moved = harness();
  const second = await openPreview(moved);
  moved.sendOutcome = { kind: 'unknown', requestId: id(3) };
  await moved.bridge.approve(second.preview.preview_ref);
  moved.getReply = {
    kind: 'response',
    status: 200,
    body: {
      ...snapshot({
        state: 'approved',
        state_revision: '2',
        allowed_actions: ['cancel'],
      }),
    },
  };
  assert.deepEqual(await moved.bridge.check(second.ref), {
    ok: true,
    value: 'state_changed',
  });
  // 読めなければ保留のまま。
  const unread = harness();
  const third = await openPreview(unread);
  unread.sendOutcome = { kind: 'unknown', requestId: id(4) };
  await unread.bridge.approve(third.preview.preview_ref);
  unread.getReply = { kind: 'unknown' };
  assert.deepEqual(await unread.bridge.check(third.ref), {
    ok: false,
    reason: 'not_connected',
  });
  assert.equal(
    unread.bridge.entries(unread.operations)[0]?.delivery_unknown,
    true,
  );
});

test('work started before a lock or disconnect sends nothing and changes nothing afterwards', async () => {
  // 会話の作成を待っている間にロック・解除（reset）: 遅れて届いた応答で会話を戻さず、発言も送らない。
  const turn = harness();
  turn.replies.push({
    kind: 'response',
    status: 201,
    body: {
      request_id: id(1),
      session_id: id(0x44),
      storage_mode: 'normal',
      route_revision: '0',
    },
  });
  // 会話の作成を始めた直後（応答が届く前）にロック・解除する。
  const pending = turn.bridge.submitTurn('こんにちは');
  turn.bridge.reset();
  assert.deepEqual(await pending, { ok: false, reason: 'not_connected' });
  assert.deepEqual(
    turn.requests.map((request) => request.path),
    ['/v1/sessions'],
  );

  // 確認を出している間にロック・解除: 送らない。
  const approve = harness();
  const { preview } = await openPreview(approve);
  approve.duringConfirm = () => approve.bridge.reset();
  assert.deepEqual(await approve.bridge.approve(preview.preview_ref), {
    ok: false,
    reason: 'not_connected',
  });
  assert.equal(approve.sent.length, 0);

  // 送った後に世代が進み、返事が分からなかった: 今の世代に保留を作らない。
  const lost = harness();
  const second = await openPreview(lost);
  lost.sendOutcome = { kind: 'unknown', requestId: id(5) };
  lost.duringConfirm = () => undefined;
  const sending = lost.bridge.approve(second.preview.preview_ref);
  lost.bridge.reset();
  await sending;
  assert.equal(
    lost.bridge.entries(lost.operations)[0]?.delivery_unknown,
    false,
  );

  // 準備を待っている間にロック・解除: 確認の記録を作らない。
  const gate = harness();
  gate.operations = [snapshot()];
  const ref = gate.bridge.entries(gate.operations)[0]?.ref ?? '';
  await flush();
  let open: (() => void) | null = null;
  gate.previewGate = () =>
    new Promise<void>((resolve) => {
      open = resolve;
    });
  const waiting = gate.bridge.preview(ref);
  await flush();
  gate.bridge.reset();
  (open as unknown as () => void)();
  assert.deepEqual(await waiting, { ok: false, reason: 'not_connected' });
});

test('previews of one operation are serialized and only the latest request is issued; an older reference is not valid', async () => {
  const h = harness();
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  await flush();
  const base = h.previewCount;
  // 1 番目の応答を遅らせる間に、2 番目・3 番目の要求が来る。
  const gates: (() => void)[] = [];
  h.previewGate = (n) =>
    n === base + 1
      ? new Promise<void>((resolve) => {
          gates.push(resolve);
        })
      : Promise.resolve();
  const first = h.bridge.preview(ref);
  await flush();
  const second = h.bridge.preview(ref);
  const third = h.bridge.preview(ref);
  await flush();
  // 直列: 1 番目の応答が返るまで、次の要求は中枢へ出ない。
  assert.equal(h.previewCount, base + 1);
  gates[0]?.();
  const results = await Promise.all([first, second, third]);
  // 古い 2 番目は発行しない。最新の 3 番目だけが有効。
  assert.equal(h.previewCount, base + 2);
  assert.deepEqual(results[1], { ok: false, reason: 'preview_stale' });
  assert(results[0]?.ok && results[2]?.ok);
  assert.notEqual(results[0].value.preview_ref, results[2].value.preview_ref);
  assert.deepEqual(await h.bridge.approve(results[0].value.preview_ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.deepEqual(await h.bridge.approve(results[2].value.preview_ref), {
    ok: true,
    value: 'accepted',
  });
});

test('the list shows the content of a waiting operation, read by main itself and kept only in main', async () => {
  const h = harness();
  const first = h.bridge.entries(h.operations)[0];
  assert.equal(first?.headline, null);
  await flush();
  await flush();
  const task = h.bridge.entries(h.operations)[0];
  assert.equal(task?.headline, '牛乳を買う');
  assert.equal(task?.detail, '期限 2030-10-06');
  assert(h.changed.count > 0);
  // 同じ状態版では読み直さない（失敗を繰り返さず、利用者の確認を失効させない）。
  const count = h.displayCount;
  h.bridge.entries(h.operations);
  h.bridge.entries(h.operations);
  await flush();
  assert.equal(h.displayCount, count);
  // 見出しは読み取りだけで読み、承認表示の準備（preview）は発行しない（利用者の確認を失効させない）。
  assert.equal(h.previewCount, 0);
  // 承認待ちでなくなっても、見出しは残る。
  h.operations = [
    snapshot({ state: 'succeeded', state_revision: '3', allowed_actions: [] }),
  ];
  assert.equal(h.bridge.entries(h.operations)[0]?.headline, '牛乳を買う');
  // メールの操作は、件名を見出しにし、ラベルの変更を補足にする。
  const mail = harness();
  mail.operations = [
    snapshot({
      operation_kind: 'mail.labels.change',
      content_hash: 'cd'.repeat(32),
    }),
  ];
  mail.displayQueue.push({
    kind: 'response',
    status: 200,
    body: {
      content_version: '1',
      content_hash: 'cd'.repeat(32),
      state_revision: '1',
      intent: labelIntent,
      display: {
        account_label: 'user@example.com',
        target: {
          subject: '来週の打ち合わせ',
          sender: 'sato@example.com',
          received_at: '2026-10-04T18:30:00+09:00',
        },
      },
    },
  });
  mail.bridge.entries(mail.operations);
  await flush();
  await flush();
  const row = mail.bridge.entries(mail.operations)[0];
  assert.equal(row?.headline, '来週の打ち合わせ');
  assert.equal(row?.detail, '付ける: follow-up');
  // 内容（本文・件名・差出人）は、操作の一覧の IPC には headline・detail としてだけ出る（ID・hash は出ない）。
  assert.equal(JSON.stringify(row).includes('sato@example.com'), false);
});

test('an external change whose account or target mail could not be read cannot be approved', async () => {
  const h = harness();
  h.operations = [snapshot({ operation_kind: 'mail.labels.change' })];
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  await flush();
  h.replies.push({
    kind: 'response',
    status: 200,
    body: {
      preview_id: id(0x779),
      intent: labelIntent,
      content_hash: HASH,
      state_revision: '1',
    },
  });
  const result = await h.bridge.preview(ref);
  assert(result.ok);
  assert.equal(result.value.approvable, false);
  assert.deepEqual(await h.bridge.approve(result.value.preview_ref), {
    ok: false,
    reason: 'core_rejected',
  });
  assert.equal(h.confirms.length, 0);
  assert.equal(h.sent.length, 0);
});

test('a confirmation for cancel or retry uses only content that matches the current content version and hash, and reads it again when it is missing', async () => {
  // 別端末で内容が改訂された（内容版・hash が変わった）後の再試行: 古い見出しでは確認へ進ませない。
  const h = harness();
  await seed(h);
  assert.equal(h.bridge.entries(h.operations)[0]?.headline, '牛乳を買う');
  h.operations = [
    snapshot({
      state: 'not_executed',
      state_revision: '5',
      content_version: '2',
      content_hash: 'cd'.repeat(32),
      allowed_actions: ['retry'],
    }),
  ];
  // 古い内容の見出しは、一覧にも出さない。
  assert.equal(h.bridge.entries(h.operations)[0]?.headline, null);
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  // 読み直しても一致する内容が返らなければ（中枢が古い版を返した）、確認へ進ませない。
  h.displayQueue.push(
    displayReply(taskIntent, HASH, '1'),
    displayReply(taskIntent, HASH, '1'),
  );
  assert.deepEqual(await h.bridge.command('retry', ref), {
    ok: false,
    reason: 'content_unavailable',
  });
  assert.equal(h.confirms.length, 0);
  assert.equal(h.sent.length, 0);

  // ロック・切断の後（内容を捨てた後）に承認待ち以外の操作（未実行・承認済み）を取り直すと、内容の表示用の読み取りで
  // 内容を取り、内容版が一致したときだけ確認を出す（取消と再試行が戻る）。
  for (const [kind, state, allowed] of [
    ['retry', 'not_executed', ['retry']],
    ['cancel', 'approved', ['cancel']],
  ] as const) {
    const reset = harness();
    await seed(reset);
    reset.bridge.reset();
    reset.operations = [
      snapshot({ state, state_revision: '5', allowed_actions: [...allowed] }),
    ];
    const again = reset.bridge.entries(reset.operations)[0]?.ref ?? '';
    const before = reset.displayCount;
    assert.deepEqual(await reset.bridge.command(kind, again), {
      ok: true,
      value: 'accepted',
    });
    assert(reset.displayCount > before || reset.displayCount > 0);
    assert.equal(reset.confirms.length, 1);
    assert.equal(reset.confirms[0]?.action, `${kind}_operation`);
    assert.equal(
      (reset.confirms[0] as { headline: string | null }).headline,
      '牛乳を買う',
    );
  }

  // 中枢が内容を返せない（409 など）ときは、確認を出さない。
  const refused = harness();
  refused.operations = [
    snapshot({
      state: 'not_executed',
      state_revision: '5',
      allowed_actions: ['retry'],
    }),
  ];
  refused.displayQueue.push(
    { kind: 'response', status: 409, body: {} },
    { kind: 'response', status: 409, body: {} },
  );
  const refusedRef = refused.bridge.entries(refused.operations)[0]?.ref ?? '';
  assert.deepEqual(await refused.bridge.command('retry', refusedRef), {
    ok: false,
    reason: 'content_unavailable',
  });
  assert.equal(refused.confirms.length, 0);
  assert.equal(refused.sent.length, 0);
});

test('check responses that arrive in reverse order never put an older state over a newer one', async () => {
  const h = harness();
  const { ref, preview } = await openPreview(h);
  h.sendOutcome = { kind: 'unknown', requestId: id(2) };
  await h.bridge.approve(preview.preview_ref);
  const at = (revision: string, state: OperationSnapshot['state']) => ({
    kind: 'response' as const,
    status: 200,
    body: snapshot({
      state,
      state_revision: revision,
      allowed_actions: state === 'approved' ? ['cancel'] : [],
    }),
  });
  // 同じ参照の確認を 2 つ並行して送り、応答が逆の順（新しい版 4 が先、古い版 2 が後）で届く。
  h.getQueue.push(at('2', 'approved'), at('4', 'succeeded'));
  const releases: (() => void)[] = [];
  h.getGate = (n) =>
    new Promise<void>((resolve) => {
      releases[n - 1] = resolve;
    });
  const first = h.bridge.check(ref);
  await flush();
  const second = h.bridge.check(ref);
  await flush();
  releases[1]?.();
  assert.deepEqual(await second, { ok: true, value: 'state_changed' });
  assert.equal(h.bridge.entries(h.operations)[0]?.state, 'succeeded');
  releases[0]?.();
  await first;
  // 遅れて届いた古い応答（版 2）で、新しく読んだ状態（版 4）を戻さない。
  const row = h.bridge.entries(h.operations)[0];
  assert.equal(row?.state, 'succeeded');
  assert.equal(row?.state_revision, '4');
  assert.deepEqual(row?.allowed_actions, []);
});

test('reading the state of a held command shows the state read, without saying the command arrived', async () => {
  const h = harness();
  const { ref, preview } = await openPreview(h);
  h.sendOutcome = { kind: 'unknown', requestId: id(2) };
  await h.bridge.approve(preview.preview_ref);
  h.getReply = {
    kind: 'response',
    status: 200,
    body: snapshot({
      state: 'approved',
      state_revision: '2',
      approval_state: 'valid',
      allowed_actions: ['cancel'],
    }),
  };
  assert.deepEqual(await h.bridge.check(ref), {
    ok: true,
    value: 'state_changed',
  });
  // クライアントの状態は古いまま（承認待ち・版 1）でも、読み取った状態（承認済み・版 2）を一覧に出す。
  const row = h.bridge.entries(h.operations)[0];
  assert.equal(row?.state, 'approved');
  assert.equal(row?.state_revision, '2');
  assert.equal(row?.delivery_unknown, false);
  assert.deepEqual(row?.allowed_actions, ['cancel']);
  // 状態が変わっていなければ、変わっていないという事実だけを返す。
  const same = harness();
  const second = await openPreview(same);
  same.sendOutcome = { kind: 'unknown', requestId: id(3) };
  await same.bridge.approve(second.preview.preview_ref);
  same.getReply = { kind: 'response', status: 200, body: snapshot() };
  assert.deepEqual(await same.bridge.check(second.ref), {
    ok: true,
    value: 'state_unchanged',
  });
  assert.equal(
    same.bridge.entries(same.operations)[0]?.state,
    'awaiting_approval',
  );
});

test('reading headings in the background does not push out the reference of the confirmation on screen', async () => {
  const h = harness();
  const { preview } = await openPreview(h);
  // ほかの承認待ちの操作が 25 件見つかり、main が見出しを読む（承認用の上限 20 件とは別）。
  h.operations = [
    snapshot(),
    ...Array.from({ length: 25 }, (_, index) =>
      snapshot({ operation_id: id(0x300 + index) }),
    ),
  ];
  h.bridge.entries(h.operations);
  for (let i = 0; i < 30; i += 1) await flush();
  const headlines = h.bridge
    .entries(h.operations)
    .filter((entry) => entry.headline !== null);
  assert.equal(headlines.length, 26);
  // 見出しの読み取りは preview を発行しない（利用者が開いた確認の 1 回だけ）。
  assert.equal(h.previewCount, 1);
  // 表示中の確認は、そのまま承認できる。
  assert.deepEqual(await h.bridge.approve(preview.preview_ref), {
    ok: true,
    value: 'accepted',
  });
});

test('an external change is approvable only when the account, the subject, the sender and the received time are all read', () => {
  const full = {
    account_label: 'user@example.com',
    target: {
      subject: '件名',
      sender: 'sato@example.com',
      received_at: '2026-10-04T18:30:00+09:00',
    },
  };
  assert.equal(previewView(labelIntent, id(1), full).approvable, true);
  for (const missing of ['subject', 'sender', 'received_at'] as const)
    assert.equal(
      previewView(labelIntent, id(1), {
        ...full,
        target: { ...full.target, [missing]: null },
      }).approvable,
      false,
      missing,
    );
  assert.equal(
    previewView(labelIntent, id(1), { ...full, account_label: null })
      .approvable,
    false,
  );
  assert.equal(previewView(taskIntent, id(1), undefined).approvable, true);
});

test('cancel and retry of an external change are not confirmed when the account or the target mail was not identified', async () => {
  const none = {
    kind: 'response' as const,
    status: 200,
    body: {
      content_version: '1',
      content_hash: HASH,
      state_revision: '1',
      intent: labelIntent,
      // 接続先が替わった後は、Core は対象・口座の表示名を null にして返す。
      display: { account_label: null, target: null },
    },
  };
  const h = harness();
  h.operations = [
    snapshot({
      operation_kind: 'mail.labels.change',
      state: 'approved',
      state_revision: '3',
      allowed_actions: ['cancel'],
    }),
  ];
  h.displayQueue.push(none, none, none);
  const ref = h.bridge.entries(h.operations)[0]?.ref ?? '';
  await flush();
  assert.deepEqual(await h.bridge.command('cancel', ref), {
    ok: false,
    reason: 'content_unavailable',
  });
  assert.equal(h.confirms.length, 0);
  assert.equal(h.sent.length, 0);
  // 確認できる内容（口座の表示名と対象のメールがそろう）なら、確認へ進む。
  const ok = harness();
  ok.operations = [
    snapshot({
      operation_kind: 'mail.labels.change',
      state: 'approved',
      state_revision: '3',
      allowed_actions: ['cancel'],
    }),
  ];
  ok.displayQueue.push({
    kind: 'response',
    status: 200,
    body: {
      ...none.body,
      display: {
        account_label: 'user@example.com',
        target: {
          subject: '来週の打ち合わせ',
          sender: 'sato@example.com',
          received_at: '2026-10-04T18:30:00+09:00',
        },
      },
    },
  });
  const okRef = ok.bridge.entries(ok.operations)[0]?.ref ?? '';
  await flush();
  assert.deepEqual(await ok.bridge.command('cancel', okRef), {
    ok: true,
    value: 'accepted',
  });
  assert.equal(ok.confirms.length, 1);
});
