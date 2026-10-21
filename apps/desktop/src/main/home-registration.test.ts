// 中枢の画面の「自宅のネットワーク」の main の試験（B03-08、ADR 0022・0026）。
// - 伏せた表示（home-registration.ts）を、手で書いた期待値と比べる。
// - DesktopCoreLink の desktop.home_status・desktop.home_register を、模擬の中枢（試験が応答を決める通信）と
//   模擬の指紋の読み取りで確かめる: 受付の規則、参照、ネットワークが変わったときの拒否、結果が分からないときに
//   送り直さないこと、読み取りの失敗・時間切れ、画面・IPC・ログに MAC・SSID の生の値が出ないこと。
// MAC・SSID・アドレスは文書用の合成値（00:00:5e:00:53:xx・RFC 5737）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import type { ClientApiOutcome, ClientApiRequest } from '@buddy/client';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import {
  CREDENTIAL_FILE,
  SecretText,
  saveCredential,
} from './credential-store.js';
import {
  macTailOf,
  maskHomeObservation,
  sameFingerprint,
  ssidHintOf,
} from './home-registration.js';
import type { HomeObservation } from './home-reporter.js';
import {
  mockProtector,
  onCleanup,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const SCREEN = { trustedSender: true, windowFocused: true };
const FP = 'cd'.repeat(32);
const PEM = '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n';
const DEVICE = '00000000-0000-4000-8000-000000000e01';
const SCOPE = '00000000-0000-4000-8000-000000000e03';
const AT = '2030-10-05T00:00:00Z';
const HOME = {
  gateway_mac: '00:00:5e:00:53:01',
  subnet: '192.0.2.0/24',
  ssid: '合成の自宅',
};
// 生の値（画面・IPC・ログに出てはいけないもの）。
const RAW = [HOME.gateway_mac, HOME.ssid, '00:00:5e:00:53:02', '合成の別の家'];

test('the masked view keeps only the last two MAC octets, the subnet and the SSID length with its first character', () => {
  assert.equal(macTailOf('00:00:5e:00:53:01'), '53:01');
  assert.deepEqual(ssidHintOf('合成の自宅'), { first: '合', length: 5 });
  assert.deepEqual(ssidHintOf('abcd'), { first: 'a', length: 4 });
  // 3 文字以下は先頭の文字も出さない。
  assert.deepEqual(ssidHintOf('abc'), { first: null, length: 3 });
  assert.deepEqual(ssidHintOf('a'), { first: null, length: 1 });
  // 文字数はコードポイントで数える（サロゲートペアは 1 文字）。
  assert.deepEqual(ssidHintOf('🏠Home'), { first: '🏠', length: 5 });
  const ref = '00000000-0000-4000-8000-000000000e61';
  assert.deepEqual(maskHomeObservation(HOME, [], ref, AT), {
    ref,
    collected_at: AT,
    gateway_mac_tail: '53:01',
    subnet: '192.0.2.0/24',
    ssid_hint: { first: '合', length: 5 },
    ssid_unavailable_reason: null,
  });
  // SSID が取れない理由（@buddy/platform のコード）を画面の理由にまとめる。
  const noSsid = { ...HOME, ssid: null };
  assert.equal(
    maskHomeObservation(noSsid, ['ssid_redacted'], ref, AT)
      ?.ssid_unavailable_reason,
    'redacted',
  );
  assert.equal(
    maskHomeObservation(noSsid, ['ssid_ambiguous'], ref, AT)
      ?.ssid_unavailable_reason,
    'ambiguous',
  );
  assert.equal(
    maskHomeObservation(noSsid, [], ref, AT)?.ssid_unavailable_reason,
    'unavailable',
  );
  // MAC かサブネットが取れなければ参照を渡さない（登録できない）。
  assert.equal(
    maskHomeObservation({ ...HOME, gateway_mac: null }, [], ref, AT)?.ref,
    null,
  );
  assert.equal(
    maskHomeObservation({ ...HOME, subnet: null }, [], ref, AT)?.ref,
    null,
  );
  // どの要素も取れなければ読み取れなかった扱い。
  assert.equal(
    maskHomeObservation(
      { gateway_mac: null, subnet: null, ssid: null },
      ['platform_unsupported'],
      ref,
      AT,
    ),
    null,
  );
  assert.equal(sameFingerprint(HOME, { ...HOME }), true);
  assert.equal(sameFingerprint(HOME, { ...HOME, ssid: null }), false);
  // 伏せた表示は契約の形と意味の検査に通る。
  for (const observation of [
    maskHomeObservation(HOME, [], ref, AT),
    maskHomeObservation({ ...HOME, ssid: 'abc' }, [], ref, AT),
    maskHomeObservation(
      { ...HOME, gateway_mac: null, ssid: null },
      ['ssid_redacted'],
      ref,
      AT,
    ),
  ])
    assert.deepEqual(
      contract.responseErrors({
        request_id: randomUUID(),
        channel: 'desktop.home_status',
        outcome: 'ok',
        home: { registration: null, observation },
      }),
      [],
    );
});

interface HubState {
  // 中枢の登録（GET の応答）。PUT で置き換える。
  registration: Record<string, unknown> | null;
  // 中枢の画面の端末か（承認待ちの申請の一覧の経路が 200 か 403 か）。
  hubScreen: boolean;
  // PUT の応答を返さない（送った後に切れた）。
  dropPut: boolean;
}

async function liveLink(
  t: test.TestContext,
  options: { readonly homeCollectTimeoutMs?: number } = {},
) {
  const dir = await tempDir(t, 'bdhr-');
  const protector = mockProtector();
  const hub: HubState = { registration: null, hubScreen: true, dropPut: false };
  const sent: ClientApiRequest[] = [];
  const shown: unknown[] = [];
  const logs: string[] = [];
  // 試験が決めるこのマシンの指紋（'throw' は読み取りの失敗、'hang' は応答しない）。
  const network: { value: HomeObservation | 'throw' | 'hang' } = {
    value: { ...HOME, unavailable: [] },
  };
  const ioState = {
    device_id: DEVICE,
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
  const respond = (
    request: ClientApiRequest,
  ): ClientApiOutcome | Promise<ClientApiOutcome> => {
    const ok = (body: unknown, status = 200): ClientApiOutcome => ({
      kind: 'response',
      status,
      body,
    });
    if (request.path === '/v1/bootstrap')
      return ok({
        api_version: '1.0',
        core_instance_id: '00000000-0000-4000-8000-000000000e04',
        store_generation: '00000000-0000-4000-8000-000000000e05',
        device_id: DEVICE,
        command_scope_id: SCOPE,
        command_scope_expires_at: '2030-10-06T00:00:00Z',
        capabilities: [],
        io_state: ioState,
      });
    if (request.path === '/v1/snapshot')
      return ok({
        store_generation: '00000000-0000-4000-8000-000000000e05',
        core_instance_id: '00000000-0000-4000-8000-000000000e04',
        event_cursor: 'cursor-1',
        view: 'full',
        io_state: ioState,
        sessions: [],
        candidates: [],
        operations: [],
      });
    const notHubScreen = ok(
      {
        code: 'hub_screen_required',
        message: '合成の拒否',
        request_id: null,
        retryable: false,
      },
      403,
    );
    if (request.path === '/v1/pairing/claims')
      return hub.hubScreen ? ok({ claims: [] }) : notHubScreen;
    if (request.path === '/v1/home-network/reports')
      return ok({
        allowed: true,
        exempt: true,
        reasons: [],
        report_expires_at: null,
      });
    if (request.path === '/v1/home-network/registration') {
      if (!hub.hubScreen) return notHubScreen;
      if (request.method === 'GET')
        return ok({ registration: hub.registration });
      if (hub.dropPut) return { kind: 'unreachable', reason: 'test' };
      hub.registration = {
        subnet: request.body?.['subnet'],
        ssid_registered: request.body?.['ssid'] !== null,
        registered_at: '2030-10-05T00:10:00Z',
      };
      return ok(hub.registration);
    }
    return { kind: 'unreachable', reason: 'test' };
  };
  const link: DesktopCoreLink = new DesktopCoreLink({
    contract,
    credentialPath: join(dir, CREDENTIAL_FILE),
    protector,
    clock: systemClock(),
    platform: 'macos',
    collectHome: () => {
      const value = network.value;
      if (value === 'throw') return Promise.reject(new Error('synthetic'));
      if (value === 'hang') return new Promise<HomeObservation>(() => {});
      return Promise.resolve(value);
    },
    networkSignature: () => 'x',
    onChange: () => shown.push(link.view('unlocked')),
    log: (code) => logs.push(code),
    homeReportIntervalMs: 600_000,
    ...(options.homeCollectTimeoutMs === undefined
      ? {}
      : { homeCollectTimeoutMs: options.homeCollectTimeoutMs }),
    transportFor: () => ({
      request: (request) => {
        sent.push(request);
        return Promise.resolve(respond(request));
      },
      openStream: () =>
        Promise.resolve({ kind: 'open', stream: { close: () => {} } }),
    }),
  });
  onCleanup(t, () => link.stop());
  saveCredential(join(dir, CREDENTIAL_FILE), protector, {
    deviceId: DEVICE,
    token: new SecretText('P'.repeat(43)),
    issuedAt: '2030-10-01T00:00:00Z',
    hub: {
      host: '127.0.0.1',
      port: 47443,
      certificatePem: PEM,
      fingerprint: FP,
    },
  });
  const admin = async (
    channel: string,
    payload: unknown,
    state: DesktopIoState = UNLOCKED,
    sender = SCREEN,
  ) => {
    const { response } = await link.handleAdminIpc(
      channel,
      { channel, request_id: randomUUID(), payload },
      sender,
      state,
    );
    shown.push(response);
    return response as Record<string, unknown> & {
      home?: {
        registration: Record<string, unknown> | null;
        observation: Record<string, unknown> | null;
      };
      reason?: string;
    };
  };
  link.start('unlocked');
  await waitUntil(() => link.linkState?.phase === 'live', 'live');
  await link.homeReportIdle();
  const puts = () =>
    sent.filter(
      (request) =>
        request.method === 'PUT' &&
        request.path === '/v1/home-network/registration',
    );
  return { link, hub, network, sent, shown, logs, admin, puts };
}

function assertNoRawValues(shown: unknown[], logs: string[]): void {
  const ipc = JSON.stringify(shown);
  const log = logs.join('\n');
  for (const raw of RAW) {
    assert.equal(ipc.includes(raw), false, 'IPC shows a raw home value');
    assert.equal(log.includes(raw), false, 'log shows a raw home value');
  }
}

test(
  'home_status shows the registration and a masked view; home_register sends only the values shown, through a screen operation (B03-08)',
  { timeout: 30_000 },
  async (t) => {
    const { hub, network, sent, shown, logs, admin, puts } = await liveLink(t);
    const first = await admin('desktop.home_status', null);
    assert.equal(first['outcome'], 'ok');
    assert.equal(first.home?.registration, null);
    const observation = first.home?.observation;
    assert(observation);
    assert.match(String(observation['ref']), /^[0-9a-f-]{36}$/u);
    assert.equal(observation['gateway_mac_tail'], '53:01');
    assert.equal(observation['subnet'], '192.0.2.0/24');
    assert.deepEqual(observation['ssid_hint'], { first: '合', length: 5 });
    // 同じネットワークを読み取り直しても同じ参照（確認を開いている間に古くならない）。
    const again = await admin('desktop.home_status', null);
    assert.equal(again.home?.observation?.['ref'], observation['ref']);

    // 知らない参照・画面操作でない・ロック中は送らない。
    assert.equal(
      (await admin('desktop.home_register', { ref: randomUUID() })).reason,
      'entry_not_found',
    );
    assert.equal(
      (
        await admin(
          'desktop.home_register',
          { ref: observation['ref'] },
          UNLOCKED,
          {
            trustedSender: true,
            windowFocused: false,
          },
        )
      ).reason,
      'screen_operation_required',
    );
    assert.equal(
      (
        await admin(
          'desktop.home_register',
          { ref: observation['ref'] },
          {
            ...UNLOCKED,
            lockState: 'locked',
          },
        )
      ).reason,
      'device_locked',
    );
    assert.equal(
      (
        await admin('desktop.home_status', null, {
          ...UNLOCKED,
          lockState: 'unknown',
        })
      ).reason,
      'device_locked',
    );
    // 画面から MAC・SSID の値を送る形は契約にない（形式で拒否）。
    assert.equal(
      (
        await admin('desktop.home_register', {
          ref: observation['ref'],
          gateway_mac: HOME.gateway_mac,
        })
      ).reason,
      'invalid_request',
    );
    assert.equal(puts().length, 0);

    // 確認の間にネットワークが変わったら送らない。参照も使えなくなる。
    network.value = {
      ...HOME,
      gateway_mac: '00:00:5e:00:53:02',
      unavailable: [],
    };
    assert.equal(
      (await admin('desktop.home_register', { ref: observation['ref'] }))
        .reason,
      'home_network_changed',
    );
    network.value = { ...HOME, unavailable: [] };
    assert.equal(
      (await admin('desktop.home_register', { ref: observation['ref'] }))
        .reason,
      'entry_not_found',
    );
    assert.equal(puts().length, 0);

    // 読み取り直して確かめた参照で登録する。中枢へは画面操作・今の接続範囲で、集めた値を送る。
    const fresh = await admin('desktop.home_status', null);
    const ref = fresh.home?.observation?.['ref'];
    assert.notEqual(ref, observation['ref']);
    const registered = await admin('desktop.home_register', { ref });
    assert.equal(registered['outcome'], 'ok');
    assert.deepEqual(registered.home?.registration, {
      subnet: '192.0.2.0/24',
      ssid_registered: true,
      registered_at: '2030-10-05T00:10:00Z',
    });
    assert.equal(registered.home?.observation?.['ref'], ref);
    assert.equal(puts().length, 1);
    const put = puts()[0];
    assert.equal(put?.screenOperation, true);
    assert.equal(put?.body?.['gateway_mac'], HOME.gateway_mac);
    assert.equal(put?.body?.['subnet'], HOME.subnet);
    assert.equal(put?.body?.['ssid'], HOME.ssid);
    assert.equal(put?.body?.['command_scope_id'], SCOPE);
    assert.match(String(put?.body?.['request_id']), /^[0-9a-f-]{36}$/u);
    assert(logs.includes('hub_home_registered'));
    // 登録の後は登録済み（最終更新の時刻）を返す。
    const after = await admin('desktop.home_status', null);
    assert.equal(
      after.home?.registration?.['registered_at'],
      '2030-10-05T00:10:00Z',
    );

    // 結果が分からないときは outcome_unknown で、自動では送り直さない。
    hub.dropPut = true;
    const unknown = await admin('desktop.home_register', { ref });
    assert.equal(unknown.reason, 'outcome_unknown');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(puts().length, 2);
    // 中枢へ送った要求の宛先は決まった経路だけ（画面が宛先を決めない）。
    for (const request of sent)
      assert(
        [
          '/v1/bootstrap',
          '/v1/snapshot',
          '/v1/pairing/claims',
          '/v1/home-network/reports',
          '/v1/home-network/registration',
        ].includes(request.path),
        request.path,
      );
    assertNoRawValues(shown, logs);
  },
);

test(
  'a missing MAC gives no reference; a failed or slow read shows no observation; a device that is not the hub screen gets nothing (B03-08)',
  { timeout: 30_000 },
  async (t) => {
    const { hub, network, shown, logs, admin, puts } = await liveLink(t, {
      homeCollectTimeoutMs: 100,
    });
    const ok = await admin('desktop.home_status', null);
    const oldRef = ok.home?.observation?.['ref'];
    // ルーターの MAC が取れない: 参照なし（登録できない）。SSID は理由だけ。前の参照も使えない。
    network.value = {
      gateway_mac: null,
      subnet: HOME.subnet,
      ssid: null,
      unavailable: ['gateway_mac_unavailable', 'ssid_redacted'],
    };
    const partial = await admin('desktop.home_status', null);
    assert.deepEqual(partial.home?.observation, {
      ref: null,
      collected_at: partial.home?.observation?.['collected_at'],
      gateway_mac_tail: null,
      subnet: '192.0.2.0/24',
      ssid_hint: null,
      ssid_unavailable_reason: 'redacted',
    });
    assert.equal(
      (await admin('desktop.home_register', { ref: oldRef })).reason,
      'entry_not_found',
    );
    // 読み取りの失敗・時間切れ・どの要素も取れない: observation は null。登録の状態は出す。
    hub.registration = {
      subnet: '192.0.2.0/24',
      ssid_registered: false,
      registered_at: '2030-10-05T00:10:00Z',
    };
    for (const value of [
      'throw',
      'hang',
      { gateway_mac: null, subnet: null, ssid: null, unavailable: [] },
    ] as const) {
      network.value = value;
      const failed = await admin('desktop.home_status', null);
      assert.equal(failed['outcome'], 'ok', JSON.stringify(value));
      assert.equal(failed.home?.observation, null);
      assert.equal(
        failed.home?.registration?.['registered_at'],
        '2030-10-05T00:10:00Z',
      );
    }
    assert(logs.includes('hub_home_read_failed'));
    assert(logs.includes('hub_home_read_timeout'));
    assert(logs.includes('hub_home_read_empty'));
    assert.equal(puts().length, 0);
    // 中枢の画面でない端末: 経路が 403 hub_screen_required なら画面も操作も出さない。
    hub.hubScreen = false;
    network.value = { ...HOME, unavailable: [] };
    const refused = await admin('desktop.home_status', null);
    assert.equal(refused.reason, 'hub_screen_required');
    assert.equal(
      (await admin('desktop.home_status', null)).reason,
      'hub_screen_required',
    );
    assertNoRawValues(shown, logs);
  },
);
