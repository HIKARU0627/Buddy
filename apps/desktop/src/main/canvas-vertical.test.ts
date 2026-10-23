// 最小の縦断の統合試験（UI-03、ADR 0032、Issue #95 の完了条件）。入力バーの発言 → 流れ（POST /v1/stream/turns）→
// 模擬の配置者 → 用事の list のカードの記述が、キャンバスの窓だけに届くことを、127.0.0.1 の Core と main の部品
// （DesktopCoreLink・CanvasBridge・UiWindowRegistry・窓の役割の受付）で確かめる（two-clients.test.ts と同じ形）。
//
// - 中枢は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬の KeyStore）。クライアントは DesktopCoreLink
//   （TLS のピン留め・ws・@buddy/client の状態機械）。Electron は起動しない。safeStorage は模擬。端末は中枢の DB に直接
//   登録し、その端末トークンを模擬の safeStorage に保存して start する（ペアリングは two-clients.test.ts で試験済み）。
// - 窓は対応表（UiWindowRegistry）の模擬で、通知の宛先と、役割ごとの受付（windowSender）を実物の関数で確かめる。
// - 期待値（版・見出し・件数・宛先・拒否の理由）は手で書いた値か、中枢（別の実装）から取った値で、検査対象の
//   クライアントの関数から作らない。中枢の識別子（予定の参照）は、中枢へ直接 GET して求める。
// - 模擬の試験だけ。実機（Electron の窓・画面）の確認は docs/ui/canvas-vertical.md で別に記録する。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type { CoreHttpsOptions } from '@buddy/core';
import type {
  CanvasDocument,
  DesktopCanvasView,
  DesktopIpcNotification,
  DesktopIpcResponse,
} from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import {
  DESKTOP_IPC_CHANNELS,
  desktopChannelAllowedForRole,
} from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import {
  CANVAS_DISPLAY_FILE,
  saveCanvasDisplaySettings,
} from './canvas-display.js';
import {
  ADMIN_CHANNELS,
  CANVAS_CHANNELS,
  CONNECTION_CHANNELS,
  DesktopCoreLink,
  OPERATION_CHANNELS,
  type AdminConfirmRequest,
} from './core-link.js';
import { SecretText, saveCredential } from './credential-store.js';
import {
  freePort,
  mockProtector,
  onCleanup,
  startHub,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import { describeExchange } from './hub-test-support.js';
import type { TestHub } from './hub-test-support.js';
import { hubRequest, createHubTransport } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import { systemClock } from './system-clock.js';
import {
  UiWindowRegistry,
  canvasResendAfter,
  senderFactsOf,
  windowSender,
} from './window-roles.js';
import type { UiWindowRole } from './window-roles.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const HOME = {
  gateway_mac: '00:00:5e:00:53:01',
  subnet: '192.0.2.0/24',
  ssid: null,
  unavailable: [],
};

// 設計 09 §2 の時計（2026-10-05T09:00:00+09:00）。今日は ev-0〜ev-3 の 4 件（ev-1 と ev-2 が重なる）、ev-4 は翌日。
const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const EVENTS = [
  ['ev-0', '2026-10-04T23:30:00+09:00', '2026-10-05T00:30:00+09:00'],
  ['ev-1', '2026-10-05T09:30:00+09:00', '2026-10-05T10:30:00+09:00'],
  ['ev-2', '2026-10-05T10:00:00+09:00', '2026-10-05T11:00:00+09:00'],
  ['ev-3', '2026-10-05T11:00:00+09:00', '2026-10-05T12:00:00+09:00'],
  ['ev-4', '2026-10-06T10:00:00+09:00', '2026-10-06T11:00:00+09:00'],
].map(([event_id, start, end]) => ({
  event_id: event_id as string,
  title: `合成の予定 ${event_id}`,
  start: start as string,
  end: end as string,
}));

const turnsWith = (
  events: typeof EVENTS,
): NonNullable<CoreHttpsOptions['turns']> => ({
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
    listEvents: () => Promise.resolve(events),
  },
  candidates: { mailCandidates: () => Promise.resolve([]) },
  utcOffset: '+09:00',
});
const turns = turnsWith(EVENTS);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const APP_URL = 'buddy://app/index.html';
const mainFrameOf = (id: number) => ({ processId: id * 10, routingId: 1 });
const frameOf = (id: number) => ({
  parent: null,
  ...mainFrameOf(id),
  url: APP_URL,
});

// 3 つの窓の対応表（canvas 11・status 12・input 13）。通知は読み込みが終わった窓だけ。
function threeWindows() {
  const registry = new UiWindowRegistry<string>();
  registry.register(11, 'canvas', 'canvas');
  registry.register(12, 'status', 'status');
  registry.register(13, 'input', 'input');
  for (const id of [11, 12, 13]) registry.setReady(id, true);
  return registry;
}

// main の受付と同じ組み立て: 対応表で送信元の窓を引き、実際の senderFactsOf を通し、役割から送信元を作る。
function senderFor(
  registry: UiWindowRegistry<string>,
  webContentsId: number,
  channel: string,
) {
  const entry = registry.lookup(webContentsId);
  return windowSender({
    channel,
    role: entry?.role ?? null,
    facts: senderFactsOf(
      webContentsId,
      frameOf(webContentsId),
      entry === null
        ? null
        : {
            webContentsId: entry.webContentsId,
            mainFrame: mainFrameOf(entry.webContentsId),
          },
    ),
    focused: true,
  });
}

interface Client {
  readonly link: DesktopCoreLink;
  // 端末側の保存の場所（端末トークンの保存などを置く一時のディレクトリ。UI-06 の「端末に本文が残らない」の試験）。
  readonly dir: string;
  readonly registry: UiWindowRegistry<string>;
  // キャンバスの窓へ通知した記述（通知の宛先は対応表で確かめた）。
  readonly canvasNotices: Extract<
    DesktopIpcNotification,
    { channel: 'desktop.canvas_changed' }
  >[];
  readonly logs: string[];
  // 中枢へ送った要求（方法とパス）と、流れへの発言の本文。
  readonly requests: string[];
  // main の OS の確認ダイアログ（模擬の confirmAdmin）を出した回数と内容（UI-04 のなりすましの試験）。
  readonly confirms: AdminConfirmRequest[];
  readonly streamBodies: Record<string, unknown>[];
  // 入力バー（webContents 13）から発言を送る。
  submit(text: string): Promise<DesktopIpcResponse>;
  // 窓の役割と webContents ごとの IPC（承認・停止の経路の拒否の確認）。
  ipc(
    webContentsId: number,
    channel: string,
    payload: unknown,
  ): Promise<DesktopIpcResponse>;
  // 中枢へ直接読む（登録済みの端末のトークン。キャンバスの正本を別の経路で確かめる）。
  coreCanvas(): Promise<CanvasDocument>;
  coreTurn(text: string): Promise<{ status: number; body: unknown }>;
}

// 中枢からの版の知らせ（購読の canvas メッセージ）が届き、main の処理（取るかどうかの判断）が済んだときに解決する。
// 接続の listener より後に登録するので、解決した時点で main の onRevision は呼ばれている（取得は idle で待つ）。
function nextNotice(
  client: Client,
  predicate: (revision: string) => boolean = () => true,
): Promise<string> {
  const connection = client.link.connection;
  assert(connection !== null, 'not connected');
  return new Promise((resolve) => {
    const off = connection.onCanvas((revision) => {
      if (!predicate(revision)) return;
      off();
      resolve(revision);
    });
  });
}

interface ClientOptions {
  // 応答を中枢から受け取った後、クライアントへ返す前に保つ（世代の競合を作る）。
  readonly holdResponse?: (
    method: string,
    path: string,
  ) => Promise<void> | undefined;
  // 応答を書き換える（中枢が契約に反する記述を返したときの試験）。
  // 端末の入出力の状態（試験が書き換える。停止・io_epoch）。
  readonly io?: { state: DesktopIoState };
  // キャンバスが前に出ているか（UI-06。試験が書き換える）。省略は前に出ている。
  readonly front?: { value: boolean };
  // main の OS の確認ダイアログの答え（与えたときだけ confirmAdmin を付ける）。
  readonly confirm?: (request: AdminConfirmRequest) => boolean;
  readonly rewrite?: (
    path: string,
    outcome: { kind: string; status?: number; body?: unknown },
  ) => { kind: string; status?: number; body?: unknown };
}

