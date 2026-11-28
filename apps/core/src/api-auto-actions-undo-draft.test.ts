// 自動で作った返信の下書きの取り消し（POST /v1/auto-actions/{id}/undo、B13-05、ADR 0156）の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬）。提供元は試験の中の合成の読み書きの口で、
// 操作は合成の返信の下書きの保存（mail-001 への返信、方針で自動承認）。実アカウント・実データは使わない。
// 期待値は設計 03「取り消しと安全停止」・J12 と ADR 0156（Buddy が作ったままの下書きだけを削除する。送った・
// 手を加えた・消えた下書きは 409 target_changed。送る直前に版が変わっていれば消さない）から手で書いた値。
// 模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { operationMarker } from '@buddy/domain';
import {
  openWriteConnection,
  sealOperationIntent,
  storagePlatform,
} from '@buddy/storage';
import type { CreateOperationCommand, DbCommand } from '@buddy/storage';
import {
  draftCreationOf,
  draftUnchanged,
  undoOperationId,
  undoableKindsOf,
} from './api-auto-actions.js';
import {
  DATA_KEY_MATERIAL,
  bearer,
  bootstrap,
  dispatchCommand,
  insertDevice,
  prepareCommand,
  startEventCore,
  submitDurable,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { draftDeleteObserved } from './operation-runner.js';
import { pinnedRequest, sharedApiContract } from './api-test-support.js';
import type { ApiResponse, TestDevice } from './api-test-support.js';
import { DB_FILE } from './paths.js';
import type {
  ProviderDraftContent,
  ProviderReader,
  ProviderWriteOutcome,
  ProviderWriter,
} from './turn-ports.js';

const contract = sharedApiContract();
type Json = Record<string, unknown>;
const SCREEN = { 'buddy-input-origin': 'screen' } as const;
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const MAIL = 'mail-001';
const DRAFT = 'draft-0001';
const REPLY = {
  to: ['sender@example.invalid'],
  cc: [] as string[],
  subject: 'Re: 打ち合わせの件',
  body: '確認しました。',
};

// 合成の提供元。下書きを 1 件持ち、id での読み取りと、版が合うときだけの削除を受ける。
interface FakeDrafts {
  draft: ProviderDraftContent | null;
  reads: number;
  // 読み取りのたびに呼ぶ（2 回目の読み取りの前に下書きを書き換える、などに使う）。
  onRead?: (reads: number) => void;
  // 接続の口座（省略は ACCOUNT）。結果不明の後に口座を付け替える試験に使う（ADR 0198 の見直し）。
  account?: string;
  // 削除の応答を差し替える（省略は版を見て消す）。
  respond?: () => ProviderWriteOutcome<{ readonly draft_id: string }> | null;
  readonly deletes: { draft_id: string; source_revision: string }[];
}

function fakeProvider(
  drafts: FakeDrafts,
  options: { readonly readDraft?: boolean } = {},
): { reader: ProviderReader; writer: ProviderWriter } {
  const reader: ProviderReader = {
    connection: () =>
      Promise.resolve({
        provider: 'mock',
        account_id: drafts.account ?? ACCOUNT,
        status: 'active',
        access: 'read_write',
        writable_kinds: ['mail.draft.create', 'mail.draft.delete'],
        readable_kinds: ['mail.message', 'mail.draft'],
      }),
    readPermission: (accountId) =>
      Promise.resolve(
        accountId === ACCOUNT
          ? {
              account_id: ACCOUNT,
              permission_revision: '1',
              scopes: ['mail.read', 'mail.drafts.create', 'mail.drafts.delete'],
            }
          : null,
      ),
    readTarget: () => Promise.resolve(null),
    listEvents: () => Promise.resolve([]),
  };
  const withRead: ProviderReader =
    options.readDraft === false
      ? reader
      : {
          ...reader,
          readDraft: (draftId) => {
            drafts.reads += 1;
            drafts.onRead?.(drafts.reads);
            const draft = drafts.draft;
            return Promise.resolve(
              draft !== null && draft.draft_id === draftId
                ? { ...draft, to: [...draft.to], cc: [...draft.cc] }
                : null,
            );
          },
        };
  return {
    reader: withRead,
    writer: {
      changeLabels: () => Promise.resolve({ kind: 'not_sent' }),
      deleteDraft: (_identity, request) => {
        drafts.deletes.push({ ...request });
        const forced = drafts.respond?.() ?? null;
        if (forced !== null) return Promise.resolve(forced);
        const draft = drafts.draft;
        if (draft === null || draft.draft_id !== request.draft_id)
          return Promise.resolve({
            kind: 'rejected',
            status: 404,
            code: 'not_found',
          });
        if (
          draft.status !== 'draft' ||
          draft.revision !== request.source_revision
        )
          return Promise.resolve({
            kind: 'rejected',
            status: 409,
            code: 'precondition_failed',
          });
        drafts.draft = null;
        return Promise.resolve({
          kind: 'applied',
          status: 200,
          value: { draft_id: request.draft_id },
        });
      },
    },
  };
}

interface Harness {
  readonly core: EventCore;
  readonly device: TestDevice;
  readonly scope: string;
  sql<T>(body: (db: ReturnType<typeof openWriteConnection>) => T): T;
}

async function start(
  t: test.TestContext,
  drafts: FakeDrafts,
  options: { readonly readDraft?: boolean } = {},
): Promise<Harness> {
  const ports = fakeProvider(drafts, options);
  const core = await startEventCore(t, {
    turns: { provider: ports.reader, writer: ports.writer },
  });
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
  const sql = <T>(
    body: (db: ReturnType<typeof openWriteConnection>) => T,
  ): T => {
    const db = openWriteConnection(join(core.dataDir, DB_FILE), {
      platform: storagePlatform(),
    });
    try {
      return body(db);
    } finally {
      db.close();
    }
  };
  return { core, device, scope, sql };
}

const base = (operationId: string, expected: string) => ({
  command_id: randomUUID(),
  operation_id: operationId,
  expected_state_revision: expected,
  request_revision: null,
  permission_revision: '1',
  forgetting_generation: '0',
  connection_id: null,
  request: null,
});

// 方針で自動承認した返信の下書きの保存を、準備・送出・結果まで進める（結果の版は 5、作成物は DRAFT）。
async function seedAutoDraft(h: Harness): Promise<string> {
  const operationId = randomUUID();
  const sealed = sealOperationIntent(
    DATA_KEY_MATERIAL,
    { operationId, contentVersion: 1 },
    {
      schema: 'buddy.operation.v1',
      operation_id: operationId,
      content_version: '1',
      permission_revision: '1',
      provider: 'mock',
      account_id: ACCOUNT,
      target: { remote_id: MAIL, source_revision: 'r2' },
      action: { kind: 'mail.draft.create', ...REPLY },
      effects: { external_recipients: [], reconcile_scope: 'operation_marker' },
    },
  );
  assert(sealed.ok);
  const create: CreateOperationCommand = {
    ...base(operationId, '0'),
    kind: 'operation.create',
    workflow_id: null,
    operation_kind: 'mail.draft.create',
    effect_route: 'remote_mutation',
    content_hash: sealed.content_hash,
    intent: sealed.intent,
    auto_approval: {
      approval_id: randomUUID(),
      policy_version: '3',
      current_policy_version: '3',
      safety_target_key: `target:${operationId}`,
    },
  };
  await submitDurable(h.core, create);
  const prepare = prepareCommand(operationId, '1');
  assert(prepare.kind === 'operation.prepare');
  await submitDurable(h.core, { ...prepare, permission_revision: '1' });
  await submitDurable(h.core, {
    ...dispatchCommand(operationId, '2', prepare.attempt_id),
    permission_revision: '1',
    observed_connection: {
      status: 'active',
      access: 'read_write',
      permission_revision: '1',
    },
    step: { step_id: '1-create_draft', step_kind: 'create_draft' },
  } as DbCommand);
  for (const [expected, to] of [
    ['3', 'reconciling'],
    ['4', 'succeeded'],
  ] as const)
    await submitDurable(h.core, {
      ...base(operationId, expected),
      kind: 'operation.record_result',
      attempt_id: prepare.attempt_id,
      to,
      external_id: DRAFT,
    });
  return operationId;
}

const createdDraft = (operationId: string): ProviderDraftContent => ({
  draft_id: DRAFT,
  revision: 'd1',
  status: 'draft',
  marker: operationMarker(operationId, '1'),
  in_reply_to: MAIL,
  ...REPLY,
});

const undoRequest = (
  h: Harness,
  operationId: string,
  requestId: string = randomUUID(),
): Promise<ApiResponse> =>
  pinnedRequest(h.core.target, {
    method: 'POST',
    path: `/v1/auto-actions/${operationId}/undo`,
    headers: {
      ...bearer(h.device.token),
      'content-type': 'application/json',
      ...SCREEN,
    },
    body: JSON.stringify({
      request_id: requestId,
      command_scope_id: h.scope,
      expected_state_revision: '5',
    }),
  });

async function undoStates(h: Harness): Promise<string[]> {
  const response = await pinnedRequest(h.core.target, {
    method: 'GET',
    path: '/v1/auto-actions',
    headers: bearer(h.device.token),
  });
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('AutoActionList', response.json), response.text);
  return ((response.json as Json)['items'] as Json[]).map((item) =>
    String(item['undo_state']),
  );
}

