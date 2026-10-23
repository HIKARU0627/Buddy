// Electron の main の薄いアダプター（設計 02・10 §1、ADR 0014・0015・0025）。
// ここは BrowserWindow・Tray・ipcMain・powerMonitor・protocol・safeStorage・app のライフサイクルの接続だけを持ち、
// 判断は Electron に依存しない純粋なモジュール（device-controller・core-link・window-policy・lock-query・
// device-io-store・credential-store など）に任せる。
// 中枢との接続（B03-05）: 端末トークンは main だけが持ち、safeStorage で暗号化して保存する。Renderer・IPC・ログに出さない。
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from 'electron';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import {
  createHomeFingerprintCollector,
  createNodeCommandRunner,
} from '@buddy/platform/home-fingerprint';
import { fileURLToPath } from 'node:url';
import { DESKTOP_IPC_CHANNELS, type DesktopPowerEvent } from '@buddy/domain';
import { adminConfirmText } from '../admin-confirm.js';
import { ConnectionPublisher } from '../connection-publisher.js';
import { createDesktopContract, loadContractSchema } from '../contract.js';
import type { DesktopCanvasDisplaySettings } from '@buddy/contracts';
import {
  ADMIN_CHANNELS,
  CANVAS_CHANNELS,
  CONNECTION_CHANNELS,
  OPERATION_CHANNELS,
  DesktopCoreLink,
  type AdminConfirmRequest,
} from '../core-link.js';
import {
  CanvasPresence,
  CanvasSummoner,
  isDismissKey,
  MAC_DESKTOP_RELATIVE_LEVEL,
  type CanvasDismissReason,
  type CanvasSummonSource,
} from '../canvas-presence.js';
import {
  CANVAS_DISPLAY_FILE,
  DEFAULT_CANVAS_DISPLAY_SETTINGS,
  canvasWorkAreaNotification,
  loadCanvasDisplaySettings,
  resolveCanvasDisplay,
} from '../canvas-display.js';
import { CREDENTIAL_FILE } from '../credential-store.js';
import {
  STOP_SHORTCUT_ARG,
  registerGlobalShortcuts,
  shortcutsForMode,
  stopShortcutState,
  trayMenuEntries,
  type GlobalShortcutId,
  type StopShortcutState,
} from '../global-shortcuts.js';
import {
  CONFIRM_NOT_SHOWN,
  StatusPanel,
  confirmDialogParent,
  runPanelConfirm,
  statusWindowBounds,
} from '../status-panel.js';
import type { SecretProtector } from '../credential-store.js';
import { DesktopDeviceController } from '../device-controller.js';
import { networkSignatureOf } from '../home-reporter.js';
import { devicePlatformOf, systemClock } from '../system-clock.js';
import {
  DEVICE_IO_STATE_FILE,
  loadDeviceIoRecord,
  saveDeviceIoRecord,
} from '../device-io-store.js';
import {
  LOCK_QUERY_IDLE_THRESHOLD_SECONDS,
  lockQueryEvent,
} from '../lock-query.js';
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  CONTENT_SECURITY_POLICY,
  ClientLifecycle,
  TRAY_MENU,
  externalOpenTarget,
  navigationAllowed,
  resolveAppAsset,
  trayTooltip,
  type TrayAction,
} from '../window-policy.js';
import {
  UiWindowRegistry,
  canvasResendAfter,
  rolesForMode,
  senderFactsOf,
  uiWindowMode,
  uiWindowSpec,
  windowSender,
  type UiWindowRole,
} from '../window-roles.js';

const here = fileURLToPath(new URL('.', import.meta.url));
// dist/main/electron から見たビルド済みの preload と画面。
const PRELOAD_PATH = join(here, '..', '..', 'preload', 'preload.cjs');
const RENDERER_DIR = join(here, '..', '..', 'renderer');

// トレイのアイコン（16px と 32px の PNG。リポジトリにバイナリを置かないため埋め込む）。
const TRAY_ICON_1X =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAT0lEQVR4nGPQz7/HgAf/h2KcavBpwoXxGkBIM4Yh5GhGMYRczXBD8BlAjPdwGkAoVlAMIMZ2nK6gigEUe4EmgUhyNFKckKiSlKmSmUjOzgDIAA+LwvufTQAAAABJRU5ErkJggg==';
const TRAY_ICON_2X =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAlklEQVR4nO3UyQ2AMAxEUXdEaXRMK3COTJYZxk6QcvAR/wciseO8bOYwD92dCQH0ojQmMj6EiAwPQbLiVURm/BWxHCA67hAz4gWCBSh+XgqgvLgKwNc3Z78EBBiNQzs3YAN+BQg9htMvIkTdgsA72IcV4wCZCKsBMhC2PCAS4VqKs0zHewAVpLlffbNBcQSAYKB9DEA6DxdGPimEe0K2AAAAAElFTkSuQmCC';

