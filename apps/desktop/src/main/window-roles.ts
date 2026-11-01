// 窓の役割の基盤（UI-02、ADR 0032・0014・0015）。キャンバス・状態の層・入力バーの 3 つの窓と、従来の 1 つの窓。
// main は、送信元の webContents と窓の役割の対応（UiWindowRegistry）を持ち、送信元の検査（isTrustedSender）に
// 役割の検査（DESKTOP_ROLE_CHANNELS）を足して受付を絞る。通知も役割ごとの表（DESKTOP_ROLE_NOTIFICATIONS）に
// 合う窓にだけ送る。役割の正本は main の対応表で、preload に渡す引数（--buddy-window-role）は画面の切り替えと
// preload の多重の防御のためだけに使う（画面・preload の申告で受付を広げない）。
// Electron に依存しない（node:test で試験する）。
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_NOTIFICATION_CHANNELS,
  DESKTOP_ROLE_NOTIFICATIONS,
  desktopChannelAllowedForRole,
  type DesktopIpcSender,
  type DesktopWindowRole,
} from '@buddy/domain';
import { isTrustedSender, type SenderFacts } from './window-policy.js';

// 従来の窓（legacy）は、今の 1 つの窓（B03・B04 の画面）。今と同じく全チャネル・全通知を使う。
// ただし UI-02 で足したキャンバスを前に出すチャネル、UI-04 で足した状態の層のパネルのチャネル、UI-06 で足したキャンバスの
// ユーザーの操作のチャネルは使わない（従来の窓の組み立てにはキャンバスも状態の層もない）。
export type UiWindowRole = DesktopWindowRole | 'legacy';

const LEGACY_EXCLUDED_CHANNELS: readonly string[] = [
  'desktop.canvas_summon',
  'desktop.status_panel',
  'desktop.canvas_user_op',
  'desktop.canvas_content',
  // 予算の確認（B07-05）は状態の層だけ。従来の窓には予算の画面がない。
  'desktop.budget_overage_decide',
  'desktop.budget_overrun_review',
  'desktop.budget_manual_settle',
  // 音声の状態・「続ける」・同意の取り消し（B05-06）は状態の層だけ。従来の窓には音声の画面がない（音声レンダラーも作らない）。
  'desktop.get_voice',
  'desktop.voice_continue',
  'desktop.voice_consent_revoke',
  'desktop.voice_control',
];

// 窓の組み立て方。既定は従来の 1 つの窓。canvas は 3 つの役割の窓（試作）。
export type UiWindowMode = 'legacy' | 'canvas';

// 開発用のフラグ（コマンドラインの --buddy-ui=canvas、または環境変数 BUDDY_DESKTOP_UI=canvas）。
// 開発の起動（app.isPackaged が false）のときだけ受ける。配布版では両方を無視して従来の窓にする。
export const UI_MODE_FLAG = '--buddy-ui=';
export const UI_MODE_ENV = 'BUDDY_DESKTOP_UI';
// preload へ窓の役割を渡す引数（webPreferences.additionalArguments）。
export const WINDOW_ROLE_ARG = '--buddy-window-role=';

type NotificationChannel = (typeof DESKTOP_NOTIFICATION_CHANNELS)[number];

// 窓の組み立て方を決める。配布版（packaged）は必ず従来の窓。開発の起動ではフラグが環境変数より優先。
// 知らない値は従来の窓（既定を変えない）。
export function uiWindowMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  launch: { readonly packaged: boolean },
): UiWindowMode {
  if (launch.packaged) return 'legacy';
  const flagged = argv
    .filter((arg) => arg.startsWith(UI_MODE_FLAG))
    .map((arg) => arg.slice(UI_MODE_FLAG.length))
    .at(-1);
  const value = flagged ?? env[UI_MODE_ENV];
  return value === 'canvas' ? 'canvas' : 'legacy';
}

// 作る窓の順番。キャンバスを先に作り、状態の層・入力バーをその前に重ねる。
export function rolesForMode(mode: UiWindowMode): readonly UiWindowRole[] {
  return mode === 'canvas' ? ['canvas', 'status', 'input'] : ['legacy'];
}

