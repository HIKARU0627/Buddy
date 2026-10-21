// ローカル制御チャネルの要求と応答（ADR 0012）。
// 改行区切りの JSON で、1 接続につき 1 要求。状態の確認と停止、最初の端末のペアリングの開始と承認
// （ADR 0021）を扱う。本文・秘密は載せない。最初の端末の開始の応答だけは、CLI の画面に出すワンタイム
// コード（有効 5 分・1 回だけ）を載せる。
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
] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export type ControlRequest =
  | { readonly op: 'status' | 'stop'; readonly request_id: string }
  | { readonly op: 'pairing_first_start'; readonly request_id: string }
  | {
      readonly op: 'pairing_first_approve';
      readonly request_id: string;
      readonly pairing_id: string;
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
  | 'invalid_pairing_id';

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

export type ControlResponse =
  | ({ readonly ok: true; readonly request_id: string } & ControlStatus)
  | ({
      readonly ok: true;
      readonly request_id: string;
    } & ControlFirstDeviceResult)
  | {
      readonly ok: false;
      readonly error: 'invalid_request' | 'unavailable';
      readonly reason?: ControlRejectReason;
    }
  // 最初の端末の命令の拒否（有効な端末がある・HTTPS がない・申請がないなど）。
  | { readonly ok: false; readonly error: 'refused'; readonly reason: string };

const decoder = new TextDecoder('utf-8', { fatal: true });
const ALLOWED_FIELDS: readonly string[] = ['op', 'request_id'];
// pairing_first_approve だけが pairing_id を持つ。
const APPROVE_FIELDS: readonly string[] = ['op', 'request_id', 'pairing_id'];

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
    value['op'] === 'pairing_first_approve' ? APPROVE_FIELDS : ALLOWED_FIELDS;
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
  return {
    ok: true,
    request:
      op === 'pairing_first_start'
        ? { op, request_id: requestId }
        : { op: op as 'status' | 'stop', request_id: requestId },
  };
}

export function encodeControlMessage(message: object): string {
  return `${JSON.stringify(message)}\n`;
}
