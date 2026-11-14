// 気づき（候補）の保存（設計 11 §4、設計 03、ADR 0073・0115〜0118、マイグレーション 0013、B11-03）。
//
// - candidate.create: 候補を 1 行で作る。同じ transaction の中で次の順に判定する（読んでから書くまでの間に別の writer が入らない）。
//     0. 形の検査と、由来（発言・元情報）がまだあること（忘却・期限切れで消えた由来から候補を作らない最後のガード）。
//     1. 同じ notification_key の行があれば、書かずに duplicate（再同期・再接続で二重に作らない。却下・解決の後も
//        識別子が残る間は作らない）。
//     2. 題と抄録（暗号化済みの封筒）・候補の行・由来の辺（derivations）を書く。辺がないと忘却の閉包の対象にならない。
// - candidate.transition: 状態を 1 つ遷移させる。呼び出し側が見ていた状態（expected_state）と今の状態を照合し、
//   domain の candidateTransition が許す遷移だけを書く。期限切れ・スヌーズの終わりは、行を読み直して
//   candidateDueEvent が同じ遷移を返すときだけ書く（時計の判断を呼び出し側だけに任せない）。閉じる遷移は
//   閉じた時刻と識別子の削除日（7 日 + 90 日）を同時に書く。
// - candidate.list / candidate.get / candidate.counts: 読み取り。題・抄録は暗号化した封筒のまま返す（復号は Core）。
// - candidate.sweep: 閉じた候補の保持の掃除。解決・却下から 7 日で題・抄録（封筒）を消し、97 日で識別子の行ごと消す
//   （段階は domain の candidateRetentionPhase）。活動中の候補は消さない。元情報（source_item）の期限では消えない
//   （期限の掃除は元情報を由来の期限に数えない。expiry-store・ADR 0118）。
// 時刻は呼び出し側の値を信じる（DB は時計を持たない）。結果には ID・件数・状態だけを入れ、SQL・パスを入れない。

import Database from 'better-sqlite3';
import {
  CANDIDATE_EVENTS,
  CANDIDATE_STATES,
  candidateDueEvent,
  candidateRetentionPhase,
  candidateTransition,
  checkSnoozeUntil,
  isCandidateZone,
} from '@buddy/domain';
import type { CandidateEvent, CandidateState, Deadline } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { writeDerivation } from './derivation-store.js';
import { isHex64, isUuid } from './forget-store.js';
import { isSealedBlob } from './operation-commands.js';
import type { SealedBlobInput } from './operation-commands.js';
import { runImmediate } from './operation-store.js';

const DAY_MS = 86_400_000;
// 閉じてから識別子を消すまで（抄録 7 日 + 識別子 90 日。ADR 0073。0013 の CHECK と同じ値）。
export const CANDIDATE_KEY_RETENTION_MS = 97 * DAY_MS;
export const CANDIDATE_LIST_LIMIT = 1000;

const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;
const REVISION = /^(0|[1-9][0-9]{0,15})$/u;
const LOCAL_DATE_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$/u;
const LOCAL_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const KINDS: ReadonlySet<string> = new Set([
  'schedule_overlap',
  'mail_deadline',
  'mail_reply',
  'research_done',
]);
const UNRESOLVED_REASONS: ReadonlySet<string> = new Set([
  'missing_year',
  'missing_date',
  'relative',
  'conflict',
  'missing_zone',
]);
const ORIGIN_KINDS: ReadonlySet<string> = new Set(['turn', 'source_item']);

export class CandidateRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'CandidateRejection';
    this.reasons = reasons;
  }
}

export type CandidateKind =
  'schedule_overlap' | 'mail_deadline' | 'mail_reply' | 'research_done';

// 契約の Deadline の列（原文 original_text は題の封筒の中に入れる。ADR 0118）。
export type CandidateDeadlineInput =
  | {
      readonly kind: 'instant';
      readonly local_datetime: string;
      readonly zone: string;
    }
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'unresolved'; readonly reason: string }
  | { readonly kind: 'none' };

export interface CandidateRelatedAnalysisInput {
  readonly group_id: string;
  readonly analysis_revision: number;
  readonly source_set_hash: string;
  readonly published_generation: number;
}

