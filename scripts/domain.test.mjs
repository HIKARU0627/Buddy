import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ARG_FIELDS,
  INITIAL_OPERATION_STATES,
  INTENT_NAMES,
  INTENT_POLICIES,
  OPERATION_TRANSITIONS,
  assessReadiness,
  canTransition,
  checkIntentArgs,
} from '../packages/domain/dist/index.js';
import {
  contentHash,
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// ビルド後の domain を検査する。期待値は fixtures の手書きの表で、実装から生成しない。
const { schema, validators } = await loadContracts();
const defs = schema.$defs;
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));
const cases = await read('packages/contracts/fixtures/schema-cases.json');
const fixture = (id) =>
  structuredClone(cases.find((entry) => entry.id === id).value);

test('the domain intent table matches the 24 intents and shared arguments in the schema', () => {
  assert.deepEqual([...INTENT_NAMES], defs.IntentName.enum);
  assert.deepEqual([...ARG_FIELDS], Object.keys(defs.IntentArgs.properties));
  assert.deepEqual(
    [...ARG_FIELDS],
    defs.InputFieldEvidence.properties.field.enum,
  );
  assert.deepEqual(Object.keys(INTENT_POLICIES), [...INTENT_NAMES]);
  for (const [intent, policy] of Object.entries(INTENT_POLICIES)) {
    for (const field of policy.required)
      assert(policy.allowed.includes(field), `${intent}.${field}`);
    if (policy.route === 'read') assert.equal(policy.approval, 'none', intent);
    if (policy.approval === 'screen')
      assert.equal(policy.liveTranscript, false, intent);
  }
  assert.deepEqual(
    [...new Set(Object.values(INTENT_POLICIES).map((policy) => policy.route))]
      .filter((route) => route !== 'read')
      .sort(),
    [...defs.ActionReadiness.properties.route.enum].sort(),
  );
});

test('readiness follows the hand-written QA41 / F01 table', async () => {
  const table = await read('packages/contracts/fixtures/readiness-cases.json');
  for (const entry of table.cases) {
    const checks = { ...table.default_checks, ...entry.checks };
    assert.deepEqual(
      assessReadiness(entry.input, entry.intent, checks),
      entry.expected,
      entry.id,
    );
  }
  const covered = new Set(table.cases.map((entry) => entry.expected.state));
  assert.deepEqual([...covered].sort(), [
    'auto_eligible',
    'blocked',
    'needs_approval',
  ]);
});

test('sealed input alone never authorizes, and read intents have no readiness', () => {
  const ok = {
    utteranceHold: false,
    targetResolved: true,
    evidenceVerified: true,
    permissionCurrent: true,
    policyCurrent: true,
    safetyStopped: false,
    autoPolicyAllows: true,
  };
  const sealed = { state: 'sealed', inputEvidence: 'submitted_text' };
  for (const key of [
    'targetResolved',
    'evidenceVerified',
    'permissionCurrent',
    'policyCurrent',
  ])
    assert.equal(
      assessReadiness(sealed, 'label_mail', { ...ok, [key]: false }).state,
      'blocked',
      key,
    );
  for (const intent of INTENT_NAMES.filter(
    (name) => INTENT_POLICIES[name].route === 'read',
  ))
    assert.throws(() => assessReadiness(sealed, intent, ok), TypeError);
});

test('intent arguments separate clarification from unexpected values', () => {
  const wire = fixture('wire-label');
  assert.deepEqual(checkIntentArgs('label_mail', wire.args), {
    missing: [],
    unexpected: [],
  });
  assert.deepEqual(
    checkIntentArgs('label_mail', { ...wire.args, title: '追加の題' })
      .unexpected,
    ['title'],
  );
  assert.deepEqual(
    checkIntentArgs('label_mail', {
      ...wire.args,
      add_labels: [],
      remove_labels: [],
    }).missing,
    ['add_labels'],
  );
  const empty = Object.fromEntries(ARG_FIELDS.map((field) => [field, null]));
  assert.deepEqual(
    checkIntentArgs('create_event', { ...empty, title: '面談' }).missing,
    ['start'],
  );
  assert.deepEqual(
    checkIntentArgs('update_task', {
      ...empty,
      target_candidate_id: '00000000-0000-4000-8000-000000000021',
      task_change: 'reschedule',
    }).missing,
    ['due'],
  );
  assert.deepEqual(checkIntentArgs('memory_forget', empty).missing, [
    'target_candidate_id',
  ]);
  assert.deepEqual(checkIntentArgs('smalltalk', empty), {
    missing: [],
    unexpected: [],
  });
});

