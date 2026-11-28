// 気づきの画面の状態（candidate-state.ts。B11-05、ADR 0132）の試験。期待値は手で書く（基準は 2030-10-09（水）12:00 JST
// = 03:00Z）。見出しは中枢の応答の zone・fetched_at で分け、端末の OS のタイムゾーンを使わないこと、未取得を「候補なし」に
// しないこと、再通知の時刻を本人のタイムゾーンで決めること、409 で読み直すこと、世代をまたいだ応答を捨てることを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DesktopCandidateEntry,
  DesktopCandidateView,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import {
  CandidateStore,
  INITIAL_CANDIDATE_STATE,
  applyListResponse,
  candidateSections,
  deadlineText,
  headerOf,
  rowActions,
  rowNotes,
  snoozePreview,
  zonedText,
} from './candidate-state.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2030-10-09T03:00:00.000Z');

const entry = (
  n: number,
  overrides: Partial<DesktopCandidateEntry> = {},
): DesktopCandidateEntry => ({
  ref: id(n),
  position: n,
  kind: 'mail_reply',
  state: 'new',
  title: `合成の気づき ${n}`,
  deadline: { kind: 'none' },
  initial_import: false,
  unread_partial: false,
  has_operations: false,
  auto_actions: [],
  auto_actions_unlisted: 0,
  delivery_unknown: false,
  ...overrides,
});

const date = (value: string) =>
  ({ kind: 'date', date: value, original_text: '期限' }) as const;

const view = (
  entries: DesktopCandidateEntry[],
  overrides: Partial<DesktopCandidateView> = {},
): DesktopCandidateView => ({
  fetch: 'loaded',
  fetched_at: '2030-10-09T03:00:00Z',
  zone: 'Asia/Tokyo',
  counts: { new: 2, seen: 1, acted: 0, dismissed: 0, snoozed: 0, resolved: 0 },
  entries,
  truncated: false,
  list_seq: 2,
  alert: null,
  auto_action_fetch: 'loaded',
  ...overrides,
});

// 中枢の順（position）で並んだ 6 件。
const SIX = [
  entry(0, {
    kind: 'schedule_overlap',
    deadline: {
      kind: 'instant',
      local_datetime: '2030-10-09T15:00:00',
      zone: 'Asia/Tokyo',
      original_text: '15:00',
    },
  }),
  entry(1, { deadline: date('2030-10-10') }),
  entry(2, { kind: 'mail_deadline', deadline: date('2030-10-12') }),
  entry(3, { kind: 'mail_deadline', deadline: date('2030-10-14') }),
  entry(4),
  entry(5, { initial_import: true, deadline: date('2030-09-01') }),
];

test('sections follow the domain headings for the hub zone and time, in hub order', () => {
  // 画面の配列の順を崩しても、見出しの中は position の順。
  const result = candidateSections(view([...SIX].reverse()));
  assert.equal(result.headed, true);
  assert.deepEqual(
    result.sections.map((section) => [
      section.heading,
      section.label,
      section.collapsed,
      section.entries.map((item) => item.position),
    ]),
    [
      ['today', '今日', false, [0]],
      ['tomorrow', '明日', false, [1]],
      ['this_week', '今週', false, [2]],
      ['later', 'それ以降', false, [3]],
      ['unknown', '期限不明', false, [4]],
      ['initial_import_past', '初回取り込み（過去の期限）', true, [5]],
    ],
  );
  // 同じ一覧でも本人のタイムゾーンが違えば見出しが変わる。03:00Z は Honolulu では 10/8（火）17:00。10-09 15:00 JST
  // （06:00Z）の予定は Honolulu の 10/8 20:00 なので「今日」、日付だけの 10-10 は 2 日後で同じ週（月〜日）なので「今週」。
  const honolulu = candidateSections(
    view(SIX.slice(0, 2), { zone: 'Pacific/Honolulu' }),
  );
  assert.deepEqual(
    honolulu.sections.map((section) => section.heading),
    ['today', 'this_week'],
  );
});

test('without a zone or a time the list is shown flat in hub order (no device zone fallback)', () => {
  for (const missing of [{ zone: null }, { fetched_at: null }]) {
    const result = candidateSections(view([...SIX].reverse(), missing));
    assert.equal(result.headed, false);
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0]?.label, null);
    assert.deepEqual(
      result.sections[0]?.entries.map((item) => item.position),
      [0, 1, 2, 3, 4, 5],
    );
  }
  assert.deepEqual(candidateSections(view([])).sections, []);
});

