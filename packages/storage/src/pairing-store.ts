// 端末のペアリング（pairing_sessions・pairing_claims）と端末の一覧・数・証明書の変更による失効
// （設計 02 端末登録と接続、ADR 0009 の U15・0020・0021）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、
// device-store.ts と同じく transaction の前に接続の耐久設定を読み戻す。
// - コード・申請用の秘密は受け取った hash（32 バイト）だけを扱い、平文を受け取らない。照合は
//   transaction の中で timingSafeEqual で行い、照合と残り回数の更新・使用済みの記録を同じ transaction にする。
// - 有効なペアリングは一つだけ。新しく開始すると、まだ使っていないペアリングを使用済みにする（申請はコード
//   だけを送り、ペアリング ID を送らないため、照合の相手を一つに決める）。
// - トークンの受取りでは、端末を登録し（devices.token_hash はトークンの hash だけ）、申請を consumed にする
//   ことを同じ transaction で行う。
// 結果の理由にはコードだけを入れ、SQL・パス・hash の値を入れない。

import { timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import type { DevicePlatform, DeviceRecord } from './device-store.js';
import { runImmediate } from './operation-store.js';

// ペアリングの有効期間（02 の設計初期値 5 分。0001 の CHECK と同じ上限）と連続の失敗の上限（5 回）。
export const PAIRING_SESSION_TTL_MS = 300_000;
export const PAIRING_MAX_ATTEMPTS = 5;
// 申請の有効期間（申請の時刻から 5 分。ADR 0021 の判断）。承認とトークンの受取りはこの期限の前だけ。
export const PAIRING_CLAIM_TTL_MS = 300_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const PLATFORMS = new Set(['windows', 'macos', 'linux']);

export type PairingClaimStatus =
  'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

// 申請（hash を含めない）。certificate_fingerprint は申請したペアリングの開始時の中枢の証明書の指紋。
export interface PairingClaimRecord {
  readonly claim_id: string;
  readonly pairing_id: string;
  readonly device_name: string;
  readonly platform: DevicePlatform;
  readonly status: PairingClaimStatus;
  // UTC の Unix ミリ秒。
  readonly expires_at: number;
  readonly device_id: string | null;
  readonly certificate_fingerprint: string;
}

export interface PairingSessionRecord {
  readonly pairing_id: string;
  readonly certificate_fingerprint: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly attempts_left: number;
  readonly used: boolean;
}

// コードの照合の失敗の理由（domain の checkPairingCode と同じ並び。外へはどれも pairing_failed）。
export type PairingCodeFailure =
  'no_session' | 'used' | 'expired' | 'attempts_exhausted' | 'code_mismatch';

export type PairingClaimOutcome =
  | { readonly ok: true; readonly claim: PairingClaimRecord }
  | {
      readonly ok: false;
      readonly reason: PairingCodeFailure;
      readonly attempts_left: number;
    };

export type PairingOp =
  // ペアリングを開始する。まだ使っていない他のペアリングは使用済みにする。
  | {
      readonly kind: 'pairing.start';
      readonly pairing_id: string;
      // コードの照合値（HMAC-SHA256 の小文字の 16 進。ADR 0021）。
      readonly code_hash: string;
      readonly certificate_fingerprint: string;
      readonly created_at: number;
      readonly expires_at: number;
    }
  // 申請。最新のペアリングとコードを照合し、合えば使用済みにして申請（pending）を作る。
  // 合わなければ残り回数を減らす（その更新は commit する）。
  | {
      readonly kind: 'pairing.claim';
      readonly claim_id: string;
      readonly code_hash: string;
      readonly device_name: string;
      readonly platform: DevicePlatform;
      // 申請用の秘密の SHA-256（端末が送った値）。
      readonly claim_secret_hash: string;
      readonly now: number;
      readonly claim_expires_at: number;
    }
  | { readonly kind: 'pairing.find_claim'; readonly claim_id: string }
  // ペアリングの申請（最初の端末の CLI の承認で、ペアリング ID から申請を引く）。
  | { readonly kind: 'pairing.find_session_claim'; readonly pairing_id: string }
  | { readonly kind: 'pairing.find_session'; readonly pairing_id: string }
  // 申請用の秘密の照合（timingSafeEqual）。申請がなければ一致しない。
  | {
      readonly kind: 'pairing.claim_secret_matches';
      readonly claim_id: string;
      readonly claim_secret_hash: string;
    }
  // 承認・拒否。pending かつ期限の前で、ペアリングの開始時と今の証明書の指紋が同じときだけ。
  // require_no_active_devices は最初の端末の CLI の承認（有効な端末が 0 台のときだけ）。
  | {
      readonly kind: 'pairing.decide';
      readonly claim_id: string;
      readonly decision: 'approve' | 'reject';
      readonly now: number;
      readonly certificate_fingerprint: string;
      readonly require_no_active_devices: boolean;
    }
  // トークンの受取り。承認済み・期限の前・秘密が一致・証明書が同じときだけ、端末を登録して consumed にする。
  | {
      readonly kind: 'pairing.pickup';
      readonly claim_id: string;
      readonly claim_secret_hash: string;
      readonly device_id: string;
      // 端末トークンの照合用の hash（トークンそのものは受け取らない）。
      readonly token_hash: string;
      readonly hub_local: boolean;
      readonly now: number;
      readonly certificate_fingerprint: string;
    }
  | { readonly kind: 'devices.list' }
  | { readonly kind: 'devices.find'; readonly device_id: string }
  | { readonly kind: 'devices.count_active' }
  // 今の証明書と違う指紋のペアリングで登録した有効な端末を失効し、接続範囲を無効にする（再登録にする）。
  | {
      readonly kind: 'devices.revoke_certificate_mismatch';
      readonly certificate_fingerprint: string;
      readonly revoked_at: number;
    };

export type PairingOpKind = PairingOp['kind'];

// 命令ごとの成功時の値。
export interface PairingOpValues {
  'pairing.start': PairingSessionRecord;
  'pairing.claim': PairingClaimOutcome;
  'pairing.find_claim': PairingClaimRecord | null;
  'pairing.find_session_claim': PairingClaimRecord | null;
  'pairing.find_session': PairingSessionRecord | null;
  'pairing.claim_secret_matches': { readonly matches: boolean };
  'pairing.decide': PairingClaimRecord;
  'pairing.pickup': DeviceRecord;
  'devices.list': readonly DeviceRecord[];
  'devices.find': DeviceRecord | null;
  'devices.count_active': { readonly count: number };
  'devices.revoke_certificate_mismatch': {
    readonly revoked_device_ids: readonly string[];
  };
}

export type PairingOpValue = PairingOpValues[PairingOpKind];

export type PairingOpResult =
  | { readonly ok: true; readonly value: PairingOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface PairingStoreResult {
  readonly result: PairingOpResult;
  // 以後の書込みを止めるべき失敗（成否不明・想定外の失敗・耐久設定の不一致）。
  readonly halt: boolean;
}

export const PAIRING_WRITE_OPS: ReadonlySet<PairingOpKind> = new Set([
  'pairing.start',
  'pairing.claim',
  'pairing.decide',
  'pairing.pickup',
  'devices.revoke_certificate_mismatch',
]);

class PairingRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'PairingRejection';
    this.reasons = reasons;
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// 形の検査。structured clone を通った値を信用せず、DB に書く前に確かめる。
export function pairingOpShapeReasons(op: PairingOp): string[] {
  const reasons: string[] = [];
  const id = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !UUID.test(value))
      reasons.push(`${name}_invalid`);
  };
  const hash = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !HASH.test(value))
      reasons.push(`${name}_invalid`);
  };
  const time = (value: unknown, name: string) => {
    if (!isTime(value)) reasons.push(`${name}_invalid`);
  };
  switch (op.kind) {
    case 'pairing.start':
      id(op.pairing_id, 'pairing_id');
      hash(op.code_hash, 'code_hash');
      hash(op.certificate_fingerprint, 'certificate_fingerprint');
      time(op.created_at, 'created_at');
      if (
        !isTime(op.created_at) ||
        !isTime(op.expires_at) ||
        op.expires_at <= op.created_at ||
        op.expires_at > op.created_at + PAIRING_SESSION_TTL_MS
      )
        reasons.push('expires_at_invalid');
      break;
    case 'pairing.claim':
      id(op.claim_id, 'claim_id');
      hash(op.code_hash, 'code_hash');
      hash(op.claim_secret_hash, 'claim_secret_hash');
      if (
        typeof op.device_name !== 'string' ||
        op.device_name.length < 1 ||
        op.device_name.length > 40
      )
        reasons.push('device_name_invalid');
      if (!PLATFORMS.has(op.platform)) reasons.push('platform_invalid');
      time(op.now, 'now');
      if (
        !isTime(op.now) ||
        !isTime(op.claim_expires_at) ||
        op.claim_expires_at <= op.now ||
        op.claim_expires_at > op.now + PAIRING_CLAIM_TTL_MS
      )
        reasons.push('claim_expires_at_invalid');
      break;
    case 'pairing.find_claim':
      id(op.claim_id, 'claim_id');
      break;
    case 'pairing.find_session_claim':
    case 'pairing.find_session':
      id(op.pairing_id, 'pairing_id');
      break;
    case 'pairing.claim_secret_matches':
      id(op.claim_id, 'claim_id');
      hash(op.claim_secret_hash, 'claim_secret_hash');
      break;
    case 'pairing.decide':
      id(op.claim_id, 'claim_id');
      if (op.decision !== 'approve' && op.decision !== 'reject')
        reasons.push('decision_invalid');
      time(op.now, 'now');
      hash(op.certificate_fingerprint, 'certificate_fingerprint');
      if (typeof op.require_no_active_devices !== 'boolean')
        reasons.push('require_no_active_devices_invalid');
      break;
    case 'pairing.pickup':
      id(op.claim_id, 'claim_id');
      hash(op.claim_secret_hash, 'claim_secret_hash');
      id(op.device_id, 'device_id');
      hash(op.token_hash, 'token_hash');
      if (typeof op.hub_local !== 'boolean') reasons.push('hub_local_invalid');
      time(op.now, 'now');
      hash(op.certificate_fingerprint, 'certificate_fingerprint');
      break;
    case 'devices.list':
    case 'devices.count_active':
      break;
    case 'devices.find':
      id(op.device_id, 'device_id');
      break;
    case 'devices.revoke_certificate_mismatch':
      hash(op.certificate_fingerprint, 'certificate_fingerprint');
      time(op.revoked_at, 'revoked_at');
      break;
    default:
      reasons.push('kind_invalid');
  }
  return reasons;
}

