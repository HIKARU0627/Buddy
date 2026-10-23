// キャンバスの物を配置のエンジンの結果どおりに置く（UI-03・UI-06、ADR 0032）。置く物は main が検査した記述
// （DesktopCanvasView）だけで、位置と大きさは @buddy/domain の layoutCanvas（state/canvas-layout-state.ts）が決める。
// DOM の順は読む順（読み上げ・キーボードの移動の順）。AI はコード・HTML・CSS・座標を出さず、描画は決まった部品だけで行う。
// 今の部品は list の 1 種類で、そのほかの部品・フローティングウィンドウは UI-07（同じカードで描く）。
// - 下の中央（入力バー）と右の端（状態の層）はエンジンが空ける。棚は下の帯（入力バーの左、狭ければ入力バーの上）。
// - キャンバスが前に出ている間（front）だけ操作を受ける: 見出しの帯を掴んで動かす、右下の角で大きさを変える、×で閉じる、
//   下向きの矢印で棚へ片付ける、棚の物を押して出す。キーボードは Tab で選び、矢印・Shift ＋ 矢印・Delete・Alt ＋ ↓。
// - ドラッグ中・送信中の物はエンジンにその位置で置かせ、新しい記述が届いても AI の更新から守る。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { Button } from '@heroui/react';
import type { CanvasUserOp, DesktopCanvasView } from '@buddy/contracts';
import type { CanvasInsets, CanvasRect } from '@buddy/domain';
import {
  CloseIcon,
  ResizeGrip,
  ShelveIcon,
  UnshelveIcon,
} from '../../components/CanvasItemIcons.js';
import {
  NO_INSETS,
  NO_INTERACTION,
  beginDrag,
  dragTo,
  endDrag,
  interactionAfterView,
  keyOp,
  layoutForView,
  sent,
  settled,
} from '../../state/canvas-layout-state.js';
import type {
  CanvasInteraction,
  CanvasLayoutBox,
} from '../../state/canvas-layout-state.js';
import type { CanvasViewItem } from '../../state/canvas-state.js';
import { ListCard } from './ListCard.js';

const rectStyle = (rect: CanvasRect): CSSProperties => ({
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
});

// これより低い箱（1 行分 = 72）は、行の代わりに件数の札だけを出す。
const COMPACT_HEIGHT = 120;

export type CanvasUserOpSender = (
  op: CanvasUserOp,
  expectedRevision: string,
) => Promise<boolean>;

function PlacedCard({
  item,
  box,
  front,
  selected,
  dragging,
  onSelect,
  onKey,
  onGrab,
  onSend,
}: {
  readonly item: CanvasViewItem;
  readonly box: CanvasLayoutBox;
  readonly front: boolean;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly onSelect: (id: string) => void;
  readonly onKey: (
    event: ReactKeyboardEvent<HTMLDivElement>,
    box: CanvasLayoutBox,
  ) => void;
  readonly onGrab: (
    event: ReactPointerEvent<HTMLElement>,
    box: CanvasLayoutBox,
    mode: 'move' | 'resize',
  ) => void;
  readonly onSend: (op: CanvasUserOp) => void;
}) {
  const movable = front && box.cell !== null;
  // 操作の印は、選んだ物と、ポインターを重ねた・フォーカスのある物にだけ出す（狭いカードでも見出しを隠さない）。
  const reveal =
    selected || dragging
      ? 'flex'
      : 'hidden group-hover:flex group-focus-within:flex';
  return (
    <div
      data-item={item.item_id}
      data-source={box.source}
      data-dragging={dragging ? 'true' : undefined}
      tabIndex={front ? 0 : -1}
      onFocus={() => onSelect(item.item_id)}
      onKeyDown={(event) => onKey(event, box)}
      style={rectStyle(box.rect)}
      className={`group absolute rounded-3xl outline-none transition-[left,top,width,height] duration-150 motion-reduce:transition-none ${
        dragging ? 'z-10 shadow-overlay' : ''
      } ${front && selected ? 'ring-2 ring-focus ring-offset-2 ring-offset-background' : ''}`}
    >
      <ListCard
        item={item}
        compact={box.rect.height < COMPACT_HEIGHT}
        {...(movable ? { onGrab: (event) => onGrab(event, box, 'move') } : {})}
        controls={
          front ? (
            <span
              data-controls="true"
              className={`${reveal} shrink-0 items-center gap-1`}
            >
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={`${item.heading}を棚へ片付ける`}
                onPress={() =>
                  onSend({ kind: 'shelve', item_id: item.item_id })
                }
                onPointerDown={(event) => event.stopPropagation()}
              >
                <ShelveIcon />
              </Button>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={`${item.heading}を閉じる`}
                onPress={() => onSend({ kind: 'close', item_id: item.item_id })}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <CloseIcon />
              </Button>
            </span>
          ) : null
        }
      />
      {movable ? (
        <span
          aria-hidden="true"
          data-resize-grip="true"
          onPointerDown={(event) => onGrab(event, box, 'resize')}
          className={`absolute right-1.5 bottom-1.5 ${reveal} size-5 cursor-nwse-resize touch-none items-center justify-center text-muted`}
        >
          <ResizeGrip />
        </span>
      ) : null}
    </div>
  );
}

