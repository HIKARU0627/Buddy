// 端末の忘却台帳の複製と追いつき（B06-07b-3、Issue #179、ADR 0182）の模擬の試験。
// - 中枢は domain の forgetLedgerDelta（製品の Core と同じ判定）で答える模擬。故障（切断・部分の頁・hash の書き換え・
//   系譜の違い・本文の欄・503・保存の失敗）を入れる。保存先はメモリーの模擬（ファイルの保存は apps/desktop の試験）。
// - 期待値は tests/fixtures/forget-ledger-replica-cases.json に手で書いた値で、ForgetLedgerSync の出力から作っていない。
// - 台帳の連鎖の entry_hash は、この試験の中で JCS の文字列を手で組んで SHA-256 を掛けて作る（検査対象の
//   canonicalLedgerJson を使わない）。既知値は packages/storage の ledgerEntryHash と Python で確かめた値。
// 実機・実データは使わない。

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  ForgetLedgerChainEntry,
  ForgetLedgerDelta,
  ForgetLedgerEntry,
  ForgetLedgerSyncRequest,
} from '@buddy/contracts';
import { forgetLedgerDelta } from '@buddy/domain';
import {
  EMPTY_LEDGER_CHAIN,
  ForgetLedgerSync,
  applyLedgerDelta,
  canonicalLedgerJson,
  ledgerChainProblem,
  ledgerEntryHash,
} from './forget-ledger.js';
import type {
  LedgerReplicaChain,
  LedgerReplicaLoad,
  LedgerReplicaStorePort,
  LedgerReplicaWriteResult,
  LedgerSyncRequestOutcome,
} from './forget-ledger.js';
import { schemaContract } from './test-support.js';

const ZERO = '0'.repeat(64);
const contract = schemaContract();
const valid = (name: string, value: unknown): boolean =>
  (contract.valid as (name: string, value: unknown) => boolean)(name, value);
const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

interface ChainSpec {
  readonly lineage: 'A' | 'B' | null;
  readonly length: number;
  readonly fork_at?: number;
}

interface Fault {
  readonly request?: number;
  readonly save?: number;
  readonly kind: string;
}

// 読み込みの結果を入れる（順に 1 回ずつ。使い切ったら保存先の今の中身を返す）。
type LoadFault = 'transient' | 'too_large' | 'throws';

interface Step {
  readonly do:
    'connected' | 'notice' | 'notice_malformed' | 'restart' | 'core_becomes';
  readonly generation?: string;
  readonly lineage?: 'A' | 'B';
  readonly core?: ChainSpec;
  readonly expect?: {
    readonly saved: ChainSpec | null;
    readonly issue: string | null;
  };
}

interface SyncCase {
  readonly id: string;
  readonly replica: ChainSpec | null | 'unreadable';
  // 読んだ複製の持ち主（省けば持ち主を返さない）。same は今の端末 ID、other は別の端末 ID。
  readonly replica_device?: 'same' | 'other';
  readonly core: ChainSpec;
  readonly page_limit?: number;
  readonly faults?: readonly Fault[];
  readonly load_faults?: readonly LoadFault[];
  readonly steps: readonly Step[];
  readonly expected: {
    readonly sent: readonly string[];
    readonly loads?: number;
    readonly saved: ChainSpec | null | 'unreadable';
    readonly matches?: 'core' | 'replica' | 'first_core';
    readonly saves: number;
    readonly replaces: number;
    readonly set_aside: number;
    readonly issue: string | null;
    readonly replace_pending?: boolean;
  };
}

