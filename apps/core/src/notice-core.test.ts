// 製品の Core（startCore、HTTPS は 127.0.0.1・鍵は模擬）での知らせの運搬（UI-05 の段階 3、ADR 0187、U40・U168）。
// - 期限切れ: 流れへの発言で置いた用事のカードは、その発言が期限切れで消えると Core が閉じて版を進め、開いている購読へ
//   版の知らせ（canvas）と知らせ（notice）が届く。ロック中の購読にも届く。閉じた購読・後から開いた購読には送らない（再送しない）。
// - 自宅の外: 確かめ直しで閉じた購読には送らず、自宅に戻って開き直した購読は次の知らせから受け取る。
// - 端末へ送る知らせから元サービスの生の ID（source_item）を除き、除いて空なら送らない。本文・HMAC を含めない。
// 忘却の公開ゲートは閉じたまま（忘却の知らせは notice-relay.test.ts・canvas-notice.test.ts と、端末の統合の試験で確かめる）。
// 期待値（版・物・知らせの中身・閉じるコード）は手で書いた値で、検査対象の関数から作らない。模擬の試験だけ。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type {
  CanvasDocument,
  ForgetLedgerNotice,
  RetentionNotice,
  StreamTurnResponse,
} from '@buddy/contracts';
import { sharedApiContract } from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import {
  bootstrap,
  getJson,
  insertDevice,
  openStream,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type {
  EventCore,
  MutableEnvironment,
  StreamClient,
} from './event-test-support.js';
import type { ProviderReader } from './turn-ports.js';

const contract = sharedApiContract();
const DAY = 86_400_000;
// 設計 09 §2 の時計（2026-10-05T09:00:00+09:00）。
const T0 = Date.parse('2026-10-05T09:00:00+09:00');
const ACCOUNT = '00000000-0000-4000-8000-000000000002';

// 合成の読み取り専用の provider（今日の予定 2 件）。
const provider: ProviderReader = {
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
  listEvents: () =>
    Promise.resolve([
      {
        event_id: 'ev-1',
        title: '合成の予定1',
        start: '2026-10-05T10:00:00+09:00',
        end: '2026-10-05T11:00:00+09:00',
      },
      {
        event_id: 'ev-2',
        title: '合成の予定2',
        start: '2026-10-05T13:00:00+09:00',
        end: '2026-10-05T14:00:00+09:00',
      },
    ]),
};

async function startNoticeCore(
  t: test.TestContext,
  clock: { at: number },
  options: { readonly pingIntervalMs?: number; env?: MutableEnvironment } = {},
): Promise<EventCore> {
  return startEventCore(t, {
    previewValid: false,
    now: () => new Date(clock.at),
    turns: {
      provider,
      candidates: { mailCandidates: () => Promise.resolve([]) },
      utcOffset: '+09:00',
    },
    ...(options.pingIntervalMs === undefined
      ? {}
      : { pingIntervalMs: options.pingIntervalMs }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

const canvasOf = async (core: EventCore, device: TestDevice) => {
  const response = await getJson(core, device, '/v1/canvas');
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('CanvasDocument', response.json), response.text);
  return response.json as unknown as CanvasDocument;
};

const openAt = async (
  t: test.TestContext,
  core: EventCore,
  device: TestDevice,
): Promise<StreamClient> => {
  const snapshot = await getJson(core, device, '/v1/snapshot');
  assert.equal(snapshot.status, 200, snapshot.text);
  const stream = openStream(
    t,
    core,
    device,
    String(snapshot.json?.['event_cursor']),
  );
  assert.deepEqual(await stream.opened, { ok: true });
  return stream;
};

const noticesOf = (stream: StreamClient) =>
  stream.messages
    .filter((message) => message.type === 'notice')
    .map((message) => message.notice);

const ID = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// 購読が「接続範囲を確かめて配信を始めた」状態になるまで待つ（その後の知らせだけが届く）。中枢の購読の数で確かめる。
const subscribed = async (core: EventCore, count: number) => {
  const relay = core.handle.notices as unknown as { listenerCount: number };
  for (let i = 0; i < 200 && relay.listenerCount !== count; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.listenerCount, count);
};

test(
  'an expired turn closes its canvas card, bumps the revision and reaches only the open streams, also while locked',
  { timeout: 60_000 },
  async (t) => {
    const clock = { at: T0 };
    const core = await startNoticeCore(t, clock);
    await core.handle.retention.idle();
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const posted = await postJson(core, device, '/v1/stream/turns', {
      request_id: randomUUID(),
      command_scope_id: scope,
      text: '今日の用事を見せて',
      input_kind: 'text',
      expected_canvas_revision: '0',
    });
    assert.equal(posted.status, 200, posted.text);
    const turn = posted.json as unknown as StreamTurnResponse;
    assert.equal(turn.canvas?.canvas_revision, '1');
    assert.deepEqual(
      (await canvasOf(core, device)).items.map((item) => item.item_id),
      ['errands'],
    );

    // 開いている購読 A と、閉じた購読 B。
    const open = await openAt(t, core, device);
    const gone = await openAt(t, core, device);
    await subscribed(core, 2);
    gone.close();
    await gone.closed;
    await subscribed(core, 1);

    // 8 日後（normal の発言の期限は 7 日）にロックした状態で掃除する。
    clock.at = T0 + 8 * DAY;
    core.env.lock = 'locked';
    const record = await core.handle.retention.runOnce(true);
    assert.equal(record.status, 'completed');

    await open.waitFor(
      (messages) => messages.some((message) => message.type === 'notice'),
      'expired notice',
    );
    // 版の知らせが先、知らせが後（知らせを受けた端末が取る getCanvas は閉じた後の記述になる）。
    const kinds = open.messages
      .filter((message) => message.type !== 'event')
      .map((message) => message.type);
    assert.deepEqual(kinds, ['canvas', 'notice']);
    assert.deepEqual(
      open.messages.find((message) => message.type === 'canvas'),
      { type: 'canvas', canvas_revision: '2' },
    );
    const [notice] = noticesOf(open) as unknown as RetentionNotice[];
    assert(notice !== undefined);
    assert.equal(notice.schema, 'buddy.retention-notice.v1');
    assert.equal(notice.kind, 'expired');
    assert.equal(notice.reason, 'retention_due');
    assert.equal(notice.forgetting_generation, null);
    assert.equal(notice.occurred_at, '2026-10-13T00:00:00Z');
    assert.deepEqual(notice.items, [
      { item_kind: 'turn', item_id: turn.turn_id },
    ]);
    for (const message of open.messages)
      assert(
        contract.valid('EventStreamMessage', message),
        JSON.stringify(message),
      );
    // 本文・予定の見出し・元サービスの ID を含めない。
    const text = JSON.stringify(open.messages);
    assert(!text.includes('今日の用事'));
    assert(!text.includes('合成の予定'));
    assert(!text.includes('ev-1'));

    // 閉じた購読には何も届いていない（閉じた後の知らせを溜めない）。
    assert.deepEqual(noticesOf(gone), []);
    // 記述は版 2 で空（解除してから読む。getCanvas はロック中は出さない）。
    core.env.lock = 'unlocked';
    assert.deepEqual(await canvasOf(core, device), {
      canvas_revision: '2',
      items: [],
      reading_order: [],
    });

    // 後から開いた購読には、前の知らせを送らない（再送しない）。次の知らせから受け取る。8 日後なので接続範囲を取り直す。
    await bootstrap(core, device);
    const late = await openAt(t, core, device);
    await subscribed(core, 2);
    const ledger: ForgetLedgerNotice = {
      schema: 'buddy.forget-ledger-notice.v1',
      notice_id: ID(0xe1),
      occurred_at: '2026-10-13T00:00:01.000Z',
      kind: 'ledger_advanced',
      ledger_id: ID(0xe2),
      forgetting_generation: '1',
      entry_hash: 'cd'.repeat(32),
    };
    await core.handle.notices.publish(ledger);
    await late.waitFor(
      (messages) => messages.some((message) => message.type === 'notice'),
      'ledger notice',
    );
    assert.deepEqual(noticesOf(late), [ledger]);
    await open.waitFor(
      (messages) =>
        messages.filter((message) => message.type === 'notice').length === 2,
      'ledger notice on the first stream',
    );
    assert.deepEqual(noticesOf(open)[1], ledger);
    // 台帳の知らせはキャンバスを変えない。
    assert.equal((await canvasOf(core, device)).canvas_revision, '2');
  },
);

test(
  'streams closed outside the home network get nothing; raw source ids are dropped and an empty notice is not sent',
  { timeout: 60_000 },
  async (t) => {
    const clock = { at: T0 };
    const env: MutableEnvironment = { home: true, lock: 'unlocked' };
    const core = await startNoticeCore(t, clock, {
      pingIntervalMs: 50,
      env,
    });
    const device = await insertDevice(core.handle.store);
    await bootstrap(core, device);
    const cursor = String(
      (await getJson(core, device, '/v1/snapshot')).json?.['event_cursor'],
    );
    const first = await openAt(t, core, device);
    await subscribed(core, 1);

    // 自宅の外: 確かめ直しで 4403 で閉じる。閉じた後の知らせは送らない。開き直しも 403。
    env.home = false;
    assert.deepEqual(await first.closed, {
      code: 4403,
      reason: 'outside_home_network',
    });
    await subscribed(core, 0);
    const expired: RetentionNotice = {
      schema: 'buddy.retention-notice.v1',
      notice_id: ID(0xf1),
      occurred_at: '2026-10-05T00:00:00.000Z',
      kind: 'expired',
      reason: 'retention_due',
      forgetting_generation: null,
      items: [
        { item_kind: 'source_item', item_id: 'mail-synthetic-raw-1' },
        { item_kind: 'turn', item_id: ID(0xf2) },
      ],
    };
    await core.handle.notices.publish(expired);
    assert.deepEqual(noticesOf(first), []);
    const refused = openStream(t, core, device, cursor);
    assert.deepEqual(await refused.opened, { ok: false, status: 403 });

    // 自宅に戻って開き直す。前の知らせは届かない。source_item だけの知らせは送らず、混ざった知らせは source_item を除く。
    env.home = true;
    const second = await openAt(t, core, device);
    await subscribed(core, 1);
    await core.handle.notices.publish({
      ...expired,
      notice_id: ID(0xf3),
      items: [{ item_kind: 'source_item', item_id: 'mail-synthetic-raw-2' }],
    });
    await core.handle.notices.publish({
      ...expired,
      notice_id: ID(0xf4),
      kind: 'forgotten',
      reason: 'derived_from_forgotten',
      forgetting_generation: '3',
    });
    await second.waitFor(
      (messages) => messages.some((message) => message.type === 'notice'),
      'mixed notice',
    );
    assert.deepEqual(noticesOf(second), [
      {
        schema: 'buddy.retention-notice.v1',
        notice_id: ID(0xf4),
        occurred_at: '2026-10-05T00:00:00.000Z',
        kind: 'forgotten',
        reason: 'derived_from_forgotten',
        forgetting_generation: '3',
        items: [{ item_kind: 'turn', item_id: ID(0xf2) }],
      },
    ]);
    assert(!JSON.stringify(second.messages).includes('mail-synthetic-raw'));
  },
);
