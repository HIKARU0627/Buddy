// 忘却の transaction（設計 03 忘却と再取り込み・バックアップ、08 §6、ADR 0040・0044・0054、マイグレーション 0012）。
//
// DB worker の中で実行する同期関数。1 つの忘却を 1 つの BEGIN IMMEDIATE の transaction で行う。
// - 系譜（derivations と memory_sources）・会話・記憶・操作の状態を transaction の中で読み直し、domain の planForget で
//   計画を作り直して、Core が渡した計画と同じであることを確かめる（読んでから適用するまでに派生物が増えていれば
//   forget_plan_stale で拒否し、Core が計画を作り直す。閉包の漏れを作らない）。
// - 元情報・発言の HMAC は Core が鍵で求めて渡す（worker は鍵を持たない）。計画に要る HMAC が渡されていなければ
//   source_hmac_missing で拒否する。
// - 台帳の行（連鎖の hash と項目の数）と項目・派生物と記憶と暗号文の物理削除・「〇〇を忘れて」の発言の削除・
//   残す操作への送出禁止の印（U61）を、同じ transaction で書く。進行中の操作の状態・承認・試行は変えず、再送もしない。
// - 台帳の別ファイルは DB の COMMIT の後に Core が書く（forget-ledger-file.ts。DB が正本で、ファイルは DB から作り直せる）。
// 結果には ID・件数・hash だけを入れ、本文・検索語・SQL・パスを入れない。

import { buildLedgerEntry, planForget } from '@buddy/domain';
import type {
  ForgetEntry,
  ForgetGraph,
  ForgetLedgerEntryDraft,
  ForgetNode,
  ForgetPlan,
  LedgerSource,
  MemorySource,
  NoticeItemDraft,
} from '@buddy/domain';
import type { SqliteDatabase } from './connection.js';
import { canonicalIntentJson, sha256OfCanonical } from './content-hash.js';
import { COMPLETED_OPERATION_STATES } from './operation-store.js';

export const LEDGER_ZERO_HASH = '0'.repeat(64);

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

export class ForgetRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'ForgetRejection';
    this.reasons = reasons;
  }
}

export interface SourceHmacValue {
  readonly source_kind: MemorySource['source_kind'];
  readonly source_id: string;
  readonly hmac: string;
}

// --- 台帳の読み出し ---

interface LedgerRow {
  forgetting_generation: number;
  entry_id: string;
  recorded_at: number;
  entry_hash: string | null;
  item_count: number | null;
}

