import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_EXECUTION_RULES,
  AUTO_OPERATION_RULES,
  DEFAULT_AUTO_EXECUTION_POLICY,
  GRAPH_CATEGORY_AUTO_VERIFIED,
  autoExecutionDuplicateKey,
  judgeAutoExecution,
} from '../packages/domain/dist/index.js';

// B13-02 の候補起点の自動実行の判定表（ADR 0146、設計 11 §5・§5A・§5B、08 §9）。
// 期待値はすべて手で書く。実データ・実 API は使わない（合成の値だけ）。

const ALL_ON = {
  policy_version: '3',
  rules: {
    'task.register': true,
    'event.create_own': true,
    'mail.apply_existing_label': true,
    'mail.save_draft': true,
  },
};

const verifiedFields = [
  {
    field: 'summary',
    status: 'explicit',
    refs: [{ quote: 'q' }],
    rule_id: null,
  },
  { field: 'kind', status: 'explicit', refs: [{ quote: 'q' }], rule_id: null },
  {
    field: 'deadline',
    status: 'explicit',
    refs: [{ quote: 'q' }],
    rule_id: null,
  },
];

const request = (overrides = {}) => ({
  kind: 'reply_required',
  deadline: {
    kind: 'instant',
    local_datetime: '2026-12-10T17:00',
    zone: 'Asia/Tokyo',
    original_text: '12月10日17時までに',
  },
  fields: verifiedFields,
  in_quoted_text: false,
  confidence_observed: 'high',
  addressed_to_me: true,
  from_automated_sender: false,
  ...overrides,
});

const readyAnalysis = {
  group_id: 'group-1',
  analysis_revision: 'a2',
  source_set_hash: 'hash-1',
  published_generation: 'g3',
  plan_complete: true,
  sources: [{ state: 'analyzed', rule_id: null }],
  unresolved_change_count: 0,
};

const activeEntity = {
  request_entity_id: 'req-1',
  state: 'active',
  recreation_suppressed: false,
  created_operations: [],
};

const facts = (operation, overrides = {}) => ({
  operation,
  policy: ALL_ON,
  policy_current: true,
  permission_current: true,
  safety_stopped: false,
  auto_approvals: null,
  now: '2026-11-25T00:10:00Z',
  initial_import: false,
  request: request(),
  completeness: { unread_source_ids: [], truncated_source_ids: [] },
  received_at_local: '2026-11-25T09:00',
  context: {
    ownCalendarSelected: true,
    labelAssigned: true,
    draftExists: false,
    budgetAvailable: true,
  },
  label_provider: operation === 'label_mail' ? 'google' : null,
  analysis: readyAnalysis,
  current_published_generation: 'g3',
  entity: activeEntity,
  changes: [],
  target: {
    account_id: 'acct-1',
    calendar_id: operation === 'create_event' ? 'cal-own' : null,
  },
  ...overrides,
});

test('each of the four rows maps to exactly one policy rule', () => {
  assert.deepEqual(AUTO_OPERATION_RULES, {
    create_task: 'task.register',
    create_event: 'event.create_own',
    label_mail: 'mail.apply_existing_label',
    draft_reply: 'mail.save_draft',
  });
  assert.deepEqual(
    Object.values(AUTO_OPERATION_RULES).sort(),
    [...AUTO_EXECUTION_RULES].sort(),
  );
});

test('a candidate that passes every check is eligible with its duplicate key', () => {
  assert.deepEqual(judgeAutoExecution(facts('create_task')), {
    decision: 'auto_eligible',
    rule: 'task.register',
    duplicate_key: '["req-1","create_task","acct-1"]',
    reason_codes: [],
  });
  assert.deepEqual(judgeAutoExecution(facts('create_event')), {
    decision: 'auto_eligible',
    rule: 'event.create_own',
    duplicate_key: '["req-1","create_event","acct-1","cal-own"]',
    reason_codes: [],
  });
  assert.deepEqual(judgeAutoExecution(facts('label_mail')), {
    decision: 'auto_eligible',
    rule: 'mail.apply_existing_label',
    duplicate_key: '["req-1","label_mail","acct-1"]',
    reason_codes: [],
  });
  assert.deepEqual(judgeAutoExecution(facts('draft_reply')), {
    decision: 'auto_eligible',
    rule: 'mail.save_draft',
    duplicate_key: '["req-1","draft_reply","acct-1"]',
    reason_codes: [],
  });
});

