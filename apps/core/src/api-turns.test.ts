// 会話の開始・発言（入力→解釈→意味検証→操作の作成）・preview の発行と無効化（ADR 0029、X02・X03・X04、
// QA27 の Read 側）。Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬の KeyStore）。解釈は模擬
// （モデルを使わない）、provider は試験の中で作る合成の読み取り専用の模擬（#87 のアダプターは未接続）。
// 期待値（状態・件数・hash・並び）は手で書いた値で、hash は手で書いた正規形の文字列から求める（実装の正規化を
// 使わない）。模擬の試験だけで、実機・実 API・実請求は未実施。

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { sealOperationIntent } from '@buddy/storage';
import type { ReviseContentCommand } from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { scheduleOverlaps } from './api-turns.js';
import { DeviceConnections } from './device-connections.js';
import { PreviewRegistry } from './previews.js';
import {
  DATA_KEY_MATERIAL,
  approve,
  approveBody,
  bootstrap,
  getJson,
  insertDevice,
  postJson,
  startEventCore,
  submitDurable,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import type { TestDevice } from './api-test-support.js';
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderReader,
} from './turn-ports.js';

const contract = createApiContract();

// 設計 09 §2 の時計（2026-10-05T09:00:00+09:00）と、H01 と同じ合成の口座。
const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';

interface MockProvider extends ProviderReader {
  connectionState: ProviderConnection | null;
  permissionRevision: string;
  readonly calls: string[];
}

// 合成の読み取り専用の provider。書込みの命令を持たない（外部変更の回数は構造的に 0）。
function mockProvider(): MockProvider {
  const events: ProviderEvent[] = [
    // 前日から日をまたぐ予定（今日に含む、重ならない）。
    {
      event_id: 'ev-0',
      title: '合成の予定0',
      start: '2026-10-04T23:30:00+09:00',
      end: '2026-10-05T00:30:00+09:00',
    },
    // ev-2 と重なる。
    {
      event_id: 'ev-1',
      title: '合成の予定1',
      start: '2026-10-05T09:30:00+09:00',
      end: '2026-10-05T10:30:00+09:00',
    },
    {
      event_id: 'ev-2',
      title: '合成の予定2',
      start: '2026-10-05T10:00:00+09:00',
      end: '2026-10-05T11:00:00+09:00',
    },
    // ev-2 の終了と接するだけ（重ならない）。
    {
      event_id: 'ev-3',
      title: '合成の予定3',
      start: '2026-10-05T11:00:00+09:00',
      end: '2026-10-05T12:00:00+09:00',
    },
    // 翌日（今日に含めない）。
    {
      event_id: 'ev-4',
      title: '合成の予定4',
      start: '2026-10-06T10:00:00+09:00',
      end: '2026-10-06T11:00:00+09:00',
    },
  ];
  const provider: MockProvider = {
    connectionState: {
      provider: 'mock',
      account_id: ACCOUNT,
      status: 'active',
      access: 'read_write',
    },
    permissionRevision: '1',
    calls: [],
    connection() {
      provider.calls.push('connection');
      return Promise.resolve(provider.connectionState);
    },
    readPermission(accountId) {
      provider.calls.push('readPermission');
      return Promise.resolve(
        accountId === ACCOUNT
          ? {
              account_id: ACCOUNT,
              permission_revision: provider.permissionRevision,
              scopes: ['mail.read', 'mail.labels'],
            }
          : null,
      );
    },
    readTarget(remoteId) {
      provider.calls.push('readTarget');
      return Promise.resolve(
        remoteId === 'mail-001'
          ? {
              remote_id: 'mail-001',
              source_revision: '7',
              mailbox: 'INBOX',
              labels: ['inbox'],
            }
          : null,
      );
    },
    listEvents() {
      provider.calls.push('listEvents');
      return Promise.resolve(events);
    },
  };
  return provider;
}

const READ_METHODS = new Set([
  'connection',
  'readPermission',
  'readTarget',
  'listEvents',
]);

