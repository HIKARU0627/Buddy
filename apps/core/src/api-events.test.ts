// スナップショット・イベントの再取得・WSS の配信（ADR 0023、X11）。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬の KeyStore）。期待値（状態・版・連番・閉じるコード）は
// 手で書いた値で、検査対象の関数から作らない。端末側の反映には domain の applyEvents（端末の規則）を使い、
// 収束した版を手書きの値と、中枢の getOperation の値の両方と比べる。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applyEvents } from '@buddy/domain';
import { createApiContract } from './api-contract.js';
import { decodeEventCursor, encodeEventCursor } from './event-cursor.js';
import {
  H01_OPERATION,
  H01_SHA256,
  approve,
  approveBody,
  bootstrap,
  cancel,
  createCommand,
  eventsOf,
  getJson,
  insertDevice,
  openStream,
  startEventCore,
  submitDurable,
} from './event-test-support.js';

const contract = createApiContract();
const DAY = 86_400_000;
const ENVELOPE_KEYS = [
  'event_cursor',
  'event_id',
  'event_type',
  'occurred_at',
  'operation_id',
  'schema',
  'sequence',
  'state_revision',
  'store_generation',
];

const sequenceOf = (cursor: unknown): number | undefined =>
  decodeEventCursor(String(cursor))?.sequence;

test(
  'the snapshot reads operations and the event boundary together and hides content while locked',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    await submitDurable(core, createCommand(H01_OPERATION));
    const auto = randomUUID();
    await submitDurable(core, createCommand(auto, { auto: true }));

    const full = await getJson(core, device, '/v1/snapshot');
    assert.equal(full.status, 200, full.text);
    assert(contract.valid('Snapshot', full.json), full.text);
    assert.equal(full.json?.['view'], 'full');
    assert.equal(full.json?.['store_generation'], core.handle.storeGeneration);
    assert.equal(full.json?.['core_instance_id'], core.handle.coreInstanceId);
    // 作成 2 件でイベントは 2 件。境界は連番 2。
    assert.equal(sequenceOf(full.json?.['event_cursor']), 2);
    const operations = full.json?.['operations'] as Record<string, unknown>[];
    assert.deepEqual(
      operations.find(
        (operation) => operation['operation_id'] === H01_OPERATION,
      ),
      {
        operation_id: H01_OPERATION,
        operation_kind: 'mail.labels.change',
        content_version: '1',
        content_hash: H01_SHA256,
        state_revision: '1',
        state: 'awaiting_approval',
        approval_state: 'none',
        allowed_actions: ['preview', 'approve', 'cancel'],
        result: null,
      },
    );
    const approved = operations.find(
      (operation) => operation['operation_id'] === auto,
    );
    assert.equal(approved?.['state'], 'approved');
    assert.equal(approved?.['approval_state'], 'valid');
    assert.equal(approved?.['state_revision'], '1');
    // 本文（確定 intent）・トークンを含めない。
    assert(!full.text.includes(device.token));
    assert(!full.text.includes('"intent"'));
    assert(!full.text.includes('account_id'));

    for (const lock of ['locked', 'unknown'] as const) {
      core.env.lock = lock;
      const hidden = await getJson(core, device, '/v1/snapshot');
      assert.equal(hidden.status, 200, hidden.text);
      assert(contract.valid('Snapshot', hidden.json), hidden.text);
      assert.equal(hidden.json?.['view'], 'management_only', lock);
      assert.deepEqual(hidden.json?.['operations'], []);
      assert.deepEqual(hidden.json?.['sessions'], []);
      assert.deepEqual(hidden.json?.['candidates'], []);
      assert.equal(
        (hidden.json?.['io_state'] as Record<string, unknown>)['lock_state'],
        lock,
      );
      assert.equal(sequenceOf(hidden.json?.['event_cursor']), 2);
    }
  },
);