export interface CandidateOriginInput {
  readonly source_kind: 'turn' | 'source_item';
  // turn は発言の ID、source_item は remote_id（期限の掃除・忘却の閉包と同じ呼び方）。
  readonly source_id: string;
}

export interface CandidateCreateInput {
  readonly candidate_id: string;
  readonly candidate_kind: CandidateKind;
  readonly notification_key: string;
  readonly request_entity_id: string | null;
  // 依頼エンティティの版（0 を除く整数の文字列）。request_entity_id があるときだけ。
  readonly request_revision: string | null;
  readonly source_revision: string | null;
  readonly deadline: CandidateDeadlineInput;
  readonly initial_import: boolean;
  readonly unread_partial: boolean;
  readonly related_analysis: CandidateRelatedAnalysisInput | null;
  // 受信（元情報の受信。予定の重複と調査では作った時刻）と、作った時刻。UTC の ISO 8601。
  readonly received_at: string;
  readonly created_at: string;
  // 暗号化済みの題（題と期限の原文を入れる）と抄録。Core が封をして渡す。
  readonly title: SealedBlobInput;
  readonly excerpt: SealedBlobInput | null;
  readonly origins: readonly CandidateOriginInput[];
}

export interface CandidateTransitionInput {
  readonly candidate_id: string;
  readonly event: CandidateEvent;
  // 呼び出し側が見ていた状態。今の状態と違えば書かない（古い画面からの操作で別の遷移を上書きしない）。
  readonly expected_state: CandidateState;
  // 時計から起こす遷移の再確認に使う本人のタイムゾーン（IANA）。
  readonly zone: string;
  // snooze のときだけ必要な再通知の時刻（UTC）。ほかの遷移では null。
  readonly snooze_until: string | null;
  readonly now: string;
}