async function startClient(
  t: test.TestContext,
  hub: TestHub,
  options: ClientOptions = {},
): Promise<Client> {
  const dir = await tempDir(t, 'bdv-');
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
    registered_at: CLOCK.getTime(),
  });
  assert(inserted.ok, 'device insert failed');
  const pem = readFileSync(join(hub.dataDir, 'tls-certificate.pem'), 'utf8');
  const fingerprint = new X509Certificate(pem).fingerprint256
    .replaceAll(':', '')
    .toLowerCase();
  const pinned: PinnedHub = {
    host: '127.0.0.1',
    port: hub.port,
    certificatePem: pem,
    fingerprint,
  };
  const credentialPath = join(dir, 'device-credential.bin');
  saveCredential(credentialPath, protector, {
    deviceId,
    token: new SecretText(token),
    issuedAt: '2026-10-05T00:00:00Z',
    hub: pinned,
  });
  const registry = threeWindows();
  const canvasNotices: Client['canvasNotices'] = [];
  const logs: string[] = [];
  const requests: string[] = [];
  const streamBodies: Record<string, unknown>[] = [];
  const confirms: AdminConfirmRequest[] = [];
  const link = new DesktopCoreLink({
    contract,
    credentialPath,
    protector,
    clock: systemClock(),
    platform: 'macos',
    collectHome: () => Promise.resolve(HOME),
    networkSignature: () => 'fixed',
    onChange: () => undefined,
    log: (code) => logs.push(code),
    backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
    ...(options.io === undefined
      ? {}
      : { ioState: () => (options.io as { state: DesktopIoState }).state }),
    ...(options.confirm === undefined
      ? {}
      : {
          confirmAdmin: (request: AdminConfirmRequest) => {
            confirms.push(request);
            return Promise.resolve(
              (options.confirm as (r: AdminConfirmRequest) => boolean)(request),
            );
          },
        }),
    canvasMode: true,
    canvasFront: () => options.front?.value ?? true,
    onCanvas: (notification) => {
      // 通知の宛先は、読み込みが終わり役割の表に通知がある窓だけ（キャンバスの窓だけ）。
      assert.deepEqual(
        registry
          .notificationTargets(notification.channel)
          .map((entry) => entry.role),
        ['canvas'],
      );
      canvasNotices.push(notification);
    },
    transportFor: (target, bearer) => {
      const transport = createHubTransport({ hub: target, token: bearer });
      return {
        request: async (request) => {
          requests.push(`${request.method} ${request.path}`);
          if (request.path === '/v1/stream/turns')
            streamBodies.push(request.body as Record<string, unknown>);
          const outcome = await transport.request(request);
          await options.holdResponse?.(request.method, request.path);
          return options.rewrite === undefined
            ? outcome
            : (options.rewrite(
                request.path,
                outcome as { kind: string },
              ) as typeof outcome);
        },
        openStream: (cursor, lockState, listener) =>
          transport.openStream(cursor, lockState, listener),
      };
    },
  });
  onCleanup(t, () => link.stop());
  const send = async (
    webContentsId: number,
    channel: string,
    payload: unknown,
  ): Promise<DesktopIpcResponse> => {
    const raw = { channel, request_id: randomUUID(), payload };
    const sender = senderFor(registry, webContentsId, channel);
    if (OPERATION_CHANNELS.includes(channel as never))
      return (await link.handleOperationIpc(channel, raw, sender, UNLOCKED))
        .response;
    if (ADMIN_CHANNELS.includes(channel as never))
      return (await link.handleAdminIpc(channel, raw, sender, UNLOCKED))
        .response;
    if (CONNECTION_CHANNELS.includes(channel as never))
      return link.handleIpc(channel, raw, sender, UNLOCKED).response;
    // キャンバスの物のユーザーの操作（UI-06）は、端末の今の入出力の状態で受け付ける。
    if (CANVAS_CHANNELS.includes(channel as never))
      return (
        await link.handleCanvasIpc(
          channel,
          raw,
          sender,
          options.io?.state ?? UNLOCKED,
        )
      ).response;
    throw new Error(`not a link channel: ${channel}`);
  };
  const direct = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    hubRequest(pinned, {
      method,
      path,
      headers: {
        authorization: `Bearer ${token}`,
        'buddy-lock-state': 'unlocked',
      },
      ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
    });
  return {
    link,
    dir,
    registry,
    canvasNotices,
    logs,
    requests,
    streamBodies,
    confirms,
    // 最初の live で一度だけ送る。確認時刻の進行や再接続の収束を待たない（Issue #108）。
    async submit(text) {
      await waitUntil(
        () => link.linkState?.phase === 'live',
        'live before submit',
      );
      return send(13, 'desktop.turn_submit', { text });
    },
    ipc: send,
    async coreCanvas() {
      const outcome = await direct('GET', '/v1/canvas');
      assert(outcome.kind === 'response' && outcome.status === 200);
      return outcome.body as CanvasDocument;
    },
    async coreTurn(text) {
      const scope = link.linkState?.commandScopeId;
      assert(typeof scope === 'string');
      const outcome = await direct('POST', '/v1/stream/turns', {
        request_id: randomUUID(),
        command_scope_id: scope,
        text,
        input_kind: 'text',
        expected_canvas_revision: '0',
      });
      assert(outcome.kind === 'response');
      return { status: outcome.status, body: outcome.body };
    },
  };
}

async function startCanvasHub(
  t: test.TestContext,
  hubTurns: NonNullable<CoreHttpsOptions['turns']> = turns,
): Promise<TestHub> {
  const dir = await tempDir(t, 'bdh-');
  return startHub(t, {
    dataDir: join(dir, 'd'),
    port: await freePort(),
    now: () => CLOCK,
    turns: hubTurns,
  });
}

const field = (response: DesktopIpcResponse, key: string): unknown =>
  (response as unknown as Record<string, unknown>)[key];

const latest = (client: Client): DesktopCanvasView | null =>
  client.canvasNotices.at(-1)?.canvas ?? null;

