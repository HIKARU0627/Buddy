// 同じマシンの 2 クライアント A・B の統合試験（模擬。B03-05、ADR 0025、Issue #66 の完了条件）。
//
// - 中枢は同じプロセスの startCore（HTTPS は 127.0.0.1、模擬の KeyStore）。クライアントはデスクトップの main の
//   部品（DesktopCoreLink: ペアリング・safeStorage の模擬での保存・TLS のピン留め・ws・@buddy/client の状態機械）。
// - Electron は起動しない。safeStorage は模擬（試験ごとの乱数の鍵の AES-256-GCM）を注入する。
// - 期待値（状態・理由・版・操作の状態）は試験に手で書いた値か、中枢（別の実装）から取った値で、検査対象の
//   クライアントの関数から作っていない。指紋の期待値は X509Certificate#fingerprint256 から求める。
// - 実機（別のマシン・Tailscale）での確認は docs/b03/device-check.md で別に記録する（この試験は模擬）。

import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  createMockCommandRunner,
  createMockTlsKeyStore,
  createTailscaleStatusSource,
} from '@buddy/platform';
import type {
  DesktopConnectionView,
  DesktopHomeView,
  DesktopIpcResponse,
} from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import type { AdminConfirmRequest } from './core-link.js';
import { CREDENTIAL_FILE, parseCredential } from './credential-store.js';
import type { HomeObservation } from './home-reporter.js';
import { createHubTransport, hubRequest } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import {
  createCommand,
  dispatchCommand,
  freePort,
  mockProtector,
  onCleanup,
  prepareCommand,
  startHub,
  submitDurable,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import type { MockProtector, TestHub } from './hub-test-support.js';
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const SCREEN = { trustedSender: true, windowFocused: true };
const HOME = {
  gateway_mac: '00:00:5e:00:53:01',
  subnet: '192.0.2.0/24',
  ssid: null,
};
// 自宅の Wi-Fi の指紋（文書用の合成値。B03-08 の試験で中枢と B が同じ自宅の LAN にいるとき）。
const HOME_WIFI: HomeObservation = {
  gateway_mac: '00:00:5e:00:53:01',
  subnet: '192.0.2.0/24',
  ssid: '合成の自宅',
  unavailable: [],
};

interface Client {
  readonly name: string;
  readonly link: DesktopCoreLink;
  readonly protector: MockProtector;
  readonly credentialPath: string;
  // 画面へ出した値（応答・通知の接続の状態）とログ。トークンが出ていないかを確かめる。
  readonly ipc: unknown[];
  readonly logs: string[];
  readonly claims: string[];
  // main が出した本人の確認（OS の確認ダイアログの代わりに、試験は内容を控えて「確定」を返す）。
  readonly confirms: AdminConfirmRequest[];
  // 登録した端末として中枢へ送った要求（方法とパス。本文・ヘッダーは記録しない）。
  readonly requests: string[];
  view(): Extract<DesktopConnectionView, { visibility: 'shown' }>;
  invoke(channel: string, payload: unknown): DesktopIpcResponse;
  // 発言・承認表示の準備・承認・取消・照合の IPC（B04-05）。
  work(channel: string, payload: unknown): Promise<DesktopIpcResponse>;
  // 中枢の画面の端末の申請の承認・端末の管理の IPC（B03-06）。
  admin(
    channel: string,
    payload: unknown,
    options?: { readonly sender?: typeof SCREEN },
  ): Promise<DesktopIpcResponse>;
  // 試験だけが保存したトークンを読む（模擬の safeStorage の復号）。
  token(): string;
}

async function createClient(
  t: test.TestContext,
  name: string,
  options: {
    readonly dir?: string;
    readonly protector?: MockProtector;
    readonly pollIntervalMs?: number;
    // 受取り（トークンの要求）を送る前に待つ（試験で受取りの時点を決める）。
    readonly beforePickup?: () => Promise<void>;
    // このマシンのネットワークの指紋（模擬の読み取り。既定は SSID なしの HOME）。関数なら読み取りのたびに呼ぶ
    // （試験の途中で端末のネットワークを変える）。
    readonly home?: HomeObservation | (() => HomeObservation);
    // 本人の確認の答え（既定は確定）。B04-05 の承認の確認を試験で決める。
    readonly confirm?: (request: AdminConfirmRequest) => boolean;
    // 中枢へ送らずに「届いたか分からない」を返す要求（試験で結果不明を作る）。
    readonly dropRequest?: (method: string, path: string) => boolean;
  } = {},
): Promise<Client> {
  const dir = options.dir ?? (await tempDir(t, `bd${name}-`));
  const credentialPath = join(dir, CREDENTIAL_FILE);
  const protector = options.protector ?? mockProtector();
  const ipc: unknown[] = [];
  const logs: string[] = [];
  const claims: string[] = [];
  const requests: string[] = [];
  const confirms: AdminConfirmRequest[] = [];
  let link: DesktopCoreLink | null = null;
  link = new DesktopCoreLink({
    contract,
    credentialPath,
    protector,
    clock: systemClock(),
    platform: 'windows',
    collectHome: () =>
      Promise.resolve(
        typeof options.home === 'function'
          ? options.home()
          : (options.home ?? HOME),
      ),
    networkSignature: () => 'fixed',
    onChange: () => {
      if (link) ipc.push(link.view('unlocked'));
    },
    log: (code) => logs.push(code),
    confirmAdmin: (request) => {
      confirms.push(request);
      return Promise.resolve(options.confirm?.(request) ?? true);
    },
    backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
    aliveTimeoutMs: 3_000,
    pairingPollIntervalMs: options.pollIntervalMs ?? 50,
    transportFor: (hub, token) => {
      const transport = createHubTransport({ hub, token });
      return {
        request: (request) => {
          requests.push(`${request.method} ${request.path}`);
          if (options.dropRequest?.(request.method, request.path) === true)
            return Promise.resolve({
              kind: 'unreachable' as const,
              reason: 'test_dropped',
            });
          return transport.request(request);
        },
        openStream: (cursor, lockState, listener) => {
          requests.push('WSS /v1/events/stream');
          return transport.openStream(cursor, lockState, listener);
        },
      };
    },
    // 申請の応答から claim_id を記録する（中枢の画面の承認で使う。端末の画面には出さない値）。
    pairingRequest: async (hub: PinnedHub, request) => {
      if (request.path.endsWith('/token') && options.beforePickup)
        await options.beforePickup();
      const outcome = await hubRequest(hub, request);
      if (
        request.path === '/v1/pairing/claims' &&
        outcome.kind === 'response' &&
        outcome.status === 202
      )
        claims.push(
          String((outcome.body as Record<string, unknown>)['claim_id']),
        );
      return outcome;
    },
  });
  const created = link;
  onCleanup(t, () => created.stop());
  return {
    name,
    link: created,
    protector,
    credentialPath,
    ipc,
    logs,
    claims,
    confirms,
    requests,
    view() {
      const view = created.view('unlocked');
      assert.equal(view.visibility, 'shown');
      return view as Extract<DesktopConnectionView, { visibility: 'shown' }>;
    },
    invoke(channel, payload) {
      const response = created.handleIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        SCREEN,
        UNLOCKED,
      ).response;
      ipc.push(response);
      return response;
    },
    async work(channel, payload) {
      const { response } = await created.handleOperationIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        SCREEN,
        UNLOCKED,
      );
      ipc.push(response);
      return response;
    },
    async admin(channel, payload, adminOptions = {}) {
      const { response } = await created.handleAdminIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        adminOptions.sender ?? SCREEN,
        UNLOCKED,
      );
      ipc.push(response);
      return response;
    },
    token() {
      const credential = parseCredential(
        protector.reveal(readFileSync(credentialPath)),
      );
      assert(credential !== null);
      return credential.token.reveal();
    },
  };
}

