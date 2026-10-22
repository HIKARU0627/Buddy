// 会話・変更の確認・処理状況の状態の試験（B04-05、ADR 0031）。期待値の文言は手で書く。
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import type {
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopOperationEntry,
  DesktopOperationPreview,
} from '@buddy/contracts';
import {
  INITIAL_WORK_STATE,
  applyApproveResponse,
  applyCommandResponse,
  applyPreviewResponse,
  applyTurnResponse,
  changeRows,
  entryActions,
  groupOperations,
  markPreviewLoading,
  operationFailureText,
  operationNote,
  operationStatus,
  rowSubtitle,
  rowTitle,
  scheduleText,
  syncOperations,
  WorkStore,
  workActions,
} from './work-state.js';
import type { WorkViewState } from './work-state.js';

const test = (name: string, fn: () => void | Promise<void>) =>
  nodeTest(name, { timeout: 10_000 }, fn);

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const entry = (
  overrides: Partial<DesktopOperationEntry> = {},
): DesktopOperationEntry => ({
  ref: id(1),
  operation_kind: 'task.create',
  state: 'awaiting_approval',
  approval_state: 'none',
  allowed_actions: ['preview', 'approve', 'cancel'],
  result: null,
  state_revision: '1',
  delivery_unknown: false,
  headline: null,
  detail: null,
  ...overrides,
});

const rejected = (
  reason: Extract<DesktopIpcResponse, { outcome: 'rejected' }>['reason'],
  channel: DesktopIpcRequest['channel'] = 'desktop.operation_approve',
): DesktopIpcResponse => ({
  request_id: id(9),
  channel,
  outcome: 'rejected',
  reason,
});

const previewOf = (): DesktopOperationPreview => ({
  preview_ref: id(0x20),
  operation_kind: 'mail.labels.change',
  service: 'mock',
  target: 'mail-001',
  fields: [
    { field: 'labels_add', values: ['follow-up'] },
    { field: 'labels_remove', values: ['inbox', 'todo'] },
  ],
  account_label: 'user@example.com',
  target_detail: {
    subject: '来週の打ち合わせ',
    sender: 'sato@example.com',
    received_at: '2026-10-04T18:30:00+09:00',
  },
  approvable: true,
});

test('every operation state has its own sentence, symbol and tone, and no code or API name', () => {
  const expected: [DesktopOperationEntry['state'], string, string, string][] = [
    ['awaiting_approval', '承認待ち', 'circle', 'warning'],
    ['approved', '承認しました。実行を待っています', 'spinner', 'neutral'],
    ['preparing', '実行を準備しています', 'spinner', 'neutral'],
    ['dispatching', '実行しています', 'spinner', 'neutral'],
    ['reconciling', '結果を確認しています', 'spinner', 'neutral'],
    ['succeeded', '完了しました', 'dot', 'success'],
    ['unknown_held', '結果を確認できませんでした', 'warning', 'danger'],
    ['not_executed', '実行されませんでした', 'square', 'neutral'],
    ['cancelled', '取り消しました', 'square', 'neutral'],
    [
      'superseded',
      '内容が更新されたため、この操作は使われません',
      'square',
      'neutral',
    ],
  ];
  for (const [state, text, mark, tone] of expected) {
    const line = operationStatus(entry({ state }));
    assert.deepEqual(
      [line.text, line.mark, line.tone],
      [text, mark, tone],
      state,
    );
    assert.doesNotMatch(line.text, /[A-Za-z_]{4,}|unknown|held|API/u, state);
  }
  // 承認の期限切れ・取消は、承認待ちの理由として言う。
  assert.equal(
    operationStatus(entry({ approval_state: 'expired' })).text,
    '承認の期限が切れました',
  );
  assert.equal(
    operationStatus(entry({ approval_state: 'revoked' })).text,
    '承認が取り消されました',
  );
  // 命令が届いたか分からない保留は、状態より優先して言う。
  assert.equal(
    operationStatus(entry({ delivery_unknown: true })).text,
    '命令が届いたか確かめられていません',
  );
});

