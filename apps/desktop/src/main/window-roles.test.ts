// 窓の役割の基盤（UI-02、ADR 0032）。送信元の窓の役割で受付を絞ること・通知の宛先・従来の窓が変わらないこと・
// 役割ごとの窓の作り方。期待値は手で書き、実装から生成しない。Electron は起動しない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC_CHANNELS, admitDesktopRequest } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopDeviceController } from './device-controller.js';
import {
  FLOAT_SHADOW,
  INPUT_BAR_COLLAPSE_DELAY_MS,
  INPUT_BAR_EXPANDED_SIZE,
  INPUT_BAR_SIZE,
  ISLAND_EXPANDED_SIZE,
  ISLAND_MARGIN,
  ISLAND_SIZE,
  UiWindowRegistry,
  channelAllowedForWindow,
  inputBarBounds,
  islandBounds,
  islandExpandedFor,
  titleBarOverlayFor,
  notificationAllowedForWindow,
  rolesForMode,
  senderFactsOf,
  uiWindowMode,
  uiWindowSpec,
  windowSender,
  type UiWindowRole,
} from './window-roles.js';

// UI-02 より前からある 24 チャネル（B01〜B04-05）。従来の窓はこれをすべて使う。
const LEGACY_CHANNELS = [
  'desktop.get_state',
  'desktop.io_stop',
  'desktop.io_resume',
  'desktop.window_hide',
  'desktop.client_quit',
  'desktop.get_connection',
  'desktop.pairing_begin',
  'desktop.pairing_confirm',
  'desktop.pairing_submit',
  'desktop.pairing_cancel',
  'desktop.claims_list',
  'desktop.claim_decide',
  'desktop.devices_list',
  'desktop.device_revoke',
  'desktop.pairing_open',
  'desktop.home_status',
  'desktop.home_register',
  'desktop.turn_submit',
  'desktop.operation_preview',
  'desktop.operation_approve',
  'desktop.operation_cancel',
  'desktop.operation_reconcile',
  'desktop.operation_retry',
  'desktop.operation_check',
];
// UI-02 で足した、キャンバスを前に出すチャネル（状態の層と入力バーだけ。従来の窓は使わない）。
const SUMMON = 'desktop.canvas_summon';
// UI-04 で足した、状態の層のパネルを出す・しまうチャネル（状態の層だけ。従来の窓は使わない）。
const PANEL = 'desktop.status_panel';
// UI-06 で足した、キャンバスの物のユーザーの操作のチャネル（キャンバスの窓だけ。従来の窓は使わない）。
const USER_OP = 'desktop.canvas_user_op';
// B07-05 で足した、予算の確認のチャネル（状態の層だけ。従来の窓は使わない）。
const BUDGET = [
  'desktop.budget_overage_decide',
  'desktop.budget_overrun_review',
  'desktop.budget_manual_settle',
];
// UI-07 で足した、キャンバスの物の中身（本文）を求めるチャネル（キャンバスの窓だけ。従来の窓は使わない）。
const CONTENT = 'desktop.canvas_content';
// B05-06 で足した、音声の状態・最小の「続ける」・同意の取り消しのチャネル（状態の層だけ。従来の窓は使わない）。
const VOICE = [
  'desktop.get_voice',
  'desktop.voice_continue',
  'desktop.voice_consent_revoke',
  'desktop.voice_control',
];
// B11-05 で足した、気づきの一覧・状態の変更のチャネル（従来の窓と状態の層。キャンバス・入力バーは使わない。ADR 0132）。
// 気づきの OS 通知の入・切の変更（ADR 0196）と根拠を見る（ADR 0201）も同じ窓。
const CANDIDATES = [
  'desktop.candidates_list',
  'desktop.candidate_state',
  'desktop.candidate_alert_setting',
  'desktop.candidate_evidence',
];
// B08-02 P3・B09-05 で足した、連携の接続の一覧・取得範囲の変更のチャネル（従来の窓の中枢の画面と状態の層。
// キャンバス・入力バーは使わない。ADR 0142）。
const CONNECTIONS = [
  'desktop.connections_list',
  'desktop.connection_targets_update',
  // 選べる取得対象の読み取り（ADR 0145）。
  'desktop.connection_targets_discover',
];
// B13-05 で足した、自動実行の一覧・取り消し・安全停止の解除のチャネル（従来の窓と状態の層。キャンバス・入力バーは
// 使わない。ADR 0154）。
const AUTO_ACTIONS = [
  'desktop.auto_actions_list',
  'desktop.auto_action_undo',
  'desktop.safety_resume',
  // 家計簿の月ごとの合計と記録・分類の変更・削除（ADR 0162）。
  'desktop.household_view',
  'desktop.household_category',
  'desktop.household_delete',
  'desktop.household_intake',
  'desktop.household_import',
  'desktop.household_budget',
  'desktop.household_add',
  'desktop.household_edit',
  'desktop.household_export',
  'desktop.household_receipt_setting',
  'desktop.household_receipt_read',
  // 請求予定を消す（ADR 0179）。
  'desktop.household_bill_delete',
  // 忘却の画面の記憶の一覧・計画・実行（UI-10、ADR 0183。従来の窓と状態の層。キャンバス・入力バー・島は使わない）。
  'desktop.memories_list',
  'desktop.forget_plan',
  'desktop.forget_execute',
  // 保存してよい記憶の種類の設定の変更（ADR 0191。従来の窓と状態の層）。
  'desktop.memory_settings_change',
  // 保存モードの切り替え（UI-05 の段階 6、ADR 0189。従来の窓と状態の層。キャンバス・入力バー・島は使わない）。
  'desktop.storage_mode_change',
  // 流れの表示先の移動（UI-05 の段階 5、ADR 0193。状態の層のパネルから。キャンバス・入力バー・島は使わない）。
  'desktop.display_handoff',
  // 記録しない会話の独立した確認の承認・断る（ADR 0197。従来の窓と状態の層。キャンバス・入力バー・島には渡さない）。
  'desktop.private_confirmation_decide',
];
const ALL_CHANNELS = [
  ...LEGACY_CHANNELS,
  SUMMON,
  PANEL,
  USER_OP,
  CONTENT,
  ...BUDGET,
  ...VOICE,
  ...CANDIDATES,
  ...CONNECTIONS,
  ...AUTO_ACTIONS,
];

const UNLOCKED = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
} as const;

const APP_URL = 'buddy://app/index.html';

interface FakeWindow {
  readonly name: string;
  // 窓の今の主フレーム（processId・routingId）。null は破棄した窓。
  readonly mainFrame?: {
    readonly processId: number;
    readonly routingId: number;
  } | null;
}

// 窓の webContents の ID から決めた主フレーム（processId = ID × 10、routingId = 1）。
const mainFrameOf = (id: number) => ({ processId: id * 10, routingId: 1 });