// 画面は登録した特権スキームから読み込む（file:// を使わない）。ready の前に登録する必要がある。
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
]);
// すべてのレンダラーを sandbox にする。
app.enableSandbox();

const lifecycle = new ClientLifecycle();
// 窓の組み立て方（UI-02）。既定は従来の 1 つの窓。開発用のフラグ --buddy-ui=canvas（または BUDDY_DESKTOP_UI=canvas）で
// キャンバス・状態の層・入力バーの 3 つの窓（試作）にする。
// 開発の起動（app.isPackaged が false）のときだけフラグと環境変数を受け、配布版は必ず従来の窓。
const uiMode = uiWindowMode(process.argv, process.env, {
  packaged: app.isPackaged,
});
// キャンバスを前に出しているか（UI-02、本人の判断 2026-10-22）。正本は main。
const presence = new CanvasPresence();
// 呼ぶ・戻すの手順（canvas-presence.ts）。窓の操作は BrowserWindow へ渡す。
const summoner = new CanvasSummoner({
  platform: process.platform,
  presence,
  canvas: () => {
    const canvas = liveWindow('canvas');
    if (canvas === null) return null;
    return {
      setFocusable: (value) => canvas.setFocusable(value),
      setSkipTaskbar: (value) => canvas.setSkipTaskbar(value),
      setLevel: (level) => {
        if (level === 'normal') canvas.setAlwaysOnTop(false);
        else canvas.setAlwaysOnTop(true, 'normal', MAC_DESKTOP_RELATIVE_LEVEL);
      },
      show: () => canvas.show(),
      focus: () => canvas.focus(),
      blur: () => canvas.blur(),
    };
  },
  companions: () =>
    (['status', 'input'] as const).flatMap((role) => {
      const window = liveWindow(role);
      return window === null
        ? []
        : [
            {
              isVisible: () => window.isVisible(),
              showInactive: () => window.showInactive(),
            },
          ];
    }),
  lockState: () => controller?.state.lockState ?? 'unknown',
  // log は後で宣言するので、呼ぶときに引く。
  log: (code) => log(code),
});
// 状態の層のパネル（UI-04）。出しているかの正本は main。画面は窓の幅に合わせて描く。
const statusPanel = new StatusPanel({
  window: () => {
    const window = liveWindow('status');
    if (window === null) return null;
    return {
      setBounds: (bounds, animate) => window.setBounds(bounds, animate),
      isVisible: () => window.isVisible(),
      show: () => window.show(),
      focus: () => window.focus(),
    };
  },
  workArea: () => uiDisplay().workArea,
  reducedMotion: () => {
    try {
      return systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch {
      return true;
    }
  },
  // パネルをしまうときは、パネルを親にした確認を閉じて送らない。
  closeConfirm: () => link?.closeConfirm(),
  // 全体のショートカットで出すとき、ほかのアプリが前面でも Buddy を前面にする（macOS）。
  activateApp: () => {
    if (process.platform === 'darwin') app.focus({ steal: true });
  },
  log: (code) => log(code),
});
// 全体の停止のショートカットを登録できたか（窓とトレイに印を出す。登録は start で窓を作る前に行う）。
let stopShortcut: StopShortcutState = 'registered';
// main が作った窓の webContents と役割の対応。送信元の検査と通知の宛先はこれだけで決める。
const windows = new UiWindowRegistry<BrowserWindow>();
let tray: Tray | null = null;
let controller: DesktopDeviceController | null = null;
let link: DesktopCoreLink | null = null;
let contractRef: ReturnType<typeof createDesktopContract> | null = null;

// ログは理由のコードだけ（トークン・宛先・指紋の値・自宅の指紋を出さない）。例外の本文も出さない。
const log = (code: string) => console.error(`[buddy-desktop] ${code}`);

function liveWindow(role: UiWindowRole): BrowserWindow | null {
  const window = windows.byRole(role)?.window ?? null;
  return window !== null && !window.isDestroyed() ? window : null;
}

// 本人の画面操作（承認・失効・自宅の登録の確認）を受け持つ窓。従来の窓、または状態の層。
function screenWindow(): BrowserWindow | null {
  return liveWindow(uiMode === 'canvas' ? 'status' : 'legacy');
}

// 通知は、読み込みが終わり、役割の表（DESKTOP_ROLE_NOTIFICATIONS）に通知がある窓にだけ送る。
// 画面の読み込みが終わるまでの通知は送らず、読み込み後に記録をまとめて送る。
function sendToRenderer(channel: string, payload: unknown): void {
  for (const entry of windows.notificationTargets(channel)) {
    const contents = entry.window.isDestroyed()
      ? null
      : entry.window.webContents;
    if (contents && !contents.isDestroyed()) contents.send(channel, payload);
  }
}

function showWindow(): void {
  // 準備（スキーム・IPC の登録）が終わる前の activate・second-instance では作らない。
  if (!controller) return;
  // 画面が自分で window.close() した場合もクライアントはトレイに残り、ここで作り直す。
  for (const role of rolesForMode(uiMode)) {
    const window = liveWindow(role) ?? createWindow(role);
    if (window.isMinimized()) window.restore();
    if (
      uiWindowSpec(role, process.platform, uiDisplay(), PRELOAD_PATH)
        .focusOnShow
    ) {
      window.show();
      window.focus();
    } else window.showInactive();
  }
}

function hideWindows(): void {
  dismissCanvas('hidden');
  for (const entry of windows.entries())
    if (!entry.window.isDestroyed()) entry.window.hide();
}

function requestQuit(): void {
  lifecycle.requestQuit();
  app.quit();
}

// OS へロック状態を問い合わせ、取得できたときだけ反映する（ADR 0015 の決定 1）。
function queryLockState(): void {
  if (!controller) return;
  try {
    const idle = powerMonitor.getSystemIdleState(
      LOCK_QUERY_IDLE_THRESHOLD_SECONDS,
    );
    controller.applyLockQuery(lockQueryEvent(process.platform, idle));
  } catch {
    // 取得できなければ unknown のまま（解除済みと扱わない）。
    log('lock_query_failed');
  }
}

// 送信元の事実。送信元の webContents が main の作った窓（対応表にある窓）のときだけ、その窓の主フレームと比べる
// （判定は window-roles.ts の senderFactsOf。破棄した窓・破棄したフレームは一致しない）。
function senderFacts(event: IpcMainInvokeEvent, ui: BrowserWindow | null) {
  const live =
    ui !== null && !ui.isDestroyed() && !ui.webContents.isDestroyed()
      ? ui
      : null;
  return senderFactsOf(
    event.sender.id,
    event.senderFrame,
    live === null
      ? null
      : {
          webContentsId: live.webContents.id,
          mainFrame: live.webContents.mainFrame,
        },
  );
}

// キャンバスを前に出す（全体のショートカット・端のつまみ・入力バー）。ロック中・不明は出さない。
function summonCanvas(source: CanvasSummonSource): void {
  summoner.summon(source);
}

function dismissCanvas(reason: CanvasDismissReason): void {
  summoner.dismiss(reason);
}

function isWindowFocused(window: BrowserWindow | null): boolean {
  return (
    window !== null &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.isMinimized() &&
    window.isFocused()
  );
}

// 本人の画面操作を受け持つ窓が表示中かつ前面にあるか（自宅の登録の送る直前の確かめ直し）。
function windowFocused(): boolean {
  return isWindowFocused(screenWindow());
}

// キャンバスを置く画面の設定（複数のモニターの設定。UI-06）。既定は主の画面。start で userData から読む。
let displaySettings: DesktopCanvasDisplaySettings =
  DEFAULT_CANVAS_DISPLAY_SETTINGS;

// キャンバス・状態の層・入力バーを置く画面（canvas-display.ts の resolveCanvasDisplay。選んだ画面がなければ主の画面）。
function uiDisplay() {
  const primary = screen.getPrimaryDisplay();
  const resolved = resolveCanvasDisplay(
    displaySettings,
    screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
    })),
    primary.id,
  );
  return (
    resolved?.geometry ?? {
      bounds: primary.bounds,
      workArea: primary.workArea,
    }
  );
}

