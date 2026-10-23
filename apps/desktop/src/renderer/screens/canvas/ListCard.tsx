// 用事の一覧のカード（UI-03、ADR 0032）。キャンバスの部品 list を HeroUI の Card で描く。見出しはプレーンテキスト
// （React の文字列の子としてだけ渡す。HTML として解釈せず、リンクにしない）で、説明文は置かない。記述は参照だけで
// 本文を持たないので（本文は開いたときに許可範囲内で取る設計。UI-07）、行は順番の数と空の帯で数と並びを示す。
// 残りの件数（more_count）は「+数」の小さな札、強調（high）は accent の枠で伝える。位置と大きさは配置のエンジン
// （UI-06）が決め、カードは置かれた箱いっぱいに描く。キャンバスが前に出ている間だけ、見出しの帯を掴んで動かせ、
// 右上に閉じる・棚へ片付けるの印（controls）を出す。箱が低い（1 行分）ときは、行の代わりに件数の札だけを出す（compact）。
import { useId } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Card, Chip } from '@heroui/react';
import { emphasisClass } from '../../state/canvas-state.js';
import type { CanvasViewItem } from '../../state/canvas-state.js';

export function ListCard({
  item,
  controls = null,
  compact = false,
  onGrab,
}: {
  readonly item: CanvasViewItem;
  readonly controls?: ReactNode;
  // 箱が低く、行を描けない。
  readonly compact?: boolean;
  // 見出しの帯を掴んだ（キャンバスが前に出ているときだけ渡す）。
  readonly onGrab?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const headingId = useId();
  const refs = item.data.item_refs;
  return (
    <Card
      aria-labelledby={headingId}
      data-emphasis={item.emphasis}
      className={`h-full w-full min-h-0 overflow-hidden ${emphasisClass(item.emphasis)}`}
    >
      <Card.Header
        onPointerDown={onGrab}
        className={`flex flex-row items-start gap-2 ${onGrab === undefined ? '' : 'cursor-grab touch-none'}`}
      >
        <Card.Title id={headingId} className="min-w-0 flex-1 truncate">
          {item.heading}
        </Card.Title>
        {compact ? (
          <Chip
            size="sm"
            variant="tertiary"
            data-compact-count="true"
            className="shrink-0 tabular-nums"
          >
            {String(refs.length + item.data.more_count)}
          </Chip>
        ) : null}
        {controls}
      </Card.Header>
      {compact ? null : (
        <Card.Content className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {refs.length === 0 ? (
            <span
              aria-hidden="true"
              data-empty="true"
              className="mx-auto mt-2 size-6 rounded-full border border-separator"
            />
          ) : (
            <ol className="flex flex-col gap-2">
              {refs.map((entry, index) => (
                <li key={entry.ref} className="flex items-center gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-default text-xs text-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span
                    aria-hidden="true"
                    className="h-2 flex-1 rounded-full bg-default"
                  />
                </li>
              ))}
            </ol>
          )}
          {item.data.more_count > 0 ? (
            <Chip size="sm" variant="tertiary" className="self-start">
              {`+${item.data.more_count}`}
            </Chip>
          ) : null}
        </Card.Content>
      )}
    </Card>
  );
}
