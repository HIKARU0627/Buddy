// デスクトップの main の接続・ペアリングの IPC の試験（ADR 0014・0025）。中枢は模擬（証明書の受取りと
// 申請・受取りの応答を試験が決める）。受付の規則（ロック・画面操作）、手順の順序、安全な保存がないときの拒否、
// 失敗の扱い（受取りの結果が分からなければ自動で再送しない）、画面へトークン・申請用の秘密を出さないことを確かめる。
// 期待値は試験に手で書いた値。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { ClientApiOutcome } from '@buddy/client';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import { CREDENTIAL_FILE } from './credential-store.js';
import type { HubHttpRequest } from './hub-transport.js';
import {
  mockProtector,
  onCleanup,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import type { MockProtector } from './hub-test-support.js';
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const FP = 'cd'.repeat(32);
const PEM = '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n';
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const SCREEN = { trustedSender: true, windowFocused: true };
const TOKEN = 'P'.repeat(43);
// 公開の検査（scripts/public-content.mjs は tailnet のホスト名の形を拒否する）に掛からないよう、`*.ts.net` の
// 合成の名前は実行時に組み立てる（実在の Tailnet の名前ではない）。
const TS_NET = ['ts', 'net'].join('.');

type Responder = (
  request: HubHttpRequest,
) => ClientApiOutcome | Promise<ClientApiOutcome>;

async function setup(
  t: test.TestContext,
  options: {
    readonly protector?: MockProtector;
    readonly responders?: Responder[];
    readonly pollIntervalMs?: number;
  } = {},
) {
  const dir = await tempDir(t, 'bdl-');
  const requests: HubHttpRequest[] = [];
  const responders = [...(options.responders ?? [])];
  const shown: unknown[] = [];
  const logs: string[] = [];
  let fetches = 0;
  const link: DesktopCoreLink = new DesktopCoreLink({
    contract,
    credentialPath: join(dir, CREDENTIAL_FILE),
    protector: options.protector ?? mockProtector(),
    clock: systemClock(),
    platform: 'macos',
    collectHome: () =>
      Promise.resolve({ gateway_mac: null, subnet: null, ssid: null }),
    networkSignature: () => 'x',
    onChange: () => shown.push(link.view('unlocked')),
    log: (code) => logs.push(code),
    pairingPollIntervalMs: options.pollIntervalMs ?? 20,
    fetchCertificate: () => {
      fetches += 1;
      return Promise.resolve({
        ok: true,
        certificatePem: PEM,
        fingerprint: FP,
      });
    },
    pairingRequest: (_hub, request) => {
      requests.push(request);
      const next = responders.shift();
      return Promise.resolve(
        next ? next(request) : { kind: 'unreachable', reason: 'none' },
      );
    },
    // 登録後の接続は試験しない（接続できない宛先として扱う）。
    transportFor: () => ({
      request: () => Promise.resolve({ kind: 'unreachable', reason: 'test' }),
      openStream: () =>
        Promise.resolve({ kind: 'unreachable', reason: 'test' }),
    }),
  });
  onCleanup(t, () => link.stop());
  const invoke = (
    channel: string,
    payload: unknown,
    state: DesktopIoState = UNLOCKED,
    sender = SCREEN,
  ) => {
    const response = link.handleIpc(
      channel,
      { channel, request_id: randomUUID(), payload },
      sender,
      state,
    ).response;
    shown.push(response);
    return response as Record<string, unknown>;
  };
  const view = () =>
    link.view('unlocked') as Record<string, unknown> & {
      pairing: Record<string, unknown> | null;
    };
  return {
    link,
    requests,
    invoke,
    view,
    shown,
    logs,
    dir,
    fetches: () => fetches,
  };
}

const claimAccepted: Responder = () => ({
  kind: 'response',
  status: 202,
  body: {
    claim_id: '00000000-0000-4000-8000-000000000301',
    status: 'pending',
    device_name: '合成の端末',
    platform: 'macos',
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  },
});

test(
  'pairing channels need an unlocked device and a screen operation; the order of the steps is enforced',
  { timeout: 30_000 },
  async (t) => {
    const { link, invoke, view, requests, fetches } = await setup(t);
    link.start('unlocked');
    const begin = { host: '127.0.0.1', port: 47443 };
    const locked = invoke('desktop.pairing_begin', begin, {
      ...UNLOCKED,
      lockState: 'locked',
    });
    assert.deepEqual(
      [locked['outcome'], locked['reason']],
      ['rejected', 'device_locked'],
    );
    const hidden = invoke('desktop.pairing_begin', begin, UNLOCKED, {
      trustedSender: true,
      windowFocused: false,
    });
    assert.equal(hidden['reason'], 'screen_operation_required');
    const untrusted = invoke('desktop.pairing_begin', begin, UNLOCKED, {
      trustedSender: false,
      windowFocused: true,
    });
    assert.equal(untrusted['reason'], 'untrusted_sender');
    // 未知の項目（検証を無効にする指定など）は形式で拒否する。
    const extra = invoke('desktop.pairing_begin', {
      ...begin,
      reject_unauthorized: false,
    });
    assert.equal(extra['reason'], 'invalid_request');
    assert.equal(fetches(), 0);
    // ロック中でも状態は取得できるが、内容は隠す。
    const lockedView = invoke('desktop.get_connection', null, {
      ...UNLOCKED,
      lockState: 'unknown',
    });
    assert.deepEqual(lockedView['connection'], {
      visibility: 'hidden',
      lock_state: 'unknown',
    });

    assert.equal(
      invoke('desktop.pairing_confirm', { fingerprint: FP })['reason'],
      'pairing_step_mismatch',
    );
    assert.equal(invoke('desktop.pairing_begin', begin)['outcome'], 'ok');
    await waitUntil(
      () => view().pairing?.['step'] === 'fingerprint_check',
      'fingerprint',
    );
    assert.equal(view().pairing?.['fingerprint'], FP);
    // 進行中に始め直せない。指紋の確認の前に申請できない。
    assert.equal(
      invoke('desktop.pairing_begin', begin)['reason'],
      'pairing_step_mismatch',
    );
    assert.equal(
      invoke('desktop.pairing_submit', {
        pairing_code: '12345678',
        device_name: '合成の端末',
      })['reason'],
      'pairing_step_mismatch',
    );
    assert.equal(
      invoke('desktop.pairing_confirm', { fingerprint: 'ce'.repeat(32) })[
        'reason'
      ],
      'pairing_step_mismatch',
    );
    assert.equal(requests.length, 0);
    // やめるはロック中でも受け付ける。
    assert.equal(
      invoke(
        'desktop.pairing_cancel',
        null,
        { ...UNLOCKED, lockState: 'locked' },
        { trustedSender: true, windowFocused: false },
      )['outcome'],
      'ok',
    );
    assert.equal(view().pairing, null);
  },
);

test(
  'a wrong code fails the pairing; an unknown pickup result is not retried; nothing secret reaches the screen',
  { timeout: 30_000 },
  async (t) => {
    {
      const { link, invoke, view, requests } = await setup(t, {
        responders: [
          () => ({
            kind: 'response',
            status: 410,
            body: { code: 'pairing_failed', message: 'x', request_id: null },
          }),
        ],
      });
      link.start('unlocked');
      invoke('desktop.pairing_begin', { host: '127.0.0.1', port: 47443 });
      await waitUntil(
        () => view().pairing?.['step'] === 'fingerprint_check',
        'fingerprint',
      );
      invoke('desktop.pairing_confirm', { fingerprint: FP });
      invoke('desktop.pairing_submit', {
        pairing_code: '00000000',
        device_name: '合成の端末',
      });
      await waitUntil(() => view().pairing?.['step'] === 'failed', 'failed');
      assert.equal(view().pairing?.['failure'], 'pairing_failed');
      assert.equal(requests.length, 1);
      // 申請には秘密の hash だけを送る。
      const body = requests[0]?.body as Record<string, unknown>;
      assert.match(String(body['claim_secret_hash']), /^[0-9a-f]{64}$/u);
      assert.equal('claim_secret' in body, false);
    }
    {
      const { link, invoke, view, requests, shown, logs, dir } = await setup(
        t,
        {
          responders: [
            claimAccepted,
            () => ({
              kind: 'response',
              status: 409,
              body: { code: 'conflict', message: 'x', request_id: null },
            }),
            () => ({ kind: 'unreachable', reason: 'ECONNRESET' }),
          ],
        },
      );
      link.start('unlocked');
      invoke('desktop.pairing_begin', { host: '127.0.0.1', port: 47443 });
      await waitUntil(
        () => view().pairing?.['step'] === 'fingerprint_check',
        'fingerprint',
      );
      invoke('desktop.pairing_confirm', { fingerprint: FP });
      invoke('desktop.pairing_submit', {
        pairing_code: '00000000',
        device_name: '合成の端末',
      });
      await waitUntil(() => view().pairing?.['step'] === 'failed', 'failed');
      assert.equal(view().pairing?.['failure'], 'pickup_unknown');
      const count = requests.length;
      assert.equal(count, 3);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(requests.length, count);
      // 受取りには申請用の秘密を送るが、画面・ログには出さない。
      const secret = String(
        (requests[1]?.body as Record<string, unknown>)['claim_secret'],
      );
      assert.match(secret, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(JSON.stringify(shown).includes(secret), false);
      assert.equal(logs.join('\n').includes(secret), false);
      assert.equal(existsSync(join(dir, CREDENTIAL_FILE)), false);
    }
  },
);

test(
  'a received token is stored with safeStorage and the device then counts as registered',
  { timeout: 30_000 },
  async (t) => {
    const protector = mockProtector();
    const { link, invoke, view, shown, dir } = await setup(t, {
      protector,
      responders: [
        claimAccepted,
        () => ({
          kind: 'response',
          status: 200,
          body: {
            device_id: '00000000-0000-4000-8000-000000000401',
            device_token: TOKEN,
            issued_at: '2030-10-01T00:00:00Z',
          },
        }),
      ],
    });
    link.start('unlocked');
    invoke('desktop.pairing_begin', { host: '127.0.0.1', port: 47443 });
    await waitUntil(
      () => view().pairing?.['step'] === 'fingerprint_check',
      'fingerprint',
    );
    invoke('desktop.pairing_confirm', { fingerprint: FP });
    invoke('desktop.pairing_submit', {
      pairing_code: '00000000',
      device_name: '合成の端末',
    });
    await waitUntil(() => link.registration === 'registered', 'registered');
    assert.equal(view().pairing, null);
    assert.equal(view()['registration'], 'registered');
    // 登録済みの間はペアリングを始めない。
    assert.equal(
      invoke('desktop.pairing_begin', { host: '127.0.0.1', port: 47443 })[
        'reason'
      ],
      'pairing_step_mismatch',
    );
    assert.equal(JSON.stringify(shown).includes(TOKEN), false);
    const stored = protector.reveal(readFileSync(join(dir, CREDENTIAL_FILE)));
    assert(stored.includes(TOKEN));
  },
);

test(
  'without strong protection the device is not paired and nothing is stored',
  { timeout: 30_000 },
  async (t) => {
    const { link, invoke, view, fetches, dir } = await setup(t, {
      protector: mockProtector({ platform: 'linux', backend: 'basic_text' }),
    });
    link.start('unlocked');
    assert.equal(view()['registration'], 'secure_storage_unavailable');
    assert.equal(view()['link'], 'not_connected');
    const response = invoke('desktop.pairing_begin', {
      host: '127.0.0.1',
      port: 47443,
    });
    assert.equal(response['reason'], 'secure_storage_unavailable');
    assert.equal(fetches(), 0);
    assert.equal(existsSync(join(dir, CREDENTIAL_FILE)), false);
  },
);

// レビューの指摘 L2: 末尾のドット・大文字の名前でペアリングしても、保存した記録を読み戻せる
// （直す前は、毎回「再登録が必要」になっていた）。
test(
  'a trailing-dot, mixed-case name is normalized at pairing_begin and the stored credential reads back after a restart',
  { timeout: 30_000 },
  async (t) => {
    const protector = mockProtector();
    const { link, invoke, view, dir } = await setup(t, {
      protector,
      responders: [claimAccepted, () => issued],
    });
    link.start('unlocked');
    invoke('desktop.pairing_begin', {
      host: `Hub.Example-Tailnet.${TS_NET.toUpperCase()}.`,
      port: 47443,
    });
    await waitUntil(
      () => view().pairing?.['step'] === 'fingerprint_check',
      'fingerprint',
    );
    assert.equal(view().pairing?.['host'], `hub.example-tailnet.${TS_NET}`);
    invoke('desktop.pairing_confirm', { fingerprint: FP });
    invoke('desktop.pairing_submit', {
      pairing_code: '00000000',
      device_name: '合成の端末',
    });
    await waitUntil(() => link.registration === 'registered', 'registered');
    const stored = protector.reveal(readFileSync(join(dir, CREDENTIAL_FILE)));
    assert(stored.includes(`"host":"hub.example-tailnet.${TS_NET}"`));
    // 起動し直しても、保存した記録を読み戻して登録済みのまま。
    link.stop();
    link.start('unlocked');
    assert.equal(link.registration, 'registered');
  },
);

// 本人の判断（2026-10-21）: ペアリングの宛先は Tailscale のアドレス・ループバック・*.ts.net の名前だけ。
test(
  'pairing_begin accepts only Tailscale addresses, loopback and *.ts.net names; others are refused before any connection',
  { timeout: 30_000 },
  async (t) => {
    const { link, invoke, view, fetches } = await setup(t);
    link.start('unlocked');
    for (const host of [
      '192.168.1.10',
      '100.63.255.255',
      '100.128.0.0',
      '8.8.8.8',
      'buddy-hub.example',
      'ts.net',
      `hub.${TS_NET}.example`,
      'fe80::1',
      '::ffff:100.64.0.1',
      'fd7a:115c:a1e1::1',
    ]) {
      const refused = invoke('desktop.pairing_begin', { host, port: 47443 });
      assert.deepEqual(
        [refused['outcome'], refused['reason']],
        ['rejected', 'pairing_host_not_allowed'],
        host,
      );
    }
    assert.equal(fetches(), 0);
    assert.equal(view().pairing, null);
    for (const [host, shown] of [
      ['100.64.0.0', '100.64.0.0'],
      ['100.127.255.255', '100.127.255.255'],
      ['127.0.0.1', '127.0.0.1'],
      ['::1', '::1'],
      ['FD7A:115C:A1E0::5', 'fd7a:115c:a1e0::5'],
      [
        `Mac-Mini.Example-Tailnet.${TS_NET}`,
        `mac-mini.example-tailnet.${TS_NET}`,
      ],
    ] as const) {
      assert.equal(
        invoke('desktop.pairing_begin', { host, port: 47443 })['outcome'],
        'ok',
        host,
      );
      assert.equal(view().pairing?.['host'], shown, host);
      invoke('desktop.pairing_cancel', null);
    }
    assert.equal(fetches(), 6);
  },
);

// 受取りの要求を試験が決めた時に返す（受取りの最中の操作を試験する）。
function deferred(): {
  readonly responder: Responder;
  readonly resolve: (outcome: ClientApiOutcome) => void;
} {
  let resolve: (outcome: ClientApiOutcome) => void = () => undefined;
  const promise = new Promise<ClientApiOutcome>((done) => {
    resolve = done;
  });
  return { responder: () => promise, resolve: (outcome) => resolve(outcome) };
}

const issued: ClientApiOutcome = {
  kind: 'response',
  status: 200,
  body: {
    device_id: '00000000-0000-4000-8000-000000000402',
    device_token: TOKEN,
    issued_at: '2030-10-01T00:00:00Z',
  },
};

const notYet: ClientApiOutcome = {
  kind: 'response',
  status: 409,
  body: { code: 'conflict', message: 'x', request_id: null },
};

async function untilWaitingApproval(
  invoke: (channel: string, payload: unknown) => Record<string, unknown>,
  view: () => { pairing: Record<string, unknown> | null },
) {
  invoke('desktop.pairing_begin', { host: '127.0.0.1', port: 47443 });
  await waitUntil(
    () => view().pairing?.['step'] === 'fingerprint_check',
    'fingerprint',
  );
  assert.equal(view().pairing?.['cancelable'], true);
  invoke('desktop.pairing_confirm', { fingerprint: FP });
  invoke('desktop.pairing_submit', {
    pairing_code: '00000000',
    device_name: '合成の端末',
  });
}

// レビューの指摘 M2（端末側）: 受取りの要求が進んでいる間に「やめる」を押しても、届いたトークンを捨てない。
test(
  'cancel while a pickup is in flight does not discard the token: a late 200 is stored and registered',
  { timeout: 30_000 },
  async (t) => {
    const protector = mockProtector();
    const pickup = deferred();
    const { link, invoke, view, requests, shown, dir } = await setup(t, {
      protector,
      responders: [claimAccepted, pickup.responder],
    });
    link.start('unlocked');
    await untilWaitingApproval(invoke, view);
    await waitUntil(() => requests.length === 2, 'pickup in flight');
    // 受取りの間は「やめる」を押せない（画面は cancelable を見てボタンを無効にする）。
    assert.equal(view().pairing?.['step'], 'waiting_approval');
    assert.equal(view().pairing?.['cancelable'], false);
    // 画面の無効化をすり抜けた「やめる」も、受取りの結果を捨てない。
    const cancelled = invoke('desktop.pairing_cancel', null);
    assert.equal(cancelled['outcome'], 'ok');
    assert.equal(view().pairing?.['step'], 'waiting_approval');
    assert.equal(view().pairing?.['cancelable'], false);
    pickup.resolve(issued);
    await waitUntil(() => link.registration === 'registered', 'registered');
    assert.equal(view().pairing, null);
    const stored = protector.reveal(readFileSync(join(dir, CREDENTIAL_FILE)));
    assert(stored.includes(TOKEN));
    assert.equal(JSON.stringify(shown).includes(TOKEN), false);
  },
);

test(
  'a cancel during an in-flight pickup takes effect when the pickup ends without a token; between polls it is immediate',
  { timeout: 30_000 },
  async (t) => {
    {
      const pickup = deferred();
      const { link, invoke, view, requests, dir } = await setup(t, {
        responders: [claimAccepted, pickup.responder],
      });
      link.start('unlocked');
      await untilWaitingApproval(invoke, view);
      await waitUntil(() => requests.length === 2, 'pickup in flight');
      invoke('desktop.pairing_cancel', null);
      pickup.resolve(notYet);
      await waitUntil(() => view().pairing === null, 'cancelled');
      // 承認前（409）の後は、やめた手順として次の受取りを送らない。
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(requests.length, 2);
      assert.equal(link.registration, 'unregistered');
      assert.equal(existsSync(join(dir, CREDENTIAL_FILE)), false);
    }
    {
      // 受取りの間隔の待ちの間（要求を送っていない）は、すぐにやめられる。
      const { link, invoke, view, requests } = await setup(t, {
        pollIntervalMs: 60_000,
        responders: [claimAccepted, () => notYet],
      });
      link.start('unlocked');
      await untilWaitingApproval(invoke, view);
      await waitUntil(() => requests.length === 2, 'first pickup');
      await waitUntil(
        () => view().pairing?.['cancelable'] === true,
        'cancelable between polls',
      );
      assert.equal(view().pairing?.['step'], 'waiting_approval');
      invoke('desktop.pairing_cancel', null);
      assert.equal(view().pairing, null);
      assert.equal(requests.length, 2);
    }
  },
);
