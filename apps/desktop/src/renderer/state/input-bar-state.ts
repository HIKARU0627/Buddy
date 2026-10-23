// 入力バーの送信（UI-03、ADR 0032）の判定。React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。
// 送れるかの受付の正本は main（ロック・停止・接続・送信元の窓の役割）。画面は押せる状態の判定と、結果で
// 入力欄をどうするかを決めるだけ。
import type { DesktopIpcResponse } from '@buddy/contracts';

// 送ってよい文字か（空・空白だけは送らない）。送っている間は重ねて送らない。
export function canSubmit(
  text: string,
  enabled: boolean,
  sending: boolean,
): boolean {
  return enabled && !sending && text.trim().length > 0;
}

// 発言の結果の扱い。sent は入力欄を空にする。needs_attention は入力欄の文字を残し、入力欄の枠で知らせる
// （聞き返し・拒否・通信の失敗・結果が分からない。文章の説明は置かない。聞き返しの表示は UI-08）。
// 結果が分からないときも文字を残す（main は自動では送り直さない。本人がもう一度送る）。
export type SubmitResult = 'sent' | 'needs_attention';

export function submitResult(response: DesktopIpcResponse): SubmitResult {
  if (response.outcome !== 'ok' || !('turn' in response))
    return 'needs_attention';
  return response.turn.status === 'clarification' ? 'needs_attention' : 'sent';
}
