// 保存モードの切り替えと記録しない間の表示の値（UI-05 の段階 6、ADR 0189）を、127.0.0.1 の Core と main の部品
// （DesktopCoreLink・StorageModeBridge・OperationBridge・限定 IPC の受付・状態欄）で通す統合の試験（candidate-link.test.ts と
// 同じ形）。中枢は同じプロセスの startCore（鍵は模擬）。端末は中枢の DB に直接登録する。従来の窓（配布版の既定の組み立て）。
// Electron は起動しない。実機・実 API は未実施。期待値は手で書いた。
// 確かめること: 接続したら中枢の保存モードを読んで状態欄に載せる、画面操作の切り替えが中枢の保存境界を動かして状態欄が
// 記録しないになる、前面でない窓・ロック中は中枢へ何も送らない、記録しない間の従来の窓の発言は会話を作らずに流れの経路へ送る
// （B06-07a-2 の 2c までは中枢が断り、何も保存しない）、出たら次の発言で出た先の保存モードの会話を作る、ロックで値を捨てる。
// U477 の直し: ほかの端末の切り替えが中枢の知らせ（StorageModeNotice）で届いて表示が変わる、知らせを取り逃して記録しないと
// 表示したまま送った発言が記録されたら、応答の区切りで表示をすぐ直し、記録された印（storage_notice）を画面へ返す。
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
import { createHubTransport } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import { buildStatusBar } from './status-bar.js';
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const SCREEN = { trustedSender: true, windowFocused: true };

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly storageMode: unknown;
  readonly origin: unknown;
}

// 流れへの発言が答えを返せるよう、合成の口座と予定を読む模擬の provider（canvas-vertical.test.ts と同じ形。値は合成）。
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const TURNS: NonNullable<Parameters<typeof startHub>[1]['turns']> = {
  provider: {
    connection: () =>
      Promise.resolve({
        provider: 'mock' as const,
        account_id: ACCOUNT,
        account_label: '合成の口座',
        status: 'active' as const,
        access: 'read_write' as const,
      }),
    readPermission: (accountId) =>
      Promise.resolve(
        accountId === ACCOUNT
          ? {
              account_id: ACCOUNT,
              permission_revision: '1',
              scopes: ['mail.read'],
            }
          : null,
      ),
    readTarget: () => Promise.resolve(null),
    listEvents: () => Promise.resolve([]),
  },
  candidates: { mailCandidates: () => Promise.resolve([]) },
  utcOffset: '+09:00',
};

interface Rig {
  readonly hub: TestHub;
  readonly link: DesktopCoreLink;
  readonly sent: Sent[];
  // 購読で届いた保存モードの知らせの数（U477）。
  readonly modeNotices: () => number;
  // true の間は、保存モードの知らせを main へ渡さない（取り逃しを作る）。
  dropModeNotices: boolean;
  change(
    mode: string,
    options?: {
      readonly io?: DesktopIoState;
      readonly sender?: typeof SCREEN;
    },
  ): Promise<DesktopIpcResponse>;
  turn(text: string): Promise<DesktopIpcResponse>;
}

async function startStorageHub(t: test.TestContext): Promise<TestHub> {
  const dir = await tempDir(t, 'bsh-');
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  return startHub(t, { dataDir, port: await freePort(), turns: TURNS });
}

const isModeNotice = (data: unknown): boolean =>
  typeof data === 'object' &&
  data !== null &&
  (data as { type?: unknown }).type === 'notice' &&
  (data as { notice?: { schema?: unknown } }).notice?.schema ===
    'buddy.storage-mode-notice.v1';

async function start(
  t: test.TestContext,
  options: {
    readonly hub?: TestHub;
    readonly canvasMode?: boolean;
  } = {},
): Promise<Rig> {
  const dir = await tempDir(t, 'bsm-');
  const hub = options.hub ?? (await startStorageHub(t));
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
  const sent: Sent[] = [];
  let modeNotices = 0;
  const state = { dropModeNotices: false };
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
    ioState: () => UNLOCKED,
    ...(options.canvasMode === true
      ? { canvasMode: true, displayLease: false as const }
      : {}),
    transportFor: (target, bearer) => {
      const transport = createHubTransport({ hub: target, token: bearer });
      return {
        request: (request) => {
          const body = (request.body ?? {}) as Record<string, unknown>;
          sent.push({
            method: request.method,
            path: request.path,
            storageMode: body['storage_mode'] ?? null,
            origin: request.screenOperation === true ? 'screen' : null,
          });
          return transport.request(request);
        },
        openStream: (cursor, lockState, listener) =>
          transport.openStream(cursor, lockState, (event) => {
            if (event.type === 'message' && isModeNotice(event.data)) {
              modeNotices += 1;
              if (state.dropModeNotices) return;
            }
            listener(event);
          }),
      };
    },
  });
  onCleanup(t, () => link.stop());
  await link.start('unlocked');
  await waitUntil(() => link.linkState?.phase === 'live', 'live');
  return {
    hub,
    link,
    sent,
    modeNotices: () => modeNotices,
    get dropModeNotices() {
      return state.dropModeNotices;
    },
    set dropModeNotices(value: boolean) {
      state.dropModeNotices = value;
    },
    async change(mode, options = {}) {
      const channel = 'desktop.storage_mode_change';
      const { response } = await link.handleStorageModeIpc(
        channel,
        { channel, request_id: randomUUID(), payload: { storage_mode: mode } },
        options.sender ?? SCREEN,
        options.io ?? UNLOCKED,
      );
      return response;
    },
    async turn(text) {
      const channel = 'desktop.turn_submit';
      const { response } = await link.handleOperationIpc(
        channel,
        { channel, request_id: randomUUID(), payload: { text } },
        SCREEN,
        UNLOCKED,
      );
      return response;
    },
  };
}

