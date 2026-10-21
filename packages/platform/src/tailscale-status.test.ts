// 中枢側の Tailscale の状態の取得（ADR 0022）。模擬の runner に合成の `tailscale status --json` を渡し、
// 実機の tailscale は呼ばない。アドレスは文書用（RFC 5737・RFC 3849）と Tailscale の CGNAT の範囲の合成値。
// 期待値（経路の種類・理由）は手で書いた値。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockCommandRunner } from './runner.js';
import type { CommandResult } from './runner.js';
import {
  TAILSCALE_COMMANDS,
  UNAVAILABLE_TAILSCALE_STATUS,
  createMockTailscaleStatusSource,
  createTailscaleStatusSource,
  fetchTailscaleStatus,
  findPeerPath,
  normalizeRemoteAddress,
  parseTailscaleStatus,
} from './tailscale-status.js';

// 合成の状態。ピアは 4 つ（直接・DERP・ピアの中継・経路不明）。
const STATUS = {
  Version: '1.90.0-synthetic',
  BackendState: 'Running',
  Self: {
    HostName: 'synthetic-hub',
    TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
  },
  Peer: {
    'nodekey:direct': {
      HostName: 'synthetic-laptop',
      TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0::2'],
      CurAddr: '192.0.2.23:41641',
      Relay: 'tok',
      Online: true,
    },
    'nodekey:derp': {
      HostName: 'synthetic-phone',
      TailscaleIPs: ['100.64.0.3'],
      CurAddr: '',
      Relay: 'tok',
    },
    'nodekey:peer-relay': {
      TailscaleIPs: ['100.64.0.4'],
      CurAddr: '',
      Relay: 'tok',
      PeerRelay: '198.51.100.9:7777',
    },
    'nodekey:unknown': {
      TailscaleIPs: ['100.64.0.5'],
    },
  },
};

const ok = (stdout: string): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
});

test(
  'peers are found by the remote address and classified by CurAddr, Relay and PeerRelay',
  { timeout: 10_000 },
  () => {
    const status = parseTailscaleStatus(JSON.stringify(STATUS));
    assert.equal(status.ok, true);
    assert.deepEqual(findPeerPath(status, '100.64.0.2'), {
      kind: 'peer',
      cur_addr: '192.0.2.23:41641',
      relay: 'tok',
      peer_relay: '',
    });
    // IPv4 射影の IPv6・IPv6 の Tailscale のアドレス・大文字でも同じピア。
    assert.equal(findPeerPath(status, '::ffff:100.64.0.2').kind, 'peer');
    assert.equal(findPeerPath(status, 'FD7A:115C:A1E0::2').kind, 'peer');
    assert.deepEqual(findPeerPath(status, '100.64.0.3'), {
      kind: 'peer',
      cur_addr: '',
      relay: 'tok',
      peer_relay: '',
    });
    assert.deepEqual(findPeerPath(status, '100.64.0.4'), {
      kind: 'peer',
      cur_addr: '',
      relay: 'tok',
      peer_relay: '198.51.100.9:7777',
    });
    // CurAddr・Relay がない（省略）は空として扱い、直接経路にしない。
    assert.deepEqual(findPeerPath(status, '100.64.0.5'), {
      kind: 'peer',
      cur_addr: '',
      relay: '',
      peer_relay: '',
    });
    // 中枢自身・知らないアドレス・空はピアではない。
    assert.deepEqual(findPeerPath(status, '100.64.0.1'), {
      kind: 'peer_not_found',
    });
    assert.deepEqual(findPeerPath(status, '192.0.2.23'), {
      kind: 'peer_not_found',
    });
    assert.deepEqual(findPeerPath(status, ''), { kind: 'peer_not_found' });
    assert.equal(normalizeRemoteAddress('fe80::1%en0'), 'fe80::1');
  },
);

test(
  'unreadable, stopped or ambiguous states are not treated as a direct path',
  { timeout: 10_000 },
  () => {
    const unavailable = { kind: 'unavailable' };
    for (const [output, reason] of [
      ['not json', 'tailscale_output_invalid'],
      ['[]', 'tailscale_output_invalid'],
      [
        JSON.stringify({ ...STATUS, BackendState: 'Stopped' }),
        'tailscale_not_running',
      ],
      [
        JSON.stringify({ ...STATUS, BackendState: 'NeedsLogin' }),
        'tailscale_not_running',
      ],
      [JSON.stringify({ ...STATUS, Peer: [] }), 'tailscale_output_invalid'],
      [
        JSON.stringify({
          BackendState: 'Running',
          Peer: { a: { TailscaleIPs: '100.64.0.2' } },
        }),
        'tailscale_output_invalid',
      ],
      [
        JSON.stringify({
          BackendState: 'Running',
          Peer: { a: { TailscaleIPs: ['100.64.0.2'], CurAddr: 41641 } },
        }),
        'tailscale_output_invalid',
      ],
    ] as const) {
      const status = parseTailscaleStatus(output);
      assert.deepEqual(status, { ok: false, reason }, output);
      assert.deepEqual(findPeerPath(status, '100.64.0.2'), unavailable);
    }
    // ピアが一つもない（Peer が null）は読めるが、ピアは見つからない。
    const empty = parseTailscaleStatus(
      JSON.stringify({ BackendState: 'Running', Peer: null }),
    );
    assert.deepEqual(empty, { ok: true, peers: [] });
    // 同じアドレスのピアが二つ（読み違い）は見つからない扱い。
    const duplicated = parseTailscaleStatus(
      JSON.stringify({
        BackendState: 'Running',
        Peer: {
          a: { TailscaleIPs: ['100.64.0.2'], CurAddr: '192.0.2.23:1' },
          b: { TailscaleIPs: ['100.64.0.2'], CurAddr: '' },
        },
      }),
    );
    assert.deepEqual(findPeerPath(duplicated, '100.64.0.2'), {
      kind: 'peer_not_found',
    });
  },
);

