// キャンバスを前に出す・後ろへ戻す（UI-02、本人の判断 2026-10-22、ADR 0032）。
// キャンバスは普段はデスクトップの層に置き、アプリの後ろで見るだけにする。本人が呼ぶ（全体のショートカット・端のつまみ・
// 入力バー）と前に出て、クリック・キー入力を受ける。Esc・ほかのアプリへの移動（キャンバスが前面でなくなる）・ロック・
// 窓を隠す操作で後ろへ戻る。ロック中・ロック状態が不明のときは呼ばない（キャンバスの中身を出さない）。
// この状態の正本は main。Electron に依存しない（node:test で試験する）。窓の操作は canvasLayerOps の列で表し、
// Electron のアダプター（main.ts）がそのとおりに BrowserWindow を操作する。
import type { DesktopIoState } from '@buddy/domain';

export type CanvasLayer = 'behind' | 'front';
export type CanvasSummonSource = 'shortcut' | 'status' | 'input';
export type CanvasDismissReason = 'escape' | 'blur' | 'lock' | 'hidden';

export type CanvasSummonResult =
  // raise: 前に出す。none: 既に前にある（二重に呼んでも何もしない）。
  | { readonly ok: true; readonly effect: 'raise' | 'none' }
  // device_locked: ロック中・不明。canvas_unavailable: キャンバスの窓がない（従来の窓の組み立て・閉じた後）。
  | {
      readonly ok: false;
      readonly reason: 'device_locked' | 'canvas_unavailable';
    };

// 全体のショートカットの既定値。IME の切り替え（macOS の ⌃Space・⌃⌥Space・⌘Space、Windows の Win+Space・
// Alt+Shift・Ctrl+Shift・Shift+Space）と、よく使うアプリの既定（⌘⇧B など）を避けて、修飾キーを 3 つ使う。
export const CANVAS_SUMMON_ACCELERATOR = 'CommandOrControl+Alt+Shift+B';

export class CanvasPresence {
  #layer: CanvasLayer = 'behind';
  #lastSource: CanvasSummonSource | null = null;
  #lastDismissReason: CanvasDismissReason | null = null;

  get layer(): CanvasLayer {
    return this.#layer;
  }

  // 最後に前に出した呼び方（記録用）。後ろへ戻すと null。
  get lastSource(): CanvasSummonSource | null {
    return this.#lastSource;
  }

  summon(
    source: CanvasSummonSource,
    context: {
      readonly lockState: DesktopIoState['lockState'];
      readonly canvasAvailable: boolean;
    },
  ): CanvasSummonResult {
    if (context.lockState !== 'unlocked')
      return { ok: false, reason: 'device_locked' };
    if (!context.canvasAvailable)
      return { ok: false, reason: 'canvas_unavailable' };
    if (this.#layer === 'front') return { ok: true, effect: 'none' };
    this.#layer = 'front';
    this.#lastSource = source;
    this.#lastDismissReason = null;
    return { ok: true, effect: 'raise' };
  }

  // 最後に後ろへ戻した理由（記録用）。前に出すと null。
  get lastDismissReason(): CanvasDismissReason | null {
    return this.#lastDismissReason;
  }

  // 後ろへ戻す。前にあったときだけ lower。
  dismiss(reason: CanvasDismissReason): 'lower' | 'none' {
    if (this.#layer === 'behind') return 'none';
    this.#layer = 'behind';
    this.#lastSource = null;
    this.#lastDismissReason = reason;
    return 'lower';
  }

  // ロック状態が変わった。解除済みでなくなったら後ろへ戻す（中身を出したままにしない）。
  lockChanged(lockState: DesktopIoState['lockState']): 'lower' | 'none' {
    return lockState === 'unlocked' ? 'none' : this.dismiss('lock');
  }

  // キャンバスの窓が閉じた・作り直した。窓は後ろの状態で作るので、状態も後ろに戻す。
  reset(): void {
    this.#layer = 'behind';
    this.#lastSource = null;
    this.#lastDismissReason = null;
  }
}

// キャンバスの窓のキー入力のうち、後ろへ戻す Esc か。IME の変換中の Esc は変換の取り消しで、ここへは来ない
// （試作の実機の確認: 変換中の Esc は before-input-event に届かなかった）。修飾キー付きは戻さない。
export function isDismissKey(input: {
  readonly type: string;
  readonly key: string;
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}): boolean {
  return (
    input.type === 'keyDown' &&
    input.key === 'Escape' &&
    !input.alt &&
    !input.control &&
    !input.meta &&
    !input.shift
  );
}

export type CanvasLayerOp =
  // キー入力を受けるか（BrowserWindow.setFocusable）。
  | { readonly op: 'set_focusable'; readonly value: boolean }
  // macOS の窓の段。normal: 通常の窓の段（setAlwaysOnTop(false)）。desktop: デスクトップの段に戻す。
  | { readonly op: 'set_level'; readonly level: 'normal' | 'desktop' }
  | { readonly op: 'show_focus' }
  | { readonly op: 'blur' };

// Electron の type: 'desktop' の段（kCGDesktopWindowLevel − 1）を、通常の窓の段からの差で表した値。
// 試作の実機（macOS 27.0.1）で、作ったときの段と、この値で戻したときの段が同じ（−2147483624）ことを確かめた。
export const MAC_DESKTOP_RELATIVE_LEVEL = -2147483624;

// 前に出す・後ろへ戻すときの窓の操作。macOS は段を通常の窓まで上げてキー入力を受けるようにし、戻すときは
// デスクトップの段へ戻してキー入力を受けないようにする。Windows（とその他）は通常の前面にするだけ（未実施）。
export function canvasLayerOps(
  platform: string,
  layer: CanvasLayer,
): readonly CanvasLayerOp[] {
  if (platform === 'darwin')
    return layer === 'front'
      ? [
          { op: 'set_focusable', value: true },
          { op: 'set_level', level: 'normal' },
          { op: 'show_focus' },
        ]
      : [
          { op: 'set_level', level: 'desktop' },
          { op: 'set_focusable', value: false },
          { op: 'blur' },
        ];
  return layer === 'front' ? [{ op: 'show_focus' }] : [{ op: 'blur' }];
}
