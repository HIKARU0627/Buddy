// 入力バー（UI-02 の試作、ADR 0032）。画面の下の小さな帯。左に入出力の状態の記号、中に 1 行の入力欄、右にキャンバスを
// 前に出すボタン（4 つの四角の記号）だけを置く。説明文は置かない。
// 形（ADR 0181 の段階 4）: 小さめはカプセル（完全な丸）、入力中は島の丸み（28px）。窓は透明で、角の外は透ける（U399）。
// 打てるか（enabled）と内容を出せるか（value は呼び出し側が inputDraftAfter で決める）は別。ロック中・不明は値を描かない。
// Enter（IME の変換の確定は除く）で発言を送る（desktop.turn_submit。UI-03）。送っている間は記号を回転にし、聞き返し・拒否・
// 失敗は入力欄の枠（無効の枠）で知らせて文字を残す（説明文は置かない）。入力中は窓が上へ広がり、入力欄を複数行にする（UI-08）。
import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Alert,
  Button,
  Input,
  Spinner,
  TextArea,
  TextField,
  WarningIcon,
} from '@heroui/react';
import { CanvasIcon } from '../../components/CanvasIcon.js';
import { StatusMark } from '../../components/StatusText.js';
import type { StatusLine } from '../../tones.js';

export function InputBar({
  line,
  enabled,
  value,
  onChange,
  onSubmit,
  sending,
  attention,
  canSummon,
  onSummon,
  expanded = false,
  clarification = null,
  storageNotice = null,
}: {
  readonly line: StatusLine;
  readonly enabled: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly sending: boolean;
  readonly attention: boolean;
  readonly canSummon: boolean;
  readonly onSummon: () => void;
  // 入力するときの大きさ（UI-08）。main が窓を広げ、画面は入力欄を複数行にする。
  readonly expanded?: boolean;
  // 聞き返しの文（UI-08）。広がった領域に出す。説明文ではなく、その回の質問そのもの。
  readonly clarification?: string | null;
  // 記録しないと表示していたのに発言が記録された旨の 1 文（UI-05 の段階 6、ADR 0189、U477）。広がった領域に出す。
  readonly storageNotice?: string | null;
}) {
  // IME・OS の音声入力（AquaVoice・macOS の音声入力・Win+H）の変換中は送らない。composition の間は form の
  // submit も通さず、確定してから Enter で送る。
  const composingRef = useRef(false);
  // Enter で送る（IME の変換の確定は除く）。TextArea の Enter は改行なので、form の submit に頼らずここで送る。
  const sendOnEnter = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const native = event.nativeEvent;
    if (composingRef.current || native.isComposing || native.keyCode === 229)
      return;
    event.preventDefault();
    onSubmit();
  };
  // 窓が広がると Input が TextArea に置き換わる。置き換えでフォーカスを失わないよう、広がった後に入力欄へ移す。
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!expanded || !enabled) return;
    const field = formRef.current?.querySelector('textarea');
    if (field != null && document.activeElement !== field) field.focus();
  }, [expanded, enabled]);
  return (
    <form
      ref={formRef}
      className={
        expanded
          ? 'flex h-screen w-screen flex-col gap-2 rounded-island border border-border bg-surface p-3 text-foreground'
          : 'flex h-14 w-screen flex-col rounded-full border border-border bg-surface py-2 pr-2.5 pl-5 text-foreground'
      }
      onSubmit={(event) => {
        event.preventDefault();
        if (!composingRef.current) onSubmit();
      }}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
    >
      {expanded && storageNotice !== null ? (
        <Alert
          status="warning"
          role="status"
          aria-live="polite"
          data-storage-notice=""
          className="max-h-[72px] shrink-0 overflow-y-auto"
        >
          <Alert.Indicator>
            <WarningIcon aria-hidden="true" />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>{storageNotice}</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
      {expanded && enabled && clarification !== null ? (
        <Alert
          status="accent"
          role="status"
          aria-live="polite"
          className="max-h-[72px] shrink-0 overflow-y-auto"
        >
          <Alert.Content>
            <Alert.Title>{clarification}</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
      <div
        className={`flex min-h-0 flex-1 gap-3 ${expanded ? 'items-end' : 'items-center'}`}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          {sending ? (
            <Spinner size="sm" color="current" aria-hidden="true" />
          ) : (
            <StatusMark line={line} />
          )}
        </span>
        <TextField
          aria-label="Buddy への入力"
          className="h-full min-h-0 flex-1"
          value={value}
          onChange={onChange}
          isDisabled={!enabled}
          isInvalid={attention}
          autoFocus
        >
          {expanded ? (
            <TextArea
              variant="secondary"
              className="h-full min-h-0 w-full [&_textarea]:h-full [&_textarea]:min-h-0"
              rows={5}
              onKeyDown={sendOnEnter}
            />
          ) : (
            <Input
              variant="secondary"
              className="w-full"
              onKeyDown={sendOnEnter}
            />
          )}
        </TextField>
        <Button
          isIconOnly
          variant="outline"
          size="sm"
          aria-label="キャンバスを前に出す"
          isDisabled={!canSummon}
          onPress={onSummon}
        >
          <CanvasIcon />
        </Button>
      </div>
    </form>
  );
}
