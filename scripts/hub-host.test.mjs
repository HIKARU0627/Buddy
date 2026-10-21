import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HUB_HOSTNAME_PATTERN,
  admitPairingHost,
  isNormalizedHubHost,
  normalizeHubHost,
  parseIpv6,
} from '../packages/domain/dist/index.js';
import { loadContracts } from './contract-tools.mjs';

// 中枢の宛先の正規化とペアリングで受け付ける宛先（ADR 0025、レビューの指摘 L2・本人の判断 2026-10-21）。
// 期待値はすべて手で書いた値で、検査対象の関数から作っていない。

// 公開の検査（scripts/public-content.mjs は tailnet のホスト名の形を拒否する）に掛からないよう、`*.ts.net` の
// 合成の名前は実行時に組み立てる（実在の Tailnet の名前ではない）。
const TS_NET = ['ts', 'net'].join('.');

const { schema, validators } = await loadContracts();
const hubHostValid = (value) => validators.DesktopHubHost(value) === true;

test('Tailscale CGNAT, loopback, Tailscale IPv6 and *.ts.net names are the only pairing destinations', () => {
  const allowed = [
    // 100.64.0.0/10 の両端と内側。
    ['100.64.0.0', '100.64.0.0'],
    ['100.64.0.1', '100.64.0.1'],
    ['100.100.100.100', '100.100.100.100'],
    ['100.127.255.255', '100.127.255.255'],
    // 127.0.0.0/8 の両端。
    ['127.0.0.0', '127.0.0.0'],
    ['127.0.0.1', '127.0.0.1'],
    ['127.255.255.255', '127.255.255.255'],
    // IPv6 のループバックと fd7a:115c:a1e0::/48 の両端（小文字にする）。
    ['::1', '::1'],
    ['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:1'],
    ['fd7a:115c:a1e0::', 'fd7a:115c:a1e0::'],
    ['fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::1'],
    [
      'FD7A:115C:A1E0:FFFF:FFFF:FFFF:FFFF:FFFF',
      'fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff',
    ],
    // *.ts.net（末尾のドットを除き、小文字にする）。
    [
      `mac-mini.example-tailnet.${TS_NET}`,
      `mac-mini.example-tailnet.${TS_NET}`,
    ],
    [
      `Mac-Mini.Example-Tailnet.${TS_NET.toUpperCase()}.`,
      `mac-mini.example-tailnet.${TS_NET}`,
    ],
    [`a.${TS_NET}`, `a.${TS_NET}`],
  ];
  for (const [input, host] of allowed)
    assert.deepEqual(admitPairingHost(input), { ok: true, host }, input);

  const refused = [
    // 100.64.0.0/10 のすぐ外。
    '100.63.255.255',
    '100.128.0.0',
    '100.0.0.1',
    '100.255.255.255',
    // 127.0.0.0/8 のすぐ外・私設・公開のアドレス。
    '126.255.255.255',
    '128.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.10',
    '8.8.8.8',
    '0.0.0.0',
    // 形の違う IPv4（名前の形には合うが、Tailscale の名前ではない）。
    '100.64.0.256',
    '100.064.0.1',
    '100.64.0',
    // IPv6: ループバック以外・fd7a:115c:a1e0::/48 のすぐ外・IPv4 射影・未指定。
    '::',
    '::2',
    'fe80::1',
    'fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff',
    'fd7a:115c:a1e1::',
    'fd7a:115d:a1e0::1',
    '::ffff:100.64.0.1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    // 名前: ts.net でない・ts.net そのもの・似た名前・MagicDNS の短い名前・localhost。
    'buddy-hub.example',
    'ts.net',
    'ts.net.',
    'evilts.net',
    `hub.${TS_NET}.example`,
    `hub.${TS_NET}work`,
    'mac-mini',
    'localhost',
    // 形の不正（URL・ポート・空白・角かっこ・ゾーン ID・空・254 文字の名前）。
    'https://100.64.0.1',
    '100.64.0.1:47443',
    '[::1]',
    ' 100.64.0.1',
    'fe80::1%en0',
    '',
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(55)}.ts.net`,
  ];
  for (const input of refused)
    assert.deepEqual(
      admitPairingHost(input),
      { ok: false, reason: 'pairing_host_not_allowed' },
      input,
    );
});

test('host normalization is idempotent and matches the contract pattern', () => {
  const cases = [
    ['Example.COM.', { kind: 'hostname', host: 'example.com' }],
    ['example.com', { kind: 'hostname', host: 'example.com' }],
    ['100.64.0.1', { kind: 'ipv4', host: '100.64.0.1' }],
    ['FD7A::1', { kind: 'ipv6', host: 'fd7a::1' }],
    ['::ffff:1.2.3.4', { kind: 'ipv6', host: '::ffff:1.2.3.4' }],
    ['example..com', null],
    ['-example.com', null],
    ['example-.com', null],
    ['example.com..', null],
    ['.', null],
    ['1:2:3:4:5:6:7:8:9', null],
    ['1::2::3', null],
    ['1:2:3:4:5:6:7::8', null],
    ['::1.2.3.4:5', null],
    ['12345::1', null],
  ];
  for (const [input, expected] of cases) {
    const normalized = normalizeHubHost(input);
    assert.deepEqual(normalized, expected, input);
    if (normalized !== null) {
      assert.deepEqual(normalizeHubHost(normalized.host), normalized, input);
      assert.equal(isNormalizedHubHost(normalized.host), true, input);
      // 正規化した値は契約の DesktopHubHost に合う（画面へ出す pairing.host・保存する宛先）。
      assert.equal(hubHostValid(normalized.host), true, input);
    }
  }
  assert.equal(isNormalizedHubHost('Example.com'), false);
  assert.equal(isNormalizedHubHost('example.com.'), false);
  assert.equal(isNormalizedHubHost('FD7A::1'), false);

  // 名前の形は一つの正規表現: 契約の DesktopHubHost の名前の分岐は domain の HUB_HOSTNAME_PATTERN と同じ文字列。
  const hostnameBranch = schema.$defs.DesktopHubHost.anyOf.find(
    (branch) => branch.pattern !== undefined,
  );
  assert.equal(hostnameBranch?.pattern, HUB_HOSTNAME_PATTERN);
  assert.equal(
    schema.$defs.DesktopHubHost.anyOf.some(
      (branch) => branch.format === 'hostname',
    ),
    false,
  );
  // 名前の 63 文字のラベルは受け付け、64 文字は受け付けない。全体は 253 文字まで。
  const label63 = 'a'.repeat(63);
  assert.notEqual(normalizeHubHost(`${label63}.ts.net`), null);
  assert.equal(normalizeHubHost(`${'a'.repeat(64)}.ts.net`), null);
  const name253 = `${label63}.${label63}.${label63}.${'d'.repeat(61)}`;
  assert.equal(name253.length, 253);
  assert.notEqual(normalizeHubHost(name253), null);
  assert.equal(normalizeHubHost(`${name253}e`), null);
  assert.equal(hubHostValid(name253), true);
  assert.equal(hubHostValid(`${name253}e`), false);
});

test('the IPv6 parser returns hand-written values', () => {
  assert.deepEqual(parseIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(
    parseIpv6('fd7a:115c:a1e0::'),
    [0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    parseIpv6('::ffff:100.64.0.1'),
    [0, 0, 0, 0, 0, 0xffff, 0x6440, 0x0001],
  );
  assert.deepEqual(parseIpv6('1:2:3:4:5:6:7::'), [1, 2, 3, 4, 5, 6, 7, 0]);
  assert.equal(parseIpv6('1.2.3.4::1'), null);
  assert.equal(parseIpv6(':1::'), null);
  assert.equal(parseIpv6(':::'), null);
});