test(
  'UI-03: a message typed in the input bar goes to the stream and the errands card reaches the canvas window only',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => client.link.linkState?.phase === 'live', 'live');
    // 接続したら、中枢のキャンバスの今の記述（版 0 の空）を取って渡す。
    await waitUntil(() => client.canvasNotices.length === 1, 'first notice');
    assert.deepEqual(client.canvasNotices[0], {
      channel: 'desktop.canvas_changed',
      canvas: { canvas_revision: '0', items: [], reading_order: [] },
    });

    // 入力バー（webContents 13）から発言する。文字の結果は answered、予定は 4 件（ev-0〜ev-3）で、重なりが 2 件。
    const response = await client.submit('今日の用事を見せて');
    assert.equal(response.outcome, 'ok', JSON.stringify(response));
    assert.equal(
      client.requests.filter((line) => line === 'GET /v1/bootstrap').length,
      1,
      describeExchange(client),
    );
    assert.deepEqual(
      client.logs.filter((line) => line.startsWith('link:')),
      [
        'link:bootstrapping',
        'link:snapshotting',
        'link:subscribing',
        'link:live',
      ],
      describeExchange(client),
    );

    const turn = field(response, 'turn') as {
      status: string;
      result: Record<string, unknown>;
    };
    assert.equal(turn.status, 'answered');
    assert.equal(turn.result['kind'], 'schedule_cards');
    assert.equal(turn.result['event_count'], 4);
    assert.equal(turn.result['overlap_count'], 2);

    // 会話（POST /v1/sessions）は作らず、流れだけへ送る。本文は発言の文字・版だけ（会話・区切りの ID・保存モードを送らない）。
    assert(!client.requests.includes('POST /v1/sessions'));
    assert.deepEqual(
      client.requests.filter((line) => line.includes('/turns')),
      ['POST /v1/stream/turns'],
    );
    assert.equal(client.streamBodies.length, 1);
    const sentBody = client.streamBodies[0] ?? {};
    assert.deepEqual(Object.keys(sentBody).sort(), [
      'command_scope_id',
      'expected_canvas_revision',
      'input_kind',
      'request_id',
      'text',
    ]);
    assert.equal(sentBody['text'], '今日の用事を見せて');
    assert.equal(sentBody['input_kind'], 'text');
    assert.equal(sentBody['expected_canvas_revision'], '0');

    // 版 1 の記述が、キャンバスの窓へ届く（版の知らせ → 取得 → 検査 → 参照の置き換え → 通知）。
    await waitUntil(
      () => latest(client)?.canvas_revision === '1',
      'canvas revision 1',
    );
    const view = latest(client) as DesktopCanvasView;
    assert.deepEqual(view.reading_order, ['errands']);
    assert.equal(view.items.length, 1);
    const item = view.items[0];
    assert.equal(item?.item_id, 'errands');
    assert.equal(item?.kind, 'card');
    assert.equal(item?.component, 'list');
    assert.equal(item?.heading, '今日の用事');
    assert.equal(item?.emphasis, 'high');
    assert.equal(item?.placement, 'canvas');
    assert.deepEqual(item?.grid, { column: 2, span: 4, rows: 3 });
    assert.equal(item?.data.more_count, 0);
    const refs = item?.data.item_refs ?? [];
    assert.equal(refs.length, 4);
    assert(refs.every((ref) => ref.kind === 'calendar_event'));
    assert(refs.every((ref) => UUID.test(ref.ref)));
    assert.equal(new Set(refs.map((ref) => ref.ref)).size, 4);
    assert(contract.valid('DesktopCanvasView', view));

    // 中枢の識別子（中枢へ直接 GET して求めた予定の参照）は、画面へ渡した記述のどこにも入らない。
    const core = await client.coreCanvas();
    assert.equal(core.canvas_revision, '1');
    const realIds = core.items[0]?.data.item_refs.map((ref) => ref.id) ?? [];
    assert.equal(realIds.length, 4);
    const text = JSON.stringify(client.canvasNotices);
    for (const real of realIds) assert(!text.includes(real), real);

    // 検査・置き換えのほかは中枢の記述と同じ（見出し・格子・強調・読む順）。
    assert.equal(core.items[0]?.heading, item?.heading);
    assert.deepEqual(core.items[0]?.grid, item?.grid);
    assert.deepEqual(core.reading_order, view.reading_order);

    // 状態の層・入力バーへは記述を送らない（通知の宛先は canvas の窓だけ。onCanvas の中でも毎回確かめた）。
    assert.deepEqual(
      client.registry
        .notificationTargets('desktop.canvas_changed')
        .map((entry) => entry.role),
      ['canvas'],
    );
    // 取得は読み取りだけ（GET /v1/canvas）。
    assert(client.requests.includes('GET /v1/canvas'));
  },
);

test(
  'UI-03: a second query updates the card in place and the next message carries the version in hand; a clarification changes nothing',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const firstRefs = latest(client)?.items[0]?.data.item_refs ?? [];
    const second = await client.submit('今日の予定を見せて');
    assert.equal(second.outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '2', 'rev 2');
    // 描いている版を添える。
    assert.equal(client.streamBodies[1]?.['expected_canvas_revision'], '1');
    // 同じカードの中身の更新（物は 1 枚のまま）。同じ世代の中で同じ対象（同じ予定）なら、同じ参照を保つ（UI-07 の PR #124 の
    // レビュー。画面が持つ本文を、対象が変わらないのに取り直さないため）。
    const view = latest(client) as DesktopCanvasView;
    assert.equal(view.items.length, 1);
    const secondRefs = view.items[0]?.data.item_refs ?? [];
    assert.equal(secondRefs.length, 4);
    assert.deepEqual(secondRefs, firstRefs);
    // 知らない文は聞き返し（文字の結果）。キャンバスは変わらない。固定の待ちは使わず、順序で確かめる: 聞き返しの後に本物の
    // 変更（版 3）を行い、その知らせ（購読は順番どおり）が届くまでに、版 3 より前の知らせが 1 つも出ていないこと。
    const seen: string[] = [];
    const off = client.link.connection?.onCanvas((revision) =>
      seen.push(revision),
    );
    const clarified = await client.submit('こんにちは');
    assert.equal(
      (field(clarified, 'turn') as { status: string }).status,
      'clarification',
    );
    const third = nextNotice(client, (revision) => revision === '3');
    assert.equal((await client.coreTurn('今日の予定を見せて')).status, 200);
    await third;
    await client.link.canvasIdle();
    off?.();
    assert.deepEqual(seen, ['3']);
    await waitUntil(() => latest(client)?.canvas_revision === '3', 'rev 3');
    assert.equal((await client.coreCanvas()).canvas_revision, '3');
  },
);

test(
  'UI-03: locking discards the description; a change made while locked is fetched only after unlocking',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    await client.submit('今日の用事を見せて');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    assert.notEqual(client.link.canvasView(), null);
    const countBefore = client.canvasNotices.length;
    const fetchesBefore = client.requests.filter(
      (line) => line === 'GET /v1/canvas',
    ).length;

    // ロック: 中身を捨てて、キャンバスの窓へ空を通知する（参照も捨てる）。
    client.link.setLockState('locked');
    assert.equal(client.link.canvasView(), null);
    assert.equal(client.canvasNotices.length, countBefore + 1);
    assert.deepEqual(client.canvasNotices.at(-1), {
      channel: 'desktop.canvas_changed',
      canvas: null,
    });

    // ロック中に中枢のキャンバスが変わる（別の端末の発言）。版の知らせが届いても取りに行かない。
    const noticed = nextNotice(client, (revision) => revision === '2');
    const other = await client.coreTurn('今日の予定を見せて');
    assert.equal(other.status, 200, JSON.stringify(other.body));
    // 版の知らせが届き、main が処理を終えるまで待つ（固定の待ちは使わない）。
    await noticed;
    await client.link.canvasIdle();
    assert.equal(
      client.requests.filter((line) => line === 'GET /v1/canvas').length,
      fetchesBefore,
    );
    assert.equal(client.canvasNotices.length, countBefore + 1);
    assert.equal(client.link.canvasView(), null);
    // ロック中の入力バーの発言は受け付けず、中枢へ送らない（本文を送らない）。
    const streamBefore = client.streamBodies.length;
    const locked = await client.link.handleOperationIpc(
      'desktop.turn_submit',
      {
        channel: 'desktop.turn_submit',
        request_id: randomUUID(),
        payload: { text: '今日の用事を見せて' },
      },
      senderFor(client.registry, 13, 'desktop.turn_submit'),
      { ...UNLOCKED, lockState: 'locked' },
    );
    assert.equal(field(locked.response, 'reason'), 'device_locked');
    assert.equal(client.streamBodies.length, streamBefore);

    // 解除したら、中枢から今の記述（版 2）を取り直して渡す。
    client.link.setLockState('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '2', 'rev 2');
    assert.equal(client.link.canvasView()?.canvas_revision, '2');
  },
);

test(
  'UI-03: an answer that arrives after the lock is not shown, and a message sent just before the lock is reported as unknown',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const gates: { path: string; release: () => void; reached: boolean }[] = [];
    let hold: string | null = null;
    const client = await startClient(t, hub, {
      holdResponse: (_method, path) => {
        if (path !== hold) return undefined;
        return new Promise<void>((resolve) => {
          gates.push({ path, release: resolve, reached: true });
        });
      },
    });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');

    // 発言を送った後、応答が届く前にロックする: 内容を画面へ返さず、結果不明にする（未送信と答えない）。
    hold = '/v1/stream/turns';
    const noticedOne = nextNotice(client, (revision) => revision === '1');
    const submitting = client.submit('今日の用事を見せて');
    await waitUntil(() => gates.length === 1, 'turn gate');
    client.link.setLockState('locked');
    // ロックの時点の通知の数（版の知らせが先に届いて、ロックの前に版 1 を渡していることもある）。ロックの後は何も増えない。
    const atLock = client.canvasNotices.length;
    hold = null;
    gates[0]?.release();
    const response = await submitting;
    assert.equal(response.outcome, 'rejected');
    assert.equal(field(response, 'reason'), 'outcome_unknown');
    // 中枢には届いている（記述は版 1 になった）が、ロック中なので画面へは何も渡さない。版の知らせの処理と、
    // 進行中の取得の完了まで待つ。
    await noticedOne;
    await client.link.canvasIdle();
    assert.equal((await client.coreCanvas()).canvas_revision, '1');
    assert.equal(client.link.canvasView(), null);
    assert.equal(client.canvasNotices.length, atLock);
    assert.equal(client.canvasNotices.at(-1)?.canvas ?? null, null);

    // 取得の応答がロックの後に届く: 反映しない。
    client.link.setLockState('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    hold = '/v1/canvas';
    gates.length = 0;
    // 別の端末が版 2 にする → 版の知らせ → 取得を始める。応答を保っている間にロックする。
    const other = await client.coreTurn('今日の予定を見せて');
    assert.equal(other.status, 200);
    await waitUntil(() => gates.length === 1, 'canvas gate');
    const shownBefore = client.canvasNotices.length;
    client.link.setLockState('locked');
    hold = null;
    gates[0]?.release();
    // 保っていた取得の処理（世代の照合で捨てる）が終わるまで待つ。
    await client.link.canvasIdle();
    // ロックで空を 1 回通知しただけ。保っていた版 2 の記述は渡していない。
    assert.equal(client.canvasNotices.length, shownBefore + 1);
    assert.deepEqual(client.canvasNotices.at(-1)?.canvas, null);
    assert.equal(client.link.canvasView(), null);
  },
);

