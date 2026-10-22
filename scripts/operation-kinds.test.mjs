import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_RECONCILE_LIMIT,
  CONTENT_REVISABLE_STATES,
  INTENT_POLICIES,
  OPERATION_KINDS,
  OPERATION_KIND_RULES,
  OPERATION_TRANSITIONS,
  canAutoReconcile,
  canTransition,
  checkConnectorCapability,
  nextStepDecision,
  operationMarker,
  preconditionReads,
  planContentRevision,
  reconcileOutcome,
  stepId,
  stepState,
} from '../packages/domain/dist/index.js';
import { loadContracts } from './contract-tools.mjs';

// B04-01（ADR 0027）: D1・D5 の遷移、操作の種類と connector の能力、照合、工程（D3）の規則。
// 期待値は ADR 0027 と Issue #81 の本人の判断から手で書き、実装から生成しない。
const { schema } = await loadContracts();
const defs = schema.$defs;
const H_OLD = 'a'.repeat(64);
const H_NEW = 'b'.repeat(64);
const OP = '00000000-0000-4000-8000-000000000101';

test('operation kinds match the contract enum and the intent routes', () => {
  assert.deepEqual([...OPERATION_KINDS], defs.OperationKind.enum);
  assert.deepEqual(
    defs.OperationIntent.oneOf.map(
      (ref) =>
        defs[ref.$ref.split('/').at(-1)].properties.action.properties.kind
          .const,
    ),
    ['mail.labels.change', 'mail.draft.create', 'task.create'],
  );
  // 種類の経路は意図表の経路と一致する（label_mail・draft_reply は RemoteMutation、create_task は LocalCommand）。
  assert.equal(
    OPERATION_KIND_RULES['mail.labels.change'].route,
    INTENT_POLICIES.label_mail.route,
  );
  assert.equal(
    OPERATION_KIND_RULES['mail.draft.create'].route,
    INTENT_POLICIES.draft_reply.route,
  );
  assert.equal(
    OPERATION_KIND_RULES['task.create'].route,
    INTENT_POLICIES.create_task.route,
  );
  // 照合の範囲は契約の effects.reconcile_scope の const と同じ。
  for (const [name, kind] of [
    ['LabelOperationIntent', 'mail.labels.change'],
    ['DraftReplyOperationIntent', 'mail.draft.create'],
    ['TaskOperationIntent', 'task.create'],
  ])
    assert.equal(
      defs[name].properties.effects.properties.reconcile_scope.const,
      OPERATION_KIND_RULES[kind].reconcile_scope,
      name,
    );
});

test('D5: only LocalCommand may go from approved straight to succeeded', () => {
  assert(canTransition('approved', 'succeeded', 'local_command'));
  assert(!canTransition('approved', 'succeeded', 'remote_mutation'));
  // 経路が分からない呼び出しには許さない（安全側）。
  assert(!canTransition('approved', 'succeeded'));
  assert(!OPERATION_TRANSITIONS.approved.includes('succeeded'));
  // 他の近道は LocalCommand でも許さない。
  assert(!canTransition('awaiting_approval', 'succeeded', 'local_command'));
  assert(!canTransition('preparing', 'succeeded', 'local_command'));
  // 送出境界の規則は経路に関係なく保つ。
  for (const route of [null, 'local_command', 'remote_mutation']) {
    assert(!canTransition('dispatching', 'cancelled', route));
    assert(!canTransition('unknown_held', 'dispatching', route));
  }
});

