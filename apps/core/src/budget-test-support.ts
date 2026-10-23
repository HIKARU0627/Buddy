// 予算の門（ADR 0037）の試験の道具（試験専用。index.ts から export しない）。
// - 合成の実行時の設定（通貨は ISO の試験用コード XTS、上限・単価は縮めた合成値。個人の金額ではない）。
// - 模擬の有料 provider（同じプロセス）。受信の記録（request_id・予約・受信順）と、provider 側の真の usage を持つ。
//   応答の喪失・保留（遅れて結果を返す）・例外を要求ごとに決める。重複した要求も消さない。
// - 関門（barrier）と、手で進める timer・時計。固定の sleep を使わない。
// 期待値は各試験に手で書く（ここでは作らない）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DbWorkerClient,
  openWriteConnection,
  storagePlatform,
} from '@buddy/storage';
import type { SqliteDatabase } from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { checkBudgetConfigText } from './budget-config.js';
import type { LoadedBudgetConfig } from './budget-config.js';
import { BudgetGate } from './budget-gate.js';
import type {
  BudgetGateOptions,
  GateTimers,
  PaidOutcome,
  PaidRequest,
  PaidSendContext,
  PaidUsage,
  UsageReconciler,
} from './budget-gate.js';

export const STORE_GENERATION = '00000000-0000-4000-8000-0000000000bb';
// 東京の 2030 年 10 月 15 日・11 月 2 日（UTC）。
export const OCT_15 = Date.parse('2030-10-15T00:00:00.000Z');
export const NOV_02 = Date.parse('2030-11-02T00:00:00.000Z');
// 東京の 11 月の始まり（2030-10-31T15:00Z）。
export const TOKYO_NOV_START = Date.parse('2030-10-31T15:00:00.000Z');

const money = (amount: string) => ({ currency: 'XTS', amount });
const rate = (
  category: string,
  unitPrice: string,
  minimum: string,
  max: string | null,
) => ({
  category,
  unit_price: unitPrice,
  per_quantity: '1',
  minimum_quantity: minimum,
  max_quantity_per_request: max,
});
const SAME = {
  conversion_version: 'xts.same.v1',
  to_currency: 'XTS',
  rate: '1',
  safety_factor: '1',
};

// 枠の木: total(200) ─ llm(100) ─ llm.background(50)、total ─ search(40)、voice(50)、overage(60・承認が要る)。
// 単価: 文字は 1 token 1 単位（出力の上限 100）、会話は 1 秒 1 単位（最低 15 秒・上限 60 秒）。為替 1・安全係数 1。
export function syntheticConfig(
  change: (config: Record<string, unknown>) => void = () => undefined,
): Record<string, unknown> {
  const autonomous = { llm: 'llm.background', search: 'search', voice: null };
  const config: Record<string, unknown> = {
    schema: 'buddy.budget-runtime.v1',
    time_zone: 'Asia/Tokyo',
    budget: {
      schema: 'buddy.budget-config.v1',
      currency: 'XTS',
      pools: [
        {
          pool_id: 'total',
          parent_pool_id: null,
          limit: money('200'),
          requires_approval: false,
        },
        {
          pool_id: 'llm',
          parent_pool_id: 'total',
          limit: money('100'),
          requires_approval: false,
        },
        {
          pool_id: 'llm.background',
          parent_pool_id: 'llm',
          limit: money('50'),
          requires_approval: false,
        },
        {
          pool_id: 'search',
          parent_pool_id: 'total',
          limit: money('40'),
          requires_approval: false,
        },
        {
          pool_id: 'voice',
          parent_pool_id: null,
          limit: money('50'),
          requires_approval: false,
        },
        {
          pool_id: 'overage',
          parent_pool_id: null,
          limit: money('60'),
          requires_approval: true,
        },
      ],
      verified_price_versions: ['xts.text.v1', 'xts.live.v1'],
    },
    price_versions: [
      {
        price_version: 'xts.text.v1',
        price_key: 'synthetic.text',
        currency: 'XTS',
        effective_from: '2030-01-01T00:00:00.000Z',
        effective_to: null,
        rates: [
          rate('input_tokens', '1', '0', null),
          rate('output_tokens', '1', '0', '100'),
        ],
        conversion: SAME,
      },
      {
        price_version: 'xts.live.v1',
        price_key: 'synthetic.live',
        currency: 'XTS',
        effective_from: '2030-01-01T00:00:00.000Z',
        effective_to: null,
        rates: [rate('live_seconds', '1', '15', '60')],
        conversion: SAME,
      },
    ],
    routing: {
      routes: {
        owner_request: { llm: 'llm', search: 'search', voice: 'voice' },
        autonomous_analysis: { ...autonomous },
        auto_execution: { ...autonomous },
        initial_import: { ...autonomous },
        shadow_mode: { llm: 'llm.background', search: null, voice: null },
      },
      overage_pool_id: 'overage',
    },
  };
  change(config);
  return config;
}

