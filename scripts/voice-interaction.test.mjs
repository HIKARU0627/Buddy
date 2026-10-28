import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  COMMENTARY_PART_MAX_CHARS,
  EMPTY_HOLD,
  EMPTY_LIVE_TRANSCRIPT,
  HOLD_MAX_MS,
  INTENT_NAMES,
  INTENT_POLICIES,
  LIVE_DELEGATION_WINDOW_MS,
  LIVE_INPUT_WAIT_MS,
  LIVE_MIN_SECONDS_LEFT,
  METHOD_C_STABLE_MS,
  SESSION_CONTROL_EFFECTS,
  SESSION_CONTROL_TABLE,
  admitLiveInput,
  chooseWakeInteraction,
  fixOutputTarget,
  inputCommentary,
  isHeld,
  liveTranscriptFacts,
  observeEndCandidate,
  observeFragment,
  observeSpeechStart,
  planReplyModeChange,
  resolveDelegationTarget,
  resolveHold,
  resolveSessionControl,
  resultCommentary,
  routeResultDelivery,
  sessionControlTableErrors,
  startUtteranceHold,
  turnText,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// B05-05（ADR 0052）の入出力のモード・文字応答への切り替え・結果の届け先・発話開始の一時保留・Live の文字起こしからの委譲の
// 入力の規則を、手書きの期待値（voice-interaction-cases.json）で検査する。期待値は domain の実装から作らない。
// 時計は注入した合成の値。実際の音声・実 API・実機は使わない。
const read = async (name) =>
  parseStrictJson(
    await readFile(
      new URL(`packages/contracts/fixtures/${name}`, root),
      'utf8',
    ),
  );
const spec = await read('voice-interaction-cases.json');
const phrases = await read('session-control-phrases.json');

// ---- 出力先の固定 -----------------------------------------------------------------------------------------------

test('output target: text and local recognition are always text, only a live transcript with an epoch is voice', () => {
  for (const entry of spec.output_cases) {
    const target = fixOutputTarget({
      ...entry.input,
      device_id: spec.device_id,
    });
    assert.deepEqual(
      target,
      { ...entry.expected, device_id: spec.device_id },
      entry.id,
    );
  }
});

test('output target: a request that is not a live transcript never gets a voice output for any epoch', () => {
  for (const kind of ['text', 'voice_local'])
    for (const epoch of [null, '0', '1', '3', '999999999999999999999'])
      assert.deepEqual(
        fixOutputTarget({
          input_kind: kind,
          device_id: spec.device_id,
          session_epoch: epoch,
        }),
        { mode: 'text', device_id: spec.device_id, session_epoch: null },
        `${kind}/${epoch}`,
      );
});

// ---- 結果の届け先 -----------------------------------------------------------------------------------------------

test('delivery: hand-written cases for voice, screen and discard (X13・X29・X47・X49・QA43)', () => {
  for (const entry of spec.delivery_cases)
    assert.deepEqual(
      routeResultDelivery(
        { ...spec.delivery_base, ...entry.override },
        spec.delivery_current,
      ),
      entry.expected,
      entry.id,
    );
  for (const entry of spec.delivery_suspended_cases)
    assert.deepEqual(
      routeResultDelivery(
        { ...spec.delivery_base, ...entry.override },
        { ...spec.delivery_current, ...entry.current },
      ),
      entry.expected,
      entry.id,
    );
});

test('delivery: a text request is never voiced for any combination of the other facts (voice output of text requests is 0)', () => {
  const booleans = [false, true];
  const epochs = [null, '0', '1', '2', '3', '7', '99'];
  let checked = 0;
  for (const revision_current of booleans)
    for (const live_open of booleans)
      for (const reply_text_requested of booleans)
        for (const backgrounded of booleans)
          for (const audio_epoch of epochs)
            for (const output_epoch of epochs)
              for (const session_epoch of epochs)
                for (const suspended of booleans)
                  for (const lease of booleans) {
                    const result = routeResultDelivery(
                      {
                        output: {
                          mode: 'text',
                          device_id: spec.device_id,
                          session_epoch,
                        },
                        audio_epoch,
                        output_epoch,
                        revision_current,
                        live_open,
                        reply_text_requested,
                        backgrounded,
                      },
                      {
                        ...spec.delivery_current,
                        ioSuspended: suspended,
                        audioLeaseValid: lease,
                      },
                    );
                    checked += 1;
                    assert.notEqual(result.channel, 'voice');
                    assert.equal(
                      result.channel,
                      revision_current ? 'screen' : 'discard',
                    );
                  }
  assert.equal(checked, 2 * 2 * 2 * 2 * 7 * 7 * 7 * 2 * 2);
});

