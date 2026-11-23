// ペアリングの流れの試験（証明書の取得・申請・承認待ち・受け取り）。期待値は手で書く。
// 申請用の秘密の hash の期待値は、契約（Core の claimSecretHash と同じ SHA-256）を標準ライブラリで計算する。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CoreClient, CoreClientOutcome } from './core-client.js';
import type { CoreTransport, CoreTransportOutcome } from './core-transport.js';
import { pairBridge } from './pairing.js';
import type { PairingDeps } from './pairing.js';

const FINGERPRINT = 'cd34';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

interface PreAuthCall {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function setup(
  pickupOutcomes: readonly CoreClientOutcome[],
  overrides: Partial<PairingDeps> = {},
) {
  const preAuthCalls: PreAuthCall[] = [];
  const queue = [...pickupOutcomes];
  const transport: CoreTransport = {
    request: async (): Promise<CoreTransportOutcome> => {
      throw new Error('pairing does not use the unpinned transport');
    },
    fetchPeerCertificate: async () => ({
      kind: 'ok',
      certificatePem: PEM,
      fingerprint: FINGERPRINT,
    }),
  };
  const pinnedClient = (): CoreClient => ({
    read: async () => {
      throw new Error('not used');
    },
    command: async () => {
      throw new Error('not used');
    },
    preAuth: async (_method, path, body) => {
      preAuthCalls.push({ path, body });
      if (path === '/v1/pairing/claims')
        return {
          kind: 'response',
          status: 202,
          body: {
            claim_id: 'claim-1',
            status: 'pending',
            device_name: 'Buddy Bridge (Muse)',
            platform: 'macos',
            expires_at: '2030-10-09T03:05:00Z',
          },
        } satisfies CoreClientOutcome;
      const next = queue.shift();
      if (next === undefined) throw new Error('no scripted pickup outcome');
      return next;
    },
  });
  const deps: PairingDeps = {
    transport,
    pinnedClient,
    collectFingerprint: async () => ({
      gateway_mac: 'aa:bb:cc:dd:ee:ff',
      subnet: '192.168.1.0/24',
      ssid: null,
    }),
    deviceName: 'Buddy Bridge (Muse)',
    platform: 'macos',
    sleep: async () => undefined,
    pollIntervalMs: 0,
    pollTimeoutMs: 60_000,
    ...overrides,
  };
  return { deps, preAuthCalls };
}

test('claim, wait for approval, then pick up the device token once', async () => {
  const seen: string[] = [];
  const { deps, preAuthCalls } = setup(
    [
      { kind: 'response', status: 409, body: { code: 'conflict' } },
      {
        kind: 'response',
        status: 200,
        body: {
          device_id: 'device-1',
          device_token: 'd'.repeat(43),
          issued_at: '2030-10-09T03:01:00Z',
        },
      },
    ],
    {
      onPeerCertificate: (fingerprint) => {
        seen.push(`fp:${fingerprint}`);
      },
      onClaimCreated: (claimId) => {
        seen.push(`claim:${claimId}`);
      },
    },
  );
  const result = await pairBridge(deps, '12345678');
  assert.deepEqual(result, {
    kind: 'paired',
    deviceId: 'device-1',
    deviceToken: 'd'.repeat(43),
    certificatePem: PEM,
    fingerprint: FINGERPRINT,
  });
  assert.deepEqual(seen, ['fp:cd34', 'claim:claim-1']);
  // 申請: コードと、秘密の hash だけを送る（秘密そのものは送らない）。
  const claim = preAuthCalls[0];
  assert.equal(claim?.path, '/v1/pairing/claims');
  assert.equal(claim?.body['pairing_code'], '12345678');
  assert.equal(claim?.body['device_name'], 'Buddy Bridge (Muse)');
  assert.equal(claim?.body['platform'], 'macos');
  assert.deepEqual(claim?.body['home_fingerprint'], {
    gateway_mac: 'aa:bb:cc:dd:ee:ff',
    subnet: '192.168.1.0/24',
    ssid: null,
  });
  // 受け取り: 申請で hash を送った秘密そのものを送る（hash が一致することを標準ライブラリで確かめる）。
  const pickups = preAuthCalls.filter((call) => call.path.endsWith('/token'));
  assert.equal(pickups.length, 2);
  const secret = pickups[0]?.body['claim_secret'];
  assert.equal(typeof secret, 'string');
  assert.match(secret as string, /^[A-Za-z0-9_-]{43}$/u);
  const expectedHash = createHash('sha256')
    .update(secret as string, 'ascii')
    .digest('hex');
  assert.equal(claim?.body['claim_secret_hash'], expectedHash);
});

test('an expired or rejected claim ends the pairing', async () => {
  const { deps } = setup([
    { kind: 'response', status: 410, body: { code: 'pairing_failed' } },
  ]);
  const result = await pairBridge(deps, '12345678');
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed')
    assert.equal(result.reason, 'pickup_rejected_410_pairing_failed');
});

test('when the hub certificate cannot be fetched, nothing else is attempted', async () => {
  const { deps, preAuthCalls } = setup([], {
    transport: {
      request: async (): Promise<CoreTransportOutcome> => {
        throw new Error('not used');
      },
      fetchPeerCertificate: async () => ({
        kind: 'unreachable',
        reason: 'ECONNREFUSED',
      }),
    },
  });
  const result = await pairBridge(deps, '12345678');
  assert.deepEqual(result, {
    kind: 'failed',
    reason: 'certificate_ECONNREFUSED',
  });
  assert.equal(preAuthCalls.length, 0);
});