async function startTurnCore(
  t: test.TestContext,
  provider: MockProvider,
  options: { readonly restartOf?: EventCore } = {},
): Promise<EventCore> {
  const previous = options.restartOf;
  return startEventCore(t, {
    previewValid: false,
    now: () => CLOCK,
    ...(previous === undefined
      ? {}
      : { dataDir: previous.dataDir, tlsKeyStore: previous.tlsKeyStore }),
    turns: {
      provider,
      candidates: {
        mailCandidates: () =>
          Promise.resolve([
            { candidate_id: MAIL_CANDIDATE, remote_id: 'mail-001' },
          ]),
      },
      utcOffset: '+09:00',
    },
  });
}

const createSession = async (
  core: EventCore,
  device: TestDevice,
  scope: string,
): Promise<string> => {
  const response = await postJson(core, device, '/v1/sessions', {
    request_id: randomUUID(),
    command_scope_id: scope,
    storage_mode: 'normal',
  });
  assert.equal(response.status, 201, response.text);
  assert(contract.valid('SessionReceipt', response.json), response.text);
  return String(response.json?.['session_id']);
};

const postTurn = async (
  core: EventCore,
  device: TestDevice,
  session: string,
  scope: string,
  text: string,
  requestId: string = randomUUID(),
) => {
  const response = await postJson(
    core,
    device,
    `/v1/sessions/${session}/turns`,
    {
      request_id: requestId,
      command_scope_id: scope,
      text,
      input_kind: 'text',
    },
  );
  if (response.status === 200)
    assert(contract.valid('TurnResponse', response.json), response.text);
  return response;
};

const snapshotOperations = async (core: EventCore, device: TestDevice) => {
  const snapshot = await getJson(core, device, '/v1/snapshot');
  assert.equal(snapshot.status, 200, snapshot.text);
  return snapshot.json?.['operations'] as Record<string, unknown>[];
};

const preview = async (
  core: EventCore,
  device: TestDevice,
  operationId: string,
  scope: string,
) => {
  const response = await postJson(
    core,
    device,
    `/v1/operations/${operationId}/preview`,
    { request_id: randomUUID(), command_scope_id: scope },
  );
  if (response.status === 200)
    assert(contract.valid('OperationPreview', response.json), response.text);
  return response;
};

// 「mail-001 に follow-up を付けて」の確定 intent の正規形（キーの辞書順・空白なし、手で書いた文字列）。
const labelCanonical = (operationId: string, version = '1') =>
  `{"account_id":"${ACCOUNT}","action":{"add":["follow-up"],"kind":"mail.labels.change","remove":[]},"content_version":"${version}","effects":{"external_recipients":[],"reconcile_scope":"exact_target"},"operation_id":"${operationId}","permission_revision":"1","provider":"mock","schema":"buddy.operation.v1","target":{"remote_id":"mail-001","source_revision":"7"}}`;
const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

// 「mail-001 に follow-up を付けて」で操作を作り、操作 ID を返す。
async function createLabelOperation(
  core: EventCore,
  device: TestDevice,
  scope: string,
): Promise<string> {
  const session = await createSession(core, device, scope);
  const response = await postTurn(
    core,
    device,
    session,
    scope,
    'mail-001 に follow-up を付けて',
  );
  assert.equal(response.status, 200, response.text);
  const view = response.json?.['result_view'] as Record<string, unknown>;
  const refs = view['item_refs'] as { kind: string; id: string }[];
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.kind, 'operation');
  return String(refs[0]?.id);
}

test(
  'overlaps are computed by code: touching ends do not overlap and nested intervals do',
  { timeout: 5_000 },
  () => {
    const at = (hour: number) => Date.UTC(2026, 9, 5, hour);
    assert.deepEqual(
      [
        ...scheduleOverlaps([
          { id: 'a', start: at(9), end: at(10) },
          { id: 'b', start: at(10), end: at(11) },
          { id: 'c', start: at(12), end: at(15) },
          { id: 'd', start: at(13), end: at(14) },
          { id: 'e', start: at(16), end: at(17) },
        ]),
      ].sort(),
      ['c', 'd'],
    );
    assert.equal(scheduleOverlaps([]).size, 0);
  },
);

