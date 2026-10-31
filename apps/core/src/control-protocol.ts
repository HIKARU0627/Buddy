// ローカル制御チャネルの要求と応答（ADR 0012）。
// 改行区切りの JSON で、1 接続につき 1 要求。状態の確認と停止、最初の端末のペアリングの開始と承認
// （ADR 0021）、端末の一覧と失効（中枢の画面が使えないときの保守の手段。ADR 0021 の追記）を扱う。
// 承認の命令（2 台目以降の申請の承認）は置かない。本文・秘密は載せない。最初の端末の開始の応答だけは、
// CLI の画面に出すワンタイムコード（有効 5 分・1 回だけ）を載せる。端末の一覧はトークン・その hash・
// 証明書の指紋を含めない。予算月の状態と、本人が見た値を明示する確かめ直し（ADR 0037）も扱う（金額は載せない）。
// スキーマ検証ライブラリを Core に入れないため、許可する形を手で厳格に検査する。

import {
  StrictJsonError,
  UUID_PATTERN,
  isJsonObject,
  parseStrictJson,
} from './strict-json.js';
import type { LifecycleState } from './lifecycle.js';

// 1 行（改行を除く）の上限。超えた時点で読み取りをやめて拒否する。
export const MAX_CONTROL_LINE_BYTES = 4096;
export const CONTROL_OPS = [
  'status',
  'stop',
  'pairing_first_start',
  'pairing_first_approve',
  'device_list',
  'device_revoke',
  // 予算月の状態と、本人による確かめ直し（B07-04、ADR 0037）。
  'budget_calendar_status',
  'budget_calendar_confirm',
  // バックアップの状態・実行と、復旧キーの設定の Core 側（ADR 0055）。復旧キーは通さない。
  'backup_status',
  'backup_run',
  'backup_setup_inspect',
  'backup_setup_record',
] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export type ControlRequest =
  | { readonly op: 'status' | 'stop'; readonly request_id: string }
  | { readonly op: 'pairing_first_start'; readonly request_id: string }
  | {
      readonly op: 'pairing_first_approve';
      readonly request_id: string;
      readonly pairing_id: string;
    }
  | { readonly op: 'device_list'; readonly request_id: string }
  | {
      readonly op: 'device_revoke';
      readonly request_id: string;
      readonly device_id: string;
    }
  | { readonly op: 'budget_calendar_status'; readonly request_id: string }
  | {
      readonly op: 'backup_status' | 'backup_run' | 'backup_setup_inspect';
      readonly request_id: string;
    }
  // CLI が書いた包み（backup-keys.json）の台帳の鍵の ID。Core は包みと KeyStore を確かめてから DB に記録する。
  | {
      readonly op: 'backup_setup_record';
      readonly request_id: string;
      readonly ledger_hmac_key_id: string;
    }
  // 本人が見た理由・月・始まり（RFC 3339 の UTC）と、そのときの状態の版・時計（status の confirmation_revision・
  // checked_at）。今の状態と一致するときだけ Core が記録する。
  | {
      readonly op: 'budget_calendar_confirm';
      readonly request_id: string;
      readonly reason: 'clock_regressed' | 'calendar_mismatch';
      readonly month: string;
      readonly month_start: string;
      readonly revision: string;
      readonly observed_at: string;
    };

export type ControlRejectReason =
  | 'too_large'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'duplicate_key'
  | 'not_object'
  | 'unknown_field'
  | 'missing_field'
  | 'invalid_type'
  | 'unknown_op'
  | 'invalid_request_id'
  | 'invalid_pairing_id'
  | 'invalid_device_id'
  | 'invalid_reason'
  | 'invalid_month'
  | 'invalid_month_start'
  | 'invalid_revision'
  | 'invalid_observed_at'
  | 'invalid_key_id';

export type ControlParseResult =
  | { readonly ok: true; readonly request: ControlRequest }
  | { readonly ok: false; readonly reason: ControlRejectReason };

export interface ControlStatus {
  readonly state: LifecycleState;
  readonly core_instance_id: string;
  readonly store_generation: string;
  readonly started_at: string;
  readonly uptime_ms: number;
  readonly pid: number;
}

// 最初の端末の開始・承認の応答（ADR 0021）。
export type ControlFirstDeviceResult =
  | {
      readonly pairing_id: string;
      readonly pairing_code: string;
      readonly certificate_fingerprint: string;
      readonly expires_at: string;
    }
  | {
      readonly claim_id: string;
      readonly status: 'approved';
      readonly device_name: string;
      readonly platform: string;
      readonly expires_at: string;
    };

