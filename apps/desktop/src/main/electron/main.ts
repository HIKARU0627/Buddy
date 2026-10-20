// Electron の main の薄いアダプター（設計 02・10 §1、ADR 0014・0015）。
// ここは BrowserWindow・Tray・ipcMain・powerMonitor・protocol・app のライフサイクルの接続だけを持ち、
// 判断は Electron に依存しない純粋なモジュール（device-controller・window-policy・lock-query・device-io-store）に任せる。
// B01 は中枢に接続しない（ADR 0012）。端末トークンも持たない（B03 で main だけが持つ）。
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  ipcMain,
  nativeImage,
  powerMonitor,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_IPC_CHANNELS, type DesktopPowerEvent } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from '../contract.js';
import { DesktopDeviceController } from '../device-controller.js';
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
  isTrustedSender,
  navigationAllowed,
  resolveAppAsset,
  trayTooltip,
  type TrayAction,
} from '../window-policy.js';

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
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: DesktopDeviceController | null = null;
// 画面の読み込みが終わるまでの通知は送らず、読み込み後に記録をまとめて送る。
let rendererReady = false;

const log = (code: string, error?: unknown) =>
  console.error(
    `[buddy-desktop] ${code}`,
    error instanceof Error ? error.message : '',
  );

function sendToRenderer(channel: string, payload: unknown): void {
  const contents = mainWindow?.webContents;
  if (!rendererReady || !contents || contents.isDestroyed()) return;
  contents.send(channel, payload);
}

function showWindow(): void {
  // 準備（スキーム・IPC の登録）が終わる前の activate・second-instance では作らない。
  if (!controller) return;
  // 画面が自分で window.close() した場合もクライアントはトレイに残り、ここで作り直す。
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
  } catch (error) {
    // 取得できなければ unknown のまま（解除済みと扱わない）。
    log('lock_query_failed', error);
  }
}

function senderFacts(event: IpcMainInvokeEvent) {
  const ui = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const frame = event.senderFrame;
  const main = ui?.webContents.mainFrame;
  return {
    senderWebContentsId: event.sender.id,
    uiWebContentsId: ui ? ui.webContents.id : null,
    senderIsMainFrame:
      frame !== null &&
      main !== undefined &&
      frame.parent === null &&
      frame.processId === main.processId &&
      frame.routingId === main.routingId,
    senderFrameUrl: frame?.url ?? null,
  };
}

function windowFocused(): boolean {
  const window = mainWindow;
  return (
    window !== null &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.isMinimized() &&
    window.isFocused()
  );
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'Buddy',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
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
    },
  });
  window.once('ready-to-show', () => window.show());
  // ウィンドウを閉じてもトレイに残る。終了の操作の後だけ閉じる（02）。
  window.on('close', (event) => {
    if (lifecycle.onWindowCloseRequested() === 'hide') {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    rendererReady = false;
  });
  // 画面が前面に来たとき、ロック状態が解除済みでなければ OS へ問い合わせ直す。
  window.on('focus', () => {
    if (controller && controller.state.lockState !== 'unlocked')
      queryLockState();
  });
  window.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  window.webContents.on('did-finish-load', () => {
    rendererReady = true;
    if (!controller) return;
    // 読み込み前の電源・ロックの記録と現在の状態欄を送る（記録の通知で、停止・再開の命令ではない）。
    for (const record of controller.powerLog)
      sendToRenderer(record.channel, record);
    sendToRenderer('desktop.state_changed', {
      channel: 'desktop.state_changed',
      status: controller.statusBar,
    });
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

function registerIpc(): void {
  for (const channel of DESKTOP_IPC_CHANNELS) {
    ipcMain.handle(channel, (event, raw: unknown) => {
      if (!controller) throw new Error('desktop_not_ready');
      const outcome = controller.handleIpc(channel, raw, {
        trustedSender: isTrustedSender(senderFacts(event)),
        windowFocused: windowFocused(),
      });
      // 応答を返してからウィンドウを隠す・終了する。入出力の状態と中枢は変えない。
      if (outcome.effect === 'hide_window')
        setImmediate(() => mainWindow?.hide());
      if (outcome.effect === 'quit') setImmediate(requestQuit);
      return outcome.response;
    });
  }
}

function registerPowerMonitor(): void {
  const forward = (event: DesktopPowerEvent) => () => {
    controller?.recordOsEvent(event);
    // スリープからの復帰では解除済みに戻さず、OS へ問い合わせて確かめる（07 §2・§5）。
    if (event === 'resume') queryLockState();
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
          .catch((error: unknown) => log('open_external_failed', error));
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

function start(): void {
  const contract = createDesktopContract(loadContractSchema());
  const storePath = join(app.getPath('userData'), DEVICE_IO_STATE_FILE);
  const loaded = loadDeviceIoRecord(storePath, new Date());
  const persist = (record: typeof loaded.record) =>
    saveDeviceIoRecord(storePath, record);
  if (loaded.kind === 'corrupt') {
    // 壊れた保存は停止中・大きい世代として扱い、その値ですぐに保存し直す（ADR 0015 の決定 2）。
    log('device_io_state_corrupt');
    try {
      persist(loaded.record);
    } catch (error) {
      log('device_io_state_save_failed', error);
    }
  }
  controller = new DesktopDeviceController({
    contract,
    initial: loaded.record,
    now: () => new Date(),
    persist,
    onPersistError: (error) => log('device_io_state_save_failed', error),
    onNotification: (notification) => {
      sendToRenderer(notification.channel, notification);
      if (notification.channel === 'desktop.state_changed') updateTray();
    },
  });
  hardenWebContents();
  registerAppProtocol();
  registerIpc();
  registerPowerMonitor();
  tray = createTray();
  updateTray();
  // 起動直後のロック状態は unknown。OS へ問い合わせて確かめる。
  queryLockState();
  mainWindow = createWindow();
}

if (!app.requestSingleInstanceLock()) {
  // 同じ userData の保存を二つのクライアントで書かない。
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // OS の終了要求・メニューの終了もクライアントの終了として扱う（中枢は止めない）。
  app.on('before-quit', () => lifecycle.requestQuit());
  app.on('window-all-closed', () => {
    if (lifecycle.onAllWindowsClosed() === 'quit') app.quit();
  });
  app.on('activate', showWindow);
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      log('start_failed', error);
      app.exit(1);
    });
}
