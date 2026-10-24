// 音声の世代（epoch）・入出力の停止・Live の制御の状態の保存（B05-03、ADR 0046。設計 07 §5、10 §1A・§2A、ADR 0005・0038）。
//
// DB worker の中で実行する同期関数。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で行い、transaction の前に
// 接続の耐久設定を読み戻す（home-network-store.ts と同じ）。
// - 世代は先頭ゼロのない非負整数の 10 進文字列で受け渡す（07 §1）。DB では INTEGER（Number.MAX_SAFE_INTEGER まで）。
// - 次の世代の値は Core が domain の規則（issueLiveEpochs・nextLiveControl）で決めて渡し、ここでは今の値との一致を
//   確かめてから書く（compare-and-set）。戻す・消す更新は 0009 の trigger が拒否する。
// - 停止は中枢が io_epoch・output_epoch を 1 つ進める（ADR 0046・U70）。再開は版（expected_io_epoch）の一致を確かめて
//   停止の印を外す（世代は進めない）。
// 結果の理由にはコードだけを入れ、SQL・パスを入れない。

import Database from 'better-sqlite3';
import { writeConnectionReasons } from './connection.js';
import type { SqliteDatabase, StoragePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EPOCH = /^(?:0|[1-9][0-9]*)$/u;

export type VoiceStopScope = 'local' | 'guest' | 'global';
export type LiveControlStateValue =
  'connecting' | 'ready' | 'lost' | 'closing' | 'closed';
export type LiveClosureValue =
  'open' | 'close_requested' | 'close_confirmed' | 'close_unconfirmed';

export interface DeviceVoiceState {
  readonly device_id: string;
  readonly io_epoch: string;
  readonly output_epoch: string;
  readonly audio_epoch: string;
  readonly session_epoch: string;
  readonly local_stop: boolean;
  readonly guest_mode: boolean;
  readonly global_stop: boolean;
  // 登録済みで失効していない端末か。
  readonly active: boolean;
}

export interface LiveSessionRecord {
  readonly live_session_id: string;
  readonly device_id: string;
  readonly session_id: string | null;
  readonly purpose: 'conversation' | 'notification';
  readonly control_state: LiveControlStateValue;
  readonly control_epoch: string;
  readonly closure: LiveClosureValue;
  readonly usage_seconds: number | null;
  readonly reservation_id: string;
  readonly audio_epoch: string;
  readonly session_epoch: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly end_reason: string | null;
}

export interface LiveEpochPair {
  readonly audio_epoch: string;
  readonly session_epoch: string;
}

export interface LiveControlValues {
  readonly control_state: LiveControlStateValue;
  readonly control_epoch: string;
  readonly closure: LiveClosureValue;
  readonly usage_seconds: number | null;
}

export type VoiceOp =
  | { readonly kind: 'voice.device_state'; readonly device_id: string }
  // 登録済みで失効していない端末の状態（来客モード・全体停止の対象）。
  | { readonly kind: 'voice.active_devices' }
  // 停止。local は要求した端末、guest・global は失効していない全端末の io_epoch・output_epoch を 1 つ進める。
  | {
      readonly kind: 'voice.stop';
      readonly scope: VoiceStopScope;
      readonly device_id: string;
      readonly now: number;
    }
  // 再開。要求した端末の io_epoch が expected_io_epoch と一致するときだけ、その範囲の停止の印を外す。
  | {
      readonly kind: 'voice.resume';
      readonly scope: VoiceStopScope;
      readonly device_id: string;
      readonly expected_io_epoch: string;
      readonly now: number;
    }
  // Live の接続の記録。端末の audio・session の epoch が expected のときだけ next にし、同じ transaction で挿入する。
  | {
      readonly kind: 'voice.live_open';
      readonly live_session_id: string;
      readonly device_id: string;
      readonly session_id: string | null;
      readonly purpose: 'conversation' | 'notification';
      readonly reservation_id: string;
      readonly expected: LiveEpochPair;
      readonly next: LiveEpochPair;
      readonly started_at: number;
    }
  // 制御の状態の更新。今の値が expected と一致するときだけ next にする。
  | {
      readonly kind: 'voice.live_update';
      readonly live_session_id: string;
      readonly expected: LiveControlValues;
      readonly next: LiveControlValues;
      readonly ended_at: number | null;
      readonly end_reason: string | null;
    }
  | { readonly kind: 'voice.live_get'; readonly live_session_id: string }
  // 閉じ終えていない（closed でない）接続。再起動の照合で使う。
  | { readonly kind: 'voice.live_unfinished' }
  // 閉じ終えたが使用量を確認できていない（closure が close_unconfirmed）接続。終了後の照合で使う（B05-04）。
  | { readonly kind: 'voice.live_held' };

export type VoiceOpKind = VoiceOp['kind'];

export interface VoiceStopValue {
  readonly scope: VoiceStopScope;
  // 停止の対象になった端末の、停止の後の状態（要求した端末を含む）。
  readonly devices: readonly DeviceVoiceState[];
}

export interface VoiceOpValues {
  'voice.device_state': DeviceVoiceState | null;
  'voice.active_devices': readonly DeviceVoiceState[];
  'voice.stop': VoiceStopValue;
  'voice.resume': DeviceVoiceState;
  'voice.live_open': LiveSessionRecord;
  'voice.live_update': LiveSessionRecord;
  'voice.live_get': LiveSessionRecord | null;
  'voice.live_unfinished': readonly LiveSessionRecord[];
  'voice.live_held': readonly LiveSessionRecord[];
}

export type VoiceOpValue = VoiceOpValues[VoiceOpKind];

export type VoiceOpResult =
  | { readonly ok: true; readonly value: VoiceOpValue }
  | {
      readonly ok: false;
      // rejected: 書いていないことが確か。unknown: COMMIT の失敗で成否不明。
      readonly outcome: 'rejected' | 'unknown';
      readonly reasons: readonly string[];
    };

export interface VoiceStoreResult {
  readonly result: VoiceOpResult;
  readonly halt: boolean;
}

export const VOICE_WRITE_OPS: ReadonlySet<VoiceOpKind> = new Set([
  'voice.stop',
  'voice.resume',
  'voice.live_open',
  'voice.live_update',
]);

class VoiceRejection extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(', '));
    this.name = 'VoiceRejection';
    this.reasons = reasons;
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isEpoch = (value: unknown): value is string =>
  typeof value === 'string' &&
  EPOCH.test(value) &&
  Number.isSafeInteger(Number(value));
