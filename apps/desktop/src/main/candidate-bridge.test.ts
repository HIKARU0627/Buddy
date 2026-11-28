// 気づきの経路（CandidateBridge。B11-05、ADR 0132）の試験。接続は模擬（中枢への要求を記録して手で答える）で、世代・時計を
// 手で動かす。期待値（表示用の値・本文・理由）は手で書いた合成の値。実メール・実 API は使わない。
// 確かめること: 画面へ候補 ID・版・期待する状態を渡さない、読めなかったことを「候補なし」にしない、状態の変更は一覧で
// 読んだ状態を expected_state にして送り、記録できたら読み直す、409 は読み直して preview_stale、結果不明は送り直さず
// 次の読み取りまで操作させない、世代をまたいだ読み取りは反映しない。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientConnection } from '@buddy/client';
import { CandidateBridge } from './candidate-bridge.js';
import type { CandidateHost } from './candidate-bridge.js';
import { createDesktopContract, loadContractSchema } from './contract.js';

const contract = createDesktopContract(loadContractSchema());
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const SCOPE = uuid(0x5c);
const MAIL = uuid(0x601);
const OVERLAP = uuid(0x602);
const NOW = Date.parse('2030-10-09T03:00:00.000Z');

const snapshot = (fields: Record<string, unknown>) => ({
  candidate_id: MAIL,
  kind: 'mail_reply',
  state: 'new',
  request_entity_id: uuid(0x611),
  request_revision: '2',
  source_revision: 'r1',
  notification_key: '1'.repeat(64),
  title: '参加可否の返信：10/7まで',
  deadline: { kind: 'date', date: '2030-10-10', original_text: '10月10日まで' },
  initial_import: false,
  unread_partial: true,
  related_analysis: null,
  operation_ids: [],
  ...fields,
});

const overlap = (state = 'seen') =>
  snapshot({
    candidate_id: OVERLAP,
    kind: 'schedule_overlap',
    state,
    request_entity_id: null,
    request_revision: null,
    source_revision: 'cal-1',
    notification_key: '2'.repeat(64),
    title: '予定の重複：定例と面談',
    deadline: {
      kind: 'instant',
      local_datetime: '2030-10-09T15:00:00',
      zone: 'Asia/Tokyo',
      original_text: '15:00',
    },
    unread_partial: false,
    operation_ids: [uuid(0x701)],
  });

const listBody = (
  candidates: unknown[] = [overlap(), snapshot({})],
  fields: Record<string, unknown> = {},
) => ({
  candidates,
  counts: {
    new: 1,
    seen: 1,
    acted: 0,
    dismissed: 0,
    snoozed: 0,
    resolved: 0,
  },
  next_cursor: null,
  zone: 'Asia/Tokyo',
  as_of: '2030-10-09T03:00:00Z',
  ...fields,
});

const alertBody = (value: 'on' | 'off', revision: string) => ({
  schema: 'buddy.candidate-alert-settings.v1',
  os_notification: value,
  candidate_alert_settings_revision: revision,
});

type Outcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unknown' }
  | { kind: 'not_sent'; reason: 'not_connected' };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly scoped?: boolean;
  readonly screenOperation?: boolean;
  readonly expectedScopeId?: string;
}

interface Rig {
  readonly bridge: CandidateBridge;
  readonly calls: Call[];
  readonly logs: string[];
  list: () => Outcome;
  // OS 通知の入・切の読み取り（ADR 0196。既定は切・版 0）。
  alert: () => Outcome;
  post: (call: Call) => Outcome;
  // 中枢への要求の答えを返す前に待つ（途中で世代が変わる状況を作る）。
  delay: (() => Promise<void>) | null;
  scope: string | null;
  posts(): Call[];
}

function rig(): Rig {
  const calls: Call[] = [];
  const logs: string[] = [];
  const state: Rig = {
    calls,
    logs,
    list: () => ({ kind: 'response', status: 200, body: listBody() }),
    alert: () => ({
      kind: 'response',
      status: 200,
      body: alertBody('off', '0'),
    }),
    post: () => ({ kind: 'unknown' }),
    delay: null,
    scope: SCOPE,
    posts: () => calls.filter((call) => call.method === 'POST'),
    bridge: undefined as unknown as CandidateBridge,
  };
  const connection = {
    get state() {
      return { commandScopeId: state.scope, phase: 'live' };
    },
    request: async (call: Call): Promise<Outcome> => {
      calls.push(call);
      if (state.delay !== null) await state.delay();
      if (call.method === 'GET' && call.path === '/v1/candidates')
        return state.list();
      if (
        call.method === 'GET' &&
        call.path === '/v1/candidates/alert-settings'
      )
        return state.alert();
      return state.post(call);
    },
  } as unknown as ClientConnection;
  let counter = 0x100;
  const host: CandidateHost = {
    contract,
    connection: () => connection,
    newRef: () => uuid(counter++),
    now: () => NOW,
    log: (code) => logs.push(code),
  };
  return Object.assign(state, { bridge: new CandidateBridge(host) });
}

