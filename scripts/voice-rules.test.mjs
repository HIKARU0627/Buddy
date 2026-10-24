import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AUDIO_CONTROL_RULES,
  BUDGET_CLOSE_GRACE_MS,
  INITIAL_NOTIFICATION_STATE,
  INITIAL_SILENCE_STATE,
  INTENT_NAMES,
  INTENT_POLICIES,
  LIVE_EPOCH_EVENTS,
  LIVE_INITIAL_EXTRA_SECONDS,
  LIVE_INITIAL_RESERVE_SECONDS,
  LIVE_MIN_BILLED_SECONDS,
  LIVE_TOP_UP_INTERVAL_MS,
  LIVE_TOP_UP_SECONDS,
  METHOD_C_OPERATIONS,
  METHOD_C_STABLE_MS,
  NOTIFICATION_BATCH_WINDOW_MS,
  NOTIFICATION_MAX_ITEMS,
  NOTIFICATION_MIN_INTERVAL_MS,
  SEGMENT_BITS_PER_SAMPLE,
  SEGMENT_BRIDGE_SECONDS,
  SEGMENT_CHANNELS,
  SEGMENT_RING_CAPACITY_SAMPLES,
  SEGMENT_RING_MAX_SECONDS,
  SEGMENT_SAMPLE_RATE,
  SESSION_CONTROL_EFFECTS,
  SESSION_START_TOLERANCE_MS,
  SIDEBAND_CONNECT_DEADLINE_MS,
  SILENCE_AFTER_QUESTION_MS,
  SILENCE_DEFAULT_MS,
  SILENCE_EXTENDED_MS,
  SILENCE_TIMEOUT_MS_RANGE,
  STOP_LAYER1_TARGET_MS,
  STOP_LAYER2_DEADLINE_MS,
  VOICE_IPC_TIMEOUTS,
  acceptDeviceEpochReport,
  acceptLeaseRenewal,
  addNotice,
  admitLiveReservation,
  admitMethodC,
  advanceEpoch,
  assessLeaseClock,
  assessStop,
  budgetCloseDeadline,
  classifyEpoch,
  compareTranscripts,
  decideNotification,
  deviceEpochAtStartup,
  emptyRing,
  endsWithQuestion,
  epochsAfterRestore,
  evaluateLiveStartGate,
  evaluateLease,
  grantSilenceExtension,
  holdEpoch,
  issueControlEpoch,
  issueLiveEpochs,
  nextLiveControl,
  observeLease,
  observeSilence,
  planBudgetFailure,
  planStop,
  pushFrame,
  resolveSessionControl,
  sealSegment,
  sessionControlTableErrors,
  settleLiveSeconds,
  shouldCloseForBudget,
  silenceBlockers,
  silenceTimeoutMs,
  topUpSchedule,
  withBuddyUtterance,
} from '../packages/domain/dist/index.js';
import { parseStrictJson, root } from './contract-tools.mjs';

// B05-02（ADR 0041）の音声の純粋な規則を、手書きの期待値（fixtures）で検査する。
// 期待値は domain の実装から作らない。時計は注入した値で、実際の音声・実 API・実機は使わない。
const read = async (name) =>
  parseStrictJson(
    await readFile(
      new URL(`packages/contracts/fixtures/${name}`, root),
      'utf8',
    ),
  );
const lease = await read('voice-lease-clock-cases.json');
const epochs = await read('voice-epoch-cases.json');
const stop = await read('voice-stop-timing-cases.json');
const silence = await read('voice-silence-cases.json');
const reservation = await read('voice-reservation-cases.json');
const notification = await read('voice-notification-rate-cases.json');
const segment = await read('voice-segment-cases.json');
const methodC = await read('voice-method-c-cases.json');
const asr = await read('voice-asr-compare-cases.json');
const phrases = await read('session-control-phrases.json');
const startGate = await read('voice-start-gate-cases.json');

const throwsNamed = (name, run) =>
  assert.throws(run, (error) => error?.constructor?.name === name);

// ---- 1. リースの期限 ------------------------------------------------------------------------------------------------

test('lease clock: verdicts for sleep, skew, monotonic regression and unreadable clocks', () => {
  assert.equal(lease.tolerance_ms_default, 1000);
  for (const entry of lease.clock_cases)
    assert.equal(
      entry.tolerance_ms === undefined
        ? assessLeaseClock(entry.since, entry.now)
        : assessLeaseClock(entry.since, entry.now, entry.tolerance_ms),
      entry.expected,
      entry.id,
    );
});

test('lease status: expiry is counted from the request, the deadline itself is expired, clock faults discard', () => {
  for (const entry of lease.lease_cases) {
    const held = 'held' in entry ? entry.held : lease.held_base;
    assert.deepEqual(evaluateLease(held, entry.now), entry.expected, entry.id);
  }
});