test('deadlines: date-only says so and shows no time; other zones are named; unresolved keeps the words', () => {
  assert.equal(
    deadlineText(date('2030-10-10'), 'Asia/Tokyo'),
    '10/10（日付のみの期限）',
  );
  const instant = {
    kind: 'instant',
    local_datetime: '2030-10-09T15:00:00',
    zone: 'Asia/Tokyo',
    original_text: '15:00',
  } as const;
  assert.equal(deadlineText(instant, 'Asia/Tokyo'), '10/9 15:00');
  assert.equal(
    deadlineText({ ...instant, zone: 'America/New_York' }, 'Asia/Tokyo'),
    '10/9 15:00（America/New_York）',
  );
  assert.equal(deadlineText({ kind: 'none' }, 'Asia/Tokyo'), '期限なし');
  assert.equal(
    deadlineText(
      { kind: 'unresolved', reason: 'relative', original_text: '来週中' },
      'Asia/Tokyo',
    ),
    '期限は未確定（「来週中」）',
  );
});

test('row notes and actions follow the domain rules', () => {
  // 結び付いた自動実行の操作は注記ではなく行の中の欄で出す（ADR 0199）。
  assert.deepEqual(
    rowNotes(entry(1, { unread_partial: true, has_operations: true })),
    ['対応済みかは未確認', '本文・添付の一部は未読'],
  );
  assert.deepEqual(rowNotes(entry(0, { kind: 'schedule_overlap' })), []);
  assert.deepEqual(rowActions(entry(1)), ['open', 'snooze', 'dismiss']);
  assert.deepEqual(rowActions(entry(1, { state: 'seen' })), [
    'snooze',
    'dismiss',
  ]);
  assert.deepEqual(rowActions(entry(1, { state: 'acted' })), []);
});

test('the header shows the last fetch in the person zone, the fetch state and the new count; nothing read is unavailable', () => {
  assert.equal(zonedText('2030-10-09T03:00:00Z', 'Asia/Tokyo'), '10/9 12:00');
  assert.equal(zonedText('2030-10-09T03:00:00Z', null), null);
  assert.deepEqual(headerOf(null), {
    fetch: 'unavailable',
    fetchedText: null,
    newCount: null,
  });
  assert.deepEqual(headerOf(view(SIX, { fetch: 'stale' })), {
    fetch: 'stale',
    fetchedText: '10/9 12:00',
    newCount: 2,
  });
  assert.equal(snoozePreview('tomorrow', NOW, 'Asia/Tokyo'), '10/10 12:00');
  assert.equal(snoozePreview('next_week', NOW, 'Asia/Tokyo'), '10/16 12:00');
  assert.equal(snoozePreview('tomorrow', NOW, null), null);
});

test('an older list from main never replaces a newer one', () => {
  const newer = applyListResponse(INITIAL_CANDIDATE_STATE, {
    request_id: id(0x900),
    channel: 'desktop.candidates_list',
    outcome: 'ok',
    candidates: view(SIX, { list_seq: 5 }),
  });
  const older = applyListResponse(newer, {
    request_id: id(0x901),
    channel: 'desktop.candidates_list',
    outcome: 'ok',
    candidates: view([], { list_seq: 4 }),
  });
  assert.equal(older.view?.entries.length, 6);
  assert.equal(older.seq, 5);
});

// --- 状態の持ち主 ---

interface Pending {
  readonly request: DesktopIpcRequest;
  readonly resolve: (response: DesktopIpcResponse) => void;
  readonly reject: (error: Error) => void;
}

function harness(now = NOW) {
  const pending: Pending[] = [];
  // 気づきの欄で取り消した後に、自動実行の欄の読み直しを頼んだ回数（ADR 0199）。
  const autoRefreshes: number[] = [];
  const store = new CandidateStore(
    {
      invoke: (request) =>
        new Promise<DesktopIpcResponse>((resolve, reject) => {
          pending.push({ request, resolve, reject });
        }),
    },
    () => now,
    () => autoRefreshes.push(1),
  );
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
  return { store, pending, answer, autoRefreshes };
}

