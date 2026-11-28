// 自動で作った自分だけの予定の取り消し（POST /v1/auto-actions/{id}/undo、B13-05、U310 の予定、ADR 0198）の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬）。提供元は試験の中の合成の読み書きの口で、操作は合成の
// 自分だけの予定の作成（方針で自動承認、作成物は event-0101）。実アカウント・実データは使わない。
// 製品では予定の取り消しを閉じている（CALENDAR_EVENT_UNDO_OPEN は false。本人の決定待ち）。試験は閉じたときの見え方と、
// 開いたとき（CoreTurnOptions.calendarEventUndo）の経路を確かめる。
// 期待値は設計 03「取り消しと安全停止」・J12・ADR 0156（下書きの削除と同じ考え方）・ADR 0198（Buddy が作ったままの予定だけを
// 版を条件にして削除する。参加者・繰り返し・本人の編集・消えた予定は 409 target_changed。結果不明は再送しない。照合は
// 同じ口座で、削除済みと見えないを分ける）から手で書いた値。目印・補償の操作の ID は検査対象の関数で作らない。
// 模擬の試験だけで、実機・実 API（Google Calendar・Microsoft）は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
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
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000003';
const CALENDAR = 'primary';
const EVENT = 'event-0101';
const CREATED = {
  calendar_id: CALENDAR,
  summary: '（合成）歯科の予約',
  start: '2030-10-07T17:00:00',
  end: '2030-10-07T17:30:00',
  time_zone: 'Asia/Tokyo',
};
// 操作の目印（buddy-op:<操作 ID>:<内容版>）を手で書く。
const markerOf = (operationId: string): string => `buddy-op:${operationId}:1`;

// 合成の提供元。予定を 1 件持ち、id での読み取りと、版が合うときだけの削除を受ける。予定が無いときは、削除済みと
// 分かる（deleted）か、このカレンダーで見えない（missing）かを gone で決める。
interface FakeEvents {
  event: ProviderEventContent | null;
  gone: 'deleted' | 'missing';
  // 接続の口座と書込みの範囲（押下の後に口座を付け替える・範囲を外す、などに使う）。
  account: string;
  writable: string[];
  reads: number;
  onRead?: (reads: number) => void;
  // 削除の応答を差し替える（結果不明・412 など）。省略は版を見て消す。
  respond?: () => ProviderWriteOutcome<{ readonly event_id: string }> | null;
  readonly deletes: {
    calendar_id: string;
    event_id: string;
    source_revision: string;
  }[];
}

const fakeEvents = (): FakeEvents => ({
  event: null,
  gone: 'deleted',
  account: ACCOUNT,
  writable: ['calendar.event.delete'],
  reads: 0,
  deletes: [],
});