const fail = (reason: string) => ({ ok: false, reason });

function refOf(r: Rig, title: string): string {
  const entry = r.bridge.view().entries.find((item) => item.title === title);
  assert(entry !== undefined, title);
  return entry.ref;
}

const MAIL_TITLE = '参加可否の返信：10/7まで';
const OVERLAP_TITLE = '予定の重複：定例と面談';

test('before any read the view says unavailable, not "no candidates"', () => {
  const r = rig();
  assert.deepEqual(r.bridge.view(), {
    fetch: 'unavailable',
    fetched_at: null,
    zone: null,
    counts: null,
    entries: [],
    truncated: false,
    list_seq: 1,
    alert: null,
  });
});

test('the list keeps the hub order and gives the screen only refs and display values', async () => {
  const r = rig();
  const listed = await r.bridge.list();
  assert.equal(listed.ok, true);
  assert.deepEqual(r.calls, [
    { method: 'GET', path: '/v1/candidates', expectedScopeId: SCOPE },
    {
      method: 'GET',
      path: '/v1/candidates/alert-settings',
      expectedScopeId: SCOPE,
    },
  ]);
  const view = r.bridge.view();
  assert.deepEqual(
    {
      ...view,
      entries: view.entries.map((entry) => ({ ...entry, ref: 'r' })),
      alert: view.alert === null ? null : { ...view.alert, ref: 'a' },
    },
    {
      fetch: 'loaded',
      fetched_at: '2030-10-09T03:00:00Z',
      zone: 'Asia/Tokyo',
      counts: {
        new: 1,
        seen: 1,
        acted: 0,
        dismissed: 0,
        snoozed: 0,
        resolved: 0,
      },
      entries: [
        {
          ref: 'r',
          position: 0,
          kind: 'schedule_overlap',
          state: 'seen',
          title: OVERLAP_TITLE,
          deadline: {
            kind: 'instant',
            local_datetime: '2030-10-09T15:00:00',
            zone: 'Asia/Tokyo',
            original_text: '15:00',
          },
          initial_import: false,
          unread_partial: false,
          has_operations: true,
          delivery_unknown: false,
        },
        {
          ref: 'r',
          position: 1,
          kind: 'mail_reply',
          state: 'new',
          title: MAIL_TITLE,
          deadline: {
            kind: 'date',
            date: '2030-10-10',
            original_text: '10月10日まで',
          },
          initial_import: false,
          unread_partial: true,
          has_operations: false,
          delivery_unknown: false,
        },
      ],
      truncated: false,
      list_seq: 3,
      alert: { ref: 'a', os_notification: 'off' },
    },
  );
  // 参照は main が作った値で、候補 ID・通知キー・版・操作 ID は画面へ出ない。
  const text = JSON.stringify(view);
  for (const secret of [MAIL, OVERLAP, '1'.repeat(64), uuid(0x611), 'r1'])
    assert(!text.includes(secret), secret);
  assert.notEqual(view.entries[0]?.ref, view.entries[1]?.ref);
  // 応答は IPC の契約に合う。
  assert.deepEqual(
    contract.responseErrors({
      request_id: uuid(0x900),
      channel: 'desktop.candidates_list',
      outcome: 'ok',
      candidates: view,
    }),
    [],
  );
  // 同じ候補は読み直しても同じ参照。
  const before = refOf(r, MAIL_TITLE);
  await r.bridge.list();
  assert.equal(refOf(r, MAIL_TITLE), before);
});

test('a failed read keeps the last list and marks it stale; a failed first read stays unavailable', async () => {
  const r = rig();
  r.list = () => ({
    kind: 'response',
    status: 503,
    body: { error: 'dependency_unavailable' },
  });
  await r.bridge.list();
  assert.equal(r.bridge.view().fetch, 'unavailable');
  assert.deepEqual(r.bridge.view().entries, []);
  assert.deepEqual(r.logs, ['candidate_list_unavailable']);
  r.list = () => ({ kind: 'response', status: 200, body: listBody() });
  await r.bridge.list();
  assert.equal(r.bridge.view().fetch, 'loaded');
  // 形の違う応答（zone がない）も読めなかったものとして扱う。
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: { ...listBody(), zone: undefined },
  });
  await r.bridge.list();
  const stale = r.bridge.view();
  assert.equal(stale.fetch, 'stale');
  assert.equal(stale.entries.length, 2);
  assert.equal(stale.fetched_at, '2030-10-09T03:00:00Z');
  r.list = () => ({ kind: 'unknown' });
  await r.bridge.list();
  assert.equal(r.bridge.view().fetch, 'stale');
});

