// 連携の接続の取得対象の読み取りと、本人の選択の変更（設計 04 取得する対象、設計 11 §1A、B08-02、ADR 0086・0087・0088）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、
// 端末の命令（device-store.ts）と同じく、transaction の前に接続の耐久設定を読み戻す。
// - 取得対象の検査（期間・サイズの上限、種類、ID）は domain の validateFetchScope が正本。ここは DB に書く前に確かめるだけで、
//   範囲を広げる既定値を作らない。保存済みの値が不完全・不正（4 項目が無い古い行など）なときは「何も選ばれていない」として
//   読み、取得させない（選択外は取得しない）。期間とサイズは設計の初期値（上限）を表示用に返すだけで、選択を足さない。
// - 変更は許可版（permission_revision）の一致を条件にする（compare-and-swap）。選択に変更があれば許可版と取得範囲の版を
//   1 つずつ上げ、同じ接続の取得集合（sync_scopes）の scope_revision を新しい版へ揃え、有効な走査を abandoned にする
//   （11 §1A、domain の abandonScan と同じく、走査の種類に応じて pending_* を立てる）。変更があれば、その接続の
//   全取得集合に pending_full を立てる（U207 の決定 (b)、B08-05、ADR 0136）。変更がなければ何も書かない。
// - 接続の作成・切断・再認可の記録もここで扱う（B03-04、ADR 0144）。作成は、アカウント識別の封筒
//   （sealed_blobs、用途 connection_account。Core が封をして渡す）・接続の行・取得集合（sync_scopes）の
//   初期行を 1 つの transaction で入れる。切断は許可版の一致を条件に状態を disconnected にし、
//   credential_ref を NULL にする（0001 の CHECK）。OAuth のトークン本体はここでは扱わない
//   （OS の KeyStore、ADR 0010）。切断済みの接続の取得対象は変えない。
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
import type { SealedBlobInput } from './operation-commands.js';
import { runImmediate } from './operation-store.js';
import { SEALED_BLOB_FORMAT_VERSION } from './sealed-blob.js';

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

export interface ConnectionScopeSeed {
  readonly scope_id: string;
  readonly resource: 'mail' | 'calendar';
}

export type ConnectionTargetsOp =
  | { readonly kind: 'connections.list' }
  | { readonly kind: 'connections.get'; readonly connection_id: string }
  | {
      readonly kind: 'connections.update_targets';
      readonly connection_id: string;
      readonly expected_permission_revision: string;
      readonly targets: ConnectionTargetsWire;
    }
  // 接続の作成（B03-04、ADR 0144）。アカウント識別は Core が封をした封筒で渡す。
  | {
      readonly kind: 'connections.create';
      readonly connection_id: string;
      readonly provider: ConnectionProviderName;
      // 封筒の行の created_at（ミリ秒。Core の時計が正本）。
      readonly created_at: number;
      readonly account: SealedBlobInput;
      readonly credential_ref: string;
      readonly access: 'read' | 'read_write';
      readonly granted_scopes: readonly string[];
      readonly targets: ConnectionTargetsWire;
      readonly scopes: readonly ConnectionScopeSeed[];
    }
  // アカウント識別の封筒の読み取り（重複接続の判定と targetsFor の account_id 復元。B03-04）。
  | {
      readonly kind: 'connections.account_blob';
      readonly connection_id: string;
    }
  // 接続の解除（B03-04）。許可版の一致を条件にする。トークンの削除・失効は Core 側の後処理。
  | {
      readonly kind: 'connections.disconnect';
      readonly connection_id: string;
      readonly expected_permission_revision: string;
    }
  // 再認可の完了（B03-04）。切断済みには使えない（作り直す）。対象と取得集合は触らない。
  | {
      readonly kind: 'connections.reactivate';
      readonly connection_id: string;
      readonly credential_ref: string;
      readonly access: 'read' | 'read_write';
      readonly granted_scopes: readonly string[];
    }
  // 更新トークンの恒常的な失敗の記録（B03-04）。許可版は上げない（本人の選択は変わっていない）。
  | {
      readonly kind: 'connections.mark_needs_reauth';
      readonly connection_id: string;
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
  | SealedBlobInput
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
  new Set([
    'connections.update_targets',
    'connections.create',
    'connections.disconnect',
    'connections.reactivate',
    'connections.mark_needs_reauth',
  ]);

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

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const VISIBLE = /^[\x21-\x7e]{1,256}$/u;

// アカウント識別の封筒の形（candidate-store の SealedBlobInput の検査と同じ規則）。
function sealedBlobReasons(value: unknown): string[] {
  if (!isRecord(value)) return ['account_blob_invalid'];
  const reasons: string[] = [];
  if (
    typeof value['blob_id'] !== 'string' ||
    !CONNECTION_ID.test(value['blob_id'])
  )
    reasons.push('account_blob_id_invalid');
  if (value['format_version'] !== SEALED_BLOB_FORMAT_VERSION)
    reasons.push('account_blob_format_version_invalid');
  if (typeof value['key_id'] !== 'string' || !KEY_ID.test(value['key_id']))
    reasons.push('account_blob_key_id_invalid');
  if (!(value['nonce'] instanceof Uint8Array) || value['nonce'].length !== 12)
    reasons.push('account_blob_nonce_invalid');
  if (
    !(value['ciphertext'] instanceof Uint8Array) ||
    value['ciphertext'].length < 1
  )
    reasons.push('account_blob_ciphertext_invalid');
  if (!(value['tag'] instanceof Uint8Array) || value['tag'].length !== 16)
    reasons.push('account_blob_tag_invalid');
  return reasons.length > 0 ? ['account_blob_invalid', ...reasons] : reasons;
}

function credentialReasons(value: unknown): string[] {
  const reasons: string[] = [];
  if (typeof value !== 'string' || !VISIBLE.test(value))
    reasons.push('credential_ref_invalid');
  return reasons;
}

function accessReasons(value: unknown): string[] {
  return value === 'read' || value === 'read_write' ? [] : ['access_invalid'];
}

function grantedScopesReasons(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every(
      (scope) =>
        typeof scope === 'string' && scope.length >= 1 && scope.length <= 1024,
    )
  )
    return ['granted_scopes_invalid'];
  return [];
}

function scopeSeedReasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    return ['scopes_invalid'];
  const reasons: string[] = [];
  const ids = new Set<string>();
  const resources = new Set<string>();
  for (const seed of value) {
    if (!isRecord(seed)) return ['scopes_invalid'];
    const keys = Object.keys(seed);
    if (
      keys.length !== 2 ||
      !Object.hasOwn(seed, 'scope_id') ||
      !Object.hasOwn(seed, 'resource')
    )
      return ['scopes_invalid'];
    if (
      typeof seed['scope_id'] !== 'string' ||
      !CONNECTION_ID.test(seed['scope_id']) ||
      ids.has(seed['scope_id'])
    )
      reasons.push('scope_id_invalid');
    else ids.add(seed['scope_id']);
    if (
      (seed['resource'] !== 'mail' && seed['resource'] !== 'calendar') ||
      resources.has(seed['resource'])
    )
      reasons.push('scope_resource_invalid');
    else resources.add(seed['resource']);
  }
  return reasons.length > 0 ? ['scopes_invalid', ...reasons] : reasons;
}

export function connectionTargetsOpShapeReasons(
  op: ConnectionTargetsOp,
): string[] {
  const reasons: string[] = [];
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !CONNECTION_ID.test(value))
      reasons.push('connection_id_invalid');
  };
  const revision = (value: unknown) => {
    if (
      typeof value !== 'string' ||
      !REVISION.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      reasons.push('expected_permission_revision_invalid');
  };
  switch (op.kind) {
    case 'connections.list':
      break;
    case 'connections.get':
    case 'connections.account_blob':
    case 'connections.mark_needs_reauth':
      id(op.connection_id);
      break;
    case 'connections.update_targets':
      id(op.connection_id);
      revision(op.expected_permission_revision);
      reasons.push(...targetsReasons(op.targets));
      break;
    case 'connections.create':
      id(op.connection_id);
      if (op.provider !== 'google' && op.provider !== 'microsoft')
        reasons.push('provider_invalid');
      if (!Number.isSafeInteger(op.created_at) || op.created_at < 0)
        reasons.push('created_at_invalid');
      reasons.push(...sealedBlobReasons(op.account));
      reasons.push(...credentialReasons(op.credential_ref));
      reasons.push(...accessReasons(op.access));
      reasons.push(...grantedScopesReasons(op.granted_scopes));
      reasons.push(...targetsReasons(op.targets));
      reasons.push(...scopeSeedReasons(op.scopes));
      break;
    case 'connections.disconnect':
      id(op.connection_id);
      revision(op.expected_permission_revision);
      break;
    case 'connections.reactivate':
      id(op.connection_id);
      reasons.push(...credentialReasons(op.credential_ref));
      reasons.push(...accessReasons(op.access));
      reasons.push(...grantedScopesReasons(op.granted_scopes));
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
  const abandoned = abandonConnectionScans(db, op.connection_id);
  // 変更のたびに全量照合を必ず要求する（U207 の決定 (b)、B08-05、ADR 0136）。新しく選んだフォルダー／ラベルの
  // 過去分は増分では届かないので、その接続の全取得集合に pending_full を立てる。
  db.prepare(
    'UPDATE sync_scopes SET scope_revision = ?, pending_full = 1 WHERE connection_id = ?',
  ).run(scopeRevision, op.connection_id);
  const connection = readConnection(db, op.connection_id);
  if (connection === null)
    throw new ConnectionTargetsRejection(['connection_not_found']);
  return { connection, changed: true, abandoned_scans: abandoned };
}

// 接続の有効な走査をすべて abandoned にし、走査の種類に応じて pending_* を立てる（11 §1A）。
// 戻り値は abandoned にした走査の数。
function abandonConnectionScans(
  db: SqliteDatabase,
  connectionId: string,
): number {
  const active = db
    .prepare(
      `SELECT b.scan_id, b.scope_id, b.kind FROM sync_batches b
       JOIN sync_scopes s ON s.scope_id = b.scope_id
       WHERE s.connection_id = ? AND b.status IN ('fetching', 'staged', 'validated')`,
    )
    .all(connectionId) as ActiveBatchRow[];
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
  return active.length;
}

function applyCreate(
  db: SqliteDatabase,
  op: Extract<ConnectionTargetsOp, { kind: 'connections.create' }>,
): ConnectionRecord {
  const existing = readConnection(db, op.connection_id);
  if (existing !== null)
    throw new ConnectionTargetsRejection(['connection_exists']);
  const targets = toWire(normalizeFetchScope(toScope(op.targets)));
  // アカウント識別の封筒（所有者は接続の行、内容版 0。candidate-store と同じ列の形）。
  db.prepare(
    `INSERT INTO sealed_blobs
       (blob_id, format_version, key_id, nonce, ciphertext, tag,
        owner_table, owner_id, owner_version, purpose, created_at, delete_at)
     VALUES (?, ?, ?, ?, ?, ?, 'connections', ?, 0, 'connection_account', ?, NULL)`,
  ).run(
    op.account.blob_id,
    op.account.format_version,
    op.account.key_id,
    Buffer.from(op.account.nonce),
    Buffer.from(op.account.ciphertext),
    Buffer.from(op.account.tag),
    op.connection_id,
    op.created_at,
  );
  db.prepare(
    `INSERT INTO connections
       (connection_id, account_blob_id, credential_ref, provider, status, access,
        granted_scopes, targets, permission_revision, scope_revision)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 1, 1)`,
  ).run(
    op.connection_id,
    op.account.blob_id,
    op.credential_ref,
    op.provider,
    op.access,
    JSON.stringify([...op.granted_scopes]),
    JSON.stringify(targets),
  );
  // 取得集合の初期行（設計 11 §1A: プロバイダ＋アカウント＋資源種別で 1 つ）。
  // まだ全量照合が済んでいないので pending_full を立て、スケジューラの最初の走査を全量にする。
  for (const seed of op.scopes) {
    db.prepare(
      `INSERT INTO sync_scopes
         (scope_id, connection_id, scope_revision, active_scan_id, active_generation,
          committed_watermark, provider_cursor, executor_generation,
          last_incremental_completed_at, last_full_reconciled_at,
          pending_incremental, pending_full, analysis_plan_complete_generation)
       VALUES (?, ?, 1, NULL, 0, NULL, NULL, 0, NULL, NULL, 0, 1, NULL)`,
    ).run(seed.scope_id, op.connection_id);
  }
  const connection = readConnection(db, op.connection_id);
  if (connection === null)
    throw new ConnectionTargetsRejection(['connection_not_found']);
  return connection;
}

interface AccountBlobRow {
  blob_id: string;
  format_version: number;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function readAccountBlob(
  db: SqliteDatabase,
  connectionId: string,
): SealedBlobInput | null {
  const row = db
    .prepare(
      `SELECT b.blob_id, b.format_version, b.key_id, b.nonce, b.ciphertext, b.tag
       FROM connections c JOIN sealed_blobs b ON b.blob_id = c.account_blob_id
       WHERE c.connection_id = ?`,
    )
    .get(connectionId) as AccountBlobRow | undefined;
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

function applyDisconnect(
  db: SqliteDatabase,
  op: Extract<ConnectionTargetsOp, { kind: 'connections.disconnect' }>,
): ConnectionTargetsUpdated {
  const current = readConnection(db, op.connection_id);
  if (current === null)
    throw new ConnectionTargetsRejection(['connection_not_found']);
  if (current.permission_revision !== op.expected_permission_revision)
    throw new ConnectionTargetsRejection(['permission_revision_mismatch']);
  // すでに切断済みなら、版が合う限り冪等に成功として返す（何も書かない）。
  if (current.status === 'disconnected')
    return { connection: current, changed: false, abandoned_scans: 0 };
  const permission = Number(current.permission_revision) + 1;
  if (!Number.isSafeInteger(permission))
    throw new ConnectionTargetsRejection(['revision_overflow']);
  const updated = db
    .prepare(
      `UPDATE connections SET status = 'disconnected', credential_ref = NULL,
         permission_revision = ?
       WHERE connection_id = ? AND permission_revision = ?`,
    )
    .run(
      permission,
      op.connection_id,
      Number(op.expected_permission_revision),
    ).changes;
  if (updated !== 1)
    throw new ConnectionTargetsRejection(['permission_revision_mismatch']);
  // 取得を止める: 有効な走査を abandoned にし、保留中の走査要求も消す。
  const abandoned = abandonConnectionScans(db, op.connection_id);
  db.prepare(
    'UPDATE sync_scopes SET pending_incremental = 0, pending_full = 0 WHERE connection_id = ?',
  ).run(op.connection_id);
  const connection = readConnection(db, op.connection_id);
  if (connection === null)
    throw new ConnectionTargetsRejection(['connection_not_found']);
  return { connection, changed: true, abandoned_scans: abandoned };
}

function applyReactivate(
  db: SqliteDatabase,
  op: Extract<ConnectionTargetsOp, { kind: 'connections.reactivate' }>,
): ConnectionRecord {
  const current = readConnection(db, op.connection_id);
  if (current === null)
    throw new ConnectionTargetsRejection(['connection_not_found']);
  if (current.status === 'disconnected')
    throw new ConnectionTargetsRejection(['connection_disconnected']);
  const permission = Number(current.permission_revision) + 1;
  if (!Number.isSafeInteger(permission))
    throw new ConnectionTargetsRejection(['revision_overflow']);
  db.prepare(
    `UPDATE connections SET credential_ref = ?, access = ?, granted_scopes = ?,
       status = 'active', permission_revision = ?
     WHERE connection_id = ?`,
  ).run(
    op.credential_ref,
    op.access,
    JSON.stringify([...op.granted_scopes]),
    permission,
    op.connection_id,
  );
  const connection = readConnection(db, op.connection_id);
  if (connection === null)
    throw new ConnectionTargetsRejection(['connection_not_found']);
  return connection;
}

function applyMarkNeedsReauth(
  db: SqliteDatabase,
  op: Extract<ConnectionTargetsOp, { kind: 'connections.mark_needs_reauth' }>,
): ConnectionRecord | null {
  const current = readConnection(db, op.connection_id);
  if (current === null) return null;
  if (current.status !== 'active') return current;
  db.prepare(
    "UPDATE connections SET status = 'needs_reauth' WHERE connection_id = ?",
  ).run(op.connection_id);
  return readConnection(db, op.connection_id);
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
  if (op.kind === 'connections.account_blob')
    return {
      result: { ok: true, value: readAccountBlob(db, op.connection_id) },
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
    const run = runImmediate(db, () => {
      switch (op.kind) {
        case 'connections.update_targets':
          return applyUpdate(db, op);
        case 'connections.create':
          return applyCreate(db, op);
        case 'connections.disconnect':
          return applyDisconnect(db, op);
        case 'connections.reactivate':
          return applyReactivate(db, op);
        case 'connections.mark_needs_reauth':
          return applyMarkNeedsReauth(db, op);
        default:
          throw new ConnectionTargetsRejection(['kind_invalid']);
      }
    });
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
