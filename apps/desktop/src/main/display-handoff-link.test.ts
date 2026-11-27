// 流れの表示先の移動「このPCに出す」（UI-05 の段階 5、ADR 0193）を、127.0.0.1 の製品の Core（startCore、鍵は模擬）と、
// 2 台分の main の部品（DesktopCoreLink・DisplayRouteBridge・DisplayLeaseKeeper・@buddy/client）で通す統合の試験
// （display-lease-link.test.ts と同じ形）。Electron は起動しない。表示のリースの時計とタイマーは端末ごとに手で進める（実時間を
// 待たない。中枢の期限の見積もりは実時間で、この試験は数秒で終わる）。期待値は手で書いた。実機・実データは未実施。
// 確かめること: 誰も移していない間は 2 台とも表示のリースを持つ、片方が「このPCに出す」と、もう片方は次の更新で拒否されて
// 表示を失い（ADR 0188 と同じ理由つきの空）取り直しを繰り返しても取れず、状態欄は他の端末になる、もう片方が移し返すとすぐ取り直す、
// 画面操作でない・前面でない・ロック中・停止中・従来の窓は中枢へ送らない（停止中は中枢が断る）、本文に端末 ID は移す先の自分
// だけ・会話の ID を含まない。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type { DesktopIpcResponse } from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import type { CanvasChangedNotification } from './core-link.js';
import { SecretText, saveCredential } from './credential-store.js';
import {
  freePort,
  mockProtector,
  onCleanup,
  startHub,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import type { TestHub } from './hub-test-support.js';
import { createHubTransport, hubRequest } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import { buildStatusBar } from './status-bar.js';
import { systemClock } from './system-clock.js';
import { ManualVoiceClock } from './voice-test-support.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const SCREEN = { trustedSender: true, windowFocused: true };
const NIL = '00000000-0000-4000-8000-000000000000';

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly origin: 'screen' | null;
}

interface Device {
  readonly id: string;
  readonly link: DesktopCoreLink;
  readonly lease: ManualVoiceClock;
  readonly sent: Sent[];
  readonly notices: CanvasChangedNotification[];
  // この端末の入出力の状態（試験が変える）。
  io: DesktopIoState;
  // 表示先の読み取りの応答を受けた直後に 1 回だけ呼ぶ（読んだ後に他の端末が移した、を再現する）。
  afterRead: (() => Promise<void>) | null;
  handoff(options?: {
    readonly sender?: typeof SCREEN;
    readonly io?: DesktopIoState;
  }): Promise<DesktopIpcResponse>;
  // 中枢にこの端末の入出力の停止（local）を知らせる。HTTP の状態を返す（端末の main はこの経路を呼ばないので、試験が直接送る）。
  stopOnHub(): Promise<number>;
}

async function startDevice(
  t: test.TestContext,
  hub: TestHub,
  options: { readonly canvasMode: boolean },
): Promise<Device> {
  const dir = await tempDir(t, 'bdh-');
  const protector = mockProtector();
  const token = createDeviceToken();
  const deviceId = randomUUID();
  const inserted = await hub.handle.store.device({
    kind: 'device.insert',
    device_id: deviceId,
    device_name: '合成の端末',
    platform: 'macos',
    hub_local: true,
    token_hash: deviceTokenHash(token),
    registered_at: Date.now(),
  });
  assert(inserted.ok, 'device insert failed');
  const pem = await readFile(join(hub.dataDir, 'tls-certificate.pem'), 'utf8');
  const pinned: PinnedHub = {
    host: '127.0.0.1',
    port: hub.port,
    certificatePem: pem,
    fingerprint: new X509Certificate(pem).fingerprint256
      .replaceAll(':', '')
      .toLowerCase(),
  };
  const credentialPath = join(dir, 'device-credential.bin');
  await saveCredential(credentialPath, protector, {
    deviceId,
    token: new SecretText(token),
    issuedAt: '2030-10-05T00:00:00Z',
    hub: pinned,
  });
  const lease = new ManualVoiceClock();
  const sent: Sent[] = [];
  const notices: CanvasChangedNotification[] = [];
  const device: Device = {
    id: deviceId,
    lease,
    sent,
    notices,
    io: UNLOCKED,
    afterRead: null,
    link: null as unknown as DesktopCoreLink,
    async stopOnHub() {
      const scope = device.link.linkState?.commandScopeId ?? null;
      assert(scope !== null, 'scope');
      const response = await hubRequest(pinned, {
        method: 'POST',
        path: '/v1/io/stop',
        headers: {
          authorization: `Bearer ${token}`,
          'buddy-lock-state': 'unlocked',
        },
        body: {
          request_id: randomUUID(),
          command_scope_id: scope,
          scope: 'local',
        },
      });
      return response.kind === 'response' ? response.status : 0;
    },
    async handoff(call = {}) {
      const channel = 'desktop.display_handoff';
      const { response } = await device.link.handleDisplayHandoffIpc(
        channel,
        { channel, request_id: randomUUID(), payload: null },
        call.sender ?? SCREEN,
        call.io ?? device.io,
      );
      return response;
    },
  };
  const link = new DesktopCoreLink({
    contract,
    credentialPath,
    protector,
    clock: systemClock(),
    platform: 'macos',
    collectHome: () =>
      Promise.resolve({ gateway_mac: null, subnet: null, ssid: null }),
    networkSignature: () => 'fixed',
    onChange: () => undefined,
    log: () => undefined,
    budgetAuto: false,
    backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
    confirmAdmin: () => Promise.resolve(false),
    ioState: () => device.io,
    ...(options.canvasMode
      ? {
          canvasMode: true,
          onCanvas: (notification: CanvasChangedNotification) =>
            notices.push(notification),
          displayLease: {
            clock: {
              mono: () => lease.mono,
              wall: () => lease.wall,
              setTimer: lease.setTimer,
              newId: () => randomUUID(),
            },
          },
        }
      : {}),
    transportFor: (target, bearer) => {
      const transport = createHubTransport({ hub: target, token: bearer });
      return {
        request: async (request) => {
          if (request.path === '/v1/stream/handoff')
            sent.push({
              method: request.method,
              path: request.path,
              body: { ...(request.body ?? {}) },
              origin: request.screenOperation === true ? 'screen' : null,
            });
          const outcome = await transport.request(request);
          if (
            request.method === 'GET' &&
            request.path === '/v1/stream/handoff' &&
            device.afterRead !== null
          ) {
            const hook = device.afterRead;
            device.afterRead = null;
            await hook();
          }
          return outcome;
        },
        openStream: (cursor, lockState, listener) =>
          transport.openStream(cursor, lockState, listener),
      };
    },
  });
  (device as { link: DesktopCoreLink }).link = link;
  onCleanup(t, () => link.stop());
  await link.start('unlocked');
  await waitUntil(() => link.linkState?.phase === 'live', 'live');
  return device;
}