// 画面の追加・取り外し・大きさの変更（UI-06）。置く画面を選び直し、3 つの窓をその画面へ置き直す。
function placeRoleWindows(): void {
  if (uiMode !== 'canvas') return;
  const display = uiDisplay();
  for (const role of ['canvas', 'input'] as const) {
    const window = liveWindow(role);
    if (window === null) continue;
    const { x, y, width, height } = uiWindowSpec(
      role,
      process.platform,
      display,
      PRELOAD_PATH,
    ).options;
    if (x !== undefined && y !== undefined)
      window.setBounds({ x, y, width, height });
    if (role === 'canvas' && process.platform !== 'darwin') window.maximize();
  }
  liveWindow('status')?.setBounds(
    statusWindowBounds(statusPanel.open, display.workArea),
  );
  pushCanvasWorkArea();
}

// キャンバスの窓へ、作業領域の外の幅を送る（UI-06）。画面は配置のエンジンの空ける場所を計算し直す。窓の大きさが
// 変わらず作業領域だけが変わったとき（Dock の大きさ・表示）も、画面の作業領域の変化（display-metrics-changed）で送る。
function pushCanvasWorkArea(): void {
  if (uiMode !== 'canvas' || !contractRef) return;
  const canvas = liveWindow('canvas');
  if (canvas === null) return;
  const notification = canvasWorkAreaNotification(
    canvas.getBounds(),
    uiDisplay().workArea,
  );
  if (contractRef.notificationErrors(notification).length > 0) {
    log('canvas_work_area_invalid');
    return;
  }
  sendToRenderer(notification.channel, notification);
}