// 端末の一覧・失効の応答の 1 台分（ADR 0021 の追記）。トークン・その hash・証明書の指紋は含めない。
export interface ControlDevice {
  readonly device_id: string;
  readonly device_name: string;
  readonly hub_local: boolean;
  readonly registered_at: string;
  readonly last_seen_at: string | null;
  // 失効していなければ null。
  readonly revoked_at: string | null;
}

// 予算月の状態（B07-04、ADR 0037）。本人が確かめ直す前に CLI に出す値。金額を含めない。
export interface ControlBudgetCalendar {
  // 実行時の設定の検査に通っているか。
  readonly configured: boolean;
  readonly configured_time_zone: string | null;
  // 今の月（確かめ直しを重ねたもの）。記録がなければ null。
  readonly month: string | null;
  readonly time_zone: string | null;
  readonly month_start: string | null;
  readonly month_start_time_zone: string | null;
  // 予算月の記録の始まりと、tz データで求め直した始まり。
  readonly recorded_month_start: string | null;
  readonly recomputed_month_start: string | null;
  // 時計の戻りを受け入れた下限。
  readonly regression_floor: string | null;
  // 確かめ直しの版。確かめ直しの要求に revision として渡す。
  readonly confirmation_revision: string | null;
  // 受付を止めている理由（clock_regressed・invalid_calendar_state など）。空なら止めていない。
  readonly hold_reasons: readonly string[];
  readonly checked_at: string;
}

export type ControlResponse =
  | ({ readonly ok: true; readonly request_id: string } & ControlStatus)
  | {
      readonly ok: true;
      readonly request_id: string;
      readonly budget_calendar: ControlBudgetCalendar;
    }
  | {
      readonly ok: true;
      readonly request_id: string;
      readonly devices: readonly ControlDevice[];
    }
  // バックアップの状態・実行・設定の応答（ID・件数・理由コードだけ。鍵・パス・本文は載せない）。
  | {
      readonly ok: true;
      readonly request_id: string;
      readonly backup: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: true;
      readonly request_id: string;
      readonly device: ControlDevice;
    }
  | ({
      readonly ok: true;
      readonly request_id: string;
    } & ControlFirstDeviceResult)
  | {
      readonly ok: false;
      readonly error: 'invalid_request' | 'unavailable';
      readonly reason?: ControlRejectReason;
    }
  // 最初の端末・端末の失効の命令の拒否（有効な端末がある・HTTPS がない・申請がない・端末がないなど）。
  | { readonly ok: false; readonly error: 'refused'; readonly reason: string };

const decoder = new TextDecoder('utf-8', { fatal: true });
const ALLOWED_FIELDS: readonly string[] = ['op', 'request_id'];
// pairing_first_approve だけが pairing_id を、device_revoke だけが device_id を持つ。
const APPROVE_FIELDS: readonly string[] = ['op', 'request_id', 'pairing_id'];
const REVOKE_FIELDS: readonly string[] = ['op', 'request_id', 'device_id'];
// budget_calendar_confirm だけが理由・月・始まり・版・見た時刻を持つ。
const CONFIRM_FIELDS: readonly string[] = [
  'op',
  'request_id',
  'reason',
  'month',
  'month_start',
  'revision',
  'observed_at',
];
// 鍵の ID（契約の BackupKeyWrap.key_id と同じ文字種）。
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const RECORD_FIELDS: readonly string[] = [
  'op',
  'request_id',
  'ledger_hmac_key_id',
];
const REVISION = /^(0|[1-9][0-9]{0,14})$/u;
const YEAR_MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/u;
const UTC_MILLIS =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