test('the default policy keeps every row to a notice only', () => {
  for (const operation of [
    'create_task',
    'create_event',
    'label_mail',
    'draft_reply',
  ]) {
    assert.deepEqual(
      judgeAutoExecution(
        facts(operation, { policy: DEFAULT_AUTO_EXECUTION_POLICY }),
      ),
      {
        decision: 'notice_only',
        rule: AUTO_OPERATION_RULES[operation],
        duplicate_key: null,
        reason_codes: ['policy_disabled'],
      },
      operation,
    );
  }
  assert.equal(
    judgeAutoExecution(facts('create_task', { policy: null })).decision,
    'notice_only',
  );
  const onlyTasks = {
    policy_version: '4',
    rules: { ...DEFAULT_AUTO_EXECUTION_POLICY.rules, 'task.register': true },
  };
  assert.equal(
    judgeAutoExecution(facts('create_task', { policy: onlyTasks })).decision,
    'auto_eligible',
  );
  assert.deepEqual(
    judgeAutoExecution(facts('draft_reply', { policy: onlyTasks }))
      .reason_codes,
    ['policy_disabled'],
  );
});

test('initial import candidates are never automatic', () => {
  assert.deepEqual(
    judgeAutoExecution(facts('create_task', { initial_import: true })),
    {
      decision: 'notice_only',
      rule: 'task.register',
      duplicate_key: null,
      reason_codes: ['initial_import'],
    },
  );
});

test('unread or truncated sources stop all four rows, labels included', () => {
  for (const operation of [
    'create_task',
    'create_event',
    'label_mail',
    'draft_reply',
  ]) {
    const result = judgeAutoExecution(
      facts(operation, {
        completeness: {
          unread_source_ids: ['att-1'],
          truncated_source_ids: ['body'],
        },
      }),
    );
    assert.equal(result.decision, 'notice_only', operation);
    assert.deepEqual(
      result.reason_codes,
      ['unread_sources', 'truncated_sources'],
      operation,
    );
  }
});

test('row conditions: a date-only deadline can register a task but not an event', () => {
  const dateOnly = request({
    deadline: {
      kind: 'date',
      date: '2026-12-10',
      original_text: '12月10日まで',
    },
  });
  assert.equal(
    judgeAutoExecution(facts('create_task', { request: dateOnly })).decision,
    'auto_eligible',
  );
  assert.deepEqual(
    judgeAutoExecution(facts('create_event', { request: dateOnly })),
    {
      decision: 'notice_only',
      rule: 'event.create_own',
      duplicate_key: null,
      reason_codes: ['deadline_not_instant'],
    },
  );
});

test('row conditions: medium confidence allows a task but not an event', () => {
  const medium = request({ confidence_observed: 'medium' });
  assert.equal(
    judgeAutoExecution(facts('create_task', { request: medium })).decision,
    'auto_eligible',
  );
  assert.deepEqual(
    judgeAutoExecution(facts('create_event', { request: medium })).reason_codes,
    ['confidence_not_high'],
  );
});

test('row conditions: cc-only and automated senders stay a notice', () => {
  assert.deepEqual(
    judgeAutoExecution(
      facts('draft_reply', {
        request: request({
          addressed_to_me: false,
          from_automated_sender: true,
        }),
      }),
    ).reason_codes,
    ['not_addressed_to_me', 'automated_sender'],
  );
});

