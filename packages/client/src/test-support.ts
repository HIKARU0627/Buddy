// 端末側の状態機械の試験で使う模擬（試験専用。index.ts から export しない）。
// - 模擬の通信: 要求を記録し、試験が決めた応答を返す。購読は試験からメッセージ・切断を送れる。
// - 模擬の時計: タイマーを試験が進める（実時間を待たない）。
// - 形式の検査: 契約の JSON Schema を Ajv で検査する（デスクトップの main と同じ正本）。
// 値（ID・hash・cursor）は文書用の合成値で、検査対象の実装から作っていない。

import { readFileSync } from 'node:fs';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import type {
  ClientApiOutcome,
  ClientApiRequest,
  ClientClock,
  ClientContract,
  ClientContractName,
  ClientLockState,
  ClientStreamEvent,
  ClientStreamOpen,
  ClientTransport,
} from './transport.js';

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;

const schema = JSON.parse(
  readFileSync(
    new URL(import.meta.resolve('@buddy/contracts/schema.json')),
    'utf8',
  ),
) as { $id: string };

export function schemaContract(): ClientContract {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  return {
    valid(name: ClientContractName, value: unknown) {
      const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
      if (!validate) throw new Error(`missing schema ${name}`);
      return validate(value) === true;
    },
  };
}

export const IDS = {
  core1: '10000000-0000-4000-8000-000000000001',
  core2: '10000000-0000-4000-8000-000000000002',
  generation1: '20000000-0000-4000-8000-000000000001',
  generation2: '20000000-0000-4000-8000-000000000002',
  device: '30000000-0000-4000-8000-000000000001',
  scope1: '40000000-0000-4000-8000-000000000001',
  scope2: '40000000-0000-4000-8000-000000000002',
  scope3: '40000000-0000-4000-8000-000000000003',
  op1: '50000000-0000-4000-8000-000000000001',
  op2: '50000000-0000-4000-8000-000000000002',
  event1: '60000000-0000-4000-8000-000000000001',
  event2: '60000000-0000-4000-8000-000000000002',
  event3: '60000000-0000-4000-8000-000000000003',
  request1: '70000000-0000-4000-8000-000000000001',
  request2: '70000000-0000-4000-8000-000000000002',
} as const;

export const HASH = 'ab'.repeat(32);

export function bootstrapBody(
  options: {
    readonly apiVersion?: string;
    readonly core?: string;
    readonly generation?: string;
    readonly scope?: string;
  } = {},
): Record<string, unknown> {
  return {
    api_version: options.apiVersion ?? '1.0',
    core_instance_id: options.core ?? IDS.core1,
    store_generation: options.generation ?? IDS.generation1,
    device_id: IDS.device,
    command_scope_id: options.scope ?? IDS.scope1,
    command_scope_expires_at: '2030-10-02T00:00:00Z',
    capabilities: [],
    io_state: ioState('unknown'),
  };
}

function ioState(lock: ClientLockState): Record<string, unknown> {
  return {
    device_id: IDS.device,
    io_epoch: '0',
    output_epoch: '0',
    lock_state: lock,
    stop_scope: 'none',
    input_permitted: false,
    voice_state: 'waiting_wake_word',
    output_mode: 'text',
    private_conversation: false,
    audio_lease_valid: false,
  };
}

export function operation(
  id: string,
  revision: string,
  state: string,
): Record<string, unknown> {
  return {
    operation_id: id,
    operation_kind: 'mail.labels.change',
    content_version: '1',
    content_hash: HASH,
    state_revision: revision,
    state,
    approval_state: 'none',
    allowed_actions: [],
    result: null,
  };
}

export function snapshotBody(
  options: {
    readonly generation?: string;
    readonly cursor?: string;
    readonly lock?: ClientLockState;
    readonly operations?: readonly Record<string, unknown>[];
  } = {},
): Record<string, unknown> {
  const lock = options.lock ?? 'unlocked';
  return {
    store_generation: options.generation ?? IDS.generation1,
    core_instance_id: IDS.core1,
    event_cursor: options.cursor ?? 'cursor-snapshot',
    view: lock === 'unlocked' ? 'full' : 'management_only',
    io_state: ioState(lock),
    sessions: [],
    candidates: [],
    operations: lock === 'unlocked' ? (options.operations ?? []) : [],
  };
}

export function eventMessage(
  eventId: string,
  operationId: string,
  revision: string,
  sequence: string,
  options: { readonly generation?: string } = {},
): Record<string, unknown> {
  return {
    type: 'event',
    event: {
      schema: 'buddy.event.v1',
      event_id: eventId,
      store_generation: options.generation ?? IDS.generation1,
      sequence,
      event_cursor: `cursor-${sequence}`,
      operation_id: operationId,
      state_revision: revision,
      event_type: 'operation.updated',
      occurred_at: '2030-10-01T00:00:00Z',
    },
  };
}

