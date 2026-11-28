// 自動で作った自分だけの予定の取り消し（POST /v1/auto-actions/{id}/undo、B13-05、U310 の予定、ADR 0198）の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬）。提供元は試験の中の合成の読み書きの口で、操作は合成の
// 自分だけの予定の作成（方針で自動承認、作成物は event-0101）。実アカウント・実データは使わない。
// 製品では予定の取り消しを閉じている（CALENDAR_EVENT_UNDO_OPEN は false。本人の決定待ち）。試験は閉じたときの見え方と、
// 開いたとき（CoreTurnOptions.calendarEventUndo）の経路を確かめる。
// 期待値は設計 03「取り消しと安全停止」・J12・ADR 0156（下書きの削除と同じ考え方）・ADR 0198（Buddy が作ったままの予定だけを
// 版を条件にして削除する。参加者・繰り返し・本人の編集・消えた予定は 409 target_changed。結果不明は再送しない）から手で書いた値。
// 模擬の試験だけで、実機・実 API（Google Calendar・Microsoft）は未実施。

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
  CALENDAR_EVENT_UNDO_OPEN,
  eventCreationOf,
  eventUnchanged,
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
import { eventDeleteObserved } from './operation-runner.js';
import { pinnedRequest, sharedApiContract } from './api-test-support.js';
import type { ApiResponse, TestDevice } from './api-test-support.js';
import { DB_FILE } from './paths.js';
import type {
  ProviderEventContent,
  ProviderReader,
  ProviderWriteOutcome,
  ProviderWriter,
} from './turn-ports.js';

const contract = sharedApiContract();
type Json = Record<string, unknown>;
const SCREEN = { 'buddy-input-origin': 'screen' } as const;
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const CALENDAR = 'primary';
const EVENT = 'event-0101';
const CREATED = {
  calendar_id: CALENDAR,
  summary: '（合成）歯科の予約',
  start: '2030-10-07T17:00:00',
  end: '2030-10-07T17:30:00',
  time_zone: 'Asia/Tokyo',
};

// 合成の提供元。予定を 1 件持ち、id での読み取りと、版が合うときだけの削除を受ける。
interface FakeEvents {
  event: ProviderEventContent | null;
  reads: number;
  onRead?: (reads: number) => void;
  // 削除の応答を差し替える（結果不明など）。省略は版を見て消す。
  respond?: () => ProviderWriteOutcome<{ readonly event_id: string }> | null;
  readonly deletes: {
    calendar_id: string;
    event_id: string;
    source_revision: string;
  }[];
}

