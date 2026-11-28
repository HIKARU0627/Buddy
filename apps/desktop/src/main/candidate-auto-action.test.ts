// 気づきの欄の自動実行の結果と取り消し（ADR 0199）を、CandidateBridge と AutoActionBridge を同じ模擬の接続でつないで
// 確かめる。中枢への要求を記録して手で答える。期待値（表示用の値・送る本文・理由）は手で書いた合成の値。
// 確かめること: 候補の operation_ids を自動実行の一覧と突き合わせ、自動実行の欄と同じ参照・表示用の値だけを渡す（操作 ID・
// 版を渡さない）、一覧に無い操作は件数だけ、結び付きのない候補だけなら自動実行の一覧を読まない、気づきの欄の参照での
// 取り消しは自動実行の経路の取り消し（一覧で読んだ state_revision）をそのまま通る、取り消せない・取り消し済みは送らない、
// 読めなかった一覧を「結果なし」にしない、ロック（世代）で参照を捨てる。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import type { DesktopCandidateEntry } from '@buddy/contracts';
import { AutoActionBridge } from './auto-action-bridge.js';
import { CandidateBridge } from './candidate-bridge.js';
import { createDesktopContract, loadContractSchema } from './contract.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const SCOPE = uuid(0x5c);
const LINKED = uuid(0x601);
const PLAIN = uuid(0x602);
const LABEL_OP = uuid(0x801);
const DRAFT_OP = uuid(0x802);
const PENDING_OP = uuid(0x803);
const OTHER_OP = uuid(0x804);
const NOW = Date.parse('2030-10-09T03:00:00.000Z');

const snapshot = (
  candidateId: string,
  title: string,
  operationIds: readonly string[],
) => ({
  candidate_id: candidateId,
  kind: 'mail_reply',
  state: 'new',
  request_entity_id: uuid(0x611),
  request_revision: '2',
  source_revision: 'r1',
  notification_key: (candidateId === LINKED ? '1' : '2').repeat(64),
  title,
  deadline: { kind: 'none' },
  initial_import: false,
  unread_partial: false,
  related_analysis: null,
  operation_ids: operationIds,
});

const candidateList = (candidates: unknown[]) => ({
  candidates,
  counts: { new: 2, seen: 0, acted: 0, dismissed: 0, snoozed: 0, resolved: 0 },
  next_cursor: null,
  zone: 'Asia/Tokyo',
  as_of: '2030-10-09T03:00:00Z',
});

const item = (fields: Record<string, unknown>) => ({
  action_kind: 'label_mail',
  policy_version: '1',
  state_revision: '4',
  completed_at: '2030-10-09T02:00:00Z',
  undo_state: 'available',
  undo_deadline: '2030-11-08T02:00:00Z',
  undo_target: null,
  ...fields,
});

// 自動実行の一覧（新しい順）: 別の候補の操作・ラベル（取り消せる）・下書き（取り消せない）。PENDING_OP は載らない。
const autoList = (labelState = 'available') => ({
  safety: {
    state: 'running',
    safety_revision: '3',
    stop_reason: null,
    stopped_at: null,
  },
  items: [
    item({ operation_id: OTHER_OP, completed_at: '2030-10-09T02:30:00Z' }),
    item({ operation_id: LABEL_OP, undo_state: labelState }),
    item({
      operation_id: DRAFT_OP,
      action_kind: 'draft_reply',
      state_revision: '6',
      completed_at: '2030-10-08T03:00:00Z',
      undo_state: 'unavailable',
      undo_deadline: '2030-11-07T03:00:00Z',
    }),
  ],
});

const receipt = {
  request_id: uuid(0x901),
  command_id: uuid(0x902),
  operation_id: uuid(0x903),
  state_revision: '1',
  status: 'durable',
  committed_state_revision: '2',
};

type Outcome =
  { kind: 'response'; status: number; body: unknown } | { kind: 'unknown' };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly scoped?: boolean;
  readonly screenOperation?: boolean;
  readonly expectedScopeId?: string;
}

