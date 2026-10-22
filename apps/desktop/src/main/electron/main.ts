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
  ipcMain,
  nativeImage,
  powerMonitor,
  protocol,
  safeStorage,
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
let link: DesktopCoreLink | null = null;
let contractRef: ReturnType<typeof createDesktopContract> | null = null;
// 画面の読み込みが終わるまでの通知は送らず、読み込み後に記録をまとめて送る。
let rendererReady = false;

// ログは理由のコードだけ（トークン・宛先・指紋の値・自宅の指紋を出さない）。例外の本文も出さない。
const log = (code: string) => console.error(`[buddy-desktop] ${code}`);

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
  } catch {
    // 取得できなければ unknown のまま（解除済みと扱わない）。
    log('lock_query_failed');
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
  // 隠れた・最小化された（前面でなくなった）ら、表示している本人の確認（承認・失効・自宅の登録）を閉じて送らない。
  window.on('hide', () => link?.closeConfirm());
  window.on('minimize', () => link?.closeConfirm());
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
      const sender = {
        trustedSender: isTrustedSender(senderFacts(event)),
        windowFocused: windowFocused(),
      };
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
    onChange: pushConnection,
    log,
    confirmAdmin: confirmAdminWithDialog,
  });
}

// 承認・拒否・失効の前の本人の確認（本人の判断 2026-10-22、ADR 0026）。親付きのモーダルな OS の確認ダイアログで、
// 「やめる」を既定・取り消しにする。ロック・切断で signal が閉じられたら閉じる。ウィンドウがなければ確認できないので送らない。
async function confirmAdminWithDialog(
  request: AdminConfirmRequest,
  signal: AbortSignal,
): Promise<boolean> {
  const window = mainWindow;
  if (window === null || window.isDestroyed() || signal.aborted) return false;
  const text = adminConfirmText(request);
  const result = await dialog.showMessageBox(window, {
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
  });
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
          link.setLockState(controller.state.lockState);
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
  mainWindow = createWindow();
}

if (!app.requestSingleInstanceLock()) {
  // 同じ userData の保存を二つのクライアントで書かない。
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // OS の終了要求・メニューの終了もクライアントの終了として扱う（中枢は止めない）。
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
