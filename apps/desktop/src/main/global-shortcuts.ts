// 全体のショートカット（UI-02・UI-04、ADR 0032）。Electron に依存しない（node:test で試験する）。
// - 全体の停止（UI-04）: どこからでも 1 回でこの端末の入出力を止める。トレイの「入出力を停止」と同じ処理
//   （DesktopDeviceController.stopFromMain）を呼ぶ。パネルの停止（desktop.io_stop）も同じ状態の遷移（io_stop）を通る。
// - 状態の層のパネル（UI-04）: パネルを出す・しまう。
// - キャンバスを呼ぶ（UI-02）: CANVAS_SUMMON_ACCELERATOR。
// 既定値は、IME・入力ソースの切り替えと OS の決まったショートカット（RESERVED_ACCELERATORS）を避け、修飾キーを 3 つ
// （⌘⌥⇧ / Ctrl+Alt+Shift）と英字 1 つにする。ほかのアプリが使っていて登録できなければ、ログを出してほかの入口
// （トレイ・つまみ・パネル）で続ける。設定で変えられるようにするのは後の Issue。
import { CANVAS_SUMMON_ACCELERATOR } from './canvas-presence.js';
import type { TrayMenuItem } from './window-policy.js';

export const STOP_ACCELERATOR = 'CommandOrControl+Alt+Shift+X';
export const STATUS_PANEL_ACCELERATOR = 'CommandOrControl+Alt+Shift+P';

export type GlobalShortcutId = 'stop' | 'status_panel' | 'canvas';

export interface GlobalShortcut {
  readonly id: GlobalShortcutId;
  readonly accelerator: string;
  // 登録できなかったときのログ（理由のコードだけ）。
  readonly unavailableLog: string;
}

// 登録の順。停止を最初に登録する（ほかと重なったときに停止を優先して取る）。
export const GLOBAL_SHORTCUTS: readonly GlobalShortcut[] = [
  {
    id: 'stop',
    accelerator: STOP_ACCELERATOR,
    unavailableLog: 'stop_shortcut_unavailable',
  },
  {
    id: 'status_panel',
    accelerator: STATUS_PANEL_ACCELERATOR,
    unavailableLog: 'status_panel_shortcut_unavailable',
  },
  {
    id: 'canvas',
    accelerator: CANVAS_SUMMON_ACCELERATOR,
    unavailableLog: 'canvas_shortcut_unavailable',
  },
];

// 組み立てごとに登録するショートカット。全体の停止は安全に関わるので、既定の従来の窓（配布版を含む）でも登録する
// （本人の判断 2026-10-23、UI-04 のレビュー）。パネルとキャンバスは 3 つの窓の組み立てのときだけ。
export function shortcutsForMode(
  mode: 'legacy' | 'canvas',
): readonly GlobalShortcut[] {
  return mode === 'canvas'
    ? GLOBAL_SHORTCUTS
    : GLOBAL_SHORTCUTS.filter((shortcut) => shortcut.id === 'stop');
}

// 全体のショートカットを登録の順（停止が先）に登録する。登録できない（false）・例外のときはログを出して次へ進む。
// 戻り値は登録できなかったものの ID（停止を登録できなければ、トレイと画面に印を出す）。main は Electron の
// globalShortcut.register を渡すだけ。
export function registerGlobalShortcuts(
  shortcuts: readonly GlobalShortcut[],
  register: (accelerator: string, callback: () => void) => boolean,
  run: Readonly<Record<GlobalShortcutId, () => void>>,
  log: (code: string) => void,
): readonly GlobalShortcutId[] {
  const failed: GlobalShortcutId[] = [];
  for (const shortcut of shortcuts) {
    let ok: boolean;
    try {
      ok = register(shortcut.accelerator, run[shortcut.id]);
    } catch {
      ok = false;
    }
    if (!ok) {
      log(shortcut.unavailableLog);
      failed.push(shortcut.id);
    }
  }
  return failed;
}

// 全体の停止のショートカットを登録できたか。登録できなければ、トレイの停止の項目と画面の停止のボタンの近くに印を出す
// （説明文に頼らない。UI-04 のレビュー P3-d）。画面へは窓を作るときの引数で渡す（表示だけに使い、受付には使わない）。
export type StopShortcutState = 'registered' | 'unavailable';
export const STOP_SHORTCUT_ARG = '--buddy-stop-shortcut=';

