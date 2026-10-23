// 入力バーの送信の判定の試験（UI-03）。期待値は手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopIpcResponse } from '@buddy/contracts';
import { canSubmit, submitResult } from './input-bar-state.js';

const id = '00000000-0000-4000-8000-000000000001';

const turn = (
  status: 'answered' | 'clarification' | 'background' | 'session_control',
): DesktopIpcResponse => ({
  request_id: id,
  channel: 'desktop.turn_submit',
  outcome: 'ok',
  turn: { status, reply_text: null, result: null },
});

test('only a non-blank text is sent, while enabled and not already sending', () => {
  assert.equal(canSubmit('今日の用事を見せて', true, false), true);
  assert.equal(canSubmit('', true, false), false);
  assert.equal(canSubmit('  　 ', true, false), false);
  assert.equal(canSubmit('今日の用事を見せて', false, false), false);
  assert.equal(canSubmit('今日の用事を見せて', true, true), false);
});

test('an answer empties the field; a clarification or any rejection keeps the text and flags the field', () => {
  assert.equal(submitResult(turn('answered')), 'sent');
  assert.equal(submitResult(turn('background')), 'sent');
  assert.equal(submitResult(turn('session_control')), 'sent');
  assert.equal(submitResult(turn('clarification')), 'needs_attention');
  for (const reason of [
    'not_connected',
    'input_stopped',
    'device_locked',
    'outcome_unknown',
    'core_rejected',
  ] as const)
    assert.equal(
      submitResult({
        request_id: id,
        channel: 'desktop.turn_submit',
        outcome: 'rejected',
        reason,
      }),
      'needs_attention',
      reason,
    );
});
