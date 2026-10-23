// キャンバスの物 1 つのカード（UI-03 の用事のカードを、UI-07 で 9 つの部品の枠に広げた。ADR 0032）。HeroUI の Card に、見出し
// （プレーンテキスト。React の文字列の子としてだけ渡す。HTML として解釈せず、リンクにしない）と、部品ごとの本文を置く。説明文は
// 置かない。本文の中身は main から取った物（画面のメモリーだけ）で、取っている間は順番の数と空の帯、取れなかったときは警告の
// 記号だけを出す。位置と大きさは配置のエンジン（UI-06）が決め、カードは置かれた箱いっぱいに描く。
// 強調（high）は accent の太い線、ユーザーが動かした物・フローティングウィンドウ（kind が float）は影で、形で区別する。
// キャンバスが前に出ている間だけ、見出しの帯を掴んで動かせ、右上に閉じる・棚へ片付けるの印（controls）を出す。箱が低い（1 行分）
// ときは、本文の代わりに件数の札だけを出す（compact）。箱が狭い（narrow）ときは、見出しを 1 行目に幅いっぱいで置き、件数の札と
// 操作の印をその下の行へ移す（見出しを優先。PR #121 の再確認）。
import { useId } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Card, Chip } from '@heroui/react';
import { bodySizeOf, widthClassOf } from '../../state/canvas-content-state.js';
import type { ItemContent } from '../../state/canvas-content-state.js';
import { emphasisClass } from '../../state/canvas-state.js';
import type { CanvasViewItem } from '../../state/canvas-state.js';
import { ChartPart } from './parts/ChartPart.js';
import { ComparePart } from './parts/ComparePart.js';
import { ListPart } from './parts/ListPart.js';
import { MailPart } from './parts/MailPart.js';
import { PlaceholderBody } from './parts/part-kit.js';
import type { PartBox } from './parts/part-kit.js';
import { ProgressPart } from './parts/ProgressPart.js';
import { SourcePart } from './parts/SourcePart.js';
import { TablePart } from './parts/TablePart.js';
import { TextPart } from './parts/TextPart.js';
import { TimelinePart } from './parts/TimelinePart.js';

// これより低い箱（1 行分 = 72）は、本文の代わりに件数の札だけを出す。
export const COMPACT_HEIGHT = 120;
// これより狭い箱は、見出しを 1 行目に置き、件数と操作の印をその下の行へ移す（見出しを優先する）。
export const NARROW_WIDTH = 240;

// 参照の位置が行になる部品（件数の札の意味がある部品）。
const ROW_COMPONENTS: readonly CanvasViewItem['component'][] = [
  'list',
  'table',
  'schedule_timeline',
  'mail_card',
  'source_list',
];

function Body({
  item,
  entry,
  box,
  onOpenMail,
  onCloseMail,
}: {
  readonly item: CanvasViewItem;
  readonly entry: ItemContent | undefined;
  readonly box: PartBox;
  readonly onOpenMail?: (index: number) => void;
  readonly onCloseMail?: () => void;
}) {
  if (entry === undefined || entry.status === 'loading')
    return <PlaceholderBody item={item} status="loading" />;
  const content = entry.content;
  // 中身が物の部品と合わないときは描かない（main が検査済みだが、画面も多重に確かめる）。
  if (
    entry.status === 'failed' ||
    content === null ||
    content.component !== item.component
  )
    return <PlaceholderBody item={item} status="failed" />;
  switch (content.component) {
    case 'list':
      return <ListPart item={item} content={content} box={box} />;
    case 'table':
      return <TablePart item={item} content={content} box={box} />;
    case 'schedule_timeline':
      return <TimelinePart item={item} content={content} box={box} />;
    case 'mail_card':
      return (
        <MailPart
          item={item}
          content={content}
          box={box}
          opened={entry.opened}
          opening={entry.opening}
          onOpen={(index) => onOpenMail?.(index)}
          onClose={() => onCloseMail?.()}
        />
      );
    case 'compare':
      return <ComparePart item={item} content={content} box={box} />;
    case 'progress':
      return <ProgressPart item={item} content={content} box={box} />;
    case 'chart':
      return <ChartPart item={item} content={content} box={box} />;
    case 'source_list':
      return <SourcePart item={item} content={content} box={box} />;
    case 'text':
      return <TextPart item={item} content={content} box={box} />;
  }
}

export function ItemCard({
  item,
  entry,
  size,
  now,
  front = false,
  controls = null,
  onGrab,
  onOpenMail,
  onCloseMail,
}: {
  readonly item: CanvasViewItem;
  // 取った中身（なければ取っている間として描く）。
  readonly entry?: ItemContent | undefined;
  // 置かれた箱の大きさ（ピクセル）。部品はこの大きさに入る行・列だけを描く。
  readonly size: { readonly width: number; readonly height: number };
  // 時刻の書き方の基準（今日は時刻だけ）。
  readonly now: number;
  // キャンバスが前に出ている（押せる部品を押せる・Tab の対象にする）。
  readonly front?: boolean;
  readonly controls?: ReactNode;
  // 見出しの帯を掴んだ（キャンバスが前に出ているときだけ渡す）。
  readonly onGrab?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onOpenMail?: (index: number) => void;
  readonly onCloseMail?: () => void;
}) {
  const headingId = useId();
  const compact = size.height < COMPACT_HEIGHT;
  const narrow = size.width < NARROW_WIDTH;
  const total = item.data.item_refs.length + item.data.more_count;
  const count =
    compact && total > 0 && ROW_COMPONENTS.includes(item.component) ? (
      <Chip
        size="sm"
        variant="tertiary"
        data-compact-count="true"
        className="shrink-0 tabular-nums"
      >
        {String(total)}
      </Chip>
    ) : null;
  const stackedTools = narrow && (count !== null || controls !== null);
  const box: PartBox = {
    ...bodySizeOf(size, { stackedTools }),
    size: widthClassOf(size.width),
    now,
    front,
  };
  return (
    <Card
      role="group"
      aria-labelledby={headingId}
      data-emphasis={item.emphasis}
      data-component={item.component}
      data-kind={item.kind}
      data-width-class={box.size}
      className={`h-full w-full min-h-0 overflow-hidden ${emphasisClass(item.emphasis)} ${
        item.kind === 'float' ? 'shadow-overlay' : ''
      }`}
    >
      <Card.Header
        onPointerDown={onGrab}
        data-header={narrow ? 'stacked' : 'inline'}
        className={`flex ${narrow ? 'flex-col items-stretch gap-1' : 'flex-row items-start gap-2'} ${onGrab === undefined ? '' : 'cursor-grab touch-none'}`}
      >
        <Card.Title
          id={headingId}
          className={narrow ? 'w-full truncate' : 'min-w-0 flex-1 truncate'}
        >
          {item.heading}
        </Card.Title>
        {narrow ? (
          stackedTools ? (
            <span
              data-header-tools="true"
              className="flex items-center justify-end gap-1"
            >
              {count}
              {controls}
            </span>
          ) : null
        ) : (
          <>
            {count}
            {controls}
          </>
        )}
      </Card.Header>
      {compact ? null : (
        <Card.Content className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <Body
            item={item}
            entry={entry}
            box={box}
            {...(onOpenMail === undefined ? {} : { onOpenMail })}
            {...(onCloseMail === undefined ? {} : { onCloseMail })}
          />
        </Card.Content>
      )}
    </Card>
  );
}
