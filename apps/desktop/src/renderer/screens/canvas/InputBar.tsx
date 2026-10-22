// 入力バー（UI-02 の試作、ADR 0032）。画面の下の小さな帯。左に入出力の状態の記号、中に 1 行の入力欄、右にキャンバスを
// 前に出すボタン（4 つの四角の記号）だけを置く。説明文は置かない。
// 打てるか（enabled）と内容を出せるか（value は呼び出し側が inputDraftAfter で決める）は別。ロック中・不明は値を描かない。
// 送る（desktop.turn_submit）・大きくなる・聞き返しは UI-03・UI-08。
import { Button, Input, TextField } from '@heroui/react';
import { StatusMark } from '../../components/StatusText.js';
import type { StatusLine } from '../../tones.js';

// キャンバスの記号（4 つの四角）。色は文字色に従う。
function CanvasIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4"
      fill="currentColor"
    >
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
    </svg>
  );
}

export function InputBar({
  line,
  enabled,
  value,
  onChange,
  canSummon,
  onSummon,
}: {
  readonly line: StatusLine;
  readonly enabled: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly canSummon: boolean;
  readonly onSummon: () => void;
}) {
  return (
    <form
      className="flex h-screen w-screen items-center gap-3 border border-separator bg-surface px-4 text-foreground"
      onSubmit={(event) => event.preventDefault()}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <StatusMark line={line} />
      </span>
      <TextField
        aria-label="Buddy への入力"
        className="flex-1"
        value={value}
        onChange={onChange}
        isDisabled={!enabled}
        autoFocus
      >
        <Input variant="secondary" className="w-full" />
      </TextField>
      <Button
        isIconOnly
        variant="ghost"
        size="sm"
        aria-label="キャンバスを前に出す"
        isDisabled={!canSummon}
        onPress={onSummon}
      >
        <CanvasIcon />
      </Button>
    </form>
  );
}
