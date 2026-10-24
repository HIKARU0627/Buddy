// 音声の制御の模擬試験の共通の装置（試験専用。index.ts から export しない）。DB worker（一時ディレクトリ）・予算の門・
// 模擬の Live の provider・手で進める時計・端末の模擬をそろえる。期待値は各試験に手で書く（ここでは作らない）。

import assert from 'node:assert/strict';
import type { DeviceRecord } from '@buddy/storage';
import {
  syntheticConfig,
  loadedConfig,
  uuid,
  withBudgetStore,
} from './budget-test-support.js';
import type { BudgetHarness } from './budget-test-support.js';
import type { JsonObject } from './strict-json.js';
import { createLiveUsageReconciler } from './live-reconcile.js';
import { VoiceControl } from './voice-control.js';
import type { VoiceControlOptions } from './voice-control.js';
import {
  ManualVoiceClock,
  MockLiveProvider,
  gateLiveBudget,
} from './voice-test-support.js';

export const TIMEOUT = { timeout: 20_000 };
export const CORE = uuid(0xc0);
export const CORE_2 = uuid(0xc1);
export const DEV_A = uuid(0xa1);
export const DEV_B = uuid(0xb1);
export const SCOPE_A = uuid(0x5a);
export const SCOPE_B = uuid(0x5b);
export const SESSION = uuid(0x55);

export const device = (id: string): DeviceRecord => ({
  device_id: id,
  device_name: '合成の端末',
  platform: 'macos',
  hub_local: false,
  registered_at: 1000,
  last_seen_at: null,
  revoked_at: null,
});
export const A = device(DEV_A);
export const B = device(DEV_B);

// 予算: 会話の 195 秒を受け付けられるよう、合成の上限と 1 要求の秒数の上限を広げる（金額は合成の XTS）。
export function liveConfig(voiceLimit = '2000') {
  return loadedConfig(
    syntheticConfig((config) => {
      const budget = config['budget'] as {
        pools: { pool_id: string; limit: { amount: string } }[];
      };
      for (const pool of budget.pools) {
        if (pool.pool_id === 'total') pool.limit.amount = '5000';
        if (pool.pool_id === 'voice') pool.limit.amount = voiceLimit;
      }
      const prices = config['price_versions'] as {
        price_key: string;
        rates: { max_quantity_per_request: string | null }[];
      }[];
      for (const price of prices)
        if (price.price_key === 'synthetic.live')
          for (const rate of price.rates) rate.max_quantity_per_request = '400';
    }),
  );
}

export interface Rig {
  readonly harness: BudgetHarness;
  readonly clock: ManualVoiceClock;
  readonly provider: MockLiveProvider;
  budget: ReturnType<typeof gateLiveBudget>;
  readonly events: Map<string, JsonObject[]>;
  voice: VoiceControl;
  restart(coreInstanceId: string): Promise<void>;
  wait(): Promise<void>;
}

export async function withRig(
  body: (rig: Rig) => Promise<void>,
  overrides: Partial<VoiceControlOptions> = {},
  // 音声の枠の上限（合成の XTS。1 秒 1 単位）。予算に達する場面で縮める。
  voiceLimit = '2000',
): Promise<void> {
  await withBudgetStore(async (harness) => {
    harness.sql((db) => {
      for (const [id, fill] of [
        [DEV_A, 'a'],
        [DEV_B, 'b'],
      ] as const)
        db.prepare(
          `INSERT INTO devices VALUES (?, '合成の端末', 'macos', 0, X'${fill.repeat(64)}', 1000, NULL, NULL)`,
        ).run(id);
      db.prepare(
        "INSERT INTO sessions VALUES (?, 'normal', NULL, 0, NULL, 1000, NULL)",
      ).run(SESSION);
    });
    const gate = harness.gate({ config: liveConfig(voiceLimit) });
    await gate.start();
    const clock = new ManualVoiceClock();
    const provider = new MockLiveProvider();
    const budget = gateLiveBudget(gate);
    const events = new Map<string, JsonObject[]>();
    const make = (coreInstanceId: string) => {
      const voice = new VoiceControl({
        store: harness.store,
        coreInstanceId,
        monoNow: clock.mono,
        wallNow: () => Date.parse('2030-10-15T00:00:00.000Z') + clock.mono(),
        timers: clock,
        provider,
        budget: rig.budget,
        consent: () => 'granted',
        ...overrides,
      });
      for (const id of [DEV_A, DEV_B])
        voice.subscribe(id, (event) => {
          const list = events.get(id) ?? [];
          list.push(event as JsonObject);
          events.set(id, list);
        });
      return voice;
    };
    const rig: Rig = {
      harness,
      clock,
      provider,
      budget,
      events,
      voice: null as unknown as VoiceControl,
      // 中枢の再起動の模擬。DB worker は試験側が先に起動し直す（harness.restart）。予算の門も新しい worker で作り直す。
      async restart(coreInstanceId) {
        await rig.voice.close();
        const next = harness.gate({ config: liveConfig(voiceLimit) });
        // 再起動の照合は、予算の門が provider への照会（Live の口）も使う（本番と同じ組み立て）。
        await next.start(
          createLiveUsageReconciler({
            gate: next,
            store: harness.store,
            provider,
          }),
        );
        rig.budget = gateLiveBudget(next);
        rig.voice = make(coreInstanceId);
        await rig.voice.start();
      },
      async wait() {
        for (let i = 0; i < 4; i += 1) {
          await rig.voice.idle();
          await clock.settle();
        }
      },
    };
    rig.voice = make(CORE);
    clock.settle = async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await rig.voice.idle();
      }
    };
    await rig.voice.start();
    try {
      await body(rig);
    } finally {
      await rig.voice.close();
    }
  });
}

