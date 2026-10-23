import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AUDIO_ACTION_REASONS,
  AUDIO_CONTROL_RULES,
  INPUT_CONDITIONS,
  INPUT_KIND_RULES,
  LIVE_CONTROL_TRIGGERS,
  SESSION_CONTROL_EFFECTS,
  SILENCE_TIMEOUT_MS_RANGE,
  VOICE_CLIP_IDS,
  VOICE_IPC_CHANNELS,
  VOICE_IPC_TIMEOUTS,
  admitInputKind,
  admitLiveStart,
  acceptVoiceAck,
  applyLeaseResponse,
  consentChangeErrors,
  consentRecordErrors,
  consentStatus,
  controlAllowsAudioLease,
  controlAllowsVoiceWork,
  leaseRenewalReasons,
  matchSessionControl,
  nextLiveControl,
  rendererEpochDecision,
  retainPendingVoiceRequests,
  resolvePlaybackResume,
  voiceAckErrors,
  voiceRequestErrors,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B05-01（ADR 0038）の契約と domain の規則を、手書きの期待値（fixtures）と Schema の列挙で検査する。
// 期待値は domain の実装から作らない。列挙・表の一致は Schema と fixture を別の正本として照合する。
const { schema, validators } = await loadContracts();
const defs = schema.$defs;
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));
const dir = 'packages/contracts/fixtures/';
const contract = await read(`${dir}voice-contract-cases.json`);
const ipc = await read(`${dir}voice-ipc-cases.json`);
const control = await read(`${dir}live-control-cases.json`);
const lease = await read(`${dir}lease-renewal-cases.json`);
const input = await read(`${dir}input-kind-cases.json`);
const consent = await read(`${dir}consent-cases.json`);
const phrases = await read(`${dir}session-control-phrases.json`);

const sorted = (list) => [...list].sort();

test('IPC channels, clips and reasons match the schema and the stop table', () => {
  assert.deepEqual(
    sorted(VOICE_IPC_CHANNELS),
    sorted(defs.VoiceIpcChannel.enum),
  );
  assert.deepEqual(
    defs.VoiceRendererRequest.oneOf.map((b) => b.properties.channel.const),
    [...VOICE_IPC_CHANNELS],
  );
  assert.deepEqual(sorted(VOICE_CLIP_IDS), sorted(defs.VoiceClipId.enum));
  // 効果音だけで、話し言葉（定型句）の識別子を持たない（質問 99）。
  for (const id of VOICE_CLIP_IDS) assert(!/phrase|say|speech/u.test(id), id);
  const byChannel = Object.fromEntries(
    defs.VoiceRendererRequest.oneOf.map((b) => [
      b.properties.channel.const,
      b.properties.payload.properties,
    ]),
  );
  for (const action of Object.keys(AUDIO_ACTION_REASONS))
    assert.deepEqual(
      byChannel[`voice.${action}`].reason.enum,
      [...AUDIO_ACTION_REASONS[action]],
      action,
    );
  assert.deepEqual(byChannel['voice.suspend_io'].scope.enum, [
    'local',
    'guest',
    'global',
  ]);
  const silence = byChannel['voice.set_silence_timeout'].timeout_ms;
  assert.equal(silence.minimum, SILENCE_TIMEOUT_MS_RANGE.min);
  assert.equal(silence.maximum, SILENCE_TIMEOUT_MS_RANGE.max);
  // 要求の ACK の待ち時間の上限は、どのチャネルの表の値も含む。
  const maximum =
    defs.VoiceRendererRequest.oneOf[0].properties.ack_timeout_ms.maximum;
  for (const rule of Object.values(VOICE_IPC_TIMEOUTS))
    assert(rule.maxAckTimeoutMs <= maximum);
});