export interface CandidateBlobOutput {
  readonly blob_id: string;
  readonly format_version: number;
  readonly key_id: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

// 候補の行（題・抄録は封筒のまま）。時刻は UTC の Unix ミリ秒。
export interface CandidateRow {
  readonly candidate_id: string;
  readonly candidate_kind: CandidateKind;
  readonly state: CandidateState;
  readonly notification_key: string;
  readonly request_entity_id: string | null;
  readonly request_revision: number | null;
  readonly source_revision: string | null;
  readonly deadline: CandidateDeadlineInput;
  readonly initial_import: boolean;
  readonly unread_partial: boolean;
  readonly related_analysis: CandidateRelatedAnalysisInput | null;
  readonly created_at: number;
  readonly received_at: number;
  readonly state_changed_at: number;
  readonly snooze_until: number | null;
  readonly closed_at: number | null;
  readonly key_delete_at: number | null;
  readonly content_deleted_at: number | null;
  readonly title: CandidateBlobOutput | null;
  readonly excerpt: CandidateBlobOutput | null;
}

export type CandidateOp =
  | { readonly kind: 'candidate.create'; readonly input: CandidateCreateInput }
  | {
      readonly kind: 'candidate.transition';
      readonly input: CandidateTransitionInput;
    }
  | {
      readonly kind: 'candidate.list';
      // 省略は全状態。
      readonly states?: readonly CandidateState[];
      readonly limit: number;
    }
  | { readonly kind: 'candidate.get'; readonly candidate_id: string }
  | { readonly kind: 'candidate.counts' }
  | {
      readonly kind: 'candidate.sweep';
      // 呼び出し側が判定済みの現在時刻（UTC）。時計の巻き戻りの保留は掃除の job が先に行う。
      readonly now: string;
    };

export type CandidateOpKind = CandidateOp['kind'];

export type CandidateCreateResult =
  | { readonly result: 'created'; readonly candidate_id: string }
  | {
      readonly result: 'duplicate';
      // すでにある候補。作り直さず、この候補を使う。
      readonly candidate_id: string;
      readonly state: CandidateState;
    };

export interface CandidateOpValues {
  'candidate.create': CandidateCreateResult;
  'candidate.transition': {
    readonly candidate_id: string;
    readonly from: CandidateState;
    readonly to: CandidateState;
    readonly state_changed_at: number;
  };
  'candidate.list': {
    readonly candidates: readonly CandidateRow[];
    // limit で切ったときに true。
    readonly truncated: boolean;
  };
  'candidate.get': { readonly candidate: CandidateRow | null };
  'candidate.counts': Readonly<Record<CandidateState, number>>;
  'candidate.sweep': {
    // 題・抄録を消した候補の ID。
    readonly content_deleted: readonly string[];
    // 識別子の行ごと消した候補の ID。
    readonly deleted: readonly string[];
  };
}

export type CandidateOpValue = CandidateOpValues[CandidateOpKind];

export type CandidateOpResult =
  | { readonly ok: true; readonly value: CandidateOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface CandidateStoreResult {
  readonly result: CandidateOpResult;
  readonly halt: boolean;
}

export const CANDIDATE_WRITE_OPS: ReadonlySet<CandidateOpKind> = new Set([
  'candidate.create',
  'candidate.transition',
  'candidate.sweep',
]);

const OP_KINDS: ReadonlySet<string> = new Set<CandidateOpKind>([
  'candidate.create',
  'candidate.transition',
  'candidate.list',
  'candidate.get',
  'candidate.counts',
  'candidate.sweep',
]);

// --- 形の検査 ---

function utcMillis(value: unknown): number | null {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  // 暦にない日時（2 月 30 日）は Date.parse が繰り上げる。繰り上げた値を行に入れない。
  return new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19)
    ? millis
    : null;
}

function deadlineReasons(deadline: unknown): string[] {
  if (deadline === null || typeof deadline !== 'object')
    return ['deadline_invalid'];
  const item = deadline as Record<string, unknown>;
  switch (item['kind']) {
    case 'instant':
      return typeof item['local_datetime'] === 'string' &&
        LOCAL_DATE_TIME.test(item['local_datetime']) &&
        typeof item['zone'] === 'string' &&
        isCandidateZone(item['zone'])
        ? []
        : ['deadline_invalid'];
    case 'date':
      return typeof item['date'] === 'string' && LOCAL_DATE.test(item['date'])
        ? []
        : ['deadline_invalid'];
    case 'unresolved':
      return typeof item['reason'] === 'string' &&
        UNRESOLVED_REASONS.has(item['reason'])
        ? []
        : ['deadline_invalid'];
    case 'none':
      return [];
    default:
      return ['deadline_invalid'];
  }
}

function createReasons(input: unknown): string[] {
  if (input === null || typeof input !== 'object') return ['input_invalid'];
  const item = input as Partial<CandidateCreateInput>;
  const reasons: string[] = [];
  if (!isUuid(item.candidate_id)) reasons.push('candidate_id_invalid');
  if (
    typeof item.candidate_kind !== 'string' ||
    !KINDS.has(item.candidate_kind)
  )
    reasons.push('candidate_kind_invalid');
  if (!isHex64(item.notification_key)) reasons.push('notification_key_invalid');
  if (item.request_entity_id !== null && !isUuid(item.request_entity_id))
    reasons.push('request_entity_id_invalid');
  if (
    (item.request_entity_id === null) !== (item.request_revision === null) ||
    (item.request_revision !== null &&
      (typeof item.request_revision !== 'string' ||
        !REVISION.test(item.request_revision) ||
        item.request_revision === '0'))
  )
    reasons.push('request_revision_invalid');
  if (
    item.source_revision !== null &&
    (typeof item.source_revision !== 'string' ||
      item.source_revision === '' ||
      item.source_revision.length > 256)
  )
    reasons.push('source_revision_invalid');
  reasons.push(...deadlineReasons(item.deadline));
  if (typeof item.initial_import !== 'boolean')
    reasons.push('initial_import_invalid');
  if (typeof item.unread_partial !== 'boolean')
    reasons.push('unread_partial_invalid');
  const related = item.related_analysis;
  if (
    related !== null &&
    (related === undefined ||
      typeof related !== 'object' ||
      !isUuid(related.group_id) ||
      !Number.isSafeInteger(related.analysis_revision) ||
      related.analysis_revision < 1 ||
      !isHex64(related.source_set_hash) ||
      !Number.isSafeInteger(related.published_generation) ||
      related.published_generation < 0)
  )
    reasons.push('related_analysis_invalid');
  const received = utcMillis(item.received_at);
  const created = utcMillis(item.created_at);
  if (received === null) reasons.push('received_at_invalid');
  if (created === null) reasons.push('created_at_invalid');
  if (!isSealedBlob(item.title)) reasons.push('title_invalid');
  if (item.excerpt !== null && !isSealedBlob(item.excerpt))
    reasons.push('excerpt_invalid');
  if (
    Array.isArray(item.origins) &&
    item.origins.length >= 1 &&
    item.origins.length <= 64 &&
    item.origins.every(
      (origin) =>
        origin !== null &&
        typeof origin === 'object' &&
        ORIGIN_KINDS.has(origin.source_kind) &&
        typeof origin.source_id === 'string' &&
        origin.source_id !== '' &&
        origin.source_id.length <= 512,
    )
  ) {
    const keys = item.origins.map(
      (origin) => `${origin.source_kind}\u0000${origin.source_id}`,
    );
    if (new Set(keys).size !== keys.length) reasons.push('origins_invalid');
  } else reasons.push('origins_invalid');
  return reasons;
}

function transitionReasons(input: unknown): string[] {
  if (input === null || typeof input !== 'object') return ['input_invalid'];
  const item = input as Partial<CandidateTransitionInput>;
  const reasons: string[] = [];
  if (!isUuid(item.candidate_id)) reasons.push('candidate_id_invalid');
  if (
    typeof item.event !== 'string' ||
    !(CANDIDATE_EVENTS as readonly string[]).includes(item.event)
  )
    reasons.push('event_invalid');
  if (
    typeof item.expected_state !== 'string' ||
    !(CANDIDATE_STATES as readonly string[]).includes(item.expected_state)
  )
    reasons.push('expected_state_invalid');
  if (typeof item.zone !== 'string' || !isCandidateZone(item.zone))
    reasons.push('zone_invalid');
  if (utcMillis(item.now) === null) reasons.push('now_invalid');
  // snooze だけが再通知の時刻を持つ。ほかの遷移に付けた時刻は黙って捨てず拒否する。
  if (item.event === 'snooze') {
    if (item.snooze_until === null || utcMillis(item.snooze_until) === null)
      reasons.push('snooze_until_invalid');
  } else if (item.snooze_until !== null)
    reasons.push('snooze_until_unexpected');
  return reasons;
}

// 命令の形の検査。理由が空なら形は正しい。
export function candidateOpShapeReasons(op: CandidateOp): string[] {
  if (op === null || typeof op !== 'object' || !OP_KINDS.has(op.kind))
    return ['kind_invalid'];
  switch (op.kind) {
    case 'candidate.create':
      return createReasons(op.input);
    case 'candidate.transition':
      return transitionReasons(op.input);
    case 'candidate.list': {
      const reasons: string[] = [];
      if (
        !Number.isSafeInteger(op.limit) ||
        op.limit < 1 ||
        op.limit > CANDIDATE_LIST_LIMIT
      )
        reasons.push('limit_invalid');
      if (
        op.states !== undefined &&
        (!Array.isArray(op.states) ||
          op.states.length === 0 ||
          !op.states.every((state) =>
            (CANDIDATE_STATES as readonly string[]).includes(state),
          ))
      )
        reasons.push('states_invalid');
      return reasons;
    }
    case 'candidate.get':
      return isUuid(op.candidate_id) ? [] : ['candidate_id_invalid'];
    case 'candidate.counts':
      return [];
    case 'candidate.sweep':
      return utcMillis(op.now) === null ? ['now_invalid'] : [];
  }
}

// --- 読み取り ---

interface SqlRow {
  candidate_id: string;
  kind: CandidateKind;
  state: CandidateState;
  notification_key: string;
  request_entity_id: string | null;
  request_revision: number | null;
  source_revision: string | null;
  deadline_kind: 'instant' | 'date' | 'unresolved' | 'none';
  deadline_local: string | null;
  deadline_zone: string | null;
  deadline_reason: string | null;
  initial_import: number;
  unread_partial: number;
  related_group_id: string | null;
  related_analysis_revision: number | null;
  related_source_set_hash: string | null;
  related_published_generation: number | null;
  created_at: number;
  received_at: number;
  state_changed_at: number;
  snooze_until: number | null;
  closed_at: number | null;
  key_delete_at: number | null;
  content_deleted_at: number | null;
  title_blob_id: string | null;
  excerpt_blob_id: string | null;
}

const COLUMNS = `candidate_id, kind, state, notification_key, request_entity_id, request_revision, source_revision,
  deadline_kind, deadline_local, deadline_zone, deadline_reason, initial_import, unread_partial,
  related_group_id, related_analysis_revision, related_source_set_hash, related_published_generation,
  created_at, received_at, state_changed_at, snooze_until, closed_at, key_delete_at, content_deleted_at,
  title_blob_id, excerpt_blob_id`;

interface BlobSqlRow {
  blob_id: string;
  format_version: number;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function readBlob(
  db: SqliteDatabase,
  blobId: string | null,
): CandidateBlobOutput | null {
  if (blobId === null) return null;
  const row = db
    .prepare(
      'SELECT blob_id, format_version, key_id, nonce, ciphertext, tag FROM sealed_blobs WHERE blob_id = ?',
    )
    .get(blobId) as BlobSqlRow | undefined;
  if (row === undefined) return null;
  return {
    blob_id: row.blob_id,
    format_version: row.format_version,
    key_id: row.key_id,
    nonce: new Uint8Array(row.nonce),
    ciphertext: new Uint8Array(row.ciphertext),
    tag: new Uint8Array(row.tag),
  };
}

function deadlineOf(row: SqlRow): CandidateDeadlineInput {
  switch (row.deadline_kind) {
    case 'instant':
      return {
        kind: 'instant',
        local_datetime: row.deadline_local ?? '',
        zone: row.deadline_zone ?? '',
      };
    case 'date':
      return { kind: 'date', date: row.deadline_local ?? '' };
    case 'unresolved':
      return { kind: 'unresolved', reason: row.deadline_reason ?? '' };
    case 'none':
      return { kind: 'none' };
  }
}

// domain の Deadline（原文は封筒の中なので空にする。期限の判定は原文を使わない）。
function domainDeadline(row: SqlRow): Deadline {
  switch (row.deadline_kind) {
    case 'instant':
      return {
        kind: 'instant',
        local_datetime: row.deadline_local ?? '',
        zone: row.deadline_zone ?? '',
        original_text: '',
      };
    case 'date':
      return {
        kind: 'date',
        date: row.deadline_local ?? '',
        original_text: '',
      };
    case 'unresolved':
      return {
        kind: 'unresolved',
        reason: (row.deadline_reason ?? 'conflict') as Extract<
          Deadline,
          { kind: 'unresolved' }
        >['reason'],
        original_text: '',
      };
    case 'none':
      return { kind: 'none' };
  }
}

function toRow(
  db: SqliteDatabase,
  row: SqlRow,
  withExcerpt: boolean,
): CandidateRow {
  return {
    candidate_id: row.candidate_id,
    candidate_kind: row.kind,
    state: row.state,
    notification_key: row.notification_key,
    request_entity_id: row.request_entity_id,
    request_revision: row.request_revision,
    source_revision: row.source_revision,
    deadline: deadlineOf(row),
    initial_import: row.initial_import === 1,
    unread_partial: row.unread_partial === 1,
    related_analysis:
      row.related_group_id === null
        ? null
        : {
            group_id: row.related_group_id,
            analysis_revision: row.related_analysis_revision ?? 0,
            source_set_hash: row.related_source_set_hash ?? '',
            published_generation: row.related_published_generation ?? 0,
          },
    created_at: row.created_at,
    received_at: row.received_at,
    state_changed_at: row.state_changed_at,
    snooze_until: row.snooze_until,
    closed_at: row.closed_at,
    key_delete_at: row.key_delete_at,
    content_deleted_at: row.content_deleted_at,
    title: readBlob(db, row.title_blob_id),
    excerpt: withExcerpt ? readBlob(db, row.excerpt_blob_id) : null,
  };
}

function listCandidates(
  db: SqliteDatabase,
  op: Extract<CandidateOp, { kind: 'candidate.list' }>,
): CandidateOpValues['candidate.list'] {
  const states = op.states ?? CANDIDATE_STATES;
  const placeholders = states.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM notification_candidates WHERE state IN (${placeholders})
        ORDER BY received_at DESC, candidate_id LIMIT ?`,
    )
    .all(...states, op.limit + 1) as SqlRow[];
  const truncated = rows.length > op.limit;
  return {
    candidates: rows.slice(0, op.limit).map((row) => toRow(db, row, false)),
    truncated,
  };
}

function getCandidate(
  db: SqliteDatabase,
  candidateId: string,
): CandidateOpValues['candidate.get'] {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM notification_candidates WHERE candidate_id = ?`,
    )
    .get(candidateId) as SqlRow | undefined;
  return { candidate: row === undefined ? null : toRow(db, row, true) };
}

export function countCandidates(
  db: SqliteDatabase,
): Record<CandidateState, number> {
  const counts = Object.fromEntries(
    CANDIDATE_STATES.map((state) => [state, 0]),
  ) as Record<CandidateState, number>;
  const rows = db
    .prepare(
      'SELECT state, count(*) AS value FROM notification_candidates GROUP BY state',
    )
    .all() as { state: CandidateState; value: number }[];
  for (const row of rows) counts[row.state] = row.value;
  return counts;
}

// --- 書込み ---

function originExists(
  db: SqliteDatabase,
  origin: CandidateOriginInput,
): boolean {
  const sql =
    origin.source_kind === 'turn'
      ? 'SELECT 1 FROM turns WHERE turn_id = ?'
      : 'SELECT 1 FROM source_items WHERE remote_id = ? LIMIT 1';
  return db.prepare(sql).get(origin.source_id) !== undefined;
}

function insertBlob(
  db: SqliteDatabase,
  purpose: 'candidate_title' | 'candidate_excerpt',
  candidateId: string,
  blob: SealedBlobInput,
  now: number,
): void {
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, ?, 'notification_candidates', ?, 0, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    blob.blob_id,
    purpose,
    candidateId,
    blob.format_version,
    blob.key_id,
    Buffer.from(blob.nonce),
    Buffer.from(blob.ciphertext),
    Buffer.from(blob.tag),
    now,
  );
}

