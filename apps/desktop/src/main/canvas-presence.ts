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
  // キー入力を受けるか（BrowserWindow.setFocusable。Windows では WS_EX_NOACTIVATE の切り替え）。
  | { readonly op: 'set_focusable'; readonly value: boolean }
  // macOS の窓の段。normal: 通常の窓の段（setAlwaysOnTop(false)）。desktop: デスクトップの段に戻す。
  | { readonly op: 'set_level'; readonly level: 'normal' | 'desktop' }
  | { readonly op: 'show_focus' }
  | { readonly op: 'blur' };

// Electron の type: 'desktop' の段（kCGDesktopWindowLevel − 1）を、通常の窓の段からの差で表した値。
// 試作の実機（macOS 27.0.1）で、作ったときの段と、この値で戻したときの段が同じ（−2147483624）ことを確かめた。
export const MAC_DESKTOP_RELATIVE_LEVEL = -2147483624;

// 前に出す・後ろへ戻すときの窓の操作。どの OS でも、後ろにある間はキー入力を受けない（フォーカスを受けない）。
// macOS: 段を通常の窓まで上げてキー入力を受けるようにし、戻すときはデスクトップの段へ戻してキー入力を受けないようにする。
// Windows（とその他）: 段はない。前に出すときにフォーカスを受けるようにして前面にし、戻すときはフォーカスを受けない
// ようにしてから前面を外す。重なりは「次の窓を前面にする」（blur）までで、その後は OS の重なりに任せる。フォーカスを
// 受けない窓はクリックしても前面に来ないので、ほかのアプリを使えばキャンバスはその後ろになる（Windows の実機は未実施）。
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
  return layer === 'front'
    ? [{ op: 'set_focusable', value: true }, { op: 'show_focus' }]
    : [{ op: 'set_focusable', value: false }, { op: 'blur' }];
}

// キャンバスの窓の操作（Electron のアダプターが BrowserWindow で実装する）。
export interface CanvasWindowPort {
  setFocusable(value: boolean): void;
  setLevel(level: 'normal' | 'desktop'): void;
  show(): void;
  focus(): void;
  blur(): void;
}

// 状態の層・入力バーの窓の操作。
export interface CompanionWindowPort {
  isVisible(): boolean;
  // 前面を奪わずに表示する（キャンバスのフォーカスを外さない）。
  showInactive(): void;
}

export interface CanvasSummonerOptions {
  readonly platform: string;
  readonly presence: CanvasPresence;
  // キャンバスの窓（なければ null）。
  readonly canvas: () => CanvasWindowPort | null;
  // 状態の層と入力バー（あるものだけ）。
  readonly companions: () => readonly CompanionWindowPort[];
  readonly lockState: () => DesktopIoState['lockState'];
  readonly log: (code: string) => void;
}

// 呼ぶ・戻すの手順（main の状態 CanvasPresence と窓の操作をつなぐ）。Electron に依存しない。
// 呼ぶときは、隠れている状態の層・入力バーを前面を奪わずに表示し直してから、最後にキャンバスを前に出してフォーカスする
// （小さな窓を後から表示してキャンバスが blur しない順序）。前に出す手順の途中に来た blur では戻さない。
export class CanvasSummoner {
  readonly #options: CanvasSummonerOptions;
  #raising = false;

  constructor(options: CanvasSummonerOptions) {
    this.#options = options;
  }

  summon(source: CanvasSummonSource): CanvasSummonResult {
    const canvas = this.#options.canvas();
    const result = this.#options.presence.summon(source, {
      lockState: this.#options.lockState(),
      canvasAvailable: canvas !== null,
    });
    if (!result.ok) {
      this.#options.log(`canvas_summon_refused:${result.reason}`);
      return result;
    }
    if (canvas === null) return result;
    this.#raising = true;
    try {
      for (const companion of this.#options.companions())
        if (!companion.isVisible()) companion.showInactive();
      if (result.effect === 'raise') this.#apply(canvas, 'front');
      else canvas.focus();
    } finally {
      this.#raising = false;
    }
    return result;
  }

  dismiss(reason: CanvasDismissReason): 'lower' | 'none' {
    // 前に出す手順の途中の blur（小さな窓の表示・前面の切り替えの途中）では戻さない。
    if (reason === 'blur' && this.#raising) return 'none';
    const effect = this.#options.presence.dismiss(reason);
    if (effect === 'lower') {
      const canvas = this.#options.canvas();
      if (canvas !== null) this.#apply(canvas, 'behind');
    }
    return effect;
  }

  lockChanged(lockState: DesktopIoState['lockState']): 'lower' | 'none' {
    return lockState === 'unlocked' ? 'none' : this.dismiss('lock');
  }

  #apply(canvas: CanvasWindowPort, layer: CanvasLayer): void {
    for (const step of canvasLayerOps(this.#options.platform, layer)) {
      if (step.op === 'set_focusable') canvas.setFocusable(step.value);
      else if (step.op === 'set_level') canvas.setLevel(step.level);
      else if (step.op === 'show_focus') {
        canvas.show();
        canvas.focus();
      } else canvas.blur();
    }
  }
}
