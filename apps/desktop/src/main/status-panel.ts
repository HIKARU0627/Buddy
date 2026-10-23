// 状態の層のパネル（UI-04、本人の決定 2026-10-22、ADR 0032）。
// 状態の層の窓は、普段は画面の端のつまみ（STATUS_TAB_SIZE）だけの大きさで、つまみを押す（または全体のショートカット）と、
// 同じ窓を画面の端から広げてパネルを出す。Esc・つまみ・外へのクリック（窓が前面でなくなる）・窓を隠す操作でしまう。
// パネルが出ているかの正本は main（この StatusPanel）。画面（renderer）は窓の幅に合わせて描くだけで、出す・しまうの
// 状態を別に持たない（窓の大きさと描く中身がずれない）。
// OS の確認ダイアログ（承認・取消・再試行・照合・失効・自宅の登録）は、パネルが出ている間だけ、パネルの窓を親にして出す
// （confirmDialogParent）。確認を出している間は、確認の窓へフォーカスが移っても（blur）パネルをしまわない。
// Electron に依存しない（node:test で試験する）。窓の操作は StatusPanelWindowPort で表し、main.ts が BrowserWindow へ渡す。
import type { Rect } from './window-roles.js';
import { STATUS_TAB_SIZE } from './window-roles.js';

// パネルを出したときの窓の幅（つまみを含む）。承認の確認に出す変更の前後の表が読める幅にする。
export const STATUS_PANEL_WIDTH = 440;

// escape: パネルの中の Esc。tab: つまみを押し直した。shortcut: 全体のショートカットを押し直した。
// blur: 外へのクリック・ほかのアプリへの移動（窓が前面でなくなった）。hidden: 窓を隠す操作・窓が閉じた。
export type StatusPanelCloseReason =
  'escape' | 'tab' | 'shortcut' | 'blur' | 'hidden';

// 状態の層の窓の大きさと位置。しまっている間は作業領域の右の端の中ほどのつまみ、出している間は作業領域の右の端の
// 上から下までのパネル（つまみはパネルの左の縁の中ほどに残る。画面が同じ位置に描く）。
export function statusWindowBounds(open: boolean, workArea: Rect): Rect {
  if (open)
    return {
      x: workArea.x + workArea.width - STATUS_PANEL_WIDTH,
      y: workArea.y,
      width: STATUS_PANEL_WIDTH,
      height: workArea.height,
    };
  return {
    x: workArea.x + workArea.width - STATUS_TAB_SIZE.width,
    y: workArea.y + Math.round((workArea.height - STATUS_TAB_SIZE.height) / 2),
    width: STATUS_TAB_SIZE.width,
    height: STATUS_TAB_SIZE.height,
  };
}

// OS の確認ダイアログの親（UI-04 で決めた。ADR 0032）。
// - 従来の窓の組み立て: 従来の窓（今までどおり）。
// - 3 つの窓の組み立て: パネルが出ている間は状態の層の窓（パネル）。macOS はパネルに付くシート、Windows はパネルが
//   持ち主のモーダル。ロック・停止・窓を隠す操作で閉じる仕組み（AbortSignal）は従来の窓と同じ経路を通る。
//   パネルが出ていない（つまみだけ）なら確認を出さず、送らない（確認の入口はパネルだけ）。
export function confirmDialogParent(
  mode: 'legacy' | 'canvas',
  panelOpen: boolean,
): 'legacy' | 'status' | null {
  if (mode === 'legacy') return 'legacy';
  return panelOpen ? 'status' : null;
}

// 状態の層の窓の操作（Electron のアダプターが BrowserWindow で実装する）。
export interface StatusPanelWindowPort {
  // 窓の大きさと位置を変える。animate は macOS で動きを付ける（Windows では効かない）。
  setBounds(bounds: Rect, animate: boolean): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
}

export interface StatusPanelOptions {
  // 状態の層の窓（なければ null。従来の窓の組み立て・閉じた後）。
  readonly window: () => StatusPanelWindowPort | null;
  // 主の画面の作業領域。
  readonly workArea: () => Rect;
  // OS の「視差効果を減らす」（動きを減らす）。true なら動きを付けない。
  readonly reducedMotion: () => boolean;
  // パネルをしまうとき、表示している本人の確認（OS の確認ダイアログ）を閉じて送らない。
  readonly closeConfirm: () => void;
  readonly log: (code: string) => void;
}

// 出す・しまうの手順。二重に出しても・しまっても何もしない。確認を出している間の blur ではしまわない。
export class StatusPanel {
  readonly #options: StatusPanelOptions;
  #open = false;
  #confirming = 0;

  constructor(options: StatusPanelOptions) {
    this.#options = options;
  }

  get open(): boolean {
    return this.#open;
  }

  // OS の確認ダイアログを出している（パネルを親にしている）。
  get confirming(): boolean {
    return this.#confirming > 0;
  }

  // つまみの要求（desktop.status_panel）。
  request(open: boolean): 'expand' | 'collapse' | 'none' {
    return open ? this.show() : this.hide('tab');
  }

  // 全体のショートカット: 出ていればしまい、しまっていれば出す。
  toggle(): 'expand' | 'collapse' | 'none' {
    return this.#open ? this.hide('shortcut') : this.show();
  }

  show(): 'expand' | 'none' {
    const window = this.#options.window();
    if (window === null) {
      this.#options.log('status_panel_unavailable');
      return 'none';
    }
    // 出ていても、隠れていれば表示し直してフォーカスを戻す（ショートカットで呼び直したとき）。
    const expand = !this.#open;
    this.#open = true;
    if (expand)
      window.setBounds(
        statusWindowBounds(true, this.#options.workArea()),
        !this.#options.reducedMotion(),
      );
    if (!window.isVisible()) window.show();
    window.focus();
    return expand ? 'expand' : 'none';
  }

  hide(reason: StatusPanelCloseReason): 'collapse' | 'none' {
    if (!this.#open) return 'none';
    // 確認の窓（シート・モーダル）へフォーカスが移った blur ではしまわない。
    if (reason === 'blur' && this.confirming) return 'none';
    this.#open = false;
    // しまう前に確認を閉じる（パネルが確認の親。パネルなしで確認を残さない）。
    this.#options.closeConfirm();
    const window = this.#options.window();
    if (window !== null)
      window.setBounds(
        statusWindowBounds(false, this.#options.workArea()),
        reason !== 'hidden' && !this.#options.reducedMotion(),
      );
    return 'collapse';
  }

  // OS の確認ダイアログを出す前と後。パネルが出ていなければ false（確認を出さない）。
  beginConfirm(): boolean {
    if (!this.#open) return false;
    this.#confirming += 1;
    return true;
  }

  endConfirm(): void {
    if (this.#confirming > 0) this.#confirming -= 1;
  }

  // 状態の層の窓が閉じた・作り直した。窓はつまみの大きさで作るので、状態もしまった状態に戻す。
  reset(): void {
    this.#open = false;
    this.#confirming = 0;
  }
}
