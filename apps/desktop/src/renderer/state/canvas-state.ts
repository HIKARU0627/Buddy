// キャンバスの窓が描く記述（UI-03、ADR 0032）の表示の規則。React と DOM に依存しない純粋な関数だけを置き、node:test で
// 試験する。記述は main が形式（Ajv）と意味（domain）を検査して参照を置き換えた DesktopCanvasView で、画面は検査をやり直さず
// 描き方だけを決める。位置と大きさは配置のエンジン（UI-06。state/canvas-layout-state.ts）が決め、ピクセル・座標・色は
// 記述に持たない。
import type { DesktopCanvasView } from '@buddy/contracts';

export type CanvasViewItem = DesktopCanvasView['items'][number];

// 物の強調に応じた枠の色と濃さ。説明文ではなく、枠で「要確認」を伝える（high は accent の枠）。
export function emphasisClass(emphasis: CanvasViewItem['emphasis']): string {
  if (emphasis === 'high') return 'border-2 border-accent';
  if (emphasis === 'low') return 'opacity-70';
  return '';
}
