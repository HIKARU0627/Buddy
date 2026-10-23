// キャンバスの部品の共通の道具（UI-07、ADR 0032）。部品は配置のエンジンが決めた箱の大きさだけを見て、行・列・目盛りを決める。
// 中身はプレーンテキストとして React の文字列の子にだけ渡す（HTML として解釈せず、リンクにしない。出典の URL だけが、
// https のときにリンクになる）。説明文は置かず、数・形・位置で伝える。色は HeroUI のトークンだけを使う。
import { Chip, WarningIcon } from '@heroui/react';
import type { CanvasViewItem } from '../../../state/canvas-state.js';
import {
  moreColumnsLabel,
  moreLabel,
} from '../../../state/canvas-content-state.js';
import type { WidthClass } from '../../../state/canvas-content-state.js';

// 部品が描くときに受け取る箱の事情（本文を描ける大きさ・幅の種類・今の時刻・キャンバスが前に出ているか）。
export interface PartBox {
  readonly width: number;
  readonly height: number;
  readonly size: WidthClass;
  readonly now: number;
  readonly front: boolean;
}

export interface PartProps<C> {
  readonly item: CanvasViewItem;
  readonly content: C;
  readonly box: PartBox;
}

// 入りきらない行（↓）・列（→）の数の札。数と矢印の形で示し、読み上げは「ほか N 件・N 列」。
export function MoreChip({
  count,
  axis = 'rows',
}: {
  readonly count: number;
  readonly axis?: 'rows' | 'columns';
}) {
  if (count <= 0) return null;
  return (
    <Chip
      size="sm"
      variant="tertiary"
      role="img"
      aria-label={axis === 'rows' ? moreLabel(count) : moreColumnsLabel(count)}
      data-more={axis}
      className="shrink-0 self-start tabular-nums"
    >
      <span aria-hidden="true">
        {axis === 'rows' ? '+' : '→'}
        {count}
      </span>
    </Chip>
  );
}

// 中身を取っている間・取れなかったときの本文。取っている間は、参照ごとの順番の数と空の帯（数と並びだけ）を出し、
// 取れなかったときは警告の記号だけを出す（説明文は置かない。読み上げは名前で伝える）。
export function PlaceholderBody({
  item,
  status,
}: {
  readonly item: CanvasViewItem;
  readonly status: 'loading' | 'failed';
}) {
  const refs = item.data.item_refs;
  if (status === 'failed')
    return (
      <span
        role="img"
        aria-label="中身を表示できません"
        data-state="failed"
        className="mx-auto mt-2 flex size-6 items-center justify-center text-warning-soft-foreground"
      >
        <WarningIcon />
      </span>
    );
  return (
    <>
      {refs.length === 0 ? (
        <span
          aria-hidden="true"
          data-empty="true"
          className="mx-auto mt-2 size-6 rounded-full border border-separator"
        />
      ) : (
        <ol data-state="loading" className="flex flex-col gap-2">
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
    </>
  );
}
