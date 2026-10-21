// 端末と接続範囲（command_scope）の保存（設計 02 端末登録と接続、07 §2・§3、ADR 0009・0020）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、
// 操作の命令（operation-store.ts）と同じく、transaction の前に接続の耐久設定を読み戻す。
// - 端末の照合は端末トークンの SHA-256（32 バイト）で devices を引く。トークンそのものは受け取らない。
// - 接続範囲は端末ごとに一つだけ有効にする。新しく発行すると、同じ端末の有効な接続範囲を同じ
//   transaction で無効にする（07 §2「再接続で無効」）。期限は最長 24 時間（RETENTION_RULES の command_scope）。
// - 端末の失効では、その端末の有効な接続範囲も同じ transaction で無効にする。
// 結果の理由にはコードだけを入れ、SQL・パス・hash の値を入れない。

import Database from 'better-sqlite3';
import { RETENTION_RULES } from '@buddy/domain';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';

// 接続範囲の最長の期限（24 時間）。0001 の CHECK（expires_at <= issued_at + 86400000）と同じ値。
export const COMMAND_SCOPE_MAX_TTL_MS =
  RETENTION_RULES['command_scope']?.ms ?? 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TOKEN_HASH = /^[0-9a-f]{64}$/u;
const PLATFORMS = new Set(['windows', 'macos', 'linux']);

export type DevicePlatform = 'windows' | 'macos' | 'linux';

export interface DeviceRecord {
  readonly device_id: string;
  readonly device_name: string;
  readonly platform: DevicePlatform;
  readonly hub_local: boolean;
  // UTC の Unix ミリ秒。
  readonly registered_at: number;
  readonly last_seen_at: number | null;
  readonly revoked_at: number | null;
}

export interface CommandScopeRecord {
  readonly command_scope_id: string;
  readonly device_id: string;
  readonly core_instance_id: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

export type DeviceOp =
  // 端末を登録する。ペアリング（B03-02）と試験から使う。token_hash は端末トークンの SHA-256 の小文字の 16 進。
  | {
      readonly kind: 'device.insert';
      readonly device_id: string;
      readonly device_name: string;
      readonly platform: DevicePlatform;
      readonly hub_local: boolean;
      readonly token_hash: string;
      readonly registered_at: number;
    }
  // 端末を失効し、その端末の有効な接続範囲を無効にする。
  | {
      readonly kind: 'device.revoke';
      readonly device_id: string;
      readonly revoked_at: number;
    }
  | { readonly kind: 'device.find_by_token_hash'; readonly token_hash: string }
  // 接続範囲を発行し、同じ端末の有効な接続範囲を無効にする。端末の last_seen_at も更新する。
  | {
      readonly kind: 'scope.issue';
      readonly command_scope_id: string;
      readonly device_id: string;
      readonly core_instance_id: string;
      readonly issued_at: number;
      readonly expires_at: number;
    }
  | { readonly kind: 'scope.find'; readonly command_scope_id: string };

export type DeviceOpKind = DeviceOp['kind'];

export type DeviceOpValue =
  | DeviceRecord
  | CommandScopeRecord
  | { readonly revoked_scopes: number }
  | null;

export type DeviceOpResult =
  | { readonly ok: true; readonly value: DeviceOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface DeviceStoreResult {
  readonly result: DeviceOpResult;
  // 以後の書込みを止めるべき失敗（成否不明・想定外の失敗・耐久設定の不一致）。
  readonly halt: boolean;
}

export const DEVICE_WRITE_OPS: ReadonlySet<DeviceOpKind> = new Set([
  'device.insert',
  'device.revoke',
  'scope.issue',
]);

class DeviceRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'DeviceRejection';
    this.reasons = reasons;
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// 形の検査。structured clone を通った値を信用せず、DB に書く前に確かめる。
export function deviceOpShapeReasons(op: DeviceOp): string[] {
  const reasons: string[] = [];
  const id = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !UUID.test(value))
      reasons.push(`${name}_invalid`);
  };
  switch (op.kind) {
    case 'device.insert':
      id(op.device_id, 'device_id');
      if (
        typeof op.device_name !== 'string' ||
        op.device_name.length < 1 ||
        op.device_name.length > 40
      )
        reasons.push('device_name_invalid');
      if (!PLATFORMS.has(op.platform)) reasons.push('platform_invalid');
      if (typeof op.hub_local !== 'boolean') reasons.push('hub_local_invalid');
      if (typeof op.token_hash !== 'string' || !TOKEN_HASH.test(op.token_hash))
        reasons.push('token_hash_invalid');
      if (!isTime(op.registered_at)) reasons.push('registered_at_invalid');
      break;
    case 'device.revoke':
      id(op.device_id, 'device_id');
      if (!isTime(op.revoked_at)) reasons.push('revoked_at_invalid');
      break;
    case 'device.find_by_token_hash':
      if (typeof op.token_hash !== 'string' || !TOKEN_HASH.test(op.token_hash))
        reasons.push('token_hash_invalid');
      break;
    case 'scope.issue':
      id(op.command_scope_id, 'command_scope_id');
      id(op.device_id, 'device_id');
      id(op.core_instance_id, 'core_instance_id');
      if (!isTime(op.issued_at)) reasons.push('issued_at_invalid');
      if (
        !isTime(op.expires_at) ||
        !isTime(op.issued_at) ||
        op.expires_at <= op.issued_at ||
        op.expires_at > op.issued_at + COMMAND_SCOPE_MAX_TTL_MS
      )
        reasons.push('expires_at_invalid');
      break;
    case 'scope.find':
      id(op.command_scope_id, 'command_scope_id');
      break;
    default:
      reasons.push('kind_invalid');
  }
  return reasons;
}