test(
  'the command candidates are tried in order and failures become unavailable',
  { timeout: 10_000 },
  async () => {
    // 先頭の候補が起動できず（exitCode null）、2 番目で成功する。
    const runner = createMockCommandRunner((command) =>
      command === TAILSCALE_COMMANDS[1]
        ? ok(JSON.stringify(STATUS))
        : { exitCode: null, stdout: '', stderr: '' },
    );
    const status = await fetchTailscaleStatus(runner);
    assert.equal(status.ok, true);
    assert.deepEqual(
      runner.calls.map((call) => [call.command, call.args]),
      [
        [TAILSCALE_COMMANDS[0], ['status', '--json']],
        [TAILSCALE_COMMANDS[1], ['status', '--json']],
      ],
    );
    // 終了コードが 0 でなければ次の候補へ進まずに unavailable。
    const failing = createMockCommandRunner(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'synthetic failure',
    }));
    assert.deepEqual(await fetchTailscaleStatus(failing), {
      ok: false,
      reason: 'tailscale_status_failed',
    });
    assert.equal(failing.calls.length, 1);
    // どの候補も起動できない。
    const missing = createMockCommandRunner(() => ({
      exitCode: null,
      stdout: '',
      stderr: '',
    }));
    assert.deepEqual(await fetchTailscaleStatus(missing), {
      ok: false,
      reason: 'tailscale_command_unavailable',
    });
    assert.equal(missing.calls.length, TAILSCALE_COMMANDS.length);
    // runner が例外を投げても unavailable（例外を外へ出さない）。
    const throwing = {
      run: () => Promise.reject(new Error('synthetic')),
    };
    assert.deepEqual(await fetchTailscaleStatus(throwing, ['tailscale']), {
      ok: false,
      reason: 'tailscale_command_failed',
    });
  },
);

test(
  'the status is kept for a short time and fetched again afterwards',
  { timeout: 10_000 },
  async () => {
    let output = JSON.stringify(STATUS);
    const runner = createMockCommandRunner(() => ok(output));
    let mono = 1_000;
    const source = createTailscaleStatusSource({
      runner,
      commands: ['tailscale'],
      ttlMs: 5_000,
      monotonicNow: () => mono,
    });
    assert.equal((await source.peerPath('100.64.0.2')).kind, 'peer');
    // 同時の要求は一度の実行にまとめる。保持の間は取り直さない。
    await Promise.all([
      source.peerPath('100.64.0.2'),
      source.peerPath('100.64.0.3'),
    ]);
    mono += 4_999;
    await source.peerPath('100.64.0.2');
    assert.equal(runner.calls.length, 1);
    // 保持の時間を過ぎたら取り直す。止まっていれば unavailable。
    output = JSON.stringify({ ...STATUS, BackendState: 'Stopped' });
    mono += 1;
    assert.deepEqual(await source.peerPath('100.64.0.2'), {
      kind: 'unavailable',
    });
    assert.equal(runner.calls.length, 2);
    assert.equal(source.lastFailure, 'tailscale_not_running');
    // 単調時計が戻ったら保持した状態を使わない。捨てた後も取り直す。
    output = JSON.stringify(STATUS);
    mono -= 10;
    assert.equal((await source.peerPath('100.64.0.2')).kind, 'peer');
    assert.equal(runner.calls.length, 3);
    source.invalidate();
    await source.peerPath('100.64.0.2');
    assert.equal(runner.calls.length, 4);
    assert.equal(source.lastFailure, null);
    // 0 なら毎回取り直す。
    const always = createTailscaleStatusSource({
      runner,
      commands: ['tailscale'],
      ttlMs: 0,
    });
    await always.peerPath('100.64.0.2');
    await always.peerPath('100.64.0.2');
    assert.equal(runner.calls.length, 6);
  },
);

test(
  'the mock and the unavailable default never run a command',
  { timeout: 10_000 },
  async () => {
    const mock = createMockTailscaleStatusSource(() => ({
      kind: 'peer_not_found',
    }));
    assert.deepEqual(await mock.peerPath('100.64.0.9'), {
      kind: 'peer_not_found',
    });
    assert.deepEqual(mock.calls, ['100.64.0.9']);
    assert.deepEqual(
      await UNAVAILABLE_TAILSCALE_STATUS.peerPath('100.64.0.9'),
      {
        kind: 'unavailable',
      },
    );
  },
);
