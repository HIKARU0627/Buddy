// 用事の一覧のカード（UI-03、ADR 0032）。キャンバスの部品 list を HeroUI の Card で描く。見出しはプレーンテキスト
// （React の文字列の子としてだけ渡す。HTML として解釈せず、リンクにしない）で、説明文は置かない。記述は参照だけで
// 本文を持たないので（本文は開いたときに許可範囲内で取る設計。UI-07）、行は順番の数と空の帯で数と並びを示す。
// 残りの件数（more_count）は「+数」の小さな札、強調（high）は accent の枠で伝える。位置は格子のヒントから決める。
import { useId } from 'react';
import { Card, Chip } from '@heroui/react';
import { emphasisClass, gridClass } from '../../state/canvas-state.js';
import type { CanvasViewItem } from '../../state/canvas-state.js';

export function ListCard({ item }: { readonly item: CanvasViewItem }) {
  const headingId = useId();
  const refs = item.data.item_refs;
  return (
    <Card
      aria-labelledby={headingId}
      data-item={item.item_id}
      data-emphasis={item.emphasis}
      className={`min-h-0 overflow-hidden ${gridClass(item.grid)} ${emphasisClass(item.emphasis)}`}
    >
      <Card.Header>
        <Card.Title id={headingId}>{item.heading}</Card.Title>
      </Card.Header>
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
    </Card>
  );
}