async function startHandoffHub(t: test.TestContext): Promise<TestHub> {
  const dir = await tempDir(t, 'bdhh-');
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  return startHub(t, { dataDir, port: await freePort() });
}

const target = (d: Device) => {
  const status = buildStatusBar(d.io, d.link.hubStatus());
  return status.visibility === 'shown' ? status.display_target : 'hidden';
};
const withheld = (d: Device) => {
  const last = d.notices.at(-1);
  return (
    last !== undefined &&
    last.canvas === null &&
    'withheld_reason' in last &&
    last.withheld_reason === 'display_lease_lost'
  );
};
const posts = (d: Device) => d.sent.filter((entry) => entry.method === 'POST');

test(
  'moving the display to this device takes it from the other device, which loses the lease with the same reason as any loss and cannot take it back until it moves it again',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHandoffHub(t);
    const a = await startDevice(t, hub, { canvasMode: true });
    const b = await startDevice(t, hub, { canvasMode: true });
    // 誰も移していない間は、2 台とも表示のリースを持つ（端末ごとの今までの動き）。状態欄はこの端末。
    await waitUntil(() => a.link.displayLeaseState === 'held', 'A holds');
    await waitUntil(() => b.link.displayLeaseState === 'held', 'B holds');
    await waitUntil(() => target(a) === 'this_device', 'A target');
    await waitUntil(() => target(b) === 'this_device', 'B target');

    // A が「このPCに出す」。直前に今の版を読み、画面操作として、自分の端末だけを移す先にして 1 回だけ送る。
    const moved = await a.handoff();
    assert.deepEqual(contract.responseErrors(moved), [], JSON.stringify(moved));
    assert.deepEqual(
      [moved.outcome, 'handoff_state' in moved && moved.handoff_state],
      ['ok', 'moving'],
    );
    // 読み取りは画面操作ではなく、移動は画面操作として 1 回だけ。移動の直前は読み取り（今の版を読む）。
    assert.deepEqual(
      a.sent.map((entry) => entry.method === 'POST'),
      [...a.sent.map(() => false).slice(0, -1), true],
    );
    assert.equal(posts(a).length, 1);
    assert.deepEqual(
      a.sent.map((entry) => entry.origin),
      [...a.sent.map(() => null).slice(0, -1), 'screen'],
    );
    const body = posts(a)[0]?.body ?? {};
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        'command_scope_id',
        'expected_route_revision',
        'request_id',
        'target_device_id',
      ].sort(),
    );
    assert.equal(body['target_device_id'], a.id);
    assert.equal(body['expected_route_revision'], '0');
    assert.equal(target(a), 'this_device');

    // B の次の更新（2 秒後）は拒否され、B は表示を失う。ADR 0188 と同じ理由つきの空。状態欄は他の端末。
    await b.lease.advance(2000);
    await waitUntil(() => b.link.displayLeaseState === 'lost', 'B loses');
    assert(withheld(b), 'B withholds the canvas with the display reason');
    await waitUntil(() => target(b) === 'other_device', 'B target other');
    // A は失わない。
    assert.equal(a.link.displayLeaseState, 'held');
    assert(!withheld(a));
    // B の取り直しは A が持っている間は取れず、失ったまま。
    await b.lease.advance(2000);
    await b.lease.advance(4000);
    await b.lease.advance(8000);
    assert.equal(b.link.displayLeaseState, 'lost');
    assert.equal(target(b), 'other_device');

    // B が「このPCに出す」と、待たずに取り直し、A が失う。版は B が読み直した今の値（1）。
    const back = await b.handoff();
    assert.deepEqual(
      [back.outcome, 'handoff_state' in back && back.handoff_state],
      ['ok', 'moving'],
    );
    assert.equal(posts(b)[0]?.body['expected_route_revision'], '1');
    await waitUntil(() => b.link.displayLeaseState === 'held', 'B holds again');
    assert(!withheld(b));
    assert.equal(target(b), 'this_device');
    await a.lease.advance(2000);
    await waitUntil(() => a.link.displayLeaseState === 'lost', 'A loses');
    await waitUntil(() => target(a) === 'other_device', 'A target other');
    assert(withheld(a));
  },
);

