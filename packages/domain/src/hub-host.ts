// 中枢の宛先（端末が接続する中枢の IP アドレス・名前）の正規化と、ペアリングで受け付ける宛先の範囲
// （設計 02 端末登録と接続、ADR 0025。レビューの指摘 L2・本人の判断 2026-10-21）。
//
// - 名前の形は HUB_HOSTNAME_PATTERN の一つだけ。契約（JSON Schema の DesktopHubHost）は同じ文字列を pattern に
//   使い、端末の保存（credential-store）は正規化した値と同じかどうかで読み戻しを判定する（試験で一致を確かめる）。
// - 正規化: 名前は末尾のドットを一つ除いて小文字にする。IPv6 は小文字にする。IPv4 はそのまま。
//   正規化した値をもう一度正規化しても変わらない（保存した値をそのまま読み戻せる）。
// - ペアリングの宛先は Tailscale のアドレス（100.64.0.0/10・fd7a:115c:a1e0::/48）、ループバック
//   （127.0.0.0/8・::1）、`*.ts.net` の名前だけ。端末は名前ではなく証明書の指紋で中枢を確かめる（ADR 0020）が、
//   打ち間違い・誘導で Tailnet の外の宛先へ申請（自宅の指紋を含む）を送らないための受付の制限。
// DB・Core・OS・Node の API に依存しない。

import { parseIpv4 } from './home-network.js';

// 名前（ラベルは英数字とハイフン、先頭と末尾は英数字、63 文字まで）。末尾のドットを一つだけ許す。
// 長さ（1〜253 文字）は契約の minLength・maxLength と normalizeHubHost が別に確かめる。
export const HUB_HOSTNAME_PATTERN =
  '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\\.?$';

const HUB_HOSTNAME = new RegExp(HUB_HOSTNAME_PATTERN, 'u');
export const HUB_HOST_MAX_LENGTH = 253;

const HEXTET = /^[0-9A-Fa-f]{1,4}$/u;

// IPv6（`::` の省略と、末尾の 32 ビットの IPv4 の表記を含む。ゾーン ID は不可）。8 つの 16 ビットの数を返す。
export function parseIpv6(text: string): readonly number[] | null {
  if (text.length === 0 || text.length > 45 || text.includes('%')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes('.')) {
        // 先頭の 0 を許さない 10 進の IPv4（home-network.ts の parseIpv4。32 ビットの数）。
        const v4 = parseIpv4(piece);
        if (v4 === null) return null;
        out.push(Math.floor(v4 / 65_536), v4 % 65_536);
        continue;
      }
      if (!HEXTET.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const head = groups(halves[0] as string);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  // IPv4 の表記は末尾だけ（`::` の前には置けない）。
  if ((halves[0] as string).includes('.')) return null;
  const tail = groups(halves[1] as string);
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  // `::` は 1 つ以上の 0 のグループを表す。
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

export type HubHostKind = 'ipv4' | 'ipv6' | 'hostname';

export interface NormalizedHubHost {
  readonly kind: HubHostKind;
  readonly host: string;
}

// 宛先の入力を正規化する。形が合わなければ null。
export function normalizeHubHost(text: string): NormalizedHubHost | null {
  if (text.length === 0 || text.length > HUB_HOST_MAX_LENGTH) return null;
  if (parseIpv4(text) !== null) return { kind: 'ipv4', host: text };
  if (text.includes(':'))
    return parseIpv6(text) === null
      ? null
      : { kind: 'ipv6', host: text.toLowerCase() };
  if (!HUB_HOSTNAME.test(text)) return null;
  const host = (text.endsWith('.') ? text.slice(0, -1) : text).toLowerCase();
  return host.length === 0 ? null : { kind: 'hostname', host };
}

// 保存した宛先が正規化済みの値か（端末の保存の読み戻しで使う）。
export function isNormalizedHubHost(text: string): boolean {
  return normalizeHubHost(text)?.host === text;
}

export type PairingHostRejection = 'pairing_host_not_allowed';

export type PairingHostAdmission =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: PairingHostRejection };

// Tailscale の IPv6 の範囲（fd7a:115c:a1e0::/48）の先頭 3 グループ。
const TAILSCALE_IPV6_PREFIX: readonly number[] = [0xfd7a, 0x115c, 0xa1e0];
// `*.ts.net`（Tailscale の MagicDNS の名前）。ts.net そのものは中枢の名前にならない。
const TS_NET_SUFFIX = '.ts.net';

function ipv4Allowed(value: number): boolean {
  const a = Math.floor(value / 2 ** 24);
  const b = Math.floor(value / 2 ** 16) % 256;
  // 100.64.0.0/10（100.64.0.0〜100.127.255.255。Tailscale のアドレス）・127.0.0.0/8（ループバック）。
  return (a === 100 && b >= 64 && b <= 127) || a === 127;
}

function ipv6Allowed(groups: readonly number[]): boolean {
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)
    return true;
  return TAILSCALE_IPV6_PREFIX.every((group, index) => groups[index] === group);
}

// ペアリングで受け付ける宛先か。受け付ければ正規化した宛先を返す。
export function admitPairingHost(text: string): PairingHostAdmission {
  const normalized = normalizeHubHost(text);
  const rejected = {
    ok: false,
    reason: 'pairing_host_not_allowed',
  } as const;
  if (normalized === null) return rejected;
  const { kind, host } = normalized;
  const allowed =
    kind === 'ipv4'
      ? ipv4Allowed(parseIpv4(host) ?? 0)
      : kind === 'ipv6'
        ? ipv6Allowed(parseIpv6(host) ?? [])
        : host.endsWith(TS_NET_SUFFIX) && host.length > TS_NET_SUFFIX.length;
  return allowed ? { ok: true, host } : rejected;
}