test('D1: content revisions return to awaiting_approval only before the dispatch boundary', () => {
  assert.deepEqual([...CONTENT_REVISABLE_STATES].sort(), [
    'approved',
    'awaiting_approval',
    'not_executed',
    'preparing',
  ]);
  for (const from of CONTENT_REVISABLE_STATES)
    assert(canTransition(from, 'awaiting_approval'), from);
  for (const from of [
    'dispatching',
    'reconciling',
    'unknown_held',
    'succeeded',
    'cancelled',
    'superseded',
  ])
    assert(!canTransition(from, 'awaiting_approval', 'remote_mutation'), from);

  const base = {
    current_content_version: '1',
    current_content_hash: H_OLD,
    next_content_hash: H_NEW,
    has_valid_approval: false,
    has_active_attempt: false,
  };
  assert.deepEqual(
    planContentRevision({ ...base, state: 'awaiting_approval' }),
    {
      ok: true,
      next_state: 'awaiting_approval',
      next_content_version: '2',
      revoke_approval: false,
      supersede_attempt: false,
    },
  );
  // 承認の後: 旧版の承認を revoked。
  assert.deepEqual(
    planContentRevision({
      ...base,
      state: 'approved',
      has_valid_approval: true,
    }),
    {
      ok: true,
      next_state: 'awaiting_approval',
      next_content_version: '2',
      revoke_approval: true,
      supersede_attempt: false,
    },
  );
  // 送出準備中（X09）: 旧版の承認を revoked、試行を superseded。
  assert.deepEqual(
    planContentRevision({
      ...base,
      state: 'preparing',
      current_content_version: '9007199254740993',
      has_valid_approval: true,
      has_active_attempt: true,
    }),
    {
      ok: true,
      next_state: 'awaiting_approval',
      next_content_version: '9007199254740994',
      revoke_approval: true,
      supersede_attempt: true,
    },
  );
  // 拒否: 送出境界の後・終端・内容が同じ・版が不正・試行の状態の不一致。
  for (const state of ['dispatching', 'reconciling', 'unknown_held'])
    assert.deepEqual(planContentRevision({ ...base, state }), {
      ok: false,
      reasons: ['dispatch_boundary_crossed'],
    });
  for (const state of ['succeeded', 'cancelled', 'superseded'])
    assert.deepEqual(planContentRevision({ ...base, state }), {
      ok: false,
      reasons: ['operation_finished'],
    });
  assert.deepEqual(
    planContentRevision({
      ...base,
      state: 'approved',
      next_content_hash: H_OLD,
    }),
    { ok: false, reasons: ['content_unchanged'] },
  );
  assert.deepEqual(
    planContentRevision({
      ...base,
      state: 'approved',
      current_content_version: '01',
    }),
    { ok: false, reasons: ['content_version_invalid'] },
  );
  assert.deepEqual(
    planContentRevision({
      ...base,
      state: 'approved',
      has_active_attempt: true,
    }),
    { ok: false, reasons: ['attempt_state_mismatch'] },
  );
});

const mockCapability = () => ({
  provider: 'mock',
  reads: [
    { kind: 'permission', effect_kind: 'Read' },
    { kind: 'mail.message', effect_kind: 'Read' },
    { kind: 'mail.draft', effect_kind: 'Read' },
  ],
  writes: [
    {
      action_kind: 'mail.labels.change',
      effect_kind: 'RemoteMutation',
      automatic_http_retries: 0,
      precondition: 'recheck_before_dispatch',
      lookup: 'by_remote_id',
      reconcile_scope: 'exact_target',
      steps: ['apply_labels'],
    },
    {
      action_kind: 'mail.draft.create',
      effect_kind: 'RemoteMutation',
      automatic_http_retries: 0,
      precondition: 'conditional_request',
      lookup: 'by_operation_marker',
      reconcile_scope: 'operation_marker',
      steps: ['create_draft'],
    },
  ],
});

test('connector capabilities must follow the per-kind rules', () => {
  assert.deepEqual(checkConnectorCapability(mockCapability()), []);
  const cases = [
    [
      (c) => (c.writes[0].automatic_http_retries = 1),
      ['mail.labels.change:automatic_retry_forbidden'],
    ],
    [
      (c) => (c.writes[1].reconcile_scope = 'exact_target'),
      ['mail.draft.create:reconcile_scope_mismatch'],
    ],
    [
      (c) => (c.writes[1].lookup = 'by_remote_id'),
      ['mail.draft.create:lookup_mismatch'],
    ],
    [
      (c) => (c.writes[0].precondition = 'not_required'),
      ['mail.labels.change:precondition_not_allowed'],
    ],
    [
      (c) => (c.writes[0].steps = ['apply_labels', 'send']),
      ['mail.labels.change:steps_mismatch'],
    ],
    [
      (c) => (c.writes[0].effect_kind = 'LocalCommand'),
      ['mail.labels.change:effect_kind_mismatch'],
    ],
    [
      (c) => (c.reads = c.reads.filter((r) => r.kind !== 'mail.draft')),
      ['mail.draft.create:lookup_read_missing'],
    ],
    [
      (c) => c.reads.push({ kind: 'permission', effect_kind: 'Read' }),
      ['permission:duplicate_read'],
    ],
    [
      (c) => c.writes.push({ ...c.writes[0] }),
      ['mail.labels.change:duplicate_write'],
    ],
    [
      (c) =>
        c.writes.push({
          action_kind: 'task.create',
          effect_kind: 'RemoteMutation',
          automatic_http_retries: 0,
          precondition: 'not_required',
          lookup: 'none',
          reconcile_scope: 'local_transaction',
          steps: ['create_task'],
        }),
      ['task.create:local_command_without_connector'],
    ],
    [
      (c) => (c.writes[1].action_kind = 'mail.draft.send'),
      ['mail.draft.send:operation_kind_unknown'],
    ],
    [(c) => (c.provider = ''), ['provider_missing']],
  ];
  for (const [mutate, expected] of cases) {
    const capability = mockCapability();
    mutate(capability);
    assert.deepEqual(
      checkConnectorCapability(capability),
      expected,
      expected.join(),
    );
  }
});

