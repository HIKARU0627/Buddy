// 端末の忘却台帳の複製と追いつき（B06-07b-3、Issue #179、設計 03、ADR 0040・0180・0182）。
//
// 端末は中枢の台帳（DB が正本）の写しを保存し、次の接続で追いつくだけで、忘却の判定・実行・承認の正本にはならない。
// - 接続のたびと「台帳が進んだ」知らせ（ForgetLedgerNotice）で、最後に保存できた head（系譜・世代・entry_hash）を
//   POST /v1/forget-ledger/sync に送り、返った続き（最大 256 件・has_more）を確かめて保存する。保存は 1 頁ごと
//   （途中で切れても、次は最後に保存できた世代から続ける）。中枢の head に届いたら、それ以上は取らない。
// - 確かめること: 世代が保存した head の次から欠番なく続く・previous_hash の連鎖・entry_hash（{entry, previous_hash} の
//   JCS に SHA-256）・entry_id と忘れた対象の重複・最後の頁で中枢の head と一致すること・系譜が変わらないこと。
//   どれかが違う応答（部分の複製・hash の食い違い・系譜の違い）は保存せず、理由だけを残して次の同期で取り直す。
// - diverged（中枢が、端末の複製は中枢の台帳の続きでないと答えた）: 保存しないまま、世代 0 から取り直す。取り直した
//   中枢の台帳を保存するときに、今の複製を消さずに退避する（中枢が忘却を失った証拠として残す。ADR 0182）。
// - replica_ahead（端末が中枢より新しい世代を持つ）: 巻き戻さず、何も保存しない。
// - 前の複製が読めない: 世代 0 から取り直し、最初の保存のときに読めないファイルを退避する。
// ログには決まった理由のコードだけを出し、台帳の中身（ID・HMAC・世代・hash）を出さない。
// Node・DOM・Electron の API を使わない（SHA-256・保存・通信は端末の main が渡す）。

import type {
  ForgetLedgerChainEntry,
  ForgetLedgerDelta,
  ForgetLedgerNotice,
  ForgetLedgerSyncRequest,
} from '@buddy/contracts';

export const LEDGER_ZERO_HASH = '0'.repeat(64);

// 1 回の同期で取る頁の上限（256 件 × 512 頁で、契約の台帳の上限 100000 件を超える）。上限で止まったら、次の同期で続ける。
export const FORGET_LEDGER_SYNC_MAX_PAGES = 512;

// 文字列の UTF-8 に SHA-256 を掛けた小文字 16 進（端末の main が node:crypto で渡す）。
export type Sha256Hex = (text: string) => string;

// ---- JCS（RFC 8785）----
// 台帳の 1 件は文字列・配列・オブジェクトだけで、数を持たない。表せない値（undefined・関数・孤立したサロゲート・
// 安全な整数でない数・疎な配列・プレーンでないオブジェクト）は、黙って落とさずに拒否する。

const MAX_DEPTH = 64;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export class LedgerCanonicalError extends Error {
  constructor() {
    super('ledger_value_not_canonical');
    this.name = 'LedgerCanonicalError';
  }
}