const fingerprintOf = (hub: TestHub): string =>
  new X509Certificate(
    readFileSync(join(hub.dataDir, 'tls-certificate.pem'), 'utf8'),
  ).fingerprint256
    .replaceAll(':', '')
    .toLowerCase();

function hubTarget(hub: TestHub): PinnedHub {
  const pem = readFileSync(join(hub.dataDir, 'tls-certificate.pem'), 'utf8');
  return {
    host: '127.0.0.1',
    port: hub.port,
    certificatePem: pem,
    fingerprint: fingerprintOf(hub),
  };
}

// 中枢の画面の操作（中枢と同じマシンの登録済み端末のトークン・今の接続範囲・画面操作・ロック解除の申告）。
async function hubScreen(
  hub: TestHub,
  operator: Client,
  path: string,
  body: Record<string, unknown>,
) {
  const scope = operator.link.linkState?.commandScopeId;
  assert(typeof scope === 'string', `${operator.name} has no scope`);
  return hubRequest(hubTarget(hub), {
    method: 'POST',
    path,
    headers: {
      authorization: `Bearer ${operator.token()}`,
      'buddy-input-origin': 'screen',
      'buddy-lock-state': 'unlocked',
    },
    body: { request_id: randomUUID(), command_scope_id: scope, ...body },
  });
}

// ペアリングの画面の流れ（指紋の確認 → コード → 申請 → 受取り）。approve は中枢側の承認。
async function pair(
  client: Client,
  hub: TestHub,
  code: string,
  approve: () => Promise<void>,
): Promise<void> {
  const begin = client.invoke('desktop.pairing_begin', {
    host: '127.0.0.1',
    port: hub.port,
  });
  assert.equal(begin.outcome, 'ok');
  await waitUntil(
    () => client.view().pairing?.step === 'fingerprint_check',
    `${client.name} fingerprint`,
  );
  // 指紋は中枢の証明書のもの（別の実装で求めた値）。確かめる前の申請は送らない。
  assert.equal(client.view().pairing?.fingerprint, fingerprintOf(hub));
  const early = client.invoke('desktop.pairing_submit', {
    pairing_code: code,
    device_name: `合成の端末 ${client.name}`,
  });
  assert.equal(early.outcome, 'rejected');
  assert.equal((early as { reason: string }).reason, 'pairing_step_mismatch');
  assert.equal(client.claims.length, 0);
  const hubFingerprint = fingerprintOf(hub);
  const wrong = client.invoke('desktop.pairing_confirm', {
    fingerprint: '0'.repeat(64),
    fingerprint_tail: '0000',
  });
  assert.equal((wrong as { reason?: string }).reason, 'pairing_step_mismatch');
  // 中枢の画面の指紋と違う 4 桁では申請へ進まない（main が受け取った証明書の指紋と比べる）。
  const otherTail = hubFingerprint.endsWith('0000') ? '1111' : '0000';
  const wrongTail = client.invoke('desktop.pairing_confirm', {
    fingerprint: hubFingerprint,
    fingerprint_tail: otherTail,
  });
  assert.equal(
    (wrongTail as { reason?: string }).reason,
    'fingerprint_tail_mismatch',
  );
  assert.equal(client.claims.length, 0);
  // 本人が中枢の画面（別の実装で求めた指紋）から読んだ最後の 4 桁を入力する。
  const confirm = client.invoke('desktop.pairing_confirm', {
    fingerprint: hubFingerprint,
    fingerprint_tail: hubFingerprint.slice(-4),
  });
  assert.equal(confirm.outcome, 'ok');
  const submit = client.invoke('desktop.pairing_submit', {
    pairing_code: code,
    device_name: `合成の端末 ${client.name}`,
  });
  assert.equal(submit.outcome, 'ok');
  await waitUntil(
    () => client.view().pairing?.step === 'waiting_approval',
    `${client.name} waiting`,
  );
  await approve();
  await waitUntil(
    () => client.link.registration === 'registered',
    `${client.name} registered`,
  );
  await waitUntil(
    () => client.view().link === 'connected',
    `${client.name} live`,
  );
}

async function pairTwoClients(
  t: test.TestContext,
  hub: TestHub,
): Promise<{ readonly a: Client; readonly b: Client }> {
  const a = await createClient(t, 'A');
  const b = await createClient(t, 'B');
  a.link.start('unlocked');
  b.link.start('unlocked');
  assert.equal(a.view().registration, 'unregistered');
  assert.equal(a.view().link, 'not_connected');
  // A: 最初の端末（登録済みの端末が 0 台）を中枢の CLI の承認（制御の入口）で登録する。
  const pairing = hub.handle.pairing;
  assert(pairing !== null);
  const first = await pairing.startFirstDevice();
  assert(first.ok);
  assert.equal(first.certificate_fingerprint, fingerprintOf(hub));
  await pair(a, hub, first.pairing_code, async () => {
    await waitUntil(() => a.claims.length === 1, 'A claim');
    const approved = await pairing.approveFirstDevice(first.pairing_id);
    assert(approved.ok, approved.ok ? '' : approved.reason);
  });
  // B: A（中枢の画面の端末）がペアリングを始めて承認する。
  const started = await hubScreen(hub, a, '/v1/pairing/sessions', {});
  assert.equal(started.kind, 'response');
  assert.equal(started.kind === 'response' && started.status, 201);
  const session = (started as { body: Record<string, unknown> }).body;
  await pair(b, hub, String(session['pairing_code']), async () => {
    await waitUntil(() => b.claims.length === 1, 'B claim');
    const decided = await hubScreen(
      hub,
      a,
      `/v1/pairing/claims/${b.claims[0] ?? ''}/decision`,
      { decision: 'approve' },
    );
    assert.equal(decided.kind === 'response' && decided.status, 200);
  });
  return { a, b };
}

// 接続している（live）ときの管理の入口の応答。接続した直後は、届いたイベントで取り直し（resnapshot）が
// 起きて一時的に live でなくなることがあり、その間の要求は not_connected になる（負荷の高い CI で見た）。
// 試験は live に戻るのを待って送り直す（main は送っていないので、送り直しで中枢に二重に届くことはない）。
async function adminWhenLive(
  client: Client,
  channel: string,
  payload: unknown,
): Promise<DesktopIpcResponse> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await waitUntil(
      () => client.link.linkState?.phase === 'live',
      `${client.name} live`,
    );
    const response = await client.admin(channel, payload);
    if ((response as { reason?: string }).reason !== 'not_connected')
      return response;
  }
  throw new Error(`${client.name} did not stay live for ${channel}`);
}

const opsOf = (client: Client) =>
  (client.link.linkState?.operations ?? []).map((op) => [
    op.operation_id,
    op.state_revision,
    op.state,
  ]);

function assertNoSecrets(
  clients: readonly Client[],
  secrets: readonly string[],
) {
  for (const client of clients) {
    const shown = JSON.stringify(client.ipc);
    const logs = client.logs.join('\n');
    for (const secret of secrets) {
      // 値そのものは出さない（真偽だけを確かめる）。
      assert.equal(shown.includes(secret), false, `${client.name} ipc leaked`);
      assert.equal(logs.includes(secret), false, `${client.name} log leaked`);
    }
    // 保存したファイルに平文のトークンがない。
    const stored = readFileSync(client.credentialPath);
    for (const secret of secrets)
      assert.equal(
        stored.includes(Buffer.from(secret)),
        false,
        `${client.name} file`,
      );
  }
}