const undoRecords = (h: Harness): unknown[] =>
  h.sql((db) =>
    db
      .prepare(
        'SELECT operation_id, compensation_operation_id, status FROM undo_records ORDER BY requested_at',
      )
      .all(),
  );

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('did not reach the expected state');
}

test('undo deletes the draft Buddy created, with its revision, through a compensation approved by the press', async (t) => {
  const drafts: FakeDrafts = { draft: null, reads: 0, deletes: [] };
  const h = await start(t, drafts);
  const operationId = await seedAutoDraft(h);
  drafts.draft = createdDraft(operationId);
  assert.deepEqual(await undoStates(h), ['available']);

  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, requestId);
  assert.equal(accepted.status, 202, accepted.text);
  assert(contract.valid('CommandReceipt', accepted.json), accepted.text);
  const compensationId = undoOperationId(h.scope, requestId);
  assert.equal((accepted.json as Json)['operation_id'], compensationId);

  await waitFor(async () => (await undoStates(h))[0] === 'undone');
  assert.deepEqual(drafts.deletes, [
    { draft_id: DRAFT, source_revision: 'd1' },
  ]);
  assert.equal(drafts.draft, null);
  assert.deepEqual(undoRecords(h), [
    {
      operation_id: operationId,
      compensation_operation_id: compensationId,
      status: 'undone',
    },
  ]);
  assert.deepEqual(
    h.sql((db) =>
      db
        .prepare(
          'SELECT o.kind, o.state, a.route FROM operations o JOIN approvals a ON a.operation_id = o.operation_id WHERE o.operation_id = ?',
        )
        .get(compensationId),
    ),
    { kind: 'mail.draft.delete', state: 'succeeded', route: 'screen' },
  );
});

