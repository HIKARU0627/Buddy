import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AUDIO_ACTION_REASONS,
  AUDIO_CONTROL_RULES,
  INTENT_NAMES,
  RESULT_VIEW_BY_INTENT,
  acceptDelivery,
  audioControlScopeMatches,
  matchSessionControl,
  resolveOutputMode,
  resultViewKind,
  strongerReason,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// ビルド後の domain を、手書きの期待値（fixtures）と schema の列挙で検査する。
const { schema, validators } = await loadContracts();
const defs = schema.$defs;
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));
const cases = await read('packages/contracts/fixtures/schema-cases.json');
const fixture = (id) =>
  structuredClone(cases.find((entry) => entry.id === id).value);

test('each stop reason belongs to exactly one action, matching the schema', () => {
  const byAction = Object.fromEntries(
    defs.AudioControl.oneOf.map((branch) => [
      branch.properties.action.const,
      branch.properties.reason.enum,
    ]),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(AUDIO_ACTION_REASONS).map(([k, v]) => [k, [...v]]),
    ),
    byAction,
  );
  const all = Object.values(AUDIO_ACTION_REASONS).flat();
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(Object.keys(AUDIO_CONTROL_RULES).sort(), [...all].sort());
  for (const [action, reasons] of Object.entries(AUDIO_ACTION_REASONS))
    for (const reason of reasons)
      assert.equal(AUDIO_CONTROL_RULES[reason].action, action, reason);
  assert.deepEqual(
    [...defs.LiveSessionClose.properties.reason.enum].sort(),
    [
      ...AUDIO_ACTION_REASONS.close_voice_session,
      ...AUDIO_ACTION_REASONS.suspend_io,
    ].sort(),
  );
});

test('stop actions and resume conditions follow the 10 §1A table', async () => {
  const spec = await read(
    'packages/contracts/fixtures/audio-control-cases.json',
  );
  assert.equal(spec.cases.length, Object.keys(AUDIO_CONTROL_RULES).length);
  for (const entry of spec.cases) {
    const rule = AUDIO_CONTROL_RULES[entry.reason];
    assert.deepEqual(
      {
        action: rule.action,
        closes_live: rule.closesLive,
        keeps_mic: !rule.stopsCapture,
        ends_session: rule.endsSession,
        scope: rule.scope,
        resume: rule.resume,
      },
      {
        action: entry.action,
        closes_live: entry.closes_live,
        keeps_mic: entry.keeps_mic,
        ends_session: entry.ends_session,
        scope: entry.scope,
        resume: entry.resume,
      },
      entry.reason,
    );
  }
  for (const entry of spec.overlaps) {
    assert.equal(strongerReason(entry.first, entry.second), entry.expected);
    assert.equal(strongerReason(entry.second, entry.first), entry.expected);
  }
  // 停止はどれも呼びかけ・再接続・ロック解除だけでは入出力を再開しない。
  for (const reason of AUDIO_ACTION_REASONS.suspend_io)
    assert.equal(AUDIO_CONTROL_RULES[reason].resume, 'explicit_screen_resume');
  // 再生停止はマイクと Live を維持し、会話も処理も終えない。
  for (const reason of AUDIO_ACTION_REASONS.stop_playback) {
    assert.equal(AUDIO_CONTROL_RULES[reason].closesLive, false);
    assert.equal(AUDIO_CONTROL_RULES[reason].stopsCapture, false);
  }
});

test('AudioControl scope must match the reason', () => {
  const lock = fixture('audio-suspend-lock');
  assert(validators.AudioControl(lock));
  assert(audioControlScopeMatches(lock.reason, lock.scope));
  assert(validators.AudioControl({ ...lock, scope: 'global' }));
  assert(!audioControlScopeMatches(lock.reason, 'global'));
  assert(audioControlScopeMatches('global_stop', 'global'));
  assert(audioControlScopeMatches('silence', null));
});

test('late results for an old epoch, device or output are rejected', async () => {
  const spec = await read('packages/contracts/fixtures/delivery-cases.json');
  for (const entry of spec.cases)
    assert.deepEqual(
      acceptDelivery(entry.delivery, spec.current),
      entry.expected,
      entry.id,
    );
  const suspended = { ...spec.current, ioSuspended: true };
  for (const entry of spec.suspended_cases)
    assert.deepEqual(
      acceptDelivery(entry.delivery, suspended),
      entry.expected,
      entry.id,
    );
});

test('text requests never flow into a voice session', () => {
  assert.equal(resolveOutputMode('text'), 'text');
  assert.equal(resolveOutputMode('voice_local'), 'text');
  assert.equal(resolveOutputMode('voice_live'), 'voice');
  assert(
    !validators.InteractionMode({ input_kind: 'text', output_mode: 'voice' }),
  );
  const result = fixture('delegation-result-voice');
  assert.deepEqual(semanticErrors('DelegationResult', result), []);
  result.output.mode = 'text';
  result.output.session_epoch = null;
  assert(validators.DelegationResult(result));
  assert.deepEqual(semanticErrors('DelegationResult', result), [
    'delegation_result_not_voice',
  ]);
});

test('live sessions are not settled without confirmed usage', () => {
  const state = fixture('live-control-unconfirmed');
  assert.deepEqual(semanticErrors('LiveControlState', state), []);
  assert.deepEqual(
    semanticErrors('LiveControlState', {
      ...state,
      reservation_state: 'settled',
    }),
    ['settled_without_confirmed_usage'],
  );
  assert.deepEqual(
    semanticErrors('LiveControlState', {
      ...state,
      closure: 'close_confirmed',
    }),
    ['confirmed_without_usage'],
  );
});

test('device input is not permitted while locked, unknown or stopped', () => {
  const device = fixture('device-io-live');
  assert.deepEqual(semanticErrors('DeviceIOState', device), []);
  for (const change of [
    { lock_state: 'unknown' },
    { lock_state: 'locked' },
    { stop_scope: 'global' },
  ])
    assert(
      semanticErrors('DeviceIOState', { ...device, ...change }).includes(
        'input_permitted_while_locked_or_stopped',
      ),
      JSON.stringify(change),
    );
  assert.deepEqual(
    semanticErrors('DeviceIOState', { ...device, private_conversation: true }),
    ['live_without_voice_conditions'],
  );
  assert.deepEqual(
    semanticErrors('Lease', { ...fixture('lease-audio'), heartbeat_ms: 6000 }),
    ['heartbeat_not_shorter_than_ttl'],
  );
});

test('every intent has a result view and approval or clarification takes precedence', () => {
  assert.deepEqual(Object.keys(RESULT_VIEW_BY_INTENT), [...INTENT_NAMES]);
  for (const kind of Object.values(RESULT_VIEW_BY_INTENT))
    assert(defs.ResultViewKind.enum.includes(kind), kind);
  assert.equal(resultViewKind('query_mail', 'done'), 'mail_rows');
  assert.equal(
    resultViewKind('create_event', 'needs_approval'),
    'approval_link',
  );
  assert.equal(
    resultViewKind('label_mail', 'needs_clarification'),
    'clarification',
  );
  assert.equal(resultViewKind('undo_action', 'done'), 'undo_list_link');
});

test('session control phrases match only whole short utterances', async () => {
  const spec = await read(
    'packages/contracts/fixtures/session-control-phrases.json',
  );
  assert(validators.SessionControlPhrases(spec.table));
  for (const entry of spec.matches)
    assert.equal(
      matchSessionControl(entry.utterance, spec.table.phrases),
      entry.expected,
      JSON.stringify(entry.utterance),
    );
});
