// 発言・元情報・派生物の期限削除（設計 03 保存期限、ADR 0043・0054・0058、B06-07a-1）。
//
// 掃除の計画（domain の sweepPlan）の入力に、発言（7／30 日）・元情報の本文（24 時間）・記憶（見直し待ち・削除）・
// 派生物（由来のうち最も早い期限）の行を足し、計画が「消す」とした行だけを物理削除する。
// - 読み出し（readExpiryRows）と削除（deleteExpiredRows）は同じ行の読み方を使う。削除の命令は、ID を受けたときに
//   その行を読み直し、domain の sweepPlan が今の時刻で「消す」と判定したときだけ消す（計画と命令を食い違わせない。
//   DB は時計を持たず、呼び出し側の now を信じる。時計の巻き戻りの保留は掃除の job が sweepPlan に通してから呼ぶ）。
// - 期限切れは忘却ではない。台帳には書かず、再登録を禁じない（ADR 0008・0040）。系譜の辺は pruneDeadLineage で、
//   生きた下流がなくなったときだけ回収する（ADR 0054 U110）。
// - 記憶は memory-store の memory.start_review・memory.delete_due を使う（ここでは読み出しだけ）。
// 結果には ID と件数だけを入れ、本文・SQL・パスを入れない。

import { RETENTION_RULES, sweepPlan } from '@buddy/domain';
import type { DerivedRow, MemoryRow, SweepRow, TimedRow } from '@buddy/domain';
import type { SqliteDatabase } from './connection.js';
import {
  deleteForgetNode,
  lineageSources,
  pruneDeadLineage,
} from './forget-store.js';
import type { LineageNode } from './forget-store.js';

const DAY_MS = 86_400_000;
// 完了した操作の本文の保存期間（RETENTION_RULES の operation_body。7 日）。
const BODY_TTL_MS = RETENTION_RULES['operation_body']?.ms ?? 7 * DAY_MS;
const HOUR_MS = 3_600_000;
const READABLE_MIN_MS = -62_167_219_200_000;
const READABLE_MAX_MS = 253_402_300_799_999;
// 期限のない由来（完了していない操作）。派生物の期限の計算で「ずっと先」を表す（9999-12-31T23:59:59Z）。
const FAR_FUTURE = '9999-12-31T23:59:59Z';

export class ExpiryRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'ExpiryRejection';
    this.reasons = reasons;
  }
}

const isoOrNull = (millis: number | null): string | null => {
  if (
    millis === null ||
    !Number.isSafeInteger(millis) ||
    millis < READABLE_MIN_MS ||
    millis > READABLE_MAX_MS
  )
    return null;
  return new Date(millis).toISOString().replace('.000Z', 'Z');
};

// --- 行の ID ---

const encode = (value: string): string => encodeURIComponent(value);

// 元情報の行の ID（提供元・口座・元サービスの ID）。口座の ID に区切り文字が入っても一意になる。
export function sourceItemRowId(
  provider: string,
  accountId: string,
  remoteId: string,
): string {
  return `${encode(provider)}/${encode(accountId)}/${encode(remoteId)}`;
}

function parseSourceItemRowId(
  id: string,
): { provider: string; accountId: string; remoteId: string } | null {
  const parts = id.split('/');
  if (parts.length !== 3) return null;
  try {
    const [provider, accountId, remoteId] = parts.map((part) =>
      decodeURIComponent(part),
    ) as [string, string, string];
    return sourceItemRowId(provider, accountId, remoteId) === id
      ? { provider, accountId, remoteId }
      : null;
  } catch {
    return null;
  }
}

// 派生物の行の ID（種類と ID）。
export const derivedRowId = (kind: string, id: string): string =>
  `${kind}:${id}`;

function parseDerivedRowId(
  id: string,
): { kind: string; artifactId: string } | null {
  const at = id.indexOf(':');
  if (at <= 0) return null;
  return { kind: id.slice(0, at), artifactId: id.slice(at + 1) };
}

