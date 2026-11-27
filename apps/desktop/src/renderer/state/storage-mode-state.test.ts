// 保存モードの切り替えの欄・記録しない間の印・区切りの知らせを決める純粋な関数の試験（UI-05 の段階 6、ADR 0189）。
// 期待値の文言・記号・並びは手で書いた。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopStatusBar, StorageMode } from '@buddy/contracts';
import { rejectMessage } from '../labels.js';
import { deviceActions } from './desktop-state.js';
import {
  applyStorageBoundary,
  applyTurnResponse,
  INITIAL_WORK_STATE,
} from './work-state.js';
import { storageNoticeText, submitResult } from './input-bar-state.js';
import {
  privateModeOn,
  storageBoundary,
  storageModeControlView,
  storageModeLine,
  storageModeOf,
} from './storage-mode-state.js';

const shown = (
  storage: StorageMode | null,
  hub: 'connected' | 'unreachable' | 'not_connected' = 'connected',
): DesktopStatusBar => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '2',
  voice_state: null,
  hub_connection: hub,
  hub_last_confirmed_at:
    hub === 'not_connected' ? null : '2030-11-04T09:00:00Z',
  display_target: null,
  storage_mode: hub === 'connected' ? storage : null,
  budget_held: null,
  safety_stopped: null,
});

test('the private mark is on only while the hub says private', () => {
  assert.equal(privateModeOn(shown('private')), true);
  assert.equal(privateModeOn(shown('normal')), false);
  assert.equal(privateModeOn(shown('extended')), false);
  assert.equal(privateModeOn(shown(null)), false);
  assert.equal(privateModeOn(null), false);
  assert.equal(
    privateModeOn({ visibility: 'hidden', lock_state: 'locked' }),
    false,
  );
  assert.equal(storageModeOf(shown('extended')), 'extended');
  assert.equal(
    storageModeOf({ visibility: 'hidden', lock_state: 'unknown' }),
    null,
  );
});

test('the control lists normal, extended and private in a fixed order and selects only the hub value', () => {
  assert.deepEqual(storageModeControlView(shown('normal')), {
    kind: 'shown',
    options: [
      { mode: 'normal', label: '通常（7\u00a0日）', selected: true },
      { mode: 'extended', label: '継続相談（30\u00a0日）', selected: false },
      { mode: 'private', label: '記録しない', selected: false },
    ],
    unknown: false,
    line: { tone: 'neutral', mark: 'dot', text: '通常（7\u00a0日）' },
  });
  const unknown = storageModeControlView(shown(null));
  assert.equal(unknown.kind, 'shown');
  assert.equal(unknown.kind === 'shown' && unknown.unknown, true);
  assert.deepEqual(
    unknown.kind === 'shown'
      ? unknown.options.map((option) => option.selected)
      : null,
    [false, false, false],
  );
  // 出さない: 受け取る前・ロック中・不明・中枢に接続していない。
  for (const status of [
    null,
    { visibility: 'hidden', lock_state: 'locked' } as const,
    { visibility: 'hidden', lock_state: 'unknown' } as const,
    shown(null, 'unreachable'),
    shown(null, 'not_connected'),
  ])
    assert.deepEqual(storageModeControlView(status), { kind: 'hidden' });
});

test('the current value line uses a square for private, a dot otherwise, and words when unknown', () => {
  assert.deepEqual(storageModeLine('private'), {
    tone: 'neutral',
    mark: 'square',
    text: '記録しない',
  });
  assert.deepEqual(storageModeLine('extended'), {
    tone: 'neutral',
    mark: 'dot',
    text: '継続相談（30\u00a0日）',
  });
  assert.deepEqual(storageModeLine(null), {
    tone: 'neutral',
    mark: 'none',
    text: '今の保存モードを中枢から受け取っていません。',
  });
});