test(
  'X02: "follow-up" makes one workflow and one awaiting operation without external changes, and both devices see it',
  { timeout: 60_000 },
  async (t) => {
    const provider = mockProvider();
    const core = await startTurnCore(t, provider);
    const one = await insertDevice(core.handle.store);
    const two = await insertDevice(core.handle.store);
    const scope1 = await bootstrap(core, one);
    const scope2 = await bootstrap(core, two);
    const session = await createSession(core, one, scope1);
    const requestId = randomUUID();
    const response = await postTurn(
      core,
      one,
      session,
      scope1,
      'mail-001 に follow-up を付けて',
      requestId,
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json?.['status'], 'answered');
    assert.equal(response.json?.['reply_text'], null);
    const workflowId = response.json?.['workflow_id'];
    assert.equal(typeof workflowId, 'string');
    const view = response.json?.['result_view'] as Record<string, unknown>;
    assert.equal(view['kind'], 'approval_link');
    assert.equal(view['status'], 'needs_review');
    assert.equal(view['intent'], 'label_mail');
    assert.equal(view['workflow_id'], workflowId);
    const operationId = String((view['item_refs'] as { id: string }[])[0]?.id);

    // 同じ要求の再送: 同じ発言・依頼・操作（二つ目を作らない）。内容が違えば 409。
    const again = await postTurn(
      core,
      one,
      session,
      scope1,
      'mail-001 に follow-up を付けて',
      requestId,
    );
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json, response.json);
    const conflict = await postTurn(
      core,
      one,
      session,
      scope1,
      '今日の予定を見せて',
      requestId,
    );
    assert.equal(conflict.status, 409, conflict.text);

    // 操作は 1 件で承認待ち、内容版 1、hash は手で書いた正規形の SHA-256。外部への変更は 0 回（読み取りだけ）。
    const expectedHash = sha256(labelCanonical(operationId));
    const ones = await snapshotOperations(core, one);
    const twos = await snapshotOperations(core, two);
    assert.equal(ones.length, 1);
    assert.deepEqual(
      ones.map((operation) => [
        operation['operation_id'],
        operation['operation_kind'],
        operation['state'],
        operation['content_version'],
        operation['content_hash'],
        operation['approval_state'],
      ]),
      [
        [
          operationId,
          'mail.labels.change',
          'awaiting_approval',
          '1',
          expectedHash,
          'none',
        ],
      ],
    );
    // 2 端末のスナップショットに同じ操作 ID・内容版・hash。
    assert.deepEqual(twos, ones);
    assert(provider.calls.every((call) => READ_METHODS.has(call)));

    // preview: 確定 intent と hash（承認ではない）。
    const shown = await preview(core, one, operationId, scope1);
    assert.equal(shown.status, 200, shown.text);
    assert.equal(shown.json?.['content_hash'], expectedHash);
    assert.equal(shown.json?.['state_revision'], '1');
    assert.deepEqual(
      shown.json?.['intent'],
      JSON.parse(labelCanonical(operationId)),
    );
    const previewId = String(shown.json?.['preview_id']);

    // 別の端末が、端末 1 に出した preview で承認する: 409。
    const other = await approve(
      core,
      two,
      operationId,
      approveBody(scope2, { previewId, hash: expectedHash }),
    );
    assert.equal(other.status, 409, other.text);
    // 発行した端末・接続範囲・内容版・hash がそろえば受け付ける（202、外部変更の成功ではない）。
    const accepted = await approve(
      core,
      one,
      operationId,
      approveBody(scope1, { previewId, hash: expectedHash }),
    );
    assert.equal(accepted.status, 202, accepted.text);
    assert.equal(accepted.json?.['status'], 'durable');
    const after = await snapshotOperations(core, two);
    assert.equal(after[0]?.['state'], 'approved');
    assert.equal(after[0]?.['approval_state'], 'valid');
  },
);

