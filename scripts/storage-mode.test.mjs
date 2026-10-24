import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AUDIO_CONTROL_RULES,
  INPUT_KIND_RULES,
  PRIVATE_CONFIRMATION_FIELDS,
  SESSION_CONTROL_EFFECTS,
  STORAGE_EFFECTS,
  STORAGE_MODE_NAMES,
  admitLiveStart,
  applyStorageBoundaryEvent,
  initialStorageBoundaryState,
  memoryAdmission,
  nextCarriedSummary,
  privateApprovalErrors,
  privateConfirmationErrors,
  shouldExtractMemories,
  storageModeDecision,
  storageModeStateEffects,
  streamSegmentErrors,
  turnRetentionRule,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

// 記録しない会話の保存の境界（B06-04、ADR 0045）を、手書きの期待値（storage-mode-cases.json）で検査する。
// 期待値は domain の実装から作っていない。$draft / $approval は fixture の中の合成の値を差し込むだけの参照。
const { schema, validators } = await loadContracts();
const spec = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/storage-mode-cases.json', root),
    'utf8',
  ),
);

function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== 'object') return value;
  const { $draft, $approval, ...rest } = value;
  const base =
    $draft !== undefined
      ? structuredClone(spec.drafts[$draft])
      : $approval !== undefined
        ? structuredClone(spec.approvals[$approval])
        : {};
  assert(base !== undefined, `unknown reference ${$draft ?? $approval}`);
  for (const [key, item] of Object.entries(rest)) base[key] = expand(item);
  return base;
}

const sorted = (list) => [...list].sort();

test('許可表のすべての行に、許可側と拒否側の手書きのケースがある', () => {
  assert.deepEqual(
    spec.permission_rows.map((row) => row.effect),
    [...STORAGE_EFFECTS],
  );
  for (const row of spec.permission_rows) {
    assert(
      row.cases.some((entry) => entry.allowed === true),
      `${row.effect} に許可側がない`,
    );
    assert(
      row.cases.some((entry) => entry.allowed === false),
      `${row.effect} に拒否側がない`,
    );
    for (const mode of STORAGE_MODE_NAMES)
      assert(
        row.cases.some(
          (entry) =>
            entry.mode === mode &&
            entry.independent_confirmation_approved === undefined,
        ),
        `${row.effect} に ${mode} のケースがない`,
      );
    assert(
      row.cases.some((entry) => !STORAGE_MODE_NAMES.includes(entry.mode)),
      `${row.effect} に判別できない保存モードのケースがない`,
    );
  }
});

test('許可表の判定が手書きの期待値と一致する', () => {
  for (const row of spec.permission_rows)
    for (const entry of row.cases) {
      const context =
        entry.independent_confirmation_approved === undefined
          ? {}
          : {
              independentConfirmationApproved:
                entry.independent_confirmation_approved,
            };
      const expected = entry.allowed
        ? { allowed: true }
        : { allowed: false, reason: entry.reason };
      assert.deepEqual(
        storageModeDecision(entry.mode, row.effect, context),
        expected,
        `${row.id} ${JSON.stringify(entry)}`,
      );
    }
  for (const entry of spec.unknown_effect_cases)
    assert.deepEqual(storageModeDecision(entry.mode, entry.effect), {
      allowed: false,
      reason: entry.reason,
    });
});

test('契約の StorageModeState と表から作る effects が一致する（X17・X44・X48・X59）', () => {
  for (const mode of STORAGE_MODE_NAMES) {
    const effects = storageModeStateEffects(mode);
    assert.deepEqual(effects, spec.state_effects[mode], mode);
    const state = {
      schema: 'buddy.storage-mode-state.v1',
      segment_id: '00000000-0000-4000-8000-000000000501',
      storage_mode: mode,
      since: '2030-10-05T00:00:00Z',
      effects,
    };
    assert(
      validators.StorageModeState(state),
      `${mode} ${JSON.stringify(validators.StorageModeState.errors)}`,
    );
    // Schema の const と手書きの期待値も一致する（どちらかだけ変えると落ちる）。
    const branch = schema.$defs.StorageModeState.oneOf.find(
      (entry) => entry.properties.storage_mode.const === mode,
    );
    const consts = Object.fromEntries(
      Object.entries(branch.properties.effects.properties).map(
        ([key, value]) => [key, value.const],
      ),
    );
    assert.deepEqual(consts, spec.state_effects[mode], mode);
  }
  for (const mode of ['archived', null, 'PRIVATE'])
    assert.equal(storageModeStateEffects(mode), null);
});