test(
  'UI-03: a description that breaks the schema or the domain rules is dropped and the previous version stays',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    let corrupt: ((body: Record<string, unknown>) => unknown) | null = null;
    const client = await startClient(t, hub, {
      rewrite: (path, outcome) =>
        path === '/v1/canvas' &&
        corrupt !== null &&
        outcome.kind === 'response' &&
        outcome.status === 200
          ? {
              ...outcome,
              body: corrupt(
                structuredClone(outcome.body) as Record<string, unknown>,
              ),
            }
          : outcome,
    });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    await client.submit('今日の用事を見せて');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const kept = JSON.stringify(client.link.canvasView());
    const noticesBefore = client.canvasNotices.length;
    const itemOf = (body: Record<string, unknown>) =>
      (body['items'] as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >;

    // 中枢が版 2 として、契約か意味の検査に反する記述を返したとする。どれも渡さず、版 1 が残る。
    const corruptions: [string, (body: Record<string, unknown>) => unknown][] =
      [
        [
          'description field',
          (body) => {
            itemOf(body)['description'] = '今日の予定の一覧';
            return body;
          },
        ],
        [
          'markup in heading',
          (body) => {
            itemOf(body)['heading'] = '<img src=x onerror=1>';
            return body;
          },
        ],
        [
          'unknown component',
          (body) => {
            itemOf(body)['component'] = 'approval_button';
            return body;
          },
        ],
        [
          'reading order missing',
          (body) => {
            body['reading_order'] = [];
            return body;
          },
        ],
        [
          'grid overflow',
          (body) => {
            itemOf(body)['grid'] = { column: 10, span: 6, rows: 1 };
            return body;
          },
        ],
        ['not a document', () => ({ canvas_revision: '2' })],
      ];
    for (const [name, mutate] of corruptions) {
      corrupt = (body) => {
        body['canvas_revision'] = '2';
        return mutate(body);
      };
      // 基準の件数は操作の前に取る（操作の間に拒否が終わっても取り逃さない）。
      const rejections = client.logs.filter(
        (code) => code === 'canvas_document_rejected',
      ).length;
      const turn = await client.coreTurn('今日の予定を見せて');
      assert.equal(turn.status, 200, name);
      // 版の知らせが届いて取得が走り、拒否のログが出るまで待つ。
      await waitUntil(
        () =>
          client.logs.filter((code) => code === 'canvas_document_rejected')
            .length > rejections,
        `rejected: ${name}`,
      );
      assert.equal(JSON.stringify(client.link.canvasView()), kept, name);
      assert.equal(client.canvasNotices.length, noticesBefore, name);
      // 版が 1 つずつ進むので、次の組み合わせのために中枢の版（本物）を数える必要はない（書き換えは版を 2 に固定する）。
    }
    // 壊れた書き換えをやめると、次の知らせで本物の記述（中枢の今の版）を受け取る。
    corrupt = null;
    const real = await client.coreCanvas();
    assert(Number(real.canvas_revision) > 2);
    await client.coreTurn('今日の予定を見せて');
    await waitUntil(
      () =>
        Number(latest(client)?.canvas_revision ?? '0') >
        Number(real.canvas_revision),
      'recovered',
    );
    assert(client.canvasNotices.length > noticesBefore);
  },
);

test(
  'UI-03: the canvas window cannot use the approval, stop, resume, summon or message channels; the input bar can only send messages',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    const requestsBefore = client.requests.length;

    // キャンバス（webContents 11）は、状態の取得のほかのチャネルをすべて拒否される（untrusted_sender）。
    // 承認・取消・再試行・照合・承認表示の準備・発言・接続・登録・端末の管理・自宅の登録が対象で、中枢へは何も送らない。
    const refs = { ref: randomUUID() };
    // 形式（Schema）に合う本文（形式の検査は受付より先なので、合わない本文だと invalid_request になってしまう）。
    const payloads: Record<string, unknown> = {
      'desktop.turn_submit': { text: '今日の用事を見せて' },
      'desktop.operation_preview': refs,
      'desktop.operation_approve': refs,
      'desktop.operation_cancel': refs,
      'desktop.operation_reconcile': refs,
      'desktop.operation_retry': refs,
      'desktop.operation_check': refs,
      'desktop.pairing_begin': { host: '100.64.0.10', port: 47823 },
      'desktop.pairing_confirm': {
        fingerprint: 'a'.repeat(64),
        fingerprint_tail: 'aaaa',
      },
      'desktop.pairing_submit': {
        pairing_code: '12345678',
        device_name: '合成の端末',
      },
      'desktop.claim_decide': { ref: randomUUID(), decision: 'approve' },
      'desktop.device_revoke': refs,
      'desktop.home_register': { ref: randomUUID(), include_ssid: false },
    };
    const linkChannels = [
      ...OPERATION_CHANNELS,
      ...ADMIN_CHANNELS,
      ...CONNECTION_CHANNELS,
    ] as string[];
    for (const channel of linkChannels) {
      const response = await client.ipc(11, channel, payloads[channel] ?? null);
      assert.equal(response.outcome, 'rejected', channel);
      assert.equal(field(response, 'reason'), 'untrusted_sender', channel);
    }
    // 停止・再開・窓を閉じる・終了・キャンバスを前に出す（main の端末の制御が受け持つ）も、役割の表で使えない。
    for (const channel of [
      'desktop.io_stop',
      'desktop.io_resume',
      'desktop.window_hide',
      'desktop.client_quit',
      'desktop.canvas_summon',
    ])
      assert.equal(
        desktopChannelAllowedForRole('canvas', channel),
        false,
        channel,
      );
    // キャンバスが使えるのは状態の取得と、物のユーザーの操作（UI-06）・物の中身の読み取り（UI-07）だけ（すべてのチャネルのうちの 3 つ）。
    assert.deepEqual(
      DESKTOP_IPC_CHANNELS.filter((channel) =>
        desktopChannelAllowedForRole('canvas', channel),
      ),
      ['desktop.get_state', 'desktop.canvas_user_op', 'desktop.canvas_content'],
    );
    assert.equal(client.requests.length, requestsBefore);

    // 状態の層（12）は発言を送れない。入力バー（13）は発言だけで、承認も停止もできない。
    assert.equal(
      field(
        await client.ipc(12, 'desktop.turn_submit', { text: 'a' }),
        'reason',
      ),
      'untrusted_sender',
    );
    for (const channel of [
      'desktop.operation_approve',
      'desktop.operation_cancel',
      'desktop.operation_retry',
    ])
      assert.equal(
        field(await client.ipc(13, channel, refs), 'reason'),
        'untrusted_sender',
        channel,
      );
    assert.equal(client.requests.length, requestsBefore);
    // 知らない窓（対応表にない webContents）と閉じた窓も拒否される。
    assert.equal(
      field(
        await client.ipc(99, 'desktop.turn_submit', { text: 'a' }),
        'reason',
      ),
      'untrusted_sender',
    );
    client.registry.unregister(13);
    assert.equal(
      field(
        await client.ipc(13, 'desktop.turn_submit', { text: 'a' }),
        'reason',
      ),
      'untrusted_sender',
    );
    assert.equal(client.requests.length, requestsBefore);
    // 役割の窓が使える発言は、対応表の入力バーだけ（作り直した窓の新しい ID だけを受け付ける）。
    client.registry.register(14, 'input', 'input');
    const resent = await client.ipc(14, 'desktop.turn_submit', {
      text: '今日の用事を見せて',
    });
    assert.equal(resent.outcome, 'ok');
    const roles: UiWindowRole[] = client.registry
      .entries()
      .map((entry) => entry.role);
    assert.deepEqual(roles.sort(), ['canvas', 'input', 'status']);
  },
);