test(
  'getEvents pages the events after a cursor and asks for a resnapshot when it cannot replay',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t, { events: { pageSize: 2 } });
    const device = await insertDevice(core.handle.store);
    const empty = await getJson(core, device, '/v1/snapshot');
    const start = String(empty.json?.['event_cursor']);
    assert.equal(sequenceOf(start), 0);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await submitDurable(core, createCommand(id));

    const page1 = await getJson(
      core,
      device,
      `/v1/events?cursor=${encodeURIComponent(start)}`,
    );
    assert.equal(page1.status, 200, page1.text);
    assert(contract.valid('EventPage', page1.json), page1.text);
    const events1 = page1.json?.['events'] as Record<string, unknown>[];
    assert.deepEqual(
      events1.map((event) => [
        event['sequence'],
        event['operation_id'],
        event['state_revision'],
      ]),
      [
        ['1', ids[0], '1'],
        ['2', ids[1], '1'],
      ],
    );
    for (const event of events1) {
      assert.deepEqual(Object.keys(event).sort(), ENVELOPE_KEYS);
      assert.equal(event['event_type'], 'operation.updated');
      assert.equal(event['store_generation'], core.handle.storeGeneration);
      assert.equal(
        sequenceOf(event['event_cursor']),
        Number(event['sequence']),
      );
    }
    assert.equal(page1.json?.['resnapshot_required'], false);
    assert.equal(sequenceOf(page1.json?.['event_cursor']), 2);

    const page2 = await getJson(
      core,
      device,
      `/v1/events?cursor=${encodeURIComponent(String(page1.json?.['event_cursor']))}`,
    );
    assert.deepEqual(
      (page2.json?.['events'] as Record<string, unknown>[]).map(
        (event) => event['sequence'],
      ),
      ['3'],
    );
    const page3 = await getJson(
      core,
      device,
      `/v1/events?cursor=${encodeURIComponent(String(page2.json?.['event_cursor']))}`,
    );
    assert.deepEqual(page3.json?.['events'], []);
    assert.equal(sequenceOf(page3.json?.['event_cursor']), 3);

    // 中枢が発行した形でない cursor は 422。
    for (const bad of ['c-1', 'ec1_', 'opaque-test-cursor']) {
      const response = await getJson(
        core,
        device,
        `/v1/events?cursor=${encodeURIComponent(bad)}`,
      );
      assert.equal(response.status, 422, bad);
      assert.equal(response.json?.['code'], 'invalid_input');
    }
    // 世代違い・7 日を過ぎた・連番が今より先は再スナップショット（cursor はそのまま返す）。
    const now = Date.now();
    const resnapshotCursors = [
      encodeEventCursor({
        storeGeneration: '00000000-0000-4000-8000-0000000000bb',
        sequence: 1,
        issuedAt: now,
      }),
      encodeEventCursor({
        storeGeneration: core.handle.storeGeneration,
        sequence: 1,
        issuedAt: now - 8 * DAY,
      }),
      encodeEventCursor({
        storeGeneration: core.handle.storeGeneration,
        sequence: 99,
        issuedAt: now,
      }),
    ];
    for (const cursor of resnapshotCursors) {
      const response = await getJson(
        core,
        device,
        `/v1/events?cursor=${encodeURIComponent(cursor)}`,
      );
      assert.equal(response.status, 200, response.text);
      assert(contract.valid('EventPage', response.json));
      assert.deepEqual(response.json, {
        events: [],
        event_cursor: cursor,
        resnapshot_required: true,
      });
    }
    // 認証のない要求は 401（cursor は認証の代わりにならない）。
    const anonymous = await getJson(
      core,
      { device: device.device, token: 'A'.repeat(43) },
      `/v1/events?cursor=${encodeURIComponent(start)}`,
    );
    assert.equal(anonymous.status, 401);
  },
);

test(
  'X11: an update between the snapshot and the subscription is delivered, and duplicates or reordering converge',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    await submitDurable(core, createCommand(H01_OPERATION));
    const scope = await bootstrap(core, device);
    const snapshot = await getJson(core, device, '/v1/snapshot');
    const cursor = String(snapshot.json?.['event_cursor']);
    assert.equal(sequenceOf(cursor), 1);

    // 故障点: スナップショットの取得の後・購読の前に状態を更新する（承認で版 2）。
    const approval = await approve(
      core,
      device,
      H01_OPERATION,
      approveBody(scope),
    );
    assert.equal(approval.status, 202, approval.text);

    const stream = openStream(t, core, device, cursor);
    assert.deepEqual(await stream.opened, { ok: true });
    await stream.waitFor(
      (messages) => eventsOf(messages).length >= 1,
      'event after the snapshot',
    );
    // 購読の後の更新（取消で版 3）も配る。
    const cancelled = await cancel(core, device, H01_OPERATION, {
      request_id: randomUUID(),
      command_scope_id: scope,
      expected_state_revision: '2',
    });
    assert.equal(cancelled.status, 202, cancelled.text);
    await stream.waitFor(
      (messages) => eventsOf(messages).length >= 2,
      'event after the subscription',
    );
    const events = eventsOf(stream.messages);
    assert.deepEqual(
      events.map((event) => [
        event['sequence'],
        event['operation_id'],
        event['state_revision'],
      ]),
      [
        ['2', H01_OPERATION, '2'],
        ['3', H01_OPERATION, '3'],
      ],
    );
    for (const message of stream.messages) {
      assert(
        contract.valid('EventStreamMessage', message),
        JSON.stringify(message),
      );
      assert(!JSON.stringify(message).includes(device.token));
    }
    for (const event of events)
      assert.deepEqual(Object.keys(event).sort(), ENVELOPE_KEYS);

    // 端末の反映: 重複・逆順で配っても、スナップショットの版から最新の版 3 に収まる。
    const view = {
      store_generation: core.handle.storeGeneration,
      revisions: { [H01_OPERATION]: '1' },
      seen_event_ids: [],
    };
    const asLike = (event: Record<string, unknown>) => ({
      event_id: String(event['event_id']),
      store_generation: String(event['store_generation']),
      operation_id: String(event['operation_id']),
      state_revision: String(event['state_revision']),
    });
    const [second, third] = events.map(asLike) as [
      ReturnType<typeof asLike>,
      ReturnType<typeof asLike>,
    ];
    const shuffled = applyEvents(view, [third, second, third, second]);
    assert.equal(shuffled.resnapshot, false);
    assert.equal(shuffled.view.revisions[H01_OPERATION], '3');
    const current = await getJson(
      core,
      device,
      `/v1/operations/${H01_OPERATION}`,
    );
    assert.equal(current.json?.['state_revision'], '3');
    assert.equal(current.json?.['state'], 'cancelled');
  },
);

