// 連携の接続の画面の状態（connections-state.ts。B08-02 P3・B09-05、ADR 0142）の試験。期待値は手で書く。
// 確かめること: 下書きの変換と範囲の検査（上限は設計の初期値）、並び順に依らない変更の判定、未取得を「接続なし」に
// しないこと、保存は参照と取得範囲だけを送ること、409 で読み直すこと、世代をまたいだ応答を捨てること。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ConnectionTargets,
  DesktopConnectionEntry,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopProviderConnectionsView,
} from '@buddy/contracts';
import {
  ConnectionsStore,
  INITIAL_CONNECTIONS_STATE,
  applyConnectionsListResponse,
  draftChanged,
  draftFromTargets,
  draftToTargets,
} from './connections-state.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const TARGETS: ConnectionTargets = {
  calendar_ids: ['primary'],
  mail_container_ids: ['INBOX'],
  attachment_kinds: ['pdf', 'text'],
  mail_lookback_days: 90,
  calendar_past_days: 30,
  calendar_future_days: 90,
  attachment_max_bytes: 10000000,
};

const entry = (
  n: number,
  overrides: Partial<DesktopConnectionEntry> = {},
): DesktopConnectionEntry => ({
  ref: id(n),
  provider: 'google',
  status: 'active',
  access: 'read',
  granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  targets: TARGETS,
  graph_account: null,
  delivery_unknown: false,
  ...overrides,
});

const view = (
  entries: DesktopConnectionEntry[],
  overrides: Partial<DesktopProviderConnectionsView> = {},
): DesktopProviderConnectionsView => ({
  fetch: 'loaded',
  entries,
  list_seq: 2,
  ...overrides,
});

// --- 下書き ---

test('the draft round-trips the saved targets', () => {
  assert.deepEqual(draftToTargets(draftFromTargets(TARGETS)), TARGETS);
});

test('out-of-range or unreadable numbers make the draft unsendable', () => {
  const draft = draftFromTargets(TARGETS);
  for (const bad of [
    { ...draft, mailLookbackDays: '91' },
    { ...draft, mailLookbackDays: '0' },
    { ...draft, mailLookbackDays: '' },
    { ...draft, mailLookbackDays: '九十' },
    { ...draft, calendarPastDays: '31' },
    { ...draft, calendarFutureDays: '91' },
    { ...draft, attachmentMaxBytes: '10000001' },
    { ...draft, attachmentMaxBytes: '0' },
  ])
    assert.equal(draftToTargets(bad), null, JSON.stringify(bad));
  // 狭める値は送れる。
  assert.notEqual(
    draftToTargets({
      ...draft,
      mailLookbackDays: '1',
      calendarPastDays: '0',
      calendarFutureDays: '0',
      attachmentMaxBytes: '1',
    }),
    null,
  );
});

test('changed compares sets, not order; removals and number changes count', () => {
  const draft = draftFromTargets(TARGETS);
  assert.equal(draftChanged(TARGETS, draft), false);
  assert.equal(
    draftChanged(TARGETS, {
      ...draft,
      attachmentKinds: ['text', 'pdf'],
    }),
    false,
  );
  assert.equal(draftChanged(TARGETS, { ...draft, calendarIds: [] }), true);
  assert.equal(
    draftChanged(TARGETS, { ...draft, mailLookbackDays: '30' }),
    true,
  );
  assert.equal(
    draftChanged(TARGETS, { ...draft, mailLookbackDays: 'x' }),
    true,
  );
});

// --- 応答の反映 ---

test('an older list is not applied over a newer one', () => {
  const newer = applyConnectionsListResponse(INITIAL_CONNECTIONS_STATE, {
    request_id: id(0x900),
    channel: 'desktop.connections_list',
    outcome: 'ok',
    connections: view([entry(1), entry(2)], { list_seq: 5 }),
  });
  const older = applyConnectionsListResponse(newer, {
    request_id: id(0x901),
    channel: 'desktop.connections_list',
    outcome: 'ok',
    connections: view([], { list_seq: 4 }),
  });
  assert.equal(older.view?.entries.length, 2);
  assert.equal(older.seq, 5);
});