// 期限を持つ派生物の種類のうち、掃除が扱うもの（行の表がある種類と、つないだ要約＝辺だけ）。
const DERIVED_KINDS: readonly string[] = [
  'session_summary',
  'carried_summary',
  'notification_candidate',
  'request_entity',
  'related_analysis',
  'intent_shadow',
  'async_guard',
];

// --- 読み出し ---

interface TurnSqlRow {
  turn_id: string;
  created_at: number;
  expires_at: number;
}

// 発言の規則: 保存した期限が作成から 30 日ちょうどなら extended、それ以外は normal（短い側。ADR 0058 の U138）。
// 規則から求めた期限と保存した期限の早い方を domain が使うので、保存した期限が 7 日より長い normal の行は 7 日に戻る。
function turnRule(row: TurnSqlRow): 'turn_normal' | 'turn_extended' {
  return row.expires_at - row.created_at === 30 * DAY_MS
    ? 'turn_extended'
    : 'turn_normal';
}

function readTurns(db: SqliteDatabase): TimedRow[] {
  const rows = db
    .prepare(
      'SELECT turn_id, created_at, expires_at FROM turns ORDER BY turn_id',
    )
    .all() as TurnSqlRow[];
  return rows.map((row) => timedTurn(row));
}

function timedTurn(row: TurnSqlRow): TimedRow {
  return {
    family: 'timed',
    rule: turnRule(row),
    id: row.turn_id,
    anchor_at: isoOrNull(row.created_at),
    delete_at: isoOrNull(row.expires_at),
  };
}

interface SourceItemSqlRow {
  provider: string;
  account_id: string;
  remote_id: string;
  fetched_at: number;
}

function timedSourceItem(row: SourceItemSqlRow): TimedRow {
  return {
    family: 'timed',
    rule: 'source_body',
    id: sourceItemRowId(row.provider, row.account_id, row.remote_id),
    anchor_at: isoOrNull(row.fetched_at),
    delete_at: null,
    notice_item_id: row.remote_id,
  };
}

function readSourceItems(db: SqliteDatabase): TimedRow[] {
  const rows = db
    .prepare(
      'SELECT provider, account_id, remote_id, fetched_at FROM source_items ORDER BY provider, account_id, remote_id',
    )
    .all() as SourceItemSqlRow[];
  return rows.map(timedSourceItem);
}

interface MemorySqlRow {
  memory_id: string;
  status: MemoryRow['status'];
  review_at: number;
  delete_at: number | null;
}

function memoryRow(row: MemorySqlRow): MemoryRow {
  return {
    family: 'memory',
    id: row.memory_id,
    status: row.status,
    // 読めない見直し日は空文字にする（domain が deadline_unreadable で残して使わない）。
    review_at: isoOrNull(row.review_at) ?? '',
    delete_at: isoOrNull(row.delete_at),
  };
}

function readMemories(db: SqliteDatabase): MemoryRow[] {
  const rows = db
    .prepare(
      'SELECT memory_id, status, review_at, delete_at FROM memories ORDER BY memory_id',
    )
    .all() as MemorySqlRow[];
  return rows.map(memoryRow);
}