interface SessionRow {
  pairing_id: string;
  code_hash: Buffer;
  certificate_fingerprint: string;
  created_at: number;
  expires_at: number;
  attempts_left: number;
  used: number;
}

interface ClaimRow {
  claim_id: string;
  pairing_id: string;
  device_name: string;
  platform: string;
  status: string;
  expires_at: number;
  device_id: string | null;
  certificate_fingerprint: string;
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

const SESSION_COLUMNS =
  'pairing_id, code_hash, certificate_fingerprint, created_at, expires_at, attempts_left, used';
const CLAIM_SELECT =
  'SELECT c.claim_id, c.pairing_id, c.device_name, c.platform, c.status, c.expires_at, c.device_id, s.certificate_fingerprint FROM pairing_claims c JOIN pairing_sessions s ON s.pairing_id = c.pairing_id';
const DEVICE_COLUMNS =
  'device_id, device_name, platform, hub_local, registered_at, last_seen_at, revoked_at';

function toSession(row: SessionRow): PairingSessionRecord {
  return {
    pairing_id: row.pairing_id,
    certificate_fingerprint: row.certificate_fingerprint,
    created_at: row.created_at,
    expires_at: row.expires_at,
    attempts_left: row.attempts_left,
    used: row.used === 1,
  };
}

function toClaim(row: ClaimRow): PairingClaimRecord {
  return {
    claim_id: row.claim_id,
    pairing_id: row.pairing_id,
    device_name: row.device_name,
    platform: row.platform as DevicePlatform,
    status: row.status as PairingClaimStatus,
    expires_at: row.expires_at,
    device_id: row.device_id,
    certificate_fingerprint: row.certificate_fingerprint,
  };
}

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

// 32 バイトの hash を定数時間で比べる。長さが違えば一致しない。
function sameHash(stored: Buffer, given: string): boolean {
  const candidate = Buffer.from(given, 'hex');
  return (
    stored.length === candidate.length && timingSafeEqual(stored, candidate)
  );
}

function readSession(db: SqliteDatabase, pairingId: string): SessionRow | null {
  return (
    (db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM pairing_sessions WHERE pairing_id = ?`,
      )
      .get(pairingId) as SessionRow | undefined) ?? null
  );
}

function readClaim(db: SqliteDatabase, claimId: string): ClaimRow | null {
  return (
    (db.prepare(`${CLAIM_SELECT} WHERE c.claim_id = ?`).get(claimId) as
      ClaimRow | undefined) ?? null
  );
}

function readClaimSecretHash(
  db: SqliteDatabase,
  claimId: string,
): Buffer | null {
  const row = db
    .prepare('SELECT claim_secret_hash FROM pairing_claims WHERE claim_id = ?')
    .get(claimId) as { claim_secret_hash: Buffer } | undefined;
  return row?.claim_secret_hash ?? null;
}

function readDevice(db: SqliteDatabase, deviceId: string): DeviceRow | null {
  return (
    (db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE device_id = ?`)
      .get(deviceId) as DeviceRow | undefined) ?? null
  );
}

