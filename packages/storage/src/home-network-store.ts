// 自宅の登録値と端末ごとの最新の報告の保存（設計 11 §10、X42、ADR 0022）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、
// 端末の命令（device-store.ts）と同じく、transaction の前に接続の耐久設定を読み戻す。
// - MAC と SSID は Core が HMAC にしてから渡す（小文字の 16 進 64 桁）。平文は受け取らない。
// - 自宅は家ごとに 1 つ（home_id = 1）。登録し直すと置き換える。
// - 報告は端末ごとに最新の 1 件だけ。失効した端末・未登録の端末の報告は書かない。
// - 自宅判定が成り立たないとき、Core はその端末の有効な接続範囲をここで失効させる（home.revoke_scopes）。
// 結果の理由にはコードだけを入れ、SQL・パス・hash の値を入れない。

import Database from 'better-sqlite3';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HMAC = /^[0-9a-f]{64}$/u;
// 正準の IPv4 の CIDR の形（値の検査は Core が domain の parseHomeSubnet で行う）。
const SUBNET = /^[0-9]{1,3}(\.[0-9]{1,3}){3}\/[0-9]{1,2}$/u;

export interface HomeRegistrationRecord {
  readonly gateway_mac_hmac: string;
  readonly subnet: string;
  readonly ssid_hmac: string | null;
  // UTC の Unix ミリ秒。
  readonly registered_at: number;
  readonly registered_by_device_id: string;
}

export interface HomeReportRecord {
  readonly device_id: string;
  readonly gateway_mac_hmac: string | null;
  readonly subnet: string | null;
  readonly ssid_hmac: string | null;
  // 中枢が受け取った時刻（UTC の Unix ミリ秒）。
  readonly received_at: number;
}

export type HomeNetworkOp =
  // 自宅を登録する（置き換える）。登録した端末が登録済みで失効していないこと。
  | {
      readonly kind: 'home.register';
      readonly gateway_mac_hmac: string;
      readonly subnet: string;
      readonly ssid_hmac: string | null;
      readonly registered_at: number;
      readonly device_id: string;
    }
  | { readonly kind: 'home.get' }
  // 端末の最新の報告を置き換える。
  | {
      readonly kind: 'home.report';
      readonly device_id: string;
      readonly gateway_mac_hmac: string | null;
      readonly subnet: string | null;
      readonly ssid_hmac: string | null;
      readonly received_at: number;
    }
  | { readonly kind: 'home.find_report'; readonly device_id: string }
  // 自宅判定の不成立で、端末の有効な接続範囲を失効させる。
  | {
      readonly kind: 'home.revoke_scopes';
      readonly device_id: string;
      readonly revoked_at: number;
    };

export type HomeNetworkOpKind = HomeNetworkOp['kind'];

export type HomeNetworkOpValue =
  | HomeRegistrationRecord
  | HomeReportRecord
  | { readonly revoked_scopes: number }
  | null;

export type HomeNetworkOpResult =
  | { readonly ok: true; readonly value: HomeNetworkOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface HomeNetworkStoreResult {
  readonly result: HomeNetworkOpResult;
  // 以後の書込みを止めるべき失敗（成否不明・想定外の失敗・耐久設定の不一致）。
  readonly halt: boolean;
}

export const HOME_NETWORK_WRITE_OPS: ReadonlySet<HomeNetworkOpKind> = new Set([
  'home.register',
  'home.report',
  'home.revoke_scopes',
]);

class HomeNetworkRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'HomeNetworkRejection';
    this.reasons = reasons;
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// 形の検査。structured clone を通った値を信用せず、DB に書く前に確かめる。
export function homeNetworkOpShapeReasons(op: HomeNetworkOp): string[] {
  const reasons: string[] = [];
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !UUID.test(value))
      reasons.push('device_id_invalid');
  };
  const hmac = (value: unknown, name: string, nullable: boolean) => {
    if (value === null && nullable) return;
    if (typeof value !== 'string' || !HMAC.test(value))
      reasons.push(`${name}_invalid`);
  };
  const subnet = (value: unknown, nullable: boolean) => {
    if (value === null && nullable) return;
    if (typeof value !== 'string' || !SUBNET.test(value))
      reasons.push('subnet_invalid');
  };
  switch (op.kind) {
    case 'home.register':
      hmac(op.gateway_mac_hmac, 'gateway_mac_hmac', false);
      subnet(op.subnet, false);
      hmac(op.ssid_hmac, 'ssid_hmac', true);
      if (!isTime(op.registered_at)) reasons.push('registered_at_invalid');
      id(op.device_id);
      break;
    case 'home.get':
      break;
    case 'home.report':
      id(op.device_id);
      hmac(op.gateway_mac_hmac, 'gateway_mac_hmac', true);
      subnet(op.subnet, true);
      hmac(op.ssid_hmac, 'ssid_hmac', true);
      if (!isTime(op.received_at)) reasons.push('received_at_invalid');
      break;
    case 'home.find_report':
      id(op.device_id);
      break;
    case 'home.revoke_scopes':
      id(op.device_id);
      if (!isTime(op.revoked_at)) reasons.push('revoked_at_invalid');
      break;
    default:
      reasons.push('kind_invalid');
  }
  return reasons;
}