test('a draft that was edited, sent or removed is not deleted automatically (409 target_changed)', async (t) => {
  const drafts: FakeDrafts = { draft: null, reads: 0, deletes: [] };
  const h = await start(t, drafts);
  const operationId = await seedAutoDraft(h);
  const changes: readonly (ProviderDraftContent | null)[] = [
    { ...createdDraft(operationId), body: '確認しました。追記です。' },
    { ...createdDraft(operationId), to: ['other@example.invalid'] },
    { ...createdDraft(operationId), status: 'sent' },
    {
      ...createdDraft(operationId),
      marker: operationMarker(randomUUID(), '1'),
    },
    null,
  ];
  for (const draft of changes) {
    drafts.draft = draft;
    const response = await undoRequest(h, operationId);
    assert.equal(response.status, 409, response.text);
    assert(contract.valid('ApiError', response.json), response.text);
    assert.equal(response.json?.['code'], 'target_changed');
  }
  assert.deepEqual(drafts.deletes, []);
  assert.deepEqual(undoRecords(h), []);
  assert.deepEqual(await undoStates(h), ['available']);
});

test('a draft edited after the press is not deleted: the runner rechecks its revision before sending', async (t) => {
  const drafts: FakeDrafts = { draft: null, reads: 0, deletes: [] };
  const h = await start(t, drafts);
  const operationId = await seedAutoDraft(h);
  drafts.draft = createdDraft(operationId);
  // 経路の読み取り（1 回目）の後、実行担当の確かめ直し（2 回目）の前に本人が下書きに手を加える。
  drafts.onRead = (reads) => {
    if (reads === 2 && drafts.draft !== null)
      drafts.draft = { ...drafts.draft, revision: 'd2', body: '書き直し' };
  };
  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, requestId);
  assert.equal(accepted.status, 202, accepted.text);
  await waitFor(() => drafts.reads >= 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(drafts.deletes, []);
  assert.notEqual(drafts.draft, null);
  const compensationId = undoOperationId(h.scope, requestId);
  assert.deepEqual(
    h.sql((db) =>
      db
        .prepare('SELECT state FROM operations WHERE operation_id = ?')
        .get(compensationId),
    ),
    { state: 'preparing' },
  );
  assert.deepEqual(await undoStates(h), ['in_progress']);
});

