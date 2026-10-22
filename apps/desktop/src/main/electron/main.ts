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
import {
  ADMIN_CHANNELS,
  CONNECTION_CHANNELS,
  OPERATION_CHANNELS,
  DesktopCoreLink,
  type AdminConfirmRequest,
} from '../core-link.js';
import {
  CANVAS_SUMMON_ACCELERATOR,
  CanvasPresence,
  canvasLayerOps,
  isDismissKey,
  MAC_DESKTOP_RELATIVE_LEVEL,
  type CanvasDismissReason,
  type CanvasSummonSource,
} from '../canvas-presence.js';
import { CREDENTIAL_FILE } from '../credential-store.js';
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
      uiWindowSpec(role, process.platform, primaryDisplay(), PRELOAD_PATH)
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

// キャンバスの窓に、前に出す・後ろへ戻す操作を当てる（canvasLayerOps の列のとおり）。
function applyCanvasLayer(layer: 'front' | 'behind'): void {
  const canvas = liveWindow('canvas');
  if (canvas === null) return;
  for (const step of canvasLayerOps(process.platform, layer)) {
    if (step.op === 'set_focusable') canvas.setFocusable(step.value);
    else if (step.op === 'set_level')
      if (step.level === 'normal') canvas.setAlwaysOnTop(false);
      else canvas.setAlwaysOnTop(true, 'normal', MAC_DESKTOP_RELATIVE_LEVEL);
    else if (step.op === 'show_focus') {
      canvas.show();
      canvas.focus();
    } else canvas.blur();
  }
}

// キャンバスを前に出す（全体のショートカット・端のつまみ・入力バー）。ロック中・不明は出さない。
function summonCanvas(source: CanvasSummonSource): void {
  const result = presence.summon(source, {
    lockState: controller?.state.lockState ?? 'unknown',
    canvasAvailable: liveWindow('canvas') !== null,
  });
  if (!result.ok) {
    log(`canvas_summon_refused:${result.reason}`);
    return;
  }
  if (result.effect === 'raise') applyCanvasLayer('front');
}

function dismissCanvas(reason: CanvasDismissReason): void {
  if (presence.dismiss(reason) === 'lower') applyCanvasLayer('behind');
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

function primaryDisplay() {
  const display = screen.getPrimaryDisplay();
  return { bounds: display.bounds, workArea: display.workArea };
}

// 役割の窓を作る。3 つの窓と従来の窓は、同じ sandbox・contextIsolation・CSP（特権スキームの応答の見出し）・preload を使い、
// 役割の引数（--buddy-window-role）だけが違う。役割の正本は main の対応表（windows）。
function createWindow(role: UiWindowRole): BrowserWindow {
  const spec = uiWindowSpec(
    role,
    process.platform,
    primaryDisplay(),
    PRELOAD_PATH,
  );
  const window = new BrowserWindow({
    ...spec.options,
    webPreferences: {
      ...spec.options.webPreferences,
      additionalArguments: [...spec.options.webPreferences.additionalArguments],
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
  });
  if (role === 'canvas') {
    // 前に出したキャンバスは、Esc・ほかのアプリへの移動（前面でなくなる）で後ろへ戻る。
    window.on('blur', () => dismissCanvas('blur'));
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
    io_stop: () => controller?.stopFromTray(),
    client_quit: requestQuit,
  };
  created.setContextMenu(
    Menu.buildFromTemplate(
      TRAY_MENU.map((item) => ({
        label: item.label,
        click: run[item.action],
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
      const outcome = controller.handleIpc(channel, raw, sender);
      // 応答を返してからウィンドウを隠す・終了する。入出力の状態と中枢は変えない。
      if (outcome.effect === 'hide_window') setImmediate(hideWindows);
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
  });
}

// 承認・拒否・失効の前の本人の確認（本人の判断 2026-10-22、ADR 0026）。親付きのモーダルな OS の確認ダイアログで、
// 「やめる」を既定・取り消しにする。ロック・切断で signal が閉じられたら閉じる。ウィンドウがなければ確認できないので送らない。
// 3 つの窓の試作（UI-02）では、状態の層のつまみが小さく、シートを付けられないので、親を付けないアプリのモーダルにする
// （状態の層がなければ送らないことは同じ。確認の出し方は UI-04 で決める）。
async function confirmAdminWithDialog(
  request: AdminConfirmRequest,
  signal: AbortSignal,
): Promise<boolean> {
  const window = screenWindow();
  if (window === null || signal.aborted) return false;
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
  const result =
    uiMode === 'canvas'
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(window, options);
  return !signal.aborted && result.response === 1;
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
          // ロック中・不明になったら、前に出したキャンバスを後ろへ戻す（中身を出したままにしない）。
          if (presence.lockChanged(controller.state.lockState) === 'lower')
            applyCanvasLayer('behind');
          pushConnection();
        }
      }
    },
  });
  link = createLink(contract);
  hardenWebContents();
  registerAppProtocol();
  registerIpc();
  registerPowerMonitor();
  tray = createTray();
  updateTray();
  // 起動直後のロック状態は unknown。OS へ問い合わせて確かめる。
  queryLockState();
  link.start(controller.state.lockState);
  for (const role of rolesForMode(uiMode)) createWindow(role);
  // 全体のショートカットでキャンバスを呼ぶ（3 つの窓の組み立てのときだけ）。ほかのアプリが使っていれば登録できず、
  // ショートカットなしで続ける（端のつまみ・入力バーから呼べる）。
  if (uiMode === 'canvas') {
    try {
      if (
        !globalShortcut.register(CANVAS_SUMMON_ACCELERATOR, () =>
          summonCanvas('shortcut'),
        )
      )
        log('canvas_shortcut_unavailable');
    } catch {
      log('canvas_shortcut_unavailable');
    }
  }
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
