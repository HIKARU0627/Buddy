// mail_card: メール（UI-07、ADR 0032）。差出人・件名・受信の時刻・ラベル。本文は開いたときだけ取り、開いた 1 通の下にだけ
// 出す（別の 1 通を開くか、閉じると捨てる）。すべてプレーンテキストで、本文の HTML・URL は解釈しない（改行だけを生かす）。
// 開くのは本人の操作なので、キャンバスが前に出ている間だけ押せる（後ろにある間は押せない）。箱に入る行だけを描き、残りは「+数」の札。
import { Button, Chip } from '@heroui/react';
import type { CanvasContent } from '@buddy/contracts';
import { useId } from 'react';
import type { MailBody } from '../../../state/canvas-content-state.js';
import {
  ROW,
  clockLabel,
  rowsThatFit,
} from '../../../state/canvas-content-state.js';
import { MoreChip } from './part-kit.js';
import type { PartProps } from './part-kit.js';

type MailContent = Extract<CanvasContent, { component: 'mail_card' }>;

// 開いた本文の高さ（ピクセル。この高さに収まる行だけ。残りは切る）。
const OPEN_BODY_HEIGHT = 120;

export function MailPart({
  item,
  content,
  box,
  opened,
  opening,
  onOpen,
  onClose,
}: PartProps<MailContent> & {
  readonly opened: MailBody | null;
  readonly opening: number | null;
  readonly onOpen: (index: number) => void;
  readonly onClose: () => void;
}) {
  const bodyId = useId();
  // ラベルは狭い箱（幅 240 未満）では描かない（差出人・件名・時刻を優先する）。
  const wide = box.size !== 'narrow';
  const pitch = ROW.mail.pitch + (wide ? ROW.mail.wideExtra : 0);
  const reserved = opened === null ? 0 : OPEN_BODY_HEIGHT + ROW.mail.gap;
  const capacity = rowsThatFit(
    content.mails.length,
    box.height - reserved,
    pitch,
    ROW.mail.gap,
    item.data.more_count > 0,
  );
  // 開いている行は、箱に入りきらなくても必ず描く（開いたのに見えないことを避ける）。
  const indexes = content.mails.map((_, index) => index);
  const shown = indexes.slice(0, capacity);
  if (opened !== null && !shown.includes(opened.index))
    shown[shown.length - 1] = opened.index;
  const hidden = content.mails.length - shown.length + item.data.more_count;
  return (
    <>
      <ul data-part="mail" className="flex flex-col gap-1">
        {shown.map((index) => {
          const mail = content.mails[index];
          if (mail === undefined) return null;
          const isOpen = opened?.index === index;
          return (
            <li
              key={index}
              data-mail={index}
              data-open={isOpen ? 'true' : undefined}
              className="flex flex-col"
            >
              <Button
                variant="ghost"
                size="sm"
                isDisabled={!box.front}
                aria-expanded={isOpen}
                {...(isOpen ? { 'aria-controls': bodyId } : {})}
                {...(opening === index ? { 'aria-busy': true } : {})}
                onPress={() => (isOpen ? onClose() : onOpen(index))}
                className="h-auto w-full flex-col items-stretch gap-0.5 px-2 py-1.5 text-left font-normal disabled:opacity-100 aria-disabled:opacity-100"
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {mail.from}
                  </span>
                  <time
                    dateTime={mail.received_at}
                    className="shrink-0 text-xs text-muted tabular-nums"
                  >
                    {clockLabel(mail.received_at, box.now)}
                  </time>
                </span>
                <span className="truncate text-sm text-foreground">
                  {mail.subject}
                </span>
                {wide && mail.labels.length > 0 ? (
                  <span className="flex gap-1">
                    {mail.labels.map((label, labelIndex) => (
                      <Chip key={labelIndex} size="sm" variant="tertiary">
                        {label}
                      </Chip>
                    ))}
                  </span>
                ) : null}
              </Button>
              {isOpen ? (
                <div
                  id={bodyId}
                  role="region"
                  aria-label={`${mail.subject}の本文`}
                  data-mail-body="true"
                  style={{ maxHeight: OPEN_BODY_HEIGHT }}
                  className="overflow-hidden px-2 pb-1 text-sm leading-5 break-words whitespace-pre-wrap text-foreground"
                >
                  {opened.body}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <MoreChip count={hidden} />
    </>
  );
}
