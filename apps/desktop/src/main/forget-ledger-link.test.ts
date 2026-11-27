// 端末の忘却台帳の複製（B06-07b-3、Issue #179、ADR 0182）を、127.0.0.1 の製品の Core（startCore、鍵は模擬）と
// main の部品（DesktopCoreLink・ForgetLedgerSync・複製のファイル）で通す統合の試験（household-link.test.ts と同じ形）。
// 端末は中枢の DB に直接登録する。忘却は保存層の命令で直接適用する（忘却の公開ゲートは閉じたままなので、ゲートを通らない
// 試験の手順。apps/core の forget-core.test.ts と同じ）。ここでは試験が中枢の台帳の head から知らせを組んで端末の受け取り口
// （forgetLedgerNotice）へ直接渡す。中枢の購読（WSS の notice）で運ぶ経路は notice-link.test.ts が確かめる（UI-05 の段階 3、
// ADR 0187）。Electron は起動しない。実機・実データは未実施。
// 確かめること: 台帳が空なら 1 回だけ尋ねて何も書かない・知らせで続きを受け取って保存する・知らせの head を持っていれば
// 尋ねない・ロック中も追いつく・再起動の後も複製が残り、接続で 1 回だけ尋ねて余分に取らない・壊れたファイルは退避して
// 取り直す・ファイルとログに元サービスの生の ID・台帳の中身を出さない。期待値は手で書いた。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import { planForget } from '@buddy/domain';
import type { MemorySource } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import { SecretText, saveCredential } from './credential-store.js';
import {
  FORGET_LEDGER_REPLICA_FILE,
  loadReplicaFile,
  setAsideReplicaFiles,
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

// 元サービスの生の ID（台帳・複製には HMAC だけが入る）と、試験用に決めた HMAC。
const SOURCES: readonly { source: MemorySource; hmac: string }[] = [
  {
    source: { source_kind: 'source_item', source_id: 'mail-synthetic-101' },
    hmac: 'a1'.repeat(32),
  },
  {
    source: { source_kind: 'source_item', source_id: 'mail-synthetic-102' },
    hmac: 'a2'.repeat(32),
  },
  {
    source: { source_kind: 'source_item', source_id: 'mail-synthetic-103' },
    hmac: 'a3'.repeat(32),
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
    now: Date.parse(`2031-01-0${index + 1}T00:00:00.000Z`),
  });
  assert(applied.ok, 'forget apply failed');
}

// 中枢の台帳の head から「台帳が進んだ」知らせを組む（ここでは試験が受け取り口へ直接渡す）。
async function noticeOf(hub: TestHub) {
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

interface Rig {
  readonly hub: TestHub;
  readonly replicaPath: string;
  // 送った同期の head の世代（順に）。
  readonly sent: string[];
  readonly logs: string[];
  link(): Promise<DesktopCoreLink>;
}

async function start(t: test.TestContext): Promise<Rig> {
  const dir = await tempDir(t, 'bfl-');
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
  const sent: string[] = [];
  const logs: string[] = [];
  const replicaPath = join(userData, FORGET_LEDGER_REPLICA_FILE);
  return {
    hub,
    replicaPath,
    sent,
    logs,
    async link() {
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
        transportFor: (target, bearer) => {
          const transport = createHubTransport({ hub: target, token: bearer });
          return {
            request: (request) => {
              if (request.path === '/v1/forget-ledger/sync')
                sent.push(String(request.body?.['forgetting_generation']));
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
      return link;
    },
  };
}

async function loadedGeneration(path: string): Promise<number | null> {
  const loaded = await loadReplicaFile(path, valid);
  return loaded.kind === 'loaded' ? loaded.chain.entries.length : null;
}

test(
  'the device replica follows the product Core ledger, survives a restart and never stores raw source ids',
  { timeout: 60_000 },
  async (t) => {
    const rig = await start(t);
    // 台帳が空の中枢: 接続で 1 回だけ尋ね、何も書かない。
    const first = await rig.link();
    assert.deepEqual(rig.sent, ['0']);
    assert.deepEqual(await loadReplicaFile(rig.replicaPath, valid), {
      kind: 'missing',
    });
    assert.equal(first.forgetLedgerState?.issue, null);

    // 2 回の忘却の後の知らせ: 世代 0 から続きを受け取り、世代 2 まで保存する。
    await forget(rig.hub, 0);
    await forget(rig.hub, 1);
    const notice = await noticeOf(rig.hub);
    await first.forgetLedgerNotice(notice);
    await first.forgetLedgerIdle();
    assert.deepEqual(rig.sent, ['0', '0']);
    assert.equal(await loadedGeneration(rig.replicaPath), 2);
    const loaded = await loadReplicaFile(rig.replicaPath, valid);
    assert(loaded.kind === 'loaded');
    assert.equal(loaded.chain.ledger_id, notice.ledger_id);
    const text = await readFile(rig.replicaPath, 'utf8');
    assert(!text.includes('mail-synthetic-'));
    assert(text.includes('a1'.repeat(32)) && text.includes('a2'.repeat(32)));

    // 同じ知らせをもう一度: 持っている head なので尋ねない。
    await first.forgetLedgerNotice(notice);
    await first.forgetLedgerIdle();
    assert.deepEqual(rig.sent, ['0', '0']);

    // ロック中も追いつく（台帳は本文を持たない）。
    first.setLockState('locked');
    await forget(rig.hub, 2);
    await first.forgetLedgerNotice(await noticeOf(rig.hub));
    await first.forgetLedgerIdle();
    assert.deepEqual(rig.sent, ['0', '0', '2']);
    assert.equal(await loadedGeneration(rig.replicaPath), 3);
    const saved = await readFile(rig.replicaPath);

    // 再起動: 複製が残り、接続で世代 3 を 1 回だけ送って、余分に取らない（ファイルは書き換えない）。
    first.stop();
    const second = await rig.link();
    assert.deepEqual(rig.sent, ['0', '0', '2', '3']);
    assert.deepEqual(await readFile(rig.replicaPath), saved);
    assert.equal(second.forgetLedgerState?.head.forgetting_generation, '3');
    second.stop();

    // 壊れたファイル: 使わずに世代 0 から取り直し、壊れたファイルを消さずに退避する。
    await writeFile(
      rig.replicaPath,
      '{"schema":"buddy.forget-ledger-replica.v1"',
    );
    const third = await rig.link();
    assert.deepEqual(rig.sent, ['0', '0', '2', '3', '0']);
    assert.equal(await loadedGeneration(rig.replicaPath), 3);
    const aside = await setAsideReplicaFiles(rig.replicaPath);
    assert.equal(aside.length, 1);
    assert.equal(
      await readFile(aside[0] ?? '', 'utf8'),
      '{"schema":"buddy.forget-ledger-replica.v1"',
    );
    assert.equal(third.forgetLedgerState?.issue, null);

    // ログは決まった理由のコードだけ（台帳の中身・HMAC・世代を出さない）。
    const ledgerLogs = rig.logs.filter((code) =>
      code.startsWith('forget_ledger:'),
    );
    assert.deepEqual(ledgerLogs, [
      'forget_ledger:replica_unreadable',
      'forget_ledger:replica_set_aside',
    ]);
    for (const code of rig.logs) {
      assert(!code.includes('mail-synthetic-'));
      assert(!/[0-9a-f]{64}/u.test(code));
    }
  },
);