test('timeout table follows the 10 §1 three layers and the hand-written expectation', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(VOICE_IPC_TIMEOUTS).map(([channel, rule]) => [
        channel,
        {
          max_ack_timeout_ms: rule.maxAckTimeoutMs,
          on_timeout: rule.onTimeout,
          basis: rule.basis,
        },
      ]),
    ),
    ipc.timeouts,
  );
  // 第 2 層: suspend_io は 300 ms 以内に ACK がなければ音声レンダラーを強制終了する（原本の値）。
  assert.equal(VOICE_IPC_TIMEOUTS['voice.suspend_io'].maxAckTimeoutMs, 300);
  assert.equal(VOICE_IPC_TIMEOUTS['voice.suspend_io'].basis, 'design');
  // 再生停止の ACK が返らない障害では安全側に全停止する。
  assert.equal(
    VOICE_IPC_TIMEOUTS['voice.stop_playback'].onTimeout,
    'escalate_suspend_io',
  );
  // 原本に値がないものは仮置きと明示する（合格値にしない）。
  for (const [channel, rule] of Object.entries(VOICE_IPC_TIMEOUTS))
    if (channel !== 'voice.suspend_io') assert.equal(rule.basis, 'provisional');
});

test('contract cases: shape, then the meaning that the schema cannot express', () => {
  const ids = new Set();
  for (const entry of contract.cases) {
    assert(!ids.has(entry.id), entry.id);
    ids.add(entry.id);
    assert.equal(validators[entry.schema](entry.value), entry.valid, entry.id);
    if (!entry.valid) continue;
    if (entry.schema === 'VoiceRendererRequest')
      assert.deepEqual(
        voiceRequestErrors(entry.value),
        entry.semantic_errors,
        entry.id,
      );
    if (entry.schema === 'ExternalSendConsent')
      assert.deepEqual(
        consentRecordErrors(entry.value).filter(
          (code) => code !== 'revoked_at_mismatch',
        ),
        entry.semantic_errors,
        entry.id,
      );
    if (entry.schema === 'LeaseRenewalRequest')
      assert.equal(
        entry.value.heartbeat_ms >= entry.value.ttl_ms,
        entry.semantic_errors.includes('heartbeat_not_shorter_than_ttl'),
        entry.id,
      );
  }
  // 拒否例は Schema・意味検査のどちらかで必ず止まる。
  const rejected = contract.cases.filter(
    (entry) => !entry.valid || (entry.semantic_errors ?? []).length > 0,
  );
  for (const required of [
    'voice-ipc-unknown-channel',
    'voice-ipc-suspend-os-lock-with-global-scope',
    'lease-renewal-expiry-before-heartbeat',
    'consent-change-grant-without-confirmation',
  ])
    assert(
      rejected.some((entry) => entry.id === required),
      required,
    );
});

test('an unknown IPC name or a reason with the wrong scope is never accepted', () => {
  const request = structuredClone(
    contract.cases.find((entry) => entry.id === 'voice-ipc-suspend-os-lock')
      .value,
  );
  assert.deepEqual(voiceRequestErrors(request), []);
  // どの理由と範囲の組も、domain の表（AUDIO_CONTROL_RULES）の範囲と一致するときだけ受け付ける。
  for (const reason of AUDIO_ACTION_REASONS.suspend_io)
    for (const scope of ['local', 'guest', 'global']) {
      const errors = voiceRequestErrors({
        ...request,
        payload: { ...request.payload, reason, scope },
      });
      assert.equal(
        errors.length === 0,
        AUDIO_CONTROL_RULES[reason].scope === scope,
        `${reason} ${scope}`,
      );
    }
  // 別のチャネルの理由は、Schema を通っても意味検査が拒否する（理由はチャネルの動作の列挙にだけある）。
  assert.deepEqual(
    voiceRequestErrors({
      ...request,
      channel: 'voice.stop_playback',
      payload: { ...request.payload, reason: 'os_lock', scope: null },
    }),
    ['reason_not_for_action'],
  );
  assert.deepEqual(
    voiceRequestErrors({ ...request, channel: 'voice.get_device_token' }),
    ['unknown_channel'],
  );
  assert.deepEqual(voiceRequestErrors({ ...request, ack_timeout_ms: 301 }), [
    'ack_timeout_exceeds_limit',
  ]);
  assert.deepEqual(
    voiceRequestErrors({
      channel: 'voice.set_silence_timeout',
      request_id: request.request_id,
      ack_timeout_ms: 500,
      payload: { timeout_ms: 90000, audio_epoch: '7' },
    }),
    ['silence_timeout_out_of_range'],
  );
});