// 役割の窓を作る。3 つの窓と従来の窓は、同じ sandbox・contextIsolation・CSP（特権スキームの応答の見出し）・preload を使い、
// 役割の引数（--buddy-window-role）だけが違う。役割の正本は main の対応表（windows）。
function createWindow(role: UiWindowRole): BrowserWindow {
  const spec = uiWindowSpec(role, process.platform, uiDisplay(), PRELOAD_PATH);
  const window = new BrowserWindow({
    ...spec.options,
    webPreferences: {
      ...spec.options.webPreferences,
      // 停止のショートカットを登録できたか（画面の印だけに使う。受付には使わない）。
      additionalArguments: [
        ...spec.options.webPreferences.additionalArguments,
        `${STOP_SHORTCUT_ARG}${stopShortcut}`,
      ],
    },
  });
  const contentsId = window.webContents.id;
  windows.register(contentsId, role, window);
  // 画面共有・スクリーンショットから守る（キャンバスと状態の層）。
  if (spec.contentProtection) window.setContentProtection(true);
  if (spec.allWorkspaces !== null)
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: spec.allWorkspaces.visibleOnFullScreen,
    });
  if (spec.alwaysOnTopLevel !== null)
    window.setAlwaysOnTop(true, spec.alwaysOnTopLevel);
  window.once('ready-to-show', () => {
    if (spec.maximize) window.maximize();
    if (spec.focusOnShow) window.show();
    else window.showInactive();
  });
  // ウィンドウを閉じてもトレイに残る。終了の操作の後だけ閉じる（02）。
  window.on('close', (event) => {
    if (lifecycle.onWindowCloseRequested() === 'hide') {
      event.preventDefault();
      window.hide();
    }
  });
  // 隠れた・最小化された（前面でなくなった）ら、表示している本人の確認（承認・失効・自宅の登録）を閉じて送らない。
  window.on('hide', () => link?.closeConfirm());
  window.on('minimize', () => link?.closeConfirm());
  // 閉じた窓は対応表から外す（閉じた後の要求は役割が分からず拒否される）。
  window.on('closed', () => {
    windows.unregister(contentsId);
    if (role === 'canvas') presence.reset();
    if (role === 'status') statusPanel.reset();
  });
  if (role === 'status') {
    // 状態の層のパネルは、外へのクリック・ほかのアプリへの移動（前面でなくなる）・窓を隠す操作でしまう（UI-04）。
    // 確認のダイアログ（パネルを親にしたシート・モーダル）へフォーカスが移った blur ではしまわない（status-panel.ts）。
    window.on('blur', () => statusPanel.hide('blur'));
    window.on('hide', () => statusPanel.hide('hidden'));
  }
  if (role === 'canvas') {
    // 前に出したキャンバスは、Esc・ほかのアプリへの移動（前面でなくなる）で後ろへ戻る。
    window.on('blur', () => dismissCanvas('blur'));
    // 窓の大きさが変わった（Windows の最大化など）: 作業領域の外の幅を送り直す（UI-06）。
    window.on('resize', pushCanvasWorkArea);
    window.webContents.on('before-input-event', (event, input) => {
      if (presence.layer === 'front' && isDismissKey(input)) {
        event.preventDefault();
        dismissCanvas('escape');
      }
    });
  }
  // 画面が前面に来たとき、ロック状態が解除済みでなければ OS へ問い合わせ直す。
  window.on('focus', () => {
    if (controller && controller.state.lockState !== 'unlocked')
      queryLockState();
  });
  window.webContents.on('did-start-loading', () => {
    windows.setReady(contentsId, false);
  });
  window.webContents.on('did-finish-load', () => {
    windows.setReady(contentsId, true);
    if (!controller) return;
    // 読み込み前の電源・ロックの記録と現在の状態欄を、読み込んだ窓にだけ送る（記録の通知で、停止・再開の命令ではない）。
    const sendHere = (channel: string, payload: unknown) => {
      if (
        windows
          .notificationTargets(channel)
          .some((entry) => entry.webContentsId === contentsId) &&
        !window.isDestroyed()
      )
        window.webContents.send(channel, payload);
    };
    for (const record of controller.powerLog) sendHere(record.channel, record);
    sendHere('desktop.state_changed', {
      channel: 'desktop.state_changed',
      status: controller.statusBar,
    });
    // 読み込み直したキャンバスの窓へ、今の記述を送る（役割の表に通知がある窓だけ）。
    const canvas = link?.canvasView() ?? null;
    if (canvas !== null)
      sendHere('desktop.canvas_changed', {
        channel: 'desktop.canvas_changed',
        canvas,
      });
    // 読み込み直した画面は前回の接続の状態を持っていないので、同じ内容でも送る。
    connectionPublisher.reset();
    pushConnection();
  });
  void window.loadURL(APP_ENTRY_URL);
  return window;
}