interface LedgerItemRow {
  forgetting_generation: number;
  item_kind: string;
  item_id: string;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function ledgerSourceKey(item: LedgerSource): string {
  return item.source_kind === 'source_item'
    ? item.source_id_hmac
    : item.source_id;
}

// 台帳の 1 件の配列を決まった順にそろえる（hash の入力を DB の行の順に依らないものにする）。planForget の順と同じ。
export function normalizeLedgerEntry(
  entry: ForgetLedgerEntryDraft,
): ForgetLedgerEntryDraft {
  return {
    schema: 'buddy.forget-ledger.v1',
    entry_id: entry.entry_id,
    forgetting_generation: entry.forgetting_generation,
    recorded_at: entry.recorded_at,
    forgotten: [...entry.forgotten].sort(
      (a, b) =>
        compare(a.source_kind, b.source_kind) ||
        compare(ledgerSourceKey(a), ledgerSourceKey(b)),
    ),
    blocked_source_hmacs: [...entry.blocked_source_hmacs].sort(compare),
    blocked_content_keys: [...entry.blocked_content_keys].sort(compare),
  };
}

// 連鎖の hash: {entry, previous_hash} の JCS（RFC 8785）の UTF-8 の SHA-256（ADR 0040）。
export function ledgerEntryHash(
  entry: ForgetLedgerEntryDraft,
  previousHash: string,
): string {
  return sha256OfCanonical(
    canonicalIntentJson({
      entry: normalizeLedgerEntry(entry),
      previous_hash: previousHash,
    }),
  );
}

export function utcIso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface LedgerChainEntry {
  readonly entry: ForgetLedgerEntryDraft;
  readonly previous_hash: string;
  readonly entry_hash: string;
}

export interface ForgetLedgerExport {
  // 台帳の系譜。まだ 1 件も忘れていなければ null。
  readonly ledger_id: string | null;
  readonly entries: readonly LedgerChainEntry[];
  readonly head: {
    readonly forgetting_generation: string;
    readonly entry_hash: string;
  };
}

function entryFromRows(
  row: LedgerRow,
  items: readonly LedgerItemRow[],
): ForgetLedgerEntryDraft {
  const forgotten: LedgerSource[] = [];
  const blockedSources: string[] = [];
  const blockedContent: string[] = [];
  for (const item of items) {
    if (item.item_kind === 'turn' || item.item_kind === 'memory')
      forgotten.push({ source_kind: item.item_kind, source_id: item.item_id });
    else if (item.item_kind === 'source_item')
      forgotten.push({
        source_kind: 'source_item',
        source_id_hmac: item.item_id,
      });
    else if (item.item_kind === 'blocked_source')
      blockedSources.push(item.item_id);
    else if (item.item_kind === 'blocked_content')
      blockedContent.push(item.item_id);
  }
  return normalizeLedgerEntry({
    schema: 'buddy.forget-ledger.v1',
    entry_id: row.entry_id,
    forgetting_generation: String(row.forgetting_generation),
    recorded_at: utcIso(row.recorded_at),
    forgotten,
    blocked_source_hmacs: blockedSources,
    blocked_content_keys: blockedContent,
  });
}

// 台帳の全件を、連鎖の hash を計算し直して読む。保存した hash・項目の数と食い違えば拒否する（DB の行が書き換わった・
// 項目が欠けた）。0012 より前の行（hash が NULL）は計算した値をそのまま使う。
export function readLedgerChain(db: SqliteDatabase): LedgerChainEntry[] {
  const rows = db
    .prepare(
      'SELECT forgetting_generation, entry_id, recorded_at, entry_hash, item_count FROM forget_ledger ORDER BY forgetting_generation',
    )
    .all() as LedgerRow[];
  const items = db
    .prepare(
      'SELECT forgetting_generation, item_kind, item_id FROM forget_ledger_items ORDER BY forgetting_generation, item_kind, item_id',
    )
    .all() as LedgerItemRow[];
  const byGeneration = new Map<number, LedgerItemRow[]>();
  for (const item of items) {
    const list = byGeneration.get(item.forgetting_generation) ?? [];
    list.push(item);
    byGeneration.set(item.forgetting_generation, list);
  }
  const chain: LedgerChainEntry[] = [];
  let previous = LEDGER_ZERO_HASH;
  let expected = 1;
  for (const row of rows) {
    if (row.forgetting_generation !== expected)
      throw new ForgetRejection(['forget_ledger_gap']);
    expected += 1;
    const own = byGeneration.get(row.forgetting_generation) ?? [];
    if (row.item_count !== null && row.item_count !== own.length)
      throw new ForgetRejection(['forget_ledger_items_mismatch']);
    const entry = entryFromRows(row, own);
    if (entry.forgotten.length === 0)
      throw new ForgetRejection(['forget_ledger_items_mismatch']);
    const hash = ledgerEntryHash(entry, previous);
    if (row.entry_hash !== null && row.entry_hash !== hash)
      throw new ForgetRejection(['forget_ledger_hash_mismatch']);
    chain.push({ entry, previous_hash: previous, entry_hash: hash });
    previous = hash;
  }
  return chain;
}

export function readLedgerId(db: SqliteDatabase): string | null {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'ledger_id'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function exportForgetLedger(db: SqliteDatabase): ForgetLedgerExport {
  const entries = readLedgerChain(db);
  const ledgerId = readLedgerId(db);
  if (entries.length > 0 && ledgerId === null)
    throw new ForgetRejection(['ledger_id_missing']);
  const last = entries.at(-1);
  return {
    ledger_id: ledgerId,
    entries,
    head:
      last === undefined
        ? { forgetting_generation: '0', entry_hash: LEDGER_ZERO_HASH }
        : {
            forgetting_generation: last.entry.forgetting_generation,
            entry_hash: last.entry_hash,
          },
  };
}

export function currentForgettingGeneration(db: SqliteDatabase): number {
  const row = db
    .prepare(
      'SELECT coalesce(max(forgetting_generation), 0) AS value FROM forget_ledger',
    )
    .get() as { value: number };
  return row.value;
}

// 遅着の検査（ledgerRelationReasons）に渡す台帳の全件。
export function readLedgerEntries(db: SqliteDatabase): ForgetEntry[] {
  return readLedgerChain(db).map((item) => ({
    forgetting_generation: item.entry.forgetting_generation,
    forgotten: item.entry.forgotten,
    blocked_source_hmacs: item.entry.blocked_source_hmacs,
    blocked_content_keys: item.entry.blocked_content_keys,
  }));
}

// --- 系譜の読み出し ---

const nodeKey = (node: ForgetNode): string => `${node.kind}\u0000${node.id}`;

// 忘却の閉包に渡す系譜を DB から作る（ADR 0054）。
// - 辺: derivations の全行と memory_sources（記憶の由来。0001 の系譜）。
// - 由来を引けない派生物: 系譜の辺を持たない会話の要約（範囲は会話）と、影モードの記録（範囲は入力の発言）。
//   ほかの種類で辺を持たない行は、作る処理（B08・B09・B10）が辺を必ず書く前提で、ここでは数えない（U110）。
// - 発言と会話の対応は、範囲に出る会話の発言だけ。記憶は全件（内容の HMAC）。操作は確定内容の辺に出るものだけ。
export function readForgetGraph(db: SqliteDatabase): ForgetGraph {
  const edgeRows = db
    .prepare(
      'SELECT artifact_kind, artifact_id, source_kind, source_id FROM derivations ORDER BY artifact_kind, artifact_id, source_kind, source_id',
    )
    .all() as {
    artifact_kind: string;
    artifact_id: string;
    source_kind: string;
    source_id: string;
  }[];
  const memorySources = db
    .prepare(
      'SELECT memory_id, source_kind, source_id FROM memory_sources ORDER BY memory_id, source_kind, source_id',
    )
    .all() as { memory_id: string; source_kind: string; source_id: string }[];
  const seen = new Set<string>();
  const edges: { artifact: ForgetNode; source: ForgetNode }[] = [];
  const push = (artifact: ForgetNode, source: ForgetNode): void => {
    const key = `${nodeKey(artifact)}\u0001${nodeKey(source)}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ artifact, source });
  };
  for (const row of edgeRows)
    push(
      { kind: row.artifact_kind as ForgetNode['kind'], id: row.artifact_id },
      { kind: row.source_kind as ForgetNode['kind'], id: row.source_id },
    );
  for (const row of memorySources)
    push(
      { kind: 'memory', id: row.memory_id },
      { kind: row.source_kind as ForgetNode['kind'], id: row.source_id },
    );
  // 本人の指示は、作った発言（user_directives.turn_id）を由来にする派生物として閉包に入れる（U112。忘れた発言から作った
  // 指示の本文を残さない。計画の user_directives で消える指示を本人に見せる）。
  const directives = db
    .prepare(
      'SELECT directive_id, turn_id FROM user_directives WHERE turn_id IS NOT NULL ORDER BY directive_id',
    )
    .all() as { directive_id: string; turn_id: string }[];
  for (const row of directives)
    push(
      { kind: 'user_directive', id: row.directive_id },
      { kind: 'turn', id: row.turn_id },
    );
  const attributed = new Set(edges.map((edge) => nodeKey(edge.artifact)));
  const unattributed: { artifact: ForgetNode; scope: ForgetNode }[] = [];
  const summaries = db
    .prepare(
      'SELECT session_id FROM sessions WHERE summary_blob_id IS NOT NULL ORDER BY session_id',
    )
    .pluck()
    .all() as string[];
  for (const sessionId of summaries) {
    const artifact: ForgetNode = { kind: 'session_summary', id: sessionId };
    if (!attributed.has(nodeKey(artifact)))
      unattributed.push({
        artifact,
        scope: { kind: 'session', id: sessionId },
      });
  }
  const shadows = db
    .prepare(
      `SELECT s.record_id, i.turn_id FROM intent_shadow s
         JOIN input_snapshots i ON i.input_id = s.input_id AND i.request_revision = s.request_revision
        WHERE i.turn_id IS NOT NULL ORDER BY s.record_id`,
    )
    .all() as { record_id: string; turn_id: string }[];
  for (const row of shadows) {
    const artifact: ForgetNode = { kind: 'intent_shadow', id: row.record_id };
    if (!attributed.has(nodeKey(artifact)))
      unattributed.push({ artifact, scope: { kind: 'turn', id: row.turn_id } });
  }
  const sessionIds = [
    ...new Set(
      unattributed
        .filter((item) => item.scope.kind === 'session')
        .map((item) => item.scope.id),
    ),
  ];
  const turnSessions: { turn_id: string; session_id: string }[] = [];
  const turnsOf = db.prepare(
    'SELECT turn_id, session_id FROM turns WHERE session_id = ? ORDER BY turn_id',
  );
  for (const sessionId of sessionIds)
    turnSessions.push(
      ...(turnsOf.all(sessionId) as { turn_id: string; session_id: string }[]),
    );
  const memories = db
    .prepare('SELECT memory_id, dedupe_key FROM memories ORDER BY memory_id')
    .all() as { memory_id: string; dedupe_key: string }[];
  const operationIds = [
    ...new Set(
      edges.flatMap((edge) =>
        [edge.artifact, edge.source]
          .filter((node) => node.kind === 'operation_content')
          .map((node) => node.id),
      ),
    ),
  ].sort(compare);
  const stateOf = db.prepare(
    'SELECT state FROM operations WHERE operation_id = ?',
  );
  const operations: { operation_id: string; state: string }[] = [];
  for (const id of operationIds) {
    const state = stateOf.pluck().get(id) as string | undefined;
    if (state !== undefined) operations.push({ operation_id: id, state });
  }
  return {
    edges,
    unattributed,
    turn_sessions: turnSessions,
    memories,
    operations,
  };
}

// 対象が今あるか（resolveForgetTarget の known）。発言・記憶は行があること。元情報は、行がなくても台帳に書いて再取り込みを
// 止められるので、いつもあるものとして扱う。
export function forgetTargetExists(
  db: SqliteDatabase,
  target: MemorySource,
): boolean {
  if (target.source_kind === 'turn')
    return (
      db
        .prepare('SELECT 1 FROM turns WHERE turn_id = ?')
        .get(target.source_id) !== undefined
    );
  if (target.source_kind === 'memory')
    return (
      db
        .prepare('SELECT 1 FROM memories WHERE memory_id = ?')
        .get(target.source_id) !== undefined
    );
  return true;
}

// --- 期限で消した記憶の系譜の辺（ADR 0054 U110） ---

// 派生物の行がまだあるか（種類ごとの表。deleteNode と同じ表と ID）。表のない種類（canvas_item・carried_summary）は
// 確かめられないので、ある側に倒す（生きた下流への道を消さない）。行のない記憶は、その記憶が生きた派生物を持つ間は
// 道の途中として生きている扱い。
function artifactAlive(
  db: SqliteDatabase,
  kind: string,
  id: string,
  visiting: Set<string>,
): boolean {
  const exists = (sql: string): boolean =>
    db.prepare(sql).get(id) !== undefined;
  switch (kind) {
    case 'memory':
      return (
        exists('SELECT 1 FROM memories WHERE memory_id = ?') ||
        memoryHasLiveDerivatives(db, id, visiting)
      );
    case 'turn':
      return exists('SELECT 1 FROM turns WHERE turn_id = ?');
    case 'operation_content':
      // 操作の行がある間は残す（送出禁止で残した操作の確定内容の由来。90 日の削除で行が消える）。
      return exists('SELECT 1 FROM operations WHERE operation_id = ?');
    case 'intent_shadow':
      return exists('SELECT 1 FROM intent_shadow WHERE record_id = ?');
    case 'notification_candidate':
      return exists(
        'SELECT 1 FROM notification_candidates WHERE candidate_id = ?',
      );
    case 'related_analysis':
      return exists('SELECT 1 FROM related_analyses WHERE group_id = ?');
    case 'request_entity':
      return exists(
        'SELECT 1 FROM request_entities WHERE request_entity_id = ?',
      );
    case 'async_guard':
      return exists('SELECT 1 FROM async_context_guards WHERE guard_id = ?');
    case 'session_summary':
      return exists(
        'SELECT 1 FROM sessions WHERE session_id = ? AND summary_blob_id IS NOT NULL',
      );
    default:
      return true;
  }
}

function memoryHasLiveDerivatives(
  db: SqliteDatabase,
  memoryId: string,
  visiting: Set<string>,
): boolean {
  if (visiting.has(memoryId)) return false;
  visiting.add(memoryId);
  try {
    // memory_sources の子は、外部キーで行のある記憶だけ。
    if (
      db
        .prepare(
          "SELECT 1 FROM memory_sources WHERE source_kind = 'memory' AND source_id = ? LIMIT 1",
        )
        .get(memoryId) !== undefined
    )
      return true;
    const children = db
      .prepare(
        "SELECT artifact_kind, artifact_id FROM derivations WHERE source_kind = 'memory' AND source_id = ? ORDER BY artifact_kind, artifact_id",
      )
      .all(memoryId) as { artifact_kind: string; artifact_id: string }[];
    return children.some((child) =>
      artifactAlive(db, child.artifact_kind, child.artifact_id, visiting),
    );
  } finally {
    visiting.delete(memoryId);
  }
}

// 記憶を由来にする派生物（記憶・ほかの種類）で、行がまだあるもの（行のない記憶は、その下流が生きているもの）があるか。
export function memoryHasDerivatives(
  db: SqliteDatabase,
  memoryId: string,
): boolean {
  return memoryHasLiveDerivatives(db, memoryId, new Set());
}

// 記憶の由来の記憶（memory_sources と、期限で消した記憶に残した derivations の辺）。
export function memoryParents(db: SqliteDatabase, memoryId: string): string[] {
  return [
    ...new Set(
      db
        .prepare(
          "SELECT source_id FROM memory_sources WHERE memory_id = ? AND source_kind = 'memory' UNION SELECT source_id FROM derivations WHERE artifact_kind = 'memory' AND artifact_id = ? AND source_kind = 'memory'",
        )
        .pluck()
        .all(memoryId, memoryId) as string[],
    ),
  ];
}

// 行のない記憶（期限で消した記憶）に残した由来の辺は、生きた派生物がなくなれば消す。辺を消したら由来の記憶も
// 評価し直す（まだ生きた派生物があって残した記憶も、後で最後の派生物が消えれば消す。合流する系譜でも同じ）。
// その記憶を由来にする行のない派生物の辺（もう消えた派生物の残り）も一緒に消す。行のある記憶の辺には触れない。
export function pruneDeletedMemoryEdges(
  db: SqliteDatabase,
  memoryId: string,
): void {
  const queue = [memoryId];
  const pruned = new Set<string>();
  const live = db.prepare('SELECT 1 FROM memories WHERE memory_id = ?');
  while (queue.length > 0) {
    const id = queue.shift() as string;
    // 消した記憶はもう辺を持たない。生きている・生きた派生物を持つ記憶は、今は消さない（後の削除で評価し直す）。
    if (pruned.has(id)) continue;
    if (live.get(id) !== undefined || memoryHasDerivatives(db, id)) continue;
    const parents = memoryParents(db, id);
    // この記憶を由来にする行のない記憶（生きた派生物を持たない）も、辺を消した後に評価する。
    const children = db
      .prepare(
        "SELECT artifact_id FROM derivations WHERE source_kind = 'memory' AND source_id = ? AND artifact_kind = 'memory'",
      )
      .pluck()
      .all(id) as string[];
    db.prepare(
      "DELETE FROM derivations WHERE artifact_kind = 'memory' AND artifact_id = ?",
    ).run(id);
    db.prepare(
      "DELETE FROM derivations WHERE source_kind = 'memory' AND source_id = ?",
    ).run(id);
    pruned.add(id);
    queue.push(...parents, ...children);
  }
}

// 派生物（記憶以外）を消したときの系譜の整理。派生物としての辺を消し、由来の行のない記憶の辺も要らなくなれば消す。
export function removeArtifactEdges(
  db: SqliteDatabase,
  kind: string,
  id: string,
): void {
  const memorySources = db
    .prepare(
      "SELECT source_id FROM derivations WHERE artifact_kind = ? AND artifact_id = ? AND source_kind = 'memory'",
    )
    .pluck()
    .all(kind, id) as string[];
  db.prepare(
    'DELETE FROM derivations WHERE artifact_kind = ? AND artifact_id = ?',
  ).run(kind, id);
  for (const source of memorySources) pruneDeletedMemoryEdges(db, source);
}

// --- 適用 ---

export interface ForgetApplyInput {
  readonly target: MemorySource;
  readonly instruction_turn_id: string | null;
  // domain の planForget の結果（Core が forget.graph の系譜と鍵の HMAC で作った計画）。
  readonly plan: ForgetPlan;
  readonly source_hmacs: readonly SourceHmacValue[];
  // 台帳の 1 件の ID と、計画を作ったときの台帳の世代（今の世代と違えば拒否）。
  readonly entry_id: string;
  readonly previous_generation: string;
  // 台帳の系譜がまだなければ、この値で作る（あれば使わない）。
  readonly new_ledger_id: string;
  readonly now: number;
}

export interface ForgetApplyValue {
  readonly forgetting_generation: string;
  readonly entry_id: string;
  readonly entry_hash: string;
  readonly ledger_id: string;
  // 種類ごとに物理削除した行の数（今ない行は数えない）。
  readonly deleted: Readonly<Record<string, number>>;
  // 確定内容の暗号文を消した操作。
  readonly purged_operations: readonly string[];
  // 送出禁止の印を付けた操作（状態・承認・試行は変えていない）。
  readonly send_blocked_operations: readonly string[];
  // 知らせ（RetentionNotice の forgotten・derived_from_forgotten。ID だけ）。256 件ごとに分けて送る。
  readonly notice: {
    readonly forgotten: readonly NoticeItemDraft[];
    readonly derived_from_forgotten: readonly NoticeItemDraft[];
  };
}

function hmacLookup(
  values: readonly SourceHmacValue[],
): (source: MemorySource) => string {
  const map = new Map<string, string>();
  for (const value of values)
    map.set(`${value.source_kind}\u0000${value.source_id}`, value.hmac);
  return (source) => {
    const found = map.get(`${source.source_kind}\u0000${source.source_id}`);
    if (found === undefined) throw new ForgetRejection(['source_hmac_missing']);
    return found;
  };
}

function deleteBlob(db: SqliteDatabase, blobId: string | null): number {
  if (blobId === null) return 0;
  return db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(blobId)
    .changes;
}

// 種類ごとの物理削除。参照する側を先に消す（外部キーの違反を作らない）。消した行の数を返す。
// canvas_item・carried_summary は、まだ DB に表がない（UI-05 の永続のキャンバス・つないだ要約）。系譜の辺だけを消す。
function deleteNode(db: SqliteDatabase, node: ForgetNode): number {
  switch (node.kind) {
    case 'intent_shadow':
      return db
        .prepare('DELETE FROM intent_shadow WHERE record_id = ?')
        .run(node.id).changes;
    case 'notification_candidate':
      return deleteCandidates(db, 'candidate_id = ?', node.id);
    case 'related_analysis':
      // 関連解析は group_id を派生物の ID にする（解析の版はまとめて消す）。
      return db
        .prepare('DELETE FROM related_analyses WHERE group_id = ?')
        .run(node.id).changes;
    case 'request_entity': {
      const row = db
        .prepare(
          'SELECT summary_blob_id FROM request_entities WHERE request_entity_id = ?',
        )
        .get(node.id) as { summary_blob_id: string | null } | undefined;
      if (row === undefined) return 0;
      // 依頼から作った気づきと、一度だけの記録（依頼を参照する）を先に消す。
      deleteCandidates(db, 'request_entity_id = ?', node.id);
      db.prepare(
        'DELETE FROM request_entity_operations WHERE request_entity_id = ?',
      ).run(node.id);
      const removed = db
        .prepare('DELETE FROM request_entities WHERE request_entity_id = ?')
        .run(node.id).changes;
      deleteBlob(db, row.summary_blob_id);
      return removed;
    }
    case 'async_guard':
      return db
        .prepare('DELETE FROM async_context_guards WHERE guard_id = ?')
        .run(node.id).changes;
    case 'session_summary': {
      // 会話の要約は会話の行の暗号文の列。列を空にしてから暗号文を消す（会話の行は残す）。
      const blob = db
        .prepare('SELECT summary_blob_id FROM sessions WHERE session_id = ?')
        .pluck()
        .get(node.id) as string | null | undefined;
      if (blob === undefined || blob === null) return 0;
      db.prepare(
        'UPDATE sessions SET summary_blob_id = NULL WHERE session_id = ?',
      ).run(node.id);
      return deleteBlob(db, blob);
    }
    case 'memory': {
      const row = db
        .prepare(
          'SELECT text_blob_id, target_key_blob_id FROM memories WHERE memory_id = ?',
        )
        .get(node.id) as
        { text_blob_id: string; target_key_blob_id: string } | undefined;
      if (row === undefined) return 0;
      db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(node.id);
      const removed = db
        .prepare('DELETE FROM memories WHERE memory_id = ?')
        .run(node.id).changes;
      deleteBlob(db, row.text_blob_id);
      if (row.target_key_blob_id !== row.text_blob_id)
        deleteBlob(db, row.target_key_blob_id);
      return removed;
    }
    case 'turn': {
      const blob = db
        .prepare('SELECT text_blob_id FROM turns WHERE turn_id = ?')
        .pluck()
        .get(node.id) as string | null | undefined;
      if (blob === undefined) return 0;
      // 発言への応答（ID・決まった文だけ）は発言と一緒に消す。入力の版は残し、発言への結び付けだけを外す（操作の記録の
      // 監査）。この発言から作った本人の指示は閉包に入って先に消えている（U112）。結び付けを外すのは外部キーの保証。
      db.prepare('DELETE FROM turn_responses WHERE turn_id = ?').run(node.id);
      db.prepare(
        'UPDATE input_snapshots SET turn_id = NULL WHERE turn_id = ?',
      ).run(node.id);
      db.prepare(
        'UPDATE user_directives SET turn_id = NULL WHERE turn_id = ?',
      ).run(node.id);
      const removed = db
        .prepare('DELETE FROM turns WHERE turn_id = ?')
        .run(node.id).changes;
      deleteBlob(db, blob);
      return removed;
    }
    case 'user_directive': {
      // 本人の指示の行と本文の暗号文（directive.revoke と同じ消し方）。
      const blob = db
        .prepare(
          'SELECT text_blob_id FROM user_directives WHERE directive_id = ?',
        )
        .pluck()
        .get(node.id) as string | undefined;
      if (blob === undefined) return 0;
      const removed = db
        .prepare('DELETE FROM user_directives WHERE directive_id = ?')
        .run(node.id).changes;
      deleteBlob(db, blob);
      return removed;
    }
    case 'source_item': {
      // 元情報の参照は元サービスの ID（remote_id）。アカウントをまたいで同じ ID があればすべて消す（閉じた側。U110）。
      const blobs = db
        .prepare('SELECT body_blob_id FROM source_items WHERE remote_id = ?')
        .pluck()
        .all(node.id) as (string | null)[];
      const removed = db
        .prepare('DELETE FROM source_items WHERE remote_id = ?')
        .run(node.id).changes;
      for (const blob of blobs) deleteBlob(db, blob);
      return removed;
    }
    default:
      return 0;
  }
}

function deleteCandidates(
  db: SqliteDatabase,
  where: string,
  value: string,
): number {
  const rows = db
    .prepare(
      `SELECT candidate_id, title_blob_id, excerpt_blob_id FROM notification_candidates WHERE ${where}`,
    )
    .all(value) as {
    candidate_id: string;
    title_blob_id: string | null;
    excerpt_blob_id: string | null;
  }[];
  const remove = db.prepare(
    'DELETE FROM notification_candidates WHERE candidate_id = ?',
  );
  let count = 0;
  for (const row of rows) {
    count += remove.run(row.candidate_id).changes;
    deleteBlob(db, row.title_blob_id);
    deleteBlob(db, row.excerpt_blob_id);
  }
  return count;
}

// 確定内容（暗号文）を消す。終端の操作だけ（planForget の purge）。hash・行・承認・試行は残す（J5 と同じ）。
function purgeOperationContent(
  db: SqliteDatabase,
  operationId: string,
  now: number,
): boolean {
  const state = db
    .prepare('SELECT state FROM operations WHERE operation_id = ?')
    .pluck()
    .get(operationId) as string | undefined;
  if (state === undefined) return false;
  if (!(COMPLETED_OPERATION_STATES as readonly string[]).includes(state))
    throw new ForgetRejection(['operation_not_finished']);
  const versions = db
    .prepare(
      'SELECT content_version, intent_blob_id FROM operation_versions WHERE operation_id = ? AND intent_blob_id IS NOT NULL ORDER BY content_version',
    )
    .all(operationId) as { content_version: number; intent_blob_id: string }[];
  for (const version of versions) {
    db.prepare(
      'UPDATE operation_versions SET intent_blob_id = NULL, body_deleted_at = ? WHERE operation_id = ? AND content_version = ? AND intent_blob_id = ?',
    ).run(now, operationId, version.content_version, version.intent_blob_id);
    deleteBlob(db, version.intent_blob_id);
  }
  return versions.length > 0;
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalIntentJson(a) === canonicalIntentJson(b);
  } catch {
    return false;
  }
}

// 忘却を 1 つの transaction の中で適用する（呼び出し側が BEGIN IMMEDIATE を張る）。拒否は ForgetRejection で投げ、
// 呼び出し側が巻き戻す。
export function applyForget(
  db: SqliteDatabase,
  input: ForgetApplyInput,
): ForgetApplyValue {
  const current = currentForgettingGeneration(db);
  if (String(current) !== input.previous_generation)
    throw new ForgetRejection(['forgetting_generation_changed']);
  // 0012 より前の台帳の行があるのに系譜がなければ、ここで新しい系譜を出さない（起動時の確認と付け直しを待つ。U119）。
  if (current > 0 && readLedgerId(db) === null)
    throw new ForgetRejection(['ledger_id_missing']);
  if (!forgetTargetExists(db, input.target))
    throw new ForgetRejection(['target_not_found']);
  if (
    input.instruction_turn_id !== null &&
    db
      .prepare('SELECT 1 FROM turns WHERE turn_id = ?')
      .get(input.instruction_turn_id) === undefined
  )
    throw new ForgetRejection(['instruction_turn_not_found']);
  // 計画を DB の今の系譜で作り直し、Core の計画と同じかを確かめる。
  const graph = readForgetGraph(db);
  const replanned = planForget({
    target: input.target,
    instruction_turn_id: input.instruction_turn_id,
    executing_operation_id: null,
    graph,
    sourceHmac: hmacLookup(input.source_hmacs),
  });
  if (!replanned.ok) throw new ForgetRejection(replanned.reasons);
  if (!sameJson(replanned.plan, input.plan))
    throw new ForgetRejection(['forget_plan_stale']);
  const plan = replanned.plan;
  // 台帳の欄に本文を入れない（発言・記憶は Buddy 内の UUID。ADR 0040）。
  if (
    plan.ledger.forgotten.some(
      (item) =>
        item.source_kind !== 'source_item' && !UUID_V4.test(item.source_id),
    )
  )
    throw new ForgetRejection(['ledger_ref_invalid']);
  const built = buildLedgerEntry(plan.ledger, {
    entry_id: input.entry_id,
    previous_generation: input.previous_generation,
    recorded_at: utcIso(input.now),
  });
  if (!built.ok) throw new ForgetRejection(built.reasons);
  const entry = normalizeLedgerEntry(built.entry);
  const chain = readLedgerChain(db);
  const previousHash = chain.at(-1)?.entry_hash ?? LEDGER_ZERO_HASH;
  const entryHash = ledgerEntryHash(entry, previousHash);
  const generation = current + 1;
  const items: { kind: string; id: string }[] = [
    ...entry.forgotten.map((item) => ({
      kind: item.source_kind,
      id: ledgerSourceKey(item),
    })),
    ...entry.blocked_source_hmacs.map((id) => ({ kind: 'blocked_source', id })),
    ...entry.blocked_content_keys.map((id) => ({
      kind: 'blocked_content',
      id,
    })),
  ];
  db.prepare(
    'INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at, entry_hash, item_count) VALUES (?, ?, ?, ?, ?)',
  ).run(generation, input.entry_id, input.now, entryHash, items.length);
  const insertItem = db.prepare(
    'INSERT INTO forget_ledger_items (forgetting_generation, item_kind, item_id) VALUES (?, ?, ?)',
  );
  for (const item of items) insertItem.run(generation, item.kind, item.id);
  let ledgerId = readLedgerId(db);
  if (ledgerId === null) {
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('ledger_id', ?)",
    ).run(input.new_ledger_id);
    ledgerId = input.new_ledger_id;
  }
  // 物理削除（計画の順。参照する側から先）。
  const deleted: Record<string, number> = {};
  const removeEdges = db.prepare(
    'DELETE FROM derivations WHERE artifact_kind = ? AND artifact_id = ?',
  );
  const memoryParentIds = new Set<string>();
  const memorySourcesOf = (kind: string, id: string): string[] =>
    kind === 'memory'
      ? memoryParents(db, id)
      : (db
          .prepare(
            "SELECT source_id FROM derivations WHERE artifact_kind = ? AND artifact_id = ? AND source_kind = 'memory'",
          )
          .pluck()
          .all(kind, id) as string[]);
  for (const node of plan.deletions) {
    for (const parent of memorySourcesOf(node.kind, node.id))
      memoryParentIds.add(parent);
    const count = deleteNode(db, node);
    deleted[node.kind] = (deleted[node.kind] ?? 0) + count;
    removeEdges.run(node.kind, node.id);
  }
  // 確定内容。終端の操作は暗号文を消し、進行中・結果不明は状態を変えずに送出禁止の印だけを付ける。
  const purged: string[] = [];
  for (const operationId of plan.operation_contents.purge) {
    for (const parent of memorySourcesOf('operation_content', operationId))
      memoryParentIds.add(parent);
    if (purgeOperationContent(db, operationId, input.now))
      purged.push(operationId);
    removeEdges.run('operation_content', operationId);
  }
  // 期限で消した記憶に残した由来の辺は、派生物がなくなれば消す（系譜を読んで計画を照合した後なので、計画は変わらない）。
  for (const parent of memoryParentIds) pruneDeletedMemoryEdges(db, parent);
  const blocked: string[] = [];
  const mark = db.prepare(
    'UPDATE operations SET send_blocked_generation = ? WHERE operation_id = ? AND send_blocked_generation IS NULL',
  );
  for (const retained of plan.operation_contents.retained)
    if (mark.run(generation, retained.operation_id).changes === 1)
      blocked.push(retained.operation_id);
  // 台帳の別ファイルに書けるかを、ここで確かめる（連鎖を DB から作り直せること）。
  const after = readLedgerChain(db).at(-1);
  if (after === undefined || after.entry_hash !== entryHash)
    throw new ForgetRejection(['forget_ledger_hash_mismatch']);
  return {
    forgetting_generation: String(generation),
    entry_id: input.entry_id,
    entry_hash: entryHash,
    ledger_id: ledgerId,
    deleted,
    purged_operations: purged,
    send_blocked_operations: blocked,
    notice: plan.notice,
  };
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}