// 派生物の由来 1 つの期限。由来の行がもうなければ null（存在しない由来は期限切れ。ADR 0040）。
function originExpiry(
  db: SqliteDatabase,
  kind: string,
  id: string,
  visiting: Set<string>,
): string | null {
  switch (kind) {
    case 'turn': {
      const row = db
        .prepare(
          'SELECT turn_id, created_at, expires_at FROM turns WHERE turn_id = ?',
        )
        .get(id) as TurnSqlRow | undefined;
      if (row === undefined) return null;
      // 発言自身の削除と同じ補正（規則の期限と保存した期限の小さい方）。保存した期限が 7 日より長い normal の行は
      // 7 日に戻る（AO レビュー P2）。
      const ttl = RETENTION_RULES[turnRule(row)]?.ms ?? 7 * DAY_MS;
      return isoOrNull(Math.min(row.expires_at, row.created_at + ttl));
    }
    case 'source_item': {
      // 本文のある行の保存期限（24 時間）の遅い方。本文のある行がなければ期限切れ（ADR 0054 U118 と同じ読み方）。
      const row = db
        .prepare(
          'SELECT max(fetched_at) AS fetched FROM source_items WHERE remote_id = ? AND body_blob_id IS NOT NULL',
        )
        .get(id) as { fetched: number | null };
      return row.fetched === null
        ? null
        : isoOrNull(row.fetched + 24 * HOUR_MS);
    }
    case 'memory': {
      const row = db
        .prepare(
          'SELECT status, review_at, delete_at FROM memories WHERE memory_id = ?',
        )
        .get(id) as
        | { status: string; review_at: number; delete_at: number | null }
        | undefined;
      if (row === undefined || row.status === 'deleted') return null;
      // 記憶自身の削除と同じ補正: 見直し待ちは保存した削除日と見直し日＋30 日の小さい方、有効な記憶は見直し日から
      // 30 日（見直し待ちを経て消える最も遅い日）。review_at＋90 日を保存した記憶も 30 日に戻す（AO レビュー P2）。
      const cap = row.review_at + 30 * DAY_MS;
      const deadline =
        row.status === 'review_pending' && row.delete_at !== null
          ? Math.min(row.delete_at, cap)
          : cap;
      return isoOrNull(deadline);
    }
    case 'operation_content': {
      const row = db
        .prepare(
          'SELECT state, completed_at FROM operations WHERE operation_id = ?',
        )
        .get(id) as { state: string; completed_at: number | null } | undefined;
      if (row === undefined) return null;
      // 操作の確定内容（本文）の期限。完了から 7 日で本文だけ消える（J5。90 日は本文のないレシートの期限）。
      // 本文がもう消えていれば期限切れ（存在しない由来は期限切れ。ADR 0040）。完了していない操作は期限がない。
      const body = db
        .prepare(
          'SELECT 1 FROM operation_versions WHERE operation_id = ? AND intent_blob_id IS NOT NULL LIMIT 1',
        )
        .get(id);
      if (body === undefined) return null;
      if (row.completed_at === null) return FAR_FUTURE;
      return isoOrNull(row.completed_at + BODY_TTL_MS);
    }
    default: {
      // ほかの派生物が由来のとき（要約の要約など）は、その派生物の期限。行がなければ期限切れ。
      if (!DERIVED_KINDS.includes(kind)) return null;
      const key = `${kind}:${id}`;
      if (visiting.has(key)) return null;
      visiting.add(key);
      try {
        if (!derivedExists(db, kind, id)) return null;
        const origins = derivedOrigins(db, kind, id, visiting);
        if (origins.length === 0) return null;
        const times: number[] = [];
        for (const origin of origins) {
          if (origin.expires_at === null) return null;
          times.push(Date.parse(origin.expires_at));
        }
        // その派生物自身の保存した期限（再要約・影モードなどで決めた値）との小さい方。由来として渡す期限にも反映し、
        // 二段以上の系譜でも、上流が消える日に下流も期限になる（AO レビュー P2）。
        const stored = storedDerivedDeadline(db, kind, id);
        if (stored !== null) times.push(Date.parse(stored));
        return isoOrNull(Math.min(...times));
      } finally {
        visiting.delete(key);
      }
    }
  }
}

// 派生物の行がまだあるか（carried_summary は表がないので、辺があればある）。
function derivedExists(db: SqliteDatabase, kind: string, id: string): boolean {
  const exists = (sql: string): boolean =>
    db.prepare(sql).get(id) !== undefined;
  switch (kind) {
    case 'session_summary':
      return exists(
        'SELECT 1 FROM sessions WHERE session_id = ? AND summary_blob_id IS NOT NULL',
      );
    case 'notification_candidate':
      return exists(
        'SELECT 1 FROM notification_candidates WHERE candidate_id = ?',
      );
    case 'request_entity':
      return exists(
        'SELECT 1 FROM request_entities WHERE request_entity_id = ?',
      );
    case 'related_analysis':
      return exists('SELECT 1 FROM related_analyses WHERE group_id = ?');
    case 'intent_shadow':
      return exists('SELECT 1 FROM intent_shadow WHERE record_id = ?');
    case 'async_guard':
      return exists('SELECT 1 FROM async_context_guards WHERE guard_id = ?');
    case 'carried_summary':
      return true;
    default:
      return false;
  }
}