test(
  'two clients pair over pinned connections; an unregistered token is 401; revoking A disconnects A only',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdt-');
    const live = await startHub(t, {
      dataDir: join(dir, 'd'),
      port: await freePort(),
    });
    await submitDurable(
      live,
      createCommand('00000000-0000-4000-8000-0000000000d1'),
    );
    const { a, b } = await pairTwoClients(t, live);
    assert.notEqual(a.view().operations.length, 0);
    assert.deepEqual(opsOf(a), opsOf(b));
    assert.deepEqual(opsOf(a), [
      ['00000000-0000-4000-8000-0000000000d1', '1', 'awaiting_approval'],
    ]);

    // 未登録のトークン（形式は正しい合成の値）は 401 で、再登録が必要になり要求を続けない。
    const strangerDir = await tempDir(t, 'bds-');
    const strangerProtector = mockProtector();
    const credential = JSON.parse(
      a.protector.reveal(readFileSync(a.credentialPath)),
    ) as Record<string, unknown>;
    writeFileSync(
      join(strangerDir, CREDENTIAL_FILE),
      strangerProtector.encryptString(
        JSON.stringify({
          ...credential,
          device_id: randomUUID(),
          device_token: 'Z'.repeat(43),
        }),
      ),
    );
    const stranger = await createClient(t, 'S', {
      dir: strangerDir,
      protector: strangerProtector,
    });
    stranger.link.start('unlocked');
    await waitUntil(
      () => stranger.view().link === 'reregistration_required',
      'stranger 401',
    );
    assert.equal(stranger.view().link_reason, 'unauthenticated');
    assert.equal(stranger.view().registration, 'reregistration_required');

    // A を失効する（B が中枢の画面の端末として操作）。A は 4401 で切断され再登録が必要、B は使い続ける。
    const aDevice = a.link.linkState?.deviceId;
    assert(typeof aDevice === 'string');
    const tokenA = a.token();
    const tokenB = b.token();
    const revoked = await hubScreen(
      live,
      b,
      `/v1/devices/${aDevice}/revoke`,
      {},
    );
    assert.equal(revoked.kind === 'response' && revoked.status, 200);
    await waitUntil(
      () => a.view().link === 'reregistration_required',
      'A revoked',
    );
    assert.equal(a.view().link_reason, 'device_revoked');
    assert.deepEqual(a.view().operations, []);
    assert.equal(b.view().link, 'connected');
    // B は命令を送れる（取消は durable）。A の端末は送らない。
    const cancelled = await b.link.connection?.send({
      kind: 'cancel',
      operationId: '00000000-0000-4000-8000-0000000000d1',
      expectedStateRevision: '1',
    });
    assert.equal(cancelled?.kind, 'accepted');
    assert.deepEqual(
      await a.link.connection?.send({
        kind: 'cancel',
        operationId: '00000000-0000-4000-8000-0000000000d1',
        expectedStateRevision: '1',
      }),
      { kind: 'not_sent', reason: 'not_connected' },
    );
    await waitUntil(
      () => opsOf(b)[0]?.[2] === 'cancelled',
      'B sees its cancel',
    );

    // 失効した A のトークンで起動し直しても 401（再登録が必要）。
    const again = await createClient(t, 'A2', {
      dir: join(a.credentialPath, '..'),
      protector: a.protector,
    });
    again.link.start('unlocked');
    await waitUntil(
      () => again.view().link === 'reregistration_required',
      'A token 401',
    );
    assert.equal(again.view().link_reason, 'unauthenticated');
    assert.equal(b.view().link, 'connected');
    assertNoSecrets([a, b, again], [tokenA, tokenB]);
  },
);

test(
  'after the hub certificate is replaced both clients send nothing and need re-registration',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdc-');
    const port = await freePort();
    const hub = await startHub(t, { dataDir: join(dir, 'd'), port });
    const { a, b } = await pairTwoClients(t, hub);
    const tokens = [a.token(), b.token()];
    const oldFingerprint = fingerprintOf(hub);
    await hub.handle.stop('replace certificate');
    await waitUntil(
      () =>
        a.view().link === 'waiting_retry' && b.view().link === 'waiting_retry',
      'both waiting',
    );
    // 鍵の項目を消した中枢（新しい鍵と証明書。指紋が変わる）。
    const replaced = await startHub(t, {
      dataDir: hub.dataDir,
      port,
      tlsKeyStore: createMockTlsKeyStore(),
    });
    assert.notEqual(fingerprintOf(replaced), oldFingerprint);
    for (const client of [a, b]) {
      client.link.networkMayHaveChanged('test');
      await waitUntil(
        () => client.view().link === 'reregistration_required',
        `${client.name} certificate`,
      );
      assert.equal(client.view().link_reason, 'certificate_mismatch');
      assert.equal(client.view().registration, 'reregistration_required');
    }
    // 中枢は前の証明書で登録した端末を起動時に失効している（中枢の記録）。
    const devices = await replaced.handle.store.pairing({
      kind: 'devices.count_active',
    });
    assert(devices.ok);
    assert.equal(devices.value.count, 0);
    assertNoSecrets([a, b], tokens);
  },
);