const SCOPES: readonly string[] = ['local', 'guest', 'global'];
const STATES: readonly string[] = [
  'connecting',
  'ready',
  'lost',
  'closing',
  'closed',
];
const CLOSURES: readonly string[] = [
  'open',
  'close_requested',
  'close_confirmed',
  'close_unconfirmed',
];

function controlReasons(value: LiveControlValues, name: string): string[] {
  const reasons: string[] = [];
  if (typeof value !== 'object' || value === null) return [`${name}_invalid`];
  if (!STATES.includes(value.control_state)) reasons.push(`${name}_invalid`);
  if (!isEpoch(value.control_epoch)) reasons.push(`${name}_invalid`);
  if (!CLOSURES.includes(value.closure)) reasons.push(`${name}_invalid`);
  if (
    value.usage_seconds !== null &&
    !(Number.isSafeInteger(value.usage_seconds) && value.usage_seconds >= 0)
  )
    reasons.push(`${name}_invalid`);
  return [...new Set(reasons)];
}

// 形の検査。structured clone を通った値を信用せず、DB に書く前に確かめる。
export function voiceOpShapeReasons(op: VoiceOp): string[] {
  const reasons: string[] = [];
  const id = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !UUID.test(value))
      reasons.push(`${name}_invalid`);
  };
  const pair = (value: LiveEpochPair, name: string) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !isEpoch(value.audio_epoch) ||
      !isEpoch(value.session_epoch)
    )
      reasons.push(`${name}_invalid`);
  };
  switch (op.kind) {
    case 'voice.device_state':
      id(op.device_id, 'device_id');
      break;
    case 'voice.active_devices':
    case 'voice.live_unfinished':
    case 'voice.live_held':
      break;
    case 'voice.stop':
      if (!SCOPES.includes(op.scope)) reasons.push('scope_invalid');
      id(op.device_id, 'device_id');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'voice.resume':
      if (!SCOPES.includes(op.scope)) reasons.push('scope_invalid');
      id(op.device_id, 'device_id');
      if (!isEpoch(op.expected_io_epoch))
        reasons.push('expected_io_epoch_invalid');
      if (!isTime(op.now)) reasons.push('now_invalid');
      break;
    case 'voice.live_open':
      id(op.live_session_id, 'live_session_id');
      id(op.device_id, 'device_id');
      if (op.session_id !== null) id(op.session_id, 'session_id');
      if (op.purpose !== 'conversation' && op.purpose !== 'notification')
        reasons.push('purpose_invalid');
      id(op.reservation_id, 'reservation_id');
      pair(op.expected, 'expected');
      pair(op.next, 'next');
      if (!isTime(op.started_at)) reasons.push('started_at_invalid');
      break;
    case 'voice.live_update':
      id(op.live_session_id, 'live_session_id');
      reasons.push(...controlReasons(op.expected, 'expected'));
      reasons.push(...controlReasons(op.next, 'next'));
      if (op.ended_at !== null && !isTime(op.ended_at))
        reasons.push('ended_at_invalid');
      if (
        op.end_reason !== null &&
        (typeof op.end_reason !== 'string' ||
          !/^[a-z_]{1,64}$/u.test(op.end_reason))
      )
        reasons.push('end_reason_invalid');
      break;
    case 'voice.live_get':
      id(op.live_session_id, 'live_session_id');
      break;
    default:
      reasons.push('kind_invalid');
  }
  return reasons;
}