export function loadedConfig(
  config: Record<string, unknown> = syntheticConfig(),
): Extract<LoadedBudgetConfig, { readonly ok: true }> {
  const loaded = checkBudgetConfigText(
    JSON.stringify(config),
    createApiContract(),
    () => 'Asia/Tokyo',
  );
  if (!loaded.ok) throw new Error(`config: ${loaded.reasons.join(',')}`);
  return loaded;
}

// 文字の要求（入力 10 token・出力の上限 30 token → M = 10 + 30 = 40）。
export function textRequest(
  requestId: string,
  overrides: Partial<PaidRequest> = {},
): PaidRequest {
  return {
    request_id: requestId,
    origin: 'owner_request',
    service: 'llm',
    profile_id: 'intent.synthetic.v1',
    profile_revision: '1',
    price_key: 'synthetic.text',
    quantities: { input_tokens: '10', output_tokens: '30' },
    timeout_ms: 60_000,
    ...overrides,
  };
}

// 合成の UUID（v4 の形）。
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export class ManualClock {
  #now: number;
  constructor(start: number) {
    this.#now = start;
  }
  now = (): number => this.#now;
  set(value: number): void {
    this.#now = value;
  }
}

// 手で発火する timer（timeout の試験）。
export class ManualTimers implements GateTimers {
  readonly #pending = new Map<number, () => void>();
  // 設定された残り時間（ミリ秒）の記録。
  readonly delays: number[] = [];
  #next = 0;
  set(ms: number, fn: () => void): () => void {
    this.delays.push(ms);
    const id = this.#next++;
    this.#pending.set(id, fn);
    return () => this.#pending.delete(id);
  }
  get size(): number {
    return this.#pending.size;
  }
  fireAll(): void {
    const fns = [...this.#pending.values()];
    this.#pending.clear();
    for (const fn of fns) fn();
  }
}

// parties 件がそろうまで待たせる関門。
export function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) open();
    await opened;
  };
}

type Plan =
  | { readonly kind: 'usage'; readonly actual: string }
  // provider は usage を記録した（費用は発生した）が、応答を返さずに切れる。
  | { readonly kind: 'drop'; readonly actual: string }
  // 応答を保留する。deliver() で遅れて usage を返す。中断の知らせは無視する（送った後は取り消せない）。
  | { readonly kind: 'hold' }
  | { readonly kind: 'throw' };

export interface ProviderReceipt {
  readonly request_id: string;
  readonly reservation_id: string;
  readonly order: number;
}

// 模擬の有料 provider。受信の記録と真の usage は試験装置だけが見る。
export class MockPaidProvider {
  readonly receipts: ProviderReceipt[] = [];
  readonly #plans = new Map<string, Plan>();
  readonly #usage = new Map<string, PaidUsage>();
  readonly #held = new Map<string, (outcome: PaidOutcome) => void>();
  readonly #waiters = new Map<string, () => void>();

  plan(requestId: string, plan: Plan): void {
    this.#plans.set(requestId, plan);
  }