test('独立した確認の中身の検査（会話の本文を持たない）', () => {
  const ids = new Set();
  for (const entry of spec.confirmation_cases) {
    assert(!ids.has(entry.id), entry.id);
    ids.add(entry.id);
    assert.deepEqual(
      sorted(privateConfirmationErrors(expand(entry.draft))),
      sorted(entry.errors),
      entry.id,
    );
  }
  assert(spec.confirmation_cases.some((entry) => entry.errors.length === 0));
  assert(spec.confirmation_cases.some((entry) => entry.errors.length > 0));
});

test('独立した確認の承認は画面での一度だけ', () => {
  for (const entry of spec.approval_cases)
    assert.deepEqual(
      sorted(privateApprovalErrors(entry.approval)),
      sorted(entry.errors),
      entry.id,
    );
});

test('入る・出る・外部変更・音声の接続の順序を入れ替えた遷移', () => {
  for (const sequence of spec.sequences) {
    let state = sequence.start;
    sequence.steps.forEach((step, index) => {
      const label = `${sequence.id} #${index + 1} ${step.event.type}`;
      const result = applyStorageBoundaryEvent(state, expand(step.event));
      assert.equal(result.rejected, step.rejected ?? null, label);
      assert.deepEqual(result.commands, expand(step.commands ?? []), label);
      assert.deepEqual(result.errors, step.errors ?? [], label);
      state = result.state;
    });
    assert.deepEqual(state, sequence.final, sequence.id);
  }
});

test('記録しない区切りの間に書くのは予算の予約と、承認の後の最小の記録だけ（X17）', () => {
  const allowedView = sorted([
    ...PRIVATE_CONFIRMATION_FIELDS,
    'conversation_saved',
  ]);
  const allowedRecord = sorted([
    ...PRIVATE_CONFIRMATION_FIELDS,
    'record_kind',
    'workflow_id',
    'approval',
  ]);
  let records = 0;
  for (const sequence of spec.sequences) {
    let state = sequence.start;
    for (const step of sequence.steps) {
      const before = state.mode;
      const result = applyStorageBoundaryEvent(state, expand(step.event));
      if (before === 'private')
        for (const command of result.commands) {
          if (command.type === 'write')
            assert.equal(command.effect, 'reserve_budget', sequence.id);
          if (command.type === 'show_independent_confirmation') {
            assert.deepEqual(sorted(Object.keys(command.view)), allowedView);
            assert.equal(command.view.conversation_saved, false);
          }
          if (command.type === 'record_minimal_operation') {
            records += 1;
            assert.deepEqual(
              sorted(Object.keys(command.record)),
              allowedRecord,
            );
            assert.equal(command.record.workflow_id, null);
            assert.equal(command.record.record_kind, 'private_minimal');
            assert.equal(command.record.approval.route, 'screen');
          }
        }
      else
        assert(
          result.commands.every(
            (command) => command.type !== 'record_minimal_operation',
          ),
          sequence.id,
        );
      state = result.state;
    }
  }
  assert(records >= 3);
});