interface Rig {
  readonly candidates: CandidateBridge;
  readonly autoActions: AutoActionBridge;
  readonly calls: Call[];
  candidateBody: unknown;
  auto: () => Outcome;
  post: (call: Call) => Outcome;
  paths(): string[];
}

function rig(): Rig {
  const calls: Call[] = [];
  const state = {
    calls,
    candidateBody: candidateList([
      snapshot(LINKED, '連絡の返信', [
        LABEL_OP,
        DRAFT_OP,
        PENDING_OP,
        LABEL_OP,
      ]),
      snapshot(PLAIN, '結び付きのない気づき', []),
    ]) as unknown,
    auto: (): Outcome => ({ kind: 'response', status: 200, body: autoList() }),
    post: (call: Call): Outcome => {
      void call;
      return { kind: 'unknown' };
    },
    paths: () => calls.map((call) => `${call.method} ${call.path}`),
  };
  const connection = {
    get state() {
      return { commandScopeId: SCOPE, phase: 'live' };
    },
    request: async (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (call.method === 'GET' && call.path === '/v1/candidates')
        return { kind: 'response', status: 200, body: state.candidateBody };
      if (
        call.method === 'GET' &&
        call.path === '/v1/candidates/alert-settings'
      )
        return {
          kind: 'response',
          status: 200,
          body: {
            schema: 'buddy.candidate-alert-settings.v1',
            os_notification: 'off',
            candidate_alert_settings_revision: '0',
          },
        };
      if (call.method === 'GET' && call.path === '/v1/auto-actions')
        return state.auto();
      return state.post(call);
    },
  } as unknown as ClientConnection;
  let counter = 0x100;
  const common = {
    contract,
    connection: () => connection,
    newRef: () => uuid(counter++),
    now: () => NOW,
    log: () => undefined,
  };
  const autoActions = new AutoActionBridge(common);
  const candidates = new CandidateBridge({ ...common, autoActions });
  return Object.assign(state, { candidates, autoActions });
}

const ok = <T>(outcome: { ok: boolean; value?: T }): T => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.value as T;
};

const entryOf = (
  entries: readonly DesktopCandidateEntry[],
  title: string,
): DesktopCandidateEntry => {
  const found = entries.find((entry) => entry.title === title);
  assert(found !== undefined, title);
  return found;
};

test('a candidate carries its listed automatic operations with the auto-action refs; the rest are counted only', async () => {
  const r = rig();
  const view = ok(await r.candidates.list());
  // 候補の一覧・設定の後に、結び付いた操作があるので自動実行の一覧を読む。
  assert.deepEqual(r.paths(), [
    'GET /v1/candidates',
    'GET /v1/candidates/alert-settings',
    'GET /v1/auto-actions',
  ]);
  assert.equal(view.auto_action_fetch, 'loaded');
  // 自動実行の欄の行（一覧の順: 別の候補の操作・ラベル・下書き）と同じ参照。
  const autoRefs = r.autoActions.view().entries.map((entry) => entry.ref);
  const linked = entryOf(view.entries, '連絡の返信');
  // 自動実行の一覧の順（ラベル・下書き）。重なった ID は 1 件。一覧に無い PENDING_OP は件数だけ。
  assert.deepEqual(linked.auto_actions, [
    {
      ref: autoRefs[1],
      position: 1,
      kind: 'label_mail',
      completed_at: '2030-10-09T02:00:00Z',
      undo_state: 'available',
      undo_deadline: '2030-11-08T02:00:00Z',
      delivery_unknown: false,
    },
    {
      ref: autoRefs[2],
      position: 2,
      kind: 'draft_reply',
      completed_at: '2030-10-08T03:00:00Z',
      undo_state: 'unavailable',
      undo_deadline: '2030-11-07T03:00:00Z',
      delivery_unknown: false,
    },
  ]);
  assert.equal(linked.auto_actions_unlisted, 1);
  assert.equal(linked.has_operations, true);
  const plain = entryOf(view.entries, '結び付きのない気づき');
  assert.deepEqual(
    [plain.has_operations, plain.auto_actions, plain.auto_actions_unlisted],
    [false, [], 0],
  );
  // 操作 ID・版は画面へ出ない。応答は IPC の契約に合う。
  const text = JSON.stringify(view);
  for (const secret of [LABEL_OP, DRAFT_OP, PENDING_OP, OTHER_OP, '"4"'])
    assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(
    contract.responseErrors({
      request_id: uuid(0x900),
      channel: 'desktop.candidates_list',
      outcome: 'ok',
      candidates: view,
    }),
    [],
  );
});