function createCandidate(
  db: SqliteDatabase,
  input: CandidateCreateInput,
): CandidateCreateResult {
  // 0. 由来がまだあること。忘却・期限切れで消えた発言・元情報から候補を作らない。
  for (const origin of input.origins)
    if (!originExists(db, origin))
      throw new CandidateRejection(['origin_not_found']);
  // 1. 同じ識別子の候補があれば作らない（状態が何でも。却下・解決の後も、識別子が残る間は作らない）。
  const existing = db
    .prepare(
      'SELECT candidate_id, state FROM notification_candidates WHERE notification_key = ?',
    )
    .get(input.notification_key) as
    { candidate_id: string; state: CandidateState } | undefined;
  if (existing !== undefined)
    return {
      result: 'duplicate',
      candidate_id: existing.candidate_id,
      state: existing.state,
    };
  const sameId = db
    .prepare('SELECT 1 FROM notification_candidates WHERE candidate_id = ?')
    .get(input.candidate_id);
  if (sameId !== undefined)
    throw new CandidateRejection(['candidate_id_exists']);
  // 2. 題・抄録・行・由来の辺。
  const created = utcMillis(input.created_at) as number;
  const received = utcMillis(input.received_at) as number;
  insertBlob(db, 'candidate_title', input.candidate_id, input.title, created);
  if (input.excerpt !== null)
    insertBlob(
      db,
      'candidate_excerpt',
      input.candidate_id,
      input.excerpt,
      created,
    );
  const deadline = input.deadline;
  db.prepare(
    `INSERT INTO notification_candidates (
       candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key,
       title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at,
       created_at, received_at, state_changed_at,
       deadline_kind, deadline_local, deadline_zone, deadline_reason,
       initial_import, unread_partial, snooze_until,
       related_group_id, related_analysis_revision, related_source_set_hash, related_published_generation,
       content_deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
  ).run(
    input.candidate_id,
    input.request_entity_id,
    input.request_revision === null ? null : Number(input.request_revision),
    input.source_revision,
    input.candidate_kind,
    input.notification_key,
    input.title.blob_id,
    input.excerpt === null ? null : input.excerpt.blob_id,
    created,
    received,
    created,
    deadline.kind,
    deadline.kind === 'instant'
      ? deadline.local_datetime
      : deadline.kind === 'date'
        ? deadline.date
        : null,
    deadline.kind === 'instant' ? deadline.zone : null,
    deadline.kind === 'unresolved' ? deadline.reason : null,
    input.initial_import ? 1 : 0,
    input.unread_partial ? 1 : 0,
    input.related_analysis?.group_id ?? null,
    input.related_analysis?.analysis_revision ?? null,
    input.related_analysis?.source_set_hash ?? null,
    input.related_analysis?.published_generation ?? null,
  );
  for (const origin of input.origins)
    writeDerivation(db, {
      artifact_kind: 'notification_candidate',
      artifact_id: input.candidate_id,
      source_kind: origin.source_kind,
      source_id: origin.source_id,
      created_at: created,
    });
  return { result: 'created', candidate_id: input.candidate_id };
}

const CLOSING: ReadonlySet<CandidateState> = new Set(['dismissed', 'resolved']);

function transitionCandidate(
  db: SqliteDatabase,
  input: CandidateTransitionInput,
): CandidateOpValues['candidate.transition'] {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM notification_candidates WHERE candidate_id = ?`,
    )
    .get(input.candidate_id) as SqlRow | undefined;
  if (row === undefined) throw new CandidateRejection(['candidate_not_found']);
  if (row.state !== input.expected_state)
    throw new CandidateRejection(['state_mismatch']);
  const now = utcMillis(input.now) as number;
  if (now < row.state_changed_at)
    throw new CandidateRejection(['time_backwards']);
  const next = candidateTransition(row.state, input.event);
  if (next === null) throw new CandidateRejection(['transition_not_allowed']);

  // 時計から起こす遷移は、行を読み直して同じ判断になるときだけ書く。
  if (input.event === 'deadline_passed' || input.event === 'snooze_elapsed') {
    const due = candidateDueEvent(
      {
        state: row.state,
        deadline: domainDeadline(row),
        initial_import: row.initial_import === 1,
        created_at: new Date(row.created_at).toISOString(),
        snooze_until:
          row.snooze_until === null
            ? null
            : new Date(row.snooze_until).toISOString(),
      },
      input.now,
      input.zone,
    );
    if (!due.ok || due.event !== input.event)
      throw new CandidateRejection(['event_not_due']);
  }

  let snooze: number | null = null;
  if (input.event === 'snooze') {
    const check = checkSnoozeUntil(input.now, input.snooze_until as string);
    if (!check.ok) throw new CandidateRejection([`snooze_${check.reason}`]);
    snooze = utcMillis(input.snooze_until) as number;
  }
  const closed = CLOSING.has(next);
  const result = db
    .prepare(
      `UPDATE notification_candidates
          SET state = ?, state_changed_at = ?, snooze_until = ?, closed_at = ?, key_delete_at = ?
        WHERE candidate_id = ? AND state = ?`,
    )
    .run(
      next,
      now,
      snooze,
      closed ? now : null,
      closed ? now + CANDIDATE_KEY_RETENTION_MS : null,
      input.candidate_id,
      input.expected_state,
    );
  if (result.changes !== 1) throw new CandidateRejection(['state_mismatch']);
  return {
    candidate_id: input.candidate_id,
    from: row.state,
    to: next,
    state_changed_at: now,
  };
}

