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
import type { AdminConfirmRequest } from './core-link.js';
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

test(
  'the masked view keeps only the last two MAC octets, the subnet and the SSID length with its first character',
  { timeout: 10_000 },
  () => {
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
          list_seq: 1,
        }),
        [],
      );
  },
);

interface HubState {
  // 中枢の登録（GET の応答）。PUT で置き換える。
  registration: Record<string, unknown> | null;
  // 中枢の画面の端末か（承認待ちの申請の一覧の経路が 200 か 403 か）。
  hubScreen: boolean;
  // PUT の応答を返さない（送った後に切れた）。
  dropPut: boolean;
  // PUT に 200 で契約に合わない本文を返す。
  badPutBody: boolean;
  // 設定すると、PUT の応答を releasePut まで止める（送った後の競合を作る）。
  gatePut: boolean;
  releasePut: () => void;
  // bootstrap の回数（bootstrap ごとに新しい接続範囲を返す）。
  bootstraps: number;
  // WSS のイベントの受け口（4410 などを試験から送る）。
  stream: ((event: unknown) => void) | null;
}

async function liveLink(
  t: test.TestContext,
  options: { readonly homeCollectTimeoutMs?: number } = {},
) {
  const dir = await tempDir(t, 'bdhr-');
  const protector = mockProtector();
  const hub: HubState = {
    registration: null,
    hubScreen: true,
    dropPut: false,
    badPutBody: false,
    gatePut: false,
    releasePut: () => {},
    bootstraps: 0,
    stream: null,
  };
  const sent: ClientApiRequest[] = [];
  const shown: unknown[] = [];
  const logs: string[] = [];
  // 試験が決めるこのマシンの指紋（'throw' は読み取りの失敗、'hang' は応答しない、'gate' は release まで待つ）。
  // ウィンドウが前面か（送る直前の確かめ直しに使う。試験が切り替える）。
  const focus = { value: true };
  // 本人の確認（OS の確認ダイアログの代わり）。answer で「登録する」か「やめる」か、'hold' なら閉じられるまで
  // 待つかを決め、出した値と閉じる合図を記録する。
  const confirm: {
    answer: boolean | 'hold';
    shown: AdminConfirmRequest[];
    signals: AbortSignal[];
  } = { answer: true, shown: [], signals: [] };
  const network: {
    value: HomeObservation | 'throw' | 'hang' | 'gate';
    collects: number;
    release: () => void;
  } = {
    value: { ...HOME, unavailable: [] },
    collects: 0,
    release: () => undefined,
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
    if (request.path === '/v1/bootstrap') {
      hub.bootstraps += 1;
      return ok({
        api_version: '1.0',
        core_instance_id: '00000000-0000-4000-8000-000000000e04',
        store_generation: '00000000-0000-4000-8000-000000000e05',
        device_id: DEVICE,
        // 最初の bootstrap は SCOPE、やり直すたびに新しい接続範囲。
        command_scope_id:
          hub.bootstraps === 1
            ? SCOPE
            : `00000000-0000-4000-8000-${String(0xe10 + hub.bootstraps).padStart(12, '0')}`,
        command_scope_expires_at: '2030-10-06T00:00:00Z',
        capabilities: [],
        io_state: ioState,
      });
    }
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
      const put = (): ClientApiOutcome => {
        if (hub.dropPut) return { kind: 'unreachable', reason: 'test' };
        if (hub.badPutBody) return ok({ accepted: true });
        hub.registration = {
          subnet: request.body?.['subnet'],
          ssid_registered: request.body?.['ssid'] !== null,
          registered_at: '2030-10-05T00:10:00Z',
        };
        return ok(hub.registration);
      };
      if (!hub.gatePut) return put();
      return new Promise<ClientApiOutcome>((resolve) => {
        hub.releasePut = () => resolve(put());
      });
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
      network.collects += 1;
      const value = network.value;
      if (value === 'throw') return Promise.reject(new Error('synthetic'));
      if (value === 'hang') return new Promise<HomeObservation>(() => {});
      if (value === 'gate')
        return new Promise<HomeObservation>((resolve) => {
          network.release = () => {
            network.value = { ...HOME, unavailable: [] };
            resolve({ ...HOME, unavailable: [] });
          };
        });
      return Promise.resolve(value);
    },
    networkSignature: () => 'x',
    onChange: () => shown.push(link.view('unlocked')),
    log: (code) => logs.push(code),
    homeReportIntervalMs: 600_000,
    windowFocused: () => focus.value,
    confirmAdmin: (request, signal) => {
      confirm.shown.push(request);
      confirm.signals.push(signal);
      const answer = confirm.answer;
      if (answer !== 'hold') return Promise.resolve(answer);
      return new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(false));
      });
    },
    ...(options.homeCollectTimeoutMs === undefined
      ? {}
      : { homeCollectTimeoutMs: options.homeCollectTimeoutMs }),
    transportFor: () => ({
      request: (request) => {
        sent.push(request);
        return Promise.resolve(respond(request));
      },
      openStream: (_cursor, _lock, onEvent) => {
        hub.stream = onEvent as (event: unknown) => void;
        return Promise.resolve({ kind: 'open', stream: { close: () => {} } });
      },
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
  return { link, hub, network, focus, confirm, sent, shown, logs, admin, puts };
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
      (
        await admin('desktop.home_register', {
          ref: randomUUID(),
          include_ssid: true,
        })
      ).reason,
      'entry_not_found',
    );
    assert.equal(
      (
        await admin(
          'desktop.home_register',
          { ref: observation['ref'], include_ssid: true },
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
          { ref: observation['ref'], include_ssid: true },
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
          include_ssid: true,
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
      (
        await admin('desktop.home_register', {
          ref: observation['ref'],
          include_ssid: true,
        })
      ).reason,
      'home_network_changed',
    );
    network.value = { ...HOME, unavailable: [] };
    assert.equal(
      (
        await admin('desktop.home_register', {
          ref: observation['ref'],
          include_ssid: true,
        })
      ).reason,
      'entry_not_found',
    );
    assert.equal(puts().length, 0);

    // 読み取り直して確かめた参照で登録する。中枢へは画面操作・今の接続範囲で、集めた値を送る。
    const fresh = await admin('desktop.home_status', null);
    const ref = fresh.home?.observation?.['ref'];
    assert.notEqual(ref, observation['ref']);
    const registered = await admin('desktop.home_register', {
      ref,
      include_ssid: true,
    });
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
    assert(logs.includes('hub_home_registered:with_ssid'));
    // 登録の後は登録済み（最終更新の時刻）を返す。
    const after = await admin('desktop.home_status', null);
    assert.equal(
      after.home?.registration?.['registered_at'],
      '2030-10-05T00:10:00Z',
    );

    // 結果が分からないときは outcome_unknown で、自動では送り直さない。
    hub.dropPut = true;
    const unknown = await admin('desktop.home_register', {
      ref,
      include_ssid: true,
    });
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
      (
        await admin('desktop.home_register', {
          ref: oldRef,
          include_ssid: true,
        })
      ).reason,
      'entry_not_found',
    );
    // 読み取りの失敗・時間切れ・どの要素も取れない: observation は null。登録の状態は出す。
    hub.registration = {
      subnet: '192.0.2.0/24',
      ssid_registered: false,
      registered_at: '2030-10-05T00:10:00Z',
    };
    // 応答しない収集は終わるまで残る（次の要求もそれを待つ）ので、最後に試す。
    for (const value of [
      'throw',
      { gateway_mac: null, subnet: null, ssid: null, unavailable: [] },
      'hang',
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

test(
  'concurrent reads share one collection; a lock, a disconnect or an unreadable network before sending sends nothing; a 2xx with an unexpected body is unknown (B03-08)',
  { timeout: 30_000 },
  async (t) => {
    const { link, hub, network, logs, admin, puts } = await liveLink(t);
    // 同時の読み取りは 1 回の収集にまとめる（コマンドを並行に何組も動かさない）。
    network.value = 'gate';
    const before = network.collects;
    const first = admin('desktop.home_status', null);
    const second = admin('desktop.home_status', null);
    await waitUntil(() => network.collects > before, 'collect started');
    await new Promise((resolve) => setTimeout(resolve, 20));
    network.release();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(network.collects - before, 1);
    const ref = one.home?.observation?.['ref'];
    assert.equal(typeof ref, 'string');
    assert.equal(two.home?.observation?.['ref'], ref);

    // 送る直前の読み取りの間にロックした: 送らず、参照も捨てる。
    network.value = 'gate';
    const gated = network.collects;
    const locked = admin('desktop.home_register', { ref, include_ssid: true });
    await waitUntil(() => network.collects > gated, 'register read started');
    link.setLockState('locked');
    network.release();
    assert.equal((await locked).reason, 'device_locked');
    link.setLockState('unlocked');
    assert.equal(
      (await admin('desktop.home_register', { ref, include_ssid: true }))
        .reason,
      'entry_not_found',
    );

    // 送る直前に読み取れなくなった: ネットワークが変わったときと同じく送らない（ログは理由のコードだけ）。
    const ref2 = (await admin('desktop.home_status', null)).home?.observation?.[
      'ref'
    ];
    network.value = 'throw';
    assert.equal(
      (await admin('desktop.home_register', { ref: ref2, include_ssid: true }))
        .reason,
      'home_network_changed',
    );
    assert(logs.includes('hub_home_unreadable'));
    assert.equal(puts().length, 0);

    // 2xx でも本文が契約に合わなければ、登録されたかもしれないので結果不明（自動では送り直さない）。
    network.value = { ...HOME, unavailable: [] };
    const ref3 = (await admin('desktop.home_status', null)).home?.observation?.[
      'ref'
    ];
    hub.badPutBody = true;
    assert.equal(
      (await admin('desktop.home_register', { ref: ref3, include_ssid: true }))
        .reason,
      'outcome_unknown',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(puts().length, 1);

    // 送る直前の読み取りの間に切断した: 送らない。
    hub.badPutBody = false;
    // 結果が分からなかった登録は、読み取り直すまで保留（同じ参照では送らない）。
    assert.equal(
      (await admin('desktop.home_register', { ref: ref3, include_ssid: true }))
        .reason,
      'entry_not_found',
    );
    const ref4 = (await admin('desktop.home_status', null)).home?.observation?.[
      'ref'
    ];
    network.value = 'gate';
    const beforeCut = network.collects;
    const cut = admin('desktop.home_register', {
      ref: ref4,
      include_ssid: true,
    });
    await waitUntil(() => network.collects > beforeCut, 'read before cut');
    link.stop();
    network.release();
    assert.equal((await cut).reason, 'not_connected');
    assert.equal(puts().length, 1);
  },
);

test(
  'turning the Wi-Fi name off registers without the SSID; losing focus before sending sends nothing and keeps the reference (B03-08)',
  { timeout: 30_000 },
  async (t) => {
    const { hub, network, focus, logs, admin, puts } = await liveLink(t);
    const ref = (await admin('desktop.home_status', null)).home?.observation?.[
      'ref'
    ];
    // 確かめない（include_ssid: false）: 中枢へ SSID を送らない（null）。登録は SSID なし。
    const off = await admin('desktop.home_register', {
      ref,
      include_ssid: false,
    });
    assert.equal(off['outcome'], 'ok');
    assert.equal(off.home?.registration?.['ssid_registered'], false);
    assert.equal(puts().length, 1);
    assert.equal(puts()[0]?.body?.['ssid'], null);
    assert.equal(puts()[0]?.body?.['gateway_mac'], HOME.gateway_mac);
    assert.equal(puts()[0]?.body?.['subnet'], HOME.subnet);
    assert(logs.includes('hub_home_registered:without_ssid'));
    // 確かめる（include_ssid: true）: SSID を送る。
    const on = await admin('desktop.home_register', {
      ref,
      include_ssid: true,
    });
    assert.equal(on.home?.registration?.['ssid_registered'], true);
    assert.equal(puts()[1]?.body?.['ssid'], HOME.ssid);
    assert.equal(hub.registration?.['ssid_registered'], true);

    // 送る直前の読み取りの間に、ウィンドウが前面でなくなった: 送らない。参照は残す。
    network.value = 'gate';
    const before = network.collects;
    const unfocused = admin('desktop.home_register', {
      ref,
      include_ssid: true,
    });
    await waitUntil(() => network.collects > before, 'register read started');
    focus.value = false;
    network.release();
    assert.equal((await unfocused).reason, 'screen_operation_required');
    assert.equal(puts().length, 2);
    // 前面に戻せば、同じ参照で登録できる。
    focus.value = true;
    const again = await admin('desktop.home_register', {
      ref,
      include_ssid: true,
    });
    assert.equal(again['outcome'], 'ok');
    assert.equal(puts().length, 3);
  },
);

test(
  'a read that timed out keeps its collection for later requests; registering waits for a running read and reads once more (B03-08 review)',
  { timeout: 30_000 },
  async (t) => {
    {
      // 時間切れで見限っても、収集（コマンドの連鎖）が終わるまで次の要求はそれを待つ（連鎖を重ねない）。
      const { network, admin, logs } = await liveLink(t, {
        homeCollectTimeoutMs: 100,
      });
      network.value = 'gate';
      const before = network.collects;
      const first = await admin('desktop.home_status', null);
      assert.equal(first.home?.observation, null);
      const second = await admin('desktop.home_status', null);
      assert.equal(second.home?.observation, null);
      assert.equal(network.collects - before, 1);
      assert.equal(
        logs.filter((code) => code === 'hub_home_read_timeout').length,
        2,
      );
      // 収集が終われば、次の要求は新しく読む。
      network.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const third = await admin('desktop.home_status', null);
      assert.equal(third.home?.observation?.['gateway_mac_tail'], '53:01');
      assert.equal(network.collects - before, 2);
    }
    {
      // 登録は、進行中の読み取りに相乗りせず、それが終わるのを待ってから新しく 1 回読む。
      const { network, admin, puts } = await liveLink(t);
      const ref = (await admin('desktop.home_status', null)).home
        ?.observation?.['ref'];
      network.value = 'gate';
      const before = network.collects;
      const status = admin('desktop.home_status', null);
      await waitUntil(() => network.collects > before, 'status read started');
      const register = admin('desktop.home_register', {
        ref,
        include_ssid: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(network.collects - before, 1);
      assert.equal(puts().length, 0);
      network.release();
      // 登録より前に始めた読み取りは、登録に追い越されたので返さない（古い表示・参照を戻さない）。
      assert.equal((await status).reason, 'list_superseded');
      assert.equal((await register)['outcome'], 'ok');
      assert.equal(network.collects - before, 2);
      assert.equal(puts().length, 1);
    }
  },
);

test(
  'registering asks with the OS confirmation showing only masked values; cancel, a lock or a hidden window while it is open sends nothing (B03-08)',
  { timeout: 30_000 },
  async (t) => {
    const { link, hub, confirm, shown, logs, admin, puts } = await liveLink(t);
    const ref = (await admin('desktop.home_status', null)).home?.observation?.[
      'ref'
    ];
    // 確認に出すのは伏せた値だけ（MAC の最後の 2 組・サブネット・Wi-Fi 名の先頭の 1 文字と文字数）。
    confirm.answer = false;
    assert.equal(
      (await admin('desktop.home_register', { ref, include_ssid: true }))
        .reason,
      'confirmation_declined',
    );
    assert.deepEqual(confirm.shown.at(-1), {
      action: 'register_home',
      replacing: false,
      macTail: '53:01',
      subnet: '192.0.2.0/24',
      includeSsid: true,
      ssidHint: { first: '合', length: 5 },
      ssidChange: null,
    });
    assert.equal(
      JSON.stringify(confirm.shown).includes(HOME.gateway_mac),
      false,
    );
    assert.equal(JSON.stringify(confirm.shown).includes(HOME.ssid), false);
    assert.equal(puts().length, 0);

    // 確認を開いている間にロックした: 確認を閉じ、送らない。参照も捨てる。
    confirm.answer = 'hold';
    const locked = admin('desktop.home_register', { ref, include_ssid: true });
    await waitUntil(() => confirm.signals.length === 2, 'confirm shown');
    link.setLockState('locked');
    assert.equal(confirm.signals[1]?.aborted, true);
    assert.equal((await locked).reason, 'device_locked');
    link.setLockState('unlocked');
    assert.equal(puts().length, 0);

    // 確認を開いている間にウィンドウが隠れた: 確認を閉じ、画面操作からやり直す（参照は残す）。
    const ref2 = (await admin('desktop.home_status', null)).home?.observation?.[
      'ref'
    ];
    const hidden = admin('desktop.home_register', {
      ref: ref2,
      include_ssid: false,
    });
    await waitUntil(() => confirm.signals.length === 3, 'confirm shown again');
    // 確認は同時に 1 つまで。
    assert.equal(
      (await admin('desktop.home_register', { ref: ref2, include_ssid: true }))
        .reason,
      'confirmation_pending',
    );
    link.closeConfirm();
    assert.equal((await hidden).reason, 'screen_operation_required');
    assert.equal(puts().length, 0);

    // 確認されたときだけ送る。登録し直しの確認には置き換えと Wi-Fi 名の確認の変化を出す。
    confirm.answer = true;
    const done = await admin('desktop.home_register', {
      ref: ref2,
      include_ssid: true,
    });
    assert.equal(done.home?.registration?.['ssid_registered'], true);
    assert.equal(puts().length, 1);
    await admin('desktop.home_status', null);
    const ref3 = (await admin('desktop.home_status', null)).home?.observation?.[
      'ref'
    ];
    await admin('desktop.home_register', { ref: ref3, include_ssid: false });
    assert.equal(confirm.shown.at(-1)?.action, 'register_home');
    assert.deepEqual(
      (({ replacing, includeSsid, ssidHint, ssidChange }) => ({
        replacing,
        includeSsid,
        ssidHint,
        ssidChange,
      }))(
        confirm.shown.at(-1) as Extract<
          AdminConfirmRequest,
          { action: 'register_home' }
        >,
      ),
      {
        replacing: true,
        includeSsid: false,
        ssidHint: null,
        ssidChange: 'removed',
      },
    );
    assert.equal(hub.registration?.['ssid_registered'], false);
    assertNoRawValues(shown, logs);
  },
);

test(
  'a lock during a read returns no masked view or reference (B03-08)',
  { timeout: 30_000 },
  async (t) => {
    const { link, network, admin } = await liveLink(t);
    const ref = (await admin('desktop.home_status', null)).home?.observation?.[
      'ref'
    ];
    assert.equal(typeof ref, 'string');
    // 読み取りの間にロックした: 伏せた表示も参照も返さない（ロックをまたいだ内容を返さない）。
    network.value = 'gate';
    const gated = network.collects;
    const during = admin('desktop.home_status', null);
    await waitUntil(() => network.collects > gated, 'collect before lock');
    link.setLockState('locked');
    network.release();
    const response = await during;
    assert.equal(response.reason, 'device_locked');
    assert.equal(response.home, undefined);
    link.setLockState('unlocked');
    assert.equal(
      (await admin('desktop.home_register', { ref, include_ssid: true }))
        .reason,
      'entry_not_found',
    );
  },
);

test(
  'races: a read started during a registration is superseded; an unknown result holds until a read started after it; a stale generation changes nothing; a new bootstrap closes the confirmation (B03-08)',
  { timeout: 30_000 },
  async (t) => {
    const { link, hub, network, confirm, admin, puts } = await liveLink(t);
    const readRef = async () =>
      (await admin('desktop.home_status', null)).home?.observation?.['ref'];
    // 1) 登録の最中に始めた読み取り（登録が成功した後に返る）は list_superseded（登録の前の状態を戻さない）。
    const ref = await readRef();
    hub.gatePut = true;
    const registering = admin('desktop.home_register', {
      ref,
      include_ssid: true,
    });
    await waitUntil(() => puts().length === 1, 'put sent');
    network.value = 'gate';
    const beforeRead = network.collects;
    const during = admin('desktop.home_status', null);
    await waitUntil(() => network.collects > beforeRead, 'read during put');
    hub.releasePut();
    assert.equal((await registering)['outcome'], 'ok');
    network.release();
    const superseded = await during;
    assert.equal(superseded.reason, 'list_superseded');
    assert.equal(superseded.home, undefined);

    // 2) 結果が分からなかった登録は保留にする。結果が分かる前に始めた読み取りでは解かず、後に始めた読み取りで解く。
    network.value = { ...HOME, unavailable: [] };
    const ref2 = await readRef();
    hub.badPutBody = true;
    const unknown = admin('desktop.home_register', {
      ref: ref2,
      include_ssid: true,
    });
    await waitUntil(() => puts().length === 2, 'second put sent');
    network.value = 'gate';
    const beforeHeld = network.collects;
    const startedBefore = admin('desktop.home_status', null);
    await waitUntil(() => network.collects > beforeHeld, 'read before result');
    hub.releasePut();
    assert.equal((await unknown).reason, 'outcome_unknown');
    network.release();
    const early = await startedBefore;
    assert.equal(early['outcome'], 'ok');
    const earlyRef = early.home?.observation?.['ref'];
    assert.equal(
      (
        await admin('desktop.home_register', {
          ref: earlyRef,
          include_ssid: true,
        })
      ).reason,
      'entry_not_found',
    );
    hub.badPutBody = false;
    hub.gatePut = false;
    const ref3 = await readRef();
    assert.equal(
      (await admin('desktop.home_register', { ref: ref3, include_ssid: true }))[
        'outcome'
      ],
      'ok',
    );
    assert.equal(puts().length, 3);

    // 3) PUT の最中にロックした（古い世代）: 結果が分からなくても保留を作らず、応答も返さない。
    const ref4 = await readRef();
    hub.gatePut = true;
    hub.badPutBody = true;
    const lockedPut = admin('desktop.home_register', {
      ref: ref4,
      include_ssid: true,
    });
    await waitUntil(() => puts().length === 4, 'fourth put sent');
    link.setLockState('locked');
    hub.releasePut();
    const lockedOutcome = await lockedPut;
    assert.equal(lockedOutcome.reason, 'device_locked');
    assert.equal(lockedOutcome.home, undefined);
    link.setLockState('unlocked');
    hub.gatePut = false;
    hub.badPutBody = false;
    // 保留はないので、読み取り直せばすぐ登録できる。
    const ref5 = await readRef();
    assert.equal(
      (await admin('desktop.home_register', { ref: ref5, include_ssid: true }))[
        'outcome'
      ],
      'ok',
    );
    assert.equal(puts().length, 5);

    // 4) 確認を開いている間に 4410 で bootstrap をやり直した（接続範囲が変わる）: 確認を閉じ、送らない。
    const ref6 = await readRef();
    confirm.answer = 'hold';
    const shownBefore = confirm.signals.length;
    const rescoped = admin('desktop.home_register', {
      ref: ref6,
      include_ssid: true,
    });
    await waitUntil(
      () => confirm.signals.length === shownBefore + 1,
      'confirm before 4410',
    );
    const bootstrapsBefore = hub.bootstraps;
    hub.stream?.({ type: 'closed', code: 4410, reason: 'resnapshot' });
    assert.equal(confirm.signals.at(-1)?.aborted, true);
    assert.notEqual((await rescoped)['outcome'], 'ok');
    await waitUntil(
      () =>
        hub.bootstraps > bootstrapsBefore && link.linkState?.phase === 'live',
      'live again',
    );
    assert.equal(puts().length, 5);
    // 新しい接続範囲で読み取り直せば、その接続範囲で送る。
    confirm.answer = true;
    const ref7 = await readRef();
    assert.equal(
      (await admin('desktop.home_register', { ref: ref7, include_ssid: true }))[
        'outcome'
      ],
      'ok',
    );
    assert.equal(puts().length, 6);
  },
);

test(
  'list_seq: a re-read after the registration response comes later in main order; a re-read returned during the registration is what the registration response shows (B03-08)',
  { timeout: 30_000 },
  async (t) => {
    const { hub, network, admin, puts, shown, logs } = await liveLink(t);
    // 順 1: 登録の応答の後に本人が読み取り直した結果は、登録の応答より大きい番号で返る（画面は捨てない）。
    const first = await admin('desktop.home_status', null);
    const firstSeq = Number(first['list_seq']);
    assert(firstSeq >= 1);
    const registered = await admin('desktop.home_register', {
      ref: first.home?.observation?.['ref'],
      include_ssid: true,
    });
    const registeredSeq = Number(registered['list_seq']);
    assert(registeredSeq > firstSeq);
    const reread = await admin('desktop.home_status', null);
    assert(Number(reread['list_seq']) > registeredSeq);
    assert.equal(reread.home?.observation?.['gateway_mac_tail'], '53:01');

    // 順 2: 登録の最中（PUT を送った後）に読み取り直した結果が先に返り、ネットワークは変わっていた。登録の応答は
    // それより大きい番号で、その新しい読み取りの表示と参照を返す（登録の前の古い読み取りで戻さない）。
    hub.gatePut = true;
    const registering = admin('desktop.home_register', {
      ref: reread.home?.observation?.['ref'],
      include_ssid: true,
    });
    await waitUntil(() => puts().length === 2, 'put sent');
    network.value = {
      ...HOME,
      gateway_mac: '00:00:5e:00:53:02',
      unavailable: [],
    };
    const during = await admin('desktop.home_status', null);
    const duringSeq = Number(during['list_seq']);
    const duringRef = during.home?.observation?.['ref'];
    assert.equal(during.home?.observation?.['gateway_mac_tail'], '53:02');
    assert.notEqual(duringRef, reread.home?.observation?.['ref']);
    hub.releasePut();
    const done = await registering;
    assert.equal(done['outcome'], 'ok');
    assert(Number(done['list_seq']) > duringSeq);
    assert.equal(done.home?.observation?.['gateway_mac_tail'], '53:02');
    assert.equal(done.home?.observation?.['ref'], duringRef);
    assert.equal(done.home?.registration?.['ssid_registered'], true);

    // 結果が分からなかった登録は、保留にした時点の番号を返す。
    hub.gatePut = false;
    hub.badPutBody = true;
    const unknown = await admin('desktop.home_register', {
      ref: duringRef,
      include_ssid: true,
    });
    assert.equal(unknown.reason, 'outcome_unknown');
    assert(Number(unknown['list_seq']) > Number(done['list_seq']));
    assertNoRawValues(shown, logs);
  },
);
