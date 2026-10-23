// text: 話の本体（UI-07、ADR 0032）。プレーンテキストだけ（HTML として解釈せず、リンクにしない。URL はただの文字）。改行は生かし、
// 長い行は折り返す。箱の高さに入る行数で切る（切れた分は、箱を大きくすると読める）。1 回の答えにつき 1 つまで（契約の意味の検査）。
import type { CanvasContent } from '@buddy/contracts';
import { ROW } from '../../../state/canvas-content-state.js';
import type { PartProps } from './part-kit.js';

type TextContent = Extract<CanvasContent, { component: 'text' }>;

export function TextPart({ content, box }: PartProps<TextContent>) {
  const lines = Math.max(2, Math.floor(box.height / ROW.textLine));
  return (
    <p
      data-part="text"
      style={{
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: lines,
        overflow: 'hidden',
      }}
      className={`leading-6 break-words whitespace-pre-wrap text-foreground ${
        box.size === 'wide' ? 'text-base' : 'text-sm'
      }`}
    >
      {content.text}
    </p>
  );
}
