// 公開 Web 調査の受付・保存（設計 05・10 §5、B12-05、ADR 0125〜0129・0135・0141）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、
// 同期の保存（sync-store.ts）と同じく、transaction の前に接続の耐久設定を読み戻す。
// - 状態・遷移・試行・出典の規則は domain が正本（webResearchStatusErrors / webResearchTransitionErrors /
//   webResearchAttemptsErrors / webResearchOutcomeErrors / webSourceRecordErrors / webQueryScreeningErrors）。
//   ここは保存済みの行を domain の型へ変換して適用し、結果をそのまま保存するだけで、規則を足さない。
// - URL は保存しない（本人の決定 A、ADR 0126）。出典の行に URL の列は無く、読み戻しでは常に null にする。
//   検査の policy は url_storage: 'disallowed' で固定する。
// - 検索結果（URL・タイトル・スニペット）と取得本文は保存しない。試行は件数と種類だけ、出典は抜粋・要約・
//   取得時刻・本文の hash だけを持つ（ADR 0077・0126）。
// - 受付は dedupe_key で冪等（同じ要求の再送・同時の重複でジョブは 1 つ。ADR 0135）。
// - 結果の理由にはコードだけを入れ、SQL・パス・値を入れない。

import Database from 'better-sqlite3';
import {
  RETENTION_RULES,
  WEB_RESEARCH_STATES,
  webQueryScreeningErrors,
  webResearchAttemptsErrors,
  webResearchFinalState,
  webResearchIsTerminal,
  webResearchOutcomeErrors,
  webResearchStatusErrors,
  webResearchTransitionErrors,
  webSourceRecordErrors,
} from '@buddy/domain';
import type {
  WebResearchAttemptsLike,
  WebResearchState,
  WebResearchStatusLike,
  WebSourceRecordLike,
} from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';

const ID = /^[\x21-\x7e]{1,128}$/u;
const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;
const REVISION = /^(0|[1-9][0-9]{0,15})$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
// URL は保存しない（本人の決定 A、ADR 0126）。出典・状態の検査はこの policy で固定する。
const POLICY = { url_storage: 'disallowed' } as const;
// 完了した調査の保持（workflow_result: 完了から 7 日。domain の RETENTION_RULES）。
const RESULT_RETENTION_MS =
  RETENTION_RULES['workflow_result']?.ms ?? 604_800_000;

// --- 契約の形（ワイヤ・保存の境界） ---

export interface ResearchScreeningRecord {
  readonly query_id: string;
  // 検査を通った検索語（passed の記録だけを保存する）。
  readonly screened_query: string;
  readonly input_sources: readonly string[];
  readonly rules_version: number;
  readonly outcome: 'passed';
  readonly rejected_reasons: readonly string[];
  readonly screened_at: string;
}

export interface ResearchSourceRecord {
  readonly source_id: string;
  readonly query_id: string;
  readonly basis: 'page_read';
  readonly fetched_at: string;
  readonly page_title: string | null;
  readonly excerpt: string | null;
  readonly summary: string | null;
  readonly content_hash: string;
  // 保存しないので常に null（ADR 0126）。
  readonly url: null;
}

export interface ResearchJobRecord {
  readonly workflow_id: string;
  readonly session_id: string;
  readonly dedupe_key: string;
  readonly query_id: string;
  readonly query: string;
  // WebResearchStatus の保存の形（transient_links は保存しないので常に null）。
  readonly status: WebResearchStatusLike;
  readonly screening: ResearchScreeningRecord;
  readonly attempts: WebResearchAttemptsLike;
  readonly sources: readonly ResearchSourceRecord[];
  // 要約が作れた時点で先に保存した完了文（completed へ進める前の落下に備える）。
  readonly pending_summary: string | null;
  readonly notified_at: string | null;
  // 対応する依頼（workflows）の状態。受付だけが先に保存され、依頼がまだ無いときは null（ADR 0135）。
  readonly workflow_state: string | null;
  // 依頼を作った発言（候補の由来に使う）。input_snapshots から引く。無ければ null。
  readonly turn_id: string | null;
}

export interface ResearchAcceptValue {
  readonly outcome: 'accepted' | 'duplicate';
  readonly workflow_id: string;
}

export interface ResearchRunnableEntry {
  readonly workflow_id: string;
  readonly workflow_state: string | null;
}

