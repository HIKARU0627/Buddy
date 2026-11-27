// 流れの表示先「このPCに出す」の欄を決める純粋な関数の試験（UI-05 の段階 5、ADR 0193）。期待値の文言は手で書いた。
// 今の表示先の値（この端末・他の端末）は既存の 8 項目の「表示先」が出すので、この欄は操作だけを決める。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopStatusBar } from '@buddy/contracts';
import { rejectMessage } from '../labels.js';
import { request } from '../desktop-api.js';
import { displayHandoffView } from './display-handoff-state.js';

const shown = (
  target: 'this_device' | 'other_device' | null,
  options: {
    readonly hub?: 'connected' | 'unreachable' | 'not_connected';
    readonly permitted?: boolean;
  } = {},
): DesktopStatusBar => {
  const hub = options.hub ?? 'connected';
  const permitted = options.permitted ?? true;
  return {
    visibility: 'shown',
    lock_state: 'unlocked',
    stop_scope: permitted ? 'none' : 'local',
    input_permitted: permitted,
    io_epoch: '2',
    voice_state: null,
    hub_connection: hub,
    hub_last_confirmed_at:
      hub === 'not_connected' ? null : '2030-11-04T09:00:00Z',
    display_target: hub === 'connected' ? target : null,
    storage_mode: null,
    budget_held: null,
    safety_stopped: null,
  };
};

test('the button is offered only when another device or an unknown device shows, the hub is connected and input is permitted', () => {
  const other = displayHandoffView(shown('other_device'));
  assert.deepEqual(
    other.kind === 'shown' && [other.canHandoff, other.stoppedNote],
    [true, false],
  );
  const unknown = displayHandoffView(shown(null));
  assert.deepEqual(
    unknown.kind === 'shown' && [unknown.canHandoff, unknown.stoppedNote],
    [true, false],
  );
  // この端末が表示先なら押す必要がない。
  const here = displayHandoffView(shown('this_device'));
  assert.deepEqual(
    here.kind === 'shown' && [here.canHandoff, here.stoppedNote],
    [false, false],
  );
  // 入出力を止めている間は押せない（中枢も断る）。理由の 1 文を出す。
  const stopped = displayHandoffView(
    shown('other_device', { permitted: false }),
  );
  assert.deepEqual(
    stopped.kind === 'shown' && [stopped.canHandoff, stopped.stoppedNote],
    [false, true],
  );
});

test('the field is hidden while locked, unknown, before the first state, or when the hub is not connected', () => {
  assert.deepEqual(displayHandoffView(null), { kind: 'hidden' });
  assert.deepEqual(
    displayHandoffView({ visibility: 'hidden', lock_state: 'locked' }),
    { kind: 'hidden' },
  );
  assert.deepEqual(
    displayHandoffView({ visibility: 'hidden', lock_state: 'unknown' }),
    { kind: 'hidden' },
  );
  for (const hub of ['unreachable', 'not_connected'] as const)
    assert.deepEqual(displayHandoffView(shown('other_device', { hub })), {
      kind: 'hidden',
    });
});

test('the request carries nothing and the refusals say what to check', () => {
  const built = request('desktop.display_handoff', null);
  assert.equal(built.channel, 'desktop.display_handoff');
  assert.equal(built.payload, null);
  assert.equal(
    rejectMessage('desktop.display_handoff', 'core_rejected'),
    '表示先を移せませんでした。他の端末が先に移したか、この端末の入出力が止まっているなど、中枢が受け付けませんでした。「表示先」の表示を確かめてから、もう一度押してください。',
  );
  assert.equal(
    rejectMessage('desktop.display_handoff', 'outcome_unknown'),
    '表示先が移ったか確かめられませんでした。自動では送り直しません。「表示先」の表示を確かめてから、必要ならもう一度押してください。',
  );
  // 画面操作でない・ロック中は、ほかの操作と同じ文言。
  assert.equal(
    rejectMessage('desktop.display_handoff', 'device_locked'),
    rejectMessage('desktop.io_stop', 'device_locked'),
  );
});
