// 自宅ネットワークの判定（設計 11 §10、02 端末登録と接続・運用上の境界、X42、ADR 0022）。
//
// 初期版は自宅だけを許可する。次の二つを両方満たすときだけ許可し、端末認証の代わりにはしない（追加の条件）。
//   1. 自宅の指紋が一致する（ゲートウェイの MAC とサブネットは必須。SSID は登録値と報告の両方にあるときだけ比べる）
//   2. Tailscale の直接経路が自宅 LAN の中にある（DERP・ピアの中継・経路不明・状態を取得できないは不成立）
// 指紋だけの許可に切り替えない。端末の報告は受け取ってから 6 分を過ぎたら使わない。
// 中枢と同じマシンのクライアント（hub_local の端末で、接続元が同じマシン）は自宅判定だけを免除する。
// MAC と SSID は Core が HMAC にしてから渡す（ここでは等しいかだけを見る）。サブネットは平文の IPv4 の CIDR。
// 結果は理由のコードの並びで、空なら許可。理由は診断用で、値（MAC・SSID・アドレス）を含めない。

// 報告の鮮度（本人の判断 2026-10-21）。受け取った時刻から 6 分（360 秒）の前だけ使う。
export const HOME_REPORT_MAX_AGE_MS = 360_000;

export type HomeNetworkReason =
  // 自宅が登録されていない（中枢の画面から登録する）。
  | 'home_not_registered'
  // 端末の報告がない・古い・中枢の時計より後の時刻（時計の巻き戻り）。
  | 'report_missing'
  | 'report_stale'
  | 'report_clock_inconsistent'
  | 'gateway_mac_unavailable'
  | 'gateway_mac_mismatch'
  | 'subnet_unavailable'
  | 'subnet_mismatch'
  | 'ssid_mismatch'
  // `tailscale status --json` を取得できない・読めない・動いていない。
  | 'tailscale_unavailable'
  // 接続元のアドレスに合う Tailscale のピアがない。
  | 'tailscale_peer_not_found'
  // DERP（Tailscale の中継サーバー）を通っている。
  | 'tailscale_derp'
  // ピアの中継（peer relay）を通っている。直接経路ではない。
  | 'tailscale_peer_relay'
  // 直接のアドレス（CurAddr）が空で、中継も分からない（経路を確認できない）。
  | 'direct_address_missing'
  | 'direct_address_invalid'
  | 'direct_address_outside_home';

// 理由の並びの順（診断の表示を安定させる）。
export const HOME_NETWORK_REASONS: readonly HomeNetworkReason[] = [
  'home_not_registered',
  'report_missing',
  'report_stale',
  'report_clock_inconsistent',
  'gateway_mac_unavailable',
  'gateway_mac_mismatch',
  'subnet_unavailable',
  'subnet_mismatch',
  'ssid_mismatch',
  'tailscale_unavailable',
  'tailscale_peer_not_found',
  'tailscale_derp',
  'tailscale_peer_relay',
  'direct_address_missing',
  'direct_address_invalid',
  'direct_address_outside_home',
];

// 中枢の Tailscale から見た、接続元のピアへの経路。
export type TailscalePeerPath =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'peer_not_found' }
  | {
      readonly kind: 'peer';
      // 直接のアドレス（`ip:port`・`[ipv6]:port`）。DERP を通っているときは空。
      readonly cur_addr: string;
      // DERP の地域（中継サーバーの名前）。空のこともある。
      readonly relay: string;
      // ピアの中継。使っていなければ空。
      readonly peer_relay: string;
    };

export interface HomeRegistrationView {
  readonly gateway_mac_hash: string;
  // 正準の IPv4 の CIDR（ネットワークのアドレス／接頭辞の長さ）。
  readonly subnet: string;
  readonly ssid_hash: string | null;
}

export interface HomeReportView {
  // 取得できなかった要素は null。
  readonly gateway_mac_hash: string | null;
  readonly subnet: string | null;
  readonly ssid_hash: string | null;
  // 中枢が受け取った時刻（UTC の Unix ミリ秒）。端末の時計は使わない。
  readonly received_at_ms: number;
}

export interface HomeNetworkInput {
  // hub_local の端末で、接続元が中枢と同じマシン。端末認証は別に必要。
  readonly same_machine_hub_client: boolean;
  readonly registration: HomeRegistrationView | null;
  readonly report: HomeReportView | null;
  readonly tailscale: TailscalePeerPath;
  readonly now_ms: number;
}

export interface HomeNetworkDecision {
  readonly allowed: boolean;
  // 中枢と同じマシンの免除で許可した。
  readonly exempt: boolean;
  readonly reasons: readonly HomeNetworkReason[];
}

const OCTET = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/u;
// 自宅のサブネットとして受け付ける接頭辞の長さ。/0〜/7 は広すぎ、/31・/32 は LAN にならない。
export const HOME_SUBNET_MIN_PREFIX = 8;
export const HOME_SUBNET_MAX_PREFIX = 30;

// IPv4 の 4 つの数字の表記を 32 ビットの数に。先頭の 0・空・範囲外は null。
export function parseIpv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(value / 2 ** shift) % 256)
    .join('.');
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (2 ** 32 - 2 ** (32 - prefix)) >>> 0;
}

export interface Ipv4Subnet {
  readonly network: number;
  readonly prefix: number;
}