test('lease observation: the previous reading is kept and a monotonic regression is refused without any tolerance', () => {
  for (const scenario of lease.observe_scenarios) {
    let held = lease.held_base;
    for (const [index, step] of scenario.steps.entries()) {
      const observation = observeLease(held, step.now);
      assert.deepEqual(
        observation.status,
        step.expected,
        `${scenario.id} #${index}`,
      );
      // 有効なときだけ状態を持ち越す（直前の観測を今の時計にする）。それ以外は捨てる。
      if (step.expected.status === 'valid')
        assert.deepEqual(observation.held, {
          ...held,
          last_observed: step.now,
        });
      else assert.equal(observation.held, null);
      held = observation.held;
    }
  }
});

test('lease renewal: a late response never extends the lease and clock faults refuse it', () => {
  const { pending, response, current } = lease.renewal_base;
  for (const entry of lease.renewal_cases) {
    const outcome = acceptLeaseRenewal(
      'pending' in entry ? entry.pending : pending,
      { ...response, ...entry.response },
      entry.now,
      { ...current, ...entry.current },
      null,
    );
    assert.deepEqual(outcome, entry.expected, entry.id);
  }
  // 応答がどれだけ遅れても、期限は要求を送った時点から ttl（10000 + 6000）で、受信時刻から足し直した値にならない。
  for (const delay of [0, 1, 1000, 3000, 5999]) {
    const outcome = acceptLeaseRenewal(
      pending,
      response,
      { mono_ms: 10000 + delay, wall_ms: 5000000 + delay },
      current,
      null,
    );
    assert.equal(outcome.held.expires_at_mono_ms, 16000, `delay ${delay}`);
  }
  // 6000 ms 以上遅れた応答は、数え直した期限がすでに過ぎているので延ばさない。
  for (const delay of [6000, 6001, 20000]) {
    const outcome = acceptLeaseRenewal(
      pending,
      response,
      { mono_ms: 10000 + delay, wall_ms: 5000000 + delay },
      current,
      null,
    );
    assert.equal(outcome.held, null, `delay ${delay}`);
    assert.deepEqual(outcome.reasons, ['expired_before_applied']);
  }
});

test('lease renewal: the old lease last observation and the renewal are checked as one transition', () => {
  const { pending, response, current } = lease.renewal_base;
  for (const entry of lease.renewal_with_previous_cases)
    assert.deepEqual(
      acceptLeaseRenewal(
        { ...pending, ...entry.pending },
        response,
        entry.now,
        current,
        entry.previous_held,
      ),
      entry.expected,
      entry.id,
    );
  // 1 つの遷移: 旧いリースを 15000 で観測し、その状態を渡して、14999 で受けた更新の応答を適用する（拒否される）。
  const old = {
    lease_id: pending.lease_id,
    expires_at_mono_ms: 20000,
    sent_at: { mono_ms: 7000, wall_ms: 4997000 },
    last_observed: { mono_ms: 7000, wall_ms: 4997000 },
  };
  const observed = observeLease(old, { mono_ms: 15000, wall_ms: 5005000 });
  assert.equal(observed.status.status, 'valid');
  const request = {
    ...pending,
    requested_at_mono_ms: 12000,
    requested_at_wall_ms: 5002000,
  };
  const late = { mono_ms: 14999, wall_ms: 5005001 };
  assert.equal(
    acceptLeaseRenewal(request, response, late, current, observed.held).held,
    null,
  );
  // 前の観測の引数を省略した呼び出し（渡し忘れ）は受理せず、例外にする。初回だけ明示的に null を渡す。
  assert.throws(
    () => acceptLeaseRenewal(request, response, late, current),
    TypeError,
  );
  // 同じ応答でも、旧いリースの観測を渡さなければ（状態を持たない呼び出し）受理される。これが前回の穴で、渡すのが規則。
  assert.notEqual(
    acceptLeaseRenewal(request, response, late, current, null).held,
    null,
  );
  // 受理したリースの last_observed は、直前の観測より戻らない（応答の時計が同じか進んでいるときだけ受理される）。
  for (const mono of [15000, 15001, 20000]) {
    const out = acceptLeaseRenewal(
      request,
      response,
      { mono_ms: mono, wall_ms: 5005000 + (mono - 15000) },
      current,
      observed.held,
    );
    if (out.held !== null)
      assert(out.held.last_observed.mono_ms >= 15000, `${mono}`);
  }
});

test('lease renewal then evaluation: a renewed lease is valid until the counted deadline and discarded after sleep', () => {
  const { pending, response, current } = lease.renewal_base;
  const { held } = acceptLeaseRenewal(
    pending,
    response,
    { mono_ms: 10100, wall_ms: 5000100 },
    current,
    null,
  );
  assert.deepEqual(evaluateLease(held, { mono_ms: 15999, wall_ms: 5005999 }), {
    status: 'valid',
    remaining_ms: 1,
  });
  assert.deepEqual(evaluateLease(held, { mono_ms: 16000, wall_ms: 5006000 }), {
    status: 'expired',
  });
  assert.deepEqual(evaluateLease(held, { mono_ms: 12000, wall_ms: 5100000 }), {
    status: 'discarded',
    reason: 'sleep_or_clock_skew',
  });
});