test('renderer applies only commands for the current epoch, and acks never move epochs back', () => {
  for (const entry of ipc.renderer_epoch_cases)
    assert.equal(
      rendererEpochDecision(entry.command, entry.renderer),
      entry.expected,
      entry.id,
    );
  for (const entry of ipc.ack_cases)
    assert.deepEqual(
      voiceAckErrors(entry.request, entry.ack),
      entry.expected,
      entry.id,
    );
  const currentOf = (entry) => ({ ...ipc.current_base, ...entry.current });
  for (const entry of ipc.accept_ack_cases)
    assert.deepEqual(
      acceptVoiceAck(entry.pending, entry.ack, currentOf(entry)),
      entry.expected,
      entry.id,
    );
  for (const entry of ipc.retain_cases)
    assert.deepEqual(
      retainPendingVoiceRequests(entry.pending, currentOf(entry)).map(
        (request) => request.request_id,
      ),
      entry.expected,
      entry.id,
    );
  // 停止の後に届く遅着: 停止で pending の start を捨てると、その ACK は後から届いても使えない。
  const start = ipc.accept_ack_cases.find(
    (entry) =>
      entry.id === 'late-applied-ack-after-an-io-stop-advanced-the-epoch',
  );
  const stopped = { ...ipc.current_base, io_epoch: '5', io_suspended: true };
  assert.equal(
    acceptVoiceAck(start.pending, start.ack, ipc.current_base).accepted,
    true,
  );
  const kept = retainPendingVoiceRequests(start.pending, stopped);
  assert.deepEqual(kept, []);
  assert.deepEqual(acceptVoiceAck(kept, start.ack, stopped), {
    accepted: false,
    errors: ['no_pending_request'],
  });
  // 世代が 1 つでも戻った ACK は、どの結果でも受け付けない。
  const request = ipc.ack_cases[0].request;
  for (const outcome of defs.VoiceRendererAck.properties.outcome.enum)
    for (const key of ['io_epoch', 'audio_epoch', 'output_epoch']) {
      const ack = {
        ...ipc.ack_cases[0].ack,
        outcome,
        [key]: (BigInt(request.payload[key]) - 1n).toString(),
      };
      assert(voiceAckErrors(request, ack).includes('epoch_regressed'), key);
    }
});

test('playback resumes on a new Live connection unless the same-connection setting is verified', () => {
  for (const entry of ipc.playback_resume_cases)
    assert.equal(
      resolvePlaybackResume(
        entry.same_connection_playback_resume,
        entry.old_stream_excluded,
      ),
      entry.expected,
      entry.id,
    );
  // stop_playback の理由は、どちらも再生キューと世代の照合で再開する（ADR 0005）。再開の方式は設定で決める。
  for (const reason of AUDIO_ACTION_REASONS.stop_playback)
    assert.equal(AUDIO_CONTROL_RULES[reason].resume, 'playback_queue');
});