test('delivery: a voice output is given only when every condition holds, and any one failure sends it to the screen', () => {
  const base = spec.delivery_base;
  const current = spec.delivery_current;
  assert.equal(routeResultDelivery(base, current).channel, 'voice');
  const failures = [
    [{ revision_current: false }, current, 'discard'],
    [{ live_open: false }, current, 'screen'],
    [{ reply_text_requested: true }, current, 'screen'],
    [{ backgrounded: true }, current, 'screen'],
    [{ audio_epoch: '6' }, current, 'screen'],
    [{ audio_epoch: '8' }, current, 'screen'],
    [{ output_epoch: '1' }, current, 'screen'],
    [{ output_epoch: '3' }, current, 'screen'],
    [{}, { ...current, ioSuspended: true }, 'screen'],
    [{}, { ...current, audioLeaseValid: false }, 'screen'],
    [
      {},
      { ...current, deviceId: '00000000-0000-4000-8000-000000000051' },
      'screen',
    ],
    [{}, { ...current, sessionEpoch: '4' }, 'screen'],
  ];
  for (const [override, now, channel] of failures)
    assert.equal(
      routeResultDelivery({ ...base, ...override }, now).channel,
      channel,
      JSON.stringify([override, now]),
    );
});

// ---- 呼びかけでの ① か ③ の選び方 -------------------------------------------------------------------------------

test('wake: hand-written choices between live, local text and refusal', () => {
  assert.equal(LIVE_MIN_SECONDS_LEFT, 15);
  for (const entry of spec.wake_cases)
    assert.deepEqual(
      chooseWakeInteraction({ ...spec.wake_base, ...entry.override }),
      entry.expected,
      entry.id,
    );
});

test('wake: live opens only when every external-send condition is plainly satisfied', () => {
  let live = 0;
  for (const io_permitted of [false, true])
    for (const reply_mode of ['voice', 'text', 'both'])
      for (const private_conversation of [false, true])
        for (const consent of [
          'granted',
          'missing',
          'revoked',
          'policy_outdated',
          'other_device',
        ])
          for (const budget_seconds_left of [
            null,
            Number.NaN,
            -1,
            0,
            14,
            15,
            3600,
          ])
            for (const recent_live_failure of [false, true])
              for (const core_refused of [false, true]) {
                const result = chooseWakeInteraction({
                  io_permitted,
                  reply_mode,
                  private_conversation,
                  consent,
                  budget_seconds_left,
                  recent_live_failure,
                  core_refused,
                });
                if (result.mode !== 'live') continue;
                live += 1;
                assert.equal(io_permitted, true);
                assert.equal(reply_mode, 'voice');
                assert.equal(private_conversation, false);
                assert.equal(consent, 'granted');
                assert.ok(budget_seconds_left >= 15);
                assert.equal(recent_live_failure, false);
                assert.equal(core_refused, false);
              }
  // 開く組は、入出力の許可・声・記録する会話・同意・残り 15 秒以上（15・3600 の 2 通り）・失敗なし・拒否なしの 2 通りだけ。
  assert.equal(live, 2);
});

// ---- 返し方の切り替え -------------------------------------------------------------------------------------------