interface DeviceRow {
  device_id: string;
  revoked_at: number | null;
  io_epoch: number | null;
  output_epoch: number | null;
  audio_epoch: number | null;
  session_epoch: number | null;
  local_stop: number | null;
}

interface StopRow {
  guest_mode: number;
  global_stop: number;
}

interface LiveRow {
  live_session_id: string;
  device_id: string;
  session_id: string | null;
  purpose: 'conversation' | 'notification';
  control_state: LiveControlStateValue;
  control_epoch: number;
  closure: LiveClosureValue;
  usage_seconds: number | null;
  reservation_id: string;
  audio_epoch: number;
  session_epoch: number;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

const DEVICE_SELECT = `SELECT d.device_id AS device_id, d.revoked_at AS revoked_at, e.io_epoch AS io_epoch,
  e.output_epoch AS output_epoch, e.audio_epoch AS audio_epoch, e.session_epoch AS session_epoch, e.local_stop AS local_stop
  FROM devices d LEFT JOIN device_epochs e ON e.device_id = d.device_id`;

function readStop(db: SqliteDatabase): StopRow {
  const row = db
    .prepare(
      'SELECT guest_mode, global_stop FROM io_stop_state WHERE stop_id = 1',
    )
    .get() as StopRow | undefined;
  // 0009 が 1 行を作り、消す trigger がある。なければ安全側（止めている）にする。
  return row ?? { guest_mode: 1, global_stop: 1 };
}

function toDevice(row: DeviceRow, stop: StopRow): DeviceVoiceState {
  return {
    device_id: row.device_id,
    io_epoch: String(row.io_epoch ?? 0),
    output_epoch: String(row.output_epoch ?? 0),
    audio_epoch: String(row.audio_epoch ?? 0),
    session_epoch: String(row.session_epoch ?? 0),
    local_stop: row.local_stop === 1,
    guest_mode: stop.guest_mode === 1,
    global_stop: stop.global_stop === 1,
    active: row.revoked_at === null,
  };
}

function readDevice(
  db: SqliteDatabase,
  deviceId: string,
): DeviceVoiceState | null {
  const row = db
    .prepare(`${DEVICE_SELECT} WHERE d.device_id = ?`)
    .get(deviceId) as DeviceRow | undefined;
  return row === undefined ? null : toDevice(row, readStop(db));
}

function readActiveDevices(db: SqliteDatabase): DeviceVoiceState[] {
  const stop = readStop(db);
  return (
    db
      .prepare(
        `${DEVICE_SELECT} WHERE d.revoked_at IS NULL ORDER BY d.device_id`,
      )
      .all() as DeviceRow[]
  ).map((row) => toDevice(row, stop));
}

function toLive(row: LiveRow): LiveSessionRecord {
  return {
    live_session_id: row.live_session_id,
    device_id: row.device_id,
    session_id: row.session_id,
    purpose: row.purpose,
    control_state: row.control_state,
    control_epoch: String(row.control_epoch),
    closure: row.closure,
    usage_seconds: row.usage_seconds,
    reservation_id: row.reservation_id,
    audio_epoch: String(row.audio_epoch),
    session_epoch: String(row.session_epoch),
    started_at: row.started_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason,
  };
}

const LIVE_SELECT = `SELECT live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure,
  usage_seconds, reservation_id, audio_epoch, session_epoch, started_at, ended_at, end_reason FROM live_sessions`;

function readLive(
  db: SqliteDatabase,
  liveSessionId: string,
): LiveSessionRecord | null {
  const row = db
    .prepare(`${LIVE_SELECT} WHERE live_session_id = ?`)
    .get(liveSessionId) as LiveRow | undefined;
  return row === undefined ? null : toLive(row);
}

// 登録済みで失効していない端末か。そうでなければ書かない。
function requireActiveDevice(db: SqliteDatabase, deviceId: string): void {
  const row = db
    .prepare('SELECT revoked_at FROM devices WHERE device_id = ?')
    .get(deviceId) as { revoked_at: number | null } | undefined;
  if (row === undefined) throw new VoiceRejection(['device_not_found']);
  if (row.revoked_at !== null) throw new VoiceRejection(['device_revoked']);
}

function ensureEpochRow(db: SqliteDatabase, deviceId: string, now: number) {
  db.prepare(
    'INSERT INTO device_epochs (device_id, updated_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM device_epochs WHERE device_id = ?)',
  ).run(deviceId, now, deviceId);
}

function applyWrite(db: SqliteDatabase, op: VoiceOp): VoiceOpValue {
  if (op.kind === 'voice.stop') {
    requireActiveDevice(db, op.device_id);
    const targets =
      op.scope === 'local'
        ? [op.device_id]
        : readActiveDevices(db).map((device) => device.device_id);
    for (const deviceId of targets) {
      ensureEpochRow(db, deviceId, op.now);
      db.prepare(
        `UPDATE device_epochs SET io_epoch = io_epoch + 1, output_epoch = output_epoch + 1,
           local_stop = CASE WHEN ? THEN 1 ELSE local_stop END, updated_at = ? WHERE device_id = ?`,
      ).run(op.scope === 'local' ? 1 : 0, op.now, deviceId);
    }
    if (op.scope !== 'local')
      db.prepare(
        `UPDATE io_stop_state SET guest_mode = CASE WHEN ? THEN 1 ELSE guest_mode END,
           global_stop = CASE WHEN ? THEN 1 ELSE global_stop END, updated_at = ? WHERE stop_id = 1`,
      ).run(
        op.scope === 'guest' ? 1 : 0,
        op.scope === 'global' ? 1 : 0,
        op.now,
      );
    return {
      scope: op.scope,
      devices: targets.map((deviceId) => {
        const state = readDevice(db, deviceId);
        if (state === null) throw new VoiceRejection(['device_not_found']);
        return state;
      }),
    };
  }
  if (op.kind === 'voice.resume') {
    requireActiveDevice(db, op.device_id);
    ensureEpochRow(db, op.device_id, op.now);
    const current = readDevice(db, op.device_id);
    if (current === null) throw new VoiceRejection(['device_not_found']);
    if (current.io_epoch !== op.expected_io_epoch)
      throw new VoiceRejection(['io_epoch_mismatch']);
    if (op.scope === 'local')
      db.prepare(
        'UPDATE device_epochs SET local_stop = 0, updated_at = ? WHERE device_id = ?',
      ).run(op.now, op.device_id);
    else
      db.prepare(
        `UPDATE io_stop_state SET guest_mode = CASE WHEN ? THEN 0 ELSE guest_mode END,
           global_stop = CASE WHEN ? THEN 0 ELSE global_stop END, updated_at = ? WHERE stop_id = 1`,
      ).run(
        op.scope === 'guest' ? 1 : 0,
        op.scope === 'global' ? 1 : 0,
        op.now,
      );
    const after = readDevice(db, op.device_id);
    if (after === null) throw new VoiceRejection(['device_not_found']);
    return after;
  }
  if (op.kind === 'voice.live_open') {
    requireActiveDevice(db, op.device_id);
    ensureEpochRow(db, op.device_id, op.started_at);
    const changed = db
      .prepare(
        `UPDATE device_epochs SET audio_epoch = ?, session_epoch = ?, updated_at = ?
           WHERE device_id = ? AND audio_epoch = ? AND session_epoch = ?`,
      )
      .run(
        Number(op.next.audio_epoch),
        Number(op.next.session_epoch),
        op.started_at,
        op.device_id,
        Number(op.expected.audio_epoch),
        Number(op.expected.session_epoch),
      ).changes;
    if (changed !== 1) throw new VoiceRejection(['epoch_conflict']);
    db.prepare(
      `INSERT INTO live_sessions (live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure,
         usage_seconds, reservation_id, started_at, ended_at, end_reason, audio_epoch, session_epoch)
       VALUES (?, ?, ?, ?, 'connecting', 0, 'open', NULL, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      op.live_session_id,
      op.device_id,
      op.session_id,
      op.purpose,
      op.reservation_id,
      op.started_at,
      Number(op.next.audio_epoch),
      Number(op.next.session_epoch),
    );
    const row = readLive(db, op.live_session_id);
    if (row === null) throw new VoiceRejection(['live_session_missing']);
    return row;
  }
  if (op.kind === 'voice.live_update') {
    const changed = db
      .prepare(
        `UPDATE live_sessions SET control_state = ?, control_epoch = ?, closure = ?, usage_seconds = ?,
           ended_at = coalesce(ended_at, ?), end_reason = coalesce(end_reason, ?)
         WHERE live_session_id = ? AND control_state = ? AND control_epoch = ? AND closure = ? AND usage_seconds IS ?`,
      )
      .run(
        op.next.control_state,
        Number(op.next.control_epoch),
        op.next.closure,
        op.next.usage_seconds,
        op.ended_at,
        op.end_reason,
        op.live_session_id,
        op.expected.control_state,
        Number(op.expected.control_epoch),
        op.expected.closure,
        op.expected.usage_seconds,
      ).changes;
    if (changed !== 1)
      throw new VoiceRejection([
        readLive(db, op.live_session_id) === null
          ? 'live_session_not_found'
          : 'live_state_conflict',
      ]);
    const row = readLive(db, op.live_session_id);
    if (row === null) throw new VoiceRejection(['live_session_not_found']);
    return row;
  }
  throw new VoiceRejection(['kind_invalid']);
}

function sqliteCode(error: unknown): string | null {
  return error instanceof Database.SqliteError ? error.code : null;
}

// trigger の RAISE の理由（0009 で決めたコードだけ）。
const TRIGGER_REASONS: readonly string[] = [
  'device_epoch_regressed',
  'device_epochs_permanent',
  'io_stop_state_permanent',
  'live_session_issued_fixed',
  'live_control_epoch_regressed',
  'live_control_state_regressed',
  'live_close_confirmed_final',
];

const rejected = (reasons: readonly string[]): VoiceOpResult => ({
  ok: false,
  outcome: 'rejected',
  reasons,
});

// 音声の命令と照会を 1 件処理する。DB worker の中から呼ぶ。
export function executeVoiceOp(
  db: SqliteDatabase,
  op: VoiceOp,
  context: {
    readonly platform: StoragePlatform;
    readonly halted: boolean;
    readonly beforeCommit?: (op: VoiceOp) => void;
  },
): VoiceStoreResult {
  const shape = voiceOpShapeReasons(op);
  if (shape.length > 0) return { result: rejected(shape), halt: false };
  if (op.kind === 'voice.device_state')
    return {
      result: { ok: true, value: readDevice(db, op.device_id) },
      halt: false,
    };
  if (op.kind === 'voice.active_devices')
    return { result: { ok: true, value: readActiveDevices(db) }, halt: false };
  if (op.kind === 'voice.live_get')
    return {
      result: { ok: true, value: readLive(db, op.live_session_id) },
      halt: false,
    };
  if (op.kind === 'voice.live_unfinished')
    return {
      result: {
        ok: true,
        value: (
          db
            .prepare(
              `${LIVE_SELECT} WHERE control_state <> 'closed' ORDER BY started_at, live_session_id`,
            )
            .all() as LiveRow[]
        ).map(toLive),
      },
      halt: false,
    };
  if (op.kind === 'voice.live_held')
    return {
      result: {
        ok: true,
        value: (
          db
            .prepare(
              `${LIVE_SELECT} WHERE closure = 'close_unconfirmed' ORDER BY started_at, live_session_id`,
            )
            .all() as LiveRow[]
        ).map(toLive),
      },
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
    const run = runImmediate(
      db,
      () => applyWrite(db, op),
      context.beforeCommit === undefined
        ? undefined
        : () => context.beforeCommit?.(op),
    );
    return { result: { ok: true, value: run.value }, halt: false };
  } catch (error) {
    if (error instanceof VoiceRejection)
      return { result: rejected(error.reasons), halt: false };
    if (error instanceof Error && error.name === 'CommitUncertain')
      return {
        result: { ok: false, outcome: 'unknown', reasons: ['commit_failed'] },
        halt: true,
      };
    const code = sqliteCode(error);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
      return { result: rejected(['database_busy']), halt: false };
    if (code?.startsWith('SQLITE_CONSTRAINT')) {
      const message = error instanceof Error ? error.message : '';
      const trigger = TRIGGER_REASONS.find((reason) => message === reason);
      return {
        result: rejected([trigger ?? 'constraint_violation']),
        halt: false,
      };
    }
    return {
      result: rejected([
        code === 'SQLITE_FULL' ? 'database_full' : 'transaction_failed',
      ]),
      halt: true,
    };
  }
}
