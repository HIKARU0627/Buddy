// 忘却の画面の状態と表示の値（UI-10、ADR 0183）の試験。期待値は手で書いた。
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopMemoryView,
} from '@buddy/contracts';
import {
  INITIAL_MEMORY_STATE,
  MemoryStore,
  applyListResponse,
  bandSummary,
  deadlineText,
  forgetAvailability,
  groupByKind,
  keptLines,
  removedLines,
  shownPlan,
  sourceText,
} from './memory-state.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const entry = (ref: string, kind: string, fields = {}) =>
  ({
    ref,
    kind,
    origin: 'explicit_request',
    text: '合成の記憶',
    status: 'active',
    created_at: '2030-10-01T00:00:00.000Z',
    review_at: '2030-12-30T12:00:00.000Z',
    delete_at: null,
    source_counts: { turn: 0, source_item: 0, memory: 0 },
    ...fields,
  }) as DesktopMemoryView['entries'][number];

const PLAN = {
  ref: uuid(0x201),
  target_ref: uuid(0x101),
  forgetting_generation: '12',
  expires_at: '2030-11-04T09:10:00.000Z',
  removed: {
    counts: [
      { kind: 'memory', count: 2 },
      { kind: 'user_directive', count: 1 },
      { kind: 'operation_content', count: 3 },
    ],
    memory_refs: [uuid(0x101)],
    unlisted_memory_count: 1,
    directive_count: 1,
  },
  kept: {
    operation_states: ['dispatching', 'awaiting_approval', 'dispatching'],
    lineage_only: 2,
  },
  blocked_source_count: 0,
} as DesktopMemoryView['plan'] & object;

const view = (fields: Partial<DesktopMemoryView> = {}): DesktopMemoryView => ({
  fetch: 'loaded',
  fetched_at: '2030-11-04T08:59:00.000Z',
  forget: 'open',
  truncated: false,
  entries: [entry(uuid(0x101), 'preference')],
  plan: PLAN,
  result: null,
  list_seq: 2,
  ...fields,
});

test('row values: sources by kind without IDs, review dates, and the review-pending deadline', () => {
  assert.equal(sourceText(entry('r', 'goal')), null);
  assert.equal(
    sourceText(
      entry('r', 'goal', {
        source_counts: { turn: 2, source_item: 1, memory: 1 },
      }),
    ),
    '由来: 発言 2 件・元の情報 1 件・別の記憶 1 件',
  );
  // 端末の地域時間の月日（UTC−11〜＋11 のどこでも同じ日になる正午を選んだ）。
  assert.equal(deadlineText(entry('r', 'goal')), '見直し 12/30');
  assert.equal(
    deadlineText(
      entry('r', 'goal', {
        status: 'review_pending',
        delete_at: '2030-12-01T12:00:00.000Z',
      }),
    ),
    '12/1 に削除（見直さなければ）',
  );
});

test('rows are grouped under kind headings in a fixed order, and empty kinds are left out', () => {
  const groups = groupByKind([
    entry('a', 'routine'),
    entry('b', 'preference'),
    entry('c', 'routine'),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.kind, group.entries.map((item) => item.ref)]),
    [
      ['preference', ['b']],
      ['routine', ['a', 'c']],
    ],
  );
});

test('plan lines: directives are separate, kept operations are grouped by state, the band counts listed and unlisted memories', () => {
  assert.deepEqual(removedLines(PLAN), ['記憶 2 件', '操作の確定内容 3 件']);
  assert.deepEqual(keptLines(PLAN), [
    '承認待ちの操作 1 件',
    '送出中の操作 2 件',
  ]);
  assert.equal(bandSummary(PLAN), '消える物 合計 6 件（記憶 2 件・指示 1 件）');
});

test('forgetting is available only when the hub says open and nothing blocked it', () => {
  const state = { ...INITIAL_MEMORY_STATE, view: view(), seq: 2 };
  assert.equal(forgetAvailability(INITIAL_MEMORY_STATE), 'unavailable');
  assert.equal(forgetAvailability(state), 'open');
  assert.equal(
    forgetAvailability({ ...state, view: view({ forget: 'closed' }) }),
    'closed',
  );
  assert.equal(forgetAvailability({ ...state, blocked: true }), 'unavailable');
  assert.equal(
    forgetAvailability({ ...state, view: view({ fetch: 'unavailable' }) }),
    'unavailable',
  );
  // しまった計画は出さない。
  assert.equal(shownPlan(state), PLAN);
  assert.equal(shownPlan({ ...state, dismissed: PLAN.ref }), null);
  // 自動の読み直しでは止めた状態を解かず、本人の「読み直す」で解く。
  const response = {
    request_id: uuid(1),
    channel: 'desktop.memories_list',
    outcome: 'ok',
    memories: view({ list_seq: 3 }),
  } as DesktopIpcResponse;
  const blocked = { ...state, blocked: true };
  assert.equal(applyListResponse(blocked, response, false).blocked, true);
  assert.equal(applyListResponse(blocked, response, true).blocked, false);
  // 古い一覧（小さい通し番号）は反映しない。
  const older = {
    ...response,
    memories: view({ list_seq: 1, entries: [] }),
  } as DesktopIpcResponse;
  assert.equal(applyListResponse(state, older, false).view, state.view);
});

test('the store never sends a plan or an execute while forgetting is closed, and drops replies after hide', async () => {
  const sent: DesktopIpcRequest[] = [];
  let reply: (request: DesktopIpcRequest) => DesktopIpcResponse = (request) =>
    ({
      request_id: request.request_id,
      channel: request.channel,
      outcome: 'ok',
      memories: view({ forget: 'closed' }),
    }) as DesktopIpcResponse;
  const store = new MemoryStore({
    invoke: (request) => {
      sent.push(request);
      return Promise.resolve(reply(request));
    },
  });
  store.open();
  await new Promise((resolve) => setImmediate(resolve));
  store.actions.plan(uuid(0x101));
  store.actions.execute();
  assert.deepEqual(
    sent.map((request) => request.channel),
    ['desktop.memories_list'],
  );
  // 隠した後に届いた応答は反映しない。
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  reply = (request) =>
    ({
      request_id: request.request_id,
      channel: request.channel,
      outcome: 'ok',
      memories: view({ list_seq: 9 }),
    }) as DesktopIpcResponse;
  const slow = new MemoryStore({
    invoke: async (request) => {
      await pending;
      return reply(request);
    },
  });
  slow.open();
  slow.hide();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slow.snapshot().view, null);
});