// その窓の主フレームから送った要求のフレーム。
const frameOf = (id: number) => ({
  parent: null,
  ...mainFrameOf(id),
  url: APP_URL,
});

// main の受付と同じ組み立て: 対応表で送信元の窓を引き、実際の senderFactsOf で送信元の事実を作り、役割から送信元を作る。
function senderFor(
  registry: UiWindowRegistry<FakeWindow>,
  webContentsId: number,
  channel: string,
  options: {
    readonly focused?: boolean;
    readonly frame?:
      | ReturnType<typeof frameOf>
      | {
          readonly parent: unknown;
          readonly processId: number;
          readonly routingId: number;
          readonly url: string;
        }
      | null;
  } = {},
) {
  const entry = registry.lookup(webContentsId);
  const mainFrame =
    entry === null
      ? null
      : entry.window.mainFrame === undefined
        ? mainFrameOf(entry.webContentsId)
        : entry.window.mainFrame;
  return windowSender({
    channel,
    role: entry?.role ?? null,
    facts: senderFactsOf(
      webContentsId,
      options.frame === undefined ? frameOf(webContentsId) : options.frame,
      entry === null || mainFrame === null
        ? null
        : { webContentsId: entry.webContentsId, mainFrame },
    ),
    focused: options.focused ?? true,
  });
}

function threeWindows() {
  const registry = new UiWindowRegistry<FakeWindow>();
  registry.register(11, 'canvas', { name: 'canvas' });
  registry.register(12, 'status', { name: 'status' });
  registry.register(13, 'input', { name: 'input' });
  return registry;
}

const DEV = { packaged: false } as const;
const PACKAGED = { packaged: true } as const;

test('the default stays the single legacy window; the flag or env opens the three windows in a dev launch', () => {
  assert.equal(uiWindowMode([], {}, DEV), 'legacy');
  assert.equal(uiWindowMode(['electron', '.'], {}, DEV), 'legacy');
  assert.equal(
    uiWindowMode(['electron', '.', '--buddy-ui=canvas'], {}, DEV),
    'canvas',
  );
  assert.equal(uiWindowMode([], { BUDDY_DESKTOP_UI: 'canvas' }, DEV), 'canvas');
  // フラグが環境変数より優先。最後のフラグを使う。
  assert.equal(
    uiWindowMode(['--buddy-ui=legacy'], { BUDDY_DESKTOP_UI: 'canvas' }, DEV),
    'legacy',
  );
  assert.equal(
    uiWindowMode(['--buddy-ui=canvas', '--buddy-ui=legacy'], {}, DEV),
    'legacy',
  );
  // 知らない値は既定のまま。
  assert.equal(uiWindowMode(['--buddy-ui=CANVAS'], {}, DEV), 'legacy');
  assert.equal(uiWindowMode(['--buddy-ui='], {}, DEV), 'legacy');
  assert.equal(uiWindowMode([], { BUDDY_DESKTOP_UI: 'status' }, DEV), 'legacy');
  assert.deepEqual(rolesForMode('legacy'), ['legacy']);
  // キャンバスを先に作り、状態の層・入力バー・島（ADR 0181 の段階 4）を前に重ねる。
  assert.deepEqual(rolesForMode('canvas'), [
    'canvas',
    'status',
    'input',
    'island',
  ]);
});

test('a packaged launch ignores the dev flag and the env and always uses the legacy window', () => {
  for (const [argv, env] of [
    [['--buddy-ui=canvas'], {}],
    [[], { BUDDY_DESKTOP_UI: 'canvas' }],
    [['--buddy-ui=canvas'], { BUDDY_DESKTOP_UI: 'canvas' }],
    [[], {}],
  ] as const)
    assert.equal(uiWindowMode(argv, env, PACKAGED), 'legacy');
});

test('the legacy window keeps every existing channel and the same sender decision as before', () => {
  assert.deepEqual([...DESKTOP_IPC_CHANNELS], ALL_CHANNELS);
  const registry = new UiWindowRegistry<FakeWindow>();
  registry.register(7, 'legacy', { name: 'legacy' });
  // 気づきのチャネル（B11-05）は従来の窓（標準の端末画面）で使う。連携のチャネル（B08-02 P3・B09-05）も従来の窓の
  // 中枢の画面で使う。
  for (const channel of [
    ...LEGACY_CHANNELS,
    ...CANDIDATES,
    ...CONNECTIONS,
    ...AUTO_ACTIONS,
  ]) {
    assert.equal(channelAllowedForWindow('legacy', channel), true, channel);
    // 窓の主フレームからの要求は、前面かどうかをそのまま渡して受け付ける（期待値は手で書いた値）。
    for (const focused of [true, false])
      assert.deepEqual(senderFor(registry, 7, channel, { focused }), {
        trustedSender: true,
        windowFocused: focused,
      });
    // 子フレーム・別のページの URL・別の窓（対応表にない ID）からは受け付けない。
    assert.deepEqual(
      senderFor(registry, 7, channel, {
        frame: { ...frameOf(7), parent: {} },
      }),
      { trustedSender: false, windowFocused: true },
    );
    assert.deepEqual(
      senderFor(registry, 7, channel, {
        frame: { ...frameOf(7), url: 'https://example.com/' },
      }),
      { trustedSender: false, windowFocused: true },
    );
    assert.deepEqual(senderFor(registry, 8, channel), {
      trustedSender: false,
      windowFocused: true,
    });
  }
  // 従来の窓はキャンバスを前に出さない・状態の層のパネルを使わない・キャンバスの物を操作しない（従来の窓の組み立てには
  // どちらもない）。
  for (const channel of [SUMMON, PANEL, USER_OP, CONTENT, ...VOICE]) {
    assert.equal(channelAllowedForWindow('legacy', channel), false, channel);
    assert.deepEqual(
      admitDesktopRequest(
        channel,
        null,
        UNLOCKED,
        senderFor(registry, 7, channel),
      ),
      { ok: false, reason: 'untrusted_sender' },
      channel,
    );
  }
  assert.equal(channelAllowedForWindow('legacy', 'desktop.hub_stop'), false);
  for (const channel of [
    'desktop.state_changed',
    'desktop.power_event',
    'desktop.connection_changed',
  ])
    assert.equal(notificationAllowedForWindow('legacy', channel), true);
  // キャンバスの記述（UI-03）と作業領域の外の幅（UI-06）と音声の状態（B05-06）は従来の窓へ送らない。
  assert.equal(
    notificationAllowedForWindow('legacy', 'desktop.canvas_changed'),
    false,
  );
  assert.equal(
    notificationAllowedForWindow('legacy', 'desktop.voice_changed'),
    false,
  );
  assert.equal(
    notificationAllowedForWindow('legacy', 'desktop.canvas_work_area'),
    false,
  );
  // 作業領域の外の幅はキャンバスの窓だけ（状態の層・入力バーへは送らない）。
  assert.equal(
    notificationAllowedForWindow('canvas', 'desktop.canvas_work_area'),
    true,
  );
  for (const role of ['status', 'input'] as const)
    assert.equal(
      notificationAllowedForWindow(role, 'desktop.canvas_work_area'),
      false,
      role,
    );
});

