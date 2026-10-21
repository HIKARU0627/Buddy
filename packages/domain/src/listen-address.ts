// 中枢の HTTPS が待ち受けるアドレスの判定（設計 02 端末登録と接続「Tailscale のインターフェースだけで待ち受け」、
// ADR 0020、B03-07 M2）。Node の API を使わない純粋な関数。
//
// - IP アドレスの文字列だけを読む。IPv4 は 4 つの 10 進の数字（先頭の 0 は不可）、IPv6 は 8 つの 16 進の組
//   （`::` の省略と、末尾の IPv4 の表記を含む）。
// - IPv4-mapped（::ffff:0:0/96）は、16 進の表記も含めて IPv4 に直してから判定する。全アドレスの別の書き方
//   （`::ffff:0:0`・`0:0:0:0:0:ffff:0:0`・`::ffff:0.0.0.0` など）をすり抜けさせない。
// - 許可する範囲を列挙する: ループバック（127.0.0.0/8・::1）と Tailscale（100.64.0.0/10・fd7a:115c:a1e0::/48）。
//   それ以外（LAN・リンクローカル・IPv4-compatible など）は拒否する。
// - zone（`%`）つきは受け付けない。許可する範囲に zone の要るアドレスはない。
// - 許可したときは正規化した文字列（IPv4 は 10 進の 4 つの数字、IPv6 は RFC 5952 の形）を返す。中枢はこの文字列で
//   待ち受ける（入力の書き方によらず、同じアドレスに同じ形で結び付く）。

import { parseIpv4 } from './home-network.js';

export type ListenAddressReason =
  // IP アドレスの文字列ではない（名前・空・形の不正）。
  | 'not_ip_address'
  // 全アドレス（0.0.0.0・::、IPv4-mapped の 0.0.0.0）。
  | 'unspecified'
  // 許可する範囲（ループバック・Tailscale）の外、または zone つき。
  | 'not_allowed';

export type ListenAddressDecision =
  | {
      readonly ok: true;
      readonly family: 4 | 6;
      // 正規化したアドレス。
      readonly address: string;
    }
  | { readonly ok: false; readonly reason: ListenAddressReason };

const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/u;

function formatIpv4(value: number): string {
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(value / 2 ** shift) % 256)
    .join('.');
}

// `:` で区切った 16 進の組を読む。空の文字列は 0 個の組。
function hexGroups(part: string): number[] | null {
  if (part === '') return [];
  const groups: number[] = [];
  for (const group of part.split(':')) {
    if (!HEX_GROUP.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

// IPv6 の表記を 8 つの 16 ビットの組に。読めなければ null。
export function parseIpv6(text: string): readonly number[] | null {
  let hex = text;
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) return null;
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    // 末尾の IPv4 の表記は、下位 32 ビットの 2 つの組に置き換えてから読む。
    const v4 = parseIpv4(last);
    if (v4 === null) return null;
    hex = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65_536).toString(16)}:${(v4 % 65_536).toString(16)}`;
  }
  const halves = hex.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const groups = hexGroups(hex);
    return groups !== null && groups.length === 8 ? groups : null;
  }
  const left = hexGroups(halves[0] as string);
  const right = hexGroups(halves[1] as string);
  if (left === null || right === null) return null;
  // `::` は 1 つ以上の 0 の組を表す。
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

// RFC 5952 の形（小文字・先頭の 0 なし・2 つ以上続く 0 の組の最長の並びを `::` にする。同じ長さなら先のもの）。
export function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const text = (part: readonly number[]) =>
    part.map((group) => group.toString(16)).join(':');
  if (bestStart === -1) return text(groups);
  return `${text(groups.slice(0, bestStart))}::${text(groups.slice(bestStart + bestLength))}`;
}

const inIpv4Range = (value: number, network: number, prefix: number) =>
  Math.floor(value / 2 ** (32 - prefix)) ===
  Math.floor(network / 2 ** (32 - prefix));

// 127.0.0.0/8・100.64.0.0/10。
const LOOPBACK_V4 = 0x7f00_0000;
const TAILSCALE_V4 = 0x6440_0000;
// fd7a:115c:a1e0::/48 の上位 3 つの組。
const TAILSCALE_V6 = [0xfd7a, 0x115c, 0xa1e0] as const;

function decideIpv4(value: number): ListenAddressDecision {
  if (value === 0) return { ok: false, reason: 'unspecified' };
  if (
    inIpv4Range(value, LOOPBACK_V4, 8) ||
    inIpv4Range(value, TAILSCALE_V4, 10)
  )
    return { ok: true, family: 4, address: formatIpv4(value) };
  return { ok: false, reason: 'not_allowed' };
}

// 待ち受けのアドレスを正規化してから、許可する範囲かを判定する。
export function listenAddressDecision(host: string): ListenAddressDecision {
  const zoneAt = host.indexOf('%');
  const base = zoneAt === -1 ? host : host.slice(0, zoneAt);
  const v4 = base.includes(':') ? null : parseIpv4(base);
  const v6 = v4 === null ? parseIpv6(base) : null;
  if (v4 === null && v6 === null)
    return { ok: false, reason: 'not_ip_address' };
  if (zoneAt !== -1) return { ok: false, reason: 'not_allowed' };
  if (v4 !== null) return decideIpv4(v4);
  const groups = v6 as readonly number[];
  // IPv4-mapped（::ffff:a.b.c.d）は IPv4 として判定する。
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return decideIpv4((groups[6] as number) * 65_536 + (groups[7] as number));
  if (groups.every((group) => group === 0))
    return { ok: false, reason: 'unspecified' };
  const loopback =
    groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const tailscale = TAILSCALE_V6.every(
    (group, index) => groups[index] === group,
  );
  if (loopback || tailscale)
    return { ok: true, family: 6, address: formatIpv6(groups) };
  return { ok: false, reason: 'not_allowed' };
}