// 派生物自身が保存している期限（作る・要約し直すときに決めた値）。ないものは null。
function storedDerivedDeadline(
  db: SqliteDatabase,
  kind: string,
  id: string,
): string | null {
  const value = (sql: string): number | null => {
    const row = db.prepare(sql).pluck().get(id) as number | null | undefined;
    return row ?? null;
  };
  switch (kind) {
    case 'request_entity':
      return isoOrNull(
        value(
          'SELECT delete_at FROM request_entities WHERE request_entity_id = ?',
        ),
      );
    case 'intent_shadow':
      return isoOrNull(
        value('SELECT expires_at FROM intent_shadow WHERE record_id = ?'),
      );
    case 'async_guard':
      return isoOrNull(
        value('SELECT expires_at FROM async_context_guards WHERE guard_id = ?'),
      );
    default:
      return null;
  }
}

function derivedOrigins(
  db: SqliteDatabase,
  kind: string,
  id: string,
  visiting: Set<string>,
): { origin_id: string; expires_at: string | null }[] {
  const edges = db
    .prepare(
      'SELECT source_kind, source_id FROM derivations WHERE artifact_kind = ? AND artifact_id = ? ORDER BY source_kind, source_id',
    )
    .all(kind, id) as { source_kind: string; source_id: string }[];
  return edges.map((edge) => ({
    origin_id: `${edge.source_kind}:${edge.source_id}`,
    expires_at: originExpiry(db, edge.source_kind, edge.source_id, visiting),
  }));
}

function derivedRow(db: SqliteDatabase, kind: string, id: string): DerivedRow {
  return {
    family: 'derived',
    artifact_kind: kind === 'carried_summary' ? 'carried_summary' : 'other',
    id: derivedRowId(kind, id),
    origins: derivedOrigins(db, kind, id, new Set([`${kind}:${id}`])),
    delete_at: storedDerivedDeadline(db, kind, id),
    notice_item_id: id,
  };
}

function readDerived(db: SqliteDatabase): DerivedRow[] {
  const placeholders = DERIVED_KINDS.map(() => '?').join(', ');
  const artifacts = db
    .prepare(
      `SELECT DISTINCT artifact_kind, artifact_id FROM derivations
        WHERE artifact_kind IN (${placeholders}) ORDER BY artifact_kind, artifact_id`,
    )
    .all(...DERIVED_KINDS) as { artifact_kind: string; artifact_id: string }[];
  const rows: DerivedRow[] = [];
  for (const artifact of artifacts) {
    // 行が先に消えた派生物の辺は、系譜の整理（pruneDeadLineage）に任せる。
    if (!derivedExists(db, artifact.artifact_kind, artifact.artifact_id))
      continue;
    rows.push(derivedRow(db, artifact.artifact_kind, artifact.artifact_id));
  }
  return rows;
}

// 掃除の計画へ足す行（発言・元情報・記憶・派生物）。
export function readExpiryRows(db: SqliteDatabase): readonly SweepRow[] {
  return [
    ...readTurns(db),
    ...readSourceItems(db),
    ...readMemories(db),
    ...readDerived(db),
  ];
}

// --- 削除 ---

export type ExpiryFamily = 'turn' | 'source_item' | 'derived';

export interface ExpiryDeleteValue {
  readonly deleted: readonly string[];
  readonly skipped: readonly {
    readonly id: string;
    readonly reasons: readonly string[];
  }[];
}