test('models and clients cannot set effect kind, route, approval or state', () => {
  const wire = fixture('wire-label');
  assert(validators.WireResponse(wire));
  for (const field of [
    'effect_kind',
    'route',
    'approved',
    'approval',
    'state',
    'auto_eligible',
  ]) {
    assert(!validators.WireResponse({ ...wire, [field]: 'x' }), field);
    assert(
      !validators.WireResponse({
        ...wire,
        args: { ...wire.args, [field]: 'x' },
      }),
      `args.${field}`,
    );
  }
});

test('local date-times and output targets are checked beyond their shape', () => {
  assert(validators.LocalDateTime('2030-02-28T17:00'));
  assert.deepEqual(semanticErrors('LocalDateTime', '2030-02-28T17:00'), []);
  assert(validators.LocalDateTime('2030-02-30T17:00'));
  assert.deepEqual(semanticErrors('LocalDateTime', '2030-02-30T17:00'), [
    'invalid_local_datetime',
  ]);
  assert(!validators.LocalDateTime('2030-02-28T17:00Z'));
  const output = {
    mode: 'voice',
    device_id: '00000000-0000-4000-8000-000000000050',
    session_epoch: null,
  };
  assert(validators.OutputTarget(output));
  assert.deepEqual(semanticErrors('OutputTarget', output), [
    'voice_without_session_epoch',
  ]);
});

test('X01〜X11 expected operation paths stay inside the 08 §3 state graph', async () => {
  const spec = await read(
    'packages/contracts/fixtures/operation-transitions.json',
  );
  assert.deepEqual(
    Object.keys(OPERATION_TRANSITIONS).sort(),
    [...defs.OperationSnapshot.properties.state.enum].sort(),
  );
  for (const entry of spec.cases) {
    // route を書かない例は RemoteMutation（ADR 0027）。
    const route = entry.route ?? 'remote_mutation';
    assert(INITIAL_OPERATION_STATES.includes(entry.path[0]), entry.id);
    for (let i = 1; i < entry.path.length; i++)
      assert(
        canTransition(entry.path[i - 1], entry.path[i], route),
        `${entry.id}: ${entry.path[i - 1]} -> ${entry.path[i]}`,
      );
    // 成功の証拠は、RemoteMutation では外部変更、LocalCommand では一つの transaction（D5）。
    if (entry.path.at(-1) === 'succeeded')
      if (route === 'local_command') {
        assert.equal(entry.external_writes, 0, entry.id);
        assert.equal(entry.local_transactions, 1, entry.id);
      } else assert(entry.external_writes >= 1, entry.id);
    // D1: 内容版は awaiting_approval への戻りでだけ一つ上がり、他の遷移では変わらない。
    if (entry.content_versions) {
      assert.equal(entry.content_versions.length, entry.path.length, entry.id);
      for (let i = 1; i < entry.path.length; i++) {
        const step =
          BigInt(entry.content_versions[i]) -
          BigInt(entry.content_versions[i - 1]);
        const revised =
          entry.path[i] === 'awaiting_approval' && i > 0 ? 1n : 0n;
        assert.equal(step, revised, `${entry.id} #${i}`);
      }
    }
    if (entry.automatic_retry === false)
      assert(!OPERATION_TRANSITIONS.unknown_held.includes('dispatching'));
  }
  for (const terminal of ['succeeded', 'cancelled', 'superseded'])
    assert.deepEqual(OPERATION_TRANSITIONS[terminal], [], terminal);
  assert(!canTransition('dispatching', 'cancelled'));
  assert(!canTransition('unknown_held', 'dispatching'));
  const { delivered_state_revisions, expected_final_state_revision } =
    spec.event_ordering;
  const final = delivered_state_revisions.reduce((latest, revision) =>
    BigInt(revision) > BigInt(latest) ? revision : latest,
  );
  assert.equal(final, expected_final_state_revision);
});