const listed = (v: DesktopCandidateView) => ({
  outcome: 'ok' as const,
  candidates: v,
});

test('refresh asks main for the list and shows it', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  assert.equal(store.snapshot().reading, true);
  assert.deepEqual(
    pending.map((item) => [item.request.channel, item.request.payload]),
    [['desktop.candidates_list', null]],
  );
  await answer(listed(view(SIX)));
  assert.equal(store.snapshot().reading, false);
  assert.equal(store.snapshot().view?.entries.length, 6);
});

test('open and dismiss send the ref only, once at a time, and show the re-read list', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view(SIX)));
  store.actions.open(id(1));
  // 結果を待つ間は次の操作を送らない。
  store.actions.dismiss(id(2));
  assert.deepEqual(
    pending.map((item) => [item.request.channel, item.request.payload]),
    [
      [
        'desktop.candidate_state',
        { ref: id(1), event: 'open', snooze_until: null },
      ],
    ],
  );
  assert.equal(store.snapshot().busy, id(1));
  await answer(
    listed(
      view(
        SIX.map((item) =>
          item.position === 1 ? { ...item, state: 'seen' as const } : item,
        ),
        { list_seq: 3 },
      ),
    ),
  );
  assert.equal(store.snapshot().busy, null);
  assert.equal(store.snapshot().view?.entries[1]?.state, 'seen');
  assert.equal(store.snapshot().notice, null);
  store.actions.dismiss(id(2));
  await answer(
    listed(
      view(
        SIX.filter((item) => item.position !== 2),
        { list_seq: 4 },
      ),
    ),
  );
  assert.equal(store.snapshot().notice?.tone, 'success');
  assert.equal(store.snapshot().notice?.ref, null);
  assert.equal(store.snapshot().view?.entries.length, 5);
});

test('snooze choices are read in the person zone from the list, not the device zone', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view(SIX)));
  store.actions.startSnooze(id(1));
  store.actions.snooze(id(1), 'tomorrow');
  assert.deepEqual(pending.at(-1)?.request.payload, {
    ref: id(1),
    event: 'snooze',
    snooze_until: '2030-10-10T03:00:00Z',
  });
  await answer(listed(view(SIX, { list_seq: 3 })));
  store.actions.startSnooze(id(1));
  store.actions.snooze(id(1), 'next_week');
  assert.deepEqual(pending.at(-1)?.request.payload, {
    ref: id(1),
    event: 'snooze',
    snooze_until: '2030-10-16T03:00:00Z',
  });
  await answer(listed(view(SIX, { list_seq: 4 })));
  // 日時の指定は本人のタイムゾーンの現地の日時（18:30 JST = 09:30Z）。
  store.actions.startSnooze(id(1));
  store.actions.setSnoozeInput('2030-10-09T18:30');
  store.actions.snooze(id(1), 'at');
  assert.deepEqual(pending.at(-1)?.request.payload, {
    ref: id(1),
    event: 'snooze',
    snooze_until: '2030-10-09T09:30:00Z',
  });
  await answer(listed(view(SIX, { list_seq: 5 })));
  assert.equal(store.snapshot().snooze, null);
});

test('a past or empty snooze time is not sent; without a zone nothing is decided', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view(SIX)));
  store.actions.startSnooze(id(1));
  store.actions.setSnoozeInput('2030-10-09T11:00');
  store.actions.snooze(id(1), 'at');
  assert.equal(pending.length, 0);
  assert.equal(
    store.snapshot().snooze?.problem,
    '今より後の日時を選んでください。',
  );
  store.actions.setSnoozeInput('');
  store.actions.snooze(id(1), 'at');
  assert.equal(pending.length, 0);
  assert.equal(
    store.snapshot().snooze?.problem,
    '日付と時刻を入れてください。',
  );
  // 本人のタイムゾーンが分からない一覧では、再通知の日時を決めない。
  store.actions.refresh();
  await answer(listed(view(SIX, { zone: null, list_seq: 3 })));
  store.actions.snooze(id(1), 'tomorrow');
  assert.equal(pending.length, 0);
  assert.equal(store.snapshot().notice?.tone, 'warning');
});