test('an unknown result offers reconcile, never a resend; a held command offers nothing', () => {
  const unknown = entry({
    state: 'unknown_held',
    allowed_actions: ['reconcile'],
  });
  assert.deepEqual(entryActions(unknown), {
    preview: false,
    cancel: false,
    reconcile: true,
    retry: false,
    check: false,
  });
  assert.match(
    operationNote(unknown) ?? '',
    /自動では送り直しません。「照合」/u,
  );
  // 結果不明の操作には、retry を許可していても再試行を出さない（再試行は、実行されなかったと確定したときだけ）。
  assert.equal(
    entryActions(
      entry({ state: 'unknown_held', allowed_actions: ['reconcile', 'retry'] }),
    ).retry,
    false,
  );
  // 命令の結果不明の保留には、読み取りだけで確かめる操作だけを出す（命令の再送・取消・再試行は出さない）。
  assert.deepEqual(entryActions(entry({ delivery_unknown: true })), {
    preview: false,
    cancel: false,
    reconcile: false,
    retry: false,
    check: true,
  });
  assert.deepEqual(entryActions(entry()), {
    preview: true,
    cancel: true,
    reconcile: false,
    retry: false,
    check: false,
  });
  assert.match(
    operationNote(entry({ delivery_unknown: true })) ?? '',
    /自動では送り直しません/u,
  );
});

test('operations are grouped: waiting and unknown need attention, running, and the latest finished ones', () => {
  const list = [
    entry({ ref: id(1), state: 'awaiting_approval' }),
    entry({
      ref: id(2),
      state: 'unknown_held',
      allowed_actions: ['reconcile'],
    }),
    entry({ ref: id(3), state: 'preparing' }),
    entry({ ref: id(4), state: 'approved' }),
    entry({ ref: id(5), state: 'approved', delivery_unknown: true }),
    ...[6, 7, 8, 9, 10, 11, 12].map((n) =>
      entry({ ref: id(n), state: 'succeeded', allowed_actions: [] }),
    ),
  ];
  const groups = groupOperations(list);
  assert.deepEqual(
    groups.attention.map((item) => item.ref),
    [id(1), id(2), id(5)],
  );
  assert.deepEqual(
    groups.running.map((item) => item.ref),
    [id(3), id(4)],
  );
  assert.equal(groups.finished.length, 5);
  assert.equal(groups.hiddenFinished, 2);
});

test('the change table shows before and after for every kind of change', () => {
  assert.deepEqual(
    changeRows(previewOf()).map((row) => [row.name, row.before, row.after]),
    [
      ['付けるラベル', '付いていません', 'follow-up'],
      ['外すラベル', 'inbox、todo', '外します'],
    ],
  );
  const draft = changeRows({
    preview_ref: id(1),
    operation_kind: 'mail.draft.create',
    service: 'gmail',
    target: 'x',
    fields: [
      { field: 'draft_to', values: ['a@example.com'] },
      { field: 'draft_body', values: ['こんにちは\nよろしく'] },
    ],
    account_label: null,
    target_detail: null,
    approvable: false,
  });
  assert.deepEqual(
    draft.map((row) => [row.name, row.before, row.after, row.long]),
    [
      ['宛先', 'なし', 'a@example.com', false],
      ['本文', 'なし', 'こんにちは\nよろしく', true],
    ],
  );
});

test('schedule counts use no-break spaces and say what is not shown', () => {
  const base = {
    kind: 'schedule_cards',
    status: 'needs_review',
    intent: 'query_schedule',
    event_count: 0,
    overlap_count: 0,
    more_count: 0,
    operation_ref: null,
  } as const;
  const note = 'この画面では、予定の件名と時刻はまだ表示できません。';
  assert.equal(scheduleText(base), `取得した予定はありません。${note}`);
  assert.equal(
    scheduleText({ ...base, event_count: 3, overlap_count: 2, more_count: 4 }),
    `取得した予定は3\u00a0件です。そのうち2\u00a0件は、時間が重なっています。ほか4\u00a0件は、集計に含めていません。${note}`,
  );
  assert.equal(
    scheduleText({ ...base, event_count: 1 }),
    `取得した予定は1\u00a0件です。${note}`,
  );
});

