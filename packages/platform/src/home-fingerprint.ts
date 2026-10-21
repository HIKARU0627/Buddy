// 端末側の自宅の指紋の収集（設計 11 §10、X42、ADR 0022）。
//
// 既定のゲートウェイの MAC・端末のサブネット（IPv4 の CIDR）・Wi-Fi の SSID を集める。
// 取れない要素は null（「取得できない」）にし、推測で埋めない。理由は診断用のコードだけで、値を入れない。
// コマンドは CommandRunner 経由で shell を通さずに実行し、試験では模擬の runner に合成の出力を渡す。
//
// macOS:
//   1. `/sbin/route -n get default` の gateway・interface（既定の経路の IPv4 のゲートウェイと接続口）
//   2. `/usr/sbin/arp -n <gateway>` の MAC（macOS は先頭の 0 を省いて出すので 2 桁にそろえる）
//   3. サブネットは接続口の IPv4 のアドレスとネットマスク（os.networkInterfaces と同じ情報）から求める
//   4. SSID は `/usr/sbin/ipconfig getsummary <interface>` の SSID の行。位置情報の許可がないと <redacted> に
//      なるので取得できない扱いにし、`/usr/sbin/networksetup -getairportnetwork <interface>` を次に試す
// Windows:
//   1〜3. PowerShell の Get-NetRoute（0.0.0.0/0 の経路の中で経路と接続口の metric の和が最小）・
//         Get-NetNeighbor（ゲートウェイの LinkLayerAddress）・Get-NetIPAddress（IPv4 と PrefixLength）を JSON で出す
//   4. `netsh wlan show interfaces` の SSID の行（BSSID の行は除く。複数の無線の接続口があれば取得できない扱い）
// Linux は対象外（すべて取得できない）。
import type { CommandRunner } from './runner.js';

export interface HomeFingerprintObservation {
  // 小文字の 16 進 2 桁をコロンでつないだ 6 組。
  readonly gateway_mac: string | null;
  // 正準の IPv4 の CIDR（ネットワークのアドレス／接頭辞の長さ）。
  readonly subnet: string | null;
  readonly ssid: string | null;
  // 取得できなかった理由（診断用のコード。値を含めない）。
  readonly unavailable: readonly string[];
}

export interface HomeFingerprintCollector {
  collect(): Promise<HomeFingerprintObservation>;
}

export interface InterfaceAddress {
  readonly address: string;
  readonly netmask: string;
  readonly family: string;
  readonly internal: boolean;
}

export type NetworkInterfacesSource = () => Readonly<
  Record<string, readonly InterfaceAddress[] | undefined>
>;

export const ROUTE_PATH = '/sbin/route';
export const ARP_PATH = '/usr/sbin/arp';
export const IPCONFIG_PATH = '/usr/sbin/ipconfig';
export const NETWORKSETUP_PATH = '/usr/sbin/networksetup';
export const POWERSHELL_COMMAND = 'powershell.exe';
export const NETSH_COMMAND = 'netsh.exe';

// Windows で既定のゲートウェイ・その MAC・接続口の IPv4 を JSON で出す PowerShell のスクリプト。
export const WINDOWS_ROUTE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$r = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Sort-Object -Property @{ Expression = { $_.RouteMetric + $_.InterfaceMetric } } | Select-Object -First 1",
  '$n = Get-NetNeighbor -AddressFamily IPv4 -IPAddress $r.NextHop -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1',
  '$a = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1',
  '[pscustomobject]@{ gateway = $r.NextHop; mac = $n.LinkLayerAddress; address = $a.IPAddress; prefix = $a.PrefixLength } | ConvertTo-Json -Compress',
].join('; ');

const OCTET = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/u;

function ipv4ToNumber(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => OCTET.test(part)))
    return null;
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(value / 2 ** shift) % 256)
    .join('.');
}