test('with no linked operation the automatic-operation list is not read', async () => {
  const r = rig();
  r.candidateBody = candidateList([
    snapshot(PLAIN, '結び付きのない気づき', []),
  ]);
  const view = ok(await r.candidates.list());
  assert.deepEqual(r.paths(), [
    'GET /v1/candidates',
    'GET /v1/candidates/alert-settings',
  ]);
  assert.equal(view.auto_action_fetch, 'unavailable');
  assert.deepEqual(view.entries[0]?.auto_actions, []);
});

test('undo from the candidate row goes through the automatic-operation undo with the read revision', async () => {
  const r = rig();
  const view = ok(await r.candidates.list());
  const label = entryOf(view.entries, '連絡の返信').auto_actions[0];
  assert(label !== undefined);
  let posted: Call | null = null;
  r.post = (call) => {
    posted = call;
    r.auto = () => ({
      kind: 'response',
      status: 200,
      body: autoList('in_progress'),
    });
    return { kind: 'response', status: 202, body: receipt };
  };
  ok(await r.autoActions.undo(label.ref));
  assert.deepEqual(posted, {
    method: 'POST',
    path: `/v1/auto-actions/${LABEL_OP}/undo`,
    body: { expected_state_revision: '4' },
    scoped: true,
    screenOperation: true,
    expectedScopeId: SCOPE,
  });
  // 画面が読み直すと、同じ参照の行が取り消し中になる。もう一度押しても送らない。
  const reread = ok(await r.candidates.list());
  const after = entryOf(reread.entries, '連絡の返信').auto_actions[0];
  assert.deepEqual([after?.ref, after?.undo_state], [label.ref, 'in_progress']);
  const before = r.calls.length;
  assert.deepEqual(await r.autoActions.undo(label.ref), {
    ok: false,
    reason: 'preview_stale',
  });
  assert.equal(r.calls.length, before);
});

test('an operation that cannot be undone, or a ref from before the lock, sends nothing', async () => {
  const r = rig();
  const view = ok(await r.candidates.list());
  const [label, draft] = entryOf(view.entries, '連絡の返信').auto_actions;
  assert(label !== undefined && draft !== undefined);
  const before = r.calls.length;
  // 取り消せない（unavailable）。
  assert.deepEqual(await r.autoActions.undo(draft.ref), {
    ok: false,
    reason: 'preview_stale',
  });
  // ロック（世代）で両方の参照を捨てる。前の参照では送らない。
  r.candidates.reset();
  r.autoActions.reset();
  assert.deepEqual(r.candidates.view().entries, []);
  assert.deepEqual(await r.autoActions.undo(label.ref), {
    ok: false,
    reason: 'entry_not_found',
  });
  assert.equal(r.calls.length, before);
});

test('an unread automatic-operation list counts every link as unlisted; a later failure keeps the last rows as stale', async () => {
  const r = rig();
  r.auto = () => ({ kind: 'response', status: 503, body: {} });
  const unread = ok(await r.candidates.list());
  assert.equal(unread.auto_action_fetch, 'unavailable');
  const linked = entryOf(unread.entries, '連絡の返信');
  // 重なった ID は 1 件（LABEL_OP・DRAFT_OP・PENDING_OP の 3 件）。「結果なし」にしない。
  assert.deepEqual(
    [linked.auto_actions, linked.auto_actions_unlisted],
    [[], 3],
  );
  r.auto = () => ({ kind: 'response', status: 200, body: autoList() });
  ok(await r.candidates.list());
  r.auto = () => ({ kind: 'unknown' });
  const stale = ok(await r.candidates.list());
  assert.equal(stale.auto_action_fetch, 'stale');
  assert.equal(entryOf(stale.entries, '連絡の返信').auto_actions.length, 2);
});