export interface ResearchRecoverValue {
  readonly runnable: readonly ResearchRunnableEntry[];
  // 完了したが気づきをまだ作っていない調査（回復のときにもう一度知らせる）。
  readonly unnotified: readonly string[];
  readonly expired: number;
  readonly orphans_canceled: number;
}

export type ResearchOp =
  | {
      readonly kind: 'research.accept';
      readonly workflow_id: string;
      readonly session_id: string;
      readonly dedupe_key: string;
      readonly request_revision: string;
      readonly screening: ResearchScreeningRecord;
      readonly now: string;
    }
  | { readonly kind: 'research.get'; readonly workflow_id: string }
  | { readonly kind: 'research.list_runnable' }
  | {
      readonly kind: 'research.record_progress';
      readonly workflow_id: string;
      readonly attempts: WebResearchAttemptsLike;
      readonly sources: readonly ResearchSourceRecord[];
      // 要約が作れたときだけ渡す完了文。それ以外は null（保存済みの値を消さない）。
      readonly pending_summary: string | null;
      readonly now: string;
    }
  | {
      readonly kind: 'research.advance';
      readonly workflow_id: string;
      readonly expected_state_revision: string;
      readonly to_state: WebResearchState;
      // 終わり方が決まる状態（no_results・held・failed・canceled）のときだけ。それ以外は null。
      readonly stop_reason: string | null;
      // completed のときだけ（無ければ保存済みの pending_summary を使う）。
      readonly result_summary: string | null;
      readonly now: string;
    }
  | {
      readonly kind: 'research.mark_notified';
      readonly workflow_id: string;
      readonly now: string;
    }
  | { readonly kind: 'research.recover'; readonly now: string };

export type ResearchOpKind = ResearchOp['kind'];

// 書込みを伴う命令（応答が失われたら成否不明として扱う。照会は拒否でよい）。
export const RESEARCH_WRITE_OPS: ReadonlySet<ResearchOpKind> = new Set([
  'research.accept',
  'research.record_progress',
  'research.advance',
  'research.mark_notified',
  'research.recover',
]);

export type ResearchOpValue =
  | ResearchAcceptValue
  | ResearchJobRecord
  | readonly ResearchRunnableEntry[]
  | ResearchRecoverValue
  | null;

export type ResearchOpResult =
  | { readonly ok: true; readonly value: ResearchOpValue }
  | {
      readonly ok: false;
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface ResearchStoreResult {
  readonly result: ResearchOpResult;
  readonly halt: boolean;
}

const OP_KINDS: ReadonlySet<string> = new Set<ResearchOpKind>([
  'research.accept',
  'research.get',
  'research.list_runnable',
  'research.record_progress',
  'research.advance',
  'research.mark_notified',
  'research.recover',
]);

class ResearchRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'ResearchRejection';
    this.reasons = reasons;
  }
}

// --- 形の検査 ---

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return false;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  return new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function screeningShapeReasons(screening: ResearchScreeningRecord): string[] {
  const reasons: string[] = [];
  if (screening === null || typeof screening !== 'object')
    return ['screening_invalid'];
  if (!isId(screening.query_id)) reasons.push('query_id_invalid');
  if (
    typeof screening.screened_query !== 'string' ||
    screening.screened_query.length < 1 ||
    screening.screened_query.length > 512
  )
    reasons.push('screened_query_invalid');
  if (
    !Array.isArray(screening.input_sources) ||
    screening.input_sources.length !== 1 ||
    screening.input_sources[0] !== 'user_question'
  )
    reasons.push('input_sources_invalid');
  if (!Number.isSafeInteger(screening.rules_version))
    reasons.push('rules_version_invalid');
  if (screening.outcome !== 'passed') reasons.push('screening_not_passed');
  if (
    !Array.isArray(screening.rejected_reasons) ||
    screening.rejected_reasons.length !== 0
  )
    reasons.push('rejected_reasons_invalid');
  if (!isIsoTime(screening.screened_at)) reasons.push('screened_at_invalid');
  return reasons;
}

