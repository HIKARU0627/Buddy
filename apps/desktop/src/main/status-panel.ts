// 状態の層のパネル（UI-04、本人の決定 2026-10-22、ADR 0032。ADR 0181 の段階 4 で改めた）。
// 状態の層の窓は、作業領域の右の端の上から下まで（幅 440）のパネルの大きさで作り、普段は隠しておく。上の中央の島の
// 「状態のパネルを出す」（または全体のショートカット）で窓を表示してパネルを出す。Esc・パネルの「しまう」・外へのクリック
// （窓が前面でなくなる）・窓を隠す操作・ショートカットの押し直しで窓を隠してしまう。端のつまみ（UI-04 の 56 × 232）は
// やめた（U392 の暫定 (a)。パネルの置き場所・大きさ・確認の親・しまい方は UI-04 のまま）。
// パネルが出ているかの正本は main（この StatusPanel）。画面（renderer）は窓が表示されているときにパネルを描くだけで、
// 出す・しまうの状態を別に持たない。
// OS の確認ダイアログ（承認・取消・再試行・照合・失効・自宅の登録）は、パネルが出ている間だけ、パネルの窓を親にして出す
// （confirmDialogParent）。確認を出している間は、確認の窓へフォーカスが移っても（blur）パネルをしまわない。
// Electron に依存しない（node:test で試験する）。窓の操作は StatusPanelWindowPort で表し、main.ts が BrowserWindow へ渡す。
// 型だけを読む（window-roles.ts が statusPanelBounds を読むので、値を読み合わない）。
import type { Rect } from './window-roles.js';

// パネルの窓の幅。承認の確認に出す変更の前後の表が読める幅にする。
export const STATUS_PANEL_WIDTH = 440;

// escape: パネルの中の Esc。screen: パネルの「しまう」を押した（画面の要求 desktop.status_panel の open: false）。
// shortcut: 全体のショートカットを押し直した。blur: 外へのクリック・ほかのアプリへの移動（窓が前面でなくなった）。
// hidden: 窓を隠す操作・窓が閉じた。
export type StatusPanelCloseReason =
  'escape' | 'screen' | 'shortcut' | 'blur' | 'hidden';

// 状態の層の窓（パネル）の大きさと位置。作業領域の右の端の上から下まで。作業領域より狭くはしない。
export function statusPanelBounds(workArea: Rect): Rect {
  const width = Math.min(STATUS_PANEL_WIDTH, workArea.width);
  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height: workArea.height,
  };
}

// OS の確認ダイアログの親（UI-04 で決めた。ADR 0032）。
// - 従来の窓の組み立て: 従来の窓（今までどおり）。
// - 3 つの窓の組み立て: パネルが出ている間は状態の層の窓（パネル）。macOS はパネルに付くシート、Windows はパネルが
//   持ち主のモーダル。ロック・停止・窓を隠す操作で閉じる仕組み（AbortSignal）は従来の窓と同じ経路を通る。
//   パネルが出ていない（窓を隠している）なら確認を出さず、送らない（確認の入口はパネルだけ。島からは出さない）。
export function confirmDialogParent(
  mode: 'legacy' | 'canvas',
  panelOpen: boolean,
): 'legacy' | 'status' | null {
  if (mode === 'legacy') return 'legacy';
  return panelOpen ? 'status' : null;
}

// 状態の層の窓の操作（Electron のアダプターが BrowserWindow で実装する）。
export interface StatusPanelWindowPort {
  // 窓の大きさと位置を変える（出すたびに今の作業領域に合わせる）。
  setBounds(bounds: Rect): void;
  isVisible(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
}

export interface StatusPanelOptions {
  // 状態の層の窓（なければ null。従来の窓の組み立て・閉じた後）。
  readonly window: () => StatusPanelWindowPort | null;
  // 主の画面の作業領域。
  readonly workArea: () => Rect;
  // パネルをしまうとき、表示している本人の確認（OS の確認ダイアログ）を閉じて送らない。
  readonly closeConfirm: () => void;
  // 全体のショートカットで出すとき、ほかのアプリが前面にあっても Buddy を前面にする（macOS の app.focus({ steal: true })）。
  readonly activateApp?: () => void;
  readonly log: (code: string) => void;
}

// screen: 島の「状態のパネルを出す」（画面の要求 desktop.status_panel の open: true）。shortcut: 全体のショートカット。
export type StatusPanelOpenSource = 'screen' | 'shortcut';

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