test(
  'X11: a commit while the subscription is reading is delivered after the read (no lost event)',
  { timeout: 30_000 },
  async (t) => {
    let injected = false;
    let coreRef: Awaited<ReturnType<typeof startEventCore>> | null = null;
    const late = randomUUID();
    const core = await startEventCore(t, {
      // 定期の読み直しを止め、取りこぼしが通知だけで埋まることを確かめる。
      events: {
        pollIntervalMs: 0,
        afterRead: async () => {
          if (injected || coreRef === null) return;
          injected = true;
          // 故障点: 最初の読み出しの後・配る前に別の更新をコミットする（命令の後の通知つき）。
          const watched = coreRef.handle.events.watchStore(
            coreRef.handle.store,
          );
          const outcome = await watched.submit(createCommand(late)).result;
          assert.equal(outcome.outcome, 'durable');
        },
      },
    });
    coreRef = core;
    const device = await insertDevice(core.handle.store);
    const first = randomUUID();
    await submitDurable(core, createCommand(first));
    await bootstrap(core, device);
    const stream = openStream(
      t,
      core,
      device,
      encodeEventCursor({
        storeGeneration: core.handle.storeGeneration,
        sequence: 0,
        issuedAt: Date.now(),
      }),
    );
    await stream.waitFor(
      (messages) => eventsOf(messages).length >= 2,
      'both events',
    );
    assert(injected);
    assert.deepEqual(
      eventsOf(stream.messages).map((event) => [
        event['sequence'],
        event['operation_id'],
      ]),
      [
        ['1', first],
        ['2', late],
      ],
    );
  },
);

test(
  'commands sent outside the HTTP routes are delivered by the periodic re-read',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t, { events: { pollIntervalMs: 50 } });
    const device = await insertDevice(core.handle.store);
    await bootstrap(core, device);
    const snapshot = await getJson(core, device, '/v1/snapshot');
    const stream = openStream(
      t,
      core,
      device,
      String(snapshot.json?.['event_cursor']),
    );
    assert.deepEqual(await stream.opened, { ok: true });
    const id = randomUUID();
    // 通知のない store から直接送る。
    await submitDurable(core, createCommand(id));
    await stream.waitFor(
      (messages) =>
        eventsOf(messages).some((event) => event['operation_id'] === id),
      'polled event',
    );
  },
);

test(
  'the stream asks for a resnapshot on another generation, an expired cursor or a missing command scope',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    const now = Date.now();
    const cursorOf = (storeGeneration: string, issuedAt: number) =>
      encodeEventCursor({ storeGeneration, sequence: 0, issuedAt });

    // 接続範囲がまだない（bootstrap の前）。
    const noScope = openStream(
      t,
      core,
      device,
      cursorOf(core.handle.storeGeneration, now),
    );
    assert.deepEqual(await noScope.closed, {
      code: 4410,
      reason: 'scope_expired',
    });
    assert.deepEqual(noScope.messages, [
      { type: 'resnapshot_required', reason: 'scope_expired' },
    ]);

    await bootstrap(core, device);
    const cases: [string, string][] = [
      [
        cursorOf('00000000-0000-4000-8000-0000000000bb', now),
        'store_generation_changed',
      ],
      [cursorOf(core.handle.storeGeneration, now - 8 * DAY), 'history_expired'],
      [
        encodeEventCursor({
          storeGeneration: core.handle.storeGeneration,
          sequence: 50,
          issuedAt: now,
        }),
        'history_expired',
      ],
    ];
    for (const [cursor, reason] of cases) {
      const stream = openStream(t, core, device, cursor);
      assert.deepEqual(await stream.closed, { code: 4410, reason }, reason);
      assert.deepEqual(stream.messages, [
        { type: 'resnapshot_required', reason },
      ]);
      assert(contract.valid('EventStreamMessage', stream.messages[0]));
    }

    // 中枢が発行した形でない cursor・cursor なしは切り替えずに 422。
    for (const cursor of ['c-1', null]) {
      const stream = openStream(t, core, device, cursor);
      assert.deepEqual(await stream.opened, { ok: false, status: 422 });
    }
    // 端末トークンのない切り替えは 401。
    const anonymous = openStream(
      t,
      core,
      null,
      cursorOf(core.handle.storeGeneration, now),
    );
    assert.deepEqual(await anonymous.opened, { ok: false, status: 401 });
  },
);

