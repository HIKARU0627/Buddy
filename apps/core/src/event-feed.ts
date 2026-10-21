// イベントの配信の元（設計 07 §1・§4、ADR 0023）。WSS の購読と getEvents が使う。
//
// - イベントは DB worker の照会（events_since）で event_outbox から読む。DB worker はメッセージを一つずつ
//   処理するので、読めるのは COMMIT 済みの行だけ（durable commit の後だけ配信する）。中枢のメモリーにイベントを
//   ためて配ることはしない。
// - 購読ごとに位置（受け取り済みの連番）を持ち、読んで配るたびに位置を進める。購読ごとの読み出しは一つずつ
//   （pumping）で、読み出しの途中に届いた通知は dirty にして読み直す。購読の登録を最初の読み出しより先に行うので、
//   スナップショットの取得と購読の間に状態が更新されても、cursor の後のイベントとして必ず読まれる（X11）。
// - 通知（notify）は、操作の命令が durable／accepted を返した後に呼ぶ（watchStore）。命令を別の経路で送った場合に
//   備えて、購読がある間は一定の間隔でも読み直す（pollIntervalMs、0 で止める）。
// - 読むたびに、残っている連番の範囲で cursor の後を欠けなく配れるかを確かめ、配れなければ再スナップショットを求める。

import type {
  DbCommand,
  DbSubmission,
  EventQuery,
  EventQueryValues,
  OutboxEventRecord,
} from '@buddy/storage';
import { cursorReplayDecision, encodeEventCursor } from './event-cursor.js';
import type { ResnapshotReason } from './event-cursor.js';

// 端末へ配るイベントの種類（契約の EventEnvelope.event_type）。これ以外の行は配らない（見せないイベント）。
const DELIVERED_TYPES: ReadonlySet<string> = new Set([
  'operation.updated',
  'command.durable',
]);

export const DEFAULT_EVENT_PAGE = 100;
export const DEFAULT_EVENT_POLL_MS = 1_000;

// 契約の EventEnvelope と同じ形。本文・宛先・認証情報を含めない。
export interface EventEnvelope {
  readonly schema: 'buddy.event.v1';
  readonly event_id: string;
  readonly store_generation: string;
  readonly sequence: string;
  readonly event_cursor: string;
  readonly operation_id: string;
  readonly state_revision: string;
  readonly event_type: string;
  readonly occurred_at: string;
}

export interface EventQueryStore {
  readonly storeGeneration: string;
  query<Q extends EventQuery>(query: Q): Promise<EventQueryValues[Q['kind']]>;
}

export type EventBatch =
  | {
      readonly kind: 'events';
      readonly events: readonly EventEnvelope[];
      // 読み終えた位置（配った最後のイベント、見せないイベントを読み飛ばした場合はその連番）。
      readonly sequence: number;
      readonly hasMore: boolean;
    }
  | { readonly kind: 'resnapshot'; readonly reason: ResnapshotReason };

export interface EventSink {
  // 読んだイベントを配る。false を返すと購読を止める（送れない・閉じた）。
  deliver(events: readonly EventEnvelope[]): boolean;
  resnapshot(reason: ResnapshotReason): void;
  // DB の照会に失敗した（DB worker が使えない）。
  fail(reason: string): void;
}

export interface EventSubscription {
  readonly position: number;
  close(): void;
}

export interface EventFeedOptions {
  readonly store: EventQueryStore;
  readonly now?: () => number;
  readonly pageSize?: number;
  readonly pollIntervalMs?: number;
  // 試験用の故障点。購読の読み出しで、イベントを読んだ後・配る前に呼ぶ（X11 の取りこぼしの確認）。
  readonly afterRead?: (position: number) => Promise<void> | void;
}

function envelopeOf(record: OutboxEventRecord, now: number): EventEnvelope {
  return {
    schema: 'buddy.event.v1',
    event_id: record.event_id,
    store_generation: record.store_generation,
    sequence: String(record.sequence),
    event_cursor: encodeEventCursor({
      storeGeneration: record.store_generation,
      sequence: record.sequence,
      issuedAt: now,
    }),
    operation_id: record.target_id,
    state_revision: record.state_revision,
    event_type: record.event_type,
    occurred_at: new Date(record.occurred_at).toISOString(),
  };
}

