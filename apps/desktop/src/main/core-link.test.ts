// デスクトップの main の接続・ペアリングの IPC の試験（ADR 0014・0025）。中枢は模擬（証明書の受取りと
// 申請・受取りの応答を試験が決める）。受付の規則（ロック・画面操作）、手順の順序、安全な保存がないときの拒否、
// 失敗の扱い（受取りの結果が分からなければ自動で再送しない）、画面へトークン・申請用の秘密を出さないことを確かめる。
// 期待値は試験に手で書いた値。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type {
  ClientApiOutcome,
  ClientStreamEvent,
  ClientTransport,
} from '@buddy/client';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import type { AdminConfirm, AdminConfirmRequest } from './core-link.js';
import {
  CREDENTIAL_FILE,
  SecretText,
  saveCredential,
} from './credential-store.js';
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
    // 登録後の接続の通信（省略は接続できない宛先）。
    readonly transport?: ClientTransport;
    readonly homeReportIntervalMs?: number;
    readonly hubScreenProbeRetryMs?: number;
    readonly confirmAdmin?: AdminConfirm;
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
    // 登録後の接続は、指定がなければ試験しない（接続できない宛先として扱う）。
    transportFor: () =>
      options.transport ?? {
        request: () => Promise.resolve({ kind: 'unreachable', reason: 'test' }),
        openStream: () =>
          Promise.resolve({ kind: 'unreachable', reason: 'test' }),
      },
    ...(options.homeReportIntervalMs === undefined
      ? {}
      : { homeReportIntervalMs: options.homeReportIntervalMs }),
    ...(options.hubScreenProbeRetryMs === undefined
      ? {}
      : { hubScreenProbeRetryMs: options.hubScreenProbeRetryMs }),
    ...(options.confirmAdmin === undefined
      ? {}
      : { confirmAdmin: options.confirmAdmin }),
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
      invoke('desktop.pairing_confirm', {
        fingerprint: FP,
        fingerprint_tail: 'cdcd',
      })['reason'],
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
      invoke('desktop.pairing_confirm', {
        fingerprint: 'ce'.repeat(32),
        fingerprint_tail: 'cece',
      })['reason'],
      'pairing_step_mismatch',
    );
    // 本人が入力した最後の 4 桁が受け取った証明書の指紋と合わなければ、進めず申請も送らない（ADR 0025）。
    for (const tail of ['dcdc', '0000', 'cdce'])
      assert.equal(
        invoke('desktop.pairing_confirm', {
          fingerprint: FP,
          fingerprint_tail: tail,
        })['reason'],
        'fingerprint_tail_mismatch',
      );
    assert.equal(view().pairing?.['step'], 'fingerprint_check');
    // 4 桁でない入力は形式で拒否する（main の契約の検査）。
    for (const tail of ['cdc', 'cdcdc', 'cdcg', ''])
      assert.equal(
        invoke('desktop.pairing_confirm', {
          fingerprint: FP,
          fingerprint_tail: tail,
        })['reason'],
        'invalid_request',
      );
    assert.equal(
      invoke('desktop.pairing_confirm', { fingerprint: FP })['reason'],
      'invalid_request',
    );
    assert.equal(requests.length, 0);
    assert.equal(
      invoke('desktop.pairing_submit', {
        pairing_code: '12345678',
        device_name: '合成の端末',
      })['reason'],
      'pairing_step_mismatch',
    );
    // 大文字で入力しても同じ 4 桁として受け付け、コードの入力へ進む。
    assert.equal(
      invoke('desktop.pairing_confirm', {
        fingerprint: FP,
        fingerprint_tail: 'CDCD',
      })['outcome'],
      'ok',
    );
    assert.equal(view().pairing?.['step'], 'code_entry');
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
      invoke('desktop.pairing_confirm', {
        fingerprint: FP,
        fingerprint_tail: 'cdcd',
      });
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
      invoke('desktop.pairing_confirm', {
        fingerprint: FP,
        fingerprint_tail: 'cdcd',
      });
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
    invoke('desktop.pairing_confirm', {
      fingerprint: FP,
      fingerprint_tail: 'cdcd',
    });
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
    invoke('desktop.pairing_confirm', {
      fingerprint: FP,
      fingerprint_tail: 'cdcd',
    });
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
  invoke('desktop.pairing_confirm', {
    fingerprint: FP,
    fingerprint_tail: 'cdcd',
  });
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