test('a turn answer is added to the conversation and the draft is cleared; a failure keeps the draft under the field', () => {
  const sending: WorkViewState = {
    ...INITIAL_WORK_STATE,
    draft: '  今日の予定を見せて  ',
    sending: true,
  };
  const answered = applyTurnResponse(sending, {
    request_id: id(1),
    channel: 'desktop.turn_submit',
    outcome: 'ok',
    turn: {
      status: 'clarification',
      reply_text: 'どのメールのことか教えてください。',
      result: null,
    },
  });
  assert.deepEqual(
    answered.messages.map((message) => [
      message.role,
      message.text,
      message.clarification,
    ]),
    [
      ['user', '今日の予定を見せて', false],
      ['buddy', 'どのメールのことか教えてください。', true],
    ],
  );
  assert.equal(answered.draft, '');
  assert.equal(answered.sending, false);
  const failed = applyTurnResponse(
    sending,
    rejected('outcome_unknown', 'desktop.turn_submit'),
  );
  assert.equal(failed.draft, '  今日の予定を見せて  ');
  assert.equal(failed.messages.length, 0);
  assert.equal(failed.sending, false);
  assert.match(failed.turnNotice?.text ?? '', /自動では送り直しません。/u);
  // 承認が要る操作を作った答えは、まだ何も実行していないと言う。
  const approval = applyTurnResponse(sending, {
    request_id: id(2),
    channel: 'desktop.turn_submit',
    outcome: 'ok',
    turn: {
      status: 'answered',
      reply_text: null,
      result: {
        kind: 'approval_link',
        status: 'needs_review',
        intent: 'create_task',
        event_count: 0,
        overlap_count: 0,
        more_count: 0,
        operation_ref: id(5),
      },
    },
  });
  assert.match(approval.messages[1]?.text ?? '', /まだ何も実行していません。/u);
});

test('an approval declined or stale leaves a sentence under the row; a sent approval closes the confirmation', () => {
  const open: WorkViewState = {
    ...INITIAL_WORK_STATE,
    preview: { ref: id(1), seq: 1, preview: previewOf(), approving: true },
  };
  // 「やめる」: 確認は残してやり直せる。承認していないと言う。
  const declined = applyApproveResponse(
    open,
    id(1),
    1,
    rejected('confirmation_declined'),
  );
  assert.equal(declined.preview?.approving, false);
  assert.equal(
    declined.notices[id(1)]?.text,
    '確認で「やめる」を選んだため、承認していません。',
  );
  // 内容が変わった・結果が分からない: 確認を閉じて、行のすぐ下に出す。
  for (const reason of [
    'preview_stale',
    'outcome_unknown',
    'entry_not_found',
  ] as const) {
    const closed = applyApproveResponse(open, id(1), 1, rejected(reason));
    assert.equal(closed.preview, null, reason);
    assert.equal(closed.notices[id(1)]?.tone, 'warning', reason);
  }
  assert.match(
    operationFailureText('desktop.operation_approve', 'outcome_unknown'),
    /届いたか確かめられませんでした。自動では送り直しません。/u,
  );
  const sent = applyApproveResponse(open, id(1), 1, {
    request_id: id(2),
    channel: 'desktop.operation_approve',
    outcome: 'ok',
    receipt: 'accepted',
  });
  assert.equal(sent.preview, null);
  assert.equal(sent.notices[id(1)]?.tone, 'success');
  // 別の操作の応答は無視する。
  assert.equal(
    applyApproveResponse(open, id(7), 1, rejected('preview_stale')),
    open,
  );
});

test('a preview for another operation or after closing is ignored; a failed preview shows a sentence', () => {
  const loading = markPreviewLoading(INITIAL_WORK_STATE, id(1), 1);
  const ok = applyPreviewResponse(loading, id(1), 1, {
    request_id: id(2),
    channel: 'desktop.operation_preview',
    outcome: 'ok',
    preview: previewOf(),
  });
  assert.equal(ok.preview?.preview?.preview_ref, id(0x20));
  assert.equal(
    applyPreviewResponse(loading, id(2), 1, {
      request_id: id(2),
      channel: 'desktop.operation_preview',
      outcome: 'ok',
      preview: previewOf(),
    }),
    loading,
  );
  const failed = applyPreviewResponse(
    loading,
    id(1),
    1,
    rejected('core_rejected', 'desktop.operation_preview'),
  );
  assert.equal(failed.preview, null);
  assert.match(
    failed.notices[id(1)]?.text ?? '',
    /内容を確かめられませんでした。/u,
  );
});

