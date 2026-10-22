// 状態の層の端のつまみ（UI-02 の試作、ADR 0032）。記号 1 つ（入出力の状態。tones.ts の対応表）と、
// 確認が必要な操作の数の枠だけを縦に並べる。説明文は置かず、読み上げの名前だけを付ける。
// 押すとパネルがスライドして出る動きは UI-04。
import { Chip } from '@heroui/react';
import { StatusMark } from '../../components/StatusText.js';
import type { StatusTabView } from '../../state/window-role-state.js';

export function StatusTab({ view }: { readonly view: StatusTabView }) {
  return (
    <aside
      role="status"
      aria-label={view.label}
      className="flex h-screen w-screen select-none flex-col items-center justify-center gap-3 border-l border-separator bg-surface text-foreground"
    >
      <span className="flex size-6 items-center justify-center text-lg leading-none">
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
    </aside>
  );
}