function sourceShapeReasons(source: ResearchSourceRecord): string[] {
  const reasons: string[] = [];
  if (source === null || typeof source !== 'object') return ['source_invalid'];
  if (!isId(source.source_id)) reasons.push('source_id_invalid');
  if (!isId(source.query_id)) reasons.push('query_id_invalid');
  if (source.basis !== 'page_read') reasons.push('basis_invalid');
  if (!isIsoTime(source.fetched_at)) reasons.push('fetched_at_invalid');
  if (
    source.page_title !== null &&
    (typeof source.page_title !== 'string' ||
      source.page_title.length < 1 ||
      source.page_title.length > 200)
  )
    reasons.push('page_title_invalid');
  if (
    source.excerpt !== null &&
    (typeof source.excerpt !== 'string' ||
      source.excerpt.length < 1 ||
      source.excerpt.length > 500)
  )
    reasons.push('excerpt_invalid');
  if (
    source.summary !== null &&
    (typeof source.summary !== 'string' ||
      source.summary.length < 1 ||
      source.summary.length > 4000)
  )
    reasons.push('source_summary_invalid');
  if (
    typeof source.content_hash !== 'string' ||
    !HEX64.test(source.content_hash)
  )
    reasons.push('content_hash_invalid');
  if (source.url !== null) reasons.push('url_not_storable');
  return reasons;
}

function attemptsShapeReasons(attempts: WebResearchAttemptsLike): string[] {
  if (attempts === null || typeof attempts !== 'object')
    return ['attempts_invalid'];
  const reasons: string[] = [];
  if (!isId(attempts.workflow_id)) reasons.push('workflow_id_invalid');
  if (
    typeof attempts.request_revision !== 'string' ||
    !REVISION.test(attempts.request_revision)
  )
    reasons.push('request_revision_invalid');
  if (!Array.isArray(attempts.searches) || attempts.searches.length > 3)
    reasons.push('searches_invalid');
  if (
    !Array.isArray(attempts.search_denials) ||
    attempts.search_denials.length > 8
  )
    reasons.push('search_denials_invalid');
  if (!Array.isArray(attempts.pages) || attempts.pages.length > 5)
    reasons.push('pages_invalid');
  if (!Number.isSafeInteger(attempts.page_limit_denials))
    reasons.push('page_limit_denials_invalid');
  if (
    attempts.summary !== 'not_attempted' &&
    attempts.summary !== 'ok' &&
    attempts.summary !== 'budget_denied' &&
    attempts.summary !== 'failed'
  )
    reasons.push('summary_invalid');
  return reasons;
}

export function researchOpShapeReasons(op: ResearchOp): string[] {
  if (op === null || typeof op !== 'object' || !OP_KINDS.has(op.kind))
    return ['kind_invalid'];
  const reasons: string[] = [];
  switch (op.kind) {
    case 'research.accept':
      if (!isId(op.workflow_id)) reasons.push('workflow_id_invalid');
      if (!isId(op.session_id)) reasons.push('session_id_invalid');
      if (!isId(op.dedupe_key)) reasons.push('dedupe_key_invalid');
      if (!REVISION.test(op.request_revision))
        reasons.push('request_revision_invalid');
      reasons.push(...screeningShapeReasons(op.screening));
      if (!isIsoTime(op.now)) reasons.push('now_invalid');
      break;
    case 'research.get':
      if (!isId(op.workflow_id)) reasons.push('workflow_id_invalid');
      break;
    case 'research.mark_notified':
      if (!isId(op.workflow_id)) reasons.push('workflow_id_invalid');
      if (!isIsoTime(op.now)) reasons.push('now_invalid');
      break;
    case 'research.list_runnable':
      break;
    case 'research.record_progress':
      if (!isId(op.workflow_id)) reasons.push('workflow_id_invalid');
      reasons.push(...attemptsShapeReasons(op.attempts));
      if (!Array.isArray(op.sources) || op.sources.length > 5)
        reasons.push('sources_invalid');
      else
        for (const source of op.sources)
          reasons.push(...sourceShapeReasons(source));
      if (
        op.pending_summary !== null &&
        (typeof op.pending_summary !== 'string' ||
          op.pending_summary.length < 1 ||
          op.pending_summary.length > 4000)
      )
        reasons.push('pending_summary_invalid');
      if (!isIsoTime(op.now)) reasons.push('now_invalid');
      break;
    case 'research.advance':
      if (!isId(op.workflow_id)) reasons.push('workflow_id_invalid');
      if (!REVISION.test(op.expected_state_revision))
        reasons.push('expected_state_revision_invalid');
      if (!WEB_RESEARCH_STATES.includes(op.to_state))
        reasons.push('to_state_invalid');
      if (op.stop_reason !== null && typeof op.stop_reason !== 'string')
        reasons.push('stop_reason_invalid');
      if (
        op.result_summary !== null &&
        (typeof op.result_summary !== 'string' ||
          op.result_summary.length < 1 ||
          op.result_summary.length > 4000)
      )
        reasons.push('result_summary_invalid');
      if (!isIsoTime(op.now)) reasons.push('now_invalid');
      break;
    case 'research.recover':
      if (!isIsoTime(op.now)) reasons.push('now_invalid');
      break;
  }
  return reasons;
}

