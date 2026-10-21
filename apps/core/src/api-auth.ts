// 端末トークンと接続範囲（command_scope）の判定（設計 02 端末登録と接続、07 §2・§3、ADR 0009・0020）。
//
// - 端末トークンは 256 ビットの乱数の base64url（パディングなし 43 文字、契約の DeviceCredential）。
//   中枢はトークンを保存せず、ASCII の 43 文字の SHA-256（小文字の 16 進）で devices を引く。
// - device_id は認証の結果から決める。本文・ヘッダーで名乗った端末 ID では処理しない。
// - 接続範囲は、認証した端末のもので、今回の起動（core_instance_id）で発行し、失効しておらず、
//   期限（最長 24 時間）の前のときだけ current。それ以外は stale（経路の検査で 410 expired_scope）。

import { createHash, randomBytes } from 'node:crypto';
import type { CommandScopeRecord } from '@buddy/storage';

export const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/iu;

// Authorization ヘッダーから端末トークンを取り出す。形式が違えば null（DB を引かずに 401）。
export function parseBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

// 照合用の hash。トークンの ASCII の 43 文字の SHA-256 の小文字の 16 進（devices.token_hash の 32 バイト）。
export function deviceTokenHash(token: string): string {
  if (!DEVICE_TOKEN_PATTERN.test(token))
    throw new TypeError('device token must be 43 base64url characters');
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

// 新しい端末トークン（256 ビットの暗号論的乱数）。ペアリング（B03-02）と試験で使う。
export function createDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export type CommandScopeState = 'current' | 'stale';

export function commandScopeState(
  scope: CommandScopeRecord | null,
  current: {
    readonly deviceId: string;
    readonly coreInstanceId: string;
    readonly now: number;
  },
): CommandScopeState {
  if (scope === null) return 'stale';
  if (scope.device_id !== current.deviceId) return 'stale';
  if (scope.core_instance_id !== current.coreInstanceId) return 'stale';
  if (scope.revoked_at !== null) return 'stale';
  // 時計が発行より前へ戻ったときも、期限を確かめられないので古いものとして扱う。
  if (current.now < scope.issued_at || current.now >= scope.expires_at)
    return 'stale';
  return 'current';
}