// 自宅のサブネットの CIDR を読む。ネットワークのアドレスでない（ホスト部が 0 でない）・接頭辞の長さが
// 範囲外なら null。正準の表記は formatSubnet で戻した文字列と同じ。
export function parseHomeSubnet(text: string): Ipv4Subnet | null {
  const match = /^([0-9.]+)\/([0-9]{1,2})$/u.exec(text);
  if (match === null) return null;
  const address = parseIpv4(match[1] as string);
  const digits = match[2] as string;
  if (address === null || (digits.length === 2 && digits.startsWith('0')))
    return null;
  const prefix = Number(digits);
  if (prefix < HOME_SUBNET_MIN_PREFIX || prefix > HOME_SUBNET_MAX_PREFIX)
    return null;
  if ((address & maskOf(prefix)) >>> 0 !== address) return null;
  return { network: address, prefix };
}

export function formatSubnet(subnet: Ipv4Subnet): string {
  return `${formatIpv4(subnet.network)}/${subnet.prefix}`;
}

// アドレスとネットマスクの長さから、そのアドレスが属するサブネット（ネットワークのアドレス）を求める。
export function subnetOfAddress(
  address: string,
  prefix: number,
): string | null {
  const value = parseIpv4(address);
  if (
    value === null ||
    !Number.isInteger(prefix) ||
    prefix < HOME_SUBNET_MIN_PREFIX ||
    prefix > HOME_SUBNET_MAX_PREFIX
  )
    return null;
  return formatSubnet({ network: (value & maskOf(prefix)) >>> 0, prefix });
}

export function ipv4InSubnet(address: number, subnet: Ipv4Subnet): boolean {
  return (address & maskOf(subnet.prefix)) >>> 0 === subnet.network;
}

// Tailscale の CurAddr（`ip:port` か `[ipv6]:port`）からアドレスを取り出す。読めなければ null。
export function hostOfAddrPort(
  addrPort: string,
):
  | { readonly family: 4; readonly address: number }
  | { readonly family: 6 }
  | null {
  const v6 = /^\[([0-9A-Fa-f:.]+)(%[^\]]+)?\]:([0-9]{1,5})$/u.exec(addrPort);
  if (v6 !== null) {
    const port = Number(v6[3]);
    return port <= 65_535 && (v6[1] as string).includes(':')
      ? { family: 6 }
      : null;
  }
  const v4 = /^([0-9.]+):([0-9]{1,5})$/u.exec(addrPort);
  if (v4 === null || Number(v4[2]) > 65_535) return null;
  const address = parseIpv4(v4[1] as string);
  return address === null ? null : { family: 4, address };
}

function tailscaleReasons(
  path: TailscalePeerPath,
  subnet: Ipv4Subnet | null,
): HomeNetworkReason[] {
  if (path.kind === 'unavailable') return ['tailscale_unavailable'];
  if (path.kind === 'peer_not_found') return ['tailscale_peer_not_found'];
  // CurAddr があれば直接経路（Tailscale は直接経路が使えるときに CurAddr を埋める）。
  if (path.cur_addr === '') {
    if (path.peer_relay !== '') return ['tailscale_peer_relay'];
    if (path.relay !== '') return ['tailscale_derp'];
    return ['direct_address_missing'];
  }
  const host = hostOfAddrPort(path.cur_addr);
  if (host === null) return ['direct_address_invalid'];
  // 自宅のサブネットは IPv4。IPv6 の直接経路は自宅 LAN の中と確かめられない。
  if (host.family === 6) return ['direct_address_outside_home'];
  // 登録がなければ比べられない（home_not_registered で拒否する）。
  if (subnet === null) return [];
  return ipv4InSubnet(host.address, subnet)
    ? []
    : ['direct_address_outside_home'];
}

// 自宅判定。理由が一つもなければ許可。判定できる理由はすべて返す（診断のため）。
export function homeNetworkDecision(
  input: HomeNetworkInput,
): HomeNetworkDecision {
  if (input.same_machine_hub_client)
    return { allowed: true, exempt: true, reasons: [] };
  const reasons = new Set<HomeNetworkReason>();
  const registration = input.registration;
  const subnet =
    registration === null ? null : parseHomeSubnet(registration.subnet);
  if (registration === null || subnet === null)
    reasons.add('home_not_registered');
  const report = input.report;
  if (report === null) reasons.add('report_missing');
  else {
    const age = input.now_ms - report.received_at_ms;
    if (age < 0) reasons.add('report_clock_inconsistent');
    else if (age >= HOME_REPORT_MAX_AGE_MS) reasons.add('report_stale');
    if (report.gateway_mac_hash === null)
      reasons.add('gateway_mac_unavailable');
    else if (
      registration !== null &&
      report.gateway_mac_hash !== registration.gateway_mac_hash
    )
      reasons.add('gateway_mac_mismatch');
    if (report.subnet === null) reasons.add('subnet_unavailable');
    else if (registration !== null && report.subnet !== registration.subnet)
      reasons.add('subnet_mismatch');
    // SSID は両方で取れたときだけ比べる。
    if (
      registration !== null &&
      registration.ssid_hash !== null &&
      report.ssid_hash !== null &&
      registration.ssid_hash !== report.ssid_hash
    )
      reasons.add('ssid_mismatch');
  }
  for (const reason of tailscaleReasons(input.tailscale, subnet))
    reasons.add(reason);
  const ordered = HOME_NETWORK_REASONS.filter((reason) => reasons.has(reason));
  return { allowed: ordered.length === 0, exempt: false, reasons: ordered };
}