test('reply mode: voice to text closes the live now, text to voice never opens or resumes one', () => {
  for (const entry of spec.reply_mode_cases)
    assert.deepEqual(
      planReplyModeChange(entry.input),
      entry.expected,
      entry.id,
    );
  // 声から文字へ切り替えて接続を閉じるのは、声の接続が開いているときだけ。
  for (const current of ['voice', 'text'])
    for (const next of ['voice', 'text'])
      for (const live_active of [false, true]) {
        const change = planReplyModeChange({ current, next, live_active });
        assert.equal(change.opens_live_now, false);
        assert.equal(change.keeps_session, true);
        assert.equal(change.reply_mode, next);
        assert.equal(
          change.close_live !== null,
          current === 'voice' && next === 'text' && live_active,
        );
      }
});

// ---- 発話の開始による一時保留 -----------------------------------------------------------------------------------

test('hold: an utterance start holds only changes that are not sent yet and never extends an existing hold', () => {
  const scenario = spec.hold_scenarios[0];
  const held = startUtteranceHold(EMPTY_HOLD, scenario.in_flight, scenario.now);
  assert.deepEqual(
    held.entries.map((entry) => entry.workflow_id),
    scenario.expected_held,
  );
  assert.deepEqual(held.entries[0], {
    workflow_id: 'w-change',
    request_revision: '1',
    held_at_mono_ms: 1000,
  });
  // 保留中のものは、もう一度発話が始まっても保留の時刻を延ばさず、重ねて入れない。
  const again = startUtteranceHold(held, scenario.in_flight, 5000);
  assert.deepEqual(again.entries, held.entries);
  assert.equal(isHeld(again, 'w-change'), true);
  assert.equal(isHeld(again, 'w-read'), false);
  assert.equal(isHeld(again, 'w-sent'), false);
  // 時計を読めない: 保留の時刻を数えられないので null（呼び出し側は変更を進めない）。
  for (const bad of [Number.NaN, Infinity, undefined, null])
    assert.equal(startUtteranceHold(EMPTY_HOLD, scenario.in_flight, bad), null);
});

test('hold: hand-written resolutions of new, correction, cancel and unknown relations (QA35・X27)', () => {
  assert.equal(HOLD_MAX_MS, 30000);
  for (const entry of spec.hold_scenarios.slice(1)) {
    const state = {
      entries: entry.held.map((id) => ({
        workflow_id: id,
        request_revision: '1',
        held_at_mono_ms: entry.held_at_each?.[id] ?? entry.held_at,
      })),
    };
    const result = resolveHold(state, entry.resolution, entry.now);
    assert.deepEqual(result.decisions, entry.expected.decisions, entry.id);
    assert.equal(result.ask_back, entry.expected.ask_back, entry.id);
    assert.deepEqual(
      result.state.entries.map((item) => item.workflow_id),
      entry.expected.held_after,
      entry.id,
    );
  }
});

test('hold: a change is resumed only for a new relation or after another change was settled, never on an unclear relation', () => {
  const held = {
    entries: ['a', 'b', 'c'].map((id) => ({
      workflow_id: id,
      request_revision: '1',
      held_at_mono_ms: 1000,
    })),
  };
  const targetSets = [
    [],
    [{ workflow_id: 'a', phase: 'pre_dispatch' }],
    [{ workflow_id: 'x', phase: 'pre_dispatch' }],
    [{ workflow_id: 'x', phase: 'dispatched' }],
    [
      { workflow_id: 'a', phase: 'pre_dispatch' },
      { workflow_id: 'b', phase: 'pre_dispatch' },
    ],
    [
      { workflow_id: 'a', phase: 'pre_dispatch' },
      { workflow_id: 'x', phase: 'dispatched' },
    ],
  ];
  for (const relation of [
    'new',
    'clarification',
    'correction',
    'cancel',
    'unknown',
  ])
    for (const targets of targetSets) {
      const result = resolveHold(held, { relation, targets }, 2000);
      const resumed = result.decisions.filter((d) => d.action === 'resume');
      const settled =
        relation !== 'new' &&
        relation !== 'unknown' &&
        targets.length === 1 &&
        (targets[0].phase === 'dispatched' ||
          held.entries.some((e) => e.workflow_id === targets[0].workflow_id));
      if (relation === 'new') {
        assert.equal(
          resumed.length,
          3,
          `${relation}/${JSON.stringify(targets)}`,
        );
        assert.equal(result.ask_back, false);
      } else if (settled) {
        // 対象が 1 つに確定: 対象でない保留だけが再開する。
        assert.equal(result.ask_back, false);
        assert.ok(
          resumed.every((d) => d.workflow_id !== targets[0].workflow_id),
        );
      } else {
        // 確定しない（分からない関係・対象なし・複数・知らない対象）: 1 つも再開せず、聞き返す。
        assert.equal(
          resumed.length,
          0,
          `${relation}/${JSON.stringify(targets)}`,
        );
        assert.equal(result.ask_back, true);
        assert.equal(result.state.entries.length, 3);
      }
    }
});

