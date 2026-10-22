// 端末のペアリング・端末の一覧・失効の試験（ADR 0021）。Core（startCore）の HTTPS 経由で、127.0.0.1 の模擬。
// 鍵は模擬の KeyStore（実機のキーチェーンに触れない）。DB は一時ディレクトリ。
// 期待値: ペアリングとトークンの受取りは契約 fixture（api-scenarios.json の pairing・token_pickup）の値、
// それ以外（状態・コード）は試験に手で書いた値。指紋の期待値は X509Certificate から求める。
// コード・申請用の秘密・トークンは試験の中で作る合成の値で、アサーションのメッセージ・出力に入れない。

import assert from 'node:assert/strict';
import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createMockKeyStore, createMockTlsKeyStore } from '@buddy/platform';
import type { MockTlsKeyStore } from '@buddy/platform';
import type { DeviceRecord } from '@buddy/storage';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { commandScopeState } from './api-auth.js';
import {
  claimSecretHash,
  createPairingCode,
  isSameMachine,
} from './api-pairing.js';
import {
  onCleanup,
  pinnedCheck,
  pinnedRequest,
  tempDir,
  withTimeout,
} from './api-test-support.js';
import type { ApiResponse, PinnedTarget } from './api-test-support.js';
import { startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { DeviceConnections } from './device-connections.js';
import type { DeviceCloseReason } from './device-connections.js';
import {
  claimPairing,
  containsAny,
  createClaimSecret,
  fetchPeerCertificate,
  pickupToken,
  requireFingerprint,
  screenRequest,
} from './pairing-test-support.js';
import type { ClaimSecret } from './pairing-test-support.js';
import { TLS_CERTIFICATE_FILE } from './tls-identity.js';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';

const MINUTE = 60_000;

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;
const readContract = (path: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/${path}`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
const schema = readContract('schemas/buddy.schema.json') as { $id: string };
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validator = (name: string) => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert(validate, name);
  return validate;
};
const valid = {
  session: validator('PairingSession'),
  claim: validator('PairingClaim'),
  credential: validator('DeviceCredential'),
  list: validator('DeviceList'),
  summary: validator('DeviceSummary'),
  error: validator('ApiError'),
};

interface FixtureStep {
  readonly code: string;
  readonly now: string;
  readonly expected: {
    readonly ok: boolean;
    readonly reason: string | null;
    readonly attempts_left: number;
  };
}

interface PickupCase {
  readonly id: string;
  readonly claim: { readonly status: string; readonly expires_at: string };
  readonly secret_matches: boolean;
  readonly now: string;
  readonly expected: { readonly status: number; readonly code: string | null };
}

const scenarios = readContract('fixtures/api-scenarios.json') as unknown as {
  pairing: {
    initial: { pairing_code: string; expires_at: string };
    steps: FixtureStep[];
    exhaustion: {
      wrong_attempts: number;
      then: { code: string; now: string };
      expected: FixtureStep['expected'];
    };
    expiry: FixtureStep;
  };
  token_pickup: PickupCase[];
};

const keyStore = () =>
  createMockKeyStore({ stored: Buffer.alloc(32, 0x5c).toString('base64') });

interface Hub {
  readonly handle: CoreHandle;
  readonly target: PinnedTarget;
  readonly clock: { now: number };
  readonly logs: string[];
  // 接続元が中枢と同じマシンか（試験で切り替える。既定は同じマシン）。
  readonly machine: { same: boolean };
}

async function startHub(
  t: test.TestContext,
  dataDir: string,
  options: {
    readonly tlsKeyStore?: MockTlsKeyStore;
    readonly clock?: { now: number };
    readonly logs?: string[];
    readonly machine?: { same: boolean };
    // false なら自宅判定を注入せず、Core の既定（B03-03 までの安全側）を使う。
    readonly injectHome?: boolean;
  } = {},
): Promise<Hub> {
  const clock = options.clock ?? { now: Date.now() };
  const logs = options.logs ?? [];
  const machine = options.machine ?? { same: true };
  const handle = await startCore({
    dataDir,
    keyStore: keyStore(),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    now: () => new Date(clock.now),
    log: (message) => logs.push(message),
    https: {
      host: '127.0.0.1',
      port: 0,
      tlsKeyStore: options.tlsKeyStore ?? createMockTlsKeyStore(),
      // 自宅判定（B03-03）とロック状態（B03-04 以降）は満たす環境を注入する。中枢の画面と申請用の秘密は
      // ペアリングの判定（製品の処理）を使う。
      environment:
        options.injectHome === false
          ? { lockState: () => 'unlocked' }
          : { homeNetwork: () => true, lockState: () => 'unlocked' },
      limits: { preAuthMaxRequests: 1000 },
      sameMachine: () => machine.same,
    },
  });
  onCleanup(t, () => handle.stop('test').catch(() => undefined));
  assert(handle.https !== null);
  const pem = await readFile(join(dataDir, TLS_CERTIFICATE_FILE), 'utf8');
  return {
    handle,
    clock,
    logs,
    machine,
    target: {
      host: handle.https.host,
      port: handle.https.port,
      certificatePem: pem,
      fingerprint: new X509Certificate(pem).fingerprint256
        .replace(/:/gu, '')
        .toLowerCase(),
    },
  };
}

function assertRejected(
  response: ApiResponse,
  status: number,
  code: string,
  label: string,
): void {
  assert.equal(response.status, status, label);
  assert.equal(response.json?.['code'], code, label);
  assert(valid.error(response.json), `${label}: ApiError`);
}

// 登録前の端末の接続先: 最初の接続で証明書を受け取り、本人が表示と比べた指紋でピン留めする。
async function claimTarget(hub: Hub, shownFingerprint: string) {
  const peer = await fetchPeerCertificate(hub.target.host, hub.target.port);
  return requireFingerprint(
    hub.target.host,
    hub.target.port,
    peer,
    shownFingerprint,
  );
}

interface Paired {
  readonly deviceId: string;
  readonly token: string;
  // ログ・DB に出ていないことを確かめる値。
  readonly secrets: readonly string[];
}

// 最初の端末を CLI の承認（Core の制御の入口）で登録する。
async function pairFirstDevice(hub: Hub): Promise<Paired> {
  assert(hub.handle.pairing !== null);
  const started = await hub.handle.pairing.startFirstDevice();
  assert(started.ok, started.ok ? '' : started.reason);
  assert.equal(started.certificate_fingerprint, hub.target.fingerprint);
  const target = await claimTarget(hub, started.certificate_fingerprint);
  const secret = createClaimSecret();
  const claim = await claimPairing(target, started.pairing_code, secret);
  assert.equal(claim.status, 202);
  const approved = await hub.handle.pairing.approveFirstDevice(
    started.pairing_id,
  );
  assert(approved.ok, approved.ok ? '' : approved.reason);
  const picked = await pickupToken(
    target,
    String(claim.json?.['claim_id']),
    secret.secret,
  );
  assert.equal(picked.status, 200);
  const token = String(picked.json?.['device_token']);
  return {
    deviceId: String(picked.json?.['device_id']),
    token,
    secrets: [started.pairing_code, secret.secret, secret.hash, token],
  };
}

async function bootstrapScope(hub: Hub, token: string): Promise<string> {
  const response = await pinnedRequest(hub.target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return String(response.json?.['command_scope_id']);
}

function startPairing(
  hub: Hub,
  token: string,
  scope: string,
): Promise<ApiResponse> {
  return screenRequest(hub.target, token, 'POST', '/v1/pairing/sessions', {
    request_id: randomUUID(),
    command_scope_id: scope,
  });
}

function decide(
  hub: Hub,
  token: string,
  scope: string,
  claimId: string,
  decision: 'approve' | 'reject',
): Promise<ApiResponse> {
  return screenRequest(
    hub.target,
    token,
    'POST',
    `/v1/pairing/claims/${claimId}/decision`,
    { request_id: randomUUID(), command_scope_id: scope, decision },
  );
}

// 中枢の画面の端末で開始し、別の端末として申請・承認・受取りまで行う。
// remote は受取りの接続元を中枢の外とみなす（hub_local ではない端末になる）。
async function pairDevice(
  hub: Hub,
  hubToken: string,
  hubScope: string,
  options: { readonly remote?: boolean } = {},
): Promise<Paired> {
  // 一覧は登録の時刻の順。前の端末と同じ時刻にしない。
  hub.clock.now += 1_000;
  const session = await startPairing(hub, hubToken, hubScope);
  assert.equal(session.status, 201);
  const target = await claimTarget(
    hub,
    String(session.json?.['certificate_fingerprint']),
  );
  const secret = createClaimSecret();
  const code = String(session.json?.['pairing_code']);
  const claim = await claimPairing(target, code, secret);
  assert.equal(claim.status, 202);
  const claimId = String(claim.json?.['claim_id']);
  assert.equal(
    (await decide(hub, hubToken, hubScope, claimId, 'approve')).status,
    200,
  );
  if (options.remote === true) hub.machine.same = false;
  const picked = await pickupToken(target, claimId, secret.secret).finally(
    () => {
      hub.machine.same = true;
    },
  );
  assert.equal(picked.status, 200);
  const token = String(picked.json?.['device_token']);
  return {
    deviceId: String(picked.json?.['device_id']),
    token,
    secrets: [code, secret.secret, secret.hash, token],
  };
}

async function attemptsLeft(hub: Hub, pairingId: string): Promise<number> {
  const found = await hub.handle.store.pairing({
    kind: 'pairing.find_session',
    pairing_id: pairingId,
  });
  assert(found.ok && found.value !== null);
  return found.value.attempts_left;
}

// fixture のコードを、試験のペアリングのコード（正しい）か、それと違うコード（誤り）に写す。
function codeFor(fixtureCode: string, real: string): string {
  if (fixtureCode === scenarios.pairing.initial.pairing_code) return real;
  return fixtureCode === real ? '99999999' : fixtureCode;
}

const FIXTURE_START =
  Date.parse(scenarios.pairing.initial.expires_at) - 5 * MINUTE;

test(
  'pairing fixture cases are reproduced over HTTPS: 5 minutes, 5 failures and a used code',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-pairing-codes-'), 'data');
    const hub = await startHub(t, dataDir);
    const first = await pairFirstDevice(hub);
    const scope = await bootstrapScope(hub, first.token);
    const { steps, exhaustion, expiry } = scenarios.pairing;

    // 中枢の画面で開始する。指紋は X509Certificate から求めた値と同じ。
    const base = hub.clock.now;
    const session = await startPairing(hub, first.token, scope);
    assert.equal(session.status, 201);
    assert(valid.session(session.json), 'PairingSession');
    assert.equal(
      session.json?.['certificate_fingerprint'],
      hub.target.fingerprint,
    );
    assert.equal(session.json?.['attempts_left'], 5);
    assert.equal(
      Date.parse(String(session.json?.['expires_at'])),
      base + 5 * MINUTE,
    );
    const code = String(session.json?.['pairing_code']);
    const pairingId = String(session.json?.['pairing_id']);
    const target = await claimTarget(hub, hub.target.fingerprint);
    for (const step of steps) {
      hub.clock.now = base + (Date.parse(step.now) - FIXTURE_START);
      const response = await claimPairing(
        target,
        codeFor(step.code, code),
        createClaimSecret(),
      );
      if (step.expected.ok) {
        assert.equal(response.status, 202, step.now);
        assert(valid.claim(response.json), 'PairingClaim');
        assert.equal(response.json?.['status'], 'pending');
      } else assertRejected(response, 410, 'pairing_failed', step.now);
      assert.equal(
        await attemptsLeft(hub, pairingId),
        step.expected.attempts_left,
        step.now,
      );
    }

    // 5 回続けて失敗すると、正しいコードでも 410。
    const exhaustedBase = hub.clock.now;
    const exhausted = await startPairing(hub, first.token, scope);
    const exhaustedCode = String(exhausted.json?.['pairing_code']);
    for (let index = 0; index < exhaustion.wrong_attempts; index += 1)
      assertRejected(
        await claimPairing(
          target,
          codeFor('00000000', exhaustedCode),
          createClaimSecret(),
        ),
        410,
        'pairing_failed',
        `wrong ${index}`,
      );
    hub.clock.now =
      exhaustedBase + (Date.parse(exhaustion.then.now) - FIXTURE_START);
    assertRejected(
      await claimPairing(
        target,
        codeFor(exhaustion.then.code, exhaustedCode),
        createClaimSecret(),
      ),
      410,
      'pairing_failed',
      'exhausted',
    );
    assert.equal(
      await attemptsLeft(hub, String(exhausted.json?.['pairing_id'])),
      exhaustion.expected.attempts_left,
    );

    // 開始から 5 分ちょうどで期限切れ（残り回数は減らさない）。
    const expiryBase = hub.clock.now;
    const expiring = await startPairing(hub, first.token, scope);
    hub.clock.now = expiryBase + (Date.parse(expiry.now) - FIXTURE_START);
    assertRejected(
      await claimPairing(
        target,
        codeFor(expiry.code, String(expiring.json?.['pairing_code'])),
        createClaimSecret(),
      ),
      410,
      'pairing_failed',
      'expired',
    );
    assert.equal(
      await attemptsLeft(hub, String(expiring.json?.['pairing_id'])),
      expiry.expected.attempts_left,
    );
  },
);

test(
  'token pickup fixture cases are reproduced over HTTPS: once only, 409 before approval, 410 afterwards',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-pairing-pickup-'), 'data');
    const hub = await startHub(t, dataDir);
    const first = await pairFirstDevice(hub);
    const scope = await bootstrapScope(hub, first.token);
    assert(scenarios.token_pickup.length >= 6);
    for (const entry of scenarios.token_pickup) {
      const session = await startPairing(hub, first.token, scope);
      assert.equal(session.status, 201, entry.id);
      const code = String(session.json?.['pairing_code']);
      const target = await claimTarget(hub, hub.target.fingerprint);
      const secret = createClaimSecret();
      const claim = await claimPairing(target, code, secret);
      assert.equal(claim.status, 202, entry.id);
      const claimId = String(claim.json?.['claim_id']);
      const expiresAt = Date.parse(String(claim.json?.['expires_at']));
      // 申請の期限は申請の時刻から 5 分（ADR 0021）。
      assert.equal(expiresAt, hub.clock.now + 5 * MINUTE, entry.id);
      const status = entry.claim.status;
      if (status === 'approved' || status === 'consumed')
        assert.equal(
          (await decide(hub, first.token, scope, claimId, 'approve')).status,
          200,
          entry.id,
        );
      if (status === 'rejected') {
        const rejected = await decide(
          hub,
          first.token,
          scope,
          claimId,
          'reject',
        );
        assert.equal(rejected.status, 200, entry.id);
        assert.equal(rejected.json?.['status'], 'rejected', entry.id);
      }
      if (status === 'consumed')
        assert.equal(
          (await pickupToken(target, claimId, secret.secret)).status,
          200,
          entry.id,
        );
      if (entry.id === 'code-only-third-party') {
        // コードを知る第三者は、使用済みのコードで申請できない。
        assertRejected(
          await claimPairing(target, code, createClaimSecret()),
          410,
          'pairing_failed',
          entry.id,
        );
      }
      // fixture の時刻を申請の期限からの差で写す。
      hub.clock.now =
        expiresAt -
        (Date.parse(entry.claim.expires_at) - Date.parse(entry.now));
      const presented = entry.secret_matches
        ? secret.secret
        : createClaimSecret().secret;
      const response = await pickupToken(target, claimId, presented);
      assert.equal(response.status, entry.expected.status, entry.id);
      if (entry.expected.code === null) {
        assert(valid.credential(response.json), `${entry.id}: credential`);
        const token = String(response.json?.['device_token']);
        assert.equal(
          (
            await pinnedRequest(hub.target, {
              method: 'GET',
              path: '/v1/bootstrap',
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
          200,
          entry.id,
        );
      } else {
        assertRejected(
          response,
          entry.expected.status,
          entry.expected.code,
          entry.id,
        );
        // 拒否の本文にトークンの形の値を返さない。
        assert.equal(response.json?.['device_token'], undefined, entry.id);
      }
      // 次のケースは 10 分後に始める（接続範囲の 24 時間の期限の内）。
      hub.clock.now += 10 * MINUTE;
    }
  },
);

test(
  'only the hub screen may start or decide pairing',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-pairing-hub-'), 'data');
    const hub = await startHub(t, dataDir);
    const first = await pairFirstDevice(hub);
    const firstScope = await bootstrapScope(hub, first.token);
    // 中枢の外から受け取った端末（hub_local ではない）。
    const other = await pairDevice(hub, first.token, firstScope, {
      remote: true,
    });
    const otherScope = await bootstrapScope(hub, other.token);
    const listed = await pinnedRequest(hub.target, {
      method: 'GET',
      path: '/v1/devices',
      headers: { authorization: `Bearer ${first.token}` },
    });
    assert.equal(listed.status, 200);
    assert(valid.list(listed.json), 'DeviceList');
    const devices = listed.json?.['devices'] as Record<string, unknown>[];
    assert.deepEqual(
      devices.map((device) => [device['device_id'], device['hub_local']]),
      [
        [first.deviceId, true],
        [other.deviceId, false],
      ],
    );

    // 中枢の画面でない端末からの開始・承認は 403。
    assertRejected(
      await startPairing(hub, other.token, otherScope),
      403,
      'hub_screen_required',
      'start from another device',
    );
    const session = await startPairing(hub, first.token, firstScope);
    const target = await claimTarget(hub, hub.target.fingerprint);
    const claim = await claimPairing(
      target,
      String(session.json?.['pairing_code']),
      createClaimSecret(),
    );
    const claimId = String(claim.json?.['claim_id']);
    assertRejected(
      await decide(hub, other.token, otherScope, claimId, 'approve'),
      403,
      'hub_screen_required',
      'decide from another device',
    );
    // hub_local の端末のトークンでも、中枢の外からの接続なら 403（B03-01 のレビュー点の見直し）。
    hub.machine.same = false;
    assertRejected(
      await startPairing(hub, first.token, firstScope),
      403,
      'hub_screen_required',
      'hub token from outside',
    );
    assertRejected(
      await decide(hub, first.token, firstScope, claimId, 'approve'),
      403,
      'hub_screen_required',
      'hub token decides from outside',
    );
    hub.machine.same = true;
    // 画面操作でない（voice）・トークンなしも拒否する。
    assertRejected(
      await pinnedRequest(hub.target, {
        method: 'POST',
        path: '/v1/pairing/sessions',
        headers: {
          authorization: `Bearer ${first.token}`,
          'buddy-input-origin': 'voice',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          request_id: randomUUID(),
          command_scope_id: firstScope,
        }),
      }),
      403,
      'screen_operation_required',
      'voice',
    );
    assertRejected(
      await pinnedRequest(hub.target, {
        method: 'POST',
        path: '/v1/pairing/sessions',
        headers: {
          'buddy-input-origin': 'screen',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          request_id: randomUUID(),
          command_scope_id: firstScope,
        }),
      }),
      401,
      'unauthenticated',
      'no token',
    );
    // 承認は 1 回だけ（決め済みは 409）。無い申請は 410。
    const approved = await decide(
      hub,
      first.token,
      firstScope,
      claimId,
      'approve',
    );
    assert.equal(approved.status, 200);
    assert(valid.claim(approved.json), 'PairingClaim');
    assert.equal(approved.json?.['status'], 'approved');
    assertRejected(
      await decide(hub, first.token, firstScope, claimId, 'reject'),
      409,
      'conflict',
      'decided twice',
    );
    assertRejected(
      await decide(hub, first.token, firstScope, randomUUID(), 'approve'),
      410,
      'pairing_failed',
      'unknown claim',
    );
    // 申請の期限を過ぎた申請は承認できない。
    const late = await startPairing(hub, first.token, firstScope);
    const lateClaim = await claimPairing(
      target,
      String(late.json?.['pairing_code']),
      createClaimSecret(),
    );
    hub.clock.now = Date.parse(String(lateClaim.json?.['expires_at']));
    assertRejected(
      await decide(
        hub,
        first.token,
        firstScope,
        String(lateClaim.json?.['claim_id']),
        'approve',
      ),
      410,
      'pairing_failed',
      'expired claim',
    );
  },
);

test(
  'the first-device CLI approval needs zero devices and a claim from the same machine',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-pairing-first-'), 'data');
    const hub = await startHub(t, dataDir);
    const pairing = hub.handle.pairing;
    assert(pairing !== null);
    // CLI で開始していないペアリング・申請の前は承認できない。
    assert.deepEqual(await pairing.approveFirstDevice(randomUUID()), {
      ok: false,
      reason: 'pairing_not_found',
    });
    const started = await pairing.startFirstDevice();
    assert(started.ok);
    assert.match(started.pairing_code, /^[0-9]{8}$/u);
    assert.deepEqual(await pairing.approveFirstDevice(started.pairing_id), {
      ok: false,
      reason: 'claim_not_found',
    });
    // 中枢の外からの申請は CLI で承認しない。
    const target = await claimTarget(hub, started.certificate_fingerprint);
    hub.machine.same = false;
    const remote = await claimPairing(
      target,
      started.pairing_code,
      createClaimSecret(),
    );
    hub.machine.same = true;
    assert.equal(remote.status, 202);
    assert.deepEqual(await pairing.approveFirstDevice(started.pairing_id), {
      ok: false,
      reason: 'claim_not_same_machine',
    });

    const first = await pairFirstDevice(hub);
    // 1 台でも有効な端末があれば、CLI での開始・承認を拒否する。
    assert.deepEqual(await pairing.startFirstDevice(), {
      ok: false,
      reason: 'devices_registered',
    });
    // 登録済みの端末は中枢と同じマシン（hub_local）。
    const listed = await hub.handle.store.pairing({ kind: 'devices.list' });
    assert(listed.ok);
    assert.deepEqual(
      listed.value.map((device: DeviceRecord) => [
        device.device_id,
        device.hub_local,
      ]),
      [[first.deviceId, true]],
    );
  },
);

test(
  'revocation: the token is 401 at once, old scopes are stale, connections close and others are unaffected',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-pairing-revoke-'), 'data');
    const hub = await startHub(t, dataDir);
    const first = await pairFirstDevice(hub);
    const firstScope = await bootstrapScope(hub, first.token);
    const second = await pairDevice(hub, first.token, firstScope);
    const secondScope = await bootstrapScope(hub, second.token);
    const closed: [string, DeviceCloseReason][] = [];
    const watch = (deviceId: string, label: string) =>
      hub.handle.deviceConnections.register(deviceId, (reason) =>
        closed.push([label, reason]),
      );
    watch(second.deviceId, 'second-a');
    watch(second.deviceId, 'second-b');
    watch(first.deviceId, 'first');

    hub.clock.now += MINUTE;
    const revokedAt = hub.clock.now;
    const revoke = (token: string, scope: string, deviceId: string) =>
      screenRequest(
        hub.target,
        token,
        'POST',
        `/v1/devices/${deviceId}/revoke`,
        {
          request_id: randomUUID(),
          command_scope_id: scope,
        },
      );
    const revoked = await revoke(first.token, firstScope, second.deviceId);
    assert.equal(revoked.status, 200);
    assert(valid.summary(revoked.json), 'DeviceSummary');
    assert.equal(revoked.json?.['device_id'], second.deviceId);
    assert.equal(Date.parse(String(revoked.json?.['revoked_at'])), revokedAt);
    // 失効した端末の接続だけを閉じる。
    assert.deepEqual(closed, [
      ['second-a', 'device_revoked'],
      ['second-b', 'device_revoked'],
    ]);
    assert.equal(hub.handle.deviceConnections.count(first.deviceId), 1);

    // 同じトークンは直後から 401（bootstrap・古い接続範囲の命令）。
    assertRejected(
      await pinnedRequest(hub.target, {
        method: 'GET',
        path: '/v1/bootstrap',
        headers: { authorization: `Bearer ${second.token}` },
      }),
      401,
      'unauthenticated',
      'revoked bootstrap',
    );
    assertRejected(
      await startPairing(hub, second.token, secondScope),
      401,
      'unauthenticated',
      'revoked command',
    );
    // 失効した端末の接続範囲は DB で無効になり、古い接続範囲として 410 になる。
    const scope = await hub.handle.store.device({
      kind: 'scope.find',
      command_scope_id: secondScope,
    });
    assert(scope.ok && scope.value !== null);
    assert.equal(scope.value.revoked_at, revokedAt);
    assert.equal(
      commandScopeState(scope.value, {
        deviceId: second.deviceId,
        coreInstanceId: hub.handle.coreInstanceId,
        now: hub.clock.now,
      }),
      'stale',
    );
    assertRejected(
      await startPairing(hub, first.token, secondScope),
      410,
      'expired_scope',
      'old scope',
    );
    // 他の端末は影響を受けない（同じ接続範囲で命令でき、一覧も見える）。
    assert.equal(
      (await startPairing(hub, first.token, firstScope)).status,
      201,
    );
    const listed = await pinnedRequest(hub.target, {
      method: 'GET',
      path: '/v1/devices',
      headers: { authorization: `Bearer ${first.token}` },
    });
    assert.equal(listed.status, 200);
    const devices = listed.json?.['devices'] as Record<string, unknown>[];
    assert.deepEqual(
      devices.map((device) => [
        device['device_id'],
        device['revoked_at'] === null,
      ]),
      [
        [first.deviceId, true],
        [second.deviceId, false],
      ],
    );
    // もう一度失効しても失効の時刻は変わらない。無い端末は 409。
    hub.clock.now += MINUTE;
    const again = await revoke(first.token, firstScope, second.deviceId);
    assert.equal(again.status, 200);
    assert.equal(Date.parse(String(again.json?.['revoked_at'])), revokedAt);
    assertRejected(
      await revoke(first.token, firstScope, randomUUID()),
      409,
      'conflict',
      'unknown device',
    );

    // ログにトークン・コード・秘密・hash を出さない。
    const tokenHashes = [first.token, second.token].map((token) =>
      createHash('sha256').update(token, 'ascii').digest('hex'),
    );
    const secrets = [...first.secrets, ...second.secrets, ...tokenHashes];
    assert.equal(containsAny(hub.logs.join('\n'), secrets), false);
    assert(hub.logs.some((line) => line.includes(second.deviceId)));

    // DB にはトークンの hash（32 バイト）だけがあり、トークン・秘密の文字列はない。
    await hub.handle.stop('test');
    const files = await readdir(dataDir);
    const bytes = Buffer.concat(
      await Promise.all(
        files
          .filter((name) => name.startsWith('buddy.sqlite'))
          .map((name) => readFile(join(dataDir, name))),
      ),
    );
    for (const hash of tokenHashes)
      assert(bytes.includes(Buffer.from(hash, 'hex')), 'token hash stored');
    assert.equal(
      [first, second].some(
        (device) =>
          bytes.includes(Buffer.from(device.token, 'ascii')) ||
          bytes.includes(Buffer.from(String(device.secrets[1]), 'ascii')),
      ),
      false,
    );
  },
);

// 端末の WSS の購読を開き、Core が端末の接続として登録するまで待つ（B03-04 の配信）。
async function openEventStream(
  t: test.TestContext,
  hub: Hub,
  device: Paired,
): Promise<{
  readonly socket: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
}> {
  const snapshot = await pinnedRequest(hub.target, {
    method: 'GET',
    path: '/v1/snapshot',
    headers: { authorization: `Bearer ${device.token}` },
  });
  assert.equal(snapshot.status, 200);
  const cursor = String(snapshot.json?.['event_cursor']);
  const socket = new WebSocket(
    `wss://127.0.0.1:${hub.target.port}/v1/events/stream?cursor=${encodeURIComponent(cursor)}`,
    {
      headers: { authorization: `Bearer ${device.token}` },
      ca: [hub.target.certificatePem],
      checkServerIdentity: pinnedCheck(
        hub.target.fingerprint,
      ) as unknown as ClientOptions['checkServerIdentity'],
    },
  );
  onCleanup(t, () => socket.terminate());
  socket.on('error', () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString('utf8') }),
    );
  });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('close', () => reject(new Error('stream closed')));
    }),
    10_000,
    'stream open',
  );
  const deadline = Date.now() + 5_000;
  while (hub.handle.deviceConnections.count(device.deviceId) === 0) {
    assert(Date.now() < deadline, 'stream registered');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { socket, closed };
}