// UI-03（ADR 0032）: キャンバスの記述の通知はキャンバスの窓だけ。読み込みが終わっていない窓へは送らない。
test('the canvas description notification goes to the canvas window only, and only once it is loaded', () => {
  const registry = new UiWindowRegistry<FakeWindow>();
  registry.register(11, 'canvas', { name: 'canvas' });
  registry.register(12, 'status', { name: 'status' });
  registry.register(13, 'input', { name: 'input' });
  assert.deepEqual(registry.notificationTargets('desktop.canvas_changed'), []);
  for (const id of [11, 12, 13]) registry.setReady(id, true);
  assert.deepEqual(
    registry
      .notificationTargets('desktop.canvas_changed')
      .map((entry) => entry.role),
    ['canvas'],
  );
  assert.equal(
    notificationAllowedForWindow('canvas', 'desktop.canvas_changed'),
    true,
  );
  for (const role of ['status', 'input'] as const)
    assert.equal(
      notificationAllowedForWindow(role, 'desktop.canvas_changed'),
      false,
      role,
    );
  // 電源・ロックの記録と接続の状態は、キャンバスの窓へ送らないまま。
  for (const channel of ['desktop.power_event', 'desktop.connection_changed'])
    assert.equal(
      notificationAllowedForWindow('canvas', channel),
      false,
      channel,
    );
  // 従来の窓だけの組み立てには、キャンバスの記述の宛先がない。
  const single = new UiWindowRegistry<FakeWindow>();
  single.register(7, 'legacy', { name: 'legacy' });
  single.setReady(7, true);
  assert.deepEqual(single.notificationTargets('desktop.canvas_changed'), []);
});

test('each role admits only its own channels; the rest are untrusted senders', () => {
  const registry = threeWindows();
  registry.register(14, 'island', { name: 'island' });
  const allowed: Record<Exclude<UiWindowRole, 'legacy'>, readonly string[]> = {
    canvas: ['desktop.get_state', USER_OP, CONTENT],
    input: ['desktop.get_state', 'desktop.turn_submit', SUMMON],
    status: ALL_CHANNELS.filter(
      (channel) =>
        channel !== 'desktop.turn_submit' &&
        channel !== USER_OP &&
        channel !== CONTENT,
    ),
    // 島（ADR 0181 の段階 4・U391 の暫定 (b)）: 状態の取得・停止・パネルを出すだけ。
    island: [
      'desktop.get_state',
      'desktop.get_connection',
      'desktop.get_voice',
      'desktop.io_stop',
      PANEL,
    ],
  };
  const ids = { canvas: 11, status: 12, input: 13, island: 14 } as const;
  for (const role of ['canvas', 'status', 'input', 'island'] as const)
    for (const channel of ALL_CHANNELS) {
      const expected = allowed[role].includes(channel);
      assert.equal(
        channelAllowedForWindow(role, channel),
        expected,
        `${role} ${channel}`,
      );
      const admission = admitDesktopRequest(
        channel,
        null,
        UNLOCKED,
        senderFor(registry, ids[role], channel),
      );
      if (!expected)
        assert.deepEqual(
          admission,
          { ok: false, reason: 'untrusted_sender' },
          `${role} ${channel}`,
        );
      else if (admission.ok === false)
        // 役割に合うチャネルは、役割の検査では拒否しない（ほかの規則の拒否だけ）。
        assert.notEqual(
          admission.reason,
          'untrusted_sender',
          `${role} ${channel}`,
        );
    }
  // 手で選んだ代表: キャンバスは承認・停止・再開・終了・接続の表示を使えない。
  for (const channel of [
    'desktop.operation_approve',
    'desktop.operation_cancel',
    'desktop.io_stop',
    'desktop.io_resume',
    'desktop.client_quit',
    'desktop.get_connection',
    'desktop.turn_submit',
  ])
    assert.equal(
      senderFor(registry, 11, channel).trustedSender,
      false,
      channel,
    );
  // キャンバスと入力バーは状態の層のパネルを出す・しまうことができない（AI が状態の層を隠す・動かすことを構造で防ぐ）。
  assert.equal(senderFor(registry, 11, PANEL).trustedSender, false);
  assert.equal(senderFor(registry, 13, PANEL).trustedSender, false);
  assert.equal(senderFor(registry, 12, PANEL).trustedSender, true);
  // キャンバスの物のユーザーの操作はキャンバスの窓だけ（状態の層・入力バーは物を動かせない。UI-06）。
  assert.equal(senderFor(registry, 11, USER_OP).trustedSender, true);
  assert.equal(senderFor(registry, 12, USER_OP).trustedSender, false);
  assert.equal(senderFor(registry, 13, USER_OP).trustedSender, false);
  // 物の中身（本文）もキャンバスの窓だけ（状態の層・入力バーへは本文を渡さない。UI-07）。
  assert.equal(senderFor(registry, 11, CONTENT).trustedSender, true);
  assert.equal(senderFor(registry, 12, CONTENT).trustedSender, false);
  assert.equal(senderFor(registry, 13, CONTENT).trustedSender, false);
  // キャンバスは自分を前に出せない。状態の層と入力バーは呼べる。
  assert.equal(senderFor(registry, 11, SUMMON).trustedSender, false);
  assert.equal(senderFor(registry, 12, SUMMON).trustedSender, true);
  assert.equal(senderFor(registry, 13, SUMMON).trustedSender, true);
  // 入力バーは発言だけ。状態の層は発言を使えない。
  assert.equal(
    senderFor(registry, 13, 'desktop.turn_submit').trustedSender,
    true,
  );
  assert.equal(
    senderFor(registry, 13, 'desktop.operation_approve').trustedSender,
    false,
  );
  assert.equal(
    senderFor(registry, 12, 'desktop.turn_submit').trustedSender,
    false,
  );
  assert.equal(
    senderFor(registry, 12, 'desktop.operation_approve').trustedSender,
    true,
  );
});

