import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import canonicalize from 'canonicalize';
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
  storageOriginRejection,
  streamSegmentErrors,
  turnRetentionRule,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// 記録しない会話の保存の境界（B06-04、ADR 0045）を、手書きの期待値（storage-mode-cases.json）で検査する。
// 期待値は domain の実装から作っていない。$draft / $approval / $origin は fixture の中の合成の値を差し込むだけの参照で、
// 一緒に書いた欄はその値を上書きする（物は中まで、配列と値は置き換え）。"$delete" はその欄を消す。
const { schema, validators } = await loadContracts();
const spec = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/storage-mode-cases.json', root),
    'utf8',
  ),
);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function overlay(base, patch) {
  const result = structuredClone(base);
  for (const [key, item] of Object.entries(patch)) {
    if (item === '$delete') delete result[key];
    else if (isObject(item) && isObject(result[key]))
      result[key] = overlay(result[key], item);
    else result[key] = expand(item);
  }
  return result;
}

function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (!isObject(value)) return value;
  const { $draft, $approval, $origin, ...rest } = value;
  const name = $draft ?? $approval ?? $origin;
  const table =
    $draft !== undefined
      ? spec.drafts
      : $approval !== undefined
        ? spec.approvals
        : $origin !== undefined
          ? spec.origins
          : null;
  if (table === null) return overlay({}, rest);
  assert(table[name] !== undefined, `unknown reference ${name}`);
  return overlay(table[name], rest);
}

const sorted = (list) => [...list].sort();

const contractValid = (operation) =>
  validators.OperationIntent(operation) &&
  semanticErrors('OperationIntent', operation).length === 0;

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

test('確認の下書きは契約の OperationIntent で、内容の hash は別に求めた値と一致する', () => {
  for (const [name, draft] of Object.entries(spec.drafts)) {
    assert(contractValid(draft.operation), name);
    assert.equal(
      createHash('sha256')
        .update(canonicalize(draft.operation), 'utf8')
        .digest('hex'),
      draft.content_hash,
      name,
    );
  }
});

test('独立した確認の中身の検査（確定した変更の型・会話の本文を持たない）', () => {
  const ids = new Set();
  for (const entry of spec.confirmation_cases) {
    assert(!ids.has(entry.id), entry.id);
    ids.add(entry.id);
    const draft = expand(entry.draft);
    const errors = privateConfirmationErrors(draft);
    assert.deepEqual(sorted(errors), sorted(entry.errors), entry.id);
    // 契約との照合（手書きの contract_valid）。domain が通す下書きは、必ず契約も通る（domain の方が狭い）。
    if (entry.contract_valid !== undefined)
      assert.equal(
        contractValid(draft.operation),
        entry.contract_valid,
        entry.id,
      );
    if (errors.length === 0)
      assert.equal(contractValid(draft.operation), true, entry.id);
  }
  assert(spec.confirmation_cases.some((entry) => entry.errors.length === 0));
  assert(spec.confirmation_cases.some((entry) => entry.errors.length > 0));
});

test('独立した確認の承認は画面での一度だけで、世代と内容に結び付く', () => {
  for (const entry of spec.approval_cases)
    assert.deepEqual(
      sorted(privateApprovalErrors(expand(entry.approval))),
      sorted(entry.errors),
      entry.id,
    );
});

test('入る・出る・外部変更・音声の接続・遅れて届く結果の順序を入れ替えた遷移', () => {
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
    assert.deepEqual(state, expand(sequence.final), sequence.id);
  }
});

