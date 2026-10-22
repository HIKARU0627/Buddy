// 入力バー（UI-02 の試作、ADR 0032）。画面の下の小さな帯。左に入出力の状態の記号、右に 1 行の入力欄だけを置く。
// 止まっている・ロック中は打てない（記号と欄の無効の見た目で伝え、説明文は置かない）。
// 送る（desktop.turn_submit）・大きくなる・聞き返しは UI-03・UI-08。今は打った文字を欄に残すだけ。
import { useState } from 'react';
import { Input, TextField } from '@heroui/react';
import { StatusMark } from '../../components/StatusText.js';
import type { StatusLine } from '../../tones.js';

export function InputBar({
  line,
  enabled,
}: {
  readonly line: StatusLine;
  readonly enabled: boolean;
}) {
  const [text, setText] = useState('');
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
        value={text}
        onChange={setText}
        isDisabled={!enabled}
        autoFocus
      >
        <Input variant="secondary" className="w-full" />
      </TextField>
    </form>
  );
}