// ADR 0181 の段階 4（U391 の暫定 (b)）: 島は前面を奪わない窓（キー入力を受けない）なので、要求はいつも前面でない窓から届く。
// 状態の取得・停止・パネルを出すは前面でなくても受け付け、承認・取消・再開・登録・終了・発言・キャンバスを前に出すは
// 役割の検査で拒否する（島から確認を出さない）。期待値は手で書いた。
test('the island reaches only state reads, the stop and the panel, even without focus; everything else is an untrusted sender', () => {
  const registry = threeWindows();
  registry.register(14, 'island', { name: 'island' });
  const fromIsland = (channel: string) =>
    admitDesktopRequest(
      channel,
      null,
      UNLOCKED,
      senderFor(registry, 14, channel, { focused: false }),
    );
  for (const channel of [
    'desktop.get_state',
    'desktop.get_connection',
    'desktop.get_voice',
    'desktop.io_stop',
    'desktop.status_panel',
  ])
    assert.deepEqual(fromIsland(channel), { ok: true }, channel);
  for (const channel of [
    'desktop.operation_preview',
    'desktop.operation_approve',
    'desktop.operation_cancel',
    'desktop.operation_retry',
    'desktop.operation_reconcile',
    'desktop.operation_check',
    'desktop.io_resume',
    'desktop.turn_submit',
    'desktop.canvas_summon',
    'desktop.canvas_user_op',
    'desktop.canvas_content',
    'desktop.claim_decide',
    'desktop.device_revoke',
    'desktop.home_register',
    'desktop.pairing_begin',
    'desktop.window_hide',
    'desktop.client_quit',
    'desktop.voice_continue',
    'desktop.voice_consent_revoke',
    'desktop.budget_overage_decide',
    'desktop.auto_action_undo',
    'desktop.safety_resume',
    'desktop.household_delete',
  ])
    assert.deepEqual(
      fromIsland(channel),
      { ok: false, reason: 'untrusted_sender' },
      channel,
    );
  // 通知: 状態欄・接続の状態（確認が必要な操作の数と結果）・音声の状態（外部へ送っている印）だけ。
  for (const [channel, expected] of [
    ['desktop.state_changed', true],
    ['desktop.connection_changed', true],
    ['desktop.voice_changed', true],
    ['desktop.power_event', false],
    ['desktop.canvas_changed', false],
    ['desktop.canvas_work_area', false],
  ] as const)
    assert.equal(
      notificationAllowedForWindow('island', channel),
      expected,
      channel,
    );
  // 停止は 1 回で効く（確認を挟まない）。パネルを出す要求は main がパネルを出す効果になる。
  const controller = new DesktopDeviceController({
    contract: createDesktopContract(loadContractSchema()),
    initial: { io_epoch: '0', stop_scope: 'none' },
    now: () => new Date('2026-11-27T00:00:00.000Z'),
    persist: () => undefined,
    onNotification: () => undefined,
    onPersistError: () => undefined,
  });
  controller.applyLockQuery('unlock_screen');
  const requestOf = (channel: string, payload: unknown) => ({
    channel,
    request_id: '5d0e3c1a-7b2f-4a6e-8c9d-0e1f2a3b4c5d',
    payload,
  });
  const stop = controller.handleIpc(
    'desktop.io_stop',
    requestOf('desktop.io_stop', null),
    senderFor(registry, 14, 'desktop.io_stop', { focused: false }),
  );
  assert.equal(stop.response.outcome, 'ok');
  assert.equal(controller.state.stopScope, 'local');
  const panel = controller.handleIpc(
    'desktop.status_panel',
    requestOf('desktop.status_panel', { open: true }),
    senderFor(registry, 14, 'desktop.status_panel', { focused: false }),
  );
  assert.equal(panel.response.outcome, 'ok');
  assert.equal(panel.effect, 'status_panel_open');
  // 島から再開はできない（再開はパネルから。止まった後の島は停止を出さず、再開も出さない）。
  const resume = controller.handleIpc(
    'desktop.io_resume',
    requestOf('desktop.io_resume', { expected_io_epoch: '1' }),
    senderFor(registry, 14, 'desktop.io_resume', { focused: true }),
  );
  assert.equal(resume.response.outcome, 'rejected');
  assert.equal(controller.state.stopScope, 'local');
});

test('a request from an unknown window or a closed window is rejected', () => {
  const registry = threeWindows();
  // 対応表にない webContents（main の作っていない窓）。
  assert.equal(registry.lookup(99), null);
  assert.equal(channelAllowedForWindow(null, 'desktop.get_state'), false);
  for (const channel of ALL_CHANNELS)
    assert.deepEqual(
      admitDesktopRequest(
        channel,
        null,
        UNLOCKED,
        senderFor(registry, 99, channel),
      ),
      { ok: false, reason: 'untrusted_sender' },
    );
  // 対応表にあっても、送信元の事実が別の窓（ID の食い違い）なら拒否。
  assert.equal(
    windowSender({
      channel: 'desktop.get_state',
      role: 'status',
      facts: senderFactsOf(12, frameOf(12), {
        webContentsId: 11,
        mainFrame: mainFrameOf(12),
      }),
      focused: true,
    }).trustedSender,
    false,
  );
  // 閉じた窓は対応表から外れ、その ID からの要求は拒否する。
  assert.equal(senderFor(registry, 12, 'desktop.io_stop').trustedSender, true);
  registry.unregister(12);
  assert.equal(registry.lookup(12), null);
  assert.deepEqual(
    admitDesktopRequest(
      'desktop.io_stop',
      null,
      UNLOCKED,
      senderFor(registry, 12, 'desktop.io_stop'),
    ),
    { ok: false, reason: 'untrusted_sender' },
  );
  // ほかの窓はそのまま。
  assert.equal(
    senderFor(registry, 11, 'desktop.get_state').trustedSender,
    true,
  );
  // 同じ役割を作り直せば、新しい窓の ID だけを受け付ける（古い ID は拒否のまま）。
  registry.register(21, 'status', { name: 'status again' });
  assert.equal(senderFor(registry, 21, 'desktop.io_stop').trustedSender, true);
  assert.equal(senderFor(registry, 12, 'desktop.io_stop').trustedSender, false);
});

test('the controller rejects a stop from the canvas and keeps the state', () => {
  const registry = threeWindows();
  const controller = new DesktopDeviceController({
    contract: createDesktopContract(loadContractSchema()),
    initial: { io_epoch: '0', stop_scope: 'none' },
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    persist: () => undefined,
    onNotification: () => undefined,
    onPersistError: () => undefined,
  });
  controller.applyLockQuery('unlock_screen');
  const request = {
    channel: 'desktop.io_stop',
    request_id: '5d0e3c1a-7b2f-4a6e-8c9d-0e1f2a3b4c5d',
    payload: null,
  };
  const fromCanvas = controller.handleIpc(
    'desktop.io_stop',
    request,
    senderFor(registry, 11, 'desktop.io_stop'),
  );
  assert.deepEqual(fromCanvas.response, {
    request_id: request.request_id,
    channel: 'desktop.io_stop',
    outcome: 'rejected',
    reason: 'untrusted_sender',
  });
  assert.equal(controller.state.stopScope, 'none');
  const fromStatus = controller.handleIpc(
    'desktop.io_stop',
    request,
    senderFor(registry, 12, 'desktop.io_stop'),
  );
  assert.equal(fromStatus.response.outcome, 'ok');
  assert.equal(controller.state.stopScope, 'local');
});