test('永続化は今の区切りが由来のものだけで、記録しない区切りの間は予算の予約と承認の後の最小の記録だけ（X17）', () => {
  const allowedView = sorted([
    ...PRIVATE_CONFIRMATION_FIELDS,
    'intent',
    'conversation_saved',
  ]);
  const allowedRecord = sorted([
    ...PRIVATE_CONFIRMATION_FIELDS,
    'intent',
    'record_kind',
    'workflow_id',
    'approval',
  ]);
  let records = 0;
  let writes = 0;
  for (const sequence of spec.sequences) {
    let state = sequence.start;
    for (const step of sequence.steps) {
      const before = state;
      const result = applyStorageBoundaryEvent(state, expand(step.event));
      for (const command of result.commands) {
        if (command.type === 'write') {
          writes += 1;
          // 書く物の由来は、事象を当てる前の今の区切り（遅れて届いた結果・失効した区切りの結果は書かない）。
          assert.deepEqual(
            command.origin,
            {
              segment_id: before.segment_id,
              segment_generation: before.segment_generation,
              storage_mode: before.mode,
            },
            sequence.id,
          );
          if (command.origin.storage_mode === 'private')
            assert.equal(command.effect, 'reserve_budget', sequence.id);
        }
        if (command.type === 'hold_in_ram')
          assert.equal(command.origin.storage_mode, 'private', sequence.id);
        if (command.type === 'show_independent_confirmation') {
          assert.equal(before.mode, 'private', sequence.id);
          assert.equal(command.segment_generation, before.segment_generation);
          assert.deepEqual(sorted(Object.keys(command.view)), allowedView);
          assert.equal(command.view.conversation_saved, false);
        }
        if (command.type === 'record_minimal_operation') {
          records += 1;
          assert.equal(before.mode, 'private', sequence.id);
          assert.deepEqual(sorted(Object.keys(command.record)), allowedRecord);
          assert.deepEqual(sorted(Object.keys(command.record.approval)), [
            'approved_at',
            'device_id',
            'route',
          ]);
          assert.equal(command.record.workflow_id, null);
          assert.equal(command.record.record_kind, 'private_minimal');
          assert.equal(command.record.approval.route, 'screen');
          assert(contractValid(command.record.operation), sequence.id);
        }
      }
      state = result.state;
    }
  }
  assert(records >= 4);
  assert(writes >= 10);
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
      origin: structuredClone(spec.origins.seg2p),
      draft: structuredClone(spec.drafts.label_mail),
    },
    approve: {
      type: 'confirmation_approved',
      confirmation_id: 'c-1',
      approval: structuredClone(spec.approvals.label_g2),
    },
    exit: { type: 'exit_private', segment_id: 'seg-3', mode: 'normal' },
    connected: { type: 'live_connected' },
  };
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
    assert.equal(
      state.pending_confirmations.length,
      expectShow && !expectRecord && privateEnd === Infinity ? 1 : 0,
      order.join(','),
    );
  }
});

// 入る（seg-2）・出る（seg-3）・入り直す（seg-4）と、記録しない区切りで始まった処理の結果（要約）・最初の区切りで頼んだ
// 確認への古い承認の 5 つを、すべての順序（120 通り）で当てる。初めに seg-1 を通常の区切りとし、入る・入り直すの前に
// 確認を頼む事象は置かない（頼みは「入る」の直後に自動で当てる）。規則:
// - 要約は、由来（seg-2・世代 2・private）と今の区切りが同じときだけ RAM に持ち、それ以外はどの順序でも永続化しない。
// - 古い承認が記録を作るのは、seg-2 の確認が出ていて、まだ出ていないときだけ（入り直した後の同じ ID の確認には当たらない）。
// 「条件が揃えば出る」側も確かめるため、RAM に持つ数と記録の数を、実装を通さない小さな模型（区切り・世代・確認の有無だけ）で
// 別に数えて照合する。
function expectedLateCounts(order) {
  let mode = 'normal';
  let segment = 'seg-1';
  let generation = 1;
  let firstPending = false;
  let holds = 0;
  let records = 0;
  for (const name of order) {
    if ((name === 'enter' || name === 'reenter') && mode === 'normal') {
      mode = 'private';
      segment = name === 'enter' ? 'seg-2' : 'seg-4';
      generation += 1;
      // seg-2 の確認（由来は seg-2・世代 2）が出るのは、入った区切りが seg-2・世代 2 のときだけ。
      firstPending = segment === 'seg-2' && generation === 2;
    } else if (name === 'exit' && mode === 'private') {
      mode = 'normal';
      segment = 'seg-3';
      generation += 1;
      firstPending = false;
    } else if (
      name === 'late_summary' &&
      mode === 'private' &&
      segment === 'seg-2' &&
      generation === 2
    )
      holds += 1;
    else if (name === 'old_approval' && firstPending && generation === 2) {
      records += 1;
      firstPending = false;
    }
  }
  return { holds, records };
}

