// 音声の制御（ADR 0046）の試験の道具（試験専用。index.ts から export しない）。
// - 手で進める単調時計とタイマー（固定の sleep を使わない）。
// - 模擬の Live の provider（同じプロセス）。SDP の交換とサイドバンド（ping・pong・session.close・session.closed・断線）を
//   試験が決める。実際の音声・実 API は使わない。
// - 予算の門（BudgetGate）への境界（本番と同じ createLiveBudget）に呼び出しの記録を付けたもの。会話は合成の単価 1 秒 1 単位（通貨は試験用の XTS）。
// 期待値は各試験に手で書く（ここでは作らない）。

import { createLiveBudget } from './live-budget.js';
import type { BudgetGate } from './budget-gate.js';
import type {
  LiveBudgetPort,
  LiveLookup,
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

  // 時計を戻す（時計の逆行の模擬）。置いた timer の時刻は変えない（実際の timer は経過した時間で発火するので、
  // 戻した時計を読むのは、時計を読む処理だけ）。
  rewind(ms: number): void {
    this.#now -= ms;
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
  // appendInstructions で送った指示（予算の上限）の数と、送れない状態にするか。
  instructions: string[] = [];
  canInstruct = true;
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
  appendInstructions(kind: 'budget_reached'): boolean {
    if (!this.canInstruct) return false;
    this.instructions.push(kind);
    return true;
  }
  terminate(): void {
    this.terminated = true;
  }
  pong(): void {
    this.#handlers.onPong();
  }
  // モデルの発話の終わり（provider のイベント）。
  utteranceEnded(): void {
    this.#handlers.onModelUtteranceEnded();
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
  // lookupSession の答え（live_session_id ごと）。なければ not_found。照会の記録も残す。
  readonly lookups = new Map<string, LiveLookup>();
  readonly lookupCalls: string[] = [];
  // 作成の応答を保留して、遅れて成功させる（期限切れの後に作られる孤児のセッション）。
  holdCreate = false;
  readonly #heldCreates: (() => void)[] = [];
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
    const answer = {
      ok: true as const,
      provider_session_id: `prov-${input.live_session_id}`,
      sdp_answer: 'v=0 synthetic-answer',
    };
    if (this.holdCreate)
      return new Promise((resolve) => {
        this.#heldCreates.push(() => resolve(answer));
      });
    return Promise.resolve(answer);
  }

  // 保留した作成の応答を遅れて返す。
  releaseCreate(): void {
    this.#heldCreates.shift()?.();
  }

  lookupSession(liveSessionId: string): Promise<LiveLookup> {
    this.lookupCalls.push(liveSessionId);
    return Promise.resolve(
      this.lookups.get(liveSessionId) ?? { state: 'not_found' },
    );
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

// 予算の門への境界（本番と同じ createLiveBudget）に、呼び出しの記録を付ける。会話は合成の単価（1 秒 1 単位。通貨は XTS）。
// calls は呼び出しの名前の列（reserve:秒数・dispatch・release・topup:秒数・settle:使用秒数・hold）。
export function gateLiveBudget(gate: BudgetGate): LiveBudgetPort & {
  readonly calls: string[];
  // 次の追加予約を失敗させる（予算の上限・DB の失敗の模擬）。
  failTopUps: 'none' | 'reject' | 'throw';
  failSettles: number;
} {
  const real = createLiveBudget(gate, {
    profile_id: 'live.synthetic.v1',
    profile_revision: '1',
    price_key: 'synthetic.live',
  });
  const calls: string[] = [];
  const port = {
    calls,
    failTopUps: 'none' as 'none' | 'reject' | 'throw',
    failSettles: 0,
    reserve(input: { request_id: string; seconds: number }) {
      calls.push(`reserve:${input.seconds}`);
      return real.reserve(input);
    },
    dispatch(ticket: unknown) {
      calls.push('dispatch');
      return real.dispatch(ticket);
    },
    release(ticket: unknown) {
      calls.push('release');
      return real.release(ticket);
    },
    async topUp(ticket: unknown, seconds: number) {
      calls.push(`topup:${seconds}`);
      if (port.failTopUps === 'throw') throw new Error('synthetic');
      if (port.failTopUps === 'reject')
        return { ok: false as const, reasons: ['r_limit:voice'] };
      return real.topUp(ticket, seconds);
    },
    async settle(
      ticket: unknown,
      input: { live_session_id: string; usage_seconds: number },
    ) {
      calls.push(`settle:${input.usage_seconds}`);
      if (port.failSettles > 0) {
        port.failSettles -= 1;
        return { ok: false as const, reasons: ['synthetic_failure'] };
      }
      return real.settle(ticket, input);
    },
    hold(ticket: unknown) {
      calls.push('hold');
      return real.hold(ticket);
    },
    ticketOf(reservationId: string) {
      return real.ticketOf(reservationId);
    },
  };
  return port;
}