  // 画面の要求（desktop.status_panel。島の「状態のパネルを出す」・パネルの「しまう」）。
  request(open: boolean): 'expand' | 'collapse' | 'none' {
    return open ? this.show('screen') : this.hide('screen');
  }

  // 全体のショートカット: 出ていればしまい、しまっていれば出す。
  toggle(): 'expand' | 'collapse' | 'none' {
    return this.#open ? this.hide('shortcut') : this.show('shortcut');
  }

  show(source: StatusPanelOpenSource): 'expand' | 'none' {
    const window = this.#options.window();
    if (window === null) {
      this.#options.log('status_panel_unavailable');
      return 'none';
    }
    // 出ていても、隠れていれば表示し直してフォーカスを戻す（ショートカットで呼び直したとき）。
    // 窓の大きさは一度に変える（窓を表示する前に置き直すので、窓の動きは付けない。中身は画面が少しだけ滑り込ませ、
    // 動きを減らす設定では付けない）。
    const expand = !this.#open;
    this.#open = true;
    if (expand) window.setBounds(statusPanelBounds(this.#options.workArea()));
    if (!window.isVisible()) window.show();
    // ショートカットはほかのアプリが前面のときに押される。Buddy を前面にしてから窓にフォーカスを渡す（Esc を受けるため）。
    if (source === 'shortcut') this.#options.activateApp?.();
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
    if (window !== null && window.isVisible()) window.hide();
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

  // 状態の層の窓が閉じた・作り直した。窓は隠して作るので、状態もしまった状態に戻す。
  reset(): void {
    this.#open = false;
    this.#confirming = 0;
  }
}

// パネルを親にした確認を出さなかった（パネルが出ていない・既に閉じられた）。core-link は screen_operation_required にする
// （本人が「やめる」を選んだのではないので confirmation_declined にしない）。
export const CONFIRM_NOT_SHOWN = 'not_shown';

export interface PanelConfirmPorts {
  // 親付きの OS の確認ダイアログを出し、押したボタンの番号を返す（main は dialog.showMessageBox を渡すだけ）。
  readonly showDialog: () => Promise<{ readonly response: number }>;
  // 確認が終わった時点で、状態の層の窓が前面にあるか。
  readonly windowFocused: () => boolean;
  // 確認の後の前面の確かめを、フォーカスの移動が落ち着いてから行う（main は短い時間の後に呼ぶ）。
  readonly defer: (task: () => void) => void;
}

// パネルを親にした確認の手順（3 つの窓の組み立て）。Electron に依存しない。
// - パネルが出ていない・既に閉じられた（signal）なら確認を出さない（CONFIRM_NOT_SHOWN）。
// - 確認を出している間は、確認へフォーカスが移った blur でパネルをしまわない（beginConfirm〜endConfirm。例外でも終える）。
// - 「承認する」（番号 1）を選び、閉じられておらず、パネルが出たままのときだけ true。
// - 確認の間にほかのアプリへ移っていたら（確認が終わった時点で窓が前面でない）、パネルをしまう。しまうのは結果を
//   返した後（承認の確定を、フォーカスの移動の途中の状態で取り消さない）。
export async function runPanelConfirm(
  panel: StatusPanel,
  signal: AbortSignal,
  ports: PanelConfirmPorts,
): Promise<boolean | typeof CONFIRM_NOT_SHOWN> {
  if (signal.aborted || !panel.beginConfirm()) return CONFIRM_NOT_SHOWN;
  let response: number;
  try {
    response = (await ports.showDialog()).response;
  } finally {
    panel.endConfirm();
  }
  const confirmed = !signal.aborted && panel.open && response === 1;
  ports.defer(() => {
    if (panel.open && !panel.confirming && !ports.windowFocused())
      panel.hide('blur');
  });
  return confirmed;
}