function fakeProvider(events: FakeEvents): {
  reader: ProviderReader;
  writer: ProviderWriter;
} {
  const reader: ProviderReader = {
    connection: () =>
      Promise.resolve({
        provider: 'mock',
        account_id: events.account,
        status: 'active',
        access: 'read_write',
        writable_kinds: [...events.writable],
        readable_kinds: ['calendar.events'],
      }),
    readPermission: (accountId) =>
      Promise.resolve(
        accountId === events.account
          ? {
              account_id: events.account,
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
          ? { kind: 'found', event: { ...event } }
          : { kind: events.event === null ? events.gone : 'missing' },
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
        events.gone = 'deleted';
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
  marker: markerOf(operationId),
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

// 受け付けた補償の操作の ID（受付の応答から読む。検査対象の関数で作らない）。
async function accept(h: Harness, operationId: string): Promise<string> {
  const accepted = await undoRequest(h, operationId);
  assert.equal(accepted.status, 202, accepted.text);
  assert(contract.valid('CommandReceipt', accepted.json), accepted.text);
  const compensationId = String((accepted.json as Json)['operation_id']);
  assert.notEqual(compensationId, operationId);
  return compensationId;
}

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

const stateOf = (h: Harness, operationId: string): string =>
  (operationState(h, operationId) as { state: string } | undefined)?.state ??
  '';

const undoRecords = (h: Harness): unknown[] =>
  h.sql((db) =>
    db
      .prepare(
        'SELECT compensation_operation_id, status FROM undo_records ORDER BY requested_at, rowid',
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test('in the product the event undo stays closed: the row is unavailable and a press is refused without reading', async (t) => {
  assert.equal(CALENDAR_EVENT_UNDO_OPEN, false);
  const events = fakeEvents();
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
  const events = fakeEvents();
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  assert.deepEqual(await undoStates(h), ['available']);

  const requestId = randomUUID();
  const accepted = await undoRequest(h, operationId, requestId);
  assert.equal(accepted.status, 202, accepted.text);
  assert(contract.valid('CommandReceipt', accepted.json), accepted.text);
  const compensationId = String((accepted.json as Json)['operation_id']);

  await waitFor(async () => (await undoStates(h))[0] === 'undone');
  assert.deepEqual(events.deletes, [
    { calendar_id: CALENDAR, event_id: EVENT, source_revision: 'e1' },
  ]);
  assert.equal(events.event, null);
  // 予定の削除の操作は 1 つだけで、受付が返した ID のもの。押下が画面の承認になっている。
  assert.deepEqual(
    h.sql((db) =>
      db
        .prepare(
          "SELECT o.operation_id, o.state, a.route FROM operations o JOIN approvals a ON a.operation_id = o.operation_id WHERE o.kind = 'calendar.event.delete'",
        )
        .all(),
    ),
    [{ operation_id: compensationId, state: 'succeeded', route: 'screen' }],
  );
  // 同じ要求の再送は同じ受付で、二つ目を作らない。
  const again = await undoRequest(h, operationId, requestId);
  assert.equal(again.status, 202, again.text);
  assert.equal((again.json as Json)['operation_id'], compensationId);
  await settle();
  assert.equal(events.deletes.length, 1);
});

test('an event with attendees, made recurring, edited, cancelled, moved or gone is not deleted automatically (409 target_changed)', async (t) => {
  const events = fakeEvents();
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  const created = createdEvent(operationId);
  const changes: readonly [
    ProviderEventContent | null,
    'deleted' | 'missing',
  ][] = [
    [{ ...created, attendee_count: 1 }, 'deleted'],
    [{ ...created, recurring: true }, 'deleted'],
    [{ ...created, summary: '（合成）歯科の予約（変更）' }, 'deleted'],
    [
      {
        ...created,
        start: '2030-10-07T18:00:00',
        end: '2030-10-07T18:30:00',
      },
      'deleted',
    ],
    [{ ...created, location: '（合成）駅前の歯科' }, 'deleted'],
    [{ ...created, description: '持ち物: 保険証' }, 'deleted'],
    [{ ...created, status: 'cancelled' }, 'deleted'],
    [
      {
        ...created,
        marker: markerOf('00000000-0000-4000-8000-0000000009aa'),
      },
      'deleted',
    ],
    [{ ...created, marker: null }, 'deleted'],
    // 別のカレンダーへ移した（このカレンダーでは見えない）。
    [{ ...created, calendar_id: 'other-calendar' }, 'deleted'],
    [null, 'deleted'],
    [null, 'missing'],
  ];
  for (const [event, gone] of changes) {
    events.event = event;
    events.gone = gone;
    const response = await undoRequest(h, operationId);
    assert.equal(response.status, 409, response.text);
    assert(contract.valid('ApiError', response.json), response.text);
    assert.equal(response.json?.['code'], 'target_changed');
  }
  assert.deepEqual(events.deletes, []);
  assert.deepEqual(await undoStates(h), ['available']);
});

test('a press while the connection is another account is 409 target_changed; without the delete scope it is 503', async (t) => {
  const events = fakeEvents();
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  events.account = OTHER_ACCOUNT;
  const other = await undoRequest(h, operationId);
  assert.equal(other.status, 409, other.text);
  assert.equal(other.json?.['code'], 'target_changed');
  events.account = ACCOUNT;
  events.writable = [];
  const unwritable = await undoRequest(h, operationId);
  assert.equal(unwritable.status, 503, unwritable.text);
  assert.equal(unwritable.json?.['code'], 'dependency_unavailable');
  // どちらも予定を読まず（口座が違う・書けない段階で止まる）、消さない。
  assert.equal(events.reads, 0);
  assert.deepEqual(events.deletes, []);
  assert.deepEqual(undoRecords(h), []);
});

test('an event edited after the press is not deleted: the runner rechecks its revision before sending', async (t) => {
  const events = fakeEvents();
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  // 経路の読み取り（1 回目）の後、実行担当の確かめ直し（2 回目）の前に本人が予定に参加者を足す（版も進む）。
  events.onRead = (reads) => {
    if (reads === 2 && events.event !== null)
      events.event = { ...events.event, revision: 'e2', attendee_count: 1 };
  };
  const compensationId = await accept(h, operationId);
  await waitFor(() => events.reads >= 2);
  await settle();
  assert.deepEqual(events.deletes, []);
  assert.notEqual(events.event, null);
  assert.equal(stateOf(h, compensationId), 'preparing');
  assert.deepEqual(await undoStates(h), ['in_progress']);
});

test('an unknown delete outcome is reconciled by reading the event exactly once and never resent', async (t) => {
  const events = fakeEvents();
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  // 応答を失い、予定は残っている（届いていない）。
  events.respond = () => ({ kind: 'unknown', reason: 'timeout' });
  const compensationId = await accept(h, operationId);
  await waitFor(() => stateOf(h, compensationId) === 'unknown_held');
  await settle();
  assert.equal(events.deletes.length, 1);
  assert.notEqual(events.event, null);
  // 押下の読み取り 1 回・送る直前の確かめ直し 1 回・結果不明の照合 1 回。
  assert.equal(events.reads, 3);
  // 取り消しは結果の確認中（in_progress）として見せ、同じ自動実行を取り消し直させない。
  assert.deepEqual(await undoStates(h), ['in_progress']);
  const again = await undoRequest(h, operationId);
  assert.equal(again.status, 409, again.text);
  assert.equal(events.deletes.length, 1);
});

test('an unknown delete outcome whose event reads as deleted counts as undone', async (t) => {
  const events = fakeEvents();
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  // 相手は消したが応答が届かなかった。
  events.respond = () => {
    events.event = null;
    events.gone = 'deleted';
    return { kind: 'unknown', reason: 'connection_reset' };
  };
  await accept(h, operationId);
  await waitFor(async () => (await undoStates(h))[0] === 'undone');
  assert.equal(events.deletes.length, 1);
});

test('an unknown delete outcome is not taken as undone when the event is only invisible or the account changed', async (t) => {
  for (const situation of ['moved', 'account'] as const) {
    const events = fakeEvents();
    const h = await start(t, events);
    const operationId = await seedAutoEvent(h);
    events.event = createdEvent(operationId);
    events.respond = () => {
      if (situation === 'moved') {
        // 別のカレンダーへ移された（このカレンダーでは 404）。
        events.event = null;
        events.gone = 'missing';
      } else {
        // 口座を付け替えた（新しい口座では予定が削除済みに見える）。
        events.account = OTHER_ACCOUNT;
        events.event = null;
        events.gone = 'deleted';
      }
      return { kind: 'unknown', reason: 'timeout' };
    };
    const compensationId = await accept(h, operationId);
    await waitFor(() => stateOf(h, compensationId) === 'unknown_held');
    await settle();
    assert.equal(stateOf(h, compensationId), 'unknown_held', situation);
    assert.deepEqual(await undoStates(h), ['in_progress'], situation);
    assert.equal(events.deletes.length, 1, situation);
    // 口座が違えば照合で予定を読まない（押下・確かめ直しの 2 回だけ）。
    assert.equal(events.reads, situation === 'account' ? 2 : 3, situation);
  }
});

test('a delete refused for a changed revision (412) is not executed; the undo fails and three in a row stop automation', async (t) => {
  const events = fakeEvents();
  const h = await start(t, events);
  const operationId = await seedAutoEvent(h);
  events.event = createdEvent(operationId);
  events.respond = () => ({
    kind: 'rejected',
    status: 412,
    code: 'precondition_failed',
  });
  const compensations: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const compensationId = await accept(h, operationId);
    compensations.push(compensationId);
    await waitFor(() => stateOf(h, compensationId) === 'not_executed');
    // 送らなかったことが確かなので、取り消しは失敗で、同じ自動実行をもう一度取り消せる。
    await waitFor(async () => (await undoStates(h))[0] === 'available');
  }
  assert.equal(events.deletes.length, 3);
  assert.notEqual(events.event, null);
  assert.deepEqual(
    undoRecords(h),
    compensations.map((id) => ({
      compensation_operation_id: id,
      status: 'failed',
    })),
  );
  // 補償の失敗が 3 回続いたので安全停止（下書き・ラベルの補償と同じ数え方）。
  const safety = (await list(h))['safety'] as Json;
  assert.equal(safety['state'], 'stopped');
  assert.equal(safety['stop_reason'], 'compensation_failures');
});

test('during a safety stop the press is recorded but the delete is not sent', async (t) => {
  const events = fakeEvents();
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
  const compensationId = await accept(h, operationId);
  await waitFor(() => events.reads >= 2);
  await settle();
  assert.deepEqual(events.deletes, []);
  assert.equal(stateOf(h, compensationId), 'preparing');
});

test('the pure checks: which kinds can be undone, the unchanged event and the delete reconciliation', () => {
  const reads = {
    readDraft: () => Promise.resolve(null),
    readEvent: () => Promise.resolve({ kind: 'missing' } as const),
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
  // 内容版が違う目印（作り直した後の作成物）は、作ったままとみなさない。
  assert.equal(
    eventUnchanged(
      { ...createdEvent(operationId), marker: `buddy-op:${operationId}:2` },
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
  assert.deepEqual(
    eventDeleteObserved({ kind: 'deleted' }, { remote_id: EVENT }),
    {
      kind: 'found',
      external_id: EVENT,
    },
  );
  // このカレンダーで見えないだけでは、消えた証拠にしない。
  assert.deepEqual(
    eventDeleteObserved({ kind: 'missing' }, { remote_id: EVENT }),
    { kind: 'unreadable' },
  );
  assert.deepEqual(
    eventDeleteObserved(
      {
        kind: 'found',
        event: { ...createdEvent(operationId), status: 'cancelled' },
      },
      { remote_id: EVENT },
    ),
    { kind: 'found', external_id: EVENT },
  );
  assert.deepEqual(
    eventDeleteObserved(
      { kind: 'found', event: createdEvent(operationId) },
      { remote_id: EVENT },
    ),
    { kind: 'not_found' },
  );
  assert.deepEqual(
    eventDeleteObserved(
      {
        kind: 'found',
        event: { ...createdEvent(operationId), event_id: 'event-0102' },
      },
      { remote_id: EVENT },
    ),
    { kind: 'unreadable' },
  );
});