function fakeProvider(events: FakeEvents): {
  reader: ProviderReader;
  writer: ProviderWriter;
} {
  const reader: ProviderReader = {
    connection: () =>
      Promise.resolve({
        provider: 'mock',
        account_id: ACCOUNT,
        status: 'active',
        access: 'read_write',
        writable_kinds: ['calendar.event.delete'],
        readable_kinds: ['calendar.events'],
      }),
    readPermission: (accountId) =>
      Promise.resolve(
        accountId === ACCOUNT
          ? {
              account_id: ACCOUNT,
              permission_revision: '1',
              scopes: ['calendar.read', 'calendar.events.delete'],
            }
          : null,
      ),
    readTarget: () => Promise.resolve(null),
    listEvents: () => Promise.resolve([]),
    readEvent: (calendarId, eventId) => {
      events.reads += 1;
      events.onRead?.(events.reads);
      const event = events.event;
      return Promise.resolve(
        event !== null &&
          event.calendar_id === calendarId &&
          event.event_id === eventId
          ? { ...event }
          : null,
      );
    },
  };
  return {
    reader,
    writer: {
      changeLabels: () => Promise.resolve({ kind: 'not_sent' }),
      deleteEvent: (_identity, request) => {
        events.deletes.push({ ...request });
        const forced = events.respond?.() ?? null;
        if (forced !== null) return Promise.resolve(forced);
        const event = events.event;
        if (event === null || event.event_id !== request.event_id)
          return Promise.resolve({
            kind: 'rejected',
            status: 404,
            code: 'not_found',
          });
        if (event.revision !== request.source_revision)
          return Promise.resolve({
            kind: 'rejected',
            status: 412,
            code: 'precondition_failed',
          });
        events.event = null;
        return Promise.resolve({
          kind: 'applied',
          status: 204,
          value: { event_id: request.event_id },
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
  events: FakeEvents,
  options: { readonly open?: boolean } = { open: true },
): Promise<Harness> {
  const ports = fakeProvider(events);
  const core = await startEventCore(t, {
    turns: {
      provider: ports.reader,
      writer: ports.writer,
      ...(options.open === undefined
        ? {}
        : { calendarEventUndo: options.open }),
    },
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

// 方針で自動承認した自分だけの予定の作成を、準備・送出・結果まで進める（結果の版は 5、作成物は EVENT）。
async function seedAutoEvent(h: Harness): Promise<string> {
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
      target: null,
      action: { kind: 'calendar.event.create', ...CREATED },
      effects: { external_recipients: [], reconcile_scope: 'operation_marker' },
    },
  );
  assert(sealed.ok);
  const create: CreateOperationCommand = {
    ...base(operationId, '0'),
    kind: 'operation.create',
    workflow_id: null,
    operation_kind: 'calendar.event.create',
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
    step: { step_id: '1-create_event', step_kind: 'create_event' },
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
      external_id: EVENT,
    });
  return operationId;
}

const createdEvent = (operationId: string): ProviderEventContent => ({
  event_id: EVENT,
  revision: 'e1',
  status: 'confirmed',
  marker: operationMarker(operationId, '1'),
  attendee_count: 0,
  recurring: false,
  location: null,
  description: null,
  ...CREATED,
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

async function list(h: Harness): Promise<Json> {
  const response = await pinnedRequest(h.core.target, {
    method: 'GET',
    path: '/v1/auto-actions',
    headers: bearer(h.device.token),
  });
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('AutoActionList', response.json), response.text);
  return response.json as Json;
}

async function undoStates(h: Harness): Promise<string[]> {
  return ((await list(h))['items'] as Json[]).map((item) =>
    String(item['undo_state']),
  );
}

const operationState = (h: Harness, operationId: string): unknown =>
  h.sql((db) =>
    db
      .prepare('SELECT state FROM operations WHERE operation_id = ?')
      .get(operationId),
  );

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('did not reach the expected state');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test('in the product the event undo stays closed: the row is unavailable and a press is refused without reading', async (t) => {
  assert.equal(CALENDAR_EVENT_UNDO_OPEN, false);
  const events: FakeEvents = { event: null, reads: 0, deletes: [] };
  // 起動の設定で開かない（製品の既定のまま）。
  const h = await start(t, events, {});
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  const items = (await list(h))['items'] as Json[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.['action_kind'], 'create_event');
  assert.equal(items[0]?.['undo_state'], 'unavailable');
  const response = await undoRequest(h, operationId);
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json?.['code'], 'conflict');
  assert.equal(events.reads, 0);
  assert.deepEqual(events.deletes, []);
});

test('when opened, undo deletes the event Buddy created, with its revision, through a compensation approved by the press', async (t) => {
  const events: FakeEvents = { event: null, reads: 0, deletes: [] };
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  assert.deepEqual(await undoStates(h), ['available']);

  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, requestId);
  assert.equal(accepted.status, 202, accepted.text);
  assert(contract.valid('CommandReceipt', accepted.json), accepted.text);
  const compensationId = undoOperationId(h.scope, requestId);
  assert.equal((accepted.json as Json)['operation_id'], compensationId);

  await waitFor(async () => (await undoStates(h))[0] === 'undone');
  assert.deepEqual(events.deletes, [
    { calendar_id: CALENDAR, event_id: EVENT, source_revision: 'e1' },
  ]);
  assert.equal(events.event, null);
  assert.deepEqual(
    h.sql((db) =>
      db
        .prepare(
          'SELECT o.kind, o.state, a.route FROM operations o JOIN approvals a ON a.operation_id = o.operation_id WHERE o.operation_id = ?',
        )
        .get(compensationId),
    ),
    { kind: 'calendar.event.delete', state: 'succeeded', route: 'screen' },
  );
  // 同じ要求の再送は二つ目を作らない。
  const again = await undoRequest(h, operationId, requestId);
  assert.equal(again.status, 202, again.text);
  await settle();
  assert.equal(events.deletes.length, 1);
});

test('an event with attendees, made recurring, edited, cancelled or gone is not deleted automatically (409 target_changed)', async (t) => {
  const events: FakeEvents = { event: null, reads: 0, deletes: [] };
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  const created = createdEvent(operationId);
  const changes: readonly (ProviderEventContent | null)[] = [
    { ...created, attendee_count: 1 },
    { ...created, recurring: true },
    { ...created, summary: '（合成）歯科の予約（変更）' },
    { ...created, start: '2030-10-07T18:00:00', end: '2030-10-07T18:30:00' },
    { ...created, location: '（合成）駅前の歯科' },
    { ...created, description: '持ち物: 保険証' },
    { ...created, status: 'cancelled' },
    { ...created, marker: operationMarker(randomUUID(), '1') },
    { ...created, marker: null },
    null,
  ];
  for (const event of changes) {
    events.event = event;
    const response = await undoRequest(h, operationId);
    assert.equal(response.status, 409, response.text);
    assert(contract.valid('ApiError', response.json), response.text);
    assert.equal(response.json?.['code'], 'target_changed');
  }
  assert.deepEqual(events.deletes, []);
  assert.deepEqual(await undoStates(h), ['available']);
});

test('an event edited after the press is not deleted: the runner rechecks its revision before sending', async (t) => {
  const events: FakeEvents = { event: null, reads: 0, deletes: [] };
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  // 経路の読み取り（1 回目）の後、実行担当の確かめ直し（2 回目）の前に本人が予定に参加者を足す（版も進む）。
  events.onRead = (reads) => {
    if (reads === 2 && events.event !== null)
      events.event = { ...events.event, revision: 'e2', attendee_count: 1 };
  };
  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, requestId);
  assert.equal(accepted.status, 202, accepted.text);
  await waitFor(() => events.reads >= 2);
  await settle();
  assert.deepEqual(events.deletes, []);
  assert.notEqual(events.event, null);
  assert.deepEqual(operationState(h, undoOperationId(h.scope, requestId)), {
    state: 'preparing',
  });
  assert.deepEqual(await undoStates(h), ['in_progress']);
});

test('an unknown delete outcome is reconciled once by reading the event and never resent', async (t) => {
  const events: FakeEvents = { event: null, reads: 0, deletes: [] };
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  // 応答を失い、予定は残っている（届いていない）。
  events.respond = () => ({ kind: 'unknown', reason: 'timeout' });
  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, requestId);
  assert.equal(accepted.status, 202, accepted.text);
  const compensationId = undoOperationId(h.scope, requestId);
  await waitFor(
    () =>
      (operationState(h, compensationId) as { state: string }).state ===
      'unknown_held',
  );
  await settle();
  assert.equal(events.deletes.length, 1);
  assert.notEqual(events.event, null);
  // 取り消しは結果の確認中（in_progress）として見せ、同じ自動実行を取り消し直させない。
  assert.deepEqual(await undoStates(h), ['in_progress']);
  const again = await undoRequest(h, operationId);
  assert.equal(again.status, 409, again.text);
  assert.equal(events.deletes.length, 1);
});

test('an unknown delete outcome whose event is gone on the follow-up read counts as undone', async (t) => {
  const events: FakeEvents = { event: null, reads: 0, deletes: [] };
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  // 相手は消したが応答が届かなかった。
  events.respond = () => {
    events.event = null;
    return { kind: 'unknown', reason: 'connection_reset' };
  };
  const accepted = await undoRequest(h, operationId);
  assert.equal(accepted.status, 202, accepted.text);
  await waitFor(async () => (await undoStates(h))[0] === 'undone');
  assert.equal(events.deletes.length, 1);
});

test('during a safety stop the press is recorded but the delete is not sent', async (t) => {
  const events: FakeEvents = { event: null, reads: 0, deletes: [] };
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  h.sql((db) =>
    db
      .prepare(
        "INSERT INTO safety_breaker (singleton, state, safety_revision, stop_reason, stopped_at, resumed_by_device_id) VALUES (1, 'stopped', 1, 'rate_exceeded', ?, NULL) ON CONFLICT (singleton) DO UPDATE SET state = 'stopped', safety_revision = safety_revision + 1, stop_reason = 'rate_exceeded', stopped_at = excluded.stopped_at",
      )
      .run(Date.now()),
  );
  assert.equal(((await list(h))['safety'] as Json)['state'], 'stopped');
  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, requestId);
  assert.equal(accepted.status, 202, accepted.text);
  await waitFor(() => events.reads >= 2);
  await settle();
  assert.deepEqual(events.deletes, []);
  assert.deepEqual(operationState(h, undoOperationId(h.scope, requestId)), {
    state: 'preparing',
  });
});

test('the pure checks: which kinds can be undone, the unchanged event and the delete reconciliation', () => {
  const reads = {
    readDraft: () => Promise.resolve(null),
    readEvent: () => Promise.resolve(null),
  };
  assert.deepEqual(undoableKindsOf(reads), [
    'label_mail',
    'draft_reply',
    'create_task',
  ]);
  assert.deepEqual(undoableKindsOf(reads, { calendarEventUndo: true }), [
    'label_mail',
    'draft_reply',
    'create_task',
    'create_event',
  ]);
  assert.deepEqual(undoableKindsOf({}, { calendarEventUndo: true }), [
    'label_mail',
    'create_task',
  ]);
  const operationId = randomUUID();
  const creation = eventCreationOf({
    operation_id: operationId,
    content_version: '1',
    provider: 'mock',
    account_id: ACCOUNT,
    target: null,
    action: { kind: 'calendar.event.create', ...CREATED },
  });
  assert(creation !== null);
  assert.equal(eventUnchanged(createdEvent(operationId), creation), true);
  assert.equal(
    eventUnchanged(
      { ...createdEvent(operationId), calendar_id: 'other' },
      creation,
    ),
    false,
  );
  assert.equal(
    eventUnchanged(
      { ...createdEvent(operationId), time_zone: 'UTC' },
      creation,
    ),
    false,
  );
  assert.equal(
    eventCreationOf({
      action: { kind: 'calendar.event.create_with_attendees' },
    }),
    null,
  );
  assert.deepEqual(eventDeleteObserved(null, { remote_id: EVENT }), {
    kind: 'found',
    external_id: EVENT,
  });
  assert.deepEqual(
    eventDeleteObserved(
      { ...createdEvent(operationId), status: 'cancelled' },
      { remote_id: EVENT },
    ),
    { kind: 'found', external_id: EVENT },
  );
  assert.deepEqual(
    eventDeleteObserved(createdEvent(operationId), { remote_id: EVENT }),
    { kind: 'not_found' },
  );
  assert.deepEqual(
    eventDeleteObserved(
      { ...createdEvent(operationId), event_id: 'event-0102' },
      { remote_id: EVENT },
    ),
    { kind: 'unreadable' },
  );
});