test(
  'a route revision that went stale while moving (another device moved first) is refused by the hub and not resent; the screen then reads the new owner',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHandoffHub(t);
    const a = await startDevice(t, hub, { canvasMode: true });
    const b = await startDevice(t, hub, { canvasMode: true });
    await waitUntil(() => target(a) === 'this_device', 'A target');
    await waitUntil(() => target(b) === 'this_device', 'B target');
    await a.link.canvasIdle();
    // A が今の版（0）を読んだ直後に、B が先に移す（版は 1 になる）。A は版 0 のまま送るので中枢が 409 にする。
    a.afterRead = async () => {
      const first = await b.handoff();
      assert.equal(first.outcome, 'ok');
    };
    const refused = await a.handoff();
    assert.deepEqual(
      [refused.outcome, 'reason' in refused && refused.reason],
      ['rejected', 'core_rejected'],
    );
    // 送り直さない（A の移動は 1 回だけ。版は読んだときの 0）。
    assert.equal(posts(a).length, 1);
    assert.equal(posts(a)[0]?.body['expected_route_revision'], '0');
    // A は読み直して、表示先が B（他の端末）だと分かる。A の表示のリースは次の更新で拒否される。
    await waitUntil(
      () => target(a) === 'other_device',
      'A reads the new owner',
    );
    await a.lease.advance(2000);
    await waitUntil(() => a.link.displayLeaseState === 'lost', 'A loses');
    assert.equal(b.link.displayLeaseState, 'held');
    // 本人がもう一度押せば、今の版（1）で通る。
    const again = await a.handoff();
    assert.equal(again.outcome, 'ok');
    assert.equal(posts(a)[1]?.body['expected_route_revision'], '1');
    await waitUntil(() => a.link.displayLeaseState === 'held', 'A holds again');
  },
);

test(
  'nothing is sent for an unfocused window, a locked device or an untrusted sender; a stopped device is refused by the hub and the other device keeps the display',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHandoffHub(t);
    const a = await startDevice(t, hub, { canvasMode: true });
    const b = await startDevice(t, hub, { canvasMode: true });
    await waitUntil(() => a.link.displayLeaseState === 'held', 'A holds');
    await waitUntil(() => b.link.displayLeaseState === 'held', 'B holds');
    await waitUntil(() => target(b) === 'this_device', 'B target');
    const before = a.sent.length;
    for (const [call, reason] of [
      [
        { sender: { trustedSender: true, windowFocused: false } },
        'screen_operation_required',
      ],
      [{ io: { ...UNLOCKED, lockState: 'locked' as const } }, 'device_locked'],
      [{ io: { ...UNLOCKED, lockState: 'unknown' as const } }, 'device_locked'],
      [
        { sender: { trustedSender: false, windowFocused: true } },
        'untrusted_sender',
      ],
    ] as const) {
      const response = await a.handoff(call);
      assert.deepEqual(
        [response.outcome, 'reason' in response && response.reason],
        ['rejected', reason],
      );
    }
    assert.equal(a.sent.length, before, 'nothing reached the hub');
    // A の入出力が止まっている: 画面の受付は通るが、中枢が断る（B の表示は消えない）。
    a.io = { ...UNLOCKED, stopScope: 'local' };
    // 中枢にもこの端末の停止（ローカル）を知らせる。
    assert.equal(await a.stopOnHub(), 202);
    const refused = await a.handoff();
    assert.deepEqual(
      [refused.outcome, 'reason' in refused && refused.reason],
      ['rejected', 'core_rejected'],
    );
    // B は表示を失っていない（2 秒後の更新が受け付けられる）。
    await b.lease.advance(2000);
    await b.lease.advance(10);
    assert.equal(b.link.displayLeaseState, 'held');
    assert(!withheld(b));
  },
);

test(
  'the legacy window does not hold a display lease, so it cannot move the display (nothing is sent)',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHandoffHub(t);
    const legacy = await startDevice(t, hub, { canvasMode: false });
    const response = await legacy.handoff();
    assert.deepEqual(
      [response.outcome, 'reason' in response && response.reason],
      ['rejected', 'invalid_request'],
    );
    assert.deepEqual(legacy.sent, []);
    assert.equal(target(legacy), null);
    assert.notEqual(NIL, legacy.id);
  },
);