test('control connection transitions follow 10 §2A', () => {
  const live = control.live_session_id;
  assert.deepEqual(
    sorted(LIVE_CONTROL_TRIGGERS),
    sorted(defs.LiveControlTrigger.enum),
  );
  const stateProps = defs.LiveControlState.properties;
  for (const entry of control.transitions) {
    const from = { live_session_id: live, ...entry.from };
    assert(validators.LiveControlState(from), entry.id);
    const result = nextLiveControl(from, entry.trigger, entry.usage_seconds);
    const expected = entry.expected.ok
      ? {
          ok: true,
          next: { live_session_id: live, ...entry.expected.next },
        }
      : entry.expected;
    assert.deepEqual(result, expected, entry.id);
    if (result.ok) {
      assert(validators.LiveControlState(result.next), entry.id);
      assert.deepEqual(semanticErrors('LiveControlState', result.next), []);
      // 遷移の記録として Schema を通る。
      assert(
        validators.LiveControlTransition({
          live_session_id: live,
          trigger: entry.trigger,
          usage_seconds: entry.usage_seconds,
          before: from,
          after: result.next,
          occurred_at: '2030-10-05T00:00:00Z',
        }),
        entry.id,
      );
    }
  }
  for (const entry of control.permits) {
    const state = {
      live_session_id: live,
      control_state: entry.control_state,
      control_epoch: '1',
      closure: 'open',
      usage_seconds: null,
      reservation_state: 'reserved',
    };
    assert.equal(
      controlAllowsVoiceWork(state),
      entry.voice_work,
      entry.control_state,
    );
    assert.equal(
      controlAllowsAudioLease(state),
      entry.audio_lease,
      entry.control_state,
    );
  }
  // 整合した全ての状態・出来事・使用秒数の組で、性質を独立に確かめる。
  const consistent = [
    ['connecting', 'open', null, 'reserved'],
    ['ready', 'open', null, 'reserved'],
    ['lost', 'open', null, 'reserved'],
    ['closing', 'close_requested', null, 'reserved'],
    ['closed', 'close_unconfirmed', null, 'held'],
    ['closed', 'close_confirmed', 12, 'settled'],
  ];
  const fits = (state) =>
    consistent.some(
      ([name, closure, usage, reservation]) =>
        state.control_state === name &&
        state.closure === closure &&
        state.reservation_state === reservation &&
        (closure === 'close_confirmed'
          ? Number.isInteger(state.usage_seconds) && state.usage_seconds >= 0
          : state.usage_seconds === usage),
    );
  assert.deepEqual(
    sorted(new Set(consistent.map(([name]) => name))),
    sorted(stateProps.control_state.enum),
  );
  let checked = 0;
  for (const [
    control_state,
    closure,
    usage_seconds,
    reservation_state,
  ] of consistent)
    for (const trigger of LIVE_CONTROL_TRIGGERS)
      for (const usage of [null, 0, 27, -1, 1.5]) {
        const before = {
          live_session_id: live,
          control_state,
          control_epoch: '4',
          closure,
          usage_seconds,
          reservation_state,
        };
        const result = nextLiveControl(before, trigger, usage);
        checked += 1;
        if (!result.ok) continue;
        // 整合した状態から整合した状態へだけ動く。
        assert(fits(result.next), `${control_state} ${trigger}`);
        // 世代は戻らず、lost へ入るときだけ進む。
        assert(BigInt(result.next.control_epoch) >= 4n);
        assert.equal(
          BigInt(result.next.control_epoch) > 4n,
          result.next.control_state === 'lost' && control_state !== 'lost',
        );
        // lost・closing・closed から ready へは戻らない。
        if (['lost', 'closing', 'closed'].includes(control_state))
          assert.notEqual(result.next.control_state, 'ready');
        // 精算済みにできるのは、確認した使用秒数があるときだけ。
        if (result.next.reservation_state === 'settled') {
          assert.equal(result.next.closure, 'close_confirmed');
          assert(Number.isInteger(result.next.usage_seconds));
          assert(result.next.usage_seconds >= 0);
        }
      }
  assert(checked > 250);
});

