import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  APPROVAL_REQUIRED_OPERATION_KINDS,
  DISPATCH_GUARD_REJECTIONS,
  OPERATION_KINDS,
  OPERATION_KIND_RULES,
  OPERATION_STEP_KINDS,
  canDispatch,
  dispatchGuardReasons,
  preconditionReads,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B14-01（ADR 0075）: 送信・予定の変更・参加者のいる予定の作成・ごみ箱の契約と、
// 送出直前の照合の拒否。期待値は Issue #197 と ADR 0075 から手で書き、実装から生成しない。
const { validators, schema } = await loadContracts();
const defs = schema.$defs;
const cases = parseStrictJson(
  await readFile(
    new URL(
      'packages/contracts/fixtures/approval-required-operations-cases.json',
      root,
    ),
    'utf8',
  ),
);

test('the four approval-required operations are separate and keep no permanent delete', () => {
  assert.deepEqual(
    [...APPROVAL_REQUIRED_OPERATION_KINDS],
    [
      'mail.send',
      'calendar.event.update',
      'calendar.event.create_with_attendees',
      'mail.trash',
    ],
  );
  assert.deepEqual(
    [...APPROVAL_REQUIRED_OPERATION_KINDS],
    defs.ApprovalRequiredOperationKind.enum,
  );
  for (const kind of APPROVAL_REQUIRED_OPERATION_KINDS)
    assert(OPERATION_KINDS.includes(kind), kind);
  // 完全削除・空にする操作は語彙にない。
  for (const kind of OPERATION_KINDS)
    assert(!/delete|purge|empty|permanent/iu.test(kind), kind);
});

test('the four operations go through remote mutation and keep their steps', () => {
  for (const kind of APPROVAL_REQUIRED_OPERATION_KINDS) {
    const rule = OPERATION_KIND_RULES[kind];
    assert.equal(rule.route, 'remote_mutation', kind);
    assert.equal(
      rule.preconditions.includes('conditional_request'),
      false,
      kind,
    );
    assert.equal(
      rule.preconditions.includes('recheck_before_dispatch'),
      true,
      kind,
    );
    assert.equal(rule.steps.length, 1, kind);
    assert(OPERATION_STEP_KINDS.includes(rule.steps[0]), kind);
    // 送出の前に、対象と許可を読み直す（参加者のいる作成は対象がないので許可だけ）。
    assert.deepEqual(
      preconditionReads(rule, 'recheck_before_dispatch'),
      rule.precondition_target_read === null
        ? ['permission']
        : [rule.precondition_target_read, 'permission'],
      kind,
    );
  }
  assert.equal(
    OPERATION_KIND_RULES['calendar.event.update'].reconcile_scope,
    'exact_target',
  );
  assert.equal(
    OPERATION_KIND_RULES['mail.trash'].reconcile_scope,
    'exact_target',
  );
  assert.equal(
    OPERATION_KIND_RULES['calendar.event.create_with_attendees'].steps[0],
    'create_event_with_attendees',
  );
  assert.notEqual(
    OPERATION_KIND_RULES['calendar.event.create_with_attendees'].steps[0],
    OPERATION_KIND_RULES['calendar.event.update'].steps[0],
  );
});

test('the fixture keeps the allowed and rejected shapes of the four operations', () => {
  for (const entry of cases.cases) {
    const validate = validators[entry.schema];
    assert(validate, entry.schema);
    assert.equal(
      validate(entry.value),
      entry.valid,
      `${entry.id}: ${JSON.stringify(validate.errors)}`,
    );
    if (entry.valid)
      assert.deepEqual(
        semanticErrors(entry.schema, entry.value),
        entry.semantic_errors ?? [],
        entry.id,
      );
  }
  const send = cases.cases.find((entry) => entry.id === 'send').value;
  // 宛先を変えたら hash が変わる前提で、宛先は承認の対象（intent）に入る。
  assert.deepEqual(send.action.to, ['one@example.com']);
  assert.deepEqual(send.effects.external_recipients, [
    'one@example.com',
    'two@example.com',
  ]);
  const trash = cases.cases.find((entry) => entry.id === 'trash').value;
  assert.equal(trash.action.kind, 'mail.trash');
  assert.deepEqual(trash.target, {
    remote_id: 'mail-001',
    source_revision: 'r1',
  });
  // 終日の逆順と、日付と日時の混在も拒否する。
  for (const id of ['calendar-all-day-reversed', 'calendar-mixed-time-order'])
    assert.deepEqual(
      cases.cases.find((entry) => entry.id === id).semantic_errors,
      ['event_time_order'],
      id,
    );
});

test('the dispatch guard turns every required rejection into a reason', () => {
  assert.deepEqual(
    [...DISPATCH_GUARD_REJECTIONS],
    [
      'not_approved',
      'approval_cancelled',
      'content_changed',
      'recipient_changed',
      'target_changed',
      'stale_version',
    ],
  );
  assert.deepEqual(
    [...DISPATCH_GUARD_REJECTIONS],
    defs.DispatchGuardRejection.enum,
  );
  const guards = cases.cases.filter(
    (entry) => entry.schema === 'DispatchGuard',
  );
  assert(guards.length >= 8);
  for (const entry of guards) {
    assert.deepEqual(
      dispatchGuardReasons(entry.value),
      entry.expected_reasons,
      entry.id,
    );
    assert.equal(
      canDispatch(entry.value),
      entry.expected_reasons.length === 0,
      entry.id,
    );
  }
  const byId = (id) => guards.find((entry) => entry.id === id);
  assert(canDispatch(byId('guard-allowed-send').value));
  assert(canDispatch(byId('guard-created-event-allowed').value));
  assert.deepEqual(dispatchGuardReasons(byId('guard-not-approved').value), [
    'not_approved',
  ]);
  assert.deepEqual(dispatchGuardReasons(byId('guard-cancelled').value), [
    'approval_cancelled',
  ]);
  assert.deepEqual(dispatchGuardReasons(byId('guard-content-changed').value), [
    'content_changed',
  ]);
  assert.deepEqual(
    dispatchGuardReasons(byId('guard-recipient-changed').value),
    ['recipient_changed'],
  );
  assert.deepEqual(
    dispatchGuardReasons(byId('guard-event-target-changed').value),
    ['target_changed'],
  );
  assert.deepEqual(dispatchGuardReasons(byId('guard-stale-version').value), [
    'stale_version',
  ]);
  // 新規の送信は既存の対象を持たない。宛先が同じなら送出できる。
  assert(canDispatch(byId('guard-new-send-allowed').value));
  assert.deepEqual(
    dispatchGuardReasons(byId('guard-calendar-recipient-changed').value),
    ['recipient_changed'],
  );
  // 結果不明は拒否の語彙に入れず、保留として別に扱う。
  assert(!DISPATCH_GUARD_REJECTIONS.includes('unknown_result'));
});