test('a command response clears busy and says what was asked; reconcile is not a resend', () => {
  const busy: WorkViewState = { ...INITIAL_WORK_STATE, busy: [id(1)] };
  const reconciled = applyCommandResponse(
    busy,
    id(1),
    'desktop.operation_reconcile',
    {
      request_id: id(2),
      channel: 'desktop.operation_reconcile',
      outcome: 'ok',
      receipt: 'durable',
    },
  );
  assert.deepEqual(reconciled.busy, []);
  assert.equal(
    reconciled.notices[id(1)]?.text,
    '照合を依頼しました。結果が分かると、この行の状態が変わります。',
  );
  const lost = applyCommandResponse(
    busy,
    id(1),
    'desktop.operation_reconcile',
    rejected('outcome_unknown', 'desktop.operation_reconcile'),
  );
  assert.match(
    lost.notices[id(1)]?.text ?? '',
    /もう一度「照合」を押してください/u,
  );
});

test('syncOperations drops notices of removed operations and closes a confirmation that is no longer waiting', () => {
  const state: WorkViewState = {
    ...INITIAL_WORK_STATE,
    preview: { ref: id(1), seq: 1, preview: previewOf(), approving: false },
    notices: {
      [id(1)]: { tone: 'warning', text: 'a' },
      [id(2)]: { tone: 'warning', text: 'b' },
    },
  };
  assert.equal(
    syncOperations(state, [entry({ ref: id(1) }), entry({ ref: id(2) })]),
    state,
  );
  const removed = syncOperations(state, [entry({ ref: id(1) })]);
  assert.deepEqual(Object.keys(removed.notices), [id(1)]);
  const moved = syncOperations(state, [
    entry({ ref: id(1), state: 'approved' }),
    entry({ ref: id(2) }),
  ]);
  assert.equal(moved.preview, null);
  const held = syncOperations(state, [
    entry({ ref: id(1), delivery_unknown: true }),
    entry({ ref: id(2) }),
  ]);
  assert.equal(held.preview, null);
});

test('actions send only references and text; an empty or long draft is refused before sending', () => {
  let current: WorkViewState = INITIAL_WORK_STATE;
  const sent: DesktopIpcRequest[] = [];
  const actions = workActions({
    state: () => current,
    update: (change) => {
      current = change(current);
    },
    send: (built, _onResponse, _onFailure, before) => {
      sent.push(built);
      current = before(current);
    },
  });
  actions.submit();
  assert.equal(sent.length, 0);
  assert.equal(current.turnNotice?.text, '発言を入力してください。');
  actions.setDraft('あ'.repeat(4001));
  actions.submit();
  assert.equal(sent.length, 0);
  assert.match(current.turnNotice?.text ?? '', /4000\u00a0文字までです/u);
  actions.setDraft(' 今日の予定を見せて ');
  actions.submit();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    [sent[0]?.channel, sent[0]?.payload],
    ['desktop.turn_submit', { text: '今日の予定を見せて' }],
  );
  // 送信中は二重に送らない。
  actions.submit();
  assert.equal(sent.length, 1);
  actions.preview(id(1));
  actions.cancel(id(1));
  actions.reconcile(id(2));
  assert.deepEqual(
    sent.slice(1).map((request) => [request.channel, request.payload]),
    [
      ['desktop.operation_preview', { ref: id(1) }],
      ['desktop.operation_cancel', { ref: id(1) }],
      ['desktop.operation_reconcile', { ref: id(2) }],
    ],
  );
  // 同じ操作の取消・照合を、結果を待つ間は二重に送らない。
  actions.cancel(id(1));
  assert.equal(sent.length, 4);
  // 内容を取得できていない間は承認を送らない。承認は main が渡した確認の参照だけを送る。
  actions.approve();
  assert.equal(sent.length, 4);
  current = {
    ...current,
    preview: { ref: id(1), seq: 1, preview: previewOf(), approving: false },
  };
  actions.approve();
  assert.deepEqual(
    [sent[4]?.channel, sent[4]?.payload],
    ['desktop.operation_approve', { ref: id(0x20) }],
  );
  actions.approve();
  assert.equal(sent.length, 5);
});