test('notifications go only to loaded windows whose role takes them', () => {
  const registry = threeWindows();
  const names = (channel: string) =>
    registry.notificationTargets(channel).map((entry) => entry.window.name);
  // 読み込みが終わるまでは送らない。
  assert.deepEqual(names('desktop.state_changed'), []);
  registry.setReady(11, true);
  registry.setReady(12, true);
  registry.setReady(13, true);
  assert.deepEqual(names('desktop.state_changed'), [
    'canvas',
    'status',
    'input',
  ]);
  assert.deepEqual(names('desktop.power_event'), ['status']);
  assert.deepEqual(names('desktop.connection_changed'), ['status']);
  assert.deepEqual(names('desktop.unknown'), []);
  registry.setReady(12, false);
  assert.deepEqual(names('desktop.connection_changed'), []);
  registry.unregister(13);
  assert.deepEqual(names('desktop.state_changed'), ['canvas']);
  // 従来の窓は 3 種とも受ける。
  const legacy = new UiWindowRegistry<FakeWindow>();
  legacy.register(1, 'legacy', { name: 'legacy' });
  legacy.setReady(1, true);
  for (const channel of [
    'desktop.state_changed',
    'desktop.power_event',
    'desktop.connection_changed',
  ])
    assert.deepEqual(
      legacy.notificationTargets(channel).map((entry) => entry.window.name),
      ['legacy'],
    );
});

test('a webContents or a role is registered only once', () => {
  const registry = threeWindows();
  assert.throws(
    () => registry.register(11, 'legacy', { name: 'x' }),
    /window_already_registered/u,
  );
  assert.throws(
    () => registry.register(30, 'canvas', { name: 'x' }),
    /window_role_taken/u,
  );
  assert.equal(registry.byRole('canvas')?.webContentsId, 11);
  assert.equal(registry.byRole('legacy'), null);
});

const DISPLAY = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 33, width: 1512, height: 875 },
};
const PRELOAD = '/app/dist/preload/preload.cjs';

const SHARED_PREFS = {
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: false,
};

test('the legacy window hides the title bar on macOS and Windows and keeps the OS frame elsewhere', () => {
  // タイトルバーの指定（ADR 0204）。手で書いた期待値。
  const titleBar: Record<string, object> = {
    darwin: { titleBarStyle: 'hiddenInset', titleBarOverlay: true },
    win32: {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#18181b',
        height: 48,
      },
    },
    linux: {},
  };
  assert.deepEqual(titleBarOverlayFor(true), {
    color: '#00000000',
    symbolColor: '#f5f5f5',
    height: 48,
  });
  for (const platform of ['darwin', 'win32', 'linux'])
    assert.deepEqual(uiWindowSpec('legacy', platform, DISPLAY, PRELOAD), {
      role: 'legacy',
      options: {
        width: 1040,
        height: 720,
        minWidth: 480,
        minHeight: 360,
        show: false,
        title: 'Buddy',
        autoHideMenuBar: true,
        ...titleBar[platform],
        webPreferences: {
          ...SHARED_PREFS,
          additionalArguments: ['--buddy-window-role=legacy'],
        },
      },
      contentProtection: false,
      allWorkspaces: null,
      alwaysOnTopLevel: null,
      maximize: false,
      focusOnShow: true,
      showOnStart: true,
    });
});

test('all windows share sandbox, isolation and the preload; only the role argument differs (and the island reports its size)', () => {
  for (const platform of ['darwin', 'win32'])
    for (const role of [
      'legacy',
      'canvas',
      'status',
      'input',
      'island',
    ] as const)
      assert.deepEqual(
        uiWindowSpec(role, platform, DISPLAY, PRELOAD).options.webPreferences,
        {
          ...SHARED_PREFS,
          additionalArguments: [`--buddy-window-role=${role}`],
          // 島だけ、中身の高さを main へ知らせる（2 つの決まった大きさのどちらかにするため。ADR 0181 の段階 4）。
          ...(role === 'island' ? { enablePreferredSizeMode: true } : {}),
        },
        `${platform} ${role}`,
      );
});

test('the macOS canvas sits on the desktop layer over the whole screen, on every space', () => {
  const spec = uiWindowSpec('canvas', 'darwin', DISPLAY, PRELOAD);
  assert.equal(spec.options.type, 'desktop');
  // 後ろにある間はキー入力を受けない（前に出すときだけ受ける。canvas-presence.ts）。
  assert.equal(spec.options.focusable, false);
  assert.equal(spec.options.frame, false);
  assert.deepEqual(
    [spec.options.x, spec.options.y, spec.options.width, spec.options.height],
    [0, 0, 1512, 982],
  );
  assert.equal(spec.contentProtection, true);
  assert.deepEqual(spec.allWorkspaces, { visibleOnFullScreen: false });
  assert.equal(spec.alwaysOnTopLevel, null);
  assert.equal(spec.maximize, false);
  // 前面を奪わない（ほかのアプリの後ろ）。
  assert.equal(spec.focusOnShow, false);
});

test('the Windows canvas is a frameless maximized window kept off the taskbar', () => {
  const spec = uiWindowSpec('canvas', 'win32', DISPLAY, PRELOAD);
  assert.equal(spec.options.type, undefined);
  // Windows でも、後ろにある間はフォーカスを受けない（クリックしても前面に来ず、キー入力を受けない）。
  assert.equal(spec.options.focusable, false);
  assert.equal(spec.options.frame, false);
  assert.equal(spec.options.skipTaskbar, true);
  assert.equal(spec.options.thickFrame, false);
  assert.deepEqual(
    [spec.options.x, spec.options.y, spec.options.width, spec.options.height],
    [0, 33, 1512, 875],
  );
  assert.equal(spec.maximize, true);
  assert.equal(spec.contentProtection, true);
  assert.equal(spec.allWorkspaces, null);
  assert.equal(spec.focusOnShow, false);
});