test(
  'after a hub restart both clients reconnect with new scopes, show the same IDs, versions and states, and replay missed events; commands made while down are not sent',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdr-');
    const port = await freePort();
    const hub = await startHub(t, { dataDir: join(dir, 'd'), port });
    const waiting = '00000000-0000-4000-8000-0000000000e1';
    const held = '00000000-0000-4000-8000-0000000000e2';
    await submitDurable(hub, createCommand(waiting));
    await submitDurable(hub, createCommand(held, { auto: true }));
    const prepare = prepareCommand(held, '1');
    await submitDurable(hub, prepare);
    await submitDurable(hub, dispatchCommand(held, '2', prepare.attempt_id));
    const { a, b } = await pairTwoClients(t, hub);
    const before = [
      [waiting, '1', 'awaiting_approval'],
      [held, '3', 'dispatching'],
    ];
    assert.deepEqual(opsOf(a), before);
    assert.deepEqual(opsOf(b), before);
    const scopes = [
      a.link.linkState?.commandScopeId,
      b.link.linkState?.commandScopeId,
    ];
    const coreBefore = a.link.linkState?.coreInstanceId;

    await hub.handle.stop('restart');
    await waitUntil(
      () =>
        a.view().link === 'waiting_retry' && b.view().link === 'waiting_retry',
      'both waiting',
    );
    // 切断中は画面へ操作を出さない（古い値を今の値として見せない）。状態機械は値を持ち続け、
    // 再接続では cursor から続ける。切断中の取消は送らずに返す。
    assert.deepEqual(a.view().operations, []);
    assert.deepEqual(
      a.link.linkState?.operations.map((op) => [
        op.operation_id,
        op.state_revision,
        op.state,
      ]),
      before,
    );
    assert.deepEqual(
      await a.link.connection?.send({
        kind: 'cancel',
        operationId: waiting,
        expectedStateRevision: '1',
      }),
      { kind: 'not_sent', reason: 'not_connected' },
    );

    // 再起動: 起動時の回復で送出意図のまま止まった操作を unknown_held へ回す（停止中のイベント）。
    const sentBefore = [a.requests.length, b.requests.length];
    const restarted = await startHub(t, {
      dataDir: hub.dataDir,
      port,
      tlsKeyStore: hub.tlsKeyStore,
    });
    assert.deepEqual(restarted.handle.recovery.held, [held]);
    for (const client of [a, b]) client.link.networkMayHaveChanged('test');
    const after = [
      [waiting, '1', 'awaiting_approval'],
      [held, '4', 'unknown_held'],
    ];
    await waitUntil(
      () =>
        JSON.stringify(opsOf(a)) === JSON.stringify(after) &&
        JSON.stringify(opsOf(b)) === JSON.stringify(after),
      'missed events replayed',
    );
    for (const [index, client] of [a, b].entries()) {
      const state = client.link.linkState;
      assert.equal(client.view().link, 'connected');
      assert.notEqual(state?.commandScopeId, scopes[index]);
      assert.equal(state?.coreInstanceId, restarted.handle.coreInstanceId);
      assert.notEqual(state?.coreInstanceId, coreBefore);
      assert.equal(state?.storeGeneration, restarted.handle.storeGeneration);
    }
    // 再接続は bootstrap（新しい接続範囲）→ cursor からの購読で、スナップショットを取り直していない。
    // 欠けたイベント（回復の unknown_held）は購読で受け取り、その操作だけを取り直した。
    for (const [index, client] of [a, b].entries()) {
      const sent = client.requests.slice(sentBefore[index]);
      const label = `${client.name} ${JSON.stringify(sent)}`;
      assert(sent.includes('GET /v1/bootstrap'), label);
      assert(!sent.includes('GET /v1/snapshot'), label);
      assert(sent.includes(`GET /v1/operations/${held}`), label);
      assert(!sent.includes(`GET /v1/operations/${waiting}`), label);
      // 命令（POST /v1/operations/...）は送っていない。自宅の指紋の報告だけは送る。
      assert(
        sent.every((line) => !line.startsWith('POST /v1/operations/')),
        label,
      );
    }
    // 中枢の値と同じ（別の実装の値と比べる）。
    for (const [id, revision, state] of after) {
      const record = await restarted.handle.store.query({
        kind: 'operation',
        operation_id: id ?? '',
      });
      assert.equal(record?.state_revision, revision);
      assert.equal(record?.state, state);
    }
    // 切断中の取消は復帰しても送られていない（中枢に受付がない）。
    const receipt = await restarted.handle.store.query({
      kind: 'operation',
      operation_id: waiting,
    });
    assert.equal(receipt?.state, 'awaiting_approval');
    assert.equal(receipt?.state_revision, '1');
    assertNoSecrets([a, b], [a.token(), b.token()]);
  },
);

test(
  'the hub screen opens pairing, approves the claim with the matching claim check and revokes a device through the IPC; other devices get neither (B03-06)',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdh-');
    const machine = { same: true };
    const hub = await startHub(t, {
      dataDir: join(dir, 'd'),
      port: await freePort(),
      sameMachine: () => machine.same,
      homeNetwork: true,
    });
    const a = await createClient(t, 'A');
    // B の受取りは、A が承認して「中枢と別のマシン」に切り替えるまで送らせない（hub_local でない端末にする）。
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const b = await createClient(t, 'B', { beforePickup: () => gate });
    a.link.start('unlocked');
    b.link.start('unlocked');
    const pairing = hub.handle.pairing;
    assert(pairing !== null);
    const first = await pairing.startFirstDevice();
    assert(first.ok);
    await pair(a, hub, first.pairing_code, async () => {
      await waitUntil(() => a.claims.length === 1, 'A claim');
      const approved = await pairing.approveFirstDevice(first.pairing_id);
      assert(approved.ok);
    });
    await waitUntil(() => a.view().hub_screen, 'A is the hub screen');

    const empty = await a.admin('desktop.claims_list', null);
    assert.deepEqual(empty, {
      request_id: (empty as { request_id: string }).request_id,
      channel: 'desktop.claims_list',
      outcome: 'ok',
      claims: [],
      // main の一覧の通し番号（この端末で最初の申請の一覧）。
      list_seq: 1,
    });
    // 中枢の画面でペアリングを始める（コードは本人が端末へ入力するための表示で、この応答にだけ入る）。
    const opened = await a.admin('desktop.pairing_open', null);
    assert.equal(opened.outcome, 'ok');
    const session = (
      opened as {
        session: {
          pairing_code: string;
          certificate_fingerprint: string;
          expires_at: string;
          hub_endpoint: { host: string; port: number };
        };
      }
    ).session;
    assert.equal(session.certificate_fingerprint, fingerprintOf(hub));
    // 登録する端末で入力する宛先（中枢の待ち受けのアドレスとポート）も、中枢の画面に出せる。
    assert.deepEqual(session.hub_endpoint, {
      host: '127.0.0.1',
      port: hub.port,
    });
    let decided: DesktopIpcResponse | null = null;
    await pair(b, hub, session.pairing_code, async () => {
      // 端末の画面の確認コードと、中枢の画面の一覧の確認コードが同じ申請を承認する。
      const check = b.view().pairing?.claim_check;
      assert.match(String(check), /^[0-9a-f]{8}$/u);
      const listed = await a.admin('desktop.claims_list', null);
      const claims = (
        listed as unknown as { claims: Record<string, unknown>[] }
      ).claims;
      assert.equal(claims.length, 1);
      assert.equal(claims[0]?.['claim_check'], check);
      assert.equal(claims[0]?.['device_name'], '合成の端末 B');
      assert.deepEqual(Object.keys(claims[0] ?? {}).sort(), [
        'claim_check',
        'claimed_at',
        'device_name',
        'expires_at',
        'platform',
        'ref',
      ]);
      // 画面は一覧を定期的に取り直す。確認を開いている間に取り直しても、同じ申請の参照は変わらない。
      const relisted = (
        (await a.admin('desktop.claims_list', null)) as unknown as {
          claims: Record<string, unknown>[];
        }
      ).claims;
      assert.equal(relisted[0]?.['ref'], claims[0]?.['ref']);
      // 古い参照・画面操作でない・ロック中は送らない。
      const stale = await a.admin('desktop.claim_decide', {
        ref: randomUUID(),
        decision: 'approve',
      });
      assert.equal((stale as { reason?: string }).reason, 'entry_not_found');
      const unfocused = await a.admin(
        'desktop.claim_decide',
        { ref: claims[0]?.['ref'], decision: 'approve' },
        { sender: { trustedSender: true, windowFocused: false } },
      );
      assert.equal(
        (unfocused as { reason?: string }).reason,
        'screen_operation_required',
      );
      decided = await a.admin('desktop.claim_decide', {
        ref: claims[0]?.['ref'],
        decision: 'approve',
      });
      // main は確認に、中枢から受け取った端末名と確認コード（端末の画面と同じ値）を出した。
      assert.deepEqual(
        a.confirms.flatMap((entry) =>
          entry.action === 'register_home' ||
          entry.action === 'approve_operation'
            ? []
            : [[entry.action, entry.deviceName, entry.claimCheck]],
        ),
        [['approve', '合成の端末 B', check]],
      );
      // 受取りの前に「中枢と別のマシン」へ切り替え、B を hub_local でない端末として登録させる。
      machine.same = false;
      openGate();
    });
    assert.equal(decided?.['outcome' as never], 'ok');
    assert.deepEqual((decided as unknown as { claims: unknown[] }).claims, []);
    machine.same = true;

    // B は中枢の画面ではない: 画面を出さず、経路は 403（hub_screen_required）。
    await waitUntil(() => b.link.linkState?.phase === 'live', 'B live');
    const refused = await adminWhenLive(b, 'desktop.claims_list', null);
    assert.equal(
      (refused as { reason?: string }).reason,
      'hub_screen_required',
    );
    assert.equal(b.view().hub_screen, false);
    // 一覧・承認・拒否・失効・ペアリングの開始のどれも、参照の確かめ（entry_not_found）より先に hub_screen_required で拒否する。
    const refusedOperations: [string, unknown][] = [
      ['desktop.devices_list', null],
      ['desktop.claim_decide', { ref: randomUUID(), decision: 'approve' }],
      ['desktop.claim_decide', { ref: randomUUID(), decision: 'reject' }],
      ['desktop.device_revoke', { ref: randomUUID() }],
      ['desktop.pairing_open', null],
    ];
    for (const [channel, payload] of refusedOperations) {
      const refusedOperation = await adminWhenLive(b, channel, payload);
      assert.equal(
        (refusedOperation as { reason?: string }).reason,
        'hub_screen_required',
        channel,
      );
    }

    // 端末の一覧: この端末（参照なし）と B（参照あり）。
    const devices = (
      (await a.admin('desktop.devices_list', null)) as unknown as {
        devices: Record<string, unknown>[];
      }
    ).devices;
    assert.deepEqual(
      devices.map((device) => [
        device['device_name'],
        device['this_device'],
        device['hub_local'],
        device['ref'] === null,
        device['revoked_at'],
      ]),
      [
        ['合成の端末 A', true, true, true, null],
        ['合成の端末 B', false, false, false, null],
      ],
    );
    const devicesAgain = (
      (await a.admin('desktop.devices_list', null)) as unknown as {
        devices: Record<string, unknown>[];
      }
    ).devices;
    assert.equal(devicesAgain[1]?.['ref'], devices[1]?.['ref']);
    // 失効: B はすぐに 4401 で切断されて再登録が必要、A は接続したまま。
    const revoked = await a.admin('desktop.device_revoke', {
      ref: devices[1]?.['ref'],
    });
    assert.equal(revoked.outcome, 'ok');
    const after = (revoked as unknown as { devices: Record<string, unknown>[] })
      .devices;
    assert.equal(after[1]?.['ref'], null);
    assert.equal(typeof after[1]?.['revoked_at'], 'string');
    await waitUntil(
      () => b.view().link === 'reregistration_required',
      'B revoked',
    );
    assert.equal(b.view().link_reason, 'device_revoked');
    assert.equal(a.view().link, 'connected');
    assert.equal(a.view().hub_screen, true);

    // 一覧・応答・ログにトークン・コードが出ない（コードはペアリングを始めた応答にだけある）。
    const secrets = [a.token(), session.pairing_code];
    const shown = a.ipc.filter(
      (entry) =>
        (entry as { channel?: string }).channel !== 'desktop.pairing_open',
    );
    for (const secret of secrets) {
      assert.equal(JSON.stringify(shown).includes(secret), false);
      assert.equal(a.logs.join('\n').includes(secret), false);
      assert.equal(b.logs.join('\n').includes(secret), false);
      assert.equal(JSON.stringify(b.ipc).includes(secret), false);
    }
    assertNoSecrets([a], [a.token()]);
  },
);