test('a conflict shows a notice on the row and re-reads the list', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view(SIX)));
  store.actions.dismiss(id(1));
  await answer({ outcome: 'rejected', reason: 'preview_stale' });
  assert.equal(store.snapshot().notice?.ref, id(1));
  assert.deepEqual(
    pending.map((item) => item.request.channel),
    ['desktop.candidates_list'],
  );
  await answer(
    listed(
      view(
        SIX.map((item) =>
          item.position === 1 ? { ...item, state: 'seen' as const } : item,
        ),
        { list_seq: 3 },
      ),
    ),
  );
  // 読み直した一覧を出し、文言は残す。
  assert.equal(store.snapshot().view?.entries[1]?.state, 'seen');
  assert.equal(store.snapshot().notice?.ref, id(1));
});

test('an unknown outcome is not resent; a failed read keeps the fetch state honest', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer({ outcome: 'rejected', reason: 'not_connected' });
  // 読めていないので一覧はなく、「気づきはありません」にもならない。
  assert.equal(store.snapshot().view, null);
  assert.equal(headerOf(store.snapshot().view).fetch, 'unavailable');
  assert.equal(store.snapshot().notice?.ref, null);
  store.actions.refresh();
  await answer(listed(view(SIX)));
  store.actions.dismiss(id(1));
  await answer({ outcome: 'rejected', reason: 'outcome_unknown' });
  assert.equal(pending.length, 0);
  assert.match(store.snapshot().notice?.text ?? '', /自動では送り直しません/u);
});

test('hide drops the content and ignores late responses', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view(SIX)));
  store.actions.open(id(1));
  store.hide();
  assert.deepEqual(store.snapshot(), INITIAL_CANDIDATE_STATE);
  await answer(listed(view(SIX, { list_seq: 9 })));
  assert.deepEqual(store.snapshot(), INITIAL_CANDIDATE_STATE);
  assert.equal(pending.length, 0);
});

test('an IPC failure says so without inventing a list', async () => {
  const { store, pending } = harness();
  store.actions.refresh();
  pending.shift()?.reject(new Error('ipc'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot().view, null);
  assert.equal(store.snapshot().reading, false);
  assert.equal(store.snapshot().notice?.tone, 'warning');
});

// --- OS の通知の入・切（ADR 0196） ---

const ALERT_REF = '00000000-0000-4000-8000-0000000000a1';
const NEW_ALERT_REF = '00000000-0000-4000-8000-0000000000a2';

test('the OS notification choice sends the settings ref and the value only, once at a time', async () => {
  const { store, pending, answer } = harness();
  // 設定を読めていない間は送らない。
  store.actions.refresh();
  await answer(listed(view(SIX)));
  store.actions.setAlert('on');
  assert.equal(pending.length, 0);
  store.actions.refresh();
  await answer(
    listed(
      view(SIX, {
        list_seq: 3,
        alert: { ref: ALERT_REF, os_notification: 'off' },
      }),
    ),
  );
  store.actions.setAlert('on');
  // 結果を待つ間は次の変更を送らない。
  store.actions.setAlert('off');
  assert.deepEqual(
    pending.map((item) => [item.request.channel, item.request.payload]),
    [
      [
        'desktop.candidate_alert_setting',
        { settings_ref: ALERT_REF, os_notification: 'on' },
      ],
    ],
  );
  assert.equal(store.snapshot().alertBusy, true);
  await answer(
    listed(
      view(SIX, {
        list_seq: 4,
        alert: { ref: NEW_ALERT_REF, os_notification: 'on' },
      }),
    ),
  );
  assert.equal(store.snapshot().alertBusy, false);
  assert.equal(store.snapshot().view?.alert?.os_notification, 'on');
  assert.equal(store.snapshot().notice?.tone, 'success');
  assert.match(
    store.snapshot().notice?.text ?? '',
    /今ある気づきは知らせません/u,
  );
});

test('a stale or unknown OS notification change stays locked until the re-read list arrives', async () => {
  for (const reason of ['preview_stale', 'outcome_unknown'] as const) {
    const { store, pending, answer } = harness();
    store.actions.refresh();
    await answer(
      listed(view(SIX, { alert: { ref: ALERT_REF, os_notification: 'off' } })),
    );
    store.actions.setAlert('on');
    await answer({ outcome: 'rejected', reason });
    assert.equal(store.snapshot().notice?.tone, 'warning', reason);
    assert.equal(store.snapshot().alertBusy, true, reason);
    // 読み直しを待つ間は押しても送らない。
    store.actions.setAlert('on');
    assert.deepEqual(
      pending.map((item) => item.request.channel),
      ['desktop.candidates_list'],
      reason,
    );
    await answer(
      listed(
        view(SIX, {
          list_seq: 3,
          alert: { ref: NEW_ALERT_REF, os_notification: 'on' },
        }),
      ),
    );
    assert.equal(store.snapshot().alertBusy, false, reason);
    assert.equal(store.snapshot().view?.alert?.ref, NEW_ALERT_REF, reason);
    // 断った理由の文言は残す。
    assert.equal(store.snapshot().notice?.tone, 'warning', reason);
  }
});

test('another refusal of the OS notification change unlocks at once and never resends', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(
    listed(view(SIX, { alert: { ref: ALERT_REF, os_notification: 'on' } })),
  );
  store.actions.setAlert('off');
  await answer({ outcome: 'rejected', reason: 'core_rejected' });
  assert.equal(store.snapshot().alertBusy, false);
  assert.equal(pending.length, 0);
  assert.equal(store.snapshot().view?.alert?.os_notification, 'on');
});