// 送信元の窓の役割がそのチャネルを使えるか。役割が分からない（対応表にない・閉じた）窓は何も使えない。
export function channelAllowedForWindow(
  role: UiWindowRole | null,
  channel: string,
): boolean {
  if (role === null) return false;
  if (role === 'legacy')
    return (
      (DESKTOP_IPC_CHANNELS as readonly string[]).includes(channel) &&
      !LEGACY_EXCLUDED_CHANNELS.includes(channel)
    );
  return desktopChannelAllowedForRole(role, channel);
}

// キャンバスの窓が状態を取った後に、キャンバスの記述を送り直すか。キャンバスの窓は購読を始めてから状態を取るので、
// その取得を「通知を受け取る準備ができた」合図にする（UI-03。読み込みの通知を購読の前に取り逃した画面を救う）。
export function canvasResendAfter(
  role: UiWindowRole | null,
  channel: string,
): boolean {
  return role === 'canvas' && channel === 'desktop.get_state';
}

// その窓へ通知を送ってよいか。
export function notificationAllowedForWindow(
  role: UiWindowRole,
  channel: string,
): boolean {
  // 従来の窓はキャンバスの記述（UI-03）と作業領域の外の幅（UI-06）を受けない（キャンバスの窓だけ）。
  // 音声の状態（B05-06）も受けない（状態の層だけ）。
  if (role === 'legacy')
    return (
      (DESKTOP_NOTIFICATION_CHANNELS as readonly string[]).includes(channel) &&
      channel !== 'desktop.canvas_changed' &&
      channel !== 'desktop.canvas_work_area' &&
      channel !== 'desktop.voice_changed'
    );
  return (DESKTOP_ROLE_NOTIFICATIONS[role] as readonly string[]).includes(
    channel,
  );
}

// IPC の送信元のフレーム（Electron の WebFrameMain の一部）。破棄されたフレームは null（Electron の仕様）。
export interface SenderFrameLike {
  readonly parent: unknown;
  readonly processId: number;
  readonly routingId: number;
  readonly url: string;
}

// main が作った窓（対応表で引いた窓。破棄済みなら null）の webContents の ID と主フレーム。
export interface UiContentsLike {
  readonly webContentsId: number;
  readonly mainFrame: {
    readonly processId: number;
    readonly routingId: number;
  };
}

// 送信元の事実を組み立てる。送信元のフレームが、対応表で引いた窓の主フレーム（親がなく、processId と routingId が
// 今の主フレームと同じ）のときだけ senderIsMainFrame。子フレーム・古いフレーム・破棄されたフレーム・破棄された窓は false。
export function senderFactsOf(
  senderWebContentsId: number,
  frame: SenderFrameLike | null,
  ui: UiContentsLike | null,
): SenderFacts {
  return {
    senderWebContentsId,
    uiWebContentsId: ui === null ? null : ui.webContentsId,
    senderIsMainFrame:
      frame !== null &&
      ui !== null &&
      frame.parent === null &&
      frame.processId === ui.mainFrame.processId &&
      frame.routingId === ui.mainFrame.routingId,
    senderFrameUrl: frame === null ? null : frame.url,
  };
}

// 受付（admitDesktopRequest）に渡す送信元の事実。送信元の検査に役割の検査を足し、どちらかに合わなければ
// 信頼しない送信元（untrusted_sender）として拒否させる（拒否の理由は増やさない。ADR 0032 の 0014 の改め）。
export function windowSender(input: {
  readonly channel: string;
  readonly role: UiWindowRole | null;
  readonly facts: SenderFacts;
  readonly focused: boolean;
}): DesktopIpcSender {
  return {
    trustedSender:
      isTrustedSender(input.facts) &&
      channelAllowedForWindow(input.role, input.channel),
    windowFocused: input.focused,
  };
}

export interface UiWindowEntry<W> {
  readonly webContentsId: number;
  readonly role: UiWindowRole;
  readonly window: W;
  // 画面の読み込みが終わっている（通知を送ってよい）。
  readonly ready: boolean;
}