test(
  'UI-03: stopping input (or a new io_epoch) discards the canvas and the refs, nothing is fetched while stopped, and resuming restores it',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const io = { state: { ...UNLOCKED } as DesktopIoState };
    const client = await startClient(t, hub, { io });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    await client.submit('今日の用事を見せて');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const noticesBefore = client.canvasNotices.length;
    const fetchCount = () =>
      client.requests.filter((line) => line === 'GET /v1/canvas').length;

    // 停止（トレイ・画面のどれでも io_epoch が進む）: 記述と参照を捨てて、空を通知する。ロック状態は変わらない。
    io.state = { lockState: 'unlocked', stopScope: 'local', ioEpoch: '1' };
    client.link.ioStateChanged();
    assert.equal(client.link.canvasView(), null);
    assert.equal(client.canvasNotices.length, noticesBefore + 1);
    assert.deepEqual(client.canvasNotices.at(-1), {
      channel: 'desktop.canvas_changed',
      canvas: null,
    });

    // 停止中に中枢のキャンバスが変わる。版の知らせは届くが、取りに行かない。
    const fetches = fetchCount();
    const noticed = nextNotice(client, (revision) => revision === '2');
    assert.equal((await client.coreTurn('今日の予定を見せて')).status, 200);
    await noticed;
    await client.link.canvasIdle();
    assert.equal(fetchCount(), fetches);
    assert.equal(client.link.canvasView(), null);
    assert.equal(client.canvasNotices.length, noticesBefore + 1);

    // 再開（停止の世代のまま）: 中枢から取り直して渡す。
    io.state = { lockState: 'unlocked', stopScope: 'none', ioEpoch: '1' };
    client.link.ioStateChanged();
    await waitUntil(() => latest(client)?.canvas_revision === '2', 'rev 2');
    assert.equal(client.link.canvasView()?.canvas_revision, '2');

    // 世代だけが進んだ（停止と再開の通知を main が 1 つにまとめて受けた）: 捨てて、取り直す。
    const count = client.canvasNotices.length;
    io.state = { lockState: 'unlocked', stopScope: 'none', ioEpoch: '3' };
    client.link.ioStateChanged();
    assert.equal(client.canvasNotices.at(count)?.canvas ?? null, null);
    await waitUntil(
      () => client.link.canvasView()?.canvas_revision === '2',
      'restored after epoch change',
    );
  },
);

test(
  'UI-03: an answer that arrives after input was stopped is not shown',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const io = { state: { ...UNLOCKED } as DesktopIoState };
    const gates: (() => void)[] = [];
    let hold = false;
    const client = await startClient(t, hub, {
      io,
      holdResponse: (_method, path) =>
        hold && path === '/v1/canvas'
          ? new Promise<void>((resolve) => gates.push(resolve))
          : undefined,
    });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    // 取得の応答を保っている間に停止する。
    hold = true;
    const noticed = nextNotice(client, (revision) => revision === '1');
    assert.equal((await client.coreTurn('今日の用事を見せて')).status, 200);
    await noticed;
    await waitUntil(() => gates.length === 1, 'canvas gate');
    const atStop = client.canvasNotices.length;
    io.state = { lockState: 'unlocked', stopScope: 'local', ioEpoch: '1' };
    client.link.ioStateChanged();
    hold = false;
    gates[0]?.();
    await client.link.canvasIdle();
    // 停止の通知（空）のあとに、保っていた版 1 の記述は渡していない。
    assert.equal(client.canvasNotices.at(-1)?.canvas ?? null, null);
    assert(
      client.canvasNotices
        .slice(atStop)
        .every((notice) => notice.canvas === null),
    );
    assert.equal(client.link.canvasView(), null);
    // 発言も停止中は送らない。
    const before = client.streamBodies.length;
    const refused = await client.link.handleOperationIpc(
      'desktop.turn_submit',
      {
        channel: 'desktop.turn_submit',
        request_id: randomUUID(),
        payload: { text: '今日の用事を見せて' },
      },
      senderFor(client.registry, 13, 'desktop.turn_submit'),
      io.state,
    );
    assert.equal(field(refused.response, 'reason'), 'input_stopped');
    assert.equal(client.streamBodies.length, before);
  },
);

test(
  'UI-03: a canvas window that missed the first notice gets the description again when it asks for its state',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    await client.submit('今日の用事を見せて');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    // 読み込み直した窓は、通知が購読より先に来て取り逃した（何も受け取っていない）。購読を始めて状態を取ると、
    // main は今の記述を送り直す。
    const missed = client.canvasNotices.length;
    assert.equal(canvasResendAfter('canvas', 'desktop.get_state'), true);
    client.link.canvasSubscribed();
    assert.equal(client.canvasNotices.length, missed + 1);
    const again = client.canvasNotices.at(-1)?.canvas as DesktopCanvasView;
    assert.deepEqual(again, latest(client));
    assert.equal(again.canvas_revision, '1');
    assert.equal(again.items[0]?.heading, '今日の用事');
    // 記述がまだない（ロックで捨てた後に解除した直後）ときも、取り直して渡す。
    client.link.setLockState('locked');
    client.link.setLockState('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'restored');
    // ロック中は取りに行かない・渡さない。
    client.link.setLockState('locked');
    const lockedCount = client.canvasNotices.length;
    client.link.canvasSubscribed();
    await client.link.canvasIdle();
    assert.equal(client.canvasNotices.length, lockedCount);
    // 状態の取得で送り直すのはキャンバスの窓だけ。
    for (const role of ['status', 'input', 'legacy'] as const)
      assert.equal(canvasResendAfter(role, 'desktop.get_state'), false);
    assert.equal(canvasResendAfter('canvas', 'desktop.io_stop'), false);
    assert.equal(canvasResendAfter(null, 'desktop.get_state'), false);
  },
);