function countActiveDevices(db: SqliteDatabase): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL')
    .get() as { n: number };
  return row.n;
}

// 申請の状態の検査（承認・受取りの共通部分）。期限は時刻で判定し、status を expired に書き換えない。
function claimStateReasons(
  claim: ClaimRow,
  now: number,
  fingerprint: string,
): string | null {
  if (claim.certificate_fingerprint !== fingerprint)
    return 'certificate_changed';
  if (claim.status === 'consumed') return 'claim_consumed';
  if (claim.status === 'rejected') return 'claim_rejected';
  if (claim.status === 'expired' || now >= claim.expires_at)
    return 'claim_expired';
  return null;
}

function applyWrite(db: SqliteDatabase, op: PairingOp): PairingOpValue {
  if (op.kind === 'pairing.start') {
    if (readSession(db, op.pairing_id) !== null)
      throw new PairingRejection(['pairing_exists']);
    // 有効なペアリングは一つだけ（申請はコードだけで照合の相手を決めるため）。
    db.prepare('UPDATE pairing_sessions SET used = 1 WHERE used = 0').run();
    db.prepare(
      `INSERT INTO pairing_sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      op.pairing_id,
      Buffer.from(op.code_hash, 'hex'),
      op.certificate_fingerprint,
      op.created_at,
      op.expires_at,
      PAIRING_MAX_ATTEMPTS,
    );
    const row = readSession(db, op.pairing_id);
    if (row === null) throw new PairingRejection(['pairing_missing']);
    return toSession(row);
  }
  if (op.kind === 'pairing.claim') {
    if (readClaim(db, op.claim_id) !== null)
      throw new PairingRejection(['claim_exists']);
    const secretInUse = db
      .prepare('SELECT 1 FROM pairing_claims WHERE claim_secret_hash = ?')
      .get(Buffer.from(op.claim_secret_hash, 'hex'));
    if (secretInUse !== undefined)
      throw new PairingRejection(['claim_secret_reused']);
    const session = db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM pairing_sessions ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as SessionRow | undefined;
    // checkPairingCode と同じ順: 使用済み → 期限切れ → 失敗回数の上限 → 不一致（残り回数を減らす）。
    if (session === undefined)
      return { ok: false, reason: 'no_session', attempts_left: 0 };
    const failure = (reason: PairingCodeFailure, attempts = session) => ({
      ok: false as const,
      reason,
      attempts_left: attempts.attempts_left,
    });
    if (session.used === 1) return failure('used');
    // 時計が開始より前へ戻ったときも、期限を確かめられないので期限切れとして扱う。
    if (op.now >= session.expires_at || op.now < session.created_at)
      return failure('expired');
    if (session.attempts_left <= 0) return failure('attempts_exhausted');
    if (!sameHash(session.code_hash, op.code_hash)) {
      db.prepare(
        'UPDATE pairing_sessions SET attempts_left = attempts_left - 1 WHERE pairing_id = ?',
      ).run(session.pairing_id);
      return {
        ok: false,
        reason: 'code_mismatch',
        attempts_left: session.attempts_left - 1,
      };
    }
    db.prepare('UPDATE pairing_sessions SET used = 1 WHERE pairing_id = ?').run(
      session.pairing_id,
    );
    db.prepare(
      "INSERT INTO pairing_claims (claim_id, pairing_id, device_name, platform, claim_secret_hash, status, expires_at, device_id) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)",
    ).run(
      op.claim_id,
      session.pairing_id,
      op.device_name,
      op.platform,
      Buffer.from(op.claim_secret_hash, 'hex'),
      op.claim_expires_at,
    );
    const row = readClaim(db, op.claim_id);
    if (row === null) throw new PairingRejection(['claim_missing']);
    return { ok: true, claim: toClaim(row) };
  }
  if (op.kind === 'pairing.decide') {
    const claim = readClaim(db, op.claim_id);
    if (claim === null) throw new PairingRejection(['claim_not_found']);
    const state = claimStateReasons(claim, op.now, op.certificate_fingerprint);
    if (state !== null) throw new PairingRejection([state]);
    if (claim.status !== 'pending')
      throw new PairingRejection(['claim_not_pending']);
    if (op.require_no_active_devices && countActiveDevices(db) > 0)
      throw new PairingRejection(['devices_registered']);
    db.prepare('UPDATE pairing_claims SET status = ? WHERE claim_id = ?').run(
      op.decision === 'approve' ? 'approved' : 'rejected',
      op.claim_id,
    );
    const row = readClaim(db, op.claim_id);
    if (row === null) throw new PairingRejection(['claim_missing']);
    return toClaim(row);
  }
  if (op.kind === 'pairing.pickup') {
    const claim = readClaim(db, op.claim_id);
    const secret = readClaimSecretHash(db, op.claim_id);
    if (claim === null || secret === null)
      throw new PairingRejection(['claim_not_found']);
    if (!sameHash(secret, op.claim_secret_hash))
      throw new PairingRejection(['claim_secret_mismatch']);
    const state = claimStateReasons(claim, op.now, op.certificate_fingerprint);
    if (state !== null) throw new PairingRejection([state]);
    if (claim.status !== 'approved')
      throw new PairingRejection(['claim_not_approved']);
    if (readDevice(db, op.device_id) !== null)
      throw new PairingRejection(['device_exists']);
    db.prepare(
      'INSERT INTO devices (device_id, device_name, platform, hub_local, token_hash, registered_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
    ).run(
      op.device_id,
      claim.device_name,
      claim.platform,
      op.hub_local ? 1 : 0,
      Buffer.from(op.token_hash, 'hex'),
      op.now,
    );
    db.prepare(
      "UPDATE pairing_claims SET status = 'consumed', device_id = ? WHERE claim_id = ?",
    ).run(op.device_id, op.claim_id);
    const row = readDevice(db, op.device_id);
    if (row === null) throw new PairingRejection(['device_missing']);
    return toDevice(row);
  }
  if (op.kind === 'devices.revoke_certificate_mismatch') {
    const rows = db
      .prepare(
        'SELECT DISTINCT d.device_id FROM devices d JOIN pairing_claims c ON c.device_id = d.device_id JOIN pairing_sessions s ON s.pairing_id = c.pairing_id WHERE d.revoked_at IS NULL AND s.certificate_fingerprint <> ? ORDER BY d.device_id',
      )
      .all(op.certificate_fingerprint) as { device_id: string }[];
    const revokeDevice = db.prepare(
      'UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
    );
    const revokeScopes = db.prepare(
      'UPDATE command_scopes SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
    );
    for (const row of rows) {
      revokeDevice.run(op.revoked_at, row.device_id);
      revokeScopes.run(op.revoked_at, row.device_id);
    }
    return { revoked_device_ids: rows.map((row) => row.device_id) };
  }
  throw new PairingRejection(['kind_invalid']);
}

function applyRead(db: SqliteDatabase, op: PairingOp): PairingOpValue {
  switch (op.kind) {
    case 'pairing.find_claim': {
      const row = readClaim(db, op.claim_id);
      return row === null ? null : toClaim(row);
    }
    case 'pairing.find_session_claim': {
      const row = db
        .prepare(
          `${CLAIM_SELECT} WHERE c.pairing_id = ? ORDER BY c.rowid DESC LIMIT 1`,
        )
        .get(op.pairing_id) as ClaimRow | undefined;
      return row === undefined ? null : toClaim(row);
    }
    case 'pairing.find_session': {
      const row = readSession(db, op.pairing_id);
      return row === null ? null : toSession(row);
    }
    case 'pairing.claim_secret_matches': {
      const secret = readClaimSecretHash(db, op.claim_id);
      return {
        matches: secret !== null && sameHash(secret, op.claim_secret_hash),
      };
    }
    case 'devices.list': {
      const rows = db
        .prepare(
          `SELECT ${DEVICE_COLUMNS} FROM devices ORDER BY registered_at, device_id`,
        )
        .all() as DeviceRow[];
      return rows.map(toDevice);
    }
    case 'devices.find': {
      const row = readDevice(db, op.device_id);
      return row === null ? null : toDevice(row);
    }
    case 'devices.count_active':
      return { count: countActiveDevices(db) };
    default:
      throw new PairingRejection(['kind_invalid']);
  }
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

const rejected = (reasons: readonly string[]): PairingOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

// ペアリング・端末の一覧の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executePairingOp(
  db: SqliteDatabase,
  op: PairingOp,
  context: { readonly platform: StoragePlatform; readonly halted: boolean },
): PairingStoreResult {
  const shape = pairingOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (!PAIRING_WRITE_OPS.has(op.kind))
    return { result: { ok: true, value: applyRead(db, op) }, halt: false };
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
    if (error instanceof PairingRejection)
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