test('without reading drafts by id the list does not offer undo for drafts', async (t) => {
  const drafts: FakeDrafts = { draft: null, reads: 0, deletes: [] };
  const h = await start(t, drafts, { readDraft: false });
  const operationId = await seedAutoDraft(h);
  drafts.draft = createdDraft(operationId);
  assert.deepEqual(await undoStates(h), ['unavailable']);
  const response = await undoRequest(h, operationId);
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json?.['code'], 'conflict');
  assert.deepEqual(drafts.deletes, []);
});

test('the pure checks: which kinds can be undone, the unchanged draft and the delete reconciliation', () => {
  assert.deepEqual(undoableKindsOf(null), []);
  assert.deepEqual(undoableKindsOf({}), ['label_mail', 'create_task']);
  assert.deepEqual(
    undoableKindsOf({ readDraft: () => Promise.resolve(null) }),
    ['label_mail', 'draft_reply', 'create_task'],
  );
  const operationId = randomUUID();
  const creation = draftCreationOf({
    operation_id: operationId,
    content_version: '1',
    provider: 'mock',
    account_id: ACCOUNT,
    target: { remote_id: MAIL, source_revision: 'r2' },
    action: { kind: 'mail.draft.create', ...REPLY },
  });
  assert(creation !== null);
  assert.equal(draftUnchanged(createdDraft(operationId), creation), true);
  assert.equal(
    draftUnchanged(
      { ...createdDraft(operationId), cc: ['cc@example.invalid'] },
      creation,
    ),
    false,
  );
  assert.equal(
    draftUnchanged(
      { ...createdDraft(operationId), in_reply_to: 'mail-002' },
      creation,
    ),
    false,
  );
  assert.equal(
    draftCreationOf({ action: { kind: 'mail.labels.change' } }),
    null,
  );
  assert.deepEqual(draftDeleteObserved(null, { remote_id: DRAFT }), {
    kind: 'found',
    external_id: DRAFT,
  });
  assert.deepEqual(
    draftDeleteObserved(createdDraft(operationId), { remote_id: DRAFT }),
    { kind: 'not_found' },
  );
  assert.deepEqual(
    draftDeleteObserved(
      { ...createdDraft(operationId), draft_id: 'draft-0002' },
      { remote_id: DRAFT },
    ),
    { kind: 'unreadable' },
  );
});

test('an unknown delete outcome is not taken as undone when the connection is another account by then (ADR 0198 review)', async (t) => {
  const drafts: FakeDrafts = { draft: null, reads: 0, deletes: [] };
  const h = await start(t, drafts);
  const operationId = await seedAutoDraft(h);
  drafts.draft = createdDraft(operationId);
  // 応答を失い、その間に口座が付け替えられた（新しい口座では下書きが見えない）。
  drafts.respond = () => {
    drafts.account = '00000000-0000-4000-8000-000000000003';
    drafts.draft = null;
    return { kind: 'unknown', reason: 'timeout' };
  };
  const accepted = await undoRequest(h, operationId);
  assert.equal(accepted.status, 202, accepted.text);
  const compensationId = String((accepted.json as Json)['operation_id']);
  const state = () =>
    (
      h.sql((db) =>
        db
          .prepare('SELECT state FROM operations WHERE operation_id = ?')
          .get(compensationId),
      ) as { state: string }
    ).state;
  await waitFor(() => state() === 'unknown_held');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(state(), 'unknown_held');
  assert.deepEqual(await undoStates(h), ['in_progress']);
  // 口座が違うので照合では読まない（押下・確かめ直しの 2 回だけ）。送り直さない。
  assert.equal(drafts.reads, 2);
  assert.equal(drafts.deletes.length, 1);
});
