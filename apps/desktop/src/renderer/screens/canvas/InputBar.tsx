// 入力バー（UI-02 の試作、ADR 0032）。画面の下の小さな帯。左に入出力の状態の記号、中に 1 行の入力欄、右にキャンバスを
// 前に出すボタン（4 つの四角の記号）だけを置く。説明文は置かない。
// 形（ADR 0181 の段階 4・ADR 0204）: 角は島の丸み（28px）のまま、高さだけが変わる。高さ 56 では錠剤の形に見え、入力中は
// 上へ伸びる。高さはばねの曲線（--ease-spring）で滑らかに動かす。窓は透明で、main は広げるときに窓を先に広げ、縮めるときは
// 見える形が縮み終わってから窓を小さくするので、窓の大きさの切り替えは見えない。窓の中には影を描く余白がある
// （左右 16・上 16・下 16。main の FLOAT_SHADOW・INPUT_BAR_MARGIN と同じ値）。
// 入力欄は小さい形でも広がった形でも同じ TextArea（置き換えないので、フォーカスも入力中の変換も失わない）。入力欄そのものは
// 枠を持たず、入力バーの面が入力欄の枠になる（フォーカスの輪・無効の枠は入力バーの縁に出す）。
// 打てるか（enabled）と内容を出せるか（value は呼び出し側が inputDraftAfter で決める）は別。ロック中・不明は値を描かない。
// Enter（IME の変換の確定は除く）で発言を送る（desktop.turn_submit。UI-03）。送っている間は記号を回転にし、聞き返し・拒否・
// 失敗は入力欄の枠（無効の枠）で知らせて文字を残す（説明文は置かない）。入力中は窓が上へ広がり、入力欄を複数行にする（UI-08）。
import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Alert,
  Button,
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
  const formRef = useRef<HTMLFormElement>(null);
  // 窓が前面に来て広がったら、入力欄へフォーカスを移す。
  useEffect(() => {
    if (!expanded || !enabled) return;
    const field = formRef.current?.querySelector('textarea');
    if (field != null && document.activeElement !== field) field.focus();
  }, [expanded, enabled]);
  const notices = expanded;
  return (
    <div className="flex h-screen w-screen flex-col justify-end p-4">
      <form
        ref={formRef}
        data-input-bar={expanded ? 'expanded' : 'compact'}
        data-attention={attention ? '' : undefined}
        className={`flex w-full flex-col overflow-clip rounded-island border bg-surface text-foreground shadow-float transition-[height,padding,border-color] duration-(--motion-island) ease-spring motion-reduce:transition-none motion-safe:animate-pop-in focus-within:border-field-border data-attention:border-danger ${
          attention ? '' : 'border-border'
        } ${expanded ? 'h-full gap-2 p-3' : 'h-14 gap-0 py-2 pr-2.5 pl-5'}`}
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
        {notices && storageNotice !== null ? (
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
        {notices && enabled && clarification !== null ? (
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
            <TextArea
              variant="secondary"
              data-expanded={expanded ? '' : undefined}
              className="h-full min-h-0 w-full resize-none border-0! bg-transparent! px-0 shadow-none! ring-0! outline-none! data-expanded:py-1"
              rows={expanded ? 5 : 1}
              onKeyDown={sendOnEnter}
            />
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
    </div>
  );
}