test('re-checking before dispatch needs the target and permission reads', () => {
  assert.deepEqual(
    preconditionReads(
      OPERATION_KIND_RULES['mail.draft.create'],
      'recheck_before_dispatch',
    ),
    ['mail.message', 'permission'],
  );
  assert.deepEqual(
    preconditionReads(
      OPERATION_KIND_RULES['mail.labels.change'],
      'recheck_before_dispatch',
    ),
    ['mail.message', 'permission'],
  );
  assert.deepEqual(
    preconditionReads(
      OPERATION_KIND_RULES['mail.draft.create'],
      'conditional_request',
    ),
    [],
  );
  // 下書きを送出の直前に読み直すのに、返信元（mail.message）や許可を読めない構成は拒否する。
  const draftOnly = (reads) => {
    const capability = mockCapability();
    capability.writes = [
      { ...capability.writes[1], precondition: 'recheck_before_dispatch' },
    ];
    capability.reads = reads.map((kind) => ({ kind, effect_kind: 'Read' }));
    return checkConnectorCapability(capability);
  };
  assert.deepEqual(draftOnly(['mail.draft']), [
    'mail.draft.create:precondition_read_missing',
  ]);
  assert.deepEqual(draftOnly(['mail.draft', 'mail.message']), [
    'mail.draft.create:precondition_read_missing',
  ]);
  assert.deepEqual(draftOnly(['mail.draft', 'permission']), [
    'mail.draft.create:precondition_read_missing',
  ]);
  assert.deepEqual(draftOnly(['mail.draft', 'mail.message', 'permission']), []);
  // 条件付き要求なら、照合の読み取り（mail.draft）だけで足りる。
  const conditional = mockCapability();
  conditional.writes = [conditional.writes[1]];
  conditional.reads = [{ kind: 'mail.draft', effect_kind: 'Read' }];
  assert.deepEqual(checkConnectorCapability(conditional), []);
  // ラベル変更の読み直しも、許可の読み取りがなければ拒否する。
  const labels = mockCapability();
  labels.reads = labels.reads.filter((read) => read.kind !== 'permission');
  assert.deepEqual(checkConnectorCapability(labels), [
    'mail.labels.change:precondition_read_missing',
  ]);
});

test('reconciliation is read-only: only found means success, and auto reconcile runs once (D4)', () => {
  assert.equal(AUTO_RECONCILE_LIMIT, 1);
  assert(canAutoReconcile(0));
  assert(!canAutoReconcile(1));
  assert(!canAutoReconcile(-1));
  assert(!canAutoReconcile(0.5));
  assert.deepEqual(
    reconcileOutcome({ kind: 'found', external_id: 'draft-001' }),
    { state: 'succeeded', reasons: [] },
  );
  assert.deepEqual(reconcileOutcome({ kind: 'not_found' }), {
    state: 'unknown_held',
    reasons: ['not_found_may_apply_late'],
  });
  assert.deepEqual(reconcileOutcome({ kind: 'multiple', count: 2 }), {
    state: 'unknown_held',
    reasons: ['multiple_matches'],
  });
  assert.deepEqual(reconcileOutcome({ kind: 'unreadable' }), {
    state: 'unknown_held',
    reasons: ['lookup_unreadable'],
  });
  assert.equal(
    operationMarker(OP, '2'),
    'buddy-op:00000000-0000-4000-8000-000000000101:2',
  );
  assert.throws(
    () => operationMarker('0000000A-0000-4000-8000-000000000101', '1'),
    TypeError,
  );
  assert.throws(() => operationMarker('op-1', '1'), TypeError);
  assert.throws(() => operationMarker(OP, '0'), TypeError);
  assert.throws(() => operationMarker(OP, '01'), TypeError);
});