// --- 行の読み書き ---

interface JobRow {
  workflow_id: string;
  session_id: string;
  dedupe_key: string;
  query_id: string;
  query: string;
  request_revision: string;
  state: string;
  state_revision: number;
  stop_kind: string | null;
  stop_reason: string | null;
  result_summary: string | null;
  result_unread_count: number | null;
  result_scope_reduced: number | null;
  pending_summary: string | null;
  notified_at: number | null;
  accepted_at: number;
  updated_at: number;
  finished_at: number | null;
}

const JOB_COLUMNS = `workflow_id, session_id, dedupe_key, query_id, query, request_revision,
  state, state_revision, stop_kind, stop_reason, result_summary, result_unread_count,
  result_scope_reduced, pending_summary, notified_at, accepted_at, updated_at, finished_at`;

const toIso = (millis: number): string => new Date(millis).toISOString();

function readJobRow(
  db: SqliteDatabase,
  workflowId: string,
): JobRow | undefined {
  return db
    .prepare(`SELECT ${JOB_COLUMNS} FROM research_jobs WHERE workflow_id = ?`)
    .get(workflowId) as JobRow | undefined;
}

function statusOf(
  row: JobRow,
  sources: readonly WebSourceRecordLike[],
): WebResearchStatusLike {
  return {
    workflow_id: row.workflow_id,
    request_revision: row.request_revision,
    state_revision: String(row.state_revision),
    state: row.state,
    accepted_at: toIso(row.accepted_at),
    updated_at: toIso(row.updated_at),
    finished_at: row.finished_at === null ? null : toIso(row.finished_at),
    result:
      row.state === 'completed'
        ? {
            summary: row.result_summary ?? '',
            sources,
            unread_count: row.result_unread_count ?? 0,
            scope_reduced: row.result_scope_reduced === 1,
          }
        : null,
    stop:
      row.stop_kind === null
        ? null
        : { kind: row.stop_kind, reason: row.stop_reason ?? '' },
    transient_links: null,
  };
}

function readSources(
  db: SqliteDatabase,
  workflowId: string,
): ResearchSourceRecord[] {
  const rows = db
    .prepare(
      `SELECT source_id, query_id, fetched_at, page_title, excerpt_text, summary_text, content_hash
       FROM research_sources WHERE workflow_id = ? ORDER BY fetched_at, source_id`,
    )
    .all(workflowId) as {
    source_id: string;
    query_id: string;
    fetched_at: number;
    page_title: string | null;
    excerpt_text: string | null;
    summary_text: string | null;
    content_hash: string;
  }[];
  return rows.map((row) => ({
    source_id: row.source_id,
    query_id: row.query_id,
    basis: 'page_read' as const,
    fetched_at: toIso(row.fetched_at),
    page_title: row.page_title,
    excerpt: row.excerpt_text,
    summary: row.summary_text,
    content_hash: row.content_hash,
    url: null,
  }));
}

function readAttempts(
  db: SqliteDatabase,
  row: JobRow,
): WebResearchAttemptsLike {
  const stored = db
    .prepare(
      'SELECT attempts_json FROM research_attempts WHERE workflow_id = ?',
    )
    .get(row.workflow_id) as { attempts_json: string } | undefined;
  if (stored === undefined) throw new ResearchRejection(['attempts_missing']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.attempts_json);
  } catch {
    throw new ResearchRejection(['attempts_unreadable']);
  }
  const attempts = parsed as WebResearchAttemptsLike;
  if (
    attempts === null ||
    typeof attempts !== 'object' ||
    attempts.workflow_id !== row.workflow_id ||
    attempts.request_revision !== row.request_revision
  )
    throw new ResearchRejection(['attempts_mismatch']);
  return attempts;
}