test('a cut-off list is marked truncated', async () => {
  const r = rig();
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody(undefined, { next_cursor: 'c-next' }),
  });
  await r.bridge.list();
  assert.equal(r.bridge.view().truncated, true);
});

test('a state change sends the read state as expected_state through the scoped connection, then re-reads', async () => {
  const r = rig();
  await r.bridge.list();
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: snapshot({ state: 'seen' }),
  });
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([overlap(), snapshot({ state: 'seen' })], {
      counts: {
        new: 0,
        seen: 2,
        acted: 0,
        dismissed: 0,
        snoozed: 0,
        resolved: 0,
      },
      as_of: '2030-10-09T03:01:00Z',
    }),
  });
  const result = await r.bridge.change(refOf(r, MAIL_TITLE), 'open', null);
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: `/v1/candidates/${MAIL}/state`,
      body: { event: 'open', expected_state: 'new', snooze_until: null },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 読み直した一覧と件数（件数と行が合う）。
  assert.equal(result.value.counts?.seen, 2);
  assert.equal(result.value.counts?.new, 0);
  assert.equal(result.value.fetched_at, '2030-10-09T03:01:00Z');
  assert.deepEqual(
    result.value.entries.map((entry) => entry.state),
    ['seen', 'seen'],
  );
  // 一覧の読み取りは 2 回（最初と変更の後）。それぞれ OS 通知の設定も読む。
  assert.equal(
    r.calls.filter(
      (call) => call.method === 'GET' && call.path === '/v1/candidates',
    ).length,
    2,
  );
});

test('a dismiss that leaves the list removes the row after the re-read', async () => {
  const r = rig();
  await r.bridge.list();
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: snapshot({ state: 'dismissed' }),
  });
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([overlap()], {
      counts: {
        new: 0,
        seen: 1,
        acted: 0,
        dismissed: 1,
        snoozed: 0,
        resolved: 0,
      },
    }),
  });
  const ref = refOf(r, MAIL_TITLE);
  const result = await r.bridge.change(ref, 'dismiss', null);
  assert.equal(result.ok, true);
  assert.deepEqual(
    r.bridge.view().entries.map((entry) => entry.title),
    [OVERLAP_TITLE],
  );
  // 消えた行の参照はもう使えない（何も送らない）。
  assert.deepEqual(
    await r.bridge.change(ref, 'open', null),
    fail('entry_not_found'),
  );
  assert.equal(r.posts().length, 1);
});

test('snooze needs a future UTC time; other events must not carry one', async () => {
  const r = rig();
  await r.bridge.list();
  const ref = refOf(r, MAIL_TITLE);
  assert.deepEqual(
    await r.bridge.change(ref, 'snooze', null),
    fail('invalid_request'),
  );
  // いまちょうど・過去は送らない。
  assert.deepEqual(
    await r.bridge.change(ref, 'snooze', '2030-10-09T03:00:00Z'),
    fail('invalid_request'),
  );
  assert.deepEqual(
    await r.bridge.change(ref, 'dismiss', '2030-10-10T03:00:00Z'),
    fail('invalid_request'),
  );
  assert.equal(r.posts().length, 0);
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: snapshot({ state: 'snoozed' }),
  });
  const result = await r.bridge.change(ref, 'snooze', '2030-10-10T03:00:00Z');
  assert.equal(result.ok, true);
  assert.deepEqual(r.posts()[0]?.body, {
    event: 'snooze',
    expected_state: 'new',
    snooze_until: '2030-10-10T03:00:00Z',
  });
});

test('an unknown ref sends nothing', async () => {
  const r = rig();
  await r.bridge.list();
  assert.deepEqual(
    await r.bridge.change(uuid(0xdead), 'open', null),
    fail('entry_not_found'),
  );
  assert.equal(r.posts().length, 0);
});