test('row conditions: an existing draft or a stopped budget blocks the draft row only', () => {
  const context = {
    ownCalendarSelected: true,
    labelAssigned: true,
    draftExists: true,
    budgetAvailable: false,
  };
  assert.deepEqual(
    judgeAutoExecution(facts('draft_reply', { context })).reason_codes,
    ['draft_exists', 'budget_unavailable'],
  );
  assert.equal(
    judgeAutoExecution(facts('create_task', { context })).decision,
    'auto_eligible',
  );
});

test('row conditions: a label needs an assigned label and a known provider', () => {
  assert.deepEqual(
    judgeAutoExecution(
      facts('label_mail', {
        context: {
          ownCalendarSelected: false,
          labelAssigned: false,
          draftExists: false,
          budgetAvailable: true,
        },
      }),
    ).reason_codes,
    ['label_not_assigned'],
  );
  assert.deepEqual(
    judgeAutoExecution(facts('label_mail', { label_provider: null }))
      .reason_codes,
    ['label_provider_unknown'],
  );
});

test('an Outlook category stays a screen proposal until If-Match is verified', () => {
  assert.equal(GRAPH_CATEGORY_AUTO_VERIFIED, false);
  assert.deepEqual(
    judgeAutoExecution(facts('label_mail', { label_provider: 'microsoft' })),
    {
      decision: 'needs_approval',
      rule: 'mail.apply_existing_label',
      duplicate_key: '["req-1","label_mail","acct-1"]',
      reason_codes: ['graph_category_unverified'],
    },
  );
  // 方針で無効なら、承認待ちも作らない。
  assert.equal(
    judgeAutoExecution(
      facts('label_mail', {
        label_provider: 'microsoft',
        policy: DEFAULT_AUTO_EXECUTION_POLICY,
      }),
    ).decision,
    'notice_only',
  );
});

test('a safety stop or a full window holds the candidate for a later judgment', () => {
  assert.deepEqual(
    judgeAutoExecution(facts('create_task', { safety_stopped: true })),
    {
      decision: 'hold',
      rule: 'task.register',
      duplicate_key: null,
      reason_codes: ['safety_stopped'],
    },
  );
  const window = (count, startedAt) => ({
    window_started_at: startedAt,
    auto_approvals: count,
    limit: 20,
    window_minutes: 10,
  });
  // 10 分の窓の中で 19 件なら次の 1 件は通り、20 件なら止まる。
  assert.equal(
    judgeAutoExecution(
      facts('create_task', {
        auto_approvals: window(19, '2026-11-25T00:01:00Z'),
      }),
    ).decision,
    'auto_eligible',
  );
  assert.deepEqual(
    judgeAutoExecution(
      facts('create_task', {
        auto_approvals: window(20, '2026-11-25T00:01:00Z'),
      }),
    ).reason_codes,
    ['rate_exceeded'],
  );
  // 窓の開始から 10 分ちょうどで新しい窓になる（now は 00:10:00）。
  assert.equal(
    judgeAutoExecution(
      facts('create_task', {
        auto_approvals: window(20, '2026-11-25T00:00:00Z'),
      }),
    ).decision,
    'auto_eligible',
  );
  // 停止中は、時間窓の理由を重ねない。
  assert.deepEqual(
    judgeAutoExecution(
      facts('create_task', {
        safety_stopped: true,
        auto_approvals: window(20, '2026-11-25T00:01:00Z'),
      }),
    ).reason_codes,
    ['safety_stopped'],
  );
});

test('a candidate without the right to run stays a notice even during a safety stop', () => {
  assert.deepEqual(
    judgeAutoExecution(
      facts('create_task', {
        safety_stopped: true,
        policy: DEFAULT_AUTO_EXECUTION_POLICY,
      }),
    ).reason_codes,
    ['policy_disabled'],
  );
});