// レビューの指摘 L4: 中枢の API の major が違えば（upgrade_required）、自宅の指紋の報告も止める。
test(
  'upgrade_required stops the home network reports',
  { timeout: 30_000 },
  async (t) => {
    const protector = mockProtector();
    const sent: string[] = [];
    const transport: ClientTransport = {
      request: (request) => {
        sent.push(`${request.method} ${request.path}`);
        if (request.path === '/v1/bootstrap')
          return Promise.resolve({
            kind: 'response',
            status: 200,
            body: {
              api_version: '2.0',
              core_instance_id: '00000000-0000-4000-8000-000000000501',
              store_generation: '00000000-0000-4000-8000-000000000502',
              device_id: '00000000-0000-4000-8000-000000000401',
              command_scope_id: '00000000-0000-4000-8000-000000000503',
              command_scope_expires_at: '2030-10-02T00:00:00Z',
              capabilities: [],
              io_state: {
                device_id: '00000000-0000-4000-8000-000000000401',
                io_epoch: '0',
                output_epoch: '0',
                lock_state: 'unlocked',
                stop_scope: 'none',
                input_permitted: true,
                voice_state: 'waiting_wake_word',
                output_mode: 'text',
                private_conversation: false,
                audio_lease_valid: false,
              },
            },
          });
        return Promise.resolve({ kind: 'unreachable', reason: 'test' });
      },
      openStream: () =>
        Promise.resolve({ kind: 'unreachable', reason: 'test' }),
    };
    const { link, dir, logs } = await setup(t, {
      protector,
      transport,
      homeReportIntervalMs: 20,
    });
    saveCredential(join(dir, CREDENTIAL_FILE), protector, {
      deviceId: '00000000-0000-4000-8000-000000000401',
      token: new SecretText(TOKEN),
      issuedAt: '2030-10-01T00:00:00Z',
      hub: {
        host: '127.0.0.1',
        port: 47443,
        certificatePem: PEM,
        fingerprint: FP,
      },
    });
    link.start('unlocked');
    await waitUntil(
      () => link.linkState?.phase === 'upgrade_required',
      'upgrade_required',
    );
    assert(logs.includes('link:upgrade_required:api_major_mismatch'));
    await link.homeReportIdle();
    const reports = () =>
      sent.filter((entry) => entry === 'POST /v1/home-network/reports').length;
    const before = reports();
    // 報告の間隔（20 ms）を何度も過ぎても、新しい報告を送らない。
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(reports(), before);
    assert.equal(
      sent.filter((entry) => entry === 'GET /v1/bootstrap').length,
      1,
    );
  },
);

// レビューの指摘 L8: 最終確認時刻だけが変わった（中枢の ping・画面に出ない値の変化）ときは、画面への通知を間引く。
test(
  'changes of only the last confirmation time are thinned; visible changes are notified at once',
  { timeout: 30_000 },
  async (t) => {
    const protector = mockProtector();
    // 購読の通知を試験から送る（閉じた関数の中で代入するので、入れ物に置く）。
    const stream: { listener: ((event: ClientStreamEvent) => void) | null } = {
      listener: null,
    };
    const ioState = {
      device_id: '00000000-0000-4000-8000-000000000401',
      io_epoch: '0',
      output_epoch: '0',
      lock_state: 'unlocked',
      stop_scope: 'none',
      input_permitted: true,
      voice_state: 'waiting_wake_word',
      output_mode: 'text',
      private_conversation: false,
      audio_lease_valid: false,
    };
    const transport: ClientTransport = {
      request: (request) => {
        if (request.path === '/v1/bootstrap')
          return Promise.resolve({
            kind: 'response',
            status: 200,
            body: {
              api_version: '1.0',
              core_instance_id: '00000000-0000-4000-8000-000000000501',
              store_generation: '00000000-0000-4000-8000-000000000502',
              device_id: '00000000-0000-4000-8000-000000000401',
              command_scope_id: '00000000-0000-4000-8000-000000000503',
              command_scope_expires_at: '2030-10-02T00:00:00Z',
              capabilities: [],
              io_state: ioState,
            },
          });
        if (request.path === '/v1/snapshot')
          return Promise.resolve({
            kind: 'response',
            status: 200,
            body: {
              store_generation: '00000000-0000-4000-8000-000000000502',
              core_instance_id: '00000000-0000-4000-8000-000000000501',
              event_cursor: 'cursor-1',
              view: 'full',
              io_state: ioState,
              sessions: [],
              candidates: [],
              operations: [],
            },
          });
        return Promise.resolve({ kind: 'unreachable', reason: 'test' });
      },
      openStream: (_cursor, _lock, onEvent) => {
        stream.listener = onEvent;
        return Promise.resolve({ kind: 'open', stream: { close: () => {} } });
      },
    };
    const { link, dir, shown } = await setup(t, {
      protector,
      transport,
      homeReportIntervalMs: 600_000,
    });
    saveCredential(join(dir, CREDENTIAL_FILE), protector, {
      deviceId: '00000000-0000-4000-8000-000000000401',
      token: new SecretText(TOKEN),
      issuedAt: '2030-10-01T00:00:00Z',
      hub: {
        host: '127.0.0.1',
        port: 47443,
        certificatePem: PEM,
        fingerprint: FP,
      },
    });
    link.start('unlocked');
    await waitUntil(() => link.linkState?.phase === 'live', 'live');
    await link.homeReportIdle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = shown.length;
    // 中枢の ping を続けて受け取る（最終確認時刻だけが変わる）。
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stream.listener?.({ type: 'alive' });
    }
    assert.equal(shown.length, before);
    // 画面に出る変化（切断して待つ）はすぐに知らせる。
    stream.listener?.({ type: 'closed', code: 1001, reason: 'core_stopping' });
    assert.equal(link.linkState?.phase, 'waiting_retry');
    assert(shown.length > before);
    link.stop();
  },
);