test('one text request keeps the same IDs and versions from input to operation result', async () => {
  const input = fixture('input-text');
  const wire = fixture('wire-label');
  const interpretation = fixture('interpretation-label');
  const intent = fixture('intent-h01');
  const preview = fixture('preview-label');
  const approve = fixture('approve-label');
  const accepted = fixture('accepted-not-durable');
  const durable = fixture('durable-not-success');
  const operation = fixture('operation-unknown');
  const event = fixture('metadata-event');
  const { expected_sha256 } = await read(
    'packages/contracts/fixtures/h01.json',
  );
  // Core が渡した候補集合（合成）。モデルは候補 ID を選ぶだけで対象を作らない。
  const candidates = {
    '00000000-0000-4000-8000-000000000020': {
      account_id: intent.account_id,
      remote_id: 'mail-001',
      source_revision: 'r1',
    },
  };

  assert(validators.InputSnapshot(input));
  assert(validators.WireResponse(wire));
  assert(validators.Interpretation(interpretation));
  assert.deepEqual(semanticErrors('Interpretation', interpretation), []);
  assert.equal(interpretation.input_id, input.input_id);
  assert.equal(interpretation.workflow_id, input.workflow_id);
  assert.equal(interpretation.request_revision, input.request_revision);
  assert.deepEqual(interpretation.args, wire.args);
  assert.deepEqual(checkIntentArgs(wire.intent, wire.args), {
    missing: [],
    unexpected: [],
  });

  const target = candidates[interpretation.args.target_candidate_id];
  assert.deepEqual(intent.target, {
    remote_id: target.remote_id,
    source_revision: target.source_revision,
  });
  assert.equal(intent.permission_revision, input.permission_revision);
  assert.deepEqual(intent.action.add, interpretation.args.add_labels);

  const readiness = assessReadiness(
    { state: input.state, inputEvidence: input.input_evidence },
    interpretation.intent,
    {
      utteranceHold: false,
      targetResolved: Boolean(target),
      evidenceVerified: true,
      permissionCurrent: true,
      policyCurrent: true,
      safetyStopped: false,
      autoPolicyAllows: false, // 09 §1: 縦断試作は承認経路を試す方針
    },
  );
  assert.equal(readiness.state, 'needs_approval');
  assert(
    validators.ActionReadiness({
      workflow_id: input.workflow_id,
      request_revision: input.request_revision,
      route: readiness.route,
      state: readiness.state,
      reason_codes: [...readiness.reasonCodes],
      policy_version: '1',
      permission_revision: input.permission_revision,
    }),
  );

  assert.equal(contentHash(JSON.stringify(intent)), expected_sha256);
  assert.deepEqual(preview.intent, intent);
  assert.equal(preview.content_hash, expected_sha256);
  assert.equal(approve.preview_id, preview.preview_id);
  assert.equal(approve.content_hash, preview.content_hash);
  assert.equal(approve.content_version, intent.content_version);
  assert.equal(approve.expected_state_revision, preview.state_revision);
  for (const receipt of [accepted, durable]) {
    assert.equal(receipt.request_id, approve.request_id);
    assert.equal(receipt.operation_id, intent.operation_id);
  }
  assert.equal(accepted.committed_state_revision, null);
  assert.equal(durable.committed_state_revision, durable.state_revision);
  assert.equal(event.operation_id, intent.operation_id);
  assert.equal(event.state_revision, durable.committed_state_revision);
  assert.equal(operation.operation_id, intent.operation_id);
  assert.equal(operation.content_hash, expected_sha256);
  assert(BigInt(operation.state_revision) > BigInt(durable.state_revision));
  assert(!operation.allowed_actions.includes('retry'));
});