test('the status panel, the input bar and the island are small, frameless, always-on-top windows', () => {
  for (const platform of ['darwin', 'win32']) {
    const status = uiWindowSpec('status', platform, DISPLAY, PRELOAD);
    const input = uiWindowSpec('input', platform, DISPLAY, PRELOAD);
    const island = uiWindowSpec('island', platform, DISPLAY, PRELOAD);
    for (const spec of [status, input, island]) {
      assert.equal(
        spec.options.type,
        platform === 'darwin' ? 'panel' : undefined,
      );
      assert.equal(spec.options.frame, false);
      assert.equal(spec.options.resizable, false);
      assert.equal(spec.options.movable, false);
      assert.equal(spec.options.skipTaskbar, true);
      assert.equal(spec.options.alwaysOnTop, true);
      assert.equal(spec.alwaysOnTopLevel, 'floating');
      assert.deepEqual(spec.allWorkspaces, { visibleOnFullScreen: true });
    }
    // 状態の層は右の端の上から下までのパネル（440 × 作業領域の高さ）。端のつまみ（56 × 232）はやめ、窓は隠して作り、
    // パネルを出すときだけ表示する（ADR 0181 の段階 4・U392 の暫定 (a)）。
    assert.deepEqual(
      [
        status.options.x,
        status.options.y,
        status.options.width,
        status.options.height,
      ],
      [1512 - 440, 33, 440, 875],
    );
    assert.equal(status.showOnStart, false);
    assert.equal(input.showOnStart, true);
    assert.equal(island.showOnStart, true);
    // 上の中央の島（見える島は 560 × 48、上端から 8）。窓は影の余白を足した 592 × 72 で、作業領域の上端に付く（ADR 0204）。
    assert.deepEqual(
      [
        island.options.x,
        island.options.y,
        island.options.width,
        island.options.height,
      ],
      [Math.round((1512 - 592) / 2), 33, 592, 72],
    );
    // 島と入力バーは角の外を透かす透明な窓（U399 の暫定 (a)）。OS の影は付けない。状態の層のパネルは四角い窓のまま。
    for (const spec of [input, island]) {
      assert.equal(spec.options.transparent, true);
      assert.equal(spec.options.backgroundColor, '#00000000');
      assert.equal(spec.options.hasShadow, false);
    }
    assert.equal(status.options.transparent, undefined);
    // 島は前面を奪わず、キー入力も受けない（押してもパネル・入力バーを前面から外さない）。
    assert.equal(island.options.focusable, false);
    assert.equal(island.focusOnShow, false);
    assert.equal(island.contentProtection, true);
    // 下の中ほどの帯（見える入力バーは 560 × 56、下端から 16）。窓は影の余白を足した 592 × 88 で、作業領域の下端に付く。
    assert.deepEqual(
      [
        input.options.x,
        input.options.y,
        input.options.width,
        input.options.height,
      ],
      [Math.round((1512 - 592) / 2), 33 + 875 - 88, 592, 88],
    );
    // 画面共有から守るのはキャンバスと状態の層。入力バーはキー入力のために前面に出す。
    assert.equal(status.contentProtection, true);
    assert.equal(input.contentProtection, false);
    assert.equal(status.focusOnShow, false);
    assert.equal(input.focusOnShow, true);
  }
});

// ADR 0181 の段階 4: 島は上の端を固定して下へ広がり、横の位置は変えない。大きさは 2 つだけで、画面の中身の高さが
// 小さな島（48）より高いときだけ広げる。期待値は手で書いた。
test('the island grows downward from a fixed top edge; it takes only two sizes chosen from the content height', () => {
  assert.deepEqual(ISLAND_SIZE, { width: 560, height: 48 });
  assert.deepEqual(ISLAND_EXPANDED_SIZE, { width: 560, height: 104 });
  const compact = islandBounds(DISPLAY.workArea, false);
  const expanded = islandBounds(DISPLAY.workArea, true);
  // 窓は作業領域の上端（y: 33）に付け、「上の余白 8 ＋見える島＋影の余白 16」の高さ、左右に影の余白 16 ずつ（ADR 0204）。
  // 見える島の位置（x: 476・y: 41）は、余白を足す前と同じ。
  assert.deepEqual(FLOAT_SHADOW, { side: 16, below: 16, above: 16 });
  assert.deepEqual(compact, { x: 460, y: 33, width: 592, height: 72 });
  assert.deepEqual(expanded, { x: 460, y: 33, width: 592, height: 128 });
  assert.equal(compact.x + FLOAT_SHADOW.side, 476);
  assert.equal(compact.y + ISLAND_MARGIN, 41);
  // 狭い・低い作業領域では作業領域に合わせる（はみ出さない）。
  assert.deepEqual(
    islandBounds({ x: 10, y: 20, width: 320, height: 80 }, true),
    {
      x: 10,
      y: 20,
      width: 320,
      height: 80,
    },
  );
  // 中身の高さ: 72 までは小さな島、73 からは広げた島。数でない値は小さな島。
  assert.equal(islandExpandedFor(0), false);
  // 中身の高さは「上の余白 8 ＋見える島＋影の余白 16」。小さい形は 72。
  assert.equal(islandExpandedFor(48), false);
  assert.equal(islandExpandedFor(72), false);
  assert.equal(islandExpandedFor(73), true);
  assert.equal(islandExpandedFor(128), true);
  assert.equal(islandExpandedFor(400), true);
  assert.equal(islandExpandedFor(Number.NaN), false);
  assert.equal(islandExpandedFor(Number.POSITIVE_INFINITY), false);
});

// UI-08: 入力バーは入力するときだけ上へ広がり、下の端と横の位置は変えない。作業領域からはみ出さない。
test('the input bar grows upward from a fixed bottom edge and stays inside the work area', () => {
  const compact = inputBarBounds(DISPLAY.workArea, false);
  const expanded = inputBarBounds(DISPLAY.workArea, true);
  assert.deepEqual(compact, {
    // 窓は作業領域の下端に付け、「影の余白 16 ＋見える入力バー＋下の余白 16」の高さ、左右に影の余白 16 ずつ（ADR 0204）。
    x: Math.round((1512 - INPUT_BAR_SIZE.width) / 2) - 16,
    y: 33 + 875 - INPUT_BAR_SIZE.height - 16 - 16,
    width: INPUT_BAR_SIZE.width + 32,
    height: INPUT_BAR_SIZE.height + 32,
  });
  assert.deepEqual(expanded, {
    x: Math.round((1512 - INPUT_BAR_EXPANDED_SIZE.width) / 2) - 16,
    y: 33 + 875 - INPUT_BAR_EXPANDED_SIZE.height - 16 - 16,
    width: INPUT_BAR_EXPANDED_SIZE.width + 32,
    height: INPUT_BAR_EXPANDED_SIZE.height + 32,
  });
  assert.equal(compact.y + compact.height, expanded.y + expanded.height);
  const tiny = inputBarBounds({ x: 10, y: 20, width: 320, height: 100 }, true);
  assert.deepEqual(tiny, { x: 10, y: 20, width: 320, height: 100 });
  // 縮めるときは、見える形が縮み終わる（--motion-island の 520ms）まで窓を小さくしない。
  assert.equal(INPUT_BAR_COLLAPSE_DELAY_MS, 560);
});