// --- 保持の掃除 ---

function deleteBlobs(
  db: SqliteDatabase,
  blobIds: readonly (string | null)[],
): void {
  for (const id of blobIds)
    if (id !== null)
      db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(id);
}

// 閉じた候補の保持（設計 11 §4・03）。段階は domain の candidateRetentionPhase。
// - identifier_only（閉じてから 7 日以上 97 日未満）: 題・抄録の封筒を消し、識別子と状態だけ残す。
// - delete（97 日以上）: 由来の辺・封筒・行を消す。同じ識別子はここで初めて作り直せる。
// 活動中の候補（closed_at が無い行）は読まない。
function sweepCandidates(
  db: SqliteDatabase,
  nowIso: string,
  nowMs: number,
): CandidateOpValues['candidate.sweep'] {
  const rows = db
    .prepare(
      `SELECT candidate_id, state, closed_at, title_blob_id, excerpt_blob_id
         FROM notification_candidates WHERE closed_at IS NOT NULL ORDER BY candidate_id`,
    )
    .all() as {
    candidate_id: string;
    state: CandidateState;
    closed_at: number;
    title_blob_id: string | null;
    excerpt_blob_id: string | null;
  }[];
  const contentDeleted: string[] = [];
  const deleted: string[] = [];
  for (const row of rows) {
    const phase = candidateRetentionPhase(
      row.state,
      new Date(row.closed_at).toISOString(),
      nowIso,
    );
    if (phase === 'delete') {
      db.prepare(
        'DELETE FROM notification_candidates WHERE candidate_id = ?',
      ).run(row.candidate_id);
      deleteBlobs(db, [row.title_blob_id, row.excerpt_blob_id]);
      db.prepare(
        "DELETE FROM derivations WHERE artifact_kind = 'notification_candidate' AND artifact_id = ?",
      ).run(row.candidate_id);
      deleted.push(row.candidate_id);
    } else if (
      phase === 'identifier_only' &&
      (row.title_blob_id !== null || row.excerpt_blob_id !== null)
    ) {
      db.prepare(
        'UPDATE notification_candidates SET title_blob_id = NULL, excerpt_blob_id = NULL, content_deleted_at = ? WHERE candidate_id = ?',
      ).run(nowMs, row.candidate_id);
      deleteBlobs(db, [row.title_blob_id, row.excerpt_blob_id]);
      contentDeleted.push(row.candidate_id);
    }
  }
  return { content_deleted: contentDeleted, deleted };
}

