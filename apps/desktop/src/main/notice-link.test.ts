// 中枢の知らせ（WSS の notice。UI-05 の段階 3、ADR 0187、U403）を、127.0.0.1 の製品の Core（startCore、鍵は模擬）と main の
// 部品（DesktopCoreLink・@buddy/client の購読・ForgetLedgerSync・CanvasBridge）で通す統合の試験（forget-ledger-link.test.ts と
// 同じ形）。忘却は保存層の命令で直接適用する（忘却の公開ゲートは閉じたままなので、ゲートを通らない試験の手順）。保存層の命令は
// 知らせを出さないので、試験が中枢の台帳の head から「台帳が進んだ」知らせを組み、製品の Core の知らせの口
// （handle.notices。掃除の job・忘却の経路が渡すのと同じ口）へ渡す。そこから先の運搬（Core の中継 → WSS → 端末の購読 →
// 台帳の複製の受け取り口）は製品のまま。Electron は起動しない。実機・実データは未実施。
// 確かめること: 接続したまま起きた忘却に、台帳の知らせで 1 回だけ尋ねて追いつく・持っている head の知らせでは尋ねない・
// ロック中も追いつく・期限切れの知らせでキャンバスを読み直す（ロック中は読まない）。期待値は手で書いた。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type { ForgetLedgerNotice, RetentionNotice } from '@buddy/contracts';
import { planForget } from '@buddy/domain';
import type { MemorySource } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import { SecretText, saveCredential } from './credential-store.js';
import {
  FORGET_LEDGER_REPLICA_FILE,
  loadReplicaFile,
} from './forget-ledger-replica-store.js';
import {
  freePort,
  mockProtector,
  onCleanup,
  startHub,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import type { TestHub } from './hub-test-support.js';
import { createHubTransport } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const valid = (name: string, value: unknown) => contract.valid(name, value);
const ID = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// 元サービスの生の ID（台帳・複製には HMAC だけが入る）と、試験用に決めた HMAC。
const SOURCES: readonly { source: MemorySource; hmac: string }[] = [
  {
    source: { source_kind: 'source_item', source_id: 'mail-synthetic-201' },
    hmac: 'b1'.repeat(32),
  },
  {
    source: { source_kind: 'source_item', source_id: 'mail-synthetic-202' },
    hmac: 'b2'.repeat(32),
  },
  {
    source: { source_kind: 'source_item', source_id: 'mail-synthetic-203' },
    hmac: 'b3'.repeat(32),
  },
];

async function forget(hub: TestHub, index: number): Promise<void> {
  const { source, hmac } = SOURCES[index] as (typeof SOURCES)[number];
  const read = await hub.handle.store.memory({
    kind: 'forget.graph',
    target: source,
  });
  assert(read.ok);
  const plan = planForget({
    target: source,
    instruction_turn_id: null,
    executing_operation_id: null,
    graph: read.value.graph,
    sourceHmac: () => hmac,
  });
  assert(plan.ok);
  const applied = await hub.handle.store.memory({
    kind: 'forget.apply',
    target: source,
    instruction_turn_id: null,
    plan: plan.plan,
    source_hmacs: [{ ...source, hmac }],
    entry_id: randomUUID(),
    previous_generation: read.value.forgetting_generation,
    new_ledger_id: randomUUID(),
    now: Date.parse(`2031-02-0${index + 1}T00:00:00.000Z`),
  });
  assert(applied.ok, 'forget apply failed');
}

// 中枢の台帳の head から「台帳が進んだ」知らせを組む（ForgetService が忘却の後に渡すのと同じ形）。
async function ledgerNoticeOf(hub: TestHub): Promise<ForgetLedgerNotice> {
  const exported = await hub.handle.store.memory({
    kind: 'forget.ledger_export',
  });
  assert(exported.ok && exported.value.ledger_id !== null);
  return {
    schema: 'buddy.forget-ledger-notice.v1',
    notice_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    kind: 'ledger_advanced',
    ledger_id: exported.value.ledger_id,
    forgetting_generation: exported.value.head.forgetting_generation,
    entry_hash: exported.value.head.entry_hash,
  };
}

const expiredNotice = (n: number): RetentionNotice => ({
  schema: 'buddy.retention-notice.v1',
  notice_id: ID(0xc00 + n),
  occurred_at: '2031-02-01T00:00:00Z',
  kind: 'expired',
  reason: 'retention_due',
  forgetting_generation: null,
  items: [{ item_kind: 'turn', item_id: ID(0xd00 + n) }],
});

test(
  'ledger notices on the stream bring the replica up to date once, also while locked; expiry notices re-read the canvas only while unlocked',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bnl-');
    const dataDir = join(dir, 'data');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const userData = join(dir, 'user-data');
    await mkdir(userData, { recursive: true });
    const hub = await startHub(t, { dataDir, port: await freePort() });
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
    const pem = await readFile(
      join(hub.dataDir, 'tls-certificate.pem'),
      'utf8',
    );
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
    // 送った同期の head の世代（順に）と、キャンバスの読み取りの数。
    const sent: string[] = [];
    let canvasReads = 0;
    const logs: string[] = [];
    const replicaPath = join(userData, FORGET_LEDGER_REPLICA_FILE);
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
      log: (code) => logs.push(code),
      budgetAuto: false,
      backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
      confirmAdmin: () => Promise.resolve(false),
      forgetLedgerReplicaPath: replicaPath,
      canvasMode: true,
      onCanvas: () => undefined,
      transportFor: (target, bearer) => {
        const transport = createHubTransport({ hub: target, token: bearer });
        return {
          request: (request) => {
            if (request.path === '/v1/forget-ledger/sync')
              sent.push(String(request.body?.['forgetting_generation']));
            if (request.method === 'GET' && request.path === '/v1/canvas')
              canvasReads += 1;
            return transport.request(request);
          },
          openStream: (cursor, lockState, listener) =>
            transport.openStream(cursor, lockState, listener),
        };
      },
    });
    onCleanup(t, () => link.stop());
    await link.start('unlocked');
    await waitUntil(() => link.linkState?.phase === 'live', 'live');
    await waitUntil(() => sent.length > 0, 'first ledger sync');
    await link.forgetLedgerIdle();
    await waitUntil(() => canvasReads > 0, 'first canvas read');
    await link.canvasIdle();
    // 中枢の購読が配信を始めるまで待つ（その後の知らせだけが届く）。
    const relay = hub.handle.notices as unknown as { listenerCount: number };
    await waitUntil(() => relay.listenerCount === 1, 'stream subscribed');
    assert.deepEqual(sent, ['0']);
    assert.equal(canvasReads, 1);

    // 接続したままの忘却: 台帳の知らせで世代 0 の head を送り、世代 1 を受け取って保存する。
    await forget(hub, 0);
    const first = await ledgerNoticeOf(hub);
    await hub.handle.notices.publish(first);
    await waitUntil(() => sent.length === 2, 'ledger sync by notice');
    await link.forgetLedgerIdle();
    assert.deepEqual(sent, ['0', '0']);
    const loaded = await loadReplicaFile(replicaPath, valid);
    assert(loaded.kind === 'loaded');
    assert.equal(loaded.chain.entries.length, 1);
    assert.equal(loaded.chain.ledger_id, first.ledger_id);

    // 持っている head の知らせでは尋ねない。続く新しい知らせ（世代 2）でだけ尋ねる（購読の中の順で確かめる）。
    await hub.handle.notices.publish(first);
    await forget(hub, 1);
    await hub.handle.notices.publish(await ledgerNoticeOf(hub));
    await waitUntil(() => sent.length === 3, 'second ledger sync');
    await link.forgetLedgerIdle();
    assert.deepEqual(sent, ['0', '0', '1']);

    // 期限切れの知らせ（キャンバスに当たる物がなく、版は進まない）でも、キャンバスを 1 回読み直す。
    await hub.handle.notices.publish(expiredNotice(1));
    await waitUntil(() => canvasReads === 2, 'canvas re-read by notice');
    await link.canvasIdle();

    // ロック中: 期限切れの知らせではキャンバスを読まない。台帳の知らせでは追いつく（台帳は本文を持たない）。
    link.setLockState('locked');
    await hub.handle.notices.publish(expiredNotice(2));
    await forget(hub, 2);
    await hub.handle.notices.publish(await ledgerNoticeOf(hub));
    await waitUntil(() => sent.length === 4, 'ledger sync while locked');
    await link.forgetLedgerIdle();
    await link.canvasIdle();
    assert.deepEqual(sent, ['0', '0', '1', '2']);
    assert.equal(canvasReads, 2);
    const latest = await loadReplicaFile(replicaPath, valid);
    assert(latest.kind === 'loaded');
    assert.equal(latest.chain.entries.length, 3);
    const text = await readFile(replicaPath, 'utf8');
    assert(!text.includes('mail-synthetic-'));
    assert.equal(link.forgetLedgerState?.issue, null);
    // ログに台帳の中身・元サービスの ID を出さない。
    for (const code of logs) {
      assert(!code.includes('mail-synthetic-'));
      assert(!/[0-9a-f]{64}/u.test(code));
    }
  },
);
