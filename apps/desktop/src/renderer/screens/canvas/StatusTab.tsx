// 状態の層の端のつまみ（UI-02 の試作、ADR 0032）。記号 1 つ（入出力の状態。tones.ts の対応表）と、
// 確認が必要な操作の数の枠だけを縦に並べる。説明文は置かず、読み上げの名前だけを付ける。
// つまみを押すとキャンバスを前に出す（本人の判断 2026-10-22）。パネルがスライドして出る動きは UI-04。
// ロック中・不明は押せない（キャンバスの中身を出さない）。
import { Button, Chip } from '@heroui/react';
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
      className="flex h-screen w-screen select-none border-l border-separator bg-surface text-foreground"
    >
      <Button
        variant="ghost"
        aria-label="キャンバスを前に出す"
        isDisabled={!canSummon}
        onPress={onSummon}
        className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-none"
      >
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
      </Button>
    </aside>
  );
}