test('stale policy or permission versions hold the candidate', () => {
  assert.deepEqual(
    judgeAutoExecution(
      facts('create_task', {
        policy_current: false,
        permission_current: false,
      }),
    ),
    {
      decision: 'hold',
      rule: 'task.register',
      duplicate_key: null,
      reason_codes: ['policy_changed', 'permission_changed'],
    },
  );
});

test('an unfinished related analysis holds and does not settle a cancel yet', () => {
  const cancel = {
    relation: 'cancel',
    target_request_entity_id: 'req-1',
    resolution: 'resolved',
  };
  assert.deepEqual(
    judgeAutoExecution(
      facts('create_task', {
        analysis: { ...readyAnalysis, plan_complete: false },
        changes: [cancel],
      }),
    ),
    {
      decision: 'hold',
      rule: 'task.register',
      duplicate_key: null,
      reason_codes: ['plan_incomplete'],
    },
  );
  assert.deepEqual(
    judgeAutoExecution(
      facts('create_task', { current_published_generation: 'g4' }),
    ).reason_codes,
    ['generation_changed'],
  );
  assert.deepEqual(
    judgeAutoExecution(
      facts('create_task', {
        analysis: {
          ...readyAnalysis,
          sources: [
            { state: 'analyzed', rule_id: null },
            { state: 'pending', rule_id: null },
          ],
        },
      }),
    ).reason_codes,
    ['source_pending'],
  );
  // 解析が済めば、取消は確定して気づきだけになる。
  assert.deepEqual(
    judgeAutoExecution(facts('create_task', { changes: [cancel] })),
    {
      decision: 'notice_only',
      rule: 'task.register',
      duplicate_key: null,
      reason_codes: ['entity_cancelled'],
    },
  );
});

test('a suppressed or already created request is not created again', () => {
  assert.deepEqual(
    judgeAutoExecution(
      facts('create_task', {
        entity: { ...activeEntity, recreation_suppressed: true },
      }),
    ).reason_codes,
    ['recreation_suppressed'],
  );
  const created = {
    ...activeEntity,
    created_operations: [
      {
        operation_kind: 'create_event',
        operation_id: 'op-1',
        account_id: 'acct-1',
        calendar_id: 'cal-own',
      },
    ],
  };
  assert.deepEqual(
    judgeAutoExecution(facts('create_event', { entity: created })).reason_codes,
    ['already_created'],
  );
  // 同じ依頼でも、用事は予定とは別の操作なので作れる（11 §5「どちらかを取り消してももう一方は残る」）。
  assert.equal(
    judgeAutoExecution(facts('create_task', { entity: created })).decision,
    'auto_eligible',
  );
  // 別のカレンダーへの予定は別の重複キー。
  assert.equal(
    judgeAutoExecution(
      facts('create_event', {
        entity: created,
        target: { account_id: 'acct-1', calendar_id: 'cal-other' },
      }),
    ).decision,
    'auto_eligible',
  );
});

test('the duplicate key takes a calendar only for an event', () => {
  assert.equal(
    autoExecutionDuplicateKey('req-9', 'create_event', {
      account_id: 'acct-2',
      calendar_id: 'cal-x',
    }),
    '["req-9","create_event","acct-2","cal-x"]',
  );
  assert.throws(
    () =>
      autoExecutionDuplicateKey('req-9', 'create_event', {
        account_id: 'acct-2',
        calendar_id: null,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      autoExecutionDuplicateKey('req-9', 'create_task', {
        account_id: 'acct-2',
        calendar_id: 'cal-x',
      }),
    TypeError,
  );
  // 区切り文字を含む値でも、別の組と同じ文字列にならない。
  assert.notEqual(
    autoExecutionDuplicateKey('a","b', 'create_task', {
      account_id: 'c',
      calendar_id: null,
    }),
    autoExecutionDuplicateKey('a', 'create_task', {
      account_id: 'b","c',
      calendar_id: null,
    }),
  );
});