// --- 結び付いた自動実行の取り消し（ADR 0199） ---

const AUTO_REF = id(0xa01);
const LOCKED_REF = id(0xa02);
const LINKED = entry(1, {
  has_operations: true,
  auto_actions: [
    {
      ref: AUTO_REF,
      position: 0,
      kind: 'label_mail',
      completed_at: '2030-10-09T02:00:00Z',
      undo_state: 'available',
      undo_deadline: '2030-10-19T02:00:00Z',
      delivery_unknown: false,
    },
    {
      ref: LOCKED_REF,
      position: 1,
      kind: 'draft_reply',
      completed_at: '2030-10-09T01:00:00Z',
      undo_state: 'unavailable',
      undo_deadline: '2030-10-19T01:00:00Z',
      delivery_unknown: false,
    },
  ],
  auto_actions_unlisted: 1,
});

test('undo of a linked automatic operation sends only its ref on the auto-action channel, once at a time, then re-reads', async () => {
  const { store, pending, answer, autoRefreshes } = harness();
  store.actions.refresh();
  await answer(listed(view([LINKED, entry(2)])));
  store.actions.undoAutoAction(id(1), AUTO_REF);
  // 結果を待つ間は、次の取り消しも状態の変更も送らない。
  store.actions.undoAutoAction(id(1), AUTO_REF);
  store.actions.dismiss(id(2));
  assert.deepEqual(
    pending.map((item) => [item.request.channel, item.request.payload]),
    [['desktop.auto_action_undo', { ref: AUTO_REF }]],
  );
  assert.equal(store.snapshot().busy, AUTO_REF);
  await answer({
    outcome: 'ok',
    auto_actions: {
      fetch: 'loaded',
      fetched_at: '2030-10-09T03:00:00Z',
      safety: null,
      entries: [],
      list_seq: 5,
    },
  });
  assert.equal(store.snapshot().busy, null);
  assert.deepEqual(store.snapshot().notice, {
    tone: 'success',
    text: '取り消しを受け付けました。元に戻ったかは、この欄を読み直すと確かめられます。',
    ref: id(1),
  });
  // 受け付けたら気づきの一覧を読み直し、自動実行の欄にも読み直しを頼む。
  assert.deepEqual(
    pending.map((item) => [item.request.channel, item.request.payload]),
    [['desktop.candidates_list', null]],
  );
  assert.deepEqual(autoRefreshes, [1]);
  const undone = {
    ...LINKED,
    auto_actions: LINKED.auto_actions.map((item) =>
      item.ref === AUTO_REF
        ? { ...item, undo_state: 'in_progress' as const }
        : item,
    ),
  };
  await answer(listed(view([undone, entry(2)], { list_seq: 3 })));
  assert.equal(
    store.snapshot().view?.entries[0]?.auto_actions[0]?.undo_state,
    'in_progress',
  );
  // 文言は読み直しの後も残す。
  assert.equal(store.snapshot().notice?.ref, id(1));
});