function updateTray(): void {
  if (!tray || !controller) return;
  tray.setToolTip(trayTooltip(controller.statusBar));
}

function createTray(): Tray {
  const icon = nativeImage.createFromBuffer(
    Buffer.from(TRAY_ICON_1X, 'base64'),
  );
  icon.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from(TRAY_ICON_2X, 'base64'),
  });
  const created = new Tray(icon);
  const run: Record<TrayAction, () => void> = {
    show_window: showWindow,
    // 全体の停止のショートカット（UI-04）と同じ処理。
    io_stop: () => controller?.stopFromMain(),
    client_quit: requestQuit,
  };
  // 停止の項目には、登録できた停止のショートカットを出す（登録できなければ ⚠ の印。global-shortcuts.ts）。
  created.setContextMenu(
    Menu.buildFromTemplate(
      trayMenuEntries(TRAY_MENU, stopShortcut).map((item) => ({
        label: item.label,
        click: run[item.action],
        ...(item.accelerator === null
          ? {}
          : { accelerator: item.accelerator, registerAccelerator: false }),
      })),
    ),
  );
  // Windows ではアイコンのクリックでウィンドウを出す（macOS はメニューを開く）。
  if (process.platform === 'win32') created.on('click', showWindow);
  return created;
}

// 中枢との接続の状態を状態欄と画面へ送る（ロック中は内容を隠した値）。状態欄の更新が状態欄の通知を出し、
// その処理からもう一度呼ばれても二重に送らない。前回と同じ内容は送らない（connection-publisher.ts）。
const connectionPublisher = new ConnectionPublisher({
  refreshHub: () => {
    if (controller && link) controller.setHub(link.hubStatus());
  },
  build: () => {
    if (!controller || !link || !contractRef) return null;
    const notification = {
      channel: 'desktop.connection_changed' as const,
      connection: link.view(controller.state.lockState),
    };
    const errors = contractRef.notificationErrors(notification);
    if (errors.length > 0) {
      log(`connection_notification_invalid:${errors.join(',')}`);
      return null;
    }
    return notification;
  },
  send: (notification) => sendToRenderer(notification.channel, notification),
});

function pushConnection(): void {
  connectionPublisher.publish();
}

