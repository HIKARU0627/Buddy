// 知らせの中継（UI-05 の段階 3、ADR 0187）の単体の試験。端末へ送る形（source_item を除く・空なら送らない）と、
// 表示の後始末 → 開いている購読 → 起動の設定の受け取り口の順、購読がなければ溜めないこと、契約に合わない知らせを送らないこと、
// 1 つの受け手の失敗で他を止めないことを確かめる。期待値は手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  StorageModeNotice,
  ForgetLedgerNotice,
  RetentionNotice,
  StorageBoundaryNotice,
} from '@buddy/contracts';
import { sharedApiContract } from './api-test-support.js';
import { NoticeRelay, streamNoticeOf } from './notice-relay.js';
import type { StreamNoticeMessage } from './notice-relay.js';
import type { Notice } from './notice-sink.js';
import { RecordingNoticeSink } from './notice-sink.js';

const contract = sharedApiContract();
// 知らせの見分け（保存モードの知らせは ID を持たないので、種類の名前で見分ける。UI-05 の段階 6、ADR 0189）。
const idOf = (notice: Notice): string =>
  'notice_id' in notice ? notice.notice_id : notice.schema;
const ID = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const EXPIRED: RetentionNotice = {
  schema: 'buddy.retention-notice.v1',
  notice_id: ID(1),
  occurred_at: '2031-01-01T00:00:00Z',
  kind: 'expired',
  reason: 'retention_due',
  forgetting_generation: null,
  items: [
    { item_kind: 'turn', item_id: ID(2) },
    { item_kind: 'source_item', item_id: 'mail-synthetic-raw' },
    { item_kind: 'memory', item_id: ID(3) },
  ],
};
const LEDGER: ForgetLedgerNotice = {
  schema: 'buddy.forget-ledger-notice.v1',
  notice_id: ID(4),
  occurred_at: '2031-01-01T00:00:00Z',
  kind: 'ledger_advanced',
  ledger_id: ID(5),
  forgetting_generation: '2',
  entry_hash: 'ef'.repeat(32),
};
const BOUNDARY: StorageBoundaryNotice = {
  schema: 'buddy.storage-boundary-notice.v1',
  notice_id: ID(6),
  occurred_at: '2031-01-01T00:00:00Z',
  kind: 'private_ended',
  reason: 'core_restarted',
  ended_generation: '3',
  segment_id: ID(7),
  segment_generation: '4',
};

test('the stream form drops raw source ids, keeps the rest as is and sends nothing when only source ids were left', () => {
  assert.deepEqual(streamNoticeOf(EXPIRED), {
    type: 'notice',
    notice: {
      schema: 'buddy.retention-notice.v1',
      notice_id: ID(1),
      occurred_at: '2031-01-01T00:00:00Z',
      kind: 'expired',
      reason: 'retention_due',
      forgetting_generation: null,
      items: [
        { item_kind: 'turn', item_id: ID(2) },
        { item_kind: 'memory', item_id: ID(3) },
      ],
    },
  });
  assert.equal(
    streamNoticeOf({
      ...EXPIRED,
      items: [{ item_kind: 'source_item', item_id: 'mail-synthetic-raw' }],
    }),
    null,
  );
  assert.deepEqual(streamNoticeOf(LEDGER), { type: 'notice', notice: LEDGER });
  assert.deepEqual(streamNoticeOf(BOUNDARY), {
    type: 'notice',
    notice: BOUNDARY,
  });
  for (const notice of [EXPIRED, LEDGER, BOUNDARY])
    assert(contract.valid('EventStreamMessage', streamNoticeOf(notice)));
});

