// 音声の制御（ADR 0046）の試験の道具（試験専用。index.ts から export しない）。
// - 手で進める単調時計とタイマー（固定の sleep を使わない）。
// - 模擬の Live の provider（同じプロセス）。SDP の交換とサイドバンド（ping・pong・session.close・session.closed・断線）を
//   試験が決める。実際の音声・実 API は使わない。
// - 予算の門（BudgetGate）への境界の模擬の写し。会話は合成の単価 1 秒 1 単位（通貨は試験用の XTS）。
// 期待値は各試験に手で書く（ここでは作らない）。

import { randomUUID } from 'node:crypto';
import type { BudgetGate, BudgetTicket } from './budget-gate.js';
import type {
  LiveBudgetPort,
  LiveProvider,
  LiveSideband,
  LiveSidebandHandlers,
  VoiceTimers,
} from './voice-control.js';

// 手で進める単調時計とタイマー。advance は期限の来たタイマーを時刻の順に 1 つずつ実行し、その都度 settle を待つ。
export class ManualVoiceClock implements VoiceTimers {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();
  settle: () => Promise<void> = flush;

  constructor(start = 1_000_000) {
    this.#now = start;
  }

  readonly mono = (): number => this.#now;

  set(ms: number, fn: () => void): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === 'number') this.#timers.delete(handle);
  }

  get pending(): number {
    return this.#timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.#timers)
        if (
          entry[1].at <= target &&
          (next === null ||
            entry[1].at < next[1].at ||
            (entry[1].at === next[1].at && entry[0] < next[0]))
        )
          next = entry;
      if (next === null) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].at;
      next[1].fn();
      await this.settle();
    }
    this.#now = target;
    await this.settle();
  }
}

// マイクロタスクと I/O を何回か回す（worker の応答を待つのは呼び出し側の idle）。
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

export class MockSideband implements LiveSideband {
  pings = 0;
  closes = 0;
  terminated = false;
  readonly #handlers: LiveSidebandHandlers;
  constructor(handlers: LiveSidebandHandlers) {
    this.#handlers = handlers;
  }
  ping(): void {
    this.pings += 1;
  }
  sendClose(): void {
    this.closes += 1;
  }
  terminate(): void {
    this.terminated = true;
  }
  pong(): void {
    this.#handlers.onPong();
  }
  closed(usageSeconds: number | null): void {
    this.#handlers.onSessionClosed(usageSeconds);
  }
  disconnect(): void {
    this.#handlers.onDisconnected();
  }
}

export type SidebandPlan = 'connect' | 'fail' | 'hold';

// 模擬の Live の provider。createSession は計画（ok・fail）どおりに答え、受信を記録する（送り直しの検出用）。
// connectSideband は呼ばれた順に計画を使う（なければ connect）。
export class MockLiveProvider implements LiveProvider {
  readonly created: { live_session_id: string; sdp_offer: string }[] = [];
  readonly sidebands: MockSideband[] = [];
  readonly connectCalls: string[] = [];
  createPlan: 'ok' | 'fail' = 'ok';
  readonly sidebandPlans: SidebandPlan[] = [];
  readonly #held: ((value: MockSideband | null) => void)[] = [];
  readonly #heldHandlers: LiveSidebandHandlers[] = [];

  createSession(input: {
    readonly live_session_id: string;
    readonly purpose: 'conversation' | 'notification';
    readonly sdp_offer: string;
  }): Promise<
    | { ok: true; provider_session_id: string; sdp_answer: string }
    | { ok: false }
  > {
    this.created.push({
      live_session_id: input.live_session_id,
      sdp_offer: input.sdp_offer,
    });
    if (this.createPlan === 'fail') return Promise.resolve({ ok: false });
    return Promise.resolve({
      ok: true,
      provider_session_id: `prov-${input.live_session_id}`,
      sdp_answer: 'v=0 synthetic-answer',
    });
  }

  connectSideband(
    providerSessionId: string,
    handlers: LiveSidebandHandlers,
  ): Promise<LiveSideband | null> {
    this.connectCalls.push(providerSessionId);
    const plan = this.sidebandPlans.shift() ?? 'connect';
    if (plan === 'fail') return Promise.resolve(null);
    if (plan === 'hold')
      return new Promise((resolve) => {
        this.#held.push(resolve);
        this.#heldHandlers.push(handlers);
      });
    const sideband = new MockSideband(handlers);
    this.sidebands.push(sideband);
    return Promise.resolve(sideband);
  }

  // 保留した接続を遅れて成立させる。
  releaseHeld(): MockSideband | null {
    const resolve = this.#held.shift();
    const handlers = this.#heldHandlers.shift();
    if (resolve === undefined || handlers === undefined) return null;
    const sideband = new MockSideband(handlers);
    this.sidebands.push(sideband);
    resolve(sideband);
    return sideband;
  }

  get last(): MockSideband {
    const sideband = this.sidebands.at(-1);
    if (sideband === undefined) throw new Error('no sideband');
    return sideband;
  }
}

// 予算の門への境界の写し。会話の秒数を live_seconds の量として渡し、精算は合成の単価（1 秒 1 単位）で実費にする。
export function gateLiveBudget(gate: BudgetGate): LiveBudgetPort & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async reserve({ request_id, seconds }) {
      calls.push(`reserve:${seconds}`);
      const admitted = await gate.admit({
        request_id,
        origin: 'owner_request',
        service: 'voice',
        profile_id: 'live.synthetic.v1',
        profile_revision: '1',
        price_key: 'synthetic.live',
        quantities: { live_seconds: String(seconds) },
        timeout_ms: 7_200_000,
      });
      return admitted.ok
        ? {
            ok: true,
            reservation_id: admitted.ticket.reservation_id,
            ticket: admitted.ticket,
          }
        : { ok: false, budget_held: admitted.budgetHeld };
    },
    async dispatch(ticket) {
      calls.push('dispatch');
      const result = await gate.dispatch(ticket as BudgetTicket);
      return result.ok
        ? { ok: true, uncertain: false }
        : { ok: false, uncertain: result.uncertain };
    },
    async release(ticket) {
      calls.push('release');
      await gate.release(ticket as BudgetTicket);
    },
    async settle(ticket, billableSeconds) {
      calls.push(`settle:${billableSeconds}`);
      await gate.settle(ticket as BudgetTicket, {
        kind: 'usage',
        provider: 'mocklive',
        reconciliation_id: `live-${randomUUID()}`,
        actual_gross: String(billableSeconds),
      });
    },
    async hold(ticket) {
      calls.push('hold');
      await gate.unknown(ticket as BudgetTicket);
    },
  };
}