test('boundaries: private started, private ended, the mode changed, and nothing without both values', () => {
  assert.deepEqual(storageBoundary('normal', 'private'), {
    from: 'normal',
    to: 'private',
    line: {
      tone: 'neutral',
      mark: 'square',
      text: 'ここから記録しない会話です。',
    },
  });
  assert.deepEqual(storageBoundary('private', 'normal')?.line, {
    tone: 'neutral',
    mark: 'dot',
    text: '記録しない会話を終えました。ここから保存モードは「通常（7\u00a0日）」です。',
  });
  assert.deepEqual(storageBoundary('normal', 'extended')?.line, {
    tone: 'neutral',
    mark: 'dot',
    text: 'ここから保存モードは「継続相談（30\u00a0日）」です。',
  });
  assert.equal(storageBoundary('private', 'private'), null);
  assert.equal(storageBoundary(null, 'private'), null);
  assert.equal(storageBoundary('private', null), null);
});

test('the switch request carries only the chosen mode; refusals say what happened', () => {
  const sent: unknown[] = [];
  const actions = deviceActions(shown('normal'), (built) => sent.push(built));
  actions.changeStorageMode('private');
  assert.equal(sent.length, 1);
  const [built] = sent as {
    channel: string;
    request_id: string;
    payload: unknown;
  }[];
  assert.equal(built?.channel, 'desktop.storage_mode_change');
  assert.deepEqual(built?.payload, { storage_mode: 'private' });
  assert.match(
    rejectMessage('desktop.storage_mode_change', 'core_rejected'),
    /^保存モードを切り替えられませんでした。中枢が受け付けなかったため、保存モードは変わっていません。/u,
  );
  assert.match(
    rejectMessage('desktop.storage_mode_change', 'outcome_unknown'),
    /^保存モードが切り替わったか確かめられませんでした。自動では送り直しません。/u,
  );
  // 前面でない・ロック中は共通の文言。
  assert.equal(
    rejectMessage('desktop.storage_mode_change', 'screen_operation_required'),
    'このウィンドウを一度クリックして前面にしてから、もう一度押してください。',
  );
});

test('a boundary line is added to the legacy conversation without touching the draft', () => {
  const state = {
    ...INITIAL_WORK_STATE,
    draft: '書きかけ',
    nextId: 5,
  };
  const next = applyStorageBoundary(state, {
    text: 'ここから記録しない会話です。',
    mark: 'square',
  });
  assert.deepEqual(next.messages, [
    {
      id: 5,
      role: 'boundary',
      text: 'ここから記録しない会話です。',
      clarification: false,
      mark: 'square',
    },
  ]);
  assert.equal(next.nextId, 6);
  assert.equal(next.draft, '書きかけ');
  assert.equal(next.sending, false);
});

// U477 の直し: 記録しないと表示していたのに記録された発言は、その旨を 1 文で出す（従来の窓は入力欄の下、キャンバス表示は
// 入力バー）。発言そのものは受け付けられているので、入力欄は空にする。
test('a turn recorded while private was shown is reported in one sentence', () => {
  const recorded = {
    request_id: '00000000-0000-4000-8000-000000000f81',
    channel: 'desktop.turn_submit' as const,
    outcome: 'ok' as const,
    turn: {
      status: 'answered' as const,
      reply_text: '受け付けました。',
      result: null,
      storage_notice: 'recorded_while_private_shown' as const,
    },
  };
  const sentence =
    '記録しないモードは送る前に終わっていたため、この発言は記録されました。';
  assert.equal(storageNoticeText(recorded), sentence);
  assert.equal(submitResult(recorded), 'sent');
  const plain = {
    ...recorded,
    turn: { status: 'answered' as const, reply_text: 'はい。', result: null },
  };
  assert.equal(storageNoticeText(plain), null);
  assert.equal(
    storageNoticeText({
      request_id: null,
      channel: 'desktop.turn_submit',
      outcome: 'rejected',
      reason: 'core_rejected',
    }),
    null,
  );
  // 従来の窓: 発言は履歴に入り、入力欄は空になり、入力欄の下に warning の 1 文。
  const state = {
    ...INITIAL_WORK_STATE,
    draft: '今日の予定は？',
    sending: true,
  };
  const after = applyTurnResponse(state, recorded);
  assert.equal(after.draft, '');
  assert.equal(after.messages.length, 2);
  assert.deepEqual(after.turnNotice, { tone: 'warning', text: sentence });
  assert.equal(applyTurnResponse(state, plain).turnNotice, null);
});