test('retry is offered only when the operation is known not to have run; reconcile 409 says to wait', () => {
  const notRun = entry({ state: 'not_executed', allowed_actions: ['retry'] });
  assert.deepEqual(entryActions(notRun), {
    preview: false,
    cancel: false,
    reconcile: false,
    retry: true,
    check: false,
  });
  assert.match(
    operationNote(notRun) ?? '',
    /「再試行」を押すと、同じ内容をもう一度実行します。/u,
  );
  // 結果不明・命令の結果不明・成功には出さない（allowed_actions に retry があっても、状態が違えば出さない）。
  for (const other of [
    entry({ state: 'unknown_held', allowed_actions: ['reconcile', 'retry'] }),
    entry({ state: 'succeeded', allowed_actions: ['retry'] }),
    entry({
      state: 'not_executed',
      allowed_actions: ['retry'],
      delivery_unknown: true,
    }),
  ])
    assert.equal(entryActions(other).retry, false, other.state);
  assert.equal(
    operationFailureText('desktop.operation_reconcile', 'core_rejected'),
    '今は確かめられません。少し待ってから、もう一度「照合」を押してください。',
  );
  const sent: DesktopIpcRequest[] = [];
  const actions = workActions({
    state: () => INITIAL_WORK_STATE,
    update: () => undefined,
    send: (built) => {
      sent.push(built);
    },
  });
  actions.retry(id(3));
  assert.deepEqual(
    [sent[0]?.channel, sent[0]?.payload],
    ['desktop.operation_retry', { ref: id(3) }],
  );
});

test('responses of previews that arrive in reverse order never replace the newest confirmation', async () => {
  const pending: {
    request: DesktopIpcRequest;
    resolve: (response: DesktopIpcResponse) => void;
  }[] = [];
  const store = new WorkStore({
    invoke: (request) =>
      new Promise((resolve) => {
        pending.push({ request, resolve });
      }),
  });
  // 操作 A → B → A の順に確認を切り替える（番号 1・2・3）。
  store.actions.preview(id(1));
  store.actions.preview(id(2));
  store.actions.preview(id(1));
  assert.equal(pending.length, 3);
  assert.equal(store.snapshot().previewSeq, 3);
  const reply = (n: number, ref: number): DesktopIpcResponse => ({
    request_id: id(0x90 + n),
    channel: 'desktop.operation_preview',
    outcome: 'ok',
    preview: { ...previewOf(), preview_ref: id(ref) },
  });
  // 最新（3 番目の A）が先に届き、古い 1 番目の A と 2 番目の B が後から届く。
  pending[2]?.resolve(reply(3, 0x33));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.snapshot().preview?.preview?.preview_ref, id(0x33));
  pending[1]?.resolve(reply(2, 0x22));
  pending[0]?.resolve(reply(1, 0x11));
  await Promise.resolve();
  await Promise.resolve();
  const shown = store.snapshot().preview;
  assert.equal(shown?.ref, id(1));
  assert.equal(shown?.seq, 3);
  assert.equal(shown?.preview?.preview_ref, id(0x33));
  // 古い応答は、拒否でも確認を閉じない。
  pending[0]?.resolve(rejected('core_rejected', 'desktop.operation_preview'));
  await Promise.resolve();
  assert.equal(store.snapshot().preview?.seq, 3);
});