test(
  'QA27 (Read): a schedule query returns cards with overlaps computed by code and creates no approval or attempt',
  { timeout: 60_000 },
  async (t) => {
    const provider = mockProvider();
    const core = await startTurnCore(t, provider);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const session = await createSession(core, device, scope);
    const response = await postTurn(
      core,
      device,
      session,
      scope,
      '今日の予定を見せて',
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json?.['status'], 'answered');
    const view = response.json?.['result_view'] as Record<string, unknown>;
    assert.equal(view['kind'], 'schedule_cards');
    assert.equal(view['intent'], 'query_schedule');
    // 重なりがあるので確認を促す状態。
    assert.equal(view['status'], 'needs_review');
    const refs = view['item_refs'] as { kind: string; id: string }[];
    // 今日の予定 4 件（開始の順: ev-0・ev-1・ev-2・ev-3）と、重なる ev-1・ev-2 の参照。翌日の ev-4 は含めない。
    assert.deepEqual(
      refs.map((ref) => ref.kind),
      [
        'calendar_event',
        'calendar_event',
        'calendar_event',
        'calendar_event',
        'calendar_overlap',
        'calendar_overlap',
      ],
    );
    assert.equal(new Set(refs.slice(0, 4).map((ref) => ref.id)).size, 4);
    assert.deepEqual(
      refs.slice(4).map((ref) => ref.id),
      [refs[1]?.id, refs[2]?.id],
    );
    // 承認 0・試行 0（操作を作らない）。
    assert.deepEqual(await snapshotOperations(core, device), []);
    assert(provider.calls.every((call) => READ_METHODS.has(call)));
  },
);

test(
  'unknown sentences and missing arguments are clarified without operations, and tasks become LocalCommand operations',
  { timeout: 60_000 },
  async (t) => {
    const provider = mockProvider();
    const core = await startTurnCore(t, provider);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const session = await createSession(core, device, scope);

    const unknown = await postTurn(
      core,
      device,
      session,
      scope,
      '天気はどう？',
    );
    assert.equal(unknown.status, 200, unknown.text);
    assert.equal(unknown.json?.['status'], 'clarification');
    assert.equal(unknown.json?.['workflow_id'], null);
    assert.equal(unknown.json?.['result_view'], null);
    assert.equal(typeof unknown.json?.['reply_text'], 'string');

    // 意図は分かるが題名がない: 依頼は作り、聞き返す（操作は作らない）。
    const missing = await postTurn(
      core,
      device,
      session,
      scope,
      '用事を登録して',
    );
    assert.equal(missing.status, 200, missing.text);
    assert.equal(missing.json?.['status'], 'clarification');
    assert.equal(typeof missing.json?.['workflow_id'], 'string');
    const missingView = missing.json?.['result_view'] as Record<
      string,
      unknown
    >;
    assert.equal(missingView['kind'], 'clarification');
    assert.equal(missingView['status'], 'confirming_input');

    // 対象の候補がないメール: 対象を解決できず聞き返し。
    const noTarget = await postTurn(
      core,
      device,
      session,
      scope,
      'mail-999 に follow-up を付けて',
    );
    assert.equal(noTarget.json?.['status'], 'clarification');
    // すでに付いているラベル: 変更がないので聞き返し（操作を作らない）。
    const noChange = await postTurn(
      core,
      device,
      session,
      scope,
      'mail-001 に inbox を付けて',
    );
    assert.equal(noChange.json?.['status'], 'clarification');
    // 接続が読み取りだけ: 外部変更の操作を作らない。
    provider.connectionState = {
      provider: 'mock',
      account_id: ACCOUNT,
      status: 'active',
      access: 'read',
    };
    const readOnly = await postTurn(
      core,
      device,
      session,
      scope,
      'mail-001 に follow-up を付けて',
    );
    assert.equal(readOnly.json?.['status'], 'clarification');
    assert.deepEqual(await snapshotOperations(core, device), []);

    // 用事の登録（LocalCommand）: 自動実行は off なので承認待ちで作る。
    const task = await postTurn(
      core,
      device,
      session,
      scope,
      '「牛乳を買う」を用事に登録して',
    );
    assert.equal(task.status, 200, task.text);
    assert.equal(task.json?.['status'], 'answered');
    const operations = await snapshotOperations(core, device);
    assert.deepEqual(
      operations.map((operation) => [
        operation['operation_kind'],
        operation['state'],
        operation['content_version'],
      ]),
      [['task.create', 'awaiting_approval', '1']],
    );
    const operationId = String(operations[0]?.['operation_id']);
    const shown = await preview(core, device, operationId, scope);
    assert.equal(shown.status, 200, shown.text);
    const canonical = `{"action":{"body":null,"due":null,"kind":"task.create","title":"牛乳を買う"},"content_version":"1","effects":{"external_recipients":[],"reconcile_scope":"local_transaction"},"operation_id":"${operationId}","permission_revision":"0","schema":"buddy.operation.v1","target":{"list_id":"inbox"}}`;
    assert.equal(shown.json?.['content_hash'], sha256(canonical));
    assert.equal(operations[0]?.['content_hash'], sha256(canonical));
  },
);