test(
  'revoking a device closes its event stream with 4401 and leaves other streams open',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-pairing-wss-'), 'data');
    const hub = await startHub(t, dataDir);
    const first = await pairFirstDevice(hub);
    const firstScope = await bootstrapScope(hub, first.token);
    const second = await pairDevice(hub, first.token, firstScope);
    await bootstrapScope(hub, second.token);
    const secondStream = await openEventStream(t, hub, second);
    const firstStream = await openEventStream(t, hub, first);

    const revoked = await screenRequest(
      hub.target,
      first.token,
      'POST',
      `/v1/devices/${second.deviceId}/revoke`,
      { request_id: randomUUID(), command_scope_id: firstScope },
    );
    assert.equal(revoked.status, 200);
    assert.deepEqual(
      await withTimeout(secondStream.closed, 10_000, 'revoked stream closed'),
      { code: 4401, reason: 'device_revoked' },
    );
    assert.equal(hub.handle.deviceConnections.count(second.deviceId), 0);
    // 他の端末の購読は開いたまま。
    assert.equal(hub.handle.deviceConnections.count(first.deviceId), 1);
    assert.equal(firstStream.socket.readyState, WebSocket.OPEN);
    // 失効した端末は新しく購読できない（401）。
    const again = await pinnedRequest(hub.target, {
      method: 'GET',
      path: '/v1/snapshot',
      headers: { authorization: `Bearer ${second.token}` },
    });
    assert.equal(again.status, 401);
  },
);

