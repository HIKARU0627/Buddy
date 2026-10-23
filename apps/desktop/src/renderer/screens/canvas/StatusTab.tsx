// 状態の層の端のつまみ（UI-02 の試作、ADR 0032）。上から、持ち手（引き出せることを示す縦の線）・記号 1 つ（入出力の
// 状態。tones.ts の対応表）・確認が必要な操作の数の枠・キャンバスを前に出すボタン（入力バーと同じ 4 つの四角の記号、
// 押せる縁つき）を縦に並べる。説明文は置かず、読み上げの名前だけを付ける（本人の判断 2026-10-22、PR #104 の再確認 P3）。
// 状態を見る部分と押す部分を分け、押せるのは縁のあるボタンだけにする。パネルがスライドして出る動きは UI-04。
// ロック中・不明はボタンを押せない（キャンバスの中身を出さない）。
import { Button, Chip } from '@heroui/react';
import { CanvasIcon } from '../../components/CanvasIcon.js';
import { StatusMark } from '../../components/StatusText.js';
import type { StatusTabView } from '../../state/window-role-state.js';

export function StatusTab({
  view,
  canSummon,
  onSummon,
}: {
  readonly view: StatusTabView;
  readonly canSummon: boolean;
  readonly onSummon: () => void;
}) {
  return (
    <aside
      role="status"
      aria-label={view.label}
      className="relative flex h-screen w-screen select-none flex-col items-center justify-between border-l border-separator bg-surface py-2 pl-1 text-foreground"
    >
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-1 h-8 w-1 -translate-y-1/2 rounded-full bg-separator"
      />
      <span className="flex flex-col items-center gap-1.5 pt-1">
        <span
          aria-hidden="true"
          className="flex size-6 items-center justify-center text-lg leading-none"
        >
          <StatusMark line={view.line} />
        </span>
        {view.pending === null ? null : (
          <Chip
            aria-hidden="true"
            size="sm"
            variant={view.pending > 0 ? 'primary' : 'tertiary'}
            color={view.pending > 0 ? 'warning' : 'default'}
            className="min-w-7 justify-center tabular-nums"
          >
            {view.pending}
          </Chip>
        )}
      </span>
      <Button
        isIconOnly
        variant="outline"
        aria-label="キャンバスを前に出す"
        isDisabled={!canSummon}
        onPress={onSummon}
        className="size-10"
      >
        <CanvasIcon className="size-5" />
      </Button>
    </aside>
  );
}