export class EventFeed {
  readonly #store: EventQueryStore;
  readonly #now: () => number;
  readonly #pageSize: number;
  readonly #pollIntervalMs: number;
  readonly #afterRead: EventFeedOptions['afterRead'];
  readonly #subscribers = new Set<Subscriber>();
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: EventFeedOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => Date.now());
    this.#pageSize = options.pageSize ?? DEFAULT_EVENT_PAGE;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_EVENT_POLL_MS;
    this.#afterRead = options.afterRead;
  }

  get storeGeneration(): string {
    return this.#store.storeGeneration;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  // 位置 sequence の後を 1 ページ読む（getEvents と購読で使う）。cursor の発行の時刻の検査は呼び出し側。
  async read(sequence: number, limit = this.#pageSize): Promise<EventBatch> {
    const page = await this.#store.query({
      kind: 'events_since',
      after_sequence: sequence,
      limit,
    });
    const decision = cursorReplayDecision(
      {
        storeGeneration: page.store_generation,
        sequence,
        // 発行の時刻の検査は cursor を受け取った時に済ませる。ここでは範囲だけを見る。
        issuedAt: this.#now(),
      },
      {
        storeGeneration: this.#store.storeGeneration,
        now: this.#now(),
        minSequence: page.min_sequence,
        maxSequence: page.max_sequence,
      },
    );
    if (!decision.ok) return { kind: 'resnapshot', reason: decision.reason };
    const now = this.#now();
    const events = page.events
      .filter((record) => DELIVERED_TYPES.has(record.event_type))
      .map((record) => envelopeOf(record, now));
    const last = page.events.at(-1);
    return {
      kind: 'events',
      events,
      sequence: last === undefined ? sequence : last.sequence,
      hasMore: page.has_more,
    };
  }

  // 位置 sequence の後のイベントを sink へ配り続ける。登録は最初の読み出しより先。
  subscribe(sequence: number, sink: EventSink): EventSubscription {
    if (this.#closed) throw new Error('event_feed_closed');
    const subscriber = new Subscriber(this, sequence, sink);
    this.#subscribers.add(subscriber);
    this.#startPolling();
    subscriber.wake();
    return {
      get position() {
        return subscriber.position;
      },
      close: () => this.#remove(subscriber),
    };
  }

  // 新しい durable commit があったかもしれない。購読ごとに読み直す。
  notify(): void {
    for (const subscriber of this.#subscribers) subscriber.wake();
  }

  // 操作の命令を送った後に通知する store を作る（durable・accepted の結果の後だけ）。
  watchStore<S extends { submit(command: DbCommand): DbSubmission }>(
    store: S,
  ): S {
    const submit = (command: DbCommand): DbSubmission => {
      const submission = store.submit(command);
      void submission.result.then(
        (outcome) => {
          if (outcome.outcome === 'durable' || outcome.outcome === 'accepted')
            this.notify();
        },
        () => undefined,
      );
      return submission;
    };
    return new Proxy(store, {
      get(target, property) {
        if (property === 'submit') return submit;
        // 私的なフィールドを使う getter・メソッドのため、this は元の store にする。
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  close(): void {
    this.#closed = true;
    this.#stopPolling();
    for (const subscriber of [...this.#subscribers]) this.#remove(subscriber);
  }

  get afterRead(): EventFeedOptions['afterRead'] {
    return this.#afterRead;
  }

  #remove(subscriber: Subscriber): void {
    subscriber.stop();
    this.#subscribers.delete(subscriber);
    if (this.#subscribers.size === 0) this.#stopPolling();
  }

  #startPolling(): void {
    if (this.#timer !== null || this.#pollIntervalMs <= 0) return;
    this.#timer = setInterval(() => this.notify(), this.#pollIntervalMs);
    this.#timer.unref();
  }

  #stopPolling(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  // 購読の終わり（再スナップショット・失敗）。
  end(subscriber: Subscriber): void {
    this.#remove(subscriber);
  }
}

class Subscriber {
  position: number;
  readonly #feed: EventFeed;
  readonly #sink: EventSink;
  #pumping = false;
  #dirty = false;
  #stopped = false;

  constructor(feed: EventFeed, position: number, sink: EventSink) {
    this.#feed = feed;
    this.position = position;
    this.#sink = sink;
  }

  stop(): void {
    this.#stopped = true;
  }

  wake(): void {
    if (this.#stopped) return;
    if (this.#pumping) {
      this.#dirty = true;
      return;
    }
    this.#pumping = true;
    void this.#pump().finally(() => {
      this.#pumping = false;
    });
  }

  async #pump(): Promise<void> {
    for (;;) {
      if (this.#stopped) return;
      this.#dirty = false;
      let batch: EventBatch;
      try {
        batch = await this.#feed.read(this.position);
        await this.#feed.afterRead?.(this.position);
      } catch {
        if (this.#stopped) return;
        this.#feed.end(this);
        this.#sink.fail('dependency_unavailable');
        return;
      }
      if (this.#stopped) return;
      if (batch.kind === 'resnapshot') {
        this.#feed.end(this);
        this.#sink.resnapshot(batch.reason);
        return;
      }
      if (batch.events.length > 0 && !this.#sink.deliver(batch.events)) {
        this.#feed.end(this);
        return;
      }
      this.position = batch.sequence;
      if (!batch.hasMore && !this.#dirty) return;
    }
  }
}