function emptyAttempts(row: {
  workflow_id: string;
  request_revision: string;
}): WebResearchAttemptsLike {
  return {
    workflow_id: row.workflow_id,
    request_revision: row.request_revision,
    searches: [],
    search_denials: [],
    pages: [],
    page_limit_denials: 0,
    summary: 'not_attempted',
  };
}

function readRecord(
  db: SqliteDatabase,
  workflowId: string,
): ResearchJobRecord | null {
  const row = readJobRow(db, workflowId);
  if (row === undefined) return null;
  const screeningRow = db
    .prepare(
      `SELECT query_id, screened_query, input_sources, rules_version, rejected_reasons, screened_at
       FROM research_screenings WHERE workflow_id = ?`,
    )
    .get(workflowId) as
    | {
        query_id: string;
        screened_query: string;
        input_sources: string;
        rules_version: number;
        rejected_reasons: string;
        screened_at: number;
      }
    | undefined;
  if (screeningRow === undefined)
    throw new ResearchRejection(['screening_missing']);
  const sources = readSources(db, workflowId);
  const status = statusOf(row, sources.map(toSourceLike));
  const workflow = db
    .prepare('SELECT state FROM workflows WHERE workflow_id = ?')
    .get(workflowId) as { state: string } | undefined;
  const turn = db
    .prepare(
      'SELECT turn_id FROM input_snapshots WHERE workflow_id = ? ORDER BY rowid LIMIT 1',
    )
    .get(workflowId) as { turn_id: string } | undefined;
  return {
    workflow_id: row.workflow_id,
    session_id: row.session_id,
    dedupe_key: row.dedupe_key,
    query_id: row.query_id,
    query: row.query,
    status,
    screening: {
      query_id: screeningRow.query_id,
      screened_query: screeningRow.screened_query,
      input_sources: JSON.parse(screeningRow.input_sources) as string[],
      rules_version: screeningRow.rules_version,
      outcome: 'passed',
      rejected_reasons: JSON.parse(screeningRow.rejected_reasons) as string[],
      screened_at: toIso(screeningRow.screened_at),
    },
    attempts: readAttempts(db, row),
    sources,
    pending_summary: row.pending_summary,
    notified_at: row.notified_at === null ? null : toIso(row.notified_at),
    workflow_state: workflow?.state ?? null,
    turn_id: turn?.turn_id ?? null,
  };
}

function toSourceLike(source: ResearchSourceRecord): WebSourceRecordLike {
  return {
    source_id: source.source_id,
    basis: source.basis,
    fetched_at: source.fetched_at,
    excerpt: source.excerpt,
    summary: source.summary,
    url: null,
  };
}

// --- 書込みの適用（transaction の中） ---

function applyAccept(
  db: SqliteDatabase,
  op: Extract<ResearchOp, { kind: 'research.accept' }>,
): ResearchAcceptValue {
  // 検査の記録そのものの整合（domain が正本）。passed でなければ受け付けない。
  const screeningErrors = webQueryScreeningErrors({
    query_id: op.screening.query_id,
    screened_query: op.screening.screened_query,
    input_sources: op.screening.input_sources,
    rules_version: op.screening.rules_version,
    outcome: op.screening.outcome,
    rejected_reasons: op.screening.rejected_reasons,
  });
  if (screeningErrors.length > 0)
    throw new ResearchRejection(
      screeningErrors.map((error) => `screening_${error}`),
    );
  const byDedupe = db
    .prepare('SELECT workflow_id FROM research_jobs WHERE dedupe_key = ?')
    .get(op.dedupe_key) as { workflow_id: string } | undefined;
  if (byDedupe !== undefined)
    return { outcome: 'duplicate', workflow_id: byDedupe.workflow_id };
  const byWorkflow = readJobRow(db, op.workflow_id);
  if (byWorkflow !== undefined)
    throw new ResearchRejection(['workflow_conflict']);
  const now = Date.parse(op.now);
  db.prepare(
    `INSERT INTO research_jobs (${JOB_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, 'accepted', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    op.workflow_id,
    op.session_id,
    op.dedupe_key,
    op.screening.query_id,
    op.screening.screened_query,
    op.request_revision,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO research_screenings (query_id, workflow_id, screened_query, input_sources, rules_version, outcome, rejected_reasons, screened_at)
     VALUES (?, ?, ?, ?, ?, 'passed', ?, ?)`,
  ).run(
    op.screening.query_id,
    op.workflow_id,
    op.screening.screened_query,
    JSON.stringify(op.screening.input_sources),
    op.screening.rules_version,
    JSON.stringify(op.screening.rejected_reasons),
    Date.parse(op.screening.screened_at),
  );
  db.prepare(
    'INSERT INTO research_attempts (workflow_id, attempts_json) VALUES (?, ?)',
  ).run(
    op.workflow_id,
    JSON.stringify(
      emptyAttempts({
        workflow_id: op.workflow_id,
        request_revision: op.request_revision,
      }),
    ),
  );
  return { outcome: 'accepted', workflow_id: op.workflow_id };
}