test(
  'revocation is accepted only from the hub screen, so another device cannot lock devices out (B03-07)',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-pairing-hubrv-'), 'data');
    const hub = await startHub(t, dataDir);
    const first = await pairFirstDevice(hub);
    const firstScope = await bootstrapScope(hub, first.token);
    // 中枢の外から受け取った端末（hub_local ではない）を 2 台。
    const other = await pairDevice(hub, first.token, firstScope, {
      remote: true,
    });
    const otherScope = await bootstrapScope(hub, other.token);
    const third = await pairDevice(hub, first.token, firstScope, {
      remote: true,
    });
    const revoke = (token: string, scope: string, deviceId: string) =>
      screenRequest(
        hub.target,
        token,
        'POST',
        `/v1/devices/${deviceId}/revoke`,
        { request_id: randomUUID(), command_scope_id: scope },
      );
    const active = async (deviceId: string) => {
      const found = await hub.handle.store.pairing({
        kind: 'devices.find',
        device_id: deviceId,
      });
      assert(found.ok && found.value !== null);
      return found.value.revoked_at === null;
    };

    // 中枢の画面でない端末は、他の端末・中枢の画面の端末・自分を失効できない（403）。
    for (const [target, label] of [
      [third.deviceId, 'another device'],
      [first.deviceId, 'the hub screen device'],
      [other.deviceId, 'itself'],
    ] as const)
      assertRejected(
        await revoke(other.token, otherScope, target),
        403,
        'hub_screen_required',
        `revoke ${label} from a remote device`,
      );
    // hub_local の端末のトークンでも、中枢の外からの接続なら 403。
    hub.machine.same = false;
    assertRejected(
      await revoke(first.token, firstScope, third.deviceId),
      403,
      'hub_screen_required',
      'hub token from outside',
    );
    hub.machine.same = true;
    for (const deviceId of [first.deviceId, other.deviceId, third.deviceId])
      assert.equal(await active(deviceId), true, deviceId);
    // 中枢の画面からは失効できる。
    const revoked = await revoke(first.token, firstScope, third.deviceId);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json?.['device_id'], third.deviceId);
    assert.equal(await active(third.deviceId), false);
    assert.equal(await active(other.deviceId), true);
  },
);