// PR #104 のレビュー（P3）: 実際の senderFactsOf を通して、送信元のフレームの検査を確かめる。期待値は手で書く。
test('the sender frame must be the current main frame of the registered window', () => {
  const registry = threeWindows();
  const status = 12;
  // 主フレームからの要求は受け付ける。
  assert.deepEqual(
    senderFactsOf(status, frameOf(status), {
      webContentsId: status,
      mainFrame: mainFrameOf(status),
    }),
    {
      senderWebContentsId: 12,
      uiWebContentsId: 12,
      senderIsMainFrame: true,
      senderFrameUrl: APP_URL,
    },
  );
  assert.equal(
    senderFor(registry, status, 'desktop.io_stop').trustedSender,
    true,
  );
  const rejected = { trustedSender: false, windowFocused: true };
  // 同じ窓の子フレーム（親がある）。
  assert.deepEqual(
    senderFor(registry, status, 'desktop.io_stop', {
      frame: { ...frameOf(status), parent: { routingId: 1 } },
    }),
    rejected,
  );
  // 古い processId（読み込み直す前のレンダラーのフレーム）。
  assert.deepEqual(
    senderFor(registry, status, 'desktop.io_stop', {
      frame: { ...frameOf(status), processId: 999 },
    }),
    rejected,
  );
  // 古い routingId。
  assert.deepEqual(
    senderFor(registry, status, 'desktop.io_stop', {
      frame: { ...frameOf(status), routingId: 2 },
    }),
    rejected,
  );
  // 破棄されたフレーム（Electron は senderFrame を null にする）。
  assert.deepEqual(
    senderFor(registry, status, 'desktop.io_stop', { frame: null }),
    rejected,
  );
  assert.deepEqual(
    senderFactsOf(status, null, {
      webContentsId: status,
      mainFrame: mainFrameOf(status),
    }),
    {
      senderWebContentsId: 12,
      uiWebContentsId: 12,
      senderIsMainFrame: false,
      senderFrameUrl: null,
    },
  );
  // 破棄した窓（main は破棄済みの窓を null として渡す）。
  const destroyed = new UiWindowRegistry<FakeWindow>();
  destroyed.register(status, 'status', { name: 'status', mainFrame: null });
  assert.deepEqual(senderFor(destroyed, status, 'desktop.io_stop'), rejected);
  assert.deepEqual(senderFactsOf(status, frameOf(status), null), {
    senderWebContentsId: 12,
    uiWebContentsId: null,
    senderIsMainFrame: false,
    senderFrameUrl: APP_URL,
  });
  // どれも受付では untrusted_sender。
  for (const frame of [
    { ...frameOf(status), parent: {} },
    { ...frameOf(status), processId: 999 },
    { ...frameOf(status), routingId: 2 },
    null,
  ])
    assert.deepEqual(
      admitDesktopRequest(
        'desktop.io_stop',
        null,
        UNLOCKED,
        senderFor(registry, status, 'desktop.io_stop', { frame }),
      ),
      { ok: false, reason: 'untrusted_sender' },
    );
});

test('the controller turns a summon from the status layer or the input bar into the summon effect', () => {
  const registry = threeWindows();
  const controller = new DesktopDeviceController({
    contract: createDesktopContract(loadContractSchema()),
    initial: { io_epoch: '0', stop_scope: 'none' },
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    persist: () => undefined,
    onNotification: () => undefined,
    onPersistError: () => undefined,
  });
  const request = {
    channel: SUMMON,
    request_id: '5d0e3c1a-7b2f-4a6e-8c9d-0e1f2a3b4c5d',
    payload: null,
  };
  const rejected = (reason: string) => ({
    request_id: request.request_id,
    channel: SUMMON,
    outcome: 'rejected',
    reason,
  });
  // ロック状態が不明（起動直後）なら呼ばない。
  assert.deepEqual(
    controller.handleIpc(SUMMON, request, senderFor(registry, 12, SUMMON))
      .response,
    rejected('device_locked'),
  );
  controller.applyLockQuery('unlock_screen');
  for (const id of [12, 13])
    assert.deepEqual(
      controller.handleIpc(SUMMON, request, senderFor(registry, id, SUMMON)),
      {
        response: {
          request_id: request.request_id,
          channel: SUMMON,
          outcome: 'ok',
        },
        effect: 'summon_canvas',
      },
    );
  // キャンバス自身からは呼べない。前面でない窓からも呼べない。
  assert.deepEqual(
    controller.handleIpc(SUMMON, request, senderFor(registry, 11, SUMMON))
      .response,
    rejected('untrusted_sender'),
  );
  assert.deepEqual(
    controller.handleIpc(
      SUMMON,
      request,
      senderFor(registry, 12, SUMMON, { focused: false }),
    ).response,
    rejected('screen_operation_required'),
  );
  // 入出力の状態は変えない。
  assert.equal(controller.state.stopScope, 'none');
});

// 忘却の画面（UI-10、ADR 0183）: 記憶の一覧・計画・実行のチャネルは、従来の窓と状態の層のパネルだけが使える。
// キャンバス・入力バー・島からは、前面でもロック解除済みでも untrusted_sender。期待値は手で書いた。
test('forget screen channels: only the legacy window and the status panel reach them', () => {
  const registry = new UiWindowRegistry<FakeWindow>();
  registry.register(21, 'legacy', { name: 'legacy' });
  registry.register(22, 'status', { name: 'status' });
  registry.register(23, 'canvas', { name: 'canvas' });
  registry.register(24, 'input', { name: 'input' });
  registry.register(25, 'island', { name: 'island' });
  const memory = [
    'desktop.memories_list',
    'desktop.forget_plan',
    'desktop.forget_execute',
    // 保存してよい記憶の種類の設定の変更（ADR 0191）も同じ窓だけ。
    'desktop.memory_settings_change',
  ];
  for (const channel of memory) {
    for (const [id, role] of [
      [21, 'legacy'],
      [22, 'status'],
    ] as const) {
      assert.equal(channelAllowedForWindow(role, channel), true, channel);
      assert.deepEqual(
        admitDesktopRequest(
          channel,
          null,
          UNLOCKED,
          senderFor(registry, id, channel, { focused: true }),
        ),
        { ok: true },
        `${role} ${channel}`,
      );
    }
    for (const [id, role] of [
      [23, 'canvas'],
      [24, 'input'],
      [25, 'island'],
    ] as const) {
      assert.equal(channelAllowedForWindow(role, channel), false, channel);
      assert.deepEqual(
        admitDesktopRequest(
          channel,
          null,
          UNLOCKED,
          senderFor(registry, id, channel, { focused: true }),
        ),
        { ok: false, reason: 'untrusted_sender' },
        `${role} ${channel}`,
      );
    }
  }
  // 一覧はロック解除済みなら前面でなくても読める。計画と実行は前面の画面操作だけ。ロック中・不明はどれも拒否。
  const back = (channel: string) =>
    admitDesktopRequest(
      channel,
      null,
      UNLOCKED,
      senderFor(registry, 21, channel, { focused: false }),
    );
  assert.deepEqual(back('desktop.memories_list'), { ok: true });
  assert.deepEqual(back('desktop.forget_plan'), {
    ok: false,
    reason: 'screen_operation_required',
  });
  assert.deepEqual(back('desktop.forget_execute'), {
    ok: false,
    reason: 'screen_operation_required',
  });
  // 保存してよい記憶の種類の設定の変更（ADR 0191）も前面の画面操作だけ。
  assert.deepEqual(back('desktop.memory_settings_change'), {
    ok: false,
    reason: 'screen_operation_required',
  });
  for (const lockState of ['locked', 'unknown'] as const)
    for (const channel of memory)
      assert.deepEqual(
        admitDesktopRequest(
          channel,
          null,
          { ...UNLOCKED, lockState },
          senderFor(registry, 21, channel, { focused: true }),
        ),
        { ok: false, reason: 'device_locked' },
        `${lockState} ${channel}`,
      );
  // 中枢の記録を消すだけで外部へは送らないので、この端末の入出力の停止中も計画・実行を受け付ける。
  for (const channel of [
    'desktop.forget_plan',
    'desktop.forget_execute',
    'desktop.memory_settings_change',
  ])
    assert.deepEqual(
      admitDesktopRequest(
        channel,
        null,
        { ...UNLOCKED, stopScope: 'local' },
        senderFor(registry, 21, channel, { focused: true }),
      ),
      { ok: true },
      channel,
    );
});