interface DeviceRow {
  device_id: string;
  device_name: string;
  platform: string;
  hub_local: number;
  registered_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

interface ScopeRow {
  command_scope_id: string;
  device_id: string;
  core_instance_id: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const DEVICE_COLUMNS =
  'device_id, device_name, platform, hub_local, registered_at, last_seen_at, revoked_at';
const SCOPE_COLUMNS =
  'command_scope_id, device_id, core_instance_id, issued_at, expires_at, revoked_at';

function toDevice(row: DeviceRow): DeviceRecord {
  return {
    device_id: row.device_id,
    device_name: row.device_name,
    platform: row.platform as DevicePlatform,
    hub_local: row.hub_local === 1,
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
  };
}

function toScope(row: ScopeRow): CommandScopeRecord {
  return { ...row };
}

function readDevice(db: SqliteDatabase, deviceId: string): DeviceRow | null {
  return (
    (db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE device_id = ?`)
      .get(deviceId) as DeviceRow | undefined) ?? null
  );
}

function readScope(db: SqliteDatabase, scopeId: string): ScopeRow | null {
  return (
    (db
      .prepare(
        `SELECT ${SCOPE_COLUMNS} FROM command_scopes WHERE command_scope_id = ?`,
      )
      .get(scopeId) as ScopeRow | undefined) ?? null
  );
}

function revokeActiveScopes(
  db: SqliteDatabase,
  deviceId: string,
  at: number,
): number {
  return db
    .prepare(
      'UPDATE command_scopes SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
    )
    .run(at, deviceId).changes;
}

function applyWrite(db: SqliteDatabase, op: DeviceOp): DeviceOpValue {
  if (op.kind === 'device.insert') {
    if (readDevice(db, op.device_id) !== null)
      throw new DeviceRejection(['device_exists']);
    db.prepare(
      'INSERT INTO devices (device_id, device_name, platform, hub_local, token_hash, registered_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
    ).run(
      op.device_id,
      op.device_name,
      op.platform,
      op.hub_local ? 1 : 0,
      Buffer.from(op.token_hash, 'hex'),
      op.registered_at,
    );
    const row = readDevice(db, op.device_id);
    if (row === null) throw new DeviceRejection(['device_missing']);
    return toDevice(row);
  }
  if (op.kind === 'device.revoke') {
    const row = readDevice(db, op.device_id);
    if (row === null) throw new DeviceRejection(['device_not_found']);
    // 失効済みの端末は失効の時刻を変えない。接続範囲は念のため無効にする。
    if (row.revoked_at === null)
      db.prepare('UPDATE devices SET revoked_at = ? WHERE device_id = ?').run(
        op.revoked_at,
        op.device_id,
      );
    return {
      revoked_scopes: revokeActiveScopes(db, op.device_id, op.revoked_at),
    };
  }
  if (op.kind === 'scope.issue') {
    const device = readDevice(db, op.device_id);
    if (device === null) throw new DeviceRejection(['device_not_found']);
    if (device.revoked_at !== null)
      throw new DeviceRejection(['device_revoked']);
    if (readScope(db, op.command_scope_id) !== null)
      throw new DeviceRejection(['command_scope_exists']);
    revokeActiveScopes(db, op.device_id, op.issued_at);
    db.prepare(
      `INSERT INTO command_scopes (${SCOPE_COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      op.command_scope_id,
      op.device_id,
      op.core_instance_id,
      op.issued_at,
      op.expires_at,
    );
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(
      op.issued_at,
      op.device_id,
    );
    const row = readScope(db, op.command_scope_id);
    if (row === null) throw new DeviceRejection(['command_scope_missing']);
    return toScope(row);
  }
  throw new DeviceRejection(['kind_invalid']);
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): DeviceOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

// 端末・接続範囲の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeDeviceOp(
  db: SqliteDatabase,
  op: DeviceOp,
  context: { readonly platform: StoragePlatform; readonly halted: boolean },
): DeviceStoreResult {
  const shape = deviceOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'device.find_by_token_hash') {
    const row = db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE token_hash = ?`)
      .get(Buffer.from(op.token_hash, 'hex')) as DeviceRow | undefined;
    return {
      result: { ok: true, value: row === undefined ? null : toDevice(row) },
      halt: false,
    };
  }
  if (op.kind === 'scope.find') {
    const row = readScope(db, op.command_scope_id);
    return {
      result: { ok: true, value: row === null ? null : toScope(row) },
      halt: false,
    };
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
  try {
    const run = runImmediate(db, () => applyWrite(db, op));
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof DeviceRejection)
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