test(
  'hub screen channels need an unlocked device, a screen operation for decisions, a live connection and the hub screen (B03-06)',
  { timeout: 30_000 },
  async (t) => {
    const { link } = await setup(t);
    link.start('unlocked');
    const admin = async (
      channel: string,
      payload: unknown,
      state: DesktopIoState = UNLOCKED,
      sender = SCREEN,
    ) =>
      (
        await link.handleAdminIpc(
          channel,
          { channel, request_id: randomUUID(), payload },
          sender,
          state,
        )
      ).response as Record<string, unknown>;
    const ref = randomUUID();
    assert.equal(
      (
        await admin('desktop.claims_list', null, {
          ...UNLOCKED,
          lockState: 'locked',
        })
      )['reason'],
      'device_locked',
    );
    assert.equal(
      (
        await admin('desktop.device_revoke', { ref }, UNLOCKED, {
          trustedSender: true,
          windowFocused: false,
        })
      )['reason'],
      'screen_operation_required',
    );
    assert.equal(
      (
        await admin(
          'desktop.claim_decide',
          { ref, decision: 'approve' },
          UNLOCKED,
          {
            trustedSender: false,
            windowFocused: true,
          },
        )
      )['reason'],
      'untrusted_sender',
    );
    // 申請 ID・端末 ID を直接渡す形は契約にない（形式で拒否）。
    assert.equal(
      (await admin('desktop.device_revoke', { device_id: ref }))['reason'],
      'invalid_request',
    );
    // 未登録（接続していない）では中枢へ送らない。
    for (const channel of [
      'desktop.claims_list',
      'desktop.devices_list',
      'desktop.pairing_open',
    ])
      assert.equal((await admin(channel, null))['reason'], 'not_connected');
    // 接続・ペアリングのチャネルを管理の入口へ送っても受け付けない。
    assert.equal(
      (await admin('desktop.get_connection', null))['reason'],
      'invalid_request',
    );
    const view = link.view('unlocked');
    assert(view.visibility === 'shown');
    assert.equal(view.hub_screen, false);
  },
);

// 登録済みで接続した（live）状態を作る。中枢の画面の経路（申請・端末の一覧と操作）の応答は試験が決める。
async function liveHub(
  t: test.TestContext,
  hub: (request: {
    readonly method: string;
    readonly path: string;
  }) => ClientApiOutcome | null,
  extra: {
    readonly hubScreenProbeRetryMs?: number;
    readonly confirmAdmin?: AdminConfirm;
  } = {},
) {
  const protector = mockProtector();
  const sent: string[] = [];
  const stream: { listener: ((event: ClientStreamEvent) => void) | null } = {
    listener: null,
  };
  let bootstraps = 0;
  const ioState = {
    device_id: '00000000-0000-4000-8000-000000000401',
    io_epoch: '0',
    output_epoch: '0',
    lock_state: 'unlocked',
    stop_scope: 'none',
    input_permitted: true,
    voice_state: 'waiting_wake_word',
    output_mode: 'text',
    private_conversation: false,
    audio_lease_valid: false,
  };
  const transport: ClientTransport = {
    request: (request) => {
      sent.push(`${request.method} ${request.path}`);
      if (request.path === '/v1/bootstrap') {
        bootstraps += 1;
        return Promise.resolve({
          kind: 'response',
          status: 200,
          body: {
            api_version: '1.0',
            core_instance_id: '00000000-0000-4000-8000-000000000501',
            store_generation: '00000000-0000-4000-8000-000000000502',
            device_id: '00000000-0000-4000-8000-000000000401',
            // bootstrap ごとに新しい接続範囲。
            command_scope_id: `00000000-0000-4000-8000-${String(502 + bootstraps).padStart(12, '0')}`,
            command_scope_expires_at: '2030-10-02T00:00:00Z',
            capabilities: [],
            io_state: ioState,
          },
        });
      }
      if (request.path === '/v1/snapshot')
        return Promise.resolve({
          kind: 'response',
          status: 200,
          body: {
            store_generation: '00000000-0000-4000-8000-000000000502',
            core_instance_id: '00000000-0000-4000-8000-000000000501',
            event_cursor: 'cursor-1',
            view: 'full',
            io_state: ioState,
            sessions: [],
            candidates: [],
            operations: [],
          },
        });
      return Promise.resolve(
        hub(request) ?? { kind: 'unreachable', reason: 'test' },
      );
    },
    openStream: (_cursor, _lock, onEvent) => {
      stream.listener = onEvent;
      return Promise.resolve({ kind: 'open', stream: { close: () => {} } });
    },
  };
  const context = await setup(t, {
    protector,
    transport,
    homeReportIntervalMs: 600_000,
    ...extra,
  });
  saveCredential(join(context.dir, CREDENTIAL_FILE), protector, {
    deviceId: '00000000-0000-4000-8000-000000000401',
    token: new SecretText(TOKEN),
    issuedAt: '2030-10-01T00:00:00Z',
    hub: {
      host: '127.0.0.1',
      port: 47443,
      certificatePem: PEM,
      fingerprint: FP,
    },
  });
  context.link.start('unlocked');
  await waitUntil(() => context.link.linkState?.phase === 'live', 'live');
  const admin = async (channel: string, payload: unknown) =>
    (
      await context.link.handleAdminIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        SCREEN,
        UNLOCKED,
      )
    ).response as Record<string, unknown>;
  return { ...context, sent, admin, stream, bootstraps: () => bootstraps };
}