// 実時間の上限つきで、条件が満たされるまで中枢の処理を消化する。遅い実行機でも回数で打ち切らない。
// 上限を超えたら、何を待っていたかが分かるメッセージで失敗させる。
export async function waitUntil(
  rig: Rig,
  description: string,
  done: () => boolean,
  limitMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!done()) {
    if (Date.now() >= deadline)
      assert.fail(
        `${description} を実時間で ${limitMs} ms 待っても確認できませんでした`,
      );
    await rig.wait();
  }
}

export interface LeaseRequestInput {
  readonly lease_id: string;
  readonly nonce: string;
  readonly previous_nonce: string | null;
  readonly at: number;
  readonly io_epoch?: string;
  readonly scope?: string;
  readonly core?: string;
  readonly kind?: 'audio' | 'display';
  readonly device_id?: string;
  readonly ttl_ms?: number;
}

export const leaseBody = (
  owner: string,
  input: LeaseRequestInput,
): JsonObject => ({
  request_id: uuid(Math.floor(Math.random() * 0xffffff)),
  lease_id: input.lease_id,
  kind: input.kind ?? 'audio',
  device_id: input.device_id ?? owner,
  core_instance_id: input.core ?? CORE,
  command_scope_id: input.scope ?? (owner === DEV_A ? SCOPE_A : SCOPE_B),
  io_epoch: input.io_epoch ?? '0',
  nonce: input.nonce,
  previous_nonce: input.previous_nonce,
  requested_at_mono_ms: input.at,
  heartbeat_ms: 2000,
  ttl_ms: input.ttl_ms ?? 6000,
});

export async function renew(
  rig: Rig,
  who: DeviceRecord,
  input: LeaseRequestInput,
  lock: 'unlocked' | 'locked' | null = 'unlocked',
) {
  return rig.voice.renewLease(who, leaseBody(who.device_id, input), lock);
}

export const liveBody = (scope = SCOPE_A): JsonObject => ({
  request_id: uuid(0x700000 + Math.floor(Math.random() * 0xffff)),
  command_scope_id: scope,
  session_id: SESSION,
  purpose: 'conversation',
  sdp_offer: 'v=0 synthetic-offer',
});

export const bodyOf = (result: { body: object }) => result.body as JsonObject;

export async function openLive(
  rig: Rig,
  leaseId = uuid(0x1a),
): Promise<string> {
  const lease = await renew(rig, A, {
    lease_id: leaseId,
    nonce: 'n1',
    previous_nonce: null,
    at: 10,
  });
  assert.equal(bodyOf(lease)['result'], 'renewed');
  const created = await rig.voice.createLiveSession(A, liveBody());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await rig.wait();
  return bodyOf(created)['live_session_id'] as string;
}

export function reservationStatus(rig: Rig): string[] {
  return rig.harness.sql(
    (db) =>
      db
        .prepare(
          "SELECT status FROM budget_reservations WHERE pool_id = 'voice' ORDER BY created_at, reservation_id",
        )
        .pluck()
        .all() as string[],
  );
}

export function actualGross(rig: Rig): number[] {
  return rig.harness.sql(
    (db) =>
      db
        .prepare(
          "SELECT actual_gross FROM budget_reservations WHERE pool_id = 'voice' ORDER BY created_at, reservation_id",
        )
        .pluck()
        .all() as number[],
  );
}

export const audioControls = (rig: Rig, id: string) =>
  (rig.events.get(id) ?? [])
    .filter((event) => event['event_type'] === 'audio_control')
    .map((event) => {
      const control = event['audio_control'] as JsonObject;
      return [control['action'], control['reason'], control['io_epoch']];
    });
