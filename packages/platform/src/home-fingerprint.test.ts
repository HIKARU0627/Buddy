// 端末側の自宅の指紋の収集（ADR 0022）。模擬の runner に合成のコマンドの出力を渡し、実機のコマンドは呼ばない。
// MAC は文書用（RFC 7042 の 00:00:5e:00:53:xx）、アドレスは文書用（RFC 5737）、SSID は合成の名前。
// 出力の形は macOS・Windows のコマンドの出力の形を手で写した合成値で、期待値も手で書いた値。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARP_PATH,
  IPCONFIG_PATH,
  NETSH_COMMAND,
  NETWORKSETUP_PATH,
  POWERSHELL_COMMAND,
  ROUTE_PATH,
  WINDOWS_ROUTE_SCRIPT,
  createHomeFingerprintCollector,
  createMockHomeFingerprintCollector,
  normalizeMac,
  parseMacArp,
  parseMacIpconfigSsid,
  parseMacRoute,
  parseNetshSsid,
  parseWindowsRoute,
  prefixOfNetmask,
  subnetCidr,
} from './home-fingerprint.js';
import type { NetworkInterfacesSource } from './home-fingerprint.js';
import { createMockCommandRunner } from './runner.js';
import type { CommandResult } from './runner.js';

const ok = (stdout: string): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
});
const missing: CommandResult = { exitCode: null, stdout: '', stderr: '' };

const MAC_ROUTE = [
  '   route to: default',
  'destination: default',
  '       mask: default',
  '    gateway: 192.0.2.1',
  '  interface: en0',
  '      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>',
  ' recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire',
  '       0         0         0         0         0         0      1500         0',
].join('\n');
// macOS の arp は先頭の 0 を省いて出す。
const MAC_ARP = '? (192.0.2.1) at 0:0:5e:0:53:1 on en0 ifscope [ethernet]\n';
const MAC_SUMMARY = [
  '<dictionary> {',
  '  BSSID : 00:00:5e:00:53:99',
  '  InterfaceType : WiFi',
  '  SSID : 合成の自宅',
  '}',
].join('\n');
const INTERFACES: NetworkInterfacesSource = () => ({
  lo0: [
    {
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      internal: true,
    },
  ],
  en0: [
    {
      address: 'fe80::1',
      netmask: 'ffff:ffff:ffff:ffff::',
      family: 'IPv6',
      internal: false,
    },
    {
      address: '192.0.2.23',
      netmask: '255.255.255.0',
      family: 'IPv4',
      internal: false,
    },
  ],
});

function macRunner(overrides: Record<string, CommandResult> = {}) {
  return createMockCommandRunner((command) => {
    if (command in overrides) return overrides[command] as CommandResult;
    if (command === ROUTE_PATH) return ok(MAC_ROUTE);
    if (command === ARP_PATH) return ok(MAC_ARP);
    if (command === IPCONFIG_PATH) return ok(MAC_SUMMARY);
    if (command === NETWORKSETUP_PATH)
      return ok('You are not associated with an AirPort network.\n');
    return missing;
  });
}

test(
  'macOS: gateway MAC, subnet and SSID are collected from route, arp and ipconfig',
  { timeout: 10_000 },
  async () => {
    const runner = macRunner();
    const collector = createHomeFingerprintCollector({
      platform: 'darwin',
      runner,
      networkInterfaces: INTERFACES,
    });
    assert.deepEqual(await collector.collect(), {
      gateway_mac: '00:00:5e:00:53:01',
      subnet: '192.0.2.0/24',
      ssid: '合成の自宅',
      unavailable: [],
    });
    assert.deepEqual(
      runner.calls.map((call) => [call.command, call.args]),
      [
        [ROUTE_PATH, ['-n', 'get', 'default']],
        [ARP_PATH, ['-n', '192.0.2.1']],
        [IPCONFIG_PATH, ['getsummary', 'en0']],
      ],
    );
  },
);