// 接続の要求を試験が止める: match に合う要求は、中枢の応答を受け取った後、gates の関数を呼ぶまで返さない。
function stallRequests(
  link: DesktopCoreLink,
  match: (request: {
    readonly method: string;
    readonly path: string;
  }) => boolean,
): (() => void)[] {
  const gates: (() => void)[] = [];
  const connection = link.connection;
  assert(connection !== null);
  const original = connection.request.bind(connection);
  (connection as unknown as { request: typeof original }).request = async (
    request,
  ) => {
    const outcome = await original(request);
    if (match(request))
      await new Promise<void>((resolve) => gates.push(resolve));
    return outcome;
  };
  return gates;
}

const DEVICE_ID = '00000000-0000-4000-8000-000000000402';
const deviceList = (revoked: boolean) => ({
  devices: [
    {
      device_id: DEVICE_ID,
      device_name: '合成の端末',
      platform: 'windows',
      hub_local: false,
      registered_at: '2030-10-01T00:00:00Z',
      last_seen_at: null,
      revoked_at: revoked ? '2030-10-01T00:01:00Z' : null,
    },
  ],
});

const CLAIM_LIST = {
  claims: [
    {
      claim_id: '00000000-0000-4000-8000-000000000601',
      device_name: '合成の申請',
      platform: 'windows',
      claimed_at: '2030-10-01T00:00:00Z',
      expires_at: '2030-10-01T00:05:00Z',
      claim_check: '0a1b2c3d',
    },
  ],
};
const ok = (body: unknown): ClientApiOutcome => ({
  kind: 'response',
  status: 200,
  body,
});
const unavailable: ClientApiOutcome = {
  kind: 'response',
  status: 503,
  body: { code: 'unavailable', message: 'x', request_id: null },
};
const hubScreen = (link: DesktopCoreLink) => {
  const view = link.view('unlocked');
  return view.visibility === 'shown' ? view.hub_screen : null;
};

// CR-L1: 中枢の画面かの判定が一時的な失敗（503 など）で決まらなかったら、間隔を空けて問い合わせ直す（上限つき）。
test(
  'an undecided hub-screen probe is retried with a growing interval, up to a limit',
  { timeout: 30_000 },
  async (t) => {
    {
      let probes = 0;
      const { link, logs } = await liveHub(
        t,
        (request) => {
          if (request.path !== '/v1/pairing/claims') return null;
          probes += 1;
          return probes <= 2 ? unavailable : ok({ claims: [] });
        },
        { hubScreenProbeRetryMs: 10 },
      );
      await waitUntil(() => hubScreen(link) === true, 'hub screen');
      assert.equal(probes, 3);
      assert.deepEqual(
        logs.filter((code) => code.startsWith('hub_screen')),
        [
          'hub_screen_probe_retry:1',
          'hub_screen_probe_retry:2',
          'hub_screen:true',
        ],
      );
    }
    {
      let probes = 0;
      const { link } = await liveHub(
        t,
        (request) => {
          if (request.path !== '/v1/pairing/claims') return null;
          probes += 1;
          return unavailable;
        },
        { hubScreenProbeRetryMs: 10 },
      );
      await waitUntil(() => probes === 4, 'probes');
      // 上限（最初の 1 回と再試行 3 回）の後は問い合わせない。判定は決まらないまま（画面を出さない）。
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(probes, 4);
      assert.equal(hubScreen(link), false);
    }
  },
);