// 入る・外部変更を頼む・承認・出る・遅れて届く Live の接続の 5 つを、すべての順序（120 通り）で当てる。
// 期待は実装を通さず、次の規則から決める:
// - 記録しない期間は「入る」から「出る」まで（「出る」が先なら拒否され、期間は最後まで）。
// - 確認を出すのは「頼む」が記録しない期間の中のとき。最小の記録は、その後の「承認」も同じ期間の中のときだけ。
// - Live を閉じる命令は「入る」のときに 1 回だけで、その命令の最初に出る（初めは接続の途中）。
// - 最後の保存モードは、「入る」より後に「出る」があれば normal、なければ private。
// - 承認を待つ確認が最後に残るのは、確認を出したのに記録せず、まだ出ていないときだけ（出ると捨てる）。
test('5 つの事象のすべての順序で、記録と Live の閉じ方が規則どおり', () => {
  const events = {
    enter: { type: 'enter_private', segment_id: 'seg-2' },
    request: {
      type: 'external_change_requested',
      confirmation_id: 'c-1',
      draft: structuredClone(spec.drafts.label_mail),
    },
    approve: {
      type: 'confirmation_approved',
      confirmation_id: 'c-1',
      approval: structuredClone(spec.approvals.screen),
    },
    exit: { type: 'exit_private', segment_id: 'seg-3', mode: 'normal' },
    connected: { type: 'live_connected' },
  };
  const permutations = (list) =>
    list.length <= 1
      ? [list]
      : list.flatMap((item, index) =>
          permutations([...list.slice(0, index), ...list.slice(index + 1)]).map(
            (rest) => [item, ...rest],
          ),
        );
  const orders = permutations(Object.keys(events));
  assert.equal(orders.length, 120);
  for (const order of orders) {
    const at = Object.fromEntries(order.map((name, index) => [name, index]));
    const privateEnd = at.exit > at.enter ? at.exit : Infinity;
    const inPrivate = (index) => index > at.enter && index < privateEnd;
    const expectShow = inPrivate(at.request);
    const expectRecord =
      expectShow && inPrivate(at.approve) && at.approve > at.request;
    let state = {
      ...initialStorageBoundaryState('seg-1', 'normal'),
      live: 'connecting',
    };
    let shows = 0;
    let recordsMade = 0;
    let closes = 0;
    order.forEach((name, index) => {
      const result = applyStorageBoundaryEvent(state, events[name]);
      for (const command of result.commands) {
        if (command.type === 'show_independent_confirmation') shows += 1;
        if (command.type === 'record_minimal_operation') recordsMade += 1;
        if (command.type === 'close_voice_session') {
          closes += 1;
          assert.equal(index, at.enter, order.join(','));
          assert.equal(result.commands[0], command, order.join(','));
        }
        assert.notEqual(command.type, 'write', order.join(','));
      }
      state = result.state;
    });
    assert.equal(shows, expectShow ? 1 : 0, order.join(','));
    assert.equal(recordsMade, expectRecord ? 1 : 0, order.join(','));
    assert.equal(closes, 1, order.join(','));
    assert.equal(
      state.mode,
      at.exit > at.enter ? 'normal' : 'private',
      order.join(','),
    );
    // 承認を待つ確認が残るのは、確認を出したのに記録せず、まだ出ていないときだけ。
    assert.equal(
      state.pending_confirmations.length,
      expectShow && !expectRecord && privateEnd === Infinity ? 1 : 0,
      order.join(','),
    );
  }
});

test('確認と記録は、頼んだ後に呼び出し側が下書きを書き換えても変わらない', () => {
  const draft = structuredClone(spec.drafts.label_mail);
  let state = initialStorageBoundaryState('seg-1', 'normal');
  state = applyStorageBoundaryEvent(state, {
    type: 'enter_private',
    segment_id: 'seg-2',
  }).state;
  const shown = applyStorageBoundaryEvent(state, {
    type: 'external_change_requested',
    confirmation_id: 'c-1',
    draft,
  });
  draft.change.add_labels.push('synthetic-extra');
  draft.target.remote_id = 'mock-mail-999';
  const approved = applyStorageBoundaryEvent(shown.state, {
    type: 'confirmation_approved',
    confirmation_id: 'c-1',
    approval: structuredClone(spec.approvals.screen),
  });
  assert.deepEqual(shown.commands[0].view.change, {
    add_labels: ['follow-up'],
    remove_labels: [],
  });
  assert.deepEqual(approved.commands[0].record.change, {
    add_labels: ['follow-up'],
    remove_labels: [],
  });
  assert.equal(approved.commands[0].record.target.remote_id, 'mock-mail-001');
});