const step = (index, kind, intent, result, externalId = null) => ({
  step_id: `${index + 1}-${kind}`,
  step_kind: kind,
  dispatch_intent_at: intent,
  result_status: result,
  external_id: externalId,
});

test('D3: steps advance in order and saved dispatch intents are reconciled, not resent', () => {
  const plan = ['create_draft', 'send'];
  assert.equal(stepId(0, 'create_draft'), '1-create_draft');
  assert.equal(stepId(1, 'send'), '2-send');
  assert.throws(() => stepId(-1, 'send'), TypeError);
  assert.equal(stepState(step(0, 'create_draft', null, null)), 'pending');
  assert.equal(stepState(step(0, 'create_draft', 10, null)), 'dispatching');
  assert.equal(stepState(step(0, 'create_draft', 10, 'unknown')), 'unknown');
  assert.equal(
    stepState(step(0, 'create_draft', 10, 'confirmed_success')),
    'succeeded',
  );
  assert.equal(
    stepState(step(0, 'create_draft', 10, 'confirmed_not_executed')),
    'not_executed',
  );

  assert.deepEqual(nextStepDecision(plan, []), {
    action: 'dispatch',
    step_id: '1-create_draft',
    step_kind: 'create_draft',
  });
  // X10: 下書きの送出意図の後に停止 → 再起動で照合（再送しない）。
  assert.deepEqual(
    nextStepDecision(plan, [step(0, 'create_draft', 10, null)]),
    { action: 'reconcile', step_id: '1-create_draft' },
  );
  assert.deepEqual(
    nextStepDecision(plan, [step(0, 'create_draft', 10, 'unknown')]),
    { action: 'reconcile', step_id: '1-create_draft' },
  );
  assert.deepEqual(
    nextStepDecision(plan, [
      step(0, 'create_draft', 10, 'confirmed_success', 'draft-001'),
    ]),
    { action: 'dispatch', step_id: '2-send', step_kind: 'send' },
  );
  assert.deepEqual(
    nextStepDecision(plan, [
      step(0, 'create_draft', 10, 'confirmed_success'),
      step(1, 'send', 20, null),
    ]),
    { action: 'reconcile', step_id: '2-send' },
  );
  assert.deepEqual(
    nextStepDecision(plan, [
      step(0, 'create_draft', 10, 'confirmed_success'),
      step(1, 'send', 20, 'confirmed_success'),
    ]),
    { action: 'complete' },
  );
  // 拒否・停止
  assert.deepEqual(nextStepDecision([], []), {
    action: 'stop',
    reasons: ['step_plan_empty'],
  });
  assert.deepEqual(nextStepDecision(plan, [step(0, 'send', null, null)]), {
    action: 'stop',
    reasons: ['step_plan_mismatch'],
  });
  assert.deepEqual(
    nextStepDecision(plan, [
      { ...step(0, 'create_draft', null, null), step_id: 'x' },
    ]),
    { action: 'stop', reasons: ['step_plan_mismatch'] },
  );
  assert.deepEqual(
    nextStepDecision(
      ['create_draft'],
      [
        step(0, 'create_draft', 10, 'confirmed_success'),
        step(1, 'send', null, null),
      ],
    ),
    { action: 'stop', reasons: ['step_plan_mismatch'] },
  );
  assert.deepEqual(
    nextStepDecision(plan, [
      step(0, 'create_draft', null, null),
      step(1, 'send', 20, null),
    ]),
    { action: 'stop', reasons: ['step_order_violation'] },
  );
  assert.deepEqual(
    nextStepDecision(plan, [
      step(0, 'create_draft', 10, 'confirmed_not_executed'),
    ]),
    { action: 'stop', reasons: ['step_not_executed'] },
  );
  assert.deepEqual(
    nextStepDecision(plan, [
      step(0, 'create_draft', 10, 'confirmed_success'),
      step(1, 'send', 20, 'confirmed_not_executed'),
    ]),
    { action: 'stop', reasons: ['partial_steps'] },
  );
  // 種類ごとの工程は 1 工程（2 工程は D3 の仕組みだけで、送信の種類は B14）。
  for (const kind of OPERATION_KINDS)
    assert.equal(OPERATION_KIND_RULES[kind].steps.length, 1, kind);
});
