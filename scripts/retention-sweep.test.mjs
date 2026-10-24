import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BUDGET_RECORD_RETENTION_MONTHS,
  RETENTION_RULES,
  SWEEP_INTERVAL_MS,
  SWEEP_STALE_MS,
  applyMemoryEvent,
  budgetRecordDeleteAt,
  budgetReservationDeletable,
  checkClock,
  clampedDeadline,
  deadlineAfterModeChange,
  deleteAt,
  derivedDeadline,
  isDue,
  isRowUsable,
  resummarizedDeadline,
  sweepDue,
  sweepPlan,
  startupGate,
  turnRetentionRule,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// 掃除の計画（B06-02）。期待値は tests/fixtures/retention-sweep-cases.json に手で書いたもので、domain の出力から作らない。
const cases = parseStrictJson(
  await readFile(
    new URL('tests/fixtures/retention-sweep-cases.json', root),
    'utf8',
  ),
);

const DAY_MS = 86_400_000;

// 期待値に書いた項目だけを照合する（件数と順序は厳密）。
function assertSubset(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: count`);
  expected.forEach((want, index) => {
    for (const [key, value] of Object.entries(want))
      assert.deepEqual(actual[index][key], value, `${label}[${index}].${key}`);
  });
}

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
};

test('hand-written sweep cases: actions, holds, notices and clock state', () => {
  assert(cases.sweep_cases.length >= 45);
  const seen = new Set();
  for (const entry of cases.sweep_cases) {
    assert(!seen.has(entry.id), `duplicate ${entry.id}`);
    seen.add(entry.id);
    const input = deepFreeze(
      structuredClone({
        now: entry.now,
        last_checked_at: entry.last_checked_at,
        rows: entry.rows,
      }),
    );
    const plan = sweepPlan(input);
    assert.equal(plan.ok, true, entry.id);
    const want = entry.expected;
    assertSubset(plan.actions, want.actions, `${entry.id} actions`);
    assertSubset(plan.holds, want.holds, `${entry.id} holds`);
    if (want.notice_drafts !== undefined)
      assert.deepEqual(
        plan.notice_drafts.map(({ reason, items }) => ({ reason, items })),
        want.notice_drafts,
        `${entry.id} notices`,
      );
    if (want.use_blocked !== undefined)
      assert.deepEqual(
        plan.use_blocked,
        want.use_blocked,
        `${entry.id} use_blocked`,
      );
    assert.equal(plan.clock.state, want.clock_state, entry.id);
    assert.equal(plan.auto_use_blocked, want.auto_use_blocked, entry.id);
    if (want.effective_now !== undefined)
      assert.equal(plan.clock.effective_now, want.effective_now, entry.id);
    if (want.next_last_checked_at !== undefined)
      assert.equal(
        plan.clock.next_last_checked_at,
        want.next_last_checked_at,
        entry.id,
      );
    // 同じ入力は同じ計画（純粋）。入力は書き換えない（凍結した入力で例外が出ない）。
    assert.deepEqual(sweepPlan(input), plan, entry.id);
  }
});

test('the plan has no deletion for a row that is not yet due, at any boundary', () => {
  // 期限ちょうど・1 ミリ秒前・1 ミリ秒後の 3 点で、同じ行の判定が 前: 残す / ちょうど・後: 消す になる。
  const row = {
    family: 'timed',
    rule: 'turn_extended',
    id: 'turn-30',
    anchor_at: '2026-09-24T12:00:00Z',
    delete_at: '2026-10-24T12:00:00Z',
  };
  const at = (now) =>
    sweepPlan({ now, last_checked_at: null, rows: [row] }).actions.length;
  assert.equal(at('2026-10-24T11:59:59.999Z'), 0);
  assert.equal(at('2026-10-24T12:00:00Z'), 1);
  assert.equal(at('2026-10-24T12:00:00.001Z'), 1);
  assert.equal(at('2026-09-24T12:00:00Z'), 0);
});

test('invalid clocks plan nothing (closed side) and report why', () => {
  for (const entry of cases.sweep_rejections) {
    const plan = sweepPlan({
      now: entry.now,
      last_checked_at: entry.last_checked_at,
      rows: [
        {
          family: 'timed',
          rule: 'turn_normal',
          id: 't',
          anchor_at: '2020-01-01T00:00:00Z',
          delete_at: null,
        },
      ],
    });
    assert.equal(plan.ok, false, entry.id);
    assert.deepEqual(plan.reasons, entry.reasons, entry.id);
    assert.equal('actions' in plan, false, entry.id);
  }
});

test('a clock that moves back only ever moves the deletion line forward, never back', () => {
  // 最終確認時刻 10-24T12:00 のあと、時計が 1 ミリ秒でも戻ったら、期限の判定は最終確認時刻で行う。
  const row = {
    family: 'timed',
    rule: 'turn_normal',
    id: 't',
    anchor_at: '2026-10-17T00:00:00Z',
    delete_at: '2026-10-24T00:00:00Z',
  };
  for (const now of [
    '2026-10-24T11:59:59.999Z',
    '2026-10-23T00:00:00Z',
    '2020-01-01T00:00:00Z',
  ]) {
    const plan = sweepPlan({
      now,
      last_checked_at: '2026-10-24T12:00:00Z',
      rows: [row],
    });
    assert.equal(plan.clock.state, 'regressed', now);
    assert.equal(plan.clock.effective_now, '2026-10-24T12:00:00Z', now);
    assert.equal(plan.clock.next_last_checked_at, '2026-10-24T12:00:00Z', now);
    assert.equal(plan.actions.length, 1, now);
    assert.equal(plan.auto_use_blocked, true, now);
  }
  // 戻りが解消した（時計が最終確認時刻に追いついた）後は、止めない。
  const caught = sweepPlan({
    now: '2026-10-24T12:00:00Z',
    last_checked_at: '2026-10-24T12:00:00Z',
    rows: [],
  });
  assert.equal(caught.auto_use_blocked, false);
});

test('checkClock states', () => {
  assert.deepEqual(checkClock('2026-10-24T12:00:00Z', null), {
    ok: true,
    state: 'ok',
    effective_now: '2026-10-24T12:00:00Z',
    next_last_checked_at: '2026-10-24T12:00:00Z',
    regressed_by_ms: 0,
  });
  assert.deepEqual(
    checkClock('2026-10-24T11:59:59.999Z', '2026-10-24T12:00:00Z'),
    {
      ok: true,
      state: 'regressed',
      effective_now: '2026-10-24T12:00:00Z',
      next_last_checked_at: '2026-10-24T12:00:00Z',
      regressed_by_ms: 1,
    },
  );
  assert.deepEqual(checkClock('2026-10-24T12:00:00Z', '2026-10-24T12:00:00Z'), {
    ok: true,
    state: 'ok',
    effective_now: '2026-10-24T12:00:00Z',
    next_last_checked_at: '2026-10-24T12:00:00Z',
    regressed_by_ms: 0,
  });
  assert.deepEqual(checkClock('nope', null), {
    ok: false,
    reason: 'invalid_now',
  });
  assert.deepEqual(checkClock('2026-10-24T12:00:00Z', 'nope'), {
    ok: false,
    reason: 'invalid_last_checked_at',
  });
});

test('clamped deadlines never go past the rule and never extend', () => {
  for (const entry of cases.clamped_deadline_cases)
    assert.deepEqual(
      clampedDeadline(entry.rule, entry.anchor_at, entry.stored),
      entry.expected,
      entry.id,
    );
});

test('derived deadline is the earliest origin deadline', () => {
  for (const entry of cases.derived_deadline_cases)
    assert.equal(derivedDeadline(entry.origins), entry.expected, entry.id);
});

test('resummarizing uses in-deadline materials only and never extends', () => {
  for (const entry of cases.resummarize_cases)
    assert.deepEqual(
      resummarizedDeadline({
        now: entry.now,
        previous_delete_at: entry.previous_delete_at,
        materials: entry.materials,
      }),
      entry.expected,
      entry.id,
    );
  let previous = null;
  for (const [index, step] of cases.resummarize_chain.steps.entries()) {
    const result = resummarizedDeadline({
      now: step.now,
      previous_delete_at: previous,
      materials: step.materials,
    });
    assert.deepEqual(result, step.expected, `chain step ${index}`);
    previous = result === null ? null : result.delete_at;
  }
});

test('changing the storage mode never extends a stored turn deadline', () => {
  for (const entry of cases.mode_change_cases)
    assert.deepEqual(
      deadlineAfterModeChange({
        created_at: entry.created_at,
        stored_delete_at: entry.stored_delete_at,
        to: entry.to,
      }),
      { delete_at: entry.expected },
      entry.id,
    );
  // どの組み合わせでも、保存した期限より後にならない。
  const stored = '2026-10-17T00:00:00Z';
  for (const to of ['normal', 'extended', 'private'])
    assert(
      Date.parse(
        deadlineAfterModeChange({
          created_at: '2026-10-10T00:00:00Z',
          stored_delete_at: stored,
          to,
        }).delete_at,
      ) <= Date.parse(stored),
      to,
    );
});

test('explicit continue restarts the 90 days only for a pending review', () => {
  const entry = cases.memory_continuation;
  const continued = applyMemoryEvent(
    entry.before,
    'explicit_continue',
    entry.continued_at,
  );
  assert.equal(continued.rejected, null);
  assert.deepEqual(continued.memory, entry.after);
  const row = {
    family: 'memory',
    id: 'm',
    ...continued.memory,
  };
  assert.equal(
    sweepPlan({
      now: entry.sweep_one_ms_before_new_review,
      last_checked_at: null,
      rows: [row],
    }).actions.length,
    0,
  );
  const due = sweepPlan({
    now: entry.sweep_at_new_review,
    last_checked_at: null,
    rows: [row],
  });
  assertSubset(due.actions, [{ action: 'start_review', id: 'm' }], 'continued');
  // 使った・要約し直した・重複して抽出された、では期限は変わらない（既存の動作）。
  for (const event of ['used', 'resummarized', 'duplicate_extracted'])
    assert.deepEqual(
      applyMemoryEvent(entry.before, event, entry.continued_at).memory,
      entry.before,
      event,
    );
  // 明示継続は見直し待ちだけ。有効な記憶の継続は拒否される。
  assert.equal(
    applyMemoryEvent(entry.after, 'explicit_continue', entry.continued_at)
      .rejected,
    'not_review_pending',
  );
});

test('budget record deadline is 13 months after the month close, in the month time zone', () => {
  assert.equal(BUDGET_RECORD_RETENTION_MONTHS, 13);
  for (const entry of cases.budget_record_delete_at_cases)
    assert.equal(
      budgetRecordDeleteAt(entry.month, entry.time_zone),
      entry.expected,
      entry.id,
    );
});

test('RETENTION_RULES carry the J4 and J5 decisions and the existing rules are unchanged', () => {
  // 手書きの期待値。J5: 本文 7 日・本文のない記録 90 日。J4: 月の締めから 13 か月。
  assert.deepEqual(RETENTION_RULES.operation_body, {
    anchor: 'completed',
    ms: 604_800_000,
  });
  assert.deepEqual(RETENTION_RULES.operation_receipt, {
    anchor: 'completed',
    ms: 7_776_000_000,
  });
  assert.deepEqual(RETENTION_RULES.budget_record, {
    anchor: 'month_closed',
    ms: 0,
    months: 13,
  });
  const existing = {
    turn_normal: ['created', 7 * DAY_MS],
    turn_extended: ['created', 30 * DAY_MS],
    command_receipt: ['created', 7 * DAY_MS],
    event_outbox: ['occurred', 7 * DAY_MS],
    command_scope: ['issued', DAY_MS],
    pairing_code: ['created', 300_000],
    source_body: ['fetched', DAY_MS],
    sync_batch: ['created', DAY_MS],
    workflow_result: ['completed', 7 * DAY_MS],
    undo_window: ['completed', 30 * DAY_MS],
    candidate_excerpt: ['closed', 7 * DAY_MS],
    candidate_key: ['closed', 97 * DAY_MS],
  };
  for (const [id, [anchor, ms]] of Object.entries(existing))
    assert.deepEqual(RETENTION_RULES[id], { anchor, ms }, id);
  assert.deepEqual(
    Object.keys(RETENTION_RULES).sort(),
    [
      ...Object.keys(existing),
      'operation_body',
      'operation_receipt',
      'budget_record',
    ].sort(),
  );
  // 既存の関数の動作は変えない。暦の月で数える規則に、ms の関数を黙って当てない。
  assert.equal(
    deleteAt('turn_normal', '2026-10-17T12:00:00Z'),
    '2026-10-24T12:00:00Z',
  );
  assert.equal(
    deleteAt('operation_body', '2026-10-17T12:00:00Z'),
    '2026-10-24T12:00:00Z',
  );
  assert.equal(
    deleteAt('operation_receipt', '2026-10-17T12:00:00Z'),
    '2027-01-15T12:00:00Z',
  );
  assert.throws(
    () => deleteAt('budget_record', '2026-10-17T12:00:00Z'),
    /calendar based/u,
  );
  assert.throws(() => deleteAt('nope', '2026-10-17T12:00:00Z'), /unknown/u);
  assert.equal(isDue('2026-10-24T12:00:00Z', '2026-10-24T12:00:00Z'), true);
  assert.equal(
    isDue('2026-10-24T12:00:00Z', '2026-10-24T11:59:59.999Z'),
    false,
  );
  assert.equal(turnRetentionRule('private'), null);
  assert.equal(turnRetentionRule('normal'), 'turn_normal');
  assert.equal(turnRetentionRule('extended'), 'turn_extended');
});

test('retention days in the storage mode contract match the domain turn rules', async () => {
  // 契約の StorageModeState の turn_retention_days（7・30）と、domain の発言の規則が一致する。
  const schema = parseStrictJson(
    await readFile(
      new URL('packages/contracts/schemas/buddy.schema.json', root),
      'utf8',
    ),
  );
  const byMode = Object.fromEntries(
    schema.$defs.StorageModeState.oneOf.map((variant) => [
      variant.properties.storage_mode.const,
      variant.properties.effects.properties.turn_retention_days.const,
    ]),
  );
  assert.equal(byMode.normal * DAY_MS, RETENTION_RULES.turn_normal.ms);
  assert.equal(byMode.extended * DAY_MS, RETENTION_RULES.turn_extended.ms);
  assert.equal(byMode.private, null);
});

test('notices: 300 expired turns are split at the contract limit of 256 and carry only ids', async () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({
    family: 'timed',
    rule: 'turn_normal',
    id: `turn-${String(index).padStart(3, '0')}`,
    anchor_at: '2026-10-01T00:00:00Z',
    delete_at: null,
  }));
  const plan = sweepPlan({
    now: '2026-10-24T12:00:00Z',
    last_checked_at: null,
    rows,
  });
  assert.equal(plan.actions.length, 300);
  assert.deepEqual(
    plan.notice_drafts.map((draft) => [draft.reason, draft.items.length]),
    [
      ['retention_due', 256],
      ['retention_due', 44],
    ],
  );
  const schema = parseStrictJson(
    await readFile(
      new URL('packages/contracts/schemas/buddy.schema.json', root),
      'utf8',
    ),
  );
  assert.equal(
    schema.$defs.RetentionNotice.oneOf[0].properties.items.maxItems,
    256,
  );
  for (const draft of plan.notice_drafts) {
    assert.deepEqual(Object.keys(draft).sort(), ['items', 'kind', 'reason']);
    for (const item of draft.items)
      assert.deepEqual(Object.keys(item).sort(), ['item_id', 'item_kind']);
  }
});

test('startup gate: search and cloud send stay closed until a sweep for this boot completed', () => {
  assert(cases.gate_cases.length >= 21);
  for (const entry of cases.gate_cases) {
    const decision = startupGate(structuredClone(entry.input));
    assert.equal(decision.search, entry.expected.open, entry.id);
    assert.equal(decision.cloud_send, entry.expected.open, entry.id);
    assert.equal(decision.auto_use, entry.expected.open, entry.id);
    assert.deepEqual(decision.reasons, entry.expected.reasons, entry.id);
    if (entry.expected.use_blocked !== undefined)
      assert.deepEqual(
        decision.use_blocked,
        entry.expected.use_blocked,
        entry.id,
      );
    for (const row of entry.expected.usable ?? [])
      assert.equal(
        isRowUsable(decision, row.family, row.id),
        row.usable,
        `${entry.id} ${row.family}:${row.id}`,
      );
  }
  assert.equal(SWEEP_INTERVAL_MS, 300_000);
  assert.equal(SWEEP_STALE_MS, 900_000);
});

test('periodic sweep is due when never done, after the interval, or when records are unreadable', () => {
  for (const entry of cases.sweep_due_cases)
    assert.equal(
      sweepDue(entry.last_completed_at, entry.now),
      entry.expected,
      entry.id,
    );
});

test('the gate follows the plan: a sweep that planned deletions is only done when none failed', () => {
  // 計画 → 実行 → 記録 → ゲート の流れを、関数だけでつないだ例（実行は模擬）。
  const now = '2027-02-01T00:00:00Z';
  const plan = sweepPlan({
    now,
    last_checked_at: '2026-10-24T12:00:00Z',
    rows: [
      {
        family: 'timed',
        rule: 'turn_normal',
        id: 't',
        anchor_at: '2026-10-24T00:00:00Z',
        delete_at: null,
      },
    ],
  });
  assert.equal(plan.actions.length, 1);
  const gateAfter = (failed) =>
    startupGate({
      epoch: 'boot-9',
      now,
      last_checked_at: plan.clock.next_last_checked_at,
      sweep: {
        epoch: 'boot-9',
        status: 'completed',
        completed_at: now,
        failed_actions: failed,
        use_blocked: [],
      },
    });
  assert.equal(gateAfter(0).search, true);
  assert.equal(gateAfter(1).search, false);
  assert.equal(
    startupGate({
      epoch: 'boot-9',
      now,
      last_checked_at: plan.clock.next_last_checked_at,
      sweep: null,
    }).cloud_send,
    false,
  );
});

test('resummarize, save the deadline, then sweep: the previous cap survives the sweep', () => {
  const entry = cases.resummarize_to_sweep;
  const resummarized = resummarizedDeadline(entry.resummarize);
  assert.equal(resummarized.delete_at, entry.expected_delete_at);
  // 保存: 要約し直した結果の期限を行の delete_at に書く。由来だけからの計算し直しでは 11 月まで残ってしまう。
  const row = {
    ...structuredClone(entry.row),
    delete_at: resummarized.delete_at,
  };
  const unsaved = { ...structuredClone(entry.row), delete_at: null };
  assert.equal(
    sweepPlan({ now: entry.sweep_at, last_checked_at: null, rows: [unsaved] })
      .actions.length,
    0,
    'without the saved deadline the origins alone keep it (the bug this guards)',
  );
  assert.equal(
    sweepPlan({
      now: entry.sweep_one_ms_before,
      last_checked_at: null,
      rows: [row],
    }).actions.length,
    0,
  );
  const plan = sweepPlan({
    now: entry.sweep_at,
    last_checked_at: null,
    rows: [row],
  });
  assertSubset(plan.actions, [entry.expected_action], entry.id);
});

test('budget reservation amounts must be contract amounts before the reviewed flag counts', () => {
  const row = (actual, max, reviewed, status = 'settled') => ({
    reservation_id: 'r',
    status,
    actual_gross: actual,
    max_liability: max,
    overrun_reviewed: reviewed,
    live_session_ids: [],
    approval_ids: [],
  });
  // 正しい金額（0・18 桁の最大・M 超過でも確認済み・M ちょうど）
  assert.equal(budgetReservationDeletable(row('0', '0', false)), true);
  assert.equal(
    budgetReservationDeletable(
      row('999999999999999999', '999999999999999999', false),
    ),
    true,
  );
  assert.equal(budgetReservationDeletable(row('1000', '1000', false)), true);
  assert.equal(budgetReservationDeletable(row('1001', '1000', false)), false);
  assert.equal(budgetReservationDeletable(row('1001', '1000', true)), true);
  assert.equal(
    budgetReservationDeletable(row(null, '100', false, 'released')),
    true,
  );
  // 不正な金額は、確認済みでも消さない。
  for (const bad of [
    '',
    '12x',
    '-1',
    '01',
    ' 5',
    '5 ',
    '1.5',
    '1e3',
    '１２',
    '1000000000000000000',
  ])
    assert.equal(
      budgetReservationDeletable(row(bad, '1000', true)),
      false,
      `actual ${JSON.stringify(bad)}`,
    );
  for (const bad of ['', 'x', '-1', '00', '1000000000000000000', null, 5])
    assert.equal(
      budgetReservationDeletable(row('5', bad, true)),
      false,
      `max ${JSON.stringify(bad)}`,
    );
  assert.equal(
    budgetReservationDeletable(row('7x', '100', false, 'released')),
    false,
  );
  assert.equal(
    budgetReservationDeletable(row('', '100', false, 'released')),
    false,
  );
  assert.equal(
    budgetReservationDeletable(row(null, '100', true, 'usage_unknown')),
    false,
  );
  assert.equal(
    budgetReservationDeletable(row(null, '100', true, 'reserved')),
    false,
  );
});

test('inherited property names are never rules, even when called directly', () => {
  for (const name of [
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
  ])
    assert.equal(
      clampedDeadline(name, '2026-10-10T00:00:00Z', '2026-10-17T00:00:00Z'),
      null,
      name,
    );
  const plan = sweepPlan({
    now: '2026-10-24T12:00:00Z',
    last_checked_at: null,
    rows: [
      {
        family: 'timed',
        rule: 'constructor',
        id: 'x',
        anchor_at: '2026-10-01T00:00:00Z',
        delete_at: null,
      },
    ],
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(
    plan.holds.map((hold) => hold.reason),
    ['unknown_unit'],
  );
});