test(
  'a regenerated certificate is refused by existing devices and nothing is re-registered automatically',
  { timeout: 60_000 },
  async (t) => {
    const dataDir = join(await tempDir(t, 'buddy-pairing-cert-'), 'data');
    const tlsKeyStore = createMockTlsKeyStore();
    const clock = { now: Date.now() };
    const logs: string[] = [];
    const before = await startHub(t, dataDir, { tlsKeyStore, clock, logs });
    const first = await pairFirstDevice(before);
    const scope = await bootstrapScope(before, first.token);
    // 承認済みで受取りの前の申請を残す。
    const session = await startPairing(before, first.token, scope);
    const oldTarget = await claimTarget(before, before.target.fingerprint);
    const secret: ClaimSecret = createClaimSecret();
    const claim = await claimPairing(
      oldTarget,
      String(session.json?.['pairing_code']),
      secret,
    );
    const claimId = String(claim.json?.['claim_id']);
    assert.equal(
      (await decide(before, first.token, scope, claimId, 'approve')).status,
      200,
    );
    await before.handle.stop('regenerate');

    // 証明書を作り直す（鍵は同じ。指紋は変わる）。
    await rm(join(dataDir, TLS_CERTIFICATE_FILE));
    const after = await startHub(t, dataDir, { tlsKeyStore, clock, logs });
    assert(after.handle.https !== null);
    assert.equal(after.handle.https.certificateCreation, 'certificate');
    assert.notEqual(after.target.fingerprint, before.target.fingerprint);

    // 既存の端末（前の証明書でピン留め）は接続を拒否し、要求を送らない。
    await assert.rejects(
      pinnedRequest(
        { ...before.target, port: after.target.port },
        {
          method: 'GET',
          path: '/v1/bootstrap',
          headers: { authorization: `Bearer ${first.token}` },
        },
      ),
    );
    // 受取りの前の端末も、本人が比べた前の指紋と違うので申請の接続を作らない（自動で受け入れない）。
    const peer = await fetchPeerCertificate(
      after.target.host,
      after.target.port,
    );
    assert.equal(peer.fingerprint, after.target.fingerprint);
    assert.throws(
      () =>
        requireFingerprint(
          after.target.host,
          after.target.port,
          peer,
          before.target.fingerprint,
        ),
      /certificate_fingerprint_not_confirmed/u,
    );
    // 中枢の側でも自動で承認しない: 前の証明書で登録した端末は起動時に失効し、前の指紋の申請は受け取れない。
    assertRejected(
      await pinnedRequest(after.target, {
        method: 'GET',
        path: '/v1/bootstrap',
        headers: { authorization: `Bearer ${first.token}` },
      }),
      401,
      'unauthenticated',
      'old device on the new certificate',
    );
    assertRejected(
      await pickupToken(after.target, claimId, secret.secret),
      410,
      'pairing_failed',
      'claim approved under the old certificate',
    );
    const listed = await after.handle.store.pairing({ kind: 'devices.list' });
    assert(listed.ok);
    assert.equal(listed.value.length, 1);
    assert.notEqual(listed.value[0]?.revoked_at, null);
    assert(logs.some((line) => line.includes('再登録が必要')));
    // 再登録は本人がやり直す（有効な端末が 0 台なので、最初の端末の CLI の承認からやり直せる）。
    const again = await pairFirstDevice(after);
    assert.notEqual(again.deviceId, first.deviceId);
  },
);