// ネットマスクの接頭辞の長さ。連続した 1 でなければ null。
export function prefixOfNetmask(netmask: string): number | null {
  const value = ipv4ToNumber(netmask);
  if (value === null) return null;
  const bits = value.toString(2).padStart(32, '0');
  if (!/^1*0*$/u.test(bits)) return null;
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

// アドレスと接頭辞の長さから正準の CIDR（ネットワークのアドレス）を作る。自宅の LAN にならない長さは null。
export function subnetCidr(address: string, prefix: number): string | null {
  const value = ipv4ToNumber(address);
  if (value === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30)
    return null;
  const block = 2 ** (32 - prefix);
  return `${numberToIpv4(Math.floor(value / block) * block)}/${prefix}`;
}

// MAC の表記（コロン・ハイフン区切り、先頭の 0 の省略、大文字）を小文字の 2 桁のコロン区切りにそろえる。
// 全部 0・全部 F（不完全な近隣の表示・ブロードキャスト）は取得できない扱い。
export function normalizeMac(text: string): string | null {
  const parts = text.trim().split(/[:-]/u);
  if (
    parts.length !== 6 ||
    !parts.every((part) => /^[0-9A-Fa-f]{1,2}$/u.test(part))
  )
    return null;
  const mac = parts
    .map((part) => part.toLowerCase().padStart(2, '0'))
    .join(':');
  if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return null;
  return mac;
}

// `route -n get default` の gateway と interface。
export function parseMacRoute(
  output: string,
): { readonly gateway: string; readonly interfaceName: string } | null {
  const gateway = /^\s*gateway:\s*(\S+)\s*$/mu.exec(output)?.[1];
  const interfaceName = /^\s*interface:\s*([A-Za-z0-9]+)\s*$/mu.exec(
    output,
  )?.[1];
  if (gateway === undefined || interfaceName === undefined) return null;
  if (ipv4ToNumber(gateway) === null) return null;
  return { gateway, interfaceName };
}

// `arp -n <gateway>` の「at <MAC> on <interface>」。不完全（incomplete）なら null。
export function parseMacArp(output: string, gateway: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\S+ \(([0-9.]+)\) at ([0-9A-Fa-f:]+) on /u.exec(line);
    if (match !== null && match[1] === gateway)
      return normalizeMac(match[2] as string);
  }
  return null;
}

// SSID の行の値。<redacted>・空は取得できない扱い（理由を返す）。
function ssidValue(raw: string): {
  ssid: string | null;
  reason: string | null;
} {
  const value = raw.trim();
  if (value === '') return { ssid: null, reason: 'ssid_unavailable' };
  if (/^<redacted>$/iu.test(value))
    return { ssid: null, reason: 'ssid_redacted' };
  if (value.length > 32) return { ssid: null, reason: 'ssid_unavailable' };
  return { ssid: value, reason: null };
}

// `ipconfig getsummary <interface>` の「SSID : <名前>」（BSSID の行は除く）。
export function parseMacIpconfigSsid(output: string): {
  readonly ssid: string | null;
  readonly reason: string | null;
} {
  const match = /^\s*SSID\s*:\s?(.*)$/mu.exec(output);
  if (match === null) return { ssid: null, reason: 'ssid_unavailable' };
  return ssidValue(match[1] as string);
}

// `networksetup -getairportnetwork <interface>` の「Current Wi-Fi Network: <名前>」。
export function parseMacAirportSsid(output: string): {
  readonly ssid: string | null;
  readonly reason: string | null;
} {
  const match = /^Current Wi-Fi Network:\s?(.*)$/mu.exec(output);
  if (match === null) return { ssid: null, reason: 'ssid_unavailable' };
  return ssidValue(match[1] as string);
}

// Windows の PowerShell の出力（JSON）。
export function parseWindowsRoute(output: string): {
  readonly gateway: string | null;
  readonly mac: string | null;
  readonly subnet: string | null;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  const gateway =
    typeof record['gateway'] === 'string' &&
    ipv4ToNumber(record['gateway']) !== null
      ? record['gateway']
      : null;
  const mac =
    typeof record['mac'] === 'string' ? normalizeMac(record['mac']) : null;
  const subnet =
    typeof record['address'] === 'string' &&
    typeof record['prefix'] === 'number'
      ? subnetCidr(record['address'], record['prefix'])
      : null;
  return { gateway, mac, subnet };
}

// `netsh wlan show interfaces` の SSID の行。接続口が複数（SSID の行が複数）なら取得できない扱い。
export function parseNetshSsid(output: string): {
  readonly ssid: string | null;
  readonly reason: string | null;
} {
  const values = [...output.matchAll(/^\s*SSID\s*:\s?(.*)$/gmu)].map(
    (match) => match[1] as string,
  );
  if (values.length === 0) return { ssid: null, reason: 'ssid_unavailable' };
  if (values.length > 1) return { ssid: null, reason: 'ssid_ambiguous' };
  return ssidValue(values[0] as string);
}

