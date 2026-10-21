// イベントの配信の元（EventFeed）の購読の動き（ADR 0023）。DB worker の代わりに、手で並べた行を返す模擬の照会を使う。
// 期待値（配る連番・位置・再スナップショットの理由）は手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutboxEventRecord } from '@buddy/storage';
import { withTimeout } from './api-test-support.js';
import { decodeEventCursor } from './event-cursor.js';
import { EventFeed } from './event-feed.js';
import type { EventEnvelope, EventQueryStore } from './event-feed.js';

const GEN = '00000000-0000-4000-8000-0000000000aa';

const row = (
  sequence: number,
  type = 'operation.updated',
): OutboxEventRecord => ({
  store_generation: GEN,
  sequence,
  event_id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  target_id: '00000000-0000-4000-8000-000000000001',
  state_revision: String(sequence),
  event_type: type,
  occurred_at: Date.UTC(2030, 9, 5),
  delete_at: Date.UTC(2030, 9, 12),
});

// 照会のたびに rows の今の内容を返す模擬。fail を立てると照会が失敗する。
function fakeStore(rows: OutboxEventRecord[]) {
  const state = { fail: false, reads: 0 };
  const store: EventQueryStore = {
    storeGeneration: GEN,
    query: (async (query: {
      kind: string;
      after_sequence: number;
      limit: number;
    }) => {
      state.reads += 1;
      if (state.fail) throw new Error('query_failed');
      assert.equal(query.kind, 'events_since');
      const after = rows.filter((r) => r.sequence > query.after_sequence);
      return {
        store_generation: GEN,
        min_sequence: rows[0]?.sequence ?? null,
        max_sequence: rows.at(-1)?.sequence ?? 0,
        events: after.slice(0, query.limit),
        has_more: after.length > query.limit,
      };
    }) as EventQueryStore['query'],
  };
  return { store, state };
}

function collector() {
  const delivered: EventEnvelope[] = [];
  const ended: string[] = [];
  let wake: () => void = () => undefined;
  const sink = {
    deliver: (events: readonly EventEnvelope[]) => {
      delivered.push(...events);
      wake();
      return true;
    },
    resnapshot: (reason: string) => {
      ended.push(`resnapshot:${reason}`);
      wake();
    },
    fail: (reason: string) => {
      ended.push(`fail:${reason}`);
      wake();
    },
  };
  const until = (check: () => boolean, label: string) =>
    withTimeout(
      new Promise<void>((resolve) => {
        const test = () => {
          if (check()) resolve();
        };
        wake = test;
        test();
      }),
      5_000,
      label,
    );
  return { delivered, ended, sink, until };
}

test(
  'a subscription delivers pages in order, skips hidden event types and picks up notified commits',
  { timeout: 10_000 },
  async () => {
    const rows = [row(1), row(2), row(3, 'internal.audit'), row(4)];
    const { store } = fakeStore(rows);
    const feed = new EventFeed({ store, pageSize: 2, pollIntervalMs: 0 });
    const { delivered, sink, until } = collector();
    const subscription = feed.subscribe(0, sink);
    await until(() => delivered.length === 3, 'first events');
    // 3 は見せない種類なので配らない（端末から見ると連番が飛ぶ）。
    assert.deepEqual(
      delivered.map((event) => event.sequence),
      ['1', '2', '4'],
    );
    for (const event of delivered) {
      assert.equal(
        decodeEventCursor(event.event_cursor)?.sequence,
        Number(event.sequence),
      );
      assert.equal(event.occurred_at, '2030-10-05T00:00:00.000Z');
    }
    assert.equal(subscription.position, 4);
    rows.push(row(5));
    feed.notify();
    await until(() => delivered.length === 4, 'notified event');
    assert.equal(delivered.at(-1)?.sequence, '5');
    subscription.close();
    assert.equal(feed.subscriberCount, 0);
    feed.close();
  },
);

test(
  'a commit during a read is re-read before the pump stops',
  { timeout: 10_000 },
  async () => {
    const rows = [row(1)];
    const { store } = fakeStore(rows);
    let injected = false;
    let feedRef: EventFeed | null = null;
    const feed = new EventFeed({
      store,
      pollIntervalMs: 0,
      afterRead: () => {
        if (injected) return;
        injected = true;
        rows.push(row(2));
        feedRef?.notify();
      },
    });
    feedRef = feed;
    const { delivered, sink, until } = collector();
    feed.subscribe(0, sink);
    await until(() => delivered.length === 2, 'both events');
    assert.deepEqual(
      delivered.map((event) => event.sequence),
      ['1', '2'],
    );
    feed.close();
  },
);

test(
  'a gap in the retained events, a sequence beyond the end or a failed read ends the subscription',
  { timeout: 10_000 },
  async () => {
    const gap = new EventFeed({
      store: fakeStore([row(5), row(6)]).store,
      pollIntervalMs: 0,
    });
    const first = collector();
    gap.subscribe(3, first.sink);
    await first.until(() => first.ended.length === 1, 'gap');
    assert.deepEqual(first.ended, ['resnapshot:history_expired']);
    assert.equal(gap.subscriberCount, 0);

    const beyond = new EventFeed({
      store: fakeStore([row(1)]).store,
      pollIntervalMs: 0,
    });
    const second = collector();
    beyond.subscribe(9, second.sink);
    await second.until(() => second.ended.length === 1, 'beyond');
    assert.deepEqual(second.ended, ['resnapshot:history_expired']);

    const { store, state } = fakeStore([row(1)]);
    state.fail = true;
    const failing = new EventFeed({ store, pollIntervalMs: 0 });
    const third = collector();
    failing.subscribe(0, third.sink);
    await third.until(() => third.ended.length === 1, 'fail');
    assert.deepEqual(third.ended, ['fail:dependency_unavailable']);
    assert.throws(() => {
      failing.close();
      failing.subscribe(0, third.sink);
    }, /event_feed_closed/u);
  },
);

test(
  'the periodic re-read runs only while there are subscribers',
  { timeout: 10_000 },
  async () => {
    const rows = [row(1)];
    const { store, state } = fakeStore(rows);
    const feed = new EventFeed({ store, pollIntervalMs: 20 });
    const { delivered, sink, until } = collector();
    const subscription = feed.subscribe(0, sink);
    await until(() => delivered.length === 1, 'first');
    rows.push(row(2));
    await until(() => delivered.length === 2, 'polled');
    subscription.close();
    const reads = state.reads;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(state.reads, reads);
    feed.close();
  },
);