const modeRequests = (r: Rig) =>
  r.sent.filter((entry) => entry.path === '/v1/stream/storage-mode');

const statusMode = (r: Rig) => {
  const status = buildStatusBar(UNLOCKED, r.link.hubStatus());
  return status.visibility === 'shown' ? status.storage_mode : 'hidden';
};

test(
  'the legacy window reads the mode on connect, enters private by a screen operation, and the status bar shows it',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t);
    // 接続したら中枢の流れの今の保存モードを読む（まだ区切りがないので通常）。
    await waitUntil(() => statusMode(r) === 'normal', 'read on connect');
    assert.deepEqual(modeRequests(r), [
      {
        method: 'GET',
        path: '/v1/stream/storage-mode',
        storageMode: null,
        origin: null,
      },
    ]);

    // 前面でない窓・ロック中・信頼しない送信元は、中枢へ何も送らない。
    for (const [options, reason] of [
      [
        { sender: { trustedSender: true, windowFocused: false } },
        'screen_operation_required',
      ],
      [{ io: { ...UNLOCKED, lockState: 'locked' as const } }, 'device_locked'],
      [
        { sender: { trustedSender: false, windowFocused: true } },
        'untrusted_sender',
      ],
    ] as const) {
      const refused = await r.change('private', options);
      assert.equal(refused.outcome, 'rejected');
      assert.equal((refused as { reason?: string }).reason, reason);
    }
    assert.equal(modeRequests(r).length, 1);
    assert.equal(statusMode(r), 'normal');

    // 画面操作で記録しないへ入る。中枢へは画面操作として 1 回だけ送り、保存境界が private になる。
    const entered = await r.change('private');
    assert.equal(entered.outcome, 'ok');
    assert.equal(
      (entered as { storage_mode?: string }).storage_mode,
      'private',
    );
    // 自分の切り替えの知らせでも読み直すので、最後の要求とは限らない。送った切り替えだけを見る。
    assert.deepEqual(
      modeRequests(r).filter((entry) => entry.method === 'POST'),
      [
        {
          method: 'POST',
          path: '/v1/stream/storage-mode',
          storageMode: 'private',
          origin: 'screen',
        },
      ],
    );
    assert.equal(r.hub.handle.storage.privateConversation(), true);
    assert.equal(statusMode(r), 'private');

    // 記録しない間の従来の窓の発言は会話を作らず、流れの経路へ送る。中枢は RAM だけで受けて答え（B06-07a-2 の 2c、
    // ADR 0190）、画面へ結果を返す。記録された印は付かず、表示は記録しないのまま。
    const before = r.sent.length;
    const privateTurn = await r.turn('今日の用事を見せて');
    assert.equal(privateTurn.outcome, 'ok', JSON.stringify(privateTurn));
    const shown = (
      privateTurn as {
        turn?: { status?: string; storage_notice?: string };
      }
    ).turn;
    assert(shown !== undefined, JSON.stringify(privateTurn));
    assert.equal(shown.storage_notice, undefined);
    const during = r.sent.slice(before).map((entry) => entry.path);
    assert(during.includes('/v1/stream/turns'), JSON.stringify(during));
    assert(!during.includes('/v1/sessions'), JSON.stringify(during));
    assert.equal(statusMode(r), 'private');
    // 中枢は発言を RAM にだけ持つ（応答の控え 1 件）。
    assert.equal(r.hub.handle.privateConversation?.held().replays, 1);

    // 継続相談へ出る。状態欄は継続相談になり、次の従来の窓の発言は継続相談の会話を作る。
    const exited = await r.change('extended');
    assert.equal(exited.outcome, 'ok');
    assert.equal(r.hub.handle.storage.privateConversation(), false);
    assert.equal(statusMode(r), 'extended');
    const mark = r.sent.length;
    await r.turn('今日の用事を見せて');
    const created = r.sent
      .slice(mark)
      .find((entry) => entry.path === '/v1/sessions');
    assert.deepEqual(created, {
      method: 'POST',
      path: '/v1/sessions',
      storageMode: 'extended',
      origin: null,
    });

    // ロックで値を捨てる（状態欄は隠す。解除したら読み直す）。
    r.link.setLockState('locked');
    assert.equal(r.link.hubStatus().storageMode, null);
    r.link.setLockState('unlocked');
    await waitUntil(
      () => r.link.hubStatus().storageMode === 'extended',
      'read after unlock',
    );
  },
);