function subnetFromInterfaces(
  interfaces: NetworkInterfacesSource,
  interfaceName: string,
): string | null {
  const candidates = (interfaces()[interfaceName] ?? []).filter(
    (entry) => entry.family === 'IPv4' && !entry.internal,
  );
  if (candidates.length !== 1) return null;
  const entry = candidates[0] as InterfaceAddress;
  const prefix = prefixOfNetmask(entry.netmask);
  return prefix === null ? null : subnetCidr(entry.address, prefix);
}

export interface HomeFingerprintCollectorOptions {
  readonly platform: NodeJS.Platform;
  readonly runner: CommandRunner;
  // 接続口のアドレス（既定は os.networkInterfaces を渡す。試験では合成の値）。
  readonly networkInterfaces: NetworkInterfacesSource;
}

async function runText(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const result = await runner.run(command, args);
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

async function collectMac(
  options: HomeFingerprintCollectorOptions,
): Promise<HomeFingerprintObservation> {
  const unavailable: string[] = [];
  let gatewayMac: string | null = null;
  let subnet: string | null = null;
  let ssid: string | null = null;
  const routeText = await runText(options.runner, ROUTE_PATH, [
    '-n',
    'get',
    'default',
  ]);
  const route = routeText === null ? null : parseMacRoute(routeText);
  if (route === null) {
    unavailable.push(
      'gateway_unavailable',
      'gateway_mac_unavailable',
      'subnet_unavailable',
    );
  } else {
    const arpText = await runText(options.runner, ARP_PATH, [
      '-n',
      route.gateway,
    ]);
    gatewayMac = arpText === null ? null : parseMacArp(arpText, route.gateway);
    if (gatewayMac === null) unavailable.push('gateway_mac_unavailable');
    subnet = subnetFromInterfaces(
      options.networkInterfaces,
      route.interfaceName,
    );
    if (subnet === null) unavailable.push('subnet_unavailable');
  }
  if (route !== null) {
    const summary = await runText(options.runner, IPCONFIG_PATH, [
      'getsummary',
      route.interfaceName,
    ]);
    let parsed =
      summary === null
        ? { ssid: null, reason: 'ssid_unavailable' }
        : parseMacIpconfigSsid(summary);
    if (parsed.ssid === null) {
      const airport = await runText(options.runner, NETWORKSETUP_PATH, [
        '-getairportnetwork',
        route.interfaceName,
      ]);
      const fallback = airport === null ? null : parseMacAirportSsid(airport);
      if (fallback?.ssid) parsed = fallback;
    }
    ssid = parsed.ssid;
    if (ssid === null) unavailable.push(parsed.reason ?? 'ssid_unavailable');
  } else unavailable.push('ssid_unavailable');
  return { gateway_mac: gatewayMac, subnet, ssid, unavailable };
}

async function collectWindows(
  options: HomeFingerprintCollectorOptions,
): Promise<HomeFingerprintObservation> {
  const unavailable: string[] = [];
  const routeText = await runText(options.runner, POWERSHELL_COMMAND, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_ROUTE_SCRIPT,
  ]);
  const route = routeText === null ? null : parseWindowsRoute(routeText);
  if (route === null || route.gateway === null)
    unavailable.push('gateway_unavailable');
  const gatewayMac = route?.gateway ? route.mac : null;
  if (gatewayMac === null) unavailable.push('gateway_mac_unavailable');
  const subnet = route?.subnet ?? null;
  if (subnet === null) unavailable.push('subnet_unavailable');
  const wlan = await runText(options.runner, NETSH_COMMAND, [
    'wlan',
    'show',
    'interfaces',
  ]);
  const parsed =
    wlan === null
      ? { ssid: null, reason: 'ssid_unavailable' }
      : parseNetshSsid(wlan);
  if (parsed.ssid === null)
    unavailable.push(parsed.reason ?? 'ssid_unavailable');
  return { gateway_mac: gatewayMac, subnet, ssid: parsed.ssid, unavailable };
}

export function createHomeFingerprintCollector(
  options: HomeFingerprintCollectorOptions,
): HomeFingerprintCollector {
  return {
    async collect() {
      if (options.platform === 'darwin') return collectMac(options);
      if (options.platform === 'win32') return collectWindows(options);
      return {
        gateway_mac: null,
        subnet: null,
        ssid: null,
        unavailable: ['platform_unsupported'],
      };
    },
  };
}

// 試験用の模擬。渡した観測をそのまま返す（実機のコマンドを呼ばない）。
export function createMockHomeFingerprintCollector(
  observation: HomeFingerprintObservation,
): HomeFingerprintCollector & { readonly kind: 'mock' } {
  return {
    kind: 'mock',
    collect: () => Promise.resolve(observation),
  };
}