// ---- 2. 世代の発行と逆行の拒否 --------------------------------------------------------------------------------------

test('epochs: classification, holding and advancing', () => {
  for (const entry of epochs.classify_cases)
    assert.equal(
      classifyEpoch(entry.given, entry.current),
      entry.expected,
      entry.id,
    );
  // 小さい世代の組を全部試し、数の大小（手書きの規則）と一致すること。
  for (let given = 0; given <= 6; given += 1)
    for (let current = 0; current <= 6; current += 1)
      assert.equal(
        classifyEpoch(String(given), String(current)),
        given === current ? 'current' : given < current ? 'stale' : 'unknown',
        `${given} ${current}`,
      );
  for (const entry of epochs.hold_cases)
    assert.deepEqual(
      holdEpoch(entry.held, entry.incoming),
      entry.expected,
      entry.id,
    );
  for (const entry of epochs.advance_cases) {
    if (entry.throws)
      throwsNamed(entry.throws, () => advanceEpoch(entry.current));
    else assert.equal(advanceEpoch(entry.current), entry.expected, entry.id);
  }
});

test('epochs: the core never lowers a stored device epoch, and a device restarts above both values', () => {
  for (const entry of epochs.device_report_cases)
    assert.deepEqual(
      acceptDeviceEpochReport(epochs.device_report_base, entry.report),
      entry.expected,
      entry.id,
    );
  // 拒否した報告は、保存した値を変えない（入力の値も変えない）。
  const stored = { io_epoch: '4', output_epoch: '7' };
  const before = structuredClone(stored);
  acceptDeviceEpochReport(stored, { io_epoch: '0', output_epoch: '0' });
  assert.deepEqual(stored, before);
  for (const entry of epochs.startup_cases) {
    if (entry.throws)
      throwsNamed(entry.throws, () =>
        deviceEpochAtStartup(entry.core, entry.saved),
      );
    else
      assert.equal(
        deviceEpochAtStartup(entry.core, entry.saved),
        entry.expected,
        entry.id,
      );
  }
});

test('epochs: the core issues audio and session epochs on live start, reconnect and device move only', () => {
  assert.deepEqual(
    [...LIVE_EPOCH_EVENTS],
    ['live_start', 'reconnect', 'device_move'],
  );
  for (const entry of epochs.issue_cases) {
    if (entry.throws)
      throwsNamed(entry.throws, () =>
        issueLiveEpochs(epochs.core_epochs, entry.event),
      );
    else
      assert.deepEqual(
        issueLiveEpochs(epochs.core_epochs, entry.event),
        entry.expected,
        entry.id,
      );
  }
  assert.deepEqual(
    issueControlEpoch(epochs.core_epochs),
    epochs.control_epoch_expected,
  );
  // lost へ入るときの control_epoch は、制御接続の遷移表（nextLiveControl）と同じ値になる。
  const lost = nextLiveControl(
    {
      live_session_id: '00000000-0000-4000-8000-000000000001',
      control_state: 'ready',
      control_epoch: epochs.core_epochs.control_epoch,
      closure: 'open',
      usage_seconds: null,
      reservation_state: 'reserved',
    },
    'ping_timeout',
  );
  assert.equal(
    lost.next.control_epoch,
    epochs.control_epoch_expected.control_epoch,
  );
  for (const entry of epochs.restore_cases) {
    if (entry.throws)
      throwsNamed(entry.throws, () =>
        epochsAfterRestore(epochs.core_epochs, entry.step),
      );
    else
      assert.deepEqual(
        epochsAfterRestore(epochs.core_epochs, entry.step),
        entry.expected,
        entry.id,
      );
  }
  assert.deepEqual(
    epochsAfterRestore(epochs.core_epochs),
    epochs.restore_cases[0].expected,
  );
  // 発行した世代は、前の世代の遅着を古いものとして拒否する（audio_epoch の遅着。QA06）。
  const issued = issueLiveEpochs(epochs.core_epochs, 'reconnect').next;
  assert.equal(
    classifyEpoch(epochs.core_epochs.audio_epoch, issued.audio_epoch),
    'stale',
  );
  assert.equal(
    classifyEpoch(epochs.core_epochs.session_epoch, issued.session_epoch),
    'stale',
  );
});

// ---- 3. 3 層の停止の時間モデル --------------------------------------------------------------------------------------

test('stop timing: the layer targets are the design initial values and match the IPC timeout table', () => {
  assert.equal(STOP_LAYER1_TARGET_MS, stop.constants.layer1_target_ms);
  assert.equal(STOP_LAYER2_DEADLINE_MS, stop.constants.layer2_deadline_ms);
  // 第 2 層の期限は、停止の命令の ACK の待ち時間の上限（表）と同じ値。
  assert.equal(
    VOICE_IPC_TIMEOUTS['voice.suspend_io'].maxAckTimeoutMs,
    STOP_LAYER2_DEADLINE_MS,
  );
  assert.equal(
    VOICE_IPC_TIMEOUTS['voice.stop_playback'].maxAckTimeoutMs,
    STOP_LAYER2_DEADLINE_MS,
  );
});