test('an unavailable, unknown, expired or unknown-ref automatic operation is not sent', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([LINKED])));
  // 取り消せない（unavailable）。
  store.actions.undoAutoAction(id(1), LOCKED_REF);
  // 知らない参照・別の行の参照。
  store.actions.undoAutoAction(id(1), id(0xbad));
  store.actions.undoAutoAction(id(2), AUTO_REF);
  assert.equal(pending.length, 0);
  // 取り消しの結果が分からない行・画面の時計で期限を過ぎた行も送らない。
  for (const over of [
    { delivery_unknown: true },
    { undo_deadline: '2030-10-09T02:59:59Z' },
  ]) {
    const { store: other, pending: queue, answer: reply } = harness();
    other.actions.refresh();
    await reply(
      listed(
        view([
          {
            ...LINKED,
            auto_actions: LINKED.auto_actions
              .slice(0, 1)
              .map((item) => ({ ...item, ...over })),
          },
        ]),
      ),
    );
    other.actions.undoAutoAction(id(1), AUTO_REF);
    assert.equal(queue.length, 0, JSON.stringify(over));
    assert.equal(other.snapshot().busy, null);
  }
});

test('a refused or unknown undo shows the auto-action words on the row, never resends, and re-reads', async () => {
  for (const [reason, words] of [
    [
      'undo_target_changed',
      /対象がその後に変わっていたため、自動では元に戻しませんでした/u,
    ],
    ['outcome_unknown', /自動では送り直しません/u],
    ['preview_stale', /期限切れ・取り消し済みなど/u],
  ] as const) {
    const { store, pending, answer, autoRefreshes } = harness();
    store.actions.refresh();
    await answer(listed(view([LINKED])));
    store.actions.undoAutoAction(id(1), AUTO_REF);
    await answer({ outcome: 'rejected', reason });
    assert.equal(store.snapshot().notice?.ref, id(1), reason);
    assert.equal(store.snapshot().notice?.tone, 'warning', reason);
    assert.match(store.snapshot().notice?.text ?? '', words);
    assert.equal(store.snapshot().busy, null);
    // 送り直さず、一覧の読み直しだけ。
    assert.deepEqual(
      pending.map((item) => item.request.channel),
      ['desktop.candidates_list'],
      reason,
    );
    assert.deepEqual(autoRefreshes, [1]);
  }
});

test('an undo answered after hide (lock) is dropped without a re-read', async () => {
  const { store, pending, answer, autoRefreshes } = harness();
  store.actions.refresh();
  await answer(listed(view([LINKED])));
  store.actions.undoAutoAction(id(1), AUTO_REF);
  store.hide();
  await answer({ outcome: 'rejected', reason: 'outcome_unknown' });
  assert.deepEqual(store.snapshot(), INITIAL_CANDIDATE_STATE);
  assert.equal(pending.length, 0);
  assert.deepEqual(autoRefreshes, []);
});

test('reload from the automatic-operation panel re-reads the list and keeps the row words', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([LINKED])));
  store.actions.undoAutoAction(id(1), AUTO_REF);
  await answer({ outcome: 'rejected', reason: 'confirmation_pending' });
  // 同じ操作を自動実行の欄から送っている途中の文言（自動実行の欄と同じ）。
  assert.equal(
    store.snapshot().notice?.text,
    'この操作の取り消しは送っている途中です。結果が出るまで待ってください。',
  );
  await answer(listed(view([LINKED], { list_seq: 3 })));
  // 自動実行の欄で取り消した後の読み直し（reload）は、行の文言を消さずに写しを新しくする。
  store.actions.reload();
  assert.deepEqual(
    pending.map((item) => item.request.channel),
    ['desktop.candidates_list'],
  );
  const undone = {
    ...LINKED,
    auto_actions: LINKED.auto_actions.map((item) => ({
      ...item,
      undo_state: 'undone' as const,
    })),
  };
  await answer(listed(view([undone], { list_seq: 4 })));
  assert.equal(
    store.snapshot().view?.entries[0]?.auto_actions[0]?.undo_state,
    'undone',
  );
  assert.equal(store.snapshot().notice?.ref, id(1));
  // 取り消し済みになった写しでは送らない。
  store.actions.undoAutoAction(id(1), AUTO_REF);
  assert.equal(pending.length, 0);
});