test('after a lock or a disconnect the content is dropped and a late answer is not shown', async () => {
  const pending: ((response: DesktopIpcResponse) => void)[] = [];
  const store = new WorkStore({
    invoke: () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  });
  store.actions.setDraft('今日の予定を見せて');
  store.actions.submit();
  assert.equal(store.snapshot().sending, true);
  // 切断（出せなくなった）: 内容を捨てる。
  store.hide();
  assert.deepEqual(store.snapshot(), INITIAL_WORK_STATE);
  // 切断をまたいだ遅い応答は、会話に戻さない。
  pending[0]?.({
    request_id: id(1),
    channel: 'desktop.turn_submit',
    outcome: 'ok',
    turn: { status: 'clarification', reply_text: '聞き返し', result: null },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(store.snapshot(), INITIAL_WORK_STATE);
  // 失敗も同じ。
  store.actions.setDraft('もう一度');
  store.actions.preview(id(4));
  store.hide();
  pending[1]?.(rejected('core_rejected', 'desktop.operation_preview'));
  await Promise.resolve();
  assert.deepEqual(store.snapshot(), INITIAL_WORK_STATE);
});

test('a row is titled by its content, with the kind as a supplement, and a failed send is not an input error', () => {
  const task = entry({ headline: '牛乳を買う', detail: '期限 2030-10-06' });
  assert.equal(rowTitle(task), '牛乳を買う');
  assert.equal(rowSubtitle(task), '用事の登録・期限 2030-10-06');
  // 内容を読めていない間は、操作の種類を見出しにする。
  assert.equal(rowTitle(entry()), '用事の登録');
  assert.equal(rowSubtitle(entry()), null);
  assert.equal(
    rowSubtitle(entry({ detail: '期限 2030-10-06' })),
    '期限 2030-10-06',
  );
  // 入力の問題だけ入力欄の下（field）に出す。通信の失敗は入力欄とは別の通知。
  let current: WorkViewState = INITIAL_WORK_STATE;
  const actions = workActions({
    state: () => current,
    update: (change) => {
      current = change(current);
    },
    send: () => undefined,
  });
  actions.submit();
  assert.equal(current.turnNotice?.field, true);
  const lost = applyTurnResponse(
    { ...INITIAL_WORK_STATE, draft: '今日の予定を見せて', sending: true },
    rejected('outcome_unknown', 'desktop.turn_submit'),
  );
  assert.notEqual(lost.turnNotice?.field, true);
  // 案内先は画面にある見出しの名前に合わせる（「処理状況」という見出しはない）。
  assert.match(lost.turnNotice?.text ?? '', /「確認が必要な操作」/u);
  assert.doesNotMatch(lost.turnNotice?.text ?? '', /処理状況/u);
});

test('a check of a held command reports what was found and never says it was resent', () => {
  const held = { ...INITIAL_WORK_STATE, busy: [id(1)] };
  const delivered = applyCommandResponse(
    held,
    id(1),
    'desktop.operation_check',
    {
      request_id: id(2),
      channel: 'desktop.operation_check',
      outcome: 'ok',
      resolved: 'state_changed',
    },
  );
  assert.equal(
    delivered.notices[id(1)]?.text,
    '今の状態を読み取りました。状態が変わっています。この行の表示を確かめてください。',
  );
  const notDelivered = applyCommandResponse(
    held,
    id(1),
    'desktop.operation_check',
    {
      request_id: id(3),
      channel: 'desktop.operation_check',
      outcome: 'ok',
      resolved: 'state_unchanged',
    },
  );
  assert.equal(
    notDelivered.notices[id(1)]?.text,
    '今の状態を読み取りました。状態は変わっていません。もう一度操作できます。',
  );
  // 命令が届いたか・届かなかったかは断定しない。
  assert.doesNotMatch(
    `${delivered.notices[id(1)]?.text}${notDelivered.notices[id(1)]?.text}`,
    /届いていま|届いていませ/u,
  );
  assert.deepEqual(notDelivered.busy, []);
  assert.equal(
    operationFailureText('desktop.operation_check', 'core_rejected'),
    '今は確かめられません。少し待ってから、もう一度「状態を確かめる」を押してください。',
  );
});

test('when the content of an operation cannot be read, the sentence says how to recover', () => {
  for (const channel of [
    'desktop.operation_cancel',
    'desktop.operation_retry',
  ] as const)
    assert.equal(
      operationFailureText(channel, 'content_unavailable'),
      '操作の内容を中枢から読めなかったため、確認へ進めません。中枢との接続を確かめて、少し待ってから、もう一度押してください。',
    );
});