test('stop timing: what each reason stops locally, and what the core closes afterwards', () => {
  for (const entry of stop.plan_cases)
    assert.deepEqual(planStop(entry.reason), entry.expected, entry.id);
  for (const reason of Object.keys(AUDIO_CONTROL_RULES)) {
    const rule = AUDIO_CONTROL_RULES[reason];
    const plan = planStop(reason);
    // 第 1 層はローカルで完結し、中枢の終了・使用量の照合を待たない。
    assert(!plan.local.includes('core_sideband_close'), reason);
    assert(!plan.local.includes('reconcile_usage_hold_reservation'), reason);
    // Live を閉じる理由だけが、中枢のサイドバンドからの終了と使用量の照合（予約を保持）に進む。
    assert.equal(
      plan.core.includes('core_sideband_close'),
      rule.closesLive,
      reason,
    );
    assert.equal(
      plan.core.includes('reconcile_usage_hold_reservation'),
      rule.closesLive,
      reason,
    );
    // 収音を止める理由だけが、マイク・リング・KWS/ASR を止める。通常の再生停止は収音を止めない。
    assert.equal(
      plan.local.includes('stop_mic_track'),
      rule.stopsCapture,
      reason,
    );
    assert.equal(
      plan.local.includes('discard_pcm_ring'),
      rule.stopsCapture,
      reason,
    );
    assert.equal(
      plan.local.includes('stop_kws_vad_asr_delivery'),
      rule.stopsCapture,
      reason,
    );
    assert.equal(plan.local.includes('close_webrtc'), rule.closesLive, reason);
    assert(plan.local.includes('mute_playback'), reason);
  }
});

test('stop timing: layer 2 is judged at the deadline inclusive, a late ack is never used', () => {
  for (const entry of stop.assess_cases)
    // action も fixture に手書きした値と比べる（planStop から取らない）。
    assert.deepEqual(assessStop(entry.observation), entry.expected, entry.id);
  // 要求から 0〜400 ms の各時点で、ACK がなければ 300 ms まで待ち、1 ms 過ぎたら強制終了する（手書きの規則）。
  for (let waited = 0; waited <= 400; waited += 1) {
    const result = assessStop({
      reason: 'os_lock',
      requested_at_mono_ms: 5000,
      local_stop_completed_at_mono_ms: null,
      ack_at_mono_ms: null,
      ack_accepted: null,
      ack_outcome: null,
      ack_timeout_ms: 300,
      now_mono_ms: 5000 + waited,
      previous_observed_mono_ms: null,
    });
    assert.equal(
      result.layer2.status,
      waited <= 300 ? 'waiting' : 'timed_out',
      `${waited}`,
    );
    assert.equal(
      result.fallback,
      waited <= 300 ? null : 'force_kill_renderer',
      `${waited}`,
    );
  }
  // どの時点で届いた ACK でも、期限（300 ms）より後なら使わない。applied 以外は、いつ届いても停止の完了にしない。
  for (const outcome of [
    'applied',
    'failed',
    'rejected_invalid',
    'ignored_stale_epoch',
  ])
    for (let ackAfter = 0; ackAfter <= 400; ackAfter += 1) {
      const result = assessStop({
        reason: 'os_lock',
        requested_at_mono_ms: 5000,
        local_stop_completed_at_mono_ms: null,
        ack_at_mono_ms: 5000 + ackAfter,
        ack_accepted: true,
        ack_outcome: outcome,
        ack_timeout_ms: 300,
        now_mono_ms: 5000 + 500,
        previous_observed_mono_ms: null,
      });
      assert.equal(
        result.layer2.status,
        outcome !== 'applied'
          ? 'failed'
          : ackAfter <= 300
            ? 'acked'
            : 'timed_out',
        `${outcome} ${ackAfter}`,
      );
      assert.equal(
        result.fallback,
        outcome === 'applied' && ackAfter <= 300 ? null : 'force_kill_renderer',
        `${outcome} ${ackAfter}`,
      );
    }
  // 現在の時刻が要求より前（時計の逆行）なら、ACK がなければいつでも待たずに停止する側（期限を延ばさない）。
  for (const now of [0, 1, 2999, 3599999, 3600000 - 1]) {
    const result = assessStop({
      reason: 'os_lock',
      requested_at_mono_ms: 3600000,
      local_stop_completed_at_mono_ms: null,
      ack_at_mono_ms: null,
      ack_accepted: null,
      ack_outcome: null,
      ack_timeout_ms: 300,
      now_mono_ms: now,
      previous_observed_mono_ms: null,
    });
    assert.equal(result.layer2.status, 'timed_out', `${now}`);
    assert.equal(result.fallback, 'force_kill_renderer', `${now}`);
  }
  // 直前の観測より前の時刻も同じ。同じ値は逆行ではない。
  for (const [now, previous, expected] of [
    [5100, 5200, 'timed_out'],
    [5199, 5200, 'timed_out'],
    [5200, 5200, 'waiting'],
    [5201, 5200, 'waiting'],
  ])
    assert.equal(
      assessStop({
        reason: 'os_lock',
        requested_at_mono_ms: 5000,
        local_stop_completed_at_mono_ms: null,
        ack_at_mono_ms: null,
        ack_accepted: null,
        ack_outcome: null,
        ack_timeout_ms: 300,
        now_mono_ms: now,
        previous_observed_mono_ms: previous,
      }).layer2.status,
      expected,
      `${now} ${previous}`,
    );
});

