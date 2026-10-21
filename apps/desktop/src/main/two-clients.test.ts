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
import { createMockTlsKeyStore } from '@buddy/platform';
import type {
  DesktopConnectionView,
  DesktopIpcResponse,
} from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import { CREDENTIAL_FILE, parseCredential } from './credential-store.js';
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

interface Client {
  readonly name: string;
  readonly link: DesktopCoreLink;
  readonly protector: MockProtector;
  readonly credentialPath: string;
  // 画面へ出した値（応答・通知の接続の状態）とログ。トークンが出ていないかを確かめる。
  readonly ipc: unknown[];
  readonly logs: string[];
  readonly claims: string[];
  // 登録した端末として中枢へ送った要求（方法とパス。本文・ヘッダーは記録しない）。
  readonly requests: string[];
  view(): Extract<DesktopConnectionView, { visibility: 'shown' }>;
  invoke(channel: string, payload: unknown): DesktopIpcResponse;
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
  } = {},
): Promise<Client> {
  const dir = options.dir ?? (await tempDir(t, `bd${name}-`));
  const credentialPath = join(dir, CREDENTIAL_FILE);
  const protector = options.protector ?? mockProtector();
  const ipc: unknown[] = [];
  const logs: string[] = [];
  const claims: string[] = [];
  const requests: string[] = [];
  let link: DesktopCoreLink | null = null;
  link = new DesktopCoreLink({
    contract,
    credentialPath,
    protector,
    clock: systemClock(),
    platform: 'windows',
    collectHome: () => Promise.resolve(HOME),
    networkSignature: () => 'fixed',
    onChange: () => {
      if (link) ipc.push(link.view('unlocked'));
    },
    log: (code) => logs.push(code),
    backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
    aliveTimeoutMs: 3_000,
    pairingPollIntervalMs: options.pollIntervalMs ?? 50,
    transportFor: (hub, token) => {
      const transport = createHubTransport({ hub, token });
      return {
        request: (request) => {
          requests.push(`${request.method} ${request.path}`);
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

const opsOf = (client: Client) =>
  client
    .view()
    .operations.map((op) => [op.operation_id, op.state_revision, op.state]);

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
        };
      }
    ).session;
    assert.equal(session.certificate_fingerprint, fingerprintOf(hub));
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
      // 受取りの前に「中枢と別のマシン」へ切り替え、B を hub_local でない端末として登録させる。
      machine.same = false;
      openGate();
    });
    assert.equal(decided?.['outcome' as never], 'ok');
    assert.deepEqual((decided as unknown as { claims: unknown[] }).claims, []);
    machine.same = true;

    // B は中枢の画面ではない: 画面を出さず、経路は 403（hub_screen_required）。
    await waitUntil(() => b.link.linkState?.phase === 'live', 'B live');
    const refused = await b.admin('desktop.claims_list', null);
    assert.equal(
      (refused as { reason?: string }).reason,
      'hub_screen_required',
    );
    assert.equal(b.view().hub_screen, false);
    const refusedRevoke = await b.admin('desktop.devices_list', null);
    assert.equal(
      (refusedRevoke as { reason?: string }).reason,
      'hub_screen_required',
    );

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