// 中枢の Tailscale の状態（模擬の `tailscale status --json`。実機の tailscale は呼ばない）。試験のクライアントは
// 127.0.0.1 から接続するので、合成のピアのアドレスを 127.0.0.1 にする。direct は直接経路（CurAddr）が自宅の
// LAN（192.0.2.0/24）の中、derp は中継（CurAddr なし）。
function mockTailscale(state: { path: 'direct' | 'derp' }) {
  const runner = createMockCommandRunner(() => ({
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      BackendState: 'Running',
      Self: { TailscaleIPs: ['100.64.0.1'] },
      Peer: {
        'nodekey:synthetic': {
          TailscaleIPs: ['127.0.0.1'],
          ...(state.path === 'direct'
            ? { CurAddr: '192.0.2.23:41641', Relay: 'tok' }
            : { Relay: 'tok' }),
        },
      },
    }),
  }));
  return createTailscaleStatusSource({
    runner,
    commands: ['tailscale'],
    ttlMs: 0,
  });
}

function homeOf(response: DesktopIpcResponse): DesktopHomeView {
  assert(
    response.outcome === 'ok' && 'home' in response,
    JSON.stringify(response),
  );
  return response.home;
}

// 申請までの画面の流れ（指紋の確認 → コード）を進め、申請が拒否されたときの失敗を返す。
async function claimRefused(
  client: Client,
  hub: TestHub,
  code: string,
): Promise<string | null> {
  const begin = client.invoke('desktop.pairing_begin', {
    host: '127.0.0.1',
    port: hub.port,
  });
  assert.equal(begin.outcome, 'ok');
  await waitUntil(
    () => client.view().pairing?.step === 'fingerprint_check',
    `${client.name} fingerprint`,
  );
  const fingerprint = fingerprintOf(hub);
  const confirmed = client.invoke('desktop.pairing_confirm', {
    fingerprint,
    fingerprint_tail: fingerprint.slice(-4),
  });
  assert.equal(confirmed.outcome, 'ok');
  const submitted = client.invoke('desktop.pairing_submit', {
    pairing_code: code,
    device_name: `合成の端末 ${client.name}`,
  });
  assert.equal(submitted.outcome, 'ok');
  await waitUntil(
    () => client.view().pairing?.step === 'failed',
    `${client.name} refused`,
  );
  return client.view().pairing?.failure ?? null;
}