// ---- 4. 無音の規則 --------------------------------------------------------------------------------------------------

test('silence: constants are the design initial values and agree with the session-control table', () => {
  assert.equal(SILENCE_DEFAULT_MS, silence.constants.default_ms);
  assert.equal(SILENCE_AFTER_QUESTION_MS, silence.constants.after_question_ms);
  assert.equal(SILENCE_EXTENDED_MS, silence.constants.extended_ms);
  // 「ちょっと待って」の効果（会話の操作の表。手書きの fixture）と同じ 60 秒。IPC の範囲の中。
  const wait = phrases.effects.find(
    (entry) => entry.action === 'extend_silence',
  );
  assert.equal(wait.extends_silence_ms, SILENCE_EXTENDED_MS);
  assert.equal(
    SESSION_CONTROL_EFFECTS.extend_silence.extends_silence_ms,
    SILENCE_EXTENDED_MS,
  );
  for (const ms of [
    SILENCE_DEFAULT_MS,
    SILENCE_AFTER_QUESTION_MS,
    SILENCE_EXTENDED_MS,
  ]) {
    assert(
      ms >= SILENCE_TIMEOUT_MS_RANGE.min && ms <= SILENCE_TIMEOUT_MS_RANGE.max,
      `${ms}`,
    );
  }
  assert.equal(silenceTimeoutMs(INITIAL_SILENCE_STATE), 10000);
  assert.equal(
    silenceTimeoutMs(withBuddyUtterance(INITIAL_SILENCE_STATE, true)),
    20000,
  );
});

test('silence: a question at the end of the last utterance is recognised by the code', () => {
  for (const entry of silence.question_cases)
    assert.equal(endsWithQuestion(entry.text), entry.expected, entry.id);
});

test('silence: only delegation in the foreground, playback, screen operation and speech are not counted', () => {
  for (const entry of silence.blocker_cases)
    assert.deepEqual(
      silenceBlockers({ ...silence.input_defaults, ...entry.input }),
      entry.expected,
      entry.id,
    );
});

test('silence: timelines for 10 s, 20 s after a question, one-time 60 s, and uncounted activity', () => {
  for (const scenario of silence.scenarios) {
    let state = INITIAL_SILENCE_STATE;
    for (const [index, step] of scenario.steps.entries()) {
      const label = `${scenario.id} #${index} at ${step.at}`;
      if ('buddy_ended_with_question' in step)
        state = withBuddyUtterance(state, step.buddy_ended_with_question);
      if (step.grant_extension) {
        const result = grantSilenceExtension(state, step.at);
        assert.equal(
          result.granted ? 'granted' : result.reason,
          step.expect_grant,
          label,
        );
        state = result.state;
        continue;
      }
      const result = observeSilence(
        state,
        { ...silence.input_defaults, ...step.input },
        step.at,
      );
      assert.deepEqual(
        {
          decision: result.decision,
          timeout_ms: result.timeout_ms,
          remaining_ms: result.remaining_ms,
        },
        step.expect,
        label,
      );
      state = result.state;
    }
  }
});

// ---- 5. 追加予約の計画・予算到達・精算 ------------------------------------------------------------------------------

test('reservation: 15 s + 180 s first, then 60 s every 60 s', () => {
  const c = reservation.constants;
  assert.equal(LIVE_MIN_BILLED_SECONDS, c.min_billed_seconds);
  assert.equal(LIVE_INITIAL_EXTRA_SECONDS, c.initial_extra_seconds);
  assert.equal(LIVE_INITIAL_RESERVE_SECONDS, c.initial_reserve_seconds);
  assert.equal(LIVE_INITIAL_RESERVE_SECONDS, 15 + 180);
  assert.equal(LIVE_TOP_UP_INTERVAL_MS, c.top_up_interval_ms);
  assert.equal(LIVE_TOP_UP_SECONDS, c.top_up_seconds);
  assert.equal(BUDGET_CLOSE_GRACE_MS, c.budget_close_grace_ms);
  for (const entry of reservation.admission_cases)
    assert.deepEqual(
      admitLiveReservation(entry.available_seconds),
      entry.expected,
      entry.id,
    );
  for (const entry of reservation.schedule_cases) {
    const result = topUpSchedule(entry.elapsed_ms, entry.completed);
    for (const [key, value] of Object.entries(entry.expected))
      assert.equal(result[key], value, `${entry.id} ${key}`);
  }
});