test(
  'macOS: a redacted SSID falls back to networksetup and otherwise stays unavailable',
  { timeout: 10_000 },
  async () => {
    const redacted = MAC_SUMMARY.replace('合成の自宅', '<redacted>');
    const fallback = macRunner({
      [IPCONFIG_PATH]: ok(redacted),
      [NETWORKSETUP_PATH]: ok('Current Wi-Fi Network: 合成の自宅\n'),
    });
    const observed = await createHomeFingerprintCollector({
      platform: 'darwin',
      runner: fallback,
      networkInterfaces: INTERFACES,
    }).collect();
    assert.equal(observed.ssid, '合成の自宅');
    assert.deepEqual(observed.unavailable, []);
    // 両方とも取れなければ、SSID だけ取得できない（MAC とサブネットは取れる）。
    const none = await createHomeFingerprintCollector({
      platform: 'darwin',
      runner: macRunner({ [IPCONFIG_PATH]: ok(redacted) }),
      networkInterfaces: INTERFACES,
    }).collect();
    assert.deepEqual(none, {
      gateway_mac: '00:00:5e:00:53:01',
      subnet: '192.0.2.0/24',
      ssid: null,
      unavailable: ['ssid_redacted'],
    });
  },
);

test(
  'macOS: missing route, incomplete arp entries and odd interfaces are reported as unavailable',
  { timeout: 10_000 },
  async () => {
    const noRoute = await createHomeFingerprintCollector({
      platform: 'darwin',
      runner: macRunner({
        [ROUTE_PATH]: {
          exitCode: 1,
          stdout: '',
          stderr: 'route: writing to routing socket: not in table',
        },
      }),
      networkInterfaces: INTERFACES,
    }).collect();
    assert.deepEqual(noRoute, {
      gateway_mac: null,
      subnet: null,
      ssid: null,
      unavailable: [
        'gateway_unavailable',
        'gateway_mac_unavailable',
        'subnet_unavailable',
        'ssid_unavailable',
      ],
    });
    const incomplete = await createHomeFingerprintCollector({
      platform: 'darwin',
      runner: macRunner({
        [ARP_PATH]: ok(
          '? (192.0.2.1) at (incomplete) on en0 ifscope [ethernet]\n',
        ),
      }),
      networkInterfaces: () => ({ en0: [] }),
    }).collect();
    assert.equal(incomplete.gateway_mac, null);
    assert.equal(incomplete.subnet, null);
    assert.deepEqual(incomplete.unavailable, [
      'gateway_mac_unavailable',
      'subnet_unavailable',
    ]);
    // 既定の経路が IPv4 のゲートウェイでない（link# など）は取得できない。
    assert.equal(
      parseMacRoute(MAC_ROUTE.replace('192.0.2.1', 'link#14')),
      null,
    );
    // 別のアドレスの行の MAC は使わない。
    assert.equal(parseMacArp(MAC_ARP, '192.0.2.254'), null);
    assert.deepEqual(parseMacIpconfigSsid('  BSSID : 00:00:5e:00:53:99\n'), {
      ssid: null,
      reason: 'ssid_unavailable',
    });
  },
);

const WINDOWS_JSON = JSON.stringify({
  gateway: '192.0.2.1',
  mac: '00-00-5E-00-53-01',
  address: '192.0.2.23',
  prefix: 24,
});
const NETSH = [
  '',
  'There is 1 interface on the system:',
  '',
  '    Name                   : Wi-Fi',
  '    State                  : connected',
  '    SSID                   : 合成の自宅',
  '    BSSID                  : 00:00:5e:00:53:99',
  '',
].join('\r\n');