function canonical(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new LedgerCanonicalError();
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new LedgerCanonicalError();
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new LedgerCanonicalError();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new LedgerCanonicalError();
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new LedgerCanonicalError();
      items.push(canonical(value[index], depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new LedgerCanonicalError();
  // JCS は名前を UTF-16 の符号単位の順に並べる（Array.prototype.sort の既定と同じ）。
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const members: string[] = [];
  for (const key of keys) {
    if (LONE_SURROGATE.test(key)) throw new LedgerCanonicalError();
    members.push(`${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`);
  }
  return `{${members.join(',')}}`;
}

export function canonicalLedgerJson(value: unknown): string {
  return canonical(value, 0);
}

// 台帳の 1 件の entry_hash（契約の ForgetLedgerChainEntry の説明のとおり。届いた entry をそのまま正規化する）。
export function ledgerEntryHash(
  entry: ForgetLedgerChainEntry['entry'],
  previousHash: string,
  sha256: Sha256Hex,
): string {
  return sha256(canonicalLedgerJson({ entry, previous_hash: previousHash }));
}

// ---- 連鎖の検査 ----

// 端末が持つ複製（世代 1 から head までの全体）。系譜は項目が 1 件以上あるときだけ持つ。
export interface LedgerReplicaChain {
  readonly ledger_id: string | null;
  readonly entries: readonly ForgetLedgerChainEntry[];
}

export const EMPTY_LEDGER_CHAIN: LedgerReplicaChain = {
  ledger_id: null,
  entries: [],
};

export function ledgerHeadOf(chain: LedgerReplicaChain): {
  readonly forgetting_generation: string;
  readonly entry_hash: string;
} {
  const last = chain.entries.at(-1);
  return last === undefined
    ? { forgetting_generation: '0', entry_hash: LEDGER_ZERO_HASH }
    : {
        forgetting_generation: last.entry.forgetting_generation,
        entry_hash: last.entry_hash,
      };
}

// 中枢へ送る head（何も持たなければ系譜 null・世代 0・64 個の 0）。
export function ledgerSyncRequestOf(
  chain: LedgerReplicaChain,
): ForgetLedgerSyncRequest {
  const head = ledgerHeadOf(chain);
  return {
    ledger_id: chain.entries.length === 0 ? null : chain.ledger_id,
    forgetting_generation: head.forgetting_generation,
    entry_hash: head.entry_hash,
  };
}

function forgottenKey(
  item: ForgetLedgerChainEntry['entry']['forgotten'][number],
) {
  return item.source_kind === 'source_item'
    ? `${item.source_kind}:${item.source_id_hmac}`
    : `${item.source_kind}:${item.source_id}`;
}

// base の続きとして items を確かめる。理由は契約の意味検査（ForgetLedgerFile）と同じ名前で、最初に見つけた 1 つ。
function continuationProblem(
  base: readonly ForgetLedgerChainEntry[],
  items: readonly ForgetLedgerChainEntry[],
  sha256: Sha256Hex,
  entryIds: Set<string>,
): string | null {
  let previous = base.at(-1)?.entry_hash ?? LEDGER_ZERO_HASH;
  for (const [index, item] of items.entries()) {
    const entry = item.entry;
    if (entry.forgetting_generation !== String(base.length + index + 1))
      return 'generation_gap';
    if (entryIds.has(entry.entry_id)) return 'duplicate_entry_id';
    entryIds.add(entry.entry_id);
    if (item.previous_hash !== previous) return 'previous_hash_mismatch';
    let hash: string;
    try {
      hash = ledgerEntryHash(entry, item.previous_hash, sha256);
    } catch {
      return 'entry_hash_mismatch';
    }
    if (hash !== item.entry_hash) return 'entry_hash_mismatch';
    const keys = entry.forgotten.map(forgottenKey);
    if (new Set(keys).size !== keys.length) return 'duplicate_forgotten';
    previous = item.entry_hash;
  }
  return null;
}

// 保存してあった複製（ForgetLedgerFile の entries と head）を確かめる。世代 1 から始まらない部分の複製・連鎖の切れ・
// 書き換え・head の食い違いは理由を返す（null なら使える）。
export function ledgerChainProblem(
  ledger: {
    readonly entries: readonly ForgetLedgerChainEntry[];
    readonly head: {
      readonly forgetting_generation: string;
      readonly entry_hash: string;
    };
  },
  sha256: Sha256Hex,
): string | null {
  const problem = continuationProblem([], ledger.entries, sha256, new Set());
  if (problem !== null) return problem;
  const head = ledgerHeadOf({ ledger_id: null, entries: ledger.entries });
  if (
    ledger.head.forgetting_generation !== head.forgetting_generation ||
    ledger.head.entry_hash !== head.entry_hash
  )
    return 'head_mismatch';
  return null;
}

export type LedgerDeltaApplication =
  | {
      readonly kind: 'appended';
      readonly chain: LedgerReplicaChain;
      // 足した項目の数（0 なら保存しない）。
      readonly added: number;
      readonly has_more: boolean;
      // 中枢の head の世代。
      readonly core_generation: bigint;
    }
  | { readonly kind: 'diverged' }
  | { readonly kind: 'replica_ahead' }
  // 部分の複製・hash の食い違い・系譜の違い・中枢の head と合わない応答。保存しない。
  | { readonly kind: 'chain_invalid'; readonly problem: string };

const DECIMAL = /^(0|[1-9][0-9]*)$/u;

// base（端末が送った head の連鎖）に中枢の応答を当てる。delta は契約の形の検査を通したもの。
export function applyLedgerDelta(
  base: LedgerReplicaChain,
  delta: ForgetLedgerDelta,
  sha256: Sha256Hex,
): LedgerDeltaApplication {
  if (delta.outcome === 'diverged') return { kind: 'diverged' };
  if (delta.outcome === 'replica_ahead') return { kind: 'replica_ahead' };
  const invalid = (problem: string): LedgerDeltaApplication => ({
    kind: 'chain_invalid',
    problem,
  });
  if (!DECIMAL.test(delta.head.forgetting_generation))
    return invalid('head_mismatch');
  const coreGeneration = BigInt(delta.head.forgetting_generation);
  const held = BigInt(base.entries.length);
  if (delta.ledger_id === null) {
    // 中枢に台帳がない。端末も何も持たないときだけ（持っていれば中枢は replica_ahead と答える）。
    if (
      base.entries.length > 0 ||
      delta.entries.length > 0 ||
      delta.has_more ||
      coreGeneration !== 0n ||
      delta.head.entry_hash !== LEDGER_ZERO_HASH
    )
      return invalid('lineage_mismatch');
    return {
      kind: 'appended',
      chain: base,
      added: 0,
      has_more: false,
      core_generation: 0n,
    };
  }
  // 系譜は変わらない（違えば中枢は diverged と答える。entries で違う系譜は応答の誤り）。
  if (base.ledger_id !== null && base.ledger_id !== delta.ledger_id)
    return invalid('lineage_mismatch');
  if (coreGeneration < held) return invalid('head_mismatch');
  const entryIds = new Set(base.entries.map((item) => item.entry.entry_id));
  const problem = continuationProblem(
    base.entries,
    delta.entries,
    sha256,
    entryIds,
  );
  if (problem !== null) return invalid(problem);
  const chain: LedgerReplicaChain = {
    ledger_id: delta.ledger_id,
    entries: [...base.entries, ...delta.entries],
  };
  const reached = BigInt(chain.entries.length);
  if (delta.has_more) {
    // 続きがあるなら、この頁で進み、まだ中枢の head に届いていない。
    if (delta.entries.length === 0 || reached >= coreGeneration)
      return invalid('head_mismatch');
  } else {
    const head = ledgerHeadOf(chain);
    if (reached !== coreGeneration || head.entry_hash !== delta.head.entry_hash)
      return invalid('head_mismatch');
  }
  return {
    kind: 'appended',
    chain,
    added: delta.entries.length,
    has_more: delta.has_more,
    core_generation: coreGeneration,
  };
}

// ---- 同期 ----

// 残す理由（決まったコードだけ。ログ・状態に台帳の中身を出さない）。
export type LedgerReplicaIssue =
  // 中枢が、端末の複製は中枢の台帳の続きでないと答えた（取り直した台帳を保存するまで残る）。
  | 'diverged'
  // 端末が中枢より新しい世代を持つ（巻き戻さない）。
  | 'replica_ahead'
  // 部分の複製・hash の食い違い・系譜の違い・中枢の head と合わない応答（保存しない）。
  | 'chain_invalid'
  // 応答が 200 でない・契約の形でない。
  | 'response_invalid'
  // 送れなかった・結果が分からない（接続が切れた）。
  | 'unreachable'
  // 保存できなかった。
  | 'save_failed'
  // 1 回の同期の頁の上限に達した（次の同期で続ける）。
  | 'page_limit';

export type LedgerReplicaLoad =
  | { readonly kind: 'missing' }
  | { readonly kind: 'loaded'; readonly chain: LedgerReplicaChain }
  // 読めない・壊れている・部分の複製。使わず、世代 0 から取り直し、最初の保存で退避する。
  | { readonly kind: 'unreadable' };

export interface LedgerReplicaStorePort {
  // 前に保存した複製を読む（最初の同期の前に 1 回だけ）。
  load(): Promise<LedgerReplicaLoad>;
  // 今の複製の続きを保存する（一時ファイル → fsync → rename → ディレクトリの fsync）。
  save(chain: LedgerReplicaChain): Promise<void>;
  // 今のファイル（読めないもの・中枢と食い違うもの）を消さずに退避してから、chain を保存する。
  replace(chain: LedgerReplicaChain): Promise<void>;
}

export type LedgerSyncRequestOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: 'not_sent' }
  | { readonly kind: 'unknown' };

export interface ForgetLedgerSyncOptions {
  readonly store: LedgerReplicaStorePort;
  // POST /v1/forget-ledger/sync を送る（接続していなければ not_sent）。
  readonly request: (
    body: ForgetLedgerSyncRequest,
  ) => Promise<LedgerSyncRequestOutcome>;
  readonly valid: (
    name: 'ForgetLedgerDelta' | 'ForgetLedgerNotice',
    value: unknown,
  ) => boolean;
  readonly sha256: Sha256Hex;
  readonly log?: (code: string) => void;
  readonly maxPagesPerRun?: number;
}

export interface ForgetLedgerSyncState {
  // 保存できた複製の head（読めていなければ系譜 null・世代 0）。
  readonly head: ForgetLedgerSyncRequest;
  // 最後の同期で残した理由（追いついたら null）。
  readonly issue: LedgerReplicaIssue | null;
  // 次の保存で、今のファイルを退避するか（読めない複製・中枢と食い違う複製）。
  readonly replace_pending: boolean;
  // 送った同期の要求の数（試験と状態の確認用）。
  readonly requests: number;
}

type Target = Pick<
  ForgetLedgerNotice,
  'ledger_id' | 'forgetting_generation' | 'entry_hash'
>;

export class ForgetLedgerSync {
  readonly #options: ForgetLedgerSyncOptions;
  #load: Promise<void> | null = null;
  #chain: LedgerReplicaChain = EMPTY_LEDGER_CHAIN;
  #replaceNext = false;
  #issue: LedgerReplicaIssue | null = null;
  #requests = 0;
  #running: Promise<void> | null = null;
  // 同期の最中に来た接続・知らせ。接続なら終わった後にもう 1 回、知らせはその head に届いていなければもう 1 回。
  #again: 'connected' | Target | null = null;

  constructor(options: ForgetLedgerSyncOptions) {
    this.#options = options;
  }

  get state(): ForgetLedgerSyncState {
    return {
      head: ledgerSyncRequestOf(this.#chain),
      issue: this.#issue,
      replace_pending: this.#replaceNext,
      requests: this.#requests,
    };
  }

  // 接続した（live になった）。自分の head を送って追いつく。
  connected(): Promise<void> {
    return this.#trigger('connected');
  }

  // 「台帳が進んだ」知らせ。形が違えば捨てる。知らせの head をもう保存していれば何も取らない。
  async notice(raw: unknown): Promise<void> {
    if (!this.#options.valid('ForgetLedgerNotice', raw)) {
      this.#log('notice_invalid');
      return;
    }
    const notice = raw as ForgetLedgerNotice;
    await this.#ensureLoaded();
    if (this.#holds(notice)) return;
    await this.#trigger({
      ledger_id: notice.ledger_id,
      forgetting_generation: notice.forgetting_generation,
      entry_hash: notice.entry_hash,
    });
  }

  // 進行中の同期が終わるまで待つ（試験・終了の前）。
  async idle(): Promise<void> {
    while (this.#running !== null) await this.#running;
  }

  #log(code: string): void {
    this.#options.log?.(`forget_ledger:${code}`);
  }

  #ensureLoaded(): Promise<void> {
    this.#load ??= (async () => {
      let loaded: LedgerReplicaLoad;
      try {
        loaded = await this.#options.store.load();
      } catch {
        loaded = { kind: 'unreadable' };
      }
      if (loaded.kind === 'loaded') this.#chain = loaded.chain;
      else if (loaded.kind === 'unreadable') {
        this.#replaceNext = true;
        this.#log('replica_unreadable');
      }
    })();
    return this.#load;
  }

  // 保存した複製が、知らせの世代とその entry_hash をもう持っているか。
  #holds(target: Target): boolean {
    const chain = this.#chain;
    if (chain.ledger_id !== target.ledger_id) return false;
    if (!DECIMAL.test(target.forgetting_generation)) return false;
    const generation = BigInt(target.forgetting_generation);
    if (generation === 0n || generation > BigInt(chain.entries.length))
      return false;
    return (
      chain.entries[Number(generation) - 1]?.entry_hash === target.entry_hash
    );
  }

  #trigger(reason: 'connected' | Target): Promise<void> {
    if (this.#running !== null) {
      if (reason === 'connected' || this.#again !== 'connected')
        this.#again = reason;
      return this.#running;
    }
    const running = (async () => {
      try {
        await this.#ensureLoaded();
        for (;;) {
          this.#again = null;
          await this.#run();
          const again: 'connected' | Target | null = this.#again;
          if (again === null) break;
          if (again !== 'connected' && this.#holds(again)) break;
        }
      } finally {
        this.#running = null;
      }
    })();
    this.#running = running;
    return running;
  }

  #stop(issue: LedgerReplicaIssue): void {
    this.#issue = issue;
    this.#log(issue);
  }

  async #run(): Promise<void> {
    const options = this.#options;
    const maxPages = options.maxPagesPerRun ?? FORGET_LEDGER_SYNC_MAX_PAGES;
    // 送る head の連鎖。diverged の後は空（世代 0）から取り直す。
    let base = this.#replaceNext ? EMPTY_LEDGER_CHAIN : this.#chain;
    for (let page = 0; page < maxPages; page += 1) {
      this.#requests += 1;
      let outcome: LedgerSyncRequestOutcome;
      try {
        outcome = await options.request(ledgerSyncRequestOf(base));
      } catch {
        outcome = { kind: 'unknown' };
      }
      if (outcome.kind !== 'response') return this.#stop('unreachable');
      if (
        outcome.status !== 200 ||
        !options.valid('ForgetLedgerDelta', outcome.body)
      )
        return this.#stop('response_invalid');
      const applied = applyLedgerDelta(
        base,
        outcome.body as ForgetLedgerDelta,
        options.sha256,
      );
      if (applied.kind === 'replica_ahead') return this.#stop('replica_ahead');
      if (applied.kind === 'chain_invalid') return this.#stop('chain_invalid');
      if (applied.kind === 'diverged') {
        // 世代 0 を送っても食い違う応答は中枢の誤り。取り直しを繰り返さない。
        if (base.entries.length === 0) return this.#stop('diverged');
        this.#stop('diverged');
        this.#replaceNext = true;
        base = EMPTY_LEDGER_CHAIN;
        continue;
      }
      if (applied.added > 0) {
        const replacing = this.#replaceNext;
        // 同じ系譜の複製より中枢の head が古いなら、取り直した台帳で置き換えない（巻き戻さない）。
        if (
          replacing &&
          this.#chain.ledger_id === applied.chain.ledger_id &&
          applied.core_generation < BigInt(this.#chain.entries.length)
        )
          return this.#stop('replica_ahead');
        try {
          if (replacing) await options.store.replace(applied.chain);
          else await options.store.save(applied.chain);
        } catch {
          return this.#stop('save_failed');
        }
        if (replacing) this.#log('replica_set_aside');
        this.#chain = applied.chain;
        this.#replaceNext = false;
      }
      base = applied.chain;
      if (!applied.has_more) {
        // 中枢の台帳が空で、退避を待つ複製がある（読めない複製）: 保存する物がないので退避もしない。
        this.#issue = null;
        return;
      }
    }
    this.#stop('page_limit');
  }
}