// main が作った窓の webContents と役割の対応。窓を閉じたら外す（閉じた窓の ID からの要求は役割が分からず拒否）。
export class UiWindowRegistry<W> {
  readonly #entries = new Map<number, UiWindowEntry<W>>();

  register(webContentsId: number, role: UiWindowRole, window: W): void {
    if (this.#entries.has(webContentsId))
      throw new Error('window_already_registered');
    for (const entry of this.#entries.values())
      if (entry.role === role) throw new Error('window_role_taken');
    this.#entries.set(webContentsId, {
      webContentsId,
      role,
      window,
      ready: false,
    });
  }

  unregister(webContentsId: number): void {
    this.#entries.delete(webContentsId);
  }

  setReady(webContentsId: number, ready: boolean): void {
    const entry = this.#entries.get(webContentsId);
    if (entry !== undefined)
      this.#entries.set(webContentsId, { ...entry, ready });
  }

  lookup(webContentsId: number): UiWindowEntry<W> | null {
    return this.#entries.get(webContentsId) ?? null;
  }

  byRole(role: UiWindowRole): UiWindowEntry<W> | null {
    for (const entry of this.#entries.values())
      if (entry.role === role) return entry;
    return null;
  }

  entries(): readonly UiWindowEntry<W>[] {
    return [...this.#entries.values()];
  }

  // 通知を送る先。読み込みが終わり、役割の表に通知がある窓だけ。
  notificationTargets(
    channel: NotificationChannel | string,
  ): readonly UiWindowEntry<W>[] {
    return this.entries().filter(
      (entry) =>
        entry.ready && notificationAllowedForWindow(entry.role, channel),
    );
  }
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayGeometry {
  // 画面全体と、メニューバー・Dock・タスクバーを除いた作業領域。
  readonly bounds: Rect;
  readonly workArea: Rect;
}

// 3 つの窓とも同じ webPreferences（sandbox・contextIsolation・同じ preload）。違いは役割の引数だけ。
export interface UiWebPreferences {
  readonly preload: string;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly experimentalFeatures: false;
  readonly webviewTag: false;
  readonly spellcheck: false;
  readonly additionalArguments: readonly string[];
}

// BrowserWindow に渡す値（Electron の BrowserWindowConstructorOptions の一部と同じ形）。
export interface UiWindowOptions {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly show: false;
  readonly title: string;
  readonly autoHideMenuBar?: boolean;
  readonly type?: 'desktop' | 'panel';
  readonly focusable?: boolean;
  readonly frame?: boolean;
  readonly resizable?: boolean;
  readonly movable?: boolean;
  readonly minimizable?: boolean;
  readonly maximizable?: boolean;
  readonly fullscreenable?: boolean;
  readonly skipTaskbar?: boolean;
  readonly alwaysOnTop?: boolean;
  readonly hasShadow?: boolean;
  readonly roundedCorners?: boolean;
  readonly thickFrame?: boolean;
  readonly enableLargerThanScreen?: boolean;
  readonly webPreferences: UiWebPreferences;
}

export interface UiWindowSpec {
  readonly role: UiWindowRole;
  readonly options: UiWindowOptions;
  // 画面共有・スクリーンショットから中身を守る（setContentProtection）。
  readonly contentProtection: boolean;
  // すべてのデスクトップ（Spaces）に出す（setVisibleOnAllWorkspaces）。null なら呼ばない。
  readonly allWorkspaces: { readonly visibleOnFullScreen: boolean } | null;
  // 常に最前面にする段（setAlwaysOnTop）。null なら呼ばない。
  readonly alwaysOnTopLevel: 'floating' | null;
  // 作った後に最大化する（Windows のキャンバス）。
  readonly maximize: boolean;
  // 表示のときに前面に出してキー入力を受ける（入力バーと従来の窓）。それ以外は前面を奪わずに出す。
  readonly focusOnShow: boolean;
}

// 端のつまみ（UI-04 で、プライバシーと権限の専用の記号 3 つの分だけ高くした）。パネルを出したときの大きさは
// status-panel.ts の statusWindowBounds。
export const STATUS_TAB_SIZE = { width: 56, height: 232 } as const;
export const INPUT_BAR_SIZE = { width: 560, height: 56 } as const;
// 入力バーと作業領域の下端の間。
export const INPUT_BAR_MARGIN = 16;

function webPreferences(preload: string, role: UiWindowRole): UiWebPreferences {
  return {
    preload,
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
    additionalArguments: [`${WINDOW_ROLE_ARG}${role}`],
  };
}

// 小さな窓（状態の層・入力バー）に共通の値。枠なし・大きさと位置は固定・タスクバーに出さない・常に最前面。
// macOS はパネル型（NSPanel。全画面のアプリの上にも出せる）。
function smallWindowBase(platform: string) {
  return {
    ...(platform === 'darwin' ? { type: 'panel' as const } : {}),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
  };
}

// 役割ごとの窓の作り方。platform は process.platform、display は主の画面。
export function uiWindowSpec(
  role: UiWindowRole,
  platform: string,
  display: DisplayGeometry,
  preload: string,
): UiWindowSpec {
  const prefs = webPreferences(preload, role);
  switch (role) {
    case 'legacy':
      // 今の 1 つの窓と同じ値。
      return {
        role,
        options: {
          width: 960,
          height: 680,
          minWidth: 480,
          minHeight: 360,
          show: false,
          title: 'Buddy',
          autoHideMenuBar: true,
          webPreferences: prefs,
        },
        contentProtection: false,
        allWorkspaces: null,
        alwaysOnTopLevel: null,
        maximize: false,
        focusOnShow: true,
      };
    case 'canvas': {
      const common = {
        show: false as const,
        title: 'Buddy',
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        // どの OS でも、後ろにある間はキー入力を受けない。呼んだときだけ受けるようにする（canvas-presence.ts）。
        focusable: false,
        webPreferences: prefs,
      };
      if (platform === 'darwin')
        // デスクトップの層（アイコンの層の近く）に置き、画面全体（メニューバーの下を含む）を覆う。
        return {
          role,
          options: {
            ...common,
            type: 'desktop',
            ...display.bounds,
            roundedCorners: false,
            enableLargerThanScreen: true,
          },
          contentProtection: true,
          allWorkspaces: { visibleOnFullScreen: false },
          alwaysOnTopLevel: null,
          maximize: false,
          focusOnShow: false,
        };
      // Windows（とその他）は、枠なしで作業領域に最大化し、タスクバーに出さない。
      return {
        role,
        options: {
          ...common,
          ...display.workArea,
          resizable: true,
          maximizable: true,
          thickFrame: false,
        },
        contentProtection: true,
        allWorkspaces: null,
        alwaysOnTopLevel: null,
        maximize: true,
        focusOnShow: false,
      };
    }
    case 'status': {
      const area = display.workArea;
      // 作業領域の右の端の中ほどに置くつまみ。
      return {
        role,
        options: {
          ...smallWindowBase(platform),
          show: false,
          title: 'Buddy',
          x: area.x + area.width - STATUS_TAB_SIZE.width,
          y: area.y + Math.round((area.height - STATUS_TAB_SIZE.height) / 2),
          ...STATUS_TAB_SIZE,
          webPreferences: prefs,
        },
        contentProtection: true,
        allWorkspaces: { visibleOnFullScreen: true },
        alwaysOnTopLevel: 'floating',
        maximize: false,
        focusOnShow: false,
      };
    }
    case 'input': {
      const area = display.workArea;
      // 作業領域の下の中ほどに置く帯。
      return {
        role,
        options: {
          ...smallWindowBase(platform),
          show: false,
          title: 'Buddy',
          x: area.x + Math.round((area.width - INPUT_BAR_SIZE.width) / 2),
          y: area.y + area.height - INPUT_BAR_SIZE.height - INPUT_BAR_MARGIN,
          ...INPUT_BAR_SIZE,
          webPreferences: prefs,
        },
        contentProtection: false,
        allWorkspaces: { visibleOnFullScreen: true },
        alwaysOnTopLevel: 'floating',
        maximize: false,
        focusOnShow: true,
      };
    }
  }
}