test(
  'U477: a switch on another device reaches this device by a notice, and a turn sent while private was shown reports that it was recorded',
  { timeout: 90_000 },
  async (t) => {
    const hub = await startStorageHub(t);
    // 端末 A（従来の窓）と端末 B（従来の窓）。同じ中枢に別の端末として登録する。
    const a = await start(t, { hub });
    const b = await start(t, { hub });
    await waitUntil(
      () => statusMode(a) === 'normal' && statusMode(b) === 'normal',
      'both read normal on connect',
    );

    // A で記録しないへ入ると、B は何も押さずに知らせで読み直し、記録しないと表示する。
    const bBefore = b.sent.length;
    assert.equal((await a.change('private')).outcome, 'ok');
    await waitUntil(() => statusMode(b) === 'private', 'B learns private');
    assert(b.modeNotices() >= 1);
    // B が送ったのは保存モードと、記録しない会話の承認を待つ確認（ADR 0197）の読み取りだけ（切り替え・発言は送っていない）。
    assert.deepEqual(
      [
        ...new Set(
          b.sent.slice(bBefore).map((entry) => `${entry.method} ${entry.path}`),
        ),
      ].sort(),
      ['GET /v1/private-confirmations', 'GET /v1/stream/storage-mode'],
    );

    // B で記録しないを終えると、A は知らせで読み直し、通常と表示する（A は何も押していない）。
    const aBefore = a.sent.length;
    assert.equal((await b.change('normal')).outcome, 'ok');
    await waitUntil(() => statusMode(a) === 'normal', 'A learns normal');
    assert.deepEqual(
      [
        ...new Set(
          a.sent.slice(aBefore).map((entry) => `${entry.method} ${entry.path}`),
        ),
      ].sort(),
      ['GET /v1/private-confirmations', 'GET /v1/stream/storage-mode'],
    );

    // 取り逃し: A へ知らせを渡さない間に、B が記録しないへ入って A も知らせで記録しないになり、その後 B が終える。
    assert.equal((await b.change('private')).outcome, 'ok');
    await waitUntil(() => statusMode(a) === 'private', 'A learns private');
    a.dropModeNotices = true;
    const dropped = a.modeNotices();
    assert.equal((await b.change('normal')).outcome, 'ok');
    await waitUntil(() => a.modeNotices() > dropped, 'the notice was dropped');
    assert.equal(statusMode(a), 'private');
    assert.equal(hub.handle.storage.privateConversation(), false);

    // A は記録しないと表示したまま発言を送る。中枢は通常の区切りで受けて記録する。応答の区切りで表示をすぐ直し、記録された
    // 印を画面へ返す。
    const mark = a.sent.length;
    const turn = await a.turn('今日の用事を見せて');
    assert.equal(turn.outcome, 'ok', JSON.stringify(turn));
    assert.equal(
      (turn as { turn?: { storage_notice?: string } }).turn?.storage_notice,
      'recorded_while_private_shown',
    );
    assert.equal(statusMode(a), 'normal');
    // 送った先は流れの経路（記録しないと表示していたので会話を作らない）。その後に読み直す。
    const after = a.sent
      .slice(mark)
      .map((entry) => `${entry.method} ${entry.path}`);
    assert.equal(after[0], 'POST /v1/stream/turns');
    assert(!after.includes('POST /v1/sessions'), JSON.stringify(after));
    await waitUntil(
      () =>
        a.sent
          .slice(mark)
          .some(
            (entry) =>
              entry.method === 'GET' &&
              entry.path === '/v1/stream/storage-mode',
          ),
      'read after the mismatch',
    );
    // 表示と中枢が一致している間の発言には印を付けない。
    a.dropModeNotices = false;
    const next = await a.turn('今日の用事を見せて');
    assert.equal(next.outcome, 'ok', JSON.stringify(next));
    assert.equal(
      (next as { turn?: { storage_notice?: string } }).turn?.storage_notice,
      undefined,
    );
  },
);

test(
  'U477: in the canvas view a stream turn sent while private was shown also reports that it was recorded',
  { timeout: 90_000 },
  async (t) => {
    const hub = await startStorageHub(t);
    const c = await start(t, { hub, canvasMode: true });
    const b = await start(t, { hub });
    await waitUntil(() => statusMode(c) === 'normal', 'C reads normal');
    assert.equal((await b.change('private')).outcome, 'ok');
    await waitUntil(() => statusMode(c) === 'private', 'C learns private');
    c.dropModeNotices = true;
    const dropped = c.modeNotices();
    assert.equal((await b.change('normal')).outcome, 'ok');
    await waitUntil(() => c.modeNotices() > dropped, 'the notice was dropped');
    assert.equal(statusMode(c), 'private');
    const turn = await c.turn('今日の用事を見せて');
    assert.equal(turn.outcome, 'ok', JSON.stringify(turn));
    assert.equal(
      (turn as { turn?: { storage_notice?: string } }).turn?.storage_notice,
      'recorded_while_private_shown',
    );
    assert.equal(statusMode(c), 'normal');
  },
);