function Shelf({
  rect,
  shelved,
  overflow,
  front,
  onSend,
}: {
  readonly rect: CanvasRect;
  readonly shelved: readonly CanvasViewItem[];
  readonly overflow: readonly CanvasViewItem[];
  readonly front: boolean;
  readonly onSend: (op: CanvasUserOp) => void;
}) {
  if (shelved.length === 0 && overflow.length === 0 && !front) return null;
  return (
    <div
      role="list"
      aria-label="棚"
      data-shelf="true"
      style={rectStyle(rect)}
      className="absolute flex items-center gap-2 overflow-x-auto border-t border-separator px-1"
    >
      {/* 入りきらない物（記述は見える物。読む順のまま）。押しても動かない（AI の次の答えか、ほかの物を片付けると戻る）。 */}
      {overflow.map((item) => (
        <span
          key={item.item_id}
          role="listitem"
          data-overflow={item.item_id}
          tabIndex={front ? 0 : -1}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-separator bg-surface px-3 text-sm text-foreground"
        >
          <span aria-hidden="true" className="flex gap-0.5">
            <span className="size-1 rounded-full bg-current" />
            <span className="size-1 rounded-full bg-current" />
            <span className="size-1 rounded-full bg-current" />
          </span>
          <span className="max-w-40 truncate">{item.heading}</span>
        </span>
      ))}
      {shelved.map((item) => (
        <span key={item.item_id} role="listitem" data-shelved={item.item_id}>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!front}
            aria-label={`${item.heading}を棚から出す`}
            onPress={() => onSend({ kind: 'unshelve', item_id: item.item_id })}
            className="h-9 shrink-0 gap-1.5 rounded-full"
          >
            <UnshelveIcon />
            <span className="max-w-40 truncate">{item.heading}</span>
          </Button>
        </span>
      ))}
    </div>
  );
}

