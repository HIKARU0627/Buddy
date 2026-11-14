// 連携の接続の取得対象の読み取りと、本人の選択の変更（設計 04 取得する対象、設計 11 §1A、B08-02、ADR 0086・0087・0088）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、
// 端末の命令（device-store.ts）と同じく、transaction の前に接続の耐久設定を読み戻す。
// - 取得対象の検査（期間・サイズの上限、種類、ID）は domain の validateFetchScope が正本。ここは DB に書く前に確かめるだけで、
//   範囲を広げる既定値を作らない。保存済みの値が不完全・不正（4 項目が無い古い行など）なときは「何も選ばれていない」として
//   読み、取得させない（選択外は取得しない）。期間とサイズは設計の初期値（上限）を表示用に返すだけで、選択を足さない。
// - 変更は許可版（permission_revision）の一致を条件にする（compare-and-swap）。選択に変更があれば許可版と取得範囲の版を
//   1 つずつ上げ、同じ接続の取得集合（sync_scopes）の scope_revision を新しい版へ揃え、有効な走査を abandoned にする
//   （11 §1A、domain の abandonScan と同じく、走査の種類に応じて pending_* を立てる）。変更がなければ何も書かない。
// - 接続の作成・切断・OAuth のトークンはここでは扱わない（B03-04）。切断済みの接続の取得対象は変えない。
// 結果の理由にはコードだけを入れ、SQL・パス・取得対象の値を入れない。

import Database from 'better-sqlite3';
import {
  initialFetchScope,
  normalizeFetchScope,
  sameFetchScope,
  validateFetchScope,
} from '@buddy/domain';
import type { FetchScope } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';

const REVISION = /^(0|[1-9][0-9]*)$/u;
const CONNECTION_ID = /^[\x21-\x7e]{1,128}$/u;

// 契約の ConnectionTargets（ワイヤの形）。
export interface ConnectionTargetsWire {
  readonly calendar_ids: readonly string[];
  readonly mail_container_ids: readonly string[];
  readonly attachment_kinds: readonly ('pdf' | 'text')[];
  readonly mail_lookback_days: number;
  readonly calendar_past_days: number;
  readonly calendar_future_days: number;
  readonly attachment_max_bytes: number;
}

export type ConnectionProviderName = 'google' | 'microsoft';
export type ConnectionStatusName =
  'active' | 'needs_reauth' | 'needs_attention' | 'disconnected';

export interface ConnectionRecord {
  readonly connection_id: string;
  readonly provider: ConnectionProviderName;
  readonly status: ConnectionStatusName;
  readonly access: 'read' | 'read_write';
  readonly granted_scopes: readonly string[];
  // 保存済みの値が完全で正しければその値。そうでなければ何も選ばれていない状態（取得しない）。
  readonly targets: ConnectionTargetsWire;
  // complete: 保存済みの値が完全で正しい。incomplete: 4 項目が無い・不正で、空の選択として読んだ。
  readonly targets_state: 'complete' | 'incomplete';
  // 契約の PermissionRevision・ScopeRevision（10 進の文字列）。
  readonly permission_revision: string;
  readonly scope_revision: string;
}

export type ConnectionTargetsOp =
  | { readonly kind: 'connections.list' }
  | { readonly kind: 'connections.get'; readonly connection_id: string }
  | {
      readonly kind: 'connections.update_targets';
      readonly connection_id: string;
      readonly expected_permission_revision: string;
      readonly targets: ConnectionTargetsWire;
    };

export type ConnectionTargetsOpKind = ConnectionTargetsOp['kind'];

export interface ConnectionTargetsUpdated {
  readonly connection: ConnectionRecord;
  // false: 選択が同じで何も書いていない（版も上げない）。
  readonly changed: boolean;
  // 範囲の変更で abandoned にした有効な走査の数。
  readonly abandoned_scans: number;
}

export type ConnectionTargetsOpValue =
  | readonly ConnectionRecord[]
  | ConnectionRecord
  | ConnectionTargetsUpdated
  | null;

export type ConnectionTargetsOpResult =
  | { readonly ok: true; readonly value: ConnectionTargetsOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface ConnectionTargetsStoreResult {
  readonly result: ConnectionTargetsOpResult;
  // 以後の書込みを止めるべき失敗（成否不明・想定外の失敗・耐久設定の不一致）。
  readonly halt: boolean;
}

export const CONNECTION_TARGETS_WRITE_OPS: ReadonlySet<ConnectionTargetsOpKind> =
  new Set(['connections.update_targets']);

class ConnectionTargetsRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'ConnectionTargetsRejection';
    this.reasons = reasons;
  }
}