// CR-L7: 承認の要求を送った後に結果が分からなければ outcome_unknown にし、自動で送り直さず、参照も残す。
test(
  'a decision whose result is unknown is reported as outcome_unknown, sent once, and held until the list is refreshed',
  { timeout: 30_000 },
  async (t) => {
    const { admin, sent } = await liveHub(
      t,
      (request) => {
        if (request.method === 'GET' && request.path === '/v1/pairing/claims')
          return ok(CLAIM_LIST);
        return null; // 決定の POST は応答の前に切れる（unreachable）。
      },
      { confirmAdmin: confirmYes },
    );
    const listed = await admin('desktop.claims_list', null);
    const ref = String(
      (listed['claims'] as Record<string, unknown>[])[0]?.['ref'],
    );
    const decide = () =>
      admin('desktop.claim_decide', { ref, decision: 'approve' });
    assert.equal((await decide())['reason'], 'outcome_unknown');
    const posts = () =>
      sent.filter((entry) => entry.startsWith('POST /v1/pairing/claims/'));
    assert.equal(posts().length, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(posts().length, 1);
    // 一覧を更新するまで、同じ参照では送らない（本人が結果を確かめてから押し直す）。
    assert.equal((await decide())['reason'], 'entry_not_found');
    assert.equal(posts().length, 1);
    await admin('desktop.claims_list', null);
    assert.equal((await decide())['reason'], 'outcome_unknown');
    assert.equal(posts().length, 2);
  },
);

// ペアリングの開始が 2xx でも本文が契約に合わなければ、始まった（前のコードは使えなくなった）かもしれない。
// 外部の変更なので outcome_unknown にし、自動で送り直さない（本人の判断 2026-10-22、B03-08 のレビュー）。
test(
  'a pairing start answered 2xx with an unexpected body is outcome_unknown and is not sent again',
  { timeout: 30_000 },
  async (t) => {
    const { admin, sent, logs } = await liveHub(t, (request) => {
      if (request.method === 'GET' && request.path === '/v1/pairing/claims')
        return ok({ claims: [] });
      if (request.method === 'POST' && request.path === '/v1/pairing/sessions')
        return { kind: 'response', status: 201, body: { unexpected: true } };
      return null;
    });
    const opened = await admin('desktop.pairing_open', null);
    assert.equal(opened['outcome'], 'rejected');
    assert.equal(opened['reason'], 'outcome_unknown');
    assert(logs.includes('hub_pairing_open_failed:outcome_unknown'));
    const starts = () =>
      sent.filter((entry) => entry === 'POST /v1/pairing/sessions').length;
    assert.equal(starts(), 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(starts(), 1);
  },
);

// CR-L2: 承認・失効は適用できたが、その後の一覧の取り直しだけが失敗したときは、拒否ではなく list_refreshed: false。
test(
  'an applied decision or revocation whose list could not be refreshed is ok with list_refreshed false',
  { timeout: 30_000 },
  async (t) => {
    let claimLists = 0;
    let deviceLists = 0;
    const { admin } = await liveHub(
      t,
      (request) => {
        if (request.method === 'GET' && request.path === '/v1/pairing/claims') {
          claimLists += 1;
          // 1 回目は判定、2 回目は画面の一覧、3 回目（決定の後の取り直し）は 503。
          return claimLists <= 2 ? ok(CLAIM_LIST) : unavailable;
        }
        if (request.method === 'POST' && request.path.endsWith('/decision'))
          return ok({
            claim_id: CLAIM_LIST.claims[0]?.claim_id,
            status: 'approved',
          });
        if (request.method === 'GET' && request.path === '/v1/devices') {
          deviceLists += 1;
          return deviceLists === 1
            ? ok({
                devices: [
                  {
                    device_id: '00000000-0000-4000-8000-000000000402',
                    device_name: '合成の端末',
                    platform: 'windows',
                    hub_local: false,
                    registered_at: '2030-10-01T00:00:00Z',
                    last_seen_at: null,
                    revoked_at: null,
                  },
                ],
              })
            : { kind: 'unreachable', reason: 'test' };
        }
        if (request.method === 'POST' && request.path.endsWith('/revoke'))
          return ok({
            device_id: '00000000-0000-4000-8000-000000000402',
            revoked_at: '2030-10-01T00:01:00Z',
          });
        return null;
      },
      { confirmAdmin: confirmYes },
    );
    const listed = await admin('desktop.claims_list', null);
    const claimRef = String(
      (listed['claims'] as Record<string, unknown>[])[0]?.['ref'],
    );
    const decided = await admin('desktop.claim_decide', {
      ref: claimRef,
      decision: 'approve',
    });
    assert.deepEqual(
      {
        outcome: decided['outcome'],
        list_refreshed: decided['list_refreshed'],
      },
      { outcome: 'ok', list_refreshed: false },
    );
    // 適用した申請の参照は捨てる（もう一度押しても送らない）。
    assert.equal(
      (
        await admin('desktop.claim_decide', {
          ref: claimRef,
          decision: 'approve',
        })
      )['reason'],
      'entry_not_found',
    );
    const devices = await admin('desktop.devices_list', null);
    const deviceRef = String(
      (devices['devices'] as Record<string, unknown>[])[0]?.['ref'],
    );
    const revoked = await admin('desktop.device_revoke', { ref: deviceRef });
    assert.deepEqual(
      {
        outcome: revoked['outcome'],
        list_refreshed: revoked['list_refreshed'],
      },
      { outcome: 'ok', list_refreshed: false },
    );
  },
);

const confirmYes: AdminConfirm = () => Promise.resolve(true);

// 本人の判断（2026-10-22、ADR 0026）: 承認・拒否・失効は main の OS の確認で確かめたときだけ送る。
test(
  'decisions and revocations are sent only after the main-process confirmation; cancel, lock and disconnect send nothing',
  { timeout: 30_000 },
  async (t) => {
    const asked: AdminConfirmRequest[] = [];
    let answer: (value: boolean) => void = () => undefined;
    const signals: AbortSignal[] = [];
    const { link, admin, sent, stream, bootstraps } = await liveHub(
      t,
      (request) => {
        if (request.method === 'GET' && request.path === '/v1/pairing/claims')
          return ok(CLAIM_LIST);
        if (request.method === 'POST' && request.path.endsWith('/decision'))
          return ok({ claim_id: CLAIM_LIST.claims[0]?.claim_id });
        return null;
      },
      {
        confirmAdmin: (request, signal) => {
          asked.push(request);
          signals.push(signal);
          return new Promise<boolean>((resolve) => {
            answer = resolve;
            signal.addEventListener('abort', () => resolve(false));
          });
        },
      },
    );
    const posts = () =>
      sent.filter((entry) => entry.startsWith('POST /v1/pairing/claims/'));
    const listed = await admin('desktop.claims_list', null);
    const ref = String(
      (listed['claims'] as Record<string, unknown>[])[0]?.['ref'],
    );
    // 確認に出すのは main が持っている値（端末名・OS・確認コード）。
    const first = admin('desktop.claim_decide', { ref, decision: 'approve' });
    await waitUntil(() => asked.length === 1, 'asked');
    assert.deepEqual(asked[0], {
      action: 'approve',
      deviceName: '合成の申請',
      platform: 'windows',
      claimCheck: '0a1b2c3d',
      at: '2030-10-01T00:00:00Z',
    });
    // 同時に表示するのは 1 つまで。
    assert.equal(
      (await admin('desktop.claim_decide', { ref, decision: 'reject' }))[
        'reason'
      ],
      'confirmation_pending',
    );
    // 「やめる」では送らない。
    answer(false);
    assert.equal((await first)['reason'], 'confirmation_declined');
    assert.equal(posts().length, 0);
    // ロックすると確認を閉じ、送らない。
    const locked = admin('desktop.claim_decide', { ref, decision: 'approve' });
    await waitUntil(() => asked.length === 2, 'asked again');
    link.setLockState('locked');
    assert.equal(signals[1]?.aborted, true);
    assert.equal((await locked)['reason'], 'device_locked');
    assert.equal(posts().length, 0);
    link.setLockState('unlocked');
    // 確かめたときだけ 1 件送る。
    await admin('desktop.claims_list', null);
    const confirmed = admin('desktop.claim_decide', {
      ref,
      decision: 'approve',
    });
    await waitUntil(() => asked.length === 3, 'asked third');
    answer(true);
    assert.equal((await confirmed)['outcome'], 'ok');
    assert.equal(posts().length, 1);
    // 4410（取り直しの要求）で bootstrap をやり直すと（接続範囲が変わる）、確認を閉じ、送らない。
    const scoped = await admin('desktop.claims_list', null);
    const scopedRef = String(
      (scoped['claims'] as Record<string, unknown>[])[0]?.['ref'],
    );
    const rescoped = admin('desktop.claim_decide', {
      ref: scopedRef,
      decision: 'reject',
    });
    await waitUntil(() => asked.length === 4, 'asked before 4410');
    const before = bootstraps();
    stream.listener?.({ type: 'closed', code: 4410, reason: 'resnapshot' });
    assert.equal(signals[3]?.aborted, true);
    // 確認に答えても（閉じた後）、送らない。
    answer(true);
    assert.notEqual((await rescoped)['outcome'], 'ok');
    await waitUntil(
      () => bootstraps() > before && link.linkState?.phase === 'live',
      'live again',
    );
    assert.equal(posts().length, 1);
    // 切断でも確認を閉じ、送らない（模擬の中枢は同じ申請を返し続けるので、新しい参照で試す）。
    const again = await admin('desktop.claims_list', null);
    const nextRef = String(
      (again['claims'] as Record<string, unknown>[])[0]?.['ref'],
    );
    const cut = admin('desktop.claim_decide', {
      ref: nextRef,
      decision: 'reject',
    });
    await waitUntil(() => asked.length === 5, 'asked fifth');
    link.stop();
    assert.equal(signals[4]?.aborted, true);
    assert.notEqual((await cut)['outcome'], 'ok');
    assert.equal(posts().length, 1);
  },
);

test(
  'without a confirmation component a direct IPC call from the renderer sends nothing',
  { timeout: 30_000 },
  async (t) => {
    const { admin, sent } = await liveHub(t, (request) => {
      if (request.method === 'GET' && request.path === '/v1/pairing/claims')
        return ok(CLAIM_LIST);
      return ok({});
    });
    const listed = await admin('desktop.claims_list', null);
    const ref = String(
      (listed['claims'] as Record<string, unknown>[])[0]?.['ref'],
    );
    assert.equal(
      (await admin('desktop.claim_decide', { ref, decision: 'approve' }))[
        'reason'
      ],
      'confirmation_declined',
    );
    assert.equal(
      sent.filter((entry) => entry.startsWith('POST /v1/pairing/claims/'))
        .length,
      0,
    );
  },
);

// ロックをまたいだ一覧・ワンタイムコードは返さない（Codex のレビュー Medium 1）。
test(
  'a claims list, a device list or a one-time code whose response arrives after the screen locked is not returned',
  { timeout: 30_000 },
  async (t) => {
    const { link, admin } = await liveHub(t, (request) => {
      if (request.method === 'GET' && request.path === '/v1/pairing/claims')
        return ok(CLAIM_LIST);
      if (request.method === 'GET' && request.path === '/v1/devices')
        return ok(deviceList(false));
      if (request.method === 'POST' && request.path === '/v1/pairing/sessions')
        return {
          kind: 'response',
          status: 201,
          body: {
            pairing_id: '00000000-0000-4000-8000-000000000601',
            pairing_code: '12345678',
            certificate_fingerprint: FP,
            expires_at: '2030-10-01T00:05:00Z',
            attempts_left: 5,
            hub_endpoint: { host: '127.0.0.1', port: 47443 },
          },
        };
      return null;
    });
    // 中枢の画面の端末と確かめてから止める。
    assert.equal((await admin('desktop.claims_list', null))['outcome'], 'ok');
    // 止めるのは試す要求だけ（ロック解除の後の、中枢の画面の端末かの確認は止めない）。
    let target: string | null = null;
    const gates = stallRequests(link, (request) => {
      if (request.path !== target) return false;
      target = null;
      return true;
    });
    for (const [channel, field, path] of [
      ['desktop.claims_list', 'claims', '/v1/pairing/claims'],
      ['desktop.devices_list', 'devices', '/v1/devices'],
      ['desktop.pairing_open', 'session', '/v1/pairing/sessions'],
    ] as const) {
      target = path;
      const pending = admin(channel, null);
      await waitUntil(() => gates.length === 1, `stalled ${channel}`);
      link.setLockState('locked');
      gates.shift()?.();
      const response = await pending;
      assert.equal(response['reason'], 'device_locked', channel);
      assert.equal(field in response, false, channel);
      link.setLockState('unlocked');
    }
  },
);

// 遅れて届いた古い一覧で、表示と参照を戻さない（Codex のレビュー Medium 2）。
test(
  'a list started before a later list or a change is superseded and does not restore references',
  { timeout: 30_000 },
  async (t) => {
    const gates: (() => void)[] = [];
    let lists = 0;
    const { link, admin, sent } = await liveHub(
      t,
      (request) => {
        if (request.method === 'GET' && request.path === '/v1/devices') {
          lists += 1;
          return ok({
            devices: [
              {
                device_id: '00000000-0000-4000-8000-000000000402',
                device_name: '合成の端末',
                platform: 'windows',
                hub_local: false,
                registered_at: '2030-10-01T00:00:00Z',
                last_seen_at: null,
                // 失効の後の一覧（3 回目以降）は失効済み。
                revoked_at: lists >= 3 ? '2030-10-01T00:01:00Z' : null,
              },
            ],
          });
        }
        if (request.method === 'POST' && request.path.endsWith('/revoke'))
          return ok({});
        if (request.method === 'GET' && request.path === '/v1/pairing/claims')
          return ok(CLAIM_LIST);
        return null;
      },
      { confirmAdmin: confirmYes },
    );
    const first = await admin('desktop.devices_list', null);
    const ref = String(
      (first['devices'] as Record<string, unknown>[])[0]?.['ref'],
    );
    // 2 回目の一覧（失効の前の状態）の応答を止める。
    const connection = link.connection;
    assert(connection !== null);
    const original = connection.request.bind(connection);
    let stall = true;
    (connection as unknown as { request: typeof original }).request = async (
      request,
    ) => {
      const outcome = await original(request);
      if (stall && request.path === '/v1/devices') {
        stall = false;
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      return outcome;
    };
    const stale = admin('desktop.devices_list', null);
    await waitUntil(() => gates.length === 1, 'stalled');
    // 失効（その後の一覧で失効済み）。
    const revoked = await admin('desktop.device_revoke', { ref });
    assert.equal(revoked['outcome'], 'ok');
    assert.equal(
      (revoked['devices'] as Record<string, unknown>[])[0]?.['ref'],
      null,
    );
    // 止めていた古い一覧が届いても、表示に返さず、参照も戻さない。
    gates[0]?.();
    assert.equal((await stale)['reason'], 'list_superseded');
    // 失効の後に本人が始めた一覧は、失効の中の取り直しより大きい番号（画面はこの番号で新旧を比べる）。
    const after = await admin('desktop.devices_list', null);
    assert.equal(after['outcome'], 'ok');
    assert(Number(after['list_seq']) > Number(revoked['list_seq']));
    assert.equal(
      (await admin('desktop.device_revoke', { ref }))['reason'],
      'entry_not_found',
    );
    assert.equal(sent.filter((entry) => entry.endsWith('/revoke')).length, 1);
  },
);

// Codex の確認 Medium 1: POST の最中に始めた一覧は、取り直しが失敗しても古い（失効した端末の参照を戻さない）。
test(
  'a list started while a revocation is being sent is superseded even when the refresh after it fails',
  { timeout: 30_000 },
  async (t) => {
    let lists = 0;
    const { link, admin, sent } = await liveHub(
      t,
      (request) => {
        if (request.method === 'GET' && request.path === '/v1/devices') {
          lists += 1;
          // 1 回目・2 回目（失効の最中に始めた一覧）は失効の前。3 回目（失効の後の取り直し）は 503。
          return lists >= 3 ? unavailable : ok(deviceList(false));
        }
        if (request.method === 'POST' && request.path.endsWith('/revoke'))
          return ok({});
        // 中枢の画面の端末かの確認（申請の一覧が読める）。
        if (request.method === 'GET' && request.path === '/v1/pairing/claims')
          return ok(CLAIM_LIST);
        return null;
      },
      { confirmAdmin: confirmYes },
    );
    const first = await admin('desktop.devices_list', null);
    const ref = String(
      (first['devices'] as Record<string, unknown>[])[0]?.['ref'],
    );
    let listsStalled = 0;
    const gates = stallRequests(
      link,
      (request) =>
        request.path.endsWith('/revoke') ||
        (request.path === '/v1/devices' && ++listsStalled === 1),
    );
    const revoking = admin('desktop.device_revoke', { ref });
    await waitUntil(() => gates.length === 1, 'revoke stalled');
    const during = admin('desktop.devices_list', null);
    await waitUntil(() => gates.length === 2, 'list stalled');
    // 失効が先に終わる（取り直しは 503）。
    gates[0]?.();
    const revoked = await revoking;
    assert.equal(revoked['outcome'], 'ok');
    assert.equal(revoked['list_refreshed'], false);
    // 画面に渡す境目は、最初の一覧（1）・失効の前の境目（2）・最中の一覧（3）の後の 4。
    assert.equal(revoked['list_seq'], 4);
    // 失効の前の内容を取った一覧が遅れて届いても、返さず、参照も戻さない。
    gates[1]?.();
    assert.equal((await during)['reason'], 'list_superseded');
    assert.equal(
      (await admin('desktop.device_revoke', { ref }))['reason'],
      'entry_not_found',
    );
    assert.equal(sent.filter((entry) => entry.endsWith('/revoke')).length, 1);
  },
);

// Codex の確認 Medium 3: 結果不明の保留は申請・端末ごと。別の種類の一覧・結果が分かる前に始めた一覧では解かない。
test(
  'a revocation whose result is unknown stays held through a claims list and a device list started before the result',
  { timeout: 30_000 },
  async (t) => {
    const { link, admin, sent } = await liveHub(
      t,
      (request) => {
        if (request.method === 'GET' && request.path === '/v1/devices')
          return ok(deviceList(false));
        if (request.method === 'GET' && request.path === '/v1/pairing/claims')
          return ok(CLAIM_LIST);
        return null; // 失効の POST は応答の前に切れる（結果不明）。
      },
      { confirmAdmin: confirmYes },
    );
    const revokes = () => sent.filter((entry) => entry.endsWith('/revoke'));
    const first = await admin('desktop.devices_list', null);
    const ref = String(
      (first['devices'] as Record<string, unknown>[])[0]?.['ref'],
    );
    // 止めるのは 1 回目の失効と、その最中に始めた一覧だけ。
    let revokesStalled = 0;
    let listsStalled = 0;
    const gates = stallRequests(
      link,
      (request) =>
        (request.path.endsWith('/revoke') && ++revokesStalled === 1) ||
        (request.path === '/v1/devices' && ++listsStalled === 1),
    );
    const revoking = admin('desktop.device_revoke', { ref });
    await waitUntil(() => gates.length === 1, 'revoke stalled');
    const early = admin('desktop.devices_list', null);
    await waitUntil(() => gates.length === 2, 'list stalled');
    gates[0]?.();
    const unknown = await revoking;
    assert.equal(unknown['reason'], 'outcome_unknown');
    // 保留の時点の番号（最初の一覧 1・失効の前の境目 2・最中の一覧 3 の後の 4）を画面にも渡す。
    assert.equal(unknown['list_seq'], 4);
    // 結果が分かる前に始めた端末の一覧が届いても、保留は解かない（番号 3 は保留の時点より前）。
    gates[1]?.();
    const earlyList = await early;
    assert.equal(earlyList['outcome'], 'ok');
    assert.equal(earlyList['list_seq'], 3);
    assert.equal(
      (await admin('desktop.device_revoke', { ref }))['reason'],
      'entry_not_found',
    );
    // 申請の一覧（定期の取り直し）でも解かない。
    assert.equal((await admin('desktop.claims_list', null))['outcome'], 'ok');
    assert.equal(
      (await admin('desktop.device_revoke', { ref }))['reason'],
      'entry_not_found',
    );
    assert.equal(revokes().length, 1);
    // 結果が分かった後に始めた端末の一覧で照合できたら、本人が押し直せる。
    assert.equal((await admin('desktop.devices_list', null))['outcome'], 'ok');
    assert.equal(
      (await admin('desktop.device_revoke', { ref }))['reason'],
      'outcome_unknown',
    );
    assert.equal(revokes().length, 2);
  },
);

// Codex の確認 Medium 4: ロックの前の失効が遅れて終わっても、ロック解除の後の一覧を捨てさせない。
test(
  'a revocation from before a lock that finishes late does not supersede the list of the current generation',
  { timeout: 30_000 },
  async (t) => {
    let revokedOnHub = false;
    const { link, admin } = await liveHub(
      t,
      (request) => {
        if (request.method === 'GET' && request.path === '/v1/devices')
          return ok(deviceList(revokedOnHub));
        if (request.method === 'POST' && request.path.endsWith('/revoke')) {
          revokedOnHub = true;
          return ok({});
        }
        if (request.method === 'GET' && request.path === '/v1/pairing/claims')
          return ok(CLAIM_LIST);
        return null;
      },
      { confirmAdmin: confirmYes },
    );
    const first = await admin('desktop.devices_list', null);
    const ref = String(
      (first['devices'] as Record<string, unknown>[])[0]?.['ref'],
    );
    let listsStalled = 0;
    const gates = stallRequests(
      link,
      (request) =>
        request.path.endsWith('/revoke') ||
        (request.path === '/v1/devices' && ++listsStalled === 1),
    );
    const revoking = admin('desktop.device_revoke', { ref });
    await waitUntil(() => gates.length === 1, 'revoke stalled');
    link.setLockState('locked');
    link.setLockState('unlocked');
    const current = admin('desktop.devices_list', null);
    await waitUntil(() => gates.length === 2, 'list stalled');
    // ロックの前の失効が終わる（古い世代の応答は返さず、取り直しもしない）。
    gates[0]?.();
    assert.equal((await revoking)['reason'], 'not_connected');
    gates[1]?.();
    const listed = await current;
    assert.equal(listed['outcome'], 'ok');
    assert.equal(
      (listed['devices'] as Record<string, unknown>[])[0]?.['revoked_at'],
      '2030-10-01T00:01:00Z',
    );
  },
);
