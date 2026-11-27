// 流れの表示先「このPCに出す」の欄（UI-05 の段階 5、ADR 0193。設計 07 §5、ADR 0032・0188）。React と DOM に依存しない
// 純粋な関数だけを置き、node:test で試験する。
// 表示先の正本は中枢（main が状態欄の display_target として渡す）。画面は表示と要求の組み立てだけで、移ったかは状態欄の通知で
// 知る（押した時点では表示を変えない）。端末の ID・表示先の版・会話の ID は画面へ渡さない（main が持つ。UI-01）。
import type { DesktopStatusBar } from '@buddy/contracts';
import { DISPLAY_HANDOFF_LABELS, DISPLAY_TARGET_LABELS } from '../labels.js';
import type { StatusLine } from '../tones.js';

export type DisplayHandoffView =
  | {
      // 出さない（ロック中・不明・受け取る前・中枢に接続していない）。
      readonly kind: 'hidden';
    }
  | {
      readonly kind: 'shown';
      // 今の表示先の記号と文言（色だけに頼らない）。
      readonly line: StatusLine;
      // 「このPCに出す」を押せるか。表示先がこの端末のときは出さず、この端末の入出力が止まっている間は押せない。
      readonly canHandoff: boolean;
      // 止まっているため押せない、の 1 文を出すか。
      readonly stoppedNote: boolean;
    };

// 今の表示先の記号と文言。この端末は ●、他の端末は ○（どちらも中立。警告にしない）、未受信は記号なし。
export function displayTargetLine(
  target: 'this_device' | 'other_device' | null,
): StatusLine {
  if (target === null)
    return {
      tone: 'neutral',
      mark: 'none',
      text: DISPLAY_HANDOFF_LABELS.unknown,
    };
  return {
    tone: 'neutral',
    mark: target === 'this_device' ? 'dot' : 'none',
    text: DISPLAY_TARGET_LABELS[target] ?? target,
  };
}

// 欄の値。ロック解除済みで中枢に接続している間だけ出す（中枢の値を読めないときに移させない）。
export function displayHandoffView(
  status: DesktopStatusBar | null,
): DisplayHandoffView {
  if (status?.visibility !== 'shown' || status.hub_connection !== 'connected')
    return { kind: 'hidden' };
  const target = status.display_target;
  const here = target === 'this_device';
  return {
    kind: 'shown',
    line: displayTargetLine(target),
    canHandoff: !here && status.input_permitted,
    stoppedNote: !here && !status.input_permitted,
  };
}
