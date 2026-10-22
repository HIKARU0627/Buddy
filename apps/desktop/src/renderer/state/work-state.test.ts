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
  scheduleText,
  syncOperations,
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
  });
  assert.match(
    operationNote(unknown) ?? '',
    /自動では送り直しません。「照合」/u,
  );
  // retry を許可していても、画面には再送・再試行の操作がない。
  assert.deepEqual(
    Object.keys(
      entryActions(
        entry({ state: 'not_executed', allowed_actions: ['retry'] }),
      ),
    ).sort(),
    ['cancel', 'preview', 'reconcile'],
  );
  assert.deepEqual(entryActions(entry({ delivery_unknown: true })), {
    preview: false,
    cancel: false,
    reconcile: false,
  });
  assert.deepEqual(entryActions(entry()), {
    preview: true,
    cancel: true,
    reconcile: false,
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
  assert.equal(scheduleText(base), '予定はありません。');
  assert.equal(
    scheduleText({ ...base, event_count: 3, overlap_count: 2, more_count: 4 }),
    '予定は3 件あります。そのうち2 件は、時間が重なっています。ほか4 件は、ここには出していません。',
  );
  assert.equal(
    scheduleText({ ...base, event_count: 1 }),
    '予定は1 件あります。',
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
    preview: { ref: id(1), preview: previewOf(), approving: true },
  };
  // 「やめる」: 確認は残してやり直せる。承認していないと言う。
  const declined = applyApproveResponse(
    open,
    id(1),
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
    const closed = applyApproveResponse(open, id(1), rejected(reason));
    assert.equal(closed.preview, null, reason);
    assert.equal(closed.notices[id(1)]?.tone, 'warning', reason);
  }
  assert.match(
    operationFailureText('desktop.operation_approve', 'outcome_unknown'),
    /届いたか確かめられませんでした。自動では送り直しません。/u,
  );
  const sent = applyApproveResponse(open, id(1), {
    request_id: id(2),
    channel: 'desktop.operation_approve',
    outcome: 'ok',
    receipt: 'accepted',
  });
  assert.equal(sent.preview, null);
  assert.equal(sent.notices[id(1)]?.tone, 'success');
  // 別の操作の応答は無視する。
  assert.equal(
    applyApproveResponse(open, id(7), rejected('preview_stale')),
    open,
  );
});

test('a preview for another operation or after closing is ignored; a failed preview shows a sentence', () => {
  const loading = markPreviewLoading(INITIAL_WORK_STATE, id(1));
  const ok = applyPreviewResponse(loading, id(1), {
    request_id: id(2),
    channel: 'desktop.operation_preview',
    outcome: 'ok',
    preview: previewOf(),
  });
  assert.equal(ok.preview?.preview?.preview_ref, id(0x20));
  assert.equal(
    applyPreviewResponse(loading, id(2), {
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
    preview: { ref: id(1), preview: previewOf(), approving: false },
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
  assert.match(current.turnNotice?.text ?? '', /4000 文字までです/u);
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
    preview: { ref: id(1), preview: previewOf(), approving: false },
  };
  actions.approve();
  assert.deepEqual(
    [sent[4]?.channel, sent[4]?.payload],
    ['desktop.operation_approve', { ref: id(0x20) }],
  );
  actions.approve();
  assert.equal(sent.length, 5);
});