// 保存モードの切り替え（UI-05 の段階 6、ADR 0189）: 従来の窓と状態の層のパネルだけが、前面の本人の画面操作で使える。
// キャンバス・入力バー・島（記録しないモードの印を出すだけ）からは、前面でもロック解除済みでも untrusted_sender。
// 期待値は手で書いた。
test('storage mode change: only the legacy window and the status panel switch it, by a screen operation', () => {
  const registry = new UiWindowRegistry<FakeWindow>();
  registry.register(31, 'legacy', { name: 'legacy' });
  registry.register(32, 'status', { name: 'status' });
  registry.register(33, 'canvas', { name: 'canvas' });
  registry.register(34, 'input', { name: 'input' });
  registry.register(35, 'island', { name: 'island' });
  const channel = 'desktop.storage_mode_change';
  const admit = (
    id: number,
    focused: boolean,
    state: {
      readonly lockState?: 'unlocked' | 'locked' | 'unknown';
      readonly stopScope?: 'none' | 'local' | 'guest' | 'global';
    } = {},
  ) =>
    admitDesktopRequest(
      channel,
      null,
      { ...UNLOCKED, ...state },
      senderFor(registry, id, channel, { focused }),
    );
  assert.deepEqual(admit(31, true), { ok: true });
  assert.deepEqual(admit(32, true), { ok: true });
  assert.equal(channelAllowedForWindow('legacy', channel), true);
  assert.equal(channelAllowedForWindow('status', channel), true);
  for (const [id, role] of [
    [33, 'canvas'],
    [34, 'input'],
    [35, 'island'],
  ] as const) {
    assert.equal(channelAllowedForWindow(role, channel), false, role);
    assert.deepEqual(
      admit(id, true),
      { ok: false, reason: 'untrusted_sender' },
      role,
    );
  }
  // 前面でない窓（後ろにある従来の窓・パネル）からは受け付けない。
  assert.deepEqual(admit(31, false), {
    ok: false,
    reason: 'screen_operation_required',
  });
  assert.deepEqual(admit(32, false), {
    ok: false,
    reason: 'screen_operation_required',
  });
  // ロック中・不明は拒否。
  assert.deepEqual(admit(32, true, { lockState: 'locked' }), {
    ok: false,
    reason: 'device_locked',
  });
  assert.deepEqual(admit(31, true, { lockState: 'unknown' }), {
    ok: false,
    reason: 'device_locked',
  });
  // 入出力の停止中（この端末・来客・全体）も受け付ける（外部へは送らない。記録しないモードに入るのを止めない）。
  for (const stopScope of ['local', 'guest', 'global'] as const)
    assert.deepEqual(admit(32, true, { stopScope }), { ok: true }, stopScope);
});

// 流れの表示先の移動「このPCに出す」（UI-05 の段階 5、ADR 0193）。従来の窓（legacy）と状態の層のパネルだけが、前面の
// ロック解除済みの画面操作として送れる（従来の窓は表示のリースを取らない組み立てで main が断る。core-link の試験）。
// キャンバス・入力バー・島からは、前面でもロック解除済みでも untrusted_sender。期待値は手で書いた。
test('display handoff: only the legacy window and the status panel move the display, by a screen operation', () => {
  const registry = new UiWindowRegistry<FakeWindow>();
  registry.register(41, 'legacy', { name: 'legacy' });
  registry.register(42, 'status', { name: 'status' });
  registry.register(43, 'canvas', { name: 'canvas' });
  registry.register(44, 'input', { name: 'input' });
  registry.register(45, 'island', { name: 'island' });
  const channel = 'desktop.display_handoff';
  const admit = (
    id: number,
    focused: boolean,
    state: {
      readonly lockState?: 'unlocked' | 'locked' | 'unknown';
      readonly stopScope?: 'none' | 'local' | 'guest' | 'global';
    } = {},
  ) =>
    admitDesktopRequest(
      channel,
      null,
      { ...UNLOCKED, ...state },
      senderFor(registry, id, channel, { focused }),
    );
  assert.deepEqual(admit(41, true), { ok: true });
  assert.deepEqual(admit(42, true), { ok: true });
  for (const [id, role] of [
    [43, 'canvas'],
    [44, 'input'],
    [45, 'island'],
  ] as const) {
    assert.equal(channelAllowedForWindow(role, channel), false, role);
    assert.deepEqual(
      admit(id, true),
      { ok: false, reason: 'untrusted_sender' },
      role,
    );
  }
  // 前面でない窓からは受け付けない。
  assert.deepEqual(admit(42, false), {
    ok: false,
    reason: 'screen_operation_required',
  });
  // ロック中・不明は拒否。
  assert.deepEqual(admit(42, true, { lockState: 'locked' }), {
    ok: false,
    reason: 'device_locked',
  });
  assert.deepEqual(admit(42, true, { lockState: 'unknown' }), {
    ok: false,
    reason: 'device_locked',
  });
  // 入出力の停止中の判断は中枢が持つ（受付は止めない。中枢が io_suspended で断る）。
  for (const stopScope of ['local', 'guest', 'global'] as const)
    assert.deepEqual(admit(42, true, { stopScope }), { ok: true }, stopScope);
});
