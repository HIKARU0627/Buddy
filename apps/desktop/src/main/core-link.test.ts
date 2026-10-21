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

type Responder = (request: HubHttpRequest) => ClientApiOutcome;

async function setup(
  t: test.TestContext,
  options: {
    readonly protector?: MockProtector;
    readonly responders?: Responder[];
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
    pairingPollIntervalMs: 20,
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
