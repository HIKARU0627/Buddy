// 状態帯・停止の帯の行の試験（ADR 0024 の対応表・ADR 0025）。期待値の文言・色・記号は手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopConnectionView } from '@buddy/contracts';
import { hubScreenMode, nextHubSeen } from './connection-state.js';
import type { ShownStatus } from './desktop-state.js';
import {
  detailItems,
  hubLine,
  ioLine,
  stopReasonText,
} from './status-lines.js';

const NOW = new Date(2026, 9, 21, 10, 0, 0).getTime();
const at = (h: number, m: number, s: number) =>
  new Date(2026, 9, 21, h, m, s).toISOString();

const status = (extra: Partial<ShownStatus> = {}): ShownStatus => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '1',
  voice_state: null,
  hub_connection: 'not_connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
  ...extra,
});

type Shown = Extract<DesktopConnectionView, { visibility: 'shown' }>;
const connection = (extra: Partial<Shown> = {}): Shown => ({
  visibility: 'shown',
  registration: 'registered',
  link: 'connected',
  link_reason: null,
  last_confirmed_at: null,
  retry_at: null,
  pairing: null,
  hub_screen: false,
  hub_target: null,
  home_network: null,
  operations: [],
  budget_items: [],
  ...extra,
});

test('the io line: accepting is success, own stop is neutral, guest and global need attention', () => {
  assert.deepEqual(ioLine(status()), {
    tone: 'success',
    mark: 'dot',
    text: '受付中',
  });
  assert.deepEqual(ioLine(status({ stop_scope: 'local' })), {
    tone: 'neutral',
    mark: 'square',
    text: '停止中',
  });
  assert.deepEqual(ioLine(status({ stop_scope: 'guest' })), {
    tone: 'warning',
    mark: 'square',
    text: '停止中（来客モード）',
  });
  assert.deepEqual(ioLine(status({ stop_scope: 'global' })), {
    tone: 'warning',
    mark: 'square',
    text: '全体停止中',
  });
});

test('the hub line follows the registration first, then the link', () => {
  const s = status();
  assert.deepEqual(
    hubLine(s, connection({ registration: 'unregistered' }), NOW),
    {
      tone: 'neutral',
      mark: 'none',
      text: '未登録',
    },
  );
  assert.deepEqual(
    hubLine(s, connection({ registration: 'reregistration_required' }), NOW),
    { tone: 'warning', mark: 'warning', text: '再登録が必要です' },
  );
  assert.deepEqual(
    hubLine(s, connection({ registration: 'secure_storage_unavailable' }), NOW),
    { tone: 'danger', mark: 'warning', text: '登録できません' },
  );
  assert.deepEqual(
    hubLine(s, connection({ last_confirmed_at: at(9, 59, 30) }), NOW),
    { tone: 'success', mark: 'dot', text: '接続中（09:59:30 確認）' },
  );
  assert.deepEqual(hubLine(s, connection({ link: 'connecting' }), NOW), {
    tone: 'neutral',
    mark: 'spinner',
    text: '接続しています',
  });
  assert.deepEqual(
    hubLine(
      s,
      connection({ link: 'waiting_retry', retry_at: at(10, 0, 8) }),
      NOW,
    ),
    {
      tone: 'warning',
      mark: 'circle',
      text: '接続し直しを待っています。次は 10:00:08（8\u00a0秒後）',
    },
  );
  assert.deepEqual(hubLine(s, connection({ link: 'upgrade_required' }), NOW), {
    tone: 'danger',
    mark: 'warning',
    text: '中枢の版が違うため使えません',
  });
  assert.deepEqual(hubLine(s, connection({ link: 'not_connected' }), NOW), {
    tone: 'neutral',
    mark: 'none',
    text: '未接続',
  });
});

test('without the connection view, the hub line uses the status bar values', () => {
  assert.deepEqual(hubLine(status(), null, NOW), {
    tone: 'neutral',
    mark: 'none',
    text: '未接続',
  });
  assert.deepEqual(
    hubLine(
      status({ hub_connection: 'unreachable' }),
      { visibility: 'hidden', lock_state: 'locked' },
      NOW,
    ),
    { tone: 'warning', mark: 'circle', text: '接続できません' },
  );
  assert.deepEqual(
    hubLine(
      status({
        hub_connection: 'connected',
        hub_last_confirmed_at: at(9, 0, 0),
      }),
      null,
      NOW,
    ),
    { tone: 'success', mark: 'dot', text: '接続中（09:00:00 確認）' },
  );
});

test('the five always-visible items are kept and missing values are dashes', () => {
  assert.deepEqual(detailItems(status()), [
    { label: '表示先', value: '—', missing: true },
    { label: '音声', value: '—', missing: true },
    { label: '保存モード', value: '—', missing: true },
    { label: '予算保留', value: '—', missing: true },
    { label: '安全停止', value: '—', missing: true },
  ]);
  assert.deepEqual(
    detailItems(
      status({
        display_target: 'other_device',
        voice_state: 'conversation_live',
        storage_mode: 'extended',
        budget_held: true,
        safety_stopped: false,
      }),
    ),
    [
      { label: '表示先', value: '他の端末', missing: false },
      { label: '音声', value: '会話中', missing: false },
      { label: '保存モード', value: '継続相談（30\u00a0日）', missing: false },
      { label: '予算保留', value: '保留あり', missing: false },
      { label: '安全停止', value: 'なし', missing: false },
    ],
  );
});

test('the stop reason names the cause and time, or that the hub must lift it', () => {
  const local = status({ stop_scope: 'local' });
  assert.equal(stopReasonText(local, null, NOW), null);
  assert.equal(
    stopReasonText(local, { kind: 'button', at: at(9, 58, 0) }, NOW),
    '09:58:00 に停止ボタンで止めました。',
  );
  assert.equal(
    stopReasonText(
      local,
      { kind: 'power', event: 'suspend', at: at(9, 0, 1) },
      NOW,
    ),
    '09:00:01 にスリープで止まりました。',
  );
  assert.equal(
    stopReasonText(status({ stop_scope: 'guest' }), null, NOW),
    '来客モードのため止まっています。解除は中枢で行います。',
  );
  assert.equal(
    stopReasonText(
      status({ stop_scope: 'global' }),
      { kind: 'button', at: at(9, 0, 0) },
      NOW,
    ),
    '全体停止のため止まっています。解除は中枢で行います。',
  );
});

test('the hub screen frame stays while waiting for the hub, only for a registered device that was confirmed before', () => {
  const live = connection({ hub_screen: true });
  const waiting = connection({ link: 'waiting_retry', hub_screen: false });
  assert.equal(nextHubSeen(false, live), true);
  assert.equal(hubScreenMode(true, live), 'live');
  // 接続が切れても、前に確かめていれば枠を残す（操作は止める）。
  assert.equal(nextHubSeen(true, waiting), true);
  assert.equal(hubScreenMode(true, waiting), 'paused');
  // 一度も確かめていない端末には出さない。
  assert.equal(hubScreenMode(false, waiting), 'off');
  // ロック中など接続の状態が隠れているときは前のまま。
  assert.equal(nextHubSeen(true, null), true);
  // 登録が外れたら（再登録が必要など）捨てる。
  assert.equal(
    nextHubSeen(true, connection({ registration: 'reregistration_required' })),
    false,
  );
});