interface RegistrationRow {
  gateway_mac_hmac: Buffer;
  subnet: string;
  ssid_hmac: Buffer | null;
  registered_at: number;
  registered_by_device_id: string;
}

interface ReportRow {
  device_id: string;
  gateway_mac_hmac: Buffer | null;
  subnet: string | null;
  ssid_hmac: Buffer | null;
  received_at: number;
}

const hex = (value: Buffer | null): string | null =>
  value === null ? null : value.toString('hex');
const blob = (value: string | null): Buffer | null =>
  value === null ? null : Buffer.from(value, 'hex');

function readRegistration(db: SqliteDatabase): HomeRegistrationRecord | null {
  const row = db
    .prepare(
      'SELECT gateway_mac_hmac, subnet, ssid_hmac, registered_at, registered_by_device_id FROM home_networks WHERE home_id = 1',
    )
    .get() as RegistrationRow | undefined;
  if (row === undefined) return null;
  return {
    gateway_mac_hmac: row.gateway_mac_hmac.toString('hex'),
    subnet: row.subnet,
    ssid_hmac: hex(row.ssid_hmac),
    registered_at: row.registered_at,
    registered_by_device_id: row.registered_by_device_id,
  };
}

function readReport(
  db: SqliteDatabase,
  deviceId: string,
): HomeReportRecord | null {
  const row = db
    .prepare(
      'SELECT device_id, gateway_mac_hmac, subnet, ssid_hmac, received_at FROM home_network_reports WHERE device_id = ?',
    )
    .get(deviceId) as ReportRow | undefined;
  if (row === undefined) return null;
  return {
    device_id: row.device_id,
    gateway_mac_hmac: hex(row.gateway_mac_hmac),
    subnet: row.subnet,
    ssid_hmac: hex(row.ssid_hmac),
    received_at: row.received_at,
  };
}

// 登録済みで失効していない端末か。
function requireActiveDevice(db: SqliteDatabase, deviceId: string): void {
  const row = db
    .prepare('SELECT revoked_at FROM devices WHERE device_id = ?')
    .get(deviceId) as { revoked_at: number | null } | undefined;
  if (row === undefined) throw new HomeNetworkRejection(['device_not_found']);
  if (row.revoked_at !== null)
    throw new HomeNetworkRejection(['device_revoked']);
}

function applyWrite(db: SqliteDatabase, op: HomeNetworkOp): HomeNetworkOpValue {
  if (op.kind === 'home.register') {
    requireActiveDevice(db, op.device_id);
    db.prepare(
      `INSERT INTO home_networks (home_id, gateway_mac_hmac, subnet, ssid_hmac, registered_at, registered_by_device_id)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (home_id) DO UPDATE SET gateway_mac_hmac = excluded.gateway_mac_hmac, subnet = excluded.subnet,
         ssid_hmac = excluded.ssid_hmac, registered_at = excluded.registered_at,
         registered_by_device_id = excluded.registered_by_device_id`,
    ).run(
      blob(op.gateway_mac_hmac),
      op.subnet,
      blob(op.ssid_hmac),
      op.registered_at,
      op.device_id,
    );
    const row = readRegistration(db);
    if (row === null) throw new HomeNetworkRejection(['home_missing']);
    return row;
  }
  if (op.kind === 'home.report') {
    requireActiveDevice(db, op.device_id);
    db.prepare(
      `INSERT INTO home_network_reports (device_id, gateway_mac_hmac, subnet, ssid_hmac, received_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET gateway_mac_hmac = excluded.gateway_mac_hmac, subnet = excluded.subnet,
         ssid_hmac = excluded.ssid_hmac, received_at = excluded.received_at`,
    ).run(
      op.device_id,
      blob(op.gateway_mac_hmac),
      op.subnet,
      blob(op.ssid_hmac),
      op.received_at,
    );
    const row = readReport(db, op.device_id);
    if (row === null) throw new HomeNetworkRejection(['report_missing']);
    return row;
  }
  if (op.kind === 'home.revoke_scopes') {
    // 端末がなくても失効させるものがないだけ（0 件）。失効済みの接続範囲の時刻は変えない。
    const changes = db
      .prepare(
        'UPDATE command_scopes SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
      )
      .run(op.revoked_at, op.device_id).changes;
    return { revoked_scopes: changes };
  }
  throw new HomeNetworkRejection(['kind_invalid']);
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): HomeNetworkOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

// 自宅の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeHomeNetworkOp(
  db: SqliteDatabase,
  op: HomeNetworkOp,
  context: { readonly platform: StoragePlatform; readonly halted: boolean },
): HomeNetworkStoreResult {
  const shape = homeNetworkOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'home.get')
    return { result: { ok: true, value: readRegistration(db) }, halt: false };
  if (op.kind === 'home.find_report')
    return {
      result: { ok: true, value: readReport(db, op.device_id) },
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
    const run = runImmediate(db, () => applyWrite(db, op));
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof HomeNetworkRejection)
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