test(
  'Windows: PowerShell and netsh outputs give the gateway MAC, subnet and SSID',
  { timeout: 10_000 },
  async () => {
    const runner = createMockCommandRunner((command) => {
      if (command === POWERSHELL_COMMAND) return ok(`${WINDOWS_JSON}\r\n`);
      if (command === NETSH_COMMAND) return ok(NETSH);
      return missing;
    });
    assert.deepEqual(
      await createHomeFingerprintCollector({
        platform: 'win32',
        runner,
        networkInterfaces: () => ({}),
      }).collect(),
      {
        gateway_mac: '00:00:5e:00:53:01',
        subnet: '192.0.2.0/24',
        ssid: '合成の自宅',
        unavailable: [],
      },
    );
    assert.deepEqual(runner.calls[0], {
      command: POWERSHELL_COMMAND,
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ROUTE_SCRIPT],
    });
    assert.deepEqual(runner.calls[1], {
      command: NETSH_COMMAND,
      args: ['wlan', 'show', 'interfaces'],
    });
    // 有線（無線の接続口なし）・位置情報の許可がない（SSID の行が出ない）は SSID だけ取得できない。
    const wired = await createHomeFingerprintCollector({
      platform: 'win32',
      runner: createMockCommandRunner((command) =>
        command === POWERSHELL_COMMAND
          ? ok(WINDOWS_JSON)
          : {
              exitCode: 1,
              stdout:
                'The Wireless AutoConfig Service (wlansvc) is not running.',
              stderr: '',
            },
      ),
      networkInterfaces: () => ({}),
    }).collect();
    assert.deepEqual(wired.unavailable, ['ssid_unavailable']);
    // PowerShell が失敗すれば MAC・サブネットは取得できない。
    const failed = await createHomeFingerprintCollector({
      platform: 'win32',
      runner: createMockCommandRunner(() => missing),
      networkInterfaces: () => ({}),
    }).collect();
    assert.deepEqual(failed, {
      gateway_mac: null,
      subnet: null,
      ssid: null,
      unavailable: [
        'gateway_unavailable',
        'gateway_mac_unavailable',
        'subnet_unavailable',
        'ssid_unavailable',
      ],
    });
  },
);

test(
  'Windows: odd values in the outputs become unavailable',
  { timeout: 10_000 },
  () => {
    assert.deepEqual(
      parseWindowsRoute(
        JSON.stringify({
          gateway: '192.0.2.1',
          mac: '00-00-00-00-00-00',
          address: '192.0.2.23',
          prefix: 24,
        }),
      ),
      { gateway: '192.0.2.1', mac: null, subnet: '192.0.2.0/24' },
    );
    assert.deepEqual(
      parseWindowsRoute(
        JSON.stringify({
          gateway: null,
          mac: null,
          address: null,
          prefix: null,
        }),
      ),
      { gateway: null, mac: null, subnet: null },
    );
    assert.equal(parseWindowsRoute('not json'), null);
    assert.equal(parseWindowsRoute('[]'), null);
    // 無線の接続口が二つ（SSID の行が二つ）なら、どちらか分からないので取得できない。
    assert.deepEqual(parseNetshSsid(`${NETSH}${NETSH}`), {
      ssid: null,
      reason: 'ssid_ambiguous',
    });
  },
);

test(
  'MAC, netmask and subnet helpers normalize or refuse values',
  { timeout: 10_000 },
  () => {
    assert.equal(normalizeMac('0:0:5e:0:53:1'), '00:00:5e:00:53:01');
    assert.equal(normalizeMac('00-00-5E-00-53-0A'), '00:00:5e:00:53:0a');
    assert.equal(normalizeMac('ff:ff:ff:ff:ff:ff'), null);
    assert.equal(normalizeMac('00:00:5e:00:53'), null);
    assert.equal(normalizeMac('00:00:5e:00:53:001'), null);
    assert.equal(prefixOfNetmask('255.255.255.0'), 24);
    assert.equal(prefixOfNetmask('255.255.254.0'), 23);
    assert.equal(prefixOfNetmask('255.0.255.0'), null);
    assert.equal(prefixOfNetmask('255.255.255.255'), 32);
    assert.equal(subnetCidr('198.51.100.200', 25), '198.51.100.128/25');
    assert.equal(subnetCidr('192.0.2.23', 32), null);
    assert.equal(subnetCidr('192.0.2.23', 7), null);
    assert.equal(subnetCidr('192.0.2', 24), null);
  },
);

test(
  'Linux is not a target and the mock returns the given observation',
  { timeout: 10_000 },
  async () => {
    const runner = createMockCommandRunner(() => missing);
    assert.deepEqual(
      await createHomeFingerprintCollector({
        platform: 'linux',
        runner,
        networkInterfaces: () => ({}),
      }).collect(),
      {
        gateway_mac: null,
        subnet: null,
        ssid: null,
        unavailable: ['platform_unsupported'],
      },
    );
    assert.equal(runner.calls.length, 0);
    const observation = {
      gateway_mac: '00:00:5e:00:53:01',
      subnet: '192.0.2.0/24',
      ssid: null,
      unavailable: ['ssid_unavailable'],
    };
    assert.deepEqual(
      await createMockHomeFingerprintCollector(observation).collect(),
      observation,
    );
  },
);