function registerIpc(): void {
  for (const channel of DESKTOP_IPC_CHANNELS) {
    ipcMain.handle(channel, (event, raw: unknown) => {
      if (!controller || !link) throw new Error('desktop_not_ready');
      // 送信元の窓を対応表で引き、送信元の検査に役割の検査（DESKTOP_ROLE_CHANNELS）を足す。
      // 対応表にない・閉じた窓・役割に合わないチャネルは untrusted_sender で拒否される。
      const entry = windows.lookup(event.sender.id);
      const ui = entry?.window ?? null;
      const sender = windowSender({
        channel,
        role: entry?.role ?? null,
        facts: senderFacts(event, ui),
        focused: isWindowFocused(ui),
      });
      if (CONNECTION_CHANNELS.includes(channel))
        return link.handleIpc(channel, raw, sender, controller.state).response;
      // 中枢の画面の端末の申請の承認・端末の管理（B03-06）。中枢へ要求を送るので非同期。
      if (ADMIN_CHANNELS.includes(channel))
        return link
          .handleAdminIpc(channel, raw, sender, controller.state)
          .then((outcome) => outcome.response);
      // 発言・承認・取消・照合（B04-05、ADR 0031）。承認は main の OS の確認ダイアログで 1 回だけ。
      if (OPERATION_CHANNELS.includes(channel))
        return link
          .handleOperationIpc(channel, raw, sender, controller.state)
          .then((outcome) => outcome.response);
      // キャンバスの物のユーザーの操作（UI-06）。キャンバスの窓だけ・前に出ている間だけ（core-link が確かめる）。
      if (CANVAS_CHANNELS.includes(channel))
        return link
          .handleCanvasIpc(channel, raw, sender, controller.state)
          .then((outcome) => outcome.response);
      const outcome = controller.handleIpc(channel, raw, sender);
      // キャンバスの窓は購読を始めてから状態を取る。その取得を、通知を受け取る準備ができた合図にして、今の記述を送り直す
      // （読み込み直しの通知を購読の前に取り逃しても、空のままにしない）。
      if (canvasResendAfter(entry?.role ?? null, channel))
        setImmediate(() => {
          link?.canvasSubscribed();
          pushCanvasWorkArea();
        });
      // 応答を返してからウィンドウを隠す・終了する。入出力の状態と中枢は変えない。
      if (outcome.effect === 'hide_window') setImmediate(hideWindows);
      // 状態の層のパネルを出す・しまう（つまみ・パネルの中の Esc。UI-04）。応答を返してから窓の大きさを変える。
      if (outcome.effect === 'status_panel_open')
        setImmediate(() => {
          statusPanel.request(true);
          // パネルを開いたら、予算の確認の項目と予算保留を読み直す（B07-05）。
          void link?.refreshBudget();
        });
      if (outcome.effect === 'status_panel_close')
        setImmediate(() => statusPanel.request(false));
      // キャンバスを前に出す（端のつまみ・入力バー）。応答を返してから出す。
      if (outcome.effect === 'summon_canvas') {
        const source: CanvasSummonSource =
          entry?.role === 'input' ? 'input' : 'status';
        setImmediate(() => summonCanvas(source));
      }
      if (outcome.effect === 'quit') setImmediate(requestQuit);
      return outcome.response;
    });
  }
}

function registerPowerMonitor(): void {
  const forward = (event: DesktopPowerEvent) => () => {
    controller?.recordOsEvent(event);
    // スリープからの復帰では解除済みに戻さず、OS へ問い合わせて確かめる（07 §2・§5）。
    // ネットワークも変わり得るので、自宅の指紋を報告し直して接続し直す。
    if (event === 'resume') {
      queryLockState();
      link?.networkMayHaveChanged('resume');
    }
  };
  powerMonitor.on('lock-screen', forward('lock_screen'));
  powerMonitor.on('unlock-screen', forward('unlock_screen'));
  powerMonitor.on('suspend', forward('suspend'));
  powerMonitor.on('resume', forward('resume'));
  powerMonitor.on('shutdown', forward('shutdown'));
}