// ---- Live の文字起こし ------------------------------------------------------------------------------------------

function play(steps) {
  let transcript = EMPTY_LIVE_TRANSCRIPT;
  for (const step of steps) {
    if (step.op === 'speech_start') transcript = observeSpeechStart(transcript);
    else if (step.op === 'end_candidate')
      transcript = observeEndCandidate(transcript);
    else if (step.op === 'fragment')
      transcript = observeFragment(
        transcript,
        {
          index: step.index,
          start_ms: step.start_ms,
          end_ms: step.end_ms,
          text: step.text,
        },
        step.at,
      );
    else throw new Error(`unknown step ${step.op}`);
  }
  return transcript;
}

test('transcript: hand-written scenarios for fragments, gaps, time mapping and the target turn (QA05・X51)', () => {
  assert.equal(LIVE_DELEGATION_WINDOW_MS, 2000);
  assert.equal(LIVE_INPUT_WAIT_MS, 5000);
  for (const entry of spec.transcript_scenarios) {
    const transcript = play(entry.steps);
    const target = resolveDelegationTarget(
      transcript,
      entry.offset_ms,
      entry.claimed ?? [],
    );
    assert.equal(target.count, entry.expected.count, entry.id);
    assert.equal(
      target.turn === null ? null : turnText(target.turn),
      entry.expected.text,
      entry.id,
    );
    assert.deepEqual(
      liveTranscriptFacts(target, entry.now),
      entry.expected.facts,
      entry.id,
    );
  }
});

test('transcript: fragments are ordered by their number and times are checked only when they are whole numbers', () => {
  const transcript = play([
    { op: 'speech_start' },
    { op: 'fragment', index: 0, start_ms: 0, end_ms: 100, text: 'あ', at: 1 },
    { op: 'fragment', index: 1, start_ms: 100, end_ms: 200, text: 'い', at: 2 },
  ]);
  assert.equal(turnText(transcript.turns[0]), 'あい');
  for (const bad of [
    { start_ms: 1.5, end_ms: 200 },
    { start_ms: -1, end_ms: 200 },
    { start_ms: 300, end_ms: 200 },
    { start_ms: Number.NaN, end_ms: 200 },
  ]) {
    const next = observeFragment(
      observeSpeechStart(EMPTY_LIVE_TRANSCRIPT),
      { index: 0, text: 'あ', ...bad },
      1,
    );
    assert.equal(next.turns[0].mapping_unverified, true, JSON.stringify(bad));
  }
  // 時計を読めない断片は、時刻の対応を確かめられない。
  const clockless = observeFragment(
    observeSpeechStart(EMPTY_LIVE_TRANSCRIPT),
    { index: 0, start_ms: 0, end_ms: 100, text: 'あ' },
    Number.NaN,
  );
  assert.equal(clockless.turns[0].mapping_unverified, true);
  assert.equal(clockless.turns[0].last_fragment_mono_ms, null);
});

// ---- 入力の受付と方式 C の限定 ----------------------------------------------------------------------------------

const allConditions = Object.fromEntries(
  spec.live_input_conditions.map((name) => [name, true]),
);

test('live input: hand-written decisions for the four operations, full-text cases, reads and blockers (QA41・X51・X59)', () => {
  for (const entry of spec.live_input_cases) {
    const request = {
      ...spec.live_input_base,
      ...entry.override,
      conditions: allConditions,
    };
    assert.deepEqual(admitLiveInput(request), entry.expected, entry.id);
  }
});