export function stopShortcutState(
  failed: readonly GlobalShortcutId[],
): StopShortcutState {
  return failed.includes('stop') ? 'unavailable' : 'registered';
}

export interface TrayMenuEntry extends TrayMenuItem {
  // メニューの右に出すショートカット（表示だけ。登録は globalShortcut が持つ）。なければ null。
  readonly accelerator: string | null;
}

// トレイのメニュー。停止の項目に、登録できた停止のショートカットを出す。登録できなければショートカットを出さず、
// 項目に ⚠ の印を付ける。
export function trayMenuEntries(
  items: readonly TrayMenuItem[],
  stop: StopShortcutState,
): readonly TrayMenuEntry[] {
  return items.map((item) =>
    item.action !== 'io_stop'
      ? { ...item, accelerator: null }
      : stop === 'registered'
        ? { ...item, accelerator: STOP_ACCELERATOR }
        : { ...item, label: `⚠ ${item.label}`, accelerator: null },
  );
}

const MODIFIER_ORDER = ['Alt', 'Command', 'Control', 'Shift', 'Super'];

// Electron の accelerator を、OS ごとの比べられる形（修飾キーを決まった順に並べ、最後にキー）にする。
// CommandOrControl は macOS で Command、それ以外で Control。Option は Alt、Cmd は Command、Ctrl は Control、
// Meta・Win は Super として扱う。
export function normalizeAccelerator(
  accelerator: string,
  platform: string,
): string {
  const parts = accelerator.split('+');
  const key = parts.at(-1) ?? '';
  const modifiers = parts.slice(0, -1).map((part) => {
    if (part === 'CommandOrControl' || part === 'CmdOrCtrl')
      return platform === 'darwin' ? 'Command' : 'Control';
    if (part === 'Option') return 'Alt';
    if (part === 'Cmd') return 'Command';
    if (part === 'Ctrl') return 'Control';
    if (part === 'Meta' || part === 'Win') return 'Super';
    return part;
  });
  const sorted = [...new Set(modifiers)].sort(
    (a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b),
  );
  return [...sorted, key.length === 1 ? key.toUpperCase() : key].join('+');
}

// 既定値で避ける組み合わせ（手で書いた一覧。網羅ではない）。全体のショートカットはほかのアプリから組み合わせを
// 奪うので、IME・入力ソースの切り替えと、取り違えると困る OS の操作を避ける。
export const RESERVED_ACCELERATORS: Readonly<
  Record<'darwin' | 'win32', readonly string[]>
> = {
  darwin: [
    // 入力ソースの切り替え（⌃Space・⌃⌥Space）と Spotlight（⌘Space・⌘⌥Space）。
    'Control+Space',
    'Alt+Control+Space',
    'Command+Space',
    'Alt+Command+Space',
    // 強制終了（⌘⌥Esc）・前面のアプリを強制終了（⌘⌥⇧Esc を押し続ける）。
    'Alt+Command+Escape',
    'Alt+Command+Shift+Escape',
    // ログアウト（⌘⇧Q・確認なしの ⌘⌥⇧Q）・画面のロック（⌃⌘Q）。
    'Command+Shift+Q',
    'Alt+Command+Shift+Q',
    'Command+Control+Q',
    // スクリーンショット。
    'Command+Shift+3',
    'Command+Shift+4',
    'Command+Shift+5',
    // 確認なしでゴミ箱を空にする（Finder）・スタイルを合わせて貼り付け・別名で保存（よく使うアプリ）。
    'Alt+Command+Shift+Backspace',
    'Alt+Command+Shift+V',
    'Alt+Command+Shift+S',
  ],
  win32: [
    // IME・入力の言語の切り替え（Win+Space・Shift+Space・Ctrl+Space・Alt+`）。
    'Super+Space',
    'Shift+Space',
    'Control+Space',
    'Alt+`',
    // タスク マネージャー・セキュリティの画面・ロック・窓を閉じる。
    'Control+Shift+Escape',
    'Alt+Control+Delete',
    'Super+L',
    'Alt+F4',
    // スタイルを合わせて貼り付け・別名で保存（よく使うアプリ）。
    'Alt+Control+Shift+V',
    'Alt+Control+Shift+S',
  ],
};
