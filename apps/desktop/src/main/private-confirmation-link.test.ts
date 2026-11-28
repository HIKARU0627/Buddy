// 記録しない会話の独立した確認を画面に出して承認を受ける経路（ADR 0197、U503）を、127.0.0.1 の製品の Core（startCore、鍵は
// 模擬）と、2 台分の main の部品（DesktopCoreLink・PrivateConfirmationBridge・@buddy/client）で通す統合の試験。Electron は
// 起動しない。確認の画面の口（PRIVATE_CONFIRMATION_SCREEN_OPEN）は製品では閉じたままで、この試験の組み立てだけが開く。
// provider は合成の読み書きの口（対象のメールのラベル・件名・差出人を持ち、ラベルの変更のたびに版を 1 つ進める）。
// 期待値は手で書いた。模擬の試験だけで、実機・実 API は未実施。
// 確かめること: 記録しない会話の間の発言で確認ができると、頼んだ端末の画面にだけ「何をどう変えるか」が出る（確認の ID・hash・
// 端末 ID は画面へ渡さない）、承認は OS の確認ダイアログを 1 回挟み、画面操作として 1 回だけ送る（本文に端末 ID を入れない）、
// 中枢は最小の操作記録を書いて外部の変更を 1 回だけ行う、二度押し・他の端末・停止中・前面でない・ダイアログでやめる・
// 記録しない会話を出た後は送らない／通らない、断るは記録も外部の変更も作らない。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type { ProviderReader, ProviderWriter } from '@buddy/core';
import type {
  DesktopConnectionView,
  DesktopIpcResponse,
  DesktopPrivateConfirmationEntry,
} from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import { adminConfirmText } from './admin-confirm.js';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import type { AdminConfirmRequest } from './core-link.js';
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
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const STOPPED: DesktopIoState = { ...UNLOCKED, stopScope: 'local' };
const SCREEN = { trustedSender: true, windowFocused: true };
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const ACCOUNT_LABEL = 'synthetic-account';
const MAIL = 'mail-001';
const SUBJECT = 'B06-SYNTH 合成の件名';
const SENDER = 'sender@example.invalid';

interface FakeMail {
  labels: string[];
  revision: number;
  readonly changes: { add: readonly string[]; remove: readonly string[] }[];
}

function fakeProvider(mail: FakeMail): {
  reader: ProviderReader;
  writer: ProviderWriter;
} {
  const target = () => ({
    remote_id: MAIL,
    source_revision: `r${mail.revision}`,
    mailbox: 'inbox',
    labels: [...mail.labels],
    subject: SUBJECT,
    sender: SENDER,
    received_at: '2026-10-04T08:00:00Z',
  });
  return {
    reader: {
      connection: () =>
        Promise.resolve({
          provider: 'mock',
          account_id: ACCOUNT,
          account_label: ACCOUNT_LABEL,
          status: 'active',
          access: 'read_write',
          writable_kinds: ['mail.labels.change'],
          readable_kinds: ['mail.message'],
        }),
      readPermission: (accountId) =>
        Promise.resolve(
          accountId === ACCOUNT
            ? {
                account_id: ACCOUNT,
                permission_revision: '1',
                scopes: ['mail.read', 'mail.labels.change'],
              }
            : null,
        ),
      readTarget: (remoteId) =>
        Promise.resolve(remoteId === MAIL ? target() : null),
      listEvents: () => Promise.resolve([]),
    },
    writer: {
      changeLabels: (_identity, change) => {
        mail.changes.push({ add: change.add, remove: change.remove });
        mail.labels = [
          ...mail.labels.filter((label) => !change.remove.includes(label)),
          ...change.add.filter((label) => !mail.labels.includes(label)),
        ];
        mail.revision += 1;
        return Promise.resolve({
          kind: 'applied',
          status: 200,
          value: target(),
        });
      },
    },
  };
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly origin: 'screen' | null;
}