test('the relay tidies the display first, then the open streams, then the configured sink; nothing is kept for later', async () => {
  const order: string[] = [];
  const downstream = new RecordingNoticeSink();
  const relay = new NoticeRelay({
    contract,
    downstream: {
      publish: (notice) => {
        order.push(`sink:${idOf(notice)}`);
        downstream.publish(notice);
      },
    },
  });
  relay.attachDisplay((notice) => {
    order.push(`display:${idOf(notice)}`);
    return true;
  });
  // 購読がない間の知らせは、表示と受け取り口だけに渡り、後から購読しても届かない。
  await relay.publish(LEDGER);
  const received: StreamNoticeMessage[] = [];
  const off = relay.subscribe((message) => {
    order.push(`stream:${idOf(message.notice)}`);
    received.push(message);
  });
  assert.equal(relay.listenerCount, 1);
  await relay.publish(EXPIRED);
  assert.deepEqual(order, [
    `display:${ID(4)}`,
    `sink:${ID(4)}`,
    `display:${ID(1)}`,
    `stream:${ID(1)}`,
    `sink:${ID(1)}`,
  ]);
  // 購読へは source_item を除いた形。受け取り口へは元の知らせのまま。
  assert.deepEqual(
    received.map((message) => idOf(message.notice)),
    [ID(1)],
  );
  assert(!JSON.stringify(received).includes('mail-synthetic-raw'));
  assert.deepEqual(downstream.notices, [EXPIRED]);
  assert.deepEqual(downstream.ledgerNotices, [LEDGER]);
  // 外した購読には送らない。
  off();
  assert.equal(relay.listenerCount, 0);
  await relay.publish(BOUNDARY);
  assert.equal(received.length, 1);
  assert.deepEqual(downstream.boundaryNotices, [BOUNDARY]);
});

test('a notice that breaks the contract is not sent; a failing display or listener does not stop the others', async () => {
  const logs: string[] = [];
  const relay = new NoticeRelay({ contract, log: (line) => logs.push(line) });
  const first: string[] = [];
  const second: string[] = [];
  relay.subscribe(() => {
    first.push('called');
    throw new Error('listener');
  });
  relay.subscribe((message) => second.push(idOf(message.notice)));
  relay.attachDisplay(() => {
    throw new Error('display');
  });
  // 本文を持つ知らせ（契約にない欄）は送らない。
  const broken = {
    ...LEDGER,
    notice_id: ID(8),
    entries: [{ text: '本文' }],
  } as unknown as Notice;
  await relay.publish(broken);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  await relay.publish(LEDGER);
  assert.deepEqual(first, ['called']);
  assert.deepEqual(second, [ID(4)]);
  assert.deepEqual(logs, [
    '知らせに合わせてキャンバスを片付けられませんでした（掃除・忘却には影響しません）。',
    '契約に合わない知らせを端末へ送りませんでした（掃除・忘却には影響しません）。',
    '知らせに合わせてキャンバスを片付けられませんでした（掃除・忘却には影響しません）。',
  ]);
  // 受け取り口の失敗（Promise の拒否）は呼び出し側へ返す（掃除・忘却はそれをログにして続ける）。
  const rejecting = new NoticeRelay({
    contract,
    downstream: { publish: () => Promise.reject(new Error('sink')) },
  });
  await assert.rejects(Promise.resolve(rejecting.publish(LEDGER)), /sink/u);
});

// U477 の直し（UI-05 の段階 6、ADR 0189）: 保存モードの知らせは、保存モードと理由だけで開いている購読へそのまま届き、
// 受け取り口では保存モードの知らせとして分けて持つ。区切り・会話の ID・世代の欄を足した知らせは送らない。
test('a storage mode notice reaches the open streams as it is, and one with a segment ID is not sent', async () => {
  const downstream = new RecordingNoticeSink();
  const relay = new NoticeRelay({ contract, downstream });
  const received: StreamNoticeMessage[] = [];
  relay.subscribe((message) => received.push(message));
  const mode: StorageModeNotice = {
    schema: 'buddy.storage-mode-notice.v1',
    occurred_at: '2030-01-01T00:00:40Z',
    storage_mode: 'private',
    reason: 'private_started',
  };
  await relay.publish(mode);
  assert.deepEqual(received, [{ type: 'notice', notice: mode }]);
  assert.deepEqual(downstream.modeNotices, [mode]);
  assert.deepEqual(downstream.notices, []);
  assert.deepEqual(downstream.boundaryNotices, []);
  await relay.publish({
    ...mode,
    segment_id: ID(41),
  } as unknown as Notice);
  assert.equal(received.length, 1);
});