test(
  'the hub screen registers the home network through the IPC; a device on another machine is refused before and passes the home check after (B03-08)',
  { timeout: 90_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdn-');
    // 接続元が中枢と同じマシンか。2 クライアントはどちらも 127.0.0.1 から接続するので、B の申請・受取りの間だけ
    // 「別のマシン」に切り替えて、B を中枢と別のマシンの端末（hub_local でない）として登録させる。
    const machine = { same: true };
    const tailscale: { path: 'direct' | 'derp' } = { path: 'direct' };
    const hub = await startHub(t, {
      dataDir: join(dir, 'd'),
      port: await freePort(),
      sameMachine: () => machine.same,
      tailscale: mockTailscale(tailscale),
    });
    const a = await createClient(t, 'A', { home: HOME_WIFI });
    // B の受取りは、A が承認して「別のマシン」に切り替えるまで送らせない。
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    // B のネットワーク（試験の途中で Wi-Fi 名・ルーターを変える）。
    let bNetwork: HomeObservation = HOME_WIFI;
    const b = await createClient(t, 'B', {
      home: () => bNetwork,
      beforePickup: () => gate,
    });
    a.link.start('unlocked');
    b.link.start('unlocked');
    const pairing = hub.handle.pairing;
    assert(pairing !== null);
    const first = await pairing.startFirstDevice();
    assert(first.ok);
    await pair(a, hub, first.pairing_code, async () => {
      await waitUntil(() => a.claims.length === 1, 'A claim');
      const approved = await pairing.approveFirstDevice(first.pairing_id);
      assert(approved.ok);
    });
    const hubScreenReady = () =>
      waitUntil(
        () => a.view().link === 'connected' && a.view().hub_screen,
        'A is the hub screen',
      );
    await hubScreenReady();
    // A が落ち着くまで待つ: 接続中・中枢の画面で、自宅判定による切断（outside_home_network のログ）が
    // 600 ms（中枢の ping の 3 回分）新しく起きていない。固定の待ち時間に頼らず、「別のマシン」の間に始まった
    // 判定の失効が後から来ても、その後の再接続（新しい接続範囲）まで待つ。
    const hubScreenSettled = async () => {
      const denials = () =>
        a.logs.filter((code) => code.includes('outside_home_network')).length;
      let seen = denials();
      let quietSince = Date.now();
      await waitUntil(
        () => {
          const count = denials();
          if (count !== seen) {
            seen = count;
            quietSince = Date.now();
          }
          return (
            Date.now() - quietSince >= 600 &&
            a.view().link === 'connected' &&
            a.view().hub_screen
          );
        },
        'A settled as the hub screen',
        20_000,
      );
    };

    // 登録の前: 中枢の画面は未登録。このマシンのネットワークは伏せて見せる（生の値は main だけが持つ）。
    const before = homeOf(await a.admin('desktop.home_status', null));
    assert.equal(before.registration, null);
    assert.equal(before.observation?.gateway_mac_tail, '53:01');
    assert.equal(before.observation?.subnet, '192.0.2.0/24');
    assert.deepEqual(before.observation?.ssid_hint, {
      first: '合',
      length: 5,
    });
    assert.equal(before.observation?.ssid_unavailable_reason, null);

    // 登録の前に、中枢と別のマシンの B が申請すると、自宅判定（未登録）で拒否され、申請は中枢に届かない。
    const opened = await a.admin('desktop.pairing_open', null);
    assert.equal(opened.outcome, 'ok');
    const code = (opened as { session: { pairing_code: string } }).session
      .pairing_code;
    machine.same = false;
    const refused = await claimRefused(b, hub, code);
    machine.same = true;
    assert.equal(refused, 'outside_home_network');
    assert.equal(b.claims.length, 0);
    // 「別のマシン」の間に A の購読が自宅判定で閉じられていても、同じマシンに戻れば接続し直す。
    await hubScreenSettled();
    const noClaims = await a.admin('desktop.claims_list', null);
    assert.deepEqual((noClaims as unknown as { claims: unknown[] }).claims, []);

    // 中枢の画面で、確かめた参照を使って自宅を登録する（確認の Dialog は画面の試験で確かめる）。
    const shown = homeOf(await a.admin('desktop.home_status', null));
    const ref = shown.observation?.ref;
    assert(typeof ref === 'string');
    const registered = homeOf(
      await a.admin('desktop.home_register', { ref, include_ssid: true }),
    );
    assert.equal(registered.registration?.subnet, '192.0.2.0/24');
    // 登録は、承認・失効と同じ OS の確認（main の confirmAdmin）を経た。出したのは伏せた値だけ。
    assert.deepEqual(a.confirms.at(-1), {
      action: 'register_home',
      replacing: false,
      macTail: '53:01',
      subnet: '192.0.2.0/24',
      includeSsid: true,
      ssidHint: { first: '合', length: 5 },
      ssidChange: null,
    });
    assert.equal(registered.registration?.ssid_registered, true);
    assert.equal(typeof registered.registration?.registered_at, 'string');
    // 中枢は MAC・SSID を HMAC にして保存する（平文を保存しない）。
    const stored = await hub.handle.store.home({ kind: 'home.get' });
    assert(stored.ok && stored.value !== null);
    assert.match(stored.value.gateway_mac_hmac, /^[0-9a-f]{64}$/u);
    assert.match(String(stored.value.ssid_hmac), /^[0-9a-f]{64}$/u);
    assert.equal(stored.value.subnet, '192.0.2.0/24');
    const again = homeOf(await a.admin('desktop.home_status', null));
    assert.deepEqual(again.registration, registered.registration);

    // 登録の後: B は中枢と別のマシンのまま、自宅の指紋と Tailscale の直接経路で申請・受取り・接続できる。
    const reopened = await a.admin('desktop.pairing_open', null);
    assert.equal(reopened.outcome, 'ok');
    const code2 = (reopened as { session: { pairing_code: string } }).session
      .pairing_code;
    machine.same = false;
    await pair(b, hub, code2, async () => {
      await waitUntil(() => b.claims.length === 1, 'B claim at home');
      // 承認は中枢の画面（同じマシン）から。
      machine.same = true;
      await hubScreenReady();
      const listed = await a.admin('desktop.claims_list', null);
      const claims = (
        listed as unknown as { claims: { ref: string; claim_check: string }[] }
      ).claims;
      assert.equal(claims.length, 1);
      assert.equal(claims[0]?.claim_check, b.view().pairing?.claim_check);
      const decided = await a.admin('desktop.claim_decide', {
        ref: claims[0]?.ref,
        decision: 'approve',
      });
      assert.equal(decided.outcome, 'ok');
      machine.same = false;
      openGate();
    });
    machine.same = true;
    // B は中枢と別のマシンの端末（hub_local でない）で、免除ではなく自宅判定を通って接続している。
    const bView = b.view();
    assert.equal(bView.link, 'connected');
    assert.equal(bView.hub_screen, false);
    assert.equal(bView.home_network?.allowed, true);
    assert.equal(bView.home_network?.exempt, false);
    assert.deepEqual(bView.home_network?.reasons, []);
    const devices = (
      (await a.admin('desktop.devices_list', null)) as unknown as {
        devices: Record<string, unknown>[];
      }
    ).devices;
    assert.deepEqual(
      devices.map((device) => [device['device_name'], device['hub_local']]),
      [
        ['合成の端末 A', true],
        ['合成の端末 B', false],
      ],
    );
    // B は中枢の画面ではないので、自宅のネットワークの画面も経路もない。
    const bHome = await adminWhenLive(b, 'desktop.home_status', null);
    assert.equal((bHome as { reason?: string }).reason, 'hub_screen_required');

    // 指紋が同じでも直接経路でなければ通さない: Tailscale が中継（DERP）に変わると B の購読は閉じ、
    // A（中枢と同じマシン）は接続したまま。直接経路に戻れば B は接続し直す。
    tailscale.path = 'derp';
    await waitUntil(
      () =>
        b.view().link !== 'connected' &&
        b.view().link_reason === 'outside_home_network',
      'B outside the home',
    );
    assert.equal(a.view().link, 'connected');
    tailscale.path = 'direct';
    await waitUntil(() => b.view().link === 'connected', 'B back at home');

    // Wi-Fi 名（SSID）も確かめるか（本人の判断 2026-10-22。既定は確かめる）。
    // 確かめる登録では、ルーター・サブネットが同じでも Wi-Fi 名の違う B は拒否される。
    const reasonsOfB = () => b.view().home_network?.reasons ?? [];
    bNetwork = { ...HOME_WIFI, ssid: '合成の別の家' };
    b.link.networkMayHaveChanged('test');
    await waitUntil(
      () =>
        reasonsOfB().includes('ssid_mismatch') && b.view().link !== 'connected',
      'B refused by the Wi-Fi name',
    );
    assert.deepEqual(reasonsOfB(), ['ssid_mismatch']);
    assert.equal(a.view().link, 'connected');
    // 中枢の画面で「Wi-Fi 名も確かめる」を切って登録し直すと、B は自宅判定を通る。
    const offRef = homeOf(await a.admin('desktop.home_status', null))
      .observation?.ref;
    const off = homeOf(
      await a.admin('desktop.home_register', {
        ref: offRef,
        include_ssid: false,
      }),
    );
    assert.equal(off.registration?.ssid_registered, false);
    b.link.networkMayHaveChanged('test');
    await waitUntil(
      () =>
        b.view().link === 'connected' &&
        b.view().home_network?.allowed === true,
      'B passes without the Wi-Fi name',
    );
    assert.deepEqual(reasonsOfB(), []);
    // 切っていても、ルーターの MAC アドレスが違えば拒否される（残りの指紋と直接経路は確かめる）。
    bNetwork = {
      ...HOME_WIFI,
      gateway_mac: '00:00:5e:00:53:02',
      ssid: '合成の別の家',
    };
    b.link.networkMayHaveChanged('test');
    await waitUntil(
      () =>
        reasonsOfB().includes('gateway_mac_mismatch') &&
        b.view().link !== 'connected',
      'B refused by the router',
    );
    assert.deepEqual(reasonsOfB(), ['gateway_mac_mismatch']);
    // 確かめるように登録し直すと、Wi-Fi 名の違う B はまた拒否される。
    bNetwork = { ...HOME_WIFI, ssid: '合成の別の家' };
    const onRef = homeOf(await a.admin('desktop.home_status', null)).observation
      ?.ref;
    const on = homeOf(
      await a.admin('desktop.home_register', {
        ref: onRef,
        include_ssid: true,
      }),
    );
    assert.equal(on.registration?.ssid_registered, true);
    b.link.networkMayHaveChanged('test');
    await waitUntil(
      () =>
        reasonsOfB().includes('ssid_mismatch') && b.view().link !== 'connected',
      'B refused again by the Wi-Fi name',
    );
    assert.deepEqual(reasonsOfB(), ['ssid_mismatch']);
    assert.equal(a.view().link, 'connected');

    // MAC・SSID の生の値は、どちらの端末の画面・IPC・ログにも出ない（伏せた表示だけ）。
    for (const client of [a, b]) {
      const ipc = JSON.stringify(client.ipc);
      const logs = client.logs.join('\n');
      for (const raw of [
        '00:00:5e:00:53:01',
        '00:00:5e:00:53:02',
        '合成の自宅',
        '合成の別の家',
      ]) {
        assert.equal(ipc.includes(raw), false, `${client.name} IPC`);
        assert.equal(logs.includes(raw), false, `${client.name} log`);
      }
    }
    assertNoSecrets([a, b], [a.token(), b.token()]);
  },
);