interface Device {
  readonly id: string;
  readonly link: DesktopCoreLink;
  readonly sent: Sent[];
  readonly confirms: AdminConfirmRequest[];
  // OS の確認ダイアログの答え（試験が変える）。
  answer: boolean;
  io: DesktopIoState;
  view(): Extract<DesktopConnectionView, { visibility: 'shown' }>;
  ipc(
    channel: 'desktop.turn_submit' | 'desktop.private_confirmation_decide',
    payload: unknown,
    options?: { readonly sender?: typeof SCREEN; readonly io?: DesktopIoState },
  ): Promise<DesktopIpcResponse>;
  storage(mode: 'normal' | 'private'): Promise<DesktopIpcResponse>;
}

async function startDevice(t: test.TestContext, hub: TestHub): Promise<Device> {
  const dir = await tempDir(t, 'bpc-');
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
  const confirms: AdminConfirmRequest[] = [];
  const device: Device = {
    id: deviceId,
    sent,
    confirms,
    answer: true,
    io: UNLOCKED,
    link: null as unknown as DesktopCoreLink,
    view() {
      const view = device.link.view('unlocked');
      assert(view.visibility === 'shown');
      return view;
    },
    async ipc(channel, payload, options = {}) {
      const { response } = await device.link.handleOperationIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        options.sender ?? SCREEN,
        options.io ?? device.io,
      );
      return response;
    },
    async storage(mode) {
      const channel = 'desktop.storage_mode_change';
      const { response } = await device.link.handleStorageModeIpc(
        channel,
        { channel, request_id: randomUUID(), payload: { storage_mode: mode } },
        SCREEN,
        device.io,
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
    confirmAdmin: (request) => {
      confirms.push(request);
      return Promise.resolve(device.answer);
    },
    ioState: () => device.io,
    transportFor: (target, bearer) => {
      const transport = createHubTransport({ hub: target, token: bearer });
      return {
        request: async (request) => {
          if (request.path.startsWith('/v1/private-confirmations'))
            sent.push({
              method: request.method,
              path: request.path,
              body: { ...(request.body ?? {}) },
              origin: request.screenOperation === true ? 'screen' : null,
            });
          return transport.request(request);
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

async function startConfirmationHub(
  t: test.TestContext,
  mail: FakeMail,
  options: { readonly open?: boolean } = {},
): Promise<TestHub> {
  const dir = await tempDir(t, 'bpch-');
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const ports = fakeProvider(mail);
  return startHub(t, {
    dataDir,
    port: await freePort(),
    turns: {
      provider: ports.reader,
      writer: ports.writer,
      candidates: {
        mailCandidates: () =>
          Promise.resolve([
            {
              candidate_id: '00000000-0000-4000-8000-0000000000c1',
              remote_id: MAIL,
            },
          ]),
      },
      utcOffset: '+09:00',
      // 試験の組み立てだけが確認の画面の口を開く（製品は閉じたまま）。
      ...(options.open === false
        ? {}
        : { privateConfirmationScreen: () => true }),
    },
  });
}

const field = (response: DesktopIpcResponse, key: string): unknown =>
  (response as unknown as Record<string, unknown>)[key];

const marker = () => `B06-SYNTH-label-${randomUUID().slice(0, 8)}`;

const ask = async (device: Device, label: string) => {
  const turn = await device.ipc('desktop.turn_submit', {
    text: `${MAIL} に ${label} を付けて`,
  });
  assert.equal(turn.outcome, 'ok', JSON.stringify(turn));
  await waitUntil(
    () => device.view().private_confirmations.length === 1,
    'the confirmation is listed',
  );
  return device.view()
    .private_confirmations[0] as DesktopPrivateConfirmationEntry;
};

const privatePosts = (device: Device) =>
  device.sent.filter((entry) => entry.method === 'POST');

test(
  'the screen of the requesting device approves a private label change once after one dialog; the minimal record runs the change exactly once',
  { timeout: 90_000 },
  async (t) => {
    const mail: FakeMail = { labels: ['inbox'], revision: 1, changes: [] };
    const hub = await startConfirmationHub(t, mail);
    const a = await startDevice(t, hub);
    const b = await startDevice(t, hub);
    const entered = await a.storage('private');
    assert.equal(entered.outcome, 'ok', JSON.stringify(entered));
    await waitUntil(
      () => b.link.hubStatus().storageMode === 'private',
      'B sees private',
    );

    const label = marker();
    const entry = await ask(a, label);
    // 画面へ渡すのは参照と、何をどう変えるかだけ（確認の ID・hash・端末 ID・区切りの世代は含めない）。
    assert.deepEqual(
      { ...entry, ref: 'REF' },
      {
        ref: 'REF',
        service: 'mock',
        account_label: ACCOUNT_LABEL,
        target: {
          subject: SUBJECT,
          sender: SENDER,
          received_at: '2026-10-04T08:00:00Z',
        },
        labels_add: [label],
        labels_remove: [],
        approvable: true,
        delivery_unknown: false,
      },
    );
    // 他の端末には出さない（U600）。B が記録しない会話の間に発言して一覧を読み直しても空で、B の参照では A の確認を指せない。
    // （B のロックの申告は、記録しない区切りの承認前の確認をすべて取り下げる。U507。ここではロックを使わない。）
    const readsBefore = b.sent.filter((entry) => entry.method === 'GET').length;
    const bTurn = await b.ipc('desktop.turn_submit', {
      text: '今日の予定を見せて',
    });
    assert.equal(bTurn.outcome, 'ok', JSON.stringify(bTurn));
    await waitUntil(
      () =>
        b.sent.filter((entry) => entry.method === 'GET').length > readsBefore,
      'B reads the list again',
    );
    assert.deepEqual(b.view().private_confirmations, []);
    const fromB = await b.ipc('desktop.private_confirmation_decide', {
      ref: entry.ref,
      decision: 'approve',
    });
    assert.equal(field(fromB, 'reason'), 'entry_not_found');

    // 前面でない・停止中は送らない。ダイアログで「やめる」も送らない。
    const hidden = await a.ipc(
      'desktop.private_confirmation_decide',
      { ref: entry.ref, decision: 'approve' },
      { sender: { trustedSender: true, windowFocused: false } },
    );
    assert.equal(field(hidden, 'reason'), 'screen_operation_required');
    const stopped = await a.ipc(
      'desktop.private_confirmation_decide',
      { ref: entry.ref, decision: 'approve' },
      { io: STOPPED },
    );
    assert.equal(field(stopped, 'reason'), 'input_stopped');
    a.answer = false;
    const declinedDialog = await a.ipc('desktop.private_confirmation_decide', {
      ref: entry.ref,
      decision: 'approve',
    });
    assert.equal(field(declinedDialog, 'reason'), 'confirmation_declined');
    assert.deepEqual(privatePosts(a), []);
    assert.deepEqual(mail.changes, []);

    // 承認: OS の確認ダイアログを 1 回挟み、画面操作として 1 回だけ送る。
    a.answer = true;
    const confirmsBefore = a.confirms.length;
    const approved = await a.ipc('desktop.private_confirmation_decide', {
      ref: entry.ref,
      decision: 'approve',
    });
    assert.equal(approved.outcome, 'ok', JSON.stringify(approved));
    assert.deepEqual(contract.responseErrors(approved), []);
    assert.equal(field(approved, 'result'), 'recorded');
    assert.equal(a.confirms.length, confirmsBefore + 1);
    // ダイアログの値は main が中枢から読んだ値（記録しない会話であること・対象・付けるラベル）。
    const dialog = a.confirms.at(-1);
    assert(dialog !== undefined);
    const text = adminConfirmText(dialog);
    assert.equal(text.title, '記録しない会話の変更の承認');
    assert(text.detail.includes('会話の内容は保存しません。'));
    assert(text.detail.includes(`対象の件名: ${SUBJECT}`));
    assert(text.detail.includes(`付けるラベル: ${label}`));
    const posts = privatePosts(a);
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert(post !== undefined);
    assert.equal(post.origin, 'screen');
    assert.match(
      post.path,
      /^\/v1\/private-confirmations\/[0-9a-f-]{36}\/approve$/u,
    );
    assert.deepEqual(Object.keys(post.body).sort(), [
      'command_scope_id',
      'content_hash',
      'content_version',
      'request_id',
    ]);
    assert.equal(post.body['content_version'], '1');
    assert(!JSON.stringify(post.body).includes(a.id));

    // 中枢は最小の操作記録を書き、外部の変更を 1 回だけ行う。
    await hub.handle.runner?.idle();
    assert.deepEqual(mail.changes, [{ add: [label], remove: [] }]);
    const snapshot = await hub.handle.store.query({ kind: 'snapshot' });
    assert.equal(snapshot.operations.length, 1);
    assert.equal(snapshot.operations[0]?.state, 'succeeded');
    await waitUntil(
      () => a.view().private_confirmations.length === 0,
      'the confirmation leaves the list',
    );
    // 二度押しは送らない（一覧にない）。
    const twice = await a.ipc('desktop.private_confirmation_decide', {
      ref: entry.ref,
      decision: 'approve',
    });
    assert.equal(field(twice, 'reason'), 'entry_not_found');
    assert.equal(privatePosts(a).length, 1);
    await hub.handle.runner?.idle();
    assert.equal(mail.changes.length, 1);
  },
);

test(
  'declining sends one request without a dialog and records nothing; leaving the private conversation clears the list and nothing is sent afterwards',
  { timeout: 90_000 },
  async (t) => {
    const mail: FakeMail = { labels: ['inbox'], revision: 1, changes: [] };
    const hub = await startConfirmationHub(t, mail);
    const a = await startDevice(t, hub);
    assert.equal((await a.storage('private')).outcome, 'ok');

    // 断る: ダイアログを挟まず 1 回だけ送り、記録も外部の変更も作らない。停止中でも断れる。
    const first = await ask(a, marker());
    const declined = await a.ipc(
      'desktop.private_confirmation_decide',
      { ref: first.ref, decision: 'decline' },
      { io: STOPPED },
    );
    assert.equal(declined.outcome, 'ok', JSON.stringify(declined));
    assert.equal(field(declined, 'result'), 'declined');
    assert.equal(a.confirms.length, 0);
    assert.equal(privatePosts(a).length, 1);
    assert.match(privatePosts(a)[0]?.path ?? '', /\/decline$/u);
    await waitUntil(
      () => a.view().private_confirmations.length === 0,
      'declined leaves the list',
    );

    // 記録しない会話を出ると一覧は空になり、古い参照では送らない。
    const second = await ask(a, marker());
    assert.equal((await a.storage('normal')).outcome, 'ok');
    await waitUntil(
      () => a.view().private_confirmations.length === 0,
      'leaving clears the list',
    );
    const after = await a.ipc('desktop.private_confirmation_decide', {
      ref: second.ref,
      decision: 'approve',
    });
    assert.equal(field(after, 'reason'), 'entry_not_found');
    assert.equal(privatePosts(a).length, 1);

    // ロックで一覧を捨てる（解除の後も、中枢が取り下げた確認は出ない）。
    assert.equal((await a.storage('private')).outcome, 'ok');
    const third = await ask(a, marker());
    a.link.setLockState('locked');
    assert.equal(a.link.view('locked').visibility, 'hidden');
    // 中枢がロックの申告を受けて、承認を待つ確認を取り下げる（U507）。
    await waitUntil(
      () => hub.handle.privateConfirmations?.held().pending === 0,
      'the hub drops the confirmation on the lock report',
    );
    const readsBefore = a.sent.filter((entry) => entry.method === 'GET').length;
    a.link.setLockState('unlocked');
    // 解除の後に一覧を読み直し、空のまま。
    await waitUntil(
      () =>
        a.sent.filter((entry) => entry.method === 'GET').length > readsBefore,
      'A reads the list after unlocking',
    );
    await waitUntil(() => a.link.linkState?.phase === 'live', 'A live');
    assert.deepEqual(a.view().private_confirmations, []);
    const locked = await a.ipc('desktop.private_confirmation_decide', {
      ref: third.ref,
      decision: 'approve',
    });
    assert.equal(locked.outcome, 'rejected');
    assert.equal(privatePosts(a).length, 1);

    await hub.handle.runner?.idle();
    const snapshot = await hub.handle.store.query({ kind: 'snapshot' });
    assert.equal(snapshot.operations.length, 0);
    assert.deepEqual(mail.changes, []);
  },
);

test(
  'a lock report from another device withdraws the confirmation of the requesting device (U609), and nothing is sent or changed',
  { timeout: 90_000 },
  async (t) => {
    const mail: FakeMail = { labels: ['inbox'], revision: 1, changes: [] };
    const hub = await startConfirmationHub(t, mail);
    const a = await startDevice(t, hub);
    const b = await startDevice(t, hub);
    assert.equal((await a.storage('private')).outcome, 'ok');
    const entry = await ask(a, marker());
    assert.equal(hub.handle.privateConfirmations?.held().pending, 1);
    // B（頼んでいない端末）がロックする。中枢はロックの申告で、記録しない区切りの承認を待つ確認をすべて取り下げる。
    b.link.setLockState('locked');
    await waitUntil(
      () => hub.handle.privateConfirmations?.held().pending === 0,
      'the hub drops the confirmation on B lock report',
    );
    // A が一覧を読み直すと空で、古い参照では送らない。
    const readsBefore = a.sent.filter((s) => s.method === 'GET').length;
    const turn = await a.ipc('desktop.turn_submit', {
      text: '今日の予定を見せて',
    });
    assert.equal(turn.outcome, 'ok', JSON.stringify(turn));
    await waitUntil(
      () => a.sent.filter((s) => s.method === 'GET').length > readsBefore,
      'A reads the list again',
    );
    await waitUntil(
      () => a.view().private_confirmations.length === 0,
      'the list is empty',
    );
    const stale = await a.ipc('desktop.private_confirmation_decide', {
      ref: entry.ref,
      decision: 'approve',
    });
    assert.equal(field(stale, 'reason'), 'entry_not_found');
    assert.deepEqual(privatePosts(a), []);
    await hub.handle.runner?.idle();
    assert.deepEqual(mail.changes, []);
  },
);

test(
  'with the screen gate closed the private label change is refused and the screen shows nothing',
  { timeout: 90_000 },
  async (t) => {
    const mail: FakeMail = { labels: ['inbox'], revision: 1, changes: [] };
    const hub = await startConfirmationHub(t, mail, { open: false });
    const a = await startDevice(t, hub);
    assert.equal((await a.storage('private')).outcome, 'ok');
    const readsBefore = a.sent.filter((s) => s.method === 'GET').length;
    const turn = await a.ipc('desktop.turn_submit', {
      text: `${MAIL} に ${marker()} を付けて`,
    });
    assert.equal(turn.outcome, 'ok', JSON.stringify(turn));
    // 一覧は読みに行くが、中枢は空を返し、画面には何も出ない。
    await waitUntil(
      () => a.sent.filter((s) => s.method === 'GET').length > readsBefore,
      'A reads the list',
    );
    assert.deepEqual(a.view().private_confirmations, []);
    assert.equal(hub.handle.privateConfirmations?.held().pending, 0);
    assert.deepEqual(privatePosts(a), []);
    await hub.handle.runner?.idle();
    assert.deepEqual(mail.changes, []);
  },
);