test(
  'a claim is sent only on a connection pinned to the fingerprint the person compared',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHub(
      t,
      join(await tempDir(t, 'buddy-pairing-pin-'), 'data'),
    );
    // 別の中枢（なりすまし）。端末はそこへ接続してしまったが、本人は本物の中枢の表示と比べる。
    const impostor = await startHub(
      t,
      join(await tempDir(t, 'buddy-pairing-pin2-'), 'data'),
    );
    const peer = await fetchPeerCertificate(
      impostor.target.host,
      impostor.target.port,
    );
    assert.throws(
      () =>
        requireFingerprint(
          impostor.target.host,
          impostor.target.port,
          peer,
          hub.target.fingerprint,
        ),
      /certificate_fingerprint_not_confirmed/u,
    );
    // ピン留めの指紋だけを本物にしても、なりすましの証明書では接続できない。
    await assert.rejects(
      claimPairing(
        { ...impostor.target, fingerprint: hub.target.fingerprint },
        '12345678',
        createClaimSecret(),
      ),
    );
  },
);

test(
  // B03-03 の統合後: 別のマシンからの申請・受取りは自宅判定（Tailscale の状態の取得元なし＝取得できない）で拒否し、
  // 同じマシンからの登録前の申請・受取りは免除する（ADR 0022）。
  'without a confirmed home network only same-machine connections may claim before registration',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHub(
      t,
      join(await tempDir(t, 'buddy-pairing-home-'), 'data'),
      { injectHome: false },
    );
    assert(hub.handle.pairing !== null);
    const started = await hub.handle.pairing.startFirstDevice();
    assert(started.ok);
    const target = await claimTarget(hub, started.certificate_fingerprint);
    hub.machine.same = false;
    assertRejected(
      await claimPairing(target, started.pairing_code, createClaimSecret()),
      403,
      'outside_home_network',
      'remote claim',
    );
    assertRejected(
      await pickupToken(target, randomUUID(), createClaimSecret().secret),
      403,
      'outside_home_network',
      'remote pickup',
    );
    hub.machine.same = true;
    // 自宅判定で拒否した申請は回数を数えない。同じマシンからの申請は通り、最初の端末を登録できる。
    assert.equal(await attemptsLeft(hub, started.pairing_id), 5);
    const first = await pairFirstDevice(hub);
    assert.equal(
      (
        await pinnedRequest(hub.target, {
          method: 'GET',
          path: '/v1/bootstrap',
          headers: { authorization: `Bearer ${first.token}` },
        })
      ).status,
      200,
    );
  },
);