const TARGET_KEYS = [
  'calendar_ids',
  'mail_container_ids',
  'attachment_kinds',
  'mail_lookback_days',
  'calendar_past_days',
  'calendar_future_days',
  'attachment_max_bytes',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toScope(targets: ConnectionTargetsWire): FetchScope {
  return {
    calendarIds: targets.calendar_ids,
    mailContainerIds: targets.mail_container_ids,
    attachmentKinds: targets.attachment_kinds,
    mailLookbackDays: targets.mail_lookback_days,
    calendarPastDays: targets.calendar_past_days,
    calendarFutureDays: targets.calendar_future_days,
    attachmentMaxBytes: targets.attachment_max_bytes,
  };
}

function toWire(scope: FetchScope): ConnectionTargetsWire {
  return {
    calendar_ids: scope.calendarIds,
    mail_container_ids: scope.mailContainerIds,
    attachment_kinds: scope.attachmentKinds,
    mail_lookback_days: scope.mailLookbackDays,
    calendar_past_days: scope.calendarPastDays,
    calendar_future_days: scope.calendarFutureDays,
    attachment_max_bytes: scope.attachmentMaxBytes,
  };
}

// 値の形と意味の検査。structured clone を通った値を信用せず、DB に書く前に確かめる。理由はコードだけ。
function targetsReasons(value: unknown): string[] {
  if (!isRecord(value)) return ['targets_invalid'];
  const reasons: string[] = [];
  const keys = Object.keys(value);
  if (
    keys.length !== TARGET_KEYS.length ||
    !TARGET_KEYS.every((key) => Object.hasOwn(value, key))
  )
    return ['targets_invalid', 'targets_keys_invalid'];
  if (
    !Array.isArray(value['calendar_ids']) ||
    !Array.isArray(value['mail_container_ids']) ||
    !Array.isArray(value['attachment_kinds'])
  )
    return ['targets_invalid', 'targets_lists_invalid'];
  const issues = validateFetchScope(toScope(value as never));
  if (issues.length > 0) reasons.push('targets_invalid', ...issues);
  return reasons;
}

export function connectionTargetsOpShapeReasons(
  op: ConnectionTargetsOp,
): string[] {
  const reasons: string[] = [];
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !CONNECTION_ID.test(value))
      reasons.push('connection_id_invalid');
  };
  switch (op.kind) {
    case 'connections.list':
      break;
    case 'connections.get':
      id(op.connection_id);
      break;
    case 'connections.update_targets':
      id(op.connection_id);
      if (
        typeof op.expected_permission_revision !== 'string' ||
        !REVISION.test(op.expected_permission_revision) ||
        !Number.isSafeInteger(Number(op.expected_permission_revision))
      )
        reasons.push('expected_permission_revision_invalid');
      reasons.push(...targetsReasons(op.targets));
      break;
    default:
      reasons.push('kind_invalid');
  }
  return reasons;
}

interface ConnectionRow {
  connection_id: string;
  provider: ConnectionProviderName;
  status: ConnectionStatusName;
  access: 'read' | 'read_write';
  granted_scopes: string;
  targets: string;
  permission_revision: number;
  scope_revision: number;
}

const COLUMNS =
  'connection_id, provider, status, access, granted_scopes, targets, permission_revision, scope_revision';

// 何も選ばれていない状態。取得は選択だけを対象にするので、これでは何も取得しない。
// 期間とサイズは設計の初期値（上限）で、選択を足すものではない。
function emptyTargets(): ConnectionTargetsWire {
  return toWire({ ...initialFetchScope(null), attachmentKinds: [] });
}

function parseStored(text: string): ConnectionTargetsWire | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (targetsReasons(parsed).length > 0) return null;
  return toWire(normalizeFetchScope(toScope(parsed as ConnectionTargetsWire)));
}

