// 流れの表示先「このPCに出す」の欄（UI-05 の段階 5、ADR 0193。設計 07 §5、ADR 0032・0188）。何を出すかは純粋な関数
// （state/display-handoff-state.ts）が決め、ここは描くだけ。
// 見出し「表示先」と、今の表示先の記号と文言（中枢から受け取った値）、ボタン「このPCに出す」。表示先がこの端末のときはボタンを
// 出さない（押す必要がない）。押しても画面の表示は変えず、main の状態欄の通知で変わる（正本は中枢）。拒否の文言は欄のすぐ下に
// 出す。状態の層のパネルだけが置く（島・入力バー・キャンバスには置かない。役割の表）。
import { Button } from '@heroui/react';
import { DISPLAY_HANDOFF_LABELS } from '../labels.js';
import type { DisplayHandoffView } from '../state/display-handoff-state.js';
import { InlineNotice } from './InlineNotice.js';
import { StatusText } from './StatusText.js';

export const DISPLAY_HANDOFF_HEADING_ID = 'display-handoff-heading';

export function DisplayHandoffControl({
  view,
  message,
  onHandoff,
  headingId = DISPLAY_HANDOFF_HEADING_ID,
}: {
  readonly view: DisplayHandoffView;
  // 移せなかった理由の文言（なければ null）。
  readonly message: string | null;
  readonly onHandoff: () => void;
  // 同じ画面に 2 つ置かないので既定の ID のままでよい（試験で変える）。
  readonly headingId?: string;
}) {
  if (view.kind === 'hidden') return null;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-display-handoff=""
      className="flex flex-col gap-2"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span id={headingId} className="text-xs text-muted">
          {DISPLAY_HANDOFF_LABELS.title}
        </span>
        <StatusText line={view.line} />
      </p>
      {view.canHandoff ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label={DISPLAY_HANDOFF_LABELS.buttonName}
            data-display-handoff-button=""
            onPress={onHandoff}
          >
            {DISPLAY_HANDOFF_LABELS.button}
          </Button>
        </div>
      ) : null}
      {view.stoppedNote ? (
        <p className="text-xs text-muted">{DISPLAY_HANDOFF_LABELS.stopped}</p>
      ) : null}
      {message === null ? null : <InlineNotice tone="warning" text={message} />}
    </div>
  );
}