test('helpers: same-machine check, pairing code and claim secret hash', () => {
  const cases: [string, string, boolean][] = [
    ['127.0.0.1', '100.64.0.1', true],
    ['127.10.0.2', '100.64.0.1', true],
    ['::1', '100.64.0.1', true],
    ['::ffff:127.0.0.1', '100.64.0.1', true],
    ['100.64.0.1', '100.64.0.1', true],
    ['::ffff:100.64.0.1', '100.64.0.1', true],
    ['100.64.0.2', '100.64.0.1', false],
    ['192.168.0.10', '100.64.0.1', false],
    ['fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::2', false],
    ['FD7A:115C:A1E0::2', 'fd7a:115c:a1e0::2', true],
    ['', '100.64.0.1', false],
    ['localhost', '100.64.0.1', false],
  ];
  for (const [remote, host, expected] of cases)
    assert.equal(isSameMachine(remote, host), expected, `${remote} ${host}`);
  const codes = new Set<string>();
  for (let index = 0; index < 200; index += 1) {
    const code = createPairingCode();
    assert.match(code, /^[0-9]{8}$/u);
    codes.add(code);
  }
  assert(codes.size > 190);
  // 手で書いた値: 'A' を 43 文字並べた秘密の ASCII の SHA-256。
  const secret = 'A'.repeat(43);
  assert.equal(
    claimSecretHash(secret),
    createHash('sha256').update(Buffer.from(secret, 'ascii')).digest('hex'),
  );
  assert.throws(() => claimSecretHash('short'), TypeError);
});

test('device connections close only the given device and can be unregistered', () => {
  const connections = new DeviceConnections();
  const seen: string[] = [];
  const offA = connections.register('a', (reason) => seen.push(`a1:${reason}`));
  connections.register('a', () => {
    throw new Error('close failed');
  });
  connections.register('a', (reason) => seen.push(`a3:${reason}`));
  connections.register('b', (reason) => seen.push(`b:${reason}`));
  offA();
  offA();
  assert.equal(connections.count('a'), 2);
  // 閉じた数は閉じる処理が成功した接続の数（失敗した接続も登録からは外す）。
  assert.equal(connections.closeDevice('a', 'outside_home_network'), 1);
  assert.deepEqual(seen, ['a3:outside_home_network']);
  assert.equal(connections.count('a'), 0);
  assert.equal(connections.closeDevice('a', 'device_revoked'), 0);
  assert.equal(connections.count('b'), 1);
});