// --- B04-05: 発言・承認・取消・照合（ADR 0031） ---

const TASK_TEXT = '「牛乳を買う」を用事に登録して';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const field = (response: DesktopIpcResponse, key: string): unknown =>
  (response as unknown as Record<string, unknown>)[key];

// 画面へ出した IPC・ログに、操作 ID・hash・preview_id のような中枢の値がない（参照だけ）。
function assertNoOperationValues(
  clients: readonly Client[],
  hidden: readonly string[],
) {
  for (const client of clients) {
    const shown = JSON.stringify(client.ipc);
    const logs = client.logs.join('\n');
    for (const value of hidden) {
      assert.equal(shown.includes(value), false, `${client.name} IPC`);
      assert.equal(logs.includes(value), false, `${client.name} log`);
    }
  }
}

test(
  "an operation made from A's message appears on B and one approval on B (confirmed by main) completes it",
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdw-');
    const hub = await startHub(t, {
      dataDir: join(dir, 'd'),
      port: await freePort(),
    });
    const { a, b } = await pairTwoClients(t, hub);
    // A の発言（文字入力）から、承認待ちの操作ができる。外部変更の完了ではなく、まだ何も実行していない。
    const turn = await a.work('desktop.turn_submit', { text: TASK_TEXT });
    assert.equal(turn.outcome, 'ok');
    const result = (
      field(turn, 'turn') as {
        status: string;
        result: { kind: string; status: string; operation_ref: string };
      }
    ).result;
    assert.equal(result.kind, 'approval_link');
    assert.equal(result.status, 'needs_review');
    assert.match(result.operation_ref, UUID);
    // 同じ操作が A にも B にも出る。参照は端末ごとに別で、承認待ち。
    await waitUntil(
      () =>
        a.view().operations.length === 1 && b.view().operations.length === 1,
      'both see the operation',
    );
    const entryA = a.view().operations[0];
    const entryB = b.view().operations[0];
    assert(entryA !== undefined && entryB !== undefined);
    assert.equal(entryA.ref, result.operation_ref);
    assert.notEqual(entryB.ref, entryA.ref);
    assert.equal(entryB.state, 'awaiting_approval');
    assert.equal(entryB.operation_kind, 'task.create');
    assert.equal(entryB.delivery_unknown, false);
    // 承認の準備: 確定した内容（題名・登録先）を中枢の値で見せる。確認を出す前は承認していない。
    const prepared = await b.work('desktop.operation_preview', {
      ref: entryB.ref,
    });
    assert.equal(prepared.outcome, 'ok');
    const preview = field(prepared, 'preview') as {
      preview_ref: string;
      operation_kind: string;
      service: string;
      target: string;
      fields: unknown[];
    };
    assert.deepEqual(
      {
        kind: preview.operation_kind,
        service: preview.service,
        target: preview.target,
        fields: preview.fields,
      },
      {
        kind: 'task.create',
        service: 'buddy',
        target: 'inbox',
        fields: [{ field: 'task_title', values: ['牛乳を買う'] }],
      },
    );
    assert.equal(b.confirms.length, 0);
    assert.equal(b.view().operations[0]?.state, 'awaiting_approval');
    // 承認: main の確認（模擬の confirmAdmin）が 1 回だけ出て、確定したときだけ中枢へ送る。
    const approved = await b.work('desktop.operation_approve', {
      ref: preview.preview_ref,
    });
    assert.equal(approved.outcome, 'ok');
    assert.match(String(field(approved, 'receipt')), /^(accepted|durable)$/u);
    assert.equal(b.confirms.length, 1);
    assert.deepEqual(b.confirms[0], {
      action: 'approve_operation',
      operationKind: 'task.create',
      service: 'buddy',
      target: 'inbox',
      fields: [{ field: 'task_title', values: ['牛乳を買う'] }],
    });
    await waitUntil(
      () =>
        a.view().operations[0]?.state === 'succeeded' &&
        b.view().operations[0]?.state === 'succeeded',
      'both see it succeeded',
    );
    assert.equal(
      b.requests.filter((line) => line.endsWith('/approve')).length,
      1,
    );
    // 同じ確認では、もう一度承認できない（確認は 1 回で使い切る。確認も増えない）。
    const again = await b.work('desktop.operation_approve', {
      ref: preview.preview_ref,
    });
    assert.equal(field(again, 'reason'), 'entry_not_found');
    assert.equal(b.confirms.length, 1);
    // 中枢の値（別の実装）と同じ状態で、画面へは操作 ID・hash・preview_id を出していない。
    const stored = a.link.linkState?.operations[0];
    assert(stored !== undefined);
    const record = await hub.handle.store.query({
      kind: 'operation',
      operation_id: stored.operation_id,
    });
    assert.equal(record?.state, 'succeeded');
    assertNoOperationValues([a, b], [stored.operation_id, stored.content_hash]);
    assertNoSecrets([a, b], [a.token(), b.token()]);
  },
);