const rejected = (reasons: readonly string[]): CandidateOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

function failure(error: unknown): CandidateStoreResult {
  if (error instanceof CandidateRejection)
    return { result: rejected(error.reasons), halt: false };
  if (error instanceof Error && error.name === 'CommitUncertain')
    return {
      result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
      halt: true,
    };
  const code = error instanceof Database.SqliteError ? error.code : null;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return { result: rejected(['database_busy']), halt: false };
  if (code?.startsWith('SQLITE_CONSTRAINT'))
    return {
      result: rejected([
        error instanceof Error && /^[a-z_]{1,64}$/u.test(error.message)
          ? error.message
          : 'constraint_violation',
      ]),
      halt: false,
    };
  return {
    result: rejected([
      code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
    ]),
    halt: true,
  };
}

export interface CandidateContext {
  readonly platform: StoragePlatform;
  readonly halted: boolean;
  // 故障注入の試験用。transaction の本体の後・COMMIT の前に呼ぶ。
  readonly beforeCommit?: (op: CandidateOp) => void;
}

// 候補の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeCandidateOp(
  db: SqliteDatabase,
  op: CandidateOp,
  context: CandidateContext,
): CandidateStoreResult {
  const shape = candidateOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  switch (op.kind) {
    case 'candidate.list':
      return {
        result: { ok: true, value: listCandidates(db, op) },
        halt: false,
      };
    case 'candidate.get':
      return {
        result: { ok: true, value: getCandidate(db, op.candidate_id) },
        halt: false,
      };
    case 'candidate.counts':
      return {
        result: { ok: true, value: countCandidates(db) },
        halt: false,
      };
    default:
      break;
  }
  // 書込みを止めた worker は書かない（ADR 0018）。照会は続ける。
  if (context.halted)
    return { result: rejected(['worker_halted']), halt: false };
  const durability = writeConnectionReasons(db, context.platform);
  if (durability.length > 0)
    return {
      result: rejected(['durability_mismatch', ...durability]),
      halt: true,
    };
  const beforeCommit =
    context.beforeCommit === undefined
      ? undefined
      : () => context.beforeCommit?.(op);
  try {
    const run = runImmediate(
      db,
      (): CandidateOpValue => {
        if (op.kind === 'candidate.create')
          return createCandidate(db, op.input);
        if (op.kind === 'candidate.sweep')
          return sweepCandidates(db, op.now, utcMillis(op.now) as number);
        return transitionCandidate(
          db,
          (op as Extract<CandidateOp, { kind: 'candidate.transition' }>).input,
        );
      },
      beforeCommit,
    );
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    return failure(error);
  }
}