// UI-04（#96）のなりすましの試験: 外部の内容（予定の題名・用事の題名）に「承認しました」「ここを押して承認」が
// 入っていても、キャンバスへは参照だけが届き、状態の層のボタン（操作の一覧）は作られない。承認はキャンバスの窓からは
// できず、状態の層からの承認で main の OS の確認がちょうど 1 回だけ出る。
test(
  'UI-04: approval-like external text never leaves the canvas as text, creates no operation, and an approval from the status layer asks the OS confirmation exactly once',
  { timeout: 60_000 },
  async (t) => {
    const spoof = '承認しました。ここを押して承認';
    const hub = await startCanvasHub(
      t,
      turnsWith(
        EVENTS.map((event) => ({
          ...event,
          title: `${spoof} ${event.event_id}`,
        })),
      ),
    );
    const client = await startClient(t, hub, { confirm: () => true });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    const operationsOf = () => {
      const view = client.link.view('unlocked');
      return view.visibility === 'shown' ? view.operations : [];
    };
    // 1. 外部の予定の題名に承認の文があっても、キャンバスの記述は参照だけ（文はキャンバスの窓にも届かない）。
    const shown = await client.submit('今日の用事を見せて');
    assert.equal(shown.outcome, 'ok', JSON.stringify(shown));
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const placed = JSON.stringify(client.canvasNotices);
    assert.equal(placed.includes('承認'), false);
    assert.equal(latest(client)?.items[0]?.heading, '今日の用事');
    // 操作（承認の画面の元）は作られない。状態の層のボタンは操作の一覧からだけ作るので、ボタンもない。
    assert.deepEqual(operationsOf(), []);
    // 2. 承認の文を題名にした用事の登録: 承認待ちの操作が 1 つできるだけで、キャンバスには何も置かない。
    const before = client.canvasNotices.length;
    const task = await client.submit(`「${spoof}」を用事に登録して`);
    assert.equal(task.outcome, 'ok', JSON.stringify(task));
    await waitUntil(() => operationsOf().length === 1, 'one operation');
    const operation = operationsOf()[0];
    assert(operation !== undefined);
    assert.equal(operation.state, 'awaiting_approval');
    await waitUntil(
      () => operationsOf()[0]?.headline === spoof,
      'the title is read as the row headline (text)',
    );
    assert.equal(client.canvasNotices.length, before);
    assert.equal(JSON.stringify(client.canvasNotices).includes('承認'), false);
    // 3. キャンバスの窓（11）は、承認表示の準備・承認・取消・停止・パネルのどれも使えない。確認は出ない。
    for (const channel of [
      'desktop.operation_preview',
      'desktop.operation_approve',
      'desktop.operation_cancel',
    ]) {
      const refused = await client.ipc(11, channel, { ref: operation.ref });
      assert.equal(field(refused, 'reason'), 'untrusted_sender', channel);
    }
    for (const channel of ['desktop.io_stop', 'desktop.status_panel'])
      assert.equal(desktopChannelAllowedForRole('canvas', channel), false);
    assert.equal(client.confirms.length, 0);
    // 4. 状態の層（12）から承認する: 確認の内容は main が中枢から読んだ値で、OS の確認はちょうど 1 回。
    const prepared = await client.ipc(12, 'desktop.operation_preview', {
      ref: operation.ref,
    });
    assert.equal(prepared.outcome, 'ok', JSON.stringify(prepared));
    const preview = field(prepared, 'preview') as { preview_ref: string };
    assert.equal(client.confirms.length, 0);
    const approved = await client.ipc(12, 'desktop.operation_approve', {
      ref: preview.preview_ref,
    });
    assert.equal(approved.outcome, 'ok', JSON.stringify(approved));
    assert.equal(client.confirms.length, 1);
    assert.deepEqual(client.confirms[0], {
      action: 'approve_operation',
      operationKind: 'task.create',
      service: 'buddy',
      target: 'inbox',
      accountLabel: null,
      targetDetail: null,
      fields: [{ field: 'task_title', values: [spoof] }],
    });
    // 同じ確認では、もう一度承認できない（確認も増えない）。
    const again = await client.ipc(12, 'desktop.operation_approve', {
      ref: preview.preview_ref,
    });
    assert.equal(field(again, 'reason'), 'entry_not_found');
    assert.equal(client.confirms.length, 1);
    assert.equal(
      client.requests.filter((line) => line.endsWith('/approve')).length,
      1,
    );
  },
);

// UI-06（#98）: キャンバスの物のユーザーの操作。キャンバスの窓（11）から main を通して中枢へ記録し、中枢が記述に当てて
// 版を進め、キャンバスの窓へ新しい記述が届く。期待値（版・マス・置き場所・読む順）は手で書いた。
const userOp = (
  client: Client,
  expected: string,
  op: Record<string, unknown>,
  webContentsId = 11,
) =>
  client.ipc(webContentsId, 'desktop.canvas_user_op', {
    expected_canvas_revision: expected,
    op,
  });

const MOVED = { column: 7, row: 2, span: 4, rows: 3 };

test(
  'UI-06: the user moves, shelves, takes back and closes the card from the canvas window; the core records it and the next placement uses it',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');

    // 動かす: 中枢がユーザーの置き場所として持ち、版 2 の記述がキャンバスの窓に届く。
    const moved = await userOp(client, '1', {
      kind: 'move',
      item_id: 'errands',
      cell: MOVED,
    });
    assert.equal(moved.outcome, 'ok', JSON.stringify(moved));
    assert.equal(field(moved, 'canvas_revision'), '2');
    await waitUntil(() => latest(client)?.canvas_revision === '2', 'rev 2');
    assert.deepEqual(latest(client)?.user_pins, [
      { item_id: 'errands', cell: MOVED },
    ]);
    const core = await client.coreCanvas();
    assert.deepEqual(core.user_pins, [{ item_id: 'errands', cell: MOVED }]);
    // 格子のヒント（AI の意味）は変えない。
    assert.deepEqual(core.items[0]?.grid, { column: 2, span: 4, rows: 3 });
    assert(client.requests.includes('POST /v1/canvas/user-ops'));

    // 状態の層（12）と入力バー（13）は物を動かせない（中枢へ何も送らない）。
    const sentBefore = client.requests.length;
    for (const id of [12, 13]) {
      const refused = await userOp(
        client,
        '2',
        { kind: 'close', item_id: 'errands' },
        id,
      );
      assert.equal(field(refused, 'reason'), 'untrusted_sender', String(id));
    }
    assert.equal(client.requests.length, sentBefore);

    // 棚へ片付ける: 棚の物になり、読む順とユーザーの置き場所から外れる。
    assert.equal(
      field(
        await userOp(client, '2', { kind: 'shelve', item_id: 'errands' }),
        'canvas_revision',
      ),
      '3',
    );
    await waitUntil(() => latest(client)?.canvas_revision === '3', 'rev 3');
    assert.equal(latest(client)?.items[0]?.placement, 'shelf');
    assert.deepEqual(latest(client)?.reading_order, []);
    assert.deepEqual(latest(client)?.user_pins, []);
    // 棚から出す: 見える物に戻り、読む順の最後に入る。
    assert.equal(
      field(
        await userOp(client, '3', { kind: 'unshelve', item_id: 'errands' }),
        'canvas_revision',
      ),
      '4',
    );
    await waitUntil(() => latest(client)?.canvas_revision === '4', 'rev 4');
    assert.equal(latest(client)?.items[0]?.placement, 'canvas');
    assert.deepEqual(latest(client)?.reading_order, ['errands']);
    // 閉じる。
    assert.equal(
      field(
        await userOp(client, '4', { kind: 'close', item_id: 'errands' }),
        'canvas_revision',
      ),
      '5',
    );
    await waitUntil(() => latest(client)?.canvas_revision === '5', 'rev 5');
    assert.deepEqual(latest(client)?.items, []);

    // もう一度頼むと、配置者は記録（最後に動かしたマスの列・幅・行数）を格子のヒントにして置き直す（AI が優先）。
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '6', 'rev 6');
    assert.deepEqual(latest(client)?.items[0]?.grid, {
      column: 7,
      span: 4,
      rows: 3,
    });
    assert.deepEqual(latest(client)?.reading_order, ['errands']);
  },
);

test(
  'UI-06: an operation on an old revision is applied when the item did not move since, and refused (canvas_conflict) when it moved, is gone or the revision is ahead',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    // AI の 2 回目の答えは中身だけの update（置き場所は変えない）: 版 2。
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '2', 'rev 2');

    // 版 1 を見ていた本人の操作: その物の置き場所は版 1 から変わっていないので当てる（版 3）。
    const old = await userOp(client, '1', {
      kind: 'move',
      item_id: 'errands',
      cell: MOVED,
    });
    assert.equal(old.outcome, 'ok', JSON.stringify(old));
    assert.equal(field(old, 'canvas_revision'), '3');
    await waitUntil(() => latest(client)?.canvas_revision === '3', 'rev 3');

    // 版 2 を見ていた操作: その物は版 3 で動いたので捨てる（記述は版 3 のまま）。
    const stale = await userOp(client, '2', {
      kind: 'resize',
      item_id: 'errands',
      cell: { ...MOVED, span: 2 },
    });
    assert.equal(field(stale, 'reason'), 'canvas_conflict');
    const after = await client.coreCanvas();
    assert.equal(after.canvas_revision, '3');
    assert.deepEqual(after.user_pins, [{ item_id: 'errands', cell: MOVED }]);
    // ない物（AI が閉じた・別の名前）も捨てる。
    const ghost = await userOp(client, '3', {
      kind: 'close',
      item_id: 'ghost',
    });
    assert.equal(field(ghost, 'reason'), 'canvas_conflict');
    // 画面に渡していない版（今より新しい）は中枢へ送らない。
    const sentBefore = client.requests.length;
    const ahead = await userOp(client, '9', {
      kind: 'close',
      item_id: 'errands',
    });
    assert.equal(field(ahead, 'reason'), 'canvas_conflict');
    assert.equal(client.requests.length, sentBefore);
    assert.equal((await client.coreCanvas()).canvas_revision, '3');
  },
);