test('出た後・入り直した後に遅れて届く結果と承認は、どの順序でも永続化しない', () => {
  let totalHolds = 0;
  let totalRecords = 0;
  const second = {
    type: 'external_change_requested',
    confirmation_id: 'c-1',
    origin: structuredClone(spec.origins.seg4p),
    draft: structuredClone(spec.drafts.label_mail_b),
  };
  const first = {
    type: 'external_change_requested',
    confirmation_id: 'c-1',
    origin: structuredClone(spec.origins.seg2p),
    draft: structuredClone(spec.drafts.label_mail),
  };
  const events = {
    enter: { type: 'enter_private', segment_id: 'seg-2' },
    exit: { type: 'exit_private', segment_id: 'seg-3', mode: 'normal' },
    reenter: { type: 'enter_private', segment_id: 'seg-4' },
    late_summary: {
      type: 'write',
      effect: 'persist_summary',
      origin: structuredClone(spec.origins.seg2p),
    },
    old_approval: {
      type: 'confirmation_approved',
      confirmation_id: 'c-1',
      approval: structuredClone(spec.approvals.label_g2),
    },
  };
  for (const order of permutations(Object.keys(events))) {
    let state = initialStorageBoundaryState('seg-1', 'normal');
    const label = order.join(',');
    let holds = 0;
    let records = 0;
    for (const name of order) {
      const before = state;
      const result = applyStorageBoundaryEvent(state, events[name]);
      state = result.state;
      for (const command of result.commands) {
        assert.notEqual(command.type, 'write', label);
        if (command.type === 'hold_in_ram') {
          holds += 1;
          assert.equal(name, 'late_summary', label);
          assert.equal(before.segment_id, 'seg-2', label);
          assert.equal(before.segment_generation, '2', label);
        }
        if (command.type === 'record_minimal_operation') {
          records += 1;
          assert.equal(name, 'old_approval', label);
          assert.equal(before.segment_generation, '2', label);
          assert.equal(
            command.record.operation.operation_id,
            spec.drafts.label_mail.operation.operation_id,
            label,
          );
        }
      }
      // 入った直後に、その区切りの確認を頼む。
      if (result.rejected === null && name === 'enter')
        state = applyStorageBoundaryEvent(state, first).state;
      if (result.rejected === null && name === 'reenter')
        state = applyStorageBoundaryEvent(state, {
          ...second,
          origin: {
            segment_id: state.segment_id,
            segment_generation: state.segment_generation,
            storage_mode: state.mode,
          },
        }).state;
    }
    assert.deepEqual({ holds, records }, expectedLateCounts(order), label);
    totalHolds += holds;
    totalRecords += records;
  }
  // 出る側の例が実際にある（どの順序でも 0 という空の合格にしない）。
  assert(totalHolds > 0 && totalRecords > 0);
});

test('疎な配列のラベル・宛先は拒否する（JSON では書けないので試験の中で作る）', () => {
  const label = structuredClone(spec.drafts.label_mail);
  label.operation.action.add = ['follow-up'];
  label.operation.action.add.length = 2;
  assert.deepEqual(privateConfirmationErrors(label), ['labels_add_invalid']);
  const sparse = structuredClone(spec.drafts.label_mail);
  sparse.operation.action.remove = [];
  sparse.operation.action.remove[1] = 'waiting';
  assert.deepEqual(privateConfirmationErrors(sparse), [
    'labels_remove_invalid',
  ]);
  const draft = structuredClone(spec.drafts.draft_reply);
  draft.operation.action.cc = [];
  draft.operation.action.cc.length = 1;
  assert.deepEqual(privateConfirmationErrors(draft), ['recipients_cc_invalid']);
});

function permutations(list) {
  return list.length <= 1
    ? [list]
    : list.flatMap((item, index) =>
        permutations([...list.slice(0, index), ...list.slice(index + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );
}

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
    origin: structuredClone(spec.origins.seg2p),
    draft,
  });
  draft.operation.action.add.push('synthetic-extra');
  draft.operation.target.remote_id = 'mock-mail-999';
  draft.operation.extra = '合成の本文';
  const approved = applyStorageBoundaryEvent(shown.state, {
    type: 'confirmation_approved',
    confirmation_id: 'c-1',
    approval: structuredClone(spec.approvals.label_g2),
  });
  assert.deepEqual(
    shown.commands[0].view.operation,
    spec.drafts.label_mail.operation,
  );
  assert.deepEqual(
    approved.commands[0].record.operation,
    spec.drafts.label_mail.operation,
  );
});

test('由来の照合は、出た後・入り直した後・失効した区切りの結果を通さない', () => {
  const state = {
    mode: 'normal',
    segment_id: 'seg-3',
    segment_generation: '3',
  };
  assert.equal(storageOriginRejection(state, spec.origins.seg3), null);
  assert.equal(
    storageOriginRejection(state, spec.origins.seg2p),
    'origin_private',
  );
  assert.equal(
    storageOriginRejection(state, spec.origins.seg1),
    'origin_stale',
  );
  assert.equal(
    storageOriginRejection(state, spec.origins.seg3e),
    'origin_mismatch',
  );
  assert.equal(storageOriginRejection(state, undefined), 'origin_invalid');
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
  // 記憶（X44・X59）: 抽出 0・保存 0。Core は、今の保存モードではなく由来の保存モードを渡す
  // （出た後に届いた記録しない区切りの結果も private として扱う）。
  const privateConversation = spec.origins.seg2p.storage_mode !== 'normal';
  assert.equal(
    shouldExtractMemories({
      trigger: 'conversation_end',
      privateConversation,
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
      privateConversation,
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