test('live input: a failed input condition stops everything and reports every missing condition in table order', () => {
  for (const entry of spec.live_input_rejections) {
    const conditions = { ...allConditions };
    for (const name of entry.missing_conditions) conditions[name] = false;
    assert.deepEqual(
      admitLiveInput({ ...spec.live_input_base, conditions }),
      { decision: 'reject', reasons: entry.expected_reasons },
      entry.id,
    );
  }
  // 渡さなかった条件は満たされていないものとして扱う。
  assert.equal(
    admitLiveInput({ ...spec.live_input_base, conditions: {} }).decision,
    'reject',
  );
  // 入力の条件を満たさないとき、参照でも何も処理しない。
  assert.equal(
    admitLiveInput({
      ...spec.live_input_base,
      intent: 'query_schedule',
      conditions: { ...allConditions, voice_output_mode: false },
    }).decision,
    'reject',
  );
});

test('live input: exactly the four operations proceed, and no screen-approval or memory intent ever proceeds (C accepts four operations only)', () => {
  // 手書きの一覧: 方式 C から進めてよい意図（自分だけの予定は own_event_only のときだけ）。
  const proceeds = new Set([
    'create_task',
    'create_note',
    'label_mail',
    'draft_reply',
    'create_event',
  ]);
  const flags = [false, true];
  let combos = 0;
  for (const intent of INTENT_NAMES)
    for (const end_candidate_observed of flags)
      for (const target_range_mapped of flags)
        for (const stable_ms of [0, 299, 300, 100000])
          for (const known_fragment_gap of flags)
            for (const target_turn_unique of flags)
              for (const unresolved_correction of flags)
                for (const missing_args of flags)
                  for (const utterance_hold of flags)
                    for (const policy_version of [null, '', '1'])
                      for (const own_event_only of flags) {
                        const decision = admitLiveInput({
                          intent,
                          transcript: {
                            end_candidate_observed,
                            target_range_mapped,
                            stable_ms,
                            known_fragment_gap,
                            target_turn_unique,
                          },
                          conditions: allConditions,
                          unresolved_correction,
                          missing_args,
                          utterance_hold,
                          policy_version,
                          own_event_only,
                        });
                        combos += 1;
                        if (decision.decision !== 'proceed') continue;
                        assert.ok(proceeds.has(intent), intent);
                        assert.equal(
                          INTENT_POLICIES[intent].route === 'read',
                          false,
                        );
                        assert.equal(
                          INTENT_POLICIES[intent].approval,
                          'policy',
                        );
                        assert.equal(
                          INTENT_POLICIES[intent].liveTranscript,
                          true,
                        );
                        assert.ok(
                          end_candidate_observed && target_range_mapped,
                        );
                        assert.ok(stable_ms >= METHOD_C_STABLE_MS);
                        assert.ok(!known_fragment_gap && target_turn_unique);
                        assert.ok(!unresolved_correction && !missing_args);
                        assert.ok(!utterance_hold);
                        assert.equal(policy_version, '1');
                        if (intent === 'create_event')
                          assert.ok(own_event_only);
                        assert.equal(
                          decision.input_evidence,
                          'live_policy_observed',
                        );
                      }
  assert.equal(
    combos,
    INTENT_NAMES.length * 2 * 2 * 4 * 2 * 2 * 2 * 2 * 2 * 3 * 2,
  );
  // 記憶の保存・承認が要る操作は、観測がすべてそろっても全文の確定へ戻す。
  for (const intent of [
    'memory_save',
    'memory_forget',
    'memory_correct',
    'update_event',
    'send_mail',
    'trash_mail',
    'update_task',
    'handoff_screen',
  ])
    assert.equal(
      admitLiveInput({
        ...spec.live_input_base,
        intent,
        conditions: allConditions,
      }).decision,
      'full_text_required',
      intent,
    );
});