test(
  'UI-06: a canvas operation is refused when the canvas is not in front, while stopped or locked; an answer after the lock is unknown',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const front = { value: true };
    const io: { state: DesktopIoState } = { state: UNLOCKED };
    let hold = false;
    const gates: (() => void)[] = [];
    const client = await startClient(t, hub, {
      front,
      io,
      holdResponse: (_method, path) =>
        hold && path === '/v1/canvas/user-ops'
          ? new Promise<void>((resolve) => gates.push(resolve))
          : undefined,
    });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const sentBefore = client.requests.length;
    const close = { kind: 'close', item_id: 'errands' };

    // 後ろにある（前に出ていない）キャンバスは操作を受けない。
    front.value = false;
    assert.equal(
      field(await userOp(client, '1', close), 'reason'),
      'screen_operation_required',
    );
    front.value = true;
    // 入出力の停止中は受けない。
    io.state = { lockState: 'unlocked', stopScope: 'local', ioEpoch: '1' };
    assert.equal(
      field(await userOp(client, '1', close), 'reason'),
      'input_stopped',
    );
    io.state = UNLOCKED;
    // ロック中・不明は受けない。
    for (const lockState of ['locked', 'unknown'] as const) {
      const raw = {
        channel: 'desktop.canvas_user_op',
        request_id: randomUUID(),
        payload: { expected_canvas_revision: '1', op: close },
      };
      const refused = await client.link.handleCanvasIpc(
        'desktop.canvas_user_op',
        raw,
        senderFor(client.registry, 11, 'desktop.canvas_user_op'),
        { ...UNLOCKED, lockState },
      );
      assert.equal(field(refused.response, 'reason'), 'device_locked');
    }
    assert.equal(client.requests.length, sentBefore);

    // 送った後、応答が届く前にロックした: 結果不明（自動では送り直さない）。中枢には当たっている。
    hold = true;
    const pending = userOp(client, '1', close);
    await waitUntil(() => gates.length === 1, 'user-op gate');
    client.link.setLockState('locked');
    hold = false;
    gates[0]?.();
    const unknown = await pending;
    assert.equal(field(unknown, 'reason'), 'outcome_unknown');
    assert.equal(
      client.requests.filter((line) => line === 'POST /v1/canvas/user-ops')
        .length,
      1,
    );
    assert.equal((await client.coreCanvas()).canvas_revision, '2');
    // ロックで記述を捨てた（キャンバスの窓へ空を通知した）。
    assert.equal(client.link.canvasView(), null);
    assert.equal(client.canvasNotices.at(-1)?.canvas ?? null, null);
  },
);

// 端末のディレクトリの中のファイルをすべて読む。
function filesUnder(dir: string): { path: string; bytes: Buffer }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? filesUnder(path)
      : [{ path, bytes: readFileSync(path) }];
  });
}

test(
  'UI-06: nothing of the canvas content stays on the device; only the display setting is stored, and a setting carrying content is refused',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    assert.equal(
      (
        await userOp(client, '1', {
          kind: 'move',
          item_id: 'errands',
          cell: MOVED,
        })
      ).outcome,
      'ok',
    );
    await waitUntil(() => latest(client)?.canvas_revision === '2', 'rev 2');
    // 端末に保存してよい配置の設定（複数のモニターの設定）。本文・置き場所を含む設定は書かない。
    const valid = (value: unknown) =>
      contract.valid('DesktopCanvasDisplaySettings', value);
    const settingsPath = join(client.dir, CANVAS_DISPLAY_FILE);
    assert.equal(
      saveCanvasDisplaySettings(
        settingsPath,
        { schema_version: 1, target: 'display', display_id: 2 },
        valid,
      ),
      true,
    );
    assert.equal(
      saveCanvasDisplaySettings(
        join(client.dir, 'carrying-content.json'),
        {
          schema_version: 1,
          target: 'primary',
          heading: '今日の用事',
        } as never,
        valid,
      ),
      false,
    );
    assert.equal(
      readFileSync(settingsPath, 'utf8'),
      '{"schema_version":1,"target":"display","display_id":2}\n',
    );
    // 端末のディレクトリのどのファイルにも、見出し・物の名前・中枢の予定の識別子・置き場所が残っていない。
    const core = await client.coreCanvas();
    const ids = core.items.flatMap((entry) =>
      entry.data.item_refs.map((refEntry) => refEntry.id),
    );
    assert(ids.length > 0);
    const files = filesUnder(client.dir);
    assert.deepEqual(
      files.map((file) => file.path.slice(client.dir.length + 1)).sort(),
      [CANVAS_DISPLAY_FILE, 'device-credential.bin'],
    );
    for (const file of files)
      for (const needle of [
        '今日の用事',
        'errands',
        'user_pins',
        '"column":7',
        ...ids,
      ])
        assert.equal(
          file.bytes.includes(Buffer.from(needle, 'utf8')),
          false,
          `${file.path} ${needle}`,
        );
  },
);

// UI-07（#99）: 物の中身（本文）。キャンバスの窓（11）が main に求め、main が中枢から許可範囲内で取って返す。期待値（件数・題名・
// 拒否の理由）は手で書いた（中枢の模擬の中身は apps/core/src/canvas-content.ts の合成データ）。
const contentOp = (
  client: Client,
  expected: string,
  itemId: string,
  openRef: string | null = null,
  webContentsId = 11,
) =>
  client.ipc(webContentsId, 'desktop.canvas_content', {
    item_id: itemId,
    expected_canvas_revision: expected,
    open_ref: openRef,
  });

const CONTENT_TITLES = [
  '歯医者の予約を入れる',
  '書類を郵送する',
  '電球を買う',
  '週のメモを整える',
];

test(
  'UI-07: the canvas window gets the content of its card through main, also while it is in the background; the body reaches no other window, no notification and no log',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const front = { value: false };
    const client = await startClient(t, hub, { front });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const contentRequests = () =>
      client.requests.filter((line) => line === 'POST /v1/canvas/content');
    assert.equal(contentRequests().length, 0);

    // 後ろにある間（前に出ていない）も、描いている物の中身を取れる。
    const ok = await contentOp(client, '1', 'errands');
    assert.equal(ok.outcome, 'ok', JSON.stringify(ok));
    assert.equal(field(ok, 'canvas_revision'), '1');
    assert.equal(field(ok, 'item_id'), 'errands');
    assert.equal(field(ok, 'open_index'), null);
    assert(contract.valid('DesktopIpcResponse', ok));
    const content = field(ok, 'content') as {
      component: string;
      rows: { title: string; state: string }[];
    };
    assert.equal(content.component, 'list');
    assert.deepEqual(
      content.rows.map((row) => row.title),
      CONTENT_TITLES,
    );
    assert.equal(contentRequests().length, 1);

    // 中枢の識別子（予定の参照）も、画面の参照（ref）も、本文には入らない。
    const core = await client.coreCanvas();
    const realIds = core.items[0]?.data.item_refs.map((ref) => ref.id) ?? [];
    assert.equal(realIds.length, 4);
    const body = JSON.stringify(ok);
    for (const real of realIds) assert(!body.includes(real), real);
    for (const ref of latest(client)?.items[0]?.data.item_refs ?? [])
      assert(!body.includes(ref.ref), ref.ref);

    // 状態の層（12）・入力バー（13）は、本文を求められない（役割の表）。中枢へも送らない。
    for (const id of [12, 13]) {
      const refused = await contentOp(client, '1', 'errands', null, id);
      assert.equal(refused.outcome, 'rejected', String(id));
      assert.equal(field(refused, 'reason'), 'untrusted_sender', String(id));
      assert(!JSON.stringify(refused).includes('歯医者'));
    }
    assert.equal(contentRequests().length, 1);

    // 本文は通知（キャンバスの窓へ渡す記述）にもログにも載らない。
    for (const needle of ['歯医者', '書類を郵送', '電球']) {
      assert(!JSON.stringify(client.canvasNotices).includes(needle), needle);
      assert(!client.logs.join('\n').includes(needle), needle);
    }

    // 版が違う・物がない: canvas_conflict（本文は返さない）。古い版・新しい版のどちらも中枢へは送らない。
    for (const [label, expected, item] of [
      ['stale', '0', 'errands'],
      ['newer', '2', 'errands'],
      ['missing', '1', 'ghost'],
    ] as const) {
      const refused = await contentOp(client, expected, item);
      assert.equal(refused.outcome, 'rejected', label);
      assert.equal(field(refused, 'reason'), 'canvas_conflict', label);
    }
    assert.equal(contentRequests().length, 1);

    // メールの本文を開くのは本人の操作なので、前に出ていないと拒否される（中枢へ送らない）。前に出ていても、
    // 画面に渡した参照でなければ canvas_conflict。
    const open = randomUUID();
    const background = await contentOp(client, '1', 'errands', open);
    assert.equal(field(background, 'reason'), 'screen_operation_required');
    front.value = true;
    const unknownRef = await contentOp(client, '1', 'errands', open);
    assert.equal(field(unknownRef, 'reason'), 'canvas_conflict');
    // 本文を開けないのはメール以外の物（用事の list の参照でも開けない）。
    const listRef = latest(client)?.items[0]?.data.item_refs[0]?.ref ?? '';
    const notMail = await contentOp(client, '1', 'errands', listRef);
    assert.equal(field(notMail, 'reason'), 'canvas_conflict');
    assert.equal(contentRequests().length, 1);
  },
);