test('a conflict (409) re-reads and asks the screen to look again', async () => {
  const r = rig();
  await r.bridge.list();
  r.post = () => ({
    kind: 'response',
    status: 409,
    body: { error: 'conflict' },
  });
  r.list = () => ({
    kind: 'response',
    status: 200,
    body: listBody([overlap(), snapshot({ state: 'seen' })]),
  });
  assert.deepEqual(
    await r.bridge.change(refOf(r, MAIL_TITLE), 'open', null),
    fail('preview_stale'),
  );
  await r.bridge.refresh();
  assert.equal(r.bridge.view().entries[1]?.state, 'seen');
  // 読み直した状態を次の expected_state に使う。
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: snapshot({ state: 'dismissed' }),
  });
  await r.bridge.change(refOf(r, MAIL_TITLE), 'dismiss', null);
  assert.equal(r.posts()[1]?.body?.['expected_state'], 'seen');
});

test('a rejected input (422) is core_rejected', async () => {
  const r = rig();
  await r.bridge.list();
  r.post = () => ({
    kind: 'response',
    status: 422,
    body: { error: 'invalid_input' },
  });
  assert.deepEqual(
    await r.bridge.change(refOf(r, MAIL_TITLE), 'open', null),
    fail('core_rejected'),
  );
});

test('an unknown outcome is never resent: the row is held until a later read succeeds', async () => {
  const r = rig();
  await r.bridge.list();
  const ref = refOf(r, MAIL_TITLE);
  r.post = () => ({ kind: 'unknown' });
  assert.deepEqual(
    await r.bridge.change(ref, 'dismiss', null),
    fail('outcome_unknown'),
  );
  assert.deepEqual(r.logs, ['candidate_state_outcome_unknown']);
  const held = r.bridge.view().entries.find((entry) => entry.ref === ref);
  assert.equal(held?.delivery_unknown, true);
  // 二度押しでも送らない。
  assert.deepEqual(
    await r.bridge.change(ref, 'dismiss', null),
    fail('entry_not_found'),
  );
  assert.equal(r.posts().length, 1);
  // 次の読み取りが今の状態を示したら解く（行が残っていれば変更は当たっていない）。
  await r.bridge.list();
  assert.equal(
    r.bridge.view().entries.find((entry) => entry.ref === ref)
      ?.delivery_unknown,
    false,
  );
});

test('a 5xx or a malformed 2xx is an unknown outcome and triggers a re-read', async () => {
  for (const reply of [
    {
      kind: 'response',
      status: 503,
      body: { error: 'dependency_unavailable' },
    },
    { kind: 'response', status: 200, body: { candidate_id: MAIL } },
  ] as const) {
    const r = rig();
    await r.bridge.list();
    let reads = 0;
    const gate = new Promise<void>((resolve) => {
      r.list = () => {
        reads += 1;
        resolve();
        return { kind: 'response', status: 200, body: listBody() };
      };
    });
    r.post = () => reply;
    assert.deepEqual(
      await r.bridge.change(refOf(r, MAIL_TITLE), 'open', null),
      fail('outcome_unknown'),
    );
    await gate;
    await r.bridge.refresh();
    assert(reads >= 1);
    assert.equal(r.posts().length, 1);
  }
});

test('a generation change drops refs and in-flight reads; a change sent across it is unknown', async () => {
  const r = rig();
  await r.bridge.list();
  const ref = refOf(r, MAIL_TITLE);
  const seqBefore = r.bridge.view().list_seq;
  r.bridge.reset();
  const after = r.bridge.view();
  assert.equal(after.fetch, 'unavailable');
  assert.deepEqual(after.entries, []);
  assert(after.list_seq > seqBefore);
  assert.deepEqual(
    await r.bridge.change(ref, 'open', null),
    fail('entry_not_found'),
  );
  // 読み取りの途中で世代が進んだら、その結果を反映しない。
  let release: () => void = () => undefined;
  r.delay = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = r.bridge.list();
  await Promise.resolve();
  r.bridge.reset();
  release();
  assert.deepEqual(await pending, fail('not_connected'));
  assert.equal(r.bridge.view().fetch, 'unavailable');
  // 送った後に世代が進んだ変更は結果不明（送り直さない）。
  r.delay = null;
  await r.bridge.list();
  const fresh = refOf(r, MAIL_TITLE);
  r.delay = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: snapshot({ state: 'seen' }),
  });
  const sent = r.bridge.change(fresh, 'open', null);
  await Promise.resolve();
  r.bridge.reset();
  release();
  assert.deepEqual(await sent, fail('outcome_unknown'));
  assert.equal(r.posts().length, 1);
});

test('without a scope nothing is sent', async () => {
  const r = rig();
  await r.bridge.list();
  const ref = refOf(r, MAIL_TITLE);
  r.scope = null;
  assert.deepEqual(await r.bridge.list(), fail('not_connected'));
  assert.deepEqual(
    await r.bridge.change(ref, 'open', null),
    fail('not_connected'),
  );
  assert.equal(r.posts().length, 0);
});

