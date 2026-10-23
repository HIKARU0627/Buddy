// 全体の停止のショートカットの印（UI-04、ADR 0032）。停止のボタンの横に、キーの形で置く。
// 登録できていればキーの形（⌘⌥⇧X・Ctrl+Alt+Shift+X）、登録できなかった（ほかのアプリが使っている）なら、同じキーの形に
// 打ち消しの線と ⚠ を重ねる。説明文は置かず、読み上げの名前だけを付ける。preload が値を渡さなければ何も描かない。
import { Kbd, WarningIcon } from '@heroui/react';
import type { StopShortcutMark as Mark } from '../state/status-panel-state.js';

export function StopShortcutMark({
  mark,
  keys,
}: {
  readonly mark: Mark;
  readonly keys: string;
}) {
  if (mark === null) return null;
  if (mark === 'registered')
    return (
      <span
        role="img"
        aria-label={`停止のショートカット ${keys}`}
        data-stop-shortcut="registered"
        className="inline-flex"
      >
        <Kbd aria-hidden="true">
          <Kbd.Content>{keys}</Kbd.Content>
        </Kbd>
      </span>
    );
  return (
    <span
      role="img"
      aria-label={`停止のショートカット ${keys} は使えません`}
      data-stop-shortcut="unavailable"
      className="inline-flex items-center gap-1"
    >
      <WarningIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-warning-soft-foreground"
      />
      <Kbd aria-hidden="true" className="line-through opacity-60">
        <Kbd.Content>{keys}</Kbd.Content>
      </Kbd>
    </span>
  );
}