function applyRecordProgress(
  db: SqliteDatabase,
  op: Extract<ResearchOp, { kind: 'research.record_progress' }>,
): null {
  const row = readJobRow(db, op.workflow_id);
  if (row === undefined) throw new ResearchRejection(['job_missing']);
  if (webResearchIsTerminal(row.state as WebResearchState))
    throw new ResearchRejection(['job_terminal']);
  if (
    op.attempts.workflow_id !== op.workflow_id ||
    op.attempts.request_revision !== row.request_revision
  )
    throw new ResearchRejection(['attempts_mismatch']);
  const attemptErrors = webResearchAttemptsErrors(op.attempts);
  if (attemptErrors.length > 0)
    throw new ResearchRejection(
      attemptErrors.map((error) => `attempts_${error}`),
    );
  for (const source of op.sources) {
    const errors = webSourceRecordErrors(toSourceLike(source), POLICY);
    if (errors.length > 0)
      throw new ResearchRejection(errors.map((error) => `source_${error}`));
    // 出典は、読めたページの試行と対応するものだけを持つ（読んでいないページの出典を作らない）。
    if (
      !op.attempts.pages.some(
        (page) =>
          page.query_id === source.query_id &&
          page.source_id === source.source_id &&
          page.outcome === 'read',
      )
    )
      throw new ResearchRejection(['source_attempt_mismatch']);
  }
  db.prepare(
    'UPDATE research_attempts SET attempts_json = ? WHERE workflow_id = ?',
  ).run(JSON.stringify(op.attempts), op.workflow_id);
  const upsert = db.prepare(
    `INSERT INTO research_sources (source_id, workflow_id, query_id, fetched_at, page_title, excerpt_text, summary_text, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET summary_text = excluded.summary_text`,
  );
  for (const source of op.sources)
    upsert.run(
      source.source_id,
      op.workflow_id,
      source.query_id,
      Date.parse(source.fetched_at),
      source.page_title,
      source.excerpt,
      source.summary,
      source.content_hash,
    );
  if (op.pending_summary !== null)
    db.prepare(
      'UPDATE research_jobs SET pending_summary = ? WHERE workflow_id = ?',
    ).run(op.pending_summary, op.workflow_id);
  db.prepare(
    'UPDATE research_jobs SET updated_at = ? WHERE workflow_id = ?',
  ).run(Date.parse(op.now), op.workflow_id);
  return null;
}