const cases = JSON.parse(
  readFileSync(
    new URL(
      '../../../tests/fixtures/forget-ledger-replica-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  readonly lineages: Record<'A' | 'B', string>;
  readonly known_hash: {
    readonly entry: ForgetLedgerEntry;
    readonly previous_hash: string;
    readonly entry_hash: string;
  };
  readonly sync_cases: readonly SyncCase[];
};

// ---- 連鎖を作る（検査対象の関数を使わない） ----

const pad = (value: number): string => String(value).padStart(12, '0');

// 手で組んだ JCS（名前を文字の順に並べた文）に SHA-256 を掛ける。
function handHash(entry: ForgetLedgerEntry, previous: string): string {
  const forgotten = entry.forgotten
    .map((item) =>
      item.source_kind === 'source_item'
        ? `{"source_id_hmac":"${item.source_id_hmac}","source_kind":"source_item"}`
        : `{"source_id":"${item.source_id}","source_kind":"${item.source_kind}"}`,
    )
    .join(',');
  const list = (items: readonly string[]) =>
    items.map((item) => `"${item}"`).join(',');
  const text =
    `{"entry":{"blocked_content_keys":[${list(entry.blocked_content_keys)}],` +
    `"blocked_source_hmacs":[${list(entry.blocked_source_hmacs)}],` +
    `"entry_id":"${entry.entry_id}",` +
    `"forgetting_generation":"${entry.forgetting_generation}",` +
    `"forgotten":[${forgotten}],` +
    `"recorded_at":"${entry.recorded_at}",` +
    `"schema":"buddy.forget-ledger.v1"},"previous_hash":"${previous}"}`;
  return sha256(text);
}

// lineage ごとに決まった項目。fork_at から先は別の内容（entry_id・時刻・忘れた記憶）の枝。
function buildChain(spec: ChainSpec): LedgerReplicaChain {
  if (spec.lineage === null) return EMPTY_LEDGER_CHAIN;
  const lineagePrefix = spec.lineage === 'A' ? 'a' : 'b';
  const entries: ForgetLedgerChainEntry[] = [];
  let previous = ZERO;
  for (let generation = 1; generation <= spec.length; generation += 1) {
    const forked = spec.fork_at !== undefined && generation >= spec.fork_at;
    const branch = forked ? 'f' : '0';
    const entry: ForgetLedgerEntry = {
      schema: 'buddy.forget-ledger.v1',
      entry_id: `${lineagePrefix}${branch}000000-0000-4000-8000-${pad(generation)}`,
      forgetting_generation: String(generation),
      recorded_at: `2031-01-0${forked ? 2 : 1}T00:00:${String(generation).padStart(2, '0')}.000Z`,
      forgotten: [
        {
          source_kind: 'memory',
          source_id: `c${lineagePrefix}${branch}00000-0000-4000-8000-${pad(generation)}`,
        },
        {
          source_kind: 'source_item',
          source_id_hmac: (forked ? 'e5' : 'a7').repeat(32),
        },
      ],
      blocked_source_hmacs: ['b8'.repeat(32)],
      blocked_content_keys: [],
    };
    const entryHash = handHash(entry, previous);
    entries.push({ entry, previous_hash: previous, entry_hash: entryHash });
    previous = entryHash;
  }
  return { ledger_id: cases.lineages[spec.lineage], entries };
}

const sameChain = (a: LedgerReplicaChain, b: LedgerReplicaChain): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// ---- 模擬の中枢と保存先 ----

function deltaOf(
  core: LedgerReplicaChain,
  head: ForgetLedgerSyncRequest,
  limit: number,
): ForgetLedgerDelta {
  const decision = forgetLedgerDelta(core, head, limit);
  assert.notEqual(decision.outcome, 'ledger_invalid');
  const coreHead = core.entries.at(-1);
  const base = {
    schema: 'buddy.forget-ledger-delta.v1' as const,
    ledger_id: core.ledger_id,
    head: {
      forgetting_generation: String(core.entries.length),
      entry_hash: coreHead?.entry_hash ?? ZERO,
    },
  };
  if (decision.outcome === 'entries')
    return {
      ...base,
      outcome: 'entries',
      entries: [...decision.entries],
      has_more: decision.has_more,
    };
  assert(
    decision.outcome === 'diverged' || decision.outcome === 'replica_ahead',
  );
  return { ...base, outcome: decision.outcome, entries: [], has_more: false };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function faulted(
  kind: string,
  delta: ForgetLedgerDelta,
): LedgerSyncRequestOutcome {
  if (kind === 'unreachable') return { kind: 'not_sent' };
  if (kind === 'unknown') return { kind: 'unknown' };
  if (kind === 'status_503')
    return {
      kind: 'response',
      status: 503,
      body: { error: { code: 'dependency_unavailable', request_id: null } },
    };
  // 食い違った中枢: 続きを返せる head にも diverged と答える。
  if (kind === 'diverged')
    return {
      kind: 'response',
      status: 200,
      body: { ...delta, outcome: 'diverged', entries: [], has_more: false },
    };
  const body = clone(delta) as {
    ledger_id: string | null;
    head: { forgetting_generation: string; entry_hash: string };
    entries: ForgetLedgerChainEntry[];
  };
  assert(body.entries.length > 0, `fault ${kind} needs entries`);
  const first = body.entries[0] as ForgetLedgerChainEntry;
  switch (kind) {
    case 'drop_first_entry':
      body.entries.shift();
      break;
    case 'tamper_entry_hash':
      first.entry_hash = 'ff'.repeat(32);
      break;
    case 'rewrite_entry_keep_hash':
      first.entry.recorded_at = '2031-06-01T00:00:00.000Z';
      break;
    case 'break_previous_hash': {
      // 連鎖を切り、entry_hash は切った previous_hash で計算し直す（hash の検査だけでは見つからない形）。
      first.previous_hash = 'cd'.repeat(32);
      first.entry_hash = handHash(first.entry, first.previous_hash);
      break;
    }
    case 'other_lineage':
      body.ledger_id = cases.lineages.B;
      break;
    case 'head_overstated':
      body.head.forgetting_generation = String(
        Number(body.head.forgetting_generation) + 1,
      );
      break;
    case 'body_field':
      (first.entry as unknown as Record<string, unknown>)['text'] =
        '合成の本文';
      break;
    default:
      assert.fail(`unknown fault ${kind}`);
  }
  return { kind: 'response', status: 200, body };
}

const DEVICE = 'd0000000-0000-4000-8000-00000000000d';
const OTHER_DEVICE = 'd0000000-0000-4000-8000-0000000000ee';

class MemoryStore implements LedgerReplicaStorePort {
  saved: LedgerReplicaChain | 'unreadable' | null;
  saves = 0;
  replaces = 0;
  loads = 0;
  readonly setAside: (LedgerReplicaChain | 'unreadable')[] = [];
  #attempts = 0;
  // 書き込みの何回目を、失敗（例外）か、結果（大きすぎる・退避の上限）にするか。
  readonly #faults: ReadonlyMap<number, string>;
  readonly #loadFaults: LoadFault[];
  #owner: string | undefined;
  constructor(
    initial: LedgerReplicaChain | 'unreadable' | null,
    faults: readonly Fault[] = [],
    loadFaults: readonly LoadFault[] = [],
    owner?: string,
  ) {
    this.saved = initial;
    this.#faults = new Map(
      faults
        .filter((fault) => fault.save !== undefined)
        .map((fault) => [fault.save as number, fault.kind]),
    );
    this.#loadFaults = [...loadFaults];
    this.#owner = owner;
  }
  load(): Promise<LedgerReplicaLoad> {
    this.loads += 1;
    const fault = this.#loadFaults.shift();
    if (fault === 'throws') return Promise.reject(new Error('synthetic_load'));
    if (fault !== undefined) return Promise.resolve({ kind: fault });
    if (this.saved === null) return Promise.resolve({ kind: 'missing' });
    if (this.saved === 'unreadable')
      return Promise.resolve({ kind: 'unreadable' });
    return Promise.resolve(
      this.#owner === undefined
        ? { kind: 'loaded', chain: this.saved }
        : { kind: 'loaded', chain: this.saved, device_id: this.#owner },
    );
  }
  #attempt(): LedgerReplicaWriteResult {
    this.#attempts += 1;
    const fault = this.#faults.get(this.#attempts);
    if (fault === 'too_large' || fault === 'set_aside_limit') return fault;
    if (fault !== undefined) throw new Error('synthetic_save');
    return 'saved';
  }
  save(chain: LedgerReplicaChain): Promise<LedgerReplicaWriteResult> {
    const result = this.#attempt();
    if (result !== 'saved') return Promise.resolve(result);
    this.saved = chain;
    this.#owner = DEVICE;
    this.saves += 1;
    return Promise.resolve(result);
  }
  replace(chain: LedgerReplicaChain): Promise<LedgerReplicaWriteResult> {
    const result = this.#attempt();
    if (result !== 'saved') return Promise.resolve(result);
    if (this.saved !== null) this.setAside.push(this.saved);
    this.saved = chain;
    this.#owner = DEVICE;
    this.replaces += 1;
    return Promise.resolve(result);
  }
}

function noticeFor(chain: LedgerReplicaChain, generation: string) {
  const entry = chain.entries[Number(generation) - 1];
  assert(entry !== undefined && chain.ledger_id !== null);
  return {
    schema: 'buddy.forget-ledger-notice.v1',
    notice_id: randomUUID(),
    occurred_at: '2031-01-03T00:00:00.000Z',
    kind: 'ledger_advanced',
    ledger_id: chain.ledger_id,
    forgetting_generation: generation,
    entry_hash: entry.entry_hash,
  };
}

function savedMatches(
  saved: LedgerReplicaChain | 'unreadable' | null,
  spec: ChainSpec | null | 'unreadable',
): boolean {
  if (spec === null || spec === 'unreadable') return saved === spec;
  return (
    saved !== null &&
    saved !== 'unreadable' &&
    sameChain(saved, buildChain(spec))
  );
}

// ---- 試験 ----

test('the entry hash matches the value checked with packages/storage and a hand-built JCS', () => {
  const known = cases.known_hash;
  assert.equal(
    ledgerEntryHash(known.entry, known.previous_hash, sha256),
    known.entry_hash,
  );
  assert.equal(handHash(known.entry, known.previous_hash), known.entry_hash);
});

test('canonical JSON sorts names, keeps arrays in order and refuses values JSON cannot hold', () => {
  assert.equal(
    canonicalLedgerJson({ b: ['y', 'x'], a: { d: null, c: true }, é: 1 }),
    '{"a":{"c":true,"d":null},"b":["y","x"],"é":1}',
  );
  assert.equal(
    canonicalLedgerJson({ s: 'a"\\\n\u0001' }),
    '{"s":"a\\"\\\\\\n\\u0001"}',
  );
  for (const bad of [
    { a: undefined },
    { a: 1.5 },
    { a: Number.NaN },
    { a: '\uD800' },
    { a: new Date(0) },
    { a: () => 1 },
    // 疎な配列（穴のある配列）。
    // eslint-disable-next-line no-sparse-arrays
    { a: [1, , 2] },
  ])
    assert.throws(
      () => canonicalLedgerJson(bad),
      /ledger_value_not_canonical/u,
    );
});

test('a stored replica is usable only as a complete chain from generation 1', () => {
  const chain = buildChain({ lineage: 'A', length: 3 });
  const head = (c: LedgerReplicaChain) => ({
    forgetting_generation: String(c.entries.length),
    entry_hash: c.entries.at(-1)?.entry_hash ?? ZERO,
  });
  assert.equal(
    ledgerChainProblem({ entries: chain.entries, head: head(chain) }, sha256),
    null,
  );
  // 世代 1 のない部分の複製。
  const partial = chain.entries.slice(1);
  assert.equal(
    ledgerChainProblem(
      { entries: partial, head: head({ ledger_id: null, entries: partial }) },
      sha256,
    ),
    'generation_gap',
  );
  // head が最後の世代を指さない（末尾を隠した複製）。
  assert.equal(
    ledgerChainProblem(
      {
        entries: chain.entries,
        head: {
          forgetting_generation: '2',
          entry_hash: chain.entries[1]?.entry_hash ?? '',
        },
      },
      sha256,
    ),
    'head_mismatch',
  );
  // 同じ entry_id が 2 回。
  const duplicated = clone(chain.entries) as ForgetLedgerChainEntry[];
  const second = duplicated[1] as ForgetLedgerChainEntry;
  second.entry.entry_id = (
    duplicated[0] as ForgetLedgerChainEntry
  ).entry.entry_id;
  second.entry_hash = handHash(second.entry, second.previous_hash);
  assert.equal(
    ledgerChainProblem(
      {
        entries: duplicated.slice(0, 2),
        head: head({ ledger_id: null, entries: duplicated.slice(0, 2) }),
      },
      sha256,
    ),
    'duplicate_entry_id',
  );
  // 1 件の中で同じ対象を 2 回忘れる。
  const twice = clone(chain.entries.slice(0, 1)) as ForgetLedgerChainEntry[];
  const only = twice[0] as ForgetLedgerChainEntry;
  only.entry.forgotten = [
    {
      source_kind: 'memory',
      source_id: 'c0000000-0000-4000-8000-000000000009',
    },
    {
      source_kind: 'memory',
      source_id: 'c0000000-0000-4000-8000-000000000009',
    },
  ];
  only.entry_hash = handHash(only.entry, ZERO);
  assert.equal(
    ledgerChainProblem(
      { entries: twice, head: head({ ledger_id: null, entries: twice }) },
      sha256,
    ),
    'duplicate_forgotten',
  );
});

test('a response for an empty core is accepted only by an empty replica', () => {
  const empty: ForgetLedgerDelta = {
    schema: 'buddy.forget-ledger-delta.v1',
    outcome: 'entries',
    ledger_id: null,
    head: { forgetting_generation: '0', entry_hash: ZERO },
    entries: [],
    has_more: false,
  };
  assert.equal(
    applyLedgerDelta(EMPTY_LEDGER_CHAIN, empty, sha256).kind,
    'appended',
  );
  assert.deepEqual(
    applyLedgerDelta(buildChain({ lineage: 'A', length: 1 }), empty, sha256),
    { kind: 'chain_invalid', problem: 'lineage_mismatch' },
  );
});

for (const scenario of cases.sync_cases) {
  test(`sync case ${scenario.id}`, async () => {
    const pageLimit = scenario.page_limit ?? 256;
    const firstCore = buildChain(scenario.core);
    let core = firstCore;
    const initial =
      scenario.replica === null || scenario.replica === 'unreadable'
        ? scenario.replica
        : buildChain(scenario.replica);
    const store = new MemoryStore(
      initial,
      scenario.faults,
      scenario.load_faults,
      scenario.replica_device === undefined
        ? undefined
        : scenario.replica_device === 'same'
          ? DEVICE
          : OTHER_DEVICE,
    );
    const sent: string[] = [];
    const logs: string[] = [];
    const request = (
      body: ForgetLedgerSyncRequest,
    ): Promise<LedgerSyncRequestOutcome> => {
      // 送る本文は契約の形（ForgetLedgerSyncRequest）。
      assert(valid('ForgetLedgerSyncRequest', body), JSON.stringify(body));
      sent.push(body.forgetting_generation);
      const delta = deltaOf(core, body, pageLimit);
      const fault = (scenario.faults ?? []).find(
        (item) => item.request === sent.length,
      );
      return Promise.resolve(
        fault === undefined
          ? { kind: 'response', status: 200, body: delta }
          : faulted(fault.kind, delta),
      );
    };
    const make = () =>
      new ForgetLedgerSync({
        store,
        request,
        valid,
        sha256,
        log: (code) => logs.push(code),
        deviceId: () => DEVICE,
      });
    let sync = make();
    for (const step of scenario.steps) {
      switch (step.do) {
        case 'connected':
          await sync.connected();
          break;
        case 'notice': {
          const lineage = step.lineage;
          const source =
            lineage === undefined || cases.lineages[lineage] === core.ledger_id
              ? core
              : buildChain({ lineage, length: Number(step.generation) });
          await sync.notice(noticeFor(source, step.generation ?? '0'));
          break;
        }
        case 'notice_malformed':
          await sync.notice({ ...noticeFor(core, '1'), entries: [] });
          break;
        case 'restart':
          sync = make();
          break;
        case 'core_becomes':
          assert(step.core !== undefined);
          core = buildChain(step.core);
          break;
      }
      if (step.expect !== undefined) {
        assert(
          savedMatches(store.saved, step.expect.saved),
          `${scenario.id} step saved`,
        );
        assert.equal(
          sync.state.issue,
          step.expect.issue,
          `${scenario.id} step issue`,
        );
      }
    }
    const expected = scenario.expected;
    assert.deepEqual(sent, expected.sent, 'sent heads');
    assert(savedMatches(store.saved, expected.saved), 'saved chain');
    if (expected.matches !== undefined) {
      const reference =
        expected.matches === 'core'
          ? core
          : expected.matches === 'first_core'
            ? firstCore
            : initial;
      assert(
        reference !== null &&
          reference !== 'unreadable' &&
          store.saved !== null &&
          store.saved !== 'unreadable' &&
          sameChain(store.saved, reference),
        `saved matches ${expected.matches}`,
      );
    }
    assert.equal(store.saves, expected.saves, 'saves');
    assert.equal(store.replaces, expected.replaces, 'replaces');
    assert.equal(store.setAside.length, expected.set_aside, 'set aside');
    if (expected.loads !== undefined)
      assert.equal(store.loads, expected.loads, 'loads');
    assert.equal(sync.state.issue, expected.issue, 'issue');
    if (expected.replace_pending !== undefined)
      assert.equal(sync.state.replace_pending, expected.replace_pending);
    // 退避した複製は、初めの端末の複製か、前に保存した中枢の台帳（その頭の部分）のどちらか（消していない）。
    for (const aside of store.setAside)
      assert(
        aside === 'unreadable' ||
          (initial !== null &&
            initial !== 'unreadable' &&
            sameChain(aside, initial)) ||
          (aside.ledger_id === firstCore.ledger_id &&
            sameChain(aside, {
              ledger_id: firstCore.ledger_id,
              entries: firstCore.entries.slice(0, aside.entries.length),
            })),
        'set-aside replica is an earlier copy',
      );
    // ログは決まったコードだけ（台帳の中身・世代・hash を出さない）。
    for (const code of logs)
      assert.match(
        code,
        /^forget_ledger:(diverged|diverged_repeated|replica_ahead|chain_invalid|response_invalid|unreachable|save_failed|page_limit|set_aside_limit|replica_unavailable|replica_too_large|replica_unreadable|replica_other_device|replica_set_aside|notice_invalid)$/u,
      );
  });
}

test('a notice that arrives during a sync is served by the same run when the head is reached', async () => {
  const core = buildChain({ lineage: 'A', length: 3 });
  const store = new MemoryStore(null);
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sync = new ForgetLedgerSync({
    store,
    request: async (body) => {
      sent.push(body.forgetting_generation);
      if (sent.length === 1) await gate;
      return { kind: 'response', status: 200, body: deltaOf(core, body, 256) };
    },
    valid,
    sha256,
  });
  const first = sync.connected();
  // 同期の最中に、中枢の head（世代 3）の知らせが届く。
  await new Promise((resolve) => setImmediate(resolve));
  const noticed = sync.notice(noticeFor(core, '3'));
  release();
  await Promise.all([first, noticed]);
  await sync.idle();
  // 同じ同期で世代 3 に届いたので、知らせのための 2 回目の要求はない。
  assert.deepEqual(sent, ['0']);
  assert.equal(store.saves, 1);
});

test('a reconnection during a sync runs one more sync after it', async () => {
  let core = buildChain({ lineage: 'A', length: 2 });
  const store = new MemoryStore(null);
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sync = new ForgetLedgerSync({
    store,
    request: async (body) => {
      sent.push(body.forgetting_generation);
      if (sent.length === 1) await gate;
      return { kind: 'response', status: 200, body: deltaOf(core, body, 256) };
    },
    valid,
    sha256,
  });
  const first = sync.connected();
  await new Promise((resolve) => setImmediate(resolve));
  core = buildChain({ lineage: 'A', length: 4 });
  const second = sync.connected();
  const third = sync.connected();
  release();
  await Promise.all([first, second, third]);
  await sync.idle();
  // 1 回目は世代 2 の頃の台帳（応答は今の台帳から作るので 4 まで届く）。もう 1 回だけ送り、何も取らない。
  assert.deepEqual(sent, ['0', '4']);
  assert.equal(store.saves, 1);
});

test('a core that keeps answering diverged gets one refetch and one set-aside per sync', async () => {
  // 食い違った中枢: 世代 0 には頁を返すが、それ以外の head にはいつも diverged と答える。
  const core = buildChain({ lineage: 'A', length: 10 });
  const store = new MemoryStore(buildChain({ lineage: 'A', length: 3 }));
  const sent: string[] = [];
  const logs: string[] = [];
  const sync = new ForgetLedgerSync({
    store,
    request: (body) => {
      sent.push(body.forgetting_generation);
      const delta = deltaOf(core, body, 2);
      return Promise.resolve({
        kind: 'response',
        status: 200,
        body:
          body.forgetting_generation === '0'
            ? delta
            : { ...delta, outcome: 'diverged', entries: [], has_more: false },
      });
    },
    valid,
    sha256,
    log: (code) => logs.push(code),
  });
  await sync.connected();
  assert.deepEqual(sent, ['3', '0', '2']);
  assert.equal(store.replaces, 1);
  assert.equal(store.setAside.length, 1);
  assert.equal(sync.state.issue, 'diverged_repeated');
  assert.deepEqual(logs, [
    'forget_ledger:diverged',
    'forget_ledger:replica_set_aside',
    'forget_ledger:diverged_repeated',
  ]);
  // 次の同期も 1 回の取り直しと 1 回の退避で止まる（同期ごとに 1 個まで。数の上限は保存先が持つ）。
  await sync.connected();
  assert.deepEqual(sent, ['3', '0', '2', '2', '0', '2']);
  assert.equal(store.setAside.length, 2);
  assert.equal(sync.state.issue, 'diverged_repeated');
});