export const ok = (body: unknown, status = 200): ClientApiOutcome => ({
  kind: 'response',
  status,
  body,
});

export const apiError = (status: number, code: string): ClientApiOutcome => ({
  kind: 'response',
  status,
  body: { code, message: '合成の拒否', request_id: null },
});

type Responder = (
  request: ClientApiRequest,
) => ClientApiOutcome | Promise<ClientApiOutcome>;

export interface FakeStream {
  readonly cursor: string;
  readonly lockState: ClientLockState;
  // 端末が閉じた。
  closed: boolean;
  // 中枢が閉じた（端末が閉じた後でも、実際の WSS と同じく切断の通知は届く）。
  serverClosed: boolean;
  send(data: unknown): void;
  ping(): void;
  closeFromServer(code: number, reason?: string): void;
}

export class FakeTransport implements ClientTransport {
  readonly requests: ClientApiRequest[] = [];
  readonly streams: FakeStream[] = [];
  #responders: Responder[] = [];
  #fallback: Responder = () => ({ kind: 'unreachable', reason: 'no_response' });
  // 次の購読の結果（省略は open）。
  nextStream: (() => ClientStreamOpen | null) | null = null;
  // 次の購読の結果を、この Promise が解決するまで返さない（購読の途中の出来事を試験する）。
  nextStreamGate: Promise<void> | null = null;

  // 次の要求から順に使う応答。使い切ったら fallback。
  respond(...responders: Responder[]): void {
    this.#responders.push(...responders);
  }

  fallback(responder: Responder): void {
    this.#fallback = responder;
  }

  request(request: ClientApiRequest): Promise<ClientApiOutcome> {
    this.requests.push(request);
    const responder = this.#responders.shift() ?? this.#fallback;
    return Promise.resolve(responder(request));
  }

  async openStream(
    cursor: string,
    lockState: ClientLockState,
    listener: (event: ClientStreamEvent) => void,
  ): Promise<ClientStreamOpen> {
    const gate = this.nextStreamGate;
    this.nextStreamGate = null;
    if (gate !== null) await gate;
    const decided = this.nextStream?.() ?? null;
    this.nextStream = null;
    if (decided !== null && decided.kind !== 'open')
      return Promise.resolve(decided);
    const stream: FakeStream = {
      cursor,
      lockState,
      closed: false,
      serverClosed: false,
      send: (data) => {
        if (!stream.serverClosed) listener({ type: 'message', data });
      },
      ping: () => {
        if (!stream.serverClosed) listener({ type: 'alive' });
      },
      closeFromServer: (code, reason = '') => {
        if (stream.serverClosed) return;
        stream.serverClosed = true;
        listener({ type: 'closed', code, reason });
      },
    };
    this.streams.push(stream);
    return Promise.resolve({
      kind: 'open',
      stream: {
        close: () => {
          stream.closed = true;
        },
      },
    });
  }

  paths(): string[] {
    return this.requests.map((request) => `${request.method} ${request.path}`);
  }
}

export class FakeClock implements ClientClock {
  #now: number;
  #timers: { at: number; run: () => void; id: number }[] = [];
  #next = 0;
  readonly randomValue: number;
  #ids: string[];

  constructor(start = Date.UTC(2030, 9, 1), random = 0.5, ids: string[] = []) {
    this.#now = start;
    this.randomValue = random;
    this.#ids = [...ids];
  }

  now(): number {
    return this.#now;
  }

  random(): number {
    return this.randomValue;
  }

  newRequestId(): string {
    const id = this.#ids.shift();
    if (id === undefined) throw new Error('no request id prepared');
    return id;
  }

  setTimer(ms: number, run: () => void): () => void {
    const id = (this.#next += 1);
    this.#timers.push({ at: this.#now + ms, run, id });
    return () => {
      this.#timers = this.#timers.filter((timer) => timer.id !== id);
    };
  }

  get pendingTimers(): number[] {
    return this.#timers
      .map((timer) => timer.at - this.#now)
      .sort((a, b) => a - b);
  }

  // 時間を進め、期限の来たタイマーを順に動かす。
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((timer) => timer.id !== due.id);
      this.#now = due.at;
      due.run();
      await settle();
    }
    this.#now = target;
    await settle();
  }
}

// 模擬の応答（Promise の連鎖）が終わるまで待つ。
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