function applyAdvance(
  db: SqliteDatabase,
  op: Extract<ResearchOp, { kind: 'research.advance' }>,
): ResearchJobRecord {
  const row = readJobRow(db, op.workflow_id);
  if (row === undefined) throw new ResearchRejection(['job_missing']);
  if (String(row.state_revision) !== op.expected_state_revision)
    throw new ResearchRejection(['state_revision_conflict']);
  const attempts = readAttempts(db, row);
  const sources = readSources(db, op.workflow_id);
  const previous = statusOf(row, sources.map(toSourceLike));
  const terminal = webResearchIsTerminal(op.to_state);
  let stop: WebResearchStatusLike['stop'] = null;
  if (
    op.to_state === 'no_results' ||
    op.to_state === 'held' ||
    op.to_state === 'failed' ||
    op.to_state === 'canceled'
  ) {
    if (op.stop_reason === null)
      throw new ResearchRejection(['stop_reason_missing']);
    stop = { kind: op.to_state, reason: op.stop_reason };
  } else if (op.stop_reason !== null)
    throw new ResearchRejection(['stop_reason_unexpected']);
  if (op.to_state !== 'completed' && op.result_summary !== null)
    throw new ResearchRejection(['result_summary_unexpected']);
  let result: WebResearchStatusLike['result'] = null;
  if (op.to_state === 'completed') {
    const summary = op.result_summary ?? row.pending_summary;
    if (summary === null)
      throw new ResearchRejection(['result_summary_missing']);
    const final = webResearchFinalState(attempts);
    if (final === null || final.state !== 'completed')
      throw new ResearchRejection(['attempts_unfinished']);
    result = {
      summary,
      sources: sources.map(toSourceLike),
      unread_count: final.unread_count,
      scope_reduced: final.scope_reduced,
    };
  }
  const next: WebResearchStatusLike = {
    workflow_id: row.workflow_id,
    request_revision: row.request_revision,
    state_revision: String(row.state_revision + 1),
    state: op.to_state,
    accepted_at: previous.accepted_at,
    updated_at: op.now,
    finished_at: terminal ? op.now : null,
    result,
    stop,
    transient_links: null,
  };
  const transitionErrors = webResearchTransitionErrors(previous, next);
  if (transitionErrors.length > 0)
    throw new ResearchRejection(
      transitionErrors.map((error) => `transition_${error}`),
    );
  const statusErrors = webResearchStatusErrors(next, POLICY);
  if (statusErrors.length > 0)
    throw new ResearchRejection(statusErrors.map((error) => `status_${error}`));
  if (
    next.state === 'completed' ||
    next.state === 'no_results' ||
    next.state === 'held' ||
    next.state === 'failed'
  ) {
    const outcomeErrors = webResearchOutcomeErrors(next, attempts);
    if (outcomeErrors.length > 0)
      throw new ResearchRejection(
        outcomeErrors.map((error) => `outcome_${error}`),
      );
  }
  const now = Date.parse(op.now);
  db.prepare(
    `UPDATE research_jobs SET state = ?, state_revision = ?, stop_kind = ?, stop_reason = ?,
       result_summary = ?, result_unread_count = ?, result_scope_reduced = ?,
       updated_at = ?, finished_at = ?, delete_at = ?
     WHERE workflow_id = ?`,
  ).run(
    next.state,
    row.state_revision + 1,
    next.stop?.kind ?? null,
    next.stop?.reason ?? null,
    next.result?.summary ?? null,
    next.result?.unread_count ?? null,
    next.result === null ? null : next.result.scope_reduced ? 1 : 0,
    now,
    next.finished_at === null ? null : Date.parse(next.finished_at),
    terminal ? now + RESULT_RETENTION_MS : null,
    op.workflow_id,
  );
  if (terminal)
    // 依頼の状態も同じ transaction で終える（実行中から完了へ。ADR 0135 の遷移は実行器が持つ）。
    db.prepare(
      "UPDATE workflows SET state = 'done', updated_at = ? WHERE workflow_id = ? AND state = 'executing'",
    ).run(now, op.workflow_id);
  const record = readRecord(db, op.workflow_id);
  if (record === null) throw new ResearchRejection(['job_missing']);
  return record;
}