test('lease renewal binds the Core instance, device, scope, epoch and nonce', () => {
  const base = lease.base;
  const merged = (entry) => ({
    stored: entry.stored === undefined ? base.stored : entry.stored,
    context: { ...base.context, ...entry.context },
    request: { ...base.request, ...entry.request },
  });
  for (const entry of lease.cases) {
    const { stored, context, request } = merged(entry);
    assert.deepEqual(
      leaseRenewalReasons(stored, request, context),
      entry.expected,
      entry.id,
    );
  }
  // 理由はどれも応答の Schema の列挙にある。
  const known = new Set(defs.LeaseRenewalRejectReason.enum);
  for (const entry of lease.cases)
    for (const reason of entry.expected) assert(known.has(reason), reason);
  const resp = lease.response_base;
  for (const entry of lease.response_cases) {
    const pending =
      'pending' in entry
        ? entry.pending === null
          ? null
          : { ...resp.pending, ...entry.pending }
        : resp.pending;
    const result = applyLeaseResponse(
      pending,
      { ...resp.response, ...entry.response },
      entry.now_mono_ms ?? resp.now_mono_ms,
      entry.clock_consistent ?? resp.clock_consistent,
      { ...resp.current, ...entry.current },
    );
    assert.deepEqual(result, entry.expected, entry.id);
  }
  // 使い済みの nonce は、直前でなくても受け付けない（A → B → A）。
  const stored = {
    ...base.stored,
    used_nonces: ['nonce-0001', 'nonce-0002'],
    last_requested_at_mono_ms: 3000,
  };
  assert.deepEqual(
    leaseRenewalReasons(
      stored,
      {
        ...base.request,
        nonce: 'nonce-0001',
        previous_nonce: 'nonce-0002',
        requested_at_mono_ms: 5000,
      },
      base.context,
    ),
    ['nonce_reused'],
  );
  // 新しい nonce なら、同じ状態から受け付ける。
  assert.deepEqual(
    leaseRenewalReasons(
      stored,
      {
        ...base.request,
        nonce: 'nonce-0003',
        previous_nonce: 'nonce-0002',
        requested_at_mono_ms: 5000,
      },
      base.context,
    ),
    [],
  );
});

test('input_kind rules: which route, and what is needed', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(INPUT_KIND_RULES)), input.rules);
  for (const rule of input.rules)
    assert(validators.InputKindRule(rule), rule.input_kind);
  assert.deepEqual(sorted(INPUT_CONDITIONS), sorted(defs.InputCondition.enum));
  const conditions = (entry) => {
    const all = new Set(entry.satisfied_list ?? []);
    for (const name of entry.satisfied ?? [])
      for (const condition of input.sets[name]) all.add(condition);
    return Object.fromEntries([...all].map((name) => [name, true]));
  };
  for (const entry of input.cases)
    assert.deepEqual(
      admitInputKind(entry.input_kind, entry.route, conditions(entry)),
      entry.expected,
      entry.id,
    );
  // 端末の HTTP の発言は文字と端末内の声だけ。Live の文字起こしは名乗れない（X49）。
  const turn = defs.TurnRequest.properties.input_kind.enum;
  assert.deepEqual(sorted(turn), ['text', 'voice_local']);
  // Live の文字起こしだけが外部への送信の同意を要る。
  for (const rule of INPUT_KIND_RULES)
    assert.equal(
      rule.requires.includes('external_send_consent'),
      rule.input_kind === 'voice_live',
      rule.input_kind,
    );
  // 返し方は入力の種類だけで決まる（D14）。
  for (const rule of INPUT_KIND_RULES)
    assert.equal(
      rule.output_mode,
      rule.input_kind === 'voice_live' ? 'voice' : 'text',
    );
});

