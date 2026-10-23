// progress: 進み具合（UI-07、ADR 0032）。名前・帯の長さ・「済み / 全部」の数で示す（色だけに頼らない）。終わったものには
// チェックの形を付ける。帯は HeroUI の ProgressBar（読み上げは名前と「N / M」の値）。箱の高さに入る数だけを描き、残りは
// 「+数」の札にする。
import { ProgressBar } from '@heroui/react';
import type { CanvasContent } from '@buddy/contracts';
import { CheckMark } from '../../../components/CanvasPartIcons.js';
import { ROW, rowsThatFit } from '../../../state/canvas-content-state.js';
import { MoreChip } from './part-kit.js';
import type { PartProps } from './part-kit.js';

type ProgressContent = Extract<CanvasContent, { component: 'progress' }>;

export function ProgressPart({
  item,
  content,
  box,
}: PartProps<ProgressContent>) {
  const capacity = rowsThatFit(
    content.steps.length,
    box.height,
    ROW.progress.pitch,
    ROW.progress.gap,
    item.data.more_count > 0,
  );
  const steps = content.steps.slice(0, capacity);
  const hidden = content.steps.length - steps.length + item.data.more_count;
  return (
    <>
      <ul data-part="progress" className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={index}
            data-complete={step.done >= step.total ? 'true' : undefined}
          >
            <ProgressBar
              aria-label={step.label}
              value={step.done}
              minValue={0}
              maxValue={step.total}
              valueLabel={`${step.done} / ${step.total}`}
              className="w-full"
            >
              <div className="flex items-center gap-2">
                {step.done >= step.total ? <CheckMark /> : null}
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {step.label}
                </span>
                <ProgressBar.Output className="shrink-0 text-xs text-muted tabular-nums" />
              </div>
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
          </li>
        ))}
      </ul>
      <MoreChip count={hidden} />
    </>
  );
}