test('reservation: failing to top up tells the user once, closes at the earlier of the end of speech and 10 s, and falls back to local ASR', () => {
  for (const entry of reservation.failure_plan_cases)
    assert.deepEqual(
      planBudgetFailure(entry.sideband_ready),
      entry.expected,
      entry.id,
    );
  for (const entry of reservation.close_deadline_cases)
    assert.equal(
      budgetCloseDeadline(entry.instructed_at_ms, entry.utterance_ended_at_ms),
      entry.expected,
      entry.id,
    );
  for (const entry of reservation.should_close_cases)
    assert.equal(
      shouldCloseForBudget(
        entry.now_ms,
        entry.instructed_at_ms,
        entry.utterance_ended_at_ms,
        entry.previous_observed_ms,
      ),
      entry.expected,
      entry.id,
    );
  // 停止の表の再開条件（予約ができるまで③）と同じ。
  assert.equal(
    AUDIO_CONTROL_RULES.budget_reached.resume,
    'local_asr_until_budget',
  );
  assert.equal(
    AUDIO_CONTROL_RULES.budget_reached.action,
    'close_voice_session',
  );
});

test('reservation: settlement is the larger of 15 s and the confirmed usage, and unconfirmed usage is never settled', () => {
  for (const entry of reservation.settlement_cases)
    assert.deepEqual(
      settleLiveSeconds(entry.usage_seconds, entry.reserved_seconds),
      entry.expected,
      entry.id,
    );
  // X34: 5 秒・10 秒・60 秒の会話を各 10 回。予約は常に 15 秒を下回らない。
  let total = 0;
  for (const run of reservation.x34_runs.sessions)
    for (let i = 0; i < run.count; i += 1) {
      const result = settleLiveSeconds(
        run.usage_seconds,
        LIVE_INITIAL_RESERVE_SECONDS,
      );
      assert.equal(result.billable_seconds, run.expected_billable_seconds);
      assert(LIVE_INITIAL_RESERVE_SECONDS >= LIVE_MIN_BILLED_SECONDS);
      total += result.billable_seconds;
    }
  assert.equal(total, reservation.x34_runs.expected_total_billable_seconds);
  // 0〜20 秒の全ての使用秒数で、精算は max(15, 使用秒数)（手書きの規則）。
  for (let usage = 0; usage <= 20; usage += 1)
    assert.equal(
      settleLiveSeconds(usage, 195).billable_seconds,
      usage < 15 ? 15 : usage,
      `${usage}`,
    );
});

// ---- 6. 音声の通知の頻度の制限 --------------------------------------------------------------------------------------

test('notification: batch for 60 s, one new connection per 5 minutes, five items at most', () => {
  const c = notification.constants;
  assert.equal(NOTIFICATION_BATCH_WINDOW_MS, c.batch_window_ms);
  assert.equal(NOTIFICATION_MIN_INTERVAL_MS, c.min_interval_ms);
  assert.equal(NOTIFICATION_MAX_ITEMS, c.max_items);
  for (const scenario of notification.scenarios) {
    let state = scenario.initial ?? INITIAL_NOTIFICATION_STATE;
    for (const [index, step] of scenario.steps.entries()) {
      const label = `${scenario.id} #${index} at ${step.at}`;
      for (const id of step.add ?? [])
        state = addNotice(state, { id, arrived_at_ms: step.at });
      const outcome = decideNotification(state, {
        now_ms: step.at,
        ...notification.context_defaults,
        ...step.context,
      });
      for (const [key, value] of Object.entries(step.expect))
        assert.deepEqual(outcome.decision[key], value, `${label} ${key}`);
      state = outcome.state;
    }
  }
});

test('notification: a new connection opens exactly when 5 minutes have passed since the last one', () => {
  // 境界の前後（299999・300000・300001）を含む間隔を試す。
  for (const gap of [0, 1, 150000, 299999, 300000, 300001]) {
    const last = 1000000;
    const state = {
      pending: [
        { id: 'x', arrived_at_ms: last + gap - NOTIFICATION_BATCH_WINDOW_MS },
      ],
      last_connection_at_ms: last,
    };
    const outcome = decideNotification(state, {
      now_ms: last + gap,
      mode_enabled: true,
      blocked: null,
      conversation_open: false,
    });
    assert.equal(
      outcome.decision.action,
      gap >= 300000 ? 'read_new_connection' : 'defer',
      `gap ${gap}`,
    );
  }
});

// ---- 6A. Live の接続を始めるときの送信トラックの門 --------------------------------------------------------------------