test(
  'the stream is closed with a reason on reconnection, revocation, home network failure, client messages and shutdown',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t, { pingIntervalMs: 100 });
    const device = await insertDevice(core.handle.store);
    const cursor = () =>
      encodeEventCursor({
        storeGeneration: core.handle.storeGeneration,
        sequence: 0,
        issuedAt: Date.now(),
      });
    const opened = async () => {
      await bootstrap(core, device);
      const stream = openStream(t, core, device, cursor());
      assert.deepEqual(await stream.opened, { ok: true });
      // 接続範囲に結び付いて購読が始まるまで待つ。
      const deadline = Date.now() + 5_000;
      while (
        core.handle.deviceConnections.count(device.device.device_id) === 0
      ) {
        assert(Date.now() < deadline, 'stream registered');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return stream;
    };

    // 再接続（新しい接続範囲）で古い接続は scope_expired。
    const first = await opened();
    await bootstrap(core, device);
    assert.deepEqual(await first.closed, {
      code: 4410,
      reason: 'scope_expired',
    });
    assert.deepEqual(first.messages.at(-1), {
      type: 'resnapshot_required',
      reason: 'scope_expired',
    });

    // 失効（B03-02 が呼ぶ差し込み口）は 4401。
    const second = await opened();
    assert.equal(
      core.handle.deviceConnections.closeDevice(
        device.device.device_id,
        'device_revoked',
      ),
      1,
    );
    assert.deepEqual(await second.closed, {
      code: 4401,
      reason: 'device_revoked',
    });

    // 自宅判定の不成立（B03-03 が呼ぶ差し込み口）は 4403。
    const third = await opened();
    core.handle.deviceConnections.closeDevice(
      device.device.device_id,
      'outside_home_network',
    );
    assert.deepEqual(await third.closed, {
      code: 4403,
      reason: 'outside_home_network',
    });

    // 差し込み口を呼ばなくても、ping ごとの自宅判定の引き直しで閉じる。
    const fourth = await opened();
    core.env.home = false;
    assert.deepEqual(await fourth.closed, {
      code: 4403,
      reason: 'outside_home_network',
    });
    core.env.home = true;

    // 端末から送るメッセージは定義していない。
    const fifth = await opened();
    fifth.socket.send('{"type":"ack"}');
    assert.deepEqual(await fifth.closed, {
      code: 1003,
      reason: 'unsupported_data',
    });

    // 端末の失効（DB）で接続範囲が無効になれば、ping ごとの確認で閉じる。
    const sixth = await opened();
    const revoked = await core.handle.store.device({
      kind: 'device.revoke',
      device_id: device.device.device_id,
      revoked_at: Date.now(),
    });
    assert(revoked.ok);
    assert.deepEqual(await sixth.closed, {
      code: 4410,
      reason: 'scope_expired',
    });
    assert.equal(core.handle.deviceConnections.count(), 0);

    // 中枢の停止は 1001。
    const other = await insertDevice(core.handle.store);
    await bootstrap(core, other);
    const seventh = openStream(t, core, other, cursor());
    assert.deepEqual(await seventh.opened, { ok: true });
    const deadline = Date.now() + 5_000;
    while (core.handle.deviceConnections.count(other.device.device_id) === 0) {
      assert(Date.now() < deadline, 'stream registered');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await core.handle.stop('test');
    assert.deepEqual(await seventh.closed, {
      code: 1001,
      reason: 'core_stopping',
    });
  },
);

test(
  'a client that does not answer pings is cut off',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t, { pingIntervalMs: 100 });
    const device = await insertDevice(core.handle.store);
    await bootstrap(core, device);
    const stream = openStream(
      t,
      core,
      device,
      encodeEventCursor({
        storeGeneration: core.handle.storeGeneration,
        sequence: 0,
        issuedAt: Date.now(),
      }),
      { autoPong: false },
    );
    assert.deepEqual(await stream.opened, { ok: true });
    // 閉じる手順なしに切られる（1006）。
    assert.equal((await stream.closed).code, 1006);
  },
);
