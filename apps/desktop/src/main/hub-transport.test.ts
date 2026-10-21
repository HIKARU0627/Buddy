// 中枢との通信（TLS のピン留め・最初の接続）の試験（ADR 0020・0021・0025）。
// 模擬の TLS のサーバー（中枢と同じ形の自己署名の証明書）で、受け取ったバイト数を数える。
// - 最初の接続（fetchPeerCertificate）は 1 バイトも送らない。
// - 指紋・信頼の起点が合わない中枢へは、要求を 1 バイトも送らない（certificate_mismatch）。
// - 接続できない宛先は unreachable（例外を投げない）。
// 指紋の期待値は X509Certificate#fingerprint256 から求め、検査対象の関数で作っていない。

import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import test from 'node:test';
import { createServer } from 'node:tls';
import type { Server, TLSSocket } from 'node:tls';
import { loadOrCreateTlsIdentity } from '@buddy/core';
import { createMockTlsKeyStore } from '@buddy/platform';
import {
  fetchPeerCertificate,
  hubRequest,
  createHubTransport,
} from './hub-transport.js';
import { freePort, onCleanup, tempDir } from './hub-test-support.js';

interface RawHub {
  readonly port: number;
  readonly certificatePem: string;
  readonly fingerprint: string;
  // TLS の確立の後に受け取ったバイト数（接続ごと）。
  readonly received: number[];
  // 受け取った要求の先頭（ヘッダーの確認用。合成の値だけ）。
  readonly heads: string[];
  readonly secured: () => number;
}

async function identity(t: test.TestContext, name: string) {
  const dir = await tempDir(t, `bdh${name}-`);
  return loadOrCreateTlsIdentity({
    dataDir: dir,
    tlsKeyStore: createMockTlsKeyStore(),
    now: new Date(),
  });
}

async function rawHub(
  t: test.TestContext,
  respond: string | null = null,
): Promise<RawHub> {
  const id = await identity(t, 'raw');
  const received: number[] = [];
  const heads: string[] = [];
  let secured = 0;
  const sockets = new Set<TLSSocket>();
  const server: Server = createServer(
    {
      cert: id.certificatePem,
      key: id.privateKey.toPkcs8Pem(),
      minVersion: 'TLSv1.3',
    },
    (socket) => {
      secured += 1;
      sockets.add(socket);
      const index = received.push(0) - 1;
      socket.on('data', (chunk: Buffer) => {
        received[index] = (received[index] ?? 0) + chunk.length;
        heads.push(chunk.toString('latin1').toLowerCase());
        if (respond !== null) socket.end(respond);
      });
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    },
  );
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  onCleanup(
    t,
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert(typeof address === 'object' && address !== null);
  return {
    port: address.port,
    certificatePem: id.certificatePem,
    fingerprint: new X509Certificate(id.certificatePem).fingerprint256
      .replaceAll(':', '')
      .toLowerCase(),
    received,
    heads,
    secured: () => secured,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test(
  'the first connection only receives the certificate and writes no bytes',
  { timeout: 30_000 },
  async (t) => {
    const hub = await rawHub(t);
    const result = await fetchPeerCertificate('127.0.0.1', hub.port);
    assert(result.ok);
    assert.equal(result.fingerprint, hub.fingerprint);
    assert.equal(
      new X509Certificate(result.certificatePem).fingerprint256,
      new X509Certificate(hub.certificatePem).fingerprint256,
    );
    await settle();
    // TLS 1.3 では端末が確立を終えてすぐに閉じるので、サーバー側の確立の通知は届かないこともある。
    // 届いた接続でも、アプリのデータは 0 バイト（要求を書いていない）。書いた場合に数えられることは
    // 下の「ピン留めが合う要求」の試験で確かめている。
    assert(hub.secured() <= 1);
    assert(hub.received.every((bytes) => bytes === 0));
  },
);

test(
  'a pinned request to a hub with another certificate or fingerprint sends no bytes',
  { timeout: 30_000 },
  async (t) => {
    const hub = await rawHub(t);
    const other = await identity(t, 'other');
    const otherFingerprint = new X509Certificate(
      other.certificatePem,
    ).fingerprint256
      .replaceAll(':', '')
      .toLowerCase();
    const cases = [
      // 別の証明書を信頼の起点にしている（中枢の証明書が差し替わった）。
      { certificatePem: other.certificatePem, fingerprint: otherFingerprint },
      // 保存した証明書は合うが指紋が違う。
      { certificatePem: hub.certificatePem, fingerprint: otherFingerprint },
      // 指紋は中枢のものだが、保存した証明書が違う（両方が完全に一致するときだけ通す）。
      { certificatePem: other.certificatePem, fingerprint: hub.fingerprint },
    ];
    for (const pin of cases) {
      const outcome = await hubRequest(
        { host: '127.0.0.1', port: hub.port, ...pin },
        {
          method: 'GET',
          path: '/v1/bootstrap',
          headers: { authorization: `Bearer ${'Q'.repeat(43)}` },
        },
      );
      assert.deepEqual(outcome, { kind: 'certificate_mismatch' });
    }
    // 購読（WSS）も同じ。
    const transport = createHubTransport({
      hub: {
        host: '127.0.0.1',
        port: hub.port,
        certificatePem: other.certificatePem,
        fingerprint: otherFingerprint,
      },
      token: () => 'Q'.repeat(43),
    });
    const stream = await transport.openStream('c', 'unlocked', () => undefined);
    assert.deepEqual(stream, { kind: 'certificate_mismatch' });
    await settle();
    // サーバー側で確立したと見えた接続があっても、アプリのデータは 0 バイト。
    assert(hub.received.every((bytes) => bytes === 0));
  },
);

test(
  'a matching pin sends the request with the lock state; unreachable hubs are reported without throwing',
  { timeout: 30_000 },
  async (t) => {
    const hub = await rawHub(
      t,
      'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{"ok":true}',
    );
    const pinned = {
      host: '127.0.0.1',
      port: hub.port,
      certificatePem: hub.certificatePem,
      fingerprint: hub.fingerprint,
    };
    const transport = createHubTransport({
      hub: pinned,
      token: () => 'Q'.repeat(43),
    });
    const outcome = await transport.request({
      method: 'GET',
      path: '/v1/bootstrap',
      lockState: 'unlocked',
    });
    assert.deepEqual(outcome, {
      kind: 'response',
      status: 200,
      body: { ok: true },
    });
    assert(hub.received.some((bytes) => bytes > 0));
    assert.match(hub.heads.join(''), /buddy-lock-state: unlocked\r\n/u);
    // ロック状態が分からないときは申告しない。
    await transport.request({
      method: 'GET',
      path: '/v1/snapshot',
      lockState: 'unknown',
    });
    assert.doesNotMatch(hub.heads.at(-1) ?? '', /buddy-lock-state/u);
    assert.match(hub.heads.at(-1) ?? '', /^get \/v1\/snapshot /u);

    const closed = await freePort();
    const down = await hubRequest(
      { ...pinned, port: closed },
      { method: 'GET', path: '/v1/bootstrap' },
    );
    assert.equal(down.kind, 'unreachable');
    const fetch = await fetchPeerCertificate('127.0.0.1', closed);
    assert.equal(fetch.ok, false);
  },
);