export function CanvasBoard({
  view,
  front = false,
  viewport,
  insets = NO_INSETS,
  onUserOp,
}: {
  readonly view: DesktopCanvasView | null;
  // キャンバスが前に出ている（操作を受ける）。
  readonly front?: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly insets?: CanvasInsets;
  readonly onUserOp?: CanvasUserOpSender;
}) {
  const [interaction, setInteraction] =
    useState<CanvasInteraction>(NO_INTERACTION);
  const interactionRef = useRef(interaction);
  interactionRef.current = interaction;
  // 新しい記述が届いた・捨てた。ドラッグ中の物は守り、なくなったらやめる。送信中の位置は新しい版で解く。
  useEffect(() => {
    setInteraction((prev) => interactionAfterView(prev, view));
  }, [view]);
  // 後ろへ戻った（Esc・ほかのアプリへの移動・ロック）: 選択・ドラッグ・送信中の位置を捨てる。
  useEffect(() => {
    if (!front) setInteraction(NO_INTERACTION);
  }, [front]);
  const layout = useMemo(
    () => layoutForView(view, viewport, insets, interaction),
    [view, viewport, insets, interaction],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const byId = useMemo(
    () => new Map((view?.items ?? []).map((item) => [item.item_id, item])),
    [view],
  );

  const send = useCallback(
    (op: CanvasUserOp) => {
      if (!front || view === null || onUserOp === undefined) return;
      if (interactionRef.current.pending !== null) return;
      const revision = view.canvas_revision;
      setInteraction((prev) => sent(prev, op, revision));
      onUserOp(op, revision)
        .catch(() => false)
        .then((accepted) => setInteraction((prev) => settled(prev, accepted)));
    },
    [front, view, onUserOp],
  );

  const onKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, box: CanvasLayoutBox) => {
      if (!front || event.target !== event.currentTarget) return;
      const op = keyOp(event, box, layoutRef.current.grid);
      if (op === null) return;
      event.preventDefault();
      send(op);
    },
    [front, send],
  );

  const onGrab = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      box: CanvasLayoutBox,
      mode: 'move' | 'resize',
    ) => {
      if (!front || event.button !== 0) return;
      // 見出しの帯の中のボタン（閉じる・片付ける）を押したときは掴まない。
      if (
        event.target instanceof Element &&
        event.target.closest('button') !== null
      )
        return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 捕まえられない（ポインターがもうない）ときも、window の pointermove・pointerup で追う。
      }
      setInteraction((prev) =>
        beginDrag(prev, box, mode, { x: event.clientX, y: event.clientY }),
      );
    },
    [front],
  );

  // ドラッグ中はポインターを追い、離したら操作を送る。キャンセル（ポインターを失った）は送らない。
  const dragging = interaction.drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) =>
      setInteraction((prev) =>
        dragTo(prev, layoutRef.current.grid, {
          x: event.clientX,
          y: event.clientY,
        }),
      );
    const onUp = () => {
      const result = endDrag(interactionRef.current);
      setInteraction(result.state);
      if (result.op !== null) send(result.op);
    };
    const onCancel = () => setInteraction((prev) => ({ ...prev, drag: null }));
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [dragging, send]);

  const select = useCallback(
    (id: string) =>
      setInteraction((prev) =>
        prev.selected === id ? prev : { ...prev, selected: id },
      ),
    [],
  );

  if (view === null) return null;
  // 置く物も棚の物もなく、後ろにある間は何も描かない（前に出ている間は空の棚の場所を見せる）。
  if (
    !front &&
    layout.boxes.length === 0 &&
    layout.overflow.length === 0 &&
    layout.shelf.items.length === 0
  )
    return null;
  const shelved = layout.shelf.items.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  const overflow = layout.overflow.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  return (
    <div
      data-canvas-revision={view.canvas_revision}
      data-layout-mode={layout.mode}
      className="absolute inset-0"
    >
      {layout.boxes.map((box) => {
        const item = byId.get(box.item_id);
        if (item === undefined) return null;
        return (
          <PlacedCard
            key={box.item_id}
            item={item}
            box={box}
            front={front}
            selected={interaction.selected === box.item_id}
            dragging={interaction.drag?.item_id === box.item_id}
            onSelect={select}
            onKey={onKey}
            onGrab={onGrab}
            onSend={send}
          />
        );
      })}
      <Shelf
        rect={layout.shelf.rect}
        shelved={shelved}
        overflow={overflow}
        front={front}
        onSend={send}
      />
    </div>
  );
}