test(
  'sessions: the same request returns the same session, other content is 409 and private sessions are not accepted yet',
  { timeout: 60_000 },
  async (t) => {
    const core = await startTurnCore(t, mockProvider());
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const body = {
      request_id: randomUUID(),
      command_scope_id: scope,
      storage_mode: 'normal',
    };
    const first = await postJson(core, device, '/v1/sessions', body);
    assert.equal(first.status, 201, first.text);
    assert.equal(first.json?.['route_revision'], '0');
    const again = await postJson(core, device, '/v1/sessions', body);
    assert.deepEqual(again.json, first.json);
    const changed = await postJson(core, device, '/v1/sessions', {
      ...body,
      storage_mode: 'extended',
    });
    assert.equal(changed.status, 409, changed.text);
    const privateMode = await postJson(core, device, '/v1/sessions', {
      ...body,
      request_id: randomUUID(),
      storage_mode: 'private',
    });
    assert.equal(privateMode.status, 503, privateMode.text);
    // 知らない会話への発言は 409。
    const orphan = await postTurn(
      core,
      device,
      randomUUID(),
      scope,
      '今日の予定を見せて',
    );
    assert.equal(orphan.status, 409, orphan.text);
  },
);

test(
  'X03 / X04: a preview from an old command scope, after a content change, a lock, a permission change or a restart cannot approve (410 / 409)',
  { timeout: 90_000 },
  async (t) => {
    const provider = mockProvider();
    const core = await startTurnCore(t, provider);
    const device = await insertDevice(core.handle.store);
    let scope = await bootstrap(core, device);
    const operationId = await createLabelOperation(core, device, scope);
    const hash1 = sha256(labelCanonical(operationId));

    // 古い接続範囲: 再接続の後、古い接続範囲の承認は 410。新しい接続範囲でも古い preview は 409。
    let shown = await preview(core, device, operationId, scope);
    assert.equal(shown.status, 200, shown.text);
    const oldScope = scope;
    scope = await bootstrap(core, device);
    const stale = await approve(
      core,
      device,
      operationId,
      approveBody(oldScope, {
        previewId: String(shown.json?.['preview_id']),
        hash: hash1,
      }),
    );
    assert.equal(stale.status, 410, stale.text);
    const crossScope = await approve(
      core,
      device,
      operationId,
      approveBody(scope, {
        previewId: String(shown.json?.['preview_id']),
        hash: hash1,
      }),
    );
    assert.equal(crossScope.status, 409, crossScope.text);

    // ロック: ロック中の判定でその端末の preview を無効にする。解除の後も古い preview は 409。
    shown = await preview(core, device, operationId, scope);
    assert.equal(shown.status, 200, shown.text);
    core.env.lock = 'locked';
    const locked = await getJson(core, device, '/v1/snapshot');
    assert.equal(locked.json?.['view'], 'management_only');
    core.env.lock = 'unlocked';
    const afterLock = await approve(
      core,
      device,
      operationId,
      approveBody(scope, {
        previewId: String(shown.json?.['preview_id']),
        hash: hash1,
      }),
    );
    assert.equal(afterLock.status, 409, afterLock.text);

    // 許可の版の変更: preview の後に許可の版が変われば 409。
    shown = await preview(core, device, operationId, scope);
    assert.equal(shown.status, 200, shown.text);
    provider.permissionRevision = '2';
    const afterPermission = await approve(
      core,
      device,
      operationId,
      approveBody(scope, {
        previewId: String(shown.json?.['preview_id']),
        hash: hash1,
      }),
    );
    assert.equal(afterPermission.status, 409, afterPermission.text);
    // 許可の版が確定 intent と違う間は preview も出さない。
    assert.equal((await preview(core, device, operationId, scope)).status, 409);
    provider.permissionRevision = '1';

    // 内容の変更（D1、同じ操作 ID で内容版 2）: 版 1 の preview では、版 1 でも版 2 でも承認できない（409）。
    shown = await preview(core, device, operationId, scope);
    assert.equal(shown.status, 200, shown.text);
    const v2 = { ...JSON.parse(labelCanonical(operationId, '2')) };
    const sealed = sealOperationIntent(
      DATA_KEY_MATERIAL,
      { operationId, contentVersion: 2 },
      v2,
    );
    assert(sealed.ok);
    const hash2 = sha256(labelCanonical(operationId, '2'));
    assert.equal(sealed.content_hash, hash2);
    const revise: ReviseContentCommand = {
      command_id: randomUUID(),
      kind: 'operation.revise_content',
      operation_id: operationId,
      expected_state_revision: '1',
      request_revision: '1',
      permission_revision: '1',
      forgetting_generation: '0',
      connection_id: null,
      request: null,
      content_version: '2',
      content_hash: sealed.content_hash,
      intent: sealed.intent,
    };
    await submitDurable(core, revise);
    for (const body of [
      approveBody(scope, {
        previewId: String(shown.json?.['preview_id']),
        hash: hash1,
        expected: '2',
      }),
      {
        ...approveBody(scope, {
          previewId: String(shown.json?.['preview_id']),
          hash: hash2,
          expected: '2',
        }),
        content_version: '2',
      },
    ]) {
      const response = await approve(core, device, operationId, body);
      assert.equal(response.status, 409, response.text);
    }
    const snapshot = await snapshotOperations(core, device);
    assert.deepEqual(
      snapshot.map((operation) => [
        operation['operation_id'],
        operation['state'],
        operation['content_version'],
        operation['content_hash'],
      ]),
      [[operationId, 'awaiting_approval', '2', hash2]],
    );

    // 再起動: preview はメモリーだけにあるので、再起動の前の preview は新しい接続範囲でも 409。
    shown = await preview(core, device, operationId, scope);
    assert.equal(shown.status, 200, shown.text);
    assert.equal(shown.json?.['content_hash'], hash2);
    await core.handle.stop('test');
    const restarted = await startTurnCore(t, provider, { restartOf: core });
    const freshScope = await bootstrap(restarted, device);
    const afterRestart = await approve(restarted, device, operationId, {
      ...approveBody(freshScope, {
        previewId: String(shown.json?.['preview_id']),
        hash: hash2,
        expected: '2',
      }),
      content_version: '2',
    });
    assert.equal(afterRestart.status, 409, afterRestart.text);
    // 新しい preview なら承認できる（版 2）。
    const fresh = await preview(restarted, device, operationId, freshScope);
    assert.equal(fresh.status, 200, fresh.text);
    const accepted = await approve(restarted, device, operationId, {
      ...approveBody(freshScope, {
        previewId: String(fresh.json?.['preview_id']),
        hash: hash2,
        expected: '2',
      }),
      content_version: '2',
    });
    assert.equal(accepted.status, 202, accepted.text);
  },
);