test('start gate: the send track stays off until session.started and the sideband are both ready', () => {
  assert.equal(
    SIDEBAND_CONNECT_DEADLINE_MS,
    startGate.constants.sideband_connect_deadline_ms,
  );
  assert.equal(
    SESSION_START_TOLERANCE_MS,
    startGate.constants.session_start_tolerance_ms,
  );
  for (const entry of startGate.cases)
    assert.deepEqual(
      evaluateLiveStartGate({ ...startGate.input_base, ...entry.input }),
      entry.expected,
      entry.id,
    );
  // 全ての組（session.started・サイドバンド・入出力の停止・記録しない会話）で、送信トラックが有効になるのは
  // 両方が揃い、止める条件がないときだけ（手書きの規則）。
  for (const session_started of [false, true])
    for (const sideband_connected of [false, true])
      for (const io_suspended of [false, true])
        for (const private_conversation of [false, true])
          for (const elapsed of [0, 3000, 3001]) {
            const gate = evaluateLiveStartGate({
              ...startGate.input_base,
              session_started,
              sideband_connected,
              io_suspended,
              private_conversation,
              elapsed_since_answer_ms: elapsed,
            });
            const label = JSON.stringify([
              session_started,
              sideband_connected,
              io_suspended,
              private_conversation,
              elapsed,
            ]);
            assert.equal(
              gate.send_track_enabled,
              session_started &&
                sideband_connected &&
                !io_suspended &&
                !private_conversation,
              label,
            );
            assert.equal(
              gate.play_listening_clip,
              gate.send_track_enabled,
              label,
            );
            // 送信トラックを有効にしない間は、接続を閉じるか待つか。閉じるときは answer を適用しない。
            if (gate.close_live) assert.equal(gate.apply_answer, false, label);
            // 入出力の停止中は③へ切り替えない。
            if (io_suspended)
              assert.equal(gate.switch_to_local_asr, false, label);
          }
});

// ---- 7. 方式 A の区間リング -----------------------------------------------------------------------------------------

function buildRing(frames, epoch = segment.ring_epoch) {
  let ring = emptyRing(epoch);
  const push = (frame) => {
    const result = pushFrame(ring, epoch, frame);
    assert(result.ok, `fixture frame was rejected: ${JSON.stringify(frame)}`);
    ring = result.ring;
  };
  for (const spec of frames) {
    if (spec.gen) {
      const { first_seq: first, start, count, n } = spec.gen;
      for (let i = 0; i < n; i += 1)
        push({
          frame_seq: first + i,
          start_sample: start + i * count,
          sample_count: count,
        });
    } else push(spec);
  }
  return ring;
}

test('segment ring: 16 kHz mono 16-bit for up to 60 seconds', () => {
  const c = segment.constants;
  assert.equal(SEGMENT_SAMPLE_RATE, c.sample_rate);
  assert.equal(SEGMENT_CHANNELS, c.channels);
  assert.equal(SEGMENT_BITS_PER_SAMPLE, c.bits_per_sample);
  assert.equal(SEGMENT_RING_MAX_SECONDS, c.ring_max_seconds);
  assert.equal(SEGMENT_RING_CAPACITY_SAMPLES, c.ring_capacity_samples);
  assert.equal(SEGMENT_RING_CAPACITY_SAMPLES, 60 * 16000);
  assert.equal(SEGMENT_BRIDGE_SECONDS, c.bridge_seconds);
});

test('segment ring: duplicate frames are ignored, conflicting and regressing frames are refused, old frames are evicted', () => {
  for (const entry of segment.push_cases) {
    const ring = buildRing(entry.frames);
    const result = pushFrame(
      ring,
      entry.epoch ?? segment.ring_epoch,
      entry.push,
    );
    const summary = result.ok
      ? {
          ok: true,
          duplicate: result.duplicate,
          frames: result.ring.frames.length,
          evicted_samples: result.ring.evicted_samples,
        }
      : { ok: false, reason: result.reason };
    assert.deepEqual(summary, entry.expected, entry.id);
  }
});

test('segment seal: sealed only when the whole segment is captured and ASR finished; blocked or truncated otherwise', () => {
  for (const entry of segment.seal_cases) {
    const ring = buildRing(entry.frames);
    const verdict = sealSegment(ring, {
      ...segment.segment_defaults,
      ...entry.segment,
    });
    assert.deepEqual(verdict, entry.expected, entry.id);
  }
});

// ---- 8. 方式 C の 4 操作 --------------------------------------------------------------------------------------------

test('method C: only the four auto-execution operations proceed, every missing observation blocks', () => {
  assert.deepEqual([...METHOD_C_OPERATIONS], methodC.operations);
  assert.equal(METHOD_C_STABLE_MS, methodC.stable_ms);
  for (const entry of methodC.cases)
    assert.deepEqual(
      admitMethodC(entry.intent, { ...methodC.facts_base, ...entry.facts }),
      entry.expected,
      entry.id,
    );
});