test('既存の規則（音声・記憶・期限・区切り）と許可表が食い違わない', () => {
  // Live（X17・X36）: 記録しない会話では開かない。入るときに閉じる理由と、③の再開条件。
  assert.deepEqual(
    admitLiveStart({
      purpose: 'conversation',
      audioOwner: 'self',
      ioSuspended: false,
      audioLeaseValid: true,
      outputMode: 'voice',
      privateConversation: true,
      consent: 'granted',
      budgetReservable: true,
    }),
    { ok: false, status: 409, code: 'private_conversation' },
  );
  assert.equal(
    SESSION_CONTROL_EFFECTS.start_private_conversation.audio_reason,
    'private_conversation',
  );
  assert.equal(
    SESSION_CONTROL_EFFECTS.start_private_conversation.audio_action,
    'close_voice_session',
  );
  assert.equal(
    AUDIO_CONTROL_RULES.private_conversation.resume,
    'local_asr_until_private_ends',
  );
  assert(
    INPUT_KIND_RULES.find(
      (rule) => rule.input_kind === 'voice_live',
    ).requires.includes('not_private_conversation'),
  );
  assert(
    !INPUT_KIND_RULES.find(
      (rule) => rule.input_kind === 'voice_local',
    ).requires.includes('not_private_conversation'),
  );
  // 記憶（X44・X59）: 抽出 0・保存 0。
  assert.equal(
    shouldExtractMemories({
      trigger: 'conversation_end',
      privateConversation: true,
      userExchanges: 6,
      explicitSaveExchanges: 0,
    }),
    false,
  );
  const admission = memoryAdmission(
    {
      origin: 'explicit_request',
      kind: 'profile',
      target_key: 'synthetic-birthday',
      sources: [{ source_kind: 'turn', source_id: 'turn-1' }],
      dedupe_key: 'synthetic-key',
      forgetting_generation: '0',
      permission_revision: '1',
    },
    {
      privateConversation: true,
      allowedKinds: ['profile'],
      currentForgettingGeneration: '0',
      currentPermissionRevision: '1',
      ledger: [],
      expiredSourceIds: [],
      existing: [],
    },
  );
  assert.equal(admission.action, 'reject');
  assert.deepEqual(admission.reasons, ['private_conversation']);
  // 期限: 記録しない会話の発言は保存しないので期限もない。
  assert.equal(turnRetentionRule('private'), null);
  // 区切り（ADR 0032）: 入る・出るときに開く区切りは要約をつながず、意味の検査を通る。
  const entered = applyStorageBoundaryEvent(
    initialStorageBoundaryState('seg-1', 'normal'),
    { type: 'enter_private', segment_id: 'seg-2' },
  );
  const exited = applyStorageBoundaryEvent(entered.state, {
    type: 'exit_private',
    segment_id: 'seg-3',
    mode: 'normal',
  });
  for (const command of [...entered.commands, ...exited.commands])
    if (command.type === 'open_segment')
      assert.deepEqual(
        streamSegmentErrors({
          segment_id: command.segment_id,
          storage_mode: command.storage_mode,
          opened_at: '2030-10-05T00:00:00Z',
          open_reason: command.open_reason,
          carried_summary: command.carried_summary,
        }),
        [],
      );
  assert.equal(
    nextCarriedSummary({
      previous: {
        source_segment_ids: ['seg-1'],
        expires_at: '2030-10-12T00:00:00Z',
      },
      closing: {
        segment_id: 'seg-2',
        storage_mode: 'private',
        turn_expires_at: [],
      },
      open_reason: 'private_ended',
      now: '2030-10-05T00:00:00Z',
    }),
    null,
  );
});