test('a rejected list is a head notice, not "no connections"', () => {
  const state = applyConnectionsListResponse(INITIAL_CONNECTIONS_STATE, {
    request_id: id(0x900),
    channel: 'desktop.connections_list',
    outcome: 'rejected',
    reason: 'not_connected',
  });
  assert.equal(state.view, null);
  assert.equal(state.notice?.ref, null);
  assert.match(state.notice?.text ?? '', /接続していない/u);
});

// --- 状態の持ち主 ---

interface Pending {
  readonly request: DesktopIpcRequest;
  readonly resolve: (response: DesktopIpcResponse) => void;
  readonly reject: (error: Error) => void;
}

function harness() {
  const pending: Pending[] = [];
  const store = new ConnectionsStore({
    invoke: (request) =>
      new Promise<DesktopIpcResponse>((resolve, reject) => {
        pending.push({ request, resolve, reject });
      }),
  });
  const answer = async (response: Partial<DesktopIpcResponse>) => {
    const next = pending.shift();
    assert(next !== undefined, 'no pending request');
    next.resolve({
      request_id: next.request.request_id,
      channel: next.request.channel,
      ...response,
    } as DesktopIpcResponse);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { store, pending, answer };
}

const listed = (v: DesktopProviderConnectionsView) => ({
  outcome: 'ok' as const,
  connections: v,
});

test('refresh asks main for the list and shows it', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  assert.equal(store.snapshot().reading, true);
  assert.deepEqual(
    pending.map((item) => [item.request.channel, item.request.payload]),
    [['desktop.connections_list', null]],
  );
  await answer(listed(view([entry(1)])));
  assert.equal(store.snapshot().reading, false);
  assert.equal(store.snapshot().view?.entries.length, 1);
});

test('update sends only the ref and the targets, once at a time', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([entry(1)])));
  const narrower: ConnectionTargets = { ...TARGETS, mail_lookback_days: 30 };
  store.actions.update(id(1), narrower);
  store.actions.update(id(1), narrower);
  assert.deepEqual(
    pending.map((item) => [item.request.channel, item.request.payload]),
    [['desktop.connection_targets_update', { ref: id(1), targets: narrower }]],
  );
  assert.equal(store.snapshot().busy, id(1));
  await answer(
    listed(view([entry(1, { targets: narrower })], { list_seq: 3 })),
  );
  const state = store.snapshot();
  assert.equal(state.busy, null);
  assert.deepEqual(state.view?.entries[0]?.targets, narrower);
  assert.deepEqual(state.notice, {
    tone: 'success',
    text: '保存しました。',
    ref: id(1),
  });
});

test('a preview_stale answer re-reads the list', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([entry(1)])));
  store.actions.update(id(1), { ...TARGETS, mail_lookback_days: 30 });
  await answer({ outcome: 'rejected', reason: 'preview_stale' });
  // 読み直しの要求が続く。
  assert.deepEqual(
    pending.map((item) => item.request.channel),
    ['desktop.connections_list'],
  );
  assert.match(store.snapshot().notice?.text ?? '', /ほかの場所で変更/u);
  await answer(listed(view([entry(1)], { list_seq: 3 })));
  assert.equal(store.snapshot().view?.list_seq, 3);
});

test('an ipc failure is a notice on the row', async () => {
  const { store, pending } = harness();
  store.actions.refresh();
  const first = pending.shift();
  assert(first !== undefined);
  first.resolve({
    request_id: first.request.request_id,
    channel: 'desktop.connections_list',
    outcome: 'ok',
    connections: view([entry(1)]),
  });
  await new Promise((resolve) => setImmediate(resolve));
  store.actions.update(id(1), { ...TARGETS, mail_lookback_days: 30 });
  const sent = pending.shift();
  assert(sent !== undefined);
  sent.reject(new Error('ipc down'));
  await new Promise((resolve) => setImmediate(resolve));
  const state = store.snapshot();
  assert.equal(state.busy, null);
  assert.equal(state.notice?.ref, id(1));
  assert.match(state.notice?.text ?? '', /通信できませんでした/u);
});

test('hide drops the content and a late answer is not applied', async () => {
  const { store, answer } = harness();
  store.actions.refresh();
  store.hide();
  assert.deepEqual(store.snapshot(), INITIAL_CONNECTIONS_STATE);
  await answer(listed(view([entry(1)])));
  assert.deepEqual(store.snapshot(), INITIAL_CONNECTIONS_STATE);
});