function applyRecover(
  db: SqliteDatabase,
  op: Extract<ResearchOp, { kind: 'research.recover' }>,
): ResearchRecoverValue {
  const now = Date.parse(op.now);
  // 保持を過ぎた終端の調査を消す（出典・試行・検査の記録も一緒に）。
  const expiredRows = db
    .prepare(
      'SELECT workflow_id FROM research_jobs WHERE delete_at IS NOT NULL AND delete_at <= ?',
    )
    .all(now) as { workflow_id: string }[];
  for (const { workflow_id } of expiredRows) {
    db.prepare('DELETE FROM research_sources WHERE workflow_id = ?').run(
      workflow_id,
    );
    db.prepare('DELETE FROM research_attempts WHERE workflow_id = ?').run(
      workflow_id,
    );
    db.prepare('DELETE FROM research_screenings WHERE workflow_id = ?').run(
      workflow_id,
    );
    db.prepare('DELETE FROM research_jobs WHERE workflow_id = ?').run(
      workflow_id,
    );
  }
  // 受付だけが保存され、対応する依頼が無い調査は、本人の要求として成立していないので取り消す（ADR 0135・0141）。
  const orphans = db
    .prepare(
      `SELECT j.workflow_id, j.state_revision FROM research_jobs j
       LEFT JOIN workflows w ON w.workflow_id = j.workflow_id
       WHERE w.workflow_id IS NULL AND j.state IN ('accepted', 'searching', 'reading', 'summarizing', 'held')`,
    )
    .all() as { workflow_id: string; state_revision: number }[];
  for (const orphan of orphans)
    db.prepare(
      `UPDATE research_jobs SET state = 'canceled', state_revision = ?, stop_kind = 'canceled',
         stop_reason = 'superseded', updated_at = ?, finished_at = ?, delete_at = ?
       WHERE workflow_id = ?`,
    ).run(
      orphan.state_revision + 1,
      now,
      now,
      now + RESULT_RETENTION_MS,
      orphan.workflow_id,
    );
  const runnable = db
    .prepare(
      `SELECT j.workflow_id, w.state AS workflow_state FROM research_jobs j
       LEFT JOIN workflows w ON w.workflow_id = j.workflow_id
       WHERE j.state IN ('accepted', 'searching', 'reading', 'summarizing')
       ORDER BY j.accepted_at, j.workflow_id`,
    )
    .all() as ResearchRunnableEntry[];
  const unnotified = db
    .prepare(
      "SELECT workflow_id FROM research_jobs WHERE state = 'completed' AND notified_at IS NULL ORDER BY finished_at, workflow_id",
    )
    .all() as { workflow_id: string }[];
  return {
    runnable,
    unnotified: unnotified.map((row) => row.workflow_id),
    expired: expiredRows.length,
    orphans_canceled: orphans.length,
  };
}

function listRunnable(db: SqliteDatabase): ResearchRunnableEntry[] {
  return db
    .prepare(
      `SELECT j.workflow_id, w.state AS workflow_state FROM research_jobs j
       LEFT JOIN workflows w ON w.workflow_id = j.workflow_id
       WHERE j.state IN ('accepted', 'searching', 'reading', 'summarizing')
       ORDER BY j.accepted_at, j.workflow_id`,
    )
    .all() as ResearchRunnableEntry[];
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): ResearchOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

// 調査の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeResearchOp(
  db: SqliteDatabase,
  op: ResearchOp,
  context: { readonly platform: StoragePlatform; readonly halted: boolean },
): ResearchStoreResult {
  const shape = researchOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'research.get') {
    try {
      return {
        result: { ok: true, value: readRecord(db, op.workflow_id) },
        halt: false,
      };
    } catch (error) {
      if (error instanceof ResearchRejection)
        return { result: rejected(error.reasons), halt: false };
      throw error;
    }
  }
  if (op.kind === 'research.list_runnable')
    return { result: { ok: true, value: listRunnable(db) }, halt: false };
  // 書込みを止めた worker は書かない（ADR 0018）。照会は続ける。
  if (context.halted)
    return { result: rejected(['worker_halted']), halt: false };
  const durability = writeConnectionReasons(db, context.platform);
  if (durability.length > 0)
    return {
      result: rejected(['durability_mismatch', ...durability]),
      halt: true,
    };
  try {
    const run = runImmediate(db, (): ResearchOpValue => {
      switch (op.kind) {
        case 'research.accept':
          return applyAccept(db, op);
        case 'research.record_progress':
          return applyRecordProgress(db, op);
        case 'research.advance':
          return applyAdvance(db, op);
        case 'research.mark_notified': {
          const row = readJobRow(db, op.workflow_id);
          if (row === undefined) throw new ResearchRejection(['job_missing']);
          db.prepare(
            "UPDATE research_jobs SET notified_at = ? WHERE workflow_id = ? AND state = 'completed' AND notified_at IS NULL",
          ).run(Date.parse(op.now), op.workflow_id);
          return null;
        }
        case 'research.recover':
          return applyRecover(db, op);
        default:
          throw new ResearchRejection(['kind_invalid']);
      }
    });
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof ResearchRejection)
      return { result: rejected(error.reasons), halt: false };
    if (error instanceof Error && error.name === 'CommitUncertain')
      return {
        result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
        halt: true,
      };
    const code = sqliteCode(error);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
      return { result: rejected(['database_busy']), halt: false };
    if (code?.startsWith('SQLITE_CONSTRAINT'))
      return { result: rejected(['constraint_violation']), halt: false };
    return {
      result: rejected([
        code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
      ]),
      halt: true,
    };
  }
}