function currentRow(
  db: SqliteDatabase,
  family: ExpiryFamily,
  id: string,
): TimedRow | DerivedRow | null {
  if (family === 'turn') {
    const row = db
      .prepare(
        'SELECT turn_id, created_at, expires_at FROM turns WHERE turn_id = ?',
      )
      .get(id) as TurnSqlRow | undefined;
    return row === undefined ? null : timedTurn(row);
  }
  if (family === 'source_item') {
    const key = parseSourceItemRowId(id);
    if (key === null) return null;
    const row = db
      .prepare(
        'SELECT provider, account_id, remote_id, fetched_at FROM source_items WHERE provider = ? AND account_id = ? AND remote_id = ?',
      )
      .get(key.provider, key.accountId, key.remoteId) as
      SourceItemSqlRow | undefined;
    return row === undefined ? null : timedSourceItem(row);
  }
  const key = parseDerivedRowId(id);
  if (key === null || !DERIVED_KINDS.includes(key.kind)) return null;
  if (!derivedExists(db, key.kind, key.artifactId)) return null;
  const hasEdges = db
    .prepare(
      'SELECT 1 FROM derivations WHERE artifact_kind = ? AND artifact_id = ?',
    )
    .get(key.kind, key.artifactId);
  return hasEdges === undefined
    ? null
    : derivedRow(db, key.kind, key.artifactId);
}

// 計画が「消す」と判定する行か。時計の巻き戻りは見ない（last_checked_at を渡さない。now は呼び出し側が判定済み）。
function plannedDelete(row: TimedRow | DerivedRow, now: number): boolean {
  const plan = sweepPlan({
    now: new Date(now).toISOString().replace('.000Z', 'Z'),
    last_checked_at: null,
    rows: [row],
  });
  return (
    plan.ok &&
    plan.actions.some(
      (action) => action.action === 'delete_row' && action.id === row.id,
    )
  );
}

function deleteOne(
  db: SqliteDatabase,
  family: ExpiryFamily,
  id: string,
  now: number,
): void {
  const row = currentRow(db, family, id);
  if (row === null) throw new ExpiryRejection(['row_not_found']);
  if (!plannedDelete(row, now)) throw new ExpiryRejection(['not_due']);
  if (family === 'turn') {
    const node: LineageNode = { kind: 'turn', id };
    const parents = lineageSources(db, node);
    deleteForgetNode(db, node);
    pruneDeadLineage(db, [node, ...parents]);
    return;
  }
  if (family === 'source_item') {
    const key = parseSourceItemRowId(id) as {
      provider: string;
      accountId: string;
      remoteId: string;
    };
    const blob = db
      .prepare(
        'SELECT body_blob_id FROM source_items WHERE provider = ? AND account_id = ? AND remote_id = ?',
      )
      .pluck()
      .get(key.provider, key.accountId, key.remoteId) as string | null;
    db.prepare(
      'DELETE FROM source_items WHERE provider = ? AND account_id = ? AND remote_id = ?',
    ).run(key.provider, key.accountId, key.remoteId);
    if (blob !== null)
      db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(blob);
    pruneDeadLineage(db, [{ kind: 'source_item', id: key.remoteId }]);
    return;
  }
  const key = parseDerivedRowId(id) as { kind: string; artifactId: string };
  const node: LineageNode = { kind: key.kind, id: key.artifactId };
  const parents = lineageSources(db, node);
  if (key.kind === 'carried_summary') {
    // 表のない派生物（つないだ要約）は辺だけを消す。
    db.prepare(
      'DELETE FROM derivations WHERE artifact_kind = ? AND artifact_id = ?',
    ).run(node.kind, node.id);
  } else {
    deleteForgetNode(db, node);
  }
  pruneDeadLineage(db, [node, ...parents]);
}

// 期限の来た行を 1 件ずつ別の transaction で消す。呼び出し側（retention-store）が transaction を張る単位ごとに
// この関数を呼ぶ。
export function deleteExpiredRow(
  db: SqliteDatabase,
  family: ExpiryFamily,
  id: string,
  now: number,
): void {
  deleteOne(db, family, id, now);
}