// ---- 会話の操作の照合表と声で返す定型文 -------------------------------------------------------------------------

test('session control table: the production table is the hand-written table, valid, and resolves every hand-written example', () => {
  assert.deepEqual(SESSION_CONTROL_TABLE, phrases.table);
  assert.deepEqual(sessionControlTableErrors(SESSION_CONTROL_TABLE), []);
  for (const entry of phrases.matches) {
    const text = resolveSessionControl(
      entry.utterance,
      SESSION_CONTROL_TABLE,
      'text',
    );
    assert.equal(text?.action ?? null, entry.expected, entry.id);
    // 照合に当たれば LLM を呼ばない。文字の画面では、接続への操作ではなく画面の操作と同じ処理。
    if (text !== null) {
      assert.equal(text.bypass_intent_llm, true);
      assert.equal(text.applies_to_live_connection, false);
    }
    const live = resolveSessionControl(
      entry.utterance,
      SESSION_CONTROL_TABLE,
      'voice_live',
    );
    assert.equal(live?.action ?? null, entry.expected, entry.id);
  }
  // 声（Live）では、停止・終了・文字へ切り替え・無音の延長が開いている接続への操作になる。
  const expectedOnLive = {
    extend_silence: true,
    stop_playback: true,
    end_conversation: true,
    start_private_conversation: true,
    reply_in_text: true,
  };
  for (const [action, expected] of Object.entries(expectedOnLive)) {
    const phrase = SESSION_CONTROL_TABLE.phrases.find(
      (p) => p.action === action,
    );
    assert.equal(
      resolveSessionControl(phrase.phrase, SESSION_CONTROL_TABLE, 'voice_live')
        .applies_to_live_connection,
      expected,
      action,
    );
  }
  // どの操作も別々の効果で、同じ終了処理に束ねない。
  const reasons = Object.values(SESSION_CONTROL_EFFECTS).map(
    (effect) => effect.audio_reason,
  );
  assert.equal(new Set(reasons.filter((r) => r !== null)).size, 4);
});

test('commentary: hand-written fixed sentences, nothing says a change was done, every part fits one append', () => {
  for (const entry of spec.commentary_cases)
    assert.deepEqual(resultCommentary(entry.input), entry.expected, entry.id);
  for (const kind of ['say_again', 'full_text']) {
    const commentary = inputCommentary(kind);
    assert.equal(commentary.commentary_parts.length, 1);
    assert.equal(commentary.template_version, '1');
  }
  assert.equal(inputCommentary('say_again').template_id, 'input.say_again');
  assert.equal(inputCommentary('full_text').template_id, 'input.full_text');
  // 長すぎる聞き返しの文は使わず、言い直しの定型文にする（1 回の追記に収まる長さ）。
  const long = resultCommentary({
    kind: 'clarification',
    event_count: 0,
    overlap: false,
    more_count: 0,
    clarification_text: 'あ'.repeat(COMMENTARY_PART_MAX_CHARS + 1),
  });
  assert.equal(long.template_id, 'input.say_again');
  // どの種類・件数でも、読み上げの文は 3 つ以内で、1 つが上限の長さ以内。完了を告げる語（登録しました等）を含まない。
  for (const kind of [
    'schedule_cards',
    'task_rows',
    'insight_rows',
    'mail_rows',
    'memory_rows',
    'completion_line',
    'approval_link',
    'clarification',
    'speech_bubble',
    'accepted_line',
    'status_line',
    'undo_list_link',
  ])
    for (const event_count of [0, 1, 50, -3, Number.NaN])
      for (const more_count of [0, 7, -1])
        for (const overlap of [false, true]) {
          const out = resultCommentary({
            kind,
            event_count,
            overlap,
            more_count,
            clarification_text: null,
          });
          assert.ok(
            out.commentary_parts.length >= 1 &&
              out.commentary_parts.length <= 3,
          );
          for (const part of out.commentary_parts) {
            assert.ok(part.length <= COMMENTARY_PART_MAX_CHARS);
            assert.doesNotMatch(part, /登録|保存|送信|送りました|作成/u);
          }
        }
});