test('method C: every intent is classified, and the set that may proceed is exactly the four operations', () => {
  // 全意図を良い入力で試す。proceed になるのは手書きの 5 意図（4 操作）だけで、参照は read_allowed、残りは全文確定へ戻す。
  const proceeding = [];
  for (const intent of INTENT_NAMES) {
    const result = admitMethodC(intent, methodC.facts_base);
    if (INTENT_POLICIES[intent].route === 'read')
      assert.equal(result.decision, 'read_allowed', intent);
    else if (result.decision === 'proceed') proceeding.push(intent);
    else assert.equal(result.decision, 'requires_full_text', intent);
  }
  assert.deepEqual(proceeding.sort(), [
    'create_event',
    'create_note',
    'create_task',
    'draft_reply',
    'label_mail',
  ]);
  assert.deepEqual(
    [
      ...new Set(
        proceeding.map(
          (intent) => admitMethodC(intent, methodC.facts_base).operation,
        ),
      ),
    ].sort(),
    [...methodC.operations].sort(),
  );
  // どの変更の意図も、条件が 1 つでも欠ければ proceed にならない。
  const breaks = [
    { end_candidate_observed: false },
    { target_range_mapped: false },
    { stable_ms: 299 },
    { known_fragment_gap: true },
    { target_turn_unique: false },
    { unresolved_correction: true },
    { missing_args: true },
    { utterance_hold: true },
    { policy_version: null },
  ];
  for (const intent of proceeding)
    for (const change of breaks)
      assert.equal(
        admitMethodC(intent, { ...methodC.facts_base, ...change }).decision,
        'blocked',
        `${intent} ${JSON.stringify(change)}`,
      );
});

// ---- 9. Live と端末の ASR の比較 ------------------------------------------------------------------------------------

test('transcript comparison: numbers, dates, negation and recipients that differ are asked back', () => {
  // メールアドレスの形の文字列は fixture に書かない（公開情報の検査の誤検出を避けるため {at} と書く）。
  const real = (text) => (text === null ? null : text.replaceAll('{at}', '@'));
  for (const entry of asr.cases)
    assert.deepEqual(
      compareTranscripts(real(entry.live), real(entry.asr)),
      entry.expected,
      entry.id,
    );
});

test('transcript comparison: only a near-exact match proceeds, whatever the extraction says', () => {
  const real = (text) => (text === null ? null : text.replaceAll('{at}', '@'));
  // 手書きの規則（実装の関数を使わない）: NFKC・前後の空白・文末の句点・読点・感嘆符・疑問符だけを除いた文字列の一致。
  const oracle = (text) =>
    text
      .normalize('NFKC')
      .trim()
      .replace(/[\s。．、，,.!！?？…]+$/u, '');
  const texts = [];
  for (const entry of asr.cases)
    for (const text of [entry.live, entry.asr])
      if (text !== null && oracle(real(text)) !== '') texts.push(real(text));
  assert(texts.length > 100);
  for (const left of texts)
    for (const right of texts) {
      const result = compareTranscripts(left, right);
      assert.equal(
        result.action === 'proceed',
        oracle(left) === oracle(right),
        `${left} | ${right}`,
      );
      // proceed の説明は空、ask_back は必ず理由がある（説明が付かない差は text_differs）。
      if (result.action === 'proceed') assert.deepEqual(result.reasons, []);
      else assert(result.reasons.length > 0, `${left} | ${right}`);
    }
});

// ---- 10. 会話の操作の照合 -------------------------------------------------------------------------------------------

test('session control: the table is checked for meaning, and only a whole-utterance match becomes a control', () => {
  for (const entry of phrases.table_error_cases)
    assert.deepEqual(
      sessionControlTableErrors(entry.table),
      entry.expected,
      entry.id,
    );
  // B05-01 の fixture の表は、そのまま意味検査を通る。
  assert.deepEqual(sessionControlTableErrors(phrases.table), []);
  const effectOf = (action) =>
    phrases.effects.find((entry) => entry.action === action);
  for (const entry of phrases.resolve_cases) {
    const result = resolveSessionControl(
      entry.utterance,
      phrases.table,
      entry.input_kind,
    );
    if (entry.expected === null) assert.equal(result, null, entry.id);
    else {
      const { effect, ...rest } = result;
      assert.deepEqual(rest, entry.expected, entry.id);
      const { action, ...expectedEffect } = effectOf(entry.expected.action);
      assert.equal(action, entry.expected.action);
      assert.deepEqual(effect, expectedEffect, entry.id);
    }
  }
  const invalid = phrases.resolve_with_an_invalid_table;
  assert.equal(
    resolveSessionControl(invalid.utterance, invalid.table, invalid.input_kind),
    null,
  );
  // B05-01 の照合の例は、すべて同じ結果になる（期待値は fixture の matches）。
  for (const entry of phrases.matches) {
    const result = resolveSessionControl(
      entry.utterance,
      phrases.table,
      'voice_live',
    );
    assert.equal(
      result === null ? null : result.action,
      entry.expected,
      entry.id,
    );
  }
});