function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event) => {
      if (!navigationAllowed(event.url)) event.preventDefault();
    });
    contents.on('will-redirect', (event) => {
      if (!navigationAllowed(event.url)) event.preventDefault();
    });
    // 新しいウィンドウはすべて拒否し、https のリンクだけを通常のブラウザーへ渡す。
    contents.setWindowOpenHandler(({ url }) => {
      const target = externalOpenTarget(url);
      if (target !== null)
        void shell
          .openExternal(target)
          .catch(() => log('open_external_failed'));
      return { action: 'deny' };
    });
  });
  // UI レンダラーはマイク・カメラ・通知などの権限を持たない（音声は B05 の音声レンダラー）。
  session.defaultSession.setPermissionRequestHandler((_c, _p, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const asset = resolveAppAsset(RENDERER_DIR, request.url);
    if (asset === null) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(asset.path), {
        status: 200,
        headers: {
          'content-type': asset.contentType,
          'content-security-policy': CONTENT_SECURITY_POLICY,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

// safeStorage の呼び出しはここだけ（credential-store は注入された SecretProtector を使う）。
function secretProtector(): SecretProtector {
  return {
    platform: process.platform,
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    selectedBackend: () =>
      process.platform === 'linux'
        ? safeStorage.getSelectedStorageBackend()
        : null,
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (cipher) => safeStorage.decryptString(cipher),
  };
}

function createLink(
  contract: ReturnType<typeof createDesktopContract>,
): DesktopCoreLink {
  const collector = createHomeFingerprintCollector({
    platform: process.platform,
    runner: createNodeCommandRunner(),
    networkInterfaces: () => networkInterfaces(),
  });
  return new DesktopCoreLink({
    contract,
    credentialPath: join(app.getPath('userData'), CREDENTIAL_FILE),
    protector: secretProtector(),
    clock: systemClock(),
    platform: devicePlatformOf(process.platform),
    // 指紋の値は main の中だけで使う（中枢への報告・登録の本文）。画面へは伏せた表示だけを渡す（B03-08）。
    collectHome: async () => {
      const observation = await collector.collect();
      return {
        gateway_mac: observation.gateway_mac,
        subnet: observation.subnet,
        ssid: observation.ssid,
        unavailable: observation.unavailable,
      };
    },
    networkSignature: () => networkSignatureOf(networkInterfaces()),
    // 自宅の登録の送る直前に、前面かを確かめ直す（受付の判定と同じ条件）。
    windowFocused,
    // 送る直前に、最新の停止状態と io_epoch を確かめる（確認の最中に停止したら送らない。B04-05）。
    ioState: () =>
      controller?.state ?? {
        lockState: 'unknown',
        stopScope: 'local',
        ioEpoch: '0',
      },
    onChange: pushConnection,
    log,
    confirmAdmin: confirmAdminWithDialog,
    // キャンバスのモード（開発用のフラグ）では、入力バーの発言を流れへ送り、キャンバスの記述をキャンバスの窓だけへ渡す
    // （役割の表 DESKTOP_ROLE_NOTIFICATIONS。状態の層・入力バーへは送らない）。
    canvasMode: uiMode === 'canvas',
    // キャンバスが前に出ているか（ユーザーの操作は前に出ている間だけ。UI-06）。
    canvasFront: () => presence.layer === 'front',
    onCanvas: (notification) =>
      sendToRenderer(notification.channel, notification),
  });
}

// 承認・拒否・失効の前の本人の確認（本人の判断 2026-10-22、ADR 0026）。親付きのモーダルな OS の確認ダイアログで、
// 「やめる」を既定・取り消しにする。ロック・切断で signal が閉じられたら閉じる。ウィンドウがなければ確認できないので送らない。
// 3 つの窓の組み立て（UI-04 で決めた。ADR 0032）では、パネルが出ている間だけ、状態の層の窓（パネル）を親にする
// （macOS はパネルに付くシート、Windows はパネルが持ち主のモーダル）。パネルが出ていなければ確認を出さず、送らない。
// 確認を出している間は、確認へフォーカスが移ってもパネルをしまわない。パネルをしまう・窓を隠す・ロック・停止で閉じる。
async function confirmAdminWithDialog(
  request: AdminConfirmRequest,
  signal: AbortSignal,
): Promise<boolean | typeof CONFIRM_NOT_SHOWN> {
  const parent = confirmDialogParent(uiMode, statusPanel.open);
  const window = parent === null ? null : liveWindow(parent);
  // 確認を出せない（親の窓・パネルがない）。「やめる」ではないので、画面操作からやり直させる。
  if (window === null) return CONFIRM_NOT_SHOWN;
  if (signal.aborted) return false;
  const text = adminConfirmText(request);
  const options: Electron.MessageBoxOptions = {
    type:
      request.action === 'approve' ||
      (request.action === 'register_home' && !request.replacing)
        ? 'question'
        : 'warning',
    title: text.title,
    message: text.message,
    detail: text.detail,
    buttons: [...text.buttons],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  };
  if (uiMode === 'legacy') {
    const result = await dialog.showMessageBox(window, options);
    return !signal.aborted && result.response === 1;
  }
  // パネルを親にした確認の手順は status-panel.ts の runPanelConfirm（試験で守る）。main はダイアログを渡すだけ。
  return runPanelConfirm(statusPanel, signal, {
    showDialog: () => dialog.showMessageBox(window, options),
    windowFocused: () => isWindowFocused(liveWindow('status')),
    defer: (task) => setTimeout(task, 150),
  });
}

function start(): void {
  const contract = createDesktopContract(loadContractSchema());
  contractRef = contract;
  const storePath = join(app.getPath('userData'), DEVICE_IO_STATE_FILE);
  const loaded = loadDeviceIoRecord(storePath, new Date());
  const persist = (record: typeof loaded.record) =>
    saveDeviceIoRecord(storePath, record);
  if (loaded.kind === 'corrupt') {
    // 壊れた保存は停止中・大きい世代として扱い、その値ですぐに保存し直す（ADR 0015 の決定 2）。
    log('device_io_state_corrupt');
    try {
      persist(loaded.record);
    } catch {
      log('device_io_state_save_failed');
    }
  }
  controller = new DesktopDeviceController({
    contract,
    initial: loaded.record,
    now: () => new Date(),
    persist,
    onPersistError: () => log('device_io_state_save_failed'),
    onNotification: (notification) => {
      sendToRenderer(notification.channel, notification);
      if (notification.channel === 'desktop.state_changed') {
        updateTray();
        // ロック状態は要求の Buddy-Lock-State と接続の表示の範囲に使う。
        if (link && controller) {
          // 停止した（トレイ・画面・電源の事象のどれでも）: 表示している承認・取消・再試行の確認を閉じて送らない。
          if (controller.state.stopScope !== 'none') link.closeConfirm();
          link.setLockState(controller.state.lockState);
          // 停止・io_epoch の変化では、キャンバスの記述と参照を捨てる（再開したら取り直す）。
          link.ioStateChanged();
          // ロック中・不明になったら、前に出したキャンバスを後ろへ戻す（中身を出したままにしない）。
          summoner.lockChanged(controller.state.lockState);
          pushConnection();
        }
      }
    },
  });
  // キャンバスを置く画面の設定（UI-06）。端末に保存するのはこれだけ。形が違えば既定（主の画面）にする。
  const display = loadCanvasDisplaySettings(
    join(app.getPath('userData'), CANVAS_DISPLAY_FILE),
    (value) => contract.valid('DesktopCanvasDisplaySettings', value),
  );
  if (display.kind === 'invalid') log('canvas_display_settings_invalid');
  displaySettings = display.settings;
  screen.on('display-added', placeRoleWindows);
  screen.on('display-removed', placeRoleWindows);
  screen.on('display-metrics-changed', placeRoleWindows);
  link = createLink(contract);
  hardenWebContents();
  registerAppProtocol();
  registerIpc();
  registerPowerMonitor();
  // 起動直後のロック状態は unknown。OS へ問い合わせて確かめる。
  queryLockState();
  link.start(controller.state.lockState);
  // 全体のショートカット（global-shortcuts.ts）。全体の停止（トレイの停止と同じ処理）はどの組み立てでも、状態の層の
  // パネル・キャンバスを呼ぶは 3 つの窓の組み立てのときだけ。ほかのアプリが使っていれば登録できず、ショートカットなしで
  // 続ける（トレイ・つまみ・パネル・入力バーから同じ操作ができる）。停止を登録できなければ、トレイと画面に印を出すので、
  // 窓とトレイを作る前に登録する。
  const run: Record<GlobalShortcutId, () => void> = {
    stop: () => controller?.stopFromMain(),
    status_panel: () => {
      // パネルを出すときは、予算の確認の項目と予算保留も読み直す（B07-05）。
      if (statusPanel.toggle() === 'expand') void link?.refreshBudget();
    },
    canvas: () => summonCanvas('shortcut'),
  };
  stopShortcut = stopShortcutState(
    registerGlobalShortcuts(
      shortcutsForMode(uiMode),
      (accelerator, callback) => globalShortcut.register(accelerator, callback),
      run,
      log,
    ),
  );
  tray = createTray();
  updateTray();
  for (const role of rolesForMode(uiMode)) createWindow(role);
}

if (!app.requestSingleInstanceLock()) {
  // 同じ userData の保存を二つのクライアントで書かない。
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // OS の終了要求・メニューの終了もクライアントの終了として扱う（中枢は止めない）。
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    lifecycle.requestQuit();
    link?.stop();
  });
  app.on('window-all-closed', () => {
    if (lifecycle.onAllWindowsClosed() === 'quit') app.quit();
  });
  app.on('activate', showWindow);
  app
    .whenReady()
    .then(start)
    .catch(() => {
      log('start_failed');
      app.exit(1);
    });
}