test('external send consent: per device, per destination, per consent text version', () => {
  const merged = (patch) => ({ ...consent.record, ...patch });
  for (const entry of consent.status_cases)
    assert.equal(
      consentStatus(
        entry.record === null ? null : merged(entry.record),
        consent.expected,
      ),
      entry.expected,
      entry.id,
    );
  for (const entry of consent.change_cases)
    assert.deepEqual(
      consentChangeErrors(entry.change),
      entry.expected,
      entry.id,
    );
  for (const entry of consent.record_cases)
    assert.deepEqual(
      consentRecordErrors(merged(entry.record)),
      entry.expected,
      entry.id,
    );
  const base = consent.live_start_base;
  for (const entry of consent.live_start_cases)
    assert.deepEqual(
      admitLiveStart({ ...base, ...entry.context }),
      entry.expected,
      entry.id,
    );
  // 同意が有効でなければ、他の条件がすべて揃っても Live を開かない。
  for (const status of [
    'missing',
    'revoked',
    'policy_outdated',
    'other_device',
  ])
    assert.deepEqual(admitLiveStart({ ...base, consent: status }), {
      ok: false,
      status: 403,
      code: 'external_send_consent_required',
    });
  // 同意の取り消しは Live を閉じる理由として表にある。③は使える。
  assert(AUDIO_ACTION_REASONS.close_voice_session.includes('consent_revoked'));
  assert.equal(AUDIO_CONTROL_RULES.consent_revoked.closesLive, true);
  assert.equal(AUDIO_CONTROL_RULES.consent_revoked.stopsCapture, false);
  assert.equal(
    AUDIO_CONTROL_RULES.consent_revoked.resume,
    'local_asr_until_consent',
  );
});

test('X58: session controls match whole short utterances and map to separate effects', () => {
  assert(validators.SessionControlPhrases(phrases.table));
  for (const entry of phrases.matches)
    assert.equal(
      matchSessionControl(entry.utterance, phrases.table.phrases),
      entry.expected,
      entry.id,
    );
  for (const entry of phrases.table_cases)
    assert.equal(
      validators.SessionControlPhrases(entry.table),
      entry.valid,
      entry.id,
    );
  // 効果の表は手書きの期待値と一致し、どの操作も schema の action にある。
  const actions =
    defs.SessionControlPhrases.properties.phrases.items.properties.action.enum;
  assert.deepEqual(
    sorted(Object.keys(SESSION_CONTROL_EFFECTS)),
    sorted(actions),
  );
  assert.deepEqual(
    phrases.effects.map((entry) => entry.action),
    actions,
  );
  for (const entry of phrases.effects) {
    const { action, ...effect } = entry;
    assert.deepEqual(SESSION_CONTROL_EFFECTS[action], effect, action);
    if (effect.audio_action === null) continue;
    // 停止の表（AUDIO_CONTROL_RULES）の動作と整合する。会話を終えるのは conversation_ended だけ。
    assert(
      AUDIO_ACTION_REASONS[effect.audio_action].includes(effect.audio_reason),
      action,
    );
    assert.equal(
      AUDIO_CONTROL_RULES[effect.audio_reason].endsSession,
      effect.ends_session,
      action,
    );
    // 記録しない会話・文字へ切り替える理由は、そのままの理由で効果に出る。
    assert.equal(
      effect.starts_private_conversation,
      effect.audio_reason === 'private_conversation',
    );
    assert.equal(
      effect.sets_output_mode_text,
      effect.audio_reason === 'output_mode_text',
    );
  }
  // どの言い回しの操作も別の効果を持ち、同じ終了処理に束ねない。
  const pairs = phrases.effects.map(
    (entry) =>
      `${entry.audio_action}/${entry.audio_reason}/${entry.extends_silence_ms}`,
  );
  assert.equal(new Set(pairs).size, pairs.length);
  // 「処理を取り消す」は照合表の操作ではなく、音声も会話も閉じない別の命令（10 §1A）。
  assert.equal(
    matchSessionControl('処理を取り消して', phrases.table.phrases),
    null,
  );
  assert(!actions.includes('cancel_workflow'));
});