  readonly send = (context: PaidSendContext): Promise<PaidOutcome> => {
    this.receipts.push({
      request_id: context.request_id,
      reservation_id: context.reservation_id,
      order: this.receipts.length + 1,
    });
    this.#waiters.get(context.request_id)?.();
    const plan = this.#plans.get(context.request_id) ?? {
      kind: 'usage',
      actual: '1',
    };
    const usage = (actual: string): PaidUsage => ({
      kind: 'usage',
      provider: 'mockpaid',
      reconciliation_id: `rcpt-${context.request_id}`,
      actual_gross: actual,
    });
    switch (plan.kind) {
      case 'usage':
        this.#usage.set(context.request_id, usage(plan.actual));
        return Promise.resolve(usage(plan.actual));
      case 'drop':
        this.#usage.set(context.request_id, usage(plan.actual));
        return Promise.reject(new Error('connection reset'));
      case 'throw':
        return Promise.reject(new Error('synthetic failure'));
      case 'hold':
        return new Promise((resolve) =>
          this.#held.set(context.request_id, resolve),
        );
    }
  };

  // 保留した要求に、遅れて usage を返す（provider 側でも usage を記録する）。
  deliver(requestId: string, actual: string): void {
    const resolve = this.#held.get(requestId);
    if (resolve === undefined) throw new Error(`not held: ${requestId}`);
    this.#held.delete(requestId);
    const usage: PaidUsage = {
      kind: 'usage',
      provider: 'mockpaid',
      reconciliation_id: `rcpt-${requestId}`,
      actual_gross: actual,
    };
    this.#usage.set(requestId, usage);
    resolve(usage);
  }

  // 受信するまで待つ（固定の sleep を使わない）。
  received(requestId: string): Promise<void> {
    if (this.receipts.some((receipt) => receipt.request_id === requestId))
      return Promise.resolve();
    return new Promise((resolve) => this.#waiters.set(requestId, resolve));
  }

  // provider の usage の照合の口（provider 側の記録を request_id で引く）。
  readonly reconciler: UsageReconciler = {
    lookup: ({ request_id }) =>
      Promise.resolve(this.#usage.get(request_id) ?? null),
  };

  // 送った後に応答の前に Core が止まった場合の模擬（provider は受信して usage を記録した）。
  recordWithoutResponse(
    requestId: string,
    reservationId: string,
    actual: string | null,
  ): void {
    this.receipts.push({
      request_id: requestId,
      reservation_id: reservationId,
      order: this.receipts.length + 1,
    });
    if (actual !== null)
      this.#usage.set(requestId, {
        kind: 'usage',
        provider: 'mockpaid',
        reconciliation_id: `rcpt-${requestId}`,
        actual_gross: actual,
      });
  }
}

export interface BudgetHarness {
  readonly dir: string;
  readonly path: string;
  readonly clock: ManualClock;
  store: DbWorkerClient;
  gate(options?: Partial<BudgetGateOptions>): BudgetGate;
  restart(): Promise<void>;
  sql<T>(body: (db: SqliteDatabase) => T): T;
  close(): Promise<void>;
}

// 一時ディレクトリの DB と DB worker。終わったら閉じて消す。
export async function withBudgetStore(
  body: (harness: BudgetHarness) => Promise<void>,
  options: { readonly start?: number } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-budget-gate-'));
  const path = join(dir, 'buddy.sqlite');
  const start = () =>
    DbWorkerClient.start({
      path,
      storeGeneration: STORE_GENERATION,
      responseTimeoutMs: 10_000,
    });
  const clock = new ManualClock(options.start ?? OCT_15);
  let store = await start();
  const harness: BudgetHarness = {
    dir,
    path,
    clock,
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
    gate: (gateOptions = {}) =>
      new BudgetGate({
        store,
        config: loadedConfig(),
        now: clock.now,
        ...gateOptions,
      }),
    async restart() {
      await store.close();
      store = await start();
    },
    // 検査・状況づくりは試験側の別の接続で行う（WAL なので worker と並べて読める）。worker の命令の最中には呼ばない。
    sql(body) {
      const db = openWriteConnection(path, { platform: storagePlatform() });
      try {
        return body(db);
      } finally {
        db.close();
      }
    },
    close: () => store.close(),
  };
  try {
    await body(harness);
  } finally {
    await store.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}