test(
  'declining the confirmation sends nothing; an unknown outcome is shown, never resent, and cleared only when the operation moves',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdu-');
    const hub = await startHub(t, {
      dataDir: join(dir, 'd'),
      port: await freePort(),
    });
    const answers: boolean[] = [];
    const drop = { on: false };
    const a = await createClient(t, 'A');
    const b = await createClient(t, 'B', {
      confirm: () => answers.shift() ?? true,
      dropRequest: (method, path) =>
        method === 'POST' && path.endsWith('/approve') && drop.on,
    });
    // pairTwoClients と同じ手順で A・B を登録する（B にだけ試験用の差し込みを渡すため）。
    a.link.start('unlocked');
    b.link.start('unlocked');
    const pairing = hub.handle.pairing;
    assert(pairing !== null);
    const first = await pairing.startFirstDevice();
    assert(first.ok);
    await pair(a, hub, first.pairing_code, async () => {
      await waitUntil(() => a.claims.length === 1, 'A claim');
      const approved = await pairing.approveFirstDevice(first.pairing_id);
      assert(approved.ok);
    });
    const started = await hubScreen(hub, a, '/v1/pairing/sessions', {});
    const session = (started as { body: Record<string, unknown> }).body;
    await pair(b, hub, String(session['pairing_code']), async () => {
      await waitUntil(() => b.claims.length === 1, 'B claim');
      const decided = await hubScreen(
        hub,
        a,
        `/v1/pairing/claims/${b.claims[0] ?? ''}/decision`,
        { decision: 'approve' },
      );
      assert.equal(decided.kind === 'response' && decided.status, 200);
    });
    const turn = await a.work('desktop.turn_submit', { text: TASK_TEXT });
    assert.equal(turn.outcome, 'ok');
    await waitUntil(() => b.view().operations.length === 1, 'B sees it');
    const ref = b.view().operations[0]?.ref ?? '';
    const preview = async () =>
      field(await b.work('desktop.operation_preview', { ref }), 'preview') as {
        preview_ref: string;
      };
    const approveCount = () =>
      b.requests.filter((line) => line.endsWith('/approve')).length;

    // 確認で「やめる」: 送らず、承認していない。
    answers.push(false);
    const declined = await b.work('desktop.operation_approve', {
      ref: (await preview()).preview_ref,
    });
    assert.equal(field(declined, 'reason'), 'confirmation_declined');
    assert.equal(approveCount(), 0);
    assert.equal(b.view().operations[0]?.state, 'awaiting_approval');

    // 確認の後、中枢へ送ったが届いたか分からない: 結果不明（自動では送り直さない）。
    drop.on = true;
    const unknown = await b.work('desktop.operation_approve', {
      ref: (await preview()).preview_ref,
    });
    assert.equal(field(unknown, 'reason'), 'outcome_unknown');
    assert.equal(b.view().operations[0]?.delivery_unknown, true);
    assert.equal(b.view().operations[0]?.state, 'awaiting_approval');
    drop.on = false;
    // 時間が経っても送り直さない。同じ操作の承認・取消・照合・確認は、画面からも送らせない。
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(approveCount(), 1);
    for (const channel of [
      'desktop.operation_preview',
      'desktop.operation_cancel',
      'desktop.operation_reconcile',
    ]) {
      const held = await b.work(channel, { ref });
      assert.equal(field(held, 'reason'), 'entry_not_found', channel);
    }
    assert.equal(b.confirms.length, 2);
    assert.equal(approveCount(), 1);

    // 操作が進む（A が取り消す）と、結果不明の保留は解け、実際の状態が出る。
    const cancelled = await a.work('desktop.operation_cancel', {
      ref: a.view().operations[0]?.ref ?? '',
    });
    assert.equal(cancelled.outcome, 'ok');
    await waitUntil(
      () =>
        b.view().operations[0]?.state === 'cancelled' &&
        b.view().operations[0]?.delivery_unknown === false,
      'B sees the real state',
    );
    // 取り消された操作の承認は、確認を出さずに拒む（確かめた内容が今の状態と違う）。
    const stale = await b.work('desktop.operation_approve', { ref });
    assert.equal(field(stale, 'reason'), 'entry_not_found');
    assert.equal(b.confirms.length, 2);
  },
);

test(
  'while the input is stopped or the window is hidden, messages and approvals are refused and nothing is sent',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bds-');
    const hub = await startHub(t, {
      dataDir: join(dir, 'd'),
      port: await freePort(),
    });
    const { a } = await pairTwoClients(t, hub);
    const before = a.requests.length;
    const stopped = await a.link.handleOperationIpc(
      'desktop.turn_submit',
      {
        channel: 'desktop.turn_submit',
        request_id: randomUUID(),
        payload: { text: TASK_TEXT },
      },
      SCREEN,
      { ...UNLOCKED, stopScope: 'local' },
    );
    assert.equal(field(stopped.response, 'reason'), 'input_stopped');
    const cases: [typeof SCREEN, DesktopIoState, string][] = [
      [
        { ...SCREEN, windowFocused: false },
        UNLOCKED,
        'screen_operation_required',
      ],
      [SCREEN, { ...UNLOCKED, lockState: 'locked' }, 'device_locked'],
      [{ ...SCREEN, trustedSender: false }, UNLOCKED, 'untrusted_sender'],
    ];
    for (const [sender, state, reason] of cases) {
      const refused = await a.link.handleOperationIpc(
        'desktop.operation_approve',
        {
          channel: 'desktop.operation_approve',
          request_id: randomUUID(),
          payload: { ref: randomUUID() },
        },
        sender,
        state,
      );
      assert.equal(field(refused.response, 'reason'), reason);
    }
    // 形式の不正（未知の項目）は中枢へ行かない。
    const invalid = await a.link.handleOperationIpc(
      'desktop.operation_cancel',
      {
        channel: 'desktop.operation_cancel',
        request_id: randomUUID(),
        payload: { operation_id: randomUUID() },
      },
      SCREEN,
      UNLOCKED,
    );
    assert.equal(field(invalid.response, 'reason'), 'invalid_request');
    assert.equal(a.requests.length, before);
    assert.equal(a.confirms.length, 0);
  },
);

test(
  'after a hub restart a held result is shown as unknown on both clients and the manual reconcile request is sent once, as a reference-only request',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdk-');
    const port = await freePort();
    const hub = await startHub(t, { dataDir: join(dir, 'd'), port });
    const held = '00000000-0000-4000-8000-0000000000e2';
    await submitDurable(hub, createCommand(held, { auto: true }));
    const prepare = prepareCommand(held, '1');
    await submitDurable(hub, prepare);
    await submitDurable(hub, dispatchCommand(held, '2', prepare.attempt_id));
    const { a, b } = await pairTwoClients(t, hub);
    await hub.handle.stop('restart');
    const restarted = await startHub(t, {
      dataDir: hub.dataDir,
      port,
      tlsKeyStore: hub.tlsKeyStore,
    });
    assert.deepEqual(restarted.handle.recovery.held, [held]);
    for (const client of [a, b]) client.link.networkMayHaveChanged('test');
    await waitUntil(
      () =>
        a.view().operations[0]?.state === 'unknown_held' &&
        b.view().operations[0]?.state === 'unknown_held',
      'both see the unknown result',
    );
    const entry = b.view().operations[0];
    assert(entry !== undefined);
    // 結果不明は照合だけを出す。再試行・再承認の操作は出さない。
    assert.deepEqual(entry.allowed_actions, ['reconcile']);
    assert.equal(entry.delivery_unknown, false);
    // 自動では送っていない（再接続の後に POST /v1/operations/... がない）。本人の「照合」で 1 回だけ送る。
    const posts = () =>
      b.requests.filter((line) => line.startsWith('POST /v1/operations/'));
    assert.deepEqual(posts(), []);
    const reconciled = await b.work('desktop.operation_reconcile', {
      ref: entry.ref,
    });
    assert.match(String(reconciled.outcome), /^(ok|rejected)$/u);
    assert.deepEqual(posts(), [`POST /v1/operations/${held}/reconcile`]);
    assertNoOperationValues([a, b], [held]);
  },
);