function parseScopes(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toRecord(row: ConnectionRow): ConnectionRecord {
  const stored = parseStored(row.targets);
  return {
    connection_id: row.connection_id,
    provider: row.provider,
    status: row.status,
    access: row.access,
    granted_scopes: parseScopes(row.granted_scopes),
    targets: stored ?? emptyTargets(),
    targets_state: stored === null ? 'incomplete' : 'complete',
    permission_revision: String(row.permission_revision),
    scope_revision: String(row.scope_revision),
  };
}

function readConnection(
  db: SqliteDatabase,
  connectionId: string,
): ConnectionRecord | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM connections WHERE connection_id = ?`)
    .get(connectionId) as ConnectionRow | undefined;
  return row === undefined ? null : toRecord(row);
}

function readAll(db: SqliteDatabase): ConnectionRecord[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM connections ORDER BY connection_id`)
    .all() as ConnectionRow[];
  return rows.map(toRecord);
}

interface ActiveBatchRow {
  scan_id: string;
  scope_id: string;
  kind: 'incremental' | 'full';
}

function applyUpdate(
  db: SqliteDatabase,
  op: Extract<ConnectionTargetsOp, { kind: 'connections.update_targets' }>,
): ConnectionTargetsUpdated {
  const current = readConnection(db, op.connection_id);
  if (current === null)
    throw new ConnectionTargetsRejection(['connection_not_found']);
  if (current.status === 'disconnected')
    throw new ConnectionTargetsRejection(['connection_disconnected']);
  if (current.permission_revision !== op.expected_permission_revision)
    throw new ConnectionTargetsRejection(['permission_revision_mismatch']);
  const next = normalizeFetchScope(toScope(op.targets));
  // 保存済みの値が不完全なら、同じ内容でも書き直す（空の選択として読んだだけで、保存されていない）。
  if (
    current.targets_state === 'complete' &&
    sameFetchScope(toScope(current.targets), next)
  )
    return { connection: current, changed: false, abandoned_scans: 0 };
  const permission = Number(current.permission_revision) + 1;
  const scopeRevision = Number(current.scope_revision) + 1;
  if (!Number.isSafeInteger(permission) || !Number.isSafeInteger(scopeRevision))
    throw new ConnectionTargetsRejection(['revision_overflow']);
  const updated = db
    .prepare(
      `UPDATE connections SET targets = ?, permission_revision = ?, scope_revision = ?
       WHERE connection_id = ? AND permission_revision = ?`,
    )
    .run(
      JSON.stringify(toWire(next)),
      permission,
      scopeRevision,
      op.connection_id,
      Number(op.expected_permission_revision),
    ).changes;
  if (updated !== 1)
    throw new ConnectionTargetsRejection(['permission_revision_mismatch']);
  // 範囲の変更は旧走査を abandoned にして、新しい走査で最初から取り直す（11 §1A、domain の abandonScan）。
  const active = db
    .prepare(
      `SELECT b.scan_id, b.scope_id, b.kind FROM sync_batches b
       JOIN sync_scopes s ON s.scope_id = b.scope_id
       WHERE s.connection_id = ? AND b.status IN ('fetching', 'staged', 'validated')`,
    )
    .all(op.connection_id) as ActiveBatchRow[];
  for (const batch of active) {
    db.prepare(
      "UPDATE sync_batches SET status = 'abandoned' WHERE scan_id = ?",
    ).run(batch.scan_id);
    db.prepare(
      `UPDATE sync_scopes SET active_scan_id = NULL,
         pending_full = CASE WHEN ? = 'full' THEN 1 ELSE pending_full END,
         pending_incremental = CASE WHEN ? = 'incremental' THEN 1 ELSE pending_incremental END
       WHERE scope_id = ? AND active_scan_id = ?`,
    ).run(batch.kind, batch.kind, batch.scope_id, batch.scan_id);
  }
  db.prepare(
    'UPDATE sync_scopes SET scope_revision = ? WHERE connection_id = ?',
  ).run(scopeRevision, op.connection_id);
  const connection = readConnection(db, op.connection_id);
  if (connection === null)
    throw new ConnectionTargetsRejection(['connection_not_found']);
  return { connection, changed: true, abandoned_scans: active.length };
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): ConnectionTargetsOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

// 取得対象の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeConnectionTargetsOp(
  db: SqliteDatabase,
  op: ConnectionTargetsOp,
  context: { readonly platform: StoragePlatform; readonly halted: boolean },
): ConnectionTargetsStoreResult {
  const shape = connectionTargetsOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'connections.list')
    return { result: { ok: true, value: readAll(db) }, halt: false };
  if (op.kind === 'connections.get')
    return {
      result: { ok: true, value: readConnection(db, op.connection_id) },
      halt: false,
    };
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
    const run = runImmediate(db, () => applyUpdate(db, op));
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof ConnectionTargetsRejection)
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
