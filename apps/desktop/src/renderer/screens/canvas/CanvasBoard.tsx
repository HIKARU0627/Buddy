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
  reveal,
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

// 受け付けたら中枢が当てた後の版、拒否・結果不明は null。
export type CanvasUserOpSender = (
  op: CanvasUserOp,
  expectedRevision: string,
) => Promise<string | null>;

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

// 入りきらない物の札。押す（Enter・Space）と、その物を見える場所へ出し、ほかの物を札に回す（画面だけの切り替え）。
// キャンバスが前に出ている間は、札からも棚へ片付ける・閉じることができる。
function OverflowTag({
  item,
  front,
  compact,
  onReveal,
  onSend,
}: {
  readonly item: CanvasViewItem;
  readonly front: boolean;
  readonly compact: boolean;
  readonly onReveal: (id: string) => void;
  readonly onSend: (op: CanvasUserOp) => void;
}) {
  const size = compact ? 'h-7 text-xs' : 'h-9 text-sm';
  return (
    <span
      role="listitem"
      data-overflow={item.item_id}
      className={`flex ${size} shrink-0 items-center rounded-full border border-separator bg-surface text-foreground`}
    >
      <Button
        size="sm"
        variant="ghost"
        isDisabled={!front}
        aria-label={`${item.heading}を見せる`}
        onPress={() => onReveal(item.item_id)}
        className={`${size} gap-1.5 rounded-full px-3`}
      >
        <span aria-hidden="true" className="flex gap-0.5">
          <span className="size-1 rounded-full bg-current" />
          <span className="size-1 rounded-full bg-current" />
          <span className="size-1 rounded-full bg-current" />
        </span>
        <span className="max-w-40 truncate">{item.heading}</span>
      </Button>
      {front ? (
        <>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`${item.heading}を棚へ片付ける`}
            onPress={() => onSend({ kind: 'shelve', item_id: item.item_id })}
            className={compact ? 'size-7' : 'size-8'}
          >
            <ShelveIcon />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`${item.heading}を閉じる`}
            onPress={() => onSend({ kind: 'close', item_id: item.item_id })}
            className={`mr-1 ${compact ? 'size-7' : 'size-8'}`}
          >
            <CloseIcon />
          </Button>
        </>
      ) : null}
    </span>
  );
}

function Shelf({
  rect,
  compact,
  shelved,
  overflow,
  front,
  onReveal,
  onSend,
}: {
  readonly rect: CanvasRect;
  // 作業領域が最小の高さに満たないときの、上の端の小さな棚。
  readonly compact: boolean;
  readonly shelved: readonly CanvasViewItem[];
  readonly overflow: readonly CanvasViewItem[];
  readonly front: boolean;
  readonly onReveal: (id: string) => void;
  readonly onSend: (op: CanvasUserOp) => void;
}) {
  if (shelved.length === 0 && overflow.length === 0 && !front) return null;
  const size = compact ? 'h-7 text-xs' : 'h-9';
  return (
    <div
      role="list"
      aria-label="棚"
      data-shelf={compact ? 'compact' : 'true'}
      style={rectStyle(rect)}
      className={`absolute flex items-center gap-2 overflow-x-auto px-1 ${
        compact ? '' : 'border-t border-separator'
      }`}
    >
      {/* 入りきらない物（記述では見える物。読む順のまま）。札から見せる・片付ける・閉じる。 */}
      {overflow.map((item) => (
        <OverflowTag
          key={item.item_id}
          item={item}
          front={front}
          compact={compact}
          onReveal={onReveal}
          onSend={onSend}
        />
      ))}
      {shelved.map((item) => (
        <span key={item.item_id} role="listitem" data-shelved={item.item_id}>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!front}
            aria-label={`${item.heading}を棚から出す`}
            onPress={() => onSend({ kind: 'unshelve', item_id: item.item_id })}
            className={`${size} shrink-0 gap-1.5 rounded-full`}
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
  const viewRef = useRef(view);
  viewRef.current = view;
  const boardRef = useRef<HTMLDivElement | null>(null);
  // 操作の ID（使い回さない）と世代（選択・ドラッグ・送信中を捨てるたびに進める）。応答はこの 2 つで照合する。
  const opSeq = useRef(0);
  const generation = useRef(0);
  // 新しい記述が届いた・捨てた。ドラッグ中の物は守り、なくなったらやめる。送信中の位置は当てた版の記述で解く。
  useEffect(() => {
    if (view === null) generation.current += 1;
    setInteraction((prev) => interactionAfterView(prev, view));
  }, [view]);
  // 後ろへ戻った（Esc・ほかのアプリへの移動・ロック）: 選択・ドラッグ・送信中の位置・札からの切り替えを捨てる。
  useEffect(() => {
    if (front) return;
    generation.current += 1;
    setInteraction(NO_INTERACTION);
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
      opSeq.current += 1;
      const id = { opId: opSeq.current, generation: generation.current };
      setInteraction((prev) => sent(prev, op, revision, id));
      onUserOp(op, revision)
        .catch(() => null)
        .then((applied) =>
          setInteraction((prev) =>
            settled(
              prev,
              id,
              applied,
              viewRef.current?.canvas_revision ?? null,
            ),
          ),
        );
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
      // 既定のフォーカスの移動を止めたので、掴んだ物へフォーカスを移す（キーボードの操作の対象を、選んだ物とそろえる）。
      const card = event.currentTarget.closest('[data-item]');
      if (card instanceof HTMLElement) card.focus({ preventScroll: true });
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

  const onReveal = useCallback(
    (id: string) => {
      if (!front) return;
      setInteraction((prev) => reveal(prev, id));
    },
    [front],
  );
  // 札から見せた物へフォーカスを移す（見える場所へ出た物を、そのままキーボードで操作できる）。
  const revealed = interaction.revealed;
  useEffect(() => {
    if (revealed === null) return;
    const card = boardRef.current?.querySelector(
      `[data-item="${CSS.escape(revealed)}"]`,
    );
    if (card instanceof HTMLElement) card.focus({ preventScroll: true });
  }, [revealed]);

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
      ref={boardRef}
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
        compact={layout.shelf.compact}
        shelved={shelved}
        overflow={overflow}
        front={front}
        onReveal={onReveal}
        onSend={send}
      />
    </div>
  );
}