// UTC の RFC 3339（ミリ秒 3 桁）で、暦にある時刻か（Date が別の時刻へずらさない）。
function isUtcMillis(value: string): boolean {
  if (!UTC_MILLIS.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

// 改行を除いた 1 行のバイト列を検査する。
export function parseControlRequest(line: Uint8Array): ControlParseResult {
  if (line.byteLength > MAX_CONTROL_LINE_BYTES)
    return { ok: false, reason: 'too_large' };
  let text: string;
  try {
    text = decoder.decode(line);
  } catch {
    return { ok: false, reason: 'invalid_utf8' };
  }
  let value;
  try {
    value = parseStrictJson(text, 4);
  } catch (error) {
    if (error instanceof StrictJsonError && error.code === 'duplicate_key')
      return { ok: false, reason: 'duplicate_key' };
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isJsonObject(value)) return { ok: false, reason: 'not_object' };
  const allowed =
    value['op'] === 'pairing_first_approve'
      ? APPROVE_FIELDS
      : value['op'] === 'device_revoke'
        ? REVOKE_FIELDS
        : value['op'] === 'budget_calendar_confirm'
          ? CONFIRM_FIELDS
          : value['op'] === 'backup_setup_record'
            ? RECORD_FIELDS
            : ALLOWED_FIELDS;
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) return { ok: false, reason: 'unknown_field' };
  const op = value['op'];
  const requestId = value['request_id'];
  if (op === undefined || requestId === undefined)
    return { ok: false, reason: 'missing_field' };
  if (typeof op !== 'string' || typeof requestId !== 'string')
    return { ok: false, reason: 'invalid_type' };
  if (!(CONTROL_OPS as readonly string[]).includes(op))
    return { ok: false, reason: 'unknown_op' };
  if (!UUID_PATTERN.test(requestId))
    return { ok: false, reason: 'invalid_request_id' };
  if (op === 'pairing_first_approve') {
    const pairingId = value['pairing_id'];
    if (pairingId === undefined) return { ok: false, reason: 'missing_field' };
    if (typeof pairingId !== 'string')
      return { ok: false, reason: 'invalid_type' };
    if (!UUID_PATTERN.test(pairingId))
      return { ok: false, reason: 'invalid_pairing_id' };
    return {
      ok: true,
      request: { op, request_id: requestId, pairing_id: pairingId },
    };
  }
  if (op === 'device_revoke') {
    const deviceId = value['device_id'];
    if (deviceId === undefined) return { ok: false, reason: 'missing_field' };
    if (typeof deviceId !== 'string')
      return { ok: false, reason: 'invalid_type' };
    if (!UUID_PATTERN.test(deviceId))
      return { ok: false, reason: 'invalid_device_id' };
    return {
      ok: true,
      request: { op, request_id: requestId, device_id: deviceId },
    };
  }
  if (op === 'backup_setup_record') {
    const keyId = value['ledger_hmac_key_id'];
    if (keyId === undefined) return { ok: false, reason: 'missing_field' };
    if (typeof keyId !== 'string') return { ok: false, reason: 'invalid_type' };
    if (!KEY_ID.test(keyId)) return { ok: false, reason: 'invalid_key_id' };
    return {
      ok: true,
      request: { op, request_id: requestId, ledger_hmac_key_id: keyId },
    };
  }
  if (op === 'budget_calendar_confirm') {
    const reason = value['reason'];
    const month = value['month'];
    const monthStart = value['month_start'];
    const revision = value['revision'];
    const observedAt = value['observed_at'];
    if (
      reason === undefined ||
      month === undefined ||
      monthStart === undefined ||
      revision === undefined ||
      observedAt === undefined
    )
      return { ok: false, reason: 'missing_field' };
    if (
      typeof reason !== 'string' ||
      typeof month !== 'string' ||
      typeof monthStart !== 'string' ||
      typeof revision !== 'string' ||
      typeof observedAt !== 'string'
    )
      return { ok: false, reason: 'invalid_type' };
    if (reason !== 'clock_regressed' && reason !== 'calendar_mismatch')
      return { ok: false, reason: 'invalid_reason' };
    if (!YEAR_MONTH.test(month)) return { ok: false, reason: 'invalid_month' };
    if (!isUtcMillis(monthStart))
      return { ok: false, reason: 'invalid_month_start' };
    if (!REVISION.test(revision))
      return { ok: false, reason: 'invalid_revision' };
    if (!isUtcMillis(observedAt))
      return { ok: false, reason: 'invalid_observed_at' };
    return {
      ok: true,
      request: {
        op,
        request_id: requestId,
        reason,
        month,
        month_start: monthStart,
        revision,
        observed_at: observedAt,
      },
    };
  }
  return {
    ok: true,
    request:
      op === 'pairing_first_start' ||
      op === 'device_list' ||
      op === 'budget_calendar_status' ||
      op === 'backup_status' ||
      op === 'backup_run' ||
      op === 'backup_setup_inspect'
        ? { op, request_id: requestId }
        : { op: op as 'status' | 'stop', request_id: requestId },
  };
}

export function encodeControlMessage(message: object): string {
  return `${JSON.stringify(message)}\n`;
}