test(
  'previews are dropped when the device connection ends and replaced by a newer preview of the same operation',
  { timeout: 5_000 },
  () => {
    const previews = new PreviewRegistry();
    const connections = new DeviceConnections();
    connections.onDeviceClosed((deviceId) => {
      previews.invalidateDevice(deviceId);
    });
    const binding = (
      previewId: string,
      deviceId: string,
      operationId: string,
    ) => ({
      preview_id: previewId,
      device_id: deviceId,
      command_scope_id: 's',
      operation_id: operationId,
      content_version: '1',
      content_hash: 'a'.repeat(64),
      account: null,
      issued_at: 0,
    });
    previews.issue(binding('p1', 'd1', 'o1'));
    previews.issue(binding('p2', 'd1', 'o2'));
    previews.issue(binding('p3', 'd2', 'o1'));
    // 同じ端末・同じ操作の新しい preview は古いものを置き換える。
    previews.issue(binding('p4', 'd1', 'o1'));
    assert.equal(previews.get('p1'), null);
    assert.equal(previews.count(), 3);
    // 開いている接続がなくても、接続の終了（失効・自宅判定の不成立）でその端末の preview を無効にする。
    assert.equal(connections.closeDevice('d1', 'device_revoked'), 0);
    assert.equal(previews.get('p2'), null);
    assert.equal(previews.get('p4'), null);
    assert.equal(previews.get('p3')?.device_id, 'd2');
  },
);