test(
  'UI-07: no content while locked, stopped or after the lock; an answer that arrives after the lock is not shown; nothing of the body stays on the device',
  { timeout: 60_000 },
  async (t) => {
    const gates: (() => void)[] = [];
    let hold = false;
    const io = { state: UNLOCKED };
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub, {
      io,
      holdResponse: (method, path) => {
        if (!hold || method !== 'POST' || path !== '/v1/canvas/content')
          return undefined;
        return new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const sentContent = () =>
      client.requests.filter((line) => line === 'POST /v1/canvas/content')
        .length;

    // 入出力の停止中は取らない（本文を渡さない）。
    io.state = { lockState: 'unlocked', stopScope: 'local', ioEpoch: '0' };
    const stopped = await contentOp(client, '1', 'errands');
    assert.equal(field(stopped, 'reason'), 'input_stopped');
    assert.equal(sentContent(), 0);
    io.state = UNLOCKED;

    // ふつうに取れる。端末のディレクトリには何も残らない（端末トークンの保存だけ）。
    const ok = await contentOp(client, '1', 'errands');
    assert.equal(ok.outcome, 'ok');
    assert.equal(sentContent(), 1);
    const core = await client.coreCanvas();
    const ids = core.items.flatMap((entry) =>
      entry.data.item_refs.map((refEntry) => refEntry.id),
    );
    const files = filesUnder(client.dir);
    assert.deepEqual(
      files.map((file) => file.path.slice(client.dir.length + 1)).sort(),
      ['device-credential.bin'],
    );
    for (const file of files)
      for (const needle of [...CONTENT_TITLES, '今日の用事', 'errands', ...ids])
        assert.equal(
          file.bytes.includes(Buffer.from(needle, 'utf8')),
          false,
          `${file.path} ${needle}`,
        );

    // 中枢の答えを保っている間にロックすると、答えが届いても本文を返さない。
    hold = true;
    const pending = contentOp(client, '1', 'errands');
    await waitUntil(() => gates.length === 1, 'content gate');
    client.link.setLockState('locked');
    hold = false;
    gates[0]?.();
    const dropped = await pending;
    assert.equal(dropped.outcome, 'rejected');
    assert.equal(field(dropped, 'reason'), 'device_locked');
    assert(!JSON.stringify(dropped).includes('歯医者'));

    // ロック中は求められない（中枢へも送らない）。記述も捨てた。
    const before = sentContent();
    const locked = await client.ipc(11, 'desktop.canvas_content', {
      item_id: 'errands',
      expected_canvas_revision: '1',
      open_ref: null,
    });
    assert.equal(locked.outcome, 'rejected');
    assert.equal(sentContent(), before);
    assert.equal(client.link.canvasView(), null);
  },
);

test(
  'UI-07 (review): moving the card keeps the opaque refs (so the screen keeps its content); hiding the canvas window drops the description, the refs and an answer on the way, and showing it again fetches a fresh one',
  { timeout: 60_000 },
  async (t) => {
    const gates: (() => void)[] = [];
    let hold = false;
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub, {
      holdResponse: (method, path) => {
        if (!hold || method !== 'POST' || path !== '/v1/canvas/content')
          return undefined;
        return new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const refsNow = () =>
      latest(client)?.items[0]?.data.item_refs.map((entry) => entry.ref) ?? [];
    const first = refsNow();
    assert.equal(first.length, 4);
    // 配置だけが変わる（動かす）。版は 2 に進むが、物のデータは同じなので、参照も同じ。
    assert.equal(
      (
        await userOp(client, '1', {
          kind: 'move',
          item_id: 'errands',
          cell: MOVED,
        })
      ).outcome,
      'ok',
    );
    await waitUntil(() => latest(client)?.canvas_revision === '2', 'rev 2');
    assert.deepEqual(refsNow(), first);
    // 本文を取っている途中で、窓そのものが隠れた: 記述と参照を捨て、画面へ空を通知し、答えが届いても本文を返さない。
    hold = true;
    const pending = contentOp(client, '2', 'errands');
    await waitUntil(() => gates.length === 1, 'content gate');
    client.link.canvasHidden();
    hold = false;
    gates[0]?.();
    const dropped = await pending;
    assert.equal(dropped.outcome, 'rejected');
    assert(!JSON.stringify(dropped).includes('歯医者'));
    assert.equal(client.link.canvasView(), null);
    assert.equal(client.canvasNotices.at(-1)?.canvas ?? null, null);
    // 隠れている間は求められない（記述がない）。
    const hidden = await contentOp(client, '2', 'errands');
    assert.equal(field(hidden, 'reason'), 'canvas_conflict');
    // 表示し直したら、今の記述を取り直して送る。参照は作り直す（世代が進んだ）。
    client.link.canvasShown();
    await waitUntil(
      () => latest(client)?.canvas_revision === '2',
      'shown again',
    );
    const again = refsNow();
    assert.equal(again.length, 4);
    for (const ref of first) assert(!again.includes(ref));
    const ok = await contentOp(client, '2', 'errands');
    assert.equal(ok.outcome, 'ok');
  },
);

test(
  'UI-07 (review 2): while the canvas window is hidden nothing is fetched or sent again (revision notices, lock and unlock), and showing it fetches the current description',
  { timeout: 60_000 },
  async (t) => {
    const hub = await startCanvasHub(t);
    const client = await startClient(t, hub);
    client.link.start('unlocked');
    await waitUntil(() => latest(client)?.canvas_revision === '0', 'empty');
    assert.equal((await client.submit('今日の用事を見せて')).outcome, 'ok');
    await waitUntil(() => latest(client)?.canvas_revision === '1', 'rev 1');
    const canvasGets = () =>
      client.requests.filter((line) => line === 'GET /v1/canvas').length;
    client.link.canvasHidden();
    assert.equal(client.link.canvasView(), null);
    assert.equal(client.canvasNotices.at(-1)?.canvas ?? null, null);
    const noticesBefore = client.canvasNotices.length;
    const gets = canvasGets();
    // 隠れている間に中枢の版が進む（版の知らせが届く）。main は取りに行かない。
    const notice = nextNotice(client, (revision) => revision === '2');
    assert.equal((await client.coreTurn('今日の予定を見せて')).status, 200);
    await notice;
    await client.link.canvasIdle();
    assert.equal(canvasGets(), gets);
    // ロックして解除しても取らない。
    client.link.setLockState('locked');
    client.link.setLockState('unlocked');
    await client.link.canvasIdle();
    assert.equal(canvasGets(), gets);
    assert.equal(client.link.canvasView(), null);
    // 通知を受け取る準備の合図（読み込み直し）でも送り直さない。
    client.link.canvasSubscribed();
    await client.link.canvasIdle();
    assert.equal(canvasGets(), gets);
    assert.equal(client.canvasNotices.length, noticesBefore);
    // 本文も取れない。
    const hidden = await contentOp(client, '2', 'errands');
    assert.equal(hidden.outcome, 'rejected');
    // 表示し直したら、今の記述（版 2）を取り直して送る。
    client.link.canvasShown();
    await waitUntil(
      () => latest(client)?.canvas_revision === '2',
      'shown again',
    );
    assert.equal(canvasGets(), gets + 1);
    assert.equal((await contentOp(client, '2', 'errands')).outcome, 'ok');
  },
);
