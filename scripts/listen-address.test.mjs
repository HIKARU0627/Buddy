import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatIpv6,
  listenAddressDecision,
  parseIpv6,
} from '../packages/domain/dist/index.js';

// 中枢の待ち受けのアドレスの判定（ADR 0020、B03-07 M2）を手書きの期待値と照合する。
const ok = (family, address) => ({ ok: true, family, address });
const no = (reason) => ({ ok: false, reason });

test('the unspecified address is refused in every spelling, including IPv4-mapped hex', () => {
  for (const host of [
    '0.0.0.0',
    '::',
    '0:0:0:0:0:0:0:0',
    '0::0',
    '::0.0.0.0',
    '::ffff:0:0',
    '0:0:0:0:0:ffff:0:0',
    '::ffff:0.0.0.0',
    '::FFFF:0:0',
    '0:0::ffff:0:0',
    '::ffff:0000:0000',
  ])
    assert.deepEqual(listenAddressDecision(host), no('unspecified'), host);
});

test('loopback and Tailscale addresses are allowed and normalized', () => {
  const cases = [
    ['127.0.0.1', ok(4, '127.0.0.1')],
    ['::ffff:127.0.0.1', ok(4, '127.0.0.1')],
    ['::ffff:7f00:1', ok(4, '127.0.0.1')],
    ['0:0:0:0:0:ffff:7f00:1', ok(4, '127.0.0.1')],
    ['::FFFF:7F00:0001', ok(4, '127.0.0.1')],
    ['::1', ok(6, '::1')],
    ['0:0:0:0:0:0:0:1', ok(6, '::1')],
    ['::0:1', ok(6, '::1')],
    ['100.64.0.1', ok(4, '100.64.0.1')],
    ['::ffff:6440:1', ok(4, '100.64.0.1')],
    ['fd7a:115c:a1e0::1', ok(6, 'fd7a:115c:a1e0::1')],
    ['FD7A:115C:A1E0:0:0:0:0:1', ok(6, 'fd7a:115c:a1e0::1')],
    [
      'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240',
      ok(6, 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240'),
    ],
    ['fd7a:115c:a1e0:0:0:1:0:0', ok(6, 'fd7a:115c:a1e0::1:0:0')],
    ['fd7a:115c:a1e0:1:0:0:1:1', ok(6, 'fd7a:115c:a1e0:1::1:1')],
  ];
  for (const [host, expected] of cases)
    assert.deepEqual(listenAddressDecision(host), expected, host);
});

test('the boundaries of the allowed ranges are exact', () => {
  const cases = [
    // 127.0.0.0/8
    ['126.255.255.255', no('not_allowed')],
    ['127.0.0.0', ok(4, '127.0.0.0')],
    ['127.255.255.255', ok(4, '127.255.255.255')],
    ['128.0.0.0', no('not_allowed')],
    // 100.64.0.0/10
    ['100.63.255.255', no('not_allowed')],
    ['100.64.0.0', ok(4, '100.64.0.0')],
    ['100.127.255.255', ok(4, '100.127.255.255')],
    ['100.128.0.0', no('not_allowed')],
    ['::ffff:100.63.255.255', no('not_allowed')],
    ['::ffff:647f:ffff', ok(4, '100.127.255.255')],
    ['::ffff:6480:0', no('not_allowed')],
    // ::1 だけ
    ['::2', no('not_allowed')],
    ['::1:0', no('not_allowed')],
    ['1::1', no('not_allowed')],
    // fd7a:115c:a1e0::/48
    ['fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff', no('not_allowed')],
    ['fd7a:115c:a1e0::', ok(6, 'fd7a:115c:a1e0::')],
    [
      'fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff',
      ok(6, 'fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff'),
    ],
    ['fd7a:115c:a1e1::', no('not_allowed')],
    ['fd7a:115d:a1e0::1', no('not_allowed')],
  ];
  for (const [host, expected] of cases)
    assert.deepEqual(listenAddressDecision(host), expected, host);
});

test('other addresses, zone indexes and non-addresses are refused', () => {
  const cases = [
    ['192.168.1.10', no('not_allowed')],
    ['10.0.0.1', no('not_allowed')],
    ['0.0.0.1', no('not_allowed')],
    ['255.255.255.255', no('not_allowed')],
    ['::ffff:192.168.1.10', no('not_allowed')],
    ['::ffff:c0a8:10a', no('not_allowed')],
    // IPv4-compatible（廃止）と NAT64 は IPv4-mapped ではない。
    ['::127.0.0.1', no('not_allowed')],
    ['::7f00:1', no('not_allowed')],
    ['64:ff9b::7f00:1', no('not_allowed')],
    ['fe80::1', no('not_allowed')],
    ['fd00::1', no('not_allowed')],
    // zone つきは許可の範囲の中でも受け付けない。
    ['fe80::1%en0', no('not_allowed')],
    ['::1%lo0', no('not_allowed')],
    ['fd7a:115c:a1e0::1%utun3', no('not_allowed')],
    ['127.0.0.1%1', no('not_allowed')],
    ['::ffff:0:0%1', no('not_allowed')],
    ['%en0', no('not_ip_address')],
    ['localhost', no('not_ip_address')],
    ['', no('not_ip_address')],
    ['127.0.0.01', no('not_ip_address')],
    ['127.0.0', no('not_ip_address')],
    ['127.0.0.1.', no('not_ip_address')],
    ['256.0.0.1', no('not_ip_address')],
    [' 127.0.0.1', no('not_ip_address')],
    ['[::1]', no('not_ip_address')],
    [':::', no('not_ip_address')],
    ['::1::', no('not_ip_address')],
    [':1::', no('not_ip_address')],
    ['1::2:', no('not_ip_address')],
    ['1:2:3:4:5:6:7:8:9', no('not_ip_address')],
    ['1:2:3:4:5:6:7:8::', no('not_ip_address')],
    ['1:2:3:4:5:6:7', no('not_ip_address')],
    ['12345::1', no('not_ip_address')],
    ['g::1', no('not_ip_address')],
    ['::ffff:127.0.0.256', no('not_ip_address')],
    ['::ffff:127.0.0.1:1', no('not_ip_address')],
    ['1:2:3:4:5:6:7:1.2.3.4', no('not_ip_address')],
  ];
  for (const [host, expected] of cases)
    assert.deepEqual(listenAddressDecision(host), expected, host);
});

test('IPv6 text is parsed into groups and formatted in the RFC 5952 form', () => {
  assert.deepEqual(parseIpv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    parseIpv6('1:2:3:4:5:6:1.2.3.4'),
    [1, 2, 3, 4, 5, 6, 0x102, 0x304],
  );
  assert.deepEqual(parseIpv6('1:2:3:4:5:6:7::'), [1, 2, 3, 4, 5, 6, 7, 0]);
  assert.equal(parseIpv6('1.2.3.4'), null);
  assert.equal(formatIpv6([0, 0, 0, 0, 0, 0, 0, 0]), '::');
  assert.equal(formatIpv6([0, 0, 0, 0, 0, 0, 0, 1]), '::1');
  assert.equal(formatIpv6([1, 0, 0, 0, 0, 0, 0, 0]), '1::');
  // 1 つだけの 0 の組は省略しない。同じ長さの並びは先のものを省略する。
  assert.equal(formatIpv6([1, 0, 2, 3, 4, 5, 6, 7]), '1:0:2:3:4:5:6:7');
  assert.equal(formatIpv6([1, 0, 0, 2, 0, 0, 3, 4]), '1::2:0:0:3:4');
  assert.equal(formatIpv6([1, 0, 0, 2, 0, 0, 0, 4]), '1:0:0:2::4');
  assert.equal(
    formatIpv6([0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 1]),
    'fd7a:115c:a1e0::1',
  );
});