// --- OS 通知の入・切とトレイの件数（ADR 0196） ---

test('the OS notification setting is read with the list; the tray count shows only while on and read', async () => {
  const r = rig();
  // 読めていない間は入とみなさない。
  assert.equal(r.bridge.alertEnabled(), false);
  assert.equal(r.bridge.trayCount(), null);
  await r.bridge.list();
  assert.equal(r.bridge.view().alert?.os_notification, 'off');
  assert.equal(r.bridge.trayCount(), null);
  r.alert = () => ({
    kind: 'response',
    status: 200,
    body: alertBody('on', '1'),
  });
  await r.bridge.list();
  assert.equal(r.bridge.alertEnabled(), true);
  assert.equal(r.bridge.trayCount(), 1);
  // 設定を読めなくなっても前の値のまま（「切」の証拠にしない）。ログはコードだけ。
  r.alert = () => ({ kind: 'response', status: 503, body: {} });
  await r.bridge.list();
  assert.equal(r.bridge.alertEnabled(), true);
  assert.deepEqual(r.logs, ['candidate_alert_settings_unavailable']);
  // 版は画面へ出さない。
  assert(
    !JSON.stringify(r.bridge.view()).includes(
      'candidate_alert_settings_revision',
    ),
  );
  // 世代が進んだら捨てる。
  r.bridge.reset();
  assert.equal(r.bridge.view().alert, null);
  assert.equal(r.bridge.trayCount(), null);
});

test('in the background the list is read only while the setting is on', async () => {
  const r = rig();
  await r.bridge.background();
  assert.deepEqual(
    r.calls.map((call) => call.path),
    ['/v1/candidates/alert-settings'],
  );
  assert.equal(r.bridge.view().fetch, 'unavailable');
  r.alert = () => ({
    kind: 'response',
    status: 200,
    body: alertBody('on', '1'),
  });
  await r.bridge.background();
  assert.deepEqual(
    r.calls.map((call) => call.path),
    [
      '/v1/candidates/alert-settings',
      '/v1/candidates/alert-settings',
      '/v1/candidates',
      '/v1/candidates/alert-settings',
    ],
  );
  assert.equal(r.bridge.trayCount(), 1);
});

test('a setting change carries the main revision, refuses a stale screen ref, and never resends', async () => {
  const r = rig();
  // 読めたことがない設定は変えない。
  assert.deepEqual(
    await r.bridge.changeAlert(uuid(0x999), 'on'),
    fail('entry_not_found'),
  );
  await r.bridge.list();
  const ref = r.bridge.view().alert?.ref as string;
  // 画面が古い参照を見ている: 送らない。
  assert.deepEqual(
    await r.bridge.changeAlert(uuid(0x999), 'on'),
    fail('preview_stale'),
  );
  assert.deepEqual(r.posts(), []);
  r.post = () => ({
    kind: 'response',
    status: 200,
    body: alertBody('on', '1'),
  });
  // 中枢の設定は変えた後の値になる（読み直しも同じ値を返す）。
  r.alert = () => ({
    kind: 'response',
    status: 200,
    body: alertBody('on', '1'),
  });
  const changed = await r.bridge.changeAlert(ref, 'on');
  assert.equal(changed.ok, true);
  assert.deepEqual(r.posts(), [
    {
      method: 'POST',
      path: '/v1/candidates/alert-settings',
      body: {
        expected_candidate_alert_settings_revision: '0',
        os_notification: 'on',
      },
      scoped: true,
      screenOperation: true,
      expectedScopeId: SCOPE,
    },
  ]);
  // 版が変わったので参照も新しい。入にしたので一覧を読み直した（トレイの件数）。
  const next = r.bridge.view().alert;
  assert.equal(next?.os_notification, 'on');
  assert.notEqual(next?.ref, ref);
  assert.equal(r.bridge.trayCount(), 1);
  // 別の画面で変わった（409）・結果が分からない: 送り直さず、設定を読み直す。
  for (const [outcome, reason] of [
    [{ kind: 'response', status: 409, body: {} }, 'preview_stale'],
    [{ kind: 'unknown' }, 'outcome_unknown'],
    [{ kind: 'response', status: 503, body: {} }, 'outcome_unknown'],
    [{ kind: 'response', status: 422, body: {} }, 'core_rejected'],
  ] as const) {
    const before = r.posts().length;
    r.post = () => outcome as Outcome;
    const current = r.bridge.view().alert?.ref as string;
    assert.deepEqual(
      await r.bridge.changeAlert(current, 'off'),
      fail(reason),
      reason,
    );
    assert.equal(r.posts().length, before + 1, reason);
  }
});
